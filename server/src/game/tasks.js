import { CONFIG } from '../config.js';
import { floorTiles, makeRng, distance } from './maze.js';

/**
 * Tasks are revealed ONLY to agents. The human is told where to go, never
 * what's there. Every task is therefore an opportunity for a corrupted agent
 * to send its human somewhere useful to somebody else.
 *
 * The escalation from 1 player to 4 is deliberate: early tasks let agents
 * operate independently, late tasks force coordination — which is exactly
 * when a bribed agent does maximum damage.
 */

export const TASK_TYPES = {
  CALIBRATE: { players: 1, tiles: 1, holdTicks: 1, desc: 'One player stands on the marked tile' },
  BRIDGE:    { players: 2, tiles: 2, holdTicks: 1, desc: 'Two players on two tiles in the same tick' },
  SEQUENCE:  { players: 1, tiles: 3, holdTicks: 1, ordered: true, desc: 'Three tiles touched in order' },
  HOLD:      { players: 1, tiles: 1, holdTicks: 2, desc: 'One player holds a tile for two ticks — very exposed' },
  CONVERGE:  { players: 4, tiles: 4, holdTicks: 1, desc: 'Four players on four tiles simultaneously' },
};

const ORDER = ['CALIBRATE', 'BRIDGE', 'SEQUENCE', 'HOLD', 'CONVERGE'];

export function generateTasks(maze, seed = Date.now()) {
  const rng = makeRng(seed ^ 0x5f3759df);
  const floors = floorTiles(maze);
  const used = new Set();

  const pick = () => {
    for (let i = 0; i < 200; i++) {
      const t = floors[Math.floor(rng() * floors.length)];
      const k = `${t.x},${t.y}`;
      if (used.has(k)) continue;
      // Keep task tiles apart so the map stays interesting to traverse.
      const tooClose = [...used].some(u => {
        const [ux, uy] = u.split(',').map(Number);
        return distance({ x: ux, y: uy }, t) < 5;
      });
      if (tooClose) continue;
      used.add(k);
      return t;
    }
    return floors[Math.floor(rng() * floors.length)];
  };

  return ORDER.map((type, i) => {
    const spec = TASK_TYPES[type];
    return {
      id: `task_${i + 1}`,
      index: i,
      type,
      spec,
      tiles: Array.from({ length: spec.tiles }, pick),
      revealAtTick: i * CONFIG.GAME.TASK_REVEAL_EVERY,
      revealed: false,
      complete: false,
      progress: { held: 0, sequenceIndex: 0 },
    };
  });
}

export function revealDueTasks(state) {
  const newly = [];
  for (const t of state.tasks) {
    if (!t.revealed && state.tick >= t.revealAtTick) {
      t.revealed = true;
      newly.push(t);
    }
  }
  return newly;
}

/**
 * Evaluate every revealed, incomplete task against current positions.
 * Called at the end of MOVE phase.
 */
export function evaluateTasks(state) {
  const completed = [];

  for (const task of state.tasks) {
    if (!task.revealed || task.complete) continue;

    const alive = Object.values(state.players).filter(p => p.alive);
    const onTile = tile => alive.filter(p => p.pos.x === tile.x && p.pos.y === tile.y);

    if (task.type === 'SEQUENCE') {
      const next = task.tiles[task.progress.sequenceIndex];
      if (next && onTile(next).length > 0) {
        task.progress.sequenceIndex++;
        if (task.progress.sequenceIndex >= task.tiles.length) {
          task.complete = true;
          completed.push(task);
        }
      }
      continue;
    }

    const covered = task.tiles.every(t => onTile(t).length > 0);
    const enoughPlayers =
      task.tiles.reduce((n, t) => n + Math.min(1, onTile(t).length), 0) >= task.spec.players;

    if (covered && enoughPlayers) {
      task.progress.held++;
      if (task.progress.held >= task.spec.holdTicks) {
        task.complete = true;
        completed.push(task);
      }
    } else {
      task.progress.held = 0;   // HOLD tasks reset if you break contact
    }
  }

  state.tasksComplete = state.tasks.filter(t => t.complete).length;
  return completed;
}

/** What an agent is allowed to know about tasks. Humans get none of this. */
export function taskBriefFor(state) {
  return state.tasks
    .filter(t => t.revealed && !t.complete)
    .map(t => ({
      id: t.id,
      type: t.type,
      description: t.spec.desc,
      tiles: t.tiles,
      playersNeeded: t.spec.players,
      holdTicks: t.spec.holdTicks,
      progress: t.progress,
    }));
}
