// Voxel light volume: one RGBA8 light cell per voxel (arena maps) or per
// 2 x 2 x 2 / 4 x 4 x 4 voxels (large worlds), sampled per fragment.
//   R  sky light 0..15   Minecraft-style flood: full down open columns, -1 per
//                        metre sideways, so roofs, galleries and tunnels darken
//   G  sun visibility    a ray to the sun, swept once along sheared columns;
//                        every roof, wall and tree casts a cell-exact shadow
//   B  block light 0..15 glowstone, lava, portals and map lamps
//   A  block light hue   palette coordinate of the brightest emitter
// Everything is baked at load (large worlds in a module worker, see
// voxel-light-worker.js) and patched locally after block deltas, then uploaded
// as a Data3DTexture; patches upload only the changed box. The cell size lives
// in the voxelLightSize uniform (texture cells x cell = world extent), so the
// GPU cost is one 3D texture fetch per fragment on the materials that opt in;
// no light count, shadow map, define or program key ever changes in a match.

import * as THREE from '../vendor/three.module.js';
import {
  LIGHT_MAX, LIGHT_HUE, LIGHT_EMITTERS as EMITTERS, lightClass,
  classifyLightCell, classifyLightRows,
  createLightState, rebuildSky, rebuildBlock, rebuildAllSun, sweepSunColumn, fillTexture, bakeLightState,
} from './voxel-light-worker.js';

export { LIGHT_MAX };
/** Horizontal reach (in light cells) of any light change; region rebuilds cover this radius. */
const REACH = LIGHT_MAX + 1;

export { LIGHT_HUE, lightClass };

/** Brightness of a sky level with the per-map floor, matching the shader. */
export function skyBrightness(level, minSky = 0.5, base = 0.93) {
  return Math.max(minSky, Math.pow(base, LIGHT_MAX - Math.max(0, Math.min(LIGHT_MAX, level))));
}

