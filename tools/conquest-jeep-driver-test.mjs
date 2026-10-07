// Exposed ground crew through the real VehicleView: the jeep driver's hands
// on the wheel, the pintle gunner standing and turning with the HMG, seated
// passengers, the tank commander on the RWS, transport door gunners; sealed
// tank drivers stay hidden; crew leave with their seat and dispose cleanly.
import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { VehicleView } from '../public/js/engine/vehicle-view.js';
import { JeepDriver } from '../public/js/vehicles/jeep-driver.js';
import { AircraftPilot } from '../public/js/vehicles/aircraft-pilot.js';
import { vehicleMountOrder } from '../shared/conquest-contract.js';

globalThis.document ??= { createElement: () => ({ getContext: () => new Proxy({ measureText: () => ({ width: 60 }) }, { get: (o, k) => o[k] ?? (() => {}) }) }) };
let checks = 0;
const check = (fn) => { fn(); checks++; };
const world = object => object.getWorldPosition(new THREE.Vector3());
const player = (id, seat, vehicleId, team = 'alpha') => ({ id, name: id, team, state: 'alive', hp: 100, vehicleId, vehicleSeatId: seat });

const view = new VehicleView();
const jeep = { id: 'jeep', type: 'jeep', team: 'alpha', x: 10, y: 10, z: 10, yaw: 0.6, hp: 320, visualSteer: 0.3,
  seatOccupants: { driver: 'd', gunner: 'g', 'front-passenger': 'p', 'rear-left': 'r' }, mounts: [[0.6 + 1.1, 0.2, 50, 0, 0]] };
const crew = [player('d', 'driver', 'jeep'), player('g', 'gunner', 'jeep'), player('p', 'front-passenger', 'jeep'), player('r', 'rear-left', 'jeep')];
view.sync([jeep], crew, null);
for (let i = 0; i < 5; i++) view.update(1 / 60);
const item = view.items.get('jeep');
check(() => assert.equal(item.crew.size, 4, 'every exposed jeep seat is visible'));
check(() => assert.equal(item.driver, item.crew.get('driver')));
for (const actor of item.crew.values()) check(() => assert.ok(actor instanceof JeepDriver));
// Driver: hands on the steering-wheel grips.
const driver = item.crew.get('driver');
for (const [hand, grip] of [[driver.avatar.lHand, item.model.wheelControls.left], [driver.avatar.rHand, item.model.wheelControls.right]]) {
  check(() => assert.ok(world(hand).distanceTo(world(grip)) < 0.15, `driver hand on the wheel (${world(hand).distanceTo(world(grip)).toFixed(3)})`));
}
check(() => assert.equal(driver.standing, false));
// Gunner: stands at the pintle, holds the grips and turns with the gun.
const gunner = item.crew.get('gunner'), rig = item.model.mounts['gunner:pintle'];
check(() => assert.equal(gunner.standing, true, 'the pintle gunner stands'));
const holds = () => [[gunner.avatar.lHand, rig.grips.left], [gunner.avatar.rHand, rig.grips.right]].map(([hand, grip]) => world(hand).distanceTo(world(grip)));
check(() => assert.ok(holds().every(d => d < 0.15), `gunner holds the grips (${holds().map(d => d.toFixed(3))})`));
const facing = gunner.avatar.group.rotation.y;
view.sync([{ ...jeep, mounts: [[0.6 - 1.2, 0.1, 50, 0, 0]] }], crew, null);
for (let i = 0; i < 60; i++) view.update(1 / 60);
check(() => assert.ok(Math.abs(gunner.avatar.group.rotation.y - facing) > 1, 'gunner turns with the mount'));
check(() => assert.ok(holds().every(d => d < 0.15), 'and keeps hold of the grips'));
// Passengers sit with hands at rest.
for (const id of ['front-passenger', 'rear-left']) check(() => assert.equal(item.crew.get(id).standing, false));
// Leaving a seat removes exactly that crew member and disposes its avatar.
const passenger = item.crew.get('front-passenger');
let disposed = 0;
passenger.avatar.group.traverse(node => { for (const material of [].concat(node.material || [])) material?.addEventListener?.('dispose', () => disposed++); });
view.sync([{ ...jeep, seatOccupants: { driver: 'd', gunner: 'g', 'rear-left': 'r' } }], crew.filter(p => p.id !== 'p'), null);
check(() => assert.equal(item.crew.size, 3));
check(() => assert.equal(passenger.avatar.group.parent, null));
check(() => assert.ok(disposed > 0, 'avatar materials released'));
// Dead or mismatched occupants are never drawn.
view.sync([jeep], crew.map(p => p.id === 'r' ? { ...p, state: 'dead', hp: 0 } : p.id === 'p' ? { ...p, vehicleId: 'other' } : p), null);
check(() => assert.ok(!item.crew.has('rear-left') && !item.crew.has('front-passenger')));

// Tank: the sealed driver stays hidden; the commander stands on the RWS.
const tank = { id: 'tank', type: 'tank', team: 'bravo', x: 30, y: 10, z: 10, yaw: 0, turretYaw: 0.8, hp: 1000,
  seatOccupants: { driver: 'td', commander: 'tc' }, mounts: vehicleMountOrder('tank').map(() => [0.8, 0, 1, 0, 0]) };
view.sync([tank], [player('td', 'driver', 'tank', 'bravo'), player('tc', 'commander', 'tank', 'bravo')], null);
for (let i = 0; i < 5; i++) view.update(1 / 60);
const tankItem = view.items.get('tank');
check(() => assert.ok(!tankItem.crew.has('driver'), 'sealed tank driver is hidden'));
const commander = tankItem.crew.get('commander');
check(() => assert.ok(commander instanceof JeepDriver && commander.standing, 'commander stands in the hatch'));
check(() => assert.equal(commander.avatar.group.parent, tankItem.model.turret, 'commander rides the turret'));
const rws = tankItem.model.mounts['commander:rws'];
check(() => assert.ok(world(commander.avatar.lHand).distanceTo(world(rws.grips.left)) < 0.15, 'commander holds the RWS'));

// Transport: door gunners sit in the doors (exposed), the pilot under glass.
const transport = { id: 'tr', type: 'transport', team: 'alpha', x: 60, y: 10, z: 10, yaw: 0, hp: 600, rotorSpeed: 1,
  seatOccupants: { driver: 'tp', 'door-left': 'dl', 'rear-right': 'rr' }, mounts: [[Math.PI / 2, 0, 1, 0, 0], [-Math.PI / 2, 0, 1, 0, 0]] };
view.sync([transport], [player('tp', 'driver', 'tr'), player('dl', 'door-left', 'tr'), player('rr', 'rear-right', 'tr')], null);
view.update(1 / 60);
const trItem = view.items.get('tr');
check(() => assert.ok(trItem.crew.get('door-left') instanceof JeepDriver, 'door gunner is exposed crew'));
check(() => assert.ok(trItem.crew.get('driver') instanceof AircraftPilot, 'pilot sits under the canopy'));
check(() => assert.ok(trItem.crew.get('rear-right') instanceof AircraftPilot, 'cabin passengers ride inside'));
check(() => assert.ok(world(trItem.crew.get('door-left').avatar.group).x < 60 - 0.5, 'left door gunner sits on the left'));

// Wreck clears every crew member; view disposal releases the rest.
view.sync([{ ...tank, hp: 0, wreck: true }], [], null);
check(() => assert.equal(tankItem.crew.size, 0));
view.dispose();
check(() => assert.equal(view.items.size, 0));
console.log(`Exposed vehicle crew: ${checks} checks passed.`);
