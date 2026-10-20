// Frontier places between the flags (2026-10-07 locations pass). Four
// non-objective locations fill the empty pockets of the valley; each has a
// landmark that reads from 300 m, dense cover up close and a gravel drive
// from the nearest road. Their positions are point mirrors in pairs, so both
// teams find the same kind of ground at the same distance from their flags,
// while the themes differ (as A/E and B/D do):
//
//   Kestrel Halt (west, A-C-HQ triangle)  <->  Hollin Fuel Depot (east, E-C-HQ)
//   Aldric Quarry (south-west, B to bridge-south)  <->  Signal Rock (north-east, D to bridge-north)
//
// Every footprint stays more than 80 m from a flag (bot squads stage 50-76 m
// out), outside the HQ sight lines to the site landmarks, off the roads,
// fields, river, crossings and runway corridors. Nothing here encloses a
// space with a single way out: buildings have at least two doors and the
// quarry floor is open on two sides. Built after the flag sites and before
// the woodland, which keeps out of every rectangle in LOCATION_KEEP_OUT.
// Far-view cost: big plain masses, ground materials (gravel, rock, earth)
// where possible and few thin props, because the distant shell budget is tight.

import {
  AIR, METAL, RUST, PALE, ACCENT, CONCRETE, BRICK, GLASS, PLANK, TIMBER, CORRUGATED_STEEL, COBBLE_WALL,
  GRAVEL, MUD, DIRT, STONE, DUST_ROCK, SCORCHED_EARTH, DUST_CRATE,
} from '../blocks.js';
import { frontierTerrain } from '../frontier-terrain.js';
import { rect } from './plan.js';
import { plasterHouse, shed, sandbags, crateStack, wreckTruck } from './props.js';

// ------------------------------------------------------------- the plan

const HALT = Object.freeze({
  track: Object.freeze({ x0: 218, x1: 290, rails: Object.freeze([322, 325]) }),
  platform: rect(256, 327, 284, 329),
  house: rect(256, 332, 268, 340),
  elevator: rect(276, 331, 282, 337),
  wagons: Object.freeze([rect(270, 321, 277, 326), rect(279, 321, 286, 326)]),
  derailed: rect(226, 315, 234, 318),
  drive: Object.freeze([[268, 343], [309, 343]]),
});
const DEPOT = Object.freeze({
  forecourt: rect(478, 436, 500, 448),
  canopy: rect(482, 438, 494, 444),
  office: rect(486, 426, 496, 433),
  tanks: Object.freeze([{ x: 506.5, z: 421.5 }, { x: 517.5, z: 421.5 }, { x: 512.5, z: 431.5 }]),
  bund: rect(499, 414, 525, 438),
  pylon: { x: 476, z: 430 },
});
const QUARRY = Object.freeze({
  pit: rect(246, 582, 292, 614),
  floorY: 24,
  benchY: 28,
  crusher: rect(279, 593, 284, 598),
  heap: { x: 299.5, z: 613.5, r: 5, h: 5 },
  hut: rect(246, 600, 250, 604),
  drive: Object.freeze([[276, 613], [276, 622]]),
});
const RELAY = Object.freeze({
  mast: { x: 467, z: 167 },
  bunker: rect(474, 155, 483, 162),
  shed: rect(456, 155, 461, 159),
  drive: Object.freeze([[478, 145], [478, 154]]),
});

/** Highest terrain top over a rectangle (what kit.maxTop reads; pure, no voxels). */
function terrainMaxTop(r) {
  const { heights } = frontierTerrain();
  let m = -1;
  for (let z = r.minZ; z <= r.maxZ; z++) for (let x = r.minX; x <= r.maxX; x++) m = Math.max(m, heights[z * 768 + x]);
  return m;
}

/**
 * Landmark tops: `base` is the footprint whose highest terrain carries the
 * structure (its foundation level) and `rise` the top voxel above it; the
 * crusher stands on the dug quarry floor, a fixed level.
 */
