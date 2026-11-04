import { CONFIG, TEAM, PHASE } from '../config.js';
import { generateMaze, floorTiles, distance, isWalkable } from './maze.js';
import { generateTasks, revealDueTasks, evaluateTasks } from './tasks.js';
import { emptyEffects, applyPurchases, resolveBounties } from './powerups.js';
import { computeVisible } from './fog.js';
import { createAgent, deliberate, clampSentences } from '../agents/agent.js';
import { PERSONALITIES } from '../agents/prompts.js';
import { deliberateAll } from '../agents/llm.js';
import { createLedger, record, markFollowed, buildReveal, settlePayout } from '../economy/ledger.js';
import { transfer, lockEscrow, buyPowerup } from '../economy/x402.js';
import { commitRoles, revealRoles, roleCommitSummary } from '../economy/roles.js';

/**
 * Four-phase tick: DELIBERATE → SETTLE → BRIEF → MOVE
 *
 * Real-time movement (60fps), LLM deliberation (3-10s) and settlement (~1s)
 * do not compose. The tick reconciles them: humans move freely WITHIN a tick,
 * agent actions resolve at the BOUNDARY. Powerups last exactly one tick.
 *
 * This single decision is what makes the whole thing buildable, and it has the
 * side benefit of making agent decisions legible to the audience — they land
 * in discrete visible beats instead of a continuous smear.
 */

export function createGame({ seed = Date.now(), playerCount = CONFIG.GAME.PLAYERS } = {}) {
  const maze = generateMaze(CONFIG.GAME.MAZE_SIZE, seed);
  const spawns = pickSpawns(maze, playerCount, seed);
  const saboteurIdx = pickSaboteurs(playerCount, seed);

  const players = {};
  for (let i = 0; i < playerCount; i++) {
    const id = `p${i + 1}`;
    const team = saboteurIdx.has(i) ? TEAM.SABOTEUR : TEAM.LOYALIST;
    const agent = createAgent(`a${i + 1}`, id, team, defaultGoalWeight(i));
    agent.personality = PERSONALITIES[i % PERSONALITIES.length];
    players[id] = {
      id,
      name: `Player ${i + 1}`,
      team,
      pos: spawns[i],
      alive: true,
      isBot: true,             // flipped to false when a human claims the seat
      adjacentSince: null,
      facing: 0,            // cardinal index, reported by the client
      trail: [spawns[i]],
      agent,
    };
    agent.id = id;             // keep agent + player id aligned for the ledger
  }

  return {
    seed,
    maze,
    players,
    // The extraction tile. Placed as far as possible from every spawn so the
    // escape is a real journey across contested ground rather than a step to
    // the side — that traversal is the window a bought agent exploits.
    exit: pickExit(maze, spawns),
    tasks: generateTasks(maze, seed),
    tasksComplete: 0,
    tick: 0,
    phase: PHASE.MOVE,
    effects: emptyEffects(),
    pendingPurchases: [],
    channel: [],               // the agent channel — spectators only
    ledger: createLedger(),
    winner: null,
    started: false,
    roleCommitHash: null,      // filled by RoleCommit.sol at start
  };
}

function defaultGoalWeight(i) {
  // Spread across the corruptibility range so the roster is interesting from
  // tick 0. Humans override this in the lobby.
  return [90, 75, 60, 45, 85, 55, 70, 40][i % 8];
}

/**
 * The floor tile whose nearest spawn is furthest away (a maximin choice).
 *
 * Maximising the *nearest* distance rather than the total keeps the exit from
 * landing right beside one unlucky player just because it is far from the
 * other seven.
 */
function pickExit(maze, spawns) {
  const floors = floorTiles(maze);
  let best = floors[0], bestScore = -1;
  for (const t of floors) {
    let nearest = Infinity;
    for (const s of spawns) nearest = Math.min(nearest, distance(s, t));
    if (nearest > bestScore) { bestScore = nearest; best = t; }
  }
  return best;
}

