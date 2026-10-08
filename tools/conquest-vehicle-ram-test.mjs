// Conquest ground hulls: shoving wrecks and ramming through light voxels.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { VEHICLE_RAM, VEHICLE_MASS, RAM_RULES } from '../shared/vehicle-defs.js';
import { STONE, CONCRETE, PLANK, TIMBER, LEAVES, BRICK, WHITE_PLASTER, GLASS, BLOCK_HARDNESS } from '../shared/world/blocks.js';

const GROUND = STONE;
function fixture(spawns, { flags = [] } = {}) {
  const blocks = new Map(), dimensions = { sx: 512, sy: 64, sz: 512 };
  const key = (x, y, z) => `${x},${y},${z}`;
  const world = { dimensions, findSpawns: () => [{ x: 350, y: 1, z: 350 }],
    getBlock: (x, y, z) => y === 0 ? GROUND : blocks.get(key(x, y, z)) ?? 0,
    setBlock: (x, y, z, v) => { if (v) blocks.set(key(x, y, z), v); else blocks.delete(key(x, y, z)); } };
  const game = new GameEngine({ mode: 'conquest', world, mapMeta: { id: 'frontier', dimensions,
    spawns: { conquest: { alpha: [{ x: 350, y: 1, z: 350 }], bravo: [{ x: 400, y: 1, z: 350 }] } },
    conquest: { flags, bases: {}, vehicleSpawns: spawns.map(([id, type, x, z, yaw = 0]) => ({ id, type, team: 'alpha', x, y: 1, z, yaw })) } }, broadcast() {} });
  game.addClient('driver', 'driver');
  const driver = game.entities.get('driver');
  Object.assign(driver, { x: 350, y: 1, z: 350, hp: 100, armor: 0, spawnProtectedUntil: 0, input: { keys: {}, yaw: 0, pitch: 0 } });
  const vs = game.vehicles, hull = id => vs.vehicles.get(id);
  const board = id => { Object.assign(driver, { x: hull(id).x, y: 1, z: hull(id).z }); assert(vs.enter(driver, id)); };
  const drive = (throttle = 1) => { driver.input = { keys: {}, yaw: 0, pitch: 0, vehicleThrottle: throttle, vehicleSteer: 0 }; };
  const wreck = id => Object.assign(hull(id), { hp: 0, wreckAge: 0, respawnIn: 999, engineOn: false, speed: 0, vx: 0, vy: 0, vz: 0 });
  const set = (x, y, z, v) => world.setBlock(x, y, z, v);
  const tick = (n = 1) => { for (let i = 0; i < n; i++) vs.step(1 / 60); };
  return { game, vs, hull, board, drive, wreck, set, tick, blocks, world, driver };
}
const between = (n, lo, hi, message) => assert(n > lo && n < hi, `${message}: ${n.toFixed(3)} not in (${lo}, ${hi})`);

// 1. A tank shoves a jeep wreck ahead of it; the wreck slides on, settles and sleeps again.
{
  const f = fixture([['tank', 'tank', 200, 200], ['jeep', 'jeep', 200, 192]]);
  f.wreck('jeep');
  f.tick(5);
  const jeep = f.hull('jeep'), tank = f.hull('tank');
  assert.equal(jeep.wreckRestRevision, f.game.blockRevision, 'a resting wreck sleeps');
  f.board('tank'); f.drive(1); f.tick(240);
  const moved = 192 - jeep.z;
  between(moved, 6, 40, 'a tank shoves a jeep wreck several metres');
  assert(Math.abs(jeep.x - 200) < 0.05 && jeep.y === 1, 'the wreck stays on the ground along the push');
  assert(tank.speed > 6, `a 45 t tank barely slows for a 2.5 t wreck (speed ${tank.speed.toFixed(2)})`);
  assert(Math.hypot(jeep.vx, jeep.vz) <= 13 + 1e-9, 'the wreck is never faster than the pusher');
  f.drive(-1); f.tick(120); f.drive(0); f.tick(120);
  assert.equal(jeep.vx, 0); assert.equal(jeep.vz, 0);
  assert.equal(jeep.wreckRestRevision, f.game.blockRevision, 'the wreck sleeps again once it stops');
  assert(f.vs.clearHull(jeep, jeep.x, jeep.y, jeep.z), 'the wreck rests clear of terrain and hulls');
  assert.equal(f.vs.snapshot().find(row => row.id === 'jeep').z, Math.round(jeep.z * 100) / 100, 'the snapshot row carries the moved wreck pose');
}

