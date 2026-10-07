// Conquest v2 locks and countermeasures (spec F4): the Engineer's AX-9 STINGER
// ADS lock on aircraft (the RX-8 AT rocket is dumb-fire), the jet's AA missile lock, line of sight at 10 Hz blocked by smoke,
// proportional-navigation homing on a vehicle id (never Chaos), flares, tank
// smoke, the countermeasure event, row lk/st/cmr and the locker's progress.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { LOCK_RULES, COUNTERMEASURE_RULES, STINGER_RULES, VEHICLE_DEFS, vehicleLocalPoint } from '../shared/vehicle-defs.js';
import { VEHICLE_STATUS, decodeConquestPlayer } from '../shared/conquest-contract.js';
import { SMOKE } from '../shared/smoke-rules.js';

const TICK = 1000 / 60;

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
  const row = id => frames.at(-1)?.vehicles.find(r => r.id === id);
  return { game, frames, player, vehicle, board, events, row };
}
const lookAt = (from, to) => {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
};
/** Hold an aircraft on a scripted path (the test is about locks, not flight). */
function pin(v, { x, y, z, vx = 0, vy = 0, vz = 0 }) {
  Object.assign(v, { x, y, z, vx, vy, vz, speed: Math.hypot(vx, vz), grounded: false, rotorSpeed: 1, pitch: 0, roll: 0 });
}
/** An Engineer holding a launcher (the STINGER by default) down the sights. */
function engineer(f, id, at, weapon = 'stinger') {
  const p = f.player(id, 'alpha', { x: at[0], y: 1, z: at[2] });
  const slot = WEAPON_IDS.indexOf(weapon);
  if (Array.isArray(p.owned)) p.owned = [...p.owned, weapon];
  p.mag[slot] = 1; p.reserve[slot] = weapon === 'stinger' ? 2 : 4;
  Object.assign(p, { weapon: slot, deployT: 0, cooldown: 0 });
  return p;
}
const STINGER = WEAPON_IDS.indexOf('stinger');

