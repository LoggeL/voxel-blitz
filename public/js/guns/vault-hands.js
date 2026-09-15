import * as THREE from '../vendor/three.module.js';
import { createBlenderParts } from '../engine/blender-assets.js';
import { disposeObjectTree } from '../engine/dispose.js';
import { SkinLayer } from '../cosmetics/skin-layer.js';
import { normalizeCosmeticLoadout } from '../../../shared/career.js';
import { palette as salvagerPalette } from '../cosmetics/skins/salvager.js';
import { palette as revenantPalette } from '../cosmetics/skins/revenant.js';

const smooth = value => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

// Same palette keys the gun gloves expose (see kit.js): character skins recolour
// exactly these hexes, so the vault push matches the held weapon's hands.
const BLENDER_HAND_PALETTE = Object.freeze({
  'glove leather': 0x22252a, 'ceramic armor': 0x15171a, webbing: 0xb09a72,
});
const CHARACTER_GLOVES = Object.freeze({ salvager: salvagerPalette, revenant: revenantPalette });

/** Camera-local reach, brace, and release. These hands never move the aiming camera. */
export class VaultHands {
  constructor(parent) {
    this.root = new THREE.Group();
    this.root.name = 'vault-hands';
    this.root.visible = false;
    parent.add(this.root);
    this.blend = 0;
    this.progress = 0;
    this._blenderReady = false;
    this._cosmetics = null;
    this._gloveId = null;
    this._skinLayer = null;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const sleeve = new THREE.MeshStandardMaterial({ color: 0x44515e, roughness: 0.95 });
    const glove = new THREE.MeshStandardMaterial({ color: 0x202831, roughness: 0.88 });
    const armor = new THREE.MeshStandardMaterial({ color: 0x667582, roughness: 0.72 });
    this.hands = [-1, 1].map(side => {
      const hand = new THREE.Group();
      hand.userData.side = side;
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
      const arm = box(sleeve, [0.13, 0.13, 0.30], [0, -0.10, 0.19]);
      arm.rotation.x = 0.5;
      box(glove, [0.12, 0.065, 0.15], [0, 0, 0]);
      box(armor, [0.105, 0.018, 0.085], [0, 0.037, 0.015]);
      for (let finger = 0; finger < 4; finger++) {
        box(glove, [0.023, 0.075, 0.038], [(finger - 1.5) * 0.029, -0.023, -0.072]);
      }
      box(glove, [0.04, 0.06, 0.075], [-side * 0.073, -0.018, 0.012]);
      hand.userData.procedural = procedural;
      this.root.add(hand);
      return hand;
    });
  }

  /** Mount the Blender support glove (open cradle) once the template is loaded. */
  _ensureBlenderHands() {
    if (this._blenderReady) return true;
    let ready = true;
    for (const hand of this.hands) {
      if (hand.userData.blender) continue;
      // The support pose is the open palm that braces a ledge; the grip pose is
      // a closed fist around a handle. Glove-local matches camera space here
      // (back +y, knuckles -z, forearm +z), so the node mounts verbatim — the
      // outer hand group carries the reach/press animation. Mirrored for the
      // left hand like the gun gloves (three.js flips frontFace for the mirror).
      const node = createBlenderParts('hands', { names: ['support'] })?.support;
      if (!node) { ready = false; continue; }
      for (const mesh of node.children) {
        for (const material of [].concat(mesh.material)) {
          const key = BLENDER_HAND_PALETTE[material.userData.partMaterial];
          if (key !== undefined) material.userData.paletteColor = key;
        }
      }
      const inner = new THREE.Group();
      inner.name = 'vault-blender-hand';
      inner.userData.blenderAsset = 'hands';
      inner.userData.handPose = 'support';
      if (hand.userData.side < 0) inner.scale.x = -1;
      inner.add(...node.children);
      hand.add(inner);
      hand.userData.blender = inner;
      for (const mesh of hand.userData.procedural) mesh.visible = false;
    }
    this._blenderReady = ready;
    // New materials arrived after the last tint; re-tint onto them.
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

  update(dt, active, progress) {
    this._ensureBlenderHands();
    const seconds = Math.max(0, Math.min(0.25, dt));
    this.blend += ((active ? 1 : 0) - this.blend) * (1 - Math.exp(-seconds * (active ? 24 : 15)));
    if (active) this.progress = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0.4;
    else this.progress = Math.min(1, this.progress + seconds * 3);
    this.root.visible = this.blend > 0.005;
    for (let i = 0; i < this.hands.length; i++) {
      const side = i === 0 ? -1 : 1;
      const t = this.progress - i * 0.035;
      const reach = smooth(t / 0.22);
      const press = smooth((t - 0.32) / 0.62);
      const hand = this.hands[i];
      hand.position.set(side * (0.27 + press * 0.055),
        -0.62 + this.blend * (0.64 * reach - 0.44 * press),
        -0.22 - this.blend * (0.37 * reach - 0.08 * press));
      hand.rotation.set(-0.18 + press * 0.38, -side * 0.08, side * (0.1 + press * 0.12));
    }
    return this.blend;
  }

  dispose() {
    this._skinLayer?.clear();
    this._skinLayer = null;
    this.root.removeFromParent();
    disposeObjectTree(this.root);
    this.root.clear();
  }
}
