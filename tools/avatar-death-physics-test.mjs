import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { makeAvatar, updateAvatarWeaponPose, updateAvatarStancePose, beginAvatarDeath,
  updateAvatarDeath, resetAvatarPose, disposeAvatar } from '../public/js/avatar/avatar.js';
import { prepareDeathPart, stepDeathPart } from '../public/js/avatar/death-physics.js';
import { AvatarRoster } from '../public/js/avatar/avatar-roster.js';

globalThis.document = { createElement: () => ({ getContext: () => new Proxy({}, {
  get: (object, key) => object[key] ?? (() => {}),
}) }) };

for (const proneT of [0, 1]) {
  const av = makeAvatar('death-test', 'Test');
  av.group.position.set(8, 4, -12);
  av.group.rotation.y = 1.2;
  updateAvatarWeaponPose(av, { weapon: 'minigun', pitch: 0.6, firing: true, proneT, dt: 1 / 60 });
  updateAvatarStancePose(av);
  av.group.updateMatrixWorld(true);
  const before = av.limbStates.map(p => p.object.matrixWorld.clone());
  assert.ok(beginAvatarDeath(av, 100, { hs: true }));
  av.group.updateMatrixWorld(true);
  av.limbStates.forEach((part, i) => {
    assert.ok(part.object.matrixWorld.elements.every((v, j) => Math.abs(v - before[i].elements[j]) < 1e-9),
      'death preserves the posed world transform');
  });
  const weapon = av.limbStates.find(p => p.object === av.weaponModel.root);
  assert.ok(weapon && weapon.velocity.length() > 5, 'weapon receives its own launch velocity');
  const start = weapon.object.position.clone();
  for (let i = 0; i < 300; i++) updateAvatarDeath(av, 1 / 120, i / 300, (x, y) => y < 0);
  assert.ok(weapon.object.position.distanceTo(start) > 1, 'weapon flies away');
  for (const part of av.limbStates) {
    part.object.updateWorldMatrix(true, false);
    const box = part.bounds.clone().applyMatrix4(part.object.matrixWorld);
    assert.ok(box.min.y >= -0.002, 'all pieces stay above the actual ground');
  }
  resetAvatarPose(av);
  assert.equal(av.limbStates.length, 8);
  assert.equal(av.head.position.y, 1.66);
  assert.equal(av.lLeg.position.y, 0.73);
  assert.equal(av.weaponModel.root.position.y > 1, true);
  disposeAvatar(av);
}

function cube(x, y, vx, vy) {
  const object = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4));
  object.position.set(x, y, 0.5);
  const part = { object, velocity: new THREE.Vector3(vx, vy, 0), angular: new THREE.Vector3() };
  prepareDeathPart(part);
  return part;
}
const wall = cube(0.5, 2, 100, 0);
stepDeathPart(wall, 0.1, x => x === 2);
assert.ok(wall.object.position.x <= 1.801, 'fast pieces cannot tunnel through a one-voxel wall');
assert.ok(wall.velocity.x < 0, 'wall impact bounces');
const ceiling = cube(0.5, 1, 0, 100);
stepDeathPart(ceiling, 0.1, (x, y) => y === 3);
assert.ok(ceiling.object.position.y <= 2.801, 'ceiling blocks upward launch');
const ledge = cube(0.5, 3.2, 12, 0);
for (let i = 0; i < 120; i++) stepDeathPart(ledge, 1 / 120, (x, y) => x === 0 && y === 2);
assert.ok(ledge.object.position.x > 1 && ledge.object.position.y < 2, 'pieces fall off elevated ledges');
const support = cube(0.5, 3.2, 0, 0);
for (let i = 0; i < 60; i++) stepDeathPart(support, 1 / 120, (x, y) => y === 2);
assert.ok(support.object.position.y >= 3.199, 'elevated terrain supports pieces');
for (let i = 0; i < 60; i++) stepDeathPart(support, 1 / 120, () => false);
assert.ok(support.object.position.y < 3, 'destroyed terrain stops supporting the corpse');
const roster = new AvatarRoster({ scene: new THREE.Scene(), getBlock: () => 0 });
const remote = { id: 'remote', name: 'Test', x: 8, y: 4, z: 2, yaw: 1, state: 'alive', weapon: 0 };
roster.sync(new Map([[remote.id, remote]]), 1 / 60, 100);
roster.death(remote.id, 100);
const av = roster._avatars.get(remote.id);
const head = av.head.position.clone();
roster.sync(new Map([[remote.id, { ...remote, state: 'dead', x: 100 }]]), 0, 120);
assert.ok(av.head.getWorldPosition(new THREE.Vector3()).distanceTo(head) < 1e-9,
  'dead snapshots cannot drag detached pieces');
roster.dispose();
console.log('Death physics passed: posed breakup, weapon launch, ground, walls, ceilings, ledges, terrain removal, snapshot isolation and respawn.');
