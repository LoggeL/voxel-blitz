// Bounded hit confirmations, material-aware voxel debris, and block shatter FX.
import { footstepMaterial } from '../audio/footsteps.js';
import { pickaxeMaterial } from '../audio/pickaxe.js';
import { removedDamageCells } from '../engine/block-damage-geometry.js';
import { FACE_SHADE } from '../engine/chunks.js';
import * as THREE from '../vendor/three.module.js';
import { GLASS, LEAVES, MC_GHOST_SOLID, MC_GLASS, MC_LEAVES, isSolidBlock } from '../../../shared/world/blocks.js';
import { freeOldestIndex, hideInstance, makeImpactCrossGeometry } from './instancing.js';

const TAU = Math.PI * 2;
const IMPACT_POOL_SIZE = 40;
const PARTICLE_POOL_SIZE = 512;
const STAR_POOL_SIZE = 96;
// IRON PICK block contact: a few chips per dig hit, a block-filling burst on the break.
export const MINE_HIT_PARTICLES = 6;
export const MINE_BREAK_PARTICLES = 32;
export const CRIT_STARS = 14;
export const BACKSTAB_STARS = 18;

const BLOCK_TINTS = Object.freeze({
  1: 0x6da34d,
  2: 0x7a5a3a,
  3: 0x8a8f94,
  4: 0xd8c690,
  5: 0x4b3621,
  6: 0x4c7a3a,
  7: 0xb8bcc0,
  8: 0xffd76a,
  9: 0xff8c1a,
  10: 0xb08a5a,
  11: 0xcfe8f5,
  12: 0xcfd3d6,
  13: 0xb5723a,
  14: 0xa8543e,
  15: 0xe6c665,
  16: 0x76aaa5,
  17: 0x444b54,
  18: 0x716052,
  19: 0xe5b537,
  20: 0xb74538,
  // Minecraft B5 materials.
  36: 0x689e42, 37: 0x79583c, 38: 0x7d7d7d, 39: 0x848484, 40: 0x6b8a52, 41: 0xdbd2a0,
  42: 0x847e7c, 43: 0x9ea4b0, 44: 0x685232, 45: 0x2e6e20, 46: 0xad8a54, 47: 0xb6d4e4,
  48: 0x96483a, 49: 0xad8a54, 50: 0xe4e4e4, 51: 0xb02e28, 52: 0xd6d6d6, 53: 0xf6ce3e,
  54: 0x60ded6, 55: 0x7d7d7d, 56: 0x5a5a5a, 57: 0x180e24, 58: 0x743430, 59: 0xe8be5c,
  60: 0xf6f8fc, 61: 0x5e9436, 62: 0x986a34, 63: 0x848484, 64: 0x846240, 65: 0xc42e28,
});

const NORMAL_IMPACT_PARTICLES = Object.freeze({
  speed: 2.2, gravity: 14, size: 1.5, life: 0.42, softness: true,
});
const HEAD_IMPACT_PARTICLES = Object.freeze({
  speed: 2.7, gravity: 14, size: 1.65, life: 0.46, softness: true,
});
const METAL_PARTICLES = Object.freeze({
  speed: 5, gravity: 18, size: 0.7, life: 0.3, sparks: true,
});
const GLASS_PARTICLES = Object.freeze({
  speed: 3, gravity: 16, size: 1, life: 0.5,
});
const DUST_PARTICLES = Object.freeze({
  speed: 1.8, gravity: 16, size: 1, life: 0.5,
});
const GLINT_PARTICLES = Object.freeze({
  speed: 0.4, gravity: 0, size: 3, life: 0.16, spriteGlint: true,
});
const SHARD_PARTICLES = Object.freeze({
  speed: 4.4, gravity: 22, size: 2.6, life: 0.75, shards: true,
});
// Minecraft terrain particles: small unspun squares of the block colour that
// keep their shade, drift under air drag, fall at 16 m/s² and settle on floors.
const BLOCK_PARTICLES = Object.freeze({
  speed: 1.4, gravity: 16, size: 1.3, life: 0.9, blocky: true,
});
// Minecraft crit sparkle: a pale pixel star bursting out and braking hard.
const CRIT_TINT = 0xf4f1e6, BACKSTAB_TINT = 0xd8243c;

