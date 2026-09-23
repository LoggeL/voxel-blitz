import assert from 'node:assert/strict';
import { PlayerEntity } from '../server/sim/player.js';
import { fireOneShot, resolveWeaponIntent } from '../server/sim/combat.js';
import { ProjectileSystem } from '../server/sim/projectiles.js';
import { MOVEMENT_RULES } from '../shared/player-movement.js';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';
import { COMBAT_DAMAGE_SCALE, combatDamage } from '../shared/combat-balance.js';
import { CHAOS_UPGRADES } from '../shared/chaos.js';
import { GUN_GAME_WEAPON_ORDER, WEAPON_PRICES, DEFAULT_WEAPON_ID } from '../shared/modes.js';
import { AIR, BLOCK_HP, CONCRETE, GROUND, METAL, SX, SY, SZ } from '../shared/worlddata.js';
import { TICK_MS } from '../server/protocol/admission.js';
import {
  BUBBLE_RULES,
  bubbleAimDrop,
  bubbleBlastRules,
  bubbleFlight,
  bubbleLaunch,
  bubbleMaxRange,
  bubbleMix,
  bubbleProfile,
  stepBubble,
} from '../shared/bubble-rules.js';
import { stepBubble as clientStepBubble } from '../shared/bubble-rules.js?client';

// SB-1 SUDSBLASTER: the shared flight/blast rules, the authoritative launch, pop, soak,
// cap, owner-chain, bullet-pop and Chaos ladder paths, and the bot trigger policy.

const SLOT = WEAPON_IDS.indexOf('bubble');
const RIFLE = WEAPON_IDS.indexOf('rifle');
const STONE = Number(Object.keys(BLOCK_HP).find((id) => Number(id) !== AIR && BLOCK_HP[id] > 0));
const spawn = { x: 40.5, y: 20, z: 50.5, index: 0 };
const DT = 0.05;
const close = (actual, expected, message, eps = 1e-6) => assert.ok(Math.abs(actual - expected) <= eps,
  `${message}: expected ${expected}, received ${actual}`);
const none = () => null;

// ---- 1. Identity -----------------------------------------------------------------------
assert.equal(SLOT, 13, 'the SUDSBLASTER is appended as slot 13');
assert.equal(WEAPONS.bubble.mode, 'charge');
assert.equal(WEAPONS.bubble.projectile, 'bubble');
assert.equal(WEAPON_PRICES.bubble, 2200);
assert.equal(GUN_GAME_WEAPON_ORDER[GUN_GAME_WEAPON_ORDER.indexOf('glaive') + 1], 'bubble');
assert.equal(CHAOS_UPGRADES.bubble.length, 3);
assert.ok(STONE > 0, 'a damageable block type exists for wall contacts');

// ---- 2. Profiles -----------------------------------------------------------------------
{
  const { mix: mix0, ...small } = bubbleProfile(0);
  const { mix: mix1, ...big } = bubbleProfile(1);
  assert.deepEqual(small, { ...BUBBLE_RULES.small }, 'charge 0 is the Soap Shot endpoint');
  assert.deepEqual(big, { ...BUBBLE_RULES.big }, 'charge 1 is the Big Bubble endpoint');
  assert.equal(mix0, 0);
  assert.equal(mix1, 1);
  assert.equal(bubbleProfile(0.5).mix, 0.25, 'the charge curve is quadratic');
  assert.equal(bubbleMix(2), 1, 'charge clamps');
  const child = bubbleProfile(0, true);
  assert.equal(child.radius, BUBBLE_RULES.foam.radius, 'child profile is the Foam-party mini');
  const blast = bubbleBlastRules(bubbleProfile(0));
  assert.equal(blast.terrainRadius, 0, 'bubbles never carve terrain');
  assert.equal(blast.selfDamage, 0, 'bubbles never hurt their owner');
  // Display damage must not divide by zero (damage[2] > falloffStart).
  assert.ok(WEAPONS.bubble.damage[2] > WEAPONS.bubble.falloffStart);
  // The 3-tap contract: direct + splash of a Soap Shot, scaled, times three kills.
  const tap = combatDamage(BUBBLE_RULES.small.directDamage + BUBBLE_RULES.small.splashDamage);
  close(tap, 42 * COMBAT_DAMAGE_SCALE, 'Soap Shot direct effective damage', 1e-9);
  assert.ok(3 * tap >= 100 && 2 * tap < 100, 'three direct Soap Shots kill, two do not');
}

// ---- 3. Exact integrator ----------------------------------------------------------------
{
  const launch = () => bubbleLaunch({ x: 0, y: 10, z: 0, dir: { x: 0, y: 0, z: -1 } });
  const stepped = launch();
  for (let i = 0; i < 132; i++) stepBubble(stepped, 1 / 60, none);
  const once = launch();
  stepBubble(once, 2.2, none);
  for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz']) {
    close(stepped[key], once[key], `132 x 1/60 s equals one 2.2 s step (${key})`, 1e-9);
  }
  // Server and client import the same module: bit-identical over 120 steps.
  const a = launch(), b = launch();
  for (let i = 0; i < 120; i++) { stepBubble(a, 1 / 60, none); clientStepBubble(b, 1 / 60, none); }
  assert.deepEqual([a.x, a.y, a.z, a.vy], [b.x, b.y, b.z, b.vy], 'server and client steps agree bit for bit');
}

// ---- 4. Rise, 5. reach ------------------------------------------------------------------
{
  const b = bubbleLaunch({ x: 0, y: 10, z: 0, dir: { x: 0, y: 0, z: -1 } });
  const startY = b.y;
  let lastVy = b.vy;
  for (let i = 0; i < 60; i++) {
    stepBubble(b, 1 / 60, none);
    assert.ok(b.vy >= lastVy - 1e-12, 'a level tap never descends');
    lastVy = b.vy;
  }
  assert.ok(b.y > startY + 1.0, `a tap rises more than 1 m in the first second (${b.y - startY})`);
  assert.ok(bubbleMaxRange(bubbleProfile(0)) <= 18.6, 'Soap Shot reach caps near 18.6 m');
  assert.ok(bubbleMaxRange(bubbleProfile(1)) <= 12.85, 'Big Bubble reach caps near 12.8 m');
  assert.equal(bubbleFlight(bubbleProfile(0), 30), null, 'nothing reaches 30 m');
  assert.equal(bubbleAimDrop(bubbleProfile(0), 30), null);
  const ten = bubbleFlight(bubbleProfile(0), 10);
  close(ten.t, 0.49, 'Soap Shot reaches 10 m in ~0.49 s', 0.01);
  close(ten.rise, 0.36, 'and rises ~0.36 m', 0.01);
}

// ---- 6. Point-blank wall clamp ------------------------------------------------------------
{
  const wallZ = -0.3;
  const raycast = (ox, oy, oz, dx, dy, dz, max) => {
    if (dz >= 0) return null;
    const t = (wallZ - oz) / dz;
    return t >= 0 && t <= max ? { t, x: 0, y: 0, z: -1, nx: 0, ny: 0, nz: 1 } : null;
  };
  const l = bubbleLaunch({ x: 0, y: 10, z: 0, dir: { x: 0, y: 0, z: -1 }, raycast });
  assert.equal(l.blocked, true, 'a hugged wall blocks the launch');
  assert.ok(l.z - wallZ >= l.radius - 1e-9, 'the clamped spawn stays one radius off the wall');
}

// ---- 7. Soak speed ------------------------------------------------------------------------
assert.equal(BUBBLE_RULES.soakSpeedMult, MOVEMENT_RULES.concussedSpeedMult, 'soak prediction matches the server slow');

