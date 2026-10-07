// Frontier v2 HQ airfields (spec 4.3): each HQ plateau carries a 300 m+
// runway along z with a clear wing corridor and a terrain approach below the
// glide slope, two helipads open to the sky, a hangar with the team roundel,
// a climbable control tower, the motor pool and fuel farm. Bravo's airfield is
// the exact point mirror of alpha's, and every coordinate comes from metadata.
import assert from 'node:assert/strict';
import { FRONTIER_PLAN } from '../shared/conquest-contract.js';
import { createMapState, getMapMeta } from '../shared/world/templates.js';
import { FRONTIER_AIRFIELDS } from '../shared/world/frontier-layout.js';
import { HQ_LAYOUT } from '../shared/world/frontier-sites/hq-airfield.js';
import { frontierTopY } from '../shared/world/frontier-terrain.js';
import {
  AIR, ASPHALT, CONCRETE, PALE, METAL, GLASS, POOL_TILE_BLUE, ACCENT, TRUCK_RED, CORRUGATED_STEEL, isSolidBlock,
} from '../shared/world/blocks.js';
import { ladderContact } from '../shared/world/state.js';

const meta = getMapMeta('frontier'), world = createMapState('frontier');
const { sx: SX, sy: SY, sz: SZ } = FRONTIER_PLAN.dimensions;
const plateauY = FRONTIER_PLAN.heights.hqPlateau;
const get = (x, y, z) => world.getBlock(x, y, z);
const solid = (x, y, z) => isSolidBlock(get(x, y, z));

assert.equal(meta.conquest.airfields.length, 2);
assert.equal(FRONTIER_AIRFIELDS.length, 2);
assert.deepEqual(FRONTIER_AIRFIELDS[0], meta.conquest.airfields[0]);
const [alpha, bravo] = meta.conquest.airfields;
assert.deepEqual([alpha.team, bravo.team], ['alpha', 'bravo']);
assert.deepEqual([alpha.id, bravo.id], ['alpha-airfield', 'bravo-airfield']);

