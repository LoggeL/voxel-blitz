import * as THREE from '../vendor/three.module.js';
import { createBlenderParts } from '../engine/blender-assets.js';
import { disposeObjectTree } from '../engine/dispose.js';
import { SkinLayer } from '../cosmetics/skin-layer.js';
import { normalizeCosmeticLoadout } from '../../../shared/career.js';
import { palette as salvagerPalette } from '../cosmetics/skins/salvager.js';
import { palette as revenantPalette } from '../cosmetics/skins/revenant.js';
import { ViewmodelArms } from './viewmodel-arms.js';
import { buildChargeModel, chargeLedOn, disposeChargeModel } from '../fx/charge-model.js';

// First-person hands of the hold-to-use interactions (design
// docs/design/interact-anims/): the gun is stowed and both gloves work the
// kind's prop for the hold, driven by an InteractAnim frame
// (public/js/session/interact-anim.js). plant: the charge goes down and the
// right finger keys it in; defuse: the left hand steadies the charge, red
// pliers cut its cables; revive: stacked palms pump compressions with a green
// pulse; repair: a wrench turns on the hull with sparks; hack (ready, no
// interaction uses it yet): a rugged tablet, typed on. Both gloves are the
// Blender HANDS poses with two-bone arms to the shoulders (viewmodel-arms.js),
// like the medkit and FPV handset hands.

const BLENDER_HAND_PALETTE = Object.freeze({ 'glove leather': 0x22252a, 'ceramic armor': 0x15171a, webbing: 0xb09a72 });
const CHARACTER_GLOVES = Object.freeze({ salvager: salvagerPalette, revenant: revenantPalette });

/**
 * Per kind: `stage` the prop frame in camera space (at, pitch: +x tilts the
 * top toward the eye), the hands in stage space (pose grip | support, at,
 * fingers and back-of-hand directions) and the elbow hint.
 */
export const INTERACT_POSES = Object.freeze({
  plant: Object.freeze({
    stage: Object.freeze({ at: [0.02, -0.2, -0.45], pitch: 0.8 }),
    left: Object.freeze({ pose: 'support', at: [-0.12, 0.1, 0.01], fingers: [0.55, -0.35, -0.75], back: [-0.25, 1, 0.1] }),
    right: Object.freeze({ pose: 'support', at: [0.07, 0.15, 0.06], fingers: [-0.35, -0.55, -0.75], back: [0.2, 0.9, -0.35] }),
    pole: Object.freeze([0.6, -1, 0.1]),
  }),
  defuse: Object.freeze({
    stage: Object.freeze({ at: [0.0, -0.2, -0.45], pitch: 0.8 }),
    left: Object.freeze({ pose: 'support', at: [-0.13, 0.1, 0.0], fingers: [0.55, -0.35, -0.75], back: [-0.25, 1, 0.1] }),
    right: Object.freeze({ pose: 'grip', at: [0.04, 0.16, 0.06], fingers: [-0.45, -0.55, -0.7], back: [0.3, 0.8, -0.45] }),
    pole: Object.freeze([0.7, -1, 0.2]),
  }),
  revive: Object.freeze({
    stage: Object.freeze({ at: [-0.04, -0.17, -0.44], pitch: 1.0 }),
    left: Object.freeze({ pose: 'support', at: [-0.05, 0.12, 0.02], fingers: [0.8, -0.15, -0.55], back: [-0.1, 1, 0.15] }),
    right: Object.freeze({ pose: 'support', at: [0.03, 0.07, 0.0], fingers: [-0.7, -0.25, -0.65], back: [0.1, 1, 0.1] }),
    pole: Object.freeze([0.9, -0.7, 0.3]),
  }),
  repair: Object.freeze({
    stage: Object.freeze({ at: [0.02, -0.12, -0.42], pitch: 0.12 }),
    left: Object.freeze({ pose: 'support', at: [-0.17, 0.03, 0.04], fingers: [0.15, 0.85, -0.5], back: [0.1, 0.25, 1] }),
    right: Object.freeze({ pose: 'grip', at: [0.17, 0.0, 0.03], fingers: [0, 0, -1], back: [0, 1, 0] }),
    pole: Object.freeze([0.7, -1, 0.25]),
  }),
  hack: Object.freeze({
    stage: Object.freeze({ at: [-0.03, -0.12, -0.38], pitch: -0.45 }),
    left: Object.freeze({ pose: 'grip', at: [-0.135, -0.01, -0.01], fingers: [0.3, 0.2, -0.9], back: [-0.9, 0.2, 0.3] }),
    right: Object.freeze({ pose: 'support', at: [0.06, -0.02, 0.07], fingers: [-0.2, 0.55, -0.8], back: [0.1, 0.4, 1] }),
    pole: Object.freeze([0.8, -1, 0.1]),
  }),
});

