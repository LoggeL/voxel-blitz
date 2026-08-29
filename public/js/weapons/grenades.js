import * as THREE from '../vendor/three.module.js';

const GRAVITY = 18;
const BOUNCE = 0.46;

const solid = (getBlock, x, y, z) => (
  getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) !== 0
);

/** Predicted presentation for authoritative grenade throw/explosion events. */
export class GrenadeFX {
  constructor(scene, getBlock = () => 0) {
    this.scene = scene;
    this.getBlock = getBlock;
    this.projectiles = new Map();
    this.blasts = [];

    this.bodyGeometry = new THREE.BoxGeometry(0.26, 0.26, 0.26);
    this.capGeometry = new THREE.BoxGeometry(0.1, 0.08, 0.13);
    this.blastGeometry = new THREE.IcosahedronGeometry(1, 2);
    this.bodyMaterial = new THREE.MeshStandardMaterial({
      color: 0x20242a,
      roughness: 0.48,
      metalness: 0.78,
    });
    this.capMaterial = new THREE.MeshBasicMaterial({ color: 0xff9f1c, toneMapped: false });
  }

  throw(event) {
    if (!event?.gid || this.projectiles.has(String(event.gid)) ||
        !Array.isArray(event.o) || !Array.isArray(event.v)) return false;
    const values = [...event.o, ...event.v].map(Number);
    if (!values.every(Number.isFinite)) return false;

    const group = new THREE.Group();
    const body = new THREE.Mesh(this.bodyGeometry, this.bodyMaterial);
    body.rotation.set(0.35, 0.45, 0.12);
    const cap = new THREE.Mesh(this.capGeometry, this.capMaterial);
    cap.position.set(0, 0.17, 0);
    group.add(body, cap);
    group.position.set(values[0], values[1], values[2]);
    this.scene.add(group);
    this.projectiles.set(String(event.gid), {
      group,
      vx: values[3],
      vy: values[4],
      vz: values[5],
      age: 0,
      fuse: Math.max(0.3, (Number(event.fuse) || 2300) / 1000),
    });
    return true;
  }

  explode(event) {
    const id = String(event?.gid || '');
    this._removeProjectile(id);
    const x = Number(event?.x), y = Number(event?.y), z = Number(event?.z);
    if (![x, y, z].every(Number.isFinite)) return false;
    const material = new THREE.MeshBasicMaterial({
      color: 0xff9f1c,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(this.blastGeometry, material);
    mesh.position.set(x, y, z);
    mesh.scale.setScalar(0.08);
    mesh.renderOrder = 9;
    this.scene.add(mesh);
    this.blasts.push({ mesh, material, age: 0, life: 0.42, radius: Number(event.radius) || 5.6 });
    return true;
  }

  update(dt) {
    const step = Math.max(0, Math.min(0.05, Number(dt) || 0));
    for (const [id, grenade] of this.projectiles) {
      grenade.age += step;
      grenade.vy -= GRAVITY * step;
      this._move(grenade, 'x', grenade.vx * step);
      this._move(grenade, 'z', grenade.vz * step);
      this._move(grenade, 'y', grenade.vy * step);
      grenade.group.rotation.x += step * 7.4;
      grenade.group.rotation.z += step * 5.2;
      if (grenade.age > grenade.fuse + 1) this._removeProjectile(id);
    }

    for (let index = this.blasts.length - 1; index >= 0; index--) {
      const blast = this.blasts[index];
      blast.age += step;
      const t = Math.min(1, blast.age / blast.life);
      const eased = 1 - Math.pow(1 - t, 3);
      blast.mesh.scale.setScalar(0.08 + blast.radius * 0.38 * eased);
      blast.material.opacity = Math.max(0, (1 - t) * (1 - t) * 0.9);
      if (t >= 1) {
        this.scene.remove(blast.mesh);
        blast.material.dispose();
        this.blasts.splice(index, 1);
      }
    }
  }

  _move(grenade, axis, delta) {
    if (Math.abs(delta) < 1e-7) return;
    const next = grenade.group.position[axis] + delta;
    const x = axis === 'x' ? next : grenade.group.position.x;
    const y = axis === 'y' ? next : grenade.group.position.y;
    const z = axis === 'z' ? next : grenade.group.position.z;
    if (!solid(this.getBlock, x, y, z)) {
      grenade.group.position[axis] = next;
      return;
    }
    grenade['v' + axis] *= -BOUNCE;
    if (axis === 'y' && grenade['v' + axis] > 0) {
      grenade.vx *= 0.82;
      grenade.vz *= 0.82;
    }
  }

  _removeProjectile(id) {
    const grenade = this.projectiles.get(id);
    if (!grenade) return false;
    this.scene.remove(grenade.group);
    this.projectiles.delete(id);
    return true;
  }

  dispose() {
    for (const id of Array.from(this.projectiles.keys())) this._removeProjectile(id);
    for (const blast of this.blasts) {
      this.scene.remove(blast.mesh);
      blast.material.dispose();
    }
    this.blasts.length = 0;
    this.bodyGeometry.dispose();
    this.capGeometry.dispose();
    this.blastGeometry.dispose();
    this.bodyMaterial.dispose();
    this.capMaterial.dispose();
  }
}

