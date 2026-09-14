import { createBlenderParts } from '../../engine/blender-assets.js';

// IFRIT supplies the F-4 FIRESTORM. The Blender template owns every rigid
// form; only the per-rig pilot-flame flag stays here so the heavy-weapon rig
// keeps driving its flicker. The transverse fuel tank still owns `mag`, and
// `extra` ships empty, exactly like the procedural build.
export function buildIfrit({ groups }) {
  const parts = createBlenderParts('ifrit');
  if (!parts) return false;
  for (const key of ['body', 'mag', 'bolt', 'trigger']) groups[key].add(...parts[key].children);
  // The pilot flame ships as its own unmapped emissive material; flag the
  // per-rig clone (materials are cloned per rig) so animateHeavyWeapon()
  // collects it into its pilot set.
  groups.body.traverse(object => {
    const material = object.material;
    if (!material || material.name !== 'IFRIT | pilot light') return;
    material.userData.pilot = true;
  });
  groups.body.userData.blenderAsset = 'ifrit';
  groups.body.userData.sightHeight = 0.158;
  return true;
}
