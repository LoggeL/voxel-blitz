// Aircraft crews (server/bot-aircraft.js) on the real Frontier v2 map, flying
// through the same signed control inputs humans send: the attack helicopter
// circle-strafes 60-90 m around its flag and breaks off at 50 %, the chin
// gunner and the door gunners engage infantry, the transport drops its squad
// and lifts off again (no land-and-exit), the jet flies attack runs instead of
// a loiter, the flare reflex follows a lock, and canopy sight reaches 250 m.
import assert from 'node:assert/strict';
import { createMapState, getMapMeta } from '../shared/worlddata.js';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { HELI_ORBIT, HELI_BREAK_HP, JET_RUN } from '../server/bot-aircraft.js';
import { observeBotVehicle } from '../server/bot-vehicle-combat.js';
import { BOT_AIRCRAFT_SIGHT_RANGE, botDifficulty } from '../shared/bot-difficulty.js';
import { vehicleMaxHp } from '../shared/vehicles.js';
import { vehicleSeatOccupantId } from '../shared/vehicle-seats.js';
import { mulberry32 } from '../shared/noise.js';

// Reproducible: spread and spawn picks draw from Math.random.
Math.random = mulberry32(Number(process.env.VB_TEST_SEED ?? 1));

const meta = getMapMeta('frontier');
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const flagC = meta.conquest.flags.find(f => f.id === 'C');

/**
 * Fixture: `n` alpha bots and `enemies` bravo infantry (humans, so they never
 * move), every bot seated by hand and given a fixed crew order by overriding
 * the commander's crewFor for the bots under test.
 */
function fixture({ type, seats, enemies = 0, enemyAt = flagC }) {
  const game = new GameEngine({ mode: 'conquest', world: createMapState('frontier'), mapMeta: meta, broadcast: snap => events.push(...snap.events) });
  const events = [];
  const bots = attachBots(game, seats.length);
  const hull = game.vehicles.vehicles.get(`alpha-${type}`);
  const crew = [];
  for (const [i, seatId] of seats.entries()) {
    const p = game.entities.get(bots.brains[i].id);
    game.mode.policy.setLobbyTeam?.(p, 'alpha');
    Object.assign(p, { x: hull.x, y: hull.y, z: hull.z, spawnProtectedUntil: 0 });
    assert(game.vehicles.enter(p, hull.id, seatId), `bot seated in ${type} ${seatId}`);
    crew.push(p);
  }
  const foes = [];
  for (let i = 0; i < enemies; i++) {
    game.addClient(`foe-${i}`, `Foe ${i}`);
    const foe = game.entities.get(`foe-${i}`);
    game.mode.policy.setLobbyTeam?.(foe, 'bravo');
    const s = enemyAt.spawns?.[i % (enemyAt.spawns.length || 1)] ?? enemyAt;
    Object.assign(foe, { x: s.x, y: s.y, z: s.z, spawnProtectedUntil: 0 });
    foes.push(foe);
  }
  const orders = new Map();
  const crewFor = bots.commander.crewFor.bind(bots.commander);
  bots.commander.crewFor = id => orders.get(String(id)) ?? crewFor(id);
  const keepFoes = () => {
    for (const foe of foes) {
      foe.hp = Math.max(foe.hp, 100);
      if (foe.state !== 'alive') game.respawnPlayer?.(foe, { x: foe.x, y: foe.y, z: foe.z });
    }
  };
  return { game, bots, hull, crew, foes, orders, events, keepFoes };
}
const ground = (game, p) => { let y = Math.min(game.world.dimensions.sy - 1, Math.floor(p.y)); while (y > 0 && !game.solidAt(Math.floor(p.x), y, Math.floor(p.z))) y--; return y + 1; };

// --- attack helicopter: circle-strafe 60-90 m, chin gunner, break off at 50 % --------------
{
  const f = fixture({ type: 'helicopter', seats: ['driver', 'gunner'], enemies: 3 });
  const [pilot, gunner] = f.crew;
  f.orders.set(pilot.id, { role: 'crew', vehicleId: f.hull.id, seatId: 'driver', flag: flagC });
  f.orders.set(gunner.id, { role: 'crew', vehicleId: f.hull.id, seatId: 'gunner', flag: flagC });
  const ring = [];
  let minAgl = Infinity;
  for (let i = 0; i < Math.round(75000 / TICK_MS); i++) {
    f.keepFoes();
    f.game.step(TICK_MS);
    const state = f.bots.aircraftDriving.drivers.get(pilot.id);
    if (state?.phase === 'orbit') {
      ring.push(flat(f.hull, flagC));
      minAgl = Math.min(minAgl, f.hull.y - ground(f.game, f.hull));
    }
  }
  assert(ring.length > 600, `the helicopter reaches its orbit (${ring.length} samples)`);
  const settled = ring.slice(Math.floor(ring.length / 3)).sort((a, b) => a - b);
  const median = settled[Math.floor(settled.length / 2)];
  assert(median >= HELI_ORBIT.min - 8 && median <= HELI_ORBIT.max + 12, `circle-strafe holds 60-90 m around the flag (median ${median.toFixed(1)} m)`);
  assert(minAgl > 8, `the orbit stays clear of the terrain (min AGL ${minAgl.toFixed(1)} m)`);
  const pods = f.events.filter(e => e.kind === 'shoot' && e.vehicleWeapon === 'helicopterRocket').length;
  const chin = f.events.filter(e => e.kind === 'shoot' && e.vehicleWeapon === 'chinCannon').length;
  assert(pods > 0, `the pilot makes rocket passes (${pods})`);
  assert(chin > 0, `the gunner bot works the chin gun (${chin})`);
  // Break off below 50 %: head for the pad and land.
  f.hull.hp = vehicleMaxHp('helicopter') * (HELI_BREAK_HP - 0.08);
  const start = flat(f.hull, f.hull.spawn);
  let phase = null;
  for (let i = 0; i < Math.round(40000 / TICK_MS); i++) {
    f.game.step(TICK_MS);
    phase = f.bots.aircraftDriving.drivers.get(pilot.id)?.phase;
    if (phase === 'rest') break;
  }
  assert(['breakoff', 'land', 'rest'].includes(phase), `a damaged helicopter breaks off (${phase})`);
  assert(flat(f.hull, f.hull.spawn) < start - 30 || phase === 'rest', 'it flies back toward its pad');
  f.bots.dispose(); f.game.stop();
}

