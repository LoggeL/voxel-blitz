// The ford sluices (docs/maps/frontier.md "Ford sluices"; the Conquest event
// is docs/conquest.md "Ford sluices"). One team-neutral weir on each lane's
// reach 8 m upstream of its ford: concrete abutments on both banks, two
// piers that split the 20 m channel into a gate bay either side of the 10 m
// spillway pass, steel gantries with shut gate leaves over the bays, and a
// 2 m railed walkway at y25 across the whole weir with the (inert) sluice
// wheel platform over the pass. Infantry cross on it (steps run down to the
// lower banks); no hull fits on the walkway and boats sail through the pass
// under it.
//
// Behind the shut gates the reach is a real pond: a rock sill upstream
// closes it, and every river or flush bank column between the sill and the
// gates holds water one voxel higher (face y23) than the reach below the
// weir (face y22), so the pond spills over the pass. The boat lane crosses
// the sill through an 11 m chute (the one place where the pond's face meets the
// reach above it), and a boat rides the voxel up or down at either end
// (BOAT_RULES.waterStep).
//
// The two sluices are the one exception to the map's point symmetry about
// (384, 384): each stands upstream of its own ford (the river runs north to
// south), so the south one is the north one's functional mirror. The
// geometry is WEIR / WEIR_SOUTH in shared/map-events/weir.js, which the
// event's fall and its staged edits read too.

import { AIR, CONCRETE, METAL, RUST, MC_WATER, STONE, MC_COBBLE, MC_MOSSY } from '../blocks.js';
import { WEIR, WEIR_SOUTH, SLUICES } from '../../map-events/weir.js';

const keepOut = w => Object.freeze({ minX: w.abutments[0].x0 - 3, maxX: w.abutments[1].x1 + 3, minZ: w.z0 - 3, maxZ: w.platform.z1 + 3 });
/** The footprints no tree or roadside prop may touch (cells, inclusive): the north sluice, and the south one. */
export const WEIR_KEEP_OUT = keepOut(WEIR);
export const WEIR_SOUTH_KEEP_OUT = keepOut(WEIR_SOUTH);

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
export function weirGateCells(bay, shut, bedTop, weir = WEIR) {
  const out = [];
  for (let x = bay.x0; x <= bay.x1; x++) {
    const [y0, y1] = shut ? [bedTop(x) + 1, weir.shutTopY] : weir.openY;
    for (let y = y0; y <= y1; y++) out.push([x, y, weir.gateZ]);
  }
  return out;
}

/** Field stone for the sill and the release's stepping stones (deterministic per cell). */
export const sillStone = (x, y, z) => [STONE, MC_COBBLE, MC_MOSSY][((x * 7 + z * 13 + y * 3) % 3 + 3) % 3];

/**
 * The pond columns of a sluice in a world (`get(x, y, z)`): every column
 * reachable from the boat lane over cells whose pond row (faceY - 1) is
 * water or air, inside the pond box. Returns [[x, z], ...] in fill order.
 */
export function pondColumns(get, weir, start) {
  const p = weir.pond, y = p.faceY - 1, open = (x, z) => { const b = get(x, y, z); return b === AIR || b === MC_WATER; };
  const seen = new Set(), out = [], queue = [start];
  const key = (x, z) => x * 1024 + z;
  seen.add(key(start[0], start[1]));
  while (queue.length) {
    const [x, z] = queue.shift();
    out.push([x, z]);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (nx < p.x0 || nx > p.x1 || nz < p.z0 || nz > p.z1 || seen.has(key(nx, nz)) || !open(nx, nz)) continue;
      seen.add(key(nx, nz));
      queue.push([nx, nz]);
    }
  }
  return out;
}

/** The pond's seed column: the pass's middle on the gate row. */
export const pondSeed = weir => [Math.floor((weir.pass.x0 + weir.pass.x1) / 2), weir.pond.z1];

/** The rock sill and the pond behind it: the sill rows solid to the pond row (but for the chute), then the fill. */
function buildPond(kit, weir) {
  const { sill, pond } = weir, y = pond.faceY - 1;
  // Every open column of the sill rows across the reach (both arms round an island, the flush bank cells).
  for (let z = sill.z0; z <= sill.z1; z++) for (let x = sill.x0; x <= sill.x1; x++) {
    if (kit.solid(x, y, z) || (x >= sill.chute.x0 && x <= sill.chute.x1)) continue;
    for (let yy = solidBelow(kit, x, z, y) + 1; yy <= y; yy++) kit.set(x, yy, z, sillStone(x, yy, z));
  }
  const columns = pondColumns((x, yy, z) => kit.get(x, yy, z), weir, pondSeed(weir));
  // The chute's cells on the sill rows hold the pond face too (the boat lane's one step).
  for (let z = sill.z0; z <= sill.z1; z++) for (let x = sill.chute.x0; x <= sill.chute.x1; x++) columns.push([x, z]);
  let cells = 0;
  for (const [x, z] of columns) {
    // Water from the first solid up to the pond row (a flush bank cell gets its one voxel).
    for (let yy = solidBelow(kit, x, z, y) + 1; yy <= y; yy++) if (kit.get(x, yy, z) === AIR) { kit.set(x, yy, z, MC_WATER); cells++; }
  }
  return { columns: columns.length, cells };
}

