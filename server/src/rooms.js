import { randomUUID } from 'crypto';

import { CONFIG } from './config.js';
import { createGame, runTick, resolveTick, movePlayer, endGame } from './game/engine.js';
import { playerView, spectatorView } from './game/fog.js';
import { gameClock, flashlightState } from './game/flashlight.js';
import { stepAllBots, claimSeat, releaseSeat, firstOpenSeat } from './agents/bots.js';
import { commitRoles } from './economy/roles.js';
import { startRecording, captureFrame, captureReveal, stopRecording, isRecording } from './recording.js';

/**
 * Room registry — many concurrent games on one server.
 *
 * The server used to hold a single module-level `game`, which meant one match
 * at a time for the whole internet. Everything that was global there is now
 * per-room state, so two lobbies cannot see or interfere with each other.
 *
 * Codes are short and human-sayable because the primary way people join is
 * someone reading it out. Ambiguous glyphs (0/O, 1/I/L) are excluded from the
 * alphabet for exactly that reason.
 */

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = Number(process.env.ROOM_CODE_LENGTH ?? 4);

// An abandoned lobby should not sit in the public list forever.
const EMPTY_ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS ?? 15 * 60_000);
const MAX_ROOMS = Number(process.env.MAX_ROOMS ?? 40);

const rooms = new Map();

function newCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  // Astronomically unlikely, but a silent collision would hand a player into
  // someone else's game.
  throw new Error('could not allocate a unique room code');
}

export function createRoom({ name, isPublic = true, seed, hostName, code: fixedCode } = {}) {
  if (rooms.size >= MAX_ROOMS) throw new Error('server is at room capacity');

  /**
   * A caller may pin the code (the main table wants "MAIN", not 4 random
   * letters). It must be honoured HERE, at registration, because the registry
   * is keyed by code: assigning room.code afterwards changes the property but
   * leaves the Map entry under the old key, and every lookup then misses.
   * That bug shipped, and surfaced as agents reporting "room MAIN not found".
   */
  const code = fixedCode ? String(fixedCode).toUpperCase() : newCode();
  if (fixedCode && rooms.has(code)) throw new Error(`room ${code} already exists`);
  const room = {
    code,
    name: (name || `${hostName ? hostName + "'s" : 'Open'} lobby`).slice(0, 40),
    isPublic: Boolean(isPublic),
    game: createGame({ seed: seed ?? Date.now() }),
    loop: null,
    sockets: new Map(),      // ws -> { role, playerId }
    seatTokens: new Map(),   // token -> playerId
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    recordingFile: null,
    broadcastTimer: null,
    /**
     * Lobby state.
     *
     * hostToken is the seat token of whoever opened the table. Only they can
     * start it. Without this the game began the instant anyone walked in, so
     * there was no window to share a code and nobody could ever join you.
     */
    hostToken: null,
    hostId: null,
    /** Bots only take over once nobody is coming. */
    autoStartAt: null,
  };
  rooms.set(code, room);
  return room;
}

export function getRoom(code) {
  return rooms.get(String(code || '').toUpperCase()) ?? null;
}

export function allRooms() {
  return [...rooms.values()];
}

/** Humans currently holding a seat (bots don't count as occupancy). */
export function humanCount(room) {
  return Object.values(room.game.players).filter(p => !p.isBot).length;
}

export function roomSummary(room) {
  const g = room.game;
  return {
    code: room.code,
    name: room.name,
    isPublic: room.isPublic,
    humans: humanCount(room),
    capacity: CONFIG.GAME.PLAYERS,
    spectators: [...room.sockets.values()].filter(m => m.role === 'spectator').length,
    started: g.started,
    phase: g.phase,
    tick: g.tick,
    totalTicks: CONFIG.GAME.TOTAL_TICKS,
    winner: g.winner,
    // Empty seats auto-fill with bots, so a game is always joinable until it
    // ends — "open" here means "you can still take a seat", not "waiting".
    joinable: !g.winner && humanCount(room) < CONFIG.GAME.PLAYERS,
    hostId: room.hostId,
    /** Seconds until bots take over, or null if a human is expected. */
    autoStartIn: room.autoStartAt ? Math.max(0, Math.round((room.autoStartAt - Date.now()) / 1000)) : null,
    createdAt: room.createdAt,
  };
}

