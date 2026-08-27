import * as THREE from '../vendor/three.module.js';
import { disposeObjectTree } from '../engine/dispose.js';
import { clamp01 } from '../util/math.js';
import { hashHue, hashInt } from '../util/hash.js';

export const TEAM_AVATAR_COLORS = Object.freeze({
  alpha: Object.freeze({ suit: 0x38bdf8, dark: 0x0c4a6e }),
  bravo: Object.freeze({ suit: 0xfb923c, dark: 0x7c2d12 }),
});

export function disposeAvatar(av) {
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
}

export function setAvatarFlash(av, amount) {
  const flash = clamp01(amount);
  for (let i = 0; i < av.flashMaterials.length; i++) {
    av.flashMaterials[i].emissive.setRGB(flash * 0.9, flash * 0.08, flash * 0.04);
  }
}

export function resetAvatarPose(av) {
  av.alive = true;
  av.deathT = 0;
  av.deathForcedUntil = 0;
  av.hitT = 0;
  av.speedEst = 0;
  av.runPhase = 0;
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
  av.lLeg.rotation.set(0, 0, 0);
  av.rLeg.position.set(0.16, 0.73, 0);
  av.rLeg.rotation.set(0, 0, 0);
  av.lArm.position.set(-0.41, 1.45, 0);
  av.lArm.rotation.set(0, 0, -0.08);
  av.rArm.position.set(0.41, 1.45, 0);
  av.rArm.rotation.set(0, 0, 0.08);
  av.lElbow.rotation.set(-0.34, 0, 0);
  av.rElbow.rotation.set(-0.46, 0, 0);
  if (av.gunStub) {
    av.gunStub.position.set(0.22, 1.2, -0.4);
    av.gunStub.rotation.set(0, 0, 0);
  }
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
  if (av.gunStub) {
    av.gunStub.position.y = 1.2 - t * 0.58;
    av.gunStub.rotation.x = t * 0.9;
    av.gunStub.rotation.z = -av.deathSide * t * 0.48;
  }
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

  const gunStub = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.72), dark);
  gunStub.position.set(0.22, 1.2, -0.4);

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

  group.add(torso, hips, head, lLeg, rLeg, lArm, rArm, gunStub, tag, hpSpr);

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
    gunStub,
    tag,
    hpSpr,
    limbStates: [],
    speedEst: 0,
    runPhase: 0,
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
