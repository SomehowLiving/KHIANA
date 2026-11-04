
import { loadWallets, newMnemonic, allBalances, explorer, AGENT_COUNT } from '../src/economy/wallets.js';
import { targetsFor } from '../src/economy/funding.js';
import { CONFIG } from '../src/config.js';

/**
 * Wallet utility.
 *
 *   npm run wallets:new   → generate a mnemonic (prints only, never writes .env)
 *   npm run wallets       → print the nine addresses and their live balances
 *
 * Deliberately does not write to .env. A script that silently rotates the
 * mnemonic would orphan every funded address and every deployed contract's
 * engine binding — a slow, confusing failure. You paste it in yourself.
 */

const STAKE = CONFIG.ECONOMY.STARTING_MON;
const MODE = process.argv.includes('--play') ? 'play' : 'prove';

// Targets live in economy/funding.js so this report and `npm run fund` can
// never disagree about what "funded" means.
const targets = targetsFor(MODE);
const need = id => targets[id] ?? 0;

if (process.argv.includes('--new')) {
  console.log('\nGenerated mnemonic — paste into .env as AGENT_MNEMONIC:\n');
  console.log('  ' + newMnemonic() + '\n');
  console.log('Testnet only. Then run `npm run wallets` to see what to fund.\n');
  process.exit(0);
}

const w = loadWallets();
if (!w) {
  console.error('\nAGENT_MNEMONIC is not set in .env.');
  console.error('Run `npm run wallets:new` to generate one.\n');
  process.exit(1);
}

console.log(`\nKhiana wallets — Monad testnet (chain ${CONFIG.CHAIN.CHAIN_ID})\n`);

let balances = null;
try {
  balances = await allBalances();
} catch (err) {
  console.log(`  (could not reach ${CONFIG.CHAIN.RPC_URL} — showing addresses only)`);
  console.log(`   ${err?.shortMessage ?? err}\n`);
}

const rows = balances ?? [w.engine, ...w.agents].map(x => ({ id: x.id, address: x.address, balance: null }));

console.log(
  MODE === 'prove'
    ? '  target: MINIMUM to prove Phase 1 (`npm run phase1`)   — add --play for a full 8-agent game\n'
    : `  target: FULL live game, ${AGENT_COUNT} agents at ${STAKE} MON stake\n`
);

let short = 0;
let deficit = 0;
for (const r of rows) {
  const want = need(r.id);
  const bal = r.balance;
  let flag = '';
  if (bal !== null) {
    if (want === 0) flag = '  —  (receives only)';
    else if (bal >= want) flag = '  ok';
    else { flag = `  NEEDS ${(want - bal).toFixed(2)} MON`; short++; deficit += want - bal; }
  } else if (want > 0) {
    flag = `  fund ~${want} MON`;
  }
  console.log(
    `  ${r.id.padEnd(7)} ${r.address}` +
    (bal === null ? '' : `  ${bal.toFixed(3).padStart(9)} MON`) + flag
  );
}

console.log(`\n  explorer: ${explorer.address(w.engine.address)}`);

if (balances && short === 0) {
  console.log(
    MODE === 'prove'
      ? '\n  Funded. Next:  cd ../contracts && npm run deploy\n'
      : '\n  Funded for a full game.\n'
  );
} else {
  const total = balances
    ? `${deficit.toFixed(2)} MON still needed`
    : `${rows.reduce((s, r) => s + need(r.id), 0).toFixed(2)} MON total`;
  console.log(`\n  ${total}. Faucet: https://faucet.monad.xyz\n`);
}
