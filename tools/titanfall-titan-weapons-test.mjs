// Titan weapons and abilities (docs/titanfall.md §5.4–5.5, §11.1 WP3 row):
// every primary's sustained DPS vs a titan within ±20 % of the §5.4 table
// (measured through the real mount path, reload included), infantry damage per
// primary, the 6-tuple mount row (railgun charge, Predator spin), and every
// ability primitive: vortex catch cap and throw-back, guards (thermal, gun
// shield, sword block), firewall ground line, arc wave slow, VTOL hover, phase
// blink stopping at voxels, Mode Switch toggle, tether root, tripwire, cluster,
// incendiary trap ignited by thermite, the core meter (core damage excluded),
// cores, electric smoke, titan melee and the doomed-titan execution. Ends with
// primary-only duels between every titan pair (TTK table, printed).
// Node only, headless, no audio.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { getMapMeta, createMapState } from '../shared/world/templates.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { AIR, STONE } from '../shared/world/blocks.js';
import { TITAN_ABILITIES, TITAN_COMMON_ABILITIES, TITAN_TYPE_IDS, TITAN_ABILITY_BITS, TITAN_WEAPON_META, decodeTitanRow } from '../shared/titan-contract.js';
import { TITAN_WEAPONS, TITAN_WEAPON_DPS } from '../shared/vehicle-handling/titan-weapons.js';
import { TITAN_RULES, titanFrame } from '../shared/vehicle-handling/titan.js';
import { VEHICLE_WEAPONS, vehicleMaxHp, mountPose, vehicleDef, vehicleLocalPoint } from '../shared/vehicle-defs.js';
import { combatDamage } from '../shared/combat-balance.js';
import { aimAngles } from '../server/sim/player.js';
import { ABILITY_TUNING, guardTitanDamage, guardRay, guardSphere } from '../server/sim/titanfall/titan-abilities.js';
import { titanCockpitEye, titanSightRay } from '../server/sim/titanfall/titan-mounts.js';

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const near = (actual, expected, tolerance, message) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected} ±${tolerance}`); checks++;
};
const notes = [];

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
Math.random = seeded(0x3a77);

const TICKS_PER_S = 1000 / TICK_MS;
const ticks = seconds => Math.round(seconds * TICKS_PER_S);
const DROP_TICKS = Math.ceil((TITAN_RULES.drop.markerMs + TITAN_RULES.drop.fallMs) / TICK_MS) + 2;
/** Whether applyTitanDamage calls guardTitanDamage (request titan-damage-guard.patch), found end to end in the vortex section. */
let hooked = false;

/* ---------------------------------------------------------------- arena */
const G = 10;
const ARENA = { minX: 30, maxX: 160, minZ: 52, maxZ: 92 };
function flatten(engine, rect, level = G) {
  const world = engine.world, sy = world.dimensions.sy;
  for (let x = rect.minX; x < rect.maxX; x++) for (let z = rect.minZ; z < rect.maxZ; z++) {
    for (let y = 0; y < sy; y++) world.setBlock(x, y, z, y < level ? STONE : AIR);
  }
  engine.blockRevision++;
}
function setBlocks(engine, x0, x1, y0, y1, z0, z1, value) {
  for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) engine.world.setBlock(x, y, z, value);
  engine.blockRevision++;
}
/** Every alive pilot untouchable until `place` (auto-titans land and look for targets while the test sets up). */
const shelter = f => { for (const p of f.engine.entities.values()) if (p.state === 'alive') p.spawnProtectedUntil = Infinity; };
function arena(roster = [['a1', 'alpha'], ['a2', 'alpha'], ['b1', 'bravo'], ['b2', 'bravo']]) {
  const f = { events: [], last: null };
  f.engine = new GameEngine({ mode: 'titanfall', mapMeta: getMapMeta('harbor'), world: createMapState('harbor'),
    broadcast: s => { f.last = s; for (const e of s.events ?? []) f.events.push(e); } });
  f.policy = f.engine.mode.policy;
  f.titans = f.engine.vehicles.titans;
  f.vehicles = f.engine.vehicles;
  for (const [id, team] of roster) { f.engine.addClient(id, id.toUpperCase()); f.policy.setLobbyTeam(id, team); f.policy.deployNow(id); }
  flatten(f.engine, ARENA);
  f.step = (n = 1, each = null) => { for (let i = 0; i < n; i++) { each?.(i); f.engine.step(TICK_MS); } };
  f.step(2);
  f.p = id => f.engine.entities.get(id);
  f.kinds = kind => f.events.filter(e => e.kind === kind);
  f.row = id => f.last?.vehicles?.find(r => r.id === id) ?? null;
  shelter(f);
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
/** A landed titan of `type` for `owner` at (x, z), nose along yaw (forward is (-sin, -cos)). */
function landTitan(f, owner, type, x, z, yaw) {
  const v = f.titans.spawnDrop(owner, x, G, z, type, yaw);
  assert.ok(v, `spawnDrop ${type}`);
  f.step(DROP_TICKS + ticks(1.1));
  assert.ok(!v.dropping && v.hp > 0, `${type} landed`);
  return v;
}
function embark(f, p, v) {
  place(p, v.x + Math.sin(v.yaw) * (titanFrame(v).hl + 1.2), v.z + Math.cos(v.yaw) * (titanFrame(v).hl + 1.2), v.yaw);
  const entered = f.vehicles.action(p, { type: 'enter', vehicleId: v.id });
  f.step(ticks(TITAN_RULES.embark.animMs / 1000) + 2);
  assert.ok(entered && p.vehicleId === v.id, `${p.id} embarks ${v.type}`);
  return entered;
}
/** Chest height: the torso box (the gap between the legs passes shells under it). */
const centre = v => [v.x, v.y + titanFrame(v).height * 0.65, v.z];
function drive(p, { throttle = 0, steer = 0, yaw, pitch = 0, hold = 0, fire = false } = {}) {
  p.input = { ...(p.input || {}), keys: {}, vehicleThrottle: throttle, vehicleSteer: steer, yaw, pitch, titanHold: hold, wantFire: fire };
}
/** Point `p` (piloting v) at `point` from the cockpit eye: the crosshair the seat sends (the mount converges on it). */
function aimTitan(p, v, point, extra = {}) {
  const a = aimAngles(titanCockpitEye(v), point);
  drive(p, { yaw: a.yaw, pitch: a.pitch, ...extra });
}
const faceYaw = (from, to) => Math.atan2(-(to[0] - from[0]), -(to[2] - from[2]));
const dealtBy = (v, id) => v.damageLog?.get(String(id))?.dmg ?? 0;
const refill = v => { v.hp = vehicleMaxHp(v); v.shield = 0; v.doomed = false; v.doomPool = 0; };
const lastKill = (f, victim) => f.kinds('kill').filter(e => e.victim === victim).at(-1) ?? null;
const PRIMARY = { titan_ion: 'splitter', titan_scorch: 't203', titan_northstar: 'railgun', titan_ronin: 'leadwall', titan_legion: 'predatorClose' };

/** A shooter (a1, piloted) of `type` facing a target titan (b1, piloted, idle) `gap` m ahead along +X. */
function duelPair(type, targetType = 'titan_ion', gap = 16) {
  const f = arena();
  const [a1, b1] = ['a1', 'b1'].map(f.p);
  for (const id of ['a2', 'b2']) park(f, f.p(id));
  place(b1, 40, 88, 0);
  shelter(f);
  const shooter = landTitan(f, a1, type, 60, 72, -Math.PI / 2);
  embark(f, a1, shooter);
  const target = landTitan(f, b1, targetType, 60 + gap, 72, Math.PI / 2);
  embark(f, b1, target);
  refill(shooter); shooter.shield = TITAN_RULES.dropShieldFrac * vehicleMaxHp(shooter);
  drive(b1, { yaw: Math.PI / 2 });
  return { f, a1, b1, shooter, target };
}

/* ================================================================ weapon table */
{
  for (const [key, w] of Object.entries(TITAN_WEAPONS)) {
    for (const field of ['cooldown', 'magazine', 'reloadSeconds', 'range', 'spreadDeg', 'lifetimeMs', 'speed', 'gravity', 'damage', 'infantryDamage']) {
      ok(typeof w[field] === 'number', `${key}.${field} is a number`);
    }
    eq(w.cls, 'titan', `${key} cls titan`);
    eq(VEHICLE_WEAPONS[key]?.damage, w.damage, `${key} is in VEHICLE_WEAPONS`);
  }
  // Analytic sustained DPS (one magazine cycle incl. reload) vs the §5.4 table.
  const cycle = {
    // The reload starts at the last round: a magazine cycle is (magazine − 1) × cooldown + reload.
    splitter: w => w.magazine * w.damage / ((w.magazine - 1) * w.cooldown + w.reloadSeconds),
    t203: w => w.damage / Math.max(w.cooldown, w.reloadSeconds),
    railgun: w => w.damageCharged / (w.chargeSeconds + w.cooldown),
    leadwall: w => w.magazine * w.pellets * w.damage / ((w.magazine - 1) * w.cooldown + w.reloadSeconds),
    predatorClose: w => w.magazine * w.damage / ((w.magazine - 1) * w.cooldown + w.reloadSeconds + w.spinUpSeconds),
    predatorLong: w => w.magazine * w.damage / ((w.magazine - 1) * w.cooldown + w.reloadSeconds + w.spinUpSeconds),
  };
  for (const [key, dps] of Object.entries(cycle)) {
    const value = dps(TITAN_WEAPONS[key]);
    ok(Math.abs(value / TITAN_WEAPON_DPS[key] - 1) <= 0.2, `${key} analytic sustained DPS ${value.toFixed(1)} within ±20 % of ${TITAN_WEAPON_DPS[key]}`);
    notes.push(`analytic ${key}: ${value.toFixed(1)} dps (table ${TITAN_WEAPON_DPS[key]})`);
  }
}

/* ================================================================ measured sustained DPS through the mount path */
const MEASURE_S = 60;
// Splitter ADS (titanHold 4: split beams for ION energy) is measured too, against the same band.
for (const [type, key, hold = 0] of [['titan_ion', 'splitter'], ['titan_ion', 'splitter', 4], ['titan_scorch', 't203'], ['titan_northstar', 'railgun'], ['titan_ronin', 'leadwall'],
  ['titan_legion', 'predatorClose'], ['titan_legion', 'predatorLong']]) {
  const { f, a1, shooter, target } = duelPair(type);
  const label = hold & 4 ? `${key} ADS` : key;
  if (key === 'predatorLong') { ok(f.titans.ability(shooter, a1, 'tac'), 'Mode Switch to predatorLong'); f.step(ticks(0.7)); }
  eq(f.vehicles.mounts.selected(shooter, 'driver')?.weapon, key, `${type} fires ${key}`);
  let start = 0, startAt = 0, shots = 0, hullHits = 0;
  const shootTick = () => {
    refill(target);
    if (key === 't203') f.engine.projectiles.fire.clear();     // direct damage only (the patch is checked on its own)
    const state = shooter.mounts[0];
    const release = key === 'railgun' && state.charge >= 1;
    aimTitan(a1, shooter, centre(target), { fire: !release, hold });
  };
  aimTitan(a1, shooter, centre(target));
  f.step(ticks(1), () => aimTitan(a1, shooter, centre(target)));
  // The first magazine on its own (the ADS burst from a full energy pool), then the rest of the minute.
  const firstMag = { at: 0, dealt: 0 };
  start = dealtBy(target, 'a1'); startAt = f.engine.now;
  const shotsBefore = shooter.mounts[0].shots;
  const W = TITAN_WEAPONS[key], cycleS = Number.isFinite(W.magazine) ? (W.magazine - 1) * W.cooldown + W.reloadSeconds : 0;
  f.step(ticks(MEASURE_S), i => {
    shootTick();
    if (cycleS && i === ticks(cycleS)) { firstMag.at = (f.engine.now - startAt) / 1000; firstMag.dealt = dealtBy(target, 'a1') - start; }
  });
  shots = shooter.mounts[0].shots - shotsBefore;
  hullHits = dealtBy(target, 'a1') - start;
  const dps = hullHits / ((f.engine.now - startAt) / 1000);
  ok(Math.abs(dps / TITAN_WEAPON_DPS[key] - 1) <= 0.2, `${label} measured sustained DPS ${dps.toFixed(1)} within ±20 % of ${TITAN_WEAPON_DPS[key]}`);
  if (hold & 4) {
    const burst = firstMag.dealt / firstMag.at;
    ok(Math.abs(burst / TITAN_WEAPON_DPS[key] - 1) <= 0.2, `${label} first magazine ${burst.toFixed(1)} dps within ±20 % of ${TITAN_WEAPON_DPS[key]}`);
    ok(shooter.tfAbility.energy < ABILITY_TUNING.energy.max, 'ADS spends ION energy');
    notes.push(`measured ${label}: first magazine ${burst.toFixed(1)} dps`);
  }
  notes.push(`measured ${label}: ${dps.toFixed(1)} dps over ${MEASURE_S} s (${shots} shots, 16 m, front, from a cold trigger)`);
  f.engine.stop();
}

/* ================================================================ T-203 fire patch and thermite kill key */
{
  const { f, a1, shooter, target } = duelPair('titan_scorch');
  const spot = [target.x - titanFrame(target).hl - 1, G + 0.1, target.z];
  f.step(ticks(1), () => aimTitan(a1, shooter, spot));
  aimTitan(a1, shooter, spot, { fire: true });
  f.step(1);
  drive(a1, { yaw: a1.input.yaw, pitch: a1.input.pitch });
  f.step(ticks(1));
  const fields = [...f.engine.projectiles.fire.active.values()];
  ok(fields.some(field => field.key === 'thermite' && Math.abs(field.hullDamagePerSecond * 0.6 - 40) < 1e-9), 'thermite patch: titan 40 dps, kill key thermite');
  ok(fields.every(field => field.cells.length <= 40), 'thermite patch cell cap');
  const fx = fields[0];
  near((fx.expiresAt - fx.createdAt) / 1000, 3, 0.01, 'thermite patch lasts 3 s');
  f.engine.stop();
}

/* ================================================================ infantry damage per primary */
for (const [type, key] of [['titan_ion', 'splitter'], ['titan_northstar', 'railgun'], ['titan_legion', 'predatorLong'], ['titan_scorch', 't203'], ['titan_ronin', 'leadwall']]) {
  const f = arena();
  const [a1, b1, b2] = ['a1', 'b1', 'b2'].map(f.p);
  park(f, f.p('a2'));
  shelter(f);
  const v = landTitan(f, a1, type, 60, 72, -Math.PI / 2);
  embark(f, a1, v);
  place(b2, 72, 72, Math.PI / 2);
  place(b1, 40, 60, 0);
  b2.hp = 100;
  if (key === 'predatorLong') { f.titans.ability(v, a1, 'tac'); f.step(ticks(0.7)); }
  const target = [b2.x, b2.y + 1.0, b2.z];
  f.step(ticks(1), () => { place(b2, 72, 72, Math.PI / 2); aimTitan(a1, v, target); });
  const hpBefore = b2.hp;
  let fired = false;
  f.step(ticks(4), () => {
    if (key === 't203') f.engine.projectiles.fire.clear();   // the shell's own damage (the thermite patch is checked on its own)
    if (fired || b2.state !== 'alive') { drive(a1, { yaw: a1.input.yaw, pitch: a1.input.pitch }); return; }
    place(b2, 72, 72, Math.PI / 2);
    const state = v.mounts[0];
    const release = key === 'railgun' && state.charge >= 1;
    aimTitan(a1, v, target, { fire: !release });
    if (release || (key !== 'railgun' && state.shots > 0)) fired = true;
  });
  const w = TITAN_WEAPONS[key];
  const want = combatDamage(w.infantryDamageCharged ?? w.infantryDamage);
  const lost = b2.state === 'alive' ? hpBefore - b2.hp : hpBefore;
  if (key === 'leadwall') ok(lost >= want - 1e-6, `leadwall: at least one pellet (${want}) hits the pilot at 12 m (lost ${lost})`);
  else if (key === 'railgun') ok(b2.state !== 'alive' && lastKill(f, 'b2')?.w === 'railgun', 'railgun full charge kills a pilot (200 infantry)');
  else if (key === 'predatorLong') ok(lost >= want - 1e-6 && Math.abs(lost / want - Math.round(lost / want)) < 1e-6, `predatorLong infantry ${want} per round (lost ${lost})`);
  else near(lost, want, 1e-6, `${key} infantry damage`);
  if (b2.state !== 'alive') eq(lastKill(f, 'b2')?.w, key, `${key} kill key`);
  notes.push(`infantry ${key}: ${lost.toFixed(1)} hp from one trigger pull at 12 m`);
  f.engine.stop();
}

/* ================================================================ 6-tuple mount rows: railgun charge, Predator spin */
{
  const { f, a1, shooter } = duelPair('titan_northstar');
  const row = () => f.row(shooter.id)?.mounts?.[0];
  eq(row()?.length, 6, 'titan mount row is a 6-tuple');
  drive(a1, { yaw: -Math.PI / 2, fire: true });
  f.step(ticks(0.8));
  const half = row()[5];
  ok(half >= 40 && half <= 60, `railgun charge100 ≈ 50 after 0.8 s (${half})`);
  f.step(ticks(1));
  eq(row()[5], 100, 'railgun charge100 full after 1.6 s');
  eq(shooter.mounts[0].shots, 0, 'a held railgun waits for the release');
  drive(a1, { yaw: -Math.PI / 2, fire: false });
  f.step(2);
  eq(shooter.mounts[0].shots, 1, 'release fires');
  eq(f.kinds('shoot').filter(e => e.vehicleWeapon === 'railgun').at(-1)?.charge, 1, 'the shoot event carries the charge it left at (client crack, beam, kick)');
  eq(row()[5], 0, 'charge back to 0 after the shot');
  f.engine.stop();
}
{
  const { f, a1, shooter } = duelPair('titan_legion');
  const row = () => f.row(shooter.id)?.mounts?.[0];
  drive(a1, { yaw: -Math.PI / 2, fire: true });
  f.step(ticks(0.3));
  ok(row()[5] > 30 && row()[5] < 70 && shooter.mounts[0].shots === 0, `predator spins up before firing (${row()[5]})`);
  f.step(ticks(0.5));
  ok(row()[5] === 100 && shooter.mounts[0].shots > 0, 'predator fires at full spin');
  drive(a1, { yaw: -Math.PI / 2 });
  f.step(ticks(0.6));
  ok(row()[5] > 30 && row()[5] < 70, `predator spins down (${row()[5]})`);
  for (const type of TITAN_TYPE_IDS) eq(VEHICLE_WEAPONS[PRIMARY[type]] ? 1 : 0, 1, `${type} primary present`);
  f.engine.stop();
}

/* ================================================================ auto-titan fires charge/spin weapons via mounts.fire */
for (const type of ['titan_northstar', 'titan_legion']) {
  const f = arena();
  const [a1, b1] = ['a1', 'b1'].map(f.p);
  for (const id of ['a2', 'b2']) park(f, f.p(id));
  const auto = landTitan(f, a1, type, 60, 72, -Math.PI / 2);
  const target = landTitan(f, b1, 'titan_ion', 80, 72, Math.PI / 2);
  embark(f, b1, target);
  place(a1, 40, 88, 0);
  f.step(ticks(6), () => { refill(target); drive(b1, { yaw: Math.PI / 2 }); });
  ok(auto.mounts[0].shots > 0 && dealtBy(target, 'a1') > 0, `${type} auto-titan fires its ${PRIMARY[type]} through mounts.fire`);
  f.engine.stop();
}

/* ================================================================ vortex: catch cap, throw-back */
{
  const { f, a1, b1, shooter: ion, target: legion } = duelPair('titan_ion', 'titan_legion', 18);
  const row = TITAN_ABILITIES.titan_ion.defensive;
  // b1 (LEGION) pours Predator rounds into the ION's raised vortex.
  drive(a1, { yaw: -Math.PI / 2, hold: 2 });
  ok(f.titans.ability(ion, a1, 'def'), 'vortex on the defensive press');
  f.step(2);
  const guard = ion.tfAbility.guard;
  ok(guard?.kind === 'vortex', 'vortex up while held');
  ok(decodeTitanRow(f.row(ion.id))?.bits & TITAN_ABILITY_BITS.defensive, 'defensive bit while the vortex is up');
  const hp0 = ion.hp + ion.shield;
  let fullAt = null;
  f.step(ticks(3.2), () => {
    drive(a1, { yaw: -Math.PI / 2, hold: 2 });
    aimTitan(b1, legion, centre(ion), { fire: true });
    if (fullAt === null && guard.weight >= row.maxCaught) fullAt = ion.hp + ion.shield;
  });
  eq(guard.weight, row.maxCaught, `vortex catches at most ${row.maxCaught}`);
  eq(guard.caught.length, row.maxCaught, 'caught list capped');
  ok(fullAt !== null && fullAt >= hp0 - 1e-6, 'nothing reached the hull before the cap');
  ok(ion.hp + ion.shield < fullAt, 'rounds pass a full vortex');
  const legionBefore = dealtBy(legion, 'a1');
  drive(a1, { yaw: -Math.PI / 2, hold: 0 });
  drive(b1, { yaw: Math.PI / 2 });
  f.step(2);
  ok(!ion.tfAbility.guard, 'release drops the vortex');
  const back = dealtBy(legion, 'a1') - legionBefore;
  const caughtSum = row.maxCaught * TITAN_WEAPONS.predatorClose.damage;
  ok(back >= caughtSum - 1e-6 && back <= caughtSum * 1.15 + 1e-6, `throw-back returns the caught rounds at their titan-side damage (${back.toFixed(1)} of ${caughtSum}, zones apply)`);
  ok(ion.tfAbility.readyAt.defensive > f.engine.now + 9000, 'vortex cooldown starts at the release');
  const thrown = f.events.filter(e => e.kind === 'shoot' && e.ability === 'vortexThrow').at(-1);
  eq(thrown?.paths?.length, Math.min(ABILITY_TUNING.vortex.throwRays, row.maxCaught), 'the throw-back sends a shoot event with a path per ray');
  // Pilot weapons (applyTitanDamage → guardTitanDamage): a pilot AT round through the vortex is caught, weight 5.
  const pilot = f.p('b2');
  if (pilot.state !== 'alive') { pilot.respawnAt = 0; f.step(ticks(5)); }
  place(pilot, ion.x + 12, ion.z, Math.PI / 2);
  drive(b1, { yaw: Math.PI / 2 });
  const g2 = { kind: 'vortex', weight: 0, caught: [], until: Infinity, startedAt: f.engine.now, sawHold: false };
  ion.tfAbility.guard = g2;
  eq(guardTitanDamage(f.titans, ion, 400, 'at', pilot, { point: centre(ion) }), 0, 'guardTitanDamage: a pilot AT round through the vortex is caught');
  eq(g2.weight, row.rocketWeight, 'an AT rocket weighs 5 in the vortex');
  eq(guardTitanDamage(f.titans, ion, 400, 'at', f.p('b1'), { point: centre(ion) }), 400, 'a titan source is checked on its own path (guardRay), not here');
  const hpBefore = ion.hp + ion.shield;
  f.vehicles.damage(ion.id, 400, pilot, { cls: 'at', point: centre(ion) });
  hooked = g2.weight > row.rocketWeight;
  if (hooked) {
    near(ion.hp + ion.shield, hpBefore, 1e-6, 'end to end: the pilot round never reaches the hull');
    eq(g2.weight, 2 * row.rocketWeight, 'end to end: caught');
  } else notes.push('PENDING titan-damage.js guard hook (request titan-damage-guard.patch): pilot shots into a vortex / sword block not checked end to end');
  ion.tfAbility.guard = null;
  f.engine.stop();
}

/* ================================================================ guards: thermal shield, gun shield, sword block */
{
  const { f, a1, b1, shooter: scorch, target: ion } = duelPair('titan_scorch', 'titan_ion', 14);
  ok(f.titans.ability(scorch, a1, 'def'), 'thermal shield up');
  const before = scorch.hp + scorch.shield, ionBefore = dealtBy(ion, 'a1');
  f.step(ticks(2), () => { drive(a1, { yaw: -Math.PI / 2 }); aimTitan(b1, ion, centre(scorch), { fire: true }); });
  near(scorch.hp + scorch.shield, before, 1e-6, 'thermal shield blocks splitter rounds');
  eq(dealtBy(ion, 'a1') - ionBefore, 0, 'thermal burn does not reach 14 m');
  f.engine.stop();
}
{
  const { f, a1, b1, shooter: legion, target: ion } = duelPair('titan_legion', 'titan_ion', 16);
  ok(f.titans.ability(legion, a1, 'def'), 'gun shield up');
  const guard = legion.tfAbility.guard;
  eq(guard.kind, 'gunShield', 'gun shield guard');
  const before = legion.hp + legion.shield;
  f.step(ticks(1.2), () => { drive(a1, { yaw: -Math.PI / 2 }); aimTitan(b1, ion, mountPose(legion, 'driver', vehicleDef(legion).seats[0].mounts[0]).origin, { fire: true }); });
  ok(guard.hp < TITAN_ABILITIES.titan_legion.defensive.hp, `gun shield absorbs (${guard.hp.toFixed(0)} hp left)`);
  near(legion.hp + legion.shield, before, 1e-6, 'nothing passes the gun shield');
  // The primary still fires behind the gun shield.
  aimTitan(a1, legion, centre(ion), { fire: true });
  f.step(ticks(1));
  ok(legion.mounts[0].shots > 0, 'Legion fires behind its gun shield');
  f.engine.stop();
}
{
  const f = arena();
  const [a1] = ['a1'].map(f.p);
  for (const id of ['a2', 'b1', 'b2']) park(f, f.p(id));
  const ronin = landTitan(f, a1, 'titan_ronin', 60, 72, -Math.PI / 2);
  embark(f, a1, ronin);
  drive(a1, { yaw: -Math.PI / 2, hold: 2 });
  ok(f.titans.ability(ronin, a1, 'def'), 'sword block on the press');
  f.step(ticks(1));
  eq(ronin.tfAbility.guard?.kind, 'block', 'sword block while held (past the 1.5 s unheld time)');
  f.step(ticks(1));
  eq(ronin.tfAbility.guard?.kind, 'block', 'sword block stays while held');
  near(ronin.tfMove.damageTakenMul, 0.3, 1e-9, 'sword block damageTakenMul 0.3');
  const front = [ronin.x + 10, ronin.y + 3, ronin.z], rear = [ronin.x - 10, ronin.y + 3, ronin.z];
  const shooter = { id: 'b1', x: front[0], y: G, z: front[2] };
  eq(guardTitanDamage(f.titans, ronin, 100, 'titan', null, { origin: front, point: centre(ronin) }), 100, 'sword block: front hits keep the 0.3 reduction');
  near(guardTitanDamage(f.titans, ronin, 100, 'titan', null, { origin: rear, point: centre(ronin) }), 100 / 0.3, 1e-9, 'sword block: rear hits get the reduction back');
  void shooter;
  if (hooked) {
    const total = () => ronin.hp + ronin.shield;
    let before = total();
    f.vehicles.damage(ronin.id, 100, null, { cls: 'titan', origin: front, point: [ronin.x + titanFrame(ronin).hl, ronin.y + 3, ronin.z], sourceTeam: 'bravo' });
    near(before - total(), 30, 1e-6, 'end to end: a front hit on the sword block deals 30 %');
    before = total();
    f.vehicles.damage(ronin.id, 100, null, { cls: 'titan', origin: rear, point: [ronin.x - titanFrame(ronin).hl, ronin.y + 3, ronin.z], sourceTeam: 'bravo' });
    near(before - total(), 130, 1e-6, 'end to end: a rear hit ignores the sword block (rear zone 1.3)');
  }
  ok(!f.vehicles.mounts.fire(ronin, vehicleDef(ronin).seats[0], a1, vehicleDef(ronin).seats[0].mounts[0], 'leadwall'), 'no leadwall while blocking');
  drive(a1, { yaw: -Math.PI / 2, hold: 0 });
  f.step(ticks(0.4));
  ok(!ronin.tfAbility.guard && ronin.tfMove.damageTakenMul === 1, 'release ends the block');
  // The press arrives before the held bit: the block still lasts while held.
  f.step(ticks(0.2));
  drive(a1, { yaw: -Math.PI / 2, hold: 0 });
  ok(f.titans.ability(ronin, a1, 'def'), 'sword block press without the bit yet');
  drive(a1, { yaw: -Math.PI / 2, hold: 2 });
  f.step(ticks(2));
  eq(ronin.tfAbility.guard?.kind, 'block', 'held bit after the press keeps the block past 1.5 s');
  drive(a1, { yaw: -Math.PI / 2, hold: 0 });
  f.step(ticks(0.4));
  ok(!ronin.tfAbility.guard, 'release ends it');
  f.engine.stop();
}

/* ================================================================ firewall ground line, arc wave slow */
{
  const f = arena();
  const [a1, b1, b2] = ['a1', 'b1', 'b2'].map(f.p);
  park(f, f.p('a2'));
  const scorch = landTitan(f, a1, 'titan_scorch', 50, 72, -Math.PI / 2);
  const ion = landTitan(f, b1, 'titan_ion', 68, 72, Math.PI / 2);
  embark(f, a1, scorch);
  place(b2, 60, 72.4, 0);
  // A one-voxel step at x 56 (the line climbs it) and a 4-high wall at x 76 (the line stops).
  setBlocks(f.engine, 56, 76, G, G + 1, 66, 78, STONE);
  setBlocks(f.engine, 76, 78, G, G + 5, 66, 78, STONE);
  drive(a1, { yaw: -Math.PI / 2 });
  f.step(ticks(0.5));
  ok(f.titans.ability(scorch, a1, 'ord'), 'firewall');
  const line = scorch.tfAbility.lines[0];
  f.step(ticks(2.5), () => { refill(ion); drive(a1, { yaw: -Math.PI / 2 }); });
  ok(line.points.some(p => p[1] >= G + 1 - 1e-6), 'the firewall climbs a one-voxel step');
  ok(line.points.at(-1)[0] < 76 && line.stopped, `the firewall stops at the wall (${line.points.at(-1)[0].toFixed(1)})`);
  ok(line.points.every(p => Math.abs((p[0] - line.points[0][0]) * line.dz - (p[2] - line.points[0][2]) * line.dx) < 1e-6) && Math.abs(line.dz) < 0.1,
    'the firewall runs straight along the aim');
  ok(dealtBy(ion, 'a1') > 0, 'the ION standing on the line burns');
  ok(b2.hp < 100 || b2.state !== 'alive', 'a pilot on the line burns');
  const burnt = dealtBy(ion, 'a1');
  f.step(ticks(1), () => refill(ion));
  const perSecond = dealtBy(ion, 'a1') - burnt;
  near(perSecond, TITAN_ABILITIES.titan_scorch.ordnance.dps * 0.6, 0.35 * 120 * 0.6, 'firewall titan dps (×0.6 fire)');
  f.engine.stop();
}
{
  const { f, a1, shooter: ronin, target: ion } = duelPair('titan_ronin', 'titan_ion', 14);
  drive(a1, { yaw: -Math.PI / 2 });
  ok(f.titans.ability(ronin, a1, 'tac'), 'arc wave');
  f.step(ticks(1));
  near(dealtBy(ion, 'a1'), TITAN_ABILITIES.titan_ronin.tactical.damage, 1e-6, 'arc wave hits once for 250');
  ok(ion.tfAbility.slowUntil > f.engine.now && ion.tfMove.speedMul === 0.5, 'arc wave slows to 0.5');
  f.step(ticks(1.2));
  eq(ion.tfMove.speedMul, 1, 'slow ends after 1 s');
  f.engine.stop();
}

/* ================================================================ VTOL hover, Flight Core */
{
  const f = arena();
  const [a1] = ['a1'].map(f.p);
  for (const id of ['a2', 'b1', 'b2']) park(f, f.p(id));
  const ns = landTitan(f, a1, 'titan_northstar', 60, 72, -Math.PI / 2);
  embark(f, a1, ns);
  drive(a1, { yaw: -Math.PI / 2 });
  const y0 = ns.y;
  ok(f.titans.ability(ns, a1, 'tac'), 'VTOL hover');
  eq(ns.tfMove.hoverVy, 0, 'hoverVy 0 from the press (§5.5: no rise, the predictor mirrors 0 from the hover bit)');
  f.step(ticks(1));
  ok(ns.tfMove.hoverVy === 0 && Math.abs(ns.y - y0) < 0.05, `hover holds its height (y ${(ns.y - y0).toFixed(2)})`);
  ok(decodeTitanRow(f.row(ns.id)).bits & TITAN_ABILITY_BITS.hover, 'hover bit');
  eq(ns.tfMove.speedMul, 0.5, 'hover at half speed');
  const held = ns.y;
  f.step(ticks(1));
  near(ns.y, held, 0.05, 'hover holds its height');
  f.step(ticks(1.5));
  eq(ns.tfMove.hoverVy, null, 'hover ends after 3 s');
  f.step(ticks(2));
  near(ns.y, y0, 0.05, 'back on the ground');
  ok(!f.titans.ability(ns, a1, 'tac'), 'hover on cooldown');
  // Flight Core: hover plus 24 rockets.
  ns.tfAbility.core = 1;
  ok(f.titans.ability(ns, a1, 'core'), 'flight core');
  const launches = () => f.kinds('projectileLaunch').filter(e => e.type === 'flightRocket').length;
  f.step(ticks(4.2), () => drive(a1, { yaw: -Math.PI / 2 }));
  eq(launches(), TITAN_ABILITIES.titan_northstar.core.rockets, 'flight core fires 24 rockets');
  f.engine.stop();
}

/* ================================================================ phase dash: blink, stops at voxels, phased */
{
  const f = arena();
  const [a1] = ['a1'].map(f.p);
  for (const id of ['a2', 'b1', 'b2']) park(f, f.p(id));
  const ronin = landTitan(f, a1, 'titan_ronin', 60, 72, -Math.PI / 2);
  embark(f, a1, ronin);
  drive(a1, { yaw: -Math.PI / 2, throttle: 0 });
  f.step(2);
  const x0 = ronin.x;
  ok(f.titans.ability(ronin, a1, 'ord'), 'phase dash');
  near(ronin.x - x0, TITAN_ABILITIES.titan_ronin.ordnance.blink, 0.3, 'phase dash blinks 8 m forward in the open');
  ok(ronin.tfMove.phasedUntil > f.engine.now, 'phased after the blink');
  f.step(1);
  eq(ronin.tfMove.damageTakenMul, 0, 'phased: no damage taken');
  ok(decodeTitanRow(f.row(ronin.id)).bits & TITAN_ABILITY_BITS.phased, 'phased bit');
  f.step(ticks(9));
  // A wall 4 m ahead of the nose: the blink stops short of it.
  const nose = ronin.x + titanFrame(ronin).hl;
  setBlocks(f.engine, Math.floor(nose + 4), Math.floor(nose + 6), G, G + 8, 60, 85, STONE);
  const x1 = ronin.x;
  drive(a1, { yaw: -Math.PI / 2 });
  ok(f.titans.ability(ronin, a1, 'ord'), 'phase dash toward a wall');
  ok(ronin.x - x1 < 4.3 && ronin.x - x1 > 2.5, `the blink stops at the voxels (${(ronin.x - x1).toFixed(2)} m)`);
  ok(ronin.x + titanFrame(ronin).hl <= Math.floor(nose + 4) + 1e-6, 'the hull ends clear of the wall');
  f.engine.stop();
}

/* ================================================================ Mode Switch toggle, Power Shot */
{
  const { f, a1, shooter: legion, target } = duelPair('titan_legion', 'titan_ion', 16);
  drive(a1, { yaw: -Math.PI / 2 });
  eq(f.vehicles.mounts.selected(legion, 'driver').weapon, 'predatorClose', 'Legion starts on predatorClose');
  ok(f.titans.ability(legion, a1, 'tac'), 'Mode Switch');
  eq(f.vehicles.mounts.selected(legion, 'driver').weapon, 'predatorLong', 'Mode Switch → predatorLong');
  ok(!f.titans.ability(legion, a1, 'tac'), 'Mode Switch 0.6 s cooldown');
  f.step(ticks(0.7));
  ok(f.titans.ability(legion, a1, 'tac'), 'Mode Switch back');
  eq(f.vehicles.mounts.selected(legion, 'driver').weapon, 'predatorClose', 'Mode Switch → predatorClose');
  aimTitan(a1, legion, centre(target));
  f.step(2);
  ok(f.titans.ability(legion, a1, 'ord'), 'Power Shot (close)');
  const close = dealtBy(target, 'a1');
  ok(close > 0.6 * TITAN_ABILITIES.titan_legion.ordnance.damageClose, `power shot close at 16 m (${close.toFixed(0)})`);
  f.engine.stop();
}

/* ================================================================ tether, tripwire, cluster, laser shot, incendiary trap */
{
  const { f, a1, b1, shooter: ns, target: ion } = duelPair('titan_northstar', 'titan_ion', 14);
  drive(a1, { yaw: -Math.PI / 2 });
  ok(f.titans.ability(ns, a1, 'def'), 'tether 1');
  ok(f.titans.ability(ns, a1, 'def'), 'tether 2 (2 charges)');
  ok(!f.titans.ability(ns, a1, 'def'), 'no third charge');
  f.step(2);
  ok(ion.tfMove.rooted, 'the ION on the tether is rooted');
  near(dealtBy(ion, 'a1'), 2 * TITAN_ABILITIES.titan_northstar.defensive.damage, 1e-6, 'both tethers on the spot catch the ION: 2 × 200');
  eq(ns.tfAbility.deployables.length, 0, 'triggered tethers are spent');
  const x = ion.x;
  f.step(ticks(1), () => drive(b1, { yaw: Math.PI / 2, throttle: 1 }));
  near(ion.x, x, 1e-6, 'rooted: no walking');
  f.step(ticks(2.2), () => drive(b1, { yaw: Math.PI / 2 }));
  ok(!ion.tfMove.rooted, 'root ends after 3 s');
  // Cluster missile: 6 bursts × 80 on a titan.
  const before = dealtBy(ion, 'a1');
  aimTitan(a1, ns, centre(ion));
  f.step(2);
  ok(f.titans.ability(ns, a1, 'ord'), 'cluster missile');
  f.step(ticks(3.6), () => refill(ion));
  const cluster = dealtBy(ion, 'a1') - before;
  ok(cluster >= 4 * 80 * 0.5 && cluster <= 6 * 80 + 1e-6, `cluster bursts hit the titan (${cluster.toFixed(0)} of ≤ 480)`);
  f.engine.stop();
}
{
  const { f, a1, b1, shooter: ion, target } = duelPair('titan_ion', 'titan_scorch', 24);
  drive(a1, { yaw: -Math.PI / 2 });
  ok(f.titans.ability(ion, a1, 'tac'), 'laser tripwire');
  eq(ion.tfAbility.energy, ABILITY_TUNING.energy.max - TITAN_ABILITIES.titan_ion.tactical.energy, 'tripwire costs 350 energy');
  const mines = ion.tfAbility.deployables[0].mines;
  eq(mines.length, 3, '3 mines');
  near(Math.hypot(mines[2][0] - mines[0][0], mines[2][2] - mines[0][2]), 15, 1e-6, '15 m line');
  // The SCORCH walks into the line.
  f.step(ticks(4), () => { drive(b1, { yaw: Math.PI / 2, throttle: 1 }); });
  ok(dealtBy(target, 'a1') >= 260 * 0.5, `tripwire triggers on the walking titan (${dealtBy(target, 'a1').toFixed(0)})`);
  eq(ion.tfAbility.deployables.length, 0, 'tripwire spent');
  const placed = f.events.find(e => e.kind === 'titan_ability' && e.ability === 'tripwire');
  ok(placed?.id && placed.until > 0, 'tripwire event carries id and until');
  ok(f.events.some(e => e.kind === 'titan_ability' && e.ability === 'tripwireTrigger' && e.id === placed.id), 'tripwireTrigger names the line');
  ok(f.events.some(e => e.kind === 'titan_ability' && e.ability === 'deployableEnd' && e.id === placed.id), 'deployableEnd when the line is spent');
  // Laser shot from the chest anchor.
  ion.tfAbility.energy = ABILITY_TUNING.energy.max;
  aimTitan(a1, ion, centre(target));
  drive(b1, { yaw: Math.PI / 2 });
  f.step(2);
  const before = dealtBy(target, 'a1');
  ok(f.titans.ability(ion, a1, 'ord'), 'laser shot');
  near(dealtBy(target, 'a1') - before, 400, 1e-6, 'laser shot 400');
  f.step(1);
  const laserShoot = f.events.filter(e => e.kind === 'shoot' && e.ability === 'laserShot').at(-1);
  ok(laserShoot && laserShoot.vehicleId === String(ion.id) && laserShoot.tracer && laserShoot.paths?.[0]?.[0]?.end?.length === 3,
    'laser shot: a vehicle shoot event with a tracer path (vehicle-fx draws it)');
  ok(f.titans.ability(ion, a1, 'ord'), 'a second laser shot from the rest of the pool');
  ok(!f.titans.ability(ion, a1, 'ord'), 'laser shot needs 500 energy');
  f.engine.stop();
}
{
  const { f, a1, b1, shooter: scorch, target } = duelPair('titan_scorch', 'titan_ion', 20);
  drive(a1, { yaw: -Math.PI / 2 });
  ok(f.titans.ability(scorch, a1, 'tac'), 'incendiary trap');
  const trap = scorch.tfAbility.deployables[0];
  ok(trap.kind === 'incendiary' && !trap.lit, 'trap placed, unlit');
  f.step(ticks(1));
  ok(!trap.lit, 'a trap stays unlit on its own');
  // Thermite onto the trap lights it.
  f.step(ticks(1), () => aimTitan(a1, scorch, trap.at));
  aimTitan(a1, scorch, trap.at, { fire: true });
  f.step(1);
  drive(a1, { yaw: a1.input.yaw, pitch: a1.input.pitch });
  f.step(ticks(1.5));
  ok(trap.lit, 'thermite ignites the trap');
  ok([...f.engine.projectiles.fire.active.values()].some(field => field.key === 'incendiaryTrap'
    && Math.abs((field.expiresAt - field.createdAt) / 1000 - 8) < 1e-6), 'incendiary trap: 8 s fire, kill key incendiaryTrap');
  void b1; void target;
  f.engine.stop();
}

/* ================================================================ core meter: charge, exclusion, cores */
{
  const { f, a1, shooter: ion, target } = duelPair('titan_ion', 'titan_ion', 14);
  ion.tfAbility.core = 0;
  aimTitan(a1, ion, centre(target), { fire: true });
  const t0 = f.engine.now;
  f.step(ticks(2), () => { refill(target); aimTitan(a1, ion, centre(target), { fire: true }); });
  const dealt = dealtBy(target, 'a1'), seconds = (f.engine.now - t0) / 1000;
  near(ion.tfAbility.core, dealt / 4000 + seconds / 180, 0.01, 'core += dealt / 4000 + dt / 180');
  drive(a1, { yaw: a1.input.yaw, pitch: a1.input.pitch });
  ion.tfAbility.core = 1;
  f.step(2);
  ok(f.titans.ability(ion, a1, 'core'), 'laser core');
  f.step(1);
  ok(f.events.some(e => e.kind === 'core_start' && e.vehicleId === ion.id), 'core_start event');
  ok(!f.vehicles.mounts.fire(ion, vehicleDef(ion).seats[0], a1, vehicleDef(ion).seats[0].mounts[0], 'splitter'), 'no splitter during laser core');
  const before = dealtBy(target, 'a1');
  f.step(ticks(4.2), () => { refill(target); aimTitan(a1, ion, centre(target)); });
  const beam = dealtBy(target, 'a1') - before;
  near(beam, 2400, 2400 * 0.06, 'laser core 4 s × 600 dps');
  ok(ion.tfAbility.core < 0.005, `core damage does not charge the meter (${ion.tfAbility.core.toFixed(4)})`);
  ok(f.events.some(e => e.kind === 'core_end' && e.vehicleId === ion.id), 'core_end event');
  f.engine.stop();
}
{
  const { f, a1, shooter: legion, target } = duelPair('titan_legion', 'titan_ion', 16);
  legion.tfAbility.core = 1;
  aimTitan(a1, legion, centre(target));
  f.step(2);
  ok(f.titans.ability(legion, a1, 'core'), 'smart core');
  // Aim 15° off: smart core still finds the hull, no spin-up needed.
  drive(a1, { yaw: a1.input.yaw + 0.26, pitch: a1.input.pitch, fire: true });
  const before = dealtBy(target, 'a1');
  f.step(ticks(1), () => refill(target));
  const s = dealtBy(target, 'a1') - before;
  ok(s > 0, `smart core auto-aims inside 40° (${s.toFixed(0)} in 1 s)`);
  f.engine.stop();
}
{
  const { f, a1, shooter: ronin } = duelPair('titan_ronin', 'titan_ion', 20);
  ronin.tfAbility.core = 1;
  drive(a1, { yaw: -Math.PI / 2 });
  ok(f.titans.ability(ronin, a1, 'core'), 'sword core');
  f.step(1);
  ok(ronin.tfMove.pipRefill && Math.abs(ronin.tfMove.damageTakenMul - 0.7) < 1e-9, 'sword core: pips refill, damageTakenMul 0.7');
  f.engine.stop();
}
{
  const { f, a1, shooter: scorch, target } = duelPair('titan_scorch', 'titan_ion', 14);
  scorch.tfAbility.core = 1;
  drive(a1, { yaw: -Math.PI / 2 });
  ok(f.titans.ability(scorch, a1, 'core'), 'flame core');
  f.step(ticks(2), () => refill(target));
  const flame = dealtBy(target, 'a1');
  ok(flame > 500 - 1e-6 && flame <= TITAN_ABILITIES.titan_scorch.core.perTarget + 1e-6, `flame core ≤ 900 per target (${flame.toFixed(0)})`);
  f.engine.stop();
}

/* ================================================================ electric smoke */
{
  const { f, a1, b1, shooter: v } = duelPair('titan_ion', 'titan_ion', 30);
  const rider = f.p('b2');
  if (rider.state !== 'alive') { rider.respawnAt = 0; f.step(ticks(5)); }
  ok(rider.state === 'alive', 'rider alive');
  place(rider, v.x, v.z, 0, 0, v.y + titanFrame(v).height + 0.05);
  f.step(ticks(0.5));
  eq(rider.rodeoVehicleId, v.id, 'rider on the ION');
  ok(f.titans.ability(v, a1, 'smoke'), 'electric smoke');
  eq(v.tfAbility.smoke, TITAN_COMMON_ABILITIES.smoke.charges - 1, 'one smoke charge used');
  ok(decodeTitanRow(f.row(v.id)) && v.tfAbility.smokeUntil > f.engine.now, 'smoke up');
  f.step(ticks(0.4));
  eq(rider.state, 'alive', 'smoke arms after 0.5 s');
  f.step(ticks(1.6));
  ok(rider.state !== 'alive' && lastKill(f, 'b2')?.w === 'electricSmoke', 'electric smoke kills the rider');
  void b1;
  f.engine.stop();
}

/* ================================================================ melee, doomed execution from the front */
{
  const f = arena();
  const [a1, b1] = ['a1', 'b1'].map(f.p);
  for (const id of ['a2', 'b2']) park(f, f.p(id));
  const ronin = landTitan(f, a1, 'titan_ronin', 60, 72, -Math.PI / 2);
  const ion = landTitan(f, b1, 'titan_ion', 60 + titanFrame('titan_ronin').hl + titanFrame('titan_ion').hl + 2, 72, Math.PI / 2);
  embark(f, a1, ronin);
  embark(f, b1, ion);
  drive(a1, { yaw: -Math.PI / 2 }); drive(b1, { yaw: Math.PI / 2 });
  ion.shield = 0;
  const hp = ion.hp;
  ok(f.titans.ability(ronin, a1, 'melee'), 'titan melee');
  near(hp - ion.hp, 200, 1e-6, 'melee 200');
  ok(!f.titans.ability(ronin, a1, 'melee'), 'melee 1.3 s cooldown');
  f.step(ticks(1.4));
  // Doomed, facing the ronin: an execution.
  f.vehicles.damage(ion.id, ion.hp + 1, a1, { cls: 'titan', point: centre(ion) });
  ok(ion.doomed && ion.hp > 0, 'the ION is doomed');
  ok(f.titans.ability(ronin, a1, 'melee'), 'melee on the doomed titan');
  ok(!(ion.hp > 0), 'executed from the front');
  f.step(1);
  ok(f.events.some(e => e.kind === 'titan_ability' && e.ability === 'execution'), 'execution event');
  f.engine.stop();
}
{
  const f = arena();
  const [a1, b1] = ['a1', 'b1'].map(f.p);
  for (const id of ['a2', 'b2']) park(f, f.p(id));
  const ronin = landTitan(f, a1, 'titan_ronin', 60, 72, -Math.PI / 2);
  // The ION faces away (+X): the ronin is behind it.
  const ion = landTitan(f, b1, 'titan_ion', 60 + titanFrame('titan_ronin').hl + titanFrame('titan_ion').hl + 2, 72, -Math.PI / 2);
  embark(f, a1, ronin);
  embark(f, b1, ion);
  drive(a1, { yaw: -Math.PI / 2 }); drive(b1, { yaw: -Math.PI / 2 });
  f.step(ticks(0.5));
  f.vehicles.damage(ion.id, ion.hp + ion.shield + 1, a1, { cls: 'titan', point: centre(ion) });
  ok(ion.doomed && ion.hp > 0, 'doomed (rear test)');
  const pool = ion.hp;
  ok(f.titans.ability(ronin, a1, 'melee'), 'melee from behind');
  ok(ion.hp > 0 && ion.hp < pool, 'no execution from behind: plain melee damage');
  f.engine.stop();
}

/* ================================================================ review fixes (2026-10-13) */
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const tfProjectiles = f => [...f.engine.projectiles.active.values()].filter(p => p.tf?.startsWith('titan:'));
// Titan shells and pellets never 'contact' an enemy pilot on foot away from their line of fire.
for (const type of ['titan_scorch', 'titan_ronin']) {
  const { f, a1, shooter, target } = duelPair(type);
  const bystander = f.p('b2');
  bystander.respawnAt = 0;
  f.step(ticks(5), () => refill(target));
  ok(bystander.state === 'alive', 'bystander respawned');
  place(bystander, 68, 58, 0);
  bystander.hp = 100;
  const start = dealtBy(target, 'a1');
  let bad = 0;
  f.step(ticks(4), () => {
    refill(target);
    if (type === 'titan_scorch') f.engine.projectiles.fire.clear();
    aimTitan(a1, shooter, centre(target), { fire: true });
    for (const p of tfProjectiles(f)) if (![p.x, p.y, p.z].every(Number.isFinite)) bad++;
  });
  ok(dealtBy(target, 'a1') - start > 0.6 * 4 * TITAN_WEAPON_DPS[PRIMARY[type]], `${type}: shells reach the titan with an enemy pilot on foot 14 m off the line (${(dealtBy(target, 'a1') - start).toFixed(0)})`);
  ok(bystander.state === 'alive' && bystander.hp === 100, `${type}: the off-line pilot takes nothing (hp ${bystander.hp})`);
  eq(bad, 0, `${type}: no titan projectile with a non-finite position`);
  f.engine.stop();
}
// Point blank: a muzzle inside the vortex sphere is still caught (guardEntry).
{
  const { f, a1, b1, shooter: ion, target: ronin } = duelPair('titan_ion', 'titan_ronin', 7);
  drive(a1, { yaw: -Math.PI / 2, hold: 2 });
  ok(f.titans.ability(ion, a1, 'def'), 'vortex at point blank');
  const guard = ion.tfAbility.guard, sphere = guardSphere(ion, guard);
  const muzzle = mountPose(ronin, 'driver', vehicleDef(ronin).seats[0].mounts[0]).origin;
  ok(dist3(muzzle, sphere) <= sphere[3], `the RONIN muzzle is inside the vortex sphere at 7 m (${dist3(muzzle, sphere).toFixed(2)} of ${sphere[3]})`);
  eq(guardRay(f.titans, 'bravo', sphere.slice(0, 3), [-1, 0, 0], 20, null)?.t, 0, 'from inside, toward the hull: met at once');
  eq(guardRay(f.titans, 'bravo', sphere.slice(0, 3), [1, 0, 0], 20, null), null, 'from inside, away from the hull: passes');
  const before = ion.hp + ion.shield;
  f.step(ticks(1.5), () => { drive(a1, { yaw: -Math.PI / 2, hold: 2 }); aimTitan(b1, ronin, centre(ion), { fire: true }); });
  ok(ronin.mounts[0].shots > 0 && guard.weight > 0, `point-blank pellets are caught (weight ${guard.weight})`);
  near(ion.hp + ion.shield, before, 1e-6, 'point blank: nothing reaches the ION hull');
  f.engine.stop();
}
// Sword Block reduces from the press on, and a block that timed out between ticks no longer reduces.
{
  const f = arena();
  const [a1] = ['a1'].map(f.p);
  for (const id of ['a2', 'b1', 'b2']) park(f, f.p(id));
  const ronin = landTitan(f, a1, 'titan_ronin', 60, 72, -Math.PI / 2);
  embark(f, a1, ronin);
  drive(a1, { yaw: -Math.PI / 2, hold: 2 });
  ok(f.titans.ability(ronin, a1, 'def'), 'sword block press');
  near(ronin.tfMove.damageTakenMul, 0.3, 1e-9, 'damageTakenMul 0.3 from the press, before the next tick');
  const front = [ronin.x + 10, ronin.y + 3, ronin.z], rear = [ronin.x - 10, ronin.y + 3, ronin.z];
  const landed = origin => guardTitanDamage(f.titans, ronin, 100, 'titan', null, { origin, point: centre(ronin) }) * ronin.tfMove.damageTakenMul;
  near(landed(rear), 100, 1e-9, 'tick of the press: a rear hit lands whole');
  near(landed(front), 30, 1e-9, 'tick of the press: a front hit lands at 30 %');
  if (hooked) {
    const total = () => ronin.hp + ronin.shield, before = total();
    f.vehicles.damage(ronin.id, 100, null, { cls: 'titan', origin: rear, point: [ronin.x - titanFrame(ronin).hl, ronin.y + 3, ronin.z], sourceTeam: 'bravo' });
    near(before - total(), 130, 1e-6, 'end to end, tick of the press: a rear hit ignores the block (rear zone 1.3)');
  }
  drive(a1, { yaw: -Math.PI / 2, hold: 0 });
  ronin.tfAbility.guard.until = f.titans.now - 1;   // timed out, tfMove still carries 0.3
  near(landed(front), 100, 1e-9, 'a block that timed out between ticks: a front hit lands whole');
  f.step(1);
  ok(!ronin.tfAbility.guard && ronin.tfMove.damageTakenMul === 1 && ronin.tfAbility.blockMul === 1, 'the next tick drops it');
  near(landed(rear), 100, 1e-9, 'no block: a rear hit lands whole');
  f.engine.stop();
}
// Thermal Shield and Gun Shield run their row seconds after a tap (release only ends Vortex and Sword Block).
for (const type of ['titan_scorch', 'titan_legion']) {
  const f = arena();
  const [a1] = ['a1'].map(f.p);
  for (const id of ['a2', 'b1', 'b2']) park(f, f.p(id));
  const v = landTitan(f, a1, type, 60, 72, -Math.PI / 2);
  embark(f, a1, v);
  const seconds = TITAN_ABILITIES[type].defensive.seconds;
  drive(a1, { yaw: -Math.PI / 2, hold: 2 });
  ok(f.titans.ability(v, a1, 'def'), `${type} defensive tap`);
  f.step(ticks(0.1));
  drive(a1, { yaw: -Math.PI / 2, hold: 0 });
  f.step(ticks(seconds - 0.4));
  ok(!!v.tfAbility.guard, `${type}: the guard is still up ${(seconds - 0.3).toFixed(1)} s after a 0.1 s tap`);
  f.step(ticks(0.6));
  ok(!v.tfAbility.guard, `${type}: the guard ends after ${seconds} s`);
  f.engine.stop();
}
// A Cluster Missile caught by the vortex counts at all its bursts; its fuse in flight lets every burst go.
{
  const { f, a1, b1, shooter: ion, target: ns } = duelPair('titan_ion', 'titan_northstar', 20);
  drive(a1, { yaw: -Math.PI / 2, hold: 2 });
  ok(f.titans.ability(ion, a1, 'def'), 'vortex for the cluster');
  const guard = ion.tfAbility.guard, before = ion.hp + ion.shield;
  f.step(ticks(0.3), () => { drive(a1, { yaw: -Math.PI / 2, hold: 2 }); aimTitan(b1, ns, centre(ion)); });
  ok(f.titans.ability(ns, b1, 'ord'), 'cluster into the vortex');
  f.step(ticks(1), () => { drive(a1, { yaw: -Math.PI / 2, hold: 2 }); aimTitan(b1, ns, centre(ion)); });
  const want = TITAN_ABILITIES.titan_northstar.ordnance.damage * TITAN_ABILITIES.titan_northstar.ordnance.bursts;
  ok(guard.caught.some(n => Math.abs(n - want) < 1e-6), `the vortex holds the cluster at ${want} (${guard.caught.join(', ')})`);
  near(ion.hp + ion.shield, before, 1e-6, 'the caught cluster never reaches the hull');
  f.engine.stop();
}
{
  const { f, b1, shooter: ion, target: ns } = duelPair('titan_ion', 'titan_northstar', 20);
  let blasts = 0;
  const explosion = f.vehicles.explosion.bind(f.vehicles);
  f.vehicles.explosion = (...args) => { blasts++; return explosion(...args); };
  const c = centre(ion);
  const p = f.engine.projectiles.titanfall.launch('titan:cluster', { owner: b1, origin: [c[0], c[1] + 6, c[2]], dir: [0, 1, 0], vehicleId: ns.id, titanId: ns.id },
    f.vehicles.projectileContext());
  ok(!!p, 'a cluster in flight');
  p.explodeAt = f.engine.now;
  f.step(1);
  eq(blasts, TITAN_ABILITIES.titan_northstar.ordnance.bursts, 'a cluster at the end of its fuse in flight lets all its bursts go');
  ok(!f.engine.projectiles.active.has(p.id), 'and is gone');
  f.engine.stop();
}
// SCORCH's thermite patch charges its core meter (fire damage through MolotovFireSystem).
{
  const { f, a1, shooter: scorch, target } = duelPair('titan_scorch', 'titan_ion', 16);
  target.shield = 0;
  f.step(ticks(1), () => aimTitan(a1, scorch, centre(target)));
  aimTitan(a1, scorch, centre(target), { fire: true });
  f.step(1);
  drive(a1, { yaw: a1.input.yaw, pitch: a1.input.pitch });
  f.step(ticks(0.6));
  ok([...f.engine.projectiles.fire.active.values()].some(field => field.key === 'thermite'), 'thermite patch lit at the titan');
  scorch.tfAbility.core = 0;
  const d0 = dealtBy(target, 'a1'), t0 = f.engine.now;
  f.step(ticks(2.5));
  const fire = dealtBy(target, 'a1') - d0, seconds = (f.engine.now - t0) / 1000;
  ok(fire > 40, `the patch burns the titan (${fire.toFixed(1)})`);
  near(scorch.tfAbility.core, fire / 4000 + seconds / 180, 0.002, 'fire damage charges the core: dealt / 4000 + dt / 180');
  f.engine.stop();
}
// LEGION: the stock seat weapon select goes through the Mode Switch (lockout, tactical cooldown).
{
  const { f, a1, shooter: legion } = duelPair('titan_legion', 'titan_ion', 16);
  drive(a1, { yaw: -Math.PI / 2 });
  f.step(2);
  ok(f.vehicles.action(a1, { type: 'weapon', index: 0 }), 'selecting the current weapon is a no-op');
  eq(legion.tfAbility.readyAt.tactical, 0, 'a no-op select costs nothing');
  ok(f.vehicles.action(a1, { type: 'weapon', index: 1 }), 'the seat select switches mode');
  eq(f.vehicles.mounts.selected(legion, 'driver').weapon, 'predatorLong', 'select → predatorLong');
  ok(legion.mounts[0].cooldown >= ABILITY_TUNING.modeSwitchSeconds - 1e-9, `the 0.6 s lockout applies (${legion.mounts[0].cooldown.toFixed(2)})`);
  ok(legion.tfAbility.readyAt.tactical > f.titans.now, 'the tactical cooldown starts');
  ok(!f.vehicles.action(a1, { type: 'weapon', index: 0 }), 'no free swap back during the cooldown');
  eq(f.vehicles.mounts.selected(legion, 'driver').weapon, 'predatorLong', 'still predatorLong');
  f.engine.stop();
}

/* ================================================================ guardRay geometry */
{
  const f = arena();
  const [a1] = ['a1'].map(f.p);
  for (const id of ['a2', 'b1', 'b2']) park(f, f.p(id));
  const ion = landTitan(f, a1, 'titan_ion', 60, 72, -Math.PI / 2);
  ion.tfAbility.guard = { kind: 'vortex', weight: 0, caught: [], until: Infinity, startedAt: 0 };
  const from = [ion.x + 30, ion.y + titanFrame(ion).eye, ion.z];
  const hit = guardRay(f.titans, 'bravo', from, [-1, 0, 0], 60, null);
  ok(hit && hit.v === ion, 'a ray toward the vortex meets it');
  ok(!guardRay(f.titans, 'alpha', from, [-1, 0, 0], 60, null), 'friendly rays pass');
  ok(!guardRay(f.titans, 'bravo', [ion.x - 30, from[1], ion.z], [1, 0, 0], 20, null), 'out of reach');
  f.engine.stop();
}

/* ================================================================ duels: every titan pair, primaries only */
{
  const types = TITAN_TYPE_IDS;
  const table = [];
  for (let i = 0; i < types.length; i++) for (let j = i; j < types.length; j++) {
    const f = arena();
    const [a1, b1] = ['a1', 'b1'].map(f.p);
    for (const id of ['a2', 'b2']) park(f, f.p(id));
    const A = landTitan(f, a1, types[i], 60, 72, -Math.PI / 2);
    const B = landTitan(f, b1, types[j], 85, 72, Math.PI / 2);
    embark(f, a1, A); embark(f, b1, B);
    const t0 = f.engine.now;
    let doneA = null, doneB = null;
    const pilotTick = (p, me, them) => {
      const state = me.mounts[0], release = VEHICLE_WEAPONS[state.weapon].chargeSeconds && state.charge >= 1;
      aimTitan(p, me, centre(them), { fire: !release });
    };
    for (let n = 0; n < ticks(90) && doneA === null && doneB === null; n++) {
      pilotTick(a1, A, B); pilotTick(b1, B, A);
      f.engine.step(TICK_MS);
      if (A.doomed || !(A.hp > 0)) doneA = (f.engine.now - t0) / 1000;
      if (B.doomed || !(B.hp > 0)) doneB = (f.engine.now - t0) / 1000;
    }
    const winner = doneA === null && doneB === null ? 'none' : doneB !== null && (doneA === null || doneB <= doneA) ? types[i] : types[j];
    const ttk = doneA ?? doneB;
    ok(ttk !== null && ttk >= 6 && ttk <= 40, `${types[i]} vs ${types[j]}: a titan dooms in 6–40 s (${ttk?.toFixed(1)})`);
    table.push(`${types[i].replace('titan_', '').padEnd(9)} vs ${types[j].replace('titan_', '').padEnd(9)} TTK ${ttk?.toFixed(1).padStart(5)} s, ${winner === 'none' ? 'no result' : `${winner.replace('titan_', '')} wins`}`
      + ` (left ${Math.round(A.hp + A.shield)} / ${Math.round(B.hp + B.shield)})`);
    f.engine.stop();
  }
  console.log('Titan duels (primaries only, piloted, 25 m, full hp + drop shield):');
  for (const line of table) console.log(`  ${line}`);
}

/* ================================================================ crosshair convergence (playability pass) */
{
  // Sight ray: a plausible chase camera is used, an implausible one falls back to the cockpit eye.
  const { f, a1, shooter, target } = duelPair('titan_ion');
  const eye = titanCockpitEye(shooter), aim = aimAngles(eye, centre(target));
  const cam = [shooter.x - 7, shooter.y + 7.5, shooter.z + 1.5], camAim = aimAngles(cam, centre(target));
  const chase = titanSightRay(shooter, { yaw: aim.yaw, pitch: aim.pitch, titanSight: [...cam, camAim.yaw, camAim.pitch] });
  eq(chase.origin, cam, 'a chase sight within reach is the sight origin');
  ok(chase.skip > 0, 'a chase sight skips the stretch behind the cockpit eye');
  const far = titanSightRay(shooter, { yaw: aim.yaw, pitch: aim.pitch, titanSight: [cam[0] - 40, cam[1], cam[2], camAim.yaw, camAim.pitch] });
  eq(far.origin, eye, 'a sight beyond maxOffset falls back to the cockpit eye');
  const askew = titanSightRay(shooter, { yaw: aim.yaw, pitch: aim.pitch, titanSight: [...cam, camAim.yaw + 1.5, camAim.pitch] });
  eq(askew.origin, eye, 'a sight beyond maxAngle of the input aim falls back to the cockpit eye');
  // The mount converges on the crosshair point: the muzzle ray from the pivot passes the target chest.
  f.step(ticks(1), () => aimTitan(a1, shooter, centre(target)));
  const def = vehicleDef(shooter).seats[0].mounts[0], pose = mountPose(shooter, 'driver', def);
  const want = aimAngles(pose.pivot, centre(target));
  ok(Math.abs(want.yaw - aim.yaw) > 0.03, `pivot and cockpit eye see the chest at different yaws (${(want.yaw - aim.yaw).toFixed(3)} rad)`);
  near(shooter.mounts[0].yaw, want.yaw, 0.02, 'mount yaw converges on the crosshair point (not parallel to the eye)');
  // Chase camera sight: the shot still lands on the target.
  const before = dealtBy(target, 'a1');
  f.step(ticks(1.5), () => { refill(target); drive(a1, { yaw: aim.yaw, pitch: aim.pitch, fire: true }); a1.input.titanSight = [...cam, camAim.yaw, camAim.pitch]; });
  ok(dealtBy(target, 'a1') > before, 'a chase-camera sight hits the titan under the crosshair');
  f.engine.stop();
}
{
  // Nose against a wall: the muzzle sits inside the voxels, the gun still fires (from the pivot).
  const { f, a1, shooter } = duelPair('titan_ion');
  park(f, f.p('b1'));
  const def = vehicleDef(shooter).seats[0].mounts[0];
  f.step(ticks(0.5), () => drive(a1, { yaw: shooter.yaw, pitch: 0 }));
  const pose = mountPose(shooter, 'driver', def);
  const mx = Math.floor(pose.origin[0]), px = Math.floor(pose.pivot[0]);
  ok(mx > px, 'the primary muzzle reaches past its pivot column');
  setBlocks(f.engine, mx, mx + 2, G, G + 9, Math.floor(shooter.z) - 4, Math.floor(shooter.z) + 5, STONE);
  const shots = shooter.mounts[0].shots;
  f.step(ticks(1), () => drive(a1, { yaw: shooter.yaw, pitch: 0, fire: true }));
  ok(shooter.mounts[0].shots > shots, `the primary fires with its muzzle in a wall (${shooter.mounts[0].shots - shots} shots)`);
  f.engine.stop();
}
{
  // Playtest: a block ~1.5 m in front of the cockpit under the crosshair slewed the mount to its pitch
  // stop (shots ~39° up). Closer than TITAN_SIGHT.minConverge the mount converges far along the sight.
  const { f, a1, shooter } = duelPair('titan_ion');
  park(f, f.p('b1'));
  f.step(ticks(0.5), () => drive(a1, { yaw: shooter.yaw, pitch: -0.06 }));
  const eye = titanCockpitEye(shooter), fx = -Math.sin(shooter.yaw), fz = -Math.cos(shooter.yaw);
  const bx = Math.floor(eye[0] + fx * 1.5), bz = Math.floor(eye[2] + fz * 1.5), by = Math.floor(eye[1]);
  setBlocks(f.engine, bx, bx + 1, by - 1, by + 2, bz, bz + 1, STONE);
  f.step(ticks(1), () => drive(a1, { yaw: shooter.yaw, pitch: -0.06 }));
  ok(Math.abs(shooter.mounts[0].pitch - (-0.06)) < 0.2, `a block right in front of the cockpit leaves the mount near the sight pitch (${shooter.mounts[0].pitch.toFixed(3)})`);
  f.engine.stop();
}
for (const [type, slot] of [['titan_ion', 'tac'], ['titan_scorch', 'tac'], ['titan_northstar', 'def']]) {
  // A wall between the hull and the placement point: the deployable lands on the near side (never through it).
  const { f, a1, shooter } = duelPair(type, 'titan_ion', 40);
  setBlocks(f.engine, 66, 68, G, G + 12, 56, 89, STONE);
  f.step(2, () => drive(a1, { yaw: -Math.PI / 2 }));
  ok(f.titans.ability(shooter, a1, slot), `${type} ${slot} placed with a wall ahead`);
  const item = shooter.tfAbility.deployables.at(-1);
  const points = item?.mines ?? (item?.at ? [item.at] : []);
  ok(points.length > 0 && points.every(p => p[0] < 66), `${type} ${item?.kind} stays in front of the wall (${points.map(p => p[0].toFixed(1))})`);
  f.engine.stop();
}

for (const note of notes) console.log(`  ${note}`);
console.log(`Titanfall titan weapons: ${checks} checks passed (weapon table and sustained DPS ±20 % analytic and through the mount path, thermite patch, infantry damage, 6-tuple rows with railgun charge and Predator spin, auto-titan charge/spin, vortex cap and throw-back, thermal / gun shield / sword block, firewall line, arc wave, hover, flight core, phase blink at voxels, Mode Switch, power shot, tether, cluster, tripwire, laser shot, incendiary trap, core meter and exclusion, laser / smart / sword / flame core, electric smoke, melee and execution, duels${hooked ? ', guard hook end to end' : '; guard hook pending'}).`);
