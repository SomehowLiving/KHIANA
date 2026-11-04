import * as THREE from 'three';

/**
 * The antenna bean.
 *
 * A chunky toy figure: a capsule body, a glass visor with two eye lights,
 * stubby arms and feet, and an antenna whose bulb is the advisor link. The
 * bulb pulses when an advisor briefs and goes dark when its player is out.
 *
 * Built procedurally (no GLB) because eight of these share a frame with an
 * instanced maze, and the silhouette is what carries at corridor distance.
 * The interface (makeCharacter / animateCharacter / killCharacter /
 * updateDeath, and rig.armL/armR/legL/legR) is unchanged from the old figure,
 * so scene.js and the menus can use either.
 *
 * Seat colour is identity only, never team. The only team tell is the eye
 * colour, and it is set only when the viewer already knows the team (a
 * saboteur seeing a fellow saboteur, or the end-of-round reveal).
 */

export const INK = 0x1B1F4B;
export const EYE_LOYAL = 0x7FF3FF;
export const EYE_SAB = 0xFF3D7F;

// Per-seat character colours (p1..p8). Keep in sync with spectator/src/main.js.
export const PLAYER_COLORS = [0x2FB8F5, 0xFF8A3D, 0x6ED34A, 0xFF5FA8, 0xFFC93C, 0x5B6CFF, 0x22D6A0, 0xB070FF];
export function seatColor(id, fallbackIndex = 0) {
  const m = /(\d+)/.exec(String(id ?? ''));
  const i = m ? Number(m[1]) - 1 : fallbackIndex;
  return PLAYER_COLORS[((i % 8) + 8) % 8];
}

// Three-band toon ramp shared by every bean: the stepped shading is what
// makes it read as a toy rather than a lit plastic render.
let ramp = null;
function toonRamp() {
  if (ramp) return ramp;
  const data = new Uint8Array([90, 90, 90, 255, 175, 175, 175, 255, 255, 255, 255, 255]);
  ramp = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
  ramp.needsUpdate = true;
  return ramp;
}

const outlineMat = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });

/** Inverted-hull outline: a slightly larger back-faced copy in navy. */
function outlined(geo, mat, grow = 1.08) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(geo, mat);
  const o = new THREE.Mesh(geo, outlineMat);
  o.scale.setScalar(grow);
  g.add(o, m);
  g.userData.mesh = m;
  return g;
}

const B = {
  r: 0.2,          // body radius
  len: 0.34,       // capsule straight section
  footY: 0.07,
};

/**
 * @param {number} color  per-seat identity colour (never team)
 * @param {{isSaboteur?: boolean, decoy?: boolean, scale?: number}} opts
 */
export function makeCharacter(color, { isSaboteur = false, decoy = false, scale = 1 } = {}) {
  const root = new THREE.Group();
  const g = new THREE.Group();          // inner group takes the hop/lean
  root.add(g);

  const body = new THREE.MeshToonMaterial({
    color, gradientMap: toonRamp(),
    transparent: decoy, opacity: decoy ? 0.55 : 1,
  });
  const limbMat = body.clone();
  limbMat.color = new THREE.Color(color).multiplyScalar(0.78);
  const belly = new THREE.MeshToonMaterial({ color: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.55), gradientMap: toonRamp() });

  // ── Body ────────────────────────────────────────────────────────────────
  const bodyY = B.footY + B.r + B.len / 2 + 0.04;
  const torso = outlined(new THREE.CapsuleGeometry(B.r, B.len, 6, 16), body, 1.07);
  torso.position.y = bodyY;
  g.add(torso);

  // Belly patch, a flattened sphere on the front.
  const bellyM = new THREE.Mesh(new THREE.SphereGeometry(B.r * 0.72, 16, 12), belly);
  bellyM.scale.set(1, 1.1, 0.42);
  bellyM.position.set(0, bodyY - 0.08, -B.r * 0.78);
  g.add(bellyM);

  // ── Visor + eyes ────────────────────────────────────────────────────────
  const visorY = bodyY + B.len / 2 - 0.01;
  const visor = outlined(
    new THREE.CapsuleGeometry(0.075, 0.17, 4, 12),
    new THREE.MeshToonMaterial({ color: 0x23285C, gradientMap: toonRamp() }),
    1.12
  );
  visor.rotation.z = Math.PI / 2;
  visor.scale.set(1, 1, 0.75);
  visor.position.set(0, visorY, -B.r * 0.86);
  g.add(visor);

  const eyeMat = new THREE.MeshBasicMaterial({ color: isSaboteur ? EYE_SAB : EYE_LOYAL });
  const eyeGeo = new THREE.CapsuleGeometry(0.022, 0.045, 3, 8);
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
  eyeL.position.set(-0.06, visorY + 0.004, -B.r * 0.86 - 0.062);
  eyeR.position.set(0.06, visorY + 0.004, -B.r * 0.86 - 0.062);
  g.add(eyeL, eyeR);

  // ── Antenna: the advisor link ───────────────────────────────────────────
  const topY = bodyY + B.len / 2 + B.r;
  const stalk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.016, 0.16, 6),
    new THREE.MeshBasicMaterial({ color: INK })
  );
  stalk.position.y = topY + 0.07;
  const bulbMat = new THREE.MeshBasicMaterial({ color: 0xFFE14D });
  const bulb = outlined(new THREE.SphereGeometry(0.045, 12, 10), bulbMat, 1.25);
  bulb.position.y = topY + 0.17;
  g.add(stalk, bulb);

  // ── Limbs ───────────────────────────────────────────────────────────────
  const limb = (r, len, mat) => {
    const pivot = new THREE.Group();
    const part = outlined(new THREE.CapsuleGeometry(r, len, 4, 10), mat, 1.18);
    part.position.y = -len / 2 - r * 0.4;
    pivot.add(part);
    return pivot;
  };
  const armL = limb(0.045, 0.12, limbMat); armL.position.set(-B.r - 0.03, bodyY + 0.02, 0); armL.rotation.z = -0.35;
  const armR = limb(0.045, 0.12, limbMat); armR.position.set(B.r + 0.03, bodyY + 0.02, 0); armR.rotation.z = 0.35;
  const legL = limb(0.055, 0.05, limbMat); legL.position.set(-0.085, B.footY + 0.09, 0);
  const legR = limb(0.055, 0.05, limbMat); legR.position.set(0.085, B.footY + 0.09, 0);
  g.add(armL, armR, legL, legR);

  root.scale.setScalar(scale);
  root.userData.rig = { inner: g, torso, head: torso, visor, eyeMat, bulb, bulbMat, armL, armR, legL, legR };
  root.userData.phase = Math.random() * Math.PI * 2;
  root.userData.walk = 0;
  root.userData.pulse = 0;
  return root;
}

