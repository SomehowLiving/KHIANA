// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title RoleCommit
 * @notice Commit-reveal for team assignments.
 *
 * Roles are hashed at game start and opened at the end. This proves the host
 * did not adjust anyone's team mid-game to make the demo land better.
 *
 * Cheap to build, and every developer in the room understands why it's
 * necessary without needing it explained — which makes it worth having on
 * stage even though it's the least mechanically important of the four
 * on-chain justifications.
 */
contract RoleCommit {
    struct Game {
        bytes32 commitment;   // keccak256(abi.encode(roles, salt))
        uint64  committedAt;
        bool    revealed;
        string  roles;        // opened at game end
    }

    mapping(bytes32 => Game) public games;

    event Committed(bytes32 indexed gameId, bytes32 commitment);
    event Revealed(bytes32 indexed gameId, string roles);

    error AlreadyCommitted();
    error NoCommitment();
    error AlreadyRevealed();
    error BadReveal();

    function commit(bytes32 gameId, bytes32 commitment) external {
        if (games[gameId].committedAt != 0) revert AlreadyCommitted();
        games[gameId] = Game(commitment, uint64(block.timestamp), false, "");
        emit Committed(gameId, commitment);
    }

    function reveal(bytes32 gameId, string calldata roles, bytes32 salt) external {
        Game storage g = games[gameId];
        if (g.committedAt == 0) revert NoCommitment();
        if (g.revealed) revert AlreadyRevealed();
        if (keccak256(abi.encode(roles, salt)) != g.commitment) revert BadReveal();
        g.revealed = true;
        g.roles = roles;
        emit Revealed(gameId, roles);
    }
}
