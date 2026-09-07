// Bounded blood mist, ballistic droplets, surface stains, and local camera veil.
import * as THREE from '../vendor/three.module.js';
import { freeOldestIndex, hideInstance } from './instancing.js';
import { raycastVoxels } from '../../../shared/raycast.js';

const TAU = Math.PI * 2;
const GORE_MIST_POOL_SIZE = 256;
const GORE_DROPLET_POOL_SIZE = 640;
const GORE_STAIN_POOL_SIZE = 384;
const GORE_VEIL_POOL_SIZE = 12;
const GORE_CHUNK_POOL_SIZE = 192;
const BLOOD_RED = Object.freeze({ r: 0.56, g: 0.012, b: 0.025 });
const BLOOD_DARK = Object.freeze({ r: 0.11, g: 0.003, b: 0.005 });

export class GoreFX {
  constructor(scene, camera, worldGetBlockFn) {
    this.scene = scene;
    this.camera = camera;
    this.getBlockFn = worldGetBlockFn || (() => 0);
    this._disposed = false;

    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._col = new THREE.Color();
    this._e = new THREE.Euler();
    this._normal = new THREE.Vector3();
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();

    this.goreMistMesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
        toneMapped: false,
      }),
      GORE_MIST_POOL_SIZE,
    );
    this.goreDropletMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 5, 3),
      new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
      GORE_DROPLET_POOL_SIZE,
    );
    this.goreStainMesh = new THREE.InstancedMesh(
      new THREE.CircleGeometry(1, 14),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.84,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        side: THREE.DoubleSide,
        forceSinglePass: true,
        toneMapped: false,
      }),
      GORE_STAIN_POOL_SIZE,
    );
    // A ragged silhouette gives every surface splash a torn edge.
    const edge = this.goreStainMesh.geometry.attributes.position;
    for (let i = 1; i < edge.count; i++) {
      const radius = i % 3 === 0 ? 0.58 : (i % 2 ? 1 : 0.82);
      edge.setXY(i, edge.getX(i) * radius, edge.getY(i) * radius);
    }
    edge.needsUpdate = true;
    this.goreChunkMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      GORE_CHUNK_POOL_SIZE,
    );
    this.goreChunks = Array.from({ length: GORE_CHUNK_POOL_SIZE }, (_, i) => {
      hideInstance(this.goreChunkMesh, i);
      this.goreChunkMesh.setColorAt(i, this._col.setHex(i % 4 === 0 ? 0xc7ac89 : (i % 2 ? 0x880e20 : 0x4b0711)));
      return { active: false, t: 0, life: 1, x: 0, y: 0, z: 0,
        vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, spin: 0,
        sx: 0, sy: 0, sz: 0, settled: false, trail: 0 };
    });
    this.goreVeilMesh = new THREE.InstancedMesh(
      new THREE.CircleGeometry(1, 12),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        forceSinglePass: true,
        toneMapped: false,
      }),
      GORE_VEIL_POOL_SIZE,
    );
    this.goreMeshes = [
      this.goreChunkMesh,
      this.goreMistMesh,
      this.goreDropletMesh,
      this.goreStainMesh,
      this.goreVeilMesh,
    ];
    this.goreMist = new Array(GORE_MIST_POOL_SIZE);
    this.goreDroplets = new Array(GORE_DROPLET_POOL_SIZE);
    this.goreStains = new Array(GORE_STAIN_POOL_SIZE);
    this.goreVeil = new Array(GORE_VEIL_POOL_SIZE);

    for (const mesh of this.goreMeshes) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
    this.goreStainMesh.renderOrder = 2;
    this.goreVeilMesh.renderOrder = 7;

    for (let i = 0; i < GORE_MIST_POOL_SIZE; i++) {
      this.goreMist[i] = {
        active: false, t: 0, life: 0,
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size: 0,
      };
      hideInstance(this.goreMistMesh, i);
      this.goreMistMesh.setColorAt(
        i, this._col.setRGB(BLOOD_RED.r, BLOOD_RED.g, BLOOD_RED.b),
      );
    }
    for (let i = 0; i < GORE_DROPLET_POOL_SIZE; i++) {
      this.goreDroplets[i] = {
        active: false, t: 0, life: 0,
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size: 0,
      };
      hideInstance(this.goreDropletMesh, i);
      this.goreDropletMesh.setColorAt(
        i, this._col.setRGB(BLOOD_RED.r, BLOOD_RED.g, BLOOD_RED.b),
      );
    }
    for (let i = 0; i < GORE_STAIN_POOL_SIZE; i++) {
      this.goreStains[i] = {
        active: false, t: 0, life: 0,
        x: 0, y: 0, z: 0,
        qx: 0, qy: 0, qz: 0, qw: 1, size: 0,
      };
      hideInstance(this.goreStainMesh, i);
      this.goreStainMesh.setColorAt(
        i, this._col.setRGB(BLOOD_DARK.r, BLOOD_DARK.g, BLOOD_DARK.b),
      );
    }
    for (let i = 0; i < GORE_VEIL_POOL_SIZE; i++) {
      this.goreVeil[i] = {
        active: false, t: 0, life: 0,
        side: 0, lift: 0, size: 0, rot: 0,
      };
      hideInstance(this.goreVeilMesh, i);
      this.goreVeilMesh.setColorAt(
        i, this._col.setRGB(BLOOD_RED.r, BLOOD_RED.g, BLOOD_RED.b),
      );
    }
  }

  /** ev: {vx,vy,vz, hs?, nx?,ny?,nz?, normal?:[x,y,z]} */
  gore(ev, { lethal = false, local = false } = {}) {
    const x = ev && Number(ev.vx);
    const y = ev && Number(ev.vy);
    const z = ev && Number(ev.vz);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

    const normal = ev && Array.isArray(ev.normal) ? ev.normal : null;
    const nx = Number(normal ? normal[0] : ev.nx);
    const ny = Number(normal ? normal[1] : ev.ny);
    const nz = Number(normal ? normal[2] : ev.nz);
    const suppliedNormal = Number.isFinite(nx)
      && Number.isFinite(ny)
      && Number.isFinite(nz)
      && nx * nx + ny * ny + nz * nz > 0.0001;
    if (suppliedNormal) {
      this._normal.set(nx, ny, nz).normalize();
    } else if (this.camera && this.camera.position) {
      this._normal.set(
        this.camera.position.x - x,
        this.camera.position.y - y,
        this.camera.position.z - z,
      );
      if (this._normal.lengthSq() > 0.0001) this._normal.normalize();
      else this._normal.set(0, 1, 0);
    } else {
      this._normal.set(0, 1, 0);
    }

    const headshot = !!ev.hs;
    const severe = headshot || lethal;
    const mistCount = lethal ? (headshot ? 88 : 64) : (headshot ? 32 : 20);
    const dropletCount = lethal ? (headshot ? 160 : 120) : (headshot ? 48 : 30);
    const width = severe ? (lethal ? 13.5 : 6.8) : 4.2;

    for (let i = 0; i < mistCount; i++) {
      const idx = this._claimSlot(this.goreMist);
      const p = this.goreMist[idx];
      const speed = width * (0.3 + Math.random() * 0.7);
      p.active = true;
      p.t = 0;
      p.life = (severe ? 0.68 : 0.42) * (0.72 + Math.random() * 0.45);
      p.x = x;
      p.y = y;
      p.z = z;
      p.vx = (Math.random() - 0.5) * speed + this._normal.x * speed * 0.48;
      p.vy = (Math.random() - 0.32) * speed + this._normal.y * speed * 0.48;
      p.vz = (Math.random() - 0.5) * speed + this._normal.z * speed * 0.48;
      p.size = (lethal ? 0.21 : (severe ? 0.14 : 0.095)) * (0.65 + Math.random() * 0.7);
      this._m4.compose(
        this._v.set(x, y, z), this._q.identity(), this._s.setScalar(p.size),
      );
      this.goreMistMesh.setMatrixAt(idx, this._m4);
    }

    for (let i = 0; i < dropletCount; i++) {
      const idx = this._claimSlot(this.goreDroplets);
      const p = this.goreDroplets[idx];
      const speed = width * (0.42 + Math.random() * 0.95);
      p.active = true;
      p.t = 0;
      p.life = 1.6 + Math.random() * 0.9;
      p.x = x;
      p.y = y;
      p.z = z;
      p.vx = (Math.random() - 0.5) * speed + this._normal.x * speed * 0.62;
      p.vy = Math.random() * speed * 0.8 + 0.7 + this._normal.y * speed * 0.35;
      p.vz = (Math.random() - 0.5) * speed + this._normal.z * speed * 0.62;
      p.size = (lethal ? 0.058 : (severe ? 0.038 : 0.028)) * (0.65 + Math.random() * 0.8);
      this._m4.compose(
        this._v.set(x, y, z), this._q.identity(), this._s.setScalar(p.size),
      );
      this.goreDropletMesh.setMatrixAt(idx, this._m4);
    }

    if (lethal) this.spawnChunks(x, y, z, headshot);

    if (suppliedNormal) {
      this.spawnBloodStain(
        x + this._normal.x * 0.012,
        y + this._normal.y * 0.012,
        z + this._normal.z * 0.012,
        this._normal.x,
        this._normal.y,
        this._normal.z,
        severe ? 0.24 : 0.15,
      );
    }

    if (local && this.camera) {
      const veilCount = lethal ? 6 : (headshot ? 5 : 3);
      for (let i = 0; i < veilCount; i++) {
        const idx = this._claimSlot(this.goreVeil);
        const veil = this.goreVeil[idx];
        veil.active = true;
        veil.t = 0;
        veil.life = (lethal ? 0.72 : 0.48) * (0.75 + Math.random() * 0.35);
        veil.side = (i & 1 ? 1 : -1) * (0.78 + Math.random() * 0.32);
        veil.lift = (Math.random() - 0.5) * 1.35;
        veil.size = (lethal ? 0.048 : 0.035) * (0.72 + Math.random() * 0.55);
        veil.rot = Math.random() * TAU;
      }
    }

    for (const mesh of this.goreMeshes) mesh.instanceMatrix.needsUpdate = true;
  }

  _claimSlot(pool) {
    for (let i = 0; i < pool.length; i++) {
      if (!pool[i].active) return i;
    }
    return freeOldestIndex(pool);
  }

  spawnBloodStain(x, y, z, nx, ny, nz, size) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    this._normal.set(nx, ny, nz);
    if (this._normal.lengthSq() < 0.0001) return;
    this._normal.normalize();
    const idx = this._claimSlot(this.goreStains);
    const stain = this.goreStains[idx];
    stain.active = true;
    stain.t = 0;
    stain.life = 12 + Math.random() * 8;
    stain.x = x;
    stain.y = y;
    stain.z = z;
    stain.size = size * (0.75 + Math.random() * 0.5);
    this._q.setFromUnitVectors(this._forward.set(0, 0, 1), this._normal);
    stain.qx = this._q.x;
    stain.qy = this._q.y;
    stain.qz = this._q.z;
    stain.qw = this._q.w;
    this._m4.compose(
      this._v.set(x, y, z),
      this._q,
      this._s.set(stain.size * 1.35, stain.size * 0.78, 1),
    );
    this.goreStainMesh.setMatrixAt(idx, this._m4);
    this.goreStainMesh.instanceMatrix.needsUpdate = true;
  }

  spawnChunks(x, y, z, headshot) {
    for (let i = 0; i < (headshot ? 46 : 34); i++) {
      const index = this._claimSlot(this.goreChunks);
      const p = this.goreChunks[index];
      const angle = Math.random() * TAU;
      const speed = 4 + Math.random() * 8;
      Object.assign(p, {
        active: true, t: 0, life: 6 + Math.random() * 4,
        x, y, z, vx: Math.cos(angle) * speed, vy: 5 + Math.random() * 8,
        vz: Math.sin(angle) * speed, rx: angle, ry: 0, rz: angle,
        spin: (Math.random() - 0.5) * 26, settled: false, trail: 0, squash: 0,
        sx: 0.09 + Math.random() * 0.15,
        sy: 0.18 + Math.random() * 0.30,
        sz: 0.08 + Math.random() * 0.14,
      });
      this._drawChunk(p, index);
    }
  }

  _drawChunk(p, index) {
    const fade = Math.min(1, (p.life - p.t) * 2);
    const squash = 1 + (p.squash || 0);
    this._q.setFromEuler(this._e.set(p.rx, p.ry, p.rz));
    this._m4.compose(this._v.set(p.x, p.y, p.z), this._q,
      this._s.set(p.sx * fade * squash, p.sy * fade / squash, p.sz * fade * squash));
    this.goreChunkMesh.setMatrixAt(index, this._m4);
  }

  _updateChunks(dt) {
    let chunksDirty = false;
    for (let i = 0; i < this.goreChunks.length; i++) {
      const p = this.goreChunks[i];
      if (!p.active) continue;
      chunksDirty = true;
      p.t += dt;
      if (p.t >= p.life) {
        p.active = false;
        hideInstance(this.goreChunkMesh, i);
        continue;
      }
      p.squash = Math.max(0, (p.squash || 0) - dt * 5);
      if (!p.settled) {
        p.vy -= 15 * dt;
        const distance = Math.hypot(p.vx, p.vy, p.vz) * dt;
        const hit = raycastVoxels(this.getBlockFn, p.x, p.y, p.z, p.vx, p.vy, p.vz, distance);
        if (hit) {
          const f = distance > 0 ? hit.t / distance : 0;
          const cx = p.x + p.vx * dt * f, cy = p.y + p.vy * dt * f, cz = p.z + p.vz * dt * f;
          this.spawnBloodStain(cx + hit.nx * 0.015, cy + hit.ny * 0.015,
            cz + hit.nz * 0.015, hit.nx, hit.ny, hit.nz, 0.28 + p.sy * 0.9);
          p.x = cx + hit.nx * 0.12;
          p.y = cy + hit.ny * 0.12;
          p.z = cz + hit.nz * 0.12;
          p.squash = 0.65;
          const dot = p.vx * hit.nx + p.vy * hit.ny + p.vz * hit.nz;
          p.vx = (p.vx - 1.65 * dot * hit.nx) * 0.72;
          p.vy = (p.vy - 1.65 * dot * hit.ny) * 0.72;
          p.vz = (p.vz - 1.65 * dot * hit.nz) * 0.72;
          if (hit.ny > 0 && Math.hypot(p.vx, p.vy, p.vz) < 1.5) p.settled = true;
          // A spawn already inside cover has no entry face.
          if (!hit.nx && !hit.ny && !hit.nz) p.settled = true;
        } else {
          p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        }
        p.rx += p.spin * dt; p.ry += p.spin * dt * 0.7; p.rz += p.spin * dt * 0.4;
        p.trail += dt;
        if (p.trail > 0.065 && p.t < 1.6) {
          p.trail = 0;
          const index = this._claimSlot(this.goreDroplets);
          Object.assign(this.goreDroplets[index], { active: true, t: 0, life: 1.4,
            x: p.x, y: p.y, z: p.z, vx: p.vx * 0.1, vy: -0.4, vz: p.vz * 0.1, size: 0.038 });
        }
      }
      this._drawChunk(p, i);
    }
    if (chunksDirty) this.goreChunkMesh.instanceMatrix.needsUpdate = true;
  }

  update(dt) {
    this._updateChunks(dt);
    let mistDirty = false;
    for (let i = 0; i < this.goreMist.length; i++) {
      const p = this.goreMist[i];
      if (!p.active) continue;
      mistDirty = true;
      p.t += dt;
      if (p.t >= p.life) {
        p.active = false;
        hideInstance(this.goreMistMesh, i);
        continue;
      }
      const u = p.t / p.life;
      const drag = Math.max(0, 1 - dt * 3.4);
      p.vx *= drag;
      p.vy = p.vy * drag - 2.2 * dt;
      p.vz *= drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const fade = 1 - u;
      const scale = p.size * (0.7 + u * 3.2) * Math.min(1, fade * 3.5);
      this._s.set(scale * 1.45, scale, scale * 1.45);
      this._m4.compose(
        this._v.set(p.x, p.y, p.z), this._q.identity(), this._s,
      );
      this.goreMistMesh.setMatrixAt(i, this._m4);
    }
    if (mistDirty) this.goreMistMesh.instanceMatrix.needsUpdate = true;

    let dropletsDirty = false;
    for (let i = 0; i < this.goreDroplets.length; i++) {
      const p = this.goreDroplets[i];
      if (!p.active) continue;
      dropletsDirty = true;
      p.t += dt;
      if (p.t >= p.life) {
        p.active = false;
        hideInstance(this.goreDropletMesh, i);
        continue;
      }
      p.vy -= 13.5 * dt;
      const distance = Math.hypot(p.vx, p.vy, p.vz) * dt;
      const hit = raycastVoxels(this.getBlockFn, p.x, p.y, p.z, p.vx, p.vy, p.vz, distance);
      if (hit) {
        const f = distance > 0 ? hit.t / distance : 0;
        p.active = false;
        hideInstance(this.goreDropletMesh, i);
        this.spawnBloodStain(
          p.x + p.vx * dt * f + hit.nx * 0.012,
          p.y + p.vy * dt * f + hit.ny * 0.012,
          p.z + p.vz * dt * f + hit.nz * 0.012,
          hit.nx, hit.ny, hit.nz, p.size * 10,
        );
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz);
      this._normal.set(p.vx, p.vy, p.vz);
      if (speed > 0.0001) this._normal.multiplyScalar(1 / speed);
      else this._normal.set(0, 1, 0);
      this._q.setFromUnitVectors(this._up, this._normal);
      this._s.set(
        p.size,
        p.size * (1.35 + Math.min(2.4, speed * 0.2)),
        p.size,
      );
      this._m4.compose(this._v.set(p.x, p.y, p.z), this._q, this._s);
      this.goreDropletMesh.setMatrixAt(i, this._m4);
    }
    if (dropletsDirty) this.goreDropletMesh.instanceMatrix.needsUpdate = true;

    let stainsDirty = false;
    for (let i = 0; i < this.goreStains.length; i++) {
      const stain = this.goreStains[i];
      if (!stain.active) continue;
      stainsDirty = true;
      stain.t += dt;
      if (stain.t >= stain.life) {
        stain.active = false;
        hideInstance(this.goreStainMesh, i);
        continue;
      }
      const fade = Math.min(1, (1 - stain.t / stain.life) * 4);
      this._q.set(stain.qx, stain.qy, stain.qz, stain.qw);
      this._m4.compose(
        this._v.set(stain.x, stain.y, stain.z),
        this._q,
        this._s.set(stain.size * 1.35 * fade, stain.size * 0.78 * fade, 1),
      );
      this.goreStainMesh.setMatrixAt(i, this._m4);
    }
    if (stainsDirty) this.goreStainMesh.instanceMatrix.needsUpdate = true;

    let veilDirty = false;
    if (this.camera && this.camera.position && this.camera.quaternion) {
      this.camera.getWorldDirection(this._forward);
      this._right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
      this._normal.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
      for (let i = 0; i < this.goreVeil.length; i++) {
        const veil = this.goreVeil[i];
        if (!veil.active) continue;
        veilDirty = true;
        veil.t += dt;
        if (veil.t >= veil.life) {
          veil.active = false;
          hideInstance(this.goreVeilMesh, i);
          continue;
        }
        const u = veil.t / veil.life;
        const fade = Math.min(1, (1 - u) * 3.5);
        const side = veil.side * (1 + u * 0.16);
        this._v.copy(this.camera.position)
          .addScaledVector(this._forward, 0.24)
          .addScaledVector(this._right, side * 0.115)
          .addScaledVector(this._normal, (veil.lift + u * 0.35) * 0.07);
        this._e.set(0, 0, veil.rot + u * 0.3);
        this._q.setFromEuler(this._e).premultiply(this.camera.quaternion);
        this._s.set(veil.size * 1.55 * fade, veil.size * 0.72 * fade, 1);
        this._m4.compose(this._v, this._q, this._s);
        this.goreVeilMesh.setMatrixAt(i, this._m4);
      }
    } else {
      for (let i = 0; i < this.goreVeil.length; i++) {
        if (!this.goreVeil[i].active) continue;
        veilDirty = true;
        this.goreVeil[i].active = false;
        hideInstance(this.goreVeilMesh, i);
      }
    }
    if (veilDirty) this.goreVeilMesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const mesh of this.goreMeshes) {
      this.scene.remove(mesh);
      mesh.dispose();
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }
}
