// Mobile AA (docs/conquest.md "Mobile AA"): the `aa` hull on the tank's
// running gear with medium armour, a driver who lays the twin 35 mm flak and a
// commander on the roof .50. The flak's radar proximity fuse bursts beside an
// airborne enemy aircraft (never a friendly, a landed one or a ground hull),
// the guns alternate and overheat, Frontier parks one AA per HQ, bots crew it
// while the enemy flies and shoot the sky with it, and the client draws the
// radar scope and the lead pipper from the snapshot rows alone.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { AA_BOT, aaCoverFlag, enemyAirThreats, stickyAaCover } from '../server/bot-aa.js';
import { applyMountedCombat, pickBotThreat } from '../server/bot-vehicle-combat.js';
import { flakTrigger, flakTargets } from '../server/sim/flak-fuse.js';
import {
  ARMOR_CLASSES, CONQUEST_CONTRACT_VERSION, COUNTERMEASURES, VEHICLE_TYPE_IDS, VEHICLE_WEAPON_META, seatWeaponList,
  vehicleHullType, vehicleMountOrder,
} from '../shared/conquest-contract.js';
import { ARMOR_MATRIX, armorMultiplier } from '../shared/vehicle-armor.js';
import {
  VEHICLE_DEFS, VEHICLE_MASS, VEHICLE_RAM, VEHICLE_RULES, VEHICLE_WEAPONS, WALL_CRASH_RULES, CONQUEST_ROCKET_PROFILE, mountPose, vehicleMaxHp,
} from '../shared/vehicle-defs.js';
import { AA_RADAR, AA_RULES } from '../shared/vehicle-handling/aa.js';
import { TANK_RULES, stepTankDrive } from '../shared/vehicle-handling/tank.js';
import { getMapMeta } from '../shared/worlddata.js';
import { mulberry32 } from '../shared/noise.js';
import { aaRadarModel, aaTrackTarget, rowAirborne } from '../public/js/ui/conquest/aa-hud.js';
import { reticleModel } from '../public/js/ui/conquest-hud-state.js';
import { cameraPose, createProjector } from '../public/js/ui/conquest/projection.js';
import { makeAaModel } from '../public/js/vehicles/models/aa.js';
import * as THREE from '../public/js/vendor/three.module.js';
import { VehicleController } from '../public/js/session/vehicle-controller.js';

