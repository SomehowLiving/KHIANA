const { expect } = require('chai');
const hre = require('hardhat');
const { ethers } = hre;
const { time } = require('@nomicfoundation/hardhat-network-helpers');

/**
 * Contract tests for the Phase 1 settlement layer, now denominated in KHIA
 * and funded over EIP-3009 / x402 authorizations.
 *
 * These run on the local hardhat network — no testnet credits, no faucet, no
 * network. That matters: deployment needs funded keys and a human at a faucet,
 * but CONTRACT LOGIC should never be a demo-night unknown.
 *
 *   cd contracts && npm test
 */

const TTL = 600;
const SUPPLY = ethers.parseEther('40');

/** Build and sign a ReceiveWithAuthorization for `payee`. */
async function authorize(token, signer, payee, value, chainId, overrides = {}) {
  const now = (await ethers.provider.getBlock('latest')).timestamp;
  const auth = {
    from: signer.address,
    to: payee,
    value,
    validAfter: 0,
    validBefore: now + TTL,
    nonce: ethers.hexlify(ethers.randomBytes(32)),
    ...overrides,
  };
  const signature = await signer.signTypedData(
    { name: 'Khiana Credit', version: '1', chainId, verifyingContract: await token.getAddress() },
    {
      ReceiveWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    auth
  );
  return { auth, signature };
}

describe('KhianaEscrow', () => {
  let token, escrow, engine, payer, payee, outsider, chainId;
  const cond = t => ethers.keccak256(ethers.toUtf8Bytes(t));
  const AMOUNT = ethers.parseEther('0.5');

  beforeEach(async () => {
    [engine, payer, payee, outsider] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;

    token = await ethers.deployContract('KhianaCredit', [SUPPLY, engine.address]);
    await token.waitForDeployment();
    escrow = await ethers.deployContract('KhianaEscrow', [engine.address, await token.getAddress()]);
    await escrow.waitForDeployment();

    for (const who of [payer, payee, outsider]) {
      await token.transfer(who.address, ethers.parseEther('5'));
    }
  });

  // ── x402 path ─────────────────────────────────────────────────────────────

  it('locks a bribe from a signed authorization, submitted by a third party', async () => {
    const { auth, signature } = await authorize(token, payer, await escrow.getAddress(), AMOUNT, chainId);

    // The ENGINE submits. The payer signs and spends no gas — this is exactly
    // what the x402 facilitator does.
    await expect(
      escrow.connect(engine).lockWithAuthorization(
        auth.from, payee.address, auth.value, auth.validAfter, auth.validBefore,
        auth.nonce, signature, cond('go to 12,7'), TTL
      )
    ).to.emit(escrow, 'Locked').withArgs(0, payer.address, payee.address, AMOUNT, cond('go to 12,7'));

    expect(await token.balanceOf(await escrow.getAddress())).to.equal(AMOUNT);
    expect((await escrow.get(0)).status).to.equal(0); // Open
  });

  it('pulling funds and recording the bribe is atomic', async () => {
    const { auth, signature } = await authorize(token, payer, await escrow.getAddress(), AMOUNT, chainId);
    // A zero-value lock reverts before anything moves, so no credits can be
    // left sitting in the contract unattributed.
    await expect(
      escrow.connect(engine).lockWithAuthorization(
        auth.from, payee.address, 0, auth.validAfter, auth.validBefore,
        auth.nonce, signature, cond('x'), TTL
      )
    ).to.be.revertedWithCustomError(escrow, 'ZeroAmount');
    expect(await token.balanceOf(await escrow.getAddress())).to.equal(0);
  });

  it('rejects a replayed authorization', async () => {
    const { auth, signature } = await authorize(token, payer, await escrow.getAddress(), AMOUNT, chainId);
    const args = [auth.from, payee.address, auth.value, auth.validAfter, auth.validBefore, auth.nonce, signature, cond('x'), TTL];
    await escrow.connect(engine).lockWithAuthorization(...args);
    await expect(escrow.connect(engine).lockWithAuthorization(...args))
      .to.be.revertedWithCustomError(token, 'AuthorizationAlreadyUsed');
  });

  it('rejects an authorization signed for a different payee', async () => {
    // Signed to pay `outsider`, replayed against the escrow.
    const { auth, signature } = await authorize(token, payer, outsider.address, AMOUNT, chainId);
    await expect(
      escrow.connect(engine).lockWithAuthorization(
        auth.from, payee.address, auth.value, auth.validAfter, auth.validBefore,
        auth.nonce, signature, cond('x'), TTL
      )
    ).to.be.revertedWithCustomError(token, 'InvalidSignature');
  });

  // ── Allowance fallback ────────────────────────────────────────────────────

  it('locks via allowance when the facilitator is unavailable', async () => {
    await token.connect(payer).approve(await escrow.getAddress(), AMOUNT);
    await expect(escrow.connect(payer).lock(payee.address, AMOUNT, cond('x'), TTL))
      .to.emit(escrow, 'Locked');
    expect(await token.balanceOf(await escrow.getAddress())).to.equal(AMOUNT);
  });

  // ── Release / refund ──────────────────────────────────────────────────────

  it('pays the payee when the engine attests', async () => {
    await token.connect(payer).approve(await escrow.getAddress(), AMOUNT);
    await escrow.connect(payer).lock(payee.address, AMOUNT, cond('x'), TTL);
    await expect(escrow.connect(engine).release(0))
      .to.changeTokenBalance(token, payee, AMOUNT);
    expect((await escrow.get(0)).status).to.equal(1);
  });

  // The whole point of the contract: an enemy agent cannot self-attest.
  it('refuses release from anyone but the engine', async () => {
    await token.connect(payer).approve(await escrow.getAddress(), AMOUNT);
    await escrow.connect(payer).lock(payee.address, AMOUNT, cond('x'), TTL);
    for (const who of [payer, payee, outsider]) {
      await expect(escrow.connect(who).release(0)).to.be.revertedWithCustomError(escrow, 'NotEngine');
    }
  });

  it('cannot release twice', async () => {
    await token.connect(payer).approve(await escrow.getAddress(), AMOUNT);
    await escrow.connect(payer).lock(payee.address, AMOUNT, cond('x'), TTL);
    await escrow.connect(engine).release(0);
    await expect(escrow.connect(engine).release(0)).to.be.revertedWithCustomError(escrow, 'NotOpen');
  });

  it('refuses a refund before expiry', async () => {
    await token.connect(payer).approve(await escrow.getAddress(), AMOUNT);
    await escrow.connect(payer).lock(payee.address, AMOUNT, cond('x'), TTL);
    await expect(escrow.refund(0)).to.be.revertedWithCustomError(escrow, 'NotExpired');
  });

  // Permissionless by design — a stalled engine must not strand money.
  it('lets anyone refund the payer after expiry', async () => {
    await token.connect(payer).approve(await escrow.getAddress(), AMOUNT);
    await escrow.connect(payer).lock(payee.address, AMOUNT, cond('x'), TTL);
    await time.increase(TTL + 1);
    await expect(escrow.connect(outsider).refund(0)).to.changeTokenBalance(token, payer, AMOUNT);
    expect((await escrow.get(0)).status).to.equal(2);
  });

  it('keeps concurrent bribes independent', async () => {
    await token.connect(payer).approve(await escrow.getAddress(), ethers.parseEther('0.3'));
    await token.connect(outsider).approve(await escrow.getAddress(), ethers.parseEther('0.7'));
    await escrow.connect(payer).lock(payee.address, ethers.parseEther('0.3'), cond('a'), TTL);
    await escrow.connect(outsider).lock(payee.address, ethers.parseEther('0.7'), cond('b'), TTL);
    expect(await escrow.nextId()).to.equal(2);

    await escrow.connect(engine).release(1);
    expect((await escrow.get(0)).status).to.equal(0);
    expect((await escrow.get(1)).status).to.equal(1);
  });
});

describe('RoleCommit', () => {
  let commit;
  const gameId = ethers.keccak256(ethers.toUtf8Bytes('game-1'));
  const roles = '{"p1":"SABOTEUR","p2":"LOYALIST"}';
  const salt = ethers.keccak256(ethers.toUtf8Bytes('salt'));
  const commitment = (r, s) =>
    ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['string', 'bytes32'], [r, s]));

  beforeEach(async () => {
    commit = await ethers.deployContract('RoleCommit');
    await commit.waitForDeployment();
  });

  it('commits and reveals', async () => {
    await expect(commit.commit(gameId, commitment(roles, salt))).to.emit(commit, 'Committed');
    await expect(commit.reveal(gameId, roles, salt)).to.emit(commit, 'Revealed').withArgs(gameId, roles);
    expect((await commit.games(gameId)).revealed).to.equal(true);
  });

  it('refuses a second commitment for the same game', async () => {
    await commit.commit(gameId, commitment(roles, salt));
    await expect(commit.commit(gameId, commitment(roles, salt)))
      .to.be.revertedWithCustomError(commit, 'AlreadyCommitted');
  });

  // The property the whole mechanism exists for: the host cannot swap someone
  // onto the Saboteur team after seeing how the game is going.
  it('refuses a reveal that does not match the commitment', async () => {
    await commit.commit(gameId, commitment(roles, salt));
    await expect(commit.reveal(gameId, '{"p1":"LOYALIST","p2":"SABOTEUR"}', salt))
      .to.be.revertedWithCustomError(commit, 'BadReveal');
  });

  it('refuses a reveal with the wrong salt', async () => {
    await commit.commit(gameId, commitment(roles, salt));
    await expect(commit.reveal(gameId, roles, ethers.keccak256(ethers.toUtf8Bytes('other'))))
      .to.be.revertedWithCustomError(commit, 'BadReveal');
  });

  it('refuses a reveal for an uncommitted game', async () => {
    await expect(commit.reveal(gameId, roles, salt)).to.be.revertedWithCustomError(commit, 'NoCommitment');
  });

  it('cannot reveal twice', async () => {
    await commit.commit(gameId, commitment(roles, salt));
    await commit.reveal(gameId, roles, salt);
    await expect(commit.reveal(gameId, roles, salt)).to.be.revertedWithCustomError(commit, 'AlreadyRevealed');
  });
});