// ------------------------------------- Engineer STINGER: lk 1 -> 2 -> 3, homing hit on a crossing helicopter
{
  const f = fixture([{ id: 'heli', type: 'helicopter', team: 'bravo', x: 300, y: 1, z: 200, yaw: 0 }]);
  const heli = f.vehicle('heli'), p = engineer(f, 'eng', [300, 1, 300]);
  p.chaosUpgrades = { rocket: 3 };
  let path = { x: 290, y: 30, z: 220, vx: 12, vy: 0, vz: 0 };
  const center = () => [path.x, path.y + 1.6, path.z];
  const look = () => lookAt([p.eyeX, p.eyeY, p.eyeZ], center());
  const lk = [], progress = [];
  pin(heli, path);
  for (let i = 0; i < 100; i++) {
    f.game.applyInput(p.id, { keys: {}, ...look(), wantAds: true });
    pin(heli, path); f.game.step(TICK);
    path = { ...path, x: path.x + path.vx / 60 };
    lk.push(f.row('heli').lk ?? 0); progress.push(p.lockProgress ?? 0);
  }
  assert(p.ads, 'the Engineer is down the sights');
  // ADS is applied by this tick's movement, so the first lock tick is the next one.
  const startAt = lk.indexOf(1), lockedAt = lk.indexOf(2);
  assert(startAt >= 0 && startAt <= 1, 'locking starts as soon as the sights are up');
  assert(lockedAt > startAt, 'the lock completes');
  const seconds = (lockedAt - startAt + 1) / 60;
  assert(Math.abs(seconds - LOCK_RULES.stinger.seconds) < 0.05, `STINGER lock takes ${LOCK_RULES.stinger.seconds} s (${seconds.toFixed(3)})`);
  assert(lk.slice(startAt, lockedAt).every(value => value === 1), 'lk stays 1 while locking');
  assert(progress.every((value, i) => i === 0 || value >= progress[i - 1]), 'lockProgress rises monotonically');
  assert.equal(p.lockProgress, 1);
  const self = f.frames.at(-1).players.find(r => r.id === 'eng');
  if (self.cq) assert.equal(decodeConquestPlayer(self).lockProgress, 1, 'cq[5] publishes the locker progress');
  // Fire: the missile homes on the vehicle id, never on Chaos rules.
  f.game.applyInput(p.id, { keys: {}, ...look(), wantAds: true, wantFire: true });
  pin(heli, path); f.game.step(TICK); path = { ...path, x: path.x + path.vx / 60 };
  const rocket = [...f.game.projectiles.active.values()].find(r => r.ownerId === 'eng');
  assert(rocket, 'the STINGER launches');
  assert.equal(p.mag[STINGER], 0, 'the launch spends the missile');
  assert.equal(rocket.guidance?.targetId, 'heli'); assert.equal(rocket.chaosLevel, 0); assert.equal(rocket.chaosHoming, false);
  assert.equal(rocket.weaponKey, 'stinger', 'kills credit the STINGER');
  const launch = f.events('projectileLaunch').find(e => e.pid === rocket.id);
  assert.equal(launch.target, 'heli'); assert.equal(launch.vehicleWeapon, 'aaMissile', 'presented like the AA missile'); assert.equal(launch.g, 0);
  const hp = heli.hp;
  let inbound = false;
  for (let i = 0; i < 240 && f.game.projectiles.active.has(rocket.id); i++) {
    f.game.applyInput(p.id, { keys: {}, ...look(), wantAds: true });
    pin(heli, path); f.game.step(TICK); path = { ...path, x: path.x + path.vx / 60 };
    inbound ||= f.row('heli').lk === 3;
  }
  assert(inbound, 'a guided missile in flight sets lk 3 (MISSILE INBOUND for the crew)');
  assert(Math.abs(hp - heli.hp - STINGER_RULES.hullDamage.helicopter) < 1, `proportional navigation brings the STINGER onto the crossing helicopter (${hp - heli.hp})`);
  for (let i = 0; i < 8; i++) { pin(heli, path); f.game.step(TICK); }
  const hit = f.events('vehicle_hit').find(e => e.vehicleId === 'heli');
  assert.equal(hit.cls, 'aa'); assert.equal(hit.eff, 1);
  // Releasing ADS drops the lock and the progress.
  f.game.applyInput(p.id, { keys: {}, ...look(), wantAds: false });
  pin(heli, path); f.game.step(TICK); pin(heli, path); f.game.step(TICK);
  assert.equal(p.lockProgress, 0); assert.equal(f.row('heli').lk ?? 0, 0);
}