const TICK = 1000 / 60;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok - ${name}`); };

function fixture(spawns) {
  const dimensions = { sx: 640, sy: 64, sz: 640 }, frames = [];
  const world = { dimensions, getBlock: (x, y, z) => y === 0 ? 3 : 0, setBlock: () => true, findSpawns: () => [{ x: 20, y: 1, z: 20 }] };
  const game = new GameEngine({ mode: 'conquest', world, broadcast: frame => frames.push(frame),
    mapMeta: { id: 'frontier', dimensions, spawns: { conquest: { alpha: [{ x: 20, y: 1, z: 20 }], bravo: [{ x: 30, y: 1, z: 20 }] } },
      conquest: { flags: [], bases: {}, vehicleSpawns: spawns } } });
  const player = (id, team, extra = {}) => {
    game.addClient(id, id);
    const p = game.entities.get(id);
    game.mode.policy.setLobbyTeam(p, team);
    Object.assign(p, { hp: 100, armor: 0, spawnProtectedUntil: 0, spawnProtected: false, grounded: true, input: { keys: {}, yaw: 0, pitch: 0 }, ...extra });
    return p;
  };
  const vehicle = id => game.vehicles.vehicles.get(id);
  const board = (p, id, seatId) => {
    const v = vehicle(id);
    Object.assign(p, { x: v.x, y: v.y, z: v.z });
    game.applyInput(p.id, { keys: {}, yaw: v.yaw, pitch: 0, vehicleAction: { type: 'enter', vehicleId: id, seatId } });
    assert.equal(p.vehicleSeatId, seatId);
    return p;
  };
  const events = kind => frames.flatMap(frame => frame.events).filter(event => event.kind === kind);
  return { game, frames, player, vehicle, board, events };
}
const flak = f => [...f.game.projectiles.active.values()].filter(r => r.weaponKey === 'flak35');
/** World aim from the AA's gun trunnion to a point. */
const aimAt = (f, v, point) => {
  const o = f.game.vehicles.mountPose(v, 'driver', 'main').pivot, d = point.map((n, i) => n - o[i]);
  return { yaw: Math.atan2(-d[0], -d[2]), pitch: Math.atan2(d[1], Math.hypot(d[0], d[2])) };
};
/** Keep a helicopter hovering in place. */
const hover = (v, x, y, z) => Object.assign(v, { x, y, z, vx: 0, vy: 0, vz: 0, speed: 0, grounded: false, rotorSpeed: 1, pitch: 0, roll: 0 });

test('contract v6: `aa` appended, a tank hull variant with its own seats, mounts, medium armour and smoke', () => {
  assert.equal(CONQUEST_CONTRACT_VERSION, 6);
  // Appended after `jeep_at`; later v6 hulls (the patrol boat) come after it.
  assert.equal(VEHICLE_TYPE_IDS.indexOf('aa'), VEHICLE_TYPE_IDS.indexOf('jeep_at') + 1);
  assert.equal(ARMOR_CLASSES.at(-1), 'medium');
  assert.equal(vehicleHullType('aa'), 'tank');
  assert.deepEqual(vehicleMountOrder('aa'), ['driver:main', 'commander:rws']);
  assert.deepEqual(seatWeaponList('aa', 'driver'), [{ mount: 'main', weapon: 'flak35' }]);
  assert.deepEqual(seatWeaponList('aa', 'commander'), [{ mount: 'rws', weapon: 'hmg' }]);
  assert.equal(COUNTERMEASURES.aa, 'smoke');
  const meta = VEHICLE_WEAPON_META.flak35;
  assert.deepEqual([meta.kind, meta.cls, meta.speed, meta.rate], ['shell', 'aa', 320, 8]);
  const def = VEHICLE_DEFS.aa;
  assert.deepEqual([def.handling, def.armor, def.hp, def.countermeasure, def.openCrew], ['tracked', 'medium', 600, 'smoke', false]);
  assert.equal(def.armorModel, undefined, 'no tank plate model: the AT facing zones only');
  assert.deepEqual(def.seats.map(s => [s.id, s.drives, s.exposed, s.mount]), [['driver', true, false, 'hull'], ['commander', false, true, 'turret']]);
  assert.ok(def.mounts.main.turret && def.mounts.main.sides.length === 2, 'twin guns on one turret mount');
  assert.ok(def.mounts.main.pitchLimit[1] > 1.3, 'the guns elevate to 77 degrees');
  assert.equal(vehicleMaxHp('aa'), 600);
  assert.ok(VEHICLE_MASS.jeep < VEHICLE_MASS.aa && VEHICLE_MASS.aa < VEHICLE_MASS.tank);
  assert.ok(VEHICLE_RAM.aa && !VEHICLE_RAM.aa.classes.masonry, 'the AA flattens fences but not masonry');
  assert.ok(WALL_CRASH_RULES.aa.maxShare > WALL_CRASH_RULES.tank.maxShare);
  assert.equal(VEHICLE_RULES.aa.speed, AA_RULES.speed);
  assert.equal(AA_RULES.turretForward, TANK_RULES.turretForward, 'the ring sits where turretLocal expects it');
});

test('armour: medium sits between light and heavy; flak wears aircraft down and barely scratches armour', () => {
  for (const cls of Object.keys(ARMOR_MATRIX)) {
    const row = ARMOR_MATRIX[cls];
    assert.ok(row.medium <= row.light + 1e-9 && row.medium >= row.heavy - 1e-9, `${cls}: light >= medium >= heavy`);
  }
  assert.equal(armorMultiplier('at', 'medium', 'rear'), 1.5, 'AT facing zones apply to medium');
  assert.equal(armorMultiplier('at', 'medium', 'front'), 0.75);
  const w = VEHICLE_WEAPONS.flak35, direct = w.damage + w.splash;
  const hits = type => Math.ceil(vehicleMaxHp(type) / (direct * armorMultiplier('aa', VEHICLE_DEFS[type].armor)));
  // About one heat bar of hits each, so a crew needs two bursts and an aircraft has time to break off.
  assert.ok(hits('helicopter') >= 20 && hits('helicopter') <= 30 && hits('plane') >= 14 && hits('plane') <= 22,
    `aircraft take a sustained burst (${hits('helicopter')}, ${hits('plane')} direct hits)`);
  assert.ok(hits('tank') >= 100, `a tank shrugs it off (${hits('tank')})`);
  assert.ok(hits('jeep') >= 12, `a jeep takes a long burst (${hits('jeep')})`);
  // The Engineer's RX-8 (380 AT) kills it in two side hits.
  const rocket = CONQUEST_ROCKET_PROFILE.hullDirect + CONQUEST_ROCKET_PROFILE.hullSplash;
  assert.equal(Math.ceil(vehicleMaxHp('aa') / (rocket * armorMultiplier('at', 'medium', 'side'))), 2);
  // Sustained fire fills the heat bar in about three seconds (cooling runs while firing).
  const seconds = 1 / (VEHICLE_WEAPON_META.flak35.rate * w.heatPerShot - w.coolPerSecond);
  assert.ok(seconds > 2.8 && seconds < 3.6, `overheat after ${seconds.toFixed(2)} s`);
});

test('handling: the AA drives on its own tracked rules, a little quicker than the tank', () => {
  const tank = { speed: 0, yaw: 0 }, aa = { speed: 0, yaw: 0 };
  for (let i = 0; i < 600; i++) { stepTankDrive(tank, { throttle: 1 }, 1 / 60); stepTankDrive(aa, { throttle: 1 }, 1 / 60, AA_RULES); }
  assert.ok(Math.abs(tank.speed - TANK_RULES.speed) < 0.01 && Math.abs(aa.speed - AA_RULES.speed) < 0.01);
  assert.ok(AA_RULES.speed > TANK_RULES.speed);
  const f = fixture([{ id: 'aa', type: 'aa', team: 'alpha', x: 300, y: 1, z: 400, yaw: 0 }]);
  const v = f.vehicle('aa'), driver = f.board(f.player('driver', 'alpha'), 'aa', 'driver');
  for (let i = 0; i < 360; i++) { f.game.applyInput(driver.id, { keys: { forward: true }, yaw: 0, pitch: 0, vehicleThrottle: 1 }); f.game.step(TICK); }
  assert.ok(v.speed > TANK_RULES.speed + 0.5 && v.speed <= AA_RULES.speed + 1e-6, `the hull runs at the AA's top speed (${v.speed.toFixed(2)})`);
});

