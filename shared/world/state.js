import { AIR, GROUND, METAL, SX, SY, SZ, idx } from './blocks.js';
import { MAP_SPAWN_ANCHORS } from './metadata.js';
import { rebuildHeights, serializeBlocks } from './serialize.js';

export const RING = [...MAP_SPAWN_ANCHORS.foundry.fun.slice(0, 8), [64, 48]];

export function createStateApi(
  blocks,
  heights,
  spawnPool = null,
  mapId = 'foundry',
  meta = null,
) {
  const world = {
    mapId,
    meta,

    getBlock(x, y, z) {
      x |= 0;
      y |= 0;
      z |= 0;
      if (y < 0) return METAL;
      if (y >= SY) return AIR;
      if (x < 0 || z < 0 || x >= SX || z >= SZ) return METAL;
      return blocks[idx(x, y, z)];
    },

    setBlock(x, y, z, value) {
      x |= 0;
      y |= 0;
      z |= 0;
      if (x < 0 || z < 0 || x >= SX || z >= SZ || y < 0 || y >= SY) return false;
      blocks[idx(x, y, z)] = value;
      return true;
    },

    heightAt(x, z) {
      x |= 0;
      z |= 0;
      if (x < 0 || z < 0 || x >= SX || z >= SZ) return -1;
      return heights[z * SX + x];
    },

    findSpawns(n) {
      n = Math.max(0, n | 0);
      if (!spawnPool || spawnPool.length === 0) return findSpawnsFor(world, n);
      return Array.from(
        { length: n },
        (_, i) => ({ ...spawnPool[i % spawnPool.length] }),
      );
    },

    serializeWorld() {
      return serializeBlocks(blocks);
    },

    rebuildHeightMap() {
      rebuildHeights(blocks, heights);
    },
  };
  return world;
}

export function findSpawnsFor(world, n) {
  const out = [];
  for (const [px, pz] of RING) {
    if (out.length >= n) break;
    const spawn = freeSpotNear(world, px, pz);
    if (spawn) out.push(spawn);
  }
  if (out.length === 0 && n > 0) throw new Error('world has no walkable spawn');
  const unique = out.slice();
  while (out.length < n) out.push({ ...unique[out.length % unique.length] });
  return out;
}

export function freeSpotNear(world, px, pz) {
  const { getBlock, heightAt } = world;
  for (let r = 0; r < 12; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x = px + dx;
        const z = pz + dz;
        if (x < 3 || z < 3 || x >= SX - 3 || z >= SZ - 3) continue;
        const h = heightAt(x, z);
        if (h < GROUND - 1 || h > GROUND + 9) continue;
        if (getBlock(x, h + 1, z) !== AIR || getBlock(x, h + 2, z) !== AIR) continue;
        return { x: x + 0.5, y: h + 1.02, z: z + 0.5 };
      }
    }
  }
  return null;
}

export function ladderAt(mapMeta, x, y, z, margin = 0) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  const ladders = Array.isArray(mapMeta?.ladders) ? mapMeta.ladders : [];
  const pad = Number.isFinite(margin) ? Math.max(0, margin) : 0;
  for (const ladder of ladders) {
    if (
      x >= ladder.minX - pad
      && x <= ladder.maxX + pad
      && y >= ladder.minY - pad
      && y <= ladder.maxY + pad
      && z >= ladder.minZ - pad
      && z <= ladder.maxZ + pad
    ) {
      return ladder;
    }
  }
  return null;
}

/** True when a world-space point lies within one of the map's climb volumes. */
export function ladderContact(mapMeta, x, y, z, margin = 0) {
  return ladderAt(mapMeta, x, y, z, margin) !== null;
}
