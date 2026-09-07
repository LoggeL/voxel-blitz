import * as THREE from '../vendor/three.module.js';
import { disposeObjectTree } from '../engine/dispose.js';

const smooth = value => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

/** Camera-local reach, brace, and release. These hands never move the aiming camera. */
export class VaultHands {
  constructor(parent) {
    this.root = new THREE.Group();
    this.root.name = 'vault-hands';
    this.root.visible = false;
    parent.add(this.root);
    this.blend = 0;
    this.progress = 0;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const sleeve = new THREE.MeshStandardMaterial({ color: 0x44515e, roughness: 0.95 });
    const glove = new THREE.MeshStandardMaterial({ color: 0x202831, roughness: 0.88 });
    const armor = new THREE.MeshStandardMaterial({ color: 0x667582, roughness: 0.72 });
    this.hands = [-1, 1].map(side => {
      const hand = new THREE.Group();
      const box = (material, size, pos) => {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.scale.set(...size);
        mesh.position.set(...pos);
        hand.add(mesh);
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
      this.root.add(hand);
      return hand;
    });
  }

  update(dt, active, progress) {
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
    this.root.removeFromParent();
    disposeObjectTree(this.root);
    this.root.clear();
  }
}
