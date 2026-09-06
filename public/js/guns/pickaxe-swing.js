export const PICKAXE_SWING_SECONDS = 0.46;
const smooth = (v) => { const t = Math.max(0, Math.min(1, v)); return t * t * (3 - 2 * t); };

/** Overhead lift, sharp downward chop, then return around the gripping hand. */
export function pickaxeSwingPose(progress) {
  const lift = smooth(progress / 0.34);
  const strike = smooth((progress - 0.34) / 0.24);
  const recover = 1 - smooth((progress - 0.62) / 0.38);
  const wind = lift * (1 - strike);
  const rx = (1.0 * wind - 0.48 * strike) * recover;
  const gy = -0.225, gz = -0.035;
  return {
    x: -0.025 * strike * recover,
    y: (0.18 * wind + 0.08 * strike) * recover + gy - (gy * Math.cos(rx) - gz * Math.sin(rx)),
    z: (-0.08 * wind - 0.08 * strike) * recover + gz - (gy * Math.sin(rx) + gz * Math.cos(rx)),
    rx, ry: 0, rz: -0.035 * wind * recover,
  };
}
