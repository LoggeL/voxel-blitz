import * as THREE from '../../vendor/three.module.js';
import { createBlenderParts } from '../../engine/blender-assets.js';

// HYDRA supplies the M-6 FURNACE minigun. The Blender template owns every rigid
// form: the feed tray is authored open with the belt ladder plugged in, so
// there is no separate cover to swing — the procedural feed box does not fit
// the authored receiver and only floated off its flank. The belt reload still
// drives the ammo drum and ladder in `mag`; no `reloadPart` is set (actions.js
// guards a missing cover). The barrel bundle itself is baked static into the
// body node, so the rotor carries no meshes — it preserves the lookup contract
// and the pivot for heavy-weapon-animation.js.
const SIGHT_HEIGHT = 0.155;
const BORE_Y = 0.055;

export function buildHydra({ kit, T, groups }) {
  const parts = createBlenderParts('hydra');
  if (!parts) return false;
  for (const key of ['body', 'mag', 'bolt', 'trigger']) groups[key].add(...parts[key].children);

  // Spin pivot on the bore axis. The authored bundle is static, so this group
  // is empty: the animation still finds and rotates it about the right axis.
  const rotor = new THREE.Group();
  rotor.name = 'minigun_rotor';
  rotor.position.y = T?.muzzle?.[1] ?? BORE_Y;
  groups.body.add(rotor);

  groups.body.userData.blenderAsset = 'hydra';
  groups.body.userData.sightHeight = SIGHT_HEIGHT;
  return true;
}
