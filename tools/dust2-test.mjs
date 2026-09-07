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
import { DUST2_NAV_FLOORS } from '../shared/world/dust2-layout.js';
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
      for (const dy of [0, 1, -1, 2, -2]) {
        const next = { x: point.x + dx, y: point.y + dy, z: point.z + dz };
        if (next.x < bounds.minX || next.x > bounds.maxX
          || next.z < bounds.minZ || next.z > bounds.maxZ
          || next.y < bounds.minY || next.y >= SY - 2 || !within(next) || seen.has(key(next))
          || !walkable(next, collision) || !connects(point, next, dx ? 'x' : 'z', collision)) continue;
        seen.add(key(next));
        queue.push(next);
      }
    }
  }
  return seen;
}

const navPositions = [];
const navKeys = new Set();
for (let i = 0; i < DUST2_NAV_FLOORS.length; i += 3) {
  const [x, z, floorY] = DUST2_NAV_FLOORS.slice(i, i + 3);
  const point = { x: x + 0.5, y: floorY + 1, z: z + 0.5 };
  navPositions.push(point);
  navKeys.add(key(point));
}
const pools = [world.meta.spawns.fun, world.meta.spawns.tdm.alpha, world.meta.spawns.tdm.bravo,
  world.meta.spawns.snd.attackers, world.meta.spawns.snd.defenders];
for (const pool of pools) {
  assert.ok(pool.length >= 4, 'every combat spawn pool accommodates several players');
  assert.equal(new Set(pool.map(key)).size, pool.length, 'authored spawn positions are unique');
  for (const point of pool) {
    assert.ok(inside(point) && navKeys.has(key(point)), `spawn uses an original navigation floor: ${key(point)}`);
    assert.ok(walkable(point), `spawn has ground and full body clearance: ${key(point)}`);
  }
}
const teamA = new Set(world.meta.spawns.tdm.alpha.map(key));
assert.ok(world.meta.spawns.tdm.bravo.every(point => !teamA.has(key(point))), 'team spawn pools are separate');
const attack = new Set(world.meta.spawns.snd.attackers.map(key));
assert.ok(world.meta.spawns.snd.defenders.every(point => !attack.has(key(point))), 'S&D sides start separately');
const seen = reachableFrom(world.meta.spawns.snd.attackers[0]);
const defendersSeen = reachableFrom(world.meta.spawns.snd.defenders[0]);
for (const point of pools.flat()) {
  assert.ok(seen.has(key(point)) && defendersSeen.has(key(point)), `both teams can reach spawn ${key(point)}`);
}

// These independent reference samples come from the original 2018 NAV areas,
// not from the generated map metadata. Source X/Y are horizontal and Z is up.
// Select a standing cell within one voxel of the measured point, keeping its
// expected elevation fixed; the raster grid can place a sample on a wall edge.
function sourcePoint(name, [sourceX, sourceY, sourceZ]) {
  const x = 64 + (sourceX + 212.5) / 48;
  const z = 48 - (sourceY - 975) / 48;
  const y = Math.round(15 + sourceZ / 48);
  const nearby = [];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const point = { x: Math.floor(x) + dx + 0.5, y, z: Math.floor(z) + dz + 0.5 };
    if (navKeys.has(key(point)) && walkable(point)) nearby.push(point);
  }
  nearby.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
  assert.ok(nearby.length, `${name} retains its measured position and elevation (${x.toFixed(2)},${y},${z.toFixed(2)})`);
  return nearby[0];
}
const references = {
  tSpawn: [-1587.5, -887.5, 128.285], tRamp: [-1925, -387.5, 68.148],
  outsideTunnel: [-1775, 325, 5.963], upperTunnel: [-2125, 1137.5, 32.031],
  tunnelStairs: [-1087.5, 1275, -103.969], lowerTunnel: [-662.5, 1425, -111.969],
  bSite: [-1875, 2112.5, 0.162], bDoors: [-875, 2212.5, -81.035],
  bWindow: [-1375, 2700, 127.531], ctSpawn: [225, 2437.5, -119.969],
  topMid: [-387.5, 437.5, 0.031], mid: [-350, 1175, -97.425],
  midDoors: [-662.5, 2225, -117.806], catwalk: [162.5, 1437.5, 0.031],
  shortStairs: [337.5, 1462.5, -0.624], short: [287.5, 2125, 96.031],
  extendedA: [412.5, 2287.5, 96.031], aSite: [1150, 2937.5, 125.590],
  underA: [675, 2175, -77.721], aRamp: [1475, 2387.5, 18.199],
  longA: [1525, 1962.5, -10.849], longDoors: [1100, 487.5, 7.25],
  outsideLong: [487.5, -250, 1.794], pit: [1512.5, 262.5, -188.191],
  pitSide: [1687.5, 425, 56.078],
};
const points = Object.fromEntries(Object.entries(references).map(([name, source]) => [name, sourcePoint(name, source)]));
for (const [name, point] of Object.entries(points)) {
  assert.ok(seen.has(key(point)) && defendersSeen.has(key(point)), `${name} connects to both teams through body-sized passages`);
}
assert.ok(points.upperTunnel.y - points.lowerTunnel.y >= 3, 'upper and lower tunnels retain their separate floors');
assert.ok(points.aSite.y - points.ctSpawn.y >= 5, 'A remains above CT spawn');
assert.ok(points.longA.y - points.pit.y >= 4, 'Pit descends below Long A');
assert.ok(points.short.y - points.catwalk.y >= 2, 'Short stairs rise after the level Catwalk');
assert.ok(points.tSpawn.y > points.topMid.y, 'the T spawn ramp descends toward top mid');
assert.ok(points.topMid.y > points.midDoors.y, 'mid descends toward its double doors');

