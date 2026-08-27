// Column-chunk mesher: 16 x SY x 16 world slices -> one BufferGeometry per
// material bucket (opaque / cutout / glass). Vertex colours bake classic
// 4-sample ambient occlusion plus fixed per-face directional shading, so the
// whole terrain renders as cheap Lambert surfaces with crisp voxel lighting.

import * as THREE from '../vendor/three.module.js';
import { AIR, GRASS, LEAVES, GLASS, SX, SZ, SY } from '../../../shared/worlddata.js';

export const CHUNK_X = 16;
export const CHUNK_Z = 16;
export const CHUNKS_W = SX / CHUNK_X;
export const CHUNKS_H = SZ / CHUNK_Z;
/** Frame budget: at most this many chunk rebuilds drained per update() call. */
export const MAX_REBUILDS_PER_FRAME = 3;

/** AO brightness by occupied-sample count (0..3). */
export const AO_LEVELS = [0.42, 0.62, 0.82, 1.0];

/**
 * Classic corner rule: when both adjacent sides are solid the corner sample is
 * ignored (count forced to 3) so AO cannot leak through diagonal gaps.
 */
export function aoIndex(side1, side2, corner) {
  return side1 && side2 ? 3 : side1 + side2 + corner;
}

/**
 * Brightness lookup: sample counts feed the classic rule (aoIndex above), then
 * the LUT is read 3-minus-count so open corners stay bright, occluded darken.
 */
export function aoLevel(side1, side2, corner) {
  return AO_LEVELS[3 - aoIndex(side1, side2, corner)];
}

/** Fixed directional shade per face id 0:+X 1:-X 2:+Y 3:-Y 4:+Z 5:-Z. */
export const FACE_SHADE = [0.76, 0.76, 1.0, 0.58, 0.84, 0.84];

// Tangent frame per face: origin corner offset within the voxel cube, then U
// and V edge directions such that U x V = N. Vertex order p00, p10, p11, p01
// is therefore guaranteed CCW seen from outside the block.
const FACES = [
  { n: [1, 0, 0], o: [1, 0, 1], u: [0, 0, -1], v: [0, 1, 0] }, // +X
  { n: [-1, 0, 0], o: [0, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },  // -X
  { n: [0, 1, 0], o: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] },   // +Y
  { n: [0, -1, 0], o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1] },  // -Y
  { n: [0, 0, 1], o: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },   // +Z
  { n: [0, 0, -1], o: [1, 0, 0], u: [-1, 0, 0], v: [0, 1, 0] }, // -Z
];
const CORNER_UV = [[0, 0], [1, 0], [1, 1], [0, 1]];

const isSeeThrough = (v) => v === LEAVES || v === GLASS;

/** Per-position hash jitter source for tint code paths -> 0..100. */
function posJitter(x, y, z) {
  return ((x * 7 + y * 13 + z * 31) % 101 + 101) % 101;
}

export class ChunkStore {
  /**
   * @param {THREE.Scene} scene parent; chunk meshes are added to a group at origin
   * @param atlas atlas surface from buildAtlas(): texture(), tileRect(), faceTile()
   * @param getBlockFn live voxel getter (x,y,z)->blockId closed over the CURRENT
   *        store, so rebuilds always read fresh blocks and chunk-border
   *        neighbours resolve exactly across chunk seams.
   */
  constructor(scene, atlas, getBlockFn) {
    this.scene = scene;
    this.atlas = atlas;
    this.getBlock = getBlockFn;
    // FACE_MAP aligned with the atlas sheet via the atlas' own registry.
    this.FACE_MAP = {
      resolveTile: (id, face) => atlas.faceTile(id, face),
    };

    this.group = new THREE.Group();
    this.group.name = 'chunks';
    scene.add(this.group);

    this.chunks = new Map();     // "cx,cz" -> { cx, cz, meshes: [] }
    this.dirtyQueue = [];        // FIFO of keys awaiting rebuild
    this.queued = new Set();

    const tex = atlas.texture();
    this.materials = {
      opaque: new THREE.MeshLambertMaterial({ map: tex, vertexColors: true }),
      cutout: new THREE.MeshLambertMaterial({ map: tex, vertexColors: true, alphaTest: 0.5 }),
      glass: new THREE.MeshLambertMaterial({
        map: tex, vertexColors: true, transparent: true, depthWrite: false,
      }),
    };
  }

