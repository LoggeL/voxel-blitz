import * as THREE from '../../vendor/three.module.js';
import { createBlenderParts } from '../../engine/blender-assets.js';
import { COL, GLOW_ACCENT } from '../kit.js';
import { BREACH_Z } from './common.js';

// TORCH owns the RX-8 HAVOC skin. The Blender template owns every rigid form;
// only the parts the game animates are pulled out of it. The breech venturi
// ships hinge-relative under `extra` and swings on the reload pivot; the reload
// rocket itself never ships (no loose rounds in the asset) and is respawned
// procedurally, exactly like the fallback it replaces.
export function buildTorch({ kit, T, groups }) {
  const parts = createBlenderParts('torch');
  if (!parts) return false;
  for (const key of ['body', 'mag', 'bolt', 'trigger']) groups[key].add(...parts[key].children);

  // Breech gate: the authored venturi pivots at the bore-axis height, 0.16 m
  // ahead of the rocket breech — the same hinge the procedural gate uses, so the
  // reload swing matches the fallback frame for frame.
  const rearZ = BREACH_Z.rocket + 0.16;
  const hinge = new THREE.Vector3(T.muzzle[0], T.muzzle[1], rearZ);
  const gate = new THREE.Group();
  gate.name = 'rocket_rear_breech';
  gate.position.copy(hinge);
  // Gate leaves arrive carrying their authored node translation; normalize to
  // hinge-local so the slide-and-swing pivot owns the only offset.
  for (const child of [...parts.extra.children]) child.position.sub(hinge);
  gate.add(...parts.extra.children);
  groups.extra.add(gate);
  groups.extra.userData.reloadPart = gate;
  groups.extra.userData.rocketReload = { gate, axisY: T.muzzle[1], rearZ };

  // Reload rocket: no authored round exists, so rebuild the procedural round
  // verbatim — the insertion timeline in actions.js drives it by name and shape.
  const { box, cylZ } = kit;
  const ORANGE = GLOW_ACCENT.rocket;
  const reloadRound = new THREE.Group();
  reloadRound.name = 'rocket_reload_round';
  cylZ(reloadRound, 0.039, 0.28, 0, 0, 0, COL.olive, { seg: 10 });
  cylZ(reloadRound, 0.046, 0.11, 0, 0, -0.19, ORANGE, { seg: 10, rTop: 0.005, rBot: 0.046 });
  cylZ(reloadRound, 0.042, 0.02, 0, 0, 0.14, COL.steel, { seg: 10 });
  for (const side of [-1, 1]) {
    box(reloadRound, 0.017, 0.074, 0.065, side * 0.038, 0, 0.11, COL.gunmetal);
    box(reloadRound, 0.074, 0.017, 0.065, 0, side * 0.038, 0.11, COL.gunmetal);
  }
  reloadRound.visible = false;
  reloadRound.userData.homePosition = reloadRound.position.clone();
  groups.extra.add(reloadRound);
  groups.extra.userData.reloadRounds = reloadRound;

  groups.body.userData.blenderAsset = 'torch';
  groups.body.userData.sightHeight = 0.175;
  return true;
}
