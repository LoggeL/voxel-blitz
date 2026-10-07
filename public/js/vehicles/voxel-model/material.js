// One lit material per vehicle class. Voxel colour (with baked AO) comes from
// the vertex colour; roughness, metalness and the emissive mask come from a
// per-vertex palette attribute. One onBeforeCompile with a constant cache key
// keeps every hull, wheel set and fragment on the same program; only the
// per-material `vehicleState` uniform (soot, lamp gain, burn, near fade)
// changes at runtime. Character lighting (voxel light volume, rim) is
// composed in front of the palette patch, so hulls sample the same light as
// the terrain and the crew sitting in them.
import * as THREE from '../../vendor/three.module.js';
import { patchCharacterMaterial } from '../../engine/character-light.js';

export const VEHICLE_MATERIAL_KEY = 'vehicle-voxel-v2';

const srgb = hex => { const c = new THREE.Color().setHex(hex); return [c.r, c.g, c.b]; };

/**
 * Palette entries: colour (sRGB hex), roughness, metalness, emissive gain.
 * `camo` entries resolve per voxel to the team's camouflage; `team` entries
 * to the team's stripe, roundel or ring. `glass` voxels mesh into the
 * transparent canopy geometry instead.
 */
export const VOXEL_MATERIALS = Object.freeze({
  paint: Object.freeze({ camo: 'body', rough: 0.78, metal: 0.12 }),
  panel: Object.freeze({ camo: 'panel', rough: 0.72, metal: 0.16 }),
  dark: Object.freeze({ color: 0x2b2e2a, rough: 0.88, metal: 0.12 }),
  interior: Object.freeze({ color: 0x4b5049, rough: 0.9, metal: 0.05 }),
  seat: Object.freeze({ color: 0x3d3529, rough: 0.92, metal: 0 }),
  steel: Object.freeze({ color: 0x8a918b, rough: 0.5, metal: 0.45 }),
  gunmetal: Object.freeze({ color: 0x41464a, rough: 0.48, metal: 0.45 }),
  rubber: Object.freeze({ color: 0x1c1d1d, rough: 0.96, metal: 0 }),
  track: Object.freeze({ color: 0x3a3833, rough: 0.82, metal: 0.38 }),
  canvas: Object.freeze({ camo: 'canvas', rough: 0.95, metal: 0 }),
  exhaust: Object.freeze({ color: 0x17130f, rough: 1, metal: 0.1 }),
  brass: Object.freeze({ color: 0xb4903c, rough: 0.38, metal: 0.82 }),
  hazard: Object.freeze({ color: 0xd8b02a, rough: 0.7, metal: 0.05 }),
  missile: Object.freeze({ color: 0xdedbd0, rough: 0.5, metal: 0.2 }),
  warhead: Object.freeze({ color: 0x5d6a74, rough: 0.5, metal: 0.4 }),
  rotor: Object.freeze({ color: 0x24262a, rough: 0.7, metal: 0.25 }),
  tip: Object.freeze({ color: 0xe8d23a, rough: 0.6, metal: 0.05 }),
  head: Object.freeze({ color: 0xfff0c8, rough: 0.3, metal: 0, emissive: 2.6 }),
  tail: Object.freeze({ color: 0xff3a24, rough: 0.4, metal: 0, emissive: 1.8 }),
  navRed: Object.freeze({ color: 0xff2a18, rough: 0.35, metal: 0, emissive: 2.8 }),
  navGreen: Object.freeze({ color: 0x26ff62, rough: 0.35, metal: 0, emissive: 2.8 }),
  strobe: Object.freeze({ color: 0xffffff, rough: 0.35, metal: 0, emissive: 3.2 }),
  screen: Object.freeze({ color: 0x5be38a, rough: 0.3, metal: 0, emissive: 1.4 }),
  stripe: Object.freeze({ team: 'stripe', rough: 0.6, metal: 0.05 }),
  roundel: Object.freeze({ team: 'roundel', rough: 0.55, metal: 0.05 }),
  ring: Object.freeze({ team: 'ring', rough: 0.55, metal: 0.05 }),
  // Plain team base coat (wheel dishes, small fittings): no blots, so it merges.
  drab: Object.freeze({ team: 'drab', rough: 0.8, metal: 0.14 }),
  // Missile warning band.
  marking: Object.freeze({ color: 0xb8432a, rough: 0.6, metal: 0.05 }),
  // Radome, sensor glass housings and similar light-grey composites.
  radome: Object.freeze({ color: 0x9c9f9a, rough: 0.6, metal: 0.08 }),
  glass: Object.freeze({ glass: true, color: 0x7fb8cf, rough: 0.08, metal: 0.4 }),
});

