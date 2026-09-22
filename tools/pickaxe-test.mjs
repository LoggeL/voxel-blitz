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
const swingModule = await import('../public/js/guns/pickaxe-swing.js');
const { pickaxeSwingPose, pickaxeChopPitch, PICKAXE_SWING_SECONDS, PICKAXE_LIFT_AT, PICKAXE_STRIKE_AT,
  PICKAXE_IMPACT_AT, PICKAXE_CARRY_PITCH, PICKAXE_CARRY_YAW, PICKAXE_CARRY_ROLL, PICKAXE_CARRY_OFFSET } = swingModule;
const { HANDS, TIMERS } = await import('../public/js/guns/defs.js');
// Gun-local point -> content-parent space under one pose (content Euler 'XYZ').
const place = (pose, [x, y, z]) => new THREE.Vector3(x, y, z)
  .applyEuler(new THREE.Euler(pose.rx, pose.ry, pose.rz, 'XYZ')).add(new THREE.Vector3(pose.x, pose.y, pose.z));
const grip = [HANDS.knife.grip.x, HANDS.knife.grip.y, HANDS.knife.grip.z];
const tip = TIMERS.knife.muzzle;
assert.ok(0 < PICKAXE_LIFT_AT && PICKAXE_LIFT_AT < PICKAXE_STRIKE_AT && PICKAXE_STRIKE_AT < PICKAXE_IMPACT_AT
  && PICKAXE_IMPACT_AT < 1, 'phase keys run anticipate -> strike -> impact -> recover');
assert.ok(PICKAXE_SWING_SECONDS < 60 / WEAPONS.knife.rpm && PICKAXE_STRIKE_AT * PICKAXE_SWING_SECONDS < 0.16,
  'a snappy strike and full recovery fit inside the 120 rpm cadence');
const rest = pickaxeSwingPose(0), lift = pickaxeSwingPose(PICKAXE_LIFT_AT);
const strike = pickaxeSwingPose(PICKAXE_STRIKE_AT), impact = pickaxeSwingPose(PICKAXE_IMPACT_AT);
assert.deepEqual(rest, pickaxeSwingPose(1), 'the swing starts and ends in the settled carry');
assert.ok(Math.abs(rest.rx - PICKAXE_CARRY_PITCH) < 1e-9 && Math.abs(rest.ry - PICKAXE_CARRY_YAW) < 1e-9
  && Math.abs(rest.rz - PICKAXE_CARRY_ROLL) < 1e-9
  && [rest.x, rest.y, rest.z].every((v, i) => Math.abs(v - PICKAXE_CARRY_OFFSET[i]) < 1e-12),
'the carry is the diagonal right-hand hold on its own seat');
assert.ok(PICKAXE_CARRY_OFFSET[0] > 0 && PICKAXE_CARRY_OFFSET[2] < 0, 'the pick sits further out and right than a gun');
assert.ok(PICKAXE_CARRY_YAW > 0.4, 'the carry turns the extruded sprite face toward the eye');
const restTip = place(rest, tip), liftTip = place(lift, tip), strikeTip = place(strike, tip), impactTip = place(impact, tip);
assert.ok(liftTip.y > restTip.y + 0.04, 'anticipation cocks the head up');
assert.ok(strikeTip.y < restTip.y - 0.15 && impactTip.y < strikeTip.y, 'the chop drives the head down through impact');
const { HIP } = await import('../public/js/guns/models/common.js');
const screenX = (v) => (v.x + HIP.x) / -(v.z + HIP.z);
assert.ok(screenX(strikeTip) < screenX(restTip) - 0.06, 'the chop comes inward toward the aim line');
// Narrow screens: desktop framing is untouched; a portrait phone pulls the fist on-screen and shrinks the item about it.
const wide = pickaxeSwingPose(0, false, {}, 2), tall = pickaxeSwingPose(0, false, {}, 390 / 844);
const fistNdc = (pose, aspect) => { const v = place(pose, grip).sub(new THREE.Vector3(pose.x, pose.y, pose.z))
  .multiplyScalar(pose.s).add(new THREE.Vector3(pose.x + HIP.x, pose.y + HIP.y, pose.z + HIP.z));
return v.x / (-v.z * Math.tan(37.5 * Math.PI / 180) * aspect); };
assert.ok(wide.s === 1 && ['x', 'y', 'z', 'rx', 'ry', 'rz'].every((k) => wide[k] === rest[k])
  && tall.s < 0.5 && fistNdc(tall, 390 / 844) > 0.3 && fistNdc(tall, 390 / 844) < 0.75 && fistNdc(wide, 2) < 0.8,
'portrait framing keeps the fist in the lower-right quadrant');
// The fist is the pivot: grip travels only by the arm drift, never by the rotation itself.
const restGrip = place(rest, grip);
for (const t of [PICKAXE_LIFT_AT, PICKAXE_STRIKE_AT, PICKAXE_IMPACT_AT, 0.7]) {
  const drift = swingModule.pickaxeSwingChannels(t);
  const moved = place(pickaxeSwingPose(t), grip).sub(restGrip);
  assert.ok(moved.distanceTo(new THREE.Vector3(drift.x, drift.y, drift.z)) < 1e-9,
    `the chop pivots about HANDS.knife.grip at ${t}`);
}
assert.ok(pickaxeChopPitch(PICKAXE_LIFT_AT * PICKAXE_SWING_SECONDS) > 0.4
  && pickaxeChopPitch(PICKAXE_STRIKE_AT * PICKAXE_SWING_SECONDS) < -0.8
  && pickaxeChopPitch(null) === 0 && pickaxeChopPitch(PICKAXE_SWING_SECONDS) === 0,
'third person raises overhead, chops down, and rests outside the swing');
const { ImpactFX, MINE_HIT_PARTICLES, MINE_BREAK_PARTICLES, CRIT_STARS, BACKSTAB_STARS } =
  await import('../public/js/weapons/impacts.js');
