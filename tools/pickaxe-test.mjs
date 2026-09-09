import assert from 'node:assert/strict';
import { resolveWeaponIntent } from '../server/sim/combat.js';
import { WEAPONS } from '../shared/combatmath.js';
import { MINING_HITS, STONE } from '../shared/world/blocks.js';

function setup(type = STONE, distance = 2) {
  const blocks = new Map([[`0,2,${3 - distance}`, type]]);
  const events = [], deltas = [];
  const key = (x, y, z) => `${x},${y},${z}`;
  const p = { id: 'miner', x: 0.5, z: 3.5, eyeY: 2.5, yaw: 0, pitch: 0,
    def: WEAPONS.knife, weapon: 9, cooldown: 0, deployT: 0,
    input: { wantFire: true }, shotSeq: 0, mag: [], reserve: [] };
  const ctx = { now: 0, entities: new Map(), blockHp: new Map(), blockMining: new Map(),
    canFire: () => true, canUseWeapon: () => true, canDamage: () => true,
    getBlock: (x, y, z) => blocks.get(key(x, y, z)) || 0,
    setBlock: (x, y, z, v) => blocks.set(key(x, y, z), v),
    solidAt: (x, y, z) => blocks.get(key(x, y, z)) || 0,
    pushEvent: e => events.push(e), pushBlockDelta: (...d) => deltas.push(d) };
  const swing = () => { p.cooldown = 0; ctx.now += 500; resolveWeaponIntent(p, 0.5, ctx); };
  return { p, ctx, events, deltas, swing };
}
for (const [type, required] of Object.entries(MINING_HITS)) {
  const s = setup(Number(type));
  for (let i = 1; i < required; i++) { s.swing(); assert.equal(s.deltas.length, 0); }
  s.swing(); assert.equal(s.deltas.length, 1, `material ${type} breaks on swing ${required}`);
  assert.equal(s.events.filter(e => e.kind === 'mine').at(-1).progress, 1);
}
{
  const s = setup(); s.swing(); s.swing();
  s.p.input.wantFire = false; resolveWeaponIntent(s.p, 0.02, s.ctx);
  s.p.input.wantFire = true; s.swing(); assert.equal(s.p.mining.hits, 3, 'release preserves block damage');
  s.ctx.now += 900; s.swing(); assert.equal(s.p.mining.hits, 4, 'pause preserves block damage');
  s.p.yaw = Math.PI; s.swing(); assert.equal(s.p.mining, null);
  assert.equal(s.ctx.blockMining.get('0,2,1'), 4, 'looking away preserves damage');
  s.p.yaw = 0; s.p.id = 'second-miner'; s.p.mining = null; s.swing();
  assert.equal(s.p.mining.hits, 5, 'another player continues shared mining progress');
  s.swing(); assert.equal(s.deltas.length, 1);
  assert.equal(s.ctx.blockMining.size, 0, 'destruction clears mining state');
}
{
  const s = setup(STONE, 5); s.swing(); assert.equal(s.events.filter(e => e.kind === 'mine').length, 0);
}
{
  const s = setup(); s.ctx.canFire = () => false; s.swing(); assert.equal(s.events.length, 0);
}
{
  const s = setup(); s.swing(); const n = s.events.length;
  resolveWeaponIntent(s.p, 0.01, s.ctx); assert.equal(s.events.length, n, 'cooldown prevents faster mining');
}
console.log('Pickaxe: all materials, persistent shared damage, aim, reach, fire gating and cadence passed.');

const THREE = await import('../public/js/vendor/three.module.js');
const { pickaxeSwingPose } = await import('../public/js/guns/pickaxe-swing.js');
const lift = pickaxeSwingPose(0.34), strike = pickaxeSwingPose(0.6);
assert.ok(lift.rx > 0.9 && strike.rx < -0.4 && lift.y + 0.4 * Math.sin(lift.rx) > strike.y + 0.4 * Math.sin(strike.rx));
assert.ok(lift.ry > 0 && strike.ry < 0, 'the lift turns into an inward chop');
assert.ok(Math.abs(lift.rz) < 0.15 && Math.abs(strike.rz) < 0.15, 'wrist roll stays modest');
assert.ok(Math.abs(pickaxeSwingPose(1).rx) < 1e-9);
const { ImpactFX } = await import('../public/js/weapons/impacts.js');
const scene = new THREE.Scene();
const fx = new ImpactFX(scene, new THREE.PerspectiveCamera(), () => 3);
const event = { x: 0, y: 2, z: 0, nx: 0, ny: 0, nz: 1, from: 3, progress: 0.2 };
fx.mine(event);
assert.equal(fx.particlesSpawned, 5, 'accepted mining strike emits dust');
const { removedDamageCells } = await import('../public/js/engine/block-damage-geometry.js');
const cells = removedDamageCells(0, 2, 0, 0, 0.2);
fx.chipBlock({ ...event, v: 3, previousProgress: 0 });
assert.equal(fx.particlesSpawned, 5 + cells.length, 'every lost voxel piece emits a shard');
for (let i = 0; i < cells.length; i++) {
  const particle = fx.parts[5 + i];
  assert.deepEqual([particle.x, particle.y - 2, particle.z], cells[i],
    'shards start in the cells removed from the block mesh');
}
const spawned = fx.particlesSpawned;
fx.chipBlock({ ...event, v: 3, previousProgress: 0.2 });
fx.chipBlock({ ...event, v: 10, previousProgress: 0 });
assert.equal(fx.particlesSpawned, spawned, 'no duplicate stage chips or stale material debris');
fx.update(2);
assert.equal(fx.parts.filter(p => p.active).length, 0, 'transient debris expires');
fx.dispose(); assert.equal(scene.children.length, 0);
console.log('Pickaxe presentation: diagonal chop, matching voxel shards and debris cleanup passed.');

// Contact rebounds after the chop; missed swings keep their follow-through.
for (let i = 0; i <= 100; i++) {
  const t = i / 100;
  assert.ok(Object.values(pickaxeSwingPose(t, true)).every(Number.isFinite));
}
assert.ok(pickaxeSwingPose(0.67, true).rx > pickaxeSwingPose(0.67).rx);
assert.deepEqual(pickaxeSwingPose(1, true), pickaxeSwingPose(1));
const { ViewmodelRig } = await import('../public/js/guns/viewmodel.js');
const rig = new ViewmodelRig(new THREE.PerspectiveCamera());
rig.setWeapon('knife');
for (let i = 0; i < 180; i++) rig.update(1 / 60, { grounded: true });
assert.equal(rig.fire(), true);
rig.pickaxeContact();
assert.equal(rig._swingContact, true);
rig.setWeapon('rifle'); rig.pickaxeContact();
assert.equal(rig._swingContact, false, 'swapping clears contact recoil');
rig.dispose();
const materialFx = new ImpactFX(new THREE.Scene(), new THREE.PerspectiveCamera());
materialFx.mine({ ...event, from: 8 });
assert.equal(materialFx.particlesSpawned, 7, 'metal chips include two contact glints');
assert.equal(materialFx.parts[5].glint, true);
materialFx.dispose();
console.log('Pickaxe contact: rebound, weapon swap reset and material glints passed.');
