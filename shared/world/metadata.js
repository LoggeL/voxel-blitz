import { LARGE_SPAWN_ANCHORS, LARGE_SITES, LARGE_LANDMARKS } from './large-layout.js';
import { worldDimensions } from './dimensions.js';
import { AIR, GROUND, METAL, SX, SY, SZ } from './blocks.js';
import { MAP_MODE_COMPATIBILITY } from '../modes.js';
import { foundryLadderVolumes } from './terrain-foundry.js';
import { REACTOR_LAYOUT } from './reactor-layout.js';
import {
  DUST2_NAV_FLOORS, DUST2_SPAWN_ANCHORS, DUST2_SITES, DUST2_LANDMARKS,
  dust2FloorsAt,
} from './dust2-layout.js';

const MAP_NAMES = Object.freeze({
  harbor: 'Harbor',
  canyon: 'Canyon',
  reactor: 'Reactor 9',
  foundry: 'Foundry',
  depot: 'Depot',
  citadel: 'Citadel',
  solstice: 'Solstice',
  caldera: 'Caldera',
  nuketown: 'Nuketown',
  dust2: 'Dust 2',
  killhouse: 'Killhouse',
});

export const MAP_SPAWN_ANCHORS = Object.freeze({
  harbor: LARGE_SPAWN_ANCHORS,
  canyon: LARGE_SPAWN_ANCHORS,
  reactor: { fun: REACTOR_LAYOUT.defenders.map(p => [p.x, p.z]),
    tdm: { alpha: [], bravo: [] }, snd: { attackers: [], defenders: [] } },
  dust2: DUST2_SPAWN_ANCHORS,
  nuketown: {
    fun: [[43,12],[56,12],[73,12],[86,12],[43,83],[56,83],[73,83],[86,83],[28,40],[99,55],[35,59],[92,39]],
    tdm: { alpha: [[43,83],[51,83],[59,83],[68,83],[77,83],[86,83]], bravo: [[43,12],[51,12],[59,12],[68,12],[77,12],[86,12]] },
    snd: { attackers: [[43,83],[51,83],[59,83],[68,83],[77,83],[86,83]], defenders: [[43,12],[51,12],[59,12],[68,12],[77,12],[86,12]] },
  },
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
  killhouse: {
    fun: [[16, 86], [40, 86], [64, 86], [88, 86], [112, 86], [18, 76], [56, 76], [104, 76], [34, 60], [94, 60], [64, 62], [14, 50]],
    tdm: {
      alpha: [[16, 86], [30, 86], [16, 74], [30, 66], [46, 86], [14, 50]],
      bravo: [[112, 86], [98, 86], [112, 74], [98, 66], [82, 86], [113, 50]],
    },
    snd: { attackers: [], defenders: [] },
  },
});

const MAP_SITE_LAYOUTS = Object.freeze({
  harbor: LARGE_SITES,
  canyon: LARGE_SITES,
  reactor: [],
  dust2: DUST2_SITES,
  nuketown: [
    { id: 'A', minX: 32, maxX: 39, minZ: 43, maxZ: 51, y: GROUND + 1.02 },
    { id: 'B', minX: 92, maxX: 99, minZ: 43, maxZ: 51, y: GROUND + 1.02 },
  ],
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
  killhouse: [],
});

const MAP_LANDMARKS = Object.freeze({
  ...LARGE_LANDMARKS,
  reactor: [ { id: 'core', name: 'Reactor Core', x: 64, z: 54, floorY: GROUND },
    { id: 'supply', name: 'Service Bay', x: 64, z: 78, floorY: GROUND } ],
  dust2: DUST2_LANDMARKS,
  nuketown: [
    { id: 'yellow-house', name: 'Yellow House', x: 59, z: 67 },
    { id: 'school-bus', name: 'School Bus', x: 57, z: 46 },
    { id: 'green-house', name: 'Green House', x: 68, z: 28 },
  ],
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
  killhouse: [
    { id: 'firing-line', name: 'Firing Line', x: 64, z: 84 },
    { id: 'killhouse-yard', name: 'Killhouse Yard', x: 14, z: 50 },
    { id: 'long-lane', name: 'Long Lane', x: 64, z: 62 },
  ],
});