const scene = new THREE.Scene();
const fx = new ImpactFX(scene, new THREE.PerspectiveCamera(), () => 3);
const event = { x: 0, y: 2, z: 0, nx: 0, ny: 0, nz: 1, from: 3, progress: 0.2 };
fx.mine(event);
assert.equal(fx.particlesSpawned, MINE_HIT_PARTICLES, 'accepted mining strike chips the face');
for (let i = 0; i < MINE_HIT_PARTICLES; i++) {
  const chip = fx.parts[i];
  assert.ok(chip.blocky && chip.spinX === 0 && chip.rx === 0 && Math.abs(chip.z - 1.03) < 1e-9,
    'dig chips are unspun block squares on the struck face');
}
const { removedDamageCells } = await import('../public/js/engine/block-damage-geometry.js');
const cells = removedDamageCells(0, 2, 0, 0, 0.2);
fx.chipBlock({ ...event, v: 3, previousProgress: 0 });
assert.equal(fx.particlesSpawned, MINE_HIT_PARTICLES + cells.length, 'every lost voxel piece emits a shard');
for (let i = 0; i < cells.length; i++) {
  const particle = fx.parts[MINE_HIT_PARTICLES + i];
  assert.deepEqual([particle.x, particle.y - 2, particle.z], cells[i],
    'shards start in the cells removed from the block mesh');
}
const spawned = fx.particlesSpawned;
fx.chipBlock({ ...event, v: 3, previousProgress: 0.2 });
fx.chipBlock({ ...event, v: 10, previousProgress: 0 });
assert.equal(fx.particlesSpawned, spawned, 'no duplicate stage chips or stale material debris');
fx.update(2);
assert.equal(fx.parts.filter(p => p.active).length, 0, 'transient debris expires');
{
  // The break fills the block volume and the chips settle on the floor below.
  const floor = new ImpactFX(new THREE.Scene(), new THREE.PerspectiveCamera(), (x, y) => (y <= 1 ? 3 : 0));
  floor.mine({ ...event, progress: 1 });
  assert.equal(floor.particlesSpawned, MINE_BREAK_PARTICLES, 'the break is a bigger burst');
  const chips = floor.parts.filter(p => p.active);
  assert.ok(chips.every(p => p.blocky && p.x > 0 && p.x < 1 && p.y > 2 && p.y < 3 && p.z > 0 && p.z < 1),
    'break chips start inside the broken block');
  const shade = chips.map(p => [p.colR, p.colG, p.colB].join());
  for (let i = 0; i < 40; i++) floor.update(1 / 60);
  assert.ok(chips.every(p => !p.active || p.y >= 2.04 - 1e-9), 'chips come to rest on the floor');
  assert.deepEqual(chips.map(p => [p.colR, p.colG, p.colB].join()), shade, 'chips keep their shade');
  floor.dispose();
}
{
  // Ceiling dig: chips that pop up into the ceiling block drop back down instead
  // of being lifted onto its top face; walls never lift sideways chips either.
  const cave = new ImpactFX(new THREE.Scene(), new THREE.PerspectiveCamera(),
    (x, y) => (y >= 3 || y <= 0 || x >= 2 ? 3 : 0));
  cave.mine({ x: 0, y: 3, z: 0, nx: 0, ny: -1, nz: 0, from: 3, progress: 0.4 });
  cave.mine({ x: 2, y: 1, z: 0, nx: -1, ny: 0, nz: 0, from: 3, progress: 1 });
  const chips = cave.parts.filter(p => p.active);
  let peak = -Infinity;
  for (let i = 0; i < 60; i++) {
    cave.update(1 / 60);
    for (const p of chips) if (p.active) peak = Math.max(peak, p.y);
  }
  assert.ok(peak < 3, `no chip is teleported onto the ceiling or a wall top (${peak.toFixed(2)})`);
  assert.ok(chips.every(p => !p.active || (p.y >= 1.04 - 1e-9 && p.x < 2)), 'chips stay in the open cave');
  cave.dispose();
}
fx.meleeHit({ vx: 0, vy: 1.4, vz: 0 }, 'strong');
assert.equal(fx.starsSpawned, 0, 'a plain hit has no crit sparkle');
fx.meleeHit({ vx: 0, vy: 1.4, vz: 0 }, 'crit');
assert.equal(fx.starsSpawned, CRIT_STARS, 'a falling crit bursts pixel stars');
fx.meleeHit({ vx: 0, vy: 1.4, vz: 0 }, 'backstab');
assert.equal(fx.starsSpawned, CRIT_STARS + BACKSTAB_STARS);
fx.update(0.1);
assert.ok(fx.stars.filter(s => s.active).every(s => Number.isFinite(s.x) && s.y > 0));
fx.update(2);
assert.equal(fx.stars.filter(s => s.active).length, 0, 'crit stars expire');
fx.dispose(); assert.equal(scene.children.length, 0);
console.log('Pickaxe presentation: keyed diagonal chop about the fist, block chips, crit stars and cleanup passed.');

