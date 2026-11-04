import { parseEther, parseEventLogs, keccak256, toHex } from 'viem';

import { CONFIG } from '../config.js';
import { ESCROW_ABI, SHOP_ABI } from './abi.js';
import { walletFor, sendNative, sendContract, publicClient, explorer } from './wallets.js';
import { openChannel, purchasePowerup, offerBribe } from './x402-client.js';

/**
 * Settlement — Phase 1.
 *
 * Two modes, one interface. MOCK_CHAIN=true books everything in memory with
 * fake hashes; MOCK_CHAIN=false does it for real on Monad testnet. The game
 * engine cannot tell the difference, which is what makes the mock a genuine
 * demo parachute rather than a stub.
 *
 * All sends route through wallets.js, which serialises each agent to one
 * transaction per ~1.5s. That is not throttling for politeness — it is what
 * keeps Monad's reserve-balance rule from reverting every sub-10-MON transfer.
 * Read the comment at the top of wallets.js before changing anything here.
 *
 * Reference: https://docs.monad.xyz/guides/x402
 * Facilitator: https://x402-facilitator.molandak.org  (GET /supported lists schemes)
 *
 * Fallbacks if the primary facilitator misbehaves:
 *   - thirdweb's x402 facilitator (used at the SF x402 Blitz)
 *   - @faremeter/rides   (x402onmonad.com)
 *   - monx402.com
 */

let mockNonce = 0;

/**
 * Escrow TTL. Commitments expire two ticks after acceptance (engine.js:251),
 * so the on-chain lock must outlive that with room to spare — otherwise a
 * bribe the agent DID honour becomes refundable before the engine attests it.
 */
const ESCROW_TTL_SECONDS = Math.ceil((CONFIG.GAME.TICK_MS / 1000) * 4);

/** Contract-call gas. Monad bills the LIMIT, so estimate tight, buffer 10%. */
async function gasFor(wallet, params) {
  try {
    const est = await publicClient().estimateContractGas({ ...params, account: wallet.account });
    return est + est / 10n;
  } catch {
    // Estimation reverting must not inflate the limit — on Monad the sender
    // pays for whatever limit is set. Fall back to a measured constant.
    return 250_000n;
  }
}

/** Resolve a game-side actor ('p1'…'p8' or an agent object) to a wallet. */
function resolve(actor) {
  const id = typeof actor === 'string' ? actor : actor?.id;
  const w = walletFor(id);
  if (!w) throw new Error(`No wallet for '${id}' — is AGENT_MNEMONIC set in .env?`);
  return w;
}

function mockTx() {
  mockNonce++;
  return '0x' + mockNonce.toString(16).padStart(64, '0');
}

/**
 * Contact fee — an agent pays another agent to open a channel.
 *
 * Goes through the full x402 handshake against our own resource server: the
 * payer signs, the engine settles, the recipient is credited. Paying the
 * RECIPIENT rather than burning is what makes the social graph economically
 * visible — an agent holding valuable information earns from being popular.
 */
export async function transfer(from, toPlayerId, amount) {
  if (CONFIG.MOCK_CHAIN) {
    return { ok: true, mocked: true, txHash: mockTx() };
  }
  try {
    const res = await openChannel(from, toPlayerId);
    // A failed contact fee must not kill the tick — the message simply
    // doesn't send and the game continues.
    return res.ok ? res : { ok: false, txHash: null, error: res.error };
  } catch (err) {
    return { ok: false, txHash: null, error: String(err?.shortMessage ?? err) };
  }
}

/**
 * Escrowed conditional bribe: "I pay on delivery."
 *
 * This is the strongest justification for the chain in the whole project.
 * Two agents on opposing teams have no reason to trust each other and no way
 * to build trust inside a 10-minute game. The contract holds the money and
 * releases it when the game engine confirms the target human entered the
 * target zone. No trust needed, none possible.
 */
export async function lockEscrow(from, toPlayerId, amount, condition) {
  if (CONFIG.MOCK_CHAIN) {
    return { ok: true, mocked: true, escrowId: `esc_${mockNonce++}`, txHash: mockTx() };
  }
  if (!CONFIG.CHAIN.ESCROW_ADDRESS) {
    return { ok: false, txHash: null, error: 'ESCROW_ADDRESS unset — deploy first' };
  }

  try {
    // x402 all the way: the payer signs an EIP-3009 authorization naming the
    // ESCROW as payee, so the same handshake that buys a powerup also funds a
    // bribe — except the credits land in custody rather than a wallet, and
    // only move on engine attestation.
    const res = await offerBribe(from, toPlayerId, amount, condition);
    if (!res.ok) return { ok: false, txHash: null, escrowId: null, error: res.error };

    const escrowId = await escrowIdFromTx(res.txHash);
    return { ...res, escrowId };
  } catch (err) {
    return { ok: false, txHash: null, escrowId: null, error: String(err?.shortMessage ?? err) };
  }
}

