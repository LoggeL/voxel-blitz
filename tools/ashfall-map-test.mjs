// Ashfall, the dedicated Titanfall Attrition map (docs/titanfall.md §14):
//  - registry: id, name, dimensions, titanfall-only compatibility, 8v8 capacity;
//  - exact 180-degree point symmetry, team colours in the yards excepted;
//  - 16 street-level spawns per team in their own yard, each with a ground
//    route to the arena and to the enemy yard;
//  - titan drop zones (the TitanSystem.call rules: level, dry, 12 voxels of
//    open sky, a way out) in every yard, on both boulevards, both ring roads,
//    both approach yards and inside the arena;
//  - every titan frame stands on the lane centre lines and walks the ring
//    breaches; none fits into the pilot alleys or through a pilot doorway;
//  - long unbroken wallrun walls along the alleys and streets;
//  - high bridges: a deck with pilot headroom at both building mouths and at
//    least 9 m clearance for titans walking under;
//  - the authored lamps all stand;
//  - titan layer: every chassis flood-fills (step <= maxStep, slope <= maxSlope)
//    from its yard to both yards, every lane end to end (round the lane cover),
//    both approach yards, both ore dock tops and both halves of the arena, and
//    never climbs onto the pilot layer; every lane keeps 9 m of open headroom
//    (the lane cover pieces aside); no line along a lane stays clear at titan
//    eye height for more than ASHFALL_MAX_SIGHTLINE; the arena's outer band
//    holds hull-down cover at titan chest height;
//  - pilot layer: walking, one-voxel steps, drops and the authored ladders
//    (no wallruns, no double jumps) from the spawn reach the yard towers, the
//    gantries, the Pour Line, the crane jib, the high bridges, every perch deck
//    and every battery cache; no raised spot a pilot walks to sees into a
//    spawn within 24 m;
//  - wallruns: the blast-wall slalom gap and the cross-street billboard gaps
//    leave a metre of margin to the widest gap a chained wall jump clears under
//    the live PILOT_RULES, and a simulated pilot runs the real slalom wall to wall;
//  - rodeo perches: deck 7 m up beside a lane, inside a sprint-jump leap of
//    the lane centre, away from the spawns;
//  - the Pour: slag (lava) in the pool and runners burns pilots and titans; the
//    runners leave through the ring wall; a titan sees the pool over the rim;
//  - battery caches: on the street route graph, one battery each at match start, refilled
//    BATTERY_CACHE_MS after a pickup, never expiring.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { getMapMeta, createMapState } from '../shared/world/templates.js';
import { MAP_IDS, MAP_MODE_COMPATIBILITY, isModeMapCompatible } from '../shared/modes.js';
import { lobbyCapacity, MAP_PLAYER_LIMITS } from '../shared/lobby-limits.js';
import { getMapDimensions } from '../shared/world/dimensions.js';
import { AIR, GROUND, ACCENT, SLIDE_BLUE, TEAL_SIDING, YELLOW_SIDING, isSolidBlock } from '../shared/world/blocks.js';
import { LARGE_MAP_LIGHTS, lightFixtureGeometry } from '../shared/world/large-map-lights.js';
import { ASHFALL_CENTER, ASHFALL_ARENA, ASHFALL_TITAN_LANES, ASHFALL_MIRROR, ASHFALL_BLAST_WALLS, ASHFALL_DOCKS, ASHFALL_HIGH_DECK,
  ASHFALL_GANTRIES, ASHFALL_YARD_TOWERS, ASHFALL_POUR_LINE, ASHFALL_CRANE, ASHFALL_PERCHES, PERCH_TOP, ASHFALL_BATTERY_CACHES,
  BATTERY_CACHE_MS, ASHFALL_LADDERS, ASHFALL_POUR, ASHFALL_LANE_COVER, ASHFALL_MAX_SIGHTLINE, ASHFALL_ARENA_COVER,
  ASHFALL_BILLBOARDS } from '../shared/world/ashfall-layout.js';
import { MC_LAVA } from '../shared/world/blocks.js';
import { walkerSlope } from '../shared/vehicle-handling/titan.js';
import { PILOT_RULES, createPilotState } from '../shared/pilot-movement.js';
import { PHYSICS } from '../shared/player-movement.js';
import { PlayerEntity } from '../server/sim/player.js';
import { stepMovement } from '../server/sim/movement.js';
import { FLUID_BLOCKS } from '../shared/world/blocks.js';
import { groundRoute } from '../server/bot-navigation.js';
import { TitanfallBots } from '../server/bot-titanfall.js';
import { placeWalker, TITAN_RULES } from '../shared/vehicle-handling/titan.js';
import { TITAN_TYPE_IDS } from '../shared/titan-contract.js';

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; console.log(`  ok ${msg}`); };

const ID = 'ashfall';
const world = createMapState(ID), meta = getMapMeta(ID);
const { sx, sy, sz } = world.dimensions;
const block = (x, y, z) => world.getBlock(x, y, z);
const T = GROUND;

// ---------------------------------------------------------------- registry
ok(MAP_IDS.includes(ID) && MAP_IDS.at(-1) === 'frontier', 'ashfall is a map id (frontier stays last)');
ok(meta.name === 'Ashfall' && sx === 224 && sy === 40 && sz === 176
  && getMapDimensions(ID) === world.dimensions || (getMapDimensions(ID).sx === 224 && getMapDimensions(ID).sz === 176),
'Ashfall is 224 x 40 x 176');
ok(MAP_MODE_COMPATIBILITY[ID].length === 1 && isModeMapCompatible('titanfall', ID) && !isModeMapCompatible('tdm', ID),
  'Ashfall is a titanfall-only map');
ok(MAP_PLAYER_LIMITS[ID] === 16 && lobbyCapacity('titanfall', ID) === 16, 'Ashfall seats 8v8');
ok(meta.navigationFloor === GROUND && meta.sites.length === 0, 'street-level route graph, no bomb sites');

