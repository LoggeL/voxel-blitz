// Seated vehicle crew (JeepDriver, AircraftPilot) hold their hips, legs, torso
// and head still for the whole ride: only the arms follow the controls. Once
// the seat pose is set, those rigid meshes merge into one mesh per material
// under the hips, so a crew member costs a few draws instead of one per
// imported panel (the RIVET body has ~50 rigid meshes). Joint groups stay in
// place, empty, for cosmetic fittings and the first-person visibility switch.
import * as THREE from '../vendor/three.module.js';
import { bindRivetDetail, farRivetGeometry } from '../engine/rivet-detail.js';

const local = new THREE.Matrix4(), carrierInverse = new THREE.Matrix4(), relative = new THREE.Matrix4();
const omittedIndices = { array: [], count: 0 };

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
    const distant = farRivetGeometry(entry.geometry);
    return { geometry, upper: entry.upper, farIndex: distant ? distant.index || omittedIndices : null };
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
  let lowerCount = 0, fullCount = 0, farCount = 0, farLowerCount = 0;
  const hasDistantIndices = indexed && pieces.some(piece => piece.farIndex);
  if (indexed) {
    const vertices = merged.attributes.position.count;
    fullCount = pieces.reduce((sum, piece) => sum + piece.geometry.index.count, 0);
    if (hasDistantIndices) farCount = pieces.reduce((sum, piece) => sum + (piece.farIndex || piece.geometry.index).count, 0);
    const index = new (vertices > 65535 ? Uint32Array : Uint16Array)(fullCount + farCount);
    let offset = 0, farOffset = fullCount, base = 0;
    for (const piece of pieces) {
      const source = piece.geometry.index.array;
      for (let i = 0; i < source.length; i++) index[offset + i] = source[i] + base;
      if (hasDistantIndices) {
        const distant = (piece.farIndex || piece.geometry.index).array;
        for (let i = 0; i < distant.length; i++) index[farOffset + i] = distant[i] + base;
        farOffset += distant.length;
      }
      offset += source.length; base += piece.geometry.attributes.position.count;
      if (!piece.upper) {
        lowerCount = offset;
        farLowerCount = farOffset - fullCount;
      }
    }
    merged.setIndex(new THREE.BufferAttribute(index, 1));
    merged.setDrawRange(0, fullCount);
  } else {
    for (const piece of pieces) {
      fullCount += piece.geometry.attributes.position.count;
      if (!piece.upper) lowerCount = fullCount;
    }
  }
  for (const piece of pieces) piece.geometry.dispose();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return { geometry: merged, lowerCount, fullCount, farLowerCount, farCount, hasDistantIndices };
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
    const { geometry, ...ranges } = mergeBatch(batch.entries);
    const mesh = new THREE.Mesh(geometry, batch.material);
    mesh.name = 'crew-body-batch';
    mesh.castShadow = batch.template.castShadow; mesh.receiveShadow = batch.template.receiveShadow;
    mesh.frustumCulled = batch.template.frustumCulled; mesh.layers.mask = batch.template.layers.mask;
    mesh.matrixAutoUpdate = false;
    mesh.userData.crewRanges = ranges;
    for (const entry of batch.entries) entry.mesh.removeFromParent();
    // A batch can consist entirely of small fittings. Give its detail level
    // separate visibility so cockpit and cosmetic visibility remain independent.
    if (ranges.hasDistantIndices && (!ranges.farCount || (ranges.lowerCount && !ranges.farLowerCount))) {
      const level = new THREE.Group();
      level.name = 'crew-detail';
      level.matrixAutoUpdate = false;
      carrier.add(level);
      level.add(mesh);
    } else carrier.add(mesh);
    meshes.push(mesh);
  }
  // The rigid joints never move again: their local matrices are final.
  for (const root of [...lower, ...upper]) root.traverse(object => {
    if (object.isMesh || object.isSprite) return;
    object.updateMatrix();
    object.matrixAutoUpdate = false;
  });
  let showUpper = true, distant = false;
  function setRanges() {
    for (const mesh of meshes) {
      const range = mesh.userData.crewRanges;
      const far = distant && range.hasDistantIndices;
      const count = far ? (showUpper ? range.farCount : range.farLowerCount)
        : (showUpper ? range.fullCount : range.lowerCount);
      mesh.geometry.setDrawRange(far ? range.fullCount : 0, count);
      if (mesh.parent !== carrier) mesh.parent.visible = count > 0;
    }
  }
  const handle = {
    meshes,
    hasDistantIndices: meshes.some(mesh => mesh.userData.crewRanges.hasDistantIndices),
    /** First person hides the head and chest: each batch keeps its lower-body prefix. */
    setUpperVisible(visible) {
      showUpper = visible;
      for (const mesh of meshes) {
        if (!mesh.userData.crewRanges.lowerCount) mesh.visible = visible;
      }
      setRanges();
    },
    setDistant(value) {
      distant = value;
      setRanges();
    },
  };
  avatar.crewBatch = handle;
  if (avatar.group.updateCharacterDetail) bindRivetDetail(avatar);
  return handle;
}
