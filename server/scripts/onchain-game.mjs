import { spawn } from 'child_process';
import { createServer } from 'net';

import { CONFIG } from '../src/config.js';
import { loadWallets, hasCode, explorer, isMonadTestnet } from '../src/economy/wallets.js';
import { creditAddress, creditBalance, allCreditBalances, totalSupply } from '../src/economy/credit.js';

/**
 * Play one complete game on chain and prove the books balance.
 *
 *   cd server && npm run game:onchain
 *
 * `npm run x402` proves each kind of payment works on its own. This proves
 * they compose: a whole game of contacts, escrowed bribes, releases, refunds,
 * burns and a payout, after which every agent's wallet must hold exactly what
 * the engine believes it holds, the escrow must hold nothing of this game's,
 * and the supply must have fallen by exactly what was burned.
 *
 * Runs bots only, on short ticks. Spends real KHIA and gas, so it is not part
 * of `npm test`. Shorten further with TICK_MS / TOTAL_TICKS.
 */

const PORT = Number(process.env.ONCHAIN_GAME_PORT ?? 8790);
const BASE = `http://localhost:${PORT}`;
const TICK_MS = process.env.TICK_MS ?? '6000';
const TOTAL_TICKS = process.env.TOTAL_TICKS ?? '24';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
};
const step = t => console.log(`\n${t}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = async path => (await fetch(`${BASE}${path}`)).json();

if (CONFIG.MOCK_CHAIN) { console.error('\nMOCK_CHAIN is true — this proves nothing. Set MOCK_CHAIN=false.\n'); process.exit(1); }
const w = loadWallets();
if (!w) { console.error('\nAGENT_MNEMONIC is not set.\n'); process.exit(1); }
for (const [name, addr] of [
  ['CREDIT_ADDRESS', creditAddress()], ['ESCROW_ADDRESS', CONFIG.CHAIN.ESCROW_ADDRESS],
  ['SHOP_ADDRESS', CONFIG.CHAIN.SHOP_ADDRESS], ['COMMIT_ADDRESS', CONFIG.CHAIN.COMMIT_ADDRESS],
]) {
  if (!addr || !(await hasCode(addr))) { console.error(`\n${name} is unset or has no code. Deploy first.\n`); process.exit(1); }
}

await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.once('listening', () => probe.close(resolve));
  probe.listen(PORT);
}).catch(() => { console.error(`\nPort ${PORT} is busy. Set ONCHAIN_GAME_PORT.\n`); process.exit(1); });

console.log(`\nKhiana — full game on chain  ·  ${isMonadTestnet ? 'MONAD TESTNET' : `chain ${CONFIG.CHAIN.CHAIN_ID}`}`);
console.log(`ticks ${TOTAL_TICKS} × ${TICK_MS}ms\n`);

const supplyBefore = await totalSupply();
const escrowBefore = await creditBalance(CONFIG.CHAIN.ESCROW_ADDRESS);

const srv = spawn('node', ['src/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), X402_RESOURCE_BASE: BASE, TICK_MS, TOTAL_TICKS },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvOut = '';
srv.stdout.on('data', d => { srvOut += d; });
srv.stderr.on('data', d => { srvOut += d; });

const done = code => {
  srv.kill('SIGKILL');
  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  ✗ ${f.name}  ${f.detail}`);
    console.log('\nserver output:\n' + srvOut.slice(-2000));
  }
  console.log('');
  process.exit(code ?? (failed.length ? 1 : 0));
};

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up yet */ }
    if (srv.exitCode !== null) throw new Error(`server exited:\n${srvOut}`);
    await sleep(500);
  }

  // ── Start: stake, commit ──────────────────────────────────────────────────
  step('Start');
  const t0 = Date.now();
  const start = await (await fetch(`${BASE}/game/start`, { method: 'POST' })).json();
  check('game started on chain', start.onChain === true, start.chainError ?? `stake in ${Date.now() - t0}ms`);
  if (!start.onChain) done(1);
  check('role commitment published', Boolean(start.roleCommit?.txHash), start.roleCommit?.txHash ?? 'none');

  const staked = await allCreditBalances();
  const stakeOk = staked.filter(b => b.id !== 'engine').every(b => b.credit === CONFIG.ECONOMY.STARTING_MON);
  check(`every agent staked exactly ${CONFIG.ECONOMY.STARTING_MON} KHIA`, stakeOk,
    staked.filter(b => b.id !== 'engine').map(b => `${b.id}:${b.credit}`).join(' '));

  // ── Play ──────────────────────────────────────────────────────────────────
  step('Playing');
  let last = -1, maxGap = 0, lastAt = Date.now();
  for (;;) {
    await sleep(500);
    const { room } = await getJson('/rooms/MAIN');
    if (room.tick !== last) {
      if (last >= 1) maxGap = Math.max(maxGap, Date.now() - lastAt);
      last = room.tick; lastAt = Date.now();
      process.stdout.write(`\r  tick ${room.tick}/${room.totalTicks}`);
    }
    if (room.winner) { console.log(`\r  ${room.winner} won at tick ${room.tick}   `); break; }
    if (Date.now() - t0 > 30 * 60_000) throw new Error('game did not finish in 30 minutes');
  }
  check('ticks never overlapped', maxGap >= Number(TICK_MS) * 0.9, `longest gap ${maxGap}ms, tick ${TICK_MS}ms`);

  // ── Settle: payout, then every escrow closed ──────────────────────────────
  step('Settlement');
  let reveal;
  for (let i = 0; i < 240; i++) {
    reveal = await getJson('/game/reveal');
    if (reveal.payout?.status !== 'PENDING') break;
    await sleep(500);
  }
  const payout = reveal.payout ?? {};
  check('payout settled on chain', payout.status === 'SETTLED',
    `${payout.status}${payout.transfers ? `, ${payout.transfers.length} transfer(s)` : ''}`);
  for (const t of (payout.transfers ?? []).filter(t => !t.ok)) {
    check(`payout ${t.from} → ${t.to}`, false, t.error);
  }

  // Lapsed bribes refund only after the escrow's TTL, so this can take a
  // few ticks' worth of wall time after the game ends.
  const open = () => reveal.entries.filter(e => ['LOCKED', 'RELEASING', 'REFUNDING'].includes(e.escrow));
  for (let i = 0; i < 240 && open().length; i++) {
    await sleep(1000);
    reveal = await getJson('/game/reveal');
  }
  const bribes = reveal.entries.filter(e => e.kind === 'BRIBE');
  check('every escrow closed', open().length === 0,
    `${bribes.filter(e => e.escrow === 'RELEASED').length} released, ` +
    `${bribes.filter(e => e.escrow === 'REFUNDED').length} refunded, ${open().length} open`);
  for (const b of bribes) {
    console.log(`      tick ${b.tick}  ${b.from} → ${b.to}  ${b.amount} KHIA  ${b.escrow}`);
  }

  // ── Reconcile ─────────────────────────────────────────────────────────────
  step('Ledger vs chain');
  const kinds = reveal.entries.reduce((m, e) => ({ ...m, [e.kind]: (m[e.kind] ?? 0) + 1 }), {});
  check('the game produced payments', reveal.entries.length > 0, JSON.stringify(kinds));
  const unsettled = reveal.entries.filter(e => !e.txHash);
  check('every ledger entry has a transaction', unsettled.length === 0,
    unsettled.map(e => `${e.kind}@${e.tick}`).join(', ') || `${reveal.entries.length} entries`);

  const escrowAfter = await creditBalance(CONFIG.CHAIN.ESCROW_ADDRESS);
  check('escrow holds nothing from this game', Math.abs(escrowAfter - escrowBefore) < 1e-9,
    `${escrowBefore} → ${escrowAfter} KHIA`);

  const burned = reveal.entries.filter(e => e.kind === 'POWERUP').reduce((s, e) => s + e.amount, 0);
  const supplyAfter = await totalSupply();
  check('supply fell by exactly what was burned', Math.abs((supplyBefore - supplyAfter) - burned) < 1e-9,
    `${supplyBefore} → ${supplyAfter} KHIA, ${burned} burned`);

  const proof = await getJson('/proof');
  const chain = Object.fromEntries((await allCreditBalances()).map(b => [b.id, b.credit]));
  const drift = Object.entries(proof.balances).filter(([id, bal]) => Math.abs(chain[id] - bal) > 1e-6);
  check('every agent wallet matches the engine to the unit', drift.length === 0 && proof.inFlight === 0,
    drift.length
      ? drift.map(([id, bal]) => `${id} engine ${bal} vs chain ${chain[id]}`).join('; ')
      : Object.entries(proof.balances).map(([id, b]) => `${id}:${b}`).join(' '));

  const sample = payout.transfers?.find(t => t.txHash) ?? bribes.find(e => e.releaseTx);
  if (sample) console.log(`\n    ${explorer.tx(sample.txHash ?? sample.releaseTx)}\n`);

  done();
} catch (err) {
  console.error('\n' + (err?.stack ?? err));
  done(1);
}
