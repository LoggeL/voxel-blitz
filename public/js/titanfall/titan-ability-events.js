// Titan ability events (docs/titanfall.md §3.8 `titan_ability`, §7.3; WP5). The
// event-driven half of the ability visuals; titan-ability-fx.js keeps the row-bit
// half (guards, hover, cores, smoke). Everything here presents an authoritative
// server event and nothing else:
//
//   tripwire / tripwireTrigger   three mines on the ground and the laser fence between
//                                them; the trigger is three 6 m blasts
//   tether / tetherTrigger       a pod with its trigger ring; the trigger strings a crackling
//                                cable from the pod to the caught titan until the root ends
//   incendiaryTrap / trapIgnite  an unlit canister; ignite bursts it (the fire field itself
//                                arrives as a molotov fire field)
//   deployableEnd                removes a deployable (spent, expired or replaced)
//   firewall / arcWave / flameCore  ground lines from (x, y, z) along yaw that follow the
//                                terrain exactly as the server line does (1 m samples, rise
//                                ≤ 2.2 m, fall ≤ 4 m, a taller wall stops it), advancing at
//                                the server speed: burning path, arc blade, fire wave
//   melee / execution            the left-arm punch (from the `titanMelee` shoot, so it also
//                                shows without the ability event), the impact on the target,
//                                and the longer execution finisher on the target hull
//   laserShot / powerShot / vortexThrow  the rays from the ability anchor (`shoot` with
//                                `ability`, one path per ray; vehicle-fx.js keeps only the
//                                impacts and the light for these, so nothing is drawn twice)
//   vortex catches               hitscan paths that end inside a raised Vortex sphere leave a
//                                glowing round orbiting the dish until the throw-back
//   phaseDash                    a blink streak between the two ends
//
// Draws: one ray batch (camera-facing ribbons: lasers, cables, arcs, slashes, shots), one
// flare batch (camera-facing glows), one mesh per deployable prop and up to three per ground
// line (ground glow + scorch, fire sheet), transient shock rings. Event times are engine
// milliseconds: a lifetime is `until - at`, counted on this module's frame clock from arrival.
import * as THREE from '../vendor/three.module.js';
import { TITAN_ABILITIES, TITAN_COMMON_ABILITIES } from '../../../shared/titan-contract.js';
import { titanFrame } from '../../../shared/vehicle-handling/titan.js';
import { vehicleOccupiedSeats } from '../../../shared/vehicle-seats.js';
import { isSolidBlock } from '../../../shared/worlddata.js';
import { fireMaterial, scorchMaterial, guardSphere, TEAM_FX_COLORS, TITAN_FLAME } from './titan-ability-fx.js';

/**
 * Presentation tuning. The `line`, speed, width, radius and blast numbers mirror the server's
 * ABILITY_TUNING (server/sim/titanfall/titan-abilities.js; the model budget test pins them).
 */
export const TITAN_EVENT_FX = Object.freeze({
  line: Object.freeze({ sample: 1, rise: 2.2, fall: 4, tickHz: 60 }),   // tickHz: the server tick (TICK_RATE_HZ)
  firewall: Object.freeze({ speed: 30, width: 1.6, sheet: 3.4, fade: 0.7 }),
  arcWave: Object.freeze({ speed: 45, width: 1.8, height: 3.2, trail: 0.45, bolts: 9 }),
  flameCore: Object.freeze({ speed: 30, width: 3, sheet: 4.2, linger: 0.9 }),
  tripwire: Object.freeze({ blastRadius: 6, beamHeight: 0.95, beamWidth: 0.16 }),
  tether: Object.freeze({ triggerRadius: 4 }),
  incendiary: Object.freeze({ igniteRadius: 4 }),
  melee: Object.freeze({ seconds: 0.62, strike: 0.2, executionSeconds: 1.55, executionStrike: 0.34, executionRip: 0.95 }),
  shot: Object.freeze({
    laserShot: Object.freeze({ width: 1.5, life: 0.42, color: [0.25, 0.8, 1.6] }),
    powerShotLong: Object.freeze({ width: 1.1, life: 0.36, color: [1.7, 0.95, 0.3] }),
    powerShotClose: Object.freeze({ width: 0.42, life: 0.22, color: [1.8, 0.85, 0.25] }),
    vortexThrow: Object.freeze({ width: 0.5, life: 0.28, color: [1.6, 0.8, 0.35] }),
    // NORTHSTAR's railgun primary (not an ability): width and life grow with the shot's charge.
    railgun: Object.freeze({ width: 1.35, life: 0.55, color: [0.55, 1.25, 2.2], minCharge: 0.3 }),
  }),
  maxRays: 1536, maxFlares: 256, maxCaught: 24, maxLines: 12, maxDecals: 12,
});
const ION = [0.3, 0.85, 1.7], FIRE = [1.8, 0.7, 0.18], ARC = [0.45, 0.85, 2.0];

const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const smooth = k => { const t = clamp(k, 0, 1); return t * t * (3 - 2 * t); };
const vec = value => (Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? value : null);
const lerp3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ---- shaders ----------------------------------------------------------------------------------

const NOISE = /* glsl */ `
float h1(float n) { return fract(sin(n) * 43758.5453); }
float n1(float x) { float i = floor(x), f = fract(x); return mix(h1(i), h1(i + 1.0), f * f * (3.0 - 2.0 * f)); }`;
// Camera-facing ribbon per segment: aA → aB, width aW, colour aC (rgb, alpha), aF (fade-in m,
// fade-out m, seed). Across: a white core, the colour body and a soft haze.
const RAY_VERTEX = /* glsl */ `
attribute vec3 aA; attribute vec3 aB; attribute vec2 aST; attribute float aW; attribute vec4 aC; attribute vec3 aF;
varying vec2 vUv; varying vec4 vC; varying vec3 vF; varying float vLen;
void main() {
  vec3 d = aB - aA; float len = length(d);
  vec3 dir = len > 1e-5 ? d / len : vec3(0.0, 1.0, 0.0);
  vec3 p = mix(aA, aB, aST.y);
  vec3 side = cross(dir, cameraPosition - p); float sl = length(side);
  side = sl > 1e-5 ? side / sl : vec3(1.0, 0.0, 0.0);
  p += side * aST.x * aW * 0.5;
  vUv = vec2(aST.x, aST.y * len); vC = aC; vF = aF; vLen = len;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const RAY_FRAGMENT = /* glsl */ `
