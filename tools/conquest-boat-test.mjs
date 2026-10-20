// Conquest patrol boat (docs/conquest.md, Patrol boat) on the real Frontier
// river: contract v6 topology, the waterjet handling (planing, hump, pivot,
// no thrust beached, clamped attitude), floating pads, a moored hull that
// publishes a level, unchanging row, the drive down the boat lane, banks and
// piers stopping it (it never climbs onto land), the wreck sinking to the
// bed and the 20 s respawn, crew exits into the water, light armour, deploy
// seats, and the bot river patrol (commander slots inside the crew cap, the
// lane, the stations off the crossing, a recall, and a crew that sails to
// its station and works the bow gun on an enemy on the bank).
import assert from 'node:assert/strict';
import { createMapState, getMapMeta } from '../shared/worlddata.js';
import { MC_WATER, isSolidBlock } from '../shared/world/blocks.js';
import { CONQUEST_CONTRACT_VERSION, VEHICLE_TYPE_IDS, VEHICLE_TOPOLOGY, COUNTERMEASURES, vehicleMountOrder, seatWeaponList, vehicleHullType } from '../shared/conquest-contract.js';
import { VEHICLE_RULES } from '../shared/vehicles.js';
import { vehicleDef, isBoatType, WALL_CRASH_RULES } from '../shared/vehicle-defs.js';
import { BOAT_RULES, stepBoatDrive, boatAttitude, boatPlaning, boatSwell } from '../shared/vehicle-handling/boat.js';
import { armorMultiplier } from '../shared/vehicle-armor.js';
import { VehicleSystem } from '../server/sim/vehicles.js';
import { BOAT_SWIM_EXIT_DEPTH, waterSurfaceAt } from '../server/sim/boat.js';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { hullSeatIds } from '../server/bot-commander.js';
import { BOAT_PATROL, boatLane, laneDistance, laneProgress, lanePoint, patrolStations, riverPatrolSlots } from '../server/bot-boat-driving.js';
import { vehicleSeatOccupantId } from '../shared/vehicle-seats.js';
import { mulberry32 } from '../shared/noise.js';
import { SLUICES } from '../shared/map-events/weir.js';
import * as THREE from '../public/js/vendor/three.module.js';
import { VEHICLE_MODEL_FACTORIES } from '../public/js/engine/vehicle-view.js';
import { BOAT_TOP } from '../public/js/vehicles/models/boat.js';

Math.random = mulberry32(Number(process.env.VB_TEST_SEED ?? 1));
const meta = getMapMeta('frontier'), world = createMapState('frontier');
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const WATER_FACE = meta.conquest.waterways[0].points[0][1];
const FLOAT = WATER_FACE - BOAT_RULES.draft;
// The north ford sluice's pond (docs/conquest.md "Ford sluices") holds the reach above ford-north one voxel higher.
const faceAt = p => SLUICES.map(s => s.pond).find(o => p.x >= o.x0 && p.x <= o.x1 && p.z >= o.z0 && p.z <= o.z1)?.faceY ?? WATER_FACE;
const floatAt = p => faceAt(p) - BOAT_RULES.draft;
const POND_FLOAT = Math.max(...SLUICES.map(s => s.pond.faceY)) - BOAT_RULES.draft;
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const system = () => {
  const engine = { world, mapMeta: meta, entities: new Map(), mode: { mode: 'conquest', canFire: () => true } };
  return { engine, vehicles: new VehicleSystem(engine) };
};
const crew = (engine, id, team, v, input = {}) => {
  const p = { id, team, state: 'alive', hp: 100, x: v.x, y: v.y, z: v.z, input: { keys: {}, vehicleThrottle: 0, vehicleSteer: 0, vehicleBrake: 0, ...input } };
  engine.entities.set(id, p);
  return p;
};
const run = (vehicles, seconds, each = null) => { for (let i = 0; i < Math.round(seconds * 60); i++) { vehicles.step(1 / 60); each?.(i / 60); } };

