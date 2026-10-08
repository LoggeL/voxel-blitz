// Conquest classes: the nine kits (five base, four level unlocks), the Medic
// (revive moved off the Assault, heal aura, medkit restock), the passive kit
// abilities (adrenaline, fireproof, ordnance, ghost, overwatch), the
// authoritative level gate at deploy, the career XP for teamplay, the bot
// squad slot table and the deploy-picker read model (locked cards).
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONQUEST_CONTRACT_VERSION, CONQUEST_EVENT_KINDS, CONQUEST_RULES, KITS, KIT_IDS, SCORE_LABELS, SCORE_POINTS, decodeConquestPlayer,
} from '../shared/conquest-contract.js';
import {
  BOT_FLEX_POOL, BOT_SQUAD_SLOTS, KIT_ABILITY_LABELS, KIT_MENU, KIT_MENU_ORDER, KIT_ROLE_RULES, botSquadKit, kitAbilityHint,
  kitDigitWeapon, kitIndex, kitLoadout, kitMaxGrenades, kitUnlockLevel, kitUnlocked, unlockedKits,
} from '../shared/conquest-kits.js';
import { CAREER_REWARDS, careerLevel } from '../shared/career.js';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';
import { GRENADE_TYPE_IDS } from '../shared/grenade-rules.js';
import { PlayerEntity } from '../server/sim/player.js';
import { updateBurn } from '../server/sim/fire.js';
import { createConquestRoles } from '../server/modes/conquest/roles.js';
import { ScoreLedger } from '../server/modes/conquest/score.js';
import { careerLevelOf, mayUseKit } from '../server/modes/conquest/deploy.js';
import {
  CONQUEST_CONTRACT, CONQUEST_KIT_IDS, CONQUEST_CLASS_EVENT_KINDS,
} from './lib/protocol-contract.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const DIMS = { sx: 256, sy: 64, sz: 256 };
const TICK = 1000 / 60;
const slot = id => WEAPON_IDS.indexOf(id);
const gslot = id => GRENADE_TYPE_IDS.indexOf(id);
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };

// ------------------------------------------------------------ kit table --
{
  eq(KIT_IDS, ['assault', 'engineer', 'support', 'recon', 'medic', 'pyro', 'grenadier', 'raider', 'marksman'], 'KIT_IDS only grows at the end');
  eq(KIT_IDS.slice(0, 4).map(kitIndex), [0, 1, 2, 3], 'cq[0] indices 0-3 keep their v2 kits');
  eq(kitIndex('marksman'), 8, 'cq[0] reaches 8');
  eq(decodeConquestPlayer({ cq: [4, 1, 0, 0, 0, 0, 0] }).kit, 'medic', 'cq[0] = 4 decodes as the Medic');
  eq(decodeConquestPlayer({ cq: [8, 1, 0, 0, 0, 0, 0] }).kit, 'marksman');
  eq(KIT_MENU_ORDER, ['assault', 'medic', 'engineer', 'support', 'recon', 'pyro', 'grenadier', 'raider', 'marksman']);
  eq(KIT_MENU.map(k => k.id), KIT_MENU_ORDER, 'deploy menu follows the display order');
  eq(Object.fromEntries(KIT_IDS.map(id => [id, kitUnlockLevel(id)])),
    { assault: 1, engineer: 1, support: 1, recon: 1, medic: 1, pyro: 3, grenadier: 5, raider: 7, marksman: 9 });
  eq(unlockedKits(1), ['assault', 'medic', 'engineer', 'support', 'recon']);
  eq(unlockedKits(5), ['assault', 'medic', 'engineer', 'support', 'recon', 'pyro', 'grenadier']);
  ok(!kitUnlocked('pyro', 2) && kitUnlocked('pyro', 3) && kitUnlocked('marksman', 12), 'kitUnlocked compares levels');
  ok(!kitUnlocked('nope', 99), 'unknown kits are never unlocked');
  eq(KITS.assault.ability, 'adrenaline', 'the Assault lost revive');
  eq(KITS.medic.ability, 'revive'); eq(KITS.medic.aura, 'heal');
  eq(Object.entries(KITS).filter(([, k]) => k.ability === 'revive').map(([id]) => id), ['medic'], 'only the Medic revives');
  eq(KITS.assault.primaries, ['rifle', 'shotgun']); eq(KITS.assault.grenades, { frag: 2, pulse: 1 });
  eq(KITS.medic.primaries, ['smg', 'longarc']); eq(KITS.medic.grenades, { smoke: 2, frag: 1 });
  eq(KITS.pyro.primaries, ['flamethrower', 'shotgun']); eq(KITS.pyro.grenades, { molotov: 2, smoke: 1 });
  eq(KITS.grenadier.primaries, ['mgl', 'bubble']); eq(KITS.grenadier.grenades, { frag: 2, smoke: 1 });
  eq(KITS.raider.primaries, ['glaive', 'smg']); eq(KITS.raider.grenades, { frag: 1, limpet: 1 });
  eq(KITS.marksman.primaries, ['lance', 'longarc']); eq(KITS.marksman.grenades, { pulse: 1, smoke: 1 });
  eq(Object.entries(KITS).filter(([, k]) => k.primaries.includes('rifle')).map(([id]) => id), ['assault'], 'the RAPTOR stays unique to the Assault');
  for (const id of KIT_IDS) {
    for (const p of KITS[id].primaries) ok(WEAPON_IDS.includes(p), `${id} primary ${p} is a real weapon`);
    for (const g of Object.keys(KITS[id].grenades)) ok(GRENADE_TYPE_IDS.includes(g), `${id} grenade ${g} is real`);
    ok(KIT_ABILITY_LABELS[KITS[id].ability], `${id} ability has a label`);
    ok(kitAbilityHint(id, CONQUEST_RULES).length > 0, `${id} ability has a hint`);
    for (const variant of [0, 1]) {
      const load = kitLoadout(id, variant);
      // Kit-relative digits: 1 primary, 2 IRONCLAD, 4 IRON PICK cover every new kit.
      eq(kitDigitWeapon(load.owned, 0), KITS[id].primaries[variant], `${id}/${variant} key 1 raises the primary`);
      eq(kitDigitWeapon(load.owned, 1), 'revolver', `${id}/${variant} key 2 raises the sidearm`);
      eq(kitDigitWeapon(load.owned, 3), 'knife', `${id}/${variant} key 4 raises the melee tool`);
    }
  }
  // Hints are formatted from the rule tables, never hard-coded.
  ok(kitAbilityHint('medic').includes(`${KIT_ROLE_RULES.healRadius} M`), 'medic hint names the heal radius');
  ok(kitAbilityHint('medic').includes(`${KIT_ROLE_RULES.healPerPulse * 1000 / KIT_ROLE_RULES.healIntervalMs} HP/S`));
  ok(kitAbilityHint('grenadier').includes(`${KIT_ROLE_RULES.ordnanceIntervalMs / 1000} S`));
  eq(SCORE_POINTS.heal, 10); eq(SCORE_LABELS.heal, 'HEAL'); eq(SCORE_POINTS.revive, 100);
  ok(CONQUEST_EVENT_KINDS.includes('heal') && CONQUEST_EVENT_KINDS.includes('kit_unlocks'), 'heal and kit_unlocks are Conquest events');
  // Pinned protocol contract.
  eq(CONQUEST_CONTRACT_VERSION, CONQUEST_CONTRACT.version, 'contract version pinned');
  eq(CONQUEST_CONTRACT_VERSION, 3);
  eq([...KIT_IDS], CONQUEST_KIT_IDS.split(','), 'KIT_IDS pinned in the protocol contract');
  for (const kind of CONQUEST_CLASS_EVENT_KINDS.split(',')) ok(CONQUEST_EVENT_KINDS.includes(kind), `${kind} pinned`);
}

