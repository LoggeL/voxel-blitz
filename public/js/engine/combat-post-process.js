// One bounded full-screen pass for the rendered 3D scene. DOM HUD and menus stay
// untouched, while the world receives a restrained grade, detail recovery and
// condition feedback. A failed pass disables itself and falls back to direct
// rendering, so shader support can never prevent a match from being visible.

import * as THREE from '../vendor/three.module.js';
import { SMOKE_GLSL, smokeUniforms, updateSmokeUniforms } from './smoke-volume.js';

export const POST_PROCESS_PROFILE = Object.freeze({
  maxPixelRatio: 1.35,
  lowMemoryPixelRatio: 1,
  lowMemoryThresholdGb: 4,
});

const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D sceneTexture;
uniform vec2 resolution;
uniform float time;
uniform float panic;
uniform float burning;
uniform float pain;
uniform float scopeActive;
uniform float motion;
uniform float grading;
${SMOKE_GLSL}

varying vec2 vUv;

float hash21(vec2 point) {
  return fract(sin(dot(point, vec2(12.9898, 78.233))) * 43758.5453);
}

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
  vec3 center = texture2D(sceneTexture, vUv).rgb;

  vec3 crossBlur = (
    texture2D(sceneTexture, vUv + vec2(texel.x, 0.0)).rgb +
    texture2D(sceneTexture, vUv - vec2(texel.x, 0.0)).rgb +
    texture2D(sceneTexture, vUv + vec2(0.0, texel.y)).rgb +
    texture2D(sceneTexture, vUv - vec2(0.0, texel.y)).rgb
  ) * 0.25;
  vec3 color = clamp(center + (center - crossBlur) * 0.10, 0.0, 1.0);

  float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float saturation = 1.055 - edge * pain * 0.08;
  color = mix(vec3(luminance), color, saturation);

  float shadow = 1.0 - smoothstep(0.08, 0.58, luminance);
  float highlight = smoothstep(0.52, 0.96, luminance);
  color += shadow * vec3(-0.006, 0.007, 0.018);
  color += highlight * vec3(0.014, 0.006, -0.004);

  float breathingPulse = 0.65 + sin(time * (2.6 + panic * 3.0)) * 0.35 * motion;
  float vignette = mix(0.095, 0.022, scopeActive) + panic * breathingPulse * 0.085;
  color *= 1.0 - edge * vignette;
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
    vec3 haze = (texture2D(sceneTexture, sampleUv + vec2(blur.x, 0.0)).rgb
      + texture2D(sceneTexture, sampleUv - vec2(blur.x, 0.0)).rgb
      + texture2D(sceneTexture, sampleUv + vec2(0.0, blur.y)).rgb
      + texture2D(sceneTexture, sampleUv - vec2(0.0, blur.y)).rgb) * 0.25;
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

export class CombatPostProcess {
  constructor(renderer, {
    enabled = true,
    maxPixelRatio = POST_PROCESS_PROFILE.maxPixelRatio,
    reducedMotion = false,
  } = {}) {
    if (!renderer || typeof renderer.render !== 'function' ||
        typeof renderer.setRenderTarget !== 'function') {
      throw new TypeError('CombatPostProcess requires a WebGLRenderer-compatible adapter');
    }
    this.renderer = renderer;
    this._rendererInfoAutoReset = renderer.info?.autoReset;
    if (renderer.info) renderer.info.autoReset = false;
    this.enabled = !!enabled;
    this.maxPixelRatio = maxPixelRatio;
    this.reducedMotion = !!reducedMotion;
    this.frames = 0;
    this.fallbacks = 0;
    this.lastError = '';
    this._disposed = false;
    this._size = postProcessBufferSize(1, 1, 1, maxPixelRatio);

    this.target = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.target.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.target.texture.name = 'combat-post-process';
    this.target.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.target.texture.generateMipmaps = false;

    this.uniforms = {
      ...smokeUniforms(this.target.depthTexture),
      grading: { value: 1 },
      sceneTexture: { value: this.target.texture },
      resolution: { value: new THREE.Vector2(1, 1) },
      time: { value: 0 },
      panic: { value: 0 },
      burning: { value: 0 },
      pain: { value: 0 },
      scopeActive: { value: 0 },
      motion: { value: reducedMotion ? 0 : 1 },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'combat-post-process',
      uniforms: this.uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.screen = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.screen.name = 'combat-post-process-screen';
    this.screen.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.screen);
    this.camera = new THREE.Camera();
  }

  setSize(width, height, pixelRatio = 1) {
    if (this._disposed) return this._size;
    const next = postProcessBufferSize(width, height, pixelRatio, this.maxPixelRatio);
    if (next.width !== this._size.width || next.height !== this._size.height) {
      this.target.setSize(next.width, next.height);
      this.uniforms.resolution.value.set(next.width, next.height);
    }
    this._size = next;
    return next;
  }

  render(scene, camera, state = {}) {
    if (this._disposed) return false;
    this.renderer.info?.reset?.();
    const smokeCount = updateSmokeUniforms(this.uniforms, state.smokeFields, state.smokeNow, camera);
    const burning = clamp01(state.burning);
    if (!this.enabled && !smokeCount && !burning) {
      this.renderer.render(scene, camera);
      return false;
    }

    // Keep the hot path allocation-free; normalizePostProcessState() remains the
    // public pure helper for contracts and non-frame callers.
    this.uniforms.grading.value = this.enabled ? 1 : 0;
    this.uniforms.time.value = Math.max(0, Number(state.time) || 0);
    this.uniforms.panic.value = clamp01(state.panic);
    this.uniforms.burning.value = burning;
    this.uniforms.pain.value = clamp01(state.pain);
    this.uniforms.scopeActive.value = state.scopeActive ? 1 : 0;
    this.uniforms.motion.value = this.reducedMotion ? 0 : 1;

    try {
      this.renderer.setRenderTarget(this.target);
      this.renderer.render(scene, camera);
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      this.frames++;
      return true;
    } catch (error) {
      this.renderer.setRenderTarget(null);
      this.enabled = false;
      this.fallbacks++;
      this.lastError = String(error?.message || error || 'shader render failed');
      this.renderer.render(scene, camera);
      return false;
    }
  }

  get stats() {
    return Object.freeze({
      enabled: this.enabled,
      frames: this.frames,
      fallbacks: this.fallbacks,
      bufferWidth: this._size.width,
      bufferHeight: this._size.height,
      pixelRatio: this._size.pixelRatio,
      lastError: this.lastError,
    });
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.scene.remove(this.screen);
    this.screen.geometry.dispose();
    this.material.dispose();
    this.target.dispose();
    this.scene.clear();
    if (this.renderer?.info && this._rendererInfoAutoReset !== undefined) {
      this.renderer.info.autoReset = this._rendererInfoAutoReset;
    }
    this.renderer = null;
  }
}