// ---------------------------------------------------------------- symmetry
{
  const swaps = new Map([[SLIDE_BLUE, ACCENT], [ACCENT, SLIDE_BLUE], [TEAL_SIDING, YELLOW_SIDING], [YELLOW_SIDING, TEAL_SIDING]]);
  let mismatched = 0, outsideYards = 0;
  for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    const a = block(x, y, z), b = block(sx - 1 - x, y, sz - 1 - z);
    if (a === b) continue;
    mismatched++;
    if ((x >= 3 && x <= 29) || (x >= sx - 30 && x <= sx - 4)) { if (swaps.get(a) !== b) outsideYards++; }
    else outsideYards++;
  }
  ok(outsideYards === 0, `point-symmetric about (${(sx - 1) / 2}, ${(sz - 1) / 2}); only team colours differ in the yards (${mismatched} team cells)`);
}

// ------------------------------------------------------------------ spawns
const { alpha, bravo } = meta.spawns.tdm;
ok(alpha.length === 16 && bravo.length === 16 && meta.spawns.fun.length === 32, '16 spawns per team (32 free-for-all)');
ok([...alpha, ...bravo].every(s => s.y === T + 1.02), 'every spawn stands on the street');
ok(alpha.every(s => s.x < 30) && bravo.every(s => s.x > sx - 30), 'MILITIA spawns in the west yard, IMC in the east yard');
ok([alpha, bravo].every(pool => pool.every((s, i) => pool.every((o, j) => i === j || Math.hypot(s.x - o.x, s.z - o.z) >= 4))),
  'spawns stand at least 4 m apart');
{
  // Inside the cooling ring, between the smelter core and the toppled west segment.
  const centre = { x: ASHFALL_CENTER.x - 11.5, y: T + 1.02, z: ASHFALL_CENTER.z + 0.5 };
  const toArena = [...alpha, ...bravo].filter(s => groundRoute(world, s, centre).length > 0).length;
  ok(toArena === 32, `every spawn has a ground route to the arena (${toArena}/32)`);
  const across = alpha.filter((s, i) => groundRoute(world, s, bravo[i]).length > 0).length;
  ok(across === 16, `every MILITIA spawn has a ground route into the IMC yard (${across}/16)`);
}

