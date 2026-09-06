import { pronePose } from './player-stance.js';
import { HANDS } from './avatar-hands.js';
import { WEAPON_IDS } from './combatmath.js';

// Combat volumes follow the avatar's proportions, independently of the movement
// collider. Cosmetic gait/flinch uses small limb margins, never a full-body box.
const add = (a, b) => a.map((v, i) => v + b[i]);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const rotate = (v, basis) => [0, 1, 2].map(i => v.reduce((s, n, j) => s + n * basis[j][i], 0));
function basisFor(x = 0, y = 0, z = 0) {
  const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y);
  const e = Math.cos(z), f = Math.sin(z);
  // THREE.Euler's default XYZ order, columns of the rotation matrix.
  return [[c*e, a*f+b*d*e, b*f-a*d*e], [-c*f, a*e-b*d*f, b*e+a*d*f], [d, -b*c, a*c]];
}

export function playerHitboxes(p) {
  const prone = pronePose(p.proneT);
  const mix = (a, b) => a + (b - a) * prone;
  const crouch = p.crouch ? 1 : 0;
  const armCrouch = crouch * (1 - prone);
  const pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, p.pitch || 0));
  const hands = HANDS[WEAPON_IDS[p.weapon || 0]] || HANDS.rifle;
  const yaw = basisFor(0, p.yaw || 0, 0);
  const feet = [p.x, p.y, p.z];
  const boxes = [];
  function box(zone, center, size, basis = basisFor()) {
    boxes.push({ zone, center: add(feet, rotate(center, yaw)),
      half: size.map(v => v / 2), basis: basis.map(v => rotate(v, yaw)) });
  }
  const headBasis = basisFor(pitch * 0.7);
  const head = [0, mix(1.66 - crouch * 0.34, 0.48), 0];
  box('head', head, [0.34, 0.32, 0.34], headBasis);
  box('head', add(head, rotate([0, 0.16, 0], headBasis)), [0.38, 0.14, 0.38], headBasis);
  box('torso', [0, mix(1.18 - crouch * 0.27, 0.3), prone * 0.4], [0.56, 0.56, 0.58], basisFor(mix(crouch * 0.12, -Math.PI / 2)));
  box('torso', [0, mix(1.48 - crouch * 0.34, 0.4), prone * 0.1], [0.18, 0.12, 0.19]);
  box('hips', [0, mix(0.84 - crouch * 0.20, 0.25), prone * 0.8], [0.49, 0.22, 0.36], basisFor(-prone * Math.PI / 2));
  // Stable leg envelopes cover the cosmetic running stride without making the
  // empty space between the legs a target. Standing legs stay narrow in depth.
  const speed = Math.min(1, (p.moveSpeed ?? Math.hypot(p.vx || 0, p.vz || 0)) / 5.8);
  const legHeight = 0.72 * (1 - crouch * 0.35 * (1 - prone));
  for (const side of [-1, 1]) {
    const legAngle = -prone * Math.PI / 2;
    box('leg', [side * 0.16, mix(0.73 - crouch * 0.26, 0.25) - Math.cos(legAngle) * legHeight / 2,
      prone * 0.85 - Math.sin(legAngle) * legHeight / 2],
      [0.24, legHeight + 0.02, 0.40 + speed * 0.78 * (1 - crouch * 0.6) * (1 - prone)], basisFor(legAngle));
    const ads = p.ads && !p.reloading ? 1 : 0;
    const reload = p.reloading ? 1 : 0;
    const shoulder = [side * 0.32, 1.43 - armCrouch * 0.29 - prone * 1.08, prone * 0.14];
    const anchor = side < 0 ? hands.support : hands.grip;
    let target = [side * 0.34, 0.82 - armCrouch * 0.29 - prone * 0.5, -0.08];
    if (anchor) {
      // Settled weapon mount from AvatarWeaponModel. Recoil/reload animation
      // is cosmetic and covered by the small margins around each arm segment.
      const sight = { rifle: 0.145, smg: 0.112, shotgun: 0.100, sniper: 0.205,
        minigun: 0.155, lmg: 0.155, revolver: 0.105, longarc: 0.155, rocket: 0.175, lance: 0.155, knife: 0.02 }[WEAPON_IDS[p.weapon || 0]];
      const hip = [0.1995 - hands.grip.x * 1.1, 1.3165 - hands.grip.y * 1.1, -0.309 - hands.grip.z * 1.1];
      const mount = [ads ? 0.055 : hip[0], ads ? 1.62 - (sight || 0.12) * 1.1 : hip[1], hip[2] - ads * 0.045];
      mount[0] -= reload * 0.02; mount[1] -= armCrouch * 0.29 + prone * 1.14 + reload * 0.07; mount[2] += reload * 0.03;
      const aim = Math.max(-Math.PI * 0.43, Math.min(Math.PI * 0.43, p.pitch || 0));
      target = add(mount, rotate([anchor.x * 1.1, anchor.y * 1.1, anchor.z * 1.1],
        basisFor(aim * (1 - reload * 0.6) - reload * 0.42, reload * 0.18, reload * 0.28)));
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
    for (const [start, end] of [[shoulder, elbow], [elbow, target]]) {
      const axis = end.map((v, i) => (v - start[i]) / length);
      const ref = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const cross = [axis[1]*ref[2]-axis[2]*ref[1], axis[2]*ref[0]-axis[0]*ref[2], axis[0]*ref[1]-axis[1]*ref[0]];
      const n = Math.hypot(...cross);
      const x = cross.map(v => v / n);
      const z = [x[1]*axis[2]-x[2]*axis[1], x[2]*axis[0]-x[0]*axis[2], x[0]*axis[1]-x[1]*axis[0]];
      box('arm', start.map((v, i) => (v + end[i]) / 2), [0.23, length + 0.06, 0.23], [x, axis, z]);
    }
  }
  return boxes;
}

function localRay(o, d, box) {
  const offset = o.map((v, i) => v - box.center[i]);
  return { o: box.basis.map(v => dot(offset, v)), d: box.basis.map(v => dot(d, v)) };
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
const distanceSq = (o, half) => o.reduce((s, v, i) => s + Math.max(0, Math.abs(v) - half[i]) ** 2, 0);

export function pointPlayerDistance(point, p) {
  return Math.sqrt(Math.min(...playerHitboxes(p).map(box => {
    const { o } = localRay(point, [0, 0, 0], box);
    return distanceSq(o, box.half);
  })));
}

/** Unit rays use metres; projectile segment directions use fractions [0,1]. */
export function rayPlayerHitboxes(origin, direction, p, limit, { minT = 0, radius = 0, preferCore = false } = {}) {
  let best = null, core = null;
  for (const box of playerHitboxes(p)) {
    const { o, d } = localRay(origin, [direction.x, direction.y, direction.z], box);
    const direct = interval(o, d, box.half, 0, minT, limit);
    if (direct && (!core || direct[0] < core.t)) core = { t: direct[0], zone: box.zone, coreHit: true, radialDistance: 0 };
    const bounds = interval(o, d, box.half, radius, minT, limit);
    if (!bounds) continue;
    let t = bounds[0], radialDistance = 0;
    if (radius > 0) {
      const distance = at => distanceSq(o.map((v, i) => v + d[i] * at), box.half);
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