test('the twin guns elevate high, alternate left and right, overheat after a heat bar and lock out', () => {
  const f = fixture([{ id: 'aa', type: 'aa', team: 'alpha', x: 300, y: 1, z: 400, yaw: 0 }]);
  const v = f.vehicle('aa'), driver = f.board(f.player('driver', 'alpha'), 'aa', 'driver');
  const up = { yaw: 0, pitch: 1.3 };
  for (let i = 0; i < 90; i++) { f.game.applyInput(driver.id, { keys: {}, ...up }); f.game.step(TICK); }
  assert.ok(Math.abs(v.turretPitch - 1.3) < 0.02, `the guns reach 1.3 rad (${v.turretPitch.toFixed(3)})`);
  const xs = [];
  const state = () => f.game.vehicles.mounts.state(v, 'main');
  let ticks = 0;
  while (!state().overheated && ticks < 600) {
    const before = new Set(flak(f).map(r => r.id));
    f.game.applyInput(driver.id, { keys: {}, ...up, wantFire: true }); f.game.step(TICK); ticks++;
    for (const r of flak(f)) if (!before.has(r.id) && xs.length < 4) xs.push(r.flakOrigin[0] - v.x);
  }
  assert.ok(state().overheated, 'the guns overheat');
  assert.ok(ticks / 60 > 2.8 && ticks / 60 < 3.6, `after about three seconds of fire (${(ticks / 60).toFixed(2)} s)`);
  assert.ok(xs[0] * xs[1] < 0 && xs[1] * xs[2] < 0, `shots alternate between the guns (${xs.map(x => x.toFixed(2))})`);
  const count = flak(f).length;
  for (let i = 0; i < 60; i++) { f.game.applyInput(driver.id, { keys: {}, ...up, wantFire: true }); f.game.step(TICK); }
  assert.ok(flak(f).length <= count, 'no shots while locked out');
  const row = f.frames.at(-1).vehicles.find(r => r.id === 'aa');
  assert.equal(row.type, 'aa'); assert.equal(row.mounts.length, 2); assert.equal(row.mounts[0][3], 100, 'the row reports the lockout');
  assert.ok(Number.isFinite(row.turretYaw) && row.turretPitch > 1, 'tracked rows carry the turret');
});

