// Roadside dressing between the sites. From the HQ plateaus the open ground
// read as a bare field crossed by a black ribbon of road; along the roads,
// outside every flag zone and HQ, this adds what a fought-over valley shows:
// telegraph poles and a dashed centre line on the paved axis, worn verges,
// tyre ruts leaving the roads, shrub clumps, timber fences, sandbag nests and
// scorch marks with scattered debris toward the front.
//
// Placements are authored on the west bank and point-mirrored onto the east
// bank; a prop is built only where both banks are open ground (plain terrain,
// no set piece, no water, no field), so the halves stay fair. Every prop keeps
// at least 1.5 m off the road edge and is at most two voxels tall except the
// 8 m poles. Runs after the sites and before buildEntrances/reopenRoads.

import { FRONTIER_PLAN } from '../../conquest-contract.js';
import {
  LEAVES, TIMBER, PLANK, BARRICADE, RUST, METAL, DUST_CRATE, DIRT, MUD, GRAVEL, MEADOW, DRY_GRASS,
  SCORCHED_EARTH, PALE, ASPHALT, MC_WATER,
} from '../blocks.js';
import {
  FRONTIER_ROAD_PLAN, FRONTIER_FIELDS, FRONTIER_CELL_KIND as KIND, insideCombatArea, polylineAt, valueNoise,
} from '../frontier-terrain.js';
import { mirroredKit, seededRandom } from './kit.js';
import { roadClearance } from './plan.js';

const OPEN_TOPS = new Set([MEADOW, DRY_GRASS, DIRT, MUD, SCORCHED_EARTH, GRAVEL]);
const GRASS_TOPS = new Set([MEADOW, DRY_GRASS]);
/** Metres kept clear beyond each flag radius and HQ radius. */
const FLAG_MARGIN = 14;
const HQ_MARGIN = 14;
/** West-bank authoring limit (x): the east bank is the mirror. */
const WEST_X = FRONTIER_PLAN.dimensions.sx / 2 - 6;
const WEST_ROADS = new Set(['axis', 'hq-west-a', 'hq-west-b', 'a-c', 'b-c', 'a-d-ford', 'north-loop']);
/** Battle-scarred ground starts here (x, west bank): scorch, debris and sandbags. */
const FRONT_X = 236;

const inField = (x, z) => FRONTIER_FIELDS.some(f => x >= f.x0 - 1 && x < f.x1 + 1 && z >= f.z0 - 1 && z < f.z1 + 1);

function clearOfObjectives(x, z) {
  for (const f of FRONTIER_PLAN.flags) if (Math.hypot(x + 0.5 - f.x, z + 0.5 - f.z) < f.radius + FLAG_MARGIN) return false;
  for (const hq of Object.values(FRONTIER_PLAN.hqs)) if (Math.hypot(x + 0.5 - hq.x, z + 0.5 - hq.z) < hq.radius + HQ_MARGIN) return false;
  return true;
}

/** Plain, unbuilt terrain on one bank (x, z in that kit's authored coordinates). */
function openOn(kit, x, z, tops) {
  const bx = kit.mirrored ? kit.SX - 1 - x : x, bz = kit.mirrored ? kit.SZ - 1 - z : z;
  if (bx < 1 || bz < 1 || bx >= kit.SX - 1 || bz >= kit.SZ - 1) return false;
  if (!insideCombatArea(bx + 0.5, bz + 0.5) || !clearOfObjectives(bx, bz) || inField(bx, bz)) return false;
  if (kit.terrain.kind[bz * kit.SX + bx] !== KIND.GROUND) return false;
  const g = kit.top(x, z);
  if (!tops.has(kit.get(x, g, z)) || kit.get(x, g + 1, z) === MC_WATER) return false;
  return kit.surface(x, z) === g;
}

/**
 * Builds the roadside dressing into `kit` (and its mirror). Returns counts per
 * prop kind for tests and the docs.
 */
