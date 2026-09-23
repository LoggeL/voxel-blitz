// Headless contracts for BIKINI BOTTOM (docs: map-spec §13). The core owns
// the reef wall, seafloor, roads, lanes and spawn strips; five region builders
// fill the houses, the two sites, the school and the south quarter. While a
// region is still a stub its region-specific checks are skipped with a log
// line, but spawns, power-ups, walkability and registration always run.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import {
  createMapState, getMapMeta, AIR, BEDROCK, GLASS, GROUND, MC_WATER, FLUID_BLOCKS, isSolidBlock,
  SLIDE_BLUE, SLIDE_YELLOW, PALE, METAL, STONE, BB_SAND, BB_ROAD, BB_ROCK, BB_CORAL, BB_KELP, BB_HULL, BB_MOAI,
} from '../shared/worlddata.js';
import { BLOCK_HP, BLOCK_HARDNESS, MINING_HITS, GRENADE_RESISTANCE } from '../shared/world/blocks.js';
import { BIKINI_BOTTOM_FLUME, BIKINI_BOTTOM_POWERUPS } from '../shared/world/bikini-bottom-data.js';
import { DEFAULT_BLOCK_TILES, TILE_PAINTERS } from '../public/js/engine/atlas.js';
import { findPowerupSites } from '../shared/powerup-sites.js';
import { isModeMapCompatible } from '../shared/modes.js';
import { lobbyCapacity } from '../shared/lobby-limits.js';
import { deserializeWorld } from '../shared/worlddata.js';
import { SLIDE_RULES } from '../shared/slide-rules.js';
import { PlayerPhysics } from '../public/js/player-physics.js';

const MAP = 'bikini_bottom';
const T = GROUND;
const world = createMapState(MAP);
const meta = getMapMeta(MAP);
const { sx: SX, sy: SY, sz: SZ } = world.dimensions;
const at = (x, y, z) => world.getBlock(x, y, z);
const P = (x, z) => [127 - x, 95 - z];
const skipped = [];
const skip = (what, region) => { skipped.push(`${what} (${region} still a stub)`); };

// ---- 0. Registration.
assert.deepEqual([SX, SY, SZ], [128, 40, 96], 'default 128 x 40 x 96 grid');
for (const mode of ['fun', 'ttt', 'duel', 'chaos', 'tdm', 'snd', 'gungame']) {
  assert.ok(isModeMapCompatible(mode, MAP), `${mode} runs on Bikini Bottom`);
}
assert.equal(isModeMapCompatible('bastion', MAP), false);
assert.equal(lobbyCapacity('fun', MAP), 12);
assert.equal(meta.name, 'Bikini Bottom');
assert.deepEqual([meta.spawns.fun.length, meta.spawns.tdm.alpha.length, meta.spawns.tdm.bravo.length,
  meta.spawns.snd.attackers.length, meta.spawns.snd.defenders.length], [12, 6, 6, 6, 6], 'spawn pool sizes');
assert.equal(meta.navigationFloor, undefined, 'legacy roaming bots, no ground graph');
assert.deepEqual(meta.standHeights, [T - 1, T + 3], 'bots roam at most three voxels above the seafloor');
assert.equal(meta.sites.length, 2);

// Regions are "built" once their builder writes anything above the seafloor.
const REGIONS = {
  R1: [15, 112, 14, 27], R2: [15, 49, 34, 61], R3: [50, 77, 34, 61], R4: [78, 112, 34, 61], R5: [15, 112, 68, 81],
};
const regionOf = (x, z) => Object.keys(REGIONS).find((id) => {
  const [x0, x1, z0, z1] = REGIONS[id];
  return x >= x0 && x <= x1 && z >= z0 && z <= z1;
}) ?? 'CORE';
// R3 alone may write above y14 in the flume corridor rows outside its rectangle.
const flume = (x, z) => (z >= 57 && z <= 61 && x >= 51 && x <= 58) || (z >= 62 && z <= 67 && x >= 47 && x <= 56)
  || (z >= 68 && z <= 77 && x >= 43 && x <= 52);
