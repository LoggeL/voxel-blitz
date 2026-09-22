import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from '../public/js/vendor/three.module.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { playerHitboxes, pointPlayerDistance, rayPlayerHitboxes, SIGHT_HEIGHT } from '../shared/player-hitboxes.js';
import { makeAvatar, updateAvatarWeaponPose, updateAvatarStancePose, disposeAvatar } from '../public/js/avatar/avatar.js';
import { buildGun } from '../public/js/guns/assemble.js';
import { MaterialCache } from '../public/js/guns/kit.js';

// The authoritative body zones must trace the delivered RIVET operator. The
// exported glTF is read directly (no DOM loader), every vertex is carried into
// the real avatar joint transforms for each stance, and the shared hitboxes are
// checked for coverage, for tightness and for the mirrored leg fold.
const gltf = JSON.parse(await readFile(new URL('../public/assets/blender/rivet.gltf', import.meta.url), 'utf8'));
const bin = await readFile(new URL('../public/assets/blender/rivet.bin', import.meta.url));
const parts = {};
for (const node of gltf.nodes) {
  const vertices = [];
  for (const primitive of gltf.meshes[node.mesh].primitives) {
    const accessor = gltf.accessors[primitive.attributes.POSITION];
    const view = gltf.bufferViews[accessor.bufferView];
    const floats = new Float32Array(bin.buffer, bin.byteOffset + view.byteOffset, accessor.count * 3);
    for (let i = 0; i < accessor.count; i++) vertices.push([floats[i * 3], floats[i * 3 + 1], floats[i * 3 + 2]]);
  }
  parts[node.name] = vertices;
}
const ZONE = { head: 'head', torso: 'torso', pack: 'torso', pouches: 'torso', hips: 'hips',
  lThigh: 'leg', lKnee: 'leg', lBoot: 'leg', rThigh: 'leg', rKnee: 'leg', rBoot: 'leg',
  lArm: 'arm', lElbow: 'arm', lHand: 'arm', rArm: 'arm', rElbow: 'arm', rHand: 'arm' };
assert.deepEqual(Object.keys(parts).sort(), Object.keys(ZONE).sort(), 'RIVET export exposes the gameplay joint parts');
// Neighbouring zones legitimately share seams: the neck sits in the torso's
// neck box, belt and thigh tops overlap, and the pauldron meets the chest.
const NEIGHBOURS = { head: ['head', 'torso'], torso: ['torso', 'hips', 'head'], hips: ['hips', 'torso', 'leg'],
  leg: ['leg', 'hips'], arm: ['arm', 'torso'] };

globalThis.document = { createElement: () => ({ getContext: () => new Proxy({}, {
  get: (object, key) => object[key] ?? (() => {}),
}) }) };
const av = makeAvatar('rivet-hitboxes', 'RIVET');
const joints = () => {
  const l = av.lLeg.userData.joints, r = av.rLeg.userData.joints;
  return { head: av.head, torso: av.torso, pack: av.pack, pouches: av.pouches, hips: av.hips,
    lThigh: l.thigh, lKnee: l.knee, lBoot: l.boot, rThigh: r.thigh, rKnee: r.knee, rBoot: r.boot,
    lArm: av.lArm, lElbow: av.lElbow, lHand: av.lHand, rArm: av.rArm, rElbow: av.rElbow, rHand: av.rHand };
};
function pose(p, motion = {}) {
  av.group.position.set(p.x, p.y, p.z);
  av.group.rotation.y = p.yaw || 0;
  for (let i = 0; i < 90; i++) {
    updateAvatarWeaponPose(av, { weapon: p.weapon || 0, pitch: p.pitch || 0, ads: !!p.ads, reloading: !!p.reloading,
      crouching: !!p.crouch, proneT: p.proneT || 0, leanT: p.leanT || 0, dt: 1 / 30, blend: 1, ...motion });
    updateAvatarStancePose(av, motion);
  }
  // The roster pitches the head like the head zone does.
  av.head.rotation.x = (p.pitch || 0) * 0.7;
  av.group.updateMatrixWorld(true);
}
function worldVertices(name) {
  const joint = joints()[name];
  // poseOperatorArm stretches the rigid arm meshes along the solved segment.
  const side = name[0];
  const stretch = name.endsWith('Arm') ? -av[`${side}Elbow`].position.y / 0.34
    : name.endsWith('Elbow') ? -av[`${side}Hand`].position.y / 0.34 : 1;
  return parts[name].map(([x, y, z]) => new THREE.Vector3(x, y * stretch, z).applyMatrix4(joint.matrixWorld));
}
function gap(point, box) {
  const o = [point.x - box.center[0], point.y - box.center[1], point.z - box.center[2]];
  const d = [0, 1, 2].map(i => Math.max(0,
    Math.abs(o[0] * box.basis[i][0] + o[1] * box.basis[i][1] + o[2] * box.basis[i][2]) - box.half[i]));
  return Math.hypot(...d);
}
function coverage(p, part, boxes) {
  const allowed = boxes.filter(box => NEIGHBOURS[ZONE[part]].includes(box.zone));
  const gaps = worldVertices(part).map(v => Math.min(...allowed.map(box => gap(v, box)))).sort((a, b) => a - b);
  return { inside: gaps.filter(g => g <= 0.005).length / gaps.length, p98: gaps[Math.floor(gaps.length * 0.98)] };
}

