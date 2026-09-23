// Bounded full-screen chain for the rendered 3D scene. DOM HUD and menus stay
// untouched, while the world receives anti-aliasing, a highlight roll-off, an
// optional bloom mip chain, a per-map grade, detail recovery and condition
// feedback. The scene ALWAYS renders through the target: switching between the
// canvas and the target would change every material's program key (output
// colour space and tone mapping) and recompile the whole scene mid-fight. A
// failed pass falls back to direct rendering until the buffer is resized, so
// shader support can never prevent a match from being visible.

import * as THREE from '../vendor/three.module.js';
import { SMOKE_GLSL, smokeUniforms, updateSmokeUniforms } from './smoke-volume.js';

export const POST_PROCESS_PROFILE = Object.freeze({
  maxPixelRatio: 1.35,
  lowMemoryPixelRatio: 1,
  lowMemoryThresholdGb: 4,
});

/** Neutral grade: the look the arenas were tuned against before per-map grades. */
export const DEFAULT_GRADE = Object.freeze({
  exposure: 1,
  saturation: 1.055,
  contrast: 1,
  // Baked shadows made dark tones common; a strong cool lift would turn every
  // room teal, so shadows only lean faintly blue.
  shadowTint: Object.freeze([-0.003, 0.002, 0.007]),
  highlightTint: Object.freeze([0.014, 0.006, -0.004]),
});

/** Bloom starts above the brightest lit albedo, so only emitters and the sun glow. */
export const BLOOM_THRESHOLD = 1.0;
export const BLOOM_STRENGTH = 0.085;

/**
 * Eye adaptation only ever brightens: open daylight keeps its tuned exposure,
 * while tunnels and rooms lift towards the key over a second, the way eyes
 * adjust when stepping out of the sun.
 */
export const ADAPTATION = Object.freeze({ key: 0.2, maxBoost: 1.75, brightenPerSecond: 1.6, darkenPerSecond: 3.2 });

/**
 * Screen-space ambient occlusion (Ultra): a half-resolution pass over the
 * scene depth, depth-aware blurred, multiplied into the scene colour before
 * the highlight shoulder. The viewmodel's depth range (nearer than `near`)
 * never darkens, and distant pixels fade out before fog would reveal noise.
 */
export const SSAO = Object.freeze({
  samples: 10, radius: 0.6, intensity: 4.2, bias: 0.15, strength: 0.55,
  near: 0.3, fadeStart: 45, fadeEnd: 90,
});

const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// Hue-preserving highlight roll-off: identity below 0.76, so every LDR surface
// keeps its tuned value, then a smooth shoulder that desaturates towards white
// the way over-exposed film does. Shared by the scene and the bloom composite.
const TONE_GLSL = /* glsl */ `
vec3 rollOff(vec3 color) {
  const float start = 0.76;
  const float desaturation = 0.15;
  color = max(color, vec3(0.0));
  float peak = max(color.r, max(color.g, color.b));
  if (peak < start) return color;
  float d = 1.0 - start;
  float newPeak = 1.0 - d * d / (peak + d - start);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(color, vec3(newPeak), g);
}`;

const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D sceneTexture;
uniform sampler2D bloomTexture;
uniform float bloomStrength;
uniform vec2 resolution;
uniform float time;
uniform float panic;
uniform float burning;
uniform float pain;
uniform float scopeActive;
uniform float motion;
uniform float grading;
uniform float sharpen;
uniform float exposure;
uniform sampler2D adaptedExposure;
uniform float gradeSaturation;
uniform float gradeContrast;
uniform vec3 shadowTint;
uniform vec3 highlightTint;
uniform sampler2D ssaoTexture;
uniform float ssaoStrength;
${SMOKE_GLSL}
${TONE_GLSL}

varying vec2 vUv;

float hash21(vec2 point) {
  return fract(sin(dot(point, vec2(12.9898, 78.233))) * 43758.5453);
}

float sceneExposure() {
#ifdef USE_ADAPTATION
  return exposure * texture2D(adaptedExposure, vec2(0.5)).r;
#else
  return exposure;
#endif
}

vec3 sceneRaw(vec2 uv) {
  vec3 c = texture2D(sceneTexture, uv).rgb;
#ifdef USE_SSAO
  // Occlusion is an ambient term: sunlit texels keep more of their value
  // than the shade, so creases deepen without greying lit walls.
  float lit = smoothstep(0.35, 1.1, dot(c, vec3(0.2126, 0.7152, 0.0722)));
  c *= mix(1.0, texture2D(ssaoTexture, uv).r, ssaoStrength * (1.0 - 0.45 * lit));
#endif
  return c;
}

vec3 sceneAt(vec2 uv) {
  return rollOff(sceneRaw(uv) * sceneExposure());
}

