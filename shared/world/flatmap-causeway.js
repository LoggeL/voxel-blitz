import { AIR, BEDROCK, CONCRETE, METAL, STONE, PALE, RUST, ACCENT, WOOD, GROUND } from './blocks.js';
import { fillBox, paintFloor } from './flatmaps.js';
import { CAUSEWAY_LAYOUT } from './causeway-layout.js';

const G = GROUND;

/**
 * Causeway: an overcast concrete dam crossing between two rock masses.
 * Enemies push west from the East Gate to the Extraction Pad; each hold stage
 * breaches from an alternating side chamber and its vehicles roll down the
 * passage onto the road. Sized from world.dimensions (192 x 144 x 40).
 */
export function generateCausewayInto(world, blocks, heights) {
  const { sx: SX, sz: SZ, sy: SY } = world.dimensions;
  blocks.fill(AIR);
  heights.fill(G);
  fillBox(world, 0, 0, 0, SX - 1, G - 1, SZ - 1, BEDROCK);
  paintFloor(world, 0, 0, SX - 1, SZ - 1, G, CONCRETE);
  for (const [x0, z0, x1, z1] of [[0, 0, 3, SZ - 1], [SX - 4, 0, SX - 1, SZ - 1], [0, 0, SX - 1, 3], [0, SZ - 4, SX - 1, SZ - 1]]) {
    fillBox(world, x0, G, z0, x1, SY - 1, z1, BEDROCK);
  }
  // Rock masses north and south of the corridor, and the east cap.
  fillBox(world, 4, G + 1, 4, 187, G + 10, 43, BEDROCK);
  fillBox(world, 4, G + 1, 100, 187, G + 10, 139, BEDROCK);
  fillBox(world, 184, G + 1, 44, 187, G + 10, 99, BEDROCK);
  // Skin the corridor-facing rock faces and the mass tops with lighter,
  // destructible strata so the dam reads as concrete between cliffs. The
  // passage carving below still opens every mouth; the three cells flanking
  // each mouth stay BEDROCK so the route protection pass leaves no stubs.
  skinRockFaces(world);
  for (const x of [20, 44, 68, 92, 116, 140, 164]) {
    fillBox(world, x, G + 11, 40, x + 2, G + 13, 42, METAL);
    fillBox(world, x, G + 11, 101, x + 2, G + 13, 103, METAL);
  }
  // Lamp posts along both corridor edges. The two that would stand in a
  // vehicle route strip are left out so the protection pass leaves no stubs.
  for (let x = 16; x <= 176; x += 16) for (const z of [46, 97]) {
    if ((x === 64 && z === 46) || (x === 32 && z === 97)) continue;
    fillBox(world, x, G + 1, z, x, G + 5, z, METAL);
    world.setBlock(x, G + 6, z, ACCENT);
  }
  // East chamber: a walled staging hall with two openings and a baffle.
  fillBox(world, 166, G + 1, 44, 167, G + 7, 99, BEDROCK);
  fillBox(world, 166, G + 1, 56, 167, G + 7, 63, AIR);
  fillBox(world, 166, G + 1, 80, 167, G + 7, 87, AIR);
  fillBox(world, 174, G + 1, 66, 175, G + 7, 77, BEDROCK);
  fillBox(world, 166, G + 8, 44, 183, G + 8, 99, BEDROCK);
  paintFloor(world, 168, 52, 183, 91, G, BEDROCK);
  // Side chambers carved into the rock: chamber, passage, baffle, trim. The
  // north baffles sit at z27-28 so the vehicle route start (z31) keeps 1.4 m clear.
  for (const [x0, x1, zc0, zc1, px0, px1, pz0, pz1, bz, trimZ] of [
    [128, 147, 22, 33, 134, 141, 34, 43, 27, 43], [56, 75, 22, 33, 62, 69, 34, 43, 27, 43],
    [96, 115, 110, 121, 102, 109, 100, 109, 114, 100], [24, 43, 110, 121, 30, 37, 100, 109, 114, 100],
  ]) {
    fillBox(world, x0, G + 1, zc0, x1, G + 7, zc1, AIR);
    fillBox(world, px0, G + 1, pz0, px1, G + 7, pz1, AIR);
    fillBox(world, px0, G + 1, bz, px1, G + 7, bz + 1, BEDROCK);
    paintFloor(world, x0, zc0, x1, zc1, G, BEDROCK);
    paintFloor(world, px0, pz0, px1, pz1, G, BEDROCK);
    fillBox(world, px0 - 1, G + 8, trimZ, px1 + 1, G + 8, trimZ, ACCENT);
  }
  // Floor: the vehicle road, edge stripes, centre dashes and the extraction pad.
  paintFloor(world, 8, 70, 183, 73, G, BEDROCK);
  paintFloor(world, 8, 47, 183, 47, G, PALE);
  paintFloor(world, 8, 96, 183, 96, G, PALE);
  for (let x = 12; x <= 183; x += 6) world.setBlock(x, G, 71, ACCENT);
  paintFloor(world, 10, 66, 22, 78, G, PALE);
  paintFloor(world, 13, 68, 13, 76, G, ACCENT);
  paintFloor(world, 19, 68, 19, 76, G, ACCENT);
  paintFloor(world, 13, 72, 19, 72, G, ACCENT);
  for (const s of CAUSEWAY_LAYOUT.stages) {
    const ox = Math.floor(s.objective.x), oz = Math.floor(s.objective.z);
    paintFloor(world, ox - 3, oz - 3, ox + 3, oz + 3, G, BEDROCK);
  }
  // Pump house: an open roof on four pillars.
  for (const [x, z] of [[104, 64], [120, 64], [104, 80], [120, 80]]) fillBox(world, x, G + 1, z, x, G + 5, z, METAL);
  fillBox(world, 104, G + 5, 64, 120, G + 5, 80, METAL);
  for (const z of [64, 80]) fillBox(world, 104, G + 4, z, 120, G + 4, z, ACCENT);
  // Sluice walls either side of the control yard.
  for (const z of [60, 82]) {
    fillBox(world, 70, G + 1, z, 82, G + 3, z + 2, STONE);
    fillBox(world, 70, G + 4, z, 82, G + 4, z + 2, METAL);
  }
  // Tower base ring; the mast itself is rendered by the client.
  fillBox(world, 40, G + 1, 70, 44, G + 1, 74, METAL);
  fillBox(world, 41, G + 1, 71, 43, G + 1, 73, AIR);
  // Destructible cover per segment, all clear of the passages and the road.
  crateStack(world, 152, 50); crateStack(world, 152, 90);
  fillBox(world, 156, G + 1, 62, 156, G + 2, 66, RUST);
  fillBox(world, 156, G + 1, 77, 156, G + 2, 81, RUST);
  tank(world, 128, 48); tank(world, 128, 94);
  fillBox(world, 124, G + 1, 50, 128, G + 2, 50, CONCRETE);
  fillBox(world, 124, G + 1, 93, 128, G + 2, 93, CONCRETE);
  crateStack(world, 94, 50); crateStack(world, 94, 90);
  for (const [x, z] of [[98, 66], [98, 67], [98, 77], [98, 78]]) fillBox(world, x, G + 1, z, x, G + 2, z, RUST);
  cabinets(world, 60, 50); cabinets(world, 60, 92);
  fillBox(world, 54, G + 1, 62, 54, G + 2, 66, CONCRETE);
  fillBox(world, 54, G + 1, 78, 54, G + 2, 82, CONCRETE);
  fillBox(world, 30, G + 1, 60, 34, G + 1, 60, RUST);
  fillBox(world, 30, G + 1, 84, 34, G + 1, 84, RUST);
  crateStack(world, 36, 50); crateStack(world, 36, 90);
  protectLayout(world, CAUSEWAY_LAYOUT);
}

