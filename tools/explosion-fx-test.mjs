// Explosion presentation contract: blasts own the fixed projectile light pool
// first, the fireball/smoke batch lingers and drains, scorch marks seat on the
// ground, follow their crater and hide with their support, and every pool is
// bounded and instanced.
import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { ProjectileFX } from '../public/js/weapons/projectiles.js';
import { BLAST_CAPACITY, BLAST_STYLE, spriteScale } from '../public/js/weapons/explosion-fx.js';
import { SCORCH_CAPACITY, ScorchDecals } from '../public/js/weapons/scorch-decals.js';
import { GRENADE_TYPES } from '../shared/grenade-rules.js';
import { ROCKET_RULES } from '../shared/rocket-rules.js';
import { createMapState } from '../shared/worlddata.js';
import { ProjectileSystem } from '../server/sim/projectiles.js';
import { PlayerEntity } from '../server/sim/player.js';

// Real gameplay radii, as the server sends them in projectileExplode.
const FRAG_R = GRENADE_TYPES.frag.damageRadius;
const ROCKET_R = ROCKET_RULES.damageRadius;

const FLOOR = 20;
const removed = new Set();
const key = (x, y, z) => `${x},${y},${z}`;
const getBlock = (x, y, z) => (y < FLOOR && !removed.has(key(x, y, z)) ? 1 : 0);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera();
camera.position.set(0, FLOOR + 2, 0);
const fx = new ProjectileFX(scene, getBlock, { camera });
const explosions = fx.explosions;
const lights = [];
scene.traverse((object) => { if (object.isPointLight) lights.push(object); });
const step = (seconds, dt = 1 / 60) => { for (let t = 0; t < seconds - 1e-9; t += dt) fx.update(dt); };

// Program keys: colour attributes exist before the first blast is ever drawn.
for (const mesh of [explosions.cores, explosions.wires, explosions.rings]) {
  assert.ok(mesh.isInstancedMesh && mesh.instanceColor, `${mesh.name} carries per-instance colour from construction`);
}
assert.ok(!scene.children.some((child) => child.isInstancedMesh && child.name.startsWith('explosion')),
  'blast batches live under their own group');

// Four near rockets hold the pool until a far blast outranks them.
for (let i = 0; i < 4; i++) fx.launch({ pid: `r${i}`, type: 'rocket', o: [i, FLOOR + 3, 0], v: [0, 0, 0.001], fuse: 10000 });
fx.update(1 / 60);
assert.ok(lights.every((light) => light.intensity > 0), 'rockets fill the light pool');
fx.explode({ pid: 'g1', type: 'frag', x: 30.5, y: FLOOR + 0.3, z: 5.5, radius: FRAG_R });
assert.equal(fx.blasts.length, 1);
fx.update(1 / 60);
const blastLight = lights.find((light) => Math.abs(light.position.x - 30.5) < 1e-6);
assert.ok(blastLight, 'a far blast takes a pool light ahead of nearer rockets');
assert.equal(blastLight.distance, 9, 'blast light range stays within 8-10 m');
assert.equal(lights.length, 4, 'light count never changes');
fx.update(1 / 60);
const peak = blastLight.intensity;
assert.ok(peak > 8, 'blast light attacks fast');
step(0.6);
assert.ok(!lights.some((light) => Math.abs(light.position.x - 30.5) < 1e-6 && light.intensity > 0),
  'blast light decays out in about half a second');
assert.ok(lights.every((light) => light.intensity > 0), 'rockets win their lights back');
for (const id of [...fx.projectiles.keys()]) fx._removeProjectile(id);

// Light ranking by what each light adds: weak bubble pops at the viewer's feet
// do not steal the pool from a live rocket blast 15 m away.
fx.clear();
fx.explode({ pid: 'rb', type: 'rocket', x: 15.5, y: FLOOR + 0.2, z: 0.5, radius: ROCKET_R });
for (let i = 0; i < 4; i++) fx.explode({ pid: `b${i}`, type: 'bubble', x: 2 + i * 0.3, y: FLOOR + 1, z: 1, radius: 2.2 });
fx.update(1 / 60); fx.update(1 / 60);
assert.ok(lights.some((light) => Math.abs(light.position.x - 15.5) < 1e-6 && light.intensity > 5),
  'a rocket blast outranks nearer bubble pops');
fx.clear();
// A spent far blast gives a rocket flying past the camera its light back.
fx.launch({ pid: 'pass', type: 'rocket', o: [1, FLOOR + 2, 2], v: [0, 0, 0.001], fuse: 10000 });
fx.explode({ pid: 'far', type: 'frag', x: 120.5, y: FLOOR + 0.3, z: 0.5, radius: FRAG_R });
for (let i = 0; i < 3; i++) fx.explode({ pid: `n${i}`, type: 'frag', x: 8.5 + i, y: FLOOR + 0.3, z: 6.5, radius: FRAG_R });
step(0.2);
assert.ok(lights.some((light) => Math.abs(light.position.x - 1) < 1e-6 && light.intensity > 1),
  'a passing rocket beats a decayed blast 120 m away');