export function buildRoadside(kit) {
  const banks = [kit, mirroredKit(kit)];
  const rng = seededRandom(0x524f4144);
  const stats = { poles: 0, centreLine: 0, verge: 0, ruts: 0, shrubs: 0, fences: 0, sandbags: 0, scorch: 0, debris: 0 };
  const open = (x, z, tops = OPEN_TOPS, clear = 1.5) =>
    x < WEST_X && roadClearance(x + 0.5, z + 0.5) >= clear && banks.every(b => openOn(b, x, z, tops));
  const paint = (x, z, m) => { for (const b of banks) b.paint(x, z, m); };

  // Paved axis: dashed centre line (paint only) and a worn gravel verge.
  const axis = FRONTIER_ROAD_PLAN.find(r => r.id === 'axis');
  const [ax0, , ] = axis.points[0];
  for (let x = Math.ceil(ax0); x < WEST_X; x++) {
    if (x % 9 < 4 && banks.every(b => b.get(x, b.top(x, 383), 383) === ASPHALT)) { paint(x, 383, PALE); stats.centreLine++; }
  }
  for (let z = 360; z <= 408; z++) for (let x = Math.ceil(ax0); x < WEST_X; x++) {
    const c = roadClearance(x + 0.5, z + 0.5);
    if (c < 0 || c > 1.4) continue;
    const n = valueNoise(x / 4, z / 4, 211);
    if (n < -0.25 || !open(x, z, GRASS_TOPS, 0)) continue;
    paint(x, z, n > 0.2 ? GRAVEL : DIRT); stats.verge++;
  }
  // Telegraph poles on the north verge of the axis: an 8 m pole whose cross-arm,
  // one voxel below the top, spans across the line.
  for (let x = Math.ceil(ax0) + 6; x < WEST_X; x += 23) {
    const z = 375;
    if (!open(x, z)) continue;
    for (const b of banks) {
      const g = b.top(x, z);
      b.box(x, g + 1, z, x, g + 8, z, TIMBER);
      b.box(x, g + 7, z - 1, x, g + 7, z + 1, PLANK);
    }
    stats.poles++;
  }

  // Walk every west road: ruts, shrubs, fences, sandbags, scorch and debris.
  for (const road of FRONTIER_ROAD_PLAN.filter(r => WEST_ROADS.has(r.id))) {
    let length = 0;
    for (let i = 1; i < road.points.length; i++) length += Math.hypot(road.points[i][0] - road.points[i - 1][0], road.points[i][1] - road.points[i - 1][1]);
    const half = road.width / 2;
    let nextRut = 20 + rng() * 30, nextFence = 20 + rng() * 30, nextNest = 40 + rng() * 40;
    for (let s = 6; s < length - 6; s += 3) {
      const p = polylineAt(road.points, s);
      if (p.x >= WEST_X) continue;
      const nx = -p.dz, nz = p.dx;                         // left normal
      const side = rng() < 0.5 ? 1 : -1;
      const front = p.x >= FRONT_X;

      // Tyre ruts: a vehicle left the road here and cut across the grass.
      if (s >= nextRut) {
        nextRut = s + 30 + rng() * 45;
        const turn = (0.35 + rng() * 0.5) * (rng() < 0.5 ? 1 : -1), bend = (rng() - 0.5) * 0.03;
        let heading = Math.atan2(p.dz, p.dx) + turn * side;
        let x = p.x + nx * side * (half + 0.5), z = p.z + nz * side * (half + 0.5);
        const run = 16 + rng() * 22;
        let painted = 0;
        for (let t = 0; t < run; t += 0.5) {
          x += Math.cos(heading) * 0.5; z += Math.sin(heading) * 0.5; heading += bend;
          const px = -Math.sin(heading), pz = Math.cos(heading);
          for (const k of [-1, 1]) {
            const cx = Math.floor(x + px * k * 1.1), cz = Math.floor(z + pz * k * 1.1);
            if (!open(cx, cz, GRASS_TOPS, 0)) continue;
            paint(cx, cz, valueNoise(cx / 3, cz / 3, 223) > 0 ? MUD : DIRT); painted++;
          }
        }
        if (painted) stats.ruts++;
      }

      // Shrub clumps on the verge and the field beyond, 3-15 m off the edge.
      if (rng() < 0.3) {
        const off = half + 3 + rng() * rng() * 12;
        const cx = Math.floor(p.x + nx * side * off), cz = Math.floor(p.z + nz * side * off);
        const cells = [[0, 0]];
        for (let k = 0; k < 2 + Math.floor(rng() * 4); k++) cells.push([Math.floor(rng() * 3) - 1, Math.floor(rng() * 3) - 1]);
        const unique = [...new Set(cells.map(c => c.join(',')))].map(c => c.split(',').map(Number));
        if (unique.every(([dx, dz]) => open(cx + dx, cz + dz, OPEN_TOPS, 2.5))) {
          const tall = rng() < 0.5;
          for (const b of banks) for (const [dx, dz] of unique) {
            const g = b.top(cx + dx, cz + dz);
            b.box(cx + dx, g + 1, cz + dz, cx + dx, g + (tall && !dx && !dz ? 2 : 1), cz + dz, LEAVES);
          }
          stats.shrubs++;
        }
      }

      // Timber fence runs along the roads, 4 m off the edge, posts every 3 m.
      if (s >= nextFence) {
        nextFence = s + 50 + rng() * 50;
        const run = 10 + Math.floor(rng() * 10), off = half + 4;
        const cells = [];
        for (let k = 0; k < run; k++) {
          const q = polylineAt(road.points, s + k);
          cells.push([Math.floor(q.x + -q.dz * side * off), Math.floor(q.z + q.dx * side * off)]);
        }
        const unique = [...new Map(cells.map(c => [c.join(','), c])).values()];
        let built = 0;
        unique.forEach(([x, z], k) => {
          if (!open(x, z, OPEN_TOPS, 2.5)) return;
          for (const b of banks) {
            const g = b.top(x, z);
            if (k % 3 === 0) b.box(x, g + 1, z, x, g + 2, z, TIMBER);
            else b.set(x, g + 2, z, PLANK);
          }
          built++;
        });
        if (built) { stats.fences++; for (const b of banks) b.feature('cover', { cover: 'fence', x: unique[0][0], z: unique[0][1], height: 2 }); }
      }

      if (!front) continue;
      // Sandbag nests facing the road on the approaches to the front.
      if (s >= nextNest) {
        nextNest = s + 55 + rng() * 45;
        const off = half + 6;
        const cx = Math.floor(p.x + nx * side * off), cz = Math.floor(p.z + nz * side * off);
        const face = Math.atan2(-nz * side, -nx * side);   // toward the road
        const cells = [];
        for (let a = -1.6; a <= 1.6; a += 0.4) cells.push([Math.round(cx + Math.cos(face + a) * 2), Math.round(cz + Math.sin(face + a) * 2)]);
        const unique = [...new Map(cells.map(c => [c.join(','), c])).values()];
        if (unique.every(([x, z]) => open(x, z, OPEN_TOPS, 2))) {
          for (const b of banks) for (const [x, z] of unique) { const g = b.top(x, z); b.set(x, g + 1, z, BARRICADE); }
          for (const b of banks) b.feature('cover', { cover: 'sandbags', x: cx, z: cz, height: 1 });
          stats.sandbags++;
        }
      }
      // Scorch marks with scattered wreckage.
      if (rng() < 0.12) {
        const off = half + 2 + rng() * 9;
        const cx = p.x + nx * side * off, cz = p.z + nz * side * off, r = 1.4 + rng() * 1.4;
        let marked = 0;
        for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
          if (Math.hypot(x + 0.5 - cx, z + 0.5 - cz) > r || !open(x, z, OPEN_TOPS, 1)) continue;
          paint(x, z, SCORCHED_EARTH); marked++;
        }
        if (marked) stats.scorch++;
        for (let k = 0; k < 1 + Math.floor(rng() * 3); k++) {
          const x = Math.floor(cx + (rng() - 0.5) * 6), z = Math.floor(cz + (rng() - 0.5) * 6);
          const m = [RUST, METAL, DUST_CRATE, PLANK][Math.floor(rng() * 4)];
          if (!open(x, z, OPEN_TOPS, 2)) continue;
          for (const b of banks) b.set(x, b.top(x, z) + 1, z, m);
          stats.debris++;
        }
      }
    }
  }
  return stats;
}
