import * as THREE from '../vendor/three.module.js';
import { VEHICLE_RULES } from '../../../shared/vehicles.js';
import { disposeVehicleFragment } from './vehicle-fragments.js';

export const VEHICLE_DEBRIS_CAPACITY = 128;
export const VEHICLE_EMBER_CAPACITY = 256;
export const VEHICLE_EVENT_CAPACITY = 128;
// Sixteen whole-fleet bursts fit before the oldest cosmetic pieces are recycled.
export const VEHICLE_FRAGMENT_CAPACITY = 1024;
export const VEHICLE_FRAGMENTS_PER_BURST = 64;
export const VEHICLE_LOW_FRAGMENTS_PER_BURST = 32;

// Reuse the combat fireball/smoke and fixed blast light pool. These values
// describe presentation only; the server owns the blast radius and damage.
export const VEHICLE_BLAST_STYLE = Object.freeze({
  color: 0xffbe66, grow: .48, life: .65, ring: true, ringColor: 0xff7c2e,
  flash: 3.2, flashLife: .14, ringPeak: .35,
  fire: Object.freeze({ count: 16, size: 2.8, speed: 7, life: .95, tint: Object.freeze([1, .9, .7]) }),
  smoke: Object.freeze({ count: 24, size: 2.3, speed: 3.6, life: 5, shade: .14 }),
  light: Object.freeze({ color: 0xff973c, range: 10, intensity: 24, life: .65 }),
  scorch: 4.5,
});

/**
 * Destruction choreography on top of the blast (presentation only): the
 * turret assembly (or rotor head) tossed skyward, 1-2 delayed cook-offs,
 * smoking chunks, a shockwave dust ring and a camera jolt. The 30-45 s wreck
 * column is snapshot-driven in VehicleFx so late joiners see it too.
 */
export const VEHICLE_DESTRUCTION_STYLE = Object.freeze({
  tossTags: Object.freeze(['turret', 'gun', 'barrel', 'rws', 'rotor', 'pintle']),
  tossSpeed: Object.freeze([11, 15]),
  cookoffDelay: Object.freeze([0.7, 2.4]),
  cookoffCount: Object.freeze({ jeep: 1, tank: 2, helicopter: 2, transport: 2, plane: 1 }),
  smokingFragments: 3,
  ringParticles: 26,
  cookoff: Object.freeze({
    color: 0xffa24a, grow: .3, life: .45, ring: false, flash: 2.2, flashLife: .1,
    fire: Object.freeze({ count: 8, size: 1.6, speed: 6, life: .6, tint: Object.freeze([1, .85, .6]) }),
    smoke: Object.freeze({ count: 8, size: 1.6, speed: 2.6, life: 3, shade: .16 }),
    light: Object.freeze({ color: 0xff8a3a, range: 7, intensity: 14, life: .4 }),
    scorch: 0,
  }),
});

const finite = value => Number.isFinite(value) ? value : 0;
const clamp = (value, limit) => Math.max(-limit, Math.min(limit, finite(value)));
const positionOf = value => Array.isArray(value) ? value : value && [value.x, value.y, value.z];
const particlePool = capacity => Array.from({ length: capacity }, () => ({
  active: false, age: 0, life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
  sx: 1, sy: 1, sz: 1, rx: 0, ry: 0, rz: 0, spinX: 0, spinY: 0, spinZ: 0,
  r: 1, g: 1, b: 1, resting: false,
}));

