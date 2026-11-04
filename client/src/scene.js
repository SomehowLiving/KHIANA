import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';

import { makeCharacter, animateCharacter, killCharacter, updateDeath } from './character.js';

/**
 * First-person scene.
 *
 * The camera sits inside the player's head, below the top of the walls. That
 * single fact does most of the work: you cannot see over a wall, so you only
 * ever see the corridor you are standing in and whatever is directly down it.
 * The isometric version could not deliver that — looking down at 35° means
 * looking over every wall in the maze at once, which is why it felt like you
 * could see too much no matter how tight the fog was set.
 *
 * Three layers combine to enforce the horizon:
 *
 *   1. Geometry  — walls are taller than eye height, so they occlude.
 *   2. Fog       — exponential, dense, so distance falls off fast.
 *   3. Server fog— the authoritative `visible` set still gates what is lit.
 *
 * Only layer 3 is security. Layers 1 and 2 are feel. Never compute visibility
 * here: the server decides, and anything the client could recompute, devtools
 * could reveal.
 */

const TILE = 1;

// Above eye height on purpose. A wall shorter than the camera is a window.
const WALL_H = 2.4;
const EYE_H = 0.62;

const COLORS = {
  ink:      0x05070B,
  fogWall:  0x11161F,
  litWall:  0x3A465F,
  fogFloor: 0x0A0E15,
  litFloor: 0x1F2739,
  ceiling:  0x080B11,
  bone:     0xE8E3D9,
  amber:    0xE5A93C,
  rust:     0xC2503A,
  teal:     0x5FA8A0,
  violet:   0x7B6CD9,
};