/** Public, unfinished rooms, newest first. */
export function publicRooms() {
  return allRooms()
    .filter(r => r.isPublic && !r.game.winner)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(roomSummary);
}

// ── Sockets ─────────────────────────────────────────────────────────────────

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

export function pushState(room, ws) {
  const meta = room.sockets.get(ws);
  if (!meta) return;
  if (meta.role === 'player' && meta.playerId) {
    // Fog is applied HERE, server-side. Never send a player state they
    // shouldn't see and hide it in the renderer — devtools defeats that.
    send(ws, { type: 'STATE', view: playerView(room.game, meta.playerId) });
  } else {
    send(ws, { type: 'SPECTATE_STATE', view: spectatorView(room.game) });
  }
}

export function broadcast(room) {
  for (const ws of room.sockets.keys()) pushState(room, ws);
  if (isRecording() && room.recordingFile) captureFrame(spectatorView(room.game));
}

export function attach(room, ws, role = 'spectator') {
  room.sockets.set(ws, { role, playerId: null });
  room.lastSeenAt = Date.now();
}

export function detach(room, ws) {
  const meta = room.sockets.get(ws);
  if (meta?.playerId) releaseSeat(room.game, meta.playerId);
  room.sockets.delete(ws);
  room.lastSeenAt = Date.now();

  // If the host walks out before starting, hand the lobby to whoever is left
  // rather than leaving a table nobody is allowed to begin.
  if (meta?.playerId && meta.playerId === room.hostId && !room.game.started) {
    const remaining = [...room.sockets.values()].find(m => m.role === 'player' && m.playerId);
    if (remaining) {
      room.hostId = remaining.playerId;
      room.hostToken = [...room.seatTokens.entries()].find(([, id]) => id === remaining.playerId)?.[0] ?? null;
    } else {
      room.hostToken = null;
      room.hostId = null;
    }
  }
}

/**
 * May this token start the game?
 *
 * Plain token equality was not enough. The host slot is claimed by whoever
 * joins first, and a host who closes their tab without a clean socket close
 * leaves a GHOST HOST: a token nobody holds, which blocks every remaining
 * player from ever starting. The lobby then sits on "Starting…" forever.
 *
 * So: the real host wins, but if the recorded host has no live socket in the
 * room, anyone seated may start instead. A locked table is a worse failure
 * than the wrong person pressing go.
 */
export function isHost(room, token) {
  return Boolean(token) && token === room.hostToken;
}

/**
 * May this token start the game? ANY seated player may.
 *
 * The host label is now informational only. Gating the start on it produced a
 * class of dead lobby that a player could neither diagnose nor escape: the
 * host slot goes to whoever joins first, so a forgotten background tab, a
 * reconnect that issued a fresh token, or a stale sessionStorage entry from a
 * previous server run all left a table nobody present was allowed to begin.
 * The button sat on "Starting…" and the refusal was invisible behind the
 * lobby overlay.
 *
 * This is a party game. The cost of the wrong person pressing go is nil. The
 * cost of a table nobody can start is the entire session.
 */
export function canStart(room, token) {
  return Boolean(token) && room.seatTokens.has(token);
}

/**
 * Seat a player, resuming their previous seat when they hold a valid token.
 *
 * Reconnect-before-allocate matters on a venue network: a dropped socket hands
 * the seat back to a bot, and without the token a returning player would be
 * given whatever seat happened to be free — a different human, a different
 * team, someone else's bribes.
 */
