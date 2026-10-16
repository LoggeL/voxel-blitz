// Titan cockpit (docs/titanfall.md §7.2; concept docs/design/titanfall/cockpit/, alternative A
// "armoured hatch"): a closed armoured cabin around the seat eye per frame class (ATLAS octagon
// hatch, OGRE low wide visor under a heavy brow, STRYDER tall trapezoid with side panes), with
// heavy bolted struts and hazard edges, MFDs drawn from the titan row (titan-hud-state.js
// titanModel: hull, shield, doom, weapon, abilities, core, heading), lit key banks, switches,
// sticks, cables, vents, warning lamps that react (doom flashes red, a hit flickers and
// sparks, a ready core glows) and a baked interior light.
//
// Like a view model it is drawn with its own fixed field of view (TITAN_COCKPIT.fov, widened
// only on narrow screens), locked to the camera with a little sway, and compressed into the
// front of the depth range: the settings FOV (65-100), the vehicle speed widening and the
// titanfall FOV punch change the world through the viewport but never open a gap around the
// cabin, and no world or own-hull geometry pokes through its walls. The cabin is closed in every
// direction (tools/titanfall-model-budget-test.mjs ray-casts it), so neither sway nor a lagging
// hull can show the outside except through the viewport glass.
//
// Installed into cockpit-overlay.js (setTitanCockpitBuilder) when the titanfall client loads;
// VehicleView calls `update(row)` per frame while the cockpit is shown. Presentation only.
import * as THREE from '../vendor/three.module.js';
import { mergeGeometries } from '../vendor/utils/BufferGeometryUtils.js';
import { TITAN_CHASSIS, TITAN_LABELS, isTitanType } from '../../../shared/titan-contract.js';
import { TITAN_DEFS_INPUT } from '../../../shared/vehicle-handling/titan.js';
import { titanModel, touchLabel } from './titan-hud-state.js';
import { setTitanCockpitBuilder, titanHullFrame } from '../vehicles/cockpit-overlay.js';
import { createCockpitHud, cockpitHudKeys, COCKPIT_HUD_WARMUP_MATERIALS } from './titan-cockpit-hud.js';
import { createCockpitFx, COCKPIT_FX_WARMUP_MATERIALS } from './titan-cockpit-fx.js';
import { transitFor } from './titan-transit.js';

/** Tuning (presentation only). */
export const TITAN_COCKPIT = Object.freeze({
  fov: 75,            // the cockpit's own vertical FOV (degrees), whatever the camera's
  minTanH: 0.98,      // narrow screens: the cockpit's horizontal half-FOV tangent stays at least this ...
  maxSqueeze: 1.75,   // ... squeezing x up to this much before its vertical FOV widens too
  depth: 0.02,        // share of the depth range the cockpit draws into (in front of the world)
  refreshHz: 12,      // MFD canvas redraws per second (gauges at least 10 Hz)
  sway: { gain: 0.03, max: 0.016, rate: 9, jolt: 0.012 },
  // Own primary shots (titan-weapon-feel.js kick()): the cabin is thrown back on a damped spring
  // (stiffness 1/s², damping ratio), its offsets clamped so the closed cabin always surrounds the eye.
  kick: { stiffness: 220, damping: 0.42, maxAngle: 0.06, maxPush: 0.09 },
  eyeTolerance: 2.5,  // metres between the camera and the hull eye before the cockpit hides (other cameras)
  hitFlicker: 0.22,   // seconds of flicker after a hull hit
  // Phone portrait: the touch layout's ability row and DOOMED chip own the console band, so the MFDs go dark.
  screensMinAspect: 0.8,
});

/** Shader programs the titan warm-up links before the first embark (titan-presentation.js). */
export const TITAN_COCKPIT_WARMUP_MATERIALS = Object.freeze(['titan-cockpit-shell', 'titan-cockpit-keys', 'titan-cockpit-warn',
  'titan-cockpit-accent', 'titan-cockpit-screens', 'titan-cockpit-glass', 'titan-cockpit-sparks', ...COCKPIT_HUD_WARMUP_MATERIALS,
  ...COCKPIT_FX_WARMUP_MATERIALS]);

/** Per-titan accent (struts, MFD ink, status strips). */
export const TITAN_COCKPIT_ACCENT = Object.freeze({
  titan_ion: { accent: 0x40c8ff, ink: '#62d6ff' }, titan_scorch: { accent: 0xff8a2a, ink: '#ffa24a' },
  titan_northstar: { accent: 0x7ff0e0, ink: '#8ff5e6' }, titan_ronin: { accent: 0x8a9cff, ink: '#aab6ff' },
  titan_legion: { accent: 0xd6e05a, ink: '#dfe76c' },
});

/**
 * Cabin per frame class, in eye metres (x right, y up, -z forward): side walls at ±W, roof R,
 * floor F, the bulkhead's inner face at z = -D (T thick), the rear wall at z = B; the viewport
 * polygons (x, y) in the bulkhead.
 */
const octagon = (xh, top, bot, [tx, ty], [bx, by]) => [[-xh + bx, bot], [xh - bx, bot], [xh, bot + by], [xh, top - ty], [xh - tx, top],
  [-xh + tx, top], [-xh, top - ty], [-xh, bot + by]];
const CABINS = Object.freeze({
  atlas: { W: 1.36, R: 0.82, F: -1.45, D: 1.05, T: 0.12, B: 0.55, strut: 0.14,
    windows: [octagon(1.08, 0.56, -0.34, [0.32, 0.22], [0.26, 0.16])] },
  ogre: { W: 1.46, R: 0.74, F: -1.5, D: 1.0, T: 0.16, B: 0.55, strut: 0.18,
    windows: [octagon(1.14, 0.42, -0.27, [0.18, 0.12], [0.22, 0.12])] },
  stryder: { W: 1.3, R: 0.92, F: -1.4, D: 1.08, T: 0.1, B: 0.55, strut: 0.1,
    windows: [
      [[-0.72, -0.36], [0.72, -0.36], [0.86, -0.24], [0.7, 0.6], [0.56, 0.68], [-0.56, 0.68], [-0.7, 0.6], [-0.86, -0.24]],
      [[1.02, -0.2], [1.2, -0.14], [1.2, 0.32], [0.92, 0.46]],
      [[-1.02, -0.2], [-0.92, 0.46], [-1.2, 0.32], [-1.2, -0.14]],
    ] },
});

// Colours (sRGB): gunmetal plates, lighter strut faces, seams, bolts, hazard stripes, cables, handles.
const C = Object.freeze({
  plate: 0x4a525c, dark: 0x343a42, strut: 0x5d6671, seam: 0x1c2025, bolt: 0x9aa3ad, hazY: 0xe8a823, hazK: 0x1b1d20,
  cableR: 0x5a221d, cableK: 0x1c1e22, cableB: 0x1f3a55, cableY: 0x4a4436, handle: 0xa8781a, grip: 0x1a1c1f, vent: 0x262a30,
  console: 0x3e454e, bezel: 0x14171a, keyOff: 0x2c3238, rubber: 0x2a2d31,
});
const KEY = Object.freeze({ green: 0x59f08a, amber: 0xffa23a, red: 0xff4a3a, white: 0xd8e6f0, blue: 0x45b8ff });

// ---------------------------------------------------------------------------------- frustum

/** The cockpit's own frustum for a screen aspect: { tanH, tanV } (half-FOV tangents). */
export function cockpitFrustum(aspect) {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const tanV0 = Math.tan(THREE.MathUtils.degToRad(TITAN_COCKPIT.fov / 2));
  const tanV = Math.max(tanV0, TITAN_COCKPIT.minTanH / (a * TITAN_COCKPIT.maxSqueeze));
  return { tanH: Math.max(tanV * a, TITAN_COCKPIT.minTanH), tanV };
}

/** View-space scale { kx, ky } that shows the cockpit through `camera` as if through its own frustum. */
export function cockpitScale(camera) {
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / (camera.zoom || 1);
  const own = cockpitFrustum(camera.aspect);
  return { kx: tanV * camera.aspect / own.tanH, ky: tanV / own.tanV };
}

// ---------------------------------------------------------------------------------- geometry

const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

/** Convex polygon (CCW) offset outward by w. */
function offsetPolygon(points, w) {
  const n = points.length, lines = [];
  for (let i = 0; i < n; i++) {
    const [ax, ay] = points[i], [bx, by] = points[(i + 1) % n];
    const len = Math.hypot(bx - ax, by - ay) || 1, nx = (by - ay) / len, ny = -(bx - ax) / len;
    lines.push([ax + nx * w, ay + ny * w, bx - ax, by - ay]);
  }
  return lines.map((line, i) => {
    const [px, py, dx, dy] = lines[(i + n - 1) % n], [qx, qy, ex, ey] = line;
    const det = dx * ey - dy * ex;
    if (Math.abs(det) < 1e-9) return [qx, qy];
    const t = ((qx - px) * ey - (qy - py) * ex) / det;
    return [px + dx * t, py + dy * t];
  });
}

const signedArea = points => points.reduce((sum, [x, y], i) => { const [x2, y2] = points[(i + 1) % points.length]; return sum + x * y2 - x2 * y; }, 0) / 2;
const ccw = points => (signedArea(points) < 0 ? [...points].reverse() : [...points]);

/** Keeps only `keep` attributes, non-indexed. */
function plain(geometry, keep) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  if (g !== geometry) geometry.dispose();
  for (const name of Object.keys(g.attributes)) if (!keep.includes(name)) g.deleteAttribute(name);
  g.clearGroups();
  return g;
}

