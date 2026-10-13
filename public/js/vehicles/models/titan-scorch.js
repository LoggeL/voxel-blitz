// SCORCH (Ogre frame, 7.4 m): the heavy fire titan (docs/design/titanfall/README.md
// "SCORCH", titan-turnaround-scorch.png, lineup B). Silhouette: a round stepped dome
// with no head and an orange visor slit, the widest squared pauldrons of the five, a
// wide low stance, red fuel tanks on the back and the right hip, orange hip vents, a
// heat-shield plate with two glowing slots on the left forearm, and the short fat
// T-203 thermite launcher (3.0 m round barrel, muzzle shroud, orange band) carried at the right hip.
// Every part is authored in hull metres at its skeleton slot (titan-common.js); fine
// (0.1 m) parts use coordinates on the hull 0.1 m lattice, the launcher (centred on
// the mount pivot in x/y) odd multiples of 0.05 m from the pivot.
import { blueprint } from './common.js';
import { VOXEL_MATERIALS } from '../voxel-model/material.js';
import {
  TITAN_PALETTE as P, titanSkeleton, slotPart, slotFine, assembleTitan, hullCenter,
  piston, vents, hazardBand, bolts, batteryHatch, cable, isCamo, lamp, plateEdges, hipDrive, cockpitCavity,
} from './titan-common.js';

const TYPE = 'titan_scorch';
/** Non-emissive thermite orange for the launcher band (material.js request), else hazard yellow. */
const THERMITE = Object.hasOwn(VOXEL_MATERIALS, 'thermite') ? 'thermite' : P.hazard;
const r1 = value => Math.round(value * 10) / 10;

// ---- shape helpers ------------------------------------------------------------------------

/** Set every cell of `part` in [min, max) whose hull-metre centre gets a material from `shade(x, y, z)`. */
function fill(part, min, max, shade, { tag = null } = {}) {
  const map = p => (part.fine ? part._p(p) : p);
  const lo = part.cells3(map(min)), hi = part.cells3(map(max));
  for (let i = lo[0]; i < hi[0]; i++) for (let j = lo[1]; j < hi[1]; j++) for (let k = lo[2]; k < hi[2]; k++) {
    const m = shade(hullCenter(part, i, 0), hullCenter(part, j, 1), hullCenter(part, k, 2));
    if (m) part.setCell(i, j, k, m, tag);
  }
  return part;
}
/** Box with its corners in any order (mirrored sides). */
function bx(part, a, b, material, options) {
  return part.box([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])], material, options);
}
const span = (a, b) => [Math.min(a, b), Math.max(a, b)];
function tagAll(part, tag, priority) {
  for (const [, voxel] of part.cells) voxel.tag = tag;
  part.userData.priority = { ...part.userData.priority, [tag]: priority };
  return part;
}

// The dome: half-width 1.6 m and half-depth 1.5 m at y 5.6, a squarish superellipse
// profile (full crown, tucked belly), stepped by the voxels, cut at 4.4 below (abdomen)
// and clamped at 7.4 on top (README).
const DOME = Object.freeze({ y: 5.6, up: 1.9, down: 1.5, q: 2.6, hw: 1.6, hd: 1.5, z: 0.05, p: 2.4, bottom: 4.4, top: 7.4 });
function dome(x, y, z, inset = 0) {
  if (y < DOME.bottom || y > DOME.top) return Infinity;
  const f = 1 - Math.abs((y - DOME.y) / (y > DOME.y ? DOME.up : DOME.down)) ** DOME.q;
  if (f <= 0) return Infinity;
  const s = f ** (1 / DOME.q), hw = DOME.hw * s - inset, hd = DOME.hd * s - inset;
  if (hw <= 0.05 || hd <= 0.05) return Infinity;
  return Math.abs(x / hw) ** DOME.p + Math.abs((z - DOME.z) / hd) ** DOME.p;
}