const LANDMARKS = {
  'kestrel-halt': { id: 'kestrel-halt-elevator', kind: 'grain elevator', x: 279.5, z: 334.5, base: HALT.elevator, rise: 25 },
  'hollin-depot': { id: 'hollin-depot-pylon', kind: 'sign pylon', x: DEPOT.pylon.x + 0.5, z: DEPOT.pylon.z + 0.5, base: rect(DEPOT.pylon.x, DEPOT.pylon.z, DEPOT.pylon.x, DEPOT.pylon.z), rise: 20 },
  'aldric-quarry': { id: 'aldric-quarry-crusher', kind: 'crusher tower', x: 282, z: 596, floor: QUARRY.floorY, rise: 21 },
  'signal-rock': { id: 'signal-rock-mast', kind: 'radio mast', x: RELAY.mast.x + 1.5, z: RELAY.mast.z + 1.5, base: rect(RELAY.mast.x - 1, RELAY.mast.z - 1, RELAY.mast.x + 3, RELAY.mast.z + 3), rise: 32 },
};
const landmarkBase = l => (Number.isFinite(l.floor) ? l.floor : terrainMaxTop(l.base));

/**
 * The places, for map metadata and tests: name, a centre for the label, the
 * footprint and the enterable buildings. `landmark` (id, kind, x, z and y, its
 * top voxel) reads the terrain on first access, so importing this module
 * never builds the heightfield.
 */
export const FRONTIER_LOCATIONS = Object.freeze([
  { id: 'kestrel-halt', name: 'Kestrel Halt', x: 258, z: 330, footprint: rect(212, 312, 292, 346), buildings: ['kestrel-halt-station', 'kestrel-halt-elevator'] },
  { id: 'hollin-depot', name: 'Hollin Fuel Depot', x: 500, z: 432, footprint: rect(472, 412, 528, 450), buildings: ['hollin-depot-office'] },
  { id: 'aldric-quarry', name: 'Aldric Quarry', x: 270, z: 598, floorY: QUARRY.floorY, footprint: rect(242, 578, 306, 623), buildings: [] },
  { id: 'signal-rock', name: 'Signal Rock', x: 470, z: 166, footprint: rect(450, 145, 490, 182), buildings: ['signal-rock-bunker'] },
].map(l => {
  let landmark = null;
  return Object.freeze({
    ...l, footprint: Object.freeze(l.footprint), buildings: Object.freeze(l.buildings),
    get landmark() {
      if (landmark) return landmark;
      const { base, floor, rise, ...mark } = LANDMARKS[l.id];
      landmark = Object.freeze({ ...mark, y: landmarkBase(LANDMARKS[l.id]) + rise });
      return landmark;
    },
  });
}));
const landmarkOf = id => FRONTIER_LOCATIONS.find(l => l.id === id).landmark;

/** Ground the woodland keeps clear of (both halves test their mirror too). */
export const LOCATION_KEEP_OUT = Object.freeze(FRONTIER_LOCATIONS.map(l => l.footprint));

/** Paint a straight gravel drive `half` cells either side of a polyline (never over a road). */
function drive(kit, points, half = 2, m = GRAVEL) {
  const { roadIndex } = kit.terrain;
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1], [bx, bz] = points[i];
    const n = Math.max(Math.abs(bx - ax), Math.abs(bz - az));
    for (let k = 0; k <= n; k++) {
      const x = Math.round(ax + (bx - ax) * k / n), z = Math.round(az + (bz - az) * k / n);
      for (let d = -half; d <= half; d++) {
        const [px, pz] = ax === bx ? [x + d, z] : [x, z + d];
        if (roadIndex[pz * kit.SX + px] || kit.surface(px, pz) !== kit.top(px, pz)) continue;
        kit.paint(px, pz, (px * 7 + pz * 3) % 11 === 0 ? MUD : m);
      }
    }
  }
}

