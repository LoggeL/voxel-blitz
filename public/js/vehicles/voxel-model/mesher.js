// Greedy voxel mesher for vehicle parts. Faces merge when they share the
// resolved palette entry and the same four ambient-occlusion corners, so AO
// stays exact while flat camo blots collapse into a few quads. Each quad also
// carries its local metre coordinates and a 4-bit mask of convex edges; the
// vehicle material draws a thin highlight "lip" along those edges so voxel
// silhouettes read at range without extra geometry.
import * as THREE from '../../vendor/three.module.js';
import { VOXEL } from './dsl.js';

const AO_LEVELS = [0.52, 0.7, 0.86, 1];
const DIRECTIONS = Object.freeze([
  { d: 0, s: 1 }, { d: 0, s: -1 }, { d: 1, s: 1 }, { d: 1, s: -1 }, { d: 2, s: 1 }, { d: 2, s: -1 },
]);

/**
 * Mesh one part. `resolve(name, x, y, z)` returns a palette entry for a voxel
 * centre in hull metres. `include(tag)` filters voxels (wreck hulls drop the
 * tags that broke away; a fragment keeps only its own tag).
 * Returns { opaque, glass, triangles } with null geometries when empty.
 */
export function meshVoxelPart(part, resolve, { include = null, pivot = part.pivot } = {}) {
  const bounds = part.bounds();
  const grid = part.grid || [0, 0, 0];
  if (!bounds) return { opaque: null, glass: null, triangles: 0 };
  const min = bounds.min.map(v => v - 1), max = bounds.max.map(v => v + 1);
  const dims = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const count = dims[0] * dims[1] * dims[2];
  // 0 empty, otherwise palette id + 1; glass flagged separately.
  const cells = new Int32Array(count).fill(-1);
  const glassGrid = new Uint8Array(count);
  const entries = [];
  const entryIndex = new Map();
  const index = (x, y, z) => ((x - min[0]) * dims[1] + (y - min[1])) * dims[2] + (z - min[2]);
  for (const [x, y, z, material, tag] of part.voxels()) {
    if (include && !include(tag)) continue;
    const entry = resolve(material, part.cc(x, 0), part.cc(y, 1), part.cc(z, 2));
    let id = entryIndex.get(entry);
    if (id === undefined) { id = entries.length; entries.push(entry); entryIndex.set(entry, id); }
    const i = index(x, y, z);
    cells[i] = id;
    if (entry.glass) glassGrid[i] = 1;
  }
  const inside = (x, y, z) => x >= min[0] && y >= min[1] && z >= min[2] && x < max[0] && y < max[1] && z < max[2];
  const opaqueAt = (x, y, z) => inside(x, y, z) && cells[index(x, y, z)] >= 0 && !glassGrid[index(x, y, z)];
  const glassAt = (x, y, z) => inside(x, y, z) && glassGrid[index(x, y, z)] === 1;

  const build = glassPass => {
    const positions = [], normals = [], colors = [], pal = [], lip = [], edge = [], indices = [];
    const p = [0, 0, 0], q = [0, 0, 0];
    for (const { d, s } of DIRECTIONS) {
      const u = (d + 1) % 3, v = (d + 2) % 3;
      const du = dims[u], dv = dims[v];
      const mask = new Int32Array(du * dv);
      for (let layer = min[d]; layer < max[d]; layer++) {
        mask.fill(-1);
        let any = false;
        for (let a = 0; a < du; a++) for (let b = 0; b < dv; b++) {
          p[d] = layer; p[u] = min[u] + a; p[v] = min[v] + b;
          const solid = glassPass ? glassAt(p[0], p[1], p[2]) : opaqueAt(p[0], p[1], p[2]);
          if (!solid) continue;
          q[0] = p[0]; q[1] = p[1]; q[2] = p[2]; q[d] += s;
          const blocked = glassPass ? (opaqueAt(q[0], q[1], q[2]) || glassAt(q[0], q[1], q[2])) : opaqueAt(q[0], q[1], q[2]);
          if (blocked) continue;
          // Ambient occlusion from the opaque cells around the face's outer layer.
          let ao = 0;
          for (let corner = 0; corner < 4; corner++) {
            const cu = corner & 1 ? 1 : -1, cv = corner & 2 ? 1 : -1;
            const side1 = (() => { const r = [...q]; r[u] += cu; return opaqueAt(r[0], r[1], r[2]); })();
            const side2 = (() => { const r = [...q]; r[v] += cv; return opaqueAt(r[0], r[1], r[2]); })();
            const diag = (() => { const r = [...q]; r[u] += cu; r[v] += cv; return opaqueAt(r[0], r[1], r[2]); })();
            const level = side1 && side2 ? 0 : 3 - (side1 + side2 + diag);
            ao |= level << (corner * 2);
          }
          mask[a * dv + b] = cells[index(p[0], p[1], p[2])] | (ao << 16);
          any = true;
        }
        if (!any) continue;
        for (let a = 0; a < du; a++) for (let b = 0; b < dv;) {
          const keyValue = mask[a * dv + b];
          if (keyValue < 0) { b++; continue; }
          let h = 1;
          while (b + h < dv && mask[a * dv + b + h] === keyValue) h++;
          let w = 1;
          grow: while (a + w < du) {
            for (let k = 0; k < h; k++) if (mask[(a + w) * dv + b + k] !== keyValue) break grow;
            w++;
          }
          for (let i = 0; i < w; i++) for (let k = 0; k < h; k++) mask[(a + i) * dv + b + k] = -1;
          emitQuad(d, s, u, v, layer, min[u] + a, min[v] + b, w, h, keyValue);
          b += h;
        }
      }
    }

    function convex(d, s, u, v, layer, ua, va, w, h, side) {
      // An edge is convex when the voxel beyond it (same layer) is empty.
      const r = [0, 0, 0];
      let open = 0, total = 0;
      const along = side < 2 ? h : w;
      for (let i = 0; i < along; i++) {
        r[d] = layer;
        if (side < 2) { r[u] = side === 0 ? ua - 1 : ua + w; r[v] = va + i; }
        else { r[v] = side === 2 ? va - 1 : va + h; r[u] = ua + i; }
        total++;
        const filled = glassPass ? glassAt(r[0], r[1], r[2]) || opaqueAt(r[0], r[1], r[2]) : opaqueAt(r[0], r[1], r[2]);
        if (!filled) open++;
      }
      return open * 2 > total;
    }

    function emitQuad(d, s, u, v, layer, ua, va, w, h, keyValue) {
      const entry = entries[keyValue & 0xffff];
      const ao = keyValue >>> 16;
      const plane = (s > 0 ? layer + 1 : layer) * VOXEL;
      const base = positions.length / 3;
      const n = [0, 0, 0]; n[d] = s;
      let edges = 0;
      for (let side = 0; side < 4; side++) if (convex(d, s, u, v, layer, ua, va, w, h, side)) edges |= 1 << side;
      for (let corner = 0; corner < 4; corner++) {
        const cu = corner & 1, cv = (corner >> 1) & 1;
        const pos = [0, 0, 0];
        pos[d] = plane + grid[d] - pivot[d];
        pos[u] = (ua + cu * w) * VOXEL + grid[u] - pivot[u];
        pos[v] = (va + cv * h) * VOXEL + grid[v] - pivot[v];
        positions.push(pos[0], pos[1], pos[2]);
        normals.push(n[0], n[1], n[2]);
        const shade = glassPass ? 1 : AO_LEVELS[(ao >> (corner * 2)) & 3];
        colors.push(entry.color[0] * shade, entry.color[1] * shade, entry.color[2] * shade);
        pal.push(entry.rough, entry.metal, entry.emissive);
        lip.push(cu * w * VOXEL, cv * h * VOXEL, w * VOXEL, h * VOXEL);
        edge.push(edges);
      }
      const a0 = (ao) & 3, a1 = (ao >> 2) & 3, a2 = (ao >> 4) & 3, a3 = (ao >> 6) & 3;
      // Flip the diagonal toward the brighter pair so AO gradients stay symmetric.
      let tris = a0 + a3 > a1 + a2
        ? [base, base + 1, base + 3, base, base + 3, base + 2]
        : [base, base + 1, base + 2, base + 1, base + 3, base + 2];
      // Orient outward: compare the first triangle's winding to the normal.
      const at = i => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
      const [p0, p1, p2] = [at(tris[0]), at(tris[1]), at(tris[2])];
      const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
      const cross = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      if (cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2] < 0) tris = [tris[0], tris[2], tris[1], tris[3], tris[5], tris[4]];
      indices.push(...tris);
    }

    if (!indices.length) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute('aPal', new THREE.Float32BufferAttribute(pal, 3));
    geometry.setAttribute('aLip', new THREE.Float32BufferAttribute(lip, 4));
    geometry.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
    geometry.setIndex(positions.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(indices, 1) : new THREE.Uint16BufferAttribute(indices, 1));
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    geometry.userData.triangles = indices.length / 3;
    geometry.userData.vehicleVoxel = true;
    return geometry;
  };

  const opaque = build(false), glass = build(true);
  return { opaque, glass, triangles: (opaque?.userData.triangles || 0) + (glass?.userData.triangles || 0) };
}
