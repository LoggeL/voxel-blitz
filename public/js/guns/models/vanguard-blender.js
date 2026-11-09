import { createBlenderParts } from '../../engine/blender-assets.js';
import { disposeObjectTrees } from '../../engine/dispose.js';

const REQUIRED = ['body', 'bolt', 'trigger', 'mag', 'optic'];

/** The exporter bakes Blender geometry into gun space. Convert articulated
 * parts to their joints once; templates and shared texture maps stay immutable. */
export function buildBlenderVanguard(groups, kit, T, P) {
  const parts = createBlenderParts('vanguard');
  if (!parts) return false;
  if (REQUIRED.some(name => !parts[name]?.children.length)) {
    disposeObjectTrees(Object.values(parts));
    return false;
  }

  for (const name of ['body', 'bolt', 'trigger', 'mag']) groups[name].add(...parts[name].children);
  const optic = parts.optic;
  optic.name = 'factory-optic';
  (groups.optic ?? groups.body).add(optic);
  groups.body.userData.blenderAsset = 'vanguard';
  groups.body.userData.displayMount = P;
  groups.body.userData.sightHeight = 0.15;
  return true;
}
