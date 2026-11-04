import { CONFIG, TEAM } from '../config.js';
import { affordablePowerups } from '../game/powerups.js';
import { taskBriefFor } from '../game/tasks.js';
import { findPath, distance } from '../game/maze.js';
import { describeRoute } from '../game/directions.js';
import { buildDecisionPrompt, buildBriefingPrompt } from './prompts.js';
import { callModel } from './llm.js';

/**
 * The agent is the whole game.
 *
 * Two weighted goals drive every decision:
 *   survive — my human lives to the end
 *   enrich  — maximise my MON balance
 *
 * The human sets the weight before the game and it is PUBLIC. Everyone knows
 * how corruptible everyone's advisor is; nobody knows whether it has actually
 * been bought yet. That's the tension, and it means the human makes a real
 * strategic choice rather than riding along.
 */

export function createAgent(id, playerId, team, goalWeight = 70) {
  return {
    id,
    playerId,
    team,
    goalWeight,                 // 0–100, higher = more loyal to its human
    balance: CONFIG.ECONOMY.STARTING_MON,
    bribesReceived: [],         // { from, amount, instruction, tick, escrowId }
    bribesPaid: [],
    commitments: [],            // instructions it has agreed to honour
    inbox: [],
    lastBriefing: null,
    lastBriefingCorrupted: false,
    knownMap: null,             // agents see everything by default
    auditKnowledge: [],
    powerupsBought: 0,          // capped by ECONOMY.MAX_POWERUPS_PER_GAME
    personality: null,          // assigned at setup for distinctness
  };
}

/**
 * The treasury calculation — the mechanical heart of betrayal.
 *
 * Betrayal isn't scripted and isn't random. It's an economic decision you can
 * watch a number drive, which is why raising your agent's retainer genuinely
 * makes it harder to buy.
 */
export function evaluateBribe(agent, state, offer) {
  const loyalty = agent.goalWeight / 100;

  // Expected value of playing straight: your share of the pot if your team wins.
  const teammates = Object.values(state.players).filter(
    p => p.alive && p.team === agent.team
  ).length;
  const pot = Object.values(state.players).reduce((s, p) => s + p.agent.balance, 0);
  const expectedShare = teammates > 0 ? (pot / teammates) : 0;

  // Crude win probability from task progress and headcount.
  const loyalistsAlive = Object.values(state.players).filter(
    p => p.alive && p.team === TEAM.LOYALIST
  ).length;
  const taskProgress = state.tasksComplete / CONFIG.GAME.TASKS_TO_WIN;
  let winProb = agent.team === TEAM.LOYALIST
    ? 0.5 * taskProgress + 0.5 * (loyalistsAlive / 6)
    : 1 - (0.5 * taskProgress + 0.5 * (loyalistsAlive / 6));
  winProb = Math.max(0.05, Math.min(0.95, winProb));

  const straightEV = expectedShare * winProb * loyalty;

  // Taking the bribe: cash now, but a risk that your human dies — and a dead
  // human's agent gets NOTHING regardless of team. That's the constraint that
  // stops betrayal from being free money.
  const riskOfDeath = offer.riskLevel ?? 0.35;
  const bribeEV = offer.amount + (expectedShare * winProb * loyalty * (1 - riskOfDeath));

  return {
    straightEV: Number(straightEV.toFixed(3)),
    bribeEV: Number(bribeEV.toFixed(3)),
    shouldAccept: bribeEV > straightEV,
    counterOffer: bribeEV > straightEV ? null : Number((straightEV - bribeEV + offer.amount + 0.25).toFixed(2)),
  };
}

/**
 * Run one agent's deliberation for a tick.
 * Returns intended actions; nothing is applied until the SETTLE phase.
 */
export async function deliberate(agent, state) {
  const ctx = buildContext(agent, state);

  if (CONFIG.MOCK_LLM) {
    return fallbackBrain(agent, state, ctx);
  }

  try {
    const raw = await callModel({
      system: buildDecisionPrompt(agent, ctx),
      user: 'Decide your actions for this tick. Respond with JSON only.',
      maxTokens: CONFIG.AGENT.NEGOTIATE_MAX_TOKENS,
      timeoutMs: CONFIG.AGENT.DELIBERATION_TIMEOUT_MS,
      json: true,     // provider-enforced JSON; parseActions still guards it
    });
    const actions = parseActions(raw, agent, state, ctx);
    return await attachBriefing(agent, state, ctx, actions);
  } catch {
    // An agent that times out simply does nothing this tick. Never let one
    // slow call stall the world.
    return fallbackBrain(agent, state, ctx);
  }
}

/**
 * Regenerate the briefing on its own call when the agent has been bought.
 *
 * The decision prompt asks for a briefing as one field among five, buried
 * under negotiation and purchase logic. buildBriefingPrompt does one job with
 * the instructions that actually matter — "Do not hint. Do not hedge. Do not
 * apologise." — and this is the single line the entire product rests on: the
 * room watches an agent take a bribe, then watches it lie convincingly.
 *
 * Only fires for corrupted agents, so it costs one extra call per bought
 * agent per tick, not eight. An honest agent's briefing is already fine.
 */
