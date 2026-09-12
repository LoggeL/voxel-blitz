import assert from 'node:assert/strict';
import { AIR, GLASS, createMapState } from '../shared/worlddata.js';
import { LARGE_MAP_LIGHTS, lightFixtureGeometry } from '../shared/world/large-map-lights.js';
import { buildMapLights } from '../public/js/engine/map-lights.js';
import { buildMapSigns } from '../public/js/engine/map-signs.js';

for (const id of ['harbor', 'canyon']) {
  const world = createMapState(id);
  const lights = buildMapLights(id, world.getBlock);
  assert.ok(lights.stats.visible >= (id === 'harbor' ? 8 : 6), `${id} authored lamps have intact authoritative backing`);
  assert.equal(lights.stats.drawCalls, id === 'harbor' ? 2 : 1);
  assert.equal(lights.stats.dynamicLights, 0);
  assert.ok(lights.stats.faces <= 32);
  let lightNodes = 0;
  lights.group.traverse(node => { if (node.isLight) lightNodes++; });
  assert.equal(lightNodes, 0);
  const versions = lights.group.children.map(mesh => mesh.instanceMatrix.version);
  for (let frame = 0; frame < 100; frame++) lights.refresh();
  assert.deepEqual(lights.group.children.map(mesh => mesh.instanceMatrix.version), versions,
    'unchanged lighting does not upload instance buffers');

  let tested = 0;
  for (const light of LARGE_MAP_LIGHTS[id]) {
    const fixture = lightFixtureGeometry(light);
    if (!fixture.cells.every(([x, y, z, type]) => world.getBlock(x, y, z) === type)) continue;
    const before = lights.stats.visible;
    const stem = fixture.cells[0];
    world.setBlock(...stem.slice(0, 3), AIR);
    lights.refresh();
    assert.equal(lights.stats.visible, before - 1, 'breaking the grounded stem removes all luminous faces');
    const late = buildMapLights(id, world.getBlock);
    assert.equal(late.stats.visible, before - 1, 'late joins cannot restore a floating light');
    late.dispose();
    world.setBlock(...stem.slice(0, 3), GLASS);
    lights.refresh();
    assert.equal(lights.stats.visible, before - 1, 'transparent replacement cannot support a lamp');
    world.setBlock(...stem);
    lights.refresh();
    assert.equal(lights.stats.visible, before);
    const floorType = world.getBlock(...fixture.foundation);
    world.setBlock(...fixture.foundation, AIR);
    lights.refresh();
    assert.equal(lights.stats.visible, before - 1, 'excavated foundation disables the fixture');
    world.setBlock(...fixture.foundation, floorType);
    lights.refresh();
    assert.equal(lights.stats.visible, before);
    tested++;
  }
  let released = 0;
  const expected = lights.group.children.length * 3;
  for (const mesh of lights.group.children) for (const resource of [mesh, mesh.geometry, mesh.material])
    resource.addEventListener('dispose', () => released++);
  lights.dispose(); lights.dispose();
  assert.equal(released, expected, 'map lighting releases each GPU resource exactly once');
  console.log(`${id}: ${tested} voxel-supported fixtures, bounded instancing, destruction, late joins and teardown passed.`);
}

// The large luminous sign faces also require a complete grounded mount.
const previousDocument = globalThis.document;
globalThis.document = { createElement: () => ({ getContext: () => ({ fillRect() {}, fillText() {} }) }) };
try {
  for (const [id, post] of [['harbor', [37, 47]], ['canyon', [27, 61]]]) {
    const world = createMapState(id);
    const signs = buildMapSigns(id, world.getBlock);
    const face = signs.group.children[0];
    assert.ok(face, `${id} luminous sign exists`);
    for (const y of [14, 15, 20]) {
      const cell = [post[0], y, post[1]];
      const material = world.getBlock(...cell);
      world.setBlock(...cell, AIR); signs.refresh();
      assert.equal(face.visible, false, `${id} sign switches off when its foundation or post is broken`);
      const late = buildMapSigns(id, world.getBlock);
      assert.ok(!late.group.children.some(mesh => mesh.name === face.name));
      late.dispose();
      world.setBlock(...cell, material); signs.refresh();
      assert.equal(face.visible, true);
    }
    signs.dispose();
    console.log(`${id}: luminous sign foundation, post destruction and late joins passed.`);
  }
} finally {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
}
