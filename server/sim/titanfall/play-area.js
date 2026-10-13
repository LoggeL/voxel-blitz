/**
 * Titanfall play area (docs/titanfall.md §1 Play area, §4.1 OOB). Harbor and
 * canyon play on the whole map with `mapMeta.spawns.tdm`. Frontier plays in a
 * 256×256 m rectangle centred on the iron bridge where the east-west road
 * crosses the river (384, 384), with 16 ground-probed spawns per team on the
 * west (alpha) and east (bravo) edges, chosen from a fixed seed at match start.
 */
import { isSolidBlock } from '../../../shared/worlddata.js';
import { FLUID_BLOCKS } from '../../../shared/world/blocks.js';
import { surfaceNavigation } from '../../bot-navigation.js';

export const PLAY_AREA_RULES = Object.freeze({
  frontier: Object.freeze({ minX: 256, maxX: 512, minZ: 256, maxZ: 512 }),
  spawnsPerTeam: 16, seed: 0x7174, edgeInset: 6, edgeDepth: 18, spawnHeadroom: 3,
  ceilingPad: 4, oobMs: 3000, spawnAvoid: 35,
});

/** Deterministic 32-bit LCG in [0, 1). */
function rng(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

/** Standing height on the column (x, z): the top solid voxel + 1, or null over fluid, holes or a blocked head. */
function groundAt(world, x, z, sy) {
  const bx = Math.floor(x), bz = Math.floor(z);
  for (let y = sy - 1; y >= 0; y--) {
    const block = world.getBlock(bx, y, bz);
    if (FLUID_BLOCKS.has(block)) return null;
    if (!isSolidBlock(block)) continue;
    for (let h = 1; h <= PLAY_AREA_RULES.spawnHeadroom; h++) if (isSolidBlock(world.getBlock(bx, y + h, bz))) return null;
    return y + 1;
  }
  return null;
}

/**
 * On a surface-navigation map (frontier), a predicate that accepts only points
 * in the walkable region holding most of the rectangle's nodes: a spawn in a
 * walled pocket would trap bots (and the spawn selector favours far corners).
 * Null when the map has no surface graph.
 */
function openGround(world, rect) {
  const nav = surfaceNavigation(world);
  if (!nav?.component || !nav.flags) return null;
  const counts = new Map();
  for (let node = 0; node < nav.nodes; node++) {
    if (!(nav.flags[node] & 1) || nav.component[node] < 0) continue; // walkable
    const p = nav.nodePoint(node);
    if (p.x < rect.minX || p.x > rect.maxX || p.z < rect.minZ || p.z > rect.maxZ) continue;
    counts.set(nav.component[node], (counts.get(nav.component[node]) ?? 0) + 1);
  }
  let main = -1, best = 0;
  for (const [label, count] of counts) if (count > best) { main = label; best = count; }
  if (main < 0) return null;
  return (x, y, z) => { const node = nav.nodeAt({ x, y, z }); return node >= 0 && nav.component[node] === main; };
}

function edgeSpawns(world, rect, side, sy, random, accept = null) {
  const { edgeInset, edgeDepth, spawnsPerTeam } = PLAY_AREA_RULES, list = [];
  const yaw = side < 0 ? -Math.PI / 2 : Math.PI / 2; // face the far edge (nose is local −Z)
  for (let tries = 0; tries < 400 && list.length < spawnsPerTeam; tries++) {
    const depth = edgeInset + random() * edgeDepth;
    const x = Math.floor(side < 0 ? rect.minX + depth : rect.maxX - depth) + 0.5;
    const z = Math.floor(rect.minZ + edgeInset + random() * (rect.maxZ - rect.minZ - 2 * edgeInset)) + 0.5;
    const y = groundAt(world, x, z, sy);
    if (y == null || list.some(s => Math.hypot(s.x - x, s.z - z) < 4)) continue;
    if (accept && !accept(x, y + 0.02, z)) continue;
    list.push({ x, y: y + 0.02, z, yaw });
  }
  return list;
}

/**
 * The area for one match: { frontier, bounds {minX,maxX,minZ,maxZ}, sy, spawns {alpha, bravo} | null }.
 * `spawns` is null for whole-map areas (the policy uses mapMeta.spawns.tdm).
 */
export function titanfallPlayArea(mapMeta, world) {
  const dims = world?.dimensions ?? mapMeta?.dimensions ?? { sx: 0, sy: 0, sz: 0 };
  if (mapMeta?.id !== 'frontier') {
    return { frontier: false, bounds: { minX: 0, maxX: dims.sx, minZ: 0, maxZ: dims.sz }, sy: dims.sy, spawns: null };
  }
  const rect = PLAY_AREA_RULES.frontier, random = rng(PLAY_AREA_RULES.seed), accept = openGround(world, rect);
  const alpha = edgeSpawns(world, rect, -1, dims.sy, random, accept), bravo = edgeSpawns(world, rect, 1, dims.sy, random, accept);
  return { frontier: true, bounds: { ...rect }, sy: dims.sy, spawns: { alpha, bravo } };
}

/** True inside the rectangle and no higher than SY + ceilingPad. */
export function inPlayArea(area, x, y, z) {
  const b = area?.bounds;
  if (!b || ![x, y, z].every(Number.isFinite)) return true;
  return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && y <= area.sy + PLAY_AREA_RULES.ceilingPad;
}

/** Spawn points at least `radius` from every hazard ({x, z}); the full pool when none is clear. */
export function avoidSpawns(pool, hazards, radius = PLAY_AREA_RULES.spawnAvoid) {
  if (!Array.isArray(pool) || !hazards?.length) return pool;
  const clear = pool.filter(s => hazards.every(h => Math.hypot(s.x - h.x, s.z - h.z) >= radius));
  return clear.length ? clear : pool;
}

/**
 * OOB timer for one living pilot (or the pilot of a titan, positioned by its hull).
 * `record.oobSince` (ms or 0) persists in the policy state. Returns
 * { warn, until, kill, started } for this tick.
 */
export function stepOutOfBounds(area, x, y, z, record, now) {
  if (inPlayArea(area, x, y, z)) { record.oobSince = 0; return { warn: false, until: 0, kill: false, started: false }; }
  const started = !record.oobSince;
  if (started) record.oobSince = now;
  const until = record.oobSince + PLAY_AREA_RULES.oobMs;
  return { warn: true, until, kill: now >= until, started };
}