// --- transport: drop the squad at the landing zone, lift off again -----------------------
{
  const f = fixture({ type: 'transport', seats: ['driver', 'rear-left', 'rear-right'] });
  const [pilot, a, b] = f.crew;
  const destination = { x: flagC.x - 120, y: flagC.y, z: flagC.z - 40 };
  const transit = { vehicleId: f.hull.id, squadId: 1, seats: new Map([[pilot.id, 'driver'], [a.id, 'rear-left'], [b.id, 'rear-right']]),
    destination, flagId: 'C', createdAt: f.game.now, departAt: 0, until: f.game.now + 80000, done: false };
  for (const [id, seatId] of transit.seats) f.orders.set(id, { role: 'transit', vehicleId: f.hull.id, seatId, transit, destination });
  let dropAt = null, liftAfterDrop = 0, pilotExited = false, peak = 0;
  for (let i = 0; i < Math.round(90000 / TICK_MS); i++) {
    f.game.step(TICK_MS);
    peak = Math.max(peak, f.hull.y - ground(f.game, f.hull));
    const out = [a, b].filter(p => p.vehicleId !== f.hull.id).length;
    if (out === 2 && dropAt === null) dropAt = { x: f.hull.x, z: f.hull.z, y: f.hull.y };
    if (dropAt) liftAfterDrop = Math.max(liftAfterDrop, f.hull.y - dropAt.y);
    if (pilot.vehicleId !== f.hull.id) pilotExited = true;
    if (dropAt && liftAfterDrop > 12) break;
  }
  assert(peak > 15, `the transport flies (peak ${peak.toFixed(1)} m AGL)`);
  assert(dropAt, 'both passengers dismount');
  assert(flat(dropAt, destination) < 40, `the squad is dropped at its landing zone (${flat(dropAt, destination).toFixed(1)} m)`);
  assert(!pilotExited, 'the pilot never lands and exits at the target');
  assert(liftAfterDrop > 12, `the transport lifts off after the drop (${liftAfterDrop.toFixed(1)} m)`);
  f.bots.dispose(); f.game.stop();
}

// --- door gunner on infantry inside its arc -------------------------------------------------
{
  const f = fixture({ type: 'transport', seats: ['door-left'], enemies: 2, enemyAt: { x: 0, y: 0, z: 0, spawns: [] } });
  const [gunner] = f.crew;
  f.orders.set(gunner.id, { role: 'crew', vehicleId: f.hull.id, seatId: 'door-left', flag: flagC });
  // Two enemy soldiers in the open, left of the parked transport, 25-35 m out.
  const left = { x: -Math.cos(f.hull.yaw), z: Math.sin(f.hull.yaw) };
  f.foes.forEach((foe, i) => {
    const x = f.hull.x + left.x * (25 + i * 8), z = f.hull.z + left.z * (25 + i * 8);
    Object.assign(foe, { x, y: ground(f.game, { x, y: f.hull.y + 4, z }) + 0.02, z });
  });
  const start = f.foes.map(foe => foe.hp);
  for (let i = 0; i < Math.round(8000 / TICK_MS); i++) f.game.step(TICK_MS);
  const shots = f.events.filter(e => e.kind === 'shoot' && e.vehicleWeapon === 'doorMinigun').length;
  assert(shots > 0, `the door gunner fires at infantry in its arc (${shots})`);
  assert(f.foes.some((foe, i) => foe.hp < start[i] || foe.state !== 'alive'), 'the door gun hits');
  assert.equal(gunner.vehicleId, f.hull.id, 'the gunner stays on its gun');
  f.bots.dispose(); f.game.stop();
}