  chunkKey(cx, cz) { return cx + ',' + cz; }

  /** Synchronous initial build of every chunk column. */
  buildAll() {
    for (let cz = 0; cz < CHUNKS_H; cz++) {
      for (let cx = 0; cx < CHUNKS_W; cx++) {
        this.rebuildChunk(cx, cz);
      }
    }
    return this;
  }

  /**
   * Queue-safe block mutation from netcode/events: remeshes own chunk plus any
   * neighbour when the changed voxel touches a chunk border.
   */
  applyBlockDelta(x, y, z, v) {
    if (x < 0 || z < 0 || x >= SX || z >= SZ || y < 0 || y >= SY) return;
    const cx = x >> 4, cz = z >> 4;
    this.markDirty(cx, cz);
    const lx = x & 15, lz = z & 15;
    if (lx === 0) this.markDirty(cx - 1, cz);
    else if (lx === 15) this.markDirty(cx + 1, cz);
    if (lz === 0) this.markDirty(cx, cz - 1);
    else if (lz === 15) this.markDirty(cx, cz + 1);
    // Corner edits also feed the AO corner sample of the DIAGONAL chunk.
    if ((lx === 0 || lx === 15) && (lz === 0 || lz === 15)) {
      this.markDirty(cx + (lx ? 1 : -1), cz + (lz ? 1 : -1));
    }
  }

  markDirty(cx, cz) {
    if (cx < 0 || cz < 0 || cx >= CHUNKS_W || cz >= CHUNKS_H) return;
    const key = this.chunkKey(cx, cz);
    if (!this.chunks.has(key) || this.queued.has(key)) return;
    this.queued.add(key);
    this.dirtyQueue.push(key);
  }

  /** Drain the rebuild queue up to MAX_REBUILDS_PER_FRAME entries per frame. */
  update() {
    let n = 0;
    while (this.dirtyQueue.length > 0 && n < MAX_REBUILDS_PER_FRAME) {
      const key = this.dirtyQueue.shift();
      this.queued.delete(key);
      const c = this.chunks.get(key);
      if (c !== undefined) this.rebuildChunk(c.cx, c.cz);
      n++;
    }
    return n;
  }

  get stats() {
    return {
      chunks: this.chunks.size,
      queued: this.dirtyQueue.length,
      meshes: this.group.children.length,
    };
  }

  dispose() {
    for (const rec of this.chunks.values()) this.disposeRecord(rec);
    this.chunks.clear();
    this.dirtyQueue.length = 0;
    this.queued.clear();
    this.scene.remove(this.group);
    for (const m of Object.values(this.materials)) m.dispose();
  }

  disposeRecord(rec) {
    for (const mesh of rec.meshes) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    rec.meshes.length = 0;
  }

  rebuildChunk(cx, cz) {
    if (cx < 0 || cz < 0 || cx >= CHUNKS_W || cz >= CHUNKS_H) return;
    const key = this.chunkKey(cx, cz);
    let rec = this.chunks.get(key);
    if (rec === undefined) {
      rec = { cx, cz, meshes: [] };
      this.chunks.set(key, rec);
    } else {
      this.disposeRecord(rec);          // dispose-safe: old geometry freed first
    }

    const buckets = newBuckets();
    const x0 = cx << 4, z0 = cz << 4;
    const gb = this.getBlock;
    const rectOf = this.atlas.tileRect;
    const resolveTile = this.FACE_MAP.resolveTile;

    for (let ly = 0; ly < SY; ly++) {
      for (let lz = 0; lz < CHUNK_Z; lz++) {
        const wz = z0 + lz;
        for (let lx = 0; lx < CHUNK_X; lx++) {
          const wx = x0 + lx;
          const id = gb(wx, ly, wz);
          if (id === AIR) continue;
          for (let f = 0; f < 6; f++) {
            const fd = FACES[f];
            // Visible unless fully hidden: air, or see-through neighbour of another kind.
            const nb = gb(wx + fd.n[0], ly + fd.n[1], wz + fd.n[2]);
            if (!(nb === AIR || (isSeeThrough(nb) && nb !== id))) continue;

            const bucket = id === GLASS ? buckets.glass
              : id === LEAVES ? buckets.cutout
                : buckets.opaque;
            emitFace(bucket, wx, ly, wz, f, id, rectOf, resolveTile, gb);
          }
        }
      }
    }

    for (const name of Object.keys(buckets)) {
      const b = buckets[name];
      if (b.index.length === 0) continue;
      const mesh = buildMesh(b, this.materials[name]);
      mesh.name = name;
      if (name === 'glass') mesh.renderOrder = 2;
      rec.meshes.push(mesh);
      this.group.add(mesh);
    }
  }
}

