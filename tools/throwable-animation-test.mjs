import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { ViewmodelRig } from '../public/js/guns/viewmodel.js';
import { QUICK_THROW_CUE_DELAY, THROWABLE_TIMING, ThrowableHands } from '../public/js/guns/throwable-hands.js';
import { GRENADE_PIN_MS, GRENADE_POWER_STEPS } from '../shared/grenade-rules.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} differs from ${b}`);
assert.equal(THROWABLE_TIMING.arm * 1000, GRENADE_PIN_MS, 'the visible pin pull is the shared cook origin');
const cues = () => events.map(event => event.cue);
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
    const contact = type === 'molotov' ? ['ignite'] : type === 'limpet' ? [] : ['pin'];
    hands.setCharge(0.2, index, GRENADE_PIN_MS - 10, true);
    hands.update(0.001);
    assert.deepEqual(events.map(event => event.cue), ['draw'], 'no sound before pin or lighter contact');
    hands.setCharge(0.3, index, GRENADE_PIN_MS + 2, true);
    hands.update(0.001);
    assert.deepEqual(events.map(event => event.cue), ['draw', ...contact],
      type === 'limpet' ? 'the limpet has no pin to pull' : 'contact lands exactly at GRENADE_PIN_MS');
    if (type === 'limpet') {
      assert.equal(hands.pin.visible, false, 'the limpet never shows a safety ring');
      assert.ok(hands.left.position.y < -0.5, 'the arming hand never reaches across for a limpet pin');
    } else if (type !== 'molotov') {
      hands.setCharge(0.3, index, GRENADE_PIN_MS + 90, true);
      hands.update(0.001);
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
    assert.deepEqual(events.map(event => event.cue), ['draw', ...contact, 'ready']);
    hands.update(0.25);
    assert.equal(events.length, 2 + contact.length, 'holding does not replay preparation sounds');
    hands.throw(1, index);
    assert.equal(cues().at(-1), type === 'limpet' ? 'clamp' : 'throw',
      'a held release whooshes at once; a limpet plants with a clamp instead');
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
  hands.throw(0.6, 3);
  assert.equal(hands.root.visible, true, 'a quick tap still produces the throw gesture');
  assert.equal(hands.grip.visible, false);
  assert.deepEqual(cues(), ['draw', 'ignite'], 'a quick tap sounds the contact at once');
  hands.update(QUICK_THROW_CUE_DELAY * 0.6);
  assert.deepEqual(cues(), ['draw', 'ignite'], 'the whoosh does not share the contact frame');
  hands.update(QUICK_THROW_CUE_DELAY * 0.5);
  assert.deepEqual(cues(), ['draw', 'ignite', 'throw'], 'the whoosh follows about 70 ms later');
  hands.update(0.5);
  assert.equal(events.length, 3, 'the delayed whoosh plays once');
  events.length = 0;
  hands.throw(0.6, 0);
  hands.update(0.01);
  hands.throw(0.6, 0);
  assert.deepEqual(cues(), ['draw', 'pin', 'throw', 'draw', 'pin'],
    'a pending whoosh is flushed, never dropped, when the next throwable draws');
  hands.cancel();
  events.length = 0;
  hands.throw(0.6, 1);
  hands.update(0.2);
  assert.deepEqual(cues(), ['draw', 'clamp'], 'a quick limpet plant clamps without a pin or whoosh');
  hands.cancel();

  events.length = 0;
  hands.setCharge(1, 0, 1300, true);
  hands.update(0.01);
  hands.setCharge(1, 1, 1300, true);
  hands.update(0.01);
  assert.equal(hands.type, 'frag', 'the held type is locked until the hold ends');
  assert.equal(hands.models.limpet.visible, false);
  assert.deepEqual(cues(), ['draw', 'pin', 'ready'], 'a type change mid-hold never restarts the draw');
  hands.cancel();

  // Pin back: the ring travels back to its socket with the arming hand, then both drop.
  events.length = 0;
  hands.setCharge(0.6, 0, 800, true);
  hands.update(0.01);
  const pulledPin = hands.pin.position.clone();
  const socketAt = () => hands.root.worldToLocal(hands.grip.localToWorld(new THREE.Vector3(-0.024, 0.088, 0.019)));
  assert.ok(pulledPin.distanceTo(socketAt()) > 0.04);
  hands.cancel({ reseat: true });
  assert.equal(cues().at(-1), 'cancel', 'pin back emits the cancel cue');
  assert.equal(hands.held, false);
  hands.update(THROWABLE_TIMING.reseat * 0.4);
  assert.equal(hands.root.visible, true, 'the reseat is visible');
  assert.equal(hands.left.visible, true, 'the arming hand comes back with the pin');
  assert.equal(hands.pin.visible, true);
  assert.ok(hands.pin.position.distanceTo(socketAt()) < pulledPin.distanceTo(socketAt()) * 0.5,
    'the pin travels back towards its socket');
  hands.update(THROWABLE_TIMING.reseat);
  assert.equal(hands.root.visible, false, 'the hands drop out after the reseat');
  assert.equal(hands.reseatElapsed, null);
  assert.equal(events.filter(event => event.cue === 'throw').length, 0, 'a pin back never whooshes');
  hands.setCharge(0.6, 3, 800, true);
  hands.update(0.01);
  assert.equal(hands.wickFlame.visible, true);
  hands.cancel({ reseat: true });
  hands.update(0.01);
  assert.equal(hands.wickFlame.visible, false, 'a molotov pin back snuffs the wick');
  hands.cancel({ reseat: true });
  hands.update(THROWABLE_TIMING.reseat);
  assert.equal(hands.root.visible, false);
  events.length = 0;
  hands.cancel({ reseat: true });
  assert.deepEqual(cues(), [], 'nothing to reseat without a throwable in hand');

  // The LOB step swings underhand; the other steps cock back over the shoulder by power.
  const swingPitch = (power) => {
    hands.cancel();
    hands.setCharge(power, 0, 900, true);
    hands.update(0.01);
    const held = { x: hands.right.rotation.x, y: hands.right.position.y };
    hands.throw(power, 0);
    hands.update(THROWABLE_TIMING.throw * 0.3);
    return { held, swing: hands.right.rotation.x - held.x };
  };
  const lob = swingPitch(GRENADE_POWER_STEPS[0]);
  const mid = swingPitch(GRENADE_POWER_STEPS[2]);
  const far = swingPitch(GRENADE_POWER_STEPS[4]);
  assert.ok(lob.swing > 0 && mid.swing < 0 && far.swing < 0, 'LOB pitches forward underhand, others overhand');
  assert.ok(lob.held.y < mid.held.y - 0.05, 'the underhand hold carries the grenade low');
  hands.cancel();
  hands.setCharge(GRENADE_POWER_STEPS[4], 0, 900, true);
  hands.update(0.01);
  const farX = hands.right.position.x;
  hands.cancel();
  hands.setCharge(GRENADE_POWER_STEPS[1], 0, 900, true);
  hands.update(0.01);
  assert.ok(farX > hands.right.position.x + 0.02, 'cock-back depth scales with the selected power');
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
    rig.cancelGrenade({ reseat: true });
    assert.equal(rig.grenadeActive, true, 'the pin back keeps the gun holstered while the hands reseat');
    assert.equal(rig.fire(), false);
    for (let i = 0; i < 30; i++) rig.update(1 / 60);
    assert.equal(rig.grenadeActive, false);
    rig.grenadeCharge(0.4, 3, 600, true);
    rig.update(0.01);
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
console.log('Throwable animations: typed hand-held models, pin/ignition contacts at GRENADE_PIN_MS, limpet clamp, type lock, quick-tap cue spacing, pin back reseat, power-scaled and underhand swings, firearm visibility and frame independence passed.');
