// Frontier v2 terrain acceptance (spec F8 / 4.2): the pure heightfield, the
// generated top surface, pads, road grades, drivability for jeep and tank,
// the river with its bridges and fords, landmark sight lines from both HQs,
// cover around every flag, and the generation, payload and memory budgets.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

const rss0 = process.memoryUsage().rss;
const t0 = performance.now();
const terrainModule = await import('../shared/world/frontier-terrain.js');
const {
  frontierTerrain, frontierSurfaceY, frontierTopY, FRONTIER_TERRAIN, FRONTIER_PADS, FRONTIER_PLATEAUS, FRONTIER_RUNWAYS,
  FRONTIER_CROSSINGS, FRONTIER_CELL_KIND: KIND, riverCentreX, polylineAt,
} = terrainModule;
const terrain = frontierTerrain();
const terrainMs = performance.now() - t0;
const { FRONTIER_PLAN } = await import('../shared/conquest-contract.js');
const templates = await import('../shared/world/templates.js');
const blocksModule = await import('../shared/world/blocks.js');
const { AIR, MC_WATER, CONCRETE, METAL, BEDROCK, isSolidBlock } = blocksModule;
const { VehicleSystem } = await import('../server/sim/vehicles.js');

const { sx: SX, sy: SY, sz: SZ } = FRONTIER_PLAN.dimensions;
const N = SX * SZ;
const idx = (x, z) => z * SX + x;

// ------------------------------------------------------------ pure module
assert.ok(terrain.heights instanceof Int16Array && terrain.heights.length === N);
assert.ok(terrain.surface instanceof Uint8Array && terrain.surface.length === N);
assert.ok(terrain.drivable instanceof Uint8Array && terrain.drivable.length === N);
assert.strictEqual(frontierTerrain(), terrain, 'memoised: one build per process');
assert.strictEqual(FRONTIER_TERRAIN.heights, terrain.heights);
assert.strictEqual(FRONTIER_TERRAIN.drivable, terrain.drivable);
assert.equal(frontierSurfaceY(232.4, 248.9), terrain.heights[idx(232, 248)] + 1, 'standing height is top voxel + 1');
let hash = 2166136261;
for (let i = 0; i < N; i += 7) hash = Math.imul(hash ^ terrain.heights[i] ^ (terrain.surface[i] << 8), 16777619) >>> 0;
const second = await import(`../shared/world/frontier-terrain.js?again=${Date.now()}`);
const rebuilt = second.frontierTerrain();
assert.deepEqual(rebuilt.heights, terrain.heights, 'deterministic heights (fresh module instance)');
assert.deepEqual(rebuilt.surface, terrain.surface, 'deterministic surfaces');
assert.deepEqual(rebuilt.drivable, terrain.drivable, 'deterministic drivability');
for (let i = 0; i < N; i++) assert.ok(terrain.heights[i] >= 1 && terrain.heights[i] < SY - 1, 'heights stay inside the world');

// Height relief inside the combat area.
const area = FRONTIER_PLAN.combatArea;
let sum = 0, sum2 = 0, count = 0;
for (let z = area.minZ; z < area.maxZ; z++) for (let x = area.minX; x < area.maxX; x++) {
  const h = terrain.heights[idx(x, z)]; sum += h; sum2 += h * h; count++;
}
const mean = sum / count, std = Math.sqrt(sum2 / count - mean * mean);
assert.ok(std >= 6, `terrain height std-dev ${std.toFixed(2)} >= 6`);