for (const id of [...fx.projectiles.keys()]) fx._removeProjectile(id);
fx.clear();

// Sprite scale has a soft knee: the real 7.5 m radius does not blow the
// fireball up by the raw radius ratio (1.64 for a frag), chaos blasts still grow.
assert.ok(spriteScale(FRAG_R, BLAST_STYLE.frag) <= 1.25, 'frag sprites stay near their tuned size');
assert.ok(spriteScale(ROCKET_R, BLAST_STYLE.rocket) <= 1.25, 'rocket sprites stay near their tuned size');
assert.ok(spriteScale(ROCKET_R * 1.8, BLAST_STYLE.rocket) > spriteScale(ROCKET_R, BLAST_STYLE.rocket), 'giant blasts still grow');
// A blast on top of the viewer spawns thinner, shorter smoke than the same blast down the lane.
const smokeOf = (x) => {
  fx.clear();
  explosions.seed(7);
  explosions.spawn(x, FLOOR + 0.3, 0.5, BLAST_STYLE.frag, FRAG_R, camera.position);
  const puffs = explosions.smoke.filter((p) => p.active);
  return { opacity: puffs.reduce((sum, p) => sum + p.opacity, 0) / puffs.length, life: Math.max(...puffs.map((p) => p.life)) };
};
const pointBlank = smokeOf(0.5), downLane = smokeOf(25.5);
assert.ok(pointBlank.opacity < downLane.opacity * 0.6 && pointBlank.life < downLane.life * 0.75,
  'point-blank smoke is thinner and clears sooner');
fx.clear();

// Fire and smoke: bright early, smoke lingers 2-3 s, then the batch drains.
fx.clear();
fx.explode({ pid: 'g2', type: 'rocket', x: 10.5, y: FLOOR + 0.2, z: 10.5, radius: ROCKET_R });
step(0.1);
let fire = explosions.fire.filter((p) => p.active && p.age >= 0).length;
let smoke = explosions.smoke.filter((p) => p.active).length;
assert.ok(fire >= 6 && fire <= 10, `6-10 fire sprites (${fire})`);
assert.ok(smoke >= 10 && smoke <= 16, `10-16 smoke sprites (${smoke})`);
assert.ok(explosions.activeSprites > 0 && explosions.spriteGeometry.instanceCount === explosions.activeSprites);
const hdr = explosions.tints.getX(explosions.activeSprites - 1);
assert.ok(hdr > 1, 'fire sprites carry HDR colour for bloom');
step(1.9);
assert.equal(explosions.fire.filter((p) => p.active).length, 0, 'fire burns out quickly');
assert.ok(explosions.smoke.filter((p) => p.active).length >= 6, 'smoke still hangs at 2 s');
step(1.5);
assert.equal(explosions.activeSprites, 0, 'smoke clears by ~3.5 s');

// Scorch seats on the block top under the blast.
assert.equal(explosions.scorch.mesh.count, 1, 'rocket leaves one scorch');
const matrix = new THREE.Matrix4();
explosions.scorch.mesh.getMatrixAt(0, matrix);
assert.ok(Math.abs(matrix.elements[13] - FLOOR) < 0.05, 'scorch lies on the ground face');
// Removing the supporting block hides the mark within the low-frequency check.
removed.add(key(10, FLOOR - 1, 10));
step(0.3);
assert.equal(explosions.scorch.mesh.count, 0, 'scorch hides once its block is destroyed');

// The blast's own crater: support lost right after the flash re-seats lower,
// at full size, and a ring mark chars the rim on the old surface.
fx.explode({ pid: 'g3', type: 'frag', x: 40.5, y: FLOOR + 0.3, z: 40.5, radius: FRAG_R });
step(0.05);
removed.add(key(40, FLOOR - 1, 40));
step(0.4);
assert.equal(explosions.scorch.mesh.count, 2, 'scorch follows the crater floor and marks its rim');
const pit = explosions.scorch.decals.find((d) => d.active && !d.rim);
const rimMark = explosions.scorch.decals.find((d) => d.active && d.rim);
assert.ok(Math.abs(pit.y - FLOOR + 1) < 0.05, 'crater scorch sits one block lower');
assert.ok(pit.seatSize > pit.size * 0.8, `crater walls do not shrink the pit mark (${pit.seatSize.toFixed(2)} of ${pit.size.toFixed(2)})`);
assert.ok(Math.abs(rimMark.y - FLOOR) < 0.05 && rimMark.hole > 0 && rimMark.hole < 0.9, 'rim mark rings the crater on the old surface');
// Mid-air bursts and energy blasts leave no mark.
fx.explode({ pid: 'g4', type: 'frag', x: 50.5, y: FLOOR + 9, z: 50.5, radius: FRAG_R });
fx.explode({ pid: 'p1', type: 'pulse', x: 60.5, y: FLOOR + 0.3, z: 60.5, radius: GRENADE_TYPES.pulse.damageRadius });
step(0.3);
assert.equal(explosions.scorch.mesh.count, 2, 'no scorch for air bursts or pulse blasts');
step(20);
assert.equal(explosions.scorch.mesh.count, 0, 'scorch fades out after ~20 s');

