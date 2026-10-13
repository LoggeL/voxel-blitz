// Titanfall anti-titan pilot weapons (docs/titanfall.md §6, §5.6, §11.1 WP4 row):
// the four ids appended after stinger (gadgetOnly, per-id tables), the ARCHER lock
// (titans only, only in titanfall; phase and electric smoke break it), the CR-6
// LONGBOW full-charge rule, every AT weapon needs ≥ 20 s of continuous fire to
// doom an Atlas with its drop shield, THUNDERBOLT zaps (≤ 3 targets per pulse,
// each once) and its DPS through a 5-pilot cluster, the magnetic SKIPJACK, the
// KRABER one-shot, the loadout fill (mag/reserve, owned list) and the bastion
// lists without gadgetOnly ids. Node only, headless, no audio.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GameEngine } from '../server/game.js';
import { getMapMeta, createMapState } from '../shared/world/templates.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { AIR, STONE } from '../shared/world/blocks.js';
import { WEAPONS, WEAPON_IDS, FREE_WEAPON_IDS, GADGET_ONLY_WEAPON_IDS, damageAtDistance, chargeReleaseFires } from '../shared/combatmath.js';
import { combatDamage } from '../shared/combat-balance.js';
import { infantryDamageClass, armorMultiplier } from '../shared/vehicle-armor.js';
import { LOCK_RULES, vehicleDirection, vehicleMaxHp } from '../shared/vehicle-defs.js';
import { TITAN_RULES, titanFrame } from '../shared/vehicle-handling/titan.js';
import { packTitanLoadout, TITAN_PILOT_AT, TITAN_PILOT_PRIMARIES } from '../shared/titan-contract.js';
import { WEAPON_HANDLING_PROFILES } from '../shared/weapon-handling.js';
import { ATTACHMENT_SLOTS } from '../shared/weapon-attachments.js';
import { HANDS } from '../shared/avatar-hands.js';
import { SIGHT_HEIGHT } from '../shared/player-hitboxes.js';
import { aimAngles } from '../server/sim/player.js';
import { applyTitanfallLoadout, titanfallOwned } from '../server/sim/titanfall/loadout.js';
import { PILOT_AT_RULES, TF_PILOT_PROJECTILES, zap } from '../server/sim/titanfall/pilot-projectiles.js';

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const near = (actual, expected, tolerance, message) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected} ±${tolerance}`); checks++;
};
const notes = [];
const pending = [];

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
Math.random = seeded(0x7174);

const NEW_IDS = ['chargerifle', 'archer', 'thunderbolt', 'kraber'];
const TICKS_PER_S = 1000 / TICK_MS;
const ticks = seconds => Math.round(seconds * TICKS_PER_S);
const DROP_TICKS = Math.ceil((TITAN_RULES.drop.markerMs + TITAN_RULES.drop.fallMs) / TICK_MS) + 2;
// The two request hunks (combat.js charge gate + hull damage) are applied by the orchestrator.
const COMBAT_SOURCE = readFileSync(new URL('../server/sim/combat.js', import.meta.url), 'utf8');
const CHARGE_HUNK = COMBAT_SOURCE.includes('chargeReleaseFires');
const HULL_HUNK = COMBAT_SOURCE.includes('def.hullDamage');

/* ================================================================ ids and per-id tables */
{
  eq(WEAPON_IDS.slice(WEAPON_IDS.indexOf('stinger') + 1), NEW_IDS, 'the four AT ids follow stinger in order');
  eq(WEAPON_IDS.length, 20, '20 weapon ids');
  for (const id of NEW_IDS) {
    const def = WEAPONS[id];
    ok(def?.id === id && def.gadgetOnly === true, `${id}: gadgetOnly`);
    ok(!FREE_WEAPON_IDS.includes(id) && GADGET_ONLY_WEAPON_IDS.includes(id), `${id}: never in a free roster`);
    ok(WEAPON_HANDLING_PROFILES[id], `${id}: handling profile`);
    ok(ATTACHMENT_SLOTS[id]?.optics.length >= 1, `${id}: attachment slots`);
    ok(HANDS[id]?.grip, `${id}: hands`);
    ok(Number.isFinite(SIGHT_HEIGHT[id]), `${id}: sight height`);
  }
  eq(FREE_WEAPON_IDS.length, 15, 'free roster unchanged (15)');
  eq(infantryDamageClass(WEAPONS.chargerifle), 'at', 'charge rifle deals at');
  eq(infantryDamageClass(WEAPONS.kraber), 'hmg', 'kraber deals hmg');
  near(WEAPONS.kraber.damage[0] * armorMultiplier('hmg', 'titan'), 40, 1e-9, 'kraber: 200 × hmg 0.2 = 40 to a titan');
  ok(combatDamage(damageAtDistance(WEAPONS.kraber, 1e4)) >= 100, 'kraber: the far body shot still downs a 100 hp pilot');
  near(combatDamage(WEAPONS.chargerifle.damage[0]), 50, 1e-9, 'charge rifle: 50 to a pilot');
  eq(WEAPONS.chargerifle.hullDamage, 300, 'charge rifle: 300 to a titan');
  eq(TF_PILOT_PROJECTILES, ['archer', 'thunderbolt', 'mgl'], 'router kinds');
  eq(TITAN_PILOT_AT, ['chargerifle', 'archer', 'thunderbolt', 'mgl'], 'AT loadout choices');
  ok(TITAN_PILOT_PRIMARIES.includes('kraber'), 'kraber is a primary');
  // Charge gate helper (shared by authority and prediction).
  ok(!chargeReleaseFires(WEAPONS.chargerifle, 0.99) && chargeReleaseFires(WEAPONS.chargerifle, 1), 'charge rifle: only a full charge fires');
  ok(chargeReleaseFires(WEAPONS.lance, 0.2), 'lance still fires at any charge');
}

/* ================================================================ loadout fill */
{
  for (const at of TITAN_PILOT_AT) for (const primary of TITAN_PILOT_PRIMARIES) {
    const p = { mag: [], reserve: [] };
    const kit = applyTitanfallLoadout(p, packTitanLoadout({ primary, at, tactical: 'grapple', titan: 'titan_ion' }));
    eq(kit.at, at, `loadout ${primary}/${at}: unpacked`);
    eq(p.owned, [primary, 'revolver', at, 'knife'], `loadout ${primary}/${at}: owned list`);
    eq(p.mag.length, WEAPON_IDS.length, 'mag array covers every id');
    for (const id of WEAPON_IDS) {
      const slot = WEAPON_IDS.indexOf(id), def = WEAPONS[id];
      if (!p.owned.includes(id)) { ok(p.mag[slot] === 0 && p.reserve[slot] === 0, `${id} not owned: empty`); continue; }
      eq(p.mag[slot], def.magSize, `${primary}/${at}: ${id} full magazine`);
      ok(p.reserve[slot] > 0 || id === 'knife', `${primary}/${at}: ${id} reserve`);
    }
    eq(p.weapon, WEAPON_IDS.indexOf(primary), 'spawns holding the primary');
  }
  const p = { mag: [], reserve: [] };
  applyTitanfallLoadout(p, packTitanLoadout({ primary: 'kraber', at: 'thunderbolt' }));
  eq([p.mag[WEAPON_IDS.indexOf('kraber')], p.reserve[WEAPON_IDS.indexOf('kraber')]], [4, 4], 'kraber: 4 + 4 magazines (16 rounds)');
  eq([p.mag[WEAPON_IDS.indexOf('thunderbolt')], p.reserve[WEAPON_IDS.indexOf('thunderbolt')]], [4, 3], 'thunderbolt: 4 + 3 magazines (12 rounds)');
  eq(titanfallOwned({ primary: 'kraber', at: 'archer' }), ['kraber', 'revolver', 'archer', 'knife'], 'owned list maps the new ids by name');
}

/* ================================================================ bastion lists */
{
  const armory = readFileSync(new URL('../public/js/ui/bastion-armory.js', import.meta.url), 'utf8');
  ok(/!WEAPONS\[id\]\?\.gadgetOnly/.test(armory), 'bastion armory lists no gadgetOnly id');
  // The server buy (bastion.js, orchestrator hunk) refuses exactly the four AT ids; the stinger keeps
  // its pre-WP4 server behaviour (R1). Without the hunk a hand-built buy request gets them (duds/one-shots).
  const server = readFileSync(new URL('../server/modes/bastion.js', import.meta.url), 'utf8');
  if (/'chargerifle','archer','thunderbolt','kraber'\]\.includes\(req\.item\)/.test(server)) {
    const { bastionPurchaseId } = await import('../shared/bastion.js');
    for (const item of ['stinger', ...NEW_IDS]) {
      const engine = new GameEngine({ mode: 'bastion', mapMeta: getMapMeta('reactor'), broadcast: () => {} });
      engine.addClient('p0', 'D');
      const policy = engine.mode.policy, state = policy.players.get('p0');
      const accepted = engine.mode.purchase('p0', bastionPurchaseId(policy, state.request + 1, 'loadout', item));
      eq(!!accepted, item === 'stinger', `bastion buy ${item === 'stinger' ? 'still accepts the stinger' : `refuses ${item}`}`);
      engine.stop?.();
    }
  } else pending.push('bastion.js buy filter for the four AT ids (request bastion-gadget-filter.patch; must land with the WEAPON_IDS append)');
}

/* ================================================================ arena */
const G = 10;
const ARENA = { minX: 20, maxX: 170, minZ: 50, maxZ: 96 };
function flatten(engine, rect, level = G) {
  const world = engine.world, sy = world.dimensions.sy;
  for (let x = rect.minX; x < rect.maxX; x++) for (let z = rect.minZ; z < rect.maxZ; z++) {
    for (let y = 0; y < sy; y++) world.setBlock(x, y, z, y < level ? STONE : AIR);
  }
  engine.blockRevision++;
}
function arena(roster) {
  const f = { events: [], last: null };
  f.engine = new GameEngine({ mode: 'titanfall', mapMeta: getMapMeta('harbor'), world: createMapState('harbor'),
    broadcast: s => { f.last = s; for (const e of s.events ?? []) f.events.push(e); } });
  f.policy = f.engine.mode.policy;
  if (f.policy.grunts) f.policy.grunts.enabled = false;   // exact damage sums: no attrition minions (§10, WP8)
  f.titans = f.engine.vehicles.titans;
  f.vehicles = f.engine.vehicles;
  for (const [id, team] of roster) { f.engine.addClient(id, id.toUpperCase()); f.policy.setLobbyTeam(id, team); f.policy.deployNow(id); }
  flatten(f.engine, ARENA);
  f.step = (n = 1) => { for (let i = 0; i < n; i++) f.engine.step(TICK_MS); };
  f.step(2);
  f.p = id => f.engine.entities.get(id);
  f.kinds = kind => f.events.filter(e => e.kind === kind);
  return f;
}
function place(p, x, z, yaw = 0, pitch = 0, y = G) {
  Object.assign(p, { x, y, z, vx: 0, vy: 0, vz: 0, grounded: true, yaw, pitch, spawnProtectedUntil: 0, spawnProtected: false });
  p.input = { ...(p.input || {}), keys: {}, yaw, pitch };
  p.hist = [];
}
function park(f, p) {
  if (p.state === 'alive') f.engine.killPlayer(p, null, 'world', false);
  p.respawnAt = Infinity;
}
const eyeOf = p => [p.x, p.y + 1.62, p.z];
function aimAt(p, point, extra = {}) {
  const a = aimAngles(eyeOf(p), point);
  p.input = { ...(p.input || {}), keys: {}, yaw: a.yaw, pitch: a.pitch, ...extra };
  p.yaw = a.yaw; p.pitch = a.pitch;
}
/** a1 calls an Atlas onto (x, z), embarks and holds it still facing -X. */
function pilotedAtlas(f, x, z) {
  const a1 = f.p('a1');
  place(a1, x, z + 18, 0);
  aimAt(a1, [x, G + 0.01, z]);
  f.policy.setTitanMeter(a1, 1);
  const call = f.titans.call(a1, null);
  assert.ok(call.ok, `call: ${call.reason}`);
  f.step(DROP_TICKS + 62);
  const v = f.vehicles.vehicles.get(call.vehicleId);
  assert.ok(v && !v.dropping && v.hp > 0, 'titan landed');
  place(a1, v.x, v.z + titanFrame(v).hl + 1.2, v.yaw);
  assert.ok(f.vehicles.action(a1, { type: 'enter', vehicleId: v.id }), 'embark');
  f.step(ticks(TITAN_RULES.embark.animMs / 1000) + 2);
  v.yaw = Math.PI / 2;          // nose toward -X
  hold(a1, v);
  f.step(2);
  return v;
}
function hold(a1, v) { a1.input = { ...(a1.input || {}), keys: {}, vehicleThrottle: 0, vehicleSteer: 0, yaw: v.yaw, pitch: 0, titanHold: 0, wantFire: false }; }
const total = v => v.hp + v.shield;
const center = v => [v.x, v.y + titanFrame(v).height * 0.55, v.z];
/** Arm `p` with a titanfall loadout and draw `id` at once. */
function arm(p, id) {
  const primary = TITAN_PILOT_PRIMARIES.includes(id) ? id : 'rifle';
  const at = TITAN_PILOT_AT.includes(id) ? id : 'chargerifle';
  applyTitanfallLoadout(p, packTitanLoadout({ primary, at, tactical: 'grapple', titan: 'titan_ion' }));
  p.weapon = WEAPON_IDS.indexOf(id);
  p.deployT = 0; p.cooldown = 0; p.reloading = false;
}

/**
 * Continuous fire from `p` at the titan until it is doomed (or `limit` s):
 * semi weapons get a press edge every other tick, the charge rifle holds to
 * the vent and releases, empty magazines reload at once, ammo is endless.
 */
function fireUntilDoomed(f, p, v, { limit = 120, ads = false, aimUp = 0 } = {}) {
  const slot = p.weapon, start = f.engine.now, a1 = f.p('a1');
  let tick = 0, reloadId = 1, shots = 0, firstShotAt = null, lastSeq = p.shotSeq;
  while ((f.engine.now - start) / 1000 < limit && !v.doomed && v.hp > 0) {
    p.reserve[slot] = 99;
    hold(a1, v);
    const charging = WEAPONS[WEAPON_IDS[slot]].mode === 'charge';
    const wantFire = charging ? (p.charging ? true : tick % 2 === 0) : tick % 2 === 0;
    const target = center(v); target[1] += aimUp;
    const extra = { wantFire, wantAds: ads };
    if (p.mag[slot] <= 0 && !p.reloading) { extra.reload = true; extra.reloadId = ++reloadId; }
    aimAt(p, target, extra);
    f.step(1);
    if (p.shotSeq !== lastSeq) { shots += p.shotSeq - lastSeq; lastSeq = p.shotSeq; firstShotAt ??= f.engine.now - TICK_MS; }
    tick++;
  }
  const end = f.engine.now;
  return { seconds: firstShotAt == null ? Infinity : (end - firstShotAt) / 1000, doomed: !!v.doomed, shots };
}

/* ================================================================ solo doom ≥ 20 s (front and rear ×1.3, drop shield) */
const doomTimes = {};
for (const [id, distance, options, side = 'front'] of [['chargerifle', 30, {}], ['archer', 30, { ads: true }], ['thunderbolt', 25, {}],
  ['thunderbolt', 10, {}], ['mgl', 18, { aimUp: 1.2 }], ['kraber', 40, { limit: 200, ads: true }],
  ['chargerifle', 30, {}, 'rear'], ['archer', 30, { ads: true }, 'rear'], ['thunderbolt', 25, {}, 'rear'],
  ['thunderbolt', 10, {}, 'rear'], ['mgl', 18, { aimUp: 1.2 }, 'rear']]) {
  const f = arena([['a1', 'alpha'], ['b1', 'bravo']]);
  const v = pilotedAtlas(f, 110.5, 73.5);
  near(v.shield, TITAN_RULES.dropShieldFrac * vehicleMaxHp(v), 1e-6, `${id}: drop shield up`);
  eq(vehicleMaxHp(v), 2500, `${id}: an Atlas (2500)`);
  const b1 = f.p('b1');
  // Front: on the nose axis. Rear: behind the hull (TITAN_ZONES.rear ×1.3), still inside the flattened arena.
  const fwd = vehicleDirection(side === 'rear' ? v.yaw + Math.PI : v.yaw);
  place(b1, v.x + fwd[0] * distance, v.z + fwd[2] * distance);
  arm(b1, id);
  const result = fireUntilDoomed(f, b1, v, options);
  const key = `${distance === 10 ? `${id}@10m` : id}${side === 'rear' ? ' rear' : ''}`;
  doomTimes[key] = result;
  if (id === 'chargerifle' && side === 'front' && !HULL_HUNK) {
    pending.push('charge rifle 300 hull damage (request combat-chargerifle.patch); without it the doom time is the body-damage fallback');
  }
  if ((id !== 'kraber' || result.doomed) && (id !== 'chargerifle' || HULL_HUNK)) {
    ok(result.doomed, `${key}: dooms the Atlas within the limit (${result.seconds.toFixed(1)} s, ${result.shots} shots)`);
  }
  ok(result.seconds >= 20, `${key}: solo doom needs ≥ 20 s (${result.seconds.toFixed(1)} s)`);
  notes.push(`${key.padEnd(15)} doom ${Number.isFinite(result.seconds) ? result.seconds.toFixed(1).padStart(5) : '  n/a'} s  ${String(result.shots).padStart(3)} shots${result.doomed ? '' : ' (not doomed)'}`);
  f.engine.stop();
}

/* ================================================================ single-hit numbers on a titan */
{
  const f = arena([['a1', 'alpha'], ['b1', 'bravo']]);
  const v = pilotedAtlas(f, 110.5, 73.5);
  const b1 = f.p('b1'), fwd = vehicleDirection(v.yaw);
  const hit = (id, distance, options = {}) => {
    place(b1, v.x + fwd[0] * distance, v.z + fwd[2] * distance);
    arm(b1, id);
    const slot = b1.weapon, a1 = f.p('a1');
    if (options.ads) for (let i = 0; i < ticks(0.6); i++) { hold(a1, v); aimAt(b1, center(v), { wantAds: true }); f.step(1); }
    const before = total(v), seq = b1.shotSeq;
    let fired = false;
    for (let i = 0; i < ticks(4) && total(v) === before; i++) {
      hold(a1, v);
      const t = center(v); t[1] += options.aimUp ?? 0;
      const charging = WEAPONS[id].mode === 'charge';
      aimAt(b1, t, { wantFire: !fired && (charging || i % 2 === 0), wantAds: !!options.ads });
      b1.reserve[slot] = 9;
      f.step(1);
      if (b1.shotSeq !== seq) fired = true;
    }
    f.step(ticks(1));
    return before - total(v);
  };
  const archer = hit('archer', 30);
  near(archer, PILOT_AT_RULES.archer.titanDamage, 1e-6, `archer: ${PILOT_AT_RULES.archer.titanDamage} to the titan front`);
  const mgl = hit('mgl', 16, { aimUp: 1.2 });
  near(mgl, PILOT_AT_RULES.mgl.titanDamage, 1e-6, 'skipjack: 70 at to a titan (direct)');
  const kraber = hit('kraber', 40, { ads: true });
  near(kraber, 40, 1e-6, 'kraber: 40 to a titan');
  const orb = hit('thunderbolt', 20);
  ok(orb >= PILOT_AT_RULES.thunderbolt.contactTitan * 0.9 && orb <= PILOT_AT_RULES.thunderbolt.contactTitan + 2 * PILOT_AT_RULES.thunderbolt.zapTitan,
    `thunderbolt: contact plus at most two zaps (${orb})`);
  const charge = hit('chargerifle', 30);
  if (HULL_HUNK) near(charge, 300, 1e-6, 'charge rifle: 300 to the titan');
  else near(charge, WEAPONS.chargerifle.damage[0], 1e-6, 'charge rifle (pre-hunk): body damage to the titan');
  notes.push(`one hit (front): archer ${archer}, chargerifle ${charge}, thunderbolt ${orb}, mgl ${mgl}, kraber ${kraber}`);
  f.engine.stop();
}

/* ================================================================ archer lock */
{
  const f = arena([['a1', 'alpha'], ['a2', 'alpha'], ['b1', 'bravo'], ['b2', 'bravo']]);
  const v = pilotedAtlas(f, 110.5, 73.5);
  const [a2, b1, b2] = ['a2', 'b1', 'b2'].map(f.p);
  const locks = f.vehicles.locks, a1 = f.p('a1');
  const fwd = vehicleDirection(v.yaw);
  place(b1, v.x + fwd[0] * 40, v.z + fwd[2] * 40);
  arm(b1, 'archer');
  park(f, b2);
  const holdAim = (n, ads = true, point = center(v)) => {
    for (let i = 0; i < n; i++) { hold(a1, v); aimAt(b1, point, { wantAds: ads, wantFire: false }); f.step(1); }
  };
  holdAim(ticks(LOCK_RULES.archer.seconds) - 6);
  ok(b1.lockProgress > 0.8 && b1.lockProgress < 1 && !locks.lockedTarget(b1, 'archer'), `archer: no lock before 1.2 s (${b1.lockProgress.toFixed(2)})`);
  holdAim(10);
  eq(locks.lockedTarget(b1, 'archer'), v.id, 'archer: locks the enemy titan after 1.2 s of ADS');
  eq(b1.lockProgress, 1, 'lock progress published (tfs[11])');
  holdAim(2, false);
  eq(b1.lockProgress, 0, 'leaving ADS drops the lock');
  // Phase and electric smoke break the lock.
  holdAim(ticks(1.4));
  eq(locks.lockedTarget(b1, 'archer'), v.id, 're-locked');
  v.tfMove.phasedUntil = f.engine.now + 600;
  holdAim(2);
  ok(!locks.lockedTarget(b1, 'archer') && b1.lockProgress === 0, 'phase breaks the lock');
  holdAim(ticks(0.7));
  holdAim(ticks(1.4));
  eq(locks.lockedTarget(b1, 'archer'), v.id, 'locks again after the phase');
  v.tfAbility = { ...(v.tfAbility || {}), smokeUntil: f.engine.now + 500 };
  holdAim(2);
  ok(!locks.lockedTarget(b1, 'archer'), 'electric smoke breaks the lock');
  v.tfAbility.smokeUntil = 0;
  // Locked launch homes: fire 4.5 m beside the hull centre; the missile still hits.
  holdAim(ticks(1.4));
  const before = total(v), launches = f.kinds('projectileLaunch').length;
  const off = center(v); off[2] += 4.5;   // 6.4° off the boresight: inside the 9° keep cone
  for (let i = 0; i < 4; i++) { hold(a1, v); aimAt(b1, off, { wantAds: true, wantFire: i === 0 }); f.step(1); }
  const launch = f.kinds('projectileLaunch').slice(launches).find(e => e.type === 'archer');
  ok(launch?.target === v.id, 'locked launch carries the target');
  f.step(ticks(1.5));
  near(before - total(v), PILOT_AT_RULES.archer.titanDamage, 1e-6, 'a locked missile aimed 4.5 m off still strikes the titan');
  ok(f.kinds('projectileUpdate').some(e => e.pid === launch.pid), 'guided flight streams updates');
  // No lock on a friendly titan, on a pilot, or without the titanfall lock source.
  place(a2, v.x + fwd[0] * 40, v.z + fwd[2] * 40 + 3);
  arm(a2, 'archer');
  for (let i = 0; i < ticks(1.6); i++) { hold(a1, v); aimAt(a2, center(v), { wantAds: true }); aimAt(b1, eyeOf(a2), { wantAds: true }); f.step(1); }
  ok(!locks.lockedTarget(a2, 'archer') && a2.lockProgress === 0, 'no lock on a friendly titan');
  ok(!locks.lockedTarget(b1, 'archer') && b1.lockProgress === 0, 'no lock on a pilot');
  // Dumb-fire: no lock, the missile flies straight past a 4.5 m offset.
  const before2 = total(v);
  const launches2 = f.kinds('projectileLaunch').length;
  place(b1, v.x + fwd[0] * 40, v.z + fwd[2] * 40);
  arm(b1, 'archer');
  for (let i = 0; i < 4; i++) { hold(a1, v); aimAt(b1, off, { wantAds: false, wantFire: i === 0 }); f.step(1); }
  const dumb = f.kinds('projectileLaunch').slice(launches2).find(e => e.type === 'archer');
  ok(dumb && dumb.target == null, 'unlocked launch is dumb-fire');
  f.step(ticks(1.5));
  eq(total(v), before2, 'a dumb-fire missile aimed 4.5 m off misses');
  // The lock source exists only in titanfall.
  const conquest = new GameEngine({ mode: 'conquest', mapMeta: getMapMeta('frontier'), world: createMapState('frontier'), broadcast: () => {} });
  conquest.addClient('c1', 'C1');
  conquest.engine?.step?.(TICK_MS);
  const c1 = conquest.entities.get('c1');
  ok(c1, 'conquest engine has the player');
  arm(c1, 'archer');
  c1.ads = true;
  c1.state = 'alive';
  eq(conquest.vehicles.locks.sourceFor(c1), null, 'no archer lock source outside titanfall');
  conquest.stop();
  f.engine.stop();
}

/* ================================================================ charge rifle: full charge only */
{
  const f = arena([['a1', 'alpha'], ['b1', 'bravo']]);
  const b1 = f.p('b1');
  park(f, f.p('a1'));
  place(b1, 60, 70, Math.PI / 2);
  arm(b1, 'chargerifle');
  const slot = b1.weapon, seq = b1.shotSeq, mag = b1.mag[slot];
  for (let i = 0; i < ticks(0.6); i++) { aimAt(b1, [40, G + 1.6, 70], { wantFire: true }); f.step(1); }
  ok(b1.charging, 'charging while held');
  aimAt(b1, [40, G + 1.6, 70], { wantFire: false });
  f.step(2);
  if (CHARGE_HUNK) {
    eq(b1.shotSeq, seq, 'early release: no shot');
    eq(b1.mag[slot], mag, 'early release: no cell spent');
    ok(!b1.charging && b1.charge > 0.4 && b1.charge < 0.7, 'early release: partial bank retained, trigger no longer charges');
  } else pending.push('charge rifle early-release vent (request combat-chargerifle.patch)');
  for (let i = 0; i < ticks(2.7); i++) { aimAt(b1, [40, G + 1.6, 70], { wantFire: false }); f.step(1); }
  eq(b1.charge, 0, 'released capacitor drains completely without a shot');
  eq(b1.shotSeq, seq, 'decay never auto-fires');
  const seq2 = b1.shotSeq;
  let firedAt = null;
  for (let i = 0; i < ticks(1.4) && firedAt == null; i++) {
    aimAt(b1, [40, G + 1.6, 70], { wantFire: true });
    f.step(1);
    if (b1.shotSeq !== seq2) firedAt = i + 1;
  }
  ok(firedAt != null, 'a held charge fires by itself');
  near(firedAt / TICKS_PER_S, WEAPONS.chargerifle.charge.ms / 1000, 3 / TICKS_PER_S, "at the full 1.1 s charge (press tick included)");
  const shoot = f.kinds('shoot').filter(e => e.id === 'b1' && e.w === 'chargerifle').at(-1);
  eq(shoot?.charge, 1, 'the shot leaves at full charge');
  ok(b1.cooldown > 2.3, `then ≈ 2.5 s cooldown (${b1.cooldown.toFixed(2)})`);
  f.engine.stop();
}

/* ================================================================ thunderbolt: zaps and the 5-pilot cluster */
{
  const roster = [['b1', 'bravo'], ['a1', 'alpha'], ['a2', 'alpha'], ['a3', 'alpha'], ['a4', 'alpha'], ['a5', 'alpha'], ['a6', 'alpha']];
  const f = arena(roster);
  const b1 = f.p('b1');
  park(f, f.p('a6'));
  place(b1, 40, 73, 0);
  arm(b1, 'thunderbolt');
  // Five enemy pilots 2.5–3.5 m beside the orb's path at 18–22 m (never touched by the orb).
  const cluster = ['a1', 'a2', 'a3', 'a4', 'a5'].map(f.p);
  const spots = [[58, 70.2], [59, 76], [60, 69.8], [61, 76.3], [62, 70.1]];
  cluster.forEach((p, i) => { place(p, spots[i][0], spots[i][1], 0); p.hp = 1000; p.maxHp = Math.max(p.maxHp ?? 100, 1000); });
  const startHp = cluster.map(p => p.hp);
  const before = f.events.length;
  aimAt(b1, [90, G + 1.62, 73], { wantFire: true });
  f.step(1);
  aimAt(b1, [90, G + 1.62, 73], { wantFire: false });
  for (let i = 0; i < ticks(2.6); i++) { for (const p of cluster) { p.vx = p.vy = p.vz = 0; p.input = { keys: {}, yaw: 0, pitch: 0 }; } f.step(1); }
  const zaps = f.events.slice(before).filter(e => e.kind === 'arcZap');
  ok(zaps.length >= 2, `the orb zapped the cluster on its way (${zaps.length} pulses)`);
  ok(zaps.every(e => e.to.length <= PILOT_AT_RULES.thunderbolt.zapTargets), 'every pulse strikes at most 3 targets');
  const dealt = cluster.reduce((sum, p, i) => sum + (startHp[i] - p.hp), 0);
  const struck = zaps.reduce((sum, e) => sum + e.to.length, 0);
  near(dealt, struck * PILOT_AT_RULES.thunderbolt.zapPilot, 1e-6, '15 per zap and pilot (after combatDamage)');
  const span = zaps.length ? (zaps.at(-1) === zaps[0] ? 0.25 : (zaps.length) * PILOT_AT_RULES.thunderbolt.zapIntervalS) : 1;
  const dps = dealt / span;
  ok(dps <= PILOT_AT_RULES.thunderbolt.zapTargets * PILOT_AT_RULES.thunderbolt.zapPilot / PILOT_AT_RULES.thunderbolt.zapIntervalS + 1e-6,
    `cluster DPS capped at 3 × 15 / 0.25 s = 180 (${dps.toFixed(0)})`);
  notes.push(`thunderbolt 5-pilot cluster: ${zaps.length} pulses, ${struck} strikes, ${dealt} damage, ${dps.toFixed(0)} dps while in reach`);
  // Each target at most once per pulse: a direct pulse call with every body in reach.
  const system = f.engine.projectiles, ctx = f.engine.contexts.projectiles;
  const fake = { id: 'zap-probe', owner: b1, ownerId: 'b1', x: 60, y: G + 1.4, z: 73 };
  cluster.forEach((p, i) => place(p, 59 + i * 0.5, 72 + (i % 2), 0));
  const struckNow = zap(system, fake, ctx);
  eq(struckNow.length, 3, 'five bodies in reach: three strikes');
  eq(new Set(struckNow.map(s => s.victim?.id)).size, 3, 'three distinct targets');
  f.engine.stop();
}

/* ================================================================ magnetic skipjack */
{
  const f = arena([['a1', 'alpha'], ['b1', 'bravo']]);
  const v = pilotedAtlas(f, 110.5, 73.5);
  const b1 = f.p('b1'), a1 = f.p('a1'), fwd = vehicleDirection(v.yaw);
  place(b1, v.x + fwd[0] * 16, v.z + fwd[2] * 16);
  arm(b1, 'mgl');
  const before = total(v), events = f.events.length;
  // Aimed 3.2 m beside the hull edge: the magnet pulls the round in.
  const aside = center(v); aside[2] += titanFrame(v).hw + 3.2; aside[1] += 1.2;
  for (let i = 0; i < 2; i++) { hold(a1, v); aimAt(b1, aside, { wantFire: i === 0 }); f.step(1); }
  for (let i = 0; i < ticks(2.5); i++) { hold(a1, v); f.step(1); }
  near(before - total(v), PILOT_AT_RULES.mgl.titanDamage, 1e-6, 'a near miss within 4 m is pulled onto the titan (70)');
  ok(f.events.slice(events).some(e => e.kind === 'projectileUpdate'), 'magnetised flight streams updates');
  f.engine.stop();
}

/* ================================================================ kraber one-shot */
{
  const f = arena([['a1', 'alpha'], ['b1', 'bravo']]);
  const [a1, b1] = ['a1', 'b1'].map(f.p);
  place(b1, 30, 73, 0);
  place(a1, 130, 73, 0);
  arm(b1, 'kraber');
  const target = [a1.x, a1.y + 1.15, a1.z];
  aimAt(b1, target, { wantFire: true, wantAds: true });
  b1.adsT = 1; b1.ads = true;
  f.step(1);
  aimAt(b1, target, { wantFire: false, wantAds: true });
  for (let i = 0; i < ticks(0.6) && a1.state === 'alive'; i++) { a1.vx = a1.vz = 0; f.step(1); }
  eq(a1.state, 'dead', 'kraber: one body shot at 100 m downs a pilot');
  eq(f.kinds('kill').filter(e => e.victim === 'a1').at(-1)?.w, 'kraber', 'credited to the kraber');
  f.engine.stop();
}

/* ================================================================ client: gun models and projectile views */
{
  const THREE = await import('../public/js/vendor/three.module.js');
  const { buildGun, disposeGunModels } = await import('../public/js/guns/assemble.js');
  const { MaterialCache } = await import('../public/js/guns/kit.js');
  const cache = new MaterialCache();
  const models = {};
  for (const id of NEW_IDS) {
    const model = models[id] = buildGun(id, cache);
    model.root.updateWorldMatrix(true, true);
    const inverse = model.body.matrixWorld.clone().invert();
    const bounds = new THREE.Box3(), point = new THREE.Vector3();
    let triangles = 0;
    for (const child of model.body.children) {
      if (child === model.flash.grp || child === model.muzzleMarker || /^hand_/.test(child.name)) continue;
      child.traverse(part => {
        const vertices = part.geometry?.getAttribute('position');
        if (!vertices) return;
        triangles += (part.geometry.index?.count ?? vertices.count) / 3;
        const toBody = inverse.clone().multiply(part.matrixWorld);
        for (let i = 0; i < vertices.count; i++) bounds.expandByPoint(point.fromBufferAttribute(vertices, i).applyMatrix4(toBody));
      });
    }
    // Static parts may batch by material; geometry, rather than draw count,
    // proves that the actual body built successfully in the headless runtime.
    ok(triangles > 300, `${id}: procedural model builds body geometry in Node`);
    near(bounds.min.z, model.T.muzzle[2], 1e-4, `${id}: barrel tip lands exactly on T.muzzle`);
    near(model.body.userData.sightHeight, SIGHT_HEIGHT[id], 1e-9, `${id}: model sight height matches the hitbox table`);
    near(-model.T.adsOffset.y, SIGHT_HEIGHT[id], 1e-9, `${id}: ADS offset centres the sight line`);
    // The sight axis (x 0, y sightHeight) is clear of opaque geometry along the whole gun.
    const ray = new THREE.Raycaster(new THREE.Vector3(0, SIGHT_HEIGHT[id], 1), new THREE.Vector3(0, 0, -1), 0, 3);
    const blocked = ray.intersectObject(model.body, true).filter(hit => hit.object.material?.transparent !== true
      && !/^hand_/.test(hit.object.parent?.name || '') && hit.object.visible);
    eq(blocked.length, 0, `${id}: sight axis clear of opaque geometry`);
  }
  disposeGunModels(models, cache);

  const { titanfallProjectileViews } = await import('../public/js/titanfall/projectile-views.js');
  const views = await import('../public/js/titanfall/pilot-projectile-views.js');
  ok(titanfallProjectileViews.has('archer') && titanfallProjectileViews.has('arcball'), 'archer and arcball views registered');
  const scene = new THREE.Scene();
  const emitted = [];
  views.init({ particleField: { emit: (kind) => emitted.push(kind) }, liveEffectsGroup: scene }, null);
  // The real orienter: ProjectileFX flies (and re-orients) these records through its vehicle-shell branch.
  const { ProjectileFX } = await import('../public/js/weapons/projectiles.js');
  const fx = { projectiles: new Map(), scene, _localSeq: 0, _aimTarget: new THREE.Vector3(), _orientRocket: ProjectileFX.prototype._orientRocket };
  ok(titanfallProjectileViews.get('archer').launch(fx, { pid: 'r1', type: 'archer', o: [0, 12, 0], v: [0, 0, -90], g: 0, fuse: 3200 }, {}),
    'archer launch inserts a flight record');
  for (const [pid, velocity] of [['r1', null], ['r3', [55, 20, 68]]]) {
    if (velocity) titanfallProjectileViews.get('archer').launch(fx, { pid, type: 'archer', o: [4, 12, 4], v: velocity, g: 0 }, {});
    const record = fx.projectiles.get(pid);
    record.group.updateWorldMatrix(true, true);
    const centreOf = mesh => { mesh.geometry.computeBoundingBox(); return mesh.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld); };
    const seeker = record.group.children.find(child => child.geometry?.type === 'SphereGeometry');
    const dir = new THREE.Vector3(record.vx, record.vy, record.vz).normalize();
    const lead = mesh => centreOf(mesh).sub(record.group.position).dot(dir);
    ok(lead(seeker) > 0.5 && lead(record.group.userData.exhaust) < -0.5,
      `archer ${pid}: the seeker leads along the velocity and the motor flame trails (${lead(seeker).toFixed(2)} / ${lead(record.group.userData.exhaust).toFixed(2)})`);
  }
  ok(titanfallProjectileViews.get('arcball').launch(fx, { pid: 'r2', type: 'arcball', o: [0, 12, 0], v: [0, 0, -30], g: 0, fuse: 2500 }, {}),
    'arcball launch inserts a flight record');
  ok(!titanfallProjectileViews.get('arcball').launch(fx, { pid: 'r2', type: 'arcball', o: [0, 12, 0], v: [0, 0, -30] }, {}),
    'a repeated remote launch is ignored');
  const archer = fx.projectiles.get('r1'), orb = fx.projectiles.get('r2');
  ok(archer.vehicleShell && archer.gravity === 0 && archer.trailAt === 0 && Math.abs(archer.fuse - 3.2) < 1e-9, 'archer: straight vehicle-shell flight with a smoke trail');
  ok(orb.vehicleShell && orb.trailAt === Infinity, 'arcball: no smoke trail');
  archer.age = orb.age = 0.2;
  views.frame(0.1, {});
  ok(emitted.includes('fire') && emitted.includes('spark'), 'motor flame and orb crackle emit particles');
  views.onEvent({ kind: 'arcZap', pid: 'r2', o: [0, 12, -3], to: [[2, 12, -5], [-1, 11, -6]] });
  const lines = () => scene.children.filter(child => child.isLine && child.visible);
  eq(lines().length, 2, 'arcZap draws one arc per struck target');
  for (let i = 0; i < 4; i++) views.frame(0.06, {});
  eq(lines().length, 0, 'arcs fade within a quarter second');
  views.onEvent({ kind: 'projectileExplode', type: 'arcball', pid: 'r2', x: 0, y: 12, z: -6 });
  ok(lines().length >= 3, 'the orb bursts into a fan of arcs');
  views.dispose();
  ok(scene.children.filter(child => child.isLine).length === 0, 'dispose removes the arc pool');
}

for (const line of notes) console.log(`  ${line}`);
for (const line of pending) console.log(`  PENDING ${line}`);
console.log(`titanfall-at-weapons-test: ${checks} checks passed${pending.length ? ` (${pending.length} pending orchestrator hunks)` : ''}`);