function skinRockFaces(world) {
  const strata = (n, y) => (y === G + 7 ? PALE : n % 3 === 0 ? CONCRETE : STONE);
  const flank = (x, mouths) => mouths.some(([a, b]) => (x >= a - 3 && x <= a - 1) || (x >= b + 1 && x <= b + 3));
  for (const [z, mouths] of [[43, [[134, 141], [62, 69]]], [100, [[102, 109], [30, 37]]]]) {
    for (let x = 4; x <= 183; x++) {
      if (flank(x, mouths)) continue;
      for (let y = G + 1; y <= G + 10; y++) world.setBlock(x, y, z, strata(x, y));
    }
  }
  for (let z = 44; z <= 99; z++) for (let y = G + 1; y <= G + 10; y++) world.setBlock(184, y, z, strata(z, y));
  for (const [x0, z0, x1, z1] of [[4, 4, 187, 43], [4, 100, 187, 139], [184, 44, 187, 99]]) paintFloor(world, x0, z0, x1, z1, G + 10, STONE);
}

function crateStack(world, x, z) {
  fillBox(world, x, G + 1, z, x + 3, G + 1, z + 2, RUST);
  fillBox(world, x + 1, G + 2, z, x + 2, G + 2, z + 1, WOOD);
  world.setBlock(x, G + 2, z + 2, PALE);
}

