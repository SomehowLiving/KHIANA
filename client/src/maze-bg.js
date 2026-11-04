/**
 * The page background IS a maze.
 *
 * Generated with the same recursive-backtracker the game server uses, so the
 * labyrinth behind the marketing copy is a real one with real dead ends —
 * not a decorative grid. Scrolling moves a torch down it.
 *
 * Design system: "Obsidian Labyrinth" (Stitch). Corridor model, luminous
 * depth, heavy vignette, zero organic curves.
 *
 * Drawn once to an offscreen canvas and then blitted, because regenerating a
 * maze on every frame would be absurd and re-stroking a few thousand walls per
 * frame is exactly the kind of thing that makes a landing page stutter.
 */

const COLORS = {
  wall: 'rgba(110, 84, 255, 0.55)',   // Monad purple
  lit: 'rgba(133, 230, 255, 0.9)',   // Monad cyan, for the torch-lit run
};

/** Recursive backtracker on a (2n+1) grid. 1 = wall, 0 = corridor. */
function generateMaze(size, seed = 1) {
  const n = size * 2 + 1;
  const g = Array.from({ length: n }, () => new Uint8Array(n).fill(1));

  // Deterministic RNG so the background is stable across reloads — a maze
  // that reshuffles on every visit reads as noise rather than a place.
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

  const stack = [[1, 1]];
  g[1][1] = 0;
  while (stack.length) {
    const [x, y] = stack[stack.length - 1];
    const dirs = [[0, -2], [2, 0], [0, 2], [-2, 0]]
      .filter(([dx, dy]) => {
        const nx = x + dx, ny = y + dy;
        return nx > 0 && ny > 0 && nx < n && ny < n && g[ny][nx] === 1;
      })
      .sort(() => rnd() - 0.5);

    if (!dirs.length) { stack.pop(); continue; }
    const [dx, dy] = dirs[0];
    g[y + dy / 2][x + dx / 2] = 0;
    g[y + dy][x + dx] = 0;
    stack.push([x + dx, y + dy]);
  }

  // Knock out a few walls so it has loops. A perfect maze has exactly one
  // route between any two points, which looks unnaturally sparse.
  for (let i = 0; i < n * 2; i++) {
    const x = 1 + Math.floor(rnd() * (n - 2));
    const y = 1 + Math.floor(rnd() * (n - 2));
    if (g[y][x] === 1) g[y][x] = 0;
  }
  return g;
}

export function mountMazeBackground(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let cell = 46;   // larger cells: fewer, calmer lines behind text
  let grid = null;
  let offscreen = null;
  let torch = { x: 0.5, y: 0.35 };
  let target = { ...torch };

  function build() {
    const dpr = Math.min(devicePixelRatio, 2);
    const w = innerWidth, h = innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';

    const cols = Math.ceil(w / cell), rows = Math.ceil(h / cell);
    grid = generateMaze(Math.ceil(Math.max(cols, rows) / 2) + 1, 20260816);

    // Pre-render the whole labyrinth once.
    offscreen = document.createElement('canvas');
    offscreen.width = canvas.width;
    offscreen.height = canvas.height;
    const o = offscreen.getContext('2d');
    o.scale(dpr, dpr);
    o.lineWidth = 1;
    o.strokeStyle = COLORS.wall;

    o.beginPath();
    for (let y = 0; y < grid.length && y * cell < h + cell; y++) {
      for (let x = 0; x < grid[y].length && x * cell < w + cell; x++) {
        if (grid[y][x] !== 1) continue;
        // Draw a wall segment only where it borders a corridor, so we get
        // maze WALLS rather than a solid field of filled cells.
        const px = x * cell, py = y * cell;
        if (grid[y]?.[x + 1] === 0) { o.moveTo(px + cell, py); o.lineTo(px + cell, py + cell); }
        if (grid[y + 1]?.[x] === 0) { o.moveTo(px, py + cell); o.lineTo(px + cell, py + cell); }
      }
    }
    o.stroke();
  }

  function draw() {
    const dpr = Math.min(devicePixelRatio, 2);
    const w = innerWidth, h = innerHeight;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Ease the torch so scrolling feels like walking, not teleporting.
    torch.x += (target.x - torch.x) * 0.06;
    torch.y += (target.y - torch.y) * 0.06;

    ctx.drawImage(offscreen, 0, 0);

    // The torch: a soft radial that brightens the maze it passes over, using
    // 'source-atop' so it only lights EXISTING wall pixels and never paints a
    // visible disc on the empty background.
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    const g = ctx.createRadialGradient(
      torch.x * w * dpr, torch.y * h * dpr, 0,
      torch.x * w * dpr, torch.y * h * dpr, Math.max(w, h) * 0.42 * dpr
    );
    g.addColorStop(0, COLORS.lit);
    g.addColorStop(0.55, 'rgba(133,230,255,0.10)');
    g.addColorStop(1, 'rgba(133,230,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  let raf = null;
  function loop() {
    draw();
    raf = requestAnimationFrame(loop);
  }

  build();
  draw();

  if (!reduce) {
    loop();
    // Pointer moves the torch. Passive listener; no layout reads.
    addEventListener('pointermove', e => {
      target.x = e.clientX / innerWidth;
      target.y = e.clientY / innerHeight;
    }, { passive: true });

    // Scroll drifts it downward, so descending the page reads as descending
    // into the maze. IntersectionObserver cannot give a continuous value, and
    // a scroll listener here is one cheap assignment with no layout read.
    addEventListener('scroll', () => {
      const p = scrollY / Math.max(1, document.body.scrollHeight - innerHeight);
      target.y = 0.2 + p * 0.6;
    }, { passive: true });
  }

  let resizeTimer = null;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { build(); draw(); }, 180);
  });

  return () => { if (raf) cancelAnimationFrame(raf); };
}
