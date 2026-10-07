import * as THREE from '../vendor/three.module.js';
import { DistantVoxelShell, materialColor } from './distant-voxel-shell.js';
import { patchVoxelLitMaterial } from './voxel-light.js';
import { AIR } from '../../../shared/worlddata.js';
import * as BLOCKS from '../../../shared/world/blocks.js';

const STRIDE = 9, INDICES = 36;
/** Steepness (height change per metre) at which a slope is fully rock-shaded. */
const STEEP = 1.2;
/** Neighbourhood (in shell cells) whose lowest ground bounds the distant shell. */
const SHELL_FLOOR_RADIUS = 3;

// Materials a natural ground column is built from (Frontier terrain fill and
// surfaces, arena ground). The probe climbs only through these, so towers,
// walls, trunks and chimneys standing on the ground never lift the far mesh
// into tents; they stay in the distant shell.
export const FAR_GROUND_IDS = new Set([
  'GRASS', 'DIRT', 'STONE', 'SAND', 'BEDROCK', 'DUST_ROCK', 'MC_GRASS', 'MC_DIRT', 'MC_STONE', 'MC_SAND', 'MC_GRAVEL',
  'MC_CLAY', 'MC_WATER', 'BB_SAND', 'MEADOW', 'DRY_GRASS', 'FIELD_WHEAT', 'MUD', 'SCORCHED_EARTH', 'GRAVEL', 'PINE_NEEDLES',
].map(name => BLOCKS[name]).filter(Number.isInteger));
// Paving (pads, roads, the village square) is ground only as a column's top
// layer; stacked, it is a structure (a foundation, a chimney base).
export const FAR_PAVING_IDS = new Set(['CONCRETE', 'ASPHALT', 'MC_COBBLE'].map(name => BLOCKS[name]).filter(Number.isInteger));
const GROUND = FAR_GROUND_IDS, PAVING = FAR_PAVING_IDS;

/**
 * One merged distant terrain draw. Every tile samples the authoritative voxel
 * surface (the top of the natural ground column, so roofs, bridges, towers and
 * trees never lift the ground into ramps or tents), colours it with the
 * surface block's atlas painter
 * averages as the detailed chunks, and shades slopes from the sampled relief.
 * Tile holes follow completed detailed chunks, so an unloaded or pending chunk
 * always retains a coarse visible surface. The distant voxel shell above it
 * keeps structures and silhouettes but skips the bulk terrain this mesh draws.
 */
