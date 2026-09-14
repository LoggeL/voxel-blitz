import * as THREE from '../../vendor/three.module.js';
import { createBlenderParts } from '../../engine/blender-assets.js';
import { COL } from '../kit.js';
import { PUMP_REST } from './common.js';

// MASTIFF supplies the M-DOCK 12. The Blender template owns every rigid form;
// only the parts the game animates are pulled out of it. The side-saddle
// Shell 1 donates its textured geometry to the single tube-reload shell.
export function buildMastiff({ kit, groups }) {
  const parts = createBlenderParts('mastiff');
  if (!parts) return false;
  for (const key of ['body', 'mag', 'bolt', 'trigger']) groups[key].add(...parts[key].children);

  // Baked pump verts sit at game-space PUMP_REST, but the runtime carries that
  // offset on the pump group itself, so normalize children to group-local.
  for (const child of parts.pump.children) child.position.sub(PUMP_REST);
  groups.pump.add(...parts.pump.children);

  // The loader sanitizes node names to underscores, so the side-saddle shells
  // arrive as Shell_1 / Shell_1_base… already placed at their authored saddle
  // translations. They stay visible as static spares; the reload shell below
  // clones the first pair into the Z-lying tube choreography pose.
  const saddle = parts.extra.children.filter((mesh) => /shell/i.test(mesh.name));
  for (const mesh of saddle) groups.extra.add(mesh);
  const shellBody = saddle.filter((mesh) => /^shell_1(_\d+)?$/i.test(mesh.name));
  const shellBase = saddle.filter((mesh) => /^shell_1_base(_\d+)?$/i.test(mesh.name));
  let reloadShell;
  if (shellBody.length && shellBase.length) {
    reloadShell = new THREE.Group();
    reloadShell.name = 'shotgun_reload_shell';
    const inner = new THREE.Group();
    for (const mesh of [...shellBody, ...shellBase]) {
      const clone = mesh.clone(true);
      clone.position.set(0, 0, 0);
      clone.rotation.set(0, 0, 0);
      clone.scale.set(1, 1, 1);
      inner.add(clone);
    }
    // Authored side-saddle shells stand along +Y with brass up; the tube
    // choreography carries a Z-lying shell with brass forward.
    inner.rotation.x = Math.PI / 2;
    reloadShell.add(inner);
    reloadShell.updateMatrixWorld(true);
    const center = new THREE.Box3().setFromObject(inner).getCenter(new THREE.Vector3());
    inner.position.sub(center);
  } else {
    // Authored shells missing: mirror the procedural reload shell exactly.
    const { cylZ } = kit;
    reloadShell = new THREE.Group();
    reloadShell.name = 'shotgun_reload_shell';
    cylZ(reloadShell, 0.012, 0.050, 0, 0, 0, 0xb34225, { seg: 8 });
    cylZ(reloadShell, 0.013, 0.014, 0, 0, 0.025, COL.brass, { seg: 8 });
  }
  reloadShell.visible = false;
  reloadShell.userData.homePosition = reloadShell.position.clone();
  groups.extra.add(reloadShell);
  groups.extra.userData.reloadRounds = reloadShell;

  groups.body.userData.blenderAsset = 'mastiff';
  groups.body.userData.sightHeight = 0.10;
  return true;
}
