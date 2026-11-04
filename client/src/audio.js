/**
 * Voice and sound.
 *
 * Two deliberate constraints shape this file:
 *
 *  1. NO audio files. Every sound is synthesised. A maze game that ships 2MB
 *     of samples loads slowly on venue wifi, and procedural audio gives
 *     infinite variation from tiny memory.
 *
 *  2. NO speech API key. Briefings are spoken through the browser's built-in
 *     speechSynthesis. It costs nothing, needs no network round trip, and
 *     works offline — which matters because the advisor's voice is the most
 *     important channel in the game and must never depend on a third party.
 *
 * Browsers block audio until a user gesture, so nothing initialises until
 * unlock() is called from a real click.
 *
 * Levels follow the standard for non-diegetic game feedback: roughly -18 to
 * -24 dB. Anything louder becomes fatiguing inside a ten-minute round.
 */

let ctx = null;
let master = null;
let unlocked = false;

const prefs = { sfx: true, voice: true, volume: 0.5 };

export function isUnlocked() { return unlocked; }
export function getPrefs() { return { ...prefs }; }

export function setPref(key, value) {
  if (!(key in prefs)) return;
  prefs[key] = value;
  if (key === 'volume' && master) master.gain.value = value;
  if (key === 'voice' && !value) speechSynthesis.cancel();
  try { localStorage.setItem('khiana:audio', JSON.stringify(prefs)); } catch { /* private mode */ }
}

try {
  const saved = JSON.parse(localStorage.getItem('khiana:audio') ?? 'null');
  if (saved) Object.assign(prefs, saved);
} catch { /* ignore */ }

/** Must be called from a user gesture. Safe to call repeatedly. */
export function unlock() {
  if (unlocked) return;
  const AC = window.AudioContext ?? window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = prefs.volume;
  master.connect(ctx.destination);
  ctx.resume?.();
  unlocked = true;
}

// ── Synthesis primitives ────────────────────────────────────────────────────

function env(node, { attack = 0.005, decay = 0.18, peak = 1 } = {}) {
  const g = ctx.createGain();
  const t = ctx.currentTime;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  // Exponential ramps cannot reach 0, so land just above it and stop the node.
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  node.connect(g);
  g.connect(master);
  return { gain: g, stopAt: t + attack + decay + 0.02 };
}

function tone(freq, { type = 'sine', attack, decay, peak, slideTo } = {}) {
  if (!unlocked || !prefs.sfx) return;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, ctx.currentTime);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + (decay ?? 0.18));
  const { stopAt } = env(o, { attack, decay, peak });
  o.start();
  o.stop(stopAt);
}

function noise({ decay = 0.2, peak = 0.5, filter = 1200, type = 'lowpass' } = {}) {
  if (!unlocked || !prefs.sfx) return;
  const len = Math.max(1, Math.floor(ctx.sampleRate * decay));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bq = ctx.createBiquadFilter();
  bq.type = type;
  bq.frequency.value = filter;
  src.connect(bq);
  const { stopAt } = env(bq, { decay, peak });
  src.start();
  src.stop(stopAt);
}

// ── Cues ────────────────────────────────────────────────────────────────────

/**
 * Each cue maps to something the player must notice WITHOUT looking away from
 * the maze. If a sound does not carry information you would otherwise have to
 * read, it is noise and it does not belong here.
 */
export const sfx = {
  /** Tick boundary. Dry and short — a clock, not a chime. */
  tick: () => tone(760, { type: 'square', decay: 0.045, peak: 0.035 }),

  /** New briefing. Two notes rising: "listen". */
  briefing: () => {
    tone(520, { type: 'triangle', decay: 0.09, peak: 0.06 });
    setTimeout(() => tone(700, { type: 'triangle', decay: 0.12, peak: 0.06 }), 90);
  },

  /** Footstep. Randomised so repeated steps never sound mechanical. */
  step: () => noise({ decay: 0.07, peak: 0.035 + Math.random() * 0.02, filter: 420 + Math.random() * 320 }),

  /** Blocked by a wall. Dull and unsatisfying, deliberately. */
  bump: () => noise({ decay: 0.09, peak: 0.05, filter: 200 }),

  /** Money moved. The one sound allowed to feel good. */
  bribe: () => {
    tone(1180, { type: 'sine', decay: 0.09, peak: 0.05 });
    setTimeout(() => tone(1560, { type: 'sine', decay: 0.15, peak: 0.042 }), 70);
  },

  /** Task completed. */
  task: () => {
    tone(660, { type: 'triangle', decay: 0.15, peak: 0.055 });
    setTimeout(() => tone(830, { type: 'triangle', decay: 0.2, peak: 0.055 }), 110);
  },

  /** Someone died. Low, wrong, and over quickly. */
  elimination: () => {
    tone(300, { type: 'sawtooth', decay: 0.5, peak: 0.07, slideTo: 68 });
    noise({ decay: 0.36, peak: 0.07, filter: 170 });
  },

  /** Extraction opened. The only hopeful sound in the game. */
  exitOpen: () => {
    [523, 659, 784, 1047].forEach((f, i) =>
      setTimeout(() => tone(f, { type: 'sine', decay: 0.4, peak: 0.05 }), i * 110));
  },

  powerup: () => tone(420, { type: 'square', decay: 0.2, peak: 0.045, slideTo: 1250 }),

  gameOver: () => tone(200, { type: 'sawtooth', decay: 1.0, peak: 0.075, slideTo: 55 }),

  /** The game begins. Descending minor: nothing good is about to happen. */
  gameStart: () => {
    [784, 622, 523, 392].forEach((f, i) =>
      setTimeout(() => tone(f, { type: 'triangle', decay: 0.45, peak: 0.06 }), i * 165));
    setTimeout(() => {
      tone(98, { type: 'sine', decay: 1.6, peak: 0.07 });
      noise({ decay: 1.0, peak: 0.045, filter: 260 });
    }, 640);
  },

  /** Another human takes a seat. */
  join: () => tone(180, { type: 'sine', decay: 0.22, peak: 0.05, slideTo: 300 }),
};

