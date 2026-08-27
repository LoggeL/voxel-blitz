function reportFailure(message) {
  console.error('FAIL ' + message);
}

export function ok(condition, message, onFailure = reportFailure, onSuccess) {
  if (condition) {
    onSuccess?.(message);
    return true;
  }
  onFailure(message);
  return false;
}

export function pass(condition, name, detail = '', onSuccess) {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
  onSuccess?.(name);
  return true;
}

export function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export const vectorNorm = (value) => Array.isArray(value) ? Math.hypot(...value) : 0;

export const nearly = (actual, expected, tolerance = 1e-12) =>
  Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function sameValue(actual, expected) {
  if (Object.is(actual, expected)) return true;
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object')
    return false;
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, i) =>
      key === expectedKeys[i] && sameValue(actual[key], expected[key]));
}

export const deeplyFrozen = (value) => !value || typeof value !== 'object'
  || (Object.isFrozen(value) && Object.values(value).every(deeplyFrozen));

export function fnv1a(bytes) {
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