const built = {};
for (const [id, [x0, x1, z0, z1]] of Object.entries(REGIONS)) {
  built[id] = false;
  for (let x = x0; x <= x1 && !built[id]; x++) for (let z = z0; z <= z1 && !built[id]; z++) {
    if (id !== 'R3' && flume(x, z)) continue;
    for (let y = T + 1; y < SY; y++) if (at(x, y, z) !== AIR) { built[id] = true; break; }
  }
}
built.CORE = true;
console.log(`Bikini Bottom regions built: ${Object.entries(built).filter(([, b]) => b).map(([id]) => id).join(', ')}`);

// ---- 1. Round trip and block registration.
const bytes = world.serializeWorld();
assert.deepEqual(createMapState(MAP, bytes).serializeWorld(), bytes, 'serialization round-trips');
const used = new Set(bytes.subarray(6));
for (const type of [BB_SAND, BB_ROAD, BB_ROCK, BB_CORAL, BB_KELP, BB_HULL, PALE]) assert.ok(used.has(type), `core uses block ${type}`);
for (const type of used) {
  assert.ok(DEFAULT_BLOCK_TILES[type], `texture for ${type}`);
  for (const tile of Object.values(DEFAULT_BLOCK_TILES[type])) {
    assert.ok(TILE_PAINTERS[tile], `painter for tile ${tile}`);
    assert.deepEqual(TILE_PAINTERS[tile](5, 9), TILE_PAINTERS[tile](5, 9), 'painters are pure');
  }
  if (type === AIR) continue;
  assert.ok(GRENADE_RESISTANCE[type] > 0, `blast resistance for ${type}`);
  assert.ok(BLOCK_HARDNESS[type] >= 0, `hardness for ${type}`);
  if (type === BEDROCK || FLUID_BLOCKS.has(type)) continue;
  assert.ok(MINING_HITS[type] > 0, `mining for ${type}`);
  assert.ok(BLOCK_HP[type] > 0, `hp for ${type}`);
}

// ---- Core geometry: reef wall, seafloor paint, sculptures and spawn cover.
assert.equal(at(2, T + 1, 40), PALE, 'reef wall starts with a sand line');
assert.ok([BB_ROCK, BB_CORAL, BB_KELP, BB_MOAI].includes(at(2, T + 5, 40)), 'reef wall dresses the inner shell face');
assert.equal(at(1, T + 5, 40), METAL, 'the outer METAL shell is untouched');
// Coral and stone lie in patches, not ruler-straight bands: no rise row of a
// wall face is mostly coral, yet each face carries some coral and stone.
for (const [name, cell] of [['north', (i) => [i, 2]], ['west', (i) => [2, i]]]) {
  const length = name === 'north' ? SX - 4 : SZ - 6;
  const totals = new Map();
  for (let rise = 3; rise <= 16; rise++) {
    const row = Array.from({ length }, (_, i) => { const [x, z] = cell(i + (name === 'north' ? 2 : 3)); return at(x, T + rise, z); });
    const coral = row.filter((b) => b === BB_CORAL).length;
    assert.ok(coral < length * 0.6, `${name} reef rise ${rise} is not a coral band (${coral}/${length})`);
    for (const b of row) totals.set(b, (totals.get(b) ?? 0) + 1);
  }
  assert.ok(totals.get(BB_CORAL) > 0 && totals.get(BB_MOAI) > 0 && totals.get(BB_ROCK) > length * 14 * 0.5,
    `${name} reef face is mostly rock with coral and stone patches`);
}
// The client remaps METAL to reef rock on this map; only the shell may hold it.
for (let x = 0; x < SX; x++) for (let z = 0; z < SZ; z++) {
  if (Math.min(x, z, SX - 1 - x, SZ - 1 - z) < 3) continue;
  for (let y = 0; y < SY; y++) assert.notEqual(at(x, y, z), METAL, `no authored METAL inside the reef (${x},${y},${z})`);
}
for (const [x, z] of [[70, 29], [70, 66]]) {
  assert.ok([BB_ROAD, PALE, STONE].includes(at(x, T, z)), `road paint at ${x},${z}`);
}
// Conch sculptures on the road centres: nothing there is a low roam target.
const inShell = (x, z) => (x >= 60 && x <= 62 && z >= 28 && z <= 31) || (x >= 65 && x <= 67 && z >= 30 && z <= 33)
  || (x >= 65 && x <= 67 && z >= 64 && z <= 67) || (x >= 60 && x <= 62 && z >= 62 && z <= 65);
for (let x = 60; x <= 67; x++) for (let z = 28; z <= 67; z++) {
  if (inShell(x, z)) assert.ok(world.heightAt(x, z) >= T + 4, `conch column ${x},${z} tops out at T+4 or higher`);
}

