import * as THREE from '../vendor/three.module.js';

// Both index sets reference the same position, normal, material UV and color buffers.
const distantGeometry = new WeakMap();
const torsoPosition = new THREE.Vector3();

/** Resolve the secondary glTF accessors once for the page-owned Rivet template. */
export async function loadRivetDetail(gltf) {
  const jobs = new Map();
  gltf.scene.traverse(({ geometry }) => {
    const accessor = geometry?.userData.rivetFarIndices;
    if (!Number.isInteger(accessor) || jobs.has(geometry)) return;
    jobs.set(geometry, accessor < 0 ? null : gltf.parser.getDependency('accessor', accessor));
  });
  await Promise.all(Array.from(jobs, async ([near, index]) => {
    const far = new THREE.BufferGeometry();
    // A genuinely empty geometry is skipped before Three binds vertex buffers.
    // An empty index on a populated geometry would still issue a zero-length draw.
    if (index) {
      for (const [name, attribute] of Object.entries(near.attributes)) far.setAttribute(name, attribute);
      far.setIndex(await index);
    }
    far.boundingBox = near.boundingBox?.clone() || null;
    far.boundingSphere = near.boundingSphere?.clone() || null;
    far.userData.pageOwned = true;
    far.userData.distantOperator = true;
    distantGeometry.set(near, far);
  }));
}

export function farRivetGeometry(near) {
  return distantGeometry.get(near);
}

/** Rebind after a vehicle bakes its seated pose. Cosmetic overlays retain their own visibility. */
export function bindRivetDetail(avatar) {
  const meshes = [];
  for (const joint of [avatar.torso, avatar.head, avatar.hips, avatar.lLeg, avatar.rLeg, avatar.lArm, avatar.rArm]) {
    joint.traverse(mesh => {
      const far = distantGeometry.get(mesh.geometry);
      if (far) meshes.push({ mesh, near: mesh.geometry, far });
    });
  }
  if (!meshes.length && !avatar.crewBatch?.hasDistantIndices) return;

  let distant = false;
  avatar.group.updateCharacterDetail = view => {
    // A seated crew member inherits the vehicle transform. A corpse's torso
    // moves independently after limb physics bakes its root back to the origin.
    avatar.torso.getWorldPosition(torsoPosition);
    const matrix = avatar.torso.matrixWorld.elements;
    const scaleSquared = matrix[0] ** 2 + matrix[1] ** 2 + matrix[2] ** 2;
    const threshold = (distant ? 18 : 22) * view.focalScale;
    const next = torsoPosition.distanceToSquared(view.eye) > threshold * threshold * scaleSquared;
    if (next === distant) return;
    distant = next;
    for (const entry of meshes) entry.mesh.geometry = distant ? entry.far : entry.near;
    avatar.crewBatch?.setDistant(distant);
  };
}
