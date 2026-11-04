import { CONFIG } from '../config.js';

/**
 * How much MON each wallet needs, by intent.
 *
 * Single source of truth for both `npm run wallets` (report) and
 * `npm run fund` (act), so the two can never disagree about what "funded"
 * means. Everything derives from CONFIG — change STARTING_MON or the powerup
 * table and these move with it.
 */

/** Gas headroom for one agent across a full 40-tick game. */
export const GAS_ALLOWANCE = Number(process.env.AGENT_GAS_ALLOWANCE ?? 0.5);

/** Engine gas: contract deploys plus a release() per accepted bribe. */
export const ENGINE_RESERVE = Number(process.env.ENGINE_GAS_RESERVE ?? 1.0);

/**
 * PROVE — the minimum for `npm run phase1` to pass.
 *
 * Derived from what the acceptance script actually spends, not guessed:
 *   p1  sends CONTACT_FEE, then locks a 0.5 escrow  → both + gas
 *   p3  buys the most expensive powerup it tests    → cost + gas
 *   p2  only ever receives                          → nothing
 */
export function proveTargets() {
  const escrowProbe = 0.5;
  return {
    engine: ENGINE_RESERVE,
    p1: CONFIG.ECONOMY.CONTACT_FEE + escrowProbe + GAS_ALLOWANCE,
    p3: CONFIG.POWERUPS.REVEAL.cost + GAS_ALLOWANCE,
  };
}

/** PLAY — a full live game: every agent carries a real stake. */
export function playTargets() {
  const t = { engine: ENGINE_RESERVE };
  for (let i = 1; i <= CONFIG.GAME.PLAYERS; i++) {
    t[`p${i}`] = CONFIG.ECONOMY.STARTING_MON + GAS_ALLOWANCE;
  }
  return t;
}

export function targetsFor(mode) {
  return mode === 'play' ? playTargets() : proveTargets();
}

/**
 * Work out who is short and by how much.
 * `balances` is the array returned by wallets.allBalances().
 */
export function deficits(balances, mode) {
  const targets = targetsFor(mode);
  return balances
    .map(b => ({ ...b, target: targets[b.id] ?? 0 }))
    .map(b => ({ ...b, short: Math.max(0, b.target - b.balance) }))
    .filter(b => b.short > 0);
}