// An actual stacked column proves CT runs under the Short/A bridge. Testing
// only a max-height map would accidentally replace the covered lower route.
const underBridge = { x: 75.5, y: 12, z: 21.5 };
const onBridge = { x: 75.5, y: 17, z: 21.5 };
assert.ok(walkable(underBridge) && walkable(onBridge), 'CT and the A approach both stand at the same horizontal position');
assert.ok(seen.has(key(underBridge)) && seen.has(key(onBridge)), 'both stacked levels have a usable route');
assert.ok(solidAt(75, 16, 21), 'a solid bridge separates the two playable levels');

const inRegion = ([minX, maxX, minZ, maxZ, minY, maxY]) => point =>
  point.x >= minX && point.x < maxX + 1 && point.z >= minZ && point.z < maxZ + 1
  && point.y >= minY && point.y <= maxY;
const closePortal = ([minX, maxX, minZ, maxZ, minY, maxY]) => (x, y, z) =>
  (x >= minX && x <= maxX && z >= minZ && z <= maxZ && y >= minY && y <= maxY)
  || solidAt(x, y, z);
const at = (x, y, z) => ({ x: x + 0.5, y, z: z + 0.5 });
// Local bounds exclude alternative lanes, so a global detour cannot hide a
// blocked tunnel, staircase or door. The corridor sizes follow the reference.
const crossings = [
  { name: 'Mid Doors', from: points.topMid, to: points.midDoors,
    region: [54, 66, 20, 61, 11, 16], portal: [54, 66, 33, 34, 11, 20] },
  { name: 'B tunnel exit', from: points.upperTunnel, to: points.bSite,
    region: [22, 40, 23, 46, 14, 18], portal: [22, 40, 31, 32, 14, 22] },
  { name: 'B Doors', from: points.bDoors, to: points.bSite,
    region: [27, 53, 19, 27, 11, 18], portal: [40, 41, 19, 27, 11, 22] },
  { name: 'Catwalk and Short stairs', from: points.catwalk, to: points.short,
    region: [65, 81, 23, 40, 14, 18], portal: [65, 81, 32, 33, 14, 22] },
  { name: 'Long double-door passage', from: points.outsideLong, to: at(99, 15, 49),
    region: [73, 106, 48, 79, 14, 17], portal: [73, 106, 62, 63, 14, 22] },
  { name: 'Upper-to-lower tunnel stairs', from: at(34, 16, 45), to: points.lowerTunnel,
    region: [33, 57, 36, 48, 12, 17] },
  { name: 'B window', from: at(35, 15, 13), to: at(45, 16, 14),
    region: [34, 49, 9, 18, 14, 18] },
];
for (const crossing of crossings) {
  const within = inRegion(crossing.region);
  assert.ok(reachableFrom(crossing.from, { within }).has(key(crossing.to)), `${crossing.name} works without another lane`);
  assert.ok(reachableFrom(crossing.to, { within }).has(key(crossing.from)), `${crossing.name} works in both directions`);
  if (crossing.portal) {
    assert.equal(reachableFrom(crossing.from, { within, collision: closePortal(crossing.portal) }).has(key(crossing.to)), false,
      `${crossing.name} crosses its intended opening`);
  }
}

