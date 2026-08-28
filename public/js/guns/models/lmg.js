import * as THREE from '../../vendor/three.module.js';
import { COL } from '../kit.js';
import { BREACH_Z, BOLT_HOME, TRIGGER_Z } from './common.js';

export function build({ kit, T, groups }) {
  const { box, cylZ, brakeRings, ironSights } = kit;
  const { body: b, mag: mg, bolt, trigger: tg, extra } = groups;

  box(b, 0.11, 0.135, 0.39, 0, 0.025, -0.205, COL.parkerized);                  // broad receiver
  box(b, 0.09, 0.105, 0.20, 0, -0.005, 0.075, COL.olive);                      // full shoulder stock
  box(b, 0.07, 0.095, 0.045, 0, -0.005, 0.185, COL.polymer);                   // rubber butt pad
  box(b, 0.055, 0.105, 0.065, 0.005, -0.085, -0.045, COL.polymer, { rx: 0.30 }); // grip
  box(b, 0.105, 0.055, 0.27, 0, 0.015, -0.40, COL.olive);                      // heavy heat shield
  for (let i = 0; i < 5; i++) {
    [-1, 1].forEach((s) => box(b, 0.012, 0.018, 0.045, s * 0.050, 0.018, -0.30 - i * 0.050,
      COL.fluteDark));                                                           // vented shield ribs
  }

  const bx = T.muzzle[0], by = T.muzzle[1];
  const len = Math.abs(T.muzzle[2] - BREACH_Z.lmg);
  cylZ(b, 0.027, len, bx, by, (T.muzzle[2] + BREACH_Z.lmg) / 2, COL.gunmetal, { seg: 12 });
  cylZ(b, 0.036, 0.055, bx, by, T.muzzle[2] + 0.045, COL.parkerized, { seg: 12 }); // gas block
  brakeRings(b, 0.039, bx, by, T.muzzle[2], 2, 0.009, 0.015);
  cylZ(b, 0.029, 0.012, bx, by, T.muzzle[2] + 0.006, COL.brake);
  box(b, 0.006, 0.038, 0.020, bx, by + 0.032, T.muzzle[2] + 0.035, COL.amber);    // tall front blade

  // The folded carry handle stays off the bore axis so it cannot occlude ADS.
  box(b, 0.018, 0.090, 0.024, 0.025, 0.128, -0.31, COL.polyDark, { rz: -0.28 });
  box(b, 0.018, 0.090, 0.024, 0.090, 0.128, -0.31, COL.polyDark, { rz: 0.28 });
  box(b, 0.082, 0.020, 0.14, 0.058, 0.172, -0.31, COL.polymer);
  box(b, 0.066, 0.009, 0.11, 0.058, 0.183, -0.31, COL.tan);
  ironSights(b, { rearZ: 0.070, frontZ: -0.655, height: 0.155, width: 0.052 });

  // Detachable belt box and visible brass feed run.
  box(mg, 0.13, 0.15, 0.18, -0.038, -0.125, -0.18, COL.olive);
  box(mg, 0.134, 0.018, 0.184, -0.038, -0.050, -0.18, COL.polyDark);
  [-0.095, -0.050, -0.005].forEach((x, i) => {
    cylZ(b, 0.010, 0.045, x, 0.075 - i * 0.010, -0.205, COL.brass, { seg: 8 });
    box(b, 0.021, 0.006, 0.050, x, 0.071 - i * 0.010, -0.205, COL.polyDark);
  });

  const cover = new THREE.Group();
  cover.name = 'belt_cover';
  box(cover, 0.112, 0.022, 0.28, 0, 0.103, -0.24, COL.gunmetal);
  box(cover, 0.070, 0.010, 0.18, 0, 0.118, -0.24, COL.amber);
  extra.add(cover);
  extra.userData.reloadPart = cover;

  box(bolt, 0.052, 0.035, 0.075, -0.055, 0.080, BOLT_HOME.lmg, COL.gunmetal);
  box(bolt, 0.025, 0.018, 0.052, -0.082, 0.082, BOLT_HOME.lmg + 0.025, COL.amber);
  box(tg, 0.010, 0.032, 0.010, 0, -0.020, TRIGGER_Z.lmg, COL.amber);
  box(tg, 0.036, 0.007, 0.055, 0, -0.048, TRIGGER_Z.lmg, COL.polyDark);
}
