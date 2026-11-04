import { parseEther, formatEther, keccak256, stringToHex, parseEventLogs } from 'viem';
import { CONFIG } from '../config.js';
import { POT_ABI } from './abi.js';
import { walletFor, sendContract, publicClient, explorer } from './wallets.js';

/**
 * Paid tables: real entry fees, in MON, through KhianaPot.
 *
 * Separate from the KHIA economy on purpose. KHIA is the in-game chip the
 * engine stakes and burns; it has no outside value. The pot is what players
 * actually risk — paid from their own connected wallet, held by the contract,
 * and paid to the winners minus the platform's rake.
 *
 * Unlike the agent wallets, the pot does not depend on which room holds the
 * keys, so ANY room can be a paid table as long as the server is live.
 */

/** What a player signs to claim a paid seat. The client builds the same string. */
export function joinMessage(gameId) {
  return `Join Khiana table ${gameId}`;
}

/** Paid tables need the chain and a deployed pot. */
export function potAvailable() {
  return !CONFIG.MOCK_CHAIN && Boolean(CONFIG.CHAIN.POT_ADDRESS) && Boolean(walletFor('engine'));
}

/** One pot per game: a room code is reused across games, a seed is not. */
export function potIdFor(roomCode, seed) {
  return keccak256(stringToHex(`khiana:pot:${roomCode}:${seed}`));
}

/**
 * Open a pot. Entries are refused until this lands. The deadline is the
 * latest anyone could need it — lobby wait plus a full game plus slack —
 * after which anyone may cancel and every entrant is refunded.
 */
export async function openPot(gameId, feeMon) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3 * 60 * 60);
  const res = await sendContract(walletFor('engine'), {
    address: CONFIG.CHAIN.POT_ADDRESS, abi: POT_ABI, functionName: 'open',
    args: [gameId, parseEther(String(feeMon)), deadline], gas: 150_000n,
  });
  return { ...res, url: explorer.tx(res.txHash) };
}

export async function hasEntered(gameId, address) {
  return publicClient().readContract({
    address: CONFIG.CHAIN.POT_ADDRESS, abi: POT_ABI, functionName: 'entered', args: [gameId, address],
  });
}

/** Pay out. With no winners the contract refunds every entrant minus the rake. */
export async function settlePot(gameId, winners) {
  const res = await sendContract(walletFor('engine'), {
    address: CONFIG.CHAIN.POT_ADDRESS, abi: POT_ABI, functionName: 'settle',
    args: [gameId, winners], gas: 120_000n + 60_000n * BigInt(Math.max(winners.length, 8)),
  });
  let share = null, rake = null;
  try {
    const [ev] = parseEventLogs({ abi: POT_ABI, eventName: 'Settled', logs: res.receipt.logs });
    share = Number(formatEther(ev.args.share));
    rake = Number(formatEther(ev.args.rake));
  } catch { /* status says whether it worked; the amounts are for display */ }
  return { ok: res.ok, txHash: res.txHash, url: explorer.tx(res.txHash), share, rake };
}

/** Full refunds: a paid table that never started, or was reset. */
export async function cancelPot(gameId) {
  const res = await sendContract(walletFor('engine'), {
    address: CONFIG.CHAIN.POT_ADDRESS, abi: POT_ABI, functionName: 'cancel',
    args: [gameId], gas: 120_000n + 60_000n * 8n,
  });
  return { ok: res.ok, txHash: res.txHash, url: explorer.tx(res.txHash) };
}
