/** Clear daylight keeps color in the buildings and props, without a sepia cast. */
const DEFAULT = Object.freeze({
  fog: '#b4cde1', density: 0.0036, skyTop: '#397fc4', skyHorizon: '#b3ddf5',
  skyLight: '#d2e5fa', groundLight: '#6e7775', sun: '#fff9f0',
  ambient: 0.78, sunlight: 1.35, cloud: '#ffffff',
});
const PALETTES = {
  foundry: { skyTop: '#367ab9', skyHorizon: '#b7dced', groundLight: '#697660' },
  depot: { skyTop: '#477fb8', skyHorizon: '#c6e0f1', groundLight: '#737b80' },
  citadel: { skyTop: '#377fc1', skyHorizon: '#bcdef2', groundLight: '#6d7b60' },
  solstice: { skyTop: '#378bc9', skyHorizon: '#bce5f7', groundLight: '#817f6b', density: 0.003 },
  caldera: { skyTop: '#5686b4', skyHorizon: '#c1d7e8', groundLight: '#73747e' },
  nuketown: { skyTop: '#3987c9', skyHorizon: '#bee6fa', groundLight: '#73805f', density: 0.003 },
  dust2: { skyTop: '#438fc9', skyHorizon: '#d5e6ec', groundLight: '#9a8668', sun: '#fff3df', density: 0.0028 },
  killhouse: { skyTop: '#4e8dc5', skyHorizon: '#c9e5f5', groundLight: '#78838a', ambient: 0.82 },
};
export function mapAtmosphere(mapId) {
  return { ...DEFAULT, ...PALETTES[mapId] };
}
