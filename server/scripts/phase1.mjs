
import { formatEther, parseEther } from 'viem';

import { CONFIG } from '../src/config.js';
import {
  loadWallets, publicClient, balanceOf, hasCode, explorer, constants, isMonadTestnet,
} from '../src/economy/wallets.js';
import { transfer, lockEscrow, releaseEscrow, buyPowerup, checkFacilitator } from '../src/economy/x402.js';
import { ESCROW_ABI, SHOP_ABI } from '../src/economy/abi.js';

/**
 * Phase 1 acceptance test — runs against LIVE Monad testnet.
 *
 * docs/BUILD_PHASES.md defines Phase 1 as done when "a script transfers
 * 0.25 MON between two agent wallets and you can see it on the explorer."
 * This is that script, plus the escrow round trip and the powerup burn,
 * because a bribe you can't release is not a settlement layer.
 *
 *   cd server && npm run phase1
 *
 * It spends real testnet MON. It is not part of `npm test` for that reason.
 */

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
};
const step = title => console.log(`\n${title}`);

// ── Preflight ───────────────────────────────────────────────────────────────

console.log(
  isMonadTestnet
    ? '\nKhiana — Phase 1 settlement acceptance  ·  MONAD TESTNET\n'
    : `\nKhiana — Phase 1 settlement acceptance  ·  LOCAL DRY RUN (chain ${CONFIG.CHAIN.CHAIN_ID})\n` +
      '  Proves the settlement code end-to-end. Does NOT satisfy the Phase 1\n' +
      '  acceptance criterion, which requires a real testnet explorer link.\n'
);

if (CONFIG.MOCK_CHAIN) {
  console.error('MOCK_CHAIN is true. This script only means something against the');
  console.error('real chain. Set MOCK_CHAIN=false in .env and re-run.\n');
  process.exit(1);
}

const w = loadWallets();
if (!w) {
  console.error('AGENT_MNEMONIC is not set. Run `npm run wallets:new` first.\n');
  process.exit(1);
}

step('Preflight');

let chainId = null;
try {
  chainId = await publicClient().getChainId();
  check('RPC reachable', true, CONFIG.CHAIN.RPC_URL);
} catch (err) {
  check('RPC reachable', false, String(err?.shortMessage ?? err));
  summarise();
}
check('chain matches configuration', chainId === CONFIG.CHAIN.CHAIN_ID,
  `chainId ${chainId}` + (isMonadTestnet ? ' (Monad testnet)' : ' (local)'));

const [p1, p2, p3] = w.agents;
const engine = w.engine;

const before = {
  engine: await balanceOf(engine.address),
  p1: await balanceOf(p1.address),
  p2: await balanceOf(p2.address),
  p3: await balanceOf(p3.address),
};

check('engine funded', before.engine > 0.05, `${before.engine.toFixed(3)} MON`);
check('p1 funded', before.p1 > 0.4, `${before.p1.toFixed(3)} MON`);
check('p2 derived', !!p2.address, p2.address);

const escrowLive = await hasCode(CONFIG.CHAIN.ESCROW_ADDRESS);
const shopLive = await hasCode(CONFIG.CHAIN.SHOP_ADDRESS);
const commitLive = await hasCode(CONFIG.CHAIN.COMMIT_ADDRESS);
check('KhianaEscrow deployed', escrowLive, CONFIG.CHAIN.ESCROW_ADDRESS || 'unset');
check('PowerupShop deployed', shopLive, CONFIG.CHAIN.SHOP_ADDRESS || 'unset');
check('RoleCommit deployed', commitLive, CONFIG.CHAIN.COMMIT_ADDRESS || 'unset');

