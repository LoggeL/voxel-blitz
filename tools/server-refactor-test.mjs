import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { GameEngine } from '../server/game.js';
import { ProjectileSystem, PROJECTILE_RULES } from '../server/sim/projectiles.js';
import { PlayerEntity } from '../server/sim/player.js';
import { stepMovement } from '../server/sim/movement.js';
import { AIR, STONE, WOOD, PLANK, GLASS, METAL, SX, SY, SZ, GRENADE_RESISTANCE } from '../shared/worlddata.js';
import { raycastVoxels } from '../shared/raycast.js';

// Engine ports remain live across ticks, phase transitions, state replacement,
// and nested projectile -> terrain -> combat operations.
{
  const game = new GameEngine();
  const combat = game.combatContext(), projectiles = game.projectileContext();
  assert.equal(game.combatContext(), combat);
  assert.equal(game.projectileContext(), projectiles);
  game.now += 500;
  assert.equal(combat.now, game.now);
  assert.equal(projectiles.now, game.now);
  game.mode.policy.phase = 'post';
  assert.equal(combat.canBurn(), false);
  assert.equal(projectiles.canAffectWorld(), false);
  game.mode.policy.phase = 'live';
  game.mode.policy.mode = 'gungame';
  assert.equal(projectiles.grenadeDamage, false);
  game.mode.policy.mode = 'fun';
  assert.equal(projectiles.grenadeDamage, true);
  const blocks = new Map([['10,10,10', PLANK], ['10,11,10', GLASS]]);
  game.world = {
    getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) || AIR,
    setBlock: (x, y, z, value) => blocks.set(`${x},${y},${z}`, value),
  };
  game.tickEvents = [];
  game.blockHp = new Map();
  assert.equal(combat.solidAt(10, 10, 10), true);
  projectiles.damageBlock(10, 10, 10, PLANK, 10000);
  assert.equal(blocks.get('10,10,10'), AIR);
  assert.equal(blocks.get('10,11,10'), AIR, 'fragile support collapse survives the shared ports');
  assert.equal(game.tickEvents.length, 2);
  assert.equal(game.tickBlocks.length, 2);
  assert.equal(projectiles.destroyBlock(10, 10, 10), false, 'repeat destruction emits no duplicate delta');
  assert.equal(game.blockHp.size, 0);
}

// All movement branches retain the same bounded, independent rewind samples.
{
  const player = new PlayerEntity('p', 'Player', { x: 10, y: 10, z: 10 });
  const ctx = { now: 0, solidAt: () => false, mapMeta: null, movementLocked: true,
    onFall: (_p, reason) => { throw new Error(reason); } };
  for (let tick = 0; tick < 24; tick++) {
    ctx.now += 50;
    player.x = 10 + tick;
    stepMovement(player, 0.05, ctx);
  }
  assert.equal(player.hist.length, 16);
  assert.equal(player.hist[0].t, 450);
  assert.equal(player.hist.at(-1).t, 1200);
  assert.equal(player.hist[0].x, 18);
  assert.equal(player.hist.at(-1).x, 33);
  const pose = player.hist.at(-1);
  player.x = 34;
  assert.equal(pose.x, 33);
  ctx.movementLocked = false;
  ctx.now += 50;
  stepMovement(player, 0.05, ctx);
  assert.equal(player.hist.at(-1).t, 1250);
  assert(Number.isFinite(player.y));
  player.x = '34';
  assert.throws(() => stepMovement(player, 0.05, ctx), /invalid/);
}

// Explosions can remove existing members and add children while stepping. The
// launch tick must not move those children or process a deleted sibling.
{
  const system = new ProjectileSystem();
  const stepped = [];
  const initial = [
    { id: 'first', type: 'frag', x: 10, y: 10, z: 10, explodeAt: Infinity },
    { id: 'removed', type: 'frag', x: 10, y: 10, z: 10, explodeAt: Infinity },
    { id: 'last', type: 'frag', x: 10, y: 10, z: 10, explodeAt: Infinity },
  ];
  for (const projectile of initial) system.active.set(projectile.id, projectile);
  system._flyGrenade = (projectile) => {
    stepped.push(projectile.id);
    if (projectile.id === 'first') {
      system.active.delete('first');
      system.active.delete('removed');
      system.active.set('child', { id: 'child', type: 'frag', x: 10, y: 10, z: 10, explodeAt: Infinity });
    }
  };
  const ctx = { now: 50, entities: new Map(), pushEvent() {} };
  system.step(0.05, ctx);
  assert.deepEqual(stepped, ['first', 'last']);
  stepped.length = 0;
  system.step(0.05, ctx);
  assert.deepEqual(stepped, ['last', 'child']);
  system.clear();
  stepped.length = 0;
  system.step(0.05, ctx);
  assert.deepEqual(stepped, []);
}

