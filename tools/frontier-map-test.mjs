// Frontier v2 map contract: dimensions, the mapMeta.conquest v2 shape of spec
// 3.2, terrain-derived y values everywhere, standable spawns, the 15-hull
// fleet of spec 4.4 and an exact serialization round trip.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { MAP_MODE_COMPATIBILITY } from '../shared/modes.js';
import { FRONTIER_PLAN, VEHICLE_TYPE_IDS } from '../shared/conquest-contract.js';
import { createMapState, getMapMeta } from '../shared/world/templates.js';
import { FRONTIER_ROADS, FRONTIER_CONQUEST, FRONTIER_AIRFIELDS, frontierSurfaceY } from '../shared/world/frontier-layout.js';
import * as layoutModule from '../shared/world/frontier-layout.js';
import { frontierTopY } from '../shared/world/frontier-terrain.js';
import { BEDROCK, MC_WATER, isSolidBlock } from '../shared/world/blocks.js';
import { getMapDimensions, KNOWN_DIMENSIONS, FRONTIER_DIMENSIONS } from '../shared/world/dimensions.js';
import { boxCollides, solidBelow } from '../shared/player-movement.js';

const started = performance.now();
const meta = getMapMeta('frontier');
const plan = FRONTIER_PLAN;
const feetY = (x, z) => Math.round((frontierTopY(x, z) + 1.02) * 100) / 100;

// ------------------------------------------------------------- dimensions
assert.deepEqual(meta.dimensions, { sx: 768, sy: 80, sz: 768 });
assert.deepEqual(plan.dimensions, meta.dimensions);
assert.strictEqual(getMapDimensions('frontier'), FRONTIER_DIMENSIONS);
assert.ok(KNOWN_DIMENSIONS.includes(FRONTIER_DIMENSIONS));
assert.equal(meta.id, 'frontier'); assert.equal(meta.name, 'Frontier');
assert.strictEqual(meta.modes, MAP_MODE_COMPATIBILITY.frontier);
assert.ok(Object.isFrozen(meta) && Object.isFrozen(meta.conquest) && Object.isFrozen(meta.conquest.flags[0].spawns[0]));
assert.equal('FRONTIER_FLOOR' in layoutModule, false, 'FRONTIER_FLOOR is gone');

// -------------------------------------------------- top-level metadata
assert.deepEqual(meta.navigation, { mode: 'surface', cell: 4, maxStep: 1 });
assert.equal(meta.navigationFloor, null);
assert.equal(meta.groundLevel, 24);
assert.deepEqual(meta.spawnBounds, { minX: 24, maxX: 743, minZ: 24, maxZ: 743, minY: 20, maxY: 79 });
assert.strictEqual(meta.spawns.conquest.alpha, meta.spawns.tdm.alpha);
assert.deepEqual(meta.spawns.conquest, { alpha: meta.conquest.bases.alpha.spawns, bravo: meta.conquest.bases.bravo.spawns });
assert.equal(meta.spawns.fun.length, 16);

