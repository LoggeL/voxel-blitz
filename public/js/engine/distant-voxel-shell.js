import * as THREE from '../vendor/three.module.js';
import { AIR } from '../../../shared/world/blocks.js';
import { TILE_PAINTERS, TILE_PX, faceTile } from './atlas.js';
import { patchVoxelLitMaterial } from './voxel-light.js';

const CHUNK_SIZE = 16;
const EMPTY = new Uint16Array(0);
/**
 * Occupancy marker for terrain under the shell floor (and below the shell):
 * solid for face culling, never drawn. Block ids stay below 255.
 */
export const BURIED = 255;
/** Spare quads per record slot (plus 1/8 of its own) so most edits patch in place. */
const SLOT_SLACK_QUADS = 12;
/** Pending partial uploads per attribute before one full upload is cheaper. */
const MAX_UPDATE_RANGES = 48;
/** Attributes whose pending upload is the whole buffer (see markRange). */
const FULL_UPLOADS = new WeakSet();
/** Upload callback (`this` is the attribute): the full upload is on the GPU. */
function endFullUpload() { FULL_UPLOADS.delete(this); }
const NORMALS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const TILE_COLORS = new Map();

/**
 * Average the same material painter used by detailed chunks, in linear RGB (0..255).
 * `remap` is the map's whole-tile remap (atlas.js mapSurface), so far LODs
 * wear the same per-map palette as the detailed chunks.
 */
export function materialColor(id, face, remap = null) {
  const base = faceTile(id, face);
  const tile = remap?.[base] ?? base;
  if (TILE_COLORS.has(tile)) return TILE_COLORS.get(tile);
  const painter = TILE_PAINTERS[tile], color = new THREE.Color();
  const sum = [0, 0, 0];
  let weight = 0;
  for (let z = 0; z < TILE_PX; z++) for (let x = 0; x < TILE_PX; x++) {
    const rgba = painter(x, z), alpha = rgba[3] / 255;
    color.setRGB(rgba[0] / 255, rgba[1] / 255, rgba[2] / 255, THREE.SRGBColorSpace);
    sum[0] += color.r * alpha; sum[1] += color.g * alpha; sum[2] += color.b * alpha;
    weight += alpha;
  }
  const rgb = sum.map(value => Math.round(255 * value / (weight || 1)));
  TILE_COLORS.set(tile, rgb);
  return rgb;
}

/**
 * Direct reader over a raw y/z/x voxel array for in-range coordinates, or null.
 * `voxels` returns { blocks, dimensions } (the client's decoded arena); the
 * load-time scans read it instead of the layered getBlock closures.
 */
export function rawVoxelReader(voxels, dimensions) {
  let source = null;
  try { source = typeof voxels === 'function' ? voxels() : null; } catch { source = null; }
  const { sx, sy, sz } = dimensions, d = source?.dimensions;
  if (!(source?.blocks instanceof Uint8Array) || source.blocks.length !== sx * sy * sz
    || d?.sx !== sx || d?.sy !== sy || d?.sz !== sz) return null;
  const blocks = source.blocks, plane = sx * sz;
  const read = (x, y, z) => blocks[y * plane + z * sx + x];
  read.blocks = blocks;
  return read;
}

/**
 * A single distant draw of the authoritative above-ground world. Each 2x1x2m
 * cell contains the first occupied source voxel in its horizontal footprint;
 * empty vertical layers stay empty, including the space below gantries. Greedy
 * faces remain local to 16m chunks so detailed chunks can replace exact spans.
 * No per-chunk Three objects or procedural landmark proxies are created.
 *
 * `floor` ({width, depth, heights} on the shell cell grid, see FarTerrain)
 * excludes the bulk terrain under the local ground: on a world with relief the
 * hills are drawn by the far terrain mesh, and only what rises from them
 * (buildings, trees, cliffs, banks) stays in the shell, which keeps its quad
 * count bounded by structures instead of by the landscape. The excluded
 * terrain still counts as solid (BURIED) when faces are culled, so the shell
 * never emits the bottoms and underground sides of its lowest cells.
 *
 * Destruction: every 16m record owns a slot with spare room in the merged
 * buffers, so a rebuilt record is written in place and only its ranges are
 * uploaded (a blast costs a fraction of a millisecond, not a re-layout and a
 * full re-upload of the whole shell). Records hidden behind detailed chunks
 * are not drawn, so their rebuild waits until the chunk streams out again.
 */
