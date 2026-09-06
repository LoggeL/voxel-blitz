// Bounded hit confirmations, material-aware voxel debris, and block shatter FX.
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
    this.miningCracks = new Map();

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
    const key = `${ev.x},${ev.y},${ev.z}`;
    const old = this.miningCracks.get(key);
    if (old) { this.scene.remove(old.mesh); old.mesh.geometry.dispose(); old.mesh.material.dispose(); }
    this.miningCracks.delete(key);
    this.spawnParticles(ev.x + 0.5 + ev.nx * 0.53, ev.y + 0.5 + ev.ny * 0.53,
      ev.z + 0.5 + ev.nz * 0.53, ev.progress >= 1 ? 18 : 5,
      BLOCK_TINTS[ev.from] || 0x999999, DUST_PARTICLES);
    if (ev.progress >= 1) return;
    // Pixel stair-step cracks on every face, visible from either side of a block.
    const points = [];
    const count = Math.ceil(ev.progress * 8);
    for (let face = 0; face < 6; face++) {
      const axis = Math.floor(face / 2), side = face % 2 ? 0.502 : -0.502;
      const point = (u, v) => {
        const p = [0, 0, 0]; p[axis] = side;
        p[(axis + 1) % 3] = u; p[(axis + 2) % 3] = v;
        return p;
      };
      for (let branch = 0; branch < count; branch++) {
        let u = 0, v = 0;
        for (let step = 0; step < 5; step++) {
          const nu = u + Math.cos(branch * 2.4) * 0.085;
          const nv = v + Math.sin(branch * 2.4) * 0.085;
          points.push(...point(u, v), ...point(nu, v), ...point(nu, v), ...point(nu, nv));
          u = nu; v = nv;
        }
      }
    }
    if (this.miningCracks.size >= 24) {
      const [oldKey, cue] = this.miningCracks.entries().next().value;
      this.scene.remove(cue.mesh); cue.mesh.geometry.dispose(); cue.mesh.material.dispose();
      this.miningCracks.delete(oldKey);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    const mesh = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x171c19 }));
    mesh.position.set(ev.x + 0.5, ev.y + 0.5, ev.z + 0.5);
    this.scene.add(mesh);
    this.miningCracks.set(key, { mesh, life: 0.8, x: ev.x, y: ev.y, z: ev.z });
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
    for (const [key, cue] of this.miningCracks) {
      cue.life -= dt;
      if (cue.life <= 0 || !this.getBlockFn(cue.x, cue.y, cue.z)) {
        this.scene.remove(cue.mesh); cue.mesh.geometry.dispose(); cue.mesh.material.dispose();
        this.miningCracks.delete(key);
      }
    }
    for (let i = 0; i < this.impacts.length; i++) {
      const cue = this.impacts[i];
      if (!cue.active) continue;
      cue.t += dt;
      if (cue.t >= cue.life) {
        cue.active = false;
        for (const mesh of this.impactMeshes) hideInstance(mesh, i);
        continue;
      }
      this._updateImpactCue(i, cue, cue.t / cue.life);
    }
    for (const mesh of this.impactMeshes) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      if (!p.active) continue;
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
      if (p.vy < 0 && wasVy >= 0 === false) {
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
    this.partMesh.instanceMatrix.needsUpdate = true;
    if (this.partMesh.instanceColor) this.partMesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const cue of this.miningCracks.values()) {
      this.scene.remove(cue.mesh); cue.mesh.geometry.dispose(); cue.mesh.material.dispose();
    }
    this.miningCracks.clear();
    for (const mesh of [this.partMesh, ...this.impactMeshes]) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }
}