uniform float uTime;
varying vec2 vUv; varying vec4 vC; varying vec3 vF; varying float vLen;
${NOISE}
void main() {
  float u = abs(vUv.x), along = vUv.y;
  float core = 1.0 - smoothstep(0.1, 0.3, u);
  float body = 1.0 - smoothstep(0.28, 0.78, u);
  float haze = 1.0 - smoothstep(0.65, 1.0, u);
  float noise = 0.8 + 0.2 * n1(along * 1.7 - uTime * 24.0 + vF.z * 31.0);
  float ends = (vF.x > 0.0 ? smoothstep(0.0, vF.x, along) : 1.0) * (vF.y > 0.0 ? 1.0 - smoothstep(vLen - vF.y, vLen, along) : 1.0);
  vec3 color = vC.rgb * (body * 0.75 * noise + haze * 0.22) + vec3(1.0) * core * 0.8;
  gl_FragColor = vec4(color * ends * vC.a, 1.0);
}`;
// Camera-facing glow per point: aP centre, aQ corner (-1..1), aS radius, aC colour and alpha.
const FLARE_VERTEX = /* glsl */ `
attribute vec3 aP; attribute vec2 aQ; attribute float aS; attribute vec4 aC;
varying vec2 vUv; varying vec4 vC;
void main() {
  vUv = aQ; vC = aC;
  vec4 mv = viewMatrix * vec4(aP, 1.0);
  mv.xy += aQ * aS;
  gl_Position = projectionMatrix * mv;
}`;
const FLARE_FRAGMENT = /* glsl */ `
varying vec2 vUv; varying vec4 vC;
void main() {
  float r = length(vUv);
  float glow = pow(max(0.0, 1.0 - r), 2.4);
  float core = pow(max(0.0, 1.0 - r * 2.6), 2.0);
  float streak = max(0.0, 1.0 - abs(vUv.y) * 14.0) * max(0.0, 1.0 - abs(vUv.x)) * 0.35;
  gl_FragColor = vec4((vC.rgb * (glow + streak) + vec3(core)) * vC.a, 1.0);
}`;
// Ground glow under a line: each vertex carries the clock time the head reached it (aBirth)
// and its place on the strip (aRib: across -1..1, along metres). Bright at the head, then
// fading with `uFade` seconds; blended additively (arc) or normally (fire: no lemon grass).
const TRAIL_VERTEX = /* glsl */ `
attribute float aBirth; attribute vec2 aRib;
uniform float uNow;
varying float vAge; varying vec2 vRib;
void main() {
  vAge = uNow - aBirth; vRib = aRib;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const TRAIL_FRAGMENT = /* glsl */ `
uniform vec3 uColor; uniform float uFade; uniform float uOpacity; uniform float uTime; uniform float uHead;
varying float vAge; varying vec2 vRib;
${NOISE}
void main() {
  float across = 1.0 - smoothstep(0.3, 1.0, abs(vRib.x));
  float life = exp(-max(vAge, 0.0) / uFade);
  float n = 0.55 + 0.45 * n1(vRib.y * 2.3 - uTime * 3.0 + vRib.x * 1.7) * (0.6 + 0.4 * n1(vRib.y * 0.6 + uTime * 1.1));
  float head = uHead * (1.0 - smoothstep(0.0, 0.3, vAge));
  float k = clamp(life * n + head, 0.0, 1.0);
  gl_FragColor = vec4(uColor * (0.6 + 0.6 * k), across * k * uOpacity);
}`;

function rayMaterial() {
  return new THREE.ShaderMaterial({
    name: 'titan-ray-fx', uniforms: { uTime: { value: 0 } }, vertexShader: RAY_VERTEX, fragmentShader: RAY_FRAGMENT,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
  });
}
function flareBatchMaterial() {
  return new THREE.ShaderMaterial({
    name: 'titan-flare-batch-fx', vertexShader: FLARE_VERTEX, fragmentShader: FLARE_FRAGMENT,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
  });
}
function trailMaterial(color, { additive = true, fade = 0.5, head = 1 } = {}) {
  return new THREE.ShaderMaterial({
    name: 'titan-ground-trail-fx',
    uniforms: { uColor: { value: new THREE.Color(...color) }, uNow: { value: 0 }, uFade: { value: fade }, uOpacity: { value: 1 },
      uTime: { value: 0 }, uHead: { value: head } },
    vertexShader: TRAIL_VERTEX, fragmentShader: TRAIL_FRAGMENT,
    transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
}
/** Deployable props: lit, vertex-coloured voxel boxes (one program for every prop). */
function propMaterial() {
  return new THREE.MeshStandardMaterial({ name: 'titan-deployable-fx', vertexColors: true, roughness: 0.62, metalness: 0.25 });
}
/** Blast burns: soot-black, soft-edged (vertex alpha), one shared program. */
function burnMaterial() {
  return new THREE.MeshBasicMaterial({ name: 'titan-burn-decal-fx', color: 0x15110d, vertexColors: true, transparent: true, opacity: 0.82,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
}
/** A ragged burn of `radius` (XZ plane): opaque core, a sooty mid band and a rim that fades out. */
function burnGeometry(radius, rim = 18) {
  const pos = [0, 0, 0], col = [1, 1, 1, 1], index = [];
  for (let i = 0; i < rim; i++) {
    const a = i / rim * Math.PI * 2, j = 0.78 + Math.random() * 0.36, s = Math.sin(a), c = Math.cos(a);
    pos.push(s * radius * 0.5 * j, 0, c * radius * 0.5 * j, s * radius * j, 0, c * radius * j);
    col.push(1, 1, 1, 0.8, 1, 1, 1, 0);
  }
  for (let i = 0; i < rim; i++) {
    const m = 1 + 2 * i, o = m + 1, m2 = 1 + 2 * ((i + 1) % rim), o2 = m2 + 1;
    index.push(0, m, m2, m, o, m2, o, o2, m2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(index);
  return g;
}
function ringMaterial(color, opacity) {
  return new THREE.MeshBasicMaterial({ name: 'titan-glow-fx', color: new THREE.Color(...color), transparent: true, opacity,
    depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
}

// ---- batches -----------------------------------------------------------------------------------

/** Camera-facing ribbons, rebuilt every frame from the live effects: one draw for all of them. */
class RayBatch {
  constructor(capacity) {
    this.capacity = capacity; this.count = 0;
    const v = capacity * 4, g = new THREE.BufferGeometry();
    const attr = (name, size) => { const a = new THREE.BufferAttribute(new Float32Array(v * size), size); a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(name, a); return a; };
    this.a = attr('aA', 3); this.b = attr('aB', 3); this.w = attr('aW', 1); this.c = attr('aC', 4); this.f = attr('aF', 3);
    const st = new Float32Array(v * 2), index = new Uint32Array(capacity * 6);
    for (let i = 0; i < capacity; i++) {
      st.set([-1, 0, 1, 0, -1, 1, 1, 1], i * 8);
      index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2], i * 6);
    }
    g.setAttribute('aST', new THREE.BufferAttribute(st, 2));
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v * 3), 3));   // unused (three needs one)
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.setDrawRange(0, 0);
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, rayMaterial());
    Object.assign(this.mesh, { name: 'titan-ray-batch', frustumCulled: false, renderOrder: 5 });
  }
  begin() { this.count = 0; }
  /** One ribbon a → b, `width` m, colour rgb at `alpha`, fade-in/out metres, seed. */
  add(a, b, width, color, alpha = 1, fadeIn = 0, fadeOut = 0, seed = 0) {
    if (this.count >= this.capacity || !(alpha > 0.002)) return;
    const i = this.count++;
    for (let k = 0; k < 4; k++) {
      const j = i * 4 + k;
      this.a.setXYZ(j, a[0], a[1], a[2]); this.b.setXYZ(j, b[0], b[1], b[2]);
      this.w.setX(j, width); this.c.setXYZW(j, color[0], color[1], color[2], alpha); this.f.setXYZ(j, fadeIn, fadeOut, seed);
    }
  }
  /** A polyline (`points`) as joined ribbons, the alpha ramping from `alpha0` to `alpha1`. */
  polyline(points, width, color, alpha0 = 1, alpha1 = alpha0, seed = 0) {
    for (let i = 0; i + 1 < points.length; i++) {
      const k = points.length > 2 ? i / (points.length - 2) : 0;
      this.add(points[i], points[i + 1], width, color, alpha0 + (alpha1 - alpha0) * k, 0, 0, seed + i);
    }
  }
  end(time) {
    for (const attr of [this.a, this.b, this.w, this.c, this.f]) {
      attr.needsUpdate = true;
      attr.clearUpdateRanges?.();
      attr.addUpdateRange?.(0, this.count * 4 * attr.itemSize);
    }
    this.geometry.setDrawRange(0, this.count * 6);
    this.mesh.material.uniforms.uTime.value = time;
    this.mesh.visible = this.count > 0;
  }
}

/** Camera-facing glows (anchor flashes, lenses, impact flares): one draw for all of them. */
class FlareBatch {
  constructor(capacity) {
    this.capacity = capacity; this.count = 0;
    const v = capacity * 4, g = new THREE.BufferGeometry();
    const attr = (name, size) => { const a = new THREE.BufferAttribute(new Float32Array(v * size), size); a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(name, a); return a; };
    this.p = attr('aP', 3); this.s = attr('aS', 1); this.c = attr('aC', 4);
    const q = new Float32Array(v * 2), index = new Uint32Array(capacity * 6);
    for (let i = 0; i < capacity; i++) {
      q.set([-1, -1, 1, -1, -1, 1, 1, 1], i * 8);
      index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2], i * 6);
    }
    g.setAttribute('aQ', new THREE.BufferAttribute(q, 2));
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v * 3), 3));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.setDrawRange(0, 0);
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, flareBatchMaterial());
    Object.assign(this.mesh, { name: 'titan-flare-batch', frustumCulled: false, renderOrder: 6 });
  }
  begin() { this.count = 0; }
  add(p, radius, color, alpha = 1) {
    if (this.count >= this.capacity || !(alpha > 0.002) || !(radius > 0)) return;
    const i = this.count++;
    for (let k = 0; k < 4; k++) {
      const j = i * 4 + k;
      this.p.setXYZ(j, p[0], p[1], p[2]); this.s.setX(j, radius); this.c.setXYZW(j, color[0], color[1], color[2], alpha);
    }
  }
  end() {
    for (const attr of [this.p, this.s, this.c]) {
      attr.needsUpdate = true;
      attr.clearUpdateRanges?.();
      attr.addUpdateRange?.(0, this.count * 4 * attr.itemSize);
    }
    this.geometry.setDrawRange(0, this.count * 6);
    this.mesh.visible = this.count > 0;
  }
}

// ---- prop geometry ------------------------------------------------------------------------------

/** Boxes and prisms with per-part colours merged into one non-indexed geometry. */
function mergeColored(parts) {
  const pos = [], nor = [], col = [];
  const c = new THREE.Color();
  for (const [geometry, hex] of parts) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    g.computeVertexNormals();
    c.setHex(hex);
    const p = g.attributes.position.array, n = g.attributes.normal.array;
    for (let i = 0; i < p.length; i += 3) { pos.push(p[i], p[i + 1], p[i + 2]); nor.push(n[i], n[i + 1], n[i + 2]); col.push(c.r, c.g, c.b); }
    if (g !== geometry) g.dispose();
    geometry.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}
const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z);
const prism = (r0, r1, h, sides, y, rot = 0) => new THREE.CylinderGeometry(r1, r0, h, sides).rotateY(rot).translate(0, y + h / 2, 0);
const STEEL = 0x434a52, DARK = 0x23272c, LIGHT = 0x77808a;
const TEAM_HEX = { alpha: 0x3aa8e0, bravo: 0xe58a3c, neutral: 0xb8bcc2 };
let props = null;
/**
 * Shared prop geometries (module lifetime): the tripwire mine (y up, emitter lens at the top),
 * the tether pod and the incendiary canister, one per team for the team band.
 */
