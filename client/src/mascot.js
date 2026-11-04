import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/**
 * The official advisor mascot: a glossy black sphere with big yellow eyes, a
 * yellow crown crest and an electric-blue glow.
 *
 * One reusable component. A page creates ONE instance and mounts it into
 * whichever screen is showing (join card, lobby, HUD, reveal…), so there is a
 * single WebGL context and the character carries across screens instead of
 * being re-created.
 *
 *   const m = createMascot();
 *   m.mount(hostEl, { size: 140, bubble: 'right' });
 *   m.say('Hello.', { anim: 'happy' });
 *   m.setState('mysterious');
 *
 * States: idle · blink · lookAround · track · happy · confused · sarcastic ·
 * surprised · speaking · disappointed · victory · mysterious
 *
 * Expressions are built from eye openness, eye tilt, pupil position, body
 * tilt/lean, a bounce spring and the glow, all eased toward per-state targets
 * every frame, so any state can blend into any other.
 */

const YELLOW = 0xFFD21F;
const BLUE = 0x2FA8FF;

// Per-state targets. open: 0 shut … 1 normal … 1.3 wide.
const POSE = {
  idle:         { openL: 1, openR: 1, tiltE: 0, tiltB: 0, lean: 0, glow: 0.55, crest: 0 },
  happy:        { openL: 0.55, openR: 0.55, tiltE: -0.18, tiltB: 0.12, lean: -0.06, glow: 0.8, crest: 0.15, bounce: 1, eyeY: 0.03 },
  confused:     { openL: 1.1, openR: 0.6, tiltE: 0, tiltB: 0.28, lean: 0, glow: 0.5, crest: -0.2 },
  sarcastic:    { openL: 0.42, openR: 0.62, tiltE: 0.1, tiltB: -0.14, lean: 0.05, glow: 0.5, crest: 0.1, eyeY: -0.02 },
  surprised:    { openL: 1.32, openR: 1.32, tiltE: 0, tiltB: 0, lean: 0.1, glow: 1, crest: 0.35, bounce: 0.7 },
  disappointed: { openL: 0.5, openR: 0.5, tiltE: 0.28, tiltB: -0.08, lean: 0.16, glow: 0.3, crest: -0.35, eyeY: -0.05 },
  victory:      { openL: 0.5, openR: 0.5, tiltE: -0.2, tiltB: 0, lean: -0.1, glow: 1.2, crest: 0.4, bounce: 1, spin: true, eyeY: 0.04 },
  mysterious:   { openL: 0.48, openR: 0.48, tiltE: 0.08, tiltB: 0.05, lean: 0.04, glow: 1.25, crest: 0, eyeY: 0 },
  lookAround:   { openL: 1, openR: 1, tiltE: 0, tiltB: 0, lean: 0, glow: 0.6, crest: 0, look: true },
  track:        { openL: 1.08, openR: 1.08, tiltE: 0, tiltB: 0.1, lean: -0.04, glow: 0.75, crest: 0.1, bounce: 0.5 },
};

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(64, 64, 6, 64, 64, 64);
  r.addColorStop(0, 'rgba(120,200,255,0.9)');
  r.addColorStop(0.35, 'rgba(47,168,255,0.45)');
  r.addColorStop(1, 'rgba(47,168,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function shadowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  r.addColorStop(0, 'rgba(10,12,30,0.55)'); r.addColorStop(1, 'rgba(10,12,30,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export function createMascot({ label = 'Your advisor' } = {}) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── DOM ────────────────────────────────────────────────────────────────
  const el = document.createElement('div');
  el.className = 'mascot';
  el.innerHTML = `<canvas class="mascot-cv" role="img" aria-label="${label}: a glossy black sphere with yellow eyes and a yellow crown"></canvas>
    <div class="mascot-bubble" role="status" aria-live="polite" hidden><span class="mb-text"></span></div>`;
  const canvas = el.querySelector('canvas');
  const bubble = el.querySelector('.mascot-bubble');
  const bubbleText = el.querySelector('.mb-text');

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch { renderer = null; }
  if (renderer) {
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
  } else {
    el.classList.add('mascot-fallback');   // CSS draws a flat version
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 30);
  camera.position.set(0, 0.25, 6.2);
  camera.lookAt(0, 0.12, 0);

  if (renderer) {
    // Reflections are what sell "glossy black": without an environment a
    // black clear-coat sphere renders as a flat hole.
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    pm.dispose();
  }
  scene.add(new THREE.HemisphereLight(0xffffff, 0x223355, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(-2.5, 3, 4); scene.add(key);
  const rim = new THREE.PointLight(BLUE, 30, 12, 2); rim.position.set(2.2, 0.8, -1.6); scene.add(rim);
  const rim2 = new THREE.PointLight(BLUE, 14, 12, 2); rim2.position.set(-2.4, -0.6, -1.2); scene.add(rim2);

  const rig = new THREE.Group(); scene.add(rig);       // float + bounce
  const bodyG = new THREE.Group(); rig.add(bodyG);     // tilt / lean / spin

  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: 0x07070C, metalness: 0.25, roughness: 0.16,
    clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.35,
  });
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), bodyMat);
  bodyG.add(body);

  // Crown crest: five rounded spikes on a band.
  const gold = new THREE.MeshPhysicalMaterial({ color: YELLOW, metalness: 0.35, roughness: 0.28, clearcoat: 0.8, emissive: 0x3A2A00, emissiveIntensity: 0.4 });
  const crest = new THREE.Group();
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.075, 12, 40), gold);
  band.rotation.x = Math.PI / 2;
  crest.add(band);
  [-0.6, -0.3, 0, 0.3, 0.6].forEach((a, i) => {
    const h = i === 2 ? 0.52 : i % 2 ? 0.4 : 0.32;
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.1, h, 14), gold);
    spike.position.set(Math.sin(a) * 0.42, h / 2, Math.cos(a) * 0.42 * 0.35);
    spike.rotation.z = -a * 0.55;
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 10), gold);
    tip.position.y = h / 2;
    spike.add(tip);
    crest.add(spike);
  });
  crest.position.set(0, 0.9, -0.05);
  crest.rotation.x = -0.18;
  bodyG.add(crest);

  // Eyes: yellow, emissive so they read at night, each with a pupil and glint.
  const eyeMat = new THREE.MeshStandardMaterial({ color: YELLOW, emissive: YELLOW, emissiveIntensity: 0.55, roughness: 0.25 });
  const pupilMat = new THREE.MeshStandardMaterial({ color: 0x14110A, roughness: 0.3 });
  const glintMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const eyes = [-1, 1].map(side => {
    const g = new THREE.Group();
    const white = new THREE.Mesh(new THREE.SphereGeometry(0.27, 32, 24), eyeMat);
    white.scale.set(1, 1.25, 0.45);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 16), pupilMat);
    pupil.scale.set(1, 1.2, 0.5);
    pupil.position.z = 0.1;
    const glint = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), glintMat);
    glint.position.set(-0.04, 0.06, 0.06);
    pupil.add(glint);
    g.add(white, pupil);
    // Sit the eye on the sphere's surface, turned to its normal.
    const n = new THREE.Vector3(side * 0.36, 0.16, 0.92).normalize();
    g.position.copy(n.clone().multiplyScalar(0.985));
    g.lookAt(n.clone().multiplyScalar(3));
    bodyG.add(g);
    return { g, pupil, side };
  });

  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  glow.scale.setScalar(3.6); glow.position.z = -0.6;
  scene.add(glow);
  const shadow = new THREE.Sprite(new THREE.SpriteMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }));
  shadow.scale.set(1.9, 0.45, 1); shadow.position.set(0, -1.35, 0);
  scene.add(shadow);

  // ── State ──────────────────────────────────────────────────────────────
  let state = 'idle', stateUntil = 0, night = false, speaking = false, level = 0;
  const cur = { openL: 1, openR: 1, tiltE: 0, tiltB: 0, lean: 0, glow: 0.55, crest: 0, eyeY: 0, yaw: 0, px: 0, py: 0 };
  let bounceV = 0, bounceY = 0, spin = 0, blinkT = 0, nextBlink = 2 + Math.random() * 3;
  let gaze = { x: 0, y: 0 }, gazeUntil = 0, pointerInside = false, nextLook = 3;

  function setState(name, { hold = 1800 } = {}) {
    if (!POSE[name] && name !== 'speaking') return;
    if (name === 'speaking') { speaking = true; return; }
    state = name;
    stateUntil = hold === Infinity ? Infinity : performance.now() + hold;
    if (POSE[name].bounce && !reduce) bounceV += 3.2 * POSE[name].bounce;
    if (name === 'victory') spin = 0;
  }

  /** Point the eyes at a screen position (clientX/Y); called on pointermove. */
  function lookAt(x, y) {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dx = (x - cx) / Math.max(240, innerWidth / 2), dy = (y - cy) / Math.max(240, innerHeight / 2);
    gaze = { x: Math.max(-1, Math.min(1, dx)), y: Math.max(-1, Math.min(1, dy)) };
    gazeUntil = performance.now() + 2500;
  }

  // ── Speech bubble (also the subtitles) ────────────────────────────────
  let hideTimer = 0;
  function say(text, { anim, hold } = {}) {
    if (!text) return;
    bubbleText.textContent = text;
    bubble.hidden = false;
    bubble.classList.remove('pop'); void bubble.offsetWidth; bubble.classList.add('pop');
    if (anim) setState(anim, { hold: Math.max(1800, (hold ?? 0)) });
    clearTimeout(hideTimer);
    const ms = hold ?? Math.min(9000, 1800 + text.length * 55);
    if (ms !== Infinity) hideTimer = setTimeout(() => { if (!speaking) bubble.hidden = true; }, ms);
  }
  function hideBubble() { clearTimeout(hideTimer); bubble.hidden = true; }
  function setSpeaking(on, getLevel) {
    speaking = on;
    levelFn = on ? getLevel : null;
    el.classList.toggle('is-speaking', on);
    if (!on) { clearTimeout(hideTimer); hideTimer = setTimeout(() => { bubble.hidden = true; }, 1600); }
  }
  let levelFn = null;

  function setNight(on) {
    night = on;
    el.classList.toggle('is-night', on);
  }

  // ── Interaction ───────────────────────────────────────────────────────
  const handlers = { hover: [], tap: [] };
  canvas.addEventListener('pointerenter', e => {
    if (e.pointerType !== 'mouse') return;
    pointerInside = true;
    setState('track', { hold: 1400 });
    handlers.hover.forEach(f => f());
  });
  canvas.addEventListener('pointerleave', e => {
    if (e.pointerType !== 'mouse') return;
    pointerInside = false;
    if (state === 'track') setState('idle');
  });
  canvas.addEventListener('pointerup', e => {
    if (e.pointerType === 'mouse') return;   // mouse already got hover
    setState('happy', { hold: 1200 });
    handlers.tap.forEach(f => f());
  });
  canvas.addEventListener('click', e => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    setState('happy', { hold: 1200 });
    handlers.tap.forEach(f => f());
  });
  addEventListener('pointermove', e => { if (e.pointerType === 'mouse') lookAt(e.clientX, e.clientY); }, { passive: true });

  // ── Mounting ──────────────────────────────────────────────────────────
  let size = 140;
  function mount(host, opts = {}) {
    if (!host) return;
    size = opts.size ?? size;
    el.style.setProperty('--m-size', size + 'px');
    el.dataset.bubble = opts.bubble ?? 'right';
    host.appendChild(el);
    resize();
  }
  function resize() {
    if (!renderer) return;
    renderer.setSize(size, size, false);
    canvas.style.width = canvas.style.height = size + 'px';
  }

  // ── Loop ──────────────────────────────────────────────────────────────
  let last = performance.now(), t = 0, raf = 0, visible = true;
  const ease = (a, b, k) => a + (b - a) * k;

  function frame(now = performance.now()) {
    raf = 0;
    const dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt;
    if (stateUntil !== Infinity && now > stateUntil && state !== 'idle') state = night ? 'mysterious' : 'idle';
    const p = POSE[state] ?? POSE.idle;
    const k = Math.min(1, dt * 9);

    // Blink (not while surprised: wide eyes are the expression).
    let blink = 1;
    nextBlink -= dt;
    if (nextBlink <= 0 && state !== 'surprised') { blinkT = 0.13; nextBlink = 2.2 + Math.random() * 3.6; }
    if (blinkT > 0) { blinkT -= dt; blink = 0.08; }

    // Gaze: pointer if recent, otherwise idle glances.
    let gx = 0, gy = 0;
    if (now < gazeUntil) { gx = gaze.x; gy = gaze.y; }
    else if (p.look || state === 'idle' || state === 'mysterious') {
      nextLook -= dt;
      if (nextLook <= 0) { gaze = { x: (Math.random() * 2 - 1) * 0.8, y: (Math.random() * 2 - 1) * 0.4 }; nextLook = p.look ? 0.8 : 2.5 + Math.random() * 3; gazeUntil = now + 900; }
    }

    // Speaking: open/close with the voice level, a little body pulse.
    const lv = speaking && levelFn ? Math.min(1, levelFn() * 3) : 0;
    level = ease(level, lv, Math.min(1, dt * 18));

    for (const key2 of ['openL', 'openR', 'tiltE', 'tiltB', 'lean', 'glow', 'crest', 'eyeY']) {
      cur[key2] = ease(cur[key2], p[key2] ?? 0, k);
    }
    cur.px = ease(cur.px, gx * 0.075, Math.min(1, dt * 12));
    cur.py = ease(cur.py, -gy * 0.06, Math.min(1, dt * 12));
    cur.yaw = ease(cur.yaw, gx * 0.32, Math.min(1, dt * 5));

    eyes.forEach(({ g, pupil, side }) => {
      const open = (side < 0 ? cur.openL : cur.openR) * blink * (1 + level * 0.08);
      g.scale.set(1, Math.max(0.06, open), 1);
      g.rotation.z = side * cur.tiltE;
      g.position.y = 0.16 * 0.985 / Math.hypot(0.36, 0.16, 0.92) + cur.eyeY;
      pupil.position.x = cur.px; pupil.position.y = cur.py;
    });
    eyeMat.emissiveIntensity = night ? 1.1 : 0.55;

    // Bounce spring + float.
    bounceV += (-bounceY * 60 - bounceV * 9) * dt;
    bounceY += bounceV * dt;
    const float = reduce ? 0 : Math.sin(t * 1.7) * 0.07;
    rig.position.y = float + Math.max(-0.05, bounceY * 0.35) + level * 0.02;
    const sq = 1 + (speaking ? Math.sin(t * 22) * 0.012 + level * 0.03 : 0);
    rig.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));

    if (p.spin && !reduce) spin = Math.min(Math.PI * 2, spin + dt * 7);
    bodyG.rotation.set(cur.lean, cur.yaw + (p.spin ? spin : 0), cur.tiltB + (reduce ? 0 : Math.sin(t * 0.9) * 0.03));
    crest.rotation.z = cur.crest * 0.3 * Math.sin(t * 6);
    crest.position.y = 0.9 + cur.crest * 0.05;

    const g = cur.glow * (night ? 1.35 : 1) * (1 + level * 0.3);
    glow.material.opacity = Math.min(1, g * 0.75);
    glow.scale.setScalar(3.3 + g * 0.6 + (reduce ? 0 : Math.sin(t * 2.2) * 0.08));
    rim.intensity = 18 + g * 22;
    shadow.scale.x = 1.9 - (rig.position.y) * 0.8;
    shadow.material.opacity = 0.9 - rig.position.y;

    if (renderer) renderer.render(scene, camera);
    if (visible && !document.hidden) raf = requestAnimationFrame(frame);
  }

  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  });
  io.observe(el);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && visible && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  });
  raf = requestAnimationFrame(frame);

  return {
    el, mount, setState, say, hideBubble, setSpeaking, setNight, lookAt,
    get state() { return state; },
    onHover(f) { handlers.hover.push(f); },
    onTap(f) { handlers.tap.push(f); },
  };
}
