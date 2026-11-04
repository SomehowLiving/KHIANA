import { parseEther, formatEther } from 'viem';

import { CONFIG } from '../src/config.js';
import { loadWallets, sendContract, explorer, isMonadTestnet } from '../src/economy/wallets.js';
import { CREDIT_ABI, creditAddress, allCreditBalances, totalSupply } from '../src/economy/credit.js';

/**
 * Hand each agent its KHIA stake.
 *
 *   npm run distribute          # top every agent up to STARTING_MON
 *   npm run distribute -- --dry # show the plan, send nothing
 *
 * This is the step the public faucet used to make impossible. The whole supply
 * is already ours, so an eight-agent game funds in one pass instead of nine
 * days of rate-limited claims.
 *
 * Gas is paid in native MON by the engine; the credits themselves are ERC-20,
 * so the reserve-balance rule does not apply to the transfer amounts — only to
 * the engine's own MON balance. The per-wallet gate still spaces the sends.
 */

const DRY = process.argv.includes('--dry');
const STAKE = CONFIG.ECONOMY.STARTING_MON;

const w = loadWallets();
if (!w) { console.error('\nAGENT_MNEMONIC is not set.\n'); process.exit(1); }
if (CONFIG.MOCK_CHAIN) { console.error('\nMOCK_CHAIN is true — nothing to distribute.\n'); process.exit(1); }
if (!creditAddress()) { console.error('\nCREDIT_ADDRESS is not set — deploy KhianaCredit first.\n'); process.exit(1); }

console.log(`\nKhiana credit distribution — ${isMonadTestnet ? 'Monad testnet' : `chain ${CONFIG.CHAIN.CHAIN_ID}`}`);
console.log(`token   ${creditAddress()}`);
console.log(`supply  ${await totalSupply()} KHIA${DRY ? '   (dry run)' : ''}\n`);

const balances = await allCreditBalances();
const engine = balances.find(b => b.id === 'engine');

const plan = balances
  .filter(b => b.id !== 'engine')
  .map(b => ({ ...b, send: Math.max(0, STAKE - b.credit) }))
  .filter(b => b.send > 0);

const total = plan.reduce((s, p) => s + p.send, 0);

console.log(`engine holds ${engine.credit} KHIA, needs to send ${total.toFixed(2)}\n`);
for (const p of plan) {
  console.log(`  ${p.id.padEnd(4)} ${p.address}  ${p.credit.toFixed(2)} → ${STAKE}   send ${p.send.toFixed(2)}`);
}

if (plan.length === 0) { console.log('\nEvery agent is already staked.\n'); process.exit(0); }
if (total > engine.credit) {
  console.error(`\nEngine holds ${engine.credit} KHIA but needs ${total.toFixed(2)}. Aborting rather than partially staking.\n`);
  process.exit(1);
}
if (DRY) { console.log('\nDry run — nothing sent.\n'); process.exit(0); }

console.log(`\nSending ${plan.length} transfer(s)…\n`);
let sent = 0, failed = 0;
for (const p of plan) {
  const res = await sendContract(w.engine, {
    address: creditAddress(),
    abi: CREDIT_ABI,
    functionName: 'transfer',
    args: [p.address, parseEther(String(p.send))],
    gas: 100_000n,
  }).catch(err => ({ ok: false, error: String(err?.shortMessage ?? err) }));

  if (res.ok) { sent++; console.log(`  ✓ ${p.id}  ${p.send.toFixed(2)} KHIA   ${explorer.tx(res.txHash)}`); }
  else { failed++; console.log(`  ✗ ${p.id}  ${res.error}`); }
}

console.log(`\n${sent} sent, ${failed} failed.\n`);
const after = await allCreditBalances();
for (const b of after) console.log(`  ${b.id.padEnd(7)} ${b.credit.toFixed(2)} KHIA`);
console.log('');
process.exit(failed ? 1 : 0);
