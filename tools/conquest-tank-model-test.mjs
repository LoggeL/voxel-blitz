// Main battle tank voxel model: rig chain, commander RWS with grips, smoke
// banks, muzzle brake, roadwheels and moving cleats, team roundel, budgets.
import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { makeTankModel, TANK_TRACK_X } from '../public/js/vehicles/models/tank.js';
import { VEHICLE_DEFS, mountPose } from '../shared/vehicle-defs.js';
import { vehicleSeatPose } from '../shared/vehicles.js';
import { TEAM_SCHEMES } from '../public/js/vehicles/voxel-model/material.js';

let checks = 0;
const check = (fn) => { fn(); checks++; };
const def = VEHICLE_DEFS.tank;
const model = makeTankModel({ team: 'alpha' });
model.group.updateMatrixWorld(true);

// Rig chain: hull body -> turret (yaw) -> gun (pitch) -> barrel (recoil).
check(() => assert.equal(model.turret.parent, model.body));
check(() => assert.equal(model.gun.parent, model.turret));
check(() => assert.equal(model.barrel.parent, model.gun));
const main = model.mounts['driver:main'], coax = model.mounts['driver:coax'], rws = model.mounts['commander:rws'];
check(() => assert.equal(main.yawNode, model.turret));
check(() => assert.equal(main.recoilNode, model.barrel));
check(() => assert.equal(coax.yawNode, model.turret, 'coax is slaved to the turret'));
check(() => assert.equal(coax.slavedTo, 'main'));
check(() => assert.notEqual(rws.yawNode, model.turret, 'the RWS has its own ring'));
check(() => assert.equal(rws.yawNode.parent, model.turret, 'the RWS rides the turret'));
check(() => assert.ok(rws.grips?.left && rws.grips?.right, 'commander grips'));
check(() => assert.equal(model.seatAnchors.commander.parent, model.turret));

// Muzzles at the shared anchors (pivot + barrel length) at rest.
const rest = { type: 'tank', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, turretYaw: 0, turretPitch: 0,
  mounts: [[0, 0, 1, 0, 0], [0, 0, 1, 0, 0], [0, 0, 1, 0, 0]] };
for (const [key, seat, mount] of [['driver:main', 'driver', 'main'], ['driver:coax', 'driver', 'coax'], ['commander:rws', 'commander', 'rws']]) {
  const rendered = model.mounts[key].muzzle.getWorldPosition(new THREE.Vector3());
  const server = mountPose(rest, seat, mount).origin;
  check(() => assert.ok(rendered.distanceTo(new THREE.Vector3(...server)) < 1e-6, `${key} muzzle at the def anchor`));
}
check(() => assert.equal(model.muzzleLength, def.mounts.main.muzzle));
for (const seat of def.seats) {
  const anchor = model.seatAnchors[seat.id].getWorldPosition(new THREE.Vector3());
  const pose = vehicleSeatPose(rest, seat.id);
  check(() => assert.ok(anchor.distanceTo(new THREE.Vector3(pose.x, pose.y, pose.z)) < 0.15, `${seat.id} seat anchor`));
}

// Muzzle brake: the barrel is wider at the tip than along the tube.
const barrelMesh = model.barrel.children.find(child => child.isMesh);
const p = barrelMesh.geometry.attributes.position;
// Hull-frame z of each vertex (geometry is meshed about the gun pivot).
const pivotZ = def.mounts.main.pivot[2], tip = pivotZ - def.mounts.main.muzzle;
let tipWidth = 0, tubeWidth = 0;
for (let i = 0; i < p.count; i++) {
  const x = Math.abs(p.getX(i)), z = p.getZ(i) + pivotZ;
  // The brake spans tip..tip+0.6 (front ring, side slots, rear ring).
  if (z < tip + 0.45) tipWidth = Math.max(tipWidth, x);
  else if (z > tip + 0.65 && z < -3.05) tubeWidth = Math.max(tubeWidth, x);
}
check(() => assert.ok(tipWidth > tubeWidth + 0.15, `muzzle brake (${tipWidth.toFixed(2)} vs ${tubeWidth.toFixed(2)})`));

// Running gear: 12 roadwheels and 2 x 28 cleats, instanced; belts animate per side.
check(() => assert.equal(model.wheels[0].count, 12));
check(() => assert.equal(model.trackCleats.count, 56));
const cleat = i => { const m = new THREE.Matrix4(); model.trackCleats.getMatrixAt(i, m); return new THREE.Vector3().setFromMatrixPosition(m); };
const wheel = i => { const m = new THREE.Matrix4(); model.wheels[0].getMatrixAt(i, m); return new THREE.Quaternion().setFromRotationMatrix(m); };
const left0 = cleat(0), right0 = cleat(28), leftWheel = wheel(0), rightWheel = wheel(6);
check(() => assert.ok(left0.x < 0 && right0.x > 0 && Math.abs(Math.abs(left0.x) - TANK_TRACK_X) < 1e-5));
model.animateTracks(0.5, -0.5);
check(() => assert.ok(cleat(0).distanceTo(left0) > 0.3, 'left belt advances'));
check(() => assert.ok(cleat(28).distanceTo(right0) > 0.3, 'right belt counter-rotates on a pivot'));
check(() => assert.ok(wheel(0).angleTo(leftWheel) > 0.5 && wheel(6).angleTo(rightWheel) > 0.5, 'roadwheels spin'));
// Cleats never sink below the ground contact.
let lowest = Infinity;
for (let i = 0; i < 56; i++) lowest = Math.min(lowest, cleat(i).y);
check(() => assert.ok(lowest >= -0.001, `cleats rest on the ground (${lowest.toFixed(3)})`));
model.animate(1 / 60, { wreck: true, leftTrackSpeed: 5, rightTrackSpeed: 5 });
const frozen = cleat(0);
model.animate(1 / 60, { wreck: true, leftTrackSpeed: 5, rightTrackSpeed: 5 });
check(() => assert.ok(cleat(0).equals(frozen), 'a wreck never drives its belts'));

// Emitters: smoke banks either side of the turret, exhausts aft, head/tail lamps, cook-off.
check(() => assert.equal(model.emitters.smoke.length, 2));
check(() => assert.ok(model.emitters.smoke.every(emitter => emitter.node.parent === model.turret)));
check(() => assert.equal(model.emitters.exhaust.length, 2));
check(() => assert.equal(model.emitters.tracks.length, 2));
check(() => assert.deepEqual(model.emitters.lights.map(light => light.kind).sort(), ['head', 'head', 'tail', 'tail']));
check(() => assert.equal(model.contacts.length, 2, 'one contact blob per track'));

// Team roundel on the turret roof (WEST blue disc).
const roundel = new THREE.Color().setHex(TEAM_SCHEMES.alpha.roundel);
const turretMesh = model.turret.children.find(child => child.isMesh);
const c = turretMesh.geometry.attributes.color, n = turretMesh.geometry.attributes.normal;
let roof = 0;
for (let i = 0; i < c.count; i++) if (n.getY(i) > 0.9 && Math.abs(c.getX(i) / c.getZ(i) - roundel.r / roundel.b) < 0.03) roof++;
check(() => assert.ok(roof >= 4, 'turret roof roundel'));

// Budgets.
check(() => assert.ok(model.stats.draws <= 10 && model.stats.triangles <= 12000, JSON.stringify(model.stats)));
console.log(`Tank model: ${checks} checks passed (${model.stats.draws} draws, ${model.stats.triangles} triangles).`);
