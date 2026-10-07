// Reusable Frontier set pieces: hedgerows, field walls, sandbag lines, hay
// bales, trees, plaster houses, wrecks and small yard props. Every helper
// stands on the terrain surface and records the cover it creates.

import {
  AIR, WOOD, LEAVES, PLANK, GLASS, METAL, RUST, CONCRETE, BRICK, BARRICADE, DIRT,
  MC_LOG, PINE_LEAVES, BIRCH_LOG, WHITE_PLASTER, TERRACOTTA_ROOF, COBBLE_WALL, TIMBER,
  FIELD_WHEAT, SCORCHED_EARTH, CORRUGATED_STEEL, DUST_CRATE, ACCENT, PALE, MC_WATER,
} from '../blocks.js';
import { roadClearance } from './plan.js';

/** 4-connected cells along a line, so walls never leak at diagonals. */
export function lineCells(ax, az, bx, bz) {
  let x = Math.floor(ax), z = Math.floor(az);
  const x1 = Math.floor(bx), z1 = Math.floor(bz);
  const cells = [[x, z]];
  const dx = Math.abs(x1 - x), dz = Math.abs(z1 - z), sx = Math.sign(x1 - x), sz = Math.sign(z1 - z);
  let err = dx - dz;
  while (x !== x1 || z !== z1) {
    if (2 * err > -dz && (2 * err < dx ? Math.abs(err - dz) <= Math.abs(err + dx) : true) && x !== x1) { err -= dz; x += sx; }
    else { err += dx; z += sz; }
    cells.push([x, z]);
  }
  return cells;
}