// ----------------------------------------------------- bot squad table --
{
  eq(BOT_SQUAD_SLOTS, ['assault', 'medic', 'engineer', 'flex']);
  eq(botSquadKit(0, { team: 'alpha', squadId: 1, seed: 7 }), 'assault');
  eq(botSquadKit(1, { team: 'alpha', squadId: 1, seed: 7 }), 'medic', 'every squad has a Medic in slot 1');
  eq(botSquadKit(2, { team: 'bravo', squadId: 2, seed: 7 }), 'engineer');
  const flex = new Set();
  for (let seed = 0; seed < 200; seed++) for (const team of ['alpha', 'bravo']) for (const squadId of [1, 2]) {
    const kit = botSquadKit(3, { team, squadId, seed });
    ok(BOT_FLEX_POOL.includes(kit), `flex kit ${kit} comes from the pool`);
    flex.add(kit);
  }
  eq([...flex].sort(), [...new Set(BOT_FLEX_POOL)].sort(), 'every pool kit shows up over many matches');
  eq(botSquadKit(3, { team: 'alpha', squadId: 1, seed: 42 }), botSquadKit(3, { team: 'alpha', squadId: 1, seed: 42 }), 'stable per match');
}

// --------------------------------------------------------------- fixture --
function fixture() {
  const engine = { now: 100000, entities: new Map(), tickEvents: [], solidAt: (_x, y) => y < 10, vehicles: null,
    projectiles: { smoke: { blocksSight: () => false } } };
  const policy = {
    phase: 'live', awards: [], events: [],
    teamFor: p => p?.team ?? null,
    award(id, reason, scale = 1) { this.awards.push([id, reason, scale]); },
    _emit(kind, fields) { this.events.push({ kind, ...fields }); },
    refundTicket() {},
  };
  const roles = createConquestRoles({ policy, engine, rules: CONQUEST_RULES });
  const add = (id, team, kit, variant, x, z, y = 10) => {
    const p = new PlayerEntity(id, id, { x, y, z }, false, DIMS);
    p.team = team;
    engine.entities.set(id, p);
    roles.applyLoadout(p, kit, variant);
    roles.onRespawn(p);
    return p;
  };
  const step = (ms = TICK) => { engine.now += ms; roles.tick(engine.now, ms); };
  const run = ms => { for (let t = 0; t < ms; t += TICK) step(); };
  // Set HP without it reading as a hit (the aura pauses after damage).
  const setHp = (p, hp) => { p.hp = hp; const st = roles.states.get(p.id); if (st) { st.lastHp = hp; st.lastDamagedAt = -Infinity; } };
  return { engine, policy, roles, add, step, run, setHp };
}

