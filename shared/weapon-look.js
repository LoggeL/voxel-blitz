import { weaponTurnProfile } from './weapon-handling.js';
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
/** Mouse movement beyond the carry envelope is discarded, never queued up to
 * rotate the player after they stop moving the mouse. Translation is unaffected. */
export function constrainWeaponLook(dt, { yaw, pitch, previousYaw, previousPitch,
  weaponYaw = previousYaw, weaponPitch = previousPitch, yawVelocity = 0, pitchVelocity = 0, handling, ads = 0 }) {
  const profile = weaponTurnProfile(handling, ads);
  const step = Number.isFinite(dt) ? clamp(dt, 0, 0.25) : 0;
  let dy = yaw - previousYaw, dp = pitch - previousPitch;
  const inputSize = Math.hypot(dy, dp), limit = profile.maxSpeed * 1.15 * step;
  if (inputSize > limit) { dy *= limit / inputSize; dp *= limit / inputSize; }
  let nextYaw = previousYaw + dy, nextPitch = clamp(previousPitch + dp, -1.56, 1.56);
  const e = clamp(Number(handling?.ergonomics ?? 70), 0, 100) / 100;
  const envelope = (24 - e * 12) * (1 - clamp(ads, 0, 1) * 0.35) * Math.PI / 180;
  // Account for the weapon motion in this frame, avoiding a one-frame carry delay.
  const lagYaw = wrap(nextYaw - weaponYaw - yawVelocity * step), lagPitch = nextPitch - weaponPitch - pitchVelocity * step;
  const lag = Math.hypot(lagYaw, lagPitch);
  if (lag > envelope) {
    const scale = envelope / lag;
    nextYaw -= lagYaw * (1 - scale); nextPitch -= lagPitch * (1 - scale);
  }
  // A render hitch must never allow the camera to escape the carry cone.
  const hardYaw = wrap(nextYaw - weaponYaw), hardPitch = nextPitch - weaponPitch;
  const hardLag = Math.hypot(hardYaw, hardPitch), hardLimit = 35 * Math.PI / 180;
  if (hardLag > hardLimit) {
    nextYaw -= hardYaw * (1 - hardLimit / hardLag);
    nextPitch -= hardPitch * (1 - hardLimit / hardLag);
  }
  return { yaw: nextYaw, pitch: clamp(nextPitch, -1.56, 1.56), maxSpeed: profile.maxSpeed * 1.15, envelope };
}
