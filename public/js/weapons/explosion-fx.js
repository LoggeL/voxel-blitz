// Blast presentation for every projectile end: an HDR core flash and shock
// ring (instanced, opacity carried by the per-instance colour under additive
// blending, so each blast fades on its own clock), a fireball-and-smoke
// billboard batch over a procedurally generated puff atlas, scorch decals on
// the ground under real explosions, and the light envelope that
// ProjectileFX feeds into its fixed projectile point-light pool.
// Every pool is fixed at construction; update() allocates nothing.
import * as THREE from '../vendor/three.module.js';
import { ScorchDecals } from './scorch-decals.js';

const GLAIVE_COLOR = 0xff3fd0;
export const BLAST_CAPACITY = 96;
const FIRE_CAPACITY = 192;
const SMOKE_CAPACITY = 320;
const ATLAS_CELL = 128;
const ATLAS_CELLS = 2; // 2 x 2 puff variants

const FIRE_HOT = Object.freeze([1, 1, 1]);
const FIRE_OILY = Object.freeze([1, 0.82, 0.62]);

/**
 * Blast presentation per projectile type. `color/grow/life/ring/ringColor/wireframe`
 * drive the flash sphere and ring; `flash` is the core's HDR peak and `flashLife`
 * its (shorter) life where a fireball carries the look. `fire`/`smoke` describe the
 * billboard burst, `light` the pool light (range m, peak intensity, life s) and
 * `scorch` the ground mark diameter at the default radius.
 */
export const BLAST_STYLE = Object.freeze({
  frag: Object.freeze({
    color: 0xff9f1c, grow: 0.38, life: 0.42, ring: true, ringColor: 0xffc56b, flash: 2.4, flashLife: 0.13,
    fire: Object.freeze({ count: 8, size: 1.7, speed: 5.5, life: 0.55, tint: FIRE_HOT }),
    smoke: Object.freeze({ count: 12, size: 1.5, speed: 2.6, life: 2.4, shade: 0.2 }),
    light: Object.freeze({ color: 0xff9a3c, range: 9, intensity: 16, life: 0.5 }),
    scorch: 3.4,
  }),
  limpet: Object.freeze({
    color: 0xffd9a8, grow: 0.46, life: 0.5, ring: true, ringColor: 0xff5a3c, flash: 2.6, flashLife: 0.14,
    fire: Object.freeze({ count: 9, size: 1.8, speed: 6, life: 0.6, tint: FIRE_HOT }),
    smoke: Object.freeze({ count: 12, size: 1.6, speed: 2.8, life: 2.5, shade: 0.18 }),
    light: Object.freeze({ color: 0xffa24a, range: 9.5, intensity: 18, life: 0.55 }),
    scorch: 3.6,
  }),
  pulse: Object.freeze({
    color: 0x59e8ff, grow: 0.65, life: 0.42, wireframe: true, ring: true, ringColor: 0x9ff4ff, flash: 1.5,
    light: Object.freeze({ color: 0x59e8ff, range: 8, intensity: 11, life: 0.45 }),
  }),
  bolt: Object.freeze({ color: 0x7dfcff, grow: 0.16, life: 0.28, ring: false, flash: 1.4 }),
  glaive: Object.freeze({ color: GLAIVE_COLOR, grow: 0.08, life: 0.22, ring: false, flash: 1.2 }),
  glaiveCatch: Object.freeze({ color: GLAIVE_COLOR, grow: 0.05, life: 0.32, ring: true, ringColor: 0xff8ae6, flash: 1 }),
  // SB-1 SUDSBLASTER pop: a brief soft soapy blink; the pop strokes and droplets in
  // projectiles.js carry the cartoon read (smoke billboards tint warm, so no puff).
  bubble: Object.freeze({
    color: 0xd6f6ff, grow: 0.14, life: 0.09, ring: false, flash: 0.35,
    light: Object.freeze({ color: 0x9fe9ff, range: 4, intensity: 0.6, life: 0.08 }),
  }),
  rocket: Object.freeze({
    color: 0xffb347, grow: 0.5, life: 0.55, ring: true, ringColor: 0xff7a1c, flash: 2.6, flashLife: 0.15,
    fire: Object.freeze({ count: 10, size: 2.0, speed: 6.5, life: 0.65, tint: FIRE_HOT }),
    smoke: Object.freeze({ count: 16, size: 1.8, speed: 3, life: 2.8, shade: 0.19 }),
    light: Object.freeze({ color: 0xffa040, range: 10, intensity: 20, life: 0.55 }),
    scorch: 3.8,
  }),
  molotov: Object.freeze({
    color: 0xff7924, grow: 0.2, life: 0.3, ring: false, flash: 1.6, flashLife: 0.12,
    fire: Object.freeze({ count: 6, size: 1.3, speed: 3.2, life: 0.5, tint: FIRE_OILY }),
    smoke: Object.freeze({ count: 10, size: 1.25, speed: 1.6, life: 2.2, shade: 0.11 }),
    light: Object.freeze({ color: 0xff7a2a, range: 7.5, intensity: 10, life: 0.5 }),
    scorch: 2.3,
  }),
});