// ---- Harness ------------------------------------------------------------------------------
function harness({ solid = () => false, canDamage = (a, b) => a !== b, grenadeDamage = true } = {}) {
  const owner = new PlayerEntity('owner', 'Owner', spawn, false);
  Object.assign(owner, { yaw: 0, pitch: 0, deployT: 0, weapon: SLOT, cooldown: 0 });
  const events = [], kills = [], blockHits = [], destroyed = [];
  const projectiles = new ProjectileSystem();
  const world = { solid };
  const getBlock = (x, y, z) => (world.solid(Math.floor(x), Math.floor(y), Math.floor(z)) ? STONE : AIR);
  const pctx = {
    now: 1000,
    entities: new Map([[owner.id, owner]]),
    solidAt: (x, y, z) => getBlock(x, y, z) !== AIR,
    getBlock,
    get grenadeDamage() { return grenadeDamage; },
    canAffectWorld: () => true,
    canDamage,
    canThrow: () => true,
    pushEvent: (event) => events.push({ ...event, at: pctx.now }),
    killPlayer: (victim, killer, weapon, hs) => {
      victim.state = 'dead';
      kills.push({ victim: victim.id, killer: killer?.id, weapon, hs });
    },
    damageBlock: (x, y, z, type, damage) => blockHits.push({ x, y, z, type, damage }),
    destroyBlock: (x, y, z) => { destroyed.push([x, y, z]); return false; },
  };
  const combat = {
    get now() { return pctx.now; },
    get entities() { return pctx.entities; },
    solidAt: pctx.solidAt,
    getBlock,
    blockHp: new Map(),
    canFire: () => true,
    canUseWeapon: () => true,
    canDamage,
    computeConeDeg: () => 0,
    pushEvent: pctx.pushEvent,
    killPlayer: pctx.killPlayer,
    launchBubble: (p, dir, charge) => projectiles.launchBubble(p, pctx, dir, charge),
    popBubblesOnRay: (shooter, origin, dir, t0, t1, pad) =>
      projectiles.popBubblesOnRay(shooter, origin, dir, t0, t1, pad, pctx),
  };
  const addPlayer = (id, dz, dx = 0, dy = 0) => {
    const p = new PlayerEntity(id, id, { ...spawn, x: spawn.x + dx, y: spawn.y + dy, z: spawn.z - dz }, false);
    p.yaw = Math.PI;
    pctx.entities.set(p.id, p);
    return p;
  };
  const tick = (ms = DT * 1000) => { pctx.now += ms; projectiles.step(ms / 1000, pctx); };
  const bubbles = () => [...projectiles.active.values()].filter((p) => p.type === 'bubble');
  /** Press the trigger one tick and release it the next (a Soap Shot tap), or hold `holdMs`. */
  const pull = (p = owner, holdMs = 0) => {
    p.cooldown = 0; p.triggerPrev = false; p.deployT = 0;
    const before = new Set(bubbles().map((b) => b.id));
    const input = (wantFire) => ({ wantFire, wantAds: false, reload: false, keys: {}, yaw: p.yaw, pitch: p.pitch });
    p.input = input(true);
    p.fireEdgeQueued = true;
    resolveWeaponIntent(p, TICK_MS / 1000, combat);
    for (let held = 0; held < holdMs; held += TICK_MS) {
      p.input = input(true);
      p.fireEdgeQueued = false;
      resolveWeaponIntent(p, TICK_MS / 1000, combat);
      if (!p.charging) break;
    }
    p.input = input(false);
    p.fireEdgeQueued = false;
    if (p.charging) resolveWeaponIntent(p, TICK_MS / 1000, combat);
    return bubbles().filter((b) => !before.has(b.id));
  };
  const runUntilGone = (b, maxMs = 5000) => {
    for (let t = 0; t < maxMs && projectiles.active.has(b.id); t += DT * 1000) tick();
  };
  return { owner, events, kills, blockHits, destroyed, projectiles, pctx, combat, world, addPlayer, tick,
    bubbles, pull, runUntilGone };
}

const hitsOn = (events, victim) => events.filter((e) => e.kind === 'hit' && e.victim === victim.id);
const chestOf = (p) => ({ x: p.x, y: p.y + 1.05, z: p.z });

// ---- 8. A tap launches one Soap Shot -------------------------------------------------------
{
  const h = harness();
  const mag = h.owner.mag[SLOT];
  const launched = h.pull();
  assert.equal(launched.length, 1, 'a tap launches exactly one bubble');
  const [b] = launched;
  assert.ok(b.id.startsWith('u'), 'bubble ids use the u prefix');
  assert.ok(Math.abs(b.blastRules.directDamage - 16) < 0.01, 'a tap is (almost exactly) the Soap Shot');
  assert.equal(h.owner.mag[SLOT], mag - 1, 'the tap spends one round');
  const launch = h.events.find((e) => e.kind === 'projectileLaunch' && e.pid === b.id);
  assert.ok(launch && Number.isFinite(launch.charge) && launch.chaos === 0, 'launch carries charge and chaos');
  assert.equal(launch.type, 'bubble');
}

// ---- 9. Direct Soap Shots: 33.6 each, three kill, credit 'bubble' --------------------------
{
  const h = harness();
  const victim = h.addPlayer('victim', 5, 0, 0);
  for (let shot = 0; shot < 3; shot++) {
    const hp = victim.hp;
    const [b] = h.pull();
    h.runUntilGone(b);
    const hits = hitsOn(h.events, victim);
    assert.equal(hits.length, shot + 1, `tap ${shot + 1} lands directly`);
    // Hit events carry whole-number damage; the authoritative HP carries the decimals.
    if (shot < 2) close(hp - victim.hp, 33.6, `tap ${shot + 1} deals 33.6`, 0.05);
    assert.equal(hits.at(-1).soak, BUBBLE_RULES.small.concussMs, 'direct pops soak the victim');
  }
  assert.equal(victim.state, 'dead', 'three direct Soap Shots kill');
  assert.deepEqual(h.kills.at(-1), { victim: 'victim', killer: 'owner', weapon: 'bubble', hs: false });
}

// ---- 10. Big Bubble direct: 56, a hard upward shove --------------------------------------
{
  const h = harness();
  const victim = h.addPlayer('victim', 5, 0, 0);
  const seq = victim.impulseSeq || 0;
  const hp = victim.hp;
  const [b] = h.pull(h.owner, 900);
  assert.ok(b.charge >= 0.99, `a 900 ms hold is a full Big Bubble (${b.charge})`);
  close(b.radius, BUBBLE_RULES.big.radius, 'Big Bubble radius', 1e-3);
  h.runUntilGone(b);
  const [hit] = hitsOn(h.events, victim);
  close(hp - victim.hp, 56, 'Big Bubble direct deals 56', 0.1);
  assert.equal(hit.dmg, 56);
  assert.equal(hit.soak, Math.round(bubbleProfile(b.charge).concussMs), 'Big Bubble soaks ~1.8 s');
  assert.ok(victim.vy >= 10, `Big Bubble lifts the victim (vy ${victim.vy})`);
  assert.ok(victim.impulseSeq > seq, 'the shove bumps impulseSeq');
}

// ---- 11. Splash at 1 m; nothing behind a wall ------------------------------------------------
{
  const h = harness();
  const victim = h.addPlayer('victim', 8, 0, 0);
  const b = h.projectiles.launchBubble(h.owner, h.pctx, { x: 0, y: 0, z: -1 }, 0);
  const chest = chestOf(victim);
  Object.assign(b, { x: chest.x + 1, y: chest.y, z: chest.z });
  h.projectiles.explode(b, h.pctx);
  assert.equal(hitsOn(h.events, victim).length, 1, 'the splash hits');
  const expected = combatDamage(Math.round(26 * (1 - 1 / 2.2) * 10) / 10);
  close(100 - victim.hp, expected, 'Soap Shot splash at 1 m', 1e-9);
  close(100 - victim.hp, 11.3, 'splash at 1 m is ~11.3', 0.1);
  close(victim.concussedUntil, h.pctx.now + BUBBLE_RULES.small.concussMs, 'splash soaks for 500 ms', 1e-3);

  const walled = harness({ solid: (x, y, z) => x === Math.floor(spawn.x + 0.6) });
  const shielded = walled.addPlayer('victim', 8, 0, 0);
  const c = walled.projectiles.launchBubble(walled.owner, walled.pctx, { x: 0, y: 0, z: -1 }, 0);
  const shieldedChest = chestOf(shielded);
  Object.assign(c, { x: shieldedChest.x + 1, y: shieldedChest.y, z: shieldedChest.z });
  walled.projectiles.explode(c, walled.pctx);
  assert.equal(hitsOn(walled.events, shielded).length, 0, 'a voxel wall blocks the splash');
  assert.equal(shielded.concussedUntil, 0, 'and the soak');
}

// ---- 12. No terrain -----------------------------------------------------------------------
{
  const wallZ = Math.floor(spawn.z - 6);
  const h = harness({ solid: (x, y, z) => z === wallZ });
  for (let i = 0; i < 20; i++) {
    const [b] = h.pull();
    assert.ok(b, `pop ${i + 1} launches`);
    h.runUntilGone(b);
    h.owner.mag[SLOT] = WEAPONS.bubble.magSize;
  }
  const pops = h.events.filter((e) => e.kind === 'projectileExplode' && e.type === 'bubble');
  assert.equal(pops.length, 20, 'every bubble pops on the wall');
  assert.equal(h.blockHits.length + h.destroyed.length, 0, 'bubble pops never damage terrain');
}

