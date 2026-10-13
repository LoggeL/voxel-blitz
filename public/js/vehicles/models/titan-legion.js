// LEGION (Ogre frame, 7.4 m): the heavy gunner and the only asymmetric titan
// (docs/design/titanfall/README.md "LEGION", titan-turnaround-legion.png, lineup B).
// Silhouette: bulky Ogre legs, a squarer chest than SCORCH, a low dome head with a
// 2 × 2 cluster of red optics, huge squared pauldrons, the RIGHT forearm replaced by the
// 4.0 m six-barrel Predator Cannon (spinning barrel node, two hazard bands, a gun-shield
// plate folded flat on its inboard face that swings in front of the gun for Gun Shield), and
// an ammo drum on the back right whose link belt runs over the right pauldron and down
// the upper arm into the receiver. Every part is authored in hull metres at its skeleton
// slot (titan-common.js); the cannon parts ride the mount pitch node like ION's rifle.
import { blueprint } from './common.js';
import {
  TITAN_PALETTE as P, titanSkeleton, slotPart, slotFine, assembleTitan, FinePart, hullCenter,
  jointBall, piston, vents, hazardBand, hazardCollar, bolts, batteryHatch, cable, isCamo, lamp, plateEdges, hipDrive, cockpitCavity,
} from './titan-common.js';

const TYPE = 'titan_legion';
const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const smooth = t => t * t * (3 - 2 * t);

// ---- lattice helpers ---------------------------------------------------------------------
const mod02 = value => { const r = ((value % 0.2) + 0.2) % 0.2; return Math.abs(r - 0.2) < 1e-9 || Math.abs(r) < 1e-9 ? 0 : Math.round(r * 1e9) / 1e9; };
/**
 * Re-grid a part per axis: 'c' makes the pivot a cell centre (odd widths centre on it),
 * 'e' makes it a cell edge (0.2 parts: edges at pivot + 0.2k, fine parts: pivot + 0.1k),
 * anything else keeps the hull lattice. The cannon pivot (y 4.44) is off the hull lattice,
 * so its parts share this pivot-relative lattice instead.
 */
function align(part, modes) {
  part.grid = Object.freeze(part.pivot.map((value, i) => (modes[i] === 'c' ? mod02(value - 0.1) : modes[i] === 'e' ? mod02(value) : part.grid[i])));
  return part;
}
/** Sorted [min, max] corners, so mirrored (left side) boxes can be written outboard-first. */
const box2 = (a, b) => [a.map((v, i) => Math.min(v, b[i])), a.map((v, i) => Math.max(v, b[i]))];

/**
 * Ammo belt of chunky links along axis-aligned segments (hull metres): each link is a
 * 0.2 m gunmetal block and a 0.1 m steel pin, `w` wide across `widths[i]` (the axis the
 * belt lies flat across) and `t` thick on the remaining axis.
 */
function belt(part, points, widths, { w = 0.4, t = 0.2, link = 0.3, tag = null } = {}) {
  const AX = { x: 0, y: 1, z: 2 };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const ax = [0, 1, 2].find(k => Math.abs(b[k] - a[k]) > 1e-6);
    const wa = AX[widths[i - 1]], ta = 3 - ax - wa;
    const dir = Math.sign(b[ax] - a[ax]), len = Math.abs(b[ax] - a[ax]);
    for (let s = 0; s < len - 1e-6; s += link) {
      const piece = (from, to, inset, material) => {
        const lo = [...a], hi = [...a];
        lo[wa] = a[wa] - w / 2 + inset; hi[wa] = a[wa] + w / 2 - inset;
        lo[ta] = a[ta] - t / 2; hi[ta] = a[ta] + t / 2;
        lo[ax] = a[ax] + dir * from; hi[ax] = a[ax] + dir * to;
        part.box(...box2(lo, hi), material, { tag });
      };
      piece(s, Math.min(len, s + link - 0.1), 0, P.frame);
      if (s + link <= len + 1e-6) piece(s + link - 0.1, s + link, 0.1, P.steel);
    }
  }
  return part;
}

/** Alternating link sectors round a drum rim (cells between r0 and r1 of the x-axis drum). */
function drumLinks(part, center, r0, r1, [x0, x1], sectors = 14) {
  for (const [x, y, z, material] of [...part.voxels()]) {
    const h = [hullCenter(part, x, 0), hullCenter(part, y, 1), hullCenter(part, z, 2)];
    if (h[0] < x0 || h[0] > x1) continue;
    const dy = h[1] - center[1], dz = h[2] - center[2], r = Math.hypot(dy, dz);
    if (r < r0 || r > r1 || material !== P.dark) continue;
    const sector = Math.floor((Math.atan2(dy, dz) + Math.PI) / (2 * Math.PI) * sectors);
    part.getCell(x, y, z).material = sector % 2 ? P.frame : P.steel;
  }
  return part;
}

// Gun shield: folded flat on the receiver's inboard (left) face (pivot = plate centre), deployed
// swung 90° about Y in front of the receiver with the barrels through it.
const SHIELD_REST = Object.freeze([1.25, 4.44, -0.25]);
const SHIELD_DEPLOYED = Object.freeze([1.85, 4.64, -1.35]);

