// Titanfall placeholder walker (docs/titanfall.md §7, WP0). A blocky voxel biped
// built from the titan def (hull boxes, seat, mount), so VehicleView, VehicleFx,
// the destruction FX and the cockpit camera work before WP5 lands the real
// models. It freezes the rig convention WP5 keeps:
//   model.animate(step, state) with titan fields inside `state`
//   { speed, visualSteer, grounded, wreck, tw, titan, mounts, phase, legYaw, yaw, events }
// and the node names legs / pelvis / torso / head / hatch / arms, plus
// `walker: true`. Torso is the mount yaw node (torso twist), the right arm the
// mount pitch node, its gun the recoil node.
import { VoxelPart } from '../voxel-model/dsl.js';
import { vehicleDef } from '../../../../shared/vehicle-defs.js';
import { TITAN_CHASSIS, TITAN_PHASE } from '../../../../shared/titan-contract.js';
import { blueprint, createKit, buildSeatAnchors, buildMounts, finishModel } from './common.js';

const finite = value => (Number.isFinite(value) ? value : 0);
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const angleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/** Presentation-only rig tuning. */
export const TITAN_PLACEHOLDER_RIG = Object.freeze({
  stride: 2.6,          // metres per half gait cycle
  swing: 0.42,          // hip swing at full walk (rad)
  knee: 0.55,           // knee bend at full walk (rad)
  bob: 0.12,            // pelvis bob (m), phase-locked to footfalls
  crouch: 0.7,          // landing crouch drop (m)
  hatch: 1.25,          // open hatch angle (rad)
  legTwist: 0.35,       // legs lag the hull yaw by at most this
  blend: 8,             // pose smoothing rate (1/s)
});

/** Hull-frame layout of one titan type, all from the def. */
function layout(type) {
  const def = vehicleDef(type);
  const boxes = def.hullBoxes;
  const mount = Object.values(def.mounts)[0];
  const [legL, , pelvis, torso, hatch, battery, head] = boxes;
  const legX = Math.abs((legL[0][0] + legL[1][0]) / 2);   // leg centre distance from the midline
  const hipY = legL[1][1];
  return {
    def, mount, legX, hipY, kneeY: hipY * 0.5,
    pelvis, torso, hatch, battery, head,
    pivot: mount.pivot, muzzle: mount.muzzle,
    stryder: TITAN_CHASSIS[type] === 'stryder',
  };
}