// ---- 13. Self: no damage; a Big Bubble at the feet launches the owner ----------------------
{
  const h = harness();
  const hp = h.owner.hp;
  const b = h.projectiles.launchBubble(h.owner, h.pctx, { x: 0, y: 0, z: -1 }, 1);
  Object.assign(b, { x: h.owner.x, y: h.owner.y + 0.1, z: h.owner.z - 0.2 });
  h.owner.vy = 0;
  h.projectiles.explode(b, h.pctx);
  assert.equal(h.owner.hp, hp, 'the owner never takes bubble damage');
  assert.ok(h.owner.vy >= 8.5 && h.owner.vy <= 10.5, `a Big Bubble at the feet gives dvy ${h.owner.vy}`);
  assert.equal(hitsOn(h.events, h.owner).length, 0, 'no hit event for the owner');
  assert.equal(h.owner.concussedUntil, 0, 'the owner is never soaked');
}

// ---- 14. Soak signal only with damage ---------------------------------------------------------
{
  const h = harness();
  const victim = h.addPlayer('victim', 8, 0, 0);
  const b = h.projectiles.launchBubble(h.owner, h.pctx, { x: 0, y: 0, z: -1 }, 0);
  const chest = chestOf(victim);
  // 2.198 m: inside the 2.2 m radius, but the splash rounds to zero.
  Object.assign(b, { x: chest.x + 2.198, y: chest.y, z: chest.z });
  h.projectiles.explode(b, h.pctx);
  assert.equal(hitsOn(h.events, victim).length, 0, 'a zero-damage edge pop sends no hit');
  assert.equal(victim.concussedUntil, 0, 'and soaks nobody');
}

// ---- 15. Gun Game keeps bubble damage and knockback -----------------------------------------
{
  const h = harness({ grenadeDamage: false });
  const victim = h.addPlayer('victim', 5, 0, 0);
  const [b] = h.pull();
  h.runUntilGone(b);
  assert.equal(hitsOn(h.events, victim).length, 1, 'grenadeDamage:false still lets bubbles hurt');
  const game = new GameEngine({ broadcast: () => {}, mode: 'gungame' });
  try {
    assert.equal(game.contexts.projectiles.grenadeDamage, false, 'Gun Game disables grenade damage');
    game.addClient('g1', 'A');
    game.addClient('g2', 'B');
    const a = game.entities.get('g1');
    const v = game.entities.get('g2');
    v.spawnProtectedUntil = 0;
    const ctx = game.contexts.projectiles;
    const bubble = game.projectiles.launchBubble(a, ctx, { x: 0, y: 0, z: -1 }, 1);
    Object.assign(bubble, { x: v.x, y: v.y + 1.05, z: v.z, directVictim: v });
    const hp = v.hp;
    game.projectiles.explode(bubble, ctx);
    assert.ok(v.hp < hp, 'a Gun Game Big Bubble damages');
  } finally {
    game.stop();
  }
}

// ---- 16. Owner chain -----------------------------------------------------------------------
{
  const h = harness();
  const first = h.projectiles.launchBubble(h.owner, h.pctx, { x: 0, y: 0, z: -1 }, 0);
  const second = h.projectiles.launchBubble(h.owner, h.pctx, { x: 0, y: 0, z: -1 }, 0);
  Object.assign(first, { x: 40.5, y: 25, z: 30 });
  Object.assign(second, { x: 40.5, y: 25, z: 31.6 });
  const fuse = second.explodeAt;
  h.projectiles.explode(first, h.pctx);
  assert.equal(second.explodeAt, fuse, 'a same-owner stream never pops its own siblings');
  const enemy = h.addPlayer('enemy', 20, 5, 0);
  h.projectiles.chaosBlast(enemy, [40.5, 25, 30.1], 'frag', 2.2, 10, 0, h.pctx);
  assert.ok(second.explodeAt <= h.pctx.now && second.chained, 'an enemy blast chain-pops the bubble');
}

// ---- 17. Bullets pop bubbles without stopping --------------------------------------------------
{
  const h = harness();
  const shooter = h.addPlayer('shooter', 0, 3, 0);
  const victim = h.addPlayer('victim', 12, 3, 0);
  Object.assign(shooter, { weapon: RIFLE, yaw: 0, pitch: 0, deployT: 0, cooldown: 0 });
  const b = h.projectiles.launchBubble(h.owner, h.pctx, { x: 0, y: 0, z: -1 }, 1);
  // Park the owner's Big Bubble on the rifle's line, 6 m out and 0.7 m off the victim's chest line.
  Object.assign(b, { x: shooter.x, y: shooter.eyeY, z: shooter.z - 6 });
  fireOneShot(shooter, h.combat, 1, { yaw: 0, pitch: 0 });
  assert.ok(b.explodeAt <= h.pctx.now && b.chained, 'an enemy ray pops the bubble');
  assert.ok(hitsOn(h.events, victim).some((e) => e.attacker === 'shooter'), 'the ray still reaches the victim');
  h.tick();
  assert.equal(h.projectiles.active.has(b.id), false, 'the popped bubble is gone next tick');

  const team = harness({ canDamage: (a, v) => a !== v && !(a.team && a.team === v.team) });
  const mate = team.addPlayer('mate', 0, 3, 0);
  Object.assign(mate, { weapon: RIFLE, deployT: 0, cooldown: 0, team: 'alpha' });
  team.owner.team = 'alpha';
  const friendly = team.projectiles.launchBubble(team.owner, team.pctx, { x: 0, y: 0, z: -1 }, 1);
  Object.assign(friendly, { x: mate.x, y: mate.eyeY, z: mate.z - 6 });
  const friendlyFuse = friendly.explodeAt;
  fireOneShot(mate, team.combat, 1, { yaw: 0, pitch: 0 });
  assert.equal(friendly.explodeAt, friendlyFuse, 'a teammate ray passes friendly bubbles');
  team.owner.cooldown = 0;
  team.owner.weapon = RIFLE;
  Object.assign(friendly, { x: team.owner.x, y: team.owner.eyeY, z: team.owner.z - 6 });
  fireOneShot(team.owner, team.combat, 1, { yaw: 0, pitch: 0 });
  assert.ok(friendly.explodeAt <= team.pctx.now, 'the owner can airburst their own bubble');
}

// ---- 18. Soap trampoline ----------------------------------------------------------------------
{
  const h = harness();
  const b = h.projectiles.launchBubble(h.owner, h.pctx, { x: 0, y: 0, z: -1 }, 1);
  // A hovering bubble sitting in the owner's chest.
  const hover = () => Object.assign(b, { x: h.owner.x, y: h.owner.y + 1.05, z: h.owner.z,
    vx: 0, vy: 0, vz: 0, rise: 0 });
  hover();
  h.tick(100);
  assert.ok(h.projectiles.active.has(b.id), 'no owner contact inside the 220 ms grace');
  hover();
  h.owner.vy = 0;
  const hp = h.owner.hp;
  h.tick(150);
  assert.equal(h.projectiles.active.has(b.id), false, 'the owner pops their own bubble after the grace');
  assert.ok(h.owner.vy >= 6.4, `soap trampoline launches the owner (vy ${h.owner.vy})`);
  assert.equal(h.owner.hp, hp, 'the trampoline never hurts');
}

// ---- 19. Per-owner cap and room budget ----------------------------------------------------------
{
  const h = harness();
  const made = [];
  for (let i = 0; i < BUBBLE_RULES.maxPerOwner; i++) {
    h.pctx.now += 1;
    made.push(h.projectiles.launchBubble(h.owner, h.pctx, { x: 0, y: 1, z: 0 }, 0));
  }
  assert.ok(made.every((b) => b.explodeAt > h.pctx.now), 'sixteen bubbles float');
  h.pctx.now += 1;
  h.projectiles.launchBubble(h.owner, h.pctx, { x: 0, y: 1, z: 0 }, 0);
  assert.equal(made[0].explodeAt, h.pctx.now, 'the 17th bubble airbursts the oldest');
  assert.ok(made.slice(1).every((b) => b.explodeAt > h.pctx.now), 'only the oldest');

  const full = harness();
  const filler = full.addPlayer('filler', 30, 0, 0);
  const mine = full.projectiles.launchBubble(full.owner, full.pctx, { x: 0, y: 1, z: 0 }, 0);
  for (let i = 0; full.projectiles.active.size < 192; i++) {
    full.projectiles.active.set(`x${i}`, { id: `x${i}`, type: 'rocket', owner: filler, x: 0, y: 0, z: 0,
      explodeAt: Infinity });
  }
  const evicting = full.projectiles.launchBubble(full.owner, full.pctx, { x: 0, y: 1, z: 0 }, 0);
  assert.ok(evicting && !full.projectiles.active.has(mine.id), 'a full room evicts the owner’s oldest bubble');
  const other = full.addPlayer('other', 10, 2, 0);
  Object.assign(other, { weapon: SLOT, deployT: 0, cooldown: 0 });
  const mag = other.mag[SLOT];
  const refused = full.pull(other);
  assert.equal(refused.length, 0, 'nothing to evict: the launch is refused');
  assert.equal(other.mag[SLOT], mag, 'the refused round is refunded');
}

