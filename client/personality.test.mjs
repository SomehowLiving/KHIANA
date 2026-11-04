import { createMistakeTracker, pickLine, LINES } from './src/personality.js';

/**
 * Mascot personality: mistake escalation and dialogue variety.
 *
 *   node personality.test.mjs
 */
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
};

console.log('\nKhiana — mascot personality\n');

{
  const t = createMistakeTracker();
  const tiers = [1, 2, 3, 4, 5].map(() => t.mistake('wall').tier);
  check('repeating the same mistake escalates 1 → 4, then stays at 4', tiers.join() === '1,2,3,4,4', tiers.join());

  const moods = [1, 2, 3, 4].map(n => { const x = createMistakeTracker(); let r; for (let i = 0; i < n; i++) r = x.mistake('wall'); return r.mood; });
  check('first mistake is helpful, later ones sarcastic', moods[0] === 'helpful' && moods.slice(1).every(m => m === 'sarcastic'), moods.join());

  t.success('wall');
  check('a successful action resets that mistake', t.mistake('wall').tier === 1);

  const u = createMistakeTracker();
  u.mistake('wall'); u.mistake('wall');
  check('a different mistake type has its own count', u.mistake('flashlight-day').tier === 1);
  check('and does not reset the first', u.mistake('wall').tier === 3);

  const v = createMistakeTracker();
  const sys = v.system('network');
  check('system errors never count as player mistakes', v.mistake('wall').tier === 1 && sys.mood === 'helpful');
  const blame = /your fault|you broke|you did (this|that)|you caused|because of you|your mistake|you messed/i;
  const sysLines = Object.values(LINES.system).flat();
  check('no system error line blames the player', sysLines.every(l => !blame.test(l)), `${sysLines.length} lines checked`);

  const w = createMistakeTracker();
  const first = w.mistake('wall');
  check('every mistake comes with a line to say', typeof first.line === 'string' && first.line.length > 5, first.line);
}

{
  let prev = null, repeats = 0;
  for (let i = 0; i < 40; i++) { const l = pickLine('nightStart'); if (l === prev) repeats++; prev = l; }
  check('the same situation never says the same line twice in a row', repeats === 0, `${repeats} repeats`);
  const situations = Object.keys(LINES).length;
  const total = Object.values(LINES).flatMap(v => Array.isArray(v) ? v : Object.values(v).flat()).length;
  check('dialogue library is broad', situations >= 15 && total >= 120, `${situations} situations, ${total} lines`);
}

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length ? 1 : 0);
