// Desert set pieces for Redrock Canyon: adobe houses with flat roofs and
// vigas, palms, saguaro cacti, scrub, boulders, steel lattice towers and
// rail track. Every helper stands on the terrain surface (kit.top) and
// records what it builds; plants only fill air, so they never cut a wall.

import {
  AIR, DUST_PLASTER, DUST_WOOD, DUST_SANDSTONE, DUST_ROCK, LEAVES, MC_CACTUS, PLANK, GLASS, METAL, RUST, TIMBER,
  GRAVEL, WOOD,
} from '../blocks.js';

/**
 * Adobe: thick plaster walls, a flat roof behind a one-voxel parapet with
 * timber vigas poking through, doors on the given sides and small windows.
 * `floors` storeys of 4 voxels; an upper storey is reached by a stair.
 */
export function adobe(kit, x0, z0, x1, z1, { floors = 1, doors = ['s'], wall = DUST_PLASTER, floorY = null, id = null, hard = false } = {}) {
  const y = floorY ?? kit.maxTop(x0, z0, x1, z1);
  kit.foundation(x0, z0, x1, z1, y, PLANK, DUST_SANDSTONE);
  const eave = y + floors * 4;
  kit.walls(x0, z0, x1, z1, y + 1, eave, wall);
  for (let f = 1; f < floors; f++) {
    const fy = y + f * 4;
    kit.box(x0 + 1, fy, z0 + 1, x1 - 1, fy, z1 - 1, PLANK);
    kit.box(x0 + 1, fy, z1 - 2, x0 + 3, fy, z1 - 1, AIR);
    for (let s = 0; s < 3; s++) kit.box(x0 + 1 + s, fy - 3, z1 - 2, x0 + 1 + s, fy - 3 + s, z1 - 1, PLANK);
  }
  for (let f = 0; f < floors; f++) {
    const wy = y + 2 + f * 4;
    for (let x = x0 + 2; x < x1 - 1; x += 4) { kit.set(x, wy, z0, GLASS); kit.set(x, wy, z1, GLASS); }
    for (let z = z0 + 2; z < z1 - 1; z += 4) { kit.set(x0, wy, z, GLASS); kit.set(x1, wy, z, GLASS); }
  }
  // Flat roof, parapet and vigas.
  kit.box(x0, eave + 1, z0, x1, eave + 1, z1, wall);
  kit.walls(x0, z0, x1, z1, eave + 2, eave + 2, wall);
  for (let x = x0 + 1; x < x1; x += 3) { kit.set(x, eave, z0 - 1, DUST_WOOD); kit.set(x, eave, z1 + 1, DUST_WOOD); }
  const mx = (x0 + x1) >> 1, mz = (z0 + z1) >> 1;
  for (const d of doors) {
    if (d === 's') kit.box(mx - 1, y + 1, z1, mx, y + 3, z1, AIR);
    if (d === 'n') kit.box(mx - 1, y + 1, z0, mx, y + 3, z0, AIR);
    if (d === 'e') kit.box(x1, y + 1, mz - 1, x1, y + 3, mz, AIR);
    if (d === 'w') kit.box(x0, y + 1, mz - 1, x0, y + 3, mz, AIR);
  }
  kit.feature('building', { ...(id ? { id } : {}), minX: x0, minZ: z0, maxX: x1, maxZ: z1, floorY: y, eave, ridge: eave + 2, floors,
    enterable: doors.length > 0, ...(hard ? { hard: true } : {}) });
  return eave;
}

/** Date palm: a leaning tan trunk and a drooping star of fronds. */
export function palm(kit, x, z, height, rng) {
  const g = kit.top(x, z);
  const lean = rng() < 0.5 ? 1 : -1, alongX = rng() < 0.5;
  let tx = x, tz = z;
  for (let y = 1; y <= height; y++) {
    if (y === Math.round(height * 0.6)) { if (alongX) tx += lean; else tz += lean; }
    kit.fillAir(tx, g + y, tz, tx, g + y, tz, DUST_WOOD);
  }
  const top = g + height + 1;
  kit.fillAir(tx, top, tz, tx, top, tz, LEAVES);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    kit.fillAir(tx + dx, top, tz + dz, tx + dx * 2, top, tz + dz * 2, LEAVES);
    kit.fillAir(tx + dx * 3, top - 1, tz + dz * 3, tx + dx * 3, top - 1, tz + dz * 3, LEAVES);
  }
  for (const [dx, dz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    kit.fillAir(tx + dx, top, tz + dz, tx + dx, top, tz + dz, LEAVES);
    kit.fillAir(tx + dx * 2, top - 1, tz + dz * 2, tx + dx * 2, top - 1, tz + dz * 2, LEAVES);
  }
}

