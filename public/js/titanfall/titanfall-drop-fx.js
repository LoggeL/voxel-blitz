// Titanfall drop presentation (docs/titanfall.md §7.1 "Drop", §7.3): the called titan
// falls out of the sky, brakes on its back thrusters, slams in and shakes everyone near it.
// Presentation only, titanfall only: the server hull sits on its landing spot for the whole
// drop (TITAN_RULES.drop markerMs + fallMs, phase 1) and lands at `landsAt`; this module lifts
// the presented hull onto a visual-only fall path that reaches the ground exactly at `landsAt`
// (server clock from the frame ctx, else the event's own landsAt - at on a local clock).
//
//   fall      the hull comes in from FALL.height m along a slight slant from the titan's front,
//             wrapped in a re-entry heat streak (trail + leading plasma shell), a smoke contrail
//             and shed embers; FALL.brake s before impact the back thrusters fire (jets, burst ring,
//             ground wash) and the shell cools off
//   marker    a team countdown ring on the landing spot (the stock marker beam stays in
//             titan-ability-fx.js dropBeam)
//   impact    flash + light + scorch (an ExplosionFX blast style), a dust shock wave (ground ring,
//             rolling dust wall and particle front out to ~22 m), voxel chunks thrown up (pooled
//             instanced cubes in the ground's colour), grit, sparks and a dust cloud that settles
//             over a few seconds; the camera shake (`dropShakeTrauma`, every viewer, pilots and
//             cockpits alike), a short FOV punch close in, a boom/rumble with distance falloff and
//             sound delay, and a dry sub thump close in (synthesized through the TitanSynth engine)
//   landing   servo steam puffs out of the knees and back vents on impact and again when the
//             titan rises out of the hero landing (the rig's three-point pose, titan-common.js)
//
// Interface (titan-presentation.js wires it): setSinks(sinks), setExplosions(fx), place(item, row),
// impact(item, self), frame(dt, camera, nowMs), onDrop(event, team), clear(), stats(),
// warmupRoot(), TITANFALL_DROP_WARMUP_MATERIALS, dropShakeTrauma(d), dropFovPunch(d), dropLift(tau).
// Pools: one fall rig per concurrent drop (reused), one instanced chunk mesh; no per-frame allocation.
import * as THREE from '../vendor/three.module.js';
import { decodeTitanRow, TITAN_PHASE } from '../../../shared/titan-contract.js';
import { TITAN_RULES, titanFrame } from '../../../shared/vehicle-handling/titan.js';
import { isSolidBlock } from '../../../shared/worlddata.js';
import { TEAM_FX_COLORS } from './titan-ability-fx.js';
import { blockDustTint } from '../vehicles/vehicle-fx.js';

const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const clamp01 = k => Math.max(0, Math.min(1, k));
const smooth = k => k * k * (3 - 2 * k);
const TAU = Math.PI * 2;

/** Presentation tuning (metres, seconds, shake trauma, degrees). No gameplay values. */
export const TITANFALL_DROP_FX = Object.freeze({
  // Fall path: v(tau) = impactSpeed + (cruise - impactSpeed) * tau / brake inside the brake window,
  // `cruise` above it; tau = seconds to impact. ~245 m up at the 3.0 s drop's start.
  cruise: 85, impactSpeed: 40, brake: 0.45, slant: 0.12,          // slant = tan(7°): it comes down along the beam
  streakLength: 58, streakRadius: 2.6, shellRadius: 3.0,
  jetsAt: 0.6, jetLength: 4.2,                                      // s before impact the thrusters light
  hotAt: 1.5, coronaRadius: 5.2,                                    // s before impact the re-entry burns hottest; glow (m)
  heroSnap: 0.6,                                                    // landing pose already this far in at the visual touchdown
  beamFlash: 0.28,                                                  // s the marker beam flashes out at impact
  contrailSpacing: 2.2,                                             // m between contrail puffs
  // Marker countdown ring (m).
  markerRadius: 4.4, markerReach: 16, markerSize: 17,
  // Impact.
  waveRadius: 22, waveSeconds: 1.15, pressureRadius: 15, pressureSeconds: 0.32,
  dustLinger: 3.2, chunks: 34, chunkLife: 3.4, chunkGravity: 24,
  steamDelay: 0.22,
  // Shake: strong inside `shakeNear`, fading to nothing at `shakeFar` (trauma 0..1 on the CameraShake bus).
  shakeNear: 20, shakeFar: 60, shakeInner: 1, shakeEdge: 0.8, shakeRumble: 1.1,
  approachRange: 45, approachShake: 0.5,                            // thruster rumble before impact (trauma/s)
  // FOV punch (degrees) and the dry sub thump inside `closeRange`.
  fovPunch: 9, closeRange: 16,
  linger: 2.2,                                                      // s a drop record outlives its impact (the rise vents inside it)
});
const D = TITANFALL_DROP_FX;

/** Height (m) of the presented hull above its landing spot `tau` seconds before impact. */
export function dropLift(tau) {
  const t = Math.max(0, finite(tau));
  const v1 = D.impactSpeed, v0 = D.cruise, b = D.brake;
  if (t <= b) return v1 * t + (v0 - v1) * t * t / (2 * b);
  return v1 * b + (v0 - v1) * b / 2 + v0 * (t - b);
}
/** Fall speed (m/s) `tau` seconds before impact. */
export const dropSpeed = tau => { const t = Math.max(0, finite(tau)); return t <= D.brake ? D.impactSpeed + (D.cruise - D.impactSpeed) * t / D.brake : D.cruise; };

/** Camera-shake trauma for a viewer `d` m from the impact: strong within 20 m, felt to 60 m. */
export function dropShakeTrauma(d) {
  const x = Math.max(0, finite(d, Infinity));
  if (x <= D.shakeNear) return D.shakeInner - (D.shakeInner - D.shakeEdge) * (x / D.shakeNear);
  if (x >= D.shakeFar) return 0;
  return D.shakeEdge * (D.shakeFar - x) / (D.shakeFar - D.shakeNear);
}
/** FOV punch (degrees, one impulse the camera's own FOV easing takes back) at `d` m. */
export function dropFovPunch(d) {
  const x = Math.max(0, finite(d, Infinity));
  return x >= D.closeRange ? 0 : D.fovPunch * (1 - x / D.closeRange) ** 1.3;
}

// ---- sinks ---------------------------------------------------------------------------------
const sink = { scene: null, fx: null, getBlock: null, shake: null, camera: null, audio: null, view: null, explosions: null,
  selfId: () => null };
const clock = { local: 0, nowMs: null, at: 0 };
const perf = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/** { scene, fx, getBlock, shake, camera, audio (VehicleAudio), view, selfId }. */
export function setSinks({ scene = null, fx = null, getBlock = null, shake = null, camera = null, audio = null, view = null, selfId = null } = {}) {
  if (scene !== sink.scene) clear();
  sink.scene = scene || null;
  sink.fx = fx || null;
  sink.getBlock = typeof getBlock === 'function' ? getBlock : null;
  sink.shake = shake || null;
  sink.camera = camera || null;
  sink.audio = audio || null;
  sink.view = view || null;
  sink.selfId = typeof selfId === 'function' ? selfId : () => null;
  if (sink.scene) sink.scene.add(warmupRoot());
  else warmup?.removeFromParent();
}
/** The match's ExplosionFX (flash, light, scorch); null keeps the rest of the impact. */
export function setExplosions(explosions = null) { sink.explosions = explosions?.spawn ? explosions : null; }

// ---- materials -----------------------------------------------------------------------------
const FOG_V = '#include <fog_pars_vertex>\n', FOG_F = '#include <fog_pars_fragment>\n';
const FOG_ADD = `
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    gl_FragColor.rgb *= 1.0 - fogFactor;
  #endif`;
const NOISE = `
float h21( vec2 p ) { p = fract( p * vec2( 123.34, 456.21 ) ); p += dot( p, p + 45.32 ); return fract( p.x * p.y ); }
float vnoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p ); vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( h21( i ), h21( i + vec2( 1.0, 0.0 ) ), u.x ), mix( h21( i + vec2( 0.0, 1.0 ) ), h21( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}`;

