export const BULLET_FLYBY_RADIUS = 2.2;
export const BULLET_FLYBY_COOLDOWN_MS = 110;

/** Nearest actual pass, bounded by server-resolved walls, victims and range. */
export function closestBulletFlyby(paths, listener) {
  if (!Array.isArray(paths) || !listener ||
      ![listener.x, listener.y, listener.z].every(Number.isFinite)) return null;
  let closest = null;
  for (const path of paths) {
    if (!Array.isArray(path)) continue;
    for (const segment of path) {
      const o = segment?.o, end = segment?.end;
      if (!Array.isArray(o) || !Array.isArray(end) || o.length !== 3 || end.length !== 3 ||
          ![...o, ...end].every(Number.isFinite)) continue;
      const dx = end[0] - o[0], dy = end[1] - o[1], dz = end[2] - o[2];
      const lengthSq = dx * dx + dy * dy + dz * dz;
      if (lengthSq < 1e-6) continue;
      const t = ((listener.x - o[0]) * dx + (listener.y - o[1]) * dy +
        (listener.z - o[2]) * dz) / lengthSq;
      // A shot starting beside us or stopping before us never passes our ears.
      if (t <= 0 || t >= 1) continue;
      const pos = [o[0] + dx * t, o[1] + dy * t, o[2] + dz * t];
      const distance = Math.hypot(listener.x - pos[0], listener.y - pos[1], listener.z - pos[2]);
      if (distance >= BULLET_FLYBY_RADIUS || (closest && distance >= closest.distance)) continue;
      // A squared falloff keeps close passes present and flattens into silence
      // at the outer radius, without an audible step when a pass leaves range.
      const proximity = 1 - distance / BULLET_FLYBY_RADIUS;
      closest = { pos, distance, volume: 0.7 * proximity * proximity };
    }
  }
  return closest;
}
