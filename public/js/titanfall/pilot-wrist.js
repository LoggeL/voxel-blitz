// Pilot wrist display (docs/titanfall.md §8.7 "Wrist display"; concepts docs/design/titanfall/wrist/, chosen A
// "armoured bracer slab"). In titanfall pilot first person the tactical readout lives on the left forearm instead
// of floating by the crosshair: an armoured slab strapped behind the glove, its screen turned toward the eye.
//
//   screen   tactical glyph and name (GRAPPLE / REELING / STIM / CLOAK), the rebinding-aware key, charge cells
//            (grapple 2, stim and cloak 1) that fill with the recharge or drain with a running stim / cloak, the
//            seconds left, a status LED edge, and IN RANGE when the crosshair is on a grappleable voxel in range;
//            a glass under compactPx wide on screen (phones, wide FOVs) draws the compact face: bigger name, cells
//            and timer, no key cap, IN RANGE as a lit frame
//   housing  one merged gunmetal mesh (bezel, back plate, cradle onto the sleeve, strap)
//   offHand  a stand-in left fist for weapons built without a support glove (SMG, revolver, the knife): the rig
//            poses the left arm from it (ViewmodelArms.offHand, eased to the gun's own reload hand and back), so
//            the display is on screen with every pilot weapon; it follows a damped share of the gun's motion
//
// Every value comes from the titan-ui HUD model's `pilot.tactical` (titan-hud-state.js tacticalModel: the `tfs`
// charges and cooldown progress, the `tf` flags), the same object the DOM tactical chip paints. IN RANGE is
// presentation only: the server's grapple test (grappleTarget: the shot aim, release from the chest, the pull's line
// of sight) on the client world at 10 Hz, without titan hulls. titan-ui.js drives it each frame (update, before
// the rig) and hides the DOM chip while the screen is live (wristLive); the rig places it after posing the arms
// (ViewmodelRig.armGear -> standIn, place). Live means drawn, at least PILOT_WRIST.inView of the glass inside the
// viewport, and not aiming down sights on the support arm (the receiver covers it): anything else, and the rig
// root's own visibility (spectating, dying, seated, scope), hands the tactical back to the DOM chip at once.
//
// Cost: two draws (housing, screen), plus the stand-in fist's parts while it shows. The canvas redraws only when
// its quantised face changes (≤ 12 Hz; a tone or state change at once); per frame it builds one small face object
// and its key string to find that out.
import * as THREE from '../vendor/three.module.js';
import { mergeGeometries } from '../vendor/utils/BufferGeometryUtils.js';
import { createBlenderParts } from '../engine/blender-assets.js';
import { raycastVoxels } from '../../../shared/raycast.js';
import { PILOT_RULES, grappleLineClear } from '../../../shared/pilot-movement.js';
import { EYE_HEIGHT } from '../../../shared/combatmath.js';
import { TACTICAL_GLYPHS } from './titan-loadout.js';

/** Tuning (presentation only; metres in the rig's camera-local space at the base FOV). */
export const PILOT_WRIST = Object.freeze({
  liveMs: 250,          // the DOM chip stays hidden while the screen drew this recently
  inView: 0.75,         // share of the glass inside the viewport for the screen to count as live
  adsHandback: 0.5,     // ADS blend past which the support-arm slab (behind the receiver) hands back to the chip
  compactPx: 140,       // glass narrower than this on screen (CSS px) draws the compact face (the key cap < 9 px)
  easeGap: 0.05,        // stand-in <-> reload-hand ease share inside which the slab is off (no slide across the view)
  redrawHz: 12,         // canvas redraws per second at most (a tone or state change redraws at once)
  rangeHz: 10,          // IN RANGE ray rate
  canvas: Object.freeze({ width: 384, height: 240 }),
  screen: Object.freeze({ width: 0.11, height: 0.0688 }), // lit glass (m)
  bezel: 0.006,         // housing rim around the glass (m)
  depth: 0.016,         // housing thickness (m)
  cradle: 0.03,         // the housing's block under the slab, down to the sleeve across the tilt gap (m)
  along: 0.2,           // slab centre from the wrist joint toward the elbow (m)
  narrowAlong: 0.05,    // portrait: next to the glove, above the touch buttons
  narrowShift: -0.04,   // portrait: slab centre across the arm toward the screen centre (m along the screen x)
  cuffAlong: 0.01,      // portrait fallback: the slab right at the cuff
  handAlong: -0.05,     // last portrait fallback: over the back of the hand (gauntlet), past the wrist joint
  touchFloor: -0.53,    // portrait touch: lowest NDC y of the glass (the button cluster starts below)
  // Per-weapon seat [wide, portrait] (m along the screen x): the SKIPJACK's launcher body hides the support
  // forearm, the slab moves off it to the left (further on a portrait screen, where the body fills the middle);
  // the ARCHER and THUNDERBOLT bodies cover the right half of the portrait back-of-hand seat, the LMG's bipod
  // stub the right cell.
  weaponShift: Object.freeze({ mgl: Object.freeze([-0.055, -0.16]), archer: Object.freeze([0, -0.075]),
    thunderbolt: Object.freeze([0, -0.055]), lmg: Object.freeze([-0.05, -0.065]) }),
  // Grown slabs (phones, wide FOVs) grow leftward from the glass's right edge, away from the gun body.
  growAnchor: 1,
  radius: 0.056,        // sleeve surface from the forearm axis (m; the Blender sleeve, not the procedural box)
  tilt: 0.75,           // share of the turn from the sleeve surface toward the eye
  upright: 0.75,        // share of the turn from the forearm direction toward the screen's horizontal
  // Readability: small viewports and wide FOVs grow the slab (the viewmodel keeps its angular size, the screen
  // fraction shrinks with tan(fov / 2)).
  growRefPx: 760, growMax: 1.45, fovGrowMax: 1.3, growCap: 1.85, portraitScale: 0.85,
  // Stand-in left fist (rig root space at aspect >= 1.2; narrower screens pull it toward the centre).
  offHand: Object.freeze({ position: Object.freeze([-0.12, -0.2, -0.52]), narrowZ: -0.6, fingers: Object.freeze([0.9, 0.1, -0.4]),
    back: Object.freeze([-0.1, 0.7, 0.7]), narrowX: 0.02, narrowY: -0.13, along: 0.05,
    follow: 0.5 }),     // share of the gun's motion from its hip rest (bob, kick, ADS, reload, stow) the fist follows
});

