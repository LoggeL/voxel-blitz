// Frontier ford sluices, the geometry (docs/maps/frontier.md "Ford sluices",
// docs/conquest.md "Ford sluices"): one small concrete weir across each lane's
// reach 8 m upstream of its ford. Two gate bays under steel gantries either
// side of the spillway pass, a railed walkway with a platform over the pass,
// reached from both banks, and behind the shut gates a real pond: the reach
// stands one voxel higher (face y23) from a rock sill upstream down to the
// gates, and spills over the pass into the reach below (face y22). Blowing a
// sluice down (shared/map-events/sluice.js) releases the pond as a bore
// through its own ford and scours the ford bed out of reach of every hull.
//
// The voxel geometry is shared by the site builder
// (shared/world/frontier-sites/weir.js), the event's fall and every staged
// edit of the release, so the voxels and the edits cannot drift apart.

const freeze = Object.freeze;
const box = b => freeze({ ...b });

/**
 * One sluice, in voxel cells (inclusive). The reach at z `z0`..`z1` runs
 * between the abutments.
 *   abutments  concrete from the ground (or bed) to the deck level, both banks
 *   piers      concrete from the bed to the deck level, splitting the channel
 *              into the two gate bays and the 10 m spillway pass (the boat
 *              lane runs through it)
 *   deckY      top voxel of the walkway and the wheel platform (feet 26.02);
 *              the underside stands 3 m over the water face below the gates
 *              and 2 m over the pond's (a boat passes under either)
 *   walk       the 2 m walkway (railed on its outer rows: no hull fits)
 *   platform   the wheel platform over the pass, downstream of the walkway
 *   wheel      the (inert) sluice wheel: a ring in the x-y plane on a post
 *   gates      one leaf per bay in the plane z `gateZ`: shut from the bed to
 *              `shutTopY` (one voxel over the pond face); the posts at each
 *              bay edge reach `gantryTopY` and carry the beam and the hoist
 *   pond       the impoundment: every river and flush bank column connected
 *              to the boat lane between the sill and the gate row (`z0`..`z1`,
 *              inside `x0`..`x1`) holds water up to `faceY` (one voxel over
 *              the reach's y22 face); the gate row's pass is the spillway lip
 *   sill       the rock bar that closes the pond upstream: rows `z0`..`z1`
 *              solid to the pond face across the reach, but for the boat
 *              `chute` (x0..x1), where the pond meets the reach above
 *   ford       the ford the release washes out: columns whose bed lies in
 *              the authored ford (y20, its y19 shelves) inside the box; `bed`
 *              the y20 bed's x range (the HUD paints it)
 *   reach      the river's centreline below the gates, [z, x] every 10 m
 *              (riverCentreX, pinned by the sluice test): the bore runs on it
 *   heads      the ford's bank ends of the road (bots hold them)
 *   crossing   the road crossing the ford is (mapMeta.conquest.crossings)
 */
const NORTH = {
  id: 'north', crossing: 'ford-north',
  z0: 254, z1: 257, deckY: 25,
  abutments: [{ x0: 374, x1: 379 }, { x0: 400, x1: 404 }],
  piers: [{ x0: 383, x1: 383 }, { x0: 394, x1: 394 }],
  pass: { x0: 384, x1: 393 },
  walk: { x0: 374, x1: 404, z0: 255, z1: 256, railZ: [254, 257] },
  platform: { x0: 386, x1: 391, z0: 258, z1: 260 },
  wheel: { x: 388, z: 260, y: 28 },
  gateZ: 254, shutTopY: 23, openY: [27, 31], gantryTopY: 32,
  bays: [{ id: 'west', x0: 380, x1: 382, posts: [379, 383] }, { id: 'east', x0: 395, x1: 399, posts: [394, 400] }],
  pond: { faceY: 23, x0: 350, x1: 415, z0: 205, z1: 254 },
  sill: { z0: 203, z1: 204, x0: 350, x1: 415, chute: { x0: 375, x1: 385 } },
  ford: { x0: 376, x1: 408, z0: 263, z1: 276, bed: { x0: 381, x1: 400 } },
  reach: [[258, 390.3], [268, 391.1], [278, 391.1], [288, 392.8], [298, 395.5], [308, 398.3], [318, 396.6], [328, 389.9], [338, 386.7], [348, 386.0], [358, 385.4], [368, 384.9], [378, 384.3]],
  heads: [{ x: 376.5, y: 22.02, z: 270.5 }, { x: 407.5, y: 22.02, z: 270.5 }],
};

// The south sluice is the north one's functional mirror on the south lane:
// upstream of ford-south (the river runs north to south, so the exact point
// mirror would stand below the ford), the wide bay on the west bank as the
// point mirror puts it. Its pond is short (z470-476) so it keeps clear of
// WEST's boat moored below the Iron Bridge at (361, 464).
const SOUTH = {
  id: 'south', crossing: 'ford-south',
  z0: 477, z1: 480, deckY: 25,
  abutments: [{ x0: 359, x1: 363 }, { x0: 386, x1: 390 }],
  piers: [{ x0: 369, x1: 369 }, { x0: 380, x1: 380 }],
  pass: { x0: 370, x1: 379 },
  walk: { x0: 359, x1: 390, z0: 478, z1: 479, railZ: [477, 480] },
  platform: { x0: 372, x1: 377, z0: 481, z1: 483 },
  wheel: { x: 374, z: 483, y: 28 },
  gateZ: 477, shutTopY: 23, openY: [27, 31], gantryTopY: 32,
  bays: [{ id: 'west', x0: 364, x1: 368, posts: [363, 369] }, { id: 'east', x0: 381, x1: 385, posts: [380, 386] }],
  pond: { faceY: 23, x0: 350, x1: 400, z0: 470, z1: 477 },
  sill: { z0: 468, z1: 469, x0: 350, x1: 400, chute: { x0: 367, x1: 377 } },
  ford: { x0: 358, x1: 392, z0: 491, z1: 504, bed: { x0: 367, x1: 386 } },
  reach: [[481, 375.4], [491, 377.0], [501, 376.9], [511, 377.9], [521, 380.4], [531, 383.7], [541, 386.7], [551, 388.5], [561, 388.4], [571, 386.4], [581, 382.9], [591, 378.7], [601, 375.0]],
  heads: [{ x: 360.5, y: 22.02, z: 497.5 }, { x: 391.5, y: 22.02, z: 497.5 }],
};

function sluice(s) {
  return freeze({
    ...s,
    abutments: freeze(s.abutments.map(box)), piers: freeze(s.piers.map(box)), pass: box(s.pass),
    walk: freeze({ ...s.walk, railZ: freeze([...s.walk.railZ]) }), platform: box(s.platform), wheel: box(s.wheel),
    openY: freeze([...s.openY]), bays: freeze(s.bays.map(b => freeze({ ...b, posts: freeze([...b.posts]) }))),
    pond: box(s.pond), sill: freeze({ ...s.sill, chute: box(s.sill.chute) }), ford: freeze({ ...s.ford, bed: box(s.ford.bed) }), heads: freeze(s.heads.map(box)),
    reach: freeze(s.reach.map(p => freeze([...p]))),
  });
}

/** The north sluice (the old sluice weir across the north reach). */
export const WEIR = sluice(NORTH);
/** The south sluice above ford-south. */
export const WEIR_SOUTH = sluice(SOUTH);
/** Both sluices, north first. */
export const SLUICES = freeze([WEIR, WEIR_SOUTH]);
