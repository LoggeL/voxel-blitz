import { fbm2, mulberry32 } from '../noise.js';
import {
  AIR,
  GRASS,
  DIRT,
  STONE,
  SAND,
  WOOD,
  LEAVES,
  CONCRETE,
  METAL,
  ACCENT,
  PLANK,
  GLASS,
  PALE,
  SX,
  SZ,
  SY,
  GROUND,
  SEED,
} from './blocks.js';

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

const FOUNDRY_SITE_LAYOUTS = [
  { id: 'A', minX: 46, maxX: 53, minZ: 68, maxZ: 75, y: GROUND + 1.02 },
  { id: 'B', minX: 76, maxX: 83, minZ: 20, maxZ: 27, y: GROUND + 1.02 },
];

const FOUNDRY_SPAWN_ANCHORS = {
  fun: [[16,16],[112,16],[112,80],[16,80],[64,14],[64,82],[20,48],[108,48],[52,40],[76,56],[40,72],[88,24]],
  tdm: {
    alpha: [[13,16],[14,32],[14,48],[14,64],[16,80],[25,48]],
    bravo: [[114,80],[113,64],[113,48],[113,32],[111,16],[102,48]],
  },
  snd: {
    attackers: [[42,82],[52,82],[64,82],[76,82],[86,82]],
    defenders: [[42,13],[52,13],[64,13],[76,13],[86,13]],
  },
};

export function terrainHeight(x, z) {
  const n1 = fbm2(x * 0.032, z * 0.032, SEED, 4);
  const n2 = fbm2(x * 0.11 + 40, z * 0.11 + 40, SEED + 7, 3);
  const h = GROUND + Math.round(n1 * 7 + n2 * 1.5);
  return Math.max(4, Math.min(GROUND + 10, h));
}

export function foundryLadderVolumes() {
  return TOWERS.map(({ cx, cz }) => {
    const floorY = terrainHeight(cx, cz - 2) + 1;
    const deckY = terrainHeight(cx, cz) + 12;
    return {
      minX: cx + 0.05,
      maxX: cx + 0.95,
      minY: floorY,
      maxY: deckY,
      minZ: cz - 1.95,
      maxZ: cz - 1.2,
    };
  });
}

export function generateFoundryInto(world, blocks, heights) {
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

  for (const tower of TOWERS) buildTower(world, tower.cx, tower.cz);
  for (const house of HOUSES) buildHouse(world, house.cx, house.cz, house.w, house.d);

  // scattered cover on open ground
  const rng = mulberry32(SEED ^ 0xbeef);
  for (let i = 0; i < 110; i++) {
    const x = 6 + ((rng() * (SX - 12)) | 0);
    const z = 6 + ((rng() * (SZ - 12)) | 0);
    if (nearStructure(x, z)) continue;
    const h = heightAt(x, z);
    const kind = rng();
    if (kind < 0.5) setBlock(x, h + 1, z, CONCRETE);
    else if (kind < 0.8) {
      setBlock(x - 1, h + 1, z, CONCRETE);
      setBlock(x, h + 1, z, CONCRETE);
      setBlock(x + 1, h + 1, z, CONCRETE);
    } else {
      setBlock(x, h + 1, z, CONCRETE);
      setBlock(x + 1, h + 1, z, ACCENT);
      setBlock(x, h + 2, z, PALE);
    }
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

function nearStructure(x, z) {
  for (const tower of TOWERS) {
    if (Math.abs(x - tower.cx) < 10 && Math.abs(z - tower.cz) < 10) return true;
  }
  for (const house of HOUSES) {
    if (Math.abs(x - house.cx) < house.w + 2 && Math.abs(z - house.cz) < house.d + 2) return true;
  }
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
        if (corner) {
          setBlock(x, y, z, METAL);
          continue;
        }
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
  for (let dz = -R + 1; dz <= R - 1; dz += 2) {
    setBlock(cx - R + 1, topY + 1, cz + dz, ACCENT);
    setBlock(cx + R - 1, topY + 1, cz + dz, ACCENT);
  }
  for (let dx = -R + 1; dx <= R - 1; dx += 2) {
    setBlock(cx + dx, topY + 1, cz - R + 1, ACCENT);
    setBlock(cx + dx, topY + 1, cz + R - 1, ACCENT);
  }
  setBlock(cx, topY + 1, cz, WOOD);
  setBlock(cx, topY + 2, cz, WOOD);
  setBlock(cx, topY + 3, cz, ACCENT);
  // south entrance
  for (let y = baseH + 1; y <= baseH + 2; y++) setBlock(cx, y, cz - R, AIR);
  // exterior step ramp (east side)
  let sy = baseH + 1;
  for (let dz = cz - R + 1; dz <= cz + R + 4; dz += 2) {
    for (let step = 0; step < 2; step++, sy++) {
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
        if (y === base + 3 && !midX && !midZ) {
          setBlock(x, y, z, GLASS);
          continue;
        }
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
  for (let z = z0; z < z0 + d; z++) {
    setBlock(x0, ty + 1, z, ACCENT);
    setBlock(x0 + w - 1, ty + 1, z, ACCENT);
  }
  for (let x = x0; x < x0 + w; x++) {
    setBlock(x, ty + 1, z0, ACCENT);
    setBlock(x, ty + 1, z0 + d - 1, ACCENT);
  }
  // roof stair ramp along west wall (double-wide, climbable steps)
  for (let step = 0; step <= H; step++) {
    for (let zz = 0; zz < 2; zz++) {
      setBlock(x0 - 1, base + 1 + step, z0 + 2 + step + zz, PALE);
      setBlock(x0 - 2, base + 1 + step, z0 + 2 + step + zz, PALE);
    }
  }
}

function fillBox(world, x0, y0, z0, x1, y1, z1, type) {
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++)
        world.setBlock(x, y, z, type);
}

function clearBox(world, x0, y0, z0, x1, y1, z1) {
  fillBox(world, x0, y0, z0, x1, y1, z1, AIR);
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
  for (const site of FOUNDRY_SITE_LAYOUTS) flattenFoundrySite(world, site);

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

  for (const pool of [
    FOUNDRY_SPAWN_ANCHORS.fun,
    FOUNDRY_SPAWN_ANCHORS.tdm.alpha,
    FOUNDRY_SPAWN_ANCHORS.tdm.bravo,
    FOUNDRY_SPAWN_ANCHORS.snd.attackers,
    FOUNDRY_SPAWN_ANCHORS.snd.defenders,
  ]) {
    for (const [x, z] of pool) clearFoundrySpawn(world, heights, x, z);
  }
}
