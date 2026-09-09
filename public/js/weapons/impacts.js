// Bounded hit confirmations, material-aware voxel debris, and block shatter FX.
import { pickaxeMaterial } from '../audio/pickaxe.js';
import { removedDamageCells } from '../engine/block-damage-geometry.js';
import * as THREE from '../vendor/three.module.js';
import { freeOldestIndex, hideInstance, makeImpactCrossGeometry } from './instancing.js';

const TAU = Math.PI * 2;
const IMPACT_POOL_SIZE = 40;
const PARTICLE_POOL_SIZE = 512;

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

export function blockSoundFor(type) {
  if (type === 11) return 'glass';
  if (type === 10 || type === 6 || type === 5) return 'wood';
  if (type === 9 || type === 8 || type === 13 || type === 14) return 'metal';
  return 'stone';
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
    const particleMaterial = new THREE.MeshBasicMaterial({ toneMapped: false });
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

  mine(ev) {
    if (this._disposed) return;
    const material = pickaxeMaterial(ev.from);
    const x = ev.x + 0.5 + ev.nx * 0.53;
    const y = ev.y + 0.5 + ev.ny * 0.53;
    const z = ev.z + 0.5 + ev.nz * 0.53;
    const outward = [ev.nx * 0.3, ev.ny * 0.3, ev.nz * 0.3];
    const particles = material === 'metal' ? METAL_PARTICLES
      : material === 'glass' ? GLASS_PARTICLES : DUST_PARTICLES;
    this.spawnParticles(x, y, z, ev.progress >= 1 ? 18 : 5,
      material === 'metal' ? 0xffd78a : BLOCK_TINTS[ev.from] || 0x999999,
      { ...particles, outward, softness: material === 'soft' });
    if (material === 'glass' || material === 'metal') {
      this.spawnParticles(x, y, z, 2, 0xfff1cf, GLINT_PARTICLES);
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
      p.x = x;
      p.y = y;
      p.z = z;
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
      p.spinX = (Math.random() - 0.5) * 12;
      p.spinY = (Math.random() - 0.5) * 12;
      p.rx = Math.random() * TAU;
      p.ry = Math.random() * TAU;
      p.colR = col.r * (0.8 + Math.random() * 0.35);
      p.colG = col.g * (0.8 + Math.random() * 0.35);
      p.colB = col.b * (0.8 + Math.random() * 0.35);
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
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.vy < 0 && wasVy < 0) {
        const below = this.getBlockFn(
          Math.floor(p.x), Math.floor(p.y - 0.04), Math.floor(p.z),
        );
        if (below) {
          p.y += 0.05;
          p.vy *= -0.35;
          p.vx *= 0.6;
          p.vz *= 0.6;
        }
      }
      p.rx += p.spinX * dt;
      p.ry += p.spinY * dt;
      const fade = 1 - p.t / p.life;
      const scale = p.size * (p.softness ? fade * fade : 0.6 + fade * 0.6);
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
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const mesh of [this.partMesh, ...this.impactMeshes]) {
      this.scene.remove(mesh);
      mesh.dispose();
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }
}
