// Ambient air particles: dust motes, embers and ash, pollen, low mist or
// drizzle, one THREE.Points draw per map. Every particle lives in a unit box
// that the vertex shader scales, drifts and wraps around the camera, so the
// field is endless and the CPU only ever writes two uniforms per frame.
//
// Program keys are fixed at map load: the kind only changes uniform values,
// never defines, and the particle count only sizes the buffer.
//   - premultiplied blending (ONE, ONE_MINUS_SRC_ALPHA): embers write alpha 0
//     and add light (they bloom on HDR tiers), ash and dust composite over
//   - covered cells fade through the voxel light volume's sky channel, so
//     halls and tunnels stay clear; embers keep drifting indoors
//   - fog is applied to the straight colour before premultiplying; the stock
//     fog chunk would tint the transparent corners of each sprite

import * as THREE from '../vendor/three.module.js';
import { mulberry32 } from '../../../shared/noise.js';
import { displaySettings } from '../ui/display-settings.js';
import { FAR_FADE_START, FAR_FADE_END } from './fog-chunk.js';

export const AMBIENCE_MIN_PARTICLES = 250;

/**
 * Kind presets. box: wrap volume around the camera (m); size: sprite world
 * size (m); vel/vel2: drift of the primary and secondary population (m/s);
 * mix: share of the secondary population (ash beside embers);
 * indoor: 1 fades particles where the sky is covered; band: height above the
 * map floor the field fades out by (0 = none); streak: 1 draws thin rain lines.
 * fixed: particle count that ignores the graphics tier, so a kind that can
 * veil targets (mist) looks the same on every tier; maxPx: largest sprite,
 * bigger ones fade out instead of clamping into a flat disc.
 * soft: 1 makes a haze layer: a flat bell falloff, clipped per fragment to
 * the band above the floor, and faded where solid voxels sit beside or under
 * the sprite, so billboards never cut hard lines into floors or walls.
 */
export const AMBIENCE_KINDS = Object.freeze({
  dust: {
    density: 1, box: [34, 14, 34], size: 0.034, alpha: 0.34, color: '#efdcb4', color2: '#efdcb4',
    vel: [0.32, 0.03, 0.14], vel2: [0.32, 0.03, 0.14], wobble: 0.55, mix: 0, additive: 0, indoor: 1, sunlit: 0.7,
    band: 26, near: 2.5,
  },
  sparse: {
    density: 0.35, box: [30, 12, 30], size: 0.032, alpha: 0.3, color: '#f2efe6', color2: '#f2efe6',
    vel: [0.18, 0.02, 0.1], vel2: [0.18, 0.02, 0.1], wobble: 0.5, mix: 0, additive: 0, indoor: 1, sunlit: 0.7,
    band: 20, near: 2.5,
  },
  embers: {
    density: 0.7, box: [34, 18, 34], size: 0.05, alpha: 0.95, color: '#ff8a2c', color2: '#6d6765',
    vel: [0.2, 0.85, 0.08], vel2: [0.25, -0.28, 0.12], wobble: 0.8, mix: 0.55, additive: 1, indoor: 0, sunlit: 0,
    glow: 2.6, band: 45, near: 1.5,
  },
  pollen: {
    density: 0.55, box: [32, 12, 32], size: 0.045, alpha: 0.5, color: '#fff1b8', color2: '#fbfbf2',
    vel: [0.26, 0.05, 0.2], vel2: [0.2, -0.04, 0.16], wobble: 1.1, mix: 0.35, additive: 0, indoor: 1, sunlit: 0.6,
    band: 14, near: 2.5,
  },
  mist: {
    density: 1, fixed: 110, box: [48, 8, 48], size: 7, alpha: 0.055, color: '#e4eef2', color2: '#e4eef2',
    vel: [0.35, 0.03, 0.12], vel2: [0.35, 0.03, 0.12], wobble: 0.9, mix: 0, additive: 0, indoor: 1, sunlit: 0,
    band: 3.5, near: 7, soft: 1, maxPx: 360,
  },
  drizzle: {
    density: 1.3, box: [28, 18, 28], size: 0.3, alpha: 0.16, color: '#d3dde4', color2: '#d3dde4',
    vel: [0.7, -8.5, 0.35], vel2: [0.7, -8.5, 0.35], wobble: 0.05, mix: 0, additive: 0, indoor: 1, sunlit: 0,
    streak: 1, near: 2,
  },
});