// ------------------------------------------------------------------ contract v6
{
  eq(CONQUEST_CONTRACT_VERSION, 8, 'contract v6 adds the patrol boat');
  eq(VEHICLE_TYPE_IDS.at(-1), 'boat', 'the boat is appended to the hull list');
  eq(VEHICLE_TOPOLOGY.boat.map(s => [s.id, s.role, s.drives, s.exposed, s.personalWeapons]), [
    ['driver', 'driver', true, true, false], ['gunner', 'gunner', false, true, false],
    ['rear-left', 'passenger', false, true, true], ['rear-right', 'passenger', false, true, true]]);
  eq([...vehicleMountOrder('boat')], ['gunner:bow']);
  eq(seatWeaponList('boat', 'gunner'), [{ mount: 'bow', weapon: 'hmg' }]);
  eq(COUNTERMEASURES.boat, null);
  eq(vehicleHullType('boat'), 'boat', 'the boat is its own hull, not a variant');
  ok(isBoatType('boat') && !isBoatType('jeep'), 'isBoatType');
  const def = vehicleDef('boat');
  eq([def.handling, def.armor, def.hp, def.respawnSeconds], ['boat', 'light', 360, 20]);
  eq(armorMultiplier('hmg', 'light'), 1, 'the .50 bites a boat in full');
  ok(armorMultiplier('small', 'light') < 0.5, 'rifles only scratch it');
}

// ------------------------------------------------------------------ handling (pure)
{
  const R = BOAT_RULES;
  const hull = () => ({ speed: 0, yaw: 0, course: 0, yawRate: 0 });
  // Full throttle from rest: through the hump, onto the plane, to top speed.
  const s = hull();
  let t = 0, humpAt = null, planeAt = null;
  while (t < 20) {
    stepBoatDrive(s, { throttle: 1 }, 1 / 60); t += 1 / 60;
    if (humpAt == null && s.speed > R.planeSpeed * 0.35) humpAt = t;
    if (planeAt == null && s.speed >= R.planeSpeed) planeAt = t;
  }
  ok(Math.abs(s.speed - R.speed) < 0.2, `top speed ${s.speed.toFixed(2)} m/s`);
  ok(planeAt > humpAt && planeAt - humpAt > (R.planeSpeed * 0.65) / R.acceleration, `the hump slows the climb onto the plane (${(planeAt - humpAt).toFixed(2)} s)`);
  ok(planeAt < 5, `on the plane in ${planeAt.toFixed(2)} s`);
  eq(boatPlaning(0), 0); eq(boatPlaning(R.speed), 1);
  // Steering: pivot at rest, full authority under way, the course trails the heading.
  const rest = hull();
  for (let i = 0; i < 120; i++) stepBoatDrive(rest, { steer: 1 }, 1 / 60);
  ok(Math.abs(rest.yawRate) > 0.3 && Math.abs(rest.yawRate) <= R.pivotTurn + 1e-9, `pivot turn at rest ${rest.yawRate.toFixed(2)} rad/s`);
  ok(Math.abs(rest.speed) < 1e-9, 'pivoting does not move the hull');
  const fast = { speed: 18, yaw: 0, course: 0, yawRate: 0 };
  for (let i = 0; i < 60; i++) stepBoatDrive(fast, { throttle: 1, steer: 1 }, 1 / 60);
  ok(Math.abs(fast.yawRate) > R.pivotTurn + 0.3, `full rudder under way ${fast.yawRate.toFixed(2)} rad/s`);
  ok(fast.yaw < 0, 'positive steer turns right (yaw decreases)');
  ok(Math.abs(fast.course - fast.yaw) > 0.02, 'a planing hull slides through the turn');
  // Beached: no water under the stern, no thrust; aground it only creeps.
  const beached = hull();
  for (let i = 0; i < 240; i++) stepBoatDrive(beached, { throttle: 1 }, 1 / 60, { wet: 0, aground: 1 });
  eq(beached.speed, 0, 'no water under the waterjet: no thrust');
  const grounded = hull();
  for (let i = 0; i < 240; i++) stepBoatDrive(grounded, { throttle: 1 }, 1 / 60, { wet: 1, aground: 1 });
  ok(grounded.speed > 0 && grounded.speed <= R.creep + 1e-9, `aground it creeps (${grounded.speed.toFixed(2)} m/s)`);
  // The attitude never capsizes, whatever the inputs; a hull at rest is level.
  for (const state of [{ speed: 20, yawRate: 0.95 }, { speed: -4.5, yawRate: -0.95 }, { speed: 1e6, yawRate: 1e6 }, { speed: NaN, yawRate: Infinity }]) {
    const a = boatAttitude(state, 1e4);
    ok(Math.abs(a.roll) <= R.maxRoll + 1e-12 && Math.abs(a.pitch) <= R.maxPitch + 1e-12, `attitude clamped for ${JSON.stringify(state)}`);
  }
  eq(boatAttitude({ speed: 0, yawRate: 0 }, 0), { pitch: 0, roll: 0 }, 'a hull at rest publishes a level attitude');
  ok(boatAttitude({ speed: 4, yawRate: 0 }, 0).pitch > 0.05, 'bow up on the hump');
  for (let t2 = 0; t2 < 30; t2 += 0.37) {
    const swell = boatSwell(t2, 370, 211, 0);
    ok(Math.abs(swell.pitch) <= R.bob && Math.abs(swell.roll) <= R.bob * 1.4 && Math.abs(swell.heave) <= 0.05, 'the presentation swell stays small');
  }
}

