/**
 * Turning a path into something a human can actually follow.
 *
 * Briefings used to read "Head north toward (44,7)". In a first-person view
 * with no minimap that is unusable twice over: the player has no compass, and
 * a grid coordinate is not information they can act on. They cannot see the
 * grid. They can see a corridor.
 *
 * So a path becomes leg-by-leg instructions in plain language:
 *
 *   "Go forward four, then take the left. Hold there."
 *
 * Cardinal directions are still emitted as a fallback for the spectator and
 * the bot parser, but the sentence the player hears is relative to the way
 * they are facing, which is the only frame of reference they have.
 */

import { findPath } from './maze.js';

export const CARDINALS = ['north', 'east', 'south', 'west'];

/** Grid delta → cardinal index. y grows southward in this grid. */
export function headingOf(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 1 : 3;   // east : west
  return dy > 0 ? 2 : 0;                                     // south : north
}

/**
 * Collapse a tile-by-tile path into straight runs.
 * [{heading, steps}] — "north 4, east 3" rather than 7 individual tiles.
 */
export function legsFrom(path) {
  if (!path || path.length < 2) return [];
  const legs = [];
  for (let i = 1; i < path.length; i++) {
    const h = headingOf(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    const last = legs[legs.length - 1];
    if (last && last.heading === h) last.steps++;
    else legs.push({ heading: h, steps: 1 });
  }
  return legs;
}

/**
 * A turn, expressed the way a passenger gives directions.
 * `from` and `to` are cardinal indices.
 */
export function turnWord(from, to) {
  const d = (to - from + 4) % 4;
  return ['straight on', 'right', 'back the way you came', 'left'][d];
}

const COUNT = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const count = n => (n <= 10 ? COUNT[n] : String(n));

/**
 * Build the briefing sentence.
 *
 * Capped at two legs on purpose. A four-instruction route cannot be held in
 * memory while something is chasing you, and the advisor gets to speak again
 * in fifteen seconds anyway. Two legs is roughly one tick of movement.
 *
 * @param {object} maze
 * @param {object} from      player position
 * @param {object} to        target tile
 * @param {number} facing    cardinal index the player is currently facing,
 *                           or null if unknown (then we use absolutes)
 * @param {string} thenWhat  trailing clause, e.g. "Hold there."
 */
export function describeRoute(maze, from, to, facing = null, thenWhat = 'Hold there.') {
  if (!from || !to) return 'Stay where you are.';
  if (from.x === to.x && from.y === to.y) return `You are on it. ${thenWhat}`;

  const path = findPath(maze, from, to);
  if (!path || path.length < 2) {
    // No route: say so rather than inventing one. An advisor confidently
    // giving directions into a wall is a bug the player reads as betrayal.
    return 'No clear route from here. Hold position.';
  }

  const legs = legsFrom(path).slice(0, 2);
  const parts = [];

  // Once we start in absolutes we stay in absolutes. Mixing the two frames
  // ("Head south eight, then right for two") forces the listener to switch
  // reference mid-sentence, which is worse than either alone.
  const relative = facing !== null && facing !== undefined;
  let cur = facing;
  legs.forEach((leg, i) => {
    const dir = CARDINALS[leg.heading];
    const n = count(leg.steps);
    const stepWord = leg.steps === 1 ? 'step' : 'steps';

    if (!relative) {
      // No facing known — absolutes throughout, which pair with the HUD compass.
      parts.push(i === 0 ? `Head ${dir} ${n} ${stepWord}` : `then ${dir} for ${n}`);
    } else {
      const turn = turnWord(cur, leg.heading);
      if (i === 0) {
        parts.push(turn === 'straight on'
          ? `Go forward ${n} ${stepWord}`
          : turn === 'back the way you came'
            ? `Turn around and go ${n} ${stepWord}`
            : `Turn ${turn}, then ${n} ${stepWord}`);
      } else {
        parts.push(turn === 'straight on' ? `carry on ${n} more` : `then ${turn} for ${n}`);
      }
    }
    cur = leg.heading;
  });

  return `${parts.join(', ')}. ${thenWhat}`;
}

/**
 * Compass bearing from the player to a tile, for the HUD arrow.
 * Returns radians where 0 = north, matching the client's yaw convention.
 */
export function bearingTo(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  return Math.atan2(dx, -dy);
}

/** Straight-line tile distance, for "12 tiles away" readouts. */
export function tileDistance(from, to) {
  return Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
}