function buildParts() {
  const skel = titanSkeleton(TYPE, {
    // Wide Ogre stance (turnaround: feet as wide as the pauldrons); thigh + shin = 1.045 ×
    // (hip − ankle − 0.06). The elbow sits on the cannon axis 1.4 m behind the mount pivot,
    // so the receiver runs from the elbow to the barrels and the cannon is 4.0 m overall.
    hip: [1.0, 3.2, 0], thigh: 1.15, shin: 1.4, ankle: [0, 0.7, 0], home: [1.1, 0, -0.05],
    elbowOut: 0, elbowBack: 1.4, hatchHinge: [0, 6.1, -1.2],
  });
  const S = skel;
  const parts = {};

  // ---- legs (Ogre: thick thighs, heavy knee guards, very wide stepped feet) ----------------
  for (const side of [-1, 1]) {
    const k = side < 0 ? 'L' : 'R';
    const hip = S[`hip${k}`], knee = S[`knee${k}`], ankle = S[`ankle${k}`];
    const hx = hip[0], O = v => hx + side * v;          // O: outboard offset from the hip line
    // Thigh (2.05..3.2): hip drum, gunmetal bone, a 1.0 m camo shell, front plate, outer tasset.
    const thigh = slotPart(S, `thigh${k}`, `thigh-${k}`, { center: 'x' });
    thigh.cyl([hx, hip[1], 0], 0.4, 1.0, 'x', P.frame);
    thigh.cyl([hx, hip[1], 0], 0.2, 1.4, 'x', P.dark);
    thigh.box([hx - 0.3, 2.0, -0.3], [hx + 0.3, 3.0, 0.3], P.frame);
    thigh.box([hx - 0.5, 2.4, -0.5], [hx + 0.5, 3.4, 0.5], P.camo);
    thigh.box([hx - 0.3, 2.4, -0.7], [hx + 0.3, 3.2, -0.5], P.plate);
    thigh.wedge([hx - 0.3, 3.2, -0.7], [hx + 0.3, 3.4, -0.5], P.plate, { along: 'y', slope: 'z', from: 1, to: 0.5, anchor: 1 });
    thigh.box(...box2([O(0.5), 2.6, -0.5], [O(0.7), 3.6, 0.5]), P.plate);
    thigh.skin(...box2([O(0.5), 3.0, -0.6], [O(0.8), 3.2, 0.6]), P.dark, { normal: [side, 0, 0] });
    thigh.skin([hx - 0.6, 2.4, -0.8], [hx + 0.6, 2.6, 0.6], P.frame, { where: isCamo });
    // Rear piston sleeve and a hydraulic line.
    thigh.box([hx - 0.1, 2.2, 0.5], [hx + 0.1, 3.0, 0.7], P.frame);
    cable(thigh, [[O(-0.3), 3.2, 0.6], [O(-0.3), 2.4, 0.6]], P.black);
    parts[`thigh${k}`] = thigh;

    // Shin (knee 2.05, ankle 0.65; pivot-centred lattice): knee drum, a 1.4 m camo block
    // flaring over the foot, the accent band, a knee guard 0.4 m proud, calf piston and vents.
    const shin = slotPart(S, `shin${k}`, `shin-${k}`, { center: 'xy' });
    shin.cyl([hx, knee[1], 0], 0.4, 1.0, 'x', P.frame);
    shin.cyl([hx, knee[1], 0], 0.2, 1.2, 'x', P.dark);
    shin.box([hx - 0.5, 1.75, -0.5], [hx + 0.5, 2.15, 0.5], P.frame);
    shin.box([hx - 0.7, 0.75, -0.6], [hx + 0.7, 1.75, 0.6], P.camo);
    shin.wedge([hx - 0.7, 0.55, -0.8], [hx + 0.7, 0.95, 0.8], P.camo, { along: 'y', slope: 'z', from: 1, to: 0.75, anchor: 0.5 });
    shin.skin([hx - 0.9, 0.55, -0.9], [hx + 0.9, 0.75, 0.9], P.frame, { where: isCamo });
    // Accent band all the way round.
    shin.skin([hx - 0.9, 1.15, -0.9], [hx + 0.9, 1.55, 0.9], P.accent, { where: m => isCamo(m) || m === P.frame });
    // Knee guard: a thick plate over the knee with a chamfered top and a centre groove.
    shin.box([hx - 0.5, 1.55, -1.0], [hx + 0.5, 2.35, -0.6], P.plate);
    shin.wedge([hx - 0.5, 2.35, -1.0], [hx + 0.5, 2.55, -0.6], P.plate, { along: 'y', slope: 'z', from: 1, to: 0.5, anchor: 1 });
    shin.box([hx - 0.3, 1.55, -0.6], [hx + 0.3, 1.75, -0.4], P.plate);
    shin.skin([hx - 0.1, 1.55, -1.1], [hx + 0.1, 2.35, -0.9], P.dark, { normal: [0, 0, -1] });
    shin.skin([hx - 0.6, 1.55, -1.1], [hx + 0.6, 1.75, -0.9], P.frame, { normal: [0, -1, 0] });
    // Front greave under the band and the calf: exposed frame with a piston, outer vents.
    shin.box([hx - 0.5, 0.75, -0.8], [hx + 0.5, 1.15, -0.6], P.plate);
    shin.box([hx - 0.3, 0.95, 0.6], [hx + 0.3, 1.95, 0.8], P.frame);
    piston(shin, [hx, 1.15, 0.7], [hx, 2.15, 0.7], 0.2, { sleeve: 0.4 });
    vents(shin, box2([O(0.5), 0.75, -0.4], [O(0.7), 1.15, 0.4])[0], box2([O(0.5), 0.75, -0.4], [O(0.7), 1.15, 0.4])[1], [side, 0, 0], { along: 'z' });
    vents(shin, box2([O(0.5), 1.55, -0.4], [O(0.7), 1.75, 0.4])[0], box2([O(0.5), 1.55, -0.4], [O(0.7), 1.75, 0.4])[1], [side, 0, 0], { along: 'z' });
    parts[`shin${k}`] = shin;

    // Foot: 1.6 × 0.7 × 2.0, a stepped block (gunmetal sole, camo upper, ankle socket), a toe
    // cap with a dark centre slot and a heel spur; centred 0.1 m outboard of the hip line.
    const foot = slotPart(S, `foot${k}`, `foot-${k}`, { center: 'xy' });
    const s = ankle[1] - skel.frame.ankle[1];            // -0.05, a lattice edge
    const fx = [O(-0.7), O(0.9)].sort((a, b) => a - b), ux = [O(-0.5), O(0.7)].sort((a, b) => a - b), tx = [O(-0.3), O(0.5)].sort((a, b) => a - b);
    foot.box([fx[0], s, -1.2], [fx[1], s + 0.2, 0.8], P.frame);
    foot.box([ux[0], s + 0.2, -1.0], [ux[1], s + 0.4, 0.6], P.camo);
    foot.wedge([ux[0], s + 0.4, -1.0], [ux[1], s + 0.6, 0.6], P.camo, { along: 'z', slope: 'y', from: 0.5, to: 1, anchor: 0 });
    foot.box([tx[0], s + 0.4, -0.6], [tx[1], s + 0.8, 0.4], P.frame);
    // Toe cap with a dark centre slot, heel spur and a frame lip round the sole.
    foot.box([fx[0], s, -1.4], [fx[1], s + 0.4, -1.0], P.plate);
    foot.wedge([fx[0], s + 0.2, -1.4], [fx[1], s + 0.6, -1.0], P.plate, { along: 'z', slope: 'y', from: 0.5, to: 1, anchor: 0 });
    foot.carve([O(0.1) - 0.1, s, -1.4], [O(0.1) + 0.1, s + 0.4, -1.2]);
    foot.box([O(0.1) - 0.1, s, -1.2], [O(0.1) + 0.1, s + 0.4, -1.0], P.dark);
    foot.box([tx[0], s, 0.6], [tx[1], s + 0.4, 1.0], P.frame);
    foot.skin([fx[0] - 0.1, s, -1.5], [fx[1] + 0.1, s + 0.2, 1.1], P.dark, { where: m => m === P.frame });
    parts[`foot${k}`] = foot;
  }

  // ---- pelvis (2.2 × 0.8 × 1.4, y 3.0..3.8) -----------------------------------------------------
  const pelvis = slotPart(S, 'pelvis', 'pelvis');
  pelvis.box([-0.8, 3.0, -0.6], [0.8, 3.8, 0.6], P.frame);
  pelvis.box([-1.0, 3.4, -0.8], [1.0, 3.8, 0.8], P.camo);
  pelvis.box([-0.4, 2.8, -1.0], [0.4, 3.6, -0.8], P.plate);
  pelvis.wedge([-0.4, 2.6, -1.0], [0.4, 2.8, -0.8], P.plate, { along: 'y', slope: 'x', from: 0.5, to: 1, anchor: 0.5 });
  pelvis.box([-0.6, 3.0, 0.8], [0.6, 3.8, 1.0], P.camo);
  pelvis.skin([-1.1, 3.6, -0.9], [1.1, 3.8, 0.9], P.frame, { where: isCamo });
  pelvis.skin([-0.2, 2.8, -1.1], [0.2, 3.4, -0.9], P.dark, { normal: [0, 0, -1] });
  hazardBand(pelvis, [-0.5, 2.5, -1.1], [0.5, 2.85, -0.7], { where: m => m === P.plate, period: 0.8 });
  hipDrive(pelvis, skel, 0.5);
  parts.pelvis = pelvis;

  // ---- torso (0.2 m, x-centred lattice): waist, abdomen, square chest, pauldrons, back -------
  const torso = slotPart(S, 'torso', 'torso', { center: 'x' });
  torso.box([-0.7, 3.8, -0.6], [0.7, 4.4, 0.6], P.frame);
  torso.box([-0.9, 4.0, -0.4], [0.9, 4.2, 0.4], P.dark);
  torso.box([-1.1, 4.2, -0.8], [1.1, 4.8, 0.8], P.camo);
  // Square chest, tapered under the cannon so the receiver clears it (x ≥ 1.35 below y 4.94).
  torso.prism('z', [[-1.1, 4.4], [1.1, 4.4], [1.3, 5.0], [1.5, 5.2], [1.5, 6.2], [1.3, 6.4], [-1.3, 6.4], [-1.5, 6.2], [-1.5, 5.2], [-1.3, 5.0]],
    [-1.0, 1.0], P.camo);
  // Front: cheek plates and a brow round the hatch, a gunmetal skirt with vents under it.
  for (const side of [-1, 1]) torso.box(...box2([side * 0.7, 5.0, -1.2], [side * 1.5, 6.2, -1.0]), P.plate);
  torso.box([-0.7, 6.2, -1.2], [0.7, 6.4, -1.0], P.plate);
  torso.box([-1.1, 4.4, -1.2], [1.1, 4.8, -1.0], P.plate);
  vents(torso, [-0.5, 4.4, -1.2], [0.5, 4.8, -1.0], [0, 0, -1], { along: 'x' });
  torso.box([-0.7, 4.8, -1.2], [0.7, 5.0, -1.0], P.frame);
  for (const y of [4.3, 4.6]) torso.skin([-1.1, y - 0.1, -0.9], [1.1, y + 0.1, -0.7], P.dark, { normal: [0, 0, -1] });
  // Flank vents and a side groove.
  for (const side of [-1, 1]) {
    vents(torso, ...box2([side * 1.3, 5.2, -0.6], [side * 1.6, 5.6, 0.6]), [side, 0, 0], { along: 'z' });
    torso.skin(...box2([side * 1.3, 6.0, -1.0], [side * 1.6, 6.2, 1.0]), P.dark, { normal: [side, 0, 0] });
  }
  // Pauldrons: 1.2 wide × 1.8 tall × 2.0 deep two-tone blocks standing above the chest top
  // (the head sits low between them), chamfered corners, a gunmetal socket underneath. (Art
  // review 2: outer faces pulled in 0.4 m and the tops dropped, so the upper body is ~5.2 m
  // wide over the legs, not 6 m.)
  for (const side of [-1, 1]) {
    const tag = side < 0 ? 'kit-left' : 'kit-right';
    const [lo, hi] = box2([side * 1.3, 5.2, -1.0], [side * 2.5, 7.0, 1.0]);
    torso.box(lo, hi, P.camo, { tag });
    torso.paint([lo[0], 6.4, -1.0], [hi[0], 7.0, 1.0], P.plate);
    // Underside socket on the left (the right pauldron clears the cannon's elbow housing).
    if (side < 0) torso.box([-2.3, 5.0, -0.8], [-1.5, 5.2, 0.8], P.frame);
    // Chamfers: outer top edge (not under the ammo belt), front top edge, outer vertical corners.
    torso.carve(...box2([side * 2.3, 6.8, -1.0], [side * 2.5, 7.0, side > 0 ? 0.6 : 1.0]));
    torso.carve(...box2([side * 1.3, 6.8, -1.0], [side * 2.5, 7.0, -0.8]));
    torso.carve(...box2([side * 2.3, 5.2, -1.0], [side * 2.5, 6.8, -0.8]));
    if (side < 0) torso.carve([-2.5, 5.2, 0.8], [-2.3, 6.8, 1.0]);
    torso.carve(...box2([side * 2.3, 5.2, -1.0], [side * 2.5, 5.4, 1.0]));
    // Panel grooves: front and outer face; a gunmetal rim round the lower edge.
    torso.skin(...box2([side * 1.3, 6.2, -1.1], [side * 2.5, 6.4, -0.9]), P.dark, { normal: [0, 0, -1] });
    torso.skin(...box2([side * 2.4, 6.2, -0.8], [side * 2.6, 6.4, 0.8]), P.dark, { normal: [side, 0, 0] });
    torso.skin(...box2([side * 1.3, 5.2, -1.1], [side * 2.5, 5.4, 1.1]), P.frame, { where: isCamo });
  }
  // WEST/EAST stripe over the left pauldron top (the front face carries a fine decal).
  torso.skin([-2.1, 6.8, -0.8], [-1.7, 7.0, 1.0], P.stripe, { normal: [0, 1, 0] });
  for (const side of [-1, 1]) plateEdges(torso, ...box2([side * 1.3, 5.4, -1.0], [side * 2.5, 6.2, 1.0]), { top: false, outer: side });
  // Camo abdomen plates over the waist (front), with a centre groove.
  torso.box([-0.7, 3.8, -0.9], [0.7, 4.4, -0.6], P.plate);
  torso.skin([-0.1, 3.8, -1.0], [0.1, 4.4, -0.8], P.dark, { normal: [0, 0, -1] });
  torso.skin([-0.8, 3.8, -1.0], [0.8, 4.0, -0.8], P.frame, { normal: [0, 0, -1] });
  // Team accent band (0.4 m) across the upper chest and round its flanks.
  torso.skin([-1.6, 5.8, -1.3], [1.6, 6.2, 1.2], P.accent, { where: isCamo });
  // Low collar guards round the head, a raised spine behind it.
  for (const side of [-1, 1]) torso.box(...box2([side * 0.5, 6.4, -0.6], [side * 1.3, 6.6, 0.8]), P.camo);
  torso.box([-0.5, 6.4, 0.4], [0.5, 6.8, 0.8], P.frame);
  // Back plate with the battery-hatch recess, lower frame lip and the drum bracket.
  torso.box([-1.1, 4.6, 1.0], [1.1, 6.2, 1.4], P.camo);
  torso.carve([-0.7, 4.8, 1.2], [0.7, 6.2, 1.4]);
  torso.paint([-0.7, 4.8, 1.0], [0.7, 6.2, 1.2], P.dark);
  torso.skin([-1.2, 4.6, 1.3], [1.2, 4.8, 1.5], P.frame, { normal: [0, 0, 1] });
  torso.box([1.1, 6.0, 1.0], [1.5, 6.8, 1.4], P.frame, { tag: 'kit-right' });
  torso.box([0.9, 6.2, 1.0], [1.1, 6.6, 1.6], P.frame, { tag: 'kit-right' });
  // The cockpit behind the chest hatch (seen while the hatch is open).
  cockpitCavity(torso, { front: -1.0, floor: 5.0, width: 1.4, height: 1.0, depth: 1.0 });
  torso.userData.priority = { 'kit-left': 45, 'kit-right': 44 };
  parts.torso = [torso];

  // ---- torso detail (0.1 m): pauldron vents, roundel, bolts, battery hatch, lamps, drum, belt --
  const fine = slotFine(S, 'torso', 'torso-detail');
  for (const side of [-1, 1]) {
    const [x0, x1] = side < 0 ? [-2.2, -1.6] : [1.6, 2.2];
    // Grille on the pauldron top (behind the stripe on the left): four raised slats over a dark well.
    if (side > 0) {
      fine.box([x0, 7.0, -0.6], [x1, 7.05, 0.4], P.dark);
      for (let i = 0; i < 4; i++) fine.box([x0, 7.0, -0.55 + i * 0.25], [x1, 7.1, -0.45 + i * 0.25], P.frame);
    }
    // Bolts round the pauldron front and on the cheek plates.
    const bx = v => (side < 0 ? -v - 0.1 : v);
    bolts(fine, [[bx(1.4), 6.7, -1.1], [bx(2.2), 6.7, -1.1], [bx(1.4), 5.5, -1.1]], P.frame);
    bolts(fine, [[bx(0.8), 6.0, -1.3], [bx(1.3), 6.0, -1.3], [bx(0.8), 5.1, -1.3]], P.frame);
    // Flood lamps low on the outer pauldron fronts.
    lamp(fine, [side * 2.05, 5.55], -1.2, -1);
    // Tail lamps on the back plate.
    lamp(fine, [side * 0.85, 4.75], 1.6, 1, P.lampRed);
  }
  // Team stripe decal on the right pauldron front: 0.4 m with 0.1 m edges.
  // In-game pass: the roundel moved from the drum hub (seen only from the right and behind) to the
  // LEFT pauldron front, and the stripe decal to the right one. From a pilot's eye height the
  // Predator's barrel cluster, 2.75 m ahead of the right shoulder, covers both faces of the right
  // pauldron (front and outer, tried in that order); the left pauldron front stays clear from the
  // front and both three-quarter views. RONIN uses the same left placement (art review 2).
  fine.cyl([-1.9, 6.1, -1.05], 0.45, 0.1, 'z', P.ring);
  fine.roundel([-1.9, 6.1, -1.1], 0.35, [0, 0, -1], { ring: 0.1, depth: 0.1 });
  fine.box([1.6, 5.4, -1.1], [2.2, 6.8, -1.0], P.stripeRim);
  fine.box([1.7, 5.4, -1.1], [2.1, 6.8, -1.0], P.stripe);
  // Battery hatch between the shoulder blades (rodeo target).
  batteryHatch(fine, [0, 5.5], 1.2, { width: 1.2, height: 1.4 });
  // Sensor mast on the left collar.
  fine.box([-1.0, 6.6, 0.5], [-0.9, 7.4, 0.6], P.frame);
  fine.box([-1.05, 7.3, 0.45], [-0.85, 7.4, 0.65], P.dark);
  // Ammo drum on the back right (r 0.7, 0.6 wide): dark rim with link sectors, camo hub
  // caps, gunmetal axle; the belt leaves the drum top and runs over the right pauldron.
  {
    const tag = 'kit-right', c = [1.5, 6.7, 1.7];
    fine.cyl(c, 0.7, 0.6, 'x', P.dark, { tag });
    drumLinks(fine, c, 0.5, 0.75, [1.2, 1.8]);
    fine.cyl(c, 0.45, 0.8, 'x', P.camo, { tag });
    fine.cyl(c, 0.28, 0.8, 'x', P.plate, { tag });
    fine.cyl(c, 0.12, 1.0, 'x', P.frame, { tag });
    // Drum hub cap: a hazard ring round a gunmetal boss (the roundel moved to the pauldron front).
    fine.cyl([1.95, c[1], c[2]], 0.45, 0.1, 'x', P.hazard, { tag });
    fine.cyl([2.0, c[1], c[2]], 0.25, 0.1, 'x', P.frame, { tag });
    belt(fine, [[1.5, 7.1, 1.7], [1.5, 7.1, 0.8], [2.6, 7.1, 0.8], [2.6, 5.2, 0.8]], ['x', 'z', 'z'], { tag });
    fine.userData.priority = { ...fine.userData.priority, 'kit-right': 44 };
  }
  parts.torso.push(fine);

  // ---- chest hatch (0.1 m): its own part, opens on the top hinge and blows off on eject ---------
  const hatch = slotFine(S, 'hatch', 'hatch');
  {
    const tag = 'hatch';
    hatch.box([-0.7, 4.9, -1.3], [0.7, 6.1, -1.0], P.plate, { tag });
    hatch.box([-0.6, 5.0, -1.4], [0.6, 6.0, -1.3], P.plate, { tag });
    for (const x of [-0.7, 0.6]) for (const y of [4.9, 6.0]) hatch.carve([x, y, -1.4], [x + 0.1, y + 0.1, -1.0]);
    hatch.skin([-0.6, 5.0, -1.45], [0.6, 5.1, -1.25], P.dark, { normal: [0, 0, -1] });
    // Vision slit: gunmetal brow lip over a green screen slot, 0.1 m proud.
    hatch.box([-0.45, 5.4, -1.5], [0.45, 5.7, -1.4], P.frame, { tag });
    hatch.box([-0.35, 5.5, -1.5], [0.35, 5.6, -1.4], P.screen, { tag });
    // Accent band across the hatch top, hinge knuckles, grab handles, bolts.
    hatch.skin([-0.8, 5.8, -1.5], [0.8, 6.2, -1.0], P.accent, { where: isCamo });
    for (const x of [-0.5, 0.5]) hatch.box([x - 0.15, 6.0, -1.3], [x + 0.15, 6.2, -1.1], P.frame, { tag });
    for (const x of [-0.45, 0.45]) hatch.box([x - 0.05, 5.05, -1.5], [x + 0.05, 5.35, -1.4], P.frame, { tag });
    bolts(hatch, [[-0.6, 4.95, -1.4], [0.5, 4.95, -1.4], [-0.6, 5.85, -1.5], [0.5, 5.85, -1.5]], P.frame);
    for (const [, voxel] of hatch.cells) voxel.tag = tag;
    hatch.userData.priority = { hatch: 90 };
  }
  parts.hatch = hatch;

  // ---- head (0.1 m): a low armoured dome, visor brim, 2 × 2 red optic cluster ----------------
  const head = slotFine(S, 'head', 'head');
  {
    const tag = 'head';
    head.box([-0.3, 6.3, -0.3], [0.3, 6.5, 0.4], P.frame, { tag });
    head.box([-0.5, 6.4, -0.6], [0.5, 7.0, 0.3], P.camo, { tag });
    head.box([-0.4, 7.0, -0.5], [0.4, 7.1, 0.2], P.camo, { tag });
    head.box([-0.3, 7.1, -0.4], [0.3, 7.2, 0.1], P.plate, { tag });
    head.box([-0.1, 7.2, -0.2], [0.1, 7.3, 0.0], P.frame, { tag });
    for (const x of [-0.5, 0.4]) head.carve([x, 6.9, -0.6], [x + 0.1, 7.0, 0.3]);
    // Visor brim over the optics, chin guard.
    head.box([-0.5, 7.0, -0.8], [0.5, 7.1, -0.5], P.plate, { tag });
    head.box([-0.4, 6.3, -0.7], [0.4, 6.4, -0.4], P.plate, { tag });
    // Face: gunmetal rim, recessed dark cross, four optic sockets (filled by eye / eyeDoom).
    head.box([-0.4, 6.4, -0.7], [0.4, 7.0, -0.6], P.frame, { tag });
    head.carve([-0.3, 6.5, -0.7], [0.3, 7.0, -0.6]);
    head.paint([-0.3, 6.5, -0.6], [0.3, 7.0, -0.5], P.dark);
    // Ear blocks with vents, rear frame.
    for (const side of [-1, 1]) {
      head.box(...box2([side * 0.5, 6.5, -0.4], [side * 0.6, 6.9, 0.2]), P.frame, { tag });
      vents(head, ...box2([side * 0.5, 6.5, -0.4], [side * 0.6, 6.9, 0.2]), [side, 0, 0], { along: 'z', pitch: 0.2 });
    }
    head.box([-0.4, 6.5, 0.3], [0.4, 6.9, 0.4], P.frame, { tag });
    for (const [, voxel] of head.cells) voxel.tag = tag;
    head.userData.priority = { head: 70 };
  }
  parts.head = head;
  const OPTICS = [[-0.3, 6.5], [0.1, 6.5], [-0.3, 6.8], [0.1, 6.8]];
  const eye = slotFine(S, 'head', 'eye');
  for (const [x, y] of OPTICS) eye.box([x, y, -0.7], [x + 0.2, y + 0.2, -0.6], P.lampRed, { tag: 'head' });
  eye.userData.priority = { head: 70 };
  parts.eye = eye;
  // Doom: two optics dead, two still lit.
  const eyeDoom = slotFine(S, 'head', 'eye-doom');
  OPTICS.forEach(([x, y], i) => eyeDoom.box([x, y, -0.7], [x + 0.2, y + 0.2, -0.6], i === 0 || i === 3 ? P.lampRed : P.soot, { tag: 'head' }));
  eyeDoom.userData.priority = { head: 70 };
  parts.eyeDoom = eyeDoom;

  // ---- arms ---------------------------------------------------------------------------------------
  // Upper arms hang straight down from the shoulder in the authored pose; the rig aims them.
  for (const side of [-1, 1]) {
    const k = side < 0 ? 'L' : 'R';
    const sh = S[`shoulder${k}`], len = S.upperLen, sx = sh[0], sz = sh[2];
    const tagArm = side < 0 ? 'arm' : null;
    const upper = slotPart(S, `upper${k}`, `upper-${k}`, { center: 'xz' });
    upper.cyl([sx, sh[1], sz], 0.4, 1.0, 'x', P.frame, { tag: tagArm });
    upper.box([sx - 0.3, sh[1] - len + 0.2, sz - 0.3], [sx + 0.3, sh[1] - 0.2, sz + 0.3], P.frame, { tag: tagArm });
    const bicep = side < 0 ? 1.3 : 1.1;
    upper.box([sx - 0.5, sh[1] - bicep, sz - 0.5], [sx + 0.5, sh[1] - 0.5, sz + 0.5], P.camo, { tag: tagArm });
    upper.box([sx - 0.3, sh[1] - bicep + 0.1, sz - 0.7], [sx + 0.3, sh[1] - 0.6, sz - 0.5], P.plate, { tag: tagArm });
    upper.skin([sx - 0.6, sh[1] - 0.7, sz - 0.6], [sx + 0.6, sh[1] - 0.5, sz + 0.6], P.frame, { where: isCamo });
    piston(upper, [sx, sh[1] - bicep, sz + 0.6], [sx, sh[1] - len + 0.1, sz + 0.6], 0.2, { sleeve: 0.2, tag: tagArm });
    for (const [, voxel] of upper.cells) voxel.tag = tagArm;
    if (tagArm) upper.userData.priority = { arm: 50 };
    parts[`upper${k}`] = upper;
  }
  // Right upper arm: the ammo belt drops off the pauldron and runs down the outer back of
  // the arm into the receiver's feed chute.
  {
    const sh = S.shoulderR, sx = sh[0];
    const feed = slotFine(S, 'upperR', 'upper-R-belt');
    belt(feed, [[sx + 0.5, sh[1] - 0.9, 0.6], [sx + 0.5, sh[1] - S.upperLen + 0.3, 0.6]], ['z']);
    parts.upperR = [parts.upperR, feed];
  }
  // Left forearm (heavy, 1.0 × 1.2 × 1.0) and big fist hang down (rig: two-bone IK).
  {
    const e = S.elbowL, w = S.wristL, ex = e[0], ez = e[2];
    const fore = slotPart(S, 'foreL', 'fore-L', { center: 'xz' });
    fore.cyl([ex, e[1], ez], 0.35, 1.0, 'x', P.frame, { tag: 'arm' });
    fore.box([ex - 0.5, 3.0, ez - 0.5], [ex + 0.5, 4.2, ez + 0.5], P.camo, { tag: 'arm' });
    fore.box([ex - 0.7, 3.2, ez - 0.3], [ex - 0.5, 4.0, ez + 0.3], P.plate, { tag: 'arm' });
    fore.box([ex - 0.3, 3.2, ez - 0.7], [ex + 0.3, 4.0, ez - 0.5], P.plate, { tag: 'arm' });
    fore.box([ex - 0.3, w[1] - 0.1, ez - 0.3], [ex + 0.3, 3.0, ez + 0.3], P.frame, { tag: 'arm' });
    fore.skin([ex - 0.6, 3.0, ez - 0.6], [ex + 0.6, 3.2, ez + 0.6], P.frame, { where: isCamo });
    fore.skin([ex - 0.8, 3.6, ez - 0.4], [ex - 0.6, 3.8, ez + 0.4], P.dark, { normal: [-1, 0, 0] });
    vents(fore, [ex + 0.3, 3.4, ez - 0.3], [ex + 0.5, 4.0, ez + 0.3], [1, 0, 0], { along: 'y' });
    for (const [, voxel] of fore.cells) voxel.tag = 'arm';
    fore.userData.priority = { arm: 50 };
    parts.foreL = fore;
    const hand = slotFine(S, 'handL', 'hand-L');
    const hx = w[0], hy = w[1], hz = w[2];
    hand.box([hx - 0.3, hy - 0.5, hz - 0.3], [hx + 0.3, hy + 0.1, hz + 0.3], P.frame, { tag: 'arm' });
    hand.box([hx - 0.4, hy - 0.45, hz - 0.25], [hx - 0.3, hy - 0.05, hz + 0.25], P.plate, { tag: 'arm' });
    hand.box([hx - 0.25, hy - 0.45, hz + 0.3], [hx + 0.25, hy - 0.05, hz + 0.4], P.plate, { tag: 'arm' });
    // Four thick fingers curled toward the palm, a thumb.
    for (const [i, fx] of [-0.3, -0.15, 0, 0.15].entries()) {
      hand.box([hx + fx, hy - 0.9, hz - 0.2], [hx + fx + 0.1, hy - 0.5, hz + 0.2], i % 2 ? P.dark : P.frame, { tag: 'arm' });
      hand.box([hx + fx, hy - 1.0, hz - 0.3], [hx + fx + 0.1, hy - 0.9, hz + 0.1], P.frame, { tag: 'arm' });
    }
    hand.box([hx + 0.3, hy - 0.45, hz - 0.25], [hx + 0.4, hy - 0.15, hz + 0.05], P.dark, { tag: 'arm' });
    hand.box([hx + 0.3, hy - 0.6, hz - 0.3], [hx + 0.4, hy - 0.45, hz - 0.1], P.frame, { tag: 'arm' });
    hand.userData.priority = { arm: 50 };
    parts.handL = hand;
  }

  // ---- Predator Cannon: the right forearm (elbow 1.05 → muzzle -2.75, 4.0 m with the motor cap) ----
  const [cx, cy, pz] = S.pivot, muzzleZ = pz - S.muzzle;
  // Receiver (0.2 m, lattice centred on the cannon axis): 1.0 × 1.0 × 1.4 camo block, rear
  // motor cap, belly ammo box, top armour, elbow housing the upper arm plugs into, feed chute.
  {
    const fore = align(slotPart(S, 'foreR', 'fore-R'), ['c', 'c', 'e']);
    fore.box([cx - 0.5, cy - 0.5, -0.85], [cx + 0.5, cy + 0.5, 1.05], P.camo);
    fore.box([cx - 0.3, cy - 0.3, 1.05], [cx + 0.3, cy + 0.3, 1.25], P.frame);
    fore.box([cx - 0.3, cy - 0.7, -0.65], [cx + 0.3, cy - 0.5, 0.75], P.frame);
    fore.box([cx - 0.3, cy + 0.5, -0.85], [cx + 0.3, cy + 0.7, 0.15], P.plate);
    fore.box([cx - 0.3, cy + 0.5, 0.15], [cx + 0.1, cy + 0.7, 1.05], P.frame);
    fore.box([cx + 0.1, cy + 0.5, 0.15], [cx + 0.5, cy + 0.7, 0.55], P.frame);
    fore.skin([cx - 0.6, cy - 0.6, 0.15], [cx + 0.6, cy + 0.6, 0.35], P.frame, { where: isCamo });
    fore.skin([cx - 0.6, cy - 0.6, 0.75], [cx + 0.6, cy + 0.6, 0.95], P.frame, { where: isCamo });
    fore.skin([cx - 0.6, cy - 0.1, -0.85], [cx - 0.4, cy + 0.1, 0.15], P.dark, { normal: [-1, 0, 0] });
    fore.skin([cx - 0.6, cy - 0.6, -0.85], [cx + 0.6, cy - 0.4, -0.65], P.frame, { where: isCamo });
    vents(fore, [cx - 0.3, cy - 0.8, -0.65], [cx + 0.3, cy - 0.6, 0.75], [0, -1, 0], { along: 'z' });
    parts.foreR = fore;
  }
  // Fine detail on the recoil node: rear barrel collar with hazard band 1, motor, sight block.
  {
    const gun = align(slotFine(S, 'gun', 'predator'), ['e', 'e', 'e']);
    const g = 'gun';
    // Rear barrel collar at the receiver: a solid 0.3 m hazard ring with four clean diagonals.
    gun.cyl([cx, cy, -1.0], 0.75, 0.3, 'z', P.dark, { tag: g });
    hazardCollar(gun, [cx, cy], -1.2, -0.8, { outer: 0.8, stripes: 4, where: m => m === P.dark });
    gun.cyl([cx, cy, -0.8], 0.6, 0.1, 'z', P.frame, { tag: g });
    gun.cyl([cx, cy, 1.3], 0.25, 0.1, 'z', P.dark, { tag: g });
    gun.cyl([cx, cy, 1.3], 0.1, 0.1, 'z', P.steel, { tag: g });
    // Sight block on the top armour with a red sensor lens, a handle rail along the top.
    gun.box([cx - 0.15, cy + 0.7, -0.85], [cx + 0.15, cy + 0.9, -0.45], P.frame, { tag: g });
    gun.box([cx - 0.05, cy + 0.75, -0.9], [cx + 0.05, cy + 0.85, -0.85], P.opticRed, { tag: g });
    gun.box([cx - 0.25, cy + 0.7, -0.35], [cx - 0.15, cy + 0.8, 0.05], P.frame, { tag: g });
    gun.box([cx - 0.25, cy + 0.8, -0.35], [cx - 0.15, cy + 0.9, -0.25], P.frame, { tag: g });
    gun.box([cx - 0.25, cy + 0.8, -0.05], [cx - 0.15, cy + 0.9, 0.05], P.frame, { tag: g });
    // Bolts on the inner face, a dark feed mouth on the chute.
    bolts(gun, [[cx - 0.6, cy + 0.3, -0.75], [cx - 0.6, cy + 0.3, 0.35], [cx - 0.6, cy - 0.4, -0.75], [cx - 0.6, cy - 0.4, 0.35]], P.frame);
    gun.box([cx + 0.15, cy + 0.7, 0.25], [cx + 0.45, cy + 0.75, 0.45], P.black, { tag: g });
    gun.userData.priority = { gun: 60 };
    parts.gun = gun;
  }
  // Barrels (spin node, axis through the pivot): spindle, mid clamp, six 0.3 m barrels on a
  // ring of r 0.5 (art review: thicker, fewer gaps), 0.2 m black bores inside 0.1 m steel lips,
  // and the muzzle clamp with hazard band 2 (0.3 m diagonal stripes that show the spin).
  const barrels = align(slotFine(S, 'gun', 'barrels'), ['c', 'c', 'e']);
  {
    const g = 'gun';
    barrels.cyl([cx, cy, -1.8], 0.25, 1.8, 'z', P.frame, { tag: g });
    barrels.cyl([cx, cy, -1.6], 0.75, 0.3, 'z', P.frame, { tag: g });
    // Muzzle collar 0.5 m behind the muzzle: a solid hazard ring with three diagonals (shows the spin).
    barrels.cyl([cx, cy, -2.2], 0.75, 0.3, 'z', P.dark, { tag: g });
    hazardCollar(barrels, [cx, cy], -2.4, -2.0, { outer: 0.8, stripes: 3, where: m => m === P.dark });
    const RING = [[0.5, 0], [-0.5, 0], [0.25, 0.45], [-0.25, 0.45], [0.25, -0.45], [-0.25, -0.45]];
    for (const [ox, oy] of RING) {
      const bx = cx + ox, by = cy + oy;
      barrels.cyl([bx, by, -1.8], 0.16, 1.9, 'z', P.gun, { tag: g });
      barrels.paint([bx - 0.2, by - 0.2, muzzleZ], [bx + 0.2, by + 0.2, muzzleZ + 0.3], P.steel, { where: m => m === P.gun });
      barrels.carve([bx - 0.1, by - 0.1, muzzleZ], [bx + 0.1, by + 0.1, muzzleZ + 0.1]);
      barrels.box([bx - 0.1, by - 0.1, muzzleZ + 0.1], [bx + 0.1, by + 0.1, muzzleZ + 0.3], P.black, { tag: g });
    }
    barrels.userData.priority = { gun: 60 };
  }
  // Gun shield (folded): 1.2 × 1.6 camo plate flat on the receiver's inboard (left) face, frame
  // rim, hazard edge (0.3 m stripes).
  const shield = align(new FinePart(`${TYPE}-gun-shield`, SHIELD_REST), ['e', 'e', 'e']);
  {
    const g = 'gun';
    shield.box([1.15, 3.84, -1.05], [1.35, 5.04, 0.55], P.camo, { tag: g });
    shield.box([1.05, 3.84, -1.05], [1.15, 3.94, 0.55], P.frame, { tag: g });
    shield.box([1.05, 4.94, -1.05], [1.15, 5.04, 0.55], P.frame, { tag: g });
    shield.box([1.05, 3.84, 0.45], [1.15, 5.04, 0.55], P.frame, { tag: g });
    hazardBand(shield, [1.0, 3.8, -1.1], [1.4, 5.1, -0.66], { where: isCamo, drop: "x" });
    // Vision slit and a row of bolts.
    shield.box([1.1, 4.54, -0.55], [1.15, 4.64, 0.05], P.frame, { tag: g });
    shield.box([1.1, 4.64, -0.45], [1.15, 4.74, -0.05], P.dark, { tag: g });
    bolts(shield, [[1.05, 4.14, -0.65], [1.05, 4.14, -0.15], [1.05, 4.14, 0.25]], P.frame);
    for (const [, voxel] of shield.cells) voxel.tag = g;
    shield.userData.priority = { gun: 60 };
  }
  // No right hand: the cannon replaces the forearm.
  parts.handR = [];
  const extras = [
    { name: 'barrels', parent: 'gun', pivot: [...S.pivot], parts: barrels },
    { name: 'shield', parent: 'gun', pivot: [...SHIELD_REST], parts: shield },
  ];
  return { skel, parts, extras };
}

