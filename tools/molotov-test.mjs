import assert from 'node:assert/strict';
import { ProjectileSystem } from '../server/sim/projectiles.js';
import { PlayerEntity } from '../server/sim/player.js';
import { GameEngine } from '../server/game.js';
import { makeSnapshot } from '../server/protocol/snapshot.js';
import { GRENADE_TYPES, GRENADE_TYPE_IDS, freshGrenadeLoadout, predictGrenadePath } from '../shared/grenade-rules.js';
import { MOLOTOV_FIRE, molotovFireProfile } from '../shared/molotov-rules.js';

function fixture(blockAt = (_x, y) => y === 0 ? 1 : 0) {
  const system = new ProjectileSystem();
  const owner = new PlayerEntity('owner', 'Owner', { x: 20.5, y: 1, z: 20.5 });
  const victim = new PlayerEntity('victim', 'Victim', { x: 20.5, y: 1, z: 16.5 });
  owner.spawnProtectedUntil = victim.spawnProtectedUntil = 0;
  const events = [], kills = [], terrain = [];
  const ctx = { now: 0, entities: new Map([[owner.id, owner], [victim.id, victim]]),
    canThrow: () => true, canDamage: () => true, canAffectWorld: () => true,
    getBlock: blockAt, solidAt: (x, y, z) => !!blockAt(x, y, z),
    pushEvent: e => events.push(e), destroyBlock: (...args) => terrain.push(args),
    killPlayer: (v, killer, weapon) => { v.state = 'dead'; kills.push({ v, killer, weapon }); },
  };
  const ignite = (overrides = {}) => system.fire.ignite({ id: `test-${system._nextId++}`,
    ownerId: owner.id, owner, x: victim.x, y: 1.16, z: victim.z, ...overrides }, ctx);
  const step = dt => { ctx.now += dt * 1000; system.step(dt, ctx); };
  return { system, owner, victim, events, kills, terrain, ctx, ignite, step };
}

assert.deepEqual(GRENADE_TYPE_IDS, ['frag', 'limpet', 'pulse', 'molotov', 'smoke']);
assert.deepEqual(freshGrenadeLoadout(), [2, 1, 2, 1, 1]);
assert.equal(GRENADE_TYPES.molotov.cook, false);
assert.equal(molotovFireProfile(), MOLOTOV_FIRE);
assert.equal(molotovFireProfile(NaN), MOLOTOV_FIRE);
assert.equal(molotovFireProfile(-1), MOLOTOV_FIRE);

// Chaos tiers change real exposure and lifetime, while normal bottles keep their tuning.
for (const [level, radius, duration, dps] of [[0, 3.2, 7.5, 30], [1, 4.2, 7.5, 30],
  [2, 4.2, 10, 30], [3, 4.2, 10, 40]]) {
  const f = fixture(); f.victim.hp = 1000;
  const field = f.ignite({ chaosLevel: level });
  assert.equal(field.radius, radius);
  f.step(0.5);
  assert.equal(f.victim.hp, 1000 - dps * 0.5, `tier ${level} deals its actual per-second damage`);
  f.step(duration - 0.5);
  assert(Math.abs(f.victim.hp - (1000 - dps * duration)) < 1e-7);
  assert.equal(f.system.fire.active.size, 0, `tier ${level} expires after exactly ${duration} seconds`);
}
{
  const f = fixture(); f.ignite(); f.ignite({ chaosLevel: 3 }); f.step(0.5);
  assert.equal(f.victim.hp, 80, 'hotter overlapping fire wins regardless of insertion order without stacking damage');
}
for (const level of [0, 1]) {
  const f = fixture(); f.ignite({ chaosLevel: level });
  f.victim.x += 4.5; f.step(0.5);
  assert.equal(f.victim.hp, level ? 85 : 100, 'wider tier actually damages the visible outer ring');
}
// Every supported site in the wider circle survives the shared cap at varied impact offsets.
for (const offsetX of [0, 0.13, 0.5, 0.87]) for (const offsetZ of [0, 0.13, 0.5, 0.87]) {
  const f = fixture();
  const field = f.ignite({ x: 20 + offsetX, z: 20 + offsetZ, chaosLevel: 3 });
  let expected = 0;
  for (let x = 15; x <= 25; x++) for (let z = 15; z <= 25; z++) {
    if (Math.hypot(x + 0.5 - field.x, z + 0.5 - field.z) <= 4.2) expected++;
  }
  assert.equal(field.cells.length, expected, 'wider spread loses no outer sites to its rendering/network cap');
}

