// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IKhianaCredit {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function burn(uint256 value) external;
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title PowerupShop
 * @notice Sells powerups for KHIA over x402. Everything paid here is BURNED.
 *
 * The burn is the economy's pressure curve: the pool shrinks all game, so late
 * actions are relatively more expensive. Bribes, by contrast, only move credits
 * between agents and preserve the pool. The net effect is that bribery is the
 * efficient strategy — which is exactly the behaviour the game is built to
 * produce, and the thing the room is there to watch an agent work out.
 *
 * Burning literally (KhianaCredit.burn) rather than parking credits at a dead
 * address matters here: totalSupply falls, so "MON left in the world" is
 * readable straight off the token contract at the ledger reveal instead of
 * being an off-chain claim the audience has to take on faith.
 *
 * This is a paid HTTP resource in x402 terms. The buyer signs an EIP-3009
 * authorization naming this contract as payee; the facilitator submits it.
 * The buyer spends no gas and broadcasts nothing.
 */
contract PowerupShop {
    IKhianaCredit public immutable token;
    address public immutable engine;
    uint256 public totalBurned;

    struct Purchase {
        address buyer;
        string  powerup;
        uint256 cost;
        uint64  gameTick;
    }

    Purchase[] public purchases;

    event PowerupPurchased(address indexed buyer, string powerup, uint256 cost, uint64 gameTick);

    error NotEngine();
    error ZeroAmount();

    constructor(address _engine, address _token) {
        engine = _engine;
        token = IKhianaCredit(_token);
    }

    /// @notice x402 settlement leg: pull the signed payment, then burn it.
    function buyWithAuthorization(
        address buyer,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature,
        string calldata powerup,
        uint64 gameTick
    ) external {
        if (value == 0) revert ZeroAmount();
        token.receiveWithAuthorization(
            buyer, address(this), value, validAfter, validBefore, nonce, signature
        );
        _record(buyer, powerup, value, gameTick);
    }

    /// @notice Allowance-based fallback for MOCK runs and facilitator outages.
    function buy(string calldata powerup, uint256 value, uint64 gameTick) external {
        if (value == 0) revert ZeroAmount();
        require(token.transferFrom(msg.sender, address(this), value), "pull failed");
        _record(msg.sender, powerup, value, gameTick);
    }

    function _record(address buyer, string memory powerup, uint256 value, uint64 gameTick) private {
        totalBurned += value;
        purchases.push(Purchase(buyer, powerup, value, gameTick));
        emit PowerupPurchased(buyer, powerup, value, gameTick);

        // Destroy it. Nothing that arrives here ever re-enters the economy.
        token.burn(value);
    }

    function purchaseCount() external view returns (uint256) { return purchases.length; }

    /// @notice Recover credits sent here by mistake. Cannot touch burned supply,
    /// because burned supply no longer exists.
    function sweep(address to) external {
        if (msg.sender != engine) revert NotEngine();
        // transfer, not transferFrom — a contract has no allowance to itself.
        uint256 stuck = token.balanceOf(address(this));
        if (stuck > 0) require(token.transfer(to, stuck), "sweep failed");
    }
}