/** Re-entry streak, plasma shell, thruster jets, corona, beam flash: additive. uMode 0 trail, 1 shell, 2 jet, 3 corona, 4 flash. */
function streakMaterial() {
  return new THREE.ShaderMaterial({
    name: 'titanfall-drop-streak', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
    side: THREE.DoubleSide,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uHot: { value: new THREE.Color(1, 1, 1) }, uCool: { value: new THREE.Color(1, 0.4, 0.1) },
      uOpacity: { value: 1 }, uTime: { value: 0 }, uMode: { value: 0 },
    }]),
    vertexShader: `#include <common>
${FOG_V}varying vec2 vUv; varying float vFacing;
void main() {
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  vec3 n = normalize( normalMatrix * normal );
  vFacing = abs( dot( n, normalize( - mvPosition.xyz ) ) );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`,
    fragmentShader: `#include <common>
${FOG_F}uniform vec3 uHot; uniform vec3 uCool; uniform float uOpacity; uniform float uTime; uniform float uMode;
varying vec2 vUv; varying float vFacing;
${NOISE}
void main() {
  float a; vec3 col;
  if ( uMode < 0.5 ) {
    // Trail: v 0 at the hull, 1 at the far end; hot at the hull, licking turbulence along it.
    float head = 1.0 - vUv.y;
    float n = vnoise( vec2( vUv.x * 9.0, vUv.y * 14.0 - uTime * 26.0 ) );
    col = mix( uCool, uHot, head * head );
    a = pow( head, 1.35 ) * smoothstep( 0.0, 0.22, vUv.y ) * pow( vFacing, 1.6 ) * ( 0.55 + 0.6 * n );
  } else if ( uMode < 1.5 ) {
    // Shell: the leading (lower) half glows as a bow-shock rim; the face stays clear so the hull reads.
    float lead = smoothstep( 0.62, 0.02, vUv.y );
    float n = vnoise( vec2( vUv.x * 14.0 + uTime * 3.0, vUv.y * 10.0 - uTime * 18.0 ) );
    float rim = smoothstep( 0.02, 0.22, vFacing ) * pow( 1.0 - vFacing, 2.2 );
    col = mix( uCool, uHot, lead * ( 1.0 - vFacing ) );
    a = lead * rim * ( 0.6 + 0.7 * n );
  } else if ( uMode < 2.5 ) {
    // Jet: v 0 at the nozzle; a white core fading into the plume colour.
    float k = 1.0 - vUv.y;
    float n = vnoise( vec2( vUv.x * 6.0, vUv.y * 9.0 - uTime * 40.0 ) );
    col = mix( uCool, uHot, k * k * vFacing );
    a = pow( k, 1.5 ) * pow( vFacing, 1.2 ) * ( 0.7 + 0.4 * n );
  } else if ( uMode < 3.5 ) {
    // Corona: a camera-facing re-entry glow round the hull (reads from straight below too).
    vec2 q = vUv * 2.0 - 1.0;
    float r = length( q );
    float n = vnoise( vec2( atan( q.y, q.x ) * 3.0 + uTime * 2.0, r * 4.0 - uTime * 9.0 ) );
    float g = max( 0.0, 1.0 - r );
    col = mix( uCool, uHot, g * g );
    a = pow( g, 2.4 ) * ( 0.7 + 0.45 * n );
  } else {
    // Beam flash: a white column, brightest at the ground.
    col = mix( uCool, uHot, vFacing );
    a = ( 1.0 - 0.7 * vUv.y ) * pow( vFacing, 0.7 );
  }
  a *= uOpacity;
  if ( a <= 0.003 ) discard;
  gl_FragColor = vec4( col * a, 1.0 );
${FOG_ADD}
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
  });
}

/** Flat landing-spot countdown ring (XZ plane quad): a segmented sweep, a closing ring, a faint disc. */
function markerMaterial() {
  return new THREE.ShaderMaterial({
    name: 'titanfall-drop-marker', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uColor: { value: new THREE.Color(1, 1, 1) }, uProgress: { value: 0 }, uOpacity: { value: 1 }, uTime: { value: 0 },
      uSize: { value: D.markerSize }, uRadius: { value: D.markerRadius }, uReach: { value: D.markerReach },
    }]),
    vertexShader: `#include <common>
${FOG_V}varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`,
    fragmentShader: `#include <common>
${FOG_F}uniform vec3 uColor; uniform float uProgress; uniform float uOpacity; uniform float uTime; uniform float uSize; uniform float uRadius; uniform float uReach;
varying vec2 vUv;
float band( float r, float c, float w ) { return smoothstep( c - w, c - w * 0.4, r ) * ( 1.0 - smoothstep( c + w * 0.4, c + w, r ) ); }
void main() {
  vec2 p = ( vUv * 2.0 - 1.0 ) * uSize;
  float r = length( p );
  float ang = fract( atan( p.x, p.y ) / 6.2831853 + 1.0 );
  // Countdown: 24 segments, the swept ones bright, the rest dim.
  float seg = step( fract( ang * 24.0 ), 0.82 );
  float swept = step( ang, uProgress );
  float ring = band( r, uRadius, 0.42 ) * seg * mix( 0.22, 1.0, swept );
  // Inner hairline and a slow pulse disc.
  float hair = band( r, uRadius - 0.75, 0.12 ) * 0.5;
  float disc = ( 1.0 - smoothstep( uRadius - 1.0, uRadius - 0.6, r ) ) * ( 0.07 + 0.05 * sin( uTime * 9.0 ) ) * ( 0.6 + uProgress );
  // A ring closing in from the reach onto the footprint as the titan nears.
  float rc = mix( uReach, uRadius + 0.6, pow( uProgress, 0.8 ) );
  float closing = band( r, rc, 0.32 ) * ( 0.25 + 0.75 * uProgress );
  // Ripples running outward from the ring.
  float rp = uRadius + fract( uTime * 1.3 ) * ( uReach - uRadius );
  float ripple = band( r, rp, 0.25 ) * ( 1.0 - fract( uTime * 1.3 ) ) * 0.35;
  float a = ( ring + hair + disc + closing + ripple ) * uOpacity;
  if ( a <= 0.003 ) discard;
  gl_FragColor = vec4( uColor * a, 1.0 );
${FOG_ADD}
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
  });
}

/**
 * Shock wave: uMode 0 a ground ring (XZ quad, r from the uv), 1 a rolling dust wall (open
 * cylinder, v up). `additive` false = dust (alpha), true = the bright pressure front.
 */
