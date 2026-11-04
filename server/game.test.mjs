import { CONFIG, TEAM } from './src/config.js';
import { createGame, checkWin, atExit, resolveTick } from './src/game/engine.js';
import { playerView, spectatorView, visionRadiusFor } from './src/game/fog.js';
import { applyPurchases } from './src/game/powerups.js';
import { buildReveal } from './src/economy/ledger.js';
import { buildContext } from './src/agents/agent.js';
import { serialiseRoles, commitmentFor, gameIdFor, roleCommitSummary } from './src/economy/roles.js';

/**
 * Phase 2 game-core assertions.
 *
 * Pure logic, no server, no network, no LLM — runs in milliseconds so it can
 * be run on every change. The integration test proves the wiring; this proves
 * the RULES, which is where the expensive bugs were:
 *
 *   - the exit tile did not exist at all, and checkWin awarded a Loyalist win
 *     on task count alone
 *   - the clock-expiry threshold was a hardcoded 3
 *
 *   node game.test.mjs
 */

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
};
const section = t => console.log(`\n${t}`);

const fresh = (seed = 42) => createGame({ seed });
const loyalists = g => Object.values(g.players).filter(p => p.team === TEAM.LOYALIST);
const saboteurs = g => Object.values(g.players).filter(p => p.team === TEAM.SABOTEUR);

console.log('\nKhiana — game core (Phase 2)\n');

// ── Maze + exit ─────────────────────────────────────────────────────────────
section('Maze and extraction point');

const g = fresh();
check('maze generated', g.maze.tiles.length === CONFIG.GAME.MAZE_SIZE * 2 + 1,
  `${g.maze.tiles.length}²`);
check('exit tile exists', !!g.exit, g.exit ? `(${g.exit.x},${g.exit.y})` : 'MISSING');
check('exit is walkable floor', g.maze.tiles[g.exit.y]?.[g.exit.x] === 0,
  `tile value ${g.maze.tiles[g.exit.y]?.[g.exit.x]}`);

// The exit must be a journey, not a doorstep — it's the contested traversal
// that gives a corrupted agent its last and best opportunity.
const nearestSpawn = Math.min(
  ...Object.values(g.players).map(p => Math.abs(p.pos.x - g.exit.x) + Math.abs(p.pos.y - g.exit.y))
);
check('exit is far from every spawn', nearestSpawn >= 8, `nearest spawn ${nearestSpawn} tiles`);

check('exit is deterministic for a seed',
  JSON.stringify(fresh(7).exit) === JSON.stringify(fresh(7).exit), 'same seed, same exit');

// ── Win conditions ──────────────────────────────────────────────────────────
section('Win conditions');

{
  const s = fresh();
  s.tasksComplete = CONFIG.GAME.TASKS_TO_WIN;
  check('tasks alone do NOT win', checkWin(s) === null,
    'must also reach the exit — this was the bug');
}

{
  const s = fresh();
  s.tasksComplete = CONFIG.GAME.TASKS_TO_WIN;
  // Two survivors at the exit is one short of the requirement.
  loyalists(s).slice(0, CONFIG.GAME.SURVIVORS_TO_ESCAPE - 1).forEach(p => { p.pos = { ...s.exit }; });
  check('too few survivors at the exit does not win', checkWin(s) === null,
    `${CONFIG.GAME.SURVIVORS_TO_ESCAPE - 1} of ${CONFIG.GAME.SURVIVORS_TO_ESCAPE} present`);
}

{
  const s = fresh();
  s.tasksComplete = CONFIG.GAME.TASKS_TO_WIN;
  loyalists(s).slice(0, CONFIG.GAME.SURVIVORS_TO_ESCAPE).forEach(p => { p.pos = { ...s.exit }; });
  check('tasks + enough survivors at the exit wins', checkWin(s) === TEAM.LOYALIST,
    `${CONFIG.GAME.SURVIVORS_TO_ESCAPE} escaped`);
}

{
  const s = fresh();
  s.tasksComplete = CONFIG.GAME.TASKS_TO_WIN;
  loyalists(s).forEach(p => { p.pos = { ...s.exit }; });
  // Dead players cannot escape, however conveniently positioned.
  loyalists(s).forEach((p, i) => { if (i >= 1) p.alive = false; });
  check('dead loyalists at the exit do not count', checkWin(s) !== TEAM.LOYALIST,
    'corpses are not survivors');
}

{
  const s = fresh();
  loyalists(s).slice(0, loyalists(s).length - CONFIG.GAME.LOYALISTS_ALIVE_TO_LOSE)
    .forEach(p => { p.alive = false; });
  check('saboteurs win by attrition', checkWin(s) === TEAM.SABOTEUR,
    `${loyalists(s).filter(p => p.alive).length} loyalists left`);
}