/** Loop rates (Hz) and the sparks pool. */
export const INTERACT_HANDS = Object.freeze({ tapHz: 3.4, snipHz: 1.25, compressHz: 1.8, wrenchHz: 1.1, typeHz: 5, sparks: 14 });

const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _basis = new THREE.Matrix4();
function orient(group, fingers, back) {
  _z.fromArray(fingers).normalize().negate();
  _y.fromArray(back);
  _y.addScaledVector(_z, -_y.dot(_z)).normalize();
  _x.crossVectors(_y, _z);
  group.quaternion.setFromRotationMatrix(_basis.makeBasis(_x, _y, _z));
}
const clamp01 = v => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
const pulse = t => Math.max(0, Math.sin(t * Math.PI * 2));

const SCREEN_W = 128, SCREEN_H = 80;

export class InteractHands {
  constructor(parent) {
    this.root = new THREE.Group();
    this.root.name = 'interact-hands';
    this.root.visible = false;
    parent.add(this.root);
    this.kind = null;
    this.level = 0;
    this._cosmetics = null;
    this._gloveId = null;
    this._skinLayer = null;
    this._seed = 0x51ed;
    const geometry = this._geometry = new THREE.BoxGeometry(1, 1, 1);
    const glove = new THREE.MeshStandardMaterial({ color: 0x202831, roughness: 0.88 });
    const armor = new THREE.MeshStandardMaterial({ color: 0x667582, roughness: 0.72 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.35, metalness: 0.6 });
    const red = new THREE.MeshStandardMaterial({ color: 0xb8261c, roughness: 0.55 });
    const olive = new THREE.MeshStandardMaterial({ color: 0x4b5336, roughness: 0.82 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x1a1c1d, roughness: 0.95 });
    const spark = new THREE.MeshBasicMaterial({ color: 0xffb347, toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const glow = new THREE.MeshBasicMaterial({ color: 0x5dff8a, toneMapped: false, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this._materials = [glove, armor, steel, red, olive, rubber, spark, glow];
    const box = (into, material, size, pos, name = '') => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.scale.set(...size); mesh.position.set(...pos);
      if (name) mesh.name = name;
      into.add(mesh);
      return mesh;
    };
    this.stage = new THREE.Group();
    this.stage.name = 'interact-stage';
    this.root.add(this.stage);

    // plant / defuse: the charge on the floor in front.
    this.charge = buildChargeModel({ name: 'interact-charge' });
    this.stage.add(this.charge.root);
    this._wireH = this.charge.wires[0]?.scale.y ?? 0.06;
    // revive: a green pulse under the palms (house style: no wound, no body detail).
    this.pulse = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), glow);
    this.pulse.name = 'interact-pulse';
    this.pulse.rotation.x = -Math.PI / 2;
    this.pulse.position.set(0, 0.035, 0);
    this.stage.add(this.pulse);
    // repair: a steel plate under the wrench, so the bolt reads against any hull.
    this.panel = new THREE.Group();
    this.panel.name = 'interact-bolt';
    box(this.panel, steel, [0.1, 0.1, 0.01], [0, 0, 0]);
    box(this.panel, olive, [0.03, 0.03, 0.024], [0, 0, 0.014]);
    this.panel.position.set(0.02, 0.01, 0);
    this.stage.add(this.panel);
    // hack: the rugged tablet with a live screen.
    this.tablet = new THREE.Group();
    this.tablet.name = 'interact-tablet';
    box(this.tablet, olive, [0.24, 0.16, 0.022], [0, 0, 0]);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) box(this.tablet, rubber, [0.03, 0.03, 0.03], [sx * 0.112, sy * 0.072, 0]);
    const doc = globalThis.document;
    this.canvas = doc?.createElement?.('canvas') ?? null;
    if (this.canvas) { this.canvas.width = SCREEN_W; this.canvas.height = SCREEN_H; }
    this.context = this.canvas?.getContext?.('2d') ?? null;
    this.texture = this.canvas ? new THREE.CanvasTexture(this.canvas) : null;
    if (this.texture) { this.texture.colorSpace = THREE.SRGBColorSpace; this.texture.minFilter = THREE.LinearFilter; }
    const screenMaterial = new THREE.MeshBasicMaterial({ color: this.texture ? 0xffffff : 0x2a6f66, map: this.texture, toneMapped: false });
    this._materials.push(screenMaterial);
    this.screen = new THREE.Mesh(new THREE.PlaneGeometry(0.19, 0.118), screenMaterial);
    this.screen.name = 'interact-tablet-screen';
    this.screen.position.set(0, 0, 0.0115);
    this.tablet.add(this.screen);
    this.stage.add(this.tablet);
    // Sparks (repair): a small pool of additive cubes in stage space.
    this.sparks = Array.from({ length: INTERACT_HANDS.sparks }, (_, i) => {
      const mesh = box(this.stage, spark, [0.008, 0.008, 0.008], [0, 0, 0], `interact-spark-${i}`);
      mesh.visible = false;
      mesh.userData.v = new THREE.Vector3(); mesh.userData.life = 0;
      return mesh;
    });
    this._sparkAcc = 0;

    // Gloves: named like the gun gloves so the arm rig finds its wrist anchors.
    this.hands = [-1, 1].map(side => {
      const hand = new THREE.Group();
      hand.name = side < 0 ? 'hand_l' : 'hand_r';
      hand.userData.side = side;
      hand.userData.poses = {};
      hand.userData.procedural = [
        box(hand, glove, [0.09, 0.05, 0.11], [0, 0, 0]),
        box(hand, armor, [0.08, 0.014, 0.06], [0, 0.03, 0.01]),
        box(hand, glove, [0.085, 0.035, 0.05], [0, -0.012, -0.07]),
      ];
      this.stage.add(hand);
      return hand;
    });
    [this.left, this.right] = this.hands;
    // Tools in the right fist, across its grip channel (glove x), like the medkit roll.
    this.pliers = new THREE.Group();
    this.pliers.name = 'interact-pliers';
    box(this.pliers, red, [0.1, 0.018, 0.022], [0.0, -0.012, -0.028]);
    this.jawA = box(this.pliers, steel, [0.06, 0.01, 0.012], [-0.075, -0.004, -0.028]);
    this.jawB = box(this.pliers, steel, [0.06, 0.01, 0.012], [-0.075, -0.02, -0.028]);
    this.right.add(this.pliers);
    // The wrench pivots on the bolt (its head at the origin, the handle out along +x); the right fist rides the handle.
    this.wrench = new THREE.Group();
    this.wrench.name = 'interact-wrench';
    box(this.wrench, steel, [0.2, 0.02, 0.026], [0.1, 0, 0.03]);
    box(this.wrench, steel, [0.05, 0.05, 0.03], [0, 0, 0.03]);
    this.panel.add(this.wrench);
    this.arms = new ViewmodelArms(parent);
    this.arms.root.name = 'interact-arms';
    this._armModel = { root: this.root };
  }

