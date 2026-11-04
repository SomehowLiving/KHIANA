/**
 * Voice evaluation: generate the five reference lines with several voices,
 * then measure each clip objectively.
 *
 *   node scripts/voice-eval.mjs [outDir]
 *
 * Writes <outDir>/<voice>/<n>.wav, <outDir>/results.json and an index.html
 * with players for listening side by side. Metrics per clip:
 *
 *   latencyMs   request → full audio received (bytes endpoint)
 *   durationS   clip length
 *   wps         words per second (natural conversational speech ≈ 2.3–3.0)
 *   maxGapS     longest internal silence (unnatural pauses show up here)
 *   clipPct     share of samples at full scale (distortion)
 *   wer         word error rate of a speech-to-text round trip (pronunciation)
 *
 * The baseline is the current game voice: on Windows, Chrome's speechSynthesis
 * falls back to the installed SAPI voices, rendered here through System.Speech.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import '../src/config.js';   // loads ../../.env

const KEY = process.env.CARTESIA_API_KEY;
if (!KEY) { console.error('CARTESIA_API_KEY missing'); process.exit(1); }
const H = { 'X-API-Key': KEY, 'Cartesia-Version': '2025-04-16' };
const OUT = path.resolve(process.argv[2] ?? 'voice-eval');
fs.mkdirSync(OUT, { recursive: true });

export const LINES = [
  { text: "Welcome back. Let's see how badly you can mess this up.", emotion: 'joking/comedic' },
  { text: "Oh, it's getting dark. This should be interesting.", emotion: 'mysterious' },
  { text: "Again? I'm beginning to think you're doing this intentionally.", emotion: 'sarcastic' },
  { text: 'Well played. I wasn\'t expecting that.', emotion: 'surprised' },
  { text: "You're eliminated. I'll try not to look disappointed.", emotion: 'disappointed' },
];

const VOICES = [
  { key: 'zeke', id: 'e00d0e4c-a5c8-443f-a8a3-473eb9a62355', name: 'Zeke - Friendly Sidekick' },
  { key: 'hugo', id: '1463a4e1-56a1-4b41-b257-728d56e93605', name: 'Hugo - Teatime Friend' },
  { key: 'jasper', id: 'e98bd614-9b9d-4031-b930-ed72482af858', name: 'Jasper - Vibrant Stylist' },
  { key: 'matt', id: 'bfd3644b-d561-4b1c-a01f-d9af98cb67c0', name: 'Matt - Goofy Friend' },
  { key: 'fiona', id: 'a01c369f-6d2d-4185-bc20-b32c225eab70', name: 'Fiona - Witty Woman' },
  { key: 'wade', id: 'fbf7d2ec-ebea-49f2-8889-a482b9b0a7ed', name: 'Wade 2.0 - Storytelling Host' },
];
const MODEL = process.env.CARTESIA_MODEL ?? 'sonic-3';

async function cartesia(voiceId, text, emotion) {
  const t0 = performance.now();
  const r = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model_id: MODEL, transcript: text, language: 'en',
      voice: { mode: 'id', id: voiceId },
      generation_config: { speed: 1, volume: 1, emotion },
      output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 44100 },
    }),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return { buf, latencyMs: Math.round(performance.now() - t0) };
}

function sapi(text, file) {
  const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer;` +
    `$v = $s.GetInstalledVoices() | Where-Object { $_.Enabled } | Select-Object -First 1; $s.SelectVoice($v.VoiceInfo.Name);` +
    `$s.SetOutputToWaveFile('${file.replace(/'/g, "''")}'); $s.Speak('${text.replace(/'/g, "''")}'); $s.Dispose(); $v.VoiceInfo.Name`;
  const t0 = performance.now();
  const name = execFileSync('powershell', ['-NoProfile', '-Command', ps]).toString().trim();
  return { name, latencyMs: Math.round(performance.now() - t0) };
}

/** Minimal PCM16 WAV reader: finds the data chunk, returns mono floats. */
function readWav(buf) {
  let off = 12, fmt = null, data = null;
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { ch: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') { data = buf.subarray(off + 8, off + 8 + Math.min(size, buf.length - off - 8)); break; }
    off += 8 + size + (size % 2);
  }
  const n = Math.floor(data.length / 2 / fmt.ch), s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = data.readInt16LE(i * 2 * fmt.ch) / 32768;
  return { s, rate: fmt.rate };
}

