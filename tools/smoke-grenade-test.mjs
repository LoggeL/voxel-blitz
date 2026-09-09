import assert from 'node:assert/strict';
import { ProjectileSystem } from '../server/sim/projectiles.js';
import { PlayerEntity } from '../server/sim/player.js';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { makeSnapshot } from '../server/protocol/snapshot.js';
import { GRENADE_TYPE_IDS, freshGrenadeLoadout } from '../shared/grenade-rules.js';
import { SMOKE, smokeBlocksSight, smokeOpticalDepth } from '../shared/smoke-rules.js';
import { fireOneShot } from '../server/sim/combat.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { CombatPostProcess } from '../public/js/engine/combat-post-process.js';
import * as THREE from '../public/js/vendor/three.module.js';

const system = new ProjectileSystem();
const owner = new PlayerEntity('owner', 'Owner', { x: 20.5, y: 1, z: 20.5 });
const victim = new PlayerEntity('victim', 'Victim', { x: 20.5, y: 1, z: 16.5 });
owner.spawnProtectedUntil = victim.spawnProtectedUntil = 0;
const events = [];
const ctx = { now: 0, entities: new Map([[owner.id, owner], [victim.id, victim]]),
  canThrow: () => true, canAffectWorld: () => true, canDamage: () => true,
  getBlock: (_x, y) => y < 1 ? 1 : 0, solidAt: (_x, y) => y < 1,
  pushEvent: e => events.push(e), killPlayer: () => assert.fail('smoke cannot kill'),
  damageBlock: () => assert.fail('smoke cannot carve terrain'),
};
const index = GRENADE_TYPE_IDS.indexOf('smoke');
const projectile = system.throw(owner, ctx, 0.4, index, 9999);
assert(projectile && projectile.explodeAt === 1800, 'fuse starts on release and cannot be cooked');
assert.deepEqual(owner.grenades, freshGrenadeLoadout().map((n, i) => n - (i === index ? 1 : 0)));
for (let i = 0; i < 37; i++) { ctx.now += 50; system.step(0.05, ctx); }
assert.equal(system.active.size, 0, 'thrown canister completes its real flight');
assert.equal(system.smoke.active.size, 1);
assert.equal(victim.hp, 100);
assert.equal(victim.panic, 0, 'smoke has no explosive suppression');
assert.equal(victim.impulseSeq, 0);
assert(events.some(e => e.kind === 'projectileExplode' && e.type === 'smoke'));
const field = [...system.smoke.active.values()][0];
const now = field.createdAt + 1000;
const a = [field.x - 8, field.y, field.z], b = [field.x + 8, field.y, field.z];
assert(smokeBlocksSight([field], a, b, now), 'cloud blocks a crossing sightline');
assert(smokeBlocksSight([field], [field.x, field.y, field.z], b, now), 'inside-to-outside is obscured');
assert(!smokeBlocksSight([field], a, [field.x - 6, field.y, field.z], now), 'foreground is clear');
assert(!smokeBlocksSight([field], a.map((v, i) => v + (i === 1 ? 8 : 0)), b.map((v, i) => v + (i === 1 ? 8 : 0)), now));
assert.equal(smokeOpticalDepth([field], a, b, field.createdAt), 0, 'cloud grows after activation');
assert.equal(smokeOpticalDepth([field], a, b, field.expiresAt), 0, 'expiry is exact');
const wire = makeSnapshot([], [], [], now, undefined, [], [], [], system.smoke.snapshot());
field.radius = 2;
assert.equal(wire.smokeFields[0].radius, 4, 'wire and room do not alias');
ctx.now = field.expiresAt; system.step(0.05, ctx);
assert.equal(system.smoke.active.size, 0);
for (let i = 0; i < SMOKE.maxFields + 3; i++) system.smoke.deploy({ id: i, x: 0, y: 1, z: 0 }, ctx);
assert.equal(system.smoke.active.size, SMOKE.maxFields);
ctx.canAffectWorld = () => false; system.step(0.05, ctx);
assert.equal(system.smoke.active.size, 0, 'round end clears all smoke');

// Held bot targets must be dropped as soon as their sightline is obscured.
const engine = new GameEngine();
const bots = attachBots(engine, 1);
engine.addClient('human', 'Human');
engine.world.getBlock = () => 0;
const bot = engine.entities.get('bot-0'), human = engine.entities.get('human');
Object.assign(bot, { x: 20, y: 5, z: 20, yaw: 0, pitch: 0, spawnProtectedUntil: 0 });
Object.assign(human, { x: 20, y: 5, z: 10, spawnProtectedUntil: 0 });
assert.equal(bots.pickTarget(bot, bots.brains[0]), human);
engine.projectiles.smoke.deploy({ id: 'cover', x: 20, y: 5, z: 15 }, engine.contexts.projectiles);
engine.now += 1000;
assert.equal(bots.pickTarget(bot, bots.brains[0]), null, 'smoke clears cached enemy lock');
assert.equal(bots.brains[0].enemyId, null);
// It is concealment: shots still hit when fired through the obscured line.
bot.weapon = WEAPON_IDS.indexOf('sniper');
fireOneShot(bot, { ...engine.contexts.combat, computeConeDeg: () => 0 });
assert(human.hp < 100, 'smoke never stops bullets');
bots.dispose(); engine.stop();

const renderer = { renders: 0, setRenderTarget() {}, render() { this.renders++; } };
const post = new CombatPostProcess(renderer, { enabled: false });
const camera = new THREE.PerspectiveCamera();
post.render(new THREE.Scene(), camera, { smokeFields: wire.smokeFields, smokeNow: now });
assert.equal(renderer.renders, 2, 'disabling the optional grade cannot remove tactical smoke');
assert.equal(post.uniforms.grading.value, 0);
assert.equal(post.uniforms.smokeCount.value, 1);
post.dispose();
console.log('Smoke grenades: flight, inventory, visibility, bots, bullet passage, wire isolation, expiry, cleanup and shader-off rendering passed.');
