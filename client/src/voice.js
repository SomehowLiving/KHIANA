/**
 * The mascot's voice and the dialogue queue.
 *
 * Lines are spoken one at a time. Each has a priority:
 *   2 = advisor briefing (game-critical), 1 = reactions and mistakes,
 *   0 = flavour (hover, taps). Flavour is dropped rather than queued when the
 *   mascot is already talking, and anything stale is dropped before playing,
 *   so audio never overlaps and never lags behind the game.
 *
 * Audio comes from the game server's /tts (Cartesia; the key never reaches
 * the browser). On failure it falls back to the browser's speechSynthesis,
 * or to subtitles only, and says so once without blaming the player.
 */

const PREF_KEY = 'khiana:voice-prefs';
const DEFAULTS = { voice: true, textOnly: false, volume: 0.85, speed: 1, voiceKey: 'zeke', subtitles: true, browserFallback: true };

function loadPrefs() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') }; } catch { return { ...DEFAULTS }; }
}

export function createVoice({ api, mascot, onSystem } = {}) {
  const prefs = loadPrefs();
  const queue = [];
  let busy = false, current = null, lastEnd = 0, ctx = null, analyser = null, failedOnce = false;
  const COOLDOWN_MS = 450;

  function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* private mode */ } }

  function audioCtx() {
    if (ctx) return ctx;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = ctx.createAnalyser(); analyser.fftSize = 512;
      analyser.connect(ctx.destination);
    } catch { ctx = null; }
    return ctx;
  }
  const buf = new Uint8Array(256);
  function level() {
    if (!analyser) return 0.35 + Math.random() * 0.2;
    analyser.getByteTimeDomainData(buf);
    let s = 0; for (const v of buf) s += ((v - 128) / 128) ** 2;
    return Math.sqrt(s / buf.length);
  }

  async function fetchAudio(text, mood) {
    const r = await fetch(`${api}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1' },
      body: JSON.stringify({ text, mood, voice: prefs.voiceKey, speed: prefs.speed }),
    });
    if (!r.ok) throw new Error(`tts ${r.status}`);
    return URL.createObjectURL(await r.blob());
  }

  function browserSpeak(text, mood) {
    return new Promise(res => {
      if (typeof speechSynthesis === 'undefined') return res();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = prefs.speed * (mood === 'mysterious' ? 0.92 : 1);
      u.volume = prefs.volume;
      u.onend = u.onerror = () => res();
      speechSynthesis.speak(u);
      setTimeout(res, 12000);
    });
  }

  async function play(item) {
    const { text, mood, anim } = item;
    mascot?.say(prefs.subtitles || prefs.textOnly || !prefs.voice ? text : '', { anim, hold: Infinity });
    if (!prefs.subtitles && prefs.voice && !prefs.textOnly) mascot?.hideBubble();
    const readMs = Math.min(9000, 1400 + text.length * 55);

    if (!prefs.voice || prefs.textOnly) {
      mascot?.setSpeaking(false);
      await new Promise(r => setTimeout(r, readMs));
      return;
    }
    let url = null;
    try {
      url = item.url ?? await (item.pending ?? fetchAudio(text, mood));
    } catch {
      if (!failedOnce) { failedOnce = true; onSystem?.('voice'); }
      mascot?.setSpeaking(true, () => 0.3 + Math.random() * 0.2);
      if (prefs.browserFallback) await browserSpeak(text, mood);
      else await new Promise(r => setTimeout(r, readMs));
      mascot?.setSpeaking(false);
      return;
    }
    await new Promise(resolve => {
      const a = new Audio(url);
      current = a;
      a.volume = prefs.volume;
      const c = audioCtx();
      if (c) {
        try { c.resume?.(); c.createMediaElementSource(a).connect(analyser); } catch { /* already wired */ }
      }
      mascot?.setSpeaking(true, level);
      const done = () => { mascot?.setSpeaking(false); URL.revokeObjectURL(url); current = null; resolve(); };
      a.onended = done; a.onerror = done;
      a.play().catch(() => {
        // Autoplay blocked (no gesture yet): keep the subtitle up instead.
        setTimeout(done, readMs);
      });
    });
  }

  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const wait = lastEnd + COOLDOWN_MS - performance.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      queue.sort((a, b) => b.priority - a.priority || a.at - b.at);
      const item = queue.shift();
      if (performance.now() - item.at > item.ttl) continue;   // stale: drop it
      await play(item);
      lastEnd = performance.now();
    }
    busy = false;
  }

  /**
   * @param {string} text
   * @param {{mood?: string, anim?: string, priority?: 0|1|2, key?: string, ttl?: number}} o
   */
  function say(text, { mood = 'playful', anim, priority = 1, key, ttl } = {}) {
    if (!text) return;
    if (priority === 0 && (busy || queue.length)) return;              // flavour never queues
    if (key) for (let i = queue.length - 1; i >= 0; i--) if (queue[i].key === key) queue.splice(i, 1);
    const item = { text, mood, anim, priority, key, at: performance.now(), ttl: ttl ?? (priority === 2 ? 14000 : 6000) };
    // Start fetching now so the line is ready when its turn comes.
    if (prefs.voice && !prefs.textOnly) item.pending = fetchAudio(text, mood).then(u => (item.url = u), e => { throw e; });
    item.pending?.catch(() => {});
    queue.push(item);
    pump();
  }

  function stop() {
    queue.length = 0;
    if (current) { current.pause(); current.onended?.(); }
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    mascot?.setSpeaking(false);
  }

  return {
    say, stop, prefs,
    setPref(k, v) { prefs[k] = v; savePrefs(); if ((k === 'voice' && !v) || (k === 'textOnly' && v)) stop(); if (current && k === 'volume') current.volume = v; },
    async status() { try { return await (await fetch(`${api}/tts/status`, { headers: { 'ngrok-skip-browser-warning': '1' } })).json(); } catch { return { available: false, voices: [] }; } },
    unlock() { const c = audioCtx(); c?.resume?.(); },
  };
}
