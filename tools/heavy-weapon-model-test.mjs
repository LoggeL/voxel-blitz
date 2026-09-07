import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { ViewmodelRig } from '../public/js/guns/viewmodel.js';
import { AvatarWeaponModel } from '../public/js/avatar/avatar-weapon.js';

const rig = new ViewmodelRig(new THREE.PerspectiveCamera(75, 2, 0.01, 100));
const remote = new AvatarWeaponModel();
try {
  rig.setWeapon('minigun');
  const rotor = rig._cur.body.getObjectByName('minigun_rotor');
  for (let i = 0; i < 6; i++) assert.ok(rotor.getObjectByName(`minigun_barrel_${i}`));
  rig.setMinigun({ spin: 1, heat: 0.82 }); rig.update(0.1);
  assert.ok(Math.abs(rotor.rotation.z - 4.2) < 1e-10, 'rotor uses elapsed time on a slow render frame');
  const indicator = rig._cur.body.getObjectByName('minigun_heat_indicator_0');
  assert.ok(indicator.material.emissiveIntensity > 1);
  remote.update({ weapon: 'minigun', minigun: { spin: 1, heat: 0 }, dt: 0.1 });
  assert.ok(remote.modelRoot.getObjectByName('minigun_heat_indicator_0').material.emissiveIntensity < 0.1,
    'a remote cold gun cannot inherit local heat materials');
  rig.setMinigun({ spin: 0, heat: 0 }); rig.update(0.1);
  assert.ok(indicator.material.emissiveIntensity < 0.1, 'heat lamps cool back down');

  rig.setWeapon('flamethrower');
  const needle = rig._cur.body.getObjectByName('flamethrower_pressure_needle');
  const nozzle = rig._cur.body.getObjectByName('flamethrower_nozzle');
  assert.ok(needle && nozzle && rig._cur.body.getObjectByName('flamethrower_pilot'));
  rig.setFlame(false, 1); rig.update(0.1);
  const fullAngle = needle.rotation.z;
  rig.setFlame(true, 0.5);
  for (let i = 0; i < 20; i++) rig.update(0.05);
  assert.ok(Math.abs(needle.rotation.z - fullAngle) > 0.5, 'visible gauge follows local fuel');
  const hot = nozzle.material.emissiveIntensity;
  assert.ok(hot > 1, 'continuous jet heats the nozzle');
  rig.setFlame(false, 0.5);
  for (let i = 0; i < 20; i++) rig.update(0.05);
  assert.ok(nozzle.material.emissiveIntensity < hot * 0.3, 'release cools the nozzle gradually');

  remote.update({ weapon: 'flamethrower', firing: true, dt: 0.1 });
  assert.equal(remote._model.flash.grp.visible, false, 'remote jet never strobes a firearm muzzle flash');
  assert.equal(remote._model.bolt.position.z, 0, 'remote nozzle never reciprocates a bolt');
} finally { rig.dispose(); remote.dispose(); }
console.log('Heavy weapon models: six barrels, elapsed rotor time, isolated heat lamps, fuel gauge, nozzle cooling and remote continuous presentation passed.');
