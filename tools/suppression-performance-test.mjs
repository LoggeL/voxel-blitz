import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { collectNearMisses, suppressExplosion } from '../server/sim/suppression.js';
import { stanceEye } from '../shared/player-stance.js';
import { leanEyeOffset } from '../shared/player-lean.js';
import { PHYSICS } from '../shared/player-movement.js';
import { SUPPRESSION_RULES, applySuppression } from '../shared/suppression-rules.js';
import { raycastVoxels } from '../shared/raycast.js';

// Frozen vector-based query verifies both the closest-pellet result and the
// stance/lean visibility geometry while the production query reuses scratch.
function targetFor(victim) {
  const lean = leanEyeOffset(victim.leanT || 0, victim.yaw || 0, victim.crouch ? 1 : 0);
  return [victim.x + lean.x,
    victim.y + stanceEye(PHYSICS.eye, victim.crouch, victim.proneT) + lean.y,
    victim.z + lean.z];
}
function eligible(owner, victim, ctx) {
  return owner && victim !== owner && victim.id !== owner.id && victim.state === 'alive'
    && !(victim.spawnProtectedUntil > ctx.now) && ctx.canDamage(owner, victim);
}
function visible(origin, target, ctx) {
  const d = target.map((v, i) => v - origin[i]);
  const distance = Math.hypot(...d);
  return distance < 0.001 || !raycastVoxels(ctx.solidAt || ((x, y, z) => ctx.getBlock(x, y, z)),
    ...origin, ...d, distance);
}
function referenceMisses(owner, origin, end, ctx, candidates = new Map()) {
  const d = end.map((v, i) => v - origin[i]);
  const len2 = d.reduce((sum, v) => sum + v * v, 0);
  if (len2 < 1e-10) return candidates;
  for (const victim of ctx.entities.values()) {
    if (!eligible(owner, victim, ctx)) continue;
    const target = targetFor(victim);
    const t = Math.max(0, Math.min(1,
      target.reduce((sum, v, i) => sum + (v - origin[i]) * d[i], 0) / len2));
    const point = origin.map((v, i) => v + d[i] * t);
    const distance = Math.hypot(...target.map((v, i) => v - point[i]));
    if (distance >= SUPPRESSION_RULES.nearMissRadius || !visible(point, target, ctx)) continue;
    const gain = SUPPRESSION_RULES.nearMissGain * (1 - distance / SUPPRESSION_RULES.nearMissRadius);
    candidates.set(victim, Math.max(candidates.get(victim) || 0, gain));
  }
  return candidates;
}
function referenceBlast(owner, origin, radius, hits, ctx) {
  const reach = radius * SUPPRESSION_RULES.blastRadiusMult;
  if (!(reach > 0)) return;
  for (const victim of ctx.entities.values()) {
    if (!eligible(owner, victim, ctx) || hits?.has(victim)) continue;
    const target = targetFor(victim);
    const distance = Math.hypot(...target.map((v, i) => v - origin[i]));
    if (distance >= reach || !visible(origin, target, ctx)) continue;
    applySuppression(victim, SUPPRESSION_RULES.blastGain * (1 - distance / reach), ctx.now);
  }
}

