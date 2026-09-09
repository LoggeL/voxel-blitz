import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { PlayerEntity } from '../server/sim/player.js';
import { ProjectileSystem } from '../server/sim/projectiles.js';
import { makeSnapshot } from '../server/protocol/snapshot.js';
import { ProjectileFX } from '../public/js/weapons/projectiles.js';
import { CLAYMORE_RULES, placeClaymore, claymoreBeam, crossesClaymore } from '../shared/claymore-rules.js';
import { grenadeLaunch } from '../shared/grenade-rules.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const wall = (x) => x === 12;
const placement = { x: 10.5, eyeY: 2.2, z: 10.5, dir: { x: 1, y: 0, z: 0 } };
const mine = placeClaymore(placement, wall);
assert.deepEqual(mine.n, [-1, 0, 0]);
assert.deepEqual(mine.mount, [12, 2, 10]);
near(mine.x, 12 - CLAYMORE_RULES.surfaceOffset);
for (const [args, terrain, label] of [
  [placement, () => false, 'empty space'],
  [{ ...placement, x: 8 }, wall, 'distant wall'],
  [{ ...placement, dir: { x: 0, y: -1, z: 0 } }, (_x, y) => y === 0, 'floor'],
  [{ ...placement, dir: { x: 0, y: 1, z: 0 } }, (_x, y) => y === 3, 'ceiling'],
  [{ ...placement, x: 12.5 }, wall, 'eye inside terrain'],
  [{ ...placement, dir: { x: NaN, y: 0, z: 0 } }, wall, 'invalid aim'],
]) assert.equal(placeClaymore(args, terrain), null, label);
for (const n of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
  const axis = n[0] ? 'x' : 'z';
  const direction = { x: -n[0], y: 0, z: -n[2] };
  const args = { x: 10.5, eyeY: 2.2, z: 10.5, dir: direction };
  const cell = n[0] + n[2] > 0 ? 9 : 12;
  const surface = (x, _y, z) => (axis === 'x' ? x : z) === cell;
  assert.deepEqual(placeClaymore(args, surface).n, n, 'all four wall orientations');
}
assert.equal(grenadeLaunch({ ...placement, type: 'limpet', charge: 1 }), null, 'mine cannot become an airborne grenade');

function fixture(level = 0) {
  const owner = new PlayerEntity('owner', 'Owner', { x: 10.5, y: 1, z: 10.5 }, false);
  Object.assign(owner, { yaw: -Math.PI / 2, pitch: -0.27, spawnProtectedUntil: 5000,
    chaosUpgrades: { limpet: level } });
  const victim = new PlayerEntity('victim', 'Victim', { x: 10.5, y: 1, z: 12.5 }, false);
  victim.spawnProtectedUntil = 0;
  const system = new ProjectileSystem();
  const events = [];
  const ctx = { now: 0, entities: new Map([[owner.id, owner], [victim.id, victim]]),
    getBlock: (x, y, z) => x === 12 && y >= 0 && y < 5 ? 1 : 0,
    canThrow: () => true, canAffectWorld: () => true, canDamage: (_a, b) => !b.friendly,
    pushEvent: event => events.push(event), destroyBlock: () => false,
    killPlayer: p => { p.state = 'dead'; }, grenadeDamage: true };
  const place = () => system.throw(owner, ctx, 1, 1);
  const tick = at => { ctx.now = at; system.step(0.05, ctx); };
  return { owner, victim, system, events, ctx, place, tick };
}