// ------------------------------------------------------------------ pads and mooring
{
  const { engine, vehicles } = system();
  const boats = [...vehicles.vehicles.values()].filter(v => v.type === 'boat');
  eq(boats.map(v => v.id).sort(), ['alpha-boat-north', 'alpha-boat-south', 'bravo-boat-north', 'bravo-boat-south']);
  for (const v of boats) {
    ok(waterSurfaceAt(world, v.x, v.z, v.y) === faceAt(v), `${v.id} moors on the river (or the north sluice's pond)`);
    eq(vehicles.placement(v, v.x, v.z), floatAt(v), `${v.id} floats the draft under the water face`);
    ok(flat(v, lanePoint(boatLane({ mapMeta: meta }), laneProgress(boatLane({ mapMeta: meta }), v))) < 12, `${v.id} moors beside the boat lane`);
  }
  // Moored and crewless: it settles, then publishes the same level row every tick.
  run(vehicles, 2);
  const rows = boats.map(v => JSON.stringify(vehicles.row(v, 0)));
  run(vehicles, 3);
  eq(boats.map(v => JSON.stringify(vehicles.row(v, 0))), rows, 'moored boats publish an unchanging row');
  for (const v of boats) { eq([v.pitch, v.roll, v.speed].map(Math.abs), [0, 0, 0], `${v.id} rests level`); eq(v.y, floatAt(v)); }
  void engine;
}

// ------------------------------------------------------------------ a run down the lane
{
  const { engine, vehicles } = system();
  const v = vehicles.vehicles.get('alpha-boat-north');
  const driver = crew(engine, 'helm', 'alpha', v);
  ok(vehicles.enter(driver, v.id, 'driver'), 'the helmsman boards');
  const lane = boatLane({ mapMeta: meta });
  let maxSpeed = 0, maxPitch = 0, maxRoll = 0, minY = Infinity, maxY = -Infinity;
  const startHp = v.hp;
  // A careful helmsman: pursue a point 14 m down the lane, open up on the straights, ease off
  // for the bends and take the Iron Bridge arch at 6 m/s. 25 s gets it past the bridge.
  run(vehicles, 25, () => {
    const s = laneProgress(lane, v), aim = lanePoint(lane, s + 14);
    const want = Math.atan2(-(aim.x - v.x), -(aim.z - v.z)), error = Math.atan2(Math.sin(want - v.yaw), Math.cos(want - v.yaw));
    const a = lanePoint(lane, s), b = lanePoint(lane, s + 12), c = lanePoint(lane, s + 30);
    const h1 = Math.atan2(b.x - a.x, b.z - a.z), h2 = Math.atan2(c.x - b.x, c.z - b.z), bend = Math.abs(Math.atan2(Math.sin(h2 - h1), Math.cos(h2 - h1)));
    const bridge = (meta.conquest.crossings ?? []).some(cr => cr.kind === 'bridge' && flat(cr, v) < 22);
    const target = bridge ? 6 : bend > 0.2 || Math.abs(error) > 0.3 ? 9 : 18;
    driver.input.vehicleSteer = Math.max(-1, Math.min(1, -error * 3));
    driver.input.vehicleThrottle = v.speed > target + 1 ? 0 : Math.min(1, 0.3 + (target - v.speed) * 0.2);
    driver.input.vehicleBrake = v.speed > target + 2 ? 1 : 0;
    maxSpeed = Math.max(maxSpeed, v.speed); maxPitch = Math.max(maxPitch, Math.abs(v.pitch)); maxRoll = Math.max(maxRoll, Math.abs(v.roll));
    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
  });
  ok(maxSpeed > 14, `the boat planes down the lane (${maxSpeed.toFixed(1)} m/s)`);
  const bridge = meta.conquest.crossings.find(cr => cr.kind === 'bridge' && Math.abs(cr.z - 390) < 20) ?? { z: 390 };
  ok(laneProgress(lane, v) > 200 && v.z > bridge.z + 10, `it covers the lane and passes under the Iron Bridge (${laneProgress(lane, v).toFixed(0)} m, z ${v.z.toFixed(0)})`);
  ok(maxPitch <= BOAT_RULES.maxPitch + 1e-9 && maxRoll <= BOAT_RULES.maxRoll + 1e-9 && maxRoll > 0.01, `trim ${maxPitch.toFixed(3)} and heel ${maxRoll.toFixed(3)} stay inside the clamp`);
  // It starts on the north sluice's pond and runs the boat chute down to the river's face.
  ok(minY >= FLOAT - 1e-6 && maxY <= POND_FLOAT + BOAT_RULES.maxStep + 1e-6, `it stays afloat (${minY.toFixed(2)}..${maxY.toFixed(2)})`);
  eq(v.hp, startHp, 'a well-steered run never touches a bank');
}