// 2. A jeep cannot move a tank wreck; it is stopped (and hurt) as by a wall.
{
  const f = fixture([['jeep', 'jeep', 200, 200], ['tank', 'tank', 200, 190]]);
  f.wreck('tank'); f.board('jeep');
  const jeep = f.hull('jeep'), tank = f.hull('tank'), start = { x: tank.x, z: tank.z };
  jeep.speed = 14; f.drive(1); f.tick(120);
  assert.deepEqual({ x: tank.x, z: tank.z }, start, 'the tank wreck does not move');
  assert(jeep.z > 190 + 2.6 + 2.12 - 0.01 && jeep.speed < 1, 'the jeep stops at the tank wreck');
}

// 3. A jeep only nudges a jeep wreck: a short shove on impact, no sustained push.
{
  const f = fixture([['a', 'jeep', 200, 200], ['b', 'jeep', 200, 193]]);
  f.wreck('b'); f.board('a');
  const a = f.hull('a'), b = f.hull('b');
  a.speed = 8; f.drive(1); f.tick(300);
  const moved = 193 - b.z;
  between(moved, 0.2, 4, 'a jeep nudges a jeep wreck');
  assert(a.speed < 1, 'the jeep cannot keep shoving a jeep wreck');
}

// 4. A pushed wreck stops at a wall; the pusher stops behind it, nothing overlaps.
{
  const f = fixture([['tank', 'tank', 200, 200], ['jeep', 'jeep', 200, 192]]);
  for (let x = 190; x <= 210; x++) for (let y = 1; y <= 4; y++) f.set(x, y, 184, CONCRETE);
  f.wreck('jeep'); f.board('tank'); f.drive(1); f.tick(360);
  const jeep = f.hull('jeep'), tank = f.hull('tank');
  between(jeep.z, 185, 187.5, 'the wreck stops at the wall');
  assert.equal(tank.speed, 0, 'the tank is stopped behind the wedged wreck');
  assert(f.vs.clearHull(jeep, jeep.x, jeep.y, jeep.z) && f.vs.clearHull(tank, tank.x, tank.y, tank.z), 'no hull overlaps a wall or the other hull');
  for (let x = 190; x <= 210; x++) assert.equal(f.world.getBlock(x, 1, 184), CONCRETE, 'concrete never breaks');
}

// 4b. A body pinned between a shoved wreck and a wall stops the shove instead of being crushed.
{
  const f = fixture([['tank', 'tank', 200, 200], ['jeep', 'jeep', 200, 192]]);
  for (let x = 190; x <= 210; x++) for (let y = 1; y <= 4; y++) f.set(x, y, 184, CONCRETE);
  f.game.addClient('walker', 'walker');
  const walker = f.game.entities.get('walker');
  Object.assign(walker, { x: 200, y: 1, z: 185.5, hp: 100, armor: 0, state: 'alive', input: { keys: {}, yaw: 0, pitch: 0 } });
  f.wreck('jeep'); f.board('tank'); f.drive(1); f.tick(240);
  const jeep = f.hull('jeep');
  assert.equal(walker.state, 'alive', 'the pinned body survives');
  assert(jeep.z - 2.12 > walker.z, 'the wreck stops short of the pinned body');
}

