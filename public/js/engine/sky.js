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
varying vec3 vDir;
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
  float sd = max(dot(d, sunDir), 0.0);
  // soft warm disc (~1.8 deg) + two additive halo lobes
  col += vec3(1.00, 0.96, 0.86) * smoothstep(0.99930, 0.99976, sd) * 0.95;
  col += vec3(1.00, 0.88, 0.62) * pow(sd, 320.0) * 0.35;
  col += vec3(1.00, 0.92, 0.75) * pow(sd, 24.0) * 0.10;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const _tmpVec = new THREE.Vector3();

/**
 * Adds sky dome + clouds to the scene.
 * @returns {((dt:number)=>void) & {ready:Promise<void>, dispose:()=>void}} cloud updater with owned-resource cleanup.
 */
export function installSky(scene, palette = {}, dimensions = DEFAULT_DIMENSIONS) {
  const MAP_CX = dimensions.sx / 2, MAP_CZ = dimensions.sz / 2;
  const group = new THREE.Group();
  group.name = 'sky';

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(SKY_RADIUS, 32, 16),
    new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(palette.skyTop || SKY_TOP_HEX) },
        horizonColor: { value: new THREE.Color(palette.skyHorizon || SKY_HORIZON_HEX) },
        sunDir: { value: SUN_DIR.clone() },
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
    opacity: 0.85,
  });
  // Note: no flatShading flag needed - MeshBasicMaterial is unlit, so the blocky
  // faces already read flat.

  const rng = mulberry32(SEED ^ 0xC10D5EED);
  const clouds = [];
  for (let i = 0; i < CLOUD_COUNT; i++) {
    const mesh = new THREE.Mesh(buildPuffGeometry(rng), cloudMat);
    mesh.position.set(
      MAP_CX + (rng() - 0.5) * CLOUD_SPAN * 2,
      CLOUD_Y + rng() * 6,
      MAP_CZ + (rng() - 0.5) * CLOUD_SPAN * 2,
    );
    clouds.push(mesh);
    group.add(mesh);
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
    cloudMat.dispose();
    group.clear();
    clouds.length = 0;
  };
  return update;
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
