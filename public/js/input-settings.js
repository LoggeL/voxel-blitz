export const MOUSE_SENSITIVITY = Object.freeze({
  min: 0.005,
  max: 0.08,
  default: 0.01,
});

export function clampMouseSensitivity(value, fallback = MOUSE_SENSITIVITY.default) {
  const parsed = Number(value);
  const resolved = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(MOUSE_SENSITIVITY.max, Math.max(MOUSE_SENSITIVITY.min, resolved));
}