const KIT_BASE = Object.freeze({
  lights: [
    { kind: 'titanLamp', slot: 'torso', point: [-2.05, 5.55, -1.18] },
    { kind: 'titanLamp', slot: 'torso', point: [2.05, 5.55, -1.18] },
    { kind: 'titanTail', slot: 'torso', point: [-0.85, 4.75, 1.58], direction: [0, 0, 1] },
    { kind: 'titanTail', slot: 'torso', point: [0.85, 4.75, 1.58], direction: [0, 0, 1] },
  ],
  // Low-ready (art review 2): the 4 m Predator angled ~25° down along the right side, its long side
  // turned to the front, the barrels pointing at the ground ~4 m ahead.
  carry: { pitch: -0.45, yaw: -0.22, roll: 0.15 },
  thrusters: [
    { slot: 'torso', point: [-0.7, 4.7, 1.5], direction: [0, -0.4, 1] },
    { slot: 'torso', point: [0.7, 4.7, 1.5], direction: [0, -0.4, 1] },
    { slot: 'pelvis', point: [-0.5, 3.1, 1.0], direction: [0, -0.6, 1] },
    { slot: 'pelvis', point: [0.5, 3.1, 1.0], direction: [0, -0.6, 1] },
  ],
  sparks: [
    { slot: 'torso', point: [1.6, 5.6, -0.6] },
    { slot: 'torso', point: [-1.6, 5.8, 0.2] },
    { slot: 'torso', point: [1.5, 7.0, 1.4] },
    { slot: 'hipL', point: [-1.0, 2.05, -0.6] },
  ],
  poses: {
    // Idle: the heavy left fist hangs beside the thigh, palm in. Gun Shield is the cannon plate,
    // so the left arm keeps its idle pose (no guard pose).
    idle: { wrist: [-2.35, 3.05, -0.3], hand: 0.15, twist: -1.57 },
    guard: null,
  },
});

