// Shared titan rig and kit (docs/titanfall.md §7, §7.1; WP5). Every titan model
// (titan-ion.js, titan-scorch.js, ...) authors its voxel parts against a frame
// skeleton from here and hands them to `assembleTitan`, which builds the node
// hierarchy, the contract mount rig, seats, emitters and the procedural rig:
//
//   group
//    ├ pelvis (bob, sway, leg yaw)          hips → thigh → knee (shin) → ankle (foot), two-bone IK
//    │  └ torso (twist = mount yaw)          hatch (hinge), head (eye, eyeDoom), shoulders → arms
//    └ mountBase (follows ≤ mountFollow of the bob)
//       └ mountYaw → mountPitch → recoil     the right forearm, hand and weapon (server mountPose)
//
// The rig keeps the frozen call `model.animate(step, state)` (WP0 placeholder):
//   state = { speed, visualSteer, grounded, wreck, tw, titan, mounts, phase, legYaw, yaw, events,
//             x, y, z (presented hull position, optional), probe (ground probe, optional) }
// Feet stay planted in world space (analytic two-bone IK), steps trigger by distance
// and alternate, and every timer runs on a fixed 1/120 s clock, so the pose is
// deterministic from the row stream and independent of the frame rate.
import * as THREE from '../../vendor/three.module.js';
import { VoxelPart, VOXEL } from '../voxel-model/dsl.js';
import { VOXEL_MATERIALS } from '../voxel-model/material.js';
import { vehicleDef } from '../../../../shared/vehicle-defs.js';
import { TITAN_CHASSIS, TITAN_PHASE, decodeTitanRow } from '../../../../shared/titan-contract.js';
import { TITAN_RULES } from '../../../../shared/vehicle-handling/titan.js';
import { createKit, buildSeatAnchors, buildMounts, lightAnchor, finishModel } from './common.js';

const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
const smooth = t => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };

// ---- palette ------------------------------------------------------------------------

const hasMaterial = name => Object.hasOwn(VOXEL_MATERIALS, name);
const pick = (name, fallback) => (hasMaterial(name) ? name : fallback);
/**
 * Palette names for titan parts. The titan entries (accent, optics, energy,
 * fuel, cloth, blade) live in material.js; until they land there each falls
 * back to the closest existing entry, so models always mesh.
 */
export const TITAN_PALETTE = Object.freeze({
  // The frame is a mid gunmetal grey (art review: the vehicle `gunmetal` at metal 0.45 renders near
  // black at titan scale, so joints read as holes); `dark` stays for bores, grooves and vents.
  // Titan-only camo (lighter woodland / desert with big blots) and a plain team ground coat for
  // small plates (knee guards) that must not take one whole camo blot.
  // In-game pass (2026-10-13, captures/ingame): under the live maps' sun, sky light and eye
  // adaptation the mid-grey `titanFrame` (0x68717b, rough 0.65) came out pale sky-blue on harbor and
  // canyon, so frame, joints and guns washed into the camo. The matt, darker `interior` grey keeps
  // the turnaround's dark-gunmetal frame against the camo on every map without going black.
  camo: pick('titanCamo', 'paint'), plate: pick('titanPlate', 'panel'), frame: 'interior', dark: 'dark', steel: 'steel', black: 'rubber', soot: 'exhaust',
  gun: 'interior',
  hazard: 'hazard', screen: 'screen', stripe: 'stripe', roundel: 'roundel', ring: 'ring', drab: pick('titanDrab', 'drab'), interior: 'interior',
  brass: 'brass', glass: 'glass', warning: 'marking',
  // Flood and tail lamps: a small amber/red lens (no headlight glare sprite, see TITAN_LIGHT_KINDS).
  lamp: pick('titanLamp', 'head'), lampRed: pick('titanTail', 'tail'),
  accent: pick('accent', 'roundel'),
  // In-game pass: the deep `energyBlue` (0x3a8cff) cells tone-mapped to a pale lavender under the
  // live post chain (bloom, eye adaptation); the ION optic blue keeps its hue, so cells, slits and
  // edges glow in the same electric blue as the eye.
  opticIon: pick('opticIon', 'strobe'), opticIonCore: pick('opticIonCore', 'strobe'), energyBlue: pick('opticIon', 'strobe'), opticCyan: pick('opticCyan', 'strobe'),
  opticOrange: pick('opticOrange', 'head'), opticRed: pick('opticRed', 'navRed'),
  fuel: pick('fuel', 'marking'), fuelCap: pick('fuelCap', 'marking'), clothRed: pick('clothRed', 'marking'),
  clothDark: pick('clothDark', 'seat'), blade: pick('blade', 'steel'), bladeEdge: pick('bladeEdge', 'missile'),
  thermite: pick('thermite', 'hazard'),
  // Team stripe edging: dark round the pale WEST stripe, pale round the black EAST one.
  stripeEdge: pick('stripeEdge', 'steel'),
  // Front-face stripe rim (art review 2: EAST keeps its pale edge on top faces only).
  stripeRim: pick('stripeRim', pick('stripeEdge', 'steel')),
});
/** True once material.js carries the titan palette entries (no fallbacks in use). */
export const TITAN_PALETTE_READY = ['accent', 'opticIon', 'energyBlue', 'opticCyan', 'opticOrange', 'opticRed', 'fuel', 'clothRed', 'blade',
  'titanCamo', 'titanPlate', 'titanDrab', 'titanFrame', 'titanLamp', 'titanTail', 'opticIonCore', 'fuelCap', 'clothDark', 'bladeEdge', 'thermite', 'stripeEdge', 'stripeRim'].every(hasMaterial);
/**
 * VehicleFx light-sprite kinds for titan lamps (vehicle-fx.js LIGHT_LOOK): small amber flood
 * lenses and red tail lenses instead of the vehicle headlight glare.
 */
export const TITAN_LIGHT_KINDS = Object.freeze({ flood: 'titanLamp', tail: 'titanTail' });
const P = TITAN_PALETTE;

// ---- fine (0.1 m) parts --------------------------------------------------------------

const mod02 = value => { const r = ((value % 0.2) + 0.2) % 0.2; return Math.abs(r - 0.2) < 1e-9 || Math.abs(r) < 1e-9 ? 0 : Math.round(r * 1e9) / 1e9; };

/**
 * A 0.1 m voxel part authored in plain hull metres. Internally it is a
 * VoxelPart at twice the size about its pivot (userData.scale 0.5), with its
 * grid shifted so the 0.1 m cells line up with the hull's 0.1 m lattice.
 * Every shape op takes hull metres. `mirrorX` is only valid with pivot x = 0.
 * Camo on fine parts samples the same hull-metre field as the 0.2 m parts
 * (assembleTitan seals every part), so blots run on across both.
 */
export class FinePart extends VoxelPart {
  constructor(name, pivot) {
    super(name, { pivot, grid: pivot.map(value => mod02(-value)) });
    this.userData.scale = 0.5;
    this.fine = true;
  }
  _p(point) { return point.map((value, i) => 2 * value - this.pivot[i]); }
  _u(axis, value) { return 2 * value - this.pivot[axis]; }
  box(min, max, material, options) { return super.box(this._p(min), this._p(max), material, options); }
  wedge(min, max, material, options) { return super.wedge(this._p(min), this._p(max), material, options); }
  cyl(center, radius, length, axis, material, options = {}) {
    return super.cyl(this._p(center), radius * 2, length * 2, axis, material, { ...options, hollow: (options.hollow || 0) * 2 });
  }
  prism(axis, polygon, [from, to], material, options = {}) {
    const a = { x: 0, y: 1, z: 2 }[axis], u = axis === 'x' ? 2 : 0, v = axis === 'y' ? 2 : 1;
    const mapped = polygon.map(([pu, pv]) => [this._u(u, pu), this._u(v, pv)]);
    return super.prism(axis, mapped, [this._u(a, from), this._u(a, to)], material, { ...options, shell: (options.shell || 0) * 2 });
  }
  loft(stations, material, options = {}) {
    const mapped = stations.map(([z, hw, yb, yt, power]) => [this._u(2, z), hw * 2, this._u(1, yb), this._u(1, yt), power]);
    return super.loft(mapped, material, { ...options, xOffset: this._u(0, options.xOffset || 0), shell: (options.shell || 0) * 2 });
  }
  carve(min, max) { return super.carve(this._p(min), this._p(max)); }
  paint(min, max, material, options) { return super.paint(this._p(min), this._p(max), material, options); }
  skin(min, max, material, options) { return super.skin(this._p(min), this._p(max), material, options); }
  roundel(center, radius, normal, options = {}) {
    return super.roundel(this._p(center), radius * 2, normal, { ...options, ring: (options.ring ?? 0.1) * 2, depth: (options.depth ?? 0.3) * 2 });
  }
}

/** Hull-metre centre of cell `index` on `axis`, for 0.2 m and fine parts alike. */
export function hullCenter(part, index, axis) {
  const value = (index + 0.5) * VOXEL + part.grid[axis];
  return part.fine ? (value + part.pivot[axis]) / 2 : value;
}

/**
 * Titan camouflage scale: the shared camo field (material.js camoIndex, tuned
 * for 5 m vehicles) is sampled at hull metres times this, so the blots on a 7 m
 * walker read about 1.5-2.5 m across like the turnarounds (art review 2: 0.46 still broke the
 * plates into blots too small to read at 60 m; the second-octave weight is a material.js request).
 */
export const TITAN_CAMO_SCALE = 0.36;

/**
 * Seal a finished part for meshing: the mesher samples the palette at
 * `part.cc(...)`, which from here on returns scaled hull metres (fine parts
 * included). Authoring ops also use `cc`, so nothing may be drawn after this;
 * assembleTitan seals every part right before it meshes them.
 */
export function sealTitanPart(part) {
  if (!(part instanceof VoxelPart) || part.titanSealed) return part;
  // Fine (0.1 m) parts sample the camo at the 0.2 m cell centres, so no single 0.1 m flecks.
  part.cc = part.fine
    ? (index, axis) => (Math.floor(hullCenter(part, index, axis) / 0.2 + 1e-6) * 0.2 + 0.1) * TITAN_CAMO_SCALE
    : (index, axis) => hullCenter(part, index, axis) * TITAN_CAMO_SCALE;
  part.titanSealed = true;
  return part;
}

// ---- frames and skeletons -------------------------------------------------------------

/**
 * Frame skeletons (README "Modelling notes", hull metres, right side x > 0).
 * Legs are authored straight down from the hip (thigh + shin slightly longer
 * than the hip height, so the standing pose keeps a bent knee for the IK);
 * `ankle` is the ankle (Stryder: hock) joint above the foot's ground contact
 * in the foot frame; `home` is the contact point under the hip at rest.
 */
