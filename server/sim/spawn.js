// Safest-spawn selection with bounded recent-use tracking.

import { worldDimensions } from '../../shared/worlddata.js';
import { EYE_HEIGHT } from '../../shared/combatmath.js';
import { boxCollides, solidBelow } from '../../shared/player-movement.js';
import { raycastVoxels } from '../../shared/raycast.js';

const SPAWN_RECENT_MS = 8000;
const NEIGHBOURS = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
const SPAWN_LOS_PENALTY = 36;
const SPAWN_RECENT_PENALTY = 24;
const MAX_TRACKED_SPAWNS = 256;

function spawnPointKey(point) {
  return `${point.x},${point.y},${point.z}`;
}

/**
 * Authoritative spawn scorer.
 *
 * `entities` is the authoritative Map in insertion order. `isEnemy`, `solidAt`
 * and optional `fluidAt`/`portalAt` are injected policy/world operations; no engine
 * object crosses the seam. Call setNow once per simulation step before
 * choosing spawns.
 */
export class SpawnSelector {
  constructor({ entities, isEnemy, solidAt, fluidAt = null, portalAt = null, now, spawnBounds = null, dimensions = null }) {
    this.dimensions = dimensions || worldDimensions();
    this.entities = entities;
    this.isEnemy = isEnemy;
    this.solidAt = solidAt;
    this.fluidAt = typeof fluidAt === 'function' ? fluidAt : null;
    this.portalAt = typeof portalAt === 'function' ? portalAt : null;
    this.spawnBounds = spawnBounds;
    this.spawnSurfaces = spawnBounds?.surfaces ? new Set() : null;
    for (let i = 0; i < (spawnBounds?.surfaces?.length || 0); i += 3) {
      const [x, z, floorY] = spawnBounds.surfaces.slice(i, i + 3);
      this.spawnSurfaces.add(`${x},${floorY + 1},${z}`);
    }
    for (let i = 0; i < (spawnBounds?.excludedSurfaces?.length || 0); i += 3) {
      const [x, z, floorY] = spawnBounds.excludedSurfaces.slice(i, i + 3);
      this.spawnSurfaces?.delete(`${x},${floorY + 1},${z}`);
    }
    this.now = now;
    this.spawnUseTimes = new Map();
    this.expandedPools = new WeakMap();
  }

  setNow(ms) {
    this.now = ms;
  }

