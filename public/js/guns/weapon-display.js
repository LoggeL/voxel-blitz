import * as THREE from '../vendor/three.module.js';
import { WEAPONS } from '../../../shared/combatmath.js';
import { isTitanfall } from '../../../shared/modes.js';
import { TITAN_PILOT_AT, TITAN_PILOT_PRIMARIES, TITAN_PILOT_SIDEARM } from '../../../shared/titan-contract.js';
import { disposeObjectTrees } from '../engine/dispose.js';
import { GLOW_ACCENT } from './kit.js';
import { HIP } from './models/common.js';
// On-gun ammo counters for the titanfall pilot weapons (docs/titanfall.md §8.6 On-gun displays), after the Halo
// MA5 rear counter (reference docs/design/titanfall/weapon-displays/halo/option-h1-rear-deck-reference.jpg): a
// small recessed screen on the top rear of the receiver, behind the rear sight, tilted up and facing back toward
// the shooter's eye. It shows the magazine count inside a segmented ring that drains with the magazine (and doubles
// as the progress ring for reload, CR-6 charge, ARCHER lock and the bolt / arc / pump cycle) and the reserve under
// it, painted from the predicted local weapon state (WeaponState.readDisplay) and the `tfs` lock. Same replaceable
// layer as stattrak-module.js: one mesh under model.body (two draws: housing and screen), its canvas repainted
// only when a shown value changes, disposed with the model. Each pilot gun's builder seats it through
// body.userData.displayMount { x, y, z, w, h, seat, tilt?, yaw?, pod?, adsHidden? } (screen centre and size in m;
// `seat` 'deck' stands it on the surface below, 'rear' on the receiver face ahead of it; `tilt`/`yaw` in degrees
// override the normal, which otherwise faces halfway between the hip and the sight eye of the gun's timing
// profile; `pod` caps how far the housing reaches into the gun; `adsHidden` when the sight picture covers it). At
// build, rays along the seat axis against the built gun (procedural or Blender) set the screen LIP off the real
// surface and grow the housing into it. Guns without a mount (and every other mode) show nothing.

/** UI tint per weapon: the style.css `--w-*` palette, so the counter matches the HUD's weapon colours. */
export const WEAPON_TINT = Object.freeze({
  rifle: 0xff9f1c, smg: 0xffcf5c, shotgun: 0xff7a45, sniper: 0x8fc7ff, lmg: 0x5ce6b0, longarc: 0x48e8ff, rocket: 0xe5ff4f,
  minigun: 0xa8b0ff, flamethrower: 0xff6a1a, revolver: 0xff5277, lance: 0xc9a2ff, knife: 0xb9c6cf, glaive: 0xff3fd0,
  bubble: 0x9fe9ff, mgl: 0xd3ba58, stinger: 0x9cff6b, chargerifle: 0xff5a3c, archer: 0x4ee6ff, thunderbolt: 0x7aa8ff,
  kraber: 0xffc04a,
});
/** The weapon's own state the ring shows while it runs (instead of the magazine). */
export const DISPLAY_EXTRAS = Object.freeze({ chargerifle: 'charge', archer: 'lock', thunderbolt: 'arc', kraber: 'bolt',
  shotgun: 'pump' });
/** Progress rings step in 5 % (20 segments), so a held charge or lock repaints at most 20 times. */
const STEPS = 20;
const WARN = '#ff3355';
const TRACK = '#ffffff1f';
const FONT = "'Rajdhani', 'Bahnschrift', 'Arial Narrow', 'Roboto Condensed', system-ui, sans-serif";
const CANVAS_W = 256;
// The ring: a horseshoe open at the bottom (the reserve sits in the opening), RING_GAP wide, segments SEG_GAP apart.
const RING_GAP = 84 * Math.PI / 180;
const SEG_GAP = 3.2 * Math.PI / 180;
// Housing: a bezel frame standing RIM proud of the screen (the screen sits recessed), a taller brow on top.
const BEZEL = 0.0035;
const BROW = 0.0055;
const RIM = 0.0025;
const HOUSING = 0x22262c;  // the pod's gunmetal
// Seating: the housing's lowest front corner stands LIP off the gun's surface along the seat axis; the back
// sinks SINK past the deepest hit, at most `pod` (default POD) past the nearest; never thinner than MIN_DEPTH.
const LIP = 0.003;
const SINK = 0.006;
const POD = 0.02;
const MIN_DEPTH = 0.008;
const BODY_DEPTH = 0.014; // the housing reaches at least this far behind the screen face (a box, not a plate)
const NO_SURFACE_DEPTH = 0.012;
const RAY_START = 0.006;   // rays start this far above / behind the screen plane, so the stock or a scope behind is never hit
const RAY_REACH = 0.3;
const SEAT_RAYS = Object.freeze([-1, -0.5, 0, 0.5, 1]);
const SEAT_AXES = Object.freeze({ deck: Object.freeze([0, 1, 0]), rear: Object.freeze([0, 0, 1]) });