/** Collects pieces per material kind; `bake` lights the shell. */
class Kit {
  constructor(cabin) {
    this.cabin = cabin;
    this.parts = { shell: [], keys: [], warn: [], accent: [], screens: [], glass: [] };
    this.glows = [];
  }

  add(kind, geometry, color = 0xffffff) {
    if (!geometry.attributes.normal && kind === 'shell') geometry.computeVertexNormals();
    geometry.userData.color = color;
    this.parts[kind].push(geometry);
    return geometry;
  }

  /** Axis-aligned box from min to max. */
  box(min, max, color = C.plate, kind = 'shell') {
    const size = [0, 1, 2].map(i => Math.max(0.004, max[i] - min[i]));
    const g = new THREE.BoxGeometry(...size);
    g.translate((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    return this.add(kind, g, color);
  }

  /** A box of `size` in the frame (right, up, normal) at `center`. */
  obox(center, size, basis, color = C.plate, kind = 'shell') {
    const g = new THREE.BoxGeometry(...size);
    g.applyMatrix4(_m.makeBasis(basis[0], basis[1], basis[2]).setPosition(center[0], center[1], center[2]));
    return this.add(kind, g, color);
  }

  /** A square-section bar from a to b. */
  bar(a, b, width = 0.05, color = C.strut, kind = 'shell', depth = width) {
    const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b), length = from.distanceTo(to);
    if (length < 1e-4) return null;
    const g = new THREE.BoxGeometry(width, length, depth);
    g.applyQuaternion(_q.setFromUnitVectors(UP, to.sub(from).normalize()));
    g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    return this.add(kind, g, color);
  }

  /** A round tube through points (cables, handles, ribs). */
  tube(points, radius, color, kind = 'shell', segments = 14, radial = 6) {
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
    return this.add(kind, new THREE.TubeGeometry(curve, segments, radius, radial, false), color);
  }

  /** A hex bolt head (or round knob) on a surface with outward normal `normal`. */
  bolt(at, normal = [0, 0, 1], radius = 0.017, color = C.bolt, kind = 'shell', sides = 6, height = 0.02) {
    const g = new THREE.CylinderGeometry(radius, radius * 1.05, height, sides);
    g.applyQuaternion(_q.setFromUnitVectors(UP, _n.set(...normal).normalize()));
    g.translate(at[0] + normal[0] * height / 2, at[1] + normal[1] * height / 2, at[2] + normal[2] * height / 2);
    return this.add(kind, g, color);
  }

  /** A slab with polygon (x, y) holes, extruded along +z from z0 by `depth`. */
  plate(outer, holes, z0, depth, color) {
    const shape = new THREE.Shape(ccw(outer).map(([x, y]) => new THREE.Vector2(x, y)));
    for (const hole of holes) shape.holes.push(new THREE.Path(ccw(hole).reverse().map(([x, y]) => new THREE.Vector2(x, y))));
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
    g.translate(0, 0, z0);
    return this.add('shell', g, color);
  }

  /** A flat quad list facing +z at depth z: [[x, y] x4] per quad. */
  quads(list, z, color, kind = 'shell') {
    const positions = [];
    // Counter-clockwise seen from +z whatever the corner order (the inner edge runs CCW, the outer edge outside it).
    for (const [a, b, c, d] of list) {
      const flip = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0;
      const [p1, p2, p3, p4] = flip ? [a, d, c, b] : [a, b, c, d];
      positions.push(...p1, z, ...p2, z, ...p3, z, ...p1, z, ...p3, z, ...p4, z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(positions.map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
    return this.add(kind, g, color);
  }

  /** Yellow-black hazard stripes in the band between a polygon and its offset by w, facing +z at depth z. */
  hazard(points, w, z, pitch = 0.07) {
    const outer = offsetPolygon(points, w), yellow = [], black = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length], oa = outer[i], ob = outer[(i + 1) % points.length];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]), count = Math.max(1, Math.round(length / pitch));
      const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      for (let k = 0; k < count; k++) {
        const t0 = k / count, t1 = (k + 1) / count, skew = 0.5 / count;
        const quad = [lerp(a, b, t0), lerp(a, b, t1), lerp(oa, ob, Math.min(1, t1 + skew)), lerp(oa, ob, Math.min(1, t0 + skew))];
        (k % 2 ? black : yellow).push(quad);
      }
    }
    this.quads(yellow, z, C.hazY);
    this.quads(black, z, C.hazK);
  }

  /** Hazard stripes in a band of `width` centred on the segment a -> b (x, y), facing +z at depth z. */
  hazardBand(a, b, width, z, pitch = 0.08) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), dir = [(b[0] - a[0]) / len, (b[1] - a[1]) / len], n = [-dir[1], dir[0]];
    const count = Math.max(1, Math.round(len / pitch)), skew = width / len, yellow = [], black = [];
    const at = (t, side) => [a[0] + (b[0] - a[0]) * Math.min(1, t) + n[0] * side * width / 2, a[1] + (b[1] - a[1]) * Math.min(1, t) + n[1] * side * width / 2];
    for (let k = 0; k < count; k++) {
      const t0 = k / count, t1 = (k + 1) / count;
      (k % 2 ? black : yellow).push([at(t0, -1), at(t1, -1), at(t1 + skew, 1), at(t0 + skew, 1)]);
    }
    this.quads(yellow, z, C.hazY);
    this.quads(black, z, C.hazK);
  }

  /** A lit display: plane w x h at `center` in the frame (right, up, normal), atlas region `region`. */
  screen(center, [w, h], basis, region) {
    const g = new THREE.PlaneGeometry(w, h);
    const uv = g.attributes.uv, [u0, v0, u1, v1] = regionUv(region);
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    g.applyMatrix4(_m.makeBasis(basis[0], basis[1], basis[2]).setPosition(center[0], center[1], center[2]));
    return this.add('screens', g);
  }

  /** Viewport glass over a polygon at depth z (uv normalised over its bounds for the edge vignette). */
  glass(points, z) {
    const grown = offsetPolygon(ccw(points), 0.012);
    const g = new THREE.ShapeGeometry(new THREE.Shape(grown.map(([x, y]) => new THREE.Vector2(x, y))));
    g.translate(0, 0, z);
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const pos = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) - x0) / (x1 - x0), (pos.getY(i) - y0) / (y1 - y0));
    return this.add('glass', g);
  }

  /** Bake the interior light into the shell's vertex colours; flat colours elsewhere. Returns merged geometries. */
  finish() {
    const out = {};
    for (const [kind, list] of Object.entries(this.parts)) {
      if (!list.length) continue;
      const keep = kind === 'screens' || kind === 'glass' ? ['position', 'uv'] : ['position', 'color'];
      const ready = list.map(g => {
        if (kind === 'shell') bake(g, this.cabin, this.glows);
        else if (keep.includes('color')) flat(g);
        return plain(g, keep);
      });
      out[kind] = mergeGeometries(ready);
      for (const g of ready) g.dispose();
      out[kind].computeBoundingSphere();
    }
    return out;
  }
}

function flat(geometry) {
  const color = new THREE.Color(geometry.userData.color ?? 0xffffff), count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) { colors[i * 3] = color.r; colors[i * 3 + 1] = color.g; colors[i * 3 + 2] = color.b; }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Interior light baked per vertex: an ambient that rises toward the roof, the warm dome lamp,
 * the cool daylight through the viewport, the MFD glows, and corner occlusion where two cabin
 * planes meet (soft shadows in the seams).
 */