// Each still stance: the body is inside its zones, and each core zone box stays
// close to the geometry it represents so empty air never becomes a target.
const stances = [
  { name: 'standing', p: { x: 3, y: 1, z: -2, yaw: 0.6 } },
  { name: 'aiming up', p: { x: 3, y: 1, z: -2, yaw: 0.6, pitch: -1.2, ads: true } },
  { name: 'aiming down', p: { x: 3, y: 1, z: -2, yaw: 0.6, pitch: 1.2 } },
  { name: 'reloading', p: { x: 3, y: 1, z: -2, yaw: 0.6, reloading: true } },
  { name: 'crouching', p: { x: 3, y: 1, z: -2, yaw: 0.6, crouch: true } },
  { name: 'crouching ads', p: { x: 3, y: 1, z: -2, yaw: 0.6, crouch: true, ads: true, pitch: 0.5 } },
  { name: 'going prone', p: { x: 3, y: 1, z: -2, yaw: 0.6, proneT: 0.5 } },
  { name: 'nearly prone', p: { x: 3, y: 1, z: -2, yaw: 0.6, proneT: 0.8 } },
  { name: 'prone', p: { x: 3, y: 1, z: -2, yaw: 0.6, proneT: 1 } },
  // Peek lean rolls head, chest, arms and weapon about the hips.
  { name: 'leaning left', p: { x: 3, y: 1, z: -2, yaw: 0.6, leanT: -1 } },
  { name: 'leaning right', p: { x: 3, y: 1, z: -2, yaw: 0.6, leanT: 1 } },
  { name: 'half lean ads', p: { x: 3, y: 1, z: -2, yaw: 0.6, leanT: 0.5, ads: true, pitch: -0.5 } },
  { name: 'crouched lean', p: { x: 3, y: 1, z: -2, yaw: 0.6, leanT: -1, crouch: true, ads: true } },
  // Bastion juggernaut: the roster scales the whole rig by `bodyScale` and the
  // shared zones scale with it, so the same thresholds hold at 1.4.
  { name: 'juggernaut 1.4', p: { x: 3, y: 1, z: -2, yaw: 0.6, bodyScale: 1.4 }, scale: 1.4 },
];
// Cosmetic extremities: the neck gasket swinging with head pitch, the radio
// antenna, the flexing reload hand and the swinging pauldron.
const MIN_INSIDE = { head: 0.95, pack: 0.96, lElbow: 0.75, rElbow: 0.75, lArm: 0.9, rArm: 0.9 };
const MAX_P98 = { head: 0.10, pack: 0.25, lElbow: 0.06, rElbow: 0.06, lArm: 0.03, rArm: 0.03 };
let checks = 0;
for (const { name, p, scale = 1 } of stances) {
  av.group.scale.setScalar(scale);
  pose(p);
  const boxes = playerHitboxes(p);
  for (const part of Object.keys(parts)) {
    const { inside, p98 } = coverage(p, part, boxes);
    assert.ok(inside >= (MIN_INSIDE[part] ?? 0.985),
      `${name}: ${part} is ${(inside * 100).toFixed(1)}% inside its zones`);
    assert.ok(p98 <= (MAX_P98[part] ?? 0.02), `${name}: ${part} 98th percentile gap ${p98.toFixed(3)}m`);
    checks++;
  }
  // The shared leg fold mirrors poseOperatorLeg: every leg joint is inside a leg box.
  for (const leg of [av.lLeg, av.rLeg]) {
    for (const joint of Object.values(leg.userData.joints)) {
      const point = joint.getWorldPosition(new THREE.Vector3()).toArray();
      const legBoxes = boxes.filter(box => box.zone === 'leg');
      const nearest = Math.min(...legBoxes.map(box => gap(new THREE.Vector3(...point), box)));
      assert.ok(nearest < 0.01, `${name}: leg joint ${nearest.toFixed(3)}m outside the leg zones`);
    }
  }
  // Tightness of the core zones: no box face further than 6 cm from its geometry.
  const zoneVertices = {};
  for (const part of Object.keys(parts)) (zoneVertices[ZONE[part]] ??= []).push(...worldVertices(part));
  for (const box of boxes) {
    if (box.zone === 'arm') continue;
    const projected = zoneVertices[box.zone].map(v => {
      const o = [v.x - box.center[0], v.y - box.center[1], v.z - box.center[2]];
      return [0, 1, 2].map(i => o[0] * box.basis[i][0] + o[1] * box.basis[i][1] + o[2] * box.basis[i][2]);
    });
    for (let axis = 0; axis < 3; axis++) {
      const lo = Math.min(...projected.map(v => v[axis])), hi = Math.max(...projected.map(v => v[axis]));
      assert.ok(-box.half[axis] >= lo - 0.06 && box.half[axis] <= hi + 0.06,
        `${name}: ${box.zone} box exceeds its geometry on axis ${axis} (${(-box.half[axis]).toFixed(3)}..${box.half[axis].toFixed(3)} vs ${lo.toFixed(3)}..${hi.toFixed(3)})`);
    }
  }
}
av.group.scale.setScalar(1);

