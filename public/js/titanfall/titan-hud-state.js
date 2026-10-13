/**
 * Titanfall HUD read model (docs/titanfall.md §8.1, WP6). Pure: no DOM, no
 * clocks, no module state. Every displayed number comes from authoritative
 * state: the snapshot (`match.titanfall`, player and vehicle rows), the own
 * player row's `tf` and the self-only `tfs` frame (R9). The only local inputs
 * are presentation clocks the caller owns (rodeo rip start, eject tap count).
 *
 *   titanHudModel({ snapshot, selfRow, tfs, now, keys, local }) -> model
 *
 * `snapshot`: the newest tick ({ match, players, vehicles, serverNow }).
 * `selfRow`: the local player's row (with `tf`). `tfs`: the decoded `tfs`
 * frame (decodeTitanfallSelf) or null. `now`: server ms. `keys`: action ->
 * key label (bindingLabel) for prompts. `local`: { ripStartedAt, ejectTaps,
 * interactHeldMs, loadoutOpen, touch, equippedTactical (equippedTacticalLatch) }. `local.touch` (the input mode) only picks
 * prompt verbs (TAP / HOLD instead of a key chip).
 */
import { TITAN_LABELS, TITAN_CHASSIS, TITAN_ABILITIES, TITAN_MV, TITAN_PHASE, TITAN_TYPE_IDS, TITAN_PILOT_PRIMARIES,
  TITAN_PILOT_AT, TITAN_PILOT_TACTICALS, TITAN_WEAPON_META, decodeTitanfallPlayer, decodeTitanRow, isTitanType,
  titanWeaponRole, TITANFALL_DIGIT_ROLES, unpackTitanLoadout, TITANFALL_DEPLOY_TIMEOUT_MS } from '../../../shared/titan-contract.js';
import { MODE_RULES } from '../../../shared/modes.js';
import { TITAN_RULES, titanFrame, batteryInsertGap, rodeoContact, rodeoContactMounts, rodeoArcMounts } from '../../../shared/vehicle-handling/titan.js';
import { PHYSICS } from '../../../shared/player-movement.js';
import { vehicleMaxHp, vehicleLocalPoint, VEHICLE_WEAPONS } from '../../../shared/vehicle-defs.js';
import { seatWeaponList } from '../../../shared/conquest-contract.js';
import { PILOT_RULES } from '../../../shared/pilot-movement.js';
import { WEAPONS, WEAPON_IDS } from '../../../shared/combatmath.js';

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp01 = value => Math.max(0, Math.min(1, finite(value)));
/** Progress percent, floored: a gauge reads 100 only once the authoritative fraction is full. */
const pct = value => Math.floor(clamp01(value) * 100 + 1e-9);

/** Team flavour names (docs/titanfall.md §1): colours stay the existing team schemes. */
export const TITANFALL_TEAM_LABELS = Object.freeze({ alpha: 'MILITIA', bravo: 'IMC' });
/** Pilot kit labels shown by the HUD and the loadout screen. */
export const TITANFALL_ITEM_LABELS = Object.freeze({
  rifle: 'RIFLE', smg: 'SMG', shotgun: 'SHOTGUN', lmg: 'LMG', kraber: 'KRABER',
  chargerifle: 'CHARGE RIFLE', archer: 'ARCHER', thunderbolt: 'THUNDERBOLT', mgl: 'MGL',
  grapple: 'GRAPPLE', stim: 'STIM', cloak: 'CLOAK', revolver: 'REVOLVER', knife: 'KNIFE',
});
export const TITANFALL_TACTICAL_HINTS = Object.freeze({
  grapple: 'GRAPPLE PULLS YOU TO WALLS, LEDGES AND TITANS. 2 CHARGES.',
  stim: 'STIM BRIEFLY INCREASES MOVEMENT SPEED AND HEALING.',
  cloak: 'CLOAK: 5 S NEAR-INVISIBLE. BOTS SPOT YOU WITHIN 12 M OR WHEN YOU FIRE.',
});
/** Kit strip frame names (the README correction: data-driven, ION is a balanced frame). */
export const TITAN_FRAME_LABELS = Object.freeze({ atlas: 'ATLAS · BALANCED FRAME', ogre: 'OGRE · HEAVY FRAME', stryder: 'STRYDER · LIGHT FRAME' });
/** Ability slot order on the HUD and the intent verb each slot sends (§3.7). */
export const TITAN_HUD_SLOTS = Object.freeze([
  Object.freeze({ slot: 'defensive', verb: 'def', action: 'titanDefensive', ab: 'def' }),
  Object.freeze({ slot: 'tactical', verb: 'tac', action: 'titanTactical', ab: 'tac' }),
  Object.freeze({ slot: 'ordnance', verb: 'ord', action: 'titanOrdnance', ab: 'ord' }),
]);
export const LOCK_LABELS = Object.freeze({ 1: 'LOCKING', 2: 'LOCKED', 3: 'MISSILE INBOUND' });
/** The Attrition score limit (the score bar's fallback until the match row carries its own). */
export const TITANFALL_SCORE_LIMIT = MODE_RULES.titanfall?.scoreLimit ?? 500;

