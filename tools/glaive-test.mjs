import assert from 'node:assert/strict';
import { PlayerEntity } from '../server/sim/player.js';
import { fireOneShot, resolveWeaponIntent, switchWeapon } from '../server/sim/combat.js';
import { ProjectileSystem } from '../server/sim/projectiles.js';
import { stepMovement } from '../server/sim/movement.js';
import { rayPlayerHitboxes } from '../shared/player-hitboxes.js';
import { GlaivePresentation } from '../public/js/guns/glaive-presentation.js';
import { applyPowerup } from '../server/sim/powerups.js';
import { GunGamePolicy } from '../server/modes/gungame.js';
import { GameEngine } from '../server/game.js';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';
import { COMBAT_DAMAGE_SCALE, combatDamage } from '../shared/combat-balance.js';
import { AIR, BLOCK_HP } from '../shared/worlddata.js';
import {
  GLAIVE_RULES,
  glaiveHitDamage,
  glaiveLegDamage,
  glaiveTarget,
  stepGlaive,
} from '../shared/glaive-rules.js';

// GV-4 RIPTIDE authority: flight legs, per-leg pierce, catch, R-return, lost discs,
// the ammo invariant, the fire gate, kill attribution and the scale-derived damage.

const SLOT = WEAPON_IDS.indexOf('glaive');
const RIFLE = WEAPON_IDS.indexOf('rifle');
const RULES = GLAIVE_RULES;
const STONE = Number(Object.keys(BLOCK_HP).find((id) => Number(id) !== AIR && BLOCK_HP[id] > 0));
const spawn = { x: 40.5, y: 20, z: 50.5, index: 0 };
const DT = 0.05;
const close = (actual, expected, message, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps,
  `${message}: expected ${expected}, received ${actual}`);

assert.equal(SLOT, 12, 'the RIPTIDE is appended as slot 12');
assert.ok(STONE > 0, 'a damageable block type exists for wall contacts');

// ---- Damage rules, derived from COMBAT_DAMAGE_SCALE -----------------------------------
{
  const out = combatDamage(glaiveLegDamage('out'));
  const back = combatDamage(glaiveLegDamage('back'));
  const headOut = combatDamage(glaiveLegDamage('out', 0, true));
  close(out, RULES.outDamage * COMBAT_DAMAGE_SCALE, 'out leg is the scaled base damage');
  close(back, RULES.backDamage * COMBAT_DAMAGE_SCALE, 'back leg is the scaled base damage');
  close(headOut, RULES.outDamage * WEAPONS.glaive.headMult * COMBAT_DAMAGE_SCALE, 'head multiplies the leg');
  assert.ok(2 * out < 100, `two out hits never kill (${2 * out})`);
  assert.ok(100 - 2 * out >= 10 && 100 - 2 * out <= 15, `two out hits leave 10..15 HP (${100 - 2 * out})`);
  assert.ok(out + back >= 100 - 1e-9, `out + back kills (${out + back})`);
  assert.ok(headOut + out >= 100 - 1e-9, `head out + out kills (${headOut + out})`);
  assert.ok(2 * back >= 100, 'back + back kills');
  close(glaiveHitDamage('out'), out, 'the test helper matches the combat path');
  // Pierce victim n takes leg * falloff^n.
  for (let n = 0; n < 3; n++) {
    close(glaiveLegDamage('out', n), Math.round(RULES.outDamage * RULES.pierceFalloff ** n * 10) / 10,
      `pierce victim ${n} takes the falloff`);
  }
}