// Contact rebounds the head up after the chop; missed swings keep their follow-through.
for (let i = 0; i <= 100; i++) {
  const t = i / 100;
  assert.ok(Object.values(pickaxeSwingPose(t, true)).every(Number.isFinite));
  assert.ok(Object.values(pickaxeSwingPose(t, 0.05)).every(Number.isFinite));
}
const bounce = PICKAXE_IMPACT_AT + 0.08;
assert.ok(place(pickaxeSwingPose(bounce, true), tip).y > place(pickaxeSwingPose(bounce), tip).y + 0.02,
  'an accepted contact kicks the head back up');
assert.deepEqual(pickaxeSwingPose(PICKAXE_STRIKE_AT, true), pickaxeSwingPose(PICKAXE_STRIKE_AT),
  'no rebound before the head reaches the target');
assert.deepEqual(pickaxeSwingPose(1, true), pickaxeSwingPose(1));
assert.deepEqual(pickaxeSwingPose(0.99, 0.95), pickaxeSwingPose(0.99), 'a very late contact cannot jolt the settle');
const { ViewmodelRig } = await import('../public/js/guns/viewmodel.js');
// A 2:1 desktop view: narrow screens add a framing roll on top of the carry.
const rig = new ViewmodelRig(new THREE.PerspectiveCamera(75, 2));
rig.setWeapon('knife');
for (let i = 0; i < 180; i++) rig.update(1 / 60, { grounded: true });
const carried = rig.content.rotation.toArray().slice(0, 3);
assert.ok(Math.abs(carried[1] - PICKAXE_CARRY_YAW) < 1e-6 && Math.abs(carried[2] - PICKAXE_CARRY_ROLL) < 1e-6,
  'the settled pick rides in the keyed carry');
