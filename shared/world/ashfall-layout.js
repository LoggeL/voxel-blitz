import { GROUND } from './blocks.js';

/**
 * Ashfall: a ruined smelter colony at dusk, built for Titanfall Attrition
 * (docs/titanfall.md §14). The map is point-symmetric about its centre
 * (x, z) -> (223 - x, 175 - z): MILITIA (alpha) stages in the west yard,
 * IMC (bravo) in the east yard. Titans walk the ring roads, the two
 * boulevards, the approach yards and the central arena; pilots own the
 * habitat blocks, the alleys and the high bridges between them.
 *
 * Band plan (x west -> east, z north -> south; the south and east halves are
 * the 180-degree rotation of the plan below):
 *   x   3..29  team yard            z   3..19  outskirts (pipeline, slag heaps)
 *   x  30..43  ring road (14 m)     z  20..33  north boulevard (14 m)
 *   x  44..179 colony district      z  34..69  north block band
 *                                   z  70..105 approach yards and the arena
 * Cross streets (12 m) at x 70..81 and 142..153, the centre street at
 * x 106..117. The arena is the disc of radius 30 m about (112, 88) with the
 * broken cooling-tower ring (radius 18-20 m, four diagonal 9 m breaches) inside it.
 */
export const ASHFALL_MIRROR = Object.freeze({ x: 223, z: 175 });
export const ASHFALL_CENTER = Object.freeze({ x: 112, z: 88 });
export const ASHFALL_ARENA = Object.freeze({ radius: 30, ringInner: 18, ringOuter: 20.2, gapHalfAngle: 0.25 });

const mirror = ([x, z]) => [ASHFALL_MIRROR.x - x, ASHFALL_MIRROR.z - z];
// Two rows of eight: the inner column stands under the team canopies, the outer one on the open apron.
const alphaCells = [10, 20].flatMap(x => [44, 50, 64, 70, 105, 111, 125, 131].map(z => [x, z]));
const alpha = alphaCells.map(([x, z]) => [x, z, GROUND]);
const bravo = alphaCells.map(mirror).map(([x, z]) => [x, z, GROUND]);

export const ASHFALL_SPAWN_ANCHORS = Object.freeze({
  fun: [...alpha, ...bravo],
  tdm: { alpha, bravo },
  snd: { attackers: [], defenders: [] },
});

export const ASHFALL_LANDMARKS = Object.freeze([
  { id: 'militia-yard', name: 'Militia Yard', x: 16, z: 88, floorY: GROUND },
  { id: 'hab-stack', name: 'Hab Stack', x: 57, z: 52, floorY: GROUND },
  { id: 'smelter-hall', name: 'Smelter Hall', x: 93, z: 46, floorY: GROUND },
  { id: 'cooling-ring', name: 'Cooling Ring', x: 112, z: 88, floorY: GROUND },
  { id: 'relay', name: 'Relay Tower', x: 137, z: 41, floorY: GROUND },
  { id: 'tenements', name: 'Tenements', x: 168, z: 52, floorY: GROUND },
  { id: 'imc-yard', name: 'IMC Yard', x: 207, z: 87, floorY: GROUND },
]);

/**
 * Titan lanes as axis-aligned open rectangles [x0, z0, x1, z1] (both halves listed): tests probe them.
 * The boulevards and ring roads are split by a median line (slag cars and wrecks, ASHFALL_MEDIANS)
 * into two 6 m carriageways each.
 */
export const ASHFALL_TITAN_LANES = Object.freeze([
  [30, 20, 193, 25], [30, 28, 193, 33],       // north boulevard carriageways
  [30, 142, 193, 147], [30, 150, 193, 155],   // south boulevard
  [30, 20, 35, 155], [38, 20, 43, 155],       // west ring road
  [180, 20, 185, 155], [188, 20, 193, 155],   // east ring road
  [70, 34, 81, 69], [142, 106, 153, 141],     // west cross streets (north) and their rotation
  [142, 34, 153, 69], [70, 106, 81, 141],     // east cross streets
  [106, 34, 117, 57], [106, 118, 117, 141],   // centre streets into the arena
]);

const rotateRect = ([x0, z0, x1, z1]) => [ASHFALL_MIRROR.x - x1, ASHFALL_MIRROR.z - z1, ASHFALL_MIRROR.x - x0, ASHFALL_MIRROR.z - z0];
const bothHalves = (rects) => Object.freeze([...rects, ...rects.map(rotateRect)].map(r => Object.freeze(r)));

/**
 * Median pieces [x0, z0, x1, z1] on the boulevard (z 26-27) and ring-road (x 36-37) centre
 * lines: derailed slag-pot cars (7 m, sightline breakers: four on a boulevard, two on a ring
 * road) and burnt-out runabouts (2 m, on the ring roads).
 */
