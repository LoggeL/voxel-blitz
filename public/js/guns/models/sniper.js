import { buildPeregrine } from './peregrine.js';

/** Build the LONGSHOT MK-II from the PEREGRINE Blender asset. The old procedural
 *  silhouette is gone: when the asset is unavailable (headless Node simulation,
 *  failed fetch) the slot builds nothing and warns. The muzzle marker, flash,
 *  heat sleeve and gloves are anchor-driven in assemble.js and still attach. */
export function build({ groups }) {
  if (buildPeregrine({ groups })) return true;
  console.warn('[vb] PEREGRINE Blender asset unavailable; sniper slot builds nothing');
  return false;
}
