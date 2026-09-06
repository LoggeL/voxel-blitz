import assert from 'node:assert/strict';
import { fireOneShot } from '../server/sim/combat.js';
import { FlameSystem, updateBurn } from '../server/sim/fire.js';
import { PlayerEntity } from '../server/sim/player.js';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';

const spawn = { x: 0.5, y: 1, z: 8.5, index: 0 };
function setup() {
  const owner = new PlayerEntity('owner', 'Owner', spawn, false);
  const victim = new PlayerEntity('victim', 'Victim', { ...spawn, z: 5.5 }, false);
  owner.weapon = WEAPON_IDS.indexOf('flamethrower');
  owner.yaw = 0; owner.pitch = 0;
  const events = [], kills = [];
  const ctx = { flames: new FlameSystem(), now: 0, entities: new Map([[owner.id, owner], [victim.id, victim]]),
    canDamage: () => true, solidAt: () => false, pushEvent: e => events.push(e),
    computeConeDeg: () => 0,
    killPlayer: (v, killer, weapon) => { v.state = 'dead'; kills.push({ killer, weapon }); } };
  return { owner, victim, ctx, events, kills };
}
{
  const { owner, victim, ctx } = setup();
  fireOneShot(owner, ctx); ctx.flames.step(0.6, ctx);
  const direct = 100 - victim.hp;
  assert.ok(direct >= 2 && direct <= 2.25, 'direct flame damage');
  assert.equal(victim.burning, 4);
  assert.ok(victim.panic >= 0.95);
  for (let i = 0; i < 201; i++) updateBurn(victim, 0.02, ctx);
  assert.ok(Math.abs(victim.hp - (100 - direct - 28)) < 1e-8, '4 seconds of 7 DPS');
  assert.equal(victim.burning, 0); assert.equal(victim.burn, null);
  const hp = victim.hp; updateBurn(victim, 2, ctx); assert.equal(victim.hp, hp);
}
{
  const { owner, victim, ctx } = setup();
  fireOneShot(owner, ctx); ctx.flames.step(0.6, ctx); updateBurn(victim, 0.25, ctx);
  fireOneShot(owner, ctx); ctx.flames.step(0.6, ctx);
  const hp = victim.hp;
  updateBurn(victim, 0.25, ctx);
  assert.ok(Math.abs(hp - victim.hp - 3.5) < 1e-8, 'refresh never stacks or discards pending damage');
  assert.equal(victim.burning, 3.75);
  victim.applySpawn(spawn); updateBurn(victim, 1, ctx);
  assert.equal(victim.hp, 100); assert.equal(victim.burning, 0);
}
for (const blocked of ['wall', 'friendly', 'range', 'behind']) {
  const { owner, victim, ctx } = setup();
  if (blocked === 'wall') ctx.solidAt = (_x, _y, z) => z === 6;
  if (blocked === 'friendly') ctx.canDamage = () => false;
  if (blocked === 'range') victim.z = -12;
  if (blocked === 'behind') victim.z = 12;
  fireOneShot(owner, ctx); ctx.flames.step(0.6, ctx);
  assert.equal(victim.hp, 100, blocked); assert.equal(victim.burn, null);
}
{
  const { owner, victim, ctx, kills } = setup();
  fireOneShot(owner, ctx); ctx.flames.step(0.6, ctx); victim.hp = 3; owner.state = 'dead';
  updateBurn(victim, 0.5, ctx);
  assert.equal(kills.length, 1); assert.equal(kills[0].killer, owner);
  assert.equal(kills[0].weapon, 'flamethrower');
  updateBurn(victim, 1, ctx); assert.equal(kills.length, 1);
}
{
  const { owner, victim, ctx } = setup();
  fireOneShot(owner, ctx); ctx.flames.step(0.6, ctx); ctx.canDamage = () => false;
  const hp = victim.hp; updateBurn(victim, 1, ctx);
  assert.equal(victim.hp, hp); assert.equal(victim.burning, 0);
}
console.log('Flamethrower: direct damage, burn duration, panic, refresh, respawn, occlusion, teams, reach and kill credit passed.');