test('flak fuse: bursts beside an airborne enemy aircraft, ignores friendlies and landed aircraft', () => {
  // Unit: the first segment point within the fuse radius of the hull boxes.
  const heli = { id: 'h', type: 'helicopter', team: 'bravo', hp: 650, x: 0, y: 50, z: -150, yaw: 0, grounded: false };
  assert.deepEqual(flakTargets(new Map([['h', heli]]), 'alpha').map(v => v.id), ['h']);
  assert.deepEqual(flakTargets(new Map([['h', heli]]), 'bravo'), [], 'own aircraft are not targets');
  assert.deepEqual(flakTargets(new Map([['h', { ...heli, grounded: true }]]), 'alpha'), [], 'landed aircraft are not targets');
  const pass = (offset, proximity = 4) => flakTrigger([offset, 51.5, -100], [offset, 51.5, -200], [heli], proximity);
  const near = pass(4);
  assert.ok(near && near.distance <= 4 && near.point[2] > -152, `a pass 4 m off the centreline fuses (${near?.distance.toFixed(2)})`);
  assert.equal(pass(9), null, 'a pass 9 m off does not');

  // Integrated: a shell aimed beside a hovering enemy helicopter bursts short of contact and hurts it.
  const at = [300, 60, 250];
  const f = fixture([{ id: 'aa', type: 'aa', team: 'alpha', x: 300, y: 1, z: 400, yaw: 0 },
    { id: 'enemy', type: 'helicopter', team: 'bravo', x: 300, y: 1, z: 250, yaw: 0 },
    { id: 'friend', type: 'helicopter', team: 'alpha', x: 340, y: 1, z: 250, yaw: 0 }]);
  const v = f.vehicle('aa'), enemy = f.vehicle('enemy'), friend = f.vehicle('friend');
  const driver = f.board(f.player('driver', 'alpha'), 'aa', 'driver');
  const pin = () => { hover(enemy, ...at); hover(friend, 340, 60, 250); };
  // Nose-on, aimed 3.2 m right of the centreline: past the stub wings, inside the fuse radius.
  const aim = () => { pin(); const a = aimAt(f, v, [at[0] + 3.2, at[1] + 1.6 + 0.6, at[2]]); return a; };
  for (let i = 0; i < 120; i++) { f.game.applyInput(driver.id, { keys: {}, ...aim() }); f.game.step(TICK); }
  const hp = enemy.hp;
  f.game.applyInput(driver.id, { keys: {}, ...aim(), wantFire: true }); f.game.step(TICK);
  const [shell] = flak(f);
  assert.ok(shell?.flak, 'the shell carries the fuse');
  for (let i = 0; i < 120 && f.game.projectiles.active.has(shell.id); i++) { f.game.applyInput(driver.id, { keys: {}, ...aim() }); f.game.step(TICK); }
  assert.ok(!f.game.projectiles.active.has(shell.id), 'the shell burst');
  assert.ok(shell.flakBurst?.vehicleId === 'enemy', 'by the proximity fuse');
  assert.ok(hp - enemy.hp > 5 && hp - enemy.hp < VEHICLE_WEAPONS.flak35.splash, `the near miss hurts less than a hit (${(hp - enemy.hp).toFixed(1)})`);
  assert.equal(friend.hp, vehicleMaxHp('helicopter'));

  // A shell laid through a hovering friendly passes it by.
  const g = fixture([{ id: 'aa', type: 'aa', team: 'alpha', x: 300, y: 1, z: 400, yaw: 0 },
    { id: 'friend', type: 'helicopter', team: 'alpha', x: 300, y: 1, z: 250, yaw: 0 }]);
  const gv = g.vehicle('aa'), gf = g.vehicle('friend'), gd = g.board(g.player('driver', 'alpha'), 'aa', 'driver');
  const gaim = () => { hover(gf, ...at); return aimAt(g, gv, [at[0] + 3.2, at[1] + 2.2, at[2]]); };
  for (let i = 0; i < 120; i++) { g.game.applyInput(gd.id, { keys: {}, ...gaim() }); g.game.step(TICK); }
  g.game.applyInput(gd.id, { keys: {}, ...gaim(), wantFire: true }); g.game.step(TICK);
  const [passing] = flak(g);
  for (let i = 0; i < 120 && g.game.projectiles.active.has(passing.id); i++) { g.game.applyInput(gd.id, { keys: {}, ...gaim() }); g.game.step(TICK); }
  assert.equal(passing.flakBurst, undefined, 'no fuse on a friendly');
  assert.equal(gf.hp, vehicleMaxHp('helicopter'));
});

