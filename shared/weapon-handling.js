// Four independently tunable handling metrics. Angles are degrees, sway rate is Hz.
// No renderer, clock or network dependency.
export const HANDLING_LIMITS = Object.freeze({
  ergonomics: Object.freeze([0, 100]),
  swayAmplitudeDeg: Object.freeze([0, 1.5]),
  swayFrequencyHz: Object.freeze([0.05, 2]),
  verticalRecoil: Object.freeze([0, 8]),
  horizontalRecoil: Object.freeze([0, 4]),
});
const profile = (ergonomics, amplitudeDeg, frequencyHz) => Object.freeze({
  ergonomics, sway: Object.freeze({ amplitudeDeg, frequencyHz }),
});
export const WEAPON_HANDLING_PROFILES = Object.freeze({
  rifle: profile(70, 0.16, 0.24), smg: profile(95, 0.20, 0.38),
  shotgun: profile(58, 0.17, 0.22), sniper: profile(38, 0.18, 0.12),
  lmg: profile(24, 0.12, 0.14), revolver: profile(88, 0.24, 0.40),
  longarc: profile(44, 0.16, 0.20), rocket: profile(12, 0.22, 0.12),
  lance: profile(34, 0.16, 0.16), knife: profile(100, 0.08, 0.50),
  minigun: profile(8, 0.10, 0.10), flamethrower: profile(28, 0.18, 0.17),
});
const DEFAULT_HANDLING = Object.freeze({
  ...WEAPON_HANDLING_PROFILES.rifle, verticalRecoil: 0.68, horizontalRecoil: 0.32,
});
function bounded(value, limits, fallback) {
  return Number.isFinite(value) ? Math.max(limits[0], Math.min(limits[1], value)) : fallback;
}
/** Partial future attachment modifiers can use this without mutating the base weapon. */
export function normalizeWeaponHandling(value, fallback = DEFAULT_HANDLING) {
  return Object.freeze({
    ergonomics: bounded(value?.ergonomics, HANDLING_LIMITS.ergonomics, fallback.ergonomics),
    sway: Object.freeze({
      amplitudeDeg: bounded(value?.sway?.amplitudeDeg, HANDLING_LIMITS.swayAmplitudeDeg, fallback.sway.amplitudeDeg),
      frequencyHz: bounded(value?.sway?.frequencyHz, HANDLING_LIMITS.swayFrequencyHz, fallback.sway.frequencyHz),
    }),
    verticalRecoil: bounded(value?.verticalRecoil, HANDLING_LIMITS.verticalRecoil, fallback.verticalRecoil),
    horizontalRecoil: bounded(value?.horizontalRecoil, HANDLING_LIMITS.horizontalRecoil, fallback.horizontalRecoil),
  });
}
/** Resolve the four metrics and existing recoil implementation together. */
export function withWeaponHandling(def, changes = {}) {
  const baseRecoil = def.handlingBaseRecoil || Object.freeze({ ...def.recoil });
  const fallback = def.handling || normalizeWeaponHandling({
    ...(WEAPON_HANDLING_PROFILES[def.id] || WEAPON_HANDLING_PROFILES.rifle),
    verticalRecoil: def.mode === 'melee' ? 0 : def.recoil.pitch,
    horizontalRecoil: def.mode === 'melee' ? 0 : def.recoil.yaw,
  });
  const handling = normalizeWeaponHandling(changes, fallback);
  return { ...def, handling, handlingBaseRecoil: baseRecoil, recoil: { ...def.recoil,
    pitch: def.mode === 'melee' ? def.recoil.pitch : handling.verticalRecoil,
    yaw: def.mode === 'melee' ? def.recoil.yaw : handling.horizontalRecoil,
    pitchRamp: def.mode === 'melee' ? baseRecoil.pitchRamp : baseRecoil.pitch > 0 ? baseRecoil.pitchRamp * handling.verticalRecoil / baseRecoil.pitch : 0,
    maxPitchRamp: def.mode === 'melee' ? baseRecoil.maxPitchRamp : baseRecoil.pitch > 0 ? baseRecoil.maxPitchRamp * handling.verticalRecoil / baseRecoil.pitch : 0,
  } };
}
/** ADS improves settling but never increases the turn-speed ceiling. */
export function weaponTurnProfile(handling = DEFAULT_HANDLING, ads = 0) {
  const e = bounded(handling?.ergonomics, HANDLING_LIMITS.ergonomics, 70) / 100;
  const aim = Math.max(0, Math.min(1, Number(ads) || 0));
  const d2r = Math.PI / 180;
  return { maxSpeed: (45 + 675 * e ** 1.6) * d2r,
    maxAcceleration: (180 + 5220 * e ** 1.6) * d2r,
    frequency: (5 + 17 * e) * (1 + aim * 0.12), dampingRatio: 1 };
}
/** Smooth bounded wander, independent of camera FOV. */
export function sampleWeaponSway(sway, seconds, out = {}) {
  const amplitude = bounded(sway?.amplitudeDeg, HANDLING_LIMITS.swayAmplitudeDeg, 0.16) * Math.PI / 180;
  const hz = bounded(sway?.frequencyHz, HANDLING_LIMITS.swayFrequencyHz, 0.24);
  const t = (Number.isFinite(seconds) ? seconds : 0) * hz * 2 * Math.PI;
  out.yaw = amplitude * (Math.sin(t) * 0.70 + Math.sin(t * 0.395 + 1.7) * 0.30);
  out.pitch = amplitude * (Math.sin(t * 1.202 + 0.8) * 0.70 + Math.sin(t * 0.513 + 2.4) * 0.30);
  return out;
}
export const HANDLING_EXTREMES = Object.freeze({
  heavy: normalizeWeaponHandling({ ergonomics: 0, sway: { amplitudeDeg: 0.10, frequencyHz: 0.05 } }),
  nimble: normalizeWeaponHandling({ ergonomics: 100, sway: { amplitudeDeg: 0.24, frequencyHz: 0.50 } }),
});
