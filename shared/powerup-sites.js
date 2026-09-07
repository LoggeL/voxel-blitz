import { AIR, SX, SY, SZ } from './world/blocks.js';

export const POWERUP_SITE_MIN_SPAWN_DISTANCE = 12;

// Hand-picked exposed ground, stored as voxel x / floor y / voxel z. Keeping
// the original floor level avoids moving rewards onto roofs or into craters
// when the mutable map changes. Every anchor has a walkable route from spawns.
const ANCHORS = Object.freeze({
  foundry: [[29, 12, 33], [80, 16, 43], [53, 14, 71], [72, 17, 69]],
  depot: [[63, 14, 24], [63, 14, 41], [64, 14, 54], [64, 14, 71]],
  citadel: [[25, 14, 50], [63, 14, 24], [84, 14, 21], [64, 14, 72]],
  solstice: [[64, 14, 29], [31, 14, 44], [64, 14, 61], [80, 14, 71]],
  caldera: [[56, 14, 34], [72, 14, 25], [53, 14, 67], [73, 14, 70]],
  nuketown: [[43, 14, 37], [79, 14, 40], [49, 14, 56], [84, 14, 59]],
});

/** Cheap live check for active pickups; a mined or blocked pad is invalid. */
export function isPowerupSiteSupported(world, site) {
  if (!world || typeof world.getBlock !== 'function' || !site
    || !Number.isFinite(site.x) || !Number.isFinite(site.y)
    || !Number.isFinite(site.z)) return false;
  const x = Math.floor(site.x);
  const y = Math.floor(site.y);
  const z = Math.floor(site.z);
  if (x < 4 || x >= SX - 4 || z < 4 || z >= SZ - 4
    || y < 1 || y >= SY - 1) return false;

  // Require a small standing area, not the isolated voxel left after a blast.
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (world.getBlock(x + dx, y - 1, z + dz) === AIR
        || world.getBlock(x + dx, y, z + dz) !== AIR
        || world.getBlock(x + dx, y + 1, z + dz) !== AIR) return false;
    }
  }
  return true;
}

function isExposed(world, site) {
  const x = Math.floor(site.x);
  const feetY = Math.floor(site.y);
  const z = Math.floor(site.z);
  for (let y = feetY + 2; y < SY; y++) {
    if (world.getBlock(x, y, z) !== AIR) return false;
  }

  // At least six directions must have a 12-metre firing lane at chest height.
  // This runs when spawning, not on every simulation tick.
  let openDirections = 0;
  for (let direction = 0; direction < 16; direction++) {
    const angle = direction * Math.PI / 8;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    let clear = true;
    for (let distance = 1; distance <= 12; distance += 0.5) {
      if (world.getBlock(
        Math.floor(site.x + dx * distance), feetY + 1,
        Math.floor(site.z + dz * distance),
      ) !== AIR) {
        clear = false;
        break;
      }
    }
    if (clear && ++openDirections >= 6) return true;
  }
  return false;
}

/** Exposed, currently usable combat-map pads. y is the player's foot level. */
export function findPowerupSites(world, mapMeta = world?.meta) {
  const anchors = ANCHORS[mapMeta?.id ?? world?.mapId];
  if (!anchors) return [];
  const pools = mapMeta?.spawns;
  const spawns = [
    ...(pools?.fun ?? []),
    ...(pools?.tdm?.alpha ?? []),
    ...(pools?.tdm?.bravo ?? []),
  ];
  return anchors.map(([x, floorY, z]) => ({
    x: x + 0.5, y: floorY + 1.02, z: z + 0.5,
  })).filter((site) => isPowerupSiteSupported(world, site)
    && spawns.every((spawn) => Math.hypot(site.x - spawn.x, site.z - spawn.z)
      >= POWERUP_SITE_MIN_SPAWN_DISTANCE)
    && isExposed(world, site));
}