function newBuckets() {
  const mk = () => ({ pos: [], nrm: [], col: [], uv: [], index: [], verts: 0 });
  return { opaque: mk(), cutout: mk(), glass: mk() };
}

/**
 * Emit one visible quad into a bucket with per-vertex baked colour:
 * AO level x directional shade (+ grass-top warm tint and hash jitter).
 * UVs map world-up onto the tile image top so side faces stand upright.
 */
function emitFace(bucket, wx, wy, wz, f, id, tileRectFn, resolveTile, gb) {
  const fd = FACES[f];
  const rect = tileRectFn(resolveTile(id, f));
  const base = bucket.verts;

  // Corner AO samples sit on the slab this face opens onto.
  const sx = wx + fd.n[0], sy = wy + fd.n[1], sz = wz + fd.n[2];
  const ux = fd.u[0], uy = fd.u[1], uz = fd.u[2];
  const vx = fd.v[0], vy = fd.v[1], vz = fd.v[2];

  const shade = FACE_SHADE[f];
  const grassTopFace = id === GRASS && f === 2;
  const warmR = grassTopFace ? 1.02 : 1;
  const warmG = grassTopFace ? 1.0 : 1;
  const warmB = grassTopFace ? 0.94 : 1;
  const jitBase = grassTopFace ? (posJitter(wx, wy, wz) - 50) * 0.0006 : 0; // ±3%

  const ao = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const cu = CORNER_UV[c][0], cv = CORNER_UV[c][1];
    const su = cu === 1 ? 1 : -1;
    const sv = cv === 1 ? 1 : -1;
    const s1 = occ(gb, sx + su * ux, sy + su * uy, sz + su * uz);
    const s2 = occ(gb, sx + sv * vx, sy + sv * vy, sz + sv * vz);
    const co = occ(gb, sx + su * ux + sv * vx, sy + su * uy + sv * vy, sz + su * uz + sv * vz);
    const lvl = aoLevel(s1, s2, co);
    ao[c] = lvl;

    bucket.pos.push(
      wx + fd.o[0] + cu * ux + cv * vx,
      wy + fd.o[1] + cu * uy + cv * vy,
      wz + fd.o[2] + cu * uz + cv * vz,
    );
    bucket.nrm.push(fd.n[0], fd.n[1], fd.n[2]);

    const k = lvl * shade * (1 + jitBase);   // per-position variance, uniform per quad
    bucket.col.push(k * warmR, k * warmG, k * warmB);

    bucket.uv.push(cu === 0 ? rect.u0 : rect.u1, cv === 0 ? rect.v1 : rect.v0);
  }

  // Standard anisotropy fix: flip the split diagonal so AO gradients interpolate cleanly.
  if (ao[0] + ao[2] > ao[1] + ao[3]) {
    bucket.index.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
  } else {
    bucket.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  bucket.verts += 4;
}

function occ(gb, x, y, z) {
  return gb(x, y, z) !== AIR ? 1 : 0;
}

function buildMesh(b, material) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
  g.setIndex(new THREE.Uint32BufferAttribute(b.index, 1));
  g.computeBoundingSphere();   // meshes sit at origin using absolute world coords
  const mesh = new THREE.Mesh(g, material);
  mesh.matrixAutoUpdate = false;
  return mesh;
}
