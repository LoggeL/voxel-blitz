/**
 * Per-map atmosphere. Colours, fog, sun placement, the post grade and the
 * voxel light floor all live here so a map's mood is one reviewable block.
 *   sunDir    direction TO the sun; elevation stays at or above ~45 degrees so
 *             baked shadows never swallow a main lane
 *   sunDisc   sky disc/halo strength (0 = overcast)
 *   sky moods (sky.js, uniforms only): skyHaze 0..1 pulls the sky toward
 *             skyHorizon; horizonGlow + horizonGlowStrength add a warm band;
 *             overcast 0..1 lays a grey deck (deckColor) over a panorama-free sky
 *   grade     post-process grade (combat-post-process.js resolveGrade)
 *   light     voxel light: minSky floor for fully enclosed rooms
 *   envIntensity  image-based light on PBR weapons and props
 *   water     fluid surfaces: sky `reflection` (fresnel weight), bank `foam` and
 *             `foamLight` (foam brightness for the map's light level; indoor < 1)
 */
const DEFAULT = Object.freeze({
  skybox: '/assets/skyboxes/voxel-daylight.webp',
  fog: '#b4cde1', density: 0.0036, skyTop: '#397fc4', skyHorizon: '#b3ddf5',
  skyLight: '#d2e5fa', groundLight: '#6e7775', sun: '#fff9f0',
  ambient: 0.78, sunlight: 1.35, cloud: '#ffffff',
  sunDir: Object.freeze([60, 90, 20]), sunDisc: 1, envIntensity: 0.45,
  // Clear daylight keeps colour in the buildings and props, without a sepia cast.
  grade: Object.freeze({}),
  light: Object.freeze({ minSky: 0.5 }),
  water: Object.freeze({ reflection: 0.5, foam: 0.85, foamLight: 1 }),
});
const PALETTES = {
  harbor: { skyTop: '#467d99', skyHorizon: '#bedbe8', fog: '#bbd7e2',
    groundLight: '#66858c', skyLight: '#d3eafa', sun: '#fff6e5', ambient: 0.86, sunlight: 1.42, density: 0.0018,
    // Cool morning over the water: low-ish eastern sun, teal shadows.
    sunDir: [85, 95, -35], grade: { shadowTint: [-0.005, 0.003, 0.01], saturation: 1.04 } },
  canyon: { skybox: '/assets/skyboxes/desert-daylight.webp', fog: '#dfd3b9', groundLight: '#b49872',
    skyLight: '#dde9f1', sun: '#fff0d6', ambient: 0.86, sunlight: 1.48, density: 0.0018,
    sunDir: [-55, 85, 45], grade: { highlightTint: [0.022, 0.01, -0.01], saturation: 1.07 } },
  foundry: { skyTop: '#367ab9', skyHorizon: '#b7dced', groundLight: '#697660',
    sunDir: [50, 95, -40], grade: { highlightTint: [0.018, 0.008, -0.006] } },
  depot: { skyTop: '#477fb8', skyHorizon: '#c6e0f1', groundLight: '#737b80', sunDir: [-45, 95, 30] },
  citadel: { skyTop: '#377fc1', skyHorizon: '#bcdef2', groundLight: '#6d7b60',
    sunDir: [40, 90, 55], grade: { highlightTint: [0.02, 0.009, -0.006], saturation: 1.06 } },
  solstice: { skybox: '/assets/skyboxes/desert-daylight.webp', skyTop: '#378bc9', skyHorizon: '#bce5f7',
    groundLight: '#817f6b', density: 0.003, sunDir: [30, 110, 25], sunlight: 1.45,
    grade: { highlightTint: [0.02, 0.012, -0.004], saturation: 1.06 } },
  caldera: { skybox: '/assets/skyboxes/volcanic-clouds.webp', skyTop: '#5686b4', skyHorizon: '#c1d7e8',
    groundLight: '#73747e', sunDisc: 0.55, sunDir: [-60, 85, -30],
    // Warm ash glow low on the horizon; the fog follows it so the volcano ridge melts in.
    fog: '#c3beb8', horizonGlow: '#ff8a45', horizonGlowStrength: 0.16,
    // Ash haze: warmer highlights, desaturated shadows with only a faint warm lean
    // (no contrast boost: the dark basalt under the overhangs must keep its grout).
    grade: { highlightTint: [0.028, 0.008, -0.012], shadowTint: [0.002, 0.001, 0.0], saturation: 1.0 } },
  nuketown: { skyTop: '#3987c9', skyHorizon: '#bee6fa', groundLight: '#73805f', density: 0.003,
    sunDir: [55, 100, 35], grade: { saturation: 1.08 } },
  dust2: { skybox: '/assets/skyboxes/desert-daylight.webp', skyTop: '#438fc9', skyHorizon: '#d5e6ec',
    groundLight: '#9a8668', sun: '#fff3df', density: 0.0028, sunDir: [70, 85, -30],
    grade: { highlightTint: [0.024, 0.012, -0.008], shadowTint: [-0.004, 0.002, 0.008], saturation: 1.06 },
    // Sandstone tunnels and stairwells: a higher enclosed floor keeps treads readable.
    light: { minSky: 0.62 } },
  killhouse: { skyTop: '#4e8dc5', skyHorizon: '#c9e5f5', groundLight: '#78838a', ambient: 0.82,
    sunDir: [45, 100, 50] },
  // Bright overworld day; the fog colour matches the map's env_fog_controller (173 199 255).
  minecraft_b5: { skyTop: '#3d8fe0', skyHorizon: '#c4dcff', fog: '#adc7ff', groundLight: '#6f8a5c',
    ambient: 0.9, sunlight: 1.36, density: 0.0022, grade: { saturation: 1.08 }, light: { minSky: 0.44 } },
  // Bright seaside day over the glass foyer roof; the hall's windows and the
  // long pool sight lines want thin, cool fog (sky_camera fog 225 242 237).
  waterworld: { skyTop: '#3d95dc', skyHorizon: '#cfe7f7', fog: '#e1f2ed', groundLight: '#7f929b',
    skyLight: '#e8f4fc', sun: '#fff8ea', ambient: 0.96, sunlight: 1.3, density: 0.0014,
    // The pools are indoors: only a faint sky sheen, never a blue mirror under a roof,
    // and a thin, dim foam lip (the fluid pass has no voxel light to darken it).
    light: { minSky: 0.6 }, envIntensity: 0.55,
    water: { reflection: 0.12, foam: 0.3, foamLight: 0.5 } },
  // Industrial reactor yard: grey-green haze, cool grade, softened sun.
  reactor: { skyTop: '#4d6f86', skyHorizon: '#b9c9cf', fog: '#aebcbf', groundLight: '#5f6a66', skyHaze: 0.5,
    skyLight: '#cfdde2', sun: '#f4f1e6', ambient: 0.84, sunlight: 1.2, density: 0.0032, sunDisc: 0.6,
    sunDir: [-40, 95, -45],
    grade: { shadowTint: [-0.002, 0.005, 0.006], highlightTint: [0.006, 0.008, 0.0], saturation: 0.98 } },
  // Overcast dam crossing: procedural grey deck (no panorama, no sun disc),
  // grey scud for the voxel clouds and fog matched to the horizon.
  causeway: { skybox: null, skyTop: '#87949c', skyHorizon: '#bac4c9', fog: '#b8c2c7', density: 0.0026, groundLight: '#5d6e70',
    overcast: 0.85, deckColor: '#a7b1b7', cloud: '#b1babf',
    ambient: 0.9, sunlight: 0.95, sunDisc: 0, sunDir: [20, 120, 30],
    grade: { saturation: 0.94, shadowTint: [-0.003, 0.002, 0.008], highlightTint: [0.0, 0.004, 0.008] },
    light: { minSky: 0.54 } },
  // Sunlit shallow sea: teal gradient, pink puff clouds read as "sky flowers",
  // soft overhead surface glow. skybox: null keeps the clouds visible; fog
  // stays under the 0.007 bot-fairness cap (bots see through client fog).
  bikini_bottom: { skybox: null, skyTop: '#0b5a86', skyHorizon: '#46c2d4', fog: '#3aa8bf', density: 0.0062,
    skyLight: '#c8f6ff', groundLight: '#d8c48c', sun: '#eafcff', ambient: 0.98, sunlight: 1.05, cloud: '#ffd6ec',
    sunDisc: 0.35, sunDir: [20, 120, 10],
    grade: { shadowTint: [-0.01, 0.008, 0.02], highlightTint: [0.0, 0.01, 0.012], saturation: 1.1 },
    light: { minSky: 0.4 }, envIntensity: 0.55 },
};
/**
 * Scenery beyond the walls and in the air (map-backdrop.js, map-ambience.js).
 *   ambience  { kind: dust|sparse|embers|pollen|mist|drizzle|none, ...preset overrides }
 *   backdrop  map-backdrop.js: { style terrain|mesa|industrial|city|harbor|islands|nuketown,
 *               ground (base y), shape mesa|hills|peaks|islands, colors (wall strata),
 *               top/top2 (caps), height [lo, hi] m, near/depth (landform ring, m beyond
 *               the map rectangle), maxRise (height cap per metre of distance), air
 *               { strength, near, far, fog } aerial perspective, open sectors [deg,
 *               0 = +x, 90 = +z], sea, volcano, towers/stacks/cranes [angle, gap, h, r],
 *               skyline [h0, h1] fades it out as the camera rises h0..h1 m above ground }
 */
