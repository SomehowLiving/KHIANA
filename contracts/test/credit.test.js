const { expect } = require('chai');
const hre = require('hardhat');
const { ethers } = hre;

/**
 * KhianaCredit — the EIP-3009 token that makes x402 possible.
 *
 * The signing tests matter more than usual: if the EIP-712 domain or typehash
 * is wrong, every signature this token produces is rejected by the facilitator
 * with a generic "invalid signature", and there is nothing in the error to
 * tell you which of the two is at fault.
 */

const SUPPLY = ethers.parseEther('40');   // PRD §8: 8 agents × 5

describe('KhianaCredit', () => {
  let token, engine, alice, bob, carol, chainId;

  beforeEach(async () => {
    [engine, alice, bob, carol] = await ethers.getSigners();
    token = await ethers.deployContract('KhianaCredit', [SUPPLY, engine.address]);
    await token.waitForDeployment();
    chainId = (await ethers.provider.getNetwork()).chainId;
    await token.transfer(alice.address, ethers.parseEther('5'));
  });

  const domain = async () => ({
    name: 'Khiana Credit',
    version: '1',
    chainId,
    verifyingContract: await token.getAddress(),
  });

  const TRANSFER_TYPES = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };

  const RECEIVE_TYPES = {
    ReceiveWithAuthorization: TRANSFER_TYPES.TransferWithAuthorization,
  };

  async function auth(overrides = {}) {
    const now = await time();
    return {
      from: alice.address,
      to: bob.address,
      value: ethers.parseEther('0.25'),
      validAfter: 0,
      validBefore: now + 3600,
      nonce: ethers.hexlify(ethers.randomBytes(32)),
      ...overrides,
    };
  }

  const time = async () => (await ethers.provider.getBlock('latest')).timestamp;

  // ── The constants I would otherwise be trusting from memory ──────────────

  it('typehashes match their canonical strings', async () => {
    const t = s => ethers.keccak256(ethers.toUtf8Bytes(s));
    expect(await token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH()).to.equal(
      t('TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)')
    );
    expect(await token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH()).to.equal(
      t('ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)')
    );
    expect(await token.CANCEL_AUTHORIZATION_TYPEHASH()).to.equal(
      t('CancelAuthorization(address authorizer,bytes32 nonce)')
    );
  });

  it('domain separator matches an independently built EIP-712 domain', async () => {
    const built = ethers.TypedDataEncoder.hashDomain(await domain());
    expect(await token.DOMAIN_SEPARATOR()).to.equal(built);
  });

  // ── Supply and policy ────────────────────────────────────────────────────

  it('mints the whole supply once, to the engine', async () => {
    expect(await token.totalSupply()).to.equal(SUPPLY);
    expect(await token.decimals()).to.equal(18);
    expect(await token.symbol()).to.equal('KHIA');
  });

  it('has no mint function — supply can never grow', () => {
    expect(token.interface.fragments.some(f => f.name === 'mint')).to.equal(false);
  });

  it('burning shrinks the pool permanently', async () => {
    await token.connect(alice).burn(ethers.parseEther('1'));
    expect(await token.totalSupply()).to.equal(SUPPLY - ethers.parseEther('1'));
  });

  // ── EIP-3009 ─────────────────────────────────────────────────────────────

  it('settles a signed transfer submitted by a third party', async () => {
    const a = await auth();
    const sig = await alice.signTypedData(await domain(), TRANSFER_TYPES, a);

    // carol broadcasts and pays the gas — this is the facilitator's role.
    await expect(
      token.connect(carol).transferWithAuthorization(
        a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, sig
      )
    ).to.changeTokenBalances(token, [alice, bob], [-a.value, a.value]);

    expect(await token.authorizationState(alice.address, a.nonce)).to.equal(true);
  });

  it('rejects a replayed nonce', async () => {
    const a = await auth();
    const sig = await alice.signTypedData(await domain(), TRANSFER_TYPES, a);
    await token.connect(carol).transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, sig);
    await expect(
      token.connect(carol).transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, sig)
    ).to.be.revertedWithCustomError(token, 'AuthorizationAlreadyUsed');
  });

  it('rejects a signature from the wrong signer', async () => {
    const a = await auth();
    const sig = await bob.signTypedData(await domain(), TRANSFER_TYPES, a);
    await expect(
      token.connect(carol).transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, sig)
    ).to.be.revertedWithCustomError(token, 'InvalidSignature');
  });

  it('rejects tampered amounts', async () => {
    const a = await auth();
    const sig = await alice.signTypedData(await domain(), TRANSFER_TYPES, a);
    await expect(
      token.connect(carol).transferWithAuthorization(
        a.from, a.to, ethers.parseEther('5'), a.validAfter, a.validBefore, a.nonce, sig
      )
    ).to.be.revertedWithCustomError(token, 'InvalidSignature');
  });

  it('rejects an expired authorization', async () => {
    const now = await time();
    const a = await auth({ validBefore: now + 60 });
    const sig = await alice.signTypedData(await domain(), TRANSFER_TYPES, a);
    await hre.network.provider.send('evm_increaseTime', [120]);
    await hre.network.provider.send('evm_mine');
    await expect(
      token.connect(carol).transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, sig)
    ).to.be.revertedWithCustomError(token, 'AuthorizationExpired');
  });

  it('rejects an authorization that is not yet valid', async () => {
    const now = await time();
    const a = await auth({ validAfter: now + 600 });
    const sig = await alice.signTypedData(await domain(), TRANSFER_TYPES, a);
    await expect(
      token.connect(carol).transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, sig)
    ).to.be.revertedWithCustomError(token, 'AuthorizationNotYetValid');
  });

  // Concurrency: an agent may have several payments in flight inside one tick.
  it('allows multiple in-flight authorizations with different nonces', async () => {
    const a1 = await auth({ value: ethers.parseEther('0.25') });
    const a2 = await auth({ value: ethers.parseEther('0.25'), to: carol.address });
    const s1 = await alice.signTypedData(await domain(), TRANSFER_TYPES, a1);
    const s2 = await alice.signTypedData(await domain(), TRANSFER_TYPES, a2);

    await token.connect(carol).transferWithAuthorization(a1.from, a1.to, a1.value, a1.validAfter, a1.validBefore, a1.nonce, s1);
    await token.connect(carol).transferWithAuthorization(a2.from, a2.to, a2.value, a2.validAfter, a2.validBefore, a2.nonce, s2);

    expect(await token.balanceOf(bob.address)).to.equal(ethers.parseEther('0.25'));
    expect(await token.balanceOf(carol.address)).to.equal(ethers.parseEther('0.25'));
  });

  it('binds receiveWithAuthorization to the payee', async () => {
    const a = await auth();
    const sig = await alice.signTypedData(await domain(), RECEIVE_TYPES, a);

    await expect(
      token.connect(carol).receiveWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, sig)
    ).to.be.revertedWithCustomError(token, 'CallerMustBePayee');

    await expect(
      token.connect(bob).receiveWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, sig)
    ).to.changeTokenBalances(token, [alice, bob], [-a.value, a.value]);
  });

  it('lets a signer cancel an authorization before it is used', async () => {
    const a = await auth();
    const sig = await alice.signTypedData(await domain(), TRANSFER_TYPES, a);
    const cancelSig = await alice.signTypedData(
      await domain(),
      { CancelAuthorization: [{ name: 'authorizer', type: 'address' }, { name: 'nonce', type: 'bytes32' }] },
      { authorizer: alice.address, nonce: a.nonce }
    );

    await token.connect(carol).cancelAuthorization(alice.address, a.nonce, cancelSig);
    await expect(
      token.connect(carol).transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, sig)
    ).to.be.revertedWithCustomError(token, 'AuthorizationAlreadyUsed');
  });
});