test('a hovering attack helicopter caught in the open takes most of a heat bar to bring down', () => {
  const at = [300, 50, 280];
  const f = fixture([{ id: 'aa', type: 'aa', team: 'alpha', x: 300, y: 1, z: 400, yaw: 0 },
    { id: 'enemy', type: 'helicopter', team: 'bravo', x: 300, y: 1, z: 280, yaw: Math.PI / 2 }]);
  const v = f.vehicle('aa'), enemy = f.vehicle('enemy');
  const driver = f.board(f.player('driver', 'alpha'), 'aa', 'driver');
  const aim = () => { if (enemy.hp > 0) hover(enemy, ...at); return aimAt(f, v, [at[0], at[1] + 1.6 + 0.4, at[2]]); };
  for (let i = 0; i < 120; i++) { f.game.applyInput(driver.id, { keys: {}, ...aim() }); f.game.step(TICK); }
  let downAt = null;
  for (let i = 0; i < 220; i++) {
    f.game.applyInput(driver.id, { keys: {}, ...aim(), wantFire: true }); f.game.step(TICK);
    if (downAt == null && !(enemy.hp > 0)) downAt = i / 60;
  }
  // Every shell laid true: it still lasts well past two seconds of fire (bot crews, with their aim error, need about six).
  assert.ok(downAt != null && downAt > 2.4, `the helicopter falls after ${downAt?.toFixed(2)} s of fire`);
});

test('Frontier parks one AA per HQ in the motor pool, point-mirrored, with a pickup and an exit route', () => {
  const meta = getMapMeta('frontier'), spawns = meta.conquest.vehicleSpawns.filter(s => s.type === 'aa');
  assert.deepEqual(spawns.map(s => [s.id, s.team]).sort(), [['alpha-aa', 'alpha'], ['bravo-aa', 'bravo']]);
  const [a, b] = ['alpha-aa', 'bravo-aa'].map(id => spawns.find(s => s.id === id));
  assert.ok(Math.abs(a.x + b.x - meta.dimensions.sx) < 1e-9 && Math.abs(a.z + b.z - meta.dimensions.sz) < 1e-9);
  assert.ok(a.walkingRoute.length >= 3 && a.exitRoute.length === 3);
});

