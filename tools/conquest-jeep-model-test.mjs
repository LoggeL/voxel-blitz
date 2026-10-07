// Jeep voxel model: four instanced wheels that roll and steer, the steering
// wheel, the pintle HMG rig with grips, four seat anchors, lamps and exhaust,
// tyre and dust emitters, axle contact blobs, budgets and break-away chunks.
import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { makeJeepModel, JEEP_WHEELS, JEEP_WHEEL_RADIUS } from '../public/js/vehicles/models/jeep.js';
import { VEHICLE_DEFS, mountPose } from '../shared/vehicle-defs.js';
import { vehicleSeatPose } from '../shared/vehicles.js';

let checks = 0;
const check = (fn) => { fn(); checks++; };
const model = makeJeepModel({ team: 'bravo' });
model.group.updateMatrixWorld(true);
const rest = { type: 'jeep', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, mounts: [[0, 0, 1, 0, 0]] };

// Wheels: one instanced draw, wheel centres on the ground at the authored axles.
const wheels = model.wheels[0];
check(() => assert.ok(wheels.isInstancedMesh && wheels.count === 4));
const wheelMatrix = i => { const m = new THREE.Matrix4(); wheels.getMatrixAt(i, m); return m; };
JEEP_WHEELS.forEach((wheel, i) => {
  const p = new THREE.Vector3().setFromMatrixPosition(wheelMatrix(i));
  check(() => assert.ok(Math.abs(p.x - wheel.x) < 1e-6 && Math.abs(p.z - wheel.z) < 1e-6));
  check(() => assert.ok(Math.abs(p.y - JEEP_WHEEL_RADIUS - 0.02) < 1e-6, 'tyres touch the ground'));
});
// Rolling and steering from the snapshot speed and visualSteer.
const before = JEEP_WHEELS.map((_, i) => new THREE.Quaternion().setFromRotationMatrix(wheelMatrix(i)));
model.animate(0.1, { speed: 8, visualSteer: 0.4 });
const after = JEEP_WHEELS.map((_, i) => new THREE.Quaternion().setFromRotationMatrix(wheelMatrix(i)));
check(() => assert.ok(after.every((q, i) => q.angleTo(before[i]) > 0.5), 'all four wheels roll'));
// Steering turns the axle (local X) about Y; rolling spins about the axle itself.
const yawOf = q => { const axle = new THREE.Vector3(1, 0, 0).applyQuaternion(q); return Math.atan2(-axle.z, axle.x); };
check(() => assert.ok(Math.abs(yawOf(after[0]) + 0.4) < 1e-4 && Math.abs(yawOf(after[1]) + 0.4) < 1e-4, 'front wheels steer'));
check(() => assert.ok(Math.abs(yawOf(after[2])) < 1e-6 && Math.abs(yawOf(after[3])) < 1e-6, 'rear wheels track straight'));
check(() => assert.ok(Math.abs(model.steeringWheel.rotation.z + 0.72) < 1e-9, 'steering wheel turns with the input'));
model.animate(0.1, { speed: 8, visualSteer: 5 });
check(() => assert.ok(Math.abs(model.steeringWheel.rotation.z + 1.08) < 1e-9, 'steer clamps'));
const frozen = new THREE.Quaternion().setFromRotationMatrix(wheelMatrix(0));
model.animate(0.1, { speed: 8, wreck: true });
check(() => assert.ok(new THREE.Quaternion().setFromRotationMatrix(wheelMatrix(0)).angleTo(frozen) < 1e-3, "wrecks never roll"));

// Pintle HMG: yaw swivel, pitching gun, grips, muzzle at the def anchor.
const pintle = model.mounts['gunner:pintle'];
check(() => assert.equal(pintle.pitchNode.parent, pintle.yawNode));
check(() => assert.ok(pintle.grips.left && pintle.grips.right));
const muzzle = pintle.muzzle.getWorldPosition(new THREE.Vector3());
check(() => assert.ok(muzzle.distanceTo(new THREE.Vector3(...mountPose(rest, 'gunner', 'pintle').origin)) < 1e-6));
pintle.yawNode.rotation.y = 1.2; pintle.pitchNode.rotation.x = 0.3; model.group.updateMatrixWorld(true);
const grip = pintle.grips.left.getWorldPosition(new THREE.Vector3());
check(() => assert.ok(grip.distanceTo(pintle.muzzle.getWorldPosition(new THREE.Vector3())) > 1, 'grips sit behind the gun'));
pintle.yawNode.rotation.y = 0; pintle.pitchNode.rotation.x = 0; model.group.updateMatrixWorld(true);

// Seats: four hips on the body, standing gunner behind the post.
check(() => assert.deepEqual(Object.keys(model.seatAnchors), VEHICLE_DEFS.jeep.seats.map(seat => seat.id)));
for (const seat of VEHICLE_DEFS.jeep.seats) {
  const anchor = model.seatAnchors[seat.id].getWorldPosition(new THREE.Vector3()), pose = vehicleSeatPose(rest, seat.id);
  check(() => assert.ok(anchor.distanceTo(new THREE.Vector3(pose.x, pose.y, pose.z)) < 0.15, seat.id));
  check(() => assert.equal(model.seatAnchors[seat.id].parent, model.body));
}
// Lamps, exhaust, dust and tyre-mark emitters; axle blobs lie across the hull.
check(() => assert.deepEqual(model.emitters.lights.map(light => light.kind).sort(), ['head', 'head', 'tail', 'tail']));
check(() => assert.equal(model.emitters.exhaust.length, 1));
check(() => assert.equal(model.emitters.dust.length, 2));
check(() => assert.equal(model.emitters.tracks.length, 2));
check(() => assert.ok(model.contacts.length === 2 && model.contacts.every(contact => contact.across)));
// Break-away chunks include the bonnet and the pintle; the wheels hide on a wreck.
const tags = model.fragmentSources().map(source => source.tag);
for (const tag of ['hood', 'pintle', 'rollbar']) check(() => assert.ok(tags.includes(tag), tag));
model.setWreck(true);
check(() => assert.equal(wheels.visible, true, 'charred wheels stay under the wreck (no floating hull)'));
model.setWreck(false);
check(() => assert.equal(wheels.visible, true));
const box = new THREE.Box3().setFromObject(model.body);
check(() => assert.ok(box.max.x - box.min.x < 2.6 && box.max.z - box.min.z < 4.8, 'fits the jeep collider'));
check(() => assert.ok(model.stats.draws <= 10 && model.stats.triangles <= 12000, JSON.stringify(model.stats)));
console.log(`Jeep model: ${checks} checks passed (${model.stats.draws} draws, ${model.stats.triangles} triangles).`);