// ---- Spawns: open sky, nothing solid above the floor within Chebyshev 2.
const anchorsFor = (pool) => pool.map((p) => [Math.floor(p.x), Math.floor(p.z)]);
const allSpawns = [...meta.spawns.fun, ...meta.spawns.tdm.alpha, ...meta.spawns.tdm.bravo,
  ...meta.spawns.snd.attackers, ...meta.spawns.snd.defenders];
for (const spawn of allSpawns) {
  const x = Math.floor(spawn.x), z = Math.floor(spawn.z);
  assert.equal(Math.floor(spawn.y), T + 1, `spawn ${x},${z} stands on the seafloor`);
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    for (let y = T + 1; y < SY; y++) {
      assert.equal(isSolidBlock(at(x + dx, y, z + dz)), false, `spawn ${x},${z} keeps ${x + dx},${y},${z + dz} clear`);
    }
  }
}
const funCells = new Set(anchorsFor(meta.spawns.fun).map(([x, z]) => `${x},${z}`));
for (const [x, z] of anchorsFor(meta.spawns.fun)) assert.ok(funCells.has(P(x, z).join(',')), `fun spawn ${x},${z} has a point twin`);
assert.deepEqual(anchorsFor(meta.spawns.tdm.alpha).map(([x, z]) => P(x, z).join(',')).sort(),
  anchorsFor(meta.spawns.tdm.bravo).map(([x, z]) => `${x},${z}`).sort(), 'TDM rows are point twins');

// ---- 2/3. Walkability: 1-voxel steps with head clearance, any drop, swimming.
const passable = (x, y, z) => !isSolidBlock(at(x, y, z));
const free = (x, y, z) => passable(x, y, z) && passable(x, y + 1, z);
const stand = (x, y, z) => y >= 1 && y < SY - 2 && free(x, y, z)
  && (isSolidBlock(at(x, y - 1, z)) || FLUID_BLOCKS.has(at(x, y - 1, z)) || FLUID_BLOCKS.has(at(x, y, z)));
const key = (x, y, z) => `${x},${y},${z}`;
const [origin] = meta.spawns.fun;
const queue = [[Math.floor(origin.x), Math.floor(origin.y), Math.floor(origin.z)]];
const seen = new Set([key(...queue[0])]);
const push = (X, Y, Z) => { const k = key(X, Y, Z); if (!seen.has(k)) { seen.add(k); queue.push([X, Y, Z]); } };
for (let i = 0; i < queue.length; i++) {
  const [x, y, z] = queue[i];
  const wet = FLUID_BLOCKS.has(at(x, y, z));
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]]) for (const dy of [0, 1, -1]) {
    if (dx === 0 && dz === 0 && (dy === 0 || !wet)) continue;
    const X = x + dx, Y = y + dy, Z = z + dz;
    if (X < 1 || X > SX - 2 || Z < 1 || Z > SZ - 2 || seen.has(key(X, Y, Z)) || !stand(X, Y, Z)) continue;
    if (dy === 1 && !free(x, y + 1, z)) continue;
    push(X, Y, Z);
  }
  // Walking off a ledge drops to the first floor below.
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const X = x + dx, Z = z + dz;
    if (X < 1 || X > SX - 2 || Z < 1 || Z > SZ - 2 || !free(X, y, Z)) continue;
    let Y = y;
    while (Y > 1 && !isSolidBlock(at(X, Y - 1, Z)) && !FLUID_BLOCKS.has(at(X, Y - 1, Z)) && !FLUID_BLOCKS.has(at(X, Y, Z))) Y--;
    if (Y < y - 1 && stand(X, Y, Z)) push(X, Y, Z);
  }
}
for (const spawn of allSpawns) {
  assert.ok(seen.has(key(Math.floor(spawn.x), Math.floor(spawn.y), Math.floor(spawn.z))), `spawn ${spawn.x},${spawn.z} connects`);
}
// Every bot roam column (heightAt within standHeights, dry top, 2 air above) is reachable.
const unreachable = [];
for (let x = 3; x < SX - 3; x++) for (let z = 3; z < SZ - 3; z++) {
  const h = world.heightAt(x, z);
  if (h < meta.standHeights[0] || h > meta.standHeights[1]) continue;
  if (FLUID_BLOCKS.has(at(x, h, z)) || at(x, h + 1, z) !== AIR || at(x, h + 2, z) !== AIR) continue;
  if (!seen.has(key(x, h + 1, z))) unreachable.push(`${x},${h},${z}`);
}
assert.deepEqual(unreachable, [], 'every bot roam column is reachable on foot');
for (const landmark of meta.landmarks) {
  const cell = key(landmark.x, Math.floor(landmark.y), landmark.z);
  const region = regionOf(landmark.x, landmark.z);
  if (!built[region] && !seen.has(cell)) { skip(`landmark ${landmark.id}`, region); continue; }
  assert.ok(free(landmark.x, Math.floor(landmark.y), landmark.z), `landmark ${landmark.id} keeps 2 air above its floor`);
  assert.ok(seen.has(cell), `landmark ${landmark.id} is reachable`);
}
const siteRegion = { A: 'R2', B: 'R4' };
for (const site of meta.sites) {
  const fy = Math.floor(site.y);
  let plantable = 0;
  for (let x = site.minX; x <= site.maxX; x++) for (let z = site.minZ; z <= site.maxZ; z++) {
    if (!isSolidBlock(at(x, fy - 1, z)) || !free(x, fy, z)) continue;
    plantable++;
    assert.ok(seen.has(key(x, fy, z)), `site ${site.id} cell ${x},${z} is reachable`);
  }
  if (!built[siteRegion[site.id]]) { skip(`site ${site.id} plantable area`, siteRegion[site.id]); continue; }
  assert.ok(plantable >= 100, `site ${site.id} keeps most of its floor plantable (${plantable}/144)`);
}

