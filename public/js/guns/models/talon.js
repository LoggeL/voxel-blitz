import { createBlenderParts } from '../../engine/blender-assets.js';

export function buildTalon({ groups }) {
  const parts = createBlenderParts('talon');
  if (!parts) return false;
  groups.body.add(...parts.body.children);
  groups.body.userData.blenderAsset = 'talon';
  groups.body.userData.sightHeight = 0.02;
  return true;
}
