// Animated fluid surfaces for the voxel world: water (translucent, rippling,
// fresnel-weighted, sun-lit) and lava (opaque, glowing, slowly flowing).
// One shared clock drives every registered material so chunk meshes and the
// far sea plane animate in step. Vertex colours keep the mesher's AO/shade.
import * as THREE from '../vendor/three.module.js';
import { SUN_DIR } from './sky.js';

const registry = new Set();
let clock = 0;

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
  vec3 displaced = position;
  vTop = step(0.5, normal.y);
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  // Long, slow swells on the surface only; world-space phase keeps chunk
  // seams continuous and the shore edge of a column stays put.
  float swell = sin(worldPosition.x * 0.9 + time * 1.1) * 0.55
    + sin(worldPosition.z * 1.3 - time * 0.8) * 0.3
    + sin((worldPosition.x + worldPosition.z) * 0.45 + time * 0.5) * 0.15;
  displaced.y -= vTop * waveHeight * (0.55 + 0.45 * swell);
  worldPosition = modelMatrix * vec4(displaced, 1.0);
  vWorldPos = worldPosition.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
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
  // Soften the pixel-art pattern so it reads as sparkle, not stripes.
  vec3 tile = mix(vec3(1.0), texture2D(map, tileRect.xy + drift * size).rgb, tileWeight);

  vec3 normal = normalize(vNormalW);
  vec3 view = normalize(cameraPosition - vWorldPos);
  vec3 sun = normalize(sunDir);
  if (vTop > 0.5) {
    vec2 p = vWorldPos.xz * rippleScale;
    float e = 0.15;
    float h0 = ripple(p, time);
    float dx = ripple(p + vec2(e, 0.0), time) - h0;
    float dz = ripple(p + vec2(0.0, e), time) - h0;
    normal = normalize(normal + vec3(-dx, 0.0, -dz) * rippleStrength);
  }
  // Grazing views see the surface; looking straight down sees into the water.
  float facing = abs(dot(normal, view));
  float fresnel = pow(1.0 - facing, 3.0);
  vec3 base = mix(deepColor, shallowColor, fresnel) * tile;
  float diffuse = 0.6 + 0.4 * max(dot(normal, sun), 0.0);
  vec3 halfway = normalize(sun + view);
  float spec = pow(max(dot(normal, halfway), 0.0), shininess) * specularStrength;
  vec3 color = base * diffuse * vColorW + vec3(spec) + glowColor * glow;
  float alpha = mix(opacityMin, opacityMax, fresnel);
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
  },
  lava: {
    shallowColor: 0xffc070, deepColor: 0xff8a2a, glowColor: 0xff5a00, glow: 0.22, tileWeight: 1,
    opacityMin: 1, opacityMax: 1, waveHeight: 0.04, rippleScale: 0.9, rippleStrength: 0.2,
    shininess: 18, specularStrength: 0.12, flow: [0.015, 0.006], transparent: false,
  },
});

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
    }]),
    vertexShader: VERT,
    fragmentShader: FRAG,
    vertexColors: true,
    transparent: preset.transparent,
    depthWrite: !preset.transparent,
    side: THREE.DoubleSide,
    fog: true,
  });
  material.uniforms.map.value = map;
  material.name = `fluid-${kind}`;
  material.userData.fluid = kind;
  registry.add(material);
  const dispose = material.dispose.bind(material);
  material.dispose = () => { registry.delete(material); dispose(); };
  return material;
}

/** Live material count, for tests and leak checks. */
export function fluidMaterialCount() { return registry.size; }