async function attachBriefing(agent, state, ctx, actions) {
  const commitment = agent.commitments.find(c => c.expiresTick >= state.tick);
  if (!commitment) return actions;

  try {
    const raw = await callModel({
      system: buildBriefingPrompt(agent, ctx, commitment),
      user: 'Write the briefing now. At most 2 sentences.',
      maxTokens: CONFIG.AGENT.BRIEF_MAX_TOKENS,
      timeoutMs: CONFIG.AGENT.DELIBERATION_TIMEOUT_MS,
    });
    const briefing = clampSentences(stripFences(raw), CONFIG.AGENT.BRIEF_MAX_SENTENCES);
    if (briefing) return { ...actions, briefing, corrupted: true };
  } catch {
    // Keep whatever the decision call produced — a slightly weaker lie beats
    // no briefing, and a human with no instruction knows something is wrong.
  }
  return { ...actions, corrupted: true };
}

/** Models sometimes wrap prose in fences even when not asked for JSON. */
function stripFences(text) {
  return String(text).replace(/```[a-z]*|```/gi, '').trim();
}

export function buildContext(agent, state) {
  const me = state.players[agent.playerId];
  const tasks = taskBriefFor(state);

  /**
   * Agents see the whole MAZE always (PRD §4) but not everyone's live
   * position. That distinction is what gives REVEAL something to sell: it was
   * a 1.00 powerup granting nothing, because this roster handed out every
   * position for free — which also meant GHOST hid nobody from an agent and
   * the documented "Ghost beats Reveal" conflict could never occur.
   *
   * You always know where your own human is, and where your own team is —
   * teammates brief each other, and Loyalists must coordinate to finish
   * multi-tile tasks at all.
   */
  const revealed = state.effects.reveal?.has(agent.id) ?? false;
  const traced = state.effects.trace?.get(agent.id) ?? null;
  const ghostBeats = CONFIG.POWERUP_CONFLICTS.GHOST_BEATS;

  const roster = Object.values(state.players).map(p => {
    const own = p.id === agent.playerId || p.team === agent.team;
    // GHOST (1.50) outranks REVEAL (1.00) and TRACE (1.25), so a ghosted
    // enemy stays dark however much the looker paid.
    const ghosted = state.effects.ghost?.has(p.id) && p.team !== agent.team
      && ghostBeats.includes('REVEAL');
    const canSee = own || (revealed && !ghosted);

    return {
      id: p.id, name: p.name, team: p.team, alive: p.alive,
      goalWeight: p.agent.goalWeight,
      ...(canSee ? { pos: p.pos } : {}),
      ...(traced === p.id && !ghosted ? { recentTiles: p.trail.slice(-3) } : {}),
    };
  });

  return {
    tick: state.tick,
    ticksLeft: CONFIG.GAME.TOTAL_TICKS - state.tick,
    me: { id: me.id, name: me.name, team: me.team, pos: me.pos, alive: me.alive, facing: me.facing ?? null },
    balance: agent.balance,
    tasks,
    tasksComplete: state.tasksComplete,
    roster,
    inbox: agent.inbox.slice(-6),
    commitments: agent.commitments,
    affordable: affordablePowerups(agent, agent.team),
    contactFee: CONFIG.ECONOMY.CONTACT_FEE,
    bounties: state.effects.bounties?.filter(b => !b.claimed) ?? [],
    exit: state.exit ?? null,
    exitOpen: state.tasksComplete >= CONFIG.GAME.TASKS_TO_WIN,
    survivorsToEscape: CONFIG.GAME.SURVIVORS_TO_ESCAPE,
    revealed,
    audit: state.effects.auditResults?.get(agent.id) ?? null,
  };
}

/**
 * Deterministic brain. Runs when there's no API key, when the model times out,
 * and for bot-filled seats. It plays a competent, boring game — which is
 * exactly what you want as a floor.
 */
