// Redrock Canyon scenery and weather (map-atmosphere.js mapAtmosphere('redrock')).
// The battlefield shares Frontier's render path (far terrain, distant shell,
// airspace apron, horizon ranges), so every knob here only changes uniform
// values and baked vertex colours, never a program key:
//   desert  high, hard afternoon sun from the south-west, pale blue zenith over
//           a warm dust horizon, thin haze so the mesas and landmarks read
//           across the canyon, turquoise reservoir water (the default)
//   dusk    low red sun from the west, long shadows, violet zenith, denser
//           dust haze
// The ranges beyond the apron are red sandstone (banded strata, tan caps),
// with no forest band and no snow; the apron colours follow APRON_KIND.

export const REDROCK_WEATHER = Object.freeze(['desert', 'dusk']);

const REDROCK_SCENERY = {
  skybox: null, density: 0.002,
  clouds: false,
  backdrop: Object.freeze({ style: 'terrain', shape: 'peaks', seed: 33, ground: 34,
    colors: ['#a4553a', '#9a4f36', '#b4673f', '#8d4630'], top: '#c98d5c', top2: '#d6a46c', rock: '#b06a48', rockAbove: 70,
    lip: 1.4, ambient: 0.4, direct: 1.0, height: [18, 260], near: 40, rise: 50, depth: 430, scale: 140, band: 7, cell: 14, step: 4,
    maxRise: 0.8, risePow: 1.6, jitter: 0.07,
    // Rounded buttes up front, broken red ridges behind, tall far ranges.
    ranges: Object.freeze([
      Object.freeze({ near: 40, far: 190, height: [6, 60], scale: 70, sharp: 1.1, haze: 0 }),
      Object.freeze({ near: 150, far: 320, height: [24, 170], scale: 110, sharp: 1.4, haze: 0.14 }),
      Object.freeze({ near: 280, far: 470, height: [40, 380], scale: 160, sharp: 1.9, haze: 0.3 }),
    ]),
    slope: 1.1,
    groundColor: '#c08a5c', groundHaze: [0.15, 0.85], groundSkirt: 30, baseHaze: 0.2, hazeHeight: 25,
    air: Object.freeze({ strength: 0.3, near: 600, far: 1400, fog: 0.2 }),
    airspace: Object.freeze({ cell: 22, step: 6, band: 24,
      ranges: Object.freeze([
        Object.freeze({ near: 40, far: 200, height: [10, 90], scale: 90, sharp: 1.2, haze: 0.05 }),
        Object.freeze({ near: 160, far: 340, height: [30, 240], scale: 130, sharp: 1.5, haze: 0.16 }),
        Object.freeze({ near: 290, far: 470, height: [50, 480], scale: 180, sharp: 2.0, haze: 0.3 }),
      ]),
      height: [30, 360] }),
    // Outer desert (airspace-apron.js): colours in APRON_KIND order
    // (meadow, dry, field, forest, rock, shore, water, gravel, desert, red rock).
    apron: Object.freeze({ colors: Object.freeze(['#8a8a50', '#a99760', '#b8a06a', '#5d6b3c', '#9a5a3e', '#c9a77a', '#3f7d84', '#9c8a74', '#d29a66', '#a8573a']),
      bank: '#b08a62', jitter: 0.1 }) }),
};

const REDROCK_PRESETS = {
  desert: { skyTop: '#5f8fcb', skyHorizon: '#f0c9a0', skyMid: '#e9dcc8', skyMidAt: 0.3, fog: '#e2c4a2', skyHaze: 0.16,
    horizonGlow: '#ffb070', horizonGlowStrength: 0.1, sunGlow: 0.25,
    cloudLayer: { cover: 0.2, lit: '#fff1dc', shade: '#c9a990' }, cloud: '#fff0dc',
    skyLight: '#a9c2e2', groundLight: '#a0603c', sun: '#fff0d2', ambient: 0.6, sunlight: 2.2,
    sunDir: [-48, 74, 34], sunDisc: 1.2, envIntensity: 0.42, fogScale: 0.4, airFogScale: 1,
    grade: { highlightTint: [0.03, 0.012, -0.018], shadowTint: [0.004, -0.004, 0.016], saturation: 1.12, contrast: 1.06 },
    light: { minSky: 0.44, shadow: 0.86 },
    ambience: { kind: 'dust', floor: 20, band: 40, color: '#f1d7b2', density: 0.5 },
    water: { reflection: 0.55, shallow: '#3f8f8f', deep: '#174a55', tile: 0.2, specular: 1.0 },
    backdropHaze: '#d9b79a', backdropHazeTint: 0.7, backdropLight: { sun: '#ffe6c4', sky: '#b4c2d8' } },
  dusk: { skyTop: '#5d5d9a', skyHorizon: '#ff9a5a', skyMid: '#f2b88a', skyMidAt: 0.28, fog: '#d39a7a', skyHaze: 0.2,
    horizonGlow: '#ff7a3a', horizonGlowStrength: 0.2, sunGlow: 0.45,
    cloudLayer: { cover: 0.45, lit: '#ffb27a', shade: '#7d5a78' }, cloud: '#ffb890',
    skyLight: '#9a9cc8', groundLight: '#8a4a30', sun: '#ffb070', ambient: 0.58, sunlight: 1.9,
    sunDir: [-70, 34, 22], sunDisc: 1.5, envIntensity: 0.4, fogScale: 0.6, airFogScale: 1.1,
    grade: { highlightTint: [0.05, 0.012, -0.03], shadowTint: [-0.006, -0.004, 0.024], saturation: 1.1, contrast: 1.08 },
    light: { minSky: 0.4, shadow: 0.8 },
    ambience: { kind: 'dust', floor: 20, band: 46, color: '#ffc49a', density: 0.6 },
    water: { reflection: 0.7, shallow: '#4b6d78', deep: '#1c3440', tile: 0.2, specular: 1.2 },
    backdropHaze: '#b9889a', backdropHazeTint: 0.85, backdropLight: { sun: '#ffc08a', sky: '#9a92b8' } },
};

/** The Redrock weather a map shows: a capture override, else the authored mapMeta value, else desert. */
export function resolveRedrockWeather(meta, override = null) {
  const wanted = override ?? meta?.conquest?.weather ?? null;
  return REDROCK_WEATHER.includes(wanted) ? wanted : 'desert';
}

export function redrockAtmosphere(weather) {
  const name = REDROCK_WEATHER.includes(weather) ? weather : 'desert';
  const { backdropHaze, backdropHazeTint = 0.55, backdropLight = null, ...rest } = REDROCK_PRESETS[name];
  const base = REDROCK_SCENERY.backdrop;
  return {
    ...rest,
    ...REDROCK_SCENERY,
    weather: name,
    backdrop: { ...base, hazeColor: backdropHaze, hazeTint: backdropHazeTint, light: backdropLight },
  };
}
