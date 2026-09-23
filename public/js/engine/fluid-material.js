// Animated fluid surfaces for the voxel world: water (translucent, rippling,
// fresnel-weighted, sun-lit, reflecting the palette sky, foaming at banks) and
// lava (opaque, glowing, slowly flowing).
// One shared clock drives every registered material so chunk meshes and the
// far sea plane animate in step. Vertex colours keep the mesher's AO/shade.
import * as THREE from '../vendor/three.module.js';
import { SUN_DIR } from './sky.js';

const registry = new Set();
let clock = 0;
let waterSky = {};
// Water shader detail per graphics tier, fixed at map load (it picks defines):
// 0 Low = sky reflection and shallow tint only, 1 Medium = one foam octave,
// 2 High/Ultra = + fine foam octave and bubble cells.
let waterDetail = 2;

/**
 * Pick the water shader detail for a graphics profile. WorldView calls it
 * before any water material exists; materials keep the detail they were
 * created with, so the program key never changes mid-match.
 */
export function configureFluidQuality(graphics = {}) {
  const tier = graphics?.tier;
  waterDetail = tier === 'low' ? 0 : tier === 'medium' ? 1 : 2;
  return waterDetail;
}

/** Advance every live fluid material; called once per rendered frame. */
export function tickFluidMaterials(dt) {
  if (!Number.isFinite(dt) || dt <= 0) return clock;
  clock = (clock + dt) % 3600;
  for (const material of registry) material.uniforms.time.value = clock;
  return clock;
}

export function fluidClock() { return clock; }

const VERT = /* glsl */`
#include <common>
#include <fog_pars_vertex>
uniform float time;
uniform float waveHeight;
varying vec3 vWorldPos;
varying vec3 vNormalW;
varying vec3 vColorW;
varying vec2 vUvW;
varying float vTop;
void main() {
  // World-space up decides the surface, so rotated planes (the B5 far sea)
  // swell and ripple exactly like chunk tops.
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vTop = step(0.5, vNormalW.y);
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  // Long, slow swells on the surface only; world-space phase keeps chunk
  // seams continuous and the shore edge of a column stays put.
  float swell = sin(worldPosition.x * 0.9 + time * 1.1) * 0.55
    + sin(worldPosition.z * 1.3 - time * 0.8) * 0.3
    + sin((worldPosition.x + worldPosition.z) * 0.45 + time * 0.5) * 0.15;
  worldPosition.y -= vTop * waveHeight * (0.55 + 0.45 * swell);
  vWorldPos = worldPosition.xyz;
  vColorW = color;
  vUvW = uv;
  vec4 mvPosition = viewMatrix * worldPosition;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */`
#include <common>
#include <fog_pars_fragment>
uniform sampler2D map;
uniform vec4 tileRect;
uniform vec2 flow;
uniform float time;
uniform vec3 sunDir;
uniform vec3 shallowColor;
uniform vec3 deepColor;
uniform vec3 glowColor;
uniform float glow;
uniform float opacityMin;
uniform float opacityMax;
uniform float rippleScale;
uniform float rippleStrength;
uniform float shininess;
uniform float specularStrength;
uniform float tileWeight;
varying vec3 vWorldPos;
varying vec3 vNormalW;
varying vec3 vColorW;
varying vec2 vUvW;
varying float vTop;
#ifdef FLUID_WATER
uniform vec3 skyColor;
uniform vec3 horizonColor;
uniform float reflection;
uniform float foamStrength;
uniform float foamLight;
#endif
#ifdef FLUID_FOAM
float foamHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float foamNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(foamHash(i), foamHash(i + vec2(1.0, 0.0)), f.x),
    mix(foamHash(i + vec2(0.0, 1.0)), foamHash(i + vec2(1.0)), f.x), f.y);
}
#endif

// Two drifting ripple fields; their gradient perturbs the surface normal.
float ripple(vec2 p, float t) {
  return sin(p.x * 1.7 + t * 1.6) * 0.5 + sin(p.y * 2.3 - t * 1.1) * 0.35
    + sin((p.x - p.y) * 1.1 + t * 0.7) * 0.15;
}

