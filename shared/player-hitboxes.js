import { pronePose } from './player-stance.js';
import { leanBodyPoint, leanRoll } from './player-lean.js';
import { HANDS } from './avatar-hands.js';
import { WEAPON_IDS } from './combatmath.js';

// Combat volumes follow the avatar's proportions, independently of the movement
// collider. Cosmetic gait/flinch uses small limb margins, never a full-body box.
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const rotate = (v, basis) => [
  v[0] * basis[0][0] + v[1] * basis[1][0] + v[2] * basis[2][0],
  v[0] * basis[0][1] + v[1] * basis[1][1] + v[2] * basis[2][1],
  v[0] * basis[0][2] + v[1] * basis[1][2] + v[2] * basis[2][2],
];
const IDENTITY_BASIS = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const ZERO = [0, 0, 0];
export const SIGHT_HEIGHT = { rifle: 0.145, smg: 0.112, shotgun: 0.100, sniper: 0.205, minigun: 0.155, lmg: 0.155,
  revolver: 0.105, longarc: 0.155, rocket: 0.175, lance: 0.155, knife: 0.02, flamethrower: 0.158,
  glaive: 0.150 };
const clamp01 = v => Math.max(0, Math.min(1, v));
function basisFor(x = 0, y = 0, z = 0) {
  const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y);
  const e = Math.cos(z), f = Math.sin(z);
  // THREE.Euler's default XYZ order, columns of the rotation matrix.
  return [[c*e, a*f+b*d*e, b*f-a*d*e], [-c*f, a*e-b*d*f, b*e+a*d*f], [d, -b*c, a*c]];
}

// Zone sizes trace the delivered RIVET operator (public/assets/blender/rivet.gltf)
// in the avatar's joint frames: helmet with visor and headset, chest with the
// backpack, the wide pelvis, thigh/shin/boot segments and armored arms.
// tools/hitbox-model-test.mjs checks them against the exported vertices.
// The helmet core stays centred on the head joint (the animation target);
// face, visor and brow peak reach 0.235 m forward of it.
const HELMET = { size: [0.36, 0.39, 0.37] };
const FACE = { size: [0.30, 0.36, 0.20], offset: [0, -0.005, -0.14] };
const HEADSET = { size: [0.42, 0.15, 0.15], offset: [0, -0.012, 0.016] };
const NECK = { size: [0.19, 0.13, 0.19] };
const TORSO = { size: [0.50, 0.50, 0.62], offset: [0, 0, 0.035] };
const HIPS = { size: [0.66, 0.24, 0.37], offset: [0, -0.005, -0.025] };
const SEGMENT = 0.325;
// The knee cap rides 0.085 m above the knee joint, on the outside of the fold.
// `stride` widens each segment for the gait fan the boots sweep while running.
const THIGH = { size: [0.30, SEGMENT + 0.05, 0.28], offset: [0.014, -SEGMENT / 2, 0], stride: [0, 0, 0.55] };
const SHIN = { size: [0.22, SEGMENT + 0.12, 0.28], offset: [0, -SEGMENT / 2 + 0.035, -0.025], stride: [0, 0, 1] };
const BOOT = { size: [0.24, 0.22, 0.34], offset: [0, 0.035, -0.072], stride: [0, 0.5, 1.2], lift: 0.2 };
// The pauldron rises 0.12 m above the shoulder joint; the glove hangs past the wrist.
const UPPER_ARM = { width: 0.32, margin: 0.18, shift: -0.05 };
const FOREARM = { width: 0.27, margin: 0.12, shift: 0.03 };

