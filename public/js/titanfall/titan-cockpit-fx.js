// Titan cockpit damage and transit dressing (docs/titanfall.md §7.2, Cockpit damage / Embark and
// disembark; references docs/design/titanfall/cockpit/damage/ (A growing into C) and
// docs/design/titanfall/transit/). Presentation only: the damage follows the authoritative hull hp
// of the presented row (and the side of the authoritative `vehicle_hit` events), the transit
// follows titan-transit.js.
//
// Damage grows in four stages of the hull (80 / 60 / 40 / 20 % left; doom is the last stage) and
// stays for the life of the titan:
//   1  a star crack in the viewport glass, sputtering sparks
//   2  more cracks, a cable bundle tears loose from the roof on the side that was hit, one MFD glitches
//   3  the lower ring trim bends off over a torn hole with live wires, a glowing breach in the pillar,
//      smoke gathers under the roof, the MFD cracks, red emergency light
//   4  the radar screen dies (NO SIGNAL), small fires at the side consoles, thick smoke, both sides torn
// Every hull hit sparks on its side, swings the loose parts and may crack the glass again.
//
// Transit (timeline in titan-embark-boot.js, references docs/design/titanfall/embark/): on embark three
// armour plates close the viewport (two from the left, one from the right), lock with a seam flash and
// sparks, the cabin goes dark, then the hatch's inside powers on as a screen showing the outside and the
// MFDs, pods and glass HUD come up in turn while the glass reads NEURAL LINK, LINK ESTABLISHED / PILOT
// ONLINE. On exit the screen cuts, the plates part, the glass reads HATCH OPEN and fades while the
// anchored cabin falls behind the camera.
//
// Also a titanfall client module: it keeps the own titans' recent `vehicle_hit` events.
import * as THREE from '../vendor/three.module.js';
import { mergeGeometries } from '../vendor/utils/BufferGeometryUtils.js';
import { displaySettings } from '../ui/display-settings.js';
import { EMBARK_BOOT, embarkBoot, exitHatch } from './titan-embark-boot.js';

/** Tuning (presentation only). */
export const COCKPIT_FX = Object.freeze({
  stages: Object.freeze([0.8, 0.6, 0.4, 0.2]),   // hull fraction thresholds of stages 1..4
  cracks: Object.freeze([1, 2, 4, 6]),           // glass cracks at least present per stage
  maxCracks: 6,
  crackGrow: 0.09,                               // s a new crack takes to spread
  hitCrack: 0.35,                                // chance a heavy hull hit (≥ 150) adds a crack beyond the stage
  smoke: Object.freeze([0.55, 0.1]),             // hull fraction where smoke starts and where it is thickest
  flames: Object.freeze([0.25, 0.12]),           // hull fraction for the hit side's fire and the other side's
  emergency: 0.35,                               // hull fraction where the cabin light turns red
  sputter: Object.freeze([[1.6, 3.2], [0.5, 1.2]]),  // s between spark spurts at stage 2-3 and stage 4
  swing: Object.freeze({ k: 26, damping: 3.2, hit: 2.6 }),
  lockSparks: 14,                                // sparks along the seams when the hatch locks
  hitLog: 8,
});

/** The hatch plate meshes in the order of titan-embark-boot.js (upper left, lower left, right). */
export const HATCH_PLATES = Object.freeze(['hatchUpper', 'hatchLower', 'hatchRight']);

/** Materials this module adds to the cockpit (titan-cockpit.js warms them). */
export const COCKPIT_FX_WARMUP_MATERIALS = Object.freeze(['titan-cockpit-fx-solid', 'titan-cockpit-fx-glow', 'titan-cockpit-fx-smoke',
  'titan-cockpit-fx-flame', 'titan-cockpit-fx-banner', 'titan-cockpit-fx-seam']);

// ------------------------------------------------------------------------------------- hit log

const hits = new Map();   // vehicle id -> [{ at, pos, dmg }]
const nowS = () => (globalThis.performance?.now?.() ?? Date.now()) / 1000;

/** Client module: keep the latest hull hits per vehicle (the cockpit reads its own). */
export function onEvent(event) {
  if (event?.kind !== 'vehicle_hit' || event.vehicleId == null || !Array.isArray(event.pos) || !(event.dmg > 0)) return;
  const id = String(event.vehicleId);
  const list = hits.get(id) ?? [];
  list.push({ at: nowS(), pos: event.pos.slice(0, 3), dmg: event.dmg, cls: event.cls ?? null });
  if (list.length > COCKPIT_FX.hitLog) list.splice(0, list.length - COCKPIT_FX.hitLog);
  hits.set(id, list);
}
export function tick() {}
export function frame() {}
export function dispose() { hits.clear(); }

/** The hits of one hull since the last call (and forgets them). */
export function takeHits(vehicleId) {
  const id = vehicleId != null ? String(vehicleId) : null;
  const list = id ? hits.get(id) : null;
  if (!list?.length) return [];
  hits.delete(id);
  return list;
}

// ------------------------------------------------------------------------------------ geometry

const UP = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _v = new THREE.Vector3();
const COL = Object.freeze({ plate: 0x4a525c, dark: 0x2b3036, rib: 0x5d6671, hazY: 0xe8a823, hazK: 0x1b1d20, hole: 0x07080a,
  bolt: 0x9aa3ad, wireR: 0xa8261e, wireB: 0x2f6fb0, wireY: 0xd0a020, wireK: 0x1c1e22, lamp: 0xff3a2a, char: 0x15171a });

/** Vertex colours from the normals: lit from above and from the eye, darker underneath. */
function shade(geometry, hex) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  if (!g.attributes.normal) g.computeVertexNormals();
  const base = new THREE.Color(hex), n = g.attributes.normal, count = g.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const k = 0.5 + 0.32 * Math.max(0, n.getY(i)) + 0.28 * Math.max(0, n.getZ(i)) - 0.12 * Math.max(0, -n.getY(i));
    colors[i * 3] = base.r * k; colors[i * 3 + 1] = base.g * k; colors[i * 3 + 2] = base.b * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'color') g.deleteAttribute(name);
  return g;
}

