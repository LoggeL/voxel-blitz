// Allocation-conscious helpers shared by the weapon-effects pools.
import * as THREE from '../vendor/three.module.js';

const HIDDEN_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

/** Hide an instance without allocating a throwaway transform. */
export function hideInstance(mesh, index) {
  mesh.setMatrixAt(index, HIDDEN_MATRIX);
}

/** Select the most-expired slot, matching the effects pools' overwrite policy. */
export function freeOldestIndex(slots) {
  let oldest = 0;
  let oldestAge = -1;
  for (let i = 0; i < slots.length; i++) {
    const age = slots[i].t / (slots[i].life || 1);
    if (age > oldestAge) {
      oldestAge = age;
      oldest = i;
    }
  }
  slots[oldest].active = false;
  return oldest;
}

export function makeImpactCrossGeometry() {
  const positions = new Float32Array([
    -1, -0.07, 0, 1, -0.07, 0, 1, 0.07, 0,
    -1, -0.07, 0, 1, 0.07, 0, -1, 0.07, 0,
    -0.07, -1, 0, 0.07, -1, 0, 0.07, 1, 0,
    -0.07, -1, 0, 0.07, 1, 0, -0.07, 1, 0,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}
