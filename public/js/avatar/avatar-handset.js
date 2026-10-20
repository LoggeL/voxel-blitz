import * as THREE from '../vendor/three.module.js';
import { poseOperatorArm } from './operator-model.js';
import { FPV_LINK, FPV_RULES } from '../../../shared/fpv-rules.js';

// Third person: an operator whose FPV drone flies holds the ground-control
// handset (docs/design/conquest/fpv-handset/, variant A) at his chest, the gun
// stowed, both hands on the grips. The pilots come from the snapshot's live
// drone rows (`own`, link live), so players and bots alike show it.

/** Group-local pose (m): the handset in front of the chest, tilted up toward the face; the grips' hand anchors. */
export const AVATAR_HANDSET = Object.freeze({ at: [0, 1.08, -0.3], crouchDrop: 0.29, tilt: -0.95, grip: 0.125 });

/** Owner ids of the live (link live) FPV drones among snapshot vehicle rows. */
export function fpvPilotIds(vehicles, out = new Set()) {
  out.clear();
  for (const row of Array.isArray(vehicles) ? vehicles : []) {
    if (row?.type !== FPV_RULES.type || !(row.hp > 0) || row.own == null) continue;
    if (Array.isArray(row.fpv) && row.fpv[1] !== FPV_LINK.live) continue;
    out.add(String(row.own));
  }
  return out;
}

let shared = null;
function sharedParts() {
  if (shared) return shared;
  shared = {
    geometry: new THREE.BoxGeometry(1, 1, 1),
    olive: new THREE.MeshStandardMaterial({ color: 0x4b5336, roughness: 0.82 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x1a1c1d, roughness: 0.95 }),
    screen: new THREE.MeshBasicMaterial({ color: 0x9fb4c4, toneMapped: false }),
  };
  return shared;
}

function buildHandset() {
  const { geometry, olive, rubber, screen } = sharedParts();
  const group = new THREE.Group();
  group.name = 'avatar-fpv-handset';
  const box = (material, size, pos) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.set(...size); mesh.position.set(...pos);
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  };
  box(olive, [0.21, 0.13, 0.03], [0, 0, 0]);
  box(screen, [0.15, 0.09, 0.004], [0, 0.004, 0.016]);
  for (const sx of [-1, 1]) {
    box(olive, [0.05, 0.12, 0.044], [sx * 0.122, -0.012, -0.004]);
    box(rubber, [0.011, 0.07, 0.011], [sx * 0.086, 0.1, -0.006]);
  }
  return group;
}

const _anchor = new THREE.Vector3();
/**
 * After the weapon pose: show or hide the handset on `av`; while shown the
 * gun hides and both arms reach the grips. Cheap: a few boxes per avatar,
 * built on the first flight.
 */
export function poseAvatarHandset(av, piloting) {
  if (!piloting) { if (av.fpvHandset) av.fpvHandset.visible = false; return false; }
  if (!av.fpvHandset) { av.fpvHandset = buildHandset(); av.group.add(av.fpvHandset); }
  const h = AVATAR_HANDSET, set = av.fpvHandset, drop = (av.crouchPose || 0) * h.crouchDrop * (1 - (av.pronePose || 0));
  set.visible = true;
  set.position.set(h.at[0], h.at[1] - drop, h.at[2]);
  set.rotation.set(h.tilt, 0, 0);
  if (av.weaponModel?.root) av.weaponModel.root.visible = false;
  const model = av.weaponModel?.modelRoot;
  if (!model) return true;
  av.group.updateMatrixWorld(true);
  for (const side of [1, -1]) {
    // poseOperatorArm reads anchors in the weapon model's frame: carry the grip there.
    _anchor.set(side * h.grip, -0.03, -0.01);
    set.localToWorld(_anchor);
    model.worldToLocal(_anchor);
    poseOperatorArm(av, side, _anchor);
  }
  return true;
}