// --------------------------------------------- flares within 1 s of launch make the missile miss
{
  const f = fixture([{ id: 'heli', type: 'helicopter', team: 'bravo', x: 300, y: 1, z: 200, yaw: 0 }]);
  const heli = f.vehicle('heli'), pilot = f.board(f.player('pilot', 'bravo'), 'heli', 'driver');
  const p = engineer(f, 'eng', [300, 1, 300]);
  const path = { x: 300, y: 32, z: 215 };
  const look = () => lookAt([p.eyeX, p.eyeY, p.eyeZ], [path.x, path.y + 1.6, path.z]);
  for (let i = 0; i < 100; i++) { f.game.applyInput(p.id, { keys: {}, ...look(), wantAds: true }); pin(heli, path); f.game.step(TICK); }
  assert.equal(f.row('heli').lk, 2);
  assert.equal(f.row('heli').cmr, 100, 'flares are ready');
  f.game.applyInput(p.id, { keys: {}, ...look(), wantAds: true, wantFire: true }); pin(heli, path); f.game.step(TICK);
  const rocket = [...f.game.projectiles.active.values()].find(r => r.ownerId === 'eng');
  assert.equal(rocket.guidance.targetId, 'heli');
  for (let i = 0; i < 30; i++) { pin(heli, path); f.game.step(TICK); }
  f.game.applyInput(pilot.id, { keys: {}, yaw: 0, pitch: 0, vehicleAction: { type: 'cm' } });
  pin(heli, path); f.game.step(TICK);
  const cm = f.events('countermeasure');
  assert.equal(cm.length, 1); assert.deepEqual([cm[0].vehicleId, cm[0].cm], ['heli', 'flares']);
  assert.equal(rocket.guidance.targetId, null, 'flares break the missile track');
  assert(rocket.guidance.decoy, 'the missile chases the flare cloud');
  const row = f.row('heli');
  assert(row.st & VEHICLE_STATUS.flares, 'st carries the flares bit');
  assert.equal(row.cmr, 0, 'readiness restarts');
  const hp = heli.hp;
  for (let i = 0; i < 60; i++) { f.game.applyInput(p.id, { keys: {}, ...look(), wantAds: true }); pin(heli, path); f.game.step(TICK); }
  assert.equal(p.lockProgress, 0, 'no lock is possible while flares burn');
  assert.equal(f.row('heli').lk ?? 0, 0);
  for (let i = 0; i < 180; i++) { f.game.applyInput(p.id, { keys: {}, ...look(), wantAds: true }); pin(heli, path); f.game.step(TICK); }
  assert.equal(f.game.projectiles.active.has(rocket.id), false, 'the decoyed rocket is spent');
  assert.equal(heli.hp, hp, 'the decoyed missile misses');
  assert.equal(f.game.vehicles.action(pilot, { type: 'cm' }), false, 'flares are on an 18 s cooldown');
  // After the decoy window a fresh lock can build again.
  for (let i = 0; i < 60 * 2; i++) { f.game.applyInput(p.id, { keys: {}, ...look(), wantAds: true }); pin(heli, path); f.game.step(TICK); }
  assert(p.lockProgress > 0, 'locking resumes after the 3 s decoy');
  for (let i = 0; i < 60 * 14; i++) { pin(heli, path); f.game.step(TICK); }
  assert.equal(f.row('heli').cmr, 100, 'readiness is back after 18 s');
  assert.equal(f.game.vehicles.action(pilot, { type: 'cm' }), true, 'flares fire again after the cooldown');
}

// ------------------------------------------------ smoke breaks a lock (line of sight at 10 Hz)
{
  const f = fixture([{ id: 'heli', type: 'helicopter', team: 'bravo', x: 300, y: 1, z: 200, yaw: 0 }]);
  const heli = f.vehicle('heli'), p = engineer(f, 'eng', [300, 1, 300]);
  const path = { x: 300, y: 8, z: 220 };
  const look = () => lookAt([p.eyeX, p.eyeY, p.eyeZ], [path.x, path.y + 1.6, path.z]);
  let checks = 0;
  const original = f.game.vehicles.locks.lineOfSight.bind(f.game.vehicles.locks);
  f.game.vehicles.locks.lineOfSight = (...args) => { checks++; return original(...args); };
  for (let i = 0; i < 60; i++) { f.game.applyInput(p.id, { keys: {}, ...look(), wantAds: true }); pin(heli, path); f.game.step(TICK); }
  assert(checks >= 9 && checks <= 11, `line of sight is checked at 10 Hz (${checks} in 1 s)`);
  assert(p.lockProgress > 0.6);
  // A smoke screen between the Engineer and the helicopter.
  f.game.projectiles.smoke.deployField({ id: 'screen', x: 300, y: 4, z: 260, radius: 5, durationMs: 8000 }, f.game.now);
  // The screen blooms over SMOKE.growMs; the lock breaks at the first dense line-of-sight check.
  let brokenAt = -1;
  for (let i = 0; i < 90; i++) {
    f.game.applyInput(p.id, { keys: {}, ...look(), wantAds: true }); pin(heli, path); f.game.step(TICK);
    if (brokenAt < 0 && p.lockProgress === 0) brokenAt = i;
  }
  assert(brokenAt >= 0 && brokenAt <= (SMOKE.growMs + LOCK_RULES.losIntervalMs) / TICK, `smoke breaks the lock (${brokenAt} ticks)`);
  assert.equal(p.lockProgress, 0, 'and keeps it broken while the screen stands');
  assert.equal(f.row('heli').lk ?? 0, 0, 'no lock warning without line of sight');
}

