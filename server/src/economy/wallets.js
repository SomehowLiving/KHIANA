import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
} from 'viem';
import { mnemonicToAccount, generateMnemonic, english } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';

import { CONFIG } from '../config.js';

/**
 * Agent wallet layer — Phase 1.
 *
 * Nine accounts derived from ONE mnemonic on the standard BIP-44 path:
 *
 *   index 0  → engine   (deployer, escrow attestor, shop owner)
 *   index 1..8 → the eight agents, aligned to player ids p1..p8
 *
 * One secret in .env instead of nine. Addresses are deterministic, so the
 * same mnemonic always produces the same eight agents — which means a funded
 * set survives a server restart, and the demo can be re-run without
 * re-funding anything.
 *
 * ── The Monad constraint that shapes this whole file ──────────────────────
 *
 * Reserve balance: a transaction reverts if the sender's ending balance drops
 * below min(starting_balance, 10 MON). Agents start with 5 MON, so their
 * floor is 5 MON and *every* bribe would revert — except for the "emptying
 * transaction" exception, which lets an undelegated EOA spend below its
 * reserve provided it sent no other transaction in the previous 3 blocks
 * (~1.2s).
 *
 * So every agent send is serialised behind a per-wallet gate with a 1.5s
 * minimum gap. At a 15-second tick this costs us nothing and is the
 * difference between the economy working and every transfer reverting.
 *
 * See: https://docs.monad.xyz/developer-essentials/reserve-balance
 */

const RESERVE_GAP_MS = 1_500;      // > 3 blocks (~1.2s). Safety margin included.
const NATIVE_TRANSFER_GAS = 21_000n; // Monad charges on the LIMIT — never estimate this.

export const AGENT_COUNT = CONFIG.GAME.PLAYERS;

// ── Chain clients ───────────────────────────────────────────────────────────

/**
 * viem ships monadTestnet (chain id 10143), which is what we run on. The
 * CHAIN_ID escape hatch exists purely so the settlement layer can be dry-run
 * end-to-end against a local hardhat node before anyone touches a faucet —
 * see `npm run phase1:local`.
 */
export const chain = CONFIG.CHAIN.CHAIN_ID === monadTestnet.id
  ? monadTestnet
  : {
      id: CONFIG.CHAIN.CHAIN_ID,
      name: `local-${CONFIG.CHAIN.CHAIN_ID}`,
      nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
      rpcUrls: { default: { http: [CONFIG.CHAIN.RPC_URL] } },
    };

export const isMonadTestnet = CONFIG.CHAIN.CHAIN_ID === monadTestnet.id;

let _public = null;
export function publicClient() {
  if (!_public) {
    _public = createPublicClient({
      chain,
      transport: http(CONFIG.CHAIN.RPC_URL),
    });
  }
  return _public;
}

// ── Key derivation ──────────────────────────────────────────────────────────

let _wallets = null;

/**
 * Derive the engine account and the eight agent accounts.
 * Returns null when no mnemonic is configured — callers must treat that as
 * "chain unavailable" rather than crashing, so MOCK_CHAIN stays viable.
 */
export function loadWallets() {
  if (_wallets !== null) return _wallets;

  const mnemonic = process.env.AGENT_MNEMONIC?.trim();
  if (!mnemonic) {
    _wallets = false;
    return null;
  }

  const engineAccount = mnemonicToAccount(mnemonic, { addressIndex: 0 });
  const engine = {
    id: 'engine',
    index: 0,
    account: engineAccount,
    address: engineAccount.address,
    client: createWalletClient({ account: engineAccount, chain, transport: http(CONFIG.CHAIN.RPC_URL) }),
    lastSentAt: 0,
    queue: Promise.resolve(),
  };

  const agents = [];
  for (let i = 1; i <= AGENT_COUNT; i++) {
    const account = mnemonicToAccount(mnemonic, { addressIndex: i });
    agents.push({
      id: `p${i}`,            // aligned to engine.js player ids
      index: i,
      account,
      address: account.address,
      client: createWalletClient({ account, chain, transport: http(CONFIG.CHAIN.RPC_URL) }),
      lastSentAt: 0,
      queue: Promise.resolve(),
    });
  }

  _wallets = { engine, agents, byId: Object.fromEntries(agents.map(a => [a.id, a])) };
  return _wallets;
}

