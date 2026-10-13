// RONIN (Stryder frame, 7.6 m, fins to 8.0 m): the sword titan
// (docs/design/titanfall/README.md "RONIN", titan-turnaround-ronin.png, lineup B).
// Silhouette: NORTHSTAR's slim digitigrade Stryder legs (the turnaround's straight
// legs are wrong, README "Turnarounds"), a narrow chest under lamellar pauldrons,
// a small helmet with a red visor slit and two swept fins, red cloth tassets that
// swing with the thighs, a 4.5 m sword stowed diagonally on the back, and the short
// Leadwall drum shotgun. Sword Block (defensive) and Sword Core draw the sword into
// the left fist; during Sword Core its edge glows. Every part is authored in hull
// metres at its skeleton slot (titan-common.js). Lattices: 0.2 m parts sit on the
// hull 0.2 lattice (pivot-centred on their `center` axes), fine parts on 0.1.
import * as THREE from '../../vendor/three.module.js';
import { blueprint } from './common.js';
import { decodeTitanRow } from '../../../../shared/titan-contract.js';
import {
  TITAN_PALETTE as P, FinePart, hullCenter, titanSkeleton, slotPart, slotFine, assembleTitan,
  jointBall, piston, vents, hazardBand, bolts, batteryHatch, cable, isCamo, lamp, plateEdges, hipDrive, cockpitCavity,
} from './titan-common.js';

const TYPE = 'titan_ronin';
const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const smooth = t => t * t * (3 - 2 * t);

// Sword (README "Weapons"): authored hanging straight down from the guard centre G
// (blade toward −Y, bright edges on both sides), then posed by its node: stowed on the back
// or gripped in the left fist.
// Art review 2: stowed near-vertical down the left side of the back (hilt over the left
// pauldron, tip flared out), so the 4.4 m blade's tip shows from the front 0.4 m clear of the
// left leg at about 2.3 m instead of hiding behind the body.
const SWORD_G = Object.freeze([-1.0, 6.7, 1.2]);
const SWORD_STOW_ANGLE = -0.137;        // rad about +Z (tip toward −X)
const SWORD_GRIP = 0.45;                // m from G up the hilt to the grip centre
const HAND_GRIP = Object.freeze([-0.05, -0.35, 0]);  // grip centre in the left fist, from the wrist
const CLAMP_AT = 1.8;                   // m down the stowed blade: the lower stowage clamp
const BLADE = 4.4;                      // m from the guard to the tip (art review 2: was 3.7)
const PAULDRON_TOP = 7.05;              // m, inner top edge of the rolled pauldron caps
const PAULDRON_ROLL = 0.35;             // rad, caps rolled down and out

/** [min, max] of a right-side box mirrored to `side` (x flipped and re-sorted). */
const mx = (side, a, b) => (side > 0 ? [a, b] : [[-b[0], a[1], a[2]], [-a[0], b[1], b[2]]]);
const X = (side, value) => side * value;
/** Left edge of a 0.1 m cell whose right-side copy starts at `x` (mirrored fine cells). */
const fx = (side, x) => (side > 0 ? x : -x - 0.1);