export const TITAN_FRAMES = Object.freeze({
  // Gait (art review 2): the stride is what the legs reach with a ≤ 0.3 m pelvis drop (half stride
  // ≈ sqrt((0.97 L)² − h²) ≈ 1.05-1.15 m for the heavies), a shorter, quicker swing keeps the ground
  // speed, and a 0.18-0.22 m bob with its low point on the footfall gives the weight. `reach` caps
  // how far a planted foot trails. Feet stand about as wide as the pauldrons (planted heavies).
  atlas: Object.freeze({ height: 7.0, hip: [0.9, 3.4, 0], thigh: 1.3, shin: 1.55, ankle: [0, 0.6, 0], home: [1.0, 0, -0.05],
    waist: [0, 4.1, 0], neck: [0, 6.2, 0.1], shoulder: [1.7, 5.9, 0], foreLen: 1.2, elbowOut: 0.55, elbowBack: 1.2,
    stepTime: 0.62, stepHeight: 0.45, trigger: 0.75, stride: 2.3, reach: 1.2, mass: 1, bob: 0.18 }),
  ogre: Object.freeze({ height: 7.4, hip: [1.05, 3.2, 0], thigh: 1.05, shin: 1.62, ankle: [0, 0.7, 0], home: [1.15, 0, -0.05],
    waist: [0, 3.9, 0], neck: [0, 6.4, 0.1], shoulder: [2.1, 6.0, 0.05], foreLen: 1.4, elbowOut: 0.5,
    stepTime: 0.7, stepHeight: 0.45, trigger: 0.75, stride: 2.2, reach: 1.15, mass: 1.3, bob: 0.22 }),
  stryder: Object.freeze({ height: 7.6, hip: [0.6, 3.8, 0], thigh: 1.25, shin: 1.9, ankle: [0, 0.9, 0.45], home: [0.65, 0, -0.25],
    waist: [0, 4.5, 0], neck: [0, 6.4, -0.05], shoulder: [1.3, 6.25, 0.05], foreLen: 1.2, elbowOut: 0.36,
    stepTime: 0.72, stepHeight: 0.55, trigger: 0.9, stride: 3.5, reach: 1.85, mass: 0.8, bob: 0.22 }),
});

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mirror = p => [-p[0], p[1], p[2]];
const len3 = v => Math.hypot(v[0], v[1], v[2]);

/**
 * The full hull-frame skeleton of one titan type: frame values (override any
 * with `overrides`), the def's mount pivot and every node pivot the parts
 * must be authored with (`skel.pivots[slot]`). Right arm: the elbow rides the
 * mount pitch node (`elbowOut` outboard of the pivot, `elbowBack` behind it), so
 * the forearm, hand and weapon pitch with the aim and the muzzle stays exactly
 * on the server's mountPose; the wrist sits `foreLen` ahead of the elbow.
 */
export function titanSkeleton(type, overrides = {}) {
  const chassis = TITAN_CHASSIS[type];
  const frame = { ...TITAN_FRAMES[chassis], ...overrides };
  const def = vehicleDef(type);
  const mount = Object.values(def.mounts)[0];
  const pivot = [...mount.pivot];
  const hipR = [...frame.hip], hipL = mirror(hipR);
  const kneeR = sub(hipR, [0, frame.thigh, 0]), ankleR = sub(kneeR, [0, frame.shin, 0]);
  const shoulderR = [...frame.shoulder], shoulderL = mirror(shoulderR);
  const elbowR = [pivot[0] + frame.elbowOut, pivot[1], pivot[2] + (frame.elbowBack ?? 0)];
  const upperLen = len3(sub(elbowR, shoulderR));
  const elbowL = sub(shoulderL, [0, upperLen, 0]), wristL = sub(elbowL, [0, frame.foreLen, 0]);
  const wristR = add(elbowR, [0, 0, -frame.foreLen]);
  const hl = def.collider.halfLength;
  const skel = {
    type, chassis, frame, def, mount, mountId: mount.id, muzzle: mount.muzzle, pivot,
    height: frame.height, upperLen, foreLen: frame.foreLen, thigh: frame.thigh, shin: frame.shin,
    hipR, hipL, kneeR, kneeL: mirror(kneeR), ankleR, ankleL: mirror(ankleR),
    shoulderR, shoulderL, elbowR, elbowL, wristR, wristL,
    waist: [...frame.waist], neck: [...frame.neck],
    hatchHinge: overrides.hatchHinge ?? [0, frame.waist[1] + 1.9, -hl * 0.85],
    backAnchor: [...(def.rules.backAnchor ?? [0, frame.waist[1] + 0.5, hl + 0.3])],
    seatHip: [...def.seats[0].position], eye: [...(def.seats[0].camera?.eye ?? [0, frame.height * 0.8, -hl * 0.55])],
  };
  skel.pivots = Object.freeze({
    pelvis: [0, hipR[1], 0], torso: skel.waist, hatch: skel.hatchHinge, head: skel.neck,
    upperL: shoulderL, foreL: elbowL, handL: wristL, upperR: shoulderR, foreR: elbowR, handR: wristR, gun: pivot,
    thighL: hipL, shinL: skel.kneeL, footL: skel.ankleL, thighR: hipR, shinR: kneeR, footR: ankleR,
  });
  return Object.freeze(skel);
}

/**
 * A 0.2 m part at a skeleton slot's pivot. Voxels sit on the hull lattice
 * unless `center` names axes ('x', 'xz', ...) on which the pivot becomes a
 * cell centre, so odd-width boxes (0.6, 1.0 m) centre exactly on the joint.
 */
export function slotPart(skel, slot, name, { center = '' } = {}) {
  const pivot = [...skel.pivots[slot]];
  const grid = pivot.map((value, i) => ('xyz'[i] && center.includes('xyz'[i]) ? mod02(value - 0.1) : 0));
  return new VoxelPart(`${skel.type}-${name}`, { pivot, grid });
}
/** A 0.1 m part at a skeleton slot's pivot (hull 0.1 m lattice, or pivot-centred on `center` axes). */
export function slotFine(skel, slot, name, { center = '' } = {}) {
  const pivot = [...skel.pivots[slot]];
  const part = new FinePart(`${skel.type}-${name}`, pivot);
  if (center) part.grid = Object.freeze(pivot.map((value, i) => (center.includes('xyz'[i]) ? mod02(value - 0.1) : part.grid[i])));
  return part;
}

// ---- shared detail builders ------------------------------------------------------------

const CAMO = material => material === P.camo || material === P.plate;
export const isCamo = CAMO;

/** A rounded joint "ball": a cube with its corner voxels removed (hips, knees, shoulders). */
export function jointBall(part, center, size, material = P.frame, options = {}) {
  const h = size / 2, cut = part.fine ? 0.1 : 0.2;
  part.box(sub(center, [h, h, h]), add(center, [h, h, h]), material, options);
  if (size >= 0.6) for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const corner = [center[0] + sx * (h - cut / 2), center[1] + sy * (h - cut / 2), center[2] + sz * (h - cut / 2)];
    part.carve(sub(corner, [cut / 2, cut / 2, cut / 2]), add(corner, [cut / 2, cut / 2, cut / 2]));
  }
  // A darker axle cap on the outer faces.
  if (options.cap !== false && size >= 0.4) {
    const c = Math.max(cut, size / 3) / 2;
    part.skin([center[0] - h - 0.01, center[1] - c, center[2] - c], [center[0] + h + 0.01, center[1] + c, center[2] + c], P.dark, { normal: [Math.sign(center[0]) || 1, 0, 0] });
  }
  return part;
}

/**
 * Hydraulic piston along one axis: a frame sleeve from `from` for `sleeve`
 * metres and a steel rod on to `to` (axis-aligned; width = cross size).
 */
export function piston(part, from, to, width = 0.2, { sleeve = 0.5, rod = P.steel, body = P.frame, tag = null } = {}) {
  const axis = [0, 1, 2].find(i => Math.abs(to[i] - from[i]) > 1e-6) ?? 1;
  const dir = Math.sign(to[axis] - from[axis]), w = width / 2, r = Math.max(part.fine ? 0.05 : 0.1, w / 2);
  const box = (a, b, half, material) => {
    const lo = [...a], hi = [...a];
    for (let i = 0; i < 3; i++) if (i !== axis) { lo[i] -= half; hi[i] += half; }
    lo[axis] = Math.min(a[axis], b); hi[axis] = Math.max(a[axis], b);
    part.box(lo, hi, material, { tag });
  };
  const split = from[axis] + dir * Math.min(sleeve, Math.abs(to[axis] - from[axis]));
  box(from, split, w, body);
  box([...from.slice(0, axis), split, ...from.slice(axis + 1)], to[axis], r, rod);
  return part;
}

/** Slatted vents: alternating `material` slats painted onto the exposed skin facing `normal`. */
export function vents(part, min, max, normal, { along = 'x', pitch = null, material = P.dark, gap = null } = {}) {
  const a = { x: 0, y: 1, z: 2 }[along], step = pitch ?? (part.fine ? 0.2 : 0.4), width = gap ?? (part.fine ? 0.1 : 0.2);
  for (let t = min[a]; t < max[a] - 1e-6; t += step) {
    const lo = [...min], hi = [...max];
    lo[a] = t; hi[a] = Math.min(max[a], t + width);
    part.skin(lo, hi, material, { normal });
  }
  return part;
}

/** Recessed panel line: carve a 1-voxel groove on the face plane (or paint it `dark` when `paint`). */
export function panelLine(part, min, max, { paint = true, material = P.dark, normal = null } = {}) {
  if (paint) part.skin(min, max, material, normal ? { normal } : {});
  else part.carve(min, max);
  return part;
}

/**
 * Yellow/black hazard band: recolours every voxel inside the hull-metre box
 * in diagonal stripes (`where(material)` filters which voxels take it). The
 * stripes run on the box's face plane (`drop`: the depth axis, default the box's
 * thinnest axis), 0.4 m wide, so thin frames show clean diagonals, never a
 * stair-stepped checker (art review 2).
 */
export function hazardBand(part, min, max, { period = 0.8, a = P.hazard, b = P.dark, where = null, drop = null } = {}) {
  const p = period;
  const extent = [0, 1, 2].map(i => max[i] - min[i]);
  const depth = drop === null ? extent.indexOf(Math.min(...extent)) : { x: 0, y: 1, z: 2 }[drop] ?? drop;
  const hull = (index, axis) => hullCenter(part, index, axis);
  for (const [x, y, z, material] of [...part.voxels()]) {
    const h = [hull(x, 0), hull(y, 1), hull(z, 2)];
    if (h[0] < min[0] || h[0] > max[0] || h[1] < min[1] || h[1] > max[1] || h[2] < min[2] || h[2] > max[2]) continue;
    if (where && !where(material)) continue;
    const sum = h[0] + h[1] + h[2] - h[depth];
    const stripe = Math.floor(sum / (p / 2) + 1000) % 2;
    part.getCell(x, y, z).material = stripe ? a : b;
  }
  return part;
}

/**
 * A solid hazard collar round a cylinder along Z (barrels, launch tubes): every voxel of the part
 * with z in [z0, z1] (and `where(material)`) inside radius `outer` of `center` [x, y] takes
 * `stripes` clean yellow diagonals that wind half a period over the collar's length (art review 2:
 * no spiral of 0.1 m flecks).
 */
export function hazardCollar(part, [cx, cy], z0, z1, { outer = 1, stripes = 4, a = P.hazard, b = P.dark, where = null } = {}) {
  const hull = (index, axis) => hullCenter(part, index, axis);
  const len = Math.max(1e-6, z1 - z0);
  for (const [x, y, z, material] of [...part.voxels()]) {
    const h = [hull(x, 0), hull(y, 1), hull(z, 2)];
    if (h[2] < z0 || h[2] > z1 || Math.hypot(h[0] - cx, h[1] - cy) > outer) continue;
    if (where && !where(material)) continue;
    const turn = (Math.atan2(h[1] - cy, h[0] - cx) / (2 * Math.PI) + 1) % 1;
    const stripe = Math.floor(turn * stripes * 2 + (h[2] - z0) / len) % 2;
    part.getCell(x, y, z).material = stripe ? b : a;
  }
  return part;
}

