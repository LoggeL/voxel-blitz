// Voxel light volume: one RGBA8 cell per voxel, sampled per fragment.
//   R  sky light 0..15   Minecraft-style flood: full down open columns, -1 per
//                        step sideways, so roofs, galleries and tunnels darken
//   G  sun visibility    a ray to the sun, swept once along sheared columns;
//                        every roof, wall and tree casts a block-exact shadow
//   B  block light 0..15 glowstone, lava, portals and map lamps
//   A  block light hue   palette coordinate of the brightest emitter
// Everything is baked on the CPU at load and patched locally after block
// deltas, then uploaded as a Data3DTexture. The GPU cost is one 3D texture
// fetch per fragment on the materials that opt in; no light count, shadow map
// or program key ever changes during a match.

import * as THREE from '../vendor/three.module.js';
import {
  AIR, GLASS, LEAVES, MC_GLASS, MC_LEAVES, MC_WATER, MC_LAVA, MC_PORTAL,
  MC_GLOWSTONE, MC_GHOST_GLOWSTONE,
} from '../../../shared/worlddata.js';

export const LIGHT_MAX = 15;
/** Horizontal reach of any light change; region rebuilds cover this radius. */
const REACH = LIGHT_MAX + 1;

const OPAQUE = 0, CLEAR = 1, FOLIAGE = 2, WATER = 3;

/** Palette coordinates for block-light hues (see voxelBlockColor in GLSL). */
export const LIGHT_HUE = Object.freeze({ cyan: 0, warm: 0.33, amber: 0.45, lava: 0.66, portal: 1 });

const EMITTERS = new Map([
  [MC_GLOWSTONE, { level: 15, hue: LIGHT_HUE.warm }],
  [MC_GHOST_GLOWSTONE, { level: 15, hue: LIGHT_HUE.warm }],
  [MC_LAVA, { level: 14, hue: LIGHT_HUE.lava }],
  [MC_PORTAL, { level: 11, hue: LIGHT_HUE.portal }],
]);

export function lightClass(id) {
  if (id === AIR || id === GLASS || id === MC_GLASS || id === MC_PORTAL) return CLEAR;
  if (id === LEAVES || id === MC_LEAVES) return FOLIAGE;
  if (id === MC_WATER) return WATER;
  return OPAQUE;
}

/** Brightness of a sky level with the per-map floor, matching the shader. */
export function skyBrightness(level, minSky = 0.5, base = 0.93) {
  return Math.max(minSky, Math.pow(base, LIGHT_MAX - Math.max(0, Math.min(LIGHT_MAX, level))));
}

export class VoxelLightVolume {
  /**
   * @param getBlock live voxel getter (x,y,z)->id
   * @param {{sx:number,sy:number,sz:number}} dims map extents
   * @param {{sunDir?:THREE.Vector3, emitters?:()=>Array<{x,y,z,level,hue}>}} options
   */
  constructor(getBlock, dims, { sunDir = new THREE.Vector3(60, 90, 20).normalize(), emitters = () => [] } = {}) {
    this.getBlock = getBlock;
    this.W = dims.sx; this.H = dims.sy; this.D = dims.sz;
    this.N = this.W * this.H * this.D;
    this.extraEmitters = emitters;
    const dir = sunDir.clone().normalize();
    // Guard against a sun at the horizon: the sweep walks one layer per step.
    this.shearX = dir.x / Math.max(dir.y, 0.35);
    this.shearZ = dir.z / Math.max(dir.y, 0.35);
    this.cls = new Uint8Array(this.N);
    this.sky = new Uint8Array(this.N);
    this.sun = new Uint8Array(this.N);
    this.block = new Uint8Array(this.N);
    this.hue = new Uint8Array(this.N);
    this.emitter = new Uint8Array(this.N);
    // Cells can be re-queued as their level rises; twice the volume never wraps.
    this.queue = new Int32Array(Math.max(4096, this.N * 2));
    this.data = new Uint8Array(this.N * 4);
    this.texture = new THREE.Data3DTexture(this.data, this.W, this.H, this.D);
    this.texture.format = THREE.RGBAFormat;
    this.texture.type = THREE.UnsignedByteType;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = this.texture.wrapR = THREE.ClampToEdgeWrapping;
    this.texture.unpackAlignment = 1;
    this.texture.name = 'voxel-light';
    this.pending = null;         // {x0,x1,z0,z1} union of changed cells
    this.sunColumns = new Set(); // sheared columns touched by deltas
    this.lastUpload = -Infinity;
    this.uploads = 0;
    this.built = false;
  }

