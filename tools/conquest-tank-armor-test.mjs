// Tank armour (shared/tank-armor.js, docs/conquest.md "Tank armour"): hit
// parts and plate slope, the ricochet and no-penetration limits, HE against
// sloped plate, subsystem damage (tracks, engine, turret ring) and its repair,
// ricochets in flight through the real GameEngine tick, the vehicle_hit fields
// and the client callouts.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { TANK_ARMOR, TANK_ARMOR_RULES, TANK_SUBSYSTEMS, TANK_PARTS, locateTankHit, tankArmorHit, ricochetVelocity } from '../shared/tank-armor.js';
import { VEHICLE_DEFS, vehicleLocalPoint, mountPose } from '../shared/vehicle-defs.js';
import { VEHICLE_STATUS } from '../shared/conquest-contract.js';
import { SUBSYSTEM_REPAIR_HP } from '../server/sim/vehicle-damage.js';
import { tankHitCallout, vehicleHitMark } from '../public/js/ui/conquest-hud-state.js';

const TICK = 1000 / 60;
const DEG = Math.PI / 180;
const near = (a, b, tolerance, message) => assert(Math.abs(a - b) <= tolerance, `${message}: ${a} vs ${b}`);

// ------------------------------------------------------------------ pure model
const tank = { type: 'tank', x: 10, y: 4, z: -6, yaw: 0, pitch: 0, roll: 0, turretYaw: 0 };
/** A round flying from `from` (hull-local) to `to` (hull-local) on `v`. */
function shot(v, from, to, opts = {}) {
  const a = vehicleLocalPoint(v, ...from), b = vehicleLocalPoint(v, ...to);
  const d = b.map((n, i) => n - a[i]), l = Math.hypot(...d);
  return tankArmorHit(v, b, { dir: d.map(n => n / l), cls: 'at', weapon: 'tankAP', ...opts });
}
/** A level round at `deg` from the hull's right-side normal toward its front, onto the right side at height y. */
function sideShot(v, deg, y = 1.2, opts = {}) {
  const to = [VEHICLE_DEFS.tank.collider.halfWidth, y, 0.3];
  const from = [to[0] + 30 * Math.cos(deg * DEG), y, to[2] - 30 * Math.sin(deg * DEG)];
  return shot(v, from, to, opts);
}
{
  // Parts by where the round lands, from the front, the side, the rear and above.
  const parts = [
    [[0, 1.2, -30], [0, 1.2, -2.6], 'hull-front'], [[0, 0.6, -30], [0, 0.6, -2.6], 'hull-front'],
    [[1.5, 0.5, -30], [1.5, 0.5, -2.6], 'tracks'], [[0, 2.1, -30], [0, 2.1, -2.6], 'turret-front'],
    [[30, 1.2, 0], [1.95, 1.2, 0], 'hull-side'], [[30, 0.5, 0], [1.95, 0.5, 0], 'tracks'], [[30, 2.2, 0], [1.95, 2.2, 0], 'turret-side'],
    [[0, 1.2, 30], [0, 1.2, 2.6], 'hull-rear'], [[0, 2.2, 30], [0, 2.2, 2.6], 'turret-rear'], [[0, 30, 2.2], [0, 2.65, 2.2], 'engine'],
    [[0, 30, 0], [0, 2.65, 0], 'turret-top'],
  ];
  for (const [from, to, part] of parts) assert.equal(shot(tank, from, to).part, part, `${part} from ${from}`);
  for (const part of Object.keys(TANK_ARMOR)) assert(TANK_PARTS[part], `${part} reports a facing zone`);
  // Slope: the upper glacis meets a level round at 59 degrees, the lower plate at 34, the mantlet square-on, a cheek at 45.
  near(shot(tank, [0, 1.2, -30], [0, 1.2, -2.6]).cos, 0.514, 0.01, 'glacis slope');
  near(shot(tank, [0, 0.6, -30], [0, 0.6, -2.6]).cos, 0.833, 0.01, 'lower plate slope');
  near(shot(tank, [0, 2.1, -30], [0, 2.1, -2.6]).cos, 1, 1e-6, 'mantlet square-on');
  near(shot(tank, [1, 2.1, -30], [1, 2.1, -2.6]).cos, Math.SQRT1_2, 0.01, 'turret cheek at 45 degrees');
  // The turret turns: with the gun 90 degrees left, a round from the front meets the turret's right side.
  assert.equal(shot({ ...tank, turretYaw: Math.PI / 2 }, [0, 2.1, -30], [0, 2.1, -2.6]).part, 'turret-side');
  // Hull attitude: cresting nose-up lays the glacis back (more slope against a level round),
  // nosing down a slope turns it into the round.
  const level = locateTankHit(tank, vehicleLocalPoint(tank, 0, 1.2, -2.6), [0, 0, 1]);
  const up = { ...tank, pitch: 0.3 }, upHit = locateTankHit(up, vehicleLocalPoint(up, 0, 1.2, -2.6), [0, 0, 1]);
  const down = { ...tank, pitch: -0.3 }, downHit = locateTankHit(down, vehicleLocalPoint(down, 0, 1.2, -2.6), [0, 0, 1]);
  assert(upHit.cos < level.cos - 0.2 && downHit.cos > level.cos + 0.2,
    `glacis vs a level round: nose up ${upHit.cos.toFixed(2)} < level ${level.cos.toFixed(2)} < nose down ${downHit.cos.toFixed(2)}`);
  const rolled = { ...tank, roll: 0.35 }, rolledHit = locateTankHit(rolled, vehicleLocalPoint(rolled, 1.95, 1.2, 0), [-1, 0, 0]);
  near(rolledHit.cos, Math.cos(0.35), 0.01, 'a rolled hull tilts its side plate');
  // A hit with no direction (a blast) takes the nearest face square-on.
  const blast = locateTankHit(tank, vehicleLocalPoint(tank, 2.4, 0.4, 0.5));
  assert.equal(blast.part, 'tracks'); assert.equal(blast.cos, 1);
}
{
  // Ricochet limits: 70 degrees for the AP shell, 75 for the HAVOC rocket, never for HE.
  const ap = TANK_ARMOR_RULES.ricochetDeg.tankAP, rocket = TANK_ARMOR_RULES.ricochetDeg.rocket;
  assert.equal(sideShot(tank, ap - 1).outcome, 'pen', 'AP at 69 degrees still penetrates the side');
  assert.equal(sideShot(tank, ap + 1).outcome, 'rico', 'AP at 71 degrees glances off');
  assert.equal(sideShot(tank, ap + 1).multiplier, 0, 'a ricochet deals nothing');
  assert.equal(sideShot(tank, rocket - 1, 1.2, { weapon: 'rocket' }).outcome, 'pen', 'the rocket bites at 74 degrees');
  assert.equal(sideShot(tank, rocket + 1, 1.2, { weapon: 'rocket' }).outcome, 'rico', 'the rocket skips at 76 degrees');
  const he = sideShot(tank, 85, 1.2, { cls: 'he', weapon: 'tankHE' });
  assert.equal(he.outcome, 'pen', 'HE never ricochets');
  near(he.multiplier, 0.35 * TANK_ARMOR['hull-side'].he * (TANK_ARMOR_RULES.heBase + TANK_ARMOR_RULES.heSlope * Math.cos(85 * DEG)), 1e-3, 'HE at a grazing angle');
  // Penetration falls with the angle once cos < ratio; below 45 % it only spalls.
  const side60 = sideShot(tank, 60);
  near(side60.multiplier, TANK_ARMOR['hull-side'].at * Math.cos(60 * DEG) / TANK_ARMOR['hull-side'].ratio, 1e-3, 'AP at 60 degrees: cos / ratio');
  assert.equal(side60.effective, true);
  // The mantlet (ratio 0.95) stops an AP round at 66 degrees without a ricochet.
  const mantlet = shot(tank, [0.2 + 30 * Math.sin(66 * DEG), 2.1, -1.9 - 30 * Math.cos(66 * DEG)], [0.2, 2.1, -1.9]);
  assert.equal(mantlet.part, 'turret-front'); assert.equal(mantlet.outcome, 'nopen', `mantlet at 66 degrees: ${mantlet.outcome}`);
  near(mantlet.multiplier, TANK_ARMOR['turret-front'].at * TANK_ARMOR_RULES.spall, 1e-9, 'no penetration spalls');
  assert.equal(mantlet.effective, false, 'a non-penetration is not effective');
  // HE against the front, side and rear.
  const heAt = (from, to) => shot(tank, from, to, { cls: 'he', weapon: 'tankHE' }).multiplier;
  const heFront = heAt([0, 1.2, -30], [0, 1.2, -2.6]), heSide = heAt([30, 1.2, 0], [1.95, 1.2, 0]), heRear = heAt([0, 1.2, 30], [0, 1.2, 2.6]);
  assert(heFront < heSide && heSide < heRear, `HE: front ${heFront.toFixed(3)} < side ${heSide.toFixed(3)} < rear ${heRear.toFixed(3)}`);
  // MG and small arms stay harmless whatever they strike.
  for (const cls of ['small', 'mg']) assert.equal(sideShot(tank, 0, 1.2, { cls }).multiplier, 0, `${cls} vs tank`);
  // Reflection: mirrored about the normal, slowed.
  const out = ricochetVelocity([10, 0, 0], [-1, 0, 0], 'tankAP');
  near(out[0], -10 * TANK_ARMOR_RULES.ricochetSpeed.tankAP, 1e-9, 'reflected velocity');
}

