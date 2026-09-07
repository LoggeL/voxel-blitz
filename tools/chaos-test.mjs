import { fireOneShot } from '../server/sim/combat.js';
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { makeSnapshot } from '../server/protocol/snapshot.js';
import { parseBuyFrame } from '../server/protocol/admission.js';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';
import { GRENADE_TYPE_IDS } from '../shared/grenade-rules.js';
import { FLAME_RULES } from '../shared/flame-rules.js';
import { MAP_IDS, isModeMapCompatible, mapForMode } from '../shared/modes.js';
import { CHAOS_UPGRADES, CHAOS_START_CREDITS, CHAOS_KILL_CREDITS, chaosPurchaseId, parseChaosPurchase, chaosWeaponDef } from '../shared/chaos.js';
import { chaosShot, chaosHit } from '../server/sim/chaos-combat.js';

assert.equal(CHAOS_START_CREDITS, 600);
assert.equal(CHAOS_KILL_CREDITS, 300);
// Every selectable weapon and throwable must have a complete upgrade ladder.
assert.deepEqual(Object.keys(CHAOS_UPGRADES).sort(), [...WEAPON_IDS, ...GRENADE_TYPE_IDS].sort());
for (const id of WEAPON_IDS) {
  assert.deepEqual(parseChaosPurchase(`chaos:${id}:1`), { item: id, level: 1 });
  assert.equal(chaosWeaponDef({ chaosUpgrades: {} }, WEAPONS[id]), WEAPONS[id]);
}
assert.equal(Object.values(CHAOS_UPGRADES).flat().length, 45);
for (const rows of Object.values(CHAOS_UPGRADES)) {
  assert.deepEqual(rows.map(r => r.price), [300, 600, 900]);
  assert.equal(new Set(rows.map(r => r.name)).size, 3);
  assert(rows.every(r => r.description.length > 10));
}
for (const map of MAP_IDS) assert.equal(isModeMapCompatible('chaos', map), map !== 'killhouse');
assert.equal(mapForMode('chaos', 'killhouse'), 'foundry');

