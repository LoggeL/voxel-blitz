// Shared timed stance contract for prediction, authority, and presentation.
export const PRONE = Object.freeze({ downS: 0.65, upS: 0.8, speed: 1.15, eye: 0.48, height: 0.75 });
export function stepProne(value = 0, target, dt) {
  const step = Math.max(0, dt) / (target ? PRONE.downS : PRONE.upS);
  return target ? Math.min(1, value + step) : Math.max(0, value - step);
}
export function pronePose(value = 0) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}
export function stanceEye(standingEye, crouching, value) {
  const upright = standingEye * (crouching ? 0.58 : 1);
  return upright + (PRONE.eye - upright) * pronePose(value);
}
export function stanceHeight(standingHeight, value = 0) {
  return standingHeight + (PRONE.height - standingHeight) * pronePose(value);
}