// ---- Harness ---------------------------------------------------------------------------
function harness({ solid = () => false } = {}) {
  const owner = new PlayerEntity('owner', 'Owner', spawn, false);
  Object.assign(owner, { yaw: 0, pitch: 0, deployT: 0, weapon: SLOT, cooldown: 0 });
  const events = [], kills = [], blockHits = [];
  const projectiles = new ProjectileSystem();
  const world = { solid };
  const getBlock = (x, y, z) => (world.solid(Math.floor(x), Math.floor(y), Math.floor(z)) ? STONE : AIR);
  const pctx = {
    now: 1000,
    entities: new Map([[owner.id, owner]]),
    solidAt: (x, y, z) => getBlock(x, y, z) !== AIR,
    getBlock,
    canAffectWorld: () => true,
    canDamage: (a, b) => a !== b,
    canThrow: () => true,
    pushEvent: (event) => events.push({ ...event, at: pctx.now }),
    killPlayer: (victim, killer, weapon, hs) => {
      victim.state = 'dead';
      kills.push({ victim: victim.id, killer: killer?.id, weapon, hs });
    },
    damageBlock: (x, y, z, type, damage) => blockHits.push({ x, y, z, type, damage }),
    destroyBlock: () => false,
  };
  const combat = {
    get now() { return pctx.now; },
    get entities() { return pctx.entities; },
    solidAt: pctx.solidAt,
    getBlock,
    blockHp: new Map(),
    canFire: () => true,
    canUseWeapon: () => true,
    canDamage: pctx.canDamage,
    computeConeDeg: () => 0,
    pushEvent: pctx.pushEvent,
    killPlayer: pctx.killPlayer,
    launchGlaive: (p, dir) => projectiles.launchGlaive(p, pctx, dir),
    canThrowGlaive: (p) => projectiles.canThrowGlaive(p),
    returnDiscs: (p) => projectiles.returnDiscs(p, pctx),
  };
  const addVictim = (id, dz, dx = 0, hp = 100, lift = 0.45) => {
    // Raised by default so the owner's level eye-height throw crosses the chest, not the head.
    const victim = new PlayerEntity(id, id, { ...spawn, x: spawn.x + dx, y: spawn.y + lift, z: spawn.z - dz }, false);
    victim.hp = hp;
    victim.yaw = Math.PI;
    pctx.entities.set(victim.id, victim);
    return victim;
  };
  const tick = (ms = DT * 1000) => { pctx.now += ms; projectiles.step(ms / 1000, pctx); };
  const discs = () => [...projectiles.active.values()].filter((p) => p.type === 'glaive');
  const throwDisc = (p = owner) => {
    p.cooldown = 0; p.triggerPrev = false;
    const before = discs().length;
    fireOneShot(p, combat);
    return discs().length > before ? discs().at(-1) : null;
  };
  const ammo = (p = owner) => ({
    mag: p.mag[SLOT],
    inFlight: projectiles.glaiveInFlight(p),
    embedded: [...projectiles.glaivePickups.values()].filter((row) => row.owner === p).length,
    fab: (p.glaiveFab || []).length,
  });
  const invariant = (label, p = owner) => {
    const a = ammo(p);
    const magSize = p.chaosUpgrades?.glaive ? 3 : WEAPONS.glaive.magSize;
    assert.ok(a.mag + a.inFlight + a.embedded + a.fab <= magSize,
      `${label}: invariant holds (${JSON.stringify(a)})`);
    return a;
  };
  return { owner, events, kills, blockHits, projectiles, pctx, combat, world, addVictim, tick, discs,
    throwDisc, ammo, invariant };
}

const hitsOn = (events, victim) => events.filter((e) => e.kind === 'hit' && e.victim === victim.id);
const explodes = (events, disc) => events.filter((e) => e.kind === 'projectileExplode' && e.pid === disc.id);

// ---- Out flight, timed flip, return curvature within 540 deg/s, natural catch ----------
{
  const h = harness();
  const disc = h.throwDisc();
  assert.ok(disc, 'a seated disc launches');
  assert.equal(h.owner.mag[SLOT], 1, 'the throw spends the seated disc');
  const launch = h.events.find((e) => e.kind === 'projectileLaunch' && e.pid === disc.id);
  assert.equal(launch.type, 'glaive');
  assert.equal(launch.phase, 'out');
  assert.equal(launch.flip, RULES.outMs, 'the launch publishes the timed flip');
  assert.equal(launch.bn, RULES.bounces);
  close(Math.hypot(disc.vx, disc.vy, disc.vz), RULES.speedOut, 'the out leg flies at speedOut');
  const start = { x: disc.x, z: disc.z };
  let flips = 0, maxTurn = 0, sawBack = false, farthest = 0;
  let last = null;
  for (let i = 0; i < 80 && h.projectiles.active.has(disc.id); i++) {
    h.tick();
    if (!h.projectiles.active.has(disc.id)) break;
    farthest = Math.max(farthest, Math.hypot(disc.x - start.x, disc.z - start.z));
    if (disc.phase === 'out') {
      assert.equal(disc.vy, 0, 'no gravity on the out leg');
      assert.ok(h.pctx.now - disc.launchedAt <= RULES.outMs, 'the out leg ends on time');
    } else {
      if (!sawBack) close(Math.hypot(disc.vx, disc.vy, disc.vz), RULES.speedBack, 'the back leg flies at speedBack');
      if (sawBack && last) {
        const speed = Math.hypot(disc.vx, disc.vy, disc.vz);
        const cos = (disc.vx * last.x + disc.vy * last.y + disc.vz * last.z) / (speed * Math.hypot(last.x, last.y, last.z));
        maxTurn = Math.max(maxTurn, Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI);
      }
      sawBack = true;
      last = { x: disc.vx, y: disc.vy, z: disc.vz };
    }
    flips += h.events.filter((e) => e.kind === 'projectileUpdate' && e.pid === disc.id && e.flip && e.at === h.pctx.now).length;
  }
  assert.equal(flips, 1, 'exactly one phase flip event');
  const flip = h.events.find((e) => e.kind === 'projectileUpdate' && e.pid === disc.id && e.flip);
  assert.equal(flip.flip, 'time');
  assert.equal(flip.phase, 'back');
  assert.ok(maxTurn > 5, `the return visibly curves (${maxTurn.toFixed(1)} deg/step)`);
  assert.ok(maxTurn <= RULES.turnDegPerSec * DT + 1e-6, `the return turns at most 540 deg/s (${maxTurn.toFixed(2)} deg/step)`);
  assert.ok(farthest > 17 && farthest < 25, `the out leg reaches about 19..22 m (${farthest.toFixed(1)} m)`);
  const syncs = h.events.filter((e) => e.kind === 'projectileUpdate' && e.pid === disc.id && !e.flip);
  assert.ok(syncs.length >= 3 && syncs.every((e) => e.phase === 'back'), 'only the back leg syncs');
  const end = explodes(h.events, disc);
  // Cadence: one sync per 100 ms after the flip (50 ms ticks land each at 100..149 ms).
  const stream = [flip, ...syncs].map((e) => e.at);
  for (let i = 1; i < stream.length; i++) {
    const gap = stream[i] - stream[i - 1];
    assert.ok(gap >= 100 && gap < 150, `back-leg syncs are 100 ms apart (gap ${gap} ms)`);
  }
  assert.ok(syncs.length >= Math.floor((end[0].at - flip.at) / 100) - 1,
    `the sync stream covers the back leg (${syncs.length} syncs over ${end[0].at - flip.at} ms)`);
  assert.equal(end.length, 1);
  assert.equal(end[0].caught, true, 'the returning disc is caught');
  assert.equal(end[0].reason, 'catch');
  assert.equal(end[0].type, 'glaive');
  assert.equal(h.owner.mag[SLOT], 2, 'the catch reseats the disc');
  h.invariant('after a catch');
}

