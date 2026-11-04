import { Scene } from './scene.js';
import { mountLineup } from './lineup.js';
import { seatColor, PLAYER_COLORS } from './character.js';
import { unlock, sfx, speak, setPref, getPrefs, stopSpeaking, startAmbience, setTension, outputLevel, isUnlocked } from './audio.js';

const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8787';
const API = import.meta.env.VITE_API_URL ?? WS_URL.replace(/^ws/, 'http');

/**
 * Room + seat continuity.
 *
 * The room comes from ?room=CODE so a lobby link is shareable. The seat token
 * is kept in sessionStorage keyed by room: a refresh or a dropped connection
 * resumes the same player, same team, same accumulated bribes, instead of
 * being handed whatever seat happens to be free.
 *
 * sessionStorage, not localStorage — two tabs should be two players, which is
 * how you test a game like this on one machine.
 */
const ROOM = new URLSearchParams(location.search).get('room') || null;
const TOKEN_KEY = `khiana:seat:${ROOM ?? 'MAIN'}`;

const el = id => document.getElementById(id);
const scene = new Scene(el('stage'));

// Debug handle. Harmless in production and the only practical way to inspect
// three.js internals from an automated browser session.
if (typeof window !== 'undefined') {
  // Audio helpers hang off the same module instance the game uses. Importing
  // './audio.js' separately gives a DIFFERENT instance under Vite HMR (it
  // appends ?t=), which reports unlocked=false and looks like silence.
  window.__khiana = { scene, audio: { outputLevel, isUnlocked, sfx, startAmbience, setTension } };
}
let ws = null;
let me = null;
let mazeBuilt = false;
let myToken = null;
let isHost = false;
let started = false;
let amDead = false;

// ── Retainer descriptions ───────────────────────────────────────────────────
// The player's one pre-game strategic decision. It's public, so the wording
// has to make the trade-off obvious in a glance.
const RETAINER = [
  [85, 'Nearly incorruptible. Your advisor refuses almost everything, but it plays scared and spends nothing.'],
  [65, 'Loyal, but it will take a low-risk bribe if the ask seems harmless.'],
  [45, 'Openly mercenary. It negotiates hard and takes good deals. Everyone can see that.'],
  [0,  'For sale. It will actively solicit bribes. You will be lied to. You may also end up very rich.'],
];

function retainerText(v) {
  return RETAINER.find(([min]) => v >= min)[1];
}

// ── Join screen: your bean on a pedestal ───────────────────────────────────
// Seat colour is assigned by the server, so the preview cycles through the
// palette rather than pretending you can pick one. The antenna bulb tracks the
// retainer: pink when the advisor is for sale, cyan when it is loyal.
const gatePreview = mountLineup(el('gatestage'), { cast: [{ id: 'p1' }], spin: false, camera: { zoom: 1.0, lookY: 0.5, fov: 32 } });
let gateColor = 0;
const gateTimer = gatePreview && setInterval(() => {
  gateColor = (gateColor + 1) % PLAYER_COLORS.length;
  gatePreview.setColor(PLAYER_COLORS[gateColor]);
}, 2400);
// Blended in hue, not RGB: a straight RGB mix passes through a dull grey that
// reads as the eliminated (dark) bulb. Every retainer value stays fully lit.
function bulbFor(v) {
  const t = (v - 20) / 75;            // 0 = for sale (pink), 1 = incorruptible (cyan)
  return `hsl(${Math.round(330 - t * 145)}, 100%, 62%)`;
}

el('weight').addEventListener('input', e => {
  const v = Number(e.target.value);
  el('wv').textContent = `${v} / 100`;
  el('wd').textContent = retainerText(v);
  gatePreview?.setBulb(bulbFor(v));
  gatePreview?.pulse();
});
el('weight').dispatchEvent(new Event('input'));

el('join').addEventListener('click', () => {
  // Browsers refuse to start audio outside a user gesture, and this click is
  // the only guaranteed one before the game begins.
  unlock();
  startAmbience();
  const name = el('name').value.trim() || 'Anon';
  connect(name, Number(el('weight').value));
  el('gate').style.display = 'none';
  clearInterval(gateTimer);
  gatePreview?.destroy();
});