function buildParts() {
  // Longer legs than the Stryder default (art review): thigh +0.2, shin +0.2, hips at 4.2 m.
  // (art review 2: the hock sits 0.3 m lower, 0.6 m over the sole, so the idle knee flex stays
  // under 12° — a straight, chest-up stance instead of a 48° crouch — with the IK allowed 99.6 %
  // of the leg; shorter strides keep the straighter legs' gait excursion under 0.3 m.)
  const S = titanSkeleton(TYPE, { hatchHinge: [0, 6.3, -0.9], elbowBack: 1.1, hip: [0.5, 4.2, 0], thigh: 1.45, shin: 2.1, ankle: [0, 0.6, 0.45], legReach: 0.996, stride: 2.8, reach: 1.3 });
  const parts = {};

  // ---- legs (Stryder: hip → knee forward → hock → long raised foot) ------------------------
  for (const side of [-1, 1]) {
    const k = side < 0 ? 'L' : 'R';
    const hip = S[`hip${k}`], knee = S[`knee${k}`], ankle = S[`ankle${k}`];
    const hx = hip[0], hy = hip[1], ky = knee[1], ay = ankle[1];
    const B = (part, a, b, material, options) => part.box(...mx(side, a, b), material, options);

    // Thigh: hip drum, gunmetal strut, slim camo shell with an outer plate, a proud front plate
    // with a groove, and a rear piston with its hose.
    const thigh = slotPart(S, `thigh${k}`, `thigh-${k}`, { center: 'x' });
    thigh.cyl([hx, hy, 0], 0.32, 0.8, 'x', P.frame);
    B(thigh, [0.8, 4.0, -0.2], [1.0, 4.4, 0.2], P.dark);
    B(thigh, [0.4, 2.8, -0.2], [0.6, 4.0, 0.2], P.frame);
    B(thigh, [0.2, 3.0, -0.4], [0.8, 4.2, 0.4], P.camo);
    B(thigh, [0.8, 3.2, -0.4], [1.0, 4.0, 0.4], P.plate);
    B(thigh, [0.2, 3.0, -0.6], [0.8, 4.0, -0.4], P.plate);
    thigh.carve(...mx(side, [0.2, 3.8, -0.6], [0.4, 4.0, -0.4]));
    thigh.carve(...mx(side, [0.6, 3.8, -0.6], [0.8, 4.0, -0.4]));
    thigh.skin(...mx(side, [0.0, 3.0, -0.8], [1.2, 3.2, 0.6]), P.frame, { where: isCamo });
    thigh.skin(...mx(side, [0.8, 3.4, -0.6], [1.2, 3.6, 0.6]), P.dark, { normal: [side, 0, 0] });
    thigh.skin(...mx(side, [0.4, 3.2, -0.8], [0.6, 3.6, -0.4]), P.dark, { normal: [0, 0, -1] });
    plateEdges(thigh, ...mx(side, [0.2, 3.2, -0.6], [0.8, 4.0, 0.4]), { top: false, outer: side });
    piston(thigh, [X(side, 0.5), 4.0, 0.5], [X(side, 0.5), 2.8, 0.5], 0.2, { sleeve: 0.4 });
    cable(thigh, [[X(side, 0.9), 3.8, 0.3], [X(side, 0.9), 3.0, 0.3]], P.black);
    parts[`thigh${k}`] = thigh;

    // Shin (knee → hock): knee drum and chamfered cap, camo shell with a front greave and the
    // team accent band, gunmetal strut and calf piston behind, outer vents, hock drum.
    const shin = slotPart(S, `shin${k}`, `shin-${k}`, { center: 'x' });
    shin.cyl([hx, ky, 0], 0.32, 0.8, 'x', P.frame);
    B(shin, [0.8, 2.6, -0.2], [1.0, 3.0, 0.2], P.dark);
    B(shin, [0.2, 2.4, -0.6], [0.8, 3.0, -0.2], P.plate);
    shin.carve(...mx(side, [0.2, 2.8, -0.6], [0.4, 3.0, -0.4]));
    shin.carve(...mx(side, [0.6, 2.8, -0.6], [0.8, 3.0, -0.4]));
    B(shin, [0.2, 1.0, -0.4], [0.8, 2.4, 0.2], P.camo);
    B(shin, [0.2, 0.8, -0.2], [0.8, 1.0, 0.2], P.camo);
    B(shin, [0.2, 1.2, -0.6], [0.8, 2.2, -0.4], P.plate);
    shin.skin(...mx(side, [0.4, 1.2, -0.8], [0.6, 2.2, -0.4]), P.dark, { normal: [0, 0, -1] });
    B(shin, [0.4, 0.6, 0.2], [0.6, 2.6, 0.4], P.frame);
    piston(shin, [X(side, 0.5), 1.0, 0.5], [X(side, 0.5), 2.4, 0.5], 0.2, { sleeve: 0.5 });
    for (const [a, b] of [[0.2, 0.4], [0.6, 0.8]]) B(shin, [a, 1.2, 0.2], [b, 2.4, 0.6], P.camo);
    shin.skin(...mx(side, [0.0, 2.2, 0.4], [1.0, 2.4, 0.8]), P.frame, { where: isCamo });
    shin.skin(...mx(side, [0.0, 1.4, -0.8], [1.0, 1.8, 0.8]), P.accent, { where: m => isCamo(m) || m === P.frame });
    vents(shin, ...mx(side, [0.6, 2.0, -0.4], [0.8, 2.4, 0.2]), [side, 0, 0], { along: 'z' });
    shin.cyl([hx, ay, 0], 0.22, 0.6, 'x', P.frame);
    cable(shin, [[X(side, 0.9), 2.4, 0.3], [X(side, 0.9), 1.0, 0.3]], P.black);
    parts[`shin${k}`] = shin;

    // Foot: hock socket, a ramped camo instep down to a long pointed toe plate, raised heel spur.
    // Pivot-centred in y, so the sole sits exactly on the ground contact (frame.ankle below the hock).
    const foot = slotPart(S, `foot${k}`, `foot-${k}`, { center: 'xy' });
    const sole = ay - S.frame.ankle[1];
    const poly = points => points.map(([x, z]) => [X(side, x), z]);
    B(foot, [0.2, ay - 0.3, -0.2], [0.8, ay + 0.1, 0.2], P.frame);
    foot.prism('y', poly([[0.15, 0.35], [0.85, 0.35], [0.85, -0.9], [0.58, -1.62], [0.42, -1.62], [0.15, -0.9]]), [sole, sole + 0.2], P.frame);
    foot.prism('y', poly([[0.15, 0.15], [0.85, 0.15], [0.85, -0.85], [0.6, -1.4], [0.4, -1.4], [0.15, -0.85]]), [sole + 0.2, sole + 0.4], P.camo);
    foot.prism('x', [[0.3, sole + 0.4], [0.3, ay + 0.1], [-0.1, ay + 0.1], [-0.9, sole + 0.4]], [hx - 0.3, hx + 0.3], P.camo);
    B(foot, [0.4, sole + 0.4, -1.2], [0.6, sole + 0.6, -0.4], P.plate);
    B(foot, [0.4, sole, 0.2], [0.6, ay - 0.1, 0.6], P.frame);
    B(foot, [0.8, sole, -1.2], [1.0, sole + 0.2, -0.4], P.frame);
    B(foot, [0.8, sole + 0.2, -1.0], [1.0, sole + 0.4, -0.4], P.plate);
    foot.skin(...mx(side, [0.0, sole, -1.8], [1.2, sole + 0.2, 0.8]), P.dark, { where: m => m === P.frame });
    foot.skin(...mx(side, [0.6, sole + 0.2, -0.8], [1.0, sole + 0.4, 0.2]), P.plate, { normal: [side, 0, 0], where: isCamo });
    parts[`foot${k}`] = foot;
  }

  // ---- pelvis --------------------------------------------------------------------------------
  // (0.4 m higher with the longer legs; the ribbed waist above it stays 1.2 m wide.)
  const pelvis = slotPart(S, 'pelvis', 'pelvis');
  pelvis.box([-0.6, 3.8, -0.4], [0.6, 4.6, 0.4], P.frame);
  pelvis.box([-0.8, 4.2, -0.4], [0.8, 4.6, 0.4], P.camo);
  pelvis.box([-0.4, 3.8, -0.6], [0.4, 4.2, -0.4], P.frame);
  for (const side of [-1, 1]) {
    pelvis.box(...mx(side, [1.0, 3.6, -0.4], [1.2, 4.6, 0.4]), P.plate);
    pelvis.skin(...mx(side, [1.0, 3.6, -0.6], [1.4, 3.8, 0.6]), P.frame, { where: isCamo });
  }
  pelvis.skin([-1.4, 4.4, -0.6], [1.4, 4.6, 0.6], P.frame, { where: isCamo });
  // Rear belt bracket the back tasset hangs from (the front one hangs under the belt buckle).
  pelvis.box([-0.4, 4.2, 0.4], [0.4, 4.8, 0.6], P.frame);
  hipDrive(pelvis, S, 0.4);
  // Gunmetal belt (0.2 m, the nearest lattice step to 0.15) round the hips with a brass buckle
  // over the front tabard (art review 2; on the 0.2 m pelvis part: a fine part would cost a draw).
  pelvis.box([-1.0, 4.2, -0.6], [1.0, 4.4, 0.4], P.frame);
  pelvis.box([-0.2, 4.2, -0.8], [0.2, 4.4, -0.6], P.brass);
  parts.pelvis = pelvis;

  // ---- torso (0.2 m): ribbed waist, chest, cheeks, pauldron caps, collar, back plate --------
  const torso = slotPart(S, 'torso', 'torso');
  torso.box([-0.6, 4.0, -0.4], [0.6, 4.2, 0.4], P.frame);
  torso.box([-0.4, 4.2, -0.2], [0.4, 4.4, 0.2], P.dark);
  torso.box([-0.6, 4.4, -0.4], [0.6, 4.6, 0.4], P.frame);
  torso.box([-0.4, 4.6, -0.2], [0.4, 4.8, 0.2], P.dark);
  torso.box([-0.4, 4.2, -0.6], [0.4, 4.4, -0.4], P.plate);
  torso.box([-0.2, 4.4, -0.6], [0.2, 4.8, -0.4], P.plate);
  torso.prism('z', [[-0.6, 4.75], [0.6, 4.75], [1.05, 5.4], [1.05, 6.2], [0.75, 6.45], [-0.75, 6.45], [-1.05, 6.2], [-1.05, 5.4]], [-0.8, 0.6], P.camo);
  // Front frame round the hatch: cheek plates, brow, a gunmetal skirt below with vents.
  torso.paint([-0.6, 5.0, -0.8], [0.6, 6.2, -0.6], P.dark);
  for (const side of [-1, 1]) torso.box(...mx(side, [0.6, 5.0, -1.0], [1.0, 6.4, -0.8]), P.plate);
  torso.box([-0.6, 6.2, -1.0], [0.6, 6.4, -0.8], P.plate);
  torso.box([-0.6, 4.8, -1.0], [0.6, 5.0, -0.8], P.plate);
  vents(torso, [-0.4, 4.8, -1.0], [0.4, 5.0, -0.8], [0, 0, -1], { along: 'x' });
  for (const side of [-1, 1]) {
    vents(torso, ...mx(side, [0.8, 5.6, -0.6], [1.0, 6.0, 0.4]), [side, 0, 0], { along: 'z' });
    torso.skin(...mx(side, [0.8, 5.0, -0.8], [1.2, 5.2, 0.6]), P.dark, { normal: [side, 0, 0] });
  }
  // Team accent band (0.4 m) across the chest and round its flanks.
  torso.skin([-1.2, 5.4, -1.2], [1.2, 5.8, 0.8], P.accent, { where: isCamo });
  // Collar: gunmetal neck ring, camo guards beside the head, a raised spine behind it.
  torso.box([-0.4, 6.4, -0.4], [0.4, 6.6, 0.4], P.frame);
  for (const side of [-1, 1]) torso.box(...mx(side, [0.6, 6.4, -0.4], [0.8, 6.8, 0.6]), P.camo);
  torso.box([-0.4, 6.4, 0.4], [0.4, 6.8, 0.6], P.frame);
  // Pauldron mounts: gunmetal blocks over the shoulder joints carrying the rolled caps (fine detail).
  for (const side of [-1, 1]) {
    const tag = side < 0 ? 'kit-left' : 'kit-right';
    torso.box(...mx(side, [0.8, 6.6, -0.6], [1.2, 7.0, 0.4]), P.frame, { tag });
  }
  // Back plate: recess for the battery hatch, ears beside its top, lower band and thruster pods.
  torso.box([-0.8, 4.8, 0.6], [0.8, 6.4, 0.8], P.camo);
  torso.carve([-0.6, 5.0, 0.6], [0.6, 6.2, 0.8]);
  torso.paint([-0.6, 5.0, 0.4], [0.6, 6.2, 0.6], P.dark);
  for (const side of [-1, 1]) {
    torso.box(...mx(side, [0.6, 5.8, 0.6], [0.8, 6.6, 1.0]), P.frame);
    torso.box(...mx(side, [0.4, 4.6, 0.6], [0.8, 5.0, 1.0]), P.frame);
  }
  torso.skin([-1.0, 4.8, 0.6], [1.0, 5.0, 1.0], P.frame, { where: isCamo });
  // The cockpit behind the chest hatch (seen while the hatch is open).
  cockpitCavity(torso, { front: -0.8, floor: 5.0, width: 1.2, height: 1.2, depth: 0.8 });
  torso.userData.priority = { 'kit-left': 45, 'kit-right': 44 };
  parts.torso = [torso];

  // ---- torso detail (0.1 m): lamellar slabs, roundel, stripe, battery hatch, lamps, clamps ----
  const fine = slotFine(S, 'torso', 'torso-detail');
  // Pauldrons (art review 2): 1.0 m caps rolled 0.35 rad down and out over the shoulder joints,
  // two-tone, with three lamellae hanging under the outer edge (outer x 1.8; 0.2 m plates on the
  // 0.1 m lattice — 0.15 m ones broke up into single-cell rows).
  const capY = x => PAULDRON_TOP - Math.tan(PAULDRON_ROLL) * (x - 0.85);
  const band = (x0, x1, drop, thick) => [[x0, capY(x0) - drop], [x1, capY(x1) - drop], [x1, capY(x1) - drop - thick], [x0, capY(x0) - drop - thick]];
  const sided = (side, poly) => poly.map(([x, y]) => [side * x, y]);
  for (const side of [-1, 1]) {
    const tag = side < 0 ? 'kit-left' : 'kit-right';
    fine.prism('z', sided(side, band(0.85, 1.81, 0, 0.3)), [-0.8, 0.6], P.camo, { tag });
    fine.prism('z', sided(side, band(0.85, 1.81, 0, 0.12)), [-0.8, 0.6], P.plate, { tag });
    for (let i = 0; i < 3; i++) {
      const material = i === 1 ? P.plate : P.camo;
      fine.prism('z', sided(side, band(1.61, 1.81, 0.35 + 0.3 * i, 0.2)), [-0.7, 0.5], material, { tag });
    }
    bolts(fine, [[fx(side, 1.0), capY(1.05) - 0.2, -0.9]], P.frame);
    // Cheek bolts, flood lamps low on the cheeks, tail lamps, thruster nozzles.
    bolts(fine, [[fx(side, 0.8), 6.2, -1.1]], P.frame);
    lamp(fine, [side * 0.8, 5.15], -1.0, -1);
    lamp(fine, [side * 0.75, 5.15], 1.0, 1, P.lampRed);
    fine.box(...mx(side, [0.5, 4.6, 1.0], [0.7, 4.8, 1.1]), P.soot);
  }
  // Roundel (0.35 m with a 0.1 m ring) across the outer face of the left cap and its lamellae.
  fine.roundel([-1.8, capY(1.81) - 0.45, -0.1], 0.35, [-1, 0, 0], { ring: 0.1, depth: 0.12 });
  // WEST/EAST stripe: a 0.4 m band with 0.1 m edges over the right cap, front to back, and down
  // its front face (EAST drops the pale edge on the front face).
  for (const [x0, x1, top, front] of [[1.0, 1.1, P.stripeEdge, P.stripeRim], [1.1, 1.5, P.stripe, P.stripe], [1.5, 1.6, P.stripeEdge, P.stripeRim]]) {
    fine.prism('z', band(x0 + 0.01, x1 - 0.01, 0, 0.12), [-0.7, 0.6], top);
    fine.prism('z', band(x0 + 0.01, x1 - 0.01, 0, 0.3), [-0.8, -0.7], front);
  }
  // Battery hatch between the shoulder blades (rodeo target).
  batteryHatch(fine, [0, 5.6], 0.8);
  // Sword stowage: a strap over the left ear and a clamp on the lower back, both under the
  // stowed blade's line (they stay, empty, when the sword is drawn).
  {
    const s = Math.sin(SWORD_STOW_ANGLE), c = Math.cos(SWORD_STOW_ANGLE);
    const clamp2 = (px, py, z0) => {
      fine.box([px - 0.2, py - 0.2, z0], [px + 0.2, py + 0.2, 1.1], P.frame);
      for (const ex of [px - 0.3, px + 0.2]) fine.box([ex, py - 0.1, z0], [ex + 0.1, py + 0.1, 1.4], P.frame);
      fine.box([px - 0.3, py - 0.1, 1.3], [px + 0.3, py + 0.1, 1.4], P.dark);
      // Bracket back to the back plate.
      fine.box([Math.min(px + 0.2, -0.7), py - 0.1, z0], [-0.6, py + 0.1, z0 + 0.2], P.frame);
    };
    const at = d => [Math.round((SWORD_G[0] + s * d) * 10) / 10, Math.round((SWORD_G[1] - c * d) * 10) / 10];
    clamp2(...at(CLAMP_AT), 0.8);
    clamp2(...at(0.3), 1.0);
  }
  parts.torso.push(fine);

  // ---- chest hatch (0.1 m): its own part, opens on the hinge and blows off on eject ----------
  const hatch = slotFine(S, 'hatch', 'hatch');
  {
    const tag = 'hatch';
    hatch.box([-0.6, 5.0, -1.0], [0.6, 6.2, -0.8], P.plate, { tag });
    hatch.box([-0.5, 5.1, -1.1], [0.5, 6.1, -1.0], P.plate, { tag });
    for (const [x0, x1] of [[-0.6, -0.5], [0.5, 0.6]]) for (const y of [5.0, 6.1]) hatch.carve([x0, y, -1.0], [x1, y + 0.1, -0.8]);
    hatch.skin([-0.5, 5.1, -1.2], [0.5, 5.2, -1.0], P.dark, { normal: [0, 0, -1] });
    hatch.skin([-0.5, 6.0, -1.2], [0.5, 6.1, -1.0], P.dark, { normal: [0, 0, -1] });
    // Vision slit: a gunmetal brow lip round a glowing slot, 0.1 m proud.
    hatch.box([-0.4, 5.7, -1.2], [0.4, 6.0, -1.1], P.frame, { tag });
    hatch.box([-0.3, 5.8, -1.2], [0.3, 5.9, -1.1], P.energyBlue, { tag });
    // Accent band across the hatch, hinge knuckles, grab handles and corner bolts.
    hatch.skin([-0.7, 5.4, -1.3], [0.7, 5.8, -0.7], P.accent, { where: isCamo });
    for (const sx of [-0.4, 0.3]) hatch.box([sx, 6.1, -1.1], [sx + 0.1, 6.3, -0.9], P.frame, { tag });
    for (const sx of [-0.3, 0.2]) hatch.box([sx, 5.2, -1.2], [sx + 0.1, 5.4, -1.1], P.frame, { tag });
    bolts(hatch, [[-0.5, 5.1, -1.2], [0.4, 5.1, -1.2], [-0.5, 6.0, -1.2], [0.4, 6.0, -1.2]], P.frame);
    for (const [, voxel] of hatch.cells) voxel.tag = tag;
    hatch.userData.priority = { hatch: 90 };
  }
  parts.hatch = hatch;

  // ---- head (0.1 m): helmet with brow, V faceplate, cheek guards and two swept fins --------
  const head = slotFine(S, 'head', 'head');
  const H = 0.2;   // helmet lift: the head stands clear of the pauldron caps on a short neck
  {
    const tag = 'head';
    head.box([-0.2, 6.3, -0.2], [0.2, 6.5 + H, 0.2], P.frame, { tag });
    head.box([-0.4, 6.5 + H, -0.4], [0.4, 7.0 + H, 0.3], P.camo, { tag });
    head.paint([-0.4, 6.9 + H, -0.4], [0.4, 7.0 + H, 0.3], P.plate);
    head.carve([-0.4, 6.9 + H, -0.4], [-0.3, 7.0 + H, 0.3]);
    head.carve([0.3, 6.9 + H, -0.4], [0.4, 7.0 + H, 0.3]);
    head.box([-0.3, 6.5 + H, 0.3], [0.3, 6.9 + H, 0.4], P.frame, { tag });
    // Brow hood over the visor, the dark visor band, and the V-shaped mouth guard below it.
    head.box([-0.4, 6.9 + H, -0.5], [0.4, 7.0 + H, -0.4], P.plate, { tag });
    head.box([-0.4, 6.8 + H, -0.5], [0.4, 6.9 + H, -0.4], P.dark, { tag });
    head.box([-0.4, 6.7 + H, -0.5], [0.4, 6.8 + H, -0.4], P.frame, { tag });
    head.box([-0.3, 6.6 + H, -0.5], [0.3, 6.7 + H, -0.4], P.frame, { tag });
    head.box([-0.2, 6.5 + H, -0.5], [0.2, 6.6 + H, -0.4], P.frame, { tag });
    head.box([-0.1, 6.4 + H, -0.5], [0.1, 6.5 + H, -0.4], P.frame, { tag });
    for (const x0 of [-0.2, 0.1]) head.skin([x0, 6.6 + H, -0.6], [x0 + 0.1, 6.7 + H, -0.4], P.dark, { normal: [0, 0, -1] });
    // Neck cables either side of the neck block.
    for (const x0 of [-0.3, 0.2]) head.box([x0, 6.4, -0.1], [x0 + 0.1, 6.6 + H, 0.0], P.black, { tag });
    for (const side of [-1, 1]) {
      head.box(...mx(side, [0.4, 6.5 + H, -0.4], [0.5, 6.9 + H, 0.2]), P.plate, { tag });
      vents(head, ...mx(side, [0.4, 6.6 + H, -0.3], [0.5, 6.8 + H, 0.1]), [side, 0, 0], { along: 'z' });
      // Fin: rises from the helmet top, swept 20° out and 15° back, tapering to a tip near 8.1 m.
      head.box(...mx(side, [0.2, 6.9 + H, -0.3], [0.4, 7.1 + H, 0.2]), P.frame, { tag });
      for (let i = 0; i <= 9; i++) {
        const y = 7.1 + H + i * 0.1 - 0.1;
        const out = 0.2 + Math.round(i * 0.1 * Math.tan(20 * Math.PI / 180) * 10) / 10;
        const back = Math.round(i * 0.1 * Math.tan(15 * Math.PI / 180) * 10) / 10;
        const w = i < 7 ? 0.2 : 0.1, d0 = i < 4 ? -0.3 : i < 7 ? -0.2 : -0.1;
        head.box(...mx(side, [out, y, d0 + back], [out + w, y + 0.1, 0.1 + back]), i >= 8 ? P.frame : P.camo, { tag });
        if (i < 8) head.box(...mx(side, [out, y, d0 + back - 0.1], [out + 0.1, y + 0.1, d0 + back]), P.plate, { tag });
      }
    }
    for (const [, voxel] of head.cells) voxel.tag = tag;
    head.userData.priority = { head: 70 };
  }
  parts.head = head;
  // Visor: a red slit 0.6 × 0.1, 0.1 m proud of the dark band (constant glow).
  const eye = slotFine(S, 'head', 'eye');
  eye.box([-0.3, 6.8 + H, -0.6], [0.3, 6.9 + H, -0.5], P.opticRed, { tag: 'head' });
  eye.userData.priority = { head: 70 };
  parts.eye = eye;
  // Doomed: a broken, sputtering orange slit.
  const eyeDoom = slotFine(S, 'head', 'eye-doom');
  for (const x0 of [-0.3, -0.1, 0.0, 0.2]) eyeDoom.box([x0, 6.8 + H, -0.6], [x0 + 0.1, 6.9 + H, -0.5], P.opticOrange, { tag: 'head' });
  eyeDoom.userData.priority = { head: 70 };
  parts.eyeDoom = eyeDoom;

  // ---- arms ------------------------------------------------------------------------------------
  // Upper arms hang straight down from the shoulder in the authored pose; the rig aims them.
  for (const side of [-1, 1]) {
    const k = side < 0 ? 'L' : 'R';
    const sh = S[`shoulder${k}`], len = S.upperLen, sx = sh[0], sy = sh[1], sz = sh[2];
    const tag = side < 0 ? 'arm' : null;
    const upper = slotPart(S, `upper${k}`, `upper-${k}`, { center: 'xz' });
    jointBall(upper, [sx, sy, sz], 0.6, P.frame, { tag });
    upper.box([sx - 0.1, sy - len + 0.2, sz - 0.1], [sx + 0.1, sy - 0.2, sz + 0.1], P.frame);
    upper.box([sx - 0.3, sy - 1.3, sz - 0.3], [sx + 0.3, sy - 0.5, sz + 0.3], P.camo);
    upper.box([sx - 0.1, sy - 1.1, sz - 0.5], [sx + 0.1, sy - 0.7, sz - 0.3], P.plate);
    upper.box([sx - 0.1, sy - 1.5, sz - 0.3], [sx + 0.1, sy - 1.3, sz + 0.3], P.frame);
    upper.skin([sx - 0.4, sy - 0.7, sz - 0.6], [sx + 0.4, sy - 0.5, sz + 0.4], P.frame, { where: isCamo });
    piston(upper, [sx, sy - 0.8, sz + 0.4], [sx, sy - len + 0.1, sz + 0.4], 0.2, { sleeve: 0.3 });
    for (const [, voxel] of upper.cells) voxel.tag = tag;
    if (tag) upper.userData.priority = { arm: 50 };
    parts[`upper${k}`] = upper;
  }
  // Left forearm and fist hang down in the authored pose (rig: two-bone IK). The palm faces
  // +X (in), so the sword hilt runs through the fist along Z.
  {
    const e = S.elbowL, w = S.wristL, ex = e[0], ey = e[1], ez = e[2], wy = w[1];
    const tag = 'arm';
    const fore = slotPart(S, 'foreL', 'fore-L', { center: 'xz' });
    fore.cyl([ex, ey, ez], 0.26, 0.6, 'x', P.frame);
    fore.box([ex - 0.3, wy + 0.2, ez - 0.3], [ex + 0.3, ey - 0.2, ez + 0.3], P.camo);
    fore.box([ex - 0.5, wy + 0.3, ez - 0.3], [ex - 0.3, ey - 0.3, ez + 0.3], P.plate);
    fore.box([ex - 0.3, wy + 0.4, ez - 0.5], [ex + 0.1, ey - 0.3, ez - 0.3], P.plate);
    fore.box([ex - 0.3, wy - 0.1, ez - 0.3], [ex + 0.3, wy + 0.2, ez + 0.3], P.frame);
    fore.skin([ex - 0.6, wy + 0.2, ez - 0.6], [ex + 0.4, wy + 0.4, ez + 0.4], P.frame, { where: isCamo });
    vents(fore, [ex + 0.1, wy + 0.5, ez - 0.1], [ex + 0.3, ey - 0.4, ez + 0.1], [1, 0, 0], { along: 'y' });
    for (const [, voxel] of fore.cells) voxel.tag = tag;
    fore.userData.priority = { arm: 50 };
    parts.foreL = fore;

    const hand = slotFine(S, 'handL', 'hand-L', { center: 'x' });
    const hx = w[0], hy = wy, hz = w[2];
    hand.box([hx - 0.15, hy - 0.15, hz - 0.15], [hx + 0.15, hy + 0.05, hz + 0.15], P.frame);
    hand.box([hx - 0.25, hy - 0.6, hz - 0.25], [hx + 0.15, hy - 0.1, hz + 0.25], P.frame);
    hand.box([hx - 0.35, hy - 0.55, hz - 0.2], [hx - 0.25, hy - 0.15, hz + 0.2], P.plate);
    // Three fingers curled round to the palm side with dark tips; a thumb over the front.
    for (const fz of [-0.2, 0.0, 0.2]) {
      hand.box([hx + 0.15, hy - 0.55, hz + fz - 0.05], [hx + 0.25, hy - 0.15, hz + fz + 0.05], P.frame);
      hand.box([hx + 0.15, hy - 0.6, hz + fz - 0.05], [hx + 0.25, hy - 0.55, hz + fz + 0.05], P.dark);
    }
    hand.box([hx - 0.05, hy - 0.35, hz - 0.35], [hx + 0.25, hy - 0.15, hz - 0.25], P.dark);
    hand.box([hx - 0.25, hy - 0.65, hz - 0.2], [hx + 0.15, hy - 0.6, hz + 0.2], P.dark);
    for (const [, voxel] of hand.cells) voxel.tag = tag;
    hand.userData.priority = { arm: 50 };
    parts.handL = hand;
  }
  // Right forearm: rigid with the shotgun, pointing forward from the elbow on the pitch axis.
  {
    const e = S.elbowR, ex = e[0], ey = e[1], ez = e[2];
    const fore = slotPart(S, 'foreR', 'fore-R', { center: 'xy' });
    fore.cyl([ex, ey, ez], 0.3, 0.6, 'x', P.frame);
    fore.box([ex - 0.3, ey - 0.3, -0.4], [ex + 0.3, ey + 0.3, 0.6], P.camo);
    fore.box([ex - 0.3, ey + 0.3, -0.2], [ex + 0.3, ey + 0.5, 0.4], P.plate);
    fore.box([ex + 0.3, ey - 0.3, -0.2], [ex + 0.5, ey + 0.3, 0.4], P.plate);
    fore.box([ex - 0.3, ey - 0.3, -0.6], [ex + 0.3, ey + 0.3, -0.4], P.frame);
    fore.skin([ex - 0.6, ey - 0.6, -0.4], [ex + 0.6, ey + 0.6, -0.2], P.frame, { where: isCamo });
    vents(fore, [ex + 0.3, ey - 0.3, 0.0], [ex + 0.5, ey + 0.3, 0.4], [1, 0, 0], { along: 'z' });
    piston(fore, [ex, ey - 0.4, 0.6], [ex, ey - 0.4, -0.2], 0.2, { sleeve: 0.4 });
    parts.foreR = fore;
    const hand = slotFine(S, 'handR', 'hand-R');
    // Knuckle block outboard of the shotgun, fingers wrapping under the receiver, thumb on top.
    hand.box([1.7, 4.3, -0.9], [2.0, 4.8, -0.4], P.frame);
    hand.box([2.0, 4.4, -0.8], [2.1, 4.7, -0.5], P.plate);
    for (const [i, z0] of [-0.9, -0.7, -0.5].entries()) hand.box([1.2, 4.2, z0], [1.7, 4.3, z0 + 0.1], i === 1 ? P.dark : P.frame);
    hand.box([1.4, 4.8, -0.8], [1.7, 4.9, -0.6], P.dark);
    parts.handR = hand;
  }

  // ---- Leadwall (0.1 m) on the recoil node: receiver, drum, wide slotted muzzle ---------------
  {
    const gun = slotFine(S, 'gun', 'leadwall');   // muzzle face at pivot − 1.9 = −2.25 (lattice −2.3)
    const g = 'gun';
    gun.box([1.2, 4.3, -1.5], [1.7, 4.8, -0.2], P.frame, { tag: g });
    gun.box([1.3, 4.4, -0.2], [1.6, 4.8, 0.0], P.dark, { tag: g });
    // Barrel shroud with side slots and a wide flat muzzle (the pellet spread).
    gun.box([1.2, 4.4, -2.2], [1.7, 4.8, -1.5], P.dark, { tag: g });
    for (const z of [-2.0, -1.8, -1.6]) for (const x of [1.2, 1.6]) gun.carve([x, 4.5, z], [x + 0.1, 4.7, z + 0.1]);
    gun.box([1.1, 4.3, -2.3], [1.8, 4.9, -2.1], P.frame, { tag: g });
    gun.carve([1.2, 4.5, -2.3], [1.7, 4.7, -2.2]);
    gun.paint([1.2, 4.5, -2.2], [1.7, 4.7, -2.1], P.black);
    vents(gun, [1.2, 4.7, -2.1], [1.7, 4.8, -1.5], [0, 1, 0], { along: 'z', material: P.frame });
    // Top rail with a red-dot sight, four red bars along both receiver sides.
    gun.box([1.3, 4.8, -1.4], [1.6, 4.9, -1.0], P.frame, { tag: g });
    gun.box([1.3, 4.9, -1.3], [1.6, 5.0, -1.0], P.dark, { tag: g });
    gun.box([1.4, 4.9, -1.4], [1.5, 5.0, -1.3], P.opticRed, { tag: g });
    for (let i = 0; i < 4; i++) {
      const z0 = -1.4 + i * 0.2;
      gun.skin([1.1, 4.5, z0], [1.8, 4.7, z0 + 0.1], P.warning, { where: m => m === P.frame });
    }
    // Drum magazine under the receiver with hub caps and a frame band; pistol grip in the fist.
    gun.cyl([1.45, 4.1, -1.15], 0.35, 0.3, 'x', P.dark, { tag: g });
    gun.cyl([1.45, 4.1, -1.15], 0.15, 0.5, 'x', P.frame, { tag: g });
    gun.cyl([1.45, 4.1, -1.15], 0.38, 0.1, 'x', P.frame, { tag: g });
    gun.box([1.3, 3.9, -0.7], [1.6, 4.2, -0.4], P.dark, { tag: g });
    hazardBand(gun, [1.1, 4.3, -0.4], [1.8, 4.9, -0.2], { where: m => m === P.frame });
    gun.userData.priority = { gun: 60 };
    parts.gun = gun;
  }

  // ---- extras: sword (+ Sword Core edge glow) and the cloth tassets ----------------------------
  const [gx, gy, gz] = SWORD_G;
  const sword = new FinePart(`${TYPE}-sword`, SWORD_G);
  {
    const tag = 'sword';
    // (art review 2: a 4.4 m blade, 0.3 m wide, with a 0.1 m bright edge down BOTH sides.)
    sword.box([gx - 0.2, gy - BLADE + 0.4, gz - 0.1], [gx + 0.1, gy - 0.1, gz + 0.1], P.blade, { tag });
    sword.box([gx - 0.1, gy - BLADE + 0.2, gz - 0.1], [gx, gy - BLADE + 0.4, gz + 0.1], P.blade, { tag });
    sword.box([gx - 0.1, gy - BLADE, gz - 0.05], [gx, gy - BLADE + 0.2, gz + 0.05], P.bladeEdge, { tag });
    for (const x0 of [gx - 0.2, gx]) sword.paint([x0, gy - BLADE + 0.3, gz - 0.1], [x0 + 0.1, gy - 0.2, gz + 0.1], P.bladeEdge);
    // A steel fuller on both flats (silver, not a dark slot); brass collar, square guard, wrapped
    // hilt, pommel.
    sword.skin([gx - 0.1, gy - BLADE + 0.8, gz - 0.2], [gx, gy - 0.3, gz + 0.2], P.steel, { normal: [0, 0, -1] });
    sword.skin([gx - 0.1, gy - BLADE + 0.8, gz - 0.2], [gx, gy - 0.3, gz + 0.2], P.steel, { normal: [0, 0, 1] });
    sword.box([gx - 0.2, gy - 0.2, gz - 0.2], [gx + 0.2, gy - 0.1, gz + 0.2], P.brass, { tag });
    sword.box([gx - 0.3, gy - 0.1, gz - 0.2], [gx + 0.3, gy + 0.1, gz + 0.2], P.frame, { tag });
    sword.box([gx - 0.1, gy + 0.1, gz - 0.1], [gx + 0.1, gy + 0.8, gz + 0.1], P.dark, { tag });
    for (const [x, y, z] of [...sword.voxels()]) {
      const h = hullCenter(sword, y, 1);
      if (h > gy + 0.1 && h < gy + 0.8 && (x + y + z) % 2 === 0) sword.getCell(x, y, z).material = P.clothRed;
    }
    sword.box([gx - 0.2, gy + 0.8, gz - 0.1], [gx + 0.2, gy + 0.9, gz + 0.1], P.frame, { tag });
    sword.userData.priority = { sword: 55 };
  }
  const edge = new FinePart(`${TYPE}-sword-edge`, SWORD_G);
  {
    for (const x0 of [gx - 0.3, gx + 0.1]) edge.box([x0, gy - BLADE + 0.4, gz - 0.1], [x0 + 0.1, gy - 0.2, gz + 0.1], P.energyBlue);
    // Follow the stepped tip, then the fuller on both flats.
    for (const x0 of [gx - 0.2, gx]) edge.box([x0, gy - BLADE + 0.2, gz - 0.1], [x0 + 0.1, gy - BLADE + 0.4, gz + 0.1], P.energyBlue);
    edge.box([gx - 0.1, gy - BLADE - 0.1, gz - 0.05], [gx, gy - BLADE, gz + 0.05], P.energyBlue);
    for (const z0 of [gz - 0.2, gz + 0.1]) edge.box([gx - 0.1, gy - BLADE + 0.9, z0], [gx, gy - 0.4, z0 + 0.1], P.energyBlue);
  }
  // Cloth tassets: hinged at the belt, 0.4 m deep, ragged three-step hems with a darker trim
  // (README "Tassets"; art review).
  const cloth = (name, pivot, hems, z0, z1, boltZ) => {
    const part = new FinePart(`${TYPE}-${name}`, pivot);
    const width = hems.length * 0.1, py = pivot[1];
    part.box([-width / 2 - 0.1, py - 0.2, z0 - 0.1], [width / 2 + 0.1, py, z1 + 0.1], P.frame);
    hems.forEach((hem, i) => {
      const x0 = -width / 2 + i * 0.1;
      part.box([x0, hem + 0.1, z0], [x0 + 0.1, py - 0.2, z1], i % 3 === 1 ? P.fuel : P.clothRed);
      part.box([x0, hem, z0], [x0 + 0.1, hem + 0.1, z1], P.clothDark);
    });
    bolts(part, [[-width / 2, py - 0.2, boltZ], [width / 2 - 0.1, py - 0.2, boltZ]], P.brass);
    return part;
  };
  const HEM = [3.4, 3.2, 3.0, 3.2, 3.4, 3.0, 3.2, 3.4, 3.0, 3.2];
  // Front tabard (art review 2): 0.6 m of cloth (0.8 m with its hanger) from under the belt at
  // 4.2 m down to 2.6 m, slimmer (0.2 m) so it hangs flat over the pelvis.
  const clothFront = cloth('cloth-front', [0, 4.2, -0.8], [2.8, 2.6, 2.7, 2.6, 2.8, 2.6], -0.9, -0.7, -1.1);
  const clothBack = cloth('cloth-back', [0, 4.6, 0.7], HEM.map(h => h - 0.2), 0.5, 0.9, 1.0);
  parts.extras = [
    { name: 'sword', parent: 'torso', pivot: [...SWORD_G], parts: [sword, edge] },
    { name: 'clothFront', parent: 'pelvis', pivot: [0, 4.2, -0.8], parts: [clothFront] },
    { name: 'clothBack', parent: 'pelvis', pivot: [0, 4.6, 0.7], parts: [clothBack] },
  ];
  return { skel: S, parts };
}

