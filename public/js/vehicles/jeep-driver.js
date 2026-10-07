import * as THREE from '../vendor/three.module.js';
import { makeAvatar, setAvatarTeam, disposeAvatar } from '../avatar/avatar.js';
import { UPPER_ARM, FOREARM } from '../avatar/operator-model.js';
import { applyAvatarCosmetics } from '../cosmetics/skins.js';
import { vehicleSeatDefinition } from '../../../shared/vehicle-seats.js';

const DOWN = new THREE.Vector3(0, -1, 0);
const LEG_LENGTH = .325;
const STANDING_HIP = 0.7;

/**
 * An exposed crew member on a ground hull or a transport door: the driver
 * reaches for the wheel, gunners stand (or sit) behind their mount and hold
 * its grips while turning with it, passengers sit with hands on their knees.
 * `anchor` is the model's seat anchor; `rig` optionally supplies
 * { grips: { left, right }, yawNode } for a gunner's mount.
 */
export class JeepDriver {
  constructor(model, player, seat = vehicleSeatDefinition('jeep', 'driver'), anchor = null, rig = null) {
    // Legacy signature: (hull, player, seat, mount).
    if (model?.isObject3D) model = { hull: model, group: model, floorTop: 0.8, steeringWheel: model.getObjectByName('steering-wheel') };
    this.playerId = String(player.id);
    this.seatId = seat.id; this.role = seat.role; this.seatDefinition = seat;
    this.model = model;
    this.hull = model.group || model.hull;
    this.anchor = anchor || model.seatAnchors?.[seat.id] || null;
    this.rig = rig;
    this.steering = seat.drives ? model.steeringWheel || null : null;
    this.wheelControls = seat.drives ? model.wheelControls || null : null;
    const parent = this.anchor?.parent || this.hull;
    this.parent = parent;
    this.avatar = makeAvatar(this.playerId, player.name || '', player.team);
    const avatar = this.avatar;
    // Crew use the complete body and its cosmetic joints, without a carried gun.
    avatar.weaponModel.dispose(); avatar.weaponModel = null;
    avatar.tag.visible = avatar.hpSpr.visible = false;
    // Three.js shares one sprite geometry across every operator's hidden labels.
    for (const sprite of [avatar.tag, avatar.hpSpr]) sprite.geometry.userData.pageOwned = true;
    avatar.group.name = seat.drives ? 'jeep-driver' : rig?.grips ? 'vehicle-gunner' : 'jeep-passenger';
    avatar.group.userData.playerId = this.playerId;
    avatar.group.userData.vehicleSeatId = this.seatId;
    parent.add(avatar.group);
    if (this.anchor) avatar.group.position.copy(this.anchor.position);
    else avatar.group.position.fromArray(seat.position);
    // Hip height above the floor decides standing (pintle, hatch) or seated.
    const floorTop = Number.isFinite(model.floorTop) ? model.floorTop : 0.8;
    const hipAboveFloor = (this.anchor?.userData.pivot?.[1] ?? seat.position[1]) - floorTop;
    this.standing = !!rig?.grips && hipAboveFloor >= STANDING_HIP;
    avatar.hips.position.set(0, 0, 0);
    // Lean clear of the seat back while keeping the authored hip and floor anchors.
    avatar.torso.position.set(0, .31, this.standing ? 0 : -.1);
    avatar.head.position.set(0, .76, this.standing ? -.03 : -.125);
    for (const [leg, side] of [[avatar.lLeg, -1], [avatar.rLeg, 1]]) {
      leg.position.set(side * .15, .02, 0);
      leg.rotation.set(0, 0, 0); leg.scale.setScalar(1);
      const { skeleton, thigh, knee, boot } = leg.userData.joints;
      skeleton.scale.setScalar(1);
      if (this.standing) { thigh.rotation.x = 0; knee.rotation.x = 0; boot.rotation.x = 0; continue; }
      // Seated: sole just above the floor, rigid thighs and upright shins.
      const kneeHeight = .075 + LEG_LENGTH;
      const thighAngle = Math.acos(THREE.MathUtils.clamp((Math.max(0.05, hipAboveFloor) + .02 - kneeHeight) / LEG_LENGTH, -1, 1));
      thigh.rotation.x = thighAngle; knee.rotation.x = -thighAngle; boot.rotation.x = 0;
    }
    this._target = new THREE.Vector3(); this._direction = new THREE.Vector3();
    this._pole = new THREE.Vector3(); this._joint = new THREE.Vector3();
    this._upperRotation = new THREE.Quaternion(); this._foreRotation = new THREE.Quaternion();
    this._mid = new THREE.Vector3(); this._left = new THREE.Vector3(); this._right = new THREE.Vector3();
    this._disposed = false;
    this.sync(player); this.update();
  }

