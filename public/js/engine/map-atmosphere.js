/** Clear daylight keeps color in the buildings and props, without a sepia cast. */
const DEFAULT = Object.freeze({
  skybox: '/assets/skyboxes/voxel-daylight.webp',
  fog: '#b4cde1', density: 0.0036, skyTop: '#397fc4', skyHorizon: '#b3ddf5',
  skyLight: '#d2e5fa', groundLight: '#6e7775', sun: '#fff9f0',
  ambient: 0.78, sunlight: 1.35, cloud: '#ffffff',
});
const PALETTES = {
  harbor: { skyTop: '#467d99', skyHorizon: '#bedbe8', fog: '#bbd7e2',
    groundLight: '#66858c', skyLight: '#d3eafa', sun: '#fff6e5', ambient: 0.86, sunlight: 1.42, density: 0.0018 },
  canyon: { skybox: '/assets/skyboxes/desert-daylight.webp', fog: '#dfd3b9', groundLight: '#b49872',
    skyLight: '#dde9f1', sun: '#fff0d6', ambient: 0.86, sunlight: 1.48, density: 0.0018 },
  foundry: { skyTop: '#367ab9', skyHorizon: '#b7dced', groundLight: '#697660' },
  depot: { skyTop: '#477fb8', skyHorizon: '#c6e0f1', groundLight: '#737b80' },
  citadel: { skyTop: '#377fc1', skyHorizon: '#bcdef2', groundLight: '#6d7b60' },
  solstice: { skybox: '/assets/skyboxes/desert-daylight.webp', skyTop: '#378bc9', skyHorizon: '#bce5f7', groundLight: '#817f6b', density: 0.003 },
  caldera: { skybox: '/assets/skyboxes/volcanic-clouds.webp', skyTop: '#5686b4', skyHorizon: '#c1d7e8', groundLight: '#73747e' },
  nuketown: { skyTop: '#3987c9', skyHorizon: '#bee6fa', groundLight: '#73805f', density: 0.003 },
  dust2: { skybox: '/assets/skyboxes/desert-daylight.webp', skyTop: '#438fc9', skyHorizon: '#d5e6ec', groundLight: '#9a8668', sun: '#fff3df', density: 0.0028 },
  killhouse: { skyTop: '#4e8dc5', skyHorizon: '#c9e5f5', groundLight: '#78838a', ambient: 0.82 },
  // Bright overworld day; the fog colour matches the map's env_fog_controller (173 199 255).
  // Bright seaside day over the glass foyer roof; the hall's windows and the
  // long pool sight lines want thin, cool fog (sky_camera fog 225 242 237).
  waterworld: { skyTop: '#3d95dc', skyHorizon: '#cfe7f7', fog: '#e1f2ed', groundLight: '#7f929b',
    skyLight: '#e8f4fc', sun: '#fff8ea', ambient: 0.96, sunlight: 1.3, density: 0.0014 },
  minecraft_b5: { skyTop: '#3d8fe0', skyHorizon: '#c4dcff', fog: '#adc7ff', groundLight: '#6f8a5c', ambient: 0.9, sunlight: 1.36, density: 0.0022 },
  // Overcast dam crossing: flat grey-blue sky and thin cool fog down the corridor.
  causeway: { skyTop: '#3b6f8f', skyHorizon: '#b9cfd9', fog: '#b7c9d3', density: 0.0026, groundLight: '#5d6e70', ambient: 0.8 },
};
export function mapAtmosphere(mapId) {
  return { ...DEFAULT, ...PALETTES[mapId] };
}