/** Saguaro: a column with one or two arms that turn up. */
export function saguaro(kit, x, z, height, rng) {
  const g = kit.top(x, z);
  kit.fillAir(x, g + 1, z, x, g + height, z, MC_CACTUS);
  if (height < 4) return;
  const arms = rng() < 0.45 ? 2 : 1;
  const dirs = rng() < 0.5 ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
  for (let a = 0; a < arms; a++) {
    const [dx, dz] = dirs[a];
    const y = g + 2 + Math.floor(rng() * Math.max(1, height - 4));
    kit.fillAir(x + dx, y, z + dz, x + dx, y, z + dz, MC_CACTUS);
    kit.fillAir(x + dx, y + 1, z + dz, x + dx, Math.min(g + height - 1, y + 2), z + dz, MC_CACTUS);
  }
}

/** Low scrub (sage, creosote): one or two leaf voxels hugging the ground. */
export function scrub(kit, x, z, rng) {
  const g = kit.top(x, z);
  kit.fillAir(x, g + 1, z, x, g + 1, z, LEAVES);
  if (rng() < 0.45) kit.fillAir(x + (rng() < 0.5 ? 1 : 0), g + 1, z + (rng() < 0.5 ? 1 : 0), x + 1, g + 1, z, LEAVES);
}

/** A tumble of sandstone boulders (solid crouch cover). */
export function boulders(kit, x, z, rng) {
  const g = kit.top(x, z);
  const r = 1.2 + rng() * 1.1;
  kit.ellipsoid(x + 0.5, g + 0.6, z + 0.5, r, r * 0.8, r * 0.9, rng() < 0.6 ? DUST_ROCK : DUST_SANDSTONE, true);
  if (rng() < 0.5) kit.ellipsoid(x + 2.5, g + 0.5, z + 1, 0.9, 0.8, 0.9, DUST_ROCK, true);
  kit.feature('cover', { cover: 'boulders', x, z, height: 2 });
}

/**
 * Square steel lattice tower from `y0` up `height` voxels, `half` cells from
 * the axis to each leg, braced every four voxels. Returns the top y.
 */
export function latticeTower(kit, cx, cz, y0, height, half, { leg = METAL, brace = RUST } = {}) {
  const legs = [[-half, -half], [half, -half], [-half, half], [half, half]];
  for (let y = y0; y < y0 + height; y++) {
    const taper = Math.round((y - y0) / height * Math.max(0, half - 1));
    for (const [dx, dz] of legs) kit.set(cx + dx - Math.sign(dx) * taper, y, cz + dz - Math.sign(dz) * taper, leg);
    if ((y - y0) % 4 === 3) {
      const h = half - taper;
      kit.walls(cx - h, cz - h, cx + h, cz + h, y, y, brace);
    }
  }
  return y0 + height - 1;
}

/** Rail track along a polyline of straight runs: timber sleepers every other cell, steel rails. */
export function railTrack(kit, x0, z0, x1, z1, gauge = 2) {
  const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
  const n = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
  for (let k = 0; k <= n; k++) {
    const x = Math.round(x0 + (x1 - x0) * k / n), z = Math.round(z0 + (z1 - z0) * k / n);
    for (let d = -gauge; d <= gauge; d++) {
      const [px, pz] = alongX ? [x, z + d] : [x + d, z];
      const g = kit.top(px, pz);
      kit.set(px, g, pz, GRAVEL);
      if (k % 2 === 0 && Math.abs(d) <= gauge) kit.set(px, g + 1, pz, Math.abs(d) === gauge - 1 ? METAL : TIMBER);
      else if (Math.abs(d) === gauge - 1) kit.set(px, g + 1, pz, METAL);
    }
  }
  kit.feature('rail', { from: [x0, z0], to: [x1, z1] });
}

/** Boxcar on the rails (along z), 3 x 4 x 9, doors open on both sides. */
export function boxcar(kit, x, z, colour, alongX = false) {
  const g = kit.top(x, z) + 1;
  const [hx, hz] = alongX ? [4, 1] : [1, 4];
  kit.box(x - hx, g + 1, z - hz, x + hx, g + 3, z + hz, colour);
  kit.box(x - hx, g + 4, z - hz, x + hx, g + 4, z + hz, METAL);
  if (alongX) kit.box(x - 1, g + 1, z - hz, x, g + 2, z + hz, AIR);
  else kit.box(x - hx, g + 1, z, x + hx, g + 2, z + 1, AIR);
  kit.feature('cover', { cover: 'boxcar', x, z, height: 4 });
}

export { WOOD, TIMBER, PLANK, METAL, RUST };