// ------------------------------------------------------- titans and drops
const engine = new GameEngine({ mode: 'titanfall', mapMeta: meta, world, broadcast: () => {} });
try {
  const bots = new TitanfallBots(engine), titans = engine.vehicles.titans, tworld = titans.world;
  const stands = (type, x, z, yaw = 0) => Number.isFinite(placeWalker({ type, x, y: T + 1, z, yaw }, x, z, tworld));
  const dropZone = (x, z) => bots.openGround(x, T + 1, z) && TITAN_TYPE_IDS.every(type => titans.wayOut(type, x, T + 1, z));
  const zones = {
    'militia yard': [6, 24, 22, 152], 'imc yard': [sx - 25, sx - 7, 22, 152],
    'north boulevard': [32, 191, 21, 32], 'south boulevard': [32, 191, sz - 33, sz - 22],
    'west ring road': [31, 42, 22, 153], 'east ring road': [sx - 43, sx - 32, 22, 153],
    'west approach yard': [46, 80, 72, 104], 'east approach yard': [sx - 81, sx - 47, 72, 104],
    arena: [ASHFALL_CENTER.x - 28, ASHFALL_CENTER.x + 28, ASHFALL_CENTER.z - 28, ASHFALL_CENTER.z + 28],
  };
  let total = 0;
  for (const [name, [x0, x1, z0, z1]] of Object.entries(zones)) {
    let n = 0;
    for (let x = x0 + 0.5; x <= x1; x += 4) for (let z = z0 + 0.5; z <= z1; z += 4) if (dropZone(x, z)) n++;
    total += n;
    ok(n >= 4, `${name}: titans can land (${n} drop points on a 4 m grid)`);
  }
  ok(total >= 250, `drop zones across the map (${total})`);
  // Every frame stands along every lane centre line, at both lane headings (past the lane
  // cover, which fills a whole carriageway: the flood below walks round it).
  let laneFails = [];
  const byCover = (x, z) => ASHFALL_LANE_COVER.some(([x0, z0, x1, z1]) => x > x0 - 2.5 && x < x1 + 3.5 && z > z0 - 2.5 && z < z1 + 3.5);
  for (const [x0, z0, x1, z1] of ASHFALL_TITAN_LANES) {
    const alongX = x1 - x0 >= z1 - z0, cx = (x0 + x1 + 1) / 2, cz = (z0 + z1 + 1) / 2;
    for (let t = 2; t <= (alongX ? x1 - x0 : z1 - z0) - 2; t += 2) {
      const x = alongX ? x0 + t + 0.5 : cx, z = alongX ? cz : z0 + t + 0.5;
      if (byCover(x, z)) continue;
      for (const type of TITAN_TYPE_IDS) if (!stands(type, x, z, alongX ? Math.PI / 2 : 0)) laneFails.push(`${type}@${x},${z}`);
    }
  }
  ok(laneFails.length === 0, `every titan frame stands on every lane centre line away from the lane cover${laneFails.length ? ` (${laneFails.slice(0, 6).join(' ')})` : ''}`);
  // The four ring breaches: a hull walks from outside the ring to inside along each diagonal.
  for (const [dx, dz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
    const yaw = Math.atan2(-dx, -dz), fails = [];
    for (let r = ASHFALL_ARENA.ringInner - 4; r <= ASHFALL_ARENA.ringOuter + 5; r += 1) {
      const x = ASHFALL_CENTER.x + dx * r / Math.SQRT2, z = ASHFALL_CENTER.z + dz * r / Math.SQRT2;
      for (const type of TITAN_TYPE_IDS) if (!stands(type, x, z, yaw)) fails.push(`${type}@r${r}`);
    }
    ok(fails.length === 0, `titans walk the ${dz < 0 ? 'north' : 'south'}-${dx < 0 ? 'west' : 'east'} ring breach${fails.length ? ` (${fails.slice(0, 4).join(' ')})` : ''}`);
  }
  // Pilot spaces. The alleys are 4 m wide (a hull would fit side to side), so
  // they are closed to titans by gates: a low skybridge (4 m clearance) across
  // every mouth. No frame stands anywhere in a gate, at
  // any heading, so no titan walks into an alley. Building interiors (3 m
  // pilot doors, storeys well under a titan's height) hold no frame; the tall
  // Smelter Hall does, but its doorways are pilot sized.
  const yaws = [0, Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4];
  const pilotOnly = {
    'Hab alley north gate': [56, 59, 36, 37], 'Hab alley south gate': [56, 59, 66, 67],
    'tenement N-S alley north gate': [167, 170, 36, 37], 'tenement N-S alley south gate': [167, 170, 66, 67],
    'tenement E-W alley gate': [155, 156, 52, 55],
    'Hab tower ground floor': [47, 53, 38, 49], 'tenement ground floor': [173, 177, 54, 65],
    'smelter hall west door': [83, 83, 44, 46], 'smelter hall east door': [104, 104, 44, 46], 'smelter hall south door': [96, 98, 55, 55], 'barracks': [4, 7, 80, 95],
  };
  for (const [name, [x0, x1, z0, z1]] of Object.entries(pilotOnly)) {
    for (const flip of [false, true]) {
      const fits = [];
      for (let x = x0; x <= x1 + 1; x += 0.5) for (let z = z0; z <= z1 + 1; z += 0.5) {
        const [px, pz] = flip ? [sx - x, sz - z] : [x, z];
        for (const type of TITAN_TYPE_IDS) if (yaws.some(yaw => stands(type, px, pz, yaw))) fits.push(`${type}@${px},${pz}`);
      }
      const at = flip ? `${sx - 1 - x1}..${sx - 1 - x0}, ${sz - 1 - z1}..${sz - 1 - z0}` : `${x0}..${x1}, ${z0}..${z1}`;
      ok(fits.length === 0, `${name} (${at}) holds no titan${fits.length ? ` (${fits.slice(0, 4).join(' ')})` : ''}`);
    }
  }
} finally { engine.stop(); }

// ------------------------------------------------------------ pilot routes
{
  // Longest unbroken solid run along a wall line at pilot wallrun heights (feet +0.3, +1.0, +1.8 above y0).
  const run = (fixed, axis, from, to, y0) => {
    let best = 0, cur = 0;
    for (let t = from; t <= to; t++) {
      const [x, z] = axis === 'z' ? [fixed, t] : [t, fixed];
      const solid = [0, 1, 2].every(dy => isSolidBlock(block(x, y0 + dy, z)));
      cur = solid ? cur + 1 : 0; best = Math.max(best, cur);
    }
    return best;
  };
  const walls = [
    ['Hab alley, tower side', 55, 'z', 36, 67, T + 4], ['Hab alley, annex side', 60, 'z', 36, 67, T + 4],
    ['tenement alley, west side', 166, 'z', 36, 51, T + 4], ['tenement alley, east side', 171, 'z', 36, 67, T + 4],
    ['smelter hall, cross street face', 83, 'z', 36, 55, T + 4], ['admin block, centre street face', 119, 'z', 36, 55, T + 4],
  ];
  for (const [name, fixed, axis, from, to, y0] of walls) {
    const n = run(fixed, axis, from, to, y0);
    ok(n >= 12, `${name}: ${n} m unbroken wallrun wall`);
  }
  // High bridges: deck solid, pilot headroom at the mouths, titan clearance below.
  const bridges = [['Hab -> Smelter', 69, 82, 45], ['Smelter -> admin', 105, 118, 41], ['relay -> tenements', 141, 154, 41]];
  for (const [name, x0, x1, z] of bridges) {
    for (const [ax, bx, zz] of [[x0, x1, z], [sx - 1 - x1, sx - 1 - x0, sz - 1 - z]]) {
      let deck = true, head = true, under = true;
      for (let x = ax - 1; x <= bx + 1; x++) {
        if (x >= ax && x <= bx && !isSolidBlock(block(x, T + 12, zz))) deck = false;
        if (block(x, T + 13, zz) !== AIR || block(x, T + 14, zz) !== AIR) head = false;
      }
      for (let x = ax + 1; x < bx; x++) for (let y = T + 1; y <= T + 9; y++) if (block(x, y, zz) !== AIR) under = false;
      ok(deck && head && under, `${name} bridge (${ax}..${bx}, z ${zz}): deck, open mouths, 9 m under`);
    }
  }
}

// ------------------------------------------------------------------- lamps
{
  const lights = LARGE_MAP_LIGHTS[ID];
  const standing = lights.filter(light => lightFixtureGeometry(light).cells.every(([x, y, z, type]) => block(x, y, z) === type));
  ok(lights.length >= 20 && standing.length === lights.length, `all ${lights.length} authored lamps stand (${standing.length})`);
}

// --------------------------------------------------------------- titan layer
const rot = ([x, z]) => [ASHFALL_MIRROR.x - x, ASHFALL_MIRROR.z - z];
let ionGround = null;   // titan_ion flood heights: where a hull's centre stands
{
  const engine2 = new GameEngine({ mode: 'titanfall', mapMeta: meta, world, broadcast: () => {} });
  try {
    const tworld = engine2.vehicles.titans.world;
    const HEADINGS_X = [Math.PI / 2, Math.PI / 4, 3 * Math.PI / 4, 0], HEADINGS_Z = [0, Math.PI / 4, 3 * Math.PI / 4, Math.PI / 2];
    const flood = (type, sx0, sz0) => {
      const height = new Float32Array(sx * sz).fill(NaN), queue = [];
      height[sz0 * sx + sx0] = T + 1; queue.push(sz0 * sx + sx0);
      for (let head = 0; head < queue.length; head++) {
        const cell = queue[head], x = cell % sx, z = (cell - x) / sx, y = height[cell];
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, nz = z + dz, next = nz * sx + nx;
          if (nx < 1 || nz < 1 || nx >= sx - 1 || nz >= sz - 1 || !Number.isNaN(height[next])) continue;
          // A hull turns on the spot: any of four headings that stands there will do.
          let support = null;
          for (const yaw of dx ? HEADINGS_X : HEADINGS_Z) {
            const v = { type, x: x + 0.5, y, z: z + 0.5, yaw };
            const s = placeWalker(v, nx + 0.5, nz + 0.5, tworld);
            if (s === null || !Number.isFinite(s)) continue;
            if (s > y + 1e-3) {
              const slope = walkerSlope(v, nx + 0.5, nz + 0.5, dx, dz, tworld);
              if (slope !== null && slope > TITAN_RULES.maxSlope) continue;
            }
            support = s; break;
          }
          if (support === null) continue;
          height[next] = support; queue.push(next);
        }
      }
      return height;
    };
    const targets = {
      'IMC yard': [207, 87, T + 1], 'west approach yard': [77, 89, T + 1], 'east approach yard': [...rot([77, 89]), T + 1],
      'west ore dock top': [59, 90, T + 4], 'east ore dock top': [...rot([59, 90]), T + 4],
      'arena, west of the Pour': [ASHFALL_CENTER.x - 12, ASHFALL_CENTER.z, T + 1], 'arena, east of the Pour': [ASHFALL_CENTER.x + 12, ASHFALL_CENTER.z, T + 1],
      'north centre street': [111, 40, T + 1], 'south centre street': [...rot([111, 40]), T + 1],
    };
    for (const type of TITAN_TYPE_IDS) {
      const h = flood(type, 16, 88);
      if (type === 'titan_ion') ionGround = h;
      const missing = Object.entries(targets).filter(([, [x, z, y]]) => h[z * sx + x] !== y).map(([name]) => name);
      const laneMiss = [];
      for (const [x0, z0, x1, z1] of ASHFALL_TITAN_LANES) {
        const cx = Math.floor((x0 + x1) / 2), cz = Math.floor((z0 + z1) / 2);
        for (const [x, z] of [[cx, cz], [x0 + 2, cz], [x1 - 2, cz], [cx, z0 + 2], [cx, z1 - 2]]) {
          if (!(h[z * sx + x] === T + 1)) laneMiss.push(`${x},${z}`);
        }
        // End to end: every metre along the lane, some cell across it (or across the
        // neighbouring carriageway, round a cover piece) holds the hull.
        const alongX = x1 - x0 >= z1 - z0;
        for (let t = alongX ? x0 : z0; t <= (alongX ? x1 : z1); t++) {
          const [a0, a1] = alongX ? [z0 - 8, z1 + 8] : [x0 - 8, x1 + 8];
          let any = false;
          for (let c = a0; c <= a1 && !any; c++) if (h[(alongX ? c * sx + t : t * sx + c)] === T + 1) any = true;
          if (!any) { laneMiss.push(`${alongX ? `x ${t}, z ${z0}-${z1}` : `z ${t}, x ${x0}-${x1}`} blocked`); break; }
        }
      }
      let high = 0, where = '';
      // The slag heaps in the outskirts corners are open hills; everywhere else the highest titan ground
      // is the ore dock (feet T + 4) and its 1 m parapet.
      for (let i = 0; i < h.length; i++) {
        const z = Math.floor(i / sx);
        if (z >= 20 && z < sz - 20 && h[i] > T + 5.5 && h[i] - T > high) { high = h[i] - T; where = `${i % sx},${z}`; }
      }
      ok(missing.length === 0 && laneMiss.length === 0,
        `${type} walks from the MILITIA yard to the IMC yard, every lane, both approach yards, dock tops and arena halves${missing.length || laneMiss.length ? ` (missing ${[...missing, ...laneMiss.slice(0, 6)].join('; ')})` : ''}`);
      ok(high === 0, `${type} never climbs above the ore docks onto the pilot layer${high ? ` (y +${high} at ${where})` : ''}`);
    }
  } finally { engine2.stop(); }
  // Headroom: nothing between the street and 9 m up over a lane, the lane cover pieces aside.
  const blocked = [];
  const inCover = (x, z) => ASHFALL_LANE_COVER.some(([x0, z0, x1, z1]) => x >= x0 && x <= x1 && z >= z0 && z <= z1);
  for (const [x0, z0, x1, z1] of ASHFALL_TITAN_LANES) {
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = T + 1; y <= T + 9; y++) {
      if (inCover(x, z)) break;
      if (isSolidBlock(block(x, y, z))) { blocked.push(`${x},${y - T},${z}`); break; }
    }
  }
  ok(blocked.length === 0, `every titan lane has 9 m of open headroom${blocked.length ? ` (${blocked.length} columns: ${blocked.slice(0, 6).join(' ')})` : ''}`);
  // Sightlines: along every row of every boulevard and ring road (both carriageways and the
  // median line), the longest run of open cells at titan eye height (5.6-6.1 m over the feet).
  let longest = 0, where = '';
  for (const [x0, z0, x1, z1] of ASHFALL_TITAN_LANES) {
    const alongX = x1 - x0 >= z1 - z0;
    if ((alongX ? x1 - x0 : z1 - z0) < 100) continue;   // the boulevards and ring roads
    // A carriageway, and the median line beyond it when the other carriageway follows.
    const median = ASHFALL_TITAN_LANES.some(o => (alongX ? o[0] === x0 && o[1] === z1 + 3 : o[1] === z0 && o[0] === x1 + 3)) ? 2 : 0;
    const [c0, c1] = alongX ? [z0, z1 + median] : [x0, x1 + median];
    for (let c = c0; c <= c1; c++) for (const y of [T + 6, T + 7]) {
      let run = 0;
      for (let t = alongX ? x0 : z0; t <= (alongX ? x1 : z1); t++) {
        const open = !isSolidBlock(alongX ? block(t, y, c) : block(c, y, t));
        run = open ? run + 1 : 0;
        if (run > longest) { longest = run; where = alongX ? `z ${c}, x ${t - run + 1}-${t}` : `x ${c}, z ${t - run + 1}-${t}`; }
      }
    }
  }
  ok(longest <= ASHFALL_MAX_SIGHTLINE, `no line along a boulevard or ring road is clear at titan eye height for more than ${ASHFALL_MAX_SIGHTLINE} m (longest ${longest} m at ${where})`);
  // Hull-down cover in the arena's outer band (between the ring and the kerb): cells solid at titan chest height.
  let band = 0, chest = 0;
  for (let z = ASHFALL_CENTER.z - 30; z <= ASHFALL_CENTER.z + 30; z++) for (let x = ASHFALL_CENTER.x - 30; x <= ASHFALL_CENTER.x + 30; x++) {
    const r = Math.hypot(x + 0.5 - ASHFALL_CENTER.x, z + 0.5 - ASHFALL_CENTER.z);
    if (r < 21.5 || r > 29.5) continue;
    band++;
    if (isSolidBlock(block(x, T + 5, z))) chest++;
  }
  ok(chest >= 12 * ASHFALL_ARENA_COVER.length * 2, `the arena's outer band holds hull-down cover (${chest} of ${band} cells solid at titan chest height, ${ASHFALL_ARENA_COVER.length * 2} ingot stacks)`);
}