// ------------------------------------------------------------ server: subsystems and events
function fixture(spawns) {
  const size = 384, dimensions = { sx: size, sy: 64, sz: size }, frames = [];
  const world = { dimensions, getBlock: (x, y, z) => y === 0 ? 3 : 0, setBlock: () => true, findSpawns: () => [{ x: 20, y: 1, z: 20 }] };
  const game = new GameEngine({ mode: 'conquest', world, broadcast: frame => frames.push(frame),
    mapMeta: { id: 'frontier', dimensions, spawns: { conquest: { alpha: [{ x: 20, y: 1, z: 20 }], bravo: [{ x: 30, y: 1, z: 20 }] } },
      conquest: { flags: [], bases: {}, vehicleSpawns: spawns } } });
  const player = (id, team) => {
    game.addClient(id, id);
    const p = game.entities.get(id);
    game.mode.policy.setLobbyTeam(p, team);
    Object.assign(p, { x: 20, y: 1, z: 20, hp: 100, armor: 0, spawnProtectedUntil: 0, spawnProtected: false, grounded: true, input: { keys: {}, yaw: 0, pitch: 0 } });
    return p;
  };
  const vehicle = id => game.vehicles.vehicles.get(id);
  const board = (p, vehicleId, seatId) => {
    const v = vehicle(vehicleId);
    Object.assign(p, { x: v.x, y: v.y, z: v.z });
    game.applyInput(p.id, { keys: {}, yaw: v.yaw, pitch: 0, vehicleAction: { type: 'enter', vehicleId, seatId } });
    assert.equal(p.vehicleId, vehicleId);
    return p;
  };
  const events = kind => frames.flatMap(frame => frame.events).filter(event => event.kind === kind);
  const tick = (count = 1) => { for (let i = 0; i < count; i++) game.step(TICK); };
  const row = id => frames.at(-1).vehicles.find(r => r.id === id);
  return { game, frames, player, vehicle, board, events, tick, row };
}
const spawn = (id, type, team, x, z, yaw = 0) => ({ id, type, team, x, y: 1, z, yaw });
const lookAt = (from, to) => {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
};
const along = (v, local, dir) => ({ point: vehicleLocalPoint(v, ...local), dir });