  /** Mount both Blender glove poses on each hand (shown per kind) once loaded. */
  _ensureBlenderHands() {
    if (this._blenderReady) return;
    let ready = true;
    for (const hand of this.hands) {
      for (const pose of ['grip', 'support']) {
        if (hand.userData.poses[pose]) continue;
        const node = createBlenderParts('hands', { names: [pose] })?.[pose];
        if (!node) { ready = false; continue; }
        for (const mesh of node.children) {
          for (const material of [].concat(mesh.material)) {
            const key = BLENDER_HAND_PALETTE[material.userData.partMaterial];
            if (key !== undefined) material.userData.paletteColor = key;
          }
        }
        const inner = new THREE.Group();
        inner.name = `interact-blender-hand-${pose}`;
        inner.userData.blenderAsset = 'hands';
        inner.userData.handPose = pose;
        if (hand.userData.side < 0) inner.scale.x = -1;
        inner.add(...node.children);
        hand.add(inner);
        hand.userData.poses[pose] = inner;
      }
      if (hand.userData.poses.grip && hand.userData.poses.support) for (const mesh of hand.userData.procedural) mesh.visible = false;
    }
    this._blenderReady = ready;
    if (ready && this._cosmetics) this._retint();
  }

  _retint() {
    this._skinLayer?.clear();
    this._skinLayer = null;
    const palette = this._gloveId ? CHARACTER_GLOVES[this._gloveId] : null;
    if (!palette) return;
    this._skinLayer = new SkinLayer();
    this._skinLayer.tint(this.root, { [0x22252a]: palette.glove, [0x15171a]: palette.armor, [0xb09a72]: palette.cuff }, { includeHands: true });
  }

