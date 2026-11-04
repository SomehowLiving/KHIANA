import crypto from 'node:crypto';

/**
 * The mascot's voice: Cartesia Sonic, proxied by the game server.
 *
 * The key lives in .env and never reaches the browser; the client asks this
 * server for a line and gets back audio. Choice of voice came from
 * scripts/voice-eval.mjs + voice-pitch.mjs (samples in docs/voice-samples):
 * the browser speechSynthesis voice it replaces measured 2.6 semitones of
 * intonation and 0.6 of mood range, i.e. flat; the candidates here are 4.6–6.2
 * and 1.8–2.2.
 *
 * Mood changes delivery (Sonic's emotion control and a small speed nudge) but
 * never the voice id, so it is one character in six moods rather than six
 * characters.
 */

const KEY = () => process.env.CARTESIA_API_KEY;
const MODEL = process.env.CARTESIA_MODEL ?? 'sonic-3';

export const VOICES = {
  zeke: { id: 'e00d0e4c-a5c8-443f-a8a3-473eb9a62355', label: 'Zeke (default): bright, quick sidekick' },
  hugo: { id: '1463a4e1-56a1-4b41-b257-728d56e93605', label: 'Hugo: drier, lower, more deadpan' },
  jasper: { id: 'e98bd614-9b9d-4031-b930-ed72482af858', label: 'Jasper: lively, most animated' },
};
const DEFAULT_VOICE = process.env.CARTESIA_VOICE_ID ? 'custom' : 'zeke';
if (process.env.CARTESIA_VOICE_ID) VOICES.custom = { id: process.env.CARTESIA_VOICE_ID, label: 'Custom (CARTESIA_VOICE_ID)' };

/** Personality mode → Sonic emotion + speed factor. */
export const MOODS = {
  helpful:      { emotion: 'content', speed: 1.0 },
  playful:      { emotion: 'joking/comedic', speed: 1.0 },
  sarcastic:    { emotion: 'sarcastic', speed: 0.96 },
  competitive:  { emotion: 'confident', speed: 1.02 },
  mysterious:   { emotion: 'mysterious', speed: 0.92 },
  celebratory:  { emotion: 'excited', speed: 1.06 },
  disappointed: { emotion: 'disappointed', speed: 0.95 },
  surprised:    { emotion: 'surprised', speed: 1.04 },
};

const MAX_CHARS = 320;
const cache = new Map();          // key -> Buffer, insertion-ordered for LRU
const inflight = new Map();       // key -> Promise<Buffer>
const CACHE_MAX = 300;

// A per-client budget, because every miss costs credits.
const buckets = new Map();
function allow(ip) {
  const now = Date.now(), b = buckets.get(ip) ?? { tokens: 40, at: now };
  b.tokens = Math.min(40, b.tokens + (now - b.at) / 1500);   // ~40/min sustained
  b.at = now;
  buckets.set(ip, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

export function ttsStatus() {
  return {
    available: Boolean(KEY()),
    provider: KEY() ? `cartesia/${MODEL}` : null,
    defaultVoice: DEFAULT_VOICE,
    voices: Object.entries(VOICES).map(([key, v]) => ({ key, label: v.label })),
    moods: Object.keys(MOODS),
  };
}

export async function synthesize({ text, mood = 'playful', voice = DEFAULT_VOICE, speed = 1 }) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
  if (!t) throw Object.assign(new Error('empty text'), { status: 400 });
  if (!KEY()) throw Object.assign(new Error('voice provider not configured'), { status: 503 });
  const v = VOICES[voice] ?? VOICES[DEFAULT_VOICE];
  const m = MOODS[mood] ?? MOODS.playful;
  const s = Math.min(1.4, Math.max(0.7, Number(speed) || 1)) * m.speed;

  const key = crypto.createHash('sha1').update(`${MODEL}|${v.id}|${m.emotion}|${s.toFixed(2)}|${t}`).digest('hex');
  if (cache.has(key)) { const b = cache.get(key); cache.delete(key); cache.set(key, b); return b; }
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    const r = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: { 'X-API-Key': KEY(), 'Cartesia-Version': '2025-04-16', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_id: MODEL, transcript: t, language: 'en',
        voice: { mode: 'id', id: v.id },
        generation_config: { speed: +s.toFixed(2), volume: 1, emotion: m.emotion },
        output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw Object.assign(new Error(`provider ${r.status}`), { status: 502 });
    const buf = Buffer.from(await r.arrayBuffer());
    cache.set(key, buf);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return buf;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** Express wiring: POST /tts → audio/mpeg, GET /tts/status. */
export function mountTts(app) {
  app.get('/tts/status', (_req, res) => res.json(ttsStatus()));
  app.post('/tts', async (req, res) => {
    if (!allow(req.ip ?? 'x')) return res.status(429).json({ error: 'Too many voice lines, slow down.' });
    try {
      const buf = await synthesize(req.body ?? {});
      res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=86400' }).send(buf);
    } catch (e) {
      // Never forward provider detail (it can include account info).
      res.status(e.status ?? 500).json({ error: e.status === 400 ? 'Nothing to say.' : 'Voice unavailable.' });
    }
  });
}
