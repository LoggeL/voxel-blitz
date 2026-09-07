import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { ProjectileSystem } from '../server/sim/projectiles.js';
import { sweepPlayers } from '../server/sim/projectile-contact.js';
import { playerHitboxes, rayPlayerHitboxes } from '../shared/player-hitboxes.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { evProjectileUpdate } from '../server/protocol/events.js';
import { raycastVoxels } from '../shared/raycast.js';

// Frozen reference algorithms keep equivalence and cost comparisons useful after commits.
function visibleTo(ctx, origin, target, endMargin = 0.18) {
  const dx = target[0] - origin[0];
  const dy = target[1] - origin[1];
  const dz = target[2] - origin[2];
  const distance = Math.hypot(dx, dy, dz);
  if (distance <= endMargin) return true;
  return !raycastVoxels(
    (x, y, z) => ctx.getBlock(x, y, z) !== 0,
    origin[0], origin[1], origin[2], dx, dy, dz,
    distance - endMargin,
  );
}

class OldSystem {
  _home(projectile, dt, ctx) {
    const speed = Math.hypot(projectile.vx, projectile.vy, projectile.vz);
    if (speed < 0.1) return;
    let best = null, distance = 42;
    for (const v of ctx.entities.values()) {
      if (v === projectile.owner || v.state !== 'alive' || !ctx.canDamage(projectile.owner, v)) continue;
      const dx = v.x - projectile.x, dy = v.y + 1 - projectile.y, dz = v.z - projectile.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 0.1 || d >= distance || (dx * projectile.vx + dy * projectile.vy + dz * projectile.vz) / (d * speed) < 0.15) continue;
      if (!visibleTo(ctx, [projectile.x, projectile.y, projectile.z], [v.x, v.y + 1, v.z])) continue;
      distance = d; best = [dx / d, dy / d, dz / d];
    }
    if (!best) return;
    const t = Math.min(1, Math.max(0, dt) * 5);
    const vector = [projectile.vx / speed, projectile.vy / speed, projectile.vz / speed].map((v, i) => v * (1 - t) + best[i] * t);
    const norm = Math.hypot(...vector) || 1;
    [projectile.vx, projectile.vy, projectile.vz] = vector.map(v => v / norm * speed);
  }

}
function referenceSweep(from, to, radius, entities, canHit) {
  const direction = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  const origin = [from.x, from.y, from.z];
  let nearest = null;
  for (const victim of entities.values()) {
    if (!canHit(victim)) continue;
    const hit = rayPlayerHitboxes(origin, direction, victim, 1, { radius });
    if (!hit || (nearest && hit.t >= nearest.t)) continue;
    const { t, zone } = hit;
    nearest = {
      victim, t, zone,
      x: from.x + direction.x * t,
      y: from.y + direction.y * t,
      z: from.z + direction.z * t,
    };
  }
  return nearest;
}

const oldContact = { sweepPlayers: referenceSweep };

// Keep the broad-phase envelope honest across weapons and extreme poses.
for (let weapon = 0; weapon < WEAPON_IDS.length; weapon++)
for (const crouch of [false, true]) for (const ads of [false, true])
for (const reloading of [false, true]) for (const pitch of [-Math.PI / 2, 0, Math.PI / 2])
for (const yaw of [0, Math.PI / 4, Math.PI / 2, Math.PI]) {
  const p = { x: 0, y: 0, z: 0, weapon, crouch, ads, reloading, pitch, yaw, moveSpeed: 6 };
  for (const box of playerHitboxes(p)) for (let axis = 0; axis < 3; axis++) {
    const extent = box.half.reduce((sum, h, i) => sum + h * Math.abs(box.basis[i][axis]), 0);
    assert(Math.abs(box.center[axis]) + extent < 3, `${WEAPON_IDS[weapon]} ${box.zone} envelope`);
  }
}
let seed = 781;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const entities = new Map(Array.from({ length: 24 }, (_, i) => [String(i), {
  id: String(i), state: 'alive', x: random() * 40, y: random() * 3, z: random() * 40,
  yaw: random() * Math.PI * 2, pitch: random() * 3 - 1.5, weapon: i % WEAPON_IDS.length,
  crouch: i % 2 === 0, ads: i % 3 === 0, reloading: i % 5 === 0,
}]));
const segments = Array.from({ length: 192 }, () => {
  const from = { x: random() * 40, y: random() * 5, z: random() * 40 };
  return [from, { x: from.x + random() * 4 - 2, y: from.y + random() - 0.5, z: from.z + random() * 4 - 2 }];
});
let contacts = 0;
for (const [from, to] of segments) for (const radius of [0.04, 0.18, 0.5]) {
  const expected = oldContact.sweepPlayers(from, to, radius, entities, () => true);
  const actual = sweepPlayers(from, to, radius, entities, () => true);
  assert.deepEqual(actual, expected);
  if (actual) contacts++;
}
assert(contacts > 0, 'fixture exercises actual contacts as well as misses');
function measure(fn) {
  fn();
  const samples = [];
  for (let i = 0; i < 7; i++) { const start = performance.now(); fn(); samples.push(performance.now() - start); }
  return samples.sort((a, b) => a - b)[3];
}
const collision = {};
for (const [name, fn] of [['before', oldContact.sweepPlayers], ['after', sweepPlayers]]) {
  collision[name] = measure(() => { for (const [from, to] of segments) fn(from, to, 0.18, entities, () => true); });
}

