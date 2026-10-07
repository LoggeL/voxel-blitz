import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import {
  ConquestWorld, CONQUEST_FLAG_COLORS, conquestFlagStates, CLOTH_LOW, CLOTH_HIGH, LABEL_DEPTH_DISTANCE, MAST_HEIGHT,
  RING_VERTICES_PER_FLAG,
} from '../public/js/engine/conquest-world.js';
import { FRONTIER_PLAN } from '../shared/conquest-contract.js';
import { createFrontierMetadata } from '../shared/world/frontier-layout.js';

const calls = [];
const context = new Proxy({}, { get: (_target, name) => (...args) => calls.push([name, ...args]), set: () => true });
globalThis.document = { createElement: kind => {
  assert.equal(kind, 'canvas'); return { getContext: kind => { assert.equal(kind, '2d'); return context; } };
} };

// A flat ground at y < 10 with a raised 3-voxel bank crossing flag C's ring.
const C = FRONTIER_PLAN.flags.find(flag => flag.id === 'C');
const bank = (x, z) => x >= C.x + C.radius - 2 && x <= C.x + C.radius + 2 && Math.abs(z - C.z) <= 3;
// A roof slab (y 14) over part of flag A's ring, open underneath like a house interior.
const A = FRONTIER_PLAN.flags.find(flag => flag.id === 'A');
const roof = (x, z) => x >= A.x + A.radius - 4 && x <= A.x + A.radius + 4 && Math.abs(z - A.z) <= 5;
const solid = new Set();
const getBlock = (x, y, z) => (y < 10 || (bank(x, z) && y < 13) || (roof(x, z) && y === 14) || solid.has(`${x},${y},${z}`) ? 1 : 0);
const layout = { flags: FRONTIER_PLAN.flags.map(flag => ({ ...flag, y: 10.02 })) };

const scene = new THREE.Scene(), existingWorld = new THREE.Group(); scene.add(existingWorld);
const world = new ConquestWorld(scene, layout, { getBlock });
scene.updateMatrixWorld(true);
assert.equal(world.flags.size, 5, 'every authored flag renders: no flag cap');
assert.equal(world.masts.count, 5);
assert.equal(world.cloths.count, 5);
assert.equal(world.beams.count, 5);
assert.equal(world.stats.draws, 9, 'masts, cloths, beams and rings are one draw each, plus one marker per flag');
assert.equal(world.group.visible, false, 'default and legacy modes hide Conquest objectives');
world.setMode('tdm'); assert.equal(world.group.visible, false);
world.setMode('conquest'); assert.equal(world.group.visible, true);

// Capture rings sit on the ground at the authored radius, including on the
// bank, and under a roof rather than on it.
const ring = world.ringPositions.array, perFlag = RING_VERTICES_PER_FLAG;
for (const flag of world.order) {
  for (let v = 0; v < perFlag; v++) {
    const x = ring[(flag.index * perFlag + v) * 3], y = ring[(flag.index * perFlag + v) * 3 + 1], z = ring[(flag.index * perFlag + v) * 3 + 2];
    const r = Math.hypot(x - flag.x, z - flag.z);
    assert.ok(Math.abs(r - flag.radius) <= 0.36, `${flag.id} ring follows the capture radius`);
    const expected = bank(Math.floor(x), Math.floor(z)) ? 13.06 : 10.06;
    assert.ok(Math.abs(y - expected) < 0.001, `${flag.id} ring is seated on the ground (${y} vs ${expected})`);
  }
  // A segment never stands up as a sheet: steps over 1.25 m (the 3 m bank edge) are dropped.
  for (let q = 0; q < perFlag; q += 4) {
    const base = (flag.index * perFlag + q) * 3, rise = Math.abs(ring[base + 7] - ring[base + 1]);
    assert.equal(world.ringShow.array[flag.index * perFlag + q], rise > 1.25 ? 0 : 1, `${flag.id} ring drops only climbing segments`);
  }
}
const shown = (flag) => { let n = 0; for (let q = 0; q < perFlag; q += 4) n += world.ringShow.array[flag.index * perFlag + q]; return n; };
assert.equal(shown(world.flags.get('A')), perFlag / 4, 'a ring under a roof stays whole on the floor');
assert.equal(shown(world.flags.get('C')), perFlag / 4 - 2, 'the two segments climbing the bank are hidden');
assert.equal(world.beams.material.premultipliedAlpha, true, 'the premultiplied additive beam actually adds light');

const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), color = new THREE.Color();
const clothY = (flag) => { world.cloths.getMatrixAt(flag.index, matrix); return position.setFromMatrixPosition(matrix).y - flag.y; };
const clothColor = (flag) => { world.cloths.getColorAt(flag.index, color); return color.getHex(); };
const beamColor = (flag) => { world.beams.getColorAt(flag.index, color); return color.getHex(); };
const beamGlow = (flag) => world.beamParams.getX(flag.index);
const ringColor = (flag) => color.setRGB(...world.ringColors.array.slice(flag.index * perFlag * 3, flag.index * perFlag * 3 + 3)).getHex();