  sync(player) {
    if (this._disposed) return;
    setAvatarTeam(this.avatar, player.team);
    applyAvatarCosmetics(this.avatar, player.cosmetics);
  }

  update(visualSteer = 0) {
    if (this._disposed) return;
    const grips = this.rig?.grips;
    if (grips) {
      // Face the mount, then hold its grips wherever it points.
      this.parent.updateWorldMatrix(true, false);
      grips.left.getWorldPosition(this._left); grips.right.getWorldPosition(this._right);
      this._mid.addVectors(this._left, this._right).multiplyScalar(0.5);
      this.parent.worldToLocal(this._mid);
      const dx = this._mid.x - this.avatar.group.position.x, dz = this._mid.z - this.avatar.group.position.z;
      if (Math.hypot(dx, dz) > 0.05) this.avatar.group.rotation.set(0, Math.atan2(-dx, -dz), 0);
      this.avatar.group.updateWorldMatrix(true, false);
      this.poseArm(-1, this.avatar.group.worldToLocal(this._target.copy(this._left)));
      this.poseArm(1, this.avatar.group.worldToLocal(this._target.copy(this._right)));
      return;
    }
    if (!this.seatDefinition.drives || !this.wheelControls) {
      for (const side of [-1, 1]) this.poseArm(side, this._target.set(side * .16, .15, -.27));
      return;
    }
    // Anchors use the actual wheel transform, including its authored tilt and turn.
    this.avatar.group.updateWorldMatrix(true, false);
    for (const side of [-1, 1]) {
      (side < 0 ? this.wheelControls.left : this.wheelControls.right).getWorldPosition(this._target);
      this.avatar.group.worldToLocal(this._target);
      this.poseArm(side, this._target);
    }
  }

  poseArm(side, target) {
    const avatar = this.avatar;
    const arm = side < 0 ? avatar.lArm : avatar.rArm;
    const elbow = side < 0 ? avatar.lElbow : avatar.rElbow;
    const hand = side < 0 ? avatar.lHand : avatar.rHand;
    arm.position.set(side * .32, .56, this.standing ? 0 : -.1);
    const direction = this._direction.subVectors(target, arm.position);
    const distance = Math.max(.001, direction.length()); direction.divideScalar(distance);
    const along = (UPPER_ARM * UPPER_ARM - FOREARM * FOREARM + distance * distance) / (2 * distance);
    const bend = Math.sqrt(Math.max(0, UPPER_ARM * UPPER_ARM - along * along));
    const pole = this._pole.set(side * (this.seatDefinition.drives || this.rig?.grips ? .8 : -.8), -1, .25);
    pole.addScaledVector(direction, -pole.dot(direction)).normalize();
    const joint = this._joint.copy(arm.position).addScaledVector(direction, along).addScaledVector(pole, bend);
    direction.subVectors(joint, arm.position).normalize();
    arm.quaternion.setFromUnitVectors(DOWN, direction);
    this._upperRotation.copy(arm.quaternion);
    direction.subVectors(target, joint).normalize();
    this._foreRotation.setFromUnitVectors(DOWN, direction);
    elbow.position.set(0, -UPPER_ARM, 0);
    elbow.quaternion.copy(this._upperRotation).invert().multiply(this._foreRotation);
    hand.position.set(0, -FOREARM, 0);
    hand.quaternion.copy(this._foreRotation).invert();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.avatar.group.removeFromParent();
    disposeAvatar(this.avatar);
  }
}

/** Generic name for the exposed-crew rig (jeep, tank commander, door gunners). */
export { JeepDriver as VehicleCrewMember };
