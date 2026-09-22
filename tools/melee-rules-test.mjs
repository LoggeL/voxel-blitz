import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { resolveWeaponIntent } from '../server/sim/combat.js';
import { stepMovement, updateTimers } from '../server/sim/movement.js';
import { aimAngles } from '../server/sim/player.js';
import { WEAPON_IDS, WEAPONS, EYE_HEIGHT } from '../shared/combatmath.js';
import { combatDamage } from '../shared/combat-balance.js';
import {
  MELEE_RULES, MELEE_HIT_KINDS, meleeCritEligible, meleeHitProfile, meleeDamage,
  knockbackResistance, applyMeleeKnockback,
} from '../shared/melee.js';
import { AIR, CONCRETE, GRASS, GROUND, METAL, SX, SY, SZ, createMapState } from '../shared/worlddata.js';
import { TICK_MS } from '../server/protocol/admission.js';

// IRON PICK (`knife`) attack rules: Minecraft falling crit, shove on every hit,
// sprint knockback, the tagged hit event and bots that actually swing.
const KNIFE = WEAPON_IDS.indexOf('knife');
const def = WEAPONS.knife;

// ---------------------------------------------------------------- pure rules
{
  assert.equal(def.name, 'IRON PICK');
  assert.deepEqual([def.rpm, def.damage[0], def.melee.reach, def.melee.coneDeg, def.melee.backstabMult,
    def.melee.backstabDot], [120, 58, 2.2, 110, 2.5, 0.4], 'base pick numbers stay pinned');
  assert.equal(def.melee.critMult, MELEE_RULES.critMult);
  assert.deepEqual(MELEE_HIT_KINDS, ['strong', 'crit', 'knockback', 'backstab']);
  const fall = { grounded: false, vy: -3 };
  assert.equal(meleeCritEligible(fall), true, 'airborne and falling crits');
  for (const [label, patch, opts] of [
    ['grounded', { grounded: true }], ['rising', { vy: 2 }], ['apex', { vy: 0 }],
    ['swimming', { swimming: true }], ['vaulting', { vault: {} }], ['riding', { slide: {} }],
    ['prone', { proneT: 0.5 }], ['ladder', {}, { ladder: true }], ['sprinting', { sprint: true }],
  ]) assert.equal(meleeCritEligible({ ...fall, ...patch }, opts), false, `${label} never crits`);

  const kinds = (a, backstab) => meleeHitProfile(def, a, { backstab }).kind;
  const stand = { grounded: true, vy: 0, sprint: false };
  assert.equal(kinds(stand, false), 'strong');
  assert.equal(kinds({ ...stand, sprint: true }, false), 'knockback');
  assert.equal(kinds(fall, false), 'crit');
  assert.equal(kinds({ ...fall, sprint: true }, false), 'knockback', 'a sprinting fall is a knockback hit, never a crit');
  assert.equal(kinds({ ...fall, sprint: true }, true), 'backstab', 'backstab outranks everything');
  const strong = meleeHitProfile(def, stand), crit = meleeHitProfile(def, fall);
  const sprintHit = meleeHitProfile(def, { ...fall, sprint: true });
  assert.equal(strong.mult, 1);
  assert.equal(crit.mult, 1.5);
  assert.equal(meleeHitProfile(def, fall, { backstab: true }).mult, 2.5, 'backstab and crit never stack');
  assert.equal(strong.knockback, MELEE_RULES.knockback.base, 'every hit shoves');
  assert.equal(crit.knockback, MELEE_RULES.knockback.base, 'a crit only shoves a little');
  assert.equal(sprintHit.knockback, MELEE_RULES.knockback.sprint, 'the sprint hit knocks back hard');
  assert.equal(sprintHit.mult, 1, 'the sprint hit deals plain damage');
  assert.ok(Math.abs(meleeDamage(def, 1) - 46.4) < 1e-9);
  assert.ok(Math.abs(meleeDamage(def, 1.5) - 69.6) < 1e-9, 'crit + strong (116) kills where three strongs were needed');
  assert.ok(Math.abs(meleeDamage(def, 2.5) - 116) < 1e-9);
  assert.equal(meleeDamage(def, 1), combatDamage(def.damage[0]));

  assert.equal(knockbackResistance({}), 0);
  assert.equal(knockbackResistance({ objective: true }), 1, 'objectives never move');
  assert.equal(knockbackResistance({ npcRole: 'apc' }), 1, 'vehicles never move');
  assert.equal(knockbackResistance({ npcRole: 'runner' }), 0);
  assert.ok(Math.abs(knockbackResistance({ npcRole: 'juggernaut' }) - 0.6) < 1e-9, 'big bodies brace');
  const v = { state: 'alive', grounded: true, vx: 2, vy: 0, vz: 0, impulseSeq: 0, vault: {} };
  applyMeleeKnockback(v, 0, MELEE_RULES.knockback.base); // yaw 0 swings toward -Z
  assert.deepEqual([v.vx, v.vy, v.vz], [1, 4, -4.5], 'shove halves own speed, adds the swing push and a hop');
  assert.equal(v.impulseSeq, 1);
  assert.equal(v.grounded, false);
  assert.equal(v.vault, null);
  const air = { state: 'alive', grounded: false, vx: 0, vy: -5, vz: 0 };
  applyMeleeKnockback(air, Math.PI / 2, MELEE_RULES.knockback.sprint); // yaw +90deg swings toward -X
  assert.ok(Math.abs(air.vx + 9.5) < 1e-9 && Math.abs(air.vz) < 1e-9 && air.vy === -5,
    'an airborne victim keeps its vertical speed');
  assert.equal(applyMeleeKnockback({ state: 'dead' }, 0, MELEE_RULES.knockback.base), 0);
}

