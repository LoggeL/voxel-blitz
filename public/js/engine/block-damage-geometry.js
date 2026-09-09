// Render-only erosion. The authoritative voxel and its collider stay whole
// until destruction; these little cells describe only the visible remainder.
export const DAMAGE_GRID = 4;
const CELL_COUNT = DAMAGE_GRID ** 3;
export const DAMAGE_THRESHOLDS = Object.freeze([0.2, 0.4, 0.6, 0.8, 0.95]);
const REMOVED_COUNTS = [0, 5, 13, 23, 35, 46];
const VARIANT_COUNT = 64;
const shapes = new Map();

export function damageStage(progress) {
  if (!Number.isFinite(progress)) return 0;
  // Small hits retain the intact silhouette; erosion follows accumulated damage.
  let stage = 0;
  while (stage < DAMAGE_THRESHOLDS.length && progress >= DAMAGE_THRESHOLDS[stage]) stage++;
  return stage;
}

function hash(value) {
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) >>> 0;
}

function variantAt(x, y, z) {
  return hash(Math.imul(x, 73856093) ^ Math.imul(y, 19349663)
    ^ Math.imul(z, 83492791)) % VARIANT_COUNT;
}

function makeStages(variant) {
  const shell = [];
  for (let z = 0; z < DAMAGE_GRID; z++) {
    for (let y = 0; y < DAMAGE_GRID; y++) {
      for (let x = 0; x < DAMAGE_GRID; x++) {
        const outer = Number(x === 0 || x === 3) + Number(y === 0 || y === 3)
          + Number(z === 0 || z === 3);
        if (outer === 0) continue; // The 2 x 2 x 2 core never floats or vanishes.
        const octant = Number(x >= 2) + Number(y >= 2) * 2 + Number(z >= 2) * 4;
        const index = x + DAMAGE_GRID * (y + DAMAGE_GRID * z);
        // Shared corner bias creates clustered missing chunks. Every outward
        // cell outranks its inward neighbour, keeping all remaining cells
        // connected to the core throughout the cumulative erosion sequence.
        const cornerBias = hash(variant * 83 + octant * 271 + 17) / 0xffffffff * 1.8;
        const grain = hash(variant * 179 + index * 43 + 719) / 0xffffffff * 0.28;
        shell.push({ index, score: outer + cornerBias + grain });
      }
    }
  }
  shell.sort((a, b) => b.score - a.score || a.index - b.index);
  // Two opposite corners touch all six faces, so even a block buried in a
  // wall shows a missing piece at its first damage stage, whichever face is exposed.
  const first = shell[0];
  const oppositeIndex = CELL_COUNT - 1 - first.index;
  const order = [first, shell.find((cell) => cell.index === oppositeIndex),
    ...shell.filter((cell) => cell.index !== first.index && cell.index !== oppositeIndex)];
  return REMOVED_COUNTS.map((count) => {
    const cells = new Uint8Array(CELL_COUNT).fill(1);
    for (let i = 0; i < count; i++) cells[order[i].index] = 0;
    return cells;
  });
}

/** Cached occupancy, indexed x + 4 * (y + 4 * z). Treat returned cells as read-only. */
export function damageCells(x, y, z, stage) {
  const variant = variantAt(x, y, z);
  if (!shapes.has(variant)) shapes.set(variant, makeStages(variant));
  return shapes.get(variant)[Math.max(0, Math.min(5, stage | 0))];
}

/** Local centres of newly detached quarter-block pieces, for hit particles. */
export function removedDamageCells(x, y, z, previousProgress, progress) {
  const before = damageCells(x, y, z, damageStage(previousProgress));
  const after = damageCells(x, y, z, damageStage(progress));
  const removed = [];
  for (let iz = 0; iz < DAMAGE_GRID; iz++) {
    for (let iy = 0; iy < DAMAGE_GRID; iy++) {
      for (let ix = 0; ix < DAMAGE_GRID; ix++) {
        const index = ix + DAMAGE_GRID * (iy + DAMAGE_GRID * iz);
        if (before[index] && !after[index]) {
          removed.push([(ix + 0.5) / DAMAGE_GRID, (iy + 0.5) / DAMAGE_GRID, (iz + 0.5) / DAMAGE_GRID]);
        }
      }
    }
  }
  return removed;
}
