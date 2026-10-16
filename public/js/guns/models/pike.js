import { createBlenderParts } from '../../engine/blender-assets.js';

// PIKE supplies the CL-9 VOLTLANCE. The Blender template owns every rigid form,
// including the rail optic (rear aperture + glowing front post) and the violet
// arc-glow emissive, so the builder only places parts and the sight line.
export function buildPike({ groups }) {
  // The dedicated local/remote induction drive owns these cloned materials.
  // Shared templates and other carriers keep their own charge state.
  const parts = createBlenderParts('pike', { materialFor: (original) => {
    const clone = original.clone();
    if (clone.userData.cosmeticGlow) clone.userData.voltlanceGlow = { role: 'housing' };
    return clone;
  } });
  if (!parts) return false;
  for (const key of ['body', 'mag', 'bolt', 'trigger']) groups[key].add(...parts[key].children);
  groups.body.add(parts['factory-optic']);
  groups.body.userData.blenderAsset = 'pike';
  groups.body.userData.sightHeight = 0.155;
  return true;
}
