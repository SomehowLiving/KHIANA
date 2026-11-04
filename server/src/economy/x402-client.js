import { formatEther } from 'viem';

import { CONFIG } from '../config.js';
import { walletFor, explorer } from './wallets.js';
import { signAuthorization, encodePayment } from './credit.js';

/**
 * The agent side of x402.
 *
 * One function does the whole handshake, because the handshake is the same
 * for every paid resource:
 *
 *   1. POST the request with no payment
 *   2. get 402 back with the price, the payee, and the EIP-712 domain
 *   3. sign an authorization for exactly those terms
 *   4. POST again with X-PAYMENT
 *   5. server settles on Monad and serves the resource
 *
 * Step 3 signs what the SERVER quoted rather than what the caller intended.
 * That sounds backwards but it's the point: the agent commits to terms it has
 * been shown, and the server rejects any authorization that doesn't match what
 * it asked for, so neither side can quietly substitute a different amount or
 * payee. It also means a price change needs no client deploy.
 */

function resourceBase() {
  return CONFIG.X402.RESOURCE_BASE || `http://localhost:${CONFIG.PORT}`;
}

/**
 * @param {string} resource  'contact' | 'powerup' | 'bribe'
 * @param {object} payer     agent id ('p1') or an agent object
 * @param {object} body      resource-specific arguments
 */
export async function payFor(resource, payer, body) {
  const id = typeof payer === 'string' ? payer : payer?.id;
  const wallet = walletFor(id);
  if (!wallet) return { ok: false, error: `no wallet for '${id}'` };

  const url = `${resourceBase()}/x402/${resource}`;
  const headers = { 'Content-Type': 'application/json' };

  const first = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });

  if (first.status !== 402) {
    // Either it was free (mock mode) or it failed outright.
    const data = await first.json().catch(() => null);
    return first.ok
      ? { ok: true, ...data }
      : { ok: false, error: data?.error ?? `HTTP ${first.status}` };
  }

  const requirements = await first.json().catch(() => null);
  const terms = requirements?.accepts?.[0];
  if (!terms) return { ok: false, error: '402 with no payment requirements' };

  const amount = Number(formatEther(BigInt(terms.amount)));

  // Contact fees pay another agent's wallet, which cannot submit its own
  // settlement, so they're signed as a plain transfer. Everything else pays a
  // contract that submits on its own behalf — those use the front-run-safe
  // receive variant.
  const kind = resource === 'contact' ? 'transfer' : 'receive';

  let signed;
  try {
    signed = await signAuthorization(wallet, terms.payTo, amount, kind);
  } catch (err) {
    return { ok: false, error: `signing failed: ${err.message ?? err}` };
  }

  const retry = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'X-PAYMENT': encodePayment(signed) },
    body: JSON.stringify(body),
  });

  const data = await retry.json().catch(() => null);
  if (!retry.ok) return { ok: false, error: data?.error ?? `HTTP ${retry.status}`, amount };

  // The settlement proof the server attached.
  let txHash = data?.txHash ?? null;
  const proof = retry.headers.get('X-PAYMENT-RESPONSE');
  if (!txHash && proof) {
    try { txHash = JSON.parse(Buffer.from(proof, 'base64').toString()).txHash; } catch { /* shape varies */ }
  }

  return { ok: true, ...data, txHash, amount, url: txHash ? explorer.tx(txHash) : null, via: 'x402' };
}

export const openChannel = (payer, to) => payFor('contact', payer, { to });
export const purchasePowerup = (payer, type, amount) => payFor('powerup', payer, { type, amount });
export const offerBribe = (payer, to, amount, instruction) =>
  payFor('bribe', payer, { to, amount, instruction });