function buildParts(type) {
  const L = layout(type);
  const legParts = side => {
    const x = L.legX * side;
    const thigh = new VoxelPart(`${type}-thigh-${side < 0 ? 'l' : 'r'}`, { pivot: [x, L.hipY, 0] });
    thigh.box([x - 0.3, L.kneeY, -0.4], [x + 0.3, L.hipY + 0.2, 0.4], 'paint');
    thigh.box([x - 0.34, L.hipY - 0.4, -0.44], [x + 0.34, L.hipY + 0.2, 0.44], 'gunmetal');
    const shin = new VoxelPart(`${type}-shin-${side < 0 ? 'l' : 'r'}`, { pivot: [x, L.kneeY, 0] });
    shin.box([x - 0.26, 0.4, -0.3], [x + 0.26, L.kneeY + 0.2, 0.3], 'paint');
    shin.box([x - 0.3, L.kneeY - 0.3, -0.42], [x + 0.3, L.kneeY + 0.2, 0.2], 'gunmetal');
    shin.box([x - 0.42, 0, -0.8], [x + 0.42, 0.4, 0.5], 'dark');
    shin.box([x - 0.26, 0.2, -0.9], [x + 0.26, 0.4, -0.8], 'stripe');
    return { thigh, shin };
  };
  const pelvis = new VoxelPart(`${type}-pelvis`, { pivot: [0, L.pelvis[0][1], 0] });
  pelvis.box(L.pelvis[0], L.pelvis[1], 'gunmetal');
  pelvis.box([L.pelvis[0][0] + 0.2, L.pelvis[0][1] - 0.2, -0.4], [L.pelvis[1][0] - 0.2, L.pelvis[0][1], 0.4], 'dark');

  const torso = new VoxelPart(`${type}-torso`, { pivot: [0, L.torso[0][1], 0] });
  torso.box(L.torso[0], L.torso[1], 'paint');
  // Team band across the chest and a shoulder yoke.
  torso.box([L.torso[0][0], L.torso[1][1] - 0.6, L.torso[0][2] - 0.01], [L.torso[1][0], L.torso[1][1] - 0.4, L.torso[1][2]], 'stripe');
  torso.box([L.torso[0][0] - 0.2, L.torso[1][1] - 0.4, -0.6], [L.torso[1][0] + 0.2, L.torso[1][1], 0.6], 'panel');
  // Rear battery hatch (rodeo target).
  torso.box(L.battery[0], L.battery[1], 'hazard', { tag: 'battery' });
  torso.userData.priority = { battery: 80 };

  const hatch = new VoxelPart(`${type}-hatch`, { pivot: [0, L.hatch[0][1], L.hatch[0][2]] });
  hatch.box(L.hatch[0], L.hatch[1], 'panel', { tag: 'hatch' });
  hatch.box([L.hatch[0][0] + 0.2, L.hatch[1][1] - 0.6, L.hatch[0][2] - 0.01], [L.hatch[1][0] - 0.2, L.hatch[1][1] - 0.4, L.hatch[0][2] + 0.2], 'screen', { tag: 'hatch' });
  hatch.userData.priority = { hatch: 90 };

  const head = new VoxelPart(`${type}-head`, { pivot: [0, L.head[0][1], 0] });
  head.box(L.head[0], L.head[1], 'gunmetal', { tag: 'head' });
  // The optic: one emissive lens on the front face (Atlas round eye, Ogre slit, Stryder narrow visor).
  const eyeY = (L.head[0][1] + L.head[1][1]) / 2;
  const eyeHalf = TITAN_CHASSIS[type] === 'ogre' ? 0.4 : TITAN_CHASSIS[type] === 'stryder' ? 0.3 : 0.2;
  head.box([-eyeHalf, eyeY - 0.1, L.head[0][2] - 0.2], [eyeHalf, eyeY + 0.1, L.head[0][2]], 'head', { tag: 'head' });
  head.userData.priority = { head: 70 };

  const [px, py, pz] = L.pivot;
  const armR = new VoxelPart(`${type}-arm-r`, { pivot: [px, py, pz] });
  armR.box([px - 0.36, py - 0.2, pz - 0.5], [px + 0.36, py + 0.6, pz + 0.5], 'panel');
  armR.box([px - 0.26, py - 1.2, pz - 0.3], [px + 0.26, py + 0.2, pz + 0.3], 'gunmetal');
  const gun = new VoxelPart(`${type}-gun`, { pivot: [px, py, pz] });
  gun.box([px - 0.3, py - 0.4, pz - 1.2], [px + 0.3, py + 0.3, pz + 0.4], 'gunmetal', { tag: 'gun' });
  gun.box([px - 0.14, py - 0.14, pz - L.muzzle], [px + 0.14, py + 0.14, pz - 1.2], 'dark', { tag: 'gun' });
  gun.userData.priority = { gun: 60 };
  const armL = new VoxelPart(`${type}-arm-l`, { pivot: [-px, py, pz] });
  armL.box([-px - 0.36, py - 0.2, pz - 0.5], [-px + 0.36, py + 0.6, pz + 0.5], 'panel');
  armL.box([-px - 0.26, py - 2.0, pz - 0.3], [-px + 0.26, py + 0.2, pz + 0.3], 'gunmetal', { tag: 'arm' });
  armL.box([-px - 0.34, py - 2.4, pz - 0.36], [-px + 0.34, py - 2.0, pz + 0.36], 'dark', { tag: 'arm' });
  armL.userData.priority = { arm: 50 };

  return { left: legParts(-1), right: legParts(1), pelvis, torso, hatch, head, armR, gun, armL, layout: L };
}

/**
 * Blocky biped for any TITAN_TYPE_IDS type. Options: { team, material, glass, blur }.
 */