// ------------------------------------------------------------------- pads
const flatWithin = (cells, y, label) => {
  for (const [x, z] of cells) {
    const h = terrain.heights[idx(x, z)];
    assert.ok(Math.abs(h - y) <= 1, `${label}: ${x},${z} at ${h} vs ${y}`);
  }
};
const disk = (cx, cz, r) => {
  const out = [];
  for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
    if (Math.hypot(x + 0.5 - cx, z + 0.5 - cz) <= r) out.push([x, z]);
  }
  return out;
};
for (const pad of FRONTIER_PADS) {
  const cells = disk(pad.x, pad.z, pad.radius).filter(([x, z]) => {
    const k = terrain.kind[idx(x, z)];
    return k === KIND.PAD;          // roads and the river keep their own levels
  });
  assert.ok(cells.length > Math.PI * pad.radius * pad.radius * 0.6, `flag ${pad.flag} pad covers its radius`);
  flatWithin(cells, pad.y, `flag ${pad.flag} pad`);
}
for (const p of FRONTIER_PLATEAUS) {
  const cells = [];
  for (let z = p.minZ; z < p.maxZ; z++) for (let x = p.minX; x < p.maxX; x++) if (terrain.kind[idx(x, z)] === KIND.PLATEAU) cells.push([x, z]);
  assert.ok(cells.length > (p.maxX - p.minX) * (p.maxZ - p.minZ) * 0.85, `${p.team} HQ plateau is a real plateau`);
  flatWithin(cells, p.y, `${p.team} HQ plateau`);
}
const meta = templates.getMapMeta('frontier');
for (const field of meta.conquest.airfields) {
  const r = field.runway;
  const cells = [];
  for (let z = Math.ceil(r.z0); z < r.z1; z++) for (let x = Math.floor(r.x - r.width / 2); x < r.x + r.width / 2; x++) cells.push([x, z]);
  flatWithin(cells, FRONTIER_PLAN.heights.hqPlateau, `${field.team} runway`);
  for (const pad of field.helipads) flatWithin(disk(pad.x, pad.z, pad.radius + 1), FRONTIER_PLAN.heights.hqPlateau, `${field.team} helipad`);
}

// ------------------------------------------------------------------ roads
// Grade along the centreline: never more than one voxel per three metres;
// across: every cell of the carriageway within one voxel of its centre.
for (const road of terrain.roads) {
  const samples = [];
  for (let s = 0; s <= road.length; s += 1) {
    const p = polylineAt(road.points, s);
    samples.push({ ...p, h: terrain.heights[idx(Math.floor(p.x), Math.floor(p.z))] });
  }
  for (let k = 3; k < samples.length; k++) {
    assert.ok(Math.abs(samples[k].h - samples[k - 3].h) <= 1, `${road.id}: grade at ${samples[k].x.toFixed(0)},${samples[k].z.toFixed(0)}`);
  }
  for (const p of samples) {
    const nx = -p.dz, nz = p.dx;
    for (let o = -road.width / 2 + 0.5; o <= road.width / 2 - 0.5; o += 0.5) {
      const x = Math.floor(p.x + nx * o), z = Math.floor(p.z + nz * o), k = terrain.kind[idx(x, z)];
      if (k === KIND.RIVER) continue;                              // open water beside a deck
      assert.ok(Math.abs(terrain.heights[idx(x, z)] - p.h) <= 1, `${road.id}: cross-fall at ${x},${z}`);
    }
  }
}

// ------------------------------------------------------- river, crossings
for (let z = 0; z < SZ; z++) {
  const cx = Math.floor(riverCentreX(z + 0.5));
  assert.equal(terrain.water[idx(cx, z)], FRONTIER_PLAN.river.surfaceY, `river water at row ${z}`);
}
assert.deepEqual(FRONTIER_CROSSINGS.map(c => [c.id, c.kind, c.x, c.z]), FRONTIER_PLAN.crossings.map(c => [c.id, c.kind, c.x, c.z]));
assert.equal(FRONTIER_CROSSINGS.filter(c => c.kind === 'bridge').length, 3);
assert.equal(FRONTIER_CROSSINGS.filter(c => c.kind === 'ford').length, 2);
const t1 = performance.now();
const world = templates.createMapState('frontier');
const generateMs = performance.now() - t1;
for (const c of FRONTIER_CROSSINGS) {
  const x = Math.floor(c.x), z = Math.floor(c.z), k = terrain.kind[idx(x, z)];
  if (c.kind === 'bridge') {
    assert.equal(k, KIND.BRIDGE, `${c.id}: deck at the plan position`);
    assert.equal(world.getBlock(x, c.deckY, z), CONCRETE, `${c.id}: concrete deck`);
    assert.equal(world.getBlock(x, c.deckY - 1, z), METAL, `${c.id}: metal core`);
    assert.equal(world.getBlock(x + 3, FRONTIER_PLAN.river.surfaceY, z), MC_WATER, `${c.id}: water flows under the deck`);
  } else {
    assert.equal(k, KIND.FORD, `${c.id}: ford at the plan position`);
    assert.equal(world.getBlock(x, c.bedY + 1, z), MC_WATER, `${c.id}: one voxel of water`);
    assert.equal(world.getBlock(x, c.bedY + 2, z), AIR, `${c.id}: wadeable`);
  }
}

