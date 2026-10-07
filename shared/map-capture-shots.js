import { FRONTIER_PLAN } from './conquest-contract.js';
import { frontierSurfaceY } from './world/frontier-terrain.js';
import { getMapDimensions } from './world/dimensions.js';

const shot = (map, id, position, target, fov = 75, mode = null, options = {}) => Object.freeze({
  map,
  id,
  position: Object.freeze(position),
  target: Object.freeze(target),
  fov,
  mode,
  ...options,
});

const flag = (id) => FRONTIER_PLAN.flags.find((entry) => entry.id === id);
const [A, B, C, D, E] = ['A', 'B', 'C', 'D', 'E'].map(flag);
const HQ = FRONTIER_PLAN.hqs.alpha;

/**
 * Frontier v2 cameras, placed from FRONTIER_PLAN anchors: each end is
 * [x, z, lift] and stands `lift` metres above the terrain surface
 * (frontierSurfaceY), so the shots follow the authored relief. Positions are
 * resolved on first read. `stage` parks a capture-only hull pose (a hovering
 * helicopter, a jet in the air) for vehicle shots; `subject` frames a fleet
 * spawn from mapMeta. resolveMapCaptureShot() re-resolves against the loaded
 * world when that is not the planned one.
 */
const groundShot = (id, from, to, fov, options = {}) => {
  let resolved = null;
  const resolve = () => (resolved ??= resolveAnchors(from, to, frontierSurfaceY));
  return Object.freeze({
    map: 'frontier', id, fov, mode: 'conquest', anchor: Object.freeze({ from: Object.freeze(from), to: Object.freeze(to) }),
    get position() { return resolve().position; },
    get target() { return resolve().target; },
    ...options,
  });
};

function resolveAnchors(from, to, surfaceY) {
  const at = ([x, z, lift]) => Object.freeze([x, surfaceY(x, z) + lift, z]);
  return { position: at(from), target: at(to) };
}

const frontierOverview = () => {
  const { sx, sz } = getMapDimensions('frontier');
  return shot('frontier', 'overview', [sx / 2, 1200, sz / 2], [sx / 2, 0, sz / 2], 75, 'conquest',
    { kind: 'orthographic', scale: Math.max(sx, sz) });
};

/** Frontier v2: the first sixty seconds, flag by flag, plus vehicles in the field. */
const FRONTIER_SHOTS = [
  // West HQ plateau edge looking down the valley: spire right, bridge ahead,
  // the works chimneys far right, the north ridge left, mountains beyond.
  groundShot('vista', [HQ.x + 74, HQ.z + 14, 9], [C.x, C.z - 6, 6], 64),
  groundShot('farm', [A.x - 34, A.z + 40, 7], [A.x + 6, A.z - 4, 5], 70),
  // Eye clear of the low cobble wall at the square's corner (inside it, the culled wall showed the sky).
  groundShot('village-street', [B.x - 12, B.z + 15, 1.7], [B.x + 6, B.z - 12, 9], 78),
  groundShot('bridge', [C.x - 30, C.z + 40, 4], [C.x + 4, C.z, 7], 70),
  groundShot('trenches', [D.x - 18, D.z + 16, 1.6], [D.x + 6, D.z - 8, 1.2], 78),
  // From the C approach (north-west): flag E ahead, the smelter hall and both
  // chimneys behind it, the cooling tower at the right edge.
  groundShot('works', [E.x - 46, E.z - 30, 10], [E.x + 18, E.z + 22, 18], 66),
  // The west tank on its motor-pool pad, framed toward the Ashgrove forest.
  groundShot('tank-forest', [HQ.x + 40, HQ.z + 150, 3.2], [HQ.x + 70, HQ.z + 200, 1], 60,
    { subject: Object.freeze({ vehicle: 'alpha-tank', from: Object.freeze([-7, 3.2, 9]), to: Object.freeze([0, 1.4, 0]) }) }),
  // A gunship hovering low over the river north of the iron bridge.
  groundShot('heli-river', [C.x - 26, C.z - 70, 9], [C.x + 6, C.z - 92, 16], 62,
    { stage: Object.freeze({ vehicle: 'alpha-helicopter', at: Object.freeze([C.x + 6, C.z - 92, 16]), yaw: 2.2 }) }),
  // A jet banking over the valley, the HQ plateau behind it.
  groundShot('jet-sky', [HQ.x + 150, HQ.z - 40, 70], [HQ.x + 190, HQ.z - 70, 82], 58,
    { stage: Object.freeze({ vehicle: 'alpha-plane', at: Object.freeze([HQ.x + 190, HQ.z - 70, 82]), yaw: -2.1 }) }),
  // Smoke over the burnt-out tank by the river west of C (mapMeta.conquest.dressing).
  groundShot('wreck-column', [C.x - 50, C.z + 70, 6], [C.x - 14, C.z + 30, 14], 66,
    { subject: Object.freeze({ landmark: 'wreck-tank-c-west', from: Object.freeze([-24, 6, 30]), to: Object.freeze([0, 10, 0]) }) }),
];