// ----------------------------------------------------- mapMeta.conquest v2
const c = meta.conquest;
assert.equal(c.version, 2);
assert.deepEqual(Object.keys(c).sort(), ['airfields', 'bases', 'combatArea', 'crossings', 'dressing', 'flags', 'roads', 'vehicleSpawns', 'version', 'weather'].sort());
assert.deepEqual(c.combatArea, plan.combatArea);
assert.ok(['golden', 'mist', 'overcast'].includes(c.weather));
assert.deepEqual(c.flags.map(f => f.id), ['A', 'B', 'C', 'D', 'E']);
for (const f of c.flags) {
  const p = plan.flags.find(q => q.id === f.id);
  assert.deepEqual(Object.keys(f).sort(), ['home', 'id', 'name', 'radius', 'site', 'spawns', 'x', 'y', 'z']);
  assert.deepEqual([f.name, f.site, f.x, f.z, f.radius, f.home], [p.name, p.site, p.x, p.z, p.radius, p.home]);
  assert.equal(f.y, feetY(f.x, f.z), `flag ${f.id} y is the terrain feet height`);
  assert.equal(f.spawns.length, 12);
  for (const s of f.spawns) assert.deepEqual(Object.keys(s).sort(), ['x', 'y', 'z']);
}
for (const team of ['alpha', 'bravo']) {
  const b = c.bases[team], hq = plan.hqs[team];
  assert.deepEqual([b.id, b.x, b.z, b.radius], [team, hq.x, hq.z, hq.radius]);
  assert.equal(b.name, hq.name);
  assert.equal(b.spawns.length, 8);
  assert.equal(b.y, feetY(b.x, b.z));
  assert.equal(new Set(b.spawns.map(s => `${s.x},${s.z}`)).size, 8);
  for (const s of b.spawns) assert.ok(Math.hypot(s.x - b.x, s.z - b.z) < b.radius, `${team} spawn inside the HQ`);
}
assert.equal(c.roads.length, FRONTIER_ROADS.length);
for (const r of c.roads) {
  assert.ok(['paved', 'gravel'].includes(r.kind) && r.width >= 7 && r.points.length >= 2, r.id);
  for (const [x, y, z] of r.points) assert.equal(y, feetY(x, z), `${r.id} point ${x},${z} y from the terrain`);
}
assert.equal(c.roads.find(r => r.id === 'axis').kind, 'paved');
assert.deepEqual(c.crossings.map(x => [x.id, x.kind, x.x, x.z, x.width]), plan.crossings.map(x => [x.id, x.kind, x.x, x.z, x.width]));
for (const x of c.crossings) assert.ok(x.y === feetY(x.x, x.z), `${x.id} y is the deck or ford bed`);
assert.ok(c.crossings.filter(x => x.kind === 'ford').every(x => x.y < plan.river.surfaceY + 1));
assert.ok(c.crossings.filter(x => x.kind === 'bridge').every(x => x.y > plan.river.surfaceY + 2));

// --------------------------------------------------- fleet (spec 4.4)
const fleet = c.vehicleSpawns;
assert.equal(fleet.length, 15);
const expected = [
  ...['alpha', 'bravo'].flatMap(team => ['jeep', 'tank', 'helicopter', 'transport', 'plane'].map(type => [`${team}-${type}`, team, type, undefined])),
  ['flag-A-jeep', 'alpha', 'jeep', 'A'], ['flag-B-jeep', 'alpha', 'jeep', 'B'], ['flag-C-tank', null, 'tank', 'C'],
  ['flag-D-jeep', 'bravo', 'jeep', 'D'], ['flag-E-jeep', 'bravo', 'jeep', 'E'],
];
assert.deepEqual(fleet.map(v => [v.id, v.team, v.type, v.flag]).sort(), expected.sort());
for (const v of fleet) {
  assert.ok(VEHICLE_TYPE_IDS.includes(v.type));
  assert.equal(v.y, feetY(v.x, v.z), `${v.id} rests on the terrain`);
  assert.ok(Number.isFinite(v.yaw));
  if (v.flag) {
    const flag = c.flags.find(f => f.id === v.flag);
    assert.ok(Math.hypot(v.x - flag.x, v.z - flag.z) <= flag.radius + 40, `${v.id} pad belongs to flag ${v.flag}`);
  }
}
const cTank = fleet.find(v => v.id === 'flag-C-tank');
assert.ok(cTank.x < plan.river.points[2][0] && cTank.altX > plan.river.points[2][0], 'C tank: west pad for alpha, east alt pad for bravo');
assert.equal(cTank.altY, feetY(cTank.altX, cTank.altZ));
// Bravo's HQ fleet is the point mirror of alpha's.
for (const type of ['jeep', 'tank', 'helicopter', 'transport', 'plane']) {
  const a = fleet.find(v => v.id === `alpha-${type}`), b = fleet.find(v => v.id === `bravo-${type}`);
  assert.ok(Math.abs(a.x + b.x - plan.dimensions.sx) < 1e-9 && Math.abs(a.z + b.z - plan.dimensions.sz) < 1e-9, `${type} pads are point-mirrored`);
  assert.ok(Math.abs(Math.cos(a.yaw) + Math.cos(b.yaw)) < 1e-9 && Math.abs(Math.sin(a.yaw) + Math.sin(b.yaw)) < 1e-9, `${type} yaw is mirrored`);
}
assert.equal(c.airfields.length, 2);
assert.deepEqual(c.airfields.map(a => a.team), ['alpha', 'bravo']);

