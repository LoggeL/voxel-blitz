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
  const limit = Math.PI / 2 - 0.01;
  return Math.max(-limit, Math.min(limit, Number.isFinite(value) ? value : 0));
}

export function smooth01(v) {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
}

export function clampNumber(value, min, max, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

export function readStoredNumber(key, fallback, min, max) {
  try {
    return clampNumber(localStorage.getItem(key), min, max, fallback);
  } catch (_) {
    return fallback;
  }
}