  index(x, y, z) { return x + this.W * (y + this.H * z); }

  /** Full bake. Returns elapsed milliseconds. */
  build() {
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const { W, H, D, cls, getBlock } = this;
    for (let z = 0; z < D; z++) {
      for (let y = 0; y < H; y++) {
        let i = this.index(0, y, z);
        for (let x = 0; x < W; x++, i++) cls[i] = lightClass(getBlock(x, y, z));
      }
    }
    this.rebuildSky(0, W - 1, 0, D - 1);
    this.rebuildBlock(0, W - 1, 0, D - 1);
    this.rebuildAllSun();
    this.fillTexture(0, W - 1, 0, H - 1, 0, D - 1);
    this.texture.needsUpdate = true;
    this.built = true;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.buildMs = now - started;
    return this.buildMs;
  }

  // ------------------------------------------------------------------ sky
  rebuildSky(x0, x1, z0, z1) {
    const { W, H, cls, sky, queue } = this;
    let head = 0, tail = 0;
    // Columns: full sky straight down through clear cells, foliage and water dim it.
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        let level = LIGHT_MAX;
        for (let y = H - 1; y >= 0; y--) {
          const i = x + W * (y + H * z);
          const c = cls[i];
          if (c === OPAQUE) level = 0;
          else if (c === FOLIAGE) level = Math.max(0, level - 2);
          else if (c === WATER) level = Math.max(0, level - 1);
          sky[i] = level;
          if (level > 1) queue[tail++] = i;
        }
      }
    }
    // Light flowing in from outside the rebuilt region seeds the flood.
    const seedEdge = (x, z) => {
      if (x < 0 || z < 0 || x >= W || z >= this.D) return;
      for (let y = 0; y < H; y++) {
        const i = x + W * (y + H * z);
        if (sky[i] > 1) queue[tail++] = i;
      }
    };
    if (x0 > 0 || x1 < W - 1 || z0 > 0 || z1 < this.D - 1) {
      for (let z = z0 - 1; z <= z1 + 1; z++) { seedEdge(x0 - 1, z); seedEdge(x1 + 1, z); }
      for (let x = x0; x <= x1; x++) { seedEdge(x, z0 - 1); seedEdge(x, z1 + 1); }
    }
    this.flood(sky, null, queue, head, tail, x0, x1, z0, z1);
  }

  // ----------------------------------------------------------- block light
  rebuildBlock(x0, x1, z0, z1) {
    const { W, H, cls, block, hue, queue, getBlock } = this;
    let tail = 0;
    for (let z = z0; z <= z1; z++) {
      for (let y = 0; y < H; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = x + W * (y + H * z);
          block[i] = 0;
          this.emitter[i] = 0;
          // Portals are see-through yet glow, so only water skips the lookup.
          if (cls[i] === WATER) continue;
          const emitter = EMITTERS.get(getBlock(x, y, z));
          if (!emitter) continue;
          this.emitter[i] = 1;
          block[i] = emitter.level;
          hue[i] = Math.round(emitter.hue * 255);
          queue[tail++] = i;
        }
      }
    }
    for (const light of this.extraEmitters() || []) {
      const { x, y, z } = light;
      if (x < x0 || x > x1 || z < z0 || z > z1 || y < 0 || y >= H) continue;
      const i = x + W * (y + H * z);
      if (cls[i] === OPAQUE || light.level <= block[i]) continue;
      block[i] = light.level;
      hue[i] = Math.round(light.hue * 255);
      queue[tail++] = i;
    }
    const seedEdge = (x, z) => {
      if (x < 0 || z < 0 || x >= W || z >= this.D) return;
      for (let y = 0; y < H; y++) {
        const i = x + W * (y + H * z);
        if (block[i] > 1) queue[tail++] = i;
      }
    };
    if (x0 > 0 || x1 < W - 1 || z0 > 0 || z1 < this.D - 1) {
      for (let z = z0 - 1; z <= z1 + 1; z++) { seedEdge(x0 - 1, z); seedEdge(x1 + 1, z); }
      for (let x = x0; x <= x1; x++) { seedEdge(x, z0 - 1); seedEdge(x, z1 + 1); }
    }
    this.flood(block, hue, queue, 0, tail, x0, x1, z0, z1);
  }

  /** Breadth-first spread: each step into a clear neighbour costs one level. */
  flood(level, hue, queue, head, tail, x0, x1, z0, z1) {
    const { W, H, D, cls } = this;
    const capacity = queue.length;
    const push = (from, to, cost) => {
      const c = cls[to];
      if (c === OPAQUE) return;
      const next = level[from] - cost - (c === FOLIAGE ? 1 : 0);
      if (next <= level[to]) return;
      level[to] = next;
      if (hue) hue[to] = hue[from];
      if (next > 1 && tail - head < capacity) { queue[tail % capacity] = to; tail++; }
    };
    while (head < tail) {
      const i = queue[head % capacity]; head++;
      if (level[i] <= 1) continue;
      const x = i % W;
      const y = ((i / W) | 0) % H;
      const z = (i / (W * H)) | 0;
      if (x > 0 && x - 1 >= x0) push(i, i - 1, 1);
      if (x < W - 1 && x + 1 <= x1) push(i, i + 1, 1);
      if (z > 0 && z - 1 >= z0) push(i, i - W * H, 1);
      if (z < D - 1 && z + 1 <= z1) push(i, i + W * H, 1);
      if (y > 0) push(i, i - W, 1);
      if (y < H - 1) push(i, i + W, 1);
    }
  }

  // ------------------------------------------------------------------ sun
  /** Sheared column coordinate of a cell: every cell on one sun ray shares it. */
  sunColumnOf(x, y, z) {
    return [Math.round(x - this.shearX * y), Math.round(z - this.shearZ * y)];
  }

  rebuildAllSun() {
    const { W, H, D } = this;
    const uMin = Math.floor(Math.min(0, -this.shearX * (H - 1))) - 1;
    const uMax = Math.ceil(Math.max(W - 1, W - 1 - this.shearX * (H - 1))) + 1;
    const wMin = Math.floor(Math.min(0, -this.shearZ * (H - 1))) - 1;
    const wMax = Math.ceil(Math.max(D - 1, D - 1 - this.shearZ * (H - 1))) + 1;
    for (let w = wMin; w <= wMax; w++) for (let u = uMin; u <= uMax; u++) this.sweepSunColumn(u, w);
  }

  /** Walk one sun ray from the top of the map down, darkening behind occluders. */
  sweepSunColumn(u, w) {
    const { W, H, D, cls, sun, shearX, shearZ } = this;
    let lit = 255;
    for (let y = H - 1; y >= 0; y--) {
      const x = Math.round(u + shearX * y);
      const z = Math.round(w + shearZ * y);
      if (x < 0 || z < 0 || x >= W || z >= D) continue;
      const i = x + W * (y + H * z);
      const c = cls[i];
      if (c === OPAQUE) { sun[i] = 0; lit = 0; continue; }
      sun[i] = lit;
      if (c === FOLIAGE) lit = (lit * 0.45) | 0;
      else if (c === WATER) lit = (lit * 0.8) | 0;
    }
  }

  // ------------------------------------------------------------- texture
  /**
   * Opaque cells take the brightest open neighbour, so linear filtering across
   * a face never pulls light down towards a solid block's zero.
   */
  fillTexture(x0, x1, y0, y1, z0, z1) {
    const { W, H, D, cls, sky, sun, block, hue, data } = this;
    x0 = Math.max(0, x0); z0 = Math.max(0, z0); y0 = Math.max(0, y0);
    x1 = Math.min(W - 1, x1); z1 = Math.min(D - 1, z1); y1 = Math.min(H - 1, y1);
    const stepY = W, stepZ = W * H;
    for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) {
        let i = x0 + W * (y + H * z);
        for (let x = x0; x <= x1; x++, i++) {
          let s = sky[i], u = sun[i], b = block[i], h = hue[i];
          if (cls[i] === OPAQUE) {
            s = 0; u = 0;
            const take = (j) => {
              if (cls[j] === OPAQUE) return;
              if (sky[j] > s) s = sky[j];
              if (sun[j] > u) u = sun[j];
              if (block[j] > b) { b = block[j]; h = hue[j]; }
            };
            if (x > 0) take(i - 1);
            if (x < W - 1) take(i + 1);
            if (y > 0) take(i - stepY);
            if (y < H - 1) take(i + stepY);
            if (z > 0) take(i - stepZ);
            if (z < D - 1) take(i + stepZ);
          }
          const o = i * 4;
          data[o] = s * 17;
          data[o + 1] = u;
          data[o + 2] = b * 17;
          data[o + 3] = h;
        }
      }
    }
  }

  // --------------------------------------------------------------- deltas
  /** Record changed voxels; the rebuild runs in update() on a short cadence. */
  applyDeltas(deltas) {
    if (!this.built) return;
    for (const d of deltas) {
      const { x, y, z } = d;
      if (x < 0 || z < 0 || y < 0 || x >= this.W || z >= this.D || y >= this.H) continue;
      const i = this.index(x, y, z);
      const next = lightClass(this.getBlock(x, y, z));
      const emitterChanged = EMITTERS.has(d.v) || this.emitter[i] === 1;
      if (next === this.cls[i] && !emitterChanged) continue;
      this.cls[i] = next;
      const p = this.pending ||= { x0: x, x1: x, z0: z, z1: z };
      p.x0 = Math.min(p.x0, x); p.x1 = Math.max(p.x1, x);
      p.z0 = Math.min(p.z0, z); p.z1 = Math.max(p.z1, z);
      const [u, w] = this.sunColumnOf(x, y, z);
      this.sunColumns.add(`${u},${w}`);
    }
  }

  /** Emitters outside the voxel data (map lamps) changed: rebuild their neighbourhood. */
  touchEmitters(cells) {
    for (const { x, z } of cells) {
      const p = this.pending ||= { x0: x, x1: x, z0: z, z1: z };
      p.x0 = Math.min(p.x0, x); p.x1 = Math.max(p.x1, x);
      p.z0 = Math.min(p.z0, z); p.z1 = Math.max(p.z1, z);
    }
  }

  /**
   * Drain pending changes at most every `intervalMs`; returns true when the
   * texture was re-uploaded. Big blasts fold into one rebuild.
   */
  update(nowMs, intervalMs = 120) {
    if (!this.pending && !this.sunColumns.size) return false;
    if (nowMs - this.lastUpload < intervalMs) return false;
    this.flush();
    this.lastUpload = nowMs;
    return true;
  }

  flush() {
    const { W, H, D } = this;
    let fx0 = W, fx1 = -1, fz0 = D, fz1 = -1;
    if (this.pending) {
      const { x0, x1, z0, z1 } = this.pending;
      const rx0 = Math.max(0, x0 - REACH), rx1 = Math.min(W - 1, x1 + REACH);
      const rz0 = Math.max(0, z0 - REACH), rz1 = Math.min(D - 1, z1 + REACH);
      this.rebuildSky(rx0, rx1, rz0, rz1);
      this.rebuildBlock(rx0, rx1, rz0, rz1);
      fx0 = rx0; fx1 = rx1; fz0 = rz0; fz1 = rz1;
      this.pending = null;
    }
    for (const key of this.sunColumns) {
      const [u, w] = key.split(',').map(Number);
      this.sweepSunColumn(u, w);
      for (const y of [0, H - 1]) {
        const x = Math.round(u + this.shearX * y), z = Math.round(w + this.shearZ * y);
        fx0 = Math.min(fx0, x); fx1 = Math.max(fx1, x);
        fz0 = Math.min(fz0, z); fz1 = Math.max(fz1, z);
      }
    }
    this.sunColumns.clear();
    if (fx1 >= fx0 && fz1 >= fz0) {
      this.fillTexture(fx0 - 1, fx1 + 1, 0, H - 1, fz0 - 1, fz1 + 1);
      this.texture.needsUpdate = true;
      this.uploads++;
    }
  }

  /** Trilinear CPU sample for props, avatars and the viewmodel: {sky,sun,block,hue} 0..1. */
  sample(x, y, z, out = { sky: 1, sun: 1, block: 0, hue: 0 }) {
    if (!this.built) { out.sky = 1; out.sun = 1; out.block = 0; out.hue = 0; return out; }
    const { W, H, D, data } = this;
    const fx = Math.max(0, Math.min(W - 1.001, x - 0.5));
    const fy = Math.max(0, Math.min(H - 1.001, y - 0.5));
    const fz = Math.max(0, Math.min(D - 1.001, z - 0.5));
    const x0 = fx | 0, y0 = fy | 0, z0 = fz | 0;
    const tx = fx - x0, ty = fy - y0, tz = fz - z0;
    let sky = 0, sun = 0, block = 0, hue = 0, hueWeight = 0;
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = c >> 2;
      const wgt = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz);
      const o = ((x0 + dx) + W * ((y0 + dy) + H * (z0 + dz))) * 4;
      sky += data[o] * wgt; sun += data[o + 1] * wgt; block += data[o + 2] * wgt;
      hue += data[o + 3] * data[o + 2] * wgt; hueWeight += data[o + 2] * wgt;
    }
    out.sky = sky / 255; out.sun = sun / 255; out.block = block / 255;
    out.hue = hueWeight > 0 ? hue / hueWeight / 255 : 0;
    return out;
  }

  dispose() {
    this.texture.dispose();
  }
}