// The actual snapshot and interpolation seam preserves burn status and clears it on a new life.
const { makeSnapshot } = await import('../server/protocol/snapshot.js');
const { NetClient } = await import('../public/js/engine/netclient.js');
const { LocalPlayer } = await import('../public/js/player/local-player.js');
{
  const { owner, victim, ctx } = setup(); fireOneShot(owner, ctx); ctx.flames.step(0.6, ctx);
  const row = makeSnapshot([victim], [], [], 100).players[0];
  assert.equal(row.burning, 4); assert.ok(row.panic >= 0.95);
  const net = new NetClient();
  net.latestSnapshots.push({ now: 100, players: [row], events: [], blocks: [] });
  const interpolated = net.interpolate(100, 0).players.get(victim.id);
  assert.equal(interpolated.burning, 4);
  const local = new LocalPlayer({ input: { consumeDelta: () => ({x:0,y:0}), getKeys: () => ({}), setGameplayEnabled() {}, consumeBuyMenuRequest() {} } });
  local.respawn(row); local.reconcile(row, 1);
  assert.equal(local.burning, 4);
  local._updateConditionEstimates(0.1, false);
  assert.ok(local.panic >= 0.95); assert.equal(local.burning, 3.9);
  local.die(owner.id); assert.equal(local.burning, 0);
  local.respawn(row); assert.equal(local.burning, 0);
  local.burning = 2; local.resetForMenu(); assert.equal(local.burning, 0);
}
console.log('Flamethrower snapshots, interpolation, client panic, death, respawn and menu reset passed.');

{
  const { owner, victim, ctx } = setup(); fireOneShot(owner, ctx); ctx.flames.step(0.6, ctx);
  ctx.canBurn = () => false;
  const hp = victim.hp; updateBurn(victim, 1, ctx);
  assert.equal(victim.hp, hp); assert.equal(victim.burning, 0);
}
console.log('Round end extinguishes burning without post-round damage.');

const { GameEngine } = await import('../server/game.js');
{
  const frames = [];
  const engine = new GameEngine({ broadcast: snapshot => frames.push(snapshot) });
  engine.addClient('fire-user', 'Fire User'); engine.addClient('fire-target', 'Fire Target');
  const owner = engine.entities.get('fire-user'), victim = engine.entities.get('fire-target');
  Object.assign(owner, { x: 40.5, y: 40, z: 50.5, yaw: 0, pitch: 0,
    weapon: WEAPON_IDS.indexOf('flamethrower'), spawnProtectedUntil: 0 });
  Object.assign(victim, { x: 40.5, y: 40, z: 47.5, spawnProtectedUntil: 0 });
  engine.fireOneShot(owner);
  const hp = victim.hp;
  for (let i = 0; i < 35; i++) engine.step(20);
  assert.ok(victim.hp < hp, 'real simulation advances burn damage');
  const row = frames.at(-1).players.find(p => p.id === victim.id);
  assert.ok(row.burning > 3 && row.panic >= 0.95, 'real tick broadcasts burn and panic');
  assert.equal(frames.flatMap(s => s.events).filter(e => e.kind === 'hit').length, 2);
}
console.log('Authoritative game loop applies burning and broadcasts its status and hit events.');

