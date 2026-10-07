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
  /** Assault revive reach, reviver feet to body feet (m). */
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
});

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

/** Deploy-screen rows: id, label, ability, the two variant primaries and the gadget choices. */
export const KIT_MENU = Object.freeze(KIT_IDS.map(id => Object.freeze({
  id,
  label: KITS[id].label,
  ability: KITS[id].ability,
  variants: Object.freeze(KITS[id].primaries.map(primary => Object.freeze({
    primary, name: WEAPONS[primary]?.name ?? primary.toUpperCase(),
  }))),
  gadget: KITS[id].gadget,
  gadgets: Object.freeze((KITS[id].gadgets ?? []).map(gadget => Object.freeze({
    gadget, name: WEAPONS[gadget]?.name ?? gadget.toUpperCase(), ...KIT_GADGET_LABELS[gadget],
  }))),
  grenades: Object.freeze({ ...KITS[id].grenades }),
})));