/**
 * Display name of a pilot kit item: weapons use their def name (the stock ammo card shows the same),
 * tacticals their TITANFALL_ITEM_LABELS entry.
 */
export function itemLabel(id) {
  const name = Object.hasOwn(WEAPONS, id) && WEAPON_IDS.includes(id) ? WEAPONS[id]?.name : null;
  return typeof name === 'string' && name ? name.toUpperCase() : TITANFALL_ITEM_LABELS[id] ?? String(id).toUpperCase();
}

/**
 * Pilot primary stats (0..1 across the five primaries) for the loadout's pilot column:
 * damage per shot (pellets counted), rate of fire and magazine, from WEAPONS.
 */
export function primaryStats(id) {
  const def = WEAPONS[id];
  if (!def) return null;
  const list = TITAN_PILOT_PRIMARIES.map(w => WEAPONS[w]).filter(Boolean);
  // `damage` is [close, far, head] or a number; pellets multiply a shotgun's close hit.
  const damage = w => finite(Array.isArray(w.damage) ? w.damage[0] : w.damage) * Math.max(1, finite(w.pellets, 1));
  const rate = w => finite(w.rpm);
  const mag = w => finite(w.magSize);
  const norm = (key, w) => {
    const values = list.map(key), lo = Math.min(...values), hi = Math.max(...values);
    return 0.2 + 0.8 * (hi > lo ? (key(w) - lo) / (hi - lo) : 1);
  };
  return { damage: norm(damage, def), rate: norm(rate, def), mag: norm(mag, def), magSize: mag(def) };
}

/** Kit stats (0..1) for the loadout strip, from the frame table (§5.1). */
export function titanKitStats(type) {
  const frames = Object.values(TITAN_RULES.frames);
  const f = titanFrame(type);
  if (!f) return null;
  const range = key => [Math.min(...frames.map(x => key(x))), Math.max(...frames.map(x => key(x)))];
  const norm = (key, value) => { const [lo, hi] = range(key); return 0.25 + 0.75 * (hi > lo ? (value - lo) / (hi - lo) : 1); };
  return { health: norm(x => x.hp, f.hp), speed: norm(x => x.sprint, f.sprint), dash: norm(x => x.pips * x.dash.speed, f.pips * f.dash.speed),
    hp: f.hp, pips: f.pips };
}

/** One titan card + kit strip for the loadout screen. */
export function titanCard(type) {
  if (!isTitanType(type)) return null;
  const chassis = TITAN_CHASSIS[type];
  const weapon = seatWeaponList(type, 'driver')[0]?.weapon;
  const abilities = TITAN_ABILITIES[type] ?? {};
  return {
    type, label: TITAN_LABELS[type], chassis: chassis.toUpperCase(), frame: TITAN_FRAME_LABELS[chassis] ?? chassis.toUpperCase(),
    kit: [TITAN_WEAPON_META[weapon]?.label ?? String(weapon).toUpperCase(),
      ...['defensive', 'tactical', 'ordnance', 'core'].map(slot => abilities[slot]?.label ?? '')],
    stats: titanKitStats(type),
  };
}

/** The loadout screen model for a packed or unpacked loadout. */
export function loadoutModel(loadout, { team = 'alpha', dead = false, respawnIn = null, autoDeployIn = null } = {}) {
  const sel = typeof loadout === 'number' ? unpackTitanLoadout(loadout) : unpackTitanLoadout(packed(loadout));
  const item = id => ({ id, label: itemLabel(id) });
  const mark = (list, chosen) => list.map(id => ({ ...item(id), selected: id === chosen }));
  return {
    // Alive, a pick only reaches the kit at the next respawn (and the titan at the next call).
    title: 'LOADOUT', subtitle: `${TITANFALL_TEAM_LABELS[team] ?? 'PILOT'} · ${dead ? 'ATTRITION' : 'APPLIES NEXT DEPLOY'}`,
    primary: mark(TITAN_PILOT_PRIMARIES, sel.primary), at: mark(TITAN_PILOT_AT, sel.at), tactical: mark(TITAN_PILOT_TACTICALS, sel.tactical),
    tacticalHint: TITANFALL_TACTICAL_HINTS[sel.tactical] ?? '',
    primaryName: itemLabel(sel.primary), primaryStats: primaryStats(sel.primary),
    titans: TITAN_TYPE_IDS.map(type => ({ ...titanCard(type), selected: type === sel.titan })),
    kit: titanCard(sel.titan), selection: sel,
    // The respawn chip counts down to 0 and then hands over to the server's idle fallback
    // (§3.4: deployed TITANFALL_DEPLOY_TIMEOUT_MS after the respawn time without DEPLOY).
    respawn: dead && Number.isFinite(respawnIn) && respawnIn > 0 ? respawnIn : null,
    autoDeploy: dead && !(respawnIn > 0) && Number.isFinite(autoDeployIn) ? Math.max(0, Math.ceil(autoDeployIn)) : null,
    deployLabel: dead ? (Number.isFinite(respawnIn) && respawnIn > 0 ? `DEPLOY · ${respawnIn.toFixed(1)}` : 'DEPLOY') : 'READY',
  };
}
function packed(loadout) {
  const s = loadout && typeof loadout === 'object' ? loadout : {};
  const idx = (list, v) => Math.max(0, list.indexOf(v));
  return idx(TITAN_PILOT_PRIMARIES, s.primary) | idx(TITAN_PILOT_AT, s.at) << 4 | idx(TITAN_PILOT_TACTICALS, s.tactical) << 8 | idx(TITAN_TYPE_IDS, s.titan) << 12;
}

