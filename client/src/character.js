import * as THREE from 'three';

/**
 * Procedural low-poly humanoid.
 *
 * Replaces the previous "sphere balanced on a cylinder", which read as a
 * chess pawn rather than a person. This builds a jointed figure with a head,
 * torso, arms and legs, and animates a walk cycle by swinging the limbs.
 *
 * ── Why procedural rather than a GLB ──────────────────────────────────────
 *
 * Eight of these are on screen at once and the maze already spends its draw
 * calls on instanced geometry. A rigged GLB per player means a loader, a
 * skinned mesh, an AnimationMixer and a network fetch before the first frame
 * renders — for a figure that is at most 40 pixels tall inside a dark
 * corridor. The silhouette is what carries at that size, so the budget goes
 * on the silhouette.
 *
 * If a real GLB is dropped in later, `loadCharacterGLB()` at the bottom is
 * the seam: it returns the same interface, so nothing else has to change.
 */

// Body proportions, in world units where one maze tile is 1.0.
const P = {
  height: 0.92,
  headR: 0.115,
  torsoW: 0.20, torsoH: 0.26, torsoD: 0.13,
  limbR: 0.045,
  armL: 0.24,
  legL: 0.28,
};

/**
 * @param {number} color        team colour
 * @param {boolean} isSaboteur  saboteurs get a heavier, hunched silhouette
 */
export function makeCharacter(color, { isSaboteur = false, decoy = false } = {}) {
  const g = new THREE.Group();

  const skin = new THREE.MeshStandardMaterial({
    color, roughness: 0.55, metalness: 0.12,
    emissive: color, emissiveIntensity: decoy ? 0.5 : 0.22,
    transparent: decoy, opacity: decoy ? 0.55 : 1,
  });

  // Darker material for limbs so the torso reads as the body's mass and the
  // figure doesn't flatten into one colour blob at distance.
  const dark = skin.clone();
  dark.color = new THREE.Color(color).multiplyScalar(0.62);
  dark.emissiveIntensity = decoy ? 0.35 : 0.10;

  const box = (w, h, d, mat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.castShadow = true;
    return m;
  };

  // ── Torso ────────────────────────────────────────────────────────────────
  const hipY = P.legL;
  const torso = box(P.torsoW, P.torsoH, P.torsoD, skin);
  torso.position.y = hipY + P.torsoH / 2;
  // A slight forward lean sells "creeping through a maze" over "standing".
  torso.rotation.x = isSaboteur ? 0.16 : 0.07;
  g.add(torso);

  // Shoulders: a slightly wider slab reads as a person even in silhouette.
  const shoulders = box(P.torsoW * 1.18, 0.07, P.torsoD * 1.05, dark);
  shoulders.position.y = hipY + P.torsoH - 0.02;
  g.add(shoulders);

  // ── Head ─────────────────────────────────────────────────────────────────
  const head = new THREE.Mesh(new THREE.SphereGeometry(P.headR, 16, 12), skin);
  head.position.y = hipY + P.torsoH + P.headR + 0.03;
  head.castShadow = true;
  g.add(head);

  // A visor rather than eyes. Eyes at this scale become two dark dots that
  // read as damage; a bright band reads as equipment and catches the torch.
  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(P.headR * 1.5, 0.035, 0.02),
    new THREE.MeshBasicMaterial({ color: isSaboteur ? 0xFF6A50 : 0x9BE8DF })
  );
  visor.position.set(0, head.position.y + 0.012, -P.headR * 0.92);
  g.add(visor);

  // ── Limbs ────────────────────────────────────────────────────────────────
  // Each limb hangs from a pivot Group so rotating the pivot swings the whole
  // limb from the joint, which is what makes the walk cycle look like walking
  // rather than the parts sliding independently.
  const limb = (len, mat) => {
    const pivot = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry
      ? new THREE.CapsuleGeometry(P.limbR, len - P.limbR * 2, 4, 8)
      : new THREE.CylinderGeometry(P.limbR, P.limbR, len, 8), mat);
    mesh.position.y = -len / 2;
    mesh.castShadow = true;
    pivot.add(mesh);
    return pivot;
  };

  const shoulderY = hipY + P.torsoH - 0.04;
  const armL = limb(P.armL, dark); armL.position.set(-P.torsoW / 2 - 0.03, shoulderY, 0);
  const armR = limb(P.armL, dark); armR.position.set(P.torsoW / 2 + 0.03, shoulderY, 0);
  const legL = limb(P.legL, dark); legL.position.set(-0.055, hipY, 0);
  const legR = limb(P.legL, dark); legR.position.set(0.055, hipY, 0);
  g.add(armL, armR, legL, legR);

  g.userData.rig = { torso, head, visor, armL, armR, legL, legR };
  g.userData.phase = Math.random() * Math.PI * 2;   // desync identical bots
  g.userData.walk = 0;

  return g;
}