// ---- Catch radius --------------------------------------------------------------------
{
  const owner = { x: 0, y: 0, eyeY: 1.6, z: 0 };
  const target = glaiveTarget(owner);
  close(target.y, 1.6 - 0.35, 'the return aims at the chest');
  for (const [offset, expected] of [[RULES.catchRadius - 0.05, true], [RULES.catchRadius + 0.1, false]]) {
    const disc = { type: 'glaive', phase: 'back', x: target.x + offset, y: target.y, z: target.z,
      vx: 0, vy: 0, vz: RULES.speedBack, bouncesLeft: 0, expiresAt: Infinity };
    stepGlaive(disc, 0.001, () => null, target);
    assert.equal(disc.caught, expected, `a disc ${offset.toFixed(2)} m from the chest ${expected ? 'is' : 'is not'} caught`);
  }
}

// ---- Wall contact on the out leg reflects, flips and chips the block ------------------
{
  const h = harness({ solid: (x, y, z) => z < 41 });
  const disc = h.throwDisc();
  let bounced = false;
  for (let i = 0; i < 80 && h.projectiles.active.has(disc.id); i++) {
    h.tick();
    if (disc.phase === 'back' && !bounced) {
      bounced = true;
      assert.ok(h.pctx.now - disc.launchedAt < RULES.outMs, 'the wall flips the disc before the timer');
      assert.ok(disc.vz > 0, 'the disc reflects off the wall');
    }
  }
  const flip = h.events.find((e) => e.kind === 'projectileUpdate' && e.pid === disc.id && e.flip);
  assert.equal(flip?.flip, 'bounce', 'the first wall contact flips the disc to its return leg');
  assert.equal(h.blockHits.length, 1, 'the bounce damages one block');
  assert.equal(h.blockHits[0].damage, RULES.blockDamage);
  assert.equal(explodes(h.events, disc)[0]?.caught, true, 'the bounced disc still comes home');
}

// ---- Out leg: one cut per victim, pierce limit and falloff ----------------------------
{
  const h = harness();
  const victims = [4, 6, 8, 10].map((dz, i) => h.addVictim(`v${i}`, dz, 0, 1000));
  const disc = h.throwDisc();
  while (h.projectiles.active.has(disc.id) && disc.phase === 'out') h.tick();
  const flipAt = h.pctx.now;
  const outHits = (v) => hitsOn(h.events, v).filter((e) => e.at < flipAt);
  for (let i = 0; i < 3; i++) {
    const rows = outHits(victims[i]);
    assert.equal(rows.length, 1, `victim ${i} takes exactly one out cut`);
    // A level throw at eye height crosses heads, so the zone comes from the hit row.
    close(1000 - victims[i].hp, combatDamage(glaiveLegDamage('out', i, !!rows[0].hs)),
      `victim ${i} takes out * 0.85^${i}`);
  }
  assert.equal(outHits(victims[3]).length, 0, 'the fourth body is past the pierce limit');
  assert.equal(disc.hitOut.size, 3);
  while (h.projectiles.active.has(disc.id)) h.tick();
  for (const v of victims) {
    const rows = hitsOn(h.events, v);
    assert.ok(rows.length <= 2, `${v.id} is cut at most once per leg`);
  }
  assert.ok(disc.hitBack.size <= RULES.pierce, 'the back leg obeys the same pierce limit');
}

// ---- Timed return loops level: a flat throw never dives into the floor ----------------
{
  const h = harness();
  const disc = h.throwDisc();
  const startY = disc.y;
  let lowest = Infinity, widest = 0;
  while (h.projectiles.active.has(disc.id)) {
    h.tick();
    lowest = Math.min(lowest, disc.y);
    widest = Math.max(widest, Math.abs(disc.x - h.owner.x));
  }
  assert.ok(startY - lowest < 0.5, `the return loop stays level (dropped ${(startY - lowest).toFixed(2)} m)`);
  assert.ok(widest > 2, 'the return traces a visible sideways curve');
  assert.equal(explodes(h.events, disc)[0]?.caught, true, 'the level loop still comes home');
}