{
  const f = fixture();
  f.ctx.getBlock = () => 0;
  assert.equal(f.place(), null);
  assert.equal(f.owner.grenades[1], 1);
  assert.equal(f.owner.spawnProtectedUntil, 5000, 'failed placement preserves spawn protection');
  assert.equal(f.events.length, 0, 'failed placement creates no effect');
}
{
  const f = fixture();
  const p = f.place();
  assert.ok(p && p.stuck);
  assert.equal(f.owner.grenades[1], 0);
  assert.equal(f.owner.spawnProtectedUntil, 0);
  assert.equal(f.place(), null, 'empty inventory cannot place a second mine');
  f.victim.z = p.z;
  f.tick(899);
  assert.equal(f.system.active.size, 1, 'walking through during arming does not trigger');
  f.victim.z = 12.5;
  f.tick(10000);
  assert.equal(f.system.active.size, 1, 'no timed detonation; owner can stand in own laser');
  f.victim.friendly = true;
  f.victim.z = p.z;
  f.tick(10100);
  assert.equal(f.system.active.size, 1, 'teammates cannot trigger');
  f.victim.friendly = false;
  f.victim.spawnProtectedUntil = 12000;
  f.tick(10200);
  assert.equal(f.system.active.size, 1, 'spawn-protected players cannot trigger');
  f.victim.spawnProtectedUntil = 0;
  f.tick(12001);
  assert.equal(f.system.active.size, 0, 'enemy on the laser triggers immediately');
  assert.ok(f.victim.hp < 100, 'trigger applies real blast damage');
  assert.equal(f.events.filter(e => e.kind === 'projectileExplode').length, 1);
  f.tick(12051);
  assert.equal(f.events.filter(e => e.kind === 'projectileExplode').length, 1, 'exactly one explosion');
}
{
  const f = fixture();
  const p = f.place();
  const original = f.ctx.getBlock;
  f.ctx.getBlock = (x, y, z) => x === 9 ? 1 : original(x, y, z);
  f.victim.x = 8.5; f.victim.z = p.z;
  f.tick(1000);
  assert.equal(f.system.active.size, 1, 'player behind an obstruction cannot trigger');
  const beam = claymoreBeam(p, (x, y, z) => f.ctx.getBlock(x, y, z) !== 0);
  near(beam.end[0], 10);
  f.ctx.getBlock = original;
  f.tick(1050);
  assert.equal(f.system.active.size, 0, 'removing beam obstruction extends the live trigger');
}
{
  const f = fixture();
  const p = f.place();
  f.victim.z = p.z - 0.8;
  f.tick(1000);
  assert.equal(f.system.active.size, 1);
  f.victim.z = p.z + 0.8;
  f.tick(1050);
  assert.equal(f.system.active.size, 0, 'fast movement across the entire beam between ticks still triggers');
}
{
  const f = fixture();
  const p = f.place();
  const beam = claymoreBeam(p, wall);
  f.victim.z = p.z; f.victim.proneT = 1;
  assert.equal(crossesClaymore(beam, f.victim), false, 'a prone body below a high laser can crawl underneath');
  f.ctx.getBlock = () => 0;
  f.tick(1000);
  assert.equal(f.system.active.size, 0, 'destroyed mounting block removes the mine');
  assert.equal(f.events.filter(e => e.kind === 'projectileExplode').length, 0);
}
for (const level of [0, 1, 2, 3]) {
  const f = fixture(level);
  const p = f.place();
  assert.equal(p.laserRange, level >= 1 ? 7 : 5);
  assert.equal(p.armedAt, level >= 2 ? 450 : 900);
  assert.ok(!p.chaosHoming);
  f.system.explode(p, f.ctx);
  assert.equal(f.system.active.size, 0, 'Chaos mines never scatter airborne sticky charges');
}
{
  const f = fixture();
  f.owner.grenades[1] = 8;
  for (let i = 0; i < 8; i++) f.place();
  assert.equal(f.system.active.size, CLAYMORE_RULES.maxPerOwner);
  const p = [...f.system.active.values()][0];
  p.explodeAt = 50;
  f.tick(50);
  assert.ok(!f.system.active.has(p.id), 'chain-triggered mines still detonate');
  f.system.clear();
  assert.deepEqual(f.system.mineSnapshot(1000), [], 'room reset clears all persistent mines');
}

// Snapshots reconstruct the complete mine for late arrivals; prediction adopts the
// authority's exact wall face, survives indefinitely and follows terrain edits.
{
  const f = fixture();
  const p = f.place();
  const rows = f.system.mineSnapshot(0);
  const wire = makeSnapshot([], [], [], 0, undefined, [], [], [], [], rows);
  rows[0].n[0] = 99;
  assert.equal(wire.mines[0].n[0], -1, 'snapshot owns nested arrays');
  const scene = new THREE.Scene();
  const fx = new ProjectileFX(scene, (x, y, z) => f.ctx.getBlock(x, y, z));
  const event = wire.mines[0];
  fx.launch(event, { local: true });
  fx.syncMines(wire.mines, 'owner');
  assert.equal(fx.projectiles.size, 1, 'snapshot adopts prediction without doubling');
  const rendered = fx.projectiles.get(p.id);
  assert.equal(rendered.local, false);
  assert.equal(rendered.group.userData.laser.visible, false, 'laser stays off during arming');
  for (let i = 0; i < 24; i++) fx.update(0.05);
  assert.equal(rendered.group.userData.laser.visible, true);
  const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(rendered.group.quaternion);
  near(facing.x, -1);
  const late = new ProjectileFX(new THREE.Scene(), (x, y, z) => f.ctx.getBlock(x, y, z));
  late.syncMines(f.system.mineSnapshot(10000), 'new-player');
  assert.equal(late.projectiles.get(p.id).group.userData.laser.visible, true, 'late join sees armed laser');
  for (let i = 0; i < 400; i++) late.update(0.05);
  assert.equal(late.projectiles.size, 1, 'persistent mine outlives old throw fuse');
  fx.setPreview({ ...p });
  assert.equal(fx.previewLine.visible, false, 'mine has no throw arc');
  assert.equal(fx.minePreview.group.visible, true);
  fx.setPreview(null);
  assert.equal(fx.minePreview.group.visible, false, 'invalid wall hides placement ghost');
  fx.syncMines([], 'owner');
  assert.equal(fx.projectiles.size, 0);
  assert.equal(fx.launch(event), false, 'delayed launch event cannot resurrect a removed mine');
  fx.dispose(); late.dispose();
  assert.equal(scene.children.length, 0, 'mine, laser and preview clean up');
}
console.log('Claymore: wall-only placement, inventory, arming, laser occlusion, swept crossing, teams, damage, Chaos, snapshots and rendering passed.');
