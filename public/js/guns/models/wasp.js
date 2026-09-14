import { createBlenderParts } from '../../engine/blender-assets.js';

// WASP supplies the SMG. The Blender template owns every rigid form, including
// the micro reflex sight glass on the body; the slot is `mag`-type, so `extra`
// stays empty and no rounds are wired even if any exist.
export function buildWasp({ groups }) {
  const parts = createBlenderParts('wasp');
  if (!parts) return false;
  for (const key of ['body', 'mag', 'bolt', 'trigger']) groups[key].add(...parts[key].children);
  groups.body.userData.blenderAsset = 'wasp';
  groups.body.userData.sightHeight = 0.112;
  return true;
}