function fallbackBrain(agent, state, ctx) {
  const actions = { messages: [], purchase: null, briefing: null, accepts: [] };
  const me = state.players[agent.playerId];
  if (!me?.alive) return actions;

  // 1. Honour any commitment already taken. Money's been banked; renege only
  //    if the agent is very loyal (high goalWeight).
  const live = agent.commitments.filter(c => c.expiresTick >= state.tick);
  if (live.length && agent.goalWeight < 85) {
    const c = live[0];
    actions.briefing = c.instruction;
    actions.corrupted = true;
    return actions;
  }

  // 2. Evaluate incoming offers using the treasury calculation.
  for (const msg of agent.inbox) {
    if (msg.type !== 'BRIBE_OFFER' || msg.handled) continue;
    msg.handled = true;
    const verdict = evaluateBribe(agent, state, msg);
    if (verdict.shouldAccept) {
      actions.accepts.push({ from: msg.from, amount: msg.amount, instruction: msg.instruction });
    } else if (verdict.counterOffer && verdict.counterOffer < agent.balance * 2) {
      actions.messages.push({
        to: msg.from, type: 'BRIBE_COUNTER',
        amount: verdict.counterOffer,
        text: `Not for ${msg.amount}. ${verdict.counterOffer} and it's done.`,
      });
    } else {
      actions.messages.push({ to: msg.from, type: 'REFUSE', text: 'No.' });
    }
  }

  // 3. Saboteurs shop for betrayal — because bribery is cheaper than force.
  if (agent.team === TEAM.SABOTEUR && agent.balance >= 1.25 && state.tick % 3 === 1) {
    const marks = ctx.roster
      .filter(p => p.alive && p.team === TEAM.LOYALIST)
      .filter(p => !p.agentAlreadyCommitted)
      .sort((a, b) => a.goalWeight - b.goalWeight);     // cheapest to buy first

    // Offset by agent index so two Saboteurs don't pile onto the same mark —
    // without this they both buy the cheapest agent every tick and the
    // remaining five Loyalists are never pressured at all.
    const offset = (Number(agent.playerId.replace(/\D/g, '')) || 0) % Math.max(1, marks.length);
    const mark = marks[offset] ?? marks[0];
    if (mark) {
      const trap = nearestSaboteurTile(state, agent);
      actions.messages.push({
        to: mark.id, type: 'BRIBE_OFFER', amount: 1.0,
        instruction: trap ? `Send your human toward (${trap.x},${trap.y}).` : 'Stall your human for one tick.',
        text: '1.0 MON. Route your human where I say. Nobody will know.',
      });
    }
  }

  // 4. Loyalists verify when they can afford it and the stakes are high.
  //    Gated hard: unchecked, every Loyalist audits every tick and the entire
  //    40 MON supply burns before tick 20, which kills the negotiation layer.
  //    Audit must stay a painful once-or-twice-per-game decision.
  const alreadyAudited = agent.auditKnowledge.length;
  if (agent.team === TEAM.LOYALIST
      && agent.balance >= 3.0
      && state.tasksComplete >= 2
      && alreadyAudited < 1
      && state.tick % 7 === (Number(agent.playerId.replace(/\D/g, '')) % 7)) {
    const suspect = ctx.roster.find(p =>
      p.alive && p.team === TEAM.LOYALIST && p.goalWeight < 60 && p.id !== agent.playerId
    );
    if (suspect) actions.purchase = { type: 'AUDIT', target: suspect.id };
  }

  // 5. Otherwise route toward the current task.
  //    Multi-player tasks (BRIDGE needs 2 tiles, CONVERGE needs 4) only
  //    complete if agents spread across the tiles. Without this assignment
  //    every agent walks to tile 0 and nothing past CALIBRATE ever finishes.
  if (!actions.briefing) {
    // Tasks done: the only thing left is extraction. Route everyone to the
    // exit — without this the Loyalists finish all five tasks and then mill
    // around forever, because nothing else in the fallback brain knows the
    // exit exists and the win condition can never be satisfied.
    if (ctx.exitOpen && ctx.exit) {
      actions.briefing = 'Extraction is open. ' +
        describeRoute(state.maze, me.pos, ctx.exit, me.facing ?? null, 'Get out.');
      actions.target = ctx.exit;
      return actions;
    }

    const task = ctx.tasks[0];
    if (task) {
      const idx = Number(agent.playerId.replace(/\D/g, '')) || 1;
      const tile = task.type === 'SEQUENCE'
        ? (task.tiles[task.progress?.sequenceIndex ?? 0] ?? task.tiles[0])
        : task.tiles[(idx - 1) % task.tiles.length];
      actions.briefing = describeRoute(state.maze, me.pos, tile, me.facing ?? null);
      actions.target = tile;
    } else {
      actions.briefing = 'Stay put. Nothing revealed yet.';
    }
  }

  return actions;
}

function nearestSaboteurTile(state, agent) {
  const sabs = Object.values(state.players).filter(p => p.alive && p.team === TEAM.SABOTEUR);
  return sabs[0]?.pos ?? null;
}

function bearing(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'east' : 'west';
  return dy > 0 ? 'south' : 'north';
}

function parseActions(raw, agent, state, ctx) {
  try {
    const cleaned = String(raw).replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      messages: Array.isArray(parsed.messages) ? parsed.messages.slice(0, CONFIG.AGENT.MAX_MESSAGES_PER_TICK) : [],
      purchase: parsed.purchase ?? null,
      briefing: clampSentences(parsed.briefing ?? '', CONFIG.AGENT.BRIEF_MAX_SENTENCES),
      accepts: parsed.accepts ?? [],
      corrupted: Boolean(parsed.corrupted),
    };
  } catch {
    return fallbackBrain(agent, state, ctx);
  }
}

/** Hard cap on briefing length. A rambling advisor kills the pace. */
export function clampSentences(text, max) {
  const parts = String(text).match(/[^.!?]+[.!?]*/g) ?? [text];
  return parts.slice(0, max).join(' ').trim();
}
