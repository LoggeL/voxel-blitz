export const PICKAXE_CARRY_YAW = 0.38;
export const PICKAXE_CARRY_ROLL = -0.20;
export const PICKAXE_SWING_SECONDS = 0.46;
const smooth = (v) => { const t = Math.max(0, Math.min(1, v)); return t * t * (3 - 2 * t); };

/** Canted lift, inward diagonal chop, then return around the gripping hand. */
export function pickaxeSwingPose(progress, contact = false) {
  // Keep the head high through anticipation, accelerate into the face, then
  // let the wrist absorb contact before easing back into the next swing.
  const lift = smooth(progress / 0.34);
  const strike = smooth((progress - 0.34) / 0.18);
  const recover = 1 - smooth((progress - 0.68) / 0.32);
  const wind = lift * (1 - strike);
  const recoil = contact ? Math.sin(Math.PI * smooth((progress - 0.56) / 0.22)) : 0;
  const rx = (1.12 * wind - 0.58 * strike + 0.20 * recoil) * recover;
  const gy = -0.225, gz = -0.035;
  return {
    x: (0.025 * wind - 0.075 * strike) * recover,
    y: (0.20 * wind + 0.19 * strike + 0.025 * recoil) * recover + gy - (gy * Math.cos(rx) - gz * Math.sin(rx)),
    z: (-0.06 * wind - 0.14 * strike + 0.045 * recoil) * recover + gz - (gy * Math.sin(rx) + gz * Math.cos(rx)),
    rx, ry: (0.12 * wind - 0.16 * strike) * recover,
    rz: (-0.07 * wind + 0.14 * strike) * recover,
  };
}