export class DistantVoxelShell {
  constructor(scene, getBlock, dimensions, {
    step = 2, groundHeight = 11, floor = null, lightUniforms = null, remap = null, voxels = null,
  } = {}) {
    if (!Number.isInteger(step) || step < 1 || CHUNK_SIZE % step !== 0) {
      throw new RangeError('Distant voxel step must be a positive divisor of 16');
    }
    for (const axis of ['sx', 'sy', 'sz']) {
      if (!Number.isInteger(dimensions[axis]) || dimensions[axis] <= 0) {
        throw new RangeError(`Invalid distant voxel dimension ${axis}`);
      }
    }
    const started = performance.now();
    this.scene = scene; this.getBlock = getBlock; this.dimensions = dimensions;
    this.remap = remap;
    // Every shell corner is an integer world coordinate. Unsigned shorts
    // preserve these exactly on Frontier and reduce cached and GPU positions;
    // Three converts non-normalized attributes to floating-point shader inputs.
    this.PositionArray = Math.max(dimensions.sx, dimensions.sy, dimensions.sz) <= 65535 ? Uint16Array : Float32Array;
    this.step = step;
    this.width = Math.ceil(dimensions.sx / step);
    this.depth = Math.ceil(dimensions.sz / step);
    this.floor = floor && floor.width === this.width && floor.depth === this.depth ? floor.heights : null;
    let base = Math.floor(groundHeight);
    if (this.floor) for (let i = 0; i < this.floor.length; i++) base = Math.min(base, this.floor[i]);
    this.groundHeight = Math.max(0, Math.min(dimensions.sy, base));
    this.height = dimensions.sy - this.groundHeight;
    this.chunkWidth = Math.ceil(dimensions.sx / CHUNK_SIZE);
    this.chunkDepth = Math.ceil(dimensions.sz / CHUNK_SIZE);
    this.cellsPerChunk = CHUNK_SIZE / step;
    this.plane = this.width * this.depth;
    this.cells = new Uint8Array(this.plane * this.height);
    this.records = new Map();
    this.hidden = new Set(); this.dirty = new Set();
    this.sampleReads = 0; this.rebuilds = 0; this.patches = 0; this.merges = 0; this.lastUpdateMs = 0;
    const center = new THREE.Vector3(dimensions.sx / 2, dimensions.sy / 2, dimensions.sz / 2);
    this.boundingSphere = new THREE.Sphere(center, center.length());
    this.disposed = false; this.ready = false;
    for (let cz = 0; cz < this.chunkDepth; cz++) for (let cx = 0; cx < this.chunkWidth; cx++) {
      this.records.set(`${cx},${cz}`, {
        cx, cz, occupied: 0, positions: EMPTY, normals: new Int8Array(0), colors: new Uint8Array(0),
        vertexOffset: 0, vertexCapacity: 0, indexOffset: 0, indexCapacity: 0, indexCount: 0,
      });
    }
    // The initial full-map scan reads the raw voxels when the store has them;
    // later record rebuilds (deltas) go through getBlock.
    const raw = rawVoxelReader(voxels, dimensions);
    this.sampleWorld(raw?.blocks || null);
    const sampled = performance.now();
    for (const record of this.records.values()) this.buildChunk(record);
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.material.name = 'distant-voxel-shell';
    if (lightUniforms) patchVoxelLitMaterial(this.material, lightUniforms, 'voxel-lit');
    this.geometry = null;
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.name = 'frontier-distant-voxel-shell';
    this.mesh.matrixAutoUpdate = false;
    this.merge();
    scene.add(this.mesh);
    this.sampleMs = sampled - started;
    this.buildMs = performance.now() - started;
    this.ready = true;
  }

  sampleCell(x, y, z) {
    // Bulk terrain below the local ground belongs to the far terrain mesh;
    // it is solid ground (the floor is the lowest surface around the cell).
    if (this.floor && y + this.groundHeight < this.floor[x + z * this.width]) return BURIED;
    const wx = x * this.step, wz = z * this.step;
    const x1 = Math.min(this.dimensions.sx, wx + this.step);
    const z1 = Math.min(this.dimensions.sz, wz + this.step);
    for (let zz = wz; zz < z1; zz++) for (let xx = wx; xx < x1; xx++) {
      this.sampleReads++;
      const id = this.getBlock(xx, y + this.groundHeight, zz);
      if (id !== AIR) return id;
    }
    return AIR;
  }