const FONT = "'Rajdhani', 'Bahnschrift', 'Arial Narrow', 'Roboto Condensed', sans-serif";
const INK = Object.freeze({
  bg: '#04080b', glass: '#0a1218', rule: '#1b3442', white: '#eef6fb', sub: '#8fa4b2', dim: '#2a3843',
  amber: '#ffab2e', amberDim: '#7a5520', cyan: '#46d2ff', green: '#7fe07a', cloak: '#9ad8ff',
});
/** Tone of the face: its accent colour. */
const TONES = Object.freeze({ ready: INK.amber, reel: INK.cyan, stim: INK.green, cloak: INK.cloak, cool: INK.amberDim });
const QUANT = 40;   // fill steps

const now = () => globalThis.performance?.now?.() ?? Date.now();
/** Share of an NDC span [a, b] inside [-1, 1]. */
const overlap = (a, b) => b > a ? Math.max(0, Math.min(1, b) - Math.max(-1, a)) / (b - a) : 0;
const clamp01 = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const shared = { shownAt: -Infinity };

/** True while a pilot wrist screen drew within PILOT_WRIST.liveMs (titan-ui hides the DOM tactical chip). */
export const wristLive = (atMs = now()) => atMs - shared.shownAt <= PILOT_WRIST.liveMs;
/** Time (performance.now ms) the screen last drew (capture pages compare it with their render). */
export const wristShownAt = () => shared.shownAt;
/** Clears the live flag (titan-ui dispose). */
export function resetWrist() { shared.shownAt = -Infinity; }

/**
 * Whether the wrist is worn this frame, from the HUD model: on foot in the pilot layout, not spectating (a dead
 * or seated player has another layout). The rig root hides it further with the weapon (scope, killcam).
 */
export function wristShown(model, { spectating = false } = {}) {
  return model?.layout === 'pilot' && !!model.pilot?.tactical && !spectating;
}

/**
 * The quantised face of a tactical model (titan-hud-state.js tacticalModel): what the screen draws. Pure.
 *   { tone, glyph, label, key, cells: [0..1], drain, timer ('3.3' | null), status ('READY' | 'REEL' | null), inRange, compact }
 * `drain`: the cells show a running stim / cloak emptying (else a recharge filling). `compact`: the small-glass layout
 * (no key cap).
 */
export function wristFace(tactical, { inRange = false, touch = false, compact = false } = {}) {
  const t = tactical;
  if (!t) return null;
  const q = value => Math.round(clamp01(value) * QUANT) / QUANT;
  const active = t.state === 'active';
  const tone = t.id === 'grapple' ? (active ? 'reel' : t.charges > 0 ? 'ready' : 'cool')
    : active ? t.id : t.state === 'ready' ? 'ready' : 'cool';
  const drain = active && t.id !== 'grapple';
  const cells = drain ? [q(t.activeFrac)] : (t.pips ?? []).map(q);
  // Reeling shows the cable chevrons, not the spent charge's recharge (its cell still fills).
  const left = drain ? t.activeLeft : active ? null : t.cooldownLeft;
  const timer = Number.isFinite(left) && left > 0 ? (Math.ceil(left * 10 - 1e-6) / 10).toFixed(1) : null;
  return {
    tone, glyph: t.id, label: t.id === 'grapple' && active ? 'REELING' : String(t.label ?? '').toUpperCase(),
    key: touch || compact ? '' : String(t.key ?? ''), compact: !!compact,
    cells, drain, timer, status: timer ? null : active ? (t.id === 'grapple' ? 'REEL' : null) : t.state === 'ready' ? 'READY' : null,
    inRange: !!inRange && t.id === 'grapple' && !active && t.charges > 0,
  };
}

