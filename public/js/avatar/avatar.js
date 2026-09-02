import * as THREE from '../vendor/three.module.js';
import { disposeObjectTree } from '../engine/dispose.js';
import { clamp01 } from '../util/math.js';
import { hashHue, hashInt } from '../util/hash.js';
import { AvatarWeaponModel } from './avatar-weapon.js';

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
  stride = 0,
  swing = 0,
  dt = 0,
  blend = 1,
  charge = 0,
} = {}) {
  const aimPitch = Math.max(-1.1, Math.min(1.1, Number(pitch) || 0));
  const poseBlend = Math.max(0, Math.min(1, Number(blend) || 0));
  const stanceBlend = dt > 0 ? 1 - Math.exp(-dt * 12) : poseBlend;
  av.crouchPose += ((crouching ? 1 : 0) - av.crouchPose) * stanceBlend;
  av.weaponModel.update({
    weapon,
    pitch,
    firing,
    ads,
    reloading,
    crouchT: av.crouchPose,
    stride,
    swing,
    dt,
    charge,
  });
  const adsT = av.weaponModel.adsT;
  const reloadT = av.weaponModel.reloadT;
  // The support hand leaves the handguard to work the magazine; the firing arm dips.
  if (dt > 0) av.reloadPhase = (av.reloadPhase || 0) + dt / 0.9;
  const reloadPulse = reloadT * (0.5 + 0.5 * Math.sin(Math.PI * 2 * (av.reloadPhase || 0)));
  const handPose = av.weaponModel.handPose;
  const twoHanded = !!handPose.support;
  const supportReach = twoHanded
    ? clamp01((-handPose.support.z - 0.24) / 0.26)
    : 0;
  const gripLift = Math.max(-0.03, Math.min(0.03, Number(handPose.grip.y) || 0));
  const crouchDrop = av.crouchPose * 0.29;
  const leftArmX = (twoHanded
    ? 0.86 + supportReach * 0.14 + aimPitch + adsT * 0.18 - swing * stride * 0.08
    : -swing * 0.5) - reloadT * 0.55 - reloadPulse * 0.25;
  const leftArmZ = (twoHanded ? 0.30 + supportReach * 0.12 + adsT * 0.08 : -0.08) + reloadT * 0.22;
  av.lArm.position.x += ((-0.41 + (twoHanded ? adsT * 0.035 : 0)) -
    av.lArm.position.x) * poseBlend;
  av.rArm.position.x += ((0.41 - adsT * 0.045) - av.rArm.position.x) * poseBlend;
  av.lArm.position.y += ((1.45 - crouchDrop + adsT * 0.16) - av.lArm.position.y) * poseBlend;
  av.rArm.position.y += ((1.45 - crouchDrop + adsT * 0.18) - av.rArm.position.y) * poseBlend;
  av.lArm.position.z += ((twoHanded ? -adsT * 0.025 : 0) - av.lArm.position.z) * poseBlend;
  av.rArm.position.z += (-adsT * 0.035 - av.rArm.position.z) * poseBlend;
  av.lArm.rotation.x += (leftArmX - av.lArm.rotation.x) * poseBlend;
  av.rArm.rotation.x += (1.00 + gripLift * 0.9 + aimPitch * (1 - reloadT * 0.6) + adsT * 0.19 +
    swing * stride * 0.06 - reloadT * 0.3 - av.rArm.rotation.x) * poseBlend;
  av.lArm.rotation.z += (leftArmZ - av.lArm.rotation.z) * poseBlend;
  av.rArm.rotation.z += (-0.34 - av.rArm.rotation.z) * poseBlend;
  av.lElbow.rotation.x += ((twoHanded ? 0.40 + supportReach * 0.14 : -0.34) + reloadT * 0.5 -
    av.lElbow.rotation.x) * poseBlend;
  av.rElbow.rotation.x += (0.38 - av.rElbow.rotation.x) * poseBlend;
}

