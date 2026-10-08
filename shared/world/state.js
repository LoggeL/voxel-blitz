import { AIR, BEDROCK, GROUND, METAL } from './blocks.js';
import { getMapDimensions, worldDimensions } from './dimensions.js';
import { MAP_SPAWN_ANCHORS } from './metadata.js';
import { encodeMapFrame, mapFingerprint, rebuildHeights, serializeBlocks } from './serialize.js';

const PRISTINE_BYTES = new WeakMap();
const PRISTINE_FINGERPRINTS = new WeakMap();

/** The template's serialization, shared by every state built from it. */
function pristineBytes(pristine, dimensions) {
  let bytes = PRISTINE_BYTES.get(pristine);
  if (!bytes) PRISTINE_BYTES.set(pristine, bytes = serializeBlocks(pristine, dimensions));
  return bytes;
}
const RING = [...MAP_SPAWN_ANCHORS.foundry.fun.slice(0, 8), [64, 48]];

export function createStateApi(
  blocks,
  heights,
  spawnPool = null,
  mapId = 'foundry',
  meta = null,
  dimensions = getMapDimensions(mapId),
  pristine = null,
) {
  const { sx: SX, sy: SY, sz: SZ } = dimensions;
  const idx = (x, y, z) => (y * SZ + z) * SX + x;
  let navigationRevision = 0;
  const navigationChanges = [];
  // Template-backed states (createMapState) know their pristine voxels: they
  // count the cells that differ from it and the block replacements made, so
  // derived data (wire bytes, navigation graphs) can be cached per template
  // or per mutation instead of being rebuilt from 47 M voxels.
  if (pristine && pristine.length !== blocks.length) pristine = null;
  let divergent = 0, mutations = 0, serialized = null;
  // Cells that differ from the template (the V3 map frame's patch) and the
  // per-mutation frame cache: [template frame, reference frame].
  const divergentCells = pristine ? new Set() : null;
  let frames = null;
  const world = {
    dimensions,
    mapId,
    meta,
    /** The pristine template voxels this state started from (shared, read-only), or null. */
    get templateBlocks() { return pristine; },
    /** Block replacements since creation (monotonic). */
    get mutationCount() { return mutations; },
    /** True when every voxel equals the pristine template again (or never changed). */
    matchesTemplate() { return pristine !== null && divergent === 0; },
    /** The template's voxel at a cell; the live voxel for states without a template. */
    templateBlock(x, y, z) {
      if (!pristine) return world.getBlock(x, y, z);
      x |= 0; y |= 0; z |= 0;
      if (y < 0) return BEDROCK;
      if (x < 0 || z < 0 || x >= SX || z >= SZ) return METAL;
      if (y >= SY) return AIR;
      return pristine[idx(x, y, z)];
    },
    get navigationRevision() { return navigationRevision; },
    navigationChangesSince(revision) {
      if (revision === navigationRevision) return [];
      if (!navigationChanges.length || revision < navigationChanges[0].revision - 1) return null;
      return navigationChanges.filter(change => change.revision > revision);
    },

    getBlock(x, y, z) {
      x |= 0;
      y |= 0;
      z |= 0;
      if (y < 0) return BEDROCK;
      if (x < 0 || z < 0 || x >= SX || z >= SZ) return METAL;
      if (y >= SY) return AIR;
      return blocks[idx(x, y, z)];
    },

    setBlock(x, y, z, value) {
      x |= 0;
      y |= 0;
      z |= 0;
      if (x < 0 || z < 0 || x >= SX || z >= SZ || y < 0 || y >= SY) return false;
      const index = idx(x, y, z);
      const before = blocks[index];
      if (before === value) return true;
      const wasAir = before === AIR;
      if (pristine) {
        const original = pristine[index];
        divergent += (value !== original) - (before !== original);
        if (value !== original) divergentCells.add(index);
        else divergentCells.delete(index);
      }
      mutations++;
      blocks[index] = value;
      const floor = meta?.navigationFloor;
      if (Number.isFinite(floor) && wasAir !== (value === AIR) && y >= floor && y <= floor + 2) {
        navigationChanges.push({ revision: ++navigationRevision, x, z });
        if (navigationChanges.length > 256) navigationChanges.shift();
      }
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
      // Template-backed states change only through setBlock, so the encoded
      // bytes are reused until the next replacement; an unchanged (or fully
      // restored) map shares one encoding per template. Callers must treat the
      // returned bytes as read-only.
      if (!pristine) return serializeBlocks(blocks, dimensions);
      if (divergent === 0) return pristineBytes(pristine, dimensions);
      if (serialized?.mutations !== mutations) serialized = { mutations, bytes: serializeBlocks(blocks, dimensions) };
      return serialized.bytes;
    },

    /** Fingerprint of the template's serialization (null without a template). */
    get templateFingerprint() {
      if (!pristine) return null;
      let fingerprint = PRISTINE_FINGERPRINTS.get(pristine);
      if (!fingerprint) PRISTINE_FINGERPRINTS.set(pristine, fingerprint = mapFingerprint(pristineBytes(pristine, dimensions)));
      return fingerprint;
    },

    /**
     * V3 map frame (serialize.js): the template (or, with `cached`, only its
     * fingerprint) plus every cell that differs from it. Costs O(changed
     * cells) instead of re-encoding the world; cached per mutation. Returns
     * null without a template (callers then send serializeWorld()).
     */
    mapFrame({ cached = false } = {}) {
      if (!pristine) return null;
      if (frames?.mutations !== mutations) frames = { mutations, bytes: [null, null] };
      const slot = cached ? 1 : 0;
      frames.bytes[slot] ??= encodeMapFrame({
        template: pristineBytes(pristine, dimensions), fingerprint: world.templateFingerprint,
        cells: divergentCells, blocks, includeTemplate: !cached,
      });
      return frames.bytes[slot];
    },

    rebuildHeightMap() {
      rebuildHeights(blocks, heights, dimensions);
    },
  };
  return world;
}

function findSpawnsFor(world, n) {
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

function freeSpotNear(world, px, pz) {
  const { getBlock, heightAt } = world;
  const { sx: SX, sz: SZ } = worldDimensions(world);
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

function ladderAt(mapMeta, x, y, z, margin = 0) {
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

/** The authored teleport portal whose trigger volume holds a world-space point, if any. */
export function portalAt(mapMeta, x, y, z) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  const portals = Array.isArray(mapMeta?.portals) ? mapMeta.portals : [];
  for (const portal of portals) {
    if (x >= portal.minX && x <= portal.maxX && y >= portal.minY && y <= portal.maxY
      && z >= portal.minZ && z <= portal.maxZ) return portal;
  }
  return null;
}