const faceKey = face => face ? `${face.tone}|${face.glyph}|${face.label}|${face.key}|${face.cells.join(',')}|${face.drain}|${face.timer}|${face.status}|${face.inRange}|${face.compact}` : '';
/** Faces whose difference redraws at once (not throttled): anything but a cell fill or the timer moving. */
const faceClass = face => face ? `${face.tone}|${face.glyph}|${face.label}|${face.key}|${face.cells.length}|${face.status}|${face.inRange}|${face.compact}` : '';

/**
 * IN RANGE (presentation only): the server's grapple test (server/sim/titanfall/pilot-tacticals.js grappleTarget)
 * on the client world, without titan hulls: the first solid voxel along `dir` from the eye within the cable range,
 * its anchor (0.05 m off the face) at least the release distance from the chest, and the pull's line from the head
 * clear (grappleLineClear). `body` is the feet position (default: `EYE_HEIGHT` under the eye).
 */
export function grappleInRange(solidAt, origin, dir, body = null, rules = PILOT_RULES.grapple) {
  if (typeof solidAt !== 'function' || !origin || !dir) return false;
  const hit = raycastVoxels(solidAt, origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, rules.range);
  if (!hit || hit.t > rules.range || hit.t <= 0.3) return false;
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1, pad = 0.05;
  const anchor = [origin.x + dir.x / len * hit.t + hit.nx * pad, origin.y + dir.y / len * hit.t + hit.ny * pad,
    origin.z + dir.z / len * hit.t + hit.nz * pad];
  const feet = body ?? { x: origin.x, y: origin.y - EYE_HEIGHT, z: origin.z };
  if (Math.hypot(anchor[0] - feet.x, anchor[1] - (feet.y + rules.chest), anchor[2] - feet.z) < rules.release) return false;
  return grappleLineClear({ solidAt }, feet, anchor);
}

// ---------------------------------------------------------------------------------- canvas face

function canvasTexture(width, height) {
  const canvas = globalThis.document?.createElement?.('canvas');
  const ctx = canvas?.getContext?.('2d');
  if (!ctx || typeof ctx.fillRect !== 'function' || typeof ctx.fillText !== 'function') return null;
  canvas.width = width; canvas.height = height;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.name = 'pilot-wrist-screen';
  return { canvas, ctx, texture };
}

const glyphPaths = new Map();
function glyphPath(id) {
  if (!glyphPaths.has(id)) {
    let path = null;
    try { path = typeof Path2D === 'function' ? new Path2D(TACTICAL_GLYPHS[id] ?? 'M6 6 H18 V18 H6 Z') : null; } catch { path = null; }
    glyphPaths.set(id, path);
  }
  return glyphPaths.get(id);
}

/** A chamfered cell outline path (top-right and bottom-left corners cut). */
function cellPath(ctx, x, y, w, h, cut) {
  ctx.beginPath();
  ctx.moveTo(x, y); ctx.lineTo(x + w - cut, y); ctx.lineTo(x + w, y + cut); ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + cut, y + h); ctx.lineTo(x, y + h - cut); ctx.closePath();
}

/** Paint one face onto the canvas (384 x 240 layout units; the compact face trades the key cap and the IN RANGE
 *  tag for bigger type, its glass is ~60 px tall on a phone). */
