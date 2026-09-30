import assert from 'node:assert/strict';
import { WEAPONS } from '../shared/combatmath.js';
import { MGL_RULES, mglLaunch, stepMgl } from '../shared/mgl-rules.js';
import { PlayerEntity } from '../server/sim/player.js';
import { ProjectileSystem } from '../server/sim/projectiles.js';

assert.equal(WEAPONS.mgl.rpm, 115);
assert.equal(MGL_RULES.speed, 32);
assert.equal(MGL_RULES.fuseMs, 1800);
assert.equal(MGL_RULES.bounce, 0.65);

const wallZ = -1;
const wall = (_x, _y, z, _dx, _dy, dz, max) => {
  if (dz >= 0) return null;
  const t = (wallZ - z) / dz;
  return t >= 0 && t <= max
    ? { t, x: 0, y: 10, z: wallZ, nx: 0, ny: 0, nz: 1 } : null;
};
const bank = mglLaunch({ x: 0, y: 10, z: 0, dir: { x: 0, y: 0, z: -1 } });
for (let i = 0; i < 5 && !bank.bounced; i++) stepMgl(bank, 0.05, wall);
assert.equal(bank.bouncesLeft, MGL_RULES.maxBounces - 1);
assert.ok(Math.abs(bank.vz - MGL_RULES.speed * MGL_RULES.bounce * MGL_RULES.wallDamping) < 1e-8,
  'an angled bank retains the configured speed after wall damping');

function fixture(withTarget = true) {
  const owner = new PlayerEntity('owner', 'Owner', { x: 20, y: 10, z: 20 });
  const target = new PlayerEntity('target', 'Target', { x: 20, y: 10, z: 15 });
  const entities = new Map([[owner.id, owner], ...(withTarget ? [[target.id, target]] : [])]);
  const events = [];
  const system = new ProjectileSystem();
  const ctx = {
    now: 1000, entities, targets: entities, solidAt: () => false, getBlock: () => 0,
    canDamage: () => true, canThrow: () => false, killPlayer: () => {},
    pushEvent: (event) => events.push(event),
  };
  return { owner, target, events, system, ctx };
}

{
  const { owner, target, events, system, ctx } = fixture();
  const round = system.launchMgl(owner, ctx, { x: 0, y: 0, z: -1 });
  const launch = events.find((event) => event.kind === 'projectileLaunch');
  assert.equal(launch.fuse, MGL_RULES.fuseMs, 'the client receives the authoritative fuse');
  assert.equal(launch.arm, MGL_RULES.armMs);
  assert.equal(launch.v[2], -MGL_RULES.speed, 'the client receives the authoritative muzzle speed');
  for (let i = 0; i < 120 && system.active.has(round.id); i++) {
    ctx.now += 1000 / 60;
    system.step(1 / 60, ctx);
  }
  assert.equal(target.hp, 36, 'armed body contact deals 64 HP after the global multiplier');
  assert.equal(owner.hp, 100, 'a forward direct shot does not detonate on its owner');
  assert.equal(events.filter((event) => event.kind === 'projectileExplode').length, 1);
}

{
  const { owner, events, system, ctx } = fixture(false);
  ctx.solidAt = (_x, _y, z) => z <= 17;
  ctx.getBlock = (_x, _y, z) => z <= 17 ? 1 : 0;
  const round = system.launchMgl(owner, ctx, { x: 0, y: 0, z: -1 });
  for (let i = 0; i < 40 && round.bouncesLeft === MGL_RULES.maxBounces; i++) {
    ctx.now += 1000 / 60;
    system.step(1 / 60, ctx);
  }
  assert.equal(round.bouncesLeft, MGL_RULES.maxBounces - 1);
  assert.ok(round.vz > 0, 'authority reflects from the voxel face');
  assert.ok(events.some((event) => event.kind === 'projectileUpdate'
    && event.bn === round.bouncesLeft && event.v[2] > 0),
  'the authority publishes the reflected velocity and bounce count');
}

{
  const { owner, events, system, ctx } = fixture(false);
  const round = system.launchMgl(owner, ctx, { x: 1, y: 0, z: 0 });
  round.x = owner.x + 5;
  ctx.now = round.explodeAt - 1;
  system.step(1 / 60, ctx);
  assert.ok(system.active.has(round.id), 'the airburst does not occur before the fuse');
  ctx.now = round.explodeAt;
  system.step(1 / 60, ctx);
  assert.ok(!system.active.has(round.id), 'the server detonates at the configured fuse');
  assert.equal(events.filter((event) => event.kind === 'projectileExplode').length, 1);
}

{
  const { owner, system, ctx } = fixture(false);
  const round = system.launchMgl(owner, ctx, { x: 0, y: 0, z: -1 });
  Object.assign(round, { x: owner.x, y: owner.y + 1.05, z: owner.z, vx: 0, vy: 0, vz: 0 });
  ctx.now = round.armedAt;
  system.step(1 / 60, ctx);
  assert.ok(system.active.has(round.id), 'arming alone does not allow owner contact during grace');
  assert.equal(owner.hp, 100);
  ctx.now = round.launchedAt + 220;
  system.step(1 / 60, ctx);
  assert.ok(!system.active.has(round.id), 'owner contact becomes authoritative after grace');
  assert.ok(owner.hp < 100 && owner.hp > 0, 'late self-contact uses reduced self damage');
}

console.log('SKIPJACK gameplay: cadence, launch wire values, retained bank speed, server bounce sync, body damage, fuse airburst, and owner contact grace passed.');