const engine = new GameEngine({ mode: 'chaos' });
engine.addClient('buyer', 'Buyer'); engine.addClient('target', 'Target');
const buyer = engine.entities.get('buyer'), target = engine.entities.get('target');
const buy = request => engine.mode.purchase(buyer, request);
assert.equal(buyer.credits, 600);
for (const bad of ['chaos:rifle:0', 'chaos:rifle:4', 'chaos:rifle:01', 'chaos:__proto__:1', 'chaos:constructor:1', 'chaos:missing:1', 'chaos:rifle:1:extra', null, {}, 42]) {
  assert.equal(parseChaosPurchase(bad), null);
  assert.equal(parseBuyFrame({ t: 'buy', weapon: bad }), null);
  assert.equal(buy(bad), false);
}
assert.equal(parseBuyFrame({ t: 'buy', weapon: 'chaos:rifle:1', credits: 99999 }), null);
assert.equal(buy('chaos:rifle:2'), false, 'cannot skip tiers');
assert.equal(buy('chaos:rifle:1'), true);
assert.equal(buyer.credits, 300);
assert.equal(buy('chaos:rifle:1'), false, 'duplicate packet cannot purchase next tier');
assert.equal(buy('chaos:rifle:2'), false, 'unaffordable upgrade rejected');
assert.equal(buyer.credits, 300);
engine.killPlayer(target, buyer, 'rifle', false);
assert.equal(buyer.credits, 600);
engine.killPlayer(target, buyer, 'rifle', false);
assert.equal(buyer.credits, 600, 'dead victim cannot pay twice');
assert.equal(buy('chaos:rifle:2'), true);
engine.killPlayer(buyer, buyer, 'rocket', false);
assert.equal(buyer.credits, 0, 'suicide earns nothing');
assert.equal(buy('chaos:smg:1'), false, 'dead player cannot buy');
engine.respawnPlayer(buyer);
assert.equal(buyer.credits, 0);
assert.equal(buyer.chaosUpgrades.rifle, 2, 'upgrades survive death and respawn');
for (const [item, rows] of Object.entries(CHAOS_UPGRADES)) {
  buyer.credits = 16000;
  const start = buyer.chaosUpgrades[item] || 0;
  for (let tier = start; tier < rows.length; tier++) {
    const before = buyer.credits;
    const request = chaosPurchaseId(item, tier);
    assert.equal(parseBuyFrame({ t: 'buy', weapon: request }), request);
    assert.equal(buy(request), true, `${item} tier ${tier + 1} purchasable`);
    assert.equal(buyer.credits, before - rows[tier].price);
    assert.equal(buyer.chaosUpgrades[item], tier + 1);
    assert.equal(buy(request), false, 'stale purchase rejected');
  }
  assert.equal(buy(chaosPurchaseId(item, 3)), false, 'max tier cannot overflow');
}
const boughtUpgrades = { ...buyer.chaosUpgrades }, creditsBeforeRespawn = buyer.credits;
engine.killPlayer(buyer, buyer, 'rocket', false);
engine.respawnPlayer(buyer);
assert.deepEqual(buyer.chaosUpgrades, boughtUpgrades, 'all 45 purchases survive a fresh life');
assert.equal(buyer.credits, creditsBeforeRespawn);
const snapshot = makeSnapshot([buyer], [], [], engine.now, engine.mode.matchSnapshot());
assert.equal(snapshot.match.mode, 'chaos');
assert.deepEqual(snapshot.players[0].chaosUpgrades, buyer.chaosUpgrades);
snapshot.players[0].chaosUpgrades.rifle = 0;
assert.equal(buyer.chaosUpgrades.rifle, 3, 'snapshot does not alias authority state');
const normal = new GameEngine({ mode: 'fun' });
normal.addClient('normal', 'Normal');
const vanilla = normal.entities.get('normal');
assert.equal(normal.mode.purchase(vanilla, 'chaos:shotgun:1'), false);
for (const id of ['minigun', 'flamethrower']) assert.equal(normal.mode.purchase(vanilla, `chaos:${id}:1`), false);
assert.equal(vanilla.chaosUpgrades, undefined);
assert.equal(chaosWeaponDef(vanilla, WEAPONS.shotgun), WEAPONS.shotgun);
assert.equal('chaosUpgrades' in makeSnapshot([vanilla], [], [], normal.now).players[0], false);