// Bounded pools under a chaos salvo.
for (let i = 0; i < 200; i++) fx.explode({ pid: `c${i}`, type: 'rocket', x: i + 0.5, y: FLOOR + 0.2, z: 0.5, radius: ROCKET_R });
fx.update(1 / 60);
assert.ok(fx.blasts.length <= BLAST_CAPACITY && explosions.cores.count <= BLAST_CAPACITY);
assert.ok(explosions.scorch.activeCount <= SCORCH_CAPACITY);
assert.equal(lights.length, 4);
assert.ok(lights.every((light) => light.intensity > 0 && light.distance <= 10), 'salvo blasts share the fixed pool');
step(3.5);
assert.equal(fx.blasts.length, 0);
assert.equal(explosions.activeSprites, 0);

// A grenade resting against a thin (one block) wall: the mark keeps its size
// but slides off the wall instead of coming out on the floor behind it.
{
  const wallX = 3;
  const solid = (x, y, z) => {
    const bx = Math.floor(x), by = Math.floor(y);
    return by < FLOOR || (bx === wallX && by < FLOOR + 3);
  };
  const decals = new ScorchDecals(new THREE.Group(), solid);
  const mark = decals.place(wallX - 0.2, FLOOR + 0.25, 0.5, 3.8, 1, 0, 4);
  decals.update(0.2);
  assert.ok(mark.seated && mark.seatSize > 2.6, `wall-side scorch keeps its size (${mark.seatSize.toFixed(2)})`);
  assert.ok(mark.x + mark.seatSize / 2 <= wallX + 1 + 1e-6, 'wall-side scorch does not reach past the thin wall');
  // Drop-offs still cap the reach on a small ledge.
  const table = (x, y, z) => Math.floor(y) === FLOOR && Math.abs(Math.floor(x)) <= 1 && Math.abs(Math.floor(z)) <= 1;
  const ledge = new ScorchDecals(new THREE.Group(), table);
  const onTable = ledge.place(0.5, FLOOR + 1.25, 0.5, 3.8, 1, 0, 4);
  ledge.update(0.2);
  assert.ok(onTable.seated && onTable.seatSize <= 2.2 + 1e-6, 'ledge scorch never hangs over the drop');
  // dispose() releases the instanced matrix buffer via the mesh's dispose event.
  let released = false;
  decals.mesh.addEventListener('dispose', () => { released = true; });
  decals.dispose();
  ledge.dispose();
  assert.ok(released, 'scorch dispose frees its InstancedMesh');
}

// Real terrain damage: the server's crater (ProjectileSystem.explode incl.
// _destroyTerrain) lands before the mark seats, on real maps.
for (const [map, type, x, y, z] of [['dust2', 'frag', 98.5, 15.25, 45.19], ['dust2', 'rocket', 98.5, 15.05, 45.19],
  ['nuketown', 'frag', 53.12, 15.25, 75.6], ['nuketown', 'rocket', 57.444, 16.05, 71.905]]) {
  const world = createMapState(map);
  const gone = new Set();
  const block = (bx, by, bz) => (gone.has(`${bx},${by},${bz}`) ? 0 : world.getBlock(bx, by, bz));
  const events = [];
  const system = new ProjectileSystem();
  const owner = new PlayerEntity('o', 'O', { x: 0, y: 0, z: 0 });
  const ctx = {
    now: 1000, entities: new Map(), dimensions: world.dimensions, canDamage: () => false, getBlock: block,
    destroyBlock: (bx, by, bz) => { if (!block(bx, by, bz)) return false; gone.add(`${bx},${by},${bz}`); return true; },
    pushEvent: (event) => events.push(event), killPlayer() {},
  };
  const projectile = { id: 'p1', type, owner, ownerId: 'o', x, y, z };
  system.active.set('p1', projectile);
  system.explode(projectile, ctx);
  const event = events.find((e) => e.kind === 'projectileExplode');
  assert.ok(event && gone.size > 0, `${map} ${type} digs a crater`);
  const liveFx = new ProjectileFX(new THREE.Scene(), block);
  liveFx.explode(event);
  for (let i = 0; i < 90; i++) liveFx.update(1 / 60);
  const marks = liveFx.explosions.scorch.decals.filter((d) => d.active);
  const floor = marks.find((d) => !d.rim);
  const ring = marks.find((d) => d.rim);
  assert.ok(floor && floor.seatSize >= floor.size * 0.75, `${map} ${type}: the pit mark keeps its size (${floor?.seatSize.toFixed(2)} of ${floor?.size.toFixed(2)})`);
  assert.ok(ring && ring.y > floor.y + 0.9 && ring.seatSize > 2 && ring.hole < 0.9,
    `${map} ${type}: a rim mark chars the old surface (${ring ? `y ${ring.y.toFixed(2)} size ${ring.seatSize.toFixed(2)} hole ${ring.hole.toFixed(2)}` : 'none'})`);
  liveFx.dispose();
}

fx.dispose();
assert.equal(scene.children.length, 0, 'dispose removes every explosion resource');
console.log('ok - blast lights own the fixed pool, fire/smoke linger and drain, scorch seats, follows craters, hides and fades');
