import { parseEther } from 'viem';

import { CONFIG } from '../config.js';
import { walletFor, sendContract, publicClient, explorer, chain } from './wallets.js';
import { CREDIT_ABI, creditAddress, decodePayment, conditionHash } from './credit.js';
import { ESCROW_ABI, SHOP_ABI } from './abi.js';

/**
 * The x402 resource server.
 *
 * Three paid resources, one protocol. An agent asks for something, gets a 402
 * describing what it costs and to whom, signs an EIP-3009 authorization, and
 * asks again with the signature attached. We verify it, settle it on Monad,
 * and only then hand over the resource.
 *
 *   POST /x402/contact   0.25 KHIA, paid TO the recipient → opens a channel
 *   POST /x402/powerup   price from the catalogue, BURNED → grants the effect
 *   POST /x402/bribe     negotiated, into escrow → conditional, released on
 *                        engine attestation
 *
 * ── Why we settle the escrow leg ourselves ────────────────────────────────
 *
 * The public Monad facilitator settles `exact` by calling
 * transferWithAuthorization on the token: credits land in the payee's wallet,
 * immediately and unconditionally. A bribe must NOT do that — it has to sit in
 * escrow until the engine attests delivery. So for bribes the engine submits
 * escrow.lockWithAuthorization, which pulls the same signed authorization but
 * routes it into custody. Same signature, same protocol, correct semantics.
 *
 * The agent still never broadcasts and never pays gas, which is the property
 * x402 actually exists to provide.
 */

const PRICES = {
  contact: () => CONFIG.ECONOMY.CONTACT_FEE,
  powerup: type => CONFIG.POWERUPS[type]?.cost,
};

/** RFC-shaped 402 body describing what this resource costs. */
function paymentRequirements({ resource, description, amount, payTo }) {
  return {
    x402Version: 2,
    accepts: [{
      scheme: 'exact',
      network: `eip155:${chain.id}`,
      asset: creditAddress(),
      amount: parseEther(String(amount)).toString(),
      payTo,
      maxTimeoutSeconds: CONFIG.X402.AUTHORIZATION_TTL_SECONDS,
      resource,
      description,
      // The client needs these to build the EIP-712 domain. Sending them
      // rather than assuming the client hardcodes them is what lets the token
      // be redeployed without shipping a new client.
      extra: { name: 'Khiana Credit', version: '1' },
    }],
  };
}

/** Reject anything whose signed terms don't match what we quoted. */
function validate(payment, { amount, payTo }) {
  const a = payment?.payload?.authorization;
  if (!a) return 'malformed payment payload';
  if (a.to?.toLowerCase() !== payTo.toLowerCase()) return `authorization pays ${a.to}, expected ${payTo}`;
  if (a.value !== parseEther(String(amount))) return `authorization is for ${a.value}, expected ${parseEther(String(amount))}`;
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (a.validBefore <= now) return 'authorization expired';
  return null;
}

/**
 * Settle a plain agent-to-agent payment: contact fees.
 * The engine broadcasts; the payer signed and did nothing else.
 */
async function settleTransfer(payment) {
  const engine = walletFor('engine');
  const a = payment.payload.authorization;
  const fn = payment.payload.primaryType === 'TransferWithAuthorization'
    ? 'transferWithAuthorization'
    : 'receiveWithAuthorization';

  // receiveWithAuthorization requires msg.sender == payee, so a contact fee
  // paid to another agent has to be signed as a plain transfer.
  if (fn === 'receiveWithAuthorization') {
    return { ok: false, error: 'contact fees must be signed as TransferWithAuthorization' };
  }

  return sendContract(engine, {
    address: creditAddress(),
    abi: CREDIT_ABI,
    functionName: fn,
    args: [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, payment.payload.signature],
    gas: 200_000n,
  });
}

/** Settle a powerup purchase: pull the authorization into the shop and burn. */
async function settlePowerup(payment, { type, tick }) {
  const engine = walletFor('engine');
  const a = payment.payload.authorization;
  return sendContract(engine, {
    address: CONFIG.CHAIN.SHOP_ADDRESS,
    abi: SHOP_ABI,
    functionName: 'buyWithAuthorization',
    args: [a.from, a.value, a.validAfter, a.validBefore, a.nonce, payment.payload.signature, type, BigInt(tick ?? 0)],
    gas: 300_000n,
  });
}

