// Frontier v2 fleet (spec 4.4): fifteen hulls on terrain-derived pads. Every
// parked hull rests on prepared ground with room to pivot, no hull overlaps
// another, every HQ hull has a clear infantry pickup route, the ground hulls
// drive out of their bays and every aircraft departs without striking scenery.
import assert from 'node:assert/strict';
import { createMapState, getMapMeta } from '../shared/world/templates.js';
import { isSolidBlock } from '../shared/world/blocks.js';
import { VEHICLE_RULES, vehicleEnterDistance } from '../shared/vehicles.js';
import { vehicleSeats } from '../shared/vehicle-seats.js';
import { vehicleHullParts, hullBoxesOverlap } from '../shared/vehicle-collision.js';
import { playerHullContact } from '../shared/player-vehicle-collision.js';
import { PHYSICS, boxCollides, solidBelow } from '../shared/player-movement.js';
import { VehicleSystem } from '../server/sim/vehicles.js';

const meta = getMapMeta('frontier'), world = createMapState('frontier');
const engine = () => ({ world, mapMeta: meta, entities: new Map(), mode: { canFire: () => true } });
const parked = new VehicleSystem(engine());
const hulls = [...parked.vehicles.values()];
const live = hulls.filter(v => v.hp > 0);
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const solidAt = (x, y, z) => isSolidBlock(world.getBlock(x, y, z));
const sample = (route, visit) => {
  for (let j = 1; j < route.length; j++) {
    const a = route[j - 1], b = route[j], n = Math.max(1, Math.ceil(distance(a, b) * 4));
    for (let i = 0; i <= n; i++) visit({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n, z: a.z + (b.z - a.z) * i / n });
  }
};

assert.equal(hulls.length, 15, 'fifteen hulls');
assert.equal(new Set(hulls.map(v => v.id)).size, 15);
const seats = {};
for (const team of ['alpha', 'bravo']) {
  const fleet = hulls.filter(v => v.team === team);
  assert.equal(fleet.length, 7, `${team}: HQ five plus two flag jeeps`);
  assert.deepEqual(fleet.map(v => v.type).sort(), ['helicopter', 'jeep', 'jeep', 'jeep', 'plane', 'tank', 'transport']);
  seats[team] = fleet.reduce((sum, v) => sum + vehicleSeats(v).length, 0);
}
const cTank = parked.vehicles.get('flag-C-tank');
assert.ok(cTank && cTank.team === null && cTank.hp === 0 && cTank.padInactive, 'the C tank waits for the first capture');
assert.ok(cTank.spawn.alt && cTank.spawn.flag === 'C', 'the C pad carries its east-bank alternate');

for (const hull of live) {
  const floor = parked.placement(hull, hull.x, hull.z);
  assert.ok(floor != null && Math.abs(floor - (hull.y - 0.02)) < 1e-6, `${hull.id} rests on balanced prepared terrain (${floor} vs ${hull.y})`);
  for (let a = 0; a < 32; a++) assert.ok(parked.clearHull(hull, hull.x, hull.y, hull.z, a * Math.PI / 16), `${hull.id} has room for its entire rotating body`);
  for (const other of live) if (other.id > hull.id)
    assert.ok(!vehicleHullParts(hull).some(a => vehicleHullParts(other).some(b => hullBoxesOverlap(a, b))), `${hull.id} is physically separate from ${other.id}`);
}
// The C tank's two pads also hold a resting, pivoting tank.
for (const pad of [cTank.spawn, cTank.spawn.alt]) {
  const probe = { ...cTank, x: pad.x, y: pad.y, z: pad.z, yaw: pad.yaw, hp: VEHICLE_RULES.tank.hp };
  const floor = parked.placement(probe, pad.x, pad.z);
  assert.ok(floor != null && Math.abs(floor - (pad.y - 0.02)) < 1e-6, `C tank pad ${pad.x},${pad.z} is flat`);
  for (let a = 0; a < 16; a++) assert.ok(parked.clearHull(probe, pad.x, pad.y, pad.z, a * Math.PI / 8), 'C tank pad pivot room');
}

