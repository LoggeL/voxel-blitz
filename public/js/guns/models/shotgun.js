import { COL } from '../kit.js';
import { BOLT_HOME, BREACH_Z, PUMP_REST, TRIGGER_Z } from './common.js';

/** Build the M-DOCK 12's full-stock, tube-fed pump-action silhouette. */
export function build({ kit, T, groups }) {
  const { box, cylZ, brakeRings, ironSights } = kit;
  const { body, mag, bolt, pump, trigger, extra } = groups;

  // Layered full stock. The short rotated sections read as the reference's flowing pistol-grip
  // neck without bringing one large cuboid close enough to fill the first-person camera.
  box(body, 0.060, 0.055, 0.105, 0, 0.020, 0.157, COL.polymer, { rx: -0.05 });
  box(body, 0.058, 0.070, 0.080, 0, -0.012, 0.087, COL.polymer, { rx: -0.22 });
  box(body, 0.056, 0.070, 0.075, 0, -0.050, 0.050, COL.polymer, { rx: -0.48 });
  box(body, 0.064, 0.104, 0.030, 0, -0.012, 0.221, COL.polyDark, { rx: -0.06 });
  box(body, 0.067, 0.108, 0.010, 0, -0.013, 0.240, COL.polyDark, { rx: -0.06 });
  for (const y of [-0.048, -0.016, 0.016]) {
    box(body, 0.004, 0.008, 0.012, -0.034, y, 0.247, COL.amber, { rx: -0.06 });
  }
  box(body, 0.004, 0.008, 0.102, -0.032, 0.051, 0.157, COL.amber, { rx: -0.05 });

  // Steel receiver: stepped roof, side plate, ejection window and lower loading gate.
  box(body, 0.090, 0.105, 0.220, 0, 0.010, 0.000, COL.gunmetal, { rg: 0.52, mt: 0.62 });
  box(body, 0.084, 0.025, 0.195, 0, 0.073, -0.002, COL.blued, { rg: 0.48, mt: 0.66 });
  box(body, 0.004, 0.075, 0.175, -0.047, 0.012, 0.006, COL.steel,
    { rg: 0.58, mt: 0.48 });
  box(body, 0.005, 0.036, 0.072, -0.050, 0.030, -0.016, COL.polymer,
    { rg: 0.42, mt: 0.72 });
  box(body, 0.006, 0.022, 0.052, -0.053, 0.030, -0.016, COL.polyDark);
  box(body, 0.043, 0.006, 0.072, 0, -0.045, -0.020, COL.polyDark);
  box(body, 0.030, 0.006, 0.054, 0, -0.049, -0.018, COL.steel,
    { rg: 0.50, mt: 0.58 });
  for (const z of [-0.074, 0.064]) {
    box(body, 0.006, 0.012, 0.012, -0.052, 0.010, z, COL.brass,
      { rg: 0.42, mt: 0.70 });
  }
  box(body, 0.005, 0.008, 0.202, -0.049, 0.066, -0.002, COL.amber);

  // The barrel terminates exactly at T.muzzle. The parallel magazine tube stops just behind it,
  // matching the reference's unmistakable twin-tube profile.
  const barrelY = T.muzzle[1];
  const barrelLength = Math.abs(T.muzzle[2] - BREACH_Z.shotgun);
  cylZ(body, 0.018, barrelLength, 0, barrelY,
    (T.muzzle[2] + BREACH_Z.shotgun) / 2, COL.blued, { seg: 12, rg: 0.44, mt: 0.72 });
  cylZ(body, 0.0185, 0.470, 0, 0.018, -0.355, COL.brake,
    { seg: 12, rg: 0.50, mt: 0.64 });
  cylZ(body, 0.021, 0.018, 0, 0.018, -0.599, COL.polyDark, { seg: 12 });
  for (const z of [-0.155, -0.575]) {
    box(body, 0.050, 0.056, 0.014, 0, 0.038, z, COL.polyDark);
    box(body, 0.053, 0.008, 0.016, 0, 0.071, z, COL.amber);
  }
  brakeRings(body, 0.022, 0, barrelY, T.muzzle[2], 2, 0.006, 0.009, COL.amber);
  cylZ(body, 0.021, 0.012, 0, barrelY, T.muzzle[2] + 0.006, COL.brake,
    { seg: 12, rg: 0.42, mt: 0.74 });

  // Low-profile bead sights share the existing 0.100 sight axis used by ADS alignment.
  ironSights(body, {
    rearZ: 0.088,
    frontZ: -0.612,
    height: 0.100,
    width: 0.030,
    gap: 0.014,
    color: COL.polyDark,
    accent: COL.amber,
  });

  // Tube-fed weapons retain the assembler's magazine hierarchy without a removable box.
  box(mag, 0.001, 0.001, 0.001, 0, -0.5, -0.5, COL.brake);
  const reloadShell = new THREE.Group();
  reloadShell.name = 'shotgun_reload_shell';
  cylZ(reloadShell, 0.012, 0.050, 0, 0, 0, 0xb34225, { seg: 8 });
  cylZ(reloadShell, 0.013, 0.014, 0, 0, 0.025, COL.brass, { seg: 8 });
  reloadShell.visible = false;
  reloadShell.userData.homePosition = reloadShell.position.clone();
  extra.add(reloadShell);
  extra.userData.reloadRounds = reloadShell;

  // The visible breech face sits inside the body-side ejection window and follows bolt travel.
  box(bolt, 0.008, 0.029, 0.055, -0.050, 0.030, BOLT_HOME.shotgun, COL.steel,
    { rg: 0.40, mt: 0.76 });
  box(bolt, 0.010, 0.007, 0.016, -0.055, 0.040, BOLT_HOME.shotgun + 0.026, COL.amber);

  // Long walnut action sleeve with individually modelled ribs. The support hand remains welded
  // to this moving group, so both continue to ride the pump cycle without runtime IK.
  box(pump, 0.070, 0.060, 0.180, 0, 0, 0, COL.walnut, { rg: 0.88, mt: 0.05 });
  box(pump, 0.074, 0.012, 0.160, 0, 0.031, 0, COL.wood, { rg: 0.90, mt: 0.04 });
  for (let i = -4; i <= 4; i++) {
    box(pump, 0.073, 0.064, 0.007, 0, 0, i * 0.018, COL.fluteDark,
      { rg: 0.92, mt: 0.03 });
  }
  for (const z of [-0.091, 0.091]) {
    box(pump, 0.076, 0.066, 0.012, 0, 0, z, COL.polyDark);
  }
  box(pump, 0.078, 0.006, 0.182, 0, -0.032, 0, COL.amber);
  pump.position.copy(PUMP_REST);

  // Trigger and squared guard stay on their dedicated animation group.
  box(trigger, 0.008, 0.031, 0.008, 0, -0.018, TRIGGER_Z.shotgun, COL.amber,
    { rx: -0.28 });
  box(trigger, 0.038, 0.007, 0.068, 0, -0.043, TRIGGER_Z.shotgun + 0.004, COL.polyDark);
  box(trigger, 0.038, 0.025, 0.007, 0, -0.032, TRIGGER_Z.shotgun - 0.031, COL.polyDark);
  box(trigger, 0.038, 0.025, 0.007, 0, -0.032, TRIGGER_Z.shotgun + 0.039, COL.polyDark);
}
import * as THREE from '../../vendor/three.module.js';
