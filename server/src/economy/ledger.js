import { CONFIG } from '../config.js';

/**
 * Every movement of MON is recorded here, and the whole thing is published
 * at game end. That reveal is the emotional payoff of the product — each
 * player finds out what their agent was paid and by whom.
 *
 * It is worthless if the host could fabricate it, which is exactly why every
 * entry carries an on-chain tx hash. Public settlement is the only version
 * anyone in that room will believe.
 */

export function createLedger() {
  return {
    entries: [],
    burned: 0,
    startingSupply: CONFIG.GAME.PLAYERS * CONFIG.ECONOMY.STARTING_MON,
  };
}

export function record(ledger, entry) {
  const e = {
    seq: ledger.entries.length,
    tick: entry.tick,
    kind: entry.kind,            // CONTACT | BRIBE | POWERUP | BOUNTY | PAYOUT
    from: entry.from,
    to: entry.to ?? null,        // null = burned
    amount: Number(entry.amount.toFixed(4)),
    memo: entry.memo ?? null,    // the instruction attached to a bribe
    txHash: entry.txHash ?? null,
    followed: entry.followed ?? null,  // did the bribed agent actually comply?
    // WHISPER: hidden from the per-player reveal, never from the audience.
    // The spectator ledger shows every entry regardless of this flag.
    whispered: entry.whispered ?? false,
    ts: Date.now(),
  };
  ledger.entries.push(e);
  if (!e.to) ledger.burned += e.amount;
  return e;
}

/**
 * Mark whether a bribe was honoured. Filled in after the briefing phase, once
 * we know what the agent actually told its human. This column is the one the
 * audience cares about most.
 */
export function markFollowed(ledger, seq, followed) {
  const e = ledger.entries[seq];
  if (e) e.followed = followed;
}

export function balanceOf(ledger, agentId, starting = CONFIG.ECONOMY.STARTING_MON) {
  let b = starting;
  for (const e of ledger.entries) {
    if (e.from === agentId) b -= e.amount;
    if (e.to === agentId) b += e.amount;
  }
  return Number(b.toFixed(4));
}

/** The end-of-game reveal, grouped per player. */
export function buildReveal(state) {
  const byAgent = {};
  for (const p of Object.values(state.players)) {
    byAgent[p.id] = {
      player: p.name,
      team: p.team,
      alive: p.alive,
      goalWeight: p.agent.goalWeight,
      finalBalance: Number(p.agent.balance.toFixed(2)),
      received: [],
      paid: [],
      spent: [],
    };
  }

  for (const e of state.ledger.entries) {
    if (e.kind === 'POWERUP' && byAgent[e.from]) {
      byAgent[e.from].spent.push(e);
    } else if (e.kind === 'BRIBE') {
      // A whispered bribe is struck from the victim's copy of the reveal —
      // that is the whole 0.50. The payer still sees what they paid for, and
      // the audience-facing ledger below is untouched.
      if (byAgent[e.to] && !e.whispered) byAgent[e.to].received.push(e);
      if (byAgent[e.from]) byAgent[e.from].paid.push(e);
    }
  }

  return {
    winner: state.winner,
    perAgent: byAgent,
    totalBurned: Number(state.ledger.burned.toFixed(2)),
    totalBribed: Number(
      state.ledger.entries
        .filter(e => e.kind === 'BRIBE')
        .reduce((s, e) => s + e.amount, 0)
        .toFixed(2)
    ),
    betrayals: state.ledger.entries.filter(e => e.kind === 'BRIBE' && e.followed === true).length,
    entries: state.ledger.entries,
  };
}

/**
 * Winning team splits ALL remaining MON across SURVIVING pairs.
 * Dead humans' agents get nothing regardless of team — this is the constraint
 * that stops betrayal from being free, because a bribed agent whose human dies
 * still loses everything.
 */
export function settlePayout(state) {
  const survivors = Object.values(state.players).filter(
    p => p.alive && p.team === state.winner
  );
  if (!survivors.length) return [];

  const pot = Object.values(state.players).reduce((s, p) => s + p.agent.balance, 0);
  const share = pot / survivors.length;

  return survivors.map(p => {
    p.agent.balance = share;
    return { agentId: p.id, share: Number(share.toFixed(2)) };
  });
}
