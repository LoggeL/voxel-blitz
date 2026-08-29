/** Shared client/server contract for charge-to-distance grenade throws. */
export const GRENADE_PER_LIFE = 2;
export const GRENADE_CHARGE_MS = 1200;
export const GRENADE_MIN_THROW_SPEED = 7;
export const GRENADE_MAX_THROW_SPEED = 16;
export const GRENADE_MIN_LIFT = 2.1;
export const GRENADE_MAX_LIFT = 3.5;

export function clampGrenadeCharge(value) {
  const charge = Number(value);
  return Number.isFinite(charge) ? Math.max(0, Math.min(1, charge)) : 0;
}

export function grenadeThrowProfile(value) {
  const charge = clampGrenadeCharge(value);
  return Object.freeze({
    charge,
    speed: GRENADE_MIN_THROW_SPEED
      + (GRENADE_MAX_THROW_SPEED - GRENADE_MIN_THROW_SPEED) * charge,
    lift: GRENADE_MIN_LIFT + (GRENADE_MAX_LIFT - GRENADE_MIN_LIFT) * charge,
  });
}