const clampStep = value => Number.isFinite(value) ? Math.max(0, Math.min(STEPS, Math.round(value * STEPS))) : -1;
const hex = color => `#${color.toString(16).padStart(6, '0')}`;

/** Fresh display model; `weaponDisplayModel` refills it in place (no per-frame allocation). */
export function createWeaponDisplayModel() {
  return { id: null, extra: null, magSize: 0, mag: 0, reserve: 0, low: false, reload: -1, staged: false,
    charge: -1, lock: -1, ready: STEPS };
}

/** Same shown values: the counter keeps its paint. */
export function sameWeaponDisplay(a, b) {
  return !!a && !!b && a.id === b.id && a.mag === b.mag && a.reserve === b.reserve && a.low === b.low && a.reload === b.reload
    && a.staged === b.staged && a.charge === b.charge && a.lock === b.lock && a.ready === b.ready && a.magSize === b.magSize;
}

/** True for the weapons this display serves in this mode (titanfall only). */
export function weaponDisplayEnabled(mode, id) {
  return isTitanfall(mode) && Object.hasOwn(WEAPONS, id) && hasDisplayMountFor(id);
}
/** Every titanfall pilot gun (the knife has no magazine); each builder seats its counter (body.userData.displayMount). */
export const DISPLAY_WEAPONS = Object.freeze([...TITAN_PILOT_PRIMARIES, TITAN_PILOT_SIDEARM, ...TITAN_PILOT_AT]);
const MOUNTED = new Set(DISPLAY_WEAPONS);
export const hasDisplayMountFor = id => MOUNTED.has(id);

/**
 * Display model of the drawn weapon from the predicted local weapon state:
 * `read` is WeaponState.readDisplay (or the readModel fields wid, mag, reserve,
 * reloading01, reloadStaged, charge01, ready01), `lock` the `tfs` lock progress 0..1. Returns
 * `out` refilled, or null outside titanfall and for weapons without a display.
 */
export function weaponDisplayModel(read, { mode, lock = 0 } = {}, out = createWeaponDisplayModel()) {
  const id = read?.wid;
  if (!weaponDisplayEnabled(mode, id)) return null;
  const def = WEAPONS[id];
  const extra = DISPLAY_EXTRAS[id] ?? null;
  const mag = Math.max(0, Math.trunc(Number(read.mag) || 0));
  if (out.id !== id) {
    out.id = id;
    out.extra = extra;
    out.magSize = Math.max(1, def.magSize | 0);
  }
  out.mag = mag;
  out.reserve = Math.max(0, Math.trunc(Number(read.reserve) || 0));
  // The stock ammo card's rule (GameplayHud.updateAmmoLow): at most 22 % of the magazine left; a
  // single-round launcher (ARCHER) is low only when empty.
  out.low = def.magSize > 1 ? mag <= Math.max(1, Math.round(def.magSize * 0.22)) : mag === 0;
  out.reload = read.reloading01 == null || read.reloading01 >= 1 ? -1 : clampStep(read.reloading01);
  // A staged tube reload (M-DOCK) seats shells one at a time and a shot interrupts it: the count stays up.
  out.staged = out.reload >= 0 && !!read.reloadStaged;
  out.charge = extra === 'charge' ? clampStep(read.charge01 ?? 0) : -1;
  out.lock = extra === 'lock' ? clampStep(lock) : -1;
  out.ready = extra === 'charge' || extra === 'arc' || extra === 'bolt' || extra === 'pump' ? clampStep(read.ready01 ?? 1) : STEPS;
  return out;
}

/* ------------------------------------------------------------------ painting */

/**
 * What the ring shows: { segments, lit, color, outline } — the reload or the weapon's running state as
 * STEPS progress segments, else one segment per round (STEPS for magazines larger than that).
 */
