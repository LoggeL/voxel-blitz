// Conquest team spotting (WP8): cone, range and duration by kit, voxel line of
// sight, smoke, best-target choice, hulls, cooldown, auto-spot on fire and the
// spot-assist award. A fake engine pins the rules; a final case runs on the
// real GameEngine world and SmokeSystem.
import assert from 'node:assert/strict';
import { CONQUEST_RULES } from '../shared/conquest-contract.js';
import { KIT_ROLE_RULES } from '../shared/conquest-kits.js';
import { PlayerEntity } from '../server/sim/player.js';
import { SmokeSystem } from '../server/sim/smoke.js';
import { createConquestRoles } from '../server/modes/conquest/roles.js';
import { ConquestSpotting, hullSightGeometry } from '../server/modes/conquest/spotting.js';

const DIMS = { sx: 1024, sy: 64, sz: 1024 };
const GROUND = 10;

class FakeVehicleSystem {
  constructor() { this.vehicles = new Map(); this.spots = []; }
  spot(vehicleId, team, untilMs) { this.spots.push({ vehicleId, team, untilMs }); }
}

function fixture() {
  const solid = new Set();
  const smoke = new SmokeSystem();
  const engine = {
    now: 50000,
    entities: new Map(),
    tickEvents: [],
    solidAt: (x, y, z) => y < GROUND || solid.has(`${x},${y},${z}`),
    projectiles: { smoke },
    vehicles: new FakeVehicleSystem(),
    respawnPlayer(p, spawn) { p.applySpawn(spawn); return true; },
  };
  const policy = {
    phase: 'live', awards: [], events: [],
    teamFor: p => p?.team ?? null,
    award(id, reason, scale = 1) { this.awards.push([id, reason, scale]); },
    refundTicket() {},
    _emit(kind, fields) { this.events.push({ kind, ...fields }); },
  };
  const roles = createConquestRoles({ policy, engine, rules: CONQUEST_RULES });
  const add = (id, team, kit, x, z, y = GROUND) => {
    const p = new PlayerEntity(id, id, { x, y, z }, false, DIMS);
    p.team = team;
    engine.entities.set(id, p);
    roles.applyLoadout(p, kit, 0);
    return p;
  };
  const step = (ms = 1000 / 60) => { engine.now += ms; roles.tick(engine.now, ms); engine.tickEvents.length = 0; };
  const wall = (x0, x1, y0, y1, z) => { for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) solid.add(`${x},${y},${z}`); };
  const spot = p => roles.intent(p, { type: 'spot' });
  const later = (ms = CONQUEST_RULES.spotCooldownMs + 1) => { engine.now += ms; };
  return { engine, policy, roles, add, step, wall, spot, later, smoke, solid };
}

// Spotter at (500, 500) looking down -Z (yaw 0); targets are placed along -Z.
const look = (p, yaw = 0, pitch = 0) => Object.assign(p, { yaw, pitch });

// ------------------------------------------------------------- cone/range --
{
  const f = fixture();
  assert.ok(f.roles.spotting instanceof ConquestSpotting);
  const spotter = look(f.add('a1', 'alpha', 'assault', 500.5, 500.5));
  const enemy = f.add('b1', 'bravo', 'assault', 500.5, 440.5);
  assert.equal(f.spot(spotter), true, 'enemy straight ahead is spotted');
  assert.equal(f.roles.snapshotFields(enemy).spotted, true);
  const ev = f.policy.events.find(e => e.kind === 'spot');
  assert.deepEqual(ev, { kind: 'spot', by: 'a1', ids: ['b1'] }, 'spot event {by, ids}');
  assert.equal(f.roles.spotting.spotterOf(enemy), 'a1');

  // Duration: 5 s for non-recon, then the mark expires.
  f.step(CONQUEST_RULES.spotMs - 20);
  assert.equal(f.roles.snapshotFields(enemy).spotted, true);
  f.step(40);
  assert.equal(f.roles.snapshotFields(enemy).spotted, false, 'mark expires after spotMs');

  // Cone: 0.06 rad plus the body radius; 10 degrees off-axis is outside.
  f.later();
  const off = 10 * Math.PI / 180;
  Object.assign(enemy, { x: 500.5 + Math.sin(off) * 60, z: 500.5 - Math.cos(off) * 60 });
  assert.equal(f.spot(spotter), false, 'outside the cone');
  const inside = CONQUEST_RULES.spotConeRad * 0.8;
  Object.assign(enemy, { x: 500.5 + Math.sin(inside) * 120, z: 500.5 - Math.cos(inside) * 120 });
  f.later();
  assert.equal(f.spot(spotter), true, 'inside the cone at 120 m');

  // Teammates are never marked; a teammate alone in the cone spots nothing.
  f.later();
  enemy.z = 900; enemy.x = 900;
  f.add('a2', 'alpha', 'assault', 500.5, 470.5);
  assert.equal(f.spot(spotter), false, 'teammates are not spot targets');
}

