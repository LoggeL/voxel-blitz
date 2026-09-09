import assert from 'node:assert/strict';
import { PlayerEntity } from '../server/sim/player.js';
import { fireOneShot, resolveWeaponIntent } from '../server/sim/combat.js';
import { FlameSystem, updateBurn } from '../server/sim/fire.js';
import { ProjectileSystem } from '../server/sim/projectiles.js';
import { chaosHit } from '../server/sim/chaos-combat.js';
import { CONDITION_RULES, WEAPON_IDS } from '../shared/combatmath.js';
import { POWERUP_RULES } from '../shared/powerups.js';

const spawn = { x: 40.5, y: 20, z: 50.5, index: 0 };
const player = () => new PlayerEntity('target', 'Target', spawn, false);
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-8,
  `${message}: expected ${expected}, received ${actual}`);

{
  const p = player();
  assert.equal(p.armor, 0, 'fresh players have no armor');
  p.armor = 50;
  assert.equal(p.takeDamage(20, true), false);
  assert.equal(p.armor, 30);
  assert.equal(p.hp, 100, 'armor absorbs a complete hit');
  close(p.panic, 20 * CONDITION_RULES.panicDamageGain + CONDITION_RULES.panicHeadshotGain,
    'an armored headshot retains incoming-hit panic');
  close(p.pain, 0, 'fully absorbed headshots cause impact panic without injury pain');
  assert.equal(p.takeDamage(45), false);
  assert.equal(p.armor, 0);
  assert.equal(p.hp, 85, 'only damage beyond remaining armor reaches health');
  assert.equal(p.takeDamage(85), true);
  assert.equal(p.hp, 0);
}

{
  const p = player();
  p.armor = POWERUP_RULES.maxArmor;
  for (let i = 0; i < 4; i++) assert.equal(p.takeDamage(25), false);
  assert.equal(p.armor, 0);
  assert.equal(p.hp, 100, 'separate impacts cannot reuse absorbed armor');
  assert.equal(p.takeDamage(140), true);
  assert.equal(p.hp, 0, 'lethal overflow clamps health to zero');
  p.state = 'dead'; p.armor = 12;
  const before = [p.hp, p.armor, p.panic, p.pain];
  assert.equal(p.takeDamage(20, true), false);
  assert.deepEqual([p.hp, p.armor, p.panic, p.pain], before, 'dead players ignore hits');
  p.applySpawn(spawn);
  assert.deepEqual([p.hp, p.armor, p.panic, p.pain, p.state], [100, 0, 0, 0, 'alive'],
    'respawning starts a fresh unarmored life');
}

for (const damage of [0, -20, NaN, Infinity, -Infinity, undefined, null, '20']) {
  const p = player(); p.armor = 35;
  assert.equal(p.takeDamage(damage, true), false);
  assert.deepEqual([p.hp, p.armor, p.panic, p.pain], [100, 35, 0, 0],
    `invalid damage ${String(damage)} cannot mutate health, armor or conditions`);
}
for (const armor of [NaN, Infinity, -5, undefined]) {
  const p = player(); p.armor = armor;
  assert.equal(p.takeDamage(20), false);
  assert.equal(p.armor, 0);
  assert.equal(p.hp, 80, 'invalid armor cannot prevent health damage');
}
{
  const p = player(); p.armor = POWERUP_RULES.maxArmor + 1000;
  assert.equal(p.takeDamage(POWERUP_RULES.maxArmor + 20), false);
  assert.equal(p.armor, 0);
  assert.equal(p.hp, 80, 'armor above the cap cannot provide additional absorption');
}

function setup(armor) {
  const owner = new PlayerEntity('owner', 'Owner', spawn, false);
  const victim = new PlayerEntity('victim', 'Victim', { ...spawn, z: spawn.z - 3 }, false);
  Object.assign(owner, { yaw: 0, pitch: 0, deployT: 0, input: { wantFire: true } });
  Object.assign(victim, { armor, yaw: Math.PI });
  const events = [], kills = [];
  const projectiles = new ProjectileSystem();
  const ctx = {
    now: 1000, flames: new FlameSystem(), entities: new Map([[owner.id, owner], [victim.id, victim]]),
    blockHp: new Map(), blockMining: new Map(), getBlock: () => 0, solidAt: () => false,
    canFire: () => true, canUseWeapon: () => true, canDamage: () => true,
    computeConeDeg: () => 0, pushEvent: e => events.push(e),
    killPlayer: (v, killer, weapon) => { v.state = 'dead'; kills.push({ victim: v.id, killer, weapon }); },
    launchBolt: (p, dir, charge) => projectiles.launchBolt(p, ctx, dir, charge),
  };
  return { owner, victim, ctx, events, kills, projectiles };
}

const attacks = {
  bullet(s) { s.owner.weapon = WEAPON_IDS.indexOf('rifle'); fireOneShot(s.owner, s.ctx); },
  melee(s) {
    s.owner.weapon = WEAPON_IDS.indexOf('knife'); s.victim.z = s.owner.z - 1.5;
    resolveWeaponIntent(s.owner, 0.02, s.ctx);
  },
  flame(s) {
    s.owner.weapon = WEAPON_IDS.indexOf('flamethrower');
    fireOneShot(s.owner, s.ctx); s.ctx.flames.step(0.6, s.ctx);
  },
  afterburn(s) { attacks.flame(s); updateBurn(s.victim, 1, s.ctx); },
  grenade(s) { s.projectiles.detonateInHand(s.owner, s.ctx); },
  bolt(s) {
    s.owner.weapon = WEAPON_IDS.indexOf('longarc'); fireOneShot(s.owner, s.ctx, 0.1);
    for (let i = 0; i < 10; i++) { s.ctx.now += 20; s.projectiles.step(0.02, s.ctx); }
  },
  chaos(s) {
    s.owner.weapon = WEAPON_IDS.indexOf('rifle'); s.owner.chaosUpgrades = { rifle: 1 };
    chaosHit(s.owner, { id: 'primary' }, [s.victim.x + 1, s.victim.eyeY, s.victim.z], s.ctx);
  },
};
for (const [name, attack] of Object.entries(attacks)) {
  const bare = setup(0), armored = setup(POWERUP_RULES.maxArmor);
  attack(bare); attack(armored);
  const damage = 100 - bare.victim.hp;
  assert.ok(damage > 0 && damage < 100, `${name} reaches a living target through its real damage path`);
  assert.equal(armored.victim.hp, 100, `${name} damage is absorbed before health`);
  close(armored.victim.armor, POWERUP_RULES.maxArmor - damage, `${name} consumes its actual damage in armor`);
  assert.ok(armored.events.some(e => e.kind === 'hit' && e.victim === armored.victim.id),
    `${name} still produces hit feedback`);
  assert.equal(armored.kills.some(k => k.victim === armored.victim.id), false,
    `${name} cannot kill a target whose armor absorbed the impact`);
}
console.log('Armor: absorption, overflow, lethal and repeated hits, headshot feedback, invalid input, cap, death, respawn, and real bullet/melee/flame/burn/grenade/bolt/chaos damage passed.');
