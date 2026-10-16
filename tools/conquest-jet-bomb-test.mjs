// Jet STRIKE pylons (docs/conquest.md "Jet pylons"): the rails carry AA missiles
// or bombs, the load only changes on the ground, bombs drop with the airframe's
// velocity from an airborne jet, re-arm one by one, and land with an HE blast,
// an AT direct hit and a crater. Authoritative server only (GameEngine).
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { VEHICLE_WEAPONS, VEHICLE_STORE_RULES, bombReleaseVelocity, mountPose, storesChangeable } from '../shared/vehicle-defs.js';
import { VEHICLE_WEAPON_META, seatWeaponList, isStoreMount } from '../shared/conquest-contract.js';
import { DIRT } from '../shared/world/blocks.js';

const FLOOR = 4; // dirt up to y 4, so the surface is y 5
const BOMB = VEHICLE_WEAPONS.jetBomb;
const measured = {};

function fixture() {
  const dimensions = { sx: 1024, sy: 64, sz: 1024 }, removed = new Set();
  let snapshot = null;
  const world = { dimensions,
    getBlock(x, y, z) {
      if (y >= dimensions.sy) return 0;
      if (x < 0 || z < 0 || x >= dimensions.sx || z >= dimensions.sz || y < 0) return 3;
      return y <= FLOOR && !removed.has(`${x},${y},${z}`) ? DIRT : 0;
    },
    setBlock(x, y, z, value) { if (value === 0) removed.add(`${x},${y},${z}`); return true; },
    findSpawns: () => [{ x: 450, y: FLOOR + 1, z: 870 }] };
  const game = new GameEngine({ mode: 'conquest', world,
    mapMeta: { id: 'frontier', dimensions, spawns: { conquest: { alpha: [{ x: 450, y: FLOOR + 1, z: 870 }], bravo: [{ x: 750, y: FLOOR + 1, z: 850 }] } },
      conquest: { flags: [{ id: 'A', x: 450, y: FLOOR + 1, z: 850 }], bases: {}, vehicleSpawns: [
        { id: 'jet', team: 'alpha', type: 'plane', x: 450, y: FLOOR + 1, z: 850, yaw: 0 },
        { id: 'tank', team: 'bravo', type: 'tank', x: 750, y: FLOOR + 1, z: 850, yaw: 0 },
        { id: 'jeep', team: 'bravo', type: 'jeep', x: 760, y: FLOOR + 1, z: 900, yaw: 0 },
      ] } }, broadcast: value => { snapshot = value; } });
  game.addClient('pilot', 'Pilot'); game.addClient('foe', 'Foe');
  const pilot = game.entities.get('pilot'), foe = game.entities.get('foe'), jet = game.vehicles.vehicles.get('jet');
  Object.assign(pilot, { x: jet.x + 5, y: FLOOR + 1, z: jet.z });
  Object.assign(foe, { x: 700, y: FLOOR + 1, z: 700 });
  game.applyInput(pilot.id, { keys: {}, vehicleAction: { type: 'enter', vehicleId: jet.id }, yaw: 0, pitch: 0 });
  assert.equal(pilot.vehicleId, jet.id, 'the pilot boards the jet');
  const input = payload => game.applyInput(pilot.id, { keys: {}, yaw: jet.yaw, pitch: 0, ...payload });
  const pick = index => input({ vehicleAction: { type: 'weapon', index } });
  const ticks = count => { for (let i = 0; i < count; i++) game.step(1000 / 60); };
  const rails = () => game.vehicles.mounts.state(jet, 'rails');
  const row = () => snapshot.vehicles.find(r => r.id === jet.id);
  return { game, pilot, foe, jet, input, pick, ticks, rails, row, removed, snapshot: () => snapshot };
}

/** Put the jet in level flight at `agl` metres, `speed` m/s along -z. */
function fly(f, { agl = 120, speed = 50, x = 450, z = 900 } = {}) {
  Object.assign(f.jet, { x, y: FLOOR + 1 + agl, z, yaw: 0, pitch: 0, roll: 0, vx: 0, vy: 0, vz: -speed, speed, airspeed: speed,
    grounded: false, gearDown: false, throttle: 0.6, enginePower: 0.6 });
}

