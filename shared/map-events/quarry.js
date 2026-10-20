// Aldric Quarry rockslide (docs/conquest.md "Map events: Aldric Quarry
// rockslide", Frontier only): a detonator plunger in the site hut on the west
// bench sets off the charges on the high north face. A 5 s siren, five
// staggered blasts, then the face and the hill-house overhang above the bench
// come down: a boulder choke buries the haul ramp (floor -> north bench) and a
// talus slope grows from the pit floor up over the bench to the north rim, a
// new climbable way out of the pit toward St. Aldric (B).
//
// Every number lives here: the site props (charges, plunger) are placed by
// shared/world/frontier-sites/locations.js from QUARRY_SITE, the server
// controller (server/modes/conquest/map-events/quarry.js) plans the voxel
// edits from QUARRY_SLIDE against the live world, so the slide is the same
// in every match. Coordinates are Frontier voxels (x east, z south, y up).
import { defineMapEvent } from './define.js';

/** Site props: the charge boxes in the north face and the detonator in the hut (both ACCENT-striped). */
export const QUARRY_SITE = Object.freeze({
  /** Charge boxes [x, y, z] set into the face (z 581 is the rim row above the bench), doubled at y + 1 where the face stands that high. */
  charges: Object.freeze([[253, 29, 581], [258, 29, 581], [264, 29, 581], [270, 29, 581], [276, 29, 581]].map(Object.freeze)),
  /** Detonator box on the hut floor (bench y28, the hut is rect(246, 600, 250, 604) with its back wall west). */
  plunger: Object.freeze({ x: 247, y: 29, z: 602 }),
});

/**
 * The slide (all ms after the active phase starts; boxes inclusive voxels):
 *   blastsMs   one per charge, west to east: the charge's boxes go, a blast flash
 *   faceAtMs   the face box above the profile and the overhang box (the hill
 *              houses hanging over the bench) fall through the structural system
 *              (StructureSystem.bringDown: chunks that crush and leave rubble)
 *   profile    the talus surface line: top cell y0 at z0 down to y1 at z1
 *   talus      columns filled up to the profile (floor -> bench -> rim slope)
 *   choke      columns filled up to `top` (+0/1 by a hash): the boulder choke over the haul ramp
 *   rows       the deposit front runs north to south, one z row every `rowMs` from `frontAtMs`
 *   gradeAtMs  the talus columns are graded to the profile exactly (fallen house rubble cleared,
 *              except `keep` blocks: the conveyor trestles), so the slope stays walkable (1-block steps)
 *   clearance  deposit cells within this many metres of a living body or a hull are skipped (never buries anyone)
 *   crush      infantry inside a band as the front reaches it take `damage`, ground hulls `hullFraction`
 *   push       knockdown down the slope (south) while the front runs
 */
export const QUARRY_SLIDE = Object.freeze({
  blastsMs: Object.freeze([0, 280, 560, 840, 1120]),
  faceAtMs: 1400,
  face: Object.freeze({ x0: 250, x1: 279, z0: 576, z1: 581 }),
  overhang: Object.freeze({ x0: 250, x1: 277, z0: 582, z1: 592, y0: 29, y1: 56 }),
  chunkCap: 14,
  profile: Object.freeze({ z0: 576, y0: 33, z1: 597, y1: 24 }),
  talus: Object.freeze({ x0: 250, x1: 262, z0: 582, z1: 597 }),
  choke: Object.freeze({ x0: 263, x1: 278, z0: 582, z1: 593, top: 31 }),
  frontAtMs: 1900,
  rowMs: 120,
  gradeAtMs: 5600,
  gradeHeadroom: 8,
  clearance: 1.2,
  /** Rubble materials (by a hash of the cell) and the blocks the grade keeps (METAL, RUST: trestles, conveyor). */
  rubble: Object.freeze([23, 3, 23, 101, 3]),
  keep: Object.freeze([8, 13]),
  crush: Object.freeze({ damage: 120, hullFraction: 0.45, bands: Object.freeze([[576, 587], [588, 592], [593, 598]]), y0: 22, y1: 40 }),
  push: Object.freeze({ impulse: Object.freeze({ x: 0, y: 3.5, z: 6 }), damage: 10, untilMs: 4200, pad: 3 }),
});

/** The quarry pit's footprint (the locations plan) and the slide's hazard footprint, flat boxes for bots and the HUD. */
export const QUARRY_PIT = Object.freeze({ shape: 'box', x0: 246, z0: 582, x1: 293, z1: 615 });
export const QUARRY_SLIDE_ZONE = Object.freeze({ shape: 'box', x0: 249, z0: 575, x1: 280, z1: 598, y0: 22, y1: 40 });

/** Talus top cell y at row z (the profile line, clamped to its ends). */
export function quarryProfileY(z, profile = QUARRY_SLIDE.profile) {
  const t = Math.max(0, Math.min(1, (z - profile.z0) / (profile.z1 - profile.z0)));
  return Math.round(profile.y0 + (profile.y1 - profile.y0) * t);
}

/** Deterministic 0..n-1 pick for a cell (rubble material, choke height). */
export function quarryCellHash(x, y, z, n) {
  let h = Math.imul(x * 73856093 ^ y * 19349663 ^ z * 83492791, 0x9e3779b1);
  h ^= h >>> 15;
  return ((h >>> 0) % n + n) % n;
}

export const QUARRY_EVENT = defineMapEvent({
  id: 'quarry', maps: ['frontier'], kind: 'levolution', name: 'Aldric Quarry', short: 'QUARRY', glyph: 'rockslide',
  anchor: { x: 264, y: 31, z: 584 }, flag: 'B', big: true, repeat: null, breakthrough: true,
  durations: { warningMs: 5000, activeMs: 7000 },
  texts: {
    warning: { title: 'ROCKSLIDE IMMINENT', countdown: 'BLAST IN', detail: 'CLEAR THE NORTH FACE',
      own: { detail: 'CHARGES SET · CLEAR THE NORTH FACE' }, enemy: { detail: 'ENEMY BLAST · GET OUT OF THE PIT' } },
    active: { title: 'ROCKSLIDE', detail: 'NORTH FACE COMING DOWN' },
    done: { title: 'RAMP BURIED', detail: 'NEW SLOPE UP THE NORTH FACE' },
  },
  points: [{ id: 'plunger', x: 248.6, y: 29.02, z: 602.5, radius: 2.2, holdMs: 4000, teams: 'any', verb: 'Detonate', glyph: 'charge' }],
  killKeys: { quarrySlide: { label: 'ROCKSLIDE', icon: 'collapse' } },
  cues: { warning: { stinger: 'ticket_low' }, active: { stinger: 'neutralized' } },
  tuning: {
    site: QUARRY_SITE, slide: QUARRY_SLIDE, pit: QUARRY_PIT, zone: QUARRY_SLIDE_ZONE,
    /**
     * Bots: a side posts the plunger task (priority, one bot within `range` m)
     * once `pressure` enemies stand in the slide zone grown by `margin` (an
     * enemy ground hull in the pit counts `hullWeight`) and at most `ownMax`
     * of its own do; an enemy at the plunger draws `contestSquad` bots to break the hold.
     */
    bot: Object.freeze({ pressure: 3, hullWeight: 3, margin: 6, ownMax: 1, priority: 4, range: 140, contestPriority: 5, contestSquad: 2, contestRange: 110 }),
  },
});
