// Safest-spawn selection with bounded recent-use tracking.

import { worldDimensions } from '../../shared/worlddata.js';
import { EYE_HEIGHT } from '../../shared/combatmath.js';
import { boxCollides, solidBelow } from '../../shared/player-movement.js';
import { raycastVoxels } from '../../shared/raycast.js';

const SPAWN_RECENT_MS = 8000;
const SPAWN_LOS_PENALTY = 36;
const SPAWN_RECENT_PENALTY = 24;
export const MAX_TRACKED_SPAWNS = 256;

function spawnPointKey(point) {
  return `${point.x},${point.y},${point.z}`;
}

/**
 * Authoritative spawn scorer.
 *
 * `entities` is the authoritative Map in insertion order. `isEnemy` and
 * `solidAt` are injected policy/world operations; no engine object crosses the
 * seam. Call setNow once per simulation step before choosing spawns.
 */
export class SpawnSelector {
  constructor({ entities, isEnemy, solidAt, now, spawnBounds = null, dimensions = null }) {
    this.dimensions = dimensions || worldDimensions();
    this.entities = entities;
    this.isEnemy = isEnemy;
    this.solidAt = solidAt;
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

  reset() {
    this.spawnUseTimes.clear();
  }

  dispose() {
    this.spawnUseTimes.clear();
    this.entities = null;
    this.isEnemy = null;
    this.solidAt = null;
    this.spawnSurfaces = null;
    this.now = 0;
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
          if (y < 1 || y > SY - 3 || !this.walkable(point) || seen.has(spawnPointKey(point))) continue;
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

  pick(pool, player = null, excludeIndex = -1, { variety = false } = {}) {
    const { sx: SX, sy: SY, sz: SZ } = this.dimensions;
    const candidates = [];
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
            if (this.walkable(point)) { candidates.push(point); break; }
          }
        }
      }
      if (!candidates.length) throw new Error('World has no walkable spawn surface');
    }

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