// ------------------------------------------------------- medic heal aura --
{
  const f = fixture();
  const medic = f.add('m', 'alpha', 'medic', 0, 50, 50);
  const mate = f.add('a', 'alpha', 'assault', 0, 54, 50);
  const far = f.add('far', 'alpha', 'support', 0, 50 + KIT_ROLE_RULES.healRadius + 1, 50 + 3);
  const foe = f.add('e', 'bravo', 'recon', 0, 52, 50);
  f.step();
  f.setHp(mate, 40); f.setHp(far, 40); f.setHp(foe, 40); f.setHp(medic, 60);
  f.run(KIT_ROLE_RULES.healIntervalMs + 50);
  eq(mate.hp, 40 + KIT_ROLE_RULES.healPerPulse, 'one pulse heals a mate in reach by healPerPulse');
  eq(far.hp, 40, 'a mate outside the radius is not healed');
  eq(foe.hp, 40, 'enemies are never healed');
  eq(medic.hp, 60 + KIT_ROLE_RULES.healPerPulse * KIT_ROLE_RULES.healSelfFraction, 'the Medic heals itself at the self fraction');
  const heals = f.policy.events.filter(e => e.kind === 'heal');
  ok(heals.some(e => e.id === 'a' && e.by === 'm' && e.hp === KIT_ROLE_RULES.healPerPulse), 'a heal event names mate, medic and HP');
  // A second Medic never stacks: one pulse per mate per interval.
  const medic2 = f.add('m2', 'alpha', 'medic', 1, 53, 50);
  const before = mate.hp;
  f.run(KIT_ROLE_RULES.healIntervalMs * 3 + 20);
  ok(mate.hp - before <= KIT_ROLE_RULES.healPerPulse * 3 + 1e-9, `two Medics do not stack (${mate.hp - before} HP in 3 pulses)`);
  // Damage pauses the aura for healDamagePauseMs.
  f.setHp(mate, 50); mate.takeDamage(5, false, foe, 'rifle');
  f.step();
  const hurt = mate.hp;
  f.run(KIT_ROLE_RULES.healDamagePauseMs - 200);
  eq(mate.hp, hurt, 'no heal inside the damage pause');
  f.run(KIT_ROLE_RULES.healIntervalMs + 400);
  ok(mate.hp > hurt, 'healing resumes after the pause');
  // Awards: one `heal` per healAwardHp restored to others (self-heal earns nothing).
  const awards = f.policy.awards.filter(([id, reason]) => reason === 'heal');
  const givenByM = heals.length ? f.policy.events.filter(e => e.kind === 'heal' && e.by === 'm' && e.id !== 'm').reduce((s, e) => s + e.hp, 0) : 0;
  eq(awards.filter(([id]) => id === 'm').length, Math.floor(givenByM / KIT_ROLE_RULES.healAwardHp + 1e-9), 'heal award per 50 HP given');
  // Full heal earns heal awards; cap at max HP.
  f.setHp(mate, 1);
  f.run(25000);
  eq(mate.hp, 100, 'healing caps at max HP');
  ok(f.policy.awards.some(([id, reason]) => reason === 'heal'), 'a Medic earns heal awards');
  // Seated or down Medics have no aura.
  medic.vehicleId = 'jeep'; medic2.vehicleId = 'jeep';
  f.setHp(mate, 30); f.run(KIT_ROLE_RULES.healIntervalMs * 2 + 50);
  eq(mate.hp, 30, 'a seated Medic does not heal');
  medic.vehicleId = null; medic2.vehicleId = null;
  // Medkit restock: a spent medkit comes back at most every medkitRestockMs.
  mate.medkit.remaining = 0;
  f.run(KIT_ROLE_RULES.healIntervalMs + 50);
  eq(mate.medkit.remaining, 1, 'the aura restocks a spent medkit');
  mate.medkit.remaining = 0;
  f.run(KIT_ROLE_RULES.healIntervalMs * 3);
  eq(mate.medkit.remaining, 0, 'restock waits medkitRestockMs');
  f.run(KIT_ROLE_RULES.medkitRestockMs);
  eq(mate.medkit.remaining, 1, 'restocked again after the cooldown');
}

// --------------------------------------------------- assault adrenaline --
{
  const f = fixture();
  const assault = f.add('a', 'alpha', 'assault', 0, 50, 50);
  const victim = f.add('e', 'bravo', 'recon', 0, 60, 50);
  const victim2 = f.add('e2', 'bravo', 'recon', 0, 61, 50);
  const mate = f.add('m', 'alpha', 'support', 0, 70, 50);
  f.step();
  assault.medkit.remaining = 0;
  assault.grenades[gslot('frag')] = 0;
  victim.hp = 0; victim.state = 'dead';
  f.roles.onDeath(victim, assault, { weapon: 'rifle' });
  eq(assault.medkit.remaining, 1, 'an enemy kill re-arms the spent medkit');
  eq(assault.grenades[gslot('frag')], KIT_ROLE_RULES.adrenalineGrenades, 'and returns a frag');
  assault.medkit.remaining = 0;
  victim2.hp = 0; victim2.state = 'dead';
  f.roles.onDeath(victim2, assault, { weapon: 'rifle' });
  eq(assault.medkit.remaining, 0, 'adrenaline waits its cooldown');
  f.run(KIT_ROLE_RULES.adrenalineCooldownMs + 50);
  assault.grenades[gslot('frag')] = kitMaxGrenades('assault')[gslot('frag')];
  const v3 = f.add('e3', 'bravo', 'recon', 0, 62, 50); f.step();
  v3.hp = 0; v3.state = 'dead';
  f.roles.onDeath(v3, assault, { weapon: 'rifle' });
  eq(assault.medkit.remaining, 1, 'after the cooldown a kill re-arms again');
  eq(assault.grenades[gslot('frag')], kitMaxGrenades('assault')[gslot('frag')], 'frags stay capped at the kit maximum');
  // Teamkills and seated killers earn nothing.
  f.run(KIT_ROLE_RULES.adrenalineCooldownMs + 50);
  assault.medkit.remaining = 0;
  mate.hp = 0; mate.state = 'dead';
  f.roles.onDeath(mate, assault, { weapon: 'rifle' });
  eq(assault.medkit.remaining, 0, 'a teamkill earns no adrenaline');
  // A non-Assault killer gets nothing.
  const recon = f.add('r', 'alpha', 'recon', 0, 52, 52); f.step();
  recon.medkit.remaining = 0;
  const v4 = f.add('e4', 'bravo', 'recon', 0, 63, 50); f.step();
  v4.hp = 0; v4.state = 'dead';
  f.roles.onDeath(v4, recon, { weapon: 'sniper' });
  eq(recon.medkit.remaining, 0, 'only the Assault has adrenaline');
}

