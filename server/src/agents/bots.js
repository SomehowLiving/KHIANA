import { findPath } from '../game/maze.js';
import { movePlayer } from '../game/engine.js';

/**
 * Bot humans fill any empty seat.
 *
 * Build this early, not late. You cannot test with eight humans at 2am, and
 * you cannot guarantee eight volunteers at demo time. Every seat must be
 * bot-fillable from hour one — the game shouldn't care who's in it.
 *
 * Bots are deliberately naive: they follow their agent's last briefing, exactly
 * like a trusting human would. Which means a bot walks into a trap just as
 * readily as a person, and the betrayal still reads on the spectator screen.
 */

/**
 * Where the agent is actually sending this human.
 *
 * Previously this regex-scraped "(12,7)" out of the briefing text. Briefings
 * are now spoken directions with no coordinates in them ("Turn left, then
 * four steps"), because coordinates are unusable to a first-person player —
 * so the target travels as structured data alongside the words instead of
 * being encoded in them.
 *
 * The legacy parse is kept as a fallback: an LLM briefing may still slip a
 * coordinate through, and a bot that can use it should.
 */
function targetFor(player) {
  if (player.agent.lastTarget) return player.agent.lastTarget;
  const m = /\((\d+)\s*,\s*(\d+)\)/.exec(player.agent.lastBriefing ?? '');
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

const BEARINGS = {
  north: { dx: 0, dy: -1 },
  south: { dx: 0, dy: 1 },
  east:  { dx: 1, dy: 0 },
  west:  { dx: -1, dy: 0 },
};

/**
 * A human gets the full 15-second MOVE window and will cover several tiles.
 * A bot taking a single step per tick under-moves by roughly 5x, which means
 * task tiles are never reached and the game stalls at 1/5 forever. STEPS_PER_TICK
 * is the bot's equivalent of that window — tune it against how far a real
 * player actually gets in 15 seconds.
 */
export const STEPS_PER_TICK = 5;

export function stepBot(state, player) {
  if (!player.alive || !player.isBot) return;

  const briefing = player.agent.lastBriefing ?? '';
  const target = targetFor(player);

  if (target) {
    const path = findPath(state.maze, player.pos, target);
    if (path && path.length > 1) {
      for (let i = 1; i <= Math.min(STEPS_PER_TICK, path.length - 1); i++) {
        const step = path[i];
        movePlayer(state, player.id, step.x - player.pos.x, step.y - player.pos.y);
      }
      return;
    }
  }

  // No coordinates — fall back to the bearing word in the briefing.
  const word = Object.keys(BEARINGS).find(b => briefing.toLowerCase().includes(b));
  if (word) {
    const { dx, dy } = BEARINGS[word];
    movePlayer(state, player.id, dx, dy);
    return;
  }

  // Nothing usable. Wander so the board doesn't look frozen.
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const [dx, dy] = dirs[Math.floor(Math.random() * 4)];
  movePlayer(state, player.id, dx, dy);
}

export function stepAllBots(state) {
  for (const p of Object.values(state.players)) stepBot(state, p);
}

export function claimSeat(state, playerId, name) {
  const p = state.players[playerId];
  if (!p) return null;
  p.isBot = false;
  if (name) p.name = name;
  return p;
}

export function releaseSeat(state, playerId) {
  const p = state.players[playerId];
  if (p) p.isBot = true;   // disconnects hand the seat back to a bot mid-game
  return p;
}

export function firstOpenSeat(state) {
  return Object.values(state.players).find(p => p.isBot && p.alive) ?? null;
}
