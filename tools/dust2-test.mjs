import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { AIR, GROUND, METAL, SX, SY, SZ, createMapState } from '../shared/worlddata.js';
import { isModeMapCompatible } from '../shared/modes.js';
import { generateDust2Into } from '../shared/world/flatmap-dust2.js';
import { createStateApi } from '../shared/world/state.js';
import { MINING_HITS, GRENADE_RESISTANCE } from '../shared/world/blocks.js';
import { MAP_HEADER_BYTES } from '../shared/world/serialize.js';
import { findPowerupSites, isPowerupSiteSupported } from '../shared/powerup-sites.js';
import {
  boxCollides, solidBelow, slidePlayerAxis, findVault, stepVault, VAULT_SECONDS, PHYSICS,
} from '../shared/player-movement.js';
import { DEFAULT_BLOCK_TILES, TILE_PAINTERS } from '../public/js/engine/atlas.js';

const world = createMapState('dust2');
const bytes = world.serializeWorld();
const solidAt = (x, y, z) => world.getBlock(x, y, z) !== AIR;
const bounds = world.meta.spawnBounds;
assert.ok(bounds, 'Dust 2 constrains expanded and recovery spawns to its arena');
assert.equal(world.meta.id, 'dust2');
for (const mode of ['fun', 'chaos', 'tdm', 'snd', 'gungame']) {
  assert.ok(isModeMapCompatible(mode, 'dust2'), `Dust 2 supports ${mode}`);
  assert.ok(world.meta.modes.includes(mode));
}
assert.equal(isModeMapCompatible('training', 'dust2'), false);

function assertFrozen(value) {
  if (!value || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value), 'shared map metadata is deeply frozen');
  for (const child of Object.values(value)) assertFrozen(child);
}
assertFrozen(world.meta);

// Exercise generation independently of the cached templates, then verify room
// clone isolation and wire round trips without fixing a voxel count or hash.
for (let run = 0; run < 2; run++) {
  const blocks = new Uint8Array(SX * SY * SZ);
  const heights = new Int16Array(SX * SZ);
  const generated = createStateApi(blocks, heights, null, 'dust2');
  generateDust2Into(generated, blocks, heights);
  assert.deepEqual(generated.serializeWorld(), bytes, 'independent generation is deterministic');
}
assert.deepEqual(createMapState('dust2', bytes).serializeWorld(), bytes);
const clone = createMapState('dust2');
const mutation = world.meta.spawns.fun[0];
clone.setBlock(mutation.x, mutation.y, mutation.z, METAL);
assert.equal(world.getBlock(mutation.x, mutation.y, mutation.z), AIR, 'room mutations are isolated');
assert.equal(createMapState('dust2').getBlock(mutation.x, mutation.y, mutation.z), AIR,
  'room mutations preserve the cached template');
assert.deepEqual(createMapState('dust2', clone.serializeWorld()).serializeWorld(), clone.serializeWorld(),
  'mutated map state survives a wire round trip');
for (const type of new Set(bytes.subarray(MAP_HEADER_BYTES))) {
  assert.ok(DEFAULT_BLOCK_TILES[type], `texture mapping for block ${type}`);
  for (const tile of Object.values(DEFAULT_BLOCK_TILES[type])) assert.ok(TILE_PAINTERS[tile]);
  if (type !== AIR) {
    assert.ok(MINING_HITS[type] > 0, `mining resistance for block ${type}`);
    assert.ok(GRENADE_RESISTANCE[type] > 0, `blast resistance for block ${type}`);
  }
}

const inside = point => point.x >= bounds.minX && point.x <= bounds.maxX
  && point.z >= bounds.minZ && point.z <= bounds.maxZ
  && point.y >= bounds.minY && point.y <= bounds.maxY;
const key = point => `${Math.floor(point.x)},${Math.floor(point.y)},${Math.floor(point.z)}`;
const centered = point => ({ x: Math.floor(point.x) + 0.5,
  y: Math.floor(point.y), z: Math.floor(point.z) + 0.5 });
const walkable = (point, collision = solidAt) => !boxCollides(collision, point.x, point.y, point.z)
  && solidBelow(collision, point.x, point.y, point.z);