// Exercise real effect hooks with deterministic targets instead of random aim.
function shot(item, level, seq) {
  const launches = { bolts: [], rockets: [], blasts: [], flames: [], events: [] };
  const player = { id: 'shooter', x: 20, y: 10, z: 20, eyeY: 11.6, def: WEAPONS[item], shotSeq: seq, chaosUpgrades: { [item]: level } };
  chaosShot(player, { launchBolt: (...a) => launches.bolts.push(a), launchRocket: (...a) => launches.rockets.push(a),
    chaosBlast: (...a) => launches.blasts.push(a), flames: { launch: (...a) => launches.flames.push(a) },
    solidAt: () => false, pushEvent: e => launches.events.push(e) }, { x: 0, y: 0, z: -1 });
  return launches;
}
assert.equal(shot('rifle', 3, 2).bolts.length, 0);
assert.equal(shot('rifle', 3, 3).bolts.length, 1);
assert.equal(shot('smg', 1, 3).bolts.length, 1);
assert.equal(shot('smg', 2, 3).bolts.length, 2);
assert.equal(shot('smg', 3, 6).rockets.length, 1);
assert.equal(shot('shotgun', 2, 1).bolts.length, 3);
assert.equal(shot('shotgun', 3, 1).blasts.length, 1);
assert.equal(shot('sniper', 3, 1).rockets.length, 3);
assert.equal(shot('lmg', 1, 5).rockets.length, 1);
assert.equal(shot('lmg', 2, 3).rockets.length, 1);
assert.equal(shot('lmg', 3, 3).rockets.length, 3);
assert.equal(shot('revolver', 3, 1).bolts.length, 6);
assert.equal(shot('lance', 3, 1).bolts.length, 8);
assert.equal(shot('knife', 1, 1).blasts.length, 1);
assert.equal(shot('knife', 3, 1).bolts.length, 3);
for (let level = 1; level <= 3; level++) {
  const burst = shot('flamethrower', level, 20);
  assert.equal(burst.flames.length, 2, 'higher tiers keep both side jets');
  assert.equal(burst.events.length, 2);
  assert(burst.events.every(e => e.kind === 'shoot' && e.chaosFlame && e.w === 'flamethrower'));
  assert(burst.flames[0][2].x < 0 && burst.flames[1][2].x > 0, 'jets fan to both sides');
  assert.equal(burst.blasts.length, level >= 2 ? 1 : 0);
  assert.equal(burst.rockets.length, level >= 3 ? 1 : 0);
  assert.equal(shot('minigun', level, 20).bolts.length, level === 1 ? 0 : level === 2 ? 3 : 11);
  assert.equal(chaosWeaponDef({ chaosUpgrades: { minigun: level } }, WEAPONS.minigun).pierce.players, 3);
}
assert.equal(shot('flamethrower', 3, 9).blasts.length, 0);
assert.equal(shot('flamethrower', 3, 10).blasts.length, 1);
assert.equal(shot('flamethrower', 3, 10).rockets.length, 0);
assert.equal(shot('minigun', 3, 9).bolts.length, 0);
assert.equal(shot('minigun', 3, 10).bolts.length, 3);
for (const id of WEAPON_IDS) assert.deepEqual(shot(id, 0, 6), { bolts: [], rockets: [], blasts: [], flames: [], events: [] });
for (const [id, count] of [['rifle', 4], ['revolver', 2], ['lance', 4]]) {
  const p = { id: 'shooter', def: WEAPONS[id], chaosUpgrades: { [id]: 2 } };
  const targets = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, state: 'alive', x: i + 1, eyeY: 10, z: 20, vy: 0, hp: 100, takeDamage(n) { this.hp -= n; return false; } }));
  chaosHit(p, {}, [0, 10, 20], { entities: new Map(targets.map(t => [t.id, t])), canDamage: () => true, solidAt: () => false, pushEvent: () => {} });
  assert.equal(targets.filter(t => t.hp < 100).length, count, `${id} arcs to intended number of targets`);
}
console.log('Chaos: 45 purchases, complete weapon catalog, economy, stale requests, death persistence, normal-mode isolation, snapshots and cumulative weapon effects passed.');