// Left-hand poses (torso-frame wrist, hand pitch, twist about the forearm).
const POSE_IDLE = Object.freeze({ wrist: Object.freeze([-1.8, 3.3, -0.2]), hand: 0, twist: 0 });
// Sword Core: blade drawn, held low and forward at the left side.
const POSE_CORE = Object.freeze({ wrist: Object.freeze([-1.4, 4.2, -1.5]), hand: -1.7, twist: 0.3 });
// Sword Block: fist in front of the chest, blade raised diagonally across the body.
const POSE_GUARD = Object.freeze({ wrist: Object.freeze([-0.75, 5.0, -2.0]), hand: -0.7, twist: -0.3 });

const KIT = Object.freeze({
  lights: [
    { kind: 'titanLamp', slot: 'torso', point: [-0.8, 5.15, -0.98] },
    { kind: 'titanLamp', slot: 'torso', point: [0.8, 5.15, -0.98] },
    { kind: 'titanTail', slot: 'torso', point: [-0.75, 5.15, 0.98], direction: [0, 0, 1] },
    { kind: 'titanTail', slot: 'torso', point: [0.75, 5.15, 0.98], direction: [0, 0, 1] },
  ],
  // Low-ready: the short Leadwall dips at the hip.
  carry: { pitch: -0.35, yaw: 0.25 },
  thrusters: [
    { slot: 'torso', point: [-0.6, 4.7, 1.15], direction: [0, -0.4, 1] },
    { slot: 'torso', point: [0.6, 4.7, 1.15], direction: [0, -0.4, 1] },
    { slot: 'torso', point: [-1.3, 6.0, 0.7], direction: [0, -0.2, 1] },
    { slot: 'torso', point: [1.3, 6.0, 0.7], direction: [0, -0.2, 1] },
  ],
  poses: { idle: POSE_IDLE, guard: POSE_GUARD },
});