/** A run of single-voxel bolts (fine parts: 0.1 m heads) on a face. */
export function bolts(part, points, material = P.frame) {
  const v = part.fine ? 0.1 : 0.2;
  for (const p of points) part.box(p, add(p, [v, v, v]), material);
  return part;
}

/**
 * Rodeo battery hatch (README shared parts) on a FinePart whose back face is at
 * `z` (+Z is the back): a 1.0 × 1.2 frame in diagonal hazard stripes, two grab
 * handles and the green cell in the seam. Tagged `battery` (rip-out fragment).
 */
export function batteryHatch(part, center, z, { width = 1.0, height = 1.2, tag = 'battery' } = {}) {
  const [cx, cy] = center, hw = width / 2, hh = height / 2;
  part.box([cx - hw, cy - hh, z - 0.2], [cx + hw, cy + hh, z + 0.1], P.dark, { tag });
  // Hazard frame (0.2 m) round the edge: 0.3 m diagonal stripes, three voxels wide (art review 2:
  // the 0.1 m checker aliased to a checkerboard).
  for (let x = cx - hw; x < cx + hw - 1e-6; x += 0.1) for (let y = cy - hh; y < cy + hh - 1e-6; y += 0.1) {
    const edge = x < cx - hw + 0.15 || x > cx + hw - 0.25 || y < cy - hh + 0.15 || y > cy + hh - 0.25;
    if (!edge) continue;
    const i = Math.round((x - cx + hw) / 0.1), j = Math.round((y - cy + hh) / 0.1);
    const yellow = Math.floor((i + j) / 3) % 2 === 0;
    part.box([x, y, z], [x + 0.1, y + 0.1, z + 0.1], yellow ? P.hazard : P.dark, { tag });
  }
  // Inner plate, the green cell in its seam and two grab handles.
  part.box([cx - hw + 0.2, cy - hh + 0.2, z], [cx + hw - 0.2, cy + hh - 0.2, z + 0.05], P.frame, { tag });
  part.box([cx - 0.1, cy - 0.3, z], [cx + 0.1, cy + 0.3, z + 0.1], P.screen, { tag });
  for (const sx of [-1, 1]) {
    part.box([cx + sx * 0.3 - 0.05, cy - 0.3, z + 0.1], [cx + sx * 0.3 + 0.05, cy + 0.3, z + 0.2], P.frame, { tag });
    part.box([cx + sx * 0.3 - 0.05, cy - 0.3, z + 0.05], [cx + sx * 0.3 + 0.05, cy - 0.2, z + 0.1], P.frame, { tag });
    part.box([cx + sx * 0.3 - 0.05, cy + 0.2, z + 0.05], [cx + sx * 0.3 + 0.05, cy + 0.3, z + 0.1], P.frame, { tag });
  }
  part.userData.priority = { ...part.userData.priority, [tag]: 80 };
  // The cell's outer face (hull metres): assembleTitan puts the battery anchor and its glow here.
  part.userData.batteryCell = [cx, cy, z + 0.15];
  return part;
}

/** Simple voxel cable along a polyline of axis-aligned segments (0.1 m on fine parts). */
export function cable(part, points, material = P.black, width = null) {
  const w = (width ?? (part.fine ? 0.1 : 0.2)) / 2;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    part.box([Math.min(a[0], b[0]) - w, Math.min(a[1], b[1]) - w, Math.min(a[2], b[2]) - w],
      [Math.max(a[0], b[0]) + w, Math.max(a[1], b[1]) + w, Math.max(a[2], b[2]) + w], material);
  }
  return part;
}

/**
 * A flood or tail lamp on a fine part: a 0.3 × 0.2 m gunmetal hood with the lens recessed
 * 0.05 m into it, so it reads as a lens rather than a flare. `face` is the hood's outer face
 * plane (z), `dir` −1 for a lamp facing forward (−Z), +1 facing back; `center` [x, y] is the
 * lens centre on the 0.1 m lattice (x and y at .x5 values: the lens is 0.2 × 0.1 m).
 */
export function lamp(part, [cx, cy], face, dir = -1, material = P.lamp) {
  const z0 = dir < 0 ? face : face - 0.2, z1 = dir < 0 ? face + 0.2 : face;
  part.box([cx - 0.15, cy - 0.1, z0], [cx + 0.15, cy + 0.1, z1], P.frame);
  part.box([cx - 0.15, cy + 0.1, dir < 0 ? face - 0.05 : face - 0.15], [cx + 0.15, cy + 0.15, dir < 0 ? face + 0.15 : face + 0.05], P.frame);
  // The lens sits one fine voxel deep in the hood.
  part.carve([cx - 0.1, cy - 0.05, dir < 0 ? face : face - 0.1], [cx + 0.1, cy + 0.05, dir < 0 ? face + 0.1 : face]);
  part.box([cx - 0.1, cy - 0.05, dir < 0 ? face + 0.05 : face - 0.1], [cx + 0.1, cy + 0.05, dir < 0 ? face + 0.1 : face - 0.05], material);
  return part;
}

/**
 * Plate read (art review): a lighter top bevel (the `plate` coat on the camo voxels of the top
 * layer) and a dark lip along the underside of the plate box `min`..`max`. `outer` (±1) also
 * lightens the outboard top edge strip down the side face.
 */
export function plateEdges(part, min, max, { top = true, under = true, outer = 0 } = {}) {
  const v = part.fine ? 0.1 : 0.2;
  if (top) part.paint([min[0], max[1] - v, min[2]], max, P.plate, { where: m => m === P.camo });
  if (outer) {
    const x0 = outer > 0 ? max[0] - v : min[0], x1 = outer > 0 ? max[0] : min[0] + v;
    part.paint([x0, max[1] - 2 * v, min[2]], [x1, max[1], max[2]], P.plate, { where: m => m === P.camo });
  }
  if (under) part.paint(min, [max[0], min[1] + v, max[2]], P.dark, { where: CAMO });
  return part;
}

/**
 * The hip drive (art review: the hips read as black holes): a gunmetal actuator drum along X
 * through both hip pivots on the pelvis part, `radius` ≈ 0.5 m, plus dark end caps.
 */
export function hipDrive(pelvis, skel, radius = 0.5) {
  const [hx, hy] = skel.hipR;
  const length = Math.round((2 * hx + 0.4) * 5) / 5;
  pelvis.cyl([0, hy, 0], radius, length, 'x', P.frame);
  pelvis.cyl([0, hy, 0], Math.max(0.2, radius - 0.2), length + 0.4, 'x', P.dark);
  return pelvis;
}

/**
 * The cockpit behind the chest hatch (art review: the open hatch showed no cavity): carves a
 * `width` × `height` × `depth` pocket into a 0.2 m torso part from the hatch plane `front` (z)
 * inward, lines it dark, and adds a seat back, a seat pan, a ceiling lamp and two side screens.
 * The embark pilot ends on `part.userData.cockpit` (hull metres, read by assembleTitan).
 */
export function cockpitCavity(part, { front, floor, width = 1.2, height = 1.2, depth = 1.0, x = 0 }) {
  const hw = width / 2, back = front + depth, top = floor + height;
  part.paint([x - hw - 0.2, floor - 0.2, front], [x + hw + 0.2, top + 0.2, back + 0.2], P.dark);
  part.carve([x - hw, floor, front - 0.4], [x + hw, top, back]);
  // Seat back and pan (interior grey), a headrest pad.
  part.box([x - 0.4, floor, back - 0.2], [x + 0.4, top - 0.2, back], P.interior);
  part.box([x - 0.4, floor, back - 0.6], [x + 0.4, floor + 0.2, back - 0.2], P.interior);
  part.box([x - 0.2, top - 0.4, back - 0.4], [x + 0.2, top - 0.2, back - 0.2], P.black);
  // Amber ceiling lamp and two green side screens.
  part.box([x - 0.2, top, front + 0.2], [x + 0.2, top + 0.2, front + 0.4], P.lamp);
  for (const sx of [-1, 1]) part.box([sx < 0 ? x - hw - 0.2 : x + hw, floor + 0.4, front + 0.2], [sx < 0 ? x - hw : x + hw + 0.2, floor + 0.8, front + 0.6], P.screen);
  part.userData.cockpit = [x, floor + 0.2, front + 0.6];
  return part;
}

// ---- rig tuning -----------------------------------------------------------------------------

/** Presentation-only rig constants (docs/titanfall.md §7.1). */
export const TITAN_RIG = Object.freeze({
  fixedStep: 1 / 120,     // s; every rig timer advances on this clock
  sprintStep: 0.7,        // step time factor while sprinting
  idleTrigger: 0.32,      // m; a standing foot steps back home beyond this
  settleDelay: 0.35,      // s standing still before feet square up
  bob: 0.25,              // m, pelvis bob at walk (frame.bob overrides), low point on the footfall
  sway: 0.12,             // m, lateral weight shift over the stance foot
  roll: 0.035,            // rad, hip roll toward the stance foot
  torsoRoll: 3 * Math.PI / 180,   // rad, torso lean over the stance leg
  yawSwing: 4 * Math.PI / 180,    // rad, pelvis yaw with the swinging hip; the torso counter-rotates
  headSteady: 0.5,        // share of the bob the head cancels
  impact: 0.1,            // m, footfall recoil dip (0.1 s)
  swingPitch: 0.17,       // rad, swing foot toe-down at lift-off (≤ 10°)
  heelStrike: 0.105,      // rad, toe-up heel strike before the footfall (6°)
  // Low-ready carry: after `readyDelay` s without a shot, aim input, guard or core the weapon
  // drops (blend `readyIn` s) and snaps back up in `readyOut` s; presentation only.
  readyDelay: 1.2, readyIn: 0.4, readyOut: 0.12, aimActivity: 0.6,
  reach: 0.985,           // of the full leg length the IK keeps
  stand: 0.06,            // m, standing pelvis drop (keeps the knees soft)
  landCrouch: 0.75,       // m, titanfall landing crouch
  embarkCrouch: 1.5,      // m, kneel for embark/disembark
  embarkBow: 0.38,        // rad, torso bow over the low palm (embark 0-30 %)
  doomDrop: 0.35,         // m
  wreckDrop: 1.55,        // m, kneeling wreck
  hatchOpen: 1.25,        // rad
  hatchSeconds: 1.0,
  embarkSeconds: TITAN_RULES.embark.animMs / 1000,   // the server's embark lock (phase 3)
  heroCrouch: 0.55,       // m of extra crouch in the titanfall (phase 2) landing
  heroLean: 22 * Math.PI / 180,   // rad torso lean over the planted fist (≤ 25° with the slump)
  heroKnee: 0.4,          // m, the right (kneeling) knee's height in the three-point landing
  heroHold: 0.4,          // s the landing pose holds after the landed phase ends
  heroRelease: 0.5,       // s to rise out of it
  gaitExcursion: 0.3,     // m, the most the gait (bob, footfall dip, IK reach) lowers the pelvis
  mountFollow: 0.05,      // m, the most the weapon arm follows the gait drop (muzzle contract 0.15 m)
  doomTilt: 6 * Math.PI / 180,    // rad, a doomed torso lists to its damaged (left) side
  doomSparkEvery: 0.4,    // s between doom spark bursts (two joints each)
  hoverTilt: 10 * Math.PI / 180,  // rad, legs swept back under the hover thrusters (art review 2)
  dashLean: 15 * Math.PI / 180,   // rad, torso lean into the dash
  dashSeconds: 0.28,
  recoilTorso: 2 * Math.PI / 180,
  recoilTravel: 0.15,     // m of recoil-node travel that maps to the full torso kick
  legTwist: TITAN_RULES.legTwistLimit,
});