export class Scene {
  constructor(container) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COLORS.ink);

    /**
     * Exponential fog, not linear.
     *
     * FogExp2 falls off with the square of distance, so nearby geometry stays
     * readable while anything a few tiles out is gone. Linear fog needs a
     * near/far pair tuned to the camera distance — which is what silently
     * blanked the entire isometric scene when the camera sat past the far
     * plane. Density has no such failure mode.
     */
    this.scene.fog = new THREE.FogExp2(COLORS.ink, 0.34);

    // Human-ish FOV. Wider looks fish-eyed in a 1-metre corridor and makes the
    // maze feel larger, which is the opposite of what we want.
    this.camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.05, 60);
    this.camera.rotation.order = 'YXZ';   // yaw then pitch — no roll, ever
    this.camera.position.set(0, EYE_H, 0);

    this.yaw = 0;
    this.pitch = 0;

    // Cold ambient fill, kept low on purpose. This is a torch in a dark maze:
    // ambient exists only to keep unlit geometry off pure black, never to light
    // the room. At 2.0 it washed the whole corridor to near-white and the torch
    // stopped meaning anything, which is the opposite of the intent.
    this.scene.add(new THREE.AmbientLight(0x223047, 0.85));

    /**
     * The torch. A forward cone from the player's head, which is the only
     * meaningful light source down here.
     *
     * Shadows are off for this light deliberately: a shadow-casting spotlight
     * that moves every frame forces a shadow-map re-render each frame, and in
     * a corridor where the walls already occlude everything it buys almost no
     * visual information for a large cost on integrated GPUs.
     */
    // decay MUST be 2, and intensity has to be sized for the NEAREST surface,
    // not the far end of the corridor. three.js r155+ uses physical units, so a
    // wall receives intensity / distance^decay; corridors are TILE=1 wide, so
    // the wall you are facing sits about 0.5 away and gets a 4x multiplier
    // before intensity is even applied. Measured at spawn facing a wall, the
    // share of pixels brighter than 0.70 luminance was 3.1% at intensity 9 and
    // 0% at 6. Five leaves margin and keeps the maze genuinely dark.
    this.torch = new THREE.SpotLight(0xFFD9A0, 5, 9, Math.PI / 5, 0.6, 2);
    this.torch.position.set(0, EYE_H, 0);
    this.torchTarget = new THREE.Object3D();
    this.scene.add(this.torch, this.torchTarget);
    this.torch.target = this.torchTarget;

    // A small point light at the head stops the immediate floor from going
    // pure black at your feet, which reads as falling into a hole.
    this.headLamp = new THREE.PointLight(0xFFC98A, 0.65, 3.2, 2);
    this.scene.add(this.headLamp);

    this.setupPost();

    this.walls = null;
    this.floors = null;
    this.ceiling = null;
    this.tileIndex = new Map();   // "x,y" -> { kind, i }
    this.actors = new Map();      // playerId -> Group
    this.markers = new Map();

    addEventListener('resize', () => this.onResize());
  }

  /**
   * Post-processing: bloom then vignette, and nothing else.
   *
   * Bloom is doing real work here rather than decoration — the torch, the
   * visors and the extraction beam are the only light sources in a black
   * maze, and bleeding them slightly is what makes them read as light rather
   * than as bright polygons. Threshold is high so only those genuinely bright
   * pixels bloom; a low threshold would fog the whole corridor.
   *
   * The vignette does the opposite job: it crushes the screen edges, which
   * tightens the sense of a corridor closing in and hides the hard edge where
   * FogExp2 reaches full density.
   *
   * Both are cheap. Deliberately skipped: SSAO, DOF and FXAA — each is another
   * full-screen pass, and this game must hold framerate on an integrated GPU
   * in a venue, not win a rendering benchmark.
   */
  setupPost() {
    const half = new THREE.Vector2(innerWidth / 2, innerHeight / 2);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    // Half-resolution bloom. At this blur radius the difference is invisible
    // and it costs a quarter of the fill rate.
    //
    // Threshold sits ABOVE the torch's lit-wall response on purpose. At 0.62 it
    // sat below it, so every lit surface bloomed and the corridor turned into
    // one soft blob with no readable geometry. Only genuine emissives (the exit
    // beam, task markers) should bloom.
    this.bloom = new UnrealBloomPass(half, 0.28, 0.5, 0.92);
    this.composer.addPass(this.bloom);

    // FogExp2 already darkens with distance, which reads as a vignette from
    // inside a corridor. Stacking a real vignette on top darkened the image
    // twice and was most of why the maze went unreadable, so this is a light
    // touch rather than the 1.25 it used to be.
    this.vignette = new ShaderPass(VignetteShader);
    this.vignette.uniforms.offset.value = 1.1;
    this.vignette.uniforms.darkness.value = 0.6;
    this.composer.addPass(this.vignette);

    // Off by default. The scene's lighting was tuned with no post at all, and
    // that is the look to match; post is an opt-in extra via ?post=1, never a
    // silent change to how the game reads. A weak device never gets it.
    const weak = /iPhone|iPad|Android/i.test(navigator.userAgent)
      || (navigator.hardwareConcurrency ?? 8) <= 4;
    this.postEnabled = !weak
      && new URLSearchParams(location.search).get('post') === '1';
  }

  onResize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.composer?.setSize(innerWidth, innerHeight);
    this.bloom?.resolution.set(innerWidth / 2, innerHeight / 2);
  }

  /** Look direction, in radians. Driven by mouse / touch / Q-E from main.js. */
  setLook(yaw, pitch = this.pitch) {
    this.yaw = yaw;
    // Clamped so you can glance at the floor and ceiling but never roll over.
    this.pitch = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, pitch));
  }

  /** Unit forward vector on the XZ plane — main.js maps this to a grid step. */
  forward() {
    return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) };
  }

  /**
   * Build maze geometry as InstancedMeshes: one draw call for every wall, one
   * for every floor tile. A 49x49 grid is ~2400 tiles and individual meshes
   * would tank the framerate on a phone.
   */
  buildMaze(tiles) {
    for (const m of [this.walls, this.floors, this.ceiling]) {
      if (m) { this.scene.remove(m); m.geometry?.dispose(); m.material?.dispose(); }
    }
    this.tileIndex.clear();

    const wallPos = [], floorPos = [];
    for (let y = 0; y < tiles.length; y++)
      for (let x = 0; x < tiles[y].length; x++)
        (tiles[y][x] === 1 ? wallPos : floorPos).push({ x, y });

    const mk = (geo, mat, list, kind, yOff) => {
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      mesh.castShadow = kind === 'wall';
      mesh.receiveShadow = true;
      // These never move, so stop three.js re-uploading the matrices.
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      const m = new THREE.Matrix4();
      const c = new THREE.Color();
      list.forEach((p, i) => {
        m.makeTranslation(p.x * TILE, yOff, p.y * TILE);
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, c.setHex(kind === 'wall' ? COLORS.fogWall : COLORS.fogFloor));
        this.tileIndex.set(`${p.x},${p.y}`, { kind, i });
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.scene.add(mesh);
      return mesh;
    };

    this.walls = mk(
      new THREE.BoxGeometry(TILE, WALL_H, TILE),
      new THREE.MeshStandardMaterial({ roughness: .92, metalness: .06 }),
      wallPos, 'wall', WALL_H / 2
    );
    this.floors = mk(
      new THREE.BoxGeometry(TILE, 0.12, TILE),
      new THREE.MeshStandardMaterial({ roughness: 1 }),
      floorPos, 'floor', -0.06
    );

    /**
     * A ceiling over the walkable tiles.
     *
     * Without it you look up into empty background and the maze reads as an
     * open-topped model rather than somewhere you are trapped. One extra draw
     * call, and it is what makes the corridors feel enclosed.
     */
    const ceilGeo = new THREE.PlaneGeometry(TILE, TILE);
    const ceilMat = new THREE.MeshStandardMaterial({ color: COLORS.ceiling, roughness: 1, side: THREE.FrontSide });
    this.ceiling = new THREE.InstancedMesh(ceilGeo, ceilMat, floorPos.length);
    const cm = new THREE.Matrix4();
    const rot = new THREE.Matrix4().makeRotationX(Math.PI / 2);   // face downward
    floorPos.forEach((p, i) => {
      cm.copy(rot).setPosition(p.x * TILE, WALL_H * 0.92, p.y * TILE);
      this.ceiling.setMatrixAt(i, cm);
    });
    this.ceiling.instanceMatrix.needsUpdate = true;
    this.scene.add(this.ceiling);

    this.mazeSize = tiles.length;
  }

  /** Recolour instances from the server's authoritative visibility set. */
  applyFog(visibleKeys) {
    if (!this.walls || !this.floors) return;
    const visible = new Set(visibleKeys);
    const c = new THREE.Color();

    for (const [key, { kind, i }] of this.tileIndex) {
      const lit = visible.has(key);
      const mesh = kind === 'wall' ? this.walls : this.floors;
      mesh.setColorAt(i, c.setHex(
        kind === 'wall'
          ? (lit ? COLORS.litWall : COLORS.fogWall)
          : (lit ? COLORS.litFloor : COLORS.fogFloor)
      ));
    }
    if (this.walls.instanceColor) this.walls.instanceColor.needsUpdate = true;
    if (this.floors.instanceColor) this.floors.instanceColor.needsUpdate = true;
  }

  updateActors(you, others) {
    const seen = new Set();

    for (const p of others) {
      seen.add(p.id);
      let a = this.actors.get(p.id);
      if (!a) {
        // The server sends team:null for anyone whose allegiance this player
        // has not earned. Everyone unknown wears the same silhouette, so a
        // saboteur can walk right up to you and the only thing that gives them
        // away is behaviour. Only a saboteur ever sees another saboteur marked.
        const known = p.team === 'SABOTEUR';
        a = makeCharacter(
          p.decoy ? COLORS.violet : known ? COLORS.rust : COLORS.teal,
          { isSaboteur: known, decoy: Boolean(p.decoy) }
        );
        this.actors.set(p.id, a);
        this.scene.add(a);
        a.position.set(p.pos.x, 0, p.pos.y);
        a.userData.last = new THREE.Vector3(p.pos.x, 0, p.pos.y);
      }
      a.userData.target = new THREE.Vector3(p.pos.x, 0, p.pos.y);
      if (p.alive === false && !a.userData.dead) killCharacter(a);
    }

    // In first person you are inside your own head — drawing your body puts a
    // cylinder through the camera. Track the position, render nothing.
    if (you) this.youPos = new THREE.Vector3(you.pos.x, 0, you.pos.y);

    for (const [id, mesh] of this.actors) {
      if (!seen.has(id)) { this.scene.remove(mesh); this.actors.delete(id); }
    }
  }

  setExit(exit, open) {
    if (!exit) return;
    if (!this.exitMesh) {
      this.exitMesh = new THREE.Group();
      const pad = new THREE.Mesh(
        new THREE.RingGeometry(.30, .46, 28),
        new THREE.MeshBasicMaterial({ color: COLORS.bone, side: THREE.DoubleSide, transparent: true, opacity: .5 })
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.y = .04;

      // Tall enough to be seen down a corridor before you reach the tile.
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(.16, .30, WALL_H * 1.7, 14, 1, true),
        new THREE.MeshBasicMaterial({
          color: COLORS.bone, transparent: true, opacity: .12,
          side: THREE.DoubleSide, depthWrite: false, fog: true,
        })
      );
      beam.position.y = WALL_H * 0.85;

      this.exitMesh.add(pad, beam);
      this.exitMesh.userData = { pad, beam };
      this.scene.add(this.exitMesh);
    }

    this.exitMesh.position.set(exit.x, 0, exit.y);
    const { pad, beam } = this.exitMesh.userData;
    const col = open ? COLORS.amber : COLORS.bone;
    pad.material.color.setHex(col);
    pad.material.opacity = open ? .95 : .30;
    beam.material.color.setHex(col);
    beam.material.opacity = open ? .26 : .05;
    this.exitOpen = open;
  }

  setTaskMarkers(tiles = []) {
    for (const [, m] of this.markers) this.scene.remove(m);
    this.markers.clear();
    tiles.forEach((t, i) => {
      const m = new THREE.Mesh(
        new THREE.TorusGeometry(.30, .045, 8, 20),
        new THREE.MeshBasicMaterial({ color: COLORS.amber, transparent: true, opacity: .85 })
      );
      m.rotation.x = -Math.PI / 2;
      m.position.set(t.x, .45, t.y);
      this.markers.set(`t${i}`, m);
      this.scene.add(m);
    });
  }

  render(dt) {
    for (const [, a] of this.actors) {
      if (!a.userData.target) continue;
      const prev = a.userData.last ?? a.position.clone();
      a.position.lerp(a.userData.target, Math.min(1, dt * 9));

      if (a.userData.dead) {
        updateDeath(a, dt);
      } else {
        // Walk weight comes from how far the figure actually moved this frame,
        // so a character standing still stands still instead of miming a
        // stride on the spot.
        const dx = a.position.x - prev.x, dz = a.position.z - prev.z;
        const dist = Math.hypot(dx, dz);
        const facing = dist > 0.0008 ? Math.atan2(dx, dz) : null;
        animateCharacter(a, dt, Math.min(1, dist / (dt * 2.2 || 1)), facing);
      }
      a.userData.last = a.position.clone();
    }

    if (this.youPos) {
      // Smooth the walk so a grid step reads as motion rather than a teleport.
      if (!this.eye) this.eye = this.youPos.clone();
      this.eye.lerp(this.youPos, Math.min(1, dt * 8));

      this.camera.position.set(this.eye.x, EYE_H, this.eye.z);
      this.camera.rotation.set(this.pitch, this.yaw, 0);

      const f = this.forward();
      this.torch.position.copy(this.camera.position);
      this.torchTarget.position.set(
        this.eye.x + f.x * 6,
        EYE_H + Math.sin(this.pitch) * 6,
        this.eye.z + f.z * 6
      );
      this.headLamp.position.copy(this.camera.position);
    }

    for (const [, m] of this.markers) m.rotation.z += dt * 1.4;

    if (this.exitMesh && this.exitOpen) {
      const t = performance.now() * 0.0022;
      this.exitMesh.userData.pad.material.opacity = .6 + Math.sin(t) * .35;
      this.exitMesh.rotation.y += dt * .5;
    }

    // composer.render() replaces renderer.render() — calling both draws the
    // scene twice and the post pass is thrown away.
    if (this.postEnabled && this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
