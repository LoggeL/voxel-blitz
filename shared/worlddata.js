// Shared voxel world: block palette, store, procedural arena generation,
// binary map serialization, spawn queries. Used identically by server and clients.
import { fbm2, mulberry32 } from './noise.js';
import { MAP_IDS, MAP_MODE_COMPATIBILITY } from './modes.js';

export { MAP_IDS };

export const AIR = 0;
export const GRASS = 1;
export const DIRT = 2;
export const STONE = 3;
export const SAND = 4;
export const WOOD = 5;
export const LEAVES = 6;
export const CONCRETE = 7;
export const METAL = 8;   // indestructible border + tower frames
export const ACCENT = 9;  // orange trim plates (tough but breakable)
export const PLANK = 10;  // house walls, breakable
export const GLASS = 11;  // windows, fragile
export const PALE = 12;   // pale concrete stairs / blocks

/** Damage points required to break each destructible block type. */
export const BLOCK_HP = {
  [GLASS]: 6,
  [LEAVES]: 10,
  [PLANK]: 30,
  [ACCENT]: 45,
};

export const SX = 128, SZ = 96, SY = 40, GROUND = 14;
export const SEED = 20260826;

const MAP_VERSION = 1;
const MAP_HEADER_BYTES = 6;
const MAP_BYTES = MAP_HEADER_BYTES + SX * SY * SZ;

const data = new Uint8Array(SX * SY * SZ);
const heightMap = new Int16Array(SX * SZ);

const idx = (x, y, z) => ((y * SZ) + z) * SX + x;

