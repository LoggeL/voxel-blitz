// Aircraft presentation through the real VehicleView: authoritative pitch,
// bank and yaw smoothing (no ground fit), rotor spool from rotorSpeed or the
// crew fallback, pilots and gunners holding their controls under fogged
// glass, jet gear and missiles from snapshot fields, contact blobs.
import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { VehicleView } from '../public/js/engine/vehicle-view.js';
import { AircraftPilot } from '../public/js/vehicles/aircraft-pilot.js';
import { mountIndex } from '../public/js/vehicles/voxel-model/anchors.js';
import { VEHICLE_STATUS } from '../shared/conquest-contract.js';

globalThis.document ??= { createElement: () => ({ getContext: () => new Proxy({ measureText: () => ({ width: 60 }) }, { get: (o, k) => o[k] ?? (() => {}) }) }) };
let checks = 0;
const check = (fn) => { fn(); checks++; };
const world = object => object.getWorldPosition(new THREE.Vector3());
const flatGround = (_x, y) => (y < 10 ? 1 : 0);

// Attitude: aircraft use the row's pitch and roll even with a world attached.
{
  const view = new VehicleView({ getBlock: flatGround });
  const heli = { id: 'h', type: 'helicopter', team: 'alpha', x: 0, y: 30, z: 0, yaw: 0.4, pitch: 0.2, roll: -0.3, hp: 650, rotorSpeed: 1, grounded: false };
  view.sync([heli], [], null);
  view.update(1 / 60);
  const root = view.items.get('h').root;
  check(() => assert.ok(Math.abs(root.rotation.x - 0.2) < 1e-9 && Math.abs(root.rotation.z + 0.3) < 1e-9, 'spawned at the row attitude'));
  view.sync([{ ...heli, pitch: -0.1, roll: 0.5, yaw: 1 }], [], null);
  view.update(1 / 60);
  check(() => assert.ok(root.rotation.x > -0.1 && root.rotation.x < 0.2, 'pitch eases toward the row'));
  for (let i = 0; i < 60; i++) view.update(1 / 60);
  check(() => assert.ok(Math.abs(root.rotation.x + 0.1) < 1e-3 && Math.abs(root.rotation.z - 0.5) < 1e-3 && Math.abs(root.rotation.y - 1) < 1e-3));
  view.dispose();
}

// Rotor spool: rotorSpeed drives the blades and blur; without it, crew or motion spin it up.
{
  const view = new VehicleView();
  const row = { id: 'r', type: 'transport', team: 'alpha', x: 0, y: 10, z: 0, yaw: 0, hp: 600 };
  view.sync([{ ...row, rotorSpeed: 0 }], [], null);
  const item = view.items.get('r');
  for (let i = 0; i < 10; i++) view.update(1 / 60);
  check(() => assert.equal(item.model.rotorBlur.visible, false, 'a stopped rotor shows blades'));
  view.sync([{ ...row, rotorSpeed: 1 }], [], null);
  view.update(1 / 60);
  check(() => assert.equal(item.model.rotorBlur.visible, true, 'full rotor speed blurs'));
  view.sync([{ ...row, seatOccupants: { driver: 'p' } }], [], null);
  for (let i = 0; i < 120; i++) view.update(1 / 60);
  check(() => assert.ok(item.fallbackRotor > 0.9, 'a crewed hull without rotorSpeed spins up'));
  view.sync([{ ...row, hp: 0, wreck: true }], [], null);
  const angle = item.model.mainRotor.rotation.y;
  view.update(1 / 60);
  check(() => assert.equal(item.model.mainRotor.rotation.y, angle, 'wreck rotors never turn'));
  view.dispose();
}

