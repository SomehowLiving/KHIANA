import { spawn } from 'child_process';
import { createServer } from 'net';
import { WebSocket } from 'ws';

/**
 * Self-contained integration test. Spawns the server, connects a player and a
 * spectator, asserts the information boundary, tears everything down.
 *
 * The critical assertion is LEAK_channel === false. If a player's state packet
 * ever contains the agent channel, the entire game is defeated by opening
 * devtools. Run this after any change to fog.js or index.js.
 *
 *   node integration.test.mjs
 */

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
};

const PORT = 8799;

/**
 * Refuse to run if the port is occupied.
 *
 * Without this the spawned server dies with EADDRINUSE, every assertion
 * silently runs against whatever stale instance is still listening, and you
 * get a confident-looking result from a server that isn't the one you just
 * changed. Two false readings before this check existed.
 */
await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', err => {
    console.error(
      err.code === 'EADDRINUSE'
        ? `\nPort ${PORT} is already in use — a previous run is probably still alive.\n` +
          `Kill it, then re-run:\n` +
          `  powershell "Get-NetTCPConnection -LocalPort ${PORT} -State Listen | ` +
          `Select -Expand OwningProcess -Unique | ForEach { Stop-Process -Id $_ -Force }"\n`
        : `\nCould not probe port ${PORT}: ${err.message}\n`
    );
    reject(err);
  });
  probe.once('listening', () => probe.close(resolve));
  probe.listen(PORT);
}).catch(() => process.exit(1));

const srv = spawn('node', ['src/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, MOCK_CHAIN: 'true', PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let srvOut = '';
srv.stdout.on('data', d => { srvOut += d; });
srv.stderr.on('data', d => { srvOut += d; });

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Wait for the server to answer, rather than guessing a fixed delay.
 *
 * A hardcoded 2500ms passed on an idle machine and failed the moment
 * anything else was running, producing an ECONNREFUSED that looked like a
 * real regression. Polling removes the flake entirely.
 */
async function waitForServer(ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${PORT}/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  return false;
}

async function main() {
  if (!await waitForServer()) {
    console.error(`
Server did not come up on :${PORT} within 20s.
`);
    console.error(srvOut);
    process.exit(1);
  }

  console.log('\nKhiana integration test\n');

  // ── HTTP ──────────────────────────────────────────────────────────────
  const health = await fetch('http://localhost:8799/health').then(r => r.json());
  check('server boots', health.ok === true);
  check('8 players seeded', health.players === 8, `got ${health.players}`);
  check('mock chain active', health.mockChain === true);

  const fac = await fetch('http://localhost:8799/facilitator').then(r => r.json());
  check('facilitator endpoint responds', fac.ok === true);

  // ── Player socket ─────────────────────────────────────────────────────
  const player = new WebSocket('ws://localhost:8799');
  let pState = null, joined = null;

  player.on('open', () => player.send(JSON.stringify({ type: 'JOIN', name: 'Tester' })));
  player.on('message', d => {
    const m = JSON.parse(d);
    if (m.type === 'JOINED') joined = m;
    if (m.type === 'STATE') pState = m.view;
  });

  // ── Spectator socket ──────────────────────────────────────────────────
  const spec = new WebSocket('ws://localhost:8799');
  let sState = null;
  spec.on('open', () => spec.send(JSON.stringify({ type: 'SPECTATE' })));
  spec.on('message', d => {
    const m = JSON.parse(d);
    if (m.type === 'SPECTATE_STATE') sState = m.view;
  });

  await sleep(1200);
  check('player joins a seat', joined?.playerId != null, joined?.playerId);
  check('player is assigned a team', ['LOYALIST', 'SABOTEUR'].includes(joined?.team), joined?.team);

  await fetch('http://localhost:8799/game/start', { method: 'POST' });
  await sleep(4000);

  // ── THE ASSERTION THAT MATTERS ────────────────────────────────────────
  check('PLAYER CANNOT SEE AGENT CHANNEL', pState && !('channel' in pState),
    pState ? (('channel' in pState) ? 'LEAKED!' : 'clean') : 'no state');
  check('PLAYER CANNOT SEE LEDGER', pState && !('ledger' in pState),
    pState ? (('ledger' in pState) ? 'LEAKED!' : 'clean') : 'no state');

  // Fog: the visible set must be a small fraction of the maze, not all of it.
  const totalTiles = (pState?.maze?.length ?? 0) ** 2;
  const visible = pState?.visible?.length ?? 0;
  check('fog restricts vision', visible > 0 && visible < totalTiles * 0.1,
    `${visible} of ${totalTiles} tiles`);

  check('client receives maze geometry', (pState?.maze?.length ?? 0) > 0,
    `${pState?.maze?.length}²`);
  check('roster is public (teams visible)', (pState?.roster?.length ?? 0) === 8);
  check('roster exposes agent loyalty', pState?.roster?.[0]?.agentGoal != null,
    `p1 loyalty ${pState?.roster?.[0]?.agentGoal}`);

  // ── Spectator sees everything ─────────────────────────────────────────
  check('spectator receives channel', Array.isArray(sState?.channel),
    `${sState?.channel?.length ?? 0} msgs`);
  check('spectator sees all 8 players', (sState?.players?.length ?? 0) === 8);
  check('spectator sees agent balances', sState?.players?.[0]?.balance != null,
    `${sState?.players?.[0]?.balance} MON`);
  check('spectator sees ledger', sState?.ledger != null);

  // ── Movement ──────────────────────────────────────────────────────────
  // Check after EACH move, not after a set of four — up/right/down/left
  // returns to origin and looks identical to total failure.
  const before = { ...pState.you.pos };
  let moved = false;
  outer:
  for (let round = 0; round < 4 && !moved; round++) {
    for (const [dx, dy] of [[0,-1],[1,0],[0,1],[-1,0]]) {
      player.send(JSON.stringify({ type: 'MOVE', dx, dy }));
      await sleep(180);
      if (pState.you.pos.x !== before.x || pState.you.pos.y !== before.y) {
        moved = true;
        break outer;
      }
    }
  }
  check('movement changes position', moved,
    `(${before.x},${before.y}) → (${pState.you.pos.x},${pState.you.pos.y}) · phase ${pState.phase}`);

  // ── Tick engine ───────────────────────────────────────────────────────
  const t1 = pState.tick;
  await sleep(16000);
  check('tick engine advances', pState.tick > t1, `tick ${t1} → ${pState.tick}`);
  check('briefing delivered to player', pState.briefing != null,
    pState.briefing ? `"${pState.briefing.slice(0, 48)}…"` : 'none');

  player.close(); spec.close();

  // ── Summary ───────────────────────────────────────────────────────────
  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  ✗ ${f.name}  ${f.detail}`);
    console.log('\nserver output:\n' + srvOut);
  }
  console.log('');

  srv.kill('SIGKILL');
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  console.error('\nserver output:\n' + srvOut);
  srv.kill('SIGKILL');
  process.exit(1);
});
