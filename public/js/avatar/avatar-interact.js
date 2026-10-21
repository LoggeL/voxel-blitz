import * as THREE from '../vendor/three.module.js';
import { poseOperatorArm } from './operator-model.js';
import { buildChargeModel } from '../fx/charge-model.js';

// Third person: a player or bot holding an interaction shows it from a
// distance (design docs/design/interact-anims/, reference B): plant, defuse
// and revive kneel with the torso over the hands at the floor (the planter
// sets a charge down, the medic pumps compressions), repair crouches with a
// wrench at the hull, hack stands with a tablet at the chest. The gun is
// stowed meanwhile. Driven by the row's `interaction` (rowInteraction); the
// level eases in and out so a cancel or a finish never snaps.

/** Group-local targets (m; the avatar faces -z): hands, torso lean, kneel and the loop. */
export const AVATAR_INTERACT = Object.freeze({
  plant: Object.freeze({ kneel: true, lean: 0.42, hands: [[-0.1, 0.2, -0.5], [0.1, 0.24, -0.48]], prop: 'charge', tapHz: 3.4, tap: 0.03 }),
  defuse: Object.freeze({ kneel: true, lean: 0.42, hands: [[-0.1, 0.2, -0.52], [0.12, 0.26, -0.46]], prop: 'pliers', tapHz: 1.25, tap: 0.04 }),
  revive: Object.freeze({ kneel: true, lean: 0.55, hands: [[-0.02, 0.36, -0.52], [0.02, 0.33, -0.52]], prop: null, tapHz: 1.8, tap: 0.05, both: true }),
  repair: Object.freeze({ kneel: true, lean: 0.2, hands: [[-0.16, 0.62, -0.5], [0.12, 0.56, -0.52]], prop: 'wrench', tapHz: 1.1, tap: 0.05, swing: true }),
  hack: Object.freeze({ kneel: false, lean: 0.08, hands: [[-0.12, 1.02, -0.3], [0.08, 1.04, -0.3]], prop: 'tablet', tapHz: 5, tap: 0.012 }),
});
/** Ease rate (1/s) of the pose in and out. */
export const AVATAR_INTERACT_RATE = 10;

/** Whether the row's hold kneels (the roster passes it as a crouch to the stance). */
export const interactKneels = hold => !!hold && AVATAR_INTERACT[hold.kind]?.kneel === true;

let shared = null;
function parts() {
  if (shared) return shared;
  shared = {
    geometry: new THREE.BoxGeometry(1, 1, 1),
    steel: new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.4, metalness: 0.5 }),
    red: new THREE.MeshStandardMaterial({ color: 0xb8261c, roughness: 0.55 }),
    olive: new THREE.MeshStandardMaterial({ color: 0x4b5336, roughness: 0.82 }),
    screen: new THREE.MeshBasicMaterial({ color: 0x4fd8c4, toneMapped: false }),
  };
  shared.geometry.userData.pageOwned = true;
  return shared;
}

function buildProps() {
  const { geometry, steel, red, olive, screen } = parts();
  const group = new THREE.Group();
  group.name = 'avatar-interact-props';
  const box = (into, material, size, pos) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.set(...size); mesh.position.set(...pos);
    mesh.castShadow = true;
    into.add(mesh);
    return mesh;
  };
  const charge = buildChargeModel({ name: 'avatar-interact-charge' });
  charge.root.scale.setScalar(1.25);
  group.add(charge.root);
  const pliers = new THREE.Group();
  box(pliers, red, [0.03, 0.03, 0.12], [0, 0, 0.02]);
  box(pliers, steel, [0.02, 0.02, 0.07], [0, 0, -0.07]);
  group.add(pliers);
  const wrench = new THREE.Group();
  box(wrench, steel, [0.035, 0.035, 0.3], [0, 0, -0.08]);
  box(wrench, steel, [0.07, 0.04, 0.07], [0, 0, -0.24]);
  group.add(wrench);
  const tablet = new THREE.Group();
  box(tablet, olive, [0.28, 0.19, 0.03], [0, 0, 0]);
  box(tablet, screen, [0.22, 0.13, 0.005], [0, 0, 0.017]);
  group.add(tablet);
  return { group, charge, pliers, wrench, tablet };
}

const _anchor = new THREE.Vector3();
const _grip = new THREE.Vector3();

/**
 * Before the stance pose: take back last frame's torso lean (the stance eases
 * the torso, an added lean would build up). Cheap when idle.
 */
export function unposeAvatarInteract(av) {
  if (av.interactLean) { av.torso.rotation.x -= av.interactLean; av.interactLean = 0; }
}