{
  // Tracks: a rocket on the running gear breaks them; the hull stops, st carries tracksHit.
  const f = fixture([spawn('t', 'tank', 'alpha', 100, 100), spawn('ref', 'tank', 'alpha', 160, 100)]);
  const enemy = f.player('enemy', 'bravo');
  const driver = f.board(f.player('d', 'alpha'), 't', 'driver'), ref = f.board(f.player('r', 'alpha'), 'ref', 'driver');
  const t = f.vehicle('t');
  const { point, dir } = along(t, [1.95, 0.5, 0], [-1, 0, 0]);
  assert(f.game.vehicles.damage('t', 320, enemy, { cls: 'at', point, dir, weapon: 'rocket' }));
  near(t.hp, 1000 - 320 * TANK_ARMOR.tracks.at, 1e-6, 'tracks take AT x0.95');
  assert(f.game.vehicles.subsystemBroken(t, 'tracks'), 'one rocket on the running gear breaks the tracks');
  for (const p of [driver, ref]) f.game.applyInput(p.id, { keys: {}, yaw: 0, pitch: 0, vehicleThrottle: 1, vehicleSteer: 1 });
  f.tick(60);
  assert(Math.abs(t.speed) < 0.01 && Math.abs(t.yawRate || 0) < 1e-6, 'broken tracks: no drive and no pivot');
  assert(f.vehicle('ref').speed > 1, 'the intact tank drives off');
  assert(f.row('t').st & VEHICLE_STATUS.tracksHit, 'st carries tracksHit');
  f.tick(8);
  const hit = f.events('vehicle_hit').find(e => e.vehicleId === 't');
  assert.deepEqual([hit.part, hit.sys, hit.zone, hit.res], ['tracks', 'tracks', 'side', undefined], 'vehicle_hit: part, subsystem, facing');
  // The tracks mend themselves after TANK_SUBSYSTEMS.tracks.seconds.
  f.tick(Math.ceil(TANK_SUBSYSTEMS.tracks.seconds * 60));
  assert(!f.game.vehicles.subsystemBroken(t, 'tracks'), 'tracks back after their time');
  f.tick(60);
  assert(t.speed > 1, 'and the tank drives again');
  assert(!(f.row('t').st & VEHICLE_STATUS.tracksHit));
}
{
  // Engine: a rear hit caps the drive at half; turret ring: a turret-side hit slows the traverse.
  const f = fixture([spawn('e', 'tank', 'alpha', 60, 150), spawn('h', 'tank', 'alpha', 140, 150), spawn('g', 'tank', 'alpha', 220, 150)]);
  const enemy = f.player('enemy', 'bravo');
  const pe = f.board(f.player('a', 'alpha'), 'e', 'driver'), ph = f.board(f.player('b', 'alpha'), 'h', 'driver'), pg = f.board(f.player('c', 'alpha'), 'g', 'driver');
  const e = f.vehicle('e'), g = f.vehicle('g');
  // 200 AT on the rear plate (x1.7 = 340): engine broken, but under the 30 % single-hit disable.
  f.game.vehicles.damage('e', 170, enemy, { cls: 'at', ...along(e, [0, 1.2, 2.6], [0, 0, -1]), weapon: 'tankAP' });
  assert(f.game.vehicles.subsystemBroken(e, 'engine') && !e.disabled, 'engine damaged, hull not disabled');
  f.game.vehicles.damage('g', 320, enemy, { cls: 'at', ...along(g, [1.95, 2.2, -0.2], [-1, 0, 0]), weapon: 'tankAP' });
  assert(f.game.vehicles.subsystemBroken(g, 'turret'), 'a turret-side penetration of 352 damages the turret ring');
  for (const p of [pe, ph, pg]) f.game.applyInput(p.id, { keys: {}, yaw: 1.2, pitch: 0, vehicleThrottle: 1 });
  f.tick();
  const turn = id => Math.abs(Math.atan2(Math.sin(f.vehicle(id).turretYaw), Math.cos(f.vehicle(id).turretYaw)));
  near(turn('g') / turn('h'), TANK_SUBSYSTEMS.turret.slew, 0.05, 'a damaged turret ring traverses at 0.4x');
  f.tick(299);
  near(e.speed / f.vehicle('h').speed, TANK_SUBSYSTEMS.engine.drive, 0.03, 'a damaged engine drives at 0.5x');
  f.tick(4);
  assert(f.row('e').st & VEHICLE_STATUS.engineHit && f.row('g').st & VEHICLE_STATUS.turretHit, 'st carries engineHit and turretHit');
  // Repair: SUBSYSTEM_REPAIR_HP of Engineer repair fixes a broken subsystem early.
  const engineer = f.player('engineer', 'alpha');
  assert(f.game.vehicles.repair('e', SUBSYSTEM_REPAIR_HP - 1, engineer) > 0);
  assert(f.game.vehicles.subsystemBroken(e, 'engine'), 'not yet');
  f.game.vehicles.repair('e', 1, engineer);
  assert(!f.game.vehicles.subsystemBroken(e, 'engine'), 'repaired');
  // Pools drain: hits spread over time do not add up to a broken subsystem.
  const before = g.subsystems.turret.pool;
  f.tick(60);
  assert(g.subsystems.turret.pool <= Math.max(0, before - TANK_SUBSYSTEMS.turret.decay * 0.9));
  // A destroyed hull respawns with its subsystems whole.
  f.game.vehicles.damage('g', 5000, enemy, { cls: 'collision' });
  assert.equal(g.subsystems, null);
}
{
  // A rear AT hit on the turret bustle disables like one on the engine; HE does not disable.
  const f = fixture([spawn('b', 'tank', 'alpha', 100, 100)]);
  const enemy = f.player('enemy', 'bravo'), b = f.vehicle('b');
  f.game.vehicles.damage('b', 400, enemy, { cls: 'at', ...along(b, [0, 2.2, 2.6], [0, 0, -1]), weapon: 'tankAP' });
  assert(b.disabled, 'a turret-rear AP hit (ammunition bustle) disables the tank');
}