// ------------------------------------------------------------------ shaders

/** Shared uniforms; a 1-cell full-sky texture stands in until a volume binds. */
export function createVoxelLightUniforms() {
  const fallback = new THREE.Data3DTexture(new Uint8Array([255, 255, 0, 0]), 1, 1, 1);
  fallback.needsUpdate = true;
  return {
    voxelLightMap: { value: fallback },
    voxelLightSize: { value: new THREE.Vector3(1, 1, 1) },
    // x: sky floor, y: sky falloff base, z: block light strength, w: sun shadow strength
    voxelLightParams: { value: new THREE.Vector4(0.5, 0.93, 1.6, 1) },
    // Extra exposure an enclosed viewpoint gives indirect light (0: none).
    voxelLightView: { value: 0 },
    _fallback: fallback,
  };
}

/**
 * Static eye adaptation for tiers without it (LDR: no float luminance). From
 * inside a fully enclosed spot, indirect light gains up to this share on top;
 * the gain follows the sky level at the camera, so the whole view brightens
 * together and occlusion contrast inside the frame is kept.
 */
export const LDR_VIEW_EXPOSURE = 0.9;

/**
 * shadow < 1 lets a little sun through baked shadows: shade reads as depth,
 * never as a black hole a player can hide in. `adaptation: false` (tiers
 * without eye adaptation) turns on LDR_VIEW_EXPOSURE; uniform values only.
 */
