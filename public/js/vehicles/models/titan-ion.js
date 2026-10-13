// ION (Atlas frame, 7.0 m): the style benchmark of the titan models
// (docs/design/titanfall/README.md "ION", titan-turnaround-ion.png, lineup B).
// Silhouette: a wide box chest over a narrow waist, a small head sunk between
// square pauldrons with one big round blue-white eye, two exhaust stacks on the
// back, and the long Splitter Rifle with four blue cells held at the hip.
// Every part is authored in hull metres at its skeleton slot (titan-common.js).
import { blueprint } from './common.js';
import {
  TITAN_PALETTE as P, titanSkeleton, slotPart, slotFine, assembleTitan,
  jointBall, piston, vents, hazardBand, bolts, batteryHatch, cable, isCamo, lamp, plateEdges, hipDrive, cockpitCavity,
} from './titan-common.js';

const TYPE = 'titan_ion';

function buildParts() {
  const skel = titanSkeleton(TYPE, { hatchHinge: [0, 6.0, -0.9] });
  const parts = {};
  const S = skel;

  // ---- legs ---------------------------------------------------------------------------
  for (const side of [-1, 1]) {
    const k = side < 0 ? 'L' : 'R', X = v => side * v;
    const hip = S[`hip${k}`], knee = S[`knee${k}`], ankle = S[`ankle${k}`];
    const hx = hip[0];
    // Thigh: hip drum, gunmetal frame, a camo shell with a proud front plate and a rear piston sleeve.
    const thigh = slotPart(S, `thigh${k}`, `thigh-${k}`, { center: 'x' });
    thigh.cyl([hx, hip[1], 0], 0.36, 0.8, 'x', P.frame);
    thigh.cyl([hx, hip[1], 0], 0.18, 1.0, 'x', P.dark);
    thigh.box([hx - 0.2, knee[1] + 0.2, -0.3], [hx + 0.2, hip[1] - 0.2, 0.3], P.frame);
    // (art review 2: legs 0.2 m wider, 1.2 m thigh shell, under a stance as wide as the pauldrons)
    thigh.box([hx - 0.6, knee[1] + 0.3, -0.5], [hx + 0.6, hip[1] + 0.2, 0.5], P.camo);
    thigh.box([X(0.9) + X(0.3), hip[1] - 0.6, -0.4], [X(0.9) + X(0.6), hip[1] + 0.4, 0.4], P.plate);
    thigh.box([hx - 0.4, knee[1] + 0.3, -0.7], [hx + 0.4, hip[1] - 0.1, -0.5], P.plate);
    thigh.wedge([hx - 0.4, hip[1] - 0.1, -0.7], [hx + 0.4, hip[1] + 0.1, -0.5], P.plate, { along: 'y', slope: 'z', from: 1, to: 0.5, anchor: 1 });
    thigh.skin([hx - 0.7, knee[1] + 0.3, -0.8], [hx + 0.7, knee[1] + 0.5, 0.6], P.frame, { where: isCamo });
    plateEdges(thigh, [hx - 0.6, knee[1] + 0.5, -0.5], [hx + 0.6, hip[1] + 0.2, 0.5], { under: false, outer: side });
    // Front plate groove, side panel groove and the rear piston sleeve.
    thigh.skin([hx - 0.1, knee[1] + 0.5, -0.8], [hx + 0.1, hip[1] - 0.3, -0.6], P.dark, { normal: [0, 0, -1] });
    thigh.skin([X(0.9) + X(0.3), knee[1] + 0.5, -0.5], [X(0.9) + X(0.6), knee[1] + 0.7, 0.5], P.dark, { normal: [side, 0, 0] });
    thigh.box([hx - 0.1, knee[1] + 0.1, 0.5], [hx + 0.1, hip[1] - 0.3, 0.7], P.frame);
    cable(thigh, [[hx - X(0.35), hip[1] - 0.2, 0.55], [hx - X(0.35), knee[1] + 0.3, 0.55]], P.black);
    parts[`thigh${k}`] = thigh;

    // Shin: knee drum and plate, camo shell with the team accent band, ankle cuff and drum.
    const shin = slotPart(S, `shin${k}`, `shin-${k}`, { center: 'x' });
    shin.cyl([hx, knee[1], 0], 0.36, 0.9, 'x', P.frame);
    shin.cyl([hx, knee[1], 0], 0.16, 1.1, 'x', P.dark);
    shin.box([hx - 0.6, 0.9, -0.6], [hx + 0.6, knee[1] - 0.2, 0.6], P.camo);
    shin.box([hx - 0.4, 0.7, -0.4], [hx + 0.4, 0.9, 0.4], P.frame);
    shin.wedge([hx - 0.6, 0.7, -0.6], [hx + 0.6, 0.9, 0.6], P.camo, { along: 'y', slope: 'z', from: 0.6, to: 1, anchor: 0.5 });
    // Front greave (0.2 proud), with a vertical groove.
    shin.box([hx - 0.5, 1.4, -0.8], [hx + 0.5, knee[1] - 0.3, -0.6], P.plate);
    // Knee guard: hugs the knee drum on a gunmetal bracket, so it stays on the shin when the knee
    // bends; plain ground coat with a lighter top bevel (a small plate must not take one blot).
    shin.box([hx - 0.4, knee[1] - 0.5, -0.6], [hx + 0.4, knee[1] + 0.1, -0.4], P.frame);
    shin.box([hx - 0.4, knee[1] - 0.5, -0.8], [hx + 0.4, knee[1] + 0.1, -0.6], P.drab);
    shin.wedge([hx - 0.4, knee[1] + 0.1, -0.8], [hx + 0.4, knee[1] + 0.3, -0.5], P.drab, { along: 'y', slope: 'z', from: 1, to: 0.34, anchor: 1 });
    shin.skin([hx - 0.4, knee[1] - 0.5, -0.9], [hx + 0.4, knee[1] - 0.3, -0.7], P.frame, { normal: [0, 0, -1] });
    shin.skin([hx - 0.1, 1.4, -0.9], [hx + 0.1, knee[1] - 0.6, -0.7], P.dark, { normal: [0, 0, -1] });
    // Accent band all the way round (0.3 m per the README, on the 0.2 lattice 0.4).
    shin.skin([hx - 0.9, 1.0, -0.9], [hx + 0.9, 1.4, 0.9], P.accent, { where: m => isCamo(m) || m === P.frame });
    plateEdges(shin, [hx - 0.6, 1.4, -0.6], [hx + 0.6, knee[1] - 0.2, 0.6], { top: false, outer: side });
    // Calf: exposed frame, piston rod, outer vents.
    shin.box([hx - 0.3, 1.2, 0.6], [hx + 0.3, knee[1] - 0.1, 0.8], P.frame);
    piston(shin, [hx, 1.5, 0.7], [hx, knee[1] + 0.1, 0.7], 0.2, { sleeve: 0.4 });
    vents(shin, [hx + X(0.6), 1.5, -0.4], [hx + X(0.8), 1.9, 0.4], [side, 0, 0], { along: 'y' });
    shin.cyl([hx, ankle[1], 0], 0.28, 0.8, 'x', P.frame);
    parts[`shin${k}`] = shin;

    // Foot: gunmetal sole, a camo upper sloping to two split toes, heel spur and ankle socket.
    const foot = slotPart(S, `foot${k}`, `foot-${k}`, { center: 'x' });
    const sole = ankle[1] - skel.frame.ankle[1];
    // 2.0 m long: a gunmetal sole, a camo upper sloping down to two blunt toes, heel spur.
    foot.box([hx - 0.7, sole, -1.1], [hx + 0.7, sole + 0.2, 0.7], P.frame);
    foot.box([hx - 0.7, sole + 0.2, -0.9], [hx + 0.7, sole + 0.5, 0.5], P.camo);
    foot.wedge([hx - 0.6, sole + 0.5, -0.9], [hx + 0.6, sole + 0.9, 0.3], P.camo, { along: 'z', slope: 'y', from: 0.25, to: 1, anchor: 0 });
    for (const tx of [-0.35, 0.35]) {
      foot.box([hx + tx - 0.25, sole, -1.4], [hx + tx + 0.25, sole + 0.5, -0.9], P.plate);
      foot.wedge([hx + tx - 0.25, sole + 0.2, -1.4], [hx + tx + 0.25, sole + 0.5, -1.2], P.plate, { along: 'z', slope: 'y', from: 0, to: 1, anchor: 0 });
      foot.box([hx + tx - 0.25, sole, -1.4], [hx + tx + 0.25, sole + 0.2, -1.2], P.frame);
    }
    foot.box([hx - 0.4, sole, 0.5], [hx + 0.4, sole + 0.4, 0.8], P.frame);
    foot.box([hx - 0.3, sole + 0.4, -0.3], [hx + 0.3, ankle[1] + 0.1, 0.3], P.frame);
    foot.skin([hx - 0.8, sole, -1.5], [hx + 0.8, sole + 0.2, 0.9], P.dark, { where: m => m === P.frame });
    parts[`foot${k}`] = foot;
  }

  // ---- pelvis ---------------------------------------------------------------------------
  const pelvis = slotPart(S, 'pelvis', 'pelvis');
  pelvis.box([-0.6, 3.2, -0.5], [0.6, 4.0, 0.5], P.frame);
  pelvis.box([-0.8, 3.6, -0.6], [0.8, 4.0, 0.6], P.camo);
  pelvis.box([-0.4, 3.0, -0.8], [0.4, 3.8, -0.6], P.plate);
  pelvis.wedge([-0.4, 2.8, -0.8], [0.4, 3.0, -0.6], P.plate, { along: 'y', slope: 'x', from: 0.5, to: 1, anchor: 0.5 });
  pelvis.box([-0.6, 3.2, 0.6], [0.6, 3.8, 0.8], P.camo);
  // Hip skirts over the (now wider) hip drums.
  for (const side of [-1, 1]) {
    pelvis.box([side * 0.8, 3.7, -0.5], [side * 1.6, 4.1, 0.5], P.plate);
    pelvis.skin([side * 0.8, 3.7, -0.6], [side * 1.6, 3.8, 0.6], P.dark, { where: isCamo });
  }
  pelvis.skin([-1.7, 3.6, -0.9], [1.7, 3.7, 0.9], P.frame, { where: isCamo });
  pelvis.skin([-0.2, 3.0, -0.9], [0.2, 3.6, -0.7], P.dark, { normal: [0, 0, -1] });
  hipDrive(pelvis, skel, 0.5);
  parts.pelvis = pelvis;

  // ---- torso (0.2 m): waist, abdomen, chest, cheeks, pauldrons, collar, back plate, stacks ----
  const torso = slotPart(S, 'torso', 'torso', { center: 'x' });
  torso.box([-0.7, 3.9, -0.5], [0.7, 4.3, 0.5], P.frame);
  torso.box([-0.9, 4.0, -0.3], [0.9, 4.1, 0.3], P.dark);
  torso.box([-0.9, 4.2, -0.7], [0.9, 4.6, 0.7], P.camo);
  for (const y of [4.25, 4.45]) torso.skin([-0.9, y - 0.05, -0.8], [0.9, y + 0.05, -0.6], P.dark, { normal: [0, 0, -1] });
  torso.prism('z', [[-1.1, 4.4], [1.1, 4.4], [1.3, 4.8], [1.3, 6.2], [-1.3, 6.2], [-1.3, 4.8]], [-0.8, 0.9], P.camo);
  // Front frame round the hatch: cheek plates, brow and a gunmetal skirt with vents.
  for (const side of [-1, 1]) torso.box([side * 0.9, 4.6, -1.0], [side * 1.3, 6.2, -0.8], P.plate);
  torso.box([-0.9, 6.0, -1.0], [0.9, 6.2, -0.8], P.plate);
  torso.box([-0.9, 4.4, -1.0], [0.9, 4.6, -0.8], P.frame);
  torso.paint([-0.9, 4.6, -0.8], [0.9, 6.0, -0.6], P.dark);
  // Chest side vents and a side panel groove.
  for (const side of [-1, 1]) {
    vents(torso, [side * 1.1, 4.8, -0.5], [side * 1.5, 5.2, 0.5], [side, 0, 0], { along: 'z' });
    torso.skin([side * 1.1, 5.6, -0.8], [side * 1.5, 5.8, 0.9], P.dark, { normal: [side, 0, 0] });
  }
  // Pauldrons: two-tone plates over a gunmetal underside, chamfered outer top edge.
  for (const side of [-1, 1]) {
    const x0 = side * 0.9, x1 = side * 2.3;
    torso.box([x0, 5.4, -0.8], [x1, 6.8, 0.8], P.camo, { tag: side < 0 ? 'kit-left' : 'kit-right' });
    torso.paint([x0, 6.2, -0.8], [x1, 6.8, 0.8], P.plate);
    torso.box([side * 1.1, 5.2, -0.6], [side * 2.1, 5.4, 0.6], P.frame);
    torso.carve([side * 2.1, 6.6, -0.8], [side * 2.3, 6.8, 0.8]);
    torso.carve([x0, 6.6, -0.8], [x1, 6.8, -0.6]);
    torso.skin([x0, 6.0, -0.9], [x1, 6.2, 0.9], P.dark, { normal: [0, 0, -1] });
    torso.skin([side * 2.2, 6.0, -0.8], [side * 2.4, 6.2, 0.8], P.dark, { normal: [side, 0, 0] });
    plateEdges(torso, [Math.min(x0, x1), 5.4, -0.8], [Math.max(x0, x1), 6.6, 0.8], { top: false, outer: side });
  }
  // WEST/EAST stripe: a vertical band on the left pauldron (front, top and outer side), edged in
  // a contrasting edge (dark round the pale WEST stripe, pale round the black EAST one).
  // (art review 2: one plain 0.4 m stripe with thin 0.1 m edges, a fine decal on the front face;
  // the top keeps the stripe under the vent slats)
  torso.skin([-1.8, 6.6, -0.8], [-1.4, 6.8, 0.8], P.stripe, { normal: [0, 1, 0] });
  // Team accent band (0.4 m) across the chest under the vision slit and round its flanks.
  torso.skin([-1.4, 4.8, -1.1], [1.4, 5.2, 1.0], P.accent, { where: isCamo });
  // Collar guards beside the head and a raised spine behind it.
  for (const side of [-1, 1]) torso.box([side * 0.5, 6.2, -0.4], [side * 0.9, 6.6, 0.8], P.camo);
  torso.box([-0.5, 6.2, 0.4], [0.5, 6.5, 0.8], P.frame);
  // Back plate with the recess for the battery hatch (fine part) and rear lamp housings.
  torso.box([-1.1, 4.6, 0.9], [1.1, 6.2, 1.3], P.camo);
  torso.carve([-0.5, 4.9, 1.1], [0.5, 6.1, 1.3]);
  torso.box([-0.5, 4.9, 1.0], [0.5, 6.1, 1.1], P.dark);
  torso.skin([-1.2, 4.6, 1.2], [1.2, 4.8, 1.4], P.frame, { normal: [0, 0, 1] });
  // Exhaust stacks (the shoulder kit that blows off) with soot caps.
  for (const side of [-1, 1]) {
    const tag = side < 0 ? 'kit-left' : 'kit-right';
    torso.box([side * 0.7, 5.6, 0.5], [side * 1.1, 7.2, 0.9], P.frame, { tag });
    torso.box([side * 0.5, 7.0, 0.3], [side * 1.3, 7.2, 1.1], P.frame, { tag });
    torso.box([side * 0.7, 7.2, 0.5], [side * 1.1, 7.4, 0.9], P.soot, { tag });
    torso.box([side * 0.5, 5.6, 0.4], [side * 1.3, 5.8, 1.0], P.frame, { tag });
  }
  // The cockpit behind the chest hatch (seen while the hatch is open).
  cockpitCavity(torso, { front: -0.8, floor: 4.7, width: 1.0, height: 1.2, depth: 1.0 });
  torso.userData.priority = { 'kit-left': 45, 'kit-right': 44 };
  parts.torso = [torso];

  // ---- torso detail (0.1 m): pauldron vents, roundel, bolts, battery hatch, rear lamps ---
  const fine = slotFine(S, 'torso', 'torso-detail');
  for (const side of [-1, 1]) {
    const x0 = side * 1.15, x1 = side * 2.05;
    fine.box([x0, 6.8, -0.55], [x1, 6.85, 0.45], P.dark);
    for (let i = 0; i < 4; i++) {
      const z = -0.5 + i * 0.25;
      fine.box([x0, 6.8, z], [x1, 7.0, z + 0.1], P.frame);
    }
    // Pauldron bolts round the front plate.
    bolts(fine, [[side * 0.95 - (side < 0 ? 0.1 : 0), 6.6, -0.9], [side * 2.15 - (side < 0 ? 0.1 : 0), 6.6, -0.9],
      [side * 0.95 - (side < 0 ? 0.1 : 0), 5.45, -0.9], [side * 2.15 - (side < 0 ? 0.1 : 0), 5.45, -0.9]], P.frame);
    // Cheek bolts and hatch-hinge pins.
    bolts(fine, [[side * 1.05 - 0.05, 5.95, -1.1], [side * 1.05 - 0.05, 4.75, -1.1]], P.frame);
  }
  // Roundel on the right pauldron front, centred and inset (art review 2): a 0.7 m disc in a
  // 0.1 m ring, ≥ 0.25 m from every pauldron edge.
  fine.cyl([1.6, 6.1, -0.85], 0.45, 0.1, 'z', P.ring);
  fine.roundel([1.6, 6.1, -0.9], 0.35, [0, 0, -1], { ring: 0.1, depth: 0.1 });
  // Team stripe decal on the left pauldron front: 0.4 m with 0.1 m edges, full face height.
  fine.box([-1.9, 5.4, -0.9], [-1.3, 6.8, -0.8], P.stripeRim);
  fine.box([-1.8, 5.4, -0.9], [-1.4, 6.8, -0.8], P.stripe);
  // Battery hatch between the shoulder blades (rodeo target).
  batteryHatch(fine, [0, 5.5], 1.1);
  // Flood lamps under the pauldrons, rear lamps low on the back plate, antenna on the right collar.
  for (const side of [-1, 1]) {
    lamp(fine, [side * 1.95, 5.15], -1.0, -1);
    lamp(fine, [side * 0.85, 4.95], 1.4, 1, P.lampRed);
  }
  fine.box([0.7, 6.6, 0.4], [0.8, 7.5, 0.5], P.frame);
  fine.box([0.65, 7.5, 0.35], [0.85, 7.6, 0.55], P.dark);
  parts.torso.push(fine);

  // ---- chest hatch (0.1 m): its own part, opens on the hinge and blows off on eject ---------
  const hatch = slotFine(S, 'hatch', 'hatch');
  const tag = 'hatch';
  hatch.box([-0.8, 4.6, -1.0], [0.8, 6.0, -0.8], P.plate, { tag });
  hatch.box([-0.6, 4.7, -1.1], [0.6, 5.9, -1.0], P.plate, { tag });
  // Chamfered corners, a recessed seam ring and the vision slit.
  for (const sx of [-1, 1]) for (const y of [4.6, 5.9]) hatch.carve([sx < 0 ? -0.8 : 0.7, y, -1.0], [sx < 0 ? -0.7 : 0.8, y + 0.1, -0.8]);
  hatch.skin([-0.7, 4.7, -1.15], [0.7, 4.8, -0.95], P.dark, { normal: [0, 0, -1] });
  hatch.skin([-0.7, 5.8, -1.15], [0.7, 5.9, -0.95], P.dark, { normal: [0, 0, -1] });
  // Vision slit: a gunmetal brow lip over a glowing ION-blue slot, 0.1 m proud of the plate.
  hatch.box([-0.45, 5.5, -1.2], [0.45, 5.8, -1.1], P.frame, { tag });
  hatch.box([-0.35, 5.6, -1.2], [0.35, 5.7, -1.1], P.energyBlue, { tag });
  // Accent band across the hatch, hinge knuckles and handles.
  hatch.skin([-0.9, 4.8, -1.2], [0.9, 5.2, -0.8], P.accent, { where: isCamo });
  for (const sx of [-0.5, 0.5]) hatch.box([sx - 0.15, 5.9, -1.0], [sx + 0.15, 6.05, -0.85], P.frame, { tag });
  for (const sx of [-0.45, 0.45]) {
    hatch.box([sx - 0.05, 4.85, -1.2], [sx + 0.05, 5.15, -1.15], P.frame, { tag });
  }
  bolts(hatch, [[-0.75, 4.65, -1.1], [0.65, 4.65, -1.1], [-0.75, 5.85, -1.1], [0.65, 5.85, -1.1]], P.frame);
  for (const [k, voxel] of hatch.cells) voxel.tag = tag;
  hatch.userData.priority = { hatch: 90 };
  parts.hatch = hatch;

  // ---- head (0.1 m): a small box sunk between the pauldrons, brow, ear vents, eye rim --------
  const head = slotFine(S, 'head', 'head');
  const htag = 'head';
  // A 1.0 m cube standing proud of the chest top (6.2) between the collar guards.
  head.box([-0.2, 6.1, -0.2], [0.2, 6.4, 0.2], P.frame, { tag: htag });
  head.box([-0.5, 6.35, -0.6], [0.5, 7.3, 0.3], P.camo, { tag: htag });
  head.box([-0.4, 6.4, 0.3], [0.4, 7.15, 0.45], P.frame, { tag: htag });
  head.box([-0.55, 7.15, -0.7], [0.55, 7.3, -0.45], P.plate, { tag: htag });
  for (const side of [-1, 1]) {
    head.box([side * 0.5 - (side < 0 ? 0.1 : 0), 6.45, -0.5], [side * 0.5 + (side > 0 ? 0.1 : 0), 7.1, 0.2], P.frame, { tag: htag });
    vents(head, [side < 0 ? -0.65 : 0.55, 6.5, -0.45], [side < 0 ? -0.55 : 0.65, 7.05, 0.15], [side, 0, 0], { along: 'y', pitch: 0.2 });
  }
  head.skin([-0.5, 7.25, -0.6], [0.5, 7.35, 0.3], P.plate, { normal: [0, 1, 0] });
  head.box([-0.3, 7.3, -0.3], [0.3, 7.4, 0.1], P.frame, { tag: htag });
  // Eye socket: a 0.1 m gunmetal ring round the lens.
  head.cyl([0, 6.8, -0.65], 0.4, 0.1, 'z', P.gun, { tag: htag });
  for (const [, voxel] of head.cells) voxel.tag = htag;
  head.userData.priority = { head: 70 };
  parts.head = head;
  // The lens: ION blue (constant glow) with a 0.2 m blue-white core, 0.1 m proud of the ring.
  const eye = slotFine(S, 'head', 'eye');
  eye.cyl([0, 6.8, -0.75], 0.3, 0.1, 'z', P.opticIon, { tag: htag });
  eye.box([-0.1, 6.7, -0.8], [0.1, 6.9, -0.7], P.opticIonCore, { tag: htag });
  eye.userData.priority = { head: 70 };
  parts.eye = eye;
  const eyeDoom = slotFine(S, 'head', 'eye-doom');
  eyeDoom.cyl([0, 6.8, -0.75], 0.3, 0.12, 'z', P.opticRed, { tag: htag });
  eyeDoom.userData.priority = { head: 70 };
  parts.eyeDoom = eyeDoom;

  // ---- arms -----------------------------------------------------------------------------
  // Upper arms hang straight down from the shoulder in the authored pose; the rig aims them.
  for (const side of [-1, 1]) {
    const k = side < 0 ? 'L' : 'R';
    const sh = S[`shoulder${k}`], len = S.upperLen, sx = sh[0];
    const tagArm = side < 0 ? 'arm' : null;
    const upper = slotPart(S, `upper${k}`, `upper-${k}`, { center: 'xz' });
    upper.cyl([sx, sh[1], sh[2]], 0.34, 0.8, 'x', P.frame, { tag: tagArm });
    upper.box([sx - 0.2, sh[1] - len + 0.2, sh[2] - 0.2], [sx + 0.2, sh[1] - 0.2, sh[2] + 0.2], P.frame, { tag: tagArm });
    upper.box([sx - 0.3, sh[1] - 1.3, sh[2] - 0.3], [sx + 0.3, sh[1] - 0.4, sh[2] + 0.3], P.camo, { tag: tagArm });
    upper.skin([sx - 0.4, sh[1] - 0.6, sh[2] - 0.4], [sx + 0.4, sh[1] - 0.4, sh[2] + 0.4], P.frame, { tag: tagArm, where: isCamo });
    piston(upper, [sx, sh[1] - 1.2, sh[2] + 0.4], [sx, sh[1] - len + 0.1, sh[2] + 0.4], 0.2, { sleeve: 0.3, tag: tagArm });
    upper.box([sx - 0.1, sh[1] - 1.3, sh[2] + 0.3], [sx + 0.1, sh[1] - 1.1, sh[2] + 0.5], P.frame, { tag: tagArm });
    for (const [, voxel] of upper.cells) voxel.tag = tagArm;
    if (tagArm) upper.userData.priority = { arm: 50 };
    parts[`upper${k}`] = upper;
  }
  // Left forearm and hand hang down in the authored pose (rig: two-bone IK).
  {
    const e = S.elbowL, w = S.wristL, ex = e[0];
    const fore = slotPart(S, 'foreL', 'fore-L', { center: 'xz' });
    fore.cyl([ex, e[1], e[2]], 0.28, 0.7, 'x', P.frame, { tag: 'arm' });
    fore.box([ex - 0.4, w[1] + 0.1, e[2] - 0.4], [ex + 0.4, e[1] - 0.2, e[2] + 0.4], P.camo, { tag: 'arm' });
    fore.box([ex - 0.3, w[1] + 0.3, e[2] - 0.6], [ex + 0.3, e[1] - 0.3, e[2] - 0.4], P.plate, { tag: 'arm' });
    fore.box([ex - 0.3, w[1] - 0.1, e[2] - 0.3], [ex + 0.3, w[1] + 0.1, e[2] + 0.3], P.frame, { tag: 'arm' });
    fore.skin([ex - 0.5, w[1] + 0.3, e[2] - 0.5], [ex + 0.5, w[1] + 0.5, e[2] + 0.5], P.frame, { where: isCamo });
    vents(fore, [ex - 0.5, w[1] + 0.6, e[2] - 0.3], [ex - 0.3, e[1] - 0.4, e[2] + 0.3], [-1, 0, 0], { along: 'y' });
    for (const [, voxel] of fore.cells) voxel.tag = 'arm';
    fore.userData.priority = { arm: 50 };
    parts.foreL = fore;
    const hand = slotFine(S, 'handL', 'hand-L');
    const hx = w[0], hy = w[1], hz = w[2];
    hand.box([hx - 0.3, hy - 0.45, hz - 0.25], [hx + 0.3, hy + 0.05, hz + 0.25], P.frame, { tag: 'arm' });
    hand.box([hx - 0.35, hy - 0.4, hz - 0.2], [hx - 0.25, hy - 0.05, hz + 0.25], P.plate, { tag: 'arm' });
    hand.box([hx - 0.25, hy - 0.4, hz + 0.25], [hx + 0.25, hy - 0.05, hz + 0.3], P.plate, { tag: 'arm' });
    // Three fingers (slightly curled toward the palm) and a thumb.
    for (const fx of [-0.2, 0, 0.2]) {
      hand.box([hx + fx - 0.07, hy - 0.8, hz - 0.15], [hx + fx + 0.07, hy - 0.45, hz + 0.1], P.dark, { tag: 'arm' });
      hand.box([hx + fx - 0.07, hy - 0.9, hz - 0.25], [hx + fx + 0.07, hy - 0.8, hz], P.frame, { tag: 'arm' });
    }
    hand.box([hx + 0.3, hy - 0.4, hz - 0.2], [hx + 0.4, hy - 0.15, hz + 0.05], P.dark, { tag: 'arm' });
    // Vortex emitter on the palm (−Z face): energy-blue disc in a dark rim.
    hand.cyl([hx, hy - 0.22, hz - 0.28], 0.2, 0.06, 'z', P.dark, { tag: 'arm' });
    hand.cyl([hx, hy - 0.22, hz - 0.3], 0.14, 0.06, 'z', P.energyBlue, { tag: 'arm' });
    hand.userData.priority = { arm: 50 };
    parts.handL = hand;
  }
  // Right forearm: rigid with the rifle, pointing forward from the elbow on the pitch axis.
  {
    const e = S.elbowR, ex = e[0], ey = e[1], ez = e[2], wz = S.wristR[2];
    const fore = slotPart(S, 'foreR', 'fore-R', { center: 'xy' });
    fore.cyl([ex, ey, ez], 0.3, 0.7, 'x', P.frame);
    fore.box([ex - 0.4, ey - 0.4, wz + 0.1], [ex + 0.4, ey + 0.4, ez - 0.1], P.camo);
    fore.box([ex - 0.3, ey + 0.4, wz + 0.3], [ex + 0.3, ey + 0.6, ez - 0.2], P.plate);
    fore.box([ex - 0.2, ey - 0.2, wz - 0.1], [ex + 0.2, ey + 0.2, wz + 0.1], P.frame);
    fore.skin([ex - 0.5, ey - 0.5, wz + 0.1], [ex + 0.5, ey + 0.7, wz + 0.3], P.frame, { where: isCamo });
    vents(fore, [ex + 0.3, ey - 0.3, wz + 0.4], [ex + 0.5, ey + 0.3, ez - 0.2], [1, 0, 0], { along: 'z' });
    piston(fore, [ex, ey - 0.5, ez], [ex, ey - 0.5, wz + 0.2], 0.2, { sleeve: 0.5 });
    parts.foreR = fore;
    const w = S.wristR, hx = w[0], hy = w[1], hz = w[2];
    const hand = slotFine(S, 'handR', 'hand-R');
    // Knuckle block outboard of the rifle, fingers wrapping under the grip, thumb over the top.
    hand.box([hx - 0.25, hy - 0.35, hz - 0.45], [hx + 0.3, hy + 0.35, hz], P.frame);
    hand.box([hx + 0.3, hy - 0.3, hz - 0.4], [hx + 0.4, hy + 0.3, hz - 0.05], P.plate);
    for (const [i, fz] of [-0.4, -0.27, -0.14].entries()) {
      hand.box([hx - 0.75, hy - 0.5, hz + fz - 0.05], [hx - 0.25, hy - 0.35, hz + fz + 0.05], i === 1 ? P.dark : P.frame);
    }
    hand.box([hx - 0.7, hy + 0.3, hz - 0.35], [hx - 0.25, hy + 0.4, hz - 0.2], P.dark);
    parts.handR = hand;
  }

  // ---- Splitter Rifle (0.1 m) on the recoil node: receiver, four energy cells, slotted muzzle ----
  {
    const [px, py, pz] = S.pivot, muzzleZ = pz - S.muzzle;
    const gun = slotFine(S, 'gun', 'splitter');
    const g = 'gun';
    // Receiver body 0.5 × 0.55 from the stock to the shroud.
    gun.box([px - 0.25, py - 0.25, muzzleZ + 0.45], [px + 0.25, py + 0.3, pz + 1.0], P.frame, { tag: g });
    gun.box([px - 0.2, py + 0.3, muzzleZ + 0.9], [px + 0.2, py + 0.4, pz + 0.6], P.dark, { tag: g });
    // Stock: a tapered block with a dark butt pad.
    gun.wedge([px - 0.2, py - 0.25, pz + 1.0], [px + 0.2, py + 0.3, pz + 1.3], P.frame, { along: 'z', slope: 'y', from: 1, to: 0.6, anchor: 1, tag: g });
    gun.box([px - 0.2, py - 0.1, pz + 1.3], [px + 0.2, py + 0.3, pz + 1.4], P.dark, { tag: g });
    // Slotted muzzle shroud (0.45 m) ending exactly at the server muzzle.
    gun.box([px - 0.2, py - 0.2, muzzleZ], [px + 0.2, py + 0.25, muzzleZ + 0.45], P.dark, { tag: g });
    for (let z = muzzleZ + 0.1; z < muzzleZ + 0.4; z += 0.2) {
      gun.carve([px - 0.2, py - 0.1, z], [px - 0.1, py + 0.15, z + 0.1]);
      gun.carve([px + 0.1, py - 0.1, z], [px + 0.2, py + 0.15, z + 0.1]);
    }
    gun.box([px - 0.25, py - 0.25, muzzleZ + 0.4], [px + 0.25, py + 0.3, muzzleZ + 0.5], P.frame, { tag: g });
    gun.box([px - 0.1, py - 0.05, muzzleZ - 0.02], [px + 0.1, py + 0.1, muzzleZ + 0.05], P.energyBlue, { tag: g });
    // Four 0.3 m energy cells with 0.1 m gunmetal dividers on BOTH side faces (the low-ready carry
    // turns the outboard face to the front, art review 2; the fourth outboard cell sits under the
    // gripping hand, so that face shows three) plus a strip along the top.
    for (let i = 0; i < 4; i++) {
      const z0 = muzzleZ + 0.55 + i * 0.4;
      for (const sx of [-1, 1]) {
        if (sx > 0 && i === 3) continue;
        const [a, b] = sx < 0 ? [px - 0.45, px - 0.35] : [px + 0.35, px + 0.45];
        gun.box([Math.min(px + sx * 0.25, px + sx * 0.35), py - 0.25, z0 - 0.1], [Math.max(px + sx * 0.25, px + sx * 0.35), py + 0.35, z0 + 0.4], P.frame, { tag: g });
        gun.box([a, py - 0.2, z0], [b, py + 0.3, z0 + 0.3], P.energyBlue, { tag: g });
        gun.box([a, py - 0.25, z0 + 0.3], [b, py + 0.35, z0 + 0.4], P.gun, { tag: g });
        gun.box([a, py - 0.25, z0 - 0.1], [b, py + 0.35, z0], P.gun, { tag: g });
      }
      gun.box([px - 0.1, py + 0.3, z0 + 0.05], [px + 0.1, py + 0.38, z0 + 0.25], P.energyBlue, { tag: g });
    }
    // Under-slung energy pack, pistol grip (inside the hand) and a top sight block.
    gun.box([px - 0.2, py - 0.45, pz - 0.3], [px + 0.2, py - 0.25, pz + 0.5], P.frame, { tag: g });
    gun.box([px - 0.15, py - 0.45, pz - 0.2], [px + 0.15, py - 0.4, pz + 0.4], P.energyBlue, { tag: g });
    gun.box([px - 0.1, py - 0.5, S.wristR[2] - 0.35], [px + 0.1, py - 0.25, S.wristR[2] - 0.15], P.dark, { tag: g });
    gun.box([px - 0.15, py + 0.3, pz - 0.3], [px + 0.15, py + 0.5, pz + 0.2], P.frame, { tag: g });
    gun.box([px - 0.1, py + 0.4, pz - 0.35], [px + 0.1, py + 0.48, pz - 0.3], P.opticCyan, { tag: g });
    hazardBand(gun, [px - 0.3, py + 0.25, pz + 0.65], [px + 0.3, py + 0.35, pz + 0.95], { where: m => m === P.dark });
    gun.userData.priority = { gun: 60 };
    parts.gun = gun;
  }
  return { skel, parts };
}