/**
 * A one-voxel plinth on the ground ring under a roof overhang (`r` grown by
 * one). A rotor hull (3 x 7 m, 3.2 m tall) clears the ground beside a wall
 * and would then climb into the eaves; on the plinth it never touches down there.
 */
function eavePlinth(kit, r, m = COBBLE_WALL) {
  for (let x = r.minX - 1; x <= r.maxX + 1; x++) for (let z = r.minZ - 1; z <= r.maxZ + 1; z++) {
    if (x !== r.minX - 1 && x !== r.maxX + 1 && z !== r.minZ - 1 && z !== r.maxZ + 1) continue;
    const g = kit.top(x, z);
    if (kit.solid(x, g, z) && !kit.solid(x, g + 1, z)) kit.set(x, g + 1, z, m);
  }
}

/** A plain box wagon: rust body, metal chassis, sliding doors open on both sides. */
function boxcar(kit, r, y, body = RUST) {
  kit.box(r.minX, y + 1, r.minZ + 1, r.maxX, y + 1, r.maxZ - 1, METAL);
  kit.box(r.minX, y + 2, r.minZ, r.maxX, y + 4, r.maxZ, body);
  const mx = (r.minX + r.maxX) >> 1;
  kit.box(mx, y + 2, r.minZ, mx + 1, y + 3, r.maxZ, AIR);           // walk-through doors: a firing step, never a box
  kit.box(r.minX, y + 5, r.minZ + 1, r.maxX, y + 5, r.maxZ - 1, body);
  kit.feature('cover', { cover: 'wagon', x: (r.minX + r.maxX + 1) / 2, z: (r.minZ + r.maxZ + 1) / 2, height: 4 });
}

// --------------------------------------------------------- Kestrel Halt