export function drawWristFace(ctx, face, { width = PILOT_WRIST.canvas.width, height = PILOT_WRIST.canvas.height } = {}) {
  ctx.save();
  ctx.setTransform(width / 384, 0, 0, height / 240, 0, 0);
  ctx.fillStyle = INK.bg; ctx.fillRect(0, 0, 384, 240);
  const g = ctx.createLinearGradient(0, 0, 0, 240);
  if (g) { g.addColorStop(0, '#0e1a22'); g.addColorStop(1, INK.bg); ctx.fillStyle = g; ctx.fillRect(16, 0, 368, 240); }
  if (!face) { ctx.restore(); return; }
  const ink = TONES[face.tone] ?? INK.amber;
  const cool = face.tone === 'cool', compact = !!face.compact;
  // Status LED edge (IN RANGE lights it white-hot; the compact face frames the glass in cyan instead of the tag).
  ctx.fillStyle = face.inRange ? INK.white : ink;
  ctx.globalAlpha = cool ? 0.45 : 1;
  ctx.fillRect(0, 0, compact ? 16 : 12, 240);
  ctx.globalAlpha = 1;
  if (compact && face.inRange) { ctx.strokeStyle = INK.cyan; ctx.lineWidth = 10; ctx.strokeRect(21, 5, 358, 230); }
  // Glyph.
  const path = glyphPath(face.glyph);
  ctx.save();
  if (compact) { ctx.translate(26, 4); ctx.scale(6.4, 6.4); } else { ctx.translate(18, 2); ctx.scale(6.3, 6.3); }
  ctx.lineWidth = 1.9; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = cool ? INK.sub : ink;
  if (face.glyph === 'cloak') ctx.setLineDash([3, 2]);
  if (path) ctx.stroke(path); else ctx.strokeRect(6, 6, 12, 12);
  ctx.restore();
  // Name.
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.fillStyle = cool ? INK.sub : face.tone === 'ready' ? INK.white : ink;
  if (compact) {
    ctx.font = `700 ${face.label.length > 6 ? 50 : 56}px ${FONT}`;
    ctx.fillText(face.label, 28, 224, 162);
  } else {
    ctx.font = `700 ${face.label.length > 6 ? 38 : 44}px ${FONT}`;
    ctx.fillText(face.label, 26, 184, 160);
  }
  // Key chip and IN RANGE.
  let x = 26;
  if (face.key) {
    ctx.font = `700 24px ${FONT}`;
    const w = Math.max(30, ctx.measureText(face.key).width + 14);
    ctx.strokeStyle = INK.sub; ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, 198, w, 32);
    ctx.fillStyle = INK.white; ctx.textAlign = 'center';
    ctx.fillText(face.key, x + 1 + w / 2, 223);
    x += w + 10;
  }
  if (face.inRange && !compact) {
    ctx.fillStyle = INK.cyan; ctx.fillRect(x, 198, 148, 32);
    ctx.fillStyle = INK.bg; ctx.font = `700 24px ${FONT}`; ctx.textAlign = 'center';
    ctx.fillText('IN RANGE', x + 74, 223, 140);
  }
  // Charge cells: grapple two tall cells, stim / cloak one wide one.
  const n = Math.max(1, face.cells.length);
  const gap = 14, top = compact ? 14 : 16, h = compact ? 132 : 124, left = 196, span = compact ? 168 : 172;
  const w = (span - gap * (n - 1)) / n;
  for (let i = 0; i < n; i++) {
    const fill = face.cells[i] ?? 0, cx = left + i * (w + gap);
    cellPath(ctx, cx, top, w, h, 12);
    ctx.fillStyle = INK.glass; ctx.fill();
    if (fill > 0) {
      ctx.save();
      cellPath(ctx, cx, top, w, h, 12); ctx.clip();
      const full = fill >= 1 && !face.drain;
      ctx.fillStyle = ink; ctx.globalAlpha = full || face.drain ? 1 : 0.55;
      ctx.fillRect(cx, top + h * (1 - fill), w, h * fill);
      if (!full) { ctx.globalAlpha = 1; ctx.fillRect(cx, top + h * (1 - fill), w, 5); }
      ctx.restore();
    }
    cellPath(ctx, cx, top, w, h, 12);
    ctx.lineWidth = 4; ctx.strokeStyle = fill >= 1 ? ink : cool ? INK.dim : INK.rule; ctx.stroke();
  }
  // Seconds left (or the status word) under the cells.
  ctx.textAlign = 'center';
  if (face.timer && compact) {
    ctx.fillStyle = face.drain ? ink : INK.white;
    ctx.font = `700 84px ${FONT}`;
    ctx.fillText(face.timer, left + span / 2, 230, span);
  } else if (face.timer) {
    ctx.fillStyle = face.drain ? ink : INK.white;
    ctx.font = `700 74px ${FONT}`;
    const tw = ctx.measureText(face.timer).width;
    ctx.fillText(face.timer, left + span / 2 - 10, 226);
    ctx.fillStyle = INK.sub; ctx.font = `700 30px ${FONT}`; ctx.textAlign = 'left';
    ctx.fillText('S', left + span / 2 - 10 + tw / 2 + 4, 226);
  } else if (face.status === 'REEL') {
    // Cable chevrons toward the hook.
    ctx.strokeStyle = ink; ctx.lineWidth = compact ? 12 : 9; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let i = 0; i < 4; i++) {
      const cx = left + 22 + i * 40, y = compact ? 172 : 166;
      ctx.beginPath(); ctx.moveTo(cx, y); ctx.lineTo(cx + 18, y + 26); ctx.lineTo(cx, y + 52); ctx.stroke();
    }
  } else if (face.status) {
    ctx.fillStyle = ink; ctx.font = `700 ${compact ? 56 : 46}px ${FONT}`;
    ctx.fillText(face.status, left + span / 2, compact ? 222 : 214, span);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------------- meshes

/** The housing: bezel frame, back plate, the cradle down onto the sleeve and the strap bands, one merged geometry
 *  (slab-local: screen at +z). */
export function wristHousingGeometry() {
  const S = PILOT_WRIST.screen, b = PILOT_WRIST.bezel, d = PILOT_WRIST.depth;
  const parts = [];
  const box = (w, h, depth, x, y, z) => { const g = new THREE.BoxGeometry(w, h, depth); g.translate(x, y, z); parts.push(g); };
  const W = S.width + b * 2, H = S.height + b * 2;
  box(W, H, d, 0, 0, -d / 2);                          // slab body (the screen sits on its face)
  box(W + 0.006, H * 0.62, d * 0.5, 0, 0, -d * 0.85);  // side lugs
  box(b * 1.2, H, 0.004, -W / 2 + b * 0.6, 0, 0.002);  // raised left rim
  box(b * 1.2, H, 0.004, W / 2 - b * 0.6, 0, 0.002);   // raised right rim
  box(W, b * 1.2, 0.004, 0, H / 2 - b * 0.6, 0.002);   // raised top rim
  box(W, b * 1.2, 0.004, 0, -H / 2 + b * 0.6, 0.002);  // raised bottom rim
  box(W * 0.5, H * 0.55, PILOT_WRIST.cradle, 0, 0, -d - PILOT_WRIST.cradle / 2); // cradle: fills the tilt gap to the sleeve
  box(0.02, H + 0.022, 0.006, -W * 0.18, 0, -d - 0.002); // strap bands over the cradle, round the sleeve
  box(0.02, H + 0.022, 0.006, W * 0.18, 0, -d - 0.002);
  box(0.02, 0.008, PILOT_WRIST.cradle + 0.006, -W * 0.18, (H + 0.022) / 2 - 0.004, -d - PILOT_WRIST.cradle / 2);
  box(0.02, 0.008, PILOT_WRIST.cradle + 0.006, W * 0.18, (H + 0.022) / 2 - 0.004, -d - PILOT_WRIST.cradle / 2);
  box(0.02, 0.008, PILOT_WRIST.cradle + 0.006, -W * 0.18, -(H + 0.022) / 2 + 0.004, -d - PILOT_WRIST.cradle / 2);
  box(0.02, 0.008, PILOT_WRIST.cradle + 0.006, W * 0.18, -(H + 0.022) / 2 + 0.004, -d - PILOT_WRIST.cradle / 2);
  const merged = mergeGeometries(parts.map(g => g.toNonIndexed()), false);
  for (const g of parts) g.dispose();
  return merged;
}

const _wrist = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _back = new THREE.Vector3();
const _toEye = new THREE.Vector3();
const _radial = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _sx = new THREE.Vector3();
const _sy = new THREE.Vector3();
const _right = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _rect = { minX: 0, maxX: 0, minY: 0, maxY: 0, behind: false };

/** The per-weapon slab shift (m) for a held weapon at a portrait share `narrow` (0 wide .. 1 portrait). */
export function weaponShift(weapon, narrow = 0) {
  const shift = PILOT_WRIST.weaponShift[weapon];
  return shift ? shift[0] + (shift[1] - shift[0]) * narrow : 0;
}

/** Pure placement: the slab centre and basis (x along the screen, z its normal) on a forearm, in rig root space. */
export function wristPose(wrist, axis, back, out = {}, { along = PILOT_WRIST.along, radius = PILOT_WRIST.radius, depth = PILOT_WRIST.depth,
  tilt = PILOT_WRIST.tilt, upright = PILOT_WRIST.upright, scale = 1, shift = 0 } = {}) {
  const centre = (out.position ||= new THREE.Vector3()).copy(wrist).addScaledVector(axis, along);
  // Around the sleeve toward the eye (the eye is the rig root origin).
  _toEye.copy(centre).negate();
  _radial.copy(_toEye).addScaledVector(axis, -_toEye.dot(axis));
  if (_radial.lengthSq() < 1e-8) _radial.copy(back);
  _radial.normalize();
  _normal.copy(_toEye).normalize().sub(_radial).multiplyScalar(tilt).add(_radial).normalize();
  // Off the sleeve: the slab sits on its cradle, its tilted edge clears the sleeve (sunk in, the cloth covers the glass).
  const sin = Math.sqrt(Math.max(0, 1 - _normal.dot(_radial) ** 2));
  const half = Math.max(PILOT_WRIST.screen.width, PILOT_WRIST.screen.height) / 2 + PILOT_WRIST.bezel;
  centre.addScaledVector(_radial, radius).addScaledVector(_normal, (depth + half * sin) * scale);
  // Screen x: between the forearm direction (read left to right) and the view's horizontal, in the screen plane.
  _sx.copy(axis).addScaledVector(_normal, -axis.dot(_normal));
  if (_sx.x < 0) _sx.negate();
  _right.set(1, 0, 0).addScaledVector(_normal, -_normal.x);
  if (_sx.lengthSq() < 1e-8) _sx.copy(_right);
  _sx.normalize();
  if (_right.lengthSq() > 1e-8) _sx.lerp(_right.normalize(), upright).normalize();
  _sy.crossVectors(_normal, _sx).normalize();
  _sx.crossVectors(_sy, _normal).normalize();
  (out.quaternion ||= new THREE.Quaternion()).setFromRotationMatrix(_m.makeBasis(_sx, _sy, _normal));
  out.scale = scale;
  if (shift) centre.addScaledVector(_sx, shift * scale);
  out.normal = (out.normal ||= new THREE.Vector3()).copy(_normal);
  return out;
}

/** The stand-in fist: a mirrored Blender grip glove, else a procedural box mitt. Its frame is the kit glove frame. */
function buildOffHand() {
  const anchor = new THREE.Group();
  anchor.name = 'pilot-wrist-offhand';
  const glove = new THREE.Group();
  glove.name = 'pilot-wrist-offhand-glove';
  const parts = createBlenderParts('hands', { names: ['grip'] })?.grip;
  if (parts) {
    glove.add(...parts.children);
    glove.scale.x = -1;
  } else {
    const leather = new THREE.MeshStandardMaterial({ color: 0x22252a, roughness: 0.85, metalness: 0.08, flatShading: true });
    const fist = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.07), leather);
    glove.add(fist);
  }
  glove.traverse(node => { node.frustumCulled = false; node.castShadow = false; });
  glove.visible = false;
  anchor.add(glove);
  return { anchor, glove, blender: !!parts };
}

