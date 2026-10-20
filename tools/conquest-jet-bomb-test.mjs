// Jet stores (docs/conquest.md "Jet stores"): the jet carries 2 AA missiles on
// the outer rails AND 2 bombs on the inner pylons, each with its own ammo and
// re-arm, all selectable at any time (in the air too). Bombs drop with the
// airframe's velocity from an airborne jet, re-arm one by one in 10 s, land
// with a 13 m HE blast, an AT direct hit and a crater, and leave a burning
// field that keeps hurting infantry for the pilot (kill key jetBomb).
// Authoritative server only (GameEngine).
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import * as vehicleDefs from '../shared/vehicle-defs.js';
import * as contract from '../shared/conquest-contract.js';
import { DIRT } from '../shared/world/blocks.js';

const { VEHICLE_WEAPONS, bombReleaseVelocity, mountPose } = vehicleDefs;
const { VEHICLE_WEAPON_META, seatWeaponList, vehicleMountOrder } = contract;
const FLOOR = 4; // dirt up to y 4, so the surface is y 5
const BOMB = VEHICLE_WEAPONS.jetBomb;
const measured = {};

function fixture() {
  const dimensions = { sx: 1024, sy: 64, sz: 1024 }, removed = new Set();
  let snapshot = null;
  const listeners = [];
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
        { id: 'jeep2', team: 'bravo', type: 'jeep', x: 780, y: FLOOR + 1, z: 900, yaw: 0 },
      ] } }, broadcast: value => { snapshot = value; for (const listen of listeners) listen(value); } });
  // Teams alternate: pilot/mate/spare alpha, the foes bravo.
  for (const id of ['pilot', 'foe', 'mate', 'foe2', 'spare', 'foe3']) game.addClient(id, id);
  const pilot = game.entities.get('pilot'), jet = game.vehicles.vehicles.get('jet');
  const foes = ['foe', 'foe2', 'foe3'].map(id => game.entities.get(id)), mate = game.entities.get('mate');
  assert.deepEqual([pilot.team, mate.team, ...foes.map(p => p.team)], ['alpha', 'alpha', 'bravo', 'bravo', 'bravo']);
  Object.assign(pilot, { x: jet.x + 5, y: FLOOR + 1, z: jet.z });
  for (const [i, p] of [...foes, mate, game.entities.get('spare')].entries()) Object.assign(p, { x: 300 + i * 20, y: FLOOR + 1, z: 300 });
  game.applyInput(pilot.id, { keys: {}, vehicleAction: { type: 'enter', vehicleId: jet.id }, yaw: 0, pitch: 0 });
  assert.equal(pilot.vehicleId, jet.id, 'the pilot boards the jet');
  const input = payload => game.applyInput(pilot.id, { keys: {}, yaw: jet.yaw, pitch: 0, ...payload });
  const pick = index => input({ vehicleAction: { type: 'weapon', index } });
  const ticks = count => { for (let i = 0; i < count; i++) game.step(1000 / 60); };
  const rails = () => game.vehicles.mounts.state(jet, 'rails'), bombs = () => game.vehicles.mounts.state(jet, 'bombs');
  const row = () => snapshot.vehicles.find(r => r.id === jet.id);
  return { game, pilot, foes, mate, jet, input, pick, ticks, rails, bombs, row, removed, snapshot: () => snapshot, listen: fn => listeners.push(fn) };
}

/** Put the jet in level flight at `agl` metres, `speed` m/s along -z. */
function fly(f, { agl = 120, speed = 50, x = 450, z = 900 } = {}) {
  Object.assign(f.jet, { x, y: FLOOR + 1 + agl, z, yaw: 0, pitch: 0, roll: 0, vx: 0, vy: 0, vz: -speed, speed, airspeed: speed,
    grounded: false, gearDown: false, throttle: 0.6, enginePower: 0.6 });
}
/** Where a bomb released now lands on the dirt surface. */
function predictImpact(f) {
  const velocity = bombReleaseVelocity(f.jet), pose = mountPose(f.jet, 'driver', 'bombs', { side: f.bombs().side });
  const drop = pose.origin[1] - (FLOOR + 1), g = VEHICLE_WEAPON_META.jetBomb.gravity;
  const t = (velocity[1] + Math.sqrt(velocity[1] ** 2 + 2 * g * drop)) / g;
  return { t, velocity, point: [pose.origin[0] + velocity[0] * t, FLOOR + 1, pose.origin[2] + velocity[2] * t] };
}
const place = (p, at, dx, dz) => Object.assign(p, { x: at[0] + dx, y: FLOOR + 1, z: at[2] + dz, vx: 0, vy: 0, vz: 0,
  spawnProtectedUntil: 0, spawnProtected: false, state: 'alive', hp: 100 });