function bake(geometry, cabin, glows) {
  const pos = geometry.attributes.position, nor = geometry.attributes.normal, count = pos.count;
  const base = new THREE.Color(geometry.userData.color ?? C.plate), colors = new Float32Array(count * 3);
  const lights = [
    { at: [0, cabin.R - 0.06, -0.2], color: [1.0, 0.86, 0.68], power: 1.05, range: 1.05 },
    { at: [0, 0.05, -cabin.D - 1.1], color: [0.74, 0.84, 1.0], power: 0.95, range: 1.4 },
    ...glows,
  ];
  for (let i = 0; i < count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
    const h = Math.min(1, Math.max(0, (y - cabin.F) / (cabin.R - cabin.F)));
    let r = 0.17 + 0.15 * h, g = r, b = r + 0.02;
    for (const light of lights) {
      const lx = light.at[0] - x, ly = light.at[1] - y, lz = light.at[2] - z, d = Math.hypot(lx, ly, lz) || 1;
      const ndl = Math.max(0, ((nx * lx + ny * ly + nz * lz) / d + 0.2) / 1.2);
      const k = light.power * ndl * light.range * light.range / (light.range * light.range + d * d);
      r += light.color[0] * k; g += light.color[1] * k; b += light.color[2] * k;
    }
    const near = [cabin.W - Math.abs(x), cabin.R - y, y - cabin.F, z + cabin.D, cabin.B - z].map(d => 1 - smooth(0, 0.24, d));
    let corner = 0;
    for (let a = 0; a < near.length; a++) for (let c = a + 1; c < near.length; c++) corner += near[a] * near[c];
    const ao = 1 - 0.42 * Math.min(1, corner);
    colors[i * 3] = Math.min(1.6, base.r * r * ao * 1.7);
    colors[i * 3 + 1] = Math.min(1.6, base.g * g * ao * 1.7);
    colors[i * 3 + 2] = Math.min(1.6, base.b * b * ao * 1.7);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// ---------------------------------------------------------------------------------- MFD atlas

/** Atlas regions (px in a 1024 x 512 canvas): [x, y, w, h]. */
const ATLAS = Object.freeze({ width: 1024, height: 512 });
const REGION = Object.freeze({
  status: [0, 0, 400, 240], radar: [404, 0, 240, 240], weapon: [648, 0, 376, 240],
  aux: [0, 248, 256, 128], caution: [260, 248, 192, 128],
});
function regionUv([x, y, w, h]) {
  return [x / ATLAS.width, 1 - (y + h) / ATLAS.height, (x + w) / ATLAS.width, 1 - y / ATLAS.height];
}
const regionAspect = name => REGION[name][2] / REGION[name][3];

const FONT = "'Rajdhani', 'Bahnschrift', 'Arial Narrow', 'Roboto Condensed', sans-serif";
const INK = Object.freeze({ dim: '#24313a', bg: '#05090c', ok: '#7fd069', shield: '#45b8ff', amber: '#ff9f1c', danger: '#ff3355', white: '#e6eef4' });

/** Draws every MFD from the titan model `s` (titanModel) at time t (seconds); s null = standby. */
function drawAtlas(g, type, s, t, extra) {
  const ink = TITAN_COCKPIT_ACCENT[type]?.ink ?? '#62d6ff';
  const doomed = !!s?.doomed, alarm = doomed && Math.floor(t * 3) % 2 === 0;
  const panel = (name, draw) => {
    const [x, y, w, h] = REGION[name];
    g.save(); g.translate(x, y);
    g.fillStyle = INK.bg; g.fillRect(0, 0, w, h);
    g.beginPath(); g.rect(0, 0, w, h); g.clip();
    draw(w, h);
    // Scanlines and a soft inner frame.
    g.fillStyle = 'rgba(0,0,0,0.18)';
    for (let k = 0; k < h; k += 4) g.fillRect(0, k, w, 1);
    g.strokeStyle = doomed ? '#5a1018' : '#12303c'; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6);
    g.restore();
  };
  const text = (value, x, y, size, color, align = 'left', weight = 700) => {
    g.font = `${weight} ${size}px ${FONT}`; g.textAlign = align; g.textBaseline = 'alphabetic'; g.fillStyle = color; g.fillText(value, x, y);
  };
  const bar = (x, y, w, h, frac, color, cells = 16) => {
    const cw = w / cells;
    for (let i = 0; i < cells; i++) {
      g.fillStyle = (i + 0.5) / cells <= frac ? color : INK.dim;
      g.fillRect(x + i * cw + 1, y, cw - 3, h);
    }
  };

  panel('status', (w, h) => {
    text(`${TITAN_LABELS[type] ?? 'TITAN'} · ${(TITAN_CHASSIS[type] ?? '').toUpperCase()}`, 18, 34, 26, ink);
    if (!s) { text('SYSTEMS STANDBY', 18, 120, 30, INK.white); return; }
    // Titan glyph coloured by hull state.
    const hull = doomed ? INK.danger : s.hpFrac > 0.5 ? INK.ok : s.hpFrac > 0.25 ? INK.amber : INK.danger;
    g.fillStyle = doomed && !alarm ? '#5a1018' : hull;
    const gx = 22, gy = 54;
    for (const [x, y, rw, rh] of [[22, 0, 26, 22], [10, 24, 50, 46], [0, 26, 10, 38], [60, 26, 10, 38], [14, 72, 16, 58], [40, 72, 16, 58]]) g.fillRect(gx + x, gy + y, rw, rh);
    if (doomed) {
      text('DOOMED', 120, 92, 46, alarm ? INK.danger : '#ff8899');
      bar(120, 110, w - 140, 18, s.doomFrac, INK.danger, 14);
      text(s.eject?.key ? `${s.eject.key} ×3 · EJECT` : 'TAP EJECT ×3', 120, 162, 26, INK.white);   // eject is a triple tap
    } else {
      text('HULL', 120, 72, 22, INK.white, 'left', 600);
      text(`${Math.ceil(s.hp)}`, w - 18, 72, 26, hull, 'right');
      bar(120, 82, w - 140, 20, s.hpFrac, hull);
      text('SHIELD', 120, 136, 22, INK.white, 'left', 600);
      text(`${Math.ceil(s.shield)}`, w - 18, 136, 26, INK.shield, 'right');
      bar(120, 146, w - 140, 14, s.shieldMax > 0 ? s.shield / s.shieldMax : 0, INK.shield);
    }
    // Dash pips.
    text('DASH', 120, 212, 20, INK.white, 'left', 600);
    s.dash?.cells?.forEach((fill, i) => {
      g.fillStyle = INK.dim; g.fillRect(186 + i * 46, 194, 38, 20);
      g.fillStyle = INK.amber; g.fillRect(186 + i * 46, 194, 38 * fill, 20);
    });
  });

  panel('radar', (w, h) => {
    const cx = w / 2, cy = h / 2 + 4, r = 92;
    // Core charge ring around the scope.
    const core = s?.core?.frac ?? 0, ready = !!s?.core?.ready, active = !!s?.core?.active;
    g.lineWidth = 9; g.strokeStyle = INK.dim; g.beginPath(); g.arc(cx, cy, r + 12, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = active ? INK.white : ready ? (Math.floor(t * 4) % 2 ? INK.amber : '#ffe2a8') : INK.amber;
    g.beginPath(); g.arc(cx, cy, r + 12, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * core); g.stroke();
    g.lineWidth = 2; g.strokeStyle = doomed ? '#7a1a22' : '#1f6b3e';
    for (const k of [0.33, 0.66, 1]) { g.beginPath(); g.arc(cx, cy, r * k, 0, Math.PI * 2); g.stroke(); }
    // Compass ticks turn with the hull heading.
    const yaw = extra.yaw ?? 0;
    g.strokeStyle = '#59f08a'; g.fillStyle = '#59f08a';
    for (let i = 0; i < 24; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 12 + yaw, len = i % 6 === 0 ? 12 : 5;
      g.beginPath(); g.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); g.lineTo(cx + Math.cos(a) * (r - len), cy + Math.sin(a) * (r - len)); g.stroke();
    }
    ['N', 'E', 'S', 'W'].forEach((label, i) => {
      const a = -Math.PI / 2 + i * Math.PI / 2 + yaw;
      text(label, cx + Math.cos(a) * (r - 24), cy + Math.sin(a) * (r - 24) + 7, 20, '#59f08a', 'center');
    });
    // Sweep.
    const sweep = t * 2.2;
    const grad = g.createLinearGradient?.(cx, cy, cx + Math.cos(sweep) * r, cy + Math.sin(sweep) * r);
    grad?.addColorStop?.(0, 'rgba(89,240,138,0.05)'); grad?.addColorStop?.(1, 'rgba(89,240,138,0.85)');
    g.strokeStyle = grad ?? '#59f08a'; g.lineWidth = 3; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(sweep) * r, cy + Math.sin(sweep) * r); g.stroke();
    g.fillStyle = ink; g.beginPath(); g.moveTo(cx, cy - 11); g.lineTo(cx + 8, cy + 8); g.lineTo(cx, cy + 3); g.lineTo(cx - 8, cy + 8); g.closePath(); g.fill();
    text(active ? 'CORE ONLINE' : ready ? 'CORE READY' : `CORE ${s?.core?.pct ?? 0}%`, cx, h - 6, 20, ready || active ? INK.amber : INK.white, 'center');
  });

  panel('weapon', (w, h) => {
    const weapon = s?.weapon;
    text(weapon?.label ?? 'ARMAMENT', 18, 34, 26, ink);
    if (!s) return;
    const reloading = (weapon?.reload ?? 0) > 0;
    text(reloading ? 'RELOAD' : weapon?.ammoText ?? '∞', 18, 82, reloading ? 34 : 44, reloading ? INK.amber : INK.white);
    bar(150, 58, w - 168, 20, reloading ? weapon.reload : weapon?.frac ?? 1, reloading ? INK.amber : INK.shield, 14);
    // Ability tiles: fill rises with readiness.
    (s.abilities ?? []).forEach((slot, i) => {
      const x = 18 + i * 116, y = 108, tw = 104, th = 88;
      g.fillStyle = '#0c151b'; g.fillRect(x, y, tw, th);
      g.fillStyle = slot.state === 'ready' ? 'rgba(255,159,28,0.28)' : slot.state === 'active' ? 'rgba(98,214,255,0.35)' : 'rgba(255,255,255,0.08)';
      g.fillRect(x, y + th * (1 - slot.ready), tw, th * slot.ready);
      g.strokeStyle = slot.state === 'ready' ? INK.amber : '#2a3a44'; g.lineWidth = 3; g.strokeRect(x + 1.5, y + 1.5, tw - 3, th - 3);
      text(slot.key || '', x + 10, y + 30, 24, INK.white);
      text(slot.state === 'ready' ? 'RDY' : slot.state === 'active' ? 'ON' : `${slot.readyPct}%`, x + tw - 10, y + 30, 22, slot.state === 'ready' ? INK.amber : INK.white, 'right');
      text(touchLabel(slot.label), x + tw / 2, y + th - 14, 19, '#9fb3c0', 'center', 600);   // shared short name
    });
    text('SMOKE', 18, 228, 20, INK.white, 'left', 600);
    for (let i = 0; i < (s.smoke?.max ?? 0); i++) { g.fillStyle = i < (s.smoke?.charges ?? 0) ? INK.amber : INK.dim; g.fillRect(90 + i * 28, 212, 20, 18); }
    if (s.lock) text(s.lock.label, w - 18, 228, 22, Math.floor(t * 6) % 2 ? INK.danger : INK.amber, 'right');
  });

  panel('aux', (w, h) => {
    const weapon = s?.weapon;
    const label = { titan_ion: 'ENERGY', titan_scorch: 'THERMAL', titan_northstar: 'RAIL CHARGE', titan_ronin: 'SHELLS', titan_legion: 'BARREL' }[type] ?? 'AUX';
    text(label, 14, 30, 22, ink);
    const value = !s ? 0 : type === 'titan_northstar' ? weapon?.charge ?? 0 : type === 'titan_scorch' || type === 'titan_legion' ? Math.max(weapon?.heat ?? 0, weapon?.charge ?? 0) : weapon?.frac ?? 0;
    for (let i = 0; i < 12; i++) {
      const lit = (i + 0.5) / 12 <= value;
      g.fillStyle = lit ? (i > 9 ? INK.danger : i > 7 ? INK.amber : ink) : INK.dim;
      g.fillRect(14 + i * 19, 50 + (11 - i) * 3, 15, 56 - (11 - i) * 3);
    }
  });

  panel('caution', (w, h) => {
    const cells = !s ? [] : [
      ['SHLD', s.shield > 0 ? INK.ok : INK.amber], ['HULL', doomed ? INK.danger : s.hpFrac > 0.5 ? INK.ok : s.hpFrac > 0.25 ? INK.amber : INK.danger],
      ['CORE', s.core?.ready || s.core?.active ? INK.amber : '#3a4a54'], ['DOOM', doomed ? (alarm ? INK.danger : '#5a1018') : '#3a4a54'],
      ['BATT', s.batteryOut ? INK.danger : INK.ok], ['RIDR', s.rider ? (Math.floor(t * 4) % 2 ? INK.danger : INK.amber) : '#3a4a54'],
    ];
    cells.forEach(([label, color], i) => {
      const x = 10 + (i % 3) * 60, y = 12 + Math.floor(i / 3) * 56;
      g.fillStyle = color; g.fillRect(x, y, 54, 48);
      text(label, x + 27, y + 32, 18, '#05090c', 'center');
    });
  });
}

