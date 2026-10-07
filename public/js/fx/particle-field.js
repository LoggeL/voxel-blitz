// One particle field for every vehicle and ambience effect: two instanced
// draws (alpha-blended smoke/dust and additive flashes/sparks/embers), each a
// ring buffer of per-particle spawn records. Motion is integrated on the GPU
// from the spawn state (position, velocity, gravity, drag, birth time), so the
// CPU only writes a record per emitted particle and two uniforms per frame.
// Particles fade near the camera (2.5 m) and where their quads meet the
// emitter's ground plane, so smoke never clips into the lens or the terrain.
import * as THREE from '../vendor/three.module.js';
import { FX_KINDS, FX_PRESETS, PARTICLE_CAPACITY } from './presets.js';

export { FX_KINDS };

/** Share of the capacity given to the alpha-blended pool (the rest is additive). */
const ALPHA_SHARE = 0.625;
const NO_GROUND = -1e5;
const MAX_EMIT = 256;
const TAU = Math.PI * 2;

const VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
uniform float uTime;
uniform vec3 uCamPos;
attribute vec4 aPos0;   // xyz spawn, w birth time
attribute vec4 aVel;    // xyz velocity, w life
attribute vec4 aSize;   // size0, size1, gravity, drag
attribute vec4 aCol0;   // rgb, alpha0
attribute vec4 aCol1;   // rgb, alpha1
attribute vec4 aMisc;   // tile + 4 * near, rotation0, spin, streak
attribute float aGround;
varying vec2 vUv;
varying vec4 vColor;
varying float vTile;
varying float vFade;
varying float vGround;
varying float vWorldY;
varying float vSize;
void main() {
  float age = uTime - aPos0.w;
  float life = max( aVel.w, 1e-3 );
  if ( age < 0.0 || age > life ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    vColor = vec4( 0.0 );
    return;
  }
  float t = age / life;
  float drag = aSize.w;
  float decay = exp( - drag * age );
  float reach = drag > 1e-3 ? ( 1.0 - decay ) / drag : age;
  vec3 p = aPos0.xyz + aVel.xyz * reach;
  p.y += 0.5 * aSize.z * age * age;
  vec3 velocity = aVel.xyz * decay + vec3( 0.0, aSize.z * age, 0.0 );
  if ( aGround > -9999.0 ) p.y = max( p.y, aGround + 0.02 );
  float size = mix( aSize.x, aSize.y, t );
  float tileNear = aMisc.x;
  float nearFlag = step( 3.5, tileNear );
  vTile = tileNear - 4.0 * nearFlag;
  float angle = aMisc.y + aMisc.z * age;
  vec4 mvPosition = viewMatrix * vec4( p, 1.0 );
  vec2 corner = position.xy;
  vec2 offset;
  vec2 viewVelocity = ( viewMatrix * vec4( velocity, 0.0 ) ).xy;
  float speed = length( viewVelocity );
  if ( aMisc.w > 0.0 && speed > 1e-3 ) {
    vec2 axis = viewVelocity / speed;
    vec2 side = vec2( - axis.y, axis.x );
    offset = axis * corner.y * ( size + speed * aMisc.w ) + side * corner.x * size;
  } else {
    float c = cos( angle ), s = sin( angle );
    offset = vec2( c * corner.x - s * corner.y, s * corner.x + c * corner.y ) * size;
  }
  mvPosition.xy += offset;
  gl_Position = projectionMatrix * mvPosition;
  vUv = corner + 0.5;
  vec4 color = mix( aCol0, aCol1, t );
  // Ease in over the first 6 % of the life so spawns never pop.
  color.a *= smoothstep( 0.0, 0.06, t );
  vColor = color;
  vFade = nearFlag > 0.5 ? smoothstep( 0.6, 2.5, distance( p, uCamPos ) ) : 1.0;
  vGround = aGround;
  // World height of this corner: the view rotation is orthonormal, so its
  // inverse is the transpose (row 1 of the view matrix's upper 3x3).
  vWorldY = p.y + viewMatrix[ 1 ][ 0 ] * offset.x + viewMatrix[ 1 ][ 1 ] * offset.y;
  vSize = size;
  #include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D uAtlas;
uniform vec3 uLight;
varying vec2 vUv;
varying vec4 vColor;
varying float vTile;
varying float vFade;
varying float vGround;
varying float vWorldY;
varying float vSize;
void main() {
  if ( vColor.a <= 0.002 ) discard;
  vec2 cell = vec2( mod( vTile, 2.0 ), floor( vTile / 2.0 ) );
  vec4 texel = texture2D( uAtlas, ( clamp( vUv, 0.01, 0.99 ) + cell ) * 0.5 );
  float alpha = vColor.a * texel.a * vFade;
  if ( vGround > -9999.0 ) alpha *= smoothstep( 0.0, max( 0.15, vSize * 0.35 ), vWorldY - vGround );
  if ( alpha <= 0.002 ) discard;
  vec3 color = vColor.rgb * texel.rgb;
  #ifdef PARTICLE_ADDITIVE
    gl_FragColor = vec4( color * alpha, 1.0 );
  #else
    gl_FragColor = vec4( color * uLight, alpha );
  #endif
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    #ifdef PARTICLE_ADDITIVE
      gl_FragColor.rgb *= 1.0 - fogFactor;
    #else
      gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
    #endif
  #endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

let atlas = null;
/**
 * 2x2 procedural atlas (64 px tiles): 0 soft puff, 1 billowing smoke,
 * 2 hot glow, 3 square chip. White RGB, shape in alpha (and a little
 * internal shading in RGB for the smoke tiles).
 */
export function particleAtlas() {
  if (atlas) return atlas;
  const tile = 64, size = tile * 2, data = new Uint8Array(size * size * 4);
  const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
  for (let index = 0; index < 4; index++) {
    const ox = (index % 2) * tile, oy = Math.floor(index / 2) * tile;
    for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) {
      const u = (x + 0.5) / tile * 2 - 1, v = (y + 0.5) / tile * 2 - 1, r = Math.hypot(u, v);
      let alpha = 0, shade = 1;
      if (index === 0) alpha = Math.pow(Math.max(0, 1 - r), 1.6);
      else if (index === 1) {
        const n = noise(u * 3.2 + 9, v * 3.2 + 4) * 0.65 + noise(u * 7 + 2, v * 7 + 7) * 0.35;
        alpha = Math.max(0, Math.min(1, (1 - r * 1.08) * 1.5 * (0.55 + 0.75 * n)));
        shade = 0.72 + 0.28 * (1 - v * 0.5) * (0.7 + 0.3 * n);
      } else if (index === 2) alpha = Math.exp(-r * r * 5.5) + Math.max(0, 1 - r) * 0.15;
      else alpha = Math.max(Math.abs(u), Math.abs(v)) < 0.8 ? 1 : 0;
      const o = ((oy + y) * size + ox + x) * 4;
      const value = Math.round(255 * Math.max(0, Math.min(1, shade)));
      data[o] = data[o + 1] = data[o + 2] = value;
      data[o + 3] = Math.round(255 * Math.max(0, Math.min(1, alpha)));
    }
  }
  atlas = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  atlas.magFilter = THREE.LinearFilter;
  atlas.minFilter = THREE.LinearFilter;
  atlas.name = 'particle-atlas';
  atlas.needsUpdate = true;
  return atlas;
}

const STRIDES = Object.freeze({ aPos0: 4, aVel: 4, aSize: 4, aCol0: 4, aCol1: 4, aMisc: 4, aGround: 1 });

/** One blend pool: one mesh, one ring buffer of particle records. */
class ParticlePool {
  constructor(blend, capacity, uniforms) {
    this.blend = blend;
    this.capacity = Math.max(16, capacity | 0);
    this.cursor = 0;
    this.used = 0;
    this.deaths = new Float32Array(this.capacity);
    this.dirtyMin = Infinity;
    this.dirtyMax = -1;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0], 3));
    geometry.setIndex([0, 1, 2, 2, 1, 3]);
    this.attributes = {};
    for (const [name, stride] of Object.entries(STRIDES)) {
      const attribute = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * stride), stride);
      attribute.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, attribute);
      this.attributes[name] = attribute;
    }
    // Unwritten slots are born in the far future: invisible until reused.
    const pos0 = this.attributes.aPos0.array;
    for (let i = 0; i < this.capacity; i++) pos0[i * 4 + 3] = 1e9;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    const additive = blend === 'add';
    const material = new THREE.ShaderMaterial({
      name: additive ? 'particle-field-add' : 'particle-field-alpha',
      uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      defines: additive ? { PARTICLE_ADDITIVE: '' } : {},
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: true,
      toneMapped: true,
      forceSinglePass: true,
    });
    this.geometry = geometry;
    this.material = material;
    // One InstancedMesh per blend mode. Its instance matrices stay identity:
    // the vertex shader positions each particle from its spawn record.
    this.mesh = new THREE.InstancedMesh(geometry, material, this.capacity);
    this.mesh.count = 0;
    this.mesh.name = material.name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 7 : 6;
  }

  /** Next slot: the ring cursor, skipping nothing (oldest is overwritten). */
  take(death) {
    const slot = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.used < this.capacity) this.used++;
    this.deaths[slot] = death;
    if (slot < this.dirtyMin) this.dirtyMin = slot;
    if (slot > this.dirtyMax) this.dirtyMax = slot;
    return slot;
  }

  /** Upload the dirty slot range once per frame. */
  flush() {
    if (this.dirtyMax < 0) return;
    const start = this.dirtyMin, count = this.dirtyMax - this.dirtyMin + 1;
    for (const [name, stride] of Object.entries(STRIDES)) {
      const attribute = this.attributes[name];
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(start * stride, count * stride);
      attribute.needsUpdate = true;
    }
    this.dirtyMin = Infinity;
    this.dirtyMax = -1;
    this.mesh.count = this.used;
  }

  alive(time) {
    let count = 0;
    for (let i = 0; i < this.used; i++) if (this.deaths[i] > time) count++;
    return count;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}

