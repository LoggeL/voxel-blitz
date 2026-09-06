import { pronePose } from '../../../shared/player-stance.js';
import * as THREE from '../vendor/three.module.js';
import { disposeObjectTree } from '../engine/dispose.js';
import { smooth01 } from '../util/math.js';

const BODY_POSE = Object.freeze({
  hipsY: 0.72,
  hipsZ: 0.12,
  torsoY: 0.91,
  torsoZ: 0.16,
  legX: 0.13,
  legY: 0.66,
});

export function makeFirstPersonBody() {
  const group = new THREE.Group();
  group.name = 'first-person-body';
  group.rotation.order = 'YXZ';
  const cloth = new THREE.MeshLambertMaterial({ color: 0x44515e });
  const armor = new THREE.MeshLambertMaterial({ color: 0x202831 });
  const bootMaterial = new THREE.MeshLambertMaterial({ color: 0x0b0f14 });
  // The local body is a peripheral silhouette, not a second chest in front of
  // the camera. Its upper mass stays below and slightly behind the eye line.
  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.18, 0.25), armor);
  hips.position.set(0, BODY_POSE.hipsY, BODY_POSE.hipsZ);
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.22, 0.27), cloth);
  torso.position.set(0, BODY_POSE.torsoY, BODY_POSE.torsoZ);
  const thighGeometry = new THREE.BoxGeometry(0.18, 0.36, 0.21);
  const shinGeometry = new THREE.BoxGeometry(0.16, 0.34, 0.19);
  const bootGeometry = new THREE.BoxGeometry(0.18, 0.13, 0.3);

  function makeLeg(side) {
    const leg = new THREE.Group();
    leg.position.set(side * BODY_POSE.legX, BODY_POSE.legY, 0.04);
    const thigh = new THREE.Mesh(thighGeometry, cloth);
    thigh.position.y = -0.17;
    const knee = new THREE.Group();
    knee.position.y = -0.34;
    const shin = new THREE.Mesh(shinGeometry, armor);
    shin.position.y = -0.16;
    const boot = new THREE.Mesh(bootGeometry, bootMaterial);
    boot.position.set(0, -0.36, -0.05);
    knee.add(shin, boot);
    leg.add(thigh, knee);
    return { leg, knee, boot };
  }

  const left = makeLeg(-1);
  const right = makeLeg(1);
  group.add(hips, torso, left.leg, right.leg);
  const body = {
    group,
    hips,
    torso,
    left,
    right,
    phase: 0,
    crouch: 0,
    disposed: false,
  };
  resetFirstPersonBody(body);
  return body;
}

export function resetFirstPersonBody(body) {
  if (!body || body.disposed) return;
  body.phase = 0;
  body.crouch = 0;
  body.group.visible = true;
  body.group.rotation.set(0, 0, 0);
  body.group.scale.set(1, 1, 1);
  body.hips.position.set(0, BODY_POSE.hipsY, BODY_POSE.hipsZ);
  body.hips.rotation.set(0, 0, 0);
  body.torso.position.set(0, BODY_POSE.torsoY, BODY_POSE.torsoZ);
  body.torso.rotation.set(0, 0, 0);
  body.left.leg.position.set(-BODY_POSE.legX, BODY_POSE.legY, 0.04);
  body.right.leg.position.set(BODY_POSE.legX, BODY_POSE.legY, 0.04);
  body.left.leg.rotation.set(0, 0, 0);
  body.right.leg.rotation.set(0, 0, 0);
  body.left.knee.rotation.set(0, 0, 0);
  body.right.knee.rotation.set(0, 0, 0);
  body.left.boot.rotation.set(0, 0, 0);
  body.right.boot.rotation.set(0, 0, 0);
}

export function updateFirstPersonBody(
  body,
  dt,
  pos,
  yaw,
  speed,
  crouching,
  alive,
  deathElapsed,
  deathSide,
  scopeActive,
  proneT = 0,
) {
  if (!body || body.disposed || !pos) return;
  body.group.visible = !scopeActive;
  body.group.position.set(pos.x, pos.y, pos.z);
  const stride = alive ? Math.min(1, Math.max(0, speed) / 5.8) : 0;
  if (stride > 0.025) body.phase += dt * (5.4 + speed * 1.15);
  body.crouch += ((crouching && alive ? 1 : 0) - body.crouch) *
    Math.min(1, dt * 13);
  const crouch = crouching && alive ? 1 : body.crouch;
  const swing = Math.sin(body.phase) * stride;
  const bounce = Math.abs(Math.sin(body.phase * 2)) * stride * 0.025;

  if (!alive) {
    const death = smooth01(deathElapsed / 0.9);
    body.group.position.y -= death * 0.14;
    body.group.rotation.set(death * 1.08, yaw, deathSide * death * 0.92);
    body.torso.rotation.x = death * 0.28;
    body.hips.rotation.z = deathSide * death * 0.2;
    body.left.leg.rotation.x = -death * 0.5;
    body.right.leg.rotation.x = death * 0.72;
    body.left.knee.rotation.x = death * 0.34;
    body.right.knee.rotation.x = death * 0.62;
    return;
  }

  body.group.rotation.set(0, yaw, 0);
  body.hips.position.y = BODY_POSE.hipsY - crouch * 0.28 + bounce;
  body.torso.position.y = BODY_POSE.torsoY - crouch * 0.34 + bounce;
  body.torso.rotation.x = crouch * 0.12;
  body.hips.rotation.x = 0;
  body.hips.rotation.z = swing * stride * 0.045;
  body.left.leg.position.y = BODY_POSE.legY - crouch * 0.24;
  body.right.leg.position.y = BODY_POSE.legY - crouch * 0.24;
  body.left.leg.rotation.x = swing * 0.72 - crouch * 0.58;
  body.right.leg.rotation.x = -swing * 0.72 - crouch * 0.58;
  body.left.knee.rotation.x = crouch * 1.02 + Math.max(0, -swing) * 0.32;
  body.right.knee.rotation.x = crouch * 1.02 + Math.max(0, swing) * 0.32;
  const prone = pronePose(proneT);
  for (const [part, y, z] of [[body.hips, 0.25, 0.8], [body.torso, 0.3, 0.4],
    [body.left.leg, 0.25, 0.85], [body.right.leg, 0.25, 0.85]]) {
    part.position.y += (y - part.position.y) * prone;
    const standingZ = part === body.hips ? BODY_POSE.hipsZ : part === body.torso ? BODY_POSE.torsoZ : 0.04;
    part.position.z = standingZ + (z - standingZ) * prone;
    part.rotation.x = part.rotation.x * (1 - prone) - Math.PI / 2 * prone;
  }
  body.left.knee.rotation.x *= 1 - prone;
  body.right.knee.rotation.x *= 1 - prone;
}

/** Terminal cleanup for every scene object and GPU resource created by the factory. */
export function disposeFirstPersonBody(body) {
  if (!body || body.disposed) return;
  body.disposed = true;
  body.group.removeFromParent();
  disposeObjectTree(body.group);
  body.group.clear();
}
