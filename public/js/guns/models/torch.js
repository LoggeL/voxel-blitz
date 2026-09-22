import * as THREE from '../../vendor/three.module.js';
import { createBlenderParts } from '../../engine/blender-assets.js';
import { COL, GLOW_ACCENT } from '../kit.js';
import { BREACH_Z } from './common.js';

// TORCH owns the RX-8 HAVOC skin. The Blender template owns every rigid form;
// only the parts the game animates are pulled out of it. The breech venturi
// ships hinge-relative under `extra` and swings open sideways on a vertical
// pin on the left flank (Carl Gustaf M3 breech); the reload rocket itself never
// ships (no loose rounds in the asset) and is respawned procedurally, exactly
// like the fallback it replaces.
export const ROCKET_GATE_SWING = 1.75;   // rad about game +y; the sweep is audited in build-torch.py

export function buildTorch({ kit, T, groups }) {
  const parts = createBlenderParts('torch');
  if (!parts) return false;
  for (const key of ['body', 'mag', 'bolt', 'trigger']) groups[key].add(...parts[key].children);

  // Breech gate: the gate leaves arrive carrying the authored hinge as their
  // node translation (torch.gltf is the single source of truth for the pin:
  // game (-0.104, 0.075, -0.135)). The pin is vertical at bore-axis height, so
  // the venturi swings clear of the bore and the round path along the axis
  // (rearZ = BREACH_Z.rocket + 0.16, the gate zone's rear reference) is untouched.
  const leaves = [...parts.extra.children];
  const hinge = leaves[0].position.clone();
  if (Math.abs(hinge.y - T.muzzle[1]) > 1e-6) {
    console.warn(`[vb] TORCH gate hinge y ${hinge.y} is off the bore axis ${T.muzzle[1]}`);
  }
  const rearZ = BREACH_Z.rocket + 0.16;
  const gate = new THREE.Group();
  gate.name = 'rocket_rear_breech';
  gate.position.copy(hinge);
  // Normalize the leaves to hinge-local so the swing pivot owns the only offset.
  for (const child of leaves) child.position.sub(hinge);
  gate.add(...leaves);
  groups.extra.add(gate);
  groups.extra.userData.reloadPart = gate;
  groups.extra.userData.rocketReload = { gate, axisY: T.muzzle[1], rearZ, swing: ROCKET_GATE_SWING, hinge };

  // Reload rocket: no authored round exists, so rebuild the procedural round
  // verbatim — the insertion timeline in actions.js drives it by name and shape.
  const { box, cylZ } = kit;
  const ORANGE = GLOW_ACCENT.rocket;
  const reloadRound = new THREE.Group();
  reloadRound.name = 'rocket_reload_round';
  cylZ(reloadRound, 0.039, 0.28, 0, 0, 0, COL.olive, { seg: 10 });
  cylZ(reloadRound, 0.046, 0.11, 0, 0, -0.19, ORANGE, { seg: 10, rTop: 0.005, rBot: 0.046 });
  cylZ(reloadRound, 0.042, 0.02, 0, 0, 0.14, COL.steel, { seg: 10 });
  // Fins trimmed to clear the tube-mouth lip on the way in: corner radius
  // 0.0524 < lip 0.0555 (the swept-volume audit's fins-vs-mouth graze).
  for (const side of [-1, 1]) {
    box(reloadRound, 0.015, 0.065, 0.065, side * 0.0335, 0, 0.11, COL.gunmetal);
    box(reloadRound, 0.065, 0.015, 0.065, 0, side * 0.0335, 0.11, COL.gunmetal);
  }
  reloadRound.visible = false;
  reloadRound.userData.homePosition = reloadRound.position.clone();
  groups.extra.add(reloadRound);
  groups.extra.userData.reloadRounds = reloadRound;

  groups.body.userData.blenderAsset = 'torch';
  groups.body.userData.sightHeight = 0.175;
  return true;
}