function analyse(buf, words) {
  const { s, rate } = readWav(buf);
  const win = Math.round(rate * 0.02);
  const rms = [];
  for (let i = 0; i + win <= s.length; i += win) {
    let e = 0; for (let j = i; j < i + win; j++) e += s[j] * s[j];
    rms.push(Math.sqrt(e / win));
  }
  const peak = Math.max(...rms);
  const voiced = rms.map(v => v > peak * 0.06);
  const first = voiced.indexOf(true), last = voiced.lastIndexOf(true);
  let gap = 0, maxGap = 0;
  for (let i = first; i <= last; i++) { gap = voiced[i] ? 0 : gap + 1; maxGap = Math.max(maxGap, gap); }
  let clip = 0; for (const v of s) if (Math.abs(v) > 0.995) clip++;
  const speech = (last - first + 1) * 0.02;
  return {
    durationS: +(s.length / rate).toFixed(2),
    wps: +(words / speech).toFixed(2),
    maxGapS: +(maxGap * 0.02).toFixed(2),
    clipPct: +((clip / s.length) * 100).toFixed(3),
  };
}

async function transcribe(file) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/wav' }), path.basename(file));
  form.append('model', 'ink-whisper');
  form.append('language', 'en');
  const r = await fetch('https://api.cartesia.ai/stt', { method: 'POST', headers: H, body: form });
  if (!r.ok) return null;
  return (await r.json()).text ?? null;
}

const norm = t => t.toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/'/g, '').split(/\s+/).filter(Boolean);
function wer(ref, hyp) {
  const a = norm(ref), b = norm(hyp ?? '');
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return +(d[a.length][b.length] / a.length).toFixed(3);
}

const results = [];
const candidates = [{ key: 'baseline-sapi', name: 'Current: Windows system voice (speechSynthesis fallback)' }, ...VOICES];
for (const v of candidates) {
  const dir = path.join(OUT, v.key); fs.mkdirSync(dir, { recursive: true });
  const clips = [];
  for (const [i, line] of LINES.entries()) {
    const file = path.join(dir, `${i + 1}.wav`);
    let latencyMs, buf;
    try {
      if (v.id) { ({ buf, latencyMs } = await cartesia(v.id, line.text, line.emotion)); fs.writeFileSync(file, buf); }
      else { const r = sapi(line.text, file); latencyMs = r.latencyMs; v.name = `Current: ${r.name} (Windows SAPI)`; buf = fs.readFileSync(file); }
    } catch (e) { clips.push({ line: i + 1, error: String(e.message ?? e).slice(0, 200) }); continue; }
    const m = analyse(buf, norm(line.text).length);
    const heard = await transcribe(file);
    clips.push({ line: i + 1, latencyMs, ...m, heard, wer: wer(line.text, heard) });
  }
  const ok = clips.filter(c => !c.error);
  const avg = k => +(ok.reduce((s, c) => s + c[k], 0) / (ok.length || 1)).toFixed(3);
  results.push({ key: v.key, name: v.name, clips, summary: { latencyMs: avg('latencyMs'), wps: avg('wps'), maxGapS: Math.max(...ok.map(c => c.maxGapS)), clipPct: avg('clipPct'), wer: avg('wer'), errors: clips.length - ok.length } });
  console.log(v.key.padEnd(14), JSON.stringify(results.at(-1).summary));
}
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ model: MODEL, lines: LINES, results }, null, 2));

const rows = results.map(r => `<section><h2>${r.name}</h2><p class="m">avg latency ${r.summary.latencyMs} ms · ${r.summary.wps} words/s · longest pause ${r.summary.maxGapS}s · WER ${r.summary.wer}</p>
${r.clips.map(c => `<div class="c"><b>${c.line}.</b> ${LINES[c.line - 1].text}<br>${c.error ? `<i>${c.error}</i>` : `<audio controls preload="none" src="${r.key}/${c.line}.wav"></audio> <small>heard: “${c.heard ?? '?'}”</small>`}</div>`).join('')}</section>`).join('');
fs.writeFileSync(path.join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Khiana voice samples</title>
<style>body{font:15px system-ui;max-width:900px;margin:24px auto;padding:0 16px;background:#FFF7E6;color:#1B1F4B}section{background:#fff;border:3px solid #1B1F4B;border-radius:16px;padding:12px 16px;margin:14px 0}.c{margin:8px 0}.m{color:#464C86}audio{vertical-align:middle;height:32px}small{color:#464C86}</style>
<h1>Khiana mascot voice samples (${MODEL})</h1>${rows}`);
console.log('wrote', OUT);