// ---- 4. Portals: three doorways into each site.
function portals(ring, y0, y1) {
  const door = new Set(ring.filter(([x, z]) => {
    for (let y = y0; y <= y1; y++) if (at(x, y, z) !== AIR) return false;
    return true;
  }).map(([x, z]) => `${x},${z}`));
  let count = 0;
  const done = new Set();
  for (const cell of door) {
    if (done.has(cell)) continue;
    count++;
    const stack = [cell]; done.add(cell);
    while (stack.length) {
      const [x, z] = stack.pop().split(',').map(Number);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const next = `${x + dx},${z + dz}`;
        if (door.has(next) && !done.has(next)) { done.add(next); stack.push(next); }
      }
    }
  }
  return count;
}
if (built.R2) {
  const ring = [];
  for (let x = 15; x <= 36; x++) for (let z = 37; z <= 58; z++) if (x === 15 || x === 36 || z === 37 || z === 58) ring.push([x, z]);
  assert.equal(portals(ring, T + 1, T + 3), 3, 'Krusty Krab: front door, back door and drive-thru');
} else skip('site A portals', 'R2');
if (built.R4) {
  const ring = [];
  for (let x = 90; x <= 113; x++) for (let z = 36; z <= 59; z++) {
    const d = Math.hypot(x - 101.5, z - 47.5);
    if (d >= 9 && d < 10) ring.push([x, z]);
  }
  assert.equal(portals(ring, T + 4, T + 6), 3, 'Chum Bucket ring: west, south and gatehouse doors');
} else skip('site B portals', 'R4');

// ---- 4b. Chum Lab periscope (map-spec §7.5): a peek hole, never a route. The
// GLASS tile dies to one bullet; the raised collar keeps the landing cells a
// 4-voxel rise above the lab floor, so a jump plus an airborne vault grab
// (reach 2.05 from the apex) cannot pull a body onto the site-B deck.
if (built.R4) {
  assert.equal(at(105, T + 3, 52), GLASS, 'periscope pane in the site-B floor');
  for (let x = 104; x <= 106; x++) for (let z = 51; z <= 53; z++) {
    if (x === 105 && z === 52) continue;
    assert.ok(isSolidBlock(at(x, T + 4, z)), `periscope collar ${x},${z} rises to T+4`);
  }
  const shotOut = createMapState(MAP);
  shotOut.setBlock(105, T + 3, 52, AIR);
  const arena = new GameEngine({ world: shotOut, mapMeta: meta });
  arena.addClient('climber', 'Climber');
  const body = arena.entities.get('climber');
  for (const [yaw, dir] of [[-Math.PI / 2, 'east'], [Math.PI / 2, 'west'], [0, 'north'], [Math.PI, 'south']]) {
    Object.assign(body, { x: 105.5, y: T + 1, z: 52.5, vx: 0, vy: 0, vz: 0, grounded: true, vault: null, state: 'alive', hp: 100 });
    let maxY = body.y;
    for (let tick = 0; tick < 120; tick++) {
      const keys = { f: tick >= 10, jump: tick === 0 || tick === 12 || tick === 13 };
      arena.applyInput('climber', { keys, yaw, pitch: 0, viewYaw: yaw });
      arena.step(arena.intervalMs);
      maxY = Math.max(maxY, body.y);
    }
    assert.ok(maxY < T + 4, `periscope: a lab jump-grab facing ${dir} never reaches the deck (max y ${maxY.toFixed(2)})`);
  }
  arena.stop?.();
} else skip('Chum Lab periscope', 'R4');

