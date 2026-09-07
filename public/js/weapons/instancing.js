// Allocation-conscious helpers shared by the weapon-effects pools.
import * as THREE from '../vendor/three.module.js';

const TAU = Math.PI * 2;
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

export function makeFlashTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d');
  context.translate(32, 32);
  const gradient = context.createRadialGradient(0, 0, 2, 0, 0, 30);
  gradient.addColorStop(0, 'rgba(255,240,200,1)');
  gradient.addColorStop(0.35, 'rgba(255,190,90,0.85)');
  gradient.addColorStop(1, 'rgba(255,140,40,0)');
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(0, 0, 30, 0, TAU);
  context.fill();
  context.lineWidth = 3;
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * TAU;
    context.beginPath();
    context.moveTo(2, 0);
    context.lineTo(Math.cos(angle) * 28, Math.sin(angle) * 28);
    context.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
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