/** Look up an agent wallet by player id ('p1'…'p8'), or the engine. */
export function walletFor(playerId) {
  const w = loadWallets();
  if (!w) return null;
  if (playerId === 'engine') return w.engine;
  return w.byId[playerId] ?? null;
}

/** Generate a fresh 12-word mnemonic. Used by `npm run wallets:new`. */
export function newMnemonic() {
  return generateMnemonic(english);
}

// ── The reserve-balance gate ────────────────────────────────────────────────

/**
 * Serialise sends per wallet and hold each one at least RESERVE_GAP_MS after
 * the previous, so the emptying-transaction exception always applies.
 *
 * Per wallet, not global: eight agents transacting simultaneously is fine —
 * the 3-block rule is scoped to a single sender.
 */
function gated(wallet, fn) {
  const run = wallet.queue.then(async () => {
    const wait = RESERVE_GAP_MS - (Date.now() - wallet.lastSentAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      wallet.lastSentAt = Date.now();
    }
  });
  // Keep the chain alive even when a send rejects, or one failure wedges the
  // wallet for the rest of the game.
  wallet.queue = run.then(() => {}, () => {});
  return run;
}

// ── Sends ───────────────────────────────────────────────────────────────────

/**
 * Native MON transfer. Used for contact fees (0.25) and direct bribes.
 *
 * Gas limit is hardcoded to 21,000 rather than estimated: on Monad the sender
 * pays gas_limit * price, not gas_used * price, so an inflated estimate is a
 * real cost. A native transfer is always exactly 21,000.
 */
export async function sendNative(fromWallet, toAddress, amountMon) {
  return gated(fromWallet, async () => {
    const hash = await fromWallet.client.sendTransaction({
      to: toAddress,
      value: parseEther(String(amountMon)),
      gas: NATIVE_TRANSFER_GAS,
    });
    const receipt = await publicClient().waitForTransactionReceipt({ hash });
    return { ok: receipt.status === 'success', txHash: hash, receipt };
  });
}

/**
 * Contract write behind the same gate.
 * `gas` must be supplied by the caller — see the note above on gas limits.
 */
export async function sendContract(fromWallet, { address, abi, functionName, args, value, gas }) {
  return gated(fromWallet, async () => {
    const hash = await fromWallet.client.writeContract({
      address,
      abi,
      functionName,
      args,
      ...(value !== undefined ? { value } : {}),
      ...(gas !== undefined ? { gas } : {}),
    });
    const receipt = await publicClient().waitForTransactionReceipt({ hash });
    return { ok: receipt.status === 'success', txHash: hash, receipt };
  });
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function balanceOf(address) {
  const wei = await publicClient().getBalance({ address });
  return Number(formatEther(wei));
}

/** Balances for the engine plus all eight agents, in one pass. */
export async function allBalances() {
  const w = loadWallets();
  if (!w) return null;
  const list = [w.engine, ...w.agents];
  const balances = await Promise.all(list.map(x => balanceOf(x.address)));
  return list.map((x, i) => ({ id: x.id, address: x.address, balance: balances[i] }));
}

/** Does this address have contract code deployed? Used by the preflight. */
export async function hasCode(address) {
  if (!address) return false;
  const code = await publicClient().getCode({ address });
  return !!code && code !== '0x';
}

/**
 * Explorer links. On a local dry run there is no explorer, and emitting a
 * testnet.monadscan.com URL for a hash that only exists on 127.0.0.1 is how
 * you end up pasting a dead link into a demo.
 */
export const explorer = {
  tx: hash => isMonadTestnet
    ? `https://testnet.monadscan.com/tx/${hash}`
    : `(local chain ${CONFIG.CHAIN.CHAIN_ID}) ${hash}`,
  address: addr => isMonadTestnet
    ? `https://testnet.monadscan.com/address/${addr}`
    : `(local chain ${CONFIG.CHAIN.CHAIN_ID}) ${addr}`,
};

export const constants = { RESERVE_GAP_MS, NATIVE_TRANSFER_GAS };