// ---- 20. Charge vent ----------------------------------------------------------------------------
{
  const h = harness();
  const p = h.owner;
  p.input = { wantFire: true, keys: {}, yaw: 0, pitch: 0 };
  p.fireEdgeQueued = true;
  resolveWeaponIntent(p, TICK_MS / 1000, h.combat);
  let launched = null;
  for (let ms = 0; ms <= 1600 && !launched; ms += TICK_MS) {
    p.fireEdgeQueued = false;
    resolveWeaponIntent(p, TICK_MS / 1000, h.combat);
    launched = h.bubbles()[0] || null;
  }
  assert.ok(launched, 'a held trigger vents at holdMaxMs');
  assert.equal(launched.charge, 1, 'the vented bubble is a full Big Bubble');
  assert.ok(p.chargeT === 0 || !p.charging, 'the vent clears the charge');
}

// ---- 21. Chaos 1: Double bubble --------------------------------------------------------------------
{
  const h = harness();
  h.owner.chaosUpgrades = { bubble: 1 };
  const mag = h.owner.mag[SLOT];
  const launched = h.pull();
  assert.equal(launched.length, 2, 'one pull blows two bubbles');
  assert.equal(h.owner.mag[SLOT], mag - 1, 'the twin is free');
  const launches = h.events.filter((e) => e.kind === 'projectileLaunch' && e.type === 'bubble');
  assert.equal(launches.length, 2);
  assert.equal(launches[1].twin, 1, 'the twin is flagged so the client never adopts it');
  assert.ok(!('twin' in launches[0]), 'the primary launch is adoptable');
  const [main, twin] = launched;
  const yaw = Math.atan2(twin.vx, -twin.vz) - Math.atan2(main.vx, -main.vz);
  close(Math.abs(yaw), BUBBLE_RULES.twin.yawRad, 'the twin fans off by the twin yaw', 1e-6);
}

// ---- 22. Chaos 2: Clingfilm -------------------------------------------------------------------------
{
  const wallZ = Math.floor(spawn.z - 4);
  const h = harness({ solid: (x, y, z) => z === wallZ });
  h.owner.chaosUpgrades = { bubble: 2 };
  const [b] = h.pull();
  for (let i = 0; i < 40 && !b.stuck && h.projectiles.active.has(b.id); i++) h.tick();
  assert.ok(b.stuck, 'a wall contact sticks under Clingfilm');
  const stick = h.events.find((e) => e.kind === 'projectileStick' && e.pid === b.id);
  assert.ok(stick && stick.fuse === BUBBLE_RULES.cling.ms, 'the stick event carries the 5 s fuse');
  assert.equal(b.explodeAt, stick.at + BUBBLE_RULES.cling.ms, 'Clingfilm resets the fuse');
  // An enemy within reach and in sight pops it.
  const enemy = h.addPlayer('enemy', 0, 0, 0);
  Object.assign(enemy, { x: b.x + 1.3, y: b.y - 1.05, z: b.z });
  h.tick();
  assert.equal(h.projectiles.active.has(b.id), false, 'an enemy 1.3 m away in sight pops the mine');

  // Behind glass (any solid voxel) it stays.
  const g = harness({ solid: (x, y, z) => z === wallZ || (x === Math.floor(spawn.x + 1) && z === wallZ + 1) });
  g.owner.chaosUpgrades = { bubble: 2 };
  const [c] = g.pull();
  for (let i = 0; i < 40 && !c.stuck && g.projectiles.active.has(c.id); i++) g.tick();
  assert.ok(c.stuck);
  const hidden = g.addPlayer('hidden', 0, 0, 0);
  Object.assign(hidden, { x: c.x + 1.3, y: c.y - 1.05, z: c.z });
  g.tick();
  assert.ok(g.projectiles.active.has(c.id), 'an enemy behind a solid voxel does not trip it');
  // Removing the mount pops it.
  g.world.solid = () => false;
  g.tick();
  assert.equal(g.projectiles.active.has(c.id), false, 'a removed mount voxel pops it');

  // A floor contact still pops.
  const floorY = Math.floor(spawn.y + 1);
  const f = harness({ solid: (x, y) => y <= floorY });
  f.owner.chaosUpgrades = { bubble: 2 };
  f.owner.y = floorY + 1;
  const down = f.projectiles.launchBubble(f.owner, f.pctx, { x: 0, y: -1, z: 0 }, 0);
  f.runUntilGone(down, 500);
  assert.equal(down.stuck, false, 'a floor contact never sticks');
  assert.equal(f.projectiles.active.has(down.id), false, 'it pops');

  // The ninth stuck bubble evicts the oldest (launched as twins: the ladder is cumulative,
  // so a trigger pull under Clingfilm would also blow the Double-bubble twin).
  const n = harness({ solid: (x, y, z) => z === wallZ });
  n.owner.chaosUpgrades = { bubble: 2 };
  const stuck = [];
  for (let i = 0; i < BUBBLE_RULES.cling.perOwner + 1; i++) {
    const s = n.projectiles.launchBubble(n.owner, n.pctx, { x: 0, y: 0, z: -1 }, 0, true);
    for (let k = 0; k < 40 && !s.stuck; k++) n.tick();
    assert.ok(s.stuck, `bubble ${i + 1} clings`);
    stuck.push(s);
  }
  n.tick();
  assert.equal(n.projectiles.active.has(stuck[0].id), false, 'the ninth clung bubble evicts the oldest');
  assert.ok(stuck.slice(1).every((s) => n.projectiles.active.has(s.id)), 'the other eight stay');
}

// ---- 22b. Clingfilm never revives a bubble already marked to pop; stick carries the normal ------------
{
  // A bullet pops a bubble one tick short of a wall: it pops next tick, it never clings.
  const wallZ = Math.floor(spawn.z - 8);
  const h = harness({ solid: (x, y, z) => z <= wallZ });
  h.owner.chaosUpgrades = { bubble: 2 };
  const b = h.projectiles.launchBubble(h.owner, h.pctx, { x: 0, y: 0, z: -1 }, 0, true);
  for (let i = 0; i < 40 && b.z - (wallZ + 1) > 1; i++) h.tick();
  assert.ok(h.projectiles.active.has(b.id) && !b.stuck && b.z - (wallZ + 1) <= 1, 'the bubble is one tick off the wall');
  const shooter = h.addPlayer('shooter', 0, 5, 0);
  assert.equal(h.projectiles.popBubblesOnRay(shooter, [b.x + 5, b.y, b.z], { x: -1, y: 0, z: 0 }, 0, 20, 0, h.pctx), 1,
    'the ray pops the bubble');
  h.tick();
  assert.equal(h.projectiles.active.has(b.id), false, 'a shot bubble pops on the next tick');
  assert.equal(h.events.filter((e) => e.kind === 'projectileStick').length, 0, 'it never clings with a fresh fuse');
  assert.ok(h.events.some((e) => e.kind === 'projectileExplode' && e.pid === b.id), 'it explodes');

  // A point-blank launch into a hugged wall is blocked: it pops next tick under Clingfilm too.
  const pb = harness({ solid: (x, y, z) => z <= Math.floor(spawn.z - 0.9) });
  pb.owner.chaosUpgrades = { bubble: 2 };
  const blocked = pb.projectiles.launchBubble(pb.owner, pb.pctx, { x: 0, y: 0, z: -1 }, 0, true);
  assert.equal(blocked.explodeAt, pb.pctx.now, 'a hugged wall blocks the launch');
  pb.tick();
  assert.equal(pb.projectiles.active.has(blocked.id), false, 'the blocked bubble pops next tick');
  assert.equal(pb.events.filter((e) => e.kind === 'projectileStick').length, 0, 'a blocked launch never clings');

  // A clung wall bubble reports its mount face normal (the client flattens along it).
  const w = harness({ solid: (x, y, z) => z === wallZ });
  w.owner.chaosUpgrades = { bubble: 2 };
  const c = w.projectiles.launchBubble(w.owner, w.pctx, { x: 0, y: 0, z: -1 }, 0, true);
  for (let i = 0; i < 40 && !c.stuck && w.projectiles.active.has(c.id); i++) w.tick();
  assert.ok(c.stuck, 'the wall bubble clings');
  const stick = w.events.find((e) => e.kind === 'projectileStick' && e.pid === c.id);
  assert.deepEqual(stick.n, [0, 0, 1], 'the stick event carries the +z face normal');

  // Bubbles never steer: chaos bubbles (flying or clung) send no 10 Hz correction stream.
  const s1 = harness();
  s1.owner.chaosUpgrades = { bubble: 1 };
  for (let i = 0; i < 4; i++) {
    s1.projectiles.launchBubble(s1.owner, s1.pctx, { x: 0, y: 0, z: -1 }, 0);
    for (let k = 0; k < 4; k++) s1.tick();
  }
  for (let k = 0; k < 20; k++) s1.tick();
  assert.ok(s1.events.filter((e) => e.kind === 'projectileLaunch').length >= 8, 'Double bubble launched pairs');
  assert.equal(s1.events.filter((e) => e.kind === 'projectileUpdate').length, 0,
    'chaos bubbles send no projectileUpdate stream');
  assert.equal(w.events.filter((e) => e.kind === 'projectileUpdate').length, 0, 'clung bubbles send none either');
}

