import * as THREE from '../vendor/three.module.js';
import { WEAPONS, HITSCAN_REACH, chargeShotProfile, chargeDamageMult, damageAtDistance } from '../../../shared/combatmath.js';
import { BLOCK_HP } from '../../../shared/world/blocks.js';
import { BULLET_RULES, bulletPower, bulletMaterialImpact, voxelExitDistance } from '../../../shared/bullet-material.js';
import { raycastVoxels } from '../../../shared/raycast.js';
import { SX, SY, SZ } from '../../../shared/worlddata.js';

const AXIS = new THREE.Vector3(0, 0, -1);
const POOL_SIZE = 12;

/** Fixed pool of layered energy beams: white core, violet corona, expanding ion rings. */
export class RailBeamFX {
  constructor(scene, getBlock) {
    this.scene = scene;
    this.getBlock = getBlock;
    this.cursor = 0;
    const pixels = new Uint8Array(32 * 32 * 4);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const offset = (y * 32 + x) * 4;
      pixels[offset] = 185; pixels[offset + 1] = 145; pixels[offset + 2] = 255;
      pixels[offset + 3] = Math.round(255 * Math.pow(Math.max(0, 1 - Math.hypot(x - 15.5, y - 15.5) / 16), 2));
    }
    this.glowTexture = new THREE.DataTexture(pixels, 32, 32);
    this.glowTexture.magFilter = THREE.LinearFilter;
    this.glowTexture.minFilter = THREE.LinearFilter;
    this.glowTexture.needsUpdate = true;
    this.muzzleProvider = null;
    this.geometry = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);
    this.geometry.rotateX(Math.PI / 2);
    this.geometry.translate(0, 0, -0.5);
    this.ringGeometry = new THREE.TorusGeometry(1, 0.045, 4, 24);
    this.pool = Array.from({ length: POOL_SIZE }, () => {
      const group = new THREE.Group();
      const layers = [0xf7ffff, 0xaa89ff, 0x633bff].map((color) => {
        const mesh = new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial({
          color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        group.add(mesh);
        return mesh;
      });
      const rings = Array.from({ length: 5 }, () => {
        const mesh = new THREE.Mesh(this.ringGeometry, new THREE.MeshBasicMaterial({
          color: 0x9defff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        group.add(mesh);
        return mesh;
      });
      const glows = [0, 1].map(() => {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
          map: this.glowTexture, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        group.add(sprite);
        return sprite;
      });
      group.visible = false;
      scene.add(group);
      return { group, layers, rings, glows, age: 0, life: 0, charge: 0, length: 0 };
    });
  }

  shoot(event, { local = false } = {}) {
    if (Array.isArray(event.paths)) {
      for (const path of event.paths) {
        let origin = path[0]?.o;
        for (let i = 0; i < path.length; i++) {
          const segment = path[i];
          if (segment.action !== 'ricochet' && i < path.length - 1) continue;
          const d = segment.end.map((value, axis) => value - origin[axis]);
          if (Math.hypot(...d) > 0.001) this.shoot({ ...event, paths: undefined,
            o: origin, d, spread: d, resolvedEnd: segment.end }, { local: false });
          origin = path[i + 1]?.o;
        }
      }
      return;
    }
    const charge = Math.max(0, Math.min(1, event.charge ?? 1));
    const raw = event.spread || event.d;
    const direction = Array.isArray(raw) ? new THREE.Vector3(...raw) : new THREE.Vector3(raw.x, raw.y, raw.z);
    direction.normalize();
    const eye = new THREE.Vector3(...event.o);
    const profile = chargeShotProfile(WEAPONS.lance, charge);
    const chaosArc = event.chaosArc && Number.isFinite(event.reach);
    // Empty-sky beams need finite geometry, but a terrain hit can be as distant
    // as the world permits. This fallback does not constrain authoritative hits.
    let length = chaosArc ? Math.max(0.1, Math.min(9, event.reach)) : Math.hypot(SX, SY, SZ);
    const traceReach = chaosArc ? length : HITSCAN_REACH;
    const pierced = new Set();
    let power = bulletPower(WEAPONS.lance, charge);
    let damageScale = chargeDamageMult(WEAPONS.lance, charge);
    for (let wall = 0; !event.resolvedEnd && wall < BULLET_RULES.maxContacts; wall++) {
      const hit = raycastVoxels((x, y, z) =>
        !pierced.has(`${x},${y},${z}`) && this.getBlock(x, y, z),
        eye.x, eye.y, eye.z, direction.x, direction.y, direction.z, traceReach);
      if (!hit) break;
      length = hit.t;
      if (hit.y <= 0) break;
      const type = this.getBlock(hit.x, hit.y, hit.z);
      const exit = voxelExitDistance(event.o, direction, hit);
      const result = bulletMaterialImpact({ type, power, hp: BLOCK_HP[type],
        damage: damageAtDistance(WEAPONS.lance, hit.t) * damageScale,
        incidence: Math.abs(direction.x * hit.nx + direction.y * hit.ny + direction.z * hit.nz),
        thickness: exit - hit.t });
      if (result.action !== 'penetrate') break;
      power = result.power;
      damageScale *= result.damageScale;
      length = Math.max(length, exit + 20);
      pierced.add(`${hit.x},${hit.y},${hit.z}`);
    }
    const endpoint = event.resolvedEnd ? new THREE.Vector3(...event.resolvedEnd) : eye.clone().addScaledVector(direction, length);
    const beam = this.pool[this.cursor++ % POOL_SIZE];
    beam.group.position.copy(eye);
    if (local && this.muzzleProvider) this.muzzleProvider(beam.group.position);
    direction.copy(endpoint).sub(beam.group.position);
    beam.length = direction.length();
    beam.group.quaternion.setFromUnitVectors(AXIS, direction.normalize());
    beam.local = local;
    beam.age = 0;
    beam.life = 0.18 + charge * 0.3;
    beam.charge = charge;
    beam.hitRadius = profile.hitRadius;
    beam.coreRadius = profile.coreRadius;
    beam.group.visible = true;
    this._render(beam);
  }

  _render(beam) {
    const t = beam.age / beam.life;
    const fade = Math.pow(Math.max(0, 1 - t), 1.7);
    const width = 0.006 + 0.022 * beam.charge * beam.charge;
    beam.layers.forEach((mesh, i) => {
      const radius = (i === 2 ? beam.hitRadius : i === 1 ? beam.coreRadius : width) * (1 + t * 0.6);
      mesh.scale.set(radius, radius, beam.length);
      mesh.material.opacity = fade * [1, 0.4, 0.12][i];
    });
    beam.glows.forEach((sprite, i) => {
      sprite.position.z = i ? -beam.length + 0.08 : -0.1;
      sprite.scale.setScalar((i ? 1.7 : 0.65) * (0.2 + beam.charge) * (1 + t));
      sprite.material.opacity = fade * 0.85;
    });
    beam.rings.forEach((mesh, i) => {
      mesh.position.z = -Math.min(beam.length, 2.5 + (i + t * 2) * beam.length / 7);
      mesh.scale.setScalar(width * (4 + t * 18));
      mesh.material.opacity = fade * 0.35 * beam.charge;
      mesh.rotation.z = i + t * 3;
    });
  }

  update(dt) {
    for (const beam of this.pool) {
      if (!beam.group.visible) continue;
      beam.age += dt;
      beam.group.visible = beam.age < beam.life;
      if (beam.group.visible) this._render(beam);
    }
  }

  dispose() {
    for (const beam of this.pool) {
      this.scene.remove(beam.group);
      for (const mesh of [...beam.layers, ...beam.rings, ...beam.glows]) mesh.material.dispose();
    }
    this.glowTexture.dispose();
    this.geometry.dispose();
    this.ringGeometry.dispose();
  }
}