// ── Networking ──────────────────────────────────────────────────────────────

function connect(name, weight) {
  ws = new WebSocket(ROOM ? `${WS_URL}?room=${encodeURIComponent(ROOM)}` : WS_URL);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'JOIN', name,
      room: ROOM ?? undefined,
      token: sessionStorage.getItem(TOKEN_KEY) ?? undefined,
    }));
    ws.send(JSON.stringify({ type: 'SET_GOAL_WEIGHT', value: weight, room: ROOM ?? undefined }));
  };

  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'JOINED') {
      me = msg.playerId;
      scene.youId = me;
      if (msg.token) { myToken = msg.token; sessionStorage.setItem(TOKEN_KEY, msg.token); }
      // A token issued by a previous server run cannot resume anything. Clear
      // it so a later reload allocates a fresh seat rather than half-failing.
      if (!msg.resumed) sessionStorage.setItem(TOKEN_KEY, msg.token ?? '');
      isHost = Boolean(msg.isHost);
      started = Boolean(msg.started);
      showLobby(msg.room ?? ROOM ?? 'MAIN');
      const r = el('role');
      r.className = 'stat ' + msg.team.toLowerCase();
      r.querySelector('b').textContent = msg.team === 'SABOTEUR' ? 'Saboteur' : 'Loyalist';
    }
    if (msg.type === 'STATE' && msg.view) render(msg.view);
    if (msg.type === 'ERROR') {
      const box = el('lobby');
      if (msg.context === 'START' || (box && !box.hidden)) {
        // Surface it IN the lobby and give the button back.
        const hint = el('lhint');
        if (hint) { hint.textContent = msg.error; hint.style.color = 'var(--rust)'; }
        const btn = el('lstart');
        if (btn) { btn.disabled = false; btn.textContent = 'Start the game'; }
      }
      el('brieftext').textContent = msg.error;
    }
  };

  ws.onclose = () => {
    el('brieftext').className = 'text empty';
    el('brieftext').textContent = 'Connection lost. Reload to rejoin.';
  };
}

/**
 * Cue sound and speech from CHANGES in state, never from the state itself.
 * render() runs on every server frame (~15fps during movement), so anything
 * keyed off a raw value would retrigger continuously.
 */
const lastSeen = { tick: null, briefing: null, tasks: null, exitOpen: null, alive: null, started: null, winner: null, humans: null };

function cueAudio(view) {
  // The game beginning is the single most important audio moment: it is when
  // the player stops reading the lobby and starts playing.
  if (lastSeen.started === false && view.started === true) sfx.gameStart();

  if (view.winner && !lastSeen.winner) {
    sfx.gameOver();
    stopSpeaking();
  }

  // Another human taking a seat, so a host waiting in the lobby hears people
  // arriving instead of having to watch the seat bar.
  const humans = (view.roster ?? []).filter(p => p.name && !/^Player \d+$/.test(p.name)).length;
  if (lastSeen.humans !== null && humans > lastSeen.humans) sfx.join();

  if (lastSeen.tick !== null && view.tick !== lastSeen.tick) {
    sfx.tick();
    scene.pulseAdvisors();   // every advisor briefs on the tick
  }

  if (view.briefing && view.briefing !== lastSeen.briefing) {
    sfx.briefing();
    const b = el('briefing');
    b.classList.remove('ping'); void b.offsetWidth; b.classList.add('ping');
    // The advisor speaks. This is the game's primary channel: the player is
    // looking at a wall, so the instruction has to arrive through their ears.
    speak(view.briefing, { corrupted: false });
  }

  if (lastSeen.tasks !== null && view.tasksComplete > lastSeen.tasks) sfx.task();
  if (lastSeen.exitOpen === false && view.exitOpen === true) sfx.exitOpen();

  const alive = (view.roster ?? []).filter(p => p.alive).length;
  if (lastSeen.alive !== null && alive < lastSeen.alive) sfx.elimination();

  lastSeen.tick = view.tick;
  lastSeen.briefing = view.briefing;
  lastSeen.tasks = view.tasksComplete;
  lastSeen.exitOpen = Boolean(view.exitOpen);
  lastSeen.alive = alive;
  lastSeen.started = Boolean(view.started);
  lastSeen.winner = view.winner ?? null;
  lastSeen.humans = humans;

  // Tension tracks the two things that actually make the game dangerous:
  // how many people are left, and how little time is.
  const total = (view.roster ?? []).length || 1;
  const lost = 1 - alive / total;
  const clock = view.totalTicks ? view.tick / view.totalTicks : 0;
  setTension(Math.max(lost * 1.5, clock * 0.8));
}

