import * as THREE from '../../vendor/three.module.js';
import { createBlenderParts } from '../../engine/blender-assets.js';
import { disposeObjectTrees } from '../../engine/dispose.js';

// HYDRA supplies the M-6 FURNACE minigun. Blender exports the six barrels and
// their collars separately in gun coordinates. The runtime owns the bore-axis
// joint and thermal materials; the magazine group owns the drum and feed belt.
const SIGHT_HEIGHT = 0.155;
const BORE_Y = 0.055;

export function buildHydra({ T, groups }) {
  const parts = createBlenderParts('hydra');
  if (!parts) return false;
  // A stale template without articulated barrels must use the complete
  // procedural fallback, never silently install an empty spinning group.
  const barrels = parts.extra?.children.filter(mesh => mesh.userData.rotorKind === 'barrel') || [];
  if (barrels.length !== 6) {
    disposeObjectTrees(Object.values(parts));
    return false;
  }
  for (const key of ['body', 'mag', 'bolt', 'trigger']) groups[key].add(...parts[key].children);

  const rotor = new THREE.Group();
  rotor.name = 'minigun_rotor';
  rotor.position.y = T?.muzzle?.[1] ?? BORE_Y;
  groups.body.add(rotor);
  for (const mesh of [...parts.extra.children]) {
    if (mesh.userData.role === 'rotor') {
      // createBlenderParts flattens the template into gun coordinates. Move
      // that geometry into the joint's local frame without changing its pose.
      mesh.position.sub(rotor.position);
      rotor.add(mesh);
      if (mesh.userData.rotorKind === 'barrel') {
        for (const material of [].concat(mesh.material)) material.userData.thermal = true;
      }
    } else if (mesh.userData.role === 'heatIndicator') {
      const threshold = mesh.userData.heatThreshold;
      mesh.name = `minigun_heat_indicator_${Math.round(threshold * 5) - 1}`;
      // All cells use one exported palette material; each threshold needs its
      // own instance so both cells and different players heat independently.
      mesh.material = mesh.material.clone();
      mesh.material.userData.heatIndicator = threshold;
      mesh.material.emissiveIntensity = 0.08;
      groups.body.add(mesh);
    } else {
      groups.extra.add(mesh);
    }
  }

  groups.body.userData.blenderAsset = 'hydra';
  groups.body.userData.sightHeight = SIGHT_HEIGHT;
  return true;
}