/** The escrow id is emitted, not returned — a write can't hand back a value. */
async function escrowIdFromTx(txHash) {
  if (!txHash) return null;
  try {
    const receipt = await publicClient().getTransactionReceipt({ hash: txHash });
    const [locked] = parseEventLogs({ abi: ESCROW_ABI, eventName: 'Locked', logs: receipt.logs });
    return locked ? locked.args.id.toString() : null;
  } catch { return null; }
}

/**
 * Engine attests the bribe's condition was met and the money moves to the
 * agent that took it. Only the engine key can call this — see the
 * centralisation caveat documented in KhianaEscrow.sol.
 */
export async function releaseEscrow(escrowId, _engineProof) {
  if (CONFIG.MOCK_CHAIN) {
    return { ok: true, mocked: true, txHash: mockTx() };
  }
  if (escrowId == null) return { ok: false, txHash: null, error: 'no escrowId' };

  const engine = resolve('engine');
  const params = {
    address: CONFIG.CHAIN.ESCROW_ADDRESS,
    abi: ESCROW_ABI,
    functionName: 'release',
    args: [BigInt(escrowId)],
  };

  try {
    const res = await sendContract(engine, { ...params, gas: await gasFor(engine, params) });
    return { ...res, url: explorer.tx(res.txHash) };
  } catch (err) {
    return { ok: false, txHash: null, error: String(err?.shortMessage ?? err) };
  }
}

/** Anyone may refund an expired escrow — a stalled engine can't strand money. */
export async function refundEscrow(escrowId) {
  if (CONFIG.MOCK_CHAIN) return { ok: true, mocked: true, txHash: mockTx() };

  const engine = resolve('engine');
  const params = {
    address: CONFIG.CHAIN.ESCROW_ADDRESS,
    abi: ESCROW_ABI,
    functionName: 'refund',
    args: [BigInt(escrowId)],
  };

  try {
    const res = await sendContract(engine, { ...params, gas: await gasFor(engine, params) });
    return { ...res, url: explorer.tx(res.txHash) };
  } catch (err) {
    return { ok: false, txHash: null, error: String(err?.shortMessage ?? err) };
  }
}

/**
 * Powerup purchase — money leaves the economy permanently.
 *
 * Two settlement paths. If X402_SHOP_URL points at a live x402-gated endpoint
 * we run the full 402 → sign → retry handshake. Otherwise we settle directly
 * against PowerupShop.sol, which burns the MON just the same.
 *
 * The direct path is the default on purpose: it depends only on contracts we
 * deployed ourselves, so a facilitator outage on demo night costs us the x402
 * talking point but not the game.
 */
export async function buyPowerup(agent, type, cost) {
  if (CONFIG.MOCK_CHAIN) {
    return { ok: true, mocked: true, txHash: mockTx(), cost };
  }
  if (!CONFIG.CHAIN.SHOP_ADDRESS) {
    return { ok: false, txHash: null, cost, error: 'SHOP_ADDRESS unset — deploy first' };
  }

  try {
    const res = await purchasePowerup(agent, type, cost);
    return res.ok ? { ...res, cost } : { ok: false, txHash: null, cost, error: res.error };
  } catch (err) {
    return { ok: false, txHash: null, cost, error: String(err?.shortMessage ?? err) };
  }
}

/**
 * Health check for the facilitator.
 *
 * "Responds" is not the useful question — the facilitator serves both Monad
 * mainnet (eip155:143) and testnet (eip155:10143), and a response listing
 * only mainnet schemes would mean the x402 path is unusable for us while
 * looking perfectly healthy. So we assert on our own CAIP-2 network id.
 */
export async function checkFacilitator(chainId = CONFIG.CHAIN.CHAIN_ID) {
  if (CONFIG.MOCK_CHAIN) return { ok: true, mocked: true, schemes: ['mock'] };

  const network = `eip155:${chainId}`;
  try {
    const res = await fetch(`${CONFIG.CHAIN.FACILITATOR}/supported`);
    const data = await res.json();
    const kinds = data?.kinds ?? [];
    const ours = kinds.filter(k => k.network === network);
    return {
      ok: res.ok && ours.length > 0,
      network,
      schemes: ours.map(k => k.scheme),
      signer: data?.signers?.[network]?.[0] ?? null,
      ...(ours.length === 0 && res.ok
        ? { error: `facilitator is up but lists no schemes for ${network}` }
        : {}),
    };
  } catch (err) {
    return { ok: false, network, error: String(err) };
  }
}
