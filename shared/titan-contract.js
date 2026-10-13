/**
 * Frozen cross-package contract for the Titanfall (Attrition) mode
 * (docs/titanfall.md §2.2, §3). Dependency-free on purpose: no imports, so
 * conquest-contract.js can resolve titan types without a cycle and the
 * preload graph grows by this one small module. Edit only through the
 * orchestrator (§12.5): every export name and shape here is frozen by WP0.
 */
const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
};
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clampInt = (value, lo, hi) => Math.max(lo, Math.min(hi, Math.round(finite(value))));

export const TITANFALL_CONTRACT_VERSION = 1;
export const TITAN_TYPE_IDS = Object.freeze(['titan_ion', 'titan_scorch', 'titan_northstar', 'titan_ronin', 'titan_legion']);
export const TITAN_CHASSIS = Object.freeze({ titan_ion: 'atlas', titan_scorch: 'ogre', titan_northstar: 'stryder',
  titan_ronin: 'stryder', titan_legion: 'ogre' });
export const TITAN_LABELS = Object.freeze({ titan_ion: 'ION', titan_scorch: 'SCORCH', titan_northstar: 'NORTHSTAR',
  titan_ronin: 'RONIN', titan_legion: 'LEGION' });
export const TITAN_ARMOR_CLASS = 'titan';
/** `tf[0]` pilot movement state. */
export const TITAN_MV = Object.freeze({ ground: 0, sprint: 1, slide: 2, wallrun: 3, air: 4, grapple: 5,
  rodeo: 6, embarking: 7, piloting: 8, ejecting: 9 });
export const TITAN_ABILITY_SLOTS = Object.freeze(['defensive', 'tactical', 'ordnance', 'core']);
/** `tw[5]` titan phase. */
export const TITAN_PHASE = Object.freeze({ idle: 0, dropping: 1, landed: 2, embark: 3, disembark: 4, auto: 5, doomed: 6, ejected: 7 });
/** `tw[4]` ability bits. */
export const TITAN_ABILITY_BITS = Object.freeze({ core: 1, defensive: 2, hover: 4, phased: 8, batteryOut: 16, rider: 32, smoke: 64, slowed: 128, rooted: 256 });
/**
 * `tf[3]` pilot flag bits. Deploy gate (§3.4 deploy): `deploy` while a dead human waits for its DEPLOY
 * request, `deployQueued` once it was sent (spawns when the respawn timer runs out), `staged` while
 * the player was held off the field without a death (join, match start, team change, bot takeover).
 */
export const TITANFALL_PLAYER_FLAGS = Object.freeze({ battery: 1, cloaked: 2, stimmed: 4, ejectCloak: 8, grappling: 16, oob: 32,
  deploy: 64, deployQueued: 128, staged: 256 });

/** Same row shape as VEHICLE_TOPOLOGY in conquest-contract.js (S/M helpers). */
const S = (id, role, drives, exposed, personalWeapons, mounts) => Object.freeze({ id, role, drives, exposed, personalWeapons, mounts: Object.freeze(mounts) });
const M = (id, weapons) => Object.freeze({ id, weapons: Object.freeze(weapons) });
export const TITAN_TOPOLOGY = Object.freeze({
  titan_ion: Object.freeze([S('driver', 'pilot', true, false, false, [M('splitter', ['splitter'])])]),
  titan_scorch: Object.freeze([S('driver', 'pilot', true, false, false, [M('t203', ['t203'])])]),
  titan_northstar: Object.freeze([S('driver', 'pilot', true, false, false, [M('railgun', ['railgun'])])]),
  titan_ronin: Object.freeze([S('driver', 'pilot', true, false, false, [M('leadwall', ['leadwall'])])]),
  // One mount, two weapons: Mode Switch reuses the mount `weapon` select action and `sel`.
  titan_legion: Object.freeze([S('driver', 'pilot', true, false, false, [M('predator', ['predatorClose', 'predatorLong'])])]),
});