/** Settle a bribe: pull the authorization into escrow, conditional on delivery. */
async function settleBribe(payment, { payee, instruction, ttlSeconds }) {
  const engine = walletFor('engine');
  const a = payment.payload.authorization;
  return sendContract(engine, {
    address: CONFIG.CHAIN.ESCROW_ADDRESS,
    abi: ESCROW_ABI,
    functionName: 'lockWithAuthorization',
    args: [
      a.from, payee, a.value, a.validAfter, a.validBefore, a.nonce,
      payment.payload.signature, conditionHash(instruction), BigInt(ttlSeconds),
    ],
    gas: 400_000n,
  });
}

/**
 * Mount the paid endpoints on an Express app.
 *
 * Each handler is the same three steps: price it, 402 if unpaid, settle and
 * serve if paid. The differences are only in who gets the money and what
 * "serving the resource" means.
 */
export function mountX402(app, getGame) {
  const base = CONFIG.X402.RESOURCE_BASE || `http://localhost:${CONFIG.PORT}`;

  /** Shared 402 / settle wrapper. */
  const paid = (name, price, payTo, settle, serve) => async (req, res) => {
    if (CONFIG.MOCK_CHAIN) {
      return res.json({ ok: true, mocked: true, ...serve(req, null) });
    }
    const resource = `${base}/x402/${name}`;
    let amount, destination;
    try {
      amount = price(req);
      destination = payTo(req);
    } catch (err) {
      return res.status(400).json({ error: String(err.message ?? err) });
    }
    if (!(amount > 0) || !destination) {
      return res.status(400).json({ error: 'unpriceable request' });
    }

    const header = req.get('X-PAYMENT');
    if (!header) {
      // The handshake begins. Everything the client needs to sign is here.
      return res.status(402).json(paymentRequirements({
        resource, description: `Khiana ${name}`, amount, payTo: destination,
      }));
    }

    let payment;
    try { payment = decodePayment(header); }
    catch { return res.status(400).json({ error: 'undecodable X-PAYMENT header' }); }

    const bad = validate(payment, { amount, payTo: destination });
    if (bad) return res.status(402).json({ error: bad, ...paymentRequirements({ resource, description: name, amount, payTo: destination }) });

    let settled;
    try { settled = await settle(payment, req); }
    catch (err) { settled = { ok: false, error: String(err?.shortMessage ?? err) }; }

    if (!settled?.ok) {
      return res.status(402).json({ error: settled?.error ?? 'settlement failed' });
    }

    // Proof of payment travels back with the resource, per x402.
    res.set('X-PAYMENT-RESPONSE', Buffer.from(JSON.stringify({
      success: true, txHash: settled.txHash, network: `eip155:${chain.id}`,
    })).toString('base64'));

    res.json({ ok: true, txHash: settled.txHash, url: explorer.tx(settled.txHash), ...serve(req, settled) });
  };

  // ── Contact: pay the recipient to open a channel ──────────────────────────
  app.post('/x402/contact', paid(
    'contact',
    () => PRICES.contact(),
    req => {
      const w = walletFor(req.body?.to);
      if (!w) throw new Error(`unknown recipient '${req.body?.to}'`);
      return w.address;
    },
    settleTransfer,
    req => ({ channelOpen: true, to: req.body?.to })
  ));

  // ── Powerup: burn credits, receive the effect ─────────────────────────────
  app.post('/x402/powerup', paid(
    'powerup',
    req => {
      const cost = PRICES.powerup(req.body?.type);
      if (cost == null) throw new Error(`unknown powerup '${req.body?.type}'`);
      return req.body?.type === 'BOUNTY' ? Math.max(req.body?.amount ?? cost, cost) : cost;
    },
    () => CONFIG.CHAIN.SHOP_ADDRESS,
    (payment, req) => settlePowerup(payment, { type: req.body?.type, tick: getGame()?.tick }),
    req => ({ granted: req.body?.type })
  ));

  // ── Bribe: into escrow, released only on engine attestation ───────────────
  app.post('/x402/bribe', paid(
    'bribe',
    req => Math.max(CONFIG.ECONOMY.MIN_BRIBE, Number(req.body?.amount) || 0),
    () => CONFIG.CHAIN.ESCROW_ADDRESS,
    (payment, req) => {
      const w = walletFor(req.body?.to);
      if (!w) throw new Error(`unknown payee '${req.body?.to}'`);
      return settleBribe(payment, {
        payee: w.address,
        instruction: req.body?.instruction,
        ttlSeconds: Math.ceil((CONFIG.GAME.TICK_MS / 1000) * 4),
      });
    },
    req => ({ escrowed: true, to: req.body?.to, instruction: req.body?.instruction })
  ));
}