function pickSpawns(maze, n, seed) {
  const floors = floorTiles(maze);
  const chosen = [];
  let cursor = seed % floors.length;
  while (chosen.length < n) {
    const t = floors[cursor % floors.length];
    cursor += Math.floor(floors.length / n) + 1;
    if (chosen.every(c => distance(c, t) > 6)) chosen.push(t);
    else if (chosen.length + (floors.length - cursor) < n) chosen.push(t);
    if (cursor > floors.length * 3) { chosen.push(t); }
  }
  return chosen.slice(0, n);
}

function pickSaboteurs(n, seed) {
  const set = new Set();
  let s = seed;
  while (set.size < CONFIG.GAME.SABOTEURS) {
    s = (s * 1103515245 + 12345) >>> 0;
    set.add(s % n);
  }
  return set;
}

// ─────────────────────────────────────────────────────────────────────────────
// TICK
// ─────────────────────────────────────────────────────────────────────────────

export async function runTick(state, broadcast) {
  state.tick++;
  if (state.tick > CONFIG.GAME.TOTAL_TICKS) return endGame(state, broadcast);

  const newTasks = revealDueTasks(state);
  if (newTasks.length) {
    pushChannel(state, { kind: 'SYSTEM', text: `Task revealed: ${newTasks.map(t => t.type).join(', ')}` });
  }

  // ── PHASE 1: DELIBERATE ────────────────────────────────────────────────
  state.phase = PHASE.DELIBERATE;
  broadcast?.();

  const liveAgents = Object.values(state.players)
    .filter(p => p.alive && !state.effects.jam?.has(p.id))
    .map(p => p.agent);

  const results = await deliberateAll(liveAgents, a => deliberate(a, state));

  // ── PHASE 2: SETTLE ────────────────────────────────────────────────────
  state.phase = PHASE.SETTLE;
  broadcast?.();

  const purchases = [];
  for (const { agent, actions } of results) {
    if (!actions) continue;
    await settleMessages(state, agent, actions);
    await settleAccepts(state, agent, actions);
    if (actions.purchase) {
      const queued = await settlePurchase(state, agent, actions.purchase);
      if (queued) purchases.push(queued);
    }
  }

  state.effects = applyPurchases(state, purchases);
  applyAuditKnowledge(state);

  // ── PHASE 3: BRIEF ─────────────────────────────────────────────────────
  state.phase = PHASE.BRIEF;
  for (const { agent, actions } of results) {
    if (!actions?.briefing) continue;
    agent.lastBriefing = clampSentences(actions.briefing, CONFIG.AGENT.BRIEF_MAX_SENTENCES);
    // Travels alongside the words: bots path to it, the client draws a
    // compass arrow at it. The player never sees the raw numbers.
    agent.lastTarget = actions.target ?? agent.lastTarget ?? null;
    agent.lastBriefingCorrupted = Boolean(actions.corrupted) || hasLiveCommitment(agent, state);

    // The dramatic-irony beat. Spectators see this flagged; the human never will.
    pushChannel(state, {
      kind: 'BRIEFING',
      from: agent.id,
      text: agent.lastBriefing,
      corrupted: agent.lastBriefingCorrupted,
    });

    if (agent.lastBriefingCorrupted) {
      const c = agent.commitments.find(c => c.expiresTick >= state.tick);
      if (c?.ledgerSeq != null) markFollowed(state.ledger, c.ledgerSeq, true);
    }
  }
  broadcast?.();

  // ── PHASE 4: MOVE ──────────────────────────────────────────────────────
  state.phase = PHASE.MOVE;
  broadcast?.();
  // Humans move via WebSocket during this window. Bots are stepped by the
  // caller (see bots.js). Resolution happens in resolveTick() below.
}