let seed = 20261001;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const owner = { id: 'owner', state: 'alive', x: 10, y: 1, z: 10 };
const players = Array.from({ length: 48 }, (_, i) => ({
  id: String(i), state: i % 13 ? 'alive' : 'dead', x: 8 + random() * 5,
  y: 1 + random() * 2, z: 10 + random() * 40, yaw: random() * Math.PI * 2,
  crouch: i % 3 === 0, proneT: i % 4 === 0 ? random() : 0,
  leanT: i % 5 === 0 ? random() * 2 - 1 : 0,
  spawnProtectedUntil: i % 11 === 0 ? 2000 : 0, panic: 0,
}));
const entities = new Map([[owner.id, owner], ...players.map(p => [p.id, p])]);
const ctx = { now: 1000, entities, canDamage: (_a, v) => Number(v.id) % 7 !== 0 };
const segments = Array.from({ length: 160 }, (_, i) => {
  const origin = [8 + random() * 5, 1 + random() * 3, 10 + random() * 40];
  return [origin, i % 17 === 0 ? [...origin]
    : [8 + random() * 5, 1 + random() * 3, 10 + random() * 40]];
});
let contacts = 0;
for (const covered of [false, true]) {
  const solidAt = (x, y, z) => covered && x === 10 && y < 3 && z % 4 !== 0;
  for (const fallback of [false, true]) {
    ctx.solidAt = fallback ? undefined : solidAt;
    ctx.getBlock = solidAt;
    let expected = new Map(), actual = new Map();
    for (const [origin, end] of segments) {
      // Retain the map for a multi-pellet query and start a fresh shot regularly.
      if (random() < 0.2) { expected = new Map(); actual = new Map(); }
      referenceMisses(owner, origin, end, ctx, expected);
      assert.equal(collectNearMisses(owner, origin, end, ctx, actual), actual);
      assert.deepEqual(actual, expected);
      contacts += actual.size;
    }
    for (const radius of [0, 1.5, 4, 8]) {
      const before = structuredClone(players), after = structuredClone(players);
      const blastContext = rows => ({ ...ctx,
        entities: new Map([[owner.id, owner], ...rows.map(p => [p.id, p])]) });
      const hitsBefore = new Set([before[1]]), hitsAfter = new Set([after[1]]);
      referenceBlast(owner, [10.5, 2.2, 25], radius, hitsBefore, blastContext(before));
      suppressExplosion(owner, [10.5, 2.2, 25], radius, hitsAfter, blastContext(after));
      assert.deepEqual(after, before);
    }
  }
}
assert(contacts > 200, 'equivalence fixture must exercise real nearby misses');

// Once a stronger visible pellet is recorded, redundant lateral rays cannot
// improve the query. New cover and stronger subsequent pellets still matter.
{
  const victim = { id: 'v', state: 'alive', x: 10.7, y: 1, z: 20 };
  let reads = 0, wall = false;
  const local = { now: 1000, entities: new Map([['v', victim]]), canDamage: () => true,
    solidAt: () => { reads++; return wall; } };
  const candidates = collectNearMisses(owner, [10.5, 2.62, 10], [10.5, 2.62, 30], local);
  assert.equal(candidates.size, 1);
  reads = 0; wall = true;
  collectNearMisses(owner, [10.3, 2.62, 10], [10.3, 2.62, 30], local, candidates);
  assert.equal(reads, 0, 'a weaker pellet avoids the redundant visibility ray');
  const gain = candidates.get(victim);
  collectNearMisses(owner, [10.65, 2.62, 10], [10.65, 2.62, 30], local, candidates);
  assert.equal(candidates.get(victim), gain, 'stronger pellet behind newly added cover stays excluded');
  assert(reads > 0, 'a potentially stronger pellet still checks current cover');
  wall = false;
  collectNearMisses(owner, [10.65, 2.62, 10], [10.65, 2.62, 30], local, candidates);
  assert(candidates.get(victim) > gain, 'removing cover admits a stronger pellet');
}

ctx.solidAt = () => false;
function median(fn) {
  fn();
  const samples = [];
  for (let i = 0; i < 9; i++) {
    const start = performance.now(); fn(); samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[4];
}
const timing = {};
for (const [name, query] of [['before', referenceMisses], ['after', collectNearMisses]]) {
  timing[name] = median(() => {
    for (let shot = 0; shot < 40; shot++) {
      const candidates = new Map();
      for (let pellet = 0; pellet < 12; pellet++) {
        const [origin, end] = segments[(shot * 12 + pellet) % segments.length];
        query(owner, origin, end, ctx, candidates);
      }
    }
  });
}
console.log(JSON.stringify({ suppressionQuery: { players: players.length, segments: 480,
  medianMs: timing, speedup: timing.before / timing.after, equivalentContacts: contacts } }));
console.log('Suppression query: stance/lean, cover, closest-pellet, blast equivalence and redundant ray checks passed.');