export function seatPlayer(room, ws, { name, token, playerId } = {}) {
  const g = room.game;
  const resumedId = token && room.seatTokens.get(token);
  const seat = (resumedId && g.players[resumedId])
    ?? (playerId ? g.players[playerId] : null)
    ?? randomOpenSeat(g);

  if (!seat) return { error: 'This lobby is full.' };
  if (!seat.alive && !resumedId) return { error: 'No living seats left in this game.' };

  claimSeat(g, seat.id, name);
  room.sockets.set(ws, { role: 'player', playerId: seat.id });
  room.lastSeenAt = Date.now();

  const issued = (token && resumedId) ? token : randomUUID();
  room.seatTokens.set(issued, seat.id);

  // First human through the door owns the lobby.
  if (!room.hostToken) {
    room.hostToken = issued;
    room.hostId = seat.id;
  }

  return {
    seat, token: issued, resumed: Boolean(resumedId),
    isHost: issued === room.hostToken,
  };
}

export function movePlayerIn(room, playerId, dx, dy) {
  movePlayer(room.game, playerId, dx, dy);
  room.lastSeenAt = Date.now();
  scheduleBroadcast(room);
}

/**
 * Coalesced broadcast, ~15fps.
 *
 * Movement used to push state only to the socket that moved, so the spectator
 * board froze between ticks and positions appeared to update only on reload.
 * Broadcasting on every keypress instead would mean up to 8 players x 9 moves
 * a second x N spectators of full board serialisation, so the writes are
 * coalesced into one frame instead.
 */
const BROADCAST_MS = Number(process.env.BROADCAST_MS ?? 66);

export function scheduleBroadcast(room) {
  if (room.broadcastTimer) return;
  room.broadcastTimer = setTimeout(() => {
    room.broadcastTimer = null;
    broadcast(room);
  }, BROADCAST_MS);
  room.broadcastTimer.unref?.();
}

/**
 * A random free seat, rather than always the lowest-numbered one.
 *
 * firstOpenSeat() handed out p1 every single time, so on a given server the
 * first player to join always got p1's role. Since roles are fixed per game
 * seed, that meant testing the same room repeatedly always produced the same
 * team — it looked like role assignment was broken when in fact seat
 * assignment was deterministic.
 */
