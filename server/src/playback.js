import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

import { CONFIG } from './config.js';
import { loadRecording, newestRecording, listRecordings } from './recording.js';

/**
 * Replay a recorded run over the live protocol.
 *
 *   npm run playback              # newest recording
 *   npm run playback -- <file>    # a specific one
 *
 * Speaks exactly the same WebSocket messages as the real server, so the
 * spectator client connects to it unmodified and cannot tell it is watching
 * a recording. That is the whole design goal: on demo night the fallback must
 * not require a different client, a different URL scheme, or a code change —
 * only a different port.
 *
 * There is no simulation here and no LLM and no chain. It cannot fail for any
 * of the reasons a live run can.
 */

const file = process.argv[2] || newestRecording();

if (!file) {
  console.error('\nNo recordings found.');
  console.error('Record one first:  RECORD=true npm start\n');
  process.exit(1);
}

const { header, frames, reveal, dropped } = loadRecording(file);

if (!frames.length) {
  console.error(`\n${file} contains no frames.\n`);
  process.exit(1);
}

const PORT = Number(process.env.PLAYBACK_PORT ?? CONFIG.PORT);
const SPEED = Number(process.env.PLAYBACK_SPEED ?? 1);
const LOOP = process.env.PLAYBACK_LOOP !== 'false';

const app = express();
app.use(cors());
app.use(express.json());
const http = createServer(app);
const wss = new WebSocketServer({ server: http });

let cursor = 0;
let latest = frames[0].view;
const sockets = new Set();

app.get('/health', (_req, res) => res.json({
  ok: true, playback: true, file, frames: frames.length,
  frame: cursor, mockChain: true, players: header?.players ?? null,
}));

// The reveal is served from the recording, so the ledger screen works too.
app.get('/game/reveal', (_req, res) => res.json(reveal ?? { winner: null, perAgent: {} }));

// Present but inert: a stray click from the operator must not 500 on stage.
app.post('/game/start', (_req, res) => res.json({ ok: false, playback: true }));
app.post('/game/new', (_req, res) => res.json({ ok: false, playback: true }));
app.get('/facilitator', (_req, res) => res.json({ ok: true, playback: true, schemes: ['recorded'] }));

wss.on('connection', ws => {
  sockets.add(ws);
  // Send the current frame immediately — a spectator joining mid-replay sees
  // the board at once instead of a blank screen until the next frame.
  send(ws, { type: 'SPECTATE_STATE', view: latest });
  ws.on('close', () => sockets.delete(ws));
  ws.on('message', () => { /* playback is read-only */ });
});

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(payload) {
  for (const ws of sockets) send(ws, payload);
}

/**
 * Drive frames on their original timing.
 *
 * Scheduling each frame off the recorded offset (rather than a fixed
 * interval) preserves the real pacing — the pauses where agents were
 * deliberating are part of what makes a run feel live.
 */
function play() {
  cursor = 0;
  const t0 = Date.now();

  const next = () => {
    if (cursor >= frames.length) {
      if (reveal) broadcast({ type: 'SPECTATE_STATE', view: { ...latest, phase: 'REVEAL' } });
      console.log(`  replay complete (${frames.length} frames)`);
      if (LOOP) setTimeout(play, 4000);
      return;
    }

    const f = frames[cursor++];
    latest = f.view;
    broadcast({ type: 'SPECTATE_STATE', view: f.view });

    const upcoming = frames[cursor];
    const delay = upcoming
      ? Math.max(0, (upcoming.at - f.at) / SPEED)
      : 1200;
    setTimeout(next, delay);
  };

  const lead = Math.max(0, (frames[0].at) / SPEED - (Date.now() - t0));
  setTimeout(next, lead);
}

http.listen(PORT, () => {
  console.log(`\nKhiana PLAYBACK :${PORT}`);
  console.log(`  file    ${file}`);
  console.log(`  frames  ${frames.length}${dropped ? `  (${dropped} unreadable line(s) skipped)` : ''}`);
  console.log(`  recorded ${header?.recordedAt ?? 'unknown'}   speed ${SPEED}x   loop ${LOOP}`);
  console.log(`  ${listRecordings().length} recording(s) available\n`);
  play();
});