// ------------------------------------------------------ pyro fireproof --
{
  const f = fixture();
  const pyro = f.add('p', 'alpha', 'pyro', 0, 50, 50);
  const foe = f.add('e', 'bravo', 'pyro', 0, 55, 50);
  f.step();
  eq(f.roles.damageTakenScale(pyro, 'flamethrower'), 0, 'flamethrower deals the Pyro nothing');
  eq(f.roles.damageTakenScale(pyro, 'molotov'), 0, 'molotov fields deal the Pyro nothing');
  eq(f.roles.damageTakenScale(pyro, 'frag'), 1, 'explosives are normal');
  eq(f.roles.damageTakenScale(pyro, 'rifle'), 1, 'bullets are normal');
  eq(f.roles.damageTakenScale(pyro, 'lava'), 1, 'world lava is not fire-class');
  const medic = f.add('m', 'bravo', 'medic', 0, 56, 50); f.step();
  eq(f.roles.damageTakenScale(medic, 'flamethrower'), 1, 'other kits burn');
  // Through the real Conquest damage hook (ScoreLedger.attach): fire does nothing, frags do.
  const ledger = new ScoreLedger({ now: () => f.engine.now, emit: () => {}, entity: id => f.engine.entities.get(String(id?.id ?? id)),
    teamFor: p => p?.team, isEnemy: (a, b) => a?.team !== b?.team, vehicleFor: () => null, flags: () => [], rules: CONQUEST_RULES,
    damageTakenScale: (e, w) => f.roles.damageTakenScale(e, w), onInfantryHit: (...a) => f.roles.onInfantryHit(...a) });
  ledger.attach(pyro);
  pyro.takeDamage(30, false, foe, 'flamethrower');
  eq(pyro.hp, 100, 'a flame packet leaves the Pyro unhurt');
  pyro.takeDamage(12, false, foe, 'frag');
  eq(pyro.hp, 88, 'a frag still hurts the Pyro');
  pyro.burning = 4; pyro.molotovBurning = 0.5; pyro.burn = { owner: foe, remaining: 4, elapsed: 0 };
  f.step();
  eq([pyro.burning, pyro.molotovBurning, pyro.burn], [0, 0, null], 'the Pyro never shows as burning');
  // The fire systems skip a fire-immune body: no hit, burn or panic, and the stream passes on.
  eq(pyro.fireImmune, true, 'a living Pyro is fire-immune for the flame and molotov systems');
  eq(medic.fireImmune ?? false, false, 'other kits are not');
  pyro.panic = 0;
  pyro.burn = { owner: foe, remaining: 3, elapsed: 0.4 };
  updateBurn(pyro, 0.5, { canDamage: () => true, pushEvent: () => {}, killPlayer: () => {} });
  eq([pyro.burn, pyro.burning, pyro.panic, pyro.hp], [null, 0, 0, 88], 'a flamethrower burn goes out on a Pyro without damage or panic');
  pyro.burn = { owner: null, source: 'lava', remaining: 3, elapsed: 0.4 };
  updateBurn(pyro, 0.5, { canDamage: () => true, pushEvent: () => {}, killPlayer: () => {} });
  ok(pyro.hp < 88, 'lava still burns a Pyro');
  pyro.burn = null; pyro.burning = 0;
  // A hit the hook cancels is no hurt: the Medic aura keeps healing a Pyro standing in its own fire.
  const healer = f.add('h', 'alpha', 'medic', 0, 51, 50);
  f.step();
  f.setHp(pyro, 50);
  for (let t = 0; t < 6000; t += 500) { pyro.takeDamage(4, false, foe, 'molotov'); f.run(500); }
  ok(pyro.hp > 50, `the heal aura is not paused by cancelled fire hits (hp ${pyro.hp})`);
  eq(pyro.lastDamage?.cancelled, true, 'a cancelled hit is marked as such');
  ok(healer.state === 'alive');
}

// ----------------------------------------- revives pay only for enemy kills --
{
  const f = fixture();
  const medic = f.add('m', 'alpha', 'medic', 0, 50, 50);
  const mate = f.add('a', 'alpha', 'assault', 0, 51, 50);
  const foe = f.add('e', 'bravo', 'assault', 0, 90, 90);
  f.step();
  const reviveCycle = (killer, weapon) => {
    mate.hp = 0; mate.state = 'dead';
    const down = f.roles.onDeath(mate, killer, { weapon });
    for (let t = 0; t < CONQUEST_RULES.reviveHoldMs + 200; t += TICK) { f.roles.intent(medic, { type: 'support', support: 'revive', targetId: 'a' }); f.step(); }
    return down && mate.state === 'alive';
  };
  f.engine.respawnPlayer = (p, spawn) => { p.state = 'alive'; p.hp = 100; p.x = spawn.x; p.y = spawn.y; p.z = spawn.z; };
  ok(reviveCycle(null, 'fall'), 'a self-inflicted fall still leaves a revivable body');
  eq(f.policy.awards.filter(([, r]) => r === 'revive').length, 0, 'reviving a self-inflicted death pays no revive award (no fall-death farming)');
  ok(reviveCycle(mate, 'frag'), 'an own grenade leaves a body');
  eq(f.policy.awards.filter(([, r]) => r === 'revive').length, 0, 'an own grenade pays nothing either');
  ok(reviveCycle(foe, 'rifle'), 'an enemy kill leaves a body');
  eq(f.policy.awards.filter(([, r]) => r === 'revive').length, 1, 'reviving an enemy kill pays the award');
}

