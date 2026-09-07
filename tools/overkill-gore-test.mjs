import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { PlayerEntity } from '../server/sim/player.js';
import { GameEngine } from '../server/game.js';
import { evHit, evKill, evDie } from '../server/protocol/events.js';
import { GoreFX } from '../public/js/weapons/gore.js';
import { goreProfile, withGoreDamage } from '../public/js/weapons/gore-profile.js';
import { LocalPlayer } from '../public/js/player/local-player.js';
import { AvatarRoster } from '../public/js/avatar/avatar-roster.js';

const spawn = { x: 0, y: 2, z: 0, index: 0 };
const target = (health = 100, armor = 0) => Object.assign(new PlayerEntity('victim', 'Victim', spawn, false), { hp: health, armor });
for (const [hp, armor, incoming, healthDamage, excess, lethal] of [
  [100, 0, 100, 100, 0, true],
  [100, 0, 105, 105, 5, true],
  [25, 0, 125, 125, 100, true],
  [100, 100, 200, 100, 0, true],
  [25, 100, 135, 35, 10, true],
  [100, 100, 50, 0, 0, false],
  [100, 0, 20, 20, 0, false],
  [100, 0, 1e9, 1e9, 1e9 - 100, true],
]) {
  const victim = target(hp, armor);
  assert.equal(victim.takeDamage(incoming), lethal);
  assert.deepEqual(victim.lastDamage, { healthBefore: hp, healthDamage, overkill: excess, lethal },
    'authoritative excess uses damage remaining after armor and health before the hit');
  const hit = evHit('owner', victim.id, incoming, false, [0, 2, 0], victim.lastDamage);
  assert.equal(hit.dmg, incoming, 'existing incoming-damage field keeps its meaning');
  assert.equal(hit.overkill, excess); assert.equal(hit.healthDamage, healthDamage); assert.equal(hit.lethal, lethal);
  if (lethal) {
    const engine = { tickEvents: [], mode: { onPlayerDeath() {} } };
    GameEngine.prototype.killPlayer.call(engine, victim, null, 'rifle', false);
    assert.deepEqual(engine.tickEvents.map((event) => [event.kind, event.overkill, event.healthDamage]),
      [['die', excess, healthDamage], ['kill', excess, healthDamage]],
      'both death routes retain the server damage metadata');
  }
  victim.applySpawn(spawn);
  assert.equal(victim.lastDamage, null, 'respawn cannot carry over the previous killing hit');
}
const worldVictim = target();
worldVictim.takeDamage(20);
const worldEngine = { tickEvents: [], mode: { onPlayerDeath() {} } };
GameEngine.prototype.killPlayer.call(worldEngine, worldVictim, null, 'world', false);
assert.ok(worldEngine.tickEvents.every((event) => event.overkill === undefined),
  'a later world death cannot reuse an unrelated hit as its killing damage');
assert.equal(evHit('a', 'v', 25, false, [0, 0, 0]).overkill, undefined);
assert.equal(evKill('a', 'v', 'rifle', false).overkill, undefined);
assert.equal(evDie('v').overkill, undefined, 'legacy event constructors remain valid');

const samples = [0, 5, 30, 100, 200, 1e9].map((overkill) => goreProfile({ overkill }, { lethal: true }));
for (const field of ['mistCount', 'dropletCount', 'chunkCount', 'width', 'mistSize', 'dropletSize', 'stainSize']) {
  assert.ok(samples[0][field] < samples[1][field] && samples[1][field] < samples[3][field],
    `${field} distinguishes exact lethal, small excess and substantial overkill`);
  assert.equal(samples[4][field], samples[5][field], `${field} saturates for extreme damage`);
}
assert.deepEqual(goreProfile({}, { lethal: true }), goreProfile({ overkill: 0 }, { lethal: true }),
  'legacy lethal events use restrained zero-excess feedback');
for (const overkill of [NaN, Infinity, -Infinity, -3, '200']) {
  const profile = goreProfile({ overkill }, { lethal: true });
  assert.ok(Object.values(profile).every(Number.isFinite), 'invalid metadata never creates nonfinite particle state');
}
assert.equal(goreProfile({ overkill: 200, healthDamage: 0 }).mistCount, 0,
  'a fully absorbed nonlethal impact never splatters');
assert.equal(goreProfile({ overkill: 200, healthDamage: 0 }).chunkCount, 0);