// ---- two-bone IK ---------------------------------------------------------------------------

const _v = Array.from({ length: 12 }, () => new THREE.Vector3());
const _s = Array.from({ length: 9 }, () => new THREE.Vector3());
const _sq = new THREE.Quaternion();
const _q = Array.from({ length: 8 }, () => new THREE.Quaternion());
const _m = new THREE.Matrix4();
const DOWN = new THREE.Vector3(0, -1, 0);
const restBasis = hinge => {
  const h = new THREE.Vector3(...hinge), a = DOWN.clone(), c = new THREE.Vector3().crossVectors(h, a);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(h, a, c)).invert();
};
const REST_LEG = restBasis([1, 0, 0]);
const REST_ARM = restBasis([-1, 0, 0]);

/**
 * Two-bone IK in the parent frame. Both bones are authored straight down
 * (rest direction −Y) and bend about their local X. `root` and `target` are
 * Vector3 in the parent frame, `pole` the bend direction. Writes the first
 * bone's quaternion into `outQ` and returns the second bone's X angle; also
 * reports how far the target was out of reach (`solveTwoBone.miss`).
 */
export function solveTwoBone(root, target, pole, L1, L2, outQ, restInv = REST_LEG) {
  const d = _s[0].subVectors(target, root);
  let dist = d.length();
  const max = L1 + L2 - 1e-4, min = Math.abs(L1 - L2) + 1e-4;
  solveTwoBone.miss = Math.max(0, dist - max);
  if (dist < 1e-6) { d.set(0, -1, 0); dist = 1e-6; }
  const dn = d.multiplyScalar(1 / dist);
  dist = clamp(dist, min, max);
  const b = _s[1].copy(pole).addScaledVector(dn, -pole.dot(dn));
  if (b.lengthSq() < 1e-8) b.set(0, 0, -1).addScaledVector(dn, -dn.z);
  b.normalize();
  const cosA = clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
  const u1 = _s[2].copy(dn).multiplyScalar(cosA).addScaledVector(b, sinA);
  const knee = _s[3].copy(root).addScaledVector(u1, L1);
  const end = _s[4].copy(root).addScaledVector(dn, dist);
  const u2 = _s[5].subVectors(end, knee).normalize();
  const n = _s[6].crossVectors(dn, b).normalize();
  const c = _s[7].crossVectors(n, u1);
  outQ.setFromRotationMatrix(_m.makeBasis(n, u1, c)).multiply(restInv);
  const local = _s[8].copy(u2).applyQuaternion(_sq.copy(outQ).invert());
  return Math.atan2(-local.z, -local.y);
}
solveTwoBone.miss = 0;

// ---- assembly ------------------------------------------------------------------------------

const list = value => (Array.isArray(value) ? value : value ? [value] : []);

/**
 * Build a titan model from its parts (see the slot list in titanSkeleton's
 * pivots). `parts[slot]` is a part or an array of parts authored at that slot's
 * pivot; extra slots: `eye` and `eyeDoom` (under the head, at the head pivot),
 * and `extras: [{ name, parent (slot or extra name), pivot, parts }]` for
 * kit nodes (spinning barrels, shields). Options are VehicleView's
 * `{ team, material, glass, blur }`. `kit` describes anchors:
 *   { lights: [{ kind, slot, point, direction }], thrusters: [{ slot, point, direction }],
 *     sparks: [{ slot, point }], poses: { idle: { wrist, hand, twist }, guard: { wrist, hand, twist } | null } }
 *   (wrist: torso-frame hull metres; hand: wrist pitch, twist: roll about the forearm, rad)
 */
export function assembleTitan(type, options, skel, parts, kitSpec = {}) {
  const { kit } = createKit(type, options);
  const { group } = kit;
  for (const value of Object.values(parts)) for (const part of list(value)) sealTitanPart(part);
  for (const extra of kitSpec.extras || parts.extras || []) for (const part of list(extra.parts)) sealTitanPart(part);
  const nodes = {};
  const meshes = {};
  const attach = (slot, node) => {
    meshes[slot] = list(parts[slot]).map(part => kit.part(node, part));
    return node;
  };
  const S = skel.pivots;
  // Legs and pelvis.
  const pelvis = attach('pelvis', kit.node(group, 'titan-pelvis', S.pelvis));
  const leg = side => {
    const k = side < 0 ? 'L' : 'R';
    const hip = attach(`thigh${k}`, kit.node(pelvis, `titan-hip-${k}`, S[`thigh${k}`]));
    const knee = attach(`shin${k}`, kit.node(hip, `titan-knee-${k}`, S[`shin${k}`]));
    const ankle = attach(`foot${k}`, kit.node(knee, `titan-ankle-${k}`, S[`foot${k}`]));
    const sole = kit.anchor(ankle, `titan-sole-${k}`, sub(S[`foot${k}`], skel.frame.ankle));
    return { side, hip, knee, ankle, sole };
  };
  const left = leg(-1), right = leg(1);
  // Upper body.
  const torso = attach('torso', kit.node(pelvis, 'titan-torso', S.torso));
  const hatch = attach('hatch', kit.node(torso, 'titan-hatch', S.hatch));
  const head = attach('head', kit.node(torso, 'titan-head', S.head));
  meshes.eye = list(parts.eye).map(part => kit.part(head, part));
  meshes.eyeDoom = list(parts.eyeDoom).map(part => kit.part(head, part));
  for (const entry of meshes.eyeDoom) if (entry.mesh) entry.mesh.visible = false;
  const upperL = attach('upperL', kit.node(torso, 'titan-upper-L', S.upperL));
  const foreL = attach('foreL', kit.node(upperL, 'titan-fore-L', S.foreL));
  const handL = attach('handL', kit.node(foreL, 'titan-hand-L', S.handL));
  const upperR = attach('upperR', kit.node(torso, 'titan-upper-R', S.upperR));
  // Weapon arm: hull-frame mount rig (the server's mountPose), following the pelvis bob.
  const mountBase = kit.node(group, 'titan-mount-base', [0, 0, 0]);
  const mountYaw = kit.node(mountBase, 'titan-mount-yaw', S.gun);
  const mountPitch = kit.node(mountYaw, 'titan-mount-pitch', S.gun);
  // Low-ready carry (presentation only): turns the forearm and weapon about the elbow, under the
  // server-aimed pitch node, so the aim itself (and VehicleView's slew) never changes.
  const carry = kit.node(mountPitch, 'titan-carry', skel.elbowR);
  const recoil = attach('gun', kit.node(carry, 'titan-recoil', S.gun));
  const foreR = attach('foreR', kit.node(recoil, 'titan-fore-R', S.foreR));
  const handR = attach('handR', kit.node(foreR, 'titan-hand-R', S.handR));
  Object.assign(nodes, { group, pelvis, torso, hatch, head, upperL, foreL, handL, upperR, mountBase, mountYaw, mountPitch,
    carry, recoil, gun: recoil, foreR, handR, hipL: left.hip, kneeL: left.knee, footL: left.ankle, hipR: right.hip, kneeR: right.knee, footR: right.ankle });
  for (const extra of kitSpec.extras || parts.extras || []) {
    const parent = nodes[extra.parent] || torso;
    const node = kit.node(parent, `titan-${extra.name}`, extra.pivot);
    meshes[extra.name] = list(extra.parts).map(part => kit.part(node, part));
    nodes[extra.name] = node;
  }
  const elbowAnchor = kit.anchor(mountPitch, 'titan-elbow-R', skel.elbowR);
  nodes.elbowAnchor = elbowAnchor;

  const seatAnchors = buildSeatAnchors(kit, type, { body: torso });
  const mounts = buildMounts(kit, type, { [skel.mountId]: { yawNode: mountYaw, pitchNode: mountPitch, recoilNode: recoil } });
  // The muzzle anchors ride the aimed pitch node, not the carry: shots, flashes and tracers
  // (VehicleView.mountWorldPose) always leave from the server's mountPose, even while the
  // weapon is still coming up from the low-ready carry. Recoil and pitch nodes share the gun
  // pivot, so the anchors keep their local positions.
  for (const mount of Object.values(mounts)) for (const muzzle of mount.muzzles) if (muzzle.parent === recoil) mountPitch.add(muzzle);
  const at = (slot, point) => kit.anchor(nodes[slot] || torso, `titan-anchor-${slot}`, point);
  const chestMid = [0, (skel.waist[1] + skel.neck[1]) / 2, 0];
  const lights = (kitSpec.lights || [
    { kind: TITAN_LIGHT_KINDS.flood, slot: 'head', point: add(skel.neck, [0, 0.4, -0.6]) },
  ]).map(light => lightAnchor(kit, nodes[light.slot] || torso, light.kind, light.point, light.direction));
  const emitters = {
    fire: [at('torso', chestMid), at('pelvis', [0, skel.hipR[1] + 0.2, 0.3])],
    // Doom flames on visible surfaces (art review): both pauldron tops, the upper back, one hip.
    doomFire: (kitSpec.doomFire || [
      { slot: 'torso', point: [skel.shoulderR[0], skel.shoulderR[1] + 0.95, 0.1] },
      { slot: 'torso', point: [-skel.shoulderR[0], skel.shoulderR[1] + 0.95, -0.1] },
      { slot: 'torso', point: [0.45, skel.neck[1] - 0.1, skel.backAnchor[2] - 0.2] },
      { slot: 'pelvis', point: [skel.hipR[0] + 0.45, skel.hipR[1] + 0.35, 0.1] },
    ]).map(f => at(f.slot || 'torso', f.point)),
    cookoff: [at('torso', [skel.backAnchor[0], skel.backAnchor[1] + 0.5, skel.backAnchor[2] - 0.4])],
    smoke: [{ node: at('torso', [0, skel.neck[1], 0.5]), direction: [0, 1, 0.4] }],
    dust: [left.sole, right.sole],
    exhaust: [],
    thrusters: (kitSpec.thrusters || []).map(t => ({ node: at(t.slot || 'torso', t.point), direction: t.direction || [0, -0.3, 1] })),
    sparks: (kitSpec.sparks || [
      { slot: 'torso', point: [skel.shoulderR[0] - 0.3, skel.shoulderR[1] - 0.2, -0.4] },
      { slot: 'torso', point: [-skel.shoulderR[0] + 0.3, skel.shoulderR[1] - 0.4, 0.2] },
      { slot: 'hipL', point: skel.kneeL }, { slot: 'hipR', point: skel.kneeR },
    ]).map(s => at(s.slot || 'torso', s.point)),
    lights,
  };
  // The battery cell as authored by batteryHatch (any torso part), else the default back point.
  const cell = list(parts.torso).map(part => part.userData?.batteryCell).find(Array.isArray);
  // The cockpit pocket (cockpitCavity), else a point behind the hatch at the seat height.
  const cockpit = list(parts.torso).map(part => part.userData?.cockpit).find(Array.isArray)
    ?? [0, skel.eye[1] - 1.4, skel.hatchHinge[2] + 0.6];
  // Low-ready carry: the left hand's grip point on the weapon (kitSpec.carry.foregrip, hull metres).
  const foregrip = kitSpec.carry?.foregrip ? kit.anchor(recoil, 'titan-foregrip', kitSpec.carry.foregrip) : null;
  nodes.foregrip = foregrip;
  const anchors = {
    rodeo: at('torso', skel.backAnchor),
    battery: at('torso', cell ?? [skel.backAnchor[0], skel.backAnchor[1] + 0.6, skel.backAnchor[2] - 0.5]),
    hatch: kit.anchor(hatch, 'titan-hatch-mouth', add(skel.hatchHinge, [0, -0.8, -0.3])),
    elbowR: elbowAnchor,
    // Embark: the pilot rides the left palm (the hand hangs from the wrist in the authoring pose).
    palmL: kit.anchor(handL, 'titan-palm-L', add(skel.wristL, [0, -0.3, -0.32])),
    // Ejection and cockpit: the seat (hull frame) and a point on the hatch for the blow-off.
    seat: seatAnchors.driver,
    // Where the embarking pilot ends: on the seat pan inside the open hatch.
    cockpit: at('torso', cockpit),
  };
  // The embark lift brings the palm level with this seat point (it kneels down with the torso).
  nodes.cockpitPoint = anchors.cockpit;
  // Battery glow (VehicleFx light sprites, kind 'battery'): lit while the cell is in.
  lights.push(lightAnchor(kit, torso, 'battery', add(cell ?? anchors.battery.userData.pivot, [0, 0, 0.12]), [0, 0, 1]));
  const contacts = [left, right].map(foot => ({ x: skel.frame.home[0] * foot.side, z: skel.frame.home[2], radius: 0.95,
    stretch: 1.4, strength: 0.65 }));

  const rig = new TitanRig({ type, skel, nodes, legs: [left, right], meshes, contacts, kitSpec });
  // VehicleView sets `visible` on these in and out of the cockpit view: whole nodes where the rig
  // toggles child meshes itself (the head's eye/eyeDoom), the torso's own meshes otherwise.
  const firstPersonHidden = [hatch, head, upperL, upperR];
  for (const entry of meshes.torso || []) if (entry.mesh) firstPersonHidden.push(entry.mesh);
  // The hull frame for presentation overlays (titan cockpit dressing, ability FX).
  group.userData.titanHull = true;
  // A blown hatch (ejection, titan-presentation.js) flies on its own: the wreck's fragments skip it.
  const fragmentSources = () => kit.fragmentSources().filter(source => !(rig.hatchBlown && source.tag === 'hatch'));
  const setWreck = wreck => {
    kit.setWreck(!!wreck);
    if (!wreck) rig.blowHatch(false);
  };
  return finishModel(kit, {
    fragmentSources, setWreck,
    body: torso, turret: torso, gun: mountPitch, barrel: recoil, mounts, seatAnchors, emitters, contacts, anchors,
    animate: (dt, state) => rig.animate(dt, state),
    walker: true, titanRig: true, chassis: skel.chassis, skeleton: skel, rig,
    legs: { node: pelvis, left: { hip: left.hip, knee: left.knee, foot: left.ankle }, right: { hip: right.hip, knee: right.knee, foot: right.ankle } },
    pelvis, upper: torso, torso, head, hatch, nodes,
    arms: { left: upperL, right: mountPitch, gun: recoil },
    floorTop: skel.hipR[1] + 0.4,
    firstPersonHidden,
  });
}