const unit = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const vec3Of = value => Array.isArray(value) ? value
  : value && Number.isFinite(value.x) ? [value.x, value.y, value.z] : null;

/**
 * The shared particle system. `emit(kind, pos, params)` spawns a burst of a
 * preset kind; `addEmitter` keeps a continuous source alive until removed.
 * params: count, dir, speed (scale), scale (size), life (scale), color0,
 * color1, alpha (scale), ground (y of the ground plane), velocity (inherited),
 * spread, near (bool), jitter (position jitter radius, metres).
 */
export class ParticleField {
  constructor({ scene = null, capacity = PARTICLE_CAPACITY.medium } = {}) {
    const total = Math.max(64, Math.floor(unit(capacity, PARTICLE_CAPACITY.medium)));
    this.capacity = total;
    this.time = 0;
    this.uniforms = {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: { value: 0 },
      uCamPos: { value: new THREE.Vector3() },
      uAtlas: { value: particleAtlas() },
      uLight: { value: new THREE.Color(1, 1, 1) },
    };
    const alphaCapacity = Math.round(total * ALPHA_SHARE);
    this.pools = {
      alpha: new ParticlePool('alpha', alphaCapacity, this.uniforms),
      add: new ParticlePool('add', total - alphaCapacity, this.uniforms),
    };
    this.group = new THREE.Group();
    this.group.name = 'particle-field';
    this.group.add(this.pools.alpha.mesh, this.pools.add.mesh);
    scene?.add(this.group);
    this.emitters = new Set();
    this.emitted = 0;
    this.emitsByKind = Object.fromEntries(FX_KINDS.map(kind => [kind, 0]));
    this._seed = 0x2f6b1d;
    this._disposed = false;
  }