function kestrelHalt(kit) {
  const { track } = HALT;
  // Ballast bed with dark sleepers (ground paint, free in the distant view) and two rails.
  for (let x = track.x0; x <= track.x1; x++) {
    for (let z = track.rails[0] - 1; z <= track.rails[1] + 1; z++) {
      kit.paint(x, z, x % 2 === 0 && z >= track.rails[0] && z <= track.rails[1] ? MUD : GRAVEL);
    }
    for (const rz of track.rails) kit.set(x, kit.top(x, rz) + 1, rz, METAL);
  }
  // Buffer stop at the east end.
  const be = kit.top(track.x1, track.rails[0]);
  kit.box(track.x1, be + 1, track.rails[0] - 1, track.x1, be + 2, track.rails[1] + 1, TIMBER);
  // Platform: a field-stone edge with a gravel top, one step up from the yard.
  const p = HALT.platform, py = kit.maxTop(p.minX, p.minZ, p.maxX, p.maxZ) + 1;
  kit.foundation(p.minX, p.minZ, p.maxX, p.maxZ, py, GRAVEL, COBBLE_WALL);
  kit.box(p.minX, py, p.minZ, p.maxX, py, p.minZ, COBBLE_WALL);
  // Station house: two storeys, doors to the platform, the yard and the west lane.
  const h = HALT.house;
  plasterHouse(kit, h.minX, h.minZ, h.maxX, h.maxZ, { floors: 2, axis: 'x', doors: ['n', 's', 'w'] });
  eavePlinth(kit, h);
  Object.assign(kit.features[kit.features.length - 1], { id: 'kestrel-halt-station', location: 'kestrel-halt' });
  // Grain elevator: a tall timber bin house over a drive-through bay, a
  // narrower headhouse and a gabled cap, with a spout down to the siding.
  const e = HALT.elevator, ey = kit.maxTop(e.minX, e.minZ, e.maxX, e.maxZ);
  kit.foundation(e.minX, e.minZ, e.maxX, e.maxZ, ey, CONCRETE, CONCRETE);
  kit.box(e.minX, ey + 1, e.minZ, e.maxX, ey + 16, e.maxZ, TIMBER);
  kit.box(e.minX + 1, ey + 1, e.minZ, e.maxX - 1, ey + 3, e.maxZ, AIR);
  kit.box(e.minX, ey + 4, e.minZ, e.maxX, ey + 4, e.maxZ, PLANK);
  kit.box(e.minX + 1, ey + 17, e.minZ + 1, e.maxX - 1, ey + 21, e.maxZ - 1, PLANK);
  const ridge = kit.gableRoof(e.minX, e.minZ, e.maxX, e.maxZ, ey + 22, 'z', CORRUGATED_STEEL);
  kit.line(e.minX - 1, ey + 14, e.minZ + 2, e.minX - 5, ey + 7, track.rails[1], RUST);
  kit.feature('building', { id: 'kestrel-halt-elevator', location: 'kestrel-halt', minX: e.minX, minZ: e.minZ, maxX: e.maxX, maxZ: e.maxZ, floorY: ey, eave: ey + 16, enterable: true, open: true });
  kit.feature('landmark', { ...landmarkOf('kestrel-halt'), y: ridge });
  // Wagons on the siding and one derailed and tipped onto its side up the line.
  for (const w of HALT.wagons) boxcar(kit, w, kit.maxTop(w.minX, w.minZ, w.maxX, w.maxZ));
  const d = HALT.derailed, dy = kit.maxTop(d.minX, d.minZ, d.maxX, d.maxZ);
  kit.foundation(d.minX, d.minZ, d.maxX, d.maxZ, dy, DIRT, DIRT);
  kit.box(d.minX, dy + 1, d.minZ, d.maxX, dy + 3, d.maxZ - 1, RUST);              // body on its side
  kit.box(d.minX + 1, dy + 1, d.maxZ, d.maxX - 1, dy + 2, d.maxZ, METAL);         // undercarriage toward the track
  kit.paintRect(d.minX - 2, d.minZ - 2, d.maxX + 2, d.minZ - 1, SCORCHED_EARTH);
  kit.feature('cover', { cover: 'wagon', x: (d.minX + d.maxX + 1) / 2, z: (d.minZ + d.maxZ + 1) / 2, height: 3 });
  // Yard: sleeper stacks, crates and a sandbagged corner on the west lane.
  for (const [x, z] of [[244, 329], [250, 336], [238, 333]]) {
    const g = kit.top(x, z);
    kit.box(x, g + 1, z, x + 3, g + 2, z + 1, TIMBER);
    kit.feature('cover', { cover: 'sleepers', x: x + 2, z: z + 1, height: 2 });
  }
  crateStack(kit, 271, 337, 2, 2, 2);
  sandbags(kit, [[246, 341], [252, 341]], { height: 2 });
  drive(kit, HALT.drive);
}

// ---------------------------------------------------- Hollin Fuel Depot