function waveMaterial(additive = false) {
  return new THREE.ShaderMaterial({
    name: 'titanfall-drop-wave', transparent: true, depthWrite: false, fog: true, side: THREE.DoubleSide,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uColor: { value: new THREE.Color(0.6, 0.52, 0.4) }, uOpacity: { value: 1 }, uTime: { value: 0 }, uMode: { value: 0 },
      uRadius: { value: 1 }, uWidth: { value: 2 }, uSize: { value: 1 }, uSeed: { value: 0 }, uAdd: { value: additive ? 1 : 0 },
    }]),
    vertexShader: `#include <common>
${FOG_V}varying vec2 vUv; varying float vFacing;
void main() {
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  vec3 n = normalize( normalMatrix * normal );
  vFacing = abs( dot( n, normalize( - mvPosition.xyz ) ) );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`,
    fragmentShader: `#include <common>
${FOG_F}uniform vec3 uColor; uniform float uOpacity; uniform float uTime; uniform float uMode; uniform float uRadius; uniform float uWidth; uniform float uSize; uniform float uSeed; uniform float uAdd;
varying vec2 vUv; varying float vFacing;
${NOISE}
void main() {
  float a;
  if ( uMode < 0.5 ) {
    vec2 p = ( vUv * 2.0 - 1.0 ) * uSize;
    float r = length( p );
    float ang = atan( p.x, p.y );
    float n = vnoise( vec2( ang * 5.0 + uSeed, r * 0.35 - uTime * 0.6 ) ) * 0.6 + vnoise( vec2( ang * 13.0 - uSeed, r * 0.9 ) ) * 0.4;
    // Sharp leading edge, soft trailing body.
    float front = 1.0 - smoothstep( uRadius - uWidth * 0.18, uRadius + uWidth * 0.06, r );
    float body = smoothstep( uRadius - uWidth, uRadius - uWidth * 0.25, r );
    a = front * body * ( 0.45 + 0.75 * n );
  } else {
    float ang = vUv.x * 6.2831853;
    float n = vnoise( vec2( vUv.x * 46.0 + uSeed, vUv.y * 2.5 - uTime * 1.4 ) ) * 0.65 + vnoise( vec2( vUv.x * 110.0, vUv.y * 6.0 + uSeed ) ) * 0.35;
    float h = pow( 1.0 - vUv.y, 1.2 );
    // A torn top (noise), soft silhouette edges.
    a = h * ( 0.3 + 0.7 * smoothstep( 0.2, 0.7, n + h * 0.35 ) ) * pow( vFacing, 1.5 );
  }
  a *= uOpacity;
  if ( a <= 0.003 ) discard;
  if ( uAdd > 0.5 ) gl_FragColor = vec4( uColor * a, 1.0 );
  else gl_FragColor = vec4( uColor, a );
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    if ( uAdd > 0.5 ) gl_FragColor.rgb *= 1.0 - fogFactor;
    else gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
  #endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
  });
}

function chunkMaterial() {
  return new THREE.MeshLambertMaterial({ name: 'titanfall-drop-chunk', color: 0xffffff });
}

/** Programs of the drop FX; `warmupRoot` carries one hidden mesh of each. */
export const TITANFALL_DROP_WARMUP_MATERIALS = Object.freeze(['titanfall-drop-streak', 'titanfall-drop-marker', 'titanfall-drop-wave', 'titanfall-drop-chunk']);

// ---- shared geometry -----------------------------------------------------------------------
let geo = null;
function shapes() {
  if (geo) return geo;
  // Trail: an open cone from the hull (y 0, wide) to the far end (y 1, narrow), v 0 → 1.
  const trail = new THREE.CylinderGeometry(0.3, 1, 1, 16, 6, true);
  trail.translate(0, 0.5, 0);
  // Shell: a sphere (v 0 at the bottom pole).
  const shell = new THREE.SphereGeometry(1, 20, 14);
  // Jet: a cone from the nozzle (y 0) down to its tip (y -1), v 0 at the nozzle.
  const jet = new THREE.CylinderGeometry(1, 0.25, 1, 12, 3, true);
  jet.translate(0, -0.5, 0);
  { const uv = jet.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i)); }
  const quad = new THREE.PlaneGeometry(2, 2, 1, 1);
  quad.rotateX(-Math.PI / 2);
  const wall = new THREE.CylinderGeometry(1, 1, 1, 48, 1, true);
  wall.translate(0, 0.5, 0);
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const glow = new THREE.PlaneGeometry(2, 2, 1, 1);    // camera-facing (XY)
  for (const g of [trail, shell, jet, quad, wall, cube, glow]) g.userData.pageOwned = true;
  geo = { trail, shell, jet, quad, wall, cube, glow };
  return geo;
}

// ---- warm-up -------------------------------------------------------------------------------
let warmup = null;
/** A hidden group with one mesh per drop-FX program (built once, kept for the page). */
export function warmupRoot() {
  if (warmup) return warmup;
  const S = shapes();
  warmup = new THREE.Group();
  warmup.name = 'titanfall-drop-fx-shader-warmup';
  warmup.visible = false;
  for (const mat of [streakMaterial(), markerMaterial(), waveMaterial(false), waveMaterial(true)]) {
    const mesh = new THREE.Mesh(S.quad, mat);
    mesh.name = `warmup-${mat.name}`;
    mesh.frustumCulled = false;
    warmup.add(mesh);
  }
  // The chunk program is the instanced one with instance colours.
  const chunk = new THREE.InstancedMesh(S.cube, chunkMaterial(), 1);
  chunk.setColorAt(0, new THREE.Color(1, 1, 1));
  chunk.name = 'warmup-titanfall-drop-chunk';
  chunk.frustumCulled = false;
  warmup.add(chunk);
  return warmup;
}

// ---- fall rigs (pooled per concurrent drop) ------------------------------------------------
const rigPool = [];
function makeRig() {
  const S = shapes();
  const mesh = (geometry, material, parent) => {
    const m = new THREE.Mesh(geometry, material);
    m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false; m.renderOrder = 5;
    parent.add(m);
    return m;
  };
  const fall = new THREE.Group();
  fall.name = 'titanfall-drop-fall';
  const trail = mesh(S.trail, streakMaterial(), fall);
  const trailCore = mesh(S.trail, streakMaterial(), fall);
  const shell = mesh(S.shell, streakMaterial(), fall);
  shell.material.uniforms.uMode.value = 1;
  shell.material.side = THREE.FrontSide;
  const jets = [0, 1, 2, 3].map(() => { const j = mesh(S.jet, streakMaterial(), fall); j.material.uniforms.uMode.value = 2; return j; });
  const corona = mesh(S.glow, streakMaterial(), fall);
  corona.material.uniforms.uMode.value = 3;
  const ground = new THREE.Group();
  ground.name = 'titanfall-drop-ground';
  const marker = mesh(S.quad, markerMaterial(), ground);
  marker.position.y = 0.07;
  // The quad spans ±1: scaled by the half extent, which the shader also gets as uSize (metres).
  marker.scale.setScalar(D.markerSize);
  marker.material.uniforms.uSize.value = D.markerSize;
  const dust = mesh(S.quad, waveMaterial(false), ground);
  dust.position.y = 0.09;
  const wall = mesh(S.wall, waveMaterial(false), ground);
  wall.material.uniforms.uMode.value = 1;
  const pressure = mesh(S.quad, waveMaterial(true), ground);
  pressure.position.y = 0.11;
  // The marker beam's last moment: a white column flashing out at impact.
  const flash = mesh(S.trail, streakMaterial(), ground);
  flash.visible = false;
  return { fall, ground, trail, trailCore, shell, jets, corona, marker, dust, wall, pressure, flash,
    materials: [trail, trailCore, shell, ...jets, corona, marker, dust, wall, pressure, flash].map(m => m.material) };
}
function takeRig() { return rigPool.pop() ?? makeRig(); }
function giveRig(rig) {
  rig.fall.removeFromParent();
  rig.ground.removeFromParent();
  rigPool.push(rig);
}
function disposeRig(rig) {
  rig.fall.removeFromParent(); rig.ground.removeFromParent();
  for (const material of rig.materials) material.dispose();
}

// ---- chunk pool (instanced voxel debris) ---------------------------------------------------
const CHUNK_CAP = 128;
const chunk = {
  mesh: null, n: 0, cursor: 0,
  pos: new Float32Array(CHUNK_CAP * 3), vel: new Float32Array(CHUNK_CAP * 3), rot: new Float32Array(CHUNK_CAP * 3),
  spin: new Float32Array(CHUNK_CAP * 3), size: new Float32Array(CHUNK_CAP), age: new Float32Array(CHUNK_CAP),
  life: new Float32Array(CHUNK_CAP), bounces: new Uint8Array(CHUNK_CAP), alive: new Uint8Array(CHUNK_CAP),
};
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
const _c = new THREE.Color(), _v = new THREE.Vector3(), _w = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
function chunkMesh() {
  if (chunk.mesh) return chunk.mesh;
  const mesh = new THREE.InstancedMesh(shapes().cube, chunkMaterial(), CHUNK_CAP);
  mesh.name = 'titanfall-drop-chunks';
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.setColorAt(0, _c.setRGB(1, 1, 1));
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.visible = false;
  chunk.mesh = mesh;
  return mesh;
}
function spawnChunk(x, y, z, vx, vy, vz, size, color) {
  const mesh = chunkMesh();
  let i = -1;
  for (let k = 0; k < CHUNK_CAP; k++) { const j = (chunk.cursor + k) % CHUNK_CAP; if (!chunk.alive[j]) { i = j; break; } }
  if (i < 0) i = chunk.cursor;               // full: recycle the oldest slot
  chunk.cursor = (i + 1) % CHUNK_CAP;
  const o = i * 3;
  chunk.pos[o] = x; chunk.pos[o + 1] = y; chunk.pos[o + 2] = z;
  chunk.vel[o] = vx; chunk.vel[o + 1] = vy; chunk.vel[o + 2] = vz;
  chunk.rot[o] = Math.random() * TAU; chunk.rot[o + 1] = Math.random() * TAU; chunk.rot[o + 2] = Math.random() * TAU;
  chunk.spin[o] = (Math.random() - 0.5) * 16; chunk.spin[o + 1] = (Math.random() - 0.5) * 10; chunk.spin[o + 2] = (Math.random() - 0.5) * 16;
  chunk.size[i] = size; chunk.age[i] = 0; chunk.life[i] = D.chunkLife * (0.75 + Math.random() * 0.5);
  chunk.bounces[i] = 0; chunk.alive[i] = 1;
  mesh.setColorAt(i, color);
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}
const solidAt = (x, y, z) => !!sink.getBlock && isSolidBlock(sink.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)));
function stepChunks(dt) {
  const mesh = chunk.mesh;
  if (!mesh) return 0;
  let top = 0, live = 0;
  for (let i = 0; i < CHUNK_CAP; i++) {
    if (!chunk.alive[i]) continue;
    chunk.age[i] += dt;
    if (chunk.age[i] >= chunk.life[i]) { chunk.alive[i] = 0; continue; }
    live++;
    const o = i * 3, half = chunk.size[i] / 2;
    if (chunk.bounces[i] < 3) {
      chunk.vel[o + 1] -= D.chunkGravity * dt;
      const drag = Math.exp(-dt * 0.35);
      chunk.vel[o] *= drag; chunk.vel[o + 2] *= drag;
      const nx = chunk.pos[o] + chunk.vel[o] * dt, ny = chunk.pos[o + 1] + chunk.vel[o + 1] * dt, nz = chunk.pos[o + 2] + chunk.vel[o + 2] * dt;
      if (chunk.vel[o + 1] < 0 && solidAt(nx, ny - half, nz)) {
        // Bounce off the voxel top, losing most of the energy; the third contact rests it.
        chunk.pos[o] = nx; chunk.pos[o + 2] = nz; chunk.pos[o + 1] = Math.floor(ny - half) + 1 + half;
        chunk.bounces[i]++;
        chunk.vel[o + 1] = chunk.bounces[i] >= 3 ? 0 : -chunk.vel[o + 1] * 0.32;
        chunk.vel[o] *= 0.45; chunk.vel[o + 2] *= 0.45;
        for (let k = 0; k < 3; k++) chunk.spin[o + k] *= 0.4;
        if (chunk.bounces[i] === 1 && sink.fx && half > 0.18) sink.fx.emit('dust', [nx, chunk.pos[o + 1] - half + 0.1, nz], { count: 1, speed: 0.6, scale: 0.9, alpha: 0.5 });
      } else if (chunk.vel[o] !== 0 && solidAt(nx, ny, nz)) {
        // Into a wall: drop straight down.
        chunk.vel[o] = 0; chunk.vel[o + 2] = 0; chunk.pos[o + 1] = ny;
      } else { chunk.pos[o] = nx; chunk.pos[o + 1] = ny; chunk.pos[o + 2] = nz; }
      chunk.rot[o] += chunk.spin[o] * dt; chunk.rot[o + 1] += chunk.spin[o + 1] * dt; chunk.rot[o + 2] += chunk.spin[o + 2] * dt;
    }
    // Shrink away over the last 0.5 s.
    const left = chunk.life[i] - chunk.age[i];
    const s = chunk.size[i] * (left < 0.5 ? left / 0.5 : 1);
    _q.setFromEuler(_e.set(chunk.rot[o], chunk.rot[o + 1], chunk.rot[o + 2]));
    _m.compose(_p.set(chunk.pos[o], chunk.pos[o + 1], chunk.pos[o + 2]), _q, _s.set(s, s, s));
    mesh.setMatrixAt(i, _m);
    top = i + 1;
  }
  // Dead slots below `top` keep a zero-scale matrix.
  for (let i = 0; i < top; i++) if (!chunk.alive[i]) mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
  mesh.count = top;
  mesh.visible = live > 0;
  if (top) mesh.instanceMatrix.needsUpdate = true;
  chunk.n = live;
  return live;
}

// ---- drop records --------------------------------------------------------------------------
const drops = new Map();        // vehicleId -> record
let stamp = 0;

/** Seconds until the record's impact on the server clock (or the local fallback clock). */
function tauOf(rec) {
  if (Number.isFinite(clock.nowMs) && Number.isFinite(rec.landsAt)) return (rec.landsAt - (clock.nowMs + (perf() - clock.at))) / 1000;
  return rec.localLand - clock.local;
}

function record(id, { x, y, z, team = 'neutral', landsAt = NaN, seconds = (TITAN_RULES.drop.markerMs + TITAN_RULES.drop.fallMs) / 1000 } = {}) {
  let rec = drops.get(id);
  if (!rec) {
    rec = { id, x, y, z, team, landsAt, localLand: clock.local + seconds, total: seconds, impacted: false, impactAge: 0, rig: null,
      contrailY: null, emberCarry: 0, sparkCarry: 0, steam: [], yaw: 0, lift: 0, item: null, seed: (stamp++ * 7.31) % 100, wash: 0, tint: null, burst: false,
      self: false, endBeam: null };
    drops.set(id, rec);
  } else {
    Object.assign(rec, { x, y, z, team, landsAt });
    rec.localLand = clock.local + seconds; rec.total = seconds;
  }
  return rec;
}

/**
 * `titanfall_drop` (titan-presentation onEvent): the record, its countdown ring and the incoming sound.
 * `self`: the viewer called it (full shake); `endBeam`: ends the marker beam at impact.
 */
export function onDrop(event, team = 'neutral', { self = false, endBeam = null } = {}) {
  if (!event || event.vehicleId == null || ![event.x, event.y, event.z].every(Number.isFinite)) return null;
  const seconds = Number.isFinite(event.landsAt) && Number.isFinite(event.at) ? Math.max(0.3, (event.landsAt - event.at) / 1000)
    : (TITAN_RULES.drop.markerMs + TITAN_RULES.drop.fallMs) / 1000;
  const rec = record(String(event.vehicleId), { x: event.x, y: event.y, z: event.z, team, landsAt: finite(event.landsAt, NaN), seconds });
  rec.self = !!self;
  rec.endBeam = typeof endBeam === 'function' ? endBeam : null;
  ensureRig(rec);
  incomingSound(rec, seconds);
  return rec;
}

function ensureRig(rec) {
  if (rec.rig || !sink.scene) return rec.rig;
  const rig = rec.rig = takeRig();
  const color = TEAM_FX_COLORS[rec.team] || TEAM_FX_COLORS.neutral;
  rig.marker.material.uniforms.uColor.value.setRGB(color[0] * 1.8, color[1] * 1.8, color[2] * 1.8);
  rig.marker.material.uniforms.uOpacity.value = 0;
  for (const m of [rig.dust, rig.wall, rig.pressure]) { m.visible = false; m.material.uniforms.uOpacity.value = 0; }
  rig.marker.visible = true;
  rig.flash.visible = false;
  rig.ground.position.set(rec.x, rec.y, rec.z);
  sink.scene.add(rig.ground);
  rig.fall.visible = false;
  return rig;
}

function release(rec) {
  if (rec.rig) { giveRig(rec.rig); rec.rig = null; }
  drops.delete(rec.id);
}

/**
 * Before the rig poses a walker (titan-presentation update): a dropping hull is lifted onto its
 * fall path. The server hull stands still at its landing spot while it drops, so the root snaps
 * to the row plus the lift (no smoothing to fight). At the visual touchdown the impact plays right
 * here, and from then on the rig is handed the landed phase (returned) while the row still says
 * dropping, so the landing pose starts on the touchdown frame. Returns the phase to present, or
 * null for the row's own.
 */
export function place(item, row) {
  const phase = decodeTitanRow(row)?.phase ?? 0;
  if (!Number.isFinite(row?.x)) return null;
  const id = String(item.id ?? row.id);
  let rec = drops.get(id);
  if (phase !== TITAN_PHASE.dropping || item.wreck) {
    // Landed before the visual touchdown (a late frame): straight onto the row, the edge slams next.
    if (rec && !rec.impacted && !item.wreck) { item.root.position.set(row.x, row.y, row.z); item.root.rotation.x = 0; rec.lift = 0; }
    return null;
  }
  // Joined mid-drop (no event seen): assume the fall's last second.
  if (!rec) rec = record(id, { x: row.x, y: row.y, z: row.z, team: row.team ?? 'neutral', seconds: 1 });
  rec.item = item;
  rec.yaw = finite(row.yaw);
  if (!rec.impacted && tauOf(rec) <= 0) {
    // Visual touchdown: the impact now (the landed row's edge then finds it done).
    rec.x = row.x; rec.y = row.y; rec.z = row.z; rec.lift = 0;
    ensureRig(rec);
    slam(rec, false);
  }
  if (rec.impacted) { item.root.position.set(row.x, row.y, row.z); return TITAN_PHASE.landed; }
  const tau = Math.max(0, tauOf(rec));
  const lift = dropLift(tau);
  rec.lift = lift;
  // Height only here: the rig reads no ground speed from the fall (afterPose adds the slant).
  item.root.position.set(row.x, row.y + lift, row.z);
  if (lift > 0.05) ensureRig(rec);
  return null;
}

/**
 * After the rig posed the falling hull: the approach comes in from the titan's front (where the
 * caller looked) on a 20° slant, so the hull is shifted along it (airborne feet hang with the hull).
 */
export function afterPose(item) {
  const rec = drops.get(String(item?.id ?? ''));
  if (!rec || rec.impacted || !(rec.lift > 0.05) || rec.item !== item) return;
  const k = rec.lift * D.slant;
  item.root.position.x += -Math.sin(rec.yaw) * k;
  item.root.position.z += -Math.cos(rec.yaw) * k;
}

/**
 * The dropping → landed edge (titan-presentation's slam): the impact, once per drop. Returns true
 * when this module presented it (the caller then skips its own slam).
 */
export function impact(item, self = false) {
  const id = String(item?.id ?? '');
  let rec = drops.get(id);
  if (rec?.impacted) return true;
  // The landed row is the truth (the root may still carry part of the lift through the view's easing).
  const row = item?.row, p = item?.root?.position;
  if (!p) return false;
  const x = finite(row?.x, p.x), y = finite(row?.y, p.y), z = finite(row?.z, p.z);
  if (!rec) rec = record(id, { x, y, z, team: row?.team ?? 'neutral', seconds: 0 });
  rec.item = item;
  rec.x = x; rec.y = y; rec.z = z;
  item.root.position.set(x, y, z);
  ensureRig(rec);
  slam(rec, self);
  return true;
}

// ---- per frame -----------------------------------------------------------------------------

/** Per frame (titan-presentation frame): fall rigs, impacts on visual touchdown, waves, chunks, steam. */
export function frame(dt, camera = null, nowMs = null) {
  const step = Math.max(0, Math.min(0.25, finite(dt)));
  if (camera) sink.camera = camera;
  if (Number.isFinite(nowMs)) { clock.nowMs = nowMs; clock.at = perf(); }
  for (const rec of [...drops.values()]) {
    if (!rec.impacted) falling(rec, step);
    else aftermath(rec, step);
  }
  stepChunks(step);
  clock.local += step;
}

const _eye = new THREE.Vector3();
const eye = () => (sink.camera?.getWorldPosition ? sink.camera.getWorldPosition(_eye) : sink.camera?.position ?? null);
const distanceTo = (x, y, z) => { const e = eye(); return e ? Math.hypot(e.x - x, e.y - y, e.z - z) : Infinity; };

function falling(rec, step) {
  const tau = tauOf(rec);
  const rig = rec.rig;
  const item = rec.item && rec.item.root?.parent ? rec.item : (sink.view?.item?.(rec.id) ?? null);
  // Countdown ring: in over 0.25 s, the sweep fills toward the impact.
  if (rig) {
    const u = rig.marker.material.uniforms;
    u.uProgress.value = clamp01(1 - Math.max(0, tau) / Math.max(0.3, rec.total));
    u.uOpacity.value = Math.min(1, u.uOpacity.value + step * 4);
    u.uTime.value = clock.local;
  }
  // A drop whose hull left (refund, owner gone) fades out without an impact.
  if (!item) {
    if (tau < -0.5 || (rec.item && !rec.item.root?.parent)) release(rec);
    return;
  }
  rec.item = item;
  const root = item.root;
  if (tau <= 0) {
    // Visual touchdown before the landed row: present the impact now, the phase edge then skips it.
    slam(rec, false);
    return;
  }
  if (!rig) return;
  const lift = rec.lift;
  // Fall rig rides the hull root; the streak points back up the approach.
  const fall = rig.fall;
  if (fall.parent !== root) root.add(fall);
  fall.visible = lift > 0.3;
  if (!fall.visible) return;
  const f = titanFrame(item.kind ?? item.row?.type) || { height: 7, hw: 1.4, hl: 1.1 };
  const speed = dropSpeed(tau);
  // Re-entry heat: warming over the high fall, hottest from `hotAt` s out until late in the burn,
  // still glowing at touchdown.
  const heat = tau > D.hotAt ? 0.6 + 0.4 * clamp01((rec.total - tau) / Math.max(0.1, rec.total - D.hotAt))
    : tau > 0.3 ? 1 : 0.55 + 0.45 * tau / 0.3;
  const jets = clamp01(1 - (tau - 0.05) / D.jetsAt);
  // World direction back up the path (unit), expressed in the root's frame.
  const fx = -Math.sin(rec.yaw), fz = -Math.cos(rec.yaw);
  _v.set(fx * D.slant, 1, fz * D.slant).normalize();
  _qa.setFromUnitVectors(_up, _v);
  root.getWorldQuaternion(_qb).invert();
  fall.quaternion.copy(_qb.multiply(_qa));
  fall.position.set(0, f.height * 0.35, 0);
  const t = clock.local;
  const trailLen = D.streakLength * (0.35 + 0.65 * heat) * Math.min(1, lift / 12);
  rig.trail.scale.set(D.streakRadius, Math.max(0.1, trailLen), D.streakRadius);
  rig.trail.position.y = f.height * 0.2;
  setStreak(rig.trail.material, [3.2, 1.9, 0.8], [2.2, 0.55, 0.08], 1.0 * heat, t, 0);
  rig.trailCore.scale.set(D.streakRadius * 0.42, Math.max(0.1, trailLen * 0.6), D.streakRadius * 0.42);
  rig.trailCore.position.y = f.height * 0.25;
  setStreak(rig.trailCore.material, [3.8, 3.0, 2.0], [2.6, 1.1, 0.25], 0.85 * heat, t, 0);
  rig.shell.scale.set(D.shellRadius * 1.05, f.height * 0.62, D.shellRadius * 1.05);
  rig.shell.position.y = -f.height * 0.02;
  // Shell and corona give way to the hull and its jets late in the burn (the landing must read).
  const reveal = smooth(clamp01((tau - 0.08) / 0.45));
  setStreak(rig.shell.material, [3.2, 2.0, 0.8], [1.8, 0.45, 0.08], 0.5 * heat * reveal, t, 1);
  // Corona: faces the camera, so a pilot right under the beam sees the fireball coming.
  const cam = sink.camera;
  rig.corona.visible = !!cam;
  if (cam) {
    rig.corona.position.set(0, -f.height * 0.05, 0);
    cam.getWorldQuaternion(_qb);
    rig.corona.quaternion.copy(fall.getWorldQuaternion(_qa).invert().multiply(_qb));
    const size = D.coronaRadius * (0.7 + 0.3 * heat) * (0.92 + 0.08 * Math.sin(t * 37));
    rig.corona.scale.set(size, size, size);
    setStreak(rig.corona.material, [3.4, 2.7, 1.7], [2.2, 0.62, 0.1], 0.7 * heat * reveal, t, 3);
  }
  // Thruster jets out of the back vents, pointing down the fall (braking burn).
  const thrusters = item.model?.emitters?.thrusters || [];
  for (let j = 0; j < rig.jets.length; j++) {
    const jet = rig.jets[j];
    const node = thrusters[j % Math.max(1, thrusters.length)]?.node;
    jet.visible = jets > 0.01 && !!node && j < thrusters.length;
    if (!jet.visible) continue;
    node.getWorldPosition(_w);
    fall.worldToLocal(_w);
    jet.position.copy(_w);
    // Jets fire straight down (world -Y; the cone's own axis is local -Y), flickering.
    jet.quaternion.copy(fall.getWorldQuaternion(_qa).invert());
    const flicker = 0.85 + 0.15 * Math.sin(t * 61 + j * 2.1);
    jet.scale.set(0.95 * flicker, D.jetLength * jets * flicker, 0.95 * flicker);
    setStreak(jet.material, [2.4, 3.0, 3.6], [0.25, 0.65, 1.9], 1.0 * jets, t, 2);
  }
  // Particles: contrail puffs along the path since last frame, shed embers, thruster sparks, ground wash.
  const fx2 = sink.fx;
  if (fx2) {
    const p = root.position, top = p.y + f.height * 0.5;
    if (rec.contrailY === null) rec.contrailY = top + 2;
    const sp = D.contrailSpacing;
    let guard = 0;
    while (rec.contrailY - top > sp && guard++ < 40) {
      rec.contrailY -= sp;
      const back = (rec.contrailY - rec.y) * D.slant;
      _p.set(rec.x + fx * back, rec.contrailY, rec.z + fz * back);
      fx2.emit('smoke', [_p.x, _p.y + 3, _p.z], { count: 1, speed: 0.35, scale: 3 + 2 * heat, life: 2.4, alpha: 0.5,
        color0: [0.5, 0.48, 0.46], color1: [0.76, 0.75, 0.73], dir: [0, 1, 0], spread: 1.2 });
      if (heat > 0.2) fx2.emit('fire', [_p.x, _p.y, _p.z], { count: 1, speed: 0.3, scale: 2.4 * heat, life: 0.5,
        alpha: 0.75, color0: [3.0, 1.9, 0.8], color1: [1.6, 0.42, 0.06] });
    }
    // A ragged fire wake: puffs born just up the path behind the hull (never over it) trail off.
    if (heat > 0.05) for (let k = 0; k < 2; k++) {
      const a = Math.random() * TAU, r = 0.6 + Math.random() * 1.4, d = 2 + Math.random() * 5;
      fx2.emit('fire', [p.x + fx * D.slant * d + Math.sin(a) * r, top + d, p.z + fz * D.slant * d + Math.cos(a) * r], { count: 1, speed: 0.5, scale: 2.2 * heat,
        life: 0.45, alpha: 0.55 * heat, color0: [2.1, 0.95, 0.3], color1: [0.9, 0.2, 0.04] });
    }
    // Sparks and slag torn off the hot hull, left hanging up the path.
    rec.sparkCarry += step * 90 * Math.max(0, heat - 0.5) * 2;
    const sparks = Math.floor(rec.sparkCarry); rec.sparkCarry -= sparks;
    if (sparks > 0) fx2.emit('spark', [p.x, p.y + f.height * 0.25, p.z], { count: Math.min(10, sparks), speed: 6, dir: [fx * D.slant, 1, fz * D.slant], spread: 0.9,
      velocity: [-fx * D.slant * speed * 0.35, -speed * 0.35, -fz * D.slant * speed * 0.35] });
    rec.emberCarry += step * 70 * heat;
    const embers = Math.floor(rec.emberCarry); rec.emberCarry -= embers;
    if (embers > 0) fx2.emit('ember', [p.x, p.y + f.height * 0.3, p.z], { count: Math.min(8, embers), speed: 2.2, dir: [fx * D.slant, 1, fz * D.slant], spread: 0.6,
      velocity: [-fx * D.slant * speed * 0.5, -speed * 0.5, -fz * D.slant * speed * 0.5] });
    if (jets > 0) {
      for (let j = 0; j < Math.min(4, thrusters.length); j++) {
        thrusters[j].node.getWorldPosition(_w);
        // The plume rides down with the hull and beyond it.
        fx2.emit('fire', [_w.x, _w.y - 0.8, _w.z], { count: 2, dir: [0, -1, 0], speed: 4, spread: 0.18, scale: 1.5, life: 0.32, alpha: 0.75,
          color0: [1.8, 2.4, 2.9], color1: [0.3, 0.8, 1.9], velocity: [-_v.x * speed, -_v.y * speed - 10, -_v.z * speed] });
      }
      // The burst ring the moment the burn lights.
      if (!rec.burst) {
        rec.burst = true;
        for (let k = 0; k < 14; k++) {
          const a = k / 14 * TAU;
          fx2.emit('smoke', [p.x + Math.sin(a) * 1.8, p.y + f.height * 0.6, p.z + Math.cos(a) * 1.8], { count: 1, dir: [Math.sin(a), -0.2, Math.cos(a)],
            speed: 4.5, spread: 0.2, scale: 1.3, life: 0.8, alpha: 0.5, color0: [0.82, 0.84, 0.88], color1: [0.7, 0.72, 0.75] });
        }
        burnSound(rec);
      }
      // Thruster wash kicks the dust up before the hull arrives.
      if (lift < 22) {
        rec.wash += step * 60 * (1 - lift / 22);
        const n = Math.floor(rec.wash); rec.wash -= n;
        const tint = groundTint(rec);
        for (let k = 0; k < n && k < 6; k++) {
          const a = Math.random() * TAU;
          fx2.emit('dust', [rec.x + Math.sin(a) * 2.5, rec.y + 0.3, rec.z + Math.cos(a) * 2.5], { count: 1, dir: [Math.sin(a), 0.15, Math.cos(a)],
            speed: 4 + 4 * (1 - lift / 22), spread: 0.25, scale: 1.8, life: 0.9, alpha: 0.5, color0: tint, color1: tint, ground: rec.y });
        }
      }
    }
  }
  // Rumble on the ground under the burn.
  if (jets > 0 && sink.shake?.add) {
    const d = distanceTo(rec.x, rec.y, rec.z);
    if (d < D.approachRange) sink.shake.add(D.approachShake * step * jets * (1 - d / D.approachRange));
  }
}

function setStreak(material, hot, cool, opacity, time, mode) {
  const u = material.uniforms;
  u.uHot.value.setRGB(hot[0], hot[1], hot[2]);
  u.uCool.value.setRGB(cool[0], cool[1], cool[2]);
  u.uOpacity.value = Math.max(0, opacity);
  u.uTime.value = time;
  u.uMode.value = mode;
}

const DIRT_DUST = Object.freeze([0.56, 0.47, 0.35]), DIRT_SOIL = Object.freeze([0.4, 0.3, 0.2]);
/** Ground dust colour under the landing spot (cached per record). */
function groundTint(rec) {
  if (rec.tint) return rec.tint;
  let id = 0;
  if (sink.getBlock) {
    const bx = Math.floor(rec.x), bz = Math.floor(rec.z);
    for (let by = Math.floor(rec.y + 0.5); by >= Math.floor(rec.y - 3); by--) { const b = sink.getBlock(bx, by, bz); if (isSolidBlock(b)) { id = b; break; } }
  }
  let tint;
  try { tint = blockDustTint(id); } catch { tint = DIRT_DUST; }
  // Kicked-up soil under the top tile: lean the surface colour toward earth (no green fog off a lawn).
  rec.tint = tint.map((c, i) => c * 0.4 + DIRT_DUST[i] * 0.6);
  rec.soil = DIRT_SOIL;
  tint = rec.tint;
  return tint;
}

/** The titanfall impact blast style (ExplosionFX): white-hot contact flash, light and a wide scorch. */
export const TITANFALL_IMPACT_BLAST = Object.freeze({
  color: 0xfff1d6, grow: 0.42, life: 0.5, ring: false, flash: 3.2, flashLife: 0.12,
  // No fireball or smoke ball: the drop's own dust (ParticleField) carries the cloud.
  fire: null, smoke: null,
  light: Object.freeze({ color: 0xffd9a8, range: 30, intensity: 34, life: 0.5 }),
  scorch: 7.2,
});

function slam(rec, self) {
  if (rec.impacted) return;
  rec.impacted = true;
  rec.impactAge = 0;
  self = !!self || rec.self;
  rec.selfImpact = self;
  const item = rec.item, rig = rec.rig;
  if (item?.root) { item.root.position.set(rec.x, rec.y, rec.z); item.root.rotation.x = 0; }
  // The landing pose is already well in on the touchdown frame: never a hanging-legs frame on the ground.
  const pose = item?.model?.rig;
  if (pose && Number.isFinite(pose.hero)) pose.hero = Math.max(pose.hero, D.heroSnap);
  // The marker beam goes out in a white flash.
  rec.endBeam?.();
  rec.endBeam = null;
  if (rig) {
    rig.fall.removeFromParent();
    rig.fall.visible = false;
    for (const m of [rig.dust, rig.wall, rig.pressure]) m.visible = true;
    const tint = groundTint(rec);
    rig.dust.material.uniforms.uColor.value.setRGB(tint[0] * 0.92, tint[1] * 0.9, tint[2] * 0.88);
    rig.wall.material.uniforms.uColor.value.setRGB(tint[0] * 0.85, tint[1] * 0.83, tint[2] * 0.8);
    rig.pressure.material.uniforms.uColor.value.setRGB(1.5, 1.45, 1.35);
    for (const m of [rig.dust, rig.wall, rig.pressure]) m.material.uniforms.uSeed.value = rec.seed;
    const color = TEAM_FX_COLORS[rec.team] || TEAM_FX_COLORS.neutral;
    setStreak(rig.flash.material, [4.2, 4.2, 4.2], [color[0] * 2.4, color[1] * 2.4, color[2] * 2.4], 1, clock.local, 4);
    rig.flash.visible = true;
    rig.ground.position.set(rec.x, rec.y, rec.z);
    if (!rig.ground.parent && sink.scene) sink.scene.add(rig.ground);
  }
  const x = rec.x, y = rec.y, z = rec.z, fx = sink.fx, tint = groundTint(rec);
  // Flash, light, smoke and the scorch.
  const e = eye();
  sink.explosions?.spawn?.(x, y + 0.9, z, TITANFALL_IMPACT_BLAST, 9, e);
  if (fx) {
    // The instant burst: a dense cloud thrown out of the footprint before the front gets going.
    fx.emit('dust', [x, y + 0.8, z], { count: 34, dir: [0, 0.35, 0], speed: 5, spread: Math.PI * 0.48, scale: 4.6, life: 1.5, alpha: 1.7,
      color0: tint, color1: tint, ground: y });
    // Dust front: two speed layers of puffs riding out along the ground (reach ≈ speed / drag).
    for (let i = 0; i < 56; i++) {
      const a = (i + Math.random() * 0.6) / 56 * TAU, s = Math.sin(a), c = Math.cos(a);
      fx.emit('dust', [x + s * 2.6, y + 0.6, z + c * 2.6], { count: 1, dir: [s, 0.05, c], speed: 20 + Math.random() * 7, spread: 0.1, scale: 3.6,
        life: 2.2, alpha: 1.5, color0: tint, color1: tint, ground: y });
      fx.emit('dust', [x + s * 2.2, y + 1.0, z + c * 2.2], { count: 1, dir: [s, 0.34, c], speed: 10 + Math.random() * 4, spread: 0.2, scale: 5.4,
        life: 2.8, alpha: 1.25, color0: tint, color1: tint, ground: y });
    }
    // The column over the impact and the low cloud that settles.
    fx.emit('dust', [x, y + 1.2, z], { count: 24, dir: [0, 1, 0], speed: 9, spread: 0.7, scale: 4.8, life: 2.6, alpha: 1.1, color0: tint, color1: tint, ground: y });
    fx.emit('dust', [x, y + 1.5, z], { count: 16, dir: [0, 1, 0], speed: 15, spread: 0.32, scale: 4, life: 2.2, alpha: 1.2, color0: tint, color1: tint, ground: y });
    // A slow plume that hangs over the spot and drifts up while the ground cloud settles.
    fx.emit('smokeColumn', [x, y + 2, z], { count: 6, dir: [0, 1, 0], speed: 1.6, spread: 0.6, scale: 0.9, life: 0.55, alpha: 0.55,
      color0: tint, color1: tint });
    fx.emit('dust', [x, y + 0.6, z], { count: 16, dir: [0, 0.3, 0], speed: 4, spread: Math.PI * 0.5, scale: 5.5, life: 3, alpha: 0.9, color0: tint, color1: tint, ground: y });
    // Chips, grit and sparks off the armour.
    fx.emit('debris', [x, y + 0.5, z], { count: 46, dir: [0, 1, 0], speed: 1.5, spread: 1.05, scale: 3.2, ground: y,
      color0: tint.map(c => c * 0.62), color1: tint.map(c => c * 0.5) });
    fx.emit('grit', [x, y + 0.4, z], { count: 30, dir: [0, 1, 0], speed: 7, spread: 1.1, ground: y });
    fx.emit('spark', [x, y + 0.6, z], { count: 34, dir: [0, 1, 0], speed: 1.1, spread: 1.25 });
    fx.emit('fire', [x, y + 0.5, z], { count: 5, speed: 2.5, dir: [0, 0.2, 0], spread: 1.4, scale: 3.2, life: 0.16, alpha: 0.7, color0: [2.4, 1.9, 1.3], color1: [1.6, 0.7, 0.2] });
    // The dust that hangs on for a few seconds and settles.
    rec.linger = fx.addEmitter?.({ kind: 'dust', pos: lingerPos(rec), rate: 14, until: D.dustLinger,
      params: { speed: 0.9, scale: 4.2, life: 2.2, alpha: 0.5, dir: [0, 0.25, 0], spread: 1.2, color0: tint, color1: tint, ground: y } }) ?? null;
  }
  // Voxel chunks in the ground's colour (darker, varied).
  for (let i = 0; i < D.chunks; i++) {
    const a = Math.random() * TAU, out = 3 + Math.random() * 8.5, up = 9 + Math.random() * 11;
    const r0 = 1.2 + Math.random() * 2;
    const k = 0.75 + Math.random() * 0.35, src = Math.random() < 0.6 ? DIRT_SOIL : tint, m = src === tint ? 0.62 : 1;
    _c.setRGB(src[0] * k * m, src[1] * k * m, src[2] * k * m);
    spawnChunk(x + Math.sin(a) * r0, y + 0.4 + Math.random() * 0.6, z + Math.cos(a) * r0, Math.sin(a) * out, up, Math.cos(a) * out,
      0.22 + Math.random() * Math.random() * 0.55, _c);
  }
  if (chunk.mesh && sink.scene && chunk.mesh.parent !== sink.scene) sink.scene.add(chunk.mesh);
  // Shake every viewer by distance, punch the FOV close in.
  const d = distanceTo(x, y + 1.6, z);
  const trauma = self ? Math.max(dropShakeTrauma(d), 0.85) : dropShakeTrauma(d);
  rec.trauma = trauma;
  if (trauma > 0) sink.shake?.add?.(trauma);
  const punch = dropFovPunch(d);
  const cam = sink.camera;
  if (punch > 0 && cam?.isPerspectiveCamera) { cam.fov += punch; cam.updateProjectionMatrix(); }
  rec.steam.length = 0;
  rec.steam.push(D.steamDelay, D.steamDelay + 0.55);
  impactSound(rec, d);
}

/** A position source for the settling-dust emitter: walks a sunflower spiral around the impact (one array). */
function lingerPos(rec) {
  const out = [rec.x, rec.y + 0.6, rec.z];
  let n = 0;
  return () => {
    n++;
    const a = n * 2.399, r = 2 + (n * 3.7) % 9;
    out[0] = rec.x + Math.sin(a) * r; out[1] = rec.y + 0.6; out[2] = rec.z + Math.cos(a) * r;
    return out;
  };
}

function aftermath(rec, step) {
  rec.impactAge += step;
  const t = rec.impactAge, rig = rec.rig;
  if (rig) {
    // The beam's white flash: a column that thins and fades.
    const kf = clamp01(t / D.beamFlash);
    rig.flash.visible = kf < 1;
    if (rig.flash.visible) {
      const r = 0.95 * (1 - 0.6 * kf);
      rig.flash.scale.set(r, 140 * (1 - 0.3 * kf), r);
      rig.flash.material.uniforms.uOpacity.value = 1.4 * (1 - kf) ** 2.5;
    }
    // Countdown ring flashes out.
    const mu = rig.marker.material.uniforms;
    mu.uProgress.value = 1;
    mu.uOpacity.value = Math.max(0, 1 - t / 0.14) * 1.4;
    rig.marker.visible = mu.uOpacity.value > 0;
    // Dust ring along the ground and the rolling wall.
    const k = clamp01(t / D.waveSeconds), ease = 1 - (1 - k) ** 3;
    const radius = 1.5 + (D.waveRadius - 1.5) * ease;
    const du = rig.dust.material.uniforms;
    rig.dust.scale.setScalar(radius + 4);
    du.uSize.value = radius + 4; du.uRadius.value = radius; du.uWidth.value = 2 + 6 * ease; du.uTime.value = t;
    du.uOpacity.value = 0.85 * (1 - smooth(k)) * Math.min(1, t / 0.04);
    rig.dust.visible = du.uOpacity.value > 0.003;
    const wu = rig.wall.material.uniforms;
    rig.wall.scale.set(radius * 0.94, 1.6 + 3.4 * ease, radius * 0.94);
    wu.uTime.value = t;
    wu.uOpacity.value = 1.15 * (1 - k) ** 1.1 * Math.min(1, t / 0.05);
    rig.wall.visible = wu.uOpacity.value > 0.003;
    // The white-hot pressure front, fast and short.
    const kp = clamp01(t / D.pressureSeconds), pr = 1 + (D.pressureRadius - 1) * (1 - (1 - kp) ** 2);
    const pu = rig.pressure.material.uniforms;
    rig.pressure.scale.setScalar(pr + 2);
    pu.uSize.value = pr + 2; pu.uRadius.value = pr; pu.uWidth.value = 0.9; pu.uTime.value = t;
    // A flat ring: it reads from above (cockpits, roofs) and turns into a hard line at eye height, so it fades there.
    const e = eye(), dist = e ? Math.hypot(e.x - rec.x, e.y - rec.y, e.z - rec.z) : 1;
    const elev = e ? (e.y - rec.y) / Math.max(1, dist) : 0.5;
    pu.uOpacity.value = 0.7 * (1 - kp) ** 2 * smooth(clamp01((elev - 0.08) / 0.25));
    rig.pressure.visible = pu.uOpacity.value > 0.003;
  }
  // Rumble tail on top of the impact jolt.
  if (t < 1.1 && rec.trauma > 0) sink.shake?.add?.(rec.trauma * D.shakeRumble * step * (1 - t / 1.1));
  // Servo steam out of the knees and back vents.
  for (let i = rec.steam.length - 1; i >= 0; i--) {
    if (t >= rec.steam[i]) { steam(rec, i === 0 ? 1 : 0.7); rec.steam.splice(i, 1); }
  }
  if (t > D.linger && !rec.steam.length && !(t < D.waveSeconds)) release(rec);
}

/** Steam puffs: knees and back vents of the landed hull (hull-frame points), plus a hiss. */
function steam(rec, strength = 1) {
  const item = rec.item, fx = sink.fx;
  if (!fx || !item?.model?.group) return;
  const f = titanFrame(item.kind ?? item.row?.type) || { height: 7, hw: 1.4, hl: 1.1 };
  const g = item.model.group;
  g.updateWorldMatrix(true, false);
  const points = [[-f.hw * 0.75, 1.5, -0.4, -1], [f.hw * 0.75, 1.5, -0.4, 1], [-f.hw * 0.6, f.height * 0.62, f.hl * 0.9, -1], [f.hw * 0.6, f.height * 0.62, f.hl * 0.9, 1]];
  for (const [px, py, pz, side] of points) {
    g.localToWorld(_w.set(px, py, pz));
    _v.set(side * 0.9, 0.7, pz > 0 ? 0.6 : -0.3).transformDirection(g.matrixWorld);
    fx.emit('smoke', [_w.x, _w.y, _w.z], { count: Math.round(4 * strength), dir: [_v.x, _v.y, _v.z], speed: 3.2, spread: 0.35, scale: 0.55, life: 0.55,
      alpha: 0.55, color0: [0.92, 0.94, 0.97], color1: [0.8, 0.82, 0.86] });
  }
  steamSound(rec, strength);
}

/** The titan rises out of the hero landing (landed phase ends): one more vent. */
export function rise(item) {
  const rec = drops.get(String(item?.id ?? ''));
  if (rec?.impacted) { steam(rec, 1.2); return true; }
  return false;
}

// ---- synthesized audio (through the TitanSynth engine; silent without a running context) ----
const sounds = { scheduled: 0, impacts: 0, live: [] };
function audioOut(pos, { far = true, dry = false, life = 3, gain = 1, delay = 0 } = {}) {
  const synth = sink.audio?.titan;
  const audio = synth?._engine?.();
  if (!audio) return null;
  const { engine, ctx, v } = audio, now = ctx.currentTime;
  sounds.live = sounds.live.filter(end => end > now);
  if (sounds.live.length >= 8) return null;
  sounds.live.push(now + delay + life);
  const out = ctx.createGain();
  out.gain.value = gain;
  if (dry) out.connect(engine.bus);
  else { const panner = synth._panner(ctx, pos, far); out.connect(panner).connect(engine.bus); }
  setTimeout(() => { try { out.disconnect(); } catch { /* gone */ } }, (delay + life + 0.6) * 1000);
  return { out, ctx, v, engine, t: v.nowT(delay) };
}
/** Noise through a filter whose frequency and gain ramp over [t0, t1] (exponential ramps). */
function sweep(o, { filter = 'bandpass', f0, f1, q = 1, g0 = 0.001, g1, t0, t1, tail = 0.08, rate = 1 }) {
  const { ctx, engine, out } = o;
  const src = ctx.createBufferSource();
  src.buffer = engine.noiseBuffer; src.loop = true; src.playbackRate.value = rate;
  const bq = ctx.createBiquadFilter();
  bq.type = filter; bq.Q.value = q;
  bq.frequency.setValueAtTime(Math.max(30, f0), t0);
  bq.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t1);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(Math.max(0.0001, g0), t0);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, g1), t1);
  gain.gain.exponentialRampToValueAtTime(0.0001, t1 + tail);
  src.connect(bq).connect(gain).connect(out);
  src.start(t0); src.stop(t1 + tail + 0.05);
}
function rampTone(o, { type = 'sine', f0, f1, g0 = 0.001, g1, t0, t1, tail = 0.06 }) {
  const { ctx, out } = o;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(1, f0), t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t1);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(Math.max(0.0001, g0), t0);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, g1), t1);
  gain.gain.exponentialRampToValueAtTime(0.0001, t1 + tail);
  osc.connect(gain).connect(out);
  osc.start(t0); osc.stop(t1 + tail + 0.05);
}

/** Incoming: a rising re-entry roar and whistle that ends at impact. */
function incomingSound(rec, seconds) {
  sounds.scheduled++;
  const o = audioOut([rec.x, rec.y + 30, rec.z], { far: true, life: seconds + 0.2, gain: 0.9 });
  if (!o) return;
  const t0 = o.t, t1 = t0 + Math.max(0.3, seconds - 0.04);
  sweep(o, { filter: 'bandpass', f0: 380, f1: 2100, q: 1.6, g0: 0.004, g1: 0.32, t0, t1, tail: 0.05 });
  sweep(o, { filter: 'lowpass', f0: 140, f1: 520, q: 0.7, g0: 0.01, g1: 0.5, t0, t1, tail: 0.08 });
  rampTone(o, { type: 'triangle', f0: 620, f1: 1450, g0: 0.002, g1: 0.07, t0: t0 + seconds * 0.25, t1, tail: 0.04 });
  rampTone(o, { type: 'sine', f0: 640, f1: 1490, g0: 0.002, g1: 0.05, t0: t0 + seconds * 0.25, t1, tail: 0.04 });
}
/** The braking burn: a blast of jet noise and a low growl. */
function burnSound(rec) {
  const o = audioOut([rec.x, rec.y + 12, rec.z], { far: true, life: 1, gain: 0.8 });
  if (!o) return;
  o.v.hiss(o.out, { t0: o.t, filter: 'highpass', f: 900, sweepTo: 2600, q: 0.6, g: 0.4, att: 0.03, dec: 0.5 });
  o.v.tone(o.out, { t0: o.t, type: 'sawtooth', f0: 58, f1: 92, g: 0.12, att: 0.04, dec: 0.45 });
}
/** Impact: sub boom, crack, armour clang, debris rattle and a rumble tail; sound travels at 343 m/s. */
function impactSound(rec, distance) {
  sounds.impacts++;
  const near = Number.isFinite(distance) ? distance : 60;
  const delay = Math.min(0.6, near / 343);
  const o = audioOut([rec.x, rec.y + 1, rec.z], { far: true, life: 3.2, gain: 1.25, delay });
  if (o) {
    const { out, v, t } = o;
    v.tone(out, { t0: t, type: 'sine', f0: 72, f1: 24, g: 0.95, att: 0.003, dec: 1.6 });
    v.hiss(out, { t0: t, filter: 'lowpass', f: 3400, sweepTo: 240, q: 0.5, g: 0.75, att: 0.002, dec: 0.7 });
    v.tone(out, { t0: t + 0.01, type: 'square', f0: 176, f1: 104, g: 0.09, att: 0.002, dec: 0.28 });
    v.hiss(out, { t0: t + 0.01, filter: 'bandpass', f: 1250, q: 2.2, g: 0.16, att: 0.002, dec: 0.18 });
    v.hiss(out, { t0: t + 0.14, filter: 'bandpass', f: 1900, q: 0.9, sweepTo: 700, g: 0.14, att: 0.04, dec: 1.2, rate: 1.4 });
    v.hiss(out, { t0: t + 0.05, filter: 'lowpass', f: 190, q: 0.6, g: 0.5, att: 0.06, dec: 2.6 });
  }
  // Close in: a dry, low-passed thump in the chest.
  if (near < D.closeRange) {
    const c = audioOut(null, { dry: true, life: 1.2, gain: 0.9 * (1 - near / D.closeRange), delay });
    if (c) {
      c.v.tone(c.out, { t0: c.t, type: 'sine', f0: 48, f1: 20, g: 1, att: 0.002, dec: 0.9 });
      c.v.hiss(c.out, { t0: c.t, filter: 'lowpass', f: 260, sweepTo: 90, q: 0.8, g: 0.6, att: 0.002, dec: 0.6 });
    }
  }
}
/** Servo steam hiss. */
function steamSound(rec, strength) {
  const o = audioOut([rec.x, rec.y + 3, rec.z], { far: false, life: 0.9, gain: 0.55 * strength });
  if (!o) return;
  o.v.hiss(o.out, { t0: o.t, filter: 'highpass', f: 3200, sweepTo: 1800, q: 0.7, g: 0.3, att: 0.02, dec: 0.6 });
  o.v.hiss(o.out, { t0: o.t, filter: 'bandpass', f: 5200, q: 1.5, g: 0.12, att: 0.01, dec: 0.4 });
}

// ---- lifecycle -----------------------------------------------------------------------------
/** Drop every live drop (leave the match, capture reset); pooled rigs keep their materials. */
export function clear() {
  for (const rec of [...drops.values()]) {
    if (rec.linger) sink.fx?.removeEmitter?.(rec.linger);
    release(rec);
  }
  chunk.alive.fill(0);
  if (chunk.mesh) { chunk.mesh.count = 0; chunk.mesh.visible = false; chunk.mesh.removeFromParent(); }
}
/** Free the pooled GPU resources (titanfall-client dispose → releaseCaches). */
export function releasePools() {
  clear();
  for (const rig of rigPool.splice(0)) disposeRig(rig);
  if (chunk.mesh) { chunk.mesh.material.dispose(); chunk.mesh.dispose(); chunk.mesh = null; }
}

/** Live counts (tests and the capture page). */
export function stats() {
  let falling = 0, impacted = 0;
  for (const rec of drops.values()) rec.impacted ? impacted++ : falling++;
  return { drops: drops.size, falling, impacted, chunks: chunk.n, rigsPooled: rigPool.length, sounds: sounds.scheduled, impacts: sounds.impacts };
}
/** One drop's presented state (tests, capture labels). */
export function inspect(vehicleId) {
  const rec = drops.get(String(vehicleId));
  if (!rec) return null;
  return { lift: rec.lift, tau: tauOf(rec), impacted: rec.impacted, impactAge: rec.impactAge, trauma: rec.trauma ?? 0,
    fallVisible: !!rec.rig?.fall.visible, markerVisible: !!rec.rig?.marker.visible };
}