const SCENERY = {
  dust2: { ambience: { kind: 'dust' },
    // Low, far sandstone mesas that only peek over the walls; the overview
    // camera sees the arena on open sky (skyline fade).
    backdrop: { style: 'terrain', shape: 'mesa', seed: 2, ground: 12.95,
      colors: ['#c4a071', '#ae8a5f', '#d0af80', '#a6825a'], top: '#d6be90', top2: '#cbb080',
      height: [8, 22], near: 135, depth: 100, terrace: 6, scale: 48, band: 3, maxRise: 0.13, baseHaze: 0.3,
      groundColor: '#c09f70', groundHaze: [0.25, 0.9], hazeColor: '#d2b88e', hazeTint: 0.6,
      air: { strength: 0.2, fog: 0.3 }, skyline: [30, 60] } },
  canyon: { ambience: { kind: 'dust', color: '#f1d7b2' },
    backdrop: { style: 'terrain', shape: 'mesa', seed: 3, ground: 14.95,
      colors: ['#c2875a', '#a66b45', '#d49d6b', '#98603f'], top: '#d9ae7c', top2: '#c99a68',
      height: [12, 40], near: 105, depth: 110, terrace: 8, scale: 55, band: 4, groundColor: '#c59a6a', hazeColor: '#e6d4b8', skyline: [30, 60] } },
  solstice: { ambience: { kind: 'dust', color: '#f7ead0' },
    backdrop: { style: 'terrain', shape: 'mesa', seed: 4, ground: 14.95,
      colors: ['#c3966a', '#a97d56', '#d3a877', '#9c7250'], top: '#dcc196', top2: '#cfae80',
      height: [14, 40], near: 110, depth: 105, terrace: 6, scale: 50, band: 3, maxRise: 0.26, groundColor: '#d2b98e', hazeColor: '#e4d6bc', skyline: [30, 60] } },
  caldera: { ambience: { kind: 'embers' },
    backdrop: { style: 'terrain', shape: 'peaks', seed: 5, ground: 14.95,
      colors: ['#3a3133', '#57494a', '#463b3c', '#6e5d58'], top: '#8a7d74', top2: '#6f6560', crater: '#2a2220', glow: '#ff7a1a',
      height: [14, 44], near: 105, depth: 110, scale: 60, band: 3, maxRise: 0.28, groundColor: '#4a4345',
      volcano: { angle: 268, gap: 165, height: 80, radius: 80, crater: 13, deep: 6 }, air: { strength: 0.52, far: 300 } } },
  foundry: { ambience: { kind: 'embers', density: 0.35, mix: 0.7 },
    backdrop: { style: 'industrial', seed: 6, ground: 14.95, hills: ['#66705d', '#59624f', '#727a63'], hillTop: '#71864f', hillTop2: '#7d8a5c',
      gap: [130, 170], hillHeight: [14, 36], hillNear: 160, maxRise: 0.28, groundColor: '#6c7163', sheds: ['#7d7f82', '#8a6f5c', '#6c7075'], shedCount: 9,
      stacks: [[250, 150, 74, 5], [262, 162, 82, 6], [300, 140, 66, 5], [200, 155, 70, 5], [60, 150, 68, 5]] } },
  depot: {
    backdrop: { style: 'industrial', seed: 7, ground: 14.95, hills: ['#6d7468', '#62685f', '#777d6c'], hillTop: '#768560',
      gap: [125, 165], hillHeight: [14, 36], hillNear: 160, maxRise: 0.28, groundColor: '#6f726d', sheds: ['#7f8386', '#8b6c57', '#5f6f7a', '#a19a8a'], shedCount: 14,
      stacks: [[228, 150, 44, 5]], cranes: [[262, 128, 34], [288, 136, 34], [92, 130, 34], [120, 140, 34]] } },
  reactor: { ambience: { kind: 'sparse', color: '#e6ece6' },
    backdrop: { style: 'industrial', seed: 8, ground: 14.95, hills: ['#687169', '#5c645d', '#737a70'], hillTop: '#6d7a64',
      gap: [125, 170], hillHeight: [14, 34], hillNear: 165, maxRise: 0.28, groundColor: '#62685f', sheds: ['#8b8e8a', '#6e726f'], shedCount: 8, concrete: '#b0b2ad',
      towers: [[222, 175, 56, 20], [248, 195, 62, 22], [200, 205, 52, 18], [38, 185, 54, 20], [300, 190, 58, 20]],
      stacks: [[272, 150, 60, 5]] } },
  // Citadel's courtyard walls hide anything lower than a sky-filling skyline: clean sky.
  citadel: { ambience: { kind: 'pollen' } },
  nuketown: { ambience: { kind: 'pollen', density: 0.45 },
    backdrop: { style: 'nuketown', lit: true, ground: 13.9, groundColor: '#c4ad83', colors: ['#a79078'] } },
  killhouse: {
    backdrop: { style: 'terrain', shape: 'hills', seed: 10, ground: 14.95,
      colors: ['#6f6a55', '#5e5a48', '#7a735c', '#66614e'], top: '#6f8a4c', top2: '#80905c', lip: 0.8,
      height: [14, 44], near: 105, depth: 105, scale: 55, band: 3.5, maxRise: 0.3, groundColor: '#7c8166' } },
  harbor: { ambience: { kind: 'mist', floor: 15 },
    backdrop: { style: 'harbor', seed: 11, ground: 8, sea: { y: 12.4, color: '#3f7286' },
      colors: ['#8d8f92', '#a39a8a', '#6f7a80', '#b8b1a3'], height: [16, 40], gap: [120, 160],
      land: { color: '#7b7e7b', y: 15, channel: 64, cityOpen: [[62, 298]] },
      cranes: [[330, 90, 34], [348, 84, 34], [14, 86, 34], [32, 92, 34]], stacks: [],
      headland: ['#6f7564', '#5f6656', '#77725f'], headlandTop: '#6f8a55', headlandSand: '#8f7f58', headlandOpen: [[0, 70], [200, 255], [290, 360]],
      headlandShape: 'islands', headlandHeight: [1, 24], headlandNear: 100, scale: 45,
      baseHaze: 0.15, hazeGround: 12.4, hazeHeight: 10 } },
  // Overcast dam valley: steep grass-topped ridges and the reservoir to the north.
  causeway: { ambience: { kind: 'drizzle' },
    backdrop: { style: 'terrain', shape: 'peaks', seed: 12, ground: 14.95,
      colors: ['#5e6a62', '#6b766d', '#535e57', '#646d60'], top: '#62745a', top2: '#6f7d5f', rock: '#7d8581', rockAbove: 30, lip: 0.8,
      height: [22, 60], near: 95, depth: 110, scale: 65, band: 3.5, maxRise: 0.34, groundColor: '#56635b',
      sea: { y: 33, sides: ['north'], color: '#4b6a72' } } },
  minecraft_b5: { ambience: { kind: 'sparse' },
    backdrop: { style: 'islands', seed: 13, ground: 35, colors: ['#7c7c7a', '#6e6e6c', '#86786a', '#747472'], top: '#6a9a45', top2: '#5f8f3d',
      sand: '#d9cc93', sandBelow: 2, height: [1, 18], near: 110, depth: 120, scale: 38, band: 2, baseHaze: 0.15, hazeHeight: 6, cell: 4, step: 2, air: { strength: 0.2 }, open: [[240, 300]] } },
  waterworld: { ambience: { kind: 'mist', floor: 8, indoor: 0, fixed: 70, alpha: 0.03 },
    backdrop: { style: 'city', seed: 14, ground: 8.95, colors: ['#b8ad9a', '#9c8f80', '#8a9296'],
      height: [12, 34], gap: [110, 150], count: 20, groundColor: '#7f8a80', hills: ['#6f7d6a', '#65725f'], hillTop: '#7c9160', hillHeight: [10, 26] } },
};
export function mapAtmosphere(mapId) {
  const palette = PALETTES[mapId] || {};
  return {
    ...DEFAULT,
    ...palette,
    ...SCENERY[mapId],
    grade: { ...DEFAULT.grade, ...palette.grade },
    light: { ...DEFAULT.light, ...palette.light },
    water: { ...DEFAULT.water, ...palette.water },
  };
}