/**
 * Titan mount weapons, same shape as VEHICLE_WEAPON_META: label, kind
 * ('hitscan' | 'shell' | 'melee'), cls (always 'titan', §2.4), speed, gravity,
 * rate (shots/s) and the client presentation family. Numbers live in
 * shared/vehicle-handling/titan-weapons.js (WP3).
 */
export const TITAN_WEAPON_META = deepFreeze({
  splitter:      { label: 'SPLITTER RIFLE', kind: 'hitscan', cls: 'titan', speed: 0,   gravity: 0,  rate: 1 / 0.15, presentation: 'splitter' },
  t203:          { label: 'T-203 THERMITE', kind: 'shell',   cls: 'titan', speed: 60,  gravity: 12, rate: 1,        presentation: 't203' },
  railgun:       { label: 'PLASMA RAILGUN', kind: 'hitscan', cls: 'titan', speed: 0,   gravity: 0,  rate: 1 / 2.4,  presentation: 'railgun' },
  leadwall:      { label: 'LEADWALL',       kind: 'shell',   cls: 'titan', speed: 120, gravity: 0,  rate: 1 / 0.65, presentation: 'leadwall' },
  predatorClose: { label: 'PREDATOR CANNON',kind: 'hitscan', cls: 'titan', speed: 0,   gravity: 0,  rate: 1 / 0.06, presentation: 'predator' },
  predatorLong:  { label: 'PREDATOR LONG',  kind: 'hitscan', cls: 'titan', speed: 0,   gravity: 0,  rate: 1 / 0.12, presentation: 'predator' },
  titanMelee:    { label: 'TITAN MELEE',    kind: 'melee',   cls: 'titan', speed: 0,   gravity: 0,  rate: 1 / 1.3,  presentation: 'titanMelee' },
});

/**
 * Abilities as data over server primitives (§5.5):
 * `TITAN_ABILITIES[type][slot] = { slot, key, label, primitive, cls, cooldown, charges, anchor, ...params }`.
 * `key` is the kill key (TITAN_KILL_KEYS) or null for non-damaging abilities;
 * `anchor` is a hull-space muzzle offset [x, y, z] (forward is -Z). Cooldowns
 * are seconds; 'core' abilities charge from the core meter instead (cooldown 0).
 * WP3 owns the numbers; the field set is frozen.
 */
const A = (slot, key, label, primitive, cls, cooldown, charges, anchor, params = {}) =>
  ({ slot, key, label, primitive, cls, cooldown, charges, anchor, ...params });
