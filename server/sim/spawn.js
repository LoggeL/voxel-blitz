// Safest-spawn selection with bounded recent-use tracking.

import { SX, SZ } from '../../shared/worlddata.js';
import { EYE_HEIGHT } from '../../shared/combatmath.js';
import { raycastVoxels } from '../../shared/raycast.js';

const SPAWN_RECENT_MS = 8000;
const SPAWN_LOS_PENALTY = 36;
const SPAWN_RECENT_PENALTY = 24;
export const MAX_TRACKED_SPAWNS = 64;

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
  constructor({ entities, isEnemy, solidAt, now }) {
    this.entities = entities;
    this.isEnemy = isEnemy;
    this.solidAt = solidAt;
    this.now = now;
    this.spawnUseTimes = new Map();
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
    this.now = 0;
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

  pick(pool, player = null, excludeIndex = -1) {
    const candidates = [];
    for (let i = 0; i < pool.length; i++) {
      const source = pool[i];
      if (!source || ![source.x, source.y, source.z].every(Number.isFinite)) continue;
      const index = Number.isFinite(source.index) ? Math.trunc(source.index) : i;
      candidates.push({ x: source.x, y: source.y, z: source.z, index });
    }
    if (!candidates.length) return { x: 0, y: 1, z: 0, index: 0 };

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
    for (const candidate of candidates) {
      if (canExcludePrior && isPriorSpawn(candidate)) continue;
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
      const score = nearest - visibleEnemies * SPAWN_LOS_PENALTY - recentPenalty;
      if (score > bestScore) {
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
