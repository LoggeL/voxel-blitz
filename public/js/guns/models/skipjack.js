import { createBlenderParts } from '../../engine/blender-assets.js';

// GL-3 SKIPJACK is authored as five rigid runtime parts. The three live rounds
// travel with the under-slung cassette (`mag`), while the charging pawl remains
// a small independent bolt so firing and reload motion stay inside the normal
// viewmodel contract.
export function buildSkipjack({ groups }) {
  const parts = createBlenderParts('skipjack');
  if (!parts) return false;

  for (const key of ['body', 'mag', 'bolt', 'trigger', 'extra']) {
    if (parts[key]) groups[key].add(...parts[key].children);
  }

  groups.body.userData.blenderAsset = 'skipjack';
  groups.body.userData.sightHeight = 0.291;
  groups.mag.userData.cassette = true;
  return true;
}
