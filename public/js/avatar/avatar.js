import { pronePose } from '../../../shared/player-stance.js';
import * as THREE from '../vendor/three.module.js';
import { disposeObjectTree } from '../engine/dispose.js';
import { clamp01 } from '../util/math.js';
import { hashHue, hashInt } from '../util/hash.js';
import { AvatarWeaponModel } from './avatar-weapon.js';
import { buildOperator, poseOperatorArm } from './operator-model.js';

export const TEAM_AVATAR_COLORS = Object.freeze({
  alpha: Object.freeze({ suit: 0x38bdf8, dark: 0x0c4a6e }),
  bravo: Object.freeze({ suit: 0xfb923c, dark: 0x7c2d12 }),
});

export function disposeAvatar(av) {
  av.weaponModel?.dispose();
  disposeObjectTree(av.group);
}

export function setAvatarTeam(av, team) {
  const normalized = team === 'alpha' || team === 'bravo' ? team : null;
  if (av.team === normalized) return;
  av.team = normalized;
  const palette = normalized ? TEAM_AVATAR_COLORS[normalized] : null;
  if (palette) {
    av.suitMaterial.color.setHex(palette.suit);
    av.darkMaterial.color.setHex(palette.dark);
    return;
  }
  const hue = hashHue(av.id);
  av.suitMaterial.color.setHSL(hue / 360, 0.32, 0.42);
  av.darkMaterial.color.setHSL(hue / 360, 0.25, 0.2);
}

export function setAvatarOpacity(av, opacity) {
  for (let i = 0; i < av.fadeMaterials.length; i++) av.fadeMaterials[i].opacity = opacity;
  if (av.weaponModel) av.weaponModel.root.visible = opacity > 0.45;
}

export function setAvatarFlash(av, amount) {
  const flash = clamp01(amount);
  for (let i = 0; i < av.flashMaterials.length; i++) {
    av.flashMaterials[i].emissive.setRGB(flash * 0.9, flash * 0.08, flash * 0.04);
  }
}

/** Keep the third-person arms and the carried weapon on one shared pose contract. */
export function updateAvatarWeaponPose(av, {
  weapon = 0,
  pitch = 0,
  firing = false,
  ads = false,
  reloading = false,
  crouching = false,
  proneT = 0,
  stride = 0,
  swing = 0,
  dt = 0,
  blend = 1,
  charge = 0,
  minigun,
} = {}) {
  const poseBlend = Math.max(0, Math.min(1, Number(blend) || 0));
  const stanceBlend = dt > 0 ? 1 - Math.exp(-dt * 12) : poseBlend;
  av.pronePose = pronePose(proneT);
  av.crouchPose += ((crouching ? 1 : 0) - av.crouchPose) * stanceBlend;
  av.weaponModel.update({
    weapon,
    pitch,
    firing,
    ads,
    reloading,
    crouchT: av.crouchPose,
    prone: av.pronePose,
    stride,
    swing,
    dt,
    charge,
    minigun,
  });
  if (dt > 0) av.reloadPhase = (av.reloadPhase || 0) + dt / 0.9;
  const reload = av.weaponModel.reloadT * (0.65 + 0.25 * Math.sin(Math.PI * 2 * (av.reloadPhase || 0)));
  av.group.updateMatrixWorld(true);
  poseOperatorArm(av, 1, av.weaponModel.handPose.grip);
  poseOperatorArm(av, -1, av.weaponModel.handPose.support, reload);
}