  setCosmetics(loadout) {
    this.arms.setCosmetics(loadout);
    this._cosmetics = loadout;
    const id = normalizeCosmeticLoadout(loadout).characterSkin;
    if (id === this._gloveId) return;
    this._gloveId = id;
    this._retint();
  }

  /** Show the kind's props and glove poses. */
  _setKind(kind) {
    if (kind === this.kind) return;
    this.kind = kind;
    const P = INTERACT_POSES[kind];
    this.charge.root.visible = kind === 'plant' || kind === 'defuse';
    this.pulse.visible = kind === 'revive';
    this.panel.visible = kind === 'repair';
    this.tablet.visible = kind === 'hack';
    this.pliers.visible = kind === 'defuse';
    this.wrench.visible = kind === 'repair';
    for (const wire of this.charge.wires) wire.scale.y = this._wireH;
    for (const s of this.sparks) { s.visible = false; s.userData.life = 0; }
    if (!P) return;
    this.arms.pole = P.pole;
    this.stage.position.fromArray(P.stage.at);
    this.stage.rotation.set(P.stage.pitch, 0, 0);
  }

  _placeHand(hand, spec) {
    hand.position.fromArray(spec.at);
    orient(hand, spec.fingers, spec.back);
    const poses = hand.userData.poses;
    if (poses.grip) poses.grip.visible = spec.pose === 'grip';
    if (poses.support) poses.support.visible = spec.pose === 'support';
  }

  /**
   * One frame from an InteractAnim frame ({kind, level, workS, progress,
   * finish, done, phase}); `pitch` the camera pitch (the shoulders follow it).
   * Returns the shown level (0 while hidden).
   */
  update(dt, frame = null, pitch = 0, { reducedMotion = false, nowMs = 0 } = {}) {
    const level = clamp01(frame?.level);
    const kind = frame?.kind && INTERACT_POSES[frame.kind] ? frame.kind : this.kind;
    this.level = level;
    this.root.visible = level > 0.001 && !!kind;
    if (!this.root.visible) { this.arms.update(this._armModel, pitch, false); return 0; }
    this._ensureBlenderHands();
    this._setKind(kind);
    const P = INTERACT_POSES[kind];
    const seconds = Math.max(0, Math.min(0.1, dt));
    const t = frame.workS || 0, progress = clamp01(frame.progress), finish = clamp01(frame.finish), done = !!frame.done;
    const motion = reducedMotion ? 0.35 : 1;
    // In from below, out the same way.
    this.root.position.set(0, -(1 - level) * 0.45, (1 - level) * 0.08);
    this._placeHand(this.left, P.left);
    this._placeHand(this.right, P.right);
    this.stage.position.fromArray(P.stage.at);
    this.stage.rotation.set(P.stage.pitch, 0, 0);
    if (kind === 'plant') this._plant(t, progress, finish, done, motion, nowMs);
    else if (kind === 'defuse') this._defuse(t, progress, finish, done, motion, nowMs);
    else if (kind === 'revive') this._revive(t, finish, done, motion);
    else if (kind === 'repair') this._repair(t, seconds, finish, motion);
    else if (kind === 'hack') this._hack(t, progress, finish, done, motion);
    if (kind !== 'repair') for (const s of this.sparks) s.visible = false;
    this.arms.update(this._armModel, pitch, true, seconds);
    return level;
  }