// Frozen pre-refactor terrain algorithm verifies exact destruction order,
// shielding, material resistance, clipping and per-blast caps.
function referenceTerrain(origin, rules, ctx) {
  const radius = rules.terrainRadius, candidates = [];
  const minX = Math.max(0, Math.floor(origin[0] - radius));
  const maxX = Math.min(SX - 1, Math.ceil(origin[0] + radius));
  const minY = Math.max(1, Math.floor(origin[1] - radius));
  const maxY = Math.min(SY - 1, Math.ceil(origin[1] + radius));
  const minZ = Math.max(0, Math.floor(origin[2] - radius));
  const maxZ = Math.min(SZ - 1, Math.ceil(origin[2] + radius));
  for (let y = minY; y <= maxY; y++) for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) {
    const resistance = GRENADE_RESISTANCE[ctx.getBlock(x, y, z)];
    if (!Number.isFinite(resistance)) continue;
    const distance = Math.hypot(x + 0.5 - origin[0], y + 0.5 - origin[1], z + 0.5 - origin[2]);
    if (distance > radius) continue;
    const power = rules.terrainPower * Math.pow(Math.max(0, 1 - distance / radius), 0.58);
    if (power >= resistance) candidates.push({ x, y, z, distance });
  }
  candidates.sort((a, b) => a.distance - b.distance);
  let destroyed = 0;
  for (const block of candidates) {
    if (destroyed >= rules.maxDestroyedBlocks) break;
    const dx = block.x + 0.5 - origin[0], dy = block.y + 0.5 - origin[1], dz = block.z + 0.5 - origin[2];
    const hit = raycastVoxels((x, y, z) => ctx.getBlock(x, y, z) !== AIR,
      ...origin, dx, dy, dz, block.distance + 0.2);
    if (hit && (hit.x !== block.x || hit.y !== block.y || hit.z !== block.z)) continue;
    if (ctx.destroyBlock(block.x, block.y, block.z)) destroyed++;
  }
}

function terrainFixture(origin, salt) {
  const removed = new Set(), destroyed = [];
  let reads = 0;
  const ctx = {
    getBlock(x, y, z) {
      reads++;
      if (removed.has(`${x},${y},${z}`)) return AIR;
      if (x === Math.floor(origin[0]) && y === Math.floor(origin[1]) && z === Math.floor(origin[2])) return AIR;
      return [STONE, AIR, WOOD, GLASS, METAL, WOOD][Math.abs(x * 17 + y * 31 + z * 13 + salt) % 6];
    },
    destroyBlock(x, y, z) {
      const key = `${x},${y},${z}`;
      if (removed.has(key)) return false;
      removed.add(key);
      destroyed.push(key);
      return true;
    },
  };
  return { ctx, destroyed, get reads() { return reads; } };
}

const system = new ProjectileSystem();
const totals = { before: 0, after: 0, destroyed: 0, fixtures: 0 };
const start = performance.now();
for (const origin of [[20.5, 20.5, 20.5], [22.123, 12.876, 18.42], [0.12, 1.2, 0.1], [SX - 0.2, SY - 0.2, SZ - 0.2]]) {
  for (const radius of [1, 3.1, 5.27, 7]) for (const cap of [0, 12, 120]) {
    const rules = { ...PROJECTILE_RULES.rocket, terrainRadius: radius, terrainPower: 160, maxDestroyedBlocks: cap };
    const before = terrainFixture(origin, totals.fixtures), after = terrainFixture(origin, totals.fixtures);
    referenceTerrain(origin, rules, before.ctx);
    system._destroyTerrain(origin, rules, after.ctx);
    assert.deepEqual(after.destroyed, before.destroyed);
    assert(after.reads <= before.reads);
    totals.before += before.reads;
    totals.after += after.reads;
    totals.destroyed += after.destroyed.length;
    totals.fixtures++;
  }
}
assert(totals.destroyed > 100, 'equivalence fixtures must actually destroy terrain');
assert(totals.after < totals.before * 0.7, 'sphere rejection removes at least 30% of terrain reads');
console.log(JSON.stringify({ terrainVoxelReads: totals, elapsedMs: Math.round(performance.now() - start) }));
console.log('Server refactor: live room contexts, pose history, projectile membership and terrain equivalence passed.');