/** Predator spin (rad/s at full spin-up) and its spin-up / spin-down time constants. */
const SPIN = Object.freeze({ rate: 26, up: 0.25, down: 0.9, kick: 0.004 });

/**
 * LEGION titan model. Options: VehicleView's { team, material, glass, blur }. Beyond the
 * shared rig it animates the barrel spin (mount row charge100 = spin-up, or recoil kicks)
 * and the gun shield (folded ↔ deployed with the rig's defensive `guard` ramp).
 */
export function makeLegionModel(options = {}) {
  const { skel, parts, extras } = blueprint(TYPE, buildParts);
  const model = assembleTitan(TYPE, options, skel, parts, { ...KIT_BASE, extras });
  const { barrels, shield, recoil } = model.nodes;
  const rest = shield.position.clone();
  const offset = SHIELD_DEPLOYED.map((value, i) => value - SHIELD_REST[i]);
  const restZ = recoil.position.z;
  const base = model.animate;
  let rate = 0, angle = 0;
  model.spin = () => rate / SPIN.rate;
  model.animate = (dt, state = {}) => {
    base(dt, state);
    const step = clamp(finite(dt), 0, 0.25), rig = model.rig;
    const mount = Array.isArray(state.mounts) && Array.isArray(state.mounts[0]) ? state.mounts[0] : null;
    const charge = clamp(finite(mount?.[5]) / 100, 0, 1);
    const firing = recoil.position.z - restZ > SPIN.kick ? 1 : 0;
    const target = state.wreck ? 0 : Math.max(charge, firing) * SPIN.rate;
    rate += (target - rate) * (1 - Math.exp(-step / (target > rate ? SPIN.up : SPIN.down)));
    angle = (angle + rate * step) % (2 * Math.PI);
    barrels.rotation.z = angle;
    const g = state.wreck ? 0 : smooth(clamp(rig.guard, 0, 1));
    shield.position.set(rest.x + offset[0] * g, rest.y + offset[1] * g, rest.z + offset[2] * g);
    // Inboard plate: swings the other way round, so its rim ends up facing forward.
    shield.rotation.y = -g * Math.PI / 2;
  };
  return model;
}