function buildParts() {
  const skel = titanSkeleton(TYPE, {
    // Leaner Ogre legs (README: lineup A): thigh + shin ≈ 1.045 × (hip − ankle − 0.06).
    thigh: 1.0, shin: 1.55,
    // The launcher sits inboard of the forearm; the elbow rides 1.1 m behind the mount pivot.
    elbowOut: 0.85, elbowBack: 1.1,
    // No head: the visor housing pitches about its own seat in the dome's brow.
    neck: [0, 6.9, -0.7],
    hatchHinge: [0, 6.2, -1.5],
  });
  const S = skel;
  const parts = {};

  // ---- legs -------------------------------------------------------------------------------
  for (const side of [-1, 1]) {
    const k = side < 0 ? 'L' : 'R', X = v => side * v;
    const hip = S[`hip${k}`], knee = S[`knee${k}`], ankle = S[`ankle${k}`];
    const hx = hip[0], hy = hip[1], ky = knee[1], ay = ankle[1];
    const out = (a, b) => span(X(a), X(b));   // outboard x range at |x| a..b
    // Art review 2: thighs and shins 0.2 m wider on the wider (hip 1.05 m) stance; the outer
    // tasset and shin vents sit on the new outer faces.
    const ax = Math.abs(hx);
    // Thigh: hip drum, a gunmetal bone, camo armour with a proud front plate and an outer tasset.
    const thigh = slotPart(S, `thigh${k}`, `thigh-${k}`, { center: 'xz' });
    thigh.cyl([hx, hy, 0], 0.42, 1.0, 'x', P.frame);
    thigh.cyl([hx, hy, 0], 0.2, 1.4, 'x', P.dark);
    thigh.box([hx - 0.3, ky + 0.1, -0.3], [hx + 0.3, hy - 0.2, 0.3], P.frame);
    thigh.box([hx - 0.6, ky + 0.3, -0.5], [hx + 0.6, hy + 0.1, 0.5], P.camo);
    thigh.box([hx - 0.4, ky + 0.3, -0.7], [hx + 0.4, hy + 0.1, -0.5], P.plate);
    thigh.wedge([hx - 0.4, hy + 0.1, -0.7], [hx + 0.4, hy + 0.3, -0.5], P.plate, { along: 'y', slope: 'z', from: 1, to: 0.5, anchor: 1 });
    const [tx0, tx1] = out(ax + 0.6, ax + 0.8);
    thigh.box([tx0, ky + 0.5, -0.5], [tx1, hy + 0.3, 0.3], P.plate);
    thigh.skin([hx - 0.7, ky + 0.3, -0.8], [hx + 0.7, ky + 0.5, 0.6], P.frame, { where: isCamo });
    // Seam on the outer tasset, a rear piston, and the team stripe down the left thigh's front.
    thigh.skin([tx0, ky + 0.9, -0.6], [tx1, ky + 1.1, 0.4], P.dark, { normal: [side, 0, 0] });
    piston(thigh, [hx, hy - 0.3, 0.6], [hx, ky + 0.1, 0.6], 0.2, { sleeve: 0.4 });
    if (side < 0) thigh.skin([hx - 0.1, ky + 0.3, -0.9], [hx + 0.3, hy + 0.4, -0.5], P.stripe, { normal: [0, 0, -1] });
    plateEdges(thigh, [hx - 0.6, ky + 0.5, -0.5], [hx + 0.6, hy + 0.1, 0.5], { under: false, outer: side });
    parts[`thigh${k}`] = thigh;

    // Shin: knee drum and a 0.4 m proud knee guard, a 1.4 m camo shell with the accent band,
    // calf frame with piston, ankle cuff and drum.
    const shin = slotPart(S, `shin${k}`, `shin-${k}`, { center: 'xz' });
    shin.cyl([hx, ky, 0], 0.42, 1.0, 'x', P.frame);
    shin.cyl([hx, ky, 0], 0.18, 1.2, 'x', P.dark);
    shin.box([hx - 0.8, ay + 0.3, -0.7], [hx + 0.8, ky - 0.3, 0.5], P.camo);
    shin.wedge([hx - 0.8, ky - 0.3, -0.7], [hx + 0.8, ky - 0.1, 0.5], P.camo, { along: 'y', slope: 'x', from: 1, to: 0.76, anchor: 0.5 });
    shin.box([hx - 0.5, ay - 0.1, -0.5], [hx + 0.5, ay + 0.3, 0.5], P.frame);
    shin.wedge([hx - 0.8, ay + 0.1, -0.7], [hx + 0.8, ay + 0.3, 0.5], P.camo, { along: 'y', slope: 'z', from: 0.7, to: 1, anchor: 0.5 });
    // Knee guard 1.2 × 0.8, 0.4 m proud of the greave, chamfered top and bottom, a dark seam.
    shin.box([hx - 0.6, ky - 0.5, -1.1], [hx + 0.6, ky + 0.3, -0.7], P.plate);
    shin.wedge([hx - 0.6, ky + 0.3, -1.1], [hx + 0.6, ky + 0.5, -0.7], P.plate, { along: 'y', slope: 'z', from: 1, to: 0.5, anchor: 1 });
    shin.wedge([hx - 0.6, ky - 0.7, -1.1], [hx + 0.6, ky - 0.5, -0.7], P.plate, { along: 'y', slope: 'z', from: 0.5, to: 1, anchor: 1 });
    shin.skin([hx - 0.6, ky - 0.3, -1.2], [hx + 0.6, ky - 0.1, -1.0], P.dark, { normal: [0, 0, -1] });
    // Front greave groove (the accent band, y 1.2–1.6, goes on after the calf).
    shin.skin([hx - 0.1, ay + 0.3, -0.8], [hx + 0.1, 1.2, -0.6], P.dark, { normal: [0, 0, -1] });
    // Calf: exposed frame, piston and outer vents.
    shin.box([hx - 0.3, ay + 0.4, 0.5], [hx + 0.3, ky - 0.3, 0.7], P.frame);
    piston(shin, [hx, ay + 0.6, 0.6], [hx, ky - 0.1, 0.6], 0.2, { sleeve: 0.5 });
    const [vx0, vx1] = out(ax + 0.6, ax + 0.8);
    vents(shin, [vx0, 1.7, -0.5], [vx1, ky - 0.4, 0.3], [side, 0, 0], { along: 'y' });
    // The accent band wraps the calf frame too, so it reads from behind.
    shin.skin([hx - 1.0, 1.2, -0.9], [hx + 1.0, 1.6, 0.9], P.accent, { where: m => isCamo(m) || m === P.frame });
    shin.cyl([hx, ay, 0], 0.3, 0.8, 'x', P.frame);
    plateEdges(shin, [hx - 0.8, 1.6, -0.7], [hx + 0.8, ky - 0.3, 0.5], { top: false, outer: side });
    parts[`shin${k}`] = shin;

    // Foot (1.4 × 0.7 × 2.0): gunmetal sole, stepped camo layers, two broad toes, heel spur.
    const foot = slotPart(S, `foot${k}`, `foot-${k}`, { center: 'xyz' });
    const sole = ay - skel.frame.ankle[1];
    const fx = (a, b) => span(hx + side * a, hx + side * b);   // inboard a .. outboard b
    const [f0, f1] = fx(-0.7, 0.9), [g0, g1] = fx(-0.5, 0.7);
    foot.box([f0, sole, -1.3], [f1, sole + 0.2, 0.7], P.frame);
    foot.box([f0, sole + 0.2, -1.1], [f1, sole + 0.4, 0.5], P.camo);
    foot.box([g0, sole + 0.4, -0.9], [g1, sole + 0.6, 0.5], P.camo);
    foot.box([hx - 0.3, sole + 0.6, -0.5], [hx + 0.3, ay + 0.1, 0.3], P.frame);
    foot.box([hx - 0.5, sole + 0.4, 0.1], [hx + 0.5, sole + 0.8, 0.5], P.plate);
    for (const [a, b] of [[-0.7, -0.3], [-0.1, 0.3], [0.5, 0.9]]) {
      const [t0, t1] = fx(a, b);
      foot.box([t0, sole, -1.5], [t1, sole + 0.4, -1.1], P.plate);
      foot.box([t0, sole, -1.5], [t1, sole + 0.2, -1.3], P.frame);
    }
    foot.box([hx - 0.3, sole, 0.5], [hx + 0.3, sole + 0.4, 0.9], P.frame);
    foot.skin([hx - 0.8, sole + 0.4, -1.2], [hx + 0.8, sole + 0.6, 0.6], P.plate, { where: isCamo, normal: [0, 1, 0] });
    foot.skin([hx - 0.8, sole, -1.6], [hx + 0.8, sole + 0.2, 1.0], P.dark, { where: m => m === P.frame });
    parts[`foot${k}`] = foot;
  }

  // ---- pelvis: frame core, armoured belt, codpiece, hip plates; fine: the hip fuel tank -----
  const pelvis = slotPart(S, 'pelvis', 'pelvis');
  pelvis.box([-0.6, 2.8, -0.6], [0.6, 3.8, 0.6], P.frame);
  pelvis.box([-1.0, 3.4, -0.8], [1.0, 3.8, 0.8], P.camo);
  // Codpiece in the camo (art review: the beige plate read as a bare patch), dark-lipped.
  pelvis.box([-0.4, 2.8, -1.0], [0.4, 3.6, -0.8], P.camo);
  pelvis.wedge([-0.4, 2.6, -1.0], [0.4, 2.8, -0.8], P.camo, { along: 'y', slope: 'x', from: 0.5, to: 1, anchor: 0.5 });
  pelvis.box([-0.6, 3.0, 0.8], [0.6, 3.8, 1.0], P.camo);
  for (const side of [-1, 1]) bx(pelvis, [side * 1.0, 3.4, -0.6], [side * 1.4, 4.0, 0.6], P.plate);
  pelvis.skin([-1.5, 3.4, -1.1], [1.5, 3.6, 1.1], P.frame, { where: isCamo });
  pelvis.skin([-0.2, 2.8, -1.1], [0.2, 3.4, -0.9], P.dark, { normal: [0, 0, -1] });
  hipDrive(pelvis, skel, 0.5);
  parts.pelvis = [pelvis];
  const hipKit = slotFine(S, 'pelvis', 'pelvis-detail');
  {
    // The right-hip fuel canister (r 0.25, 0.8 m) in a gunmetal cradle, its hose into the back.
    const [cx, cy, cz] = [1.15, 3.6, 1.15];
    hipKit.cyl([cx, cy, cz], 0.25, 0.8, 'y', P.fuel);
    for (const y of [3.25, 3.95]) hipKit.cyl([cx, y, cz], 0.3, 0.1, 'y', P.frame);
    hipKit.box([cx - 0.05, 4.0, cz - 0.05], [cx + 0.05, 4.1, cz + 0.05], P.steel);
    hipKit.box([1.4, 3.5, 1.1], [1.5, 3.7, 1.2], P.hazard);
    hipKit.box([0.6, 3.4, 0.8], [1.0, 3.5, 1.2], P.frame);
    cable(hipKit, [[cx, 4.15, cz], [0.75, 4.15, cz], [0.75, 4.15, 0.85]], P.frame);
    bolts(hipKit, [[-0.3, 3.4, -1.1], [0.2, 3.4, -1.1], [-0.3, 2.9, -1.1], [0.2, 2.9, -1.1]], P.frame);
  }
  parts.pelvis.push(hipKit);

  // ---- torso (0.2 m): abdomen, dome, visor bezel, hatch recess, pauldrons, back plate --------
  const torso = slotPart(S, 'torso', 'torso');
  // Abdomen: a gunmetal core under armoured plates, visible between the belt and the dome.
  torso.box([-0.8, 3.8, -0.6], [0.8, 4.6, 0.6], P.frame);
  torso.box([-1.2, 4.0, -0.8], [1.2, 4.6, 0.8], P.camo);
  torso.skin([-1.3, 4.0, 0.0], [1.3, 4.2, 0.9], P.frame, { where: isCamo });
  // The dome, two-tone: camo body, a lighter crown, a gunmetal skirt round its base.
  fill(torso, [-1.8, DOME.bottom, -1.6], [1.8, DOME.top, 1.8], (x, y, z) => (dome(x, y, z) <= 1 ? (y > 6.6 ? P.plate : P.camo) : null));
  fill(torso, [-1.8, 4.4, -0.4], [1.8, 4.6, 1.8], (x, y, z) => (dome(x, y, z) <= 1 ? P.frame : null));
  torso.skin([-1.8, 4.4, -1.8], [1.8, 4.6, -0.4], P.plate, { where: isCamo });
  // Recessed seams: a ring under the crown round the back, vertical seams on the flanks and back.
  const groove = (min, max) => {
    const lo = torso.cells3(min), hi = torso.cells3(max);
    for (let i = lo[0]; i < hi[0]; i++) for (let j = lo[1]; j < hi[1]; j++) for (let k = lo[2]; k < hi[2]; k++) {
      const x = torso.cc(i, 0), y = torso.cc(j, 1), z = torso.cc(k, 2);
      if (dome(x, y, z) <= 1 && dome(x, y, z, 0.2) > 1) torso.setCell(i, j, k, null);
    }
  };
  groove([-1.8, 6.4, -0.2], [1.8, 6.6, 1.8]);
  for (const sx of [-1, 1]) {
    const [a0, a1] = span(sx * 0.8, sx * 1.0), [b0, b1] = span(sx * 1.2, sx * 1.8);
    groove([a0, 4.6, 0.6], [a1, 6.4, 1.8]);
    groove([b0, 4.6, -0.4], [b1, 6.4, -0.2]);
  }
  // Visor seat in the brow (the head part fills it).
  torso.carve([-0.8, 6.6, -1.6], [0.8, 7.2, -0.6]);
  // Heat-sink grille seat on the crown (the fine part fills it).
  torso.carve([-0.4, 7.2, 0.0], [0.4, 7.4, 0.6]);
  // Chest: a flat dark recess for the hatch between gunmetal jambs; cheek plates below the pauldrons.
  torso.carve([-0.8, 5.0, -1.8], [0.8, 6.2, -1.2]);
  torso.box([-0.8, 5.0, -1.4], [0.8, 6.2, -1.2], P.dark);
  for (const side of [-1, 1]) bx(torso, [side * 1.0, 4.6, -1.4], [side * 1.4, 5.4, -1.0], P.plate);
  // Team accent band (0.4 m) across the dome, between the pauldrons.
  torso.skin([-1.4, 5.6, -1.8], [1.4, 6.0, 1.8], P.accent, { where: isCamo });
  // Pauldrons: squared 1.2 m blocks drooping outward, two-tone over a gunmetal underside, set
  // 0.2 m lower and clear of the dome by a gunmetal shoulder yoke (art review: the crown reads
  // 0.6 m above them and the dome stays round).
  for (const side of [-1, 1]) {
    const tag = side < 0 ? 'kit-left' : 'kit-right', X = v => side * v;
    const [x0, x1] = span(X(1.8), X(3.0));
    bx(torso, [X(1.4), 5.2, -0.6], [X(1.8), 6.2, 0.8], P.frame, { tag });
    torso.box([x0, 5.2, -0.8], [x1, 6.8, 1.0], P.camo, { tag });
    torso.paint([x0, 6.2, -0.8], [x1, 6.8, 1.0], P.plate);
    // Droop: the top steps down outboard; chamfered outer edge and lower front/back edges.
    torso.carve([span(X(2.4), X(3.0))[0], 6.6, -0.8], [span(X(2.4), X(3.0))[1], 6.8, 1.0]);
    torso.carve([span(X(2.8), X(3.0))[0], 6.4, -0.8], [span(X(2.8), X(3.0))[1], 6.6, 1.0]);
    const [c0, c1] = span(X(2.0), X(3.0));
    torso.carve([c0, 5.2, -0.8], [c1, 5.4, -0.6]);
    torso.carve([c0, 5.2, 0.8], [c1, 5.4, 1.0]);
    // Gunmetal underside and the dark seam between the two tones.
    bx(torso, [X(1.8), 5.0, -0.6], [X(2.8), 5.2, 0.8], P.frame);
    torso.skin([x0, 6.0, -0.9], [x1, 6.2, 1.1], P.dark, { where: isCamo });
    plateEdges(torso, [x0, 5.2, -0.8], [x1, 6.0, 1.0], { top: false, outer: side });
  }
  // WEST/EAST stripe: a vertical band over the left pauldron (front, top, back), edged in a
  // contrasting tone (dark round the pale WEST stripe, pale round the black EAST one).
  torso.skin([-2.8, 5.2, -0.9], [-2.0, 6.8, -0.7], P.stripeRim, { normal: [0, 0, -1] });
  torso.skin([-2.8, 6.4, -0.8], [-2.0, 6.8, 1.0], P.stripeEdge, { normal: [0, 1, 0] });
  torso.skin([-2.6, 5.2, -0.9], [-2.2, 6.8, -0.7], P.stripe, { normal: [0, 0, -1] });
  torso.skin([-2.6, 6.4, -0.8], [-2.2, 6.8, 1.0], P.stripe, { normal: [0, 1, 0] });
  torso.skin([-2.6, 5.4, 0.8], [-2.2, 6.8, 1.1], P.stripe, { normal: [0, 0, 1] });
  // Back: a flat plate for the battery hatch, tank saddles, the lower-back lamp bar.
  torso.box([-0.6, 5.2, 1.0], [0.6, 6.8, 1.6], P.frame);
  for (const side of [-1, 1]) for (const y of [5.6, 6.4]) bx(torso, [side * 0.6, y, 1.2], [side * 0.8, y + 0.2, 1.6], P.frame);
  torso.box([-0.2, 4.4, 1.0], [0.2, 5.2, 1.6], P.frame);
  // The cockpit behind the chest hatch (seen while the hatch is open).
  cockpitCavity(torso, { front: -1.2, floor: 5.0, width: 1.2, height: 1.2, depth: 1.0 });
  torso.userData.priority = { 'kit-left': 45, 'kit-right': 44 };
  parts.torso = [torso];

  // ---- torso detail (0.1 m): hip vents, fuel tanks, battery hatch, roundel, bolts, lamps ----
  const fine = slotFine(S, 'torso', 'torso-detail');
  // Orange hip vents (0.4 × 0.3 grilles under two dark slats) front and back of the abdomen.
  for (const sx of [-0.7, 0.7]) for (const n of [-1, 1]) {
    const zIn = n * 0.8, zOut = n * 1.0, zMid = n * 0.9, zLip = n * 1.1;
    bx(fine, [sx - 0.3, 3.9, zIn], [sx + 0.3, 4.4, zLip], P.frame);
    fine.carve([sx - 0.2, 4.0, Math.min(zOut, zLip)], [sx + 0.2, 4.3, Math.max(zOut, zLip)]);
    bx(fine, [sx - 0.2, 4.0, zMid], [sx + 0.2, 4.3, zOut], P.opticOrange);
    bx(fine, [sx - 0.2, 4.1, zOut], [sx + 0.2, 4.2, zLip], P.dark);
  }
  // Fuel tanks (r 0.35, 1.6 m) flanking the battery hatch, in fuel red with a bright cap ring
  // (art review: taller and redder so they read from behind): straps, caps, valves.
  for (const side of [-1, 1]) {
    const tag = side < 0 ? 'kit-left' : 'kit-right';
    const cx = side * 1.05, cz = 1.55;
    fine.cyl([cx, 6.3, cz], 0.35, 1.6, 'y', P.fuel, { tag });
    for (const y of [5.75, 6.85]) fine.cyl([cx, y, cz], 0.42, 0.1, 'y', P.frame, { tag });
    fine.cyl([cx, 7.15, cz], 0.38, 0.1, 'y', P.fuelCap, { tag });
    fine.cyl([cx, 7.2, cz], 0.25, 0.2, 'y', P.frame, { tag });
    fine.cyl([cx, 5.4, cz], 0.25, 0.2, 'y', P.frame, { tag });
    fine.box([cx - 0.05, 7.3, cz - 0.05], [cx + 0.05, 7.5, cz + 0.05], P.steel, { tag });
    fine.box([cx - 0.15, 7.5, cz - 0.05], [cx + 0.15, 7.6, cz + 0.05], P.frame, { tag });
    fine.box([cx - 0.05, 6.1, cz + 0.35], [cx + 0.05, 6.4, cz + 0.45], P.dark, { tag });
    // Hoses: tank bottom into the lower back, tank top into the pauldron.
    cable(fine, [[cx, 5.25, cz], [cx, 4.95, cz], [side * 0.65, 4.95, cz], [side * 0.65, 4.95, 1.35]], P.frame);
    cable(fine, [[cx + side * 0.3, 6.65, cz], [side * 1.95, 6.65, cz], [side * 1.95, 6.65, 1.05]], P.black);
  }
  // Battery hatch between the tanks (rodeo target).
  batteryHatch(fine, [0, 6.0], 1.6);
  // Roundel on the right pauldron front: a 1.0 m disc in a 0.15 m ring.
  fine.cyl([2.4, 5.8, -0.85], 0.5, 0.1, 'z', P.ring);
  fine.roundel([2.4, 5.8, -0.9], 0.5, [0, 0, -1], { ring: 0.15, depth: 0.1 });
  for (const side of [-1, 1]) {
    const L = side < 0 ? -0.1 : 0;
    // Pauldron bolts, outer-face fins, flood lamps under the front edge.
    bolts(fine, [[side * 1.85 + L, 6.6, -0.9], [side * 2.95 + L, 6.3, -0.9], [side * 1.85 + L, 5.3, -0.9], [side * 2.95 + L, 5.3, -0.9]], P.frame);
    for (let i = 0; i < 4; i++) {
      const z = -0.5 + i * 0.3;
      bx(fine, [side * 3.0, 5.5, z], [side * 3.1, 6.1, z + 0.1], P.frame);
    }
    lamp(fine, [side * 2.35, 4.85], -0.9, -1);
    // Hatch side clamps with bolts.
    for (const y of [5.2, 5.8]) {
      bx(fine, [side * 0.7, y, -1.7], [side * 1.0, y + 0.2, -1.3], P.frame);
      bx(fine, [side * 0.8, y + 0.1, -1.8], [side * 0.9, y + 0.2, -1.7], P.dark);
    }
    // Rear lamps on the lower back.
    lamp(fine, [side * 0.85, 4.65], 1.6, 1, P.lampRed);
  }
  // Heat-sink grille on the crown behind the visor.
  fine.box([-0.4, 7.2, 0.0], [0.4, 7.3, 0.6], P.frame);
  for (let i = 0; i < 6; i++) fine.box([-0.4, 7.3, i * 0.1], [0.4, 7.4, i * 0.1 + 0.1], i % 2 ? P.frame : P.soot);
  parts.torso.push(fine);

  // ---- chest hatch (0.1 m): opens on its top hinge, blows off on eject ----------------------
  const hatch = slotFine(S, 'hatch', 'hatch');
  hatch.box([-0.7, 5.0, -1.6], [0.7, 6.2, -1.4], P.plate);
  hatch.box([-0.6, 5.1, -1.7], [0.6, 6.1, -1.6], P.camo);
  for (const sx of [-1, 1]) for (const y of [5.0, 6.1]) hatch.carve([sx < 0 ? -0.7 : 0.6, y, -1.6], [sx < 0 ? -0.6 : 0.7, y + 0.1, -1.4]);
  hatch.skin([-0.6, 5.1, -1.8], [0.6, 5.2, -1.55], P.dark, { normal: [0, 0, -1] });
  // Vision slit (0.6 × 0.1, orange) under a gunmetal brow lip, accent band, hinges, handles.
  hatch.box([-0.4, 5.3, -1.8], [0.4, 5.6, -1.7], P.frame);
  hatch.box([-0.3, 5.4, -1.8], [0.3, 5.5, -1.7], P.opticOrange);
  hatch.box([-0.4, 5.5, -1.9], [0.4, 5.6, -1.8], P.frame);
  hatch.skin([-0.8, 5.6, -1.9], [0.8, 6.0, -1.3], P.accent, { where: isCamo });
  for (const sx of [-0.45, 0.45]) hatch.box([sx - 0.15, 6.1, -1.6], [sx + 0.15, 6.3, -1.4], P.frame);
  for (const sx of [-0.35, 0.35]) hatch.box([sx - 0.05, 5.8, -1.8], [sx + 0.05, 6.0, -1.7], P.frame);
  tagAll(hatch, 'hatch', 90);
  parts.hatch = hatch;

  // ---- head: the visor housing in the dome's brow (no separate head) ------------------------
  const head = slotFine(S, 'head', 'visor');
  head.box([-0.8, 6.6, -1.3], [0.8, 7.2, -0.6], P.camo);
  // A gunmetal rim (1.4 × 0.4) round the slit, the dark recess behind the glow, a brow lip.
  head.box([-0.7, 6.7, -1.4], [0.7, 7.1, -1.3], P.frame);
  head.carve([-0.6, 6.8, -1.4], [0.6, 7.0, -1.1]);
  head.box([-0.6, 6.8, -1.1], [0.6, 7.0, -1.0], P.dark);
  head.box([-0.8, 7.1, -1.4], [0.8, 7.2, -1.3], P.plate);
  bolts(head, [[-0.8, 6.8, -1.4], [0.7, 6.8, -1.4]], P.frame);
  tagAll(head, 'head', 70);
  parts.head = head;
  // Visor slit 1.0 × 0.2: constant orange glow, flush under the brow; red in doom.
  const eye = slotFine(S, 'head', 'eye');
  eye.box([-0.5, 6.8, -1.2], [0.5, 7.0, -1.1], P.opticOrange);
  tagAll(eye, 'head', 70);
  parts.eye = eye;
  const eyeDoom = slotFine(S, 'head', 'eye-doom');
  eyeDoom.box([-0.5, 6.8, -1.2], [0.5, 7.0, -1.1], P.opticRed);
  tagAll(eyeDoom, 'head', 70);
  parts.eyeDoom = eyeDoom;

  // ---- arms -------------------------------------------------------------------------------
  for (const side of [-1, 1]) {
    const k = side < 0 ? 'L' : 'R';
    const sh = S[`shoulder${k}`], len = S.upperLen, sx = sh[0], sz = sh[2];
    const upper = slotPart(S, `upper${k}`, `upper-${k}`, { center: 'xz' });
    upper.cyl([sx, sh[1], sz], 0.4, 1.0, 'x', P.frame);
    upper.cyl([sx, sh[1], sz], 0.2, 1.2, 'x', P.dark);
    upper.box([sx - 0.3, sh[1] - len + 0.2, sz - 0.3], [sx + 0.3, sh[1] - 0.2, sz + 0.3], P.frame);
    upper.box([sx - 0.5, sh[1] - 1.3, sz - 0.5], [sx + 0.5, sh[1] - 0.5, sz + 0.5], P.camo);
    upper.skin([sx - 0.6, sh[1] - 0.7, sz - 0.6], [sx + 0.6, sh[1] - 0.5, sz + 0.6], P.frame, { where: isCamo });
    piston(upper, [sx, sh[1] - 1.3, sz + 0.6], [sx, sh[1] - len + 0.1, sz + 0.6], 0.2, { sleeve: 0.2 });
    upper.box([sx - 0.1, sh[1] - 1.5, sz + 0.5], [sx + 0.1, sh[1] - 1.3, sz + 0.7], P.frame);
    if (side < 0) tagAll(upper, 'arm', 50);
    parts[`upper${k}`] = upper;
  }
  // Left forearm (1.0 × 1.2 × 1.0) and the heat-shield plate; the hand is a big 0.8 m fist.
  {
    const e = S.elbowL, w = S.wristL, ex = e[0], ez = e[2];
    const fore = slotPart(S, 'foreL', 'fore-L', { center: 'xz' });
    fore.cyl([ex, e[1], ez], 0.3, 0.8, 'x', P.frame);
    fore.box([ex - 0.5, w[1] + 0.1, ez - 0.5], [ex + 0.5, e[1] - 0.2, ez + 0.5], P.camo);
    fore.box([ex - 0.3, w[1] + 0.3, ez - 0.7], [ex + 0.3, e[1] - 0.3, ez - 0.5], P.plate);
    fore.box([ex - 0.3, w[1] - 0.1, ez - 0.3], [ex + 0.3, w[1] + 0.1, ez + 0.3], P.frame);
    fore.skin([ex - 0.6, w[1] + 0.1, ez - 0.8], [ex + 0.6, w[1] + 0.3, ez + 0.6], P.frame, { where: isCamo });
    vents(fore, [ex + 0.3, w[1] + 0.5, ez - 0.3], [ex + 0.5, e[1] - 0.4, ez + 0.3], [1, 0, 0], { along: 'y' });
    tagAll(fore, 'arm', 50);
    // Heat shield: a 0.3 × 1.4 × 1.2 plate on the outer face with two vertical orange slots.
    const shield = slotFine(S, 'foreL', 'shield-L');
    const x0 = r1(ex - 0.8), x1 = r1(ex - 0.5), y0 = r1(w[1]), y1 = r1(y0 + 1.4), z0 = r1(ez - 0.65), z1 = r1(ez + 0.55);
    shield.box([x0, y0, z0], [x1, y1, z1], P.camo);
    shield.box([x0 + 0.1, y0 + 0.1, z0 - 0.1], [x1, y1 - 0.1, z0], P.plate);
    shield.box([x0 + 0.1, y0 - 0.1, z0 + 0.1], [x1, y0, z1 - 0.1], P.frame);
    shield.box([x0 + 0.1, y1, z0 + 0.1], [x1, y1 + 0.1, z1 - 0.1], P.frame);
    for (const dz of [0.4, 0.8]) {
      const zc = r1(z0 + dz);
      shield.box([x0 - 0.1, y0 + 0.1, zc - 0.2], [x0, y1 - 0.1, zc + 0.1], P.frame);
      shield.carve([x0 - 0.1, y0 + 0.2, zc - 0.1], [x0 + 0.1, y1 - 0.2, zc]);
      shield.box([x0, y0 + 0.2, zc - 0.1], [x0 + 0.1, y1 - 0.2, zc], P.opticOrange);
    }
    bolts(shield, [[x0 - 0.1, y0, z0], [x0 - 0.1, y1 - 0.1, z0], [x0 - 0.1, y0, z1 - 0.1], [x0 - 0.1, y1 - 0.1, z1 - 0.1]], P.frame);
    tagAll(shield, 'arm', 50);
    parts.foreL = [fore, shield];
    const hand = slotFine(S, 'handL', 'hand-L');
    const hx = r1(w[0]), hy = r1(w[1]), hz = 0;
    hand.box([hx - 0.4, hy - 0.5, hz - 0.3], [hx + 0.4, hy + 0.1, hz + 0.3], P.frame);
    hand.box([hx - 0.5, hy - 0.4, hz - 0.2], [hx - 0.4, hy, hz + 0.2], P.plate);
    hand.box([hx - 0.3, hy - 0.4, hz + 0.3], [hx + 0.3, hy, hz + 0.4], P.plate);
    hand.box([hx - 0.4, hy - 0.6, hz - 0.3], [hx + 0.4, hy - 0.5, hz + 0.3], P.dark);
    // Three thick curled fingers and a thumb.
    for (const fx of [-0.3, 0, 0.3]) {
      hand.box([hx + fx - 0.1, hy - 0.8, hz - 0.2], [hx + fx + 0.1, hy - 0.6, hz + 0.2], P.frame);
      hand.box([hx + fx - 0.1, hy - 0.8, hz - 0.3], [hx + fx + 0.1, hy - 0.6, hz - 0.2], P.dark);
    }
    hand.box([hx + 0.4, hy - 0.5, hz - 0.3], [hx + 0.5, hy - 0.2, hz + 0.1], P.dark);
    tagAll(hand, 'arm', 50);
    parts.handL = hand;
  }
  // Right forearm: rigid with the launcher, forward from the elbow on the mount pitch axis.
  {
    const e = S.elbowR, ex = e[0], ey = e[1], ez = e[2];
    const fore = slotPart(S, 'foreR', 'fore-R', { center: 'xy' });
    // In-game pass: the 1.0 m forearm block sat on the launcher axis outboard of it, so from the
    // front-right (where an enemy pilot sees a SCORCH) it and the fist over the barrel hid the
    // breech and half the barrel. The elbow drum stays on the axis; the gauntlet now hangs under
    // it (top 0.1 m below the bore line) and ends at the magazine, so the launcher's whole flank
    // and its thermite band show above the arm.
    fore.cyl([ex, ey, ez], 0.3, 0.8, 'x', P.frame);
    fore.box([ex - 0.3, ey - 1.1, -0.2], [ex + 0.5, ey - 0.1, ez - 0.1], P.camo);
    fore.box([ex - 0.1, ey - 0.3, 0.2], [ex + 0.3, ey + 0.1, ez - 0.1], P.frame);
    fore.box([ex - 0.1, ey - 0.9, -0.4], [ex + 0.3, ey - 0.3, -0.2], P.frame);
    fore.skin([ex - 0.4, ey - 1.2, -0.2], [ex + 0.6, ey, 0.0], P.frame, { where: isCamo });
    vents(fore, [ex + 0.3, ey - 0.9, 0.0], [ex + 0.5, ey - 0.3, ez - 0.3], [1, 0, 0], { along: 'z' });
    piston(fore, [ex + 0.1, ey - 1.2, ez - 0.1], [ex + 0.1, ey - 1.2, -0.2], 0.2, { sleeve: 0.4 });
    parts.foreR = fore;
    const [px, py] = S.pivot;
    const hand = slotFine(S, 'handR', 'hand-R');
    // The fist closes round a side grip under the barrel's outboard flank (z −1.2..−0.6), below
    // the bore line: knuckle armour outboard, fingers wrapping inboard under the grip, thumb over it.
    const gx = r1(px + 0.5), gy = r1(py - 0.2);
    hand.box([gx, gy - 0.6, -1.2], [gx + 0.6, gy, -0.6], P.frame);
    hand.box([gx + 0.6, gy - 0.5, -1.1], [gx + 0.7, gy - 0.1, -0.7], P.plate);
    hand.box([gx + 0.1, gy, -1.1], [gx + 0.5, gy + 0.1, -0.7], P.plate);
    for (const [i, fz] of [-1.1, -0.95, -0.8].entries()) {
      hand.box([gx - 0.2, gy - 0.5, fz], [gx, gy - 0.1, fz + 0.1], i === 1 ? P.dark : P.frame);
    }
    hand.box([gx + 0.1, gy - 0.7, -1.0], [gx + 0.5, gy - 0.6, -0.8], P.dark);
    parts.handR = hand;
  }

  // ---- T-203 thermite launcher (0.1 m) on the recoil node -----------------------------------
  {
    const [px, py, pz] = S.pivot;
    // Art review 2: a round 3.0 m barrel (0.6 m) from the breech face to the muzzle, a 0.8 m
    // muzzle shroud over its front 0.6 m, a 0.3 m thermite band two-thirds of the way from the
    // breech, and the square breech housing behind it (the muzzle stays on the server's mount).
    const muzzleZ = Math.floor((pz - S.muzzle) * 10 + 1e-6) / 10, breechZ = r1(muzzleZ + 3.0), backZ = r1(breechZ + 0.7);
    const gun = slotFine(S, 'gun', 't203', { center: 'xy' });
    const sq = (h, z0, z1, material) => gun.box([px - h, py - h, z0], [px + h, py + h, z1], material);
    const ring = (r, z0, z1, material) => gun.cyl([px, py, (z0 + z1) / 2], r, z1 - z0, 'z', material);
    // Breech housing (0.9 m square, chamfered rear) with a diagonal hazard band and a dark back plate.
    sq(0.45, breechZ, backZ, P.frame);
    sq(0.35, backZ, r1(backZ + 0.1), P.dark);
    hazardBand(gun, [px - 0.5, py - 0.5, r1(backZ - 0.2)], [px + 0.5, py + 0.5, backZ], { where: m => m === P.frame });
    // Barrel, a dark rib by the breech, the thermite band and the muzzle shroud.
    // (radii on the launcher's odd 0.1 m lattice: 0.7 m barrel and 0.9 m shroud/band octagons,
    // the nearest round sections to 0.6 and 0.8 m)
    ring(0.32, muzzleZ, breechZ, P.frame);
    ring(0.38, r1(breechZ - 0.3), r1(breechZ - 0.2), P.dark);
    ring(0.42, r1(breechZ - 2.2), r1(breechZ - 1.8), THERMITE);
    ring(0.42, muzzleZ, r1(muzzleZ + 0.6), P.frame);
    ring(0.42, r1(muzzleZ + 0.6), r1(muzzleZ + 0.7), P.dark);
    // Hot muzzle lip (in-game pass: the reference's glowing orange mouth reads at range).
    ring(0.32, muzzleZ, r1(muzzleZ + 0.1), P.opticOrange);
    // Bore: dark lining, a thermite ember glowing at its back.
    gun.carve([px - 0.25, py - 0.25, muzzleZ], [px + 0.25, py + 0.25, r1(muzzleZ + 0.4)]);
    sq(0.25, r1(muzzleZ + 0.4), r1(muzzleZ + 0.5), P.dark);
    sq(0.15, r1(muzzleZ + 0.3), r1(muzzleZ + 0.4), P.opticOrange);
    // Box magazine (0.5 × 0.7) under the barrel, its feed collar and ribs.
    gun.box([px - 0.25, py - 1.05, -0.4], [px + 0.25, py - 0.35, 0.2], P.frame);
    gun.box([px - 0.35, py - 0.45, -0.5], [px + 0.35, py - 0.35, 0.3], P.dark);
    for (const y of [py - 0.85, py - 0.65]) gun.box([px - 0.35, y, -0.3], [px + 0.35, y + 0.1, 0.1], P.dark);
    gun.box([px - 0.15, py - 0.95, -0.5], [px + 0.15, py - 0.75, -0.4], P.hazard);
    // Side grip lug under the outboard flank for the fist (in-game pass).
    gun.box([px + 0.2, r1(py - 0.6), -1.0], [r1(px + 0.5), r1(py - 0.4), -0.8], P.frame);
    // Top carry handle and a front sight post on the shroud with an orange pip.
    for (const z of [-0.4, 0.1]) gun.box([px - 0.05, py + 0.25, z], [px + 0.05, py + 0.55, z + 0.1], P.frame);
    gun.box([px - 0.05, py + 0.55, -0.4], [px + 0.05, py + 0.65, 0.2], P.dark);
    gun.box([px - 0.15, py + 0.45, r1(muzzleZ + 0.1)], [px + 0.15, py + 0.65, r1(muzzleZ + 0.3)], P.frame);
    gun.box([px - 0.05, py + 0.65, r1(muzzleZ + 0.1)], [px + 0.05, py + 0.75, r1(muzzleZ + 0.2)], P.opticOrange);
    // Fuel line along the inboard side from the breech to the band; slotted shroud vents.
    cable(gun, [[px - 0.4, py + 0.15, breechZ - 0.05], [px - 0.4, py + 0.15, r1(breechZ - 1.8) + 0.05]], P.black);
    for (const y of [py - 0.15, py + 0.05]) {
      gun.skin([px - 0.45, y, r1(muzzleZ + 0.1)], [px - 0.35, y + 0.1, r1(muzzleZ + 0.5)], P.dark, { normal: [-1, 0, 0] });
      gun.skin([px + 0.35, y, r1(muzzleZ + 0.1)], [px + 0.45, y + 0.1, r1(muzzleZ + 0.5)], P.dark, { normal: [1, 0, 0] });
    }
    bolts(gun, [[px - 0.55, py + 0.25, r1(breechZ + 0.3)], [px - 0.55, py - 0.35, r1(breechZ + 0.3)], [px + 0.45, py + 0.25, r1(breechZ + 0.3)], [px + 0.45, py - 0.35, r1(breechZ + 0.3)]], P.dark);
    tagAll(gun, 'gun', 60);
    parts.gun = gun;
  }
  return { skel, parts };
}