/**
 * The lobby.
 *
 * The game used to begin the moment you walked in, so there was never a
 * window in which to send anyone the code. Now it waits, and only the host
 * can start it.
 */
function showLobby(code) {
  const box = el('lobby');
  if (!box) return;
  // No code means JOINED has not landed yet. Rendering the panel anyway shows
  // "----" and a dead share link, which looks broken rather than pending.
  if (!code || started) { box.hidden = true; return; }
  box.hidden = false;

  el('lcodeval').textContent = code;
  const link = `${location.origin}/play.html?room=${encodeURIComponent(code)}`;
  el('lshare').value = link;

  // Shown to everyone. A hidden button plus a stale host token was how a
  // table became unstartable with no way to tell.
  // Any seated player can start. The host label is informational only —
  // gating the button on it was how a table became unstartable.
  el('lstart').hidden = false;
  el('lstart').disabled = false;
  el('lstart').textContent = 'Start the game';
  el('lstart').className = 'btn btn-primary';
  el('lwait').hidden = true;
  el('lhint').style.color = '';
  el('lhint').textContent = isHost
    ? 'Share this link. Any seat nobody takes is played by a bot.'
    : 'Waiting on the host, but you can start it yourself whenever you like.';
}

el('lcopy')?.addEventListener('click', async () => {
  const btn = el('lcopy');
  try {
    await navigator.clipboard.writeText(el('lshare').value);
    btn.textContent = 'Copied';
  } catch {
    // Clipboard is blocked on insecure origins; selecting the text still
    // lets the host copy it by hand.
    el('lshare').select();
    btn.textContent = 'Select + copy';
  }
  setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
});

el('lstart')?.addEventListener('click', () => {
  unlock();
  const btn = el('lstart');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  ws?.send(JSON.stringify({ type: 'START', token: myToken, room: ROOM ?? undefined }));

  // If the server never confirms, give the button back rather than leaving
  // the host staring at a dead lobby.
  setTimeout(() => {
    if (!started) { btn.disabled = false; btn.textContent = 'Start the game'; }
  }, 8000);
});

/**
 * The saboteur's kill readout.
 *
 * There is no kill key. Elimination fires on its own once you have held a tile
 * next to a Loyalist for a full tick with nobody watching them, which is what
 * makes a kill something a bought advisor can ARRANGE by giving directions.
 * The rule is good; the silence around it was not. Without this panel the
 * honest reading of walking into a Loyalist and nothing happening is "the game
 * is broken", so the three states each get said out loud.
 *
 * Never rendered for Loyalists: the server sends stalk:null to them, so a
 * victim's client never even holds the fact that someone is on them.
 */
function renderStalk(stalk) {
  const box = el('stalk');
  if (!box) return;

  if (!stalk || !stalk.adjacent) { box.hidden = true; return; }

  box.hidden = false;
  const who = stalk.target?.name ?? 'them';

  if (stalk.witnessed) {
    // Naming the witness turns a dead end into a plan: break line of sight,
    // or get the witness moved. That is the interesting decision.
    box.className = 'blocked';
    box.innerHTML = `<span class="lead">Cannot strike</span>`
      + `${escapeHtml(stalk.witness ?? 'Someone')} can see ${escapeHtml(who)}. `
      + `Break their line of sight, or wait for them to move on.`;
    return;
  }

  const held = Math.min(stalk.ticksHeld, stalk.ticksNeeded);
  box.className = '';
  box.innerHTML = `<span class="lead">Unwitnessed</span>`
    + `Holding position beside ${escapeHtml(who)}. Stay adjacent and they go down.`
    + `<div class="bar"><i style="transform:scaleX(${held / (stalk.ticksNeeded || 1)})"></i></div>`;
}