/** Frontier camera re-resolved against the loaded world (surface probe, mapMeta subjects). */
export function resolveMapCaptureShot(entry, { surfaceY = null, meta = null } = {}) {
  if (!entry?.anchor) return entry;
  const ground = typeof surfaceY === 'function' ? surfaceY : frontierSurfaceY;
  let { position, target } = resolveAnchors(entry.anchor.from, entry.anchor.to, ground);
  const subject = entry.subject;
  let focus = null;
  if (subject?.vehicle) {
    const spawn = meta?.conquest?.vehicleSpawns?.find((row) => row?.id === subject.vehicle);
    if (spawn) focus = { x: spawn.x, y: spawn.y, z: spawn.z, yaw: Number(spawn.yaw) || 0 };
  } else if (subject?.landmark) {
    // Site landmarks (mapMeta.landmarks) and battlefield dressing such as the
    // wreck props (mapMeta.conquest.dressing).
    const pattern = new RegExp(subject.landmark, 'i');
    const rows = [...(meta?.landmarks || []), ...(meta?.conquest?.dressing || [])];
    const mark = rows.find((row) => row && pattern.test(`${row.id} ${row.kind ?? ''} ${row.name ?? ''}`)
      && [row.x, row.y, row.z].every(Number.isFinite));
    if (mark) focus = { x: mark.x, y: ground(mark.x, mark.z), z: mark.z, yaw: 0 };
  }
  if (focus) {
    const turn = ([dx, dy, dz]) => {
      const c = Math.cos(focus.yaw), s = Math.sin(focus.yaw);
      return [focus.x + dx * c + dz * s, focus.y + dy, focus.z - dx * s + dz * c];
    };
    position = turn(subject.from); target = turn(subject.to);
  }
  let stage = entry.stage || null;
  if (stage) {
    const [x, z, lift] = stage.at;
    stage = { ...stage, position: [x, ground(x, z) + lift, z] };
  }
  return { ...entry, position: Object.freeze(position), target: Object.freeze(target), stage };
}