// Empty-space projectile fixtures verify explosions and steering without map geometry noise.
function projectileFixture(type, level) {
  const system = new engine.projectiles.constructor();
  const p = { id: 'projectile-owner', x: 20, y: 10, eyeY: 11.6, z: 20, vx: 0, vy: 0, vz: 0,
    yaw: 0, pitch: 0, def: WEAPONS[type === 'bolt' ? 'longarc' : 'rocket'], grenades: [5, 5, 5],
    chaosUpgrades: { [type === 'bolt' ? 'longarc' : type]: level } };
  const events = [];
  const ctx = { now: 0, entities: new Map(), getBlock: () => 0, canDamage: () => true,
    canAffectWorld: () => true, pushEvent: e => events.push(e), destroyBlock: () => {}, damageBlock: () => {}, killPlayer: () => {} };
  const projectile = type === 'rocket' ? system.launchRocket(p, ctx, { x: 0, y: 0, z: -1 })
    : type === 'bolt' ? system.launchBolt(p, ctx, { x: 0, y: 0, z: -1 })
      : system.throw(p, ctx, 0.5, GRENADE_TYPE_IDS.indexOf(type));
  return { system, p, ctx, events, projectile };
}
for (const [type, level, expected] of [['frag', 1, 6], ['frag', 2, 12], ['frag', 3, 12], ['rocket', 3, 6], ['limpet', 2, 5], ['limpet', 3, 5], ['pulse', 3, 8]]) {
  const f = projectileFixture(type, level);
  assert.equal(f.system.explode(f.projectile, f.ctx), true);
  assert.equal(f.system.active.size, expected, `${type} ${level} scatters ${expected} children`);
  const children = [...f.system.active.values()];
  assert(children.every(p => p.child && p.explodeAt > f.ctx.now));
  for (const child of children) f.system.explode(child, f.ctx);
  assert.equal(f.system.active.size, 0, 'children never spawn further generations');
}
for (const type of ['frag', 'limpet', 'pulse', 'rocket']) {
  const f = projectileFixture(type, 0);
  f.system.explode(f.projectile, f.ctx);
  assert.equal(f.system.active.size, 0, 'base projectile has no cluster children');
}
assert.equal(projectileFixture('bolt', 1).projectile.bouncesLeft, 8);
assert.equal(projectileFixture('bolt', 2).system.active.size, 3, 'multiball emits three real bolts');
{
  const f = projectileFixture('rocket', 2);
  assert.equal(f.projectile.chaosHoming, true);
  const target = { id: 'homing-target', state: 'alive', x: 25, y: 10, z: 5 };
  f.ctx.entities.set(target.id, target);
  const speed = Math.hypot(f.projectile.vx, f.projectile.vy, f.projectile.vz);
  f.system._home(f.projectile, 0.1, f.ctx);
  assert(f.projectile.vx > 0, 'homing rocket turns toward off-axis enemy');
  assert(Math.abs(Math.hypot(f.projectile.vx, f.projectile.vy, f.projectile.vz) - speed) < 1e-9);
}
{
  const f = projectileFixture('pulse', 1);
  const target = { id: 'pulled', state: 'alive', x: 24, y: 10, z: 20, vx: 0, vy: 0, vz: 0 };
  f.ctx.entities.set(target.id, target);
  f.system._pull(f.projectile, 0.05, f.ctx);
  assert(target.vx < 0, 'pulse vacuum pulls enemy toward grenade');
  assert(target.impulseSeq > 0, 'vacuum publishes impulse for client reconciliation');
}
{
  const f = projectileFixture('frag', 3);
  for (let i = 0; i < 190; i++) f.system.active.set(`filler${i}`, { type: 'bolt', x: 1000, y: 1000, z: 1000 });
  f.system.explode(f.projectile, f.ctx);
  assert.equal(f.system.active.size, 192, 'cluster fan respects live projectile cap');
}
assert.equal(projectileFixture('bolt', 0).projectile.chaosLevel, 0, 'unupgraded LONGARC must not receive free first tier');
console.log('Chaos projectiles: cluster counts, bounded generations, live cap, multiball, homing steering and vacuum passed.');

// Integration regression: upgraded rails use the piercing branch in fireOneShot.
// Side targets sit outside even the fully charged lance beam radius.
for (const item of ['sniper', 'lance']) for (const mode of ['chaos', 'fun']) {
  const game = new GameEngine({ mode });
  for (const id of ['rail-shooter', 'rail-hit', 'rail-side']) game.addClient(id, id);
  const shooter = game.entities.get('rail-shooter');
  const direct = game.entities.get('rail-hit');
  const side = game.entities.get('rail-side');
  for (const [p, x, z] of [[shooter, 40, 40.5], [direct, 50, 40.5], [side, 50, 43]]) {
    Object.assign(p, { x, y: 15, z, yaw: -Math.PI / 2, pitch: 0, hp: 1000,
      cooldown: 0, bloom: 0, exhaustion: 0, spawnProtected: false, spawnProtectedUntil: 0 });
  }
  shooter.weapon = WEAPON_IDS.indexOf(item);
  if (mode === 'chaos') shooter.chaosUpgrades[item] = 2;
  // Preserve the engine's real damage, explosion and arc hooks; remove terrain
  // and spread only so a target hit is deterministic.
  game.world.getBlock = () => 0;
  game.contexts.combat.computeConeDeg = () => 0;
  game.tickEvents.length = 0;
  fireOneShot(shooter, game.contexts.combat);
  assert(direct.hp < 1000, `${mode} ${item} primary shot hits`);
  if (mode === 'chaos') {
    assert(side.hp < 1000, `${item} secondary effect actually damages off-ray target through fireOneShot`);
    if (item === 'sniper') assert(game.tickEvents.some(e => e.kind === 'projectileExplode'), 'sniper impact produces actual explosion');
    else assert(game.tickEvents.some(e => e.kind === 'hit' && e.victim === side.id), 'lance produces secondary combat events');
  } else {
    assert.equal(side.hp, 1000, `normal ${item} cannot damage off-ray target`);
    assert.equal(game.tickEvents.filter(e => e.kind === 'projectileExplode').length, 0);
  }
}
console.log('Chaos piercing integration: actual sniper explosions and lance arcs damage off-ray targets only in chaos.');

