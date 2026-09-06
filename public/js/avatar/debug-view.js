import * as THREE from '../vendor/three.module.js';
import { playerHitboxes } from '../../../shared/player-hitboxes.js';
import { displaySettings } from '../ui/display-settings.js';

/** The same oriented body zones the server uses for damage. */
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
    for (const remote of remotes.values()) {
      if (remote.id === myId || remote.state !== 'alive') continue;
      let group = this.boxes.get(remote.id);
      if (!group) {
        group = new THREE.Group();
        group.name = 'debug-hitbox';
        this.scene.add(group);
        this.boxes.set(remote.id, group);
      }
      const zones = playerHitboxes(remote);
      zones.forEach((zone, i) => {
        let wire = group.children[i];
        if (!wire) {
          wire = new THREE.LineSegments(this.geometry, zone.zone === 'head' ? this.headMaterial : this.bodyMaterial);
          group.add(wire);
        }
        wire.position.set(...zone.center);
        wire.scale.set(...zone.half.map(v => v * 2));
        const matrix = new THREE.Matrix4().makeBasis(...zone.basis.map(v => new THREE.Vector3(...v)));
        wire.quaternion.setFromRotationMatrix(matrix);
      });
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
