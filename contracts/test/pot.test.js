const { expect } = require('chai');
const { ethers } = require('hardhat');

describe('KhianaPot', () => {
  let pot, engine, treasury, a, b, c, outsider;
  const FEE = ethers.parseEther('0.1');
  const game = ethers.keccak256(ethers.toUtf8Bytes('khiana:test'));
  const later = async s => (await ethers.provider.getBlock('latest')).timestamp + s;

  beforeEach(async () => {
    [engine, treasury, a, b, c, outsider] = await ethers.getSigners();
    pot = await ethers.deployContract('KhianaPot', [engine.address, treasury.address, 500]);
    await pot.connect(engine).open(game, FEE, await later(3600));
  });

  it('takes exactly the fee, once per player', async () => {
    await expect(pot.connect(a).enter(game, { value: FEE })).to.changeEtherBalance(pot, FEE);
    await expect(pot.connect(a).enter(game, { value: FEE })).to.be.revertedWithCustomError(pot, 'AlreadyEntered');
    await expect(pot.connect(b).enter(game, { value: FEE - 1n })).to.be.revertedWithCustomError(pot, 'WrongFee');
    expect(await pot.entered(game, a.address)).to.equal(true);
  });

  it('refuses entry to a pot that was never opened', async () => {
    const other = ethers.keccak256(ethers.toUtf8Bytes('nope'));
    await expect(pot.connect(a).enter(other, { value: FEE })).to.be.revertedWithCustomError(pot, 'NotOpen');
  });

  it('pays the rake to the treasury and splits the rest between winners', async () => {
    for (const p of [a, b, c]) await pot.connect(p).enter(game, { value: FEE });
    const total = FEE * 3n;
    const rest = total - total * 5n / 100n;
    await expect(pot.connect(engine).settle(game, [a.address, b.address])).to.changeEtherBalances(
      [a, b, c, treasury], [rest / 2n, rest / 2n, 0, total - (rest / 2n) * 2n]);
  });

  it('refunds entrants minus the rake when no entrant won', async () => {
    for (const p of [a, b]) await pot.connect(p).enter(game, { value: FEE });
    const each = (FEE * 2n - FEE * 2n * 5n / 100n) / 2n;
    await expect(pot.connect(engine).settle(game, [])).to.changeEtherBalances([a, b], [each, each]);
  });

  it('only pays players who entered, and only the engine settles', async () => {
    await pot.connect(a).enter(game, { value: FEE });
    await expect(pot.connect(a).settle(game, [a.address])).to.be.revertedWithCustomError(pot, 'NotEngine');
    await expect(pot.connect(engine).settle(game, [outsider.address]))
      .to.be.revertedWithCustomError(pot, 'NotEntrant');
  });

  it('cannot settle twice', async () => {
    await pot.connect(a).enter(game, { value: FEE });
    await pot.connect(engine).settle(game, [a.address]);
    await expect(pot.connect(engine).settle(game, [a.address])).to.be.revertedWithCustomError(pot, 'NotOpen');
  });

  it('cancels with full refunds: engine any time, anyone after the deadline', async () => {
    for (const p of [a, b]) await pot.connect(p).enter(game, { value: FEE });
    await expect(pot.connect(outsider).cancel(game)).to.be.revertedWithCustomError(pot, 'TooEarly');
    await ethers.provider.send('evm_increaseTime', [3601]);
    await ethers.provider.send('evm_mine', []);
    await expect(pot.connect(outsider).cancel(game)).to.changeEtherBalances([a, b], [FEE, FEE]);
  });

  it('refuses a rake above 20%', async () => {
    await expect(ethers.deployContract('KhianaPot', [engine.address, treasury.address, 2001]))
      .to.be.revertedWithCustomError(pot, 'RakeTooHigh');
  });
});