function heavyWeaponFixture(item, level, positions, mode = 'chaos') {
  const game = new GameEngine({ mode });
  game.addClient('heavy-shooter', 'Heavy shooter');
  const shooter = game.entities.get('heavy-shooter');
  const victims = positions.map(([x, z], i) => {
    const id = `heavy-target-${i}`;
    game.addClient(id, id);
    const victim = game.entities.get(id);
    Object.assign(victim, { x, y: 15, z, hp: 1000, spawnProtected: false, spawnProtectedUntil: 0 });
    return victim;
  });
  Object.assign(shooter, { x: 40, y: 15, z: 40.5, yaw: -Math.PI / 2, pitch: 0,
    hp: 1000, cooldown: 0, bloom: 0, exhaustion: 0, spawnProtected: false, spawnProtectedUntil: 0 });
  shooter.weapon = WEAPON_IDS.indexOf(item);
  if (mode === 'chaos') shooter.chaosUpgrades[item] = level;
  game.world.getBlock = () => 0;
  game.contexts.combat.computeConeDeg = () => 0;
  game.tickEvents.length = 0;
  return { game, shooter, victims };
}

// One accepted minigun round reaches exactly three aligned bodies at every
// tier. The base gun stops at the first body and upgraded rounds stop at cover.
for (const level of [0, 1, 2, 3]) {
  const { game, shooter, victims } = heavyWeaponFixture('minigun', level,
    [[47, 40.5], [50, 40.5], [53, 40.5], [56, 40.5]]);
  fireOneShot(shooter, game.contexts.combat);
  assert.equal(victims.filter(v => v.hp < 1000).length, level ? 3 : 1, `minigun tier ${level} body penetration`);
  if (level) {
    const damage = victims.slice(0, 3).map(v => 1000 - v.hp);
    assert(damage[0] > damage[1] && damage[1] > damage[2], 'successive bodies take less damage');
    assert.equal(victims[3].hp, 1000, 'piercing stops at the advertised body limit');
  }
}
{
  const { game, shooter, victims } = heavyWeaponFixture('minigun', 3, [[47, 40.5], [53, 40.5]]);
  game.world.getBlock = x => x === 50 ? 1 : 0;
  fireOneShot(shooter, game.contexts.combat);
  assert(victims[0].hp < 1000);
  assert.equal(victims[1].hp, 1000, 'Chaos minigun body piercing does not grant wall piercing');
}

// Side jets are real packets: they need flight time, burn off-axis targets and
// obey the same wall and friendly-fire checks as the central stream.
for (const mode of ['chaos', 'fun']) for (const level of [1, 2, 3]) {
  const { game, shooter, victims } = heavyWeaponFixture('flamethrower', level,
    [[50, 40.5], [50, 38.5], [50, 42.5]], mode);
  fireOneShot(shooter, game.contexts.combat);
  assert.equal(game.flames.active.length, mode === 'chaos' ? 3 : 1);
  assert(victims.every(v => v.hp === 1000), 'flame upgrades retain travel time');
  game.flames.step(0.6, game.contexts.combat);
  assert(victims[0].hp < 1000, 'center jet still hits');
  for (const side of victims.slice(1)) {
    if (mode === 'chaos') {
      assert(side.hp < 1000, 'side jet damages an off-axis target');
      assert(side.burning > 0, 'side jet applies authoritative afterburn');
      assert.equal(side.burn.owner, shooter);
    } else assert.equal(side.hp, 1000, 'normal flame keeps its base width');
  }
  assert.equal(game.tickEvents.filter(e => e.chaosFlame).length, mode === 'chaos' ? 2 : 0);
}
for (const restriction of ['cover', 'friendly']) {
  const { game, shooter, victims } = heavyWeaponFixture('flamethrower', 3, [[50, 38.5], [50, 42.5]]);
  if (restriction === 'cover') game.world.getBlock = x => x === 45 ? 1 : 0;
  else game.contexts.combat.canDamage = () => false;
  fireOneShot(shooter, game.contexts.combat);
  game.flames.step(0.6, game.contexts.combat);
  assert(victims.every(v => v.hp === 1000 && !v.burn), `${restriction} blocks additional flame damage`);
}

