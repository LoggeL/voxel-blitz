// Break-away voxel chunks for destroyed hulls. Each model tags the voxels
// that tear off (turret, rotor, skirts, doors, wings); the intact hull draws
// them, the wreck geometry omits them, and on destruction each tag becomes a
// tumbling chunk posed exactly where its part sat. Chunk geometry is cached
// per (type, team) and shared; chunks share one charred material whose
// shader fades them out within 2.5 m of the camera.
import * as THREE from '../vendor/three.module.js';
import { createVehicleMaterial } from './voxel-model/material.js';

let charred = null;
/** The shared charred chunk material (vehicle program, soot and near fade on). */
export function fragmentMaterial() {
  if (!charred) charred = createVehicleMaterial({ soot: 0.82, lamps: 0, burn: 0.7, nearFade: true, name: 'vehicle-fragment' });
  return charred;
}

const offset = new THREE.Matrix4();
const world = new THREE.Matrix4();

/**
 * Chunks of a posed voxel model, highest priority first (turret before
 * skirts). Returns [{ object, name, radius, geometry, materials }].
 */
export function createVehicleFragments(model, { maxPieces = 64 } = {}) {
  if (!model?.fragmentSources) return [];
  const limit = Math.max(0, Math.min(64, Number.isFinite(maxPieces) ? Math.floor(maxPieces) : 64));
  model.group.updateWorldMatrix(true, true);
  const sources = model.fragmentSources().map((source, index) => ({ source, index }))
    .sort((a, b) => b.source.priority - a.source.priority || a.index - b.index);
  const material = fragmentMaterial();
  const pieces = [];
  for (const { source } of sources) {
    if (pieces.length >= limit) break;
    const geometry = model.fragmentGeometry(source);
    if (!geometry?.opaque || !geometry.center) continue;
    const pivot = source.node.userData.pivot || [0, 0, 0];
    offset.makeTranslation(geometry.center[0] - pivot[0], geometry.center[1] - pivot[1], geometry.center[2] - pivot[2]);
    world.multiplyMatrices(source.node.matrixWorld, offset);
    const object = new THREE.Mesh(geometry.opaque, material);
    object.name = `vehicle-fragment-${source.tag}`;
    world.decompose(object.position, object.quaternion, object.scale);
    object.castShadow = true; object.receiveShadow = true;
    object.userData.vehicleFragment = source.tag;
    object.userData.fragmentOwned = true;
    if (!geometry.opaque.boundingBox) geometry.opaque.computeBoundingBox();
    if (!geometry.opaque.boundingSphere) geometry.opaque.computeBoundingSphere();
    pieces.push({ object, name: source.tag, radius: geometry.opaque.boundingSphere.radius, geometry: geometry.opaque, materials: [] });
  }
  return pieces;
}

/** Detach a chunk. Cached geometry and the shared material stay alive. */
export function disposeVehicleFragment(fragment) {
  if (!fragment?.object?.userData.fragmentOwned) return;
  fragment.object.userData.fragmentOwned = false;
  fragment.object.removeFromParent();
  if (!fragment.geometry?.userData?.cached) fragment.geometry?.dispose?.();
  for (const material of fragment.materials || []) if (material !== charred) material.dispose();
}
