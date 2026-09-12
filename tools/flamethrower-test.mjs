import { combatDamage } from '../shared/combat-balance.js';
import assert from 'node:assert/strict';
import { fireOneShot } from '../server/sim/combat.js';
import { FlameSystem, updateBurn } from '../server/sim/fire.js';
import { PlayerEntity } from '../server/sim/player.js';
import { WEAPONS, WEAPON_IDS, damageAtDistance } from '../shared/combatmath.js';
import { FLAME_RULES, FLAME_BURN, flamePanicFloor } from '../shared/flame-rules.js';
import { recoverConditions } from '../shared/conditions.js';
import { AimSway } from '../public/js/player/aim-sway.js';

const FLAME_FLIGHT_SECONDS = FLAME_RULES.range / FLAME_RULES.speed;
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
  fireOneShot(owner, ctx); ctx.flames.step(FLAME_FLIGHT_SECONDS, ctx);
  const direct = 100 - victim.hp;
  assert.ok(Math.abs(direct - 4.8) < 1e-8, 'close contact deals 4.8 immediate damage');
  assert.equal(victim.burning, 0.75, 'one graze produces a short afterburn');
  assert.equal(victim.panic, flamePanicFloor(0.75));
  assert.equal(victim.panic, 1, 'one graze immediately forces full panic');
  for (let i = 0; i < 51; i++) updateBurn(victim, 0.02, ctx);
  assert.ok(Math.abs(victim.hp - (100 - direct - combatDamage(6))) < 1e-8, 'one graze adds 4.8 afterburn damage at 6.4 DPS');
  assert.equal(victim.burning, 0); assert.equal(victim.burn, null);
  const hp = victim.hp; updateBurn(victim, 2, ctx); assert.equal(victim.hp, hp);
}
{
  const { owner, victim, ctx } = setup();
  fireOneShot(owner, ctx); ctx.flames.step(FLAME_FLIGHT_SECONDS, ctx); updateBurn(victim, 0.25, ctx);
  fireOneShot(owner, ctx); ctx.flames.step(FLAME_FLIGHT_SECONDS, ctx);
  const hp = victim.hp;
  updateBurn(victim, 0.25, ctx);
  assert.ok(Math.abs(hp - victim.hp - combatDamage(4)) < 1e-8, 'new contact never stacks or discards pending burn damage');
  assert.equal(victim.burning, 0.5, 'a spaced graze renews only the short burn');
  victim.applySpawn(spawn); updateBurn(victim, 1, ctx);
  assert.equal(victim.hp, 100); assert.equal(victim.burning, 0);
}
{
  const { owner, victim, ctx } = setup();
  victim.hp = 1000;
  fireOneShot(owner, ctx); ctx.flames.step(FLAME_FLIGHT_SECONDS, ctx);
  for (let i = 0; i < 6; i++) {
    updateBurn(victim, FLAME_RULES.cadence, ctx);
    fireOneShot(owner, ctx); ctx.flames.step(FLAME_FLIGHT_SECONDS, ctx);
  }
  assert.ok(victim.burning > 1.3 && victim.burning < 1.5, 'short tracking builds a medium afterburn');
  for (let i = 0; i < 24; i++) {
    updateBurn(victim, FLAME_RULES.cadence, ctx);
    fireOneShot(owner, ctx); ctx.flames.step(FLAME_FLIGHT_SECONDS, ctx);
  }
  assert.equal(victim.burning, 3, 'sustained tracking caps one afterburn at three seconds');
  assert.ok(victim.panic >= FLAME_BURN.panicFloor);
  const pendingDamage = combatDamage(victim.burn.elapsed * FLAME_BURN.damagePerS);
  const hp = victim.hp;
  updateBurn(victim, 4, ctx);
  assert.ok(Math.abs(hp - victim.hp - pendingDamage - combatDamage(24)) < 1e-8, 'fully built afterburn remains 6.4 DPS on a long tick');
  assert.equal(victim.burn, null);
}
{
  const directDps = distance => {
    const { owner, victim, ctx } = setup();
    victim.z = owner.z - distance;
    victim.hp = 1000;
    for (let i = 0; i < 20; i++) { fireOneShot(owner, ctx); ctx.flames.step(FLAME_FLIGHT_SECONDS, ctx); }
    return 1000 - victim.hp;
  };
  const nearDps = directDps(3), farDps = directDps(27);
  assert.ok(Math.abs(nearDps - 96) < 1e-8, 'twenty close-range packets deliver 96 direct DPS');
  assert.ok(farDps >= 32 && farDps < 48, 'distant flame contact loses most of its direct damage');
  assert.ok(nearDps > farDps * 2, 'close tracking has a clear damage advantage');
  assert.equal(damageAtDistance(WEAPONS.flamethrower, 5) / FLAME_RULES.cadence, 120);
  assert.equal(damageAtDistance(WEAPONS.flamethrower, 28) / FLAME_RULES.cadence, 40);
  assert.equal(flamePanicFloor(0), 0);
  assert.equal(flamePanicFloor(FLAME_BURN.duration), FLAME_BURN.panicFloor);
}
for (const blocked of ['wall', 'friendly', 'range', 'behind']) {
  const { owner, victim, ctx } = setup();
  if (blocked === 'wall') ctx.solidAt = (_x, _y, z) => z === 6;
  if (blocked === 'friendly') ctx.canDamage = () => false;
  if (blocked === 'range') victim.z = owner.z - (FLAME_RULES.range + 3);
  if (blocked === 'behind') victim.z = 12;
  fireOneShot(owner, ctx); ctx.flames.step(FLAME_FLIGHT_SECONDS, ctx);
  assert.equal(victim.hp, 100, blocked); assert.equal(victim.burn, null);
}
{
  const { owner, victim, ctx, kills } = setup();
  fireOneShot(owner, ctx); ctx.flames.step(FLAME_FLIGHT_SECONDS, ctx); victim.hp = 3; owner.state = 'dead';
  updateBurn(victim, 0.5, ctx);
  assert.equal(kills.length, 1); assert.equal(kills[0].killer, owner);
  assert.equal(kills[0].weapon, 'flamethrower');
  updateBurn(victim, 1, ctx); assert.equal(kills.length, 1);
}
{
  const { owner, victim, ctx } = setup();
  fireOneShot(owner, ctx); ctx.flames.step(FLAME_FLIGHT_SECONDS, ctx); ctx.canDamage = () => false;
  const hp = victim.hp; updateBurn(victim, 1, ctx);
  assert.equal(victim.hp, hp); assert.equal(victim.burning, 0);
}
{
  const { owner, victim, ctx, kills } = setup();
  fireOneShot(owner, ctx); ctx.flames.step(FLAME_FLIGHT_SECONDS, ctx); updateBurn(victim, 0.25, ctx);
  const nextOwner = new PlayerEntity('next-owner', 'Next Owner', spawn, false);
  ctx.entities.delete(owner.id); ctx.entities.set(nextOwner.id, nextOwner);
  ctx.flames.launch(nextOwner, [nextOwner.x, nextOwner.eyeY, nextOwner.z], { x: 0, y: 0, z: -1 }, ctx);
  ctx.flames.step(FLAME_FLIGHT_SECONDS, ctx);
  assert.equal(victim.burn.owner, nextOwner, 'most recent contact owns the single afterburn');
  assert.equal(victim.burn.elapsed, 0.25, 'owner handoff preserves pending burn time');
  victim.hp = 3;
  updateBurn(victim, 0.25, ctx);
  assert.equal(kills.length, 1);
  assert.equal(kills[0].killer, nextOwner, 'burn kill credit follows the most recent contact');
  assert.equal(victim.burn, null);
}
{
  const { owner, victim, ctx } = setup();
  const behind = new PlayerEntity('behind', 'Behind', { ...spawn, z: 2.5 }, false);
  ctx.entities.set(behind.id, behind);
  fireOneShot(owner, ctx); ctx.flames.step(FLAME_FLIGHT_SECONDS, ctx);
  assert.equal(victim.hp, 95.2, 'front body receives the packet');
  assert.equal(behind.hp, 100, 'one packet cannot pass through a body into a second victim');
  assert.equal(behind.burn, null);
}
console.log('Flamethrower: close-range DPS, graze and sustained burn buildup, full-panic suppression, non-stacking refresh, respawn, occlusion, teams, reach and owner credit passed.');