// Packets need flight time, retain their original aim, and do not tunnel on slow ticks.
{
  const { owner, victim, ctx, events } = setup();
  victim.z = -7.5; // Sixteen metres, beyond the former ten-metre flame reach.
  fireOneShot(owner, ctx);
  assert.equal(victim.hp, 100, 'launch causes no hitscan damage');
  assert.equal(ctx.flames.active.length, 1);
  ctx.flames.step(0.25, ctx);
  assert.equal(victim.hp, 100, 'target remains unharmed before packet arrival');
  owner.yaw = Math.PI; owner.state = 'dead';
  ctx.flames.step(0.3, ctx);
  assert.ok(victim.hp < 100, 'original packet travels beyond ten metres after owner turns and dies');
  assert.equal(ctx.flames.active.length, 0, 'body contact consumes packet');
  assert.equal(events.filter(e => e.kind === 'hit').length, 1);
}
{
  const { owner, victim, ctx } = setup();
  victim.z = -7.5;
  ctx.solidAt = (_x, _y, z) => z === 0;
  fireOneShot(owner, ctx); ctx.flames.step(1, ctx);
  assert.equal(victim.hp, 100, 'long sweep cannot tunnel through one-voxel wall');
  assert.equal(ctx.flames.active.length, 0, 'wall consumes packet');
}
{
  const { owner, victim, ctx } = setup();
  fireOneShot(owner, ctx); victim.state = 'dead';
  ctx.flames.step(0.6, ctx);
  assert.equal(victim.hp, 100, 'corpses receive no fire damage');
  assert.equal(ctx.flames.active.length, 0, 'packet expires at maximum range');
}
{
  const { owner, victim, ctx } = setup();
  ctx.canDamage = (_attacker, target) => target.spawnProtectedUntil <= ctx.now;
  victim.spawnProtectedUntil = 1000;
  fireOneShot(owner, ctx); ctx.flames.step(0.6, ctx);
  assert.equal(victim.hp, 100, 'spawn protection is checked at contact');
}
{
  const { owner, victim, ctx } = setup();
  fireOneShot(owner, ctx); ctx.canBurn = () => false;
  ctx.flames.step(0.6, ctx);
  assert.equal(victim.hp, 100, 'round end cancels packets still in flight');
  assert.equal(ctx.flames.active.length, 0);
  fireOneShot(owner, ctx);
  assert.equal(ctx.flames.active.length, 0, 'non-live phase cannot launch a packet');
}
{
  const { FLAME_RULES } = await import('../shared/flame-rules.js');
  const { owner, ctx } = setup();
  for (let i = 0; i < FLAME_RULES.maxProjectiles + 10; i++) {
    ctx.flames.launch(owner, [owner.x, owner.eyeY, owner.z], { x: 0, y: 1, z: 0 }, ctx);
  }
  assert.equal(ctx.flames.active.length, FLAME_RULES.maxProjectiles, 'room packet count is bounded');
  ctx.flames.clear(); assert.equal(ctx.flames.active.length, 0);
  assert.equal(60 / WEAPONS.flamethrower.rpm, FLAME_RULES.cadence);
  assert.equal(WEAPONS.flamethrower.magSize * FLAME_RULES.cadence, 8, 'one tank supplies eight seconds');
}
{
  const { resolveWeaponIntent } = await import('../server/sim/combat.js');
  const { owner, ctx, events } = setup();
  ctx.canFire = () => true; ctx.canUseWeapon = () => true;
  owner.input = { wantFire: true }; owner.deployT = 0;
  for (let i = 0; i < 100; i++) {
    if (i) owner.cooldown = Math.max(-0.01, owner.cooldown - 0.01);
    resolveWeaponIntent(owner, 0.01, ctx);
    ctx.flames.step(0.01, ctx);
  }
  assert.equal(events.filter(e => e.kind === 'shoot').length, 20, 'held trigger emits twenty packets per second');
  assert.equal(owner.mag[owner.weapon], 140, 'continuous stream consumes one fuel unit per packet');
  owner.input.wantFire = false;
  for (let i = 0; i < 100; i++) {
    owner.cooldown -= 0.01; resolveWeaponIntent(owner, 0.01, ctx); ctx.flames.step(0.01, ctx);
  }
  assert.equal(events.filter(e => e.kind === 'shoot').length, 20, 'releasing trigger stops new packets');
  assert.equal(ctx.flames.active.length, 0, 'remaining stream expires after release');
}
console.log('Flame stream: flight time, eighteen-metre reach, preserved aim, swept walls, corpses, protection, phase reset, packet cap and held-trigger cadence passed.');
