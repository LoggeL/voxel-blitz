// The sluice weir on the north reach (docs/maps/frontier.md "Sluice weir";
// the Conquest event in docs/conquest.md "Sluice weir"). One team-neutral
// structure on the river axis, 6 m upstream of ford-north: concrete
// abutments on both banks, two piers that split the 20 m channel into a west
// gate bay, the 9 m navigation pass and an east gate bay, steel gantries with
// shut gate leaves over the bays, and a 2 m railed walkway at y25 across the
// whole weir with the sluice wheel platform over the pass. Infantry cross on
// it (one step up from the west bank, one down to the east bank); no hull
// fits on the walkway and boats sail through the pass under it.
//
// It stands on one side of the map only (the map is point-symmetric about
// (384, 384)): the weir is a shared objective on the river axis, usable from
// both banks and about equidistant from both HQs (340 m and 332 m), like
// flag C; its mirror would put a second sluice below ford-south. The geometry
// is WEIR in shared/map-events/weir.js, which the event's gate edits read too.

import { AIR, CONCRETE, METAL, RUST, MC_WATER } from '../blocks.js';
import { WEIR } from '../../map-events/weir.js';

/** The footprint no tree or roadside prop may touch (cells, inclusive). */
export const WEIR_KEEP_OUT = Object.freeze({ minX: WEIR.abutments[0].x0 - 2, maxX: WEIR.eastSteps.x + 2, minZ: WEIR.z0 - 3, maxZ: WEIR.platform.z1 + 3 });

/** Highest solid voxel of a column at or below `y`, or 0. */
function solidBelow(kit, x, z, y) {
  for (let yy = y; yy > 0; yy--) if (kit.solid(x, yy, z)) return yy;
  return 0;
}

/** Concrete from the ground (or the river bed) up to the deck level, replacing water and air. */
function mass(kit, x0, x1, z0, z1, top) {
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    // The top voxel always, then down to the first solid (an overhanging bank cell leaves no gap under it).
    const g = solidBelow(kit, x, z, top - 1);
    kit.box(x, g + 1, z, x, top, z, CONCRETE);
  }
}

/** The gate leaf cells of a bay, shut (bed to `shutTopY`) or open (hung at `openY`): [x, y, z]. */
export function weirGateCells(bay, shut, bedTop) {
  const out = [];
  for (let x = bay.x0; x <= bay.x1; x++) {
    const [y0, y1] = shut ? [bedTop(x) + 1, WEIR.shutTopY] : WEIR.openY;
    for (let y = y0; y <= y1; y++) out.push([x, y, WEIR.gateZ]);
  }
  return out;
}

export function buildWeir(kit) {
  const { z0, z1, deckY } = WEIR;
  // Abutments and piers (the piers' upstream and downstream noses are the z0 / z1 rows).
  // The bank dressing (sandbag lines, hedgehogs) leaves no prop standing on the abutments.
  for (const a of WEIR.abutments) { mass(kit, a.x0, a.x1, z0, z1, deckY); kit.box(a.x0, deckY + 1, z0, a.x1, deckY + 4, z1, AIR); }
  for (const p of WEIR.piers) mass(kit, p.x0, p.x1, z0, z1, deckY);
  // The walkway over the bays and the pass, and the wheel platform over the pass.
  const walk = WEIR.walk, pl = WEIR.platform;
  // The deck carries the rails on its outer rows, so the clear walk between them is 2 m.
  kit.box(walk.x0, deckY, walk.railZ[0], walk.x1, deckY, walk.railZ[1], CONCRETE);
  kit.box(pl.x0 - 1, deckY, pl.z0, pl.x1 + 1, deckY, pl.z1 + 1, CONCRETE);
  kit.box(walk.x0, deckY + 1, walk.z0, walk.x1, deckY + 3, walk.z1, AIR);
  // Railings over the water: the upstream rail, the downstream rail broken by the platform, the platform's own.
  const water0 = WEIR.abutments[0].x1 + 1, water1 = WEIR.abutments[1].x0 - 1;
  for (let x = water0; x <= water1; x++) {
    kit.set(x, deckY + 1, walk.railZ[0], (x % 3) ? METAL : RUST);
    if (x < pl.x0 - 1 || x > pl.x1 + 1) kit.set(x, deckY + 1, walk.railZ[1], (x % 3) ? METAL : RUST);
  }
  kit.box(pl.x0 - 1, deckY + 1, walk.railZ[1], pl.x0 - 1, deckY + 1, pl.z1 + 1, METAL);
  kit.box(pl.x1 + 1, deckY + 1, walk.railZ[1], pl.x1 + 1, deckY + 1, pl.z1 + 1, METAL);
  kit.box(pl.x0 - 1, deckY + 1, pl.z1 + 1, pl.x1 + 1, deckY + 1, pl.z1 + 1, METAL);
  // The sluice wheel: a post and a ring on the platform's downstream edge.
  const w = WEIR.wheel;
  kit.box(w.x, deckY + 1, w.z, w.x, w.y - 1, w.z, METAL);
  for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) kit.set(w.x + dx, w.y + dy, w.z, RUST);
  kit.set(w.x, w.y, w.z, METAL);
  // Gate bays: posts at each edge up to the gantry beam, the hoist box, the shut leaf.
  for (const bay of WEIR.bays) {
    for (const x of bay.posts) kit.box(x, deckY + 1, WEIR.gateZ, x, WEIR.gantryTopY, WEIR.gateZ, METAL);
    kit.box(bay.posts[0], WEIR.gantryTopY, WEIR.gateZ, bay.posts[1], WEIR.gantryTopY, WEIR.gateZ, RUST);
    kit.box(bay.x0 + 1, WEIR.gantryTopY + 1, WEIR.gateZ, bay.x1 - 1, WEIR.gantryTopY + 1, WEIR.gateZ, METAL);
    for (const [x, y, z] of weirGateCells(bay, true, gx => solidBelow(kit, gx, WEIR.gateZ, WEIR.shutTopY))) {
      const b = kit.get(x, y, z);
      if (b === AIR || b === MC_WATER) kit.set(x, y, z, RUST);
    }
  }
  // One step down from the deck onto the lower east bank.
  const s = WEIR.eastSteps;
  kit.box(s.x, solidBelow(kit, s.x, walk.z0, s.y) + 1, walk.z0, s.x, s.y, walk.z1, CONCRETE);
  kit.feature('weir', { id: 'weir', x: 388.5, z: 256, deckY, minX: WEIR.abutments[0].x0, maxX: WEIR.abutments[1].x1, minZ: z0, maxZ: pl.z1 });
}