/** Impact bank (glass/wood/metal/stone). Wood and metal come from the footstep material
 * table so every surface cue agrees; foliage snaps like wood rather than thudding like stone. */
export function blockSoundFor(type) {
  type = MC_GHOST_SOLID[type] ?? type;
  if (type === GLASS || type === MC_GLASS) return 'glass';
  if (type === LEAVES || type === MC_LEAVES) return 'wood';
  const surface = footstepMaterial(type);
  return surface === 'wood' || surface === 'metal' ? surface : 'stone';
}

/** Flat 5x5-pixel plus with a hollow-free centre: the crit sparkle silhouette, unit size. */
function makePixelStarGeometry() {
  const u = 0.2, rects = [[-u / 2, -2.5 * u, u, 5 * u], [-2.5 * u, -u / 2, 5 * u, u],
    [-1.5 * u, -1.5 * u, u, u], [0.5 * u, 0.5 * u, u, u], [-1.5 * u, 0.5 * u, u, u], [0.5 * u, -1.5 * u, u, u]];
  const positions = [];
  for (const [x, y, w, h] of rects) {
    positions.push(x, y, 0, x + w, y, 0, x + w, y + h, 0, x, y, 0, x + w, y + h, 0, x, y + h, 0);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

export class ImpactFX {
  constructor(scene, camera, worldGetBlockFn) {
    this.scene = scene;
    this.camera = camera;
    this.getBlockFn = worldGetBlockFn || (() => 0);
    this.particlesSpawned = 0;
    this._disposed = false;

    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._col = new THREE.Color();
    this._e = new THREE.Euler();

    const particleGeometry = new THREE.BoxGeometry(0.09, 0.09, 0.09);
    // Block debris carries the terrain's fixed per-face shade (BoxGeometry faces
    // run +X -X +Y -Y +Z -Z, four vertices each, exactly the FACE_SHADE order),
    // so chips read as little lit blocks. The pool is shared with blood, sparks,
    // glass and dust, so a per-instance weight (1 for blocky chips, 0 for every
    // other particle) mixes the shade in; one fixed program for all of them.
    const chipShade = new Float32Array(particleGeometry.attributes.position.count * 3);
    for (let i = 0; i < chipShade.length / 3; i++) chipShade.fill(FACE_SHADE[(i >> 2) % 6], i * 3, i * 3 + 3);
    particleGeometry.setAttribute('color', new THREE.BufferAttribute(chipShade, 3));
    this.partShade = new THREE.InstancedBufferAttribute(new Float32Array(PARTICLE_POOL_SIZE), 1);
    particleGeometry.setAttribute('chipShadeWeight', this.partShade);
    const particleMaterial = new THREE.MeshBasicMaterial({ toneMapped: false, vertexColors: true });
    particleMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float chipShadeWeight;')
        .replace('#include <color_vertex>', [
          'vColor = vec3( 1.0 );',
          'vColor *= mix( vec3( 1.0 ), color, chipShadeWeight );',
          '#ifdef USE_INSTANCING_COLOR',
          '  vColor *= instanceColor.xyz;',
          '#endif',
        ].join('\n'));
    };
    particleMaterial.customProgramCacheKey = () => 'vb-debris-chip-shade';
    this.partMesh = new THREE.InstancedMesh(
      particleGeometry, particleMaterial, PARTICLE_POOL_SIZE,
    );
    this.partMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.partMesh.frustumCulled = false;
    this.parts = new Array(PARTICLE_POOL_SIZE);
    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      this.parts[i] = { active: false };
      hideInstance(this.partMesh, i);
      this.partMesh.setColorAt(i, this._col.setHex(0xffffff));
    }
    scene.add(this.partMesh);

    // Crit stars: a flat pixel-plus that faces the camera.
    this.starsSpawned = 0;
    this.starMesh = new THREE.InstancedMesh(makePixelStarGeometry(), new THREE.MeshBasicMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    }), STAR_POOL_SIZE);
    this.starMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.starMesh.frustumCulled = false;
    this.starMesh.renderOrder = 9;
    this.stars = new Array(STAR_POOL_SIZE);
    for (let i = 0; i < STAR_POOL_SIZE; i++) {
      this.stars[i] = { active: false };
      hideInstance(this.starMesh, i);
      this.starMesh.setColorAt(i, this._col.setHex(0xffffff));
    }
    scene.add(this.starMesh);

    const impactMaterial = () => new THREE.MeshBasicMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
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
    this.impactMeshes = [
      this.impactCoreMesh, this.impactRingMesh, this.impactCrossMesh,
    ];
    this.impacts = new Array(IMPACT_POOL_SIZE);
    this.impactCursor = 0;
    for (const mesh of this.impactMeshes) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.renderOrder = 8;
      scene.add(mesh);
    }
    for (let i = 0; i < IMPACT_POOL_SIZE; i++) {
      this.impacts[i] = {
        active: false, t: 0, life: 0.28,
        x: 0, y: 0, z: 0, hs: false, rot: 0,
      };
      for (const mesh of this.impactMeshes) {
        hideInstance(mesh, i);
        mesh.setColorAt(i, this._col.setRGB(1, 1, 1));
      }
    }
  }

  /** evHit: {vx,vy,vz, hs?, dmg?} */
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
    cue.x = x;
    cue.y = y;
    cue.z = z;
    cue.hs = hs;
    cue.rot = idx * 2.399963229728653;
    this._updateImpactCue(idx, cue, 0);
    for (const mesh of this.impactMeshes) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    this.spawnParticles(
      x, y, z,
      hs ? 8 : 5,
      hs ? 0x7a1b32 : 0x5e1620,
      hs ? HEAD_IMPACT_PARTICLES : NORMAL_IMPACT_PARTICLES,
    );
  }

  _updateImpactCue(idx, cue, u) {
    const fade = 1 - u;
    const ease = 1 - (1 - u) * (1 - u);
    const strength = cue.hs ? 1.28 : 1;
    const billboardQ = this.camera && this.camera.quaternion;

    const coreFade = Math.max(0, 1 - u * 4);
    const coreScale = strength * 0.2 * coreFade * coreFade;
    this._s.setScalar(coreScale);
    this._m4.compose(
      this._v.set(cue.x, cue.y, cue.z), this._q.identity(), this._s,
    );
    this.impactCoreMesh.setMatrixAt(idx, this._m4);
    if (cue.hs) this._col.setRGB(1.7 * coreFade, 2 * coreFade, 2.35 * coreFade);
    else this._col.setRGB(2.2 * coreFade, 1.45 * coreFade, 0.85 * coreFade);
    this.impactCoreMesh.setColorAt(idx, this._col);

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
    const tint = BLOCK_TINTS[blockType] || 0x999999;
    const kind = blockSoundFor(blockType);
    if (kind === 'metal') {
      this.spawnParticles(
        hit.x + 0.5 + hit.nx * 0.51,
        hit.y + 0.5 + hit.ny * 0.51,
        hit.z + 0.5 + hit.nz * 0.51,
        6, 0xffd76a, METAL_PARTICLES,
      );
      return;
    }
    this.spawnParticles(
      hit.x + 0.5 + hit.nx * 0.52,
      hit.y + 0.5 + hit.ny * 0.52,
      hit.z + 0.5 + hit.nz * 0.52,
      kind === 'glass' ? 8 : 6,
      tint,
      kind === 'glass' ? GLASS_PARTICLES : DUST_PARTICLES,
    );
    if (kind === 'glass') {
      this.spawnParticles(
        hit.x + 0.5, hit.y + 0.5, hit.z + 0.5,
        2, 0xffffff, GLINT_PARTICLES,
      );
    }
  }

  /**
   * One accepted pickaxe contact. Dig hits chip a few block-coloured squares off
   * the struck face; the break fills the whole block volume with a radial burst,
   * like Minecraft's 4x4x4 break shower. Metal and glass add two contact glints.
   */
  mine(ev) {
    if (this._disposed) return;
    const material = pickaxeMaterial(ev.from);
    const tint = BLOCK_TINTS[ev.from] || 0x999999;
    const broken = ev.progress >= 1;
    const x = ev.x + 0.5 + ev.nx * (broken ? 0 : 0.53);
    const y = ev.y + 0.5 + ev.ny * (broken ? 0 : 0.53);
    const z = ev.z + 0.5 + ev.nz * (broken ? 0 : 0.53);
    const outward = [ev.nx * 0.18, ev.ny * 0.18, ev.nz * 0.18];
    this.spawnParticles(x, y, z, broken ? MINE_BREAK_PARTICLES : MINE_HIT_PARTICLES, tint, broken
      ? { ...BLOCK_PARTICLES, spread: 0.42, radial: 3.2, speed: 0.6 }
      : { ...BLOCK_PARTICLES, outward, spread: 0.3, flat: [ev.nx, ev.ny, ev.nz] });
    if (material === 'glass' || material === 'metal') {
      const gx = ev.x + 0.5 + ev.nx * 0.53, gy = ev.y + 0.5 + ev.ny * 0.53, gz = ev.z + 0.5 + ev.nz * 0.53;
      this.spawnParticles(gx, gy, gz, 2, 0xfff1cf, GLINT_PARTICLES);
    }
  }

  /**
   * IRON PICK player hit by kind: crit and backstab burst pixel stars (pale /
   * crimson), a full armor absorb throws brass sparks, a knockback shove a puff.
   */
  meleeHit(ev, kind) {
    if (this._disposed) return;
    const x = Number(ev?.vx), y = Number(ev?.vy), z = Number(ev?.vz);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    if (kind === 'crit') this.spawnStars(x, y, z, CRIT_STARS, CRIT_TINT);
    else if (kind === 'backstab') this.spawnStars(x, y, z, BACKSTAB_STARS, BACKSTAB_TINT);
    else if (kind === 'armor') this.spawnParticles(x, y, z, 6, 0xffd78a, METAL_PARTICLES);
    else if (kind === 'knockback') this.spawnParticles(x, y - 0.5, z, 6, 0xe6e2da, { ...DUST_PARTICLES, softness: true });
  }

  spawnStars(x, y, z, count, tint) {
    const col = this._col.setHex(tint);
    for (let i = 0; i < count; i++) {
      let idx = this.stars.findIndex((star) => !star.active);
      if (idx < 0) idx = freeOldestIndex(this.stars);
      const star = this.stars[idx];
      const th = Math.random() * TAU, up = Math.random() * 2 - 1;
      const flat = Math.sqrt(1 - up * up), speed = 3 + Math.random() * 3;
      star.active = true;
      star.t = 0;
      star.life = 0.45 + Math.random() * 0.4;
      star.size = 0.05 + Math.random() * 0.035;
      star.x = x + Math.cos(th) * flat * 0.2;
      star.y = y + up * 0.35;
      star.z = z + Math.sin(th) * flat * 0.2;
      star.vx = Math.cos(th) * flat * speed;
      star.vy = up * speed * 0.8 + 1.4;
      star.vz = Math.sin(th) * flat * speed;
      star.spin = (Math.random() - 0.5) * 6;
      star.rot = Math.random() * TAU;
      const shade = 0.78 + Math.random() * 0.3;
      star.colR = col.r * shade; star.colG = col.g * shade; star.colB = col.b * shade;
      this.starsSpawned++;
    }
  }

  /** Debris follows exactly the cells removed by the persistent chunk mesh. */
  chipBlock(ev) {
    if (this._disposed || this.getBlockFn(ev.x, ev.y, ev.z) !== ev.v) return;
    const cells = removedDamageCells(ev.x, ev.y, ev.z, ev.previousProgress || 0, ev.progress);
    for (const [x, y, z] of cells) {
      this.spawnParticles(ev.x + x, ev.y + y, ev.z + z, 1,
        BLOCK_TINTS[ev.v] || 0x999999, {
          speed: 1.5, gravity: 15, size: 2.4, life: 0.85,
          outward: [x - 0.5, y - 0.5, z - 0.5],
        });
    }
  }

  explodeBlock(x, y, z, blockId) {
    const tint = BLOCK_TINTS[blockId] || 0x999999;
    this.spawnParticles(
      x + 0.5, y + 0.5, z + 0.5,
      14, tint, SHARD_PARTICLES,
    );
  }

  spawnParticles(x, y, z, count, tint, opt) {
    const col = this._col.setHex(tint);
    for (let i = 0; i < count; i++) {
      let idx = -1;
      for (let j = 0; j < this.parts.length; j++) {
        if (!this.parts[j].active) {
          idx = j;
          break;
        }
      }
      if (idx < 0) idx = freeOldestIndex(this.parts);
      const p = this.parts[idx];
      p.active = true;
      p.t = 0;
      p.life = opt.life * (0.6 + Math.random() * 0.8);
      p.size = opt.size * (0.6 + Math.random() * 0.9);
      p.gravity = opt.gravity ?? 20;
      p.softness = !!opt.softness;
      p.glint = !!opt.spriteGlint;
      p.blocky = !!opt.blocky;
      if (this.partShade.array[idx] !== (p.blocky ? 1 : 0)) {
        this.partShade.array[idx] = p.blocky ? 1 : 0;
        this.partShade.needsUpdate = true;
      }
      p.x = x;
      p.y = y;
      p.z = z;
      // Volume spread: jitter the start inside a box (flattened onto a struck face).
      let ox = 0, oy = 0, oz = 0;
      if (opt.spread) {
        ox = (Math.random() * 2 - 1) * opt.spread;
        oy = (Math.random() * 2 - 1) * opt.spread;
        oz = (Math.random() * 2 - 1) * opt.spread;
        if (opt.flat) { ox *= 1 - Math.abs(opt.flat[0]); oy *= 1 - Math.abs(opt.flat[1]); oz *= 1 - Math.abs(opt.flat[2]); }
        p.x += ox; p.y += oy; p.z += oz;
      }
      const th = Math.random() * TAU;
      const ph = Math.random() * Math.PI;
      const speed = opt.speed * (
        opt.sparks ? 0.6 + Math.random() : 0.35 + Math.random() * 0.85
      );
      p.vx = Math.sin(ph) * Math.cos(th) * speed;
      p.vy = Math.abs(Math.cos(ph)) * speed * (opt.sparks ? 1 : 0.9);
      p.vz = Math.sin(ph) * Math.sin(th) * speed;
      if (opt.outward) {
        p.vx += opt.outward[0] * 7;
        p.vy += opt.outward[1] * 4 + 1.2;
        p.vz += opt.outward[2] * 7;
      }
      if (opt.radial) {
        p.vx += ox * opt.radial;
        p.vy += oy * opt.radial + 1.2;
        p.vz += oz * opt.radial;
      }
      p.spinX = p.blocky ? 0 : (Math.random() - 0.5) * 12;
      p.spinY = p.blocky ? 0 : (Math.random() - 0.5) * 12;
      p.rx = p.blocky ? 0 : Math.random() * TAU;
      p.ry = p.blocky ? 0 : Math.random() * TAU;
      // Texture-fragment shading: blocky chips vary more, one shade per chip.
      const shade = p.blocky ? 0.68 + Math.random() * 0.42 : 0;
      p.colR = col.r * (shade || 0.8 + Math.random() * 0.35);
      p.colG = col.g * (shade || 0.8 + Math.random() * 0.35);
      p.colB = col.b * (shade || 0.8 + Math.random() * 0.35);
      this.particlesSpawned++;
    }
  }

  update(dt) {
    let impactsDirty = false;
    for (let i = 0; i < this.impacts.length; i++) {
      const cue = this.impacts[i];
      if (!cue.active) continue;
      impactsDirty = true;
      cue.t += dt;
      if (cue.t >= cue.life) {
        cue.active = false;
        for (const mesh of this.impactMeshes) hideInstance(mesh, i);
        continue;
      }
      this._updateImpactCue(i, cue, cue.t / cue.life);
    }
    if (impactsDirty) for (const mesh of this.impactMeshes) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    let particlesDirty = false;
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      if (!p.active) continue;
      particlesDirty = true;
      p.t += dt;
      if (p.t >= p.life) {
        p.active = false;
        hideInstance(this.partMesh, i);
        continue;
      }
      if (p.glint) {
        const k = p.t / p.life;
        this._s.setScalar(p.size * (0.4 + k * 2));
        this._m4.compose(
          this._v.set(p.x, p.y, p.z), this._q.identity(), this._s,
        );
        this.partMesh.setMatrixAt(i, this._m4);
        this.partMesh.setColorAt(i, this._col.setRGB(p.colR, p.colG, p.colB));
        continue;
      }
      const wasVy = p.vy;
      p.vy -= p.gravity * dt;
      if (p.blocky) {
        const drag = Math.pow(0.667, dt);        // Minecraft's 0.98 per tick
        p.vx *= drag; p.vy *= drag; p.vz *= drag;
      }
      const prevX = p.x, prevY = p.y, prevZ = p.z;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.blocky) {
        const floorY = Math.floor(p.y - 0.04);
        const solid = (x, y, z) => this.getBlockFn(Math.floor(x), Math.floor(y), Math.floor(z));
        if (p.vy < 0 && prevY >= floorY + 1 && this.getBlockFn(Math.floor(p.x), floorY, Math.floor(p.z))) {
          // Chips that came down through a top face rest there and slide to a stop.
          p.y = floorY + 1.04;
          p.vy = 0;
          p.vx *= 0.7;
          p.vz *= 0.7;
        } else if (solid(p.x, p.y, p.z)) {
          // Entered a wall or ceiling from the side or below: never lift it onto
          // that block's top. Side hits lose their drift; ceiling hits stop rising.
          p.x = prevX; p.z = prevZ; p.vx = 0; p.vz = 0;
          if (solid(p.x, p.y, p.z)) { p.y = prevY; if (p.vy > 0) p.vy = 0; }
          if (solid(p.x, p.y, p.z)) p.t = p.life;
        }
      } else if (p.vy < 0 && wasVy < 0) {
        const below = this.getBlockFn(
          Math.floor(p.x), Math.floor(p.y - 0.04), Math.floor(p.z),
        );
        if (isSolidBlock(below)) {
          p.y += 0.05;
          p.vy *= -0.35;
          p.vx *= 0.6;
          p.vz *= 0.6;
        }
      }
      p.rx += p.spinX * dt;
      p.ry += p.spinY * dt;
      const fade = p.blocky ? 1 : 1 - p.t / p.life;
      // Blocky chips keep size and shade, then pop out over their last 60 ms.
      const scale = p.size * (p.blocky ? Math.min(1, (p.life - p.t) / 0.06)
        : p.softness ? fade * fade : 0.6 + fade * 0.6);
      this._e.set(p.rx, p.ry, 0);
      this._q.setFromEuler(this._e);
      this._s.setScalar(scale);
      this._m4.compose(this._v.set(p.x, p.y, p.z), this._q, this._s);
      this.partMesh.setMatrixAt(i, this._m4);
      this.partMesh.setColorAt(
        i, this._col.setRGB(p.colR * fade, p.colG * fade, p.colB * fade),
      );
    }
    if (particlesDirty) {
      this.partMesh.instanceMatrix.needsUpdate = true;
      if (this.partMesh.instanceColor) this.partMesh.instanceColor.needsUpdate = true;
    }
    this._updateStars(dt);
  }

  _updateStars(dt) {
    let dirty = false;
    const billboardQ = this.camera && this.camera.quaternion;
    for (let i = 0; i < this.stars.length; i++) {
      const star = this.stars[i];
      if (!star.active) continue;
      dirty = true;
      star.t += dt;
      if (star.t >= star.life) {
        star.active = false;
        hideInstance(this.starMesh, i);
        continue;
      }
      const brake = Math.exp(-5.5 * dt);
      star.vx *= brake; star.vz *= brake;
      star.vy = star.vy * brake - 2.5 * dt;
      star.x += star.vx * dt; star.y += star.vy * dt; star.z += star.vz * dt;
      star.rot += star.spin * dt;
      const k = star.t / star.life;
      this._e.set(0, 0, star.rot);
      this._q.setFromEuler(this._e);
      if (billboardQ) this._q.premultiply(billboardQ);
      this._s.setScalar(star.size * (1 - k * k));
      this._m4.compose(this._v.set(star.x, star.y, star.z), this._q, this._s);
      this.starMesh.setMatrixAt(i, this._m4);
      this.starMesh.setColorAt(i, this._col.setRGB(star.colR, star.colG, star.colB));
    }
    if (dirty) {
      this.starMesh.instanceMatrix.needsUpdate = true;
      if (this.starMesh.instanceColor) this.starMesh.instanceColor.needsUpdate = true;
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const mesh of [this.partMesh, this.starMesh, ...this.impactMeshes]) {
      this.scene.remove(mesh);
      mesh.dispose();
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }
}