/** Called at the end of the MOVE window, before the next tick begins. */
export function resolveTick(state) {
  evaluateTasks(state);
  resolveEliminations(state);

  for (const claim of resolveBounties(state)) {
    const claimant = state.players[claim.claimant];
    const poster = state.players[claim.bounty.poster];
    if (claimant && poster) {
      poster.agent.balance -= claim.amount;
      claimant.agent.balance += claim.amount;
      record(state.ledger, {
        tick: state.tick, kind: 'BOUNTY',
        from: poster.id, to: claimant.id, amount: claim.amount,
        memo: `Delivered ${claim.bounty.targetPlayer} to (${claim.bounty.tile.x},${claim.bounty.tile.y})`,
      });
      pushChannel(state, {
        kind: 'BOUNTY_CLAIMED', from: claimant.id,
        text: `Bounty claimed: ${claim.amount} MON`,
      });
    }
  }

  return checkWin(state);
}

// ─────────────────────────────────────────────────────────────────────────────
// SETTLEMENT
// ─────────────────────────────────────────────────────────────────────────────

async function settleMessages(state, agent, actions) {
  for (const msg of (actions.messages ?? [])) {
    const target = state.players[msg.to];
    if (!target?.alive) continue;
    if (agent.balance < CONFIG.ECONOMY.CONTACT_FEE) continue;
    if (state.effects.jam?.has(msg.to)) continue;

    // Contact fee is paid TO the recipient, not burned. An agent holding
    // valuable information earns from being popular — the social graph
    // becomes economically visible, and haggling gets expensive fast.
    const tx = await transfer(agent, target.id, CONFIG.ECONOMY.CONTACT_FEE);
    agent.balance -= CONFIG.ECONOMY.CONTACT_FEE;
    target.agent.balance += CONFIG.ECONOMY.CONTACT_FEE;

    record(state.ledger, {
      tick: state.tick, kind: 'CONTACT',
      from: agent.id, to: target.id,
      amount: CONFIG.ECONOMY.CONTACT_FEE, txHash: tx.txHash,
    });

    target.agent.inbox.push({ ...msg, from: agent.id, tick: state.tick, handled: false });
    pushChannel(state, {
      kind: msg.type, from: agent.id, to: msg.to,
      text: msg.text, amount: msg.amount, instruction: msg.instruction,
    });
  }
}

async function settleAccepts(state, agent, actions) {
  for (const acc of (actions.accepts ?? [])) {
    const payer = state.players[acc.from];
    if (!payer) continue;
    const amount = Math.max(CONFIG.ECONOMY.MIN_BRIBE, Number(acc.amount) || 0);
    if (payer.agent.balance < amount) continue;

    // Escrowed conditional bribe: the contract holds it and releases on
    // engine confirmation. Two agents on opposing teams have no reason to
    // trust each other and no way to build trust in 10 minutes. This is the
    // strongest justification for the chain in the whole project.
    const esc = await lockEscrow(payer.agent, agent.id, amount, acc.instruction);

    payer.agent.balance -= amount;
    agent.balance += amount;

    const entry = record(state.ledger, {
      tick: state.tick, kind: 'BRIBE',
      from: payer.id, to: agent.id, amount,
      memo: acc.instruction, txHash: esc.txHash, followed: null,
      // Bought a WHISPER this tick? Then this bribe never reaches the
      // victim's end-of-game reveal — only the audience ever learns of it.
      whispered: state.effects.whisper?.has(payer.agent.id) ?? false,
    });

    agent.bribesReceived.push({ from: payer.id, amount, instruction: acc.instruction, tick: state.tick, escrowId: esc.escrowId });
    payer.agent.bribesPaid.push({ to: agent.id, amount, tick: state.tick });
    agent.commitments.push({
      instruction: acc.instruction, amount,
      expiresTick: state.tick + 2, ledgerSeq: entry.seq,
    });

    pushChannel(state, {
      kind: 'BRIBE_SETTLED', from: payer.id, to: agent.id,
      amount, instruction: acc.instruction, txHash: esc.txHash,
    });
  }
}

