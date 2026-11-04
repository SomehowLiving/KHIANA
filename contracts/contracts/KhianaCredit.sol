// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title KhianaCredit (KHIA)
 * @notice The game's unit of account, and the reason x402 works at all.
 *
 * ── Why this contract exists ──────────────────────────────────────────────
 *
 * Khiana's economy was originally denominated in native MON. That is
 * incompatible with x402: the Monad facilitator's `exact` scheme settles via
 * EIP-3009 `transferWithAuthorization`, which is an ERC-20 method. Native
 * tokens have no such entry point, and the facilitator rejects them outright
 * with `unsupported_scheme`. If agents are to pay each other through x402 —
 * for contact fees, powerups and bribes — the currency has to be an ERC-20
 * that implements EIP-3009. So here it is.
 *
 * The second reason is practical: a public faucet drips a few MON per address
 * per day, which makes an eight-agent game with a 5-per-agent stake
 * impossible to fund. Minting a fixed supply ourselves removes that gate
 * entirely. Native MON is then needed only for gas.
 *
 * ── Monetary policy ───────────────────────────────────────────────────────
 *
 * PRD §8 says "nothing is minted". That intent is preserved: the entire
 * supply is minted ONCE in the constructor and `mint` does not exist. Inside
 * a game, credits only ever move (contacts, bribes) or burn (powerups). The
 * pool shrinks all game exactly as designed — the substrate changed, the
 * policy did not.
 *
 * ── EIP-3009 ──────────────────────────────────────────────────────────────
 *
 * Lets a holder sign a transfer off-chain and have someone else broadcast it.
 * That is precisely the x402 handshake: the agent signs, the facilitator
 * submits and pays the gas. Nonces are arbitrary 32-byte values rather than a
 * sequential counter, so an agent can have several authorizations in flight
 * within one tick without them invalidating each other.
 */
contract KhianaCredit is ERC20, EIP712 {
    // keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;

    // keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8;

    // keccak256("CancelAuthorization(address authorizer,bytes32 nonce)")
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        0x158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a1597429;

    /// authorizer => nonce => used
    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationAlreadyUsed();
    error InvalidSignature();
    error CallerMustBePayee();

    /**
     * @param initialHolder receives the entire supply — the engine wallet,
     *        which then distributes stakes to the eight agents.
     */
    constructor(uint256 totalSupply_, address initialHolder)
        ERC20("Khiana Credit", "KHIA")
        EIP712("Khiana Credit", "1")
    {
        _mint(initialHolder, totalSupply_);
    }

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    /// @notice EIP-3009. Anyone may submit; the signature authorises it.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external {
        _validate(from, nonce, validAfter, validBefore);
        _check(
            keccak256(abi.encode(
                TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce
            )),
            from,
            signature
        );
        _markUsed(from, nonce);
        _transfer(from, to, value);
    }

    /**
     * @notice As above, but only the payee may submit it.
     *
     * Front-running protection: a plain authorization can be broadcast by
     * anyone who observes it, which for a bribe means a third party could
     * settle someone else's payment at a moment of their choosing. Binding
     * the submitter to the payee closes that.
     */
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external {
        if (to != msg.sender) revert CallerMustBePayee();
        _validate(from, nonce, validAfter, validBefore);
        _check(
            keccak256(abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce
            )),
            from,
            signature
        );
        _markUsed(from, nonce);
        _transfer(from, to, value);
    }

    /// @notice Burn an unused authorization before anyone can submit it.
    function cancelAuthorization(address authorizer, bytes32 nonce, bytes memory signature) external {
        if (_authorizationStates[authorizer][nonce]) revert AuthorizationAlreadyUsed();
        _check(
            keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)),
            authorizer,
            signature
        );
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    /// @notice Powerups burn credits permanently — the pool only ever shrinks.
    function burn(uint256 value) external {
        _burn(msg.sender, value);
    }

    function burnFrom(address account, uint256 value) external {
        _spendAllowance(account, msg.sender, value);
        _burn(account, value);
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ── internals ───────────────────────────────────────────────────────────

    function _validate(address from, bytes32 nonce, uint256 validAfter, uint256 validBefore) private view {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (_authorizationStates[from][nonce]) revert AuthorizationAlreadyUsed();
    }

    function _check(bytes32 structHash, address signer, bytes memory signature) private view {
        if (ECDSA.recover(_hashTypedDataV4(structHash), signature) != signer) revert InvalidSignature();
    }

    function _markUsed(address from, bytes32 nonce) private {
        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
    }
}
