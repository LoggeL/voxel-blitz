// Strike jet voxel model: nose gun and wing rails with visible missiles that
// disappear as they launch, retracting gear, twin afterburner nozzles,
// wingtips, canopy glass, nav lights, flares, budgets.
import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { makePlaneModel, PLANE_NOZZLES } from '../public/js/vehicles/models/plane.js';
import { VEHICLE_DEFS, mountPose } from '../shared/vehicle-defs.js';
import { vehicleSeatPose } from '../shared/vehicles.js';

let checks = 0;
const check = (fn) => { fn(); checks++; };
const model = makePlaneModel({ team: 'alpha' });
model.group.updateMatrixWorld(true);
const def = VEHICLE_DEFS.plane;
const rest = { type: 'plane', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };

// Fixed mounts at their anchors: nose gun and both rails.
check(() => assert.ok(model.mounts['driver:nose'].muzzle.getWorldPosition(new THREE.Vector3())
  .distanceTo(new THREE.Vector3(...mountPose(rest, 'driver', 'nose').origin)) < 1e-6));
for (const side of [0, 1]) check(() => assert.ok(model.mounts['driver:rails'].muzzles[side].getWorldPosition(new THREE.Vector3())
  .distanceTo(new THREE.Vector3(...mountPose(rest, 'driver', 'rails', { side }).origin)) < 1e-6, `rail ${side}`));
// Missiles: two instanced, hidden as the rail ammo drops (mounts[1][2]).
const scaleOf = i => { const m = new THREE.Matrix4(); model.missiles.getMatrixAt(i, m); return new THREE.Vector3().setFromMatrixScale(m).x; };
check(() => assert.equal(model.missiles.count, 2));
check(() => assert.ok(scaleOf(0) === 1 && scaleOf(1) === 1));
model.animate(1 / 60, { railAmmo: 1 });
check(() => assert.ok(scaleOf(0) === 1 && scaleOf(1) === 0, 'one missile launched'));
model.animate(1 / 60, { railAmmo: 0 });
check(() => assert.ok(scaleOf(0) === 0 && scaleOf(1) === 0));
model.animate(1 / 60, { railAmmo: 2 });
check(() => assert.ok(scaleOf(0) === 1 && scaleOf(1) === 1, 'rearmed'));
// Gear retracts in flight and hides when stowed; lowers again on the ground.
for (let i = 0; i < 120; i++) model.animate(1 / 30, { grounded: false });
check(() => assert.equal(model.noseGear.visible, false));
check(() => assert.ok(model.mainGears.every(gear => !gear.visible)));
for (let i = 0; i < 120; i++) model.animate(1 / 30, { grounded: true });
check(() => assert.ok(model.noseGear.visible && Math.abs(model.noseGear.rotation.x) < 1e-9));
// Nozzles, wingtips, lights, flares, canopy.
check(() => assert.equal(model.emitters.afterburner.length, 2));
model.emitters.afterburner.forEach((nozzle, i) => check(() => assert.ok(nozzle.node.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(...PLANE_NOZZLES[i])) < 1e-6)));
check(() => assert.equal(model.emitters.wingtips.length, 2));
check(() => assert.deepEqual(model.emitters.lights.map(light => light.kind).sort(), ['head', 'navGreen', 'navRed', 'strobe']));
check(() => assert.equal(model.emitters.flares.length, 2));
const glass = [];
model.group.traverse(o => { if (o.isMesh && o.material.name === 'vehicle-glass') glass.push(o); });
check(() => assert.equal(glass.length, 1, 'canopy'));
const pilot = model.seatAnchors.driver.getWorldPosition(new THREE.Vector3()), pose = vehicleSeatPose(rest, 'driver');
check(() => assert.ok(pilot.distanceTo(new THREE.Vector3(pose.x, pose.y, pose.z)) < 0.15));
const tags = model.fragmentSources().map(source => source.tag);
for (const tag of ['wing-left', 'wing-right', 'tailplane']) check(() => assert.ok(tags.includes(tag), tag));
const box = new THREE.Box3().setFromObject(model.body);
check(() => assert.ok(box.max.x - box.min.x <= def.collider.halfWidth * 2 + 0.4, 'wingspan fits the collider'));
check(() => assert.ok(model.stats.draws <= 10 && model.stats.triangles <= 12000, JSON.stringify(model.stats)));
console.log(`Plane model: ${checks} checks passed (${model.stats.draws} draws, ${model.stats.triangles} triangles).`);