test('bots: the commander crews the AA only while the enemy flies; its gunner hunts the sky to radar range', () => {
  const vehicles = new Map([
    ['eh', { id: 'eh', type: 'helicopter', team: 'bravo', hp: 650, x: 100, z: 100, seatOccupants: { driver: 'x' } }],
    ['ep', { id: 'ep', type: 'plane', team: 'bravo', hp: 450, x: 0, z: 0, seatOccupants: {} }],
    ['ot', { id: 'ot', type: 'tank', team: 'bravo', hp: 1000, x: 0, z: 0, seatOccupants: { driver: 'y' } }],
  ]);
  assert.deepEqual(enemyAirThreats(vehicles, 'alpha').map(v => v.id), ['eh'], 'crewed enemy aircraft only');
  const flags = [{ id: 'A', owner: 'alpha', x: 90, z: 120 }, { id: 'B', owner: 'alpha', x: 400, z: 400 }, { id: 'C', owner: 'bravo', x: 100, z: 100 }];
  assert.equal(aaCoverFlag(flags, 'alpha', enemyAirThreats(vehicles, 'alpha'), null).id, 'A', 'the own flag under the enemy aircraft');
  assert.equal(aaCoverFlag(flags, 'alpha', [], flags[2]), flags[2], 'no air threat: the focus flag');
  // The cover flag is held while the jet crosses the map, then re-chosen.
  const jet = x => [{ id: 'j', type: 'plane', team: 'bravo', hp: 450, x, z: x }];
  let cover = stickyAaCover(null, flags, 'alpha', jet(100), 0, flags[2]);
  assert.equal(cover.flag.id, 'A');
  cover = stickyAaCover(cover.held, flags, 'alpha', jet(400), 5000, flags[2]);
  assert.equal(cover.flag.id, 'A', 'held while the jet crosses over B');
  cover = stickyAaCover(cover.held, flags, 'alpha', jet(400), AA_BOT.coverHoldMs + 1, flags[2]);
  assert.equal(cover.flag.id, 'B', 'then re-chosen under the jet');
  const lost = flags.map(f => f.id === 'B' ? { ...f, owner: 'bravo' } : f);
  cover = stickyAaCover(cover.held, lost, 'alpha', jet(400), AA_BOT.coverHoldMs + 2, flags[2]);
  assert.equal(cover.flag.id, 'A', 'a held flag the team lost is dropped at once');
  assert.deepEqual(stickyAaCover(null, flags, 'alpha', [], 0, flags[2]), { flag: flags[2], held: null }, 'no threat, no hold: the focus flag');

  // Mounted combat: a bot in the AA driver seat takes on a helicopter 300 m out, behind it, and fires.
  const floor = 2, dims = { sx: 640, sy: 160, sz: 640 };
  const spawns = { alpha: [{ x: 300, y: floor, z: 280 }], bravo: [{ x: 300, y: floor, z: 80 }] };
  const game = new GameEngine({ mode: 'conquest', world: { mapId: 'frontier', dimensions: dims, getBlock: (x, y, z) => y < floor ? 3 : 0,
    heightAt: () => floor - 1, findSpawns: () => spawns.alpha, setBlock: () => false },
  mapMeta: { id: 'frontier', dimensions: dims, spawns: { conquest: spawns }, conquest: { flags: [], bases: {}, vehicleSpawns: [
    { id: 'aa', team: 'alpha', type: 'aa', x: 300, y: floor, z: 280, yaw: 0 },
    { id: 'heli', team: 'bravo', type: 'helicopter', x: 300, y: floor, z: 100, yaw: 0 }] } } });
  game.now = 100000;
  game.addBot('bot-0'); game.addClient('pilot', 'Pilot');
  const p = game.entities.get('bot-0'), pilot = game.entities.get('pilot');
  Object.assign(p, { x: 300, y: floor, z: 280, spawnProtectedUntil: 0 }); Object.assign(pilot, { x: 300, y: floor, z: 100, spawnProtectedUntil: 0 });
  const aa = game.vehicles.vehicles.get('aa'), heli = game.vehicles.vehicles.get('heli');
  assert(game.vehicles.enter(pilot, 'heli', 'driver')); assert(game.vehicles.enter(p, 'aa', 'driver'));
  // Hovering 300 m behind the AA (south) and 70 m up: outside any forward field of view.
  const pin = () => hover(heli, 300, floor + 70, 580);
  pin();
  const br = { id: p.id, index: 0, rng: mulberry32(7), skill: 0.85, difficulty: 'hard', personality: 'skirmisher', reactionScale: 1, seq: 0 };
  const plain = pickBotThreat(game, p, { difficulty: 'hard' }, { observer: { x: aa.x, eyeY: aa.y + 2.5, z: aa.z, yaw: 0, pitch: 0 }, ignoreVehicleId: 'aa' });
  assert.ok(!plain?.target, 'without the radar the helicopter behind is unseen');
  let fired = false, target = null;
  for (let i = 0; i < 60 * 8; i++) {
    pin();
    const inp = { seq: ++br.seq, keys: {}, yaw: p.yaw, pitch: p.pitch, wantFire: false };
    const result = applyMountedCombat(game, br, p, aa, 'driver', game.now, 1 / 60, inp, {});
    if (result?.target) target = result.target;
    game.applyInput(p.id, inp); game.step(TICK);
    if (inp.wantFire) fired = true;
  }
  assert.equal(target?.vehicleId, 'heli', 'the AA bot tracks the helicopter');
  assert.ok(fired, 'and opens fire');
  assert.ok(heli.hp < vehicleMaxHp('helicopter'), `the flak lands (${Math.round(heli.hp)} hp left)`);
  assert.equal(AA_BOT.airSightRange, AA_RADAR.range);
});