// HQ hulls: authored infantry pickup routes from the HQ road head.
for (const hull of live.filter(v => !v.spawn.flag)) {
  const spawn = meta.conquest.vehicleSpawns.find(s => s.id === hull.id), route = spawn.walkingRoute;
  assert.ok(route?.length >= 2, `${hull.id} has an authored pickup route`);
  assert.ok(distance(route[0], meta.conquest.bases[hull.team]) < 1, 'pickup begins at the HQ');
  assert.ok(distance(route.at(-1), hull) < vehicleEnterDistance(hull.type), `${hull.id} route reaches boarding range`);
  sample(route, p => {
    assert.ok(solidBelow(solidAt, p.x, p.y, p.z), `${hull.id} pedestrian support at ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
    assert.ok(!boxCollides(solidAt, p.x, p.y, p.z, PHYSICS.height), `${hull.id} walking clearance at ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
    for (const other of live) assert.ok(!playerHullContact({ ...p, state: 'alive' }, other), `${hull.id} walking route avoids parked ${other.id}`);
  });
}

// Ground hulls leave their bays along the exit route and drive out.
for (const hull of live.filter(v => (v.type === 'jeep' || v.type === 'tank') && !v.spawn.flag)) {
  const spawn = meta.conquest.vehicleSpawns.find(s => s.id === hull.id);
  assert.ok(spawn.exitRoute?.length >= 3, `${hull.id} exit route`);
  const road = spawn.exitRoute.at(-1);
  assert.ok(meta.conquest.roads.some(r => r.points.some(([x, , z]) => Math.hypot(x - road.x, z - road.z) < 10 + r.width)), `${hull.id} exit ends on a road`);
  sample(spawn.exitRoute, p => {
    const probe = { ...hull, x: p.x, z: p.z, y: p.y };
    const y = parked.placement(probe, p.x, p.z);
    assert.ok(y != null, `${hull.id} exit lane supported at ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
    for (let a = 0; a < 8; a++) assert.ok(parked.clearHull(hull, p.x, y, p.z, a * Math.PI / 4), `${hull.id} exit lane allows a full pivot`);
  });
  const sim = engine(), system = new VehicleSystem(sim), v = system.vehicles.get(hull.id);
  const driver = { id: `${hull.id}-driver`, team: hull.team, state: 'alive', x: v.x, y: v.y, z: v.z, input: { keys: {}, vehicleThrottle: 1, vehicleSteer: 0, vehicleBrake: 0 } };
  sim.entities.set(driver.id, driver); assert.ok(system.enter(driver, v.id));
  for (let i = 0; i < 600 && distance(v, spawn) < 10; i++) system.step(1 / 60);
  assert.ok(distance(v, spawn) >= 10, `${v.id} actually clears its parking bay`);
  assert.equal(v.hp, VEHICLE_RULES[v.type].hp, `${v.id} leaves undamaged`);
}

// Every aircraft departs from its pad against the live parked fleet.
const departures = [];
for (const spawn of meta.conquest.vehicleSpawns.filter(v => ['plane', 'helicopter', 'transport'].includes(v.type))) {
  const sim = engine(), system = new VehicleSystem(sim), v = system.vehicles.get(spawn.id);
  const pilot = { id: `${v.id}-pilot`, team: v.team, state: 'alive', x: v.x, y: v.y, z: v.z,
    input: { keys: {}, vehicleLift: v.type === 'plane' ? 0.5 : 1, vehicleThrottle: v.type === 'plane' ? 1 : 0, pitch: v.type === 'plane' ? 0.14 : 0, yaw: v.yaw } };
  sim.entities.set(pilot.id, pilot); assert.ok(system.enter(pilot, v.id));
  for (let i = 0; i < 900 && (v.grounded || v.y < spawn.y + 6); i++) {
    system.step(1 / 60);
    assert.equal(v.hp, VEHICLE_RULES[v.type].hp, `${v.id} departure never strikes another hull or scenery`);
  }
  assert.ok(v.y > spawn.y + 5 && !v.grounded, `${v.id} actually departs its authored parking space (y ${v.y.toFixed(1)})`);
  departures.push({ id: v.id, distance: +distance(v, spawn).toFixed(1), climb: +(v.y - spawn.y).toFixed(1) });
}
console.log(JSON.stringify({ pass: true, vehicles: hulls.length, seats, departures }));
