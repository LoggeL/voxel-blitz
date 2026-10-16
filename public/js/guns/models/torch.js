import * as THREE from '../../vendor/three.module.js';
import { createBlenderParts } from '../../engine/blender-assets.js';
import { COL, GLOW_ACCENT } from '../kit.js';
import { BREACH_Z } from './common.js';

// TORCH owns the RX-8 HAVOC skin. The Blender template owns every rigid form;
// only the parts the game animates are pulled out of it. The breech venturi
// ships hinge-relative under `extra` and swings open sideways on a vertical
// pin on the left flank (Carl Gustaf M3 breech). The sculpted fin-stabilized
// rocket round ships seat-relative under `extra` (`round | <mat>`); one copy
// lives in `rocket_chambered_round` at `ROCKET_SEAT` and a clone in
// `rocket_reload_round` is driven along the insertion path by `actions.js`.
export const ROCKET_GATE_SWING = 1.75;   // rad about game +y; the sweep is audited in build-torch.py
export const ROCKET_HINGE = new THREE.Vector3(-0.104, 0.075, -0.135);
export const ROCKET_SEAT = new THREE.Vector3(0, 0.075, -0.55);

const GATE_LEAF = /^gate(?:\b|[ _|])/i;
const ROUND_LEAF = /^round(?:\b|[ _|])/i;
const IVORY = 0xd6d2c4;

/**
 * Sculpted fin-stabilized HAVOC round (nose tip at z = -0.245, ivory/orange
 * ogive warhead, olive motor cylinder, steel tail nozzle at z = +0.150, and
 * 4 swept gunmetal fins within radius 0.052) used when Blender `round | ...`
 * meshes are unavailable (or in headless Node fallback).
 */
export function buildProceduralRocketRound(kit, name = 'rocket_reload_round') {
  const { box, cylZ } = kit;
  const ORANGE = GLOW_ACCENT.rocket;
  const group = new THREE.Group();
  group.name = name;
  // Motor tube: z in [-0.080, +0.130] (length 0.210, center +0.025)
  cylZ(group, 0.039, 0.21, 0, 0, 0.025, COL.olive, { seg: 10 });
  // Ivory warhead shoulder: z in [-0.140, -0.080] (length 0.060, center -0.110)
  cylZ(group, 0.045, 0.06, 0, 0, -0.11, IVORY, { seg: 10 });
  // Hazard orange band: z in [-0.165, -0.140] (length 0.025, center -0.1525)
  cylZ(group, 0.046, 0.025, 0, 0, -0.1525, ORANGE, { seg: 10 });
  // Ogive nose cone: z in [-0.235, -0.165] (length 0.070, center -0.200)
  cylZ(group, 0.046, 0.07, 0, 0, -0.20, IVORY, { seg: 10, rTop: 0.046, rBot: 0.012 });
  // Piezo fuze tip reaching z = -0.245 (z in [-0.245, -0.235], length 0.010, center -0.240)
  cylZ(group, 0.012, 0.01, 0, 0, -0.24, COL.gunmetal, { seg: 10, rTop: 0.012, rBot: 0.005 });
  // Steel tail nozzle reaching z = +0.150 (z in [+0.130, +0.150], length 0.020, center +0.140)
  cylZ(group, 0.042, 0.02, 0, 0, 0.14, COL.steel, { seg: 10 });
  // 4 swept gunmetal fins within radius 0.052 (clearing the 0.0555 inner bore)
  for (const side of [-1, 1]) {
    box(group, 0.008, 0.050, 0.060, side * 0.026, 0, 0.11, COL.gunmetal);
    box(group, 0.050, 0.008, 0.060, 0, side * 0.026, 0.11, COL.gunmetal);
  }
  return group;
}