/**
 * Team camouflage (fleet sheet, 2026-10-07): WEST woodland, EAST desert.
 * Each list is [base, ...blots]: the first colour is the ground coat, every
 * later entry is an independent blot field with that coverage share (later
 * entries paint over earlier ones). `panel` shares the weights so the blots
 * run on across panels in a slightly lighter coat. The stripe (WEST white,
 * EAST black) and the roundel (WEST blue, EAST orange, in a contrasting ring)
 * are the team identity; there are no saturated recognition panels.
 */
export const TEAM_SCHEMES = Object.freeze({
  alpha: Object.freeze({
    name: 'woodland',
    // Olive ground, mid green and black-green blots, a small olive-brown share.
    body: Object.freeze([[0x687341, 1], [0x465a2e, 0.4], [0x5c4b30, 0.15], [0x29361f, 0.25]]),
    panel: Object.freeze([[0x717c47, 1], [0x4c6132, 0.4], [0x635134, 0.15], [0x2e3b23, 0.25]]),
    canvas: Object.freeze([[0x5e6442, 1], [0x4b5236, 0.4]]),
    stripe: 0xefeee6, roundel: 0x2d5ad8, ring: 0xf2f0e8, drab: 0x5b6136,
  }),
  bravo: Object.freeze({
    name: 'desert',
    // Sand ground, tan and dark khaki blots, a few pale highlights.
    body: Object.freeze([[0xc9a066, 1], [0xa57a49, 0.4], [0xdcbf90, 0.14], [0x6b5235, 0.22]]),
    panel: Object.freeze([[0xd1a96f, 1], [0xae8250, 0.4], [0xe2c799, 0.14], [0x725839, 0.22]]),
    canvas: Object.freeze([[0xb59a6e, 1], [0x977c55, 0.4]]),
    stripe: 0x1b1b19, roundel: 0xec6a22, ring: 0x1b1b19, drab: 0xa98a5b,
  }),
  neutral: Object.freeze({
    name: 'grey',
    body: Object.freeze([[0x7b8079, 1], [0x666b65, 0.4]]),
    panel: Object.freeze([[0x858a83, 1]]),
    canvas: Object.freeze([[0x77786a, 1]]),
    stripe: 0xd8d8d8, roundel: 0xd8d8d8, ring: 0x4a4a4a, drab: 0x6f736d,
  }),
});

export const teamScheme = team => TEAM_SCHEMES[team] || TEAM_SCHEMES.neutral;

// Deterministic value noise in the hull frame: the camouflage pattern runs
// continuously across hull, turret and gun because all parts share it.
function hash3(x, y, z, seed) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  let total = 0;
  for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) for (let dz = 0; dz < 2; dz++) {
    const w = (dx ? sx : 1 - sx) * (dy ? sy : 1 - sy) * (dz ? sz : 1 - sz);
    total += w * hash3(xi + dx, yi + dy, zi + dz, seed);
  }
  return total;
}

// Value noise piles up around 0.5; this maps the two-octave blend to a roughly
// uniform rank so a blot share of 0.25 really covers about a quarter.
const noiseRank = n => Math.max(0, Math.min(1, (n - 0.27) / 0.46));

/**
 * Blot index for a camo palette at a hull-frame point (metres). Every blot
 * colour has its own warped noise field, stretched along the hull (Z) so the
 * patches read as the long brush blots of the reference, about 0.5-1.2 m
 * across. Voxel centres sample it, so the edges step per voxel.
 */
export function camoIndex(weights, x, y, z, seed = 7) {
  const sx = x * 1.1, sy = y * 1.25, sz = z * 0.72;
  const warp = (valueNoise(sx * 0.7 + 11, sy * 0.7, sz * 0.7, seed + 3) - 0.5) * 1.1;
  for (let i = weights.length - 1; i >= 1; i--) {
    const o = i * 17.31;
    const n = valueNoise(sx + warp + o, sy - warp * 0.6 + o * 0.37, sz + warp * 0.8 - o * 0.53, seed + i * 13) * 0.72
      + valueNoise(sx * 2.3 + o, sy * 2.3, sz * 2.3 - o, seed + i * 29) * 0.28;
    if (noiseRank(n) > 1 - weights[i][1]) return i;
  }
  return 0;
}