// --------------------------------------------------- grenadier ordnance --
{
  const f = fixture();
  const g = f.add('g', 'alpha', 'grenadier', 0, 50, 50);
  f.step();
  g.reserve[slot('mgl')] = 0;
  g.grenades[gslot('frag')] = 0;
  f.run(KIT_ROLE_RULES.ordnanceIntervalMs - 500);
  eq(g.reserve[slot('mgl')], 0, 'nothing before the ordnance interval');
  f.run(600);
  ok(g.reserve[slot('mgl')] > 0, 'one SKIPJACK reload comes back on the ordnance clock');
  eq(g.grenades[gslot('frag')], 1, 'and one grenade of the largest deficit');
  ok(!f.policy.awards.length, 'ordnance awards nothing');
}

// --------------------------------------------- raider ghost (spotting) --
{
  const f = fixture();
  const raider = f.add('r', 'alpha', 'raider', 0, 50, 50);
  const rifle = f.add('a', 'alpha', 'assault', 0, 52, 50);
  f.step();
  eq(f.roles.spotting.autoSpotShooter(raider, { weapon: 'smg' }), false, 'a Raider firing on foot is not auto-spotted');
  eq(f.roles.spotting.autoSpotShooter(rifle, { weapon: 'rifle' }), true, 'others are');
  const now = f.engine.now;
  f.roles.spotting.markPlayer(raider, { by: 'x', team: 'bravo', until: now + 8000 });
  eq(f.roles.spotting.players.get('r').until, now + KIT_ROLE_RULES.ghostSpotMs, 'a Recon mark on a Raider lasts ghostSpotMs');
  raider.vehicleId = 'jeep';
  f.roles.spotting.players.delete('r');
  f.roles.spotting.markPlayer(raider, { by: 'x', team: 'bravo', until: now + 8000 });
  eq(f.roles.spotting.players.get('r').until, now + 8000, 'a seated Raider gets the full mark');
}

// --------------------------------------------- marksman overwatch tags --
{
  const f = fixture();
  const marksman = f.add('k', 'alpha', 'marksman', 0, 50, 50);
  const foe = f.add('e', 'bravo', 'assault', 0, 90, 50);
  const mate = f.add('a', 'alpha', 'assault', 0, 52, 50);
  f.step();
  eq(f.roles.onInfantryHit(foe, marksman, 'revolver', 30), false, 'the sidearm does not tag');
  eq(f.roles.spotting.isSpotted(foe), false);
  eq(f.roles.onInfantryHit(foe, marksman, 'lance', 0), false, 'a hit for no damage does not tag');
  eq(f.roles.onInfantryHit(foe, marksman, 'lance', 60), true, 'a VOLTLANCE hit tags the target');
  eq(f.roles.spotting.isSpotted(foe), true);
  eq(f.roles.spotting.spotterOf(foe), 'k', 'the Marksman is the spotter (spot assist)');
  eq(f.roles.onInfantryHit(mate, marksman, 'lance', 60), false, 'teammates are never tagged');
  eq(f.roles.onInfantryHit(foe, mate, 'rifle', 60), false, 'only the Marksman tags');
  f.run(KIT_ROLE_RULES.overwatchTagMs + 100);
  eq(f.roles.spotting.isSpotted(foe), false, 'the tag expires after overwatchTagMs');
  // Spot assist when a teammate kills the tagged target.
  f.roles.onInfantryHit(foe, marksman, 'longarc', 20);
  foe.hp = 0; foe.state = 'dead';
  f.roles.onDeath(foe, mate, { weapon: 'rifle' });
  ok(f.policy.awards.some(([id, reason]) => id === 'k' && reason === 'spot_assist'), 'a teammate kill on a tagged target pays spot_assist');
}