// Contract (v5, still in v6): cannon, AA missiles and bombs on three mounts; no store mounts or ground-only loadout left.
assert.equal(contract.CONQUEST_CONTRACT_VERSION, 7);
assert.deepEqual(seatWeaponList('plane', 'driver'), [{ mount: 'nose', weapon: 'planeCannon' }, { mount: 'rails', weapon: 'aaMissile' },
  { mount: 'bombs', weapon: 'jetBomb' }]);
assert.deepEqual(vehicleMountOrder('plane'), ['driver:nose', 'driver:rails', 'driver:bombs']);
for (const gone of ['STORE_MOUNTS', 'isStoreMount']) assert.equal(gone in contract, false, `${gone} is gone`);
for (const gone of ['VEHICLE_STORE_RULES', 'storesChangeable', 'isStoreMount']) assert.equal(gone in vehicleDefs, false, `${gone} is gone`);
assert.deepEqual([VEHICLE_WEAPON_META.jetBomb.kind, VEHICLE_WEAPON_META.jetBomb.presentation, VEHICLE_WEAPON_META.jetBomb.cls, BOMB.splashCls],
  ['bomb', 'bomb', 'at', 'he']);
// The buff (2026-10-19): re-arm 20 → 10 s, splash radius 9 → 13 m, a burning field on the impact.
assert.deepEqual([BOMB.magazine, BOMB.cooldown, BOMB.rearmSeconds, BOMB.damage, BOMB.splash, BOMB.splashRadius, BOMB.eject], [2, 0.5, 10, 500, 420, 13, 3]);
assert.deepEqual({ ...BOMB.burn }, { radius: 6.5, durationMs: 8000, damagePerSecond: 30, cellSize: 1.5, rise: 1.5, drop: 8 });
const bombs = vehicleDefs.VEHICLE_DEFS.plane.mounts.bombs, rails = vehicleDefs.VEHICLE_DEFS.plane.mounts.rails;
assert.ok(bombs.sides.every(([x], i) => Math.abs(x) < Math.abs(rails.sides[i][0]) && Math.sign(x) === Math.sign(rails.sides[i][0])),
  'the bomb pylons sit inboard of the missile rails');

// 1. On the ground: the jet spawns with both stores full; every mount row has five entries; no bomb from the runway.
{
  const f = fixture();
  f.ticks(2);
  assert.deepEqual([f.rails().weapon, f.bombs().weapon], ['aaMissile', 'jetBomb']);
  assert.deepEqual(f.row().mounts.map(m => m.length), [5, 5, 5]);
  assert.deepEqual(f.row().mounts.slice(1).map(m => m.slice(2)), [[2, 0, 0], [2, 0, 0]], 'two missiles and two bombs, nothing loading');
  f.pick(2); f.ticks(1);
  assert.equal(f.jet.sel.driver, 2, 'the bombs are selectable on the ground at once');
  const events = []; f.listen(s => events.push(...s.events));
  f.input({ wantFire: true }); f.ticks(30); f.input({ wantFire: false }); f.ticks(1);
  assert.equal(events.filter(e => e.kind === 'projectileLaunch').length, 0, 'no bomb from the runway');
  assert.equal(f.bombs().ammo, 2);
}