const CHEST = [0, 4.8, -1.2], SHOULDER = [-1.1, 5.6, -0.6], ARM = [1.2, 3.8, -1.6];
export const TITAN_ABILITIES = deepFreeze({
  titan_ion: {
    defensive: A('defensive', null, 'VORTEX SHIELD', 'frontGuard', null, 10, 1, ARM, { mode: 'catch', seconds: 3.5, radius: 3.2, forward: 2.5, maxCaught: 40, rocketWeight: 5 }),
    tactical: A('tactical', 'tripwire', 'LASER TRIPWIRE', 'deployable', 'titan', 0, 1, CHEST, { energy: 350, mines: 3, length: 15, damage: 260 }),
    ordnance: A('ordnance', 'laserShot', 'LASER SHOT', 'shot', 'titan', 0, 1, CHEST, { energy: 500, damage: 400, infantryDamage: 150, hitscan: true }),
    core: A('core', 'laserCore', 'LASER CORE', 'coreBuff', 'titan', 0, 1, CHEST, { seconds: 4, dps: 600, infantryDps: 250, range: 90, beam: true }),
  },
  titan_scorch: {
    defensive: A('defensive', 'thermalShield', 'THERMAL SHIELD', 'frontGuard', 'fire', 12, 1, ARM, { mode: 'block', seconds: 4, dps: 120, range: 5 }),
    tactical: A('tactical', 'incendiaryTrap', 'INCENDIARY TRAP', 'deployable', 'fire', 14, 1, CHEST, { seconds: 8, radius: 6, dps: 80 }),
    ordnance: A('ordnance', 'firewall', 'FIREWALL', 'groundLine', 'fire', 12, 1, CHEST, { length: 30, seconds: 6, dps: 120, pilotDps: 60 }),
    core: A('core', 'flameCore', 'FLAME CORE', 'groundLine', 'titan', 0, 1, CHEST, { lines: 3, length: 30, damage: 1500, perTarget: 900 }),
  },
  titan_northstar: {
    defensive: A('defensive', 'tether', 'TETHER TRAP', 'deployable', 'titan', 10, 2, SHOULDER, { rootSeconds: 3, damage: 200 }),
    tactical: A('tactical', null, 'VTOL HOVER', 'hover', null, 13, 1, CHEST, { seconds: 3, hoverVy: 0, speedMul: 0.5 }),
    ordnance: A('ordnance', 'cluster', 'CLUSTER MISSILE', 'shot', 'titan', 12, 1, SHOULDER, { bursts: 6, seconds: 3, damage: 80 }),
    core: A('core', 'flightCore', 'FLIGHT CORE', 'hover', 'titan', 0, 1, SHOULDER, { seconds: 4, rockets: 24, damage: 70, interval: 0.16 }),
  },
  titan_ronin: {
    defensive: A('defensive', null, 'SWORD BLOCK', 'frontGuard', null, 0, 1, ARM, { mode: 'reduce', damageTakenMul: 0.3 }),
    tactical: A('tactical', 'arcWave', 'ARC WAVE', 'groundLine', 'titan', 7, 1, ARM, { length: 30, damage: 250, slowSeconds: 1, speedMul: 0.5 }),
    ordnance: A('ordnance', null, 'PHASE DASH', 'dash', null, 8, 1, CHEST, { blink: 8, phasedSeconds: 0.6 }),
    core: A('core', null, 'SWORD CORE', 'coreBuff', 'titan', 0, 1, ARM, { seconds: 8, meleeDamage: 350, pipRefill: true, damageTakenMul: 0.7 }),
  },
  titan_legion: {
    defensive: A('defensive', null, 'GUN SHIELD', 'frontGuard', null, 15, 1, ARM, { mode: 'block', seconds: 5, hp: 1500 }),
    tactical: A('tactical', null, 'MODE SWITCH', 'toggle', null, 0.6, 1, ARM, { weapons: ['predatorClose', 'predatorLong'] }),
    ordnance: A('ordnance', 'powerShot', 'POWER SHOT', 'shot', 'titan', 9, 1, ARM, { damageClose: 900, damageLong: 600 }),
    core: A('core', null, 'SMART CORE', 'coreBuff', null, 0, 1, ARM, { seconds: 10, cone: 40 * Math.PI / 180, damageMul: 1.15 }),
  },
});
/** Abilities every titan carries (electric smoke, melee). Same row shape as TITAN_ABILITIES. */
export const TITAN_COMMON_ABILITIES = deepFreeze({
  smoke: A('smoke', 'electricSmoke', 'ELECTRIC SMOKE', 'deployable', 'rodeo', 0, 2, CHEST, { radius: 7, seconds: 6, riderDps: 250, pilotDps: 60 }),
  melee: A('melee', 'titanMelee', 'MELEE', 'melee', 'titan', 1.3, 1, ARM, { damage: 200, infantryDamage: 150, range: 4.5 }),
});