const KIT = Object.freeze({
  lights: [
    { kind: 'titanLamp', slot: 'torso', point: [-1.95, 5.15, -0.98] },
    { kind: 'titanLamp', slot: 'torso', point: [1.95, 5.15, -0.98] },
    { kind: 'titanTail', slot: 'torso', point: [-0.85, 4.95, 1.38], direction: [0, 0, 1] },
    { kind: 'titanTail', slot: 'torso', point: [0.85, 4.95, 1.38], direction: [0, 0, 1] },
  ],
  // Low-ready carry (art review 2): the Splitter crosses the body diagonally, muzzle low to the
  // left, its outboard cell face turned to the front; the left hand on the cell housing.
  carry: { pitch: -0.45, yaw: 0.65, roll: -0.25, foregrip: [1.05, 4.65, -1.75] },
  thrusters: [
    { slot: 'torso', point: [-0.9, 7.4, 0.7], direction: [0, 1, 0.3] },
    { slot: 'torso', point: [0.9, 7.4, 0.7], direction: [0, 1, 0.3] },
    { slot: 'torso', point: [-0.6, 4.7, 1.35], direction: [0, -0.4, 1] },
    { slot: 'torso', point: [0.6, 4.7, 1.35], direction: [0, -0.4, 1] },
  ],
  poses: {
    // Idle: arm hanging beside the thigh, palm turned in. Guard (Vortex up): palm forward at chest height.
    idle: { wrist: [-2.0, 2.85, -0.3], hand: 0.15, twist: -1.57 },
    guard: { wrist: [-0.85, 5.05, -2.35], hand: -1.4, twist: 3.14 },
  },
});

/** ION titan model. Options: VehicleView's { team, material, glass, blur }. */
export function makeIonModel(options = {}) {
  const { skel, parts } = blueprint(TYPE, buildParts);
  return assembleTitan(TYPE, options, skel, parts, KIT);
}
