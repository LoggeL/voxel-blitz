// Redrock Dam breach, the precomputed voxel plan (docs/conquest.md "Redrock
// Dam breach"; tuning in shared/map-events/dam.js DAM_TUNING). Pure and
// deterministic: it reads only the pristine template voxels
// (world.templateBlock), so every room on the same template shares one plan
// (cached per template), whatever the live world went through first.
//
//   breach   solid cells of the breach box (the structural fall) and the
//            spillway water in it (turned to air)
//   flood    one timeline of block changes, sorted by when they are due (ms
//            after the breach): the reservoir cells above the new level turn
//            to air top layer first, nearest the breach first, spread evenly
//            over the drain; the canyon cells at y20..21 that join the stream
//            turn to water as the wave front passes their z
import { AIR, FLUID_BLOCKS, MC_WATER, isSolidBlock } from '../../../../shared/world/blocks.js';

const PLANS = new WeakMap();

/**
 * The plan of a world (cached per template): {breachSolids, breachWater,
 * flood: {cells: Int32Array [x, y, z, v, ...], at: Float64Array ms}, counts}.
 */
export function damPlan(world, tuning) {
  const key = world?.templateBlocks ?? world;
  const hit = key ? PLANS.get(key) : null;
  if (hit && hit.tuning === tuning) return hit;
  const plan = buildDamPlan(world, tuning);
  if (key) PLANS.set(key, plan);
  return plan;
}

function buildDamPlan(world, tuning) {
  const t0 = performance.now();
  const tb = typeof world.templateBlock === 'function' ? (x, y, z) => world.templateBlock(x, y, z) : (x, y, z) => world.getBlock(x, y, z);
  const water = b => FLUID_BLOCKS.has(b);

  // Breach: the solid cells fall (top down), the spillway's water goes.
  const b = tuning.breach;
  const solids = [], wet = [];
  for (let y = b.y1; y >= b.y0; y--) for (let z = b.z0; z <= b.z1; z++) for (let x = b.x0; x <= b.x1; x++) {
    const block = tb(x, y, z);
    if (isSolidBlock(block)) solids.push(x, y, z, AIR);
    else if (water(block)) wet.push(x, y, z, AIR);
  }

  // Drain: water above the new level connected to the upstream face.
  const d = tuning.drain;
  const drained = [];
  const seen = new Set();
  const k = (x, y, z) => (y << 20) | (z << 10) | x;
  const queue = [];
  for (let y = d.level + 1; y <= 40; y++) for (let x = d.x0; x <= d.x1; x++) {
    if (water(tb(x, y, d.face))) { seen.add(k(x, y, d.face)); queue.push(x, y, d.face); }
  }
  for (let i = 0; i < queue.length; i += 3) {
    const x = queue[i], y = queue[i + 1], z = queue[i + 2];
    drained.push(x, y, z);
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (ny <= d.level || nx < d.x0 || nx > d.x1 || nz < d.z0 || nz > d.z1) continue;
      const key2 = k(nx, ny, nz);
      if (seen.has(key2) || !water(tb(nx, ny, nz))) continue;
      seen.add(key2); queue.push(nx, ny, nz);
    }
  }
  // Top layer first, nearest the breach first within a layer.
  const cx = (b.x0 + b.x1 + 1) / 2, cz = b.z0;
  const drainOrder = [];
  for (let i = 0; i < drained.length; i += 3) drainOrder.push(i);
  drainOrder.sort((i, j) => (drained[j + 1] - drained[i + 1])
    || (Math.hypot(drained[i] - cx, drained[i + 2] - cz) - Math.hypot(drained[j] - cx, drained[j + 2] - cz)) || (i - j));

  // Canyon: air cells at y from..level over water (or a cell flooded below) or solid
  // ground, horizontally connected to the stream, inside the canyon box.
  const c = tuning.canyon;
  const filled = new Set();
  const flooded = [];
  const inBox = (x, z) => x >= c.x0 && x <= c.x1 && z >= c.z0 && z <= c.z1;
  for (let y = c.from; y <= c.level; y++) {
    const below = (x, z) => water(tb(x, y - 1, z)) || filled.has(k(x, y - 1, z));
    const open = (x, z) => tb(x, y, z) === AIR;
    const front = [];
    const layer = new Set();
    for (let z = c.z0; z <= c.z1; z++) for (let x = c.x0; x <= c.x1; x++) {
      if (open(x, z) && below(x, z)) { layer.add(k(x, y, z)); front.push(x, z); }
    }
    for (let i = 0; i < front.length; i += 2) {
      const x = front[i], z = front[i + 1];
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz;
        if (!inBox(nx, nz)) continue;
        const key2 = k(nx, y, nz);
        if (layer.has(key2) || !open(nx, nz)) continue;
        const under = tb(nx, y - 1, nz);
        if (!isSolidBlock(under) && !water(under) && !filled.has(k(nx, y - 1, nz))) continue;
        layer.add(key2); front.push(nx, nz);
      }
    }
    for (let i = 0; i < front.length; i += 2) { filled.add(k(front[i], y, front[i + 1])); flooded.push(front[i], y, front[i + 1]); }
  }

  // One timeline: drain cells evenly over d.ms, canyon cells when the front passes them.
  const w = tuning.wave;
  const n = drainOrder.length + flooded.length / 3;
  const rows = new Array(n);
  let r = 0;
  drainOrder.forEach((i, rank) => { rows[r++] = [rank / Math.max(1, drainOrder.length) * d.ms, drained[i], drained[i + 1], drained[i + 2], AIR]; });
  for (let i = 0; i < flooded.length; i += 3) {
    const z = flooded[i + 2];
    rows[r++] = [w.delayMs + Math.max(0, z - w.z0) / w.speed * 1000 + (flooded[i + 1] - c.from) * 400, flooded[i], flooded[i + 1], z, MC_WATER];
  }
  rows.sort((p, q) => p[0] - q[0] || p[3] - q[3] || p[1] - q[1] || p[2] - q[2]);
  const cells = new Int32Array(n * 4), at = new Float64Array(n);
  rows.forEach((row, i) => { at[i] = row[0]; cells[i * 4] = row[1]; cells[i * 4 + 1] = row[2]; cells[i * 4 + 2] = row[3]; cells[i * 4 + 3] = row[4]; });
  const exposed = new Set();
  for (let i = 0; i < drained.length; i += 3) exposed.add((drained[i + 2] << 10) | drained[i]);
  return {
    tuning,
    breachSolids: Int32Array.from(solids), breachWater: Int32Array.from(wet),
    flood: { cells, at, endMs: n ? at[n - 1] : 0 },
    counts: { breach: solids.length / 4, breachWater: wet.length / 4, drained: drainOrder.length, canyon: flooded.length / 3,
      drainedColumns: exposed.size, total: solids.length / 4 + wet.length / 4 + n },
    buildMs: performance.now() - t0,
  };
}