export function playerHitboxes(p) {
  const prone = pronePose(p.proneT);
  const mix = (a, b) => a + (b - a) * prone;
  const crouch = p.crouch ? 1 : 0;
  const armCrouch = crouch * (1 - prone);
  const pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, p.pitch || 0));
  const hands = HANDS[WEAPON_IDS[p.weapon || 0]] || HANDS.rifle;
  const yaw = basisFor(0, p.yaw || 0, 0);
  const feet = [p.x, p.y, p.z];
  // Uniform body scale (Bastion tiers): every joint is feet-relative, so scaling
  // the centre and the half extents scales the whole skeleton. Default 1.
  const s = Number.isFinite(p.bodyScale) && p.bodyScale > 0 ? p.bodyScale : 1;
  const boxes = [];
  // Peek lean rolls the upper body about the hips; legs and hips stay planted.
  const lean = (p.leanT || 0) * (1 - prone);
  const leanBasis = lean ? basisFor(0, 0, leanRoll(lean)) : null;
  // Each zone box sits at a joint plus an offset in the joint's own frame.
  function box(zone, joint, { size, offset = ZERO }, basis = IDENTITY_BASIS, upper = false) {
    let center = add(joint, rotate(offset, basis));
    if (upper && leanBasis) {
      center = leanBodyPoint(center, lean, crouch);
      basis = [rotate(basis[0], leanBasis), rotate(basis[1], leanBasis), rotate(basis[2], leanBasis)];
    }
    boxes.push({ zone, center: add(feet, rotate([center[0] * s, center[1] * s, center[2] * s], yaw)),
      half: [size[0] / 2 * s, size[1] / 2 * s, size[2] / 2 * s],
      basis: [rotate(basis[0], yaw), rotate(basis[1], yaw), rotate(basis[2], yaw)] });
  }
  const headBasis = basisFor(pitch * 0.7);
  const head = [0, mix(1.66 - crouch * 0.34, 0.48), 0];
  box('head', head, HELMET, headBasis, true);
  box('head', head, FACE, headBasis, true);
  box('head', head, HEADSET, headBasis, true);
  box('torso', [0, mix(1.18 - crouch * 0.27, 0.3), prone * 0.4], TORSO, basisFor(mix(crouch * 0.12, -Math.PI / 2)), true);
  box('torso', [0, mix(1.43 - crouch * 0.34, 0.36), prone * 0.1], NECK, IDENTITY_BASIS, true);
  box('hips', [0, mix(0.84 - crouch * 0.20, 0.25), prone * 0.8], HIPS, basisFor(-prone * Math.PI / 2));
  // Legs fold exactly like poseOperatorLeg for a still stance: crouching bends
  // the knees forward and prone lays the leg out behind the hips. The cosmetic
  // running stride only widens each segment's depth, so the empty space between
  // the legs never becomes a target.
  const speed = Math.min(1, (p.moveSpeed ?? Math.hypot(p.vx || 0, p.vz || 0)) / 5.8);
  const stride = speed * 0.78 * (1 - crouch * 0.6) * (1 - prone);
  const legY = mix(0.73 - crouch * 0.26, 0.25), legZ = prone * 0.85;
  const legAngle = -prone * Math.PI / 2;
  const compression = 1 - crouch * 0.35 * (1 - prone);
  const vertical = Math.max(0.001, Math.cos(legAngle));
  const floorBend = Math.acos(clamp01((legY - 0.075) / (0.65 * vertical)));
  const tuck = Math.max(floorBend, Math.acos(compression) * (1 - prone) + Math.sin(Math.PI * prone) * 0.65);
  const releaseT = clamp01((prone - 0.65) / 0.35);
  const release = releaseT * releaseT * (3 - 2 * releaseT);
  const bend = tuck * (1 - release) - 0.12 * release;
  const thighAngle = legAngle + bend, shinAngle = legAngle - bend;
  const thighBasis = basisFor(thighAngle), shinBasis = basisFor(shinAngle), bootBasis = basisFor(legAngle);
  const ads = p.ads && !p.reloading ? 1 : 0;
  const reload = p.reloading ? 1 : 0;
  const sight = SIGHT_HEIGHT[WEAPON_IDS[p.weapon || 0]] || 0.12;
  const hip = [0.1995 - hands.grip.x * 1.1, 1.3165 - hands.grip.y * 1.1, -0.309 - hands.grip.z * 1.1];
  const mount = [ads ? 0.055 : hip[0], ads ? 1.62 - sight * 1.1 : hip[1], hip[2] - ads * 0.045];
  mount[0] -= reload * 0.02; mount[1] -= armCrouch * 0.29 + prone * 1.14 + reload * 0.07; mount[2] += reload * 0.03;
  const aim = Math.max(-(80 * Math.PI) / 180, Math.min((80 * Math.PI) / 180, p.pitch || 0));
  const armBasis = basisFor(aim * (1 - reload * 0.6) - reload * 0.42, reload * 0.18, reload * 0.28);
  for (const side of [-1, 1]) {
    const hipJoint = [side * 0.16, legY, legZ];
    const knee = add(hipJoint, [0, -Math.cos(thighAngle) * SEGMENT, -Math.sin(thighAngle) * SEGMENT]);
    const ankle = add(knee, [0, -Math.cos(shinAngle) * SEGMENT, -Math.sin(shinAngle) * SEGMENT]);
    const swept = ({ size, offset, stride: growth, lift = 0 }, mirror = 1) => ({
      size: size.map((v, i) => v + growth[i] * stride),
      offset: [offset[0] * mirror, offset[1] + lift * stride, offset[2]] });
    box('leg', hipJoint, swept(THIGH, side), thighBasis);
    box('leg', knee, swept(SHIN), shinBasis);
    box('leg', ankle, swept(BOOT), bootBasis);
    const shoulder = [side * 0.32, 1.43 - armCrouch * 0.29 - prone * 1.08, prone * 0.14];
    const anchor = side < 0 ? hands.support : hands.grip;
    let target = [side * 0.34, 0.82 - armCrouch * 0.29 - prone * 0.5, -0.08];
    if (anchor) {
      // Settled weapon mount from AvatarWeaponModel. Recoil/reload animation
      // is cosmetic and covered by the small margins around each arm segment.
      target = add(mount, rotate([anchor.x * 1.1, anchor.y * 1.1, anchor.z * 1.1], armBasis));
      if (reload && side < 0) target = target.map((v, i) => v * 0.35 + [0.08, 1.08 - armCrouch * 0.29 - prone * 0.7, -0.33][i] * 0.65);
    }
    const delta = target.map((v, i) => v - shoulder[i]);
    const distance = Math.max(0.001, Math.hypot(...delta));
    const direction = delta.map(v => v / distance);
    const length = Math.max(0.34, distance / 1.98);
    const pole = [side * 0.8, -1, 0.25];
    const projection = dot(pole, direction);
    const normal = pole.map((v, i) => v - projection * direction[i]);
    const bend = Math.sqrt(Math.max(0, length * length - distance * distance / 4));
    const norm = Math.hypot(...normal) || 1;
    const elbow = shoulder.map((v, i) => v + delta[i] / 2 + normal[i] / norm * bend);
    for (const [start, end, segment] of [[shoulder, elbow, UPPER_ARM], [elbow, target, FOREARM]]) {
      const axis = end.map((v, i) => (v - start[i]) / length);
      const ref = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const cross = [axis[1]*ref[2]-axis[2]*ref[1], axis[2]*ref[0]-axis[0]*ref[2], axis[0]*ref[1]-axis[1]*ref[0]];
      const n = Math.hypot(...cross);
      const x = cross.map(v => v / n);
      const z = [x[1]*axis[2]-x[2]*axis[1], x[2]*axis[0]-x[0]*axis[2], x[0]*axis[1]-x[1]*axis[0]];
      const shift = segment.shift;
      box('arm', start.map((v, i) => (v + end[i]) / 2 + axis[i] * shift),
        { size: [segment.width, length + segment.margin, segment.width] }, [x, axis, z], true);
    }
  }
  return boxes;
}