void main() {
  // Sample the block tile with a wrapped, drifting offset so the pixel art
  // itself moves; the rect keeps the lookup inside this tile of the atlas.
  vec2 size = tileRect.zw - tileRect.xy;
  vec2 local = (vUvW - tileRect.xy) / size;
  vec2 drift = fract(local + flow * time);
  // Gradients of the unwrapped lookup: the fract() wrap would otherwise pick the
  // smallest mip along a seam line in every block.
  vec2 tileUv = tileRect.xy + (local + flow * time) * size;
  vec3 texel = textureGrad(map, tileRect.xy + drift * size, dFdx(tileUv), dFdy(tileUv)).rgb;
  float viewDist = length(cameraPosition - vWorldPos);
#ifndef FLUID_WATER
  // Lava: the pixel-art crust settles towards the tile's mean colour (mip 4 is
  // one texel per 16 px tile) with distance, so mid-range lava cannot speckle.
  float lavaFar = smoothstep(8.0, 32.0, viewDist);
  vec3 tileMean = textureLod(map, (tileRect.xy + tileRect.zw) * 0.5, 4.0).rgb;
  texel = mix(texel, tileMean, lavaFar * 0.6);
#endif
  // Soften the pixel-art pattern so it reads as sparkle, not stripes.
  vec3 tile = mix(vec3(1.0), texel, tileWeight);

  vec3 normal = normalize(vNormalW);
  vec3 view = normalize(cameraPosition - vWorldPos);
  vec3 sun = normalize(sunDir);
  if (vTop > 0.5) {
    vec2 p = vWorldPos.xz * rippleScale;
    float e = 0.15;
    float h0 = ripple(p, time);
    float dx = ripple(p + vec2(e, 0.0), time) - h0;
    float dz = ripple(p + vec2(0.0, e), time) - h0;
#ifdef FLUID_WATER
    // Ripples calm with distance: past a few dozen metres they would only alias
    // into rings under the fresnel and specular terms.
    float calm = 1.0 - 0.97 * smoothstep(14.0, 55.0, viewDist);
    normal = normalize(normal + vec3(-dx, 0.0, -dz) * rippleStrength * calm);
#else
    normal = normalize(normal + vec3(-dx, 0.0, -dz) * rippleStrength);
#endif
  }
  // Grazing views see the surface; looking straight down sees into the water.
  float facing = abs(dot(normal, view));
  float fresnel = pow(1.0 - facing, 3.0);
  vec3 base = mix(deepColor, shallowColor, fresnel) * tile;
  float diffuse = 0.6 + 0.4 * max(dot(normal, sun), 0.0);
  vec3 halfway = normalize(sun + view);
  float spec = pow(max(dot(normal, halfway), 0.0), shininess) * specularStrength;
  vec3 color = base * diffuse * vColorW + vec3(spec);
#ifndef FLUID_WATER
  // Self-emission ignores AO and sun. Molten tile texels idle under 1.0 so the
  // sea keeps its orange; crust keeps a glow floor (never a black speckle) and
  // the tile contrast settles with distance. Thin wandering veins, snapped to
  // quarter-block pixels, run a little hot in a saturated orange so HDR tiers
  // bloom them without washing to white; they fade out once a cell nears pixel
  // size or the lava is far, before they could crawl.
  float molten = mix(0.55, 1.0, smoothstep(0.18, 0.42, dot(tile, vec3(0.299, 0.587, 0.114))));
  molten = mix(molten, 0.82, lavaFar);
  vec2 cell = floor(vWorldPos.xz * 4.0) * 0.25;
  float wave = cell.x * 0.8 + sin(cell.y * 0.6 + time * 0.25) * 1.8
    + sin(cell.y * 1.7 - time * 0.4) * 0.5 + time * 0.15;
  vec2 cellRate = fwidth(vWorldPos.xz) * 4.0;
  float resolved = (1.0 - smoothstep(0.2, 0.5, max(cellRate.x, cellRate.y)))
    * (1.0 - smoothstep(12.0, 32.0, viewDist));
  float hot = smoothstep(0.82, 0.97, 1.0 - abs(sin(wave)))
    * (0.55 + 0.45 * sin(cell.y * 0.35 + cell.x * 0.2 + time * 0.3)) * molten * resolved;
  color += glow * glowColor * 0.45 * molten;
  // Veins replace the surface rather than stack on it, so their peak stays
  // just over 1.0 and the roll-off keeps them orange-yellow, not white.
  color = mix(color, glow * 1.4 * vec3(1.0, 0.5, 0.05), hot);
#endif
  float alpha = mix(opacityMin, opacityMax, fresnel);
#ifdef FLUID_WATER
  // Without scene depth in this pass, the mesher's corner AO stands in for
  // proximity: a surface texel beside a bank or wall is shallow and foamy.
  // A bank or wall along an edge gives its vertices AO 0.62 (side + corner
  // occluded), fading to open water one block out: shore ~ 1 - distance. The
  // macro tone (+-6%) stays well below the foam threshold.
  float shade = max(vColorW.r, max(vColorW.g, vColorW.b));
  float shore = vTop * clamp((0.99 - shade) / 0.37, 0.0, 1.0);
  color = mix(color, shallowColor * tile * vColorW * diffuse, shore * 0.15);
  // Sky reflection: Schlick fresnel towards the palette sky, brighter where
  // the reflected ray climbs away from the horizon. Indoor maps damp it.
  vec3 reflected = reflect(-view, normal);
  vec3 sky = mix(horizonColor, skyColor, smoothstep(0.0, 0.6, reflected.y));
  // Top surfaces only: an edge-on side face would outline the voxel sea.
  float schlick = vTop * (0.02 + 0.98 * pow(1.0 - facing, 5.0));
  // Capped well below a mirror: the water keeps its own blue and the pool
  // tiles stay visible through it; distance fog, not reflection, hazes the sea.
  float mirror = clamp(schlick * reflection, 0.0, 0.55);
  color = mix(color, sky, mirror);
  alpha = mix(alpha, 0.92, mirror * 0.3);
#ifdef FLUID_FOAM
  // Foam (Medium and up): a narrow, soft, lapping lip hugging the last quarter
  // block beside a bank or wall (shore ~ 1 - distance in blocks).
  vec2 flowP = vWorldPos.xz + vec2(time * 0.22, time * 0.13);
#ifdef FLUID_FOAM_DETAIL
  // Fine detail settles to its mean with distance, before it could alias.
  float near = 1.0 - smoothstep(10.0, 36.0, viewDist);
  float n = foamNoise(flowP * 2.6) * 0.65
    + mix(0.5, foamNoise(vWorldPos.xz * 6.5 - time * 0.4), near) * 0.35;
#else
  float n = foamNoise(flowP * 2.6);
#endif
  float lapping = 0.5 + 0.5 * sin(time * 1.3 + (vWorldPos.x + vWorldPos.z) * 0.8);
  float foam = smoothstep(0.72, 0.95, shore * (0.92 + 0.08 * lapping) + (n - 0.5) * 0.14);
  // Grazing views squeeze the lip into a sub-pixel line: let it go.
  foam *= foamStrength * smoothstep(0.05, 0.35, facing);
#ifdef FLUID_FOAM_DETAIL
  // Bubbly, not painted: fine cells thin the foam out towards open water.
  float cells = smoothstep(0.25, 0.7, foamNoise(vWorldPos.xz * 11.0 + time * vec2(0.3, -0.2)));
  foam *= 0.6 + 0.4 * mix(0.5, cells, near);
#else
  foam *= 0.8;
#endif
  // Foam takes the mesher shade and the map's light level (this pass has no
  // voxel light, so indoor palettes dim it): a lip never glows or goes opaque.
  vec3 foamColor = vec3(0.80, 0.86, 0.90) * (0.45 + 0.25 * diffuse) * mix(0.6, 1.0, shade) * foamLight;
  color = mix(color, foamColor, foam * 0.55);
  alpha = mix(alpha, 0.85, foam * 0.6);
#endif
#endif
  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

const PRESETS = Object.freeze({
  water: {
    shallowColor: 0xb4dcff, deepColor: 0x3a74d6, glowColor: 0x000000, glow: 0, tileWeight: 0.45,
    opacityMin: 0.58, opacityMax: 0.92, waveHeight: 0.12, rippleScale: 1.8, rippleStrength: 0.35,
    shininess: 90, specularStrength: 0.8, flow: [0.02, 0.012], transparent: true,
    // Palette sky reflected at grazing angles and bank foam (applyWaterPalette sets them per map).
    skyColor: 0x397fc4, horizonColor: 0xb3ddf5, reflection: 0.5, foamStrength: 0.85,
    // Foam brightness scale for the map's light level (indoor palettes lower it).
    foamLight: 1,
  },
  lava: {
    // Lit colours stay dim: the glow carries lava's brightness, so the molten body
    // idles around 0.5 (orange survives eye adaptation and the highlight roll-off)
    // while the veins peak just over 1.0 and bloom faintly.
    shallowColor: 0x9a4a18, deepColor: 0x8a3a10, glowColor: 0xff7418, glow: 0.8, tileWeight: 1,
    opacityMin: 1, opacityMax: 1, waveHeight: 0.04, rippleScale: 0.9, rippleStrength: 0.2,
    // A faint sheen only: white specular on saturated orange reads as a pink wash.
    shininess: 18, specularStrength: 0.03, flow: [0.015, 0.006], transparent: false,
  },
});

function waterDefines(detail) {
  const defines = { FLUID_WATER: '' };
  if (detail >= 1) defines.FLUID_FOAM = '';
  if (detail >= 2) defines.FLUID_FOAM_DETAIL = '';
  return defines;
}

/**
 * @param {'water'|'lava'} kind
 * @param {{ map: THREE.Texture, tileRect: {u0,v0,u1,v1} }} atlas the atlas texture and the fluid's tile
 */
export function createFluidMaterial(kind, { map = null, tileRect = { u0: 0, v0: 1, u1: 1, v1: 0 } } = {}) {
  const preset = PRESETS[kind];
  if (!preset) throw new TypeError(`unknown fluid: ${kind}`);
  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      map: { value: null },
      tileRect: { value: new THREE.Vector4(tileRect.u0, tileRect.v1, tileRect.u1, tileRect.v0) },
      flow: { value: new THREE.Vector2(...preset.flow) },
      time: { value: clock },
      sunDir: { value: SUN_DIR.clone() },
      shallowColor: { value: new THREE.Color(preset.shallowColor) },
      deepColor: { value: new THREE.Color(preset.deepColor) },
      glowColor: { value: new THREE.Color(preset.glowColor) },
      glow: { value: preset.glow },
      opacityMin: { value: preset.opacityMin },
      opacityMax: { value: preset.opacityMax },
      waveHeight: { value: preset.waveHeight },
      rippleScale: { value: preset.rippleScale },
      rippleStrength: { value: preset.rippleStrength },
      shininess: { value: preset.shininess },
      specularStrength: { value: preset.specularStrength },
      tileWeight: { value: preset.tileWeight },
      ...(kind === 'water' ? {
        skyColor: { value: new THREE.Color(waterSky.skyColor ?? preset.skyColor) },
        horizonColor: { value: new THREE.Color(waterSky.horizonColor ?? preset.horizonColor) },
        reflection: { value: waterSky.reflection ?? preset.reflection },
        foamStrength: { value: waterSky.foam ?? preset.foamStrength },
        foamLight: { value: waterSky.foamLight ?? preset.foamLight },
      } : {}),
    }]),
    vertexShader: VERT,
    fragmentShader: FRAG,
    vertexColors: true,
    transparent: preset.transparent,
    depthWrite: !preset.transparent,
    side: THREE.DoubleSide,
    fog: true,
    defines: kind === 'water' ? waterDefines(waterDetail) : {},
  });
  material.uniforms.map.value = map;
  material.name = `fluid-${kind}`;
  material.userData.fluid = kind;
  registry.add(material);
  const dispose = material.dispose.bind(material);
  material.dispose = () => { registry.delete(material); dispose(); };
  return material;
}