const homing = {};
for (const blocked of [false, true]) {
  let expected;
  for (const [name, System] of [['before', OldSystem], ['after', ProjectileSystem]]) {
    const system = new System(); let reads = 0;
    const ctx = { entities: new Map(Array.from({ length: 24 }, (_, i) => [String(i), {
      id: String(i), state: 'alive', x: 3 + i % 2, y: 9, z: 40 - i,
    }])), canDamage: () => true,
      getBlock: (x, _y, z) => { reads++; return blocked && x === 2 && z < 15 ? 1 : 0; } };
    const p = { x: 0, y: 10, z: 0, vx: 0, vy: 0, vz: 30 };
    system._home(p, 1 / 30, ctx);
    if (!expected) expected = p;
    else for (const axis of ['vx', 'vy', 'vz']) assert(Math.abs(p[axis] - expected[axis]) < 1e-12);
    if (!blocked) homing[name] = reads;
  }
}
assert(homing.after < homing.before / 4, 'visible salvo avoids redundant terrain rays');
// No target, rear targets, dead targets and equal-distance ties keep old steering.
for (const targets of [[], [{x:0,y:9,z:-5}], [{x:0,y:9,z:5,state:'dead'}],
  [{x:3,y:9,z:10},{x:-3,y:9,z:10}]]) {
  const ctx = { entities: new Map(targets.map((v,i) => [i,{state:'alive',...v}])),
    canDamage: () => true, getBlock: () => 0 };
  const a = {x:0,y:10,z:0,vx:0,vy:0,vz:30}, b = {...a};
  new OldSystem()._home(a, 1/30, ctx); new ProjectileSystem()._home(b, 1/30, ctx);
  for (const axis of ['vx','vy','vz']) assert(Math.abs(a[axis]-b[axis]) < 1e-12);
}
// A nearer enemy behind terrain must not hide a farther visible target.
{
  const ctx = { entities: new Map([
    ['near', {state:'alive',x:3,y:9,z:8}], ['far', {state:'alive',x:-3,y:9,z:12}],
  ]), canDamage: () => true, getBlock: (x,_y,z) => x === 1 && z === 3 ? 1 : 0 };
  const a = {x:0,y:10,z:0,vx:0,vy:0,vz:30}, b = {...a};
  new OldSystem()._home(a, 1/30, ctx); new ProjectileSystem()._home(b, 1/30, ctx);
  assert(b.vx < 0, 'steers toward farther visible enemy');
  for (const axis of ['vx','vy','vz']) assert(Math.abs(a[axis]-b[axis]) < 1e-12);
}
const o = [12.345678901234, 7.89123456789, 21.1234567890123];
const v = [3.456789012345, -1.234567890123, 29.987654321098];
const event = evProjectileUpdate('r123', o, v, 8);
for (const [before, after] of [[o, event.o], [v, event.v]])
  before.forEach((n,i) => assert(Math.abs(n-after[i]) <= 0.0051));
assert.equal(event.bn, 8);
assert(!('bn' in evProjectileUpdate('r1', o, v)));
const rawBytes = JSON.stringify({t:'ev',kind:'projectileUpdate',pid:'r123',o,v,bn:8}).length;
const wireBytes = JSON.stringify(event).length;
assert(wireBytes < rawBytes * 0.75);
console.log(JSON.stringify({collisionMedianMs192x24: collision, homingVoxelReads: homing,
  updateBytes: { before: rawBytes, after: wireBytes }, matchingContacts: contacts}));