// Running: the gait swings the whole leg; the stride depth keeps the boots covered.
for (const swing of [-1, 1]) {
  const p = { x: 3, y: 1, z: -2, yaw: 0.6, moveSpeed: 5.8 };
  pose(p, { swing, stride: 1 });
  const boxes = playerHitboxes(p);
  for (const part of ['lThigh', 'lKnee', 'lBoot', 'rThigh', 'rKnee', 'rBoot']) {
    const { inside } = coverage(p, part, boxes);
    assert.ok(inside >= 0.9, `running swing ${swing}: ${part} is ${(inside * 100).toFixed(1)}% inside the leg zones`);
    checks++;
  }
}

// Swimming keeps the authoritative upright zones (lag-compensated shots replay
// poses without the swim flag), so the whole stroke cycle of the visual lean,
// flutter kick and low weapon carry must stay inside the standing envelope:
// gaps no larger than the cosmetic gait already allows.
const SWIM_MIN_INSIDE = { head: 0.95, torso: 0.98, pack: 0.9, pouches: 0.9, hips: 0.9,
  lThigh: 0.9, rThigh: 0.9, lKnee: 0.9, rKnee: 0.9, lBoot: 0.9, rBoot: 0.9,
  lArm: 0.35, rArm: 0.9, lElbow: 0.75, rElbow: 0.75, lHand: 0.85, rHand: 0.9 };
