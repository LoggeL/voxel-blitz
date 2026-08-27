// Pooled gunshot/impact FX: tracers, muzzle flashes (remote shooters),
// voxel-glyph impact bursts, block shatter, brass shells, optional trauma shake.
// Everything additive + instanced; hard budgets, no allocations per frame in
// steady state beyond slot reuse. Zero textures fetched — procedural canvases.
import * as THREE from '../vendor/three.module.js';
import { WEAPONS } from '../../../shared/combatmath.js';
import { raycastVoxels } from '../../../shared/raycast.js';

const TAU = Math.PI * 2;

const BLOCK_TINTS = {
  1: 0x6da34d, // grass
  2: 0x7a5a3a, // dirt
  3: 0x8a8f94, // stone
  4: 0xd8c690, // sand
  5: 0x4b3621, // wood
  6: 0x4c7a3a, // leaves
  7: 0xb8bcc0, // concrete
  8: 0xffd76a, // metal -> sparks
  9: 0xff8c1a, // accent embers
  10: 0xb08a5a,// plank
  11: 0xcfe8f5,// glass
  12: 0xcfd3d6,// pale
};

function makeFlashTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.translate(32, 32);
  const grad = g.createRadialGradient(0, 0, 2, 0, 0, 30);
  grad.addColorStop(0, 'rgba(255,240,200,1)');
  grad.addColorStop(0.35, 'rgba(255,190,90,0.85)');
  grad.addColorStop(1, 'rgba(255,140,40,0)');
  g.fillStyle = grad;
  g.beginPath(); g.arc(0, 0, 30, 0, TAU); g.fill();
  g.lineWidth = 3;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    g.beginPath(); g.moveTo(2, 0);
    g.lineTo(Math.cos(a) * 28, Math.sin(a) * 28);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const IMPACT_POOL_SIZE = 40;
const NORMAL_IMPACT_PARTICLES = Object.freeze({
  speed: 2.2, gravity: 14, size: 1.5, life: 0.42, softness: true,
});
const HEAD_IMPACT_PARTICLES = Object.freeze({
  speed: 2.7, gravity: 14, size: 1.65, life: 0.46, softness: true,
});

