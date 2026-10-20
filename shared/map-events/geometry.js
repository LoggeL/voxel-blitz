// Geometry shared by the Conquest map events (docs/conquest.md "Map events"):
// voxel boxes, hazard zone shapes and the blast-against-supports falloff the
// Iron Bridge introduced (shared/conquest-bridge.js uses the same helper).
// Pure functions, no imports: the server, the bots and the client read them.

const finite = Number.isFinite;

/** True when a point lies inside an inclusive integer voxel box {x0, y0, z0, x1, y1, z1}. */
export const insideBox = (b, x, y, z) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && z >= b.z0 && z <= b.z1;

/** Distance (m) from a point to an inclusive voxel box (0 inside). */
export function boxDistance(b, x, y, z) {
  const dx = Math.max(b.x0 - x, 0, x - (b.x1 + 1));
  const dy = Math.max(b.y0 - y, 0, y - (b.y1 + 1));
  const dz = Math.max(b.z0 - z, 0, z - (b.z1 + 1));
  return Math.hypot(dx, dy, dz);
}

/**
 * Integrity a blast takes off a set of support boxes: `{ damage, support }`.
 * `rules.supportDamage[key]` is the full share of the blast's weapon key; it
 * falls off linearly to 0 at max(radius, rules.minReach) from the nearest box
 * (only the nearest counts, never several). An unknown key, a non-finite
 * origin or a blast out of reach deals 0.
 */
export function integrityBlastDamage(origin, key, radius, rules, boxes) {
  const base = rules?.supportDamage?.[key] ?? 0;
  if (!(base > 0) || !Array.isArray(origin) || !origin.every(finite)) return { damage: 0, support: null };
  const reach = Math.max(finite(radius) ? radius : 0, rules.minReach ?? 0);
  let best = null;
  for (const support of boxes ?? []) {
    const d = boxDistance(support, origin[0], origin[1], origin[2]);
    if (d < reach && (!best || d < best.d)) best = { d, support };
  }
  if (!best) return { damage: 0, support: null };
  return { damage: base * (1 - best.d / reach), support: best.support.id ?? null };
}

/* ------------------------------------------------------------------ zones */

/**
 * Hazard and marker zones (world metres, y up). Shapes:
 *   { shape: 'circle', x, z, r }                       flat disc
 *   { shape: 'box', x0, z0, x1, z1 }                   flat rectangle (x0 < x1, z0 < z1)
 *   { shape: 'line', ax, az, bx, bz, w }               capsule of half width w along a-b (a crush line)
 * Every shape may add `y0` / `y1` (feet height band; open when absent).
 */
export function zoneFlatDistance(zone, x, z) {
  switch (zone?.shape) {
    case 'circle': return Math.hypot(x - zone.x, z - zone.z) - zone.r;
    case 'box': {
      const dx = Math.max(zone.x0 - x, x - zone.x1), dz = Math.max(zone.z0 - z, z - zone.z1);
      return dx > 0 || dz > 0 ? Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) : Math.max(dx, dz);
    }
    case 'line': {
      const vx = zone.bx - zone.ax, vz = zone.bz - zone.az, len2 = vx * vx + vz * vz;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - zone.ax) * vx + (z - zone.az) * vz) / len2)) : 0;
      return Math.hypot(x - (zone.ax + vx * t), z - (zone.az + vz * t)) - zone.w;
    }
    default: return Infinity;
  }
}

/** True when a point (feet) lies inside the zone, its height band included. */
export function zoneContains(zone, x, y, z, pad = 0) {
  if (!zone || !finite(x) || !finite(z)) return false;
  if (finite(zone.y0) && finite(y) && y < zone.y0 - pad) return false;
  if (finite(zone.y1) && finite(y) && y > zone.y1 + pad) return false;
  return zoneFlatDistance(zone, x, z) <= pad;
}

/** Flat centre of a zone (markers, bot flee direction). */
export function zoneCenter(zone) {
  switch (zone?.shape) {
    case 'circle': return { x: zone.x, z: zone.z };
    case 'box': return { x: (zone.x0 + zone.x1) / 2, z: (zone.z0 + zone.z1) / 2 };
    case 'line': return { x: (zone.ax + zone.bx) / 2, z: (zone.az + zone.bz) / 2 };
    default: return null;
  }
}

/**
 * The nearest flat point `margin` m outside the zone from `from` (bots fleeing
 * a hazard, goal points pushed out of one). A point already outside comes back
 * unchanged. `y` is kept from `from`.
 */
export function zoneExit(zone, from, margin = 3) {
  if (!zone || !from || zoneFlatDistance(zone, from.x, from.z) > 0) return from;
  let x = from.x, z = from.z;
  switch (zone.shape) {
    case 'circle': {
      const d = Math.hypot(x - zone.x, z - zone.z);
      const ux = d > 1e-6 ? (x - zone.x) / d : 1, uz = d > 1e-6 ? (z - zone.z) / d : 0;
      x = zone.x + ux * (zone.r + margin); z = zone.z + uz * (zone.r + margin);
      break;
    }
    case 'box': {
      const exits = [[zone.x0 - margin, z, x - zone.x0], [zone.x1 + margin, z, zone.x1 - x],
        [x, zone.z0 - margin, z - zone.z0], [x, zone.z1 + margin, zone.z1 - z]];
      exits.sort((a, b) => a[2] - b[2]);
      [x, z] = exits[0];
      break;
    }
    case 'line': {
      const vx = zone.bx - zone.ax, vz = zone.bz - zone.az, len2 = vx * vx + vz * vz;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - zone.ax) * vx + (z - zone.az) * vz) / len2)) : 0;
      const px = zone.ax + vx * t, pz = zone.az + vz * t, d = Math.hypot(x - px, z - pz);
      // Off the line square to it (a toppling tower's crush line): the side the body stands on.
      let nx = len2 > 0 ? -vz / Math.sqrt(len2) : 1, nz = len2 > 0 ? vx / Math.sqrt(len2) : 0;
      if (d > 1e-6) { nx = (x - px) / d; nz = (z - pz) / d; }
      x = px + nx * (zone.w + margin); z = pz + nz * (zone.w + margin);
      break;
    }
    default: return from;
  }
  return { ...from, x, z };
}

/** True when the flat segment a-b passes through the zone (grown by `pad`): sampled every 2 m. */
export function segmentCrossesZone(zone, a, b, pad = 0) {
  if (!zone || !a || !b) return false;
  const len = Math.hypot(b.x - a.x, b.z - a.z), steps = Math.max(1, Math.ceil(len / 2));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (zoneFlatDistance(zone, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t) <= pad) return true;
  }
  return false;
}
