// Redrock Canyon places between the flags. Four non-objective locations in
// mirrored pairs (same ground, same distances, different themes):
//
//   Coyote Well (west, between HQ, B and C)  <->  Juniper Trading Post (east)
//   Arch Rock (west canyon rim, B to C)      <->  Signal Butte (east canyon rim)
//
// Every footprint stays more than 80 m from a flag, off the roads, the
// water and the runway corridors; buildings have at least two doors. Built
// after the flag sites and before the flora, which keeps out of every
// rectangle in REDROCK_LOCATION_KEEP_OUT.

import {
  AIR, METAL, RUST, PALE, ACCENT, CONCRETE, GLASS, PLANK, TIMBER, CORRUGATED_STEEL, DUST_ROCK, DUST_SANDSTONE,
  DUST_PLASTER, DUST_WOOD, MC_WATER, STONE, GRAVEL, TRUCK_RED, BARRICADE, DUST_CRATE, TEAL_SIDING,
} from '../blocks.js';
import { redrockTopY } from '../redrock-terrain.js';
import { rect } from './plan.js';
import { adobe, latticeTower } from './props.js';
import { crateStack, wreckTruck, shed } from '../frontier-sites/props.js';

const SX = 768;
// The forward service depots (shared/map-events/depot.js DEPOT_SITES): three fuel tanks behind each
// place, mirrored across x 384 (at Coyote Well they took the corral's ground), and a pump island by the windmill.
const DEPOT_TANKS = Object.freeze([{ x: 566.5, z: 415.5 }, { x: 577.5, z: 415.5 }, { x: 572, z: 423.5 }]);
const WELL = { x: 208, z: 408, house: rect(214, 398, 226, 408), pump: { x: 200.5, z: 404.5 }, island: rect(SX - 563, 400, SX - 557, 406),
  tanks: DEPOT_TANKS.map(t => ({ x: SX - t.x, z: t.z })) };
const POST = { x: SX - 208, z: 408, store: rect(SX - 227, 398, SX - 213, 408), canopy: rect(SX - 211, 400, SX - 205, 406), sign: { x: SX - 196.5, z: 404.5 },
  tanks: DEPOT_TANKS };
const ARCH = { x: 340, z: 470 };
const BUTTE = { x: SX - 340, z: 470 };

const LANDMARKS = {
  'coyote-well': { id: 'coyote-well-windmill', kind: 'windmill', x: WELL.pump.x, z: WELL.pump.z, rise: 19 },
  'juniper-post': { id: 'juniper-post-sign', kind: 'sign pylon', x: POST.sign.x, z: POST.sign.z, rise: 18 },
  'arch-rock': { id: 'arch-rock-span', kind: 'rock arch', x: ARCH.x + 0.5, z: ARCH.z + 0.5, rise: 17 },
  'signal-butte': { id: 'signal-butte-mast', kind: 'radio mast', x: BUTTE.x + 0.5, z: BUTTE.z + 0.5, rise: 35 },
};

/** The places: name, label centre, footprint, buildings; `landmark` reads the terrain on first access. */
export const REDROCK_LOCATIONS = Object.freeze([
  { id: 'coyote-well', name: 'Coyote Well', x: WELL.x, z: WELL.z, footprint: rect(185, 394, 230, 432), buildings: ['coyote-well-ranch'] },
  { id: 'juniper-post', name: 'Juniper Trading Post', x: POST.x, z: POST.z, footprint: rect(SX - 231, 394, SX - 186, 432), buildings: ['juniper-post-store'] },
  { id: 'arch-rock', name: 'Arch Rock', x: ARCH.x, z: ARCH.z, footprint: rect(326, 458, 356, 482), buildings: [] },
  { id: 'signal-butte', name: 'Signal Butte', x: BUTTE.x, z: BUTTE.z, footprint: rect(SX - 357, 458, SX - 327, 482), buildings: ['signal-butte-bunker'] },
].map(l => {
  let landmark = null;
  return Object.freeze({
    ...l, footprint: Object.freeze(l.footprint), buildings: Object.freeze(l.buildings),
    get landmark() {
      if (landmark) return landmark;
      const { rise, ...mark } = LANDMARKS[l.id];
      landmark = Object.freeze({ ...mark, y: redrockTopY(mark.x, mark.z) + rise });
      return landmark;
    },
  });
}));
export const REDROCK_LOCATION_KEEP_OUT = Object.freeze(REDROCK_LOCATIONS.map(l => l.footprint));
const landmarkOf = id => REDROCK_LOCATIONS.find(l => l.id === id).landmark;

/** Three squat fuel tanks on concrete plinths (as at Hollin, Frontier): the integrity pool of a service depot. */
function fuelTanks(kit, tanks) {
  for (const t of tanks) {
    const g = kit.top(t.x, t.z);
    kit.cylinder(t.x, t.z, 4.6, g, g, CONCRETE);
    kit.cylinder(t.x, t.z, 4.2, g + 1, g + 6, PALE);
    kit.cylinder(t.x, t.z, 3.2, g + 7, g + 7, PALE);
    kit.feature('cover', { cover: 'tank', x: t.x, z: t.z, height: 6 });
  }
}

