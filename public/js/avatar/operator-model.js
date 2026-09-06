import * as THREE from '../vendor/three.module.js';

export const UPPER_ARM = 0.34;
export const FOREARM = 0.34;

// Small bevels catch the light while preserving the game's angular silhouettes.
function plate(parent, material, size, position, bevel = 0.012) {
  const [w, h, d] = size;
  const b = Math.min(bevel, w / 4, h / 4, d / 4);
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2 + b, -h / 2 + b);
  shape.lineTo(w / 2 - b, -h / 2 + b);
  shape.lineTo(w / 2 - b, h / 2 - b);
  shape.lineTo(-w / 2 + b, h / 2 - b);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: d - b * 2, bevelEnabled: true, bevelSegments: 1,
    steps: 1, bevelSize: b, bevelThickness: b,
  });
  geometry.translate(0, 0, -d / 2 + b);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  parent.add(mesh);
  return mesh;
}

// Batch rigid panels by material within each joint to keep remote-player draw calls bounded.
function batchPanels(group) {
  const batches = new Map();
  for (const child of [...group.children]) {
    if (!child.isMesh) { batchPanels(child); continue; }
    child.updateMatrix();
    child.geometry.applyMatrix4(child.matrix);
    const meshes = batches.get(child.material) || [];
    meshes.push(child);
    batches.set(child.material, meshes);
  }
  for (const [material, meshes] of batches) {
    const geometry = new THREE.BufferGeometry();
    for (const key of ['position', 'normal', 'uv']) {
      const arrays = meshes.map(mesh => mesh.geometry.getAttribute(key));
      const merged = new Float32Array(arrays.reduce((sum, attr) => sum + attr.array.length, 0));
      let offset = 0;
      for (const attr of arrays) { merged.set(attr.array, offset); offset += attr.array.length; }
      geometry.setAttribute(key, new THREE.BufferAttribute(merged, arrays[0].itemSize));
    }
    for (const mesh of meshes) { group.remove(mesh); mesh.geometry.dispose(); }
    group.add(new THREE.Mesh(geometry, material));
  }
}

