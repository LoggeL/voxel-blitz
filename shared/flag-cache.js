// Conquest flag supply caches (docs/conquest.md "Infantry supply", Flag caches).
// Every flag has one cache of crates near its pole. The spot is picked once,
// deterministically, from the pole and the terrain when the map metadata is
// built (flag row `cache {x, y, z, yaw}`), and the client draws it as a prop,
// so the voxel world (and its fingerprints) stays as it is. The cache pays
// only the side that holds the flag, and nothing while an enemy stands in the
// capture zone. Server: server/modes/conquest/flag-caches.js.

export const FLAG_CACHE_RULES = Object.freeze({
  /** Feet within this flat distance (m) of the cache are served; no key. */
  radius: 4,
  /** Height band (m) of the served feet above or below the cache floor. */
  dy: 2.5,
  /** One magazine and one grenade every tickMs. */
  tickMs: 3000,
  /** One AT/AA gadget round every gadgetMs per player. */
  gadgetMs: 15000,
  /** One bandage every bandageMs per player. */
  bandageMs: 30000,
  /** The cache stands ringMin..ringMax m from the pole. */
  ringMin: 4,
  ringMax: 8,
  /** Bots: primary reserve share below which a bot goes for ammo. */
  botReserveShare: 0.35,
  /** Bots: with no bandage left, below this HP a bot goes for one. */
  botBandageHp: 70,
  /** Bots: only caches of held flags within this range (m). */
  botRange: 150,
});

/** Candidate radii (m) in preference order, and the bearing steps tried for each. */
const RADII = Object.freeze([6, 5, 7, 4.5, 7.5]);
const BEARINGS = 16;
/** Cells (half-width) of the flat, dry footprint the crates need. */
const FOOTPRINT = 1;
/** Keep clear of the flag's spawn cells by this flat distance (m). */
const SPAWN_CLEAR = 2.5;
/** The cache floor may sit at most this far (voxels) above or below the pole's ground. */
const MAX_RISE = 2;
const FEET = 1.02;
const round2 = v => Math.round(v * 100) / 100;

/**
 * The cache spot of one flag: `{x, y (feet), z, yaw (facing the pole)}`, or
 * null when no candidate fits. Bearings start toward `center` (the map centre:
 * the cache sits on the inner side of the flag) and alternate either way; the
 * first candidate whose 3x3 footprint is flat, dry, near the pole's ground and
 * clear of the flag's spawn cells wins. `topY(x, z)` is the top terrain voxel,
 * `waterY(x, z)` the water surface (0 on dry ground; a bridge deck over
 * the river is dry).
 */
export function flagCacheSpot(flag, { topY, waterY = () => 0, center = null } = {}) {
  if (!flag || typeof topY !== 'function' || ![flag.x, flag.z].every(Number.isFinite)) return null;
  const poleTop = topY(flag.x, flag.z);
  const toward = center && Math.hypot(center.x - flag.x, center.z - flag.z) > 1
    ? Math.atan2(center.z - flag.z, center.x - flag.x) : 0;
  const spawns = Array.isArray(flag.spawns) ? flag.spawns : [];
  const order = [0];
  for (let k = 1; k <= BEARINGS / 2; k++) { order.push(k); if (k < BEARINGS / 2) order.push(-k); }
  for (const r of RADII) {
    for (const k of order) {
      const angle = toward + k * Math.PI * 2 / BEARINGS;
      const ix = Math.floor(flag.x + Math.cos(angle) * r), iz = Math.floor(flag.z + Math.sin(angle) * r);
      const x = ix + 0.5, z = iz + 0.5;
      const d = Math.hypot(x - flag.x, z - flag.z);
      if (d < FLAG_CACHE_RULES.ringMin || d > FLAG_CACHE_RULES.ringMax) continue;
      const top = topY(x, z);
      if (!Number.isFinite(top) || Math.abs(top - poleTop) > MAX_RISE) continue;
      let ok = true;
      for (let dx = -FOOTPRINT; dx <= FOOTPRINT && ok; dx++) {
        for (let dz = -FOOTPRINT; dz <= FOOTPRINT && ok; dz++) {
          if (topY(x + dx, z + dz) !== top || waterY(x + dx, z + dz) > top) ok = false;
        }
      }
      if (!ok || spawns.some(s => Math.hypot(s.x - x, s.z - z) < SPAWN_CLEAR)) continue;
      return { x, y: round2(top + FEET), z, yaw: round2(Math.atan2(flag.x - x, flag.z - z)) };
    }
  }
  return null;
}

/**
 * The side a flag's cache serves now: its owner while no enemy stands in the
 * zone (`alpha`/`bravo` are the zone presence counts), else null.
 */
export function flagCacheTeam(flag) {
  const owner = flag?.owner;
  if (owner !== 'alpha' && owner !== 'bravo' || !flag.cache) return null;
  const enemy = owner === 'alpha' ? 'bravo' : 'alpha';
  return (flag[enemy] | 0) > 0 ? null : owner;
}

/** True while feet `p` are within reach of `cache` (flat radius and height band). */
export function inFlagCacheReach(cache, p) {
  if (!cache || !p || ![p.x, p.y, p.z].every(Number.isFinite)) return false;
  if (Math.hypot(p.x - cache.x, p.z - cache.z) > FLAG_CACHE_RULES.radius) return false;
  return Math.abs(p.y - cache.y) <= FLAG_CACHE_RULES.dy;
}
