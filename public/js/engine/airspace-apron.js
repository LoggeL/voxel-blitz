// The airspace apron's ground (shared/world/airspace.js): the outer valley
// between a map with aircraft and its horizon ranges, drawn as ONE indexed
// heightfield with the backdrop's baked light and aerial-perspective fog
// (map-backdrop.js), so it melts into the ranges behind it.
//
// The authority is the apron's cell grid (8 m cells, 16 m terraces past the
// fine band); the mesh is a smooth surface through it: every vertex takes the
// mean ground of the cells it touches, on an 8 m lattice inside the fine band
// and a 16 m lattice beyond (the odd fine vertices on that seam are pinned to
// the coarse edge, so the two grids share their border without cracks). Map
// edge vertices take the outside cells only, which start at the map rim's
// own height. Forest cells carry their canopy (dark crowns over the woods)
// and river cells add a flat water sheet at the surface height.

import * as THREE from '../vendor/three.module.js';
import { fbm2 } from '../../../shared/noise.js';
import { APRON_KIND } from '../../../shared/world/airspace.js';
import { backdropBuilder, backdropAirMaterial } from './map-backdrop.js';

const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * @param {object} palette mapAtmosphere() result (palette.backdrop.apron configures colours)
 * @param {object} apron apronFor() result
 * @param {{sx:number,sz:number}} dimensions map extents
 * @returns {{group:THREE.Group, stats:{draws:number, vertices:number}, dispose:()=>void}|null}
 */