function hollinDepot(kit) {
  const f = DEPOT.forecourt;
  // Forecourt: top-layer concrete (paving, drawn by the far terrain).
  kit.paintRect(f.minX, f.minZ, f.maxX, f.maxZ, CONCRETE);
  // Pump canopy: four posts, a flat steel roof with an orange fascia, two pump islands.
  const c = DEPOT.canopy, cy = kit.maxTop(c.minX, c.minZ, c.maxX, c.maxZ);
  for (const [x, z] of [[c.minX, c.minZ], [c.maxX, c.minZ], [c.minX, c.maxZ], [c.maxX, c.maxZ]]) kit.box(x, kit.top(x, z) + 1, z, x, cy + 5, z, METAL);
  kit.box(c.minX - 1, cy + 6, c.minZ - 1, c.maxX + 1, cy + 6, c.maxZ + 1, CORRUGATED_STEEL);
  kit.box(c.minX - 1, cy + 6, c.maxZ + 1, c.maxX + 1, cy + 6, c.maxZ + 1, ACCENT);
  eavePlinth(kit, c, CONCRETE);
  for (const x of [486, 490]) { const g = kit.top(x, 441); kit.box(x, g + 1, 440, x, g + 2, 442, PALE); kit.feature('cover', { cover: 'pump', x, z: 441, height: 2 }); }
  // Garage office: brick, flat concrete roof, doors to the forecourt, the tank yard and the road.
  const o = DEPOT.office, oy = kit.maxTop(o.minX, o.minZ, o.maxX, o.maxZ);
  kit.foundation(o.minX, o.minZ, o.maxX, o.maxZ, oy, CONCRETE, BRICK);
  kit.walls(o.minX, o.minZ, o.maxX, o.maxZ, oy + 1, oy + 4, BRICK);
  kit.box(o.minX + 2, oy + 1, o.maxZ, o.minX + 5, oy + 3, o.maxZ, AIR);         // roller door to the forecourt
  kit.box(o.maxX, oy + 1, o.minZ + 3, o.maxX, oy + 3, o.minZ + 4, AIR);         // yard door
  kit.box(o.minX, oy + 1, o.minZ + 2, o.minX, oy + 3, o.minZ + 3, AIR);         // road door
  for (let x = o.minX + 2; x < o.maxX - 1; x += 3) kit.box(x, oy + 2, o.minZ, x + 1, oy + 3, o.minZ, GLASS);
  kit.box(o.maxX - 3, oy + 1, o.minZ + 1, o.maxX - 1, oy + 2, o.minZ + 1, DUST_CRATE);
  kit.box(o.minX, oy + 5, o.minZ, o.maxX, oy + 5, o.maxZ, CONCRETE);
  kit.feature('building', { id: 'hollin-depot-office', location: 'hollin-depot', minX: o.minX, minZ: o.minZ, maxX: o.maxX, maxZ: o.maxZ, floorY: oy, eave: oy + 5, enterable: true });
  // Tank farm: three squat tanks inside an earth bund with three breaches.
  const b = DEPOT.bund;
  for (let x = b.minX; x <= b.maxX; x++) for (let z = b.minZ; z <= b.maxZ; z++) {
    if (x !== b.minX && x !== b.maxX && z !== b.minZ && z !== b.maxZ) continue;
    const gap = (z === b.maxZ && x >= 505 && x <= 508) || (x === b.minX && z >= 419 && z <= 422) || (z === b.minZ && x >= 519 && x <= 522);
    if (gap) continue;
    const g = kit.top(x, z);
    kit.box(x, g + 1, z, x, g + 2, z, DIRT);
  }
  kit.feature('cover', { cover: 'bund', x: (b.minX + b.maxX + 1) / 2, z: (b.minZ + b.maxZ + 1) / 2, height: 2 });
  for (const t of DEPOT.tanks) {
    const g = kit.top(t.x, t.z);
    kit.cylinder(t.x, t.z, 4.6, g, g, CONCRETE);
    kit.cylinder(t.x, t.z, 4.2, g + 1, g + 6, PALE);
    kit.cylinder(t.x, t.z, 3.2, g + 7, g + 7, PALE);
    kit.feature('cover', { cover: 'tank', x: t.x, z: t.z, height: 6 });
  }
  // Pipe rack from the tanks to the pumps, high enough to walk under.
  const ry = kit.maxTop(494, 434, 512, 434) + 4;
  for (const x of [497, 503]) kit.box(x, kit.top(x, 434) + 1, 434, x, ry - 1, 434, METAL);
  kit.box(494, ry, 434, 508, ry, 434, RUST);
  // Sign pylon by the road: a steel mast carrying a broad orange board.
  const mark = landmarkOf('hollin-depot'), p = DEPOT.pylon, pg = kit.top(p.x, p.z);
  kit.box(p.x, pg + 1, p.z, p.x + 1, mark.y - 1, p.z + 1, METAL);
  kit.box(p.x, mark.y - 6, p.z - 2, p.x + 1, mark.y - 1, p.z + 3, ACCENT);
  kit.box(p.x, mark.y, p.z - 2, p.x + 1, mark.y, p.z + 3, PALE);
  kit.feature('landmark', mark);
  // A burnt-out tanker on the yard, crates by the office, a sandbag nest by the bund.
  wreckTruck(kit, 506, 446, true, { cold: true });
  crateStack(kit, 498, 427, 2, 3, 2);
  crateStack(kit, 481, 433, 2, 2, 1);
  sandbags(kit, [[514, 444], [520, 444], [520, 448]], { height: 2 });
  drive(kit, [[466, 442], [478, 442]], 3, CONCRETE);
}