test('bots on Frontier: no AA crew without enemy aircraft, an AA crew (before the jet) once the enemy flies', () => {
  const meta = getMapMeta('frontier');
  const game = new GameEngine({ mode: 'conquest', world: undefined, mapMeta: meta, broadcast: () => {} });
  // 12 bots a side: a crew budget of three (tank, attack helicopter, then the AA before the jet).
  const bots = attachBots(game, 24);
  game.step(TICK);
  const replan = () => { game.mode.policy._view = null; bots.commander.viewAt = -1; bots.commander.plan(game.now); };
  const crewTypes = team => [...bots.commander.teams.get(team).crews.values()].map(c => `${game.vehicles.vehicles.get(c.vehicleId)?.type}:${c.seatId}`);
  replan();
  assert.ok(!crewTypes('alpha').some(t => t.startsWith('aa:')), `no air threat: ${crewTypes('alpha')}`);
  // A bravo bot takes the attack helicopter's seat.
  const heli = game.vehicles.vehicles.get('bravo-helicopter');
  const pilot = [...game.entities.values()].find(e => e.bot && game.mode.teamFor(e) === 'bravo');
  Object.assign(pilot, { x: heli.x, y: heli.y, z: heli.z });
  assert(game.vehicles.enter(pilot, heli.id, 'driver'));
  replan();
  assert.ok(crewTypes('alpha').includes('aa:driver'), `the enemy flies: ${crewTypes('alpha')}`);
  const crew = [...bots.commander.teams.get('alpha').crews.entries()].find(([, c]) => c.vehicleId === 'alpha-aa' && c.seatId === 'driver');
  const assignment = bots.commander.crewFor(crew[0]);
  assert.equal(assignment.flag?.owner ?? 'alpha', 'alpha', 'the AA covers an own flag (or the focus flag)');
  // The crew bot boards; then the pilot gets out (or is shot down): the AA crew stays for AA_BOT.holdMs, then stands down.
  const aaHull = game.vehicles.vehicles.get('alpha-aa'), gunnerBot = game.entities.get(crew[0]);
  Object.assign(gunnerBot, { x: aaHull.x, y: aaHull.y, z: aaHull.z });
  assert(game.vehicles.enter(gunnerBot, aaHull.id, 'driver'));
  assert(game.vehicles.exit(pilot));
  replan();
  assert.ok(crewTypes('alpha').includes('aa:driver'), `the AA crew holds after the threat: ${crewTypes('alpha')}`);
  const later = game.now + AA_BOT.holdMs + 1000;
  game.mode.policy._view = null; bots.commander.viewAt = -1; bots.commander.plan(later);
  assert.ok(!crewTypes('alpha').some(t => t.startsWith('aa:')), `and stands down once the hold ran out: ${crewTypes('alpha')}`);
  bots.dispose(); game.stop();
});

test('bots on Frontier, 8 a side: the AA driver takes the crew headroom past the budget, after the tank and the helicopter, while the enemy flies near', () => {
  const meta = getMapMeta('frontier');
  const game = new GameEngine({ mode: 'conquest', world: undefined, mapMeta: meta, broadcast: () => {} });
  // 16 bots: a budget of ceil(8 / 4) = 2 (the tank and the attack helicopter), a cap of ceil(8 / 3) = 3.
  const bots = attachBots(game, 16);
  game.step(TICK);
  const replan = () => { game.mode.policy._view = null; bots.commander.viewAt = -1; bots.commander.plan(game.now); };
  const crewTypes = team => [...bots.commander.teams.get(team).crews.values()].map(c => `${game.vehicles.vehicles.get(c.vehicleId)?.type}:${c.seatId}`).sort();
  replan();
  assert.deepEqual(crewTypes('alpha'), ['helicopter:driver', 'tank:driver'], 'no air threat: the budget goes to the tank and the helicopter');
  const heli = game.vehicles.vehicles.get('bravo-helicopter');
  const pilot = [...game.entities.values()].find(e => e.bot && game.mode.teamFor(e) === 'bravo');
  Object.assign(pilot, { x: heli.x, y: heli.y, z: heli.z });
  assert(game.vehicles.enter(pilot, heli.id, 'driver'));
  replan();
  assert.deepEqual(crewTypes('alpha'), ['helicopter:driver', 'tank:driver'], 'a crewed enemy helicopter on its pad: no AA past the budget');
  const aa = game.vehicles.vehicles.get('alpha-aa') ?? [...game.vehicles.vehicles.values()].find(v => v.type === 'aa' && v.team === 'alpha');
  Object.assign(heli, { x: aa.x + AA_BOT.headroomRange + 40, z: aa.z, y: aa.y + 60, grounded: false });
  replan();
  assert.deepEqual(crewTypes('alpha'), ['helicopter:driver', 'tank:driver'], 'the enemy flies out of AA range: still no AA past the budget');
  Object.assign(heli, { x: aa.x + AA_BOT.headroomRange - 40 });
  replan();
  assert.deepEqual(crewTypes('alpha'), ['aa:driver', 'helicopter:driver', 'tank:driver'], 'the enemy flies within AA range: the AA driver joins them inside the cap');
  assert.equal(bots.commander.teams.get('alpha').crewBudget, 2, 'the budget itself is unchanged');
  assert.ok(!crewTypes('alpha').includes('aa:commander') && !crewTypes('alpha').includes('plane:driver'), 'no gunner or jet beyond the headroom');
  bots.dispose(); game.stop();
});

