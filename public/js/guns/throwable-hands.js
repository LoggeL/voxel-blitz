import * as THREE from '../vendor/three.module.js';
import { disposeObjectTree } from '../engine/dispose.js';

export const THROWABLE_TIMING = Object.freeze({ draw: 0.18, arm: 0.24, ready: 0.48, throw: 0.36, return: 0.20 });
import { GRENADE_TYPE_IDS as IDS } from '../../../shared/grenade-rules.js';
const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));
const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
const typeId = type => IDS.includes(type) ? type : IDS[Math.max(0, Math.min(IDS.length - 1, Math.trunc(Number(type) || 0)))];

/** Independent camera-local hands. The firearm can be holstered without moving the aiming camera. */
export class ThrowableHands {
  constructor(parent, onCue = null) {
    this.root = new THREE.Group();
    this.root.name = 'throwable-hands';
    this.root.visible = false;
    parent.add(this.root);
    this.onCue = onCue;
    this.blend = 0;
    this.held = false;
    this.elapsed = 0;
    this.throwElapsed = null;
    this.returnElapsed = null;
    this.type = 'frag';
    this.charge = 0;
    this._armed = false;
    this._ready = false;
    this._holdSeconds = 0;
    this._holdOffset = 0;
    this._clock = 0;
    this._disposed = false;

    const cube = new THREE.BoxGeometry(1, 1, 1);
    const mat = (color, props = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...props });
    const sleeve = mat(0x44515e);
    const glove = mat(0x202831);
    const armor = mat(0x677786, { metalness: 0.3 });
    const steel = mat(0xadb8ba, { metalness: 0.75, roughness: 0.3 });
    const dark = mat(0x253039);
    const orange = mat(0xf1a74b);
    const cyan = mat(0x58e6ff, { emissive: 0x19bada, emissiveIntensity: 1.1 });
    const mesh = (parent, geometry, material, position = [0, 0, 0], scale = null) => {
      const part = new THREE.Mesh(geometry, material);
      part.position.set(...position);
      if (scale) part.scale.set(...scale);
      parent.add(part);
      return part;
    };
    const box = (parent, material, size, position) => mesh(parent, cube, material, position, size);
    const makeHand = (side) => {
      const hand = new THREE.Group();
      hand.name = side > 0 ? 'throwing-hand' : 'arming-hand';
      const sleeveMesh = box(hand, sleeve, [0.105, 0.115, 0.36], [side * 0.018, -0.10, 0.20]);
      sleeveMesh.rotation.x = 0.34;
      if (side < 0) {
        // The arming wrist reaches across from the left elbow. A forearm pointing
        // straight at the camera would cover the bottle and emerge from the right.
        sleeveMesh.scale.z = 0.57;
        sleeveMesh.position.set(-0.20, -0.13, 0.17);
        sleeveMesh.rotation.set(0.44, -0.85, -0.08);
      }
      box(hand, armor, [0.11, 0.024, 0.055], [0, -0.018, 0.07]);
      box(hand, glove, [0.095, 0.105, 0.070], [0, 0, 0.025]);
      box(hand, armor, [0.078, 0.070, 0.014], [0, 0.008, 0.067]);
      for (let i = 0; i < 4; i++) {
        const finger = box(hand, glove, [0.025, 0.023, 0.08], [side * 0.043, 0.040 - i * 0.026, -0.012]);
        finger.rotation.y = side * 0.20;
      }
      box(hand, glove, [0.030, 0.055, 0.055], [-side * 0.052, 0.035, 0.003]);
      this.root.add(hand);
      return hand;
    };
    this.right = makeHand(1);
    this.left = makeHand(-1);
    this.grip = new THREE.Group();
    this.grip.name = 'held-throwable';
    this.grip.position.set(0, 0.062, -0.025);
    this.right.add(this.grip);
    this.models = {};
    for (const id of IDS) {
      const model = new THREE.Group();
      model.name = `held-${id}`;
      model.visible = id === this.type;
      this.grip.add(model);
      this.models[id] = model;
      if (id === 'frag') {
        const shell = mat(0x526c3f, { metalness: 0.18 });
        mesh(model, new THREE.SphereGeometry(0.067, 10, 7), dark, [0, 0, 0], [1, 1.18, 1]);
        for (let row = 0; row < 4; row++) {
          const y = (row - 1.5) * 0.036;
          const radius = row === 0 || row === 3 ? 0.050 : 0.064;
          for (let column = 0; column < 8; column++) {
            const angle = column * Math.PI / 4;
            const panel = box(model, shell, [0.045, 0.030, 0.023], [Math.sin(angle) * radius, y, Math.cos(angle) * radius]);
            panel.rotation.y = angle;
          }
        }
        box(model, orange, [0.075, 0.009, 0.083], [0, 0.066, 0]);
      } else if (id === 'limpet') {
        const housing = mat(0x526442, { metalness: 0.35 });
        box(model, housing, [0.20, 0.13, 0.065], [0, 0.014, 0]);
        for (const side of [-1, 1]) box(model, dark, [0.024, 0.11, 0.074], [side * 0.083, 0.014, 0]);
        box(model, steel, [0.05, 0.024, 0.017], [0, 0.016, 0.037]);
        box(model, orange, [0.018, 0.018, 0.01], [0, 0.016, 0.047]);
      } else if (id === 'pulse') {
        mesh(model, new THREE.IcosahedronGeometry(0.081, 1), dark);
        for (let i = 0; i < 3; i++) {
          const ring = mesh(model, new THREE.TorusGeometry(0.071, 0.006, 4, 16), cyan);
          ring.rotation.set(i * Math.PI / 3, Math.PI / 2, 0);
        }
        box(model, steel, [0.037, 0.035, 0.042], [0, 0.075, 0]);
      } else if (id === 'smoke') {
        mesh(model, new THREE.CylinderGeometry(0.057, 0.057, 0.16, 10), steel);
        mesh(model, new THREE.CylinderGeometry(0.059, 0.059, 0.045, 10), mat(0xc7e3de));
        box(model, dark, [0.041, 0.012, 0.006], [0, 0, 0.058]);
      } else {
        const glass = mat(0x365c2c, { roughness: 0.25, metalness: 0.16 });
        const label = mat(0xd9bc7d);
        const cloth = mat(0xc7b68b);
        mesh(model, new THREE.CylinderGeometry(0.055, 0.052, 0.18, 10), glass, [0, 0.015, 0]);
        mesh(model, new THREE.CylinderGeometry(0.022, 0.055, 0.055, 10), glass, [0, 0.132, 0]);
        mesh(model, new THREE.CylinderGeometry(0.020, 0.022, 0.081, 10), glass, [0, 0.20, 0]);
        mesh(model, new THREE.CylinderGeometry(0.056, 0.056, 0.065, 10), label, [0, 0.010, 0]);
        box(model, dark, [0.035, 0.011, 0.003], [0, 0.020, 0.056]);
        box(model, dark, [0.024, 0.011, 0.003], [0, -0.001, 0.056]);
        box(model, cloth, [0.029, 0.032, 0.033], [0, 0.246, 0]);
        const wick = box(model, cloth, [0.021, 0.084, 0.018], [-0.017, 0.273, 0]);
        wick.rotation.z = 0.43;
        this.wickFlame = new THREE.Group();
        this.wickFlame.name = 'molotov-wick-flame';
        this.wickFlame.position.set(-0.037, 0.303, 0);
        model.add(this.wickFlame);
        const flameMat = new THREE.MeshBasicMaterial({ color: 0xff831f, transparent: true, opacity: 0.9, toneMapped: false, depthWrite: false });
        mesh(this.wickFlame, new THREE.ConeGeometry(0.023, 0.105, 5), flameMat, [0, 0.042, 0]);
        mesh(this.wickFlame, new THREE.ConeGeometry(0.012, 0.061, 5), new THREE.MeshBasicMaterial({ color: 0xfff2a2, toneMapped: false }), [0, 0.019, 0.008]);
        this.wickFlame.visible = false;
      }
      if (id !== 'molotov') {
        box(model, steel, [0.040, 0.032, 0.032], [0, 0.083, 0]);
        const lever = box(model, steel, [0.018, 0.10, 0.023], [0.051, 0.045, 0]);
        lever.rotation.z = 0.19;
      }
    }

