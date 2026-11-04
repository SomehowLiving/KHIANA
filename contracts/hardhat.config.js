require('@nomicfoundation/hardhat-toolbox');
require('dotenv').config({ path: '../.env' });

/** Monad testnet. Chain id and RPC per docs.monad.xyz — verify before deploying. */
module.exports = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // OpenZeppelin 5.6 uses MCOPY (EIP-5656), which is Cancun-only — the
      // default 'paris' target fails to compile Bytes.sol. Monad implements
      // Cancun; scripts/check-evm.js proves MCOPY executes on testnet rather
      // than leaving it as an assumption that fails at runtime.
      evmVersion: 'cancun',
    },
  },
  networks: {
    monadTestnet: {
      url: process.env.MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz',
      chainId: 10143,
      // The engine account is index 0 of the same mnemonic the server derives
      // its agents from, so the deployer IS the escrow attestor. Deploying
      // from a different key silently bricks release() — it's onlyEngine.
      accounts: process.env.AGENT_MNEMONIC
        ? { mnemonic: process.env.AGENT_MNEMONIC, initialIndex: 0, count: 9 }
        : (process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : []),
    },
  },
};