// Contract: the rails are a store mount with two stores; the seat lists cannon, AA missiles, bombs.
assert.deepEqual(seatWeaponList('plane', 'driver').map(e => e.weapon), ['planeCannon', 'aaMissile', 'jetBomb']);
assert.equal(isStoreMount('plane', 'rails'), true); assert.equal(isStoreMount('plane', 'nose'), false); assert.equal(isStoreMount('tank', 'main'), false);
assert.deepEqual([VEHICLE_WEAPON_META.jetBomb.kind, VEHICLE_WEAPON_META.jetBomb.presentation, VEHICLE_WEAPON_META.jetBomb.cls, BOMB.splashCls],
  ['bomb', 'bomb', 'at', 'he']);
assert.deepEqual([BOMB.magazine, BOMB.rearmSeconds], [2, 20]);

// 1. On the ground: the jet spawns with AA missiles on the rails (row store 0); slot 3 loads the bombs.
{
  const f = fixture();
  f.ticks(2);
  assert.equal(f.rails().weapon, 'aaMissile');
  assert.deepEqual(f.row().mounts[1].slice(2), [2, 0, 0, 0], 'rails row: 2 missiles, store index 0');
  assert.equal(f.row().mounts[0].length, 5, 'the nose gun is no store mount');
  assert.equal(storesChangeable(f.jet), true);
  f.pick(2); f.ticks(1);
  assert.equal(f.rails().weapon, 'jetBomb'); assert.equal(f.jet.sel.driver, 2);
  assert.deepEqual(f.row().mounts[1].slice(2), [0, 0, 100, 1], 'the bombs load empty: reload 100 %, store index 1');
  f.ticks(60 * VEHICLE_STORE_RULES.loadSeconds - 30);
  assert.equal(f.rails().ammo, 0, 'still loading');
  f.ticks(40);
  assert.deepEqual(f.row().mounts[1].slice(2), [2, 0, 0, 1], `after ${VEHICLE_STORE_RULES.loadSeconds} s both bombs hang on the pylons`);
  // A bomb never drops from a landed jet.
  f.game.tickEvents.length = 0;
  const events = []; f.game.broadcast = s => { events.push(...s.events); };
  f.input({ wantFire: true }); f.ticks(30); f.input({ wantFire: false }); f.ticks(1);
  assert.equal(events.filter(e => e.kind === 'projectileLaunch').length, 0, 'no bomb from the runway');
  assert.equal(f.rails().ammo, 2);
  // Rolling: the load stays.
  Object.assign(f.jet, { speed: 6, vz: -6 });
  assert.equal(storesChangeable(f.jet), false);
  assert.equal(f.game.vehicles.mounts.select(f.jet, 'driver', 1), false, 'no store change while rolling');
  assert.equal(f.rails().weapon, 'jetBomb');
  // Swapping back on the ground (stopped) is allowed and loads the missiles empty.
  Object.assign(f.jet, { speed: 0, vz: 0 });
  assert.equal(f.game.vehicles.mounts.select(f.jet, 'driver', 1), true);
  assert.deepEqual([f.rails().weapon, f.rails().ammo], ['aaMissile', 0]);
}

// 2. In the air: the stowed store cannot be picked; the cannon and the loaded store can.
{
  const f = fixture();
  f.pick(2); f.ticks(60 * VEHICLE_STORE_RULES.loadSeconds + 5);
  fly(f);
  assert.equal(storesChangeable(f.jet), false);
  f.pick(1); f.ticks(1);
  assert.deepEqual([f.rails().weapon, f.jet.sel.driver], ['jetBomb', 2], 'AA missiles stay stowed in the air');
  f.pick(0); f.ticks(1); assert.equal(f.jet.sel.driver, 0, 'the cannon is always available');
  f.pick(2); f.ticks(1); assert.equal(f.jet.sel.driver, 2, 'the loaded bombs are');
}