// ── Ambience ────────────────────────────────────────────────────────────────

let ambience = null;

/**
 * A generated reverb tail.
 *
 * Exponentially-decaying noise is a serviceable impulse response, and running
 * the sparse events through it is what makes them sound like they happened
 * somewhere ELSE in the maze rather than beside your ear. Distance is most of
 * what makes a sound frightening.
 */
function makeImpulse(seconds = 3.2, decay = 3.0) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

/**
 * The bed.
 *
 * The previous version was a constant sawtooth drone at a fixed level, which
 * is the textbook recipe for FAN NOISE: unchanging amplitude, unchanging
 * spectrum, always present. Nothing about it was frightening because nothing
 * about it ever changed, and the ear stops hearing that within seconds.
 *
 * This is built the opposite way:
 *
 *   RUMBLE  very low, very quiet, always breathing. Two LFOs at unrelated
 *           rates so the swell never becomes a pattern you can predict.
 *           Sine waves, not sawtooth — no buzz, nothing to whine.
 *   ROOM    a long reverb tail everything is fed through, so the maze sounds
 *           large and you sound alone in it.
 *   EVENTS  sparse and random: distant drips, structural creaks, the
 *           occasional breath, with 7-22 second gaps.
 *
 * The SILENCE is the effect. The events exist only to stop you getting used
 * to it. You should not notice any of this until it stops.
 */
export function startAmbience() {
  if (!unlocked || ambience) return;

  const bus = ctx.createGain();
  bus.gain.value = 0.0001;
  bus.connect(master);

  const room = ctx.createConvolver();
  room.buffer = makeImpulse();
  const roomGain = ctx.createGain();
  roomGain.gain.value = 0.9;
  room.connect(roomGain);
  roomGain.connect(bus);

  // Rumble: felt rather than heard.
  const rumble = ctx.createGain();
  rumble.gain.value = 0.05;
  rumble.connect(bus);

  const rlp = ctx.createBiquadFilter();
  rlp.type = 'lowpass';
  rlp.frequency.value = 170;
  rlp.Q.value = 0.4;
  rlp.connect(rumble);

  const rumbleOscs = [48, 61.7].map(f => {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    o.connect(rlp);
    o.start();
    return o;
  });

  const breathers = [[0.037, 0.028], [0.021, 0.020]].map(([rate, depth]) => {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = rate;
    const amt = ctx.createGain();
    amt.gain.value = depth;
    lfo.connect(amt);
    amt.connect(rumble.gain);
    lfo.start();
    return lfo;
  });

  ambience = { bus, room, rumble, rlp, rumbleOscs, breathers, tension: 0, timer: null, stopped: false };
  scheduleEvent();

  // Long fade, so it arrives without announcing itself.
  bus.gain.setValueAtTime(0.0001, ctx.currentTime);
  bus.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 6);
}