export class PilotWrist {
  /** `solidAt(x, y, z)`: the client world for IN RANGE (omit to drive it from update's `inRange`). */
  constructor({ solidAt = null } = {}) {
    this.solidAt = solidAt;
    this.rig = null;
    this.show = false;
    this.face = null;
    this.key = ''; this.cls = '';
    this.drawnAt = -Infinity;
    this.redraws = 0;
    this.inRange = false;
    this.touch = false;
    this.weapon = null;
    this.rangeAt = -Infinity;
    this.viewHeight = 1080;
    this.compact = false;
    /** The screen counts as live this frame (placed, mostly in view, not behind the receiver in ADS). */
    this.live = false;
    this.pose = {};
    const group = this.group = new THREE.Group();
    group.name = 'pilot-wrist';
    this.housingMaterial = new THREE.MeshStandardMaterial({ name: 'pilot-wrist-housing', color: 0x343b44, roughness: 0.55, metalness: 0.35, flatShading: true });
    this.housing = new THREE.Mesh(wristHousingGeometry(), this.housingMaterial);
    this.housing.name = 'pilot-wrist-housing';
    this.tex = canvasTexture(PILOT_WRIST.canvas.width, PILOT_WRIST.canvas.height);
    this.screenMaterial = new THREE.MeshBasicMaterial({ name: 'pilot-wrist-screen', map: this.tex?.texture ?? null, color: this.tex ? 0xffffff : 0xffab2e,
      toneMapped: false });
    this.screen = new THREE.Mesh(new THREE.PlaneGeometry(PILOT_WRIST.screen.width, PILOT_WRIST.screen.height), this.screenMaterial);
    this.screen.name = 'pilot-wrist-screen';
    this.screen.position.z = 0.0008;
    this.screen.onBeforeRender = () => { if (this.live) shared.shownAt = now(); };
    for (const mesh of [this.housing, this.screen]) { mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = false; }
    group.add(this.housing, this.screen);
    const off = buildOffHand();
    this.offHand = off.anchor;
    this.offHandGlove = off.glove;
    this.offHandRest = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
    this._placeOffHand(16 / 9);
    if (this.tex) drawWristFace(this.tex.ctx, null);
  }