// --------------------------------------------------------------- pilot layer
{
  const solid = (x, y, z) => isSolidBlock(block(x, y, z));
  const index = (x, y, z) => (y * sz + z) * sx + x;
  const ladderCell = new Set();
  for (const l of ASHFALL_LADDERS) for (let y = Math.floor(l.minY); y < Math.ceil(l.maxY); y++) ladderCell.add(index(Math.floor(l.minX), y, Math.floor(l.minZ)));
  const clear = (x, y, z) => x >= 0 && z >= 0 && x < sx && z < sz && y > 0 && y + 1 < sy && !solid(x, y, z) && !solid(x, y + 1, z)
    && !FLUID_BLOCKS.has(block(x, y, z)) && !FLUID_BLOCKS.has(block(x, y + 1, z));
  const stand = (x, y, z) => clear(x, y, z) && (solid(x, y - 1, z) || ladderCell.has(index(x, y, z)));
  const seen = new Uint8Array(sx * sy * sz), queue = [];
  const push = (x, y, z) => { const i = index(x, y, z); if (!seen[i]) { seen[i] = 1; queue.push(i); } };
  push(10, T + 1, 44);
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head], x = i % sx, z = Math.floor(i / sx) % sz, y = Math.floor(i / (sx * sz));
    if (ladderCell.has(i)) {
      if (clear(x, y + 1, z) && ladderCell.has(index(x, y + 1, z))) push(x, y + 1, z);
      if (y > 1 && clear(x, y - 1, z)) push(x, y - 1, z);
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (stand(nx, y, nz)) { push(nx, y, nz); continue; }
      // A one-voxel step (a jump) needs headroom over the takeoff; a ladder top steps off sideways.
      if (stand(nx, y + 1, nz) && !solid(x, y + 2, z)) { push(nx, y + 1, nz); continue; }
      if (!clear(nx, y, nz)) continue;
      for (let fy = y - 1; fy >= Math.max(1, y - 16); fy--) {
        if (!clear(nx, fy, nz)) break;
        if (stand(nx, fy, nz)) { push(nx, fy, nz); break; }
      }
    }
  }
  // y: the feet level, or { above } for any level higher than that.
  const reached = (x0, z0, x1, z1, y) => {
    const [y0, y1] = typeof y === 'number' ? [y, y] : [y.above + 1, sy - 2];
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let yy = y0; yy <= y1; yy++) if (seen[index(x, yy, z)]) return true;
    return false;
  };
  const both = (name, [x0, z0, x1, z1], y) => {
    const [rx0, rz0] = rot([x1, z1]), [rx1, rz1] = rot([x0, z0]);
    ok(reached(x0, z0, x1, z1, y) && reached(rx0, rz0, rx1, rz1, y), `pilots walk up to the ${name} (both halves, by stairs and ladders)`);
  };
  const HIGH = T + ASHFALL_HIGH_DECK + 1;
  for (const [cx, cz] of ASHFALL_YARD_TOWERS.slice(0, 2)) both(`yard tower deck at ${cx},${cz}`, [cx - 3, cz - 3, cx + 3, cz + 3], HIGH);
  for (const g of ASHFALL_GANTRIES.slice(0, 2)) both(`ring-road gantry at z ${g[1]}`, g, HIGH);
  const L = ASHFALL_POUR_LINE;
  for (const z of [50, 70, 88, 110, 125]) ok(reached(L.x0, z, L.x1, z, HIGH), `pilots walk the Pour Line deck at z ${z}`);
  const C = ASHFALL_CRANE;
  both('toppled crane jib', [C.x0, C.z0 + 6, C.x1, C.z1 - 6], { above: T + C.top1 });
  for (const [name, x0, x1, z] of [['Hab -> Smelter', 69, 82, 45], ['Smelter -> admin', 105, 118, 41], ['relay -> tenements', 141, 154, 41]]) {
    both(`${name} bridge`, [x0 + 2, z, x1 - 2, z], HIGH);
  }
  for (const pch of ASHFALL_PERCHES) {
    const [x0, z0, x1, z1] = pch.deck;
    ok(reached(x0, z0, x1, z1, T + PERCH_TOP + 1), `pilots walk up the ${pch.id} perch stair to its deck`);
  }
  for (const c of ASHFALL_BATTERY_CACHES) ok(seen[index(Math.floor(c.x), Math.floor(c.y), Math.floor(c.z))] === 1, `pilots reach the battery cache at ${c.x},${c.z}`);
  // Spawn overlooks: no raised spot a pilot walks to (feet 8 m or more over the street: the
  // high line, upper floors, roofs) within 24 m of a spawn sees that spawn's body. (The outer
  // blocks' facades and roofs face the yard from 25 m, across the ring road.)
  const solidAt = (x, y, z) => solid(Math.floor(x), Math.floor(y), Math.floor(z));
  const sees = (a, b) => {
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / 0.1);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (solidAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t)) return false;
    }
    return true;
  };
  const spawns = [...meta.spawns.tdm.alpha, ...meta.spawns.tdm.bravo];
  let raised = 0;
  const overlooks = [];
  for (const i of queue) {
    const x = i % sx, z = Math.floor(i / sx) % sz, y = Math.floor(i / (sx * sz));
    if (y < T + 9) continue;
    const eye = { x: x + 0.5, y: y + 1.6, z: z + 0.5 };
    for (const s of spawns) {
      if (Math.hypot(eye.x - s.x, eye.z - s.z) > 24) continue;
      raised++;
      if (sees(eye, { x: s.x, y: s.y + 1, z: s.z })) overlooks.push(`${x},${y - T},${z} -> ${s.x},${s.z}`);
    }
  }
  ok(raised > 100 && overlooks.length === 0, `no raised spot a pilot walks to sees into a spawn within 24 m (${raised} spot-spawn pairs${overlooks.length ? `; ${overlooks.length} see: ${overlooks.slice(0, 4).join(', ')}` : ''})`);
}

