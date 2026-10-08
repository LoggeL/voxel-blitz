// Conquest infantry kits: the loadout table derived from the frozen contract
// (`KITS`, `KIT_SIDEARM`) plus the role tuning numbers that the contract does
// not carry. Pure data and pure functions, shared by the server roles module,
// bots and the client deploy screen, so a kit always means the same inventory.

import { KITS, KIT_IDS, KIT_SIDEARM } from './conquest-contract.js';
import { WEAPONS, WEAPON_IDS } from './combatmath.js';
import { GRENADE_TYPE_IDS } from './grenade-rules.js';

/** Every kit also carries the default melee tool (the IRON PICK). */
export const KIT_MELEE = 'knife';

/**
 * Gadget ammunition overrides. `mag` is the loaded magazine, `reserve` the spare
 * count in the weapon's own reserve unit (spare magazines, or loose rounds for
 * staged tube weapons). Weapons absent here use their roster defaults.
 */
export const KIT_GADGET_AMMO = Object.freeze({
  rocket: Object.freeze({ mag: 1, reserve: 4 }),
  stinger: Object.freeze({ mag: 1, reserve: 2 }),
});

/** Deploy-screen labels of the gadget choices (role first, then the launcher). */
export const KIT_GADGET_LABELS = Object.freeze({
  rocket: Object.freeze({ role: 'AT', name: 'RX-8 HAVOC', hint: 'DUMB-FIRE ANTI-TANK' }),
  stinger: Object.freeze({ role: 'AA', name: 'AX-9 STINGER', hint: 'LOCK-ON ANTI-AIR' }),
});

/**
 * Role tuning that complements `CONQUEST_RULES`. Balance numbers are data, so
 * tuning never needs a logic change.
 */
export const KIT_ROLE_RULES = Object.freeze({
  /** Medic revive reach, reviver feet to body feet (m). */
  reviveRange: 2,
  /** Engineer repair reach, chest to the nearest hull surface (m). */
  repairRange: 3.5,
  /** Repair stays paused this long after the repairer last took damage. */
  repairInterruptMs: 1000,
  /** One `repair` award per this fraction of the hull's maximum HP restored. */
  repairAwardFraction: 0.1,
  /** A support session that stays stale for this long is dropped (progress lost). */
  supportSessionDropMs: 1500,
  /** Support aura pulse interval and reach (m, 3D, self included). */
  resupplyIntervalMs: 4000,
  resupplyRadius: 8,
  /** A mate in the aura gets one gadget round (AT rocket or STINGER) at most this often. */
  gadgetResupplyMs: 12000,
  /** A `resupply` award per supporter and mate at most this often. */
  resupplyAwardCooldownMs: 15000,
  /** Spot attempts closer together than this are dropped before any ray is cast. */
  spotAttemptMinMs: 250,
  /** Angular body radius used by the spot cone (m) for infantry targets. */
  spotPlayerRadius: 0.55,
  /** Medic heal aura: pulse interval, reach (m, feet to feet) and HP per pulse per mate. */
  healIntervalMs: 1000,
  healRadius: 6,
  healPerPulse: 5,
  /** A mate damaged this recently is skipped: the aura tops up between fights only. */
  healDamagePauseMs: 3000,
  /** The Medic heals itself at this share of a pulse. */
  healSelfFraction: 0.5,
  /** One `heal` award per this many HP restored to others. */
  healAwardHp: 50,
  /** A mate in the aura gets a spent medkit back at most this often. */
  medkitRestockMs: 30000,
  /** Assault ADRENALINE: an enemy infantry kill re-arms the medkit and returns grenades, at most this often. */
  adrenalineCooldownMs: 10000,
  adrenalineGrenade: 'frag',
  adrenalineGrenades: 1,
  /** Grenadier ORDNANCE: a self resupply pulse (one magazine, one grenade) this often. */
  ordnanceIntervalMs: 20000,
  /** Raider GHOST: no auto-spot on fire, and any mark on a Raider lasts at most this long. */
  ghostSpotMs: 2500,
  /** Marksman OVERWATCH: a damaging primary hit marks the target for the team this long. */
  overwatchTagMs: 4000,
  /** Tag only the first body a piercing shot passes (VOLTLANCE); off by default. */
  overwatchTagFirstOnly: false,
});

