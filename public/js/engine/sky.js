import { DEFAULT_DIMENSIONS } from '../../../shared/world/dimensions.js';
// Sky assembly: gradient dome with an in-shader sun disc/halo, plus a fleet of
// deterministically-seeded blocky clouds drifting across the arena.
//
// Design note: the sun is baked INTO the dome shader instead of being a separate
// additive sprite. Two reasons:
//  1. A real 900-unit-distant sprite depends on camera.far (>900) or it vanishes,
//     and a close-by depth-tested-free sprite lands in the transparent pass where
//     it would paint OVER terrain. In-shader costs nothing and cannot break.
//  2. Same trick protects the dome itself: its vertex shader clamps gl_Position.z
//     to just inside the clip volume, so the sky renders regardless of how tight
//     the main camera's far plane is.

import * as THREE from '../vendor/three.module.js';
import { mulberry32 } from '../../../shared/noise.js';
import { SEED } from '../../../shared/worlddata.js';

/** Canonical sunlight direction (matches WorldView's DirectionalLight placement). */
export const SUN_DIR = new THREE.Vector3(60, 90, 20).normalize();

const SKY_TOP_HEX = '#2c63b8';
const SKY_HORIZON_HEX = '#aee0f4';
const SKY_RADIUS = 480;

const CLOUD_COUNT = 14;
const CLOUD_Y = 46;
const CLOUD_SPEED = 1.6;        // units/s along +x
const CLOUD_SPAN = 240;         // drift wrap bounds: map center +/- span
const CLOUD_OPACITY = 0.85;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w * 0.9999999;   // always inside the clip volume
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 topColor;
uniform vec3 horizonColor;
uniform vec3 sunDir;
uniform sampler2D panorama;
uniform bool panoramaReady;
uniform float sunDisc;
uniform float skyHaze;
uniform vec3 glowColor;
uniform float glow;
uniform float overcast;
uniform vec3 deckColor;
varying vec3 vDir;
float skyHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float skyNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(skyHash(i), skyHash(i + vec2(1.0, 0.0)), f.x),
    mix(skyHash(i + vec2(0.0, 1.0)), skyHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  vec3 d = normalize(vDir);
  float h = pow(max(d.y, 0.0), 0.65);
  vec3 col = mix(horizonColor, topColor, h);
  if (panoramaReady) {
    vec2 uv = vec2(atan(d.z, d.x) / 6.28318530718 + 0.5,
      asin(clamp(d.y, -1.0, 1.0)) / 3.14159265359 + 0.5);
    vec3 imageColor = texture2D(panorama, uv).rgb;
    // Blend the wrap locally and quiet the poles for generated panoramas.
    float seam = smoothstep(0.0, 0.025, min(uv.x, 1.0 - uv.x));
    vec3 edge = mix(texture2D(panorama, vec2(0.001, uv.y)).rgb,
      texture2D(panorama, vec2(0.999, uv.y)).rgb, 0.5);
    imageColor = mix(edge, imageColor, seam);
    col = mix(col, imageColor, 1.0 - smoothstep(0.94, 1.0, abs(d.y)));
  }
  // Moods (uniform-only, so every map shares one sky program):
  // haze pulls the sky toward the horizon tone, strongest low down;
  if (skyHaze > 0.0) {
    float band = 1.0 - smoothstep(0.0, 0.55, abs(d.y));
    col = mix(col, horizonColor, skyHaze * (0.35 + 0.65 * band));
  }
  // an overcast deck: mottled grey cloud base projected on a plane overhead;
  if (overcast > 0.0) {
    vec2 p = d.xz / (max(d.y, 0.0) + 0.12) * 1.4;
    float n = skyNoise(p) * 0.55 + skyNoise(p * 2.3 + 7.1) * 0.3 + skyNoise(p * 5.1 - 3.7) * 0.15;
    float above = smoothstep(-0.02, 0.3, d.y);
    col = mix(col, deckColor * (0.8 + 0.34 * n), overcast * above * (0.45 + 0.55 * smoothstep(0.3, 0.75, n)));
  }
  // and a warm band hugging the horizon (ash glow, dusk).
  col += glowColor * glow * exp(-abs(d.y) * 7.0);
  float sd = max(dot(d, sunDir), 0.0);
  // Soft warm disc (~1.8 deg) + two additive halo lobes. The disc core sits
  // above 1.0, so HDR tiers bloom it; overcast palettes set sunDisc to 0.
  col += vec3(1.00, 0.96, 0.86) * smoothstep(0.99930, 0.99976, sd) * 1.6 * sunDisc;
  col += vec3(1.00, 0.88, 0.62) * pow(sd, 320.0) * 0.45 * sunDisc;
  col += vec3(1.00, 0.92, 0.75) * pow(sd, 24.0) * 0.12 * sunDisc;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const _tmpVec = new THREE.Vector3();

/**
 * Adds sky dome + clouds to the scene.
 * @returns {((dt:number)=>void) & {ready:Promise<void>, dispose:()=>void}} cloud updater with owned-resource cleanup.
 */
export function installSky(scene, palette = {}, dimensions = DEFAULT_DIMENSIONS, { onHorizon = null } = {}) {
  const MAP_CX = dimensions.sx / 2, MAP_CZ = dimensions.sz / 2;
  const group = new THREE.Group();
  group.name = 'sky';

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(SKY_RADIUS, 32, 16),
    new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(palette.skyTop || SKY_TOP_HEX) },
        horizonColor: { value: new THREE.Color(palette.skyHorizon || SKY_HORIZON_HEX) },
        sunDir: { value: Array.isArray(palette.sunDir)
          ? new THREE.Vector3(...palette.sunDir).normalize() : SUN_DIR.clone() },
        sunDisc: { value: palette.sunDisc ?? 1 },
        skyHaze: { value: palette.skyHaze ?? 0 },
        glowColor: { value: new THREE.Color(palette.horizonGlow || '#000000') },
        glow: { value: palette.horizonGlow ? palette.horizonGlowStrength ?? 0.2 : 0 },
        overcast: { value: palette.overcast ?? 0 },
        deckColor: { value: new THREE.Color(palette.deckColor || palette.cloud || '#ffffff') },
        panorama: { value: null },
        panoramaReady: { value: false },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
      depthTest: false,
    }),
  );
  dome.name = 'skydome';
  dome.renderOrder = -10;             // painted before everything; everything paints over it
  dome.frustumCulled = false;
  dome.onBeforeRender = (_renderer, _scene, camera) => {
    dome.position.copy(camera.getWorldPosition(_tmpVec));
    dome.updateMatrixWorld();         // apply THIS frame, no follow-lag
  };
  group.add(dome);

  const cloudMat = new THREE.MeshBasicMaterial({
    color: palette.cloud || 0xffffff,
    transparent: true,
    opacity: CLOUD_OPACITY,
  });
  // Note: no flatShading flag needed - MeshBasicMaterial is unlit, so the blocky
  // faces already read flat.

  const rng = mulberry32(SEED ^ 0xC10D5EED);
  const clouds = [];
  // Low blocky puffs must never sit on the distant backdrop (map-backdrop.js,
  // built before the sky): seen against a ridge they shrink it to a model.
  // Each puff fades out while its line of sight would land on the landform
  // ring; per-puff material clones share one program, opacity is a uniform.
  const guard = scene.getObjectByName?.('map-backdrop')?.userData?.cloudGuard || null;
  const cloudMats = [];
  for (let i = 0; i < CLOUD_COUNT; i++) {
    const material = guard ? cloudMat.clone() : cloudMat;
    if (guard) cloudMats.push(material);
    const mesh = new THREE.Mesh(buildPuffGeometry(rng), material);
    mesh.position.set(
      MAP_CX + (rng() - 0.5) * CLOUD_SPAN * 2,
      CLOUD_Y + rng() * 6,
      MAP_CZ + (rng() - 0.5) * CLOUD_SPAN * 2,
    );
    if (guard) mesh.onBeforeRender = guardCloud(mesh, material, guard);
    clouds.push(mesh);
    group.add(mesh);
  }
  // An overcast deck already is the cloud layer; the puffs would read as scud boxes.
  if ((palette.overcast ?? 0) >= 0.5 || palette.clouds === false) {
    for (const cloud of clouds) cloud.visible = false;
  }

  scene.add(group);

  let disposed = false;
  let panorama = null;
  let finishLoading;
  const ready = new Promise(resolve => { finishLoading = resolve; });
  if (palette.skybox && typeof document !== 'undefined' && typeof document.createElementNS === 'function') {
    new THREE.TextureLoader().load(palette.skybox, texture => {
      if (disposed) { texture.dispose(); finishLoading(); return; }
      panorama = texture;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      dome.material.uniforms.panorama.value = texture;
      dome.material.uniforms.panoramaReady.value = true;
      for (const cloud of clouds) cloud.visible = false;
      const horizon = onHorizon ? panoramaHorizon(texture.image) : null;
      if (horizon) onHorizon(moodHorizon(horizon, dome.material.uniforms));
      finishLoading();
    }, undefined, () => { finishLoading(); });
  } else finishLoading();
  const update = function update(dt) {
    if (disposed || !(dt > 0)) return;
    const dx = CLOUD_SPEED * dt;
    const maxX = MAP_CX + CLOUD_SPAN;
    const span = CLOUD_SPAN * 2;
    for (const c of clouds) {
      c.position.x += dx;
      if (c.position.x > maxX) c.position.x -= span;
    }
  };
  update.ready = ready;
  update.dispose = () => {
    if (disposed) return;
    disposed = true;
    finishLoading();
    group.removeFromParent();
    dome.geometry.dispose();
    dome.material.dispose();
    panorama?.dispose();
    for (const cloud of clouds) cloud.geometry.dispose();
    for (const material of cloudMats) material.dispose();
    cloudMat.dispose();
    group.clear();
    clouds.length = 0;
  };
  return update;
}