// --------------------------------------------- tank smoke: three fields in the front arc, 25 s cooldown
{
  const f = fixture([{ id: 'tank', type: 'tank', team: 'alpha', x: 200, y: 1, z: 200, yaw: 0 }]);
  const driver = f.board(f.player('driver', 'alpha'), 'tank', 'driver'), tank = f.vehicle('tank');
  const before = f.game.projectiles.smoke.active.size;
  f.game.applyInput(driver.id, { keys: {}, yaw: 0, pitch: 0, vehicleAction: { type: 'cm' } });
  f.game.step(TICK);
  const fields = [...f.game.projectiles.smoke.active.values()].filter(field => field.id.startsWith('cm-tank-'));
  assert.equal(f.game.projectiles.smoke.active.size - before, COUNTERMEASURE_RULES.smoke.fields);
  assert.equal(fields.length, 3);
  for (const field of fields) assert(field.z < tank.z - 3, 'every field lies in the front arc (forward is -Z)');
  assert.deepEqual(f.events('countermeasure').map(e => [e.vehicleId, e.cm]), [['tank', 'smoke']]);
  assert(f.row('tank').st & VEHICLE_STATUS.smoke);
  assert.equal(f.game.vehicles.action(driver, { type: 'cm' }), false, 'smoke is on a 25 s cooldown');
  assert(f.row('tank').cmr < 5);
  const jeep = fixture([{ id: 'j', type: 'jeep', team: 'alpha', x: 200, y: 1, z: 200, yaw: 0 }]);
  const jd = jeep.board(jeep.player('d', 'alpha'), 'j', 'driver');
  assert.equal(jeep.game.vehicles.action(jd, { type: 'cm' }), false, 'the jeep carries no countermeasure');
  jeep.game.step(TICK); assert.equal(jeep.row('j').cmr, undefined);
}

