import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { SelvedgeFX } from '../public/js/weapons/selvedge-fx.js';
import { MAX_PLAYERS } from '../shared/lobby-limits.js';
import { NetClient, RING_LEN, drainEventsWithDedupe, drainOwnEventsEarly } from '../public/js/engine/netclient.js';

const scene = new THREE.Scene(), arrivals = [];
const fx = new SelvedgeFX(scene, pos => arrivals.push(pos));
const pin = { kind: 'stitch', phase: 'pin', id: 'a', a: [1, 0.06, 0], n: [0, 1, 0], ms: 6000 };
const sew = { kind: 'stitch', phase: 'sew', id: 'a', a: pin.a, b: [17, 0.06, 0], ms: 1000, radius: 1.15 };
const cast = { kind: 'shoot', id: 'a', w: 'selvedge', o: [0, 2, 2], end: pin.a };
const foreign = { ...pin, id: 'b' };
const ring = [{ snapSeq: 1, now: 100, events: [cast, pin, foreign] }], state = {};
assert.deepEqual(drainOwnEventsEarly(ring, 'a', state), [cast, pin]);
assert.deepEqual(drainEventsWithDedupe(ring, 100, state), [foreign]);
fx.stitch(pin);
fx.stitch({ ...pin, reason: 'long' });
assert.equal(fx.pinReason('a'), 'long');
fx.stitch(foreign);
fx.update(1.5);
assert.equal(fx.pinReason('a'), null, 'refusal guidance gives way to the current pin');

assert.equal(fx.pinRemainingMs('a'), 4500);
assert.equal(fx.pins.get('a').meshes[0].material.depthTest, true);
assert.deepEqual(new THREE.Vector3(0, 0, 1).applyQuaternion(fx.pins.get('a').meshes[0].quaternion)
  .toArray().map(Math.round), pin.n, 'collar lies flat on its actual surface');
fx.stitch(sew);
assert.equal(fx.pinRemainingMs('a'), 0);
assert.equal(fx.pinRemainingMs('b'), 4500);
fx.stitch({ ...pin, a: [4, 1, 0] });
fx.update(0.5);
const [warp, head] = fx.seams.get('a').meshes;
assert.deepEqual(head.position.toArray(), [9, 0.06, 0]);
assert.equal(head.scale.x, 1.15, 'crown represents the authoritative pulse radius');
assert.equal(warp.material.uniforms.front.value, 0.5, 'stitches close where the sweep has passed');
fx.stitch({ kind: 'stitch', phase: 'clear', id: 'a', part: 'pin' });
assert.equal(fx.pinRemainingMs('a'), 0);
assert.equal(fx.seams.size, 1);
fx.update(0.51);
assert.equal(head.visible, false);
assert.deepEqual(arrivals, [sew.b]);
fx.update(0.4);
assert.equal(fx.seams.size, 0);
fx.stitch(sew);
fx.stitch(pin);
fx.stitch({ kind: 'stitch', phase: 'clear', id: 'a', part: 'seam' });
fx.update(1);
assert.equal(fx.seams.size, 0);
assert.equal(fx.pinRemainingMs('a'), 5000);
assert.equal(arrivals.length, 1, 'interrupted shuttle cannot announce arrival');
fx.stitch({ phase: 'clear', id: 'a' });
fx.update(5);
assert.equal(scene.children.length, 0);
fx.shot({ ...cast, end: undefined });
assert.equal(scene.children.length, 0, 'predicted shots cannot invent world contacts');
fx.shot(cast, new THREE.Vector3(20, 20, 20));
assert.deepEqual(scene.children[0].position.toArray(), cast.o, 'remote pose mismatch uses authoritative origin');
fx.tag([1, 0.2, 2]);
assert.equal(scene.children.length, 2);
fx.update(1);
for (let i = 0; i < MAX_PLAYERS * 3; i++) {
  fx.shot(cast);
  fx.stitch({ ...pin, id: String(i) });
}
assert.equal(fx.flashes.length, MAX_PLAYERS * 2);
assert.equal(fx.pins.size, MAX_PLAYERS);
const resources = [...fx.geometry.values(), ...scene.children.map(mesh => mesh.material)];
let disposed = 0;
for (const resource of resources) resource.addEventListener('dispose', () => disposed++);
fx.dispose();
assert.equal(scene.children.length, 0);
assert.equal(disposed, resources.length);
console.log('ok - SELVEDGE pin lifetime, networking, visible radius, shuttle travel, scoped clears and bounded FX');

// Drive the receipt and interpolation paths on a shared test clock. A large
// map can take longer to build than the entire snapshot ring.
{
  const client = new NetClient();
  client.id = 'self';
  client._timing.mapServerTime = t => t;
  let at = 0;
  const tick = (...events) => client._onTick({ t: 'tick', now: at += 20, events });
  const drain = () => client.interpolate(at, 0).events;
  const frames = n => { for (let i = 0; i < n; i++) tick(); };
  tick({ ...pin, id: 'remote', restore: true }, { ...pin, id: 'old' }, { ...cast, id: 'self' });
  tick({ ...sew, id: 'remote', ms: 2000 });
  tick({ ...pin, id: 'remote', a: [0, 2, 2] },
    { ...pin, id: 'short', ms: 50 }, { ...pin, id: 'old', phase: 'clear', part: 'pin' });
  frames(RING_LEN + 4);
  const resumed = drain();
  assert.ok(!resumed.some(e => e.kind === 'shoot'), 'old casts do not replay');
  const active = resumed.filter(e => e.phase === 'pin' || e.phase === 'sew');
  assert.deepEqual(active.map(e => [e.id, e.phase, e.ageMs, e.silent]), [
    ['remote', 'sew', at - 40, true], ['remote', 'pin', at - 60, true],
  ], 'remote pulse and new pin survive the boot backlog at their original ages');
  assert.deepEqual(drain(), []);
  const state = new SelvedgeFX(new THREE.Scene());
  for (const e of resumed) state.stitch(e);
  assert.equal(state.pinRemainingMs('remote'), 6000 - (at - 60));
  assert.ok(Math.abs(state.seams.get('remote').meshes[1].position.x - (1 + 16 * (at - 40) / 2000)) < 0.001);
  tick({ ...pin, id: 'remote', phase: 'clear', part: 'seam' });
  frames(RING_LEN + 2);
  const clears = drain();
  assert.ok(clears.some(e => e.phase === 'clear' && e.part === 'seam'));
  for (const e of clears) state.stitch(e);
  assert.equal(state.seams.size, 0);
  assert.equal(state.pins.size, 1, 'clearing an evicted seam preserves its newer pin');
  state.dispose();
  tick({ ...pin, id: 'new', restore: true, ms: 2400 });
  tick();
  const restored = drain();
  assert.equal(restored.length, 1);
  assert.equal(restored[0].ageMs, 20);
  assert.ok(restored[0].silent, 'a join snapshot is silent even on a fast boot');
  tick(pin, { ...cast, id: 'self' });
  const fresh = drain();
  assert.deepEqual(fresh.map(e => [e.kind, !!e.silent]), [['shoot', false], ['stitch', false]]);
  tick(pin);
  frames(RING_LEN + 1);
  client._resetSessionState(false);
  client.id = 'next';
  tick();
  assert.deepEqual(drain(), [], 'previous sessions do not restore their anchors');
}