function randomOpenSeat(state) {
  const open = Object.values(state.players).filter(p => p.isBot && p.alive);
  if (!open.length) return null;
  return open[Math.floor(Math.random() * open.length)];
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

export async function startRoom(room) {
  if (room.loop) return { ok: false, error: 'Already running' };

  // Publish the role commitment BEFORE the first tick. Committing afterwards
  // would prove nothing (PRD §10.4).
  const commit = await commitRoles(room.game).catch(() => null);
  room.game.started = true;
  room.game.clockStartedAt = Date.now();   // the day/night clock runs from here

  if (process.env.RECORD === 'true' && !isRecording()) {
    room.recordingFile = startRecording({ seed: room.game.seed, room: room.code });
  }

  const step = async () => {
    await runTick(room.game, () => broadcast(room));

    // MOVE window: humans act over WebSocket, bots are stepped near the end.
    const moveWindow = Math.floor(CONFIG.GAME.TICK_MS * 0.6);
    setTimeout(() => {
      stepAllBots(room.game);
      const winner = resolveTick(room.game);
      broadcast(room);
      if (winner) finishRoom(room);
    }, moveWindow);
  };

  step();
  room.loop = setInterval(step, CONFIG.GAME.TICK_MS);

  return {
    ok: true,
    recording: room.recordingFile,
    roleCommit: commit ? { commitment: commit.commitment, txHash: commit.txHash } : null,
  };
}

export function finishRoom(room) {
  stopRoomLoop(room);
  const reveal = endGame(room.game, () => broadcast(room));
  if (isRecording() && room.recordingFile) {
    captureReveal(reveal);
    stopRecording().then(r => console.log(`  recording closed (${r.frames} frames)`));
  }
  return reveal;
}

export function stopRoomLoop(room) {
  if (room.loop) clearInterval(room.loop);
  room.loop = null;
  if (room.broadcastTimer) clearTimeout(room.broadcastTimer);
  room.broadcastTimer = null;
}

export function resetRoom(room, seed) {
  stopRoomLoop(room);
  room.game = createGame({ seed: seed ?? Date.now() });
  room.seatTokens = new Map();
  broadcast(room);
  return room;
}

export function closeRoom(code) {
  const room = rooms.get(code);
  if (!room) return false;
  stopRoomLoop(room);
  for (const ws of room.sockets.keys()) { try { ws.close(); } catch { /* already gone */ } }
  return rooms.delete(code);
}

/**
 * Reap abandoned lobbies.
 *
 * Without this the public list fills with dead rooms nobody can play in,
 * which is worse than an empty list: a player clicks three ghosts before
 * finding a real game and concludes the whole thing is broken.
 */
export function reapRooms(now = Date.now()) {
  let reaped = 0;
  for (const [code, room] of rooms) {
    const empty = room.sockets.size === 0;
    const stale = now - room.lastSeenAt > EMPTY_ROOM_TTL_MS;
    const done = room.game.winner && now - room.lastSeenAt > 60_000;
    if ((empty && stale) || done) { closeRoom(code); reaped++; }
  }
  return reaped;
}

/**
 * Bots take the table if nobody else shows up.
 *
 * The host controls the start, which is right — but a host who wanders off,
 * or a solo player who just wants to see the game, should not be stuck in an
 * empty lobby forever. After AUTO_START_MS with at least one human seated and
 * the game still not begun, it begins itself.
 */
const AUTO_START_MS = Number(process.env.AUTO_START_MS ?? 90_000);

export function tickAutoStart(now = Date.now()) {
  for (const room of rooms.values()) {
    if (room.game.started || room.game.winner) { room.autoStartAt = null; continue; }
    const humans = humanCount(room);
    if (humans === 0) { room.autoStartAt = null; continue; }

    // A full table has nobody left to wait for, so give the host only a short
    // grace period rather than the full ninety seconds.
    const wait = humans >= CONFIG.GAME.PLAYERS ? 15_000 : AUTO_START_MS;
    if (!room.autoStartAt) room.autoStartAt = now + wait;
    else if (now >= room.autoStartAt) {
      room.autoStartAt = null;
      startRoom(room).catch(() => {});
    }
  }
}

export function startAutoStarter(intervalMs = 3_000) {
  const t = setInterval(() => tickAutoStart(), intervalMs);
  t.unref?.();
  return t;
}

/**
 * Day/night watcher. State is otherwise pushed on ticks and moves; dusk, dawn
 * and a flashlight running flat happen between them, and each changes what a
 * player can see, so the room is re-sent the moment any of them flips.
 */
export function tickClocks(now = Date.now()) {
  for (const room of rooms.values()) {
    const g = room.game;
    if (!g.started || g.winner) continue;
    const sig = gameClock(g, now).phase + Object.values(g.players)
      .map(p => (flashlightState(g, p, now).on ? 1 : 0)).join('');
    if (room.lightSig !== undefined && sig !== room.lightSig) broadcast(room);
    room.lightSig = sig;
  }
}

export function startClockWatch(intervalMs = 1_000) {
  const t = setInterval(() => tickClocks(), intervalMs);
  t.unref?.();
  return t;
}

export function startReaper(intervalMs = 60_000) {
  const t = setInterval(() => reapRooms(), intervalMs);
  t.unref?.();   // never hold the process open just to garbage-collect
  return t;
}

export const constants = { CODE_ALPHABET, CODE_LENGTH, EMPTY_ROOM_TTL_MS, MAX_ROOMS };