const VERT = /* glsl */ `
attribute float seed;
uniform float uTime;
uniform vec3 uBox;
uniform vec3 uVel;
uniform vec3 uVel2;
uniform float uMix;
uniform float uWobble;
uniform float uSize;
uniform float uViewH;
uniform float uAlpha;
uniform float uIndoor;
uniform float uSunlit;
uniform float uFloor;
uniform float uBand;
uniform float uNear;
uniform float uMaxPx;
uniform float uSoft;
uniform highp sampler3D voxelLightMap;
uniform vec3 voxelLightSize;
varying float vAlpha;
varying float vSecond;
varying float vFogDepth;
varying vec2 vLayer;
void main() {
  vSecond = step(1.0 - uMix, seed);
  float pace = 0.65 + 0.7 * fract(seed * 7.13);
  vec3 p = position * uBox + mix(uVel, uVel2, vSecond) * uTime * pace;
  float t = uTime * (0.35 + 0.4 * fract(seed * 3.7)) + seed * 61.0;
  p += uWobble * vec3(sin(t * 1.3 + position.y * 9.0), 0.45 * sin(t * 0.9 + position.x * 7.0),
    cos(t * 1.1 + position.z * 8.0));
  vec3 halfBox = uBox * 0.5;
  vec3 rel = mod(p - cameraPosition + halfBox, uBox) - halfBox;
  vec3 world = cameraPosition + rel;
  vec3 edge = abs(rel) / halfBox;
  float alpha = uAlpha * (1.0 - smoothstep(0.72, 1.0, max(max(edge.x, edge.y), edge.z)));

  // Covered cells have little sky: fade there. Beyond the map there is only sky.
  vec3 lp = world / voxelLightSize;
  vec2 L = texture(voxelLightMap, lp).rg;
  float outside = step(1.0, lp.y) + step(lp.x, 0.0) + step(1.0, lp.x) + step(lp.z, 0.0) + step(1.0, lp.z);
  L = mix(L, vec2(1.0), min(outside, 1.0));
  alpha *= mix(1.0, smoothstep(0.45, 0.9, L.r), uIndoor);
  alpha *= mix(1.0, 0.35 + 0.65 * L.g, uSunlit);
  float worldSize = uSize * (0.7 + 0.6 * fract(seed * 13.7));
  if (uSoft > 0.5) {
    // Haze sprites fade where solid voxels sit beside or below them (opaque
    // cells two deep read zero sky), relative to the sky at the centre.
    float r = worldSize * 0.3;
    float s = min(texture(voxelLightMap, (world + vec3(r, 0.0, 0.0)) / voxelLightSize).r,
      texture(voxelLightMap, (world - vec3(r, 0.0, 0.0)) / voxelLightSize).r);
    s = min(s, min(texture(voxelLightMap, (world + vec3(0.0, 0.0, r)) / voxelLightSize).r,
      texture(voxelLightMap, (world - vec3(0.0, 0.0, r)) / voxelLightSize).r));
    s = min(s, texture(voxelLightMap, (world - vec3(0.0, r, 0.0)) / voxelLightSize).r);
    alpha *= mix(smoothstep(0.15, 0.7, s / max(L.r, 0.05)), 1.0, min(outside, 1.0));
  }
  if (uBand > 0.0) {
    float h = world.y - uFloor;
    alpha *= smoothstep(-0.5, 1.0, h) * (1.0 - smoothstep(uBand * 0.45, uBand, h));
  }

  vec4 mvPosition = viewMatrix * vec4(world, 1.0);
  float dist = max(-mvPosition.z, 0.05);
  alpha *= smoothstep(uNear * 0.3, uNear, dist);
  float px = worldSize * uViewH * projectionMatrix[1][1] * 0.5 / dist;
  // Sub-pixel motes keep their energy as fainter 1.5 px points instead of shimmering;
  // sprites past the size cap fade out rather than shrinking into flat discs.
  alpha *= min(1.0, px * px / 2.25) * (1.0 - smoothstep(0.7 * uMaxPx, uMaxPx, px));
  gl_PointSize = clamp(px, 1.5, uMaxPx);
  // Haze layer: sprite centre height above the floor and half its world size.
  vLayer = vec2(world.y - uFloor, worldSize * 0.5);
  vAlpha = alpha;
  vFogDepth = dist;
  gl_Position = projectionMatrix * mvPosition;
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uColor2;
uniform float uAdditive;
uniform float uGlow;
uniform float uStreak;
uniform float uSoft;
uniform float uBand;
#ifdef USE_FOG
uniform vec3 fogColor;
#ifdef FOG_EXP2
uniform float fogDensity;
#else
uniform float fogNear;
uniform float fogFar;
#endif
#endif
varying float vAlpha;
varying float vSecond;
varying float vFogDepth;
varying vec2 vLayer;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  // Motes have a small solid core; mist is a flat bell with no visible rim.
  float r = length(c);
  float disc = mix(1.0 - smoothstep(0.18, 0.5, r), 1.0 - smoothstep(0.0, 0.5, r), uSoft);
  if (uSoft > 0.5) {
    // Clip the billboard to a layer over the floor (point sprites stand upright
    // on screen, so the row maps to world height): no hard cut into the ground,
    // densest at the ankles, thinning out well below eye height.
    float h = vLayer.x - c.y * 2.0 * vLayer.y;
    disc *= smoothstep(0.0, 0.9, h) * (1.0 - smoothstep(0.0, max(uBand, 0.5), h));
  }
  float line = (1.0 - smoothstep(0.03, 0.09, abs(c.x))) * (1.0 - smoothstep(0.3, 0.5, abs(c.y)));
  float shape = mix(disc, line, uStreak);
  float a = vAlpha * shape;
  if (a < 0.002) discard;
  // Embers glow (and bloom); the secondary population (ash) is plain.
  float additive = uAdditive * (1.0 - vSecond);
  vec3 col = mix(uColor * mix(1.0, uGlow, additive), uColor2, vSecond);
  float fogFactor = 0.0;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    fogFactor = max(fogFactor, smoothstep(${FAR_FADE_START.toFixed(1)}, ${FAR_FADE_END.toFixed(1)}, vFogDepth));
    col = mix(col, fogColor, fogFactor * (1.0 - additive));
    a *= 1.0 - fogFactor * additive;
  #endif
  gl_FragColor = vec4(col * a, a * (1.0 - additive));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function vec3(values) { return new THREE.Vector3(values[0], values[1], values[2]); }

/**
 * @param {object} palette mapAtmosphere() result; `palette.ambience` picks the kind
 * @param {{graphics?:object, lightUniforms?:object, floorY?:number, reducedMotion?:()=>boolean}} options
 * @returns {{points:THREE.Points, kind:string, count:number, update:(dt:number)=>void, dispose:()=>void}|null}
 */
export function buildMapAmbience(palette = {}, {
  graphics = null, lightUniforms = null, floorY = 15, reducedMotion = () => displaySettings().reducedMotion === true,
} = {}) {
  const config = palette.ambience || {};
  const kind = AMBIENCE_KINDS[config.kind] ? config.kind : 'sparse';
  if (config.kind === 'none') return null;
  const preset = { ...AMBIENCE_KINDS[kind], ...config };
  const tierCount = Math.max(AMBIENCE_MIN_PARTICLES, Number(graphics?.ambientParticles) || 600);
  const count = preset.fixed > 0 ? Math.round(preset.fixed) : Math.max(32, Math.round(tierCount * preset.density));

  const rng = mulberry32(0xA3B1E7 ^ (count * 2654435761));
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = rng();
    positions[i * 3 + 1] = rng();
    positions[i * 3 + 2] = rng();
    seeds[i] = rng();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));
  // The field always surrounds the camera; bounds only exist to satisfy three.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const fallbackLight = lightUniforms ? null : new THREE.Data3DTexture(new Uint8Array([255, 255, 0, 0]), 1, 1, 1);
  if (fallbackLight) fallbackLight.needsUpdate = true;
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uTime: { value: 0 },
    uBox: { value: vec3(preset.box) },
    uVel: { value: vec3(preset.vel) },
    uVel2: { value: vec3(preset.vel2) },
    uMix: { value: preset.mix },
    uWobble: { value: preset.wobble },
    uSize: { value: preset.size },
    uViewH: { value: 800 },
    uAlpha: { value: preset.alpha },
    uIndoor: { value: preset.indoor },
    uSunlit: { value: preset.sunlit },
    uFloor: { value: floorY },
    uBand: { value: preset.band || 0 },
    uNear: { value: preset.near || 1.2 },
    uMaxPx: { value: preset.maxPx || 96 },
    uColor: { value: new THREE.Color(preset.color) },
    uColor2: { value: new THREE.Color(preset.color2) },
    uAdditive: { value: preset.additive },
    uGlow: { value: preset.glow || 1 },
    uStreak: { value: preset.streak || 0 },
    uSoft: { value: preset.soft || 0 },
    voxelLightSize: { value: new THREE.Vector3(1, 1, 1) },
  }]);
  // Shared by reference: the volume binds its texture after the world bakes.
  uniforms.voxelLightMap = lightUniforms?.voxelLightMap || { value: fallbackLight };
  if (lightUniforms?.voxelLightSize) uniforms.voxelLightSize = lightUniforms.voxelLightSize;

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    fog: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  material.name = `ambience-${kind}`;

  const points = new THREE.Points(geometry, material);
  points.name = 'map-ambience';
  points.frustumCulled = false;
  points.renderOrder = 4;
  const viewH = uniforms.uViewH;
  const drawSize = new THREE.Vector2();
  points.onBeforeRender = (renderer) => {
    const target = renderer.getRenderTarget();
    viewH.value = target ? target.height : renderer.getDrawingBufferSize(drawSize).y;
  };

  const time = uniforms.uTime;
  let clock = 0;
  return {
    points,
    kind,
    count,
    /** Advances the drift; reduced motion slows the field to a near standstill. */
    update(dt) {
      if (!(dt > 0)) return;
      clock += dt * (reducedMotion() ? 0.15 : 1);
      if (clock > 20000) clock -= 20000;
      time.value = clock;
    },
    dispose() {
      points.removeFromParent();
      geometry.dispose();
      material.dispose();
      fallbackLight?.dispose();
    },
  };
}