// ---- 23. Chaos 3: Foam party ----------------------------------------------------------------------------
{
  const h = harness();
  h.owner.chaosUpgrades = { bubble: 3 };
  const b = h.projectiles.launchBubble(h.owner, h.pctx, { x: 0, y: 0, z: -1 }, 0, true);
  Object.assign(b, { x: 40.5, y: 30, z: 20 });
  h.projectiles.explode(b, h.pctx);
  const children = h.bubbles().filter((c) => c.child);
  assert.equal(children.length, BUBBLE_RULES.foam.count, 'a pop scatters five mini bubbles');
  assert.ok(children.every((c) => c.radius === BUBBLE_RULES.foam.radius));
  const childLaunch = h.events.filter((e) => e.kind === 'projectileLaunch' && e.child);
  assert.equal(childLaunch.length, BUBBLE_RULES.foam.count, 'each child is published as a child launch');
  const y0 = children.map((c) => c.y);
  for (let i = 0; i < 12; i++) h.tick(DT * 1000);
  const alive = children.filter((c) => h.projectiles.active.has(c.id));
  assert.ok(alive.every((c, i) => c.y > y0[children.indexOf(c)]), 'mini bubbles rise on the shared integrator');
  for (let i = 0; i < 40; i++) h.tick();
  assert.equal(h.bubbles().length, 0, 'children never scatter again');
  // Child direct damage.
  const d = harness();
  d.owner.chaosUpgrades = { bubble: 3 };
  const victim = d.addPlayer('victim', 8, 0, 0);
  const parent = d.projectiles.launchBubble(d.owner, d.pctx, { x: 0, y: 0, z: -1 }, 0, true);
  Object.assign(parent, { x: 40.5, y: 40, z: 10 });
  d.projectiles.explode(parent, d.pctx);
  const [mini] = d.bubbles().filter((c) => c.child);
  Object.assign(mini, { x: victim.x, y: victim.y + 1.05, z: victim.z, directVictim: victim });
  d.projectiles.explode(mini, d.pctx);
  close(100 - victim.hp, 11.2, 'a direct foam mini deals 11.2', 0.05);
}

// ---- Client presentation: whitelist, flight profile, twin guard, age-aware adoption ----------
{
  const THREE = await import('../public/js/vendor/three.module.js');
  const { ProjectileFX } = await import('../public/js/weapons/projectiles.js');
  const trails = [];
  const fx = new ProjectileFX(new THREE.Scene(), () => 0, {
    camera: new THREE.PerspectiveCamera(), onTrail: (_x, _y, _z, p) => trails.push(p.type),
  });
  const l = bubbleLaunch({ x: 20, y: 30, z: 20, dir: { x: 0, y: 0, z: -1 }, charge01: 0 });
  const o = [l.x, l.y, l.z], v = [l.vx, l.vy, l.vz];
  assert.ok(fx.launch({ type: 'bubble', o, v, charge: 0 }, { local: true }), 'the local prediction spawns');
  const [local] = fx.projectiles.values();
  assert.equal(local.type, 'bubble', 'bubble is a whitelisted client projectile type');
  assert.deepEqual([local.drag, local.rise, local.radius],
    [BUBBLE_RULES.small.drag, BUBBLE_RULES.small.rise, BUBBLE_RULES.small.radius], 'client flight profile');
  for (let i = 0; i < 6; i++) fx.update(1 / 60);
  fx.launch({ pid: 'u2', type: 'bubble', o, v, fuse: 2200, charge: 0, twin: 1 }, { fromSelf: true });
  assert.ok(fx.projectiles.has('u2') && local.local, 'a Double-bubble twin never adopts the prediction');
  fx.launch({ pid: 'u1', type: 'bubble', o, v, fuse: 2200, charge: 0 }, { fromSelf: true });
  assert.equal(fx.pendingLocal, 0, 'the authority launch adopts the prediction');
  assert.strictEqual(fx.projectiles.get('u1'), local, 'the same presentation object continues');
  const expected = { ...l, drag: BUBBLE_RULES.small.drag, rise: BUBBLE_RULES.small.rise };
  stepBubble(expected, local.age, none);
  close(local.vz, expected.vz, 'adoption keeps the aged (dragged) velocity', 1e-9);
  const y0 = local.y;
  for (let i = 0; i < 60; i++) fx.update(1 / 60);
  assert.ok(local.y > y0 + 0.5, 'the client bubble rises on the shared integrator');
  assert.ok(trails.includes('bubble'), 'flying bubbles emit their micro-bubble trail');
  assert.ok(fx.explode({ pid: 'u1', type: 'bubble', x: local.x, y: local.y, z: local.z, radius: 2.2 }));
  assert.equal(fx.projectiles.has('u1'), false, 'the pop removes the bubble');
  const fuse = bubbleProfile(1).lifetimeMs / 1000;
  fx.launch({ pid: 'u3', type: 'bubble', o, v: [0, 0, -13], charge: 1 });
  const bigOne = fx.projectiles.get('u3');
  close(bigOne.fuse, fuse, 'a missing fuse falls back to the charge profile lifetime', 1e-9);
  close(bigOne.radius, BUBBLE_RULES.big.radius, 'a remote Big Bubble is big', 1e-9);
  fx.dispose();
}