export function buildTorch({ kit, T, groups }) {
  const parts = createBlenderParts('torch');
  const rearZ = BREACH_Z.rocket + 0.16;

  if (!parts) {
    const hinge = ROCKET_HINGE.clone();
    const seat = ROCKET_SEAT.clone();
    const gate = new THREE.Group();
    gate.name = 'rocket_rear_breech';
    gate.position.copy(hinge);
    groups.extra.add(gate);

    const chambered = buildProceduralRocketRound(kit, 'rocket_chambered_round');
    chambered.position.copy(seat);
    groups.extra.add(chambered);

    const round = buildProceduralRocketRound(kit, 'rocket_reload_round');
    round.position.set(0, 0, 0);
    round.userData.homePosition = new THREE.Vector3();
    round.visible = false;
    groups.extra.add(round);

    groups.body.userData.sightHeight = 0.175;
    groups.extra.userData.reloadPart = gate;
    groups.extra.userData.reloadRounds = round;
    groups.extra.userData.rocketReload = {
      gate,
      chambered,
      round,
      axisY: T.muzzle[1],
      rearZ,
      swing: ROCKET_GATE_SWING,
      hinge,
      seat,
      authoritativeMag: 1,
      reloading: false,
      seated: false,
    };
    return false;
  }

  for (const key of ['body', 'mag', 'bolt', 'trigger']) groups[key].add(...parts[key].children);

  // Breech gate: the gate leaves arrive carrying the authored hinge as their
  // node translation (torch.gltf is the single source of truth for the pin:
  // game (-0.104, 0.075, -0.135)). The pin is vertical at bore-axis height, so
  // the venturi swings clear of the bore and the round path along the axis
  // (rearZ = BREACH_Z.rocket + 0.16, the gate zone's rear reference) is untouched.
  const extraChildren = [...parts.extra.children];
  const gateLeaves = extraChildren.filter((child) => GATE_LEAF.test(child.name));
  const roundLeaves = extraChildren.filter((child) => ROUND_LEAF.test(child.name));
  // Backwards-compatible fallback if an older template didn't prefix gate leaves
  const leaves = gateLeaves.length ? gateLeaves : extraChildren.filter((child) => !ROUND_LEAF.test(child.name));

  const hinge = leaves.length ? leaves[0].position.clone() : ROCKET_HINGE.clone();
  if (Math.abs(hinge.y - T.muzzle[1]) > 1e-6) {
    console.warn(`[vb] TORCH gate hinge y ${hinge.y} is off the bore axis ${T.muzzle[1]}`);
  }
  const gate = new THREE.Group();
  gate.name = 'rocket_rear_breech';
  gate.position.copy(hinge);
  // Normalize the leaves to hinge-local so the swing pivot owns the only offset.
  for (const child of leaves) child.position.sub(hinge);
  gate.add(...leaves);
  groups.extra.add(gate);

  let seat = ROCKET_SEAT.clone();
  let chambered;
  let round;
  if (roundLeaves.length) {
    seat = roundLeaves[0].position.clone();
    chambered = new THREE.Group();
    chambered.name = 'rocket_chambered_round';
    chambered.position.copy(seat);
    round = new THREE.Group();
    round.name = 'rocket_reload_round';
    const clonedMaterials = new Map();
    const cloneMat = (mat) => {
      if (!mat) return mat;
      if (!clonedMaterials.has(mat)) clonedMaterials.set(mat, mat.clone());
      return clonedMaterials.get(mat);
    };
    for (const leaf of roundLeaves) {
      leaf.position.sub(seat);
      chambered.add(leaf);
      const cloned = leaf.clone(false);
      cloned.material = Array.isArray(leaf.material) ? leaf.material.map(cloneMat) : cloneMat(leaf.material);
      round.add(cloned);
    }
  } else {
    chambered = buildProceduralRocketRound(kit, 'rocket_chambered_round');
    chambered.position.copy(seat);
    round = buildProceduralRocketRound(kit, 'rocket_reload_round');
  }
  round.position.set(0, 0, 0);
  round.userData.homePosition = new THREE.Vector3();
  round.visible = false;
  groups.extra.add(chambered, round);

  groups.extra.userData.reloadPart = gate;
  groups.extra.userData.reloadRounds = round;
  groups.extra.userData.rocketReload = {
    gate,
    chambered,
    round,
    axisY: T.muzzle[1],
    rearZ,
    swing: ROCKET_GATE_SWING,
    hinge,
    seat,
    authoritativeMag: 1,
    reloading: false,
    seated: false,
  };

  groups.body.userData.blenderAsset = 'torch';
  groups.body.userData.sightHeight = 0.175;
  return true;
}