// ----------------------------------------------------------- ricochet in flight
{
  // A tank fires AP at a hull whose flank meets the shell at about 78 degrees: the shell glances off.
  const f = fixture([spawn('gun', 'tank', 'alpha', 100, 140), spawn('target', 'tank', 'bravo', 100, 100, 0)]);
  const gunner = f.board(f.player('gunner', 'alpha'), 'gun', 'driver');
  const target = f.vehicle('target');
  // Turn the target almost end-on to the gun, then aim at its right flank near the front.
  target.yaw = 78 * DEG - Math.PI / 2; target.turretYaw = target.yaw;
  const muzzle = mountPose(f.vehicle('gun'), 'driver', 'main').pivot;
  const aimAt = vehicleLocalPoint(target, 1.95, 1.25, -1.2);
  f.game.applyInput(gunner.id, { keys: {}, ...lookAt(muzzle, aimAt), wantFire: false });
  f.tick(240);
  f.game.applyInput(gunner.id, { keys: {}, ...lookAt(muzzle, aimAt), wantFire: true });
  let launched = null;
  for (let i = 0; i < 90 && !launched; i++) { f.tick(); launched = f.events('projectileLaunch').find(e => e.vehicleWeapon === 'tankAP'); }
  f.game.applyInput(gunner.id, { keys: {}, ...lookAt(muzzle, aimAt), wantFire: false });
  assert(launched, 'the AP shell leaves the gun');
  f.tick(60);
  const hits = f.events('vehicle_hit').filter(e => e.vehicleId === 'target');
  const rico = hits.find(e => e.res === 'rico');
  assert(rico, `a grazing AP shell ricochets (${JSON.stringify(hits)})`);
  assert.equal(rico.dmg, 0); assert.equal(rico.eff, 0); assert.equal(rico.cls, 'at'); assert.equal(rico.attacker, 'gunner');
  assert(['hull-side', 'turret-side', 'tracks'].includes(rico.part), `ricochet part ${rico.part}`);
  assert.equal(target.hp, 1000, 'the ricochet leaves the tank whole');
  const update = f.events('projectileUpdate').find(e => e.pid === launched.pid);
  assert(update, 'the reflected shell is re-published (projectileUpdate)');
  const speed = Math.hypot(...update.v);
  near(speed, Math.hypot(...launched.v) * TANK_ARMOR_RULES.ricochetSpeed.tankAP, 15, 'the glancing shell keeps ~55 % of its speed');
}

