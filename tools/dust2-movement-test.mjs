import assert from 'node:assert/strict';
import { createMapState } from '../shared/worlddata.js';
import { boxCollides } from '../shared/player-movement.js';
import { slideTerrainAxis } from '../shared/terrain-steps.js';
import { DUST2_NAV_FLOORS } from '../shared/world/dust2-layout.js';

const world = createMapState('dust2');
const solid = (x, y, z) => world.getBlock(x, y, z) !== 0;
const floors = new Set();
for (let i = 0; i < DUST2_NAV_FLOORS.length; i += 3) {
  floors.add(DUST2_NAV_FLOORS.slice(i, i + 3).join(','));
}
const ascents = [];
for (let i = 0; i < DUST2_NAV_FLOORS.length; i += 3) {
  const [x, z, floor] = DUST2_NAV_FLOORS.slice(i, i + 3);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (!floors.has(`${x + dx},${z + dz},${floor + 1}`)) continue;
    const start = { x: x + .5, y: floor + 1.02, z: z + .5 };
    if (boxCollides(solid, start.x, start.y, start.z)) continue;
    const position = { ...start }, axis = dx ? 'x' : 'z', sign = dx || dz;
    for (let step = 0; step < 10; step++) {
      slideTerrainAxis(position, axis, sign * .1, solid, world.meta, true);
    }
    if (position.y === floor + 2 && Math.abs(position[axis] - start[axis] - sign) < 1e-6) {
      assert.equal(boxCollides(solid, position.x, position.y, position.z), false);
      ascents.push({ start, axis, sign });
    }
  }
}
assert.ok(ascents.length >= 100, 'many original ramp/stair edges can be walked without jumping');

const { start, axis, sign } = ascents[0];
function advance(meta, canStep, collision = solid) {
  const position = { ...start };
  for (let i = 0; i < 10; i++) slideTerrainAxis(position, axis, sign * .1, collision, meta, canStep);
  return position;
}
assert.equal(advance(world.meta, false).y, start.y, 'airborne/jumping callers cannot auto-step');
assert.equal(advance({ ...world.meta, id: 'foundry' }, true).y, start.y, 'other maps keep normal collision');
assert.equal(advance({ id: 'dust2', spawnBounds: { surfaces: [] } }, true).y, start.y,
  'ordinary boxes without a reference terrain surface are not auto-stepped');
const ceilingY = Math.floor(start.y) + 2;
const lowCeiling = (x, y, z) => solid(x, y, z)
  || (y === ceilingY && Math.abs(x - start.x) < 2 && Math.abs(z - start.z) < 2);
assert.equal(advance(world.meta, true, lowCeiling).y, start.y, 'a low ceiling prevents the step');
console.log(`Dust 2 walking: ${ascents.length} actual ramp/stair ascents, ceiling rejection and ordinary-collision guards passed.`);