/** Apply the body-height part of the remote stance without owning world-space movement. */
export function updateAvatarStancePose(av, {
  stride = 0,
  swing = 0,
  blend = 1,
} = {}) {
  const poseBlend = Math.max(0, Math.min(1, Number(blend) || 0));
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
    const radial = 2.1 + ((seed >>> 8) & 255) / 255 * 1.9;
    const boost = headshot && i === 0 ? 1.85 : 1;
    limb.object.position.copy(limb.basePosition);
    limb.object.rotation.copy(limb.baseRotation);
    limb.velocity.set(
      Math.cos(angle) * radial * boost,
      (3.1 + ((seed >>> 16) & 255) / 255 * 2.8) * boost,
      Math.sin(angle) * radial * boost,
    );
    limb.angular.set(
      (((seed >>> 3) & 15) - 7.5) * 0.75,
      (((seed >>> 11) & 15) - 7.5) * 0.62,
      (((seed >>> 19) & 15) - 7.5) * 0.8,
    );
  }
  setAvatarFlash(av, 0);
  return true;
}

export function updateAvatarDeath(av, dt, t) {
  av.torso.position.y = 1.18 - t * 0.56;
  av.torso.rotation.x = t * 1.08;
  av.torso.rotation.z = av.deathSide * t * 0.3;
  av.hips.position.y = 0.84 - t * 0.38;
  av.hips.rotation.x = t * 0.72;
  av.hips.rotation.z = av.deathSide * t * 0.22;
  av.weaponModel?.setDeathPose(t, av.deathSide);
  for (const limb of av.limbStates) {
    limb.velocity.y -= 11.8 * dt;
    limb.object.position.x += limb.velocity.x * dt;
    limb.object.position.y += limb.velocity.y * dt;
    limb.object.position.z += limb.velocity.z * dt;
    if (limb.object.position.y < limb.floorY) {
      limb.object.position.y = limb.floorY;
      if (limb.velocity.y < 0) limb.velocity.y *= -0.24;
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
  const visorMat = new THREE.MeshBasicMaterial({ color: 0x11141a, transparent: true });
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.62, 0.34), suit);
  torso.position.y = 1.18;
  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.22, 0.32), dark);
  hips.position.y = 0.84;

  const head = new THREE.Group();
  head.position.y = 1.66;
  const headBox = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.32, 0.34), suit);
  const helm = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.14, 0.38), dark);
  helm.position.y = 0.16;
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.07, 0.02), visorMat);
  visor.position.set(0, 0.02, -0.175);
  head.add(headBox, helm, visor);

  const lLeg = new THREE.Group();
  lLeg.position.set(-0.16, 0.73, 0);
  const lLegMesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.72, 0.24), dark);
  lLegMesh.position.y = -0.36;
  lLeg.add(lLegMesh);
  const rLeg = new THREE.Group();
  rLeg.position.set(0.16, 0.73, 0);
  const rLegMesh = lLegMesh.clone();
  rLegMesh.position.y = -0.36;
  rLeg.add(rLegMesh);

  const lArm = new THREE.Group();
  lArm.position.set(-0.41, 1.45, 0);
  const lUpper = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.48, 0.2), suit);
  lUpper.position.y = -0.23;
  const lElbow = new THREE.Group();
  lElbow.position.y = -0.45;
  const lFore = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.42, 0.18), dark);
  lFore.position.set(0, -0.19, -0.04);
  lElbow.add(lFore);
  lArm.add(lUpper, lElbow);

  const rArm = new THREE.Group();
  rArm.position.set(0.41, 1.45, 0);
  const rUpper = lUpper.clone();
  const rElbow = new THREE.Group();
  rElbow.position.y = -0.45;
  const rFore = lFore.clone();
  rElbow.add(rFore);
  rArm.add(rUpper, rElbow);

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
    fadeMaterials: [suit, dark, visorMat, tagMat, hpMat],
    flashMaterials: [suit, dark],
    updateHealth,
  };
  resetAvatarPose(avatar);
  avatar.limbStates = [
    { object: head, floorY: 0.18 },
    { object: lArm, floorY: 0.86 },
    { object: rArm, floorY: 0.86 },
    { object: lLeg, floorY: 0.72 },
    { object: rLeg, floorY: 0.72 },
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