// --------------------------------------- jet AA missile: 350 m / 10 deg / 1.5 s lock and a proximity kill
{
  const f = fixture([{ id: 'jet', type: 'plane', team: 'alpha', x: 300, y: 1, z: 600, yaw: 0 },
    { id: 'heli', type: 'helicopter', team: 'bravo', x: 400, y: 1, z: 100, yaw: 0 }]);
  const jet = f.vehicle('jet'), heli = f.vehicle('heli'), pilot = f.board(f.player('pilot', 'alpha'), 'jet', 'driver');
  assert(f.game.vehicles.action(pilot, { type: 'weapon', index: 1 }), 'select the AA rails');
  let jetPath = { x: 300, y: 50, z: 600, vz: -50 };
  const heliPath = { x: 300, y: 50, z: 230 };
  const fly = (wantFire = false) => {
    f.game.applyInput(pilot.id, { keys: {}, yaw: 0, pitch: 0, wantFire });
    pin(jet, jetPath); jet.yaw = 0; jet.airspeed = 50; pin(heli, heliPath);
    f.game.step(TICK);
    jetPath = { ...jetPath, z: jetPath.z - 50 / 60 };
  };
  fly();
  assert.equal(f.row('heli').lk ?? 0, 0, 'no lock beyond 350 m');
  const lk = [];
  while (jetPath.z - heliPath.z > 300) { fly(); lk.push(f.row('heli').lk ?? 0); }
  for (let i = 0; i < 100; i++) { fly(); lk.push(f.row('heli').lk ?? 0); }
  const startAt = lk.indexOf(1), lockedAt = lk.indexOf(2);
  assert(startAt > 0 && lockedAt > startAt, 'the AA lock builds once inside 350 m');
  // The seeker sits 5 m ahead of the jet root (its nose).
  const rangeAtStart = 600 - 50 / 60 * (startAt + 1) - heliPath.z - 5;
  assert(rangeAtStart <= LOCK_RULES.aaMissile.range + 1.5 && rangeAtStart > LOCK_RULES.aaMissile.range - 3, `locking starts at 350 m (${rangeAtStart.toFixed(1)})`);
  assert(Math.abs((lockedAt - startAt + 1) / 60 - LOCK_RULES.aaMissile.seconds) < 0.05, 'AA lock takes 1.5 s');
  assert.equal(pilot.lockProgress, 1);
  const hp = heli.hp;
  fly(true);
  const missile = [...f.game.projectiles.active.values()].find(r => r.vehicleWeapon === 'aaMissile');
  assert(missile, 'the rail launches'); assert.equal(missile.guidance.targetId, 'heli');
  assert(f.events('shoot').some(e => e.vehicleId === 'jet' && e.mount === 'rails' && e.vehicleWeapon === 'aaMissile'));
  const sequence = [...lk];
  for (let i = 0; i < 180 && f.game.projectiles.active.has(missile.id); i++) { fly(); sequence.push(f.row('heli').lk ?? 0); }
  assert(heli.hp < hp && heli.hp <= hp - 300 * 0.99 || heli.hp === 0, 'the AA missile proximity-fuses on the helicopter (300 AA vs air)');
  const firstOne = sequence.indexOf(1), firstTwo = sequence.indexOf(2), firstThree = sequence.indexOf(3);
  assert(firstOne >= 0 && firstOne < firstTwo && firstTwo < firstThree, 'the target row lk goes 1 -> 2 -> 3');
  for (let i = 0; i < 8; i++) fly();
  const hit = f.events('vehicle_hit').find(e => e.vehicleId === 'heli');
  assert.equal(hit.cls, 'aa');
  // Out of the 10 degree cone: no lock.
  const g = fixture([{ id: 'jet', type: 'plane', team: 'alpha', x: 300, y: 1, z: 600, yaw: 0 },
    { id: 'heli', type: 'helicopter', team: 'bravo', x: 400, y: 1, z: 100, yaw: 0 }]);
  const gp = g.board(g.player('pilot', 'alpha'), 'jet', 'driver');
  g.game.vehicles.action(gp, { type: 'weapon', index: 1 });
  for (let i = 0; i < 30; i++) {
    g.game.applyInput(gp.id, { keys: {}, yaw: 0, pitch: 0 });
    pin(g.vehicle('jet'), { x: 300, y: 50, z: 500, vz: -50 }); g.vehicle('jet').yaw = 0;
    pin(g.vehicle('heli'), { x: 300 + Math.tan(0.25) * 250, y: 50, z: 250 });
    g.game.step(TICK);
  }
  assert.equal(g.row('heli').lk ?? 0, 0, 'a target 14 deg off the nose is outside the cone');
  // The nose gun selected: no lock at all.
  g.game.vehicles.action(gp, { type: 'weapon', index: 0 });
  for (let i = 0; i < 5; i++) {
    g.game.applyInput(gp.id, { keys: {}, yaw: 0, pitch: 0 });
    pin(g.vehicle('jet'), { x: 300, y: 50, z: 500, vz: -50 }); g.vehicle('jet').yaw = 0; pin(g.vehicle('heli'), { x: 300, y: 50, z: 250 });
    g.game.step(TICK);
  }
  assert.equal(gp.lockProgress, 0, 'only the AA rails lock');
}