/**
 * Deploy-screen order (base kits first, then the level unlocks); independent of
 * the KIT_IDS wire order, which only ever grows at the end.
 */
export const KIT_MENU_ORDER = Object.freeze(['assault', 'medic', 'engineer', 'support', 'recon', 'pyro', 'grenadier', 'raider', 'marksman']);

/** Career level that opens a kit (1: always available). Unknown kits are never unlocked. */
export function kitUnlockLevel(kit) {
  const def = Object.hasOwn(KITS, kit) ? KITS[kit] : null;
  return def ? Math.max(1, Math.trunc(def.unlockLevel ?? 1)) : Infinity;
}

/** True when a player at career `level` may deploy with `kit`. */
export function kitUnlocked(kit, level) {
  const lv = Number.isFinite(level) ? Math.max(1, Math.trunc(level)) : 1;
  return lv >= kitUnlockLevel(kit);
}

/** Kit ids open at career `level`, in KIT_MENU_ORDER. */
export function unlockedKits(level) {
  return KIT_MENU_ORDER.filter(kit => kitUnlocked(kit, level));
}

/** Deploy-card ability labels (the ability ids stay internal). */
export const KIT_ABILITY_LABELS = Object.freeze({
  adrenaline: 'ADRENALINE', revive: 'REVIVE · HEAL', repair: 'REPAIR', resupply: 'RESUPPLY', spot: 'SPOTTING',
  fireproof: 'FIREPROOF', ordnance: 'ORDNANCE', ghost: 'GHOST', overwatch: 'OVERWATCH',
});

const secs = ms => `${+(ms / 1000).toFixed(1)} S`;
/**
 * One-line ability hint for the deploy card, formatted from the rule tables
 * so every number on screen is the number the server uses.
 */
export function kitAbilityHint(kit, rules = {}) {
  const r = KIT_ROLE_RULES;
  const ability = KITS[kit]?.ability;
  const hps = r.healPerPulse * 1000 / r.healIntervalMs;
  switch (ability) {
    case 'adrenaline': return `ENEMY KILL RE-ARMS YOUR MEDKIT · +${r.adrenalineGrenades} ${r.adrenalineGrenade.toUpperCase()} · ${secs(r.adrenalineCooldownMs)} COOLDOWN`;
    case 'revive': return `REVIVE DOWNED MATES · HEAL ${+hps.toFixed(1)} HP/S WITHIN ${r.healRadius} M`;
    case 'repair': return `REPAIR FRIENDLY HULLS WITHIN ${r.repairRange} M`;
    case 'resupply': return `AMMO AND GRENADES TO MATES WITHIN ${r.resupplyRadius} M EVERY ${secs(r.resupplyIntervalMs)}`;
    case 'spot': return `SPOTS REACH ${rules.spotRangeRecon ?? 400} M AND LAST ${secs(rules.spotMsRecon ?? 8000)}`;
    case 'fireproof': return 'IMMUNE TO FIRE · FLAMES AND MOLOTOVS';
    case 'ordnance': return `REFILLS ONE MAGAZINE AND ONE GRENADE EVERY ${secs(r.ordnanceIntervalMs)}`;
    case 'ghost': return `NO AUTO-SPOT WHEN FIRING · MARKS LAST ${secs(r.ghostSpotMs)}`;
    case 'overwatch': return `PRIMARY HITS TAG TARGETS FOR ${secs(r.overwatchTagMs)}`;
    default: return '';
  }
}

/**
 * Bot squad composition by member slot (bots ignore level gates): slot 0
 * Assault, 1 Medic (every squad has a reviver), 2 Engineer, 3 a flex kit from
 * BOT_FLEX_POOL picked by a stable hash of team, squad and match seed.
 */
