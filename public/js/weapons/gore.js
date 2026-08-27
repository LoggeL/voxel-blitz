// Bounded blood mist, ballistic droplets, surface stains, and local camera veil.
import * as THREE from '../vendor/three.module.js';
import { freeOldestIndex, hideInstance } from './instancing.js';

const TAU = Math.PI * 2;
const GORE_MIST_POOL_SIZE = 96;
const GORE_DROPLET_POOL_SIZE = 144;
const GORE_STAIN_POOL_SIZE = 48;
const GORE_VEIL_POOL_SIZE = 12;
const BLOOD_RED = Object.freeze({ r: 0.34, g: 0.012, b: 0.018 });
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
        toneMapped: false,
      }),
      GORE_STAIN_POOL_SIZE,
    );
    this.goreVeilMesh = new THREE.InstancedMesh(
      new THREE.CircleGeometry(1, 12),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
      GORE_VEIL_POOL_SIZE,
    );
    this.goreMeshes = [
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
    const mistCount = lethal ? (headshot ? 24 : 19) : (headshot ? 16 : 9);
    const dropletCount = lethal ? (headshot ? 26 : 21) : (headshot ? 16 : 9);
    const width = severe ? (lethal ? 5.8 : 4.6) : 3.1;

    for (let i = 0; i < mistCount; i++) {
      const idx = this._claimSlot(this.goreMist);
      const p = this.goreMist[idx];
      const speed = width * (0.3 + Math.random() * 0.7);
      p.active = true;
      p.t = 0;
      p.life = (severe ? 0.48 : 0.36) * (0.72 + Math.random() * 0.45);
      p.x = x;
      p.y = y;
      p.z = z;
      p.vx = (Math.random() - 0.5) * speed + this._normal.x * speed * 0.48;
      p.vy = (Math.random() - 0.32) * speed + this._normal.y * speed * 0.48;
      p.vz = (Math.random() - 0.5) * speed + this._normal.z * speed * 0.48;
      p.size = (severe ? 0.105 : 0.075) * (0.65 + Math.random() * 0.7);
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
      p.life = 1.05 + Math.random() * 0.7;
      p.x = x;
      p.y = y;
      p.z = z;
      p.vx = (Math.random() - 0.5) * speed + this._normal.x * speed * 0.62;
      p.vy = Math.random() * speed * 0.8 + 0.7 + this._normal.y * speed * 0.35;
      p.vz = (Math.random() - 0.5) * speed + this._normal.z * speed * 0.62;
      p.size = (severe ? 0.026 : 0.019) * (0.65 + Math.random() * 0.8);
      this._m4.compose(
        this._v.set(x, y, z), this._q.identity(), this._s.setScalar(p.size),
      );
      this.goreDropletMesh.setMatrixAt(idx, this._m4);
    }

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
    stain.life = 2.1 + Math.random() * 1.2;
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

  update(dt) {
    for (let i = 0; i < this.goreMist.length; i++) {
      const p = this.goreMist[i];
      if (!p.active) continue;
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
    this.goreMistMesh.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < this.goreDroplets.length; i++) {
      const p = this.goreDroplets[i];
      if (!p.active) continue;
      p.t += dt;
      if (p.t >= p.life) {
        p.active = false;
        hideInstance(this.goreDropletMesh, i);
        continue;
      }
      p.vy -= 13.5 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (this.getBlockFn(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))) {
        const ax = Math.abs(p.vx);
        const ay = Math.abs(p.vy);
        const az = Math.abs(p.vz);
        let cx = p.x;
        let cy = p.y;
        let cz = p.z;
        let nx = 0;
        let ny = 0;
        let nz = 0;
        if (ax >= ay && ax >= az) {
          const bx = Math.floor(p.x);
          nx = p.vx > 0 ? -1 : 1;
          cx = p.vx > 0 ? bx - 0.006 : bx + 1.006;
        } else if (ay >= az) {
          const by = Math.floor(p.y);
          ny = p.vy > 0 ? -1 : 1;
          cy = p.vy > 0 ? by - 0.006 : by + 1.006;
        } else {
          const bz = Math.floor(p.z);
          nz = p.vz > 0 ? -1 : 1;
          cz = p.vz > 0 ? bz - 0.006 : bz + 1.006;
        }
        p.active = false;
        hideInstance(this.goreDropletMesh, i);
        this.spawnBloodStain(cx, cy, cz, nx, ny, nz, p.size * 5.4);
        continue;
      }
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
    this.goreDropletMesh.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < this.goreStains.length; i++) {
      const stain = this.goreStains[i];
      if (!stain.active) continue;
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
    this.goreStainMesh.instanceMatrix.needsUpdate = true;

    if (this.camera && this.camera.position && this.camera.quaternion) {
      this.camera.getWorldDirection(this._forward);
      this._right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
      this._normal.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
      for (let i = 0; i < this.goreVeil.length; i++) {
        const veil = this.goreVeil[i];
        if (!veil.active) continue;
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
        this.goreVeil[i].active = false;
        hideInstance(this.goreVeilMesh, i);
      }
    }
    this.goreVeilMesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const mesh of this.goreMeshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }
}
