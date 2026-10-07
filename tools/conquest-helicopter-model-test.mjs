// Attack helicopter voxel model: converging pods, chin gun gimbal, rotor and
// tail rotor animation with the blur disc, canopy glass, flares, nav lights.
import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { makeHelicopterModel, HELICOPTER_ROTOR } from '../public/js/vehicles/models/helicopter.js';
import { makeTransportModel, TRANSPORT_ROTOR } from '../public/js/vehicles/models/transport.js';
import { VEHICLE_DEFS, mountPose } from '../shared/vehicle-defs.js';

let checks = 0;
const check = (fn) => { fn(); checks++; };
for (const [type, make, rotorDef] of [['helicopter', makeHelicopterModel, HELICOPTER_ROTOR], ['transport', makeTransportModel, TRANSPORT_ROTOR]]) {
  const model = make({ team: 'alpha' });
  model.group.updateMatrixWorld(true);
  const def = VEHICLE_DEFS[type];
  const rest = { type, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
  // Canopy glass is its own transparent draw.
  const glass = [];
  model.group.traverse(o => { if (o.isMesh && o.material.name === 'vehicle-glass') glass.push(o); });
  check(() => assert.equal(glass.length, 1, `${type} canopy glass`));
  check(() => assert.ok(glass[0].material.transparent && !glass[0].material.depthWrite));
  // Rotor: spins with the authoritative rotor speed; blur disc above ~45 %.
  const rotor = model.mainRotor, blur = model.rotorBlur;
  check(() => assert.ok(Math.abs(rotor.position.y + rotor.parent.position.y - rotorDef.hub[1]) < 1e-6));
  model.animate(0.05, { rotorSpeed: 0.2 });
  const slow = rotor.rotation.y;
  check(() => assert.ok(slow > 0 && blur.visible === false && rotor.visible, `${type} blades visible at low rpm`));
  model.animate(0.05, { rotorSpeed: 1 });
  check(() => assert.ok(blur.visible && blur.material.opacity > 0.5, `${type} blur disc at full rpm`));
  check(() => assert.equal(rotor.visible, false, 'solid blades hide behind the disc'));
  const tail = model.tailRotor.rotation.x;
  model.animate(0.05, { rotorSpeed: 1, wreck: true });
  check(() => assert.equal(model.tailRotor.rotation.x, tail, 'a wreck rotor stops'));
  check(() => assert.equal(blur.visible, false));
  // Flares, nav lights, strobe and the head light.
  check(() => assert.equal(model.emitters.flares.length, 2));
  check(() => assert.deepEqual(model.emitters.lights.map(light => light.kind).sort(), ['head', 'navGreen', 'navRed', 'strobe']));
  check(() => assert.equal(model.emitters.rotor.radius, rotorDef.radius));
  // Mounts at their anchors.
  for (const key of def.mountOrder) {
    const [seatId, mountId] = key.split(':'), mount = def.mounts[mountId];
    for (let side = 0; side < (mount.sides?.length || 1); side++) {
      if (!mount.fixed) {
        const centre = mount.yawLimit ? mount.yawLimit[0] : 0;
        model.mounts[key].yawNode.rotation.y = centre; model.group.updateMatrixWorld(true);
      }
      const rendered = model.mounts[key].muzzles[side].getWorldPosition(new THREE.Vector3());
      const server = mountPose({ ...rest, mounts: def.mountOrder.map(k => [def.mounts[k.split(':')[1]].yawLimit?.[0] ?? 0, 0, 1, 0, 0]) }, seatId, mountId, { side }).origin;
      check(() => assert.ok(rendered.distanceTo(new THREE.Vector3(...server)) < 1e-5, `${type} ${key}#${side}`));
    }
  }
  check(() => assert.ok(model.stats.draws <= 10 && model.stats.triangles <= 12000, JSON.stringify(model.stats)));
}

// Attack helicopter specifics: two pods converge, the chin gun gimbals.
{
  const model = makeHelicopterModel({ team: 'bravo' });
  const pods = model.mounts['driver:pods'];
  check(() => assert.equal(pods.muzzles.length, 2, 'left and right pods'));
  check(() => assert.ok(pods.fixed));
  const chin = model.mounts['gunner:chin'];
  check(() => assert.equal(chin.pitchNode.parent, chin.yawNode));
  check(() => assert.ok(chin.yawNode.parent === model.body));
  check(() => assert.deepEqual(chin.yawLimit, VEHICLE_DEFS.helicopter.mounts.chin.yawLimit));
  check(() => assert.ok(model.cockpitControls.leftHand && model.cockpitControls.rightHand && model.gunnerAnchors.left));
}
// Transport specifics: door guns on both flanks, an open cabin, five seats.
{
  const model = makeTransportModel({ team: 'alpha' });
  model.group.updateMatrixWorld(true);
  const left = model.mounts['door-left:door-left'], right = model.mounts['door-right:door-right'];
  check(() => assert.ok(left.yawNode.getWorldPosition(new THREE.Vector3()).x < -1 && right.yawNode.getWorldPosition(new THREE.Vector3()).x > 1));
  check(() => assert.deepEqual(Object.keys(model.seatAnchors), ['driver', 'door-left', 'door-right', 'rear-left', 'rear-right']));
  const tags = model.fragmentSources().map(source => source.tag);
  for (const tag of ['rotor', 'tail-rotor', 'door-left', 'door-right']) check(() => assert.ok(tags.includes(tag), tag));
}
console.log(`Helicopter and transport models: ${checks} checks passed.`);