// ------------------------------------------------------------------ the model clears the bridge decks
{
  // Afloat and level, every part of the hull model stays under the lowest deck
  // over the boat lane (the Iron Bridge arch): no roof, mast or antenna through
  // a bridge (the presentation swell and trim graze it by centimetres at most).
  const lane = boatLane({ mapMeta: meta });
  let deck = Infinity;
  for (let s = 0; s <= lane.length; s += 0.5) {
    const p = lanePoint(lane, s);
    for (let y = WATER_FACE; y < WATER_FACE + 8; y++) if (isSolidBlock(world.getBlock(Math.floor(p.x), y, Math.floor(p.z)))) { deck = Math.min(deck, y); break; }
  }
  ok(Number.isFinite(deck), `a bridge deck spans the lane (underside y ${deck})`);
  const model = VEHICLE_MODEL_FACTORIES.boat({ team: 'alpha' });
  model.group.updateMatrixWorld(true);
  const top = new THREE.Box3().setFromObject(model.group).max.y;
  ok(FLOAT + top <= deck + 1e-6, `the boat model (top ${top.toFixed(2)} m over the keel) passes under the deck at ${deck} afloat at ${FLOAT}`);
  ok(Math.abs(top - BOAT_TOP) < 0.05, `the canopy roof is the model's highest point (${top.toFixed(2)})`);
}

// ------------------------------------------------------------------ banks: it never climbs onto land
{
  const { engine, vehicles } = system();
  const v = vehicles.vehicles.get('alpha-boat-south');
  const driver = crew(engine, 'helm', 'alpha', v, { vehicleThrottle: 1, vehicleSteer: 0.35 });
  ok(vehicles.enter(driver, v.id, 'driver'));
  let maxY = -Infinity, dry = 0;
  run(vehicles, 20, () => {
    maxY = Math.max(maxY, v.y);
    // Every footprint centre stays over a column with water (or the flush first bank row).
    const bx = Math.floor(v.x), bz = Math.floor(v.z);
    let wet = false;
    for (let dx = -2; dx <= 2 && !wet; dx++) for (let dz = -2; dz <= 2 && !wet; dz++) wet = world.getBlock(bx + dx, WATER_FACE - 1, bz + dz) === MC_WATER;
    if (!wet) dry++;
  });
  ok(maxY <= FLOAT + BOAT_RULES.maxStep + 1e-6, `circling into the banks it never climbs onto land (max y ${maxY.toFixed(2)})`);
  eq(dry, 0, 'the hull never leaves the river');
  ok(v.hp > 0, 'bank strikes cost hull, not the boat');
}

