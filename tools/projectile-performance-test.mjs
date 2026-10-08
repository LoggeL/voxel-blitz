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

// A shell's camera-facing wake uses a fixed active budget and never bridges a sync jump.
const mglScene = new THREE.Scene();
const mglCamera = new THREE.PerspectiveCamera();
mglCamera.position.set(0, 4, 10);
mglCamera.lookAt(0, 4, 0);
mglCamera.updateMatrixWorld();
const mglFx = new ProjectileFX(mglScene, () => 0, { camera: mglCamera });
for (let i = 0; i < 40; i++) mglFx.launch({ pid: `m${i}`, type: 'mgl', o: [i, 4, 0], v: [0, 0, -32] });
assert.equal(mglFx._mglTrailCount, 32, 'shell wake has a fixed active limit');
for (let frame = 0; frame < 8; frame++) mglFx.update(1 / 60);
const shell = mglFx.projectiles.get('m0');
assert.ok(shell.mglTrail.geometry.drawRange.count > 0, 'moving shell draws its wake');
assert.ok(Math.abs(shell.mglTrail.positions[0] - shell.mglTrail.positions[3]) > 0.15,
  'wake keeps visible width when the shell flies toward the camera');
mglFx.updateAuthority({ pid: 'm0', o: [12, 4, -4], v: [0, 0, -32] });
assert.equal(shell.mglTrail.geometry.drawRange.count, 0, 'authority correction clears the old path');
mglFx.update(1 / 60);
assert.equal(shell.mglTrail.geometry.drawRange.count, 6, 'new wake starts from corrected position');
mglFx.clear();
mglFx.launch({ type: 'mgl', o: [0, 4, 0], v: [0, 0, -32] }, { local: true });
for (let frame = 0; frame < 6; frame++) mglFx.update(1 / 60);
const predicted = [...mglFx.projectiles.values()].find(p => p.local && p.type === 'mgl');
const predictedZ = predicted.z;
assert.ok(mglFx.launch({ pid: 'adopted', type: 'mgl', o: [0, 4, 0], v: [0, 0, -32], bn: 6 }, { fromSelf: true }));
assert.ok(Math.abs(mglFx.projectiles.get('adopted').z - predictedZ) < 1e-6,
  'authority launch adopts the advanced shell without snapping to its old muzzle');
assert.equal(mglFx.projectiles.get('adopted').bouncesLeft, 6,
  'unspent local prediction receives the full Chaos bounce budget');
const adopted = mglFx.projectiles.get('adopted');
mglFx.updateAuthority({ pid: 'adopted', o: [adopted.x, adopted.y, adopted.z],
  v: [adopted.vx, adopted.vy, adopted.vz], bn: 2 });
assert.equal(adopted.bouncesLeft, 2, 'later authority update owns the exact remaining budget');

mglFx.clear();
let contactMade = false;
mglFx.raycast = (_x, _y, z) => {
  if (contactMade || z > -0.45) return null;
  contactMade = true;
  return { x: 0, y: 4, z: -0.5, nx: 0, ny: 0, nz: 1, t: 0.01 };
};
mglFx.launch({ type: 'mgl', o: [0, 4, 0], v: [0, 0, -32] }, { local: true });
for (let frame = 0; frame < 12 && !contactMade; frame++) mglFx.update(1 / 60);
const bounced = [...mglFx.projectiles.values()].find(p => p.local && p.type === 'mgl');
assert.ok(contactMade && bounced.bouncesLeft === 3 && bounced.vz > 0, 'shared flight spends one bounce and reflects the shell');
const reflectedVz = bounced.vz;
assert.ok(mglFx.launch({ pid: 'bounced', type: 'mgl', o: [0, 4, 0], v: [0, 0, -32], bn: 6 }, { fromSelf: true }));
assert.equal(mglFx.projectiles.get('bounced').bouncesLeft, 5,
  'Chaos authority budget retains the bounce already spent by prediction');
assert.equal(mglFx.projectiles.get('bounced').vz, reflectedVz,
  'authority launch does not overwrite the reflected velocity with launch velocity');
mglFx.dispose();
assert.equal(mglScene.children.length, 0, 'shell wake resources are released');

// Conquest tank shell: a tracer streak on the ballistic integrator, no rocket body, exhaust or smoke trail.
{
  const shellScene = new THREE.Scene();
  let shellTrails = 0;
  const shellFx = new ProjectileFX(shellScene, () => 0, { camera, onTrail: () => { shellTrails++; } });
  assert.ok(shellFx.launch({ pid: 's1', type: 'shell', o: [0, 20, 0], v: [0, 0, -250], fuse: 4000, vehicleWeapon: 'tankAP', g: 9.8 }));
  const round = shellFx.projectiles.get('s1');
  assert.equal(round.type, 'shell'); assert.equal(round.gravity, 9.8);
  assert.ok(!round.group.userData.exhaust && round.group.userData.streak, 'tracer streak, no rocket exhaust');
  for (let frame = 0; frame < 60; frame++) shellFx.update(1 / 60);
  assert.equal(shellTrails, 0, 'a shell leaves no smoke trail');
  assert.equal(shellFx._rocketBatches[0].count, 0, 'and draws no rocket body');
  assert.ok(Math.abs(round.z - -250) < 0.5, 'flies 250 m in a second');
  assert.ok(Math.abs(round.y - (20 - 0.5 * 9.8)) < 0.2, `drops g t^2 / 2 (y ${round.y})`);
  assert.ok(Math.abs(round.group.userData.streak.core.scale.z - 9) < 1e-9, 'the streak reaches full length');
  assert.ok(shellFx._lights.some(light => light.intensity > 0), 'the tracer lights its surroundings');
  shellFx.explode({ pid: 's1', type: 'shell', x: round.x, y: round.y, z: round.z, radius: 5.5, vehicleWeapon: 'tankHE' });
  assert.equal(shellFx.projectiles.size, 0); assert.ok(shellFx.blasts.length > 0, 'a shell blast spawns');
  shellFx.dispose();
}
console.log('ok - 192-rocket budgets, shell wake cap/correction, Chaos bounce adoption, tank shell tracer and cleanup');
