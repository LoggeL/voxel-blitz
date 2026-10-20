// Redrock Canyon plan (voxel units): the second Conquest battlefield, an arid
// red-rock desert of 768 x 80 x 768 (docs/maps/redrock.md). Like
// FRONTIER_PLAN it is pure data with no imports, so the client, the server
// and the tests can read flags, HQs, the river and the crossings without
// building the terrain. y comes from the terrain: redrockSurfaceY(x, z) in
// shared/world/redrock-terrain.js.
//
// The layout is mirror-symmetric about x = 384 (WEST <-> EAST), not point-
// symmetric like Frontier: the river is held back by Redrock Dam (flag C) in
// the middle, so the north half is a reservoir and the south half a canyon,
// and both teams own one flag on each.

export const REDROCK_PLAN = Object.freeze({
  dimensions: Object.freeze({ sx: 768, sy: 80, sz: 768 }),
  center: Object.freeze([384, 384]),
  combatArea: Object.freeze({ minX: 24, maxX: 744, minZ: 24, maxZ: 744 }),
  // The HQ plateaus are Frontier's (same footprint, y36), so the airfields,
  // motor pools and every aircraft departure are shared with Frontier.
  hqs: Object.freeze({
    alpha: Object.freeze({ x: 72,  z: 384, radius: 56, name: 'West HQ' }),
    bravo: Object.freeze({ x: 696, z: 384, radius: 56, name: 'East HQ' }),
  }),
  flags: Object.freeze([
    Object.freeze({ id: 'A', name: 'Palmera Oasis',    site: 'oasis',    x: 236, z: 236, radius: 22, home: 'alpha' }),
    Object.freeze({ id: 'B', name: 'Copperhead Mine',  site: 'mine',     x: 250, z: 540, radius: 22, home: 'alpha' }),
    Object.freeze({ id: 'C', name: 'Redrock Dam',      site: 'dam',      x: 384, z: 384, radius: 32, home: null }),
    Object.freeze({ id: 'D', name: 'Mesa Radar',       site: 'radar',    x: 532, z: 236, radius: 22, home: 'bravo' }),
    Object.freeze({ id: 'E', name: 'Sulphur Railhead', site: 'railhead', x: 518, z: 540, radius: 22, home: 'bravo' }),
  ]),
  // North of the dam the river (surface y26) widens into the reservoir; south
  // of it the river (surface y19) runs in a canyon about 12 m deep.
  river: Object.freeze({
    points: Object.freeze([[384, 0], [384, 384], [384, 768]]),
    width: 12, depth: 3, surfaceY: 19,
    reservoir: Object.freeze({ surfaceY: 26, z0: 214, z1: 378 }),
  }),
  crossings: Object.freeze([
    Object.freeze({ id: 'bridge-north', kind: 'bridge', x: 384, z: 100, width: 8 }),
    Object.freeze({ id: 'ford-north',   kind: 'ford',   x: 384, z: 178, width: 14 }),
    Object.freeze({ id: 'redrock-dam',  kind: 'bridge', x: 384, z: 384, width: 12 }),
    Object.freeze({ id: 'trestle',      kind: 'bridge', x: 384, z: 500, width: 8 }),
    Object.freeze({ id: 'wash-ford',    kind: 'ford',   x: 384, z: 640, width: 14 }),
  ]),
  heights: Object.freeze({ bedrock: 0, waterSurface: 19, reservoirSurface: 26, plainMin: 27, plainMax: 34, hqPlateau: 36, damCrest: 34, ridgeMax: 62, landmarkMax: 78 }),
});