// ------------------------------------------------------------------ a full-speed bank strike
{
  const { engine, vehicles } = system();
  const v = vehicles.vehicles.get('alpha-boat-north');
  const driver = crew(engine, 'helm', 'alpha', v, { vehicleThrottle: 1 });
  ok(vehicles.enter(driver, v.id, 'driver'));
  // Flat out, square at the bank: one strike of at most a quarter of the hull, then it keeps
  // pressing into the bank without paying again inside the cooldown, and never climbs out.
  const hits = [];
  const damage = vehicles.damage.bind(vehicles);
  vehicles.damage = (id, amount, attacker, info) => { if (id === v.id && info?.cls === 'collision') hits.push({ amount, at: vehicles.contactClock }); return damage(id, amount, attacker, info); };
  Object.assign(v, { yaw: -Math.PI / 2, course: -Math.PI / 2, speed: BOAT_RULES.speed });
  let maxY = -Infinity;
  run(vehicles, 4, () => { maxY = Math.max(maxY, v.y); });
  ok(hits.length >= 1, 'driving flat out into the bank crashes');
  ok(hits.every(h => h.amount <= VEHICLE_RULES.boat.hp * WALL_CRASH_RULES.boat.maxShare + 1e-9), `each strike costs at most ${WALL_CRASH_RULES.boat.maxShare * 100}% of the hull`);
  ok(hits.every((h, i) => i === 0 || h.at - hits[i - 1].at >= WALL_CRASH_RULES.boat.crashSeconds - 1e-9), 'one strike per crashSeconds');
  ok(v.hp > VEHICLE_RULES.boat.hp * 0.5, `the boat survives a bank strike (${v.hp.toFixed(0)} hp)`);
  ok(maxY <= floatAt(v) + BOAT_RULES.maxStep + 1e-6, 'and stays in the water');
}

// ------------------------------------------------------------------ crew exits into the water
{
  const { engine, vehicles } = system();
  const v = vehicles.vehicles.get('alpha-boat-north');
  // Out in the middle of the wide reach (clear of both banks).
  Object.assign(v, { x: 376, z: 226, yaw: Math.PI, course: Math.PI });
  v.y = vehicles.placement(v, v.x, v.z);
  const rider = crew(engine, 'rider', 'alpha', v);
  ok(vehicles.enter(rider, v.id, 'rear-left'), 'a passenger boards');
  vehicles.exit(rider);
  ok(!rider.vehicleId, 'the passenger is out');
  ok(Math.abs(rider.y - (faceAt(v) - BOAT_SWIM_EXIT_DEPTH)) < 1e-6, `mid-river the exit is into the water (y ${rider.y.toFixed(2)})`);
  ok(flat(rider, v) < 4 && rider.y < floatAt(v) + 1, 'beside the hull, never on its roof');
}

// ------------------------------------------------------------------ wreck sinks, pad respawns in 20 s
{
  const { engine, vehicles } = system();
  const v = vehicles.vehicles.get('bravo-boat-north');
  const pad = { x: v.x, z: v.z };
  Object.assign(v, { x: v.x - 6, course: v.yaw });
  v.y = vehicles.placement(v, v.x, v.z);
  vehicles.damage(v.id, 10000, null, { cls: 'at' });
  ok(!(v.hp > 0), 'an AT hit wrecks the boat');
  const sunkFrom = v.y;
  run(vehicles, 8);
  ok(v.hp === 0 && v.y < sunkFrom - 1.5, `the wreck sinks toward the bed (${sunkFrom.toFixed(2)} -> ${v.y.toFixed(2)})`);
  ok(v.pitch > 0.1 && v.roll > 0.1, 'stern first and listing');
  const bedY = v.y;
  run(vehicles, 3);
  ok(Math.abs(v.y - bedY) < 0.05, `it comes to rest on the bed (y ${v.y.toFixed(2)})`);
  run(vehicles, 11);
  ok(v.hp === VEHICLE_RULES.boat.hp, 'the pad respawns the boat 20 s after its loss');
  ok(flat(v, pad) < 0.01 && Math.abs(v.y - FLOAT) < 0.03, `back on its mooring, afloat (y ${v.y.toFixed(2)})`);
  void engine;
}

// ------------------------------------------------------------------ deploy seats
{
  const events = [];
  const game = new GameEngine({ mode: 'conquest', world, mapMeta: meta, broadcast: snap => events.push(...(snap.events ?? [])) });
  game.addClient('deployer', 'Deployer');
  const human = game.entities.get('deployer');
  const team = human.team;
  const options = game.mode.policy.conquestView().deployOptions(human);
  const boats = options.filter(o => o.kind === 'vehicle' && o.type === 'boat');
  eq(boats.map(o => o.id).sort(), [`${team}-boat-north`, `${team}-boat-south`], 'the deploy screen lists both own boats');
  for (const o of boats) eq([o.ok, o.seats], [true, ['driver', 'gunner', 'rear-left', 'rear-right']], `${o.id} offers every seat`);
  if (human.state === 'alive') game.killPlayer(human, null, 'redeploy', false);
  ok(game.mode.conquestIntent(human, { type: 'deploy', spawn: `vehicle:${team}-boat-north:gunner`, kit: 'assault', variant: 0 }), 'deploying onto the bow gun is accepted');
  for (let t = 0; t < 12000 / TICK_MS && human.state !== 'alive'; t++) game.step(TICK_MS);
  eq([human.state, human.vehicleId, human.vehicleSeatId], ['alive', `${team}-boat-north`, 'gunner'], 'the deploy seats the player on the bow gun');
  game.removeClient?.('deployer');
  game.stop?.();
}