// ------------------------------------------------------ top-surface mix
const hist = new Map();
for (let z = 0; z < SZ; z++) for (let x = 0; x < SX; x++) {
  let m = AIR;
  for (let y = SY - 1; y >= 0; y--) { const b = world.getBlock(x, y, z); if (b !== AIR) { m = b; break; } }
  hist.set(m, (hist.get(m) ?? 0) + 1);
}
const shares = [...hist.values()].map(v => v / N);
assert.ok(Math.max(...shares) <= 0.3, `no material tops more than 30% (max ${(Math.max(...shares) * 100).toFixed(1)}%)`);
assert.ok(shares.filter(s => s > 0.02).length >= 8, `at least 8 materials above 2% (${shares.filter(s => s > 0.02).length})`);
assert.equal(world.getBlock(5, 0, 5), BEDROCK);

// -------------------------------------------------- drive every road spline
// A jeep and a tank follow each centreline with placement(): the chassis must
// find support within its step limit at every 0.25 m, including both fords.
const system = new VehicleSystem({ world, mapMeta: { ...meta, conquest: { ...meta.conquest, vehicleSpawns: [] } }, entities: new Map() });
for (const type of ['jeep', 'tank']) {
  for (const road of meta.conquest.roads) {
    const pts = road.points.map(([x, , z]) => [x, z]);
    let length = 0;
    for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const start = polylineAt(pts, 0);
    system.reset([{ id: `probe-${type}`, type, team: 'alpha', x: start.x, y: frontierSurfaceY(start.x, start.z) + 0.02, z: start.z, yaw: Math.atan2(-start.dx, -start.dz) }]);
    const v = system.vehicles.get(`probe-${type}`);
    v.y = system.placement(v, v.x, v.z);
    assert.ok(v.y != null, `${type} rests at the start of ${road.id}`);
    for (let s = 0.25; s <= length; s += 0.25) {
      const p = polylineAt(pts, s);
      v.yaw = Math.atan2(-p.dx, -p.dz);
      const y = system.placement(v, p.x, p.z);
      assert.ok(y != null, `${type} stalls on ${road.id} at ${p.x.toFixed(1)},${p.z.toFixed(1)} (y ${v.y})`);
      v.x = p.x; v.z = p.z; v.y = y;
    }
  }
}
for (const ford of FRONTIER_CROSSINGS.filter(c => c.kind === 'ford')) {
  const road = meta.conquest.roads.find(r => r.points.some(([x, , z]) => Math.hypot(x - ford.x, z - ford.z) < 1));
  assert.ok(road, `${ford.id} carries a road that the drive test covered`);
}

// --------------------------------------------- landmarks seen from the HQs
/** Voxel DDA: true when the segment reaches within `reach` of the target unobstructed. */
function sightLine(a, b, reach = 2.5) {
  const d = [b.x - a.x, b.y - a.y, b.z - a.z], len = Math.hypot(...d);
  const dir = d.map(v => v / len);
  let x = Math.floor(a.x), y = Math.floor(a.y), z = Math.floor(a.z);
  const step = dir.map(Math.sign);
  const next = (p, i, c) => (step[i] > 0 ? c + 1 - p : p - c) / Math.abs(dir[i] || 1e-12);
  let tMax = [next(a.x, 0, x), next(a.y, 1, y), next(a.z, 2, z)];
  const tDelta = dir.map(v => Math.abs(1 / (v || 1e-12)));
  let t = 0;
  while (t < len - reach) {
    if (isSolidBlock(world.getBlock(x, y, z))) return { clear: false, at: [x, y, z], t };
    const i = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
    t = tMax[i];
    if (i === 0) x += step[0]; else if (i === 1) y += step[1]; else z += step[2];
    tMax[i] += tDelta[i];
  }
  return { clear: true };
}
const eyes = Object.values(meta.conquest.bases).map(b => ({ id: b.id, x: b.x, y: b.y + 1.62, z: b.z }));
const siteLandmarks = meta.landmarks.filter(l => l.kind !== 'flag' && l.flag);
assert.equal(siteLandmarks.filter(l => l.primary).length, 5, 'one primary landmark per site');
assert.ok(siteLandmarks.length >= 10);
for (const l of siteLandmarks) {
  // Hollow tops (chimney rims, the cooling tower lip) ring their centre.
  let topVoxel = false;
  for (let dz = -9; dz <= 9; dz++) for (let dx = -9; dx <= 9; dx++) {
    if (isSolidBlock(world.getBlock(Math.floor(l.x) + dx, Math.floor(l.y), Math.floor(l.z) + dz))) topVoxel = true;
  }
  assert.ok(topVoxel && !isSolidBlock(world.getBlock(Math.floor(l.x), Math.floor(l.y) + 2, Math.floor(l.z))), `${l.id} tops out at y${l.y}`);
  for (const eye of eyes) {
    const seen = sightLine(eye, { x: l.x, y: l.y + 0.5, z: l.z }, 1);
    // The first voxel struck may be the landmark's own rim, sail or shell.
    const own = !seen.clear && Math.hypot(seen.at[0] + 0.5 - l.x, seen.at[2] + 0.5 - l.z) <= 10 && seen.at[1] >= l.y - 12;
    assert.ok(seen.clear || own, `${l.id} visible from ${eye.id} HQ (blocked at ${seen.at})`);
  }
}