/** Titanfall kill keys (`kill.w`) beyond the mount weapons' own keys, key -> kill-feed label (§2.3). */
export const TITAN_KILL_KEYS = deepFreeze({
  splitter: 'SPLITTER RIFLE', t203: 'T-203 THERMITE', railgun: 'PLASMA RAILGUN', leadwall: 'LEADWALL',
  predatorClose: 'PREDATOR CANNON', predatorLong: 'PREDATOR LONG', titanMelee: 'TITAN MELEE',
  titanfall: 'TITANFALL', titan_doom: 'TITAN DESTROYED', titan_crush: 'TITAN CRUSH', rodeo: 'RODEO',
  electricSmoke: 'ELECTRIC SMOKE', laserShot: 'LASER SHOT', laserCore: 'LASER CORE', tripwire: 'LASER TRIPWIRE',
  thermalShield: 'THERMAL SHIELD', incendiaryTrap: 'INCENDIARY TRAP', firewall: 'FIREWALL', flameCore: 'FLAME CORE',
  tether: 'TETHER TRAP', cluster: 'CLUSTER MISSILE', flightCore: 'FLIGHT CORE', arcWave: 'ARC WAVE',
  powerShot: 'POWER SHOT', thermite: 'THERMITE',
});

/**
 * Server -> client event kinds (§3.8, all `{t:'ev', kind, at, ...}`), emitted only in titanfall rooms.
 * Session forwards each of them to main.js onGameplayEvent -> titanfall client onEvent.
 */
export const TITANFALL_EVENT_KINDS = Object.freeze([
  'titanfall_drop', 'titanfall_refused', 'titan_embark', 'titan_disembark', 'titan_doomed', 'titan_eject',
  'rodeo_mount', 'rodeo_rip', 'rodeo_insert', 'rodeo_off', 'battery_drop', 'battery_pickup',
  'core_ready', 'core_start', 'core_end', 'oob_warning', 'titan_ability',
]);
export const TITAN_PILOT_TACTICALS = Object.freeze(['grapple', 'stim', 'cloak']);
export const TITAN_PILOT_PRIMARIES = Object.freeze(['rifle', 'smg', 'shotgun', 'lmg', 'kraber']);
export const TITAN_PILOT_AT = Object.freeze(['chargerifle', 'archer', 'thunderbolt', 'mgl']);
export const TITAN_PILOT_SIDEARM = 'revolver';
export const TITAN_PILOT_MELEE = 'knife';
export const isTitanType = type => typeof type === 'string' && Object.hasOwn(TITAN_TOPOLOGY, type);

/**
 * Stand-ins while WP4's ids are absent from WEAPON_IDS: the kraber falls back
 * to the sniper, every AT id to the rocket (server/sim/titanfall/loadout.js).
 * They carry the same kit roles.
 */
const ROLE_FALLBACKS = Object.freeze({ sniper: 'primary', rocket: 'at' });
/** Titanfall kit role by id (not conquest's kitWeaponRole): 'primary'|'sidearm'|'at'|'melee'|null. */
export function titanWeaponRole(id) {
  if (TITAN_PILOT_PRIMARIES.includes(id)) return 'primary';
  if (id === TITAN_PILOT_SIDEARM) return 'sidearm';
  if (TITAN_PILOT_AT.includes(id)) return 'at';
  if (id === TITAN_PILOT_MELEE) return 'melee';
  return ROLE_FALLBACKS[id] ?? null;
}
export const TITANFALL_DIGIT_ROLES = Object.freeze(['primary', 'sidearm', 'at', 'melee']);   // digits 1..4
/** §3.4 deploy gate: a held human is deployed this long after its respawn time without DEPLOY (server and loadout countdown). */
export const TITANFALL_DEPLOY_TIMEOUT_MS = 20000;