function render(view) {
  if (!mazeBuilt && view.maze) { scene.buildMaze(view.maze); mazeBuilt = true; }
  cueAudio(view);

  scene.applyFog(view.visible ?? []);
  scene.updateActors(view.you, view.others ?? []);
  scene.setExit(view.exit, view.exitOpen);
  if (view.you?.pos) lastPos = { ...view.you.pos };

  el('tickstat').querySelector('b').textContent = `${view.tick}/${view.totalTicks}`;
  el('taskstat').querySelector('b').textContent = `${view.tasksComplete}/${view.tasksToWin}`;
  el('tickbar').style.transform = `scaleX(${view.tick / view.totalTicks})`;

  // Extraction is the win condition, so it gets a line in the HUD the moment
  // it matters — a player who finishes the tasks and isn't told to run has
  // been given no way to act on it.
  const ex = el('exitstat');
  if (ex) {
    ex.hidden = !view.exit;
    ex.classList.toggle('live', Boolean(view.exitOpen));
    ex.querySelector('b').textContent = view.exitOpen
      ? `OPEN (${view.exit.x},${view.exit.y}) · need ${view.survivorsToEscape}`
      : `sealed (${view.exit.x},${view.exit.y})`;
  }

  renderSeats(view.roster ?? []);
  if (view.phase === 'REVEAL') showReveal();

  // Lobby closes itself the moment the server says the game is running.
  if (view.started && !started) {
    started = true;
    const lb = el('lobby'); if (lb) lb.hidden = true;
  }

  const obj = el('objtext');
  if (obj && view.objective) {
    obj.textContent = view.objective;
    el('objective').classList.toggle('urgent', /exit|escape|dead/i.test(view.objective));
  }

  renderStalk(view.stalk);

  /**
   * Compass needle.
   *
   * Points where the advisor says to go, rotated into the player's own frame
   * so it stays correct as they turn. It is a bearing, not a map, and it is
   * exactly as trustworthy as the advisor behind it.
   */
  const comp = el('compass');
  if (comp) {
    if (view.guide) {
      comp.hidden = false;
      const rel = view.guide.bearing - yaw;
      el('needle').style.transform = `rotate(${rel}rad)`;
      el('compassdist').textContent = `${view.guide.distance} tiles`;
    } else {
      comp.hidden = true;
    }
  }

  // Death: the overlay appears once, and input stops for good.
  if (view.you && view.you.alive === false && !amDead) {
    amDead = true;
    sfx.elimination();
    stopSpeaking();
    const d = el('dead'); if (d) d.hidden = false;
  }

  const bt = el('brieftext');
  if (view.briefing) {
    bt.className = 'text';
    bt.textContent = view.briefing;
  }

  // The roster lists everyone but marks nobody. `team` arrives as null for any
  // player whose allegiance you have not earned, so the only two numbers on
  // this panel are the ones you are meant to reason about: who is still alive,
  // and how corruptible each advisor publicly is.
  el('rosterlist').innerHTML = (view.roster ?? []).map((p, i) => `
    <div class="r ${p.team === 'SABOTEUR' ? 'sab' : ''} ${p.alive ? '' : 'dead'}">
      <span class="dot" style="background:${hex(seatColor(p.id, i))}"></span>
      <span class="n">${escapeHtml(p.name)}${p.id === me ? ' (you)' : ''}</span>
      <span class="w">${p.agentGoal}</span>
    </div>`).join('');
}

const hex = n => '#' + n.toString(16).padStart(6, '0');
const isHuman = p => p.name && !/^Player \d+$/.test(p.name);

/** Lobby seat bar: one bean slot per seat, filled in that seat's colour. */
function renderSeats(roster) {
  const box = el('lseats');
  if (!box || el('lobby').hidden) return;
  const humans = roster.filter(isHuman);
  const total = roster.length || 8;
  box.innerHTML = Array.from({ length: total }, (_, i) => {
    const p = humans[i];
    return p ? `<i class="on" style="background:${hex(seatColor(p.id, i))}" title="${escapeHtml(p.name)}"></i>` : '<i></i>';
  }).join('');
  el('lseatlbl').textContent = `${humans.length} of ${total} seats taken by people. Bots take the rest.`;
}

