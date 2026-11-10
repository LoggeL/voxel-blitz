import * as THREE from '../../vendor/three.module.js';
import { COL } from '../kit.js';
import { BOLT_HOME, BREACH_Z, TRIGGER_Z } from './common.js';
import { buildBlenderVanguard } from './vanguard-blender.js';

// KV-9 VANGUARD: semi-auto precision battle rifle (docs/design/vanguard/).
// Blender-authored rounded AR-10 DMR is the primary; this DOM-free procedural
// fallback mirrors its silhouette for offline/test rigs.
const SIGHT_Y = 0.150;
const GRAPHITE = 0x2e3236;
const EARTH = 0x4a443c;
const STEEL = 0xb8c0c8;
const BLUE = 0x9fd0ff;

export function build({ kit, T, groups }) {
  if (buildBlenderVanguard(groups, kit, T)) return true;
  const { box, cylZ, mat } = kit;
  const { body, mag, bolt, trigger } = groups;
  const [mx, axisY, mz] = T.muzzle;
  const breach = BREACH_Z.vanguard;
  const graph = mat(GRAPHITE, 0.55, 0.6);
  const earth = mat(EARTH, 0.85, 0.0);
  const steel = mat(STEEL, 0.35, 0.9);
  const black = mat(0x1a1d20, 0.7, 0.2);
  const blue = mat(BLUE, 0.4, 0.3);
  // Receiver + rounded handguard + barrel; bore lands exactly at T.muzzle.
  box(body, 0.052, 0.062, 0.34, 0, 0.01, 0.03, graph);
  box(body, 0.048, 0.052, 0.20, 0, 0.015, -0.32, earth);
  cylZ(body, 0.014, breach - mz, 0, axisY, (breach + mz) / 2, steel);
  cylZ(body, 0.026, 0.09, 0, axisY, mz + 0.045, black); // suppressor
  box(body, 0.012, 0.012, 0.06, 0, axisY + 0.012, -0.10, steel); // piston block
  // Stock, grip, rail.
  box(body, 0.044, 0.070, 0.16, 0, -0.02, 0.24, earth);
  box(body, 0.036, 0.05, 0.10, 0, 0.06, 0.24, black); // cheek riser
  box(body, 0.034, 0.085, 0.035, 0, -0.035, 0.10, earth); // pistol grip angled
  box(body, 0.020, 0.008, 0.30, 0, 0.048, -0.02, black); // top rail
  // LPVO optic block at sight height.
  cylZ(body, 0.017, 0.11, 0, SIGHT_Y, -0.02, black);
  box(body, 0.030, 0.018, 0.05, 0, SIGHT_Y - 0.022, -0.02, black);
  box(body, 0.012, 0.008, 0.012, 0, SIGHT_Y - 0.008, -0.085, steel); // rear post
  box(body, 0.004, 0.010, 0.002, 0, SIGHT_Y - 0.010, -0.085, steel); // front blade
  // Bolt carrier + charging handle on the reciprocating group.
  box(bolt, 0.030, 0.034, 0.10, 0, 0.02, BOLT_HOME.vanguard + 0.04, steel);
  cylZ(bolt, 0.008, 0.03, 0, 0.05, BOLT_HOME.vanguard - 0.01, black);
  // Curved 20-round magazine.
  box(mag, 0.040, 0.150, 0.070, 0, -0.075, 0.02, graph);
  box(mag, 0.044, 0.016, 0.074, 0, -0.155, 0.03, black);
  box(mag, 0.020, 0.010, 0.040, 0, -0.090, 0.02, blue);
  // Trigger group.
  box(trigger, 0.030, 0.010, 0.050, 0, -0.028, TRIGGER_Z.vanguard, black);
  box(trigger, 0.006, 0.020, 0.008, 0, -0.042, TRIGGER_Z.vanguard, steel);
  return true;
}
