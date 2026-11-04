import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Dry-run the entire settlement layer against a local hardhat node.
 *
 *   Terminal 1:  cd contracts && npx hardhat node
 *   Terminal 2:  cd contracts && npm run deploy:local -- --network localhost
 *   Terminal 3:  cd server   && npm run phase1:local
 *
 * Why this exists: the real Phase 1 acceptance needs funded testnet keys and
 * a human at a faucet. Everything ELSE — key derivation, the reserve-balance
 * send gate, escrow lock/release, the powerup burn — is ordinary code and
 * should be proven before anyone waits on a faucet drip.
 *
 * Env is set here rather than in .env so a local run can never be confused
 * for a testnet run, and so nobody's real mnemonic is involved.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Hardhat's well-known development mnemonic. Publicly known by design —
// never put anything of value behind it.
process.env.AGENT_MNEMONIC = 'test test test test test test test test test test test junk';
process.env.MOCK_CHAIN = 'false';
process.env.CHAIN_ID = '31337';
process.env.MONAD_RPC_URL = 'http://127.0.0.1:8545';

const deployments = path.join(__dirname, '..', '..', 'contracts', 'deployments.json');
if (!fs.existsSync(deployments)) {
  console.error('\nNo contracts/deployments.json. Deploy to the local node first:\n');
  console.error('  Terminal 1:  cd contracts && npx hardhat node');
  console.error('  Terminal 2:  cd contracts && npm run deploy:local -- --network localhost\n');
  process.exit(1);
}

const d = JSON.parse(fs.readFileSync(deployments, 'utf8'));
if (d.chainId !== 31337) {
  console.error(`\ndeployments.json is for chainId ${d.chainId}, not the local node (31337).`);
  console.error('Re-deploy locally, or run `npm run phase1` for testnet.\n');
  process.exit(1);
}

process.env.ESCROW_ADDRESS = d.ESCROW_ADDRESS;
process.env.SHOP_ADDRESS = d.SHOP_ADDRESS;
process.env.COMMIT_ADDRESS = d.COMMIT_ADDRESS;

await import('./phase1.mjs');