/** Light the antenna bulb; it fades back over ~0.8s in animateCharacter. */
export function pulseAntenna(character) {
  if (!character.userData.dead) character.userData.pulse = 1;
}

/** Set eye colour once a team is known (reveal screen). */
export function setTeamEyes(character, team) {
  const rig = character.userData.rig;
  rig?.eyeMat.color.setHex(team === 'SABOTEUR' ? EYE_SAB : EYE_LOYAL);
}

const BULB_IDLE = new THREE.Color(0xFFE14D);
const BULB_HOT = new THREE.Color(0xFFFFFF);

/**
 * Advance the walk cycle.
 * @param {number} speed  0 = still, 1 = walking
 * @param {number|null} facing  yaw in radians, or null to leave facing alone
 */
export function animateCharacter(character, dt, speed, facing = null) {
  const rig = character.userData.rig;
  if (!rig) return;

  const target = Math.min(1, speed);
  character.userData.walk += (target - character.userData.walk) * Math.min(1, dt * 8);
  const w = character.userData.walk;

  character.userData.phase += dt * (5 + w * 6);
  const ph = character.userData.phase;
  const swing = Math.sin(ph) * 0.9 * w;

  rig.legL.rotation.x = swing;
  rig.legR.rotation.x = -swing;
  rig.armL.rotation.x = -swing * 0.8;
  rig.armR.rotation.x = swing * 0.8;

  // Toy waddle: side-to-side roll while walking, a slow breathing squash
  // while idle. Both are on the inner group so position stays authoritative.
  rig.inner.rotation.z = Math.sin(ph) * 0.12 * w;
  rig.inner.position.y = Math.abs(Math.sin(ph)) * 0.05 * w;
  const breathe = 1 + Math.sin(ph * 0.5) * 0.025 * (1 - w);
  rig.inner.scale.set(1 / Math.sqrt(breathe), breathe, 1 / Math.sqrt(breathe));

  // Antenna pulse decays.
  if (character.userData.pulse > 0) {
    character.userData.pulse = Math.max(0, character.userData.pulse - dt * 1.3);
  }
  rig.bulbMat.color.copy(character.userData.bulbIdle ?? BULB_IDLE).lerp(BULB_HOT, character.userData.pulse);
  rig.bulb.scale.setScalar(1 + character.userData.pulse * 0.6);

  if (facing !== null) {
    let d = facing - character.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    character.rotation.y += d * Math.min(1, dt * 9);
  }
}

/** Elimination: limbs go slack, the bean tips over, the antenna goes dark. */
export function killCharacter(character) {
  if (character.userData.dead) return;
  character.userData.dead = true;
  character.userData.deathT = 0;
  const rig = character.userData.rig;
  if (rig) {
    rig.armL.rotation.x = 0.6; rig.armR.rotation.x = -0.4;
    rig.legL.rotation.x = 0.3; rig.legR.rotation.x = -0.2;
    rig.bulbMat.color.setHex(0x4A4E70);
    rig.bulb.scale.setScalar(1);
    rig.eyeMat.color.setHex(0x3A3F66);
  }
}

/** Advance a collapse: a little hop, then a flop onto its back. */
export function updateDeath(character, dt) {
  if (!character.userData.dead) return;
  const t = character.userData.deathT ?? 0;
  if (t >= 1) return;
  const next = Math.min(1, t + dt / 0.9);
  character.userData.deathT = next;
  const e = 1 - Math.pow(1 - next, 3);
  const inner = character.userData.rig?.inner ?? character;
  inner.rotation.x = Math.PI / 2 * e;
  inner.rotation.z = 0;
  inner.scale.set(1, 1, 1);
  inner.position.y = Math.sin(next * Math.PI) * 0.18 + 0.12 * e;
}

/** Seam for real art: a rigged GLB can replace makeCharacter() later. */
export async function loadCharacterGLB(url, { GLTFLoader }) {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  const group = gltf.scene;
  group.traverse(o => { if (o.isMesh) o.castShadow = true; });
  const mixer = gltf.animations?.length ? new THREE.AnimationMixer(group) : null;
  return { group, mixer, clips: gltf.animations ?? [] };
}
