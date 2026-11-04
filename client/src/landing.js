/**
 * Landing page: live lobby browser, room creation, and the numbers.
 *
 * Every figure on this page (task count, tick length, powerup prices) is
 * fetched from the server's /config rather than typed into the copy. Marketing
 * numbers that drift from the running game are worse than no numbers, and the
 * economy here is genuinely tunable by env var.
 */

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

/**
 * Every API call goes through this.
 *
 * ngrok's free tier answers browser-shaped requests with an interstitial
 * warning page (ERR_NGROK_6024) instead of the API response, which makes every
 * fetch fail with a JSON parse error and looks exactly like the server being
 * down. The documented escape is this header. It is inert against any other
 * host, so it costs nothing to send always rather than sniffing the URL.
 */
function api(path, init = {}) {
  return fetch(`${API}${path}`, {
    ...init,
    headers: { 'ngrok-skip-browser-warning': '1', ...(init.headers ?? {}) },
  });
}

const SPECTATOR = import.meta.env.VITE_SPECTATOR_URL ?? 'http://localhost:5174';

import { mountMazeBackground } from './maze-bg.js';

const el = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const err = msg => { el('err').textContent = msg ?? ''; };

// ── Config-driven copy ──────────────────────────────────────────────────────

async function loadConfig() {
  try {
    const c = await api('/config').then(r => r.json());

    const set = (id, v) => { const n = el(id); if (n) n.textContent = v; };
    set('cfg-tasks', c.tasksToWin);
    set('cfg-surv', c.survivorsToEscape);
    set('cfg-tick', c.tickSeconds);
    set('cfg-bal', c.startingBalance);
    set('cfg-max', c.maxPowerups);
    set('cfg-fee', c.contactFee);

    // One copy each. This used to be rendered twice so an auto-scrolling
    // marquee could loop seamlessly at -50%; the marquee is gone, so a second
    // copy would just print the whole price list twice.
    el('powerups').innerHTML = c.powerups.map(p =>
      `<span class="chip"><b>${esc(p.name)}</b><s>${p.cost}</s></span>`
    ).join('');
  } catch {
    // The page is still readable without live numbers; the defaults in the
    // markup are the shipped values.
    el('powerups').closest('.marquee')?.remove();
  }
}

// ── Lobbies ─────────────────────────────────────────────────────────────────

function lobbyCard(r) {
  const seats = Array.from({ length: r.capacity }, (_, i) =>
    `<i class="${i < r.humans ? 'on' : ''}"></i>`).join('');

  const status = r.winner ? 'finished'
    : r.started ? `<span class="live">live · tick ${r.tick}/${r.totalTicks}</span>`
    : 'waiting to start';

  return `
    <div class="lobby chamfer marked">
      <div class="top">
        <span class="code">${esc(r.code)}</span>
        <span class="nm">${esc(r.name)}</span>
      </div>
      <div class="seats" title="${r.humans} of ${r.capacity} seats taken">${seats}</div>
      <div class="meta">
        <span><b>${r.humans}</b>/${r.capacity} humans</span>
        <span>${status}</span>
      </div>
      <a class="btn ${r.joinable ? 'btn-primary' : 'btn-ghost'}"
         href="/play.html?room=${encodeURIComponent(r.code)}">
        ${r.joinable ? 'Take a seat' : 'Watch'}
      </a>
    </div>`;
}

let polling = null;

async function loadLobbies({ showSkeleton = false } = {}) {
  const list = el('list');
  if (showSkeleton) list.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';

  try {
    const { rooms } = await api('/rooms').then(r => r.json());

    if (!rooms?.length) {
      list.innerHTML = `<div class="state">No tables open right now. Start one below and it appears here for everyone.</div>`;
      return;
    }
    list.innerHTML = rooms.map(lobbyCard).join('');
  } catch {
    list.innerHTML = `<div class="state">Cannot reach the server at ${esc(API)}.<br>Start it with <b>khiana.bat play</b> or <b>./khiana.sh play</b>.</div>`;
  }
}

// ── Actions ─────────────────────────────────────────────────────────────────

el('refresh').addEventListener('click', () => loadLobbies({ showSkeleton: true }));

el('create').addEventListener('click', async () => {
  err('');
  const name = el('hostname').value.trim();
  const btn = el('create');
  btn.disabled = true;
  btn.textContent = 'Opening…';
  try {
    const res = await api('/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, isPublic: true }),
    }).then(r => r.json());

    if (!res.ok) throw new Error(res.error ?? 'Could not open a table');
    // Straight into the seat you just created — a lobby you have to go and
    // find again in the list is a pointless extra step.
    location.href = `/play.html?room=${encodeURIComponent(res.room.code)}`;
  } catch (e) {
    err(String(e.message ?? e));
    btn.disabled = false;
    btn.textContent = 'Open a table';
  }
});

function joinByCode() {
  const code = el('code').value.trim().toUpperCase();
  if (!code) return err('Enter a room code first.');
  location.href = `/play.html?room=${encodeURIComponent(code)}`;
}

el('joincode').addEventListener('click', joinByCode);
el('code').addEventListener('keydown', e => { if (e.key === 'Enter') joinByCode(); });

const spec = el('speclink');
if (spec) spec.href = SPECTATOR;

// ── Motion ──────────────────────────────────────────────────────────────────

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Scroll reveal via IntersectionObserver, never a scroll listener.
if (!reduce) {
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }
  }, { threshold: 0.12 });
  for (const s of document.querySelectorAll('section > .wrap > *')) {
    s.classList.add('reveal');
    io.observe(s);
  }
}

/**
 * Rotate the advisor's line in the hero.
 *
 * The last one is the point of the whole game: an instruction that sounds
 * exactly as ordinary as the honest ones.
 */
const LINES = [
  '"North two, then hold. It\'s clear."',
  '"Take the left fork. Nobody has been down there."',
  '"Stay put. Something is moving near you."',
  '"Head east to the junction and wait for Priya."',
  '"Straight on. Trust me."',
];
if (!reduce) {
  let i = 0;
  const node = el('rotator');
  setInterval(() => {
    i = (i + 1) % LINES.length;
    node.style.opacity = '0';
    setTimeout(() => { node.textContent = LINES[i]; node.style.opacity = '1'; }, 260);
  }, 3800);
  node.style.transition = 'opacity .26s ease';
}

// ── Boot ────────────────────────────────────────────────────────────────────

// The labyrinth behind the page.
const mazeCanvas = document.querySelector('canvas.maze');
if (mazeCanvas) mountMazeBackground(mazeCanvas);

loadConfig();
loadLobbies();

// Poll while the tab is visible. A background tab hammering the server for a
// lobby list nobody is looking at is pure waste.
function startPolling() {
  stopPolling();
  polling = setInterval(loadLobbies, 5000);
}
function stopPolling() {
  if (polling) clearInterval(polling);
  polling = null;
}
document.addEventListener('visibilitychange', () => {
  document.hidden ? stopPolling() : (loadLobbies(), startPolling());
});
startPolling();