// Route traversal includes normal jumps onto one-block stairs, plus ledge
// vaults for taller rises. Every move sweeps the body collider: a stair cannot
// bypass a low ceiling just because its destination standing cell is clear.
function jumpToStep(position, to, axis, collision) {
  const dt = 1 / 60;
  let vy = PHYSICS.jump;
  for (let frame = 0; frame < 90; frame++) {
    vy -= PHYSICS.gravity * dt;
    const distance = to[axis] - position[axis];
    // Stop at the next route node rather than leaping across untested cells.
    slidePlayerAxis(position, axis,
      Math.sign(distance) * Math.min(Math.abs(distance), PHYSICS.walk * dt), collision);
    const descending = vy < 0;
    if (slidePlayerAxis(position, 'y', vy * dt, collision)) {
      vy = 0;
      if (descending) return Math.abs(position.y - to.y) < 0.001;
    }
  }
  return false;
}

function connects(from, to, axis, collision = solidAt) {
  const position = { ...from };
  if (to.y > from.y && to.y - from.y <= 1) {
    if (!jumpToStep(position, to, axis, collision)) return false;
  } else if (to.y > from.y) {
    const wish = { x: Math.sign(to.x - from.x), z: Math.sign(to.z - from.z) };
    const vault = findVault(collision, from, wish, from.y);
    if (!vault || vault.to.y !== to.y) return false;
    stepVault(position, vault, VAULT_SECONDS, collision);
    if (Math.abs(position.y - to.y) > 0.001) return false;
  }
  if (slidePlayerAxis(position, axis, to[axis] - position[axis], collision)) return false;
  if (to.y < position.y && slidePlayerAxis(position, 'y', to.y - position.y, collision)) return false;
  return Math.abs(position.x - to.x) < 0.001 && Math.abs(position.y - to.y) < 0.001
    && Math.abs(position.z - to.z) < 0.001;
}

const stepFixture = (x, y) => y < 10 || (x >= 20 && y < 11);
const stepFrom = { x: 19.5, y: 10, z: 24.5 }, stepTo = { x: 20.5, y: 11, z: 24.5 };
assert.ok(connects(stepFrom, stepTo, 'x', stepFixture),
  'route modelling includes an ordinary jump onto a one-block step');
assert.equal(connects(stepFrom, stepTo, 'x', (x, y, z) => stepFixture(x, y, z)
  || (x === 19 && y === 12)), false, 'jump routes cannot pass through a low takeoff ceiling');

function reachableFrom(spawn, { collision = solidAt, within = () => true } = {}) {
  const start = centered(spawn);
  assert.ok(walkable(start, collision) && within(start), 'route traversal starts on a valid standing surface');
  const queue = [start], seen = new Set([key(start)]);
  for (let i = 0; i < queue.length; i++) {
    const point = queue[i];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const dy of [0, 1, -1]) {
        const next = { x: point.x + dx, y: point.y + dy, z: point.z + dz };
        if (next.x < bounds.minX || next.x > bounds.maxX
          || next.z < bounds.minZ || next.z > bounds.maxZ
          || next.y < GROUND + 1 || next.y >= SY - 2 || !within(next) || seen.has(key(next))
          || !walkable(next, collision) || !connects(point, next, dx ? 'x' : 'z', collision)) continue;
        seen.add(key(next));
        queue.push(next);
      }
    }
  }
  return seen;
}

const pools = [world.meta.spawns.fun, world.meta.spawns.tdm.alpha, world.meta.spawns.tdm.bravo,
  world.meta.spawns.snd.attackers, world.meta.spawns.snd.defenders];