function localRay(o, d, box) {
  const offset = [o[0] - box.center[0], o[1] - box.center[1], o[2] - box.center[2]];
  const basis = box.basis;
  return { o: [dot(offset, basis[0]), dot(offset, basis[1]), dot(offset, basis[2])],
    d: [dot(d, basis[0]), dot(d, basis[1]), dot(d, basis[2])] };
}
function interval(o, d, half, radius, min, max) {
  let lo = min, hi = max;
  for (let i = 0; i < 3; i++) {
    const h = half[i] + radius;
    if (Math.abs(d[i]) < 1e-9) { if (Math.abs(o[i]) > h) return null; }
    else {
      let a = (-h - o[i]) / d[i], b = (h - o[i]) / d[i];
      if (a > b) [a, b] = [b, a];
      lo = Math.max(lo, a); hi = Math.min(hi, b);
      if (lo > hi) return null;
    }
  }
  return [lo, hi];
}
// Swept-radius searches evaluate this up to 96 times per box. Keep each sample
// scalar so a contact query creates no temporary points inside the search.
function distanceSqAt(o, d, at, half) {
  const x = Math.max(0, Math.abs(o[0] + d[0] * at) - half[0]);
  const y = Math.max(0, Math.abs(o[1] + d[1] * at) - half[1]);
  const z = Math.max(0, Math.abs(o[2] + d[2] * at) - half[2]);
  return x * x + y * y + z * z;
}