function ringState(model, tint, warn) {
  if (model.reload >= 0) return { segments: STEPS, lit: model.reload, color: '#ffffff' };
  if (model.charge > 0) return { segments: STEPS, lit: model.charge, color: tint };
  if (model.lock > 0) return { segments: STEPS, lit: model.lock, color: model.lock >= STEPS ? WARN : tint };
  if (model.ready < STEPS) return { segments: STEPS, lit: model.ready, color: `${tint}8c` };
  const segments = Math.min(model.magSize, STEPS);
  const lit = model.magSize > STEPS ? Math.ceil(Math.min(model.mag, model.magSize) / model.magSize * STEPS) : Math.min(model.mag, segments);
  // Low: the drained slots turn to warning outlines, so the warning also reads without colour (the IRONCLAD's own
  // tint is close to the warning red).
  return { segments, lit, color: warn ? WARN : tint, outline: warn };
}

function ring(context, cx, cy, radius, thick, state) {
  const span = Math.PI * 2 - RING_GAP;
  const step = span / state.segments;
  const gap = state.segments > 1 ? Math.min(SEG_GAP, step * 0.4) : 0;
  const start = Math.PI / 2 + RING_GAP / 2;    // bottom left, clockwise over the top
  const outer = radius + thick / 2, inner = radius - thick / 2;
  context.lineWidth = Math.max(2, thick * 0.22);
  for (let i = 0; i < state.segments; i++) {
    const a0 = start + i * step + gap / 2, a1 = start + (i + 1) * step - gap / 2;
    context.beginPath();
    context.arc(cx, cy, outer, a0, a1);
    context.arc(cx, cy, inner, a1, a0, true);
    context.closePath();
    if (i < state.lit) {
      context.fillStyle = state.color;
      context.fill();
    } else if (state.outline) {
      context.strokeStyle = WARN;
      context.stroke();
    } else {
      context.fillStyle = TRACK;
      context.fill();
    }
  }
}

/** Largest font size up to `size` px at which `text` stays within `maxWidth`. */
function fitFont(context, text, size, maxWidth, weight = 700) {
  context.font = `${weight} ${size}px ${FONT}`;
  const width = context.measureText(text).width;
  if (!(width > maxWidth)) return size;
  const fitted = Math.floor(size * maxWidth / width);
  context.font = `${weight} ${fitted}px ${FONT}`;
  return fitted;
}

/**
 * Paint one display model into a 2D context of `width`×`height` px (the mount's aspect): the magazine count
 * large in the centre (zero-padded to the magazine's digits) in the weapon tint, the ring around it, the reserve
 * in the ring's opening. Low: count and ring in `#ff3355`, drained slots outlined; empty: RELOAD in place of the
 * reserve. Reloading: RELOADING in white replaces the count while the ring fills white, except in a staged tube
 * reload (M-DOCK), where the count climbs as shells seat over the white ring.
 */
export function paintWeaponDisplay(context, width, height, model) {
  const tint = hex(WEAPON_TINT[model.id] ?? 0xffffff);
  const warn = model.low || model.mag === 0;
  const reloading = model.reload >= 0 && !model.staged;
  context.fillStyle = '#05080b';
  context.fillRect(0, 0, width, height);
  const cx = width / 2, cy = height * 0.5;
  const thick = height * 0.08, radius = height * 0.5 - thick / 2 - 3;
  // A faint tint glow inside the ring, as an LCD backlight.
  context.fillStyle = `${tint}12`;
  context.beginPath();
  context.arc(cx, cy, radius - thick / 2, 0, Math.PI * 2);
  context.fill();
  ring(context, cx, cy, radius, thick, ringState(model, tint, warn));
  const innerWidth = (radius - thick / 2) * 2 * 0.92;
  context.textAlign = 'center';
  context.textBaseline = 'alphabetic';
  if (reloading) {
    context.fillStyle = '#ffffff';
    const size = fitFont(context, 'RELOADING', Math.round(height * 0.22), innerWidth);
    context.fillText('RELOADING', cx, cy + size * 0.35);
  } else {
    const count = String(model.mag).padStart(String(model.magSize).length, '0');
    context.fillStyle = warn ? WARN : tint;
    const size = fitFont(context, count, Math.round(height * 0.72), innerWidth);
    context.fillText(count, cx, cy + size * 0.3);
  }
  // The reserve (RELOAD when the magazine is empty and rounds are left) in the ring's opening.
  const empty = model.mag === 0 && model.reserve > 0 && !reloading && !model.staged;
  const below = empty ? 'RELOAD' : String(model.reserve);
  context.fillStyle = empty || (warn && model.reserve === 0) ? WARN : '#e8ecf1d0';
  fitFont(context, below, Math.round(height * (empty ? 0.13 : 0.16)), Math.sin(RING_GAP / 2) * radius * 2, empty ? 700 : 600);
  context.fillText(below, cx, height - Math.round(height * 0.04));
}

