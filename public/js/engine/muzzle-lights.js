import * as THREE from '../vendor/three.module.js';

/** Stable scene light count: flashes change uniforms, never shader variants. */
export class MuzzleLights {
  constructor(scene) {
    this.scene = scene;
    this.lights = Array.from({ length: 2 }, () => {
      const light = new THREE.PointLight(0xffd080, 0, 6);
      scene.add(light);
      return light;
    });
    this.position = new THREE.Vector3();
  }

  update(local, avatars, camera) {
    this.copy(this.lights[0], local);
    let closest = null, distance = Infinity;
    for (const avatar of avatars.values()) {
      const source = avatar.weaponModel?.flashLight;
      if (!avatar.alive || !avatar.group.visible || !source || source.intensity <= 0) continue;
      source.getWorldPosition(this.position);
      const next = this.position.distanceToSquared(camera.position);
      if (next < distance) { closest = source; distance = next; }
    }
    this.copy(this.lights[1], closest);
  }

  copy(target, source) {
    target.intensity = source?.intensity || 0;
    if (!source || source.intensity <= 0) return;
    source.getWorldPosition(target.position);
    target.color.copy(source.color);
    target.distance = source.distance;
  }

  dispose() {
    for (const light of this.lights) { this.scene.remove(light); light.dispose(); }
  }
}