for (const field of meta.conquest.airfields) {
  const hq = meta.conquest.bases[field.team];
  const r = field.runway;
  assert.deepEqual(field.runways, [r]);
  assert.ok(r.length >= 300 && r.width >= 24, `${field.team}: runway ${r.length} x ${r.width}`);
  assert.equal(r.y, plateauY + 1.02);
  // Takeoff runs along the runway heading for at least 300 m.
  const heading = [-Math.sin(r.yaw), -Math.cos(r.yaw)];
  const run = (r.takeoffEnd.x - r.takeoffStart.x) * heading[0] + (r.takeoffEnd.z - r.takeoffStart.z) * heading[1];
  assert.ok(run >= 300, `${field.team}: takeoff run ${run}`);
  assert.ok(r.takeoffStart.z >= r.z0 && r.takeoffStart.z <= r.z1 && r.takeoffEnd.z >= r.z0 && r.takeoffEnd.z <= r.z1);
  // Asphalt strip with painted edges, and a clear wing and airframe corridor.
  const x0 = Math.floor(r.x - r.width / 2), x1 = x0 + r.width - 1;
  for (let z = Math.ceil(r.z0); z < r.z1; z++) for (let x = x0; x <= x1; x++) {
    assert.ok([ASPHALT, PALE].includes(get(x, plateauY, z)), `${field.team}: runway surface ${x},${z}`);
    for (let y = plateauY + 1; y <= plateauY + 12; y++) assert.equal(get(x, y, z), AIR, `${field.team}: wing corridor ${x},${y},${z}`);
  }
  // Beyond the takeoff end the ground stays under a 1:5 climb (after 90 m level).
  const endZ = heading[1] < 0 ? r.z0 : r.z1;
  for (let d = 1; d <= 150; d++) {
    const z = Math.floor(endZ + heading[1] * d);
    if (z < 0 || z >= SZ) break;
    const cap = plateauY + Math.max(0, d - 90) / 5 + 1;
    for (let x = x0; x <= x1; x += 5) {
      let top = 0;
      for (let y = SY - 1; y > 0; y--) if (solid(x, y, z)) { top = y; break; }
      assert.ok(top <= cap, `${field.team}: departure corridor ${x},${z} top ${top} under ${cap.toFixed(1)}`);
    }
  }
  // Helipads: concrete, flat, open to the sky over the rotor disc.
  assert.equal(field.helipads.length, 2);
  assert.deepEqual(field.helipad, field.helipads[0]);
  for (const pad of field.helipads) {
    const cx = Math.floor(pad.x), cz = Math.floor(pad.z);
    for (let dz = -pad.radius; dz <= pad.radius; dz++) for (let dx = -pad.radius; dx <= pad.radius; dx++) {
      if (dx * dx + dz * dz > pad.radius * pad.radius) continue;
      assert.ok([CONCRETE, PALE].includes(get(cx + dx, plateauY, cz + dz)), `${field.team}: helipad surface`);
      for (let y = plateauY + 1; y < SY; y++) assert.equal(get(cx + dx, y, cz + dz), AIR, `${field.team}: rotor and vertical departure clear`);
    }
    assert.ok(Math.hypot(pad.x - hq.x, pad.z - hq.z) < 120, `${field.team}: helipad belongs to the HQ`);
  }
  // Hangar with the team roundel on the gable facing the valley.
  const [hangar] = field.hangars;
  assert.equal(hangar.kind, 'aircraft hangar');
  const gableX = field.team === 'alpha' ? HQ_LAYOUT.hangar.maxX + 1 : SX - 1 - (HQ_LAYOUT.hangar.maxX + 1);
  const roundel = new Set();
  for (let z = Math.floor(hangar.z) - 7; z <= Math.floor(hangar.z) + 7; z++) for (let y = plateauY + 1; y <= plateauY + 16; y++) roundel.add(get(gableX, y, z));
  if (field.team === 'alpha') assert.ok(roundel.has(POOL_TILE_BLUE) && roundel.has(PALE), 'WEST roundel is blue');
  else assert.ok(roundel.has(ACCENT) && roundel.has(TRUCK_RED), 'EAST roundel is red');
  assert.ok(solid(Math.floor(hangar.x), plateauY + 14, Math.floor(hangar.z)) || get(Math.floor(hangar.x), plateauY + 13, Math.floor(hangar.z)) === CORRUGATED_STEEL, 'hangar roof');
  assert.equal(get(Math.floor(hangar.entrance.x), plateauY + 1, Math.floor(hangar.entrance.z)), AIR, 'hangar is open to the taxiway');
  // Control tower: a glazed cab and a climbable ladder in the metadata.
  const tower = field.tower, ladder = tower.ladder;
  const lx = (ladder.minX + ladder.maxX) / 2, lz = (ladder.minZ + ladder.maxZ) / 2;
  assert.ok(ladderContact(meta, lx, plateauY + 6, lz), `${field.team}: tower ladder is climb metadata`);
  assert.ok(meta.ladders.some(l => l.minX === ladder.minX && l.minZ === ladder.minZ));
  let glass = 0;
  for (let z = Math.floor(tower.z - tower.d / 2); z <= tower.z + tower.d / 2; z++) for (let x = Math.floor(tower.x - tower.w / 2); x <= tower.x + tower.w / 2; x++) {
    if (get(x, plateauY + 15, z) === GLASS) glass++;
  }
  assert.ok(glass >= 16, `${field.team}: glazed tower cab`);
  let rungs = 0;
  for (let y = plateauY + 1; y <= plateauY + 14; y++) for (let x = Math.floor(ladder.minX) - 1; x <= Math.ceil(ladder.maxX); x++) for (let z = Math.floor(ladder.minZ); z <= Math.ceil(ladder.maxZ); z++) if (get(x, y, z) === METAL) rungs++;
  assert.ok(rungs >= 14, `${field.team}: ladder rails and rungs`);
  // Motor pool, fuel farm and taxiway sit on the plateau.
  for (const bay of field.motorBays) {
    assert.equal(frontierTopY(bay.x, bay.z), plateauY);
    assert.equal(get(Math.floor(bay.x), plateauY, Math.floor(bay.z)), CONCRETE, `${bay.id} concrete bay`);
  }
  assert.ok(field.fuelFarm.w > 10 && field.taxiways.length >= 1 && field.walkingRoutes.length === 5);
  for (const route of field.walkingRoutes) assert.ok(Math.hypot(route[0].x - hq.x, route[0].z - hq.z) < 1, 'pickup routes start at the HQ');
}

// Bravo mirrors alpha point-symmetrically about the map centre.
const mirrored = (a, b) => Math.abs(a.x + b.x - SX) < 1e-9 && Math.abs(a.z + b.z - SZ) < 1e-9;
assert.ok(mirrored(alpha.runway.takeoffStart, bravo.runway.takeoffStart) && mirrored(alpha.runway.takeoffEnd, bravo.runway.takeoffEnd));
alpha.helipads.forEach((h, i) => assert.ok(mirrored(h, bravo.helipads[i])));
assert.ok(mirrored(alpha.tower, bravo.tower) && mirrored(alpha.hangars[0], bravo.hangars[0]));
let diff = 0, checked = 0;
for (let z = 200; z < 568; z += 3) for (let x = 26; x < 146; x += 3) for (let y = plateauY + 1; y <= plateauY + 21; y += 2) {   // built structures (ground paint is noise-varied)
  checked++;
  const a = get(x, y, z), b = get(SX - 1 - x, y, SZ - 1 - z);
  if (a !== b && !([POOL_TILE_BLUE, ACCENT, TRUCK_RED].includes(a) || [POOL_TILE_BLUE, ACCENT, TRUCK_RED].includes(b))) diff++;
}
assert.ok(diff <= checked * 0.01, `HQ voxels are mirrored (${diff}/${checked} differ)`);
console.log(`Frontier airfields passed: runway ${alpha.runway.length} m, ${checked} mirrored HQ samples, ${meta.ladders.length} ladders.`);
