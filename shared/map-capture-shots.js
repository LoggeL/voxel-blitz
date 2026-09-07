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
  shot('nuketown', 'snd-site-a', [36, 21, 58], [36, 15, 47], 72, 'snd'),
  shot('nuketown', 'snd-site-b', [95, 22, 60], [92, 15, 47], 72, 'snd'),
  shot('nuketown', 'hero', [105, 43, 73], [62, 20, 45], 66),
  shot('nuketown', 'street', [36, 17, 47], [71, 20, 48], 78),
  shot('nuketown', 'yellow-house', [66, 18, 55], [61, 22, 69], 78),
  shot('nuketown', 'green-house', [64, 18, 40], [67, 22, 26], 78),
  shot('nuketown', 'living-room', [62, 17, 68], [55, 17, 74], 85),
  shot('nuketown', 'backyard', [80, 20, 85], [59, 21, 73], 78),
  shot('nuketown', 'bedroom', [63, 23, 69], [68, 23, 73], 80),
  shot('nuketown', 'garden', [30, 18.5, 72], [43, 20, 77], 78),
  shot('nuketown', 'playground', [45, 18, 61], [37, 18, 68], 78),

  shot('dust2', 'hero', [126, 88, 119], [64, 15, 45], 60),
  shot('dust2', 'long-a', [112, 17, 53], [110, 19, 25], 74),
  shot('dust2', 'mid-doors', [61, 17, 61], [59, 18, 30], 70),
  shot('dust2', 'catwalk', [72.5, 19.64, 47.5], [60, 19, 32], 74),
  shot('dust2', 'b-tunnels', [25, 17, 62], [25, 18, 37], 76),
  shot('dust2', 'b-site', [28.5, 17, 29.5], [26.5, 20.5, 10], 76),
  shot('dust2', 'snd-site-a', [113, 26, 29], [99.5, 18.5, 23.5], 72, 'snd'),
  shot('dust2', 'snd-site-b', [34, 23, 30], [26.5, 15.5, 23.5], 72, 'snd'),

  shot('foundry', 'hero', [64.5, 17.64, 82.5], [65, 23, 46]),
  shot('foundry', 'west-lane', [20.5, 13.64, 48.5], [65, 23, 46]),
  shot('foundry', 'north-forge', [64.5, 18.64, 49.5], [60, 21, 26]),
  shot('foundry', 'furnace-yard', [65, 19, 60], [79, 24, 36], 72),
  shot('foundry', 'snd-site-a', [50, 20.5, 83], [50, 18, 72], 70, 'snd'),
  shot('foundry', 'snd-site-b', [80, 20.5, 35], [80, 18, 24], 70, 'snd'),

  shot('depot', 'hero', [63.5, 16.64, 83.5], [64, 27, 48]),
  shot('depot', 'west-bay', [17.5, 19.5, 68.5], [43, 22, 35]),
  shot('depot', 'east-bay', [110.5, 18.5, 29.5], [84, 22, 67]),
  shot('depot', 'freight-truck', [50, 22, 30], [35, 19, 20], 76),

  shot('citadel', 'hero', [64.5, 16.64, 86.5], [63, 22, 28]),
  shot('citadel', 'market-tower', [40, 24, 84], [62, 25, 63], 70),
  shot('citadel', 'a-courtyard', [45.5, 16.64, 47.5], [27, 17, 24], 75, 'snd'),
  shot('citadel', 'b-compound', [86.5, 24.5, 77.5], [103, 20, 48], 72, 'snd'),
  shot('citadel', 'snd-site-a', [27.5, 20.5, 34.5], [27.5, 20.3, 24.5], 70, 'snd'),
  shot('citadel', 'snd-site-b', [103, 23.5, 59], [103, 23.3, 48], 70, 'snd'),

  shot('solstice', 'hero', [64.5, 27.5, 87.5], [64, 27, 42], 72),
  shot('solstice', 'solar-receiver', [84, 16.64, 78], [100, 28, 64], 76),
  shot('solstice', 'biodome', [48.5, 18.2, 73.5], [27, 21, 47], 72),
  shot('solstice', 'heliostat', [64.5, 18.2, 67.5], [64, 29, 42], 68),
  shot('solstice', 'turbine-hall', [73.5, 24.5, 81.5], [102, 22, 47], 72),
  shot('solstice', 'snd-site-a', [27.5, 19.5, 62], [27.5, 16.8, 49], 70, 'snd'),
  shot('solstice', 'snd-site-b', [116.5, 19, 48], [100, 16.8, 48], 70, 'snd'),

  shot('caldera', 'hero', [64.5, 17.64, 86.5], [64, 19, 40], 75),
  shot('caldera', 'reactor-deck', [41, 26, 62], [64, 25, 48], 72),
  shot('caldera', 'gate', [45.5, 17.64, 48.5], [25, 16, 48], 75),
  shot('caldera', 'vent', [64.5, 22.5, 68.5], [64, 19, 48], 72),
  shot('caldera', 'refinery', [91.5, 22.5, 66.5], [103, 19, 48], 72),
  shot('caldera', 'snd-site-a', [25.5, 20.5, 62], [25.5, 16, 47.5], 70, 'snd'),
  shot('caldera', 'snd-site-b', [102.5, 23.5, 62], [102.5, 19, 47.5], 70, 'snd'),
  shot('killhouse', 'hero', [38, 34, 81], [65, 16, 44], 72),
  shot('killhouse', 'control-yard', [43, 29, 41], [64, 28, 16], 72),
  shot('killhouse', 'firing-line', [35, 16.64, 87], [58, 17, 59], 76),
  shot('killhouse', 'long-lane', [64.5, 16.64, 85.5], [64, 16, 58], 65),
  shot('killhouse', 'killhouse-run', [14.5, 16.64, 53.5], [14.5, 18, 35], 75),
  shot('killhouse', 'room-one', [18, 16.64, 36], [24, 19, 27], 78),
]);

export function findMapCaptureShot(map, id = 'hero') {
  return MAP_CAPTURE_SHOTS.find((entry) => entry.map === map && entry.id === id) || null;
}