describe('PowerupShop', () => {
  let token, shop, engine, buyer, other, chainId;
  const COST = ethers.parseEther('1.0');

  beforeEach(async () => {
    [engine, buyer, other] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;
    token = await ethers.deployContract('KhianaCredit', [SUPPLY, engine.address]);
    await token.waitForDeployment();
    shop = await ethers.deployContract('PowerupShop', [engine.address, await token.getAddress()]);
    await shop.waitForDeployment();
    await token.transfer(buyer.address, ethers.parseEther('5'));
    await token.transfer(other.address, ethers.parseEther('5'));
  });

  it('settles an x402 purchase and burns the credits', async () => {
    const { auth, signature } = await authorize(token, buyer, await shop.getAddress(), COST, chainId);
    const before = await token.totalSupply();

    await expect(
      shop.connect(engine).buyWithAuthorization(
        auth.from, auth.value, auth.validAfter, auth.validBefore, auth.nonce, signature, 'REVEAL', 7
      )
    ).to.emit(shop, 'PowerupPurchased').withArgs(buyer.address, 'REVEAL', COST, 7);

    // Genuinely destroyed, not parked — totalSupply falls, so the ledger
    // reveal can read "credits left in the world" straight off the token.
    expect(await token.totalSupply()).to.equal(before - COST);
    expect(await token.balanceOf(await shop.getAddress())).to.equal(0);
    expect(await shop.totalBurned()).to.equal(COST);
  });

  it('accumulates burned credits across purchases', async () => {
    await token.connect(buyer).approve(await shop.getAddress(), ethers.parseEther('0.75'));
    await shop.connect(buyer).buy('LANTERN', ethers.parseEther('0.75'), 1);
    await token.connect(other).approve(await shop.getAddress(), ethers.parseEther('2.0'));
    await shop.connect(other).buy('FREEZE', ethers.parseEther('2.0'), 2);

    expect(await shop.totalBurned()).to.equal(ethers.parseEther('2.75'));
    expect(await token.totalSupply()).to.equal(SUPPLY - ethers.parseEther('2.75'));
  });

  it('rejects a zero-value purchase', async () => {
    await expect(shop.connect(buyer).buy('REVEAL', 0, 1))
      .to.be.revertedWithCustomError(shop, 'ZeroAmount');
  });

  it('lets only the engine sweep stuck credits', async () => {
    // Credits sent directly, bypassing buy() — recoverable, unlike burned ones.
    await token.connect(buyer).transfer(await shop.getAddress(), ethers.parseEther('1'));
    await expect(shop.connect(other).sweep(other.address))
      .to.be.revertedWithCustomError(shop, 'NotEngine');
    await expect(shop.connect(engine).sweep(engine.address))
      .to.changeTokenBalance(token, engine, ethers.parseEther('1'));
  });
});
