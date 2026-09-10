import * as THREE from '../vendor/three.module.js';
import { disposeObjectTree } from '../engine/dispose.js';

/** A pouch, exposed forearm and a gloved hand winding a field dressing. */
export class MedkitHands {
  constructor(parent) {
    this.root = new THREE.Group();
    this.root.name = 'medkit-hands';
    this.root.visible = false;
    parent.add(this.root);
    this.blend = 0;
    this.time = 0;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = color => new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
    const sleeve = material(0x44515e), glove = material(0x252d32);
    const skin = material(0xb78b6c), dressing = material(0xebe5cb), pouch = material(0x466a53);
    const box = (parent, mat, size, position) => {
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.scale.set(...size);
      mesh.position.set(...position);
      parent.add(mesh);
      return mesh;
    };
    this.arm = new THREE.Group();
    this.arm.position.set(-0.08, -0.31, -0.5);
    this.arm.rotation.set(0.12, 0.18, -0.12);
    this.root.add(this.arm);
    box(this.arm, sleeve, [0.26, 0.12, 0.14], [-0.23, 0, 0]);
    box(this.arm, skin, [0.27, 0.095, 0.105], [0.015, 0, 0]);
    box(this.arm, glove, [0.13, 0.065, 0.14], [0.21, 0, 0]);
    this.wraps = Array.from({ length: 6 }, (_, i) =>
      box(this.arm, dressing, [0.031, 0.105, 0.116], [-0.035 + i * 0.028, 0, 0]));
    this.hand = new THREE.Group();
    this.root.add(this.hand);
    box(this.hand, sleeve, [0.13, 0.13, 0.28], [0.075, -0.11, 0.19]).rotation.x = 0.45;
    box(this.hand, glove, [0.12, 0.065, 0.14], [0, 0, 0]);
    box(this.hand, dressing, [0.075, 0.065, 0.07], [-0.07, 0.014, -0.036]);
    const bag = box(this.root, pouch, [0.23, 0.15, 0.12], [-0.32, -0.45, -0.43]);
    // A simple dressing label, kept separate from the glove and wrap silhouettes.
    box(this.root, dressing, [0.12, 0.056, 0.008], [-0.32, -0.45, bag.position.z + 0.064]);
    box(this.root, pouch, [0.08, 0.012, 0.01], [-0.32, -0.45, bag.position.z + 0.07]);
  }

  update(dt, active, progress = 0, reducedMotion = false) {
    const seconds = Math.max(0, Math.min(0.25, dt));
    if (active && !this.wasActive) this.time = 0;
    this.wasActive = active;
    this.time += seconds;
    this.blend += ((active ? 1 : 0) - this.blend) * (1 - Math.exp(-seconds * 20));
    this.root.visible = this.blend > 0.01;
    this.root.position.y = -(1 - this.blend) * 0.6;
    const phase = this.time * Math.PI * 3;
    const motion = reducedMotion ? 0.25 : 1;
    this.hand.position.set(0.06 + Math.cos(phase) * 0.075 * motion,
      -0.25 + Math.sin(phase) * 0.055 * motion, -0.47 + Math.cos(phase) * 0.04 * motion);
    this.hand.rotation.set(-0.2, -0.3, Math.sin(phase) * 0.25 * motion);
    for (let i = 0; i < this.wraps.length; i++) this.wraps[i].visible = progress * 6 >= i;
    return this.blend;
  }

  dispose() {
    this.root.removeFromParent();
    disposeObjectTree(this.root);
    this.root.clear();
  }
}