// ---- Head zone: the disc centre line, not its 0.22 m envelope, picks the zone ---------
{
  const h = harness();
  const victim = h.addVictim('head', 6, 0, 1000, 0);
  const disc = h.throwDisc();
  while (!disc.hitOut.has(victim)) h.tick();
  assert.equal(hitsOn(h.events, victim)[0]?.hs, true, 'a level throw at eye height is a head cut');
  close(1000 - victim.hp, combatDamage(glaiveLegDamage('out', 0, true)), 'the head cut takes headMult');
}
{
  // A centre line that passes over the helmet only grazes with the 0.22 m envelope:
  // a body cut, never a headshot (hitscan's coreHit rule).
  let top = 0;
  const probe = new PlayerEntity('probe', 'probe', { ...spawn, z: spawn.z - 6 }, false);
  probe.yaw = Math.PI;
  for (let y = 1; y < 2.5; y += 0.005) {
    if (rayPlayerHitboxes([probe.x - 10, probe.y + y, probe.z], { x: 1, y: 0, z: 0 }, probe, 20, {})) top = y;
  }
  for (const over of [0.05, 0.15]) {
    const h = harness();
    const victim = h.addVictim(`graze${over}`, 6, 0, 1000, 0);
    const disc = h.throwDisc();
    disc.y = victim.y + top + over;
    while (!disc.hitOut.has(victim) && disc.phase === 'out') h.tick();
    const row = hitsOn(h.events, victim)[0];
    assert.ok(row, `a disc ${over} m over the head still grazes the body`);
    assert.equal(row.hs, false, `a disc ${over} m over the head is not a headshot`);
    close(1000 - victim.hp, combatDamage(glaiveLegDamage('out')), 'the graze deals body damage');
  }
}

// ---- Back leg: one cut per victim, pierce limit and falloff over several ticks -------
{
  const h = harness();
  const victims = [8, 10, 12, 14].map((dz, i) => h.addVictim(`b${i}`, dz, 0, 1000));
  const disc = h.throwDisc();
  h.tick();
  assert.equal(disc.hitOut.size, 0, 'the out leg has not reached the bodies yet');
  h.combat.returnDiscs(h.owner);
  // Send the returning disc back through all four bodies, farthest first.
  disc.x = h.owner.x; disc.z = h.owner.z - 17; disc.y = h.owner.eyeY - 0.35;
  disc.vx = 0; disc.vy = 0; disc.vz = RULES.speedBack;
  let ticks = 0;
  while (h.projectiles.active.has(disc.id)) { h.tick(); ticks++; }
  assert.ok(ticks >= 3, 'the back leg crosses the bodies over several ticks');
  assert.equal(disc.hitBack.size, RULES.pierce, 'the back leg stops at the pierce limit');
  [...victims].reverse().forEach((v, n) => {
    const rows = hitsOn(h.events, v);
    if (n >= RULES.pierce) {
      assert.equal(rows.length, 0, `${v.id} is past the back-leg pierce limit`);
      return;
    }
    assert.equal(rows.length, 1, `${v.id} takes exactly one back cut`);
    close(1000 - v.hp, combatDamage(glaiveLegDamage('back', n, !!rows[0].hs)), `${v.id} takes back * 0.85^${n}`);
  });
  assert.equal(explodes(h.events, disc)[0]?.caught, true, 'the disc still comes home');
}
{
  // Repeated back passes through one body, each past the leg gap: still one back cut.
  const h = harness();
  const victim = h.addVictim('repass', 8, 0, 1000);
  const disc = h.throwDisc();
  h.tick();
  h.combat.returnDiscs(h.owner);
  for (let pass = 0; pass < 3; pass++) {
    h.pctx.now += RULES.legGapMs;
    disc.x = victim.x; disc.z = victim.z - 1.2; disc.y = h.owner.eyeY - 0.35;
    disc.vx = 0; disc.vy = 0; disc.vz = RULES.speedBack;
    h.tick();
  }
  assert.equal(hitsOn(h.events, victim).length, 1, 'the back leg cuts one body once, however often it passes');
}

