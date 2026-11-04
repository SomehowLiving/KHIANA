import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CONFIG } from './config.js';

/**
 * Record a run, and play it back.
 *
 * A live multiplayer demo failing on stage is the single most likely way to
 * lose (docs/BUILD_PHASES.md, Phase 8). This is the parachute: every
 * spectator frame is written to disk as it happens, and playback replays them
 * over exactly the same WebSocket protocol the live server speaks — so the
 * spectator client cannot tell the difference and needs no playback mode of
 * its own.
 *
 * Frames are stored newline-delimited rather than as one JSON array, so a run
 * that is interrupted mid-game still produces a file that replays up to the
 * point it stopped. A truncated array would be unparseable, which is exactly
 * the wrong failure mode for a backup.
 *
 *   RECORD=true npm start          → writes recordings/<stamp>.jsonl
 *   npm run playback -- <file>     → replays it (defaults to the newest)
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RECORDINGS_DIR = process.env.RECORDINGS_DIR
  ?? path.join(HERE, '..', 'recordings');

let stream = null;
let startedAt = 0;
let frameCount = 0;

export function isRecording() {
  return Boolean(stream);
}

export function startRecording(meta = {}) {
  if (stream) return null;
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(RECORDINGS_DIR, `run-${stamp}.jsonl`);
  stream = fs.createWriteStream(file, { flags: 'a' });
  startedAt = Date.now();
  frameCount = 0;

  // Header first, so a player can restore config without guessing.
  stream.write(JSON.stringify({
    type: 'HEADER',
    version: 1,
    recordedAt: new Date().toISOString(),
    tickMs: CONFIG.GAME.TICK_MS,
    totalTicks: CONFIG.GAME.TOTAL_TICKS,
    players: CONFIG.GAME.PLAYERS,
    mockChain: CONFIG.MOCK_CHAIN,
    ...meta,
  }) + '\n');

  return file;
}

/**
 * Capture one spectator frame.
 *
 * Offsets are relative to the start of the recording, not wall-clock, so a
 * run replays at its true pace whenever it is opened.
 */
export function captureFrame(view) {
  if (!stream) return;
  frameCount++;
  stream.write(JSON.stringify({ type: 'FRAME', at: Date.now() - startedAt, view }) + '\n');
}

export function captureReveal(reveal) {
  if (!stream) return;
  stream.write(JSON.stringify({ type: 'REVEAL', at: Date.now() - startedAt, reveal }) + '\n');
}

export function stopRecording() {
  if (!stream) return null;
  const s = stream;
  stream = null;
  return new Promise(resolve => s.end(() => resolve({ frames: frameCount })));
}

// ── Playback ────────────────────────────────────────────────────────────────

export function listRecordings() {
  if (!fs.existsSync(RECORDINGS_DIR)) return [];
  return fs.readdirSync(RECORDINGS_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ file: path.join(RECORDINGS_DIR, f), mtime: fs.statSync(path.join(RECORDINGS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map(r => r.file);
}

export function newestRecording() {
  return listRecordings()[0] ?? null;
}

/**
 * Parse a recording. Tolerates a truncated final line — an interrupted run
 * should still replay everything it managed to write.
 */
export function loadRecording(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const frames = [];
  let header = null, reveal = null, dropped = 0;

  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec.type === 'HEADER') header = rec;
      else if (rec.type === 'FRAME') frames.push(rec);
      else if (rec.type === 'REVEAL') reveal = rec.reveal;
    } catch {
      dropped++;   // almost always a half-written last line
    }
  }

  return { header, frames, reveal, dropped, file };
}