  _rand() {
    let value = (this._seed = (this._seed + 0x6d2b79f5) | 0);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  /** Scene lighting for the alpha pool (sun + sky tint); additive ignores it. */
  setLighting(color) {
    if (color?.isColor) this.uniforms.uLight.value.copy(color);
    else if (Array.isArray(color)) this.uniforms.uLight.value.setRGB(color[0], color[1], color[2]);
  }

  /** Spawn a burst of one preset kind. Returns the number of particles written. */
  emit(kind, pos, params = {}) {
    if (this._disposed) return 0;
    const preset = FX_PRESETS[kind];
    const origin = vec3Of(pos);
    if (!preset || !origin || !origin.every(Number.isFinite)) return 0;
    const count = Math.max(0, Math.min(MAX_EMIT, Math.round(unit(params.count, 1))));
    if (!count) return 0;
    const pool = this.pools[preset.blend === 'add' ? 'add' : 'alpha'];
    const a = pool.attributes;
    const dir = vec3Of(params.dir);
    let dx = 0, dy = 1, dz = 0;
    if (dir && dir.every(Number.isFinite)) {
      const length = Math.hypot(dir[0], dir[1], dir[2]);
      if (length > 1e-6) { dx = dir[0] / length; dy = dir[1] / length; dz = dir[2] / length; }
    }
    // Orthonormal basis around the cone axis.
    let ux = Math.abs(dy) < 0.9 ? 0 : 1, uy = Math.abs(dy) < 0.9 ? 1 : 0, uz = 0;
    let rx = uy * dz - uz * dy, ry = uz * dx - ux * dz, rz = ux * dy - uy * dx;
    const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
    ux = dy * rz - dz * ry; uy = dz * rx - dx * rz; uz = dx * ry - dy * rx;
    const spread = Math.max(0, Math.min(Math.PI, unit(params.spread, preset.spread)));
    const speedScale = unit(params.speed, 1), sizeScale = unit(params.scale, 1), lifeScale = unit(params.life, 1);
    const alphaScale = unit(params.alpha, 1);
    const inherit = vec3Of(params.velocity);
    const ivx = unit(inherit?.[0]), ivy = unit(inherit?.[1]), ivz = unit(inherit?.[2]);
    const c0 = Array.isArray(params.color0) ? params.color0 : Array.isArray(params.color) ? params.color : preset.color0;
    const c1 = Array.isArray(params.color1) ? params.color1 : Array.isArray(params.color) ? params.color : preset.color1;
    const ground = Number.isFinite(params.ground) ? params.ground : preset.ground ? origin[1] - 0.05 : NO_GROUND;
    const near = params.near ?? preset.near;
    const jitter = unit(params.jitter, preset.jitter);
    const tileNear = preset.tile + (near ? 4 : 0);
    const cosSpread = Math.cos(spread);
    for (let i = 0; i < count; i++) {
      const life = (preset.life[0] + (preset.life[1] - preset.life[0]) * this._rand()) * lifeScale;
      const slot = pool.take(this.time + life);
      // Uniform direction inside the cone.
      const cosT = 1 - this._rand() * (1 - cosSpread), sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const phi = this._rand() * TAU, cp = Math.cos(phi) * sinT, sp = Math.sin(phi) * sinT;
      const vx = dx * cosT + rx * cp + ux * sp, vy = dy * cosT + ry * cp + uy * sp, vz = dz * cosT + rz * cp + uz * sp;
      const speed = (preset.speed[0] + (preset.speed[1] - preset.speed[0]) * this._rand()) * speedScale;
      const j = jitter * this._rand();
      const jphi = this._rand() * TAU, jy = (this._rand() - 0.5) * jitter;
      let o = slot * 4;
      a.aPos0.array[o] = origin[0] + Math.cos(jphi) * j;
      a.aPos0.array[o + 1] = origin[1] + jy;
      a.aPos0.array[o + 2] = origin[2] + Math.sin(jphi) * j;
      a.aPos0.array[o + 3] = this.time;
      a.aVel.array[o] = vx * speed + ivx;
      a.aVel.array[o + 1] = vy * speed + ivy;
      a.aVel.array[o + 2] = vz * speed + ivz;
      a.aVel.array[o + 3] = life;
      const sizeJitter = 0.8 + 0.4 * this._rand();
      a.aSize.array[o] = preset.size[0] * sizeScale * sizeJitter;
      a.aSize.array[o + 1] = preset.size[1] * sizeScale * sizeJitter;
      a.aSize.array[o + 2] = preset.gravity;
      a.aSize.array[o + 3] = preset.drag;
      a.aCol0.array[o] = c0[0]; a.aCol0.array[o + 1] = c0[1]; a.aCol0.array[o + 2] = c0[2];
      a.aCol0.array[o + 3] = preset.alpha0 * alphaScale;
      a.aCol1.array[o] = c1[0]; a.aCol1.array[o + 1] = c1[1]; a.aCol1.array[o + 2] = c1[2];
      a.aCol1.array[o + 3] = preset.alpha1 * alphaScale;
      a.aMisc.array[o] = tileNear;
      a.aMisc.array[o + 1] = this._rand() * TAU;
      a.aMisc.array[o + 2] = (this._rand() * 2 - 1) * preset.spin;
      a.aMisc.array[o + 3] = preset.streak;
      a.aGround.array[slot] = ground;
      o += 4;
    }
    this.emitted += count;
    this.emitsByKind[kind] = (this.emitsByKind[kind] || 0) + count;
    return count;
  }

  /**
   * A continuous source. `pos` may be an array, a Vector3 or a function
   * returning either (re-read every update); `rate` is particles per second.
   * Returns a handle for removeEmitter (and live edits of rate/params/pos).
   */
  addEmitter({ kind, pos, rate = 10, params = {}, until = Infinity } = {}) {
    if (this._disposed || !FX_PRESETS[kind]) return null;
    const handle = { kind, pos, rate: Math.max(0, unit(rate)), params: { ...params }, carry: 0,
      until: Number.isFinite(until) ? this.time + until : Infinity, active: true };
    this.emitters.add(handle);
    return handle;
  }

  removeEmitter(handle) {
    if (!handle) return false;
    handle.active = false;
    return this.emitters.delete(handle);
  }

  update(dt = 0, camera = null) {
    if (this._disposed) return;
    const step = Math.max(0, Math.min(0.25, unit(dt)));
    this.time += step;
    for (const handle of this.emitters) {
      if (this.time >= handle.until) { this.emitters.delete(handle); handle.active = false; continue; }
      handle.carry += handle.rate * step;
      const count = Math.floor(handle.carry);
      if (count <= 0) continue;
      handle.carry -= count;
      const pos = typeof handle.pos === 'function' ? handle.pos() : handle.pos;
      if (pos) this.emit(handle.kind, pos, { ...handle.params, count });
    }
    this.uniforms.uTime.value = this.time;
    if (camera) camera.getWorldPosition?.(this.uniforms.uCamPos.value);
    this.pools.alpha.flush();
    this.pools.add.flush();
  }

  /** Clear every live particle and emitter (match teardown, respawn of the scene). */
  clear() {
    this.emitters.clear();
    for (const pool of Object.values(this.pools)) {
      pool.attributes.aPos0.array.fill(0);
      for (let i = 0; i < pool.capacity; i++) pool.attributes.aPos0.array[i * 4 + 3] = 1e9;
      pool.deaths.fill(0);
      pool.cursor = 0; pool.used = 0;
      pool.dirtyMin = 0; pool.dirtyMax = pool.capacity - 1;
      pool.flush();
    }
  }

  /** Draw calls (always 2), live particles and capacity for HUD/stats and tests. */
  get stats() {
    return Object.freeze({
      draws: 2, capacity: this.capacity, emitters: this.emitters.size, emitted: this.emitted,
      alive: this.pools.alpha.alive(this.time) + this.pools.add.alive(this.time),
    });
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.emitters.clear();
    this.pools.alpha.dispose();
    this.pools.add.dispose();
    this.group.removeFromParent();
  }
}