/** Apply the body-height part of the remote stance without owning world-space movement. */
export function updateAvatarStancePose(av, {
  stride = 0,
  swing = 0,
  blend = 1,
} = {}) {
  const poseBlend = av.pronePose > 0 ? 1 : Math.max(0, Math.min(1, Number(blend) || 0));
  const crouch = clamp01(av.crouchPose);
  av.lLeg.position.y += ((0.73 - crouch * 0.26) - av.lLeg.position.y) * poseBlend;
  av.rLeg.position.y += ((0.73 - crouch * 0.26) - av.rLeg.position.y) * poseBlend;
  av.lLeg.scale.y += ((1 - crouch * 0.35) - av.lLeg.scale.y) * poseBlend;
  av.rLeg.scale.y += ((1 - crouch * 0.35) - av.rLeg.scale.y) * poseBlend;
  av.lLeg.rotation.x += (swing * 0.78 * (1 - crouch * 0.6) -
    av.lLeg.rotation.x) * poseBlend;
  av.rLeg.rotation.x += (-swing * 0.78 * (1 - crouch * 0.6) -
    av.rLeg.rotation.x) * poseBlend;
  av.torso.position.y += ((1.18 - crouch * 0.27) - av.torso.position.y) * poseBlend;
  av.hips.position.y += ((0.84 - crouch * 0.20) - av.hips.position.y) * poseBlend;
  av.head.position.y += ((1.66 - crouch * 0.34) - av.head.position.y) * poseBlend;
  av.torso.rotation.x += (stride * 0.16 + crouch * 0.12 -
    av.torso.rotation.x) * poseBlend;
  av.hips.rotation.x = 0;
  const prone = av.pronePose || 0;
  for (const [part, y, z, tilt] of [
    [av.head, 0.48, 0, null], [av.torso, 0.3, 0.4, -Math.PI / 2],
    [av.hips, 0.25, 0.8, -Math.PI / 2],
    [av.lLeg, 0.25, 0.85, -Math.PI / 2], [av.rLeg, 0.25, 0.85, -Math.PI / 2],
  ]) {
    if (part === av.lLeg || part === av.rLeg) part.scale.y += (1 - part.scale.y) * prone;
    part.position.y += (y - part.position.y) * prone;
    part.position.z = z * prone;
    if (tilt !== null) part.rotation.x = part.rotation.x * (1 - prone) + tilt * prone;
  }
}

export function resetAvatarPose(av) {
  av.alive = true;
  av.deathT = 0;
  av.deathForcedUntil = 0;
  av.hitT = 0;
  av.speedEst = 0;
  av.runPhase = 0;
  av.reloadPhase = 0;
  av.crouchPose = 0;
  av.pronePose = 0;
  for (const part of [av.head, av.torso, av.hips, av.lLeg, av.rLeg]) part.position.z = 0;
  av.lastImpact = null;
  av.motionSeeded = false;
  av.group.visible = true;
  av.group.rotation.set(0, 0, 0);
  av.group.scale.set(1, 1, 1);
  av.torso.position.set(0, 1.18, 0);
  av.torso.rotation.set(0, 0, 0);
  av.hips.position.set(0, 0.84, 0);
  av.hips.rotation.set(0, 0, 0);
  av.head.position.set(0, 1.66, 0);
  av.head.rotation.set(0, 0, 0);
  av.lLeg.position.set(-0.16, 0.73, 0);
  av.lLeg.scale.set(1, 1, 1);
  av.lLeg.rotation.set(0, 0, 0);
  av.rLeg.position.set(0.16, 0.73, 0);
  av.rLeg.scale.set(1, 1, 1);
  av.rLeg.rotation.set(0, 0, 0);
  av.lArm.position.set(-0.41, 1.45, 0);
  av.lArm.rotation.set(0, 0, -0.08);
  av.rArm.position.set(0.41, 1.45, 0);
  av.rArm.rotation.set(0, 0, 0.08);
  av.lArm.scale.set(1, 1, 1);
  av.rArm.scale.set(1, 1, 1);
  av.lElbow.scale.set(1, 1, 1);
  av.rElbow.scale.set(1, 1, 1);
  av.lElbow.rotation.set(-0.34, 0, 0);
  av.rElbow.rotation.set(-0.46, 0, 0);
  av.weaponModel?.resetPose();
  if (av.tag) av.tag.visible = true;
  if (av.hpSpr) av.hpSpr.visible = true;
  for (const limb of av.limbStates || []) {
    limb.object.visible = true;
    limb.object.position.copy(limb.basePosition);
    limb.object.rotation.copy(limb.baseRotation);
    limb.velocity.set(0, 0, 0);
    limb.angular.set(0, 0, 0);
  }
  setAvatarOpacity(av, 1);
  setAvatarFlash(av, 0);
}

