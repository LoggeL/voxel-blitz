import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { ProjectileFX } from '../public/js/weapons/projectiles.js';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera();
const emitted = new Set();
let frameTrails = 0, totalTrails = 0;
const fx = new ProjectileFX(scene, () => 0, {
  camera,
  onTrail: (_x, _y, _z, p) => { frameTrails++; totalTrails++; emitted.add(p.id); },
});
for (let i = 0; i < 192; i++) {
  fx.launch({ pid: `r${i}`, type: 'rocket', chaos: 2, o: [i, 4, 0], v: [0, 0, 1], fuse: 10000 });
}
for (let frame = 0; frame < 120; frame++) {
  frameTrails = 0;
  fx.update(1 / 60);
  assert.ok(frameTrails <= 12, 'trail bursts stay bounded');
}
assert.equal(fx.projectiles.size, 192, 'all rockets remain simulated');
const batches = scene.children.filter(object => object.isInstancedMesh);
assert.equal(batches.length, 3, 'rockets use three shared mesh batches');
assert.ok(batches.every(batch => batch.count === 192), 'all rockets are rendered in each batch');
const transform = new THREE.Matrix4();
batches[0].getMatrixAt(191, transform);
assert.ok(Math.abs(transform.elements[12] - 191) < 1e-5, 'instance preserves rocket position');
assert.ok(Math.abs(new THREE.Vector3().setFromMatrixScale(transform).x - 2.2) < 1e-5, 'instance preserves chaos scale');
assert.equal(emitted.size, 192, 'every rocket receives smoke emissions');
assert.ok(totalTrails <= 720, 'smoke rate stays within shared budget');
const lights = [];
scene.traverse(object => { if (object.isPointLight) lights.push(object); });
assert.equal(lights.length, 4, 'light count stays fixed during a full salvo');
assert.deepEqual(lights.map(light => light.position.x), [0, 1, 2, 3]);
camera.position.x = 191;
fx.update(0);
assert.deepEqual(lights.map(light => light.position.x), [191, 190, 189, 188]);
for (const id of [...fx.projectiles.keys()]) fx._removeProjectile(id);
fx.update(1 / 60);
assert.ok(lights.every(light => light.intensity === 0), 'empty pool emits no light');
fx.launch({ pid: 'single', type: 'rocket', o: [0, 4, 0], v: [0, 0, 1], fuse: 10000 });
totalTrails = 0;
for (let frame = 0; frame < 60; frame++) fx.update(1 / 60);
assert.ok(totalTrails >= 29 && totalTrails <= 31, 'single rocket retains normal smoke cadence');
for (let i = 0; i < 300; i++) fx.launch({pid: `extra${i}`, type: 'rocket', o:[i,4,0], v:[0,0,1], fuse:10000});
fx.update(1 / 60);
assert.ok(scene.children.filter(o => o.isInstancedMesh).every(o => o.count === 301), 'batch growth preserves excess local predictions');
fx.dispose();
assert.equal(scene.children.length, 0, 'dispose removes all projectile resources from scene');
console.log('ok - 192-rocket light budget, smoke budget, fairness, nearest lights, single-shot cadence and cleanup');
