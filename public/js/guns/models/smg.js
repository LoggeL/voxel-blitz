import { COL } from '../kit.js';
import { BOLT_HOME, BREACH_Z, TRIGGER_Z } from './common.js';

export function build({ kit, T, groups }) {
  const { box, cylZ, brakeRings } = kit;
  const { body, mag, bolt, trigger } = groups;

  box(body, 0.075, 0.095, 0.26, 0, 0.01, -0.145, COL.tan);
  box(body, 0.07, 0.09, 0.12, 0, -0.045, -0.10, COL.polymer);
  box(body, 0.045, 0.095, 0.055, 0, -0.11, -0.045, COL.polymer, { rx: 0.30 });
  for (let i = 0; i < 5; i++) {
    box(body, 0.06, 0.010, 0.04, 0, 0.062, -0.03 - i * 0.05, i % 2 ? COL.polymer : COL.steel);
  }
  box(body, 0.012, 0.02, 0.12, 0, 0.02, 0.08, COL.steel);
  box(body, 0.05, 0.07, 0.02, 0, -0.005, 0.145, COL.polymer);

  const muzzleY = T.muzzle[1];
  const barrelLength = Math.abs(T.muzzle[2] - BREACH_Z.smg);
  cylZ(body, 0.037, barrelLength, 0, muzzleY, (T.muzzle[2] + BREACH_Z.smg) / 2, COL.polyDark);
  brakeRings(body, 0.028, 0, muzzleY, T.muzzle[2], 1, 0.010, 0.014, COL.amber);
  cylZ(body, 0.026, 0.010, 0, muzzleY, T.muzzle[2] + 0.005, COL.brake);
  box(body, 0.03, 0.06, 0.04, 0, -0.055, -0.305, COL.polymer);

  box(mag, 0.045, 0.15, 0.068, 0, -0.155, -0.155, COL.polymer);
  box(bolt, 0.028, 0.012, 0.07, -0.052, 0.05, BOLT_HOME.smg, COL.steel);
  box(bolt, 0.02, 0.014, 0.03, -0.052, 0.05, BOLT_HOME.smg + 0.045, COL.amber);
  box(trigger, 0.008, 0.026, 0.008, 0, -0.018, TRIGGER_Z.smg, COL.amber);
  box(trigger, 0.028, 0.006, 0.045, 0, -0.04, TRIGGER_Z.smg, COL.polymer);
}