// Neutral start: every cloth sits low and grey.
world.update(1 / 60);
for (const flag of world.order) {
  assert.ok(Math.abs(clothY(flag) - CLOTH_LOW) < 1e-5, 'neutral cloths start lowered');
  assert.equal(clothColor(flag), CONQUEST_FLAG_COLORS.neutral);
}

// Authoritative v2 wire rows: [id, control100, owner, state, atk, def].
const match = { conquest: { v: 2, tickets: { alpha: 300, bravo: 300 }, maxTickets: 300, flags: [
  ['A', 100, 'alpha', 'idle', 0, 0],
  ['B', -40, 'bravo', 'neutralizing', 2, 1],
  ['C', 0, null, 'contested', 2, 2],
  ['D', -100, 'bravo', 'idle', 0, 0],
  ['E', 60, null, 'capturing', 1, 0],
] } };
const decoded = conquestFlagStates(match, layout);
assert.deepEqual(decoded.map(f => [f.id, f.control, f.owner, f.state]), [
  ['A', 1, 'alpha', 'idle'], ['B', -0.4, 'bravo', 'neutralizing'], ['C', 0, null, 'contested'],
  ['D', -1, 'bravo', 'idle'], ['E', 0.6, null, 'capturing'],
], 'the shared decoder normalises the wire rows');
world.sync(match);
const flagA = world.flags.get('A'), flagB = world.flags.get('B'), flagC = world.flags.get('C');
const flagD = world.flags.get('D'), flagE = world.flags.get('E');
world.update(1 / 60);
assert.ok(clothY(flagA) > CLOTH_LOW && clothY(flagA) < CLOTH_HIGH, 'the hoist eases toward authority instead of snapping');
for (let i = 0; i < 120; i++) world.update(1 / 60);
const height = amount => CLOTH_LOW + (CLOTH_HIGH - CLOTH_LOW) * amount;
assert.ok(Math.abs(clothY(flagA) - height(1)) < 1e-4, 'full control hoists the cloth to the masthead');
assert.ok(Math.abs(clothY(flagB) - height(0.4)) < 1e-4, 'a neutralizing flag lowers with control');
assert.ok(Math.abs(clothY(flagC) - height(0)) < 1e-4, 'a neutral flag sits at the foot');
assert.ok(Math.abs(clothY(flagE) - height(0.6)) < 1e-4, 'a capturing flag rises with control');
assert.ok(CLOTH_HIGH + 1.6 <= MAST_HEIGHT, 'the hoisted cloth stays on the mast');
assert.equal(clothColor(flagA), CONQUEST_FLAG_COLORS.own, 'WEST colours without a viewer team');
assert.equal(clothColor(flagB), CONQUEST_FLAG_COLORS.enemy, 'the cloth shows the side holding control');
assert.equal(clothColor(flagC), CONQUEST_FLAG_COLORS.neutral);
assert.equal(clothColor(flagE), CONQUEST_FLAG_COLORS.own, 'the capturing side raises its own cloth');
assert.equal(beamColor(flagA), CONQUEST_FLAG_COLORS.own, 'beam colour follows the owner');
assert.equal(beamColor(flagB), CONQUEST_FLAG_COLORS.enemy);
assert.equal(beamColor(flagE), CONQUEST_FLAG_COLORS.neutral, 'an unowned flag keeps a neutral beam while it is captured');
assert.equal(ringColor(flagD), new THREE.Color(CONQUEST_FLAG_COLORS.enemy).getHex(), 'the ground ring takes the owner colour');
assert.ok(beamGlow(flagA) > 1, 'owned beams are emissive above 1.0 (HDR bloom)');

// Contested flags pulse; settled ones hold a constant glow.
const samples = { A: new Set(), C: new Set() };
for (let i = 0; i < 40; i++) {
  world.update(0.037);
  samples.A.add(beamGlow(flagA).toFixed(4)); samples.C.add(beamGlow(flagC).toFixed(4));
}
assert.equal(samples.A.size, 1, 'a settled beam does not pulse');
assert.ok(samples.C.size > 10, 'a contested beam pulses');
assert.ok(calls.some(call => call[0] === 'arc' && call[3] === 114), 'the marker draws the authoritative control arc');

// Team-relative colours for the local player.
world.setViewerTeam('bravo');
world.update(1 / 60);
assert.equal(beamColor(flagA), CONQUEST_FLAG_COLORS.enemy);
assert.equal(beamColor(flagD), CONQUEST_FLAG_COLORS.own);
assert.equal(clothColor(flagB), CONQUEST_FLAG_COLORS.own);

