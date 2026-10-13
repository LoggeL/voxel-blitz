import assert from 'node:assert/strict';
import { buildGun, disposeGunModels } from '../public/js/guns/assemble.js';
import { MaterialCache } from '../public/js/guns/kit.js';
import { thunderboltAnimationFor } from '../public/js/guns/thunderbolt-animation.js';

// Use the real DOM-free model and presentation controller. The browser companion
// verifies the same effect against the shipped Blender asset and actual pixels.
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-8,
  `${message}: ${actual} != ${expected}`);
const caches = [new MaterialCache(), new MaterialCache()];
const guns = caches.map(cache => buildGun('thunderbolt', cache));
const [a, b] = guns.map(gun => gun.extra.userData.thunderbolt);
const animation = thunderboltAnimationFor(guns[0]);
const visible = () => a.rounds.filter(round => round.visible).length;
const pulse = expected => a.plasma.materials.forEach(material => near(material.uniforms.uPulse.value,
  expected, 'all rendered fields receive the current discharge pulse'));
const shaderMaterials = new Set();
const disposal = [new Map(), new Map()];

try {
  for (const [index, parts] of [a, b].entries()) {
    assert.ok(parts.plasma, 'production model installs its plasma field');
    assert.equal(parts.plasma.materials.length, 5, 'four charges and one accelerator field');
    for (const material of parts.plasma.materials) {
      assert.ok(material.isShaderMaterial, 'each field uses the plasma shader');
      assert.ok(!shaderMaterials.has(material), 'each field and gun owns its material');
      shaderMaterials.add(material);
      disposal[index].set(material, 0);
      material.addEventListener('dispose', () => disposal[index].set(material, disposal[index].get(material) + 1));
    }
    for (const group of [...parts.rounds, parts.energy]) {
      const fields = [];
      group.traverse(mesh => {
        if (mesh.isMesh && parts.plasma.materials.includes(mesh.material)) fields.push(mesh);
      });
      assert.equal(fields.length, 1, 'each articulated field has exactly one rendered sphere');
    }
    assert.ok(parts.pulseMaterial.isMeshStandardMaterial, 'rail lighting retains its physical material');
    assert.ok(!parts.plasma.materials.includes(parts.pulseMaterial), 'the plasma shader is restricted to the spheres');
  }

  const start = a.plasma.time;
  const otherTime = b.plasma.time;
  animation.update(0.12);
  near(a.plasma.time - start, 0.12, 'one controller update advances plasma once');
  for (const material of a.plasma.materials) near(material.uniforms.uTime.value, a.plasma.time,
    'every rendered field receives the same clock');
  near(b.plasma.time, otherTime, 'animating one gun cannot advance another gun');
  animation.update(0.2, { reducedMotion: true });
  near(a.plasma.time - start, 0.12, 'reduced motion holds the visual clock');
  animation.update(0.08, { reducedMotion: false });
  near(a.plasma.time - start, 0.2, 'visual motion resumes without accumulated time');

  const frozen = a.plasma.time;
  for (let mag = 3; mag >= 0; mag--) {
    assert.equal(animation.fire(), true);
    pulse(1);
    assert.equal(visible(), mag + 1, 'starting an effect cannot consume authoritative ammunition');
    animation.setState({ mag });
    assert.equal(visible(), mag, 'one authoritative decrement removes one field');
    animation.update(0.3, { reducedMotion: true });
    near(a.plasma.time, frozen, 'reduced motion remains visually frozen during firing');
    near(a.rotor.rotation.z, (4 - mag) * Math.PI / 2, 'reduced motion preserves mechanical indexing');
    near(animation.pulse, 0, 'discharge completes while visual motion is frozen');
    pulse(0);
  }
  assert.equal(a.energy.visible, false, 'an empty launcher has no active accelerator field');
  animation.reset();
  assert.equal(visible(), 0, 'reset does not refill the drum');
  assert.equal(animation.fire(), false, 'empty field cannot discharge');

  animation.setState({ mag: 4 });
  animation.fire();
  animation.setState({ mag: 3 });
  animation.update(0.1);
  assert.ok(animation.pulse > 0, 'accepted shots carry an active discharge pulse');
  animation.setState({ mag: 4 });
  near(animation.pulse, 0, 'authority rollback clears the discharge');
  pulse(0);
  assert.equal(visible(), 4);
  near(a.rotor.rotation.z, 0, 'authority rollback restores the first chamber');
  animation.fire();
  animation.setState({ mag: 3 });
  animation.setState({ mag: 0, reloading: true });
  near(animation.pulse, 0, 'reload cancels the discharge');
  pulse(0);
  animation.update(5);
  assert.equal(visible(), 0, 'elapsed reload time cannot create replacement fields');
  animation.cancelReload();
  assert.equal(visible(), 0, 'cancelled reload remains empty');

  disposeGunModels([guns[0]], caches[0]);
  assert.ok([...disposal[0].values()].every(count => count === 1), 'every first-gun plasma material is released once');
  assert.ok([...disposal[1].values()].every(count => count === 0), 'disposing one gun leaves the other plasma materials intact');
  b.plasma.update(0.2);
  near(b.plasma.time - otherTime, 0.2, 'the surviving gun still animates independently');
} finally {
  // A cleared model can safely pass through the normal rig teardown again.
  for (const [index, gun] of guns.entries()) disposeGunModels([gun], caches[index]);
}
assert.ok(disposal.every(counts => [...counts.values()].every(count => count === 1)), 'both guns release all field materials without double disposal');
console.log('TB-4 plasma: five owned fields, independent timing, reduced-motion indexing, ammo authority, rollback, reload and disposal passed.');
