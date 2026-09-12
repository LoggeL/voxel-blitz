import assert from 'node:assert/strict';
import { PRONE, stepProne, stanceEye } from '../shared/player-stance.js';
import { playerHitboxes } from '../shared/player-hitboxes.js';
import { Input } from '../public/js/engine/input.js';
import * as THREE from '../public/js/vendor/three.module.js';
import { makeAvatar, updateAvatarWeaponPose, updateAvatarStancePose, resetAvatarPose, disposeAvatar } from '../public/js/avatar/avatar.js';
const input = new Input({});
input.fallback = true;
const event = (repeat = false) => ({ code: 'KeyX', repeat, preventDefault() {} });
input._onKeyDown(event());
assert.equal(input.keys.prone, true);
input._onKeyDown(event(true));
input._onKeyUp(event());
assert.equal(input.keys.prone, true, 'repeat and release preserve toggle');
input._onKeyDown(event());
assert.equal(input.keys.prone, false);
input._gameplayEnabled = false;
input._onKeyDown(event());
assert.equal(input.keys.prone, false, 'menus cannot toggle stance');
let t = 0;
for (let i = 0; i < 20; i++) t = stepProne(t, true, 1 / 60);
assert.ok(t > 0 && t < 1);
const halfway = t;
t = stepProne(t, false, 1 / 60);
assert.ok(t < halfway && t > 0, 'reversal remains continuous');
for (let i = 0; i < 60; i++) t = stepProne(t, true, 1 / 60);
assert.equal(t, 1);
assert.equal(stanceEye(1.62, false, t), PRONE.eye);
for (let i = 0; i < 47; i++) t = stepProne(t, false, 1 / 60);
assert.ok(t > 0, 'standing takes the full transition');
t = stepProne(t, false, 1 / 60);
assert.ok(t < 1e-12);
globalThis.document = { createElement: () => ({ getContext: () => new Proxy({}, {
  get: (object, key) => object[key] ?? (() => {}),
}) }) };
const av = makeAvatar('prone-test', 'Prone');
for (let frame = 0; frame <= 120; frame++) {
  const proneT = frame <= 60 ? frame / 60 : (120 - frame) / 60;
  updateAvatarWeaponPose(av, { weapon: 'rifle', proneT, dt: 1 / 60 });
  updateAvatarStancePose(av);
  av.group.updateMatrixWorld(true);
  for (const [hand, anchor] of [[av.rHand, av.weaponModel.handPose.grip], [av.lHand, av.weaponModel.handPose.support]]) {
    const expected = av.weaponModel.modelRoot.localToWorld(new THREE.Vector3(anchor.x, anchor.y, anchor.z));
    assert.ok(hand.getWorldPosition(new THREE.Vector3()).distanceTo(expected) < 1e-6);
  }
  const boxes = playerHitboxes({ x: 0, y: 0, z: 0, proneT });
  const head = boxes.find(box => box.zone === 'head');
  assert.ok(Math.abs(head.center[1] - av.head.position.y) < 1e-8, 'head hitbox follows animation');
  if (frame === 60) {
    assert.equal(av.torso.rotation.x, -Math.PI / 2);
    assert.ok(boxes.every(box => box.center[1] < 0.75), 'all prone hit zones are near the floor');
  }
}
resetAvatarPose(av);
assert.equal(av.pronePose, 0);
assert.equal(av.hips.position.z, 0);
disposeAvatar(av);
console.log('prone tests passed: toggle, timing, reversal, avatar hands, hitboxes and reset');

// Run real prediction and authoritative movement against the same flat floor.
const { PlayerPhysics } = await import('../public/js/player-physics.js');
const { stepMovement } = await import('../server/sim/movement.js');
const { WEAPONS } = await import('../shared/combatmath.js');
const floor = (x, y, z) => y < 10;
const client = new PlayerPhysics();
client.solid = floor;
Object.assign(client.pos, { x: 20, y: 10, z: 20 });
client.grounded = true;
const server = { x: 20, y: 10, z: 20, vx: 0, vy: 0, vz: 0, grounded: true,
  proneT: 0, def: WEAPONS.rifle, adsT: 0, coyote: 0, hist: [],
  input: { yaw: 0, pitch: 0, keys: { f: true, sprint: true, jump: true, prone: true } } };
for (let frame = 0; frame < 180; frame++) {
  const target = frame < 60 || (frame >= 75 && frame < 90);
  client.wantProne = server.input.keys.prone = target;
  // Release jump before returning upright to isolate transition movement.
  const jump = frame < 60;
  server.input.keys.jump = jump;
  client.step(1 / 60, { x: 0, z: -1 }, 6.2, jump, 1);
  stepMovement(server, 1 / 60, { solidAt: floor, now: frame * 1000 / 60, onFall() { assert.fail('fell'); } });
  assert.ok(Math.hypot(client.pos.x - server.x, client.pos.y - server.y, client.pos.z - server.z) < 1e-8);
  assert.equal(client.proneT, server.proneT);
  if (client.proneT > 0 || target) {
    assert.equal(server.sprint, false);
    assert.equal(server.y, 10, 'jump is blocked until upright');
  }
  assert.equal(server.hist.at(-1).proneT, server.proneT, 'rewind retains stance');
}
assert.equal(client.proneT, 0);
assert.equal(server.sprint, true);
console.log('prone prediction/server parity passed, including interrupted transitions, sprint/jump locks and rewind');