// ---- procedural rig --------------------------------------------------------------------------

const FOOT_SIDES = [-1, 1];
const R_EMBARK_KNEE = 1.0;   // m the knee sinks in the embark kneel (fallback without a knee node)

/**
 * The titan's procedural animation. All state advances on the fixed clock;
 * `animate` only interpolates the hull pose between frames for the substeps
 * and evaluates the current pose at the frame time.
 */
export class TitanRig {
  constructor({ type, skel, nodes, legs, meshes, contacts, kitSpec }) {
    this.type = type;
    this.skel = skel;
    this.nodes = nodes;
    this.legs = legs;
    this.meshes = meshes;
    this.contacts = contacts;
    this.kit = kitSpec;
    this.frame = skel.frame;
    const walk = TITAN_RULES.frames[skel.chassis];
    this.walk = walk;
    this.L1 = skel.thigh; this.L2 = skel.shin;
    // A frame may stand straighter than the shared IK reach (`legReach`, RONIN: idle knee < 12°).
    this.Lmax = (skel.thigh + skel.shin) * (skel.frame.legReach ?? TITAN_RIG.reach);
    this.time = 0; this.sim = 0; this.lastPoseTime = 0;
    this.pose = null;          // { x, y, z, yaw } at this.time
    this.fixedPose = null;     // last fixed-step pose
    this.vel = new THREE.Vector3();
    this.legYaw = 0;
    this.feet = FOOT_SIDES.map(side => ({ side, planted: new THREE.Vector3(), yaw: 0, swing: null, landedAt: -1 }));
    this.lastStepped = 1;
    this.lastFootfall = { t: -10, strength: 0 };
    this.stillFor = 0;
    this.airborne = false;
    this.hatch = 0; this.crouch = 0; this.doom = 0; this.dash = 0; this.dashDir = [0, 0]; this.guard = 0; this.hover = 0;
    this.lastDashPips = null;
    this.landing = 0;
    this.hero = 0;             // titanfall landing (phase 2): fist planted, torso over it
    this.heroHold = 0;         // s the landing pose still holds after the landed phase
    this.embark = 0;           // 0..1 through the embark lock (phase 3): the left hand lifts the pilot in
    this.hatchBlown = false;   // ejected: the hatch flew off (titan-presentation.js)
    this.stepCount = 0;
    this.distance = 0;
    this.drop = TITAN_RIG.stand;
    this.events = [];
    this.debug = { stance: [true, true], miss: [0, 0], excursion: 0 };
    this.probe = null;
    this.restZ = nodes.recoil.position.z;
    // Rest positions of the nodes the rig offsets.
    this.pelvisRest = nodes.pelvis.position.clone();
    this.mountRest = nodes.mountBase.position.clone();
    this.hipLocal = legs.map(leg => leg.hip.position.clone());
    this.headRest = nodes.head.position.clone();
    this.armSwing = 0;
    // Low-ready carry: 1 lowered, 0 aiming; `quiet` counts the time since the last shot/aim/ability.
    this.ready = 0; this.quiet = 0; this.lastAim = null; this.aimRate = 0;
    this.carry = { pitch: -0.35, yaw: 0.3, roll: 0, ...(kitSpec.carry || {}) };
  }

  /** A shot (or an aim/ability input) snaps the weapon up from the low-ready carry. */
  raise(snap = false) {
    this.quiet = 0;
    // A shot also skips most of the snap-up, so the barrel meets the muzzle flash.
    if (snap) this.ready = Math.min(this.ready, 0.3);
  }

  /** Hide (or restore) the hatch after it was blown off; its fragment then flies on its own. */
  blowHatch(blown = true) {
    this.hatchBlown = !!blown;
    for (const entry of this.meshes.hatch || []) if (entry.mesh) entry.mesh.visible = !this.hatchBlown;
  }

  /** Ground height near (x, z) from the probe, else `fallback`. */
  ground(x, z, fallback) {
    const y = this.probe ? this.probe(x, z, fallback) : null;
    return Number.isFinite(y) && Math.abs(y - fallback) < 3 ? y : fallback;
  }

  home(foot, pose, out, ahead = null) {
    const h = this.frame.home, yaw = this.legYaw;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const lx = h[0] * foot.side, lz = h[2];
    out.set(pose.x + lx * c + lz * s, pose.y, pose.z - lx * s + lz * c);
    if (ahead) out.add(ahead);
    out.y = this.ground(out.x, out.z, pose.y);
    return out;
  }

  /**
   * A blink (Phase Dash): for `seconds` the presented hull may jump; the feet follow it to the new
   * spot instead of staying planted where the hull was (no legs stretched back across the gap).
   */
  teleport(seconds = 0.25) { this.blinkFor = Math.max(finite(this.blinkFor), finite(seconds)); }

  resetFeet(pose) {
    this.legYaw = pose.yaw;
    for (const foot of this.feet) { this.home(foot, pose, foot.planted); foot.yaw = pose.yaw; foot.swing = null; }
  }

  _flags(state) {
    const titan = state.titan || decodeTitanRow(state.tw ? { tw: state.tw } : null);
    const phase = finite(state.phase, titan?.phase ?? 0) | 0;
    return {
      titan, phase,
      doomed: !!(titan?.doomed) || phase === TITAN_PHASE.doomed,
      dropping: phase === TITAN_PHASE.dropping,
      landed: phase === TITAN_PHASE.landed,
      hatch: phase === TITAN_PHASE.embark || phase === TITAN_PHASE.disembark || phase === TITAN_PHASE.ejected,
      kneel: phase === TITAN_PHASE.embark || phase === TITAN_PHASE.disembark,
      embark: phase === TITAN_PHASE.embark,
      hover: !!titan?.hover,
      guard: !!titan?.defensiveUp,
      core: !!titan?.coreActive,
      dashPips: Array.isArray(state.tw) ? (state.tw[1] | 0) / 10 : null,
      grounded: state.grounded !== false,
    };
  }

  animate(dt, state = {}) {
    const step = clamp(finite(dt), 0, 0.25);
    this.events.length = 0;
    if (typeof state.probe === 'function') this.probe = state.probe;
    const flags = this._flags(state);
    // Presented hull pose; without one (bare tests) dead-reckon from the speed.
    let pose;
    if (Number.isFinite(state.x) && Number.isFinite(state.z)) {
      pose = { x: state.x, y: finite(state.y), z: state.z, yaw: finite(state.yaw) };
    } else {
      const last = this.pose || { x: 0, y: 0, z: 0, yaw: finite(state.yaw) };
      const yaw = finite(state.yaw, last.yaw), speed = finite(state.speed);
      pose = { x: last.x - Math.sin(yaw) * speed * step, y: last.y, z: last.z - Math.cos(yaw) * speed * step, yaw };
    }
    const jump = this.pose ? Math.hypot(pose.x - this.pose.x, pose.z - this.pose.z) : Infinity;
    if (this.blinkFor > 0) this.blinkFor -= step;
    if (jump > 12 || (this.blinkFor > 0 && jump > 0.5)) {
      this.pose = { ...pose }; this.fixedPose = { ...pose };
      this.vel.set(0, 0, 0);
      this.resetFeet(pose);
    }
    const from = this.pose, t0 = this.time, t1 = this.time + step;
    // Aim activity (row aim, world yaw/pitch) and shots keep the weapon up.
    const aim = Array.isArray(state.mounts?.[0]) ? state.mounts[0] : null;
    if (aim && Number.isFinite(aim[0])) {
      if (this.lastAim && step > 0) {
        const rate = Math.hypot(wrap(aim[0] - this.lastAim[0]), finite(aim[1]) - this.lastAim[1]) / step;
        this.aimRate = Math.max(rate, this.aimRate * Math.exp(-step / 0.25));
      }
      this.lastAim = [aim[0], finite(aim[1])];
    }
    if (state.fired || state.aiming) this.raise();
    if (state.wreck) {
      this.time = t1; this.sim = t1; this.pose = pose; this.fixedPose = pose; this.lastPoseTime = t0;
      this._pose(pose, flags, state, true);
      return;
    }
    const h = TITAN_RIG.fixedStep;
    while (this.sim + h <= t1 + 1e-9) {
      this.sim += h;
      const f = step > 0 ? clamp((this.sim - t0) / step, 0, 1) : 1;
      const yaw = from.yaw + wrap(pose.yaw - from.yaw) * f;
      this._fixed({ x: from.x + (pose.x - from.x) * f, y: from.y + (pose.y - from.y) * f, z: from.z + (pose.z - from.z) * f, yaw }, flags, h);
    }
    this.time = t1;
    this.pose = pose;
    this.lastPoseTime = t0;
    this._pose(pose, flags, state, false);
    if (Array.isArray(state.events)) state.events.push(...this.events);
  }