/**
 * The verdict. Once the server enters REVEAL the whole ledger is public, so
 * the screen fetches it and shows who was who. Only called in REVEAL: the
 * endpoint finishes the round if no reveal exists yet.
 */
let revealShown = false;
let overStage = null;
async function showReveal() {
  if (revealShown) return;
  revealShown = true;
  let data;
  try {
    const q = ROOM ? `?room=${encodeURIComponent(ROOM)}` : '';
    data = await fetch(`${API}/game/reveal${q}`, { headers: { 'ngrok-skip-browser-warning': '1' } }).then(r => r.json());
  } catch {
    revealShown = false;   // try again on the next frame
    return;
  }
  const agents = Object.entries(data.perAgent ?? {});
  const win = data.winner;
  const t = el('overtitle');
  t.textContent = win === 'SABOTEUR' ? 'Saboteurs win!' : win === 'LOYALIST' ? 'Loyalists win!' : 'Round over';
  t.className = 'title ' + (win === 'SABOTEUR' ? 'sab' : 'loy');
  const myTeam = data.perAgent?.[me]?.team;
  el('oversub').textContent = myTeam
    ? (myTeam === win ? 'Your team took it.' : 'Your team lost this one.') + ' The ledger is open.'
    : 'The ledger is open.';

  el('overtotals').innerHTML = `
    <span><b>${data.totalBribed ?? 0}</b> KHIA in bribes</span>
    <span><b>${data.betrayals ?? 0}</b> bribes followed</span>
    <span><b>${data.totalBurned ?? 0}</b> KHIA burned on powerups</span>`;

  el('overlist').innerHTML = agents.map(([id, a], i) => {
    const sab = a.team === 'SABOTEUR';
    const took = (a.received ?? []).length;
    const paid = (a.paid ?? []).length;
    return `<div class="res ${a.alive ? '' : 'out'} ${id === me ? 'you' : ''}" style="animation-delay:${i * 60}ms">
      <span class="dot" style="background:${hex(seatColor(id, i))}"></span>
      <span class="nm">${escapeHtml(a.player)}${id === me ? ' (you)' : ''}</span>
      <span class="tm ${sab ? 'sab' : 'loy'}">${sab ? 'Saboteur' : 'Loyalist'}</span>
      <span class="meta">${a.alive ? 'Survived' : 'Eliminated'} · ${a.finalBalance} KHIA · took ${took} bribe${took === 1 ? '' : 's'}, paid ${paid}</span>
    </div>`;
  }).join('');

  el('over').hidden = false;
  stopSpeaking();
  overStage = mountLineup(el('overstage'), {
    cast: agents.map(([id, a]) => ({ id, team: a.team, alive: a.alive, winner: a.alive && a.team === win })),
    camera: { zoom: 1.05, lookY: 0.2, fov: 28, minH: 2.6 },
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Input ───────────────────────────────────────────────────────────────────

/**
 * First-person input.
 *
 * The server speaks absolute grid deltas (dx, dy) and knows nothing about
 * facing — that stays true. The client turns "forward" into whichever grid
 * axis the player is most nearly looking down, so the protocol is unchanged
 * and the movement still lands on tile centres.
 *
 * Snapping to the dominant axis rather than allowing diagonals is deliberate:
 * the maze is a grid, and a diagonal step would either clip a wall corner or
 * need collision rules the server does not have.
 */

let yaw = 0;
let pitch = 0;

const MOVE = {
  KeyW: [1, 0], ArrowUp: [1, 0],
  KeyS: [-1, 0], ArrowDown: [-1, 0],
  KeyA: [0, -1],
  KeyD: [0, 1],
};
// Arrow left/right turn rather than strafe — it's what a keyboard-only player
// expects, and without a turn key a trackpad user cannot look around at all.
const TURN = { ArrowLeft: -1, ArrowRight: 1 };
const TURN_STEP = Math.PI / 8;

/** Project forward/strafe intent onto the dominant grid axis. */
function gridStep(fwd, strafe) {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);   // forward
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);    // right
  const vx = fx * fwd + rx * strafe;
  const vz = fz * fwd + rz * strafe;
  if (Math.abs(vx) >= Math.abs(vz)) {
    return Math.abs(vx) > 0.001 ? [Math.sign(vx), 0] : null;
  }
  return Math.abs(vz) > 0.001 ? [0, Math.sign(vz)] : null;
}

let lastMove = 0;
let lastPos = null;
function move(dx, dy) {
  if (amDead) return;    // eliminated players watch, they do not walk
  const now = performance.now();
  if (now - lastMove < 110) return;    // movement rate cap
  lastMove = now;
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: 'MOVE', dx, dy, room: ROOM ?? undefined,
    // 0=N 1=E 2=S 3=W, from the camera. Lets the server phrase directions
    // relative to where the player is actually looking.
    //
    // NEGATED yaw: the forward vector is (-sin y, -cos y), so turning right
    // makes yaw go negative while the compass index must go UP. Without the
    // minus the advisor says "turn left" when it means right, which is worse
    // than giving no directions at all.
    facing: ((Math.round(-yaw / (Math.PI / 2)) % 4) + 4) % 4,
  }));

  // The server is authoritative about walls, so wait for the state it sends
  // back rather than guessing here: if the position changed it was a step,
  // if it did not we walked into something.
  const before = lastPos;
  setTimeout(() => {
    if (!before || !lastPos) return;
    (before.x === lastPos.x && before.y === lastPos.y) ? sfx.bump() : sfx.step();
  }, 90);
}