const KIT = Object.freeze({
  lights: [
    { kind: 'titanLamp', slot: 'torso', point: [-2.35, 4.85, -0.88] },
    { kind: 'titanLamp', slot: 'torso', point: [2.35, 4.85, -0.88] },
    { kind: 'titanTail', slot: 'torso', point: [-0.85, 4.65, 1.58], direction: [0, 0, 1] },
    { kind: 'titanTail', slot: 'torso', point: [0.85, 4.65, 1.58], direction: [0, 0, 1] },
  ],
  // Low-ready: the launcher dips at the hip (heavy, one-handed).
  // (art review 2: yaw 0.25 → 0.5 so the long side of the barrel shows, not the muzzle)
  carry: { pitch: -0.45, yaw: 0.5 },
  thrusters: [
    { slot: 'torso', point: [-0.6, 4.5, 1.45], direction: [0, -0.4, 1] },
    { slot: 'torso', point: [0.6, 4.5, 1.45], direction: [0, -0.4, 1] },
    { slot: 'torso', point: [-2.4, 5.1, 1.05], direction: [0, -0.2, 1] },
    { slot: 'torso', point: [2.4, 5.1, 1.05], direction: [0, -0.2, 1] },
  ],
  sparks: [
    { slot: 'torso', point: [1.8, 5.6, -0.6] },
    { slot: 'torso', point: [-1.0, 6.6, 1.2] },
    { slot: 'hipL', point: [-0.85, 2.3, -0.5] },
    { slot: 'hipR', point: [0.85, 2.3, -0.5] },
  ],
  poses: {
    // Idle: the shield arm hanging straight beside the thigh, the heat shield facing out, fist
    // turned in. Guard (Thermal Shield): the forearm raised in front of the chest.
    idle: { wrist: [-2.2, 3.1, -0.1], hand: 0.1, twist: -1.57 },
    guard: { wrist: [-0.3, 5.2, -2.0], hand: -1.2, twist: 0 },
  },
});

/** SCORCH titan model. Options: VehicleView's { team, material, glass, blur }. */
export function makeScorchModel(options = {}) {
  const { skel, parts } = blueprint(TYPE, buildParts);
  return assembleTitan(TYPE, options, skel, parts, KIT);
}
