// Conquest vehicle effects. Every combat effect is a reaction to an
// authoritative server event (shoot with vehicleId, projectileLaunch and
// projectileExplode of vehicle weapons, vehicle_hit, vehicle_disabled,
// vehicle_repaired, countermeasure) or to a snapshot field (hp, st, speed,
// tracks, rotor, throttle, altitude): nothing here decides gameplay.
//
// Draws: the shared ParticleField (2), ground track/tyre decals (1), hull
// scorch marks (1) and the nav/head/tail light sprites (1). One of the two
// muzzle point lights is borrowed for a tank main-gun flash.
import * as THREE from '../vendor/three.module.js';
import { vehicleWeaponMeta, vehicleStatus } from '../../../shared/conquest-contract.js';
import { VEHICLE_WEAPONS, vehicleDef, vehicleMaxHp } from '../../../shared/vehicle-defs.js';
import { vehicleOccupiedSeats } from '../../../shared/vehicle-seats.js';
import { AIR, FLUID_BLOCKS } from '../../../shared/worlddata.js';
import { TILE_PAINTERS, TILE_PX, faceTile } from '../engine/atlas.js';
import { DUST_TINTS } from '../fx/presets.js';
import { canonicalMountKey, isAircraftType, rowMaxHp } from './voxel-model/anchors.js';
import { ParachuteFx } from './parachute-fx.js';
import { TITAN_WEAPON_META } from '../../../shared/titan-contract.js';

/** Presentation tuning (no gameplay values). */
export const VEHICLE_FX = Object.freeze({
  decalCapacity: 2048, decalFadeSeconds: 30, trackStamp: 0.42,
  hullMarkCapacity: 256, hullMarkSeconds: 60,
  lightCapacity: 256,
  // Tank shell pass-by cue: closest approach within this radius (m) and flight time (s).
  shellPassRadius: 14, shellPassSeconds: 3,
  // Falling bomb: listeners within this radius (m) of its predicted impact hear the whistle.
  bombWhistleRadius: 45,
  rotorWashAgl: 14, contrailAgl: 120, vortexG: 3.2,
  damageSmokeBelow: 0.5, wreckColumn: [30, 45], wreckFireSeconds: 14,
  flashSeconds: 0.09,
  cannonShake: 0.35, cannonShakeNear: 0.18, hitShakePerFraction: 2.2,
  dustSpeed: 2.2, exhaustIdle: 6, exhaustMoving: 22,
  maxMissileTrails: 24,
});

/** Tracer looks per hitscan mount weapon (TracerFX definition shape). */
const TRACERS = Object.freeze({
  coaxMG: Object.freeze({ tracer: Object.freeze({ len: 26, width: 1.3, color: '#ff9a4a' }) }),
  hmg: Object.freeze({ tracer: Object.freeze({ len: 34, width: 1.8, color: '#ff8a3a' }) }),
  doorMinigun: Object.freeze({ tracer: Object.freeze({ len: 30, width: 1.5, color: '#ffb05a' }) }),
  planeCannon: Object.freeze({ tracer: Object.freeze({ len: 42, width: 2.1, color: '#ffd27a' }) }),
  // Titanfall (docs/titanfall.md §7.3): splitter bolts, the railgun beam, predator rounds.
  splitter: Object.freeze({ tracer: Object.freeze({ len: 30, width: 2.4, color: '#6fd2ff' }) }),
  railgun: Object.freeze({ tracer: Object.freeze({ len: 120, width: 4.2, color: '#9fe8ff' }) }),
  predatorClose: Object.freeze({ tracer: Object.freeze({ len: 28, width: 1.9, color: '#ffbf5a' }) }),
  predatorLong: Object.freeze({ tracer: Object.freeze({ len: 40, width: 2.3, color: '#ffd77a' }) }),
});
/** Muzzle flash scale per vehicle weapon. */
const MUZZLE_SCALE = Object.freeze({
  tankAP: 2.4, tankHE: 2.4, coaxMG: 0.55, hmg: 0.75, helicopterRocket: 1.1, chinCannon: 0.9,
  doorMinigun: 0.6, planeCannon: 0.85, aaMissile: 1.2, jetBomb: 0,
  splitter: 1.1, t203: 1.6, railgun: 2.2, leadwall: 2.0, predatorClose: 1.0, predatorLong: 1.1, titanMelee: 0,
});
/** Energy and fire tints of the titan muzzles, impacts and light flashes (linear RGB, HDR). */
const ION_TINT = Object.freeze({ muzzle0: [1.4, 3.4, 5.4], muzzle1: [0.3, 1.1, 3.2], spark0: [0.9, 2.2, 3.6], spark1: [0.25, 0.8, 2.2], light: [0.45, 0.85, 1] });
const RAIL_TINT = Object.freeze({ muzzle0: [3.4, 4.6, 5.6], muzzle1: [0.8, 2.2, 3.8], spark0: [1.6, 3, 4.2], spark1: [0.4, 1.2, 2.6], light: [0.6, 0.9, 1] });
const BRASS = Object.freeze([0.95, 0.68, 0.3]);
/**
 * Titan primary shots (visual only; the shake, FOV punch and cockpit kick are titan-weapon-feel.js, the
 * audio VehicleAudio.titanShot, both via titan-presentation.js): arm kick (VehicleView recoil travel,
 * × 0.6 m), light flash (strength, tint), muzzle particle count, impact burst size. `shake` is only
 * used by the ability shots that borrow a primary's look (Laser Shot, Power Shot, Vortex throw-back).
 */
const TITAN_SHOT_LOOK = Object.freeze({
  splitter: Object.freeze({ kick: 0.3, shake: 0.025, flash: 0.35, tint: ION_TINT, muzzles: 1, impact: 1 }),
  t203: Object.freeze({ kick: 0.75, shake: 0.08, flash: 0.9, muzzles: 3, impact: 0 }),
  // Railgun: kick, flash and impact grow with the shot's charge (event.charge) from `min`.
  railgun: Object.freeze({ kick: 1, shake: 0.14, flash: 1.3, tint: RAIL_TINT, muzzles: 4, impact: 2.6, min: 0.35 }),
  leadwall: Object.freeze({ kick: 0.8, shake: 0.1, flash: 1, muzzles: 4, impact: 0 }),
  predatorClose: Object.freeze({ kick: 0.18, shake: 0.012, flash: 0.28, muzzles: 1, impact: 0.8, casings: 1 }),
  predatorLong: Object.freeze({ kick: 0.22, shake: 0.018, flash: 0.32, muzzles: 1, impact: 0.9, casings: 1 }),
  titanMelee: Object.freeze({ kick: 0, shake: 0, flash: 0 }),
});
const LIGHT_LOOK = Object.freeze({
  head: Object.freeze({ color: [2.4, 2.2, 1.8], size: 0.55 }),
  tail: Object.freeze({ color: [2.6, 0.25, 0.15], size: 0.32 }),
  navRed: Object.freeze({ color: [3.2, 0.3, 0.2], size: 0.42 }),
  navGreen: Object.freeze({ color: [0.3, 3.2, 0.6], size: 0.42 }),
  strobe: Object.freeze({ color: [4, 4, 4], size: 0.75 }),
  // Titan battery cell (titan-common.js): a slow green pulse, dark once the battery is ripped.
  battery: Object.freeze({ color: [0.45, 3.1, 1.1], size: 0.42 }),
  // Titan flood and tail lenses (titan-common.js TITAN_LIGHT_KINDS): a small warm glint, no glare ball.
  titanLamp: Object.freeze({ color: [1.4, 0.9, 0.4], size: 0.18 }),
  titanTail: Object.freeze({ color: [1.6, 0.18, 0.1], size: 0.14 }),
});

