import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { AIR, BEDROCK, CONCRETE, METAL, STONE, WOOD } from '../shared/worlddata.js';
import { MGL_RULES } from '../shared/mgl-rules.js';
import { PROJECTILE_RULES } from '../server/sim/projectiles.js';

assert.ok(MGL_RULES.terrainRadius > 0 && MGL_RULES.terrainRadius < PROJECTILE_RULES.frag.terrainRadius);
assert.ok(MGL_RULES.terrainPower > 0 && MGL_RULES.terrainPower < PROJECTILE_RULES.frag.terrainPower);
assert.ok(MGL_RULES.maxDestroyedBlocks > 0
  && MGL_RULES.maxDestroyedBlocks < PROJECTILE_RULES.frag.maxDestroyedBlocks);

function fixture() {
  const game = new GameEngine();
  const origin = [20.5, 30.5, 20.5];
  // Isolate the shell from generated terrain, then exercise the room's real
  // destroyBlock port, which produces both a voxel delta and a material event.
  for (let x = 17; x <= 24; x++) for (let y = 27; y <= 34; y++) {
    for (let z = 17; z <= 24; z++) game.world.setBlock(x, y, z, AIR);
  }
  game.contexts.projectiles.canAffectWorld = () => true;
  return { game, origin, ctx: game.contexts.projectiles };
}

{
  const { game, origin, ctx } = fixture();
  const put = (x, y, z, type) => game.world.setBlock(x, y, z, type);
  put(21, 30, 20, WOOD);
  put(20, 30, 21, STONE);
  put(20, 30, 19, CONCRETE);
  put(19, 30, 20, METAL);
  put(18, 30, 20, WOOD); // The resistant metal shields this otherwise breakable block.
  put(20, 30, 22, BEDROCK);
  const projectile = { id: 'mgl-terrain', type: 'mgl', x: origin[0], y: origin[1], z: origin[2] };
  game.projectiles.active.set(projectile.id, projectile);
  assert.equal(game.projectiles.explode(projectile, ctx), true);
  assert.equal(game.world.getBlock(21, 30, 20), AIR);
  assert.equal(game.world.getBlock(20, 30, 21), AIR);
  assert.equal(game.world.getBlock(20, 30, 19), AIR);
  assert.equal(game.world.getBlock(19, 30, 20), METAL);
  assert.equal(game.world.getBlock(18, 30, 20), WOOD);
  assert.equal(game.world.getBlock(20, 30, 22), BEDROCK);
  const removed = game.tickEvents.filter((event) => event.kind === 'block' && event.v === AIR);
  assert.deepEqual(new Set(removed.map((event) => event.from)), new Set([WOOD, STONE, CONCRETE]));
  assert.equal(game.tickBlocks.length, removed.length, 'each visible break has one authoritative voxel delta');
  assert.equal(game.tickEvents.filter((event) => event.kind === 'projectileExplode').length, 1);
  assert.equal(game.projectiles.explode(projectile, ctx), false, 'one detonation cannot duplicate debris');
  assert.equal(game.tickBlocks.length, removed.length);
  game.stop();
}

{
  const { game, ctx } = fixture();
  const lowOrigin = [20.5, 1.5, 20.5];
  for (let x = 18; x <= 23; x++) for (let y = 1; y <= 4; y++) {
    for (let z = 18; z <= 23; z++) game.world.setBlock(x, y, z, AIR);
  }
  game.world.setBlock(20, 0, 20, WOOD);
  game.world.setBlock(21, 1, 20, WOOD);
  const projectile = { id: 'mgl-floor', type: 'mgl', x: lowOrigin[0], y: lowOrigin[1], z: lowOrigin[2] };
  game.projectiles.active.set(projectile.id, projectile);
  game.projectiles.explode(projectile, ctx);
  assert.equal(game.world.getBlock(21, 1, 20), AIR);
  assert.equal(game.world.getBlock(20, 0, 20), WOOD, 'the protected y=0 floor survives a nearby blast');
  game.stop();
}

{
  const { game, origin, ctx } = fixture();
  for (let x = 18; x <= 23; x++) for (let y = 28; y <= 33; y++) {
    for (let z = 18; z <= 23; z++) game.world.setBlock(x, y, z, WOOD);
  }
  // Explosion starts in air. A dense test shell exercises the cap and bounds.
  game.world.setBlock(20, 30, 20, AIR);
  ctx.solidAt = () => false;
  const projectile = { id: 'mgl-cap', type: 'mgl', x: origin[0], y: origin[1], z: origin[2] };
  game.projectiles.active.set(projectile.id, projectile);
  game.projectiles.explode(projectile, ctx);
  const removed = game.tickEvents.filter((event) => event.kind === 'block' && event.v === AIR);
  assert.equal(removed.length, MGL_RULES.maxDestroyedBlocks,
    `MGL removed ${removed.length} blocks with a ${MGL_RULES.maxDestroyedBlocks}-block cap`);
  assert.ok(removed.every((event) => Math.hypot(event.x + 0.5 - origin[0],
    event.y + 0.5 - origin[1], event.z + 0.5 - origin[2]) <= MGL_RULES.terrainRadius));
  assert.equal(game.tickBlocks.length, removed.length);
  game.stop();
}

console.log('SKIPJACK destruction: material resistance, cover, protected blocks, authority events and per-blast cap passed.');