// ---- Back leg damage, the 120 ms leg gap, kill feed and single attribution ------------
{
  const h = harness();
  const victim = h.addVictim('gap', 3, 0, 1000);
  const disc = h.throwDisc();
  while (!disc.hitOut.has(victim)) h.tick();
  const outAt = disc.lastHitAt.get(victim);
  // Point-blank R: the disc is turned straight back through the same body at once.
  h.combat.returnDiscs(h.owner);
  assert.equal(disc.phase, 'back');
  disc.x = victim.x; disc.z = victim.z - 1.2; disc.y = h.owner.eyeY - 0.35;
  disc.vx = 0; disc.vy = 0; disc.vz = RULES.speedBack;
  h.tick();
  assert.ok(h.pctx.now - outAt < RULES.legGapMs, 'the second pass lands inside the gap');
  assert.equal(disc.hitBack.has(victim), false, 'the back cut is skipped inside the leg gap');
  assert.equal(hitsOn(h.events, victim).length, 1);
  // After the gap the same victim can take its back cut.
  h.pctx.now += RULES.legGapMs;
  disc.x = victim.x; disc.z = victim.z - 1.2; disc.y = h.owner.eyeY - 0.35;
  disc.vx = 0; disc.vy = 0; disc.vz = RULES.speedBack;
  h.tick();
  const rows = hitsOn(h.events, victim);
  assert.equal(rows.length, 2, 'the back cut lands after the gap');
  close(1000 - victim.hp, combatDamage(glaiveLegDamage('out')) + combatDamage(glaiveLegDamage('back')),
    'the back leg deals back damage');
}
{
  const h = harness();
  const victim = h.addVictim('kill', 4);
  const disc = h.throwDisc();
  while (!disc.hitOut.has(victim)) h.tick();
  assert.equal(victim.hp > 0, true, 'one out cut does not kill');
  h.combat.returnDiscs(h.owner);
  h.pctx.now += RULES.legGapMs;
  disc.x = victim.x; disc.z = victim.z - 1.5; disc.y = h.owner.eyeY - 0.35;
  disc.vx = 0; disc.vy = 0; disc.vz = RULES.speedBack;
  for (let i = 0; i < 20 && h.projectiles.active.has(disc.id); i++) h.tick();
  assert.equal(victim.state, 'dead', 'out + back kills');
  assert.equal(h.kills.length, 1, 'the kill is credited once');
  assert.deepEqual(h.kills[0], { victim: 'kill', killer: 'owner', weapon: 'glaive', hs: false },
    'the kill feed names the glaive and its thrower');
  assert.equal(hitsOn(h.events, victim).length, 2, 'one hit per leg, never double-counted');
  assert.ok(h.events.filter((e) => e.kind === 'hit').every((e) => e.attacker === 'owner'), 'every cut credits the thrower');
}

// ---- Catch into the slot after a weapon switch ---------------------------------------
{
  const h = harness();
  const disc = h.throwDisc();
  switchWeapon(h.owner, RIFLE);
  assert.equal(h.owner.weapon, RIFLE);
  while (h.projectiles.active.has(disc.id)) h.tick();
  assert.equal(explodes(h.events, disc)[0].caught, true);
  assert.equal(h.owner.mag[SLOT], 2, 'the catch lands in the RIPTIDE slot while another gun is in hand');
  assert.equal(h.owner.mag[RIFLE], WEAPONS.rifle.magSize, 'the gun in hand is untouched');
}

// ---- Fire gate with two discs in flight ----------------------------------------------
{
  const h = harness();
  assert.ok(h.throwDisc() && h.throwDisc(), 'both discs throw');
  assert.equal(h.owner.mag[SLOT], 0);
  assert.equal(h.projectiles.canThrowGlaive(h.owner), false, 'empty window: nothing seated');
  h.owner.mag[SLOT] = 1; // a stray refill that the normaliser has not trimmed yet
  assert.equal(h.projectiles.canThrowGlaive(h.owner), false, 'two discs out blocks a third');
  assert.equal(h.throwDisc(), null, 'the gate refuses the throw');
  assert.equal(h.owner.mag[SLOT], 1, 'a refused throw spends nothing');
  h.tick();
  assert.equal(h.owner.mag[SLOT], 0, 'the normaliser trims the stray disc');
  h.invariant('two in flight');
}

// ---- R returns only the owner's out-leg discs, never reloads, still acks -------------
{
  const h = harness();
  const other = h.addVictim('other', 0, 6);
  Object.assign(other, { yaw: 0, pitch: 0, deployT: 0, weapon: SLOT, cooldown: 0 });
  const mine = h.throwDisc();
  const theirs = h.throwDisc(other);
  h.tick();
  // Gun Game's infinite magazines make a reload possible, so the branch is really tested.
  h.owner.infiniteMagazines = true;
  assert.equal(h.owner.mag[SLOT], 1, 'a disc is out, so the mag is below magSize');
  h.owner.input = { reload: true, reloadId: 7, wantFire: false, keys: {} };
  h.owner.triggerPrev = false;
  resolveWeaponIntent(h.owner, 0.02, h.combat);
  assert.equal(mine.phase, 'back', 'R turns the owner’s disc home');
  assert.equal(theirs.phase, 'out', 'R never touches another player’s disc');
  assert.equal(h.owner.reloading, false, 'R never sets reloading, even with infinite magazines');
  assert.equal(h.owner.reloadState, null);
  assert.equal(h.owner.mag[SLOT], 1, 'R never touches the seated disc');
  assert.equal(h.owner.reloadAck, 7, 'the reload request is still acknowledged');
  const flip = h.events.filter((e) => e.kind === 'projectileUpdate' && e.flip === 'return');
  assert.deepEqual(flip.map((e) => e.pid), [mine.id], 'one return flip event for the owner’s disc');
  assert.equal(h.projectiles.returnDiscs(h.owner, h.pctx), 0, 'a returning disc is not flipped twice');
}

