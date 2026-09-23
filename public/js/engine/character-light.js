// Character lighting: avatars, the first-person body, carried weapons and the
// viewmodel sample the same voxel light volume as the terrain (sky occlusion,
// baked sun visibility, coloured block light), with three twists:
//   * a light floor above the terrain's, so a body is never harder to read than
//     the wall behind it;
//   * a faint fresnel rim that keeps silhouettes legible against dark interiors;
//   * the viewmodel and the own body take one CPU probe at the camera instead,
//     eased over ~0.3 s, so the held gun darkens smoothly in a tunnel instead of
//     shading per fragment where its barrel pokes into a wall. Nearness is a
//     per-draw switch (anything parented to the render camera, plus registered
//     near roots), not a distance: an enemy at knife range keeps its own light.
//
// One onBeforeCompile with one constant cache key: every patched material of a
// type shares its program, patched before its first compile. Only uniforms
// change at runtime (see GRAPHICS-BRIEF shader-variant rule).

import * as THREE from '../vendor/three.module.js';
import { VOXEL_LIGHT_PARS, voxelLightsFragmentBegin } from './voxel-light.js';

const CACHE_KEY = 'character-lit-v1';

/** Tuning; `charLight` mirrors x..w, `charRim` the rim colour. */
export const CHARACTER_LIGHT = Object.freeze({
  skyLift: 0.5,       // sky floor = terrain floor lifted this far towards 1
  sunFloor: 0.5,      // terrain shadows keep 1 - shadow (0.25) of the sun
  rim: 0.16,          // fresnel rim strength
  rimPower: 2.6,
  rimColor: [0.78, 0.86, 1.0],
  probeSeconds: 0.12, // exponential time constant of the camera probe (~0.35 s to settle)
});

const fallbackMap = new THREE.Data3DTexture(new Uint8Array([255, 255, 0, 0]), 1, 1, 1);
fallbackMap.needsUpdate = true;
const fallbackSize = new THREE.Vector3(1, 1, 1);
const fallbackParams = new THREE.Vector4(0.5, 0.93, 1.6, 1);
let source = null;

/**
 * Module-wide uniforms: the volume entries follow whichever WorldView bound
 * itself last (getters, so materials compiled before a map load stay valid),
 * and fall back to open sky on preview pages without a world.
 */
export const characterLightUniforms = Object.freeze({
  voxelLightMap: { get value() { return source ? source.voxelLightMap.value : fallbackMap; } },
  voxelLightSize: { get value() { return source ? source.voxelLightSize.value : fallbackSize; } },
  voxelLightParams: { get value() { return source ? source.voxelLightParams.value : fallbackParams; } },
  voxelLightView: { get value() { return source?.voxelLightView ? source.voxelLightView.value : 0; } },
  charLight: { value: new THREE.Vector4(CHARACTER_LIGHT.skyLift, CHARACTER_LIGHT.sunFloor,
    CHARACTER_LIGHT.rim, CHARACTER_LIGHT.rimPower) },
  charRim: { value: new THREE.Vector3(...CHARACTER_LIGHT.rimColor) },
  // Raw volume texel at the render camera: sky, sun, block, hue (0..1).
  charProbe: { value: new THREE.Vector4(1, 1, 0, 0) },
  // x: probe weight (0 until a world feeds it), y: this draw is a near body
  // (viewmodel / own body), set per draw by characterBeforeRender.
  charProbeMix: { value: new THREE.Vector2(0, 0) },
});

const NO_ROOTS = Object.freeze([]);
let nearRoots = NO_ROOTS;

/** WorldView binds its light uniforms here; the previous world is released. */
export function bindCharacterLight(lightUniforms) {
  source = lightUniforms || null;
  characterLightUniforms.charProbeMix.value.x = 0;
  nearRoots = NO_ROOTS;
  probe.seeded = false;
}

export function releaseCharacterLight(lightUniforms) {
  if (source !== lightUniforms) return;
  source = null;
  characterLightUniforms.charProbeMix.value.x = 0;
  nearRoots = NO_ROOTS;
  probe.seeded = false;
}

/**
 * Groups besides the render camera's children that take the camera probe
 * (the first-person body). The array is kept by reference, not copied.
 */
