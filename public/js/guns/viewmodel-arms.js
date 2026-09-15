import * as THREE from '../vendor/three.module.js';
import { createBlenderParts } from '../engine/blender-assets.js';
import { disposeObjectTree } from '../engine/dispose.js';
import { SkinLayer } from '../cosmetics/skin-layer.js';
import { normalizeCosmeticLoadout } from '../../../shared/career.js';
import { palette as salvagerPalette } from '../cosmetics/skins/salvager.js';
import { palette as revenantPalette } from '../cosmetics/skins/revenant.js';

// First-person arms: a two-bone chain from each glove wrist back to a shoulder
// on the player's own body, so the hands read as attached to the character
// instead of ending at a cut sleeve. Camera-local like the gun (the rig root),
// so the arms ride every bob, kick and ADS move of the weapon they hold.
//
// Joint frames follow the HANDS revision 3 contract (tools/blender/hands):
// the forearm part has its wrist joint at the origin and its elbow at +z
// FOREARM; the upper arm has its elbow at the origin and the shoulder at +z
// UPPER_ARM; the shoulder part shares the upper arm's axes. +y is the back of
// the forearm / outer side of the upper arm. The left arm is the same geometry
// mirrored in x (three.js flips frontFace for negative determinants).
export const ARM = Object.freeze({
  wristZ: 0.070,                 // glove-local z of the wrist joint the forearm mounts on
  forearm: 0.31,                 // authored wrist -> elbow length (m)
  upperArm: 0.34,                // authored elbow -> shoulder length (m)
  shoulder: Object.freeze([0.25, -0.23, 0.06]), // right shoulder from the eye, body frame (+x right, +z back)
  pitchFollow: 0.30,             // share of camera pitch the shoulders follow (the spine bends)
  forearmStretchMax: 1.25,       // the forearm, the half in view, stretches the least
  shoulderGive: 0.25,            // the torso leans into an out-of-reach hand before the arm stretches
  minBend: 0.045,                // the elbow never sits exactly on the shoulder-wrist line
});

// Same palette keys the gun gloves expose (see kit.js): character skins
// recolour exactly these hexes, so the arms match the held weapon's hands.
const BLENDER_HAND_PALETTE = Object.freeze({
  'glove leather': 0x22252a, 'ceramic armor': 0x15171a, webbing: 0xb09a72,
});
const CHARACTER_GLOVES = Object.freeze({ salvager: salvagerPalette, revenant: revenantPalette });
const SEGMENTS = Object.freeze(['forearm', 'upperarm', 'shoulder']);

const _inverse = new THREE.Matrix4();
const _handToRoot = new THREE.Matrix4();
const _wrist = new THREE.Vector3();
const _back = new THREE.Vector3();
const _shoulder = new THREE.Vector3();
const _elbow = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _up = new THREE.Vector3();

/**
 * Static analytic pose of one arm, in camera/root-local metres. Fills `out`
 * with the elbow, the shoulder the arm actually hangs from and both segment
 * lengths. Exported so the arm chain can be checked without a browser.
 */
export function solveArm(side, wrist, shoulder, out = {}) {
  const U = ARM.upperArm, F = ARM.forearm;
  const anchor = (out.shoulder ||= new THREE.Vector3()).copy(shoulder);
  _dir.subVectors(wrist, anchor);
  let distance = Math.max(1e-4, _dir.length());
  _dir.divideScalar(distance);
  // A viewmodel gun is carried further out than a real one, so a shoulder
  // pinned to the body could not reach its own gloves. The torso leans into an
  // out-of-reach hand first, and only what is left over stretches the arm.
  if (distance > U + F) {
    const give = Math.min(ARM.shoulderGive, distance - (U + F));
    anchor.addScaledVector(_dir, give);
    distance -= give;
  }
  // Elbows drop below and outside the shoulder-wrist line.
  _pole.set(side * 0.55, -1, 0.30);
  _pole.addScaledVector(_dir, -_pole.dot(_dir));
  if (_pole.lengthSq() < 1e-8) _pole.set(0, 0, 1).addScaledVector(_dir, -_dir.z);
  _pole.normalize();
  if (distance >= U + F - 1e-4) {
    _elbow.copy(wrist).addScaledVector(_dir, -F);
  } else {
    const along = (U * U - F * F + distance * distance) / (2 * distance);
    const bend = Math.sqrt(Math.max(0, U * U - along * along));
    _elbow.copy(anchor).addScaledVector(_dir, along).addScaledVector(_pole, bend);
  }
  const offset = _elbow.dot(_pole) - anchor.dot(_pole);
  if (offset < ARM.minBend) _elbow.addScaledVector(_pole, ARM.minBend - offset);
  // The forearm is the half the player looks at, so it is the half allowed the
  // least stretch; the upper arm, mostly off screen, absorbs the rest.
  const forearm = wrist.distanceTo(_elbow);
  const cap = F * ARM.forearmStretchMax;
  if (forearm > cap) _elbow.lerpVectors(wrist, _elbow, cap / forearm);
  out.elbow = (out.elbow ||= new THREE.Vector3()).copy(_elbow);
  out.forearm = wrist.distanceTo(_elbow);
  out.upperArm = anchor.distanceTo(_elbow);
  return out;
}