export function bindVoxelLightVolume(uniforms, volume, {
  minSky = 0.5, falloff = 0.93, blockStrength = 1.6, shadow = 0.75, adaptation = true,
} = {}) {
  uniforms.voxelLightMap.value = volume.texture;
  uniforms.voxelLightSize.value.set(volume.W, volume.H, volume.D);
  uniforms.voxelLightParams.value.set(minSky, falloff, blockStrength, shadow);
  if (uniforms.voxelLightView) uniforms.voxelLightView.value = 0;
  uniforms._viewExposureMax = adaptation ? 0 : LDR_VIEW_EXPOSURE;
}

const _viewSample = { sky: 1, sun: 1, block: 0, hue: 0 };
/**
 * Ease the LDR view exposure towards the sky openness at the camera: about a
 * third of a second to adapt, dt 0 snaps (captures, first frame).
 */
export function updateViewExposure(uniforms, volume, position, dt) {
  const max = uniforms._viewExposureMax || 0;
  if (!uniforms.voxelLightView || !max || !volume?.built || !position) return;
  const open = volume.sample(position.x, position.y, position.z, _viewSample).sky;
  const t = Math.max(0, Math.min(1, (open - 0.3) / 0.65));
  const target = max * (1 - t * t * (3 - 2 * t));
  const k = dt > 0 ? 1 - Math.exp(-dt * 3) : 1;
  uniforms.voxelLightView.value += (target - uniforms.voxelLightView.value) * k;
}

