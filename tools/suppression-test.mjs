import assert from 'node:assert/strict';
import { PlayerEntity } from '../server/sim/player.js';
import { fireOneShot } from '../server/sim/combat.js';
import { ProjectileSystem } from '../server/sim/projectiles.js';
import { collectNearMisses, applyNearMisses, suppressExplosion } from '../server/sim/suppression.js';
import { SUPPRESSION_RULES, applySuppression } from '../shared/suppression-rules.js';
import { recoverConditions } from '../shared/conditions.js';
import { WEAPON_IDS } from '../shared/combatmath.js';

function fixture() {
  const owner = new PlayerEntity('a', 'a', { x: 20.5, y: 10, z: 40.5 }, false);
  const target = new PlayerEntity('b', 'b', { x: 21.3, y: 10, z: 30.5 }, false);
  owner.yaw = 0; owner.pitch = 0; owner.weapon = WEAPON_IDS.indexOf('rifle');
  owner.spawnProtectedUntil = target.spawnProtectedUntil = 0;
  const ctx = { now: 1000, entities: new Map([['a', owner], ['b', target]]),
    solidAt: () => false, getBlock: () => 0, blockHp: new Map(),
    canDamage: () => true, computeConeDeg: () => 0, pushEvent: () => {},
    canAffectWorld: () => true, killPlayer: v => { v.state = 'dead'; },
    setBlock: () => {}, pushBlockDelta: () => {}, destroyBlock: () => false };
  return { owner, target, ctx };
}
{
  const { owner, target, ctx } = fixture();
  fireOneShot(owner, ctx);
  assert.equal(target.hp, 100);
  assert.ok(target.panic > 0, 'an actual missed rifle shot generates panic');
  assert.equal(target.pain, 0, 'near misses do not injure');
  const initial = target.panic;
  for (let i = 0; i < 12; i++) fireOneShot(owner, ctx);
  assert.equal(target.panic, initial, 'pellets and same-tick shots cannot stack panic');
}
{
  const { owner, target, ctx } = fixture();
  ctx.solidAt = (x, y, z) => z === 35;
  ctx.getBlock = (x, y, z) => z === 35 ? 29 : 0;
  fireOneShot(owner, ctx);
  assert.equal(target.panic, 0, 'the actual resolved wall endpoint excludes targets behind cover');
}
{
  const { owner, target, ctx } = fixture();
  // A bullet passes on one side of a thin wall, the target stands beside it.
  target.x = 21.7;
  ctx.solidAt = x => x === 21;
  const candidates = collectNearMisses(owner, [20.5, 11.05, 40], [20.5, 11.05, 20], ctx);
  applyNearMisses(candidates, null, ctx);
  assert.equal(target.panic, 0, 'lateral cover blocks nearby shots');
}
for (const excluded of ['team', 'protected', 'dead']) {
  const { owner, target, ctx } = fixture();
  if (excluded === 'team') ctx.canDamage = () => false;
  if (excluded === 'protected') target.spawnProtectedUntil = 2000;
  if (excluded === 'dead') target.state = 'dead';
  fireOneShot(owner, ctx);
  assert.equal(target.panic, 0, `${excluded} targets ignore suppression`);
  assert.equal(owner.panic, 0, 'self never generates suppression');
}
{
  const { owner, target, ctx } = fixture();
  target.x = owner.x;
  fireOneShot(owner, ctx);
  const reference = fixture().target;
  reference.takeDamage(100 - target.hp, true);
  assert.equal(target.panic, reference.panic, 'a direct hit receives damage panic without near-miss stacking');
}
{
  const { target } = fixture();
  let gained = 0;
  for (let now = 0; now <= 30000; now += 50) {
    recoverConditions(target, 0.05, { hp: target.hp });
    gained += applySuppression(target, 1, now);
    assert.ok(target.panic <= SUPPRESSION_RULES.panicCap);
  }
  assert.ok(gained <= SUPPRESSION_RULES.budget + 30 * SUPPRESSION_RULES.refillPerSecond + 1e-9);
  assert.ok(target.panic < 0.04, 'sustained automatic misses habituate below a meaningful penalty');
}
{
  const { owner, target, ctx } = fixture();
  target.z = 28;
  const system = new ProjectileSystem();
  system.chaosBlast(owner, [20.5, 11.05, 20], 'frag', 6, 30, 0, ctx);
  assert.equal(target.hp, 100);
  assert.ok(target.panic > 0, 'explosion outside damage radius still generates nearby danger');
  target.panic = 0; ctx.now += 1000;
  ctx.solidAt = (x, y, z) => z === 24;
  suppressExplosion(owner, [20.5, 11.05, 20], 6, null, ctx);
  assert.equal(target.panic, 0, 'blast suppression respects solid cover');
}
{
  const { owner, target, ctx } = fixture();
  target.z = -200;
  fireOneShot(owner, ctx);
  assert.ok(target.panic > 0, 'suppression follows unlimited damage reach beyond tracer presentation');
}
{
  const { owner, target, ctx } = fixture();
  const system = new ProjectileSystem();
  owner.weapon = WEAPON_IDS.indexOf('longarc');
  const bolt = system.launchBolt(owner, ctx, { x: 0, y: 0, z: -1 });
  for (let i = 0; i < 15; i++) {
    ctx.now += 20;
    system._flyBolt(bolt, 0.02, ctx);
  }
  assert.equal(target.hp, 100);
  assert.ok(target.panic > 0, 'a resolved travelling bolt near miss generates panic');
  target.applySpawn({ x: 21.3, y: 10, z: 30.5 });
  assert.equal(target.suppressionGainAt, null);
  assert.equal(target.suppressionBudget, SUPPRESSION_RULES.budget, 'a fresh life resets habituation');
}
for (const stance of ['crouch', 'prone']) {
  const { owner, target, ctx } = fixture();
  target.x = 22.2; target.y = 0; target.z = 30;
  target.crouch = stance === 'crouch';
  target.proneT = stance === 'prone' ? 1 : 0;
  const from = [20.95, 1.05, 40], end = [20.95, 1.05, 20];
  applyNearMisses(collectNearMisses(owner, from, end, ctx), null, ctx);
  assert.ok(target.panic > 0, `${stance} near misses remain detectable without cover`);
  target.panic = 0; ctx.now += 1000;
  ctx.solidAt = (x, y) => x === 21 && y === 0;
  applyNearMisses(collectNearMisses(owner, from, end, ctx), null, ctx);
  assert.equal(target.panic, 0, `${stance} near miss cannot see a phantom standing point above low cover`);
  suppressExplosion(owner, [20.95, 1.05, 30], 4, null, ctx);
  assert.equal(target.panic, 0, `${stance} blast cannot see a phantom standing point above low cover`);
  ctx.solidAt = () => false;
  suppressExplosion(owner, [20.95, 1.05, 30], 4, null, ctx);
  assert.ok(target.panic > 0, `${stance} blast is detected once low cover is absent`);
}
{
  const { owner, target, ctx } = fixture();
  Object.assign(target, { x: 22.35, y: 0, z: 30, proneT: 1 });
  ctx.solidAt = (x, y) => x === 21 && y === 0;
  applyNearMisses(collectNearMisses(owner, [20.95, 1.05, 40], [20.95, 1.05, 20], ctx), null, ctx);
  assert.equal(target.panic, 0, 'prone low-cover review reproduction stays protected');
}
console.log('Suppression: real shots, resolved endpoints, lateral cover, exclusions, direct-hit deduplication, habituation and nearby blasts passed.');