  _plant(t, progress, finish, done, motion, nowMs) {
    // The first fifth sets the charge down; then the right finger keys it in. Done: armed, the hands lift off.
    const placed = clamp01(progress / 0.2);
    const lift = (1 - placed) * 0.09 + (done ? Math.min(1, finish * 1.6) * 0.09 : 0);
    this.charge.root.position.set(0, (1 - placed) * 0.09, 0);
    this.left.position.y += lift;
    const tap = placed < 1 || done ? 0 : Math.pow(pulse(t * INTERACT_HANDS.tapHz), 6) * 0.022 * motion;
    const key = Math.floor(t * INTERACT_HANDS.tapHz) % 3;
    this.right.position.x += (key - 1) * 0.018;
    this.right.position.y += lift - tap;
    // Armed: solid for the first part of the beat, then the fuse blink.
    this.charge.setLed(done ? finish < 0.6 || chargeLedOn(nowMs, 2500) : tap > 0.012, done ? 1 : 0.5);
  }

  _defuse(t, progress, finish, done, motion, nowMs) {
    // The pliers work the three cables in turn; each third of the hold cuts one. Done: the LED goes dark.
    const cut = done ? 3 : Math.min(2, Math.floor(progress * 3));
    // A cut cable keeps only its stubs.
    this.charge.wires.forEach((wire, i) => { wire.scale.y = i < cut ? this._wireH * 0.3 : this._wireH; });
    const target = this.charge.wires[Math.min(2, cut)];
    if (target && !done) this.right.position.x = INTERACT_POSES.defuse.right.at[0] + target.position.x * 0.9;
    const snip = done ? 0 : Math.pow(pulse(t * INTERACT_HANDS.snipHz), 4) * motion;
    this.jawA.rotation.z = -0.32 * (1 - snip);
    this.jawB.rotation.z = 0.32 * (1 - snip);
    this.right.position.y += (done ? finish * 0.06 : 0) + Math.sin(t * 7) * 0.003 * motion;
    this.left.position.y += done ? finish * 0.04 : 0;
    this.charge.setLed(!done && chargeLedOn(nowMs, null), 1);
  }

  _revive(t, finish, done, motion) {
    // Compressions: both palms pump down 4.5 cm at 1.8 Hz; each one sends a soft green pulse. Done: one bright pulse, the hands lift.
    const phase = t * INTERACT_HANDS.compressHz;
    const press = done ? 0 : Math.pow(pulse(phase), 2) * 0.045 * motion;
    const lift = done ? finish * 0.08 : 0;
    this.left.position.y += lift - press;
    this.right.position.y += lift - press;
    const beat = done ? Math.sin(Math.PI * Math.min(1, finish * 1.6)) : press / 0.045 * 0.45;
    this.pulse.material.opacity = clamp01(beat);
    this.pulse.scale.setScalar(0.7 + (done ? finish * 1.4 : beat * 0.4));
  }