function step(fwd, strafe) {
  const d = gridStep(fwd, strafe);
  if (d) move(d[0], d[1]);
}

addEventListener('keydown', e => {
  if (TURN[e.code] !== undefined) {
    e.preventDefault();
    yaw -= TURN[e.code] * TURN_STEP;
    scene.setLook(yaw, pitch);
    return;
  }
  const m = MOVE[e.code];
  if (m) { e.preventDefault(); step(m[0], m[1]); }
});

// ── Mouse look ──────────────────────────────────────────────────────────────
// Pointer lock is the right feel, but it swallows the cursor — so it is opt-in
// by clicking the view, and Escape gives the cursor back for the HUD.

const stage = el('stage');
const SENS = 0.0022;

stage.addEventListener('click', () => {
  if (!document.pointerLockElement) stage.requestPointerLock?.();
});

addEventListener('mousemove', e => {
  if (document.pointerLockElement !== stage) return;
  yaw -= e.movementX * SENS;
  pitch -= e.movementY * SENS;
  scene.setLook(yaw, pitch);
});

// Drag-to-look for anyone who does not want pointer lock, and for touch.
let dragging = null;
stage.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && document.pointerLockElement) return;
  dragging = { x: e.clientX, y: e.clientY };
});
addEventListener('pointerup', () => { dragging = null; });
addEventListener('pointermove', e => {
  if (!dragging) return;
  yaw -= (e.clientX - dragging.x) * SENS * 1.6;
  pitch -= (e.clientY - dragging.y) * SENS * 1.6;
  dragging = { x: e.clientX, y: e.clientY };
  scene.setLook(yaw, pitch);
});

// ── On-screen dpad (mobile) ─────────────────────────────────────────────────
// Repurposed to forward/back/turn, because absolute compass directions are
// meaningless once the camera is inside the maze.
for (const b of document.querySelectorAll('#dpad button')) {
  const dx = Number(b.dataset.dx), dy = Number(b.dataset.dy);
  const fire = e => {
    e.preventDefault();
    if (dy === -1) step(1, 0);          // up    → forward
    else if (dy === 1) step(-1, 0);     // down  → back
    else if (dx === -1) { yaw += TURN_STEP; scene.setLook(yaw, pitch); }
    else if (dx === 1) { yaw -= TURN_STEP; scene.setLook(yaw, pitch); }
  };
  b.addEventListener('click', fire);
  b.addEventListener('touchstart', fire, { passive: false });
}

// ── Loop ────────────────────────────────────────────────────────────────────

let prev = performance.now();
(function frame(t) {
  const dt = Math.min((t - prev) / 1000, 0.1);
  prev = t;
  scene.render(dt);
  requestAnimationFrame(frame);
})(prev);