function propGeometry(kind, team) {
  props ??= new Map();
  const key = `${kind}:${team}`;
  if (props.has(key)) return props.get(key);
  const accent = TEAM_HEX[team] ?? TEAM_HEX.neutral;
  let g;
  if (kind === 'mine') {
    // A squat octagonal base with a team band, a pylon and the emitter head (lens at y 0.95).
    g = mergeColored([[prism(0.62, 0.5, 0.2, 8, 0, Math.PI / 8), DARK], [prism(0.52, 0.5, 0.08, 8, 0.2, Math.PI / 8), accent],
      [prism(0.46, 0.3, 0.16, 8, 0.28, Math.PI / 8), STEEL], [box(0.16, 0.42, 0.16, 0, 0.42, 0), LIGHT],
      [box(0.34, 0.2, 0.34, 0, 0.8, 0), STEEL], [box(0.4, 0.06, 0.4, 0, 0.78, 0), DARK],
      ...[0, 1, 2, 3].map(i => [box(0.12, 0.08, 0.5, Math.cos(i * Math.PI / 2) * 0.55, 0, Math.sin(i * Math.PI / 2) * 0.55).rotateY(i * Math.PI / 2), DARK])]);
  } else if (kind === 'pod') {
    // Tether pod: an octagonal drum on three spikes, a team ring, a dish emitter on top (y 1.0).
    g = mergeColored([...[0, 1, 2].map(i => [box(0.12, 0.5, 0.12, Math.cos(i * 2.094) * 0.42, 0, Math.sin(i * 2.094) * 0.42), DARK]),
      [prism(0.46, 0.5, 0.42, 8, 0.18, Math.PI / 8), STEEL], [prism(0.52, 0.52, 0.08, 8, 0.6, Math.PI / 8), accent],
      [prism(0.5, 0.3, 0.2, 8, 0.68, Math.PI / 8), STEEL], [prism(0.14, 0.26, 0.14, 8, 0.88, Math.PI / 8), LIGHT]]);
  } else {
    // Incendiary canister: a hazard-banded drum with a valve head (pilot lamp at y 1.42).
    g = mergeColored([[prism(0.5, 0.5, 0.12, 10, 0, 0), DARK], [prism(0.46, 0.46, 1.0, 10, 0.12, 0), 0x3b322b],
      [prism(0.48, 0.48, 0.12, 10, 0.3, 0), 0xd2691e], [prism(0.48, 0.48, 0.12, 10, 0.78, 0), 0xd2691e],
      [prism(0.48, 0.48, 0.05, 10, 0.55, 0), accent], [prism(0.3, 0.18, 0.16, 10, 1.12, 0), STEEL],
      [box(0.12, 0.16, 0.12, 0, 1.28, 0), LIGHT], [box(0.4, 0.06, 0.08, 0, 1.3, 0), DARK]]);
  }
  props.set(key, g);
  return g;
}

// ---- module state -------------------------------------------------------------------------------

const sink = { scene: null, fx: null, getBlock: null, view: null, shake: null, camera: null, selfId: () => null };
const deployables = new Map();   // id -> deployable (mines, pod, canister) and its cable
const lines = new Set();         // ground lines
const shots = new Set();         // transient rays and flashes (ability shots, blasts, blinks, impacts)
const rings = new Set();         // shock rings
const swings = new Map();        // vehicleId -> melee / execution swing
const caught = new Map();        // vehicleId -> rounds orbiting a raised vortex
let rays = null, flares = null, root = null, clock = 0;
let materialProp = null;
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const DOWN = new THREE.Vector3(0, -1, 0);

/** World sinks: { scene (effects group), fx (ParticleField), getBlock, view (VehicleView), shake, camera, selfId() }. */
export function setSinks({ scene = null, fx = null, getBlock = null, view = null, shake = null, camera = null, selfId = null } = {}) {
  if (scene !== sink.scene) clear();
  Object.assign(sink, { scene: scene || null, fx: fx || null, getBlock: typeof getBlock === 'function' ? getBlock : null,
    view: view || null, shake: shake || null, camera: camera || null, selfId: typeof selfId === 'function' ? selfId : () => null });
  if (sink.scene) sink.scene.add(warmupRoot());
  else warmup?.removeFromParent();
}

function ensureRoot() {
  if (!sink.scene) return null;
  if (!root) {
    root = new THREE.Group();
    root.name = 'titan-ability-events';
    rays = new RayBatch(TITAN_EVENT_FX.maxRays);
    flares = new FlareBatch(TITAN_EVENT_FX.maxFlares);
    root.add(rays.mesh, flares.mesh);
  }
  if (root.parent !== sink.scene) sink.scene.add(root);
  return root;
}

const emit = (kind, pos, params) => sink.fx?.emit?.(kind, pos, params);
const itemOf = id => (id == null ? null : sink.view?.item?.(id) ?? null);
const teamOfItem = item => item?.row?.team ?? item?.team ?? 'neutral';
function isSelfItem(item) {
  const self = sink.selfId?.();
  if (self == null || !item?.row) return false;
  return String(vehicleOccupiedSeats(item.row).find(seat => seat.id === 'driver')?.occupantId) === String(self);
}
/** Camera shake falling off with distance (full for the own titan). */
function shakeAt(pos, near, range, self = false, selfTrauma = near) {
  if (!sink.shake?.add) return;
  if (self) { sink.shake.add(selfTrauma); return; }
  const cam = sink.camera?.position;
  if (!cam) return;
  const d = Math.hypot(cam.x - pos[0], cam.y - pos[1], cam.z - pos[2]);
  if (d < range) sink.shake.add(near * (1 - d / range) ** 2);
}
/** Seconds an event's effect lasts: `until - at` (engine ms), else the fallback. */
function lifeOf(event, fallback) {
  const at = finite(event.at, NaN), until = finite(event.until, NaN);
  return Number.isFinite(at) && Number.isFinite(until) ? Math.max(0, (until - at) / 1000) : fallback;
}
const solidAt = (x, y, z) => !!sink.getBlock && isSolidBlock(sink.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)));
/**
 * The server's surfaceNear (titan-abilities.js): the first solid voxel in the column from
 * `y + rise` down to `y - fall` with air above it, as the y of its top face; a wall taller than
 * the rise (solid above the first solid) is null.
 */
export function surfaceNear(x, z, y, rise, fall) {
  for (let by = Math.floor(y + rise); by >= Math.floor(y - fall); by--) {
    if (!solidAt(x, by + 0.5, z)) continue;
    return solidAt(x, by + 1.5, z) || by + 1 > y + rise + 1e-6 ? null : by + 1;
  }
  return null;
}
/** Top of the ground under (x, z) near y (12 m down), else y. */
function groundAt(x, y, z) {
  if (!sink.getBlock) return y;
  for (let by = Math.floor(y + 1); by >= Math.floor(y - 12); by--) if (solidAt(x, by + 0.5, z)) return by + 1;
  return y;
}

// ---- deployables ------------------------------------------------------------------------------

function propMesh(kind, team, at) {
  materialProp ??= propMaterial();
  const mesh = new THREE.Mesh(propGeometry(kind, team), materialProp);
  mesh.name = `titan-${kind}`;
  mesh.position.set(at[0], at[1], at[2]);
  mesh.castShadow = true; mesh.receiveShadow = false;
  ensureRoot()?.add(mesh);
  return mesh;
}
function groundRing(at, radius, color, opacity) {
  const mesh = new THREE.Mesh(new THREE.RingGeometry(radius - 0.12, radius, 48).rotateX(-Math.PI / 2), ringMaterial(color, opacity));
  mesh.name = 'titan-trap-ring';
  mesh.position.set(at[0], at[1] + 0.05, at[2]);
  mesh.renderOrder = 4;
  ensureRoot()?.add(mesh);
  return mesh;
}
function dropDeployable(item) {
  for (const mesh of item.meshes) { mesh.removeFromParent(); if (mesh.name === 'titan-trap-ring') { mesh.geometry.dispose(); mesh.material.dispose(); } }
  deployables.delete(item.id);
}
function place(event, kind, points, life) {
  if (!ensureRoot() || event.id == null) return null;
  const old = deployables.get(String(event.id));
  if (old) dropDeployable(old);
  const source = itemOf(event.vehicleId), team = teamOfItem(source);
  const item = { id: String(event.id), kind, vehicleId: event.vehicleId, team, points, age: 0, life: life + 0.5, meshes: [],
    color: TEAM_FX_COLORS[team] || TEAM_FX_COLORS.neutral };
  const prop = kind === 'tripwire' ? 'mine' : kind === 'tether' ? 'pod' : 'canister';
  for (const p of points) {
    const mesh = propMesh(prop, team, p);
    mesh.rotation.y = finite(source?.root?.rotation?.y);
    mesh.scale.set(1, 0.01, 1);
    item.meshes.push(mesh);
    emit('dust', [p[0], p[1] + 0.1, p[2]], { count: 5, dir: [0, 1, 0], speed: 1.4, scale: 0.7, ground: p[1] });
    emit('spark', [p[0], p[1] + 0.5, p[2]], { count: 6, speed: 2, spread: 1.2, color0: kind === 'incendiary' ? [2.4, 1.2, 0.4] : [0.8, 1.9, 2.6],
      color1: kind === 'incendiary' ? [1.2, 0.4, 0.1] : [0.2, 0.6, 1.6] });
  }
  if (kind === 'tether') item.meshes.push(groundRing(points[0], TITAN_EVENT_FX.tether.triggerRadius, [0.25, 0.75, 1.4], 0.3));
  if (kind === 'incendiary') item.meshes.push(groundRing(points[0], TITAN_EVENT_FX.incendiary.igniteRadius, [1.2, 0.45, 0.1], 0.22));
  deployables.set(item.id, item);
  return item;
}