/** Dummy-target posts per map, indexed by dummy bot id (dummy-<index>). Killhouse only. */
export const MAP_DUMMY_POSTS = Object.freeze({
  killhouse: Object.freeze([
    { kind: 'range', x: 18, z: 74 },
    { kind: 'range', x: 34, z: 74 },
    { kind: 'range', x: 54, z: 74 },
    { kind: 'range', x: 74, z: 74 },
    { kind: 'range', x: 94, z: 74 },
    { kind: 'range', x: 114, z: 74 },
    { kind: 'range', x: 34, z: 64 },
    { kind: 'range', x: 94, z: 64 },
    { kind: 'range', x: 64, z: 58 },
    { kind: 'stage', stage: 0, x: 16, z: 32 },
    { kind: 'stage', stage: 0, x: 34, z: 42 },
    { kind: 'stage', stage: 1, x: 46, z: 30 },
    { kind: 'stage', stage: 1, x: 66, z: 44 },
    { kind: 'stage', stage: 2, x: 76, z: 44 },
    { kind: 'stage', stage: 2, x: 96, z: 30 },
    { kind: 'stage', stage: 3, x: 104, z: 30 },
    { kind: 'stage', stage: 3, x: 115, z: 42 },
  ]),
});

/** Timed run course per map, staged behind METAL gates. Killhouse only. */
export const MAP_RUN_COURSE = Object.freeze({
  killhouse: Object.freeze({
    start: Object.freeze({ minX: 12, minZ: 48, maxX: 17, maxZ: 53 }),
    finish: Object.freeze({ minX: 112, minZ: 34, maxX: 117, maxZ: 42 }),
    stages: Object.freeze([
      Object.freeze([10, 28, 39, 46]),
      Object.freeze([41, 28, 69, 46]),
      Object.freeze([71, 28, 99, 46]),
      Object.freeze([101, 28, 117, 46]),
    ]),
    gates: Object.freeze([
      Object.freeze({ x: 40 }),
      Object.freeze({ x: 70 }),
      Object.freeze({ x: 100 }),
    ]),
    gateY: Object.freeze([15, 17]),
    gateZ: Object.freeze([28, 46]),
  }),
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function spawnIsWalkable(world, spawn) {
  const { sx: SX, sy: SY, sz: SZ } = worldDimensions(world);
  const x = Math.floor(spawn.x);
  const z = Math.floor(spawn.z);
  const feetY = Math.floor(spawn.y);
  return x >= 3 && z >= 3 && x < SX - 3 && z < SZ - 3
    && feetY > 0 && feetY < SY - 1
    && world.getBlock(x, feetY - 1, z) !== AIR
    && world.getBlock(x, feetY, z) === AIR
    && world.getBlock(x, feetY + 1, z) === AIR;
}

function resolveSpawnPool(world, anchors, floorY = null) {
  const { sx: SX, sz: SZ } = worldDimensions(world);
  const out = [];
  const occupied = new Set();
  for (const [px, pz, anchorFloorY] of anchors) {
    let resolved = null;
    for (let r = 0; r <= 8 && !resolved; r++) {
      for (let dz = -r; dz <= r && !resolved; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x = px + dx;
          const z = pz + dz;
          if (x < 3 || z < 3 || x >= SX - 3 || z >= SZ - 3) continue;
          const floors = world.mapId === 'dust2'
            ? [...dust2FloorsAt(x, z)].sort((a, b) => Math.abs(a - anchorFloorY) - Math.abs(b - anchorFloorY))
            : [anchorFloorY ?? floorY ?? world.heightAt(x, z)];
          for (const h of floors) {
            const spawn = { x: x + 0.5, y: h + 1.02, z: z + 0.5 };
            const key = `${x},${h},${z}`;
            if (!occupied.has(key) && spawnIsWalkable(world, spawn)) {
              occupied.add(key);
              resolved = spawn;
              break;
            }
          }
          if (resolved) break;
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
  // Training uses one authored floor; Dust II anchors carry individual NAV levels.
  const floorY = id === 'killhouse' || id === 'reactor' ? GROUND : null;
  const metadata = {
    id,
    name: MAP_NAMES[id],
    dimensions: world.dimensions,
    ...(['harbor', 'canyon'].includes(id) ? { navigationFloor: GROUND, spawnBounds: {
      minX: 4, maxX: 187, minZ: 4, maxZ: 139, minY: GROUND + 1, maxY: GROUND + 1.1,
    } } : {}),
    ...(id === 'reactor' ? { bastion: structuredClone(REACTOR_LAYOUT), spawnBounds: {
      minX: 51, maxX: 76, minZ: 43, maxZ: 67, minY: GROUND + 1, maxY: GROUND + 1.1,
    } } : {}),
    // Keep procedural and terrain-recovery spawns inside the test-town wall.
    ...(id === 'nuketown' ? { spawnBounds: {
      minX: 22.5, maxX: 104.5, minZ: 6.5, maxZ: 88.5,
      minY: GROUND + 1, maxY: GROUND + 1.1,
    } } : {}),
    ...(id === 'dust2' ? { spawnBounds: {
      minX: 22.5, maxX: 105.5, minZ: 3.5, maxZ: 92.5,
      minY: 11, maxY: 18.1,
      surfaces: DUST2_NAV_FLOORS,
      // Two isolated source NAV pockets have no player-sized route into them.
      excludedSurfaces: [82, 10, 16, 87, 25, 13],
    } } : {}),
    modes: MAP_MODE_COMPATIBILITY[id],
    spawns: {
      fun: resolveSpawnPool(world, anchors.fun, floorY),
      tdm: {
        alpha: resolveSpawnPool(world, anchors.tdm.alpha, floorY),
        bravo: resolveSpawnPool(world, anchors.tdm.bravo, floorY),
      },
      snd: {
        attackers: resolveSpawnPool(world, anchors.snd.attackers, floorY),
        defenders: resolveSpawnPool(world, anchors.snd.defenders, floorY),
      },
    },
    ladders: id === 'foundry' ? foundryLadderVolumes() : [],
    sites: MAP_SITE_LAYOUTS[id].map((site) => ({ ...site })),
    landmarks: MAP_LANDMARKS[id].map(({ floorY: landmarkFloorY, ...landmark }) => ({
      ...landmark,
      y: (landmarkFloorY ?? (id === 'killhouse' ? GROUND : world.heightAt(landmark.x, landmark.z))) + 1.02,
    })),
    dummyPosts: (MAP_DUMMY_POSTS[id] || []).map((post) => ({
      ...post,
      y: (floorY ?? world.heightAt(post.x, post.z)) + 1.02,
    })),
    course: MAP_RUN_COURSE[id] ? structuredClone(MAP_RUN_COURSE[id]) : null,
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

  for (const post of metadata.dummyPosts) {
    const h = Math.floor(post.y) - 1;
    if (world.getBlock(post.x, h, post.z) === AIR
      || world.getBlock(post.x, h + 1, post.z) !== AIR
      || world.getBlock(post.x, h + 2, post.z) !== AIR) {
      throw new Error(`${id} contains an invalid dummy post at ${post.x},${post.z}`);
    }
  }

  if (metadata.course) {
    for (const gate of metadata.course.gates) {
      for (const y of metadata.course.gateY) {
        for (const z of metadata.course.gateZ) {
          if (world.getBlock(gate.x, y, z) !== METAL) {
            throw new Error(`${id} gate at x=${gate.x} is not sealed with METAL`);
          }
        }
      }
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
