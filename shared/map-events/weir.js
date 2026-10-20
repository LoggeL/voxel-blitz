// Frontier sluice weir (docs/conquest.md "Sluice weir"): a small concrete
// weir across the north reach 6 m upstream of ford-north, two gate bays
// under steel gantries either side of an open navigation pass, and a railed
// walkway with the sluice wheel platform over the pass, reached from both
// banks. Turning the wheel (either team) opens the gates: after a horn both
// fords flood for two minutes, then the water recedes.
//
// The voxel geometry (WEIR) is shared by the site builder
// (shared/world/frontier-sites/weir.js) and the event's gate and flood edits
// (server/modes/conquest/map-events/weir.js), so the voxels and the edits
// cannot drift apart. Every number of the event is in the definition below.
import { defineMapEvent } from './define.js';

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

/**
 * The flood: the water face over and around each ford rises from y22 to
 * `coreFace` (3 m over the y20 ford bed) in the core rows and to `taperFace`
 * in the taper rows either side, so a boat lifts one voxel at a time
 * (BOAT_RULES.waterStep). Water only ever rises over water (the river's own
 * columns), never onto the banks. ford-south is the point mirror of
 * ford-north. The surge reaches ford-north first (its cells run north to
 * south, from the weir down), then ford-south.
 */
const FORD_NORTH = freeze({ id: 'ford-north', x0: 372, x1: 412, core: freeze([263, 282]), taper: freeze([262, 288]) });
const mirrorFord = f => freeze({ id: 'ford-south', x0: 767 - f.x1, x1: 767 - f.x0,
  core: freeze([767 - f.core[1], 767 - f.core[0]]), taper: freeze([767 - f.taper[1], 767 - f.taper[0]]) });
export const WEIR_FLOODS = freeze([FORD_NORTH, mirrorFord(FORD_NORTH)]);

export const WEIR_EVENT = defineMapEvent({
  id: 'weir',
  maps: ['frontier'],
  kind: 'levolution',
  name: 'Sluice Weir',
  short: 'WEIR',
  glyph: 'flood',
  anchor: { x: 388.5, y: 26.02, z: 256 },
  flag: null,
  big: true,
  // Two minutes of high water, then four minutes' cooldown from the moment it recedes; three floods a match.
  repeat: { cooldownMs: 240000, max: 3 },
  breakthrough: true,
  durations: { warningMs: 6000, activeMs: 120000 },
  texts: {
    warning: { title: 'GATES OPENING', countdown: 'SURGE IN',
      own: { detail: 'FORDS FLOOD · CLEAR THE CROSSINGS' }, enemy: { detail: 'ENEMY OPENED THE SLUICE · CLEAR THE FORDS' } },
    active: { title: 'FORDS FLOODED', detail: 'VEHICLES CROSS AT THE BRIDGES', countdown: 'RECEDES IN' },
    cooldown: { title: 'WATER RECEDING', detail: 'THE FORDS REOPEN' },
    done: { title: 'WATER RECEDING', detail: 'THE SLUICE IS SPENT' },
  },
  points: [{ id: 'wheel', x: 388.5, y: 26.02, z: 258.6, radius: 2.4, holdMs: 5000, teams: 'any', verb: 'Open sluice', glyph: 'event-weir' }],
  // The horn reuses the alarm stinger; the surge itself is the FX hook's (no recording of its own).
  cues: { warning: { stinger: 'ticket_low' }, active: { stinger: null } },
  tuning: {
    /** Crossings bot drivers may not use from the horn until the fords have drained (mapMeta.conquest.crossings ids). */
    crossings: ['ford-north', 'ford-south'],
    /** Water faces (top of the highest water voxel + 1) of the flood: core rows, taper rows; the river's own face. */
    coreFace: 24, taperFace: 23, riverFace: 22,
    /** Cells a tick the surge and the recession take (StagedEdits per-job budget): about 2 900 cells in 4 s at 60 Hz. */
    surgeCellsPerTick: 12, recedeCellsPerTick: 12,
    /** The surge shoves bodies in the fords downstream (+z) once a second while it rises: m/s, and how long after the gates open (ms). */
    surgePush: 3.5, surgePushMs: 9000,
    /**
     * Bots: open the sluice while an enemy ground hull (crewed) is within `armourReach` m of a ford and
     * no own one is within `ownReach` m, or while an own crewed boat is within `boatReach` m of one;
     * one bot walks to the wheel from at most `range` m at `priority`. A rival holding the wheel draws
     * `contestSquad` bots within `contestRange` m.
     */
    bots: freeze({ armourReach: 70, ownReach: 45, boatReach: 90, priority: 4, range: 170, contestSquad: 2, contestRange: 120, contestPriority: 3.5 }),
  },
});
