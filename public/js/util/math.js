export function nowMs() {
  return performance.now();
}

export function easeOut(t) {
  return 1 - Math.pow(1 - t, 3);
}

export function clamp01(v) {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
}

export function clampPitch(value) {
  const limit = (80 * Math.PI) / 180;
  return Math.max(-limit, Math.min(limit, Number.isFinite(value) ? value : 0));
}

export function smooth01(v) {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
}