export function beginAvatarDeath(av, now, impact = null) {
  if (!av.alive) return false;
  av.alive = false;
  av.deathT = 0;
  av.hitT = 0;
  av.speedEst = 0;
  av.motionSeeded = false;
  av.lastImpact = impact ? { ev: impact, until: now + 2200 } : av.lastImpact;
  av.deathForcedUntil = Math.max(av.deathForcedUntil, now + 1420);
  if (av.tag) av.tag.visible = false;
  if (av.hpSpr) av.hpSpr.visible = false;
  const headshot = !!impact?.hs;
  for (let i = 0; i < av.limbStates.length; i++) {
    const limb = av.limbStates[i];
    const seed = hashInt(`${av.id}|${i}|${headshot ? 1 : 0}`);
    const angle = (seed / 0xffffffff) * Math.PI * 2;
    const radial = 5.8 + ((seed >>> 8) & 255) / 255 * 4.2;
    const boost = headshot && i === 0 ? 1.55 : 1;
    limb.object.position.copy(limb.basePosition);
    limb.object.rotation.copy(limb.baseRotation);
    limb.velocity.set(
      Math.cos(angle) * radial * boost,
      (6.2 + ((seed >>> 16) & 255) / 255 * 3.8) * boost,
      Math.sin(angle) * radial * boost,
    );
    limb.angular.set(
      (((seed >>> 3) & 15) - 7.5) * 1.5,
      (((seed >>> 11) & 15) - 7.5) * 1.24,
      (((seed >>> 19) & 15) - 7.5) * 1.6,
    );
  }
  setAvatarFlash(av, 0);
  return true;
}

export function updateAvatarDeath(av, dt, t) {
  av.weaponModel?.setDeathPose(t, av.deathSide);
  for (const limb of av.limbStates) {
    limb.velocity.y -= 11.8 * dt;
    limb.object.position.x += limb.velocity.x * dt;
    limb.object.position.y += limb.velocity.y * dt;
    limb.object.position.z += limb.velocity.z * dt;
    if (limb.object.position.y < limb.floorY) {
      limb.object.position.y = limb.floorY;
      if (limb.velocity.y < 0) limb.velocity.y *= -0.58;
      limb.velocity.x *= Math.max(0, 1 - dt * 7);
      limb.velocity.z *= Math.max(0, 1 - dt * 7);
    }
    limb.object.rotation.x += limb.angular.x * dt;
    limb.object.rotation.y += limb.angular.y * dt;
    limb.object.rotation.z += limb.angular.z * dt;
  }
}

