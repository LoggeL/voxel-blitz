import * as THREE from '../vendor/three.module.js';
import { createBlenderParts } from '../engine/blender-assets.js';
import { disposeObjectTree } from '../engine/dispose.js';
import { SkinLayer } from '../cosmetics/skin-layer.js';
import { normalizeCosmeticLoadout } from '../../../shared/career.js';
import { palette as salvagerPalette } from '../cosmetics/skins/salvager.js';
import { palette as revenantPalette } from '../cosmetics/skins/revenant.js';
import { ViewmodelArms } from './viewmodel-arms.js';

// Same palette keys the gun gloves expose (see kit.js): character skins recolour
// exactly these hexes, so the bandaging hands match the held weapon's hands.
const BLENDER_HAND_PALETTE = Object.freeze({
  'glove leather': 0x22252a, 'ceramic armor': 0x15171a, webbing: 0xb09a72,
});
const CHARACTER_GLOVES = Object.freeze({ salvager: salvagerPalette, revenant: revenantPalette });

/** Camera-local poses: the palm origin plus finger and back-of-hand directions. */
export const MEDKIT_POSE = Object.freeze({
  // The left arm is held across the lower view, palm down, fingers to the right.
  left: Object.freeze({ at: [0.08, -0.12, -0.42], fingers: [0.82, 0.12, -0.56], back: [-0.1, 0.95, 0.3] }),
  // The right fist holds the roll and circles the left forearm.
  right: Object.freeze({ fingers: [-0.55, -0.2, -0.8], back: [0.15, 0.9, 0.4] }),
  // Elbows swing out and forward, so the raised forearm crosses the view.
  pole: Object.freeze([1, -0.35, -0.6]),
  wraps: 6,
  wrapStartZ: 0.035,             // forearm-local z of the first turn (wrist at 0)
  wrapPitch: 0.026,              // spacing between turns along the forearm
  wrapRadius: 0.05,              // just outside the Blender forearm sleeve
  wrapBack: 1.3,                 // taller over the back of the forearm to cover its bracer
  orbit: 0.115,                  // right palm distance from the forearm axis
  orbitHz: 1.5,                  // wraps per second
});

const _axisX = new THREE.Vector3();
const _axisY = new THREE.Vector3();
const _center = new THREE.Vector3();
const _inverse = new THREE.Matrix4();
const _basis = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();

/** Orient a glove group so its fingers (-z) and back (+y) follow camera-space directions. */
function orient(group, fingers, back) {
  _z.fromArray(fingers).normalize().negate();
  _y.fromArray(back);
  _y.addScaledVector(_z, -_y.dot(_z)).normalize();
  _x.crossVectors(_y, _z);
  group.quaternion.setFromRotationMatrix(_basis.makeBasis(_x, _y, _z));
}

/**
 * A field dressing wound around the left forearm. Both gloves are the Blender
 * HANDS poses and each carries a two-bone arm back to the player's shoulder
 * (viewmodel-arms.js), so bandaging uses the same hands and arms as every gun.
 */
