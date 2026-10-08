import * as THREE from '../vendor/three.module.js';
import { makeAvatar, setAvatarTeam, disposeAvatar } from '../avatar/avatar.js';
import { UPPER_ARM, FOREARM } from '../avatar/operator-model.js';
import { applyAvatarCosmetics } from '../cosmetics/skins.js';
import { vehicleSeatDefinition } from '../../../shared/vehicle-seats.js';

const DOWN = new THREE.Vector3(0, -1, 0);
const LEG_LENGTH = .325;

/**
 * A seated aircraft crew member behind the canopy glass: the pilot holds the
 * cyclic and collective (or the jet's stick and throttle) with feet on the
 * pedals, an attack-helicopter gunner holds the sight grips, passengers rest.
 */
export class AircraftPilot {
  constructor(model, player, seat = vehicleSeatDefinition(model.type || model.kind || 'plane', 'driver')) {
    this.playerId = String(player.id);
    this.seatId = seat.id; this.role = seat.role; this.seatDefinition = seat;
    this.model = model;
    this.hull = model.group || model.hull;
    this.seat = model.seatAnchors?.[this.seatId] || model.operatorSeats?.[this.seatId] || (seat.drives ? model.operatorSeat : null);
    const parent = this.seat?.parent || this.hull;
    this.parent = parent;
    this.controls = seat.drives ? model.cockpitControls || {} : {};
    this.handAnchors = seat.drives
      ? model.controlAnchors || { left: this.controls.leftHand, right: this.controls.rightHand }
      : seat.role === 'gunner' ? model.gunnerAnchors || {} : {};
    this._shoulderWidth = model.type === 'plane' ? .32 : .25;
    this._inwardArms = model.type !== 'plane' || !seat.drives;
    this._target = new THREE.Vector3(); this._direction = new THREE.Vector3();
    this._pole = new THREE.Vector3(); this._joint = new THREE.Vector3();
    this._upperRotation = new THREE.Quaternion(); this._foreRotation = new THREE.Quaternion();
    this._disposed = false;
    this.firstPerson = false;
    this.avatar = makeAvatar(this.playerId, player.name || '', player.team);
    const avatar = this.avatar;
    avatar.weaponModel.dispose(); avatar.weaponModel = null;
    avatar.tag.visible = avatar.hpSpr.visible = false;
    for (const sprite of [avatar.tag, avatar.hpSpr]) sprite.geometry.userData.pageOwned = true;
    avatar.group.name = seat.drives ? 'aircraft-pilot' : 'aircraft-passenger';
    avatar.group.userData.playerId = this.playerId;
    avatar.group.userData.vehicleSeatId = this.seatId;
    parent.add(avatar.group);
    if (this.seat) avatar.group.position.copy(this.seat.position);
    else avatar.group.position.fromArray(seat.position);
    avatar.hips.position.set(0, 0, 0);
    avatar.torso.position.set(0, .31, 0);
    avatar.head.position.set(0, .76, -.025);
    const hipHeight = this.seat?.userData.pivot?.[1] ?? seat.position[1];
    const floorTop = Number.isFinite(model.floorTop) ? model.floorTop : 1;
    for (const [leg, side] of [[avatar.lLeg, -1], [avatar.rLeg, 1]]) {
      leg.position.set(side * .15, .02, 0);
      leg.rotation.set(0, 0, 0); leg.scale.setScalar(1);
      const { skeleton, thigh, knee, boot } = leg.userData.joints;
      skeleton.scale.setScalar(1);
      const pedal = side < 0 ? this.controls.leftPedal : this.controls.rightPedal;
      if (pedal) {
        this.anchorInAvatar(pedal, this._target);
        this.poseSegments(thigh, knee, boot, leg.position, this._target, LEG_LENGTH, LEG_LENGTH, side);
      } else {
        const kneeHeight = floorTop + .075 + LEG_LENGTH;
        const thighAngle = Math.acos(THREE.MathUtils.clamp((hipHeight + .02 - kneeHeight) / LEG_LENGTH, -1, 1));
        thigh.rotation.x = thighAngle; knee.rotation.x = -thighAngle; boot.rotation.x = 0;
      }
    }
    this.sync(player); this.update();
  }

  sync(player) {
    if (this._disposed) return;
    setAvatarTeam(this.avatar, player.team);
    applyAvatarCosmetics(this.avatar, player.cosmetics);
  }

  anchorInAvatar(anchor, target) {
    anchor.getWorldPosition(target);
    this.avatar.group.updateWorldMatrix(true, false);
    this.avatar.group.worldToLocal(target);
    return target;
  }

  update() {
    if (this._disposed) return;
    // The control anchor can itself animate, so the palms follow its world transform.
    for (const side of [-1, 1]) {
      const anchor = side < 0 ? this.handAnchors.left : this.handAnchors.right;
      const avatar = this.avatar;
      const arm = side < 0 ? avatar.lArm : avatar.rArm;
      const elbow = side < 0 ? avatar.lElbow : avatar.rElbow;
      const hand = side < 0 ? avatar.lHand : avatar.rHand;
      arm.position.set(side * this._shoulderWidth, .56, 0);
      if (anchor) this.anchorInAvatar(anchor, this._target);
      else this._target.set(side * .16, .15, -.27);
      this.poseSegments(arm, elbow, hand, arm.position, this._target, UPPER_ARM, FOREARM, side);
    }
  }

  poseSegments(upper, lower, tip, origin, target, upperLength, lowerLength, side) {
    const direction = this._direction.subVectors(target, origin);
    const distance = Math.max(.001, direction.length()); direction.divideScalar(distance);
    const along = (upperLength * upperLength - lowerLength * lowerLength + distance * distance) / (2 * distance);
    const bend = Math.sqrt(Math.max(0, upperLength * upperLength - along * along));
    const pole = this._pole.set(upperLength === LEG_LENGTH ? 0 : side * (this._inwardArms ? -.8 : .8), -1, upperLength === LEG_LENGTH ? -1 : .25);
    pole.addScaledVector(direction, -pole.dot(direction)).normalize();
    const joint = this._joint.copy(origin).addScaledVector(direction, along).addScaledVector(pole, bend);
    direction.subVectors(joint, origin).normalize();
    upper.quaternion.setFromUnitVectors(DOWN, direction);
    this._upperRotation.copy(upper.quaternion);
    direction.subVectors(target, joint).normalize();
    this._foreRotation.setFromUnitVectors(DOWN, direction);
    lower.position.set(0, -upperLength, 0);
    lower.quaternion.copy(this._upperRotation).invert().multiply(this._foreRotation);
    tip.position.set(0, -lowerLength, 0);
    tip.quaternion.copy(this._foreRotation).invert();
  }

  /**
   * First person from this seat (the local player's cockpit view): head, chest
   * and upper arms are hidden; forearms, hands on the controls and legs stay.
   */
  setFirstPerson(on) {
    const hidden = !!on;
    if (this._disposed || hidden === this.firstPerson) return;
    this.firstPerson = hidden;
    const avatar = this.avatar;
    avatar.head.visible = avatar.torso.visible = !hidden;
    for (const arm of [avatar.lArm, avatar.rArm]) {
      for (const child of arm.children) if (child !== avatar.lElbow && child !== avatar.rElbow) child.visible = !hidden;
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.avatar.group.removeFromParent();
    disposeAvatar(this.avatar);
  }
}