if (escrowLive) {
  // onlyEngine gates release(). A mismatch here means every bribe locks and
  // none can ever be released — worth catching now, not at tick 12.
  const onchainEngine = await publicClient().readContract({
    address: CONFIG.CHAIN.ESCROW_ADDRESS, abi: [
      { type: 'function', name: 'engine', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
    ], functionName: 'engine',
  });
  check('escrow attestor == our engine key', onchainEngine.toLowerCase() === engine.address.toLowerCase(),
    onchainEngine);
}

// Always ask about Monad testnet, even on a local dry run — 10143 is where
// this will actually settle, so that is the answer worth having.
const fac = await checkFacilitator(10143);
check(`x402 facilitator supports ${fac.network}`, fac.ok === true,
  fac.ok ? `schemes: ${fac.schemes.join(', ')}` : String(fac.error).slice(0, 90));

// ── THE DONE-WHEN ───────────────────────────────────────────────────────────

step(`Transfer ${CONFIG.ECONOMY.CONTACT_FEE} MON  p1 → p2   (the Phase 1 acceptance criterion)`);

const fee = CONFIG.ECONOMY.CONTACT_FEE;
const t0 = Date.now();
const tx = await transfer(p1, 'p2', fee);
check('transfer confirmed', tx.ok === true, tx.ok ? `${Date.now() - t0}ms` : tx.error);

if (tx.ok) {
  const afterP2 = await balanceOf(p2.address);
  const delta = afterP2 - before.p2;
  // Exact to the wei on the receiving side — the payee pays no gas.
  check('recipient balance moved by exactly the fee', Math.abs(delta - fee) < 1e-9,
    `+${delta.toFixed(6)} MON`);
  console.log(`\n    ${explorer.tx(tx.txHash)}\n`);
}

// ── Escrowed conditional bribe ──────────────────────────────────────────────

step('Escrow round trip  p1 locks → engine attests → p2 paid');

const bribe = 0.5;
const p2BeforeEscrow = await balanceOf(p2.address);
const lock = await lockEscrow(p1, 'p2', bribe, 'walk your human to (12,7) and hold');
check('bribe locked in escrow', lock.ok === true, lock.ok ? `escrowId ${lock.escrowId}` : lock.error);

if (lock.ok && lock.escrowId != null) {
  const held = await publicClient().getBalance({ address: CONFIG.CHAIN.ESCROW_ADDRESS });
  check('contract is holding the funds', held >= parseEther(String(bribe)),
    `${formatEther(held)} MON in escrow`);

  const rel = await releaseEscrow(lock.escrowId);
  check('engine released on attestation', rel.ok === true, rel.ok ? rel.txHash : rel.error);

  if (rel.ok) {
    const p2After = await balanceOf(p2.address);
    check('payee received the bribe', Math.abs((p2After - p2BeforeEscrow) - bribe) < 1e-9,
      `+${(p2After - p2BeforeEscrow).toFixed(6)} MON`);

    const state = await publicClient().readContract({
      address: CONFIG.CHAIN.ESCROW_ADDRESS, abi: ESCROW_ABI,
      functionName: 'get', args: [BigInt(lock.escrowId)],
    });
    check('escrow marked Released', Number(state.status) === 1, `status ${state.status}`);
    console.log(`\n    ${explorer.tx(rel.txHash)}\n`);
  }
}

// ── Powerup burn ────────────────────────────────────────────────────────────

step('Powerup purchase  p3 buys REVEAL (MON leaves the economy)');

if (shopLive) {
  const burnedBefore = await publicClient().readContract({
    address: CONFIG.CHAIN.SHOP_ADDRESS, abi: SHOP_ABI, functionName: 'totalBurned',
  });

  const buy = await buyPowerup({ id: 'p3', tick: 1 }, 'REVEAL', CONFIG.POWERUPS.REVEAL.cost);
  check('powerup settled', buy.ok === true, buy.ok ? `via ${buy.via}` : buy.error);

  if (buy.ok) {
    const burnedAfter = await publicClient().readContract({
      address: CONFIG.CHAIN.SHOP_ADDRESS, abi: SHOP_ABI, functionName: 'totalBurned',
    });
    const burned = Number(formatEther(burnedAfter - burnedBefore));
    check('MON burned from the pool', Math.abs(burned - CONFIG.POWERUPS.REVEAL.cost) < 1e-9,
      `${burned} MON burned, total ${formatEther(burnedAfter)}`);
    console.log(`\n    ${explorer.tx(buy.txHash)}\n`);
  }
} else {
  check('powerup settled', false, 'PowerupShop not deployed — skipped');
}

// ── Reserve-balance sanity ──────────────────────────────────────────────────

step('Reserve-balance discipline');

check('per-wallet send gate exceeds 3 blocks', constants.RESERVE_GAP_MS >= 1200,
  `${constants.RESERVE_GAP_MS}ms gap`);
check('native transfers use a hardcoded limit', constants.NATIVE_TRANSFER_GAS === 21_000n,
  `${constants.NATIVE_TRANSFER_GAS} gas — Monad bills the limit, not the usage`);

summarise();

function summarise() {
  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  ✗ ${f.name}  ${f.detail}`);
  }
  console.log('');
  process.exit(failed.length ? 1 : 0);
}