// 2. In the air every weapon is selectable; bombs and missiles keep separate ammo and re-arm.
{
  const f = fixture();
  fly(f, { agl: 150 });
  const hold = () => Object.assign(f.jet, { y: FLOOR + 151, vy: 0, vz: -50, grounded: false });
  const fireOnce = () => { f.input({ wantFire: true }); f.game.step(1000 / 60); hold(); f.input({ wantFire: false }); f.game.step(1000 / 60); hold(); };
  for (const index of [1, 2, 0, 2]) { f.pick(index); f.game.step(1000 / 60); hold(); assert.equal(f.jet.sel.driver, index, `weapon ${index + 1} picked in the air`); }
  const events = []; f.listen(s => events.push(...s.events));
  fireOnce();
  assert.deepEqual([f.bombs().ammo, f.rails().ammo], [1, 2], 'a bomb leaves the missiles on their rails');
  f.pick(1); f.game.step(1000 / 60); hold();
  fireOnce();
  assert.deepEqual([f.bombs().ammo, f.rails().ammo], [1, 1], 'a missile leaves the bomb on its pylon');
  assert.deepEqual(events.filter(e => e.kind === 'shoot').map(e => [e.mount, e.vehicleWeapon]), [['bombs', 'jetBomb'], ['rails', 'aaMissile']]);
  assert.deepEqual([f.bombs().rearm.length, f.rails().rearm.length], [1, 1], 'each store re-arms on its own');
  const row = f.row().mounts;
  assert.deepEqual([row[1][2], row[2][2]], [1, 1], 'the snapshot carries both stores');
  // Bombs back after 10 s, the missile after its own 15 s.
  for (let i = 0; i < 10.2 * 60; i++) { f.game.step(1000 / 60); hold(); }
  assert.deepEqual([f.bombs().ammo, f.rails().ammo], [2, 1]);
  for (let i = 0; i < 5 * 60; i++) { f.game.step(1000 / 60); hold(); }
  assert.deepEqual([f.bombs().ammo, f.rails().ammo], [2, 2]);
}