  /**
   * `blocks` (optional) is the raw y/z/x voxel array behind getBlock: the
   * same cells as sampleCell, read straight from the array.
   */
  sampleWorld(blocks = null) {
    // Match the authoritative store's y/z/x order to keep the full-map scan
    // sequential. Air cells need four reads; occupied cells stop at one.
    const rows = Array.from(this.records.values());
    const { sx, sz } = this.dimensions, step = this.step;
    for (let y = 0; y < this.height; y++) for (let z = 0; z < this.depth; z++) {
      const row = Math.floor(z / this.cellsPerChunk) * this.chunkWidth;
      const layer = (y + this.groundHeight) * sx * sz;
      const wz = z * step, z1 = Math.min(sz, wz + step);
      for (let x = 0; x < this.width; x++) {
        let id;
        if (!blocks) id = this.sampleCell(x, y, z);
        else if (this.floor && y + this.groundHeight < this.floor[x + z * this.width]) id = BURIED;
        else {
          id = AIR;
          const wx = x * step, x1 = Math.min(sx, wx + step);
          scan: for (let zz = wz; zz < z1; zz++) {
            const base = layer + zz * sx;
            for (let xx = wx; xx < x1; xx++) {
              this.sampleReads++;
              if (blocks[base + xx] !== AIR) { id = blocks[base + xx]; break scan; }
            }
          }
        }
        this.cells[x + z * this.width + y * this.plane] = id;
        if (id !== AIR && id !== BURIED) rows[row + Math.floor(x / this.cellsPerChunk)].occupied++;
      }
    }
  }

  cell(x, y, z) {
    // Below the shell lies ground (buried when a floor excludes the bulk terrain).
    if (y < 0 && this.floor && x >= 0 && z >= 0 && x < this.width && z < this.depth) return BURIED;
    if (x < 0 || y < 0 || z < 0 || x >= this.width || y >= this.height || z >= this.depth) return AIR;
    return this.cells[x + z * this.width + y * this.plane];
  }