export function makeTitanPlaceholderModel(type, options = {}) {
  const parts = blueprint(type, () => buildParts(type));
  const L = parts.layout;
  const { kit } = createKit(type, options);
  const { group } = kit;
  // Legs and pelvis turn with the leg yaw; the upper body follows the hull and aim.
  const legs = kit.node(group, 'titan-legs', [0, 0, 0]);
  const leg = (side, source) => {
    const hip = kit.node(legs, `titan-hip-${side}`, source.thigh.pivot);
    kit.part(hip, source.thigh);
    const knee = kit.node(hip, `titan-knee-${side}`, source.shin.pivot);
    kit.part(knee, source.shin);
    return { hip, knee };
  };
  const left = leg('l', parts.left), right = leg('r', parts.right);
  const pelvis = kit.node(legs, 'titan-pelvis', parts.pelvis.pivot);
  kit.part(pelvis, parts.pelvis);
  const upper = kit.node(group, 'titan-upper', [0, 0, 0]);
  const torso = kit.node(upper, 'titan-torso', parts.torso.pivot);
  kit.part(torso, parts.torso);
  const hatch = kit.node(torso, 'titan-hatch', parts.hatch.pivot);
  kit.part(hatch, parts.hatch);
  const head = kit.node(torso, 'titan-head', parts.head.pivot);
  kit.part(head, parts.head);
  const armR = kit.node(torso, 'titan-arm-r', parts.armR.pivot);
  kit.part(armR, parts.armR);
  const gun = kit.node(armR, 'titan-gun', parts.gun.pivot);
  kit.part(gun, parts.gun);
  const armL = kit.node(torso, 'titan-arm-l', parts.armL.pivot);
  kit.part(armL, parts.armL);

  const seatAnchors = buildSeatAnchors(kit, type, { body: torso });
  const mounts = buildMounts(kit, type, { [L.mount.id]: { yawNode: torso, pitchNode: armR, recoilNode: gun } });
  const torsoMid = [0, (L.torso[0][1] + L.torso[1][1]) / 2, 0];
  const emitters = {
    fire: [kit.anchor(torso, 'titan-core-fire', torsoMid)],
    cookoff: [kit.anchor(torso, 'titan-cookoff', [0, torsoMid[1], L.battery[1][2]])],
    smoke: [kit.anchor(torso, 'titan-smoke', [0, L.torso[1][1], 0])],
    dust: [kit.anchor(left.knee, 'titan-foot-l', [-L.legX, 0.05, 0]), kit.anchor(right.knee, 'titan-foot-r', [L.legX, 0.05, 0])],
    exhaust: [], lights: [],
  };
  const contacts = [-1, 1].map(side => ({ x: L.legX * side, z: -0.15, radius: 0.75, stretch: 1, strength: 0.6 }));

  const rig = TITAN_PLACEHOLDER_RIG;
  const kneeSign = L.stryder ? 1 : -1;   // Stryder knees bend back
  const pose = { gait: 0, amp: 0, crouch: 0, hatch: 0, slump: 0, twist: 0 };
  const animate = (dt, state = {}) => {
    if (state.wreck) return;
    const step = Math.max(0, finite(dt)), k = 1 - Math.exp(-step * rig.blend);
    const speed = Math.abs(finite(state.speed));
    const phase = state.phase | 0;
    const doomed = Array.isArray(state.tw) && (state.tw[3] | 0) > 0;
    pose.gait = (pose.gait + step * speed / rig.stride * Math.PI) % (Math.PI * 2);
    pose.amp += (clamp(speed / 4.6, 0, 1.2) - pose.amp) * k;
    pose.crouch += ((phase === TITAN_PHASE.landed ? 1 : 0) - pose.crouch) * k;
    pose.hatch += ((phase === TITAN_PHASE.embark || phase === TITAN_PHASE.disembark || phase === TITAN_PHASE.ejected ? 1 : 0) - pose.hatch) * k;
    pose.slump += ((doomed ? 1 : 0) - pose.slump) * k;
    const twist = Number.isFinite(state.legYaw) && Number.isFinite(state.yaw)
      ? clamp(angleDelta(state.legYaw, state.yaw), -rig.legTwist, rig.legTwist) : 0;
    pose.twist += (twist - pose.twist) * k;
    const swing = Math.sin(pose.gait) * rig.swing * pose.amp;
    const lift = (s) => Math.max(0, s) * rig.knee * pose.amp;
    const crouch = Math.max(pose.crouch, pose.slump * 0.5);
    left.hip.rotation.x = swing + crouch * 0.5;
    right.hip.rotation.x = -swing + crouch * 0.5;
    left.knee.rotation.x = kneeSign * (lift(Math.sin(pose.gait + Math.PI / 2)) + crouch * 0.9);
    right.knee.rotation.x = kneeSign * (lift(-Math.sin(pose.gait + Math.PI / 2)) + crouch * 0.9);
    legs.rotation.y = pose.twist;
    const bob = Math.abs(Math.sin(pose.gait)) * rig.bob * Math.min(1, pose.amp) + crouch * rig.crouch;
    pelvis.position.y = parts.pelvis.pivot[1] - bob;
    upper.position.y = -bob;
    upper.rotation.z = pose.slump * 0.08;
    hatch.rotation.x = -pose.hatch * rig.hatch;
    armL.rotation.x = -swing * 0.5;
  };

  return finishModel(kit, {
    body: torso, mounts, seatAnchors, emitters, contacts, animate,
    turret: torso, gun: armR,
    walker: true, chassis: TITAN_CHASSIS[type],
    legs: { node: legs, left, right }, pelvis, upper, torso, head, hatch, arms: { left: armL, right: armR, gun },
    floorTop: L.pelvis[1][1],
    firstPersonHidden: [head, hatch],
  });
}