// ----------------- an Engineer in an open personal-weapons seat locks with the STINGER too
{
  const f = fixture([{ id: 'heli', type: 'helicopter', team: 'bravo', x: 300, y: 1, z: 200, yaw: 0 },
    { id: 'jeep', type: 'jeep', team: 'alpha', x: 300, y: 1, z: 300, yaw: 0 }]);
  const heli = f.vehicle('heli'), p = f.board(engineer(f, 'eng', [300, 1, 300]), 'jeep', 'front-passenger');
  const path = { x: 300, y: 30, z: 220 };
  const look = () => lookAt([p.eyeX, p.eyeY, p.eyeZ], [path.x, path.y + 1.6, path.z]);
  for (let i = 0; i < 100; i++) { f.game.applyInput(p.id, { keys: {}, ...look(), wantAds: true }); pin(heli, path); f.game.step(TICK); }
  assert.equal(p.vehicleSeatId, 'front-passenger');
  assert.equal(p.lockProgress, 1, 'a seated Engineer completes the STINGER lock');
  assert.equal(f.row('heli').lk, 2);
  // Outside the seat's +-100 degree arc the personal weapon (and its seeker) is unavailable.
  const behind = { yaw: Math.PI, pitch: 0.2 };
  for (let i = 0; i < 3; i++) { f.game.applyInput(p.id, { keys: {}, ...behind, wantAds: true }); pin(heli, path); f.game.step(TICK); }
  assert.equal(p.lockProgress, 0, 'no lock outside the personal-weapon arc');
}

// ----------------------------- ground hulls, friendly and grounded aircraft are never lock candidates
{
  const f = fixture([{ id: 'tank', type: 'tank', team: 'bravo', x: 300, y: 1, z: 220, yaw: 0 },
    { id: 'friend', type: 'helicopter', team: 'alpha', x: 340, y: 1, z: 220, yaw: 0 },
    { id: 'parked', type: 'helicopter', team: 'bravo', x: 260, y: 1, z: 220, yaw: 0 }]);
  const p = engineer(f, 'eng', [300, 1, 300]);
  for (const [id, target] of [['tank', vehicleLocalPoint(f.vehicle('tank'), 0, 1.3, 0)], ['friend', [340, 31.6, 220]], ['parked', vehicleLocalPoint(f.vehicle('parked'), 0, 1.6, 0)]]) {
    if (id === 'friend') pin(f.vehicle('friend'), { x: 340, y: 30, z: 220 });
    for (let i = 0; i < 20; i++) {
      f.game.applyInput(p.id, { keys: {}, ...lookAt([p.eyeX, p.eyeY, p.eyeZ], target), wantAds: true });
      if (id === 'friend') pin(f.vehicle('friend'), { x: 340, y: 30, z: 220 });
      f.game.step(TICK);
    }
    assert.equal(p.lockProgress, 0, `${id} is not lockable`);
  }
}

// ----------------------- no lock, no launch; the AT rocket never locks; the jet warning shows STINGER locks
{
  const f = fixture([{ id: 'heli', type: 'helicopter', team: 'bravo', x: 300, y: 1, z: 200, yaw: 0 }]);
  const heli = f.vehicle('heli'), pilot = f.board(f.player('pilot', 'bravo'), 'heli', 'driver');
  const p = engineer(f, 'eng', [300, 1, 300]);
  const path = { x: 300, y: 30, z: 220 };
  const look = () => lookAt([p.eyeX, p.eyeY, p.eyeZ], [path.x, path.y + 1.6, path.z]);
  // Hip fire and an unfinished lock both refuse the trigger: nothing launches, the round stays.
  f.game.applyInput(p.id, { keys: {}, ...look(), wantAds: false, wantFire: true }); pin(heli, path); f.game.step(TICK);
  for (let i = 0; i < 20; i++) { f.game.applyInput(p.id, { keys: {}, ...look(), wantAds: true, wantFire: i % 2 === 0 }); pin(heli, path); f.game.step(TICK); }
  assert(p.lockProgress > 0 && p.lockProgress < 1, 'still locking');
  assert.equal(p.mag[STINGER], 1, 'an unlocked STINGER never fires');
  assert.equal([...f.game.projectiles.active.values()].filter(r => r.ownerId === 'eng').length, 0);
  // The pilot's row warns LOCKING then LOCKED for the STINGER seeker.
  assert.equal(f.row('heli').lk, 1, 'LOCKING on the target row');
  for (let i = 0; i < 90; i++) { f.game.applyInput(p.id, { keys: {}, ...look(), wantAds: true }); pin(heli, path); f.game.step(TICK); }
  assert.equal(f.row('heli').lk, 2, 'LOCKED on the target row');
  assert.equal(pilot.vehicleId, 'heli');
  // The RX-8 AT rocket, down the sights on the same helicopter: no lock at all.
  const g = fixture([{ id: 'heli', type: 'helicopter', team: 'bravo', x: 300, y: 1, z: 200, yaw: 0 }]);
  const at = engineer(g, 'at', [300, 1, 300], 'rocket');
  for (let i = 0; i < 100; i++) {
    g.game.applyInput(at.id, { keys: {}, ...lookAt([at.eyeX, at.eyeY, at.eyeZ], [path.x, path.y + 1.6, path.z]), wantAds: true });
    pin(g.vehicle('heli'), path); g.game.step(TICK);
  }
  assert.equal(at.lockProgress ?? 0, 0, 'the AT launcher is dumb-fire');
  assert.equal(g.row('heli').lk ?? 0, 0);
}