// The letter marker draws over terrain only beyond 60 m.
const camera = new THREE.PerspectiveCamera();
camera.position.set(flagA.x + 10, flagA.y + 12, flagA.z); camera.updateMatrixWorld();
world.update(1 / 60, camera);
assert.equal(flagA.sprite.material.depthTest, true, 'near markers are depth tested');
assert.equal(flagC.sprite.material.depthTest, false, 'far markers ignore depth');
camera.position.set(flagA.x + LABEL_DEPTH_DISTANCE + 5, flagA.y, flagA.z); camera.updateMatrixWorld();
world.update(1 / 60, camera);
assert.equal(flagA.sprite.material.depthTest, false);
assert.ok(flagA.sprite.scale.x > 2.2, 'far markers grow to stay legible');

// Unchanged snapshots upload no label texture.
const version = flagA.texture.version;
world.sync(match); world.update(1 / 60);
assert.equal(flagA.texture.version, version, 'unchanged snapshots do not upload the label again');

// A whole capture (control 0 -> 100 over 100 snapshots) repaints the marker in
// bounded arc steps, not on every eased frame.
world.sync({ conquest: { v: 2, flags: [['A', 0, null, 'capturing', 1, 0]] } });
for (let i = 0; i < 240; i++) world.update(1 / 60);
const beforeCapture = flagA.texture.version;
for (let c = 1; c <= 100; c++) {
  world.sync({ conquest: { v: 2, flags: [['A', c, c === 100 ? 'alpha' : null, c === 100 ? 'idle' : 'capturing', 1, 0]] } });
  for (let f = 0; f < 4; f++) world.update(1 / 60);
}
for (let i = 0; i < 120; i++) world.update(1 / 60);
const repaints = flagA.texture.version - beforeCapture;
assert.ok(repaints >= 20 && repaints <= 60, `a capture repaints the marker ${repaints} times`);
world.sync(match); for (let i = 0; i < 120; i++) world.update(1 / 60);

// A destroyed bank re-seats the ring at the new ground.
const bankCell = { x: Math.floor(C.x + C.radius), z: Math.floor(C.z) };
world.applyDeltas([{ x: bankCell.x, y: 12, z: bankCell.z, v: 0 }]);
assert.equal(flagC.ringDirty, true);
world.update(1 / 60);
assert.equal(flagC.ringDirty, false);

// Pre-v2 objects and malformed input stay safe.
world.sync(null); world.sync({ conquest: { flags: [null, { id: 'unknown' }] } });
world.sync({ conquest: { flags: [{ id: 'A', owner: 'alpha', capturing: 'bravo', progress: 0.25, contested: false }] } });
assert.equal(flagA.control, 0.75, 'a legacy capture against the owner lowers its cloth');
assert.equal(flagA.state, 'neutralizing');
world.setMode('snd'); assert.equal(world.group.visible, false);

// Settled objectives (nothing easing, nothing contested) upload no buffers.
world.sync({ conquest: { v: 2, flags: match.conquest.flags.map(row => (row[3] === 'contested' ? [row[0], 0, null, 'idle', 0, 0] : row)) } });
for (let i = 0; i < 240; i++) world.update(1 / 60);
const uploads = () => [world.ringColors.version, world.cloths.instanceMatrix.version, world.beamParams.version];
const settled = uploads();
for (let i = 0; i < 30; i++) world.update(1 / 60);
assert.deepEqual(uploads(), settled, 'settled flags re-upload nothing per frame');
world.sync({ conquest: { v: 2, flags: [['C', 0, null, 'contested', 1, 1]] } });
world.update(1 / 60); world.update(1 / 60);
assert.notDeepEqual(uploads(), settled, 'a contested zone pulses again');

// The current layout renders every flag it authors.
const meta = createFrontierMetadata();
const live = new ConquestWorld(null, meta.conquest);
assert.equal(live.flags.size, meta.conquest.flags.length);
live.dispose();

const resources = new Set();
world.group.traverse(object => {
  if (object.geometry) resources.add(object.geometry);
  for (const material of Array.isArray(object.material) ? object.material : object.material ? [object.material] : []) {
    resources.add(material); if (material.map) resources.add(material.map);
  }
});
const counts = new Map();
for (const resource of resources) resource.addEventListener('dispose', () => counts.set(resource, (counts.get(resource) ?? 0) + 1));
world.dispose(); world.dispose(); world.setMode('conquest'); world.sync(match); world.update(1, camera);
assert.equal(world.group.visible, false); assert.equal(world.flags.size, 0); assert.equal(world.group.children.length, 0);
assert.deepEqual(scene.children, [existingWorld], 'disposing flags preserves the existing world');
assert.equal(counts.size, resources.size);
for (const count of counts.values()) assert.equal(count, 1, 'shared and individual resources are disposed exactly once');
for (const bad of [undefined, {}, { flags: [{ id: 'A', x: NaN, y: 0, z: 1 }] }]) {
  const legacy = new ConquestWorld(scene, bad); legacy.setMode('conquest');
  assert.equal(legacy.group.visible, false); assert.equal(legacy.flags.size, 0); legacy.update(1); legacy.dispose();
}
delete globalThis.document;
console.log('Conquest world flags passed: five flags in nine draws, ground-seated rings, control-driven hoist, owner beams with contested pulse, team-relative colours, distance-gated marker depth and single disposal.');