export const ASHFALL_SLAG_CARS = Object.freeze([[58, 26, 63, 27], [84, 26, 90, 27], [132, 26, 138, 27], [160, 26, 165, 27],
  [36, 66, 37, 72], [36, 103, 37, 109]]);
export const ASHFALL_MEDIAN_WRECKS = Object.freeze([[36, 84, 37, 87], [36, 48, 37, 51]]);
export const ASHFALL_MEDIANS = bothHalves([...ASHFALL_SLAG_CARS, ...ASHFALL_MEDIAN_WRECKS]);

/**
 * Lane cover [x0, z0, x1, z1] (both halves): 6 m container stacks, revetments and ingot
 * piles that fill one whole 6 m carriageway for 5 m, staggered between the two
 * carriageways of a boulevard or ring road. A titan weaves across the median past
 * each one; no line along a lane stays clear at titan eye height for more than
 * ASHFALL_MAX_SIGHTLINE (the medians break the centre line). Clear of the street
 * mouths, the lane test points and the perches.
 */
export const ASHFALL_LANE_COVER = bothHalves([
  [50, 20, 54, 25], [100, 20, 104, 25], [144, 20, 148, 25],                      // north boulevard, outer carriageway
  [62, 28, 66, 33], [85, 28, 89, 33], [120, 28, 124, 33], [164, 28, 168, 33],   // north boulevard, inner carriageway
  [30, 45, 35, 49], [30, 96, 35, 100], [30, 130, 35, 134],                      // west ring road, yard carriageway
  [38, 36, 43, 40], [38, 78, 43, 82], [38, 118, 43, 122],                       // west ring road, inner carriageway
]);
export const ASHFALL_MAX_SIGHTLINE = 48;

/**
 * The Pour, the arena's molten centre (radii about ASHFALL_CENTER): a slag pool
 * one voxel above the floor inside a 2 m crucible rim (no titan steps it, a
 * titan's eye and any pilot on a rise sees the slag over it), fed by two ladles
 * under the Pour Line; two 2 m slag runners (x 111-112) cut the inner ring floor
 * from the rim, run through culverts in the ring wall and end in slag pits just
 * outside it (radius `runOut`), one voxel deep.
 */
export const ASHFALL_POUR = Object.freeze({ pool: 7, rim: 8.5, rimHeight: 2, runOut: 21.5, runner: Object.freeze([111, 112]) });

/**
 * Hull-down ingot stacks in the arena's outer band (5 m, titan chest height): [centre
 * angle in degrees (atan2(dz, dx) about ASHFALL_CENTER), radius]. They flank the breach
 * mouths and the hauler, at least 4 m from the toppled segment and the hauler so a
 * titan walks round them. Each stands with its rotated twin (180 degrees on): three per half.
 */
export const ASHFALL_ARENA_COVER = Object.freeze([[150, 25], [210, 25], [300, 26]].map(c => Object.freeze(c)));

/** Blast walls [x0, z, x1] (8 m tall, 1 thick, both halves): the approach-yard wallrun slalom, 3 m between rows. */
export const ASHFALL_BLAST_WALLS = Object.freeze([[48, 73, 55], [54, 77, 61], [60, 73, 67], [66, 77, 73]]
  .flatMap(([x0, z, x1]) => [[x0, z, x1], [ASHFALL_MIRROR.x - x1, ASHFALL_MIRROR.z - z, ASHFALL_MIRROR.x - x0]]).map(w => Object.freeze(w)));
/**
 * The cross-street billboard gantry (west cross street x 70-81, and its rotation):
 * three billboards (1 thick, z z0..z1, GROUND + y0..y1: 10 m of titan clearance)
 * hang from a beam between the Hab annex and the Smelter Hall at x in `xs`, so a
 * pilot chains wallruns across the street from facade (x 68) to board to board to
 * facade (x 83): every gap is 2-3 m, inside a single wall jump.
 */
export const ASHFALL_BILLBOARDS = Object.freeze({ xs: Object.freeze([71, 75, 79]), z0: 48, z1: 55, y0: 11, y1: 16 });
/** The ore dock (both halves): a 3 m titan platform [x0, z0, x1, z1] with ramps west and south. */
export const ASHFALL_DOCKS = bothHalves([[50, 84, 68, 95]]);

/**
 * The high line: every pilot bridge sits with its deck at GROUND + 12 (11 m of
 * titan clearance), so the yard towers, the gantries over the ring roads, the
 * floor-3 doors of the outer blocks, the band skybridges and the Pour Line over
 * the arena form one level a pilot crosses the map on. Rects are decks.
 */
