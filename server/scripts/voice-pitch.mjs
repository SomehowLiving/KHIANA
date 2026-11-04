// Pitch (F0) analysis of the voice-eval clips: autocorrelation per 40ms frame.
// Reports intonation range within lines (expressiveness) and spread of the
// per-line median across lines (mood range), plus overall median (identity).
import fs from 'node:fs'; import path from 'node:path';
const DIR = path.resolve(process.argv[2] ?? 'voice-eval');
function readWav(buf) {
  let off = 12, fmt, data;
  while (off < buf.length - 8) { const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { ch: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12) };
    if (id === 'data') { data = buf.subarray(off + 8, off + 8 + Math.min(size, buf.length - off - 8)); break; }
    off += 8 + size + (size % 2); }
  const n = Math.floor(data.length / 2 / fmt.ch), s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = data.readInt16LE(i * 2 * fmt.ch) / 32768;
  return { s, rate: fmt.rate };
}
function f0s({ s, rate }) {
  const W = Math.round(rate * 0.04), out = [];
  const minL = Math.floor(rate / 450), maxL = Math.ceil(rate / 70);
  let peak = 0; for (const v of s) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i + W + maxL < s.length; i += Math.round(W / 2)) {
    let e = 0; for (let j = 0; j < W; j++) e += s[i + j] ** 2;
    if (Math.sqrt(e / W) < peak * 0.05) continue;
    let best = 0, bl = 0;
    for (let L = minL; L <= maxL; L++) { let c = 0; for (let j = 0; j < W; j++) c += s[i + j] * s[i + j + L]; if (c > best) { best = c; bl = L; } }
    if (best / e > 0.5) out.push(rate / bl);
  }
  return out;
}
const st = f => 12 * Math.log2(f / 100);
const med = a => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const sd = a => { const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
const res = JSON.parse(fs.readFileSync(path.join(DIR, 'results.json')));
for (const r of res.results) {
  const lines = [1, 2, 3, 4, 5].map(n => f0s(readWav(fs.readFileSync(path.join(DIR, r.key, `${n}.wav`)))).map(st));
  const within = lines.map(sd), medians = lines.map(med);
  r.pitch = { medianHz: Math.round(100 * 2 ** (med(lines.flat()) / 12)), intonationSt: +(within.reduce((a, b) => a + b, 0) / 5).toFixed(2), moodRangeSt: +sd(medians).toFixed(2) };
  console.log(r.key.padEnd(14), JSON.stringify(r.pitch));
}
fs.writeFileSync(path.join(DIR, 'results.json'), JSON.stringify(res, null, 2));
