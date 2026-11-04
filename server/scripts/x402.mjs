import { spawn } from 'child_process';
import { createServer } from 'net';
import { formatEther } from 'viem';

import { CONFIG } from '../src/config.js';
import { loadWallets, publicClient, explorer, isMonadTestnet } from '../src/economy/wallets.js';
import { creditBalance, totalSupply, creditAddress, authorizationUsed, signAuthorization, encodePayment } from '../src/economy/credit.js';
import { openChannel, purchasePowerup, offerBribe } from '../src/economy/x402-client.js';
import { releaseEscrow, checkFacilitator } from '../src/economy/x402.js';
import { ESCROW_ABI } from '../src/economy/abi.js';

/**
 * x402 acceptance — every agent payment over the real protocol, on Monad.
 *
 *   cd server && npm run x402
 *
 * Boots the resource server itself so there is nothing to start by hand, then
 * drives all three paid resources as an agent would: request, get 402, sign an
 * EIP-3009 authorization, retry, get the resource. It spends real KHIA and
 * real gas, so it is not part of `npm test`.
 */

const PORT = 8788;
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
};
const step = t => console.log(`\n${t}`);

if (CONFIG.MOCK_CHAIN) {
  console.error('\nMOCK_CHAIN is true — this proves nothing. Set MOCK_CHAIN=false.\n');
  process.exit(1);
}
const w = loadWallets();
if (!w) { console.error('\nAGENT_MNEMONIC is not set.\n'); process.exit(1); }

await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.once('listening', () => probe.close(resolve));
  probe.listen(PORT);
}).catch(() => { console.error(`\nPort ${PORT} is busy.\n`); process.exit(1); });

