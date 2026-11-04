import { CONFIG, TEAM, PHASE } from '../config.js';
import { generateMaze, floorTiles, distance, isWalkable } from './maze.js';
import { generateTasks, revealDueTasks, evaluateTasks } from './tasks.js';
import { emptyEffects, applyPurchases, resolveBounties } from './powerups.js';
import { computeVisible } from './fog.js';
import { createAgent, deliberate, clampSentences } from '../agents/agent.js';
import { PERSONALITIES } from '../agents/prompts.js';
import { deliberateAll } from '../agents/llm.js';
import { createLedger, record, markFollowed, buildReveal, settlePayout } from '../economy/ledger.js';
import {
  transfer, lockEscrow, releaseEscrow, refundEscrow, buyPowerup, payBetween, ESCROW_TTL_SECONDS,
} from '../economy/x402.js';
import { payoutOnChain } from '../economy/stakes.js';
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
    // Whether THIS game settles on chain. Set by the room, never from
    // MOCK_CHAIN alone: only one room may hold the agent wallets at a time.
    onChain: false,
    // Settlements still in flight (releases, refunds, bounty claims). The
    // payout waits on these so it splits the pot the chain actually holds.
    chainOps: new Set(),
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

  refundLapsedBribes(state);

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

  // Agents settle concurrently. Every payment is a chain round trip, and one
  // agent after another a busy tick outlasts the tick itself. Each settle
  // function reserves funds synchronously before it awaits, so interleaving
  // can never overdraw an agent.
  const purchases = [];
  await Promise.all(results.map(async ({ agent, actions }) => {
    if (!actions) return;
    await settleMessages(state, agent, actions);
    await settleAccepts(state, agent, actions);
    if (actions.purchase) {
      const queued = await settlePurchase(state, agent, actions.purchase);
      if (queued) purchases.push(queued);
    }
  }));

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
      if (c?.ledgerSeq != null) {
        markFollowed(state.ledger, c.ledgerSeq, true);
        // The engine's attestation: the bought briefing went out, so the
        // escrow pays the agent that delivered it.
        releaseBribe(state, c);
      }
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
    if (!claimant || !poster) continue;
    // The reward was set aside from the poster's balance when the bounty went
    // up (settlePurchase). Collecting your own bounty just takes it back.
    if (claimant.id === poster.id) {
      poster.agent.balance += claim.amount;
      continue;
    }
    const tick = state.tick;
    track(state, payBetween(poster.id, claimant.id, claim.amount, chainOpts(state)).then(res => {
      if (!res.ok) {
        poster.agent.balance += claim.amount;
        return;
      }
      claimant.agent.balance += claim.amount;
      record(state.ledger, {
        tick, kind: 'BOUNTY',
        from: poster.id, to: claimant.id, amount: claim.amount, txHash: res.txHash,
        memo: `Delivered ${claim.bounty.targetPlayer} to (${claim.bounty.tile.x},${claim.bounty.tile.y})`,
      });
      pushChannel(state, {
        kind: 'BOUNTY_CLAIMED', from: claimant.id,
        text: `Bounty claimed: ${claim.amount} KHIA`, txHash: res.txHash,
      });
    }));
  }

  return checkWin(state);
}

// ─────────────────────────────────────────────────────────────────────────────
// CHAIN BOOKKEEPING
//
// Invariant: an agent's in-memory balance never exceeds what its wallet holds
// on chain. Money leaves a balance BEFORE the payment is attempted and comes
// back if it fails; money arrives only once the payment has landed. Whatever
// the in-memory economy allows, the chain can therefore always honour, and
// once nothing is in flight the two agree exactly.
// ─────────────────────────────────────────────────────────────────────────────