/** Authoritative destruction events make one burst; snapshots only re-arm it. */
export class VehicleDestructionFX {
  constructor(scene, { explosions, camera = null, getBlock = () => 0, getFragments = null, quality = 'high',
    fx = null, sfx = null, cameraShake = null } = {}) {
    this.root = new THREE.Group(); this.root.name = 'vehicle-destruction-fx'; scene.add(this.root);
    this.explosions = explosions;
    this.fx = fx; this.sfx = sfx; this.cameraShake = cameraShake;
    this.cookoffs = [];
    this.smokers = [];
    this._cookoffCount = 0;
    this.camera = camera; this.getBlock = getBlock;
    this.getFragments = getFragments;
    this.fragments = particlePool(VEHICLE_FRAGMENT_CAPACITY);
    this._fragmentCursor = 0; this.setQuality(quality);
    this.debris = particlePool(VEHICLE_DEBRIS_CAPACITY);
    this.embers = particlePool(VEHICLE_EMBER_CAPACITY);
    this.seen = new Map();
    this._debrisCursor = 0; this._emberCursor = 0; this._seed = 0x76e41c9;
    this._disposed = false; this._burstCount = 0;
    this._transform = new THREE.Object3D(); this._color = new THREE.Color();
    this._fragmentRotation = new THREE.Euler(); this._fragmentMatrix = new THREE.Matrix4();
    this.debrisGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.debrisMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: .3, roughness: .92 });
    this.emberGeometry = new THREE.OctahedronGeometry(1, 0);
    this.emberMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.debrisMesh = this._mesh(this.debrisGeometry, this.debrisMaterial, VEHICLE_DEBRIS_CAPACITY, 'vehicle-metal-debris');
    this.emberMesh = this._mesh(this.emberGeometry, this.emberMaterial, VEHICLE_EMBER_CAPACITY, 'vehicle-embers');
    this.emberMesh.renderOrder = 8;
  }

  _mesh(geometry, material, capacity, name) {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.name = name; mesh.count = 0; mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, this._color.setRGB(0, 0, 0));
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.root.add(mesh); return mesh;
  }

  _rand() {
    let value = (this._seed = (this._seed + 0x6d2b79f5) | 0);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  /** Both published events share a vehicle ID, so either arrival order works. */
  handleEvent(event) {
    if (this._disposed || !event || (event.kind !== 'vehicle_destroyed' &&
      !(event.kind === 'explosion' && event.type === 'vehicle'))) return false;
    if ((typeof event.vehicleId !== 'string' && typeof event.vehicleId !== 'number') ||
      (typeof event.vehicleId === 'number' && !Number.isFinite(event.vehicleId)) ||
      String(event.vehicleId).trim().length === 0 || !Object.hasOwn(VEHICLE_RULES, event.vehicleType)) return false;
    const pos = positionOf(event.pos);
    if (!pos || pos.length !== 3 || ![pos[0], pos[1], pos[2]].every(Number.isFinite)) return false;
    const id = String(event.vehicleId);
    if (this.seen.has(id)) return false;
    const pieces = this.getFragments?.(id, { maxPieces: this.partsPerBurst, event });
    // A newer authoritative life can invalidate an event still in the delayed
    // presentation queue. The view rejects it before any fireball is allocated.
    if (pieces === false) return false;
    if (this.seen.size >= VEHICLE_EVENT_CAPACITY) this.seen.delete(this.seen.keys().next().value);
    this.seen.set(id, { age: 0, wreckSeen: false });
    this._burstCount++;
    const rules = VEHICLE_RULES[event.vehicleType];
    const x = pos[0], y = pos[1] + (event.kind === 'vehicle_destroyed' ? rules.height * .5 : 0), z = pos[2];
    const suppliedRadius = event.blastRadius ?? event.r ?? event.radius;
    const radius = Number.isFinite(suppliedRadius) && suppliedRadius > 0 ? Math.min(24, suppliedRadius) : 6;
    this.explosions?.spawn(x, y, z, VEHICLE_BLAST_STYLE, radius, this.camera?.position);
    const velocity = positionOf(event.velocity);
    const vx = clamp(velocity?.[0], 45) * .35, vy = clamp(velocity?.[1], 35) * .35, vz = clamp(velocity?.[2], 45) * .35;
    this._spawnDebris(x, y, z, vx, vy, vz, event.vehicleType, radius);
    this._spawnFragments(pieces, x, y, z, vx, vy, vz, radius);
    this._spawnEmbers(x, y, z, vx, vy, vz, radius);
    this.sfx?.vehicleDestruction?.([x, y, z], event.vehicleType);
    this.cameraShake?.addExplosion?.([x, y, z], radius, this.camera);
    this._shockwave(x, y, z, radius);
    this._scheduleCookoffs(id, event.vehicleType, x, y, z, radius);
    // Write the new burst immediately; the shared blast pool uses its own clock.
    this._updateParticles(this.debris, this.debrisMesh, 0, false);
    this._updateParticles(this.embers, this.emberMesh, 0, true);
    return true;
  }

  _spawnDebris(x, y, z, inheritedX, inheritedY, inheritedZ, type, radius) {
    const count = type === 'jeep' ? 24 : 36;
    const size = Math.max(.8, Math.min(1.5, radius / 7));
    for (let i = 0; i < count; i++) {
      const particle = this.debris[this._debrisCursor];
      this._debrisCursor = (this._debrisCursor + 1) % this.debris.length;
      const heading = this._rand() * Math.PI * 2, speed = (3 + this._rand() * 7) * size;
      particle.active = true; particle.age = 0; particle.life = 4 + this._rand() * 2; particle.resting = false;
      particle.x = x + (this._rand() - .5) * 1.3; particle.y = y + (this._rand() - .5) * .6;
      particle.z = z + (this._rand() - .5) * 1.3;
      particle.vx = Math.cos(heading) * speed + inheritedX; particle.vy = 3 + this._rand() * 8 + inheritedY;
      particle.vz = Math.sin(heading) * speed + inheritedZ;
      particle.sx = (.12 + this._rand() * .37) * size;
      particle.sy = (.045 + this._rand() * .1) * size;
      particle.sz = (.14 + this._rand() * .45) * size;
      particle.rx = this._rand() * 6; particle.ry = this._rand() * 6; particle.rz = this._rand() * 6;
      particle.spinX = (this._rand() - .5) * 12; particle.spinY = (this._rand() - .5) * 12; particle.spinZ = (this._rand() - .5) * 12;
      const shade = .12 + this._rand() * .2;
      particle.r = shade * 1.12; particle.g = shade; particle.b = shade * .82;
    }
  }

  setQuality(quality) {
    this.partsPerBurst = quality === 'low' ? VEHICLE_LOW_FRAGMENTS_PER_BURST : VEHICLE_FRAGMENTS_PER_BURST;
  }

  _spawnFragments(pieces, x, y, z, inheritedX, inheritedY, inheritedZ, radius) {
    if (!Array.isArray(pieces)) return;
    const strength = Math.max(.8, Math.min(1.5, radius / 7));
    const style = VEHICLE_DESTRUCTION_STYLE;
    // The turret assembly (or rotor head) leaves as one: shared lift and drift.
    const tossHeading = this._rand() * Math.PI * 2;
    const toss = { vy: style.tossSpeed[0] + this._rand() * (style.tossSpeed[1] - style.tossSpeed[0]),
      vx: Math.cos(tossHeading) * (1.5 + this._rand() * 2.5), vz: Math.sin(tossHeading) * (1.5 + this._rand() * 2.5),
      spinX: (this._rand() - .5) * 1.6, spinY: (this._rand() - .5) * 2.4, spinZ: (this._rand() - .5) * 1.6 };
    let smoking = 0;
    const largest = new Set(pieces.filter(piece => piece?.object?.isObject3D)
      .sort((a, b) => finite(b.radius) - finite(a.radius)).slice(0, style.smokingFragments));
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      if (i >= this.partsPerBurst || !piece?.object?.isObject3D ||
        ![piece.object.position.x, piece.object.position.y, piece.object.position.z].every(Number.isFinite)) {
        disposeVehicleFragment(piece); continue;
      }
      const particle = this.fragments[this._fragmentCursor];
      this._fragmentCursor = (this._fragmentCursor + 1) % this.fragments.length;
      if (particle.fragment) disposeVehicleFragment(particle.fragment);
      const heading = this._rand() * Math.PI * 2;
      const offsetX = piece.object.position.x - x, offsetZ = piece.object.position.z - z;
      const distance = Math.hypot(offsetX, offsetZ), speed = (4 + this._rand() * 8) * strength;
      const outwardX = distance > .2 ? offsetX / distance : Math.cos(heading);
      const outwardZ = distance > .2 ? offsetZ / distance : Math.sin(heading);
      particle.fragment = piece; particle.active = true; particle.age = 0;
      particle.life = 7 + this._rand() * 4; particle.resting = false;
      particle.x = piece.object.position.x; particle.y = piece.object.position.y; particle.z = piece.object.position.z;
      particle.vx = outwardX * speed + inheritedX; particle.vy = 4 + this._rand() * 8 + inheritedY;
      particle.vz = outwardZ * speed + inheritedZ;
      particle.rx = particle.ry = particle.rz = 0;
      const spin = Math.max(.9, 4 / Math.max(.8, finite(piece.radius)));
      particle.spinX = (this._rand() - .5) * spin; particle.spinY = (this._rand() - .5) * spin;
      particle.spinZ = (this._rand() - .5) * spin;
      if (style.tossTags.includes(piece.name)) {
        particle.vx = toss.vx + inheritedX; particle.vy = toss.vy + inheritedY; particle.vz = toss.vz + inheritedZ;
        particle.spinX = toss.spinX; particle.spinY = toss.spinY; particle.spinZ = toss.spinZ;
        particle.tossed = true;
      } else particle.tossed = false;
      this.root.add(piece.object);
      if (this.fx && largest.has(piece) && smoking < style.smokingFragments) {
        smoking++;
        const handle = this.fx.addEmitter({ kind: 'smoke', pos: () => [particle.x, particle.y, particle.z], rate: 14,
          params: { speed: 0.5, scale: 0.7 } });
        if (handle) this.smokers.push({ handle, particle, piece });
      }
    }
  }

  /** A flat ring of dust racing out from the hull along the ground. */
  _shockwave(x, y, z, radius) {
    if (!this.fx) return;
    let ground = null;
    for (let dy = 0; dy < 6; dy++) if (this.getBlock(Math.floor(x), Math.floor(y) - dy, Math.floor(z))) { ground = Math.floor(y) - dy + 1; break; }
    if (ground == null) return;
    const count = VEHICLE_DESTRUCTION_STYLE.ringParticles;
    for (let i = 0; i < count; i++) {
      const a = i / count * Math.PI * 2;
      this.fx.emit('dust', [x, ground + .2, z], { count: 1, dir: [Math.cos(a), .06, Math.sin(a)], speed: 6 + radius * .6,
        spread: .1, scale: 1.6, ground });
    }
    this.fx.emit('smoke', [x, y, z], { count: 18, speed: 2.6, scale: 1.6 });
  }

  /** One or two secondary detonations as stored ammunition or fuel cooks off. */
  _scheduleCookoffs(id, type, x, y, z, radius) {
    const style = VEHICLE_DESTRUCTION_STYLE;
    const count = style.cookoffCount[type] ?? 1;
    for (let i = 0; i < count; i++) {
      const delay = style.cookoffDelay[0] + this._rand() * (style.cookoffDelay[1] - style.cookoffDelay[0]);
      const spread = radius * .18;
      this.cookoffs.push({ id, type, at: delay, age: 0,
        x: x + (this._rand() - .5) * spread, y: y + .4 + this._rand() * .6, z: z + (this._rand() - .5) * spread });
    }
  }

  _updateCookoffs(step) {
    for (let i = this.cookoffs.length - 1; i >= 0; i--) {
      const cookoff = this.cookoffs[i];
      cookoff.age += step;
      if (cookoff.age < cookoff.at) continue;
      this.cookoffs.splice(i, 1);
      // A respawned hull cancels pending cook-offs of its previous life.
      if (!this.seen.has(cookoff.id)) continue;
      const { x, y, z } = cookoff;
      this._cookoffCount++;
      this.explosions?.spawn(x, y, z, VEHICLE_DESTRUCTION_STYLE.cookoff, 2.6, this.camera?.position);
      this.fx?.emit('fire', [x, y, z], { count: 14, speed: 1.6, scale: 1.4 });
      this.fx?.emit('spark', [x, y, z], { count: 18, speed: 1.3 });
      this.fx?.emit('ember', [x, y, z], { count: 12 });
      this.fx?.emit('smoke', [x, y, z], { count: 8, speed: 1.4, scale: 1.2 });
      this.sfx?.vehicleDestruction?.([x, y, z], cookoff.type, { secondary: true });
      this.cameraShake?.addExplosion?.([x, y, z], 2.6, this.camera);
    }
  }

  _updateSmokers() {
    for (let i = this.smokers.length - 1; i >= 0; i--) {
      const smoker = this.smokers[i];
      if (smoker.particle.active && smoker.particle.fragment === smoker.piece) continue;
      this.fx?.removeEmitter(smoker.handle);
      this.smokers.splice(i, 1);
    }
  }

  _spawnEmbers(x, y, z, inheritedX, inheritedY, inheritedZ, radius) {
    const size = Math.max(.8, Math.min(1.5, radius / 7));
    for (let i = 0; i < 40; i++) {
      const particle = this.embers[this._emberCursor];
      this._emberCursor = (this._emberCursor + 1) % this.embers.length;
      const heading = this._rand() * Math.PI * 2, speed = (2 + this._rand() * 9) * size;
      particle.active = true; particle.age = 0; particle.life = 1.1 + this._rand() * 2.2; particle.resting = false;
      particle.x = x; particle.y = y; particle.z = z;
      particle.vx = Math.cos(heading) * speed + inheritedX; particle.vy = 3 + this._rand() * 10 + inheritedY;
      particle.vz = Math.sin(heading) * speed + inheritedZ;
      particle.sx = particle.sz = (.025 + this._rand() * .045) * size; particle.sy = particle.sx * (1 + this._rand());
      particle.rx = particle.ry = particle.rz = 0;
      particle.spinX = particle.spinY = particle.spinZ = 0;
      particle.r = 3.6; particle.g = .7 + this._rand() * 1.1; particle.b = .08;
    }
  }

  /** A late join's hp=0 row shows a wreck in VehicleView, without another boom. */
  sync(rows = []) {
    if (this._disposed || !Array.isArray(rows)) return;
    const present = new Set();
    for (const row of rows) {
      if (row?.id == null) continue;
      const id = String(row.id); present.add(id);
      const seen = this.seen.get(id); if (!seen) continue;
      if (row.wreck || (Number.isFinite(row.hp) && row.hp <= 0)) seen.wreckSeen = true;
      else if (Number.isFinite(row.hp) && row.hp > 0 && (seen.wreckSeen || seen.age >= 1)) this.seen.delete(id);
    }
    for (const [id, seen] of this.seen) if (!present.has(id) && seen.age >= 1) this.seen.delete(id);
  }

  update(dt = 0) {
    if (this._disposed) return;
    const step = Math.max(0, Math.min(.1, finite(dt)));
    for (const [id, seen] of this.seen) {
      seen.age += step;
      if (seen.age >= 120) this.seen.delete(id);
    }
    this._updateParticles(this.debris, this.debrisMesh, step, false);
    this._updateParticles(this.embers, this.emberMesh, step, true);
    this._updateFragments(step);
    this._updateCookoffs(step);
    this._updateSmokers();
  }

  _updateFragments(step) {
    for (const particle of this.fragments) {
      if (!particle.active) continue;
      particle.age += step;
      if (particle.age >= particle.life) {
        particle.active = false; disposeVehicleFragment(particle.fragment); particle.fragment = null; continue;
      }
      if (!particle.resting && step > 0) {
        const drag = Math.exp(-step * .35); particle.vx *= drag; particle.vz *= drag;
        particle.vy -= step * 18;
        const rx = particle.rx + particle.spinX * step, ry = particle.ry + particle.spinY * step, rz = particle.rz + particle.spinZ * step;
        const bounds = particle.fragment.geometry.boundingBox;
        const rotation = this._fragmentMatrix.makeRotationFromEuler(this._fragmentRotation.set(rx, ry, rz)).elements;
        const bottom = rotation[1] * (rotation[1] >= 0 ? bounds.min.x : bounds.max.x) +
          rotation[5] * (rotation[5] >= 0 ? bounds.min.y : bounds.max.y) +
          rotation[9] * (rotation[9] >= 0 ? bounds.min.z : bounds.max.z);
        const dx = particle.vx * step, dy = particle.vy * step, dz = particle.vz * step;
        const samples = Math.max(1, Math.min(32, Math.ceil(Math.hypot(dx, dy, dz) / .35)));
        let contact = false, ground = 0;
        for (let i = 1; i <= samples; i++) {
          const t = i / samples, x = particle.x + dx * t, y = particle.y + dy * t, z = particle.z + dz * t;
          const columnX = Math.floor(x), columnZ = Math.floor(z), foot = Math.floor(y + bottom);
          if (!this.getBlock(columnX, foot, columnZ)) continue;
          contact = true; ground = foot + 1;
          // A tumbling wing can reach several voxels below its centre. Recover
          // the column's real top before freezing its posed support extent.
          for (let rise = 0; rise < 32 && this.getBlock(columnX, ground, columnZ); rise++) ground++;
          break;
        }
        if (contact) {
          particle.y = ground - bottom + .015;
          particle.vx *= .3; particle.vz *= .3; particle.vy = Math.abs(particle.vy) * .17;
          particle.spinX *= .4; particle.spinY *= .4; particle.spinZ *= .4;
          if (particle.vy < 1) { particle.resting = true; particle.spinX = particle.spinY = particle.spinZ = 0; }
        } else { particle.x += dx; particle.y += dy; particle.z += dz; }
        particle.rx = rx; particle.ry = ry; particle.rz = rz;
      }
      const object = particle.fragment.object;
      object.position.set(particle.x, particle.y, particle.z); object.rotation.set(particle.rx, particle.ry, particle.rz);
      object.scale.setScalar(Math.min(1, Math.max(0, (particle.life - particle.age) / 1.2)));
    }
  }

  _updateParticles(pool, mesh, step, ember) {
    let count = 0;
    const transform = this._transform;
    for (const particle of pool) {
      if (!particle.active) continue;
      particle.age += step;
      if (particle.age >= particle.life) { particle.active = false; continue; }
      if (!particle.resting && step > 0) {
        const drag = Math.exp(-step * (ember ? .9 : .3));
        particle.vx *= drag; particle.vz *= drag;
        particle.vy -= step * (ember ? 5 : 18);
        const x = particle.x + particle.vx * step, y = particle.y + particle.vy * step, z = particle.z + particle.vz * step;
        if (!ember && this.getBlock(Math.floor(x), Math.floor(y - particle.sy * .5), Math.floor(z))) {
          // Cosmetic contact with the local terrain only. Settled fragments expire.
          particle.vx *= .35; particle.vz *= .35; particle.vy = Math.abs(particle.vy) * .2;
          if (particle.vy < .8) { particle.resting = true; particle.spinX = particle.spinY = particle.spinZ = 0; }
        } else { particle.x = x; particle.y = y; particle.z = z; }
        particle.rx += particle.spinX * step; particle.ry += particle.spinY * step; particle.rz += particle.spinZ * step;
      }
      const fade = Math.min(1, Math.max(0, (particle.life - particle.age) / (ember ? .65 : .8)));
      transform.position.set(particle.x, particle.y, particle.z);
      transform.rotation.set(particle.rx, particle.ry, particle.rz);
      transform.scale.set(particle.sx * fade, particle.sy * fade, particle.sz * fade);
      transform.updateMatrix(); mesh.setMatrixAt(count, transform.matrix);
      const glow = ember ? fade * Math.max(.1, 1 - particle.age / particle.life) : 1;
      mesh.setColorAt(count++, this._color.setRGB(particle.r * glow, particle.g * glow, particle.b * glow));
    }
    mesh.count = count;
    if (count) { mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true; }
  }

  clear() {
    for (const particle of this.debris) particle.active = false;
    for (const particle of this.embers) particle.active = false;
    for (const particle of this.fragments) {
      particle.active = false; disposeVehicleFragment(particle.fragment); particle.fragment = null;
    }
    this.debrisMesh.count = this.emberMesh.count = 0;
    for (const smoker of this.smokers) this.fx?.removeEmitter(smoker.handle);
    this.smokers.length = 0;
    this.cookoffs.length = 0;
    this.seen.clear(); this._debrisCursor = this._emberCursor = this._fragmentCursor = 0;
  }

  get stats() {
    return Object.freeze({ bursts: this._burstCount, debris: this.debrisMesh.count,
      embers: this.emberMesh.count, remembered: this.seen.size,
      debrisCapacity: VEHICLE_DEBRIS_CAPACITY, emberCapacity: VEHICLE_EMBER_CAPACITY,
      fragments: this.fragments.filter(particle => particle.active).length,
      tossed: this.fragments.filter(particle => particle.active && particle.tossed).length,
      cookoffs: this._cookoffCount, pendingCookoffs: this.cookoffs.length, smoking: this.smokers.length,
      fragmentCapacity: VEHICLE_FRAGMENT_CAPACITY, fragmentsPerBurst: this.partsPerBurst });
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true; this.clear();
    this.debrisMesh.dispose(); this.emberMesh.dispose();
    this.debrisGeometry.dispose(); this.emberGeometry.dispose();
    this.debrisMaterial.dispose(); this.emberMaterial.dispose();
    this.root.removeFromParent();
    this.explosions = null; this.camera = null;
    this.getFragments = null; this.fx = null; this.sfx = null; this.cameraShake = null;
  }
}
