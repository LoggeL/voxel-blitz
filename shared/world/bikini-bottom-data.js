// Bikini Bottom shared data (no imports): read by metadata.js for meta.slides
// and by setpiece-bikini-bottom-school.js, which builds the trough voxels.

/**
 * Boating School Flume: from the school deck (y18) south-west into Goo Lagoon.
 * Ride speed is 5.4 * SLIDE_RULES.boost (1.5), about 8.1 voxels per second.
 * The trough floor is flat at y18 (top face 19), so the rail keeps the
 * rider's feet (centreline - 1.1) just above it all the way, and the last
 * segment rises into a kicker: the ride ends airborne half a voxel over the
 * lip and the rider carries its speed off the trough into the lagoon.
 */
export const BIKINI_BOTTOM_FLUME = Object.freeze({
  id: 'boating-flume',
  speed: 5.4,
  path: Object.freeze([[56.5, 20.3, 55.5], [56.5, 20.28, 58.5], [53.5, 20.25, 62.5], [50.5, 20.22, 66.5],
    [49.0, 20.19, 71.0], [47.5, 20.16, 74.5], [44.5, 20.7, 75.5]].map(Object.freeze)),
});

/**
 * Power-up pads as [x, topSolidY, z], in point-twin pairs: four road
 * junctions at the lot mouths (GROUND = 14) and two on the school deck (y18).
 */
export const BIKINI_BOTTOM_POWERUPS = Object.freeze([
  [45, 14, 31], [82, 14, 64], [82, 14, 31], [45, 14, 64], [57, 18, 42], [70, 18, 53],
].map(Object.freeze));