function chainOpts(state) {
  return { mock: !state.onChain };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Register an in-flight settlement so endGame can wait for it. */
function track(state, promise) {
  const p = promise.catch(err => console.error('settlement failed:', err));
  state.chainOps.add(p);
  p.finally(() => state.chainOps.delete(p));
  return p;
}

/** Engine attests a bought briefing went out: escrow pays the agent. */
function releaseBribe(state, commitment) {
  const entry = state.ledger.entries[commitment.ledgerSeq];
  if (entry?.escrow !== 'LOCKED') return;
  entry.escrow = 'RELEASING';
  track(state, releaseEscrow(commitment.escrowId, chainOpts(state)).then(res => {
    if (!res.ok) {
      // Still in custody. If it never releases, the lapse sweep refunds it.
      entry.escrow = 'LOCKED';
      return;
    }
    entry.escrow = 'RELEASED';
    entry.releaseTx = res.txHash;
    state.players[entry.to].agent.balance += entry.amount;
  }));
}

/**
 * Refund bribes whose commitment ran out without the briefing going out —
 * the bought agent died, was jammed, or never delivered.
 *
 * The contract only allows a refund once its TTL has passed, which is longer
 * than the commitment window, so a lapsed bribe waits for `refundableAt`
 * before the engine asks for its money back. `force` is the end of the game:
 * nothing left can be honoured, so everything still locked goes home.
 */
function refundLapsedBribes(state, { force = false } = {}) {
  const now = Date.now();
  for (const p of Object.values(state.players)) {
    for (const c of p.agent.commitments) {
      const entry = state.ledger.entries[c.ledgerSeq];
      if (entry?.escrow !== 'LOCKED') continue;
      if (!force && c.expiresTick >= state.tick) continue;
      if (!force && now < c.refundableAt) continue;

      entry.escrow = 'REFUNDING';
      const attempt = (async () => {
        await sleep(Math.max(0, c.refundableAt - now));
        // refundableAt is the server's clock; the contract checks the chain's.
        // A mid-game miss is retried by the next tick's sweep, but nothing
        // sweeps after the game, so the final sweep retries on its own.
        for (let tries = force ? 6 : 1; tries > 0; tries--) {
          const res = await refundEscrow(c.escrowId, chainOpts(state));
          if (res.ok) {
            entry.escrow = 'REFUNDED';
            entry.refundTx = res.txHash;
            state.players[entry.from].agent.balance += entry.amount;
            return;
          }
          if (tries > 1) await sleep(5_000);
        }
        entry.escrow = 'LOCKED';
      })();
      // Mid-game refunds feed the pot, so the payout waits for them. The
      // end-of-game sweep runs after the payout and does not.
      if (force) attempt.catch(err => console.error('refund failed:', err));
      else track(state, attempt);
    }
  }
}

/** Unclaimed bounties hand their reserved reward back to the poster. */
function returnUnclaimedBounties(state) {
  for (const b of state.effects?.bounties ?? []) {
    if (b.claimed) continue;
    b.claimed = true;
    const poster = state.players[b.poster];
    if (poster) poster.agent.balance += b.amount;
  }
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
    agent.balance -= CONFIG.ECONOMY.CONTACT_FEE;
    const tx = await transfer(agent, target.id, CONFIG.ECONOMY.CONTACT_FEE, chainOpts(state));
    if (!tx.ok) {
      // Unpaid, so undelivered: the message simply doesn't send.
      agent.balance += CONFIG.ECONOMY.CONTACT_FEE;
      continue;
    }
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

/**
 * The offer an accept refers to: the newest unaccepted BRIBE_OFFER or
 * BRIBE_COUNTER in this agent's inbox from that sender.
 *
 * Accepts used to be executed exactly as the accepting agent described them.
 * With a model writing that JSON, an agent could "accept" a bribe nobody
 * offered, or name its own price, and the engine — which holds every key —
 * would sign the payment out of the other agent's wallet. The terms now come
 * from the offer itself: its sender paid a contact fee to put it there.
 */
function findOffer(agent, from) {
  for (let i = agent.inbox.length - 1; i >= 0; i--) {
    const m = agent.inbox[i];
    if (m.from === from && !m.accepted && (m.type === 'BRIBE_OFFER' || m.type === 'BRIBE_COUNTER')) return m;
  }
  return null;
}

async function settleAccepts(state, agent, actions) {
  for (const acc of (actions.accepts ?? [])) {
    const offer = findOffer(agent, acc.from);
    const offerer = state.players[acc.from];
    if (!offer || !offerer || offerer.id === agent.playerId) continue;

    // Accepting an offer means the offerer pays you to deliver. Accepting a
    // counter means YOU pay — it was your offer, re-priced by its target.
    const [payer, payee] = offer.type === 'BRIBE_OFFER'
      ? [offerer, state.players[agent.playerId]]
      : [state.players[agent.playerId], offerer];
    const amount = Number(offer.amount) || 0;
    const instruction = offer.instruction ?? acc.instruction ?? null;
    // Below the floor, and never more than was offered.
    if (amount < CONFIG.ECONOMY.MIN_BRIBE) continue;
    if (payer.agent.balance < amount) continue;
    offer.accepted = true;

    // Escrowed conditional bribe: the contract holds it and releases on
    // engine confirmation. Two agents on opposing teams have no reason to
    // trust each other and no way to build trust in 10 minutes. This is the
    // strongest justification for the chain in the whole project.
    //
    // The payer is out of pocket from the lock; the taker is paid only when
    // the escrow releases (releaseBribe), exactly as on chain.
    payer.agent.balance -= amount;
    const esc = await lockEscrow(payer.agent, payee.id, amount, instruction, chainOpts(state));
    if (!esc.ok) {
      payer.agent.balance += amount;
      offer.accepted = false;
      continue;
    }

    const entry = record(state.ledger, {
      tick: state.tick, kind: 'BRIBE',
      from: payer.id, to: payee.id, amount,
      memo: instruction, txHash: esc.txHash, followed: null,
      // Bought a WHISPER this tick? Then this bribe never reaches the
      // victim's end-of-game reveal — only the audience ever learns of it.
      whispered: state.effects.whisper?.has(payer.agent.id) ?? false,
      escrowId: esc.escrowId, escrow: 'LOCKED',
    });

    payee.agent.bribesReceived.push({ from: payer.id, amount, instruction, tick: state.tick, escrowId: esc.escrowId });
    payer.agent.bribesPaid.push({ to: payee.id, amount, tick: state.tick });
    payee.agent.commitments.push({
      instruction, amount,
      expiresTick: state.tick + 2, ledgerSeq: entry.seq,
      escrowId: esc.escrowId,
      // The contract refuses a refund before its TTL. Mocked escrows have no
      // clock to wait for.
      refundableAt: state.onChain ? Date.now() + ESCROW_TTL_SECONDS * 1000 + 2_000 : 0,
    });

    pushChannel(state, {
      kind: 'BRIBE_SETTLED', from: payer.id, to: payee.id,
      amount, instruction, txHash: esc.txHash,
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

  if (purchase.type === 'BOUNTY') return postBounty(state, agent, purchase, spec);

  const cost = spec.cost;
  if (agent.balance < cost) return null;

  agent.balance -= cost;
  const res = await buyPowerup(agent, purchase.type, cost, chainOpts(state));
  if (!res.ok) {
    agent.balance += cost;
    return null;   // failed payment = failed purchase, no retries
  }

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

/**
 * A bounty is a reward, not a purchase: nothing is burned, and the money only
 * moves when someone collects (resolveTick). Until then it is set aside from
 * the poster's balance so it cannot be spent twice.
 *
 * It used to be bought through the shop AND paid out on claim, charging the
 * poster twice the reward — once burned, once to the claimant — and only the
 * burn ever reached the chain.
 */
function postBounty(state, agent, purchase, spec) {
  // Without both, the bounty can never be claimed and the reward sits
  // reserved for the rest of the game.
  if (!purchase.target || !purchase.tile) return null;
  const reward = Math.max(purchase.amount ?? spec.cost, spec.cost);
  if (agent.balance < reward) return null;

  agent.balance -= reward;
  agent.powerupsBought++;
  pushChannel(state, { kind: 'POWERUP', from: agent.id, text: 'BOUNTY', amount: reward });

  return {
    agentId: agent.id, playerId: agent.playerId, team: agent.team,
    type: 'BOUNTY', target: purchase.target, tile: purchase.tile,
    amount: reward, cost: reward, ts: Date.now(),
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
  returnUnclaimedBounties(state);
  const shares = settlePayout(state);
  state.reveal = buildReveal(state);
  state.reveal.roleCommit = roleCommitSummary(state);
  state.reveal.payout = { onChain: Boolean(state.onChain), status: state.onChain ? 'PENDING' : 'MOCK', shares };
  state.phase = 'REVEAL';
  broadcast?.();

  // Pay the winners on chain, then send home any bribe still in custody.
  // Like the role reveal below, this resolves after the screen is up and
  // patches the reveal in place.
  if (state.onChain) {
    settlePayoutOnChain(state)
      .then(broadcast)
      .catch(err => {
        state.reveal.payout.status = 'FAILED';
        state.reveal.payout.error = String(err?.message ?? err);
        broadcast?.();
      })
      .finally(() => refundLapsedBribes(state, { force: true }));
  } else {
    refundLapsedBribes(state, { force: true });
  }

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

/**
 * The on-chain leg of the payout. Splits what the agents' wallets actually
 * hold once every in-flight settlement has landed, then makes the in-memory
 * balances and the reveal agree with what the chain says happened.
 */
async function settlePayoutOnChain(state) {
  await Promise.allSettled([...state.chainOps]);
  const winners = Object.values(state.players)
    .filter(p => p.alive && p.team === state.winner)
    .map(p => p.id);

  const res = await payoutOnChain(winners);
  state.reveal.payout = {
    ...state.reveal.payout,
    status: res.ok ? 'SETTLED' : 'FAILED',
    transfers: res.transfers,
  };
  if (res.balances) {
    for (const [id, bal] of Object.entries(res.balances)) {
      state.players[id].agent.balance = bal;
      if (state.reveal.perAgent[id]) state.reveal.perAgent[id].finalBalance = Number(bal.toFixed(2));
    }
  }
}

function pushChannel(state, msg) {
  state.channel.push({ ...msg, tick: state.tick, ts: Date.now() });
  if (state.channel.length > 500) state.channel.shift();
}

export { pushChannel };