// ------------------------------------------------------------------ bot river patrol
{
  const game = { mapMeta: meta };
  const lane = boatLane(game);
  ok(lane && lane.points.length >= 30 && lane.length > 450, `boat lane ${lane.length.toFixed(0)} m`);
  const C = meta.conquest.flags.find(f => f.id === 'C');
  const stations = patrolStations(game, lane, C);
  eq(stations.length, 2);
  for (const s of stations) {
    ok(flat(s, C) > C.radius, `station ${s.x.toFixed(0)},${s.z.toFixed(0)} lies outside the Iron Bridge zone`);
    ok(Math.abs(Math.atan2(Math.sin(s.face - Math.atan2(-(C.x - s.x), -(C.z - s.z))), 1)) < 0.3, 'the bow faces the crossing');
  }
  ok(stations[0].z < C.z && stations[1].z > C.z, 'one station each side of the bridge');
  // Commander slots: none below the bot threshold; driver then gunner; a recall for a crew out on the river.
  const { vehicles } = system();
  const hulls = [...vehicles.vehicles.values()].filter(v => v.team === 'alpha');
  eq(riverPatrolSlots(game, hulls, BOAT_PATROL.minTeamBots - 1, C, hullSeatIds, () => true).slots, []);
  for (const far of meta.conquest.flags.filter(f => f.id !== 'C')) {
    ok(laneDistance(lane, far) > BOAT_PATROL.focusReach, `flag ${far.id} lies beyond the bow gun's reach of the river`);
    eq(riverPatrolSlots(game, hulls, 8, far, hullSeatIds, () => true).slots, [], `no patrol for flag ${far.id}`);
  }
  const { slots } = riverPatrolSlots(game, hulls, 8, C, hullSeatIds, () => true);
  eq(slots.map(s => [s.v.type, s.seat]), [['boat', 'driver'], ['boat', 'gunner']]);
  ok(slots[0].prio > 1 && slots[0].prio < 2, 'after the attack helicopter, before the jet');
  const boat = slots[0].v;
  Object.assign(boat, { x: boat.x + 30, seatOccupants: { ...boat.seatOccupants, driver: 'bot-x' } });
  const out = riverPatrolSlots(game, hulls, 4, C, hullSeatIds, id => id === 'bot-x');
  eq(out.recall.map(s => [s.v.id, s.seat, s.recall]), [[boat.id, 'driver', true], [boat.id, 'gunner', true]], 'a bot crew out on the river is recalled');
}
{
  // The commander's patrol booking: both boat seats inside the crew cap (in
  // the jet's budget slot while the helicopter is down), sorties of sortieMs,
  // then restMs with the boat at its mooring and no booking, then a new sortie.
  const game = new GameEngine({ mode: 'conquest', world, mapMeta: meta, broadcast: () => {} });
  const bots = attachBots(game, 16);
  game.step(TICK_MS);
  const commander = bots.commander, C = meta.conquest.flags.find(f => f.id === 'C');
  commander.focusFlag = () => C;
  const ts = commander.teams.get('alpha');
  const alpha = bots.brains.map(br => game.entities.get(br.id)).filter(p => game.mode.teamFor(p) === 'alpha');
  game.vehicles.vehicles.get('alpha-helicopter').hp = 0;
  const boat = game.vehicles.vehicles.get('alpha-boat-south');
  const types = () => [...ts.crews.values()].map(c => `${game.vehicles.vehicles.get(c.vehicleId)?.type}:${c.seatId}`).sort();
  const boatCrews = () => types().filter(t => t.startsWith('boat:'));
  const plan = now => { game.mode.policy._view = null; commander.viewAt = -1; commander.plan(now); };
  const cap = Math.ceil(alpha.length / 3), t0 = game.now;
  plan(t0 - 1000);
  // Two bots booked on a squad ride stand on the bank by the mooring: they are
  // not free, so the boat is not booked in the jet's place for nobody to man.
  const riding = () => new Set([...ts.transits.values()].flatMap(t => [...t.seats.keys()]));
  const free = () => { const busy = riding(); return alpha.filter(p => !ts.crews.has(p.id) && !ts.hitches.has(p.id) && !busy.has(p.id)); };
  const riders = alpha.filter(p => riding().has(p.id)).slice(0, 2);
  if (riders.length === 2) {
    for (const p of riders) Object.assign(p, { state: 'alive', x: boat.x - 5, y: 23, z: boat.z, vehicleId: null });
    plan(t0 - 500);
    eq(boatCrews(), [], 'squad riders by the mooring are no boat crew');
    ok(types().includes('plane:driver') || !game.vehicles.vehicles.get('alpha-plane').hp, `the jet keeps its pilot (${types()})`);
    for (const p of riders) Object.assign(p, { x: p.x - 200 });
  }
  // Two free bots on the bank by the mooring: in walking reach of the boat.
  for (const p of free().slice(0, 2)) Object.assign(p, { state: 'alive', x: boat.x - 5, y: 23, z: boat.z, vehicleId: null });
  plan(t0);
  eq(boatCrews(), ['boat:driver', 'boat:gunner'], `a sortie books helmsman and bow gunner (${types()})`);
  ok(ts.crews.size <= cap, `inside the crew cap (${ts.crews.size} <= ${cap})`);
  ok(!types().includes('plane:driver'), 'ranked before the jet: the jet waits for budget');
  ok([...ts.crews.values()].every(c => game.vehicles.vehicles.get(c.vehicleId)?.type !== 'boat' || c.vehicleId === boat.id), 'one boat per team');
  plan(t0 + BOAT_PATROL.sortieMs - 1000);
  eq(boatCrews().length, 2, 'the sortie runs on');
  plan(t0 + BOAT_PATROL.sortieMs + 500);
  eq(boatCrews(), [], 'after sortieMs the booking ends (a moored boat needs no recall)');
  plan(t0 + BOAT_PATROL.sortieMs + BOAT_PATROL.restMs - 1000);
  eq(boatCrews(), [], 'the boat rests at its mooring for restMs');
  // The rested crew went back to the fight; two other free bots come by the mooring.
  for (const p of free().slice(0, 2)) Object.assign(p, { state: 'alive', x: boat.x - 5, y: 23, z: boat.z, vehicleId: null });
  plan(t0 + BOAT_PATROL.sortieMs + BOAT_PATROL.restMs + 1000);
  eq(boatCrews(), ['boat:driver', 'boat:gunner'], `then the next sortie books it again (${types()})`);
  // Out on the river with a bot at the helm when the cap fills (the helicopter is back): a recall, not a bail-out.
  const pilot = alpha.find(p => !ts.crews.has(p.id));
  Object.assign(boat, { x: boat.x + 30, seatOccupants: { ...boat.seatOccupants, driver: [...ts.crews].find(([, c]) => c.vehicleId === boat.id && c.seatId === 'driver')[0] } });
  game.vehicles.vehicles.get('alpha-helicopter').hp = vehicleDef('helicopter').hp;
  game.vehicles.vehicles.get('alpha-plane').hp = 0;
  plan(t0 + BOAT_PATROL.sortieMs + BOAT_PATROL.restMs + 2000);
  ok(types().includes('helicopter:driver') && [...ts.crews.values()].filter(c => c.vehicleId === boat.id).every(c => c.slot?.recall), `the helicopter takes the cap back and the boat crew is recalled (${types()})`);
  void pilot;
  bots.dispose(); game.stop();
}
{
  // A live crew: sails the lane to its station by the Iron Bridge and works the bow gun on an enemy on the bank.
  const game = new GameEngine({ mode: 'conquest', world, mapMeta: meta, broadcast: () => {} });
  const bots = attachBots(game, 16);
  game.step(TICK_MS);
  const flag = meta.conquest.flags.find(f => f.id === 'C');
  const boat = game.vehicles.vehicles.get('alpha-boat-north');
  const brains = bots.brains.filter(br => game.mode.teamFor(game.entities.get(br.id)) === 'alpha');
  const [d, g] = brains.slice(0, 2).map(br => game.entities.get(br.id));
  const crewFor = bots.commander.crewFor.bind(bots.commander);
  bots.commander.crewFor = id => String(id) === String(d.id) ? { role: 'crew', vehicleId: boat.id, seatId: 'driver', prio: 1.5, flag }
    : String(id) === String(g.id) ? { role: 'crew', vehicleId: boat.id, seatId: 'gunner', prio: 1.6, flag } : crewFor(id);
  for (let i = 0; i < 400 && !(d.state === 'alive' && g.state === 'alive'); i++) game.step(TICK_MS);
  for (const q of [d, g]) Object.assign(q, { x: boat.x, y: boat.y + 0.5, z: boat.z });
  ok(game.vehicles.enter(d, boat.id, 'driver') && game.vehicles.enter(g, boat.id, 'gunner'), 'the crew boards');
  const inputs = [];
  const applyInput = game.applyInput.bind(game);
  game.applyInput = (id, input) => {
    if (String(id) === String(d.id)) for (const key of ['x', 'y', 'z', 'vehiclePosition']) assert.ok(!(key in input), 'AI never supplies position overrides');
    if (String(id) === String(d.id)) inputs.push(input.vehicleThrottle ?? 0);
    applyInput(id, input);
  };
  const lane = boatLane(game);
  const stations = patrolStations(game, lane, flag);
  let reached = null;
  for (let t = 0; t < 70000 / TICK_MS && reached == null; t++) {
    game.step(TICK_MS);
    if (stations.some(s => flat(s, boat) < BOAT_PATROL.arrive + 1)) reached = t * TICK_MS / 1000;
    if (!(boat.hp > 0)) break;
  }
  ok(reached != null, `the patrol reaches its station by the Iron Bridge (${reached?.toFixed(1)} s)`);
  ok(inputs.some(x => x > 0.5), 'the helmsman drives with ordinary throttle input');
  eq(vehicleSeatOccupantId(boat, 'gunner'), g.id, 'the gunner stays on the bow gun');
  // An enemy rifleman on the nearest dry bank: the bow .50 engages him.
  let target = null;
  for (let i = 0; i < 6 && !target; i++) {
    game.addClient(`rifleman-${i}`, 'Rifleman');
    const q = game.entities.get(`rifleman-${i}`);
    if (game.mode.teamFor(q) === 'bravo') target = q;
  }
  ok(target, 'an enemy rifleman joins bravo');
  let bank = null;
  for (let r = 8; r < 40 && !bank; r++) for (const sx of [1, -1]) {
    const x = Math.floor(boat.x + sx * r), z = Math.floor(boat.z);
    if (world.getBlock(x, WATER_FACE - 1, z) === MC_WATER) continue;
    for (let y = 40; y > 15; y--) if (isSolidBlock(world.getBlock(x, y, z))) { bank = { x: x + 0.5, y: y + 1, z: z + 0.5 }; break; }
    if (bank && (bank.y > WATER_FACE + 4 || flat(bank, boat) > 35)) bank = null;
    if (bank) break;
  }
  ok(bank, 'a dry bank within 35 m of the station');
  let gunnerFire = 0, minHp = 100;
  const hits = [];
  const killPlayer = game.killPlayer.bind(game);
  game.killPlayer = (victim, killer, weaponKey, ...rest) => { if (victim === target) hits.push([String(killer?.id ?? killer ?? ''), weaponKey]); return killPlayer(victim, killer, weaponKey, ...rest); };
  game.applyInput = (id, input) => {
    if (String(id) === String(g.id) && input.wantFire) gunnerFire++;
    applyInput(id, input);
  };
  for (let t = 0; t < 12000 / TICK_MS && minHp > 0; t++) {
    if (target.state === 'alive') Object.assign(target, { x: bank.x, y: bank.y, z: bank.z, vx: 0, vy: 0, vz: 0, spawnProtectedUntil: 0 });
    else if (minHp === 100) Object.assign(target, { x: bank.x, y: bank.y, z: bank.z, state: 'alive', hp: 100, spawnProtectedUntil: 0 });
    game.step(TICK_MS);
    minHp = Math.min(minHp, target.state === 'alive' ? target.hp : 0);
  }
  ok(gunnerFire > 0 && minHp < 100, `the bow gunner engages a rifleman on the bank ${flat(bank, boat).toFixed(0)} m off (${gunnerFire} trigger ticks, his hp down to ${minHp.toFixed(0)})`);
  ok(minHp > 0 || hits.some(([killer, weapon]) => killer === String(g.id) && weapon === 'hmg'), `a kill on him is the bow gunner's .50 (${JSON.stringify(hits)})`);
  bots.dispose(); game.stop();
}

console.log(`Conquest patrol boat: ${checks} checks passed (contract v6, waterjet handling, floating pads, level moored rows, lane run, banks, water exits, sinking wreck and 20 s respawn, deploy seats, bot river patrol).`);