// 5. A tank at speed breaks a timber fence and a plank wall, losing speed per
//    block; block changes reach tickBlocks, blockRevision and the client events.
{
  const f = fixture([['tank', 'tank', 200, 200]]);
  for (let x = 196; x <= 204; x++) f.set(x, 1, 190, x % 3 ? 0 : TIMBER), f.set(x, 2, 190, x % 3 ? PLANK : TIMBER);
  f.board('tank');
  const tank = f.hull('tank'); tank.speed = 10; f.drive(1);
  const revision = f.game.blockRevision;
  for (let i = 0; i < 150 && tank.z > 185; i++) f.tick();
  assert(tank.z < 186, 'the tank drives through the fence');
  const broken = f.game.tickBlocks.length;
  assert(broken >= 4, `the fence breaks where the hull meets it (${broken})`);
  assert.equal(f.game.blockRevision, revision + broken, 'every broken block bumps blockRevision once');
  assert(f.game.tickBlocks.every(b => b.v === 0), 'ramming only removes blocks');
  assert.equal(f.game.tickEvents.filter(e => e.kind === 'block' && e.v === 0 && (e.from === TIMBER || e.from === PLANK)).length, broken,
    'each broken block raises the client block event (debris and break sound)');
  assert(f.game.changedBlocks.size >= broken, 'broken blocks reach the changed set the bots relabel from');

  // A plank wall: speed loss is hardness·speedLoss/mass per block.
  const g = fixture([['tank', 'tank', 200, 200]]);
  for (let x = 194; x <= 206; x++) for (let y = 1; y <= 3; y++) g.set(x, y, 193, PLANK);
  g.board('tank'); const t = g.hull('tank'); t.speed = 12; g.drive(0);
  let before = null, after = null, cap = 0;
  for (let i = 0; i < 150 && t.z > 190; i++) {
    const count = g.game.tickBlocks.length, speed = t.speed;
    g.tick();
    const n = g.game.tickBlocks.length - count;
    cap = Math.max(cap, n);
    if (n && before == null) before = speed;
    if (n) after = t.speed;
  }
  assert(t.z < 190, 'the tank drives through a plank wall');
  assert(cap <= VEHICLE_RAM.tank.perTick, `at most ${VEHICLE_RAM.tank.perTick} blocks per tick (${cap})`);
  assert.equal(cap, VEHICLE_RAM.tank.perTick, 'a wide wall uses the whole per-tick cap');
  const lost = before - after, perBlock = BLOCK_HARDNESS[PLANK] * RAM_RULES.speedLoss / VEHICLE_MASS.tank;
  assert(lost >= perBlock * (g.game.tickBlocks.length - 1), `the tank loses speed per broken plank (${lost.toFixed(3)} m/s)`);
}

// 6. Hard and protected material stops a tank; masonry needs speed.
{
  const f = fixture([['tank', 'tank', 200, 200]]);
  for (let x = 194; x <= 206; x++) for (let y = 1; y <= 3; y++) f.set(x, y, 193, STONE);
  f.board('tank'); const tank = f.hull('tank'); tank.speed = 13; f.drive(1); f.tick(60);
  assert.equal(f.game.tickBlocks.length, 0, 'stone never breaks');
  assert(tank.z > 196 && tank.speed < 1, 'the tank is stopped by stone');

  const slow = fixture([['tank', 'tank', 200, 200]]);
  for (let x = 194; x <= 206; x++) for (let y = 1; y <= 3; y++) slow.set(x, y, 197, BRICK);
  slow.board('tank'); slow.hull('tank').speed = 4; slow.drive(0); slow.tick(60);
  assert.equal(slow.game.tickBlocks.length, 0, 'a slow tank does not break brick');

  const fast = fixture([['tank', 'tank', 200, 200]]);
  for (let x = 194; x <= 206; x++) for (let y = 1; y <= 3; y++) fast.set(x, y, 196, WHITE_PLASTER);
  fast.board('tank'); fast.hull('tank').speed = 13; fast.drive(1); fast.tick(20);
  assert(fast.game.tickBlocks.length > 0, 'a fast tank breaks plaster');
  assert(fast.hull('tank').hp < 1000, 'ramming masonry costs the tank a little hull');
  assert(fast.hull('tank').hp > 900, 'ramming damage stays small');

  // A glancing hit scrapes along a plaster wall instead of carving it.
  const scrape = fixture([['tank', 'tank', 200.2, 200, 0.3]]);
  for (let z = 150; z <= 205; z++) for (let y = 1; y <= 3; y++) scrape.set(196, y, z, WHITE_PLASTER);
  scrape.board('tank'); const scraper = scrape.hull('tank'); scraper.speed = 13; scrape.drive(1); scrape.tick(90);
  assert.equal(scrape.game.tickBlocks.length, 0, 'a glancing tank scrapes along plaster without breaking it');
  assert(scraper.z < 190, 'the scraping tank keeps going along the wall');

  // Planks inside a flag pad's guard radius never break.
  const guarded = fixture([['tank', 'tank', 200, 200]], { flags: [{ id: 'A', x: 200, y: 1, z: 192, radius: 20 }] });
  for (let x = 194; x <= 206; x++) for (let y = 1; y <= 3; y++) guarded.set(x, y, 193, PLANK);
  guarded.board('tank'); guarded.hull('tank').speed = 12; guarded.drive(1); guarded.tick(60);
  assert.equal(guarded.world.getBlock(200, 2, 193), PLANK, 'a flag pad guards its structures');
}