// ---- Client pop, cling pose, remote presentation, soak prediction ------------------------------------
{
  const THREE = await import('../public/js/vendor/three.module.js');
  const { ProjectileFX } = await import('../public/js/weapons/projectiles.js');
  const fx = new ProjectileFX(new THREE.Scene(), () => 0, { camera: new THREE.PerspectiveCamera() });
  const live = () => fx._popLines.filter((p) => p.lines.visible);
  // One pop burst per pop; a Foam-party mini pops at half scale although its radius is 2 m.
  fx.launch({ pid: 'm1', type: 'bubble', o: [0, 30, 0], v: [0, 0, -5], charge: 0, child: 1 });
  fx.explode({ pid: 'm1', type: 'bubble', x: 0, y: 30, z: 0, radius: BUBBLE_RULES.foam.damageRadius });
  assert.equal(live().length, 1, 'a pop spawns one burst of pop strokes');
  close(live()[0].scale, 0.5, 'a foam mini pops at half scale', 1e-9);
  fx.launch({ pid: 'b1', type: 'bubble', o: [0, 30, 0], v: [0, 0, -5], charge: 0 });
  fx.explode({ pid: 'b1', type: 'bubble', x: 0, y: 30, z: 0, radius: 2.2 });
  close(live()[1].scale, 1, 'a Soap Shot pops at full scale', 1e-9);
  const burst = live()[1];
  const r0 = burst.lines.children[0].position.length();
  fx.update(0.05);
  assert.ok(burst.lines.children[0].position.length() > r0, 'the strokes fly outward');
  for (let i = 0; i < 4; i++) fx.update(0.05);
  assert.equal(burst.lines.visible, false, 'the burst is gone after its life');
  const effectsSource = (await import('node:fs')).readFileSync(new URL('../public/js/weapons/effects.js', import.meta.url), 'utf8');
  assert.ok(!/popLines|BubblePopLines/.test(effectsSource), 'effects.js no longer draws a second pop-line burst');

  // A clung wall bubble flattens along its mount normal, not world Y.
  fx.launch({ pid: 'c1', type: 'bubble', o: [0, 30, 0], v: [0, 0, -5], charge: 0 });
  fx.stick({ pid: 'c1', x: 0, y: 30, z: -1, fuse: 5000, n: [1, 0, 0] });
  fx.projectiles.get('c1').wobblePhase = -11 * 0.2;   // the Soap Shot wobble is at a node at 0.2 s
  for (let i = 0; i < 4; i++) fx.update(0.05);
  const shell = fx.projectiles.get('c1').group.userData.shell;
  const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(shell.quaternion);
  close(axis.x, 1, 'the flattened shell axis lines up with the +x mount normal', 1e-6);
  assert.ok(shell.scale.y < shell.scale.x * 0.92, 'and it is squashed along that axis');
  fx.dispose();

  // Remote SUDSBLASTER shots: no powder flash, soap presentation instead.
  const { TracerFX } = await import('../public/js/weapons/ballistics.js');
  const tracers = new TracerFX(new THREE.Scene(), () => 0);
  let flashes = 0;
  tracers.spawnFlash = () => { flashes++; };
  tracers.shoot({ id: 'enemy', w: 'bubble', o: [0, 30, 0], d: [0, 0, -1] });
  assert.equal(flashes, 0, 'a remote bubble shot spawns no muzzle flash');
  tracers.shoot({ id: 'enemy', w: 'rifle', o: [0, 30, 0], d: [0, 0, -1] });
  assert.equal(flashes, 1, 'a remote rifle shot still flashes');
  tracers.dispose?.();
  const { AvatarWeaponModel } = await import('../public/js/avatar/avatar-weapon.js');
  const { bubblePresentationFor } = await import('../public/js/guns/bubble-presentation.js');
  const remote = new AvatarWeaponModel();
  try {
    remote.update({ weapon: 'bubble', dt: 0.05 });
    const pres = bubblePresentationFor(remote._model);
    assert.ok(pres?.ready, 'the remote SUDSBLASTER carries the bubble presentation');
    remote.update({ weapon: 'bubble', charge: 0.8, dt: 0.05 });
    close(pres.charge, 0.8, 'the remote hold charge swells the film', 1e-9);
    remote.update({ weapon: 'bubble', charge: 0, firing: true, dt: 0.02 });
    assert.equal(remote._model.flash.grp.visible, false, 'no powder flash on a remote bubble shot');
    assert.equal(remote._model.flash.light.intensity, 0, 'and no flash light');
    assert.ok(pres.fireT !== null && pres.fireCharge >= 0.79, 'the firing edge hands off the held bubble');
    const firedAt = pres.fireT;
    remote.update({ weapon: 'bubble', firing: true, dt: 0.02 });
    assert.ok(pres.fireT > firedAt, 'a held firing flag is one shot, not a re-fire');
  } finally { remote.dispose(); }

  // Local soak prediction: one 0.6x slow through speedScale, never stacked on the move speed.
  const { LocalPlayer } = await import('../public/js/player/local-player.js');
  const steps = [];
  const physics = { pos: { x: 4, y: 1, z: 4 }, vel: { x: 0, y: 0, z: 0 }, grounded: true, speedScale: 1,
    step(dt, wish, moveSpeed) { steps.push({ moveSpeed, speedScale: this.speedScale }); return false; },
    eyeY: () => 2.62, setMapMeta() {} };
  const player = new LocalPlayer({ physics, input: { setGameplayEnabled() {}, consumeDelta: () => ({ x: 0, y: 0 }), getKeys: () => ({}) } });
  player._stepPrediction(1 / 60);
  const dry = steps.at(-1);
  player.soak(1800);
  player._stepPrediction(1 / 60);
  const wet = steps.at(-1);
  close(wet.moveSpeed, dry.moveSpeed, 'the soak leaves the move speed argument alone', 1e-9);
  close(wet.speedScale, MOVEMENT_RULES.concussedSpeedMult, 'it slows through speedScale before the snapshot lands', 1e-9);
  player._concussedS = 1.7;   // the snapshot's concussedMs arrives
  player._stepPrediction(1 / 60);
  close(steps.at(-1).speedScale * steps.at(-1).moveSpeed / dry.moveSpeed, MOVEMENT_RULES.concussedSpeedMult,
    'with the snapshot concussion the total slow stays 0.6x, not 0.36x', 1e-9);
}

// ---- 21-23 (edges). Chaos ladder: twin cap, ceilings, owner-safe mines, shot mines, foam ------------
{
  // Double bubble: the twin keeps the release charge and counts toward the owner cap.
  const big = harness();
  big.owner.chaosUpgrades = { bubble: 1 };
  const pair = big.pull(big.owner, 900);
  assert.equal(pair.length, 2, 'a charged pull blows its twin too');
  assert.ok(pair[0].charge >= 0.99 && pair[1].charge === pair[0].charge, 'the twin keeps the release charge');
  const cap = harness();
  cap.owner.chaosUpgrades = { bubble: 1 };
  const pulls = [];
  for (let i = 0; i < BUBBLE_RULES.maxPerOwner / 2 + 1; i++) {
    cap.owner.mag[SLOT] = WEAPONS.bubble.magSize;
    pulls.push(cap.pull());
  }
  assert.ok(pulls.every((p) => p.length === 2), 'every pull blows a pair');
  assert.ok(pulls[0].every((b) => b.explodeAt === cap.pctx.now), 'the ninth pair airbursts the oldest pair (twins count)');
  assert.ok(pulls.slice(1).flat().every((b) => b.explodeAt > cap.pctx.now), 'the other sixteen float on');

  // Clingfilm: ceilings hold a mine too; the owner never trips it; a bullet does.
  const ceilY = Math.floor(spawn.y + 4);
  const c = harness({ solid: (x, y) => y === ceilY });
  c.owner.chaosUpgrades = { bubble: 2 };
  const up = c.projectiles.launchBubble(c.owner, c.pctx, { x: 0, y: 1, z: 0 }, 0, true);
  for (let i = 0; i < 40 && !up.stuck && c.projectiles.active.has(up.id); i++) c.tick();
  assert.ok(up.stuck, 'a ceiling contact sticks under Clingfilm');
  Object.assign(c.owner, { x: up.x + 0.6, y: up.y - 1.05, z: up.z });
  c.tick();
  assert.ok(c.projectiles.active.has(up.id), 'an owner under the mine never trips it');
  const shooter = c.addPlayer('shooter', 0, 3, 0);
  const origin = [up.x, up.y - 3, up.z];
  assert.equal(c.projectiles.popBubblesOnRay(shooter, origin, { x: 0, y: 1, z: 0 }, 0, 5, 0, c.pctx), 1,
    'an enemy ray pops a clung mine');
  c.tick();
  assert.equal(c.projectiles.active.has(up.id), false, 'the shot mine pops');

  // Foam party (cumulative: twins and cling on): a pull pops into exactly five minis per
  // non-child bubble, minis never twin, never cling to walls and never scatter again.
  const wallZ = Math.floor(spawn.z - 3);
  const f = harness({ solid: (x, y, z) => z === wallZ });
  f.owner.chaosUpgrades = { bubble: 3 };
  const [main] = f.pull();
  Object.assign(main, { x: spawn.x, y: spawn.y + 1.5, z: wallZ + 1.6, stuck: false });
  const launchesBefore = f.events.filter((e) => e.kind === 'projectileLaunch').length;
  f.projectiles.explode(main, f.pctx);
  const minis = f.bubbles().filter((b) => b.child);
  assert.equal(minis.length, BUBBLE_RULES.foam.count, 'one pop, five minis (no twin minis)');
  const childLaunches = f.events.filter((e) => e.kind === 'projectileLaunch').slice(launchesBefore);
  assert.ok(childLaunches.every((e) => e.child && !e.twin), 'mini launches are children, never twins');
  let clung = false;
  for (let i = 0; i < 40 && minis.some((m) => f.projectiles.active.has(m.id)); i++) {
    f.tick();
    if (minis.some((m) => m.stuck)) clung = true;
  }
  assert.equal(clung, false, 'foam minis never cling');
  assert.ok(minis.every((m) => !f.projectiles.active.has(m.id)), 'every mini pops within its life');
  assert.equal(f.bubbles().filter((b) => b.child && !minis.includes(b)).length, 0, 'minis never scatter again');
}