/** A blast: flash, fire, smoke, debris and a shock ring of `radius`. */
function blast(at, radius, { color = [2.2, 1.4, 0.6], fire = true, ring = [1.6, 0.9, 0.4], shake = 0.5 } = {}) {
  emit('fire', [at[0], at[1] + 0.8, at[2]], { count: 14, speed: 3.5, spread: Math.PI, scale: 2.4, life: 0.5, alpha: 0.85,
    color0: [2.4, 1.6, 0.8], color1: [1.3, 0.4, 0.08] });
  if (fire) emit('fire', [at[0], at[1] + 0.4, at[2]], { count: 10, dir: [0, 1, 0], speed: 2.2, spread: 0.7, scale: 1.6, life: 0.9, alpha: 0.6 });
  emit('smoke', [at[0], at[1] + 1, at[2]], { count: 10, dir: [0, 1, 0], speed: 2.2, scale: 1.4, alpha: 0.6 });
  emit('debris', [at[0], at[1] + 0.3, at[2]], { count: 12, dir: [0, 1, 0], speed: 1.2, spread: 0.9, ground: at[1] });
  emit('spark', [at[0], at[1] + 0.6, at[2]], { count: 24, speed: 1.4, spread: Math.PI });
  emit('dust', [at[0], at[1] + 0.2, at[2]], { count: 8, dir: [0, 1, 0], speed: 3, spread: 1.4, scale: 2, ground: at[1] });
  shots.add({ kind: 'flash', at: [at[0], at[1] + 1, at[2]], radius: radius * 0.9, color, age: 0, life: 0.32 });
  if (ensureRoot()) {
    // A thin shock ring racing out over the ground, and the burn it leaves (fades over seconds).
    const ground = groundAt(at[0], at[1] + 0.5, at[2]);
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.84, 1, 56).rotateX(-Math.PI / 2), ringMaterial(ring, 0.6));
    mesh.position.set(at[0], ground + 0.08, at[2]);
    mesh.renderOrder = 4;
    root.add(mesh);
    rings.add({ mesh, radius, age: 0, life: 0.34, peak: 0.6 });
    if ([...rings].filter(r => r.decal).length < TITAN_EVENT_FX.maxDecals) {
      const burn = new THREE.Mesh(burnGeometry(radius * 0.5), burnMaterial());
      burn.position.set(at[0], ground + 0.04, at[2]);
      burn.rotation.y = Math.random() * Math.PI;
      root.add(burn);
      rings.add({ mesh: burn, radius, age: 0, life: 8, decal: true, peak: burn.material.opacity });
    }
  }
  shakeAt(at, shake, 40);
}

// ---- ground lines -----------------------------------------------------------------------------