// ---------------------------------------------------------------------------------- materials

const DEPTH_GLSL = `gl_Position.z = mix(-gl_Position.w, gl_Position.z, ${TITAN_COCKPIT.depth.toFixed(4)});`;

/** Draw in the front of the depth range (a view model: no world or own-hull geometry pokes through). */
function nearDepth(material) {
  material.onBeforeCompile = shader => { shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>\n\t${DEPTH_GLSL}`); };
  material.customProgramCacheKey = () => 'titan-cockpit-near-depth';
  return material;
}

const GLASS_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  ${DEPTH_GLSL}
}`;
// Viewport glass: a faint blue-grey tint, a soft vignette and amber corner ticks at the edge; red pulse when doomed.
// Damage (titan-cockpit-fx.js): up to 6 star cracks (uv centre, radius in glass heights, seed) with
// radial rays, branch rays, broken ring fractures and a frosted impact; `open` fades the glass
// (the hatch swings away on exit); `boot` (0..1, < 0 off) sweeps a scan band down on embark.
// `screen` (0..1, < 0 off) is the closed hatch's screen powering on (titan-embark-boot.js): black, a
// bright line across the middle draws out, opens into the outside feed, tinted with scanlines and
// rolling bands that settle into the plain glass. `dim` (0..1) darkens it (reduced motion).
const GLASS_FRAGMENT = /* glsl */ `
uniform float doom;
uniform float time;
uniform vec4 cracks[6];
uniform int crackCount;
uniform float aspect;
uniform float open;
uniform float boot;
uniform float screen;
uniform float dim;
varying vec2 vUv;
float h1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
float rays(vec2 d, float r, float radius, float seed, float n, float reach, float width) {
  float a = atan(d.y, d.x) + 3.14159265;
  float sector = floor(a / 6.2831853 * n);
  float h = h1(sector + seed * 3.7);
  float ang = (sector + 0.5 + (h - 0.5) * 0.55) / n * 6.2831853 - 3.14159265;
  vec2 dir = vec2(cos(ang), sin(ang));
  float along = dot(d, dir);
  // A kink half way: the outer part bends a little.
  float bend = (h1(sector * 1.7 + seed) - 0.5) * 0.35 * smoothstep(radius * 0.35, radius, along);
  float off = abs(d.x * dir.y - d.y * dir.x - bend * along * 0.3);
  float len = radius * reach * (0.5 + 0.5 * h);
  float on = step(0.0, along) * step(along, len);
  return on * smoothstep(width, 0.0, off) * (1.0 - 0.6 * along / max(len, 1e-4));
}
float crack(vec2 p, vec4 c) {
  vec2 d = p - vec2(c.x * aspect, c.y);
  float r = length(d);
  if (c.z <= 0.0 || r > c.z * 1.1) return 0.0;
  float line = rays(d, r, c.z, c.w, 9.0, 1.0, 0.0048);
  line = max(line, rays(d, r, c.z, c.w + 11.0, 15.0, 0.5, 0.0032) * 0.85);
  // Ring fractures: broken arcs at two radii.
  float a = atan(d.y, d.x) + 3.14159265;
  for (int k = 1; k <= 2; k++) {
    float rr = c.z * (0.22 + 0.2 * float(k));
    float seg = floor(a / 6.2831853 * 11.0);
    float keep = step(0.45, h1(seg + c.w * 5.0 + float(k) * 13.0));
    line = max(line, keep * smoothstep(0.004, 0.0, abs(r - rr - (h1(seg + c.w) - 0.5) * 0.01)) * 0.85);
  }
  float frost = smoothstep(c.z * 0.12, 0.0, r) * 0.75;
  return clamp(max(line, frost), 0.0, 1.0);
}
void main() {
  float edge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
  float v = 1.0 - smoothstep(0.0, 0.16, edge);
  vec2 c = abs(vUv - 0.5);
  float tick = step(0.47, max(c.x, c.y)) * step(0.4, min(c.x, c.y)) * (1.0 - step(0.485, max(c.x, c.y)));
  float pulse = doom * (0.5 + 0.5 * sin(time * 12.0));
  vec3 color = mix(vec3(0.5, 0.58, 0.68), vec3(1.0, 0.16, 0.12), pulse * 0.8);
  color = mix(color, vec3(1.0, 0.62, 0.11), tick * 0.85);
  float alpha = 0.03 + 0.24 * v * v + pulse * 0.07 + tick * 0.35;
  color *= 1.0 - 0.45 * v;
  float cr = 0.0;
  vec2 p = vec2(vUv.x * aspect, vUv.y);
  for (int i = 0; i < 6; i++) { if (i >= crackCount) break; cr = max(cr, crack(p, cracks[i])); }
  color = mix(color, vec3(0.9, 0.95, 1.0), cr);
  alpha = max(alpha, cr * 0.8);
  if (boot >= 0.0) {
    float band = exp(-abs(vUv.y - (1.0 - boot)) * 38.0) * (1.0 - boot);
    color = mix(color, vec3(0.3, 0.85, 1.0), band);
    alpha = max(alpha, band * 0.55);
  }
  if (screen >= 0.0) {
    float wide = smoothstep(0.0, 0.18, screen), tall = smoothstep(0.14, 0.58, screen), settle = smoothstep(0.5, 1.0, screen);
    float dx = abs(vUv.x - 0.5), dy = abs(vUv.y - 0.5);
    float halfH = mix(0.004, 0.56, tall * tall);
    float across = 1.0 - smoothstep(wide * 0.52 - 0.02, wide * 0.52, dx);
    float lit = across * (1.0 - smoothstep(halfH - 0.01, halfH, dy));
    float rim = across * exp(-abs(dy - halfH) * 140.0) * (1.0 - 0.75 * tall);
    float scan = 0.5 + 0.5 * sin(vUv.y * 420.0);
    float roll = step(0.8, h1(floor(vUv.y * 40.0 - time * 9.0) + floor(time * 20.0) * 3.1));
    vec3 tint = vec3(0.32, 0.86, 1.0);
    float feed = (0.5 + 0.2 * scan + 0.2 * roll) * (1.0 - settle);
    vec3 sc = tint * lit;
    float sa = mix(1.0, feed, lit);
    sc = mix(sc, vec3(0.85, 0.97, 1.0), clamp(rim, 0.0, 1.0));
    sa = max(sa, clamp(rim, 0.0, 1.0));
    float k = settle * lit;
    color = mix(sc, color, k);
    alpha = mix(sa, alpha, k);
  }
  color = mix(color, vec3(0.0), dim);
  alpha = mix(alpha, 1.0, dim);
  gl_FragColor = vec4(color, alpha * open);
}`;

function makeMaterials(type, map) {
  const accent = TITAN_COCKPIT_ACCENT[type]?.accent ?? 0x40c8ff;
  const m = {
    shell: nearDepth(new THREE.MeshBasicMaterial({ name: 'titan-cockpit-shell', vertexColors: true })),
    keys: nearDepth(new THREE.MeshBasicMaterial({ name: 'titan-cockpit-keys', vertexColors: true, toneMapped: false })),
    warn: nearDepth(new THREE.MeshBasicMaterial({ name: 'titan-cockpit-warn', vertexColors: true, toneMapped: false })),
    accent: nearDepth(new THREE.MeshBasicMaterial({ name: 'titan-cockpit-accent', color: accent, toneMapped: false })),
    screens: nearDepth(new THREE.MeshBasicMaterial({ name: 'titan-cockpit-screens', color: map ? 0xffffff : 0x2a8a52, map, toneMapped: false })),
    glass: new THREE.ShaderMaterial({ name: 'titan-cockpit-glass', vertexShader: GLASS_VERTEX, fragmentShader: GLASS_FRAGMENT,
      uniforms: { doom: { value: 0 }, time: { value: 0 }, cracks: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) },
        crackCount: { value: 0 }, aspect: { value: 2.4 }, open: { value: 1 }, boot: { value: -1 }, screen: { value: -1 }, dim: { value: 0 } },
      transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    sparks: nearDepth(new THREE.MeshBasicMaterial({ name: 'titan-cockpit-sparks', vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false })),
  };
  m.accent.userData.base = new THREE.Color(accent);
  return m;
}

// ---------------------------------------------------------------------------------- the cabin

/** Point on the ray through normalised 16:9 screen coords (u, v) at forward distance `depth`. */
const TAN = Object.freeze({ h: Math.tan(THREE.MathUtils.degToRad(TITAN_COCKPIT.fov / 2)) * 16 / 9, v: Math.tan(THREE.MathUtils.degToRad(TITAN_COCKPIT.fov / 2)) });
const rayAt = (u, v, depth) => [u * TAN.h * depth, v * TAN.v * depth, -depth];

/** Builds the cabin geometry of one titan type: { geometries, eye, cabin, spark anchors }. */
function buildCabin(type) {
  const chassis = TITAN_CHASSIS[type] ?? 'atlas', cab = CABINS[chassis];
  const { W, R, F, D, T, B, strut } = cab;
  const kit = new Kit(cab);
  const front = -D, face = front + 0.001;
  const main = cab.windows[0];
  const xs = main.map(p => p[0]), ys = main.map(p => p[1]);
  const top = Math.max(...ys), bot = Math.min(...ys), half = Math.max(...xs);

  // Heavy strut ring around each viewport (proud of the bulkhead). The main ring's opening is its thin
  // face plate: the ring body and the bulkhead behind it open along the eye rays (scaled by distance), so
  // no reveal eats the viewport while the frame still reads as a thick hatch.
  const ringDepth = 0.1, faceDepth = 0.025, skin = 0.012;
  const aperture = D - ringDepth + faceDepth, flare = D / aperture;
  const scaled = (poly, k) => poly.map(([x, y]) => [x * k, y * k]);
  const holes = cab.windows.map((w, i) => (i === 0 ? scaled(ccw(w), flare) : w));
  // Closed shell: bulkhead skin with the viewport holes, side walls, roof, floor and the rear wall (overlapping seams).
  kit.plate([[-W - 0.08, F - 0.08], [W + 0.08, F - 0.08], [W + 0.08, R + 0.08], [-W - 0.08, R + 0.08]], holes, front - skin, skin, C.plate);
  for (const s of [-1, 1]) kit.box([s > 0 ? W : -W - 0.07, F - 0.07, front - T - 0.02], [s > 0 ? W + 0.07 : -W, R + 0.07, B + 0.07], C.dark);
  kit.box([-W - 0.07, R, front - T - 0.02], [W + 0.07, R + 0.07, B + 0.07], C.dark);
  kit.box([-W - 0.07, F - 0.07, front - T - 0.02], [W + 0.07, F, B + 0.07], C.rubber);
  kit.box([-W - 0.07, F - 0.07, B], [W + 0.07, R + 0.07, B + 0.07], C.dark);
  for (const hole of holes) kit.glass(scaled(hole, 1 + (skin + 0.006) / D), front - skin - 0.004);

  for (const [i, w] of cab.windows.entries()) {
    const width = i === 0 ? strut : strut * 0.7, poly = ccw(w), outer = offsetPolygon(poly, width);
    const depth = i === 0 ? ringDepth : ringDepth * 0.8;
    if (i === 0) {
      kit.plate(outer, [poly], front + depth - faceDepth, faceDepth, C.strut);
      kit.plate(outer, [scaled(poly, flare)], front, depth - faceDepth, C.strut);
    } else kit.plate(outer, [poly], front, depth, C.strut);
    kit.hazard(poly, Math.min(0.055, width * 0.4), front + depth + 0.002, i === 0 ? 0.075 : 0.06);
    const mid = offsetPolygon(poly, width * 0.72);
    for (let k = 0; k < mid.length; k++) {
      const a = mid[k], b = mid[(k + 1) % mid.length], n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.2));
      for (let j = 0; j < n; j++) {
        const t = (j + 0.5) / n;
        kit.bolt([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, front + depth], [0, 0, 1], i === 0 ? 0.016 : 0.012);
      }
    }
  }
  // Bulkhead plating: raised panels with seams and rivets around the ring (the hatch armour).
  const ringTop = top + strut, ringBot = bot - strut, ringSide = Math.max(...cab.windows.flat().map(p => Math.abs(p[0]))) + strut;
  const panel = (x0, y0, x1, y1) => {
    if (x1 - x0 < 0.08 || y1 - y0 < 0.08) return;
    kit.box([x0 + 0.012, y0 + 0.012, front], [x1 - 0.012, y1 - 0.012, front + 0.022], C.dark);
    for (const [x, y] of [[x0 + 0.04, y0 + 0.04], [x1 - 0.04, y0 + 0.04], [x1 - 0.04, y1 - 0.04], [x0 + 0.04, y1 - 0.04]]) kit.bolt([x, y, front + 0.022], [0, 0, 1], 0.011, C.bolt, 'shell', 6, 0.012);
  };
  for (let i = 0; i < 4; i++) panel(-W + i * W / 2, ringTop + 0.03, -W + (i + 1) * W / 2, R);
  for (const s of [-1, 1]) {
    const x0 = s > 0 ? ringSide + 0.03 : -W, x1 = s > 0 ? W : -ringSide - 0.03;
    panel(x0, bot + 0.02, x1, top - 0.02);
    panel(x0, ringBot - 0.4, x1, bot - 0.02);
  }

  // Diagonal beams from the viewport's chamfered corners to the cabin corners (the hatch frame);
  // the upper ones carry the red warning lamps and an amber caution row.
  const corners = [[main[4], [W, R]], [main[5], [-W, R]], [main[1], [W, F + 0.5]], [main[0], [-W, F + 0.5]]];
  const brace = chassis === 'ogre' ? 0.24 : chassis === 'stryder' ? 0.13 : 0.18;
  const warnAt = [];
  for (const [[cx, cy], [tx, ty]] of corners) {
    const sx = Math.sign(cx), sy = Math.sign(cy) || -1;
    const from = [cx + sx * strut * 0.6, cy + sy * strut * 0.6, front + 0.06], to = [tx, ty, front + 0.06];
    kit.bar(from, to, brace, C.strut, 'shell', 0.12);
    kit.bar([from[0], from[1], front + 0.125], [to[0], to[1], front + 0.125], brace * 0.32, C.seam, 'shell', 0.012);
    const along = [to[0] - from[0], to[1] - from[1]], len = Math.hypot(...along), dir = [along[0] / len, along[1] / len], across = [-dir[1], dir[0]];
    const at = t => [from[0] + along[0] * t, from[1] + along[1] * t];
    for (const t of sy > 0 ? [0.2, 0.85] : [0.25, 0.5, 0.75]) for (const k of [-1, 1]) {
      const [bx, by] = at(t);
      kit.bolt([bx + across[0] * brace * 0.32 * k, by + across[1] * brace * 0.32 * k, front + 0.12], [0, 0, 1], 0.014);
    }
  }
  // Red warning lamps on the ring's top corners (between the score strip and the weapon / core tiles)
  // with three amber caution lamps each toward the centre.
  for (const s of [-1, 1]) {
    const lx = s * (main[4][0] - 0.06), ly = top + strut * 0.55, lz = front + ringDepth;
    kit.box([lx - 0.06, ly - 0.032, lz], [lx + 0.06, ly + 0.032, lz + 0.03], C.seam);
    kit.box([lx - 0.048, ly - 0.022, lz + 0.03], [lx + 0.048, ly + 0.022, lz + 0.045], KEY.red, 'warn');
    warnAt.push([lx, ly, lz + 0.06]);
    for (let i = 0; i < 3; i++) {
      const kx = lx - s * (0.1 + i * 0.055);
      kit.box([kx - 0.018, ly - 0.012, lz], [kx + 0.018, ly + 0.012, lz + 0.022], KEY.amber, 'keys');
    }
  }

  // Above the viewport: the brow (heavy on OGRE), hinge blocks and a grab bar.
  const browY = top + strut + 0.02;
  if (chassis === 'ogre') {
    kit.box([-W, browY - 0.04, front], [W, R, front + 0.24], C.dark);
    kit.box([-W, browY - 0.07, front + 0.22], [W, browY + 0.04, front + 0.28], C.strut);
    kit.hazardBand([-W, browY - 0.05], [W, browY - 0.05], 0.04, front + 0.281, 0.09);
    for (let i = -6; i <= 6; i++) kit.bolt([i * 0.2, browY + 0.005, front + 0.28], [0, 0, 1], 0.017);
    // Dome ribs across the roof.
    for (const z of [-0.6, -0.15, 0.3]) kit.tube([[-W, R - 0.35, z], [-W * 0.6, R - 0.06, z], [0, R + 0.02, z], [W * 0.6, R - 0.06, z], [W, R - 0.35, z]], 0.06, C.strut, 'shell', 16, 6);
  } else {
    for (const s of [-1, 1]) kit.box([s * 0.42 - 0.12, browY, front], [s * 0.42 + 0.12, browY + 0.09, front + 0.13], C.dark);
    kit.tube([[-0.36, browY + 0.03, front + 0.02], [-0.33, browY + 0.07, front + 0.17], [0.33, browY + 0.07, front + 0.17], [0.36, browY + 0.03, front + 0.02]], 0.017, C.handle, 'shell', 16, 6);
  }
  if (chassis === 'stryder') {
    // A light truss under the roof.
    for (const s of [-1, 1]) {
      kit.bar([s * W, R - 0.02, front], [0, R - 0.02, -0.3], 0.05, C.strut);
      kit.bar([s * W, R - 0.02, -0.3], [0, R - 0.02, front], 0.05, C.strut);
    }
  }
  // A roof beacon and the dome lamp lens.
  kit.box([-0.09, R - 0.07, front + 0.35], [0.09, R, front + 0.47], C.seam);
  kit.box([-0.06, R - 0.1, front + 0.37], [0.06, R - 0.07, front + 0.45], KEY.red, 'warn');
  kit.box([-0.12, R - 0.02, -0.32], [0.12, R, -0.08], KEY.white, 'keys');

  // Beside the viewport: accent status strips down the pillars (STRYDER: on the mullions), a grab handle.
  const right = new THREE.Vector3(1, 0, 0);
  for (const s of [-1, 1]) {
    if (chassis === 'stryder') kit.box([s * 0.9 - 0.012, -0.08, front + 0.08], [s * 0.9 + 0.012, 0.22, front + 0.1], 0xffffff, 'accent');
    else {
      const px = s * (half + strut + 0.05);
      kit.box([px - 0.012, bot + 0.05, front + 0.004], [px + 0.012, top - 0.12, front + 0.03], 0xffffff, 'accent');
    }
    const hx = s * (W - 0.07);
    if (chassis !== 'stryder') kit.tube([[hx, -0.3, front + 0.02], [hx, -0.27, front + 0.1], [hx, -0.05, front + 0.1], [hx, -0.02, front + 0.02]], 0.016, C.handle, 'shell', 14, 6);
    // Cable bundles down the cabin corners onto the side walls.
    [C.cableR, C.cableK, C.cableB, C.cableY].forEach((color, k) => {
      const o = k * 0.045;
      kit.tube([[s * (W - 0.04 - o), R - 0.05, front + 0.05], [s * (W - 0.05 - o), R * 0.4, front + 0.14 + o], [s * (W - 0.04 - o), -0.2, front + 0.3 + o * 0.5],
        [s * (W - 0.04 - o), F + 0.3, front + 0.45]], 0.021, color, 'shell', 16, 6);
    });
    // Side wall (in view on ultra-wide screens): a vent grille, a switch panel and a fuse row.
    const wall = s > 0 ? W : -W, inward = -s;
    kit.box([Math.min(wall, wall + inward * 0.04), -0.42, front + 0.5], [Math.max(wall, wall + inward * 0.04), 0.1, front + 0.85], C.vent);
    for (let k = 0; k < 8; k++) kit.box([Math.min(wall, wall + inward * 0.06), -0.4 + k * 0.064, front + 0.52], [Math.max(wall, wall + inward * 0.06), -0.37 + k * 0.064, front + 0.83], C.strut);
    kit.box([Math.min(wall, wall + inward * 0.05), 0.18, front + 0.3], [Math.max(wall, wall + inward * 0.05), 0.62, front + 0.75], C.plate);
    for (let k = 0; k < 6; k++) {
      const z = front + 0.36 + k * 0.065;
      kit.box([Math.min(wall + inward * 0.05, wall + inward * 0.075), 0.44, z - 0.018], [Math.max(wall + inward * 0.05, wall + inward * 0.075), 0.5, z + 0.018], k % 3 === 1 ? KEY.amber : k % 3 === 2 ? KEY.green : C.keyOff, k % 3 ? 'keys' : 'shell');
      kit.bolt([wall + inward * 0.05, 0.3, z], [inward, 0, 0], 0.012, C.bolt, 'shell', 6, 0.04);
    }
  }

  // Console: the MFD deck stands under the sill, leaning back toward the pilot: three MFDs, key rows, switches, a caution panel.
  const sill = bot - strut - 0.02;
  const deckTop = new THREE.Vector3(0, sill, front + 0.04), deckBot = new THREE.Vector3(0, F + 0.3, front + 0.3);
  const along = deckBot.clone().sub(deckTop), deckLen = along.length(); along.normalize();
  const deckUp = along.clone().negate(), deckN = new THREE.Vector3().crossVectors(right, deckUp).normalize();
  const basis = [right, deckUp, deckN];
  const deckMid = deckTop.clone().addScaledVector(along, deckLen / 2).addScaledVector(deckN, -0.05);
  kit.obox(deckMid.toArray(), [2 * W + 0.1, deckLen + 0.04, 0.1], basis, C.console);
  kit.box([-W, sill - 0.015, front], [W, sill + 0.012, front + 0.07], C.dark);
  const glow = (p, hex, power = 0.45, range = 0.32) => { const c = new THREE.Color(hex); kit.glows.push({ at: p.toArray(), color: [c.r, c.g, c.b], power, range }); };
  const accentHex = TITAN_COCKPIT_ACCENT[type]?.accent ?? 0x40c8ff;
  // A point on the deck `down` metres below its top edge, at normalised 16:9 screen column u.
  const onDeckAt = (u, down) => {
    const p = deckTop.clone().addScaledVector(along, down);
    p.x = u * TAN.h * -p.z;
    return p;
  };
  const mfd = (name, u, heightM) => {
    const h = heightM, w = h * regionAspect(name), p = onDeckAt(u, 0.035 + h / 2);
    // The screen floats 8 mm proud of its bezel: the near-depth view model has little depth precision.
    const lift = p.clone().addScaledVector(deckN, 0.03);
    kit.obox(p.clone().addScaledVector(deckN, 0.004).toArray(), [w + 0.07, h + 0.07, 0.036], basis, C.bezel);
    kit.screen(lift.toArray(), [w, h], basis, REGION[name]);
    glow(lift.clone().addScaledVector(deckN, 0.12), accentHex);
    // Soft keys either side of the screen and a bolt per corner.
    for (const s of [-1, 1]) for (let k = 0; k < 3; k++) {
      const key = lift.clone().addScaledVector(right, s * (w / 2 + 0.022)).addScaledVector(deckUp, (k - 1) * h * 0.3);
      kit.obox(key.toArray(), [0.02, 0.03, 0.016], basis, k === 1 ? accentHex : C.keyOff, k === 1 ? 'keys' : 'shell');
    }
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      kit.bolt(lift.clone().addScaledVector(right, sx * (w / 2 + 0.022)).addScaledVector(deckUp, sy * (h / 2 + 0.022)).toArray(), deckN.toArray(), 0.008, C.bolt, 'shell', 6, 0.01);
    }
    return { p: lift, w, h };
  };
  const side = chassis === 'ogre' ? 0.41 : 0.39, mh = chassis === 'stryder' ? 0.145 : 0.15;
  const status = mfd('status', -side, mh);
  const radar = mfd('radar', 0, 0.14);
  const weapon = mfd('weapon', side - 0.02, mh);
  // Key banks under the side MFDs and a row of toggle switches under the radar.
  const keyRow = (from, count, colors, size = 0.028) => {
    for (let k = 0; k < count; k++) {
      const at = from.clone().addScaledVector(right, (k - (count - 1) / 2) * size * 1.5);
      const color = colors[k % colors.length];
      kit.obox(at.toArray(), [size, size * 0.8, 0.016], basis, color ?? C.keyOff, color ? 'keys' : 'shell');
    }
  };
  keyRow(status.p.clone().addScaledVector(deckUp, -status.h / 2 - 0.055), 8, [KEY.green, null, KEY.amber, null, KEY.green, KEY.red, null, KEY.amber]);
  keyRow(weapon.p.clone().addScaledVector(deckUp, -weapon.h / 2 - 0.055), 8, [null, KEY.amber, KEY.green, null, KEY.blue, null, KEY.amber, KEY.green]);
  for (let k = 0; k < 5; k++) {
    const at = radar.p.clone().addScaledVector(right, (k - 2) * 0.042).addScaledVector(deckUp, -radar.h / 2 - 0.055);
    kit.obox(at.toArray(), [0.028, 0.028, 0.012], basis, C.seam);
    const lever = at.clone().addScaledVector(deckN, 0.022).addScaledVector(deckUp, k % 2 ? 0.008 : -0.008);
    kit.obox(lever.toArray(), [0.008, 0.008, 0.036], basis, C.bolt);
  }
  // The caution panel between the status MFD and the radar; a lit key cluster mirrors it on the right.
  const caution = onDeckAt(-0.175, 0.085).addScaledVector(deckN, 0.03);
  kit.obox(caution.clone().addScaledVector(deckN, -0.023).toArray(), [0.13, 0.095, 0.03], basis, C.bezel);
  kit.screen(caution.toArray(), [0.114, 0.076], basis, REGION.caution);
  // The per-titan aux gauge (energy, thermal, rail charge, shells, barrel) left of the status MFD.
  const aux = onDeckAt(-0.66, 0.08).addScaledVector(deckN, 0.03);
  kit.obox(aux.clone().addScaledVector(deckN, -0.023).toArray(), [0.18, 0.1, 0.03], basis, C.bezel);
  kit.screen(aux.toArray(), [0.16, 0.08], basis, REGION.aux);
  const cluster = onDeckAt(0.165, 0.085).addScaledVector(deckN, 0.02);
  for (let k = 0; k < 6; k++) {
    const at = cluster.clone().addScaledVector(right, ((k % 3) - 1) * 0.038).addScaledVector(deckUp, (Math.floor(k / 3) - 0.5) * 0.04);
    const color = [KEY.amber, null, KEY.green, KEY.blue, KEY.red, null][k];
    kit.obox(at.toArray(), [0.03, 0.03, 0.016], basis, color ?? C.keyOff, color ? 'keys' : 'shell');
  }

  // Side consoles: slanted key banks, the aux screen (left), and the control sticks.
  const sideUp = new THREE.Vector3(0, 0.62, -0.78).normalize(), sideN = new THREE.Vector3().crossVectors(right, sideUp).normalize();
  const sideBasis = [right, sideUp, sideN];
  for (const s of [-1, 1]) {
    const x0 = 0.84, width = W - 0.02 - x0, centre = new THREE.Vector3(s * (x0 + width / 2), -0.66, -0.9);
    kit.obox(centre.toArray(), [width, 0.5, 0.12], sideBasis, C.console);
    const keyFace = centre.clone().addScaledVector(sideN, 0.065);
    for (let row = 0; row < 3; row++) for (let k = 0; k < 5; k++) {
      const at = keyFace.clone().addScaledVector(right, (k - 2) * 0.06).addScaledVector(sideUp, 0.14 - row * 0.065);
      const lit = (k * 7 + row * 3 + (s > 0 ? 2 : 0)) % 5;
      const color = lit === 0 ? KEY.green : lit === 1 ? KEY.amber : lit === 2 && row === 1 ? KEY.red : null;
      kit.obox(at.toArray(), [0.036, 0.04, 0.018], sideBasis, color ?? C.keyOff, color ? 'keys' : 'shell');
    }
    // Control stick: a boot, shaft, grip and a red thumb button.
    const base = new THREE.Vector3(s * 0.66, -0.95, -0.66), tip = new THREE.Vector3(s * 0.68, -0.66, -0.74);
    kit.tube([base.toArray(), base.clone().lerp(tip, 0.5).toArray(), tip.toArray()], 0.022, C.bolt, 'shell', 6, 6);
    kit.bolt(base.toArray(), [0, 1, 0.1], 0.07, C.rubber, 'shell', 8, 0.06);
    kit.bar(tip.toArray(), tip.clone().add(new THREE.Vector3(0, 0.15, -0.03)).toArray(), 0.055, C.grip, 'shell', 0.065);
    kit.box([tip.x - 0.018, tip.y + 0.135, tip.z - 0.03], [tip.x + 0.018, tip.y + 0.16, tip.z + 0.004], KEY.red, 'keys');
  }
  // Floor: footwell plates and two pedals.
  kit.box([-0.6, F, -0.9], [0.6, F + 0.05, 0.2], C.dark);
  for (const s of [-1, 1]) kit.obox([s * 0.24, F + 0.18, -0.72], [0.16, 0.05, 0.28], [right, new THREE.Vector3(0, 0.8, 0.6), new THREE.Vector3(0, -0.6, 0.8)], C.rubber);

  // Spark anchors (screen corners, warning lamps, cable runs).
  const sparkAt = [...warnAt, status.p.toArray(), weapon.p.toArray(), [-(W - 0.12), R * 0.4, front + 0.15], [W - 0.12, R * 0.4, front + 0.15]];
  // The main viewport for the damage and transit dressing (titan-cockpit-fx.js).
  const win = { poly: main, front, skin, ringDepth, top, bot, half, strut, aspect: (2 * half) / (top - bot) };
  return { geometries: kit.finish(), cabin: cab, sparkAt, win };
}