// ---- Viewmodel presentation: film, charge sphere, handoff, suds, reload prime ------------------------
{
  const THREE = await import('../public/js/vendor/three.module.js');
  const { BubblePresentation, bubblePresentationFor } = await import('../public/js/guns/bubble-presentation.js');
  const film = (geometry, alpha = 0.55) => {
    const material = new THREE.MeshBasicMaterial({ transparent: true, opacity: alpha });
    material.userData.baseAlpha = alpha;
    return new THREE.Mesh(geometry, material);
  };
  const parts = {
    bulb: new THREE.Group(),
    film: film(new THREE.CircleGeometry(0.0485, 12)),
    bulge: film(new THREE.SphereGeometry(0.0485, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2)),
    charge: film(new THREE.SphereGeometry(1, 8, 6)),
    handoff: film(new THREE.SphereGeometry(0.045, 8, 6)),
    bead: new THREE.Mesh(new THREE.SphereGeometry(0.005, 4, 3)),
    beadCurve: new THREE.LineCurve3(new THREE.Vector3(0, 0.086, 0.05), new THREE.Vector3(0, 0.05, -0.3)),
    suds: new THREE.Group(),
    foam: new THREE.Group(),
    tank: new THREE.Group(),
    idle: [film(new THREE.SphereGeometry(0.012, 6, 4))],
  };
  parts.film.position.set(0, 0.03, -0.541);
  parts.bulge.scale.z = 0.001;
  parts.suds.position.y = -0.046;
  parts.foam.position.y = -0.046 + 0.104;
  for (const hidden of [parts.charge, parts.handoff, parts.bead, parts.idle[0]]) hidden.visible = false;
  const model = { extra: { userData: { bubble: parts } } };
  const pres = bubblePresentationFor(model);
  assert.ok(pres instanceof BubblePresentation && pres.ready && bubblePresentationFor(model) === pres,
    'one presentation per built bundle');
  const run = (seconds, step = 1 / 120) => { for (let t = 0; t < seconds - 1e-9; t += step) pres.update(step); };
  pres.reset(12, 12);
  run(0.5);
  assert.ok(parts.film.visible && Math.abs(parts.film.scale.x - 1) < 0.05, 'the film forms across the ring on the draw');
  // The suds column follows the authoritative tank.
  pres.setMag(6, 12);
  run(1);
  close(parts.suds.scale.y, 0.12 + 0.88 * 0.5, 'half a tank shows a half column', 0.01);
  assert.ok(parts.foam.position.y < -0.046 + 0.104 - 0.04, 'the foam cap rides the liquid down');
  pres.setMag(0, 12);
  run(1);
  close(parts.suds.scale.y, 0.12, 'an empty tank keeps a puddle', 0.01);
  pres.setMag(12, 12);
  run(1);
  // Charging: a film sphere swells forward off the ring, r = 0.02 + 0.14 c^2.
  pres.setCharge(0.5);
  run(1 / 60);
  assert.ok(parts.charge.visible, 'a held charge shows the swelling film');
  const r = 0.02 + 0.14 * 0.25;
  assert.ok(Math.abs(parts.charge.scale.x - r) <= r * 0.2, `charge sphere radius ~${r} (${parts.charge.scale.x})`);
  close(parts.charge.position.z, parts.film.position.z - r, 'it grows forward off the ring', 1e-9);
  const bulbY = parts.bulb.scale.y;
  pres.setCharge(1);
  run(1 / 60);
  assert.ok(parts.bulb.scale.y < bulbY && parts.bulb.scale.y <= 0.71, 'the bulb squeezes as the charge climbs');
  // Release (WeaponState zeroes the charge, then the rig fires): the bubble hands off.
  pres.setCharge(0);
  pres.fire();
  run(1 / 120);
  assert.equal(parts.charge.visible, false, 'the charge sphere lets go on release');
  assert.ok(parts.handoff.visible && parts.handoff.scale.x * 0.045 >= 0.159, 'the handoff carries the Big Bubble');
  run(0.4);
  assert.equal(parts.handoff.visible, false, 'the handoff fades out within the shot');
  assert.ok(parts.film.visible, 'the film re-forms after the shot');
  // A dropped charge (swap, reload) deflates instead of firing.
  pres.setCharge(0.8);
  run(1 / 60);
  pres.setCharge(0);
  run(0.3);
  assert.equal(parts.charge.visible, false, 'an unfired charge deflates');
  assert.equal(parts.handoff.visible, false, 'and never hands off');
  // Tap: bulb squash, air bead, film bulge, then the handoff at the release.
  pres.fire(0);
  run(0.02);
  assert.ok(parts.bulb.scale.y < 0.8 && parts.bead.visible, 'a tap squashes the bulb and runs the air bead');
  assert.ok(parts.bulge.visible && parts.bulge.scale.z > 0.3, 'the film bulges before it lets go');
  run(0.04);
  assert.ok(parts.handoff.visible, 'the tap bubble hands off at the release');
  run(0.4);
  // Reload: the tank unscrews, the film deflates while it is out, and the prime re-forms it.
  const timeline = { start: 0.16, home: 0.8, clickAt: 0.9 };
  pres.setMag(0, 12);
  pres.reload(2.2, timeline);
  run(0.14);
  assert.ok(Math.abs(parts.tank.rotation.y) > 1, 'the tank unscrews before it drops');
  run(2.2 * 0.5 - 0.14);
  assert.equal(parts.film.visible, false, 'no tank, no film');
  assert.ok(parts.suds.scale.y > 0.99, 'the fresh tank arrives full');
  run(2.2 * 0.4);
  pres.prime();
  run(0.5);
  assert.ok(parts.film.visible && parts.film.scale.x > 0.9, 'the prime re-forms the film');

  // The rig creates, feeds and fires the presentation for the drawn SUDSBLASTER.
  const { ViewmodelRig } = await import('../public/js/guns/viewmodel.js');
  const rig = new ViewmodelRig(new THREE.PerspectiveCamera(75, 16 / 9, 0.01, 100));
  rig.setBubble({ mag: 3, magSize: 12 });
  rig.setWeapon('bubble');
  assert.ok(rig._bubble, 'drawing the SUDSBLASTER attaches its presentation');
  close(rig._bubble.levelTarget, 0.12 + 0.88 * 3 / 12, 'the draw starts from the authoritative tank', 1e-9);
  for (let i = 0; i < 60; i++) rig.update(1 / 60);
  rig.setCharge(0.6);
  close(rig._bubble.charge, 0.6, 'the rig forwards the hold charge', 1e-9);
  rig.setCharge(0);
  assert.ok(rig.fire(WEAPONS.bubble), 'the rig accepts the shot');
  close(rig._bubble.fireCharge, 0.6, 'the release fires at the held charge', 1e-9);
  assert.equal(rig._cur.flash.grp.visible, false, 'soap, not powder: no muzzle flash');
  rig.setWeapon('rifle');
  assert.equal(rig._bubble, null, 'other weapons carry no bubble presentation');
  rig.dispose?.();
}

// ---- HUD: rise ladder from the shared flight model, soak vignette ------------------------------------
{
  const { bubbleLadderMarks, bubbleLadderOffsetPx, BubbleHud } = await import('../public/js/ui/bubble-hud.js');
  const tap = bubbleLadderMarks(0, 75, 800);
  assert.deepEqual(tap.map((m) => m.distance), [10, 12, 15], 'Soap Shot marks at 10/12/15 m');
  assert.ok(tap.every((m) => m.px > 0) && tap[0].px < tap[1].px && tap[1].px < tap[2].px,
    'marks sit above the crosshair, farther marks higher');
  const focal = 800 / (2 * Math.tan(75 * Math.PI / 360));
  close(tap[0].px, Math.tan(bubbleAimDrop(bubbleProfile(0), 10)) * focal, 'the 10 m mark is the aim drop', 1e-9);
  const full = bubbleLadderMarks(1, 75, 800);
  assert.deepEqual(full.map((m) => m.distance), [8, 10, 12], 'a full charge slides to the Big-Bubble marks');
  assert.ok(full.every((m) => m.px > 0), 'every Big-Bubble mark is in reach');
  assert.equal(bubbleLadderOffsetPx(bubbleProfile(1), 15), null, 'an out-of-reach mark disappears');
  assert.ok(bubbleLadderMarks(0, 100, 800)[0].px < tap[0].px, 'a wider field of view packs the ladder tighter');

  // Minimal DOM for the overlay owner.
  const node = (tag) => ({
    tagName: tag, children: [], style: { setProperty(k, v) { this[k] = v; } }, hidden: false, textContent: '',
    className: '', id: '', attrs: {},
    appendChild(child) { this.children.push(child); child.parent = this; return child; },
    setAttribute(k, v) { this.attrs[k] = v; },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); },
  });
  const hadDocument = 'document' in globalThis;
  const previous = globalThis.document;
  globalThis.document = { createElement: node };
  try {
    const hud = new BubbleHud();
    const root = node('div'), crosshair = node('div');
    hud.build(root, crosshair);
    hud.update({ charge01: 0, crosshairFov: 75, crosshairHeight: 800 }, 'bubble', true, 0);
    assert.equal(hud.ladder.hidden, false, 'the ladder shows with the SUDSBLASTER drawn');
    assert.match(hud.marks[0].mark.style.transform, /translate\(-50%, -\d/, 'marks are lifted above the crosshair');
    hud.update({ charge01: 0 }, 'rifle', true, 0);
    assert.equal(hud.ladder.hidden, true, 'other weapons hide the ladder');
    assert.equal(hud.vignette.hidden, true, 'no vignette before a soak');
    hud.soak(1800, 1000);
    assert.equal(hud.vignette.hidden, false, 'a soak shows the vignette');
    close(Number(hud.vignette.style.opacity), 0.35, 'at the soak opacity', 1e-9);
    assert.equal(hud.label.hidden, false, 'with the SOAKED label');
    hud.update({}, 'rifle', true, 1000 + 1800 - 125);
    close(Number(hud.vignette.style.opacity), 0.175, 'it fades over the last 250 ms', 1e-3);
    assert.equal(hud.label.hidden, true, 'the label lasts one second');
    hud.update({}, 'rifle', true, 1000 + 1800);
    assert.equal(hud.vignette.hidden, true, 'the vignette ends with the soak');
    // A chained soak while the label shows restarts its one-shot CSS cue.
    const writes = [];
    hud.soak(1800, 3000);
    Object.defineProperty(hud.label.style, 'animation', { set(v) { writes.push(v); }, get() { return writes.at(-1) ?? ''; },
      configurable: true });
    hud.soak(1800, 3217);
    assert.deepEqual(writes, ['none', ''], 'a chained soak replays the SOAKED label animation');
    hud.update({}, 'rifle', true, 3217 + 1001);
    assert.equal(hud.label.hidden, true, 'the label still ends one second after the last soak');
    hud.soak(500, 5000);
    hud.update({}, 'rifle', false, 5100);
    assert.equal(hud.vignette.hidden, true, 'death clears the soak');
    hud.dispose();
    assert.equal(root.children.length, 0, 'dispose removes the overlays');
  } finally {
    if (hadDocument) globalThis.document = previous; else delete globalThis.document;
  }
}

