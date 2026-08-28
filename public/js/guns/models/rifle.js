import { COL } from '../kit.js';
import { BOLT_HOME, BREACH_Z, TRIGGER_Z } from './common.js';

export function build({ kit, T, groups }) {
  const { box, cylZ, brakeRings, ironSights } = kit;
  const { body, mag, bolt, trigger } = groups;

  box(body, 0.085, 0.11, 0.34, 0, 0.03, -0.22, COL.steel);
  box(body, 0.075, 0.09, 0.13, 0, -0.005, 0.06, COL.polyDark);
  box(body, 0.05, 0.10, 0.06, -0.005, -0.075, -0.02, COL.polymer, { rx: 0.35 });
  for (let i = 0; i < 9; i++) {
    box(body, 0.07, 0.012, 0.046, 0, 0.088, -0.06 - i * 0.052, i % 2 ? COL.polyDark : COL.steel);
  }
  [0, 2, 4].forEach((i) => {
    box(body, 0.072, 0.006, 0.02, 0, 0.096, -0.06 - i * 0.104, COL.amber);
  });
  ironSights(body, { rearZ: 0.045, frontZ: -0.53, height: 0.145 });
  [-1, 1].forEach((side) => {
    [-0.36, -0.44, -0.52].forEach((z) => {
      box(body, 0.006, 0.03, 0.05, side * 0.034, 0.052, z, COL.polyDark);
    });
  });

  const muzzleX = T.muzzle[0];
  const muzzleY = T.muzzle[1];
  const barrelLength = Math.abs(T.muzzle[2] - BREACH_Z.rifle);
  cylZ(body, 0.016, barrelLength, muzzleX, muzzleY, (T.muzzle[2] + BREACH_Z.rifle) / 2, COL.blued);
  brakeRings(body, 0.026, muzzleX, muzzleY, T.muzzle[2], 2, 0.008, 0.016);
  cylZ(body, 0.02, 0.012, muzzleX, muzzleY, T.muzzle[2] + 0.006, COL.brake);
  box(body, 0.004, 0.03, 0.05, 0.043, 0.05, -0.16, COL.amber);

  box(mag, 0.05, 0.11, 0.09, 0, -0.095, -0.205, COL.polymer, { rx: 0.12 });
  box(mag, 0.05, 0.09, 0.082, 0, -0.185, -0.170, COL.polymer, { rx: 0.42 });
  box(bolt, 0.045, 0.05, 0.03, -0.045, 0.075, BOLT_HOME.rifle, COL.polymer);
  box(bolt, 0.02, 0.012, 0.05, -0.062, 0.075, BOLT_HOME.rifle + 0.02, COL.steel);
  box(trigger, 0.008, 0.03, 0.008, 0, -0.02, TRIGGER_Z.rifle, COL.amber);
  box(trigger, 0.03, 0.006, 0.05, 0, -0.045, TRIGGER_Z.rifle, COL.polyDark);
}