/** Loadout pack (§3.4): primary | at << 4 | tactical << 8 | titan << 12. */
export const TITAN_LOADOUT_DEFAULT = Object.freeze({ primary: 'rifle', at: 'chargerifle', tactical: 'grapple', titan: 'titan_ion' });
const field = (list, value, fallback) => {
  const index = typeof value === 'string' ? list.indexOf(value) : Number.isInteger(value) ? value : -1;
  return index >= 0 && index < list.length ? index : list.indexOf(fallback);
};
export function packTitanLoadout({ primary, at, tactical, titan } = {}) {
  const D = TITAN_LOADOUT_DEFAULT;
  return field(TITAN_PILOT_PRIMARIES, primary, D.primary) | field(TITAN_PILOT_AT, at, D.at) << 4
    | field(TITAN_PILOT_TACTICALS, tactical, D.tactical) << 8 | field(TITAN_TYPE_IDS, titan, D.titan) << 12;
}
/** Inverse of packTitanLoadout; every field is clamped, invalid values give the defaults. */
export function unpackTitanLoadout(n) {
  const D = TITAN_LOADOUT_DEFAULT, v = Number.isSafeInteger(n) && n >= 0 ? n : 0;
  const pick = (list, index, fallback) => list[index] ?? fallback;
  return {
    primary: pick(TITAN_PILOT_PRIMARIES, v & 15, D.primary),
    at: pick(TITAN_PILOT_AT, v >> 4 & 15, D.at),
    tactical: pick(TITAN_PILOT_TACTICALS, v >> 8 & 15, D.tactical),
    titan: pick(TITAN_TYPE_IDS, v >> 12 & 15, D.titan),
  };
}
export const TITAN_LOADOUT_DEFAULT_PACKED = packTitanLoadout(TITAN_LOADOUT_DEFAULT);

// ---- wire rows --------------------------------------------------------------------

const shortId = id => typeof id === 'string' && id.length > 0 ? id : 0;
const tenths = point => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite)
  ? point.map(n => Math.round(n * 10)) : 0;
// Readiness rounds down: 100 on the wire means the server already accepts the action.
const percent = value => Math.max(0, Math.min(100, Math.floor(finite(value) * 100 + 1e-9)));

/**
 * Player row `tf` (§3.1), from the policy's per-player record (`p.titanfall`):
 * `{ mv, titanId, loadout, flags, meter (0..1), rodeoVehicleId, grapple ([x,y,z] metres | null), titanKills }`.
 * Result: [mv, titanId|0, loadout, flags, meter100, rodeoVehicleId|0, grapple tenths|0, titanKills].
 */
export function encodeTitanfallPlayer(tf) {
  const s = tf && typeof tf === 'object' ? tf : {};
  return [clampInt(s.mv, 0, 15), shortId(s.titanId), clampInt(s.loadout, 0, 0xffff), clampInt(s.flags, 0, 0xffff),
    percent(s.meter), shortId(s.rodeoVehicleId), tenths(s.grapple), Math.max(0, Math.trunc(finite(s.titanKills)))];
}
/** Decoded `tf` of a player row, or null when the row has none. */
export function decodeTitanfallPlayer(row) {
  const tf = Array.isArray(row?.tf) ? row.tf : null;
  if (!tf) return null;
  const flags = tf[3] | 0, F = TITANFALL_PLAYER_FLAGS;
  return {
    mv: tf[0] | 0, titanId: typeof tf[1] === 'string' ? tf[1] : null, loadout: unpackTitanLoadout(tf[2] | 0), loadoutPacked: tf[2] | 0,
    flags, battery: !!(flags & F.battery), cloaked: !!(flags & F.cloaked), stimmed: !!(flags & F.stimmed),
    ejectCloak: !!(flags & F.ejectCloak), grappling: !!(flags & F.grappling), oob: !!(flags & F.oob),
    deploy: !!(flags & F.deploy), deployQueued: !!(flags & F.deployQueued), staged: !!(flags & F.staged),
    meter: (tf[4] | 0) / 100, rodeoVehicleId: typeof tf[5] === 'string' ? tf[5] : null,
    grapple: Array.isArray(tf[6]) && tf[6].length === 3 ? tf[6].map(n => n / 10) : null, titanKills: tf[7] | 0,
  };
}

/**
 * Self-only frame data `tfs.d` (§3.2) from
 * `{ vx, vy, vz, wallN, wallT, jumpsLeft, slideT, slideCd, tacCharges, tacReady (0..1), jumpSeqAck, lockProgress (0..1), tacKind }`.
 * `tacKind` (d[12]) is the tactical equipped for this life (index into TITAN_PILOT_TACTICALS, -1 unknown); the
 * loadout in `tf[2]` is only the selection, applied at the next respawn.
 */
