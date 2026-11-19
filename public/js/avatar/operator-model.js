import * as THREE from '../vendor/three.module.js';
import { leanBodyPoint } from '../../../shared/player-lean.js';
import { createRivetParts } from './rivet-model.js';
import { createFallbackOperatorParts } from './operator-fallback.js';

export const UPPER_ARM = 0.34;
export const FOREARM = 0.34;
const LEG_SEGMENT = 0.325;
const SHOULDER_X = 0.32;
const SHOULDER_Y = 1.43;

/** Both sets of meshes are authored in these gameplay joint frames. */
export function buildOperator(materials) {
  const parts = createRivetParts(materials) || createFallbackOperatorParts(materials);
  for (const side of ['l', 'r']) {
    const leg = new THREE.Group();
    const skeleton = new THREE.Group();
    const thigh = parts[`${side}Thigh`];
    const knee = parts[`${side}Knee`];
    const boot = parts[`${side}Boot`];
    thigh.name = 'operator_thigh';
    knee.name = 'operator_knee';
    boot.name = 'operator_boot';
    knee.position.y = boot.position.y = -LEG_SEGMENT;
    leg.add(skeleton);
    skeleton.add(thigh);
    thigh.add(knee);
    knee.add(boot);
    leg.userData.joints = { skeleton, thigh, knee, boot };
    parts[`${side}Leg`] = leg;

    const arm = parts[`${side}Arm`];
    const elbow = parts[`${side}Elbow`];
    const hand = parts[`${side}Hand`];
    hand.name = 'operator_hand';
    arm.add(elbow);
    elbow.add(hand);
    elbow.position.y = -UPPER_ARM;
    hand.position.y = -FOREARM;
  }
  parts.pack.name = 'operator_pack';
  parts.pouches.name = 'operator_pouches';
  parts.pack.position.set(0, 0.20, 0.18);
  parts.pouches.position.set(0, -0.075, -0.19);
  parts.torso.add(parts.pack, parts.pouches);
  return parts;
}

function setSegmentLength(segment, length, restLength) {
  const stretch = length / restLength;
  for (const child of segment.children) {
    // Fitted cuffs ride the same sleeve vertices when the hand reaches out.
    // The elbow and wrist joints take their own solved translations below.
    if (!child.isMesh && !child.userData.cosmetic) continue;
    child.userData.restY ??= child.position.y;
    child.userData.restScaleY ??= child.scale.y;
    child.position.y = child.userData.restY * stretch;
    child.scale.y = child.userData.restScaleY * stretch;
  }
}

/** The armory displays this relaxed pose directly. Respawns also start here. */
export function restOperatorArms(av) {
  for (const [side, arm, elbow, hand] of [[-1, av.lArm, av.lElbow, av.lHand], [1, av.rArm, av.rElbow, av.rHand]]) {
    arm.position.set(side * SHOULDER_X, SHOULDER_Y, 0);
    arm.rotation.set(0, 0, side * 0.08);
    arm.scale.set(1, 1, 1);
    elbow.position.set(0, -UPPER_ARM, 0);
    elbow.rotation.set(side < 0 ? 0.12 : 0.18, 0, 0);
    elbow.scale.set(1, 1, 1);
    hand.position.set(0, -FOREARM, 0);
    hand.rotation.set(0, side * -0.12, 0);
    setSegmentLength(arm, UPPER_ARM, UPPER_ARM);
    setSegmentLength(elbow, FOREARM, FOREARM);
  }
}

const down = new THREE.Vector3(0, -1, 0);
const LEAN_AXIS = new THREE.Vector3(0, 0, 1);
const target = new THREE.Vector3();
const direction = new THREE.Vector3();
const pole = new THREE.Vector3();
const joint = new THREE.Vector3();
const foreDirection = new THREE.Vector3();
const foreRotation = new THREE.Quaternion();
const handRotation = new THREE.Quaternion();

