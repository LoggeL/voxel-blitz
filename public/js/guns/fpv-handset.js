import * as THREE from '../vendor/three.module.js';
import { createBlenderParts } from '../engine/blender-assets.js';
import { disposeObjectTree } from '../engine/dispose.js';
import { ViewmodelArms } from './viewmodel-arms.js';

// The Engineer's FPV ground-control handset in first person (design
// docs/design/conquest/fpv-handset/, variant A): a rugged olive box with
// rubber corner bumpers, a screen in the middle, a stick and a red toggle on
// the side grips and two stubby antennas. Both gloves hold it by the grips and
// carry the two-bone arms back to the shoulders (viewmodel-arms.js), like the
// medkit hands. Driven by FpvTransition (public/js/session/fpv-transition.js):
// `level` 0 is lowered out of view, 1 the screen held up to the eye.

/** Camera-local poses (m, rad) at level 0 (lowered) and 1 (screen in front of the eye). */
export const HANDSET_POSE = Object.freeze({
  lowered: Object.freeze({ at: [0.04, -0.36, -0.3], pitch: -1.05, roll: 0.22 }),
  raised: Object.freeze({ at: [0, -0.014, -0.15], pitch: 0.04, roll: 0 }),
  /** Grip hand anchors in handset space (right side; the left mirrors x). */
  hand: Object.freeze({ at: [0.15, -0.035, -0.012], fingers: [-0.45, 0.8, -0.4], back: [0.85, 0.2, 0.5] }),
  pole: Object.freeze([0.7, -1, 0.15]),
});
const SCREEN_W = 128, SCREEN_H = 80;
const BLENDER_HAND_PALETTE = Object.freeze({ 'glove leather': 0x22252a, 'ceramic armor': 0x15171a, webbing: 0xb09a72 });

const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _basis = new THREE.Matrix4();
function orient(group, fingers, back) {
  _z.fromArray(fingers).normalize().negate();
  _y.fromArray(back);
  _y.addScaledVector(_z, -_y.dot(_z)).normalize();
  _x.crossVectors(_y, _z);
  group.quaternion.setFromRotationMatrix(_basis.makeBasis(_x, _y, _z));
}
const lerp = (a, b, t) => a + (b - a) * t;

export class FpvHandset {
  constructor(parent) {
    this.root = new THREE.Group();
    this.root.name = 'fpv-handset';
    this.root.visible = false;
    parent.add(this.root);
    this.level = 0;
    this._time = 0;
    this._seed = 0x9e37;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const olive = new THREE.MeshStandardMaterial({ color: 0x4b5336, roughness: 0.82 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x1a1c1d, roughness: 0.95 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x2c3033, roughness: 0.6, metalness: 0.3 });
    const red = new THREE.MeshStandardMaterial({ color: 0xc0261c, roughness: 0.5, emissive: 0x3a0705 });
    const glove = new THREE.MeshStandardMaterial({ color: 0x202831, roughness: 0.88 });
    const armor = new THREE.MeshStandardMaterial({ color: 0x667582, roughness: 0.72 });
    this._materials = [olive, rubber, metal, red, glove, armor];
    const box = (into, material, size, pos, name = '') => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.scale.set(...size); mesh.position.set(...pos);
      if (name) mesh.name = name;
      into.add(mesh);
      return mesh;
    };
    // The handset's own frame: +z faces the eye, the screen on that face.
    const set = this.set = new THREE.Group();
    set.rotation.order = 'YXZ';
    this.root.add(set);
    box(set, olive, [0.21, 0.13, 0.03], [0, 0, 0], 'fpv-handset-body');
    box(set, rubber, [0.168, 0.106, 0.004], [0, 0.004, 0.016]);                 // screen bezel
    for (const sx of [-1, 1]) {
      box(set, olive, [0.05, 0.12, 0.044], [sx * 0.122, -0.012, -0.004]);       // side grip
      box(set, rubber, [0.052, 0.05, 0.046], [sx * 0.122, -0.05, -0.004]);      // rubber grip pad
      box(set, metal, [0.022, 0.022, 0.012], [sx * 0.118, 0.022, 0.024]);       // stick housing
      box(set, rubber, [0.012, 0.012, 0.016], [sx * 0.118, 0.022, 0.034]);      // thumb stick
      for (const sy of [-1, 1]) box(set, rubber, [0.03, 0.028, 0.036], [sx * 0.1, sy * 0.058, 0]); // corner bumpers
      const mast = new THREE.Group();
      mast.position.set(sx * 0.086, 0.066, -0.006);
      mast.rotation.z = -sx * 0.12;
      box(mast, rubber, [0.016, 0.014, 0.016], [0, 0.006, 0]);
      box(mast, rubber, [0.011, 0.07, 0.011], [0, 0.046, 0]);                   // stubby antenna
      set.add(mast);
    }
    box(set, red, [0.014, 0.012, 0.01], [0.128, -0.016, 0.026], 'fpv-handset-toggle');
    box(set, metal, [0.06, 0.008, 0.006], [0, -0.058, 0.016]);                  // button row under the screen
    // The screen: a live canvas (static, CONNECTING, SIGNAL LOST), unlit so it glows.
    const doc = globalThis.document;
    this.canvas = doc?.createElement?.('canvas') ?? null;
    if (this.canvas) { this.canvas.width = SCREEN_W; this.canvas.height = SCREEN_H; }
    this.context = this.canvas?.getContext?.('2d') ?? null;
    this.image = this.context?.createImageData?.(SCREEN_W, SCREEN_H) ?? null;
    this.texture = this.canvas ? new THREE.CanvasTexture(this.canvas) : null;
    if (this.texture) { this.texture.colorSpace = THREE.SRGBColorSpace; this.texture.minFilter = THREE.LinearFilter; }
    const screenMaterial = new THREE.MeshBasicMaterial({ color: this.texture ? 0xffffff : 0x8a9096, map: this.texture, toneMapped: false });
    this._materials.push(screenMaterial);
    this.screen = new THREE.Mesh(new THREE.PlaneGeometry(0.152, 0.092), screenMaterial);
    this.screen.name = 'fpv-handset-screen';
    this.screen.position.set(0, 0.004, 0.0185);
    set.add(this.screen);

