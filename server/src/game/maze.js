import { CONFIG } from '../config.js';

/**
 * Recursive-backtracker maze, then loop carving.
 *
 * Why loop carving matters: a perfect maze has exactly one path between any
 * two points. That makes chasing trivial (there's nowhere to dodge) and hiding
 * impossible. Knocking out ~12% of interior walls creates loops, which is what
 * makes fog of war tense rather than deterministic.
 *
 * Grid representation: cell (x, y) with wall flags. Rendered as a 2N+1 tile
 * grid where odd coordinates are cells and even are walls.
 */

const DIRS = [
  { dx: 0, dy: -1, wall: 'N', opposite: 'S' },
  { dx: 1, dy: 0, wall: 'E', opposite: 'W' },
  { dx: 0, dy: 1, wall: 'S', opposite: 'N' },
  { dx: -1, dy: 0, wall: 'W', opposite: 'E' },
];

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Deterministic RNG so a seed reproduces a maze exactly — essential for demo replay. */
export function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function generateMaze(size = CONFIG.GAME.MAZE_SIZE, seed = Date.now()) {
  const rng = makeRng(seed);
  const cells = [];
  for (let y = 0; y < size; y++) {
    cells[y] = [];
    for (let x = 0; x < size; x++) {
      cells[y][x] = { x, y, walls: { N: true, E: true, S: true, W: true }, visited: false };
    }
  }

  // Recursive backtracker, iterative to avoid stack depth issues on big grids.
  const stack = [cells[0][0]];
  cells[0][0].visited = true;

  while (stack.length) {
    const cur = stack[stack.length - 1];
    const neighbours = shuffle([...DIRS], rng)
      .map(d => ({ d, c: cells[cur.y + d.dy]?.[cur.x + d.dx] }))
      .filter(n => n.c && !n.c.visited);

    if (!neighbours.length) { stack.pop(); continue; }

    const { d, c } = neighbours[0];
    cur.walls[d.wall] = false;
    c.walls[d.opposite] = false;
    c.visited = true;
    stack.push(c);
  }

  carveLoops(cells, size, rng);
  return { size, cells, seed, tiles: toTileGrid(cells, size) };
}

function carveLoops(cells, size, rng) {
  const target = Math.floor(size * size * CONFIG.GAME.LOOP_CARVE_RATIO);
  let carved = 0, attempts = 0;

  while (carved < target && attempts < target * 20) {
    attempts++;
    const x = 1 + Math.floor(rng() * (size - 2));
    const y = 1 + Math.floor(rng() * (size - 2));
    const d = DIRS[Math.floor(rng() * 4)];
    const n = cells[y + d.dy]?.[x + d.dx];
    if (!n) continue;
    if (!cells[y][x].walls[d.wall]) continue;
    cells[y][x].walls[d.wall] = false;
    n.walls[d.opposite] = false;
    carved++;
  }
}

/**
 * Expand cell grid into a tile grid the renderer and pathfinder can use.
 * 0 = floor, 1 = wall. Dimensions are (2*size + 1) square.
 */
function toTileGrid(cells, size) {
  const w = size * 2 + 1;
  const grid = Array.from({ length: w }, () => new Array(w).fill(1));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tx = x * 2 + 1, ty = y * 2 + 1;
      grid[ty][tx] = 0;
      if (!cells[y][x].walls.N) grid[ty - 1][tx] = 0;
      if (!cells[y][x].walls.S) grid[ty + 1][tx] = 0;
      if (!cells[y][x].walls.W) grid[ty][tx - 1] = 0;
      if (!cells[y][x].walls.E) grid[ty][tx + 1] = 0;
    }
  }
  return grid;
}

export function isWalkable(maze, x, y) {
  return maze.tiles[y]?.[x] === 0;
}

/** Open floor tiles, useful for spawning players and placing tasks. */
export function floorTiles(maze) {
  const out = [];
  for (let y = 0; y < maze.tiles.length; y++)
    for (let x = 0; x < maze.tiles[y].length; x++)
      if (maze.tiles[y][x] === 0) out.push({ x, y });
  return out;
}

/** BFS shortest path. Used by bots and by agents computing route guidance. */
export function findPath(maze, from, to) {
  const key = p => `${p.x},${p.y}`;
  const queue = [from];
  const prev = new Map([[key(from), null]]);

  while (queue.length) {
    const cur = queue.shift();
    if (cur.x === to.x && cur.y === to.y) {
      const path = [];
      let k = key(cur), node = cur;
      while (k) { path.unshift(node); node = prev.get(k); k = node ? key(node) : null; }
      return path;
    }
    for (const d of DIRS) {
      const nx = cur.x + d.dx, ny = cur.y + d.dy;
      if (!isWalkable(maze, nx, ny)) continue;
      const nk = `${nx},${ny}`;
      if (prev.has(nk)) continue;
      prev.set(nk, cur);
      queue.push({ x: nx, y: ny });
    }
  }
  return null;
}

/** Chebyshev distance — diagonal-aware, matches how vision and adjacency feel. */
export function distance(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}
