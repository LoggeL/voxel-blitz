// Shared plumbing for the voxel vehicle models: material defaults, seat and
// mount rig construction from shared/vehicle-defs.js, and the common return
// shape { group, body, mounts, seatAnchors, emitters, ... } VehicleView uses.
import * as THREE from '../../vendor/three.module.js';
import { ModelKit } from '../voxel-model/assemble.js';
import { createVehicleMaterial, createVehicleGlassMaterial, createRotorBlurMaterial } from '../voxel-model/material.js';
import { modelSeats, mountAnchors } from '../voxel-model/anchors.js';

/** Materials for one hull: shared program, per-hull uniforms. */
export function vehicleMaterials(options = {}) {
  return {
    material: options.material?.isMaterial ? options.material : createVehicleMaterial(),
    glass: options.glass?.isMaterial && options.glass.transparent ? options.glass : createVehicleGlassMaterial(),
    blur: options.blur?.isMaterial ? options.blur : createRotorBlurMaterial(),
  };
}

/** Lazily built, team-independent voxel parts per type. */
const blueprints = new Map();
export function blueprint(type, build) {
  let parts = blueprints.get(type);
  if (!parts) { parts = build(); blueprints.set(type, parts); }
  return parts;
}

export function createKit(type, options = {}) {
  const team = options.team === 'alpha' || options.team === 'bravo' ? options.team : 'neutral';
  const materials = vehicleMaterials(options);
  return { kit: new ModelKit(type, team, materials), materials, team };
}

/**
 * Seat anchors from the def: hull seats under `body`, turret seats under
 * `turret`. Returns { seatId: Object3D } with userData.seat set.
 */
export function buildSeatAnchors(kit, type, { body, turret = null }) {
  const anchors = {};
  for (const seat of modelSeats(type)) {
    const parent = seat.frame === 'turret' && turret ? turret : body;
    const anchor = kit.anchor(parent, `${type}-seat-${seat.id}`, seat.position);
    anchor.userData.seatId = seat.id;
    anchor.userData.seat = seat;
    anchors[seat.id] = anchor;
  }
  return anchors;
}

/**
 * Mount rigs. `nodes[mountId]` supplies { yawNode, pitchNode, recoilNode? }
 * built by the model; muzzles are placed from the def (pivot + muzzle length
 * along -Z of the pitch node, or the pod/rail sides of fixed mounts).
 */
export function buildMounts(kit, type, nodes) {
  const mounts = {};
  for (const anchor of mountAnchors(type)) {
    const rig = nodes[anchor.mountId];
    if (!rig) throw new Error(`${type} model has no rig for mount ${anchor.key}`);
    const { yawNode, pitchNode } = rig;
    const muzzles = [];
    if (anchor.sides) {
      anchor.sides.forEach((side, i) => muzzles.push(kit.anchor(pitchNode, `${type}-${anchor.mountId}-muzzle-${i}`, side)));
    } else {
      const pivot = anchor.pivot;
      const point = anchor.fixed ? pivot : [pivot[0], pivot[1], pivot[2] - anchor.muzzle];
      muzzles.push(kit.anchor(rig.recoilNode || pitchNode, `${type}-${anchor.mountId}-muzzle`, point));
    }
    mounts[anchor.key] = {
      key: anchor.key, seatId: anchor.seatId, mountId: anchor.mountId,
      yawNode, pitchNode, recoilNode: rig.recoilNode || null, muzzle: muzzles[0], muzzles,
      fixed: anchor.fixed, slavedTo: anchor.slavedTo, frame: anchor.frame, yawLimit: anchor.yawLimit,
      grips: rig.grips || null, recoil: 0,
    };
  }
  return mounts;
}

/** A light emitter anchor (headlight, tail, nav, strobe) for VehicleFx sprites. */
export function lightAnchor(kit, parent, kind, point, direction = [0, 0, -1]) {
  const node = kit.anchor(parent, `light-${kind}`, point);
  node.userData.light = kind;
  node.userData.direction = direction;
  return { node, kind, direction };
}

/** Compose the common model result. */
export function finishModel(kit, fields) {
  const stats = kit.stats();
  const model = {
    type: kit.type, team: kit.team, kit,
    group: kit.group, hull: kit.group,
    stats,
    setWreck: wreck => kit.setWreck(!!wreck),
    fragmentSources: () => kit.fragmentSources(),
    fragmentGeometry: source => kit.fragmentGeometry(source),
    animate: () => {},
    ...fields,
  };
  model.operatorSeats = model.seatAnchors;
  model.seatMounts = model.seatAnchors;
  return model;
}

/** Instance transform helper: position + Euler. */
export function instanceTransform(position, euler = null) {
  return { position, quaternion: euler ? new THREE.Quaternion().setFromEuler(new THREE.Euler(...euler, 'YXZ')) : null };
}