#ifdef USE_FXAA
// FXAA 3.11 style edge search on the tone-mapped image, for tiers without MSAA.
float lumaAt(vec2 uv) { return dot(sqrt(sceneAt(uv)), vec3(0.299, 0.587, 0.114)); }
vec3 fxaa(vec2 uv, vec2 texel) {
  float lM = lumaAt(uv);
  float lNW = lumaAt(uv + vec2(-1.0, -1.0) * texel);
  float lNE = lumaAt(uv + vec2(1.0, -1.0) * texel);
  float lSW = lumaAt(uv + vec2(-1.0, 1.0) * texel);
  float lSE = lumaAt(uv + vec2(1.0, 1.0) * texel);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  if (lMax - lMin < max(0.0312, lMax * 0.125)) return sceneAt(uv);
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
  float scale = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * scale, vec2(-8.0), vec2(8.0)) * texel;
  vec3 a = 0.5 * (sceneAt(uv + dir * (1.0 / 3.0 - 0.5)) + sceneAt(uv + dir * (2.0 / 3.0 - 0.5)));
  vec3 b = a * 0.5 + 0.25 * (sceneAt(uv - dir * 0.5) + sceneAt(uv + dir * 0.5));
  float lB = dot(sqrt(b), vec3(0.299, 0.587, 0.114));
  return (lB < lMin || lB > lMax) ? a : b;
}
#endif

float fireNoise(vec2 p) {
  vec2 cell = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(cell), hash21(cell + vec2(1.0, 0.0)), f.x),
    mix(hash21(cell + vec2(0.0, 1.0)), hash21(cell + vec2(1.0)), f.x), f.y);
}

// A tapered, rising field with broad tongues and smaller holes. Pixel snapping
// makes the silhouette belong to the voxel world without adding sprite objects.
float fireBand(vec2 p, float t) {
  float bend = sin(p.y * 8.0 - t * 1.7) * p.y * 0.7;
  float broad = fireNoise(vec2(p.x * 8.0 + bend, p.y * 3.0 - t * 1.6));
  float detail = fireNoise(vec2(p.x * 21.0 - bend, p.y * 9.0 - t * 2.7));
  return clamp((0.24 - p.y * 0.85 + broad * 0.82 + detail * 0.38) * 1.35, 0.0, 1.0);
}