function lineGeometry(max, strip) {
  // `strip`: a flat ribbon (2 verts per point); otherwise the fire sheets: a vertical sheet
  // and a V of two tilted ones (2 verts per point each) so the fire reads end-on too.
  const sheets = strip ? 1 : 3, verts = max * 2 * sheets;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(verts * 2), 2).setUsage(THREE.DynamicDrawUsage));
  if (strip) {
    g.setAttribute('aBirth', new THREE.BufferAttribute(new Float32Array(verts), 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aRib', new THREE.BufferAttribute(new Float32Array(verts * 2), 2).setUsage(THREE.DynamicDrawUsage));
  }
  const index = [];
  for (let s = 0; s < sheets; s++) for (let i = 0; i + 1 < max; i++) {
    const a = s * max * 2 + i * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  g.setIndex(index);
  g.setDrawRange(0, 0);
  return g;
}

/** A ground line event: firewall, arcWave, flameCore. */
function startLine(event, kind) {
  const start = [finite(event.x, NaN), finite(event.y, NaN), finite(event.z, NaN)];
  if (!start.every(Number.isFinite) || !ensureRoot()) return null;
  if (lines.size >= TITAN_EVENT_FX.maxLines) dropLine([...lines][0]);
  const R = TITAN_EVENT_FX[kind], yaw = finite(event.yaw), length = Math.max(1, finite(event.length, 30));
  const life = lifeOf(event, kind === 'firewall' ? 6 : length / R.speed + 0.2);
  const max = Math.ceil(length / Math.min(TITAN_EVENT_FX.line.sample, R.speed / TITAN_EVENT_FX.line.tickHz)) + 3;
  const source = itemOf(event.vehicleId);
  if (source) source.titanEventLines = clock;
  const line = { kind, vehicleId: event.vehicleId, dx: -Math.sin(yaw), dz: -Math.cos(yaw), yaw, length, speed: R.speed, width: R.width,
    points: [start], births: [clock], dists: [0], travelled: 0, ticks: 0, stopped: false, born: clock, age: 0, life,
    linger: kind === 'flameCore' ? R.linger : kind === 'firewall' ? R.fade : TITAN_EVENT_FX.arcWave.trail, max, meshes: [], dirty: true, boltAt: -1, bolts: [] };
  const trail = new THREE.Mesh(lineGeometry(max, true), kind === 'arcWave'
    ? trailMaterial(ARC.map(c => c * 0.6), { fade: TITAN_EVENT_FX.arcWave.trail, head: 1 })
    : trailMaterial([1.0, 0.42, 0.1], { additive: false, fade: kind === 'firewall' ? life : 0.8, head: 1 }));
  trail.name = `titan-${kind}-trail`;
  line.trail = trail;
  line.meshes.push(trail);
  if (kind !== 'arcWave') {
    const scorch = new THREE.Mesh(trail.geometry, scorchMaterial());
    scorch.name = `titan-${kind}-scorch`;
    line.scorch = scorch;
    const sheet = new THREE.Mesh(lineGeometry(max, false), fireMaterial());
    sheet.name = `titan-${kind}-fire`;
    line.sheet = sheet;
    line.meshes.push(scorch, sheet);
  }
  for (const mesh of line.meshes) { mesh.frustumCulled = false; mesh.renderOrder = mesh === line.sheet ? 4 : 3; root.add(mesh); }
  lines.add(line);
  advanceLine(line);
  return line;
}

/**
 * Advance the head along the ground exactly like the server's stepLines: per server tick a
 * budget of speed / tickHz metres in steps of at most `sample` m, each step's height from
 * surfaceNear (rise / fall), stopping at a taller wall or at the line's length.
 */
function advanceLine(line) {
  const L = TITAN_EVENT_FX.line;
  const goal = Math.floor(line.age * L.tickHz + 1e-9) + 1;
  while (!line.stopped && line.ticks < goal) {
    line.ticks++;
    let budget = line.speed / L.tickHz;
    while (budget > 1e-9 && !line.stopped) {
      const step = Math.min(L.sample, budget, line.length - line.travelled);
      if (!(step > 1e-9)) { line.stopped = true; break; }
      const last = line.points[line.points.length - 1];
      const nx = last[0] + line.dx * step, nz = last[2] + line.dz * step;
      const ny = sink.getBlock ? surfaceNear(nx, nz, last[1], L.rise, L.fall) : last[1];
      if (ny == null) { line.stopped = true; break; }
      line.travelled += step; budget -= step;
      line.points.push([nx, ny, nz]);
      line.births.push(line.born + line.travelled / line.speed);
      line.dists.push(line.travelled);
      line.dirty = true;
      if (line.travelled >= line.length - 1e-6) line.stopped = true;
    }
  }
}

function writeLine(line) {
  if (!line.dirty) return;
  line.dirty = false;
  const n = Math.min(line.points.length, line.max);
  const rx = Math.cos(line.yaw), rz = -Math.sin(line.yaw), half = line.width;
  // Ground strip (glow + scorch), 6 cm over the surface.
  const g = line.trail.geometry, pos = g.attributes.position, uv = g.attributes.uv, birth = g.attributes.aBirth, rib = g.attributes.aRib;
  for (let i = 0; i < n; i++) {
    const p = line.points[i], along = line.dists[i];
    for (const s of [0, 1]) {
      const side = s ? 1 : -1, j = i * 2 + s;
      pos.setXYZ(j, p[0] + rx * side * half, p[1] + 0.06, p[2] + rz * side * half);
      uv.setXY(j, s, along / line.length);
      birth.setX(j, line.births[i]); rib.setXY(j, side, along);
    }
  }
  for (const a of [pos, uv, birth, rib]) a.needsUpdate = true;
  g.setDrawRange(0, Math.max(0, n - 1) * 6);
  g.computeBoundingSphere();
  if (line.sheet) {
    // Fire sheets: vertical at the centre, then a V tilted ±55° (70 % tall) on the same base.
    const R = TITAN_EVENT_FX[line.kind], f = line.sheet.geometry, fp = f.attributes.position, fu = f.attributes.uv, m = line.max;
    const tilt = [[0, 1], [Math.sin(0.96) * 0.7, Math.cos(0.96) * 0.7], [-Math.sin(0.96) * 0.7, Math.cos(0.96) * 0.7]];
    tilt.forEach(([out, up], s) => {
      for (let i = 0; i < n; i++) {
        const p = line.points[i], u = line.dists[i] / line.length + s * 0.37;
        const j = s * m * 2 + i * 2;
        fp.setXYZ(j, p[0], p[1] + 0.05, p[2]);
        fp.setXYZ(j + 1, p[0] + rx * out * R.sheet, p[1] + 0.05 + up * R.sheet, p[2] + rz * out * R.sheet);
        fu.setXY(j, u, 0); fu.setXY(j + 1, u, 1);
      }
    });
    fp.needsUpdate = true; fu.needsUpdate = true;
    // Index runs per sheet over `max` points: draw the full index, unreached quads collapse onto
    // the last written point (zeroed below), so they are degenerate.
    for (let s = 0; s < 3; s++) for (let i = n; i < m; i++) {
      const p = line.points[n - 1], j = s * m * 2 + i * 2;
      fp.setXYZ(j, p[0], p[1], p[2]); fp.setXYZ(j + 1, p[0], p[1], p[2]);
    }
    f.setDrawRange(0, 3 * (m - 1) * 6);
    f.computeBoundingSphere();
  }
}

function dropLine(line) {
  for (const mesh of line.meshes) {
    mesh.removeFromParent();
    if (mesh !== line.scorch) mesh.geometry.dispose();
    mesh.material.dispose();
  }
  lines.delete(line);
}

/** Jagged lightning from `a` to `b` (n segments, `amp` m offsets) into the ray batch. */
function bolt(a, b, n, amp, width, color, alpha, seed) {
  const pts = [a];
  for (let i = 1; i < n; i++) {
    const k = i / n, w = Math.sin(Math.PI * k) * amp;
    pts.push([a[0] + (b[0] - a[0]) * k + (Math.random() - 0.5) * 2 * w, a[1] + (b[1] - a[1]) * k + (Math.random() - 0.5) * 2 * w,
      a[2] + (b[2] - a[2]) * k + (Math.random() - 0.5) * 2 * w]);
  }
  pts.push(b);
  rays.polyline(pts, width, color, alpha, alpha, seed);
}

function stepLine(line, dt) {
  line.age += dt;
  advanceLine(line);
  writeLine(line);
  const left = line.life - line.age, R = TITAN_EVENT_FX[line.kind];
  const head = line.points[line.points.length - 1], moving = !line.stopped;
  const fade = line.kind === 'arcWave' ? 1 : clamp((left + line.linger) / line.linger, 0, 1);
  line.trail.material.uniforms.uNow.value = clock;
  line.trail.material.uniforms.uTime.value = clock;
  line.trail.material.uniforms.uOpacity.value = line.kind === 'arcWave' ? 1 : 0.85 * fade;
  line.trail.material.uniforms.uHead.value = moving ? 1 : 0;
  if (line.scorch) line.scorch.material.opacity = 0.55 * Math.min(1, fade * 2);
  if (line.sheet) {
    const u = line.sheet.material.uniforms;
    u.uTime.value = clock + (line.kind === 'flameCore' ? 0 : 1.7);
    // The Flame Core wave burns down behind its head; the firewall burns for its whole life.
    u.uOpacity.value = fade * (line.kind === 'flameCore' ? 0.95 : 0.9);
  }
  const span = line.points.length;
  if (line.kind === 'arcWave') {
    // The arc blade: bolts rising from the head across the line's width, a head flare, sparks;
    // a few short crackles linger along the last 8 m.
    if (left > -line.linger) {
      const rx = Math.cos(line.yaw), rz = -Math.sin(line.yaw), k = moving ? 1 : clamp(1 + left / line.linger, 0, 1);
      if (clock - line.boltAt > 0.045 || !line.bolts.length) {
        line.boltAt = clock;
        line.bolts = [];
        for (let i = 0; i < TITAN_EVENT_FX.arcWave.bolts; i++) {
          const s = (Math.random() * 2 - 1) * R.width;
          const base = [head[0] + rx * s, head[1] + 0.05, head[2] + rz * s];
          const h = R.height * (0.55 + 0.45 * Math.random());
          line.bolts.push([base, [base[0] + line.dx * 0.6 * Math.random(), base[1] + h, base[2] + line.dz * 0.6 * Math.random()], i]);
        }
        for (let i = 0; i < 3 && span > 2; i++) {
          const a = line.points[Math.max(0, span - 2 - Math.floor(Math.random() * Math.min(8, span - 1)))];
          line.bolts.push([[a[0] + rx * (Math.random() - 0.5) * 2, a[1] + 0.05, a[2] + rz * (Math.random() - 0.5) * 2],
            [a[0] + rx * (Math.random() - 0.5) * 2, a[1] + 0.6 + Math.random() * 1.2, a[2] + rz * (Math.random() - 0.5) * 2], 20 + i]);
        }
      }
      if (moving) for (const [a, b, i] of line.bolts) bolt(a, b, 6, 0.35, i < 20 ? 0.16 : 0.1, ARC, (i < 20 ? 1 : 0.6) * k, i * 7.1);
      if (moving) {
        flares.add([head[0], head[1] + 1.4, head[2]], 2.6, ARC.map(c => c * 0.7), 0.9);
        emit('spark', [head[0], head[1] + 0.4, head[2]], { count: 3, speed: 1.4, spread: 1.1, color0: [0.8, 1.8, 3], color1: [0.3, 0.6, 2] });
        if (Math.random() < 0.5) emit('dust', [head[0], head[1] + 0.1, head[2]], { count: 1, dir: [line.dx, 0.3, line.dz], speed: 2, scale: 1.2, ground: head[1] });
      }
    }
  } else {
    // Fire: puffs and embers along the burning length (the firewall all of it, the core wave
    // the last 8 m behind its head), a taller fire front at a moving head, a smoke veil.
    const from = line.kind === 'flameCore' && moving ? Math.max(0, span - 9) : 0;
    const count = Math.max(0, span - from);
    if (fade > 0.05 && count > 0) {
      line.carry = (line.carry || 0) + dt * count * (line.kind === 'flameCore' ? 3.2 : 1.6) * fade;
      for (; line.carry >= 1; line.carry--) {
        const p = line.points[from + Math.floor(Math.random() * count)];
        const side = (Math.random() * 2 - 1) * line.width * 0.6, rx = Math.cos(line.yaw), rz = -Math.sin(line.yaw);
        const at = [p[0] + rx * side, p[1] + 0.6, p[2] + rz * side];
        if (Math.random() < 0.65) {
          const lick = Math.random() < 0.33;
          emit('fire', lick ? [at[0], at[1] + 0.7, at[2]] : at, { count: 1, dir: [0, 1, 0], speed: 1.8, scale: lick ? 1.2 : 1.8, life: 1.1, alpha: 0.5,
            color0: (lick ? TITAN_FLAME.body : TITAN_FLAME.core).map(c => c * TITAN_FLAME.gain), color1: (lick ? TITAN_FLAME.tip : TITAN_FLAME.body).map(c => c * TITAN_FLAME.gain) });
        } else emit('ember', at, { count: 2, speed: 1, dir: [0, 1, 0] });
        if (Math.random() < 0.12) emit('smoke', [at[0], at[1] + 2.6, at[2]], { count: 1, dir: [0, 1, 0], speed: 0.9, scale: 0.8, alpha: 0.4,
          color0: [0.16, 0.11, 0.08], color1: [0.08, 0.07, 0.06] });
      }
    }
    if (moving) {
      const tall = line.kind === 'flameCore' ? 3.2 : 2.2;
      emit('fire', [head[0], head[1] + 0.8, head[2]], { count: 2, dir: [line.dx * 0.3, 1, line.dz * 0.3], speed: 3, spread: 0.5, scale: tall, life: 0.6, alpha: 0.7,
        color0: TITAN_FLAME.core, color1: TITAN_FLAME.body });
      flares.add([head[0], head[1] + 1.2, head[2]], tall * 0.9, FIRE.map(c => c * 0.55), 0.7);
    }
  }
  return left + line.linger > 0;
}

// ---- melee and execution --------------------------------------------------------------------

function startSwing(vehicleId, kind, target = null) {
  const key = String(vehicleId), item = itemOf(vehicleId);
  if (!item?.model?.nodes?.upperL) return null;
  const now = swings.get(key);
  if (now && now.age < 0.2 && (kind === 'melee' || now.kind === 'execution')) {
    if (target != null && now.target == null) now.target = target;
    return now;
  }
  const M = TITAN_EVENT_FX.melee;
  const swing = { key, kind, target: target != null ? String(target) : null, age: 0, dur: kind === 'execution' ? M.executionSeconds : M.seconds,
    struck: false, ripped: false, at: null, self: isSelfItem(item), ronin: item.kind === 'titan_ronin' };
  swings.set(key, swing);
  return swing;
}

/** Point on the target hull facing the attacker (chest height), or null. */
function strikePoint(attacker, targetId) {
  const target = itemOf(targetId);
  if (!target?.root) return null;
  const f = titanFrame(target.kind), p = target.root.position, a = attacker.root.position;
  const dx = a.x - p.x, dz = a.z - p.z, d = Math.hypot(dx, dz) || 1, r = f ? f.hw : 1.5;
  const cockpit = target.model?.anchors?.cockpit;
  if (cockpit && target.model.titanRig) { cockpit.getWorldPosition(_v); return [_v.x + dx / d * 0.6, _v.y, _v.z + dz / d * 0.6]; }
  return [p.x + dx / d * r, p.y + (f ? f.height * 0.62 : 4), p.z + dz / d * r];
}

/** Keys of the left-arm punch: upper-arm direction (torso frame), elbow bend, torso twist. */
const PUNCH = Object.freeze({
  wind: Object.freeze({ dir: [-0.42, -0.42, 0.8], elbow: 1.9, twist: 0.32 }),
  strike: Object.freeze({ dir: [0.22, 0.02, -1], elbow: 0.12, twist: -0.3 }),
});
/** Swing weights at time k (s): wind 0→1, strike 0→1 (and hold), recover. */
function swingKeys(swing) {
  const M = TITAN_EVENT_FX.melee, t = swing.age;
  if (swing.kind === 'execution') {
    // Wind, strike into the cockpit, hold (the hand inside), rip back, recover.
    const s = M.executionStrike, r = M.executionRip, d = swing.dur;
    if (t < s - 0.12) return { wind: smooth(t / (s - 0.12)), strike: 0, on: smooth(t / 0.12) };
    if (t < s) return { wind: 1 - smooth((t - (s - 0.12)) / 0.12), strike: smooth((t - (s - 0.12)) / 0.12), on: 1 };
    if (t < r) return { wind: 0, strike: 1, on: 1 };
    if (t < r + 0.18) { const k = smooth((t - r) / 0.18); return { wind: k, strike: 1 - k, on: 1 }; }
    return { wind: 1, strike: 0, on: 1 - smooth((t - r - 0.18) / Math.max(0.05, d - r - 0.18)) };
  }
  const s = M.strike, d = swing.dur;
  if (t < s - 0.08) return { wind: smooth(t / (s - 0.08)), strike: 0, on: smooth(t / 0.08) };
  if (t < s) return { wind: 1 - smooth((t - (s - 0.08)) / 0.08), strike: smooth((t - (s - 0.08)) / 0.08), on: 1 };
  if (t < s + 0.12) return { wind: 0, strike: 1, on: 1 };
  return { wind: 0, strike: 1, on: 1 - smooth((t - s - 0.12) / Math.max(0.05, d - s - 0.12)) };
}

/** Pose the left arm and torso of one swinging titan over the rig's own pose (presentation only). */
function poseSwing(item, swing) {
  const n = item.model.nodes, k = swingKeys(swing);
  if (!(k.on > 0)) return;
  const dir = (key, out) => out.set(...PUNCH[key].dir).normalize();
  const target = _w.copy(dir('wind', _v)).multiplyScalar(k.wind).addScaledVector(dir('strike', _v), k.strike);
  if (target.lengthSq() < 1e-4) target.copy(DOWN);
  target.normalize();
  _q.setFromUnitVectors(DOWN, target);
  n.upperL.quaternion.slerp(_q, k.on);
  const elbow = PUNCH.wind.elbow * k.wind + PUNCH.strike.elbow * k.strike;
  const sign = Math.sign(n.foreL.rotation.x) || 1;
  n.foreL.rotation.x += (sign * elbow - n.foreL.rotation.x) * k.on;
  // Fist: knuckles forward on the strike.
  _q2.setFromAxisAngle(_v.set(1, 0, 0), -0.5 * k.strike);
  n.handL.quaternion.slerp(_q2, k.on * 0.6);
  n.torso.rotation.y += (PUNCH.wind.twist * k.wind + PUNCH.strike.twist * k.strike) * k.on;
  n.torso.updateMatrixWorld(true);
}

function stepSwing(swing, dt) {
  swing.age += dt;
  const attacker = itemOf(swing.key);
  if (!attacker?.model?.nodes || swing.age > swing.dur) return false;
  const M = TITAN_EVENT_FX.melee, strikeAt = swing.kind === 'execution' ? M.executionStrike : M.strike;
  const fist = attacker.model.nodes.handL.getWorldPosition(new THREE.Vector3()).toArray();
  // The slash: a fading arc through the fist's last positions (cyan blade on RONIN).
  swing.trail ??= [];
  const k = swingKeys(swing);
  if (k.strike > 0.05 && k.strike < 0.999 || (swing.age > strikeAt - 0.1 && swing.age < strikeAt + 0.08)) swing.trail.push({ p: fist, t: swing.age });
  swing.trail = swing.trail.filter(s => swing.age - s.t < 0.16);
  if (swing.trail.length > 1) {
    const color = swing.ronin ? [0.4, 0.9, 2.0] : [1.1, 1.1, 1.2];
    rays.polyline(swing.trail.map(s => s.p), swing.ronin ? 1.4 : 0.9, color, 0.05, swing.ronin ? 0.8 : 0.45, 3);
  }
  if (!swing.struck && swing.age >= strikeAt) {
    swing.struck = true;
    swing.at = swing.target != null ? strikePoint(attacker, swing.target) : null;
    if (swing.at) {
      const big = swing.kind === 'execution';
      emit('spark', swing.at, { count: big ? 40 : 26, speed: 1.3, spread: 1.2 });
      emit('debris', swing.at, { count: big ? 14 : 8, speed: 0.8, spread: 1.2 });
      emit('smoke', swing.at, { count: 4, speed: 1.2, scale: 1.1 });
      shots.add({ kind: 'flash', at: swing.at, radius: big ? 2.6 : 1.9, color: [1.8, 1.6, 1.3], age: 0, life: 0.18 });
      shakeAt(swing.at, big ? 0.5 : 0.3, 30, swing.self, big ? 0.45 : 0.28);
    } else if (swing.self) sink.shake?.add?.(0.08);
  }
  if (swing.kind === 'execution' && swing.at) {
    // Inside the hull: a spark stream from the torn hatch while the hand rips, then the pilot is
    // torn out (fire, smoke and a hard flash).
    if (swing.age > strikeAt && swing.age < M.executionRip) emit('spark', swing.at, { count: 2, speed: 1, spread: 1.4 });
    if (!swing.ripped && swing.age >= M.executionRip) {
      swing.ripped = true;
      emit('fire', swing.at, { count: 16, speed: 2.4, spread: 1.6, scale: 2.2, life: 0.6, color0: [2.4, 1.6, 0.8], color1: [1.3, 0.4, 0.08] });
      emit('spark', swing.at, { count: 48, speed: 1.6, spread: Math.PI });
      emit('smoke', swing.at, { count: 10, speed: 2, scale: 1.6 });
      emit('debris', swing.at, { count: 18, speed: 1.2, spread: 1.4 });
      shots.add({ kind: 'flash', at: swing.at, radius: 4.2, color: [2.2, 1.5, 0.8], age: 0, life: 0.3 });
      shakeAt(swing.at, 0.7, 40, swing.self, 0.6);
    }
  }
  return true;
}

// ---- shots (ability rays) -------------------------------------------------------------------

function addRays(event) {
  const o = vec(event.o);
  if (!o) return;
  const paths = (Array.isArray(event.paths) ? event.paths : []).map(path => vec(Array.isArray(path) ? path[0]?.end : null)).filter(Boolean);
  if (!paths.length) return;
  const S = TITAN_EVENT_FX.shot;
  const look = event.ability === 'laserShot' ? S.laserShot : event.ability === 'vortexThrow' ? S.vortexThrow
    : paths.length > 1 ? S.powerShotClose : S.powerShotLong;
  const hits = (Array.isArray(event.paths) ? event.paths : []).map(path => !!(Array.isArray(path) && path[0]?.hit));
  shots.add({ kind: 'rays', o, ends: paths, hits, look, age: 0, life: look.life, ability: event.ability, seed: Math.random() * 100 });
  // Sparks at every end, a heavier burst for the single beams.
  for (const end of paths) {
    const d = [o[0] - end[0], o[1] - end[1], o[2] - end[2]], l = Math.hypot(...d) || 1;
    emit('spark', end, { count: paths.length > 1 ? 4 : 16, dir: d.map(c => c / l), speed: 1.2, spread: 1.1,
      color0: look.color.map(c => c * 1.4), color1: look.color.map(c => c * 0.6) });
  }
  if (event.ability === 'laserShot' || paths.length === 1) {
    emit('smoke', paths[0], { count: 3, speed: 0.8, scale: 0.8, alpha: 0.5 });
  }
  const item = itemOf(event.vehicleId);
  if (isSelfItem(item)) sink.shake?.add?.(event.ability === 'vortexThrow' ? 0.12 : 0.2);
  if (event.ability === 'vortexThrow') caught.delete(String(event.vehicleId));
}

function stepShot(shot, dt) {
  shot.age += dt;
  const k = 1 - shot.age / shot.life;
  if (k <= 0) return false;
  if (shot.kind === 'flash') {
    flares.add(shot.at, shot.radius * (0.7 + 0.3 * k), shot.color, k * k);
    return true;
  }
  if (shot.kind === 'blink') {
    const a = shot.from, b = shot.to;
    for (let i = 0; i < 3; i++) rays.add([a[0], a[1] + 1.5 + i * 1.6, a[2]], [b[0], b[1] + 1.5 + i * 1.6, b[2]], 1.2 - i * 0.25, ARC, 0.5 * k, 1, 1, i);
    flares.add([a[0], a[1] + 3, a[2]], 3.2 * k, ARC, k);
    flares.add([b[0], b[1] + 3, b[2]], 3.6 * (0.6 + 0.4 * k), ARC, k);
    return true;
  }
  // Rays: full width at the shot, thinning as they fade (a hot white core first).
  const { o, ends, look } = shot, w = look.width * (0.35 + 0.65 * k);
  ends.forEach((end, i) => {
    rays.add(o, end, w, look.color, k, 0.4, 0.1, shot.seed + i);
    if (shot.ability !== 'vortexThrow' && i === 0) rays.add(o, end, w * 2.6, look.color.map(c => c * 0.35), k * k * 0.6, 0.4, 0.1, shot.seed + 50);
  });
  flares.add(o, (shot.ability === 'laserShot' ? 1.6 : 1.1) * (0.5 + 0.5 * k), look.color, k);
  ends.forEach((end, i) => { if (shot.hits[i] || ends.length === 1) flares.add(end, (ends.length > 1 ? 0.8 : 1.5) * (0.5 + 0.5 * k), look.color, k); });
  return true;
}

/** Hitscan paths ending inside a raised vortex sphere: rounds the vortex holds until the throw. */
function catchRounds(event) {
  const paths = Array.isArray(event.paths) ? event.paths : null;
  if (!paths || event.ability === 'vortexThrow') return;
  for (const [id, state] of caught) {
    if (String(event.vehicleId) === id) continue;
    const item = itemOf(id), sphere = state.sphere;
    if (!item || !sphere) continue;
    for (const path of paths) {
      const end = vec(Array.isArray(path) ? path[0]?.end : null);
      if (!end || dist3(end, sphere) > sphere[3] + 0.4 || state.rounds.length >= TITAN_EVENT_FX.maxCaught) continue;
      // Where it met the dish, in the dish frame (radius, angle), then it orbits inward.
      _v.set(end[0] - sphere[0], end[1] - sphere[1], end[2] - sphere[2]);
      const local = _v.applyQuaternion(_q.copy(state.quat).invert());
      state.rounds.push({ r: Math.min(sphere[3] * 0.92, Math.hypot(local.x, local.y)), a: Math.atan2(local.y, local.x), spin: 1.5 + Math.random() * 1.5,
        color: event.vehicleWeapon === 'splitter' || event.vehicleWeapon === 'railgun' ? [0.4, 1.0, 1.9] : [1.8, 0.95, 0.35] });
      emit('spark', end, { count: 6, speed: 0.6, spread: Math.PI, color0: [0.8, 1.9, 2.6], color1: [0.2, 0.6, 1.6] });
    }
  }
}

/** Track every ION with its vortex up (sphere from the server's guardSphere) and draw its rounds. */
function stepCaught(dt) {
  for (const [id, state] of [...caught]) {
    const item = itemOf(id);
    const row = item?.row, bits = Array.isArray(row?.tw) ? row.tw[4] | 0 : 0;
    if (!item || item.wreck || !(bits & 2)) { caught.delete(id); continue; }
    state.sphere = guardSphere(item, row, 'vortex');
    if (!state.sphere) continue;
    const dir = aimOf(item, row);
    state.quat.setFromUnitVectors(_v.set(0, 0, -1), _w.set(...dir));
    for (const round of state.rounds) {
      round.a += round.spin * dt;
      round.r = Math.max(0.6, round.r - dt * 0.15);
      const p = _v.set(Math.cos(round.a) * round.r, Math.sin(round.a) * round.r, -0.25).applyQuaternion(state.quat);
      const q = _w.set(Math.cos(round.a - 0.18) * round.r, Math.sin(round.a - 0.18) * round.r, -0.25).applyQuaternion(state.quat);
      const s = state.sphere;
      rays.add([s[0] + q.x, s[1] + q.y, s[2] + q.z], [s[0] + p.x, s[1] + p.y, s[2] + p.z], 0.3, round.color, 0.9, 0.15, 0, 9);
      flares.add([s[0] + p.x, s[1] + p.y, s[2] + p.z], 0.32, round.color, 0.8);
    }
  }
}
function aimOf(item, row) {
  const aim = Array.isArray(row?.mounts?.[0]) ? row.mounts[0] : null;
  const yaw = aim ? finite(aim[0]) : item.root.rotation.y, pitch = aim ? finite(aim[1]) : 0;
  return [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
}
/** Start tracking vortex catches for every ION whose defensive bit is up (row-driven). */
function watchVortices() {
  if (!sink.view?.items) return;
  for (const item of sink.view.items.values()) {
    if (item.kind !== 'titan_ion' || item.wreck) continue;
    const bits = Array.isArray(item.row?.tw) ? item.row.tw[4] | 0 : 0;
    const key = String(item.id);
    if (bits & 2 && !caught.has(key)) caught.set(key, { rounds: [], sphere: guardSphere(item, item.row, 'vortex'), quat: new THREE.Quaternion() });
  }
}

// ---- deployable frame step --------------------------------------------------------------------

function stepDeployable(item, dt) {
  item.age += dt;
  const pop = smooth(item.age / 0.25);
  for (const mesh of item.meshes) if (mesh.name !== 'titan-trap-ring') mesh.scale.set(1, Math.max(0.01, pop), 1);
  if (item.cable) {
    // The tether cable: a taut core and a crackling sheath from the pod to the caught hull.
    const target = itemOf(item.cable.target);
    if (target?.root && !target.wreck) {
      const f = titanFrame(target.kind);
      item.cable.to = [target.root.position.x, target.root.position.y + (f ? f.height * 0.38 : 2.5), target.root.position.z];
    }
    const a = [item.points[0][0], item.points[0][1] + 1.0, item.points[0][2]], b = item.cable.to;
    const k = clamp((item.cable.life - item.cable.age) / 0.3, 0, 1) * smooth(item.cable.age / 0.12);
    item.cable.age += dt;
    if (b && k > 0) {
      rays.add(a, b, 0.22, [0.6, 1.4, 2.4], k, 0, 0, 1);
      rays.add(a, b, 1.1, ION.map(c => c * 0.35), 0.4 * k, 0, 0, 2);   // soft sheath: reads at range
      if (clock - (item.cable.boltAt ?? -1) > 0.05) { item.cable.boltAt = clock; item.cable.seed = Math.random() * 100; }
      const saved = Math.random;
      let s = item.cable.seed;
      Math.random = () => { s = (s * 16807 + 0.5) % 2147483647; return (s % 1000) / 1000; };
      try {
        bolt(a, b, 10, 0.5, 0.16, ION, 0.85 * k, 4); bolt(a, b, 7, 0.35, 0.1, ION, 0.65 * k, 9);
        // The snare at the hull: short arcs crawling round the caught titan's hips.
        const hw = ((target ? titanFrame(target.kind)?.hw : null) ?? 1.6) * 1.05;
        for (let i = 0; i < 4; i++) {
          const t0 = s % 6.283 + i * 1.571, c0 = [b[0] + Math.cos(t0) * hw, b[1] - 0.4 + i * 0.25, b[2] + Math.sin(t0) * hw];
          bolt(c0, [b[0] + Math.cos(t0 + 1.2) * hw, b[1] - 0.2 + i * 0.25, b[2] + Math.sin(t0 + 1.2) * hw], 4, 0.25, 0.08, ION, 0.7 * k, 13 + i);
        }
      } finally { Math.random = saved; }
      flares.add(b, 1.8, ION, 0.8 * k);
      flares.add(a, 0.9, ION, 0.9 * k);
      if (Math.random() < 0.4) emit('spark', b, { count: 2, speed: 1, spread: Math.PI, color0: [0.8, 1.9, 2.6], color1: [0.2, 0.6, 1.6] });
    }
    if (item.cable.age >= item.cable.life) { dropDeployable(item); return; }
  }
  if (item.kind === 'tripwire' && !item.cable) {
    // Laser fence between the mine lenses, a bright pulse running along each beam, lens glows.
    const H = TITAN_EVENT_FX.tripwire.beamHeight * pop;
    const lens = item.points.map(p => [p[0], p[1] + H, p[2]]);
    for (let i = 0; i + 1 < lens.length; i++) {
      const a = lens[i], b = lens[i + 1];
      rays.add(a, b, TITAN_EVENT_FX.tripwire.beamWidth, ION, 0.85 * pop, 0, 0, i);
      rays.add(a, b, 0.6, ION.map(c => c * 0.3), 0.35 * pop, 0, 0, i + 5);
      const k = (item.age * 0.6 + i * 0.5) % 1, m = lerp3(a, b, k), n2 = lerp3(a, b, Math.min(1, k + 0.08));
      rays.add(m, n2, 0.3, ION, 0.9 * pop, 0.2, 0.2, i + 9);
    }
    const blink = 0.75 + 0.25 * Math.sin(item.age * 6);
    for (const p of lens) flares.add(p, 0.55 * blink, ION, pop);
  } else if (item.kind === 'tether' && !item.cable) {
    const p = item.points[0];
    for (let i = 0; i < 3; i++) {
      const on = Math.floor(item.age * 3) % 3 === i ? 1 : 0.35, a = i * 2.094 + item.age * 0.6;
      flares.add([p[0] + Math.cos(a) * 0.32, p[1] + 0.95, p[2] + Math.sin(a) * 0.32], 0.35, ION, on * pop);
    }
    const ring = item.meshes.find(m => m.name === 'titan-trap-ring');
    if (ring) ring.material.opacity = 0.18 + 0.1 * Math.sin(item.age * 3);
  } else if (item.kind === 'incendiary') {
    const p = item.points[0], on = Math.floor(item.age * 1.6) % 2 ? 1 : 0.25;
    flares.add([p[0], p[1] + 1.46, p[2]], 0.38, [1.8, 0.6, 0.12], on * pop);
    item.gas = (item.gas || 0) + dt * 2.5;
    for (; item.gas >= 1; item.gas--) emit('smoke', [p[0] + (Math.random() - 0.5) * 0.6, p[1] + 1.2, p[2] + (Math.random() - 0.5) * 0.6],
      { count: 1, dir: [0, 1, 0], speed: 0.4, scale: 0.5, alpha: 0.25, color0: [0.42, 0.36, 0.26], color1: [0.3, 0.28, 0.24] });
  }
  if (!item.cable && item.age > item.life) { dropDeployable(item); return; }
}

// ---- events ---------------------------------------------------------------------------------

/** One authoritative `titan_ability` event. Returns true when it produced an effect. */
export function onAbility(event) {
  if (!event || event.kind !== 'titan_ability' || !sink.scene) return false;
  switch (event.ability) {
    case 'tripwire': {
      const mines = (Array.isArray(event.mines) ? event.mines : []).map(vec).filter(Boolean);
      return mines.length >= 2 && !!place(event, 'tripwire', mines, lifeOf(event, 30));
    }
    case 'tripwireTrigger': {
      const item = deployables.get(String(event.id));
      const mines = (Array.isArray(event.mines) ? event.mines : []).map(vec).filter(Boolean);
      for (const m of mines.length ? mines : item?.points ?? []) blast([m[0], m[1] + 0.6, m[2]], TITAN_EVENT_FX.tripwire.blastRadius, { color: [1.2, 1.6, 2.2], ring: [0.6, 1.2, 2.0] });
      if (item) dropDeployable(item);
      return true;
    }
    case 'tether': {
      const at = vec([event.x, event.y, event.z]);
      if (!at) return false;
      return !!place(event, 'tether', [at], lifeOf(event, 30));
    }
    case 'tetherTrigger': {
      const item = deployables.get(String(event.id));
      if (!item) return false;
      item.cable = { target: event.target, age: 0, life: lifeOf(event, 3), to: null };
      const p = item.points[0];
      emit('spark', [p[0], p[1] + 1, p[2]], { count: 30, speed: 1.6, spread: Math.PI, color0: [0.8, 1.9, 2.6], color1: [0.2, 0.6, 1.6] });
      shots.add({ kind: 'flash', at: [p[0], p[1] + 1, p[2]], radius: 3, color: ION, age: 0, life: 0.25 });
      return true;
    }
    case 'incendiaryTrap': {
      const at = vec([event.x, event.y, event.z]);
      return !!at && !!place(event, 'incendiary', [at], lifeOf(event, 45));
    }
    case 'trapIgnite': {
      const item = deployables.get(String(event.id));
      const at = vec([event.x, event.y, event.z]) ?? item?.points[0];
      if (at) blast([at[0], at[1] + 0.5, at[2]], TITAN_ABILITIES.titan_scorch.tactical.radius, { color: [2.4, 1.2, 0.4], ring: [1.8, 0.6, 0.15], shake: 0.35 });
      if (at) {
        emit('ember', [at[0], at[1] + 1, at[2]], { count: 30, speed: 2.2, spread: 1.2, dir: [0, 1, 0] });
        // The gas cloud goes up at once over the whole trap radius (the server's fire cells follow).
        const R = TITAN_ABILITIES.titan_scorch.tactical.radius;
        for (let i = 0; i < 9; i++) {
          const a = i / 9 * Math.PI * 2 + Math.random() * 0.5, r = R * (0.35 + Math.random() * 0.45);
          const p = [at[0] + Math.cos(a) * r, groundAt(at[0] + Math.cos(a) * r, at[1] + 1, at[2] + Math.sin(a) * r) + 0.6, at[2] + Math.sin(a) * r];
          emit('fire', p, { count: 4, dir: [0, 1, 0], speed: 2.2, spread: 0.6, scale: 1.8, life: 0.9, alpha: 0.65 });
          emit('smoke', p, { count: 1, dir: [0, 1, 0], speed: 1.6, scale: 1.2, alpha: 0.45 });
        }
      }
      if (item) dropDeployable(item);
      return !!at;
    }
    case 'deployableEnd': {
      const item = deployables.get(String(event.id));
      if (!item) return false;
      // A sprung tether keeps its pod while the cable holds (the end comes in the trigger's tick).
      if (item.cable) return true;
      const p = item.points[0];
      emit('spark', [p[0], p[1] + 0.8, p[2]], { count: 8, speed: 1, spread: Math.PI, color0: [0.8, 1.6, 2.2], color1: [0.3, 0.5, 1.2] });
      emit('smoke', [p[0], p[1] + 0.5, p[2]], { count: 3, speed: 0.6, scale: 0.7 });
      dropDeployable(item);
      return true;
    }
    case 'firewall': case 'arcWave': case 'flameCore':
      return !!startLine(event, event.ability);
    case 'melee': {
      if (event.executed) return true;
      const swing = startSwing(event.vehicleId, 'melee', event.target ?? null);
      return !!swing;
    }
    case 'execution':
      return !!startSwing(event.vehicleId, 'execution', event.target ?? null);
    case 'phaseDash': {
      const item = itemOf(event.vehicleId), to = vec([event.x, event.y, event.z]);
      if (!to) return false;
      const from = item?.root ? [item.root.position.x, item.root.position.y, item.root.position.z] : to;
      // The presented hull jumps once the snapshot catches up: the feet go with it.
      item?.model?.rig?.teleport?.(0.35);
      shots.add({ kind: 'blink', from, to, age: 0, life: 0.35 });
      emit('spark', [to[0], to[1] + 3, to[2]], { count: 20, speed: 1.4, spread: Math.PI, color0: [0.8, 1.9, 2.6], color1: [0.2, 0.6, 1.6] });
      return true;
    }
    case 'modeSwitch': {
      const item = itemOf(event.vehicleId), muzzle = item?.model?.mounts ? Object.values(item.model.mounts)[0]?.muzzle : null;
      if (!muzzle) return false;
      emit('spark', muzzle.getWorldPosition(_v).toArray(), { count: 8, speed: 0.8, spread: Math.PI, color0: [2.2, 1.6, 0.6], color1: [1, 0.5, 0.1] });
      return true;
    }
    default: return false;
  }
}

/**
 * A vehicle `shoot` event (titan-presentation.js fans every shoot here): the ability rays
 * (`ability` set), the melee swing (`titanMelee`) and vortex catches of hitscan paths.
 */
export function onShoot(event) {
  if (!event || event.kind !== 'shoot' || !sink.scene) return false;
  watchVortices();
  if (event.vehicleWeapon === 'titanMelee' && event.vehicleId != null) return !!startSwing(event.vehicleId, 'melee');
  if (caught.size) catchRounds(event);
  if (event.ability === 'laserShot' || event.ability === 'powerShot' || event.ability === 'vortexThrow') {
    if (!ensureRoot()) return false;
    addRays(event);
    return true;
  }
  if (event.vehicleWeapon === 'railgun' && !event.ability) return ensureRoot() ? addRailBeam(event) : false;
  return false;
}

/**
 * The railgun's beam: one ray from the presented muzzle to the server's end point, its width and
 * life scaled by the shot's charge (`event.charge`), with a flare at a struck end. The shake, the
 * tracer, wake and impact burst are titan-weapon-feel.js and vehicle-fx.js.
 */
function addRailBeam(event) {
  const segment = Array.isArray(event.paths?.[0]) ? event.paths[0][0] : null;
  const end = vec(segment?.end);
  const o = vec(sink.view?.mountWorldPose?.(event.vehicleId, event.mount)?.origin ?? null) ?? vec(event.o);
  if (!o || !end) return false;
  const R = TITAN_EVENT_FX.shot.railgun, c = R.minCharge + (1 - R.minCharge) * clamp(finite(event.charge, 1), 0, 1);
  const look = { width: R.width * c, life: R.life * (0.5 + 0.5 * c), color: R.color };
  shots.add({ kind: 'rays', o, ends: [end], hits: [!!segment.hit], look, age: 0, life: look.life, ability: 'railgun', seed: Math.random() * 100 });
  return true;
}

/**
 * Per presented titan, right after its rig pose (titan-presentation.js update): the melee arm
 * over the rig's own pose, and the flame-core marker the row-bit fallback reads.
 */
export function updateTitan(item, row, dt) {
  void row; void dt;
  const swing = swings.get(String(item?.id));
  if (swing && item?.model?.nodes?.upperL && !item.wreck) poseSwing(item, swing);
}

/** Per frame: advance and draw every event effect. */
export function frame(dt, camera = null) {
  const step = Math.max(0, Math.min(0.25, finite(dt)));
  clock += step;
  if (camera) sink.camera = camera;
  if (!root) return;
  rays.begin(); flares.begin();
  for (const item of [...deployables.values()]) stepDeployable(item, step);
  for (const line of [...lines]) if (!stepLine(line, step)) dropLine(line);
  for (const shot of [...shots]) if (!stepShot(shot, step)) shots.delete(shot);
  for (const swing of [...swings.values()]) if (!stepSwing(swing, step)) swings.delete(swing.key);
  for (const ring of [...rings]) {
    ring.age += step;
    const k = ring.age / ring.life;
    if (k >= 1) { ring.mesh.removeFromParent(); ring.mesh.geometry.dispose(); ring.mesh.material.dispose(); rings.delete(ring); continue; }
    if (ring.decal) { ring.mesh.material.opacity = ring.peak * Math.min(1, (1 - k) * 4); continue; }
    ring.mesh.scale.setScalar(Math.max(0.05, ring.radius * smooth(Math.sqrt(k))));
    ring.mesh.material.opacity = ring.peak * (1 - k) * (1 - k);
  }
  if (caught.size) stepCaught(step);
  rays.end(clock); flares.end();
}

/** Live effect counts (tests and the capture page). */
export function stats() {
  let props = 0, cables = 0;
  for (const item of deployables.values()) { props += item.meshes.filter(m => m.name !== 'titan-trap-ring').length; if (item.cable) cables++; }
  return { deployables: deployables.size, props, cables, lines: lines.size, shots: shots.size, rings: rings.size, swings: swings.size,
    caught: [...caught.values()].reduce((n, s) => n + s.rounds.length, 0), rays: rays?.count ?? 0, flares: flares?.count ?? 0 };
}
/** Debug view of the live state (tests): deployables, lines with their sampled points, swings. */
export function inspect() {
  return {
    deployables: [...deployables.values()].map(d => ({ id: d.id, kind: d.kind, points: d.points.map(p => [...p]), cable: d.cable ? { target: d.cable.target, life: d.cable.life } : null, life: d.life })),
    lines: [...lines].map(l => ({ kind: l.kind, vehicleId: l.vehicleId, points: l.points.map(p => [...p]), stopped: l.stopped, life: l.life, travelled: l.travelled })),
    swings: [...swings.values()].map(s => ({ key: s.key, kind: s.kind, target: s.target, age: s.age, struck: s.struck, at: s.at })),
    shots: [...shots].map(s => ({ kind: s.kind, ability: s.ability ?? null, o: s.o ?? null, ends: s.ends ?? null })),
    caught: [...caught.entries()].map(([id, s]) => ({ id, rounds: s.rounds.length, sphere: s.sphere ? [...s.sphere] : null })),
  };
}

/** Programs of the event FX; `warmupRoot` carries one hidden mesh of each. */
export const TITAN_EVENT_FX_WARMUP_MATERIALS = Object.freeze(['titan-ray-fx', 'titan-flare-batch-fx', 'titan-ground-trail-fx', 'titan-deployable-fx', 'titan-burn-decal-fx']);
let warmup = null;
export function warmupRoot() {
  if (warmup) return warmup;
  warmup = new THREE.Group();
  warmup.name = 'titan-event-fx-shader-warmup';
  warmup.visible = false;
  const ray = new RayBatch(1), flare = new FlareBatch(1);
  ray.add([0, 0, 0], [0, 1, 0], 1, [1, 1, 1]); ray.end(0);
  flare.add([0, 0, 0], 1, [1, 1, 1]); flare.end();
  const trail = new THREE.Mesh(lineGeometry(2, true), trailMaterial([1, 1, 1]));
  const prop = new THREE.Mesh(propGeometry('mine', 'neutral'), propMaterial());
  const burn = new THREE.Mesh(burnGeometry(1, 6), burnMaterial());
  for (const mesh of [ray.mesh, flare.mesh, trail, prop, burn]) { mesh.frustumCulled = false; mesh.name = `warmup-${mesh.material.name}`; warmup.add(mesh); }
  return warmup;
}

/** Drop every effect (leave the match, capture reset). */
export function clear() {
  for (const item of [...deployables.values()]) dropDeployable(item);
  for (const line of [...lines]) dropLine(line);
  for (const ring of rings) { ring.mesh.removeFromParent(); ring.mesh.geometry.dispose(); ring.mesh.material.dispose(); }
  rings.clear(); shots.clear(); swings.clear(); caught.clear();
  if (root) { rays.begin(); flares.begin(); rays.end(clock); flares.end(); root.removeFromParent(); }
}

void TITAN_COMMON_ABILITIES;