// --------------------------------------------- landmarks and dressing
const ids = meta.landmarks.map(l => l.id);
for (const f of c.flags) assert.ok(ids.includes(f.id), `landmarks include flag ${f.id}`);
for (const id of ['kestrel-silo', 'st-aldric-spire', 'iron-bridge-arch', 'ridge-observation-tower', 'kessler-chimney-west', 'kessler-chimney-east'])
  assert.ok(ids.includes(id), `landmarks include ${id}`);
for (const l of meta.landmarks) assert.ok([l.x, l.y, l.z].every(Number.isFinite), l.id);
assert.ok(c.dressing.length >= 4 && c.dressing.every(d => /wreck/.test(d.id) && Number.isFinite(d.y)));

// ------------------------------------ every y comes from the terrain
const ys = [];
(function walk(value, path) {
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) {
    if (k === 'y' || k === 'altY') ys.push([path, v]);
    walk(v, `${path}.${k}`);
  }
})(meta, 'meta');
assert.ok(ys.length > 200);
assert.ok(ys.every(([, y]) => Number.isFinite(y) && y >= meta.spawnBounds.minY && y <= meta.spawnBounds.maxY), 'y within the spawn bounds');
assert.ok(!ys.some(([, y]) => y === 11.02 || y === 11), 'no flat-slab y constants remain');

// ------------------------------------------- legacy facade exports
assert.equal(FRONTIER_CONQUEST.flags.length, 5);
assert.deepEqual(Object.keys(FRONTIER_CONQUEST).sort(), Object.keys(c).sort());
assert.equal(FRONTIER_AIRFIELDS.length, 2);
assert.ok(Array.isArray(FRONTIER_AIRFIELDS) && FRONTIER_AIRFIELDS[0].runway.length >= 300);
assert.throws(() => { 'use strict'; FRONTIER_CONQUEST.flags = []; });
assert.ok(FRONTIER_ROADS.every(line => line.every(p => p.length === 2)));
assert.equal(frontierSurfaceY(384, 384), frontierTopY(384, 384) + 1);

// ------------------------------------------------------- the voxel world
const world = createMapState('frontier');
assert.strictEqual(world.meta, meta);
assert.strictEqual(createMapState('frontier').meta, meta);
const solid = (x, y, z) => isSolidBlock(world.getBlock(x, y, z));
for (const p of [...meta.spawns.fun, ...c.flags.flatMap(f => f.spawns)]) {
  assert.ok(solidBelow(solid, p.x, p.y, p.z) && !boxCollides(solid, p.x, p.y, p.z), `spawn ${p.x},${p.y},${p.z} is standable`);
  assert.notEqual(world.getBlock(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), MC_WATER);
}
assert.equal(world.getBlock(0, 0, 0), BEDROCK);
const serialized = world.serializeWorld();
assert.ok(serialized.length <= 3 * 1024 * 1024, `payload ${serialized.length}`);
const roundtrip = createMapState('frontier', serialized);
assert.deepEqual(roundtrip.dimensions, meta.dimensions);
assert.deepEqual(roundtrip.serializeWorld(), serialized, 'exact round trip');
console.log(`Frontier map passed: ${(performance.now() - started).toFixed(0)}ms, ${serialized.byteLength} serialized bytes, ${ys.length} terrain y values.`);