export class FarTerrain {
  /**
   * @param {{step?:number, silhouetteStep?:number|null, groundHeight?:number|null,
   *   surfaceHint?:((x:number,z:number)=>number)|null, lightUniforms?:object|null}} options
   *   groundHeight: y the ground probe starts below (nominal ground level); surfaceHint:
   *   authored terrain top per column (frontierSurfaceY) that seeds the probe;
   *   lightUniforms: voxel light volume uniforms (sun shadows and sky on far ground).
   */
  constructor(scene, getBlock, dimensions, {
    step = 16, silhouetteStep = null, groundHeight = null, surfaceHint = null, lightUniforms = null,
  } = {}) {
    if (!Number.isInteger(step) || step <= 0 || 16 % step !== 0) throw new RangeError('FarTerrain step must divide a 16m detail chunk');
    this.scene = scene; this.getBlock = getBlock; this.dimensions = dimensions;
    this.step = step;
    this.groundHeight = groundHeight;
    this.surfaceHint = typeof surfaceHint === 'function' ? surfaceHint : null;
    this.width = Math.ceil(dimensions.sx / this.step);
    this.depth = Math.ceil(dimensions.sz / this.step);
    this.tiles = this.width * this.depth;
    this.positions = new Float32Array(this.tiles * STRIDE * 3);
    this.colors = new Uint8Array(this.positions.length);
    this.normals = new Int8Array(this.positions.length);
    this.indices = new Uint32Array(this.tiles * INDICES);
    this.empty = new Uint8Array(this.tiles);
    this.hidden = new Set(); this.hiddenTiles = new Set(); this.samples = new Map(); this.dirty = new Set();
    this.signature = '';
    this.reads = 0;
    for (let z = 0; z < this.depth; z++) for (let x = 0; x < this.width; x++) this.buildTile(x, z);
    for (let tile = 0; tile < this.tiles; tile++) this.writeIndices(tile);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3, true));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3, true));
    this.geometry.setIndex(new THREE.BufferAttribute(this.indices, 1));
    // Destruction and rebuilt terrain can move vertices anywhere in the
    // authored extent without invalidating the initial culling volume.
    const center = new THREE.Vector3(dimensions.sx / 2, dimensions.sy / 2, dimensions.sz / 2);
    this.geometry.boundingSphere = new THREE.Sphere(center, center.length());
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.material.name = 'far-terrain';
    if (lightUniforms) patchVoxelLitMaterial(this.material, lightUniforms, 'voxel-lit');
    this.mesh = new THREE.Mesh(this.geometry, this.material); this.mesh.name = 'frontier-far-terrain';
    this.mesh.matrixAutoUpdate = false; scene.add(this.mesh);
    // The shell keeps actual overhead gaps and silhouettes instead of turning
    // roofs into ramps; bulk terrain below the local ground stays out of it.
    this.silhouette = silhouetteStep != null ? new DistantVoxelShell(scene, getBlock, dimensions, {
      step: silhouetteStep, groundHeight: groundHeight ?? 0,
      floor: this.shellFloor(silhouetteStep), lightUniforms,
    }) : null;
  }

  /** Probe start for a column: the authored hint, else just below the nominal ground. */
  probeStart(x, z) {
    const hinted = this.surfaceHint?.(x, z);
    if (Number.isFinite(hinted)) return Math.floor(hinted) - 1;
    return this.groundHeight == null ? 0 : Math.floor(this.groundHeight) - 1;
  }

  /**
   * Ground surface of one voxel column: from the probe start, up through the
   * solid ground column to its first open cell (water counts as ground), or
   * down to the ground when the start is open (craters, low valleys).
   */
  surface(x, z) {
    const top = this.dimensions.sy - 1;
    let y = Math.max(0, Math.min(top, this.probeStart(x, z)));
    const block = (yy) => { this.reads++; return this.getBlock(x, yy, z); };
    const solid = (yy) => block(yy) !== AIR;
    // Ground continues upward through natural materials, and through paving
    // only where it is the top layer.
    const ground = (yy) => {
      const id = block(yy);
      if (id === AIR || (!GROUND.has(id) && !PAVING.has(id))) return false;
      return !PAVING.has(id) || yy >= top || !solid(yy + 1);
    };
    const climb = () => { while (y < top && ground(y + 1)) y++; return y + 1; };
    if (solid(y)) return climb();
    while (y > 0 && !solid(y - 1)) y--;
    if (y > 0) return y;
    // Nothing below the start: the ground sits above it (a floating start).
    y = Math.max(0, Math.min(top, this.probeStart(x, z)));
    while (y < top && !solid(y)) y++;
    if (y >= top && !solid(top)) return 0;
    return climb();
  }

  sample(x, z) {
    x = Math.max(0, Math.min(this.dimensions.sx - 1, Math.floor(x)));
    z = Math.max(0, Math.min(this.dimensions.sz - 1, Math.floor(z)));
    const key = x + z * this.dimensions.sx;
    const cached = this.samples.get(key);
    if (cached) return cached;
    const height = this.surface(x, z);
    const id = height > 0 ? this.getBlock(x, height - 1, z) : AIR;
    const sample = { height, id };
    this.samples.set(key, sample);
    return sample;
  }

  /**
   * Lowest ground in each shell column's neighbourhood: the shell starts there,
   * so flat and rolling terrain is drawn once (here), while cliffs, banks and
   * anything standing on the ground stay in the shell.
   */
  shellFloor(cellStep) {
    const { sx, sz } = this.dimensions;
    const w = Math.ceil(sx / cellStep), d = Math.ceil(sz / cellStep);
    const raw = new Int16Array(w * d);
    for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
      let low = Infinity;
      for (let dz = 0; dz < cellStep; dz++) for (let dx = 0; dx < cellStep; dx++) {
        const xx = Math.min(sx - 1, x * cellStep + dx), zz = Math.min(sz - 1, z * cellStep + dz);
        low = Math.min(low, this.surface(xx, zz));
      }
      raw[x + z * w] = low;
    }
    // Separable min filter over the neighbourhood.
    const rows = new Int16Array(w * d), out = new Int16Array(w * d);
    const r = SHELL_FLOOR_RADIUS;
    for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
      let low = 32767;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) low = Math.min(low, raw[k + z * w]);
      rows[x + z * w] = low;
    }
    for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
      let low = 32767;
      for (let k = Math.max(0, z - r); k <= Math.min(d - 1, z + r); k++) low = Math.min(low, rows[x + k * w]);
      out[x + z * w] = low;
    }
    return { width: w, depth: d, heights: out };
  }

  buildTile(x, z) {
    const tile = x + z * this.width, vertex = tile * STRIDE;
    const step = this.step;
    const x0 = x * step, z0 = z * step;
    const x1 = Math.min(this.dimensions.sx, x0 + step), z1 = Math.min(this.dimensions.sz, z0 + step);
    const points = [[x0, z0], [x0, z1], [x1, z1], [x1, z0], [(x0 + x1) / 2, (z0 + z1) / 2]];
    let empty = true;
    for (let i = 0; i < STRIDE; i++) {
      const p = points[i < 5 ? i : i - 5];
      const s = this.sample(p[0], p[1]);
      if (s.id !== AIR) empty = false;
      const offset = (vertex + i) * 3;
      const top = i < 5;
      this.positions[offset] = p[0];
      this.positions[offset + 1] = top ? s.height - 0.04 : 0;
      this.positions[offset + 2] = p[1];
      // Relief normal from the neighbouring samples one tile step away.
      const hx = this.sample(p[0] + step, p[1]).height - this.sample(p[0] - step, p[1]).height;
      const hz = this.sample(p[0], p[1] + step).height - this.sample(p[0], p[1] - step).height;
      const nx = -hx / (2 * step), nz = -hz / (2 * step);
      const length = Math.hypot(nx, 1, nz);
      this.normals[offset] = Math.round(nx / length * 127);
      this.normals[offset + 1] = Math.round(127 / length);
      this.normals[offset + 2] = Math.round(nz / length * 127);
      // Painter colour of the surface block; slopes darken and lean to rock
      // grey, skirts sit in shade below the surface.
      const rgb = s.id === AIR ? [139, 139, 122] : materialColor(s.id, 2);
      const slope = Math.min(1, Math.hypot(hx, hz) / (2 * step) / STEEP);
      const shade = (top ? 1 - 0.28 * slope : 0.62);
      const grey = (rgb[0] + rgb[1] + rgb[2]) / 3;
      for (let c = 0; c < 3; c++) {
        const value = (rgb[c] + (grey - rgb[c]) * 0.35 * slope) * shade;
        this.colors[offset + c] = Math.max(0, Math.min(255, Math.round(value)));
      }
    }
    this.empty[tile] = empty ? 1 : 0;
  }

  /** Write a tile's live index span (zeros while hidden or empty). */
  writeIndices(tile, visible = true) {
    const offset = tile * INDICES;
    if (!visible || this.empty[tile]) { this.indices.fill(0, offset, offset + INDICES); return; }
    const vertex = tile * STRIDE;
    let k = offset;
    for (let i = 0; i < 4; i++) {
      const next = (i + 1) % 4;
      this.indices[k++] = vertex + i; this.indices[k++] = vertex + next; this.indices[k++] = vertex + 4;
      this.indices[k++] = vertex + i; this.indices[k++] = vertex + 5 + i; this.indices[k++] = vertex + 5 + next;
      this.indices[k++] = vertex + i; this.indices[k++] = vertex + 5 + next; this.indices[k++] = vertex + next;
    }
  }

  syncChunks(chunkStore) {
    this.silhouette?.syncChunks(chunkStore);
    const keys = [...chunkStore.chunks.keys()];
    const signature = keys.join(';');
    if (signature === this.signature) return;
    this.signature = signature; this.hidden = new Set(keys);
    const previous = this.hiddenTiles;
    this.hiddenTiles = new Set();
    // A detailed chunk covers 16m; capture samples may use smaller tiles.
    const per = 16 / this.step;
    for (const key of keys) {
      const [cx, cz] = key.split(',').map(Number);
      for (let z = cz * per; z < Math.min(this.depth, (cz + 1) * per); z++) {
        for (let x = cx * per; x < Math.min(this.width, (cx + 1) * per); x++) this.hiddenTiles.add(x + z * this.width);
      }
    }
    for (const tile of previous) if (!this.hiddenTiles.has(tile)) this.writeIndices(tile, true);
    for (const tile of this.hiddenTiles) if (!previous.has(tile)) this.writeIndices(tile, false);
    this.geometry.index.needsUpdate = true;
  }

  applyDeltas(deltas) {
    this.silhouette?.applyDeltas(deltas);
    for (const delta of deltas) {
      const x = Math.floor(delta.x / this.step), z = Math.floor(delta.z / this.step);
      // A shared corner belongs to adjacent tiles; invalidate the small halo.
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const tx = x + dx, tz = z + dz;
        if (tx >= 0 && tz >= 0 && tx < this.width && tz < this.depth) this.dirty.add(tx + tz * this.width);
      }
    }
  }

  update() {
    this.silhouette?.update();
    if (!this.dirty.size) return;
    // Clearing the bounded sample cache avoids retaining stale shared corners.
    this.samples.clear();
    for (let i = 0; i < 4 && this.dirty.size; i++) {
      const tile = this.dirty.values().next().value; this.dirty.delete(tile);
      const x = tile % this.width, z = Math.floor(tile / this.width);
      this.buildTile(x, z);
      this.writeIndices(tile, !this.hiddenTiles.has(tile));
    }
    this.geometry.index.needsUpdate = true;
    for (const name of ['position', 'color', 'normal']) this.geometry.attributes[name].needsUpdate = true;
  }

  flush() {
    this.silhouette?.flush();
    while (this.dirty.size) this.update();
  }

  /** Sampled ground heights (top vertices), for relief checks. */
  heightStats() {
    let min = Infinity, max = -Infinity, sum = 0, sq = 0, n = 0;
    for (let tile = 0; tile < this.tiles; tile++) {
      if (this.empty[tile]) continue;
      for (let i = 0; i < 5; i++) {
        const y = this.positions[(tile * STRIDE + i) * 3 + 1];
        min = Math.min(min, y); max = Math.max(max, y); sum += y; sq += y * y; n++;
      }
    }
    const mean = n ? sum / n : 0;
    return { min, max, mean, variance: n ? sq / n - mean * mean : 0, samples: n };
  }

  get stats() {
    const silhouette = this.silhouette?.stats || null;
    return { tiles: this.tiles, hidden: this.hiddenTiles.size, visible: this.tiles - this.hiddenTiles.size,
      vertices: this.tiles * STRIDE + (silhouette?.vertices || 0), draws: 1 + (silhouette?.draws || 0),
      bytes: this.positions.byteLength + this.colors.byteLength + this.normals.byteLength + this.indices.byteLength
        + this.empty.byteLength,
      silhouetteBytes: silhouette?.bytes || 0, reads: this.reads, silhouette };
  }
  dispose() { this.silhouette?.dispose(); this.scene.remove(this.mesh); this.geometry.dispose(); this.material.dispose(); this.samples.clear(); this.dirty.clear(); this.hidden.clear(); this.hiddenTiles.clear(); }
}
