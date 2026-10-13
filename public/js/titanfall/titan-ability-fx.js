// Titan ability visuals (docs/titanfall.md §7.3; WP5). Generic, from the
// authoritative vehicle row only: `tw[4]` ability bits (core, defensive, hover,
// phased, smoke), the mount row's charge field and the titanfall drop event.
// No gameplay: every effect is presentation of state the server already sent.
//
//   defensive  ION Vortex dome, SCORCH Thermal Shield fire wall, RONIN Sword Block
//              parry field, LEGION Gun Shield energy plate, NORTHSTAR tether flash
//   hover      blue thruster plumes from the model's thruster anchors, rotor-like ground dust
//   phased     afterimage ghosts of the hull (Phase Dash)
//   core       energy aura on every titan plus a kit layer (ION Laser Core beam, SCORCH
//              Flame Core ground fan, RONIN blade sparks, LEGION muzzle glow)
//   smoke      electric smoke cloud with arcing sparks
//   charge     NORTHSTAR railgun muzzle glow from mount field 6 (charge100)
//   drop       the titanfall marker beam and ground ring (titanfall_drop event)
//
// Meshes live in the world effects group (`setScene`), posed each frame from the
// presented hull, so the cockpit view and the model budget stay untouched.
import * as THREE from '../vendor/three.module.js';
import { TITAN_ABILITY_BITS as BITS, TITAN_ABILITIES, decodeTitanRow } from '../../../shared/titan-contract.js';
import { isSolidBlock } from '../../../shared/worlddata.js';
import { titanFrame } from '../../../shared/vehicle-handling/titan.js';
import { vehicleDef, vehicleLocalPoint, mountPose } from '../../../shared/vehicle-defs.js';
import { vehicleHullParts, rayHullPartSpan, solidHull } from '../../../shared/vehicle-collision.js';
import { raycastVoxels } from '../../../shared/raycast.js';

/**
 * Server guard volumes (server/sim/titanfall/titan-abilities.js guardSphere / ABILITY_TUNING;
 * the model budget test pins these against the server): the visuals are sized and placed from
 * them, so a round the server catches visibly meets the shield.
 */
export const TITAN_GUARD_SPHERES = Object.freeze({
  thermal: Object.freeze({ ahead: 3, height: 0.45, radius: 3.6 }),
  gunShield: Object.freeze({ ahead: 1.4, radius: 2.0 }),
});

/** Presentation tuning (metres, seconds; no gameplay values). */
export const TITAN_ABILITY_FX = Object.freeze({
  // Vortex: a concave dish whose rim is the server's catch sphere (radius 3.2 m, 2.5 m ahead of
  // the cockpit along the aim), bowl 0.7 m deep toward the titan.
  vortexRadius: TITAN_ABILITIES.titan_ion.defensive.radius, vortexDepth: 0.7, vortexAhead: TITAN_ABILITIES.titan_ion.defensive.forward,
  shieldCap: 1.08,                               // rad, half angle of the Gun Shield's spherical cap
  flameRing: 6,                                  // Flame Core ring of fire round the feet (m)
  wallAhead: 5, wallWidth: 7, wallHeight: 4.6,  // Thermal Shield: burns 5 m in front
  laserRange: 90, laserWidth: 0.5,               // Laser Core: 90 m beam
  beamFollow: 0.15,                              // m, the beam origin's most offset from the server's core anchor
  flameRange: 30, flameLines: 3,                 // Flame Core: 3 lines, 30 m
  smokeRadius: 7,                                // electric smoke
  ghostEvery: 0.06, ghostLife: 0.38, ghostMax: 6,
  beamHeight: 140, beamRadius: 0.55, ringRadius: 3.6, beamFade: 0.35,
  // Art review 2: camera-facing flares instead of glow spheres, a strobing beam start, a curved
  // hex panel for the Gun Shield, lifted flames over ground scorch decals, hover plumes, dash
  // streaks.
  flareRadius: 0.8, beamStrobe: 0.15,
  shieldWidth: 3.0, shieldHeight: 2.4, shieldAhead: 1.4, shieldOpacity: 0.35, shieldEdge: 0.08,
  parryWidth: 2.4, parryHeight: 2.8,
  flameLift: 0.6, scorchOpacity: 0.55, flameSheet: 3.2,
  plumeLength: 2.5, plumeBase: 0.5, hoverDustRing: 4,
  streakLength: 1.8, streakWidth: 0.4, streakLife: 0.3, afterimageLife: 0.25,
});

/**
 * Flame gradient (art review 2): core 0xffc060 → body 0xff6a1a → tip 0x8a1a08 at an additive
 * gain of 1.0 (the review's ceiling is 1.2: brighter puffs stack to yellow-white over grass). `flame()` emits it as two particle layers (core → body low down,
 * body → tip lifted) for every titan fire (Flame Core, Thermal Shield; doom in titan-presentation.js).
 */
export const TITAN_FLAME = Object.freeze({
  core: Object.freeze([1.0, 0.753, 0.376]), body: Object.freeze([1.0, 0.416, 0.102]), tip: Object.freeze([0.541, 0.102, 0.031]),
  gain: 1.0,
});
const flameColor = (key, gain = TITAN_FLAME.gain) => TITAN_FLAME[key].map(c => c * gain);

export const TEAM_FX_COLORS = Object.freeze({
  alpha: Object.freeze([0.22, 0.74, 0.97]),
  bravo: Object.freeze([0.98, 0.57, 0.24]),
  neutral: Object.freeze([0.85, 0.88, 0.9]),
});
const ENERGY = Object.freeze({
  vortex: [0.35, 0.72, 1.6], fire: [1.9, 0.75, 0.18], parry: [0.45, 0.8, 1.7], shield: [1.4, 0.95, 0.35],
  core: { titan_ion: [0.3, 0.75, 1.8], titan_scorch: [1.9, 0.7, 0.2], titan_northstar: [0.35, 1.3, 1.6],
    titan_ronin: [0.4, 0.75, 1.9], titan_legion: [1.7, 1.0, 0.3] },
});
const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

// ---- shared shaders ---------------------------------------------------------------------------