/** A wall of `height` above the local ground along a polyline, with gaps. */
export function groundWall(kit, points, height, material, { gapEvery = 0, gapWidth = 3, cap = null, kind = 'wall', roads = 1 } = {}) {
  let n = 0;
  for (let i = 1; i < points.length; i++) {
    const cells = lineCells(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
    for (const [x, z] of cells) {
      n++;
      if (gapEvery && n % gapEvery < gapWidth) continue;
      // Roads stay open to vehicles: walls and hedges break for every track.
      if (roads && roadClearance(x + 0.5, z + 0.5) < roads) continue;
      const g = kit.top(x, z);
      if (kit.get(x, g + 1, z) === MC_WATER) continue;              // never wall the river
      kit.box(x, g + 1, z, x, g + height, z, material);
      if (cap) kit.set(x, g + height + 1, z, cap);
    }
  }
  kit.feature('cover', { cover: kind, points: points.map(p => [p[0], p[1]]), height });
}

export const hedge = (kit, points, opts = {}) => groundWall(kit, points, opts.height ?? 2, LEAVES, { gapEvery: opts.gapEvery ?? 23, gapWidth: 3, kind: 'hedge' });
export const fieldWall = (kit, points, opts = {}) => groundWall(kit, points, opts.height ?? 2, COBBLE_WALL, { gapEvery: opts.gapEvery ?? 0, gapWidth: 3, kind: 'stone wall' });
export const sandbags = (kit, points, opts = {}) => groundWall(kit, points, opts.height ?? 2, BARRICADE, { gapEvery: opts.gapEvery ?? 0, gapWidth: 2, kind: 'sandbags' });

/** Round hay bale, 2 high, a solid crouch cover. */
export function hayBale(kit, x, z, r = 1.6) {
  const g = kit.top(x, z);
  kit.cylinder(x, z, r, g + 1, g + 2, FIELD_WHEAT);
  kit.feature('cover', { cover: 'hay', x, z, height: 2 });
}

export function crateStack(kit, x, z, w = 2, d = 2, h = 2, m = DUST_CRATE) {
  const g = kit.top(x, z);
  kit.box(x, g + 1, z, x + w - 1, g + h, z + d - 1, m);
  kit.feature('cover', { cover: 'crates', x: x + w / 2, z: z + d / 2, height: h });
}

// ------------------------------------------------------------------ trees

export function pine(kit, x, z, height, rng) {
  const g = kit.top(x, z);
  const trunk = Math.max(3, Math.round(height * 0.3));
  kit.box(x, g + 1, z, x, g + height - 1, z, MC_LOG);
  // Stacked tiers narrow toward the tip.
  let y = g + trunk;
  let r = Math.min(3.4, 1.6 + height * 0.14);
  while (y < g + height) {
    kit.cylinderLayer(x + 0.5, z + 0.5, r, y, PINE_LEAVES);
    if (r > 1.6) kit.cylinderLayer(x + 0.5, z + 0.5, r - 0.9, y + 1, PINE_LEAVES);
    y += r > 1.6 ? 2 : 1;
    r -= 0.55 + rng() * 0.2;
    if (r < 0.7) r = 0.7;
  }
  kit.set(x, g + height, z, PINE_LEAVES);
}

export function oak(kit, x, z, height, rng) {
  const g = kit.top(x, z);
  kit.box(x, g + 1, z, x, g + height - 2, z, WOOD);
  const r = 2.2 + rng() * 0.9;
  kit.ellipsoid(x + 0.5, g + height - 1.5, z + 0.5, r, r * 0.72, r, LEAVES, true);
}

export function birch(kit, x, z, height, rng) {
  const g = kit.top(x, z);
  kit.box(x, g + 1, z, x, g + height - 1, z, BIRCH_LOG);
  const r = 1.5 + rng() * 0.5;
  kit.ellipsoid(x + 0.5, g + height - 1, z + 0.5, r, r * 1.3, r, LEAVES, true);
}

/** Burnt snag: blackened trunk, a broken limb, scorched roots. */
export function deadTree(kit, x, z, height, rng) {
  const g = kit.top(x, z);
  kit.box(x, g + 1, z, x, g + height, z, MC_LOG);
  const side = rng() < 0.5 ? 1 : -1;
  kit.box(x + side, g + height - 2, z, x + side * 2, g + height - 2, z, MC_LOG);
  kit.set(x, g, z, SCORCHED_EARTH);
}

// ------------------------------------------------------------- buildings

/**
 * Plaster house: `floors` storeys of 4 voxels, stepped terracotta gable roof,
 * plank upper floor with a stair, doors on the given sides and glazed windows.
 * Returns the eave height. Interior stays enterable.
 */
export function plasterHouse(kit, x0, z0, x1, z1, { floors = 2, axis = 'x', doors = ['s'], wall = WHITE_PLASTER, roof = TERRACOTTA_ROOF, base = COBBLE_WALL, floorY = null } = {}) {
  const y = floorY ?? kit.maxTop(x0, z0, x1, z1);
  kit.foundation(x0, z0, x1, z1, y, PLANK, base);
  const eave = y + floors * 4;
  kit.walls(x0, z0, x1, z1, y + 1, eave, wall);
  kit.box(x0, y + 1, z0, x1, y + 1, z0, base); kit.box(x0, y + 1, z1, x1, y + 1, z1, base);
  kit.box(x0, y + 1, z0, x0, y + 1, z1, base); kit.box(x1, y + 1, z0, x1, y + 1, z1, base);
  // Corner quoins and timber lintels give the plaster some structure.
  for (const [cx, cz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) kit.box(cx, y + 2, cz, cx, eave, cz, COBBLE_WALL);
  for (let f = 1; f < floors; f++) {
    const fy = y + f * 4, base = fy - 4;
    kit.box(x0 + 1, fy, z0 + 1, x1 - 1, fy, z1 - 1, PLANK);
    // Stair against the back wall: three steps and an opening above them.
    kit.box(x0 + 1, fy, z1 - 2, x0 + 3, fy, z1 - 1, AIR);
    for (let s = 0; s < 3; s++) kit.box(x0 + 1 + s, base + 1, z1 - 2, x0 + 1 + s, base + 1 + s, z1 - 1, PLANK);
  }
  // Windows: every third cell on each storey, two high.
  for (let f = 0; f < floors; f++) {
    const wy = y + 2 + f * 4;
    for (let x = x0 + 2; x < x1 - 1; x += 3) { kit.box(x, wy, z0, x, wy + 1, z0, GLASS); kit.box(x, wy, z1, x, wy + 1, z1, GLASS); }
    for (let z = z0 + 2; z < z1 - 1; z += 3) { kit.box(x0, wy, z, x0, wy + 1, z, GLASS); kit.box(x1, wy, z, x1, wy + 1, z, GLASS); }
  }
  const mx = (x0 + x1) >> 1, mz = (z0 + z1) >> 1;
  for (const d of doors) {
    if (d === 's') kit.box(mx - 1, y + 1, z1, mx, y + 3, z1, AIR);
    if (d === 'n') kit.box(mx - 1, y + 1, z0, mx, y + 3, z0, AIR);
    if (d === 'e') kit.box(x1, y + 1, mz - 1, x1, y + 3, mz, AIR);
    if (d === 'w') kit.box(x0, y + 1, mz - 1, x0, y + 3, mz, AIR);
  }
  kit.box(x0 - 1, eave + 1, z0 - 1, x1 + 1, eave + 1, z1 + 1, roof);
  kit.box(x0, eave + 1, z0, x1, eave + 1, z1, roof);
  const ridge = kit.gableRoof(x0 - 1, z0 - 1, x1 + 1, z1 + 1, eave + 1, axis, roof, wall);
  kit.feature('building', { minX: x0, minZ: z0, maxX: x1, maxZ: z1, floorY: y, eave, ridge, floors, enterable: doors.length > 0 });
  return eave;
}

/** Simple open shed: posts, corrugated roof, optional back wall. */
export function shed(kit, x0, z0, x1, z1, height, { roof = CORRUGATED_STEEL, back = null, post = TIMBER } = {}) {
  const y = kit.maxTop(x0, z0, x1, z1);
  for (const [px, pz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) kit.box(px, kit.top(px, pz) + 1, pz, px, y + height, pz, post);
  if (back === 'n') kit.box(x0, y + 1, z0, x1, y + height, z0, post);
  if (back === 's') kit.box(x0, y + 1, z1, x1, y + height, z1, post);
  if (back === 'w') kit.box(x0, y + 1, z0, x0, y + height, z1, post);
  if (back === 'e') kit.box(x1, y + 1, z0, x1, y + height, z1, post);
  kit.box(x0 - 1, y + height + 1, z0 - 1, x1 + 1, y + height + 1, z1 + 1, roof);
  kit.feature('building', { minX: x0, minZ: z0, maxX: x1, maxZ: z1, floorY: y, eave: y + height, enterable: true, open: true });
}

// ------------------------------------------------------------------ wrecks

/** Burnt-out tank hull with a dropped barrel; solid cover and a smoke anchor. */
export function wreckTank(kit, x, z, alongX = true) {
  const g = kit.top(x, z);
  const [hx, hz] = alongX ? [4, 2] : [2, 4];
  kit.box(x - hx, g + 1, z - hz, x + hx, g + 1, z + hz, RUST);
  kit.box(x - hx + 1, g + 2, z - hz, x + hx - 1, g + 2, z + hz, METAL);
  kit.box(x - 1, g + 3, z - 1, x + 1, g + 3, z + 1, RUST);
  if (alongX) kit.box(x + 2, g + 3, z, x + 6, g + 3, z, METAL); else kit.box(x, g + 3, z + 2, x, g + 3, z + 6, METAL);
  kit.box(x - hx - 1, g, z - hz - 1, x + hx + 1, g, z + hz + 1, SCORCHED_EARTH);
  kit.feature('cover', { cover: 'wreck', x, z, height: 3 });
  return kit.feature('wreck', { id: `wreck-tank-${x}-${z}`, type: 'tank', x: x + 0.5, y: g + 4, z: z + 0.5 });
}

export function wreckTruck(kit, x, z, alongX = true) {
  const g = kit.top(x, z);
  const [hx, hz] = alongX ? [4, 1] : [1, 4];
  kit.box(x - hx, g + 1, z - hz, x + hx, g + 1, z + hz, RUST);
  if (alongX) { kit.box(x + 2, g + 2, z - hz, x + hx, g + 3, z + hz, RUST); kit.box(x + 3, g + 3, z - hz, x + 3, g + 3, z + hz, GLASS); kit.box(x - hx, g + 2, z - hz, x + 1, g + 2, z - hz, CORRUGATED_STEEL); }
  else { kit.box(x - hx, g + 2, z + 2, x + hx, g + 3, z + hz, RUST); kit.box(x - hx, g + 3, z + 3, x + hx, g + 3, z + 3, GLASS); kit.box(x - hx, g + 2, z - hz, x - hx, g + 2, z + 1, CORRUGATED_STEEL); }
  kit.box(x - hx - 1, g, z - hz - 1, x + hx + 1, g, z + hz + 1, SCORCHED_EARTH);
  kit.feature('cover', { cover: 'wreck', x, z, height: 3 });
  return kit.feature('wreck', { id: `wreck-truck-${x}-${z}`, type: 'truck', x: x + 0.5, y: g + 4, z: z + 0.5 });
}

/** Crashed helicopter: nose-down fuselage, snapped boom, a bent rotor blade. */
export function wreckHelicopter(kit, x, z) {
  const g = kit.top(x, z);
  kit.box(x - 2, g + 1, z - 1, x + 2, g + 2, z + 1, METAL);
  kit.box(x - 1, g + 3, z - 1, x + 1, g + 3, z + 1, METAL);
  kit.box(x + 3, g + 1, z, x + 3, g + 1, z, GLASS);
  kit.box(x - 7, g + 2, z, x - 3, g + 2, z, RUST);
  kit.box(x - 8, g + 3, z, x - 8, g + 4, z, RUST);
  kit.line(x - 4, g + 4, z - 5, x + 4, g + 4, z + 5, METAL);
  kit.box(x - 3, g, z - 2, x + 3, g, z + 2, SCORCHED_EARTH);
  kit.feature('cover', { cover: 'wreck', x, z, height: 3 });
  return kit.feature('wreck', { id: `wreck-helicopter-${x}-${z}`, type: 'helicopter', x: x + 0.5, y: g + 5, z: z + 0.5 });
}

/** Field gate posts and a short fence segment of timber rails. */
export function fence(kit, points) {
  for (let i = 1; i < points.length; i++) {
    const cells = lineCells(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
    cells.forEach(([x, z], k) => {
      const g = kit.top(x, z);
      if (k % 4 === 0) kit.box(x, g + 1, z, x, g + 2, z, TIMBER);
      else kit.set(x, g + 2, z, PLANK);
    });
  }
}

/** Painted helipad / apron ring used by the airfields. */
export function ring(kit, cx, cz, r0, r1, y, m) {
  for (let z = Math.floor(cz - r1); z <= Math.ceil(cz + r1); z++) for (let x = Math.floor(cx - r1); x <= Math.ceil(cx + r1); x++) {
    const d = Math.hypot(x + 0.5 - cx, z + 0.5 - cz);
    if (d >= r0 && d <= r1) kit.set(x, y, z, m);
  }
}

export { AIR, DIRT, CONCRETE, BRICK, ACCENT, PALE, GLASS };