/* ------------------------------------------------------------------ mesh */

function makeCanvas(width, height) {
  try {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    return context ? { canvas, context } : null;
  } catch (_error) {
    return null;
  }
}

const _at = new THREE.Vector3(), _hip = new THREE.Vector3(), _ads = new THREE.Vector3(), _normal = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0), _axis = new THREE.Vector3(), _corner = new THREE.Vector3(), _local = new THREE.Vector3();
const _m = new THREE.Matrix4(), _toLocal = new THREE.Matrix4(), _toWorld = new THREE.Matrix4();
const _ray = new THREE.Raycaster();

/** The housing's front rectangle (panel space: screen centre at 0, normal +z): left, right, bottom, top. */
const frontRect = mount => [-mount.w / 2 - BEZEL, mount.w / 2 + BEZEL, -mount.h / 2 - BEZEL, mount.h / 2 + BROW];

/**
 * Panel-space positions of the housing (group 0: bezel rim, recess walls, pod walls and back) and the
 * screen (group 1, z 0, with uv). `toBody` is the panel's placement in body space; each pod corner is the
 * front corner carried against the seat `axis` down to `back` (body coordinate along the axis), at least
 * MIN_DEPTH, so the counter stands on a pod that grows out of the gun instead of floating over it.
 */
function panelGeometry(mount, toBody, axis, back) {
  const [l, r, b, t] = frontRect(mount), sl = -mount.w / 2, sr = mount.w / 2, sb = -mount.h / 2, st = mount.h / 2;
  _toLocal.copy(toBody).invert();
  const front = [[l, b, RIM], [r, b, RIM], [r, t, RIM], [l, t, RIM]];
  const pod = front.map(([x, y, z]) => {
    _corner.set(x, y, z).applyMatrix4(toBody);
    const s = _corner.dot(axis);
    _corner.addScaledVector(axis, Math.min(back, s - MIN_DEPTH) - s).applyMatrix4(_toLocal);
    if (_corner.z > RIM - BODY_DEPTH) _corner.z = RIM - BODY_DEPTH;
    return _corner.toArray();
  });
  const centre = [0, 0, 0];
  for (const p of [...front, ...pod]) for (let i = 0; i < 3; i++) centre[i] += p[i] / 8;
  const positions = [];
  // One quad as two triangles, wound so its normal points along `outward` (or away from the pod's centre).
  const quad = (a, bq, c, d, outward = null) => {
    const e1 = [bq[0] - a[0], bq[1] - a[1], bq[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const dir = outward ?? [(a[0] + c[0]) / 2 - centre[0], (a[1] + c[1]) / 2 - centre[1], (a[2] + c[2]) / 2 - centre[2]];
    const flip = n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2] < 0;
    for (const p of flip ? [a, c, bq, a, d, c] : [a, bq, c, a, c, d]) positions.push(p[0], p[1], p[2]);
  };
  const screen = [[sl, sb, RIM], [sr, sb, RIM], [sr, st, RIM], [sl, st, RIM]];
  const floor = [[sl, sb, 0], [sr, sb, 0], [sr, st, 0], [sl, st, 0]];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad(front[i], front[j], screen[j], screen[i], [0, 0, 1]);                                   // bezel rim
    const mid = [(screen[i][0] + screen[j][0]) / 2, (screen[i][1] + screen[j][1]) / 2];
    quad(screen[i], screen[j], floor[j], floor[i], [-mid[0], -mid[1], 0]);                         // recess wall
    quad(front[i], front[j], pod[j], pod[i]);                                                      // pod wall
  }
  quad(pod[0], pod[1], pod[2], pod[3]);                                                            // pod back
  const housingCount = positions.length / 3;
  positions.push(sl, sb, 0, sr, sb, 0, sr, st, 0, sl, sb, 0, sr, st, 0, sl, st, 0);
  const uvs = new Float32Array(positions.length / 3 * 2);
  uvs.set([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], housingCount * 2);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  geometry.addGroup(0, housingCount, 0);
  geometry.addGroup(housingCount, 6, 1);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Seat orientation: the screen normal (+z) faces halfway between the hip eye (minus the gun's hip offset,
 * turned by its hip yaw) and the sight eye (minus its ADS offset), so it reads from the hip and stays square to
 * the eye while aiming; the mount's `tilt` (up from horizontal) and `yaw` (toward +x) in degrees override it.
 * The screen's horizontal edge stays level in gun space.
 */
function seatQuaternion(mount, T, out) {
  _at.set(mount.x, mount.y, mount.z);
  const hip = T?.hipOffset || HIP, yaw = T?.hipYaw || 0, cos = Math.cos(yaw), sin = Math.sin(yaw);
  _hip.set(-hip.x * cos + hip.z * sin, -hip.y, -hip.x * sin - hip.z * cos).sub(_at).normalize();
  const ads = T?.adsOffset;
  _ads.set(-(ads?.x ?? 0), -(ads?.y ?? -0.15), -(ads?.z ?? -0.6)).sub(_at).normalize();
  _normal.copy(_hip).add(_ads).normalize();
  if (Number.isFinite(mount.tilt) || Number.isFinite(mount.yaw)) {
    const tilt = Number.isFinite(mount.tilt) ? mount.tilt * Math.PI / 180 : Math.asin(_normal.y);
    const turn = Number.isFinite(mount.yaw) ? mount.yaw * Math.PI / 180 : Math.atan2(_normal.x, _normal.z);
    _normal.set(Math.sin(turn) * Math.cos(tilt), Math.sin(tilt), Math.cos(turn) * Math.cos(tilt));
  }
  _m.lookAt(_normal.add(_at), _at, _up);
  return out.setFromRotationMatrix(_m);
}

/** The gun's own meshes for the seat rays: no gloves, counter or hidden flash. */
function seatTargets(object, out = []) {
  if (!object.visible || object.name === 'hand_l' || object.name === 'hand_r' || object.name === 'weaponDisplay') return out;
  if (object.isMesh) out.push(object);
  for (const child of object.children) seatTargets(child, out);
  return out;
}

/**
 * The gun's surface under (deck) or ahead of (rear) the counter: 5×5 rays against the seat axis from just
 * above / behind the seated front face (`placement` is its body-space matrix) against the built gun (procedural
 * or Blender). Returns { outer, inner }, the nearest and deepest first hits as body coordinates along the axis,
 * or null when nothing is there (then the mount's centre stands).
 */
function findSurface(body, mount, placement, axis) {
  const targets = seatTargets(body);
  if (!targets.length) return null;
  body.updateWorldMatrix(true, true);
  _toWorld.copy(body.matrixWorld);
  _toLocal.copy(_toWorld).invert();
  const [l, r, b, t] = frontRect(mount);
  let outer = -Infinity, inner = Infinity;
  for (const fu of SEAT_RAYS) for (const fv of SEAT_RAYS) {
    _corner.set(l + (r - l) * (fu + 1) / 2, b + (t - b) * (fv + 1) / 2, RIM).applyMatrix4(placement).addScaledVector(axis, RAY_START);
    _ray.ray.origin.copy(_corner).applyMatrix4(_toWorld);
    _ray.ray.direction.copy(axis).negate().transformDirection(_toWorld);
    _ray.far = RAY_REACH;
    const hit = _ray.intersectObjects(targets, false)[0];
    if (!hit) continue;
    const s = _local.copy(hit.point).applyMatrix4(_toLocal).dot(axis);
    outer = Math.max(outer, s);
    inner = Math.min(inner, s);
  }
  return Number.isFinite(outer) ? { outer, inner } : null;
}

/**
 * Place the counter on the gun: oriented by seatQuaternion, moved along the seat axis until the housing's
 * lowest front corner stands LIP off the nearest surface hit, with the pod's back SINK past the deepest hit (at
 * most `pod` past the nearest, so a gap in the gun never draws a long spike). Without hits (SKIPJACK in node,
 * where it builds no geometry) the screen centre stays at the mount.
 */
function seatPanel(bundle, mount, mesh) {
  const axis = _axis.fromArray(SEAT_AXES[mount.seat] ?? SEAT_AXES.deck);
  seatQuaternion(mount, bundle.T, mesh.quaternion);
  mesh.position.set(mount.x, mount.y, mount.z);
  mesh.updateMatrix();
  const surface = findSurface(bundle.body, mount, mesh.matrix, axis);
  const [l, r, b, t] = frontRect(mount);
  let low = Infinity;
  for (const x of [l, r]) for (const y of [b, t]) low = Math.min(low, _corner.set(x, y, RIM).applyMatrix4(mesh.matrix).dot(axis));
  let back = low - NO_SURFACE_DEPTH;
  if (surface) {
    mesh.position.addScaledVector(axis, surface.outer + LIP - low);
    back = Math.max(surface.inner, surface.outer - (Number.isFinite(mount.pod) ? mount.pod : POD)) - SINK;
  }
  mesh.updateMatrix();
  return panelGeometry(mount, mesh.matrix, axis, back);
}

function removeDisplay(bundle) {
  const display = bundle.weaponDisplay;
  if (!display) return;
  disposeObjectTrees([display.mesh]);
  display.mesh.removeFromParent();
  bundle.weaponDisplay = null;
}

/**
 * Mount, refresh or remove the on-gun display of one gun bundle. `model` is the
 * weaponDisplayModel of the drawn weapon or null (no display: other modes, or
 * titanfall left). A bundle shows only its own weapon's model; while the state
 * already names the incoming gun during a swap, the outgoing counter keeps its paint.
 */
export function applyWeaponDisplay(bundle, id, model) {
  if (!bundle) return false;
  const mount = bundle.body.userData.displayMount;
  if (!model || !mount) { removeDisplay(bundle); return false; }
  if (model.id !== id) return !!bundle.weaponDisplay;
  let display = bundle.weaponDisplay;
  if (!display) {
    const height = Math.round(CANVAS_W * mount.h / mount.w);
    const paint = makeCanvas(CANVAS_W, height);
    const texture = paint ? new THREE.CanvasTexture(paint.canvas) : null;
    if (texture) {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      texture.anisotropy = 4;
    }
    const screen = new THREE.MeshBasicMaterial(texture ? { map: texture, toneMapped: false }
      : { color: WEAPON_TINT[id] ?? GLOW_ACCENT[id] ?? 0xffffff, toneMapped: false });
    // The housing takes the gun kit's flat-shaded metal (kit.js MaterialCache.mat), so it shares that program.
    const housing = new THREE.MeshStandardMaterial({ color: HOUSING, flatShading: true, roughness: 0.62, metalness: 0.35 });
    const mesh = new THREE.Mesh(undefined, [housing, screen]);
    mesh.name = 'weaponDisplay';
    mesh.geometry = seatPanel(bundle, mount, mesh);
    bundle.body.add(mesh);
    display = bundle.weaponDisplay = { mesh, texture, paint, height, shown: createWeaponDisplayModel(), paints: 0 };
  }
  if (sameWeaponDisplay(display.shown, model)) return true;
  Object.assign(display.shown, model);
  display.paints++;
  if (display.paint) {
    paintWeaponDisplay(display.paint.context, CANVAS_W, display.height, display.shown);
    display.texture.needsUpdate = true;
  }
  return true;
}

/** Share of a counter's screen that must lie inside the view for the rig to call it live (the ammo card hides). */
export const WEAPON_DISPLAY_IN_VIEW = 0.75;
const _ndc = new THREE.Vector3();
const inside = (a, b) => b > a ? Math.max(0, Math.min(1, b) - Math.max(-1, a)) / (b - a) : 0;

/**
 * Share 0..1 of the bundle's counter screen inside the camera's view (0 without a counter, or with a corner
 * behind the eye). Brings the counter's and the camera's world matrices up to date first: the rig poses between
 * renders. A portrait phone holds the gun at the right edge, where the counter falls off screen.
 */
export function weaponDisplayInView(bundle, camera) {
  const mesh = bundle?.weaponDisplay?.mesh, mount = bundle?.body.userData.displayMount;
  if (!mesh || !mount || !camera?.projectionMatrix) return 0;
  mesh.updateWorldMatrix(true, false);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < 4; i++) {
    _ndc.set((i & 1 ? 0.5 : -0.5) * mount.w, (i & 2 ? 0.5 : -0.5) * mount.h, 0).applyMatrix4(mesh.matrixWorld).project(camera);
    if (_ndc.z > 1) return 0;
    minX = Math.min(minX, _ndc.x); maxX = Math.max(maxX, _ndc.x);
    minY = Math.min(minY, _ndc.y); maxY = Math.max(maxY, _ndc.y);
  }
  return inside(minX, maxX) * inside(minY, maxY);
}