function coyoteWell(kit) {
  adobe(kit, WELL.house.minX, WELL.house.minZ, WELL.house.maxX, WELL.house.maxZ, { floors: 1, doors: ['w', 's', 'e'], id: 'coyote-well-ranch' });
  // The depot's tank farm on the old corral ground and a concrete pump island between the windmill and the ranch.
  fuelTanks(kit, WELL.tanks);
  const i = WELL.island, iy = kit.maxTop(i.minX, i.minZ, i.maxX, i.maxZ);
  kit.box(i.minX, iy, i.minZ, i.maxX, iy, i.maxZ, CONCRETE);
  for (const pz of [i.minZ + 2, i.maxZ - 2]) kit.box((i.minX + i.maxX) >> 1, iy + 1, pz, (i.minX + i.maxX) >> 1, iy + 2, pz, TRUCK_RED);
  // Windmill over the well head with its stock tank.
  const { x, z } = WELL.pump, g = kit.top(x, z), cx = Math.floor(x), cz = Math.floor(z);
  const top = latticeTower(kit, cx, cz, g + 1, 15, 2, { leg: DUST_WOOD, brace: TIMBER });
  kit.box(cx, top + 1, cz, cx, top + 2, cz, METAL);
  for (let k = 0; k < 12; k++) {
    const a = k * Math.PI / 6;
    for (let r = 1; r <= 3; r++) kit.set(cx + 1, top + 2 + Math.round(Math.sin(a) * r), cz + Math.round(Math.cos(a) * r), r === 3 ? PALE : METAL);
  }
  kit.box(cx - 4, top + 2, cz, cx - 1, top + 3, cz, ACCENT);
  kit.cylinder(cx + 0.5, cz - 4.5, 2.6, g + 1, g + 1, RUST, true);
  kit.cylinder(cx + 0.5, cz - 4.5, 1.8, g + 1, g + 1, MC_WATER);
  wreckTruck(kit, 228, 420, false, { cold: true });
  crateStack(kit, 212, 410, 2, 1, 1, TIMBER);
  const l = landmarkOf('coyote-well');
  kit.feature('landmark', { id: l.id, x: l.x, y: l.y, z: l.z });
}

function tradingPost(kit) {
  const s = POST.store;
  adobe(kit, s.minX, s.minZ, s.maxX, s.maxZ, { floors: 2, doors: ['e', 's', 'n'], wall: DUST_PLASTER, id: 'juniper-post-store' });
  // A porch along the east front and a fuel canopy over two pumps.
  const y = kit.maxTop(s.minX, s.minZ, s.maxX, s.maxZ);
  for (const pz of [s.minZ + 1, s.maxZ - 1]) kit.box(s.maxX + 3, y + 1, pz, s.maxX + 3, y + 4, pz, DUST_WOOD);
  kit.box(s.maxX + 1, y + 5, s.minZ, s.maxX + 3, y + 5, s.maxZ, TIMBER);
  const c = POST.canopy, cy = kit.maxTop(c.minX, c.minZ, c.maxX, c.maxZ);
  kit.box(c.minX, cy, c.minZ, c.maxX, cy, c.maxZ, CONCRETE);
  for (const [px, pz] of [[c.minX, c.minZ], [c.maxX, c.minZ], [c.minX, c.maxZ], [c.maxX, c.maxZ]]) kit.box(px, cy + 1, pz, px, cy + 5, pz, METAL);
  kit.box(c.minX - 1, cy + 6, c.minZ - 1, c.maxX + 1, cy + 6, c.maxZ + 1, TEAL_SIDING);
  for (const pz of [c.minZ + 2, c.maxZ - 2]) kit.box((c.minX + c.maxX) >> 1, cy + 1, pz, (c.minX + c.maxX) >> 1, cy + 2, pz, TRUCK_RED);
  // Tall roadside sign pylon.
  const { x, z } = POST.sign, g = kit.top(x, z), cx = Math.floor(x), cz = Math.floor(z);
  kit.box(cx, g + 1, cz, cx, g + 12, cz, METAL);
  kit.box(cx, g + 13, cz - 3, cx, g + 17, cz + 3, PALE);
  kit.box(cx, g + 14, cz - 2, cx, g + 16, cz + 2, TRUCK_RED);
  kit.set(cx, g + 18, cz, METAL);
  shed(kit, SX - 230, 416, SX - 222, 424, 3, { roof: CORRUGATED_STEEL });
  fuelTanks(kit, POST.tanks);
  crateStack(kit, SX - 214, 412, 2, 2, 1, DUST_CRATE);
  crateStack(kit, SX - 200, 424, 1, 2, 2, TIMBER);
  const l = landmarkOf('juniper-post');
  kit.feature('landmark', { id: l.id, x: l.x, y: l.y, z: l.z });
}

