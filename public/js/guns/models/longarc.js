import { COL, GLOW_ACCENT } from '../kit.js';
import { BOLT_HOME, BREACH_Z, TRIGGER_Z } from './common.js';

// LN-03 LONGARC: semi-auto coilgun DMR. Twin copper rails fling a wall/player-piercing
// rail slug; capacitor coils along the shroud decay cyan after each shot (rechargeDur).
// Every bore/coil/rail element derives from BREACH_Z.longarc and T.muzzle so the tip
// lands exactly on T.muzzle; the sight line (0.155) matches the ADS offset.
export function build({ kit, T, groups }) {
  const { box, cylZ, ironSights } = kit;
  const { body, mag, bolt, trigger } = groups;
  const CYAN = GLOW_ACCENT.longarc;

  const muzzleX = T.muzzle[0];
  const muzzleY = T.muzzle[1];
  const muzzleZ = T.muzzle[2];
  const breachZ = BREACH_Z.longarc;
  const barrelLength = Math.abs(muzzleZ - breachZ);
  const barrelMid = (muzzleZ + breachZ) / 2;

  // Split accelerator cage with exposed energy channels and staggered cooling fins.
  for (const side of [-1, 1]) {
    box(body, 0.016, 0.044, 0.27, side * 0.050, muzzleY, -0.48, COL.gunmetal);
    box(body, 0.008, 0.012, 0.25, side * 0.060, muzzleY, -0.48, CYAN);
    for (let i = 0; i < 4; i++) {
      const z = -0.38 - i * 0.062;
      box(body, 0.022, 0.056, 0.018, side * 0.052, muzzleY, z, COL.polyDark, { rz: side * 0.20 });
      box(body, 0.024, 0.008, 0.020, side * 0.054, muzzleY + 0.032, z, CYAN);
    }
  }

  // Stepped polymer receiver with gunmetal side plates.
  box(body, 0.092, 0.088, 0.240, 0, 0.048, -0.150, COL.polymer);
  box(body, 0.098, 0.034, 0.220, 0, 0.100, -0.152, COL.gunmetal);
  box(body, 0.086, 0.012, 0.200, 0, 0.112, -0.154, COL.polyDark);
  box(body, 0.086, 0.068, 0.160, 0, -0.018, -0.120, COL.polyDark);
  box(body, 0.076, 0.030, 0.110, 0, -0.064, -0.158, COL.polymer);
  box(body, 0.006, 0.050, 0.180, 0.049, 0.052, -0.150, COL.gunmetal, { rg: 0.5, mt: 0.6 });
  box(body, 0.006, 0.050, 0.180, -0.049, 0.052, -0.150, COL.gunmetal, { rg: 0.5, mt: 0.6 });
  // Ejection cover, receiver pins and cyan status strip.
  box(body, 0.007, 0.028, 0.070, 0.053, 0.058, -0.160, COL.steel);
  box(body, 0.008, 0.014, 0.060, -0.052, 0.088, -0.150, CYAN);
  box(body, 0.008, 0.010, 0.026, -0.054, 0.088, -0.108, COL.polyDark);
  for (const z of [-0.220, -0.080]) {
    box(body, 0.006, 0.012, 0.012, -0.052, 0.010, z, COL.brass, { rg: 0.42, mt: 0.7 });
  }

  // Ventilated handguard with side slots and dark inset panels.
  box(body, 0.090, 0.072, 0.260, 0, 0.054, -0.400, COL.polyDark);
  box(body, 0.078, 0.058, 0.248, 0, 0.050, -0.400, COL.gunmetal);
  box(body, 0.066, 0.016, 0.252, 0, 0.100, -0.400, COL.polymer);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const z = -0.318 - i * 0.056;
      box(body, 0.008, 0.022, 0.038, side * 0.045, 0.060, z, COL.polymer);
      box(body, 0.010, 0.008, 0.022, side * 0.050, 0.060, z, i === 1 ? COL.amber : COL.steel);
    }
  }
  box(body, 0.070, 0.016, 0.170, 0, 0.016, -0.415, COL.polymer);
  for (let i = 0; i < 4; i++) {
    box(body, 0.048, 0.008, 0.024, 0, 0.005, -0.345 - i * 0.046, COL.blued);
  }

  // Continuous picatinny spine across receiver and handguard.
  for (let i = 0; i < 9; i++) {
    const z = -0.010 - i * 0.056;
    box(body, 0.070, 0.010, 0.034, 0, 0.120, z, i % 3 === 1 ? COL.steel : COL.polyDark);
  }

  // Rear stock: buffer tube, stepped body, buttpad with amber inlay.
  cylZ(body, 0.015, 0.170, 0, 0.038, 0.140, COL.gunmetal, { seg: 8 });
  box(body, 0.066, 0.052, 0.100, 0, 0.018, 0.160, COL.polymer, { rx: -0.05 });
  box(body, 0.070, 0.020, 0.090, 0, 0.062, 0.150, COL.polyDark);
  box(body, 0.072, 0.012, 0.080, 0, 0.078, 0.148, COL.steel);
  box(body, 0.016, 0.090, 0.014, 0, 0.020, 0.224, COL.amber);
  box(body, 0.012, 0.082, 0.018, 0, 0.020, 0.238, COL.polymer);
  box(body, 0.060, 0.016, 0.070, 0, -0.014, 0.170, COL.polyDark, { rx: -0.10 });

  // Swept pistol grip with amber heel and steel ribs.
  box(body, 0.060, 0.088, 0.050, 0, -0.096, -0.048, COL.polymer, { rx: -0.30 });
  box(body, 0.063, 0.080, 0.054, 0, -0.160, -0.026, COL.polyDark, { rx: -0.24 });
  box(body, 0.066, 0.018, 0.060, 0, -0.206, -0.010, COL.amber, { rx: -0.18 });
  [-0.116, -0.144, -0.172].forEach((y, i) => {
    box(body, 0.004, 0.008, 0.036, 0.033, y, -0.034 + i * 0.010, COL.steel, { rx: -0.24 });
    box(body, 0.004, 0.008, 0.036, -0.033, y, -0.034 + i * 0.010, COL.steel, { rx: -0.24 });
  });
  // Foregrip cup under the rail shroud (support-hand anchor lives here).
  box(body, 0.046, 0.070, 0.052, 0, -0.048, -0.420, COL.polymer, { rx: 0.12 });
  box(body, 0.050, 0.018, 0.056, 0, -0.088, -0.412, COL.polyDark, { rx: 0.12 });
  box(body, 0.052, 0.008, 0.058, 0, -0.100, -0.408, COL.amber, { rx: 0.12 });

  // Bore tube: breech -> muzzle tip exactly.
  cylZ(body, 0.012, barrelLength, muzzleX, muzzleY, barrelMid, COL.blued, { seg: 12, rg: 0.44, mt: 0.72 });
  // Twin copper rails flanking the bore, breech -> muzzle.
  for (const side of [-1, 1]) {
    cylZ(body, 0.008, barrelLength, muzzleX + side * 0.021, muzzleY, barrelMid, COL.amber, { seg: 10, rg: 0.38, mt: 0.75 });
  }
  // 3 insulator yokes holding the rails.
  for (const f of [0.18, 0.50, 0.82]) {
    const z = breachZ - barrelLength * f;
    box(body, 0.064, 0.050, 0.020, muzzleX, muzzleY, z, COL.polyDark);
    box(body, 0.066, 0.010, 0.022, muzzleX, muzzleY + 0.028, z, COL.steel);
  }

  // 4 coil rings at even spacing; the muzzle coil runs slightly larger.
  for (let i = 0; i < 4; i++) {
    const f = (i + 0.5) / 4;
    const z = breachZ - barrelLength * f;
    const last = i === 3;
    const radius = last ? 0.034 : 0.030;
    cylZ(body, radius, 0.030, muzzleX, muzzleY, z, i % 2 === 0 ? COL.amber : COL.brake, { seg: 14, rg: 0.4, mt: 0.7 });
    cylZ(body, radius + 0.001, 0.006, muzzleX, muzzleY, z + 0.018, COL.amber, { seg: 14, rg: 0.4, mt: 0.7 });
  }

  // Rail optic: shared sight line, then a housing that frames (never moves) it.
  ironSights(body, {
    rearZ: 0.088,
    frontZ: -0.60,
    height: 0.155,
    width: 0.034,
    gap: 0.016,
    color: COL.polyDark,
    accent: CYAN,
  });
  box(body, 0.006, 0.045, 0.052, 0.024, 0.140, 0.088, COL.gunmetal);
  box(body, 0.006, 0.045, 0.052, -0.024, 0.140, 0.088, COL.gunmetal);
  box(body, 0.054, 0.006, 0.052, 0, 0.166, 0.088, COL.polyDark);
  box(body, 0.006, 0.006, 0.003, 0, 0.147, 0.088, CYAN);
  box(body, 0.058, 0.008, 0.024, 0, 0.126, 0.088, COL.steel);
  box(body, 0.058, 0.008, 0.024, 0, 0.126, -0.60, COL.steel);
  // Riser posts join both steel crossbars down to the stock tube / bore so the tall
  // 0.155 sight line never floats in side-profile HUD renders. Sight line untouched.
  box(body, 0.040, 0.070, 0.030, 0, 0.087, 0.088, COL.polyDark);
  box(body, 0.024, 0.055, 0.020, 0, 0.094, -0.60, COL.polyDark);

  // Power cables snaking receiver -> handguard, with brass connector blocks.
  for (const side of [-1, 1]) {
    box(body, 0.006, 0.006, 0.200, side * 0.056, 0.020, -0.250, COL.blued, { ry: side * 0.06 });
    box(body, 0.006, 0.006, 0.170, side * 0.058, 0.028, -0.260, CYAN, { ry: side * -0.05 });
    box(body, 0.010, 0.016, 0.024, side * 0.056, 0.020, -0.150, COL.brass, { rg: 0.42, mt: 0.7 });
    box(body, 0.010, 0.016, 0.024, side * 0.058, 0.028, -0.348, COL.brass, { rg: 0.42, mt: 0.7 });
  }

  // Muzzle: tip ring lands its face exactly on T.muzzle, plus 4 brake tines.
  cylZ(body, 0.026, 0.020, muzzleX, muzzleY, muzzleZ + 0.010, COL.brake, { seg: 12, rg: 0.42, mt: 0.74 });
  cylZ(body, 0.020, 0.020, muzzleX, muzzleY, muzzleZ + 0.010, COL.amber, { seg: 12 });
  for (const [tx, ty] of [[0.024, 0], [-0.024, 0], [0, 0.024], [0, -0.024]]) {
    box(body, 0.010, 0.010, 0.026, muzzleX + tx, muzzleY + ty, muzzleZ + 0.020, COL.steel);
  }

  // Battery cell in the magwell: the stock 'mag' reload timeline slides this group.
  box(mag, 0.066, 0.100, 0.070, 0, -0.100, -0.170, COL.blued, { rx: 0.08 });
  box(mag, 0.070, 0.020, 0.074, 0, -0.156, -0.162, COL.amber, { rx: 0.08 });
  for (let i = 0; i < 3; i++) {
    box(mag, 0.050, 0.010, 0.004, 0, -0.080 - i * 0.022, -0.206, CYAN, { rx: 0.08 });
  }
  box(mag, 0.012, 0.014, 0.012, 0.024, -0.046, -0.176, COL.brass);
  box(mag, 0.012, 0.014, 0.012, -0.024, -0.046, -0.176, COL.brass);

  // Charging sled at bolt home so the jerk reciprocation reads.
  box(bolt, 0.052, 0.036, 0.050, 0, 0.082, BOLT_HOME.longarc, COL.steel, { rg: 0.45, mt: 0.65 });
  box(bolt, 0.014, 0.020, 0.056, 0.030, 0.082, BOLT_HOME.longarc, COL.amber);
  box(bolt, 0.014, 0.020, 0.056, -0.030, 0.082, BOLT_HOME.longarc, COL.amber);
  box(bolt, 0.030, 0.008, 0.040, 0, 0.086, BOLT_HOME.longarc + 0.004, CYAN);

  // Trigger blade plus 3-piece guard at the longarc trigger zero.
  box(trigger, 0.008, 0.030, 0.008, 0, -0.022, TRIGGER_Z.longarc, COL.amber, { rx: -0.22 });
  box(trigger, 0.038, 0.007, 0.068, 0, -0.047, TRIGGER_Z.longarc + 0.004, COL.polyDark);
  box(trigger, 0.038, 0.025, 0.007, 0, -0.036, TRIGGER_Z.longarc - 0.031, COL.polyDark);
  box(trigger, 0.038, 0.025, 0.007, 0, -0.036, TRIGGER_Z.longarc + 0.039, COL.polyDark);
}