/** One sparse, distant, deliberately unidentifiable event. */
function spookyEvent() {
  if (!ambience || ambience.stopped || !prefs.sfx) return;
  const t = ambience.tension;
  const room = ambience.room;
  const now = ctx.currentTime;

  const send = (node, gain) => {
    const g = ctx.createGain();
    g.gain.value = gain;
    node.connect(g);
    g.connect(room);
    return g;
  };

  const pick = Math.random();

  if (pick < 0.34) {
    // Drip: high sine with a fast pitch drop. Water on stone.
    const o = ctx.createOscillator();
    o.type = 'sine';
    const f = 900 + Math.random() * 900;
    o.frequency.setValueAtTime(f, now);
    o.frequency.exponentialRampToValueAtTime(f * 0.45, now + 0.09);
    const g = send(o, 0.0001);
    g.gain.exponentialRampToValueAtTime(0.05, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    o.start(); o.stop(now + 0.34);

  } else if (pick < 0.68) {
    // Creak: narrow bandpass sweep over noise. Structural, unplaceable.
    const len = Math.floor(ctx.sampleRate * 1.0);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 14;
    const f0 = 300 + Math.random() * 500;
    bp.frequency.setValueAtTime(f0, now);
    bp.frequency.linearRampToValueAtTime(f0 * (Math.random() < 0.5 ? 1.7 : 0.6), now + 0.8);
    src.connect(bp);
    const g = send(bp, 0.0001);
    g.gain.exponentialRampToValueAtTime(0.035 + t * 0.03, now + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.95);
    src.start(); src.stop(now + 1.0);

  } else {
    // Breath: filtered noise swell. The one that makes people turn around.
    const len = Math.floor(ctx.sampleRate * 1.6);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.6;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 480 + Math.random() * 260;
    bp.Q.value = 1.6;
    src.connect(bp);
    const g = send(bp, 0.0001);
    g.gain.exponentialRampToValueAtTime(0.03 + t * 0.035, now + 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 1.5);
    src.start(); src.stop(now + 1.6);
  }
}

/** Gaps shrink as tension rises: the maze gets busier as it gets worse. */
function scheduleEvent() {
  if (!ambience || ambience.stopped) return;
  const t = ambience.tension;
  const min = 7000 - t * 4200;
  const spread = 15000 - t * 9000;
  ambience.timer = setTimeout(() => { spookyEvent(); scheduleEvent(); }, min + Math.random() * spread);
}

/**
 * 0 = calm, 1 = someone is about to die.
 * Opens the rumble slightly and makes events more frequent, rather than
 * simply turning everything up.
 */
export function setTension(t) {
  if (!ambience) return;
  const v = Math.max(0, Math.min(1, t));
  if (Math.abs(v - ambience.tension) < 0.02) return;
  ambience.tension = v;
  const now = ctx.currentTime;
  ambience.rlp.frequency.setTargetAtTime(165 + v * 130, now, 3);
  ambience.rumble.gain.setTargetAtTime(0.05 + v * 0.05, now, 3);
}

/**
 * Peak level reaching the output, 0..1.
 *
 * Exists because "I cannot hear it" and "it is not playing" are different
 * failures with the same symptom, and only a meter tells them apart.
 */
let meter = null;
export function outputLevel() {
  if (!unlocked) return null;
  if (!meter) {
    meter = ctx.createAnalyser();
    meter.fftSize = 2048;
    master.connect(meter);            // tap, not inserted in the path
  }
  const buf = new Float32Array(meter.fftSize);
  meter.getFloatTimeDomainData(buf);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
  return peak;
}

export function stopAmbience() {
  if (!ambience) return;
  ambience.stopped = true;
  clearTimeout(ambience.timer);
  const { bus, rumbleOscs, breathers } = ambience;
  bus.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.8);
  setTimeout(() => {
    [...rumbleOscs, ...breathers].forEach(o => { try { o.stop(); } catch { /* already stopped */ } });
  }, 3000);
  ambience = null;
}

// ── The advisor's voice ─────────────────────────────────────────────────────

let chosenVoice = null;

/**
 * Pick a voice once and keep it. A different voice every tick destroys the
 * illusion that one entity is advising you, which is the entire premise.
 */
function pickVoice() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  const prefer = [
    v => /Google UK English Male/i.test(v.name),
    v => /Google US English/i.test(v.name),
    v => /Microsoft (Guy|Ryan|Christopher)/i.test(v.name),
    v => /Daniel|Alex/i.test(v.name),
    v => v.lang?.startsWith('en'),
  ];
  for (const test of prefer) {
    const hit = voices.find(test);
    if (hit) return hit;
  }
  return voices[0];
}

if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.addEventListener?.('voiceschanged', () => { chosenVoice = pickVoice(); });
  chosenVoice = pickVoice();
}

/**
 * Speak a briefing.
 *
 * `corrupted` does NOT change the wording — that would hand the player the
 * answer and collapse the game. It nudges rate and pitch a fraction, at most
 * subliminally. The point is that a bought advisor sounds exactly like an
 * honest one.
 */
export function speak(text, { corrupted = false } = {}) {
  if (!prefs.voice || !text || typeof speechSynthesis === 'undefined') return;

  // Barge-in: the newest instruction is the only one that matters. A queue
  // would leave the advisor reading stale directions two ticks later.
  speechSynthesis.cancel();

  const u = new SpeechSynthesisUtterance(String(text));
  if (chosenVoice) u.voice = chosenVoice;
  u.rate = corrupted ? 1.04 : 1.0;
  u.pitch = corrupted ? 0.97 : 1.0;
  u.volume = Math.min(1, prefs.volume + 0.35);
  speechSynthesis.speak(u);
  return u;
}

export function stopSpeaking() {
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
}