  /**
   * Mount on a ViewmodelRig (its armGear slot); the rig places the slab after posing the arms. The stand-in fist
   * hangs under the rig's grip-pivot frame (comp: bob, sway and kick about the grip), the slab under its root.
   */
  attach(rig) {
    if (!rig?.root) return false;
    this.detach();
    this.rig = rig;
    rig.armGear = this;
    rig.root.add(this.group);
    (rig.comp ?? rig.root).add(this.offHand);
    return true;
  }

  detach() {
    const rig = this.rig;
    this.rig = null;
    if (rig?.armGear === this) rig.armGear = null;
    this.group.removeFromParent();
    this.offHand.removeFromParent();
  }

  /**
   * Per frame, before the rig update: the tactical model (titanHudModel pilot.tactical) or null, whether the wrist
   * is worn (wristShown), and IN RANGE either given (`inRange`) or sampled from `camera` against `solidAt`.
   */
  update(tactical, { show = true, inRange = null, camera = null, aim = null, nowMs = now(), touch = false, weapon = null,
    viewHeight = globalThis.innerHeight } = {}) {
    this.show = !!show && !!tactical;
    this.touch = !!touch;
    this.weapon = weapon;
    if (!this.show) this.live = false;
    if (Number.isFinite(viewHeight) && viewHeight > 0) this.viewHeight = viewHeight;
    if (typeof inRange === 'boolean') this.inRange = inRange;
    else if (this.show && camera && this.solidAt && nowMs - this.rangeAt >= 1000 / PILOT_WRIST.rangeHz) {
      this.rangeAt = nowMs;
      // `aim` (the local player): the shot aim the grapple intent sends and the feet, as the server tests them;
      // else the camera's view (it carries the screen shake).
      camera.getWorldPosition(_wrist);
      if (Number.isFinite(aim?.shotYaw) && Number.isFinite(aim?.shotPitch)) {
        const cp = Math.cos(aim.shotPitch);
        _axis.set(-Math.sin(aim.shotYaw) * cp, Math.sin(aim.shotPitch), -Math.cos(aim.shotYaw) * cp);
      } else camera.getWorldDirection(_axis);
      this.inRange = grappleInRange(this.solidAt, _wrist, _axis, aim?.pos ?? null);
    }
    if (!this.show) return;
    const face = wristFace(tactical, { inRange: this.inRange, touch, compact: this.compact });
    const key = faceKey(face);
    if (key === this.key) return;
    const cls = faceClass(face);
    if (cls === this.cls && nowMs - this.drawnAt < 1000 / PILOT_WRIST.redrawHz) return;
    this.face = face; this.key = key; this.cls = cls; this.drawnAt = nowMs;
    if (this.tex) {
      drawWristFace(this.tex.ctx, face);
      this.tex.texture.needsUpdate = true;
      this.redraws++;
    }
  }