// 3. Release: the bomb leaves the pylon with the jet's velocity plus the pylon kick, falls on the
// gravity arc, and its blast kills infantry, wrecks a jeep, hurts a tank and digs a crater.
{
  const f = fixture();
  f.pick(2); f.ticks(60 * VEHICLE_STORE_RULES.loadSeconds + 5);
  fly(f, { agl: 120, speed: 50 });
  const velocity = bombReleaseVelocity(f.jet), pose = mountPose(f.jet, 'driver', 'rails', { side: 0 });
  assert.deepEqual(velocity, [0, -VEHICLE_STORE_RULES.eject, -50]);
  // Where it lands: solve the fall to the dirt surface (y FLOOR + 1).
  const drop = pose.origin[1] - (FLOOR + 1), g = VEHICLE_WEAPON_META.jetBomb.gravity;
  const t = (velocity[1] + Math.sqrt(velocity[1] ** 2 + 2 * g * drop)) / g;
  const impact = [pose.origin[0] + velocity[0] * t, FLOOR + 1, pose.origin[2] + velocity[2] * t];
  const jeep = f.game.vehicles.vehicles.get('jeep'), tank = f.game.vehicles.vehicles.get('tank');
  Object.assign(jeep, { x: impact[0] + 3, z: impact[2] + 2 });
  Object.assign(tank, { x: impact[0] - 7, z: impact[2] });
  Object.assign(f.foe, { x: impact[0] + 1.5, y: FLOOR + 1, z: impact[2] - 3, vx: 0, vy: 0, vz: 0, spawnProtectedUntil: 0, spawnProtected: false });
  const tankHp = tank.hp;
  const events = []; f.game.broadcast = s => { events.push(...s.events); };
  // Hold the jet's flight state fixed each tick so the release point is the computed one.
  f.input({ wantFire: true }); f.ticks(1); f.input({ wantFire: false });
  const launch = events.find(e => e.kind === 'projectileLaunch' && e.vehicleWeapon === 'jetBomb');
  assert.ok(launch, 'one bomb released');
  assert.equal(launch.type, 'bomb'); assert.equal(launch.g, g);
  // (the flight step runs before the mounts in the tick, so the airframe has moved on by one tick)
  assert.ok(launch.v.every((n, i) => Math.abs(n - velocity[i]) < 0.25), `released with the jet's velocity plus the kick (${launch.v})`);
  assert.equal(events.filter(e => e.kind === 'shoot' && e.vehicleWeapon === 'jetBomb').length, 1);
  assert.equal(f.rails().ammo, 1); assert.equal(f.rails().rearm.length, 1, 'the empty pylon starts its 20 s re-arm');
  // Freeze the jet out of the way, let the bomb fall.
  Object.assign(f.jet, { x: 100, z: 100, y: 200, vx: 0, vy: 0, vz: 0 });
  const kills = []; const before = f.removed.size;
  for (let i = 0; i < Math.ceil((t + 1) * 60); i++) { f.game.step(1000 / 60); f.jet.y = 200; f.jet.vy = 0; }
  const blast = events.find(e => e.kind === 'projectileExplode' && e.vehicleWeapon === 'jetBomb');
  assert.ok(blast, 'the bomb explodes');
  assert.ok(Math.hypot(blast.x - impact[0], blast.z - impact[2]) < 2.5 && Math.abs(blast.y - impact[1]) < 1.5,
    `on the predicted impact (${blast.x.toFixed(1)}, ${blast.y.toFixed(1)}, ${blast.z.toFixed(1)} vs ${impact.map(n => n.toFixed(1))})`);
  assert.equal(blast.radius, BOMB.splashRadius);
  assert.ok(f.foe.state !== 'alive' || f.foe.hp <= 0, 'infantry 3.4 m from the impact dies');
  kills.push(...events.filter(e => e.kind === 'kill' && e.victim === f.foe.id));
  assert.equal(kills[0]?.w, 'jetBomb', 'the kill is credited to the bomb');
  assert.equal(jeep.hp, 0, 'a jeep 3.6 m away is wrecked');
  assert.ok(tank.hp < tankHp && tank.hp > tankHp - 200, `a tank 7 m away takes HE splash only (${tankHp - tank.hp})`);
  const crater = f.removed.size - before;
  Object.assign(measured, { crater, tankSplash7m: tankHp - tank.hp });
  assert.ok(crater > 60 && crater <= BOMB.maxDestroyedBlocks, `a crater of ${crater} blocks (budget ${BOMB.maxDestroyedBlocks})`);
}