// ----------------------------------------------------- range/duration by kit --
{
  const f = fixture();
  const assault = look(f.add('a1', 'alpha', 'assault', 500.5, 900.5));
  const recon = look(f.add('a2', 'alpha', 'recon', 501.5, 900.5));
  const enemy = f.add('b1', 'bravo', 'support', 500.5, 900.5 - 350);
  assert.equal(f.spot(assault), false, '350 m is beyond the 300 m range');
  assert.equal(f.spot(recon), true, 'recon reaches 400 m');
  f.step(CONQUEST_RULES.spotMs + 100);
  assert.equal(f.roles.snapshotFields(enemy).spotted, true, 'a recon mark lasts longer than spotMs');
  f.step(CONQUEST_RULES.spotMsRecon - CONQUEST_RULES.spotMs - 200);
  assert.equal(f.roles.snapshotFields(enemy).spotted, true);
  f.step(200);
  assert.equal(f.roles.snapshotFields(enemy).spotted, false, 'recon mark ends at spotMsRecon');
  enemy.z = 900.5 - 450;
  f.later();
  assert.equal(f.spot(recon), false, 'recon cannot see past 400 m');
}

// ------------------------------------------------------ line of sight/smoke --
{
  const f = fixture();
  const spotter = look(f.add('a1', 'alpha', 'assault', 500.5, 500.5));
  const enemy = f.add('b1', 'bravo', 'assault', 500.5, 450.5);
  f.wall(495, 505, GROUND, GROUND + 4, 475);
  assert.equal(f.spot(spotter), false, 'a voxel wall blocks the spot');
  f.solid.clear();
  f.later();
  f.smoke.deploy({ id: 's1', x: 500.5, y: GROUND, z: 475.5, chaosLevel: 0 }, { now: f.engine.now });
  f.later(1200); // let the cloud grow
  assert.equal(f.spot(spotter), false, 'smoke blocks the spot');
  f.smoke.clear();
  f.later();
  assert.equal(f.spot(spotter), true, 'clear again');
  // A low wall that hides the chest still leaves the head visible.
  f.later();
  f.wall(495, 505, GROUND, GROUND + 1, 452); // top at y 12
  spotter.y = enemy.y = GROUND + 0.6;        // chest ~11.75 hidden, head ~12.2 exposed
  const chest = [enemy.x, enemy.y + 1.15, enemy.z];
  const eye = [spotter.eyeX, spotter.eyeY, spotter.eyeZ];
  assert.equal(f.roles.spotting.lineOfSight(eye, chest), false, 'the low wall hides the chest');
  assert.equal(f.spot(spotter), true, 'a head above cover is enough');
}