// ---- Lost discs: embed -> pickup, embed -> 4 s fabricate, broken anchor, fizzle, death --
function embedded() {
  // A slab between the owner and the returning disc: the back leg embeds in it.
  const h = harness({ solid: (x, y, z) => z === 45 && Math.abs(x - 40) < 3 && y >= 20 && y < 23 });
  const disc = h.throwDisc();
  h.tick();
  h.projectiles.returnDiscs(h.owner, h.pctx);
  disc.x = h.owner.x; disc.z = 40; disc.y = h.owner.eyeY - 0.35;
  disc.vx = 0; disc.vy = 0; disc.vz = RULES.speedBack;
  for (let i = 0; i < 10 && h.projectiles.active.has(disc.id); i++) h.tick();
  const end = explodes(h.events, disc)[0];
  assert.equal(end?.reason, 'embed', 'a wall on the return leg embeds the disc');
  assert.equal(end.caught, false);
  assert.equal(h.projectiles.glaivePickups.size, 1, 'the embedded disc is an owner pickup');
  const stock = h.events.filter((e) => e.kind === 'glaiveStock').at(-1);
  assert.equal(stock.id, 'owner');
  assert.equal(stock.pickups.length, 1);
  assert.equal(stock.pickups[0].pid, disc.id);
  assert.ok(Math.abs(stock.pickups[0].regen - RULES.regenMs) <= DT * 1000);
  assert.deepEqual(h.ammo(), { mag: 1, inFlight: 0, embedded: 1, fab: 0 });
  h.invariant('embedded');
  return { h, pickup: [...h.projectiles.glaivePickups.values()][0] };
}
{
  const { h, pickup } = embedded();
  h.tick();
  assert.equal(h.owner.mag[SLOT], 1, 'a distant owner does not collect the pickup');
  Object.assign(h.owner, { x: pickup.x + 1.0, z: pickup.z + 0.5, y: pickup.y - 1.2 });
  h.tick();
  assert.equal(h.owner.mag[SLOT], 2, 'walking within 1.3 m restores the disc instantly');
  assert.equal(h.projectiles.glaivePickups.size, 0);
  assert.equal(h.events.filter((e) => e.kind === 'glaiveStock').at(-1).restored, 'pickup');
}
{
  const { h } = embedded();
  const other = h.addVictim('stranger', 0, 0);
  const pickup = [...h.projectiles.glaivePickups.values()][0];
  Object.assign(other, { x: pickup.x, z: pickup.z + 0.5, y: pickup.y - 1 });
  h.tick();
  assert.equal(h.projectiles.glaivePickups.size, 1, 'the pickup is owner-only');
  const due = pickup.expiresAt;
  while (h.pctx.now < due - DT * 1000) h.tick();
  assert.equal(h.owner.mag[SLOT], 1, 'nothing fabricates early');
  h.tick(); h.tick();
  assert.equal(h.owner.mag[SLOT], 2, 'the launcher fabricates the disc after 4 s');
  assert.equal(h.projectiles.glaivePickups.size, 0, 'the embedded disc despawns');
  assert.equal(h.events.filter((e) => e.kind === 'glaiveStock').at(-1).restored, 'fab');
}
{
  const { h, pickup } = embedded();
  h.world.solid = () => false;
  h.tick();
  assert.equal(h.projectiles.glaivePickups.size, 0, 'a destroyed anchor block removes the pickup');
  assert.deepEqual(h.ammo(), { mag: 1, inFlight: 0, embedded: 0, fab: 1 }, 'the disc still fabricates');
  while (h.pctx.now < pickup.expiresAt) h.tick();
  h.tick();
  assert.equal(h.owner.mag[SLOT], 2, 'on the original schedule');
}
{
  const h = harness();
  const disc = h.throwDisc();
  h.tick();
  disc.explodeAt = disc.expiresAt = h.pctx.now;
  h.tick();
  const end = explodes(h.events, disc)[0];
  assert.equal(end.reason, 'expire', 'a disc still flying after its lifetime fizzles');
  assert.equal(h.projectiles.glaivePickups.size, 0, 'a fizzle leaves no pickup');
  assert.deepEqual(h.ammo(), { mag: 1, inFlight: 0, embedded: 0, fab: 1 }, 'a fizzle queues a fabrication');
  const due = h.owner.glaiveFab[0];
  while (h.pctx.now < due) h.tick();
  assert.equal(h.owner.mag[SLOT], 2, 'the fizzled disc fabricates after 4 s');
}
{
  const h = harness();
  const disc = h.throwDisc();
  h.tick();
  h.owner.state = 'dead';
  h.tick();
  const end = explodes(h.events, disc)[0];
  assert.equal(end.reason, 'owner', 'owner death loses the disc');
  assert.deepEqual(h.ammo(), { mag: 1, inFlight: 0, embedded: 0, fab: 0 }, 'owner death: no pickup and no fabrication');
  h.invariant('owner death');
}
{
  const h = harness();
  const disc = h.throwDisc();
  h.tick();
  h.pctx.entities.delete(h.owner.id);
  h.tick();
  assert.equal(explodes(h.events, disc)[0]?.reason, 'owner', 'a departed owner loses the disc');
}