// 3. Release and blast: the bomb leaves the pylon with the jet's velocity plus the kick, falls on the
// gravity arc, and its 13 m blast kills infantry, wrecks jeeps, hurts tanks a little and digs a crater.
// The impact then burns: a 6.5 m field that keeps burning enemy infantry for the pilot.
{
  const f = fixture();
  fly(f, { agl: 120, speed: 50 });
  f.pick(2); f.ticks(1); fly(f, { agl: 120, speed: 50 });
  const { t, velocity, point: impact } = predictImpact(f);
  assert.deepEqual(velocity, [0, -BOMB.eject, -50]);
  const g = VEHICLE_WEAPON_META.jetBomb.gravity;
  const tank = f.game.vehicles.vehicles.get('tank'), jeep = f.game.vehicles.vehicles.get('jeep'), jeep2 = f.game.vehicles.vehicles.get('jeep2');
  Object.assign(jeep, { x: impact[0] + 3, z: impact[2] + 2 });
  Object.assign(jeep2, { x: impact[0] + 9, z: impact[2] + 8 });
  Object.assign(tank, { x: impact[0] - 7, z: impact[2] });
  // Infantry at 4, 8 and 11 m (across the impact from the vehicles), the mate well out of the blast.
  place(f.foes[0], impact, 0, -4); place(f.foes[1], impact, -2, -7.75); place(f.foes[2], impact, 2, -10.8);
  place(f.mate, impact, 0, 30);
  const tankHp = tank.hp, jeep2Hp = jeep2.hp;
  const events = []; f.listen(s => events.push(...s.events));
  f.input({ wantFire: true }); f.ticks(1); f.input({ wantFire: false });
  const launch = events.find(e => e.kind === 'projectileLaunch' && e.vehicleWeapon === 'jetBomb');
  assert.ok(launch, 'one bomb released');
  assert.equal(launch.type, 'bomb'); assert.equal(launch.g, g);
  // (the flight step runs before the mounts in the tick, so the airframe has moved on by one tick)
  assert.ok(launch.v.every((n, i) => Math.abs(n - velocity[i]) < 0.25), `released with the jet's velocity plus the kick (${launch.v})`);
  assert.equal(f.bombs().ammo, 1); assert.equal(f.bombs().rearm.length, 1, 'the empty pylon starts its 10 s re-arm');
  // Freeze the jet out of the way, let the bomb fall; stop on the blast tick.
  Object.assign(f.jet, { x: 100, z: 100, y: 200, vx: 0, vy: 0, vz: 0 });
  const before = f.removed.size;
  for (let i = 0; i < Math.ceil((t + 1) * 60) && !events.some(e => e.kind === 'projectileExplode'); i++) {
    f.game.step(1000 / 60); f.jet.y = 200; f.jet.vy = 0;
  }
  const blast = events.find(e => e.kind === 'projectileExplode' && e.vehicleWeapon === 'jetBomb');
  assert.ok(blast, 'the bomb explodes');
  assert.ok(Math.hypot(blast.x - impact[0], blast.z - impact[2]) < 2.5 && Math.abs(blast.y - impact[1]) < 1.5,
    `on the predicted impact (${blast.x.toFixed(1)}, ${blast.y.toFixed(1)}, ${blast.z.toFixed(1)} vs ${impact.map(n => n.toFixed(1))})`);
  assert.equal(blast.radius, BOMB.splashRadius);
  const lost = f.foes.map(p => (p.state === 'alive' ? 100 - p.hp : 100));
  Object.assign(measured, { infantry: lost, tankSplash7m: tankHp - tank.hp, jeep12m: jeep2Hp - jeep2.hp });
  assert.ok(f.foes[0].state !== 'alive' && f.foes[1].state !== 'alive', `infantry at 4 m and 8 m die (${lost})`);
  assert.ok(f.foes[2].state === 'alive' && lost[2] > 20 && lost[2] < 100, `infantry at 11 m is hurt (${lost[2]})`);
  assert.equal(f.mate.hp, 100, 'the mate 30 m away is untouched');
  const kills = events.filter(e => e.kind === 'kill' && e.victim === f.foes[0].id);
  assert.equal(kills[0]?.w, 'jetBomb', 'the kill is credited to the bomb');
  assert.equal(jeep.hp, 0, 'a jeep 3.6 m away is wrecked');
  assert.ok(jeep2.hp < jeep2Hp && jeep2.hp > 0, `a jeep 12 m away is damaged (${jeep2Hp - jeep2.hp})`);
  assert.ok(tank.hp < tankHp && tank.hp > tankHp - 200, `a tank 7 m away takes HE splash only (${tankHp - tank.hp})`);
  const crater = f.removed.size - before;
  measured.crater = crater;
  assert.ok(crater > 60 && crater <= BOMB.maxDestroyedBlocks, `a crater of ${crater} blocks (budget ${BOMB.maxDestroyedBlocks})`);

  // The burning field: lit in and around the crater, the pilot owns it, the jetBomb key, 8 s.
  const field = [...f.game.projectiles.fire.active.values()].find(entry => entry.id === `fire-${launch.pid}`);
  assert.ok(field, 'the impact leaves a ground fire');
  assert.deepEqual([field.ownerId, field.key, field.radius, field.cellSize, field.damagePerSecond, field.expiresAt - field.createdAt],
    ['pilot', 'jetBomb', BOMB.burn.radius, BOMB.burn.cellSize, BOMB.burn.damagePerSecond, BOMB.burn.durationMs]);
  const spread = Math.max(...field.cells.map(c => Math.hypot(c[0] - blast.x, c[2] - blast.z)));
  const deepest = Math.min(...field.cells.map(c => c[1])), highest = Math.max(...field.cells.map(c => c[1]));
  Object.assign(measured, { cells: field.cells.length, spread, craterDepth: FLOOR + 1.04 - deepest });
  assert.ok(field.cells.length >= 45 && field.cells.length <= 64, `${field.cells.length} flame cells`);
  assert.ok(spread >= 5.9, `the fire reaches the crater rim (${spread.toFixed(1)} m)`);
  assert.ok(deepest < FLOOR && Math.abs(highest - (FLOOR + 1.04)) < 0.01, 'flames on the crater floor and on the untouched rim');
  f.ticks(1);
  const wire = f.snapshot().fireFields.find(entry => entry.id === field.id);
  assert.ok(wire && wire.cellSize === BOMB.burn.cellSize && wire.cells.length === field.cells.length, 'the snapshot carries the bomb fire');

  // An enemy walking into the fire on the rim burns to death in about 4 s, credited to the pilot's bomb;
  // the mate standing in it is untouched (no team damage), and so is the tank parked in it.
  const rim = field.cells.reduce((a, b) => (Math.hypot(b[0] - blast.x, b[2] - blast.z) > Math.hypot(a[0] - blast.x, a[2] - blast.z) ? b : a));
  const runner = f.foes[2], spot = [rim[0], FLOOR + 1, rim[2]];
  place(runner, spot, 0, 0); place(f.mate, spot, 0.4, 0);
  Object.assign(tank, { x: rim[0], z: rim[2] + 3, vx: 0, vz: 0 });
  const tankBefore = tank.hp;
  let burnedFor = 0;
  while (runner.state === 'alive' && burnedFor < 6) {
    Object.assign(runner, { x: spot[0], z: spot[2], vx: 0, vz: 0 }); Object.assign(f.mate, { x: spot[0] + 0.4, z: spot[2], vx: 0, vz: 0 });
    f.game.step(1000 / 60); burnedFor += 1 / 60;
  }
  measured.burnKill = burnedFor;
  assert.notEqual(runner.state, 'alive', 'the fire kills an enemy standing in it');
  assert.ok(burnedFor > 3 && burnedFor < 5, `in ${burnedFor.toFixed(2)} s`);
  const burnKill = events.filter(e => e.kind === 'kill' && e.victim === runner.id).at(-1);
  assert.deepEqual([burnKill?.killer, burnKill?.w], ['pilot', 'jetBomb'], 'the burn kill is the pilot\'s, with the bomb key');
  assert.equal(f.mate.hp, 100, 'no team damage from the fire');
  assert.equal(tank.hp, tankBefore, 'the fire does not hurt a tank');
  // A jeep parked in the fire takes the light-hull fire dose (30 x 0.3 per s).
  Object.assign(jeep2, { x: rim[0], z: rim[2], vx: 0, vz: 0 });
  const jeepBefore = jeep2.hp;
  f.ticks(60);
  measured.jeepBurn = jeepBefore - jeep2.hp;
  assert.ok(Math.abs(measured.jeepBurn - BOMB.burn.damagePerSecond * 0.3) < 1.5, `a jeep in the fire loses ${measured.jeepBurn.toFixed(1)} per s`);
  // Out after 8 s.
  f.ticks(Math.ceil((BOMB.burn.durationMs / 1000 - burnedFor - 1) * 60) + 30);
  assert.equal(f.game.projectiles.fire.active.has(field.id), false, 'the fire burns out after 8 s');
}