// ------------------------------------------- best target, hulls, cooldown --
{
  const f = fixture();
  const spotter = look(f.add('a1', 'alpha', 'assault', 500.5, 500.5));
  const near = f.add('b1', 'bravo', 'assault', 500.5 + 1.5, 450.5); // ~1.7 deg off
  const centred = f.add('b2', 'bravo', 'assault', 500.5, 400.5);
  assert.equal(f.roles.spotting.spot(spotter), 'b2', 'the target closest to the crosshair wins');
  assert.equal(f.roles.snapshotFields(near).spotted, false, 'one mark per spot');

  // Cooldown: the next spot inside spotCooldownMs is refused even with a target.
  assert.equal(f.spot(spotter), false, 'cooldown');
  f.later(CONQUEST_RULES.spotCooldownMs - 10);
  assert.equal(f.spot(spotter), false, 'still cooling down');
  f.later(20);
  near.x = 700; centred.x = 720;
  const tank = { id: 'bravo-tank', type: 'tank', team: 'bravo', hp: 1000, x: 503, y: GROUND, z: 470, yaw: 0.4 };
  f.engine.vehicles.vehicles.set(tank.id, tank);
  const geometry = hullSightGeometry(tank);
  assert.ok(geometry.radius > 2 && geometry.points.length === 2);
  assert.equal(f.spot(spotter), true, 'a hull wider than the cone is spotted off-centre');
  assert.deepEqual(f.engine.vehicles.spots.at(-1), { vehicleId: 'bravo-tank', team: 'alpha', untilMs: f.engine.now + CONQUEST_RULES.spotMs });
  assert.deepEqual(f.policy.events.at(-1), { kind: 'spot', by: 'a1', ids: ['bravo-tank'] });
  assert.equal(f.roles.spotting.isVehicleSpotted('bravo-tank'), true);
  // Friendly and dead hulls are ignored; an unowned hull counts only with an enemy crew.
  f.later();
  Object.assign(tank, { team: 'alpha' });
  assert.equal(f.spot(spotter), false, 'friendly hulls are not targets');
  Object.assign(tank, { team: null, seatOccupants: { driver: 'b9' } });
  f.add('b9', 'bravo', 'engineer', 900, 900);
  f.engine.entities.get('b9').vehicleId = tank.id;
  f.later(KIT_ROLE_RULES.spotAttemptMinMs); // the refused attempt above only blocks re-tries for 250 ms
  assert.equal(f.spot(spotter), true, 'an unowned hull with an enemy driver is a target');
  f.later();
  tank.hp = 0;
  assert.equal(f.spot(spotter), false, 'wrecks are not targets');
  // Attempts closer than spotAttemptMinMs are dropped before any work.
  f.later();
  const attempts = f.policy.events.length;
  assert.equal(f.spot(spotter), false, 'nothing in the cone');
  Object.assign(near, { x: 500.5, z: 450.5 });
  f.engine.now += KIT_ROLE_RULES.spotAttemptMinMs - 10;
  assert.equal(f.spot(spotter), false, 'a retry inside spotAttemptMinMs is dropped');
  assert.equal(f.policy.events.length, attempts);
  f.engine.now += 20;
  assert.equal(f.spot(spotter), true, 'a failed attempt does not start the full cooldown');
  // The dead never spot and are never spotted.
  spotter.state = 'dead';
  f.later();
  assert.equal(f.spot(spotter), false);
}

// --------------------------------------------------------------- auto-spot --
{
  const f = fixture();
  const shooter = f.add('b1', 'bravo', 'assault', 100, 100);
  const quiet = f.add('b2', 'bravo', 'assault', 120, 100);
  f.step();
  f.engine.tickEvents.push({ t: 'ev', kind: 'shoot', id: 'b1', w: 'rifle' });
  f.engine.tickEvents.push({ t: 'ev', kind: 'shoot', id: 'b2', w: 'knife' });
  f.engine.now += 1000 / 60; f.roles.tick(f.engine.now, 1000 / 60); f.engine.tickEvents.length = 0;
  assert.equal(f.roles.snapshotFields(shooter).spotted, true, 'unsuppressed fire auto-spots the shooter');
  assert.equal(f.roles.snapshotFields(quiet).spotted, false, 'melee is silent');
  assert.equal(f.roles.spotting.spotterOf(shooter), null, 'an auto-spot has no spotter');
  f.step(CONQUEST_RULES.autoSpotOnFireMs + 20);
  assert.equal(f.roles.snapshotFields(shooter).spotted, false, 'auto-spot lasts autoSpotOnFireMs');
  // The authoritative shot counter also triggers it (no event needed).
  quiet.weapon = 0; // rifle slot
  quiet.shotSeq += 3;
  f.step();
  assert.equal(f.roles.snapshotFields(quiet).spotted, true, 'shotSeq advance auto-spots');
  // Mounted fire marks the hull for the enemy team.
  const jeep = { id: 'bravo-jeep', type: 'jeep', team: 'bravo', hp: 320, x: 300, y: GROUND, z: 300, yaw: 0 };
  f.engine.vehicles.vehicles.set(jeep.id, jeep);
  shooter.vehicleId = jeep.id;
  f.engine.tickEvents.push({ t: 'ev', kind: 'shoot', id: 'b1', w: 'lmg', vehicleId: jeep.id, vehicleWeapon: 'hmg' });
  f.engine.now += 1000 / 60; f.roles.tick(f.engine.now, 1000 / 60);
  assert.deepEqual(f.engine.vehicles.spots.at(-1), { vehicleId: 'bravo-jeep', team: 'alpha', untilMs: f.engine.now + CONQUEST_RULES.autoSpotOnFireMs });
  // An auto-spot never shortens a longer manual mark nor steals its spotter.
  const spotter = look(f.add('a1', 'alpha', 'recon', 120.5, 140.5));
  quiet.x = 120.5; quiet.z = 100.5;
  f.later();
  assert.equal(f.spot(spotter), true);
  const until = f.roles.spotting.players.get('b2').until;
  f.engine.tickEvents.push({ t: 'ev', kind: 'shoot', id: 'b2', w: 'rifle' });
  f.engine.now += 1000 / 60; f.roles.tick(f.engine.now, 1000 / 60); f.engine.tickEvents.length = 0;
  assert.equal(f.roles.spotting.players.get('b2').until, until);
  assert.equal(f.roles.spotting.spotterOf(quiet), 'a1');
  // A counter that moved while roles were not ticking (post phase) only re-baselines.
  f.step(CONQUEST_RULES.spotMsRecon + 10);
  assert.equal(f.roles.snapshotFields(quiet).spotted, false);
  quiet.shotSeq += 5;
  f.engine.now += 5000;
  f.step();
  assert.equal(f.roles.snapshotFields(quiet).spotted, false, 'a shot-counter gap is not fire');
  quiet.shotSeq += 1;
  f.step();
  assert.equal(f.roles.snapshotFields(quiet).spotted, true, 'the next tick-to-tick change is');
}