// ----------------------------------------------------------------- wallruns
{
  const DT = 1 / 60;
  const body = (solid, fluid, pos) => {
    const p = new PlayerEntity('pilot', 'Pilot', { ...pos }, false);
    Object.assign(p, { grounded: true, deployT: 0 });
    p.pilot = createPilotState(); p.input = { yaw: 0, pitch: 0, keys: {} };
    const ctx = { solidAt: solid, fluidAt: fluid, mapMeta: meta, now: 0, pilotRules: true, onFall: () => {} };
    const step = (k = {}) => {
      Object.assign(p.input.keys, { f: !!k.f, b: false, l: false, r: false, jump: !!k.jump, crouch: false, sprint: !!k.sprint, prone: false });
      p.input.yaw = k.yaw ?? 0; p.input.viewYaw = p.input.yaw;
      if (p.coyote > 0) p.coyote -= DT;
      ctx.now += DT * 1000;
      stepMovement(p, DT, ctx);
    };
    return { p, step };
  };
  // Widest wall-to-wall gap a chain clears (two parallel walls in open space, the live PILOT_RULES).
  const crossable = (gap, chain, dbl) => {
    const solid = (x, y, z) => y < 10 || ((z === 0 || z === 1 + gap) && x >= 0 && x < 60 && y < 30);
    const { p, step } = body(solid, null, { x: 2.5, y: 13, z: 1 + PHYSICS.halfW + 0.05 });
    Object.assign(p, { grounded: false, vx: PILOT_RULES.wallrun.speed, vy: 0, vz: 0 });
    p.pilot.lastGroundY = 10; p.pilot.chain = chain;
    let jumped = false, onA = false, doubled = false, t = 0;
    for (let i = 0; i < 300; i++) {
      let jump = false;
      if (p.pilot.wall && !jumped && t > 0.25) { jump = true; jumped = true; }
      const air = jumped && !p.pilot.wall;
      if (dbl && air && !doubled && p.vy < 0.5) { jump = true; doubled = true; }
      step({ f: true, sprint: true, yaw: air && dbl ? -Math.PI / 2 - 0.6 : -Math.PI / 2, jump });
      t += DT;
      if (p.pilot.wall && !jumped) onA = true;
      if (jumped && p.pilot.wall) return onA;
      if (p.grounded) return false;
    }
    return false;
  };
  const widest = (chain, dbl) => { let max = 0; for (let g = 2; g <= 14; g++) if (crossable(g, chain, dbl)) max = g; return max; };
  const rows = [...new Set(ASHFALL_BLAST_WALLS.filter(w => w[0] < 112).map(w => w[1]))];
  const slalomGap = Math.abs(rows[1] - rows[0]) - 1;
  const single = widest(2, false), double = widest(2, true);
  ok(single >= slalomGap + 1 && double >= slalomGap + 1.5,
    `the blast-wall slalom gap (${slalomGap} m) leaves a metre to a chained wallrun's reach (${single} m on a wall jump, ${double} m with the double jump)`);
  {
    // The cross-street billboards (and their rotation): facade x 68, three boards, facade x 83.
    const B = ASHFALL_BILLBOARDS, faces = [68, ...B.xs, 83];
    const gaps = faces.slice(1).map((x, i) => x - faces[i] - 1);
    let boards = true, under = true;
    for (const flip of [false, true]) for (const x of B.xs) for (let z = B.z0; z <= B.z1; z++) {
      const [px, pz] = flip ? rot([x, z]) : [x, z];
      for (let y = T + B.y0; y <= T + B.y1; y++) if (!isSolidBlock(block(px, y, pz))) boards = false;
      for (let y = T + 1; y < T + B.y0; y++) if (block(px, y, pz) !== AIR) under = false;
    }
    const facades = [[68, B.z0, B.z0 + 5], [83, B.z0, B.z1]].every(([x, z0, z1]) => {
      for (let z = z0; z <= z1; z++) for (let y = T + 12; y <= T + 13; y++) if (!isSolidBlock(block(x, y, z))) return false;
      return true;
    });
    ok(boards && under && facades && Math.max(...gaps) <= single - 1,
      `cross-street billboards: ${gaps.join(' / ')} m gaps from facade to board to facade (a wall jump clears ${single} m), ${B.y0 - 1} m of street under them`);
  }
  // The real slalom: sprint, jump onto the first wall, wall-jump (and double-jump) to each next one.
  const run = (x0, z0, dir, mirror) => {
    const solid = (x, y, z) => isSolidBlock(block(x, y, z)), fluid = (x, y, z) => FLUID_BLOCKS.has(block(x, y, z));
    const { p, step } = body(solid, fluid, { x: x0, y: T + 1, z: z0 });
    const walls = ASHFALL_BLAST_WALLS.filter(w => (w[0] < 112) !== mirror).sort((a, b) => dir * (a[0] - b[0]));
    const touched = new Set();
    let idx = -1, from = -1, doubled = false;
    for (let i = 0; i < 600; i++) {
      const onWall = p.pilot.wall !== 0;
      if (onWall) {
        const k = walls.findIndex(([wx0, wz, wx1]) => p.x >= wx0 - 1 && p.x <= wx1 + 2 && Math.abs(p.z - (wz + 0.5)) < 1.5);
        if (k >= 0) { touched.add(k); idx = k; }
      }
      let jump = i === 20, yaw = dir > 0 ? -Math.PI / 2 : Math.PI / 2;
      const edge = idx >= 0 ? (dir > 0 ? walls[idx][2] - 2.5 : walls[idx][0] + 3.5) : 0;
      if (onWall && idx >= 0 && idx < walls.length - 1 && from !== idx && dir * (p.x - edge) >= 0) { jump = true; from = idx; doubled = false; }
      if (!p.grounded && !onWall && from >= 0 && from === idx) {
        const toward = walls[idx + 1][1] > walls[idx][1] ? 1 : -1;
        yaw += -dir * toward * 0.5;
        if (!doubled && p.vy < 0.3) { jump = true; doubled = true; }
      }
      step({ f: true, sprint: true, yaw, jump });
      if (p.grounded && i > 30 && touched.size) break;
    }
    return touched.size;
  };
  const west = run(42.5, 74.45, 1, false);
  const [ex, ez] = rot([42.5, 74.45]);
  const east = run(ex + 1, ez + 1, -1, true);
  ok(west === 4 && east === 4, `a pilot wallruns the blast-wall slalom wall to wall (west ${west}/4, east ${east}/4 walls)`);
}