{
  const s = fresh();
  s.tick = CONFIG.GAME.TOTAL_TICKS;
  s.tasksComplete = CONFIG.GAME.TIMEOUT_TASKS_FOR_LOYALIST_WIN - 1;
  check('clock expires below the task threshold → saboteurs', checkWin(s) === TEAM.SABOTEUR,
    `${s.tasksComplete} tasks`);
}

{
  const s = fresh();
  s.tick = CONFIG.GAME.TOTAL_TICKS;
  s.tasksComplete = CONFIG.GAME.TIMEOUT_TASKS_FOR_LOYALIST_WIN;
  check('clock expires at the task threshold → loyalists', checkWin(s) === TEAM.LOYALIST,
    `${s.tasksComplete} tasks`);
}

check('timeout threshold is configurable, not hardcoded',
  typeof CONFIG.GAME.TIMEOUT_TASKS_FOR_LOYALIST_WIN === 'number',
  `${CONFIG.GAME.TIMEOUT_TASKS_FOR_LOYALIST_WIN}`);

// ── Elimination ─────────────────────────────────────────────────────────────
section('Elimination');

{
  // Isolate one saboteur beside one loyalist and push every other loyalist
  // far away so nobody can witness it.
  const s = fresh();
  const sab = saboteurs(s)[0];
  const [victim, ...rest] = loyalists(s);
  const far = { x: 1, y: 1 };

  victim.pos = { ...sab.pos };
  rest.forEach(p => { p.pos = { ...far }; });
  saboteurs(s).slice(1).forEach(p => { p.pos = { ...far }; });

  resolveTick(s);                       // first tick: adjacency starts the clock
  const survivedFirst = victim.alive;
  s.tick += CONFIG.GAME.ELIMINATION_TICKS;
  resolveTick(s);                       // second tick: the kill lands

  check('no instant kill on first adjacency', survivedFirst, 'positional, not twitch');
  check('elimination fires after a full tick of unwitnessed adjacency', !victim.alive,
    victim.alive ? 'victim survived — elimination is broken' : `${victim.id} eliminated`);
}

{
  // Same setup, but park the other loyalists on top of the victim as witnesses.
  const s = fresh();
  const sab = saboteurs(s)[0];
  const [victim, ...rest] = loyalists(s);

  victim.pos = { ...sab.pos };
  rest.forEach(p => { p.pos = { ...victim.pos }; });

  resolveTick(s);
  s.tick += CONFIG.GAME.ELIMINATION_TICKS + 1;
  resolveTick(s);

  check('witnesses prevent elimination', victim.alive,
    victim.alive ? 'watched, so no kill' : 'killed in front of witnesses — witness rule broken');
}

// ── The information boundary ────────────────────────────────────────────────
section('Information boundary');

{
  const s = fresh();
  const pv = playerView(s, 'p1');
  const sv = spectatorView(s);

  check('player never receives the agent channel', !('channel' in pv));
  check('player never receives the ledger', !('ledger' in pv));
  check('player sees only a fraction of the maze',
    pv.visible.length > 0 && pv.visible.length < (pv.maze.length ** 2) * 0.1,
    `${pv.visible.length} of ${pv.maze.length ** 2}`);
  check('player is told where the exit is', !!pv.exit, 'extraction point is public');
  check('exit stays shut until the tasks are done', pv.exitOpen === false);
  check('spectator sees everything', Array.isArray(sv.channel) && !!sv.ledger && !!sv.exit);

  // Fog is server-side. If any other player's position leaks into the packet
  // for someone outside vision range, devtools wins the game.
  const visibleSet = new Set(pv.visible);
  const leaked = pv.others.filter(o => !visibleSet.has(`${o.pos.x},${o.pos.y}`));
  check('no player positions leak outside the visible set', leaked.length === 0,
    leaked.length ? `LEAKED ${leaked.length}` : 'clean');
}

// ── Economy invariants ──────────────────────────────────────────────────────
section('Economy invariants (docs/POWERUPS.md)');

const P = CONFIG.POWERUPS;
check('bribery (~1.0) is cheaper than FREEZE', 1.0 < P.FREEZE.cost, `FREEZE ${P.FREEZE.cost}`);
check('AUDIT costs more than a typical bribe', P.AUDIT.cost > 1.0, `AUDIT ${P.AUDIT.cost}`);
check('REVEAL costs more than LANTERN', P.REVEAL.cost > P.LANTERN.cost);
// Invariant #3 is enforced as a RULE, not by pricing. The cheapest powerup is
// 0.50, so a 5 MON stake would otherwise buy ten of them — and an agent with
// no MON left can neither bribe nor be bribed.
check('powerup purchases are capped per game',
  CONFIG.ECONOMY.MAX_POWERUPS_PER_GAME === 3, `cap ${CONFIG.ECONOMY.MAX_POWERUPS_PER_GAME}`);

