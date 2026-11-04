const hre = require('hardhat');
const fs = require('fs');
const path = require('path');

/**
 * Phase 1 deploy.
 *
 *   cd contracts && npm run deploy
 *
 * The deployer is index 0 of AGENT_MNEMONIC — the same account the server
 * uses as its engine. This matters: KhianaEscrow takes the engine address
 * as an immutable constructor arg and gates release() behind onlyEngine.
 * Deploy from a different key and every bribe locks fine but can never be
 * released, with no error until the first release attempt at tick ~12.
 */

const MONAD_TESTNET = 10143;

async function main() {
  const net = await hre.ethers.provider.getNetwork();
  const chainId = Number(net.chainId);

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) {
    console.error('\nNo signer. Set AGENT_MNEMONIC in the repo-root .env.\n');
    process.exit(1);
  }

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`\nnetwork:  ${hre.network.name}  (chainId ${chainId})`);
  console.log(`deployer: ${deployer.address}`);
  console.log(`balance:  ${hre.ethers.formatEther(balance)} MON\n`);

  if (chainId === 143) {
    console.error('This is Monad MAINNET. Khiana is testnet-only by design (PRD §12). Aborting.\n');
    process.exit(1);
  }
  if (chainId !== MONAD_TESTNET && hre.network.name !== 'hardhat' && hre.network.name !== 'localhost') {
    console.error(`Unexpected chainId ${chainId} — expected ${MONAD_TESTNET}. Aborting.\n`);
    process.exit(1);
  }
  if (balance === 0n) {
    console.error('Deployer has no MON. Faucet: https://faucet.monad.xyz\n');
    process.exit(1);
  }

  /**
   * Space the deploys out on Monad.
   *
   * Reserve balance: a tx reverts if the sender's ending balance falls below
   * min(starting_balance, 10 MON). A deployer holding under 10 MON is below
   * its own floor on every deploy, and only survives via the emptying-
   * transaction exception — which requires no other tx from this account in
   * the previous 3 blocks (~1.2s). Three back-to-back deploys would trip it.
   *
   * The server enforces the same rule per-agent in economy/wallets.js; hardhat
   * doesn't know about it, so we do it by hand here.
   */
  const isMonad = chainId === MONAD_TESTNET;
  const spacing = isMonad ? 2000 : 0;
  const pace = () => new Promise(r => setTimeout(r, spacing));

  /**
   * The escrow and the shop are denominated in KHIA, so the token must exist
   * first. Reuse CREDIT_ADDRESS when it is already deployed — re-minting the
   * supply would orphan every agent's existing stake.
   */
  let credit = process.env.CREDIT_ADDRESS;
  if (credit && (await hre.ethers.provider.getCode(credit)) !== '0x') {
    console.log(`  KhianaCredit     ${credit}   (reused)`);
  } else {
    const players = Number(process.env.PLAYERS ?? 8);
    const stake = process.env.STARTING_MON ?? '5';
    const token = await hre.ethers.deployContract(
      'KhianaCredit', [hre.ethers.parseEther(String(players * Number(stake))), deployer.address]
    );
    await token.waitForDeployment();
    credit = await token.getAddress();
    console.log(`  KhianaCredit     ${credit}   (${players} × ${stake} KHIA)`);
    await new Promise(r => setTimeout(r, chainId === MONAD_TESTNET ? 2000 : 0));
  }

  const deployed = { KhianaCredit: credit };
  for (const [label, name, args] of [
    ['KhianaEscrow', 'KhianaEscrow', [deployer.address, credit]],
    ['RoleCommit', 'RoleCommit', []],
    ['PowerupShop', 'PowerupShop', [deployer.address, credit]],
  ]) {
    const c = await hre.ethers.deployContract(name, args);
    await c.waitForDeployment();
    deployed[label] = await c.getAddress();
    const spent = balance - await hre.ethers.provider.getBalance(deployer.address);
    console.log(`  ${label.padEnd(16)} ${deployed[label]}   (cumulative gas ${hre.ethers.formatEther(spent)} MON)`);
    await pace();
  }

  const Escrow = { getAddress: async () => deployed.KhianaEscrow };
  const Commit = { getAddress: async () => deployed.RoleCommit };
  const Shop = { getAddress: async () => deployed.PowerupShop };

  const addresses = {
    chainId,
    deployedAt: new Date().toISOString(),
    engine: deployer.address,
    CREDIT_ADDRESS: credit,
    ESCROW_ADDRESS: await Escrow.getAddress(),
    COMMIT_ADDRESS: await Commit.getAddress(),
    SHOP_ADDRESS: await Shop.getAddress(),
  };

  // Written so the phase1 script and the ledger reveal can find the addresses
  // without a human copy-paste step in the middle of a demo setup.
  const out = path.join(__dirname, '..', 'deployments.json');
  fs.writeFileSync(out, JSON.stringify(addresses, null, 2) + '\n');
  console.log(`\nwrote ${out}`);

  console.log('\nPaste into .env:\n');
  console.log('ESCROW_ADDRESS=' + addresses.ESCROW_ADDRESS);
  console.log('COMMIT_ADDRESS=' + addresses.COMMIT_ADDRESS);
  console.log('SHOP_ADDRESS='   + addresses.SHOP_ADDRESS);

  if (chainId === MONAD_TESTNET) {
    console.log('\nExplorer:');
    for (const k of ['ESCROW_ADDRESS', 'COMMIT_ADDRESS', 'SHOP_ADDRESS']) {
      console.log(`  https://testnet.monadscan.com/address/${addresses[k]}`);
    }
    console.log('\nNext:  cd ../server && npm run phase1\n');
  } else {
    console.log('');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
