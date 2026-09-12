import { PHYSICS, boxCollides, slidePlayerAxis, solidBelow } from './player-movement.js';

const surfaceCache = new WeakMap();
const STEP_SLICE = 0.45;
const SKIN = 1e-4;

function navSurfaces(mapMeta) {
  if (mapMeta?.id !== 'dust2' || !Array.isArray(mapMeta.spawnBounds?.surfaces)) return null;
  const source = mapMeta.spawnBounds.surfaces;
  if (surfaceCache.has(source)) return surfaceCache.get(source);
  const surfaces = new Set();
  for (let i = 0; i < source.length; i += 3) {
    surfaces.add(`${source[i]},${source[i + 1]},${source[i + 2]}`);
  }
  surfaceCache.set(source, surfaces);
  return surfaces;
}

function supportCells(position, feetY, solidAt, surfaces) {
  const result = [];
  const x0 = Math.floor(position.x - PHYSICS.halfW + SKIN);
  const x1 = Math.floor(position.x + PHYSICS.halfW - SKIN);
  const z0 = Math.floor(position.z - PHYSICS.halfW + SKIN);
  const z1 = Math.floor(position.z + PHYSICS.halfW - SKIN);
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    if (surfaces.has(`${x},${z},${feetY - 1}`) && solidAt(x, feetY - 1, z)) result.push([x, z]);
  }
  return result;
}

function stepOntoNav(position, axis, destination, solidAt, surfaces, height) {
  const feetY = Math.round(position.y);
  if (Math.abs(position.y - feetY) > 0.06) return false;
  const sourceCells = supportCells(position, feetY, solidAt, surfaces);
  if (!sourceCells.length || !solidBelow(solidAt, position.x, position.y, position.z)) return false;
  const target = { x: position.x, y: feetY + 1, z: position.z, [axis]: destination };
  const targetCells = supportCells(target, target.y, solidAt, surfaces);
  if (!targetCells.some(([tx, tz]) => sourceCells.some(([sx, sz]) =>
    Math.abs(tx - sx) + Math.abs(tz - sz) === 1))) return false;
  if (boxCollides(solidAt, target.x, target.y, target.z, height)
    || !solidBelow(solidAt, target.x, target.y, target.z)) return false;

  // Lift at the point where ordinary collision stopped us, then sweep the
  // remaining horizontal distance. A low ceiling can reject either segment.
  const swept = { x: position.x, y: position.y, z: position.z };
  if (slidePlayerAxis(swept, 'y', target.y - swept.y, solidAt, height)
    || slidePlayerAxis(swept, axis, destination - swept[axis], solidAt, height)) return false;
  Object.assign(position, target);
  return true;
}

/**
 * Ordinary axis collision with one-voxel walking steps on original Dust II
 * NAV terrain. The caller enables steps only while grounded and neither
 * jumping, climbing a ladder nor vaulting. Crates added above a NAV floor
 * cannot become steps, and every decision uses the current damaged geometry.
 */
export function slideTerrainAxis(position, axis, amount, solidAt, mapMeta, canStep = false, height = PHYSICS.height) {
  const surfaces = canStep && axis !== 'y' ? navSurfaces(mapMeta) : null;
  if (!surfaces || !Number.isFinite(amount) || amount === 0) {
    return slidePlayerAxis(position, axis, amount, solidAt, height);
  }
  const sign = Math.sign(amount);
  let remaining = Math.abs(amount);
  while (remaining > 1e-9) {
    const delta = Math.min(STEP_SLICE, remaining) * sign;
    remaining -= Math.abs(delta);
    const destination = position[axis] + delta;
    if (slidePlayerAxis(position, axis, delta, solidAt, height)
      && !stepOntoNav(position, axis, destination, solidAt, surfaces, height)) return true;
  }
  return false;
}