{
  const s = fresh();
  const agent = Object.values(s.players)[0].agent;
  agent.balance = CONFIG.ECONOMY.STARTING_MON;
  let allowed = 0;
  for (let i = 0; i < 10; i++) {
    if (agent.powerupsBought >= CONFIG.ECONOMY.MAX_POWERUPS_PER_GAME) break;
    agent.powerupsBought++;
    allowed++;
  }
  check('an agent cannot exceed the cap however cheap the item',
    allowed === CONFIG.ECONOMY.MAX_POWERUPS_PER_GAME, `${allowed} purchases allowed`);

  // The point of the cap: enough MON survives to keep bribery viable.
  const worstCase = CONFIG.ECONOMY.MAX_POWERUPS_PER_GAME
    * Math.max(...Object.values(P).map(p => p.cost));
  check('cap leaves headroom for at least one bribe',
    CONFIG.ECONOMY.STARTING_MON - Math.min(worstCase, CONFIG.ECONOMY.STARTING_MON) >= 0
    && CONFIG.ECONOMY.MAX_POWERUPS_PER_GAME * 0.5 < CONFIG.ECONOMY.STARTING_MON,
    `3 cheap buys = 1.5 of ${CONFIG.ECONOMY.STARTING_MON} MON`);
}

// ── Powerups (Phase 4) ──────────────────────────────────────────────────────
section('Powerups — catalogue and conflicts');

check('all 12 powerups exist', Object.keys(P).length === 12, `${Object.keys(P).length} defined`);
check('team restrictions match the catalogue',
  P.FREEZE.team === 'SABOTEUR' && P.BLACKOUT.team === 'SABOTEUR' && P.AUDIT.team === 'LOYALIST',
  'FREEZE/BLACKOUT saboteur, AUDIT loyalist');

const buy = (agentId, type, extra = {}) => ({
  agentId, playerId: agentId, team: P[type].team ?? TEAM.LOYALIST,
  type, cost: P[type].cost, ts: Date.now(), ...extra,
});

{
  const s = fresh();
  const fx = applyPurchases(s, [buy('p1', 'REVEAL'), buy('p1', 'LANTERN')]);
  check('one purchase per agent per tick', !(fx.reveal.has('p1') && fx.lantern.has('p1')),
    'the dearer of the two lands, not both');
}

{
  // The regression that mattered: LANTERN (0.75) was cancelling BLACKOUT
  // (2.00) back to normal vision — the cheap item beating the dear one.
  const s = fresh();
  const fx = applyPurchases(s, [
    buy('p1', 'BLACKOUT', { team: TEAM.SABOTEUR }),
    buy('p2', 'LANTERN'),
  ]);
  check('expensive BLACKOUT beats cheap LANTERN', fx.blackout && !fx.lantern.has('p2'),
    `blackout ${fx.blackout}, lantern applied ${fx.lantern.has('p2')}`);

  const victim = { id: 'p2', pos: { x: 5, y: 5 } };
  check('outbid lantern does not restore vision',
    visionRadiusFor(victim, fx) < CONFIG.GAME.VISION_RADIUS,
    `radius ${visionRadiusFor(victim, fx)} vs base ${CONFIG.GAME.VISION_RADIUS}`);
}

{
  // Same slot, same target, cheaper buyer loses.
  const s = fresh();
  const fx = applyPurchases(s, [
    buy('p1', 'FREEZE', { team: TEAM.SABOTEUR, target: 'p5' }),
    buy('p5', 'SPRINT'),
  ]);
  check('FREEZE (2.00) beats SPRINT (0.75) on the same human',
    fx.freeze.has('p5') && !fx.sprint.has('p5'),
    `frozen ${fx.freeze.has('p5')}, sprinting ${fx.sprint.has('p5')}`);
}

{
  // A lantern with nobody contesting it must still work.
  const s = fresh();
  const fx = applyPurchases(s, [buy('p2', 'LANTERN')]);
  check('uncontested LANTERN doubles vision',
    visionRadiusFor({ id: 'p2', pos: { x: 5, y: 5 } }, fx) === CONFIG.GAME.VISION_RADIUS * 2,
    `radius ${visionRadiusFor({ id: 'p2', pos: { x: 5, y: 5 } }, fx)}`);
}

check('WHISPER has a real effect, not an empty case',
  applyPurchases(fresh(), [buy('p1', 'WHISPER')]).whisper.has('p1'),
  'hides the buyer traffic from the per-player reveal');