// ---- 5. Water: only the Goo Lagoon ellipse, two deep, flush with the seafloor.
const inLagoon = (x, z) => ((x - 39) / 5) ** 2 + ((z - 75) / 4) ** 2 <= 1;
const wetColumns = new Set();
for (let x = 0; x < SX; x++) for (let z = 0; z < SZ; z++) for (let y = 0; y < SY; y++) {
  if (at(x, y, z) !== MC_WATER) continue;
  assert.ok(inLagoon(x, z) && (y === T - 1 || y === T), `water only in the lagoon at y13-14 (${x},${y},${z})`);
  wetColumns.add(`${x},${z}`);
}
if (built.R5) assert.equal(wetColumns.size, 63, 'Goo Lagoon holds 63 water columns');
else skip('Goo Lagoon water count', 'R5');
for (const spawn of allSpawns) {
  const x = Math.floor(spawn.x), z = Math.floor(spawn.z);
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    assert.equal(wetColumns.has(`${x + dx},${z + dz}`), false, `spawn ${x},${z} is dry`);
  }
}

// ---- 6. Flume: one slide, trough out of bot roam, deck launch, lagoon landing.
assert.equal(meta.slides.length, 1);
assert.deepEqual(meta.slides[0], JSON.parse(JSON.stringify(BIKINI_BOTTOM_FLUME)), 'meta carries the flume path');
let trough = 0;
for (let x = 0; x < SX; x++) for (let z = 0; z < SZ; z++) for (let y = 0; y < SY; y++) {
  const b = at(x, y, z);
  if (b !== SLIDE_YELLOW && b !== SLIDE_BLUE) continue;
  trough++;
  assert.ok(y >= 18, `flume voxel ${x},${y},${z} stays above bot roam`);
}
if (built.R3) {
  const [first] = BIKINI_BOTTOM_FLUME.path;
  const fx = Math.floor(first[0]), fz = Math.floor(first[2]);
  assert.ok(trough > 0, 'the flume trough is built');
  assert.ok(isSolidBlock(at(fx, 18, fz)) && at(fx, 19, fz) === AIR && at(fx, 20, fz) === AIR, 'the flume launches from the school deck');
} else skip('flume deck launch', 'R3');
if (built.R5) {
  let splash = false;
  for (let dx = 0; dx <= 5 && !splash; dx++) for (let dz = -1; dz <= 1; dz++) {
    if (at(Math.floor(44.5 - dx), T, Math.floor(75.5 + dz)) === MC_WATER) splash = true;
  }
  assert.ok(splash, 'the flume lip ends within 5 voxels of Goo Lagoon');
} else skip('flume lagoon landing', 'R5');
// The ride on meta.slides: a body that walks off the deck into the mouth rides
// every segment prone on the authority and in prediction (which agree), its
// feet stay above the flat y18 trough floor (the bore never holds a solid
// voxel), the lip kicker ends the ride airborne past the trough, and the
// rider carries its speed off the lip into the lagoon (or the beach sand).
if (built.R3) {
  deserializeWorld(bytes);
  const arena = new GameEngine({ world: createMapState(MAP), mapMeta: meta });
  arena.addClient('rider', 'Rider');
  const body = arena.entities.get('rider');
  Object.assign(body, { x: 56.5, y: T + 5.02, z: 54.2, vx: 0, vy: 0, vz: 0, grounded: true });
  const client = new PlayerPhysics(meta);
  client.pos = { x: body.x, y: body.y, z: body.z };
  client.vel = { x: 0, y: 0, z: 0 };
  client.grounded = true;
  const yaw = Math.PI;                       // facing +z, toward the mouth
  let riding = 0, maxIndex = -1, prone = false, stall = 0, last = null, rideEnd = null;
  for (let tick = 0; tick < 60 * 10; tick++) {
    const walk = !riding;                    // walk in, then let go of the keys
    arena.applyInput('rider', { keys: walk ? { f: true } : {}, yaw, pitch: 0, viewYaw: yaw });
    arena.step(arena.intervalMs);
    client.step(1 / 60, walk ? { x: 0, z: 1 } : { x: 0, z: 0 }, 4.4, false, 0, yaw);
    if (riding && !rideEnd) {
      for (const axis of ['x', 'y', 'z']) {
        assert.ok(Math.abs(client.pos[axis] - body[axis]) < 1e-6, `flume: prediction matches the authority on ${axis} at tick ${tick}`);
      }
    }
    if (body.slide) {
      riding++;
      maxIndex = Math.max(maxIndex, body.slide.index);
      if (body.proneT >= 1) prone = true;
      assert.equal(client.slide?.index, body.slide.index, `flume: prediction rides the same segment at tick ${tick}`);
      for (const lift of [0.05, 0.3, 0.7]) {
        assert.ok(!isSolidBlock(at(Math.floor(body.x), Math.floor(body.y + lift), Math.floor(body.z))), `flume: the rider stays above the trough floor at tick ${tick}`);
      }
      if (last && Math.hypot(body.x - last[0], body.z - last[2]) < 0.01) stall++;
    } else if (riding && !rideEnd) {
      rideEnd = { tick, x: body.x, y: body.y, z: body.z, speed: Math.hypot(body.vx, body.vz), grounded: body.grounded };
    }
    last = [body.x, body.y, body.z];
    if (rideEnd && tick > rideEnd.tick + 90) break;
  }
  assert.ok(riding > 60 * 1.5 && riding < 60 * 5, `flume: the ride lasts a few seconds (${riding} ticks)`);
  assert.equal(maxIndex, BIKINI_BOTTOM_FLUME.path.length - 2, 'flume: the rider passes every segment');
  assert.ok(prone, 'flume: the rider lies down on the slide');
  assert.ok(stall < 3, 'flume: the rider never stalls');
  assert.ok(rideEnd && !rideEnd.grounded && rideEnd.speed > 6, 'flume: the kicker ends the ride airborne at speed');
  assert.ok(body.x < 44 && body.y < T + 1.5 && body.state === 'alive', `flume: the rider lands off the lip (${body.x.toFixed(2)}, ${body.y.toFixed(2)}, ${body.z.toFixed(2)})`);
  if (built.R5) assert.ok(body.swimming, 'flume: splash-down in Goo Lagoon');
  console.log(`Bikini Bottom: flume ride ${(riding / 60).toFixed(1)} s, lands at ${body.x.toFixed(1)}, ${body.z.toFixed(1)}${body.swimming ? ' in the lagoon' : ''}.`);
} else skip('flume ride', 'R3');