// The real release/flight/impact route consumes only the new inventory slot.
{
  const f = fixture();
  f.victim.x = 40;
  const p = f.system.throw(f.owner, f.ctx, 0.5, 3, 4999);
  assert.equal(p.type, 'molotov');
  assert.equal(p.explodeAt, 5000, 'charging cannot shorten the bottle flight failsafe');
  assert.deepEqual(f.owner.grenades, [2, 1, 2, 0, 1]);
  const predicted = predictGrenadePath(p, (x, y, z) => !!f.ctx.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)));
  assert(predicted.rests && predicted.landing[1] < 1.2, 'preview terminates at the same supporting ground');
  for (let i = 0; i < 100 && f.system.active.size; i++) f.step(1 / 60);
  assert.equal(f.system.active.size, 0, 'bottle shatters on contact before its failsafe');
  assert.equal(f.system.fire.active.size, 1);
  assert.equal(f.events.filter(e => e.kind === 'projectileExplode' && e.type === 'molotov').length, 1);
  assert.equal(f.terrain.length, 0, 'ignition does not carve the map');
  const field = [...f.system.fire.active.values()][0];
  assert.equal(field.expiresAt - field.createdAt, MOLOTOV_FIRE.durationMs);
  assert(field.cells.length > 20 && field.cells.length <= MOLOTOV_FIRE.maxCells);
  assert(field.cells.every(cell => cell[1] === 1.04));
}

// Continuous damage is batched, ends when leaving, and does not stack on overlap.
{
  const f = fixture();
  f.ignite(); f.ignite();
  f.step(0.1); assert.equal(f.victim.hp, 100, 'no blast and no per-frame hit event');
  assert.equal(f.victim.molotovBurning, 0.5, 'visible contact drives the existing burning feedback');
  assert.equal(f.victim.burn, null, 'ground fire does not add a second afterburn source');
  assert.equal(makeSnapshot([f.victim], [], [], f.ctx.now).players[0].burning, 0.5);
  f.step(0.15); assert.equal(f.victim.hp, 92.5, 'overlap still deals 30 DPS');
  f.step(0.1); f.victim.x += 10; f.step(0.1);
  assert(Math.abs(f.victim.hp - 89.5) < 1e-8, 'exit flushes only actual accumulated exposure');
  assert.equal(f.victim.molotovBurning, 0, 'leaving clears fire feedback immediately');
  const hp = f.victim.hp;
  f.step(0.5); assert.equal(f.victim.hp, hp, 'no invisible damage follows a player out');
}

// Full lifetime and a delayed tick preserve damage at the expiry boundary.
{
  const f = fixture();
  f.ignite({ owner: f.victim, ownerId: f.victim.id });
  f.ignite(); f.step(0.5);
  assert.equal(f.victim.hp, 85, 'self-fire cannot reduce damage from an overlapping enemy field');
}
for (const chunks of [[7.5], Array(75).fill(0.1)]) {
  const f = fixture(); f.victim.hp = 1000;
  f.ignite();
  for (const dt of chunks) f.step(dt);
  assert(Math.abs(f.victim.hp - (1000 - 30 * 7.5)) < 1e-7);
  assert.equal(f.system.fire.active.size, 0);
  const hp = f.victim.hp; f.step(2); assert.equal(f.victim.hp, hp);
}

// Shared mode policy, owner safety factor, protection, armor and attribution.
{
  const f = fixture(); f.owner.x = f.victim.x; f.owner.z = f.victim.z;
  f.ctx.canDamage = () => false;
  f.ignite(); f.step(0.5);
  assert.equal(f.victim.hp, 100, 'friendly player is protected by mode policy');
  assert(Math.abs(f.owner.hp - (100 - 15 * 0.72)) < 1e-8, 'owner keeps existing throwable self-damage rules');
}
{
  const f = fixture(); f.victim.spawnProtectedUntil = 1000;
  f.ignite(); f.step(0.5); assert.equal(f.victim.hp, 100);
  f.victim.spawnProtectedUntil = 0; f.victim.armor = 20;
  f.step(0.5); assert.equal(f.victim.hp, 100); assert.equal(f.victim.armor, 5);
}
{
  const f = fixture(); f.ignite(); f.ctx.grenadeDamage = false;
  f.step(1); assert.equal(f.victim.hp, 100, 'GunGame keeps grenade damage disabled');
  assert.equal(f.system.fire.active.size, 1, 'non-damaging mode still presents the ground fire');
}
{
  const f = fixture(); f.ignite(); f.victim.hp = 2; f.owner.state = 'dead';
  f.ctx.entities.delete(f.owner.id);
  f.step(0.25); f.step(0.5);
  assert.equal(f.kills.length, 1);
  assert.equal(f.kills[0].killer, f.owner, 'credit survives the thrower leaving or dying');
  assert.equal(f.kills[0].weapon, 'molotov');
}

