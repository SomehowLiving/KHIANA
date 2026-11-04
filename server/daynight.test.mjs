import { CONFIG } from './src/config.js';
import { clockFor } from './src/game/clock.js';
import { createGame } from './src/game/engine.js';
import { playerView, spectatorView } from './src/game/fog.js';
import { setFlashlight } from './src/game/flashlight.js';

/**
 * Day/night and flashlight rules.
 *
 *   node daynight.test.mjs
 *
 * Seams: the game clock (clockFor) and the player's state view (playerView,
 * setFlashlight). Lighting visuals are checked in the browser, not here.
 */

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
};
const section = t => console.log(`\n${t}`);

console.log('\nKhiana — day/night and flashlight\n');

// ── Clock ───────────────────────────────────────────────────────────────────
section('Game clock');
{
  // A 24-minute day makes one game hour exactly one real minute.
  const cfg = { cycleMs: 24 * 60_000, startHour: 9 };
  const T = 1_000_000;
  const at = min => clockFor({ startedAt: T, now: T + min * 60_000, ...cfg });

  const start = at(0);
  check('starts at the configured hour', start.time === '09:00', start.time);
  check('09:00 is day', start.phase === 'DAY');
  check('12:00 is full daylight', at(3).daylight === 1, String(at(3).daylight));

  check('18:00 is night', at(9).phase === 'NIGHT', `${at(9).time} ${at(9).phase}`);
  check('17:59 is still day', at(8.99).phase === 'DAY', at(8.99).time);
  check('03:00 is fully dark', at(18).daylight === 0, `${at(18).time} ${at(18).daylight}`);
  check('06:00 is day again', at(21).phase === 'DAY', at(21).time);
  check('wraps past midnight', at(15).time === '00:00', at(15).time);

  const dusk = at(9).daylight;
  check('dusk is a gradual transition, not a switch', dusk > 0 && dusk < 1, String(dusk));
  check('light falls through the evening',
    at(8).daylight > at(9).daylight && at(9).daylight > at(10).daylight,
    [8, 9, 10].map(h => at(h).daylight.toFixed(2)).join(' > '));

  const frozen = clockFor({ startedAt: null, now: T, ...cfg });
  check('clock holds at the start hour before the game starts', frozen.time === '09:00' && frozen.running === false);
}

// ── Night sight ─────────────────────────────────────────────────────────────
const T0 = 5_000_000;
const cyc = CONFIG.DAY.CYCLE_MS;
/** Real time at which the started game's clock reads `hour`. */
const timeAt = hour => T0 + (((hour - CONFIG.DAY.START_HOUR) + 24) % 24) / 24 * cyc;
const started = () => { const g = createGame({ seed: 7 }); g.started = true; g.clockStartedAt = T0; return g; };
const cheb = (a, k) => { const [x, y] = k.split(',').map(Number); return Math.max(Math.abs(x - a.x), Math.abs(y - a.y)); };

section('Night sight (server-side)');
{
  const g = started();
  const me = Object.values(g.players)[0];
  const day = playerView(g, me.id, timeAt(12));
  const night = playerView(g, me.id, timeAt(22));
  check('view carries the clock', day.clock?.phase === 'DAY' && night.clock?.phase === 'NIGHT');
  check('night shows fewer tiles than day', night.visible.length < day.visible.length,
    `${day.visible.length} → ${night.visible.length}`);
  check('without a flashlight, night sight is only the adjacent tiles',
    night.visible.every(k => cheb(me.pos, k) <= CONFIG.DAY.NIGHT_VISION_RADIUS),
    `max ${Math.max(...night.visible.map(k => cheb(me.pos, k)))}`);
  check('spectators get the clock too', spectatorView(g, timeAt(22)).clock?.phase === 'NIGHT');
}

// ── Flashlight ──────────────────────────────────────────────────────────────
section('Flashlight (server-authoritative)');
{
  const g = started();
  const me = Object.values(g.players)[0];
  // Face down the longest open corridor from spawn, so the beam has room.
  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const runLen = ([dx, dy]) => { let i = 0; while (g.maze.tiles[me.pos.y + dy * (i + 1)]?.[me.pos.x + dx * (i + 1)] === 0) i++; return i; };
  const lens = DIRS.map(runLen);
  me.facing = lens.indexOf(Math.max(...lens));
  const [fx, fy] = DIRS[me.facing];

  check('refused in daytime', setFlashlight(g, me.id, true, timeAt(12)).reason === 'DAY');

  const night = timeAt(22);
  const before = playerView(g, me.id, night);
  check('switches on at night', setFlashlight(g, me.id, true, night).ok === true);
  const lit = playerView(g, me.id, night);
  check('view reports it on', lit.flashlight.on === true && lit.flashlight.available === true);
  const ahead = k => { const [x, y] = k.split(',').map(Number); return (x - me.pos.x) * fx + (y - me.pos.y) * fy; };
  const far = lit.visible.filter(k => cheb(me.pos, k) > 1);
  check('beam reveals tiles down the facing corridor', far.length > 0 && lit.visible.length > before.visible.length,
    `${before.visible.length} → ${lit.visible.length} tiles, corridor ${Math.max(...lens)} long`);
  check('beam reveals nothing beyond 1 tile in other directions', far.every(k => ahead(k) > 0));

  const later = playerView(g, me.id, night + 30_000);
  check('battery drains while on', later.flashlight.battery < 100 && later.flashlight.battery > 0, String(later.flashlight.battery));
  const flat = playerView(g, me.id, night + 5 * 60_000);
  check('an empty battery switches it off', flat.flashlight.on === false && flat.flashlight.battery === 0);
  check('cannot restart on an empty battery', setFlashlight(g, me.id, true, night + 5 * 60_000).reason === 'EMPTY');
  const rested = playerView(g, me.id, night + 5 * 60_000 + 30_000);
  check('recharges while off', rested.flashlight.battery > 0, String(rested.flashlight.battery));

  const g2 = started(); const p2 = Object.values(g2.players)[1];
  setFlashlight(g2, p2.id, true, night);
  const dawn = playerView(g2, p2.id, timeAt(6.5));
  check('goes out at dawn', dawn.flashlight.on === false && dawn.flashlight.available === false);

  const g3 = started(); const p3 = Object.values(g3.players)[2];
  setFlashlight(g3, p3.id, true, night);
  p3.alive = false;
  check('goes out when the player is eliminated', playerView(g3, p3.id, night + 1000).flashlight.on === false);
  check('eliminated players cannot switch it on', setFlashlight(g3, p3.id, true, night + 2000).reason === 'DEAD');
  check('unknown seats (spectators) are refused', setFlashlight(g3, 'nobody', true, night).reason === 'NO_SEAT');
}

// ── Summary ─────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) for (const f of failed) console.log(`  ✗ ${f.name}  ${f.detail}`);
console.log('');
process.exit(failed.length ? 1 : 0);