// --- jet: attack runs, not a loiter ---------------------------------------------------------
{
  const f = fixture({ type: 'plane', seats: ['driver'], enemies: 3 });
  const [pilot] = f.crew;
  // The targets stand in the open (nothing overhead for 40 m), e.g. not under the bridge truss.
  const open = flagC.spawns.concat(meta.conquest.flags.flatMap(fl => fl.spawns))
    .filter(s => flat(s, flagC) < 60 && [...Array(40).keys()].every(dy => !f.game.solidAt(Math.floor(s.x), Math.floor(s.y) + 1 + dy, Math.floor(s.z))));
  assert(open.length >= 3, 'open ground near flag C for the strafing targets');
  f.foes.forEach((foe, i) => Object.assign(foe, { x: open[i].x, y: open[i].y, z: open[i].z }));
  f.orders.set(pilot.id, { role: 'crew', vehicleId: f.hull.id, seatId: 'driver', flag: flagC });
  const phases = new Set();
  let dives = 0, last = null, minAgl = Infinity, diveAgl = Infinity, closest = Infinity, airborne = false;
  for (let i = 0; i < Math.round(120000 / TICK_MS); i++) {
    f.keepFoes();
    f.game.step(TICK_MS);
    const state = f.bots.aircraftDriving.drivers.get(pilot.id);
    if (!state) continue;
    phases.add(state.phase);
    if (state.phase === 'dive' && last !== 'dive') dives++;
    last = state.phase;
    if (f.hull.grounded === false) airborne = true;
    if (airborne && state.phase !== 'climb' && state.phase !== 'takeoff') minAgl = Math.min(minAgl, f.hull.y - ground(f.game, f.hull));
    if (state.phase === 'dive') diveAgl = Math.min(diveAgl, f.hull.y - ground(f.game, f.hull));
    if (state.phase === 'dive') closest = Math.min(closest, flat(f.hull, flagC));
  }
  assert(f.hull.hp > 0, 'the jet survives its own flying');
  for (const phase of ['climb', 'ingress', 'turnin', 'dive', 'extend']) assert(phases.has(phase), `the jet flies the ${phase} phase`);
  assert(!phases.has('loiter'), 'no 150 m loiter');
  assert(dives >= 2, `repeated attack runs (${dives})`);
  assert(closest < JET_RUN.rollIn, `the dives close on the target (${closest.toFixed(0)} m)`);
  assert(minAgl > 15, `the jet never flies into the ground (min AGL ${minAgl.toFixed(1)} m)`);
  assert(diveAgl >= JET_RUN.pullUpAgl - 25 && diveAgl < JET_RUN.cruiseAgl, `dives go down toward 60 m AGL and pull out (dive min AGL ${diveAgl.toFixed(1)} m)`);
  const cannon = f.events.filter(e => e.kind === 'shoot' && e.vehicleWeapon === 'planeCannon').length;
  assert(cannon > 0, `the jet fires its cannon on the runs (${cannon})`);
  f.bots.dispose(); f.game.stop();
}

// --- flare reflex and canopy sight -----------------------------------------------------------
{
  const f = fixture({ type: 'helicopter', seats: ['driver'] });
  const [pilot] = f.crew;
  f.orders.set(pilot.id, { role: 'crew', vehicleId: f.hull.id, seatId: 'driver', flag: flagC });
  const actions = [];
  const apply = f.game.applyInput.bind(f.game);
  f.game.applyInput = (id, input) => { if (input.vehicleAction) actions.push({ id, type: input.vehicleAction.type, at: f.game.now }); apply(id, input); };
  for (let i = 0; i < 300; i++) f.game.step(TICK_MS);
  const lockAt = f.game.now;
  let cmAt = null;
  for (let i = 0; i < 120 && cmAt === null; i++) {
    f.hull.lk = 2;
    f.game.step(TICK_MS);
    cmAt = actions.find(a => a.id === pilot.id && a.type === 'cm' && a.at >= lockAt)?.at ?? null;
  }
  const reaction = botDifficulty(f.bots.brains[0].difficulty).countermeasureMs;
  assert(cmAt !== null, 'a locked helicopter releases flares');
  assert(cmAt - lockAt >= reaction - TICK_MS && cmAt - lockAt <= reaction + 3 * TICK_MS, `flares after the ${reaction} ms reaction (${cmAt - lockAt} ms)`);
  // Canopy sight: 250 m on every difficulty, beyond any infantry sight range.
  assert.equal(BOT_AIRCRAFT_SIGHT_RANGE, 250);
  const enemy = f.game.vehicles.vehicles.get('bravo-tank');
  const observer = { x: enemy.x + 230, eyeY: enemy.y + 40, z: enemy.z, yaw: Math.PI / 2, pitch: -0.15 };
  assert.equal(observeBotVehicle(observer, enemy, () => false, null, f.game.now, false, 'easy'), null, 'infantry sight does not reach 230 m');
  assert(observeBotVehicle(observer, enemy, () => false, null, f.game.now, false, 'easy', { sightRange: BOT_AIRCRAFT_SIGHT_RANGE }), 'canopy sight reaches 230 m');
  f.bots.dispose(); f.game.stop();
}

console.log('Conquest bot aircraft: helicopter circle-strafe and break-off, chin and door gunners, transport drop and lift-off, jet attack runs, flare reflex and 250 m canopy sight passed.');