export const VOXEL_LIGHT_PARS = /* glsl */ `
uniform highp sampler3D voxelLightMap;
uniform vec3 voxelLightSize;
uniform vec4 voxelLightParams;
uniform float voxelLightView;
// Extra exposure of the current viewpoint, 0 in the open. The CPU samples the
// sky level at the camera and eases it (updateViewExposure), so walking
// through a doorway brightens over a moment instead of popping.
float voxelViewExposure() {
  return 1.0 + max(voxelLightView, 0.0);
}
vec3 voxelBlockColor(float hue) {
  vec3 c = mix(vec3(0.55, 0.9, 1.0), vec3(1.0, 0.82, 0.58), smoothstep(0.0, 0.33, hue));
  c = mix(c, vec3(1.0, 0.5, 0.16), smoothstep(0.4, 0.66, hue));
  return mix(c, vec3(0.7, 0.34, 1.0), smoothstep(0.7, 1.0, hue));
}
// x: sky multiplier on indirect light, y: sun visibility, rgb block light in zw->
struct VoxelLight { float sky; float open; float sun; vec3 block; };
VoxelLight voxelLightAt(vec3 worldPos, vec3 worldNormal) {
  vec3 p = (worldPos + worldNormal * 0.5) / voxelLightSize;
  vec4 L = texture(voxelLightMap, p);
  // Beyond the map's sides or above its top there is only open sky.
  float outside = step(1.0, p.y) + step(p.x, 0.0) + step(1.0, p.x) + step(p.z, 0.0) + step(1.0, p.z);
  L.rg = mix(L.rg, vec2(1.0), min(outside, 1.0));
  VoxelLight light;
  light.open = L.r;
  light.sky = max(voxelLightParams.x, pow(voxelLightParams.y, 15.0 * (1.0 - L.r)));
  light.sun = mix(1.0, L.g, voxelLightParams.w);
  // Squared falloff keeps lamps tight: a pool of light, not a flat wash.
  light.block = voxelBlockColor(L.a) * L.b * L.b * voxelLightParams.z;
  return light;
}
`;