void main() {
  vec2 texel = 1.0 / max(resolution, vec2(1.0));
  // Panic/pain stay peripheral. Burning adds a separate visibility penalty.
  vec2 vignetteUv = (vUv - 0.5) * 2.0;
  vignetteUv.x *= min(resolution.x / max(resolution.y, 1.0), 1.75) * 0.72;
  float edge = smoothstep(0.55, 1.34, length(vignetteUv));

#ifdef USE_FXAA
  vec3 base = fxaa(vUv, texel);
#else
  vec3 base = sceneAt(vUv);
#endif
#ifdef USE_BLOOM
  // Bloom joins before the shoulder so bright cores roll off instead of clipping.
  vec3 glow = texture2D(bloomTexture, vUv).rgb * bloomStrength * sceneExposure();
  vec3 center = rollOff(sceneRaw(vUv) * sceneExposure() + glow);
#ifdef USE_FXAA
  center = base + (center - sceneAt(vUv));
#endif
#else
  vec3 center = base;
#endif

  vec3 crossBlur = (
    sceneAt(vUv + vec2(texel.x, 0.0)) +
    sceneAt(vUv - vec2(texel.x, 0.0)) +
    sceneAt(vUv + vec2(0.0, texel.y)) +
    sceneAt(vUv - vec2(0.0, texel.y))
  ) * 0.25;
  vec3 color = clamp(center + (base - crossBlur) * sharpen, 0.0, 1.0);

  float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luminance), color, gradeSaturation - edge * (pain * 0.08 + panic * 0.10));
  // The grade runs on linear light, where voxel-occluded darks sit at 0.002-0.02.
  // Every term therefore scales with the value itself: absolute offsets there
  // would clip grout to black or paint it with the tint colour.
  // Contrast pivots on mid grey in a perceptual (sqrt) space; its toe fades the
  // curve out towards black, so no contrast setting can crush or lift black.
  vec3 perceptual = sqrt(max(color, vec3(0.0)));
  const float gradePivot = 0.4242641; // sqrt(0.18)
  perceptual += (perceptual - gradePivot) * (gradeContrast - 1.0) * min(perceptual / gradePivot, vec3(1.0));
  color = min(perceptual * perceptual, vec3(1.0));
  luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));

  // Tints were tuned as offsets on neutral mids and highlights; dividing by the
  // local luminance keeps exactly that look above 0.1 and turns it into a gain
  // below, so deep shade keeps its hue instead of drifting to the tint colour.
  float shadow = 1.0 - smoothstep(0.08, 0.58, luminance);
  float highlight = smoothstep(0.52, 0.96, luminance);
  vec3 tintGain = (shadow * shadowTint + highlight * highlightTint) / max(luminance, 0.1);
  color *= max(vec3(1.0) + tintGain, vec3(0.0));

  float breathingPulse = 0.65 + sin(time * (2.6 + panic * 3.0)) * 0.35 * motion;
  // Tunnel vision: panic drags the darkness inward and deepens it on the breath
  // cadence, while the center stays clear for aimed shots.
  float panicEdge = min(edge * (1.0 + panic * 0.45), 1.0);
  float vignette = mix(0.095, 0.022, scopeActive) + panic * breathingPulse * 0.30;
  color *= 1.0 - panicEdge * vignette;
  // Injury leaves only a faint static tint; the HUD owns the brief directional sting.
  color += vec3(0.035, -0.006, -0.008) * edge * pain;

  float grainFrame = floor(time * 30.0 * motion);
  float grain = hash21(gl_FragCoord.xy + grainFrame) - 0.5;
  color += grain * 0.005;

  color = mix(center, color, grading);
  // Gameplay visibility survives disabling decorative grading, just like smoke.
  if (burning > 0.0) {
    float flameTime = time * motion;
    float border = min(vUv.x, 1.0 - vUv.x);
    float periphery = max(1.0 - smoothstep(0.08, 0.34, border),
      1.0 - smoothstep(0.12, 0.46, vUv.y));
    vec2 heat = vec2(sin(vUv.y * 37.0 - flameTime * 3.0),
      sin(vUv.x * 31.0 + flameTime * 2.1)) * 0.004 * periphery * burning * motion;
    vec2 blur = texel * (1.5 + periphery * 6.0) * burning;
    vec2 sampleUv = clamp(vUv + heat, vec2(0.0), vec2(1.0));
    vec3 haze = (sceneAt(sampleUv + vec2(blur.x, 0.0))
      + sceneAt(sampleUv - vec2(blur.x, 0.0))
      + sceneAt(sampleUv + vec2(0.0, blur.y))
      + sceneAt(sampleUv - vec2(0.0, blur.y))) * 0.25;
    color = mix(color, haze, burning * (0.12 + periphery * 0.55));
    color = mix(color, vec3(0.72, 0.17, 0.025), burning * (0.09 + periphery * 0.20));

    vec2 grid = max(vec2(96.0), resolution / 5.0);
    vec2 pixelUv = (floor(vUv * grid) + 0.5) / grid;
    float bottom = fireBand(vec2(pixelUv.x * 1.5, pixelUv.y / 0.29), flameTime);
    float left = fireBand(vec2(pixelUv.y + 4.0, pixelUv.x / 0.19), flameTime + 3.0);
    float right = fireBand(vec2(pixelUv.y + 9.0, (1.0 - pixelUv.x) / 0.19), flameTime + 7.0);
    float fire = max(bottom, max(left, right));
    vec3 fireColor = mix(vec3(0.38, 0.014, 0.002), vec3(1.0, 0.12, 0.003), smoothstep(0.08, 0.58, fire));
    fireColor = mix(fireColor, vec3(1.0, 0.66, 0.035), smoothstep(0.72, 1.0, fire));
    color = mix(color, fireColor, smoothstep(0.0, 0.32, fire) * burning * 0.87);

    vec2 emberUv = vec2(vUv.x, vUv.y - flameTime * 0.13) * vec2(42.0, 24.0);
    vec2 emberCell = floor(emberUv), emberPoint = abs(fract(emberUv) - 0.5);
    float ember = step(0.974, hash21(emberCell)) * (1.0 - smoothstep(0.05, 0.16, max(emberPoint.x, emberPoint.y)));
    color = mix(color, vec3(1.0, 0.55, 0.025), ember * periphery * burning * 0.85);
  }
  color = smokeColor(color, vUv, time * motion);
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
  #include <colorspace_fragment>
}`;

// Bloom: a soft-knee bright pass into half resolution, dual-filter downsamples,
// then additive tent upsamples back into each larger level.
const BLOOM_PREFILTER = /* glsl */ `
uniform sampler2D source;
uniform vec2 texel;
uniform float threshold;
varying vec2 vUv;
void main() {
  vec3 c = (texture2D(source, vUv + texel * vec2(-1.0, -1.0)).rgb
    + texture2D(source, vUv + texel * vec2(1.0, -1.0)).rgb
    + texture2D(source, vUv + texel * vec2(-1.0, 1.0)).rgb
    + texture2D(source, vUv + texel * vec2(1.0, 1.0)).rgb) * 0.25;
  float brightness = max(c.r, max(c.g, c.b));
  float knee = threshold * 0.5;
  float soft = clamp(brightness - threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  float contribution = max(soft, brightness - threshold) / max(brightness, 1e-4);
  // Clamp fireflies: one hot texel must not flash the whole screen.
  gl_FragColor = vec4(min(c * contribution, vec3(24.0)), 1.0);
}`;

const BLOOM_DOWN = /* glsl */ `
uniform sampler2D source;
uniform vec2 texel;
varying vec2 vUv;
void main() {
  vec3 sum = texture2D(source, vUv).rgb * 4.0;
  sum += texture2D(source, vUv + texel * vec2(-1.0, -1.0)).rgb;
  sum += texture2D(source, vUv + texel * vec2(1.0, -1.0)).rgb;
  sum += texture2D(source, vUv + texel * vec2(-1.0, 1.0)).rgb;
  sum += texture2D(source, vUv + texel * vec2(1.0, 1.0)).rgb;
  gl_FragColor = vec4(sum / 8.0, 1.0);
}`;

const BLOOM_UP = /* glsl */ `
uniform sampler2D source;
uniform vec2 texel;
uniform float weight;
varying vec2 vUv;
void main() {
  vec3 sum = texture2D(source, vUv + texel * vec2(-2.0, 0.0)).rgb;
  sum += texture2D(source, vUv + texel * vec2(2.0, 0.0)).rgb;
  sum += texture2D(source, vUv + texel * vec2(0.0, -2.0)).rgb;
  sum += texture2D(source, vUv + texel * vec2(0.0, 2.0)).rgb;
  sum += texture2D(source, vUv + texel * vec2(-1.0, -1.0)).rgb * 2.0;
  sum += texture2D(source, vUv + texel * vec2(1.0, -1.0)).rgb * 2.0;
  sum += texture2D(source, vUv + texel * vec2(-1.0, 1.0)).rgb * 2.0;
  sum += texture2D(source, vUv + texel * vec2(1.0, 1.0)).rgb * 2.0;
  gl_FragColor = vec4(sum / 12.0 * weight, 1.0);
}`;

// Scalable ambient obscurance from depth alone. View positions come from the
// inverse projection; the normal from the flatter of each neighbour pair, so
// silhouettes do not smear. A golden-angle spiral, rotated per pixel by
// interleaved gradient noise, samples a world-space radius (shrunk up close).
const SSAO_PASS = /* glsl */ `
uniform sampler2D sceneDepth;
uniform mat4 cameraProjection;
uniform mat4 cameraProjectionInverse;
uniform vec2 depthTexel;
uniform vec2 aoResolution;
uniform float aoRadius;
uniform float aoIntensity;
uniform float aoBias;
varying vec2 vUv;

vec3 viewAt(vec2 uv, float depth) {
  vec4 p = cameraProjectionInverse * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}
vec3 viewAt(vec2 uv) { return viewAt(uv, texture2D(sceneDepth, uv).x); }

void main() {
  // A half-resolution centre falls exactly between two depth texels; snap to
  // one so the centre and its neighbours are distinct, consistent texels.
  vec2 uv = (floor(vUv / depthTexel - 0.25) + 0.5) * depthTexel;
  float depth = texture2D(sceneDepth, uv).x;
  vec3 p = viewAt(uv, depth);
  float dist = -p.z;
  if (depth >= 0.999999 || dist < SSAO_NEAR) { gl_FragColor = vec4(1.0); return; }
  vec3 r = viewAt(uv + vec2(depthTexel.x, 0.0)) - p;
  vec3 l = p - viewAt(uv - vec2(depthTexel.x, 0.0));
  vec3 u = viewAt(uv + vec2(0.0, depthTexel.y)) - p;
  vec3 d = p - viewAt(uv - vec2(0.0, depthTexel.y));
  vec3 n = normalize(cross(abs(r.z) < abs(l.z) ? r : l, abs(u.z) < abs(d.z) ? u : d));
  float radius = min(aoRadius, dist * 0.35);
  float pixels = min(radius * cameraProjection[1][1] * 0.5 * aoResolution.y / dist, 64.0);
  if (pixels < 1.0) { gl_FragColor = vec4(1.0); return; }
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float angle = noise * 6.2831853;
  float r2 = radius * radius;
  float occlusion = 0.0;
  for (int i = 0; i < SSAO_SAMPLES; i++) {
    float t = (float(i) + 0.5 + noise * 0.5) / float(SSAO_SAMPLES);
    float a = angle + float(i) * 2.3999632;
    vec3 v = viewAt(uv + vec2(cos(a), sin(a)) * (pixels * t) / aoResolution) - p;
    float vv = dot(v, v);
    float falloff = max(r2 - vv, 0.0) / r2;
    occlusion += falloff * max(dot(v, n) * inversesqrt(vv + 1e-6) - aoBias, 0.0);
  }
  float ao = 1.0 - clamp(aoIntensity * occlusion / float(SSAO_SAMPLES), 0.0, 1.0);
  ao = mix(ao, 1.0, smoothstep(SSAO_FADE_START, SSAO_FADE_END, dist));
  ao = mix(1.0, ao, smoothstep(SSAO_NEAR, SSAO_NEAR + 0.3, dist));
  gl_FragColor = vec4(ao, 0.0, 0.0, 1.0);
}`;

// 4x4 depth-aware blur that removes the per-pixel rotation noise without
// letting occlusion bleed across silhouettes.
const SSAO_BLUR = /* glsl */ `
uniform sampler2D aoTexture;
uniform sampler2D sceneDepth;
uniform vec2 aoTexel;
uniform float cameraNear;
uniform float cameraFar;
varying vec2 vUv;
float linearDepth(vec2 uv) {
  float z = texture2D(sceneDepth, uv).x * 2.0 - 1.0;
  return 2.0 * cameraNear * cameraFar / (cameraFar + cameraNear - z * (cameraFar - cameraNear));
}
void main() {
  float center = linearDepth(vUv);
  float tolerance = 0.04 * center + 0.05;
  float sum = 0.0;
  float weight = 0.0;
  for (int x = 0; x < 4; x++) {
    for (int y = 0; y < 4; y++) {
      vec2 uv = vUv + (vec2(float(x), float(y)) - 1.5) * aoTexel;
      float w = max(0.0, 1.0 - abs(linearDepth(uv) - center) / tolerance);
      sum += texture2D(aoTexture, uv).r * w;
      weight += w;
    }
  }
  gl_FragColor = vec4(weight > 1e-3 ? sum / weight : texture2D(aoTexture, vUv).r, 0.0, 0.0, 1.0);
}`;

// Center-weighted log luminance; the mip chain of this target averages it.
const LUMINANCE_PASS = /* glsl */ `
uniform sampler2D source;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(source, vUv).rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec2 d = (vUv - 0.5) * vec2(1.6, 2.0);
  float weight = 0.25 + exp(-dot(d, d) * 2.5);
  gl_FragColor = vec4(log2(lum + 1e-3) * weight, weight, 0.0, 1.0);
}`;

const ADAPT_PASS = /* glsl */ `
uniform sampler2D luminanceMip;
uniform sampler2D previous;
uniform float lastLevel;
uniform float key;
uniform float maxBoost;
uniform float brighten;
uniform float darken;
uniform float snap;
varying vec2 vUv;
void main() {
  vec2 avg = textureLod(luminanceMip, vec2(0.5), lastLevel).rg;
  float lum = exp2(avg.r / max(avg.g, 1e-4));
  float target = clamp(key / max(lum, 1e-4), 1.0, maxBoost);
  float current = texture2D(previous, vec2(0.5)).r;
  float rate = target > current ? brighten : darken;
  float adapted = snap > 0.5 ? target : mix(current, target, rate);
  gl_FragColor = vec4(adapted, 0.0, 0.0, 1.0);
}`;

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function normalizePostProcessState(state = {}) {
  return Object.freeze({
    panic: clamp01(state.panic),
    burning: clamp01(state.burning),
    pain: clamp01(state.pain),
    scopeActive: state.scopeActive ? 1 : 0,
    motion: state.reducedMotion ? 0 : 1,
    time: Math.max(0, Number(state.time) || 0),
  });
}

export function postProcessBufferSize(width, height, pixelRatio, maxPixelRatio) {
  const safeWidth = Math.max(1, Math.floor(Number(width) || 1));
  const safeHeight = Math.max(1, Math.floor(Number(height) || 1));
  const ratio = Math.max(0.5, Math.min(
    Number(pixelRatio) || 1,
    Number(maxPixelRatio) || POST_PROCESS_PROFILE.maxPixelRatio,
  ));
  return Object.freeze({
    width: Math.max(1, Math.floor(safeWidth * ratio)),
    height: Math.max(1, Math.floor(safeHeight * ratio)),
    pixelRatio: ratio,
  });
}

export function recommendedPostProcessPixelRatio(deviceMemory) {
  return Number.isFinite(deviceMemory) && deviceMemory <= POST_PROCESS_PROFILE.lowMemoryThresholdGb
    ? POST_PROCESS_PROFILE.lowMemoryPixelRatio
    : POST_PROCESS_PROFILE.maxPixelRatio;
}

/** Merge a palette grade over the neutral one; missing fields keep the defaults. */
export function resolveGrade(grade = {}) {
  const tint = (value, fallback) => (Array.isArray(value) && value.length === 3
    && value.every(Number.isFinite) ? value : fallback);
  const scalar = (value, fallback, lo, hi) => (Number.isFinite(value)
    ? Math.max(lo, Math.min(hi, value)) : fallback);
  return Object.freeze({
    exposure: scalar(grade.exposure, DEFAULT_GRADE.exposure, 0.5, 2),
    saturation: scalar(grade.saturation, DEFAULT_GRADE.saturation, 0.5, 1.5),
    contrast: scalar(grade.contrast, DEFAULT_GRADE.contrast, 0.7, 1.4),
    shadowTint: tint(grade.shadowTint, DEFAULT_GRADE.shadowTint),
    highlightTint: tint(grade.highlightTint, DEFAULT_GRADE.highlightTint),
  });
}

function fullScreenMaterial(name, fragmentShader, uniforms, blending = THREE.NoBlending) {
  return new THREE.ShaderMaterial({
    name,
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    blending,
    transparent: blending !== THREE.NoBlending,
  });
}

export class CombatPostProcess {
  /**
   * @param renderer WebGLRenderer-compatible adapter
   * @param {{enabled?:boolean,maxPixelRatio?:number,reducedMotion?:boolean,
   *   msaa?:number,hdr?:boolean,bloomLevels?:number,fxaa?:boolean,ssao?:boolean}} options
   *   msaa/hdr/bloom/fxaa/ssao fix buffer formats and program defines for the
   *   lifetime of this chain; a tier change builds a new chain at map load.
   */
  constructor(renderer, {
    enabled = true,
    maxPixelRatio = POST_PROCESS_PROFILE.maxPixelRatio,
    reducedMotion = false,
    msaa = 0,
    hdr = false,
    bloomLevels = 0,
    fxaa = false,
    ssao = false,
  } = {}) {
    if (!renderer || typeof renderer.render !== 'function' ||
        typeof renderer.setRenderTarget !== 'function') {
      throw new TypeError('CombatPostProcess requires a WebGLRenderer-compatible adapter');
    }
    this.renderer = renderer;
    this._rendererInfoAutoReset = renderer.info?.autoReset;
    if (renderer.info) renderer.info.autoReset = false;
    this.enabled = !!enabled;
    this.failed = false;
    this.maxPixelRatio = maxPixelRatio;
    this.reducedMotion = !!reducedMotion;
    this.msaa = Math.max(0, Math.floor(Number(msaa) || 0));
    this.hdr = !!hdr;
    this.bloomLevels = this.hdr ? Math.max(0, Math.min(6, Math.floor(Number(bloomLevels) || 0))) : 0;
    this.fxaa = !!fxaa && this.msaa === 0;
    this.ssao = !!ssao;
    this.frames = 0;
    this.fallbacks = 0;
    this.lastError = '';
    // A thrown pass latches direct rendering (`failed`) until the buffer is
    // resized; `enabled` alone cannot, because smoke still needs the pass
    // without grading. A shader compile error flagged from outside sets
    // `failed` directly and stays latched for good.
    this._retryOnResize = false;
    this._disposed = false;
    this._size = postProcessBufferSize(1, 1, 1, maxPixelRatio);

    this.target = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      samples: this.msaa,
      type: this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
    });
    this.target.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.target.texture.name = 'combat-post-process';
    // An 8-bit target stores sRGB-encoded texels (SRGB8_ALPHA8): the hardware
    // encodes on write and decodes on read, so dark gradients keep their steps.
    // Half floats have the precision to stay linear.
    this.target.texture.colorSpace = this.hdr ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
    this.target.texture.generateMipmaps = false;

    this.bloomTargets = [];
    for (let level = 0; level < this.bloomLevels; level++) {
      const target = new THREE.WebGLRenderTarget(1, 1, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        type: THREE.HalfFloatType,
      });
      target.texture.name = `combat-bloom-${level}`;
      target.texture.generateMipmaps = false;
      this.bloomTargets.push(target);
    }

    const grade = resolveGrade();
    this.uniforms = {
      ...smokeUniforms(this.target.depthTexture),
      grading: { value: 1 },
      sceneTexture: { value: this.target.texture },
      bloomTexture: { value: this.bloomTargets[0]?.texture || null },
      bloomStrength: { value: BLOOM_STRENGTH },
      resolution: { value: new THREE.Vector2(1, 1) },
      time: { value: 0 },
      panic: { value: 0 },
      burning: { value: 0 },
      pain: { value: 0 },
      scopeActive: { value: 0 },
      motion: { value: reducedMotion ? 0 : 1 },
      sharpen: { value: this.msaa > 0 || this.fxaa ? 0.05 : 0.1 },
      adaptedExposure: { value: null },
      exposure: { value: grade.exposure },
      gradeSaturation: { value: grade.saturation },
      gradeContrast: { value: grade.contrast },
      shadowTint: { value: new THREE.Vector3(...grade.shadowTint) },
      highlightTint: { value: new THREE.Vector3(...grade.highlightTint) },
      ssaoTexture: { value: null },
      ssaoStrength: { value: SSAO.strength },
    };
    this.material = fullScreenMaterial('combat-post-process', FRAGMENT_SHADER, this.uniforms);
    this.occlusion = this.ssao ? this._createSsao() : null;
    if (this.occlusion) {
      this.material.defines.USE_SSAO = '';
      this.uniforms.ssaoTexture.value = this.occlusion.blurred.texture;
    }
    if (this.bloomLevels) this.material.defines.USE_BLOOM = '';
    if (this.fxaa) this.material.defines.USE_FXAA = '';

    this.bloomMaterials = this.bloomLevels ? {
      prefilter: fullScreenMaterial('combat-bloom-prefilter', BLOOM_PREFILTER, {
        source: { value: this.target.texture },
        texel: { value: new THREE.Vector2(1, 1) },
        threshold: { value: BLOOM_THRESHOLD },
      }),
      down: fullScreenMaterial('combat-bloom-down', BLOOM_DOWN, {
        source: { value: null },
        texel: { value: new THREE.Vector2(1, 1) },
      }),
      up: fullScreenMaterial('combat-bloom-up', BLOOM_UP, {
        source: { value: null },
        texel: { value: new THREE.Vector2(1, 1) },
        weight: { value: 1 },
      }, THREE.AdditiveBlending),
    } : null;

    // Eye adaptation needs float luminance; LDR tiers keep a fixed exposure.
    this.adaptation = this.hdr ? this._createAdaptation() : null;
    if (this.adaptation) {
      this.material.defines.USE_ADAPTATION = '';
      this.uniforms.adaptedExposure.value = this.adaptation.targets[0].texture;
    }

    this.screen = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.screen.name = 'combat-post-process-screen';
    this.screen.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.screen);
    this.camera = new THREE.Camera();
  }

  _createSsao() {
    const target = (name) => {
      const t = new THREE.WebGLRenderTarget(1, 1, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
      });
      t.texture.name = name;
      t.texture.generateMipmaps = false;
      return t;
    };
    const raw = target('combat-ssao');
    const blurred = target('combat-ssao-blur');
    const pass = fullScreenMaterial('combat-ssao', SSAO_PASS, {
      sceneDepth: { value: this.target.depthTexture },
      cameraProjection: { value: new THREE.Matrix4() },
      cameraProjectionInverse: { value: new THREE.Matrix4() },
      depthTexel: { value: new THREE.Vector2(1, 1) },
      aoResolution: { value: new THREE.Vector2(1, 1) },
      aoRadius: { value: SSAO.radius },
      aoIntensity: { value: SSAO.intensity },
      aoBias: { value: SSAO.bias },
    });
    pass.defines = {
      SSAO_SAMPLES: SSAO.samples,
      SSAO_NEAR: SSAO.near.toFixed(3),
      SSAO_FADE_START: SSAO.fadeStart.toFixed(1),
      SSAO_FADE_END: SSAO.fadeEnd.toFixed(1),
    };
    const blur = fullScreenMaterial('combat-ssao-blur', SSAO_BLUR, {
      aoTexture: { value: raw.texture },
      sceneDepth: { value: this.target.depthTexture },
      aoTexel: { value: new THREE.Vector2(1, 1) },
      cameraNear: { value: 0.05 },
      cameraFar: { value: 400 },
    });
    return { raw, blurred, pass, blur };
  }

  _renderSsao(camera) {
    const { raw, pass, blur, blurred } = this.occlusion;
    const u = pass.uniforms;
    u.cameraProjection.value.copy(camera.projectionMatrix);
    u.cameraProjectionInverse.value.copy(camera.projectionMatrixInverse);
    blur.uniforms.cameraNear.value = Number.isFinite(camera.near) ? camera.near : 0.05;
    blur.uniforms.cameraFar.value = Number.isFinite(camera.far) ? camera.far : 400;
    this._pass(pass, raw);
    this._pass(blur, blurred);
    this.screen.material = this.material;
  }

  _createAdaptation() {
    const luminance = new THREE.WebGLRenderTarget(128, 64, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: true,
    });
    luminance.texture.name = 'combat-luminance';
    const targets = [0, 1].map((index) => {
      const target = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: false,
        stencilBuffer: false,
      });
      target.texture.name = `combat-exposure-${index}`;
      return target;
    });
    const lumMaterial = fullScreenMaterial('combat-luminance', LUMINANCE_PASS, {
      source: { value: this.target.texture },
    });
    const adaptMaterial = fullScreenMaterial('combat-adapt', ADAPT_PASS, {
      luminanceMip: { value: luminance.texture },
      previous: { value: targets[1].texture },
      lastLevel: { value: Math.log2(128) },
      key: { value: ADAPTATION.key },
      maxBoost: { value: ADAPTATION.maxBoost },
      brighten: { value: 0 },
      darken: { value: 0 },
      snap: { value: 1 },
    });
    return { luminance, targets, lumMaterial, adaptMaterial, current: 0, lastTime: null };
  }

  _renderAdaptation(time, snap) {
    const a = this.adaptation;
    const dt = a.lastTime === null ? 0 : Math.max(0, Math.min(0.25, time - a.lastTime));
    a.lastTime = time;
    this._pass(a.lumMaterial, a.luminance);
    const next = 1 - a.current;
    const u = a.adaptMaterial.uniforms;
    u.previous.value = a.targets[a.current].texture;
    u.brighten.value = 1 - Math.exp(-dt * ADAPTATION.brightenPerSecond);
    u.darken.value = 1 - Math.exp(-dt * ADAPTATION.darkenPerSecond);
    u.snap.value = snap || this.frames === 0 ? 1 : 0;
    this._pass(a.adaptMaterial, a.targets[next]);
    a.current = next;
    this.uniforms.adaptedExposure.value = a.targets[next].texture;
  }

  /** The ratio the canvas should use: composite and scene share one grid. */
  get pixelRatio() { return this._size.pixelRatio; }

  setGrade(grade) {
    const resolved = resolveGrade(grade || {});
    this.uniforms.exposure.value = resolved.exposure;
    this.uniforms.gradeSaturation.value = resolved.saturation;
    this.uniforms.gradeContrast.value = resolved.contrast;
    this.uniforms.shadowTint.value.set(...resolved.shadowTint);
    this.uniforms.highlightTint.value.set(...resolved.highlightTint);
    return resolved;
  }

  setSize(width, height, pixelRatio = 1) {
    if (this._disposed) return this._size;
    const next = postProcessBufferSize(width, height, pixelRatio, this.maxPixelRatio);
    if (next.width !== this._size.width || next.height !== this._size.height) {
      this.target.setSize(next.width, next.height);
      this.uniforms.resolution.value.set(next.width, next.height);
      if (this.occlusion) {
        const o = this.occlusion;
        const hw = Math.max(1, next.width >> 1), hh = Math.max(1, next.height >> 1);
        o.raw.setSize(hw, hh);
        o.blurred.setSize(hw, hh);
        o.pass.uniforms.depthTexel.value.set(1 / next.width, 1 / next.height);
        o.pass.uniforms.aoResolution.value.set(hw, hh);
        o.blur.uniforms.aoTexel.value.set(1 / hw, 1 / hh);
      }
      let w = next.width, h = next.height;
      for (const target of this.bloomTargets) {
        w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
        target.setSize(w, h);
      }
      if (this._retryOnResize) {
        this.failed = false;
        this._retryOnResize = false;
      }
    }
    this._size = next;
    return next;
  }

  _pass(material, target) {
    this.screen.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Every full-screen material this chain draws, each with the target it
   * draws into (the composite last, onto the canvas: null). The shader
   * warm-up (shader-warmup.js) compiles exactly these, so a new pass is
   * warmed as soon as it is listed here. Boot-time only (allocates).
   */
  warmupPasses() {
    const passes = [];
    if (this.occlusion) {
      passes.push({ material: this.occlusion.pass, target: this.occlusion.raw },
        { material: this.occlusion.blur, target: this.occlusion.blurred });
    }
    if (this.adaptation) {
      const a = this.adaptation;
      passes.push({ material: a.lumMaterial, target: a.luminance }, { material: a.adaptMaterial, target: a.targets[0] });
    }
    if (this.bloomMaterials) {
      const levels = this.bloomTargets;
      passes.push({ material: this.bloomMaterials.prefilter, target: levels[0] },
        { material: this.bloomMaterials.down, target: levels[1] || levels[0] },
        { material: this.bloomMaterials.up, target: levels[0] });
    }
    passes.push({ material: this.material, target: null });
    return passes;
  }

  _renderBloom() {
    const { prefilter, down, up } = this.bloomMaterials;
    const levels = this.bloomTargets;
    prefilter.uniforms.texel.value.set(1 / this._size.width, 1 / this._size.height);
    this._pass(prefilter, levels[0]);
    for (let i = 1; i < levels.length; i++) {
      const source = levels[i - 1];
      down.uniforms.source.value = source.texture;
      down.uniforms.texel.value.set(1 / source.width, 1 / source.height);
      this._pass(down, levels[i]);
    }
    for (let i = levels.length - 1; i > 0; i--) {
      const source = levels[i];
      up.uniforms.source.value = source.texture;
      up.uniforms.texel.value.set(0.5 / source.width, 0.5 / source.height);
      // Wider levels carry less weight, so the halo stays a glow, not a haze.
      up.uniforms.weight.value = 0.9;
      const autoClear = this.renderer.autoClear;
      this.renderer.autoClear = false;
      this._pass(up, levels[i - 1]);
      this.renderer.autoClear = autoClear;
    }
    this.screen.material = this.material;
  }

  render(scene, camera, state = {}) {
    if (this._disposed) return false;
    this.renderer.info?.reset?.();
    if (this.failed) {
      this.renderer.render(scene, camera);
      return false;
    }
    updateSmokeUniforms(this.uniforms, state.smokeFields, state.smokeNow, camera);

    // Keep the hot path allocation-free; normalizePostProcessState() remains the
    // public pure helper for contracts and non-frame callers.
    this.uniforms.grading.value = this.enabled ? 1 : 0;
    this.uniforms.time.value = Math.max(0, Number(state.time) || 0);
    this.uniforms.panic.value = clamp01(state.panic);
    this.uniforms.burning.value = clamp01(state.burning);
    this.uniforms.pain.value = clamp01(state.pain);
    this.uniforms.scopeActive.value = state.scopeActive ? 1 : 0;
    this.uniforms.motion.value = this.reducedMotion ? 0 : 1;

    try {
      this.renderer.setRenderTarget(this.target);
      this.renderer.render(scene, camera);
      if (this.occlusion) this._renderSsao(camera);
      if (this.adaptation) this._renderAdaptation(this.uniforms.time.value, state.adaptInstant);
      // The decorative glow follows the grade toggle; condition feedback does not.
      if (this.bloomMaterials) {
        this.uniforms.bloomStrength.value = this.enabled ? BLOOM_STRENGTH : 0;
        if (this.enabled) this._renderBloom();
      }
      this.screen.material = this.material;
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      this.frames++;
      return true;
    } catch (error) {
      this.renderer.setRenderTarget(null);
      this.screen.material = this.material;
      this.enabled = false;
      this.failed = true;
      this._retryOnResize = true;
      this.fallbacks++;
      this.lastError = String(error?.message || error || 'shader render failed');
      this.renderer.render(scene, camera);
      return false;
    }
  }

  get stats() {
    return Object.freeze({
      enabled: this.enabled,
      failed: this.failed,
      frames: this.frames,
      fallbacks: this.fallbacks,
      bufferWidth: this._size.width,
      bufferHeight: this._size.height,
      pixelRatio: this._size.pixelRatio,
      msaa: this.msaa,
      hdr: this.hdr,
      bloomLevels: this.bloomLevels,
      fxaa: this.fxaa,
      ssao: !!this.occlusion,
      adaptation: !!this.adaptation,
      lastError: this.lastError,
    });
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.scene.remove(this.screen);
    this.screen.geometry.dispose();
    this.material.dispose();
    if (this.bloomMaterials) for (const material of Object.values(this.bloomMaterials)) material.dispose();
    for (const target of this.bloomTargets) target.dispose();
    if (this.occlusion) {
      for (const key of ['raw', 'blurred', 'pass', 'blur']) this.occlusion[key].dispose();
    }
    if (this.adaptation) {
      this.adaptation.luminance.dispose();
      for (const target of this.adaptation.targets) target.dispose();
      this.adaptation.lumMaterial.dispose();
      this.adaptation.adaptMaterial.dispose();
    }
    this.target.dispose();
    this.scene.clear();
    if (this.renderer?.info && this._rendererInfoAutoReset !== undefined) {
      this.renderer.info.autoReset = this._rendererInfoAutoReset;
    }
    this.renderer = null;
  }
}
