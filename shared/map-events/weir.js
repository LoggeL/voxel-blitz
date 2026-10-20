// Frontier sluice weir geometry: a small concrete weir across the north
// reach 8 m upstream of ford-north, two gate bays under steel gantries either
// side of an open navigation pass, and a railed walkway with a platform over
// the pass, reached from both banks. It has no event of its own any more (the
// old wheel-and-flood event was cut, docs/conquest.md "Map events"): the
// structure stays as the river crossing on foot and as the north half of the
// planned ford sluices (slot `sluice` in the event registries).
//
// The voxel geometry (WEIR) is shared by the site builder
// (shared/world/frontier-sites/weir.js) and any event edit of the gates, so
// the voxels and the edits cannot drift apart.

const freeze = Object.freeze;

/**
 * The weir on Frontier, in voxel cells (inclusive). The river at z 254-257
 * runs from x 379-380 (west bank, top y22-24) to x 399 (east bank, top y22),
 * 8 m above the ford's first row (z 263).
 *   abutments  concrete from the ground (or bed) to the deck level, both banks
 *   piers      concrete from the bed to the deck level, splitting the channel
 *              into the west gate bay, the 10 m navigation pass (the boat lane
 *              runs through it at x 389) and the east gate bay
 *   deckY      top voxel of the walkway and the wheel platform (feet 26.02,
 *              one step over the y24 west bank); the underside stands 3 m
 *              over the water face, as the end bridges' (a boat passes under)
 *   walk       the 2 m walkway (railed at z 254 and z 257: no hull fits)
 *   platform   the wheel platform over the pass, downstream of the walkway
 *   wheel      the sluice wheel (a ring in the x-y plane on a post)
 *   gates      one leaf per bay in the plane z `gateZ`: shut from the bed to
 *              `shutTopY` (two voxels over the water face), open it hangs at
 *              `openY` in its gantry; posts at each bay edge up to
 *              `gantryTopY` carry the beam and the hoist
 *   eastSteps  one step from the deck down to the lower east bank
 */
export const WEIR = freeze({
  z0: 254, z1: 257, deckY: 25,
  abutments: freeze([freeze({ x0: 374, x1: 379 }), freeze({ x0: 400, x1: 404 })]),
  piers: freeze([freeze({ x0: 383, x1: 383 }), freeze({ x0: 394, x1: 394 })]),
  pass: freeze({ x0: 384, x1: 393 }),
  walk: freeze({ x0: 374, x1: 404, z0: 255, z1: 256, railZ: freeze([254, 257]) }),
  platform: freeze({ x0: 386, x1: 391, z0: 258, z1: 260 }),
  wheel: freeze({ x: 388, z: 260, y: 28 }),
  gateZ: 254, shutTopY: 23, openY: freeze([27, 31]), gantryTopY: 32,
  bays: freeze([freeze({ id: 'west', x0: 380, x1: 382, posts: freeze([379, 383]) }), freeze({ id: 'east', x0: 395, x1: 399, posts: freeze([394, 400]) })]),
  eastSteps: freeze({ x: 405, y: 24 }),
});