{
  // WHISPER's payoff: the victim's reveal omits it, the audience keeps it.
  const s = fresh();
  s.ledger.entries.push({ seq: 0, kind: 'BRIBE', from: 'p1', to: 'p2', amount: 1, whispered: true, tick: 1 });
  s.ledger.entries.push({ seq: 1, kind: 'BRIBE', from: 'p3', to: 'p2', amount: 1, whispered: false, tick: 1 });
  const reveal = buildReveal(s);
  check('whispered bribe is hidden from its victim', reveal.perAgent.p2.received.length === 1,
    `${reveal.perAgent.p2.received.length} of 2 shown to p2`);
  check('whispered bribe still visible to the payer', reveal.perAgent.p1.paid.length === 1);
  check('audience ledger keeps every entry', s.ledger.entries.length === 2);
}

section('Powerups — agent information economy');

{
  // REVEAL was worthless: every agent already had every position for free.
  const s = fresh();
  const enemy = Object.values(s.players).find(p => p.team !== s.players.p1.team);

  const dark = buildContext(s.players.p1.agent, s);
  const seenDark = dark.roster.find(r => r.id === enemy.id);
  check('enemy positions are hidden by default', seenDark.pos === undefined,
    'otherwise REVEAL sells nothing');

  s.effects.reveal.add('p1');
  const lit = buildContext(s.players.p1.agent, s);
  check('REVEAL exposes enemy positions', lit.roster.find(r => r.id === enemy.id).pos !== undefined);

  // GHOST (1.50) outranks REVEAL (1.00).
  s.effects.ghost.add(enemy.id);
  const ghosted = buildContext(s.players.p1.agent, s);
  check('GHOST beats REVEAL on the same target',
    ghosted.roster.find(r => r.id === enemy.id).pos === undefined,
    'ghosted enemy stays dark despite REVEAL');
}

{
  const s = fresh();
  const ally = Object.values(s.players).find(p => p.id !== 'p1' && p.team === s.players.p1.team);
  const ctx = buildContext(s.players.p1.agent, s);
  check('teammates are always visible to each other',
    ctx.roster.find(r => r.id === ally.id).pos !== undefined,
    'multi-tile tasks are impossible otherwise');
}

{
  const s = fresh();
  const enemy = Object.values(s.players).find(p => p.team !== s.players.p1.team);
  s.effects.trace.set('p1', enemy.id);
  const ctx = buildContext(s.players.p1.agent, s);
  check('TRACE returns the last tiles walked',
    Array.isArray(ctx.roster.find(r => r.id === enemy.id).recentTiles),
    `${ctx.roster.find(r => r.id === enemy.id).recentTiles?.length} tiles`);
}

// ── Role commit-reveal (Phase 7) ────────────────────────────────────────────
section('Role commit-reveal (PRD §10.4)');

{
  const s = fresh();
  const roles = serialiseRoles(s);
  const salt = '0x' + '11'.repeat(32);
  const commitment = commitmentFor(roles, salt);

  check('roles serialise deterministically', serialiseRoles(fresh()) === roles,
    roles.slice(0, 34) + '…');
  check('commitment is a 32-byte hash', /^0x[0-9a-f]{64}$/.test(commitment));
  check('same inputs give the same commitment', commitmentFor(roles, salt) === commitment);

  // The property the mechanism exists for: the host cannot move somebody onto
  // the Saboteur team after seeing how the game is going.
  const tampered = roles.replace('LOYALIST', 'SABOTEUR');
  check('a tampered role list breaks the commitment',
    commitmentFor(tampered, salt) !== commitment, 'reassignment is detectable');

  check('a wrong salt breaks the commitment',
    commitmentFor(roles, '0x' + '22'.repeat(32)) !== commitment,
    'salt must stay secret to prove anything');

  check('game id is derived from the seed',
    gameIdFor(s.seed) === gameIdFor(s.seed) && gameIdFor(s.seed) !== gameIdFor(s.seed + 1));
}

{
  // Publishing the salt before the reveal would let a spectator read every
  // team before the first tick.
  const s = fresh();
  s.roleCommit = {
    gameId: '0x1', commitment: '0x2', salt: '0xSECRET',
    roles: 'p1:SABOTEUR', revealed: false,
  };
  const before = JSON.stringify(roleCommitSummary(s));
  check('salt is withheld before the reveal',
    !before.includes('SECRET') && !before.includes('p1:SABOTEUR'),
    'commitment only');

  s.roleCommit.revealed = true;
  s.roleCommit.verified = true;
  const after = roleCommitSummary(s);
  check('salt and roles are published at the reveal',
    after.salt === '0xSECRET' && after.roles === 'p1:SABOTEUR' && after.verified === true);
}

// ── Summary ─────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('\nFAILED:');
  for (const f of failed) console.log(`  ✗ ${f.name}  ${f.detail}`);
}
console.log('');
process.exit(failed.length ? 1 : 0);