function makeImpactCrossGeometry() {
  // Two narrow bars in the local XY plane. Kept deliberately sparse so the
  // hit marker reads at range without painting over the target.
  const positions = new Float32Array([
    -1, -0.07, 0,  1, -0.07, 0,  1, 0.07, 0,
    -1, -0.07, 0,  1,  0.07, 0, -1, 0.07, 0,
    -0.07, -1, 0,  0.07, -1, 0,  0.07, 1, 0,
    -0.07, -1, 0,  0.07,  1, 0, -0.07, 1, 0,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

export class Effects {
  constructor(scene, camera, worldGetBlockFn) {
    this.scene = scene;
    this.camera = camera;
    this.getBlockFn = worldGetBlockFn || (() => 0);
    this.time = 0;

    // shared scratch objects (hideInstance uses them during pool init below)
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._col = new THREE.Color();
    this._e = new THREE.Euler();

    // ---- tracers: ONE InstancedMesh of stretched boxes
    const trGeo = new THREE.BoxGeometry(1, 1, 1);
    trGeo.translate(0, 0, -0.5);          // extends toward -z; we orient along dir
    const trMat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    this.tracerMesh = new THREE.InstancedMesh(trGeo, trMat, 96);
    this.tracerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracerMesh.frustumCulled = false;
    this.tracerCount = 96;
    this.tracers = new Array(this.tracerCount);
    for (let i = 0; i < this.tracerCount; i++) {
      this.tracers[i] = { active: false, t: 0, life: 0.06, len: 20, w: 0.03, color: new THREE.Color(0xffffff) };
      this.tracerMesh.setColorAt(i, this.tracers[i].color);
      this.hideInstance(this.tracerMesh, i);
    }
    scene.add(this.tracerMesh);

    // ---- particles: ONE InstancedMesh of small boxes (impacts, shards)
    const pGeo = new THREE.BoxGeometry(0.09, 0.09, 0.09);
    const pMat = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.partMesh = new THREE.InstancedMesh(pGeo, pMat, 512);
    this.partMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.partMesh.frustumCulled = false;
    this.parts = [];
    for (let i = 0; i < 512; i++) {
      this.parts.push({ active: false });
      this.hideInstance(this.partMesh, i);
      this.partMesh.setColorAt(i, new THREE.Color(0xffffff));
    }
    scene.add(this.partMesh);

    // ---- impact confirmations: pooled core + billboard ring/cross.
    // Instance colors fade to black under additive blending, avoiding a
    // material (and draw call) per hit while keeping every resource bounded.
    const impactMaterial = () => new THREE.MeshBasicMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.impactCoreMesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 1), impactMaterial(), IMPACT_POOL_SIZE,
    );
    this.impactRingMesh = new THREE.InstancedMesh(
      new THREE.RingGeometry(0.78, 1, 24), impactMaterial(), IMPACT_POOL_SIZE,
    );
    this.impactCrossMesh = new THREE.InstancedMesh(
      makeImpactCrossGeometry(), impactMaterial(), IMPACT_POOL_SIZE,
    );
    this.impactMeshes = [this.impactCoreMesh, this.impactRingMesh, this.impactCrossMesh];
    this.impacts = new Array(IMPACT_POOL_SIZE);
    this.impactCursor = 0;
    for (const mesh of this.impactMeshes) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.renderOrder = 8;
      scene.add(mesh);
    }
    for (let i = 0; i < IMPACT_POOL_SIZE; i++) {
      this.impacts[i] = { active: false, t: 0, life: 0.28, x: 0, y: 0, z: 0, hs: false, rot: 0 };
      for (const mesh of this.impactMeshes) {
        this.hideInstance(mesh, i);
        mesh.setColorAt(i, this._col.setRGB(1, 1, 1));
      }
    }

    // ---- remote muzzle flashes: sprite pool
    this.flashTex = makeFlashTexture();
    this.flashes = [];
    for (let i = 0; i < 24; i++) {
      const m = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.flashTex, blending: THREE.AdditiveBlending, depthWrite: false,
        transparent: true, opacity: 0, rotation: Math.random() * TAU,
      }));
      m.scale.setScalar(0.55);
      m.visible = false;
      scene.add(m);
      this.flashes.push({ spr: m, t: 0, life: 0.05 });
    }

    // ---- shells: brass pool
    this.shellGeo = new THREE.BoxGeometry(0.02, 0.05, 0.02);
    this.shellMeshes = [];
    for (let i = 0; i < 32; i++) {
      const mat = new THREE.MeshStandardMaterial({ color: 0xd4a942, roughness: 0.35, metalness: 0.8 });
      const mesh = new THREE.Mesh(this.shellGeo, mat);
      mesh.visible = false;
      scene.add(mesh);
      this.shellMeshes.push({ mesh, vel: new THREE.Vector3(), spin: new THREE.Vector3(), t: 0 });
    }

    // camera trauma (main may sample currentShakeXY; effects never touches camera itself)
    this._trauma = 0;


    // muted counters for tests
    this.stats = { shots: 0, particlesSpawned: 0 };
  }

  hideInstance(mesh, i) {
    this._m4.makeScale(0, 0, 0);
    mesh.setMatrixAt(i, this._m4);
  }

  setShellSpawner(fn) { /* legacy hook — bridge does direct injection */ }

  // ---------------------------------------------------------------- shots

  /** ev: {o:[x,y,z], d:[x,y,z], w:'rifle'|..., spread:[xyz]|{xyz}, pellets?:[{xyz}]} */
  shoot(ev, opts = {}) {
    this.stats.shots++;
    const def = WEAPONS[ev.w];
    // Wire events carry plain [x,y,z] arrays; the local prediction path passes
    // {x,y,z} pellet objects. Accept both everywhere directions are consumed.
    const toVec = (a) => (Array.isArray(a) ? { x: a[0], y: a[1], z: a[2] } : a);
    const dirs = ev.pellets && ev.pellets.length > 1
      ? ev.pellets.map(toVec)
      : [toVec(ev.spread || ev.d)];
    const ox = ev.o[0], oy = ev.o[1], oz = ev.o[2];

    if (!opts.local) this.spawnFlash(ev.o, ev.d);

    for (let pi = 0; pi < Math.min(dirs.length, def ? def.pellets : 1); pi++) {
      const d = dirs[pi];
      let endLen = def ? def.tracer.len : 22;
      // shorten against terrain so tracers "land": len is measured from the
      // anchor o, but the instance is drawn 0.35 further out — compensate.
      const hit = raycastVoxels(this.getBlockFn, ox, oy, oz, d.x, d.y, d.z, endLen);
      if (hit) {
        endLen = Math.max(0.1, Math.min(endLen, hit.t) - 0.35);
        if (pi === 0) this.wallDust(hit, opts.local);
      }
      this.spawnTracer(ev.o, d, endLen, def);
    }
  }

  spawnTracer(o, dir, len, def) {
    const slot = this.tracers.findIndex((t) => !t.active);
    const idx = slot >= 0 ? slot : freeOldestIndex(this.tracers);
    const t = this.tracers[idx];
    t.active = true; t.t = 0;
    t.life = 0.055 + len * 0.0006;
    t.len = len;
    t.w = def ? 0.028 * def.tracer.width : 0.03;
    t.color.set(def ? def.tracer.color : '#ffd27a');

    // orientation: -z axis of instance box points along dir
    this._v.set(dir.x, dir.y, dir.z).normalize();
    this._q.setFromUnitVectors(new THREE.Vector3(0, 0, -1), this._v);
    const px = o[0] + dir.x * 0.35, py = o[1] + dir.y * 0.35, pz = o[2] + dir.z * 0.35;
    this._s.set(t.w, t.w, len);
    this._m4.compose(this._v.set(px, py, pz), this._q, this._s);
    this.tracerMesh.setMatrixAt(idx, this._m4);
    this.tracerMesh.setColorAt(idx, t.color);
    t.px = px; t.py = py; t.pz = pz; t.qx = this._q.x; t.qy = this._q.y; t.qz = this._q.z; t.qw = this._q.w;
    this.tracerMesh.instanceMatrix.needsUpdate = true;
    if (this.tracerMesh.instanceColor) this.tracerMesh.instanceColor.needsUpdate = true;
  }

  spawnFlash(o, dir) {
    const f = this.flashes.find((f) => f.spr.visible === false) ||
      this.flashes.reduce((a, b) => (a.t > b.t ? a : b));
    f.t = 0; f.life = 0.045;
    f.spr.visible = true;
    f.spr.position.set(o[0] + dir[0] * 0.35, o[1] + dir[1] * 0.35, o[2] + dir[2] * 0.35);
    f.spr.material.rotation = Math.random() * TAU;
    f.spr.scale.setScalar(0.45 + Math.random() * 0.3);
    f.spr.material.opacity = 1;
  }

  // ---------------------------------------------------------------- impacts

  /** evHit: {vx,vy,vz, hs?, dmg?} -> flesh puff + contact confirmation */
  impact(evHit) {
    const x = evHit && Number(evHit.vx);
    const y = evHit && Number(evHit.vy);
    const z = evHit && Number(evHit.vz);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

    const hs = !!evHit.hs;
    const idx = this.impactCursor;
    this.impactCursor = (idx + 1) % IMPACT_POOL_SIZE;
    const cue = this.impacts[idx];
    cue.active = true;
    cue.t = 0;
    cue.life = hs ? 0.36 : 0.28;
    cue.x = x; cue.y = y; cue.z = z;
    cue.hs = hs;
    cue.rot = idx * 2.399963229728653;
    this.updateImpactCue(idx, cue, 0);
    for (const mesh of this.impactMeshes) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    this.spawnParticles(
      x, y, z,
      hs ? 8 : 5, hs ? 0x7a1b32 : 0x5e1620,
      hs ? HEAD_IMPACT_PARTICLES : NORMAL_IMPACT_PARTICLES,
    );
  }

  updateImpactCue(idx, cue, u) {
    const fade = 1 - u;
    const ease = 1 - (1 - u) * (1 - u);
    const strength = cue.hs ? 1.28 : 1;
    const billboardQ = this.camera && this.camera.quaternion;

    // A very fast white-hot core makes the exact contact point unambiguous.
    const coreFade = Math.max(0, 1 - u * 4);
    const coreScale = strength * 0.2 * coreFade * coreFade;
    this._s.setScalar(coreScale);
    this._m4.compose(this._v.set(cue.x, cue.y, cue.z), this._q.identity(), this._s);
    this.impactCoreMesh.setMatrixAt(idx, this._m4);
    if (cue.hs) this._col.setRGB(1.7 * coreFade, 2 * coreFade, 2.35 * coreFade);
    else this._col.setRGB(2.2 * coreFade, 1.45 * coreFade, 0.85 * coreFade);
    this.impactCoreMesh.setColorAt(idx, this._col);

    // The thin ring and cross grow beyond the body silhouette, remaining
    // legible at combat distance. Headshots are larger and cool-colored.
    const ringScale = strength * (0.15 + ease * 0.78);
    this._s.setScalar(ringScale);
    this._m4.compose(
      this._v.set(cue.x, cue.y, cue.z),
      billboardQ ? this._q.copy(billboardQ) : this._q.identity(),
      this._s,
    );
    this.impactRingMesh.setMatrixAt(idx, this._m4);
    if (cue.hs) this._col.setRGB(0.22 * fade, 1.35 * fade, 2.1 * fade);
    else this._col.setRGB(1.55 * fade, 0.28 * fade, 0.08 * fade);
    this.impactRingMesh.setColorAt(idx, this._col);

    const crossScale = strength * (0.12 + ease * 0.63);
    this._s.setScalar(crossScale);
    this._e.set(0, 0, cue.rot + u * (cue.hs ? 0.7 : 0.35));
    this._q.setFromEuler(this._e);
    if (billboardQ) this._q.premultiply(billboardQ);
    this._m4.compose(this._v.set(cue.x, cue.y, cue.z), this._q, this._s);
    this.impactCrossMesh.setMatrixAt(idx, this._m4);
    if (cue.hs) this._col.setRGB(0.5 * fade, 1.65 * fade, 2.25 * fade);
    else this._col.setRGB(1.8 * fade, 0.55 * fade, 0.12 * fade);
    this.impactCrossMesh.setColorAt(idx, this._col);
  }

  wallDust(hit, local) {
    const blockType = this.getBlockFn(hit.x, hit.y, hit.z);
    let tint = BLOCK_TINTS[blockType] || 0x999999;
    const kind = blockSoundFor(blockType);
    if (kind === 'metal') {
      // bright sparks, fast, brief zero-g then fall
      this.spawnParticles(
        hit.x + 0.5 + hit.nx * 0.51, hit.y + 0.5 + hit.ny * 0.51, hit.z + 0.5 + hit.nz * 0.51,
        6, 0xffd76a, { speed: 5, gravity: 18, size: 0.7, life: 0.3, sparks: true },
      );
      return;
    }
    const speed = kind === 'glass' ? 3 : 1.8;
    this.spawnParticles(
      hit.x + 0.5 + hit.nx * 0.52, hit.y + 0.5 + hit.ny * 0.52, hit.z + 0.5 + hit.nz * 0.52,
      kind === 'glass' ? 8 : 6, tint, { speed, gravity: 16, size: 1, life: 0.5 },
    );
    if (kind === 'glass') this.spawnParticles(
      hit.x + 0.5, hit.y + 0.5, hit.z + 0.5,
      2, 0xffffff, { speed: 0.4, gravity: 0, size: 3, life: 0.16, spriteGlint: true },
    );
  }

  /** Broken voxel -> colored cube shatter. */
  explodeBlock(x, y, z, blockId) {
    const tint = BLOCK_TINTS[blockId] || 0x999999;
    this.spawnParticles(x + 0.5, y + 0.5, z + 0.5, 14, tint, {
      speed: 4.4, gravity: 22, size: 2.6, life: 0.75, shards: true,
    });
  }

  spawnParticles(x, y, z, count, tint, opt) {
    const col = this._col.setHex(tint);
    for (let i = 0; i < count; i++) {
      const slotIdx = this.parts.findIndex((p) => !p.active);
      const idx = slotIdx >= 0 ? slotIdx : freeOldestIndex(this.parts);
      const p = this.parts[idx];
      p.active = true; p.t = 0;
      p.life = opt.life * (0.6 + Math.random() * 0.8);
      p.size = opt.size * (0.6 + Math.random() * 0.9);
      p.gravity = opt.gravity ?? 20;
      p.softness = !!opt.softness;
      p.glint = !!opt.spriteGlint;
      p.x = x; p.y = y; p.z = z;
      const th = Math.random() * TAU;
      const ph = Math.random() * Math.PI;
      const sp = opt.speed * (opt.sparks ? (0.6 + Math.random()) : (0.35 + Math.random() * 0.85));
      p.vx = Math.sin(ph) * Math.cos(th) * sp;
      p.vy = Math.abs(Math.cos(ph)) * sp * (opt.sparks ? 1 : 0.9);
      p.vz = Math.sin(ph) * Math.sin(th) * sp;
      p.spinX = (Math.random() - 0.5) * 12;
      p.spinY = (Math.random() - 0.5) * 12;
      p.rx = Math.random() * TAU; p.ry = Math.random() * TAU;
      p.colR = col.r * (0.8 + Math.random() * 0.35);
      p.colG = col.g * (0.8 + Math.random() * 0.35);
      p.colB = col.b * (0.8 + Math.random() * 0.35);
      this.stats.particlesSpawned++;
    }
  }

  // ---------------------------------------------------------------- shells
  /** Spawned by attachShellBridge with the rig's world-space recipe:
   *  posWorld [x,y,z], ejectVelWorld the port exit velocity. */
  spawnBrass(posWorld, ejectVelWorld) {
    const s = this.shellMeshes.find((s) => !s.mesh.visible) ||
      this.shellMeshes.reduce((a, b) => (a.t > b.t ? a : b));
    s.mesh.visible = true;
    if (Array.isArray(posWorld)) s.mesh.position.set(posWorld[0], posWorld[1], posWorld[2]);
    else if (posWorld) s.mesh.position.copy(posWorld);

    if (Array.isArray(ejectVelWorld)) {
      s.vel.set(ejectVelWorld[0], ejectVelWorld[1], ejectVelWorld[2]);
    } else if (ejectVelWorld) {
      s.vel.copy(ejectVelWorld);
    } else {
      s.vel.set(1, 0.45, -0.15).normalize().multiplyScalar(2.2 + Math.random() * 1.2);
      s.vel.y += 1.4;
    }
    s.spin.set((Math.random() - 0.5) * 22, (Math.random() - 0.5) * 22, (Math.random() - 0.5) * 22);
    s.t = 0;
  }

  // ---------------------------------------------------------------- loop

  update(dt) {
    this.time += dt;
    this._trauma = Math.max(0, this._trauma - dt * 1.8);

    // tracers shrink tail
    for (let i = 0; i < this.tracers.length; i++) {
      const t = this.tracers[i];
      if (!t.active) continue;
      t.t += dt;
      if (t.t >= t.life) {
        t.active = false;
        this.hideInstance(this.tracerMesh, i);
        continue;
      }
      const k = 1 - t.t / t.life;               // head stays, tail shrinks toward origin end
      this._s.set(t.w, t.w, t.len * k);
      this._q.set(t.qx, t.qy, t.qz, t.qw);
      this._m4.compose(this._v.set(t.px, t.py, t.pz), this._q, this._s);
      this.tracerMesh.setMatrixAt(i, this._m4);
    }
    this.tracerMesh.instanceMatrix.needsUpdate = true;

    // impact confirmations
    for (let i = 0; i < this.impacts.length; i++) {
      const cue = this.impacts[i];
      if (!cue.active) continue;
      cue.t += dt;
      if (cue.t >= cue.life) {
        cue.active = false;
        for (const mesh of this.impactMeshes) this.hideInstance(mesh, i);
        continue;
      }
      this.updateImpactCue(i, cue, cue.t / cue.life);
    }
    for (const mesh of this.impactMeshes) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    // physics particles
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      if (!p.active) continue;
      p.t += dt;
      if (p.t >= p.life) {
        p.active = false;
        this.hideInstance(this.partMesh, i);
        continue;
      }
      if (p.glint) {
        // glints don't move much, just bloom out
        const k = p.t / p.life;
        this._s.setScalar(p.size * (0.4 + k * 2));
        this._m4.compose(this._v.set(p.x, p.y, p.z), this._q.identity(), this._s);
        this.partMesh.setMatrixAt(i, this._m4);
        this.partMesh.setColorAt(i, this._col.setRGB(p.colR, p.colG, p.colB));
        continue;
      }
      if (!(p.sparksZeroG)) { /* normal gravity */ }
      const wasVy = p.vy;
      p.vy -= p.gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      // single floor bounce probe
      if (p.vy < 0 && wasVy >= 0 === false) {
        const below = this.getBlockFn(Math.floor(p.x), Math.floor(p.y - 0.04), Math.floor(p.z));
        if (below) {
          p.y += 0.05;
          p.vy *= -0.35;
          p.vx *= 0.6; p.vz *= 0.6;
        }
      }
      p.rx += p.spinX * dt; p.ry += p.spinY * dt;
      const fade = 1 - p.t / p.life;
      const sc = p.size * (p.softness ? fade * fade : 0.6 + fade * 0.6);
      this._e ||= new THREE.Euler();
      this._e.set(p.rx, p.ry, 0);
      this._q.setFromEuler(this._e);
      this._s.setScalar(sc);
      this._m4.compose(this._v.set(p.x, p.y, p.z), this._q, this._s);
      this.partMesh.setMatrixAt(i, this._m4);
      this.partMesh.setColorAt(i, this._col.setRGB(p.colR * fade, p.colG * fade, p.colB * fade));
    }
    this.partMesh.instanceMatrix.needsUpdate = true;
    if (this.partMesh.instanceColor) this.partMesh.instanceColor.needsUpdate = true;

    // flashes fade fast
    for (const f of this.flashes) {
      if (!f.spr.visible) continue;
      f.t += dt;
      if (f.t >= f.life) { f.spr.visible = false; continue; }
      f.spr.material.opacity = 1 - f.t / f.life;
    }

    // brass physics
    for (const s of this.shellMeshes) {
      if (!s.mesh.visible) continue;
      s.t += dt;
      s.vel.y -= 18 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.rotation.x += s.spin.x * dt;
      s.mesh.rotation.y += s.spin.y * dt;
      s.mesh.rotation.z += s.spin.z * dt;
      const gy = Math.floor(s.mesh.position.y);
      const gx = Math.floor(s.mesh.position.x), gz = Math.floor(s.mesh.position.z);
      const floorSolid = this.getBlockFn(gx, gy, gz) !== 0;
      if (floorSolid) {
        s.mesh.position.y = gy + 1.03;
        s.vel.set(0, 0, 0);
        s.spin.set(0, 0, 0);
        if (s.t > 2.5) s.mesh.visible = false;   // settled long enough
      }
      if (s.t > 3.5) s.mesh.visible = false;
    }
  }

  shake(amount) { this._trauma = Math.min(1, this._trauma + amount); }

  get currentShakeXY() {
    const t = this._trauma * this._trauma;
    return {
      x: t * (Math.sin(this.time * 47) + Math.sin(this.time * 31.7)) * 0.012,
      y: t * (Math.cos(this.time * 39.3) + Math.sin(this.time * 53.1)) * 0.01,
    };
  }
  dispose() {
    for (const mesh of [this.tracerMesh, this.partMesh, ...this.impactMeshes]) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    for (const f of this.flashes) {
      this.scene.remove(f.spr);
      f.spr.material.dispose();
    }
    for (const s of this.shellMeshes) {
      this.scene.remove(s.mesh);
      s.mesh.material.dispose();
    }
    if (this.shellGeo) this.shellGeo.dispose();
    this.flashTex.dispose();
  }
}

function freeOldestIndex(arr) {
  let oldest = 0, ot = -1;
  for (let i = 0; i < arr.length; i++) {
    const age = arr[i].t / (arr[i].life || 1);
    if (age > ot) { ot = age; oldest = i; }
  }
  arr[oldest].active = false;
  return oldest;
}

export function blockSoundFor(type) {
  if (type === 11) return 'glass';
  if (type === 10 || type === 6 || type === 5) return 'wood';
  if (type === 9 || type === 8) return 'metal';
  return 'stone';
}

/** Wire viewmodel rig ejection hooks into world-space brass spawns. The rig
 *  hands over ONE recipe object {pos:[xyz], vel:[xyz], spin:[xyz]} already in
 *  world space — consume it verbatim. */
export function attachShellBridge(effects, rig) {
  rig.onShellEject = ({ pos, vel }) => {
    effects.spawnBrass(pos, vel);
  };
}