// ----------------------------------------------- deploy level gate (real engine) --
{
  eq(careerLevelOf({}), 1, 'no stamp is level 1');
  eq(careerLevelOf({ careerLevel: 6 }), 6);
  ok(mayUseKit({ bot: true }, 'marksman'), 'bots bypass the level gate');
  ok(!mayUseKit({ careerLevel: 4 }, 'grenadier') && mayUseKit({ careerLevel: 5 }, 'grenadier'), 'humans need the level');
  const { GameEngine } = await import('../server/game.js');
  const world = { dimensions: { sx: 128, sy: 32, sz: 128 }, getBlock: (_x, y) => (y < 2 ? 1 : 0),
    findSpawns: () => [{ x: 20, y: 2, z: 20 }], setBlock: () => {} };
  const game = new GameEngine({ mode: 'conquest', world, broadcast: () => {},
    mapMeta: { id: 'frontier', dimensions: world.dimensions,
      spawns: { conquest: { alpha: [{ x: 20, y: 2, z: 20 }], bravo: [{ x: 90, y: 2, z: 90 }] } },
      conquest: { flags: [], bases: {}, vehicleSpawns: [] } } });
  game.addClient('h', 'Human'); game.addClient('foe', 'Foe'); game.addClient('w', 'Wing');
  const human = game.entities.get('h');
  const foe = [...game.entities.values()].find(p => game.mode.teamFor(p) !== game.mode.teamFor(human));
  const policy = game.mode.policy;
  // The first stamp (join) only states the level: a veteran is not told about "new" classes on every join.
  game.addClient('vet', 'Veteran');
  const vet = policy.setCareerLevel(game.entities.get('vet'), 9);
  eq([vet.level, vet.newly], [9, []], 'joining at level 9 announces no newly unlocked classes');
  eq(policy.setCareerLevel(game.entities.get('vet'), 9).newly, [], 're-announcing names nothing new');
  game.removeClient?.('vet');
  const unlocks = policy.setCareerLevel(human, 2);
  eq(unlocks.unlocked, ['assault', 'medic', 'engineer', 'support', 'recon'], 'level 2: base kits only');
  game.step();
  const die = () => { human.takeDamage(500, false, foe, 'rifle'); game.killPlayer(human, foe, 'rifle', false); game.tickEvents.length = 0; };
  human.takeDamage(500, false, foe, 'rifle'); game.killPlayer(human, foe, 'rifle', false);
  // The deploy screen opens with every death: the unlocks are restated (a client that missed the join event recovers).
  const restated = game.tickEvents.find(e => e.kind === 'kit_unlocks' && e.id === 'h');
  eq([restated?.level, restated?.newly], [2, []], 'a human death restates kit_unlocks for the deploy screen');
  game.tickEvents.length = 0;
  eq(game.mode.conquestIntent(human, { type: 'deploy', spawn: 'hq', kit: 'pyro', variant: 0 }), false, 'a locked kit is refused');
  const refusal = game.tickEvents.find(e => e.kind === 'deploy_refused' && e.id === 'h');
  eq([refusal?.reason, refusal?.level, refusal?.kit], ['locked', 3, 'pyro'], 'deploy_refused {reason:locked, level}');
  eq(game.mode.conquestIntent(human, { type: 'deploy', spawn: 'hq', kit: 'medic', variant: 1 }), true, 'a base kit deploys');
  for (let i = 0; i < 60 * 8 && human.state !== 'alive'; i++) game.step();
  eq(human.state, 'alive');
  ok(human.owned.includes('longarc') && human.owned.includes('revolver'), 'the Medic LONGARC loadout is issued');
  game.tickEvents.length = 0;
  const up = policy.setCareerLevel(human, 3, { announce: false });
  eq(up.newly, ['pyro'], 'a level-up names the newly unlocked kit');
  const ev = game.tickEvents.find(e => e.kind === 'kit_unlocks' && e.id === 'h');
  eq(ev?.newly, ['pyro'], 'kit_unlocks carries newly');
  ok(ev.unlocked.includes('pyro') && ev.level === 3);
  eq(policy.setCareerLevel(human, 1, { announce: false }).level, 3, 'levels never decrease');
  die();
  eq(game.mode.conquestIntent(human, { type: 'deploy', spawn: 'hq', kit: 'pyro', variant: 0 }), true, 'the unlocked kit deploys at the next death');
  for (let i = 0; i < 60 * 8 && human.state !== 'alive'; i++) game.step();
  ok(human.owned.includes('flamethrower'), 'the Pyro carries the FIRESTORM');
  // A remembered locked kit (a taken-over bot's) falls back to the default at the timed deploy.
  game.addClient('h2', 'Fresh');
  const fresh = game.entities.get('h2');
  policy.setCareerLevel(fresh, 1);
  game.step();
  policy.deploy.state('h2').kit = 'marksman';
  policy.deploy.state('h2').lastValid = { spawn: 'hq', kit: 'marksman', variant: 0, gadget: 0 };
  fresh.takeDamage(500, false, foe, 'rifle'); game.killPlayer(fresh, foe, 'rifle', false);
  for (let i = 0; i < 60 * 25 && fresh.state !== 'alive'; i++) game.step();
  eq(fresh.state, 'alive', 'the timed deploy happens');
  ok(!fresh.owned.includes('lance'), 'a level-1 player never deploys a locked remembered kit');
  eq(policy.roles.kitOf(fresh), 'assault');
  // A level-1 human taking over a bot with an unlock kit keeps that life, but a rematch or a
  // lobby team change respawn never issues the locked kit again.
  game.addClient('bot-t', 'Bot'); const carrier = game.entities.get('bot-t'); carrier.bot = true;
  game.step();
  Object.assign(policy.deploy.state('bot-t'), { kit: 'marksman', variant: 0, gadget: 0 });
  policy.applyRespawnLoadout(carrier);
  ok(carrier.owned.includes('lance'), 'the bot carries the Marksman kit');
  game.takeoverBot('bot-t', 'h3', 'Taker');
  const { stampCareerLevel } = await import('../server/lobby.js');
  stampCareerLevel(game, 'h3', { careerLevel: 1 });
  const taker = game.entities.get('h3');
  eq(taker.bot, false);
  policy.reset();
  eq(policy.roles.kitOf(taker), 'assault', 'a rematch respawn drops the locked taken-over kit');
  ok(!taker.owned.includes('lance'), 'no VOLTLANCE after the rematch');
  eq(policy.deploy.kitOf('h3').kit, 'assault', 'the remembered deploy kit is reset too');
  Object.assign(policy.deploy.state('h3'), { kit: 'raider', variant: 0, gadget: 0 });
  policy.setLobbyTeam(taker, policy.teamFor(taker) === 'alpha' ? 'bravo' : 'alpha');
  eq(policy.roles.kitOf(taker), 'assault', 'a lobby team change respawn applies the level gate');
  // Bots ignore the gate.
  game.addClient('bot-x', 'Bot'); const bot = game.entities.get('bot-x'); bot.bot = true;
  game.step();
  bot.takeDamage(500, false, foe, 'rifle'); game.killPlayer(bot, foe, 'rifle', false);
  eq(game.mode.conquestIntent(bot, { type: 'deploy', spawn: 'hq', kit: 'marksman', variant: 0 }), true, 'bots deploy any kit');
}

