import { keccak256, encodeAbiParameters, parseAbiParameters, toHex, stringToHex } from 'viem';
import { randomBytes } from 'crypto';

import { CONFIG } from '../config.js';
import { walletFor, sendContract, publicClient, explorer } from './wallets.js';
import { COMMIT_ABI } from './abi.js';

/**
 * Commit-reveal for team assignments (PRD §10.4).
 *
 * Roles are hashed and published on chain before the first tick, and opened
 * at the end. That proves the host did not move somebody onto the Saboteur
 * team mid-game to make the demo land better.
 *
 * It is the least mechanically important of the four on-chain justifications
 * and the easiest for a room of developers to verify at a glance, which is
 * exactly why it earns its place on stage: nobody needs it explained.
 *
 * The salt is held in memory only until the reveal. Publishing the commitment
 * without keeping the salt secret would prove nothing at all — anyone could
 * brute-force eight role assignments in milliseconds.
 */

/** Canonical roles payload. Sorted so the same assignment always hashes alike. */
export function serialiseRoles(state) {
  const roles = Object.values(state.players)
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
    .map(p => `${p.id}:${p.team}`)
    .join(',');
  return roles;
}

/** keccak256(abi.encode(string roles, bytes32 salt)) — must match RoleCommit.sol. */
export function commitmentFor(roles, salt) {
  return keccak256(encodeAbiParameters(parseAbiParameters('string, bytes32'), [roles, salt]));
}

/** Stable game id from the seed, so a replay of the same seed is traceable. */
export function gameIdFor(seed) {
  return keccak256(stringToHex(`khiana:${seed}`));
}

/**
 * Publish the commitment. Called once, before the first tick.
 * Never throws — a settlement hiccup must not stop a game from starting.
 */
export async function commitRoles(state) {
  const roles = serialiseRoles(state);
  const salt = `0x${randomBytes(32).toString('hex')}`;
  const commitment = commitmentFor(roles, salt);
  const gameId = gameIdFor(state.seed);

  // Held server-side and never sent to any client until the reveal.
  state.roleCommit = { gameId, commitment, salt, roles, txHash: null, revealed: false };
  state.roleCommitHash = commitment;

  if (CONFIG.MOCK_CHAIN || !CONFIG.CHAIN.COMMIT_ADDRESS) {
    state.roleCommit.mocked = true;
    return state.roleCommit;
  }

  try {
    const engine = walletFor('engine');
    if (!engine) return state.roleCommit;
    const res = await sendContract(engine, {
      address: CONFIG.CHAIN.COMMIT_ADDRESS,
      abi: COMMIT_ABI,
      functionName: 'commit',
      args: [gameId, commitment],
      gas: 120_000n,
    });
    state.roleCommit.txHash = res.txHash;
  } catch (err) {
    state.roleCommit.error = String(err?.shortMessage ?? err);
  }
  return state.roleCommit;
}

/**
 * Open the commitment at game end. The salt goes on chain here, which is what
 * lets anyone recompute the hash and check it against what was published
 * before a single move was made.
 */
export async function revealRoles(state) {
  const rc = state.roleCommit;
  if (!rc || rc.revealed) return rc ?? null;

  rc.revealed = true;
  rc.verified = commitmentFor(rc.roles, rc.salt) === rc.commitment;

  if (CONFIG.MOCK_CHAIN || !CONFIG.CHAIN.COMMIT_ADDRESS) return rc;

  try {
    const engine = walletFor('engine');
    if (!engine) return rc;
    const res = await sendContract(engine, {
      address: CONFIG.CHAIN.COMMIT_ADDRESS,
      abi: COMMIT_ABI,
      functionName: 'reveal',
      args: [rc.gameId, rc.roles, rc.salt],
      gas: 200_000n,
    });
    rc.revealTxHash = res.txHash;
  } catch (err) {
    rc.revealError = String(err?.shortMessage ?? err);
  }
  return rc;
}

/** Audience-facing summary. Safe to send only AFTER the reveal. */
export function roleCommitSummary(state) {
  const rc = state.roleCommit;
  if (!rc) return null;
  return {
    gameId: rc.gameId,
    commitment: rc.commitment,
    committedTx: rc.txHash,
    committedUrl: rc.txHash ? explorer.tx(rc.txHash) : null,
    mocked: Boolean(rc.mocked),
    // Salt and roles are withheld until the reveal — publishing them early
    // would let a spectator read every team before the game even starts.
    ...(rc.revealed ? {
      revealed: true,
      roles: rc.roles,
      salt: rc.salt,
      verified: rc.verified,
      revealTx: rc.revealTxHash ?? null,
      revealUrl: rc.revealTxHash ? explorer.tx(rc.revealTxHash) : null,
    } : { revealed: false }),
  };
}
