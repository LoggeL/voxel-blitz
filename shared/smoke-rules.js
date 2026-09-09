/** Shared optical volume. Smoke changes visibility, never bullet collision. */
export const SMOKE = Object.freeze({ radius: 4, durationMs: 12000, growMs: 900,
  fadeMs: 2000, density: 1.1, maxFields: 8, blockedDepth: 0.75 });

export function smokeProfile(level = 0) {
  return { radius: level >= 3 ? 6 : level >= 1 ? 5 : SMOKE.radius,
    durationMs: level >= 2 ? 16000 : SMOKE.durationMs };
}

export function smokeShape(field, now) {
  const age = now - field.createdAt;
  const life = Math.max(0, Math.min(1, age / SMOKE.growMs,
    (field.expiresAt - now) / SMOKE.fadeMs));
  return { radius: field.radius * Math.min(1, Math.max(0, age / SMOKE.growMs)) ** 0.5,
    density: SMOKE.density * life };
}

export function smokeOpticalDepth(fields, from, to, now) {
  const d = to.map((v, i) => v - from[i]);
  const length = Math.hypot(...d);
  if (!(length > 0)) return 0;
  for (let i = 0; i < 3; i++) d[i] /= length;
  let depth = 0;
  for (const field of fields || []) {
    const { radius, density } = smokeShape(field, now);
    if (!(density > 0 && radius > 0)) continue;
    const offset = [from[0] - field.x, from[1] - field.y, from[2] - field.z];
    const b = offset.reduce((sum, v, i) => sum + v * d[i], 0);
    const disc = b * b - offset.reduce((sum, v) => sum + v * v, 0) + radius * radius;
    if (disc <= 0) continue;
    const root = Math.sqrt(disc);
    depth += Math.max(0, Math.min(length, -b + root) - Math.max(0, -b - root)) * density;
  }
  return depth;
}

export function smokeBlocksSight(fields, from, to, now) {
  return smokeOpticalDepth(fields, from, to, now) >= SMOKE.blockedDepth;
}

export function copySmokeFields(fields) {
  return (Array.isArray(fields) ? fields : []).filter(f => f && typeof f.id === 'string'
    && [f.x, f.y, f.z, f.radius, f.createdAt, f.expiresAt].every(Number.isFinite)
    && f.radius > 0 && f.expiresAt > f.createdAt).slice(0, SMOKE.maxFields)
    .map(({ id, x, y, z, radius, createdAt, expiresAt }) =>
      ({ id, x, y, z, radius: Math.min(6, radius), createdAt, expiresAt }));
}
