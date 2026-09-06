import * as THREE from '../vendor/three.module.js';
import { PLAYER_HALF, HEADSHOT_Y_FRAC } from '../../../shared/combatmath.js';
import { displaySettings } from '../ui/display-settings.js';

/** Axis-aligned combat bounds, independent of cosmetic avatar bob and pose. */
export class AvatarDebugView {
  constructor(scene) {
    this.scene = scene;
    this.boxes = new Map();
    this.materials = new Map();
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.geometry = new THREE.EdgesGeometry(box);
    box.dispose();
    this.bodyMaterial = new THREE.LineBasicMaterial({ color: 0x36dfff, depthTest: true });
    this.headMaterial = new THREE.LineBasicMaterial({ color: 0xff9f1c, depthTest: true });
  }

  sync(remotes, avatars, myId) {
    const { showHitboxes, showWireframes } = displaySettings();
    // Restore originals before traversing: weapon models can change between frames.
    for (const [material, original] of this.materials) material.wireframe = original;
    this.materials.clear();
    if (showWireframes) {
      for (const avatar of avatars.values()) avatar.group.traverse(object => {
        if (!object.isMesh) return;
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          if (!material || this.materials.has(material)) continue;
          this.materials.set(material, material.wireframe);
          material.wireframe = true;
        }
      });
    }
    for (const [id, group] of this.boxes) {
      if (!showHitboxes || !remotes.has(id) || remotes.get(id).state !== 'alive' || id === myId) {
        this.scene.remove(group);
        this.boxes.delete(id);
      }
    }
    if (!showHitboxes) return;
    const height = PLAYER_HALF.h * 2;
    const bodyHeight = height * HEADSHOT_Y_FRAC;
    for (const remote of remotes.values()) {
      if (remote.id === myId || remote.state !== 'alive') continue;
      let group = this.boxes.get(remote.id);
      if (!group) {
        group = new THREE.Group();
        group.name = 'debug-hitbox';
        const body = new THREE.LineSegments(this.geometry, this.bodyMaterial);
        body.scale.set(PLAYER_HALF.x * 2, bodyHeight, PLAYER_HALF.x * 2);
        body.position.y = bodyHeight / 2;
        const head = new THREE.LineSegments(this.geometry, this.headMaterial);
        head.scale.set(PLAYER_HALF.x * 2, height - bodyHeight, PLAYER_HALF.x * 2);
        head.position.y = (height + bodyHeight) / 2;
        group.add(body, head);
        this.scene.add(group);
        this.boxes.set(remote.id, group);
      }
      group.position.set(remote.x, remote.y, remote.z);
    }
  }

  dispose() {
    for (const [material, original] of this.materials) material.wireframe = original;
    this.materials.clear();
    for (const group of this.boxes.values()) this.scene.remove(group);
    this.boxes.clear();
    this.geometry.dispose();
    this.bodyMaterial.dispose();
    this.headMaterial.dispose();
  }
}