/**
 * Resolve a palette entry for one voxel: [r, g, b] linear, roughness,
 * metalness, emissive gain and whether it is glass. Cached per scheme.
 */
export function createPaletteResolver(team, seed = 7) {
  const scheme = teamScheme(team);
  const resolved = new Map();
  const entry = (name, color) => {
    const k = `${name}:${color}`;
    let value = resolved.get(k);
    if (!value) {
      const spec = VOXEL_MATERIALS[name] || VOXEL_MATERIALS.dark;
      value = Object.freeze({ id: resolved.size, color: srgb(color), rough: spec.rough ?? 0.8,
        metal: spec.metal ?? 0, emissive: spec.emissive ?? 0, glass: !!spec.glass, name });
      resolved.set(k, value);
    }
    return value;
  };
  return (name, x, y, z) => {
    const spec = VOXEL_MATERIALS[name] || VOXEL_MATERIALS.dark;
    if (spec.camo) {
      const weights = scheme[spec.camo] || scheme.body;
      return entry(name, weights[camoIndex(weights, x, y, z, seed)][0]);
    }
    if (spec.team) return entry(name, scheme[spec.team]);
    return entry(name, spec.color);
  };
}

// --- shader patch ------------------------------------------------------------

const VERTEX_PARS = /* glsl */ `
attribute vec3 aPal;
attribute vec4 aLip;
attribute float aEdge;
varying vec3 vVehPal;
varying vec4 vVehLip;
varying float vVehEdge;
varying vec3 vVehWorld;
varying vec3 vVehLocal;
varying vec3 vVehNormal;
`;

const VERTEX_MAIN = /* glsl */ `
  vVehPal = aPal;
  vVehLip = aLip;
  vVehEdge = aEdge;
  {
    vec4 vehLocal = vec4( transformed, 1.0 );
    vec3 vehNormal = objectNormal;
    #ifdef USE_INSTANCING
      vehLocal = instanceMatrix * vehLocal;
      vehNormal = mat3( instanceMatrix ) * vehNormal;
    #endif
    vVehLocal = vehLocal.xyz;
    vVehWorld = ( modelMatrix * vehLocal ).xyz;
    vVehNormal = normalize( mat3( modelMatrix ) * vehNormal );
  }
`;

// Scorch and embers use smooth value noise in the part's own frame: no
// per-voxel hash (which read as a checkerboard), no swimming while driving.
const FRAGMENT_PARS = /* glsl */ `
uniform vec4 vehicleState;
varying vec3 vVehPal;
varying vec4 vVehLip;
varying float vVehEdge;
varying vec3 vVehWorld;
varying vec3 vVehLocal;
varying vec3 vVehNormal;
float vehicleLip() {
  float mask = floor( vVehEdge + 0.5 );
  float lip = 0.0;
  float w = 0.04;
  if ( mod( mask, 2.0 ) >= 1.0 ) lip = max( lip, 1.0 - smoothstep( 0.0, w, vVehLip.x ) );
  if ( mod( floor( mask / 2.0 ), 2.0 ) >= 1.0 ) lip = max( lip, 1.0 - smoothstep( 0.0, w, vVehLip.z - vVehLip.x ) );
  if ( mod( floor( mask / 4.0 ), 2.0 ) >= 1.0 ) lip = max( lip, 1.0 - smoothstep( 0.0, w, vVehLip.y ) );
  if ( mod( floor( mask / 8.0 ), 2.0 ) >= 1.0 ) lip = max( lip, 1.0 - smoothstep( 0.0, w, vVehLip.w - vVehLip.y ) );
  return lip;
}
float vehHash( vec3 p ) {
  p = fract( p * 0.3183099 + vec3( 0.71, 0.113, 0.419 ) );
  p *= 17.0;
  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}
float vehNoise( vec3 x ) {
  vec3 i = floor( x ), f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( mix( vehHash( i ), vehHash( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ),
         mix( vehHash( i + vec3( 0.0, 1.0, 0.0 ) ), vehHash( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y ),
    mix( mix( vehHash( i + vec3( 0.0, 0.0, 1.0 ) ), vehHash( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ),
         mix( vehHash( i + vec3( 0.0, 1.0, 1.0 ) ), vehHash( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ), f.y ), f.z );
}
// Scorch coverage for the soot level: blotches that spread with damage and
// close over the whole hull once it is a wreck (soot 1).
float vehScorch() {
  float s = vehicleState.x;
  if ( s <= 0.001 ) return 0.0;
  float n = smoothstep( 0.25, 0.75, vehNoise( vVehLocal * 1.6 ) * 0.7 + vehNoise( vVehLocal * 4.1 + 7.0 ) * 0.3 );
  return smoothstep( n - 0.12, n + 0.04, s * 1.15 );
}
`;