// ---- 7. Power-ups: every pad survives on the pristine map.
const sites = findPowerupSites(world, meta);
const expectedPads = BIKINI_BOTTOM_POWERUPS.filter(([x, , z]) => built[regionOf(x, z)]);
if (expectedPads.length < BIKINI_BOTTOM_POWERUPS.length) skip('school-deck power-ups', 'R3');
for (const [x, y, z] of expectedPads) {
  assert.ok(sites.some((s) => s.x === x + 0.5 && s.z === z + 0.5 && s.y === y + 1.02), `power-up pad ${x},${y},${z} survives`);
}
assert.ok(sites.length >= 3, 'at least three power-up sites');

// ---- 8. Sightlines.
if (Object.values(built).every(Boolean)) {
  const runs = [];
  const open = (x, z) => at(x, 16, z) === AIR && at(x, 15, z) === AIR;
  for (let z = 14; z <= 81; z++) for (let x = 3, run = 0; x <= 124; x++) { run = open(x, z) ? run + 1 : 0; if (run > 60) runs.push(`z${z}`); }
  for (let x = 3; x <= 124; x++) for (let z = 14, run = 0; z <= 81; z++) { run = open(x, z) ? run + 1 : 0; if (run > 60) runs.push(`x${x}`); }
  assert.deepEqual([...new Set(runs)], [], 'no chest-height axis line longer than 60 through the town');
} else skip('axis sightlines', 'a region');
if (built.R2 && built.R3 && built.R4) {
  // Glass is see-through, so only opaque voxels break the A-to-B line.
  const blocks = (x, y, z) => isSolidBlock(at(x, y, z)) && at(x, y, z) !== GLASS;
  const [a, b] = meta.sites;
  let lines = 0;
  for (let ax = a.minX; ax <= a.maxX; ax++) for (let az = a.minZ; az <= a.maxZ; az++) {
    for (let bx = b.minX; bx <= b.maxX; bx++) for (let bz = b.minZ; bz <= b.maxZ; bz++) {
      const dx = bx - ax, dz = bz - az, steps = Math.ceil(Math.hypot(dx, dz) * 4);
      let clear = true;
      for (let s = 0; s <= steps && clear; s++) {
        const t = s / steps;
        if (blocks(Math.floor(ax + 0.5 + dx * t), 16, Math.floor(az + 0.5 + dz * t))) clear = false;
      }
      if (clear) lines++;
    }
  }
  assert.equal(lines, 0, 'no open y16.6 line between site A and site B');
} else skip('A-to-B sightline', 'R2/R3/R4');