// ---- Invariant under refill paths -----------------------------------------------------
{
  // Powerup refill: ammo restores spare pools only, and the RIPTIDE has none.
  const h = harness();
  h.throwDisc();
  h.owner.owned = [...WEAPON_IDS];
  h.owner.reserve[SLOT] = 0;
  applyPowerup(h.owner, 'ammo');
  h.tick();
  assert.equal(h.owner.reserve[SLOT], 0, 'no spare discs appear from an ammo pickup');
  h.invariant('powerup refill');
  // A generic full refill with a disc in the air trims the seated count.
  h.owner.mag[SLOT] = WEAPONS.glaive.magSize;
  h.tick();
  assert.deepEqual(h.ammo(), { mag: 1, inFlight: 1, embedded: 0, fab: 0 }, 'discs in the air outrank discs in hand');
}
{
  // Gun Game level-up reassigns a full magazine while one disc flies and one is embedded.
  const { h } = embedded();
  const disc = h.throwDisc();
  assert.ok(disc);
  assert.deepEqual(h.ammo(), { mag: 0, inFlight: 1, embedded: 1, fab: 0 });
  h.owner.glaiveFab = [h.pctx.now + 3000];
  GunGamePolicy.prototype._applyLoadout.call({ _weaponSlot: () => SLOT }, h.owner, { level: 0 });
  assert.equal(h.owner.mag[SLOT], WEAPONS.glaive.magSize);
  h.tick();
  const a = h.invariant('gun game level-up');
  assert.equal(a.inFlight, 1, 'the flying disc survives');
  assert.equal(a.fab, 0, 'queued fabrications are trimmed first');
  assert.equal(a.embedded, 0, 'then embedded pickups');
  assert.equal(a.mag, 1, 'the seated count keeps what remains');
  assert.equal(h.owner.reserve[SLOT], 0, 'the infinite-reserve loadout grants no spare discs');
}
{
  // Spawn refill through the real engine: a fresh life deletes discs, pickups and fabs.
  const game = new GameEngine({ broadcast: () => {} });
  game.addClient('p1', 'Thrower');
  const p = game.entities.get('p1');
  Object.assign(p, { weapon: SLOT, deployT: 0, cooldown: 0, yaw: 0, pitch: 0 });
  const ctx = game.contexts.projectiles;
  p.mag[SLOT]--;
  const disc = game.projectiles.launchGlaive(p, ctx, { x: 0, y: 0, z: -1 });
  p.glaiveFab = [game.now + 9000];
  game.projectiles.glaivePickups.set('stale', { id: 'stale', owner: p, x: p.x, y: p.y, z: p.z, cell: null,
    expiresAt: game.now + 9000 });
  game.respawnPlayer(p);
  assert.equal(game.projectiles.active.has(disc.id), false, 'respawn deletes the owner’s discs');
  assert.equal(game.projectiles.glaivePickups.size, 0, 'respawn deletes the owner’s pickups');
  assert.deepEqual(p.glaiveFab, [], 'respawn clears queued fabrications');
  assert.equal(p.mag[SLOT], WEAPONS.glaive.magSize, 'the fresh life carries a full launcher');
  game.step();
  assert.equal(p.mag[SLOT], WEAPONS.glaive.magSize, 'the normaliser leaves a clean refill alone');
  // Disconnect clears the same state.
  const again = game.projectiles.launchGlaive(p, ctx, { x: 0, y: 0, z: -1 });
  game.removeClient('p1');
  assert.equal(game.projectiles.active.has(again.id), false, 'disconnect deletes the owner’s discs');
  game.stop();
}

// ---- Chaos ladder: Third plate, Razor wake, Long tether ------------------------------
{
  const h = harness({ solid: (x, y, z) => z < 41 });
  h.owner.chaosUpgrades = { glaive: 3 };
  h.tick();
  assert.equal(h.owner.mag[SLOT], 2, 'a refill below the cap is never topped up by the normaliser');
  h.owner.mag[SLOT] = 3;
  assert.ok(h.throwDisc() && h.throwDisc() && h.throwDisc(), 'Third plate: three discs in the air');
  assert.equal(h.projectiles.canThrowGlaive(h.owner), false);
  const disc = h.discs()[0];
  assert.equal(disc.rules.outMs, 800, 'Long tether lengthens the out leg');
  assert.equal(disc.rules.pierce, 5, 'Long tether pierces five bodies');
  const launch = h.events.find((e) => e.kind === 'projectileLaunch' && e.pid === disc.id);
  assert.equal(launch.flip, 800);
  assert.equal(launch.chaos, 3);
  for (let i = 0; i < 20; i++) h.tick();
  const blasts = h.events.filter((e) => e.kind === 'projectileExplode' && e.type === 'pulse');
  assert.ok(blasts.length >= 3, 'Razor wake: every wall contact sheds a shockwave');
  assert.ok(blasts.every((e) => e.radius === 2.5));
  h.invariant('chaos');
  const game = new GameEngine({ broadcast: () => {}, mode: 'chaos' });
  game.addClient('c1', 'Chaos');
  const c = game.entities.get('c1');
  c.credits = 16000;
  assert.equal(game.mode.purchase(c, 'chaos:glaive:1'), true);
  assert.equal(c.mag[SLOT], 3, 'buying Third plate seats the third disc');
  game.respawnPlayer(c);
  assert.equal(c.mag[SLOT], 3, 'a fresh life under Third plate carries three discs');
  game.stop();
}

