import { buildTorch } from './torch.js';

/** Build the RX-8 HAVOC from the TORCH Blender asset. The old procedural
 *  silhouette is gone: when the asset is unavailable (headless Node simulation,
 *  failed fetch) the slot builds nothing and warns. The muzzle marker, flash,
 *  heat sleeve and gloves are anchor-driven in assemble.js and still attach. */
export function build({ kit, T, groups }) {
  if (buildTorch({ kit, T, groups })) return true;
  console.warn('[vb] TORCH Blender asset unavailable; rocket slot builds nothing');
  return false;
}
