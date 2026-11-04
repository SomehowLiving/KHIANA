// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IEIP3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
}

/**
 * @title KhianaEscrow
 * @notice Conditional bribes between agents on opposing teams, funded over x402.
 *
 * This contract is the strongest justification for putting Khiana on a chain
 * at all. Two agents on opposing teams have no reason to trust each other and
 * no way to build trust inside a 10-minute game. A bribe of the form "I pay
 * you on delivery" is unenforceable without a neutral party — and there isn't
 * one. So the contract holds the money and releases it when the game engine
 * attests that the condition was met.
 *
 * ── Why this holds KHIA rather than native MON ────────────────────────────
 *
 * x402 cannot move native tokens: the facilitator's `exact` scheme settles
 * through EIP-3009 `transferWithAuthorization`, an ERC-20 method. For bribes
 * to travel over x402 the escrow has to hold an ERC-20. See KhianaCredit.sol.
 *
 * ── Why lockWithAuthorization is one call ─────────────────────────────────
 *
 * The naive version is two steps: settle an x402 payment into this contract,
 * then call lock(). Between those steps the credits are sitting here
 * unattributed, and if the second call fails they are stranded with no record
 * of who they belong to. `lockWithAuthorization` pulls the funds and records
 * the bribe atomically — either both happen or neither does.
 *
 * It uses receiveWithAuthorization (not transferWithAuthorization) so that
 * only this contract can submit the signature. A plain authorization is
 * broadcastable by anyone who sees it, which for a bribe means a third party
 * could choose the moment someone's payment lands.
 *
 * The engine is a trusted attestor, which is a real centralisation caveat and
 * worth saying out loud rather than hiding: the engine decides whether a human
 * reached a tile. What the chain guarantees is that the PAYMENT cannot be
 * reneged on, reordered, or quietly erased after the fact — which is what
 * makes the end-of-game ledger reveal believable.
 */
contract KhianaEscrow {
    enum Status { Open, Released, Refunded }

    struct Bribe {
        address payer;
        address payee;
        uint256 amount;
        bytes32 condition;   // keccak256 of the instruction text
        uint64  expiresAt;
        Status  status;
    }

    IERC20  public immutable token;
    address public immutable engine;
    uint256 public nextId;
    mapping(uint256 => Bribe) public bribes;

    event Locked(uint256 indexed id, address indexed payer, address indexed payee, uint256 amount, bytes32 condition);
    event Released(uint256 indexed id, address indexed payee, uint256 amount);
    event Refunded(uint256 indexed id, address indexed payer, uint256 amount);

    error NotEngine();
    error NotOpen();
    error NotExpired();
    error ZeroAmount();

    modifier onlyEngine() {
        if (msg.sender != engine) revert NotEngine();
        _;
    }

    constructor(address _engine, address _token) {
        engine = _engine;
        token = IERC20(_token);
    }

    /**
     * @notice Lock a bribe using an x402 / EIP-3009 authorization signed by
     *         the payer. The payer never sends a transaction and never spends
     *         gas — the facilitator (or the engine) submits this.
     */
    function lockWithAuthorization(
        address payer,
        address payee,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature,
        bytes32 condition,
        uint64 ttlSeconds
    ) external returns (uint256 id) {
        if (value == 0) revert ZeroAmount();

        // Pulls exactly `value` from payer into this contract. Reverts on a
        // bad signature, a replayed nonce, or an expired window.
        IEIP3009(address(token)).receiveWithAuthorization(
            payer, address(this), value, validAfter, validBefore, nonce, signature
        );

        id = _record(payer, payee, value, condition, ttlSeconds);
    }

    /**
     * @notice Lock via a plain ERC-20 allowance instead of an authorization.
     *         Kept for MOCK/offline runs and as a fallback if the facilitator
     *         is down — the game must never be unplayable because a third
     *         party is having an outage.
     */
    function lock(address payee, uint256 value, bytes32 condition, uint64 ttlSeconds)
        external
        returns (uint256 id)
    {
        if (value == 0) revert ZeroAmount();
        require(token.transferFrom(msg.sender, address(this), value), "pull failed");
        id = _record(msg.sender, payee, value, condition, ttlSeconds);
    }

    function _record(address payer, address payee, uint256 value, bytes32 condition, uint64 ttlSeconds)
        private
        returns (uint256 id)
    {
        id = nextId++;
        bribes[id] = Bribe({
            payer: payer,
            payee: payee,
            amount: value,
            condition: condition,
            expiresAt: uint64(block.timestamp) + ttlSeconds,
            status: Status.Open
        });
        emit Locked(id, payer, payee, value, condition);
    }

    /// @notice Engine attests the condition was satisfied; funds go to the payee.
    function release(uint256 id) external onlyEngine {
        Bribe storage b = bribes[id];
        if (b.status != Status.Open) revert NotOpen();
        b.status = Status.Released;
        emit Released(id, b.payee, b.amount);
        require(token.transfer(b.payee, b.amount), "transfer failed");
    }

    /// @notice After expiry, anyone can return the funds to the payer.
    /// Permissionless so a stalled engine can't strand money.
    function refund(uint256 id) external {
        Bribe storage b = bribes[id];
        if (b.status != Status.Open) revert NotOpen();
        if (block.timestamp < b.expiresAt) revert NotExpired();
        b.status = Status.Refunded;
        emit Refunded(id, b.payer, b.amount);
        require(token.transfer(b.payer, b.amount), "refund failed");
    }

    function get(uint256 id) external view returns (Bribe memory) {
        return bribes[id];
    }
}