// The actual snapshot and interpolation seam preserves burn status and clears it on a new life.
const { makeSnapshot } = await import('../server/protocol/snapshot.js');
const { NetClient } = await import('../public/js/engine/netclient.js');
const { LocalPlayer } = await import('../public/js/player/local-player.js');
{
  const { owner, victim, ctx } = setup(); fireOneShot(owner, ctx); ctx.flames.step(FLAME_FLIGHT_SECONDS, ctx);
  const row = makeSnapshot([victim], [], [], 100).players[0];
  assert.equal(row.burning, 0.75); assert.equal(row.panic, 1);
  const net = new NetClient();
  net.latestSnapshots.push({ now: 100, players: [row], events: [], blocks: [] });
  const interpolated = net.interpolate(100, 0).players.get(victim.id);
  assert.equal(interpolated.burning, 0.75);
  const local = new LocalPlayer({ input: { consumeDelta: () => ({x:0,y:0}), getKeys: () => ({}), setGameplayEnabled() {}, consumeBuyMenuRequest() {} } });
  local.respawn(row); local.reconcile(row, 1);
  assert.equal(local.burning, 0.75);
  local._updateConditionEstimates(0.1, false);
  assert.equal(local.panic, 1);
  assert.equal(local.burning, 0.65);
  local.die(owner.id); assert.equal(local.burning, 0);
  local.respawn(row); assert.equal(local.burning, 0);
  local.burning = 2; local.resetForMenu(); assert.equal(local.burning, 0);
}
console.log('Flamethrower snapshots, interpolation, client panic, death, respawn and menu reset passed.');

