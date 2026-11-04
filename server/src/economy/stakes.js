import { formatEther, parseEther } from 'viem';
import { CONFIG } from '../config.js';
import { walletFor, sendContract } from './wallets.js';
import { CREDIT_ABI, creditAddress, creditBalanceWei } from './credit.js';
import { payBetween } from './x402.js';

/**
 * The two settlements that bracket a live game: staking every agent before
 * the first tick, and paying the winners after the last.
 *
 * Both work from ON-CHAIN balances, never the in-memory ledger. The ledger is
 * kept in step with the chain tick by tick, but floats drift where wei does
 * not — a 40/3 split summed in JavaScript overshoots the pot by 2e-15, and the
 * last transfer of the payout reverts. Reading the chain and splitting in
 * bigint makes every transfer land exactly.
 *
 * The engine wallet is the treasury. KhianaCredit has no mint, so the supply
 * is minted once at deploy into the engine (KHIA_SUPPLY, sized for many
 * games) and every game draws its stakes from it. Powerups still burn, so the
 * supply still visibly falls — across the whole deployment rather than one
 * round.
 */

const agentIds = () => Array.from({ length: CONFIG.GAME.PLAYERS }, (_, i) => `p${i + 1}`);

async function balancesWei(ids) {
  const out = {};
  await Promise.all(ids.map(async id => {
    out[id] = await creditBalanceWei(walletFor(id).address);
  }));
  return out;
}

/**
 * Set every agent's on-chain balance to exactly STARTING_MON.
 *
 * Without this a second game starts from whatever the first one left behind:
 * the winners hold the pot, the losers hold nothing, and the in-memory 5.0
 * each describes a world the chain does not agree with. Excess comes back to
 * the engine first, because the engine may need it to fund the top-ups.
 */
export async function stakeAgents() {
  const engine = walletFor('engine');
  if (!engine) return { ok: false, error: 'AGENT_MNEMONIC unset' };
  if (!creditAddress()) return { ok: false, error: 'CREDIT_ADDRESS unset' };

  const ids = agentIds();
  const stake = parseEther(String(CONFIG.ECONOMY.STARTING_MON));
  const before = await balancesWei(ids);

  const excess = ids.filter(id => before[id] > stake);
  const short = ids.filter(id => before[id] < stake);

  const returned = await Promise.all(excess.map(id =>
    payBetween(id, 'engine', formatEther(before[id] - stake), { mock: false })
  ));
  const failedReturn = returned.find(r => !r.ok);
  if (failedReturn) return { ok: false, error: `returning excess stake: ${failedReturn.error}` };

  const need = short.reduce((s, id) => s + (stake - before[id]), 0n);
  const treasury = await creditBalanceWei(engine.address);
  if (treasury < need) {
    return {
      ok: false,
      error: `engine treasury holds ${formatEther(treasury)} KHIA, staking needs ${formatEther(need)}. ` +
        'Redeploy KhianaCredit with a larger KHIA_SUPPLY.',
    };
  }

  const toppedUp = await Promise.all(short.map(id =>
    sendContract(engine, {
      address: creditAddress(),
      abi: CREDIT_ABI,
      functionName: 'transfer',
      args: [walletFor(id).address, stake - before[id]],
      gas: 100_000n,
    }).catch(err => ({ ok: false, error: String(err?.shortMessage ?? err) }))
  ));
  const failedTopUp = toppedUp.find(r => !r.ok);
  if (failedTopUp) return { ok: false, error: `topping up stake: ${failedTopUp.error ?? 'reverted'}` };

  const after = await balancesWei(ids);
  const off = ids.filter(id => after[id] !== stake);
  if (off.length) return { ok: false, error: `stake did not settle for ${off.join(', ')}` };

  return {
    ok: true,
    txHashes: [...returned, ...toppedUp].map(r => r.txHash),
    treasury: Number(formatEther(treasury - need)),
  };
}

/**
 * Pay the winning survivors on chain: every agent's balance pooled and split
 * evenly across `winners`. Mirrors ledger.settlePayout, but in wei.
 *
 * Losers' agents pay winners directly rather than routing through the
 * engine, matched greedily so the payout is at most (payers + payees - 1)
 * transfers instead of two per agent.
 */
export async function payoutOnChain(winners) {
  const ids = agentIds();
  if (!winners.length) return { ok: true, transfers: [], balances: null };

  const current = await balancesWei(ids);
  const pot = ids.reduce((s, id) => s + current[id], 0n);
  const n = BigInt(winners.length);
  const target = Object.fromEntries(ids.map(id => [id, 0n]));
  winners.forEach((id, i) => { target[id] = pot / n + (i === 0 ? pot % n : 0n); });

  const payers = ids.filter(id => current[id] > target[id])
    .map(id => ({ id, left: current[id] - target[id] }));
  const payees = ids.filter(id => current[id] < target[id])
    .map(id => ({ id, left: target[id] - current[id] }));

  const plan = [];
  let i = 0, j = 0;
  while (i < payers.length && j < payees.length) {
    const amount = payers[i].left < payees[j].left ? payers[i].left : payees[j].left;
    plan.push({ from: payers[i].id, to: payees[j].id, amount });
    payers[i].left -= amount;
    payees[j].left -= amount;
    if (payers[i].left === 0n) i++;
    if (payees[j].left === 0n) j++;
  }

  const results = await Promise.all(plan.map(t =>
    payBetween(t.from, t.to, formatEther(t.amount), { mock: false })
  ));
  const transfers = plan.map((t, k) => ({
    from: t.from,
    to: t.to,
    amount: Number(formatEther(t.amount)),
    ok: results[k].ok,
    txHash: results[k].txHash ?? null,
    url: results[k].url ?? null,
    error: results[k].error,
  }));

  const settled = await balancesWei(ids);
  return {
    ok: transfers.every(t => t.ok),
    transfers,
    balances: Object.fromEntries(ids.map(id => [id, Number(formatEther(settled[id]))])),
  };
}
