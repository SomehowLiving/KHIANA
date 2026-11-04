/**
 * Minimal hand-written ABIs for the three Khiana contracts.
 *
 * Deliberately not imported from hardhat's artifacts/ directory: the server
 * must boot without contracts/ ever having been compiled, and a build-order
 * dependency between two packages is exactly the thing that breaks at 2am on
 * demo night. These are small enough to keep honest by eye.
 *
 * If you change a signature in contracts/, change it here too.
 */

export const ESCROW_ABI = [
  {
    // The x402 path: pulls a signed EIP-3009 authorization into escrow and
    // records the bribe atomically. Submitted by the engine, signed by the payer.
    type: 'function',
    name: 'lockWithAuthorization',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'payer', type: 'address' },
      { name: 'payee', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
      { name: 'condition', type: 'bytes32' },
      { name: 'ttlSeconds', type: 'uint64' },
    ],
    outputs: [{ name: 'id', type: 'uint256' }],
  },
  {
    // Allowance fallback for MOCK runs and facilitator outages.
    type: 'function',
    name: 'lock',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'payee', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'condition', type: 'bytes32' },
      { name: 'ttlSeconds', type: 'uint64' },
    ],
    outputs: [{ name: 'id', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'token',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'release',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'refund',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'nextId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'get',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'payer', type: 'address' },
          { name: 'payee', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'condition', type: 'bytes32' },
          { name: 'expiresAt', type: 'uint64' },
          { name: 'status', type: 'uint8' },
        ],
      },
    ],
  },
  {
    type: 'event',
    name: 'Locked',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'payer', type: 'address', indexed: true },
      { name: 'payee', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'condition', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Released',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'payee', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Refunded',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'payer', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
];

export const SHOP_ABI = [
  {
    type: 'function',
    name: 'buyWithAuthorization',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'buyer', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
      { name: 'powerup', type: 'string' },
      { name: 'gameTick', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'buy',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'powerup', type: 'string' },
      { name: 'value', type: 'uint256' },
      { name: 'gameTick', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'totalBurned',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'purchaseCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'PowerupPurchased',
    inputs: [
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'powerup', type: 'string', indexed: false },
      { name: 'cost', type: 'uint256', indexed: false },
      { name: 'gameTick', type: 'uint64', indexed: false },
    ],
  },
];

export const COMMIT_ABI = [
  {
    type: 'function',
    name: 'commit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'gameId', type: 'bytes32' },
      { name: 'commitment', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'reveal',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'gameId', type: 'bytes32' },
      { name: 'roles', type: 'string' },
      { name: 'salt', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'games',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [
      { name: 'commitment', type: 'bytes32' },
      { name: 'committedAt', type: 'uint64' },
      { name: 'revealed', type: 'bool' },
      { name: 'roles', type: 'string' },
    ],
  },
];
