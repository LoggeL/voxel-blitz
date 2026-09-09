import * as THREE from '../vendor/three.module.js';

// Cache geometry in each detached part's own coordinates, including its children.
export function prepareDeathPart(part) {
  const object = part.object;
  object.updateWorldMatrix(true, true);
  const inverse = object.matrixWorld.clone().invert();
  const box = new THREE.Box3();
  object.traverseVisible(node => {
    if (!node.isMesh) return;
    node.geometry.computeBoundingBox();
    box.union(node.geometry.boundingBox.clone().applyMatrix4(
      new THREE.Matrix4().multiplyMatrices(inverse, node.matrixWorld)));
  });
  part.bounds = box;
  part.worldBounds = new THREE.Box3();
  part.previousRotation = new THREE.Quaternion();
}

function collides(part, solidAt) {
  part.object.updateWorldMatrix(true, false);
  const box = part.worldBounds.copy(part.bounds).applyMatrix4(part.object.matrixWorld);
  if (box.isEmpty()) return false;
  const eps = 0.001;
  for (let y = Math.floor(box.min.y + eps); y <= Math.floor(box.max.y - eps); y++) {
    for (let z = Math.floor(box.min.z + eps); z <= Math.floor(box.max.z - eps); z++) {
      for (let x = Math.floor(box.min.x + eps); x <= Math.floor(box.max.x - eps); x++) {
        if (solidAt(x, y, z)) return true;
      }
    }
  }
  return false;
}

export function stepDeathPart(part, dt, solidAt) {
  const steps = Math.max(1, Math.ceil(dt / (1 / 120)),
    Math.ceil(part.velocity.length() * dt / 0.12));
  const step = dt / steps;
  const object = part.object;
  for (let i = 0; i < steps; i++) {
    part.velocity.y -= 11.8 * step;
    for (const axis of ['x', 'y', 'z']) {
      const before = object.position[axis];
      const distance = part.velocity[axis] * step;
      object.position[axis] += distance;
      if (solidAt && collides(part, solidAt)) {
        // Stop at the surface instead of leaving a frame-sized gap.
        let lo = 0, hi = 1;
        for (let j = 0; j < 8; j++) {
          const mid = (lo + hi) / 2;
          object.position[axis] = before + distance * mid;
          if (collides(part, solidAt)) hi = mid;
          else lo = mid;
        }
        object.position[axis] = before + distance * lo;
        part.velocity[axis] *= Math.abs(part.velocity[axis]) > 1 ? -0.38 : 0;
        if (axis === 'y') {
          const friction = Math.exp(-step * 12);
          part.velocity.x *= friction;
          part.velocity.z *= friction;
          part.angular.multiplyScalar(friction);
        }
      }
    }
    const rotation = part.previousRotation.copy(object.quaternion);
    object.rotation.x += part.angular.x * step;
    object.rotation.y += part.angular.y * step;
    object.rotation.z += part.angular.z * step;
    if (solidAt && collides(part, solidAt)) {
      object.quaternion.copy(rotation);
      part.angular.multiplyScalar(0.8);
    }
  }
}