// ---- 24. Bots -----------------------------------------------------------------------------------------
{
  const FEET_Y = GROUND + 1.02;
  const META = Object.freeze({
    id: 'foundry',
    spawns: {
      fun: [{ x: 16.5, y: FEET_Y, z: 16.5, index: 0 }, { x: 18.5, y: FEET_Y, z: 16.5, index: 1 }],
      tdm: {
        alpha: [{ x: 20.5, y: FEET_Y, z: 20.5, index: 0 }, { x: 20.5, y: FEET_Y, z: 24.5, index: 1 }],
        bravo: [{ x: 30.5, y: FEET_Y, z: 20.5, index: 0 }, { x: 30.5, y: FEET_Y, z: 24.5, index: 1 }],
      },
    },
    sites: [],
  });
  const world = {
    meta: META,
    getBlock(x, y, z) {
      x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
      if (y < 0 || x < 0 || z < 0 || x >= SX || z >= SZ) return METAL;
      if (y >= SY) return AIR;
      return y <= GROUND ? CONCRETE : AIR;
    },
    setBlock() { return false; },
    heightAt(x, z) { return x >= 0 && z >= 0 && x < SX && z < SZ ? GROUND : -1; },
    findSpawns(n) { return Array.from({ length: Math.max(0, n | 0) }, (_, i) => ({ ...META.spawns.fun[i % 2], index: i % 2 })); },
  };
  const realNow = Date.now;
  Date.now = () => 1_000_000;
  let engine;
  try { engine = new GameEngine({ mode: 'fun', world, mapMeta: META, broadcast: () => {} }); } finally { Date.now = realNow; }
  engine.addClient('human-0', 'Human');
  engine.addClient('human-1', 'Buddy');
  const inputs = [];
  const applyInput = engine.applyInput.bind(engine);
  engine.applyInput = (id, input) => {
    if (String(id).startsWith('bot-')) inputs.push({ id: String(id), input: structuredClone(input) });
    return applyInput(id, input);
  };
  const manager = attachBots(engine, 1);
  const place = (p, x, z) => { p.x = x; p.y = FEET_Y; p.z = z; p.vx = p.vy = p.vz = 0; p.grounded = true; };
  try {
    const human = engine.entities.get('human-0');
    const buddy = engine.entities.get('human-1');
    const bot = [...engine.entities.values()].find((p) => p.bot);
    const brain = manager.brains.find((b) => b.id === bot.id);
    const hold = (x, z, buddyAt) => {
      engine.step(TICK_MS);
      brain.spawnSwitchPending = false;
      brain.resetCombat();
      brain.bubbleSwapAt = Infinity;
      for (const p of [...engine.projectiles.active.values()]) engine.projectiles.active.delete(p.id);
      Object.assign(bot, { weapon: SLOT, deployT: 0, cooldown: 0, hp: 100, state: 'alive' });
      bot.mag[SLOT] = WEAPONS.bubble.magSize;
      bot.reserve[SLOT] = 99;
      place(bot, 20.5, 20.5);
      place(human, x, z);
      human.hp = 1000;
      place(buddy, buddyAt?.[0] ?? 100.5, buddyAt?.[1] ?? 100.5);
      buddy.hp = 1000;
      bot.yaw = Math.atan2(-(x - bot.x), -(z - bot.z));
    };
    const watch = (ms, onTick) => {
      for (let t = 0; t < ms; t += TICK_MS) { engine.step(TICK_MS); onTick?.(); }
    };
    const own = () => [...engine.projectiles.active.values()].filter((p) => p.type === 'bubble' && p.owner === bot);

    // 10 m, lone target: taps (press one tick, release the next) that aim under the chest.
    hold(20.5, 10.5);
    const charges = [];
    let pressThenRelease = false, prevWant = false;
    watch(4000, () => {
      const call = inputs.findLast((c) => c.id === bot.id);
      if (prevWant && call && !call.input.wantFire) pressThenRelease = true;
      prevWant = !!call?.input.wantFire;
      for (const b of own()) if (!charges.some((c) => c.id === b.id)) charges.push({ id: b.id, charge: b.charge });
    });
    assert.ok(charges.length >= 2, `bot fires Soap Shots at 10 m (${charges.length})`);
    assert.ok(charges.every((c) => c.charge < 0.1), 'lone targets get taps, not Big Bubbles');
    assert.ok(pressThenRelease, 'the tap presses and releases');
    assert.ok(human.hp < 1000, 'bot Soap Shots land at 10 m');
    // The aim drop the bot applies at full skill.
    const flight = bubbleFlight(bubbleProfile(0), 10);
    assert.ok(flight.rise - BUBBLE_RULES.muzzleDrop > 0.15, 'at 10 m the bot aims ~0.2 m under the chest');

    // A second enemy within 3.5 m of the target earns a ~855 ms Big Bubble.
    hold(20.5, 12.5, [22.5, 12.5]);
    const big = [];
    watch(4000, () => { for (const b of own()) if (!big.some((c) => c.id === b.id)) big.push(b.charge); });
    assert.ok(big.some((c) => c >= 0.9), `a grouped target gets a Big Bubble (${big.join(', ')})`);

    // A stale Big-Bubble flag from an earlier hold never stops a lone target at 14.5 m
    // (beyond the Big Bubble's reach, inside the Soap Shot's) from getting taps.
    hold(20.5, 6);
    brain.bubbleBig = true;
    const stale = [];
    watch(4000, () => { for (const b of own()) if (!stale.some((c) => c.id === b.id)) stale.push({ id: b.id, charge: b.charge }); });
    assert.ok(stale.length >= 2, `a stale Big-Bubble flag still fires Soap Shots at 14.5 m (${stale.length})`);
    assert.ok(stale.every((c) => c.charge < 0.1), 'and they are taps');

    // 25 m: never fires the bubble, swaps to the revolver.
    hold(20.5, 45.5);
    brain.bubbleSwapAt = 0;
    let fired = false, swapped = false;
    watch(3000, () => {
      if (own().length) fired = true;
      const call = inputs.findLast((c) => c.id === bot.id);
      if (call?.input.switchTo === WEAPON_IDS.indexOf(DEFAULT_WEAPON_ID)) swapped = true;
      if (bot.weapon !== SLOT) Object.assign(bot, { weapon: SLOT, deployT: 0 });
    });
    assert.equal(fired, false, 'bots never fire bubbles at 25 m');
    assert.ok(swapped, 'bots swap to the revolver beyond the bubble reach');
  } finally {
    manager.dispose();
    engine.stop?.();
  }
}

console.log('SB-1 SUDSBLASTER: rules, exact integrator, reach, taps, Big Bubble, splash, soak, no terrain, self, '
  + 'Gun Game, owner chain, bullet pops, trampoline, caps, vent, Double bubble, Clingfilm, Foam party, chaos edges, client presentation, '
  + 'viewmodel presentation, rise ladder, soak vignette and bots passed.');
