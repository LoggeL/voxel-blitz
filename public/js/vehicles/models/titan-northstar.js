// NORTHSTAR (Stryder frame, 7.6 m): the long-range flyer of the titan models
// (docs/design/titanfall/README.md "NORTHSTAR", titan-turnaround-northstar.png, lineup B).
// Silhouette: tall stick legs with a forward knee, a back-swept shin and a
// raised hock over long three-toed feet, a narrow chest over a slim waist, a
// small wedge head with a cyan visor, two tall hover pods on the back, a 3 x 3
// cluster-missile pod on the right pauldron, thruster pods on both calves and
// the 5 m Plasma Railgun with its cyan rail and box scope, carried long and low.
// Every part is authored in hull metres at its skeleton slot (titan-common.js).
import { blueprint } from './common.js';
import {
  TITAN_PALETTE as P, titanSkeleton, slotPart, slotFine, assembleTitan,
  piston, vents, hazardBand, bolts, batteryHatch, cable, isCamo, lamp, plateEdges, hipDrive, cockpitCavity,
} from './titan-common.js';

const TYPE = 'titan_northstar';
const camoOrFrame = m => isCamo(m) || m === P.frame;
const snap = (value, step = 0.1) => Math.round(value / step) * step;

function buildParts() {
  // The right elbow sits 1.3 m behind the mount pivot, so the hand grips the
  // receiver and the whole rail and barrel stay in view ahead of it.
  // Proportions (art review): long legs (hips at 4.4 m, thigh 1.8 / shin 1.95), a 1.6 m pelvis,
  // a 1.2 m waist and a chest ~0.85 of the Stryder default.
  // Digitigrade legs (art review 2): the hock 1.2 m up and 0.55 m behind the ground contact, so
  // the side view shows the forward knee and the reverse-bent hock of the turnaround.
  const S = titanSkeleton(TYPE, { elbowBack: 1.3, neck: [0, 6.6, -0.1], hatchHinge: [0, 6.1, -0.8],
    hip: [0.6, 4.4, 0], thigh: 1.8, shin: 1.6, waist: [0, 5.0, 0], ankle: [0, 1.2, 0.55], home: [0.65, 0, -0.3] });
  const parts = {};

  // ---- legs (art review 2): long digitigrade legs. Thigh forward to the knee, a slim shin (a
  //      0.6 m front plate on a gunmetal strut) swept back to a raised hock 1.2 m up and 0.55 m
  //      behind the ground contact, a 1.3 m rear-swept metatarsal down to a three-toed foot. ----
  for (const side of [-1, 1]) {
    const k = side < 0 ? 'L' : 'R';
    const hip = S[`hip${k}`], knee = S[`knee${k}`], ankle = S[`ankle${k}`];
    const hx = hip[0];
    // Ordered x range at offsets from the leg axis (positive = outboard).
    const R = (a, b) => { const p = hx + side * a, q = hx + side * b; return [Math.min(p, q), Math.max(p, q)]; };
    const B = (part, [a, b], y0, y1, z0, z1, material, options) => part.box([R(a, b)[0], y0, z0], [R(a, b)[1], y1, z1], material, options);

    // Thigh: hip drum, gunmetal core, a slim camo shell with a proud front plate and an outer plate.
    const thigh = slotPart(S, `thigh${k}`, `thigh-${k}`);
    const hy = hip[1], ky = knee[1];
    thigh.cyl([hx, hy, 0], 0.32, 0.6, 'x', P.frame);
    thigh.cyl([hx, hy, 0], 0.16, 0.8, 'x', P.dark);
    B(thigh, [-0.1, 0.1], ky + 0.05, hy - 0.2, -0.2, 0.2, P.frame);
    B(thigh, [-0.3, 0.3], ky + 0.3, hy - 0.2, -0.4, 0.4, P.camo);
    B(thigh, [-0.1, 0.1], hy - 0.2, hy, -0.4, 0.2, P.camo);
    // Front plate 0.2 proud, tapering over the hip.
    B(thigh, [-0.3, 0.3], ky + 0.4, hy - 0.2, -0.6, -0.4, P.plate);
    thigh.wedge([R(-0.3, 0.3)[0], hy - 0.2, -0.6], [R(-0.3, 0.3)[1], hy, -0.4], P.plate, { along: 'y', slope: 'x', from: 1, to: 0.34, anchor: 0.5 });
    // Outer plate and two horizontal panel grooves.
    B(thigh, [0.3, 0.5], hy - 0.8, hy, -0.4, 0.2, P.plate);
    thigh.skin([R(0.3, 0.6)[0], hy - 0.6, -0.5], [R(0.3, 0.6)[1], hy - 0.4, 0.3], P.dark, { normal: [side, 0, 0] });
    for (const y of [ky + 0.7, ky + 1.2]) thigh.skin([R(-0.4, 0.4)[0], y, -0.8], [R(-0.4, 0.4)[1], y + 0.2, -0.6], P.dark, { normal: [0, 0, -1] });
    plateEdges(thigh, [R(-0.3, 0.3)[0], ky + 0.3, -0.6], [R(-0.3, 0.3)[1], hy - 0.2, 0.4], { top: false, outer: side });
    // Knee cuff and the rear hamstring piston.
    thigh.skin([R(-0.4, 0.6)[0], ky + 0.3, -0.7], [R(-0.4, 0.6)[1], ky + 0.5, 0.5], P.frame, { where: isCamo });
    piston(thigh, [hx, hy - 0.3, 0.5], [hx, ky + 0.2, 0.5], 0.2, { sleeve: 0.4 });
    cable(thigh, [[R(0.3, 0.3)[0] + side * 0.1, hy - 0.2, 0.3], [R(0.3, 0.3)[0] + side * 0.1, ky + 0.3, 0.3]], P.black);
    parts[`thigh${k}`] = thigh;

    // Shin: knee drum and cap, a 0.4 m gunmetal strut with the achilles piston behind it and a
    // 0.8 × 1.4 m camo front plate (0.2 m team band), a small calf thruster behind, hock drum.
    const shin = slotPart(S, `shin${k}`, `shin-${k}`);
    const ay = ankle[1], top = ky - 0.3;
    shin.cyl([hx, ky, 0], 0.3, 0.6, 'x', P.frame);
    shin.cyl([hx, ky, 0], 0.14, 0.8, 'x', P.dark);
    B(shin, [-0.3, 0.3], ky - 0.4, ky + 0.2, -0.6, -0.4, P.plate);
    shin.skin([R(-0.1, 0.1)[0], ky - 0.4, -0.7], [R(-0.1, 0.1)[1], ky + 0.2, -0.5], P.frame, { normal: [0, 0, -1] });
    // Strut (gunmetal) from knee to hock, piston behind it.
    B(shin, [-0.2, 0.2], ay + 0.2, ky - 0.2, -0.2, 0.2, P.frame);
    piston(shin, [hx, top, 0.3], [hx, ay + 0.3, 0.3], 0.2, { sleeve: 0.5 });
    // Front plate: 0.8 wide, 1.4 tall, 0.2 proud of the strut, with a groove and the team band.
    const p0 = top - 1.4;
    B(shin, [-0.4, 0.4], p0, top, -0.4, -0.2, P.camo);
    B(shin, [-0.2, 0.2], p0 + 0.2, top - 0.2, -0.6, -0.4, P.plate);
    shin.skin([R(-0.1, 0.1)[0], p0 + 0.2, -0.7], [R(-0.1, 0.1)[1], p0 + 0.6, -0.5], P.dark, { normal: [0, 0, -1] });
    shin.skin([R(-0.5, 0.5)[0], p0 + 0.8, -0.7], [R(-0.5, 0.5)[1], p0 + 1.0, 0.0], P.accent, { where: isCamo });
    plateEdges(shin, [R(-0.4, 0.4)[0], p0, -0.4], [R(-0.4, 0.4)[1], top, -0.2], { top: true, under: true });
    // Calf thruster pod behind the strut: frame box, cyan nozzle facing down and back.
    B(shin, [-0.2, 0.2], p0 + 0.2, p0 + 0.8, 0.4, 0.8, P.camo);
    B(shin, [-0.2, 0.2], p0, p0 + 0.2, 0.4, 0.8, P.opticCyan);
    B(shin, [-0.2, 0.2], p0 + 0.8, p0 + 1.0, 0.4, 0.8, P.frame);
    vents(shin, [R(0.2, 0.3)[0], p0 + 0.3, 0.4], [R(0.2, 0.3)[1], p0 + 0.7, 0.8], [side, 0, 0], { along: 'y', pitch: 0.4 });
    // Hock fork plates and the hock drum.
    B(shin, [0.2, 0.4], ay - 0.2, ay + 0.4, -0.2, 0.2, P.frame);
    B(shin, [-0.4, -0.2], ay - 0.2, ay + 0.4, -0.2, 0.2, P.frame);
    shin.cyl([hx, ay, 0], 0.24, 0.8, 'x', P.frame);
    shin.cyl([hx, ay, 0], 0.12, 1.0, 'x', P.dark);
    parts[`shin${k}`] = shin;

    // Foot, at the hock pivot: the hock is 1.2 m over the ground contact and 0.55 m behind it.
    // A 0.4 m metatarsal sweeps down and forward from the hock to the ball, three toes (the middle
    // one long and pointed), a rear claw and a gunmetal sole.
    const foot = slotPart(S, `foot${k}`, `foot-${k}`, { center: 'y' });
    const sole = Math.round((ay - S.frame.ankle[1]) * 100) / 100, cz = -S.frame.ankle[2];
    const meta = [[0.25, ay + 0.15], [-0.15, ay + 0.15], [cz - 0.45, sole + 0.35], [cz - 0.05, sole + 0.35]];
    foot.prism('x', meta, R(-0.2, 0.2), P.camo);
    foot.prism('x', meta.map(([z, y]) => [z + 0.2, y]), R(-0.1, 0.1), P.frame);
    // Ball of the foot, instep plate, sole.
    B(foot, [-0.4, 0.4], sole, sole + 0.2, cz - 0.6, cz + 0.4, P.frame);
    B(foot, [-0.4, 0.4], sole + 0.2, sole + 0.5, cz - 0.6, cz + 0.2, P.camo);
    B(foot, [-0.2, 0.2], sole + 0.5, sole + 0.7, cz - 0.4, cz + 0.2, P.plate);
    // Middle toe, long and pointed, with a gunmetal claw; outer and inner toes.
    foot.wedge([R(-0.2, 0.2)[0], sole, cz - 1.4], [R(-0.2, 0.2)[1], sole + 0.4, cz - 0.6], P.camo, { along: 'z', slope: 'y', from: 0.5, to: 1, anchor: 0 });
    B(foot, [-0.1, 0.1], sole, sole + 0.2, cz - 1.6, cz - 1.4, P.frame);
    for (const o of [[0.2, 0.5], [-0.5, -0.2]]) {
      B(foot, o, sole, sole + 0.3, cz - 1.1, cz - 0.6, P.plate);
      B(foot, o, sole, sole + 0.2, cz - 1.3, cz - 1.1, P.frame);
    }
    // Rear claw under the hock.
    B(foot, [-0.1, 0.1], sole, sole + 0.2, cz + 0.4, cz + 0.8, P.frame);
    foot.skin([R(-0.6, 0.6)[0], sole, cz - 1.8], [R(-0.6, 0.6)[1], sole + 0.2, cz + 1.0], P.dark, { where: m => m === P.frame });
    parts[`foot${k}`] = foot;
  }

  // ---- pelvis --------------------------------------------------------------------------
  // A 1.6 m pelvis at the raised hips.
  const pelvis = slotPart(S, 'pelvis', 'pelvis');
  pelvis.box([-0.4, 4.0, -0.4], [0.4, 4.8, 0.4], P.frame);
  pelvis.box([-0.8, 4.4, -0.6], [0.8, 4.8, 0.6], P.camo);
  // Codpiece plate with a pointed bottom.
  pelvis.box([-0.2, 4.0, -0.8], [0.2, 4.6, -0.6], P.camo);
  pelvis.wedge([-0.2, 3.6, -0.8], [0.2, 4.0, -0.6], P.camo, { along: 'y', slope: 'x', from: 0.5, to: 1, anchor: 0.5 });
  pelvis.skin([-0.3, 4.2, -0.9], [0.3, 4.4, -0.7], P.dark, { normal: [0, 0, -1] });
  // Hip tassets over the thigh tops and a rear plate.
  for (const side of [-1, 1]) pelvis.box([side * 0.8, 4.4, -0.4], [side * 1.0, 4.8, 0.4], P.plate);
  pelvis.box([-0.4, 4.2, 0.6], [0.4, 4.8, 0.8], P.camo);
  pelvis.skin([-1.2, 4.4, -0.9], [1.2, 4.6, 0.9], P.frame, { where: isCamo });
  hipDrive(pelvis, S, 0.4);
  parts.pelvis = pelvis;

  // ---- torso (0.2 m): waist, abdomen, tapered chest, pauldrons, collar, back plate, hover pods ----
  const torso = slotPart(S, 'torso', 'torso');
  // A 1.2 m waist (gunmetal core, dark ring, camo band) between the pelvis and the chest.
  torso.box([-0.4, 4.8, -0.4], [0.4, 5.2, 0.4], P.frame);
  torso.box([-0.6, 4.8, -0.2], [0.6, 5.0, 0.2], P.dark);
  torso.box([-0.6, 5.0, -0.6], [0.6, 5.2, 0.6], P.camo);
  torso.box([-0.6, 5.0, -1.0], [0.6, 5.2, -0.8], P.frame);
  // Chest: narrow at the waist, 1.6 m wide from y 5.4 (0.85 of the Stryder default).
  torso.prism('z', [[-0.6, 5.0], [0.6, 5.0], [0.8, 5.4], [0.8, 6.4], [-0.8, 6.4], [-0.8, 5.4]], [-0.8, 0.6], P.camo);
  // Front frame round the hatch: cheek plates (chamfered at the bottom), brow, dark recess.
  for (const side of [-1, 1]) {
    torso.box([side * 0.6, 5.2, -1.0], [side * 0.8, 6.4, -0.8], P.plate);
    torso.carve([side * 0.6, 5.2, -1.0], [side * 0.8, 5.4, -0.8]);
  }
  torso.box([-0.6, 6.2, -1.0], [0.6, 6.4, -0.8], P.plate);
  torso.paint([-0.6, 5.0, -0.8], [0.6, 6.2, -0.6], P.dark);
  // Chest flank vents and side groove.
  for (const side of [-1, 1]) {
    const [a, b] = side > 0 ? [0.6, 1.0] : [-1.0, -0.6];
    vents(torso, [a, 5.6, -0.6], [b, 6.2, 0.4], [side, 0, 0], { along: 'z' });
    torso.skin([a, 5.4, -0.8], [b, 5.6, 0.6], P.frame, { normal: [side, 0, 0] });
  }
  // Pauldrons: camo shell, plate top, chamfered outer edge, gunmetal under-rim, proud front plate.
  for (const side of [-1, 1]) {
    const [x0, x1] = side > 0 ? [0.8, 1.8] : [-1.8, -0.8];
    const [f0, f1] = side > 0 ? [1.0, 1.6] : [-1.6, -1.0];
    torso.box([x0, 5.8, -0.6], [x1, 6.8, 0.6], P.camo);
    torso.paint([x0, 6.6, -0.6], [x1, 6.8, 0.6], P.plate);
    torso.carve([side > 0 ? 1.6 : -1.8, 6.6, -0.6], [side > 0 ? 1.8 : -1.6, 6.8, 0.6]);
    torso.carve([x0, 6.6, -0.6], [x1, 6.8, -0.4]);
    torso.box([f0, 5.6, -0.4], [f1, 5.8, 0.4], P.frame);
    torso.box([f0, 6.0, -0.8], [f1, 6.6, -0.6], P.plate);
    torso.skin([x0, 5.8, -0.7], [x1, 6.0, 0.7], P.frame, { where: isCamo, normal: [0, 0, -1] });
    torso.skin([side > 0 ? 1.6 : -2.0, 6.2, -0.6], [side > 0 ? 2.0 : -1.6, 6.4, 0.6], P.dark, { normal: [side, 0, 0] });
  }
  // WEST/EAST stripe: a vertical band down the left pauldron front and over its top, edged in
  // a contrasting tone.
  // (art review 2: one plain 0.4 m stripe, thin edges as a fine decal on the front face)
  torso.skin([-1.6, 6.4, -0.6], [-1.2, 6.8, 0.6], P.stripe, { normal: [0, 1, 0] });
  for (const side of [-1, 1]) plateEdges(torso, [side > 0 ? 0.8 : -1.8, 5.8, -0.6], [side > 0 ? 1.8 : -0.8, 6.6, 0.6], { top: false, outer: side });
  // Team accent: a 0.2 m U-band on the lower chest edge (art review 2: the full-width band read as
  // a glowing mouth), rising up both cheek plates; the hatch carries its bottom.
  for (const side of [-1, 1]) torso.skin([side > 0 ? 0.6 : -0.8, 5.4, -1.1], [side > 0 ? 0.8 : -0.6, 6.0, -0.9], P.accent, { normal: [0, 0, -1] });
  // Collar guards beside the head and a spine block behind it.
  for (const side of [-1, 1]) torso.box([side * 0.4, 6.4, -0.2], [side * 0.8, 6.6, 0.4], P.camo);
  torso.box([-0.4, 6.4, 0.2], [0.4, 6.6, 0.6], P.frame);
  // Back plate with the battery recess and lamp sill.
  torso.box([-0.8, 5.0, 0.6], [0.8, 6.4, 0.8], P.camo);
  torso.carve([-0.6, 5.2, 0.6], [0.6, 6.2, 0.8]);
  torso.paint([-0.6, 5.2, 0.4], [0.6, 6.2, 0.6], P.dark);
  torso.skin([-0.8, 5.0, 0.7], [0.8, 5.2, 0.9], P.frame, { normal: [0, 0, 1] });
  // Hover pods flanking the battery hatch (the back kit that blows off): two tall fins whose tops
  // (7.9 m) show past the shoulders from the front (art review 2).
  for (const side of [-1, 1]) {
    const tag = side < 0 ? 'kit-left' : 'kit-right';
    const [x0, x1] = side > 0 ? [0.6, 1.2] : [-1.2, -0.6];
    torso.box([x0, 5.2, 0.8], [x1, 7.4, 1.4], P.camo, { tag });
    torso.box([x0, 7.4, 0.8], [x1, 7.6, 1.4], P.frame, { tag });
    torso.wedge([x0, 7.6, 0.6], [x1, 8.0, 1.4], P.camo, { along: 'z', slope: 'y', from: 0.5, to: 1, anchor: 0, tag });
    torso.box([x0, 5.0, 0.8], [x1, 5.2, 1.4], P.frame, { tag });
    // Outer armour panel, back groove and mounting straps.
    torso.box([side > 0 ? 1.2 : -1.4, 5.6, 0.8], [side > 0 ? 1.4 : -1.2, 7.2, 1.2], P.plate, { tag });
    torso.skin([side > 0 ? 0.8 : -1.0, 5.6, 1.3], [side > 0 ? 1.0 : -0.8, 7.2, 1.5], P.dark, { normal: [0, 0, 1] });
    for (const y of [5.8, 7.0]) torso.skin([x0, y, 0.7], [x1, y + 0.2, 1.5], P.frame, { where: isCamo });
    torso.skin([x0, 7.6, 0.5], [x1, 8.0, 1.5], P.plate, { normal: [0, 1, 0], where: isCamo });
  }
  // The cockpit behind the chest hatch (seen while the hatch is open).
  cockpitCavity(torso, { front: -0.8, floor: 5.2, width: 1.2, height: 1.0, depth: 0.8 });
  torso.userData.priority = { 'kit-left': 45, 'kit-right': 44 };
  parts.torso = [torso];

  // ---- torso detail (0.1 m): missile pod, roundel, nozzles, battery hatch, lamps, bolts ------
  const fine = slotFine(S, 'torso', 'torso-detail');
  // Cluster-missile pod on the right pauldron: camo box, gunmetal face with 3 x 3 tube mouths.
  {
    const tag = 'kit-right';
    fine.box([0.8, 6.7, -0.5], [1.8, 7.7, 0.3], P.camo, { tag });
    fine.paint([0.8, 6.7, -0.5], [1.8, 7.7, -0.4], P.frame);
    fine.box([0.9, 7.7, -0.4], [1.7, 7.8, 0.2], P.plate, { tag });
    for (const x of [0.9, 1.2, 1.5]) for (const y of [6.8, 7.1, 7.4]) {
      fine.carve([x, y, -0.5], [x + 0.2, y + 0.2, -0.3]);
      fine.paint([x, y, -0.3], [x + 0.2, y + 0.2, -0.2], P.black);
    }
    // Side bands, a hazard flash, rear cap, a ready lamp and the mounting yoke.
    fine.skin([0.7, 6.7, -0.1], [1.9, 7.8, 0.0], P.frame, { where: isCamo });
    fine.box([1.8, 7.3, -0.3], [1.9, 7.6, -0.1], P.hazard, { tag });
    hazardBand(fine, [1.75, 7.25, -0.35], [1.95, 7.65, -0.05], { where: m => m === P.hazard });
    fine.box([0.9, 6.8, 0.3], [1.7, 7.6, 0.4], P.frame, { tag });
    fine.box([1.6, 7.6, 0.4], [1.7, 7.7, 0.5], P.opticCyan, { tag });
    fine.box([1.1, 6.6, -0.3], [1.5, 6.7, 0.2], P.frame, { tag });
  }
  // Roundel on the right pauldron's OUTER face (art review 2: one placement per titan so the
  // silhouettes separate): a 0.7 m disc in a 0.1 m ring, inset from the plate edges.
  fine.cyl([1.85, 6.2, 0.0], 0.45, 0.1, 'x', P.ring);
  fine.roundel([1.9, 6.2, 0.0], 0.35, [1, 0, 0], { ring: 0.1, depth: 0.1 });
  // Team stripe decal on the left pauldron front: 0.4 m with 0.1 m edges.
  fine.box([-1.7, 5.8, -0.7], [-1.1, 6.8, -0.6], P.stripeRim);
  fine.box([-1.6, 5.8, -0.7], [-1.2, 6.8, -0.6], P.stripe);
  // Flood lamps under the pauldron fronts.
  for (const side of [-1, 1]) lamp(fine, [side * 1.25, 5.45], -0.8, -1);
  // Hover-pod nozzles (cyan, the dash and hover emitters) under each pod, and a cyan
  // running light near each fin tip.
  for (const side of [-1, 1]) {
    const tag = side < 0 ? 'kit-left' : 'kit-right';
    const [x0, x1] = side > 0 ? [0.7, 1.1] : [-1.1, -0.7];
    fine.box([x0, 4.8, 0.9], [x1, 5.0, 1.3], P.opticCyan, { tag });
    fine.box([x0 - 0.1, 4.9, 0.8], [x1 + 0.1, 5.0, 0.9], P.frame, { tag });
    fine.box([x0 + 0.1, 7.1, 1.4], [x1 - 0.1, 7.3, 1.5], P.opticCyan, { tag });
  }
  // Battery hatch between the pods (rodeo target).
  batteryHatch(fine, [0, 5.6], 0.6);
  // Tail lamps on the back sill.
  for (const side of [-1, 1]) lamp(fine, [side * 0.45, 5.05], 1.0, 1, P.lampRed);
  // Bolts on the cheek plates and pauldron plates, an antenna on the left collar.
  for (const side of [-1, 1]) {
    const b = v => (side > 0 ? v : -v - 0.1);
    bolts(fine, [[b(0.7), 5.5, -1.1], ...(side < 0 ? [[b(1.0), 6.5, -0.9], [b(1.5), 6.5, -0.9], [b(1.0), 6.0, -0.9], [b(1.5), 6.0, -0.9]] : [])], P.frame);
    cable(fine, [[side * 0.55, 7.0, 0.85], [side * 0.55, 6.5, 0.85]], P.black);
  }
  fine.box([-0.7, 6.6, 0.3], [-0.6, 7.6, 0.4], P.frame);
  fine.box([-0.75, 7.6, 0.25], [-0.55, 7.7, 0.45], P.dark);
  fine.userData.priority = { ...fine.userData.priority, 'kit-left': 45, 'kit-right': 44 };
  parts.torso.push(fine);

  // ---- chest hatch (0.1 m): its own part, opens on the hinge and blows off on eject ---------
  const hatch = slotFine(S, 'hatch', 'hatch');
  {
    const tag = 'hatch';
    hatch.box([-0.6, 5.0, -1.0], [0.6, 6.1, -0.8], P.plate, { tag });
    hatch.box([-0.5, 5.1, -1.1], [0.5, 6.0, -1.0], P.plate, { tag });
    for (const x of [-0.6, 0.5]) for (const y of [5.0, 6.0]) hatch.carve([x, y, -1.0], [x + 0.1, y + 0.1, -0.8]);
    hatch.skin([-0.5, 5.1, -1.15], [0.5, 5.2, -0.95], P.dark, { normal: [0, 0, -1] });
    hatch.skin([-0.1, 5.4, -1.15], [0.0, 5.7, -0.95], P.dark, { normal: [0, 0, -1] });
    // Vision slit: gunmetal brow lip over a cyan slot, 0.1 m proud.
    hatch.box([-0.4, 5.6, -1.2], [0.4, 5.9, -1.1], P.frame, { tag });
    hatch.box([-0.3, 5.7, -1.2], [0.3, 5.8, -1.1], P.opticCyan, { tag });
    // Accent band across the hatch, hinge knuckles at the top, corner bolts.
    hatch.skin([-0.7, 5.1, -1.2], [0.7, 5.3, -0.8], P.accent, { where: isCamo });
    for (const x of [-0.5, 0.3]) hatch.box([x, 6.0, -1.0], [x + 0.2, 6.2, -0.8], P.frame, { tag });
    bolts(hatch, [[-0.5, 5.9, -1.2], [0.4, 5.9, -1.2], [-0.5, 5.4, -1.2], [0.4, 5.4, -1.2]], P.frame);
    for (const [, voxel] of hatch.cells) voxel.tag = tag;
    hatch.userData.priority = { hatch: 90 };
  }
  parts.hatch = hatch;

  // ---- head (0.1 m, centred), pushed forward of the chest: wedge with a long nose, cyan visor slit wrapping the sides ----
  const head = slotFine(S, 'head', 'head', { center: 'x' });
  {
    const tag = 'head';
    head.box([-0.25, 6.4, -0.7], [0.25, 6.7, -0.1], P.frame, { tag });
    head.box([-0.45, 6.7, -0.4], [0.45, 7.3, 0.2], P.camo, { tag });
    head.wedge([-0.45, 6.7, -1.2], [0.45, 7.3, -0.4], P.camo, { along: 'z', slope: 'y', from: 0.5, to: 1, anchor: 0, tag });
    // Visor slot (the eye part fills it), brow lip above it, chin below.
    head.carve([-0.45, 6.8, -1.2], [0.45, 6.9, -0.8]);
    head.box([-0.45, 6.9, -1.3], [0.45, 7.0, -1.0], P.frame, { tag });
    head.box([-0.35, 6.6, -1.1], [0.35, 6.7, -0.5], P.frame, { tag });
    head.box([-0.25, 6.7, -1.3], [0.25, 6.8, -1.1], P.frame, { tag });
    // Crest ridge along the top, two ear fins at the back, cheek plates with vents.
    head.box([-0.05, 7.3, -0.6], [0.05, 7.4, 0.2], P.plate, { tag });
    head.box([-0.05, 7.1, -1.0], [0.05, 7.2, -0.6], P.plate, { tag });
    for (const side of [-1, 1]) {
      const [a, b] = side > 0 ? [0.25, 0.45] : [-0.45, -0.25];
      head.box([a, 7.3, -0.2], [b, 7.6, 0.1], P.plate, { tag });
      head.box([a, 7.3, 0.1], [b, 7.5, 0.2], P.frame, { tag });
      head.box([side > 0 ? 0.45 : -0.55, 6.8, -0.6], [side > 0 ? 0.55 : -0.45, 7.2, 0.1], P.frame, { tag });
      vents(head, [side > 0 ? 0.45 : -0.55, 6.85, -0.55], [side > 0 ? 0.55 : -0.45, 7.15, 0.05], [side, 0, 0], { along: 'z', pitch: 0.2 });
    }
    head.box([-0.35, 6.8, 0.2], [0.35, 7.2, 0.3], P.frame, { tag });
    head.box([0.25, 7.5, 0.1], [0.35, 7.9, 0.2], P.frame, { tag });
    head.skin([-0.45, 7.2, -1.2], [0.45, 7.4, 0.2], P.plate, { normal: [0, 1, 0], where: isCamo });
    for (const [, voxel] of head.cells) voxel.tag = tag;
    head.userData.priority = { head: 70 };
  }
  parts.head = head;
  const visor = (part, material) => {
    part.box([-0.45, 6.8, -1.2], [0.45, 6.9, -1.1], material, { tag: 'head' });
    for (const x of [-0.45, 0.35]) part.box([x, 6.8, -1.1], [x + 0.1, 6.9, -0.8], material, { tag: 'head' });
    part.userData.priority = { head: 70 };
    return part;
  };
  parts.eye = visor(slotFine(S, 'head', 'eye', { center: 'x' }), P.opticCyan);
  parts.eyeDoom = visor(slotFine(S, 'head', 'eye-doom', { center: 'x' }), P.opticRed);

  // ---- arms -----------------------------------------------------------------------------
  // Upper arms hang straight down from the shoulder in the authored pose; the rig aims them.
  for (const side of [-1, 1]) {
    const k = side < 0 ? 'L' : 'R';
    const sh = S[`shoulder${k}`], len = S.upperLen, sx = sh[0], sz = sh[2];
    const tag = side < 0 ? 'arm' : null;
    const upper = slotPart(S, `upper${k}`, `upper-${k}`, { center: 'xz' });
    upper.cyl([sx, sh[1], sz], 0.3, 0.6, 'x', P.frame, { tag });
    upper.box([sx - 0.1, sh[1] - len + 0.2, sz - 0.1], [sx + 0.1, sh[1] - 0.2, sz + 0.1], P.frame, { tag });
    upper.box([sx - 0.3, 5.0, sz - 0.3], [sx + 0.3, 5.8, sz + 0.3], P.camo, { tag });
    upper.box([sx - 0.3, 5.2, sz - 0.5], [sx + 0.3, 5.6, sz - 0.3], P.plate, { tag });
    upper.skin([sx - 0.4, 5.6, sz - 0.6], [sx + 0.4, 5.8, sz + 0.4], P.frame, { where: isCamo });
    upper.skin([sx - 0.4, 5.0, sz - 0.6], [sx + 0.4, 5.2, sz + 0.4], P.dark, { where: isCamo });
    piston(upper, [sx, 5.0, sz + 0.4], [sx, sh[1] - len + 0.1, sz + 0.4], 0.2, { sleeve: 0.3, tag });
    upper.box([sx - 0.1, 4.8, sz + 0.3], [sx + 0.1, 5.0, sz + 0.5], P.frame, { tag });
    for (const [, voxel] of upper.cells) voxel.tag = tag;
    if (tag) upper.userData.priority = { arm: 50 };
    parts[`upper${k}`] = upper;
  }
  // Left forearm and hand hang down in the authored pose (rig: two-bone IK). The forearm
  // carries the tether-trap launcher on its outer face.
  {
    const e = S.elbowL, w = S.wristL, ex = e[0], ez = e[2];
    const tag = 'arm';
    const fore = slotPart(S, 'foreL', 'fore-L', { center: 'xz' });
    fore.cyl([ex, e[1], ez], 0.26, 0.6, 'x', P.frame, { tag });
    fore.box([ex - 0.3, 3.2, ez - 0.3], [ex + 0.3, 4.0, ez + 0.3], P.camo, { tag });
    fore.box([ex - 0.1, 4.0, ez - 0.1], [ex + 0.1, e[1], ez + 0.1], P.frame, { tag });
    fore.box([ex - 0.3, 3.2, ez - 0.5], [ex + 0.3, 3.8, ez - 0.3], P.plate, { tag });
    fore.box([ex - 0.3, w[1] - 0.1, ez - 0.3], [ex + 0.3, 3.2, ez + 0.3], P.frame, { tag });
    fore.skin([ex - 0.4, 3.8, ez - 0.6], [ex + 0.4, 4.0, ez + 0.4], P.frame, { where: isCamo });
    vents(fore, [ex - 0.3, 3.3, ez + 0.3], [ex + 0.3, 3.9, ez + 0.4], [0, 0, 1], { along: 'y', pitch: 0.4 });
    // Tether launcher: gunmetal box, dark muzzle, cyan charge cell.
    fore.box([ex - 0.5, 3.2, ez - 0.3], [ex - 0.3, 3.8, ez + 0.1], P.frame, { tag });
    fore.box([ex - 0.5, 3.2, ez - 0.5], [ex - 0.3, 3.4, ez - 0.3], P.dark, { tag });
    fore.box([ex - 0.5, 3.6, ez - 0.5], [ex - 0.3, 3.8, ez - 0.3], P.opticCyan, { tag });
    for (const [, voxel] of fore.cells) voxel.tag = tag;
    fore.userData.priority = { arm: 50 };
    parts.foreL = fore;
    const hand = slotFine(S, 'handL', 'hand-L');
    const hx = w[0], hy = w[1], hz = w[2];
    hand.box([hx - 0.25, hy - 0.45, hz - 0.25], [hx + 0.25, hy + 0.05, hz + 0.25], P.frame, { tag });
    hand.box([hx - 0.35, hy - 0.4, hz - 0.2], [hx - 0.25, hy - 0.05, hz + 0.2], P.plate, { tag });
    hand.box([hx - 0.25, hy - 0.4, hz + 0.25], [hx + 0.25, hy - 0.05, hz + 0.35], P.plate, { tag });
    for (const fx of [-0.15, 0.05, 0.25]) {
      hand.box([hx + fx - 0.1, hy - 0.8, hz - 0.15], [hx + fx, hy - 0.45, hz + 0.1], P.dark, { tag });
      hand.box([hx + fx - 0.1, hy - 0.9, hz - 0.25], [hx + fx, hy - 0.8, hz], P.frame, { tag });
    }
    hand.box([hx + 0.25, hy - 0.4, hz - 0.2], [hx + 0.35, hy - 0.15, hz + 0.05], P.dark, { tag });
    hand.userData.priority = { arm: 50 };
    parts.handL = hand;
  }
  // Right forearm: rigid with the railgun, pointing forward from the elbow on the pitch axis.
  {
    const e = S.elbowR, ex = e[0], ey = e[1], ez = e[2], wz = S.wristR[2];
    const fore = slotPart(S, 'foreR', 'fore-R', { center: 'xy' });
    fore.cyl([ex, ey, ez], 0.28, 0.6, 'x', P.frame);
    fore.box([ex - 0.3, ey - 0.3, wz + 0.05], [ex + 0.3, ey + 0.3, ez - 0.15], P.camo);
    fore.box([ex - 0.1, ey + 0.3, wz + 0.05], [ex + 0.3, ey + 0.5, ez - 0.35], P.plate);
    fore.box([ex - 0.3, ey - 0.3, wz - 0.15], [ex + 0.3, ey + 0.3, wz + 0.05], P.frame);
    fore.box([ex - 0.1, ey - 0.1, ez + 0.15], [ex + 0.3, ey + 0.3, ez + 0.35], P.plate);
    fore.skin([ex - 0.4, ey - 0.4, ez - 0.55], [ex + 0.4, ey + 0.6, ez - 0.15], P.frame, { where: isCamo });
    vents(fore, [ex + 0.3, ey - 0.3, wz + 0.05], [ex + 0.5, ey + 0.1, ez - 0.55], [1, 0, 0], { along: 'z', pitch: 0.4 });
    piston(fore, [ex, ey - 0.4, ez - 0.15], [ex, ey - 0.4, wz + 0.05], 0.2, { sleeve: 0.4 });
    parts.foreR = fore;
    const hand = slotFine(S, 'handR', 'hand-R');
    // Knuckle block outboard of the receiver, fingers wrapping under it, thumb over the top.
    hand.box([1.7, 4.2, -0.7], [2.1, 4.9, -0.2], P.frame);
    hand.box([2.1, 4.3, -0.6], [2.2, 4.8, -0.3], P.plate);
    for (const [i, z] of [-0.7, -0.55, -0.4].entries()) hand.box([1.2, 4.1, z], [1.7, 4.2, z + 0.1], i === 1 ? P.dark : P.frame);
    hand.box([1.3, 4.9, -0.7], [1.7, 5.0, -0.6], P.dark);
    hand.box([1.7, 4.1, -0.7], [2.0, 4.2, -0.3], P.frame);
    parts.handR = hand;
  }

  // ---- Plasma Railgun (0.1 m) on the recoil node: shroud, split rail with the cyan core,
  //      receiver, box scope, capacitor fins and a skeletal stock; 5 m from muzzle to butt ---
  {
    const [px, py, pz] = S.pivot, muzzleZ = pz - S.muzzle;
    const cx = Math.floor(px * 10) / 10 + 0.05, cy = Math.floor(py * 10) / 10 + 0.05;
    const mz = Math.floor(muzzleZ * 10) / 10;             // muzzle face (0.05 m past the server muzzle)
    const rf = snap(pz - 0.35), rb = snap(pz + 1.25), butt = snap(mz + 5.1);
    const X = (a, b) => [cx + a, cx + b], tag = 'gun';
    const gun = slotFine(S, 'gun', 'railgun');
    const G = ([x0, x1], y0, y1, z0, z1, material) => gun.box([x0, cy + y0, z0], [x1, cy + y1, z1], material, { tag });
    // Square muzzle shroud with a glowing bore and side ports.
    G(X(-0.35, 0.35), -0.35, 0.35, mz, mz + 0.4, P.frame);
    gun.carve([cx - 0.15, cy - 0.15, mz], [cx + 0.15, cy + 0.15, mz + 0.2]);
    G(X(-0.15, 0.15), -0.15, 0.15, mz + 0.2, mz + 0.3, P.opticCyan);
    for (const sx of [-1, 1]) gun.carve([sx > 0 ? cx + 0.25 : cx - 0.35, cy - 0.15, mz + 0.1], [sx > 0 ? cx + 0.35 : cx - 0.25, cy + 0.15, mz + 0.3]);
    G(X(-0.35, 0.35), -0.35, -0.25, mz, mz + 0.4, P.dark);
    // Split rail: lower and upper rails (0.5 wide) round a recessed cyan core, 3.4 m long.
    const r0 = mz + 0.4;
    G(X(-0.25, 0.25), -0.25, -0.05, r0, rf, P.frame);
    G(X(-0.25, 0.25), 0.15, 0.25, r0, rf, P.frame);
    G(X(-0.15, 0.15), 0.25, 0.35, r0 + 0.2, rf, P.dark);
    G(X(-0.15, 0.15), -0.05, 0.15, r0, snap(r0 + 3.4), P.opticCyan);
    // Cooling slots along the upper rail (the core stays one unbroken cyan line).
    for (let z = r0 + 0.3; z < rf - 0.2; z += 0.4) G(X(-0.15, 0.15), 0.25, 0.35, z, z + 0.1, P.frame);
    // Capacitor fins under the barrel.
    G(X(-0.15, 0.15), -0.45, -0.25, r0 + 0.6, rf - 0.2, P.frame);
    for (let z = r0 + 0.7; z < rf - 0.3; z += 0.2) G(X(-0.15, 0.15), -0.55, -0.45, z, z + 0.1, P.dark);
    // Receiver: 0.5 x 0.7 block with the core showing in a side slot, charge cells on top.
    G(X(-0.25, 0.25), -0.35, 0.35, rf, rb, P.frame);
    // The 0.2 m cyan core runs on unbroken along both sides from the shroud to the stock.
    G(X(-0.15, 0.15), -0.05, 0.15, rf, rb, P.opticCyan);
    gun.carve([cx - 0.25, cy - 0.05, rf], [cx - 0.15, cy + 0.15, rb - 0.3]);
    gun.carve([cx + 0.15, cy - 0.05, rf], [cx + 0.25, cy + 0.15, rb - 0.3]);
    for (let i = 0; i < 3; i++) G(X(-0.15, 0.15), 0.35, 0.45, rb - 0.5 - i * 0.2, rb - 0.4 - i * 0.2, i === 0 ? P.opticCyan : P.dark);
    hazardBand(gun, [cx - 0.3, cy - 0.4, rb - 0.3], [cx + 0.3, cy + 0.4, rb], { where: m => m === P.frame });
    // Battery magazine and grip under the receiver.
    G(X(-0.15, 0.15), -0.65, -0.35, rf + 0.6, rf + 1.0, P.dark);
    G(X(-0.15, 0.15), -0.65, -0.55, rf + 0.6, rf + 1.0, P.frame);
    G(X(-0.05, 0.05), -0.55, -0.35, rf + 0.1, rf + 0.3, P.dark);
    // Box scope on a two-post mount: cyan front lens, dark eyepiece.
    G(X(-0.05, 0.05), 0.35, 0.45, rf + 0.1, rf + 0.2, P.frame);
    G(X(-0.05, 0.05), 0.35, 0.45, rf + 0.6, rf + 0.7, P.frame);
    G(X(-0.15, 0.15), 0.45, 0.75, rf - 0.1, rf + 0.8, P.frame);
    G(X(-0.15, 0.15), 0.75, 0.85, rf, rf + 0.7, P.dark);
    G(X(-0.1, 0.1), 0.5, 0.7, rf - 0.2, rf - 0.1, P.dark);
    G(X(-0.1, 0.1), 0.5, 0.7, rf + 0.8, rf + 0.9, P.opticCyan);
    // Tapered stock with a thumbhole and a dark butt pad.
    gun.wedge([cx - 0.15, cy - 0.35, rb], [cx + 0.15, cy + 0.25, butt - 0.1], P.frame, { along: 'z', slope: 'y', from: 1, to: 0.67, anchor: 1, tag });
    gun.carve([cx - 0.15, cy - 0.15, rb + 0.2], [cx + 0.15, cy + 0.05, rb + 0.5]);
    G(X(-0.2, 0.2), -0.25, 0.25, butt - 0.1, butt, P.dark);
    gun.userData.priority = { gun: 60 };
    parts.gun = gun;
  }
  return { skel: S, parts };
}