/** Stable, collision-independent cameras for truthful map-design captures. */
export const MAP_CAPTURE_SHOTS = Object.freeze([
  ...FRONTIER_SHOTS,
  // Square north-up frame over the whole authoritative extent.
  frontierOverview(),
  shot('harbor', 'hero', [174, 80, 136], [94, 18, 68], 64),
  shot('harbor', 'cargo-lanes', [75, 19, 104], [98, 25, 61], 78),
  shot('harbor', 'freight-lightboxes', [65, 16.62, 61], [43, 23, 46], 76),
  shot('harbor', 'quay-floodlights', [21, 16.62, 61], [9.5, 23, 58.5], 74),
  shot('harbor', 'snd-site-a', [35, 16.62, 87], [35, 17, 71], 78, 'snd'),
  shot('harbor', 'snd-site-b', [155, 16.62, 87], [155, 17, 71], 78, 'snd'),
  shot('canyon', 'hero', [176, 92, 138], [96, 18, 70], 64),
  shot('canyon', 'dry-river', [100, 16.62, 88], [96, 24, 68], 78),
  shot('canyon', 'expedition-camp', [43, 16.62, 79], [29, 19, 60], 76),
  shot('canyon', 'river-lanterns', [87, 16.62, 49], [79, 19, 41], 80),
  shot('canyon', 'snd-site-a', [35, 16.62, 87], [35, 17, 71], 78, 'snd'),
  shot('canyon', 'snd-site-b', [155, 16.62, 60], [155, 17, 71], 78, 'snd'),
  shot('reactor', 'hero', [90, 38, 80], [64, 17, 46], 68, 'bastion'),
  shot('reactor', 'core', [67, 18, 68], [64, 18, 51], 75, 'bastion'),
  // Causeway: the dam corridor from the east, then the three stage yards.
  shot('causeway', 'hero', [162, 25, 88], [70, 15, 72], 68, 'bastion'),
  shot('causeway', 'east-gate', [128, 19, 96], [150, 17, 70], 76, 'bastion'),
  shot('causeway', 'pump-house', [96, 18, 52], [112, 17, 72], 76, 'bastion'),
  shot('causeway', 'extraction', [40, 19, 50], [16, 17, 72], 76, 'bastion'),
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

  // Remaster spectator cameras, transformed at 48 Source units per voxel.
  // Site views deliberately include the CT underpass and B's raised window.
  shot('dust2', 'hero', [116, 105, 126], [64, 13, 48], 58),
  shot('dust2', 'long-a', [99, 20, 59], [98, 15.5, 31], 82),
  shot('dust2', 'catwalk', [61.5, 17, 59.5], [62, 14.5, 35], 80),
  shot('dust2', 't-spawn', [43.5, 21, 84.5], [27, 15.5, 72], 80),
  shot('dust2', 'b-tunnels', [26.177, 17.604, 46.583], [34.535, 15.84, 29.892], 80),
  shot('dust2', 'tunnel-stairs', [40.5, 18, 44.5], [45.5, 13.5, 43], 82),
  shot('dust2', 'snd-site-a', [102, 25, 28], [88, 15, 15], 78, 'snd'),
  shot('dust2', 'snd-site-b', [24, 24, 29], [33, 15, 16], 78, 'snd'),

  // ttt_minecraft_b5 replica: the island from the south-east, its landmarks
  // and the Nether below.
  shot('minecraft_b5', 'hero', [132, 92, 118], [60, 44, 44], 58),
  shot('minecraft_b5', 'lighthouse', [44.5, 46.5, 46.5], [28, 58, 27], 74),
  shot('minecraft_b5', 'nether-portal', [86.5, 55.5, 34.5], [89, 55, 24], 76),
  shot('minecraft_b5', 'nether', [58.5, 5.5, 44.5], [78, 5, 38], 80),
  shot('minecraft_b5', 'beach', [74.5, 39.6, 91.5], [52, 38.5, 68], 78),

  // ttt_waterworld replica: the pool hall from the cafe mezzanine, the flumes,
  // the deep end, the glass foyer and the traitor room.
  shot('waterworld', 'hero', [152, 21, 11], [72, 8, 96], 64),
  shot('waterworld', 'flumes', [70.5, 12, 110.5], [99, 26, 70], 74),
  shot('waterworld', 'wave-pool', [150.5, 11.5, 40.5], [60, 8, 70], 76),
  shot('waterworld', 'foyer', [70.5, 11, 175.5], [70, 10, 138], 74),
  shot('waterworld', 'traitor-room', [172.5, 12.5, 30.5], [178, 12, 17], 78),

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

  shot('bikini_bottom', 'hero', [64.5, 34, 93.5], [64, 16, 40], 75),
  shot('bikini_bottom', 'conch-street', [8.5, 21, 30.5], [60, 20, 21], 72),
  shot('bikini_bottom', 'krusty-krab', [44.5, 21, 66.5], [26, 19, 52], 70),
  shot('bikini_bottom', 'chum-bucket', [82.5, 26, 30.5], [101.5, 21, 47.5], 70),
  shot('bikini_bottom', 'boating-school', [40.5, 24, 30.5], [63.5, 19, 47.5], 70),
  shot('bikini_bottom', 'flume', [36.5, 22, 64.5], [52, 18, 66], 72),
  shot('bikini_bottom', 'treedome', [70.5, 22, 64.5], [87, 19, 74.5], 70),
  shot('bikini_bottom', 'goo-lagoon', [39.5, 22, 86.5], [39, 15, 75], 72),
  shot('bikini_bottom', 'snd-site-a', [33.5, 19.5, 56.5], [24.5, 15.5, 46.5], 70, 'snd'),
  shot('bikini_bottom', 'snd-site-b', [101.5, 31, 59.5], [101.5, 18, 47.5], 70, 'snd'),
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