/**
 * Point every live water surface (chunk buckets, the B5 far sea) at a map
 * palette: its sky colours for the fresnel reflection, `palette.water`
 * reflection and foam strengths and the foam light level (`foamLight`).
 * Later water materials start from it too.
 */
export function applyWaterPalette(palette = {}) {
  const water = palette.water || {};
  waterSky = {
    skyColor: palette.skyTop ?? PRESETS.water.skyColor,
    horizonColor: palette.skyHorizon ?? PRESETS.water.horizonColor,
    reflection: Number.isFinite(water.reflection) ? water.reflection : PRESETS.water.reflection,
    foam: Number.isFinite(water.foam) ? water.foam : PRESETS.water.foamStrength,
    foamLight: Number.isFinite(water.foamLight) ? water.foamLight : PRESETS.water.foamLight,
  };
  for (const material of registry) {
    if (material.userData.fluid !== 'water') continue;
    const u = material.uniforms;
    u.skyColor.value.set(waterSky.skyColor);
    u.horizonColor.value.set(waterSky.horizonColor);
    u.reflection.value = waterSky.reflection;
    u.foamStrength.value = waterSky.foam;
    u.foamLight.value = waterSky.foamLight;
  }
  return waterSky;
}

/** Live material count, for tests and leak checks. */
export function fluidMaterialCount() { return registry.size; }