  buildChunk(record) {
    if (!record.occupied) {
      record.positions = EMPTY; record.normals = new Int8Array(0); record.colors = new Uint8Array(0);
      return;
    }
    const base = [record.cx * this.cellsPerChunk, 0, record.cz * this.cellsPerChunk];
    const size = [Math.min(this.cellsPerChunk, this.width - base[0]), this.height,
      Math.min(this.cellsPerChunk, this.depth - base[2])];
    // Sweep only the layers that hold drawn cells (structures rise a few
    // metres above the floor): layers outside are air or buried, which emit
    // no face, so the quads are exactly those of the full-height sweep.
    const [yMin, yMax] = this.occupiedLayers(base[0], base[2], size[0], size[2]);
    if (yMax < yMin) {
      record.positions = EMPTY; record.normals = new Int8Array(0); record.colors = new Uint8Array(0);
      return;
    }
    base[1] = yMin; size[1] = yMax - yMin + 1;
    const positions = [], normals = [], colors = [];
    const point = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
      const u = (axis + 1) % 3, v = (axis + 2) % 3;
      const mask = new Int16Array(size[u] * size[v]);
      for (let slice = -1; slice < size[axis]; slice++) {
        let index = 0;
        point[axis] = base[axis] + slice;
        for (let j = 0; j < size[v]; j++) for (let i = 0; i < size[u]; i++) {
          point[u] = base[u] + i; point[v] = base[v] + j;
          const a = this.cell(point[0], point[1], point[2]);
          point[axis]++;
          const b = this.cell(point[0], point[1], point[2]);
          point[axis]--;
          // Preserve faces on 16m record boundaries. Coarse occupancy in an
          // adjacent record cannot prove that a detailed voxel touches this
          // face: its occupied sample may sit a metre away from the seam.
          // Duplicate internal faces are hidden while both shells are shown,
          // and make hide/evict handoffs safe without remeshing neighbours.
          // Buried terrain is never drawn and hides every face against it.
          const boundary = axis !== 1 && (slice === -1 || slice === size[axis] - 1);
          mask[index++] = a && a !== BURIED && b !== BURIED && (!b || boundary) && slice >= 0 ? a
            : b && b !== BURIED && a !== BURIED && (!a || boundary) && slice + 1 < size[axis] ? -b : 0;
        }
        for (let j = 0; j < size[v]; j++) for (let i = 0; i < size[u];) {
          const offset = i + j * size[u], value = mask[offset];
          if (!value) { i++; continue; }
          let width = 1, height = 1;
          while (i + width < size[u] && mask[offset + width] === value) width++;
          outer: while (j + height < size[v]) {
            for (let k = 0; k < width; k++) if (mask[offset + k + height * size[u]] !== value) break outer;
            height++;
          }
          this.emitQuad(positions, normals, colors, base, axis, u, v, slice + 1, i, j, width, height, value);
          for (let row = 0; row < height; row++) mask.fill(0, offset + row * size[u], offset + row * size[u] + width);
          i += width;
        }
      }
    }
    record.positions = new this.PositionArray(positions);
    record.normals = new Int8Array(normals);
    record.colors = new Uint8Array(colors);
  }

  /** Lowest and highest shell layer with a drawn (not air, not buried) cell in a record footprint. */
  occupiedLayers(x0, z0, width, depth) {
    let yMin = this.height, yMax = -1;
    for (let y = 0; y < this.height; y++) {
      const layer = y * this.plane;
      let found = false;
      for (let z = z0; z < z0 + depth && !found; z++) {
        const row = layer + z * this.width;
        for (let x = x0; x < x0 + width; x++) {
          const id = this.cells[row + x];
          if (id !== AIR && id !== BURIED) { found = true; break; }
        }
      }
      if (found) { if (yMin > y) yMin = y; yMax = y; }
    }
    return [yMin, yMax];
  }

  emitQuad(positions, normals, colors, base, axis, u, v, slice, i, j, width, height, value) {
    const face = axis === 0 ? (value > 0 ? 0 : 1) : axis === 1 ? (value > 0 ? 2 : 3) : (value > 0 ? 4 : 5);
    const normal = NORMALS[face], color = materialColor(Math.abs(value), face, this.remap);
    // Cyclic axes guarantee U x V is the positive normal; reverse negative
    // faces so ordinary FrontSide materials also work from below a bridge.
    const corners = value > 0 ? [[0, 0], [width, 0], [width, height], [0, height]]
      : [[0, 0], [0, height], [width, height], [width, 0]];
    for (const [du, dv] of corners) {
      const point = [...base];
      point[axis] += slice; point[u] += i + du; point[v] += j + dv;
      positions.push(Math.min(this.dimensions.sx, point[0] * this.step), point[1] + this.groundHeight,
        Math.min(this.dimensions.sz, point[2] * this.step));
      normals.push(normal[0] * 127, normal[1] * 127, normal[2] * 127);
      colors.push(...color);
    }
  }

  /**
   * Lay every record out in one geometry. Each record owns a vertex slot with
   * some slack, so a later rebuild of that record (a blast, a placed block)
   * is written in place and uploads only its own ranges; only a record that
   * outgrows its slot lays the whole buffer out again.
   */
  merge() {
    let vertices = 0;
    for (const record of this.records.values()) {
      const count = record.positions.length / 3;
      record.vertexCapacity = count ? count + 4 * (Math.ceil(count / 32) + SLOT_SLACK_QUADS) : 0;
      record.vertexOffset = vertices;
      vertices += record.vertexCapacity;
    }
    const positions = new this.PositionArray(vertices * 3), normals = new Int8Array(vertices * 3), colors = new Uint8Array(vertices * 3);
    const indices = new Uint32Array(vertices / 4 * 6);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3, true));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    for (const attribute of [geometry.attributes.position, geometry.attributes.normal, geometry.attributes.color, geometry.index]) {
      attribute.setUsage(THREE.DynamicDrawUsage);
    }
    // Patched records may move geometry anywhere inside the map: one fixed
    // culling volume over the authoritative extent, never recomputed.
    geometry.boundingSphere = this.boundingSphere;
    this.mesh.geometry.dispose();
    this.mesh.geometry = geometry; this.geometry = geometry;
    for (const [key, record] of this.records) {
      const offset = record.vertexOffset * 3;
      positions.set(record.positions, offset); normals.set(record.normals, offset); colors.set(record.colors, offset);
      record.indexOffset = record.vertexOffset / 4 * 6;
      record.indexCapacity = record.vertexCapacity / 4 * 6;
      record.indexCount = record.positions.length / 12 * 6;
      this.writeIndexSpan(record, !this.hidden.has(key), false);
    }
    this.mesh.visible = vertices > 0;
    this.merges++;
  }

  /**
   * Write one record's index span: its quads when shown, zeros (degenerate
   * triangles, nothing drawn) when hidden or past its live quads.
   */
  writeIndexSpan(record, visible, upload = true) {
    const index = this.geometry.index, array = index.array;
    const start = record.indexOffset, end = start + record.indexCapacity;
    if (end === start) return;
    let i = start;
    if (visible) {
      const stop = start + record.indexCount;
      for (let vertex = record.vertexOffset; i < stop; vertex += 4) {
        array[i++] = vertex; array[i++] = vertex + 1; array[i++] = vertex + 2;
        array[i++] = vertex; array[i++] = vertex + 2; array[i++] = vertex + 3;
      }
    }
    array.fill(0, i, end);
    if (upload) this.markRange(index, start, record.indexCapacity);
  }

  /**
   * Queue a partial upload; a long backlog (a respawn re-showing hundreds of
   * records, no frame drawn) falls back to one full upload. That full upload
   * holds until the renderer has done it: a range added after the fallback
   * would narrow it again to the last few records, and the earlier ones
   * (the records hidden under the new spawn's detailed chunks) would stay
   * drawn on the GPU and z-fight them.
   */
  markRange(attribute, start, count) {
    if (!FULL_UPLOADS.has(attribute)) {
      if (attribute.updateRanges.length < MAX_UPDATE_RANGES) attribute.addUpdateRange(start, count);
      else {
        attribute.clearUpdateRanges();
        FULL_UPLOADS.add(attribute);
        attribute.onUpload(endFullUpload);
      }
    }
    attribute.needsUpdate = true;
  }

  /**
   * Rebuild one record and write it into its slot. Returns false when it no
   * longer fits (the caller lays the buffer out again).
   */
  patchRecord(key, record) {
    this.buildChunk(record);
    const count = record.positions.length / 3;
    if (!this.geometry || count > record.vertexCapacity) return false;
    const offset = record.vertexOffset * 3, attributes = this.geometry.attributes;
    attributes.position.array.set(record.positions, offset);
    attributes.normal.array.set(record.normals, offset);
    attributes.color.array.set(record.colors, offset);
    // Vertices past the live quads stay in the slot unreferenced.
    if (count) for (const name of ['position', 'normal', 'color']) this.markRange(attributes[name], offset, count * 3);
    record.indexCount = count / 4 * 6;
    this.writeIndexSpan(record, !this.hidden.has(key));
    this.patches++;
    return true;
  }

  /** Rebuild records (patched in place when they fit, else one layout pass). */
  rebuildRecords(keys) {
    let relayout = false;
    for (const key of keys) {
      if (!this.patchRecord(key, this.records.get(key))) relayout = true;
      this.rebuilds++;
    }
    if (relayout) this.merge();
  }

  syncChunks(chunkStore) {
    if (this.disposed) return;
    const completed = new Set();
    // ChunkStore inserts records only when their detailed rebuild completes;
    // pending/wanted/load-queue chunks must retain the distant representation.
    for (const key of chunkStore.chunks.keys()) if (this.records.has(key)) completed.add(key);
    const shown = [];
    for (const key of this.hidden) if (!completed.has(key)) shown.push(key);
    const hidden = [];
    for (const key of completed) if (!this.hidden.has(key)) hidden.push(key);
    if (!shown.length && !hidden.length) return;
    this.hidden = completed;
    for (const key of hidden) this.writeIndexSpan(this.records.get(key), false);
    // A record edited while hidden was left stale (it was not drawn): rebuild
    // it now, before it is shown again.
    const stale = shown.filter((key) => this.dirty.has(key));
    for (const key of stale) this.dirty.delete(key);
    for (const key of shown) if (!this.dirty.has(key) && !stale.includes(key)) this.writeIndexSpan(this.records.get(key), true);
    if (stale.length) this.rebuildRecords(stale);
  }

  applyDeltas(deltas) {
    if (this.disposed) return;
    const changed = new Set();
    for (const delta of deltas) {
      const x = Math.floor(delta.x / this.step), z = Math.floor(delta.z / this.step), y = Math.floor(delta.y) - this.groundHeight;
      if (x < 0 || z < 0 || y < 0 || x >= this.width || z >= this.depth || y >= this.height) continue;
      changed.add(x + z * this.width + y * this.plane);
    }
    for (const index of changed) {
      const y = Math.floor(index / this.plane), row = index - y * this.plane;
      const z = Math.floor(row / this.width), x = row - z * this.width;
      const id = this.sampleCell(x, y, z), previous = this.cells[index];
      if (id === previous) continue;
      this.cells[index] = id;
      const cx = Math.floor(x / this.cellsPerChunk), cz = Math.floor(z / this.cellsPerChunk);
      const record = this.records.get(`${cx},${cz}`);
      const drawn = (value) => (value !== AIR && value !== BURIED ? 1 : 0);
      record.occupied += drawn(id) - drawn(previous);
      this.dirty.add(`${cx},${cz}`);
      // The neighbouring records own the other side of a changed seam.
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const key = `${cx + dx},${cz + dz}`;
        if (this.records.has(key)) this.dirty.add(key);
      }
    }
  }

  /**
   * One dirty record per frame, written in place. Records hidden behind
   * detailed chunks wait: they are not drawn, so most blasts near the player
   * cost nothing here until that chunk streams out (syncChunks).
   */
  update() {
    if (this.disposed || !this.dirty.size) return;
    let key = null;
    for (const candidate of this.dirty) if (!this.hidden.has(candidate)) { key = candidate; break; }
    if (key === null) return;
    const started = performance.now();
    this.dirty.delete(key);
    this.rebuildRecords([key]);
    this.lastUpdateMs = performance.now() - started;
  }

  /** Replay terrain must drain before the next recorded frame is rendered. */
  flush() {
    if (this.disposed || !this.dirty.size) return;
    const started = performance.now();
    const keys = [...this.dirty];
    this.dirty.clear();
    this.rebuildRecords(keys);
    this.lastUpdateMs = performance.now() - started;
  }

  get stats() {
    let cachedBytes = 0, visibleQuads = 0, quads = 0, dirty = 0;
    for (const [key, record] of this.records) {
      cachedBytes += record.positions.byteLength + record.normals.byteLength + record.colors.byteLength;
      quads += record.positions.length / 12;
      if (!this.hidden.has(key)) visibleQuads += record.positions.length / 12;
    }
    for (const key of this.dirty) if (!this.hidden.has(key)) dirty++;
    const attributes = this.geometry?.attributes;
    const geometryBytes = attributes ? Object.values(attributes).reduce((bytes, attr) => bytes + attr.array.byteLength, 0)
      + this.geometry.index.array.byteLength : 0;
    const vertices = quads * 4;
    return { chunks: this.records.size, hidden: this.hidden.size, visible: this.records.size - this.hidden.size,
      quads, visibleQuads, vertices, triangles: quads * 2, draws: vertices ? 1 : 0,
      slotQuads: (attributes?.position.count || 0) / 4,
      bytes: this.cells.byteLength + cachedBytes + geometryBytes,
      geometryBytes, cachedBytes, occupancyBytes: this.cells.byteLength, sampleReads: this.sampleReads,
      sampleMs: this.sampleMs, buildMs: this.buildMs,
      // dirty: records waiting for a frame; deferred: edited while hidden behind detailed chunks.
      dirty, deferred: this.dirty.size - dirty, queued: this.dirty.size,
      rebuilds: this.rebuilds, patches: this.patches, merges: this.merges, lastUpdateMs: this.lastUpdateMs };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.ready = false;
    this.scene.remove(this.mesh); this.geometry.dispose(); this.material.dispose();
    this.records.clear(); this.dirty.clear(); this.hidden.clear();
    this.cells = new Uint8Array(0);
  }
}