const impact = { vx: 1, vy: 2, vz: 3, hs: true, overkill: 10 };
assert.deepEqual(withGoreDamage(impact, { overkill: 55, healthDamage: 75 }),
  { ...impact, overkill: 55, healthDamage: 75 }, 'death metadata preserves the impact position and headshot');
const local = { _alive: true, _lastLocalImpact: null, physics: { pos: { x: 1, y: 2, z: 3 } }, _impulseRecoil() {} };
const transition = LocalPlayer.prototype.die.call(local, 'owner', { damageEvent: { overkill: 55, healthDamage: 75 } });
assert.equal(transition.goreImpact.overkill, 55, 'a local death without a hit packet still receives excess damage');
assert.equal(transition.goreImpact.healthDamage, 75);

function seededRandom() {
  let state = 0x37acf82;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 2 ** 32; };
}
const originalRandom = Math.random;
const originalDocument = globalThis.document;
const canvasContext = new Proxy({ measureText: () => ({ width: 60 }) },
  { get: (target, key) => target[key] ?? (() => {}) });
const runs = [];
try {
  for (const overkill of [0, 10, 100, 200, 1e9]) {
    Math.random = seededRandom();
    const scene = new THREE.Scene();
    const fx = new GoreFX(scene, null, (_x, y) => y < 0 ? 1 : 0);
    fx.gore({ vx: 0, vy: 1.6, vz: 0, normal: [0, 1, 0], overkill }, { lethal: true });
    const active = (pool) => pool.filter((particle) => particle.active);
    runs.push({ mist: active(fx.goreMist).length, droplets: active(fx.goreDroplets).length,
      chunks: active(fx.goreChunks).length, stain: active(fx.goreStains)[0].size });
    for (let i = 0; i < 30; i++) fx.gore({ vx: 0, vy: 1.6, vz: 0, hs: true, overkill: 1e9 }, { lethal: true });
    assert.deepEqual([fx.goreMist.length, fx.goreDroplets.length, fx.goreChunks.length, fx.goreStains.length],
      [256, 640, 192, 384], 'saturation preserves all existing particle and stain caps');
    assert.ok(fx.goreMeshes.every((mesh) => mesh.instanceMatrix.array.every(Number.isFinite)));
    for (let i = 0; i < 300; i++) fx.update(0.1);
    assert.ok([fx.goreMist, fx.goreDroplets, fx.goreChunks, fx.goreStains].every((pool) => active(pool).length === 0),
      'all excess-driven particles, chunk trails and stains still expire');
    fx.dispose(); assert.equal(scene.children.length, 0);
  }
  for (const field of ['mist', 'droplets', 'chunks']) {
    assert.ok(runs[0][field] < runs[1][field] && runs[1][field] < runs[2][field]);
    assert.equal(runs[3][field], runs[4][field]);
  }
  assert.ok(runs[0].stain < runs[2].stain, 'actual surface stains increase with excess damage');
  const scene = new THREE.Scene();
  const fx = new GoreFX(scene, new THREE.PerspectiveCamera(), () => 0);
  fx.gore({ vx: 0, vy: 1, vz: 0, healthDamage: 0, normal: [0, 1, 0] }, { local: true });
  assert.ok([fx.goreMist, fx.goreDroplets, fx.goreChunks, fx.goreStains, fx.goreVeil]
    .every((pool) => pool.every((entry) => !entry.active)), 'armor-only hits emit no blood, stain, chunk or camera veil');
  fx.dispose();

  const received = [];
  globalThis.document = { createElement: () => ({ getContext: () => canvasContext }) };
  const roster = new AvatarRoster({ scene: new THREE.Scene(), now: () => 0, gore: (event) => received.push(event) });
  const row = { id: 'remote', name: 'Remote', team: null, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 100, state: 'alive', w: 0 };
  roster.death('remote', 0, { overkill: 87, healthDamage: 100 });
  roster.sync(new Map([[row.id, row]]), 0, 0);
  assert.equal(received.length, 1);
  assert.equal(received[0].overkill, 87, 'a pending remote death keeps excess metadata until the avatar arrives');
  roster.dispose();
} finally {
  Math.random = originalRandom;
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
}
console.log('Overkill gore: post-armor lethal excess, death metadata, local/remote passthrough, bounded zero/low/high/extreme splatter, armor-only suppression and cleanup passed.');