/**
 * Per-puff fade against the backdrop. The sight line from the camera through
 * the puff's lower near edge is followed to the backdrop's inner circle: if it
 * arrives there between the ground and the ridge top it would draw the puff
 * over the landforms, so the puff fades (opacity uniform, draw range 0 once
 * invisible). Allocation-free; called for every camera that renders it.
 */
function guardCloud(mesh, material, guard) {
  const geometry = mesh.geometry;
  return (_renderer, _scene, camera) => {
    const cam = camera.matrixWorld.elements;
    const px = cam[12], py = cam[13], pz = cam[14];
    const dx = mesh.position.x - px, dz = mesh.position.z - pz;
    const d = Math.hypot(dx, dz) + 1e-3;
    const ux = dx / d, uz = dz / d;
    const ox = px - guard.cx, oz = pz - guard.cz;
    const b = ox * ux + oz * uz;
    const c = ox * ox + oz * oz - guard.radius * guard.radius;
    const reach = Math.max(1, -b + Math.sqrt(Math.max(0, b * b - c)));
    const slope = (mesh.position.y - 1 - py) / Math.max(1, d - 12);
    const y = py + slope * reach;
    const k = Math.max(smooth01(guard.top, guard.top + 14, y), 1 - smooth01(guard.ground - 12, guard.ground, y));
    material.opacity = CLOUD_OPACITY * k;
    geometry.drawRange.count = k > 0.01 ? Infinity : 0;
  };
}