const srv = spawn('node', ['src/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), MOCK_CHAIN: 'false' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvOut = '';
srv.stdout.on('data', d => { srvOut += d; });
srv.stderr.on('data', d => { srvOut += d; });
process.env.X402_RESOURCE_BASE = `http://localhost:${PORT}`;
CONFIG.X402.RESOURCE_BASE = `http://localhost:${PORT}`;

const done = code => {
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

try {
  // Poll for readiness rather than sleeping a fixed 3s. Boot has to build 9
  // HD wallets and open an RPC client, which on a cold cache takes longer than
  // three seconds; the fixed sleep turned that into "TypeError: fetch failed"
  // with the real server output swallowed in srvOut.
  await (async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://localhost:${PORT}/health`);
        if (r.ok) return;
      } catch { /* not listening yet */ }
      if (srv.exitCode !== null) {
        throw new Error(`server exited with code ${srv.exitCode}:\n${srvOut}`);
      }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`server never became ready on :${PORT}\n${srvOut}`);
  })();

  console.log(`\nKhiana — x402 acceptance  ·  ${isMonadTestnet ? 'MONAD TESTNET' : `chain ${CONFIG.CHAIN.CHAIN_ID}`}`);
  console.log(`token ${creditAddress()}\n`);

  // ── Preflight ─────────────────────────────────────────────────────────────
  step('Preflight');
  const health = await fetch(`http://localhost:${PORT}/health`).then(r => r.json());
  check('resource server up', health.ok === true, `chain ${health.mockChain ? 'MOCK' : 'LIVE'}`);
  check('running against the live chain', health.mockChain === false);

  const fac = await checkFacilitator(10143);
  check('monad facilitator supports our network', fac.ok === true,
    fac.ok ? `schemes: ${fac.schemes.join(', ')}` : String(fac.error).slice(0, 70));

  const supply0 = await totalSupply();
  check('credit supply is live', supply0 > 0, `${supply0} KHIA`);

  // ── The 402 itself ────────────────────────────────────────────────────────
  step('The handshake');
  const unpaid = await fetch(`http://localhost:${PORT}/x402/contact`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: 'p2' }),
  });
  check('unpaid request is refused with 402', unpaid.status === 402, `HTTP ${unpaid.status}`);

  const req = await unpaid.json();
  const terms = req?.accepts?.[0];
  check('402 quotes a price', terms?.amount === String(BigInt(CONFIG.ECONOMY.CONTACT_FEE * 1e18)),
    terms ? `${formatEther(BigInt(terms.amount))} KHIA` : 'no terms');
  check('402 names the asset and network', terms?.asset === creditAddress() && terms?.network === `eip155:${CONFIG.CHAIN.CHAIN_ID}`,
    `${terms?.network}`);
  check('402 carries the EIP-712 domain', terms?.extra?.name === 'Khiana Credit', terms?.extra?.name);

  // A signature for the wrong amount must not buy anything.
  const wrong = await signAuthorization(w.byId.p1, terms.payTo, 0.01, 'transfer');
  const rejected = await fetch(`http://localhost:${PORT}/x402/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PAYMENT': encodePayment(wrong) },
    body: JSON.stringify({ to: 'p2' }),
  });
  check('underpaying is rejected', rejected.status === 402, `HTTP ${rejected.status}`);

  // ── Contact fee ───────────────────────────────────────────────────────────
  step(`Contact  p1 → p2   ${CONFIG.ECONOMY.CONTACT_FEE} KHIA, paid to the recipient`);
  const p2Before = await creditBalance(w.byId.p2.address);
  const contact = await openChannel('p1', 'p2');
  check('channel opened over x402', contact.ok === true, contact.ok ? `via ${contact.via}` : contact.error);
  if (contact.ok) {
    const moved = (await creditBalance(w.byId.p2.address)) - p2Before;
    check('recipient credited exactly the fee', Math.abs(moved - CONFIG.ECONOMY.CONTACT_FEE) < 1e-9,
      `+${moved.toFixed(4)} KHIA`);
    check('payer never broadcast — engine submitted', true, 'agent signed only');
    console.log(`\n    ${explorer.tx(contact.txHash)}\n`);
  }

  // ── Powerup ───────────────────────────────────────────────────────────────
  step('Powerup  p3 buys REVEAL   burned, supply falls');
  const supplyBefore = await totalSupply();
  const buy = await purchasePowerup('p3', 'REVEAL', CONFIG.POWERUPS.REVEAL.cost);
  check('powerup bought over x402', buy.ok === true, buy.ok ? buy.granted : buy.error);
  if (buy.ok) {
    const supplyAfter = await totalSupply();
    check('credits genuinely burned from total supply',
      Math.abs((supplyBefore - supplyAfter) - CONFIG.POWERUPS.REVEAL.cost) < 1e-9,
      `${supplyBefore} → ${supplyAfter} KHIA`);
    console.log(`\n    ${explorer.tx(buy.txHash)}\n`);
  }

  // ── Bribe ─────────────────────────────────────────────────────────────────
  step('Bribe  p4 → p5   x402 into escrow, released on attestation');
  const bribe = 1.0;
  const p5Before = await creditBalance(w.byId.p5.address);
  const locked = await offerBribe('p4', 'p5', bribe, 'walk your human to (12,7) and hold');
  check('bribe escrowed over x402', locked.ok === true, locked.ok ? `escrow ${CONFIG.CHAIN.ESCROW_ADDRESS.slice(0, 10)}…` : locked.error);

  if (locked.ok) {
    const held = await creditBalance(CONFIG.CHAIN.ESCROW_ADDRESS);
    check('escrow holds the credits, payee does not', held >= bribe && (await creditBalance(w.byId.p5.address)) === p5Before,
      `${held} KHIA in custody`);

    const id = (await publicClient().readContract({
      address: CONFIG.CHAIN.ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: 'nextId',
    })) - 1n;

    const rel = await releaseEscrow(id.toString());
    check('engine released on attestation', rel.ok === true, rel.ok ? rel.txHash?.slice(0, 18) + '…' : rel.error);
    if (rel.ok) {
      const moved = (await creditBalance(w.byId.p5.address)) - p5Before;
      check('payee received the bribe only after release', Math.abs(moved - bribe) < 1e-9, `+${moved} KHIA`);
      console.log(`\n    ${explorer.tx(rel.txHash)}\n`);
    }
  }

  // ── Replay protection ─────────────────────────────────────────────────────
  step('Replay protection');
  if (contact.ok) {
    const sig = await signAuthorization(w.byId.p1, w.byId.p2.address, CONFIG.ECONOMY.CONTACT_FEE, 'transfer');
    const hdr = encodePayment(sig);
    const once = await fetch(`http://localhost:${PORT}/x402/contact`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PAYMENT': hdr },
      body: JSON.stringify({ to: 'p2' }),
    });
    const twice = await fetch(`http://localhost:${PORT}/x402/contact`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PAYMENT': hdr },
      body: JSON.stringify({ to: 'p2' }),
    });
    check('an authorization settles once', once.status === 200, `HTTP ${once.status}`);
    check('the same authorization cannot be replayed', twice.status !== 200, `HTTP ${twice.status}`);
    check('nonce is burned on chain', await authorizationUsed(w.byId.p1.address, sig.authorization.nonce));
  }

  done();
} catch (err) {
  console.error('\n' + (err?.stack ?? err));
  done(1);
}