/** Light cell size for a large world: 2 voxels, 4 on Low, grown until the GPU takes the volume. */
export function largeWorldLightCell(dimensions, { tier = 'medium', max3DTextureSize = 2048 } = {}) {
  let cell = tier === 'low' ? 4 : 2;
  const limit = Math.max(64, max3DTextureSize | 0 || 256);
  while (Math.ceil(Math.max(dimensions.sx, dimensions.sy, dimensions.sz) / cell) > limit) cell *= 2;
  return cell;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// A module worker only starts once the main thread can serve its script
// load: posted from inside a long synchronous build it idled ~0.35 s. A
// worker started ahead of the WorldView is already running when the bake posts.
let spareWorker = null;
const newLightWorker = () => new Worker(new URL('./voxel-light-worker.js', import.meta.url), { type: 'module', name: 'voxel-light' });

/** Start the bake worker ahead of a large-world load (the next bake takes it). */
// A load error (script or import failed to fetch) can fire before a bake
// takes the worker and attaches its own handlers: the prewarm handler marks
// the spare as dead, so the bake starts a fresh worker instead of posting to
// one that never answers.
export function prewarmLightWorker() {
  if (spareWorker || typeof Worker !== 'function') return false;
  try {
    const worker = newLightWorker();
    worker.onerror = (event) => {
      event.preventDefault?.();
      worker.terminate();
      if (spareWorker === worker) spareWorker = null;
    };
    spareWorker = worker;
  } catch { spareWorker = null; }
  return !!spareWorker;
}

/** Take the prewarmed worker (if it is still alive) or start a new one. */
function takeLightWorker() {
  const worker = spareWorker || newLightWorker();
  spareWorker = null;
  return worker;
}
export class VoxelLightVolume {
  /**
   * @param getBlock live voxel getter (x,y,z)->id
   * @param {{sx:number,sy:number,sz:number}} dims map extents
   * @param {{sunDir?:THREE.Vector3, emitters?:()=>Array<{x,y,z,level,hue}>, cell?:number,
   *   renderer?:THREE.WebGLRenderer, worker?:boolean, voxels?:()=>({blocks:Uint8Array,dimensions:object}|null)}} options
   *   cell is the light cell edge in voxels (1 on arena maps); renderer enables sub-box
   *   texture uploads for patches; voxels returns the raw y/z/x array behind getBlock
   *   (or null), which lets the async bake classify in its worker as well.
   */
  constructor(getBlock, dims, {
    sunDir = new THREE.Vector3(60, 90, 20).normalize(), emitters = () => [], cell = 1, renderer = null, worker = true,
    voxels = null,
  } = {}) {
    if (!Number.isInteger(cell) || cell < 1) throw new RangeError('VoxelLightVolume cell must be a positive integer');
    this.getBlock = getBlock;
    this.dims = { sx: dims.sx, sy: dims.sy, sz: dims.sz };
    this.cell = cell;
    this.W = Math.ceil(dims.sx / cell); this.H = Math.ceil(dims.sy / cell); this.D = Math.ceil(dims.sz / cell);
    this.N = this.W * this.H * this.D;
    this.extraEmitters = emitters;
    this.renderer = renderer;
    this.useWorker = worker;
    this.voxelSource = typeof voxels === 'function' ? voxels : null;
    const dir = sunDir.clone().normalize();
    // Guard against a sun at the horizon: the sweep walks one layer per step.
    // The shear is a ratio, so it is the same in voxels and in light cells.
    this.shearX = dir.x / Math.max(dir.y, 0.35);
    this.shearZ = dir.z / Math.max(dir.y, 0.35);
    this.state = null;
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
    this.partialUploads = 0;
    this.built = false;
    this.disposed = false;
    this.buildMs = 0; this.classifyMs = 0; this.bakeMs = 0; this.bakeMode = null;
  }

  /** World extent covered by the light cells (the voxelLightSize uniform). */
  get extent() { return [this.W * this.cell, this.H * this.cell, this.D * this.cell]; }

  index(x, y, z) { return x + this.W * (y + this.H * z); }

  // ------------------------------------------------------------ classify
  /**
   * Class byte of one light cell from its voxels (classifyLightCell in
   * voxel-light-worker.js). Records voxel emitters.
   */
  classifyCell(cx, cy, cz, emitters) {
    return classifyLightCell(this, cx, cy, cz, emitters);
  }

  /** Classify light-cell slabs [cz0, cz1); returns the number of cells written. */
  classifyRows(cz0, cz1) {
    const s = this.state;
    return classifyLightRows(this, s.cls, s.emitters, cz0, cz1);
  }

  ensureState() {
    if (this.state) return this.state;
    this.state = createLightState({
      W: this.W, H: this.H, D: this.D, cell: this.cell, shearX: this.shearX, shearZ: this.shearZ, data: this.data,
    });
    return this.state;
  }

  /** Map lamps (voxel coordinates) as light-cell emitters. */
  extraCells() {
    const out = [];
    for (const light of this.extraEmitters?.() || []) {
      out.push({ x: Math.floor(light.x / this.cell), y: Math.floor(light.y / this.cell),
        z: Math.floor(light.z / this.cell), level: light.level, hue: light.hue });
    }
    return out;
  }

  /** Full synchronous bake. Returns elapsed milliseconds. */
  build() {
    const started = now();
    const s = this.ensureState();
    this.classifyRows(0, this.D);
    const classified = now();
    s.extra = this.extraCells();
    bakeLightState(s);
    this.finishBuild(started, classified, 'main');
    return this.buildMs;
  }

  /**
   * Bake without blocking the page: classify in slabs between `yieldControl`
   * calls, then flood and sweep in a module worker. Falls back to the main
   * thread where workers are unavailable (Node, old browsers) or fail.
   */
  async buildAsync({ yieldControl = null, isActive = () => true, sliceMs = 24, classifyInWorker = true } = {}) {
    const started = now();
    const s = this.ensureState();
    // Classify in the worker from a copy of the raw voxels when the store
    // exposes them: the main thread only pays the copy. Changes after the
    // copy replay as late cells (applyDeltas) like during any async bake.
    const voxels = classifyInWorker && this.useWorker && typeof Worker === 'function' ? this.rawVoxels() : null;
    if (voxels) {
      try {
        s.extra = this.extraCells();
        await this.bakeInWorker(s, voxels.slice());
        if (this.disposed) return this.buildMs;
        this.finishBuild(started, started, 'worker-classify');
        return this.buildMs;
      } catch (error) {
        console.warn('[vb] light classify worker failed; classifying on the main thread', error);
        if (this.disposed) return this.buildMs;
        this.state = null;
        this.data = new Uint8Array(this.N * 4);
        this.texture.image.data = this.data;
        return this.buildAsync({ yieldControl, isActive, sliceMs, classifyInWorker: false });
      }
    }
    if (!await this.classifySliced({ yieldControl, isActive, sliceMs })) return this.buildMs;
    const classified = now();
    s.extra = this.extraCells();
    let mode = 'main';
    if (this.useWorker && typeof Worker === 'function') {
      try {
        await this.bakeInWorker(s);
        mode = 'worker';
      } catch (error) {
        console.warn('[vb] light bake worker failed; baking on the main thread', error);
        if (this.disposed) return this.buildMs;
        // The transferred arrays are gone with the worker: start the grid over.
        this.state = null;
        this.data = new Uint8Array(this.N * 4);
        this.texture.image.data = this.data;
        const retry = this.ensureState();
        if (!await this.classifySliced({ yieldControl, isActive, sliceMs })) return this.buildMs;
        retry.extra = this.extraCells();
        bakeLightState(retry);
      }
    } else {
      bakeLightState(s);
    }
    if (this.disposed) return this.buildMs;
    this.finishBuild(started, classified, mode);
    return this.buildMs;
  }

  /** Classify every slab, yielding between slices; false when the bake was abandoned. */
  async classifySliced({ yieldControl = null, isActive = () => true, sliceMs = 24 } = {}) {
    let slice = now();
    for (let cz = 0; cz < this.D; cz++) {
      this.classifyRows(cz, cz + 1);
      if (yieldControl && now() - slice > sliceMs) {
        await yieldControl();
        if (!isActive() || this.disposed) return false;
        slice = now();
      }
    }
    return true;
  }

  /** The raw voxel array behind getBlock when the store exposes one of this volume's extent. */
  rawVoxels() {
    let source = null;
    try { source = this.voxelSource?.() || null; } catch { source = null; }
    const { sx, sy, sz } = this.dims;
    const d = source?.dimensions;
    return source?.blocks instanceof Uint8Array && source.blocks.length === sx * sy * sz
      && d?.sx === sx && d?.sy === sy && d?.sz === sz ? source.blocks : null;
  }

  /** Bake `s` in a module worker; with `blocks` (a disposable copy) the worker classifies too. */
  bakeInWorker(s, blocks = null) {
    let postedAt = performance.timeOrigin + performance.now();
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = takeLightWorker();
      } catch (error) { reject(error); return; }
      const finish = (error, message) => {
        worker.terminate();
        if (error) { reject(error); return; }
        // The arrays come back transferred; rebind them to the live state.
        s.cls = message.cls; s.sky = message.sky; s.sun = message.sun; s.block = message.block; s.hue = message.hue;
        s.data = message.data;
        if (Array.isArray(message.emitters)) s.emitters = new Map(message.emitters);
        this.data = message.data;
        this.texture.image.data = message.data;
        this.workerMs = message.ms;
        this.workerClassifyMs = message.classifyMs ?? 0;
        // Start-up (post to first worker work) and reply (worker done to here) latency.
        if (Number.isFinite(message.startedAt)) {
          const at = performance.timeOrigin + performance.now();
          this.workerStartMs = message.startedAt - postedAt;
          this.workerReplyMs = at - message.finishedAt;
        }
        resolve();
      };
      worker.onmessage = (event) => {
        if (event.data?.type === 'baked') finish(null, event.data);
        else finish(new Error(event.data?.message || 'light bake failed'));
      };
      worker.onerror = (event) => { event.preventDefault?.(); finish(new Error(event.message || 'light worker error')); };
      const state = { W: s.W, H: s.H, D: s.D, cell: s.cell, shearX: s.shearX, shearZ: s.shearZ,
        cls: s.cls, data: s.data, emitters: [...s.emitters], extra: s.extra };
      // Transfer the class grid and texture bytes: nothing is copied twice.
      const voxels = blocks ? { blocks, sx: this.dims.sx, sy: this.dims.sy, sz: this.dims.sz } : null;
      postedAt = performance.timeOrigin + performance.now();
      worker.postMessage({ type: 'bake', id: 1, state, ...(voxels ? { voxels } : {}) },
        blocks ? [s.cls.buffer, s.data.buffer, blocks.buffer] : [s.cls.buffer, s.data.buffer]);
      s.cls = null; s.data = null;
    });
  }

  finishBuild(started, classified, mode) {
    this.texture.needsUpdate = true;
    this.built = true;
    const done = now();
    this.classifyMs = classified - started;
    this.bakeMs = done - classified;
    this.buildMs = done - started;
    this.bakeMode = mode;
    this.lateReplayed = this.replayLateCells();
  }

  // --------------------------------------------------------------- deltas
  /**
   * Record changed voxels; the rebuild runs in update() on a short cadence.
   * Deltas that land while a bake is still running (a live match keeps
   * destroying blocks during the async large-world bake) are kept and
   * replayed once the bake finishes: a cell classified before its change would
   * otherwise keep stale light for the rest of the match.
   */
  applyDeltas(deltas) {
    if (this.disposed) return;
    const { cell } = this;
    const { sx, sy, sz } = this.dims;
    const late = !this.built || !this.state;
    for (const d of deltas) {
      const { x, y, z } = d;
      if (x < 0 || z < 0 || y < 0 || x >= sx || z >= sz || y >= sy) continue;
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
      if (late) (this.lateCells ||= new Set()).add(this.index(cx, cy, cz));
      else this.reclassifyCell(cx, cy, cz, EMITTERS.has(d.v));
    }
  }

  /** Re-derive one light cell from the live voxels; queue its region and sun column when it changed. */
  reclassifyCell(cx, cy, cz, emitterTouched = false) {
    const s = this.state;
    const i = this.index(cx, cy, cz);
    const hadEmitter = s.emitters.has(i);
    const previous = s.emitters.get(i);
    const next = this.classifyCell(cx, cy, cz, s.emitters);
    const emitterChanged = hadEmitter !== s.emitters.has(i) || previous !== s.emitters.get(i) || emitterTouched;
    if (next === s.cls[i] && !emitterChanged) return false;
    s.cls[i] = next;
    this.markPending(cx, cz);
    const u = Math.round(cx - this.shearX * cy), w = Math.round(cz - this.shearZ * cy);
    this.sunColumns.add(`${u},${w}`);
    return true;
  }

  /** Replay cells changed during the bake against the finished state (next update() patches them). */
  replayLateCells() {
    const late = this.lateCells;
    this.lateCells = null;
    if (!late?.size || !this.state) return 0;
    const { W, H } = this;
    let changed = 0;
    for (const i of late) {
      const cx = i % W, cy = ((i / W) | 0) % H, cz = (i / (W * H)) | 0;
      if (this.reclassifyCell(cx, cy, cz)) changed++;
    }
    return changed;
  }

  markPending(cx, cz) {
    const p = this.pending ||= { x0: cx, x1: cx, z0: cz, z1: cz };
    p.x0 = Math.min(p.x0, cx); p.x1 = Math.max(p.x1, cx);
    p.z0 = Math.min(p.z0, cz); p.z1 = Math.max(p.z1, cz);
  }

  /** Emitters outside the voxel data (map lamps) changed: rebuild their neighbourhood. */
  touchEmitters(cells) {
    for (const { x, z } of cells) this.markPending(Math.floor(x / this.cell), Math.floor(z / this.cell));
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
    if (!this.state) { this.pending = null; this.sunColumns.clear(); return; }
    const s = this.state;
    const { W, H, D } = this;
    let fx0 = W, fx1 = -1, fz0 = D, fz1 = -1;
    if (this.pending) {
      const { x0, x1, z0, z1 } = this.pending;
      const rx0 = Math.max(0, x0 - REACH), rx1 = Math.min(W - 1, x1 + REACH);
      const rz0 = Math.max(0, z0 - REACH), rz1 = Math.min(D - 1, z1 + REACH);
      s.extra = this.extraCells();
      rebuildSky(s, rx0, rx1, rz0, rz1);
      rebuildBlock(s, rx0, rx1, rz0, rz1);
      fx0 = rx0; fx1 = rx1; fz0 = rz0; fz1 = rz1;
      this.pending = null;
    }
    for (const key of this.sunColumns) {
      const [u, w] = key.split(',').map(Number);
      sweepSunColumn(s, u, w);
      for (const y of [0, H - 1]) {
        const x = Math.round(u + this.shearX * y), z = Math.round(w + this.shearZ * y);
        fx0 = Math.min(fx0, x); fx1 = Math.max(fx1, x);
        fz0 = Math.min(fz0, z); fz1 = Math.max(fz1, z);
      }
    }
    this.sunColumns.clear();
    if (fx1 >= fx0 && fz1 >= fz0) {
      const box = {
        x0: Math.max(0, fx0 - 1), x1: Math.min(W - 1, fx1 + 1),
        z0: Math.max(0, fz0 - 1), z1: Math.min(D - 1, fz1 + 1),
      };
      fillTexture(s, box.x0, box.x1, 0, H - 1, box.z0, box.z1);
      this.upload(box);
      this.uploads++;
    }
  }

  /**
   * Upload a changed box: a sub-box copy once the texture lives on the GPU
   * (a blast never re-sends the whole large-world volume), else a full upload.
   */
  upload(box) {
    const renderer = this.renderer;
    const texture = this.texture;
    const live = renderer?.properties?.has?.(texture) && renderer.properties.get(texture)?.__version === texture.version;
    const cells = (box.x1 - box.x0 + 1) * this.H * (box.z1 - box.z0 + 1);
    if (!live || typeof renderer.copyTextureToTexture !== 'function' || cells * 2 > this.N) {
      texture.needsUpdate = true;
      return;
    }
    const w = box.x1 - box.x0 + 1, d = box.z1 - box.z0 + 1, H = this.H, W = this.W;
    const patch = new Uint8Array(w * H * d * 4);
    for (let z = 0; z < d; z++) for (let y = 0; y < H; y++) {
      const from = ((box.x0) + W * (y + H * (box.z0 + z))) * 4;
      patch.set(this.data.subarray(from, from + w * 4), (w * (y + H * z)) * 4);
    }
    const source = new THREE.Data3DTexture(patch, w, H, d);
    source.format = texture.format; source.type = texture.type; source.unpackAlignment = 1;
    try {
      renderer.copyTextureToTexture(source, texture, null, new THREE.Vector3(box.x0, 0, box.z0));
      this.partialUploads++;
    } catch {
      texture.needsUpdate = true;
    } finally {
      source.dispose();
    }
  }

  /** Trilinear CPU sample for props, avatars and the viewmodel: {sky,sun,block,hue} 0..1. */
  sample(x, y, z, out = { sky: 1, sun: 1, block: 0, hue: 0 }) {
    if (!this.built) { out.sky = 1; out.sun = 1; out.block = 0; out.hue = 0; return out; }
    const { W, H, D, data, cell } = this;
    const fx = Math.max(0, Math.min(W - 1.001, x / cell - 0.5));
    const fy = Math.max(0, Math.min(H - 1.001, y / cell - 0.5));
    const fz = Math.max(0, Math.min(D - 1.001, z / cell - 0.5));
    // Above the volume there is only open sky.
    if (y >= H * cell) { out.sky = 1; out.sun = 1; out.block = 0; out.hue = 0; return out; }
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

  get stats() {
    return { cell: this.cell, cells: [this.W, this.H, this.D], bytes: this.N * 4, built: this.built,
      buildMs: this.buildMs, classifyMs: this.classifyMs, bakeMs: this.bakeMs, mode: this.bakeMode,
      uploads: this.uploads, partialUploads: this.partialUploads, lateReplayed: this.lateReplayed || 0 };
  }

  dispose() {
    this.disposed = true;
    this.texture.dispose();
    this.state = null;
  }
}

export class OutdoorLightVolume {
  constructor() {
    this.W = this.H = this.D = 1;
    this.data = new Uint8Array([255, 255, 0, 0]);
    this.texture = new THREE.Data3DTexture(this.data, 1, 1, 1);
    this.texture.needsUpdate = true;
    this.built = false;
  }
  build() { this.built = true; return 0; }
  applyDeltas() {}
  touchEmitters() {}
  update() {}
  flush() {}
  sample(x, y, z, out = {}) { out.sky = out.sun = 1; out.block = out.hue = 0; return out; }
  dispose() { this.texture.dispose(); }
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
  // Texture cells x cell size: the world extent the volume covers. A coarse
  // large-world volume differs from an arena volume only in this uniform.
  const [ex, ey, ez] = volume.extent || [volume.W, volume.H, volume.D];
  uniforms.voxelLightSize.value.set(ex, ey, ez);
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