export function buildOperator({ suit, dark, armor, visor, skin, variant }) {
  const torso = new THREE.Group();
  plate(torso, dark, [0.48, 0.52, 0.29], [0, 0, 0]);
  plate(torso, suit, [0.53, 0.24, 0.32], [0, 0.13, 0]);
  plate(torso, armor, [0.40, 0.35, 0.10], [0, 0.015, -0.19]);
  plate(torso, suit, [0.30, 0.045, 0.025], [0, 0.13, -0.252]);
  for (const x of [-0.14, 0, 0.14]) {
    plate(torso, dark, [0.115, 0.15, 0.085], [x, -0.15, -0.21]);
    plate(torso, armor, [0.10, 0.035, 0.02], [x, -0.10, -0.262]);
  }
  for (const x of [-0.19, 0.19]) plate(torso, dark, [0.065, 0.39, 0.04], [x, 0.045, -0.185]);
  plate(torso, armor, [0.34, 0.37, 0.12], [0, 0.035, 0.20]);
  plate(torso, suit, [0.24, 0.08, 0.025], [0, 0.12, 0.272]);
  if (variant === 2) {
    plate(torso, dark, [0.30, 0.32, 0.15], [0, -0.03, 0.28]);
    plate(torso, armor, [0.03, 0.30, 0.03], [0.15, 0.28, 0.22]);
  }
  const hips = new THREE.Group();
  plate(hips, dark, [0.45, 0.18, 0.29], [0, 0, 0]);
  plate(hips, armor, [0.47, 0.055, 0.32], [0, 0.065, 0]);
  plate(hips, suit, [0.065, 0.06, 0.03], [0, 0.065, -0.18]);
  const head = new THREE.Group();
  plate(head, dark, [0.16, 0.11, 0.17], [0, -0.17, 0]);
  plate(head, skin, [0.27, 0.29, 0.27], [0, -0.01, -0.005], 0.035);
  plate(head, suit, [0.34, 0.18, 0.34], [0, 0.095, 0.005], 0.038);
  plate(head, armor, [0.32, 0.045, 0.06], [0, 0.03, -0.16]);
  plate(head, visor, [0.255, variant === 1 ? 0.09 : 0.065, 0.025], [0, 0.005, -0.153]);
  for (const x of [-0.168, 0.168]) plate(head, armor, [0.05, 0.12, 0.13], [x, -0.015, 0.02]);
  if (variant !== 0) plate(head, dark, [0.24, 0.105, 0.06], [0, -0.09, -0.14]);
  if (variant === 1) plate(head, armor, [0.12, 0.055, 0.08], [0, 0.20, -0.06]);
  const legs = [-1, 1].map((side) => {
    const leg = new THREE.Group();
    plate(leg, dark, [0.19, 0.35, 0.23], [0, -0.16, 0]);
    plate(leg, suit, [0.17, 0.20, 0.06], [0, -0.18, -0.13]);
    plate(leg, dark, [0.16, 0.30, 0.19], [0, -0.48, 0]);
    plate(leg, armor, [0.18, 0.145, 0.075], [0, -0.35, -0.12]);
    plate(leg, armor, [0.21, 0.135, 0.32], [0, -0.65, -0.045]);
    plate(leg, armor, [0.07, 0.19, 0.19], [side * 0.12, -0.16, 0]);
    return leg;
  });
  const arms = [-1, 1].map(() => {
    const arm = new THREE.Group();
    plate(arm, suit, [0.16, 0.28, 0.18], [0, -0.14, 0]);
    plate(arm, armor, [0.19, 0.12, 0.21], [0, -0.04, 0]);
    plate(arm, suit, [0.195, 0.04, 0.215], [0, -0.06, 0]);
    const elbow = new THREE.Group();
    elbow.position.y = -UPPER_ARM;
    arm.add(elbow);
    plate(elbow, dark, [0.13, 0.27, 0.145], [0, -0.135, 0]);
    plate(elbow, armor, [0.14, 0.15, 0.06], [0, -0.13, 0.065]);
    const hand = new THREE.Group();
    hand.name = 'operator_hand';
    hand.position.y = -FOREARM;
    elbow.add(hand);
    // Palm and curled fingers straddle the grip rather than covering the receiver.
    plate(hand, dark, [0.075, 0.10, 0.095], [0, 0, 0]);
    for (const y of [-0.03, -0.007, 0.016]) {
      plate(hand, armor, [0.082, 0.018, 0.045], [0, y, -0.045], 0.004);
    }
    return { arm, elbow, hand };
  });
  for (const part of [torso, hips, head, ...legs, ...arms.map(entry => entry.arm)]) batchPanels(part);
  return { torso, hips, head, lLeg: legs[0], rLeg: legs[1],
    lArm: arms[0].arm, rArm: arms[1].arm,
    lElbow: arms[0].elbow, rElbow: arms[1].elbow,
    lHand: arms[0].hand, rHand: arms[1].hand };
}

const down = new THREE.Vector3(0, -1, 0);
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
  arm.position.set(side * 0.32, 1.43 - av.crouchPose * 0.29 * (1 - (av.pronePose || 0)) - (av.pronePose || 0) * 1.08, (av.pronePose || 0) * 0.14);
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
  pole.addScaledVector(direction, -pole.dot(direction)).normalize();
  joint.copy(arm.position).addScaledVector(direction, along).addScaledVector(pole, bend);
  direction.subVectors(joint, arm.position).normalize();
  arm.quaternion.setFromUnitVectors(down, direction);
  elbow.position.set(0, -length, 0);
  for (const segment of [arm, elbow]) {
    for (const mesh of segment.children) {
      if (!mesh.isMesh) continue;
      mesh.userData.restY ??= mesh.position.y;
      mesh.position.y = mesh.userData.restY * length / UPPER_ARM;
      mesh.scale.y = length / UPPER_ARM;
    }
  }
  foreDirection.subVectors(target, joint).normalize();
  foreRotation.setFromUnitVectors(down, foreDirection);
  elbow.quaternion.copy(arm.quaternion).invert().multiply(foreRotation);
  hand.position.set(0, -length, 0);
  av.weaponModel.modelRoot.getWorldQuaternion(handRotation);
  const rootRotation = av.group.getWorldQuaternion(new THREE.Quaternion());
  handRotation.premultiply(rootRotation.invert());
  hand.quaternion.copy(foreRotation).invert().multiply(handRotation);
}