/** A natural sandstone arch on the west rim, spanning east-west over a rock floor. */
function archRock(kit) {
  const { x, z } = ARCH, g = kit.top(x, z);
  // Two legs and the span (a half ellipse), banded like the canyon strata.
  for (let dx = -9; dx <= 9; dx++) for (let dz = -3; dz <= 3; dz++) {
    const t = dx / 9;
    const inner = 11 * Math.sqrt(Math.max(0, 1 - (dx / 6.5) ** 2));
    const outer = 17 - Math.abs(t) * 2 - (Math.abs(dz) === 3 ? 1 : 0);
    const lg = kit.top(x + dx, z + dz);
    const from = Math.abs(dx) >= 6.5 ? lg + 1 : g + Math.ceil(inner) + 1;
    for (let y = from; y <= g + outer; y++) kit.set(x + dx, y, z + dz, (y % 7) === 3 || (y % 7) === 4 ? DUST_SANDSTONE : DUST_ROCK);
  }
  // Boulder tumble at the feet (cover) and a cairn.
  for (const [bx, bz, r] of [[x - 12, z - 5, 2.2], [x + 12, z + 6, 1.8], [x - 4, z + 9, 1.6], [x + 6, z - 9, 2]]) {
    kit.ellipsoid(bx + 0.5, kit.top(bx, bz) + 0.6, bz + 0.5, r, r * 0.8, r, DUST_ROCK, true);
  }
  kit.box(x + 2, g + 1, z - 6, x + 2, g + 3, z - 6, STONE);
  const l = landmarkOf('arch-rock');
  kit.feature('landmark', { id: l.id, x: l.x, y: l.y, z: l.z });
  kit.feature('cover', { cover: 'rock arch', x, z, height: 17 });
}

/** A rocky knoll on the east rim with a relay mast, a concrete bunker and sandbags. */
function signalButte(kit) {
  const { x, z } = BUTTE, g = kit.top(x, z);
  kit.ellipsoid(x + 0.5, g - 2, z + 0.5, 11, 7, 8, DUST_ROCK, true);
  kit.ellipsoid(x + 0.5, g + 1, z + 0.5, 6, 5, 5, DUST_SANDSTONE, true);
  const top = kit.surface(x, z);
  const mast = latticeTower(kit, x, z, top + 1, 28, 1, { leg: METAL, brace: METAL });
  kit.set(x, mast + 1, z, TRUCK_RED);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) kit.set(x + dx * 2, mast - 6, z + dz * 2, PALE);
  // The bunker at the knoll's foot, two doors, and sandbag horseshoe.
  const b = rect(x + 6, z + 8, x + 13, z + 14), by = kit.maxTop(b.minX, b.minZ, b.maxX, b.maxZ);
  kit.foundation(b.minX, b.minZ, b.maxX, b.maxZ, by, CONCRETE);
  kit.walls(b.minX, b.minZ, b.maxX, b.maxZ, by + 1, by + 4, CONCRETE);
  kit.box(b.minX, by + 5, b.minZ, b.maxX, by + 5, b.maxZ, CONCRETE);
  kit.box(b.minX + 3, by + 1, b.minZ, b.minX + 4, by + 3, b.minZ, AIR);
  kit.box(b.maxX, by + 1, b.minZ + 3, b.maxX, by + 3, b.minZ + 4, AIR);
  for (let xx = b.minX + 1; xx < b.maxX; xx += 3) kit.set(xx, by + 3, b.maxZ, GLASS);
  kit.feature('building', { id: 'signal-butte-bunker', minX: b.minX, minZ: b.minZ, maxX: b.maxX, maxZ: b.maxZ, floorY: by, eave: by + 5, enterable: true });
  for (const [px, pz] of [[x - 9, z - 4], [x - 9, z + 4]]) { const pg = kit.top(px, pz); kit.box(px, pg + 1, pz, px, pg + 2, pz + 3, BARRICADE); }
  kit.box(x - 4, kit.top(x - 4, z - 9) + 1, z - 9, x + 3, kit.top(x - 4, z - 9) + 2, z - 9, BARRICADE);
  kit.paintRect(x + 4, z + 15, x + 14, z + 17, GRAVEL);
  const l = landmarkOf('signal-butte');
  kit.feature('landmark', { id: l.id, x: l.x, y: l.y, z: l.z });
  kit.feature('cover', { cover: 'butte', x, z, height: 8 });
}

/** Builds the four places (after the flag sites, before the flora). */
export function buildRedrockLocations(kit) {
  coyoteWell(kit);
  tradingPost(kit);
  archRock(kit);
  signalButte(kit);
  for (const l of REDROCK_LOCATIONS) kit.feature('location', { id: l.id, name: l.name, x: l.x, z: l.z, landmark: l.landmark.id });
}
