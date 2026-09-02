import { AIR, GROUND, SX, SY, SZ } from './blocks.js';
import { MAP_MODE_COMPATIBILITY } from '../modes.js';
import { foundryLadderVolumes } from './terrain-foundry.js';

export const MAP_NAMES = Object.freeze({
  foundry: 'Foundry',
  depot: 'Depot',
  citadel: 'Citadel',
  solstice: 'Solstice',
  caldera: 'Caldera',
});

export const MAP_SPAWN_ANCHORS = Object.freeze({
  foundry: {
    fun: [[16, 16], [112, 16], [112, 80], [16, 80], [64, 14], [64, 82], [20, 48], [108, 48], [52, 40], [76, 56], [40, 72], [88, 24]],
    tdm: {
      alpha: [[13, 16], [14, 32], [14, 48], [14, 64], [16, 80], [25, 48]],
      bravo: [[114, 80], [113, 64], [113, 48], [113, 32], [111, 16], [102, 48]],
    },
    snd: {
      attackers: [[42, 82], [52, 82], [64, 82], [76, 82], [86, 82]],
      defenders: [[42, 13], [52, 13], [64, 13], [76, 13], [86, 13]],
    },
  },
  depot: {
    fun: [[18, 18], [64, 12], [109, 18], [16, 48], [111, 47], [18, 77], [63, 83], [109, 77], [49, 20], [78, 75], [49, 75], [78, 20]],
    tdm: {
      alpha: [[13, 18], [13, 33], [13, 48], [13, 63], [13, 78], [22, 48]],
      bravo: [[114, 77], [114, 62], [114, 47], [114, 32], [114, 17], [105, 47]],
    },
    snd: { attackers: [], defenders: [] },
  },
  citadel: {
    fun: [[12, 8], [36, 8], [64, 9], [92, 8], [115, 18], [115, 77], [92, 87], [64, 86], [36, 87], [12, 77], [45, 47], [82, 48]],
    tdm: {
      alpha: [[18, 87], [36, 87], [54, 87], [72, 87], [90, 87], [108, 87]],
      bravo: [[18, 8], [36, 8], [54, 8], [72, 8], [90, 8], [108, 8]],
    },
    snd: {
      attackers: [[18, 87], [36, 87], [54, 87], [72, 87], [90, 87], [108, 87]],
      defenders: [[18, 8], [36, 8], [54, 8], [72, 8], [90, 8], [108, 8]],
    },
  },
  solstice: {
    fun: [[16, 12], [36, 12], [64, 10], [92, 12], [112, 18], [112, 78], [92, 84], [64, 85], [36, 84], [16, 78], [48, 48], [80, 48]],
    tdm: {
      alpha: [[16, 84], [34, 84], [52, 84], [76, 84], [94, 84], [112, 84]],
      bravo: [[16, 10], [34, 10], [52, 10], [76, 10], [94, 10], [112, 10]],
    },
    snd: {
      attackers: [[16, 84], [34, 84], [52, 84], [76, 84], [94, 84], [112, 84]],
      defenders: [[16, 10], [34, 10], [52, 10], [76, 10], [94, 10], [112, 10]],
    },
  },
  caldera: {
    fun: [[12, 8], [36, 8], [64, 9], [92, 8], [115, 18], [115, 77], [92, 87], [64, 86], [36, 87], [12, 77], [45, 47], [82, 48]],
    tdm: {
      alpha: [[18, 87], [36, 87], [54, 87], [72, 87], [90, 87], [108, 87]],
      bravo: [[18, 8], [36, 8], [54, 8], [72, 8], [90, 8], [108, 8]],
    },
    snd: {
      attackers: [[18, 87], [36, 87], [54, 87], [72, 87], [90, 87], [108, 87]],
      defenders: [[18, 8], [36, 8], [54, 8], [72, 8], [90, 8], [108, 8]],
    },
  },
});

export const MAP_SITE_LAYOUTS = Object.freeze({
  foundry: [
    { id: 'A', minX: 46, maxX: 53, minZ: 68, maxZ: 75, y: GROUND + 1.02 },
    { id: 'B', minX: 76, maxX: 83, minZ: 20, maxZ: 27, y: GROUND + 1.02 },
  ],
  depot: [],
  citadel: [
    { id: 'A', minX: 21, maxX: 34, minZ: 18, maxZ: 30, y: GROUND + 1.02 },
    { id: 'B', minX: 97, maxX: 108, minZ: 42, maxZ: 54, y: GROUND + 4.02 },
  ],
  solstice: [
    { id: 'A', minX: 21, maxX: 34, minZ: 43, maxZ: 54, y: GROUND + 1.02 },
    { id: 'B', minX: 94, maxX: 106, minZ: 42, maxZ: 54, y: GROUND + 1.02 },
  ],
  caldera: [
    { id: 'A', minX: 19, maxX: 32, minZ: 41, maxZ: 54, y: GROUND + 1.02 },
    { id: 'B', minX: 96, maxX: 109, minZ: 41, maxZ: 54, y: GROUND + 4.02 },
  ],
});