// ---- 9. Symmetry: outer lanes and roads (core) are point-symmetric; the lots are soft.
// Conch footprints are twins but their spires lean the same way, so they compare up to T+4.
const top = (x, z) => {
  for (let y = 30; y > 0; y--) if (at(x, y, z) !== AIR) return inShell(x, z) ? Math.min(y, T + 4) : y;
  return 0;
};
const mismatches = [];
for (let x = 3; x <= 124; x++) for (let z = 3; z <= 92; z++) {
  const lane = x <= 14 || x >= 113, road = (z >= 28 && z <= 33) || (z >= 62 && z <= 67);
  if (!lane && !road) continue;
  const [px, pz] = P(x, z);
  if (flume(x, z) || flume(px, pz)) continue;
  if (top(x, z) !== top(px, pz)) mismatches.push(`${x},${z}`);
}
assert.deepEqual(mismatches, [], 'outer lanes and roads are point-symmetric');
if (built.R2 && built.R4) {
  let soft = 0;
  for (let x = 37; x <= 49; x++) for (let z = 34; z <= 61; z++) if (top(x, z) !== top(...P(x, z))) soft++;
  console.log(`Bikini Bottom: lot symmetry (soft) ${soft} of ${13 * 28} A-lot columns differ from their B-lot twins.`);
}
console.log(`Bikini Bottom: registration, materials, ${seen.size} connected standing cells, spawns, water, flume, power-ups and lanes verified.`);

// ---- Server selector: procedural expansion stays inside spawnBounds and on the map.
const engine = new GameEngine({ world });
const selector = engine.spawnSelector;
const bounds = meta.spawnBounds;
const inside = (p) => p.x >= bounds.minX && p.x <= bounds.maxX + 1 && p.z >= bounds.minZ && p.z <= bounds.maxZ + 1
  && p.y >= bounds.minY && p.y <= bounds.maxY;
for (const pool of [meta.spawns.fun, meta.spawns.tdm.alpha, meta.spawns.tdm.bravo, meta.spawns.snd.attackers, meta.spawns.snd.defenders]) {
  const expanded = selector.expand(pool);
  assert.ok(expanded.length > pool.length, 'spawn variety remains available');
  for (const point of expanded) {
    assert.ok(inside(point), `expanded spawn stays inside spawnBounds: ${JSON.stringify(point)}`);
    assert.ok(seen.has(key(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z))), `expanded spawn connects: ${JSON.stringify(point)}`);
    assert.equal(wetColumns.has(`${Math.floor(point.x)},${Math.floor(point.z)}`), false, 'expanded spawn is dry');
  }
  for (let i = 0; i < 40; i++) {
    selector.setNow(i * 100);
    assert.ok(inside(selector.pick(expanded, null, -1, { variety: true })));
  }
}
assert.ok(inside(selector.pick([])), 'destroyed spawn pools recover inside the reef');
engine.stop?.();
for (const line of skipped) console.log(`Bikini Bottom: skipped ${line}.`);
console.log('Bikini Bottom: expanded, repeated and fallback server spawns stay inside the reef.');