// 4. A direct hit on a tank's deck: the AT direct hit (top zone) plus the HE splash.
{
  const f = fixture();
  f.pick(2); f.ticks(60 * VEHICLE_STORE_RULES.loadSeconds + 5);
  const tank = f.game.vehicles.vehicles.get('tank');
  fly(f, { agl: 60, speed: 40, x: tank.x, z: tank.z + 60 });
  const hp = tank.hp;
  const events = []; f.game.broadcast = s => { events.push(...s.events); };
  // Drop straight onto the tank: the next pylon (a wing station) right above the hull centre,
  // the jet's forward motion killed for this one release.
  Object.assign(f.jet, { vz: 0, speed: 0, airspeed: 0, x: tank.x, z: tank.z });
  const station = mountPose(f.jet, 'driver', 'rails', { side: f.rails().side }).origin;
  Object.assign(f.jet, { x: f.jet.x + tank.x - station[0], z: f.jet.z + tank.z - station[2] });
  f.input({ wantFire: true }); f.ticks(1); f.input({ wantFire: false });
  Object.assign(f.jet, { x: 100, z: 100, y: 200 });
  for (let i = 0; i < 6 * 60; i++) { f.game.step(1000 / 60); f.jet.y = 200; f.jet.vy = 0; f.jet.vz = 0; }
  const hit = events.find(e => e.kind === 'vehicle_hit' && e.vehicleId === tank.id && e.cls === 'at');
  assert.ok(hit, 'the bomb strikes the tank directly (AT)');
  assert.equal(hit.zone, 'top', 'a falling bomb meets the deck');
  assert.ok(hp - tank.hp >= 500, `a direct hit takes ${hp - tank.hp} of ${hp}`);
  measured.tankDirect = hp - tank.hp;
}

// 5. Re-arm: both bombs gone, each pylon refills 20 s after its own release.
{
  const f = fixture();
  f.pick(2); f.ticks(60 * VEHICLE_STORE_RULES.loadSeconds + 5);
  fly(f, { agl: 150, speed: 50 });
  const hold = () => Object.assign(f.jet, { y: FLOOR + 151, vy: 0, vz: -50, z: 900, grounded: false });
  f.input({ wantFire: true });
  for (let i = 0; i < 60; i++) { f.game.step(1000 / 60); hold(); }
  f.input({ wantFire: false });
  assert.equal(f.rails().ammo, 0, 'two releases empty the pylons');
  f.game.step(1000 / 60); hold();
  assert.ok(f.row().mounts[1][4] > 90, 'the empty pylons show their re-arm');
  for (let i = 0; i < 19 * 60; i++) { f.game.step(1000 / 60); hold(); }
  assert.equal(f.rails().ammo, 1, 'the first bomb is back about 20 s after its release');
  for (let i = 0; i < 2 * 60; i++) { f.game.step(1000 / 60); hold(); }
  assert.equal(f.rails().ammo, 2);
}

console.log(`Jet bombs: crater ${measured.crater} blocks, tank at 7 m -${measured.tankSplash7m}, direct deck hit -${measured.tankDirect}.`);
console.log('Jet bombs: store mount contract, ground-only load change (rolling/airborne refused), airborne-only release with the airframe velocity, predicted impact, infantry/jeep/tank blast, AT deck hit, crater budget and 20 s pylon re-arm passed');
