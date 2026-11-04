import { CONFIG } from '../config.js';

/**
 * How much MON each wallet needs, by intent.
 *
 * Single source of truth for both `npm run wallets` (report) and
 * `npm run fund` (act), so the two can never disagree about what "funded"
 * means. Everything derives from CONFIG — change STARTING_MON or the powerup
 * table and these move with it.
 */

/**
 * Engine gas. The engine submits EVERY transaction in the game — stakes,
 * contact fees, escrow locks and releases, powerup burns, the payout, the role
 * commit and reveal — roughly 50–70 per game, at a 100k–400k gas limit each,
 * and Monad bills the limit. Plus the four contract deploys. 5 MON covers the
 * deploy and a few games; raise ENGINE_GAS_RESERVE for a long demo day.
 */
export const ENGINE_RESERVE = Number(process.env.ENGINE_GAS_RESERVE ?? 5.0);

/**
 * Agents hold no MON at all. Since stakes moved to KHIA they only sign
 * EIP-3009 authorizations, which the engine submits and pays for, and their
 * KHIA comes from the engine's treasury at the start of each game
 * (economy/stakes.js). These used to ask for 5.5 MON per agent — a native
 * stake from before KHIA existed, plus gas they never spend.
 */
export function proveTargets() {
  return { engine: ENGINE_RESERVE };
}

/** PLAY — identical: a live game needs only engine gas. */
export function playTargets() {
  return { engine: ENGINE_RESERVE };
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
