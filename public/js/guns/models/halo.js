import { createBlenderParts } from '../../engine/blender-assets.js';

// HALO owns the LN-03 LONGARC's rigid forms: twin copper rails, three emissive
// cyan capacitor coils, vented shroud and the factory iron sight (its front
// dot glows via the authored `coil glow` emission material, so no procedural
// sight bit is needed). The longarc reload swaps the battery cell, so `extra`
// stays under the choreography's ownership, untouched here.
export function buildHalo({ groups }) {
  const parts = createBlenderParts('halo');
  if (!parts) return false;
  for (const key of ['body', 'mag', 'bolt', 'trigger']) groups[key].add(...parts[key].children);
  groups.body.add(parts['factory-optic']);
  groups.body.userData.blenderAsset = 'halo';
  groups.body.userData.sightHeight = 0.155;
  return true;
}
