// Seated vehicle crew (JeepDriver, AircraftPilot) hold their hips, legs, torso
// and head still for the whole ride: only the arms follow the controls. Once
// the seat pose is set, those rigid meshes merge into one mesh per material
// under the hips, so a crew member costs a few draws instead of one per
// imported panel (the RIVET body has ~50 rigid meshes). Joint groups stay in
// place, empty, for cosmetic fittings and the first-person visibility switch.
import * as THREE from '../vendor/three.module.js';

const local = new THREE.Matrix4(), carrierInverse = new THREE.Matrix4(), relative = new THREE.Matrix4();

/** `node`'s transform in `root`'s frame (local matrices refreshed on the way). */
function matrixIn(root, node, out) {
  out.identity();
  for (let current = node; current && current !== root; current = current.parent) {
    current.updateMatrix();
    out.premultiply(current.matrix);
  }
  return out;
}

const mergeable = mesh => mesh.isMesh && !mesh.isInstancedMesh && !mesh.isSkinnedMesh && !Array.isArray(mesh.material) &&
  mesh.material && mesh.geometry?.isBufferGeometry && mesh.geometry.groups.length === 0 &&
  Object.keys(mesh.geometry.morphAttributes).length === 0 && mesh.visible && mesh.renderOrder === 0 &&
  Object.values(mesh.geometry.attributes).every(attribute => !attribute.isInterleavedBufferAttribute);

const signature = geometry => Object.keys(geometry.attributes).sort()
  .map(name => `${name}:${geometry.attributes[name].itemSize}:${geometry.attributes[name].normalized}:${geometry.attributes[name].array.constructor.name}`).join('|');

function mergeBatch(entries) {
  const indexed = entries.every(entry => entry.geometry.index);
  const pieces = entries.map(entry => {
    const geometry = (indexed ? entry.geometry.clone() : entry.geometry.index ? entry.geometry.toNonIndexed() : entry.geometry.clone());
    geometry.applyMatrix4(entry.matrix);
    return { geometry, upper: entry.upper };
  });
  const first = pieces[0].geometry;
  const merged = new THREE.BufferGeometry();
  for (const name of Object.keys(first.attributes)) {
    const source = first.attributes[name];
    const array = new source.array.constructor(pieces.reduce((sum, piece) => sum + piece.geometry.attributes[name].array.length, 0));
    let offset = 0;
    for (const piece of pieces) { array.set(piece.geometry.attributes[name].array, offset); offset += piece.geometry.attributes[name].array.length; }
    merged.setAttribute(name, new THREE.BufferAttribute(array, source.itemSize, source.normalized));
  }
  // Lower-body pieces come first: first person keeps that prefix only.
  let lowerCount = 0;
  if (indexed) {
    const vertices = merged.attributes.position.count;
    const index = new (vertices > 65535 ? Uint32Array : Uint16Array)(pieces.reduce((sum, piece) => sum + piece.geometry.index.count, 0));
    let offset = 0, base = 0;
    for (const piece of pieces) {
      const source = piece.geometry.index.array;
      for (let i = 0; i < source.length; i++) index[offset + i] = source[i] + base;
      offset += source.length; base += piece.geometry.attributes.position.count;
      if (!piece.upper) lowerCount = offset;
    }
    merged.setIndex(new THREE.BufferAttribute(index, 1));
  } else {
    let offset = 0;
    for (const piece of pieces) { offset += piece.geometry.attributes.position.count; if (!piece.upper) lowerCount = offset; }
  }
  for (const piece of pieces) piece.geometry.dispose();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return { geometry: merged, lowerCount };
}

/**
 * Bake the seated crew body: every rigid mesh under the hips, legs, torso and
 * head merges per material into `avatar.hips`. Returns the batch handle
 * `{ meshes, setUpperVisible(visible) }`, also kept as `avatar.crewBatch`.
 */
export function batchSeatedCrewBody(avatar) {
  const carrier = avatar.hips;
  const lower = [avatar.hips, avatar.lLeg, avatar.rLeg], upper = [avatar.torso, avatar.head];
  carrierInverse.copy(matrixIn(avatar.group, carrier, local)).invert();
  const batches = new Map();
  const collect = (root, isUpper) => root.traverse(object => {
    if (!mergeable(object)) return;
    const key = `${object.material.uuid}|${object.castShadow}|${object.receiveShadow}|${object.frustumCulled}|${object.layers.mask}|${object.geometry.index ? 'i' : 'n'}|${signature(object.geometry)}`;
    let batch = batches.get(key);
    if (!batch) { batch = { material: object.material, template: object, entries: [] }; batches.set(key, batch); }
    relative.multiplyMatrices(carrierInverse, matrixIn(avatar.group, object, local));
    batch.entries.push({ mesh: object, geometry: object.geometry, matrix: relative.clone(), upper: isUpper });
  });
  for (const root of lower) collect(root, false);
  for (const root of upper) collect(root, true);
  const meshes = [];
  for (const batch of batches.values()) {
    // A material used once gains nothing from a copy of its geometry.
    if (batch.entries.length < 2) continue;
    // Lower body first so the upper body is the draw-range suffix.
    batch.entries.sort((a, b) => Number(a.upper) - Number(b.upper));
    const { geometry, lowerCount } = mergeBatch(batch.entries);
    const mesh = new THREE.Mesh(geometry, batch.material);
    mesh.name = 'crew-body-batch';
    mesh.castShadow = batch.template.castShadow; mesh.receiveShadow = batch.template.receiveShadow;
    mesh.frustumCulled = batch.template.frustumCulled; mesh.layers.mask = batch.template.layers.mask;
    mesh.matrixAutoUpdate = false;
    mesh.userData.lowerCount = lowerCount;
    mesh.userData.upperOnly = lowerCount === 0;
    mesh.userData.lowerOnly = batch.entries.every(entry => !entry.upper);
    for (const entry of batch.entries) entry.mesh.removeFromParent();
    carrier.add(mesh);
    meshes.push(mesh);
  }
  // The rigid joints never move again: their local matrices are final.
  for (const root of [...lower, ...upper]) root.traverse(object => {
    if (object.isMesh || object.isSprite) return;
    object.updateMatrix();
    object.matrixAutoUpdate = false;
  });
  const handle = {
    meshes,
    /** First person hides the head and chest: each batch keeps its lower-body prefix. */
    setUpperVisible(visible) {
      for (const mesh of meshes) {
        if (mesh.userData.lowerOnly) continue;
        mesh.geometry.setDrawRange(0, visible ? Infinity : mesh.userData.lowerCount);
        mesh.visible = visible || !mesh.userData.upperOnly;
      }
    },
  };
  avatar.crewBatch = handle;
  return handle;
}
