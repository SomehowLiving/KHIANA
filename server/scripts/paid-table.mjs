import { spawn } from 'child_process';
import WebSocket from 'ws';
import { createWalletClient, http, parseEther, formatEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { CONFIG } from '../src/config.js';
import { walletFor, sendNative, publicClient, chain, explorer, isMonadTestnet } from '../src/economy/wallets.js';
import { POT_ABI } from '../src/economy/abi.js';

/**
 * A paid table, end to end, with real player wallets.
 *
 *   cd server && npm run pot:test
 *
 * Two throwaway player wallets are funded with a little MON by the engine.
 * The script checks that a seat is refused without payment and with a forged
 * signature, then both players pay and sit at a 4-seat paid table, the game
 * plays out, and the pot must settle: rake to the treasury, the rest to the
 * winners (or back to the entrants, less the rake, if no paying player won).
 * Leftover MON is swept back to the engine.
 */

const PORT = Number(process.env.POT_TEST_PORT ?? 8791);
const BASE = `http://localhost:${PORT}`;
const FEE = Number(process.env.POT_TEST_FEE ?? 0.01);
const FUND = FEE + 0.03;   // the fee plus gas for one enter()

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
};
const step = t => console.log(`\n${t}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = async p => (await fetch(`${BASE}${p}`)).json();

if (CONFIG.MOCK_CHAIN || !CONFIG.CHAIN.POT_ADDRESS) {
  console.error('\nNeeds MOCK_CHAIN=false and POT_ADDRESS set (deploy first).\n');
  process.exit(1);
}
const engine = walletFor('engine');
if (!engine) { console.error('\nAGENT_MNEMONIC is not set.\n'); process.exit(1); }

const srv = spawn('node', ['src/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), X402_RESOURCE_BASE: BASE, TICK_MS: '4000', TOTAL_TICKS: '8' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvOut = '';
srv.stdout.on('data', d => { srvOut += d; });
srv.stderr.on('data', d => { srvOut += d; });

const players = [0, 1].map(() => {
  const account = privateKeyToAccount(generatePrivateKey());
  return { account, client: createWalletClient({ account, chain, transport: http(CONFIG.CHAIN.RPC_URL) }) };
});

async function sweepBack() {
  for (const p of players) {
    try {
      const bal = await publicClient().getBalance({ address: p.account.address });
      const gasPrice = await publicClient().getGasPrice();
      const keep = 21_000n * gasPrice * 2n;
      if (bal > keep) {
        await p.client.sendTransaction({ to: engine.address, value: bal - keep, gas: 21_000n });
      }
    } catch { /* best effort: a few thousandths of testnet MON */ }
  }
}

const done = async code => {
  await sweepBack();
  srv.kill('SIGKILL');
  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  ✗ ${f.name}  ${f.detail}`);
    console.log('\nserver output:\n' + srvOut.slice(-1500));
  }
  console.log('');
  process.exit(code ?? (failed.length ? 1 : 0));
};