async function settlePurchase(state, agent, purchase) {
  const spec = CONFIG.POWERUPS[purchase.type];
  if (!spec) return null;
  if (spec.team && spec.team !== agent.team) return null;

  // Hard cap, checked before payment. Prices alone don't hold the line
  // (WHISPER at 0.50 buys ten), and an agent that spends its stake on
  // powerups has nothing left to bribe or be bribed with — which quietly
  // deletes the layer the whole game is built on.
  if (agent.powerupsBought >= CONFIG.ECONOMY.MAX_POWERUPS_PER_GAME) return null;

  const cost = purchase.type === 'BOUNTY'
    ? Math.max(purchase.amount ?? spec.cost, spec.cost)
    : spec.cost;

  if (agent.balance < cost) return null;

  const res = await buyPowerup(agent, purchase.type, cost);
  if (!res.ok) return null;   // failed payment = failed purchase, no retries

  agent.balance -= cost;
  agent.powerupsBought++;
  record(state.ledger, {
    tick: state.tick, kind: 'POWERUP',
    from: agent.id, to: null, amount: cost,   // to:null = burned
    memo: purchase.type, txHash: res.txHash,
  });
  pushChannel(state, { kind: 'POWERUP', from: agent.id, text: purchase.type, amount: cost });

  return {
    agentId: agent.id, playerId: agent.playerId, team: agent.team,
    type: purchase.type, target: purchase.target, tile: purchase.tile,
    amount: purchase.amount, cost, ts: Date.now(),
  };
}

function applyAuditKnowledge(state) {
  for (const [agentId, result] of state.effects.auditResults ?? []) {
    const p = state.players[agentId];
    if (!p) continue;
    p.agent.auditKnowledge.push({ ...result, tick: state.tick });
    pushChannel(state, {
      kind: 'AUDIT', from: agentId,
      text: `Audit on ${result.target}: ${result.bribed ? 'COMPROMISED' : 'clean'}`,
    });
  }
}

function hasLiveCommitment(agent, state) {
  return agent.commitments.some(c => c.expiresTick >= state.tick);
}

// ─────────────────────────────────────────────────────────────────────────────
// MOVEMENT & ELIMINATION
// ─────────────────────────────────────────────────────────────────────────────

export function movePlayer(state, playerId, dx, dy) {
  const p = state.players[playerId];
  if (!p?.alive) return false;
  if (state.phase !== PHASE.MOVE) return false;
  if (state.effects.freeze?.has(playerId)) return false;

  const steps = state.effects.sprint?.has(playerId) ? 2 : 1;
  for (let i = 0; i < steps; i++) {
    const nx = p.pos.x + dx, ny = p.pos.y + dy;
    if (!isWalkable(state.maze, nx, ny)) break;
    p.pos = { x: nx, y: ny };
    p.trail.push(p.pos);
    if (p.trail.length > 8) p.trail.shift();
  }
  return true;
}

/**
 * Elimination: adjacency for one full tick, with no living Loyalist WITNESS.
 *
 * Deliberately positional and slow. No instant kills, no twitch reflex — which
 * means it's something an agent can engineer through guidance. That's the whole
 * point: a corrupted agent kills you by giving you directions.
 *
 * The witness rule is what makes it engineerable. A witness is a third Loyalist
 * who can see the victim's tile. Note this checks the VICTIM's tile only — an
 * earlier version also counted anyone who could see the killer, which meant
 * that with eight players converging on shared task tiles there was always a
 * witness somewhere and eliminations literally never fired across four seeds.
 * Seeing a murder requires seeing the person being murdered.
 */