export class MedkitHands {
  constructor(parent) {
    this.root = new THREE.Group();
    this.root.name = 'medkit-hands';
    this.root.visible = false;
    parent.add(this.root);
    this.blend = 0;
    this.time = 0;
    this.wasActive = false;
    this._blenderReady = false;
    this._cosmetics = null;
    this._gloveId = null;
    this._skinLayer = null;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const glove = new THREE.MeshStandardMaterial({ color: 0x202831, roughness: 0.88 });
    const armor = new THREE.MeshStandardMaterial({ color: 0x667582, roughness: 0.72 });
    this.dressing = new THREE.MeshStandardMaterial({ color: 0xebe5cb, roughness: 0.95, side: THREE.DoubleSide });
    // Every other turn is a shade darker, so the laid turns read one by one.
    const underlap = new THREE.MeshStandardMaterial({ color: 0xcfc6a6, roughness: 0.95, side: THREE.DoubleSide });
    this.hands = [-1, 1].map(side => {
      const hand = new THREE.Group();
      // Named like the gun gloves: the arm rig finds its wrist anchors by name.
      hand.name = side < 0 ? 'hand_l' : 'hand_r';
      hand.userData.side = side;
      hand.userData.pose = side < 0 ? 'support' : 'grip';
      hand.userData.blender = null;
      const procedural = [];
      const box = (material, size, pos) => {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.scale.set(...size);
        mesh.position.set(...pos);
        hand.add(mesh);
        procedural.push(mesh);
        return mesh;
      };
      box(glove, [0.09, 0.05, 0.11], [0, 0, 0]);
      box(armor, [0.08, 0.014, 0.06], [0, 0.03, 0.01]);
      box(glove, [0.085, 0.035, 0.05], [0, -0.012, -0.07]);
      hand.userData.procedural = procedural;
      this.root.add(hand);
      return hand;
    });
    [this.left, this.right] = this.hands;
    orient(this.left, MEDKIT_POSE.left.fingers, MEDKIT_POSE.left.back);
    this.left.position.fromArray(MEDKIT_POSE.left.at);
    orient(this.right, MEDKIT_POSE.right.fingers, MEDKIT_POSE.right.back);

    // The roll sits across the right fist's grip channel and thins as it unwinds.
    this.roll = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.062, 12), this.dressing);
    this.roll.name = 'medkit-roll';
    this.roll.rotation.z = Math.PI / 2;
    this.roll.position.set(0, -0.012, -0.028);
    this.right.add(this.roll);
    // The free strip runs from the roll to the turn being laid.
    this.strip = new THREE.Mesh(geometry, this.dressing);
    this.strip.name = 'medkit-strip';
    this.root.add(this.strip);

    // A sibling of the hands' root, not a child: the arms keep their own skin
    // layer, and they follow the hands' visibility through the anchor chain.
    this.arms = new ViewmodelArms(parent);
    this.arms.root.name = 'medkit-arms';
    this.arms.pole = MEDKIT_POSE.pole;
    this._armModel = { root: this.root };
    // The turns ride the left forearm segment, so they follow its solved pose.
    const turn = new THREE.CylinderGeometry(MEDKIT_POSE.wrapRadius, MEDKIT_POSE.wrapRadius,
      MEDKIT_POSE.wrapPitch * 1.4, 16, 1, true);
    turn.rotateX(Math.PI / 2);
    turn.scale(1, MEDKIT_POSE.wrapBack, 1);
    turn.translate(0, 0.006, 0);
    const forearm = this.arms.arms[0].segments.forearm;
    this.wraps = Array.from({ length: MEDKIT_POSE.wraps }, (_, i) => {
      const mesh = new THREE.Mesh(turn, i % 2 ? underlap : this.dressing);
      mesh.name = `medkit-wrap-${i}`;
      mesh.position.z = MEDKIT_POSE.wrapStartZ + (i + 0.5) * MEDKIT_POSE.wrapPitch;
      // A slight alternating tilt reads as a spiral instead of stacked rings.
      mesh.rotation.x = (i % 2 ? 1 : -1) * 0.08;
      mesh.visible = false;
      forearm.add(mesh);
      return mesh;
    });
  }

  /** Mount the Blender gloves (open support pose left, closed grip right) once loaded. */
  _ensureBlenderHands() {
    if (this._blenderReady) return true;
    let ready = true;
    for (const hand of this.hands) {
      if (hand.userData.blender) continue;
      const pose = hand.userData.pose;
      const node = createBlenderParts('hands', { names: [pose] })?.[pose];
      if (!node) { ready = false; continue; }
      for (const mesh of node.children) {
        for (const material of [].concat(mesh.material)) {
          const key = BLENDER_HAND_PALETTE[material.userData.partMaterial];
          if (key !== undefined) material.userData.paletteColor = key;
        }
      }
      const inner = new THREE.Group();
      inner.name = 'medkit-blender-hand';
      inner.userData.blenderAsset = 'hands';
      inner.userData.handPose = pose;
      // Mirrored for the left hand like the gun gloves (three.js flips frontFace).
      if (hand.userData.side < 0) inner.scale.x = -1;
      inner.add(...node.children);
      hand.add(inner);
      hand.userData.blender = inner;
      for (const mesh of hand.userData.procedural) mesh.visible = false;
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
    this.arms.setCosmetics(loadout);
    this._cosmetics = loadout;
    const id = normalizeCosmeticLoadout(loadout).characterSkin;
    if (id === this._gloveId) return;
    this._gloveId = id;
    this._retint();
  }

  update(dt, active, progress = 0, reducedMotion = false, pitch = 0) {
    this._ensureBlenderHands();
    const seconds = Math.max(0, Math.min(0.25, dt));
    if (active && !this.wasActive) this.time = 0;
    this.wasActive = active;
    this.time += seconds;
    this.blend += ((active ? 1 : 0) - this.blend) * (1 - Math.exp(-seconds * 20));
    this.root.visible = this.blend > 0.01;
    this.root.position.y = -(1 - this.blend) * 0.6;
    const done = Math.max(0, Math.min(1, Number(progress) || 0));
    for (let i = 0; i < this.wraps.length; i++) this.wraps[i].visible = done * this.wraps.length >= i;
    if (!this.root.visible) {
      this.arms.update(this._armModel, pitch, false);
      return this.blend;
    }
    const motion = reducedMotion ? 0.25 : 1;
    // The held arm breathes a little so the pose never reads as frozen.
    this.left.position.fromArray(MEDKIT_POSE.left.at);
    this.left.position.y += Math.sin(this.time * 2.1) * 0.004 * motion;
    // First pass solves the left forearm so the right fist can circle it.
    this.arms.update(this._armModel, pitch, true);
    const forearm = this.arms.arms[0]?.segments.forearm;
    this.root.updateWorldMatrix(true, false);
    _inverse.copy(this.root.matrixWorld).invert();
    const laid = Math.min(this.wraps.length - 1, Math.floor(done * this.wraps.length));
    const z = MEDKIT_POSE.wrapStartZ + (laid + 0.5) * MEDKIT_POSE.wrapPitch;
    if (forearm?.visible) {
      forearm.updateWorldMatrix(true, false);
      _basis.multiplyMatrices(_inverse, forearm.matrixWorld);
      // The turns are children of the stretched segment, so local z is theirs too.
      _center.set(0, 0, z).applyMatrix4(_basis);
      _axisX.set(1, 0, 0).transformDirection(_basis);
      _axisY.set(0, 1, 0).transformDirection(_basis);
    } else {
      _center.fromArray(MEDKIT_POSE.left.at).add(_axisX.set(-0.1, 0, 0.08));
      _axisX.set(1, 0, 0);
      _axisY.set(0, 1, 0);
    }
    // Over the top and around the far side; the arc under the arm is shortened
    // so the fist never swings through the forearm toward the camera.
    const phase = this.time * Math.PI * 2 * MEDKIT_POSE.orbitHz;
    const radius = MEDKIT_POSE.orbit * (0.55 + 0.45 * motion);
    const up = Math.sin(phase), side = Math.cos(phase);
    this.right.position.copy(_center)
      .addScaledVector(_axisY, radius * (up >= 0 ? up : up * 0.55))
      .addScaledVector(_axisX, radius * side * 0.8);
    orient(this.right, MEDKIT_POSE.right.fingers, MEDKIT_POSE.right.back);
    this.right.rotateZ(side * 0.3 * motion);
    this.roll.scale.set(0.55 + 0.45 * (1 - done), 1, 0.55 + 0.45 * (1 - done));
    this.arms.update(this._armModel, pitch, true);
    // The strip leaves the roll and meets the forearm surface under the fist.
    this.roll.getWorldPosition(_from).applyMatrix4(_inverse);
    _to.copy(this.right.position).sub(_center).normalize()
      .multiplyScalar(MEDKIT_POSE.wrapRadius).add(_center);
    const length = _from.distanceTo(_to);
    this.strip.visible = length > 0.005;
    this.strip.position.addVectors(_from, _to).multiplyScalar(0.5);
    this.strip.lookAt(_to.applyMatrix4(this.root.matrixWorld));
    this.strip.scale.set(0.042, 0.003, length);
    return this.blend;
  }

  dispose() {
    this.arms.dispose();
    this._skinLayer?.clear();
    this._skinLayer = null;
    this.root.removeFromParent();
    disposeObjectTree(this.root);
    this.root.clear();
  }
}