  _fixed(pose, flags, h) {
    const t = this.sim;
    const last = this.fixedPose;
    const kv = 1 - Math.exp(-h / 0.12);
    // A Phase Dash blink (8 m in one tick) or a snapshot hitch reads as a dash at most: the
    // measured ground speed is capped a little above the dash speed (no limb whip, no face-plant).
    let vx = (pose.x - last.x) / h, vz = (pose.z - last.z) / h;
    const cap = this.walk.dash.speed * 1.15, measured = Math.hypot(vx, vz);
    if (measured > cap) { vx *= cap / measured; vz *= cap / measured; }
    this.vel.x += (vx - this.vel.x) * kv;
    this.vel.y += ((pose.y - last.y) / h - this.vel.y) * kv;
    this.vel.z += (vz - this.vel.z) * kv;
    this.distance += Math.hypot(pose.x - last.x, pose.z - last.z);
    this.fixedPose = pose;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    // Legs chase the hull yaw at the frame's leg turn rate, never more than the twist limit behind.
    const turn = this.walk.legTurn * h;
    this.legYaw = wrap(this.legYaw + clamp(wrap(pose.yaw - this.legYaw), -turn, turn));
    const twist = wrap(pose.yaw - this.legYaw);
    if (Math.abs(twist) > TITAN_RIG.legTwist) this.legYaw = wrap(pose.yaw - Math.sign(twist) * TITAN_RIG.legTwist);
    // Timers.
    const ramp = (value, on, seconds) => clamp(value + (on ? h : -h) / seconds, 0, 1);
    // Embark: the hatch opens 40-55 % through the lock and closes over the last 15 %;
    // disembark and eject open it on their own ramp.
    if (flags.embark) {
      const e = this.embark;
      const goal = e < 0.4 ? 0 : e < 0.55 ? smooth((e - 0.4) / 0.15) : e < 0.85 ? 1 : 1 - smooth((e - 0.85) / 0.15);
      this.hatch = goal;
    } else this.hatch = ramp(this.hatch, flags.hatch, flags.hatch ? 0.35 : TITAN_RIG.hatchSeconds);
    this.crouch = ramp(this.crouch, flags.kneel, 0.6);
    this.doom = ramp(this.doom, flags.doomed, 0.8);
    this.hover = ramp(this.hover, flags.hover, 0.5);
    this.guard = ramp(this.guard, flags.guard, 0.18);
    this.landing = Math.max(0, this.landing - h);
    if (flags.landed && this.landing <= 0 && !this._landedSeen) { this.landing = 1.0; this._landedSeen = true; }
    if (!flags.landed && !flags.dropping) this._landedSeen = false;
    // Titanfall landing: slam into the fist fast, hold it a moment after the landed phase ends,
    // then rise.
    if (flags.landed) { this.hero = clamp(this.hero + h / 0.12, 0, 1); this.heroHold = TITAN_RIG.heroHold; }
    else if ((this.heroHold ?? 0) > 0) this.heroHold -= h;
    else this.hero = clamp(this.hero - h / TITAN_RIG.heroRelease, 0, 1);
    // Embark: one pass through the lock; it rewinds as soon as the phase ends.
    this.embark = flags.embark ? Math.min(1, this.embark + h / TITAN_RIG.embarkSeconds) : 0;
    // Low-ready: lowered after a quiet spell, snapped up by shots, aim input, guard, core or embark.
    const kick = this.nodes.recoil.position.z - this.restZ;
    if (kick > 0.01 || this.aimRate > TITAN_RIG.aimActivity || flags.guard || flags.core || flags.embark || flags.dropping) this.quiet = 0;
    else this.quiet += h;
    const lowered = this.quiet > TITAN_RIG.readyDelay && !flags.doomed;
    this.ready = clamp(this.ready + (lowered ? h / TITAN_RIG.readyIn : -h / TITAN_RIG.readyOut), 0, 1);
    // Dash: a spent pip or a burst above sprint speed.
    const pips = flags.dashPips;
    const spent = pips !== null && this.lastDashPips !== null && pips <= this.lastDashPips - 0.5;
    if (pips !== null) this.lastDashPips = pips;
    if ((spent || speed > this.walk.sprint * 1.35) && this.dash <= 0.05 && speed > 2) {
      this.dash = 1;
      this.dashDir = [this.vel.x / Math.max(speed, 1e-6), this.vel.z / Math.max(speed, 1e-6)];
      this.events.push({ type: 'dash', dir: [this.dashDir[0], 0, this.dashDir[1]], strength: 1 });
    }
    if (speed > this.walk.sprint * 1.2 && this.dash > 0) this.dash = Math.max(this.dash, 0.6);
    this.dash = Math.max(0, this.dash - h / (TITAN_RIG.dashSeconds + 0.22));
    // Airborne (drop, hover, falling): feet hang under the hips.
    const airborne = flags.dropping || flags.hover || !flags.grounded;
    if (this.airborne && !airborne) {
      // Touchdown: the feet plant on the ground under the hull, not where they hung.
      for (const foot of this.feet) { this.home(foot, pose, foot.planted); foot.swing = null; }
      this.landing = flags.dropping ? this.landing : Math.max(this.landing, 0.45);
      const strength = flags.landed ? 2 : 1.3;
      this.events.push({ type: 'land', x: pose.x, y: pose.y, z: pose.z, strength });
      this.lastFootfall = { t, strength: strength * 0.8 };
      if (flags.landed) this.landing = 1.0;
    }
    this.airborne = airborne;
    const tmp = _v[9], home = _v[10];
    if (airborne) {
      for (const foot of this.feet) {
        this.home(foot, pose, foot.planted); foot.planted.y = pose.y; foot.yaw = this.legYaw; foot.swing = null;
      }
      this.stillFor = 0;
      return;
    }
    // Dash skid: feet drag with the hull, kicking up dust.
    if (this.dash > 0.35) {
      const k = 1 - Math.exp(-h * 9);
      for (const foot of this.feet) {
        if (foot.swing) { foot.planted.copy(foot.swing.to); foot.swing = null; }
        this.home(foot, pose, home);
        foot.planted.lerp(home, k);
        foot.yaw += wrap(this.legYaw - foot.yaw) * k;
      }
      if (Math.floor(t * 14) !== Math.floor((t - h) * 14)) {
        const foot = this.feet[Math.floor(t * 14) % 2];
        this.events.push({ type: 'skid', side: foot.side, x: foot.planted.x, y: foot.planted.y, z: foot.planted.z, strength: 0.7 });
      }
      return;
    }
    // Planted feet follow the ground under them (a hull that settles after a drop, a platform).
    for (const foot of this.feet) {
      if (foot.swing) continue;
      const g = this.ground(foot.planted.x, foot.planted.z, pose.y);
      if (Math.abs(g - foot.planted.y) > 0.02) foot.planted.y += (g - foot.planted.y) * (1 - Math.exp(-h * 14));
    }
    const sprinting = speed > (this.walk.walk + this.walk.sprint) / 2;
    const moving = speed > 0.6;
    this.stillFor = moving ? 0 : this.stillFor + h;
    const dur = this.frame.stepTime * (sprinting ? TITAN_RIG.sprintStep : 1);
    const vdirX = moving ? this.vel.x / speed : 0, vdirZ = moving ? this.vel.z / speed : 0;
    // Feet land half a stride ahead of the hull (less at a stroll), so a planted foot sweeps from
    // +stride/2 to −stride/2 under the hips.
    const leadLen = Math.min(this.frame.stride / 2, speed * 0.36);
    // Swinging feet: retarget early in the swing, land at the end.
    for (const foot of this.feet) {
      const swing = foot.swing;
      if (!swing) continue;
      if (moving) {
        // Hurry the swing when the pace picks up, so the planted foot can lift before it trails
        // past its reach (the next step starts at 88 % of this one).
        const other = this.feet.find(f => f !== foot);
        if (!other.swing) {
          const ahead = (other.planted.x - pose.x) * vdirX + (other.planted.z - pose.z) * vdirZ;
          const limit = (t - swing.t0 + Math.max(0, (this.frame.reach + ahead) / speed)) / 0.88;
          swing.dur = Math.min(swing.dur, Math.max(limit, t - swing.t0 + 0.1, 0.28));
        }
      }
      const p = (t - swing.t0) / swing.dur;
      if (p < 0.7) {
        const remain = Math.max(0, swing.dur * (1 - p));
        this.home(foot, { x: pose.x + this.vel.x * remain, y: pose.y, z: pose.z + this.vel.z * remain, yaw: pose.yaw }, swing.to,
          tmp.set(vdirX * leadLen, 0, vdirZ * leadLen));
        swing.toYaw = this.legYaw;
      }
      if (p >= 1) {
        foot.planted.copy(swing.to); foot.yaw = swing.toYaw; foot.swing = null; foot.landedAt = t;
        const strength = clamp(0.35 + speed / 7, 0.35, 1.2) * this.frame.mass;
        this.lastFootfall = { t, strength };
        this.stepCount++;
        this.events.push({ type: 'footfall', side: foot.side, x: foot.planted.x, y: foot.planted.y, z: foot.planted.z, strength });
      }
    }
    // Planted feet: pick the one that has to step.
    const swinging = this.feet.find(foot => foot.swing);
    let best = null, bestErr = 0;
    for (const foot of this.feet) {
      if (foot.swing) continue;
      this.home(foot, pose, home);
      const ex = foot.planted.x - home.x, ez = foot.planted.z - home.z, err = Math.hypot(ex, ez);
      const yawErr = Math.abs(wrap(foot.yaw - this.legYaw));
      let need;
      if (moving) {
        const along = ex * vdirX + ez * vdirZ;
        need = (err > this.frame.trigger && along < 0.25 * this.frame.trigger) || err > this.frame.trigger * 1.7;
      } else {
        need = err > TITAN_RIG.idleTrigger || yawErr > 0.3 || (this.stillFor > TITAN_RIG.settleDelay && (err > 0.1 || yawErr > 0.08));
      }
      if (!need) continue;
      const score = err + yawErr + (foot.side === this.lastStepped ? -0.05 : 0.05);
      if (score > bestErr) { best = foot; bestErr = score; }
    }
    const overlapOk = swinging && (t - swinging.swing.t0) / swinging.swing.dur > 0.88;
    if (best && (!swinging || overlapOk)) {
      const settle = !moving;
      let d = settle ? Math.min(0.45, this.frame.stepTime * 0.6) : Math.min(dur, this.frame.stride / (speed * 0.88));
      if (moving) {
        // Never let the other (planted) foot trail past its reach while this one swings: the first
        // step from a standstill is short and quick, the walk settles into full strides.
        const other = this.feet.find(foot => foot !== best), at = other.swing ? other.swing.to : other.planted;
        const ahead = (at.x - pose.x) * vdirX + (at.z - pose.z) * vdirZ;
        d = Math.max(0.28, Math.min(d, (this.frame.reach + ahead) / speed));
      }
      const to = new THREE.Vector3();
      this.home(best, { x: pose.x + this.vel.x * d, y: pose.y, z: pose.z + this.vel.z * d, yaw: pose.yaw }, to,
        tmp.set(vdirX * leadLen, 0, vdirZ * leadLen));
      const travel = Math.hypot(to.x - best.planted.x, to.z - best.planted.z);
      best.swing = { from: best.planted.clone(), fromYaw: best.yaw, to, toYaw: this.legYaw, t0: t, dur: d,
        lift: this.frame.stepHeight * clamp(travel / 1.6, 0.3, 1) };
      this.lastStepped = best.side;
    }
  }