// ------------------------------------------- authoritative swings (real engine)
const world = createMapState('foundry');
const engine = new GameEngine({ world });
for (let x = 56; x < 76; x++) for (let z = 40; z < 56; z++) {
  for (let y = 15; y <= 22; y++) world.setBlock(x, y, z, AIR);
  world.setBlock(x, 14, z, GRASS);
}
const eyeY = 15 + EYE_HEIGHT;
const combat = engine.contexts.combat;
function seat(id, x, z, lookX, lookZ = 48, weapon = KNIFE) {
  if (!engine.entities.has(id)) engine.addClient(id, id);
  const p = engine.entities.get(id);
  Object.assign(p, { x, y: 15, z, vx: 0, vy: 0, vz: 0, weapon, deployT: 0, cooldown: 0,
    grounded: true, sprint: false, spawnProtectedUntil: 0, spawnProtected: false, armor: 0, hp: 100 });
  const a = aimAngles([x, eyeY, z], [lookX, eyeY, lookZ]);
  p.yaw = a.yaw; p.pitch = a.pitch;
  engine.applyInput(id, { yaw: a.yaw, pitch: a.pitch, wantFire: false });
  return p;
}
function swing(p, patch = {}) {
  engine.tickEvents.length = 0;
  Object.assign(p, patch);
  engine.applyInput(p.id, { wantFire: true });
  resolveWeaponIntent(p, 0.016, combat);
  engine.applyInput(p.id, { wantFire: false });
  return engine.tickEvents.filter(e => e.kind === 'hit');
}
{
  // Strong hit: tagged, base damage, a small shove toward +X (the swing yaw).
  const hero = seat('hero', 60, 48, 62);
  const foe = seat('foe', 62, 48, 58);
  const [hit] = swing(hero);
  assert.deepEqual([hit.w, hit.mk, hit.q, hit.dmg, hit.hs], ['knife', 'strong', 0, 46, false]);
  assert.ok(Math.abs(foe.hp - 53.6) < 1e-9);
  assert.equal(foe.impulseSeq, 1, 'every melee hit publishes an impulse');
  assert.ok(Math.abs(foe.vx - 4.5) < 1e-9 && Math.abs(foe.vz) < 1e-9 && foe.vy === 4, 'base shove along the swing');

  // Falling crit: x1.5, wire dmg 70; two hits (crit + strong) now kill.
  const crit = seat('crit-foe', 62, 48, 58); foe.state = 'dead';
  const [c] = swing(seat('hero', 60, 48, 62), { grounded: false, vy: -4 });
  assert.deepEqual([c.victim, c.mk, c.dmg], ['crit-foe', 'crit', 70]);
  assert.ok(Math.abs(crit.hp - 30.4) < 1e-9);
  updateTimers(hero, 0.5);
  const [finish] = swing(hero, { grounded: true, vy: 0 });
  assert.equal(finish.lethal, true, 'crit + strong kills');
  assert.equal(crit.impulseSeq, 1, 'a lethal hit launches no knockback impulse');

  // Sprint hit: knockback kind and the hard shove, which carries ~2.6 m.
  const runner = seat('runner', 62, 48, 58);
  const [k] = swing(seat('hero', 60, 48, 62), { sprint: true });
  assert.deepEqual([k.mk, k.dmg], ['knockback', 46]);
  assert.ok(Math.abs(runner.vx - 9.5) < 1e-9 && runner.vy === 6);
  const startX = runner.x;
  runner.input = null;
  for (let i = 0; i < 90; i++) stepMovement(runner, 1 / 60, engine.contexts.movement);
  const sprintTravel = runner.x - startX;
  assert.ok(runner.grounded && sprintTravel > 2.4 && sprintTravel < 3.1, `sprint knockback carries ~2.6 m (${sprintTravel.toFixed(2)})`);

  // Base shove travel for the same standing victim: ~1.05 m.
  const walker = seat('walker', 62, 50, 58, 50); runner.state = 'dead';
  swing(seat('hero', 60, 50, 62, 50));
  const walkStart = walker.x; walker.input = null;
  for (let i = 0; i < 90; i++) stepMovement(walker, 1 / 60, engine.contexts.movement);
  const baseTravel = walker.x - walkStart;
  assert.ok(walker.grounded && baseTravel > 0.9 && baseTravel < 1.35, `base shove carries ~1.05 m (${baseTravel.toFixed(2)})`);
  walker.state = 'dead';

  // Backstab outranks crit and sprint: one-shot, tagged backstab.
  const back = seat('back', 62, 48, 70);
  const [b] = swing(seat('hero', 60, 48, 62), { grounded: false, vy: -2, sprint: true });
  assert.deepEqual([b.mk, b.dmg, b.lethal], ['backstab', 116, true]);
  assert.equal(back.state, 'dead');

  // Armor soaks the whole strong hit: armor fields survive, tag still present.
  const tank = seat('tank', 62, 48, 58); tank.armor = 100;
  const [a] = swing(seat('hero', 60, 48, 62));
  assert.deepEqual([a.w, a.mk, a.healthDamage, a.lethal], ['knife', 'strong', 0, false]);
  assert.equal(tank.hp, 100);
  tank.state = 'dead';

  // Quick melee (V) from a rifle: same rules, q flag set.
  const qFoe = seat('q-foe', 62, 48, 58);
  const qHero = seat('hero', 60, 48, 62, 48, WEAPON_IDS.indexOf('rifle'));
  engine.tickEvents.length = 0;
  qHero.quickMeleeQueued = { yaw: qHero.yaw, pitch: qHero.pitch };
  resolveWeaponIntent(qHero, 0.016, combat);
  const [q] = engine.tickEvents.filter(e => e.kind === 'hit');
  assert.deepEqual([q.w, q.mk, q.q, q.victim], ['knife', 'strong', 1, 'q-foe']);
  assert.equal(qHero.weapon, WEAPON_IDS.indexOf('rifle'));
  qFoe.state = 'dead';
}