// The two higher flame tiers stack on the jets and route through the real
// explosion/projectile systems, including cover checks and room projectile caps.
for (const level of [1, 2, 3]) {
  const { game, shooter, victims } = heavyWeaponFixture('flamethrower', level, [[46, 43]]);
  shooter.shotSeq = 19;
  fireOneShot(shooter, game.contexts.combat);
  assert.equal(game.flames.active.length, 3);
  assert.equal(game.projectiles.active.size, level === 3 ? 1 : 0);
  assert.equal(game.tickEvents.filter(e => e.kind === 'projectileExplode').length, level >= 2 ? 1 : 0);
  if (level >= 2) {
    assert(victims[0].hp < 1000, 'backdraft deals actual splash damage');
    assert(victims[0].impulseSeq > 0, 'backdraft publishes knockback for reconciliation');
  } else assert.equal(victims[0].hp, 1000, 'first tier cannot use the backdraft');
}
{
  const { game, shooter, victims } = heavyWeaponFixture('flamethrower', 2, [[46, 40.5]]);
  game.world.getBlock = x => x === 43 ? 1 : 0;
  shooter.shotSeq = 9;
  fireOneShot(shooter, game.contexts.combat);
  game.flames.step(0.6, game.contexts.combat);
  assert.equal(victims[0].hp, 1000, 'backdraft cannot start behind the wall blocking the muzzle');
}
for (const level of [2, 3]) {
  const { game, shooter, victims } = heavyWeaponFixture('minigun', level, [[50, 42.5]]);
  shooter.shotSeq = 19;
  fireOneShot(shooter, game.contexts.combat);
  assert.equal(game.projectiles.active.size, level === 3 ? 11 : 3, 'fan and rotor ring create real bounded projectiles');
  assert([...game.projectiles.active.values()].every(p => p.type === 'bolt' && p.owner === shooter));
  for (let i = 0; i < 20; i++) {
    game.now += 25;
    game.projectiles.step(0.025, game.contexts.projectiles);
  }
  assert(victims[0].hp < 1000, 'minigun fan bolts hit targets outside the primary bullet ray');
}
for (const item of ['minigun', 'flamethrower']) {
  const { game, shooter } = heavyWeaponFixture(item, 3, []);
  for (let i = 0; i < 191; i++) game.projectiles.active.set(`cap-${i}`, { type: 'bolt' });
  if (item === 'flamethrower') for (let i = 0; i < FLAME_RULES.maxProjectiles - 1; i++) {
    game.flames.launch(shooter, [40, shooter.eyeY, 40.5], { x: 1, y: 0, z: 0 }, game.contexts.combat);
  }
  shooter.shotSeq = 19;
  fireOneShot(shooter, game.contexts.combat);
  assert.equal(game.projectiles.active.size, 192, `${item} upgrades honor the room projectile cap`);
  if (item === 'flamethrower') {
    assert.equal(game.flames.active.length, FLAME_RULES.maxProjectiles, 'extra jets honor the fire packet cap');
    assert.equal(game.tickEvents.filter(e => e.chaosFlame).length, 0, 'side jets reserve the last available slot for the center stream');
    assert(Math.abs(game.flames.active.at(-1).direction.z) < 1e-9, 'the final available fire packet follows the crosshair');
  }
}
console.log('Chaos heavy weapons: three-body piercing, cumulative salvos, travelling side jets, afterburn, cover, friendly-fire restrictions, backdraft damage and projectile caps passed.');
