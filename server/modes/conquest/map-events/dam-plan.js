// Redrock Dam breach, the precomputed plan (docs/conquest.md "Redrock Dam
// breach"; tuning in shared/map-events/dam.js DAM_TUNING). Pure and
// deterministic: it reads only the pristine template voxels
// (world.templateBlock), so every room on the same template shares one plan
// (cached per template), whatever the live world went through first.
//
//   breach   solid cells of the breach box (the structural fall) and the
//            spillway's water in it (turned to air)
//   field    the flood field (shared/world/flood-field.js buildDamFlood): the
//            moving water every client evaluates from the same start time
//   commits  the voxel changes the water leaves once it has settled, as jobs
//            of one 16 x 16 column tile each, sorted by when they are due (s
//            after the breach): the basin's water cells above its level as the
//            level passes their centres, the canyon's new water cells up to its
//            final level once their row has settled. Nothing changes while the
//            water moves; the clients' clip hides voxel water above the field.
import { AIR, FLUID_BLOCKS, MC_WATER, isSolidBlock } from '../../../../shared/world/blocks.js';
import { FLOOD_KIND, buildDamFlood } from '../../../../shared/world/flood-field.js';

const PLANS = new WeakMap();

/**
 * The plan of a world (cached per template): {breachSolids, breachWater,
 * field, commits: [{t, tile, cells: Int32Array [x, y, z, v, ...]}], counts, buildMs}.
 */
export function damPlan(world, tuning) {
  const key = world?.templateBlocks ?? world;
  const hit = key ? PLANS.get(key) : null;
  if (hit && hit.tuning === tuning) return hit;
  const plan = buildDamPlan(world, tuning);
  if (key) PLANS.set(key, plan);
  return plan;
}

/** Seconds after the breach once the basin's level stands at or below `y` (H(t) = sill + h0/(1 + t/tau)^2). */
export function lakeTimeAt(lake, y) {
  if (y >= lake.top) return 0;
  if (y <= lake.sill) return Infinity;
  return lake.tauS * (Math.sqrt(lake.h0 / (y - lake.sill)) - 1);
}

function buildDamPlan(world, tuning) {
  const t0 = performance.now();
  const tb = typeof world.templateBlock === 'function' ? (x, y, z) => world.templateBlock(x, y, z) : (x, y, z) => world.getBlock(x, y, z);

  // Breach: the solid cells fall (top down), the spillway's water goes.
  const b = tuning.breach;
  const solids = [], wet = [];
  for (let y = b.y1; y >= b.y0; y--) for (let z = b.z0; z <= b.z1; z++) for (let x = b.x0; x <= b.x1; x++) {
    const block = tb(x, y, z);
    if (isSolidBlock(block)) solids.push(x, y, z, AIR);
    else if (FLUID_BLOCKS.has(block)) wet.push(x, y, z, AIR);
  }

  const field = buildDamFlood(tb, tuning.flood);
  const { lake, canyon } = tuning.flood;
  const size = tuning.commit.tile;
  const tiles = new Map();
  const job = (x, z, t) => {
    const key = `${Math.floor(x / size)},${Math.floor(z / size)},${t}`;
    let j = tiles.get(key);
    if (!j) tiles.set(key, j = { t, tile: [Math.floor(x / size), Math.floor(z / size)], cells: [] });
    return j;
  };
  let drained = 0, filled = 0;
  const { x0, z0, x1, z1 } = field.bounds;
  // The settled canyon level: the lowest final of its rows (the south edge), one level for every committed cell.
  let canyonFinal = Infinity;
  for (let r = 0; r < field.rows; r++) canyonFinal = Math.min(canyonFinal, field.run.final[r]);
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    const kind = field.kindAt(x, z), floor = field.floorAt(x, z);
    if (kind === FLOOD_KIND.lake) {
      // Water cells whose centre ends above the basin's settled level go once the level passes them.
      const final = field.lakeFinal(z);
      for (let y = Math.max(floor, Math.floor(final - 0.5)); y < lake.top; y++) {
        if (y + 0.5 < final || tb(x, y, z) !== MC_WATER) continue;
        const t = Math.round(lakeTimeAt(lake, y + 0.5) * 10) / 10;
        if (!Number.isFinite(t)) continue;
        job(x, z, t).cells.push(x, y, z, AIR); drained++;
      }
    } else if ((kind === FLOOD_KIND.canyon || kind === FLOOD_KIND.gap) && z >= canyon.z0) {
      // New water up to the settled level, once the row has settled.
      const t = Math.ceil(field.settled(x, z));
      for (let y = floor; y + 0.5 < canyonFinal; y++) {
        if (tb(x, y, z) !== AIR) continue;
        job(x, z, t).cells.push(x, y, z, MC_WATER); filled++;
      }
    }
  }
  const commits = [...tiles.values()].sort((p, q) => p.t - q.t || p.tile[1] - q.tile[1] || p.tile[0] - q.tile[0])
    .map(j => Object.freeze({ t: j.t, tile: j.tile, cells: Int32Array.from(j.cells) }));
  return {
    tuning, field,
    breachSolids: Int32Array.from(solids), breachWater: Int32Array.from(wet),
    commits, canyonFinal,
    counts: { breach: solids.length / 4, breachWater: wet.length / 4, drained, canyon: filled, jobs: commits.length,
      lakeColumns: count(field, FLOOD_KIND.lake), canyonColumns: count(field, FLOOD_KIND.canyon) },
    buildMs: performance.now() - t0, fieldMs: field.buildMs,
  };
}

const count = (field, kind) => field.kind.reduce((n, k) => n + (k === kind), 0);
