import * as THREE from '../vendor/three.module.js';
import { raycastVoxels } from '../../../shared/raycast.js';
import { WEAPONS } from '../../../shared/combatmath.js';
function flameTexture() {
  const size = 64, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + 0.5) / size * 2 - 1, v = (y + 0.5) / size * 2 - 1;
    const radius = Math.hypot(u / (0.7 - v * 0.2), v);
    const alpha = Math.max(0, 1 - radius);
    const i = (y * size + x) * 4;
    data[i] = 255; data[i + 1] = 180 + Math.round(alpha * 75);
    data[i + 2] = 60 + Math.round(alpha * 170); data[i + 3] = Math.round(alpha * alpha * 255);
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Fixed pool of expanding fire puffs. Terrain clips each puff's travel. */
export class FlameFX {
  constructor(scene, getBlock) {
    this.getBlock = getBlock;
    this.muzzleProvider = null;
    this.origin = new THREE.Vector3();
    this.texture = flameTexture();
    this.cursor = 0;
    this.puffs = Array.from({ length: 128 }, () => {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.texture, color: 0xff7518, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      }));
      sprite.visible = false;
      scene.add(sprite);
      return { sprite, age: 0, life: 0, velocity: new THREE.Vector3() };
    });
  }

  shoot(event, options = {}) {
    if (!Array.isArray(event.o) || !Array.isArray(event.d)) return;
    this.origin.fromArray(event.o);
    if (options.local && this.muzzleProvider) this.muzzleProvider(this.origin);
    const forward = new THREE.Vector3().fromArray(event.d).normalize();
    const right = new THREE.Vector3(0, 1, 0).cross(forward);
    if (right.lengthSq() < 0.001) right.set(1, 0, 0);
    right.normalize();
    const up = forward.clone().cross(right).normalize();
    const rules = WEAPONS.flamethrower;
    for (let i = 0; i < 16; i++) {
      const puff = this.puffs[this.cursor++ % this.puffs.length];
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.sqrt(Math.random()) * Math.tan(rules.flame.coneDeg * Math.PI / 360);
      const direction = forward.clone().addScaledVector(right, Math.cos(angle) * radius)
        .addScaledVector(up, Math.sin(angle) * radius).normalize();
      const hit = raycastVoxels(this.getBlock, ...this.origin.toArray(), ...direction.toArray(), rules.range);
      const reach = hit ? Math.max(0, hit.t - 0.12) : rules.range;
      puff.age = -i * 0.007;
      puff.life = reach / 28;
      puff.velocity.copy(direction).multiplyScalar(28);
      puff.sprite.position.copy(this.origin);
      puff.sprite.visible = false;
      puff.sprite.material.rotation = Math.random() * Math.PI;
    }
  }

  update(dt) {
    for (const puff of this.puffs) {
      const before = Math.max(0, puff.age);
      puff.age += dt;
      const active = puff.age >= 0 && puff.age < puff.life;
      puff.sprite.visible = active;
      if (!active) continue;
      puff.sprite.position.addScaledVector(puff.velocity, puff.age - before);
      const t = puff.age / puff.life;
      puff.sprite.scale.setScalar(0.24 + t * 1.25);
      puff.sprite.material.opacity = Math.min(1, (1 - t) * 2.5) * 0.78;
      puff.sprite.material.color.setRGB(1, 0.55 - t * 0.4, 0.04);
    }
  }

  dispose() {
    for (const { sprite } of this.puffs) { sprite.removeFromParent(); sprite.material.dispose(); }
    this.texture.dispose();
  }
}