const FRESNEL_VERTEX = /* glsl */ `
varying vec3 vNormal; varying vec3 vView; varying vec3 vLocal; varying vec2 vUv;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vNormal = normalize(mat3(modelMatrix) * normal);
  vView = normalize(cameraPosition - world.xyz);
  vLocal = position; vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;
// Fire wall: soft flickering tongues (8-12 Hz) ramping from a 0xffb347 core to a 0xff5a10 edge,
// torn at the top into a dark 0x2a1a12 smoke veil; colours stay at or below 1 so nothing clips white.
const FIRE_FRAGMENT = /* glsl */ `
uniform vec3 uColor; uniform float uTime; uniform float uOpacity;
varying vec2 vUv;
float h1(float n) { return fract(sin(n) * 43758.5453); }
float n1(float x) { float i = floor(x), f = fract(x); return mix(h1(i), h1(i + 1.0), f * f * (3.0 - 2.0 * f)); }
void main() {
  float x = vUv.x * 14.0, y = vUv.y;
  float flick = n1(x * 1.3 + uTime * 9.0) * 0.5 + n1(x * 2.7 - uTime * 11.0 + y * 5.0) * 0.3 + n1(x * 6.1 + uTime * 13.0 - y * 9.0) * 0.2;
  float top = 0.42 + 0.3 * flick;
  float edges = smoothstep(0.0, 0.06, vUv.x) * smoothstep(1.0, 0.94, vUv.x) * smoothstep(0.0, 0.14, y);
  float flame = smoothstep(top, top - 0.28, y) * edges;
  float heat = flame * smoothstep(top, 0.0, y);
  vec3 core = vec3(1.0, 0.753, 0.376), edge = vec3(1.0, 0.416, 0.102), tip = vec3(0.541, 0.102, 0.031), soot = vec3(0.165, 0.10, 0.07);
  vec3 color = mix(edge, core, smoothstep(0.25, 0.85, heat));
  color = mix(color, tip, smoothstep(top - 0.2, top, y));
  float smoke = smoothstep(top - 0.05, top + 0.15, y) * smoothstep(1.0, 0.7, y) * edges * (0.5 + 0.5 * n1(x * 0.8 - uTime * 1.5 + y * 3.0));
  color = mix(soot, color, flame);
  gl_FragColor = vec4(color, max(flame * 0.9, smoke * 0.32) * uOpacity);
}`;
// Vortex disc: a faint swirling dish with a bright cyan rim.
const VORTEX_FRAGMENT = /* glsl */ `
uniform vec3 uColor; uniform float uTime; uniform float uOpacity; uniform float uRim; uniform float uBands;
varying vec3 vNormal; varying vec3 vView; varying vec3 vLocal; varying vec2 vUv;
void main() {
  float r = length(vLocal.xy) / uRim;
  float rim = smoothstep(0.9, 0.965, r) * (1.0 - smoothstep(0.985, 1.0, r));
  float a = atan(vLocal.y, vLocal.x);
  float swirl = 0.5 + 0.5 * sin(a * 3.0 + r * 9.0 - uTime * 3.2);
  float face = 0.15 * (0.55 + 0.45 * swirl) * (0.6 + 0.4 * r);
  gl_FragColor = vec4(mix(uColor, vec3(1.6, 2.2, 2.4), rim) * (0.7 + 0.6 * rim), (face + rim * 0.95) * uOpacity);
}`;
// Laser Core beam: one quad across the beam (u -1..1 over 2 m): a white 0.35 m core, a cyan
// 1 m body at 0.6 and a 2 m haze at 0.15, with noise scrolling along it at 6 m/s.
const BEAM_FRAGMENT = /* glsl */ `
uniform float uTime; uniform float uOpacity; uniform float uLength;
varying vec2 vUv;
float h1(float n) { return fract(sin(n) * 43758.5453); }
float n1(float x) { float i = floor(x), f = fract(x); return mix(h1(i), h1(i + 1.0), f * f * (3.0 - 2.0 * f)); }
void main() {
  float u = abs(vUv.x * 2.0 - 1.0), along = vUv.y * uLength;
  float noise = 0.75 + 0.25 * n1(along * 0.9 - uTime * 6.0) + 0.1 * n1(along * 3.7 - uTime * 14.0);
  // (art review 2: a 0.3 m white core in a 1.2 m cyan sheath, dimming along its length)
  float core = 1.0 - smoothstep(0.11, 0.15, u);
  float body = 1.0 - smoothstep(0.42, 0.6, u);
  float haze = 1.0 - smoothstep(0.6, 1.0, u);
  vec3 color = vec3(0.23, 0.82, 1.0) * (body * 0.6 * noise + haze * 0.1) + vec3(1.0) * core * 0.95;
  float fade = smoothstep(0.0, 0.6, along) * (1.0 - smoothstep(uLength - 0.8, uLength, along));
  float falloff = mix(1.0, 0.45, clamp(along / max(uLength, 1.0), 0.0, 1.0));
  gl_FragColor = vec4(color * fade * falloff * uOpacity, 1.0);
}`;
// Flare: a camera-facing additive quad (no geometric rim): soft glow, white core, faint streak.
const FLARE_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * length(vec3(modelMatrix[0].x, modelMatrix[0].y, modelMatrix[0].z));
  gl_Position = projectionMatrix * mv;
}`;
const FLARE_FRAGMENT = /* glsl */ `
uniform vec3 uColor; uniform float uOpacity;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float glow = pow(max(0.0, 1.0 - r), 2.4);
  float core = pow(max(0.0, 1.0 - r * 2.6), 2.0);
  float streak = max(0.0, 1.0 - abs(p.y) * 14.0) * max(0.0, 1.0 - abs(p.x)) * 0.35;
  gl_FragColor = vec4((uColor * (glow + streak) + vec3(core)) * uOpacity, 1.0);
}`;
// Thruster streak / hover plume: bright at the nozzle (vLocal), fading to the tail; soft edges.
const STREAK_FRAGMENT = /* glsl */ `
uniform vec3 uColor; uniform float uTime; uniform float uOpacity; uniform float uCone;
varying vec3 vNormal; varying vec3 vView; varying vec3 vLocal; varying vec2 vUv;
void main() {
  float t = uCone > 0.5 ? clamp(-vLocal.y, 0.0, 1.0) : clamp(-vLocal.z, 0.0, 1.0);
  float across = uCone > 0.5 ? pow(abs(dot(normalize(vNormal), normalize(vView))), 1.2) : 1.0 - smoothstep(0.2, 1.0, abs(vUv.x * 2.0 - 1.0));
  float flick = 0.85 + 0.15 * sin(uTime * 61.0 + t * 9.0);
  float a = pow(1.0 - t, 1.2) * (0.35 + 0.65 * across) * flick;
  vec3 color = mix(vec3(1.4), uColor * 1.8, smoothstep(0.0, 0.3, t));
  gl_FragColor = vec4(color * a * uOpacity, 1.0);
}`;
// Gun Shield / parry field: a curved panel with hex cells, a fresnel rim, a team tint at
// `uOpacity` and a bright `uEdge` m border (normal blending).
const SHIELD_FRAGMENT = /* glsl */ `
uniform vec3 uColor; uniform float uTime; uniform float uOpacity; uniform vec2 uSize; uniform float uHex; uniform float uEdge; uniform float uRound;
varying vec3 vNormal; varying vec3 vView; varying vec3 vLocal; varying vec2 vUv;
float hexDist(vec2 p) { p = abs(p); return max(dot(p, vec2(0.5, 0.866)), p.x); }
void main() {
  vec2 m = vUv * uSize;
  // uRound: a round cap (uv planar over its disc), the edge at the rim; else the panel's rectangle.
  float edgeD = uRound > 0.5 ? (0.5 - length(vUv - 0.5)) * uSize.x : min(min(m.x, uSize.x - m.x), min(m.y, uSize.y - m.y));
  float edge = 1.0 - smoothstep(uEdge * 0.75, uEdge * 1.25, edgeD);
  vec2 q = m / 0.3, r = vec2(1.0, 1.732), h = r * 0.5;
  vec2 a = mod(q, r) - h, b = mod(q - h, r) - h;
  vec2 g = dot(a, a) < dot(b, b) ? a : b;
  float cell = smoothstep(0.4, 0.48, hexDist(g)) * uHex;
  float facing = abs(dot(normalize(vNormal), normalize(vView)));
  float rim = pow(1.0 - facing, 2.0);
  float scan = 0.5 + 0.5 * sin(m.y * 5.0 - uTime * 3.0);
  float alpha = uOpacity * (0.8 + 0.2 * scan) + cell * 0.22 + rim * 0.3 + edge * 0.85;
  vec3 color = mix(uColor, vec3(1.0), clamp(edge * 0.65 + cell * 0.35, 0.0, 1.0));
  gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
}`;