const KIT = Object.freeze({
  lights: [
    { kind: 'titanLamp', slot: 'torso', point: [-1.25, 5.45, -0.78] },
    { kind: 'titanLamp', slot: 'torso', point: [1.25, 5.45, -0.78] },
    { kind: 'titanTail', slot: 'torso', point: [-0.45, 5.05, 0.98], direction: [0, 0, 1] },
    { kind: 'titanTail', slot: 'torso', point: [0.45, 5.05, 0.98], direction: [0, 0, 1] },
  ],
  // Low-ready (art review 2): the 5 m rail rests at the right side, outboard of the right thigh,
  // muzzle ~0.8 m off the ground, one-handed (the left arm hangs free).
  carry: { pitch: -1.15, yaw: -0.12, roll: 0.1 },
  thrusters: [
    // Hover pods (dash and VTOL hover) and the calf pods.
    { slot: 'torso', point: [-0.9, 4.75, 1.1], direction: [0, -1, 0.35] },
    { slot: 'torso', point: [0.9, 4.75, 1.1], direction: [0, -1, 0.35] },
    { slot: 'kneeL', point: [-0.6, 1.35, 0.6], direction: [0, -1, 0.4] },
    { slot: 'kneeR', point: [0.6, 1.35, 0.6], direction: [0, -1, 0.4] },
  ],
  poses: {
    // Idle: the long left arm hangs beside the thigh, palm turned in. Tether Trap has no guard pose.
    idle: { wrist: [-1.5, 3.2, -0.2], hand: 0.15, twist: -1.57 },
    guard: null,
  },
});

/** NORTHSTAR titan model. Options: VehicleView's { team, material, glass, blur }. */
export function makeNorthstarModel(options = {}) {
  const { skel, parts } = blueprint(TYPE, buildParts);
  return assembleTitan(TYPE, options, skel, parts, KIT);
}