// ------------------------------------------------------ cover at each flag
for (const flag of meta.conquest.flags) {
  const covered = new Set();
  for (let a = 0; a < 360; a += 2) {
    const sector = Math.floor(((a + 22.5) % 360) / 45);
    const rad = a * Math.PI / 180;
    for (let r = 10; r <= 35; r += 0.5) {
      const x = Math.floor(flag.x + Math.cos(rad) * r), z = Math.floor(flag.z + Math.sin(rad) * r);
      const g = frontierTopY(x + 0.5, z + 0.5);
      const block = world.getBlock(x, g + 1, z), above = world.getBlock(x, g + 2, z);
      const berm = g + 1 - flag.y >= 1.5;               // the ground itself shields a crouched body
      // A trench: the terrain top and the voxel below it are dug out.
      const dugIn = !isSolidBlock(world.getBlock(x, g, z)) && !isSolidBlock(world.getBlock(x, g - 1, z)) && world.getBlock(x, g, z) !== MC_WATER;
      if ((isSolidBlock(block) && isSolidBlock(above) && block !== MC_WATER) || berm || dugIn) { covered.add(sector); break; }
    }
  }
  assert.ok(covered.size >= 6, `flag ${flag.id} has cover in ${covered.size}/8 directions`);
}

// --------------------------------------------- generation, payload, memory
const bytes = world.serializeWorld();
assert.ok(bytes.length <= 3.0 * 1024 * 1024, `serialized payload ${bytes.length} <= 3.0 MB`);
const roundtrip = templates.createMapState('frontier', bytes);
for (const [x, y, z] of [[384, 25, 384], [72, 36, 384], [261, 78, 546], [0, 0, 0], [767, 40, 767]]) {
  assert.equal(roundtrip.getBlock(x, y, z), world.getBlock(x, y, z), `roundtrip ${x},${y},${z}`);
}
assert.ok(generateMs + terrainMs <= 1500, `server generation ${(generateMs + terrainMs).toFixed(0)}ms <= 1.5 s`);
// Today's Frontier held 1024 x 48 x 1024 blocks plus an int16 height map per state.
const before = 1024 * 48 * 1024 + 1024 * 1024 * 2;
const now = SX * SY * SZ + N * 2;
const terrainBytes = Object.values(terrain).filter(v => ArrayBuffer.isView(v)).reduce((s, v) => s + v.byteLength, 0);
assert.ok(now + terrainBytes <= before * 1.1, `map memory ${(now + terrainBytes) / 1e6} MB within +10% of ${before / 1e6} MB`);
const rss = (process.memoryUsage().rss - rss0) / 1048576;
console.log(`Frontier terrain passed: terrain ${terrainMs.toFixed(0)}ms, template ${generateMs.toFixed(0)}ms, payload ${bytes.length} B, `
  + `std ${std.toFixed(2)}, top mix ${[...hist.values()].filter(v => v / N > 0.02).length} materials > 2%, max ${(Math.max(...shares) * 100).toFixed(1)}%, `
  + `rss +${rss.toFixed(0)} MiB, hash ${hash.toString(16)}`);