function smooth01(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * The horizon tone after the sky shader's mood terms, sampled a few degrees
 * up, so fog matched to it melts into the hazed or glowing horizon.
 */
export function moodHorizon(color, uniforms) {
  const out = color.clone();
  const band = 1 - 0.1 / 0.55;
  if (uniforms.skyHaze.value > 0) out.lerp(uniforms.horizonColor.value, uniforms.skyHaze.value * (0.35 + 0.65 * band));
  const g = uniforms.glow.value * Math.exp(-0.7), glow = uniforms.glowColor.value;
  out.setRGB(out.r + glow.r * g, out.g + glow.g * g, out.b + glow.b * g);
  return out;
}

/**
 * Average colour just above the panorama's horizon line (sRGB decoded), so
 * distance fog melts into the sky behind it instead of outlining the skyline.
 */
export function panoramaHorizon(image) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 32;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx || !image) return null;
    ctx.drawImage(image, 0, 0, 64, 32);
    const { data } = ctx.getImageData(0, 13, 64, 3);
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
    const n = data.length / 4;
    return new THREE.Color().setRGB(r / n / 255, g / n / 255, b / n / 255, THREE.SRGBColorSpace);
  } catch {
    return null;
  }
}

/**
 * Merge a handful of randomly-sized boxes into one BufferGeometry per cloud
 * puff (one draw call per puff, 14 total).
 */
function buildPuffGeometry(rng) {
  const positions = [];
  const normals = [];
  const index = [];
  let base = 0;
  const boxes = 3 + ((rng() * 4) | 0);   // 3..6 blobs per puff
  for (let b = 0; b < boxes; b++) {
    const g = new THREE.BoxGeometry(
      7 + rng() * 11,
      3 + rng() * 4,
      6 + rng() * 9,
    );
    g.translate((rng() - 0.5) * 16, rng() * 2.4, (rng() - 0.5) * 12);
    positions.push(...g.attributes.position.array);
    normals.push(...g.attributes.normal.array);
    const ia = g.index.array;
    for (let i = 0; i < ia.length; i++) index.push(ia[i] + base);
    base += g.attributes.position.count;
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(new THREE.Uint32BufferAttribute(index, 1));
  geo.computeBoundingSphere();
  return geo;
}