// Crew under glass: pilots hold the cyclic/collective or stick/throttle, the chin gunner the sight grips.
{
  const view = new VehicleView();
  const crew = [
    { id: 'hp', team: 'alpha', state: 'alive', hp: 100, vehicleId: 'h', vehicleSeatId: 'driver' },
    { id: 'hg', team: 'alpha', state: 'alive', hp: 100, vehicleId: 'h', vehicleSeatId: 'gunner' },
    { id: 'jp', team: 'bravo', state: 'alive', hp: 100, vehicleId: 'j', vehicleSeatId: 'driver' },
  ];
  view.sync([
    { id: 'h', type: 'helicopter', team: 'alpha', x: 0, y: 20, z: 0, yaw: 0, pitch: 0.1, roll: 0.2, hp: 650, rotorSpeed: 1, seatOccupants: { driver: 'hp', gunner: 'hg' } },
    { id: 'j', type: 'plane', team: 'bravo', x: 40, y: 50, z: 0, yaw: 1, pitch: 0, roll: 0, hp: 450, grounded: false, seatOccupants: { driver: 'jp' }, enginePower: 1 },
  ], crew, null);
  for (let i = 0; i < 5; i++) view.update(1 / 60);
  const heli = view.items.get('h'), jet = view.items.get('j');
  check(() => assert.ok(heli.crew.get('driver') instanceof AircraftPilot && heli.crew.get('gunner') instanceof AircraftPilot));
  check(() => assert.ok(jet.crew.get('driver') instanceof AircraftPilot));
  const pilot = heli.crew.get('driver');
  check(() => assert.ok(world(pilot.avatar.lHand).distanceTo(world(heli.model.controlAnchors.left)) < 0.15, 'collective in the left hand'));
  check(() => assert.ok(world(pilot.avatar.rHand).distanceTo(world(heli.model.controlAnchors.right)) < 0.15, 'cyclic in the right hand'));
  const gunner = heli.crew.get('gunner');
  check(() => assert.ok(world(gunner.avatar.lHand).distanceTo(world(heli.model.gunnerAnchors.left)) < 0.15, 'gunner on the sight grips'));
  const jetPilot = jet.crew.get('driver');
  check(() => assert.ok(world(jetPilot.avatar.rHand).distanceTo(world(jet.model.cockpitControls.rightHand)) < 0.15, 'stick in hand'));
  // Fog is on for hulls, glass and crew alike.
  for (const item of [heli, jet]) item.root.traverse(o => {
    if (o.isMesh && o.name !== 'vehicle-hp-bar') check(() => assert.notEqual(o.material.fog, false, `${item.kind} ${o.name} fogged`));
  });
  check(() => assert.equal(jet.hpBar.visible, false, 'no HP bar over enemy aircraft'));
  view.dispose();
}

// Jet gear and missiles follow snapshot fields.
{
  const view = new VehicleView();
  const rails = mountIndex('plane', 'rails');
  const mounts = ammo => [[0, 0, 300, 0, 0], [0, 0, ammo, 0, 0]].map((m, i) => (i === rails ? [0, 0, ammo, 0, 0] : m));
  const jet = { id: 'j', type: 'plane', team: 'alpha', x: 0, y: 40, z: 0, yaw: 0, hp: 450, grounded: false, mounts: mounts(2), st: VEHICLE_STATUS.engine };
  view.sync([jet], [], null);
  for (let i = 0; i < 180; i++) view.update(1 / 30);
  const item = view.items.get('j');
  check(() => assert.equal(item.model.noseGear.visible, false, 'gear stowed in flight'));
  const scale = i => { const m = new THREE.Matrix4(); item.model.missiles.getMatrixAt(i, m); return new THREE.Vector3().setFromMatrixScale(m).x; };
  check(() => assert.ok(scale(0) === 1 && scale(1) === 1));
  view.sync([{ ...jet, mounts: mounts(1) }], [], null); view.update(1 / 60);
  check(() => assert.equal(scale(1), 0, 'a launched missile leaves its rail'));
  view.sync([{ ...jet, grounded: true, y: 10, mounts: mounts(2) }], [], null);
  for (let i = 0; i < 180; i++) view.update(1 / 30);
  check(() => assert.equal(item.model.noseGear.visible, true, 'gear down on the ground'));
  check(() => assert.equal(scale(1), 1, 'rearmed on the pad'));
  // Contact blobs: nose and mains.
  const blobs = [];
  view.addContactShadows({ add: (...args) => blobs.push(args) });
  check(() => assert.equal(blobs.length, 3));
  view.dispose();
}
console.log(`Aircraft view: ${checks} checks passed.`);