export function makeAvatar(id, name, team = null) {
  const group = new THREE.Group();
  const hue = hashHue(id);
  const suit = new THREE.MeshLambertMaterial({
    color: new THREE.Color().setHSL(hue / 360, 0.32, 0.42),
    transparent: true,
  });
  const dark = new THREE.MeshLambertMaterial({
    color: new THREE.Color().setHSL(hue / 360, 0.25, 0.2),
    transparent: true,
  });
  const armor = new THREE.MeshStandardMaterial({ color: 0x26323b, roughness: 0.7, metalness: 0.25, transparent: true });
  const visorMat = new THREE.MeshStandardMaterial({ color: 0x6aa5af, roughness: 0.22, metalness: 0.75, transparent: true });
  const variant = hashInt(id) % 3;
  const skin = new THREE.MeshStandardMaterial({ color: [0xc68b67, 0x8c5b42, 0xe0ae87][variant], roughness: 0.92, transparent: true });
  const { torso, hips, head, lLeg, rLeg, lArm, rArm, lElbow, rElbow, lHand, rHand } =
    buildOperator({ suit, dark, armor, visor: visorMat, skin, variant });

  const weaponModel = new AvatarWeaponModel();
  weaponModel.setWeapon('rifle');

  const tagCv = document.createElement('canvas');
  tagCv.width = 256;
  tagCv.height = 64;
  const tc = tagCv.getContext('2d');
  const radius = 14;
  tc.fillStyle = 'rgba(8,10,14,.55)';
  tc.beginPath();
  tc.moveTo(16 + radius, 8);
  tc.arcTo(240, 8, 240, 56, radius);
  tc.arcTo(240, 56, 16, 56, radius);
  tc.arcTo(16, 56, 16, 8, radius);
  tc.arcTo(16, 8, 240, 8, radius);
  tc.closePath();
  tc.fill();
  tc.font = 'bold 28px Rajdhani, Arial Narrow, sans-serif';
  tc.textAlign = 'center';
  tc.textBaseline = 'middle';
  tc.lineWidth = 3;
  tc.strokeStyle = '#000';
  tc.strokeText(name, 128, 33);
  tc.fillStyle = '#fff';
  tc.fillText(name, 128, 33);
  const tagMat = new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(tagCv), transparent: true, depthTest: true,
  });
  const tag = new THREE.Sprite(tagMat);
  tag.scale.set(1.6, 0.4, 1);
  tag.position.set(0, 2.15, 0);

  const hpCv = document.createElement('canvas');
  hpCv.width = 256;
  hpCv.height = 64;
  const hc = hpCv.getContext('2d');
  const hpTex = new THREE.CanvasTexture(hpCv);
  const hpMat = new THREE.SpriteMaterial({ map: hpTex, transparent: true, depthTest: true });
  const hpSpr = new THREE.Sprite(hpMat);
  hpSpr.scale.set(1.2, 0.3, 1);
  hpSpr.position.set(0, 1.95, 0);

  group.add(torso, hips, head, lLeg, rLeg, lArm, rArm, weaponModel.root, tag, hpSpr);

  function updateHealth(t01) {
    hc.clearRect(0, 0, 256, 64);
    hc.fillStyle = '#10141a';
    hc.fillRect(0, 52, 256, 12);
    hc.fillStyle = t01 > 0.5 ? '#7fd069' : t01 > 0.25 ? '#ffb340' : '#ff3355';
    hc.fillRect(0, 52, Math.max(0, Math.round(256 * t01)), 12);
    hpTex.needsUpdate = true;
  }

  const avatar = {
    id,
    group,
    torso,
    hips,
    head,
    lLeg,
    rLeg,
    lArm,
    rArm,
    lElbow,
    rElbow,
    weaponModel,
    lHand,
    rHand,
    variant,
    tag,
    hpSpr,
    limbStates: [],
    speedEst: 0,
    runPhase: 0,
    crouchPose: 0,
    px: 0,
    pz: 0,
    motionSeeded: false,
    lastHp: null,
    lastImpact: null,
    alive: true,
    deathT: 0,
    deathForcedUntil: 0,
    deathSide: (hashInt(id) & 1) ? 1 : -1,
    hitT: 0,
    hitSide: 1,
    team: undefined,
    suitMaterial: suit,
    darkMaterial: dark,
    fadeMaterials: [suit, dark, armor, skin, visorMat, tagMat, hpMat],
    flashMaterials: [suit, dark, armor, skin],
    updateHealth,
  };
  resetAvatarPose(avatar);
  avatar.limbStates = [
    { object: head, floorY: 0.18 },
    { object: lArm, floorY: 0.86 },
    { object: rArm, floorY: 0.86 },
    { object: lLeg, floorY: 0.72 },
    { object: rLeg, floorY: 0.72 },
    { object: torso, floorY: 0.28 },
    { object: hips, floorY: 0.18 },
  ].map((limb) => ({
    ...limb,
    basePosition: limb.object.position.clone(),
    baseRotation: limb.object.rotation.clone(),
    velocity: new THREE.Vector3(),
    angular: new THREE.Vector3(),
  }));
  setAvatarTeam(avatar, team);
  return avatar;
}
