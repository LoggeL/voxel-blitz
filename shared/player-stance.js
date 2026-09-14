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

/**
 * Swimming presentation contract. `swimming` is an authoritative snapshot flag,
 * but the combat hitboxes keep the upright stance (lag-compensated shots replay
 * poses without the flag), so every angle here is sized to stay inside the
 * standing zone envelope: the head never leaves its authoritative target, the
 * torso pitches about its own centre, and the legs trail no further than the
 * gait-widened leg boxes cover at swim speed.
 */
export const SWIM = Object.freeze({
  speed: 2.6,        // moveSpeed that counts as a full stroke cycle (SWIM_RULES.speed)
  blendIn: 6,        // 1/s, ~0.5 s to settle into the water
  blendOut: 8,       // 1/s, faster recovery when leaving the water
  treadRate: 2.4,    // rad/s idle scull/tread cycle (~2.6 s period)
  strokeRate: 3.4,   // extra rad/s at full swim speed (~1.1 s stroke period)
  torsoPitch: 0.34,  // rad forward lean at full speed (head stays put)
  torsoTread: 0.08,  // rad resting lean while treading
  hipsPitch: 0.20,
  legTrail: 0.18,    // rad legs trail behind at full speed
  kneeFlex: 0.02,    // rad heel lift while treading (leg boxes are unwidened at rest)
  strokeFlex: 0.10,  // rad extra heel lift at full speed
  kick: 0.07,        // rad alternating flutter-kick amplitude at full speed
  treadKick: 0.02,   // rad alternating tread amplitude when stationary
  headTilt: 0.26,    // rad chin-up at full speed
  bob: 0.014,        // m vertical body bob while treading
  weaponDip: 0.035,  // m the carried weapon drops toward the water
  weaponPitch: 0.07, // rad muzzle dip of the carried weapon
  weaponRoll: 0.05,  // rad outward cant of the carried weapon
  sway: 0.008,       // m stroke sway of the carried weapon
});
/** Smooth 0..1 swim weight; `floating` is swimming while not grounded (wading walks). */
export function stepSwim(value = 0, floating, dt) {
  const rate = floating ? SWIM.blendIn : SWIM.blendOut;
  const blend = dt > 0 ? 1 - Math.exp(-rate * Math.max(0, dt)) : 1;
  return value + ((floating ? 1 : 0) - value) * blend;
}
/** 0..1 stroke effort from horizontal speed. */
export function swimEffort(moveSpeed = 0) {
  return Math.max(0, Math.min(1, (Number(moveSpeed) || 0) / SWIM.speed));
}
/** Cycle offsets shared by the third-person and first-person bodies. */
export function swimCycle(phase, effort, weight = 1) {
  const s = Math.max(0, Math.min(1, weight));
  const m = Math.max(0, Math.min(1, effort));
  const wave = Math.sin(phase);
  return {
    weight: s,
    effort: m,
    torsoPitch: (SWIM.torsoTread + (SWIM.torsoPitch - SWIM.torsoTread) * m + wave * 0.02 * (1 - m)) * s,
    hipsPitch: SWIM.hipsPitch * m * s,
    legTrail: SWIM.legTrail * m * s,
    kick: (SWIM.treadKick + (SWIM.kick - SWIM.treadKick) * m) * wave * s,
    kneeFlex: (SWIM.kneeFlex + SWIM.strokeFlex * m) * s,
    headTilt: SWIM.headTilt * m * s,
    bob: SWIM.bob * (1 - m * 0.5) * wave * s,
    sway: wave * s,
    stroke: (0.5 + 0.5 * m) * s,
  };
}