{
  const { owner, victim, ctx } = setup(); fireOneShot(owner, ctx); ctx.flames.step(FLAME_FLIGHT_SECONDS, ctx);
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
  fireOneShot(owner, engine.contexts.combat);
  const hp = victim.hp;
  for (let i = 0; i < 35; i++) engine.step(20);
  assert.ok(victim.hp < hp, 'real simulation advances burn damage');
  const row = frames.at(-1).players.find(p => p.id === victim.id);
  assert.ok(row.burning > 0 && row.burning < 0.75 && row.panic === 1,
    'real tick broadcasts the decaying short burn and full panic');
  assert.equal(frames.flatMap(s => s.events).filter(e => e.kind === 'hit').length, 2);
}
console.log('Authoritative game loop applies burning and broadcasts its status and hit events.');

// Packets need flight time, retain their original aim, and do not tunnel on slow ticks.
{
  const { owner, victim, ctx, events } = setup();
  victim.z = owner.z - 26; // Far end of the extended flame stream.
  fireOneShot(owner, ctx);
  assert.equal(victim.hp, 100, 'launch causes no hitscan damage');
  assert.equal(ctx.flames.active.length, 1);
  ctx.flames.step(0.25, ctx);
  assert.equal(victim.hp, 100, 'target remains unharmed before packet arrival');
  owner.yaw = Math.PI; owner.state = 'dead';
  ctx.flames.step(0.65, ctx);
  assert.ok(victim.hp < 100, 'original packet travels twenty-six metres after owner turns and dies');
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
  ctx.flames.step(FLAME_FLIGHT_SECONDS, ctx);
  assert.equal(victim.hp, 100, 'corpses receive no fire damage');
  assert.equal(ctx.flames.active.length, 0, 'packet expires at maximum range');
}
{
  const { owner, victim, ctx } = setup();
  ctx.canDamage = (_attacker, target) => target.spawnProtectedUntil <= ctx.now;
  victim.spawnProtectedUntil = 1000;
  fireOneShot(owner, ctx); ctx.flames.step(FLAME_FLIGHT_SECONDS, ctx);
  assert.equal(victim.hp, 100, 'spawn protection is checked at contact');
}
{
  const { owner, victim, ctx } = setup();
  fireOneShot(owner, ctx); ctx.canBurn = () => false;
  ctx.flames.step(FLAME_FLIGHT_SECONDS, ctx);
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
  for (let i = 0; i < 120; i++) {
    owner.cooldown -= 0.01; resolveWeaponIntent(owner, 0.01, ctx); ctx.flames.step(0.01, ctx);
  }
  assert.equal(events.filter(e => e.kind === 'shoot').length, 20, 'releasing trigger stops new packets');
  assert.equal(ctx.flames.active.length, 0, 'remaining stream expires after release');
}
console.log('Flame stream: flight time, thirty-two-metre reach, preserved aim, swept walls, corpses, protection, phase reset, packet cap and held-trigger cadence passed.');