// A wall clips both the visible cells and the damaging footprint.
{
  const f = fixture((x, y) => y === 0 || (x === 21 && y < 5) ? 1 : 0);
  f.ignite(); f.victim.x = 22.2; f.step(0.5);
  assert.equal(f.victim.hp, 100);
  assert([...f.system.fire.active.values()][0].cells.every(cell => cell[0] < 21));
}
// New cover and destroyed ground affect already burning cells on the next step.
{
  let wall = false;
  const f = fixture((x, y) => y === 0 || (wall && x === 21 && y < 5) ? 1 : 0);
  f.ignite(); wall = true; f.victim.x = 21.2; f.step(0.5);
  assert.equal(f.victim.hp, 100, 'solid cover inserted over the body blocks contact rays');
}
{
  let ground = true;
  const f = fixture((_x, y) => ground && y === 0 ? 1 : 0);
  f.ignite(); ground = false; f.step(0.25);
  assert.equal(f.victim.hp, 100); assert.equal(f.system.fire.active.size, 0);
}
{
  const f = fixture(); f.ignite(); f.victim.y = 3; f.step(0.5);
  assert.equal(f.victim.hp, 100, 'a player above the flame height is out of contact');
}
{
  const f = fixture((_x, y) => y === 0 || y === 4 ? 1 : 0);
  const field = f.ignite({ y: 5.2 });
  assert(field.cells.every(cell => cell[1] === 5.04), 'upper floor catches the spill');
  f.step(0.5); assert.equal(f.victim.hp, 100, 'fire on an upper floor cannot reach a player underneath');
}

// Fields and pending damage obey phase/lifecycle and bounded room budgets.
{
  const f = fixture(); f.ignite(); f.step(0.1);
  f.ctx.canAffectWorld = () => false; f.step(0.5);
  assert.equal(f.system.fire.active.size, 0); assert.equal(f.system.fire.pending.size, 0);
  assert.equal(f.victim.molotovBurning, 0);
  assert.equal(f.victim.hp, 100);
  assert.equal(f.ignite(), null, 'post/prep phases cannot ignite new ground hazards');
}
{
  const f = fixture(); f.ignite(); f.step(0.1); f.system.clear();
  assert.equal(f.system.fire.active.size, 0); assert.equal(f.system.fire.pending.size, 0);
  for (let i = 0; i < 100; i++) f.ignite();
  assert.equal(f.system.fire.active.size, MOLOTOV_FIRE.maxFields);
  assert([...f.system.fire.active.values()].every(field => field.cells.length <= MOLOTOV_FIRE.maxCells));
  const source = f.system.fire.snapshot();
  const snapshot = makeSnapshot([f.owner], [], [], f.ctx.now, undefined, [], [], source);
  assert.equal(snapshot.fireFields.length, MOLOTOV_FIRE.maxFields);
  assert.equal(snapshot.players[0].grenades.length, GRENADE_TYPE_IDS.length);
  assert(!('owner' in snapshot.fireFields[0]), 'wire data never includes live player objects');
  const originalX = snapshot.fireFields[0].cells[0][0]; source[0].cells[0][0] = 999;
  assert.equal(snapshot.fireFields[0].cells[0][0], originalX, 'nested cell arrays are independent');
  assert.deepEqual(makeSnapshot([], [], [], 0).fireFields, []);
  assert.doesNotThrow(() => JSON.stringify(snapshot));
}
{
  const game = new GameEngine();
  game.projectiles.fire.active.set('field', {});
  game.projectiles.active.set('bottle', {});
  game.stop();
  assert.equal(game.projectiles.fire.active.size, 0);
  assert.equal(game.projectiles.active.size, 0);
}

console.log('Molotov: impact, visible ground cells, 30 DPS, overlap, duration, cover, modes, protection, ownership, snapshots and lifecycle passed.');
