// Mouse-look sensitivity contract, radians of yaw/pitch per pointer-lock pixel.
//
// The default turns a full 360° in roughly 2100 px of mouse travel (about 0.17°/px),
// which sits inside the range most shooters ship (0.02–0.4°/px). The previous scale
// (default 0.010, max 0.080) turned a full circle in ~630 px and had no ADS
// compensation, so the storage key is versioned: stale values from the old scale
// are ignored instead of being clamped to the new maximum.
export const MOUSE_SENSITIVITY = Object.freeze({
  min: 0.0008,
  max: 0.012,
  default: 0.003,
  /** Slider resolution; the UI shows the value ×1000 with one decimal. */
  step: 0.0001,
  /** Multiplier applied to the stored value for display and aria text. */
  displayScale: 1000,
});

/** localStorage key for the persisted preference (versioned with the scale above). */
export const SENSITIVITY_PREF_KEY = 'vb-sens-v2';

export function clampMouseSensitivity(value, fallback = MOUSE_SENSITIVITY.default) {
  const parsed = Number(value);
  const resolved = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(MOUSE_SENSITIVITY.max, Math.max(MOUSE_SENSITIVITY.min, resolved));
}

/** Human-readable slider label for a sensitivity value ("3.0" for the default). */
export function formatMouseSensitivity(value) {
  return (clampMouseSensitivity(value) * MOUSE_SENSITIVITY.displayScale).toFixed(1);
}

/**
 * Look-input multiplier while aiming down sights. Uses the "focal length" rule:
 * the on-screen distance a target moves per pixel of mouse travel stays constant
 * across zoom levels, so a 5x scope does not become five times as twitchy.
 * Both FOVs are vertical degrees. Returns 1 when zoom is absent or invalid.
 */
export function adsLookScale(liveFovDeg, baseFovDeg) {
  const live = Number(liveFovDeg);
  const base = Number(baseFovDeg);
  if (!(live > 0) || !(base > 0) || live >= 180 || base >= 180) return 1;
  const ratio = Math.tan((live * Math.PI) / 360) / Math.tan((base * Math.PI) / 360);
  return Math.min(1, Math.max(0.08, ratio));
}
