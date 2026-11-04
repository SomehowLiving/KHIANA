import { parseEther, formatEther, erc20Abi, keccak256, toHex } from 'viem';
import { randomBytes } from 'crypto';

import { CONFIG } from '../config.js';
import { publicClient, chain, walletFor } from './wallets.js';

/**
 * KhianaCredit (KHIA) client — balances and EIP-3009 authorization signing.
 *
 * This is the piece that makes x402 real. An agent signs an authorization
 * off-chain; somebody else broadcasts it and pays the gas. The agent never
 * sends a transaction, which is exactly what x402 requires and exactly what
 * native MON could not do.
 *
 * We sign ReceiveWithAuthorization rather than TransferWithAuthorization
 * throughout. A plain transfer authorization is broadcastable by anyone who
 * observes it; binding the submitter to the named payee means a third party
 * cannot pick the moment somebody's bribe lands.
 */

export const CREDIT_ABI = [
  ...erc20Abi,
  {
    type: 'function', name: 'receiveWithAuthorization', stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function', name: 'transferWithAuthorization', stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function', name: 'authorizationState', stateMutability: 'view',
    inputs: [{ name: 'authorizer', type: 'address' }, { name: 'nonce', type: 'bytes32' }],
    outputs: [{ type: 'bool' }],
  },
  { type: 'function', name: 'burn', stateMutability: 'nonpayable', inputs: [{ name: 'value', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'DOMAIN_SEPARATOR', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
];

/**
 * EIP-712 types. These strings must match KhianaCredit.sol byte for byte —
 * a mismatch produces a valid-looking signature that every verifier rejects
 * with nothing in the error to say why.
 */
const AUTHORIZATION_FIELDS = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
];

export const TOKEN_NAME = 'Khiana Credit';
export const TOKEN_VERSION = '1';

export function creditAddress() {
  return CONFIG.CHAIN.CREDIT_ADDRESS;
}

function domain() {
  const address = creditAddress();
  if (!address) throw new Error('CREDIT_ADDRESS unset — deploy KhianaCredit first');
  return { name: TOKEN_NAME, version: TOKEN_VERSION, chainId: chain.id, verifyingContract: address };
}

/** A fresh 32-byte nonce. Random, not sequential, so an agent can have several
 *  authorizations in flight inside one tick without invalidating each other. */
export function newNonce() {
  return `0x${randomBytes(32).toString('hex')}`;
}

/**
 * Sign an EIP-3009 authorization.
 *
 * @param {object} wallet   an agent wallet from wallets.js
 * @param {string} payee    address that will receive (and must submit)
 * @param {number} amount   KHIA, human units
 * @param {string} kind     'receive' (default, front-run safe) or 'transfer'
 */
export async function signAuthorization(wallet, payee, amount, kind = 'receive') {
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: wallet.address,
    to: payee,
    value: parseEther(String(amount)),
    // validAfter is exclusive in the contract (`block.timestamp <= validAfter`
    // reverts), so 0 rather than `now` — a same-second submission is normal at
    // a 15-second tick and must not be rejected as "not yet valid".
    validAfter: 0n,
    validBefore: BigInt(now + CONFIG.X402.AUTHORIZATION_TTL_SECONDS),
    nonce: newNonce(),
  };

  const primaryType = kind === 'transfer' ? 'TransferWithAuthorization' : 'ReceiveWithAuthorization';
  const signature = await wallet.account.signTypedData({
    domain: domain(),
    types: { [primaryType]: AUTHORIZATION_FIELDS },
    primaryType,
    message: authorization,
  });

  return { authorization, signature, primaryType };
}

/** Serialise an authorization for transport in the X-PAYMENT header. */
export function encodePayment({ authorization, signature, primaryType }) {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    scheme: 'exact',
    network: `eip155:${chain.id}`,
    payload: {
      signature,
      primaryType,
      authorization: {
        ...authorization,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
      },
    },
  })).toString('base64');
}

export function decodePayment(header) {
  const parsed = JSON.parse(Buffer.from(header, 'base64').toString());
  const a = parsed.payload.authorization;
  return {
    ...parsed,
    payload: {
      ...parsed.payload,
      authorization: {
        ...a,
        value: BigInt(a.value),
        validAfter: BigInt(a.validAfter),
        validBefore: BigInt(a.validBefore),
      },
    },
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function creditBalance(address) {
  const raw = await publicClient().readContract({
    address: creditAddress(), abi: CREDIT_ABI, functionName: 'balanceOf', args: [address],
  });
  return Number(formatEther(raw));
}

export async function totalSupply() {
  const raw = await publicClient().readContract({
    address: creditAddress(), abi: CREDIT_ABI, functionName: 'totalSupply',
  });
  return Number(formatEther(raw));
}

export async function authorizationUsed(authorizer, nonce) {
  return publicClient().readContract({
    address: creditAddress(), abi: CREDIT_ABI, functionName: 'authorizationState',
    args: [authorizer, nonce],
  });
}

/** Credit balances for the engine and all eight agents. */
export async function allCreditBalances() {
  const ids = ['engine', ...Array.from({ length: CONFIG.GAME.PLAYERS }, (_, i) => `p${i + 1}`)];
  const wallets = ids.map(id => walletFor(id)).filter(Boolean);
  const balances = await Promise.all(wallets.map(w => creditBalance(w.address)));
  return wallets.map((w, i) => ({ id: w.id, address: w.address, credit: balances[i] }));
}

/** Hash an instruction into the escrow's on-chain condition commitment. */
export function conditionHash(instruction) {
  return keccak256(toHex(instruction ?? ''));
}