/**
 * After the stance pose: ease `av` toward the hold `hold` ({kind, progress} or
 * null). While shown: the gun hides, the arms reach the kind's targets, the
 * torso leans over them, a kneel drops one knee, the prop shows. Returns the level.
 */
export function poseAvatarInteract(av, hold, dt = 0, timeS = 0) {
  const spec = hold ? AVATAR_INTERACT[hold.kind] : null;
  if (spec) av.interactKind = hold.kind;
  const target = spec ? 1 : 0;
  const level = av.interactLevel = (av.interactLevel || 0) + (target - (av.interactLevel || 0)) * (dt > 0 ? 1 - Math.exp(-dt * AVATAR_INTERACT_RATE) : 1);
  const kind = av.interactKind, pose = AVATAR_INTERACT[kind];
  if (!pose || level < 0.01) {
    av.interactLevel = spec ? level : 0;
    if (av.interactProps) av.interactProps.group.visible = false;
    return 0;
  }
  if (!av.interactProps) { av.interactProps = buildProps(); av.group.add(av.interactProps.group); }
  const props = av.interactProps;
  const crouch = av.crouchPose || 0, prone = av.pronePose || 0;
  // Lean and kneel (prone keeps its own body; the hands still work).
  const lean = pose.lean * level * (1 - prone);
  av.torso.rotation.x += lean;
  av.interactLean = lean;
  if (pose.kneel && prone < 0.5) {
    const joints = [av.lLeg?.userData?.joints, av.rLeg?.userData?.joints];
    // Left knee up and forward, right knee down behind: a one-knee kneel over the crouch fold.
    if (joints[0]) { joints[0].thigh.rotation.x += 0.5 * level * crouch; joints[0].knee.rotation.x -= 0.25 * level * crouch; }
    if (joints[1]) { joints[1].thigh.rotation.x -= 0.35 * level * crouch; joints[1].knee.rotation.x -= 0.45 * level * crouch; }
  }
  if (level > 0.3 && av.weaponModel?.root) av.weaponModel.root.visible = false;
  const loop = Math.max(0, Math.sin(timeS * Math.PI * 2 * pose.tapHz));
  const drop = prone * 0.15;
  const model = av.weaponModel?.modelRoot;
  props.group.visible = level > 0.3;
  props.charge.root.visible = pose.prop === 'charge' && (hold?.progress ?? 1) < 0.99;
  props.pliers.visible = pose.prop === 'pliers';
  props.wrench.visible = pose.prop === 'wrench';
  props.tablet.visible = pose.prop === 'tablet';
  if (model) av.group.updateMatrixWorld(true);
  const reach = [];
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1, [hx, hy, hz] = pose.hands[i];
    const moving = pose.both || side > 0;
    let x = hx, y = hy - drop, z = hz;
    if (moving) {
      if (pose.swing) { x += Math.cos(timeS * Math.PI * 2 * pose.tapHz) * pose.tap; y += Math.sin(timeS * Math.PI * 2 * pose.tapHz) * pose.tap; }
      else if (kind === 'hack') z += Math.pow(loop, 4) * pose.tap;
      else y -= Math.pow(loop, 3) * pose.tap;
    }
    reach.push([x, y, z]);
    if (!model) continue;
    // poseOperatorArm reads anchors in the weapon model's frame: blend from the gun grip by the level.
    _anchor.set(x, y, z);
    av.group.localToWorld(_anchor);
    model.worldToLocal(_anchor);
    const grip = side > 0 ? av.weaponModel.handPose?.grip : av.weaponModel.handPose?.support;
    if (grip) { _grip.set(grip.x, grip.y, grip.z); _anchor.lerp(_grip, 1 - level); }
    poseOperatorArm(av, side, _anchor);
  }
  const [l, r] = reach;
  props.charge.root.position.set((l[0] + r[0]) / 2, Math.max(0, Math.min(l[1], r[1]) - 0.16 - drop), (l[2] + r[2]) / 2 - 0.02);
  props.pliers.position.set(r[0], r[1], r[2] - 0.04);
  props.pliers.rotation.set(-0.9, 0, 0);
  props.wrench.position.set(r[0], r[1], r[2]);
  props.wrench.rotation.set(0, 0, Math.sin(timeS * Math.PI * 2 * pose.tapHz) * 0.5);
  props.tablet.position.set(0, (l[1] + r[1]) / 2 + 0.02, (l[2] + r[2]) / 2 - 0.02);
  props.tablet.rotation.set(-0.7, 0, 0);
  return level;
}