// ---- Owner death drops embedded pickups with a published (empty) stock -------------
{
  const { h } = embedded();
  const before = h.events.length;
  h.owner.state = 'dead';
  h.tick();
  assert.equal(h.projectiles.glaivePickups.size, 0, 'owner death removes the pickup');
  const stock = h.events.slice(before).filter((e) => e.kind === 'glaiveStock' && e.id === 'owner').at(-1);
  assert.ok(stock, 'owner death publishes the owner’s stock');
  assert.deepEqual(stock.pickups, [], 'the published stock carries no pickups, so clients drop the ghost');
}

// ---- R never holds the hands: a vault survives R under infinite magazines -----------
{
  const p = new PlayerEntity('vaulter', 'Vaulter', spawn, false);
  Object.assign(p, { weapon: SLOT, deployT: 0, infiniteMagazines: true });
  p.mag[SLOT] = 1;
  p.vault = { from: { x: p.x, y: p.y, z: p.z }, to: { x: p.x, y: p.y + 1, z: p.z - 1 }, elapsed: 0 };
  p.input = { reload: true, reloadId: 3, wantFire: false, keys: {}, yaw: 0, pitch: 0 };
  stepMovement(p, 0.02, { solidAt: () => false, fluidAt: () => false, mapMeta: null, now: 1000,
    movementLocked: false, onFall() {} });
  assert.ok(p.vault, 'R on the RIPTIDE does not cancel a vault');
}

// ---- S&D survivor keeps discs that were flying at the round restart -----------------
{
  const game = new GameEngine({ broadcast: () => {}, mode: 'snd' });
  game.addClient('p1', 'A');
  game.addClient('p2', 'B');
  const p = game.entities.get('p1');
  const policy = game.mode.policy;
  const state = policy._state(p);
  state.owned.add('glaive');
  p.mag[SLOT] = 2;
  p.weapon = SLOT;
  const ctx = game.contexts.projectiles;
  p.mag[SLOT]--;
  game.projectiles.launchGlaive(p, ctx, { x: 0, y: 0, z: -1 });
  p.mag[SLOT]--;
  game.projectiles.launchGlaive(p, ctx, { x: 1, y: 0, z: 0 });
  assert.equal(game.projectiles.glaiveStock(p), 2);
  state.survived = true;
  policy._startNextRound(false);
  assert.equal(game.projectiles.glaiveInFlight(p), 0, 'the round restart clears the discs in the air');
  assert.equal(p.mag[SLOT], WEAPONS.glaive.magSize, 'the survivor keeps both discs, seated');
  for (let i = 0; i < 5; i++) game.step();
  assert.equal(p.mag[SLOT], WEAPONS.glaive.magSize, 'the normaliser leaves the carried discs alone');
  game.stop();
}

// ---- Presentation: timers and snaps never invent a flare or a cassette lift ---------
{
  const step = (pres, seconds) => { for (let t = 0; t < seconds - 1e-9; t += 1 / 60) pres.update(1 / 60); };
  // A disc caught before its timed flip (early R or a near wall) never flares afterwards.
  const pres = new GlaivePresentation(null);
  pres.reset(2);
  pres.throw();
  step(pres, 0.2);
  pres.returnLeg({ all: false });
  step(pres, 0.2);
  pres.setDiscs(2);
  pres.caught();
  step(pres, 0.35);
  assert.equal(pres.returnAt.length, 0, 'the observed flip and the catch consume the flip timer');
  step(pres, 0.3);
  assert.equal(pres.returnT, null, 'no stale timer flares the horns after the catch');
  // Same without any observed flip (a remote mount): the catch alone consumes the timer.
  const remote = new GlaivePresentation(null);
  remote.reset(2);
  remote.throw();
  step(remote, 0.4);
  remote.setDiscs(2);
  remote.caught();
  step(remote, 0.5);
  assert.equal(remote.returnT, null, 'a disc caught before its flip time never flares afterwards');
  // A draw or respawn snaps to the authoritative count without a fake cassette lift.
  const draw = new GlaivePresentation(null);
  draw.reset(0);
  draw.setDiscs(2);
  step(draw, 0.3);
  assert.equal(draw.liftT, null, 'the first count after a reset is a snap, not a gain');
  assert.equal(draw.gainT, null);
  draw.setDiscs(1);
  draw.setDiscs(2);
  assert.equal(draw.gainT, 0, 'a later gain still plays the fabricate/pickup lift');
}

console.log('GLAIVE: scale-derived damage, flight legs, bounce, 540 deg/s return, per-leg pierce, leg gap, catch in any hand, fire gate, R-return ack, embed pickup/fabricate, fizzle, owner loss, refill invariant, resets and Chaos ladder passed.');