// ------------------------------------------------------------ rodeo perches
{
  const g = PHYSICS.gravity, vy = PHYSICS.jump;
  for (const pch of ASHFALL_PERCHES) {
    const [x0, z0, x1, z1] = pch.deck;
    const top = T + PERCH_TOP + 1;
    const solidDeck = [...Array(x1 - x0 + 1).keys()].every(i => [...Array(z1 - z0 + 1).keys()].every(j => isSolidBlock(block(x0 + i, T + PERCH_TOP, z0 + j))));
    // Leap: sprint off the deck edge with a jump, landing on a titan's back (TITAN_RULES backY ~4.6-5 m).
    const drop = PERCH_TOP - 5, air = (vy + Math.sqrt(vy * vy + 2 * g * drop)) / g, reach = PILOT_RULES.sprint * air;
    // Nearest street cell a titan's centre walks to (the ion flood), from the deck edge.
    let nearest = Infinity;
    for (let z = z0 - 12; z <= z1 + 12; z++) for (let x = x0 - 12; x <= x1 + 12; x++) {
      if (x < 0 || z < 0 || x >= sx || z >= sz || ionGround[z * sx + x] !== T + 1) continue;
      const dx = Math.max(0, x0 - (x + 0.5), x + 0.5 - (x1 + 1)), dz = Math.max(0, z0 - (z + 0.5), z + 0.5 - (z1 + 1));
      nearest = Math.min(nearest, Math.hypot(dx, dz));
    }
    const spawn = Math.min(...meta.spawns.fun.map(s => Math.hypot(s.x - (x0 + x1 + 1) / 2, s.z - (z0 + z1 + 1) / 2)));
    ok(solidDeck && block(x0 + 1, top, z0 + 1) === AIR && block(x0 + 1, top + 1, z0 + 1) === AIR && nearest + 1 <= reach && spawn >= 20,
      `${pch.id} perch: deck ${PERCH_TOP} m up, ${nearest.toFixed(1)} m from where a titan walks (sprint-jump leap ${reach.toFixed(1)} m), ${spawn.toFixed(0)} m from the nearest spawn`);
    // Closed under the treads: an open stair underside let a bot walk in and wedge on a frame post.
    const [sx0, sz0, sx1, sz1, dir] = pch.stair;
    const alongX = dir[1] === 'x', up = dir[0] === '+' ? 1 : -1, first = alongX ? (up > 0 ? sx0 : sx1) : (up > 0 ? sz0 : sz1);
    let open = 0;
    for (let z = sz0; z <= sz1; z++) for (let x = sx0; x <= sx1; x++) {
      const tread = T + 1 + ((alongX ? x : z) - first) * up;
      for (let y = T + 1; y <= tread; y++) if (!isSolidBlock(block(x, y, z))) open++;
    }
    ok(open === 0, `${pch.id} perch: no open cell under the stair treads (${open})`);
  }
}

