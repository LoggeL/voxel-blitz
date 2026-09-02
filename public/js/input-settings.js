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

/* ------------------------------------------------------------------ device options */

/** localStorage keys for the device-specific input preferences (all optional). */
export const INPUT_PREF_KEYS = Object.freeze({
  adsMode: 'vb-ads-mode',           // 'hold' | 'toggle' | '' (auto: toggle on trackpads)
  pointerMode: 'vb-pointer-mode',   // 'auto' | 'mouse' | 'trackpad'
  padSensitivity: 'vb-pad-sens',    // radians per second at full stick deflection
  touchSensitivity: 'vb-touch-sens',// multiplier on the touch look scale
  touchSize: 'vb-touch-size',       // 'small' | 'medium' | 'large'
  touchHand: 'vb-touch-hand',       // 'right' | 'left'
  aimAssist: 'vb-aim-assist',       // '1' | '0' (pad and touch only)
});

export const ADS_MODES = Object.freeze(['hold', 'toggle']);
export const POINTER_MODES = Object.freeze(['auto', 'mouse', 'trackpad']);
export const TOUCH_SIZES = Object.freeze(['small', 'medium', 'large']);
export const TOUCH_HANDS = Object.freeze(['right', 'left']);

/**
 * Trackpads travel a few centimetres per swipe and the OS hands pointer lock small,
 * heavily accelerated deltas, so trackpad look runs hotter than the mouse scale.
 */
export const TRACKPAD_LOOK_SCALE = 2.4;
/** Fraction of pending trackpad motion released per frame (mild jitter filter). */
export const TRACKPAD_SMOOTHING = 0.72;

export const PAD_SENSITIVITY = Object.freeze({
  min: 0.6, max: 4.5, default: 2.1, step: 0.1,
});
export const TOUCH_SENSITIVITY = Object.freeze({
  min: 0.5, max: 2.5, default: 1, step: 0.05,
});

/**
 * Wheel-to-weapon-switch policy. Mouse wheels arrive as discrete notches (line mode or
 * ±100/120 px); trackpads stream many tiny pixel deltas, which used to cycle through
 * several weapons per swipe. Pixel deltas now accumulate to a notch and switches are
 * rate limited, so one two-finger flick is one weapon step on every device.
 */
export const WHEEL_SWITCH = Object.freeze({
  notchPx: 48,
  cooldownMs: 120,
  /** Pixel-mode deltas at or below this magnitude are trackpad evidence. */
  trackpadDeltaPx: 40,
  /** Wheel events needed before a trackpad is assumed (auto pointer mode). */
  trackpadEvidence: 3,
});

export function normalizeChoice(value, choices, fallback) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return choices.includes(text) ? text : fallback;
}

export function clampPadSensitivity(value, fallback = PAD_SENSITIVITY.default) {
  const parsed = Number(value);
  const resolved = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(PAD_SENSITIVITY.max, Math.max(PAD_SENSITIVITY.min, resolved));
}

export function clampTouchSensitivity(value, fallback = TOUCH_SENSITIVITY.default) {
  const parsed = Number(value);
  const resolved = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(TOUCH_SENSITIVITY.max, Math.max(TOUCH_SENSITIVITY.min, resolved));
}

/**
 * Feed one wheel event into an accumulator `{acc, lastAt}`; returns -1, 0, or +1 weapon
 * steps. Line/page deltas are whole notches; pixel deltas accumulate to `notchPx`.
 * Direction reversals reset the accumulator so a jittery trackpad never double-steps.
 */
export function wheelSwitchStep(state, { deltaY = 0, deltaMode = 0 } = {}, now = 0) {
  const delta = Number(deltaY) || 0;
  if (delta === 0) return 0;
  const sign = delta > 0 ? 1 : -1;
  const pixelMode = deltaMode === 0;
  const notch = pixelMode ? WHEEL_SWITCH.notchPx : 1;
  if (Math.sign(state.acc) !== sign) state.acc = 0;
  state.acc += pixelMode ? delta : sign;
  if (Math.abs(state.acc) < notch) return 0;
  if (now - (state.lastAt || -Infinity) < WHEEL_SWITCH.cooldownMs) {
    // Inside the cooldown the accumulated travel is spent, not banked.
    state.acc = 0;
    return 0;
  }
  state.acc = 0;
  state.lastAt = now;
  return sign;
}