/**
 * What a point light adds to the view, for ranking the fixed light pool:
 * intensity x range^2 / (range^2 + d^2) with d the distance from `eye` to
 * `at`. Monotonic in distance, so equal lights still rank nearest first.
 */
export function lightWeight(intensity, range, at, eye) {
  const d2 = eye ? (at.x - eye.x) ** 2 + (at.y - eye.y) ** 2 + (at.z - eye.z) ** 2 : 0;
  const r2 = range * range;
  return intensity * r2 / (r2 + d2);
}

/**
 * Billboard scale for a blast radius against the style's reference radius.
 * Above 1 it only grows with a soft knee: the fireball and smoke read as
 * "bigger" for chaos-sized blasts without swallowing the screen at the real
 * 7.5 m frag/rocket radius.
 */
export function spriteScale(radius, style) {
  const raw = radius / (style.grow * 12);
  return raw <= 1 ? Math.max(0.6, raw) : Math.min(1.6, 1 + (raw - 1) * 0.35);
}

/* ---------------------------------------------------------------- atlas -- */

let atlasPixels = null;

function hash(x, y, seed) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function noise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x, y, seed, octaves) {
  let sum = 0, amp = 0.5, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x, y, seed + o * 17);
    norm += amp;
    x = x * 2.03 + 3.1; y = y * 2.03 - 1.7; amp *= 0.5;
  }
  return sum / norm;
}