test('client: radar scope, track and lead from snapshot rows; the model builds both guns', () => {
  const self = { id: 'aa', type: 'aa', team: 'alpha', x: 0, y: 1, z: 0, yaw: 0, turretYaw: 0, turretPitch: 0.3, hp: 600,
    mounts: [[0, 0.3, -1, 46, 0], [0, 0, -1, 0, 0]], seatOccupants: { driver: 'me' } };
  const rows = [self,
    { id: 'eh', type: 'helicopter', team: 'bravo', hp: 600, x: 0, y: 90, z: -300, vx: 20, vy: 0, vz: 0, grounded: false },
    { id: 'ej', type: 'plane', team: 'bravo', hp: 450, x: -380, y: 100, z: 0, grounded: false },
    { id: 'far', type: 'plane', team: 'bravo', hp: 450, x: 900, y: 100, z: 0, grounded: false },
    { id: 'landed', type: 'helicopter', team: 'bravo', hp: 650, x: 50, y: 1, z: 0 },
    { id: 'own', type: 'helicopter', team: 'alpha', hp: 650, x: 100, y: 50, z: 100, grounded: false },
    { id: 'tank', type: 'tank', team: 'bravo', hp: 1000, x: 30, y: 1, z: -30 }];
  assert.equal(rowAirborne(rows[4]), false); assert.equal(rowAirborne(rows[1]), true);
  const radar = aaRadarModel(self, rows, { selfTeam: 'alpha', viewYaw: 0 });
  assert.deepEqual(radar.contacts.map(c => [c.id, c.enemy]).sort(), [['eh', true], ['ej', true], ['own', false]]);
  assert.equal(radar.hostile, 2);
  const eh = radar.contacts.find(c => c.id === 'eh'), ej = radar.contacts.find(c => c.id === 'ej');
  assert.ok(Math.abs(eh.rel) < 0.01, 'dead ahead'); assert.ok(Math.abs(ej.rel - Math.PI / 2) < 0.01, 'the jet is on the left (+yaw)');
  const pose = mountPose(self, 'driver', 'main');
  assert.equal(aaTrackTarget(self, pose, rows, 'alpha')?.id, 'eh', 'the gun line tracks the helicopter ahead');
  const projector = createProjector(cameraPose({ x: 0, y: 6, z: 10, yaw: 0, pitch: 0.3, aspect: 16 / 10 }), 1440, 900);
  const seat = VEHICLE_DEFS.aa.seats[0];
  const m = reticleModel({ row: self, seat }, { projector, vehicles: rows, selfTeam: 'alpha', viewYaw: 0 });
  assert.equal(m.kind, 'aa'); assert.equal(m.heat, 0.46); assert.equal(m.label, '35MM FLAK');
  assert.equal(m.track.id, 'eh'); assert.ok(m.track.range > 300 && m.track.range < 330);
  assert.ok(m.track.lead.x > m.track.box.x, 'the lead pipper sits ahead of a helicopter crossing right');
  assert.ok(m.track.lead.y < m.track.box.y, 'and above it for the shell drop');
  const model = makeAaModel({ team: 'alpha' });
  assert.equal(model.mounts['driver:main'].muzzles.length, 2);
  assert.ok(model.mounts['commander:rws'] && model.radar && model.seatAnchors.commander);
  model.animate(0.5, {});
  assert.ok(model.radar.rotation.y !== 0, 'the search radar turns');
  // The look reaches each seat's gun elevation: the driver's 35 mm to 1.35, the commander's .50 to 1.1.
  const controller = new VehicleController({ camera: new THREE.PerspectiveCamera(70, 16 / 9), eventTarget: null, raycast: () => null });
  const up = (seatId, id) => {
    controller.sync({ self: { id, state: 'alive', hp: 100, team: 'alpha', x: 0, y: 1, z: 0, vehicleId: 'aa', vehicleSeatId: seatId },
      vehicles: [{ ...self, seatOccupants: { [seatId]: id } }], enabled: true });
    return controller.controls({}, { dx: 0, dy: -5 }).pitch;
  };
  assert.ok(Math.abs(up('driver', 'me') - VEHICLE_DEFS.aa.mounts.main.pitchLimit[1]) < 1e-9, 'driver look up to the guns\' limit');
  assert.ok(Math.abs(up('commander', 'cm') - VEHICLE_DEFS.aa.mounts.rws.pitchLimit[1]) < 1e-9, 'commander look up to the .50\'s limit');
  controller.dispose?.();
});

console.log(`conquest AA test: ${passed} passed`);
