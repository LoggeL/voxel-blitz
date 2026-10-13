// Cosmetic handling only. The action clock, ammunition and contact callbacks
// keep their canonical times; these curves change the route between contacts.
const clamp01 = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

export function handlingStress({ panic = 0, pain = 0, reducedMotion = false } = {}) {
  return reducedMotion ? 0 : clamp01(clamp01(panic) * 0.85 + clamp01(pain) * 0.55);
}

/** A stable choice for one action, independent of frame count and gameplay RNG. */
export function handlingVariant(sequence) {
  let n = Math.imul((sequence | 0) ^ 0x45d9f3b, 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 0xffffffff;
}

/** Slow the reach, then catch up before contact. Monotonic, with fixed endpoints. */
export function hesitantProgress(progress, stress, variant = 0.5) {
  const t = clamp01(progress);
  if (t === 0 || t === 1 || !stress) return t;
  return t - Math.sin(Math.PI * t) ** 2 * (0.19 + 0.07 * variant) * stress;
}

function pulse(t, from, to, variant) {
  if (t <= from || t >= to) return 0;
  const u = (t - from) / (to - from);
  // Unequal forward and return strokes read as a deliberate second grip.
  const peak = 0.40 + variant * 0.15;
  const p = u < peak ? u / peak : (1 - u) / (1 - peak);
  return p * p * (3 - 2 * p);
}

/** Small regrips land before the actual seating/closing contacts, never on them. */
export function reloadGripBeat(frac, elapsed, reload, timeline, variant) {
  if (reload.type === 'tube' && reload.stages) {
    const { start, perRound, rounds } = reload.stages;
    const roundTime = (elapsed - start) / perRound;
    if (roundTime < 0 || roundTime >= rounds) return 0;
    return pulse(roundTime % 1, 0.12, 0.78, variant);
  }
  // The revolver's speedloader seats at .68; its timeline.home is the later
  // closing movement. Keep its hand adjustment ahead of the actual load.
  const home = reload.type === 'cylinder' ? 0.68 : timeline.home;
  const reach = pulse(frac, 0.025, Math.max(0.06, timeline.start - 0.015), variant);
  const align = pulse(frac, Math.max(timeline.start, home - 0.20), home - 0.025, variant);
  return Math.max(reach * 0.7, align);
}

export function addHandlingPose(out, progress, stress, pain, variant, grip, cycle = false) {
  if (progress <= 0 || progress >= 1) return;
  const envelope = Math.sin(Math.PI * clamp01(progress)) ** 2;
  const guarded = clamp01(pain) * envelope * (stress > 0 ? 1 : 0);
  const adjust = grip * stress;
  const side = variant < 0.5 ? -1 : 1;
  const size = cycle ? 0.55 : 1;
  out.dip += size * (0.010 * adjust + 0.008 * guarded);
  out.rock += size * (0.038 * adjust + 0.025 * guarded);
  out.x += size * side * 0.012 * adjust;
  out.push += size * (0.022 * adjust + 0.010 * guarded);
  out.yaw += size * side * 0.024 * adjust;
  out.roll += size * side * 0.040 * adjust;
}