class Parts {
  constructor() { this.list = []; }
  box(min, max, hex) {
    const g = new THREE.BoxGeometry(...[0, 1, 2].map(i => Math.max(0.004, max[i] - min[i])));
    g.translate((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    this.list.push(shade(g, hex));
  }
  tube(points, radius, hex, segments = 12) {
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
    this.list.push(shade(new THREE.TubeGeometry(curve, segments, radius, 5, false), hex));
  }
  bolt(at, radius, hex = COL.bolt) {
    const g = new THREE.CylinderGeometry(radius, radius, 0.014, 6);
    g.applyQuaternion(_q.setFromUnitVectors(UP, _v.set(0, 0, 1)));
    g.translate(at[0], at[1], at[2] + 0.007);
    this.list.push(shade(g, hex));
  }
  /** Yellow-black hazard stripes on a +z face: a strip from x0 to x1 at height y0..y1, depth z. */
  hazard(x0, x1, y0, y1, z, pitch = 0.06) {
    const count = Math.max(1, Math.round((x1 - x0) / pitch)), w = (x1 - x0) / count, skew = (y1 - y0) * 0.6;
    for (let k = 0; k < count; k++) {
      const a = x0 + k * w, b = a + w, pos = [a, y0, z, b, y0, z, b + skew, y1, z, a, y0, z, b + skew, y1, z, a + skew, y1, z];
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos.map((v, i) => (i % 3 === 0 ? Math.min(x1, v) : v)), 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(18).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
      this.list.push(shade(g, k % 2 ? COL.hazK : COL.hazY));
    }
  }
  /** A flat plate over a polygon [[x, y], ...] from depth z0 (outside) to z1 (its face toward the eye). */
  prism(points, z0, z1, hex) {
    const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: z1 - z0, bevelEnabled: false });
    g.translate(0, 0, z0);
    this.list.push(shade(g, hex));
  }
  /** Hazard stripes along the edge a -> b ([x, y]) on a +z face at depth z, `width` toward the side `inward` (+1 left of a -> b). */
  stripe(a, b, width, z, inward, pitch = 0.06) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), dx = (b[0] - a[0]) / len, dy = (b[1] - a[1]) / len;
    const nx = -dy * inward * width, ny = dx * inward * width, skew = width * 0.6;
    const count = Math.max(1, Math.round(len / pitch)), step = len / count;
    for (let k = 0; k < count; k++) {
      const s0 = k * step, s1 = Math.min(len, s0 + step), s2 = Math.min(len, s1 + skew), s3 = Math.min(len, s0 + skew);
      const at = (s, n) => [a[0] + dx * s + nx * n, a[1] + dy * s + ny * n, z];
      const q = [at(s0, 0), at(s1, 0), at(s2, 1), at(s0, 0), at(s2, 1), at(s3, 1)];
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(q.flat(), 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(18).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
      this.list.push(shade(g, k % 2 ? COL.hazK : COL.hazY));
    }
  }
  finish() {
    const merged = mergeGeometries(this.list);
    for (const g of this.list) g.dispose();
    merged.computeBoundingSphere();
    return merged;
  }
}