// ------------------------------------------------------------- spot assist --
{
  const f = fixture();
  const spotter = look(f.add('a1', 'alpha', 'recon', 500.5, 500.5));
  const mate = f.add('a2', 'alpha', 'assault', 510.5, 500.5);
  const enemy = f.add('b1', 'bravo', 'assault', 500.5, 450.5);
  const enemy2 = f.add('b2', 'bravo', 'assault', 300.5, 300.5);
  assert.equal(f.spot(spotter), true);
  enemy.state = 'dead';
  f.roles.onDeath(enemy, mate, { weapon: 'rifle' });
  assert.deepEqual(f.policy.awards, [['a1', 'spot_assist', 1]], 'teammate kill on a spotted enemy');
  f.roles.onDeath(enemy, mate, { weapon: 'rifle' });
  assert.equal(f.policy.awards.length, 1, 'spot assist awarded once');
  // The spotter's own kill is a kill, not an assist; an unspotted kill gives nothing.
  f.roles.onRespawn(enemy); enemy.state = 'alive';
  f.later();
  assert.equal(f.spot(spotter), true);
  enemy.state = 'dead';
  f.roles.onDeath(enemy, spotter, { weapon: 'sniper' });
  enemy2.state = 'dead';
  f.roles.onDeath(enemy2, mate, { weapon: 'rifle' });
  assert.equal(f.policy.awards.length, 1, 'no assist for own kills or unspotted targets');
  // An expired mark gives nothing.
  f.roles.onRespawn(enemy); enemy.state = 'alive';
  f.later();
  assert.equal(f.spot(spotter), true);
  f.step(CONQUEST_RULES.spotMsRecon + 10);
  enemy.state = 'dead';
  f.roles.onDeath(enemy, mate, { weapon: 'rifle' });
  assert.equal(f.policy.awards.length, 1);
  // A spotted hull destroyed by a teammate pays the spotter once.
  const heli = { id: 'bravo-helicopter', type: 'helicopter', team: 'bravo', hp: 650, x: 500.5, y: GROUND + 2, z: 420.5, yaw: 0 };
  f.engine.vehicles.vehicles.set(heli.id, heli);
  f.later();
  assert.equal(f.spot(spotter), true);
  assert.equal(f.roles.onVehicleEvent('vehicle_destroyed', { vehicleId: heli.id, attacker: 'a2' }), true);
  assert.equal(f.roles.onVehicleEvent('vehicle_destroyed', { vehicleId: heli.id, attacker: 'a2' }), false);
  assert.deepEqual(f.policy.awards.at(-1), ['a1', 'spot_assist', 1]);
  assert.equal(f.policy.awards.length, 2);
  // A respawn clears any lingering mark.
  enemy.state = 'alive'; f.roles.onRespawn(enemy);
  assert.equal(f.roles.snapshotFields(enemy).spotted, false);
}