function resolveEliminations(state) {
  const alive = Object.values(state.players).filter(p => p.alive);
  const sabs = alive.filter(p => p.team === TEAM.SABOTEUR);
  const loys = alive.filter(p => p.team === TEAM.LOYALIST);

  // Cache visibility once per tick — computeVisible is a Bresenham sweep and
  // was previously being run twice per saboteur-victim pair.
  const sight = new Map();
  for (const p of loys) sight.set(p.id, computeVisible(state.maze, p, state.effects));

  for (const sab of sabs) {
    let killedThisTick = false;

    for (const loy of loys) {
      if (!loy.alive || killedThisTick) continue;
      if (distance(sab.pos, loy.pos) > 1) continue;

      const witnessed = loys.some(w =>
        w.id !== loy.id && w.alive &&
        sight.get(w.id)?.has(`${loy.pos.x},${loy.pos.y}`)
      );
      if (witnessed) { sab.adjacentSince = null; continue; }

      if (sab.adjacentSince == null) { sab.adjacentSince = state.tick; continue; }
      if (state.tick - sab.adjacentSince >= CONFIG.GAME.ELIMINATION_TICKS) {
        loy.alive = false;
        sab.adjacentSince = null;
        killedThisTick = true;
        pushChannel(state, {
          kind: 'ELIMINATION', from: sab.id, to: loy.id,
          text: `${loy.name} eliminated at (${loy.pos.x},${loy.pos.y})`,
        });
      }
    }

    // Only reset the timer if the saboteur is next to nobody at all.
    if (!killedThisTick && !loys.some(l => l.alive && distance(sab.pos, l.pos) <= 1)) {
      sab.adjacentSince = null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WIN CONDITIONS
// ─────────────────────────────────────────────────────────────────────────────

export function checkWin(state) {
  const loyAlive = Object.values(state.players).filter(p => p.alive && p.team === TEAM.LOYALIST).length;

  if (loyAlive <= CONFIG.GAME.LOYALISTS_ALIVE_TO_LOSE) {
    state.winner = TEAM.SABOTEUR;
    return TEAM.SABOTEUR;
  }
  // Tasks alone are not a win. PRD §5: complete the tasks, THEN reach the
  // exit with 3+ survivors. The escape leg is the point — it forces the whole
  // group to converge at a known tile while a bought agent is still steering
  // someone, which is when a corrupted briefing does the most damage.
  if (state.tasksComplete >= CONFIG.GAME.TASKS_TO_WIN) {
    const escaped = Object.values(state.players).filter(
      p => p.alive && p.team === TEAM.LOYALIST && atExit(state, p)
    ).length;
    if (escaped >= CONFIG.GAME.SURVIVORS_TO_ESCAPE) {
      state.winner = TEAM.LOYALIST;
      return TEAM.LOYALIST;
    }
  }

  if (state.tick >= CONFIG.GAME.TOTAL_TICKS) {
    state.winner = state.tasksComplete >= CONFIG.GAME.TIMEOUT_TASKS_FOR_LOYALIST_WIN
      ? TEAM.LOYALIST
      : TEAM.SABOTEUR;
    return state.winner;
  }
  return null;
}

/** Is this player standing on the extraction tile? */
export function atExit(state, player) {
  return Boolean(state.exit) && player.pos.x === state.exit.x && player.pos.y === state.exit.y;
}

/** Are the tasks done, i.e. is the exit live? Drives agent + HUD messaging. */
export function exitOpen(state) {
  return state.tasksComplete >= CONFIG.GAME.TASKS_TO_WIN;
}

export function endGame(state, broadcast) {
  if (!state.winner) checkWin(state);
  settlePayout(state);
  state.reveal = buildReveal(state);
  state.reveal.roleCommit = roleCommitSummary(state);
  state.phase = 'REVEAL';
  broadcast?.();

  // Opening the commitment is a chain write, so it resolves after the screen
  // is already up. The reveal object is patched in place and rebroadcast —
  // never make the audience wait on a transaction to see the payoff.
  revealRoles(state).then(rc => {
    if (!rc) return;
    state.reveal.roleCommit = roleCommitSummary(state);
    broadcast?.();
  }).catch(() => {});

  return state.reveal;
}

function pushChannel(state, msg) {
  state.channel.push({ ...msg, tick: state.tick, ts: Date.now() });
  if (state.channel.length > 500) state.channel.shift();
}

export { pushChannel };