// vehicleState: x soot 0..1, y lamp/emissive gain, z burn glow 0..1, w near-camera fade on.
const FRAGMENT_FADE = /* glsl */ `
  if ( vehicleState.w > 0.5 ) {
    float vehNear = smoothstep( 0.6, 2.5, distance( vVehWorld, cameraPosition ) );
    float vehDither = fract( 52.9829189 * fract( dot( floor( gl_FragCoord.xy ), vec2( 0.06711056, 0.00583715 ) ) ) );
    if ( vehDither > vehNear ) discard;
  }
`;

const FRAGMENT_COLOR = /* glsl */ `
#include <color_fragment>
vec3 vehBase = diffuseColor.rgb;
float vehLipMask = vehicleLip();
diffuseColor.rgb *= 1.0 + 0.22 * vehLipMask;
float vehChar = vehScorch();
if ( vehChar > 0.0 ) {
  // Scorched steel: charcoal with a ghost of the old paint, pale ash on the
  // upward faces, rust-brown heat streaks on the flanks, bare edges.
  float vehLum = dot( vehBase, vec3( 0.2126, 0.7152, 0.0722 ) );
  float vehUp = clamp( vVehNormal.y, 0.0, 1.0 );
  float vehGrain = vehNoise( vVehLocal * 9.0 + 3.0 );
  vec3 vehCharcoal = ( vec3( 0.034, 0.031, 0.028 ) + vehGrain * 0.014 ) * ( 0.75 + 1.1 * vehLum ) + vehBase * 0.13;
  float vehAsh = vehUp * smoothstep( 0.4, 0.78, vehNoise( vVehLocal * 2.6 + 11.0 ) );
  float vehRust = ( 1.0 - vehUp ) * smoothstep( 0.52, 0.82, vehNoise( vVehLocal * 1.9 + 23.0 ) );
  vehCharcoal = mix( vehCharcoal, vec3( 0.13, 0.125, 0.118 ), vehAsh * 0.75 );
  vehCharcoal = mix( vehCharcoal, vec3( 0.075, 0.036, 0.018 ), vehRust * 0.75 );
  vehCharcoal *= 1.0 + 1.1 * vehLipMask;
  diffuseColor.rgb = mix( diffuseColor.rgb, vehCharcoal, vehChar );
}
`;

const FRAGMENT_ROUGHNESS = /* glsl */ `
#include <roughnessmap_fragment>
roughnessFactor = mix( vVehPal.x, 0.8, vehChar );
`;

const FRAGMENT_METALNESS = /* glsl */ `
#include <metalnessmap_fragment>
metalnessFactor = mix( vVehPal.y, 0.3, vehChar );
`;