export function buildAirspaceApron(palette = {}, apron, dimensions) {
  const cfg = palette.backdrop;
  if (!cfg || cfg.lit || !apron || !dimensions) return null;
  const style = cfg.apron || {};
  const colors = (style.colors || ['#5d7238']).map(lin);
  const bank = lin(style.bank || '#6b6648');
  const water = lin(cfg.sea?.color || '#36505a');
  const jitter = style.jitter ?? 0.08;
  const b = backdropBuilder(palette, cfg);
  const { sx, sz } = dimensions, { cell, fineBand } = apron, reach = -apron.origin;
  const inside = (x, z) => x > 0 && x < sx && z > 0 && z < sz;
  const gap = (x, z) => Math.max(0, -x, x - sx, -z, z - sz);

  // Mean ground (and the dominant kind) of the outside cells around a lattice point.
  const sample = (x, z) => {
    let sum = 0, n = 0, forest = 0, waterCells = 0, kind = null;
    for (const [dx, dz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
      const px = x + dx * cell, pz = z + dz * cell;
      if (px >= 0 && px < sx && pz >= 0 && pz < sz) continue;
      const h = apron.groundAt(px, pz);
      if (h < 0) continue;
      sum += h; n++;
      const k = apron.kindAt(px, pz);
      if (k === APRON_KIND.FOREST) forest++;
      else if (k === APRON_KIND.WATER) waterCells++;
      if (kind == null || k === APRON_KIND.FOREST) kind = k;
    }
    return n ? { y: sum / n, kind: forest >= 2 ? APRON_KIND.FOREST : waterCells >= 2 ? APRON_KIND.WATER : kind } : null;
  };

  // One lattice: (x0..x1, z0..z1) at `step`, skipping the map interior; vertices are shared.
  const lattice = (x0, z0, x1, z1, step, keep, pin) => {
    const nx = Math.round((x1 - x0) / step) + 1, nz = Math.round((z1 - z0) / step) + 1;
    const ids = new Int32Array(nx * nz).fill(-1), heights = new Float32Array(nx * nz), kinds = new Uint8Array(nx * nz);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const x = x0 + i * step, z = z0 + j * step;
      if (inside(x, z) || !keep(x, z)) continue;
      const s = pin?.(x, z) ?? sample(x, z);
      if (!s) continue;
      heights[j * nx + i] = s.y; kinds[j * nx + i] = s.kind ?? 0; ids[j * nx + i] = 0;
    }
    const at = (i, j) => heights[Math.min(nz - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))];
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (ids[k] < 0) continue;
      const x = x0 + i * step, z = z0 + j * step, y = heights[k];
      // Normal from the lattice slope (edges reuse their own height).
      const gx = (at(i + 1, j) - at(i - 1, j)) / (2 * step), gz = (at(i, j + 1) - at(i, j - 1)) / (2 * step);
      const len = Math.hypot(gx, 1, gz), n = [-gx / len, 1 / len, -gz / len];
      const steep = clamp01((Math.hypot(gx, gz) - 0.35) / 0.6);
      let c = colors[kinds[k]] || colors[0];
      if (kinds[k] === APRON_KIND.WATER) c = bank;
      c = mix(c, colors[APRON_KIND.ROCK] || c, steep * 0.7);
      c = mul(c, 1 + jitter * fbm2(x / 46, z / 46, 77, 3));
      const haze = clamp01(gap(x, z) / (reach * 1.15)) * 0.25;
      ids[k] = b.position.length / 3;
      // Soft relief light: half the slope normal, so lee sides stay ground, not shadow.
      const sl = Math.hypot(n[0] * 0.5, 0.5 + n[1] * 0.5, n[2] * 0.5);
      b.vertex(x, y, z, n[0], n[1], n[2], b.shade(c, n[0] * 0.5 / sl, (0.5 + n[1] * 0.5) / sl, n[2] * 0.5 / sl), haze, 0);
    }
    for (let j = 0; j + 1 < nz; j++) for (let i = 0; i + 1 < nx; i++) {
      const a = ids[j * nx + i], c = ids[j * nx + i + 1], d = ids[(j + 1) * nx + i], e = ids[(j + 1) * nx + i + 1];
      if (a < 0 || c < 0 || d < 0 || e < 0) continue;
      b.index.push(a, d, e, a, e, c);
    }
    return { at: (x, z) => heights[Math.round((z - z0) / step) * nx + Math.round((x - x0) / step)] };
  };

  // Coarse ring first (16 m), then the fine band (8 m) pinned to it on their shared border.
  const coarse = cell * 2, f = fineBand, r = reach;
  const outer = lattice(-r, -r, sx + r, sz + r, coarse, (x, z) => gap(x, z) >= f);
  lattice(-f, -f, sx + f, sz + f, cell, () => true, (x, z) => {
    if (gap(x, z) < f) return null;
    // On the seam: the coarse surface (odd fine vertices lie halfway along a coarse edge).
    const ox = Math.floor((x + r) / coarse) * coarse - r, oz = Math.floor((z + r) / coarse) * coarse - r;
    const tx = (x - ox) / coarse, tz = (z - oz) / coarse;
    const y = tx > 0 ? outer.at(ox, oz) * (1 - tx) + outer.at(ox + coarse, oz) * tx
      : outer.at(ox, oz) * (1 - tz) + outer.at(ox, oz + coarse) * tz;
    return { y, kind: apron.kindAt(x, z) };
  });

  // River water: one flat sheet per water cell at the surface height.
  let sheets = 0;
  for (let iz = 0; iz < apron.nz; iz++) for (let ix = 0; ix < apron.nx; ix++) {
    const i = iz * apron.nx + ix, y = apron.water[i];
    if (!(y > 0)) continue;
    const x0 = apron.origin + ix * cell, z0 = apron.origin + iz * cell;
    // Overlap the neighbours a little so the sheet has no seams between cells.
    const haze = clamp01(gap(x0, z0) / (reach * 1.15)) * 0.4;
    b.quad([x0 - 0.5, y, z0 + cell + 0.5], [x0 + cell + 0.5, y, z0 + cell + 0.5], [x0 + cell + 0.5, y, z0 - 0.5], [x0 - 0.5, y, z0 - 0.5],
      [0, 1, 0], [b.shade(water, 0, 1, 0)], { haze: [haze, haze, haze, haze] });
    sheets++;
  }

  const geometry = b.build({ normals: false });
  // The apron fogs like the map's own terrain (full scene fog, little extra
  // air), so the map does not stand out as a hazier box from the apron.
  const material = backdropAirMaterial({ ...cfg, air: { strength: 0.12, near: 500, far: 1600, fog: 1, ...style.air } }, 'backdrop-air-v5');
  material.name = 'airspace-apron';
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'airspace-apron';
  mesh.matrixAutoUpdate = false;
  const group = new THREE.Group();
  group.name = 'airspace-apron';
  group.add(mesh);
  return {
    group,
    stats: { draws: 1, vertices: geometry.attributes.position.count, waterCells: sheets },
    dispose() {
      group.removeFromParent();
      geometry.dispose();
      material.dispose();
      group.clear();
    },
  };
}