    this.pin = new THREE.Group();
    this.pin.name = 'grenade-safety-pin';
    mesh(this.pin, new THREE.TorusGeometry(0.023, 0.004, 5, 14), steel);
    box(this.pin, steel, [0.052, 0.006, 0.006], [0.028, -0.009, 0]);
    this.root.add(this.pin);
    this.lighter = new THREE.Group();
    this.lighter.name = 'molotov-lighter';
    box(this.lighter, dark, [0.032, 0.064, 0.025], [0, 0.041, -0.017]);
    box(this.lighter, steel, [0.035, 0.017, 0.027], [0, 0.081, -0.017]);
    this.left.add(this.lighter);
    this.lighterFlame = mesh(this.lighter, new THREE.ConeGeometry(0.009, 0.04, 5), new THREE.MeshBasicMaterial({ color: 0xffd57d, toneMapped: false }), [0, 0.11, -0.017]);
    this._point = new THREE.Vector3();
    this._pinTarget = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._throwPosition = new THREE.Vector3();
    this._throwRotation = new THREE.Euler();
  }

  _cue(cue) { this.onCue?.({ cue, type: this.type, charge: this.charge }); }

  setCharge(charge, type = this.type, holdMs = null, active = Number(charge) > 0) {
    if (this._disposed) return;
    if (!active) {
      if (this.held) { this.held = false; this.returnElapsed = 0; }
      return;
    }
    const id = typeId(type);
    this.charge = clamp(charge);
    if (!this.held || id !== this.type) {
      this._holdOffset = this.held && Number.isFinite(holdMs) ? Math.max(0, holdMs / 1000) : 0;
      this.type = id;
      this.elapsed = 0;
      this._holdSeconds = 0;
      this._armed = false;
      this._ready = false;
      this.throwElapsed = null;
      this.returnElapsed = null;
      this.held = true;
      this.grip.visible = true;
      for (const [name, model] of Object.entries(this.models)) model.visible = name === id;
      this._cue('draw');
    }
    if (Number.isFinite(holdMs)) this._holdSeconds = Math.max(0, holdMs / 1000 - this._holdOffset);
  }

  throw(charge = this.charge, type = this.type) {
    if (this._disposed) return;
    if (!this.held && this.returnElapsed === null) this.setCharge(charge, type, null, true);
    this.charge = clamp(charge);
    // Quick taps retain the pin/lighter contact and hand follow-through. The object
    // leaves immediately, matching the predicted projectile's authoritative launch.
    if (!this._armed) { this._armed = true; this._cue(this.type === 'molotov' ? 'ignite' : 'pin'); }
    this._poseHeld();
    this._throwPosition.copy(this.right.position);
    this._throwRotation.copy(this.right.rotation);
    this.held = false;
    this.returnElapsed = null;
    this.throwElapsed = 0;
    this.grip.visible = false;
    this.root.visible = true;
    this.blend = 1;
    this._cue('throw');
  }

  cancel() {
    this.held = false;
    this.elapsed = 0;
    this.throwElapsed = null;
    this.returnElapsed = null;
    this.blend = 0;
    this.root.visible = false;
    this.grip.visible = false;
    this.pin.visible = false;
    this.wickFlame.visible = false;
    this._armed = false;
    this._ready = false;
  }

  _poseHeld() {
    const draw = smooth(this.elapsed / THROWABLE_TIMING.draw);
    const pull = smooth((this.elapsed - THROWABLE_TIMING.arm) / 0.16);
    const cock = this.type === 'limpet' ? 0 : smooth((this.elapsed - 0.40) / 0.26) * (0.45 + this.charge * 0.55);
    const bob = Math.sin(this._clock * 3.1) * 0.004;
    this.right.position.set(0.22 + cock * 0.085, -0.60 + draw * 0.36 - cock * 0.008 + bob, -0.38 - draw * 0.15 + cock * 0.022);
    this.right.rotation.set(-0.42 + draw * 0.34 + cock * 0.14, -0.17 - cock * 0.10, -0.27 + draw * 0.12 + cock * 0.10);
    const reach = smooth((this.elapsed - 0.08) / 0.16);
    const retreat = smooth((this.elapsed - 0.40) / 0.22);
    const molotov = this.type === 'molotov';
    this.left.position.set(-0.25 + reach * (molotov ? 0.40 : 0.42) - pull * (molotov ? 0.04 : 0.16) - retreat * 0.22,
      -0.58 + reach * (molotov ? 0.58 : 0.46) - retreat * 0.44 + pull * 0.035,
      -0.31 - reach * 0.20 + retreat * 0.07);
    this.left.rotation.set(0.06, 0.2, -0.12 - pull * 0.35);
    this.left.visible = retreat < 0.995;
    this.lighter.visible = molotov;
    this.lighterFlame.visible = molotov && this._armed && retreat < 0.65;
    this.wickFlame.visible = molotov && this._armed;

    // Until extraction the ring sits in the grenade's top socket. Afterwards it
    // travels with the left hand, so the sound corresponds to a visible separation.
    this.pin.visible = !molotov && retreat < 0.9;
    const attached = this._point.set(-0.024, 0.088, 0.019);
    this.grip.localToWorld(attached);
    this.root.worldToLocal(attached);
    this.pin.position.copy(attached);
    if (pull > 0) this.pin.position.lerp(this._pinTarget.set(
      this.left.position.x + 0.021, this.left.position.y + 0.055, this.left.position.z - 0.029), pull);
    this.grip.getWorldQuaternion(this._quat);
    this.root.getWorldQuaternion(this.pin.quaternion).invert();
    this.pin.quaternion.multiply(this._quat);
    this.pin.rotation.z += pull * 0.6;
    const flicker = 0.88 + Math.sin(this._clock * 41) * 0.12;
    this.wickFlame.scale.set(1, flicker, 1);
    this.wickFlame.rotation.z = Math.sin(this._clock * 21) * 0.1;
  }

  update(dt, { suppressed = false } = {}) {
    if (this._disposed || !(dt > 0)) return this.blend;
    const seconds = Math.min(dt, 0.25);
    this._clock += seconds;
    if (this.held) {
      this.elapsed = Math.max(this.elapsed + seconds, this._holdSeconds);
      if (!this._armed && this.elapsed >= THROWABLE_TIMING.arm) {
        this._armed = true;
        this._cue(this.type === 'molotov' ? 'ignite' : 'pin');
      }
      if (!this._ready && this.elapsed >= THROWABLE_TIMING.ready) { this._ready = true; this._cue('ready'); }
      this.blend = smooth(this.elapsed / THROWABLE_TIMING.draw);
      this._poseHeld();
    } else if (this.throwElapsed !== null) {
      this.throwElapsed += seconds;
      const t = this.throwElapsed / THROWABLE_TIMING.throw;
      const swing = smooth(t / 0.46);
      const lower = smooth((t - 0.38) / 0.62);
      this.right.position.copy(this._throwPosition);
      this.right.position.x -= 0.18 * swing;
      const placing = this.type === 'limpet';
      this.right.position.y += (placing ? 0.04 : 0.19) * swing - 0.64 * lower;
      this.right.position.z -= (placing ? 0.30 : 0.20 + this.charge * 0.14) * swing;
      this.right.rotation.set(this._throwRotation.x - (placing ? 0.12 : 0.80) * swing + lower * 0.3, -0.10, this._throwRotation.z - 0.20 * swing);
      this.left.visible = false;
      this.pin.visible = false;
      this.blend = 1 - smooth((t - 0.50) / 0.50);
      if (t >= 1) this.cancel();
    } else if (this.returnElapsed !== null) {
      this.returnElapsed += seconds;
      const t = smooth(this.returnElapsed / THROWABLE_TIMING.return);
      this._poseHeld();
      this.right.position.y -= 0.48 * t;
      this.left.position.y -= 0.48 * t;
      this.pin.position.y -= 0.48 * t;
      this.blend = 1 - t;
      if (t >= 1) this.cancel();
    }
    this.root.visible = this.blend > 0 && !suppressed;
    return this.blend;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.root.removeFromParent();
    disposeObjectTree(this.root);
    this.root.clear();
  }
}