/** Open a socket, send one JOIN, resolve with the first JOINED or ERROR. */
function join(code, payload) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}?room=${code}`);
    const timer = setTimeout(() => { ws.close(); reject(new Error('no reply to JOIN')); }, 20_000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'JOIN', room: code, name: 'tester', ...payload })));
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.type === 'JOINED' || m.type === 'ERROR') {
        clearTimeout(timer);
        resolve({ ...m, ws });
      }
    });
    ws.on('error', reject);
  });
}

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up yet */ }
    await sleep(500);
  }
  console.log(`\nKhiana — paid table  ·  ${isMonadTestnet ? 'MONAD TESTNET' : `chain ${CONFIG.CHAIN.CHAIN_ID}`}`);

  // ── Open ────────────────────────────────────────────────────────────────
  step('Open a 4-seat paid table');
  const created = await (await fetch(`${BASE}/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'pot test', players: 4, entryFee: FEE }),
  })).json();
  const code = created.room?.code;
  check('paid table created', created.ok && created.room.entryFee === FEE, `${code}, ${FEE} MON entry`);
  let pot;
  for (let i = 0; i < 60; i++) {
    pot = (await getJson(`/rooms/${code}`)).room.pot;
    if (pot?.status !== 'opening') break;
    await sleep(1000);
  }
  check('pot opened on chain', pot?.status === 'open', pot?.openTx ?? pot?.status);
  if (pot?.status !== 'open') await done(1);

  step('Fund two player wallets');
  for (const p of players) {
    const r = await sendNative(engine, p.account.address, FUND);
    check(`funded ${p.account.address.slice(0, 10)}…`, r.ok, `${FUND} MON`);
  }

  // ── Refusals ────────────────────────────────────────────────────────────
  step('Seats are refused without proof');
  const message = `Join Khiana table ${pot.gameId}`;
  const [A, B] = players;
  const sigA = await A.account.signMessage({ message });
  const unpaid = await join(code, { wallet: A.account.address, signature: sigA });
  unpaid.ws.close();
  check('refused before paying', unpaid.type === 'ERROR', unpaid.error);
  const forged = await join(code, { wallet: B.account.address, signature: sigA });
  forged.ws.close();
  check('refused with someone else\'s signature', forged.type === 'ERROR', forged.error);
  const noWallet = await join(code, {});
  noWallet.ws.close();
  check('refused with no wallet at all', noWallet.type === 'ERROR', noWallet.error);

  // ── Pay and sit ─────────────────────────────────────────────────────────
  step(`Both players pay ${FEE} MON and sit down`);
  const sockets = [];
  for (const p of players) {
    const hash = await p.client.writeContract({
      address: pot.address, abi: POT_ABI, functionName: 'enter', args: [pot.gameId],
      value: parseEther(String(FEE)), gas: 150_000n,
    });
    const receipt = await publicClient().waitForTransactionReceipt({ hash });
    check(`${p.account.address.slice(0, 10)}… paid`, receipt.status === 'success', explorer.tx(hash));
    const seat = await join(code, { wallet: p.account.address, signature: await p.account.signMessage({ message }) });
    check(`${p.account.address.slice(0, 10)}… seated`, seat.type === 'JOINED', seat.playerId ?? seat.error);
    sockets.push(seat.ws);
  }
  const onchain = await publicClient().readContract({
    address: pot.address, abi: POT_ABI, functionName: 'get', args: [pot.gameId],
  });
  check('pot holds both fees', onchain[1] === parseEther(String(FEE * 2)) && onchain[5] === 2n,
    `${formatEther(onchain[1])} MON from ${onchain[5]} entrants`);

  // ── Play ────────────────────────────────────────────────────────────────
  step('Play');
  const before = Object.fromEntries(await Promise.all(players.map(async p =>
    [p.account.address.toLowerCase(), await publicClient().getBalance({ address: p.account.address })])));
  await fetch(`${BASE}/game/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: code }),
  });
  let reveal;
  for (let i = 0; i < 300; i++) {
    const { room } = await getJson(`/rooms/${code}`);
    if (room.winner) {
      reveal = await getJson(`/game/reveal?room=${code}`);
      if (reveal.pot) break;
    }
    await sleep(1000);
  }
  sockets.forEach(ws => ws.close());
  check('game finished and the pot settled', Boolean(reveal?.pot?.txHash), reveal?.pot?.url ?? 'not settled');

  // ── Payout ──────────────────────────────────────────────────────────────
  step('Payout');
  const p = reveal.pot;
  const total = FEE * 2;
  const rakeExpected = total * CONFIG.ECONOMY.BRIBE_FEE_BPS / 10_000;   // same 5% default as RAKE_BPS
  check('rake went to the treasury', p.rake != null && p.rake >= rakeExpected - 1e-12,
    `${p.rake} MON of ${total}`);
  const paidTo = p.refunded ? Object.keys(before) : p.winners;
  for (const addr of Object.keys(before)) {
    const after = await publicClient().getBalance({ address: addr });
    const got = Number(formatEther(after - before[addr]));
    const expect = paidTo.includes(addr) ? p.share : 0;
    check(`${addr.slice(0, 10)}… ${p.refunded ? 'refunded' : paidTo.includes(addr) ? 'won' : 'lost'}`,
      Math.abs(got - expect) < 1e-12, `+${got} MON`);
  }
  console.log(`\n    ${reveal.winner} won · ${p.refunded ? 'no paying player won: entrants refunded less the rake' : `${p.winners.length} paying winner(s)`}`);
  const closed = await publicClient().readContract({
    address: pot.address, abi: POT_ABI, functionName: 'get', args: [pot.gameId],
  });
  check('pot closed', closed[4] === true);

  await done();
} catch (err) {
  console.error('\n' + (err?.stack ?? err));
  await done(1);
}