assert.equal(rig.fire(), true);
rig.update(0.05, { grounded: true });
rig.pickaxeContact();
assert.ok(rig._swingContact > 0.1 && rig._swingContact < 0.2, 'contact records the swing phase it arrived at');
rig.setWeapon('rifle'); rig.pickaxeContact();
assert.equal(rig._swingContact, false, 'swapping clears contact recoil');
// Quick melee pulls the pick in from below, stows it, then the gun rises back.
for (let i = 0; i < 180; i++) rig.update(1 / 60, { grounded: true });
const gunY = rig.content.position.y;
assert.equal(rig.quickMelee(), true);
rig.update(0.01, { grounded: true });
const pulledIn = rig.content.position.y;
for (let i = 0; i < 6; i++) rig.update(0.01, { grounded: true });
assert.ok(rig._id === 'knife' && pulledIn < rig.content.position.y - 0.1, 'the quick pick pulls in from below');
for (let i = 0; i < 60; i++) rig.update(0.01, { grounded: true });
assert.equal(rig._id, 'rifle');
assert.ok(rig._quickReturnT > 0 && rig.content.position.y < gunY - 0.01, 'the returning gun rises');
for (let i = 0; i < 30; i++) rig.update(0.01, { grounded: true });
assert.ok(Math.abs(rig.content.position.y - gunY) < 1e-3, 'and settles exactly where it was');
assert.equal(rig.fire(), true, 'the return rise never gates fire');
// V with the pick already drawn is one plain swing: no pull-in dip, no stow, no rise.
rig.setWeapon('knife');
for (let i = 0; i < 180; i++) rig.update(1 / 60, { grounded: true });
const pickY = rig.content.position.y;
assert.equal(rig.quickMelee(), true);
assert.ok(rig._quickMelee === null && rig._id === 'knife', 'a drawn pick never starts a quick-melee swap');
rig.update(0.01, { grounded: true });
assert.ok(rig.content.position.y > pickY - 0.1, 'the held pick does not dip out of view');
for (let i = 0; i < 60; i++) rig.update(0.01, { grounded: true });
assert.ok(rig._id === 'knife' && rig._quickReturnT === 0, 'and never replays the raise');
rig.dispose();
const materialFx = new ImpactFX(new THREE.Scene(), new THREE.PerspectiveCamera());
materialFx.mine({ ...event, from: 8 });
assert.equal(materialFx.particlesSpawned, MINE_HIT_PARTICLES + 2, 'metal chips include two contact glints');
assert.equal(materialFx.parts[MINE_HIT_PARTICLES].glint, true);
materialFx.dispose();