export const BOT_SQUAD_SLOTS = Object.freeze(['assault', 'medic', 'engineer', 'flex']);
export const BOT_FLEX_POOL = Object.freeze(['support', 'support', 'recon', 'pyro', 'grenadier', 'raider', 'marksman']);

/** FNV-1a 32-bit hash used for stable bot picks. */
export function kitHash(text) {
  let h = 2166136261;
  const s = String(text);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Bot kit of a squad member slot (0-based). */
export function botSquadKit(slot, { team = '', squadId = 0, seed = 0 } = {}) {
  const role = BOT_SQUAD_SLOTS[Math.max(0, Math.trunc(slot) || 0) % BOT_SQUAD_SLOTS.length];
  if (role !== 'flex') return role;
  return BOT_FLEX_POOL[kitHash(`${team}:${squadId}:${seed}`) % BOT_FLEX_POOL.length];
}

const WEAPON_SLOT = new Map(WEAPON_IDS.map((id, index) => [id, index]));
const GRENADE_SLOT = new Map(GRENADE_TYPE_IDS.map((id, index) => [id, index]));

/** Weapons that make no gunshot report (melee); everything else auto-spots its shooter. */
export const SILENT_WEAPON_IDS = Object.freeze(WEAPON_IDS.filter(id => WEAPONS[id]?.mode === 'melee'));
const SILENT = new Set(SILENT_WEAPON_IDS);

/** True when firing `weapon` (id or slot) reveals the shooter. Unknown keys (vehicle guns) are loud. */
export function isUnsuppressedWeapon(weapon) {
  const id = typeof weapon === 'string' ? weapon
    : Number.isInteger(weapon) ? WEAPON_IDS[weapon] : null;
  return !!id && !SILENT.has(id);
}

/** Known kit id, or null. */
export function kitId(value) {
  return typeof value === 'string' && Object.hasOwn(KITS, value) ? value : null;
}

/** Kit id, falling back to assault for anything unknown. */
export function normalizeKit(value) {
  return kitId(value) ?? KIT_IDS[0];
}

/** Variant index 0 or 1; anything else is 0. */
export function normalizeVariant(value) {
  return value === 1 || value === '1' ? 1 : 0;
}

/** Gadget index into the kit's `gadgets` (0 when the kit has no such choice). */
export function normalizeGadget(kit, value) {
  const gadgets = KITS[normalizeKit(kit)].gadgets ?? [];
  const index = value === 1 || value === '1' ? 1 : 0;
  return index < gadgets.length ? index : 0;
}

/** Gadget weapon id of a kit and gadget index, or null for kits without one. */
export function kitGadget(kit, gadget = 0) {
  const def = KITS[normalizeKit(kit)];
  return def.gadgets?.[normalizeGadget(kit, gadget)] ?? def.gadget ?? null;
}

/** `cq[0]` encoding: index into KIT_IDS, -1 for none. */
export function kitIndex(value) {
  return KIT_IDS.indexOf(kitId(value));
}

/** Weapon ids of a kit, variant and gadget choice. */
export function kitWeapons(kit, variant = 0, gadgetIndex = 0) {
  const def = KITS[normalizeKit(kit)];
  const primary = def.primaries[normalizeVariant(variant)] ?? def.primaries[0];
  const gadget = kitGadget(kit, gadgetIndex);
  const owned = [...new Set([primary, gadget, KIT_SIDEARM, KIT_MELEE].filter(Boolean))];
  return { primary, gadget, sidearm: KIT_SIDEARM, melee: KIT_MELEE, owned };
}

const KIT_GADGET_IDS = new Set(Object.values(KITS).flatMap(kit => [kit.gadget, ...(kit.gadgets || [])]).filter(Boolean));

/** Kit role of one weapon id: 'primary', 'gadget', 'sidearm' or 'melee'. */
export function kitWeaponRole(id) {
  if (id === KIT_MELEE || WEAPONS[id]?.mode === 'melee') return 'melee';
  if (id === KIT_SIDEARM) return 'sidearm';
  if (KIT_GADGET_IDS.has(id) || WEAPONS[id]?.gadgetOnly) return 'gadget';
  return 'primary';
}

/**
 * Conquest number keys are kit-relative (Battlefield style): weapon slot key
 * N (`slotN`, digit N by default) raises the role at index N-1. Keys past the
 * list do nothing in Conquest.
 */
export const KIT_DIGIT_ROLES = Object.freeze(['primary', 'sidearm', 'gadget', 'melee']);

/**
 * Weapon id that kit slot key `index` (0-based: 0 = key 1) raises from the
 * authoritative owned list, or null when the kit carries nothing in that role
 * (no gadget) or the key is not a kit key.
 */
export function kitDigitWeapon(owned, index) {
  const role = Number.isInteger(index) ? KIT_DIGIT_ROLES[index] : undefined;
  if (!role || !Array.isArray(owned)) return null;
  return owned.find(id => Object.hasOwn(WEAPONS, id) && WEAPON_SLOT.has(id) && kitWeaponRole(id) === role) ?? null;
}

/** 0-based kit slot key index that raises `id` in Conquest (0 = key 1), or -1. */
export function kitWeaponDigit(id) {
  return Object.hasOwn(WEAPONS, id) ? KIT_DIGIT_ROLES.indexOf(kitWeaponRole(id)) : -1;
}

/** Roster default reserve for one weapon (spare mags, or loose rounds for tube weapons). */
function defaultReserve(id) {
  const def = WEAPONS[id];
  return Math.max(0, Math.trunc(def.spareRounds ?? def.spareMags ?? 0));
}

/** Magazine and reserve a kit issues for `id`. */
function issuedAmmo(id) {
  const override = KIT_GADGET_AMMO[id];
  return {
    mag: override?.mag ?? Math.max(0, Math.trunc(WEAPONS[id].magSize ?? 0)),
    reserve: override?.reserve ?? defaultReserve(id),
  };
}

/** Grenade counts in GRENADE_TYPE_IDS order. */
export function kitGrenades(kit) {
  const counts = GRENADE_TYPE_IDS.map(() => 0);
  for (const [type, count] of Object.entries(KITS[normalizeKit(kit)].grenades)) {
    const slot = GRENADE_SLOT.get(type);
    if (slot !== undefined) counts[slot] = Math.max(0, Math.trunc(count));
  }
  return counts;
}

/**
 * Full inventory of a fresh life on this kit. `mag` and `reserve` are indexed by
 * WEAPON_IDS and zero for every weapon the kit does not own; `grenades` by
 * GRENADE_TYPE_IDS; `weapon` is the primary's slot.
 */
export function kitLoadout(kit, variant = 0, gadget = 0) {
  const id = normalizeKit(kit);
  const v = normalizeVariant(variant);
  const g = normalizeGadget(id, gadget);
  const weapons = kitWeapons(id, v, g);
  const mag = WEAPON_IDS.map(() => 0);
  const reserve = WEAPON_IDS.map(() => 0);
  for (const weapon of weapons.owned) {
    const slot = WEAPON_SLOT.get(weapon);
    const ammo = issuedAmmo(weapon);
    mag[slot] = ammo.mag;
    reserve[slot] = ammo.reserve;
  }
  return {
    kit: id,
    variant: v,
    gadgetIndex: g,
    ...weapons,
    weapon: WEAPON_SLOT.get(weapons.primary),
    mag,
    reserve,
    grenades: kitGrenades(id),
  };
}

/** Reserve caps for resupply, indexed by WEAPON_IDS (0 for weapons the kit lacks). */
export function kitMaxReserve(kit, variant = 0, gadget = 0) {
  return kitLoadout(kit, variant, gadget).reserve;
}

/** Grenade caps for resupply, indexed by GRENADE_TYPE_IDS. */
export function kitMaxGrenades(kit) {
  return kitGrenades(kit);
}

/**
 * Reserve units that make up one magazine of `weapon`: a staged tube weapon
 * keeps loose rounds in reserve, so a magazine is `magSize` rounds; every
 * other weapon counts whole spare magazines.
 */
export function reserveUnitsPerMagazine(weapon) {
  const def = WEAPONS[weapon];
  if (!def) return 0;
  return def.reloadStages || def.spareRounds !== undefined ? Math.max(1, def.magSize | 0) : 1;
}

/**
 * Apply one resupply pulse to an inventory in place: one primary magazine of
 * reserve and one grenade of the kit's types, both capped at the kit maximums.
 * The grenade goes to the kit type with the largest deficit (kit order breaks
 * ties). With `gadgetRound` the kit gadget (AT rocket or STINGER) also gets one
 * round back toward its issued total (magazine plus reserve). Returns what was
 * given; `{reserve:0, grenade:null, gadget:0}` means nothing.
 */
export function applyResupply(inventory, kit, variant = 0, gadget = 0, { gadgetRound = false } = {}) {
  const loadout = kitLoadout(kit, variant, gadget);
  const result = { reserve: 0, grenade: null, gadget: 0 };
  if (gadgetRound && loadout.gadget && Array.isArray(inventory?.reserve) && Array.isArray(inventory?.mag)) {
    const gslot = WEAPON_SLOT.get(loadout.gadget);
    const held = Math.max(0, Math.trunc(Number(inventory.mag[gslot]) || 0)) + Math.max(0, Math.trunc(Number(inventory.reserve[gslot]) || 0));
    if (held < loadout.mag[gslot] + loadout.reserve[gslot]) {
      inventory.reserve[gslot] = Math.max(0, Math.trunc(Number(inventory.reserve[gslot]) || 0)) + 1;
      result.gadget = 1;
    }
  }
  const slot = loadout.weapon;
  if (Array.isArray(inventory?.reserve)) {
    const current = Math.max(0, Math.trunc(Number(inventory.reserve[slot]) || 0));
    const cap = loadout.reserve[slot];
    const next = Math.min(cap, current + reserveUnitsPerMagazine(loadout.primary));
    if (next > current) {
      inventory.reserve[slot] = next;
      result.reserve = next - current;
    }
  }
  if (Array.isArray(inventory?.grenades)) {
    let best = -1;
    let bestDeficit = 0;
    for (const type of Object.keys(KITS[loadout.kit].grenades)) {
      const index = GRENADE_SLOT.get(type);
      if (index === undefined) continue;
      const deficit = loadout.grenades[index] - Math.max(0, Math.trunc(Number(inventory.grenades[index]) || 0));
      if (deficit > bestDeficit) { best = index; bestDeficit = deficit; }
    }
    if (best >= 0) {
      inventory.grenades[best] = Math.max(0, Math.trunc(Number(inventory.grenades[best]) || 0)) + 1;
      result.grenade = GRENADE_TYPE_IDS[best];
    }
  }
  return result;
}

/** Deploy-screen rows (KIT_MENU_ORDER): id, label, ability, unlock level, the two variant primaries and the gadget choices. */
export const KIT_MENU = Object.freeze(KIT_MENU_ORDER.map(id => Object.freeze({
  id,
  label: KITS[id].label,
  ability: KITS[id].ability,
  abilityLabel: KIT_ABILITY_LABELS[KITS[id].ability] ?? KITS[id].ability.toUpperCase(),
  unlockLevel: kitUnlockLevel(id),
  variants: Object.freeze(KITS[id].primaries.map(primary => Object.freeze({
    primary, name: WEAPONS[primary]?.name ?? primary.toUpperCase(),
  }))),
  gadget: KITS[id].gadget,
  gadgets: Object.freeze((KITS[id].gadgets ?? []).map(gadget => Object.freeze({
    gadget, name: WEAPONS[gadget]?.name ?? gadget.toUpperCase(), ...KIT_GADGET_LABELS[gadget],
  }))),
  grenades: Object.freeze({ ...KITS[id].grenades }),
})));