export function setCharacterNearRoots(roots) {
  nearRoots = roots || NO_ROOTS;
}

/** True when `object` hangs under the render camera or a registered near root. */
export function isNearCharacterObject(object, camera) {
  for (let node = object; node; node = node.parent) {
    if (node === camera) return true;
    for (let i = 0; i < nearRoots.length; i++) if (node === nearRoots[i]) return true;
  }
  return false;
}

/**
 * material.onBeforeRender of every patched material: flip the per-draw near
 * switch. Materials are shared between the viewmodel and third-person guns, and
 * three.js re-uploads a material's uniforms only when the material or program
 * changes between draws, so on a flip the bound program is dropped: the next
 * setProgram rebinds it and uploads the new value. Flips happen only at
 * near/far boundaries of the render list.
 */
function characterBeforeRender(renderer, scene, camera, geometry, object) {
  const mix = characterLightUniforms.charProbeMix.value;
  const near = isNearCharacterObject(object, camera) ? 1 : 0;
  if (mix.y === near) return;
  mix.y = near;
  renderer?.state?.useProgram(null);
}

const CHARACTER_PARS = /* glsl */ `
uniform vec4 charLight;
uniform vec3 charRim;
uniform vec4 charProbe;
uniform vec2 charProbeMix;
float charNear;
VoxelLight characterLightAt( vec3 worldPos, vec3 worldNormal ) {
  vec3 p = ( worldPos + worldNormal * 0.5 ) / voxelLightSize;
  vec4 L = texture( voxelLightMap, p );
  float outside = step( 1.0, p.y ) + step( p.x, 0.0 ) + step( 1.0, p.x ) + step( p.z, 0.0 ) + step( 1.0, p.z );
  L.rg = mix( L.rg, vec2( 1.0 ), min( outside, 1.0 ) );
  charNear = charProbeMix.x * charProbeMix.y;
  L = mix( L, charProbe, charNear );
  VoxelLight light;
  light.open = L.r;
  float skyFloor = mix( voxelLightParams.x, 1.0, charLight.x );
  light.sky = max( skyFloor, pow( voxelLightParams.y, 15.0 * ( 1.0 - L.r ) ) );
  light.sun = max( charLight.y, mix( 1.0, L.g, voxelLightParams.w ) );
  light.block = voxelBlockColor( L.a ) * L.b * L.b * voxelLightParams.z;
  return light;
}
`;

const CHARACTER_SAMPLE = /* glsl */ `
VoxelLight voxelLight = characterLightAt( vVoxelWorld, normalize( vVoxelNormal ) );
`;

// Unlike terrain, bodies keep the hemisphere's up/down shape indoors (the flat
// enclosed bounce reads as murk on a figure); sky occlusion only scales it.
const CHARACTER_MODULATE = /* glsl */ `
#include <aomap_fragment>
float voxelExposure = voxelViewExposure();
reflectedLight.indirectDiffuse *= voxelLight.sky * voxelExposure;
reflectedLight.indirectSpecular *= voxelLight.sky * voxelExposure;
reflectedLight.indirectDiffuse += BRDF_Lambert( diffuseColor.rgb ) * voxelLight.block;
`;

// Fresnel rim: brighter where the enclosure is darker, never on the viewmodel.
const CHARACTER_RIM = /* glsl */ `
{
  float charFacing = saturate( dot( normal, normalize( vViewPosition ) ) );
  float charRimAmount = pow( 1.0 - charFacing, charLight.w ) * charLight.z * ( 1.0 - charProbeMix.y );
  outgoingLight += charRim * charRimAmount * ( 0.55 + 0.45 * ( 1.0 - voxelLight.open ) ) * diffuseColor.a;
}
#include <opaque_fragment>
`;

const patched = new WeakSet();
let enabled = true;

/** Capture comparisons only (?charlight=0): leave new materials unpatched. */
export function setCharacterLightEnabled(value) {
  enabled = value !== false;
}

function patchable(material) {
  if (!enabled || !material || patched.has(material)) return false;
  if (!(material.isMeshStandardMaterial || material.isMeshLambertMaterial || material.isMeshPhongMaterial)) return false;
  // Terrain, voxel-lit props and other custom programs keep their own patch.
  return !Object.hasOwn(material, 'onBeforeCompile');
}