function tank(world, x, z) {
  fillBox(world, x - 1, G + 1, z - 1, x + 1, G + 4, z + 1, STONE);
  fillBox(world, x - 1, G + 5, z - 1, x + 1, G + 5, z + 1, METAL);
  for (let n = -1; n <= 1; n++) { world.setBlock(x + n, G + 3, z - 1, ACCENT); world.setBlock(x + n, G + 3, z + 1, ACCENT); }
}

function cabinets(world, x, z) {
  for (const [cx, cz] of [[x, z], [x + 2, z + 1], [x, z + 2]]) {
    fillBox(world, cx, G + 1, cz, cx, G + 3, cz, METAL);
    world.setBlock(cx, G + 4, cz, ACCENT);
  }
}

/**
 * Protection pass shared by every Bastion map (a copy lives in each generator):
 * indestructible pads under every authored point, a cleared and armoured strip
 * along every vehicle route, and an accent outline around each build zone.
 */
function protectLayout(world, layout) {
  const pad = (p, r) => paintFloor(world, Math.floor(p.x) - r, Math.floor(p.z) - r, Math.floor(p.x) + r, Math.floor(p.z) + r, G, BEDROCK);
  for (const lane of layout.lanes) pad(lane.entry, 1);
  for (const s of layout.stages) {
    for (const p of [...s.spawns, ...s.defenders, s.supply]) pad(p, 1);
    for (let i = 1; i < s.vehicleRoute.length; i++) {
      const a = s.vehicleRoute[i - 1], b = s.vehicleRoute[i];
      const len = Math.hypot(b.x - a.x, b.z - a.z), steps = Math.max(1, Math.ceil(len / 0.5));
      for (let n = 0; n <= steps; n++) {
        const t = Math.min(1, n / steps), cx = Math.floor(a.x + (b.x - a.x) * t), cz = Math.floor(a.z + (b.z - a.z) * t);
        paintFloor(world, cx - 2, cz - 2, cx + 2, cz + 2, G, BEDROCK);
        for (let y = G + 1; y <= G + 4; y++) for (let z = cz - 2; z <= cz + 2; z++) for (let x = cx - 2; x <= cx + 2; x++) {
          if (world.getBlock(x, y, z) !== BEDROCK) world.setBlock(x, y, z, AIR);
        }
      }
    }
    const { minX, maxX, minZ, maxZ } = s.buildZone;
    for (let x = minX; x <= maxX; x++) for (const z of [minZ, maxZ]) if (world.getBlock(x, G, z) === CONCRETE) world.setBlock(x, G, z, ACCENT);
    for (let z = minZ; z <= maxZ; z++) for (const x of [minX, maxX]) if (world.getBlock(x, G, z) === CONCRETE) world.setBlock(x, G, z, ACCENT);
  }
}