// ------------------------------- STINGER hulls: 2 hits kill a helicopter or a transport, 3 a jet
{
  for (const [type, hits] of [['helicopter', 2], ['transport', 2], ['plane', 3]]) {
    const f = fixture([{ id: 'air', type, team: 'bravo', x: 300, y: 1, z: 200, yaw: 0 }]);
    const air = f.vehicle('air'), p = engineer(f, 'eng', [300, 1, 300]);
    let n = 0;
    while (air.hp > 0 && n < 6) {
      pin(air, { x: 300, y: 40, z: 200 });
      const center = f.game.vehicles.hullCenter(air), eye = [p.eyeX, p.eyeY, p.eyeZ];
      const d = center.map((v, i) => v - eye[i]), l = Math.hypot(...d);
      const missile = f.game.projectiles.launchStinger(p, f.game.contexts.projectiles, d.map(v => v / l), 'air');
      assert(missile, `${type}: the STINGER launches on a lock`);
      for (let i = 0; i < 240 && f.game.projectiles.active.has(missile.id); i++) { pin(air, { x: 300, y: 40, z: 200 }); f.game.step(TICK); }
      air.lastDamagedAt = -Infinity;
      n++;
    }
    assert.equal(n, hits, `${type} dies to ${hits} STINGER hits (${n}, ${VEHICLE_DEFS[type].hp} HP)`);
  }
  // Without a target (or on a dead hull) the projectile system refuses the launch.
  const f = fixture([{ id: 'air', type: 'helicopter', team: 'bravo', x: 300, y: 1, z: 200, yaw: 0 }]);
  const p = engineer(f, 'eng', [300, 1, 300]);
  assert.equal(f.game.projectiles.launchStinger(p, f.game.contexts.projectiles, [0, 0, -1], null), null, 'no lock, no missile');
  // A decoyed STINGER only splashes infantry: ground hulls never take its hull damage.
  const g = fixture([{ id: 'tank', type: 'tank', team: 'bravo', x: 300, y: 1, z: 260, yaw: 0 }, { id: 'air', type: 'helicopter', team: 'bravo', x: 300, y: 1, z: 200, yaw: 0 }]);
  const q = engineer(g, 'eng', [300, 1, 300]), tank = g.vehicle('tank');
  pin(g.vehicle('air'), { x: 300, y: 40, z: 200 });
  const missile = g.game.projectiles.launchStinger(q, g.game.contexts.projectiles, [0, 0, -1], 'air');
  missile.guidance.targetId = null; // as if flares took it
  for (let i = 0; i < 120 && g.game.projectiles.active.has(missile.id); i++) g.game.step(TICK);
  assert.equal(tank.hp, VEHICLE_DEFS.tank.hp, 'a STINGER flying into a tank does nothing to it');
}

console.log('Vehicle locks: STINGER ADS lock with lk 1->2->3 and PN homing on a crossing target (never Chaos), no unlocked launch, AT rocket dumb-fire, 2/2/3 STINGER hits for helicopter/transport/jet, flares decoy and cooldown, smoke breaks the 10 Hz line of sight, tank smoke fields, jet AA lock 1.5 s and proximity kill, cone/range/candidate rules passed');