// Pickaxe player hits: attack cue by kind, stars, rebound and the heavy hitmarker.
{
  const { CombatFeedback } = await import('../public/js/combat/feedback.js');
  const calls = [];
  const log = (name) => (...args) => calls.push({ name, args });
  const feedback = new CombatFeedback({
    effects: { impact: log('impact'), gore: log('gore'), impacts: { meleeHit: log('stars') } },
    sfx: { pain: log('pain'), hitmark: log('hitmark'), meleeHit: log('meleeHit') },
    hud: { hitmark: log('hud.hitmark'), gameplay: { meleeHitmark: log('meleeHitmark') } },
    roster: { hit: log('roster.hit') }, player: { alive: true },
    getMyId: () => 'self', getPlayersCache: () => [], getSelfRow: () => null, isRunning: () => true,
    camera: null, world: null, respawnLocal() {}, onLocalDeath() {}, onLocalMine() {},
    onLocalMeleeHit: log('rebound'), onLocalFlinch() {},
  });
  feedback.isImpactVisible = () => true;
  feedback.spawnDamageNumber = () => {};
  feedback.applyLocalHit = () => {};
  const hit = { kind: 'hit', attacker: 'self', victim: 'other', dmg: 87, hs: false, vx: 1, vy: 1.4, vz: 2,
    healthDamage: 87, w: 'knife', mk: 'crit', q: 0 };
  feedback.handleEvent(hit);
  const named = (name) => calls.filter(c => c.name === name);
  assert.deepEqual(named('meleeHit')[0].args[0], { kind: 'crit', pos: [1, 1.4, 2], local: true });
  assert.equal(named('stars')[0].args[1], 'crit');
  assert.equal(named('rebound').length, 1, 'the attacker\'s pick rebounds on a player hit');
  assert.deepEqual(named('meleeHitmark')[0].args, ['crit']);
  calls.length = 0;
  feedback.handleEvent({ ...hit, mk: 'strong', healthDamage: 0 });
  assert.equal(named('meleeHit')[0].args[0].kind, 'armor', 'a fully absorbed swing clanks on armor');
  calls.length = 0;
  feedback.handleEvent({ ...hit, attacker: 'other', victim: 'third', mk: 'backstab' });
  assert.deepEqual(named('meleeHit')[0].args[0], { kind: 'backstab', pos: [1, 1.4, 2], local: false });
  assert.equal(named('rebound').length + named('meleeHitmark').length, 0, 'bystanders get no rebound or mark');
  calls.length = 0;
  feedback.handleEvent({ ...hit, attacker: 'other', victim: 'self', mk: 'knockback' });
  assert.equal(named('meleeHit')[0].args[0].local, true, 'the local victim hears the hit up close');
  assert.equal(named('stars').length, 0, 'no particles in the victim\'s own eyes');
  calls.length = 0;
  feedback.handleEvent({ ...hit, w: 'rifle' });
  assert.equal(named('meleeHit').length, 0, 'gun hits never play a pickaxe cue');
  const { mk, ...legacy } = hit;
  calls.length = 0;
  feedback.handleEvent(legacy);
  assert.equal(named('meleeHit')[0].args[0].kind, 'strong', 'an untagged melee hit is a strong hit');
}
{
  // The local victim hears one contact: the attack cue voices a pick hit, so the
  // generic flesh/metal impact only plays for other weapons.
  const { CombatFeedback } = await import('../public/js/combat/feedback.js');
  const calls = [];
  const log = (name) => (...args) => calls.push({ name, args });
  let hit = null;
  const feedback = new CombatFeedback({
    effects: { impact: log('fx.impact'), gore: log('gore'), impacts: { meleeHit() {} } },
    sfx: { pain: log('pain'), hitmark() {}, meleeHit: log('meleeHit'), impact: log('impact') },
    hud: { hitmark() {}, setPainImpulse: log('painImpulse') },
    roster: { hit() {} }, player: { alive: true, applyHit: () => hit },
    getMyId: () => 'self', getPlayersCache: () => [], getSelfRow: () => null, isRunning: () => true,
    camera: null, world: null, respawnLocal() {}, onLocalDeath() {}, onLocalMine() {},
    onLocalMeleeHit() {}, onLocalFlinch() {},
  });
  const impacts = () => calls.filter(c => c.name === 'impact').map(c => c.args[0]);
  const ev = { kind: 'hit', attacker: 'other', victim: 'self', dmg: 46, hs: false, vx: 1, vy: 1.4, vz: 2,
    healthDamage: 46, w: 'knife', mk: 'strong', q: 0 };
  hit = { damage: 46, healthDamage: 46, painImpulse: 0.5 };
  feedback.handleEvent(ev);
  assert.deepEqual(impacts(), [], 'a pick hit on the local player plays no generic flesh impact');
  assert.equal(calls.filter(c => c.name === 'meleeHit').length, 1);
  assert.equal(calls.filter(c => c.name === 'pain').length, 1, 'the local pain voice stays');
  calls.length = 0;
  hit = { damage: 46, healthDamage: 0, painImpulse: 0.2 };
  feedback.handleEvent({ ...ev, healthDamage: 0 });
  assert.deepEqual(impacts(), [], 'the armor clank is the attack cue alone');
  calls.length = 0;
  hit = { damage: 30, healthDamage: 30, painImpulse: 0.4 };
  feedback.handleEvent({ ...ev, w: 'rifle', mk: undefined, dmg: 30, healthDamage: 30 });
  assert.deepEqual(impacts(), ['flesh'], 'a gun hit still plays its flesh impact');
  calls.length = 0;
  hit = { damage: 30, healthDamage: 0, painImpulse: 0.2 };
  feedback.handleEvent({ ...ev, w: 'rifle', mk: undefined, dmg: 30, healthDamage: 0 });
  assert.deepEqual(impacts(), ['metal']);
}
{
  // A pick break throws only its block-chip shower: the following authoritative
  // block mutation adds no grenade shards and no second break sound.
  const { CombatFeedback } = await import('../public/js/combat/feedback.js');
  const calls = [];
  const log = (name) => (...args) => calls.push({ name, args });
  const cells = new Map();
  const world = { getBlock: (x, y, z) => cells.get(`${x},${y},${z}`) ?? 3,
    setBlock: (x, y, z, v) => cells.set(`${x},${y},${z}`, v), applyDeltas() {} };
  const feedback = new CombatFeedback({
    effects: { explodeBlock: log('explode'), impacts: { mine: log('mine'), chipBlock() {} } },
    sfx: { mine: log('sfx.mine'), impact: log('impact') },
    hud: {}, roster: {}, player: { alive: true },
    getMyId: () => 'self', getPlayersCache: () => [], getSelfRow: () => null, isRunning: () => true,
    camera: null, world, respawnLocal() {}, onLocalDeath() {}, onLocalMine() {},
    onLocalMeleeHit() {}, onLocalFlinch() {},
  });
  feedback.handleEvent({ kind: 'mine', id: 'other', x: 4, y: 5, z: 6, from: 3, progress: 1 });
  feedback.handleEvent({ kind: 'block', x: 4, y: 5, z: 6, v: 0, from: 3 });
  assert.equal(calls.filter(c => c.name === 'explode' || c.name === 'impact').length, 0,
    'a pick break adds no grenade shards or duplicate break sound');
  feedback.handleEvent({ kind: 'block', x: 7, y: 5, z: 6, v: 0, from: 3 });
  assert.deepEqual(calls.filter(c => c.name === 'explode').map(c => c.args.slice(0, 3)), [[7, 5, 6]],
    'other block breaks still explode');
}
console.log('Pickaxe contact: phase-aware rebound, quick-melee pull-in/stow/return, swap reset, drawn-pick V, material glints, melee hit feedback, single local contact and break dedupe passed.');