  _repair(t, dt, finish, motion) {
    // The wrench swings 50 degrees about the bolt; a spray of sparks leaves the bolt on each pull. Done: no sparks.
    const swing = (Math.sin(t * Math.PI * 2 * INTERACT_HANDS.wrenchHz) * 0.45 - 0.2) * motion;
    const bolt = this.panel.position, reach = INTERACT_POSES.repair.right.at[0] - bolt.x;
    this.wrench.rotation.z = swing;
    this.right.position.set(bolt.x + Math.cos(swing) * reach, bolt.y + Math.sin(swing) * reach, bolt.z + INTERACT_POSES.repair.right.at[2]);
    orient(this.right, [0, 0, -1], [-Math.sin(swing), Math.cos(swing), 0]);
    // A trickle while the wrench bites, a burst on each pull; none in the finishing beat.
    const pulling = Math.cos(t * Math.PI * 2 * INTERACT_HANDS.wrenchHz) > 0.2;
    if (finish === 0) this._sparkAcc += dt * (pulling ? 60 : 14) * (0.5 + 0.5 * motion);
    for (const s of this.sparks) {
      const d = s.userData;
      if (d.life <= 0 && this._sparkAcc >= 1) {
        this._sparkAcc -= 1;
        d.life = 0.22 + this._rand() * 0.2;
        s.position.set(bolt.x, bolt.y, bolt.z + 0.02);
        d.v.set((this._rand() - 0.5) * 1.4, this._rand() * 0.9, 0.3 + this._rand() * 0.6);
      }
      if (d.life > 0) {
        d.life -= dt;
        d.v.y -= 4.5 * dt;
        s.position.addScaledVector(d.v, dt);
        s.visible = d.life > 0;
        s.scale.setScalar(0.005 + d.life * 0.018);
      } else s.visible = false;
    }
    this._sparkAcc = Math.min(this._sparkAcc, 3);
  }

  _hack(t, progress, finish, done, motion) {
    // The right fingertip taps over the screen; the screen scrolls code under a progress bar. Done: ACCESS OK.
    const beat = Math.floor(t * INTERACT_HANDS.typeHz);
    const jx = ((beat * 37) % 7 - 3) * 0.012, jy = ((beat * 53) % 5 - 2) * 0.01;
    const tap = done ? 0 : Math.pow(pulse(t * INTERACT_HANDS.typeHz), 5) * 0.014 * motion;
    this.right.position.x += jx * motion;
    this.right.position.y += jy * motion;
    this.right.position.z -= tap;
    // Done: the finger comes off the screen so ACCESS OK reads.
    if (done) { this.right.position.x += finish * 0.06; this.right.position.y -= finish * 0.07; this.right.position.z += finish * 0.03; }
    this._paintScreen(t, progress, done);
  }

  _rand() { this._seed = (this._seed * 1664525 + 1013904223) >>> 0; return this._seed / 4294967296; }

  _paintScreen(t, progress, done) {
    const c = this.context;
    if (!c) return;
    c.fillStyle = '#0c1a1c';
    c.fillRect(0, 0, SCREEN_W, SCREEN_H);
    const scroll = Math.floor(t * 18);
    c.fillStyle = done ? '#5dff8a' : '#4fd8c4';
    for (let row = 0; row < 7; row++) {
      const n = (scroll + row) * 2654435761 >>> 0;
      const indent = (n >>> 3) % 4 * 6, width = 20 + (n >>> 8) % 70;
      c.globalAlpha = 0.35 + 0.1 * (row % 3);
      c.fillRect(6 + indent, 6 + row * 8, width, 3);
    }
    c.globalAlpha = 1;
    c.fillStyle = '#16322f';
    c.fillRect(6, 64, SCREEN_W - 12, 9);
    c.fillStyle = done ? '#5dff8a' : '#4aa3ff';
    c.fillRect(7, 65, Math.round((SCREEN_W - 14) * (done ? 1 : progress)), 7);
    if (done) {
      c.fillStyle = 'rgba(12, 26, 28, 0.85)';
      c.fillRect(24, 24, 80, 22);
      c.fillStyle = '#5dff8a';
      c.font = 'bold 12px sans-serif';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('ACCESS OK', 64, 35.5);
    }
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.arms.dispose();
    this._skinLayer?.clear();
    this._skinLayer = null;
    this.texture?.dispose();
    // The charge's parts are shared with every other charge: only its own LED goes.
    disposeChargeModel(this.charge);
    this.root.removeFromParent();
    disposeObjectTree(this.root);
    this.root.clear();
  }
}