for (const pool of pools) {
  assert.ok(pool.length >= 4, 'every combat spawn pool accommodates several players');
  assert.equal(new Set(pool.map(key)).size, pool.length, 'authored spawn positions are unique');
  for (const point of pool) {
    assert.ok(inside(point), `authored spawn remains inside the arena: ${JSON.stringify(point)}`);
    assert.ok(walkable(point), `authored spawn has ground and full body clearance: ${JSON.stringify(point)}`);
  }
}
const teamA = new Set(world.meta.spawns.tdm.alpha.map(key));
assert.ok(world.meta.spawns.tdm.bravo.every(point => !teamA.has(key(point))), 'team spawn pools are separate');
const attack = new Set(world.meta.spawns.snd.attackers.map(key));
assert.ok(world.meta.spawns.snd.defenders.every(point => !attack.has(key(point))), 'S&D sides start separately');
const seen = reachableFrom(world.meta.spawns.snd.attackers[0]);
const defendersSeen = reachableFrom(world.meta.spawns.snd.defenders[0]);
for (const point of pools.flat()) {
  assert.ok(seen.has(key(point)) && defendersSeen.has(key(point)),
    `both teams can reach spawn ${JSON.stringify(point)}`);
}

// Check recognizable route destinations at their playable floor, including
// covered tunnels and the raised Short/A route independently of roof height.
const routes = [
  ['T spawn', 65, 15, 84], ['Top Mid', 64, 15, 64], ['Mid', 59, 15, 40],
  ['Mid Doors', 59, 15, 30], ['Short A', 76, 18, 35], ['Catwalk', 72, 18, 47],
  ['A site', 99, 18, 23], ['Long A', 112, 15, 46], ['Long Doors', 99, 15, 64],
  ['Upper Tunnels', 24, 15, 61], ['Lower Tunnels', 42, 15, 50],
  ['B site', 26, 15, 23], ['B Doors', 43, 15, 24], ['CT spawn', 65, 15, 15],
];
for (const [name, x, y, z] of routes) {
  const point = { x: x + 0.5, y, z: z + 0.5 };
  assert.ok(seen.has(key(point)) && defendersSeen.has(key(point)), `${name} connects to both teams' routes`);
}
assert.deepEqual(new Set(world.meta.sites.map(site => site.id)), new Set(['A', 'B']));
for (const site of world.meta.sites) {
  for (let x = site.minX; x < site.maxX; x++) for (let z = site.minZ; z < site.maxZ; z++) {
    const point = { x: x + 0.5, y: site.y, z: z + 0.5 };
    assert.ok(walkable(point), `site ${site.id} has a clear planting floor at ${x},${z}`);
    assert.ok(seen.has(key(point)) && defendersSeen.has(key(point)),
      `site ${site.id} is accessible to both sides at ${x},${z}`);
  }
}
assert.ok(world.meta.sites.find(site => site.id === 'A').y
  > world.meta.sites.find(site => site.id === 'B').y, 'A retains its raised platform');
const powerups = findPowerupSites(world);
assert.ok(powerups.length >= 4, 'the arena provides four usable exposed powerup pads');
for (const point of powerups) {
  assert.ok(isPowerupSiteSupported(world, point) && walkable(point), 'powerup pad supports a standing player');
  assert.ok(seen.has(key(point)) && defendersSeen.has(key(point)), 'both sides can reach every powerup');
}
console.log(`Dust 2: deterministic geometry, materials and ${seen.size} connected player-sized standing positions verified.`);

// Connectivity alone could pass through a different lane. Restrict local
// crossings to their named corridor, then close its actual portal and prove
// that the local passage stops. The rest of the map keeps its alternate routes.
const pointAt = (x, y, z) => ({ x: x + 0.5, y, z: z + 0.5 });
const inRegion = ([minX, maxX, minZ, maxZ, minY, maxY]) => point =>
  point.x >= minX && point.x < maxX + 1 && point.z >= minZ && point.z < maxZ + 1
  && point.y >= minY && point.y <= maxY;
const closePortal = ([minX, maxX, minZ, maxZ, minY, maxY]) => (x, y, z) =>
  (x >= minX && x <= maxX && z >= minZ && z <= maxZ && y >= minY && y <= maxY)
  || solidAt(x, y, z);