/** Static objectives opt into an explicit box; combatants keep their body zones. */
export function combatHitboxes(p) {
  if (!p.combatBox) return playerHitboxes(p);
  return [{ zone: 'object', center: [p.x, p.y + p.combatBox[1], p.z],
    half: p.combatBox, basis: IDENTITY_BASIS }];
}

export function pointPlayerDistance(point, p) {
  let nearest = Infinity;
  for (const box of combatHitboxes(p)) {
    const { o } = localRay(point, ZERO, box);
    nearest = Math.min(nearest, distanceSqAt(o, ZERO, 0, box.half));
    if (nearest === 0) return 0;
  }
  return Math.sqrt(nearest);
}

/** Unit rays use metres; projectile segment directions use fractions [0,1]. */
export function rayPlayerHitboxes(origin, direction, p, limit, { minT = 0, radius = 0, preferCore = false } = {}) {
  let best = null, core = null;
  const ray = [direction.x, direction.y, direction.z];
  for (const box of combatHitboxes(p)) {
    const { o, d } = localRay(origin, ray, box);
    const direct = interval(o, d, box.half, 0, minT, limit);
    if (direct && (!core || direct[0] < core.t)) core = { t: direct[0], zone: box.zone, coreHit: true, radialDistance: 0 };
    const bounds = radius === 0 ? direct : interval(o, d, box.half, radius, minT, limit);
    if (!bounds) continue;
    let t = bounds[0], radialDistance = 0;
    if (radius > 0) {
      const distance = at => distanceSqAt(o, d, at, box.half);
      let low = bounds[0], high = bounds[1];
      for (let i = 0; i < 32; i++) {
        const a = low + (high-low)/3, b = high - (high-low)/3;
        if (distance(a) <= distance(b)) high = b; else low = a;
      }
      const closest = (low + high) / 2;
      radialDistance = Math.sqrt(distance(closest));
      if (radialDistance > radius) continue;
      low = bounds[0]; high = closest;
      for (let i = 0; i < 32; i++) {
        const mid = (low + high) / 2;
        if (distance(mid) <= radius * radius) high = mid; else low = mid;
      }
      t = preferCore ? closest : high;
    }
    if (!best || (preferCore && radius > 0 ? radialDistance < best.radialDistance : t < best.t)) best = { t, zone: box.zone, coreHit: !!direct, radialDistance };
  }
  return preferCore && core ? core : best;
}