// 7. A jeep breaks a hedge and glass but not a brick wall, which stops it.
{
  const f = fixture([['jeep', 'jeep', 200, 200]]);
  for (let x = 196; x <= 204; x++) for (let y = 1; y <= 2; y++) f.set(x, y, 192, LEAVES);
  f.set(200, 3, 192, GLASS);
  for (let x = 194; x <= 206; x++) for (let y = 1; y <= 3; y++) f.set(x, y, 180, BRICK);
  f.board('jeep'); const jeep = f.hull('jeep'); jeep.speed = 12; f.drive(1);
  let atHedge = null, pastHedge = null;
  for (let i = 0; i < 180; i++) {
    const count = f.game.tickBlocks.length, speed = jeep.speed;
    f.tick();
    if (f.game.tickBlocks.length > count) { atHedge ??= speed; pastHedge = jeep.speed; }
  }
  assert(f.game.tickBlocks.length >= 4, 'the jeep breaks through the hedge');
  assert(pastHedge < atHedge, 'leaves slow the jeep a little');
  for (let x = 194; x <= 206; x++) assert.equal(f.world.getBlock(x, 2, 180), BRICK, 'a jeep never breaks brick');
  assert(jeep.z > 180 + 2.12 - 0.01 && jeep.speed < 1, 'the brick wall stops the jeep');
  assert(jeep.hp < 320, 'the hard wall damages the jeep at speed');
}

// 8. A crawling jeep does not break a fence; a fast one does, and pays for it.
{
  const f = fixture([['jeep', 'jeep', 200, 200]]);
  for (let x = 196; x <= 204; x++) f.set(x, 2, 196, PLANK);
  f.board('jeep'); f.hull('jeep').speed = 3; f.drive(0); f.tick(60);
  assert.equal(f.game.tickBlocks.length, 0, 'a jeep below wood speed is stopped by planks');
  const g = fixture([['jeep', 'jeep', 200, 200]]);
  for (let x = 196; x <= 204; x++) g.set(x, 2, 196, PLANK);
  g.board('jeep'); g.hull('jeep').speed = 16; g.drive(1); g.tick(30);
  assert(g.game.tickBlocks.length > 0 && g.hull('jeep').z < 195, 'a fast jeep smashes through the rail');
  assert(g.hull('jeep').hp < 320, 'planks scratch a jeep');
}

console.log('Vehicle ram: tank shoves wrecks (jeep only nudges, tank wreck stops a jeep), wrecks stop at walls and sleep again, tank/jeep break light blocks by class and speed through the block pipeline with per-tick caps, speed loss and small damage; stone, concrete, brick (jeep) and flag pads hold');
