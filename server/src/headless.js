import { CONFIG, TEAM } from './config.js';
import { createGame, runTick, resolveTick, endGame } from './game/engine.js';
import { stepAllBots } from './agents/bots.js';

/**
 * Headless game runner. Proves the game is fun as text before you spend a
 * minute on rendering — Phase 2's exit criterion.
 *
 * Run: npm run headless
 */

const FAST_TICK = 0;   // no waiting; we only care about the simulation

async function main() {
  const seed = Number(process.argv[2]) || Date.now();
  const game = createGame({ seed });

  console.log(`\nKhiana headless — seed ${seed}`);
  console.log(`maze ${game.maze.tiles.length}² · ${Object.keys(game.players).length} players · ${CONFIG.GAME.SABOTEURS} saboteurs\n`);

  for (const p of Object.values(game.players)) {
    console.log(`  ${p.id} ${p.name.padEnd(10)} ${p.team.padEnd(9)} loyalty ${String(p.agent.goalWeight).padStart(3)} ${p.agent.personality.name}`);
  }
  console.log('');

  let winner = null;
  while (!winner && game.tick < CONFIG.GAME.TOTAL_TICKS) {
    await runTick(game);
    stepAllBots(game);
    winner = resolveTick(game);

    const recent = game.channel.filter(c => c.tick === game.tick);
    const bribes = recent.filter(c => c.kind === 'BRIBE_SETTLED');
    const kills = recent.filter(c => c.kind === 'ELIMINATION');

    if (bribes.length || kills.length || game.tick % 5 === 0) {
      console.log(`─ tick ${String(game.tick).padStart(2)} · tasks ${game.tasksComplete}/${CONFIG.GAME.TASKS_TO_WIN} · alive ${Object.values(game.players).filter(p => p.alive).length}`);
      for (const b of bribes) console.log(`    💰 ${b.from} → ${b.to}  ${b.amount} MON  "${b.instruction}"`);
      for (const k of kills) console.log(`    ☠️  ${k.text}`);
    }

    if (FAST_TICK) await new Promise(r => setTimeout(r, FAST_TICK));
  }

  const reveal = endGame(game);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`WINNER: ${reveal.winner}`);
  console.log(`bribes paid: ${reveal.totalBribed} MON across ${reveal.betrayals} honoured betrayals`);
  console.log(`burned on powerups: ${reveal.totalBurned} MON`);
  console.log(`${'═'.repeat(60)}\n`);

  console.log('LEDGER REVEAL\n');
  for (const [id, a] of Object.entries(reveal.perAgent)) {
    const status = a.alive ? 'alive' : 'DEAD ';
    console.log(`  ${id} ${a.player.padEnd(10)} ${a.team.padEnd(9)} ${status}  ${String(a.finalBalance).padStart(6)} MON`);
    for (const r of a.received) {
      console.log(`      ← paid ${r.amount} by ${r.from}: "${r.memo}" ${r.followed ? '[HONOURED]' : '[ignored]'}`);
    }
  }
  console.log('');
}

main().catch(err => { console.error(err); process.exit(1); });