// --------------------------------------------------------- Aldric Quarry

/**
 * Quarry level per column (the terrain is only ever dug down to it): an
 * L-shaped bench along the high north and west faces, a ramp from the floor
 * onto the north bench, and the floor itself, which climbs out to the
 * natural ground on the open south and east sides one voxel per two metres
 * (walkable and drivable).
 */
function quarryLevel(x, z) {
  const q = QUARRY.pit, f = QUARRY.floorY;
  if (x < q.minX || x > q.maxX || z < q.minZ || z > q.maxZ) return Infinity;
  const fromW = x - q.minX, fromN = z - q.minZ;
  if (fromW < 7 || fromN < 6) return QUARRY.benchY;
  if (fromN < 9 && x >= 266 && x <= 273) return f + Math.min(4, Math.floor((x - 264) / 2));
  return f + Math.max(0, Math.floor((z - 605) / 2), Math.floor((x - 283) / 2));
}

function aldricQuarry(kit) {
  const q = QUARRY.pit;
  const level = new Map();
  for (let z = q.minZ; z <= q.maxZ; z++) for (let x = q.minX; x <= q.maxX; x++) {
    const target = quarryLevel(x, z), g = kit.top(x, z);
    if (target >= g) continue;
    kit.box(x, target + 1, z, x, g, z, AIR);
    // Gravel on the working floor and ramps, bare rock on the bench.
    kit.set(x, target, z, target === QUARRY.benchY ? ((x + z) % 7 ? DUST_ROCK : STONE) : (x * 5 + z * 3) % 13 === 0 ? DUST_ROCK : GRAVEL);
    level.set(z * kit.SX + x, target);
  }
  // Re-skin every exposed face as banded rock: the cut shows stone, not soil.
  for (const [i, y0] of level) {
    const x = i % kit.SX, z = (i / kit.SX) | 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      const ny = level.get(nz * kit.SX + nx) ?? kit.top(nx, nz);
      for (let y = y0 + 1; y < ny; y++) kit.set(nx, y, nz, ((y / 2) | 0) % 2 ? STONE : DUST_ROCK);
      // The lip of a face above the natural ground is bare stone too.
      if (ny - y0 >= 2 && !level.has(nz * kit.SX + nx) && kit.surface(nx, nz) === ny) kit.set(nx, ny, nz, STONE);
    }
  }
  // Props on the dug floor read its level, not the planned terrain.
  const pit = Object.create(kit);
  pit.top = (x, z) => level.get(Math.floor(z) * kit.SX + Math.floor(x)) ?? kit.top(x, z);
  const f = QUARRY.floorY;
  // Crusher tower: steel legs, a corrugated house with a glazed band, a chute and a gabled cap.
  const c = QUARRY.crusher;
  for (const [x, z] of [[c.minX, c.minZ], [c.maxX, c.minZ], [c.minX, c.maxZ], [c.maxX, c.maxZ]]) kit.box(x, f + 1, z, x, f + 8, z, METAL);
  kit.box(c.minX, f + 9, c.minZ, c.maxX, f + 17, c.maxZ, CORRUGATED_STEEL);
  kit.box(c.minX + 1, f + 6, c.minZ + 1, c.maxX - 1, f + 8, c.maxZ - 1, RUST);
  kit.box(c.minX, f + 13, c.minZ, c.maxX, f + 14, c.minZ, GLASS);
  const ridge = kit.gableRoof(c.minX - 1, c.minZ - 1, c.maxX + 1, c.maxZ + 1, f + 18, 'x', RUST);
  kit.feature('landmark', { ...landmarkOf('aldric-quarry'), y: ridge });
  eavePlinth(pit, c, CONCRETE);
  // Feed conveyor from a hopper on the west bench up into the crusher, on trestles.
  const bench = QUARRY.benchY;
  kit.box(q.minX + 2, bench + 1, 593, q.minX + 5, bench + 2, 597, RUST);
  const a = [q.minX + 6, bench + 2, 595], b = [c.minX - 1, f + 15, 595];
  kit.line(a[0], a[1], a[2], b[0], b[1], b[2], RUST);
  for (const x of [257, 263, 269, 275]) {
    const y = Math.round(a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]));
    kit.box(x, pit.top(x, 595) + 1, 595, x, y - 1, 595, METAL);
  }
  // Stacker conveyor out over the east rim onto the gravel cone by the road.
  const h = QUARRY.heap, hg = kit.top(h.x, h.z);
  for (let k = 0; k < h.h; k++) kit.cylinder(h.x, h.z, h.r * (1 - k / (h.h + 0.5)), hg + 1 + k, hg + 1 + k, GRAVEL);
  kit.line(c.maxX + 1, f + 10, 597, Math.floor(h.x) - 1, hg + h.h + 2, Math.floor(h.z) - 2, METAL);
  kit.box(292, kit.top(292, 606) + 1, 606, 292, f + 6, 606, METAL);
  kit.feature('cover', { cover: 'gravel heap', x: h.x, z: h.z, height: h.h });
  // Loose blocks and a dump truck on the floor; a site hut by the gate.
  for (const [x, z, w, d] of [[274, 601, 2, 2], [288, 594, 3, 2], [282, 604, 2, 2], [276, 591, 2, 2], [256, 590, 2, 2], [266, 609, 3, 2]]) {
    const g = pit.top(x, z);
    kit.box(x, g + 1, z, x + w - 1, g + 2, z + d - 1, x % 4 ? DUST_ROCK : STONE);
    kit.feature('cover', { cover: 'rock', x: x + w / 2, z: z + d / 2, height: 2 });
  }
  wreckTruck(pit, 262, 604, true, { cold: true });
  shed(pit, QUARRY.hut.minX, QUARRY.hut.minZ, QUARRY.hut.maxX, QUARRY.hut.maxZ, 3, { back: 'w' });
  kit.features[kit.features.length - 1].location = 'aldric-quarry';
  // A timber rail along the top of the high west face.
  for (let z = q.minZ; z <= q.maxZ; z += 3) { const g = kit.top(q.minX - 1, z); kit.set(q.minX - 1, g + 1, z, TIMBER); }
  drive(kit, QUARRY.drive, 2);
}