assert.deepEqual(new Set(world.meta.sites.map(site => site.id)), new Set(['A', 'B']));
for (const site of world.meta.sites) {
  const plantCells = [];
  for (let x = Math.floor(site.minX); x <= Math.floor(site.maxX); x++) {
    for (let z = Math.floor(site.minZ); z <= Math.floor(site.maxZ); z++) {
      const point = at(x, Math.floor(site.y), z);
      if (point.x < site.minX || point.x > site.maxX || point.z < site.minZ || point.z > site.maxZ) continue;
      if (walkable(point)) plantCells.push(point);
    }
  }
  assert.ok(plantCells.length >= 6, `site ${site.id} offers several standing planting positions around its cover`);
  assert.ok(plantCells.every(point => seen.has(key(point)) && defendersSeen.has(key(point))),
    `both sides reach the clear planting cells on site ${site.id}`);
}
const powerups = findPowerupSites(world);
assert.equal(powerups.length, 4, 'four exposed powerup pads pass the live eligibility checks');
for (const point of powerups) {
  assert.ok(isPowerupSiteSupported(world, point) && walkable(point), 'powerup pad supports a standing player');
  assert.ok(seen.has(key(point)) && defendersSeen.has(key(point)), 'both teams can reach every powerup');
}

const selector = new GameEngine({ world }).spawnSelector;
for (const pool of pools) {
  const expanded = selector.expand(pool);
  assert.ok(expanded.length > pool.length, 'spawn expansion provides additional valid positions');
  for (const point of expanded) {
    assert.ok(inside(point) && navKeys.has(key(point)) && walkable(point) && seen.has(key(point)),
      `expanded spawn stays on an accessible original floor: ${key(point)}`);
  }
  const selected = new Set();
  for (let i = 0; i < 40; i++) {
    selector.setNow(i * 100);
    const point = selector.pick(expanded, null, -1, { variety: true });
    assert.ok(inside(point) && navKeys.has(key(point)) && walkable(point) && seen.has(key(point)));
    selected.add(key(point));
  }
  assert.ok(selected.size > 1, 'repeated respawns use more than one valid location');
}
for (const point of navPositions) {
  if (selector.walkable(point)) assert.ok(seen.has(key(point)), `allowed recovery floor has an exit: ${key(point)}`);
}
let rejectedDecorativeSurface = false;
for (let x = 3; x < SX - 3 && !rejectedDecorativeSurface; x++) {
  for (let z = 3; z < SZ - 3 && !rejectedDecorativeSurface; z++) {
    for (let y = bounds.minY; y <= bounds.maxY; y++) {
      const point = at(x, y, z);
      if (inside(point) && walkable(point) && !navKeys.has(key(point))) {
        assert.equal(selector.walkable(point), false, 'decorative roofs and ledges cannot become recovery spawns');
        rejectedDecorativeSurface = true;
        break;
      }
    }
  }
}
assert.ok(rejectedDecorativeSurface, 'the regression exercises a real decorative standing surface');
const outside = { x: bounds.minX - 3, y: bounds.minY, z: bounds.minZ + 6 };
assert.equal(selector.walkable(outside), false, 'outside positions cannot become fallback spawns');
for (const pool of [[], [outside]]) {
  const point = selector.pick(pool);
  assert.ok(inside(point) && navKeys.has(key(point)) && walkable(point) && seen.has(key(point)),
    'empty and outside pools recover on connected original floors');
}
const damaged = createMapState('dust2');
for (const point of pools.flat()) damaged.setBlock(Math.floor(point.x), Math.floor(point.y) - 1, Math.floor(point.z), AIR);
const damagedSelector = new GameEngine({ world: damaged }).spawnSelector;
assert.ok(pools.flat().every(point => !damagedSelector.walkable(point)), 'destruction removes authored spawn support');
for (const pool of pools) {
  const point = damagedSelector.pick(pool);
  assert.ok(inside(point) && navKeys.has(key(point)) && damagedSelector.walkable(point) && seen.has(key(point)),
    'destroyed spawn pools recover on surviving original floors with a route');
}
console.log(`Dust 2: ${Object.keys(points).length} measured landmarks, ${crossings.length} local corridors, stacked floors, plant sites, four powerups and ${seen.size} connected standing cells verified.`);
console.log('Dust 2: deterministic generation, materials, wire round trips and safe respawn recovery verified.');