/** Inserted just before lights_fragment_begin; expects vVoxelWorld/vVoxelNormal. */
export const VOXEL_LIGHT_SAMPLE = /* glsl */ `
VoxelLight voxelLight = voxelLightAt(vVoxelWorld, normalize(vVoxelNormal));
`;

/** lights_fragment_begin with the sun (the only directional light) shadowed. */
export function voxelLightsFragmentBegin() {
  const chunk = THREE.ShaderChunk.lights_fragment_begin;
  const hook = 'getDirectionalLightInfo( directionalLight, directLight );';
  if (!chunk.includes(hook)) throw new Error('voxel-light: lights_fragment_begin hook missing');
  // The dynamic-caster shadow map (High/Ultra) combines with the baked sun as
  // min(), not a product: an avatar's shadow inside a building's shade must not
  // darken it twice. color * sun * min(1, map / sun) == color * min(sun, map).
  const dirShadow = 'getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] )';
  return chunk.replace(hook, `${hook}\n\t\tdirectLight.color *= voxelLight.sun;`)
    .replace(dirShadow, `min( 1.0, ${dirShadow} / max( voxelLight.sun, 0.05 ) )`);
}

/**
 * Replaces aomap_fragment: sky (and, without eye adaptation, the viewpoint's
 * exposure) scales indirect light, block light adds to it.
 */