export const ASHFALL_HIGH_DECK = 12;
/** Gantries over the ring roads: enclosed steel galleries (walls and a roof on a 5 m deck, a 3 m walk inside). */
export const ASHFALL_GANTRIES = bothHalves([[30, 54, 44, 58], [30, 117, 44, 121]]);
export const ASHFALL_YARD_TOWERS = Object.freeze([[26, 56], [26, 119], [197, 119], [197, 56]].map(c => Object.freeze(c)));
/** The Pour Line: a pipe-rack walkway over the centre streets and the arena (x 110-113, its own rotation). */
export const ASHFALL_POUR_LINE = Object.freeze({ x0: 110, x1: 113, z0: 44, z1: 131, bents: Object.freeze([52, 77]) });
/** The toppled ladle crane: its jib bridges the north (and south) boulevard from the outskirts to the relay deck. */
export const ASHFALL_CRANE = Object.freeze({ x0: 137, x1: 139, z0: 9, z1: 37, top0: 17, top1: 13, tower: Object.freeze([139, 7]) });

/**
 * Rodeo perches: steel decks at GROUND + PERCH_TOP (pilot feet 7 m above the
 * street, a titan's back is 4.6-5 m and its top 7-7.6 m) beside the titan lanes,
 * each reached by a straight two-wide stair (one 1 m step per voxel, rising
 * along `dir`, a scaffold frame on both sides so no titan climbs it beside
 * the treads) that bot pilots walk. `climb` (world points, foot -> deck) is the
 * route the bots follow (mapMeta.climbs); `look` is the yaw a perched bot watches.
 */
export const PERCH_TOP = 7;
const perch = (id, deck, stair, look) => {
  const [sx0, sz0, sx1, sz1, dir] = stair;
  const alongX = dir === '+x' || dir === '-x', up = dir[0] === '+' ? 1 : -1;
  const first = alongX ? (up > 0 ? sx0 : sx1) : (up > 0 ? sz0 : sz1);
  const last = first + up * (PERCH_TOP - 1);
  const mid = alongX ? (sz0 + sz1 + 1) / 2 : (sx0 + sx1 + 1) / 2;
  const at = (t, y) => (alongX ? { x: t + 0.5, y, z: mid } : { x: mid, y, z: t + 0.5 });
  const [dx0, dz0, dx1, dz1] = deck;
  const climb = [at(first - up * 1.5, GROUND + 1), at(last, GROUND + PERCH_TOP + 1), { x: (dx0 + dx1 + 1) / 2, y: GROUND + PERCH_TOP + 1, z: (dz0 + dz1 + 1) / 2 }];
  return { id, deck, stair, look, climb };
};
const PERCHES_WEST = [
  perch('ring-road', [44, 101, 46, 103], [45, 94, 46, 100, '+z'], Math.PI / 2),
  perch('boulevard', [64, 17, 66, 19], [65, 10, 66, 16, '+z'], Math.PI),
  perch('arena-north', [86, 59, 88, 61], [89, 60, 95, 61, '-x'], -Math.PI * 0.75),
];
const rotatePoint = p => ({ x: ASHFALL_MIRROR.x + 1 - p.x, y: p.y, z: ASHFALL_MIRROR.z + 1 - p.z });
const rotatePerch = p => ({ ...p, id: `${p.id}-r`, deck: rotateRect(p.deck),
  stair: [...rotateRect(p.stair.slice(0, 4)), `${p.stair[4][0] === '+' ? '-' : '+'}${p.stair[4][1]}`],
  look: p.look + Math.PI, climb: p.climb.map(rotatePoint) });
export const ASHFALL_PERCHES = Object.freeze([...PERCHES_WEST, ...PERCHES_WEST.map(rotatePerch)].map(p => Object.freeze(p)));

/**
 * Battery caches (docs/titanfall.md §14): a titan battery waits in each nook
 * (the ore dock's arena face, inside the Hab annex's street door) and comes
 * back BATTERY_CACHE_MS after it is taken. Points are the pickup positions
 * (feet height of the nook floor), all on the street-level route graph.
 */
export const BATTERY_CACHE_MS = 60000;
const CACHES_WEST = [{ x: 66.5, y: GROUND + 1, z: 90.5 }, { x: 66.5, y: GROUND + 1, z: 61.5 }];
export const ASHFALL_BATTERY_CACHES = Object.freeze([...CACHES_WEST, ...CACHES_WEST.map(rotatePoint)].map(p => Object.freeze(p)));

/**
 * Ladders (mapMeta.ladders climb volumes) up the outer legs of the Pour Line's
 * arena bents, from the arena floor to the deck: the air cell in front of each leg.
 */
const LADDERS_WEST = [{ x: 106, z: 77, face: 'x+' }, { x: 117, z: 77, face: 'x-' }];
export const ASHFALL_LADDERS = Object.freeze([...LADDERS_WEST, ...LADDERS_WEST.map(l => ({ x: ASHFALL_MIRROR.x - l.x, z: ASHFALL_MIRROR.z - l.z,
  face: l.face === 'x+' ? 'x-' : 'x+' }))].map(({ x, z, face }) => Object.freeze({
  minX: x + 0.05, maxX: x + 0.95, minY: GROUND + 1, maxY: GROUND + ASHFALL_HIGH_DECK + 1.15, minZ: z + 0.05, maxZ: z + 0.95, face })));