/** Opt one lit stock material into character lighting. Returns true when patched. */
export function patchCharacterMaterial(material) {
  if (!patchable(material)) return false;
  patched.add(material);
  const uniforms = characterLightUniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      voxelLightMap: uniforms.voxelLightMap,
      voxelLightSize: uniforms.voxelLightSize,
      voxelLightParams: uniforms.voxelLightParams,
      voxelLightView: uniforms.voxelLightView,
      charLight: uniforms.charLight,
      charRim: uniforms.charRim,
      charProbe: uniforms.charProbe,
      charProbeMix: uniforms.charProbeMix,
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vVoxelWorld;\nvarying vec3 vVoxelNormal;')
      .replace('#include <project_vertex>', `#include <project_vertex>
  vec4 voxelWorld = vec4( transformed, 1.0 );
  vec3 voxelNormal = objectNormal;
  #ifdef USE_INSTANCING
    voxelWorld = instanceMatrix * voxelWorld;
    voxelNormal = mat3( instanceMatrix ) * voxelNormal;
  #endif
  voxelWorld = modelMatrix * voxelWorld;
  vVoxelWorld = voxelWorld.xyz;
  vVoxelNormal = normalize( mat3( modelMatrix ) * voxelNormal );`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vVoxelWorld;\nvarying vec3 vVoxelNormal;\n${VOXEL_LIGHT_PARS}\n${CHARACTER_PARS}`)
      .replace('#include <lights_fragment_begin>', `${CHARACTER_SAMPLE}\n${voxelLightsFragmentBegin()}`)
      .replace('#include <aomap_fragment>', CHARACTER_MODULATE)
      .replace('#include <opaque_fragment>', CHARACTER_RIM);
  };
  material.customProgramCacheKey = () => CACHE_KEY;
  if (Object.hasOwn(material, 'onBeforeRender')) {
    const own = material.onBeforeRender;
    material.onBeforeRender = function (renderer, scene, camera, geometry, object, group) {
      own.call(this, renderer, scene, camera, geometry, object, group);
      characterBeforeRender(renderer, scene, camera, geometry, object);
    };
  } else material.onBeforeRender = characterBeforeRender;
  material.needsUpdate = true;
  return true;
}

let patchedThisPass = 0;
function patchObject(object) {
  const material = object.material;
  if (!material) return;
  if (Array.isArray(material)) {
    for (let i = 0; i < material.length; i++) if (patchCharacterMaterial(material[i])) patchedThisPass++;
  } else if (patchCharacterMaterial(material)) patchedThisPass++;
}

/**
 * Patch every lit material under `root` that will render this frame. Cheap
 * enough to run per frame over the character roots (WeakSet lookups, no
 * allocation), so cosmetics, role gear and weapon swaps are caught before
 * their first compile.
 */
export function prepareCharacterTree(root, visibleOnly = true) {
  if (!root) return 0;
  patchedThisPass = 0;
  if (visibleOnly) root.traverseVisible(patchObject);
  else root.traverse(patchObject);
  return patchedThisPass;
}

const probe = { seeded: false, sample: { sky: 1, sun: 1, block: 0, hue: 0 } };

/**
 * Feed the camera probe: the viewmodel and own body ease towards the light at
 * the render camera.
 */
export function updateCharacterProbe(volume, position, dt) {
  const params = characterLightUniforms.charProbeMix.value;
  if (!volume?.built || !position) { params.x = 0; return; }
  const s = volume.sample(position.x, position.y, position.z, probe.sample);
  let sky = s.sky, sun = s.sun;
  // Above the top or beyond the sides there is only open sky, as in the shader.
  if (position.y >= volume.H || position.x <= 0 || position.z <= 0 || position.x >= volume.W || position.z >= volume.D) {
    sky = 1; sun = 1;
  }
  const out = characterLightUniforms.charProbe.value;
  const k = probe.seeded ? 1 - Math.exp(-Math.max(0, dt) / CHARACTER_LIGHT.probeSeconds) : 1;
  out.x += (sky - out.x) * k;
  out.y += (sun - out.y) * k;
  out.z += (s.block - out.z) * k;
  if (s.block > 0.02) out.w = s.hue;
  probe.seeded = true;
  params.x = 1;
}