  /** Current world position and yaw of a foot's ground contact at time `t`. */
  footAt(foot, t, out) {
    const swing = foot.swing;
    if (!swing) { out.copy(foot.planted); return { yaw: foot.yaw, pitch: 0, lift: 0 }; }
    const p = clamp((t - swing.t0) / swing.dur, 0, 1), e = smooth(p);
    out.lerpVectors(swing.from, swing.to, e);
    const arc = Math.sin(Math.PI * p);
    out.y += arc * swing.lift + Math.max(0, swing.to.y - swing.from.y) * arc * 0.5;
    // A nearly flat swing foot: toe down ≤ 10° at lift-off, a 6° toe-up heel strike before the footfall.
    const k = Math.min(1, swing.lift / 0.3);
    const pitch = p < 0.55 ? -TITAN_RIG.swingPitch * Math.sin(Math.PI * p / 0.55) * k
      : TITAN_RIG.heelStrike * Math.sin(Math.PI * Math.min(1, (p - 0.55) / 0.45)) * k;
    return { yaw: swing.fromYaw + wrap(swing.toYaw - swing.fromYaw) * e, pitch, lift: arc };
  }

  _pose(pose, flags, state, wreck) {
    const n = this.nodes, R = TITAN_RIG, t = this.time;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const amp = clamp(speed / this.walk.walk, 0, 1.25) * (this.dash > 0.35 ? 0 : 1);
    const cy = Math.cos(pose.yaw), sy = Math.sin(pose.yaw);
    const toHull = (p, out) => {
      const dx = p.x - pose.x, dz = p.z - pose.z;
      return out.set(dx * cy - dz * sy, p.y - pose.y, dx * sy + dz * cy);
    };
    // Gait: bob (low point on the footfall), sway and roll over the stance foot, hip yaw with
    // the swinging leg (the torso counter-rotates), a short recoil dip on every footfall.
    const swinging = this.feet.find(foot => foot.swing);
    const B = this.frame.bob ?? R.bob;
    let bob = 0, sway = 0, roll = 0, lean = 0;
    if (!wreck && !this.airborne) {
      if (swinging) {
        const p = clamp((t - swinging.swing.t0) / swinging.swing.dur, 0, 1), arc = Math.sin(Math.PI * p);
        const gait = Math.min(1, amp + 0.25);
        bob = B * Math.min(1, amp) * (arc * 2 - 1) * 0.5;
        sway = -swinging.side * R.sway * gait * arc;
        roll = swinging.side * R.roll * gait * arc;
        lean = swinging.side * R.torsoRoll * gait * arc;
        this.swingYaw = swinging.side * R.yawSwing * Math.min(1, amp) * (2 * smooth(p) - 1);
      } else bob = -B * Math.min(1, amp) * 0.5;
      if (!(amp > 0.05)) this.swingYaw = (this.swingYaw ?? 0) * 0.9;
      const since = t - this.lastFootfall.t;
      if (since >= 0 && since < 0.4) bob -= R.impact * Math.min(1.4, this.lastFootfall.strength) * Math.sin(Math.min(1, since / 0.1) * Math.PI) * (since < 0.1 ? 1 : Math.exp(-(since - 0.1) / 0.08));
    }
    const swingYaw = wreck || this.airborne ? 0 : (this.swingYaw ?? 0);
    // Doom stagger and wreck slump.
    const doom = wreck ? 1 : this.doom;
    const stagger = doom * (Math.sin(t * 2.3) * 0.045 + Math.sin(t * 5.1) * 0.02);
    const landing = this.landing > 0 ? Math.sin(Math.min(1, this.landing) * Math.PI * 0.5) : 0;
    const hero = wreck ? 0 : smooth(this.hero);
    // Three-point titanfall landing: the hips drop until the trailing knee nearly touches down.
    const heroDrop = this.skel.hipR[1] - R.heroKnee - this.L1 * 0.97;
    const crouch = Math.max(landing * R.landCrouch, smooth(this.crouch) * R.embarkCrouch, hero * heroDrop);
    let drop = R.stand + crouch + doom * R.doomDrop + (wreck ? R.wreckDrop : 0) - bob;
    // Dash lean along the dash direction (hull frame).
    const dashAmt = Math.sin(Math.min(1, this.dash) * Math.PI * 0.5);
    const dlx = this.dashDir[0] * cy - this.dashDir[1] * sy, dlz = this.dashDir[0] * sy + this.dashDir[1] * cy;
    const leanX = -dlz * R.dashLean * dashAmt, leanZ = -dlx * R.dashLean * dashAmt;
    // Feet for this frame (hull frame) and the reach drop that keeps them planted.
    const pelvisYaw = this.airborne || wreck ? wrap(this.legYaw - pose.yaw) * 0.5 : wrap(this.legYaw - pose.yaw);
    const qPelvis = _q[0].setFromEuler(new THREE.Euler(leanX * 0.6, pelvisYaw + swingYaw, roll + stagger + leanZ * 0.6, 'YXZ'));
    const pelvisPos = _v[11].set(this.pelvisRest.x + sway * Math.cos(pelvisYaw), this.pelvisRest.y, this.pelvisRest.z - sway * Math.sin(pelvisYaw));
    const feet = this.feet.map(foot => {
      const world = new THREE.Vector3();
      const info = this.footAt(foot, t, world);
      if (this.airborne) world.y = pose.y + 0.35;
      const local = toHull(world, new THREE.Vector3());
      // Hover: the hanging feet swing back under the thrusters (rotation about the hips).
      if (this.airborne && this.hover > 0) local.z += (this.skel.hipR[1] - local.y) * Math.tan(R.hoverTilt * smooth(this.hover));
      const yawRel = wrap(info.yaw - pose.yaw);
      const qFoot = new THREE.Quaternion().setFromEuler(new THREE.Euler(info.pitch, yawRel, 0, 'YXZ'));
      const ankle = new THREE.Vector3(...this.frame.ankle).applyQuaternion(qFoot).add(local);
      // Titanfall landing (three points: left fist, left foot, right knee): the left foot planted
      // ahead, the right shin folded back under the hips with its knee `heroKnee` off the ground.
      if (hero > 0 && !this.airborne) {
        const kneel = foot.side > 0;
        const goal = _v[7].set(this.frame.home[0] * foot.side * 1.1, kneel ? R.heroKnee + 0.15 : this.frame.ankle[1],
          kneel ? this.L2 * 0.97 : -0.85);
        ankle.lerp(goal, hero);
      }
      return { foot, local, ankle, qFoot, stance: !foot.swing && !this.airborne, lift: info.lift };
    });
    for (const f of feet) {
      if (!f.stance && f.lift > 0.3) continue;
      const hip = _v[9].copy(this.hipLocal[f.foot.side < 0 ? 0 : 1]).applyQuaternion(qPelvis).add(pelvisPos);
      const horiz = Math.hypot(hip.x - f.ankle.x, hip.z - f.ankle.z);
      const vertical = horiz < this.Lmax ? Math.sqrt(this.Lmax * this.Lmax - horiz * horiz) : 0;
      // A stance foot must be reached; a foot just lifting off or touching down (it may be far out
      // after a reversal) only pulls the hips down a little and otherwise hangs short.
      const need = hip.y - (f.ankle.y + vertical);
      drop = Math.max(drop, f.stance ? need : Math.min(need, drop + 0.2));
    }
    // Gait excursion below the pose's own drop (bob, footfall dip, IK reach): the frames' strides
    // keep it within `gaitExcursion` (art review 2: a longer reach reads as a squat, not a stride);
    // the budget test pins it. Stance feet are always reached.
    const poseDrop = R.stand + crouch + doom * R.doomDrop + (wreck ? R.wreckDrop : 0);
    drop = clamp(drop, -0.3, R.wreckDrop + R.landCrouch + 0.5);
    if (!this.airborne && hero < 0.01 && !wreck) this.debug.excursion = Math.max(0, drop - poseDrop);
    pelvisPos.y -= drop;
    n.pelvis.position.copy(pelvisPos);
    n.pelvis.quaternion.copy(qPelvis);
    // Weapon arm: the muzzle anchors ride it, so while the titan can fire it stays on the server's
    // mountPose (§7.1, 0.15 m): it ignores the doom drop, follows at most `mountFollow` of the gait
    // (bob, footfall dip, reach, landing crouch; the upper arm aims at the elbow and absorbs the
    // rest) and a quarter of the sway. The scripted, weaponless poses (titanfall landing, embark
    // kneel, wreck) carry it all the way down.
    const scripted = Math.max(smooth(this.crouch) * R.embarkCrouch, hero * heroDrop) + (wreck ? R.wreckDrop + R.doomDrop : 0);
    const follow = scripted + clamp(drop - R.stand - scripted - (wreck ? 0 : doom * R.doomDrop), -R.mountFollow, R.mountFollow);
    n.mountBase.position.set(this.mountRest.x + (pelvisPos.x - this.pelvisRest.x) * 0.25, this.mountRest.y - follow, this.mountRest.z + (pelvisPos.z - this.pelvisRest.z) * 0.25);
    // Legs: IK in the pelvis frame, feet oriented to their planted yaw.
    const qInv = _q[1].copy(qPelvis).invert();
    const pole = _v[8];
    feet.forEach((f, i) => {
      const leg = this.legs[i];
      const target = f.ankle.clone().sub(pelvisPos).applyQuaternion(qInv);
      pole.set(f.foot.side * 0.12, 0, -1).applyQuaternion(_q[2].setFromEuler(new THREE.Euler(0, wrap(f.foot.yaw - this.legYaw) * 0.5, 0)));
      const root = leg.hip.position;
      const angle = solveTwoBone(root, target, pole, this.L1, this.L2, leg.hip.quaternion, REST_LEG);
      this.debug.miss[i] = solveTwoBone.miss;
      leg.knee.rotation.set(angle, 0, 0);
      const qChain = _q[3].copy(leg.hip.quaternion).multiply(leg.knee.quaternion);
      leg.ankle.quaternion.copy(qChain.invert()).multiply(qInv).multiply(f.qFoot);
      this.debug.stance[i] = f.stance;
      const c = this.contacts[i];
      if (c) { c.x = f.local.x; c.z = f.local.z; c.strength = f.stance ? 0.7 : 0.35; }
    });
    // Torso: twist to the mount yaw, counter-roll, recoil kick, aim pitch, doom slump.
    const aimYaw = n.mountYaw.rotation.y, aimPitch = n.mountPitch.rotation.x;
    const kick = clamp((n.recoil.position.z - this.restZ) / R.recoilTravel, 0, 1.5);
    // The crouch slump comes from the landing/embark kneel, not the hero drop (that has its own lean).
    const slump = doom * 0.16 + (wreck ? 0.3 : 0) + Math.max(landing * R.landCrouch, smooth(this.crouch) * R.embarkCrouch) * 0.12 * (1 - hero);
    // Embark: the torso bows over the low palm while the pilot steps on.
    const e = wreck ? 0 : this.embark;
    const bow = e <= 0 ? 0 : e < 0.15 ? smooth(e / 0.15) : e < 0.3 ? 1 : e < 0.6 ? 1 - smooth((e - 0.3) / 0.3) : 0;
    const torsoPitch = clamp(aimPitch, -0.6, 0.5) * 0.18 - kick * R.recoilTorso + leanX * 0.5 - slump - hero * R.heroLean - bow * R.embarkBow;
    const list = (wreck ? 0 : doom) * R.doomTilt;
    n.torso.rotation.set(torsoPitch, aimYaw - pelvisYaw - 2 * swingYaw, lean - roll - stagger * 0.5 + leanZ * 0.5 + list, 'YXZ');
    // The head stays up over the planted fist (it looks where it lands).
    n.head.rotation.set(clamp(aimPitch, -0.6, 0.5) * 0.45 - doom * 0.15 - (wreck ? 0.25 : 0) + hero * R.heroLean * 0.8, 0, 0);
    // The head cancels half the bob (a steadier optic).
    n.head.position.y = this.headRest.y - R.headSteady * bob;
    n.hatch.rotation.set(smooth(this.hatch) * R.hatchOpen, 0, 0);
    // Low-ready carry about the elbow (never while doomed, wrecked or in a scripted reach).
    const carry = wreck ? 0 : smooth(this.ready) * (1 - hero);
    n.carry.rotation.set(this.carry.pitch * carry, this.carry.yaw * carry, (this.carry.roll ?? 0) * carry, 'YXZ');
    // Doom: the optic stutters (on about 70 % of 6-10 Hz random slots) between its own colour and
    // the red doom lens; spark bursts from two joints every `doomSparkEvery` s.
    const slot = Math.floor(t * 8), noise = Math.abs(Math.sin(slot * 12.9898 + 78.233) * 43758.5453) % 1;
    const flicker = doom > 0.01 && !wreck && noise < 0.3;
    for (const entry of this.meshes.eye || []) if (entry.mesh) entry.mesh.visible = !wreck && !flicker && doom < 0.98;
    for (const entry of this.meshes.eyeDoom || []) if (entry.mesh) entry.mesh.visible = !wreck && (flicker || doom >= 0.98);
    const every = R.doomSparkEvery;
    if (doom > 0.5 && !wreck && Math.floor(t / every) !== Math.floor(this.lastPoseTime / every)) {
      const k = Math.floor(t / every);
      this.events.push({ type: 'sparks', index: (k * 2) % 4, burst: true }, { type: 'sparks', index: (k * 2 + 1) % 4, burst: true });
    }
    // Arms.
    this._arms(feet, pose, amp, doom, wreck, hero);
  }