/** A flat quad list as one geometry with an extra per-vertex attribute (side or kind). */
function quadGeometry(quads, extra = 'aSide') {
  const pos = [], uv = [], tag = [];
  for (const { corners, value = 0 } of quads) {
    const [a, b, c, d] = corners;
    for (const [p, t] of [[a, [0, 0]], [b, [1, 0]], [c, [1, 1]], [a, [0, 0]], [c, [1, 1]], [d, [0, 1]]]) { pos.push(...p); uv.push(...t); tag.push(value); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute(extra, new THREE.Float32BufferAttribute(tag, 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * Geometry of the fx parts in eye metres for one cabin: the hatch plates and seams, per side the torn ring trim
 * (with its hinge), the hole and wires behind it, the dangling cable bundle (with its pivot), the
 * breach rim, the smoke sheets, the console fires and the glass banner plane.
 */
function buildParts(cabin, win) {
  const { W, R, F } = cabin, { front, top, bot, half, strut, ringDepth, skin } = win;
  const out = {};
  // Hatch plates (titan-embark-boot.js) behind the glass: the upper and lower left plates slide in from
  // the left, the right plate from the right; its pointed edge meets them in a Y seam just right of the
  // viewport's middle. Open, each sits in the hull beside the viewport (`hatchTravel`, x metres).
  const mid = (top + bot) / 2, X = half * 1.1 + 0.12, Y1 = top + 0.2, Y0 = bot - 0.2;
  const xa = half * 0.3, xp = half * 0.04, z0 = front - skin - 0.065, z1 = front - skin - 0.025;
  const seamX = (y, toward) => xp + (xa - xp) * (y - mid) / (toward - mid);
  const plates = {
    hatchUpper: { poly: [[-X, mid], [xp, mid], [xa, Y1], [-X, Y1]], lo: mid, hi: Y1, side: -1 },
    hatchLower: { poly: [[-X, Y0], [xa, Y0], [xp, mid], [-X, mid]], lo: Y0, hi: mid, side: -1 },
    hatchRight: { poly: [[xp, mid], [xa, Y0], [X, Y0], [X, Y1], [xa, Y1]], lo: Y0, hi: Y1, side: 1 },
  };
  for (const [name, { poly, lo, hi, side }] of Object.entries(plates)) {
    const p = new Parts();
    p.prism(poly, z0, z1, COL.dark);
    // Ribs across the face, clear of the seam; a row of bolts between them.
    const edgeX = y => (y >= mid ? seamX(y, Y1) : seamX(y, Y0));
    for (let k = 1; k < 5; k++) {
      const y = lo + (hi - lo) * k / 5;
      if (side < 0) p.box([-X + 0.05, y - 0.009, z1], [edgeX(y) - 0.09, y + 0.009, z1 + 0.012], COL.plate);
      else p.box([edgeX(y) + 0.09, y - 0.009, z1], [X - 0.05, y + 0.009, z1 + 0.012], COL.plate);
      if (k % 2) for (let j = 0; j < 4; j++) {
        const x = side < 0 ? -X + 0.16 + j * 0.3 : X - 0.16 - j * 0.3;
        if (side < 0 ? x < edgeX(y) - 0.12 : x > edgeX(y) + 0.12) p.bolt([x, y + (hi - lo) / 10, z1], 0.012);
      }
    }
    // The leading (slanted) edges carry a hazard band; the left plates meet each other on a rubber seal.
    const edges = name === 'hatchRight' ? [[[xa, Y1], [xp, mid]], [[xp, mid], [xa, Y0]]]
      : name === 'hatchUpper' ? [[[xp, mid], [xa, Y1]]] : [[[xa, Y0], [xp, mid]]];
    // Every edge runs with its plate on the left.
    for (const [a, b] of edges) p.stripe(a, b, 0.05, z1 + 0.004, 1);
    if (side < 0) p.box([-X, name === 'hatchUpper' ? mid : mid - 0.008, z0 - 0.004], [xp, name === 'hatchUpper' ? mid + 0.008 : mid, z1 + 0.005], COL.char);
    out[name] = p.finish();
  }
  out.hatchTravel = { hatchUpper: -(xa + half * 1.1 + 0.08), hatchLower: -(xa + half * 1.1 + 0.08), hatchRight: half * 1.1 - xp + 0.08 };
  // The seams light up as the plates lock: the horizontal left seam and the two arms of the point.
  const sw = 0.05, sz = z1 + 0.006, band = (a, b) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), nx = -(b[1] - a[1]) / len * sw, ny = (b[0] - a[0]) / len * sw;
    return { corners: [[a[0] - nx, a[1] - ny, sz], [b[0] - nx, b[1] - ny, sz], [b[0] + nx, b[1] + ny, sz], [a[0] + nx, a[1] + ny, sz]] };
  };
  out.hatchSeams = quadGeometry([band([-X, mid], [xp, mid]), band([xp, mid], [xa, Y1]), band([xp, mid], [xa, Y0])]);
  out.hatchSeamAt = [[xp, mid, z1 + 0.02], [(xp + xa) / 2, (mid + Y1) / 2, z1 + 0.02], [(xp + xa) / 2, (mid + Y0) / 2, z1 + 0.02], [-half * 0.5, mid, z1 + 0.02]];
  // Per side (s = -1 left, +1 right).
  for (const s of [-1, 1]) {
    const key = s < 0 ? 'L' : 'R';
    // The lower ring trim: a hazard plate on the ring face, hinged at its outer end.
    const ringZ = front + ringDepth + 0.004, py = bot - strut * 0.5, px0 = s * 0.22, px1 = s * 0.62;
    const hinge = [px1, py, ringZ];
    const plate = new Parts();
    const lo = Math.min(px0, px1) - hinge[0], hi = Math.max(px0, px1) - hinge[0];
    plate.box([lo, -0.045, 0], [hi, 0.045, 0.018], COL.plate);
    plate.hazard(lo + 0.01, hi - 0.01, -0.03, 0.03, 0.019, 0.05);
    plate.bolt([s < 0 ? lo + 0.02 : hi - 0.02, 0, 0.018], 0.01);
    out[`plate${key}`] = plate.finish();
    out[`hinge${key}`] = hinge;
    // Behind it: the torn hole and three live wires curling out.
    const hole = new Parts();
    hole.box([Math.min(px0, px1) + 0.02, py - 0.04, ringZ - 0.02], [Math.max(px0, px1) - 0.03, py + 0.04, ringZ - 0.004], COL.hole);
    const wx = (px0 + px1) / 2;
    hole.tube([[wx - 0.06, py - 0.02, ringZ - 0.01], [wx - 0.07, py - 0.07, ringZ + 0.04], [wx - 0.03, py - 0.12, ringZ + 0.05]], 0.007, COL.wireR, 8);
    hole.tube([[wx, py, ringZ - 0.01], [wx + 0.02, py - 0.05, ringZ + 0.06], [wx + 0.06, py - 0.1, ringZ + 0.05]], 0.006, COL.wireB, 8);
    hole.tube([[wx + 0.07, py - 0.01, ringZ - 0.01], [wx + 0.1, py - 0.06, ringZ + 0.03], [wx + 0.09, py - 0.13, ringZ + 0.04]], 0.006, COL.wireY, 8);
    out[`hole${key}`] = hole.finish();
    out[`wireTip${key}`] = [wx, py - 0.12, ringZ + 0.05];
    // The cable bundle torn loose from the roof (pivot at the roof), hanging in front of the viewport's top corner.
    const pivot = [s * 0.46, R - 0.02, front + 0.4];
    const cables = new Parts();
    [[COL.wireR, 0], [COL.wireK, 0.03], [COL.wireB, -0.03], [COL.wireY, 0.055]].forEach(([hex, o], k) => {
      const len = 0.46 + k * 0.07;
      cables.tube([[o, 0, 0], [o + s * 0.02, -len * 0.4, 0.015 * k], [o - s * 0.015, -len * 0.75, 0.02], [o + s * 0.03, -len, 0.035 - 0.01 * k]], 0.012, hex, 10);
    });
    cables.box([-0.05, -0.03, -0.03], [0.08, 0.01, 0.03], COL.dark);   // the torn clamp
    out[`cables${key}`] = cables.finish();
    out[`pivot${key}`] = pivot;
    out[`cableTip${key}`] = [pivot[0], pivot[1] - 0.66, pivot[2] + 0.03];
  }
  // Breach rims on the pillars beside the viewport (one draw for both: aSide picks the side).
  const breach = [];
  for (const s of [-1, 1]) {
    // Burnt through the ring's side band (its hazard edge), at the viewport's mid height.
    const cx = s * (half + strut * 0.45), cy = (top + bot) / 2 - 0.04, z = front + ringDepth + 0.008;
    const n = 9, pts = [];
    for (let k = 0; k < n; k++) {
      const a = k / n * Math.PI * 2, r = 0.06 * (k % 2 ? 0.62 : 1) * (1 + 0.25 * Math.sin(k * 2.7));
      pts.push([cx + Math.cos(a) * r * 0.8, cy + Math.sin(a) * r * 1.5, z]);
    }
    // A ring of quads: inner jagged edge -> outer glow edge.
    for (let k = 0; k < n; k++) {
      const a = pts[k], b = pts[(k + 1) % n];
      const grow = p => [cx + (p[0] - cx) * 1.55, cy + (p[1] - cy) * 1.55, z];
      breach.push({ corners: [a, b, grow(b), grow(a)], value: s });
    }
    // The dark hole itself (a fan as quads), drawn black by the shader (uv.y = 0 everywhere inside).
    for (let k = 0; k < n; k++) { const a = pts[k], b = pts[(k + 1) % n]; breach.push({ corners: [[cx, cy, z - 0.001], a, b, [cx, cy, z - 0.001]], value: s * 2 }); }
  }
  out.breach = quadGeometry(breach);
  out.breachAt = [[-(half + strut * 0.45), (top + bot) / 2, front + ringDepth + 0.03], [half + strut * 0.45, (top + bot) / 2, front + ringDepth + 0.03]];
  // Smoke: a layer under the roof and a sheet over the brow (seen from the eye).
  const smoke = [
    { corners: [[-W, R - 0.12, front + 0.05], [W, R - 0.12, front + 0.05], [W, R - 0.2, 0.3], [-W, R - 0.2, 0.3]], value: 0 },
    { corners: [[-W, top - 0.4, front + 0.14], [W, top - 0.4, front + 0.14], [W, R - 0.05, front + 0.14], [-W, R - 0.05, front + 0.14]], value: 1 },
    { corners: [[-W, top - 0.55, front + 0.3], [W, top - 0.55, front + 0.3], [W, R - 0.1, front + 0.3], [-W, R - 0.1, front + 0.3]], value: 2 },
  ];
  out.smoke = quadGeometry(smoke, 'aLayer');
  // Console fires: two crossed quads per side on the side console's inner edge.
  const fires = [];
  for (const s of [-1, 1]) {
    const fx = s * 0.7, fy = -0.6, fz = -0.85, w = 0.1, h = 0.28;
    fires.push({ corners: [[fx - w, fy, fz], [fx + w, fy, fz], [fx + w, fy + h, fz], [fx - w, fy + h, fz]], value: s });
    fires.push({ corners: [[fx - w * 0.7, fy, fz + 0.05], [fx + w * 0.7, fy, fz - 0.05], [fx + w * 0.7, fy + h * 0.8, fz - 0.05], [fx - w * 0.7, fy + h * 0.8, fz + 0.05]], value: s * 2 });
  }
  out.fires = quadGeometry(fires);
  out.fireAt = [[-0.7, -0.5, -0.85], [0.7, -0.5, -0.85]];
  // The glass banner: a plane just in front of the glass, above the crosshair.
  const bz = front - skin + 0.03, bw = Math.min(1.0, half * 0.95), bh = bw / 4;
  const banner = new THREE.PlaneGeometry(bw, bh);
  banner.translate(0, top - (top - bot) * 0.3, bz);
  out.banner = banner;
  return out;
}

// ------------------------------------------------------------------------------------ shaders

const smokeShader = depthGlsl => ({
  vertexShader: /* glsl */ `
attribute float aLayer;
varying vec2 vUv; varying float vLayer;
void main() { vUv = uv; vLayer = aLayer; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); ${depthGlsl} }`,
  fragmentShader: /* glsl */ `
uniform float density; uniform float time;
varying vec2 vUv; varying float vLayer;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int k = 0; k < 4; k++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
void main() {
  vec2 p = vec2(vUv.x * 5.0 + time * (0.12 + vLayer * 0.05), vUv.y * 2.0 - time * 0.07 + vLayer * 3.1);
  float n = fbm(p + fbm(p * 0.7 + time * 0.05));
  // Sheets thin out toward their lower edge; the roof layer toward the pilot.
  float fall = vLayer > 0.5 ? smoothstep(0.0, 0.3 + 0.4 * (1.0 - density), vUv.y) : 1.0 - smoothstep(0.1, 1.0, vUv.y);
  float edge = smoothstep(0.0, 0.1, vUv.x) * (1.0 - smoothstep(0.9, 1.0, vUv.x));
  float body = smoothstep(0.2, 0.7, n + density * 0.35 - 0.15);
  float a = body * fall * edge * min(1.0, density * 1.15) * (vLayer > 1.5 ? 0.7 : 0.9);
  gl_FragColor = vec4(vec3(0.15, 0.14, 0.13) + n * 0.1, a);
}`,
});

const flameShader = depthGlsl => ({
  vertexShader: /* glsl */ `
attribute float aSide;
varying vec2 vUv; varying float vSide;
void main() { vUv = uv; vSide = aSide; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); ${depthGlsl} }`,
  fragmentShader: /* glsl */ `
uniform float left; uniform float right; uniform float time;
varying vec2 vUv; varying float vSide;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
void main() {
  float on = vSide < 0.0 ? left : right;
  if (on <= 0.0) discard;
  float seed = abs(vSide) * 7.3;
  float n = noise(vec2(vUv.x * 4.0 + seed, vUv.y * 3.0 - time * 3.2)) * 0.6 + noise(vec2(vUv.x * 9.0 - seed, vUv.y * 6.0 - time * 5.0)) * 0.4;
  float width = (1.0 - vUv.y) * 0.5 * on + 0.04;
  float body = smoothstep(width, width * 0.25, abs(vUv.x - 0.5 + (n - 0.5) * 0.25 * vUv.y));
  float h = smoothstep(1.0, 0.2, vUv.y + (n - 0.5) * 0.45);
  float a = body * h * on;
  vec3 c = mix(vec3(1.6, 0.35, 0.05), vec3(2.2, 1.6, 0.5), smoothstep(0.25, 0.85, a));
  gl_FragColor = vec4(c * a, a);
}`,
});

const glowShader = depthGlsl => ({
  vertexShader: /* glsl */ `
attribute float aSide;
varying vec2 vUv; varying float vSide;
void main() { vUv = uv; vSide = aSide; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); ${depthGlsl} }`,
  fragmentShader: /* glsl */ `
uniform float left; uniform float right; uniform float time;
varying vec2 vUv; varying float vSide;
void main() {
  float on = vSide < 0.0 ? left : right;
  if (on <= 0.0) discard;
  // |aSide| 2: the hole (black); 1: the rim, hot at the torn edge (uv.y 0) cooling outward.
  if (abs(vSide) > 1.5) { gl_FragColor = vec4(0.012, 0.01, 0.01, 1.0); return; }
  float flick = 0.8 + 0.2 * sin(time * 9.0 + vUv.x * 13.0);
  float heat = (1.0 - smoothstep(0.0, 0.85, vUv.y)) * flick * on;
  vec3 hot = mix(vec3(0.18, 0.05, 0.02), vec3(2.4, 0.9, 0.2), heat);
  gl_FragColor = vec4(hot, 1.0);
}`,
});

// The hatch seams: a cyan line hot at the seam (uv.y 0.5) fading across the band; `flash` 0..1.
const seamShader = depthGlsl => ({
  vertexShader: /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); ${depthGlsl} }`,
  fragmentShader: /* glsl */ `
uniform float flash;
varying vec2 vUv;
void main() {
  float d = abs(vUv.y - 0.5) * 2.0;
  float core = exp(-d * 9.0), halo = exp(-d * 2.6) * 0.45;
  gl_FragColor = vec4(mix(vec3(0.25, 0.8, 1.0), vec3(0.9, 1.0, 1.0), core) * (core + halo) * flash * 2.2, 1.0);
}`,
});

// ------------------------------------------------------------------------------------ banner

const BANNER = Object.freeze({ width: 512, height: 128 });
function bannerCanvas() {
  const canvas = globalThis.document?.createElement?.('canvas');
  const ctx = canvas?.getContext?.('2d');
  if (!ctx || typeof ctx.fillText !== 'function') return null;
  canvas.width = BANNER.width; canvas.height = BANNER.height;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.name = 'titan-cockpit-fx-banner';
  return { canvas, ctx, texture, text: null };
}
function drawBanner(b, lines, ink) {
  const key = lines.join('|');
  if (!b || b.text === key) return;
  b.text = key;
  const g = b.ctx, { width: w, height: h } = BANNER;
  g.clearRect(0, 0, w, h);
  if (!lines.length) { b.texture.needsUpdate = true; return; }
  g.font = "700 38px 'Rajdhani', 'Bahnschrift', 'Arial Narrow', sans-serif";
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.strokeStyle = ink; g.lineWidth = 3;
  // Bracket frame like the HUD's alert band.
  g.beginPath(); g.moveTo(24, 18); g.lineTo(10, 18); g.lineTo(10, h - 18); g.lineTo(24, h - 18);
  g.moveTo(w - 24, 18); g.lineTo(w - 10, 18); g.lineTo(w - 10, h - 18); g.lineTo(w - 24, h - 18); g.stroke();
  g.shadowColor = ink; g.shadowBlur = 14; g.fillStyle = ink;
  if (lines.length === 1) g.fillText(lines[0], w / 2, h / 2 + 2);
  else { g.fillText(lines[0], w / 2, h * 0.33); g.font = "700 30px 'Rajdhani', 'Bahnschrift', 'Arial Narrow', sans-serif"; g.fillText(lines[1], w / 2, h * 0.7); }
  g.shadowBlur = 0;
  b.texture.needsUpdate = true;
}

// --------------------------------------------------------------------------------- the fx unit

const smooth = k => { const t = Math.max(0, Math.min(1, k)); return t * t * (3 - 2 * t); };
const hash = (seed, k) => { const s = Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453; return s - Math.floor(s); };

/** A pendulum about one axis (radians), driven by hits. */
class Swing {
  constructor(rest = 0) { this.rest = rest; this.a = rest; this.w = 0; }
  kick(amount) { this.w += amount; }
  step(dt) {
    const S = COCKPIT_FX.swing;
    this.w += (-(this.a - this.rest) * S.k - this.w * S.damping) * dt;
    this.a += this.w * dt;
  }
}

/**
 * The damage and transit dressing of one cockpit. `materials` are the cockpit's (shell, keys,
 * warn, accent, screens, glass); `hud` the diegetic HUD (materials pods, panels, glass);
 * `sparks(count, now, anchor)` the cockpit's spark emitter; `jolt(amount)` its sway jolt.
 * Returns { meshes (eye space, `userData.local` = placement in the cabin), update(ctx), paintScreens, dispose }.
 */
export function createCockpitFx({ type, cabin, win, depthGlsl, nearDepth, materials, hud = null, sparks = () => {}, jolt = () => {}, ink = '#62d6ff' }) {
  const parts = buildParts(cabin, win);
  const solid = nearDepth(new THREE.MeshBasicMaterial({ name: 'titan-cockpit-fx-solid', vertexColors: true }));
  const glow = new THREE.ShaderMaterial({ name: 'titan-cockpit-fx-glow', ...glowShader(depthGlsl), toneMapped: false,
    uniforms: { left: { value: 0 }, right: { value: 0 }, time: { value: 0 } } });
  const smokeMat = new THREE.ShaderMaterial({ name: 'titan-cockpit-fx-smoke', ...smokeShader(depthGlsl), transparent: true, depthWrite: false,
    side: THREE.DoubleSide, uniforms: { density: { value: 0 }, time: { value: 0 } } });
  const flameMat = new THREE.ShaderMaterial({ name: 'titan-cockpit-fx-flame', ...flameShader(depthGlsl), transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false, uniforms: { left: { value: 0 }, right: { value: 0 }, time: { value: 0 } } });
  const banner = bannerCanvas();
  const bannerMat = nearDepth(new THREE.MeshBasicMaterial({ name: 'titan-cockpit-fx-banner', map: banner?.texture ?? null, transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0 }));
  const seamMat = new THREE.ShaderMaterial({ name: 'titan-cockpit-fx-seam', ...seamShader(depthGlsl), transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false, uniforms: { flash: { value: 0 } } });
  const meshes = {};
  const add = (name, geometry, material, renderOrder = 0, local = null) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `cockpit-overlay-${type}-fx-${name}`;
    mesh.visible = false;
    mesh.renderOrder = renderOrder;
    mesh.userData.local = local;
    mesh.userData.cockpitFx = true;
    meshes[name] = mesh;
    return mesh;
  };
  for (const name of HATCH_PLATES) add(name, parts[name], solid, 1, new THREE.Matrix4());
  add('hatchSeams', parts.hatchSeams, seamMat, 2, new THREE.Matrix4());
  for (const key of ['L', 'R']) {
    add(`plate${key}`, parts[`plate${key}`], solid, 0, new THREE.Matrix4());
    add(`hole${key}`, parts[`hole${key}`], solid, 0, null);
    add(`cables${key}`, parts[`cables${key}`], solid, 0, new THREE.Matrix4());
  }
  add('breach', parts.breach, glow, 0, null);
  add('smoke', parts.smoke, smokeMat, 5, null);
  add('fires', parts.fires, flameMat, 5, null);
  add('banner', parts.banner, bannerMat, 6, null);

  // Damage state: the stage, the side that took the most, the cracks, the loose parts.
  const crackData = Array.from({ length: COCKPIT_FX.maxCracks }, () => new THREE.Vector4(0, 0, 0, 0));
  const glassU = materials.glass.uniforms;
  glassU.cracks.value = crackData;
  const S = {
    stage: 0, frac: 1, hp: null, weight: { L: 0, R: 0 }, cracks: [], seed: 0, sputterAt: 0,
    swing: { L: new Swing(0), R: new Swing(0) }, cable: { L: new Swing(0), R: new Swing(0) },
    shown: { L: { plate: false, cables: false }, R: { plate: false, cables: false } },
    screens: { status: 0, weapon: 0, radar: 0, caution: 0, aux: 0 }, lastT: null, mode: null, transitT: null,
  };
  const dominant = () => (S.weight.R > S.weight.L ? 'R' : 'L');
  const other = key => (key === 'L' ? 'R' : 'L');
  const sideSign = key => (key === 'L' ? -1 : 1);

  const addCrack = (key, now) => {
    if (S.cracks.length >= COCKPIT_FX.maxCracks) return;
    const k = S.cracks.length + S.seed * 7;
    const side = key ? sideSign(key) : (hash(S.seed, k) < 0.5 ? -1 : 1);
    // Away from the crosshair: the outer two thirds of each half, upper two thirds of the glass.
    const u = 0.5 + side * (0.17 + hash(S.seed, k + 1) * 0.28), v = 0.3 + hash(S.seed, k + 2) * 0.6;
    S.cracks.push({ u, v, r: 0.16 + hash(S.seed, k + 3) * 0.14, seed: hash(S.seed, k + 4) * 100, born: now });
    sparks(3, now, [(u - 0.5) * win.half * 2, win.bot + (win.top - win.bot) * v, win.front + 0.02]);
  };

  const reset = () => {
    S.stage = 0; S.cracks.length = 0; S.weight.L = S.weight.R = 0; S.hp = null;
    for (const key of ['L', 'R']) { S.shown[key].plate = S.shown[key].cables = false; }
  };

  /** Stage 0..4 from the hull fraction (doom is stage 4). */
  const stageOf = (frac, doomed) => (doomed ? 4 : COCKPIT_FX.stages.filter(limit => frac < limit).length);

  const hingeMatrix = (key, out) => {
    const h = parts[`hinge${key}`], s = sideSign(key);
    // The plate hangs from its outer end, its inner end bent down and a little out of the ring.
    const a = S.swing[key].a;
    return out.makeRotationFromEuler(new THREE.Euler(0.22 * Math.min(1, Math.abs(a) * 2), 0, s * a, 'XYZ')).setPosition(h[0], h[1], h[2]);
  };
  const cableMatrix = (key, out) => {
    const p = parts[`pivot${key}`], c = S.cable[key];
    return out.makeRotationFromEuler(new THREE.Euler(c.a * 0.6, 0, c.a, 'XYZ')).setPosition(p[0], p[1], p[2]);
  };

  /** One stage step up: show the parts of the new stage with a burst. */
  const enterStage = (stage, now) => {
    const main = dominant(), off = other(main);
    const want = {
      [main]: { cables: stage >= 2, plate: stage >= 3 },
      [off]: { cables: stage >= 4, plate: stage >= 4 },
    };
    for (const key of ['L', 'R']) {
      if (want[key].cables && !S.shown[key].cables) {
        S.shown[key].cables = true; S.cable[key].a = sideSign(key) * 0.9; S.cable[key].w = 0;
        sparks(8, now, parts[`pivot${key}`]);
      }
      if (want[key].plate && !S.shown[key].plate) {
        S.shown[key].plate = true; S.swing[key].rest = 0.42; S.swing[key].a = 0; S.swing[key].w = 3.5;
        sparks(9, now, parts[`wireTip${key}`]);
      }
    }
    while (S.cracks.length < COCKPIT_FX.cracks[stage - 1]) addCrack(S.cracks.length % 2 ? off : main, now);
    // Screens: the hit side's MFD glitches, then cracks; the radar dies last.
    const side = main === 'R' ? 'weapon' : 'status', far = main === 'R' ? 'status' : 'weapon';
    S.screens[side] = stage >= 3 ? 2 : stage >= 2 ? 1 : 0;
    S.screens.caution = stage >= 3 ? 1 : 0;
    S.screens.radar = stage >= 4 ? 3 : 0;
    S.screens[far] = stage >= 4 ? 1 : 0;
    S.screens.aux = stage >= 4 ? 2 : 0;
    jolt(0.01);
  };

  return {
    meshes: Object.values(meshes),
    state: S,

    /**
     * Per frame while the cockpit draws: `model` (titanModel of the row), `row`, `now` (s),
     * `transit` (titan-transit.js transitFor) and the cockpit materials already set for this
     * frame (this multiplies the power and emergency light on top).
     */
    update({ model, row, now, transit = null }) {
      const dt = S.lastT === null ? 0 : Math.min(0.1, Math.max(0, now - S.lastT));
      S.lastT = now;
      if (!model) return;
      if (row?.id != null && S.seed === 0) S.seed = [...String(row.id)].reduce((a, c) => a + c.charCodeAt(0), 0) % 97 + 1;
      const frac = model.doomed ? 0 : Math.max(0, Math.min(1, model.hp / Math.max(1, model.maxHp)));
      // A fresh hull (higher hp than ever seen by a lot) starts clean.
      if (frac > 0.97 && S.stage > 0) reset();
      // Hull hits: side weight (from the authoritative hit points), swings, sparks, maybe a crack.
      const yaw = Number.isFinite(row?.yaw) ? row.yaw : 0, rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const hullDrop = S.hp !== null && model.hp < S.hp - 1 ? S.hp - model.hp : 0;
      let hitSide = null;
      for (const hit of takeHits(row?.id)) {
        const lx = (hit.pos[0] - (row?.x ?? 0)) * rx + (hit.pos[2] - (row?.z ?? 0)) * rz;
        hitSide = lx >= 0 ? 'R' : 'L';
        S.weight[hitSide] += hit.dmg;
      }
      if (hullDrop > 0) {
        const key = hitSide ?? dominant();
        if (!hitSide) S.weight[key] += hullDrop;
        for (const k of ['L', 'R']) { S.swing[k].kick(sideSign(k) * COCKPIT_FX.swing.hit * Math.min(1, hullDrop / 300)); S.cable[k].kick(-sideSign(key) * COCKPIT_FX.swing.hit * Math.min(1, hullDrop / 250)); }
        if (S.stage >= 1 && hullDrop >= 150 && Math.random() < COCKPIT_FX.hitCrack) addCrack(key, now);
        if (S.stage >= 2) sparks(4, now, parts[`wireTip${key}`]);
      }
      S.hp = model.hp; S.frac = frac;
      const stage = stageOf(frac, model.doomed);
      while (S.stage < stage) { S.stage++; enterStage(S.stage, now); }
      // Sputtering sparks from the torn parts.
      if (S.stage >= 2 && now >= S.sputterAt) {
        const [a, b] = COCKPIT_FX.sputter[S.stage >= 4 ? 1 : 0];
        S.sputterAt = now + a + Math.random() * (b - a);
        const live = ['L', 'R'].filter(k => S.shown[k].plate || S.shown[k].cables);
        const key = live[Math.floor(Math.random() * live.length)];
        if (key) sparks(3 + Math.floor(Math.random() * 3), now, S.shown[key].plate && Math.random() < 0.6 ? parts[`wireTip${key}`] : parts[`cableTip${key}`]);
      }
      // Loose parts.
      for (const key of ['L', 'R']) {
        S.swing[key].step(dt); S.cable[key].step(dt);
        meshes[`plate${key}`].visible = meshes[`hole${key}`].visible = S.shown[key].plate;
        meshes[`cables${key}`].visible = S.shown[key].cables;
        if (S.shown[key].plate) hingeMatrix(key, meshes[`plate${key}`].userData.local);
        if (S.shown[key].cables) cableMatrix(key, meshes[`cables${key}`].userData.local);
      }
      const main = dominant();
      const breachL = S.stage >= 3 && (main === 'L' || S.stage >= 4) ? 1 : 0, breachR = S.stage >= 3 && (main === 'R' || S.stage >= 4) ? 1 : 0;
      glow.uniforms.left.value = breachL; glow.uniforms.right.value = breachR; glow.uniforms.time.value = now % 1000;
      meshes.breach.visible = breachL + breachR > 0;
      const [s0, s1] = COCKPIT_FX.smoke;
      const density = smooth((s0 - frac) / (s0 - s1)) * 0.95;
      smokeMat.uniforms.density.value = density; smokeMat.uniforms.time.value = now % 1000;
      meshes.smoke.visible = density > 0.01;
      const [f0, f1] = COCKPIT_FX.flames;
      const fireMain = smooth((f0 - frac) / 0.08), fireOff = smooth((f1 - frac) / 0.06);
      flameMat.uniforms.left.value = main === 'L' ? fireMain : fireOff;
      flameMat.uniforms.right.value = main === 'R' ? fireMain : fireOff;
      flameMat.uniforms.time.value = now % 1000;
      meshes.fires.visible = fireMain > 0.01;
      // Glass cracks.
      S.cracks.forEach((c, i) => crackData[i].set(c.u, c.v, c.r * smooth((now - c.born) / COCKPIT_FX.crackGrow), c.seed));
      for (let i = S.cracks.length; i < crackData.length; i++) crackData[i].set(0, 0, 0, 0);
      glassU.crackCount.value = S.cracks.length;

      // Emergency light (below 35 % hull; doom has its own pulse).
      if (!model.doomed && frac < COCKPIT_FX.emergency) {
        const pulse = 0.5 + 0.5 * Math.sin(now * Math.PI * 1.2);
        materials.shell.color.multiply(new THREE.Color(1, 0.78 + 0.08 * pulse, 0.74 + 0.08 * pulse));
        if (Math.floor(now * 1.2) % 2 === 0) materials.warn.color.setScalar(1.2);
      }

      // Transit: hatch plates, seams, power, banner, glass (titan-embark-boot.js).
      const reduced = displaySettings().reducedMotion === true;
      const mode = transit?.mode ?? null, t = transit?.t ?? 0;
      const lastT = S.mode === mode ? S.transitT : null;
      S.mode = mode; S.transitT = mode ? t : null;
      const beat = mode === 'embark' ? embarkBoot(t, { reduced }) : mode === 'exit' ? exitHatch(t, { reduced }) : null;
      const power = beat?.power ?? { shell: 1, keys: 1, screens: 1, pods: 1, glassHud: 1, accent: 1 };
      const lines = beat?.banner.lines ?? [], bannerAlpha = beat?.banner.alpha ?? 0;
      if (beat?.warn) materials.warn.color.setRGB(...beat.warn);
      else if (mode === 'exit') materials.warn.color.setRGB(Math.floor(t * 10) % 2 ? 1.5 : 0.3, 0.8, 0.1);
      // The hatch locks: sparks spray from the seams (once per embark; a pinned capture holds it).
      if (mode === 'embark' && !reduced && lastT !== null && lastT < EMBARK_BOOT.lock && t >= EMBARK_BOOT.lock) {
        for (const at of parts.hatchSeamAt) sparks(Math.ceil(COCKPIT_FX.lockSparks / parts.hatchSeamAt.length), now, at);
        jolt(0.012);
      }
      materials.shell.color.multiplyScalar(power.shell);
      materials.keys.color.multiplyScalar(power.keys);
      materials.accent.color.multiplyScalar(power.accent);
      materials.screens.color.multiplyScalar(power.screens);
      // The hatch plates (and the loose damage parts) sit in the cabin light.
      solid.color.setScalar(mode ? power.shell : 1);
      if (hud?.materials) {
        hud.materials.pods.color.setScalar(power.pods);
        hud.materials.panels.color.setScalar(power.pods);
        hud.materials.glass.color.setScalar(power.glassHud);
        hud.materials.glass.opacity = hud.materials.glass.map ? power.glassHud : 0;
      }
      glassU.open.value = beat?.open ?? 1;
      glassU.boot.value = beat?.band ?? -1;
      glassU.screen.value = beat?.screen ?? -1;
      glassU.dim.value = beat?.dim ?? 0;
      const plates = beat?.plates;
      HATCH_PLATES.forEach((name, i) => {
        const mesh = meshes[name], closed = plates?.closed[i] ?? 0;
        mesh.visible = !!plates?.visible && closed > 0.001;
        if (mesh.visible) mesh.userData.local.makeTranslation(parts.hatchTravel[name] * (1 - closed) + Math.sign(parts.hatchTravel[name]) * (plates.rock[i] ?? 0), 0, 0);
      });
      seamMat.uniforms.flash.value = beat?.seams ?? 0;
      meshes.hatchSeams.visible = !!plates?.visible && (beat?.seams ?? 0) > 0.01;
      drawBanner(banner, lines, ink);
      bannerMat.opacity = bannerAlpha;
      meshes.banner.visible = bannerAlpha > 0.01 && !!banner;
    },

    /** Paint the screen damage over the MFD atlas (after the cockpit drew it). */
    paintScreens(g, regions, now) {
      if (!g) return;
      for (const [name, level] of Object.entries(S.screens)) {
        const region = regions[name];
        if (!region || !level) continue;
        const [x, y, w, h] = region;
        g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
        if (level === 1) {
          // Glitch: torn horizontal bands now and then.
          if (Math.random() < 0.45) for (let k = 0; k < 3; k++) {
            const by = y + Math.random() * h, bh = 4 + Math.random() * 14;
            g.drawImage?.(g.canvas, x, by, w, bh, x + (Math.random() - 0.5) * 30, by, w, bh);
            g.fillStyle = `rgba(${Math.random() < 0.5 ? '255,60,90' : '90,220,255'},0.18)`; g.fillRect(x, by, w, bh);
          }
        } else {
          // Static noise.
          const dots = level >= 3 ? 420 : 160;
          for (let k = 0; k < dots; k++) {
            const c = Math.floor(Math.random() * 200);
            g.fillStyle = `rgba(${c},${c},${c},${level >= 3 ? 0.9 : 0.35})`;
            g.fillRect(x + Math.random() * w, y + Math.random() * h, 3, 2);
          }
          if (level >= 3) {
            g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(x, y, w, h);
            g.font = "700 30px 'Rajdhani', 'Bahnschrift', sans-serif"; g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillStyle = Math.floor(now * 2) % 2 ? '#ff3355' : '#7a1020';
            g.fillText('NO SIGNAL', x + w / 2, y + h / 2);
          }
          // A cracked screen: rays from an impact point (fixed per screen).
          const seed = name.length * 3.1 + S.seed;
          const cx = x + w * (0.3 + hash(seed, 1) * 0.4), cy = y + h * (0.3 + hash(seed, 2) * 0.4);
          g.strokeStyle = 'rgba(225,235,245,0.75)'; g.lineWidth = 1.5;
          for (let k = 0; k < 9; k++) {
            const a = k / 9 * Math.PI * 2 + hash(seed, k + 3) * 0.5, len = Math.max(w, h) * (0.25 + hash(seed, k + 13) * 0.45);
            const bx = cx + Math.cos(a) * len * 0.5 + (hash(seed, k + 23) - 0.5) * 12, by = cy + Math.sin(a) * len * 0.5;
            g.beginPath(); g.moveTo(cx, cy); g.lineTo(bx, by); g.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len); g.stroke();
          }
          g.beginPath(); g.arc(cx, cy, 7, 0, Math.PI * 2); g.fillStyle = 'rgba(230,240,250,0.6)'; g.fill();
        }
        g.restore();
      }
    },

    dispose() {
      for (const mesh of Object.values(meshes)) { mesh.removeFromParent(); mesh.geometry.dispose(); }
      for (const m of [solid, glow, smokeMat, flameMat, bannerMat, seamMat]) m.dispose();
      banner?.texture.dispose();
    },
  };
}

/** Test hook: the fx part geometry of a cabin (eye metres). */
export const cockpitFxParts = buildParts;