export function encodeTitanfallSelf(s = {}) {
  const c = v => Math.round(finite(v) * 100);
  return [c(s.vx), c(s.vy), c(s.vz), clampInt(s.wallN, -2, 2), c(s.wallT), clampInt(s.jumpsLeft, 0, 9), c(s.slideT), c(s.slideCd),
    clampInt(s.tacCharges, 0, 9), percent(s.tacReady), clampInt(s.jumpSeqAck, 0, 255), percent(s.lockProgress),
    clampInt(TITAN_PILOT_TACTICALS.indexOf(s.tacKind), -1, 9)];
}
/** Decode a `{t:'tfs', s, d}` frame (or its bare `d` array), or null. */
export function decodeTitanfallSelf(frame) {
  const d = Array.isArray(frame) ? frame : Array.isArray(frame?.d) ? frame.d : null;
  if (!d || d.length < 12) return null;
  return { seq: Number.isFinite(frame?.s) ? frame.s : null,
    vx: d[0] / 100, vy: d[1] / 100, vz: d[2] / 100, wallN: d[3] | 0, wallT: d[4] / 100, jumpsLeft: d[5] | 0,
    slideT: d[6] / 100, slideCd: d[7] / 100, tacCharges: d[8] | 0, tacReady: (d[9] | 0) / 100, jumpSeqAck: d[10] | 0,
    lockProgress: (d[11] | 0) / 100, tacKind: d.length > 12 ? TITAN_PILOT_TACTICALS[d[12] | 0] ?? null : null };
}

/**
 * Titan vehicle row extras (§3.3) from TitanSystem's state view
 * `{ shield, dash (pips, float), core (0..1), doomLeft (s, 0 alive), bits, phase, owner, def, tac, ord (0..1), smoke }`.
 * Result: `{ tw: [shield, dashTenths, core100, doomTenths, bits, phase], own, ab: [def100, tac100, ord100, smokeCharges] }`.
 */
export function encodeTitanRow(s = {}) {
  return {
    tw: [Math.max(0, Math.ceil(finite(s.shield))), Math.max(0, Math.min(99, Math.floor(finite(s.dash) * 10 + 1e-9))), percent(s.core),
      finite(s.doomLeft) > 0 ? clampInt(Math.ceil(finite(s.doomLeft) * 10), 1, 999) : 0, clampInt(s.bits, 0, 0xffff), clampInt(s.phase, 0, 15)],
    own: typeof s.owner === 'string' ? s.owner : null,
    ab: [percent(s.def), percent(s.tac), percent(s.ord), clampInt(s.smoke, 0, 9)],
  };
}
/** Decoded titan extras of a vehicle row, or null for any row without `tw`. */
export function decodeTitanRow(row) {
  const tw = Array.isArray(row?.tw) ? row.tw : null;
  if (!tw) return null;
  const ab = Array.isArray(row.ab) ? row.ab : [0, 0, 0, 0], bits = tw[4] | 0, B = TITAN_ABILITY_BITS;
  return {
    shield: tw[0] | 0, dash: (tw[1] | 0) / 10, core: (tw[2] | 0) / 100, doomLeft: (tw[3] | 0) / 10, doomed: (tw[3] | 0) > 0 || (tw[5] | 0) === TITAN_PHASE.doomed,
    bits, coreActive: !!(bits & B.core), defensiveUp: !!(bits & B.defensive), hover: !!(bits & B.hover), phased: !!(bits & B.phased),
    batteryOut: !!(bits & B.batteryOut), rider: !!(bits & B.rider), smoke: !!(bits & B.smoke), slowed: !!(bits & B.slowed), rooted: !!(bits & B.rooted),
    phase: tw[5] | 0, owner: typeof row.own === 'string' ? row.own : null,
    def: (ab[0] | 0) / 100, tac: (ab[1] | 0) / 100, ord: (ab[2] | 0) / 100, smokeCharges: ab[3] | 0,
  };
}