// ---------------------------------------------------------- bots swing the pick
{
  const FEET_Y = GROUND + 1.02;
  const meta = Object.freeze({ id: 'foundry', spawns: { fun: [
    { x: 16.5, y: FEET_Y, z: 16.5, index: 0 }, { x: 24.5, y: FEET_Y, z: 16.5, index: 1 }] } });
  const flat = {
    meta,
    getBlock(x, y, z) {
      x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
      if (y < 0 || x < 0 || z < 0 || x >= SX || z >= SZ) return METAL;
      return y >= SY ? AIR : y <= GROUND ? CONCRETE : AIR;
    },
    setBlock() { return false; },
    heightAt: (x, z) => (x >= 0 && z >= 0 && x < SX && z < SZ ? GROUND : -1),
    findSpawns: n => Array.from({ length: n }, (_, i) => ({ ...meta.spawns.fun[i % 2], index: i % 2 })),
  };
  const realNow = Date.now;
  Date.now = () => 1_000_000;
  let gg;
  try { gg = new GameEngine({ mode: 'gungame', world: flat, mapMeta: meta }); } finally { Date.now = realNow; }
  const bots = attachBots(gg, 1);
  gg.addClient('dummy', 'Dummy');
  const bot = gg.entities.get('bot-0'), dummy = gg.entities.get('dummy');
  const order = gg.mode.policy.weaponOrder;
  assert.equal(order.at(-1), 'knife');
  for (let level = 0; level < order.length - 1; level++) {
    gg.killPlayer(dummy, bot, order[level], false, {});
    gg.forceRespawn(dummy);
  }
  assert.deepEqual(gg.mode.playerSnapshot(bot).owned, ['knife'], 'bot reached the pick level');
  const place = (p, x, z, yaw) => Object.assign(p, { x, y: FEET_Y, z, vx: 0, vy: 0, vz: 0, yaw, pitch: 0,
    grounded: true, spawnProtectedUntil: 0, spawnProtected: false, hp: 100, armor: 0 });
  // 7 m apart on open concrete, the bot facing the idle dummy (+X).
  place(bot, 20.5, 30.5, -Math.PI / 2);
  place(dummy, 27.5, 30.5, Math.PI / 2);
  gg.applyInput('dummy', { yaw: Math.PI / 2, pitch: 0, keys: {} });
  const hits = [], inputs = [];
  const push = gg.tickEvents.push.bind(gg.tickEvents);
  gg.tickEvents.push = (...events) => { hits.push(...events.filter(e => e.kind === 'hit')); return push(...events); };
  const apply = gg.applyInput.bind(gg);
  gg.applyInput = (id, input) => { if (id === 'bot-0') inputs.push(structuredClone(input)); return apply(id, input); };
  for (let i = 0; i < Math.round(6000 / TICK_MS) && !hits.length; i++) gg.step(TICK_MS);
  const first = hits.find(h => h.attacker === 'bot-0');
  assert.ok(first, 'a knife-only bot closes in and swings');
  assert.equal(first.w, 'knife');
  assert.ok(['knockback', 'crit'].includes(first.mk), `the bot sprints or hops into its first swing (${first.mk})`);
  assert.equal(bot.weapon, KNIFE, 'an empty magazine never switches the pick away');
  assert.ok(inputs.some(i => i.keys.sprint && i.keys.f), 'the bot sprints in from range');
  assert.ok(!inputs.some(i => i.reload), 'the pick never asks for a reload');

  // A pick holder that also owns a loaded gun draws it for a far target.
  bots.prepareLoadout = () => [0, KNIFE];
  bots.preferredSlot = () => KNIFE;
  bot.mag[0] = WEAPONS.rifle.magSize; // Gun Game strips the other slots
  place(bot, 20.5, 30.5, -Math.PI / 2);
  place(dummy, 50.5, 30.5, Math.PI / 2);
  inputs.length = 0;
  for (let i = 0; i < Math.round(1500 / TICK_MS) && !inputs.some(x => x.switchTo === 0); i++) gg.step(TICK_MS);
  assert.ok(inputs.some(x => x.switchTo === 0), 'a far target makes the pick give way to a loaded gun');
  bots.dispose();
}