export const MAP_LANDMARKS = Object.freeze({
  foundry: [
    { id: 'north-forge', name: 'North Forge', x: 60, z: 26 },
    { id: 'center-crane', name: 'Center Crane', x: 65, z: 46 },
    { id: 'south-tower', name: 'South Tower', x: 26, z: 78 },
  ],
  depot: [
    { id: 'west-bay', name: 'West Loading Bay', x: 15, z: 48 },
    { id: 'plaza', name: 'Central Plaza', x: 64, z: 48 },
    { id: 'east-bay', name: 'East Loading Bay', x: 112, z: 47 },
  ],
  citadel: [
    { id: 'a-courtyard', name: 'A Courtyard', x: 27, z: 24 },
    { id: 'keep', name: 'Central Keep', x: 63, z: 47 },
    { id: 'b-compound', name: 'B Compound', x: 103, z: 48 },
  ],
  solstice: [
    { id: 'biodome', name: 'Glass Biodome', x: 28, z: 48 },
    { id: 'heliostat', name: 'Heliostat Ring', x: 64, z: 45 },
    { id: 'turbines', name: 'Turbine Hall', x: 101, z: 48 },
  ],
  caldera: [
    { id: 'obsidian-gate', name: 'Obsidian Gate', x: 25, z: 48 },
    { id: 'central-vent', name: 'Central Vent', x: 64, z: 48 },
    { id: 'ember-refinery', name: 'Ember Refinery', x: 103, z: 48 },
  ],
});

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function spawnIsWalkable(world, spawn) {
  const x = Math.floor(spawn.x);
  const z = Math.floor(spawn.z);
  const feetY = Math.floor(spawn.y);
  return x >= 3 && z >= 3 && x < SX - 3 && z < SZ - 3
    && feetY > 0 && feetY < SY - 1
    && world.getBlock(x, feetY - 1, z) !== AIR
    && world.getBlock(x, feetY, z) === AIR
    && world.getBlock(x, feetY + 1, z) === AIR;
}

function resolveSpawnPool(world, anchors) {
  const out = [];
  const occupied = new Set();
  for (const [px, pz] of anchors) {
    let resolved = null;
    for (let r = 0; r <= 8 && !resolved; r++) {
      for (let dz = -r; dz <= r && !resolved; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x = px + dx;
          const z = pz + dz;
          if (x < 3 || z < 3 || x >= SX - 3 || z >= SZ - 3) continue;
          const h = world.heightAt(x, z);
          const spawn = { x: x + 0.5, y: h + 1.02, z: z + 0.5 };
          const key = `${x},${z}`;
          if (!occupied.has(key) && spawnIsWalkable(world, spawn)) {
            occupied.add(key);
            resolved = spawn;
            break;
          }
        }
      }
    }
    if (!resolved) throw new Error(`no walkable spawn near ${px},${pz}`);
    out.push(resolved);
  }
  return out;
}

export function createMapMetadata(id, world) {
  const anchors = MAP_SPAWN_ANCHORS[id];
  const metadata = {
    id,
    name: MAP_NAMES[id],
    modes: MAP_MODE_COMPATIBILITY[id],
    spawns: {
      fun: resolveSpawnPool(world, anchors.fun),
      tdm: {
        alpha: resolveSpawnPool(world, anchors.tdm.alpha),
        bravo: resolveSpawnPool(world, anchors.tdm.bravo),
      },
      snd: {
        attackers: resolveSpawnPool(world, anchors.snd.attackers),
        defenders: resolveSpawnPool(world, anchors.snd.defenders),
      },
    },
    ladders: id === 'foundry' ? foundryLadderVolumes() : [],
    sites: MAP_SITE_LAYOUTS[id].map((site) => ({ ...site })),
    landmarks: MAP_LANDMARKS[id].map((landmark) => ({
      ...landmark,
      y: world.heightAt(landmark.x, landmark.z) + 1.02,
    })),
  };

  for (const pool of [
    metadata.spawns.fun,
    metadata.spawns.tdm.alpha,
    metadata.spawns.tdm.bravo,
    metadata.spawns.snd.attackers,
    metadata.spawns.snd.defenders,
  ]) {
    for (const spawn of pool) {
      if (!spawnIsWalkable(world, spawn)) throw new Error(`${id} contains an invalid spawn`);
    }
  }

  if (metadata.sites.length === 2) {
    const [a, b] = metadata.sites;
    const overlap = a.minX <= b.maxX && b.minX <= a.maxX
      && a.minZ <= b.maxZ && b.minZ <= a.maxZ;
    if (overlap) throw new Error(`${id} plant sites overlap`);
  }
  return deepFreeze(metadata);
}
