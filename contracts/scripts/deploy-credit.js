const hre = require('hardhat');
const fs = require('fs');
const path = require('path');

/**
 * Deploy KhianaCredit and prove EIP-3009 works on the live chain.
 *
 *   cd contracts && npx hardhat run scripts/deploy-credit.js --network monadTestnet
 *
 * This doubles as the Cancun check. OpenZeppelin 5.6 compiles to MCOPY
 * (EIP-5656), so if Monad did not implement Cancun this deployment would
 * either revert or produce a contract whose calls fail — and we would only
 * find out mid-game. Executing a real transferWithAuthorization here turns
 * that assumption into a fact.
 */

const MONAD_TESTNET = 10143;

async function main() {
  const net = await hre.ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const [engine, a1, a2] = await hre.ethers.getSigners();

  console.log(`\nnetwork:  ${hre.network.name} (chainId ${chainId})`);
  console.log(`engine:   ${engine.address}`);
  console.log(`balance:  ${hre.ethers.formatEther(await hre.ethers.provider.getBalance(engine.address))} MON\n`);

  // PRD §8: 8 agents × 5 = 40. Minted once, never again.
  const players = Number(process.env.PLAYERS ?? 8);
  const stake = process.env.STARTING_MON ?? '5';
  const supply = hre.ethers.parseEther(String(players * Number(stake)));

  const token = await hre.ethers.deployContract('KhianaCredit', [supply, engine.address]);
  await token.waitForDeployment();
  const address = await token.getAddress();

  console.log(`  KhianaCredit     ${address}`);
  console.log(`  supply           ${hre.ethers.formatEther(supply)} KHIA (${players} × ${stake})`);

  if (chainId === MONAD_TESTNET) await new Promise(r => setTimeout(r, 2000));

  // ── Prove EIP-3009 end to end on this chain ───────────────────────────────
  console.log('\nProving EIP-3009 (this is also the Cancun/MCOPY check)…');

  await (await token.transfer(a1.address, hre.ethers.parseEther('1'))).wait();
  if (chainId === MONAD_TESTNET) await new Promise(r => setTimeout(r, 2000));

  const domain = {
    name: 'Khiana Credit',
    version: '1',
    chainId,
    verifyingContract: address,
  };
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };
  const now = Math.floor(Date.now() / 1000);
  const auth = {
    from: a1.address,
    to: a2.address,
    value: hre.ethers.parseEther('0.25'),
    validAfter: 0,
    validBefore: now + 3600,
    nonce: hre.ethers.hexlify(hre.ethers.randomBytes(32)),
  };

  const signature = await a1.signTypedData(domain, types, auth);

  // Submitted by the ENGINE, not by a1 — exactly what the x402 facilitator
  // does. a1 spends no gas and never broadcasts anything.
  const before = await token.balanceOf(a2.address);
  const tx = await token.connect(engine).transferWithAuthorization(
    auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, signature
  );
  const receipt = await tx.wait();
  const after = await token.balanceOf(a2.address);

  const moved = after - before;
  const ok = moved === auth.value;
  console.log(`  ${ok ? '✓' : '✗'} third party settled a signed transfer — ${hre.ethers.formatEther(moved)} KHIA moved`);
  console.log(`  ${ok ? '✓' : '✗'} Cancun/MCOPY executes on this chain`);
  if (chainId === MONAD_TESTNET) {
    console.log(`\n    https://testnet.monadscan.com/tx/${receipt.hash}`);
    console.log(`    https://testnet.monadscan.com/address/${address}`);
  }
  if (!ok) process.exit(1);

  const out = path.join(__dirname, '..', 'deployments.json');
  const existing = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : {};
  fs.writeFileSync(out, JSON.stringify({
    ...existing, chainId, CREDIT_ADDRESS: address, creditSupply: supply.toString(),
  }, null, 2) + '\n');

  console.log(`\nPaste into .env:\n\nCREDIT_ADDRESS=${address}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