  _arms(feet, pose, amp, doom, wreck, hero = 0) {
    const n = this.nodes, skel = this.skel;
    n.group.updateMatrixWorld(true);
    // Right upper arm: aim from the shoulder at the elbow on the mount pitch axis.
    const elbow = n.torso.worldToLocal(n.elbowAnchor.getWorldPosition(_v[0]));
    n.upperR.quaternion.setFromUnitVectors(DOWN, elbow.sub(n.upperR.position).normalize());
    // Left arm: two-bone IK to a wrist target in the torso frame.
    const swing = feet.length === 2 ? clamp((feet[1].local.z - feet[0].local.z) * 0.22, -0.45, 0.45) * Math.min(1, amp) : 0;
    this.armSwing = swing;
    const S = skel.shoulderL, w = skel.waist;
    const idle = this.kit.poses?.idle ?? { wrist: [S[0] - 0.12, S[1] - 2.55, S[2] - 0.95], hand: 0.35 };
    const guardPose = this.kit.poses?.guard === null ? null : this.kit.poses?.guard ?? { wrist: [S[0] + 0.9, S[1] - 0.85, S[2] - 2.35], hand: -1.25 };
    const g = guardPose ? smooth(this.guard) : 0;
    const limp = Math.max(doom * 0.6, wreck ? 1 : 0);
    const wx = idle.wrist[0] + ((guardPose?.wrist[0] ?? 0) - idle.wrist[0]) * g + limp * -0.1;
    const wy = idle.wrist[1] + ((guardPose?.wrist[1] ?? 0) - idle.wrist[1]) * g - limp * 0.25;
    const wz = idle.wrist[2] + ((guardPose?.wrist[2] ?? 0) - idle.wrist[2]) * g + swing * (1 - g) + limp * 0.55;
    // Scripted reaches (torso-frame hull metres, like the poses): the titanfall landing plants
    // the fist by the left foot; the embark lifts the pilot from the ground to the hatch.
    let goal = [wx, wy, wz], palmUp = 0, fist = 0;
    const lerp3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    const fromHull = p => {
      const v = n.torso.worldToLocal(n.group.localToWorld(_v[3].set(p[0], p[1], p[2])));
      return [v.x + w[0], v.y + w[1], v.z + w[2]];
    };
    const hl = skel.def.collider.halfLength;
    // Low-ready: the left hand reaches for the weapon's fore-grip (two-handed carry).
    const carry = wreck ? 0 : smooth(this.ready) * (1 - hero) * (1 - g) * (this.carry.foregrip ? 1 : 0);
    if (carry > 0 && n.foregrip) {
      const grip = n.torso.worldToLocal(n.foregrip.getWorldPosition(_v[3]));
      goal = lerp3(goal, [grip.x + w[0], grip.y + w[1], grip.z + w[2]], carry * 0.9);
    }
    if (!wreck && hero > 0) {
      // The left fist planted on the ground (knuckles 0.1 m up) beside the left foot.
      goal = lerp3(goal, fromHull([S[0] + 0.1, 0.1 + 0.45, -(hl + 0.35)]), hero);
      fist = hero;
    }
    const e = wreck ? 0 : this.embark;
    if (e > 0) {
      // Embark (art review 2): the open palm comes down OUTBOARD of the left leg (the pilot never
      // stands in the thigh), the pilot steps on (15-30 %), it rises outboard until it is well above
      // the kneeling knee (30-46 %), only then swings in front of the chest, level with the cockpit
      // floor ≥ 0.9 m ahead of the hull (46-60 %), holds while the pilot steps in, and returns.
      const hipX = Math.abs(skel.hipL[0]), outX = -(hipX + 0.7 + 1.25);
      const knee = n.kneeL ? this._hullPoint(n.kneeL, skel.kneeL) : [skel.kneeL[0], skel.kneeL[1] - R_EMBARK_KNEE, -0.6];
      const low = fromHull([outX, 1.35, -(hl * 0.35)]);
      const high = fromHull([outX, Math.max(knee[1] + 0.8 + 0.5, 1.35), -(hl * 0.35)]);
      let lift;
      if (n.cockpitPoint) {
        const c = n.torso.worldToLocal(n.cockpitPoint.getWorldPosition(_v[3]));
        lift = [c.x + S[0] * 0.15 + w[0], c.y - 0.25 + w[1], c.z - 1.9 + w[2]];
      } else {
        const mouth = add(skel.hatchHinge, [0, -0.8, -0.3]);
        lift = fromHull([S[0] * 0.15, Math.min(5.0, mouth[1] - 0.6) + 0.35, -(hl + 1.25)]);
      }
      // The swing in keeps the palm ahead of the hull front by ≥ 0.9 m.
      const front = fromHull([outX * 0.6, (high[1] + lift[1]) / 2, -(hl + 0.9)]);
      if (e < 0.15) { const k = smooth(e / 0.15); goal = lerp3(goal, low, k); palmUp = k; }
      else if (e < 0.3) { goal = low; palmUp = 1; }
      else if (e < 0.46) { goal = lerp3(low, high, smooth((e - 0.3) / 0.16)); palmUp = 1; }
      else if (e < 0.6) {
        const k = smooth((e - 0.46) / 0.14);
        goal = k < 0.5 ? lerp3(high, front, k * 2) : lerp3(front, lift, k * 2 - 1); palmUp = 1;
      } else if (e < 0.8) { goal = lift; palmUp = 1; }
      else { const k = smooth((e - 0.8) / 0.2); goal = lerp3(lift, goal, k); palmUp = 1 - k; }
    }
    const target = _v[1].set(goal[0] - w[0], goal[1] - w[1], goal[2] - w[2]);
    const pole = _v[2].set(-0.45, -0.1, 1).normalize();
    const angle = solveTwoBone(n.upperL.position, target, pole, skel.upperLen, skel.foreLen, n.upperL.quaternion, REST_ARM);
    n.foreL.rotation.set(angle, 0, 0);
    const handPitch = (idle.hand ?? 0) + (((guardPose?.hand) ?? 0) - (idle.hand ?? 0)) * g;
    const handTwist = (idle.twist ?? 0) + (((guardPose?.twist) ?? 0) - (idle.twist ?? 0)) * g;
    n.handL.rotation.set(handPitch, handTwist, 0, 'YXZ');
    // Palm up (a level platform for the pilot) or knuckles down (the planted fist), in the hull frame.
    if (palmUp > 0) this._orientHand([0, 0, -1], [0, 1, 0], palmUp);
    else if (fist > 0) this._orientHand([0, -1, 0], [0, 0, 1], fist);
  }

  /** A node's world position in the hull frame (model group space), else `fallback`. */
  _hullPoint(node, fallback) {
    if (!node) return fallback;
    const v = this.nodes.group.worldToLocal(node.getWorldPosition(_v[7]));
    return [v.x, v.y, v.z];
  }

  /**
   * Turn the left hand toward a hull-frame orientation: fingers (hand −Y) along
   * `fingers`, palm (hand −Z) facing `palm`; `weight` slerps from the pose.
   */
  _orientHand(fingers, palm, weight) {
    const n = this.nodes;
    n.handL.updateMatrixWorld(true);
    const y = _v[4].set(-fingers[0], -fingers[1], -fingers[2]);
    const z = _v[5].set(-palm[0], -palm[1], -palm[2]);
    const x = _v[6].crossVectors(y, z).normalize();
    const goal = _q[4].setFromRotationMatrix(_m.makeBasis(x, y, z)).premultiply(n.group.getWorldQuaternion(_q[5]));
    goal.premultiply(n.foreL.getWorldQuaternion(_q[6]).invert());
    n.handL.quaternion.slerp(goal, clamp(weight, 0, 1));
  }
}