// ------------------------------------- TTT prep: the knife "fires" but never hurts
{
  const tw = createMapState('foundry');
  for (let x = 56; x < 76; x++) for (let z = 40; z < 56; z++) {
    for (let y = 15; y <= 22; y++) tw.setBlock(x, y, z, AIR);
    tw.setBlock(x, 14, z, GRASS);
  }
  // A wall right behind the dummy: a live swing along the aim ray would chip it.
  for (let z = 44; z < 53; z++) for (let y = 15; y <= 18; y++) tw.setBlock(66, y, z, CONCRETE);
  const ttt = new GameEngine({ mode: 'ttt', world: tw });
  const tBots = attachBots(ttt, 1);
  ttt.addClient('idle', 'Idle');
  const policy = ttt.mode.policy;
  assert.equal(policy.phase, 'prep');
  const bot = ttt.entities.get('bot-0'), idle = ttt.entities.get('idle');
  assert.equal(bot.weapon, KNIFE);
  assert.equal(ttt.mode.canFire(bot), true, 'prep lets the knife fire');
  assert.equal(ttt.mode.canDamage(bot, idle), false);
  const place = (p, x, z, yaw) => Object.assign(p, { x, y: 15, z, vx: 0, vy: 0, vz: 0, yaw, pitch: 0,
    grounded: true, spawnProtectedUntil: 0, spawnProtected: false, hp: 100, armor: 0 });
  place(bot, 63.5, 48.5, -Math.PI / 2);
  place(idle, 65.2, 48.5, Math.PI / 2);
  ttt.applyInput('idle', { yaw: Math.PI / 2, pitch: 0, keys: {} });
  const events = [], inputs = [];
  const push = ttt.tickEvents.push.bind(ttt.tickEvents);
  ttt.tickEvents.push = (...ev) => { events.push(...ev); return push(...ev); };
  const apply = ttt.applyInput.bind(ttt);
  ttt.applyInput = (id, input) => { if (id === 'bot-0') inputs.push(structuredClone(input)); return apply(id, input); };
  for (let i = 0; i < Math.round(2500 / TICK_MS); i++) {
    ttt.step(TICK_MS);
    Object.assign(idle, { x: 65.2, z: 48.5, hp: 100 });
  }
  assert.equal(policy.phase, 'prep', 'the case stays inside prep');
  assert.ok(inputs.length > 0);
  assert.ok(!inputs.some(i => i.wantFire), 'a prep bot never swings the pick at a player');
  assert.ok(!inputs.some(i => i.keys?.jump && i.keys?.f && i.keys?.sprint), 'no crit hop charge in prep');
  assert.ok(!events.some(e => e.kind === 'mine' && e.id === 'bot-0'), 'no wall behind the target gets mined');
  assert.ok(!events.some(e => e.kind === 'hit' && e.attacker === 'bot-0'));
  tBots.dispose();
}

console.log('Melee rules: IRON PICK crit, knockback travel, hit tags, precedence, armor, quick melee, bot swings and TTT prep restraint passed.');