// ----------------------------------------------------------- Signal Rock

function signalRock(kit) {
  // Lattice mast: four corner posts, a ring every four metres, two platforms, dipole arms and a red light.
  const mark = landmarkOf('signal-rock'), m = RELAY.mast;
  const g = kit.maxTop(m.x - 1, m.z - 1, m.x + 3, m.z + 3), topY = mark.y;
  kit.foundation(m.x - 1, m.z - 1, m.x + 3, m.z + 3, g, CONCRETE, CONCRETE);
  for (const [x, z] of [[m.x, m.z], [m.x + 2, m.z], [m.x, m.z + 2], [m.x + 2, m.z + 2]]) kit.box(x, g + 1, z, x, topY - 5, z, METAL);
  for (let y = g + 4; y < topY - 5; y += 4) kit.walls(m.x, m.z, m.x + 2, m.z + 2, y, y, METAL);
  for (const y of [g + 14, g + 24]) kit.box(m.x - 1, y, m.z - 1, m.x + 3, y, m.z + 3, METAL);
  kit.box(m.x + 1, topY - 5, m.z + 1, m.x + 1, topY - 1, m.z + 1, METAL);
  kit.set(m.x + 1, topY, m.z + 1, ACCENT);
  kit.box(m.x - 1, topY - 6, m.z + 1, m.x + 3, topY - 6, m.z + 1, PALE);
  kit.feature('landmark', mark);
  // Relay bunker: squat concrete, doors north (track), west (knoll) and south (pits), a dish on the roof.
  const r = RELAY.bunker, by = kit.maxTop(r.minX, r.minZ, r.maxX, r.maxZ);
  kit.foundation(r.minX, r.minZ, r.maxX, r.maxZ, by, CONCRETE, CONCRETE);
  kit.walls(r.minX, r.minZ, r.maxX, r.maxZ, by + 1, by + 4, CONCRETE);
  kit.box(r.minX + 3, by + 1, r.minZ, r.minX + 4, by + 3, r.minZ, AIR);
  kit.box(r.minX, by + 1, r.minZ + 3, r.minX, by + 3, r.minZ + 4, AIR);
  kit.box(r.maxX - 3, by + 1, r.maxZ, r.maxX - 2, by + 3, r.maxZ, AIR);
  kit.box(r.maxX, by + 3, r.minZ + 2, r.maxX, by + 3, r.maxZ - 2, AIR);          // firing slit east
  kit.box(r.maxX - 2, by + 1, r.minZ + 1, r.maxX - 1, by + 2, r.minZ + 2, METAL);  // equipment racks
  kit.box(r.minX - 1, by + 5, r.minZ - 1, r.maxX + 1, by + 5, r.maxZ + 1, CONCRETE);
  eavePlinth(kit, r, CONCRETE);
  kit.box(r.minX + 4, by + 6, r.minZ + 3, r.minX + 4, by + 7, r.minZ + 3, METAL);
  kit.box(r.minX + 3, by + 8, r.minZ + 1, r.minX + 3, by + 10, r.minZ + 5, PALE);   // dish
  kit.box(r.minX + 2, by + 9, r.minZ + 2, r.minX + 2, by + 9, r.minZ + 4, PALE);
  kit.feature('building', { id: 'signal-rock-bunker', location: 'signal-rock', minX: r.minX, minZ: r.minZ, maxX: r.maxX, maxZ: r.maxZ, floorY: by, eave: by + 5, enterable: true });
  // Generator shed, fuel drums and sandbagged MG pits round the knoll.
  shed(kit, RELAY.shed.minX, RELAY.shed.minZ, RELAY.shed.maxX, RELAY.shed.maxZ, 3, { back: 'n' });
  kit.features[kit.features.length - 1].location = 'signal-rock';
  const sg = kit.top(458, 157); kit.box(457, sg + 1, 156, 459, sg + 2, 157, RUST);
  sandbags(kit, [[461, 176], [465, 179], [471, 179], [475, 176]], { height: 2 });
  sandbags(kit, [[456, 164], [456, 170]], { height: 2 });
  sandbags(kit, [[486, 166], [486, 172]], { height: 2 });
  for (const [x, z] of [[488, 160], [452, 176]]) { const pg = kit.top(x, z); kit.box(x, pg + 1, z, x, pg + 7, z, METAL); kit.set(x, pg + 8, z, PALE); }
  crateStack(kit, 469, 156, 2, 2, 2);
  drive(kit, RELAY.drive, 2);
  kit.paintRect(474, 163, 483, 165, GRAVEL);
}

/** Builds the four places (after the flag sites, before the woodland). */
export function buildLocations(kit) {
  kestrelHalt(kit);
  hollinDepot(kit);
  aldricQuarry(kit);
  signalRock(kit);
  for (const l of FRONTIER_LOCATIONS) kit.feature('location', { id: l.id, name: l.name, x: l.x, z: l.z, landmark: l.landmark.id });
}