/** Point a segment's local +z from `from` to `to`, roll its +y toward `yRef`, stretch to fit. */
function poseSegment(group, from, to, yRef, authoredLength) {
  _z.subVectors(to, from);
  const length = _z.length();
  if (length < 1e-6) { group.visible = false; return; }
  group.visible = true;
  _z.divideScalar(length);
  _y.copy(yRef).addScaledVector(_z, -yRef.dot(_z));
  if (_y.lengthSq() < 1e-8) _y.set(0, 1, 0).addScaledVector(_z, -_z.y);
  if (_y.lengthSq() < 1e-8) _y.set(1, 0, 0).addScaledVector(_z, -_z.x);
  _y.normalize();
  _x.crossVectors(_y, _z);
  group.quaternion.setFromRotationMatrix(_basis.makeBasis(_x, _y, _z));
  group.position.copy(from);
  group.scale.z = authoredLength > 0 ? length / authoredLength : 1;
}

function procedural(name, side) {
  const inner = new THREE.Group();
  const mat = (hex, palette, options = {}) => {
    const material = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.85, metalness: 0.08, flatShading: true, ...options });
    if (palette !== undefined) material.userData.paletteColor = palette;
    return material;
  };
  const box = (material, size, position) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.position.set(...position);
    inner.add(mesh);
    return mesh;
  };
  const suit = mat(0x2b3e46);
  const leather = mat(0x22252a, BLENDER_HAND_PALETTE['glove leather']);
  const armor = mat(0xd9d6c8, BLENDER_HAND_PALETTE['ceramic armor'], { roughness: 0.4, metalness: 0.12 });
  if (name === 'forearm') {
    box(leather, [0.080, 0.050, 0.024], [0, 0, 0.0]);
    box(suit, [0.082, 0.052, ARM.forearm], [0, 0, ARM.forearm / 2]);
    box(armor, [0.050, 0.012, 0.13], [0, 0.030, 0.10]);
    box(leather, [0.094, 0.072, 0.056], [0, 0.004, ARM.forearm]);
  } else if (name === 'upperarm') {
    box(suit, [0.096, 0.090, ARM.upperArm], [0, 0, ARM.upperArm / 2]);
    box(armor, [0.062, 0.014, 0.15], [0, 0.050, 0.18]);
  } else {
    box(suit, [0.110, 0.104, 0.12], [0, 0, -0.035]);
    box(armor, [0.100, 0.020, 0.14], [0, 0.058, -0.03]);
  }
  inner.scale.x = side;
  return inner;
}

export class ViewmodelArms {
  constructor(parent) {
    this.root = new THREE.Group();
    this.root.name = 'viewmodel-arms';
    this.root.visible = false;
    parent.add(this.root);
    this._cosmetics = null;
    this._gloveId = null;
    this._skinLayer = null;
    this._blenderReady = false;
    this.arms = [-1, 1].map(side => this._buildArm(side));
  }

  _buildArm(side) {
    const suffix = side < 0 ? 'l' : 'r';
    const arm = { side, segments: {}, inner: {} };
    for (const name of SEGMENTS) {
      const group = new THREE.Group();
      group.name = `arm_${name}_${suffix}`;
      const inner = procedural(name, side);
      inner.userData.procedural = true;
      group.add(inner);
      this.root.add(group);
      arm.segments[name] = group;
      arm.inner[name] = inner;
    }
    return arm;
  }