  /** The stand-in fist's guard pose for a viewport aspect (narrow screens pull it toward the centre). */
  _placeOffHand(aspect) {
    const o = PILOT_WRIST.offHand;
    const narrow = Math.max(0, Math.min(1, (1.2 - aspect) / 0.75));
    this.offHand.position.set(o.position[0] + (o.narrowX - o.position[0]) * narrow, o.position[1] + (o.narrowY - o.position[1]) * narrow,
      o.position[2] + (o.narrowZ - o.position[2]) * narrow);
    this.narrow = narrow;
    _axis.fromArray(o.fingers).normalize().negate();
    _back.fromArray(o.back);
    _back.addScaledVector(_axis, -_back.dot(_axis)).normalize();
    _sx.crossVectors(_back, _axis);
    this.offHand.quaternion.setFromRotationMatrix(_m.makeBasis(_sx, _back, _axis));
    this.offHandRest.position.copy(this.offHand.position);
    this.offHandRest.quaternion.copy(this.offHand.quaternion);
    this.offHandAspect = aspect;
  }

  /**
   * ViewmodelRig hook, before the arms are posed: the stand-in fist while the wrist is worn (else null, and the
   * left arm keeps the gun's own rule). It takes PILOT_WRIST.offHand.follow of the gun content's move away from its
   * hip rest (`hip` position, `hipYaw`), so it rides ADS, recoil, reload rock and stow with the gun, damped.
   */
  standIn(content, hip, hipYaw = 0) {
    if (!this.show) return null;
    const camera = this.rig?.camera;
    if (Number.isFinite(camera?.aspect) && Math.abs(camera.aspect - this.offHandAspect) > 0.01) this._placeOffHand(camera.aspect);
    const k = PILOT_WRIST.offHand.follow, rest = this.offHandRest;
    this.offHand.position.copy(rest.position);
    this.offHand.quaternion.copy(rest.quaternion);
    if (content && hip) {
      const p = content.position, r = content.rotation;
      this.offHand.position.x += (p.x - hip.x) * k;
      this.offHand.position.y += (p.y - hip.y) * k;
      this.offHand.position.z += (p.z - hip.z) * k;
      _q.setFromEuler(_e.set(r.x * k, (r.y - hipYaw) * k, r.z * k, r.order));
      this.offHand.quaternion.premultiply(_q);
    }
    return this.offHand;
  }

  /**
   * ViewmodelRig hook, after the arms are posed: the slab on the left forearm, or hidden. Sets `live` (the DOM chip
   * hides) when at least PILOT_WRIST.inView of the glass is inside the viewport and, on the gun's own support arm,
   * the view is not past PILOT_WRIST.adsHandback into ADS (the receiver covers the slab); `compact` from its width.
   */
  place(arms) {
    const W = PILOT_WRIST;
    const arm = arms?.arms?.find(item => item.side < 0);
    const forearm = arm?.segments?.forearm;
    const camera = this.rig?.camera;
    if (Number.isFinite(camera?.aspect) && Math.abs(camera.aspect - this.offHandAspect) > 0.01) this._placeOffHand(camera.aspect);
    this.offHandGlove.visible = this.show && !!arms?.offHandUsed && !!arms?.root?.visible;
    if (!this.show || !arms?.root?.visible || !forearm?.visible) { this.hide(); return; }
    // The forearm segment: wrist joint at its origin, +z toward the elbow, +y the back of the forearm.
    _wrist.copy(forearm.position);
    _axis.set(0, 0, 1).applyQuaternion(forearm.quaternion);
    _back.set(0, 1, 0).applyQuaternion(forearm.quaternion);
    // Seat on the stand-in fist's forearm or the gun's support forearm, blended with the arms' own ease between them.
    const scale = this.grow(), share = clamp01(arms.offHandShare ?? (arms.offHandUsed ? 1 : 0)), gun = 1 - share;
    // Mid-ease (a one-handed gun's reload hand taking the arm, ~0.15 s) the slab is off rather than sliding across
    // the screen; the live window bridges the gap, so the DOM chip does not flicker.
    if (share > W.easeGap && share < 1 - W.easeGap) { this.group.visible = false; this.live = false; return; }
    const half = W.screen.width / 2 + W.bezel;
    const options = { scale, radius: W.radius * (forearm.scale.x || 1),
      shift: gun * (W.narrowShift * this.narrow + weaponShift(this.weapon, this.narrow) - W.growAnchor * (scale - 1) * half / scale),
      along: W.offHand.along * share + (W.along + (W.narrowAlong - W.along) * this.narrow) * gun };
    wristPose(_wrist, _axis, _back, this.pose, options);
    // Portrait touch layout: the slab stays above the button cluster. Slid up to the cuff, then over the back of
    // the hand, when that clears it; a pose with the whole hand under the buttons leaves the tactical to the DOM chip.
    const floor = this.touch ? W.touchFloor + (-1 - W.touchFloor) * (1 - this.narrow) : -Infinity;
    for (const along of [W.cuffAlong, W.handAlong]) {
      if (this.slabBottom(camera) >= floor) break;
      options.along = along;
      wristPose(_wrist, _axis, _back, this.pose, options);
    }
    if (this.slabBottom(camera) < floor) { this.hide(); return; }
    this.group.position.copy(this.pose.position);
    this.group.quaternion.copy(this.pose.quaternion);
    this.group.scale.setScalar(scale);
    this.group.visible = true;
    const rect = this.glassRect(camera);
    const inView = !rect || rect.behind ? 0 : overlap(rect.minX, rect.maxX) * overlap(rect.minY, rect.maxY);
    const aspect = Number.isFinite(camera?.aspect) ? camera.aspect : 16 / 9;
    if (rect && !rect.behind) this.compact = (rect.maxX - rect.minX) / 2 * this.viewHeight * aspect < W.compactPx;
    const ads = this.rig?.currentAdsT01 ?? 0;
    this.live = inView >= W.inView && !(gun > 0.5 && ads > W.adsHandback);
    if (!this.live) shared.shownAt = -Infinity;
  }