const crossings = [
  {
    name: 'Mid Doors', from: [59, 15, 40], to: [59, 15, 20],
    region: [51, 67, 18, 43, 15, 15], portal: [55, 62, 29, 31, 15, 21],
  },
  {
    name: 'B tunnel arch', from: [24, 15, 61], to: [26, 15, 23],
    region: [16, 35, 20, 68, 15, 15], portal: [20, 27, 31, 33, 15, 21],
  },
  {
    name: 'B Doors', from: [48, 15, 24], to: [26, 15, 24],
    region: [23, 53, 20, 28, 15, 15], portal: [40, 42, 21, 26, 15, 21],
  },
  {
    name: 'Catwalk to Short A', from: [72, 15, 67], to: [90, 18, 30],
    region: [68, 93, 29, 69, 15, 18], portal: [68, 76, 47, 48, 18, 21],
  },
  {
    name: 'B window vault', from: [46, 15, 16], to: [35, 15, 16],
    region: [35, 48, 13, 18, 15, 16], portal: [39, 42, 14, 17, 16, 19],
  },
];
for (const crossing of crossings) {
  const from = pointAt(...crossing.from), to = pointAt(...crossing.to);
  const within = inRegion(crossing.region);
  assert.ok(reachableFrom(from, { within }).has(key(to)), `${crossing.name} works independently of other lanes`);
  assert.ok(reachableFrom(to, { within }).has(key(from)), `${crossing.name} is usable in both directions`);
  assert.equal(reachableFrom(from, { within, collision: closePortal(crossing.portal) }).has(key(to)), false,
    `${crossing.name} crosses its intended opening without a local bypass`);
}
const tSpawn = pointAt(65, 15, 84), longA = pointAt(112, 15, 46);
const groundOnly = point => point.y === GROUND + 1;
assert.ok(reachableFrom(tSpawn, { within: groundOnly }).has(key(longA)), 'T spawn reaches Long A at ground level');
const longClosed = reachableFrom(tSpawn, { within: groundOnly,
  collision: closePortal([97, 99, 61, 66, 15, 21]) });
assert.equal(longClosed.has(key(longA)), false, 'Long Doors are required for the ground route from T into Long A');
for (const destination of [pointAt(59, 15, 40), pointAt(24, 15, 61)]) {
  assert.ok(longClosed.has(key(destination)), 'closing Long Doors preserves the independent Mid and tunnel lanes');
}
console.log('Dust 2: independent Mid/B/Catwalk crossings and required Long Doors ground passage verified.');

const engine = new GameEngine({ world });
const selector = engine.spawnSelector;
for (const pool of pools) {
  const expanded = selector.expand(pool);
  assert.ok(expanded.length > pool.length, 'spawn expansion provides additional valid positions');
  for (const point of expanded) {
    assert.ok(inside(point), `expanded spawn stays inside bounds: ${JSON.stringify(point)}`);
    assert.ok(walkable(point) && seen.has(key(point)),
      `expanded spawn has a playable exit: ${JSON.stringify(point)}`);
  }
  const selected = new Set();
  for (let i = 0; i < 40; i++) {
    selector.setNow(i * 100);
    const point = selector.pick(expanded, null, -1, { variety: true });
    assert.ok(inside(point) && walkable(point) && seen.has(key(point)));
    selected.add(key(point));
  }
  assert.ok(selected.size > 1, 'repeated respawns use more than one valid location');
}
const outside = { x: bounds.minX - 3, y: GROUND + 1, z: bounds.minZ + 6 };
assert.equal(selector.walkable(outside), false, 'outside positions cannot become fallback spawns');
for (const pool of [[], [outside]]) {
  const point = selector.pick(pool);
  assert.ok(inside(point) && walkable(point) && seen.has(key(point)), 'empty/outside pools recover on a playable floor');
}

const damaged = createMapState('dust2');
for (const point of pools.flat()) {
  damaged.setBlock(Math.floor(point.x), Math.floor(point.y) - 1, Math.floor(point.z), AIR);
}
const damagedSelector = new GameEngine({ world: damaged }).spawnSelector;
assert.ok(pools.flat().every(point => !damagedSelector.walkable(point)), 'destruction removes authored spawn support');
for (const pool of pools) {
  const point = damagedSelector.pick(pool);
  assert.ok(inside(point) && damagedSelector.walkable(point) && seen.has(key(point)),
    'destroyed authored pools recover inside the arena on surviving playable ground');
}
console.log('Dust 2: team pools, plant floors, expanded/repeated respawns and terrain-destruction recovery verified.');
