import * as THREE from 'three';
import { makeCharacter, animateCharacter, pulseAntenna, killCharacter, updateDeath, setTeamEyes, seatColor, INK } from './character.js';

/**
 * A small WebGL stage for menus: the landing lineup, the join screen's
 * character preview, and the end-of-round podium.
 *
 * One renderer per canvas, transparent so the page's sky shows through, and
 * it stops drawing when the canvas is off screen.
 *
 * cast: [{ id, color?, team?, alive?, winner?, you? }]
 */
export function mountLineup(canvas, { cast = [], spin = false, camera: camOpts = {} } = {}) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    return null;   // no WebGL: the page still reads without the figures
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(camOpts.fov ?? 30, 1, 0.1, 50);

  scene.add(new THREE.HemisphereLight(0xFFFFFF, 0x7A86C8, 2.2));
  const sun = new THREE.DirectionalLight(0xFFFFFF, 2.4);
  sun.position.set(-2, 4, -3);
  scene.add(sun);

  const stage = new THREE.Group();
  scene.add(stage);
  let figures = [];
  let bulb = null;

  function podium(width) {
    const grp = new THREE.Group();
    const top = new THREE.Mesh(
      new THREE.CylinderGeometry(width, width * 1.04, 0.14, 48),
      new THREE.MeshToonMaterial({ color: 0xFFF3D6 })
    );
    const rim = new THREE.Mesh(
      new THREE.CylinderGeometry(width * 1.06, width * 1.1, 0.12, 48),
      new THREE.MeshBasicMaterial({ color: INK })
    );
    rim.position.y = -0.03;
    top.position.y = 0.0;
    grp.add(rim, top);
    grp.position.y = -0.07;
    return grp;
  }

  function setCast(list) {
    for (const f of figures) stage.remove(f.root);
    stage.clear();
    figures = [];

    const n = Math.max(1, list.length);
    const gap = n > 5 ? 0.5 : 0.62;
    const width = (n - 1) * gap;
    stage.add(podium(Math.max(0.42, width / 2 + (n > 5 ? 0.22 : 0.38))));

    list.forEach((c, i) => {
      const root = makeCharacter(c.color ?? seatColor(c.id, i), { isSaboteur: c.team === 'SABOTEUR' });
      if (c.team) setTeamEyes(root, c.team);
      // A shallow arc so the outer figures turn in toward the middle.
      const x = -width / 2 + i * gap;
      const z = Math.abs(x) * 0.28;
      root.position.set(x, 0.0, z);
      root.rotation.y = Math.PI - x * 0.35;   // face the camera (beans face -Z), outer ones turned inward
      root.userData.hop = c.winner ? 1 : 0;
      root.userData.baseY = 0;
      if (c.alive === false) { killCharacter(root); root.userData.deathT = 0.999; }
      stage.add(root);
      figures.push({ root, c });
    });
    frame();
  }

  function fit() {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const n = Math.max(1, figures.length);
    const span = Math.max(1.3, (n - 1) * (n > 5 ? 0.5 : 0.62) + 1.0);
    // Distance at which the row fits horizontally and a figure plus podium
    // (~1.6 units) fits vertically; zoom > 1 adds margin.
    const k = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const dist = Math.max(span / (k * camera.aspect), (camOpts.minH ?? 1.6) / k) * (camOpts.zoom ?? 1.1);
    camera.position.set(0, dist * 0.32 + 0.5, dist);
    camera.lookAt(0, camOpts.lookY ?? 0.42, 0);
    camera.updateProjectionMatrix();
  }

  let t = 0, last = performance.now(), visible = true, raf = 0;
  let nextPulse = 0.6;
  function frame(now = performance.now()) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;

    if (t > nextPulse && figures.length) {
      pulseAntenna(figures[Math.floor(Math.random() * figures.length)].root);
      nextPulse = t + 0.7 + Math.random() * 0.9;
    }
    figures.forEach(({ root }, i) => {
      if (root.userData.dead) { updateDeath(root, dt); return; }
      animateCharacter(root, dt, 0);
      // Winners bounce; everyone else idles with a small offset sway.
      const hop = root.userData.hop ? Math.abs(Math.sin(t * 4 + i)) * 0.16 : 0;
      root.position.y = hop;
      if (!spin) root.rotation.y = Math.PI - root.position.x * 0.35 + Math.sin(t * 0.8 + i * 1.7) * 0.18;
    });
    if (spin) stage.rotation.y += dt * 0.6;

    renderer.render(scene, camera);
    if (!reduce && visible) raf = requestAnimationFrame(frame);
  }

  const io = new IntersectionObserver(([e]) => {
    const was = visible;
    visible = e.isIntersecting;
    if (visible && !was && !reduce) { last = performance.now(); raf = requestAnimationFrame(frame); }
  });
  io.observe(canvas);
  const ro = new ResizeObserver(() => { fit(); if (reduce) frame(); });
  ro.observe(canvas);

  setCast(cast);
  fit();

  return {
    setCast(list) { setCast(list); fit(); },
    /** Recolour every figure (join preview). */
    setColor(hex) {
      const rot = stage.rotation.y;
      setCast(figures.map(f => ({ ...f.c, color: hex })));
      stage.rotation.y = rot;
      if (bulb != null) this.setBulb(bulb);
      fit();
    },
    pulse() { for (const { root } of figures) pulseAntenna(root); },
    setBulb(hex) {
      bulb = hex;
      for (const { root } of figures) root.userData.bulbIdle = new THREE.Color(hex);
    },
    destroy() { cancelAnimationFrame(raf); io.disconnect(); ro.disconnect(); renderer.dispose(); },
  };
}