// -------------------------------------------------- real engine integration --
{
  const { GameEngine } = await import('../server/game.js');
  const wallZ = 40;
  const world = {
    dimensions: { sx: 128, sy: 32, sz: 128 },
    getBlock: (x, y, z) => (y < 2 || (z === wallZ && x >= 60 && x <= 70 && y < 8) ? 1 : 0),
    findSpawns: () => [{ x: 20, y: 2, z: 20 }],
    setBlock: () => {},
  };
  const game = new GameEngine({
    mode: 'conquest',
    mapMeta: { id: 'frontier', dimensions: world.dimensions,
      spawns: { conquest: { alpha: [{ x: 20, y: 2, z: 20 }], bravo: [{ x: 90, y: 2, z: 90 }] } },
      conquest: { flags: [], bases: {}, vehicleSpawns: [] } },
    world, broadcast: () => {},
  });
  game.addClient('s', 'Spotter'); game.addClient('t', 'Target');
  const spotter = game.entities.get('s'), target = game.entities.get('t');
  assert.notEqual(game.mode.teamFor(spotter), game.mode.teamFor(target), 'balancer split the two clients');
  const roles = createConquestRoles({ engine: game, policy: {
    get phase() { return game.mode.phase; }, teamFor: p => game.mode.teamFor(p), award() {}, refundTicket() {},
  } });
  roles.applyLoadout(spotter, 'recon', 0);
  roles.applyLoadout(target, 'assault', 0);
  // Behind the wall: hidden. Beside it: visible.
  Object.assign(spotter, { x: 65.5, y: 2, z: 60.5, yaw: 0, pitch: 0 });
  Object.assign(target, { x: 65.5, y: 2, z: 20.5 });
  assert.equal(roles.spotting.spot(spotter), null, 'real voxel wall blocks the spot');
  Object.assign(spotter, { x: 80.5 });
  Object.assign(target, { x: 80.5 });
  game.now += 300;
  assert.equal(roles.spotting.spot(spotter), 't', 'clear line through the real world');
  // A real smoke grenade cloud blocks the next spot.
  roles.spotting.players.clear();
  game.now += CONQUEST_RULES.spotCooldownMs + 1;
  game.projectiles.smoke.deploy({ id: 'g', x: 80.5, y: 1.5, z: 40.5, chaosLevel: 0 }, { now: game.now });
  game.now += 1500;
  assert.equal(roles.spotting.spot(spotter), null, 'real SmokeSystem blocks the spot');
  // A real rifle shot through the engine auto-spots the shooter.
  game.projectiles.smoke.clear();
  roles.tick(game.now, 16);
  target.weapon = 0;
  target.shotSeq += 1;
  roles.tick(game.now + 16, 16);
  assert.equal(roles.snapshotFields(target).spotted, true, 'engine shot counter auto-spots');

  // Policy-wired path (WP1): spot through the mode intent and read it back off the wire.
  const { ConquestRoles } = await import('../server/modes/conquest/roles.js');
  const wired = Object.values(game.mode.policy ?? {}).find(value => value instanceof ConquestRoles) ?? null;
  if (wired && typeof game.mode.conquestIntent === 'function') {
    wired.applyLoadout(spotter, 'recon', 0);
    let snapshot = null;
    game.broadcast = s => { snapshot = s; };
    game.step();
    Object.assign(spotter, { x: 80.5, y: 2, z: 60.5, yaw: 0, pitch: 0 });
    Object.assign(target, { x: 80.5, y: 2, z: 20.5 });
    game.now += CONQUEST_RULES.spotCooldownMs + 1;
    assert.equal(game.mode.conquestIntent(spotter, { type: 'spot' }), true, 'wired spot intent accepted');
    game.step();
    const row = snapshot.players.find(r => r.id === 't');
    assert.equal(row?.cq?.[3], 1, 'wired: cq[3] marks the spotted enemy');
    assert.ok(snapshot.events.some(e => e.kind === 'spot' && e.by === 's' && e.ids?.[0] === 't'), 'wired: spot event');
    console.log('  real engine: policy-wired spotting');
  } else {
    console.log('  real engine: standalone spotting (WP1 wiring not present)');
  }
}