// ---------------------------------------------------------------------------------- cache

const cache = new Map();
/** Shared cabin geometry per type (reference-counted: freed when the last cockpit of that type goes). */
function acquire(type) {
  let entry = cache.get(type);
  if (!entry) { entry = { ...buildCabin(type), refs: 0 }; cache.set(type, entry); }
  entry.refs++;
  return entry;
}
function release(type) {
  const entry = cache.get(type);
  if (!entry || --entry.refs > 0) return;
  for (const geometry of Object.values(entry.geometries)) geometry.dispose();
  cache.delete(type);
}
/** Test hook: live cached cabins. */
export const titanCockpitCacheSize = () => cache.size;

// ---------------------------------------------------------------------------------- sparks

const SPARKS = 18;
function sparkGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARKS * 18), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(SPARKS * 18), 3).setUsage(THREE.DynamicDrawUsage));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
  return g;
}

// ---------------------------------------------------------------------------------- overlay

/**
 * The titan cockpit for one hull type: { group, update(row), dispose } (cockpit-overlay.js
 * contract). The group is in hull metres, pinned to the hull frame; its meshes are placed per
 * render from the camera (view model).
 */
export function makeTitanCockpit(type) {
  if (!isTitanType(type)) return null;
  const entry = acquire(type);
  const canvas = globalThis.document?.createElement?.('canvas');
  const ctx = canvas?.getContext?.('2d');
  const drawable = !!ctx && typeof ctx.fillRect === 'function' && typeof ctx.arc === 'function' && typeof ctx.fillText === 'function';
  let texture = null;
  if (drawable) {
    canvas.width = ATLAS.width; canvas.height = ATLAS.height;
    texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    texture.name = 'titan-cockpit-mfd';
  }
  const materials = makeMaterials(type, texture);
  const group = new THREE.Group();
  group.name = `cockpit-overlay-${type}`;
  group.userData.cockpitOverlay = true;
  group.userData.titanCockpit = true;
  const eye = TITAN_DEFS_INPUT[type]?.camera.eye ?? [0, 5.6, -0.6];
  const meshes = [];
  for (const [kind, geometry] of Object.entries(entry.geometries)) {
    const mesh = new THREE.Mesh(geometry, materials[kind]);
    mesh.name = `${group.name}-${kind}`;
    mesh.position.set(eye[0], eye[1], eye[2]);
    mesh.renderOrder = kind === 'glass' ? 3 : 0;
    meshes.push(mesh); group.add(mesh);
  }
  const sparkGeo = sparkGeometry();
  const sparkMesh = new THREE.Mesh(sparkGeo, materials.sparks);
  sparkMesh.name = `${group.name}-sparks`;
  sparkMesh.position.set(eye[0], eye[1], eye[2]);
  sparkMesh.renderOrder = 4;
  meshes.push(sparkMesh); group.add(sparkMesh);
  // The diegetic HUD (titan-cockpit-hud.js): pods, brow display and kill feed ride the cabin, the glass projection the camera.
  const hud = createCockpitHud({ type, cabin: entry.cabin, group, eye, nearDepth, eyeTolerance: TITAN_COCKPIT.eyeTolerance });
  meshes.push(...hud.meshes); group.add(...hud.meshes, hud.glass);
  materials.glass.uniforms.aspect.value = entry.win.aspect;
  // Damage and transit dressing (titan-cockpit-fx.js): hidden until the hull is hurt or a transit plays.
  const fx = createCockpitFx({ type, cabin: entry.cabin, win: entry.win, depthGlsl: DEPTH_GLSL, nearDepth, materials, hud,
    ink: TITAN_COCKPIT_ACCENT[type]?.ink ?? '#62d6ff', sparks: (count, now, anchor) => emitSparks(count, now, anchor),
    jolt: amount => { view.jolt += amount; } });
  for (const mesh of fx.meshes) { mesh.position.set(eye[0], eye[1], eye[2]); meshes.push(mesh); group.add(mesh); }

  // Per-render placement: the camera's frame, the cockpit's own frustum, sway; hidden from other cameras.
  const view = { frame: -1, camera: null, matrix: new THREE.Matrix4(), hidden: false, yaw: null, pitch: 0, swayYaw: 0, swayPitch: 0, jolt: 0, at: 0,
    recoil: { x: [0, 0, 0, 0], v: [0, 0, 0, 0] },   // pitch, yaw, roll (rad), push (m) and their rates
    anchor: null };
  const eyeWorld = new THREE.Vector3(), camPos = new THREE.Vector3(), forward = new THREE.Vector3(), rot = new THREE.Matrix4(), scale = new THREE.Matrix4();
  const place = (renderer, camera) => {
    const frame = renderer?.info?.render?.frame ?? -1;
    if (frame === view.frame && camera === view.camera && frame !== -1) return;
    view.frame = frame; view.camera = camera;
    eyeWorld.set(eye[0], eye[1], eye[2]).applyMatrix4(group.matrixWorld);
    camPos.setFromMatrixPosition(camera.matrixWorld);
    view.hidden = !camera.isPerspectiveCamera || camPos.distanceTo(eyeWorld) > TITAN_COCKPIT.eyeTolerance;
    if (view.hidden) { view.matrix.makeScale(0, 0, 0); return; }
    // Sway: the cabin lags the look a little (and a hit jolts it), within a few degrees.
    const now = (globalThis.performance?.now?.() ?? Date.now()) / 1000, dt = Math.min(0.1, Math.max(1e-3, now - view.at || 1 / 60));
    view.at = now;
    forward.set(0, 0, -1).transformDirection(camera.matrixWorld);
    const yaw = Math.atan2(-forward.x, -forward.z), pitch = Math.asin(Math.max(-1, Math.min(1, forward.y)));
    const S = TITAN_COCKPIT.sway;
    if (view.yaw !== null) {
      let dy = yaw - view.yaw; dy -= Math.round(dy / (Math.PI * 2)) * Math.PI * 2;
      const ty = Math.max(-S.max, Math.min(S.max, -dy / dt * S.gain)), tp = Math.max(-S.max, Math.min(S.max, -(pitch - view.pitch) / dt * S.gain));
      const k = 1 - Math.exp(-S.rate * dt);
      view.swayYaw += (ty - view.swayYaw) * k; view.swayPitch += (tp - view.swayPitch) * k;
    }
    view.yaw = yaw; view.pitch = pitch;
    view.jolt *= Math.exp(-10 * dt);
    stepRecoil(view.recoil, dt);
    const [kickPitch, kickYaw, kickRoll, kickPush] = view.recoil.x;
    const { kx, ky } = cockpitScale(camera);
    rot.makeRotationFromEuler(new THREE.Euler(view.swayPitch + view.jolt + kickPitch, view.swayYaw + kickYaw, kickRoll, 'YXZ'));
    if (kickPush) rot.setPosition(0, 0, kickPush);
    scale.makeScale(kx, ky, 1);
    // An exit (titan-transit.js) leaves the cabin where the cockpit view was while the camera moves out.
    view.matrix.multiplyMatrices(view.anchor ?? camera.matrixWorld, scale);
    if (!view.anchor) view.matrix.multiply(rot);
  };
  for (const mesh of meshes) {
    mesh.frustumCulled = false;
    mesh.castShadow = false; mesh.receiveShadow = false;
    const screens = mesh.material === materials.screens || mesh.userData.portraitDark === true;
    mesh.onBeforeRender = (renderer, scene, camera) => {
      place(renderer, camera);
      if (screens && camera.aspect < TITAN_COCKPIT.screensMinAspect) mesh.matrixWorld.makeScale(0, 0, 0);
      else mesh.matrixWorld.copy(view.matrix);
      if (mesh.userData.local) mesh.matrixWorld.multiply(mesh.userData.local);
    };
  }
  titanHullFrame(group);

  // Live state: MFDs from the titan row at a low rate, lamps per frame.
  const state = { lastDraw: -Infinity, hp: null, hitAt: -Infinity, sparkAt: 0, model: null, row: null, time: 0, sparks: [] };
  const flicker = new THREE.Color();
  const emitSparks = (count, now, at = null) => {
    const anchor = at ?? entry.sparkAt[Math.floor(Math.random() * entry.sparkAt.length)];
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, up = 0.4 + Math.random() * 1.2;
      state.sparks.push({ p: [anchor[0], anchor[1], anchor[2]], v: [Math.cos(a) * (0.5 + Math.random()), up, 0.4 + Math.random() * 0.8], born: now, life: 0.35 + Math.random() * 0.35 });
    }
    if (state.sparks.length > SPARKS) state.sparks.splice(0, state.sparks.length - SPARKS);
  };
  const stepSparks = now => {
    const pos = sparkGeo.attributes.position.array, col = sparkGeo.attributes.color.array;
    pos.fill(0); col.fill(0);
    state.sparks = state.sparks.filter(spark => now - spark.born < spark.life);
    const side = new THREE.Vector3(), dir = new THREE.Vector3(), head = new THREE.Vector3();
    state.sparks.forEach((spark, i) => {
      const t = now - spark.born, fade = 1 - t / spark.life;
      head.set(spark.p[0] + spark.v[0] * t, spark.p[1] + spark.v[1] * t - 2.5 * t * t, spark.p[2] + spark.v[2] * t);
      dir.set(spark.v[0], spark.v[1] - 5 * t, spark.v[2]).normalize();
      side.crossVectors(dir, head).normalize().multiplyScalar(0.004);
      const tail = head.clone().addScaledVector(dir, -0.05);
      const quad = [head.clone().add(side), head.clone().sub(side), tail.clone().sub(side), tail.clone().add(side)];
      [0, 1, 2, 0, 2, 3].forEach((v, k) => {
        quad[v].toArray(pos, i * 18 + k * 3);
        col[i * 18 + k * 3] = 1.6 * fade; col[i * 18 + k * 3 + 1] = 0.9 * fade; col[i * 18 + k * 3 + 2] = 0.35 * fade;
      });
    });
    sparkGeo.attributes.position.needsUpdate = true; sparkGeo.attributes.color.needsUpdate = true;
  };
  const redraw = now => {
    if (!drawable) return;
    drawAtlas(ctx, type, state.model, now, { yaw: state.row?.yaw ?? 0 });
    fx.paintScreens(ctx, REGION, now);
    texture.needsUpdate = true;
  };
  redraw(0);

  return {
    group,
    /** Per frame while shown (VehicleView): the presented titan row. */
    update(row, nowMs = null) {
      const now = (Number.isFinite(nowMs) ? nowMs : globalThis.performance?.now?.() ?? Date.now()) / 1000;
      state.row = row ?? null;
      const model = row ? titanModel(row, { now: now * 1000, keys: cockpitHudKeys() }) : null;
      state.model = model;
      // A hull hit (hp dropped by a real amount): flicker, sparks, a jolt.
      const hp = model ? model.hp + model.shield : null;
      if (hp !== null && state.hp !== null && hp < state.hp - 40) {
        state.hitAt = now; view.jolt += TITAN_COCKPIT.sway.jolt * Math.min(1, (state.hp - hp) / 400);
        if (model.hp < state.hp) emitSparks(4 + Math.min(8, Math.round((state.hp - hp) / 150)), now);
      }
      state.hp = hp;
      const doomed = !!model?.doomed;
      if (doomed && now - state.sparkAt > 0.7) { state.sparkAt = now; emitSparks(5, now); }
      if (state.sparks.length || sparkGeo.userData.lit) { stepSparks(now); sparkGeo.userData.lit = state.sparks.length > 0; }
      // Lamps: doom flashes the warning lamps and pulses the cabin red; a lock flashes them amber;
      // a ready core pulses the accent strips; a hit flickers the whole cockpit.
      const hit = now - state.hitAt < TITAN_COCKPIT.hitFlicker;
      const flick = hit ? (Math.random() < 0.35 ? 0.35 : 0.85 + Math.random() * 0.15) : 1;
      const flash = Math.floor(now * 3) % 2 === 0;
      const pulse = 0.5 + 0.5 * Math.sin(now * Math.PI * 2.2);
      materials.shell.color.setRGB(1, doomed ? 0.78 - 0.18 * pulse : 1, doomed ? 0.74 - 0.2 * pulse : 1).multiplyScalar(flick);
      materials.keys.color.setScalar(doomed ? 0.55 : 1).multiplyScalar(flick);
      if (doomed) materials.warn.color.setScalar(flash ? 1.6 : 0.18);
      else if (model?.lock) materials.warn.color.setRGB(flash ? 1.5 : 0.3, flash ? 0.9 : 0.15, 0.1);
      else materials.warn.color.setScalar(0.32);
      const core = model?.core;
      flicker.copy(materials.accent.userData.base).multiplyScalar(core?.active ? 1.9 : core?.ready ? 1.2 + 0.8 * pulse : 1);
      materials.accent.color.copy(flicker).multiplyScalar(flick);
      materials.screens.color.setScalar(hit && Math.random() < 0.3 ? 0.25 : 1);
      materials.glass.uniforms.doom.value = doomed ? 1 : 0;
      materials.glass.uniforms.time.value = now % 1000;
      if (now - state.lastDraw >= 1 / TITAN_COCKPIT.refreshHz) { state.lastDraw = now; redraw(now); }
      hud.update(model, now, row);
      // Damage and transit on top of this frame's lamp state (power, emergency light, shutters, banner, glass).
      const transit = row ? transitFor(row.id) : null;
      view.anchor = transit?.anchor ?? null;
      fx.update({ model, row, now, transit });
    },
    /**
     * An own primary shot (titan-weapon-feel.js): peaks { pitch, yaw, roll (rad), push (m) } become
     * spring impulses; `bloom` (0..1) opens the glass reticle. True when the cabin took it.
     */
    kick(peaks, bloom = 0) {
      const K = TITAN_COCKPIT.kick, w = Math.sqrt(K.stiffness), z = K.damping, s = Math.sqrt(1 - z * z);
      // Underdamped spring from rest: an impulse v0 peaks at v0 / w · exp(-z/s · atan(s/z)).
      const gain = w / Math.exp(-z / s * Math.atan2(s, z));
      const r = view.recoil;
      [peaks?.pitch, peaks?.yaw, peaks?.roll, peaks?.push].forEach((peak, i) => { if (Number.isFinite(peak)) r.v[i] += peak * gain; });
      hud.shot?.(bloom);
      return true;
    },
    /** An enemy titan doomed by the own rounds: the glass kill mark and toast. */
    confirm(label) { hud.confirm?.(label); },
    /** The cabin's current kick offsets [pitch, yaw, roll, push] (tests). */
    recoilOffsets: () => [...view.recoil.x],
    /** The damage and transit dressing (tests, captures). */
    fx,
    dispose() {
      group.removeFromParent();
      sparkGeo.dispose();
      hud.dispose();
      fx.dispose();
      for (const material of Object.values(materials)) material.dispose();
      texture?.dispose();
      release(type);
    },
  };
}

/** Advance the cabin kick spring (TITAN_COCKPIT.kick) by `dt` in steps of at most 1/120 s. */
export function stepRecoil(recoil, dt) {
  const K = TITAN_COCKPIT.kick, c = 2 * K.damping * Math.sqrt(K.stiffness);
  let left = Math.max(0, Math.min(0.1, dt));
  while (left > 1e-6) {
    const h = Math.min(1 / 120, left);
    left -= h;
    for (let i = 0; i < 4; i++) {
      recoil.v[i] += (-K.stiffness * recoil.x[i] - c * recoil.v[i]) * h;
      const limit = i === 3 ? K.maxPush : K.maxAngle;
      recoil.x[i] = Math.max(-limit, Math.min(limit, recoil.x[i] + recoil.v[i] * h));
    }
  }
  return recoil;
}

/** Test hook: the cabin of a type in eye metres ({ cabin, geometries }), shared with live cockpits. */
export function titanCockpitCabin(type) {
  const entry = acquire(type);
  return { cabin: entry.cabin, geometries: entry.geometries, release: () => release(type) };
}

setTitanCockpitBuilder(makeTitanCockpit);