function vortexMaterial(color) {
  return new THREE.ShaderMaterial({
    name: 'titan-vortex-fx',
    uniforms: { uColor: { value: new THREE.Color(...color) }, uTime: { value: 0 }, uOpacity: { value: 1 },
      uRim: { value: TITAN_ABILITY_FX.vortexRadius }, uBands: { value: 0 } },
    vertexShader: FRESNEL_VERTEX, fragmentShader: VORTEX_FRAGMENT,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
  });
}
function beamMaterial() {
  return new THREE.ShaderMaterial({
    name: 'titan-laser-beam-fx',
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 1 }, uLength: { value: 10 } },
    vertexShader: FRESNEL_VERTEX, fragmentShader: BEAM_FRAGMENT,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
  });
}
function fireMaterial() {
  return new THREE.ShaderMaterial({
    name: 'titan-fire-wall-fx',
    uniforms: { uColor: { value: new THREE.Color(...ENERGY.fire) }, uTime: { value: 0 }, uOpacity: { value: 1 } },
    vertexShader: FRESNEL_VERTEX, fragmentShader: FIRE_FRAGMENT,
    // Normal blending: an additive orange sheet over grass reads acid green.
    transparent: true, depthWrite: false, blending: THREE.NormalBlending, side: THREE.DoubleSide, toneMapped: false,
  });
}
function flareMaterial(color, opacity = 1) {
  return new THREE.ShaderMaterial({
    name: 'titan-flare-fx',
    uniforms: { uColor: { value: new THREE.Color(...color) }, uOpacity: { value: opacity } },
    vertexShader: FLARE_VERTEX, fragmentShader: FLARE_FRAGMENT,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  });
}
function streakMaterial(color, cone = false) {
  return new THREE.ShaderMaterial({
    name: cone ? 'titan-plume-fx' : 'titan-streak-fx',
    uniforms: { uColor: { value: new THREE.Color(...color) }, uTime: { value: 0 }, uOpacity: { value: 1 }, uCone: { value: cone ? 1 : 0 } },
    vertexShader: FRESNEL_VERTEX, fragmentShader: STREAK_FRAGMENT,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
  });
}
function shieldMaterial(color, { width, height, hex = 1, opacity = TITAN_ABILITY_FX.shieldOpacity, round = false } = {}) {
  return new THREE.ShaderMaterial({
    name: 'titan-shield-fx',
    uniforms: { uColor: { value: new THREE.Color(...color) }, uTime: { value: 0 }, uOpacity: { value: opacity },
      uSize: { value: new THREE.Vector2(width, height) }, uHex: { value: hex }, uEdge: { value: TITAN_ABILITY_FX.shieldEdge },
      uRound: { value: round ? 1 : 0 } },
    vertexShader: FRESNEL_VERTEX, fragmentShader: SHIELD_FRAGMENT,
    transparent: true, depthWrite: false, blending: THREE.NormalBlending, side: THREE.DoubleSide, toneMapped: false,
  });
}
/** Ground scorch under fire (normal blending, pulled toward the camera so it never z-fights). */
function scorchMaterial() {
  return new THREE.MeshBasicMaterial({ name: 'titan-scorch-decal', color: 0x15110d, transparent: true, opacity: TITAN_ABILITY_FX.scorchOpacity,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
}
/** A flat arc band (XZ plane) from angle a0 to a1 (x = sin, z = cos), radii r0..r1. */
function arcStrip(a0, a1, r0, r1, n = 24) {
  const pos = [], uv = [], index = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * i / n, s = Math.sin(a), c = Math.cos(a);
    pos.push(s * r0, 0, c * r0, s * r1, 0, c * r1);
    uv.push(i / n, 0, i / n, 1);
    if (i < n) index.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}
function glowMaterial(color, opacity = 0.6) {
  return new THREE.MeshBasicMaterial({ name: 'titan-glow-fx', color: new THREE.Color(...color), transparent: true, opacity,
    depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
}

/** Two plane geometries in one (positions, uvs, index). */
function mergeQuads(a, b) {
  const out = new THREE.BufferGeometry();
  const pa = a.attributes.position.array, pb = b.attributes.position.array;
  const ua = a.attributes.uv.array, ub = b.attributes.uv.array;
  out.setAttribute('position', new THREE.Float32BufferAttribute([...pa, ...pb], 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute([...a.attributes.normal.array, ...b.attributes.normal.array], 3));
  // v runs along the beam (0 at the emitter, 1 at the far end): the plane's +y became −z.
  out.setAttribute('uv', new THREE.Float32BufferAttribute([...ua, ...ub], 2));
  const ia = Array.from(a.index.array), n = pa.length / 3;
  out.setIndex([...ia, ...Array.from(b.index.array).map(i => i + n)]);
  return out;
}

let geometries = null;
/** Shared unit geometries, built on first use and never disposed (module lifetime). */
function shapes() {
  if (geometries) return geometries;
  const wall = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true, Math.PI * 0.62, Math.PI * 0.76);
  wall.translate(0, 0.5, 0);
  const beam = new THREE.CylinderGeometry(1, 1, 1, 14, 1, true);
  beam.translate(0, 0.5, 0);
  const lance = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
  lance.translate(0, 0.5, 0); lance.rotateX(-Math.PI / 2);   // along −Z, from the origin
  const ring = new THREE.RingGeometry(0.82, 1, 40);
  ring.rotateX(-Math.PI / 2);
  const disc = new THREE.CircleGeometry(1, 32);
  const panel = new THREE.PlaneGeometry(1, 1, 1, 1);
  // Vortex dish: a shallow spherical cap (3.6 m across, 0.4 m deep) in the XY plane, bowl toward +Z
  // (the catching face looks along −Z, the aim), rim at z = 0.
  const R = TITAN_ABILITY_FX.vortexRadius, D = TITAN_ABILITY_FX.vortexDepth, sphere = (R * R + D * D) / (2 * D);
  const dish = new THREE.SphereGeometry(sphere, 48, 6, 0, Math.PI * 2, 0, Math.asin(R / sphere));
  dish.rotateX(-Math.PI / 2); dish.translate(0, 0, sphere - D); dish.scale(1, 1, -1);
  // Laser beam: two crossed quads along −Z from the origin, unit length (scaled), 2 m wide.
  const strip = new THREE.PlaneGeometry(2, 1, 1, 1);
  strip.rotateX(-Math.PI / 2); strip.translate(0, 0, -0.5);
  const strip2 = strip.clone(); strip2.rotateZ(Math.PI / 2);
  const ray = mergeQuads(strip, strip2);
  // Flare quad (2 × 2, scaled to the radius); the shield panel (an arc of a 3 m radius cylinder,
  // 3.0 m wide, unit height, centred on the origin and bulging toward −Z); the hover plume (open
  // cone, base at the origin, tip at y = −1); ground decals: a 1 m strip along −Z and the wall arc.
  const flare = new THREE.PlaneGeometry(2, 2);
  const RC = 3, span = TITAN_ABILITY_FX.shieldWidth / RC;
  const shield = new THREE.CylinderGeometry(RC, RC, 1, 20, 1, true, Math.PI - span / 2, span);
  shield.translate(0, 0, RC);
  const plume = new THREE.ConeGeometry(1, 1, 16, 1, true);
  plume.rotateX(Math.PI); plume.translate(0, -0.5, 0);
  const decal = new THREE.PlaneGeometry(1, 1);
  decal.rotateX(-Math.PI / 2); decal.translate(0, 0, -0.5);
  const wallScorch = arcStrip(Math.PI * 0.62, Math.PI * 1.38, 0.86, 1.1);
  // Flame Core fire sheets (normal-blended fire shader, as the Thermal Shield wall): a full ring
  // (unit radius and height) and a vertical strip along −Z (unit length and height).
  const fireRing = new THREE.CylinderGeometry(1, 1, 1, 48, 1, true);
  fireRing.translate(0, 0.5, 0);
  const fireLine = new THREE.PlaneGeometry(1, 1);
  fireLine.translate(0, 0.5, 0); fireLine.rotateY(Math.PI / 2); fireLine.translate(0, 0, -0.5);
  // Gun Shield: the front cap of a unit sphere around −Z (half angle `shieldCap`), uv planar over
  // its disc so the hex cells stay round and the shader's round edge sits on the rim.
  const capAngle = TITAN_ABILITY_FX.shieldCap;
  const cap = new THREE.SphereGeometry(1, 36, 12, 0, Math.PI * 2, 0, capAngle);
  cap.rotateX(-Math.PI / 2);
  {
    const p = cap.attributes.position, uv = cap.attributes.uv, span = 2 * Math.sin(capAngle);
    for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / span + 0.5, p.getY(i) / span + 0.5);
  }
  geometries = { wall, beam, lance, ring, disc, panel, dish, ray, flare, shield, plume, decal, wallScorch, fireRing, fireLine, cap };
  return geometries;
}

// ---- module state -----------------------------------------------------------------------------

const sink = { scene: null, fx: null, getBlock: null, view: null };
const states = new Map();      // item -> per-hull effect state
const beams = new Set();       // titanfall marker beams
const ghosts = new Set();      // phase afterimages
const streaks = new Set();     // dash thruster streaks
let clock = 0;
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _u = new THREE.Vector3();
const _m = new THREE.Matrix4();

/**
 * World sinks: the effects group (meshes), the particle field, the voxel probe and the
 * VehicleView (other hulls for the Laser Core's aim ray).
 */
export function setSinks({ scene = null, fx = null, getBlock = null, view = null } = {}) {
  sink.view = view || null;
  if (scene !== sink.scene) clear();
  sink.scene = scene || null;
  // The hidden warm-up meshes ride the effects group, so the loading screen's shader warm-up
  // (main.js warmShaders, after titanfall init) links every FX program.
  if (sink.scene) sink.scene.add(warmupRoot());
  else warmup?.removeFromParent();
  sink.fx = fx || null;
  sink.getBlock = typeof getBlock === 'function' ? getBlock : null;
}

function add(mesh, parent) {
  mesh.castShadow = false; mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  parent.add(mesh);
  return mesh;
}

function stateFor(item) {
  let state = states.get(item);
  if (state || !sink.scene) return state || null;
  const group = new THREE.Group();
  group.name = `titan-ability-fx-${item.id ?? item.kind}`;
  sink.scene.add(group);
  state = { item, group, parts: {}, carry: {}, ghostT: 0, t: 0, bits: 0, materials: [] };
  states.set(item, state);
  return state;
}

function material(state, make) { const m = make(); state.materials.push(m); return m; }

function drop(state) {
  for (const mesh of Object.values(state.parts)) mesh.removeFromParent();
  state.group.removeFromParent();
  for (const m of state.materials) m.dispose();
  states.delete(state.item);
}

/** Particles per second as whole emissions (fractional carry per key). */
function rate(state, key, perSecond, dt) {
  state.carry[key] = (state.carry[key] || 0) + perSecond * dt;
  const n = Math.floor(state.carry[key]);
  state.carry[key] -= n;
  return n;
}

const emit = (kind, pos, params) => sink.fx?.emit?.(kind, pos, params);

/**
 * One fire puff in the TITAN_FLAME gradient: core → body at `pos`, every third puff a smaller
 * body → tip lick 0.5 m higher.
 */
function flame(pos, i, { speed = 1.6, scale = 2, life = 1.2, alpha = 0.55 } = {}) {
  if (i % 3 === 2) {
    emit('fire', [pos[0], pos[1] + 0.5, pos[2]], { count: 1, dir: [0, 1, 0], speed, scale: scale * 0.7, life: life * 0.8, alpha,
      color0: flameColor('body'), color1: flameColor('tip') });
  } else {
    emit('fire', pos, { count: 1, dir: [0, 1, 0], speed, scale, life, alpha, color0: flameColor('core'), color1: flameColor('body') });
  }
}

/** Ground height under (x, z) near y (voxel probe), else y. */
function groundAt(x, y, z) {
  if (!sink.getBlock) return y;
  const bx = Math.floor(x), bz = Math.floor(z);
  for (let by = Math.floor(y + 1); by >= Math.floor(y - 12); by--) if (isSolidBlock(sink.getBlock(bx, by, bz))) return by + 1;
  return y;
}

/** First solid voxel along a ray (0.4 m steps), or `max`. */
function rayLength(o, d, max) {
  if (!sink.getBlock) return max;
  for (let t = 1; t < max; t += 0.4) {
    if (isSolidBlock(sink.getBlock(Math.floor(o[0] + d[0] * t), Math.floor(o[1] + d[1] * t), Math.floor(o[2] + d[2] * t)))) return t;
  }
  return max;
}

// ---- per-hull effects -------------------------------------------------------------------------

/** The torso frame (pose of the group) relative to the hull skeleton's waist. */
function poseGroup(state, model) {
  const torso = model.torso || model.body;
  torso.updateWorldMatrix(true, false);
  torso.matrixWorld.decompose(_v, _q, _s);
  state.group.position.copy(_v);
  state.group.quaternion.copy(_q);
  state.group.updateMatrixWorld(true);
}

/** A hull-skeleton point (hull metres) in the torso-posed group's frame. */
const local = (skel, p) => [p[0] - skel.waist[0], p[1] - skel.waist[1], p[2] - skel.waist[2]];

function part(state, key, build) {
  let mesh = state.parts[key];
  if (!mesh) { mesh = state.parts[key] = build(); }
  mesh.visible = true;
  return mesh;
}

function hide(state, keep) {
  for (const [key, mesh] of Object.entries(state.parts)) if (!keep.has(key)) mesh.visible = false;
}

/** World aim direction of the primary mount from the row (yaw, pitch), else the hull forward. */
function aimDir(item, row) {
  const aim = Array.isArray(row?.mounts?.[0]) ? row.mounts[0] : null;
  const yaw = aim ? finite(aim[0]) : item.root.rotation.y, pitch = aim ? finite(aim[1]) : 0;
  return [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
}

/** The row at the presented hull pose (what the server's helpers take as the vehicle). */
export function presentedRow(item, row = item?.row) {
  const r = item?.root;
  return r ? { ...row, type: item.kind ?? row?.type, x: r.position.x, y: r.position.y, z: r.position.z, yaw: r.rotation.y, pitch: 0, roll: 0 } : row;
}
function primaryPose(row) {
  const seat = vehicleDef(row?.type)?.seats?.[0], mount = seat?.mounts?.[0];
  return seat && mount ? mountPose(row, seat.id, mount) : null;
}
/**
 * Client copy of the server's guardSphere (titan-abilities.js) at the presented hull pose:
 * [cx, cy, cz, r] of the Vortex ('vortex'), Thermal Shield ('thermal') or Gun Shield ('gunShield').
 */
export function guardSphere(item, row, kind) {
  const v = presentedRow(item, row), f = titanFrame(v?.type);
  if (!f) return null;
  const dir = aimDir(item, row), add = (p, t) => [p[0] + dir[0] * t, p[1] + dir[1] * t, p[2] + dir[2] * t];
  if (kind === 'vortex') {
    const guard = TITAN_ABILITIES.titan_ion.defensive;
    return [...add(vehicleLocalPoint(v, 0, f.eye, -f.hl * 0.55), guard.forward), guard.radius];
  }
  if (kind === 'thermal') {
    const T = TITAN_GUARD_SPHERES.thermal;
    return [...vehicleLocalPoint(v, 0, f.height * T.height, -T.ahead), T.radius];
  }
  if (kind === 'gunShield') {
    const T = TITAN_GUARD_SPHERES.gunShield, origin = primaryPose(v)?.origin ?? vehicleLocalPoint(v, 0, f.height * 0.6, -f.hl);
    return [...add(origin, T.ahead), T.radius];
  }
  return null;
}
/**
 * Client copy of the server's anchorAim (titan-abilities.js): the primary's aim ray from its
 * muzzle (mountPose) to the first voxel or other hull within `range`; returns that point (the
 * Laser Core beam is aimed from its anchor at it) and whether the ray hit something.
 */
export function anchorAimPoint(item, row, range) {
  const v = presentedRow(item, row), f = titanFrame(v?.type), dir = aimDir(item, row);
  const eye = primaryPose(v)?.origin ?? (f ? vehicleLocalPoint(v, 0, f.eye, -f.hl * 0.55) : [v.x, v.y + 4, v.z]);
  let reach = range, hit = false;
  if (sink.getBlock) {
    const voxel = raycastVoxels((x, y, z) => isSolidBlock(sink.getBlock(Math.floor(x), Math.floor(y), Math.floor(z))), ...eye, ...dir, range);
    if (voxel && voxel.t < reach) { reach = voxel.t; hit = true; }
  }
  for (const other of sink.view?.items?.values?.() ?? []) {
    if (other === item || !other.row || !other.root) continue;
    const r = presentedRow(other);
    if (!solidHull(r)) continue;
    for (const part of vehicleHullParts(r)) {
      const span = rayHullPartSpan(part, eye, dir, reach);
      if (span && span.near < reach) { reach = span.near; hit = true; }
    }
  }
  const t = Math.max(4, reach);
  return { point: [eye[0] + dir[0] * t, eye[1] + dir[1] * t, eye[2] + dir[2] * t], hit, eye };
}

function defensive(state, type, skel, t, keep, item, row) {
  const S = shapes();
  if (type === 'titan_ion') {
    // Vortex Shield: a concave dish facing the aim whose rim is the server's catch sphere
    // (guardSphere: 3.2 m round, 2.5 m ahead of the cockpit point), so a flank round the server
    // catches ends on the dish's rim and a frontal one on its face; the raised left palm sits
    // behind it.
    const dir = aimDir(item, row);
    const sphere = guardSphere(item, row, 'vortex');
    const dish = part(state, 'vortex', () => {
      const mesh = add(new THREE.Mesh(S.dish, material(state, () => vortexMaterial(ENERGY.vortex))), sink.scene);
      return mesh;
    });
    if (sphere) _v.set(sphere[0], sphere[1], sphere[2]);
    else _v.copy(item.root.position).add(_w.set(0, skel.eye[1], 0));
    dish.position.copy(_v);
    dish.quaternion.setFromUnitVectors(_w.set(0, 0, -1), _s.set(...dir));
    dish.rotateZ(t * 0.8);
    dish.material.uniforms.uTime.value = t;
    keep.add('vortex');
    const n = rate(state, 'vortexRim', 24, state.dt);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, r = TITAN_ABILITY_FX.vortexRadius;
      _w.set(Math.cos(a) * r, Math.sin(a) * r, 0).applyQuaternion(dish.quaternion).add(dish.position);
      emit('spark', _w.toArray(), { count: 1, speed: 0.15, spread: Math.PI, color0: [0.8, 1.9, 2.4], color1: [0.2, 0.6, 1.6] });
    }
  } else if (type === 'titan_scorch') {
    // Thermal Shield: a fire wall on the front of the server's guard sphere (3.6 m round, 3 m ahead
    // of the hull at 0.45 × height, hull frame), from the ground to above the sphere's waist, so
    // rounds the server blocks end in the flames.
    const sphere = guardSphere(item, row, 'thermal');
    const R = sphere ? sphere[3] : TITAN_ABILITY_FX.wallAhead;
    const at = sphere ?? item.root.position.toArray();
    const g0 = groundAt(at[0], item.root.position.y + 1, at[2]);
    // The fire shader's tongues top out near 0.6 of the sheet: size the sheet so the flames climb
    // past the sphere centre (where blocked rounds end) with the soot band not much above.
    const height = Math.max(TITAN_ABILITY_FX.wallHeight, ((sphere ? sphere[1] - g0 : 0) + R * 0.35) / 0.65);
    const wall = part(state, 'wall', () => add(new THREE.Mesh(S.wall, material(state, fireMaterial)), sink.scene));
    wall.position.set(at[0], g0, at[2]);
    wall.rotation.set(0, item.root.rotation.y, 0);
    wall.scale.set(R, height, R);
    wall.material.uniforms.uTime.value = t;
    keep.add('wall');
    // A second, taller sheet just inside the first (offset flicker): a dense wall of flame, not a
    // fringe of tongues along the ground.
    const inner = part(state, 'wallInner', () => add(new THREE.Mesh(S.wall, material(state, fireMaterial)), sink.scene));
    inner.position.set(at[0], g0, at[2]);
    inner.rotation.set(0, item.root.rotation.y + 0.05, 0);
    inner.scale.set(R * 0.9, height * 1.2, R * 0.9);
    inner.material.uniforms.uTime.value = t + 3.7;
    keep.add('wallInner');
    const scorch = part(state, 'wallScorch', () => add(new THREE.Mesh(S.wallScorch, material(state, scorchMaterial)), sink.scene));
    scorch.position.set(at[0], g0 + 0.04, at[2]);
    scorch.rotation.set(0, item.root.rotation.y, 0);
    scorch.scale.set(R, 1, R);
    keep.add('wallScorch');
    wall.updateMatrixWorld(true);
    // Flames lick up along the base of the wall, lifted off the ground over the scorch.
    const n = rate(state, 'wall', 70, state.dt);
    for (let i = 0; i < n; i++) {
      const a = Math.PI * 0.62 + Math.PI * 0.76 * Math.random();
      _v.set(Math.sin(a), TITAN_ABILITY_FX.flameLift / height, Math.cos(a)).applyMatrix4(wall.matrixWorld);
      flame(_v.toArray(), i, { speed: 1.8, scale: 1.3, life: 1.4, alpha: 0.42 });
      if (i % 3 === 0) emit('ember', _v.toArray(), { count: 2, speed: 0.8, dir: [0, 1, 0] });
    }
    // A grey-black smoke veil over the wall.
    const m = rate(state, 'wallSmoke', 9, state.dt);
    for (let i = 0; i < m; i++) {
      const a = Math.PI * 0.62 + Math.PI * 0.76 * Math.random();
      _v.set(Math.sin(a), Math.min(0.95, 3.6 / height), Math.cos(a)).applyMatrix4(wall.matrixWorld);
      emit('smoke', _v.toArray(), { count: 1, dir: [0, 1, 0], speed: 0.8, scale: 0.7, alpha: 0.45, color0: [0.16, 0.11, 0.08], color1: [0.08, 0.07, 0.06] });
    }
  } else if (type === 'titan_ronin') {
    // Sword Block: a faint curved cyan field (2.4 × 2.8 m) in front of the guard, no hex cells.
    const F = TITAN_ABILITY_FX;
    const at = local(skel, [-0.3, skel.eye[1] - 0.9, skel.eye[2] - 2.2]);
    const mesh = part(state, 'parry', () => add(new THREE.Mesh(S.shield, material(state, () => shieldMaterial([0.45, 0.8, 1.0],
      { width: F.parryWidth, height: F.parryHeight, hex: 0, opacity: 0.16 }))), state.group));
    mesh.position.set(at[0], at[1], at[2]);
    mesh.scale.set(F.parryWidth / F.shieldWidth, F.parryHeight, F.parryWidth / F.shieldWidth);
    mesh.material.uniforms.uTime.value = t;
    keep.add('parry');
  } else if (type === 'titan_legion') {
    // Gun Shield: the front cap of the server's guard sphere (2.0 m round, 1.4 m ahead of the
    // primary's muzzle along the aim), a hex dome facing the aim in a team tint at 0.35 opacity
    // with a bright 0.08 m rim and a fresnel edge: a blocked round ends on its face.
    const F = TITAN_ABILITY_FX, dir = aimDir(item, row);
    const sphere = guardSphere(item, row, 'gunShield');
    const R = sphere ? sphere[3] : TITAN_GUARD_SPHERES.gunShield.radius, span = 2 * R * Math.sin(F.shieldCap);
    const mesh = part(state, 'gunShield', () => add(new THREE.Mesh(S.cap, material(state, () => shieldMaterial(
      TEAM_FX_COLORS[item.team] || TEAM_FX_COLORS[row.team] || ENERGY.shield.map(c => Math.min(1, c)), { width: span, height: span, round: true }))), sink.scene));
    if (sphere) _v.set(sphere[0], sphere[1], sphere[2]);
    else Object.values(item.model.mounts || {})[0]?.muzzle?.getWorldPosition(_v);
    mesh.position.copy(_v);
    mesh.quaternion.setFromUnitVectors(_w.set(0, 0, -1), _s.set(...dir));
    mesh.scale.setScalar(R);
    mesh.material.uniforms.uTime.value = t;
    keep.add('gunShield');
  } else if (type === 'titan_northstar' && !(state.bits & BITS.defensive)) {
    // Tether launch: one cyan crackle from the left forearm.
    const p = local(skel, skel.wristL);
    _v.set(p[0], p[1], p[2]).applyMatrix4(state.group.matrixWorld);
    emit('spark', _v.toArray(), { count: 14, dir: [0, 0.2, 0], speed: 0.8, spread: 1.4, color0: [0.4, 1.9, 2.4], color1: [0.1, 0.6, 1.2] });
  }
}

function hover(state, item, dt, keep) {
  const model = item.model, F = TITAN_ABILITY_FX, S = shapes();
  const thrusters = model.emitters?.thrusters || [];
  // Two cyan cone plumes (2.5 m, 0.5 m at the nozzle) from the back pods' bottom nozzles.
  for (const [i, thruster] of thrusters.slice(0, 2).entries()) {
    const key = `plume${i}`;
    const plume = part(state, key, () => add(new THREE.Mesh(S.plume, material(state, () => streakMaterial([0.35, 0.9, 1.0], true))), sink.scene));
    thruster.node.getWorldPosition(plume.position);
    _w.fromArray(thruster.direction).applyQuaternion(item.root.quaternion).normalize();
    plume.quaternion.setFromUnitVectors(_s.set(0, -1, 0), _w);
    const flicker = 0.94 + 0.06 * Math.sin(state.t * 37 + i * 2);
    plume.scale.set(F.plumeBase / 2, F.plumeLength * flicker, F.plumeBase / 2);
    plume.material.uniforms.uTime.value = state.t;
    keep.add(key);
  }
  const n = rate(state, 'hover', 55, dt);
  for (let i = 0; i < n && thrusters.length; i++) {
    // Round-robin across frames: at ~1 particle a frame, `i` alone would feed only the first.
    const thruster = thrusters[(state.thrusterTurn = ((state.thrusterTurn ?? -1) + 1) % thrusters.length)];
    thruster.node.getWorldPosition(_v);
    const dir = _w.fromArray(thruster.direction).applyQuaternion(item.root.quaternion).normalize();
    emit('fire', _v.toArray(), { count: 1, dir: dir.toArray(), speed: 3.2, scale: 0.75, life: 0.5, spread: 0.18,
      color0: [0.8, 1.5, 2.4], color1: [0.2, 0.5, 1.4] });
  }
  // Downwash dust on the ground below.
  const p = item.root.position, ground = groundAt(p.x, p.y, p.z);
  if (p.y - ground < 9) {
    const m = rate(state, 'wash', 26 * (1 - (p.y - ground) / 9), dt);
    // A 4 m ring of dust rolling outward under the plumes.
    for (let i = 0; i < m; i++) {
      const a = Math.random() * Math.PI * 2, r = F.hoverDustRing * (0.8 + 0.3 * Math.random());
      emit('dust', [p.x + Math.cos(a) * r, ground + 0.15, p.z + Math.sin(a) * r], { count: 1, dir: [Math.cos(a), 0.1, Math.sin(a)],
        speed: 3, scale: 1.4, ground });
    }
  }
}

function core(state, item, row, type, skel, t, keep) {
  const S = shapes(), model = item.model;
  if (!(state.bits & BITS.core)) state.coreAt = t;
  const color = ENERGY.core[type] || ENERGY.vortex;
  // No generic aura sphere (art review: it read as a shield): each core shows its own effect.
  if (type === 'titan_ion') {
    // Laser Core: a three-layer beam from the chest along the aim, stopped by the first voxel,
    // a chest flare, an impact flare with sparks; the eye and cells flare (model). The beam leaves
    // the contract's core anchor (where the server fires it) at the presented hull pose, pulled
    // at most `beamFollow` toward the same point on the twisted, slumping torso. Like the server's
    // pulses (anchorAim) it is aimed from there at the point the primary's own aim ray meets
    // (voxel or hull within the core range), so it converges on what the server hits.
    const anchor = TITAN_ABILITIES[type].core.anchor;
    const server = item.root.localToWorld(_u.set(anchor[0], anchor[1], anchor[2]));
    const o = local(skel, anchor);
    _v.set(o[0], o[1], o[2]).applyMatrix4(state.group.matrixWorld).sub(server);
    if (_v.length() > TITAN_ABILITY_FX.beamFollow) _v.setLength(TITAN_ABILITY_FX.beamFollow);
    const origin = _v.add(server).toArray();
    const range = TITAN_ABILITIES[type].core.range ?? TITAN_ABILITY_FX.laserRange;
    const aim = anchorAimPoint(item, row, range);
    const span = [aim.point[0] - origin[0], aim.point[1] - origin[1], aim.point[2] - origin[2]], spanLength = Math.hypot(...span);
    const dir = spanLength > 1e-6 ? span.map(c => c / spanLength) : aimDir(item, row);
    const reach = aim.hit ? spanLength : range;
    const length = rayLength(origin, dir, reach);
    state.laserAim = { point: aim.point, hit: aim.hit, dir, length };
    const beam = part(state, 'laser', () => add(new THREE.Mesh(S.ray, material(state, beamMaterial)), sink.scene));
    beam.position.set(...origin);
    beam.quaternion.setFromUnitVectors(_w.set(0, 0, -1), _s.set(...dir));
    beam.rotateZ(t * 2.1);
    beam.scale.set(1, 1, length);
    beam.material.uniforms.uLength.value = length;
    beam.material.uniforms.uTime.value = t;
    // A 0.15 s strobe as the beam lights, then a steady shimmer.
    const since = t - (state.coreAt ?? 0), F = TITAN_ABILITY_FX;
    beam.material.uniforms.uOpacity.value = since < F.beamStrobe ? (Math.floor(since / (F.beamStrobe / 4)) % 2 ? 0.35 : 1.5) : 0.9 + 0.1 * Math.sin(t * 47);
    keep.add('laser');
    const flare = part(state, 'laserFlare', () => add(new THREE.Mesh(S.flare, material(state, () => flareMaterial([0.3, 0.8, 1.0], 1))), sink.scene));
    flare.position.set(...origin);
    flare.scale.setScalar(F.flareRadius * (0.92 + 0.08 * Math.sin(t * 31)));
    keep.add('laserFlare');
    const end = [origin[0] + dir[0] * length, origin[1] + dir[1] * length, origin[2] + dir[2] * length];
    if (aim.hit || length < reach - 1e-6) {
      const hit = part(state, 'laserHit', () => add(new THREE.Mesh(S.flare, material(state, () => flareMaterial([0.5, 0.9, 1.0], 1))), sink.scene));
      hit.position.set(...end);
      hit.scale.setScalar(F.flareRadius * (0.9 + 0.15 * Math.sin(t * 53)));
      keep.add('laserHit');
      const n = rate(state, 'laserHit', 70, state.dt);
      if (n) emit('spark', end, { count: n, dir: dir.map(v => -v), speed: 1, spread: 1.2, color0: [1.2, 2, 3], color1: [0.3, 0.6, 1.8] });
      const m = rate(state, 'laserScorch', 6, state.dt);
      if (m) emit('smoke', end, { count: m, speed: 0.6, scale: 0.6, alpha: 0.5, color0: [0.12, 0.12, 0.13], color1: [0.06, 0.06, 0.06] });
    }
  } else if (type === 'titan_scorch') {
    // Flame Core: a ring of fire 6 m round the feet, flame tongues on the pauldrons, the hip vents
    // breathing fire, and the three fire lines racing out along the aim.
    // Flames are lifted 0.6 m off the ground (no sprite edges cutting the grass) over dark
    // ground scorch: a ring decal and one strip per fire line.
    const p = item.root.position, yaw = item.root.rotation.y, F = TITAN_ABILITY_FX;
    const g = groundAt(p.x, p.y + 1, p.z);
    const ringScorch = part(state, 'ringScorch', () => add(new THREE.Mesh(S.ring, material(state, scorchMaterial)), sink.scene));
    ringScorch.position.set(p.x, g + 0.04, p.z);
    ringScorch.scale.setScalar(F.flameRing * 1.12);
    keep.add('ringScorch');
    // The three fire lines come from the server's flameCore events (titan-ability-events.js, along
    // the terrain); only while none has arrived for this hull do the straight stand-in lines show.
    const fallback = !item.titanEventLines && t - (state.coreAt ?? t) > 0.25;
    for (let line = 0; line < F.flameLines && fallback; line++) {
      const key = `lineScorch${line}`;
      const strip = part(state, key, () => add(new THREE.Mesh(S.decal, material(state, scorchMaterial)), sink.scene));
      strip.position.set(p.x, g + 0.04, p.z);
      strip.rotation.set(0, yaw + (line - 1) * 0.26, 0);
      strip.scale.set(1.4, 1, F.flameRange + 2);
      keep.add(key);
    }
    // The ring and the lines burn as fire sheets (normal blending: additive orange over grass
    // read lemon-green), with embers and a few lifted puffs on top.
    const fireRing = part(state, 'fireRing', () => add(new THREE.Mesh(S.fireRing, material(state, fireMaterial)), sink.scene));
    fireRing.position.set(p.x, g, p.z);
    fireRing.scale.set(F.flameRing, F.flameSheet, F.flameRing);
    fireRing.material.uniforms.uTime.value = t;
    keep.add('fireRing');
    for (let line = 0; line < F.flameLines && fallback; line++) {
      const key = `fireLine${line}`;
      const sheet = part(state, key, () => add(new THREE.Mesh(S.fireLine, material(state, fireMaterial)), sink.scene));
      sheet.position.set(p.x, g, p.z);
      sheet.rotation.set(0, yaw + (line - 1) * 0.26, 0);
      sheet.scale.set(1, F.flameSheet * 0.75, F.flameRange + 2);
      sheet.material.uniforms.uTime.value = t + line * 1.7;
      keep.add(key);
    }
    const ring = rate(state, 'flameRing', 30, state.dt);
    for (let i = 0; i < ring; i++) {
      const a = Math.random() * Math.PI * 2, r = F.flameRing * (0.92 + 0.16 * Math.random());
      _v.set(p.x + Math.cos(a) * r, g + F.flameLift, p.z + Math.sin(a) * r);
      if (i % 2) emit('ember', _v.toArray(), { count: 2, speed: 0.9, dir: [0, 1, 0] });
      else flame(_v.toArray(), i, { speed: 1.6, scale: 1.0, life: 1.0, alpha: 0.35 });
    }
    const tongues = model.emitters?.doomFire || [];
    const k = rate(state, 'flameTongue', 20, state.dt);
    for (let i = 0; i < k && tongues.length; i++) {
      const node = tongues[i % Math.min(2, tongues.length)];
      node.getWorldPosition(_v);
      flame(_v.toArray(), i, { speed: 1.4, scale: 0.78, life: 1.0, alpha: 0.5 });
    }
    const n = fallback ? rate(state, 'flame', 24, state.dt) : 0;
    for (let i = 0; i < n; i++) {
      const line = i % F.flameLines, a = yaw + (line - 1) * 0.26;
      const d = ((t * 22 + i * 2.7) % F.flameRange) + 2;
      const x = p.x - Math.sin(a) * d, z = p.z - Math.cos(a) * d, y = groundAt(x, p.y + 1, z);
      emit('ember', [x, y + F.flameLift, z], { count: 2, speed: 1.2, dir: [0, 1, 0] });
    }
  } else if (type === 'titan_ronin') {
    // Sword Core: the blade's edge glows (model) and leaves a 0.2 s afterimage trail on swings.
    const sword = model.nodes?.sword;
    if (sword) {
      sword.getWorldPosition(_v);
      const last = state.swordAt;
      const moved = last ? _v.distanceTo(last) / Math.max(state.dt, 1e-3) : 0;
      state.swordAt = (state.swordAt || new THREE.Vector3()).copy(_v);
      state.trailT = (state.trailT || 0) - state.dt;
      if ((moved > 2.5 || state.t < 0.4) && state.trailT <= 0) { spawnGhost(item, sword, [0.5, 0.85, 2.0], 0.2); state.trailT = 0.04; }
      const n = rate(state, 'blade', 18, state.dt);
      if (n) emit('spark', _v.toArray(), { count: n, speed: 0.4, spread: Math.PI, color0: [0.6, 1.4, 2.8], color1: [0.2, 0.4, 1.4] });
    }
  } else if (type === 'titan_legion' || type === 'titan_northstar') {
    const muzzle = Object.values(model.mounts || {})[0]?.muzzle;
    if (muzzle) {
      const glow = part(state, 'muzzleGlow', () => add(new THREE.Mesh(S.flare, material(state, () => flareMaterial(color.map(c => Math.min(1, c * 0.6)), 1))), sink.scene));
      muzzle.getWorldPosition(_v);
      glow.position.copy(_v);
      glow.scale.setScalar(TITAN_ABILITY_FX.flareRadius * (0.9 + 0.1 * Math.sin(t * 13)));
      keep.add('muzzleGlow');
    }
    if (type === 'titan_northstar') {
      // Flight Core: the back thrusters burn short cyan cones while the salvo flies.
      const thrusters = model.emitters?.thrusters || [];
      const n = rate(state, 'flightCore', 48, state.dt);
      for (let i = 0; i < n && thrusters.length; i++) {
        const thruster = thrusters[(state.thrusterTurn = ((state.thrusterTurn ?? -1) + 1) % thrusters.length)];
        thruster.node.getWorldPosition(_v);
        _w.set(...thruster.direction).normalize().applyQuaternion(item.root.quaternion);
        emit('fire', _v.toArray(), { count: 1, dir: _w.toArray(), speed: 2.2, scale: 1.2, life: 0.35, alpha: 0.6,
          color0: [0.7, 1.7, 2.2], color1: [0.15, 0.5, 1.4] });
      }
    }
  }
}

function smoke(state, item, dt) {
  const p = item.root.position;
  const n = rate(state, 'smoke', 34, dt);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * TITAN_ABILITY_FX.smokeRadius;
    emit('smoke', [p.x + Math.cos(a) * r, p.y + 0.5 + Math.random() * 5, p.z + Math.sin(a) * r],
      { count: 1, dir: [0, 1, 0], speed: 0.4, scale: 1.6, color0: [0.72, 0.76, 0.82], color1: [0.5, 0.54, 0.6] });
  }
  const m = rate(state, 'arcs', 26, dt);
  for (let i = 0; i < m; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * TITAN_ABILITY_FX.smokeRadius * 0.8;
    emit('spark', [p.x + Math.cos(a) * r, p.y + 1 + Math.random() * 6, p.z + Math.sin(a) * r],
      { count: 3, speed: 0.7, spread: Math.PI, color0: [0.8, 1.8, 3.2], color1: [0.3, 0.6, 2] });
  }
}

function charge(state, item, row, keep) {
  const amount = Array.isArray(row.mounts?.[0]) ? clamp(finite(row.mounts[0][5]) / 100, 0, 1) : 0;
  if (amount <= 0.02) return;
  const muzzle = Object.values(item.model.mounts || {})[0]?.muzzle;
  if (!muzzle) return;
  const S = shapes();
  const glow = part(state, 'charge', () => add(new THREE.Mesh(S.flare, material(state, () => flareMaterial([0.25, 0.85, 1.0], 1))), sink.scene));
  muzzle.getWorldPosition(_v);
  glow.position.copy(_v);
  glow.scale.setScalar(TITAN_ABILITY_FX.flareRadius * (0.15 + 0.85 * amount) * (1 + 0.1 * Math.sin(state.t * 31)));
  keep.add('charge');
  const n = rate(state, 'charge', 30 * amount, state.dt);
  if (n) emit('spark', _v.toArray(), { count: n, speed: 0.25, spread: Math.PI, color0: [0.6, 2, 2.8], color1: [0.2, 0.8, 1.6] });
}

function spawnGhost(item, node = null, color = [0.35, 0.8, 1.9], life = TITAN_ABILITY_FX.ghostLife) {
  if (!sink.scene || ghosts.size >= TITAN_ABILITY_FX.ghostMax * (node ? 2 : 1)) return;
  const ghost = new THREE.Group();
  ghost.name = 'titan-phase-ghost';
  const mat = glowMaterial(color, 0.32);
  item.root.updateMatrixWorld(true);
  // Only the hull's own cached voxel meshes: never the first-person cockpit overlay (parented
  // under the body) or any geometry that can be disposed while the ghost still draws it.
  const walk = object => {
    if (!object.visible || object.userData?.cockpitOverlay || object === item.cockpit?.group) return;
    if (object.isMesh && object.geometry?.userData?.cached) {
      const copy = new THREE.Mesh(object.geometry, mat);
      copy.matrixAutoUpdate = false;
      copy.matrix.copy(object.matrixWorld);
      add(copy, ghost);
    }
    for (const child of object.children) walk(child);
  };
  walk(node || item.model.group);
  sink.scene.add(ghost);
  ghosts.add({ group: ghost, material: mat, age: 0, life });
}

/**
 * Dash (art review 2): two 1.8 m thruster streaks from the first two (back/hip) nozzles, against
 * the dash, cyan on RONIN and NORTHSTAR, white-orange on the heavier frames; RONIN also leaves a
 * 0.25 s afterimage of its silhouette at 30 %. `dir` is the world dash direction.
 */
export function dashStreak(item, dir) {
  if (!sink.scene || !item?.model || item.wreck) return;
  const S = shapes(), F = TITAN_ABILITY_FX;
  const light = item.kind === 'titan_ronin' || item.kind === 'titan_northstar';
  const color = light ? [0.35, 0.9, 1.0] : [1.0, 0.72, 0.42];
  const back = _w.set(-finite(dir?.[0]), -0.12, -finite(dir?.[2]));
  if (back.lengthSq() < 0.02) back.set(0, -0.12, 1).applyQuaternion(item.root.quaternion);
  back.normalize();
  for (const thruster of (item.model.emitters?.thrusters || []).slice(0, 2)) {
    const mat = streakMaterial(color);
    const mesh = add(new THREE.Mesh(S.ray, mat), sink.scene);
    mesh.quaternion.setFromUnitVectors(_s.set(0, 0, -1), back);
    mesh.scale.set(F.streakWidth / 2, 1, F.streakLength);
    thruster.node.getWorldPosition(mesh.position);
    streaks.add({ mesh, node: thruster.node, age: 0, life: F.streakLife });
  }
  if (item.kind === 'titan_ronin') spawnGhost(item, null, [0.35, 0.8, 1.9], F.afterimageLife);
}

/**
 * Pose every ability effect of one presented titan from its row. Called by
 * titan-presentation.js update() after the rig, with the hull matrices current.
 */
export function updateTitan(item, row, dt) {
  if (!item?.model?.titanRig || !row) return;
  const titan = decodeTitanRow(row);
  const bits = titan?.bits ?? (Array.isArray(row.tw) ? row.tw[4] | 0 : 0);
  const chargeLive = Array.isArray(row.mounts?.[0]) && finite(row.mounts[0][5]) > 2 && item.kind === 'titan_northstar';
  let state = states.get(item);
  if (!state && (!bits || item.wreck) && !chargeLive) return;
  if (item.wreck || !sink.scene) { if (state) drop(state); return; }
  state = stateFor(item);
  if (!state) return;
  state.dt = Math.max(0, finite(dt));
  state.t += state.dt;
  const model = item.model, skel = model.skeleton, type = item.kind;
  poseGroup(state, model);
  const keep = new Set();
  if (bits & BITS.defensive) defensive(state, type, skel, state.t, keep, item, row);
  if (bits & BITS.hover) hover(state, item, state.dt, keep);
  if (bits & BITS.core) core(state, item, row, type, skel, state.t, keep);
  if (bits & BITS.smoke) smoke(state, item, state.dt);
  if (bits & BITS.phased) {
    state.ghostT -= state.dt;
    if (state.ghostT <= 0) { spawnGhost(item); state.ghostT = TITAN_ABILITY_FX.ghostEvery; }
  } else state.ghostT = 0;
  if (type === 'titan_northstar') charge(state, item, row, keep);
  // A fresh defensive or core: one flash burst at the chest.
  const fresh = bits & ~state.bits & (BITS.defensive | BITS.core | BITS.phased);
  if (fresh) {
    const chest = local(skel, [0, (skel.waist[1] + skel.neck[1]) / 2, -skel.def.collider.halfLength]);
    _v.set(chest[0], chest[1], chest[2]).applyMatrix4(state.group.matrixWorld);
    const color = ENERGY.core[type] || ENERGY.vortex;
    emit('spark', _v.toArray(), { count: fresh & BITS.core ? 40 : 16, speed: 1.2, spread: Math.PI, color0: color.map(c => c * 1.4), color1: color });
  }
  state.bits = bits;
  hide(state, keep);
  if (!bits && !keep.size) drop(state);
}

/** The titanfall marker beam: from the drop event until the hull lands. */
export function dropBeam({ x, y, z, team = 'neutral', seconds = 3 } = {}) {
  if (!sink.scene || ![x, y, z].every(Number.isFinite)) return null;
  const S = shapes(), color = TEAM_FX_COLORS[team] || TEAM_FX_COLORS.neutral;
  const group = new THREE.Group();
  group.name = 'titanfall-drop-beam';
  group.position.set(x, y, z);
  const outer = add(new THREE.Mesh(S.beam, glowMaterial(color.map(c => c * 1.6), 0.32)), group);
  outer.scale.set(TITAN_ABILITY_FX.beamRadius, TITAN_ABILITY_FX.beamHeight, TITAN_ABILITY_FX.beamRadius);
  const inner = add(new THREE.Mesh(S.beam, glowMaterial([2.2, 2.2, 2.2], 0.75)), group);
  inner.scale.set(TITAN_ABILITY_FX.beamRadius * 0.28, TITAN_ABILITY_FX.beamHeight, TITAN_ABILITY_FX.beamRadius * 0.28);
  const ring = add(new THREE.Mesh(S.ring, glowMaterial(color.map(c => c * 2), 0.8)), group);
  ring.position.y = 0.06;
  const disc = add(new THREE.Mesh(S.disc, glowMaterial(color.map(c => c * 0.9), 0.22)), group);
  disc.rotation.x = -Math.PI / 2; disc.position.y = 0.04;
  disc.scale.setScalar(TITAN_ABILITY_FX.ringRadius);
  sink.scene.add(group);
  const beam = { group, outer, inner, ring, disc, age: 0, life: Math.max(0.3, finite(seconds, 3)), color };
  beams.add(beam);
  return beam;
}

/** Per-frame: beams pulse and fade, ghosts fade, detached hulls drop their effects. */
export function frame(dt) {
  const step = Math.max(0, Math.min(0.25, finite(dt)));
  clock += step;
  for (const beam of [...beams]) {
    beam.age += step;
    const left = beam.life - beam.age;
    const fade = left < 0 ? Math.max(0, 1 + left / TITAN_ABILITY_FX.beamFade) : 1;
    if (fade <= 0) {
      beam.group.removeFromParent();
      for (const mesh of [beam.outer, beam.inner, beam.ring, beam.disc]) mesh.material.dispose();
      beams.delete(beam);
      continue;
    }
    const pulse = 0.75 + 0.25 * Math.sin(beam.age * 9);
    beam.outer.material.opacity = 0.32 * pulse * fade;
    beam.inner.material.opacity = 0.75 * fade;
    const grow = 1 + ((beam.age * 1.4) % 1) * 0.35;
    beam.ring.scale.setScalar(TITAN_ABILITY_FX.ringRadius * grow);
    beam.ring.material.opacity = 0.8 * fade * (1.35 - grow);
    beam.disc.material.opacity = 0.22 * fade;
    if (sink.fx && Math.floor(beam.age * 20) !== Math.floor((beam.age - step) * 20)) {
      const p = beam.group.position;
      emit('spark', [p.x, p.y + 0.3, p.z], { count: 2, dir: [0, 1, 0], speed: 1.4, spread: 0.08, life: 2,
        color0: beam.color.map(c => c * 2.4), color1: beam.color });
    }
  }
  for (const streak of [...streaks]) {
    streak.age += step;
    const k = 1 - streak.age / streak.life;
    if (k <= 0 || !streak.node.parent) { streak.mesh.removeFromParent(); streak.mesh.material.dispose(); streaks.delete(streak); continue; }
    streak.node.getWorldPosition(streak.mesh.position);
    streak.mesh.material.uniforms.uOpacity.value = k;
    streak.mesh.material.uniforms.uTime.value = clock;
  }
  for (const ghost of [...ghosts]) {
    ghost.age += step;
    const k = 1 - ghost.age / (ghost.life ?? TITAN_ABILITY_FX.ghostLife);
    if (k <= 0) { ghost.group.removeFromParent(); ghost.material.dispose(); ghosts.delete(ghost); continue; }
    ghost.material.opacity = 0.32 * k;
  }
  for (const state of [...states.values()]) {
    if (!state.item.root?.parent) { drop(state); continue; }
    for (const mesh of Object.values(state.parts)) mesh.traverse?.(object => { if (object.material?.uniforms?.uTime) object.material.uniforms.uTime.value = clock; });
  }
}

/** Live effect counts (tests and the capture page). */
export function stats() {
  let meshes = 0;
  for (const state of states.values()) for (const mesh of Object.values(state.parts)) if (mesh.visible) meshes++;
  return { hulls: states.size, meshes, beams: beams.size, ghosts: ghosts.size, streaks: streaks.size };
}

/** Programs of the ability FX; `warmupRoot` carries one hidden mesh of each. */
export const TITAN_FX_WARMUP_MATERIALS = Object.freeze(['titan-vortex-fx', 'titan-laser-beam-fx', 'titan-fire-wall-fx', 'titan-flare-fx',
  'titan-streak-fx', 'titan-plume-fx', 'titan-shield-fx', 'titan-scorch-decal', 'titan-glow-fx']);
let warmup = null;
/**
 * A hidden group with one mesh per ability-FX material (built once, kept for the page): three.js
 * compiles hidden objects too, so warmShaders links them at load instead of on the first core,
 * shield or dash (shader-warmup.js).
 */
export function warmupRoot() {
  if (warmup) return warmup;
  const S = shapes();
  warmup = new THREE.Group();
  warmup.name = 'titan-fx-shader-warmup';
  warmup.visible = false;
  const white = [1, 1, 1];
  for (const mat of [vortexMaterial(ENERGY.vortex), beamMaterial(), fireMaterial(), flareMaterial(white), streakMaterial(white),
    streakMaterial(white, true), shieldMaterial(white, { width: 3, height: 3 }), scorchMaterial(), glowMaterial(white)]) {
    const mesh = new THREE.Mesh(S.panel, mat);
    mesh.name = `warmup-${mat.name}`;
    mesh.frustumCulled = false;
    warmup.add(mesh);
  }
  return warmup;
}

/** Drop every effect (leave the match, capture reset). */
export function clear() {
  for (const state of [...states.values()]) drop(state);
  for (const beam of beams) { beam.group.removeFromParent(); for (const mesh of [beam.outer, beam.inner, beam.ring, beam.disc]) mesh.material.dispose(); }
  beams.clear();
  for (const ghost of ghosts) { ghost.group.removeFromParent(); ghost.material.dispose(); }
  ghosts.clear();
  for (const streak of streaks) { streak.mesh.removeFromParent(); streak.mesh.material.dispose(); }
  streaks.clear();
}

void _m;

/** Shared with titan-ability-events.js (the event-driven fire lines reuse the approved fire look). */
export { fireMaterial, scorchMaterial };