/** Steps from the deck down each side of the walkway until they meet the bank (one voxel a cell). */
function buildSteps(kit, weir) {
  const { walk, deckY } = weir;
  for (const [edge, dir] of [[walk.x0, -1], [walk.x1, 1]]) {
    for (let k = 1; k <= 4; k++) {
      const x = edge + dir * k, top = deckY - k;
      let low = Infinity;
      for (let z = walk.z0; z <= walk.z1; z++) low = Math.min(low, solidBelow(kit, x, z, top + 2));
      if (low >= top) break;
      for (let z = walk.z0; z <= walk.z1; z++) kit.box(x, solidBelow(kit, x, z, top) + 1, z, x, top, z, CONCRETE);
    }
  }
}

export function buildSluice(kit, weir) {
  const { z0, z1, deckY } = weir;
  // Abutments and piers (the piers' upstream and downstream noses are the z0 / z1 rows).
  // The bank dressing (sandbag lines, hedgehogs) leaves no prop standing on the abutments.
  for (const a of weir.abutments) { mass(kit, a.x0, a.x1, z0, z1, deckY); kit.box(a.x0, deckY + 1, z0, a.x1, deckY + 4, z1, AIR); }
  for (const p of weir.piers) mass(kit, p.x0, p.x1, z0, z1, deckY);
  // The walkway over the bays and the pass, and the wheel platform over the pass.
  const walk = weir.walk, pl = weir.platform;
  // The deck carries the rails on its outer rows, so the clear walk between them is 2 m.
  kit.box(walk.x0, deckY, walk.railZ[0], walk.x1, deckY, walk.railZ[1], CONCRETE);
  kit.box(pl.x0 - 1, deckY, pl.z0, pl.x1 + 1, deckY, pl.z1 + 1, CONCRETE);
  kit.box(walk.x0, deckY + 1, walk.z0, walk.x1, deckY + 3, walk.z1, AIR);
  // Railings over the water: the upstream rail, the downstream rail broken by the platform, the platform's own.
  const water0 = weir.abutments[0].x1 + 1, water1 = weir.abutments[1].x0 - 1;
  for (let x = water0; x <= water1; x++) {
    kit.set(x, deckY + 1, walk.railZ[0], (x % 3) ? METAL : RUST);
    if (x < pl.x0 - 1 || x > pl.x1 + 1) kit.set(x, deckY + 1, walk.railZ[1], (x % 3) ? METAL : RUST);
  }
  kit.box(pl.x0 - 1, deckY + 1, walk.railZ[1], pl.x0 - 1, deckY + 1, pl.z1 + 1, METAL);
  kit.box(pl.x1 + 1, deckY + 1, walk.railZ[1], pl.x1 + 1, deckY + 1, pl.z1 + 1, METAL);
  kit.box(pl.x0 - 1, deckY + 1, pl.z1 + 1, pl.x1 + 1, deckY + 1, pl.z1 + 1, METAL);
  // The sluice wheel: a post and a ring on the platform's downstream edge.
  const w = weir.wheel;
  kit.box(w.x, deckY + 1, w.z, w.x, w.y - 1, w.z, METAL);
  for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) kit.set(w.x + dx, w.y + dy, w.z, RUST);
  kit.set(w.x, w.y, w.z, METAL);
  // Gate bays: posts at each edge up to the gantry beam, the hoist box, the shut leaf.
  for (const bay of weir.bays) {
    for (const x of bay.posts) kit.box(x, deckY + 1, weir.gateZ, x, weir.gantryTopY, weir.gateZ, METAL);
    kit.box(bay.posts[0], weir.gantryTopY, weir.gateZ, bay.posts[1], weir.gantryTopY, weir.gateZ, RUST);
    kit.box(bay.x0 + 1, weir.gantryTopY + 1, weir.gateZ, bay.x1 - 1, weir.gantryTopY + 1, weir.gateZ, METAL);
    for (const [x, y, z] of weirGateCells(bay, true, gx => solidBelow(kit, gx, weir.gateZ, weir.shutTopY), weir)) {
      const b = kit.get(x, y, z);
      if (b === AIR || b === MC_WATER) kit.set(x, y, z, RUST);
    }
  }
  buildSteps(kit, weir);
  const pond = buildPond(kit, weir);
  kit.feature('weir', { id: `sluice-${weir.id}`, x: (weir.pass.x0 + weir.pass.x1 + 1) / 2, z: (z0 + z1 + 1) / 2, deckY,
    minX: weir.abutments[0].x0, maxX: weir.abutments[1].x1, minZ: z0, maxZ: pl.z1, pond });
}

/** Both ford sluices, north then south. */
export function buildWeir(kit) {
  for (const weir of SLUICES) buildSluice(kit, weir);
}