// -------------------------------------------------------------- client callouts
{
  const base = { kind: 'vehicle_hit', vehicleId: 't', attacker: 'me', dmg: 0, zone: 'side', cls: 'at', eff: 0, pos: [0, 0, 0], part: 'hull-side' };
  assert.deepEqual(tankHitCallout({ ...base, res: 'rico' }, 'me'), { text: 'RICOCHET', tone: 'neutral', key: 'rico' });
  assert.equal(tankHitCallout({ ...base, res: 'nopen' }, 'me').text, 'NO PENETRATION');
  assert.equal(tankHitCallout({ ...base, eff: 1, dmg: 300, part: 'tracks', sys: 'tracks' }, 'me').text, 'TRACKS HIT');
  assert.equal(tankHitCallout({ ...base, eff: 1, dmg: 300, part: 'hull-rear', sys: 'engine', zone: 'rear' }, 'me').text, 'ENGINE HIT');
  assert.equal(tankHitCallout({ ...base, eff: 1, dmg: 300, part: 'hull-rear', zone: 'rear' }, 'me').text, 'HULL REAR');
  assert.equal(tankHitCallout({ ...base, eff: 1, dmg: 40, cls: 'hmg' }, 'me'), null, 'no callout for small hits');
  assert.equal(tankHitCallout({ ...base, res: 'rico', attacker: 'x' }, 'me'), null, "someone else's ricochet on someone else's tank");
  // The struck crew reads what bounced or broke.
  assert.equal(tankHitCallout({ ...base, res: 'rico', attacker: 'x' }, 'me', { id: 't' }).text, 'RICOCHET · ARMOUR HELD');
  assert.deepEqual(tankHitCallout({ ...base, eff: 1, dmg: 300, sys: 'tracks', attacker: 'x' }, 'me', { id: 't' }), { text: 'TRACKS BROKEN', tone: 'bad', key: 'sys:tracks' });
  assert.equal(tankHitCallout({ ...base, eff: 1, dmg: 300, sys: 'turret', attacker: 'x' }, 'me', { id: 't' }).text, 'TURRET DAMAGED');
  assert.equal(tankHitCallout({ ...base, part: undefined, res: 'rico' }, 'me'), null, 'other hulls carry no part');
  assert.equal(vehicleHitMark({ ...base, res: 'rico' }, 'me'), 'spark');
  assert.equal(vehicleHitMark({ ...base, eff: 1, res: 'nopen' }, 'me'), 'spark');
  assert.equal(vehicleHitMark({ ...base, eff: 1 }, 'me'), 'armor');
}

console.log('Tank armour: parts and slope, hull attitude, ricochet / no-penetration limits, HE vs plate, tracks / engine / turret subsystems, repair, in-flight ricochet and client callouts passed');