  /** Slab off: no live screen, the DOM chip takes the tactical back at once. */
  hide() {
    this.group.visible = false;
    this.live = false;
    shared.shownAt = -Infinity;
  }

  /** NDC bounds of the posed slab's glass (rig root space is the camera frame scaled by root.scale), or null. */
  glassRect(camera) {
    if (!camera?.projectionMatrix) return null;
    const S = PILOT_WRIST.screen, k = this.pose.scale ?? 1, root = this.rig?.root?.scale?.x || 1;
    _rect.minX = _rect.minY = Infinity; _rect.maxX = _rect.maxY = -Infinity; _rect.behind = false;
    for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      _v.set(x * S.width / 2 * k, y * S.height / 2 * k, 0).applyQuaternion(this.pose.quaternion).add(this.pose.position)
        .multiplyScalar(root);
      if (_v.z > -(camera.near ?? 0.01)) _rect.behind = true;
      _v.applyMatrix4(camera.projectionMatrix);
      _rect.minX = Math.min(_rect.minX, _v.x); _rect.maxX = Math.max(_rect.maxX, _v.x);
      _rect.minY = Math.min(_rect.minY, _v.y); _rect.maxY = Math.max(_rect.maxY, _v.y);
    }
    return _rect;
  }

  /** The lowest NDC y of the posed slab's glass. */
  slabBottom(camera) {
    return this.glassRect(camera)?.minY ?? Infinity;
  }

  /** Slab scale for the viewport height and FOV (readability on phones and at wide FOVs). */
  grow() {
    const W = PILOT_WRIST;
    const px = Math.min(W.growMax, Math.max(1, W.growRefPx / this.viewHeight));
    // Portrait: the horizontal view is narrow, the slab would span half of it.
    const aspect = this.rig?.camera?.aspect;
    const wide = Number.isFinite(aspect) ? Math.max(0, Math.min(1, (aspect - 0.45) / 0.75)) : 1;
    const fov = this.rig?.camera?.fov;
    const ratio = Number.isFinite(fov) ? Math.tan(fov * Math.PI / 360) / Math.tan(37.5 * Math.PI / 180) : 1;
    return Math.min(W.growCap, px * Math.min(W.fovGrowMax, Math.max(1, Math.sqrt(ratio)))) * (W.portraitScale + (1 - W.portraitScale) * wide);
  }

  /** Capture hook: the screen's box in CSS px for a camera and viewport, or null when hidden. */
  screenBox(camera, width, height) {
    if (!this.group.visible || !camera) return null;
    this.screen.updateWorldMatrix(true, false);
    const S = PILOT_WRIST.screen;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      _v.set(x * S.width / 2, y * S.height / 2, 0).applyMatrix4(this.screen.matrixWorld).project(camera);
      const px = (_v.x + 1) / 2 * width, py = (1 - _v.y) / 2 * height;
      left = Math.min(left, px); right = Math.max(right, px); top = Math.min(top, py); bottom = Math.max(bottom, py);
    }
    return { left, top, width: right - left, height: bottom - top };
  }

  /** Test and capture hook. */
  debug() {
    return { visible: this.group.visible, live: this.live, compact: this.compact, face: this.face, redraws: this.redraws,
      offHand: this.offHandGlove.visible, scale: this.group.scale.x };
  }

  dispose() {
    this.detach();
    this.housing.geometry.dispose();
    this.screen.geometry.dispose();
    this.housingMaterial.dispose();
    this.screenMaterial.dispose();
    this.tex?.texture.dispose();
    this.offHandGlove.traverse(node => {
      if (!node.isMesh) return;
      // Blender glove parts share the page-owned geometry (blender-assets.js); only their cloned materials are ours.
      if (!node.geometry?.userData?.pageOwned) node.geometry?.dispose();
      for (const material of [].concat(node.material)) material?.dispose?.();
    });
    this.offHand.clear();
    this.group.clear();
    this.tex = null;
  }
}