// ---------------------------------------------------------------- the Pour
{
  const { x: cx, z: cz } = ASHFALL_CENTER;
  ok(block(cx, T + 1, cz) === MC_LAVA && block(cx - 3, T + 1, cz) === MC_LAVA, 'the crucible pool is molten slag');
  ok(ASHFALL_POUR.runner.every(x => block(x, T, cz - 10) === MC_LAVA && block(x, T, cz + 10) === MC_LAVA), 'both slag runners carry slag across the inner ring');
  const spawnLava = meta.spawns.fun.some(s => {
    for (let x = Math.floor(s.x) - 20; x <= s.x + 20; x++) for (let z = Math.floor(s.z) - 20; z <= s.z + 20; z++) {
      for (let y = T; y <= T + 3; y++) if (block(x, y, z) === MC_LAVA) return true;
    }
    return false;
  });
  ok(!spawnLava, 'no slag within 20 m of a spawn');
  {
    // Out through the ring wall: a 2 m culvert over the runner, a pit beyond it.
    const zWall = Math.floor(cz - (ASHFALL_ARENA.ringInner + ASHFALL_ARENA.ringOuter) / 2), zPit = Math.floor(cz - ASHFALL_POUR.runOut + 0.6);
    const culvert = ASHFALL_POUR.runner.every(x => block(x, T, zWall) === MC_LAVA && block(x, T + 1, zWall) === AIR && block(x, T + 2, zWall) === AIR
      && isSolidBlock(block(x, T + 3, zWall)) && block(x, T, zPit) === MC_LAVA);
    ok(culvert, 'the slag runners leave the ring through culverts in its wall into slag pits');
    // A titan on the inner ring floor sees the slag over the 2 m rim.
    const eye = { x: cx - 11.5, y: T + 1 + 5.6, z: cz + 0.5 }, slag = { x: cx - ASHFALL_POUR.pool + 2.5, y: T + 1.9, z: cz + 0.5 };
    let clear = true;
    for (let i = 1; i < 200; i++) {
      const t = i / 200, x = eye.x + (slag.x - eye.x) * t, y = eye.y + (slag.y - eye.y) * t, z = eye.z + (slag.z - eye.z) * t;
      if (isSolidBlock(block(Math.floor(x), Math.floor(y), Math.floor(z)))) clear = false;
    }
    ok(clear && block(Math.floor(slag.x), T + 1, Math.floor(slag.z)) === MC_LAVA, `a titan on the inner ring floor sees the slag pool over the ${ASHFALL_POUR.rimHeight} m rim`);
  }
  const engine3 = new GameEngine({ mode: 'titanfall', mapMeta: meta, world, broadcast: () => {} });
  try {
    engine3.addBot('lava-test', 'Lava');
    const p = engine3.entities.get('lava-test');
    Object.assign(p, { x: ASHFALL_POUR.runner[0] + 0.5, y: T + 0.2, z: cz - 10 + 0.5, state: 'alive', hp: 100 });
    for (let i = 0; i < 10; i++) engine3.applyMapVolumes(p, 0.05);
    ok(p.hp < 100, `a pilot in a slag runner burns (100 -> ${Math.round(p.hp)} hp in 0.5 s)`);
    const titans = engine3.vehicles.titans;
    const v = titans.spawnDrop({ id: 'lava-owner', team: 'alpha' }, cx + 0.5, T + 1, cz - 14.5, 'titan_ion', 0);
    while (engine3.now < v.landsAt + 100) engine3.step(50);
    Object.assign(v, { x: ASHFALL_POUR.runner[0] + 1, z: cz - 10 + 0.5, y: T, grounded: true });
    const hull0 = v.hp + (v.shield ?? 0);
    titans.lava(v, 0.5);
    const burnt = hull0 - v.hp - (v.shield ?? 0);
    ok(burnt > 0, `a titan wading a slag runner burns (${Math.round(burnt)} hp in 0.5 s)`);
  } finally { engine3.stop(); }
}

