import { COL } from '../kit.js';
import { BOLT_HOME, BREACH_Z, PUMP_REST, TRIGGER_Z } from './common.js';

/** Build the shotgun silhouette into the assembler-owned groups. */
export function build({ kit, T, groups }) {
  const { box, cylZ, brakeRings, ironSights } = kit;
  const { body, mag, bolt, pump, trigger } = groups;

  box(body, 0.065, 0.10, 0.16, 0, -0.01, 0.10, COL.walnut);
  box(body, 0.058, 0.09, 0.02, 0, -0.015, 0.19, COL.polymer);
  box(body, 0.08, 0.095, 0.10, 0, 0.02, -0.07, COL.blued);
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < 3; i++) {
      const z = -0.045 - i * 0.04;
      const y = row ? 0.002 : 0.034;
      cylZ(body, 0.011, 0.028, -0.048, y, z, COL.shellRed, { seg: 8 });
      cylZ(body, 0.0118, 0.006, -0.048, y, z + 0.016, COL.brass, { seg: 8 });
    }
  }
  box(body, 0.03, 0.06, 0.06, 0, 0.045, -0.125, COL.blued);
  ironSights(body, {
    rearZ: 0.145,
    frontZ: -0.61,
    height: 0.100,
    width: 0.040,
    gap: 0.016,
    accent: COL.brass,
  });

  const barrelY = T.muzzle[1];
  const barrelLength = Math.abs(T.muzzle[2] - BREACH_Z.shotgun);
  cylZ(body, 0.019, barrelLength, 0, barrelY,
    (T.muzzle[2] + BREACH_Z.shotgun) / 2, COL.blued);
  cylZ(body, 0.014, 0.34, 0, 0.018, -0.29, COL.brake);
  cylZ(body, 0.017, 0.02, 0, 0.018, -0.465, COL.walnut);
  box(body, 0.008, 0.008, 0.008, 0, barrelY + 0.026, T.muzzle[2] + 0.01, COL.amber);
  brakeRings(body, 0.023, 0, barrelY, T.muzzle[2], 1, 0.008, 0.012);

  // Tube-fed guns retain the shared magazine hierarchy without exposing a visible box magazine.
  box(mag, 0.001, 0.001, 0.001, 0, -0.5, -0.5, COL.brake);
  box(bolt, 0.05, 0.055, 0.05, 0, 0.02, BOLT_HOME.shotgun, COL.steel);

  // The assembler welds the support hand to this moving group; pump animation therefore moves both.
  box(pump, 0.062, 0.05, 0.13, 0, 0, 0, COL.walnut);
  for (const dz of [-0.03, 0, 0.03]) {
    box(pump, 0.064, 0.006, 0.012, 0, 0.028, dz, COL.fluteDark);
  }
  cylZ(pump, 0.040, 0.012, 0, 0, -0.062, COL.brass, { seg: 10 });
  pump.position.copy(PUMP_REST);

  box(trigger, 0.009, 0.03, 0.009, 0, -0.018, TRIGGER_Z.shotgun, COL.amber);
  box(trigger, 0.03, 0.006, 0.05, 0, -0.042, TRIGGER_Z.shotgun, COL.polyDark);
}