/**
 * Titanfall kit digit (§6.2): the owned weapon slot key `index` (0 = key 1)
 * raises, by `titanWeaponRole` (1 primary, 2 revolver, 3 AT, 4 knife), or null.
 */
export function titanfallDigitWeapon(owned, index) {
  const role = Number.isInteger(index) ? TITANFALL_DIGIT_ROLES[index] : undefined;
  if (!role || !Array.isArray(owned)) return null;
  return owned.find(id => Object.hasOwn(WEAPONS, id) && WEAPON_IDS.includes(id) && titanWeaponRole(id) === role) ?? null;
}

/** mm:ss of a non-negative second count. */
export function formatClock(seconds) {
  const s = Math.max(0, Math.ceil(finite(seconds)));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** The attrition score bar from `match.titanfall` (own team left). */
export function scoreBar(match, selfTeam, now) {
  const tf = match?.titanfall;
  if (!tf) return null;
  const own = selfTeam === 'bravo' ? 'bravo' : 'alpha', enemy = own === 'alpha' ? 'bravo' : 'alpha';
  const sc = Array.isArray(tf.sc) ? tf.sc : [0, 0];
  const score = { alpha: finite(sc[0]), bravo: finite(sc[1]) };
  const limit = Math.max(1, finite(tf.scoreLimit, TITANFALL_SCORE_LIMIT));
  const remaining = Number.isFinite(tf.endsAt) && Number.isFinite(now) ? Math.max(0, (tf.endsAt - now) / 1000) : null;
  return {
    own: { team: own, label: TITANFALL_TEAM_LABELS[own], score: score[own], frac: clamp01(score[own] / limit) },
    enemy: { team: enemy, label: TITANFALL_TEAM_LABELS[enemy], score: score[enemy], frac: clamp01(score[enemy] / limit) },
    limit, clock: remaining == null ? '--:--' : formatClock(remaining), urgent: remaining != null && remaining <= 60,
  };
}

/** Bay state from `match.titanfall.bay` = [alphaTitans, bravoTitans, cap]. */
export function bayFull(match, team) {
  const bay = match?.titanfall?.bay;
  if (!Array.isArray(bay) || !(bay[2] > 0)) return false;
  return finite(team === 'bravo' ? bay[1] : bay[0]) >= bay[2];
}

/** World back anchor of a titan row (rodeo reach, §5.2), or null. */
export function titanBackAnchor(row) {
  const f = titanFrame(row);
  if (!f || ![row?.x, row?.y, row?.z].every(Number.isFinite)) return null;
  return vehicleLocalPoint({ x: row.x, y: row.y, z: row.z, yaw: finite(row.yaw) }, 0, f.backY, f.hl + 0.3);
}
/** Chest (feet + 1.2 m) to back-anchor distance of a player row. */
export function rodeoDistance(self, row) {
  const anchor = titanBackAnchor(row);
  if (!anchor || ![self?.x, self?.y, self?.z].every(Number.isFinite)) return Infinity;
  return Math.hypot(self.x - anchor[0], self.y + 1.2 - anchor[1], self.z - anchor[2]);
}
/** The server's battery insert reach (rodeo.js insertDistance): the ground right behind a friendly hull counts. */
export function insertDistance(self, row) {
  const anchor = titanBackAnchor(row);
  if (!anchor || ![self?.x, self?.y, self?.z].every(Number.isFinite)) return Infinity;
  return batteryInsertGap(self.x - anchor[0], self.y + 1.2 - anchor[1], self.z - anchor[2]);
}

const liveTitan = row => !!row && isTitanType(row.type) && row.hp > 0 && !row.wreck && decodeTitanRow(row)?.phase !== TITAN_PHASE.dropping;

/**
 * How a pilot body reaches an enemy titan row for a rodeo (rodeo.js contact rule):
 * 'contact' when the body is in contact with the upper hull now (airborne the
 * server grabs it, on foot a jump or T does), 'jump' when a jump from here (on
 * foot), the arc it flies or a double jump (airborne, `jumpsLeft` > 0) carries it
 * into contact, else null. body = feet { x, y, z, vx, vy, vz, grounded, jumpsLeft };
 * hullVel = [vx, vz] of the titan.
 */
export function rodeoApproach(body, row, hullVel = null) {
  if (!body || !row) return null;
  if (rodeoContactMounts(rodeoContact(body, row))) return 'contact';
  const vel = [finite(body.vx), finite(body.vz)];
  if (body.grounded !== false) return rodeoArcMounts(body, vel, row, hullVel, PHYSICS.jump) ? 'jump' : null;
  if (rodeoArcMounts(body, vel, row, hullVel, finite(body.vy), TITAN_RULES, 1.2, -4)) return 'jump';
  return finite(body.jumpsLeft, 0) > 0 && rodeoArcMounts(body, vel, row, hullVel, PILOT_RULES.doubleJumpVy, TITAN_RULES, 1.2, -4) ? 'jump' : null;
}

/**
 * The rodeo / battery context prompt of a pilot on foot: mount an enemy titan's
 * back, insert a carried battery into a friendly one, or the rider's own state.
 * Returns { kind, vehicleId, label, progress } or null.
 */
export function rodeoPrompt({ self, tf, vehicles = [], now = 0, local = {}, keys = {} }) {
  if (!self || self.state !== 'alive' || !tf) return null;
  const key = keys.interact ?? 'T';
  const reach = TITAN_RULES.rodeo.reach;
  if (tf.rodeoVehicleId) {
    const row = vehicles.find(v => v?.id === tf.rodeoVehicleId) || null;
    const titan = decodeTitanRow(row);
    const ripAt = finite(local.ripStartedAt, NaN);
    const ripMs = TITAN_RULES.rodeo.ripMs;
    // The server neither starts nor completes a rip on a doomed hull (rodeo.js): no RIP prompt or progress there.
    if (titan?.doomed && !tf.battery) return { kind: 'riding', vehicleId: tf.rodeoVehicleId, label: 'TITAN DOOMED', hold: null, key: keys.jump ?? 'SPACE', sub: 'JUMP OFF', progress: null };
    if (Number.isFinite(ripAt) && now - ripAt < ripMs + 400 && !tf.battery) {
      return { kind: 'ripping', vehicleId: tf.rodeoVehicleId, label: 'RIPPING BATTERY', hold: key, progress: clamp01((now - ripAt) / ripMs) };
    }
    if (tf.battery || titan?.batteryOut) return { kind: 'riding', vehicleId: tf.rodeoVehicleId, label: 'SHOOT THE HATCH', hold: null, key: keys.jump ?? 'SPACE', sub: 'JUMP OFF', progress: null };
    return { kind: 'rip', vehicleId: tf.rodeoVehicleId, label: 'RIP BATTERY', hold: null, key, progress: null };
  }
  if (self.vehicleId) return null;
  // Rodeo: an enemy titan without a rider that a jump from here (or the body's arc) carries the pilot onto.
  // The prompt names the jump; in contact (inReach) T and the touch RODEO chip mount as well.
  const body = local.body && [local.body.x, local.body.y, local.body.z].every(Number.isFinite) ? local.body
    : { x: self.x, y: self.y, z: self.z, vx: 0, vy: 0, vz: 0, grounded: true, jumpsLeft: 0 };
  let mount = null;
  for (const row of vehicles) {
    if (!liveTitan(row) || !(row.team && self.team && row.team !== self.team) || decodeTitanRow(row)?.rider) continue;
    if (!(Math.abs(row.x - body.x) < 14 && Math.abs(row.z - body.z) < 14)) continue;
    const how = rodeoApproach(body, row, local.titanVel?.[row.id] ?? null);
    if (how && (!mount || (how === 'contact' && mount.how !== 'contact'))) mount = { row, how };
  }
  if (mount) return { kind: 'mount', vehicleId: mount.row.id, label: 'RODEO', key: keys.jump ?? 'SPACE', progress: null, inReach: mount.how === 'contact' };
  let best = null, bestD = reach + 0.6;
  for (const row of vehicles) {
    if (!tf.battery || !liveTitan(row) || !(row.team && row.team === self.team)) continue;
    const titan = decodeTitanRow(row);
    if (titan?.doomed) continue;
    const d = insertDistance(self, row);
    if (d <= bestD) { best = { row, titan }; bestD = d; }
  }
  if (!best) return null;
  const full = finite(best.titan?.shield) >= TITAN_RULES.shieldMaxFrac * vehicleMaxHp(best.row) - 1;
  // The server inserts only within reach of the back anchor: in the display slack the prompt says so and claims nothing.
  const inReach = bestD <= reach;
  return { kind: 'insert', vehicleId: best.row.id, label: full ? 'SHIELD FULL' : inReach ? 'INSERT BATTERY' : 'MOVE CLOSER', key, progress: null, refused: full, inReach };
}

/** The selected mount weapon readout of a titan row: { key, label, ammo, magazine, frac, reload, charge, heat }. */
export function titanWeaponModel(row) {
  if (!row || !isTitanType(row.type)) return null;
  const list = seatWeaponList(row.type, 'driver');
  if (!list.length) return null;
  const index = Math.max(0, Math.min(list.length - 1, finite(row.sel?.driver, 0) | 0));
  const key = list[index].weapon;
  const weapon = VEHICLE_WEAPONS[key] ?? {};
  const mount = Array.isArray(row.mounts) ? row.mounts[0] : null;
  const ammoRaw = Array.isArray(mount) ? mount[2] : null;
  const magazine = Number.isFinite(weapon.magazine) ? weapon.magazine : null;
  const ammo = Number.isFinite(ammoRaw) ? ammoRaw : null;
  return {
    key, label: TITAN_WEAPON_META[key]?.label ?? key.toUpperCase(),
    ammo, magazine, ammoText: ammo == null || magazine == null ? '∞' : String(Math.max(0, ammo)),
    frac: ammo != null && magazine ? clamp01(ammo / magazine) : 1,
    heat: Array.isArray(mount) ? clamp01(finite(mount[3]) / 100) : 0,
    reload: Array.isArray(mount) ? clamp01(finite(mount[4]) / 100) : 0,
    charge: Array.isArray(mount) && mount.length >= 6 ? clamp01(finite(mount[5]) / 100) : 0,
  };
}

/** The titan cockpit model for a seated pilot's own titan row. */
export function titanModel(row, { now = 0, keys = {}, local = {} } = {}) {
  const t = decodeTitanRow(row);
  if (!t) return null;
  const type = row.type, f = titanFrame(type);
  const maxHp = Math.max(1, vehicleMaxHp(row) || f?.hp || 1);
  const shieldMax = TITAN_RULES.shieldMaxFrac * maxHp;
  const hp = Math.max(0, finite(row.hp));
  const doomed = t.doomed;
  const doomFrac = doomed ? clamp01(t.doomLeft / TITAN_RULES.doomSeconds) : 0;
  const abilities = TITAN_ABILITIES[type] ?? {};
  const pipsMax = f?.pips ?? 2;
  const slots = TITAN_HUD_SLOTS.map(({ slot, action, ab }) => {
    const ready = clamp01(t[ab]);
    const active = slot === 'defensive' && t.defensiveUp;
    return { slot, key: keys[action] ?? '', label: abilities[slot]?.label ?? slot.toUpperCase(), ready, readyPct: pct(ready),
      state: active ? 'active' : ready >= 1 ? 'ready' : 'cooling' };
  });
  const core = clamp01(t.core);
  return {
    type, label: TITAN_LABELS[type] ?? type, chassis: TITAN_CHASSIS[type],
    hp, maxHp, hpFrac: doomed ? 0 : clamp01(hp / maxHp),
    shield: t.shield, shieldMax, shieldFrac: clamp01(t.shield / Math.max(1, maxHp)),
    healthText: doomed ? `DOOMED · ${Math.ceil(hp)}` : `${Math.ceil(hp)} / ${maxHp}`,
    doomed, doomLeft: t.doomLeft, doomFrac,
    eject: doomed ? { key: keys.titanEject ?? 'X', taps: Math.max(0, Math.min(3, local.ejectTaps | 0)), label: 'EJECT' } : null,
    dash: { pips: Math.max(0, Math.min(pipsMax, t.dash)), max: pipsMax, key: keys.titanDash ?? 'SPACE',
      cells: Array.from({ length: pipsMax }, (_, i) => clamp01(t.dash - i)) },
    abilities: slots,
    core: { frac: core, pct: pct(core), ready: core >= 1 && !t.coreActive, active: t.coreActive, key: keys.titanCore ?? 'V',
      label: abilities.core?.label ?? 'CORE' },
    smoke: { charges: t.smokeCharges, max: TITAN_RULES.smoke.charges, key: keys.titanSmoke ?? 'C', active: t.smoke },
    weapon: titanWeaponModel(row),
    rider: t.rider, batteryOut: t.batteryOut, phase: t.phase,
    embarking: t.phase === TITAN_PHASE.embark,
    lock: row.lk > 0 ? { state: row.lk | 0, label: LOCK_LABELS[row.lk | 0] ?? 'LOCKING' } : null,
  };
}

/** The pilot-side status of the own titan (meter, call prompt, bay, owned titan). */
export function titanMeterModel({ tf, match, team, ownTitan, self, keys = {}, local = {} }) {
  const meter = clamp01(tf?.meter);
  const callKey = keys.callTitan ?? 'E';
  if (ownTitan) {
    const t = decodeTitanRow(ownTitan);
    const dropping = t?.phase === TITAN_PHASE.dropping;
    const maxHp = Math.max(1, vehicleMaxHp(ownTitan));
    const distance = self && [self.x, self.z].every(Number.isFinite) ? Math.hypot(ownTitan.x - self.x, ownTitan.y - self.y, ownTitan.z - self.z) : Infinity;
    const embark = !dropping && !t?.doomed && distance <= TITAN_RULES.embark.distance;
    const name = TITAN_LABELS[ownTitan.type] ?? 'TITAN';
    // Owned: the gauge is the titan's hull (green), never the meter (amber).
    return {
      state: dropping ? 'dropping' : t?.doomed ? 'doomed' : 'owned', frac: dropping ? 1 : clamp01(ownTitan.hp / maxHp), pct: dropping ? 100 : pct(ownTitan.hp / maxHp),
      label: dropping ? 'TITANFALL INBOUND' : t?.doomed ? 'TITAN DOOMED' : 'AUTO-TITAN', titan: name, title: dropping ? name : `${name} · HULL`,
      prompt: embark ? { key: keys.interact ?? 'T', label: 'EMBARK', hold: true, progress: clamp01(local.embarkProgress) } : null, distance,
    };
  }
  if (meter >= 1) {
    const full = bayFull(match, team), bay = match?.titanfall?.bay;
    // Full bay: the count and when it frees (a team titan destroyed), not a bare refusal.
    const label = full ? `BAY FULL ${finite(team === 'bravo' ? bay[1] : bay[0])}/${bay[2]} · NEXT TITAN DOWN` : 'TITANFALL READY';
    return { state: full ? 'bay' : 'ready', frac: 1, pct: 100, label, titan: 'TITAN', title: 'TITAN',
      prompt: full ? null : { key: callKey, label: 'CALL TITAN', hold: false, progress: 0 } };
  }
  return { state: 'filling', frac: meter, pct: pct(meter), label: 'TITAN', titan: 'TITAN', title: 'TITAN', prompt: null };
}

const knownTactical = id => TITAN_PILOT_TACTICALS.includes(id);
const seconds2 = value => Math.round(value * 100) / 100;

/**
 * The tactical the server has equipped for this life. The server applies a loadout only at a
 * respawn (applyRespawnLoadout), so `tf.loadout` (the selection) is not the current kit.
 * Pure latch, kept by the caller across frames: `prev` is the last result ({ alive, id }) or null.
 * - `tfs.tacKind` (the equipped index, when the wire carries it) is authoritative;
 * - the first life seen runs the default kit (the stored pick reaches the server after the spawn);
 * - a respawn equips the selection the row carries at that tick;
 * - an active grapple / cloak / stim flag, or more than one charge (grapple), names the kit outright.
 */
export function equippedTacticalLatch(prev, { selfRow = null, tfs = null } = {}) {
  const tf = decodeTitanfallPlayer(selfRow);
  if (!tf) return prev ?? null;
  const alive = selfRow.state === 'alive';
  let id = prev?.id ?? TITAN_PILOT_TACTICALS[0];
  if (knownTactical(tfs?.tacKind)) id = tfs.tacKind;
  else {
    if (prev && alive && !prev.alive && knownTactical(tf.loadout?.tactical)) id = tf.loadout.tactical;
    if (alive) {
      if (tf.grappling || finite(tfs?.tacCharges) > 1) id = 'grapple';
      else if (tf.cloaked) id = 'cloak';
      else if (tf.stimmed) id = 'stim';
    }
  }
  return prev && prev.alive === alive && prev.id === id ? prev : { alive, id };
}

/**
 * Pilot tactical chip from the equipped tactical and the `tfs` frame. `equipped`: the
 * equippedTacticalLatch id; without it only `tfs.tacKind` or the default kit is trusted.
 */
export function tacticalModel(tf, tfs, keys = {}, equipped = null) {
  const id = knownTactical(tfs?.tacKind) ? tfs.tacKind : knownTactical(equipped) ? equipped : TITAN_PILOT_TACTICALS[0];
  const max = id === 'grapple' ? PILOT_RULES.grapple.charges : 1;
  const charges = Math.max(0, Math.min(max, finite(tfs?.tacCharges, max)));
  const ready = clamp01(tfs ? tfs.tacReady : 1);
  const active = id === 'cloak' ? !!tf?.cloaked : id === 'stim' ? !!tf?.stimmed : !!tf?.grappling;
  // Timers (s) from the server's cooldown progress (pilot-tacticals.js counts stim and cloak from activation):
  // `cooldownLeft` until the next charge (grapple) or until ready, `activeLeft` of a running stim or cloak.
  const rule = PILOT_RULES[id];
  const span = id === 'grapple' ? rule.recharge : rule.cooldown;
  const cooling = id === 'grapple' ? charges < max : ready < 1;
  const activeLeft = active && id !== 'grapple' ? seconds2(Math.max(0, rule.seconds - ready * span)) : null;
  return { id, label: TITANFALL_ITEM_LABELS[id], key: keys.pilotTactical ?? 'Q', charges, max, ready, readyPct: pct(ready),
    pips: Array.from({ length: max }, (_, i) => i < charges ? 1 : i === charges ? ready : 0),
    state: active ? 'active' : (id === 'grapple' ? charges > 0 : ready >= 1) ? 'ready' : 'cooling',
    reeling: id === 'grapple' && active, cooldownLeft: cooling ? seconds2((1 - ready) * span) : null,
    activeLeft, activeFrac: activeLeft == null ? 0 : clamp01(activeLeft / rule.seconds) };
}

/** The AT weapon chip: owned AT id, its ammo and the lock ring (`tfs[11]`). */
export function atModel(selfRow, tfs) {
  const owned = Array.isArray(selfRow?.owned) ? selfRow.owned : [];
  const id = owned.find(w => titanWeaponRole(w) === 'at') ?? null;
  if (!id) return null;
  const slot = WEAPON_IDS.indexOf(id);
  const mag = Array.isArray(selfRow?.mag) ? selfRow.mag[slot] : null;
  const reserve = Array.isArray(selfRow?.reserve) ? selfRow.reserve[slot] : null;
  const lock = clamp01(tfs?.lockProgress);
  return { id, label: itemLabel(id), mag: Number.isFinite(mag) ? mag : null,
    reserve: Number.isFinite(reserve) ? reserve : null, equipped: selfRow?.weapon === slot || selfRow?.weapon === id,
    lock, locked: lock >= 1 };
}

/** The whole HUD model. `layout` is 'titan' (seated in the own titan), 'embark' (the embark animation), 'pilot', 'dead' or 'hidden'. */
export function titanHudModel({ snapshot = null, selfRow = null, tfs = null, now = NaN, keys = {}, local = {} } = {}) {
  const match = snapshot?.match ?? null;
  if (match?.mode && match.mode !== 'titanfall') return { layout: 'hidden' };
  const tf = decodeTitanfallPlayer(selfRow);
  const at = Number.isFinite(now) ? now : finite(snapshot?.serverNow, 0);
  const vehicles = Array.isArray(snapshot?.vehicles) ? snapshot.vehicles : [];
  const top = scoreBar(match, selfRow?.team, at);
  if (!selfRow || !tf) return { layout: 'hidden', top };
  const ownTitan = tf.titanId ? vehicles.find(v => v?.id === tf.titanId && isTitanType(v.type) && v.hp > 0 && !v.wreck) ?? null : null;
  const seated = !!ownTitan && selfRow.vehicleId === ownTitan.id && selfRow.state === 'alive' && tf.mv !== TITAN_MV.embarking;
  if (selfRow.state !== 'alive') {
    const respawnIn = Number.isFinite(selfRow.respawnAt) ? Math.max(0, (selfRow.respawnAt - at) / 1000) : null;
    // §3.4 deploy: waiting for DEPLOY (`queued` once sent; `staged` = held off the field at join / match start).
    const deploy = tf.deploy ? { queued: tf.deployQueued, staged: tf.staged } : null;
    // Seconds until the server's idle fallback deploys a held human (§3.4), shown once the respawn timer is out.
    const autoDeployIn = deploy && !deploy.queued && Number.isFinite(selfRow.respawnAt)
      ? Math.max(0, (selfRow.respawnAt + TITANFALL_DEPLOY_TIMEOUT_MS - at) / 1000) : null;
    return { layout: 'dead', top, respawnIn, autoDeployIn, deploy, meter: titanMeterModel({ tf, match, team: selfRow.team, ownTitan, self: null, keys }) };
  }
  // OOB (§4.1): the server's oob_warning deadline (local.oobUntil, server ms) counts the banner down.
  const oobLeft = tf.oob && Number.isFinite(local.oobUntil) && local.oobUntil > at ? Math.ceil((local.oobUntil - at) / 1000) : null;
  const oob = tf.oob ? { label: oobLeft ? `RETURN TO THE BATTLEFIELD · ${oobLeft} S` : 'RETURN TO THE BATTLEFIELD', seconds: oobLeft } : null;
  const toast = typeof local.toast === 'string' && local.toast ? local.toast : null;
  const touch = !!local.touch;
  if (seated) {
    return { layout: 'titan', top, oob, toast, touch, titan: titanModel(ownTitan, { now: at, keys, local }), rider: decodeTitanRow(ownTitan)?.rider ? 'ENEMY PILOT ON BOARD' : null };
  }
  // Embark animation (1.2 s, the camera is pulled into the cockpit): no pilot readouts over it (playtest).
  if (ownTitan && tf.mv === TITAN_MV.embarking) return { layout: 'embark', top, oob, toast, touch };
  const hp = Math.max(0, finite(selfRow.hp));
  return {
    layout: 'pilot', top, oob, toast, touch,
    pilot: {
      hp: Math.ceil(hp), hpFrac: clamp01(hp / 100), embarking: tf.mv === TITAN_MV.embarking,
      battery: tf.battery, cloaked: tf.cloaked, stimmed: tf.stimmed,
      meter: titanMeterModel({ tf, match, team: selfRow.team, ownTitan, self: selfRow, keys, local }),
      tactical: tacticalModel(tf, tfs, keys, local.equippedTactical),
      at: atModel(selfRow, tfs),
      rodeo: rodeoPrompt({ self: selfRow, tf, vehicles, now: at, local, keys }),
      mv: tf.mv,
    },
  };
}

/**
 * The titanfall touch context (touch-controls.js setTitanfallTouchSource) of a HUD model:
 * { layout, doomed, context (pilot chip label or null), ready: { action: 0..1 } }, or null.
 */
export function titanfallTouchModel(model) {
  if (!model || (model.layout !== 'pilot' && model.layout !== 'titan')) return null;
  if (model.layout === 'titan') {
    const t = model.titan;
    const ready = { titanDash: t.dash.max ? t.dash.pips / t.dash.max : 0, titanCore: t.core.frac, titanSmoke: t.smoke.charges > 0 ? 1 : 0, titanEject: 1 };
    const actions = { defensive: 'titanDefensive', tactical: 'titanTactical', ordnance: 'titanOrdnance' };
    const labels = {};
    for (const slot of t.abilities) { ready[actions[slot.slot]] = slot.ready; labels[actions[slot.slot]] = touchLabel(slot.label); }
    // The context chip reads EXIT (tap disembarks, as the interact tap on keyboard); doomed titans eject instead.
    ready.callTitan = 1;
    return { layout: 'titan', doomed: !!t.doomed, context: t.doomed ? null : 'EXIT', ready, labels };
  }
  const p = model.pilot, rodeo = p.rodeo;
  const embark = p.meter.prompt?.label === 'EMBARK' ? p.meter.prompt : null;
  const context = rodeo?.kind === 'rip' ? 'RIP' : rodeo?.kind === 'mount' && rodeo.inReach !== false ? 'RODEO' : rodeo?.kind === 'insert' && rodeo.inReach !== false ? 'BATTERY'
    : embark ? 'EMBARK' : p.meter.state === 'ready' ? 'TITAN' : null;
  // EMBARK is a hold: the chip's conic fill is the hold ring (0 at rest, 1 when the enter is sent).
  const callReady = context === 'EMBARK' ? clamp01(embark.progress) : 1;
  return { layout: 'pilot', doomed: false, context, ready: { pilotTactical: p.tactical.state === 'cooling' ? p.tactical.ready : 1, callTitan: callReady },
    labels: { pilotTactical: touchLabel(p.tactical.label) } };
}

/** One short name per ability (touch faces and cockpit MFD tiles share it, at most 8 letters). */
export const TITAN_ABILITY_SHORT = Object.freeze({
  'VORTEX SHIELD': 'VORTEX', 'LASER TRIPWIRE': 'TRIPWIRE', 'LASER SHOT': 'SHOT', 'LASER CORE': 'LASER',
  'THERMAL SHIELD': 'THERMAL', 'INCENDIARY TRAP': 'TRAP', 'FIREWALL': 'FIREWALL', 'FLAME CORE': 'FLAME',
  'TETHER TRAP': 'TETHER', 'VTOL HOVER': 'HOVER', 'CLUSTER MISSILE': 'CLUSTER', 'FLIGHT CORE': 'FLIGHT',
  'SWORD BLOCK': 'BLOCK', 'ARC WAVE': 'ARC WAVE', 'PHASE DASH': 'PHASE', 'SWORD CORE': 'SWORD',
  'GUN SHIELD': 'SHIELD', 'MODE SWITCH': 'MODE', 'POWER SHOT': 'POWER', 'SMART CORE': 'SMART', 'ELECTRIC SMOKE': 'SMOKE',
});

/** A touch button face: the ability's short name, else the longest word, at most 8 letters ("VORTEX SHIELD" -> "VORTEX"). */
export function touchLabel(label) {
  const short = TITAN_ABILITY_SHORT[String(label ?? '').toUpperCase().trim()];
  if (short) return short;
  const words = String(label ?? '').toUpperCase().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  return words.reduce((best, word) => word.length > best.length ? word : best, '').slice(0, 8);
}

/** Stable string of a model for paint de-duplication (the DOM skips identical frames). */
export function modelSignature(model) { return JSON.stringify(model); }
