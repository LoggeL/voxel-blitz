import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { ViewmodelRig } from '../public/js/guns/viewmodel.js';
import { THROWABLE_TIMING, ThrowableHands } from '../public/js/guns/throwable-hands.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} differs from ${b}`);
const events = [];
const root = new THREE.Group();
const hands = new ThrowableHands(root, event => events.push(event));
try {
  for (const [index, type] of ['frag', 'limpet', 'pulse', 'molotov', 'smoke'].entries()) {
    hands.cancel();
    events.length = 0;
    hands.setCharge(0, index, 0, true);
    hands.update(0.01);
    assert.equal(hands.type, type);
    assert.equal(hands.held, true, 'zero strength still draws a held throwable');
    assert.equal(hands.root.visible, true);
    assert.equal(hands.models[type].visible, true);
    assert.equal(hands.grip.parent, hands.right, 'item follows the actual throwing hand');
    assert.equal(hands.left.visible, true);
    assert.deepEqual(events.map(event => event.cue), ['draw']);
    hands.setCharge(0.2, index, 230, true);
    hands.update(0.001);
    assert.deepEqual(events.map(event => event.cue), ['draw'], 'no sound before pin or lighter contact');
    hands.setCharge(0.3, index, 320, true);
    hands.update(0.001);
    assert.deepEqual(events.map(event => event.cue), ['draw', type === 'molotov' ? 'ignite' : 'pin']);
    if (type !== 'molotov') {
      const socket = hands.grip.localToWorld(new THREE.Vector3(-0.024, 0.088, 0.019));
      hands.root.worldToLocal(socket);
      assert.ok(socket.distanceTo(hands.pin.position) > 0.04, 'pin visibly separates into the left hand');
    } else {
      assert.equal(hands.wickFlame.visible, true, 'bottle wick lights with the ignition contact');
      assert.equal(hands.lighter.visible, true);
      assert.equal(hands.pin.visible, false, 'molotov never shows a grenade safety ring');
    }
    hands.setCharge(1, index, 1400, true);
    hands.update(0.001);
    assert.equal(hands.grip.visible, true, 'item stays in hand after full charge');
    assert.equal(hands.right.visible, true);
    assert.equal(hands.left.visible, false, 'arming hand clears the view after contact');
    assert.deepEqual(events.map(event => event.cue), ['draw', type === 'molotov' ? 'ignite' : 'pin', 'ready']);
    hands.update(0.25);
    assert.equal(events.length, 3, 'holding does not replay preparation sounds');
    hands.throw(1, index);
    assert.equal(hands.grip.visible, false, 'projectile immediately leaves the viewmodel on authoritative release');
    const heldPosition = hands.right.position.clone();
    hands.setCharge(0, index, 0, false);
    hands.update(0.1);
    assert.equal(hands.root.visible, true, 'inactive input does not cancel the throw follow-through');
    assert.ok(hands.right.position.z < heldPosition.z - 0.15, 'throwing hand follows through forward');
    hands.update(0.25);
    hands.update(0.01);
    assert.equal(hands.root.visible, false);
    assert.equal(hands.blend, 0);
    assert.equal(hands.throwElapsed, null);
  }

  events.length = 0;
  hands.throw(0, 3);
  assert.equal(hands.root.visible, true, 'a quick tap still produces the throw gesture');
  assert.equal(hands.grip.visible, false);
  assert.deepEqual(events.map(event => event.cue), ['draw', 'ignite', 'throw']);
  hands.cancel();
  events.length = 0;
  hands.setCharge(1, 0, 1300, true);
  hands.update(0.01);
  hands.setCharge(1, 1, 1300, true);
  hands.update(0.01);
  assert.equal(events.at(-1).cue, 'draw', 'cycling type restarts the visible preparation despite the original hold clock');
  hands.setCharge(1, 1, 1540, true);
  hands.update(0.01);
  assert.equal(events.at(-1).cue, 'pin');
  hands.cancel();
  hands.setCharge(0.5, 0, 700, true);
  hands.update(0.01);
  hands.setCharge(0, 0, 0, false);
  hands.update(THROWABLE_TIMING.return);
  assert.equal(hands.root.visible, false, 'canceled hold stows the grenade');

  const sparse = new ThrowableHands(root);
  const dense = new ThrowableHands(root);
  try {
    dense.setCharge(0.6, 0, null, true);
    sparse.setCharge(0.6, 0, null, true);
    for (let i = 0; i < 60; i++) dense.update(0.01);
    sparse.update(0.2); sparse.update(0.2); sparse.update(0.2);
    near(dense.right.position.distanceTo(sparse.right.position), 0);
    near(dense.right.rotation.x, sparse.right.rotation.x);
    near(dense.pin.position.distanceTo(sparse.pin.position), 0);
  } finally { dense.dispose(); sparse.dispose(); }

  const camera = new THREE.PerspectiveCamera(75, 1.6, 0.01, 100);
  const rig = new ViewmodelRig(camera);
  try {
    rig.setWeapon('rifle');
    for (let i = 0; i < 100; i++) rig.update(1 / 60);
    const gunRestY = rig.content.position.y;
    rig.grenadeCharge(0, 0, 0, true);
    assert.equal(rig.grenadeActive, true);
    assert.equal(rig.fire(), false, 'gun cannot fire while grenade is in the hand');
    for (let i = 0; i < 60; i++) rig.update(1 / 60);
    assert.equal(rig.content.visible, false, 'held grenade holsters the actual weapon mesh');
    assert.ok(rig.content.position.y < gunRestY - 0.3);
    rig.grenadeThrow(1);
    for (let i = 0; i < 100; i++) rig.update(1 / 60);
    assert.equal(rig.grenadeActive, false);
    assert.equal(rig.content.visible, true);
    assert.ok(Math.abs(rig.content.position.y - gunRestY) < 0.003);
    rig.grenadeCharge(0.4, 3, 600, true);
    rig.update(0.01);
    rig.setWeapon('shotgun');
    assert.equal(rig._throwableHands.type, 'molotov', 'weapon equip does not replace a held throwable');
    assert.equal(rig.grenadeActive, true);
    rig.cancelGrenade();
    assert.equal(rig.grenadeActive, false);
    assert.equal(rig._throwableHands.wickFlame.visible, false);
    assert.equal(rig.content.visible, true);
    rig.root.traverse(object => {
      assert.ok(object.matrix.elements.every(Number.isFinite));
      assert.ok(object.position.toArray().every(Number.isFinite));
    });
  } finally { rig.dispose(); rig.dispose(); }
} finally { hands.dispose(); hands.dispose(); }
assert.equal(root.children.length, 0, 'all hand/model resources detach on disposal');
console.log('Throwable animations: typed hand-held models, synchronized pin/ignition contacts, charged hold, release, cancellation, firearm visibility and frame independence passed.');
