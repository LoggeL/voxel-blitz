// One bounded full-screen pass for the rendered 3D scene. DOM HUD and menus stay
// untouched, while the world receives a restrained grade, detail recovery and
// condition feedback. A failed pass disables itself and falls back to direct
// rendering, so shader support can never prevent a match from being visible.

import * as THREE from '../vendor/three.module.js';

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
uniform float pain;
uniform float scopeActive;
uniform float motion;

varying vec2 vUv;

float hash21(vec2 point) {
  return fract(sin(dot(point, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 texel = 1.0 / max(resolution, vec2(1.0));
  float injury = clamp(max(pain, panic * 0.55), 0.0, 1.0);
  float channelOffset = injury * texel.x * 0.85;

  vec3 center = texture2D(sceneTexture, vUv).rgb;
  center.r = mix(center.r,
    texture2D(sceneTexture, vUv + vec2(channelOffset, 0.0)).r,
    injury * 0.24);
  center.b = mix(center.b,
    texture2D(sceneTexture, vUv - vec2(channelOffset, 0.0)).b,
    injury * 0.18);

  vec3 crossBlur = (
    texture2D(sceneTexture, vUv + vec2(texel.x, 0.0)).rgb +
    texture2D(sceneTexture, vUv - vec2(texel.x, 0.0)).rgb +
    texture2D(sceneTexture, vUv + vec2(0.0, texel.y)).rgb +
    texture2D(sceneTexture, vUv - vec2(0.0, texel.y)).rgb
  ) * 0.25;
  vec3 color = clamp(center + (center - crossBlur) * 0.10, 0.0, 1.0);

  float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float saturation = 1.055 - injury * 0.25;
  color = mix(vec3(luminance), color, saturation);

  float shadow = 1.0 - smoothstep(0.08, 0.58, luminance);
  float highlight = smoothstep(0.52, 0.96, luminance);
  color += shadow * vec3(-0.006, 0.007, 0.018);
  color += highlight * vec3(0.014, 0.006, -0.004);

  vec2 vignetteUv = (vUv - 0.5) * 2.0;
  vignetteUv.x *= min(resolution.x / max(resolution.y, 1.0), 1.75) * 0.72;
  float edge = smoothstep(0.55, 1.34, length(vignetteUv));
  float vignette = mix(0.095, 0.022, scopeActive) + pain * 0.17;
  color *= 1.0 - edge * vignette;

  float pulse = 0.72 + sin(time * 6.0) * 0.28 * motion;
  color += vec3(0.13, -0.018, -0.022) * edge * pain * pulse;

  float grainFrame = floor(time * 30.0 * motion);
  float grain = hash21(gl_FragCoord.xy + grainFrame) - 0.5;
  color += grain * (0.005 + panic * 0.004);

  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
  #include <colorspace_fragment>
}`;

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function normalizePostProcessState(state = {}) {
  return Object.freeze({
    panic: clamp01(state.panic),
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
    this.target.texture.name = 'combat-post-process';
    this.target.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.target.texture.generateMipmaps = false;

    this.uniforms = {
      sceneTexture: { value: this.target.texture },
      resolution: { value: new THREE.Vector2(1, 1) },
      time: { value: 0 },
      panic: { value: 0 },
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
    if (!this.enabled) {
      this.renderer.render(scene, camera);
      return false;
    }

    // Keep the hot path allocation-free; normalizePostProcessState() remains the
    // public pure helper for contracts and non-frame callers.
    this.uniforms.time.value = Math.max(0, Number(state.time) || 0);
    this.uniforms.panic.value = clamp01(state.panic);
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
