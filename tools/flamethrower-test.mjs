import assert from 'node:assert/strict';
import { fireOneShot } from '../server/sim/combat.js';
import { updateBurn } from '../server/sim/fire.js';
import { PlayerEntity } from '../server/sim/player.js';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';

const spawn = { x: 0.5, y: 1, z: 8.5, index: 0 };
function setup() {
  const owner = new PlayerEntity('owner', 'Owner', spawn, false);
  const victim = new PlayerEntity('victim', 'Victim', { ...spawn, z: 5.5 }, false);
  owner.weapon = WEAPON_IDS.indexOf('flamethrower');
  owner.yaw = 0; owner.pitch = 0;
  const events = [], kills = [];
  const ctx = { now: 0, entities: new Map([[owner.id, owner], [victim.id, victim]]),
    canDamage: () => true, solidAt: () => false, pushEvent: e => events.push(e),
    computeConeDeg: () => 0,
    killPlayer: (v, killer, weapon) => { v.state = 'dead'; kills.push({ killer, weapon }); } };
  return { owner, victim, ctx, events, kills };
}
{
  const { owner, victim, ctx } = setup();
  fireOneShot(owner, ctx);
  const direct = 100 - victim.hp;
  assert.ok(direct >= 8 && direct <= 9, 'direct flame damage');
  assert.equal(victim.burning, 4);
  assert.ok(victim.panic >= 0.95);
  for (let i = 0; i < 201; i++) updateBurn(victim, 0.02, ctx);
  assert.ok(Math.abs(victim.hp - (100 - direct - 28)) < 1e-8, '4 seconds of 7 DPS');
  assert.equal(victim.burning, 0); assert.equal(victim.burn, null);
  const hp = victim.hp; updateBurn(victim, 2, ctx); assert.equal(victim.hp, hp);
}
{
  const { owner, victim, ctx } = setup();
  fireOneShot(owner, ctx); updateBurn(victim, 0.25, ctx);
  fireOneShot(owner, ctx);
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
  if (blocked === 'range') victim.z = -5;
  if (blocked === 'behind') victim.z = 12;
  fireOneShot(owner, ctx);
  assert.equal(victim.hp, 100, blocked); assert.equal(victim.burn, null);
}
{
  const { owner, victim, ctx, kills } = setup();
  fireOneShot(owner, ctx); victim.hp = 3; owner.state = 'dead';
  updateBurn(victim, 0.5, ctx);
  assert.equal(kills.length, 1); assert.equal(kills[0].killer, owner);
  assert.equal(kills[0].weapon, 'flamethrower');
  updateBurn(victim, 1, ctx); assert.equal(kills.length, 1);
}
{
  const { owner, victim, ctx } = setup();
  fireOneShot(owner, ctx); ctx.canDamage = () => false;
  const hp = victim.hp; updateBurn(victim, 1, ctx);
  assert.equal(victim.hp, hp); assert.equal(victim.burning, 0);
}
console.log('Flamethrower: direct damage, burn duration, panic, refresh, respawn, occlusion, teams, reach and kill credit passed.');

// The actual snapshot and interpolation seam preserves burn status and clears it on a new life.
const { makeSnapshot } = await import('../server/protocol/snapshot.js');
const { NetClient } = await import('../public/js/engine/netclient.js');
const { LocalPlayer } = await import('../public/js/player/local-player.js');
{
  const { owner, victim, ctx } = setup(); fireOneShot(owner, ctx);
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
  const { owner, victim, ctx } = setup(); fireOneShot(owner, ctx);
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
  for (let i = 0; i < 25; i++) engine.step(20);
  assert.ok(victim.hp < hp, 'real simulation advances burn damage');
  const row = frames.at(-1).players.find(p => p.id === victim.id);
  assert.ok(row.burning > 3 && row.panic >= 0.95, 'real tick broadcasts burn and panic');
  assert.equal(frames.flatMap(s => s.events).filter(e => e.kind === 'hit').length, 2);
}
console.log('Authoritative game loop applies burning and broadcasts its status and hit events.');