/** Analytic two-bone pose in avatar space, driven by the assembled gun's palm anchors. */
export function poseOperatorArm(av, side, anchor, reload = 0) {
  const arm = side < 0 ? av.lArm : av.rArm;
  const elbow = side < 0 ? av.lElbow : av.rElbow;
  const hand = side < 0 ? av.lHand : av.rHand;
  arm.position.set(side * SHOULDER_X, SHOULDER_Y - av.crouchPose * 0.29 * (1 - (av.pronePose || 0)) - (av.pronePose || 0) * 1.08, (av.pronePose || 0) * 0.14);
  // The shoulders follow the pitched torso top while swimming, by half the
  // torso's lever so the upper arms stay inside their zone margins.
  const swimPitch = av.swimLean || 0;
  arm.position.y -= 0.08 * (1 - Math.cos(swimPitch));
  arm.position.z -= 0.08 * Math.sin(swimPitch);
  // Peek lean carries the shoulders around the hip pivot with the chest.
  if (av.leanT) {
    const shoulder = leanBodyPoint([arm.position.x, arm.position.y, arm.position.z], av.leanT, av.crouchPose);
    arm.position.set(shoulder[0], shoulder[1], shoulder[2]);
  }
  if (anchor) {
    target.set(anchor.x, anchor.y, anchor.z);
    av.weaponModel.modelRoot.localToWorld(target);
    av.group.worldToLocal(target);
    if (reload && side < 0) target.lerp(new THREE.Vector3(0.08, 1.08 - av.crouchPose * 0.29 * (1 - (av.pronePose || 0)) - (av.pronePose || 0) * 0.7, -0.33), reload);
  } else {
    target.set(side * 0.34, 0.82 - av.crouchPose * 0.29 * (1 - (av.pronePose || 0)) - (av.pronePose || 0) * 0.5, -0.08);
  }
  direction.subVectors(target, arm.position);
  const distance = Math.max(0.001, direction.length());
  direction.divideScalar(distance);
  // At extreme pitch allow modest extension, keeping the palm on the gun.
  const length = Math.max(UPPER_ARM, distance / 1.98);
  const along = distance / 2;
  const bend = Math.sqrt(Math.max(0, length * length - along * along));
  pole.set(side * 0.8, -1, 0.25);
  // The hitbox arms fold in the leaned body frame, so the elbow pole rolls too.
  if (av.leanRoll) pole.applyAxisAngle(LEAN_AXIS, av.leanRoll);
  pole.addScaledVector(direction, -pole.dot(direction)).normalize();
  joint.copy(arm.position).addScaledVector(direction, along).addScaledVector(pole, bend);
  direction.subVectors(joint, arm.position).normalize();
  arm.quaternion.setFromUnitVectors(down, direction);
  elbow.position.set(0, -length, 0);
  setSegmentLength(arm, length, UPPER_ARM);
  setSegmentLength(elbow, length, FOREARM);
  foreDirection.subVectors(target, joint).normalize();
  foreRotation.setFromUnitVectors(down, foreDirection);
  elbow.quaternion.copy(arm.quaternion).invert().multiply(foreRotation);
  hand.position.set(0, -length, 0);
  av.weaponModel.modelRoot.getWorldQuaternion(handRotation);
  const rootRotation = av.group.getWorldQuaternion(new THREE.Quaternion());
  handRotation.premultiply(rootRotation.invert());
  hand.quaternion.copy(foreRotation).invert().multiply(handRotation);
}

/** Fold equal-length segments while retaining the stance's existing ankle height.
 * The carrier scale still describes the combat envelope; cancel it on the visual
 * skeleton so crouching bends rigid limbs instead of shrinking the character.
 */
export function poseOperatorLeg(leg, prone, swing, stride, swim = null) {
  const { skeleton, thigh, knee, boot } = leg.userData.joints;
  const compression = Math.max(0.5, Math.min(1, leg.scale.y));
  const crouchBend = Math.acos(compression);
  // Opposite swing values alternate the knee recovery on left and right sides.
  // A small resting bend keeps prone from looking like a rigid standing model.
  const recovery = Math.max(0, Math.min(1, swing * 5)) * Math.min(1, stride * 5);
  const crawlBend = 0.12 + recovery * 0.48;
  // Fold before lowering the hips so the feet never pass through the floor.
  const vertical = Math.max(0.001, Math.cos(leg.rotation.x));
  const floorBend = Math.acos(Math.max(0, Math.min(1,
    (leg.position.y - 0.075) / (0.65 * vertical))));
  const tuck = Math.max(floorBend,
    crouchBend * (1 - prone) + Math.sin(Math.PI * prone) * 0.65);
  // Once the thighs are nearly horizontal, extend back into the crawl.
  // This depends only on progress, including when a transition reverses.
  const releaseT = Math.max(0, Math.min(1, (prone - 0.65) / 0.35));
  const release = releaseT * releaseT * (3 - 2 * releaseT);
  const bend = tuck * (1 - release) - crawlBend * release;
  skeleton.scale.y = 1 / compression;
  // Swimming replaces the planted fold with a heel lift: the thigh trails with
  // the leg carrier while the shin flutters behind it (negative knee = heel back).
  const swimW = swim ? Math.max(0, Math.min(1, swim.weight)) : 0;
  const flex = swim ? Math.max(0, swim.kneeFlex + swim.kick) : 0;
  thigh.rotation.x = bend * (1 - swimW);
  knee.rotation.x = -2 * bend * (1 - swimW) - flex * swimW;
  boot.rotation.x = bend * (1 - swimW) + flex * 0.35 * swimW;
}
