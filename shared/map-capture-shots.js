const shot = (map, id, position, target, fov = 75, mode = null) => Object.freeze({
  map,
  id,
  position: Object.freeze(position),
  target: Object.freeze(target),
  fov,
  mode,
});

/** Stable, collision-independent cameras for truthful map-design captures. */
export const MAP_CAPTURE_SHOTS = Object.freeze([
  shot('foundry', 'hero', [64.5, 17.64, 82.5], [65, 23, 46]),
  shot('foundry', 'west-lane', [20.5, 13.64, 48.5], [65, 23, 46]),
  shot('foundry', 'north-forge', [64.5, 18.64, 49.5], [60, 21, 26]),
  shot('foundry', 'snd-site-a', [50, 20.5, 83], [50, 18, 72], 70, 'snd'),
  shot('foundry', 'snd-site-b', [80, 20.5, 35], [80, 18, 24], 70, 'snd'),

  shot('depot', 'hero', [63.5, 16.64, 83.5], [64, 27, 48]),
  shot('depot', 'west-bay', [17.5, 17.5, 68.5], [43, 22, 35]),
  shot('depot', 'east-bay', [110.5, 18.5, 29.5], [84, 22, 67]),

  shot('citadel', 'hero', [64.5, 16.64, 86.5], [63, 22, 28]),
  shot('citadel', 'a-courtyard', [45.5, 16.64, 47.5], [27, 17, 24], 75, 'snd'),
  shot('citadel', 'b-compound', [91.5, 22.5, 77.5], [103, 20, 48], 72, 'snd'),
  shot('citadel', 'snd-site-a', [27.5, 20.5, 34.5], [27.5, 20.3, 24.5], 70, 'snd'),
  shot('citadel', 'snd-site-b', [103, 23.5, 59], [103, 23.3, 48], 70, 'snd'),

  shot('solstice', 'hero', [64.5, 27.5, 87.5], [64, 27, 42], 72),
  shot('solstice', 'biodome', [48.5, 18.2, 73.5], [27, 21, 47], 72),
  shot('solstice', 'heliostat', [64.5, 18.2, 67.5], [64, 29, 42], 68),
  shot('solstice', 'turbine-hall', [73.5, 24.5, 81.5], [102, 22, 47], 72),
  shot('solstice', 'snd-site-a', [27.5, 19.5, 62], [27.5, 16.8, 49], 70, 'snd'),
  shot('solstice', 'snd-site-b', [116.5, 19, 48], [100, 16.8, 48], 70, 'snd'),

  shot('caldera', 'hero', [64.5, 17.64, 86.5], [64, 19, 40], 75),
  shot('caldera', 'gate', [45.5, 17.64, 48.5], [25, 16, 48], 75),
  shot('caldera', 'vent', [64.5, 22.5, 68.5], [64, 19, 48], 72),
  shot('caldera', 'refinery', [91.5, 22.5, 66.5], [103, 19, 48], 72),
  shot('caldera', 'snd-site-a', [25.5, 20.5, 62], [25.5, 16, 47.5], 70, 'snd'),
  shot('caldera', 'snd-site-b', [102.5, 23.5, 62], [102.5, 19, 47.5], 70, 'snd'),
  shot('killhouse', 'hero', [64.5, 24.64, 90.5], [64, 16, 40], 75),
  shot('killhouse', 'firing-line', [64.5, 17.64, 88.5], [64, 16, 58], 72),
  shot('killhouse', 'long-lane', [64.5, 17.64, 84.5], [64, 16, 58], 60),
  shot('killhouse', 'killhouse-run', [14.5, 18.64, 51.5], [60, 16, 37], 70),
]);

export function findMapCaptureShot(map, id = 'hero') {
  return MAP_CAPTURE_SHOTS.find((entry) => entry.map === map && entry.id === id) || null;
}