// Lamps (and fluorescent panels) go dark where the paint is charred. Embers: a wreck (soot near 1)
// glows in sparse veins while the burn timer (z) runs down.
const FRAGMENT_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += vehBase * ( vVehPal.z >= 0.0 ? vVehPal.z * vehicleState.y : -vVehPal.z ) * ( 1.0 - vehChar );
{
  float vehHot = vehicleState.z * smoothstep( 0.75, 1.0, vehicleState.x ) * vehChar;
  if ( vehHot > 0.0 ) {
    float vehBed = smoothstep( 0.5, 0.74, vehNoise( vVehLocal * 1.2 + 5.0 ) );
    float vehVein = smoothstep( 0.7, 0.84, vehNoise( vVehLocal * 5.2 + 41.0 ) );
    float vehFlicker = 0.7 + 0.3 * sin( dot( vVehLocal, vec3( 3.1, 1.7, 2.3 ) ) + vehicleState.z * 60.0 );
    float vehLow = 1.0 - 0.7 * clamp( vVehNormal.y, 0.0, 1.0 );
    totalEmissiveRadiance += vec3( 1.2, 0.26, 0.03 ) * vehVein * vehBed * vehFlicker * vehLow * vehHot;
    totalEmissiveRadiance += vec3( 0.035, 0.008, 0.0 ) * vehBed * vehHot;
  }
}
`;

function palettePatch(shader, material) {
  shader.uniforms.vehicleState = material.userData.vehicleState;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
    .replace('#include <fog_vertex>', `#include <fog_vertex>\n${VERTEX_MAIN}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
    .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FRAGMENT_FADE}`)
    .replace('#include <color_fragment>', FRAGMENT_COLOR)
    .replace('#include <roughnessmap_fragment>', FRAGMENT_ROUGHNESS)
    .replace('#include <metalnessmap_fragment>', FRAGMENT_METALNESS)
    .replace('#include <emissivemap_fragment>', FRAGMENT_EMISSIVE);
}

/**
 * The class material. `state` seeds the vehicleState uniform. Character
 * lighting is composed first when it is enabled; the cache key names both
 * patches so a failed program strips them together (ShaderErrorMonitor).
 */
export function createVehicleMaterial({ soot = 0, lamps = 1, burn = 0, nearFade = false, name = 'vehicle-voxel' } = {}) {
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.8, metalness: 0.1 });
  material.name = name;
  material.userData.vehicleState = { value: new THREE.Vector4(soot, lamps, burn, nearFade ? 1 : 0) };
  const character = patchCharacterMaterial(material);
  const characterPatch = character ? material.onBeforeCompile : null;
  const characterKey = character ? material.customProgramCacheKey() : '';
  material.onBeforeCompile = (shader, renderer) => {
    characterPatch?.call(material, shader, renderer);
    palettePatch(shader, material);
  };
  material.customProgramCacheKey = () => characterKey ? `${VEHICLE_MATERIAL_KEY},${characterKey}` : VEHICLE_MATERIAL_KEY;
  material.needsUpdate = true;
  return material;
}

/** Writes the per-vehicle damage presentation; never changes the program. */
export function setVehicleMaterialState(material, { soot, lamps, burn, nearFade } = {}) {
  const value = material?.userData?.vehicleState?.value;
  if (!value) return;
  if (Number.isFinite(soot)) value.x = Math.max(0, Math.min(1, soot));
  if (Number.isFinite(lamps)) value.y = Math.max(0, lamps);
  if (Number.isFinite(burn)) value.z = burn;
  if (nearFade !== undefined) value.w = nearFade ? 1 : 0;
}

/** Tinted canopy glass: lit, transparent, sorted after opaque hulls. */
export function createVehicleGlassMaterial() {
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.08, metalness: 0.35,
    transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide });
  material.name = 'vehicle-glass';
  return material;
}

/** Spinning-rotor blur disc: an unlit translucent ring texture. */
let blurTexture = null;
export function rotorBlurTexture() {
  if (blurTexture) return blurTexture;
  const size = 64, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (x + 0.5) / size * 2 - 1, dy = (y + 0.5) / size * 2 - 1, r = Math.hypot(dx, dy);
    // A faint veil that thickens toward the blade tips, plus the tip-path
    // ring: the disc tints the ground behind it instead of reading as a shadow.
    const veil = (0.16 + 0.42 * r * r) * (1 - Math.pow(Math.max(0, r - 0.9) / 0.1, 2));
    const tips = Math.max(0, 1 - Math.abs(r - 0.94) / 0.05) * 0.45;
    const band = r > 1 || r < 0.12 ? 0 : veil + tips;
    const streak = 0.7 + 0.3 * Math.cos(Math.atan2(dy, dx) * 2);
    const o = (y * size + x) * 4;
    data[o] = data[o + 1] = data[o + 2] = 255;
    data[o + 3] = Math.round(255 * Math.max(0, Math.min(1, band * streak)));
  }
  blurTexture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  blurTexture.magFilter = blurTexture.minFilter = THREE.LinearFilter;
  blurTexture.name = 'rotor-blur';
  blurTexture.needsUpdate = true;
  return blurTexture;
}

export function createRotorBlurMaterial() {
  const material = new THREE.MeshBasicMaterial({ color: 0x25272a, map: rotorBlurTexture(), transparent: true,
    opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  material.name = 'rotor-blur';
  return material;
}
