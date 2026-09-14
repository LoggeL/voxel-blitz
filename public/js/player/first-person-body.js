import { applyBodyCosmetics } from '../cosmetics/skins.js';
import { pronePose, stepSwim, swimCycle, swimEffort } from '../../../shared/player-stance.js';
import * as THREE from '../vendor/three.module.js';
import { disposeObjectTree } from '../engine/dispose.js';
import { smooth01 } from '../util/math.js';
import { createBlenderParts } from '../engine/blender-assets.js';

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
  const rivet = createBlenderParts('rivet', { names: ['torso', 'hips',
    'lThigh', 'lKnee', 'lBoot', 'rThigh', 'rKnee', 'rBoot'], materialFor(original) {
    const material = original.clone();
    if (original.userData.slot === 'dark') material.userData.paletteColor = 0x44515e;
    else if (original.userData.paletteColor === 0x26323b || original.userData.slot === 'suit') {
      material.userData.paletteColor = 0x202831;
    }
    return material;
  } });
  if (rivet) {
    // Keep the local body's established peripheral pose carriers. Its chest is
    // compressed below the camera; legs retain the authored armor and boots.
    const replacements = [[hips, rivet.hips], [torso, rivet.torso]];
    rivet.torso.scale.y = .4;
    for (const [side, entry] of [['l', left], ['r', right]]) {
      const thigh = entry.leg.children.find(object => object.isMesh);
      const shin = entry.knee.children.find(object => object.isMesh && object !== entry.boot);
      replacements.push([thigh, rivet[`${side}Thigh`]], [shin, rivet[`${side}Knee`]], [entry.boot, rivet[`${side}Boot`]]);
      // The delivered limb meshes already contain their offset from the joint.
      rivet[`${side}Thigh`].position.y = .17;
      rivet[`${side}Knee`].position.y = .16;
      rivet[`${side}Boot`].position.set(0, .115, .05);
    }
    const oldGeometry = new Set(), oldMaterials = new Set();
    for (const [carrier, replacement] of replacements) {
      oldGeometry.add(carrier.geometry); oldMaterials.add(carrier.material);
      carrier.geometry = new THREE.BufferGeometry();
      // Empty carriers keep the public body API intact without drawing a box.
      carrier.material = new THREE.MeshBasicMaterial();
      carrier.add(replacement);
    }
    for (const geometry of oldGeometry) geometry.dispose();
    for (const material of oldMaterials) material.dispose();
    group.userData.blenderAsset = 'rivet';
  }
  const body = {
    group,
    setCosmetics(loadout) { applyBodyCosmetics(body, loadout); },
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
  body.stride = 0;
  body.air = 0;
  body.land = 0;
  body.fallSpeed = 0;
  body.wasGrounded = null;
  body.forward = 1;
  body.lateral = 0;
  body.clock = 0;
  body.swim = 0;
  body.swimEffort = 0;
  body.swimPhase = 0;
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
  motion = {},
) {
  if (!body || body.disposed || !pos) return;
  body.group.visible = !scopeActive;
  body.group.position.set(pos.x, pos.y, pos.z);
  const seconds = Math.max(0, Math.min(0.1, dt));
  const follow = 1 - Math.exp(-13 * seconds);
  const grounded = motion.grounded !== false && !motion.vaulting;
  const vertical = Number(motion.verticalVelocity) || 0;
  body.clock += seconds;
  body.stride += ((alive && grounded ? Math.min(1, Math.max(0, speed) / 5.8) : 0) - body.stride) * follow;
  body.air += ((alive && !grounded ? 1 : 0) - body.air) * follow;
  body.land *= Math.exp(-12 * seconds);
  if (!grounded && !motion.vaulting) body.fallSpeed = Math.max(body.fallSpeed, -vertical);
  if (grounded && body.wasGrounded === false) {
    body.land = Math.min(1, body.fallSpeed / 9);
    body.fallSpeed = 0;
  }
  if (motion.vaulting) body.fallSpeed = 0;
  body.wasGrounded = grounded;
  // Floating (swimming, not touching the bottom) leans the body into the water;
  // wading in shallow water keeps the walk. The lean fades under crouch (the
  // dive input) and prone, which keep their own stances.
  const floating = alive && motion.swimming === true && motion.grounded === false && !motion.vaulting;
  body.swim = stepSwim(body.swim || 0, floating, seconds);
  body.swimEffort = (body.swimEffort || 0) + (swimEffort(speed) - (body.swimEffort || 0)) * follow;
  if (body.swim > 0.01) body.swimPhase = (body.swimPhase || 0) + seconds * (2.4 + 3.4 * body.swimEffort);
  const forward = speed > 0.1 && Number.isFinite(motion.forwardSpeed) ? motion.forwardSpeed / speed : 1;
  const lateral = speed > 0.1 && Number.isFinite(motion.lateralSpeed) ? motion.lateralSpeed / speed : 0;
  body.forward += (forward - body.forward) * follow;
  body.lateral += (lateral - body.lateral) * follow;
  const stride = body.stride;
  if (stride > 0.025) body.phase += seconds * (5.4 + speed * 1.15);
  body.crouch += ((crouching && alive ? 1 : 0) - body.crouch) * follow;
  const crouch = body.crouch;
  const swing = Math.sin(body.phase) * stride;
  const bounce = Math.abs(Math.sin(body.phase * 2)) * stride * 0.025;
  const compression = body.land * 0.075;
  const breathing = Math.sin(body.clock * 2.3) * 0.004 * (1 - stride) * (1 - body.air);

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

  // The local body has no hitbox to honour, so its swim lean and flutter kick
  // are wider than the third-person avatar's; the airborne tuck yields to them.
  const cycle = swimCycle(body.swimPhase || 0, body.swimEffort, body.swim * (1 - crouch));
  const swim = cycle.weight;
  const dry = 1 - swim;
  body.group.rotation.set(0, yaw, 0);
  body.hips.position.y = BODY_POSE.hipsY - crouch * 0.28 + bounce - compression + cycle.bob * 1.5;
  body.torso.position.y = BODY_POSE.torsoY - crouch * 0.34 + bounce - compression + breathing + cycle.bob * 1.5;
  body.torso.rotation.x = crouch * 0.12 + body.land * 0.08 - cycle.torsoPitch * 1.4;
  body.hips.rotation.x = -cycle.hipsPitch * 1.4;
  body.hips.rotation.z = swing * stride * 0.045 + cycle.sway * 0.03 * swim;
  body.left.leg.position.y = BODY_POSE.legY - crouch * 0.24 + cycle.bob * 1.5;
  body.right.leg.position.y = BODY_POSE.legY - crouch * 0.24 + cycle.bob * 1.5;
  body.left.leg.rotation.x = swing * 0.72 * body.forward - crouch * 0.58 - (body.air * 0.42 + body.land * 0.2) * dry -
    (cycle.legTrail + cycle.kick) * 2;
  body.right.leg.rotation.x = -swing * 0.72 * body.forward - crouch * 0.58 - (body.air * 0.28 + body.land * 0.2) * dry -
    (cycle.legTrail - cycle.kick) * 2;
  body.left.leg.rotation.z = swing * 0.42 * body.lateral;
  body.right.leg.rotation.z = -swing * 0.42 * body.lateral;
  body.left.knee.rotation.x = crouch * 1.02 + Math.max(0, -swing) * 0.32 + (body.air * 0.72 + body.land * 0.36) * dry -
    (cycle.kneeFlex + Math.max(0, cycle.kick)) * 2.2;
  body.right.knee.rotation.x = crouch * 1.02 + Math.max(0, swing) * 0.32 + (body.air * 0.55 + body.land * 0.36) * dry -
    (cycle.kneeFlex + Math.max(0, -cycle.kick)) * 2.2;
  body.left.boot.rotation.x = -body.air * 0.14 * dry - Math.max(0, swing) * 0.12 + cycle.kneeFlex * 2;
  body.right.boot.rotation.x = -body.air * 0.10 * dry - Math.max(0, -swing) * 0.12 + cycle.kneeFlex * 2;
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
  body.left.leg.rotation.z *= 1 - prone;
  body.right.leg.rotation.z *= 1 - prone;
}

/** Terminal cleanup for every scene object and GPU resource created by the factory. */
export function disposeFirstPersonBody(body) {
  if (!body || body.disposed) return;
  body.disposed = true;
  body._skinLayer?.clear();
  body.group.removeFromParent();
  disposeObjectTree(body.group);
  body.group.clear();
}
