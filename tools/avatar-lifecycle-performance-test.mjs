import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { AvatarRoster } from '../public/js/avatar/avatar-roster.js';
import { MC_WATER, MC_PORTAL, MC_GHOST_STONE, STONE } from '../shared/world/blocks.js';

const previousDocument = globalThis.document;
const context = new Proxy({ measureText: () => ({ width: 60 }) },
  { get: (target, key) => target[key] ?? (() => {}) });
globalThis.document = { createElement: () => ({ getContext: () => context }) };
try {
  let now = 0;
  const gore = [];
  const scene = new THREE.Scene();
  const roster = new AvatarRoster({ scene, now: () => now, getMyId: () => 'local', getBlock: () => 0,
    gore: (ev) => gore.push(ev) });
  const remote = { id: 'remote', name: 'Remote', x: 4, y: 1, z: 5, yaw: 0, pitch: 0, state: 'alive', weapon: 0, grounded: true };
  const rows = new Map([[remote.id, remote]]);
  roster.sync(rows, 1 / 60, now);
  roster.hit(remote.id, { vx: 99, vy: 99, vz: 99, hs: true });
  now = 3000;
  roster.death(remote.id, now, { overkill: 25, healthDamage: 40 });
  assert.equal(gore.length, 1);
  assert.deepEqual([gore[0].vx, gore[0].vy, gore[0].vz], [4, 2.08, 5], 'expired hit metadata cannot move a later death burst');
  assert.equal(gore[0].hs, false, 'an expired headshot cannot mark a later death as a headshot');
  assert.equal(gore[0].overkill, 25, 'the current death damage remains authoritative');
  roster.respawn(remote.id, remote);
  roster.hit(remote.id, { vx: 6, vy: 2, vz: 7, hs: true });
  now += 100;
  roster.death(remote.id, now, { overkill: 80 });
  assert.deepEqual([gore[1].vx, gore[1].vy, gore[1].vz], [6, 2, 7], 'a recent hit still supplies the death position');
  assert.equal(gore[1].hs, true);
  roster.dispose(); roster.dispose();
  assert.doesNotThrow(() => {
    roster.hit(remote.id, {}); roster.death(remote.id); roster.respawn(remote.id, remote);
    roster.swingPickaxe(remote.id); roster.sync(rows, 1 / 60, now);
  }, 'late events after disposal are ignored');
  assert.equal(roster.muzzleWorldPos(remote.id, new THREE.Vector3()), null);
  assert.equal(scene.children.length, 0);
  assert.equal(roster.size, 0);
  assert.equal(roster._burnFX, null);

  for (const type of [0, false, MC_WATER, MC_PORTAL, MC_GHOST_STONE]) {
    const passable = new AvatarRoster({ scene: new THREE.Scene(), getBlock: () => type });
    assert.equal(passable._solidAt(0, 0, 0), false, 'corpse collision ignores air, fluids, portals and ghost blocks');
    passable.dispose();
  }
  for (const type of [true, STONE]) {
    const solid = new AvatarRoster({ scene: new THREE.Scene(), getBlock: () => type });
    assert.equal(solid._solidAt(0, 0, 0), true, 'numeric blocks and boolean solidity fixtures both remain supported');
    solid.dispose();
  }
} finally {
  globalThis.document = previousDocument;
}
console.log('ok - avatar death metadata TTL, fresh-hit parity, late events, idempotent disposal and passable corpse collision');
