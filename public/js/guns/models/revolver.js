import * as THREE from '../../vendor/three.module.js';
import { COL } from '../kit.js';
import { BREACH_Z, BOLT_HOME, TRIGGER_Z } from './common.js';

export function build({ kit, T, groups }) {
  const { box, cylZ, brakeRings } = kit;
  const { body: b, mag: mg, bolt, trigger: tg, extra } = groups;

  box(b, 0.066, 0.100, 0.20, 0, 0.020, -0.105, COL.gunmetal);                  // compact solid frame
  box(b, 0.054, 0.125, 0.070, 0, -0.080, -0.005, COL.walnut, { rx: 0.34 });    // compact grip
  box(b, 0.059, 0.016, 0.065, 0, -0.025, -0.015, COL.brass);                   // grip heel/backstrap
  box(b, 0.072, 0.025, 0.20, 0, -0.005, -0.275, COL.gunmetal);                // full underlug

  const bx = T.muzzle[0], by = T.muzzle[1];
  const len = Math.abs(T.muzzle[2] - BREACH_Z.revolver);
  cylZ(b, 0.017, len, bx, by, (T.muzzle[2] + BREACH_Z.revolver) / 2, COL.blued, { seg: 12 });
  box(b, 0.050, 0.018, len * 0.72, bx, by + 0.022, -0.34, COL.gunmetal);         // long sight rib
  brakeRings(b, 0.022, bx, by, T.muzzle[2], 1, 0.008, 0.012, COL.gunmetal);
  cylZ(b, 0.018, 0.010, bx, by, T.muzzle[2] + 0.005, COL.brake);
  box(b, 0.007, 0.024, 0.014, bx, by + 0.025, T.muzzle[2] + 0.028, COL.amber);  // front ramp

  // Swing-out six-shot cylinder lives in the mag group so reload and firing can rotate it.
  cylZ(mg, 0.050, 0.078, 0, 0.025, -0.145, COL.gunmetal, { seg: 12 });
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    cylZ(mg, 0.011, 0.081, Math.cos(a) * 0.031, 0.025 + Math.sin(a) * 0.031,
      -0.146, COL.fluteDark, { seg: 8 });
  }
  box(mg, 0.020, 0.020, 0.092, 0, 0.025, -0.144, COL.brass);                   // axle/ejector star
  box(b, 0.014, 0.020, 0.10, -0.055, 0.010, -0.13, COL.gunmetal);              // exposed crane

  // Cocking hammer is deliberately prominent; the bolt group drives its fire stroke.
  box(bolt, 0.042, 0.055, 0.022, 0, 0.092, BOLT_HOME.revolver, COL.gunmetal, { rx: -0.36 });
  box(bolt, 0.050, 0.012, 0.025, 0, 0.122, BOLT_HOME.revolver + 0.012, COL.brass);
  box(tg, 0.009, 0.032, 0.009, 0, -0.010, TRIGGER_Z.revolver, COL.brass, { rx: 0.20 });
  box(tg, 0.040, 0.007, 0.060, 0, -0.042, TRIGGER_Z.revolver, COL.gunmetal);

  const loader = new THREE.Group();
  loader.name = 'speedloader';
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    cylZ(loader, 0.007, 0.045, Math.cos(a) * 0.024, Math.sin(a) * 0.024, 0, COL.brass, { seg: 8 });
  }
  cylZ(loader, 0.010, 0.020, 0, 0, 0.025, COL.polymer, { seg: 10 });
  loader.position.set(-0.10, 0.04, -0.145);
  loader.userData.homePosition = loader.position.clone();
  loader.visible = false;
  extra.add(loader);
  extra.userData.reloadRounds = loader;
}
