import { CONFIG } from '../src/config.js';
import {
  loadWallets, allBalances, balanceOf, sendNative, explorer, isMonadTestnet,
} from '../src/economy/wallets.js';
import { deficits, ENGINE_RESERVE } from '../src/economy/funding.js';

/**
 * Distribute MON from the engine wallet to the agents.
 *
 *   npm run fund            # top agents up to the phase1 minimum
 *   npm run fund -- --play  # top agents up to a full-game stake
 *   npm run fund -- --dry   # show the plan, send nothing
 *
 * Exists because faucets are rate-limited per address. Claiming into nine
 * separate wallets takes nine days; claiming into one and fanning out takes
 * a minute. Nothing here is hardcoded — targets come from funding.js, which
 * derives them from CONFIG.
 *
 * Sends go through wallets.sendNative, so the per-wallet 1.5s reserve-balance
 * gate applies. The engine is below 10 MON, which means every one of these
 * transfers depends on the emptying-transaction exception; back-to-back sends
 * without that gate would revert.
 */

const MODE = process.argv.includes('--play') ? 'play' : 'prove';
const DRY = process.argv.includes('--dry');

const w = loadWallets();
if (!w) {
  console.error('\nAGENT_MNEMONIC is not set in .env.\n');
  process.exit(1);
}
if (CONFIG.MOCK_CHAIN) {
  console.error('\nMOCK_CHAIN is true — there is nothing to fund. Set MOCK_CHAIN=false.\n');
  process.exit(1);
}

console.log(`\nKhiana funding — ${isMonadTestnet ? 'Monad testnet' : `local chain ${CONFIG.CHAIN.CHAIN_ID}`}`);
console.log(`target: ${MODE.toUpperCase()}${DRY ? '   (dry run)' : ''}\n`);

const balances = await allBalances();
const engineBalance = balances.find(b => b.id === 'engine').balance;

// Never spend the engine below its own gas reserve — it still has to pay for
// every release() for the rest of the game, and a broke attestor means locked
// bribes that can never be settled.
const spendable = Math.max(0, engineBalance - ENGINE_RESERVE);

const need = deficits(balances, MODE).filter(d => d.id !== 'engine');
const totalNeed = need.reduce((s, d) => s + d.short, 0);

console.log(`engine    ${engineBalance.toFixed(4)} MON   spendable ${spendable.toFixed(4)} (keeps ${ENGINE_RESERVE} for gas)`);
console.log(`requested ${totalNeed.toFixed(4)} MON across ${need.length} wallet(s)\n`);

if (need.length === 0) {
  console.log('Everything is already at target. Nothing to do.\n');
  process.exit(0);
}

// If the engine can't cover everyone, scale every allocation by the same
// factor rather than fully funding the first few and starving the rest —
// a half-funded roster of 8 is recoverable, 3 funded and 5 empty is not.
const scale = totalNeed > spendable ? spendable / totalNeed : 1;
if (scale < 1) {
  console.log(`Engine cannot cover the full ask. Scaling every allocation to ${(scale * 100).toFixed(1)}%.`);
  console.log('Top up the engine from the faucet and re-run to close the gap.\n');
}

const plan = need
  .map(d => ({ ...d, send: Math.floor(d.short * scale * 1e6) / 1e6 }))  // 6dp, avoids float dust
  .filter(d => d.send > 0);

for (const p of plan) {
  console.log(`  ${p.id.padEnd(4)} ${p.address}  ${p.balance.toFixed(4)} → ${(p.balance + p.send).toFixed(4)}   send ${p.send}`);
}

if (DRY) {
  console.log('\nDry run — nothing sent.\n');
  process.exit(0);
}

console.log(`\nSending ${plan.length} transfer(s), ~1.5s apart for the reserve-balance gate…\n`);

let sent = 0, failed = 0;
for (const p of plan) {
  const res = await sendNative(w.engine, p.address, p.send);
  if (res.ok) {
    sent++;
    console.log(`  ✓ ${p.id}  ${p.send} MON   ${explorer.tx(res.txHash)}`);
  } else {
    failed++;
    console.log(`  ✗ ${p.id}  ${res.error ?? 'failed'}`);
  }
}

console.log(`\n${sent} sent, ${failed} failed.`);

const after = await allBalances();
console.log('\nfinal balances:');
for (const b of after) {
  if (b.balance > 0 || plan.some(p => p.id === b.id)) {
    console.log(`  ${b.id.padEnd(7)} ${b.balance.toFixed(4)} MON`);
  }
}

const stillShort = deficits(after, MODE).filter(d => d.id !== 'engine');
console.log(
  stillShort.length === 0
    ? `\nAll ${MODE} targets met. Next:  npm run phase1\n`
    : `\n${stillShort.length} wallet(s) still short — engine needs more from the faucet.\n`
);

process.exit(failed > 0 ? 1 : 0);
