/**
 * Connect Wallet for paid tables, using the browser wallet directly
 * (window.ethereum: MetaMask, Rabby, Phantom EVM, …). No library: the whole
 * job is four RPC calls.
 *
 *   1. connect and switch to Monad testnet
 *   2. pay the entry fee into KhianaPot (skipped if this wallet already paid)
 *   3. sign "Join Khiana table <gameId>" so the server knows this wallet is yours
 *
 * The server checks the pot contract itself before seating anyone, so nothing
 * here is trusted — it only drives the player's wallet.
 */

const MONAD_TESTNET = {
  chainId: '0x279f',               // 10143
  chainName: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: ['https://testnet-rpc.monad.xyz'],
  blockExplorerUrls: ['https://testnet.monadscan.com'],
};

// Function selectors: keccak256("enter(bytes32)") / ("entered(bytes32,address)").
const ENTER = '0x568ab21e';
const ENTERED = '0xf41349f0';

const eth = () => window.ethereum;
const rpc = (method, params = []) => eth().request({ method, params });
const strip = h => h.replace(/^0x/, '');
const pad32 = h => strip(h).toLowerCase().padStart(64, '0');

export function hasWallet() {
  return Boolean(eth());
}

/** Decimal MON string → hex wei, exact. */
function toWeiHex(mon) {
  const [whole, frac = ''] = String(mon).split('.');
  const wei = BigInt(whole || '0') * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18));
  return '0x' + wei.toString(16);
}

export async function connectWallet() {
  if (!eth()) throw new Error('No wallet found. Install MetaMask (or any browser wallet) to play paid tables.');
  const [account] = await rpc('eth_requestAccounts');
  try {
    await rpc('wallet_switchEthereumChain', [{ chainId: MONAD_TESTNET.chainId }]);
  } catch (err) {
    // 4902: the wallet has never seen this chain.
    if (err?.code !== 4902) throw err;
    await rpc('wallet_addEthereumChain', [MONAD_TESTNET]);
  }
  return account;
}

async function alreadyEntered(pot, account) {
  const data = ENTERED + pad32(pot.gameId) + pad32(account);
  const out = await rpc('eth_call', [{ to: pot.address, data }, 'latest']);
  return BigInt(out || '0x0') === 1n;
}

async function waitForReceipt(hash) {
  for (let i = 0; i < 120; i++) {
    const r = await rpc('eth_getTransactionReceipt', [hash]);
    if (r) {
      if (r.status !== '0x1') throw new Error('Entry payment reverted.');
      return r;
    }
    await new Promise(res => setTimeout(res, 1000));
  }
  throw new Error('Entry payment is taking too long to confirm.');
}

/**
 * Pay (once) and sign. `onStep` gets short status strings for the UI.
 * Returns what the JOIN message needs.
 */
export async function payAndSign(pot, onStep = () => {}) {
  onStep('Connecting wallet…');
  const account = await connectWallet();

  if (await alreadyEntered(pot, account)) {
    onStep('Already paid for this game.');
  } else {
    onStep(`Confirm the ${pot.fee} MON entry fee in your wallet…`);
    const hash = await rpc('eth_sendTransaction', [{
      from: account, to: pot.address, value: toWeiHex(pot.fee), data: ENTER + pad32(pot.gameId),
    }]);
    onStep('Waiting for the payment to confirm…');
    await waitForReceipt(hash);
  }

  onStep('Sign in to claim your seat…');
  const message = `Join Khiana table ${pot.gameId}`;
  const signature = await rpc('personal_sign', [message, account]);
  return { wallet: account, signature };
}