// 4. A direct hit on a tank's deck: the AT direct hit (top zone) plus the HE splash.
{
  const f = fixture();
  const tank = f.game.vehicles.vehicles.get('tank');
  fly(f, { agl: 60, speed: 40, x: tank.x, z: tank.z + 60 });
  f.pick(2); f.ticks(1);
  fly(f, { agl: 60, speed: 40, x: tank.x, z: tank.z + 60 });
  const hp = tank.hp;
  const events = []; f.listen(s => events.push(...s.events));
  // Drop straight onto the tank: the next pylon right above the hull centre,
  // the jet's forward motion killed for this one release.
  Object.assign(f.jet, { vz: 0, speed: 0, airspeed: 0, x: tank.x, z: tank.z });
  const station = mountPose(f.jet, 'driver', 'bombs', { side: f.bombs().side }).origin;
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

const r = n => Math.round(n);
console.log(`Jet bombs: infantry at 4/8/11 m -${measured.infantry.map(r).join('/')}, jeep at 12 m -${r(measured.jeep12m)}, tank at 7 m -${r(measured.tankSplash7m)}, `
  + `direct deck hit -${r(measured.tankDirect)}, crater ${measured.crater} blocks (${measured.craterDepth.toFixed(1)} m deep); fire ${measured.cells} cells to `
  + `${measured.spread.toFixed(1)} m, burn kill in ${measured.burnKill.toFixed(2)} s, jeep in the fire -${measured.jeepBurn.toFixed(1)}/s.`);
console.log('Jet bombs: contract v5 (separate missile and bomb mounts), both stores selectable in the air with separate ammo and re-arm, airborne-only release with the airframe velocity, predicted impact, 13 m blast, AT deck hit, crater, and the burning field (credit, no team damage, tanks spared) passed');