export const VOXEL_LIGHT_MODULATE = /* glsl */ `
#include <aomap_fragment>
#if NUM_HEMI_LIGHTS > 0
  // Enclosed space has no sky above and no ground below: the hemisphere gives
  // way to a neutral bounce as the sky closes. The bounce keeps a Minecraft-
  // style cue by world normal, relative to the hemisphere's mean: floors catch
  // the light that enters through the openings (4.2), walls much less (0.83),
  // ceilings least (0.62), with the mesher's FACE_SHADE on top. A fifth of the
  // hemisphere always stays; minSky (voxelLight.sky) sets the room floor.
  vec3 voxelHemiAvg = ( hemisphereLights[ 0 ].skyColor + hemisphereLights[ 0 ].groundColor ) * 0.5;
  float voxelUp = normalize( vVoxelNormal ).y;
  float voxelFace = mix( 0.83, voxelUp > 0.0 ? 4.2 : 0.62, abs( voxelUp ) );
  vec3 voxelBounce = BRDF_Lambert( diffuseColor.rgb )
    * ( dot( voxelHemiAvg, vec3( 0.2126, 0.7152, 0.0722 ) ) * voxelFace );
  reflectedLight.indirectDiffuse = mix( voxelBounce, reflectedLight.indirectDiffuse, max( 0.2, smoothstep( 0.35, 1.0, voxelLight.open ) ) );
#endif
float voxelExposure = voxelViewExposure();
reflectedLight.indirectDiffuse *= voxelLight.sky * voxelExposure;
reflectedLight.indirectSpecular *= voxelLight.sky * voxelExposure;
reflectedLight.indirectDiffuse += BRDF_Lambert( diffuseColor.rgb ) * voxelLight.block;
`;

/**
 * Opt a stock Lambert/Standard material into the light volume. World position
 * and normal come from the model (and instance) matrices, so props, bastion
 * structures and details share the terrain's shadows and sky occlusion.
 */
export function patchVoxelLitMaterial(material, uniforms, key = 'voxel-lit') {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    Object.assign(shader.uniforms, {
      voxelLightMap: uniforms.voxelLightMap,
      voxelLightSize: uniforms.voxelLightSize,
      voxelLightParams: uniforms.voxelLightParams,
      voxelLightView: uniforms.voxelLightView,
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vVoxelWorld;\nvarying vec3 vVoxelNormal;')
      .replace('#include <project_vertex>', `#include <project_vertex>
  vec4 voxelWorld = vec4( transformed, 1.0 );
  vec3 voxelNormal = objectNormal;
  #ifdef USE_INSTANCING
    voxelWorld = instanceMatrix * voxelWorld;
    voxelNormal = mat3( instanceMatrix ) * voxelNormal;
  #endif
  voxelWorld = modelMatrix * voxelWorld;
  vVoxelWorld = voxelWorld.xyz;
  vVoxelNormal = normalize( mat3( modelMatrix ) * voxelNormal );`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vVoxelWorld;\nvarying vec3 vVoxelNormal;\n${VOXEL_LIGHT_PARS}`)
      .replace('#include <lights_fragment_begin>', `${VOXEL_LIGHT_SAMPLE}\n${voxelLightsFragmentBegin()}`)
      .replace('#include <aomap_fragment>', VOXEL_LIGHT_MODULATE);
  };
  const previousKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${previousKey ? previousKey() : ''}|${key}`;
  material.needsUpdate = true;
  return material;
}