  expand(pool) {
    const { sx: SX, sy: SY, sz: SZ } = this.dimensions;
    if (this.expandedPools.has(pool)) return this.expandedPools.get(pool);
    const expanded = pool.map((point) => ({ ...point }));
    const seen = new Set(expanded.map(spawnPointKey));
    // Stay near authored routes and elevations, avoiding inaccessible roofs and map edges.
    for (const radius of [3, 6, 9]) for (const seed of pool) {
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]) {
        const x = seed.x + dx * radius, z = seed.z + dz * radius;
        if (x < 3 || z < 3 || x >= SX - 3 || z >= SZ - 3) continue;
        for (const dy of [0, -1, 1, -2, 2]) {
          const y = Math.floor(seed.y) + dy;
          const point = { x, y, z, index: expanded.length };
          if (y < 1 || y > SY - 3 || !this.walkable(point) || this.hazardous(point) || seen.has(spawnPointKey(point))) continue;
          const exits = [[1,0],[-1,0],[0,1],[0,-1]].filter(([ex, ez]) =>
            !boxCollides(this.solidAt, x + ex, y, z + ez)
            && solidBelow(this.solidAt, x + ex, y, z + ez));
          if (exits.length < 2) continue;
          expanded.push(point);
          seen.add(spawnPointKey(point));
          break;
        }
      }
    }
    this.expandedPools.set(pool, expanded);
    return expanded;
  }

  walkable(point) {
    const bounds = this.spawnBounds;
    if (bounds && (point.x < bounds.minX || point.x > bounds.maxX
      || point.z < bounds.minZ || point.z > bounds.maxZ
      || point.y < bounds.minY || point.y > bounds.maxY)) return false;
    if (this.spawnSurfaces && !this.spawnSurfaces.has(
      `${Math.floor(point.x)},${Math.floor(point.y)},${Math.floor(point.z)}`,
    )) return false;
    return !boxCollides(this.solidAt, point.x, point.y, point.z)
      && solidBelow(this.solidAt, point.x, point.y, point.z);
  }

  /**
   * A portal at the same body point queried by the authoritative volume step,
   * or lava or water at the feet, body or floor cell, or in any of the eight
   * horizontal neighbours at feet or floor level: the spawn push can shove a
   * fresh body one cell sideways, and a fluid floor drops it into the pool.
   */
  hazardous(point) {
    if (this.portalAt?.(point.x, point.y + 0.5, point.z)) return true;
    const fluidAt = this.fluidAt;
    if (!fluidAt) return false;
    const x = Math.floor(point.x), y = Math.floor(point.y), z = Math.floor(point.z);
    if (fluidAt(x, y, z) || fluidAt(x, y + 1, z) || fluidAt(x, y - 1, z)) return true;
    for (const [dx, dz] of NEIGHBOURS) {
      if (fluidAt(x + dx, y, z + dz) || fluidAt(x + dx, y - 1, z + dz)) return true;
    }
    return false;
  }

  enemyHasSpawnLos(enemy, point) {
    const ox = enemy.x;
    const oy = Number.isFinite(enemy.eyeY) ? enemy.eyeY : enemy.y + EYE_HEIGHT;
    const oz = enemy.z;
    const tx = point.x;
    const ty = point.y + EYE_HEIGHT;
    const tz = point.z;
    const dx = tx - ox, dy = ty - oy, dz = tz - oz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist <= 0.2) return true;
    return !raycastVoxels(this.solidAt, ox, oy, oz, dx, dy, dz, dist - 0.1);
  }

  /** Clear body box with a floor, inside the horizontal spawn bounds. Ignores authored floor heights. */
  standable(point) {
    const bounds = this.spawnBounds;
    if (bounds && (point.x < bounds.minX || point.x > bounds.maxX
      || point.z < bounds.minZ || point.z > bounds.maxZ)) return false;
    const { sx: SX, sy: SY, sz: SZ } = this.dimensions;
    if (point.x < 1 || point.z < 1 || point.x >= SX - 1 || point.z >= SZ - 1 || point.y < 1 || point.y > SY - 3) return false;
    return !boxCollides(this.solidAt, point.x, point.y, point.z)
      && solidBelow(this.solidAt, point.x, point.y, point.z);
  }

  _occupied(point, player) {
    for (const entity of this.entities.values()) {
      if (entity === player || entity.state !== 'alive') continue;
      if (Math.hypot(point.x - entity.x, point.y - entity.y, point.z - entity.z) < 1.2) return true;
    }
    return false;
  }

  _markUsed(point) {
    this.spawnUseTimes.set(spawnPointKey(point), this.now);
    if (this.spawnUseTimes.size <= MAX_TRACKED_SPAWNS) return;
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, usedAt] of this.spawnUseTimes) {
      if (usedAt < oldestAt) { oldestKey = key; oldestAt = usedAt; }
    }
    if (oldestKey !== null) this.spawnUseTimes.delete(oldestKey);
  }

  /**
   * Conquest flag cell. Cells an enemy within `losRange` can see are dropped;
   * the rest prefer distance from the nearest `awayFrom` point (enemy-held
   * flags or the enemy HQ), with jitter and a recent-use penalty for variety.
   * Distance to enemy bodies is never maximised. Null when no cell is usable.
   */
  pickFlagCell(pool, player = null, { awayFrom = [], losRange = 40, variety = true, rng = Math.random } = {}) {
    const enemies = [];
    for (const entity of this.entities.values()) {
      if (entity === player || entity.state !== 'alive') continue;
      if (player && !this.isEnemy(player, entity)) continue;
      enemies.push(entity);
    }
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < (pool?.length || 0); i++) {
      const source = pool[i];
      if (!source || ![source.x, source.y, source.z].every(Number.isFinite)) continue;
      const cell = { x: source.x, y: source.y, z: source.z, index: Number.isFinite(source.index) ? Math.trunc(source.index) : i };
      if (!this.standable(cell) || this.hazardous(cell) || this._occupied(cell, player)) continue;
      let seen = false;
      for (const enemy of enemies) {
        if (Math.hypot(cell.x - enemy.x, cell.y - enemy.y, cell.z - enemy.z) > losRange) continue;
        if (this.enemyHasSpawnLos(enemy, cell)) { seen = true; break; }
      }
      if (seen) continue;
      let away = 0;
      if (awayFrom.length) {
        away = Infinity;
        for (const point of awayFrom) away = Math.min(away, Math.hypot(cell.x - point.x, cell.z - point.z));
      }
      const usedAt = this.spawnUseTimes.get(spawnPointKey(cell));
      const age = Number.isFinite(usedAt) ? Math.max(0, this.now - usedAt) : SPAWN_RECENT_MS;
      const recentPenalty = age < SPAWN_RECENT_MS ? SPAWN_RECENT_PENALTY * (1 - age / SPAWN_RECENT_MS) : 0;
      const score = away - recentPenalty + (variety ? rng() * 8 : 0);
      if (score > bestScore) { best = cell; bestScore = score; }
    }
    if (best) this._markUsed(best);
    return best ? { ...best } : null;
  }

  /**
   * Squad spawn beside a squadmate: 12 ring positions ordered from directly
   * behind the mate outward, 1-4 m away, each a free standable cell the mate
   * could see (no wall between them). Null when every probe is blocked.
   */
  probeSquadCell(mate, { count = 12, minRadius = 1.5, maxRadius = 3.5, player = null } = {}) {
    if (!mate || ![mate.x, mate.y, mate.z].every(Number.isFinite)) return null;
    const yaw = Number.isFinite(mate.yaw) ? mate.yaw : 0;
    // Forward is (-sin yaw, -cos yaw); behind is the opposite.
    const back = Math.atan2(Math.sin(yaw), Math.cos(yaw));
    const offsets = [0];
    for (let k = 1; offsets.length < count; k++) { offsets.push(k); if (offsets.length < count) offsets.push(-k); }
    const step = Math.PI / Math.max(1, Math.ceil(count / 2));
    for (let i = 0; i < offsets.length; i++) {
      const angle = back + offsets[i] * step;
      const radius = i % 2 === 0 ? minRadius + (maxRadius - minRadius) * 0.35 : maxRadius;
      const x = mate.x + Math.sin(angle) * radius;
      const z = mate.z + Math.cos(angle) * radius;
      for (const dy of [0, 1, -1]) {
        const cell = { x, y: mate.y + dy, z };
        if (!this.standable(cell) || this.hazardous(cell) || this._occupied(cell, player)) continue;
        const eyeY = mate.y + EYE_HEIGHT * 0.5;
        const dx = x - mate.x, dz = z - mate.z, dyy = cell.y + EYE_HEIGHT * 0.5 - eyeY;
        const dist = Math.hypot(dx, dyy, dz);
        if (dist > 0.2 && raycastVoxels(this.solidAt, mate.x, eyeY, mate.z, dx, dyy, dz, dist)) continue;
        return { ...cell, index: -1 };
      }
    }
    return null;
  }

  pick(pool, player = null, excludeIndex = -1, { variety = false } = {}) {
    const { sx: SX, sy: SY, sz: SZ } = this.dimensions;
    let candidates = [];
    for (let i = 0; i < pool.length; i++) {
      const source = pool[i];
      if (!source || ![source.x, source.y, source.z].every(Number.isFinite)) continue;
      const index = Number.isFinite(source.index) ? Math.trunc(source.index) : i;
      if (!this.walkable(source)) continue;
      candidates.push({ x: source.x, y: source.y, z: source.z, index });
    }
    if (!candidates.length) {
      // Terrain may have removed every authored floor. Recover on actual current geometry.
      if (this.spawnSurfaces) {
        // Original navigation includes covered passages and stacked floors.
        const surfaces = this.spawnBounds.surfaces;
        for (let i = 0; i < surfaces.length; i += 3) {
          const point = { x: surfaces[i] + 0.5, y: surfaces[i + 2] + 1.02,
            z: surfaces[i + 1] + 0.5, index: candidates.length };
          if (this.walkable(point)) candidates.push(point);
        }
      } else {
        for (let z = 4; z < SZ - 4; z += 8) for (let x = 4; x < SX - 4; x += 8) {
          for (let y = 1; y < SY - 2; y++) {
            const point = { x: x + 0.5, y, z: z + 0.5, index: candidates.length };
            if (!this.walkable(point)) continue;
            candidates.push(point);
            // A fluid floor (the lava sea) is walkable; keep climbing to find dry ground.
            if (!this.hazardous(point)) break;
          }
        }
      }
      if (!candidates.length) throw new Error('World has no walkable spawn surface');
    }
    // Prefer candidates clear of fluids and portal triggers; a pool that is
    // entirely hazardous keeps the ordinary scoring rather than failing.
    const dry = candidates.filter((candidate) => !this.hazardous(candidate));
    if (dry.length) candidates = dry;

    const hasPriorPoint = player &&
      [player.lastSpawnX, player.lastSpawnY, player.lastSpawnZ].every(Number.isFinite);
    const isPriorSpawn = (candidate) => hasPriorPoint
      ? candidate.x === player.lastSpawnX &&
        candidate.y === player.lastSpawnY &&
        candidate.z === player.lastSpawnZ
      : candidate.index === excludeIndex;
    const canExcludePrior = candidates.length > 1 &&
      candidates.some((candidate) => !isPriorSpawn(candidate));
    const enemies = [];
    for (const entity of this.entities.values()) {
      if (entity === player || entity.state !== 'alive') continue;
      if (player && !this.isEnemy(player, entity)) continue;
      enemies.push(entity);
    }

    let best = null;
    let bestScore = -Infinity;
    let bestSafety = -Infinity;
    for (const candidate of candidates) {
      if (!variety && canExcludePrior && isPriorSpawn(candidate)) continue;
      let nearest = Math.hypot(SX, SZ);
      let visibleEnemies = 0;
      for (const enemy of enemies) {
        nearest = Math.min(nearest, Math.hypot(
          candidate.x - enemy.x,
          candidate.y - enemy.y,
          candidate.z - enemy.z,
        ));
        if (this.enemyHasSpawnLos(enemy, candidate)) visibleEnemies++;
      }

      const usedAt = this.spawnUseTimes.get(spawnPointKey(candidate));
      const age = Number.isFinite(usedAt)
        ? Math.max(0, this.now - usedAt)
        : SPAWN_RECENT_MS;
      const recentPenalty = age < SPAWN_RECENT_MS
        ? SPAWN_RECENT_PENALTY * (1 - age / SPAWN_RECENT_MS)
        : 0;
      const occupied = [...this.entities.values()].some((entity) => entity !== player
        && entity.state === 'alive' && Math.hypot(candidate.x - entity.x,
          candidate.y - entity.y, candidate.z - entity.z) < 2.5);
      // Every mode needs a free body-sized slot. Deterministic modes still
      // score safety normally once occupied positions have been excluded.
      const safety = occupied ? -1 : !variety ? 0 : nearest >= 12 && visibleEnemies === 0 ? 2 : nearest >= 8 ? 1 : 0;
      const score = nearest - visibleEnemies * SPAWN_LOS_PENALTY - recentPenalty - (variety && isPriorSpawn(candidate) ? 12 : 0) + (variety ? Math.random() * 6 : 0);
      if (safety > bestSafety || (safety === bestSafety && score > bestScore)) {
        bestSafety = safety;
        best = candidate;
        bestScore = score;
      }
    }

    const chosen = best || candidates[0];
    this.spawnUseTimes.set(spawnPointKey(chosen), this.now);
    if (this.spawnUseTimes.size > MAX_TRACKED_SPAWNS) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, usedAt] of this.spawnUseTimes) {
        if (usedAt < oldestAt) {
          oldestKey = key;
          oldestAt = usedAt;
        }
      }
      if (oldestKey !== null) this.spawnUseTimes.delete(oldestKey);
    }
    return { ...chosen };
  }
}