const SWIM_MAX_P98 = { head: 0.10, pack: 0.25, lElbow: 0.06, rElbow: 0.06 };
let swimChecks = 0;
for (const weapon of ['rifle', 'sniper', 'lmg', 'knife'].map(id => WEAPON_IDS.indexOf(id))) {
  for (const moveSpeed of [0, 2.6]) {
    const p = { x: 3, y: 1, z: -2, yaw: 0.6, weapon, moveSpeed, swimming: true, grounded: false };
    const stride = Math.min(1, moveSpeed / 5.8);
    av.group.position.set(p.x, p.y, p.z);
    av.group.rotation.y = p.yaw;
    const boxes = playerHitboxes(p);
    for (let frame = 0; frame < 240; frame++) {
      updateAvatarWeaponPose(av, { weapon, swimming: true, speed: moveSpeed, stride, dt: 1 / 30, blend: 1 });
      updateAvatarStancePose(av, { stride, blend: 1 });
      av.head.rotation.x = av.swimHeadTilt;
      av.group.updateMatrixWorld(true);
      if (frame < 60 || frame % 12) continue;
      assert.ok(av.swimPose > 0.99, 'the swim pose has settled after two seconds');
      for (const part of Object.keys(parts)) {
        const { inside, p98 } = coverage(p, part, boxes);
        const name = `${WEAPON_IDS[weapon]} ${moveSpeed ? 'swimming' : 'treading'} frame ${frame}`;
        assert.ok(inside >= SWIM_MIN_INSIDE[part], `${name}: ${part} is ${(inside * 100).toFixed(1)}% inside its zones`);
        assert.ok(p98 <= (SWIM_MAX_P98[part] ?? 0.035), `${name}: ${part} 98th percentile gap ${p98.toFixed(3)}m`);
        swimChecks++;
      }
    }
    for (let frame = 0; frame < 90; frame++) {
      updateAvatarWeaponPose(av, { weapon, swimming: false, dt: 1 / 30, blend: 1 });
      updateAvatarStancePose(av, { blend: 1 });
    }
    assert.ok(av.swimPose < 0.01, 'leaving the water restores the dry stance');
  }
}

// The zone classification follows the model: face, helmet and headset are head;
// the belt is hips; the crouched knee cap is a leg, not empty air.
const standing = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
const shoot = (x, y, p = standing) => rayPlayerHitboxes([x, y, -5], { x: 0, y: 0, z: 1 }, p, 10)?.zone || null;
assert.equal(shoot(0, 1.5), 'head', 'the jaw below the visor is a headshot');
assert.equal(shoot(0.2, 1.65), 'head', 'the headset earpiece is a headshot');
assert.equal(shoot(0.2, 1.8), null, 'air beside the helmet crown misses');
assert.equal(shoot(0.3, 0.85), 'hips', 'the widened pelvis is hit at its edge');
assert.equal(shoot(0, 0.9), 'hips', 'the belt line belongs to the hips');
assert.equal(shoot(0, 1.0), 'torso', 'the pouches above the belt belong to the torso');
assert.equal(shoot(0.16, 0.25, { ...standing, crouch: true }), 'leg', 'a crouched knee is a leg hit');
assert.equal(shoot(0, 0.25, { ...standing, crouch: true }), null, 'the gap between crouched knees misses');

// The server's sight table must match the client's assembled weapon models.
for (const id of WEAPON_IDS) {
  const gun = buildGun(id, new MaterialCache());
  const sightHeight = Number(gun.body?.userData?.sightHeight);
  if (Number.isFinite(sightHeight)) assert.ok(Math.abs(SIGHT_HEIGHT[id] - sightHeight) < 1e-6,
    `${id}: hitbox sight height ${SIGHT_HEIGHT[id]} differs from the model's ${sightHeight}`);
}

// Point queries agree with the same vertices across every weapon and pose.
let worst = 0;
for (let weapon = 0; weapon < WEAPON_IDS.length; weapon++) {
  for (const crouch of [false, true]) for (const ads of [false, true]) {
    const p = { x: 3, y: 1, z: -2, yaw: 0.6, pitch: ads ? -0.6 : 0.4, weapon, ads, crouch };
    pose(p);
    for (const part of ['lHand', 'rHand']) {
      for (const v of worldVertices(part)) worst = Math.max(worst, pointPlayerDistance(v.toArray(), p));
    }
  }
}
assert.ok(worst < 0.03, `glove vertices stay within ${worst.toFixed(3)}m of the arm zones for every weapon`);
disposeAvatar(av);
console.log(`hitbox model tests passed: ${checks} part coverages across ${stances.length} stances, running stride, ${swimChecks} swim-cycle coverages, zone probes, ${WEAPON_IDS.length} weapon sight heights`);