// Support reach and lateral coverage are real hits, with wall/team controls.
for (const [distance, offset, expected] of [[31, 0, true], [36, 0, false], [20, 1.15, true], [20, 1.7, false]]) {
  const { owner, victim, ctx } = setup();
  victim.z = owner.z - distance; victim.x += offset;
  fireOneShot(owner, ctx); ctx.flames.step(FLAME_FLIGHT_SECONDS, ctx);
  assert.equal(victim.burning > 0, expected, `coverage at ${distance}m and ${offset}m sideways`);
  assert.equal(victim.panic, expected ? 1 : 0, 'only contact can trigger fire panic');
}
for (const blocked of ['wall', 'friendly']) {
  const { owner, victim, ctx } = setup();
  victim.z = owner.z - 20; victim.x += 1.15;
  if (blocked === 'wall') ctx.solidAt = (_x, _y, z) => z === 0;
  else ctx.canDamage = () => false;
  fireOneShot(owner, ctx); ctx.flames.step(FLAME_FLIGHT_SECONDS, ctx);
  assert.equal(victim.burning, 0, `${blocked} prevents wider-jet ignition`);
  assert.equal(victim.panic, 0, `${blocked} prevents wider-jet suppression`);
}
{
  const { owner, victim, ctx } = setup();
  fireOneShot(owner, ctx); ctx.flames.step(FLAME_FLIGHT_SECONDS, ctx);
  // Even the fastest voluntary recovery cannot bypass burning suppression.
  recoverConditions(victim, 0.7, { burning: victim.burning, holdingBreath: true, crouching: true });
  assert.equal(victim.panic, 1);
  updateBurn(victim, 0.75, ctx);
  recoverConditions(victim, 1, { burning: victim.burning });
  assert.ok(victim.panic < 1 && victim.panic > 0.9, 'normal recovery resumes after extinguishing');
}
for (const fps of [30, 60, 144]) {
  const sample = options => {
    const sway = new AimSway();
    for (let i = 0; i < fps * 2; i++) sway.update(1 / fps, options);
    return Math.hypot(sway.readModel.yaw, sway.readModel.pitch);
  };
  const calm = sample({ stationary: true });
  const panicked = sample({ stationary: true, panic: 1 });
  const moving = sample({ stationary: false, panic: 1 });
  const steady = sample({ stationary: true, panic: 1, crouching: true, ads: 1, shift: true });
  assert.ok(panicked > calm * 2.6, 'full panic materially disrupts aim');
  assert.ok(moving > calm, 'moving cannot cancel panic sway');
  assert.equal(sample({ stationary: false }), 0, 'calm movement retains its aim behavior');
  assert.ok(steady < panicked * 0.1, 'crouch and finite breath hold still help');
}
console.log('Support flame: extended/lateral hits, cover/team controls, full panic until extinguished, moving sway and deliberate recovery passed.');
