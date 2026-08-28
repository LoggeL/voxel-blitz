const shot = (map, id, position, target, fov = 75) => Object.freeze({
  map,
  id,
  position: Object.freeze(position),
  target: Object.freeze(target),
  fov,
});

/** Stable, collision-independent cameras for truthful map-design captures. */
export const MAP_CAPTURE_SHOTS = Object.freeze([
  shot('foundry', 'hero', [64.5, 17.64, 82.5], [65, 23, 46]),
  shot('foundry', 'west-lane', [20.5, 13.64, 48.5], [65, 23, 46]),
  shot('foundry', 'north-forge', [64.5, 18.64, 49.5], [60, 21, 26]),

  shot('depot', 'hero', [63.5, 16.64, 83.5], [64, 27, 48]),
  shot('depot', 'west-bay', [16.5, 16.64, 48.5], [64, 24, 48]),
  shot('depot', 'east-bay', [111.5, 16.64, 47.5], [64, 24, 48]),

  shot('citadel', 'hero', [64.5, 16.64, 86.5], [63, 22, 28]),
  shot('citadel', 'a-courtyard', [45.5, 16.64, 47.5], [27, 17, 24]),
  shot('citadel', 'b-compound', [82.5, 16.64, 48.5], [103, 20, 48]),
]);

export function findMapCaptureShot(map, id = 'hero') {
  return MAP_CAPTURE_SHOTS.find((entry) => entry.map === map && entry.id === id) || null;
}