  /** Swap the offline boxes for the Blender arm segments once the template is loaded. */
  _ensureBlenderArms() {
    if (this._blenderReady) return true;
    let ready = true;
    for (const arm of this.arms) {
      if (arm.blender) continue;
      const parts = createBlenderParts('hands', { names: SEGMENTS });
      if (!parts || SEGMENTS.some(name => !parts[name])) { ready = false; continue; }
      for (const name of SEGMENTS) {
        const node = parts[name];
        for (const mesh of node.children) {
          for (const material of [].concat(mesh.material)) {
            const key = BLENDER_HAND_PALETTE[material.userData.partMaterial];
            if (key !== undefined) material.userData.paletteColor = key;
          }
        }
        node.scale.x = arm.side;
        const previous = arm.inner[name];
        arm.segments[name].remove(previous);
        disposeObjectTree(previous);
        arm.segments[name].add(node);
        arm.inner[name] = node;
      }
      arm.blender = true;
    }
    this._blenderReady = ready;
    if (ready && this._cosmetics) this._retint();
    return ready;
  }

  _retint() {
    this._skinLayer?.clear();
    this._skinLayer = null;
    const palette = this._gloveId ? CHARACTER_GLOVES[this._gloveId] : null;
    if (!palette) return;
    this._skinLayer = new SkinLayer();
    this._skinLayer.tint(this.root,
      { [0x22252a]: palette.glove, [0x15171a]: palette.armor, [0xb09a72]: palette.cuff },
      { includeHands: true });
  }

  setCosmetics(loadout) {
    this._cosmetics = loadout;
    const id = normalizeCosmeticLoadout(loadout).characterSkin;
    if (id === this._gloveId) return;
    this._gloveId = id;
    this._retint();
  }

  /**
   * Pose both arms for the current frame. `model` is the built gun bundle
   * (its hand_l/hand_r groups are the wrist anchors), `pitch` the camera pitch
   * in radians (+up), `visible` whether the weapon content is on screen.
   * World matrices along the hand chain are refreshed here, so this runs
   * after the rig composed its transforms.
   */
  update(model, pitch = 0, visible = true) {
    this._ensureBlenderArms();
    if (!model?.root || !visible) { this.root.visible = false; return false; }
    const hands = model.root.userData.armAnchors
      ||= { l: model.root.getObjectByName('hand_l') || null, r: model.root.getObjectByName('hand_r') || null };
    this.root.updateWorldMatrix(true, false);
    _inverse.copy(this.root.matrixWorld).invert();
    const spine = -pitch * (1 - ARM.pitchFollow);
    const cos = Math.cos(spine), sin = Math.sin(spine);
    let shown = 0;
    for (const arm of this.arms) {
      const hand = arm.side < 0 ? hands.l : hands.r;
      let handVisible = !!hand;
      for (let node = hand; handVisible && node && node !== model.root.parent; node = node.parent) {
        if (!node.visible) handVisible = false;
      }
      if (!handVisible) {
        for (const name of SEGMENTS) arm.segments[name].visible = false;
        continue;
      }
      hand.updateWorldMatrix(true, false);
      _handToRoot.multiplyMatrices(_inverse, hand.matrixWorld);
      _wrist.set(0, 0, ARM.wristZ).applyMatrix4(_handToRoot);
      _back.set(0, 1, 0).transformDirection(_handToRoot);
      const [sx, sy, sz] = ARM.shoulder;
      _shoulder.set(arm.side * sx, sy * cos - sz * sin, sy * sin + sz * cos);
      const solved = solveArm(arm.side, _wrist, _shoulder, arm.solved ||= {});
      poseSegment(arm.segments.forearm, _wrist, solved.elbow, _back, ARM.forearm);
      _up.set(arm.side * 0.5, 1, 0);
      poseSegment(arm.segments.upperarm, solved.elbow, solved.shoulder, _up, ARM.upperArm);
      // The cap rides the upper arm's own frame, so the pauldron always covers
      // the joint no matter how far the arm has reached.
      const shoulder = arm.segments.shoulder;
      shoulder.visible = true;
      shoulder.position.copy(solved.shoulder);
      shoulder.quaternion.copy(arm.segments.upperarm.quaternion);
      shoulder.scale.set(1, 1, 1);
      shown++;
    }
    this.root.visible = shown > 0;
    return this.root.visible;
  }

  dispose() {
    this._skinLayer?.clear();
    this._skinLayer = null;
    this.root.removeFromParent();
    disposeObjectTree(this.root);
    this.root.clear();
    this.arms = [];
  }
}