/**
 * Advance the walk cycle.
 *
 * @param {THREE.Group} character
 * @param {number} dt        seconds
 * @param {number} speed     0 = still, 1 = walking
 * @param {number} facing    yaw in radians, or null to leave facing alone
 */
export function animateCharacter(character, dt, speed, facing = null) {
  const rig = character.userData.rig;
  if (!rig) return;

  // Ease the walk weight so stopping settles rather than snapping to a
  // T-pose mid-stride.
  const target = Math.min(1, speed);
  character.userData.walk += (target - character.userData.walk) * Math.min(1, dt * 8);
  const w = character.userData.walk;

  character.userData.phase += dt * (6.5 + w * 3);
  const swing = Math.sin(character.userData.phase) * 0.85 * w;

  rig.legL.rotation.x = swing;
  rig.legR.rotation.x = -swing;
  // Arms counter-swing, and slightly less than the legs — same as people.
  rig.armL.rotation.x = -swing * 0.72;
  rig.armR.rotation.x = swing * 0.72;

  // A small vertical bob on double the stride frequency. This is the single
  // cheapest thing that makes a walk read as weighted rather than gliding.
  character.position.y = Math.abs(Math.sin(character.userData.phase)) * 0.022 * w;

  if (facing !== null) {
    // Shortest-path rotation, so turning from +170° to -170° goes 20° the
    // near way instead of 340° the wrong way.
    let d = facing - character.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    character.rotation.y += d * Math.min(1, dt * 9);
  }
}

/**
 * Elimination.
 *
 * Animated rather than teleported flat: a body that simply becomes horizontal
 * between two frames reads as a rendering glitch, not a death. The collapse
 * takes about 900ms, which is long enough to notice from across a corridor
 * and short enough not to hold up the tick.
 */
export function killCharacter(character) {
  if (character.userData.dead) return;
  character.userData.dead = true;
  character.userData.deathT = 0;

  const rig = character.userData.rig;
  if (rig) {
    // Limbs go slack immediately; the fall is what takes time.
    rig.armL.rotation.x = 0.5; rig.armR.rotation.x = -0.35;
    rig.legL.rotation.x = 0.2; rig.legR.rotation.x = -0.15;
    // Kill the visor: the light going out is the clearest "this one is gone"
    // signal at distance, and it costs one material change.
    if (rig.visor?.material) rig.visor.material.color.setHex(0x3A2320);
  }
}

/** Advance a collapse. Called from the scene's render loop. */
export function updateDeath(character, dt) {
  if (!character.userData.dead) return;
  const t = character.userData.deathT ?? 0;
  if (t >= 1) return;

  const next = Math.min(1, t + dt / 0.9);
  character.userData.deathT = next;

  // Ease-out so it drops fast then settles, the way a body actually falls.
  const e = 1 - Math.pow(1 - next, 3);
  character.rotation.x = -Math.PI / 2 * e;
  character.rotation.z = 0.28 * e;
  character.position.y = 0.12 * e;

  if (next >= 1) {
    character.traverse(o => {
      if (o.material && 'emissiveIntensity' in o.material) o.material.emissiveIntensity = 0.03;
    });
  }
}

/**
 * Seam for real art.
 *
 * Drop a rigged GLB in and call this instead of makeCharacter(); it returns
 * the same { group, mixer } shape so scene.js needs no changes. Left
 * unimplemented on purpose rather than guessed at, because the rig's bone
 * names and animation clip names have to match the actual file.
 */
export async function loadCharacterGLB(url, { GLTFLoader }) {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  const group = gltf.scene;
  group.traverse(o => { if (o.isMesh) o.castShadow = true; });
  const mixer = gltf.animations?.length ? new THREE.AnimationMixer(group) : null;
  return { group, mixer, clips: gltf.animations ?? [] };
}