const finite = value => Number.isFinite(value) ? value : 0;
const vec = value => Array.isArray(value) ? value : value && Number.isFinite(value.x) ? [value.x, value.y, value.z] : null;
const hashId = id => { let h = 2166136261; for (const c of String(id)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296; };

// --- block tint ---------------------------------------------------------------
const tintCache = new Map();
/** Dust colour (linear RGB) for a ground block: its top tile, lightened toward dust. */
export function blockDustTint(blockId) {
  if (!blockId) return DUST_TINTS.dirt;
  let tint = tintCache.get(blockId);
  if (tint) return tint;
  try {
    const painter = TILE_PAINTERS[faceTile(blockId, 2)];
    const color = new THREE.Color(), sum = [0, 0, 0];
    let weight = 0;
    for (let z = 0; z < TILE_PX; z += 2) for (let x = 0; x < TILE_PX; x += 2) {
      const rgba = painter(x, z), alpha = rgba[3] / 255;
      color.setRGB(rgba[0] / 255, rgba[1] / 255, rgba[2] / 255, THREE.SRGBColorSpace);
      sum[0] += color.r * alpha; sum[1] += color.g * alpha; sum[2] += color.b * alpha; weight += alpha;
    }
    const base = sum.map(value => value / (weight || 1));
    // Kicked-up dust is paler and less saturated than the surface it comes from.
    const grey = (base[0] + base[1] + base[2]) / 3;
    tint = Object.freeze(base.map(value => Math.min(1, (value * 0.55 + grey * 0.45) * 1.25 + 0.06)));
    if (!tint.every(Number.isFinite)) tint = DUST_TINTS.dirt;
  } catch {
    tint = DUST_TINTS.dirt;
  }
  tintCache.set(blockId, tint);
  return tint;
}

// --- instanced quads with GPU fade ----------------------------------------------
const DECAL_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
uniform float uTime;
uniform float uFade;
attribute float aBirth;
attribute vec4 aTint;
varying float vAlpha;
varying vec3 vTint;
varying vec2 vUv;
void main() {
  float age = uTime - aBirth;
  vAlpha = aTint.a * ( 1.0 - smoothstep( uFade * 0.55, uFade, age ) ) * step( 0.0, age );
  vTint = aTint.rgb;
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;
const DECAL_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
varying float vAlpha;
varying vec3 vTint;
varying vec2 vUv;
void main() {
  vec2 d = abs( vUv - 0.5 ) * 2.0;
  float edge = 1.0 - smoothstep( 0.6, 1.0, max( d.x * 0.9, d.y ) );
  float tread = 0.75 + 0.25 * step( 0.5, fract( vUv.y * 4.0 ) );
  float alpha = vAlpha * edge * tread;
  if ( alpha < 0.004 ) discard;
  gl_FragColor = vec4( vTint, alpha );
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Ring buffer of flat quads (track/tyre marks on the ground, scorch marks on hulls). */
export class DecalLayer {
  constructor(scene, { capacity, fade, name }) {
    this.capacity = capacity;
    this.cursor = 0;
    this.time = 0;
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    this.birth = new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(-1e9), 1);
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.birth.setUsage(THREE.DynamicDrawUsage);
    this.tint.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aBirth', this.birth);
    geometry.setAttribute('aTint', this.tint);
    this.material = new THREE.ShaderMaterial({
      name, uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uTime: { value: 0 }, uFade: { value: fade } },
      vertexShader: DECAL_VERTEX, fragmentShader: DECAL_FRAGMENT,
      transparent: true, depthWrite: false, fog: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.slots = new Array(capacity).fill(null);
    scene?.add(this.mesh);
    this._matrix = new THREE.Matrix4();
    this._dirtyMin = Infinity;
    this._dirtyMax = -1;
  }

  /** Mark one slot for upload; flush() sends only the touched range. */
  touch(slot) {
    if (slot < this._dirtyMin) this._dirtyMin = slot;
    if (slot > this._dirtyMax) this._dirtyMax = slot;
  }

  /** Write one quad; `matrix` places the unit XZ quad. Returns its slot. */
  add(matrix, tint, alpha, meta = null) {
    const slot = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.mesh.setMatrixAt(slot, matrix);
    this.birth.array[slot] = this.time;
    this.tint.array[slot * 4] = tint[0]; this.tint.array[slot * 4 + 1] = tint[1];
    this.tint.array[slot * 4 + 2] = tint[2]; this.tint.array[slot * 4 + 3] = alpha;
    this.slots[slot] = meta;
    this.mesh.count = Math.max(this.mesh.count, slot + 1);
    this.touch(slot);
    return slot;
  }

  kill(slot) { this.birth.array[slot] = -1e9; this.slots[slot] = null; this.touch(slot); }

  /**
   * Upload the slots written since the last flush (one range per buffer),
   * instead of the whole 2048-quad ring every time a mark is stamped.
   */
  flush() {
    if (this._dirtyMax < 0) return false;
    const start = this._dirtyMin, count = this._dirtyMax - this._dirtyMin + 1;
    for (const [attribute, stride] of [[this.mesh.instanceMatrix, 16], [this.birth, 1], [this.tint, 4]]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(start * stride, count * stride);
      attribute.needsUpdate = true;
    }
    this._dirtyMin = Infinity;
    this._dirtyMax = -1;
    return true;
  }

  update(dt) {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
  }

  get live() {
    let count = 0;
    const fade = this.material.uniforms.uFade.value;
    for (let i = 0; i < this.mesh.count; i++) if (this.time - this.birth.array[i] < fade) count++;
    return count;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose?.();
  }
}

const SPRITE_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aGlow;  // rgb HDR, size
varying vec3 vGlow;
varying vec2 vUv;
void main() {
  vec4 center = modelViewMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
  vec4 mvPosition = center;
  mvPosition.xy += position.xy * aGlow.w;
  vGlow = aGlow.rgb;
  vUv = uv;
  gl_Position = projectionMatrix * mvPosition;
  if ( aGlow.w <= 0.0 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
  #include <fog_vertex>
}
`;
const SPRITE_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
varying vec3 vGlow;
varying vec2 vUv;
void main() {
  float r = length( vUv - 0.5 ) * 2.0;
  float glow = exp( - r * r * 6.0 ) + 0.35 * exp( - r * 18.0 );
  if ( glow < 0.01 ) discard;
  gl_FragColor = vec4( vGlow * glow, 1.0 );
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    gl_FragColor.rgb *= 1.0 - fogFactor * 0.85;
  #endif
}
`;

/** Camera-facing additive glows for nav, strobe, head and tail lights (> 1.0 HDR). */
export class LightSprites {
  constructor(scene, capacity) {
    this.capacity = capacity;
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.glow = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.glow.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aGlow', this.glow);
    this.material = new THREE.ShaderMaterial({
      name: 'vehicle-light-sprites', uniforms: THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      vertexShader: SPRITE_VERTEX, fragmentShader: SPRITE_FRAGMENT,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true, toneMapped: false,
    });
    this.mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    this.mesh.name = 'vehicle-light-sprites';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this._matrix = new THREE.Matrix4();
    this.count = 0;
    scene?.add(this.mesh);
  }

  begin() { this.count = 0; }

  push(position, color, size) {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    this._matrix.makeTranslation(position.x, position.y, position.z);
    this.mesh.setMatrixAt(i, this._matrix);
    this.glow.array[i * 4] = color[0]; this.glow.array[i * 4 + 1] = color[1];
    this.glow.array[i * 4 + 2] = color[2]; this.glow.array[i * 4 + 3] = size;
  }

  end() {
    this.mesh.count = this.count;
    if (this.count) { this.mesh.instanceMatrix.needsUpdate = true; this.glow.needsUpdate = true; }
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose?.();
  }
}

/**
 * VehicleFx: the vehicle effects layer.
 * options: { fx: ParticleField, vehicleView, sfx, cameraShake, getBlock,
 *            tracers (TracerFX, optional), muzzleLights (MuzzleLights, optional),
 *            scene (for decals and sprites; defaults to the particle field's parent) }
 */
export class VehicleFx {
  constructor({ fx, vehicleView, sfx = null, cameraShake = null, getBlock = null, tracers = null, muzzleLights = null, scene = null } = {}) {
    this.fx = fx;
    this.view = vehicleView;
    this.sfx = sfx;
    this.shake = cameraShake;
    this.getBlock = typeof getBlock === 'function' ? getBlock : () => AIR;
    this.tracers = tracers;
    this.muzzleLights = muzzleLights;
    const root = scene || fx?.group?.parent || null;
    this.group = new THREE.Group();
    this.group.name = 'vehicle-fx';
    root?.add(this.group);
    this.decals = new DecalLayer(this.group, { capacity: VEHICLE_FX.decalCapacity, fade: VEHICLE_FX.decalFadeSeconds, name: 'vehicle-track-decals' });
    this.hullMarks = new DecalLayer(this.group, { capacity: VEHICLE_FX.hullMarkCapacity, fade: VEHICLE_FX.hullMarkSeconds, name: 'vehicle-hull-marks' });
    this.sprites = new LightSprites(this.group, VEHICLE_FX.lightCapacity);
    // Canopies, ejection seats and the jet's canopy glass (synced per frame from the player rows).
    this.parachutes = new ParachuteFx({ group: this.group, fx, cameraShake, sfx });
    this.state = new Map();       // vehicleId -> per-hull FX state
    this.missiles = new Map();    // projectile id -> trail
    this.flash = null;            // borrowed muzzle light
    this.camera = null;
    this.selfId = null;
    this.time = 0;
    this.counts = Object.create(null);
    this._v = new THREE.Vector3(); this._w = new THREE.Vector3(); this._q = new THREE.Quaternion();
    this._m = new THREE.Matrix4(); this._s = new THREE.Vector3();
    this._disposed = false;
  }

  _count(kind) { this.counts[kind] = (this.counts[kind] || 0) + 1; }

  /** Top solid block at or below y within `depth`: { y (surface), block, fluid } or null. */
  ground(x, y, z, depth = 16) {
    const bx = Math.floor(x), bz = Math.floor(z);
    let by = Math.floor(y);
    for (let i = 0; i <= depth; i++, by--) {
      const block = this.getBlock(bx, by, bz);
      if (block && block !== AIR) return { y: by + 1, block, fluid: FLUID_BLOCKS.has(block) };
    }
    return null;
  }

  _rowIsSelf(row) {
    if (this.selfId == null || !row) return false;
    return vehicleOccupiedSeats(row).some(seat => seat.occupantId === this.selfId);
  }

  _distanceToCamera(pos) {
    const eye = this.camera?.position;
    return eye && pos ? Math.hypot(pos[0] - eye.x, pos[1] - eye.y, pos[2] - eye.z) : Infinity;
  }

  /** Authoritative events. Returns true when the event produced vehicle FX. */
  handleEvent(ev, selfId = this.selfId) {
    if (this._disposed || !ev || typeof ev.kind !== 'string') return false;
    if (selfId != null) this.selfId = String(selfId);
    switch (ev.kind) {
      case 'shoot': return ev.vehicleId != null ? this._shoot(ev) : false;
      case 'projectileLaunch': return typeof ev.vehicleWeapon === 'string' ? this._launch(ev) : false;
      case 'projectileExplode': return this._explode(ev);
      case 'vehicle_hit': return this._hit(ev);
      case 'vehicle_disabled': return this._disabled(ev);
      case 'vehicle_repaired': return this._repaired(ev);
      case 'countermeasure': return this._countermeasure(ev);
      case 'ejection': this._count('ejection'); return this.parachutes.eject(ev, this.selfId);
      default: return false;
    }
  }

  _shoot(ev) {
    const weapon = ev.vehicleWeapon, meta = vehicleWeaponMeta(weapon);
    if (!meta) return false;
    const item = this.view?.item(ev.vehicleId);
    const self = item ? this._rowIsSelf(item.row) : String(ev.id) === this.selfId;
    const pose = item ? this.view.mountWorldPose(ev.vehicleId, ev.mount, { side: finite(ev.side) }) : null;
    const origin = pose?.origin ?? vec(ev.o);
    const dir = pose?.dir ?? vec(ev.d);
    if (!origin || !origin.every(Number.isFinite)) return false;
    this._count('shoot');
    if (Object.hasOwn(TITAN_WEAPON_META, weapon)) return this._titanShot(ev, weapon, meta, item, self, origin, dir);
    if (meta.kind === 'bomb') {
      // A bomb leaves the pylon with no flash: the release clunk and a small jolt.
      this.sfx?.vehicleBombRelease?.(origin, { self });
      if (self) this.shake?.add(0.04);
      return true;
    }
    const scale = MUZZLE_SCALE[weapon] ?? 0.8;
    const inherit = item?.row && isAircraftType(item.kind) ? [finite(item.row.vx), finite(item.row.vy), finite(item.row.vz)] : null;
    this.fx?.emit('muzzle', origin, { count: weapon.startsWith('tank') ? 3 : 1, dir, scale, near: false, velocity: inherit });
    if (weapon === 'tankAP' || weapon === 'tankHE') {
      // Main gun: flash, smoke ring and the muzzle-brake side jets, a ground
      // dust cone under the barrel, recoil and hull rock, the light flash.
      this.fx?.emit('smoke', origin, { count: 14, dir, speed: 3.2, scale: 1.1, spread: 0.9 });
      const side = [dir[2], 0, -dir[0]];
      this.fx?.emit('smoke', origin, { count: 6, dir: side, speed: 4, scale: 0.7, spread: 0.3 });
      this.fx?.emit('smoke', origin, { count: 6, dir: [-side[0], 0, -side[2]], speed: 4, scale: 0.7, spread: 0.3 });
      this.fx?.emit('spark', origin, { count: 10, dir, speed: 1.4, spread: 0.35 });
      const below = this.ground(origin[0] + dir[0] * 3, origin[1], origin[2] + dir[2] * 3, 4);
      if (below && !below.fluid) {
        this.fx?.emit('dust', [origin[0] + dir[0] * 3, below.y + 0.1, origin[2] + dir[2] * 3],
          { count: 22, dir: [dir[0], 0.35, dir[2]], speed: 2.4, scale: 1.4, spread: 1.2, color0: blockDustTint(below.block), color1: blockDustTint(below.block), ground: below.y });
        // Muzzle overpressure: a flat dust ring racing out under the barrel.
        if (origin[1] - below.y < 3.5) this._ring([origin[0] + dir[0] * 2, 0, origin[2] + dir[2] * 2], below.y, 14, 6.5, blockDustTint(below.block));
      } else if (below?.fluid) {
        this.fx?.emit('water', [origin[0] + dir[0] * 3, below.y, origin[2] + dir[2] * 3], { count: 16, dir: [0, 1, 0], speed: 1.2, ground: below.y - 0.1 });
      }
      this.view?.kick(ev.vehicleId, ev.mount, 1);
      this._flashLight(origin, 1);
      const distance = self ? 0 : this._distanceToCamera(origin);
      if (self) this.shake?.add(VEHICLE_FX.cannonShake);
      else if (distance < 40) this.shake?.add(VEHICLE_FX.cannonShakeNear * (1 - distance / 40));
      this.sfx?.vehicleCannon?.(origin, { self, weapon });
      return true;
    }
    if (meta.kind === 'hitscan') {
      const segment = Array.isArray(ev.paths?.[0]) ? ev.paths[0][0] : null;
      const end = vec(segment?.end);
      if (ev.tracer) this._tracer(origin, dir, end, weapon);
      if (segment?.hit) this._impact(segment.hit, end);
      const index = item ? this._mountIndex(item, ev.mount) : -1;
      const heat = index >= 0 && Array.isArray(item.row?.mounts?.[index]) ? finite(item.row.mounts[index][3]) / 100 : 0;
      this.sfx?.vehicleGun?.(`${ev.vehicleId}:${ev.mount}`, origin, weapon, { heat, self });
      if (self && weapon === 'planeCannon') this.shake?.add(0.03);
      return true;
    }
    if (weapon === 'chinCannon') {
      this.fx?.emit('smoke', origin, { count: 2, dir, speed: 1.5, scale: 0.4 });
      this.sfx?.vehicleAutocannon?.(origin, { self });
      if (self) this.shake?.add(0.04);
      return true;
    }
    // Rocket pods and missiles: launch puff (the trail follows projectileLaunch).
    this.fx?.emit('smoke', origin, { count: weapon === 'aaMissile' ? 10 : 5, dir: [-dir[0], -dir[1], -dir[2]], speed: 2, scale: 0.6, velocity: inherit });
    this.sfx?.vehicleMissileLaunch?.(origin, { self, kind: weapon === 'aaMissile' ? 'aa' : 'pod' });
    if (self) this.shake?.add(weapon === 'aaMissile' ? 0.08 : 0.05);
    return true;
  }

  /**
   * Titan mount shots: splitter bolts (a tracer on every bolt, one per split path) with ion sparks,
   * the railgun crack (tracer, ionised wake, a flash and impact scaled by the event's charge; the
   * beam itself is titan-ability-events.js), Predator rounds with brass, the Leadwall / T-203 muzzle
   * blast (ProjectileFX draws the pellets and the thermite shell through titan-projectile-views.js).
   */
  _titanShot(ev, weapon, meta, item, self, origin, dir) {
    const look = TITAN_SHOT_LOOK[weapon];
    if (weapon === 'titanMelee') return true;
    // Hitscan abilities (Laser Shot, Power Shot, Vortex throw-back) leave from their anchor
    // (`ev.o`); titan-ability-events.js draws their rays, so only the impacts and the light stay.
    if (ev.ability) return this._titanAbilityShot(ev, look, self);
    const charge = weapon === 'railgun' ? look.min + (1 - look.min) * Math.max(0, Math.min(1, Number.isFinite(ev.charge) ? ev.charge : 1)) : 1;
    const tint = look?.tint ?? null, scale = (MUZZLE_SCALE[weapon] ?? 1) * (weapon === 'railgun' ? 0.6 + 0.4 * charge : 1);
    this.fx?.emit('muzzle', origin, { count: look?.muzzles ?? 1, dir, scale, near: false, spread: weapon === 'leadwall' ? 0.45 : 0.2,
      ...(tint ? { color0: tint.muzzle0, color1: tint.muzzle1 } : {}) });
    if (meta.kind === 'hitscan') {
      const paths = Array.isArray(ev.paths) && ev.paths.length ? ev.paths : [null];
      const range = VEHICLE_WEAPONS[weapon]?.range ?? 300;
      for (const path of paths) {
        const segment = Array.isArray(path) ? path[0] : null;
        const end = vec(segment?.end);
        let d = dir, length = range;
        if (end && end.every(Number.isFinite)) {
          const dx = end[0] - origin[0], dy = end[1] - origin[1], dz = end[2] - origin[2];
          length = Math.hypot(dx, dy, dz);
          if (length > 0.5) d = [dx / length, dy / length, dz / length];
        }
        // Every ION bolt and every rail shot draws; the Predator keeps the server's tracer cadence.
        if (ev.tracer !== false || weapon === 'railgun' || weapon === 'splitter') this._tracer(origin, d, end, weapon);
        if (segment?.hit) this._impact(segment.hit, end);
        // A round that stopped short of its range met a voxel, a hull or a pilot: the weapon's own burst there.
        if (end && (segment?.hit || length < range - 0.5)) this._titanImpact(weapon, end, d, look.impact * charge, !!segment?.hit);
        if (weapon === 'railgun') this._railWake(origin, d, end, charge);
      }
      if (weapon === 'splitter') this.fx?.emit('spark', origin, { count: paths.length > 1 ? 7 : 4, dir, speed: 2.4, spread: 0.45, color0: tint.spark0, color1: tint.spark1 });
      if (weapon === 'railgun') {
        this.fx?.emit('spark', origin, { count: Math.round(10 + 14 * charge), dir, speed: 3, spread: 0.6, color0: tint.spark0, color1: tint.spark1 });
        this.fx?.emit('smoke', origin, { count: 3, dir, speed: 1.6, scale: 0.7, alpha: 0.45, color0: [0.5, 0.6, 0.7], color1: [0.42, 0.46, 0.5] });
      }
      if (look?.casings) this._casing(origin, dir);
    } else {
      // Leadwall / T-203: a smoke blast and sparks off the muzzle; the T-203 belches flame.
      this.fx?.emit('smoke', origin, { count: weapon === 'leadwall' ? 10 : 9, dir, speed: 2.8, scale: weapon === 'leadwall' ? 1 : 1.2, spread: 0.7 });
      this.fx?.emit('spark', origin, { count: weapon === 'leadwall' ? 18 : 6, dir, speed: 4.5, spread: weapon === 'leadwall' ? 0.55 : 0.3 });
      if (weapon === 't203') {
        this.fx?.emit('fire', origin, { count: 5, dir, speed: 2.4, scale: 1.4, spread: 0.35, life: 0.6 });
        this.fx?.emit('ember', origin, { count: 10, dir, speed: 2.8, spread: 0.5 });
      }
    }
    if (look?.kick) this.view?.kick(ev.vehicleId, ev.mount, look.kick * charge);
    if (look?.flash) this._flashLight(origin, look.flash * charge, tint?.light ?? null);
    return true;
  }

  /** A titan round's own burst where it stopped (`strength` 0 none; `voxel`: it hit the world, so dust and chips too). */
  _titanImpact(weapon, at, dir, strength, voxel) {
    if (!(strength > 0)) return;
    const back = [-dir[0], -dir[1], -dir[2]], tint = TITAN_SHOT_LOOK[weapon]?.tint ?? null;
    const n = s => Math.max(1, Math.round(s * strength));
    this._count('titanImpact');
    if (tint) {
      this.fx?.emit('spark', at, { count: n(8), dir: back, speed: 1.4, spread: 1.1, color0: tint.spark0, color1: tint.spark1 });
      this.fx?.emit('muzzle', at, { count: 1, scale: 0.5 * strength, near: false, color0: tint.muzzle0, color1: tint.muzzle1 });
    } else {
      this.fx?.emit('spark', at, { count: n(5), dir: back, speed: 1, spread: 0.9 });
    }
    if (!voxel) return;
    this.fx?.emit('dust', at, { count: n(3), dir: back, speed: 1, scale: 0.45 + 0.2 * strength, spread: 0.8 });
    if (strength > 1.5) {
      this.fx?.emit('debris', at, { count: n(2), dir: back, speed: 0.8 });
      this.fx?.emit('smoke', at, { count: n(1.5), dir: back, speed: 0.7, scale: 0.8, alpha: 0.5 });
    }
  }

  /** A Predator casing: brass flung out of the right side of the receiver, a little behind the muzzle. */
  _casing(origin, dir) {
    const side = Math.hypot(dir[0], dir[2]) > 1e-3 ? [-dir[2] / Math.hypot(dir[0], dir[2]), 0, dir[0] / Math.hypot(dir[0], dir[2])] : [1, 0, 0];
    const at = [origin[0] - dir[0] * 1.6 + side[0] * 0.5, origin[1] - dir[1] * 1.6 + 0.2, origin[2] - dir[2] * 1.6 + side[2] * 0.5];
    this.fx?.emit('debris', at, { count: 1, dir: [side[0], 0.7, side[2]], speed: 0.7, spread: 0.35, scale: 1.1, color0: BRASS, color1: BRASS.map(c => c * 0.7) });
  }

  /** A titan ability shot (`ev.ability`): the impact of every ray and the anchor's light flash. */
  _titanAbilityShot(ev, look, self) {
    for (const path of Array.isArray(ev.paths) ? ev.paths : []) {
      const segment = Array.isArray(path) ? path[0] : null;
      if (segment?.hit) this._impact(segment.hit, vec(segment.end));
    }
    const o = vec(ev.o);
    if (o && look?.flash) this._flashLight(o, look.flash);
    if (self && look?.shake) this.shake?.add(look.shake);
    return true;
  }

  /** The railgun's ionised wake: blue flecks lingering along the beam, denser with the charge. */
  _railWake(origin, dir, end, charge = 1) {
    const length = Math.min(90, end ? Math.hypot(end[0] - origin[0], end[1] - origin[1], end[2] - origin[2]) : 90);
    for (let t = 2; t < length; t += 3.6 - 1.8 * charge) {
      this.fx?.emit('spark', [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t],
        { count: 1, dir, speed: 0.4, spread: Math.PI, life: 0.35, color0: [0.6, 1.4, 2.4], color1: [0.2, 0.5, 1.4] });
    }
  }

  _mountIndex(item, mount) {
    const key = canonicalMountKey(item.kind, mount);
    return key ? vehicleDef(item.kind).mountOrder.indexOf(key) : -1;
  }

  _tracer(origin, dir, end, weapon) {
    const length = end ? Math.hypot(end[0] - origin[0], end[1] - origin[1], end[2] - origin[2]) : 120;
    const look = TRACERS[weapon] || TRACERS.hmg;
    this._count('tracer');
    if (this.tracers?.spawnTracer) {
      this._v.set(dir[0], dir[1], dir[2]).normalize();
      this.tracers.spawnTracer(origin, this._v, Math.max(0.5, Math.min(length, look.tracer.len * 3)), look, null, 1, 0, false);
    } else {
      // Without a TracerFX (capture pages): a streaked tracer puff.
      this.fx?.emit('tracerPuff', origin, { count: 1, dir, speed: 1, velocity: [dir[0] * 160, dir[1] * 160, dir[2] * 160] });
    }
  }

  _impact(hit, end) {
    const at = end || [hit.x + 0.5, hit.y + 0.5, hit.z + 0.5];
    const normal = [finite(hit.nx), finite(hit.ny), finite(hit.nz)];
    const block = this.getBlock(hit.x | 0, hit.y | 0, hit.z | 0);
    const tint = blockDustTint(block);
    this._count('impact');
    this.fx?.emit('dust', at, { count: 3, dir: normal, speed: 0.8, scale: 0.35, color0: tint, color1: tint, spread: 0.7 });
    this.fx?.emit('debris', at, { count: 3, dir: normal, speed: 0.5, color0: tint.map(v => v * 0.7), color1: tint.map(v => v * 0.6) });
    if (this.tracers?.onWallImpact) this.tracers.onWallImpact(hit, false);
  }

  _launch(ev) {
    const o = vec(ev.o), v = vec(ev.v);
    if (!o || !v || !o.every(Number.isFinite) || !v.every(Number.isFinite)) return false;
    const weapon = ev.vehicleWeapon, meta = vehicleWeaponMeta(weapon);
    if (!meta) return false;
    this._count('launch');
    if (weapon === 'tankAP' || weapon === 'tankHE') this._shellPass(ev, o, v, weapon);
    if (meta.kind === 'bomb') this._bombWhistle(ev, o, v);
    // Shells only flash at the muzzle (ProjectileFX draws their tracer); rockets and missiles carry a smoke trail.
    if (meta.kind !== 'rocket' && meta.kind !== 'missile') return true;
    if (this.missiles.size >= VEHICLE_FX.maxMissileTrails) {
      const [oldest] = this.missiles.keys();
      this._endTrail(oldest);
    }
    const trail = { id: String(ev.pid), weapon, o, v, g: finite(ev.g) || 0, age: 0, life: weapon === 'aaMissile' ? 6 : 5, pos: [...o], emitter: null };
    trail.emitter = this.fx?.addEmitter({ kind: 'smoke', pos: () => trail.pos, rate: weapon === 'aaMissile' ? 70 : 45,
      params: { speed: 0.2, scale: weapon === 'aaMissile' ? 0.45 : 0.35, life: 0.7, spread: Math.PI } }) || null;
    trail.glow = this.fx?.addEmitter({ kind: 'fire', pos: () => trail.pos, rate: 40, params: { speed: 0.1, scale: 0.35, life: 0.25 } }) || null;
    this.missiles.set(trail.id, trail);
    return true;
  }

  /** End a live missile's trail and flight loop without its impact effects (killcam). */
  endMissile(id) { return id != null && this._endTrail(id); }

  _endTrail(id) {
    const trail = this.missiles.get(String(id));
    if (!trail) return false;
    this.fx?.removeEmitter(trail.emitter);
    this.fx?.removeEmitter(trail.glow);
    this.sfx?.stopMissileFlight?.(trail.id);
    this.missiles.delete(trail.id);
    return true;
  }

  _explode(ev) {
    const ended = ev.pid != null && this._endTrail(ev.pid);
    if (typeof ev.vehicleWeapon !== 'string') return ended;
    // A shell that bursts short of its pass point takes its pending whistle or crack with it.
    if (ev.pid != null && (ev.vehicleWeapon === 'tankAP' || ev.vehicleWeapon === 'tankHE' || ev.vehicleWeapon === 'jetBomb')) this.sfx?.cancelShellFlyby?.(ev.pid);
    const pos = [ev.x, ev.y, ev.z];
    if (!pos.every(Number.isFinite)) return ended;
    this._count('explode');
    const bomb = ev.vehicleWeapon === 'jetBomb';
    const heavy = bomb || ev.vehicleWeapon === 'tankHE' || ev.vehicleWeapon === 'tankAP';
    const radius = bomb ? 9 : heavy ? (ev.vehicleWeapon === 'tankHE' ? 5.5 : 2.5) : ev.vehicleWeapon === 'helicopterRocket' ? 4 : 2;
    const below = this.ground(pos[0], pos[1] + 0.5, pos[2], 3);
    if (below && !below.fluid) {
      const tint = blockDustTint(below.block);
      this._ring(pos, below.y, bomb ? 28 : heavy ? 18 : 10, bomb ? 10 : heavy ? 7 : 4.5, tint);
      // A bomb also throws a dirt fountain out of the crater.
      if (bomb) this.fx?.emit('dust', [pos[0], below.y + 0.3, pos[2]], { count: 26, dir: [0, 1, 0], speed: 7, spread: 0.7, scale: 1.8,
        color0: tint, color1: tint.map(v => v * 0.7), ground: below.y });
    }
    if (bomb) this._flashLight(pos, 1.6);
    this.shake?.addExplosion(pos, radius, this.camera);
    return true;
  }

  /**
   * A tank shell that will pass close to the camera: its supersonic crack (AP)
   * or incoming whistle (HE) lands on the closest approach of the launch ray.
   * Never for the crew that fired it.
   */
  _shellPass(ev, o, v, weapon) {
    const eye = this.camera?.position;
    if (!eye || String(ev.id) === this.selfId) return false;
    const item = ev.vehicleId != null ? this.view?.item(ev.vehicleId) : null;
    if (item && this._rowIsSelf(item.row)) return false;
    const listener = [eye.x, eye.y, eye.z];
    const vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    if (!(vv > 1)) return false;
    const time = -((o[0] - listener[0]) * v[0] + (o[1] - listener[1]) * v[1] + (o[2] - listener[2]) * v[2]) / vv;
    if (!(time > 0.05) || time > VEHICLE_FX.shellPassSeconds) return false;
    // Ballistic drop until the pass (gravity from the event, else the shell's own).
    const g = finite(ev.g) || vehicleWeaponMeta(weapon)?.gravity || 0;
    const point = [o[0] + v[0] * time, o[1] + v[1] * time - 0.5 * g * time * time, o[2] + v[2] * time];
    const miss = Math.hypot(point[0] - listener[0], point[1] - listener[1], point[2] - listener[2]);
    if (miss > VEHICLE_FX.shellPassRadius) return false;
    return !!this.sfx?.shellFlyby?.(point, { he: weapon === 'tankHE', delay: time, id: ev.pid ?? null });
  }

  /**
   * A falling bomb: its arc from the launch event (gravity `g`) marched against
   * the voxels; a listener within VEHICLE_FX.bombWhistleRadius of the impact
   * hears the incoming whistle (the HE shell bank) peak as it lands. The crew
   * that dropped it never does. Explode cancels a whistle still pending.
   */
  _bombWhistle(ev, o, v) {
    const eye = this.camera?.position;
    if (!eye || String(ev.id) === this.selfId) return false;
    const g = finite(ev.g) || 9.8, step = 0.1;
    let prevY = o[1];
    for (let t = step; t <= 15; t += step) {
      const x = o[0] + v[0] * t, y = o[1] + v[1] * t - 0.5 * g * t * t, z = o[2] + v[2] * t;
      const below = this.ground(x, prevY, z, Math.max(1, Math.ceil(prevY - y) + 1));
      prevY = y;
      if (!below || below.y < y) continue;
      const impact = [x, below.y, z];
      const miss = Math.hypot(impact[0] - eye.x, impact[1] - eye.y, impact[2] - eye.z);
      if (miss > VEHICLE_FX.bombWhistleRadius) return false;
      return !!this.sfx?.shellFlyby?.([impact[0], impact[1] + 4, impact[2]], { he: true, delay: Math.max(0, t - 0.15), id: ev.pid ?? null });
    }
    return false;
  }

  /** A flat ring of dust racing outward (shockwave on the ground). */
  _ring([x, , z], groundY, count, speed, tint) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      this.fx?.emit('dust', [x, groundY + 0.2, z], { count: 1, dir: [Math.cos(a), 0.08, Math.sin(a)], speed, spread: 0.12,
        scale: 1.1, color0: tint, color1: tint, ground: groundY });
    }
  }

  _hit(ev) {
    const pos = vec(ev.pos);
    if (!pos || !pos.every(Number.isFinite)) return false;
    this._count(ev.eff ? 'hit' : 'ping');
    const item = this.view?.item(ev.vehicleId);
    const self = item ? this._rowIsSelf(item.row) : false;
    if (ev.res === 'rico') {
      // A round glancing off a tank plate: a hot spark fan and the ricochet whine, no scorch.
      this.fx?.emit('spark', pos, { count: 22, speed: 1.8, scale: 1.1, spread: 0.9, color0: [6, 4.2, 1.6], color1: [2.4, 1.2, 0.4] });
      this.fx?.emit('smoke', pos, { count: 2, speed: 0.5, scale: 0.4 });
      this.sfx?.vehicleRicochet?.(pos, { self });
      if (self && item) this.shake?.add(0.12);
      return true;
    }
    if (!ev.eff) {
      // Rounds that cannot hurt this armour: a white spark and a ping only.
      this.fx?.emit('spark', pos, { count: 3, speed: 0.6, scale: 0.8, color0: [3, 3, 3], color1: [1.4, 1.4, 1.4] });
      this.sfx?.vehicleHullHit?.(pos, { zone: ev.zone, eff: 0, dmg: ev.dmg, self, cls: ev.cls ?? null, type: item?.kind ?? null });
      return true;
    }
    const heavy = ['at', 'he', 'aa'].includes(ev.cls);
    this.fx?.emit('spark', pos, { count: heavy ? 18 : 7, speed: heavy ? 1.3 : 0.9 });
    this.fx?.emit('muzzle', pos, { count: 1, scale: heavy ? 1.2 : 0.45, near: false });
    this.fx?.emit('debris', pos, { count: heavy ? 6 : 2, speed: 0.6 });
    if (heavy) this.fx?.emit('smoke', pos, { count: 5, speed: 0.8, scale: 0.6 });
    if (item) this._hullMark(item, pos, ev.zone, heavy ? 0.8 : 0.35);
    this.sfx?.vehicleHullHit?.(pos, { zone: ev.zone, eff: 1, dmg: ev.dmg, self, cls: ev.cls ?? null, type: item?.kind ?? null });
    if (self && item) this.shake?.add(Math.min(0.6, finite(ev.dmg) / Math.max(1, vehicleMaxHp(item.row)) * VEHICLE_FX.hitShakePerFraction + 0.05));
    return true;
  }

  /** Scorch decal stuck to the hull at the hit point (follows the hull). */
  _hullMark(item, pos, zone, size) {
    item.root.updateMatrixWorld(true);
    const inverse = this._m.copy(item.root.matrixWorld).invert();
    const local = this._v.set(pos[0], pos[1], pos[2]).applyMatrix4(inverse);
    const normal = zone === 'top' ? [0, 1, 0] : zone === 'bottom' ? [0, -1, 0] : zone === 'front' ? [0, 0, -1]
      : zone === 'rear' ? [0, 0, 1] : [Math.sign(local.x) || 1, 0, 0];
    const meta = { id: item.id, local: local.toArray(), normal, size, life: item.lifeToken ?? 0 };
    this.hullMarks.add(this._markMatrix(item, meta), [0.05, 0.045, 0.04], 0.85, meta);
  }

  _markMatrix(item, meta) {
    this._q.setFromUnitVectors(this._w.set(0, 1, 0), this._v.fromArray(meta.normal));
    this._s.set(meta.size, 1, meta.size);
    const local = this._w.fromArray(meta.local).addScaledVector(this._v.fromArray(meta.normal), 0.03);
    this._m.compose(local, this._q, this._s);
    return this._m.premultiply(item.root.matrixWorld);
  }

  _disabled(ev) {
    const item = this.view?.item(ev.vehicleId);
    if (!item) return false;
    this._count('disabled');
    const anchor = item.model.emitters?.fire?.[0];
    const pos = anchor ? anchor.getWorldPosition(this._v).toArray() : [item.root.position.x, item.root.position.y + 1.5, item.root.position.z];
    this.fx?.emit('spark', pos, { count: 16, speed: 1.2 });
    this.fx?.emit('smoke', pos, { count: 18, speed: 1.4, scale: 1.2 });
    this.fx?.emit('fire', pos, { count: 8, scale: 1.2 });
    return true;
  }

  _repaired(ev) {
    const item = this.view?.item(ev.vehicleId);
    if (!item) return false;
    this._count('repaired');
    const pos = [item.root.position.x, item.root.position.y + (vehicleDef(item.kind)?.height ?? 2) * 0.6, item.root.position.z];
    // Welding sparks where the engineer works.
    this.fx?.emit('spark', pos, { count: 5, speed: 0.4, scale: 0.6, color0: [3, 3.2, 4], color1: [1, 1.3, 2.4] });
    return true;
  }

  _countermeasure(ev) {
    const item = this.view?.item(ev.vehicleId);
    if (!item) return false;
    const kind = ev.cm || (ev.type === 'smoke' ? 'smoke' : 'flares');
    const self = this._rowIsSelf(item.row);
    this._count(kind);
    const inherit = isAircraftType(item.kind) ? [finite(item.row.vx), finite(item.row.vy), finite(item.row.vz)] : null;
    if (kind === 'smoke') {
      for (const emitter of item.model.emitters?.smoke || []) {
        const pos = emitter.node.getWorldPosition(this._v).toArray();
        const dir = this._w.fromArray(emitter.direction).applyQuaternion(item.root.getWorldQuaternion(this._q)).toArray();
        this.fx?.emit('muzzle', pos, { count: 1, scale: 0.6, dir });
        this.fx?.emit('smoke', pos, { count: 12, dir, speed: 6, scale: 1.4, spread: 0.4 });
      }
    } else {
      const sources = item.model.emitters?.flares || [];
      // Flares stream out in a short ripple: three salvos per dispenser.
      for (let salvo = 0; salvo < 3; salvo++) {
        this._schedule(salvo * 0.18, () => {
          if (!this.view?.item(ev.vehicleId)) return;
          for (const emitter of sources) {
            const pos = emitter.node.getWorldPosition(this._v).toArray();
            const dir = this._w.fromArray(emitter.direction).applyQuaternion(item.root.getWorldQuaternion(this._q)).toArray();
            this.fx?.emit('flare', pos, { count: 2, dir, velocity: inherit, spread: 0.45 });
            this.fx?.emit('smoke', pos, { count: 3, dir, scale: 0.5, velocity: inherit });
          }
        });
      }
    }
    this.sfx?.vehicleCountermeasure?.([item.root.position.x, item.root.position.y, item.root.position.z], kind, { self });
    return true;
  }

  _schedule(delay, run) {
    (this._timers ||= []).push({ at: this.time + delay, run });
  }

  _flashLight(origin, strength, color = null) {
    this.flash = { pos: [...origin], strength, age: 0, color };
  }

  /**
   * Per-frame snapshot-driven FX from the presented hulls (VehicleView rows
   * are the latest authoritative rows). `vehicles` is accepted for the §3.6
   * signature; the view's presented rows already carry every field used.
   */
  update(dt = 0, camera = null, vehicles = null) {
    if (this._disposed) return;
    const step = Math.max(0, Math.min(0.1, finite(dt)));
    this.time += step;
    if (camera) this.camera = camera;
    if (this._timers?.length) {
      const due = this._timers.filter(timer => timer.at <= this.time);
      this._timers = this._timers.filter(timer => timer.at > this.time);
      for (const timer of due) timer.run();
    }
    this.decals.update(step);
    this.hullMarks.update(step);
    this.sprites.begin();
    const present = new Set();
    for (const item of this.view?.items?.values?.() || []) {
      if (!item.row) continue;
      present.add(item.id);
      this._updateHull(item, step);
    }
    for (const [id, state] of this.state) if (!present.has(id)) this._dropHull(id, state);
    this.sprites.end();
    this._updateMarks();
    this.decals.flush();
    this.hullMarks.flush();
    this._updateMissiles(step);
    this._updateFlash(step);
  }

  _hullState(item) {
    let state = this.state.get(item.id);
    if (!state) {
      state = { travel: [], last: null, smoke: null, fire: null, column: null, columnUntil: 0, wreck: false,
        agl: null, aglAt: -1, vel: null, life: 0, carry: { dust: 0, exhaust: 0, wash: 0, contrail: 0, vortex: 0, burner: 0 } };
      this.state.set(item.id, state);
    }
    return state;
  }

  _dropHull(id, state) {
    this._releaseEmitters(state);
    this.state.delete(id);
  }

  _releaseEmitters(state) {
    this.fx?.removeEmitter(state.smoke); this.fx?.removeEmitter(state.fire);
    this.fx?.removeEmitter(state.column); this.fx?.removeEmitter(state.columnFire);
    state.smoke = state.fire = state.column = state.columnFire = null;
  }

  _anchorPos(node) { return node.getWorldPosition(this._v).toArray(); }

  /** Emit `rate` per second as whole particles (fractional carry per hull). */
  _rate(state, key, rate, step) {
    state.carry[key] += rate * step;
    const count = Math.floor(state.carry[key]);
    state.carry[key] -= count;
    return count;
  }

  _updateHull(item, step) {
    const state = this._hullState(item);
    // VehicleView rebuilds a hull under the same id (a pad capture repaints
    // it). Continuous emitters close over anchors of the detached old model,
    // so they would stay at its last pose: rebind them to the new model.
    if (state.model !== item.model) {
      if (state.model) { this._releaseEmitters(state); state.travel = []; }
      state.model = item.model;
    }
    const row = item.row, emitters = item.model.emitters || {};
    const status = vehicleStatus(row);
    const wreck = !!item.wreck;
    const ratio = Math.max(0, Math.min(1, finite(row.hp) / rowMaxHp(row)));
    const pos = item.root.position;
    // A respawned hull (wreck -> alive) clears its scorch marks and column.
    if (state.wreck && !wreck) { state.life++; item.lifeToken = state.life; }
    if (!state.wreck && wreck) state.columnUntil = this.time + VEHICLE_FX.wreckColumn[0] + hashId(item.id) * (VEHICLE_FX.wreckColumn[1] - VEHICLE_FX.wreckColumn[0])
      - Math.max(0, finite(row.wreckAge));
    state.wreck = wreck;
    item.lifeToken = state.life;

    // Damage smoke below half HP, fire while burning, wreck column and flames.
    const fireAnchor = emitters.fire?.[0];
    const smokeRate = !wreck && ratio < VEHICLE_FX.damageSmokeBelow ? 6 + (VEHICLE_FX.damageSmokeBelow - ratio) * 60 : 0;
    state.smoke = this._sustain(state.smoke, smokeRate > 0, fireAnchor, 'smoke', smokeRate, { speed: 0.9, scale: 0.8 + (0.5 - ratio) });
    const burning = !wreck && status.burning;
    state.fire = this._sustain(state.fire, burning, fireAnchor, 'fire', 34, { speed: 0.8 });
    const columnLive = wreck && this.time < state.columnUntil;
    state.column = this._sustain(state.column, columnLive, fireAnchor || item.root, 'smokeColumn', 9, { speed: 1 });
    const wreckFire = wreck && finite(row.wreckAge ?? item.wreckAge) < VEHICLE_FX.wreckFireSeconds;
    state.columnFire = this._sustain(state.columnFire, wreckFire, fireAnchor || item.root, 'fire', 26, { scale: 1.4 });
    if (state.smoke) state.smoke.rate = smokeRate;

    if (wreck) { state.last = null; return; }
    const def = vehicleDef(item.kind), handling = def?.handling;
    const occupied = vehicleOccupiedSeats(row).length > 0;
    const engine = (status.engine || occupied) && row.engineOn !== false;
    const speed = Math.abs(finite(row.speed));

    // Ground: block-tinted dust, track and tyre marks, exhaust.
    if (handling === 'wheeled' || handling === 'tracked') {
      const trackSpeed = Math.max(speed, Math.abs(finite(row.leftTrackSpeed)), Math.abs(finite(row.rightTrackSpeed)));
      if (trackSpeed > VEHICLE_FX.dustSpeed) {
        const count = this._rate(state, 'dust', (trackSpeed - VEHICLE_FX.dustSpeed) * (handling === 'tracked' ? 3.2 : 2.4), step);
        for (let i = 0; i < count; i++) {
          const anchor = emitters.dust?.[(i + Math.floor(this.time * 7)) % Math.max(1, emitters.dust.length)];
          if (!anchor) break;
          const at = this._anchorPos(anchor);
          const below = this.ground(at[0], at[1] + 0.5, at[2], 2);
          if (!below || below.fluid) continue;
          const tint = blockDustTint(below.block);
          this.fx?.emit('dust', [at[0], below.y + 0.1, at[2]], { count: 1, dir: [0, 1, 0], speed: 0.6 + trackSpeed * 0.06,
            scale: 0.8 + trackSpeed * 0.05, color0: tint, color1: tint, ground: below.y });
        }
      }
      this._tracks(item, state, handling === 'tracked');
      if (engine) {
        const rate = VEHICLE_FX.exhaustIdle + Math.min(1, speed / 10) * VEHICLE_FX.exhaustMoving;
        const count = this._rate(state, 'exhaust', rate, step);
        for (let i = 0; i < count; i++) {
          const source = emitters.exhaust?.[i % Math.max(1, emitters.exhaust.length)];
          if (!source) break;
          const dir = this._w.fromArray(source.direction).applyQuaternion(item.root.quaternion).toArray();
          this.fx?.emit('exhaust', this._anchorPos(source.node), { count: 1, dir, speed: 0.6 + speed * 0.05 });
        }
      }
    } else if (handling === 'rotor') {
      this._rotorWash(item, state, step);
      if (engine && finite(row.rotorSpeed) > 0.2) {
        const count = this._rate(state, 'exhaust', 8 * finite(row.rotorSpeed), step);
        for (let i = 0; i < count; i++) {
          const source = emitters.exhaust?.[i % Math.max(1, emitters.exhaust.length)];
          if (!source) break;
          const dir = this._w.fromArray(source.direction).applyQuaternion(item.root.quaternion).toArray();
          this.fx?.emit('exhaust', this._anchorPos(source.node), { count: 1, dir, speed: 0.8, scale: 0.6, alpha: 0.6 });
        }
      }
    } else if (handling === 'fixedwing') {
      this._jet(item, state, step);
    }
    this._lights(item, engine);
  }

  /** Keep or drop a continuous emitter bound to an anchor's world position. */
  _sustain(handle, on, anchor, kind, rate, params) {
    if (!on || !anchor) { if (handle) this.fx?.removeEmitter(handle); return null; }
    if (handle?.active) return handle;
    const target = new THREE.Vector3();
    const position = () => anchor.getWorldPosition(target).toArray();
    return this.fx?.addEmitter({ kind, pos: position, rate, params }) || null;
  }

  _tracks(item, state, tracked) {
    const anchors = item.model.emitters?.tracks || [];
    if (!anchors.length) return;
    if (!state.travel.length) state.travel = anchors.map(anchor => this._anchorPos(anchor));
    anchors.forEach((anchor, i) => {
      const at = this._anchorPos(anchor), last = state.travel[i];
      const moved = Math.hypot(at[0] - last[0], at[2] - last[2]);
      if (moved < VEHICLE_FX.trackStamp) return;
      if (moved > 6) { state.travel[i] = at; return; } // teleport or respawn
      state.travel[i] = at;
      const below = this.ground(at[0], at[1] + 0.6, at[2], 2);
      if (!below || below.fluid) return;
      const yaw = Math.atan2(at[0] - last[0], at[2] - last[2]);
      this._q.setFromAxisAngle(this._w.set(0, 1, 0), yaw);
      this._s.set(tracked ? 0.62 : 0.3, 1, moved + 0.04);
      this._m.compose(this._v.set((at[0] + last[0]) / 2, below.y + 0.025, (at[2] + last[2]) / 2), this._q, this._s);
      const tint = blockDustTint(below.block).map(v => v * 0.38);
      this.decals.add(this._m, tint, tracked ? 0.55 : 0.42);
      this._count('decal');
    });
  }

  _agl(item, state) {
    if (state.aglAt > this.time - 0.15 && state.agl) return state.agl;
    const p = item.root.position;
    const ground = this.ground(p.x, p.y + 0.5, p.z, 160);
    state.agl = ground ? { height: p.y - ground.y, ground } : { height: Infinity, ground: null };
    state.aglAt = this.time;
    return state.agl;
  }

  _rotorWash(item, state, step) {
    const rotor = Math.max(0, Math.min(1, finite(item.row.rotorSpeed)));
    if (rotor < 0.3) return;
    const agl = this._agl(item, state);
    if (!agl.ground || agl.height > VEHICLE_FX.rotorWashAgl) return;
    const strength = rotor * (1 - Math.max(0, agl.height) / VEHICLE_FX.rotorWashAgl);
    const count = this._rate(state, 'wash', 40 * strength, step);
    const p = item.root.position, radius = item.model.emitters?.rotor?.radius ?? 5;
    const fluid = agl.ground.fluid;
    const tint = fluid ? null : blockDustTint(agl.ground.block);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, r = radius * (0.4 + Math.random() * 0.5);
      const at = [p.x + Math.cos(a) * r, agl.ground.y + 0.15, p.z + Math.sin(a) * r];
      if (fluid) this.fx?.emit('water', at, { count: 1, dir: [Math.cos(a), 0.5, Math.sin(a)], speed: 1.4, ground: agl.ground.y - 0.1 });
      else this.fx?.emit('dust', at, { count: 1, dir: [Math.cos(a), 0.15, Math.sin(a)], speed: 2.2 + strength * 3, scale: 1.2,
        color0: tint, color1: tint, ground: agl.ground.y });
    }
    if (count) this._count(fluid ? 'spray' : 'wash');
  }

  _jet(item, state, step) {
    const row = item.row, emitters = item.model.emitters || {};
    const power = Math.max(0, Math.min(1, finite(row.enginePower ?? row.throttle)));
    const occupied = vehicleOccupiedSeats(row).length > 0;
    if (!occupied || row.engineOn === false || power <= 0.01) return;
    const back = this._w.set(0, 0, 1).applyQuaternion(item.root.quaternion).toArray();
    const velocity = [finite(row.vx), finite(row.vy), finite(row.vz)];
    // Afterburner above 80 % power: a hot, short plume at each nozzle.
    if (power > 0.8) {
      const count = this._rate(state, 'burner', 90 * (power - 0.8) / 0.2, step);
      for (let i = 0; i < count; i++) {
        const nozzle = emitters.afterburner?.[i % Math.max(1, emitters.afterburner.length)];
        if (!nozzle) break;
        this.fx?.emit('fire', this._anchorPos(nozzle.node), { count: 1, dir: back, speed: 4, scale: 0.7, life: 0.4,
          color0: [2.2, 1.6, 3.4], color1: [3, 1.2, 0.3], velocity });
      }
      if (count) this._count('afterburner');
    }
    const agl = this._agl(item, state);
    if (agl.height > VEHICLE_FX.contrailAgl) {
      const count = this._rate(state, 'contrail', 30, step);
      for (let i = 0; i < count; i++) {
        const tip = emitters.wingtips?.[i % Math.max(1, emitters.wingtips.length)];
        if (tip) this.fx?.emit('water', this._anchorPos(tip), { count: 1, speed: 0.1, life: 3, scale: 0.6, alpha: 0.8, near: true });
      }
      if (count) this._count('contrail');
    }
    // Wingtip vortices when the authoritative velocity turns hard (high G).
    if (state.vel && step > 0) {
      const g = Math.hypot(velocity[0] - state.vel[0], velocity[1] - state.vel[1], velocity[2] - state.vel[2]) / step / 9.81;
      if (g > VEHICLE_FX.vortexG) {
        const count = this._rate(state, 'vortex', 60, step);
        for (let i = 0; i < count; i++) {
          const tip = emitters.wingtips?.[i % Math.max(1, emitters.wingtips.length)];
          if (tip) this.fx?.emit('water', this._anchorPos(tip), { count: 1, speed: 0.05, life: 0.5, scale: 0.3, alpha: 0.7 });
        }
        if (count) this._count('vortex');
      }
    }
    state.vel = velocity;
  }

  _lights(item, engine) {
    const lamps = item.lampLevel ?? (engine ? 1 : 0.18);
    for (const light of item.model.emitters?.lights || []) {
      const look = LIGHT_LOOK[light.kind];
      if (!look) continue;
      let gain = 1;
      if (light.kind === 'head' || light.kind === 'tail' || light.kind === 'titanLamp' || light.kind === 'titanTail') { if (!engine) continue; gain = lamps; }
      else if (light.kind === 'battery') {
        if (item.wreck || (finite(item.row?.tw?.[4]) & 16)) continue;    // TITAN_ABILITY_BITS.batteryOut
        gain = 0.7 + 0.3 * Math.sin(this.time * 2.6 + hashId(item.id) * 6.28);
      } else if (light.kind === 'strobe') {
        const phase = (this.time + hashId(item.id)) % 1.1;
        if (phase > 0.07) continue;
      }
      light.node.getWorldPosition(this._v);
      this.sprites.push(this._v, look.color.map(c => c * gain), look.size);
    }
  }

  _updateMarks() {
    const layer = this.hullMarks;
    for (let slot = 0; slot < layer.mesh.count; slot++) {
      const meta = layer.slots[slot];
      if (!meta) continue;
      const item = this.view?.item(meta.id);
      if (!item || (item.lifeToken ?? 0) !== meta.life || layer.time - layer.birth.array[slot] > VEHICLE_FX.hullMarkSeconds) {
        layer.kill(slot); continue;
      }
      layer.mesh.setMatrixAt(slot, this._markMatrix(item, meta));
      layer.touch(slot);
    }
  }

  _updateMissiles(step) {
    for (const trail of [...this.missiles.values()]) {
      trail.age += step;
      if (trail.age >= trail.life) { this._endTrail(trail.id); continue; }
      const t = trail.age;
      trail.pos[0] = trail.o[0] + trail.v[0] * t;
      trail.pos[1] = trail.o[1] + trail.v[1] * t - 0.5 * trail.g * t * t;
      trail.pos[2] = trail.o[2] + trail.v[2] * t;
      // The authoritative projectile owns the path; homing corrections arrive as projectileUpdate.
      if (trail.weapon === 'aaMissile') this.sfx?.missileFlight?.(trail.id, trail.pos);
    }
  }

  /** Authoritative mid-flight correction for a tracked missile. */
  correctMissile(ev) {
    const trail = ev?.pid != null && this.missiles.get(String(ev.pid));
    const o = vec(ev?.o ?? ev?.pos), v = vec(ev?.v);
    if (!trail || !o || !o.every(Number.isFinite)) return false;
    // Re-base the path on the correction but keep the remaining trail lifetime.
    trail.life = Math.max(0.5, trail.life - trail.age);
    trail.o = [...o]; trail.age = 0;
    if (v && v.every(Number.isFinite)) trail.v = [...v];
    return true;
  }

  _updateFlash(step) {
    if (!this.flash) return;
    this.flash.age += step;
    if (this.flash.age >= VEHICLE_FX.flashSeconds) {
      this.flash = null;
      const light = this.muzzleLights?.lights?.[1];
      if (light) light.intensity = 0;
      return;
    }
    this.applyMuzzleLight();
  }

  /**
   * Write an active main-gun flash into the remote slot (index 1) of the
   * shared two-light muzzle pool. The frame calls this after the roster has
   * filled the pool, so the cannon flash wins for its 90 ms.
   */
  applyMuzzleLight() {
    const light = this.muzzleLights?.lights?.[1];
    if (!light || !this.flash) return false;
    const left = Math.max(0, 1 - this.flash.age / VEHICLE_FX.flashSeconds);
    light.position.fromArray(this.flash.pos);
    const tint = this.flash.color;
    if (tint) light.color.setRGB(tint[0], tint[1], tint[2]); else light.color.setRGB(1, 0.78, 0.45);
    light.distance = 22;
    light.intensity = 60 * this.flash.strength * left;
    return left > 0;
  }

  /** Per-kind counts of handled events and snapshot-driven FX (tests, stats). */
  get stats() {
    return Object.freeze({ ...this.counts, decals: this.decals.live, hullMarks: this.hullMarks.live,
      sprites: this.sprites.count, missiles: this.missiles.size, hulls: this.state.size, draws: 3 });
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const [id, state] of [...this.state]) this._dropHull(id, state);
    for (const id of [...this.missiles.keys()]) this._endTrail(id);
    this.decals.dispose();
    this.hullMarks.dispose();
    this.sprites.dispose();
    this.parachutes.dispose();
    this.group.removeFromParent();
    const light = this.muzzleLights?.lights?.[1];
    if (this.flash && light) light.intensity = 0;
    this.sfx?.stopVehicleCues?.();
    this.view = null; this.fx = null; this.sfx = null;
  }
}