    // Gloves on the grips: named like the gun gloves so the arm rig finds its wrist anchors.
    this.hands = [-1, 1].map(side => {
      const hand = new THREE.Group();
      hand.name = side < 0 ? 'hand_l' : 'hand_r';
      hand.userData.side = side;
      hand.userData.blender = null;
      const pose = HANDSET_POSE.hand;
      hand.position.set(side * pose.at[0], pose.at[1], pose.at[2]);
      orient(hand, [side * pose.fingers[0], pose.fingers[1], pose.fingers[2]], [side * pose.back[0], pose.back[1], pose.back[2]]);
      hand.userData.procedural = [
        box(hand, glove, [0.09, 0.05, 0.11], [0, 0, 0]),
        box(hand, armor, [0.08, 0.014, 0.06], [0, 0.03, 0.01]),
        box(hand, glove, [0.085, 0.035, 0.05], [0, -0.012, -0.07]),
      ];
      set.add(hand);
      return hand;
    });
    this._blenderReady = false;
    this.arms = new ViewmodelArms(parent);
    this.arms.root.name = 'fpv-handset-arms';
    this.arms.pole = HANDSET_POSE.pole;
    this._armModel = { root: this.root };
  }

  /** The Blender grip gloves (the gun hands) once their asset has loaded. */
  _ensureBlenderHands() {
    if (this._blenderReady) return;
    let ready = true;
    for (const hand of this.hands) {
      if (hand.userData.blender) continue;
      const node = createBlenderParts('hands', { names: ['grip'] })?.grip;
      if (!node) { ready = false; continue; }
      for (const mesh of node.children) {
        for (const material of [].concat(mesh.material)) {
          const key = BLENDER_HAND_PALETTE[material.userData.partMaterial];
          if (key !== undefined) material.userData.paletteColor = key;
        }
      }
      const inner = new THREE.Group();
      inner.name = 'fpv-handset-blender-hand';
      inner.userData.blenderAsset = 'hands';
      if (hand.userData.side < 0) inner.scale.x = -1;
      inner.add(...node.children);
      hand.add(inner);
      hand.userData.blender = inner;
      for (const mesh of hand.userData.procedural) mesh.visible = false;
    }
    this._blenderReady = ready;
  }

  setCosmetics(loadout) { this.arms.setCosmetics(loadout); }

  /**
   * One frame: `level` 0..1 (FpvTransition frame.handset), `screen` 'static'
   * | 'lost', `pitch` the camera pitch (the shoulders follow it). Returns the
   * shown level (0 while hidden).
   */
  update(dt, { level = 0, screen = 'static', reducedMotion = false } = {}, pitch = 0) {
    const shown = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
    this.level = shown;
    this.root.visible = shown > 0.001;
    if (!this.root.visible) { this.arms.update(this._armModel, pitch, false); return 0; }
    this._ensureBlenderHands();
    this._time += Math.max(0, Math.min(0.25, dt));
    const lo = HANDSET_POSE.lowered, hi = HANDSET_POSE.raised;
    // The last stretch of the raise pulls the screen in toward the eye.
    const reach = shown * shown;
    this.set.position.set(lerp(lo.at[0], hi.at[0], shown), lerp(lo.at[1], hi.at[1], shown), lerp(lo.at[2], hi.at[2], reach));
    const sway = reducedMotion ? 0 : Math.sin(this._time * 2.3) * 0.004 * shown;
    this.set.position.y += sway;
    this.set.rotation.set(lerp(lo.pitch, hi.pitch, shown), 0, lerp(lo.roll, hi.roll, shown));
    this.arms.update(this._armModel, pitch, true);
    this._paintScreen(screen);
    return shown;
  }

  /** Grey snow with a rolling bar, and the frame's caption: CONNECTING while raising, SIGNAL LOST on the way down. */
  _paintScreen(screen) {
    if (!this.context || !this.image) return;
    const data = this.image.data, roll = Math.floor(this._time * 60) % SCREEN_H;
    let seed = (this._seed = (this._seed * 1664525 + 1013904223) >>> 0);
    for (let y = 0, i = 0; y < SCREEN_H; y++) {
      const bar = (y - roll + SCREEN_H) % SCREEN_H < 8 ? 40 : 0;
      for (let x = 0; x < SCREEN_W; x++, i += 4) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const v = 40 + (seed >>> 25) + bar;
        data[i] = v; data[i + 1] = v + 4; data[i + 2] = v + 8; data[i + 3] = 255;
      }
    }
    const c = this.context;
    c.putImageData(this.image, 0, 0);
    const lost = screen === 'lost';
    c.fillStyle = 'rgba(13, 22, 36, 0.86)';
    c.fillRect(20, 30, 88, 20);
    c.fillStyle = lost ? '#e0473a' : '#4aa3ff';
    c.fillRect(20, 30, 3, 20);
    c.fillStyle = '#f2f4f6';
    c.font = 'bold 11px sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(lost ? 'SIGNAL LOST' : 'CONNECTING', 66, 40.5);
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.arms.dispose();
    this.texture?.dispose();
    this.root.removeFromParent();
    disposeObjectTree(this.root);
    this.root.clear();
  }
}