// ------------------------------------ real VehicleSystem hull spot (WP2 API) --
{
  const { GameEngine } = await import('../server/game.js');
  const { ConquestRoles } = await import('../server/modes/conquest/roles.js');
  const world = {
    dimensions: { sx: 128, sy: 32, sz: 128 },
    getBlock: (_x, y) => (y < 2 ? 1 : 0),
    findSpawns: () => [{ x: 20, y: 2, z: 20 }],
    setBlock: () => {},
  };
  const game = new GameEngine({
    mode: 'conquest',
    mapMeta: { id: 'frontier', dimensions: world.dimensions,
      spawns: { conquest: { alpha: [{ x: 20, y: 2, z: 20 }], bravo: [{ x: 90, y: 2, z: 90 }] } },
      conquest: { flags: [], bases: {}, vehicleSpawns: [
        { id: 'alpha-tank', team: 'alpha', type: 'tank', x: 20.5, y: 2, z: 100.5, yaw: 0 },
        { id: 'bravo-tank', team: 'bravo', type: 'tank', x: 90.5, y: 2, z: 40.5, yaw: 0 },
      ] } },
    world, broadcast: () => {},
  });
  const wired = Object.values(game.mode.policy ?? {}).find(value => value instanceof ConquestRoles) ?? null;
  if (typeof game.vehicles?.spot !== 'function' || !wired || typeof game.mode.conquestIntent !== 'function') {
    console.log('  real VehicleSystem hull spot: skipped (VehicleSystem.spot or policy wiring not present)');
  } else {
    for (const id of ['a1', 'b1', 'a2', 'b2']) game.addClient(id, id);
    const players = [...game.entities.values()];
    const [spotter, killer] = players.filter(p => game.mode.teamFor(p) === 'alpha');
    assert.ok(spotter && killer, 'two alpha clients for spotter and killer');
    wired.applyLoadout(spotter, 'assault', 0);
    const hull = game.vehicles.vehicles.get('bravo-tank');
    assert.ok(hull?.hp > 0, 'live enemy hull');
    let snapshot = null;
    const events = [];
    game.broadcast = s => { snapshot = s; events.push(...(s?.events ?? [])); };
    game.step();
    // 30 m north of the hull, looking along -Z straight at it.
    Object.assign(spotter, { x: hull.x, y: 2, z: hull.z + 30, yaw: 0, pitch: -0.05, vehicleId: null });
    game.now += CONQUEST_RULES.spotCooldownMs + 1;
    assert.equal(game.mode.conquestIntent(spotter, { type: 'spot' }), true, 'wired hull spot accepted');
    game.step();
    const row = snapshot.vehicles?.find(r => r.id === 'bravo-tank');
    assert.equal(row?.sp, 1, 'vehicles[].sp marks the spotted enemy hull');
    assert.equal(snapshot.vehicles?.find(r => r.id === 'alpha-tank')?.sp, undefined, 'own hull is never marked');
    assert.ok(events.some(e => e.kind === 'spot' && e.by === String(spotter.id) && e.ids?.[0] === 'bravo-tank'),
      'spot event names the hull');
    // A teammate of the spotter destroys the marked hull: one spot assist.
    events.length = 0;
    game.vehicles.destroy(hull, killer);
    game.step();
    const assists = events.filter(e => e.kind === 'score' && e.reason === 'spot_assist');
    if (game.mode.phase === 'live') {
      assert.equal(assists.length, 1, 'one spot assist for the destroyed hull');
      assert.equal(assists[0].id, String(spotter.id), 'spot assist pays the spotter');
    } else {
      assert.equal(assists.length, 0, 'no awards outside the live phase');
    }
    assert.equal(wired.spotting.isVehicleSpotted('bravo-tank'), false, 'mark ends with the hull');
    console.log(`  real VehicleSystem hull spot: passed (phase ${game.mode.phase})`);
  }
}

console.log('Conquest spotting: cone, range and duration by kit, voxel and smoke line of sight, best target, hulls, cooldown, auto-spot on fire, spot assist once, real-engine LOS passed.');
