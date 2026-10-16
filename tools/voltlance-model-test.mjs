import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { ViewmodelRig } from '../public/js/guns/viewmodel.js';
import { AvatarWeaponModel } from '../public/js/avatar/avatar-weapon.js';
import { animateVoltlance } from '../public/js/guns/voltlance-animation.js';
import { MuzzleLights } from '../public/js/engine/muzzle-lights.js';

const rig = new ViewmodelRig(new THREE.PerspectiveCamera(75, 2, 0.01, 100));
const remote = new AvatarWeaponModel();
const pool = new MuzzleLights(new THREE.Scene());
const coils = body => Array.from({ length: 3 }, (_, stage) =>
  body.getObjectByName(`voltlance_coil_${stage}`));
const glowMaterials = body => {
  const materials = new Set();
  body.traverse(object => {
    for (const material of [].concat(object.material || [])) {
      if (material.userData.voltlanceGlow) materials.add(material);
    }
  });
  return materials;
};
const intensity = coil => Math.max(...[...glowMaterials(coil)].map(material => material.emissiveIntensity));
const charge = (level, reducedMotion = true) => {
  rig.setCharge(level);
  rig.update(1 / 60, { reducedMotion });
};
const disposed = new Map();
try {
  rig.setWeapon('lance');
  const bank = coils(rig._cur.body);
  assert.ok(bank.every(Boolean), 'all three accelerator stages exist in the Node fallback');
  const materials = glowMaterials(rig._cur.body);
  assert.ok(materials.size >= 3, 'accelerator stages own distinct glow materials');
  const boltCaps = [];
  rig._cur.bolt.traverse(object => {
    if (object.material?.uniforms === rig._cur.uni) boltCaps.push(object);
  });
  assert.equal(boltCaps.length, 0, 'no generic glowing bolt cap obscures the VOLTLANCE optic');
  const resources = new Set(materials);
  for (const material of materials) {
    for (const value of Object.values(material)) if (value?.isTexture && !value.userData.pageOwned) resources.add(value);
  }
  for (const resource of resources) {
    disposed.set(resource, 0);
    resource.addEventListener('dispose', () => disposed.set(resource, disposed.get(resource) + 1));
  }
  const muzzle = rig._cur.muzzleMarker.position.clone();
  charge(0);
  const idle = bank.map(intensity);
  const homes = bank.map(coil => coil.position.clone());
  charge(0.5);
  assert.ok(intensity(bank[0]) > intensity(bank[1]) && intensity(bank[1]) > intensity(bank[2]),
    'charge advances visibly through the three coil stages');
  const half = bank.map(intensity);
  charge(1);
  assert.ok(bank.every((coil, index) => intensity(coil) > half[index] && intensity(coil) > 1),
    'full charge drives every stage above the HDR glow threshold');
  const source = rig._cur.body.getObjectByName('lance_charge_light');
  assert.ok(source && !source.visible, 'charge source stays hidden from the renderer light list');
  assert.ok(source.intensity > 0 && rig.flashLight === source, 'first-person charge reaches the shared light pool');
  pool.update(rig.flashLight, new Map(), new THREE.PerspectiveCamera());
  assert.equal(pool.lights[0].intensity, source.intensity, 'the renderer pool receives actual charge intensity');
  rig._cur.flash.light.intensity = 1;
  assert.equal(rig.flashLight, rig._cur.flash.light, 'actual discharge flash takes priority over charge spill');
  rig._cur.flash.light.intensity = 0;
  assert.equal(rig._cur.flash.mats.length, 2, 'VOLTLANCE keeps its discharge flash');
  const steady = bank.map(intensity);
  const orbRotation = rig._chargeOrb.rotation.toArray();
  const orbScale = rig._chargeOrb.scale.clone();
  charge(1);
  assert.deepEqual(bank.map(intensity), steady, 'reduced motion keeps coil glow steady');
  assert.deepEqual(rig._chargeOrb.rotation.toArray(), orbRotation, 'reduced motion stops corona rotation');
  assert.deepEqual(rig._chargeOrb.scale, orbScale, 'reduced motion stops corona pulsing');
  animateVoltlance(rig._cur.body, 1, 0, false);
  const pulseA = bank.map(intensity);
  animateVoltlance(rig._cur.body, 1, 0.05, false);
  assert.ok(bank.some((coil, index) => Math.abs(intensity(coil) - pulseA[index]) > 0.01),
    'normal presentation pulses near overload');

  remote.update({ weapon: 'lance', charge: 0, dt: 1 / 60 });
  const remoteBank = coils(remote.modelRoot);
  assert.deepEqual(remoteBank.map(intensity), idle, 'another carrier cannot inherit local charge');
  assert.ok([...glowMaterials(remote.modelRoot)].every(material => !materials.has(material)),
    'local and remote models own separate glow materials');
  remote.update({ weapon: 'lance', charge: 0.5, dt: 1 / 60 });
  charge(0.5);
  assert.deepEqual(remoteBank.map(intensity), bank.map(intensity), 'remote snapshot charge fills matching stages');
  assert.equal(remote.flashLight.name, 'lance_charge_light', 'remote charge uses the same light route');
  remote._model.flash.light.intensity = 1;
  assert.equal(remote.flashLight, remote._model.flash.light, 'remote discharge flash takes priority');
  remote._model.flash.light.intensity = 0;

  charge(0);
  assert.deepEqual(bank.map(intensity), idle, 'release drains the charge glow back to its idle values');
  assert.equal(source.intensity, 0, 'release removes charge spill');
  assert.equal(rig.flashLight, rig._cur.flash.light, 'idle returns the original flash source');
  assert.equal(rig._chargeOrb.visible, false, 'release removes the muzzle corona');
  assert.deepEqual(bank.map(coil => coil.position), homes, 'release restores every coil to its resting position');
  assert.deepEqual(rig._cur.muzzleMarker.position, muzzle, 'glow never moves the ballistic muzzle anchor');
  charge(1);
  rig.setWeapon('rifle');
  assert.equal(rig._chargeOrb.visible, false, 'weapon switch hides the shared muzzle corona');
  rig.setWeapon('lance');
  assert.deepEqual(bank.map(intensity), idle, 're-equip clears stale charge before its first frame');
  assert.equal(source.intensity, 0, 're-equip clears stale charge light');
} finally {
  rig.dispose();
  remote.dispose();
  pool.dispose();
}
assert.ok(disposed.size >= 3 && [...disposed.values()].every(count => count === 1),
  'gun-owned glow materials and textures dispose exactly once');
console.log('VOLTLANCE model: staged coils, overload glow, local/remote light routing, reduced motion, reset and disposal passed.');