// ----------------------------------------------------------- battery caches
{
  const engine4 = new GameEngine({ mode: 'titanfall', mapMeta: meta, world: createMapState(ID), broadcast: () => {} });
  try {
    const bats = engine4.vehicles.titans.bats;
    engine4.vehicles.titans.step(0.05);
    const routed = ASHFALL_BATTERY_CACHES.filter(c => groundRoute(world, alpha[0], c).length > 0).length;
    ok(routed === ASHFALL_BATTERY_CACHES.length, `every battery cache is on the street route graph (${routed}/${ASHFALL_BATTERY_CACHES.length} routed from a spawn)`);
    const cached = bats.list.filter(b => b.cache !== undefined);
    ok(cached.length === ASHFALL_BATTERY_CACHES.length && cached.every(b => b.expiresAt === Infinity),
      `every battery cache holds a battery at match start (${cached.length}/${ASHFALL_BATTERY_CACHES.length}), none expires`);
    const c = ASHFALL_BATTERY_CACHES[0];
    const pilot = { id: 'cache-test', state: 'alive', tfBattery: false, x: c.x, y: c.y, z: c.z };
    ok(bats.pickup(pilot) && pilot.tfBattery && bats.list.length === ASHFALL_BATTERY_CACHES.length - 1, 'a pilot takes the battery from a cache');
    const now = engine4.now;
    bats.step(now + BATTERY_CACHE_MS - 1000);
    const early = bats.list.length;
    bats.step(now + BATTERY_CACHE_MS + 100);
    ok(early === ASHFALL_BATTERY_CACHES.length - 1 && bats.list.length === ASHFALL_BATTERY_CACHES.length,
      `the cache refills ${BATTERY_CACHE_MS / 1000} s after the pickup`);
    for (let i = 0; i < 20; i++) bats.drop(60 + i, T + 1, 30, now);
    ok(bats.list.filter(b => b.cache !== undefined).length === ASHFALL_BATTERY_CACHES.length, 'dropped batteries never evict a cache battery');
  } finally { engine4.stop(); }
}

console.log(`ashfall-map-test: ${checks} checks passed`);