const STOW_Q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), SWORD_STOW_ANGLE);
// In the fist: sword +X (spine) → hand +Y, sword +Y (pommel) → hand +Z, so the blade points
// forward of the knuckles with its edge toward the fingertips.
const HAND_Q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
  new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)));
const HAND_POS = new THREE.Vector3(...HAND_GRIP).sub(new THREE.Vector3(0, SWORD_GRIP, 0).applyQuaternion(HAND_Q));
const _d = new THREE.Vector3();
const TASSET_FLARE = 10 * Math.PI / 180;
/** Forward swing of a thigh in the pelvis frame (rad, knee forward > 0). */
const thighSwing = hip => { _d.set(0, -1, 0).applyQuaternion(hip.quaternion); return Math.atan2(-_d.z, -_d.y); };

/**
 * RONIN's kit on top of the shared rig: Sword Block / Sword Core draw the sword
 * into the left fist (the hand pose blends to the core stance on a linear ramp,
 * so it is frame-rate independent), the Sword Core edge glows, and the cloth
 * tassets swing clear of the thighs. Everything is a pure function of the row
 * stream and the rig's own deterministic state.
 */
function rigRonin(model, kitSpec) {
  const n = model.nodes, rig = model.rig;
  const sword = n.sword, front = n.clothFront, back = n.clothBack;
  const edges = model.kit.parts.filter(entry => entry.part.name === `${TYPE}-sword-edge` && entry.mesh).map(entry => entry.mesh);
  const stowPos = sword.position.clone();
  const idle = kitSpec.poses.idle;
  let core = 0, drawn = null;
  const place = inHand => {
    if (drawn === inHand) return;
    drawn = inHand;
    if (inHand) { n.handL.add(sword); sword.position.copy(HAND_POS); sword.quaternion.copy(HAND_Q); }
    else { n.torso.add(sword); sword.position.copy(stowPos); sword.quaternion.copy(STOW_Q); }
  };
  place(false);
  for (const mesh of edges) mesh.visible = false;
  const base = model.animate;
  model.animate = (dt, state = {}) => {
    const step = clamp(finite(dt), 0, 0.25);
    const titan = state.titan || decodeTitanRow(state.tw ? { tw: state.tw } : null);
    const coreOn = !!titan?.coreActive && !state.wreck;
    core = clamp(core + (coreOn ? step : -step) / 0.3, 0, 1);
    const t = smooth(core);
    for (let i = 0; i < 3; i++) idle.wrist[i] = POSE_IDLE.wrist[i] + (POSE_CORE.wrist[i] - POSE_IDLE.wrist[i]) * t;
    idle.hand = POSE_IDLE.hand + (POSE_CORE.hand - POSE_IDLE.hand) * t;
    idle.twist = POSE_IDLE.twist + (POSE_CORE.twist - POSE_IDLE.twist) * t;
    base(dt, state);
    const inHand = !state.wreck && (core > 0.4 || rig.guard > 0.35);
    place(inHand);
    for (const mesh of edges) mesh.visible = inHand && coreOn;
    // Tassets follow the thighs: the front one rides just ahead of the forward thigh,
    // the back one swings back with the trailing thigh.
    const left = thighSwing(n.hipL), right = thighSwing(n.hipR);
    // Both hang flared 10° out from the hips at rest.
    front.rotation.set(TASSET_FLARE + clamp(Math.max(left, right) - 0.3, 0, 1.0), 0, 0);
    back.rotation.set(-TASSET_FLARE - clamp(-Math.min(left, right, 0) + 0.06, 0, 0.32), 0, 0);
  };
  return model;
}

/** RONIN titan model. Options: VehicleView's { team, material, glass, blur }. */
export function makeRoninModel(options = {}) {
  const { skel, parts } = blueprint(TYPE, buildParts);
  const kitSpec = { ...KIT, poses: { idle: { ...POSE_IDLE, wrist: [...POSE_IDLE.wrist] }, guard: POSE_GUARD } };
  const { extras, ...slots } = parts;
  const model = assembleTitan(TYPE, options, skel, slots, { ...kitSpec, extras });
  return rigRonin(model, kitSpec);
}
