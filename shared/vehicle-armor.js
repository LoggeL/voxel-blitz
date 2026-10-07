/** Armour class x damage class matrix and facing zones (spec §5.3). Pure data
 * plus the lookups the authoritative damage path and the HUD share. */
import { ARMOR_CLASSES, DAMAGE_CLASSES, HIT_ZONES } from './conquest-contract.js';

/** Multiplier per damage class (rows) and armour class (columns). */
export const ARMOR_MATRIX = Object.freeze({
  small:      Object.freeze({ light: 0.2, heavy: 0,    air: 0.08 }),
  mg:         Object.freeze({ light: 0.6, heavy: 0,    air: 0.3 }),
  hmg:        Object.freeze({ light: 1,   heavy: 0.03, air: 0.6 }),
  autocannon: Object.freeze({ light: 1,   heavy: 0.12, air: 1 }),
  explosive:  Object.freeze({ light: 0.8, heavy: 0.12, air: 0.5 }),
  he:         Object.freeze({ light: 1,   heavy: 0.35, air: 1 }),
  at:         Object.freeze({ light: 1,   heavy: 1,    air: 0.8 }),
  aa:         Object.freeze({ light: 0.3, heavy: 0.1,  air: 1 }),
  // Fire is a damage-per-second dose, scaled by this factor.
  fire:       Object.freeze({ light: 0.3, heavy: 0,    air: 0 }),
});

/** Heavy-armour facing multipliers. Only the AT cell of the heavy column uses them. */
export const HEAVY_ZONE_MULTIPLIERS = Object.freeze({ front: 0.75, side: 1, rear: 1.5, top: 1.3, bottom: 1.5 });
/** Damage classes whose heavy-armour multiplier is scaled by the facing zone. */
export const ZONED_HEAVY_CLASSES = Object.freeze(['at']);
/** A multiplier at or above this counts as effective (`vehicle_hit.eff`). */
export const ARMOR_EFFECTIVE_THRESHOLD = 0.1;
/** Exposed (open) seat occupants take this share of infantry damage. */
export const EXPOSED_CREW_DAMAGE = 0.8;
/** Internal classes that bypass the matrix: collisions, falls and void. */
export const PHYSICAL_DAMAGE_CLASSES = Object.freeze(['collision']);

/** Infantry weapon id -> damage class when its definition carries none. */
export const INFANTRY_DAMAGE_CLASSES = Object.freeze({
  lmg: 'mg', minigun: 'mg',
  rocket: 'at', stinger: 'aa',
  mgl: 'explosive', frag: 'explosive', limpet: 'explosive', pulse: 'explosive', bubble: 'explosive',
  flamethrower: 'fire', molotov: 'fire',
});

export const isDamageClass = cls => DAMAGE_CLASSES.includes(cls);
export const isArmorClass = armor => ARMOR_CLASSES.includes(armor);

/** The class an infantry weapon or blast deals: explicit def class, table, then small arms. */
export function infantryDamageClass(defOrId) {
  const explicit = typeof defOrId === 'object' ? defOrId?.damageClass : null;
  if (isDamageClass(explicit)) return explicit;
  const id = typeof defOrId === 'object' ? defOrId?.id : defOrId;
  return INFANTRY_DAMAGE_CLASSES[id] ?? 'small';
}

/** Final multiplier for one hit. Unknown classes deal nothing; physical damage passes. */
export function armorMultiplier(cls, armor, zone = 'side') {
  if (PHYSICAL_DAMAGE_CLASSES.includes(cls)) return 1;
  const row = ARMOR_MATRIX[cls];
  if (!row || !isArmorClass(armor)) return 0;
  const base = row[armor];
  if (armor === 'heavy' && ZONED_HEAVY_CLASSES.includes(cls)) return base * (HEAVY_ZONE_MULTIPLIERS[zone] ?? 1);
  return base;
}

export const armorEffective = multiplier => multiplier >= ARMOR_EFFECTIVE_THRESHOLD;

/**
 * Classify a hull-local point into a facing zone. Local axes follow the
 * renderer: +X right, +Y up, forward is -Z. `half` = [halfWidth, halfHeight,
 * halfLength] and `centerY` is the local height of the box centre. The face
 * whose normalised coordinate dominates wins; the hull's deck and belly only
 * win when they clearly dominate, so glancing side hits stay side hits.
 */
export function classifyHitZone(local, half, centerY = half[1]) {
  const nx = local[0] / Math.max(1e-6, half[0]);
  const ny = (local[1] - centerY) / Math.max(1e-6, half[1]);
  const nz = local[2] / Math.max(1e-6, half[2]);
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  if (ay >= 0.9 && ay > ax && ay > az) return ny > 0 ? 'top' : 'bottom';
  if (az >= ax) return nz < 0 ? 'front' : 'rear';
  return 'side';
}

export const HIT_ZONE_IDS = HIT_ZONES;