function createStateApi(blocks, heights, spawnPool = null, mapId = 'foundry', meta = null) {
  const world = {
    mapId,
    meta,

    getBlock(x, y, z) {
      x |= 0; y |= 0; z |= 0;
      if (y < 0) return METAL;
      if (y >= SY) return AIR;
      if (x < 0 || z < 0 || x >= SX || z >= SZ) return METAL;
      return blocks[idx(x, y, z)];
    },

    setBlock(x, y, z, v) {
      x |= 0; y |= 0; z |= 0;
      if (x < 0 || z < 0 || x >= SX || z >= SZ || y < 0 || y >= SY) return false;
      blocks[idx(x, y, z)] = v;
      return true;
    },

    heightAt(x, z) {
      x |= 0; z |= 0;
      if (x < 0 || z < 0 || x >= SX || z >= SZ) return -1;
      return heights[z * SX + x];
    },

    findSpawns(n) {
      n = Math.max(0, n | 0);
      if (!spawnPool || spawnPool.length === 0) return findSpawnsFor(world, n);
      return Array.from({ length: n }, (_, i) => ({ ...spawnPool[i % spawnPool.length] }));
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

const defaultWorld = createStateApi(data, heightMap);

export function getBlock(x, y, z) {
  return defaultWorld.getBlock(x, y, z);
}

export function setBlock(x, y, z, v) {
  return defaultWorld.setBlock(x, y, z, v);
}

export function heightAt(x, z) {
  return defaultWorld.heightAt(x, z);
}

function terrainHeight(x, z) {
  const n1 = fbm2(x * 0.032, z * 0.032, SEED, 4);
  const n2 = fbm2(x * 0.11 + 40, z * 0.11 + 40, SEED + 7, 3);
  const h = GROUND + Math.round(n1 * 7 + n2 * 1.5);
  return Math.max(4, Math.min(GROUND + 10, h));
}

// ---------------------------------------------------------------- generation

const TOWERS = [
  { cx: 20, cz: 20 },
  { cx: 100, cz: 24 },
  { cx: 26, cz: 78 },
  { cx: 102, cz: 74 },
];
const HOUSES = [
  { cx: 60, cz: 26, w: 11, d: 9 },
  { cx: 36, cz: 52, w: 9, d: 9 },
];

function generateInto(world, blocks, heights) {
  const { getBlock, setBlock, heightAt } = world;
  blocks.fill(AIR);

  // rolling terrain
  for (let z = 0; z < SZ; z++) {
    for (let x = 0; x < SX; x++) {
      const h = terrainHeight(x, z);
      heights[z * SX + x] = h;
      for (let y = 0; y <= h; y++) {
        let b = STONE;
        if (y === h) b = (h <= GROUND - 1) ? SAND : GRASS;
        else if (y > h - 4) b = DIRT;
        setBlock(x, y, z, b);
      }
    }
  }

  // indestructible metal border cliffs
  for (let z = 0; z < SZ; z++) {
    for (let x = 0; x < SX; x++) {
      const edge = Math.min(x, z, SX - 1 - x, SZ - 1 - z);
      if (edge < 3) {
        const top = edge === 0 ? SY - 1 : SY - 8;
        for (let y = heights[z * SX + x]; y <= top; y++) setBlock(x, y, z, METAL);
      }
    }
  }

  for (const t of TOWERS) buildTower(world, t.cx, t.cz);
  for (const hs of HOUSES) buildHouse(world, hs.cx, hs.cz, hs.w, hs.d);

  // scattered cover on open ground
  const rng = mulberry32(SEED ^ 0xbeef);
  for (let i = 0; i < 110; i++) {
    const x = 6 + ((rng() * (SX - 12)) | 0);
    const z = 6 + ((rng() * (SZ - 12)) | 0);
    if (nearStructure(x, z)) continue;
    const h = heightAt(x, z);
    const kind = rng();
    if (kind < 0.5) setBlock(x, h + 1, z, CONCRETE);
    else if (kind < 0.8) { setBlock(x - 1, h + 1, z, CONCRETE); setBlock(x, h + 1, z, CONCRETE); setBlock(x + 1, h + 1, z, CONCRETE); }
    else { setBlock(x, h + 1, z, CONCRETE); setBlock(x + 1, h + 1, z, ACCENT); setBlock(x, h + 2, z, PALE); }
  }

  // bushes — free destruction fodder
  for (let i = 0; i < 380; i++) {
    const x = 6 + ((rng() * (SX - 12)) | 0);
    const z = 6 + ((rng() * (SZ - 12)) | 0);
    if (nearStructure(x, z)) continue;
    const h = heightAt(x, z);
    if (getBlock(x, h, z) !== GRASS || getBlock(x, h + 1, z) !== AIR) continue;
    setBlock(x, h + 1, z, LEAVES);
    if (rng() < 0.3 && getBlock(x, h + 2, z) === AIR) setBlock(x, h + 2, z, LEAVES);
  }

  polishFoundry(world, heights);
}

export function generateWorld() {
  generateInto(defaultWorld, data, heightMap);
  defaultWorld.rebuildHeightMap();
}

function nearStructure(x, z) {
  for (const t of TOWERS) if (Math.abs(x - t.cx) < 10 && Math.abs(z - t.cz) < 10) return true;
  for (const hs of HOUSES) if (Math.abs(x - hs.cx) < hs.w + 2 && Math.abs(z - hs.cz) < hs.d + 2) return true;
  return false;
}

function buildTower(world, cx, cz) {
  const { heightAt, setBlock } = world;
  const baseH = heightAt(cx, cz);
  const topY = baseH + 11;
  const R = 3; // 7x7 footprint
  for (let dz = -R; dz <= R; dz++) {
    for (let dx = -R; dx <= R; dx++) {
      const x = cx + dx, z = cz + dz;
      const gh = Math.max(heightAt(x, z), baseH);
      for (let y = gh + 1; y <= topY; y++) {
        const rimX = Math.abs(dx) === R, rimZ = Math.abs(dz) === R;
        if (!(rimX || rimZ)) continue; // hollow shaft
        const corner = rimX && rimZ;
        if (corner) { setBlock(x, y, z, METAL); continue; }
        const relY = y - gh;
        if (relY % 4 === 1) setBlock(x, y, z, ACCENT);
        else if (relY === 6) continue; // leave arrow slit open
        else setBlock(x, y, z, METAL);
      }
    }
  }
  // walkable deck + crenellation posts + flag
  for (let dz = -R + 1; dz <= R - 1; dz++)
    for (let dx = -R + 1; dx <= R - 1; dx++)
      setBlock(cx + dx, topY, cz + dz, METAL);
  for (let dz = -R + 1; dz <= R - 1; dz += 2) { setBlock(cx - R + 1, topY + 1, cz + dz, ACCENT); setBlock(cx + R - 1, topY + 1, cz + dz, ACCENT); }
  for (let dx = -R + 1; dx <= R - 1; dx += 2) { setBlock(cx + dx, topY + 1, cz - R + 1, ACCENT); setBlock(cx + dx, topY + 1, cz + R - 1, ACCENT); }
  setBlock(cx, topY + 1, cz, WOOD); setBlock(cx, topY + 2, cz, WOOD); setBlock(cx, topY + 3, cz, ACCENT);
  // south entrance
  for (let y = baseH + 1; y <= baseH + 2; y++) setBlock(cx, y, cz - R, AIR);
  // exterior step ramp (east side)
  let sy = baseH + 1;
  for (let dz = cz - R + 1; dz <= cz + R + 4; dz += 2) {
    for (let s = 0; s < 2; s++, sy++) {
      if (!setBlock(cx + R + 1, sy, dz, PALE)) break;
      setBlock(cx + R + 2, sy, dz, PALE);
    }
  }
}

function buildHouse(world, cx, cz, w, d) {
  const { heightAt, setBlock } = world;
  const x0 = cx - (w >> 1), z0 = cz - (d >> 1), H = 5;
  let base = Infinity;
  for (let z = z0 - 2; z < z0 + d + 2; z++)
    for (let x = x0 - 2; x < x0 + w + 2; x++) base = Math.min(base, heightAt(x, z));
  // foundation pad
  for (let z = z0 - 2; z < z0 + d + 2; z++)
    for (let x = x0 - 2; x < x0 + w + 2; x++) {
      const gh = heightAt(x, z);
      for (let y = gh + 1; y <= base; y++) setBlock(x, y, z, CONCRETE);
      for (let y = base + 1; y <= gh; y++) setBlock(x, y, z, AIR);
    }
  const ty = base + H;
  for (let z = z0; z < z0 + d; z++) {
    for (let x = x0; x < x0 + w; x++) {
      if (!(x === x0 || x === x0 + w - 1 || z === z0 || z === z0 + d - 1)) continue;
      const midX = x === x0 + (w >> 1), midZ = z === z0 + (d >> 1);
      for (let y = base + 1; y <= ty; y++) {
        if (y === base + 3 && !midX && !midZ) { setBlock(x, y, z, GLASS); continue; }
        setBlock(x, y, z, PLANK);
      }
    }
  }
  // door gaps south + east
  for (let y = base + 1; y <= base + 2; y++) setBlock(x0 + (w >> 1), y, z0, AIR);
  for (let y = base + 1; y <= base + 2; y++) setBlock(x0 + w - 1, y, z0 + (d >> 1), AIR);
  // roof slab + accent parapet
  for (let z = z0; z < z0 + d; z++)
    for (let x = x0; x < x0 + w; x++)
      setBlock(x, ty, z, PLANK);
  for (let z = z0; z < z0 + d; z++) { setBlock(x0, ty + 1, z, ACCENT); setBlock(x0 + w - 1, ty + 1, z, ACCENT); }
  for (let x = x0; x < x0 + w; x++) { setBlock(x, ty + 1, z0, ACCENT); setBlock(x, ty + 1, z0 + d - 1, ACCENT); }
  // roof stair ramp along west wall (double-wide, climbable steps)
  for (let s = 0; s <= H; s++) {
    for (let zz = 0; zz < 2; zz++) {
      setBlock(x0 - 1, base + 1 + s, z0 + 2 + s + zz, PALE);
      setBlock(x0 - 2, base + 1 + s, z0 + 2 + s + zz, PALE);
    }
  }
}

const MAP_NAMES = Object.freeze({
  foundry: 'Foundry',
  depot: 'Depot',
  citadel: 'Citadel',
});

const MAP_SPAWN_ANCHORS = Object.freeze({
  foundry: {
    fun: [[16,16],[112,16],[112,80],[16,80],[64,14],[64,82],[20,48],[108,48],[52,40],[76,56],[40,72],[88,24]],
    tdm: {
      alpha: [[13,16],[14,32],[14,48],[14,64],[16,80],[25,48]],
      bravo: [[114,80],[113,64],[113,48],[113,32],[111,16],[102,48]],
    },
    snd: {
      attackers: [[42,82],[52,82],[64,82],[76,82],[86,82]],
      defenders: [[42,13],[52,13],[64,13],[76,13],[86,13]],
    },
  },
  depot: {
    fun: [[18,18],[64,12],[109,18],[16,48],[111,47],[18,77],[63,83],[109,77],[49,20],[78,75],[49,75],[78,20]],
    tdm: {
      alpha: [[13,18],[13,33],[13,48],[13,63],[13,78],[22,48]],
      bravo: [[114,77],[114,62],[114,47],[114,32],[114,17],[105,47]],
    },
    snd: { attackers: [], defenders: [] },
  },
  citadel: {
    fun: [[12,8],[36,8],[64,9],[92,8],[115,18],[115,77],[92,87],[64,86],[36,87],[12,77],[45,47],[82,48]],
    tdm: {
      alpha: [[18,87],[36,87],[54,87],[72,87],[90,87],[108,87]],
      bravo: [[18,8],[36,8],[54,8],[72,8],[90,8],[108,8]],
    },
    snd: {
      attackers: [[18,87],[36,87],[54,87],[72,87],[90,87],[108,87]],
      defenders: [[18,8],[36,8],[54,8],[72,8],[90,8],[108,8]],
    },
  },
});

const MAP_SITE_LAYOUTS = Object.freeze({
  foundry: [
    { id: 'A', minX: 46, maxX: 53, minZ: 68, maxZ: 75, y: GROUND + 1.02 },
    { id: 'B', minX: 76, maxX: 83, minZ: 20, maxZ: 27, y: GROUND + 1.02 },
  ],
  depot: [],
  citadel: [
    { id: 'A', minX: 21, maxX: 34, minZ: 18, maxZ: 30, y: GROUND + 1.02 },
    { id: 'B', minX: 97, maxX: 108, minZ: 42, maxZ: 54, y: GROUND + 4.02 },
  ],
});

const MAP_LANDMARKS = Object.freeze({
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
});

function fillBox(world, x0, y0, z0, x1, y1, z1, type) {
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++)
        world.setBlock(x, y, z, type);
}

function clearBox(world, x0, y0, z0, x1, y1, z1) {
  fillBox(world, x0, y0, z0, x1, y1, z1, AIR);
}

function paintFloor(world, x0, z0, x1, z1, y, type) {
  for (let z = z0; z <= z1; z++)
    for (let x = x0; x <= x1; x++)
      world.setBlock(x, y, z, type);
}

function generateFlatBase(world, blocks, heights) {
  blocks.fill(AIR);
  for (let z = 0; z < SZ; z++) {
    for (let x = 0; x < SX; x++) {
      heights[z * SX + x] = GROUND;
      for (let y = 0; y <= GROUND; y++)
        world.setBlock(x, y, z, y === GROUND ? CONCRETE : STONE);
      const edge = Math.min(x, z, SX - 1 - x, SZ - 1 - z);
      if (edge < 3) {
        const top = edge === 0 ? SY - 1 : SY - 8;
        for (let y = GROUND; y <= top; y++) world.setBlock(x, y, z, METAL);
      }
    }
  }
}

function addSymmetricBox(world, x0, y0, z0, x1, y1, z1, type) {
  fillBox(world, x0, y0, z0, x1, y1, z1, type);
  fillBox(world, SX - 1 - x1, y0, SZ - 1 - z1, SX - 1 - x0, y1, SZ - 1 - z0, type);
}

function buildContainer(world, x0, z0, x1, z1, height = 3) {
  fillBox(world, x0, GROUND + 1, z0, x1, GROUND + height, z1, METAL);
  const stripeY = GROUND + Math.min(2, height);
  for (let x = x0; x <= x1; x++) {
    world.setBlock(x, stripeY, z0, ACCENT);
    world.setBlock(x, stripeY, z1, ACCENT);
  }
}

function buildSymmetricContainer(world, x0, z0, x1, z1, height = 3) {
  buildContainer(world, x0, z0, x1, z1, height);
  buildContainer(world, SX - 1 - x1, SZ - 1 - z1, SX - 1 - x0, SZ - 1 - z0, height);
}

function flattenFoundrySite(world, site) {
  const floorY = Math.floor(site.y) - 1;
  for (let z = site.minZ; z <= site.maxZ; z++) {
    for (let x = site.minX; x <= site.maxX; x++) {
      for (let y = 0; y < floorY; y++)
        if (world.getBlock(x, y, z) === AIR) world.setBlock(x, y, z, STONE);
      world.setBlock(x, floorY, z, PALE);
      clearBox(world, x, floorY + 1, z, x, SY - 1, z);
    }
  }
  for (let x = site.minX; x <= site.maxX; x += 3) {
    world.setBlock(x, floorY, site.minZ, ACCENT);
    world.setBlock(x, floorY, site.maxZ, ACCENT);
  }
}

function clearFoundrySpawn(world, heights, x, z) {
  const floorY = heights[z * SX + x];
  clearBox(world, x - 1, floorY + 1, z - 1, x + 1, Math.min(SY - 1, floorY + 4), z + 1);
  world.setBlock(x - 2, floorY + 1, z, ACCENT);
  world.setBlock(x + 2, floorY + 1, z, ACCENT);
}

function polishFoundry(world, heights) {
  for (const site of MAP_SITE_LAYOUTS.foundry) flattenFoundrySite(world, site);

  // A recognizable crane frames mid without closing the lane.
  const craneX = [61, 69], craneZ = 46;
  const craneTop = Math.min(SY - 4, Math.max(...craneX.map((x) => heights[craneZ * SX + x])) + 8);
  for (const x of craneX) {
    const base = heights[craneZ * SX + x];
    fillBox(world, x, base + 1, craneZ, x, craneTop, craneZ, METAL);
  }
  fillBox(world, craneX[0], craneTop, craneZ, craneX[1], craneTop, craneZ, ACCENT);
  fillBox(world, 65, craneTop, craneZ, 65, craneTop, craneZ + 5, METAL);

  // Staggered mid-lane cover keeps every route from becoming a long firing tube.
  for (const [x, z, width] of [[51,43,3],[57,55,2],[72,40,2],[78,53,3]]) {
    const y = heights[z * SX + x] + 1;
    fillBox(world, x - width, y, z, x + width, y + 1, z, CONCRETE);
    world.setBlock(x, y + 2, z, ACCENT);
  }

  const anchors = MAP_SPAWN_ANCHORS.foundry;
  for (const pool of [anchors.fun, anchors.tdm.alpha, anchors.tdm.bravo, anchors.snd.attackers, anchors.snd.defenders])
    for (const [x, z] of pool) clearFoundrySpawn(world, heights, x, z);
}

function generateDepotInto(world, blocks, heights) {
  generateFlatBase(world, blocks, heights);

  paintFloor(world, 52, 34, 75, 61, GROUND, PALE);
  for (let x = 55; x <= 72; x += 4) {
    world.setBlock(x, GROUND, 34, ACCENT);
    world.setBlock(SX - 1 - x, GROUND, 61, ACCENT);
  }

  // West/east loading bases and their exits are exact 180-degree counterparts.
  addSymmetricBox(world, 7, GROUND + 1, 25, 9, GROUND + 5, 42, METAL);
  addSymmetricBox(world, 7, GROUND + 1, 53, 9, GROUND + 5, 70, METAL);
  addSymmetricBox(world, 10, GROUND + 1, 25, 23, GROUND + 3, 27, STONE);
  addSymmetricBox(world, 10, GROUND + 1, 68, 23, GROUND + 3, 70, STONE);
  addSymmetricBox(world, 21, GROUND + 1, 38, 23, GROUND + 4, 44, ACCENT);

  buildSymmetricContainer(world, 29, 17, 39, 23);
  buildSymmetricContainer(world, 31, 68, 41, 75);
  buildSymmetricContainer(world, 44, 25, 52, 30, 2);
  buildSymmetricContainer(world, 43, 44, 50, 48, 2);

  // Low central monument: useful cover without sealing the plaza.
  fillBox(world, 61, GROUND + 1, 45, 66, GROUND + 2, 50, METAL);
  addSymmetricBox(world, 57, GROUND + 1, 39, 58, GROUND + 1, 40, ACCENT);
  addSymmetricBox(world, 69, GROUND + 1, 39, 70, GROUND + 1, 40, ACCENT);
}

function buildRampX(world, x0, x1, z0, z1) {
  for (let x = x0; x <= x1; x++) {
    const top = GROUND + Math.floor((x - x0 + 1) / 2);
    fillBox(world, x, GROUND + 1, z0, x, top, z1, PALE);
  }
}

function buildRampZ(world, z0, z1, x0, x1) {
  for (let z = z0; z <= z1; z++) {
    const top = GROUND + Math.floor((z1 - z + 1) / 2);
    fillBox(world, x0, GROUND + 1, z, x1, top, z, PALE);
  }
}

function generateCitadelInto(world, blocks, heights) {
  generateFlatBase(world, blocks, heights);

  // Northwest A courtyard with offset south/east exits.
  fillBox(world, 13, GROUND + 1, 11, 43, GROUND + 4, 13, STONE);
  fillBox(world, 13, GROUND + 1, 11, 15, GROUND + 4, 41, STONE);
  fillBox(world, 13, GROUND + 1, 39, 24, GROUND + 4, 41, STONE);
  fillBox(world, 33, GROUND + 1, 39, 43, GROUND + 4, 41, STONE);
  fillBox(world, 41, GROUND + 1, 11, 43, GROUND + 4, 23, STONE);
  fillBox(world, 41, GROUND + 1, 30, 43, GROUND + 4, 41, STONE);
  paintFloor(world, 21, 18, 34, 30, GROUND, PALE);
  for (let x = 21; x <= 34; x += 3) world.setBlock(x, GROUND, 18, ACCENT);

  // The keep blocks the direct A-to-B angle. Its offset doors form a zigzag
  // connector, while open north and south rotations remain available.
  fillBox(world, 48, GROUND + 1, 27, 51, GROUND + 6, 51, METAL);
  fillBox(world, 48, GROUND + 1, 59, 51, GROUND + 6, 65, METAL);
  fillBox(world, 75, GROUND + 1, 27, 78, GROUND + 6, 34, METAL);
  fillBox(world, 75, GROUND + 1, 42, 78, GROUND + 6, 65, METAL);
  fillBox(world, 48, GROUND + 1, 27, 78, GROUND + 6, 30, STONE);
  fillBox(world, 48, GROUND + 1, 62, 78, GROUND + 6, 65, STONE);
  fillBox(world, 61, GROUND + 1, 30, 65, GROUND + 5, 52, CONCRETE);
  fillBox(world, 52, GROUND + 1, 42, 58, GROUND + 2, 45, ACCENT);
  fillBox(world, 68, GROUND + 1, 49, 74, GROUND + 2, 52, ACCENT);

  // B is a raised eastern compound with two stair connectors.
  fillBox(world, 88, GROUND + 1, 34, 113, GROUND + 3, 63, CONCRETE);
  fillBox(world, 88, GROUND + 4, 34, 90, GROUND + 7, 51, METAL);
  fillBox(world, 88, GROUND + 4, 59, 90, GROUND + 7, 63, METAL);
  fillBox(world, 88, GROUND + 4, 34, 113, GROUND + 6, 36, STONE);
  fillBox(world, 111, GROUND + 4, 34, 113, GROUND + 6, 63, STONE);
  fillBox(world, 88, GROUND + 4, 61, 101, GROUND + 6, 63, STONE);
  fillBox(world, 109, GROUND + 4, 61, 113, GROUND + 6, 63, STONE);
  paintFloor(world, 97, 42, 108, 54, GROUND + 3, PALE);
  for (let z = 42; z <= 54; z += 3) world.setBlock(108, GROUND + 3, z, ACCENT);
  buildRampX(world, 82, 87, 52, 58);
  buildRampZ(world, 64, 69, 102, 108);

  // Route markers make the long north/south connectors readable at speed.
  for (const [x, z] of [[45,19],[63,19],[81,19],[45,76],[63,76],[81,76]])
    fillBox(world, x, GROUND + 1, z, x, GROUND + 3, z, ACCENT);
}

// ---------------------------------------------------------------- queries

const RING = [...MAP_SPAWN_ANCHORS.foundry.fun.slice(0, 8), [64,48]];

function findSpawnsFor(world, n) {
  const out = [];
  for (const [px, pz] of RING) {
    if (out.length >= n) break;
    const p = freeSpotNear(world, px, pz);
    if (p) out.push(p);
  }
  if (out.length === 0 && n > 0) throw new Error('world has no walkable spawn');
  const unique = out.slice();
  while (out.length < n) out.push({ ...unique[out.length % unique.length] });
  return out;
}

/** Deterministic spread surface spawns. */
export function findSpawns(n) {
  return defaultWorld.findSpawns(n);
}

function freeSpotNear(world, px, pz) {
  const { getBlock, heightAt } = world;
  for (let r = 0; r < 12; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x = px + dx, z = pz + dz;
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

// ---------------------------------------------------------------- serialization

function serializeBlocks(blocks) {
  const out = new Uint8Array(MAP_BYTES);
  out[0] = 86; out[1] = 66; out[2] = MAP_VERSION;
  out[3] = SX; out[4] = SZ; out[5] = SY;
  out.set(blocks, MAP_HEADER_BYTES);
  return out;
}

function validateSerializedWorld(buf) {
  if (!buf || typeof buf.length !== 'number') throw new Error('invalid map buffer');
  if (buf.length !== MAP_BYTES) throw new Error('map length mismatch');
  if (buf[0] !== 86 || buf[1] !== 66) throw new Error('bad magic');
  if (buf[2] !== MAP_VERSION) throw new Error('version mismatch');
  if (buf[3] !== SX || buf[4] !== SZ || buf[5] !== SY) throw new Error('dim mismatch');
}

function rebuildHeights(blocks, heights) {
  for (let z = 0; z < SZ; z++) {
    for (let x = 0; x < SX; x++) {
      let top = -1;
      for (let y = SY - 1; y >= 0; y--) {
        if (blocks[idx(x, y, z)] !== AIR) {
          top = y;
          break;
        }
      }
      heights[z * SX + x] = top;
    }
  }
}

/** 'VB',version,SX,SZ,SY then raw block bytes (~492 KB). */
export function serializeWorld() {
  return defaultWorld.serializeWorld();
}

export function deserializeWorld(buf) {
  validateSerializedWorld(buf);
  data.set(buf.subarray(MAP_HEADER_BYTES, MAP_BYTES));
  defaultWorld.rebuildHeightMap();
}

export function rebuildHeightMap() {
  defaultWorld.rebuildHeightMap();
}

function requireMapId(id) {
  if (typeof id !== 'string' || !MAP_IDS.includes(id)) throw new Error(`unknown map: ${String(id)}`);
  return id;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function spawnIsWalkable(world, spawn) {
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
          const x = px + dx, z = pz + dz;
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

function createMapMetadata(id, world) {
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
    for (const spawn of pool)
      if (!spawnIsWalkable(world, spawn)) throw new Error(`${id} contains an invalid spawn`);
  }
  if (id === 'citadel' && metadata.sites.length === 2) {
    const [a, b] = metadata.sites;
    const overlap = a.minX <= b.maxX && b.minX <= a.maxX
      && a.minZ <= b.maxZ && b.minZ <= a.maxZ;
    if (overlap) throw new Error('citadel plant sites overlap');
  }
  return deepFreeze(metadata);
}

function buildPristineTemplate(id) {
  const blocks = new Uint8Array(SX * SY * SZ);
  const heights = new Int16Array(SX * SZ);
  const world = createStateApi(blocks, heights, null, id);
  if (id === 'foundry') generateInto(world, blocks, heights);
  else if (id === 'depot') generateDepotInto(world, blocks, heights);
  else generateCitadelInto(world, blocks, heights);
  rebuildHeights(blocks, heights);
  return Object.freeze({ blocks, heights, meta: createMapMetadata(id, world) });
}

// The generated cells are authoritative, private baselines. Each template is
// built once; every room receives fresh cells and a fresh top-surface map.
const pristineTemplates = new Map();
for (const id of MAP_IDS) pristineTemplates.set(id, buildPristineTemplate(id));

const defaultTemplate = pristineTemplates.get('foundry');
data.set(defaultTemplate.blocks);
heightMap.set(defaultTemplate.heights);

export function getMapMeta(id) {
  return pristineTemplates.get(requireMapId(id)).meta;
}

export function createMapState(id, serializedBytes) {
  const template = pristineTemplates.get(requireMapId(id));
  let blocks;
  let heights;
  if (serializedBytes === undefined) {
    blocks = template.blocks.slice();
    heights = template.heights.slice();
  } else {
    validateSerializedWorld(serializedBytes);
    blocks = new Uint8Array(template.blocks.length);
    blocks.set(serializedBytes.subarray(MAP_HEADER_BYTES, MAP_BYTES));
    heights = new Int16Array(SX * SZ);
    rebuildHeights(blocks, heights);
  }
  return createStateApi(blocks, heights, template.meta.spawns.fun, id, template.meta);
}

export function createWorldState(serializedBytes) {
  return createMapState('foundry', serializedBytes);
}
