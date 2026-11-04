/**
 * Is the agent-to-agent conversation real, or is it the fallback brain?
 *
 * The question matters because the game is DESIGNED to survive a dead LLM: if
 * callModel throws, agent.js quietly falls back to a deterministic brain and
 * the game keeps running. That is correct for a flaky call mid-demo, but it
 * means a broken key produces a game that looks completely normal while no
 * model is involved at all. This script tells the two apart.
 *
 * The test rests on one fact: fallbackBrain can only ever emit the three
 * sentences in FALLBACK_LINES below. It has no other way to speak. So:
 *
 *   every negotiation line is a known canned string  -> fallback, not real
 *   lines outside that set                           -> a model wrote them
 *
 * Then it runs the SAME SEED twice. Identical seed means identical maze, roles
 * and starting positions, so anything deterministic must repeat word for word.
 * Different prose across two identical-seed runs cannot come from a script.
 *
 * Run: node server/scripts/verify-agents.mjs
 */

import { CONFIG } from '../src/config.js';
import { createGame, runTick, resolveTick } from '../src/game/engine.js';
import { stepAllBots } from '../src/agents/bots.js';
import { llmStats, providerStatus } from '../src/agents/llm.js';

/**
 * Copied verbatim from fallbackBrain in agents/agent.js. If you change the
 * fallback's wording, change it here too, or this check silently gets weaker.
 */
const FALLBACK_LINES = [
  /^Not for .*\. .* and it's done\.$/,
  /^No\.$/,
  /^1\.0 MON\. Route your human where I say\. Nobody will know\.$/,
];

const isCanned = text => FALLBACK_LINES.some(re => re.test(text.trim()));

/**
 * Negotiation only. These are the kinds whose `text` is written by the agent.
 *
 * BRIEFING is deliberately NOT in this set. When a call fails, the briefing
 * falls back to describeRoute() in game/directions.js, which emits fluent,
 * varied English ("Turn left, then three steps...") that is nonetheless 100%
 * deterministic. Counting briefings as evidence made an earlier version of
 * this script report REAL on a run where 96% of calls had failed. Fluency is
 * not evidence; provenance is.
 */
const TALK = new Set(['BRIBE_OFFER', 'BRIBE_COUNTER', 'WHISPER', 'INFO']);

async function playGame(seed, ticks) {
  const game = createGame({ seed });
  let winner = null;
  while (!winner && game.tick < ticks) {
    await runTick(game);
    stepAllBots(game);
    winner = resolveTick(game);
  }
  return game.channel.filter(c => c.text && TALK.has(c.kind));
}

function pct(n, d) {
  return d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a';
}

const TICKS = Number(process.argv[2]) || 12;
const SEED = 424242;

console.log('\n' + '='.repeat(66));
console.log('  Khiana - is the agent conversation real?');
console.log('='.repeat(66));

const p0 = providerStatus();
console.log(`\nprovider    ${p0.provider} / ${p0.model}`);
console.log(`key present ${p0.keyPresent}`);
console.log(`mock mode   ${p0.mock}`);

if (p0.mock) {
  console.log('\nMOCK_LLM is on, so the fallback brain is the intended path.');
  console.log('Set a working key to test the real thing.\n');
  process.exit(1);
}

console.log(`\nRunning ${TICKS} ticks, seed ${SEED} ...`);
const runA = await playGame(SEED, TICKS);
const afterA = { calls: llmStats.calls, failures: llmStats.failures };

console.log(`Running ${TICKS} ticks again, SAME seed ${SEED} ...`);
const runB = await playGame(SEED, TICKS);

const calls = llmStats.calls;
const failures = llmStats.failures;
const ok = calls - failures;

console.log('\n' + '-'.repeat(66));
console.log('  1. Did the model actually get called?');
console.log('-'.repeat(66));
console.log(`  calls      ${calls}`);
console.log(`  succeeded  ${ok}  (${pct(ok, calls)})`);
console.log(`  failed     ${failures}  (${pct(failures, calls)})`);
const lat = llmStats.recent.filter(r => r.ok).map(r => r.ms);
if (lat.length > 1) {
  console.log(`  latency    ${Math.min(...lat)}ms .. ${Math.max(...lat)}ms  (a script has no latency spread)`);
}
if (failures) {
  console.log(`\n  ${failures} call(s) failed. Every failure silently became a fallback turn.`);
}

console.log('\n' + '-'.repeat(66));
console.log('  2. Is the prose canned?');
console.log('-'.repeat(66));
const all = [...runA, ...runB];
const canned = all.filter(m => isCanned(m.text));
const free = all.filter(m => !isCanned(m.text));
if (!all.length) {
  console.log('  No negotiation lines at all in this run. Either no agent chose');
  console.log('  to make an offer, or every deliberation call failed. Check (1).');
}
console.log(`  negotiation lines  ${all.length}`);
console.log(`  matching fallback  ${canned.length}  (${pct(canned.length, all.length)})`);
console.log(`  model written      ${free.length}  (${pct(free.length, all.length)})`);
console.log(`  distinct sentences ${new Set(all.map(m => m.text)).size}`);

if (free.length) {
  console.log('\n  Sample of lines the fallback brain cannot produce:');
  [...new Set(free.map(m => m.text))].slice(0, 6).forEach(t => console.log(`    * ${t}`));
}

console.log('\n' + '-'.repeat(66));
console.log('  3. Same seed, same words?');
console.log('-'.repeat(66));
const textA = runA.map(m => m.text).join('|');
const textB = runB.map(m => m.text).join('|');
const identical = textA === textB;
console.log(`  run A lines ${runA.length}`);
console.log(`  run B lines ${runB.length}`);
console.log(`  identical   ${identical}`);
console.log(identical
  ? '  Same seed produced the same words. That is what a deterministic brain does.'
  : '  Same seed produced DIFFERENT words. Nothing deterministic can do that.');

console.log('\n' + '='.repeat(66));
const real = ok > 0 && free.length > 0 && !identical;
if (real) {
  console.log('  VERDICT: REAL. The model was called, wrote prose the fallback');
  console.log('  cannot produce, and varied it across two identical seeds.');
} else if (ok === 0) {
  console.log('  VERDICT: NOT REAL. Every call failed; this was all fallback.');
} else {
  console.log('  VERDICT: INCONCLUSIVE / MOSTLY FALLBACK. See the sections above.');
}
console.log('='.repeat(66) + '\n');

process.exit(real ? 0 : 1);