// ----------------------------------------------- career XP for teamplay --
{
  const { CareerService } = await import('../server/career.js');
  const directory = path.join(root, '.conquest-work', 'wip', 'classes', `career-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  const service = new CareerService({ directory });
  try {
    const id = randomBytes(32).toString('hex');
    const entity = { id: 'p1', bot: false, team: 'alpha', input: null };
    const levels = [];
    const engine = { entities: new Map([['p1', entity]]), mode: { policy: { setCareerLevel: (e, level) => levels.push(level) } } };
    const client = { id: 'p1', profileId: id, room: { engine }, careerLevel: 1 };
    const tick = (now, events) => service.observe(client, { t: 'tick', now, match: { mode: 'conquest', phase: 'live' },
      players: [{ id: 'p1', team: 'alpha', state: 'alive' }], events });
    tick(1000, []);
    tick(1100, [{ kind: 'score', id: 'p1', pts: 100, reason: 'revive' }, { kind: 'score', id: 'other', pts: 100, reason: 'revive' }]);
    eq(service.profile(id).xp, CAREER_REWARDS.conquestObjective.majorXp, 'a revive pays conquestObjective major XP');
    const minor = CAREER_REWARDS.conquestObjective;
    const events = Array.from({ length: 20 }, () => ({ kind: 'score', id: 'p1', pts: 10, reason: 'heal' }));
    tick(1200, events);
    eq(service.profile(id).xp, minor.majorXp + minor.minorCapPerMinute, 'heal XP is capped per minute');
    tick(62000, [{ kind: 'score', id: 'p1', pts: 10, reason: 'repair' }]);
    eq(service.profile(id).xp, minor.majorXp + minor.minorCapPerMinute + minor.minorXp, 'the cap resets after a minute');
    // Level-ups reach the live entity through the mode policy.
    const capture = Array.from({ length: 30 }, () => ({ kind: 'score', id: 'p1', pts: 250, reason: 'capture' }));
    tick(62100, capture);
    const xp = service.profile(id).xp;
    ok(levels.length > 0 && levels.at(-1) === careerLevel(xp), `level-up pushed to the policy (${levels.join(',')})`);
    eq(client.careerLevel, careerLevel(xp), 'the live client carries the career level');
    // R2-6: levels come from meta.careerLevel + syncLevel only; no dead per-profile level cache.
    eq([typeof service.levelOf, 'levels' in service], ['undefined', false], 'no unused levelOf / levels cache');
  } finally {
    service.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}

// --------------------------------------------- deploy picker read model --
{
  const state = await import('../public/js/ui/conquest-hud-state.js');
  const base = state.kitUnlockState(null);
  eq([...base.unlocked].sort(), ['assault', 'engineer', 'medic', 'recon', 'support'], 'no event: base kits only');
  const cards = state.kitCards('medic', 1, 0, { unlocked: base.unlocked, career: { xp: 1240 } });
  eq(cards.map(c => c.id), KIT_MENU_ORDER);
  eq(cards.filter(c => c.row === 'base').map(c => c.id), ['assault', 'medic', 'engineer', 'support', 'recon']);
  eq(cards.filter(c => c.row === 'unlock').map(c => c.id), ['pyro', 'grenadier', 'raider', 'marksman']);
  const grenadier = cards.find(c => c.id === 'grenadier');
  eq([grenadier.unlocked, grenadier.lockText, grenadier.progress.xp, grenadier.progress.need], [false, 'LV 5', 1240, 1600]);
  eq(cards.find(c => c.id === 'medic').ability, 'REVIVE · HEAL');
  ok(cards.find(c => c.id === 'medic').selected);
  ok(cards.find(c => c.id === 'raider').grenades.includes('1× CLAYMORE'), 'limpets read as CLAYMORE');
  const unlocks = state.kitUnlockState(state.ownKitUnlocks({ kind: 'kit_unlocks', id: 'me', level: 3, unlocked: unlockedKits(3), newly: ['pyro'] }, 'me'));
  ok(unlocks.unlocked.has('pyro') && !unlocks.unlocked.has('grenadier'), 'kit_unlocks opens the Pyro');
  eq(state.ownKitUnlocks({ kind: 'kit_unlocks', id: 'other', level: 9 }, 'me'), null, 'other players\' unlocks are ignored');
  eq(state.kitUnlockBanner({ level: 3, newly: ['pyro'] }).title, 'NEW CLASS UNLOCKED · PYRO');
  eq(state.kitUnlockBanner({ level: 9, newly: ['pyro', 'grenadier'] }).title, 'NEW CLASSES AVAILABLE');
  eq(state.deployRefusedText('locked', 5), 'CLASS LOCKED · LV 5');
  // Interact: only a Medic gets the revive hold; others are told to find one.
  const row = (id, kit, x, extra = {}) => ({ id, name: id, team: 'alpha', state: 'alive', hp: 100, x, y: 10, z: 0,
    cq: [kitIndex(kit), 1, 0, 0, 0, 0, 0], ...extra });
  const down = row('down', 'support', 1, { state: 'dead', hp: 0, cq: [2, 1, 1, 0, 0, 0, 0] });
  eq(state.interactModel({ self: row('me', 'medic', 0), players: [down] })?.type, 'revive', 'a Medic sees the revive hold');
  const info = state.interactModel({ self: row('me', 'assault', 0), players: [down] });
  eq([info?.type, info?.hold, info?.label], ['needs-medic', false, 'DOWN NEEDS A MEDIC'], 'an Assault is told the mate needs a Medic');
  // Downed overlay: nearest friendly Medic.
  const medicRow = row('doc', 'medic', 23);
  eq(state.nearestMedic([medicRow, row('x', 'assault', 3)], row('me', 'support', 0)), { id: 'doc', name: 'DOC', distance: 23 });
  // Medic map items: aura ring at healRadius.
  const items = state.mapItems({ cq: { bases: {}, flags: [] }, self: row('me', 'medic', 0), players: [], vehicles: [], selfTeam: 'alpha' });
  eq(items.find(i => i.kind === 'aura')?.radius, KIT_ROLE_RULES.healRadius, 'the minimap shows the heal aura ring');
  // Heal tick and score ticker labels.
  eq(state.scoreEntry({ kind: 'score', id: 'me', pts: 10, reason: 'heal' }, 'me').text, '+10 HEAL');
  eq(state.scoreEntry({ kind: 'score', id: 'me', pts: 100, reason: 'revive' }, 'me').text, '+100 REVIVE');
  // A locked selection falls back to the Assault.
  const model = state.deployModel({ cq: { flags: [], bases: { alpha: { x: 10, z: 10 } } }, self: { id: 'me', team: 'alpha', state: 'dead', hp: 0, cq: [0, 1, 0, 0, 0, 0, 0] },
    players: [], vehicles: [], nowMs: 0, selection: { spawn: 'hq', kit: 'marksman', variant: 1 }, unlocks: base });
  eq([model.kit, model.choice.kit, model.variant], ['assault', 'assault', 0], 'a stored locked kit falls back to the Assault');
}

// ------------------------------------- R2-5: wire contract is enforced --
{
  const { parseAdmissionFrame } = await import('../server/protocol/admission.js');
  const { LobbyManager, staleConquestClient } = await import('../server/lobby.js');
  eq(parseAdmissionFrame({ t: 'join', name: 'A', bots: 0, contract: 3 }).contract, 3, 'quick play carries the contract');
  eq(parseAdmissionFrame({ t: 'join', name: 'A', lobby: 'ABCDE', contract: 3, mapCache: [] }).contract, 3);
  eq(parseAdmissionFrame({ t: 'create', name: 'A', bots: 0, gameMode: 'conquest', map: 'frontier', contract: 3 }).contract, 3);
  eq('contract' in parseAdmissionFrame({ t: 'join', name: 'A', bots: 0 }), false, 'old clients keep the old shape');
  for (const bad of ['3', -1, 1.5, null, 1e9]) eq(parseAdmissionFrame({ t: 'join', name: 'A', bots: 0, contract: bad }), null, `contract ${bad} is malformed`);
  // The browser client announces the version its code was built against.
  const netclient = (await import('node:fs')).readFileSync(path.join(root, 'public/js/engine/netclient.js'), 'utf8');
  ok(/initialFrame\.contract = CONQUEST_CONTRACT_VERSION/.test(netclient), 'NetClient sends its Conquest contract');
  eq([staleConquestClient({ clientContract: 0 }), staleConquestClient({ clientContract: CONQUEST_CONTRACT_VERSION - 1 }),
    staleConquestClient({ clientContract: CONQUEST_CONTRACT_VERSION }), staleConquestClient({ id: 'in-process' })],
  [true, true, false, false], 'tabs without (or with an older) contract are stale; in-process callers are trusted');
  const messages = [], closed = [];
  const manager = new LobbyManager({ sendJson: (meta, msg) => messages.push({ id: meta.id, ...msg }), sendFrame: () => {},
    closeClient: (meta, code, reason) => closed.push({ id: meta.id, code, reason }) });
  try {
    // An old open tab (no contract) cannot create or join a Conquest room.
    const old = { id: 'old', clientContract: 0, careerLevel: 1 };
    eq(await manager.create(old, 'Old', 0, 'conquest', 'frontier'), false, 'a stale tab cannot create Conquest');
    ok(messages.some(m => m.id === 'old' && m.t === 'error' && /Reload the page/.test(m.msg)), 'the stale tab is told to reload');
    eq(closed.find(c => c.id === 'old')?.reason, 'stale client');
    const host = { id: 'host', clientContract: CONQUEST_CONTRACT_VERSION, careerLevel: 1 };
    eq(await manager.create(host, 'Host', 0, 'conquest', 'frontier'), true, 'a current tab creates Conquest');
    const late = { id: 'late', clientContract: 2, careerLevel: 1 };
    eq(await manager.join(late, 'Late', host.room.code), false, 'a stale tab cannot join a Conquest lobby');
    // A stale member of a TDM lobby blocks the switch to Conquest instead of decoding kits as null.
    const tdmHost = { id: 'tdm-host', clientContract: CONQUEST_CONTRACT_VERSION, careerLevel: 1 };
    const member = { id: 'member', clientContract: 0, careerLevel: 1 };
    eq(await manager.create(tdmHost, 'TdmHost', 0, 'tdm', 'foundry'), true);
    eq(await manager.join(member, 'Member', tdmHost.room.code), true, 'stale tabs still play the other modes');
    eq(manager.configure(tdmHost, { gameMode: 'conquest', map: 'frontier', bots: 0 }), false, 'switch to Conquest refused');
    ok(messages.some(m => m.id === 'tdm-host' && m.t === 'error' && /reload/.test(m.msg) && /Member/.test(m.msg)), 'the host learns who must reload');
    ok(messages.some(m => m.id === 'member' && m.t === 'error' && /Reload the page/.test(m.msg)), 'the stale guest is told to reload too');
    ok(!messages.some(m => m.id === 'member' && m.t === 'error' && /Member/.test(m.msg)), 'the guest gets its own message, not the host\'s list');
    eq(tdmHost.room.gameMode, 'tdm');
  } finally { manager.stop(); }
}

console.log(`Conquest classes: ${checks} checks passed (kits table and wire order, unlocks, medic revive and heal aura, adrenaline, fireproof, ordnance, ghost, overwatch, level gate, career XP, bot slots, deploy picker).`);