const smooth = (edge0, edge1, x) => {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * 2 x 2 atlas of billowing puffs. R: density (lumpy silhouette, cauliflower
 * detail), G: heat (noisy hot core for the fire ramp), B: erosion noise that
 * eats the puff from its thin parts as it ages. Pure data, so it builds the
 * same in Node tests and in every browser.
 */
export function explosionAtlasData() {
  if (atlasPixels) return atlasPixels;
  const size = ATLAS_CELL * ATLAS_CELLS;
  const data = new Uint8Array(size * size * 4);
  for (let cell = 0; cell < ATLAS_CELLS * ATLAS_CELLS; cell++) {
    const cx = (cell % ATLAS_CELLS) * ATLAS_CELL, cy = Math.floor(cell / ATLAS_CELLS) * ATLAS_CELL;
    const seed = 101 + cell * 57;
    for (let y = 0; y < ATLAS_CELL; y++) {
      for (let x = 0; x < ATLAS_CELL; x++) {
        const px = (x + 0.5) / ATLAS_CELL * 2 - 1, py = (y + 0.5) / ATLAS_CELL * 2 - 1;
        const r = Math.hypot(px, py);
        // Low-frequency warp gives each variant its own lumpy outline.
        const lump = fbm(px * 1.6 + cell * 4.3, py * 1.6 - cell * 2.1, seed, 3);
        const outline = 0.76 + (lump - 0.5) * 0.5;
        const rr = r / outline;
        let density = Math.max(0, 1 - rr * rr);
        // Cauliflower detail: rounded billows on the surface of the dome.
        const billow = 1 - Math.abs(fbm(px * 3.4 + 7.7, py * 3.4 + cell, seed + 5, 4) * 2 - 1);
        density = density * (0.62 + billow * 0.55) + (billow - 0.55) * 0.18 * density;
        density *= smooth(0.99, 0.84, r);
        const core = fbm(px * 2.6 - 3.3, py * 2.6 + 5.9, seed + 9, 3);
        const heat = Math.pow(Math.max(0, 1 - r / (0.34 + core * 0.46)), 0.75);
        const erosion = fbm(px * 4.6 + 1.3, py * 4.6 - 8.2, seed + 13, 4);
        const i = ((cy + y) * size + cx + x) * 4;
        data[i] = Math.round(Math.max(0, Math.min(1, density)) * 255);
        data[i + 1] = Math.round(Math.max(0, Math.min(1, heat)) * 255);
        data[i + 2] = Math.round(Math.max(0, Math.min(1, erosion)) * 255);
        data[i + 3] = 255;
      }
    }
  }
  atlasPixels = data;
  return data;
}

function createExplosionAtlas() {
  const size = ATLAS_CELL * ATLAS_CELLS;
  const texture = new THREE.DataTexture(explosionAtlasData(), size, size, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/* ------------------------------------------------------------- sprites -- */

const SPRITE_VERTEX = `
  attribute vec3 center;
  attribute vec4 shape;   // size, rotation, atlas cell, kind (0 fire, 1 smoke)
  attribute vec4 tint;    // rgb (HDR for fire), opacity
  attribute vec2 params;  // normalised age, fire glow on smoke
  varying vec2 puffUv;
  varying vec2 puffCell;
  varying vec4 puffTint;
  varying vec2 puffParams;
  varying vec2 puffLight;
  varying float puffKind;
  #include <fog_pars_vertex>
  void main() {
    float cell = shape.z;
    puffUv = uv;
    puffCell = (uv + vec2(mod(cell, 2.0), floor(cell * 0.5))) * 0.5;
    puffParams = params;
    puffKind = shape.w;
    float c = cos(shape.y), s = sin(shape.y);
    vec2 local = mat2(c, s, -s, c) * (position.xy * shape.x);
    vec4 view = modelViewMatrix * vec4(center, 1.0);
    view.xy += local;
    // Readability: fade by how much of the screen the puff covers, not by its
    // centre's depth alone. cover is the sprite's projected half-size in NDC
    // (1 = it spans the full screen height), so a big puff a few metres off
    // thins out while the same puff down a lane keeps its full density. Fire
    // keeps a visible floor (the blast must still read); smoke nearly vanishes.
    float depth = -view.z;
    float cover = shape.x * 0.5 * projectionMatrix[1][1] / max(depth, 0.05);
    float floorAlpha = shape.w < 0.5 ? 0.25 : 0.1;
    float near = smoothstep(0.3, 1.2, depth) * mix(1.0, floorAlpha, smoothstep(0.2, 0.9, cover));
    puffTint = vec4(tint.rgb, tint.a * near);
    vec4 mvPosition = view;
    #include <fog_vertex>
    // World up in the sprite's rotated frame, for the fake top light on smoke.
    vec3 up = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
    puffLight = vec2(c * up.x + s * up.y, -s * up.x + c * up.y);
    gl_Position = projectionMatrix * view;
  }
`;

const SPRITE_FRAGMENT = `
  uniform sampler2D puffAtlas;
  #include <fog_pars_fragment>
  varying vec2 puffUv;
  varying vec2 puffCell;
  varying vec4 puffTint;
  varying vec2 puffParams;
  varying vec2 puffLight;
  varying float puffKind;
  vec3 fireRamp(float x) {
    vec3 c = mix(vec3(0.07, 0.012, 0.0), vec3(0.85, 0.16, 0.012), smoothstep(0.0, 0.36, x));
    c = mix(c, vec3(1.0, 0.44, 0.05), smoothstep(0.32, 0.66, x));
    return mix(c, vec3(1.0, 0.72, 0.32), smoothstep(0.66, 1.0, x));
  }
  void main() {
    vec4 puff = texture2D(puffAtlas, puffCell);
    float density = puff.r, heat = puff.g, grain = puff.b;
    float t = puffParams.x;
    vec4 color;
    if (puffKind < 0.5) {
      float edge = t * 0.62 * (0.55 + 0.45 * grain);
      float a = smoothstep(edge, edge + 0.2, density) * puffTint.a;
      float temp = clamp(heat * (1.2 - t * 1.05) + (density - 0.5) * 0.35 - t * 0.12, 0.0, 1.0);
      vec3 fire = fireRamp(temp) * puffTint.rgb;
      // Mostly additive while hot, sootier (more coverage) as it cools.
      color = vec4(fire * a, a * (0.3 + 0.55 * t));
    } else {
      float edge = t * t * 0.6 + t * 0.14 * (1.0 - grain);
      float a = smoothstep(edge, edge + 0.42, density * (0.8 + 0.2 * grain)) * (0.5 + 0.5 * density) * puffTint.a;
      vec2 p = puffUv * 2.0 - 1.0;
      float lit = clamp(dot(p, puffLight) * 0.55 + 0.62 + (density - 0.5) * 0.3, 0.25, 1.15);
      vec3 smoke = puffTint.rgb * lit * (0.85 + 0.3 * grain);
      // Young smoke is under-lit by the fireball it rose out of.
      smoke += vec3(1.9, 0.62, 0.16) * puffParams.y * (1.1 - lit * 0.6) * density;
      color = vec4(smoke * a, a);
    }
    if (color.a < 0.003 && max(color.r, max(color.g, color.b)) < 0.003) discard;
    gl_FragColor = color;
    #include <fog_fragment>
    #ifdef USE_FOG
      // Premultiplied: fade towards fog colour at this puff's own coverage.
      gl_FragColor = vec4(mix(color.rgb, fogColor * color.a, fogFactor), color.a);
    #endif
  }
`;

function createSpritePool(capacity, kind) {
  return Array.from({ length: capacity }, () => ({
    kind, active: false, age: 0, life: 1,
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    size0: 1, size1: 1, rotation: 0, spin: 0, cell: 0,
    r: 1, g: 1, b: 1, opacity: 1, drag: 1, rise: 0, glow: 0,
  }));
}

/* --------------------------------------------------------------- class -- */

export class ExplosionFX {
  /**
   * @param {THREE.Object3D} scene
   * @param {(x:number, y:number, z:number) => boolean} isSolid world-space solidity (floors itself)
   */
  constructor(scene, isSolid = () => false) {
    this.root = new THREE.Group();
    this.root.name = 'explosion-fx';
    this.isSolid = isSolid;
    scene.add(this.root);
    this._seed = 0x5eed1234;
    this._matrix = new THREE.Matrix4();
    this._color = new THREE.Color();
    this._recent = 0;

    // Active blast records, oldest first, compacted in place (no splice).
    this.blasts = [];
    this._blastPool = Array.from({ length: BLAST_CAPACITY }, () => ({
      isBlast: true, style: null, material: null, ring: false,
      x: 0, y: 0, z: 0, age: 0, life: 0, flashLife: 0, span: 0, radius: 0, grow: 0,
      r: 1, g: 1, b: 1, rr: 1, rg: 1, rb: 1, lightRank: 0,
    }));
    this._freeBlasts = this._blastPool.slice();

    // Flash core, the pulse's wire core and the shock ring: one instanced draw each.
    this.coreGeometry = new THREE.IcosahedronGeometry(1, 2);
    this.ringGeometry = new THREE.TorusGeometry(1, 0.032, 5, 48);
    this.ringGeometry.rotateX(Math.PI / 2);
    const additive = (wireframe) => new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, depthWrite: false, wireframe,
      blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
    });
    this.coreMaterial = additive(false);
    this.wireMaterial = additive(true);
    this.ringMaterial = additive(false);
    this.cores = this._instanced(this.coreGeometry, this.coreMaterial, 'explosion-core');
    this.wires = this._instanced(this.coreGeometry, this.wireMaterial, 'explosion-wire');
    this.rings = this._instanced(this.ringGeometry, this.ringMaterial, 'explosion-ring');

    // Fireball + smoke billboards: one draw, smoke written first, fire over it.
    this.fire = createSpritePool(FIRE_CAPACITY, 0);
    this.smoke = createSpritePool(SMOKE_CAPACITY, 1);
    this._fireCursor = 0;
    this._smokeCursor = 0;
    const capacity = FIRE_CAPACITY + SMOKE_CAPACITY;
    this.spriteGeometry = new THREE.InstancedBufferGeometry();
    const plane = new THREE.PlaneGeometry(1, 1);
    this.spriteGeometry.index = plane.index.clone();
    this.spriteGeometry.setAttribute('position', plane.attributes.position.clone());
    this.spriteGeometry.setAttribute('uv', plane.attributes.uv.clone());
    plane.dispose();
    this.centers = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.shapes = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.tints = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.params = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    for (const attribute of [this.centers, this.shapes, this.tints, this.params]) attribute.setUsage(THREE.DynamicDrawUsage);
    this.spriteGeometry.setAttribute('center', this.centers);
    this.spriteGeometry.setAttribute('shape', this.shapes);
    this.spriteGeometry.setAttribute('tint', this.tints);
    this.spriteGeometry.setAttribute('params', this.params);
    this.spriteGeometry.instanceCount = 0;
    this.spriteMaterial = new THREE.ShaderMaterial({
      transparent: true, depthTest: true, depthWrite: false, toneMapped: false, fog: true,
      // Premultiplied: fire adds light, smoke covers what is behind it.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { puffAtlas: { value: null } }]),
      vertexShader: SPRITE_VERTEX,
      fragmentShader: SPRITE_FRAGMENT,
    });
    // Set after the merge: UniformsUtils.merge would clone the texture.
    this.spriteMaterial.uniforms.puffAtlas.value = createExplosionAtlas();
    this.sprites = new THREE.Mesh(this.spriteGeometry, this.spriteMaterial);
    this.sprites.frustumCulled = false;
    this.sprites.name = 'explosion-sprites';
    // With the flame stream: after opaque bodies, before additive dust (8) and flashes (9).
    this.sprites.renderOrder = 6;
    this.root.add(this.sprites);

    this.scorch = new ScorchDecals(this.root, isSolid);
  }

  _instanced(geometry, material, name) {
    const mesh = new THREE.InstancedMesh(geometry, material, BLAST_CAPACITY);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Colour attribute exists from the start: its define is part of the program key.
    mesh.setColorAt(0, this._color.setRGB(0, 0, 0));
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = 9;
    mesh.name = name;
    this.root.add(mesh);
    return mesh;
  }

  /** Deterministic per-instance PRNG (mulberry32): captures and tests replay exactly. */
  _rand() {
    let t = (this._seed = (this._seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  seed(value) {
    this._seed = value | 0;
  }

  /**
   * One blast at a world point: flash, ring, fireball, smoke and (explosives) a
   * scorch. `eye` (optional world position) thins the smoke of a blast that goes
   * off on top of the viewer so it cannot hide the fight for seconds.
   */
  spawn(x, y, z, style, radius, eye = null) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !style) return null;
    const size = Number.isFinite(radius) && radius > 0 ? radius : style.grow * 12;
    // Cluster salvos and bumper bombs share a bounded visual budget.
    if (!this._freeBlasts.length) this._freeBlasts.push(this.blasts.shift());
    const blast = this._freeBlasts.pop();
    blast.style = style;
    blast.material = style.wireframe ? this.wireMaterial : this.coreMaterial;
    blast.ring = !!style.ring;
    blast.x = x; blast.y = y; blast.z = z;
    blast.age = 0;
    blast.life = style.life;
    blast.flashLife = style.flashLife || style.life;
    blast.span = Math.max(style.life, style.light?.life || 0);
    blast.radius = size;
    blast.grow = style.grow;
    this._color.setHex(style.color);
    blast.r = this._color.r; blast.g = this._color.g; blast.b = this._color.b;
    this._color.setHex(style.ringColor ?? style.color);
    blast.rr = this._color.r; blast.rg = this._color.g; blast.rb = this._color.b;
    this.blasts.push(blast);

    // Many blasts in one moment (chaos salvos) thin out their sprites instead of
    // overwriting each other's fireballs a frame after they appear.
    const scale = spriteScale(size, style);
    const thin = 1 / (1 + Math.max(0, this._recent - 2) * 0.4);
    if (style.fire || style.smoke) this._recent += 1;
    if (style.fire) this._spawnFire(blast, style.fire, scale, thin);
    if (style.smoke) {
      // Viewer inside the inner blast: thinner, shorter-lived smoke (0.45x opacity,
      // 0.6x life at point blank, full from ~0.75 radius out).
      const d = eye ? Math.sqrt((x - eye.x) ** 2 + (y - eye.y) ** 2 + (z - eye.z) ** 2) : Infinity;
      const close = Math.max(0, Math.min(1, (d - size * 0.25) / (size * 0.5)));
      this._spawnSmoke(blast, style.smoke, scale, thin, 0.4 + 0.6 * this._skyOpenness(x, y, z),
        0.45 + 0.55 * close, 0.6 + 0.4 * close);
    }
    if (style.scorch) {
      this.scorch.place(x, y, z, style.scorch * Math.sqrt(scale), 0.95, this._rand() * Math.PI * 2,
        Math.max(2, Math.round(size * 0.55)));
    }
    return blast;
  }

  _spawnFire(blast, fire, scale, thin) {
    const count = Math.max(2, Math.round(fire.count * thin));
    for (let i = 0; i < count; i++) {
      const p = this.fire[this._fireCursor];
      this._fireCursor = (this._fireCursor + 1) % FIRE_CAPACITY;
      // Upward-biased directions: a ground burst throws its fire up and out.
      const theta = this._rand() * Math.PI * 2;
      const up = 0.15 + this._rand() * 0.85;
      const flat = Math.sqrt(1 - up * up);
      const speed = fire.speed * scale * (0.35 + this._rand() * 0.65);
      p.active = true;
      p.age = -this._rand() * 0.04;
      p.life = fire.life * (0.7 + this._rand() * 0.5);
      p.vx = Math.cos(theta) * flat * speed;
      p.vy = up * speed * 0.8;
      p.vz = Math.sin(theta) * flat * speed;
      p.x = blast.x + p.vx * 0.03;
      p.y = blast.y + 0.1 + p.vy * 0.03;
      p.z = blast.z + p.vz * 0.03;
      p.size0 = fire.size * scale * (0.55 + this._rand() * 0.45);
      p.size1 = p.size0 * (1.6 + this._rand() * 0.6);
      p.rotation = this._rand() * Math.PI * 2;
      p.spin = (this._rand() - 0.5) * 2.4;
      p.cell = Math.floor(this._rand() * 4);
      p.r = fire.tint[0]; p.g = fire.tint[1]; p.b = fire.tint[2];
      p.opacity = 1;
      p.drag = 5.5;
      p.rise = 2.2;
      p.glow = 0;
    }
  }

  _spawnSmoke(blast, smoke, scale, thin, ambient, density = 1, linger = 1) {
    const count = Math.max(3, Math.round(smoke.count * thin));
    for (let i = 0; i < count; i++) {
      const p = this.smoke[this._smokeCursor];
      this._smokeCursor = (this._smokeCursor + 1) % SMOKE_CAPACITY;
      const theta = this._rand() * Math.PI * 2;
      const spread = Math.sqrt(this._rand());
      const speed = smoke.speed * scale * (0.35 + spread * 0.75);
      p.active = true;
      // Smoke appears as the fireball cools, not before it.
      p.age = -(0.05 + this._rand() * 0.18);
      p.life = smoke.life * linger * (0.8 + this._rand() * 0.35);
      p.vx = Math.cos(theta) * speed;
      p.vy = (0.6 + this._rand() * 1.1) * scale;
      p.vz = Math.sin(theta) * speed;
      p.x = blast.x + Math.cos(theta) * spread * 0.5 * scale;
      p.y = blast.y + 0.25 + this._rand() * 0.6 * scale;
      p.z = blast.z + Math.sin(theta) * spread * 0.5 * scale;
      p.size0 = smoke.size * scale * (0.6 + this._rand() * 0.4);
      p.size1 = p.size0 * (2.1 + this._rand() * 0.8);
      p.rotation = this._rand() * Math.PI * 2;
      p.spin = (this._rand() - 0.5) * 0.8;
      p.cell = Math.floor(this._rand() * 4);
      const shade = smoke.shade * ambient * (0.85 + this._rand() * 0.3);
      p.r = shade; p.g = shade * 0.97; p.b = shade * 0.93;
      p.opacity = (0.5 + this._rand() * 0.2) * density;
      p.drag = 2.1;
      p.rise = 0.45;
      p.glow = 0.55 + this._rand() * 0.3;
    }
  }

  /**
   * Share of five upward probes (straight up and four 45-degree leans, 24 m)
   * that reach open sky. Smoke under a roof is lit by the room, not the sun,
   * so it spawns darker. Runs once per blast, never per frame.
   */
  _skyOpenness(x, y, z) {
    let open = 0;
    for (let probe = 0; probe < 5; probe++) {
      const dx = probe === 1 ? 0.7071 : probe === 2 ? -0.7071 : 0;
      const dz = probe === 3 ? 0.7071 : probe === 4 ? -0.7071 : 0;
      const dy = probe === 0 ? 1 : 0.7071;
      let blocked = false;
      for (let t = 1.5; t <= 24 && !blocked; t += 0.75) blocked = this.isSolid(x + dx * t, y + dy * t, z + dz * t);
      if (!blocked) open++;
    }
    return open / 5;
  }

  /** Light envelope 0..1 for a blast: a quick attack, then a ~0.5 s decay. */
  lightLevel(blast) {
    const light = blast.style?.light;
    if (!light || blast.age >= light.life) return 0;
    const attack = 0.035;
    if (blast.age < attack) return blast.age / attack;
    const tail = 1 - (blast.age - attack) / (light.life - attack);
    return Math.exp(-(blast.age - attack) / 0.13) * Math.min(1, tail * 4);
  }

  /** `eye` (optional world position) caps a flash that goes off in the viewer's face. */
  update(dt, eye = null) {
    const step = Math.max(0, dt);
    this._recent = Math.max(0, this._recent - step * 12);
    this._updateBlasts(step, eye);
    this._updateSprites(step);
    this.scorch.update(step);
  }

  _updateBlasts(step, eye) {
    let write = 0, cores = 0, wires = 0, rings = 0;
    const blasts = this.blasts;
    for (let read = 0; read < blasts.length; read++) {
      const blast = blasts[read];
      blast.age += step;
      if (blast.age >= blast.span) { this._freeBlasts.push(blast); continue; }
      blasts[write++] = blast;
      const style = blast.style;
      // Readability: a point-blank flash and ring dim instead of whiting out the screen.
      const near = eye ? Math.max(0.3, Math.min(1, (Math.sqrt((blast.x - eye.x) ** 2
        + (blast.y - eye.y) ** 2 + (blast.z - eye.z) ** 2) - 0.5) / 3)) : 1;
      const t = Math.min(1, blast.age / blast.flashLife);
      if (t < 1) {
        const eased = 1 - Math.pow(1 - t, 3);
        const scale = 0.08 + blast.radius * blast.grow * eased * (style.flashLife ? 0.3 : 1);
        // Additive: the colour is the opacity. HDR peak for bloom, then a fast fall.
        const level = (1 - t) * (1 - t) * 0.9 * (style.flash || 1) * (t < 0.12 ? 1.25 : 1) * near;
        this._matrix.makeScale(scale, scale, scale).setPosition(blast.x, blast.y, blast.z);
        this._color.setRGB(blast.r * level, blast.g * level, blast.b * level);
        const mesh = style.wireframe ? this.wires : this.cores;
        const index = style.wireframe ? wires++ : cores++;
        mesh.setMatrixAt(index, this._matrix);
        mesh.setColorAt(index, this._color);
      }
      if (blast.ring) {
        const rt = Math.min(1, blast.age / blast.life);
        if (rt < 1) {
          const eased = 1 - Math.pow(1 - rt, 3);
          const scale = 0.1 + blast.radius * 1.1 * eased;
          // A fireball carries explosives; their ring stays a faint shock cue.
          const fade = 1 - rt;
          const level = (style.fire ? fade * fade * fade * 0.3 : fade * 0.8) * near;
          this._matrix.makeScale(scale, scale, scale).setPosition(blast.x, blast.y + 0.15, blast.z);
          this._color.setRGB(blast.rr * level, blast.rg * level, blast.rb * level);
          this.rings.setMatrixAt(rings, this._matrix);
          this.rings.setColorAt(rings, this._color);
          rings++;
        }
      }
    }
    blasts.length = write;
    this._commit(this.cores, cores);
    this._commit(this.wires, wires);
    this._commit(this.rings, rings);
  }

  _commit(mesh, count) {
    mesh.count = count;
    if (!count) return;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
  }

  _updateSprites(step) {
    let count = 0;
    count = this._writeSprites(this.smoke, step, count);
    count = this._writeSprites(this.fire, step, count);
    this.spriteGeometry.instanceCount = count;
    if (count) {
      this.centers.needsUpdate = this.shapes.needsUpdate = true;
      this.tints.needsUpdate = this.params.needsUpdate = true;
    }
  }

  _writeSprites(pool, step, count) {
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      if (!p.active) continue;
      p.age += step;
      if (p.age >= p.life) { p.active = false; continue; }
      if (p.age < 0) continue;
      const damp = Math.exp(-p.drag * step);
      p.vx *= damp; p.vz *= damp;
      p.vy = p.vy * damp + p.rise * step;
      p.x += p.vx * step; p.y += p.vy * step; p.z += p.vz * step;
      p.rotation += p.spin * step;
      const t = p.age / p.life;
      const grow = 1 - (1 - t) * (1 - t) * (1 - t);
      const size = p.size0 + (p.size1 - p.size0) * grow;
      let r = p.r, g = p.g, b = p.b, opacity = p.opacity, glow = 0;
      if (p.kind === 0) {
        // HDR while hot so bloom catches the fireball; it cools as it grows.
        const heat = 1.75 - t * 0.95;
        r *= heat; g *= heat; b *= heat;
        // Thins over its second half so a close fireball never reads as a wall.
        const late = t > 0.5 ? (t - 0.5) * 2 : 0;
        opacity *= Math.min(1, p.age / 0.03 + 0.35) * (1 - late * late * 0.7);
      } else {
        opacity *= Math.min(1, p.age / 0.2) * (1 - t * t);
        glow = p.glow * Math.max(0, 1 - p.age / 0.45);
      }
      this.centers.setXYZ(count, p.x, p.y, p.z);
      this.shapes.setXYZW(count, size, p.rotation, p.cell, p.kind);
      this.tints.setXYZW(count, r, g, b, opacity);
      this.params.setXY(count, t, glow);
      count++;
    }
    return count;
  }

  get activeSprites() {
    return this.spriteGeometry.instanceCount;
  }

  clear() {
    for (const blast of this.blasts) this._freeBlasts.push(blast);
    this.blasts.length = 0;
    for (const p of this.fire) p.active = false;
    for (const p of this.smoke) p.active = false;
    this.cores.count = this.wires.count = this.rings.count = 0;
    this.spriteGeometry.instanceCount = 0;
    this._recent = 0;
    this.scorch.clear();
  }

  dispose() {
    this.clear();
    this.scorch.dispose();
    for (const mesh of [this.cores, this.wires, this.rings]) mesh.dispose();
    this.root.removeFromParent();
    this.coreGeometry.dispose();
    this.ringGeometry.dispose();
    this.coreMaterial.dispose();
    this.wireMaterial.dispose();
    this.ringMaterial.dispose();
    this.spriteGeometry.dispose();
    this.spriteMaterial.uniforms.puffAtlas.value.dispose();
    this.spriteMaterial.dispose();
  }
}
