// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title KhianaPot
 * @notice Real-money entry fees for paid tables, in native MON.
 *
 * KHIA is the in-game chip: the engine stakes every advisor from its own
 * treasury and it has no outside value. What a PLAYER puts at risk is this:
 * an entry fee paid from their own wallet when they take a seat, pooled per
 * game, and paid out to the winners when it ends.
 *
 *   open(game, fee, deadline)   engine opens a pot before anyone can enter
 *   enter(game)                 a player pays exactly `fee`, once per game
 *   settle(game, winners)       engine: rake to the treasury, rest split
 *                               evenly between `winners` (all must have entered)
 *   cancel(game)                engine any time, ANYONE after the deadline:
 *                               every entrant refunded in full
 *
 * The engine decides who won, as it does for bribe escrow. What the contract
 * guarantees is that entry fees can only ever go to entrants or, as the rake,
 * to the treasury — and that a stalled engine cannot keep anyone's fee.
 */
contract KhianaPot {
    struct Pot {
        uint256 fee;
        uint256 total;
        uint64  deadline;
        bool    open;
        bool    closed;
        address[] entrants;
    }

    address public immutable engine;
    address public immutable treasury;
    uint16  public immutable rakeBps;      // 500 = 5%

    mapping(bytes32 => Pot) private pots;
    mapping(bytes32 => mapping(address => bool)) public entered;
    /// Payouts a recipient could not receive directly; claim with withdraw().
    mapping(address => uint256) public owed;

    event Opened(bytes32 indexed game, uint256 fee, uint64 deadline);
    event Entered(bytes32 indexed game, address indexed player, uint256 fee);
    event Settled(bytes32 indexed game, address[] winners, uint256 share, uint256 rake);
    event Cancelled(bytes32 indexed game, uint256 refunded);

    error NotEngine();
    error AlreadyOpen();
    error NotOpen();
    error WrongFee();
    error AlreadyEntered();
    error NotEntrant(address who);
    error TooEarly();
    error RakeTooHigh();

    modifier onlyEngine() {
        if (msg.sender != engine) revert NotEngine();
        _;
    }

    constructor(address _engine, address _treasury, uint16 _rakeBps) {
        if (_rakeBps > 2000) revert RakeTooHigh();   // never more than 20%
        engine = _engine;
        treasury = _treasury;
        rakeBps = _rakeBps;
    }

    function open(bytes32 game, uint256 fee, uint64 deadline) external onlyEngine {
        Pot storage p = pots[game];
        if (p.open || p.closed) revert AlreadyOpen();
        p.fee = fee;
        p.deadline = deadline;
        p.open = true;
        emit Opened(game, fee, deadline);
    }

    function enter(bytes32 game) external payable {
        Pot storage p = pots[game];
        if (!p.open) revert NotOpen();
        if (msg.value != p.fee) revert WrongFee();
        if (entered[game][msg.sender]) revert AlreadyEntered();
        entered[game][msg.sender] = true;
        p.entrants.push(msg.sender);
        p.total += msg.value;
        emit Entered(game, msg.sender, msg.value);
    }

    /**
     * Rake to the treasury, the rest split evenly between `winners`. With no
     * winners every entrant gets their fee back minus the rake: losing to the
     * bots should not hand the pot to the house.
     */
    function settle(bytes32 game, address[] calldata winners) external onlyEngine {
        Pot storage p = pots[game];
        if (!p.open) revert NotOpen();
        p.open = false;
        p.closed = true;

        uint256 rake = (p.total * rakeBps) / 10_000;
        uint256 rest = p.total - rake;
        address[] memory to = winners.length > 0 ? winners : _copy(p.entrants);
        for (uint256 i = 0; i < to.length; i++) {
            if (!entered[game][to[i]]) revert NotEntrant(to[i]);
        }

        uint256 share = to.length > 0 ? rest / to.length : 0;
        // Dust from the division goes with the rake.
        uint256 toTreasury = rest - share * to.length + rake;
        emit Settled(game, to, share, toTreasury);

        for (uint256 i = 0; i < to.length; i++) _pay(to[i], share);
        _pay(treasury, toTreasury);
    }

    /// Full refunds. The engine may cancel any time; anyone after the deadline.
    function cancel(bytes32 game) external {
        Pot storage p = pots[game];
        if (!p.open) revert NotOpen();
        if (msg.sender != engine && block.timestamp < p.deadline) revert TooEarly();
        p.open = false;
        p.closed = true;
        emit Cancelled(game, p.total);
        for (uint256 i = 0; i < p.entrants.length; i++) _pay(p.entrants[i], p.fee);
    }

    /// Claim a payout that could not be sent directly (a contract wallet that rejects MON).
    function withdraw() external {
        uint256 amount = owed[msg.sender];
        owed[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "withdraw failed");
    }

    function get(bytes32 game) external view returns (
        uint256 fee, uint256 total, uint64 deadline, bool isOpen, bool isClosed, uint256 entrants
    ) {
        Pot storage p = pots[game];
        return (p.fee, p.total, p.deadline, p.open, p.closed, p.entrants.length);
    }

    function _copy(address[] storage list) private view returns (address[] memory out) {
        out = new address[](list.length);
        for (uint256 i = 0; i < list.length; i++) out[i] = list[i];
    }

    /// One recipient that rejects MON must not block everyone else's payout.
    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount, gas: 30_000}("");
        if (!ok) owed[to] += amount;
    }
}
