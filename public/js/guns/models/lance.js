import { COL, GLOW_ACCENT } from '../kit.js';
import { BOLT_HOME, BREACH_Z, TRIGGER_Z } from './common.js';

// CL-9 VOLTLANCE: compact charge rail-lance. A short polymer receiver feeds a dense forward
// rail shroud; the last third of the gun is an exposed twin-rail lane carrying three
// lance-cell coil rings that light violet-cyan on charge (rechargeDur) and vent through a
// bayonet-caged emitter tip landing exactly on T.muzzle. A capacitor block hangs under the
// receiver and the lance-cell magazine feeds the magwell on the stock reload timeline.
// kit.js carries no GLOW_ACCENT.lance key yet, so the def-tracer hex is the in-file
// fallback; the sight line (0.155) matches the ADS offset.
const LANCE_VIOLET = GLOW_ACCENT.lance ?? 0xc9a2ff;

export function build({ kit, T, groups }) {
  const { box, cylZ, ironSights } = kit;
  const { body, mag, bolt, trigger } = groups;
  const VIOLET = LANCE_VIOLET;

  const muzzleX = T.muzzle[0];
  const muzzleY = T.muzzle[1];
  const muzzleZ = T.muzzle[2];
  const breachZ = BREACH_Z.lance;
  const railLength = Math.abs(muzzleZ - breachZ);
  const railMid = (muzzleZ + breachZ) / 2;

  // Stepped polymer receiver with gunmetal side plates; the shroud and buffer tube both
  // overlap the receiver body so the silhouette never reads as detached parts.
  box(body, 0.090, 0.084, 0.200, 0, 0.046, -0.155, COL.polymer);
  box(body, 0.096, 0.032, 0.196, 0, 0.100, -0.156, COL.gunmetal);
  box(body, 0.084, 0.012, 0.180, 0, 0.110, -0.158, COL.polyDark);
  box(body, 0.084, 0.064, 0.150, 0, -0.020, -0.125, COL.polyDark);
  for (const side of [-1, 1]) {
    box(body, 0.006, 0.048, 0.170, side * 0.048, 0.050, -0.155, COL.gunmetal, { rg: 0.5, mt: 0.6 });
  }
  // Continuous picatinny spine: six slats, every one seated on the receiver plate or the
  // shroud deck so no tooth floats past the body silhouette.
  for (let i = 0; i < 6; i++) {
    box(body, 0.068, 0.010, 0.032, 0, 0.120, -0.080 - i * 0.056, i % 3 === 1 ? COL.steel : COL.polyDark);
  }

  // Rear stock: buffer tube run back into the receiver, stepped body, violet cell inlay.
  cylZ(body, 0.015, 0.240, 0, 0.038, 0.030, COL.gunmetal, { seg: 8 });
  box(body, 0.064, 0.050, 0.104, 0, 0.018, 0.114, COL.polymer, { rx: -0.05 });
  box(body, 0.068, 0.018, 0.088, 0, 0.060, 0.104, COL.polyDark);
  box(body, 0.070, 0.011, 0.078, 0, 0.076, 0.102, COL.steel);
  box(body, 0.014, 0.088, 0.014, 0, 0.020, 0.172, VIOLET);
  box(body, 0.010, 0.080, 0.018, 0, 0.020, 0.186, COL.polymer);

  // Swept pistol grip with violet heel and steel ribs (dominant-hand anchor lives here).
  box(body, 0.058, 0.086, 0.048, 0, -0.094, -0.046, COL.polymer, { rx: -0.30 });
  box(body, 0.061, 0.078, 0.052, 0, -0.156, -0.024, COL.polyDark, { rx: -0.24 });
  box(body, 0.064, 0.016, 0.058, 0, -0.200, -0.008, VIOLET, { rx: -0.18 });
  [-0.114, -0.142, -0.170].forEach((y, i) => {
    box(body, 0.004, 0.008, 0.036, 0.031, y, -0.032 + i * 0.010, COL.steel, { rx: -0.24 });
    box(body, 0.004, 0.008, 0.036, -0.031, y, -0.032 + i * 0.010, COL.steel, { rx: -0.24 });
  });
  box(body, 0.070, 0.034, 0.155, 0, 0.100, -0.3275, COL.polymer);
  box(body, 0.046, 0.068, 0.050, 0, -0.044, -0.420, COL.polymer, { rx: 0.12 });
  box(body, 0.050, 0.016, 0.054, 0, -0.084, -0.412, COL.polyDark, { rx: 0.12 });
  box(body, 0.052, 0.008, 0.056, 0, -0.096, -0.408, COL.amber, { rx: 0.12 });

  // Dense shroud over the breech, run back into the receiver, then the exposed rail lane.
  box(body, 0.072, 0.060, 0.155, 0, 0.052, -0.3275, COL.polyDark);
  box(body, 0.062, 0.046, 0.148, 0, 0.046, -0.329, COL.gunmetal);
  box(body, 0.070, 0.014, 0.155, 0, 0.106, -0.3275, COL.polymer);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      box(body, 0.008, 0.020, 0.030, side * 0.042, 0.056, -0.290 - i * 0.054, COL.polymer);
      box(body, 0.010, 0.008, 0.018, side * 0.046, 0.056, -0.290 - i * 0.054, i === 1 ? VIOLET : COL.steel);
    }
  }
  box(body, 0.052, 0.010, 0.240, 0, 0.030, -0.470, COL.polymer);

  // Bore tube plus twin conductor rails, breech -> muzzle tip exactly.
  cylZ(body, 0.012, railLength, muzzleX, muzzleY, railMid, COL.blued, { seg: 12, rg: 0.44, mt: 0.72 });
  for (const side of [-1, 1]) {
    cylZ(body, 0.007, railLength, muzzleX + side * 0.019, muzzleY, railMid, COL.amber, { seg: 8, rg: 0.38, mt: 0.75 });
  }
  // 3 insulator yokes tying the rails to the bore and carrying the under-lane rail.
  for (const f of [0.16, 0.48, 0.80]) {
    const z = breachZ - railLength * f;
    box(body, 0.060, 0.046, 0.018, muzzleX, muzzleY, z, COL.polyDark);
    box(body, 0.062, 0.010, 0.020, muzzleX, muzzleY + 0.026, z, COL.steel);
  }

  // 3 lance-cell coil rings left proud of the shroud so the violet cells read in profile.
  for (let i = 0; i < 3; i++) {
    const z = breachZ - railLength * (0.30 + i * 0.28);
    cylZ(body, 0.034, 0.032, muzzleX, muzzleY, z, VIOLET, { seg: 14, rg: 0.4, mt: 0.7 });
    cylZ(body, 0.036, 0.006, muzzleX, muzzleY, z - 0.019, COL.brake, { seg: 14, rg: 0.4, mt: 0.7 });
    cylZ(body, 0.036, 0.006, muzzleX, muzzleY, z + 0.019, COL.brake, { seg: 14, rg: 0.4, mt: 0.7 });
  }

  // Bayonet-caged emitter: four prongs converge on the lance rod, whose front face and the
  // tip-ring face both terminate exactly on T.muzzle.
  box(body, 0.062, 0.056, 0.032, muzzleX, muzzleY, -0.676, COL.gunmetal);
  box(body, 0.008, 0.008, 0.052, muzzleX, muzzleY + 0.024, -0.688, COL.steel, { rx: -0.14 });
  box(body, 0.008, 0.008, 0.052, muzzleX, muzzleY - 0.024, -0.688, COL.steel, { rx: 0.14 });
  box(body, 0.008, 0.008, 0.052, muzzleX + 0.023, muzzleY, -0.688, COL.steel, { rz: 0.14 });
  box(body, 0.008, 0.008, 0.052, muzzleX - 0.023, muzzleY, -0.688, COL.steel, { rz: -0.14 });
  cylZ(body, 0.009, 0.052, muzzleX, muzzleY, muzzleZ + 0.026, COL.blued, { seg: 10, rg: 0.44, mt: 0.72 });
  cylZ(body, 0.022, 0.018, muzzleX, muzzleY, muzzleZ + 0.009, COL.brake, { seg: 12, rg: 0.42, mt: 0.74 });
  cylZ(body, 0.016, 0.018, muzzleX, muzzleY, muzzleZ + 0.009, VIOLET, { seg: 12 });

  // Capacitor block under the receiver with violet charge windows and brass terminals.
  box(body, 0.068, 0.052, 0.130, 0, -0.048, -0.245, COL.blued);
  box(body, 0.072, 0.014, 0.134, 0, -0.078, -0.242, COL.polyDark);
  for (let i = 0; i < 3; i++) {
    box(body, 0.046, 0.010, 0.005, 0, -0.030 - i * 0.018, -0.308, VIOLET);
  }
  box(body, 0.012, 0.014, 0.012, 0.026, -0.022, -0.184, COL.brass, { rg: 0.42, mt: 0.7 });
  box(body, 0.012, 0.014, 0.012, -0.026, -0.022, -0.184, COL.brass, { rg: 0.42, mt: 0.7 });
  // Power cables snaking receiver -> shroud with brass connector blocks.
  for (const side of [-1, 1]) {
    box(body, 0.006, 0.006, 0.190, side * 0.054, 0.018, -0.230, COL.blued, { ry: side * 0.06 });
    box(body, 0.006, 0.006, 0.160, side * 0.056, 0.026, -0.240, VIOLET, { ry: side * -0.05 });
    box(body, 0.010, 0.016, 0.022, side * 0.054, 0.018, -0.130, COL.brass, { rg: 0.42, mt: 0.7 });
    box(body, 0.010, 0.016, 0.022, side * 0.056, 0.026, -0.330, COL.brass, { rg: 0.42, mt: 0.7 });
  }

  // Rail optic around the shared 0.155 sight line, with risers tying it down so the tall
  // line never floats in side-profile HUD renders. Sight line untouched.
  ironSights(body, {
    rearZ: 0.082,
    frontZ: -0.635,
    height: 0.155,
    width: 0.032,
    gap: 0.016,
    color: COL.polyDark,
    accent: VIOLET,
  });
  box(body, 0.006, 0.042, 0.050, 0.022, 0.136, 0.082, COL.gunmetal);
  box(body, 0.006, 0.042, 0.050, -0.022, 0.136, 0.082, COL.gunmetal);
  box(body, 0.052, 0.006, 0.050, 0, 0.160, 0.082, COL.polyDark);
  box(body, 0.006, 0.006, 0.003, 0, 0.144, 0.082, VIOLET);
  box(body, 0.056, 0.008, 0.022, 0, 0.124, 0.082, COL.steel);
  box(body, 0.056, 0.008, 0.022, 0, 0.124, -0.635, COL.steel);
  box(body, 0.038, 0.072, 0.028, 0, 0.090, 0.082, COL.polyDark);
  box(body, 0.024, 0.064, 0.018, 0, 0.096, -0.635, COL.polyDark);

  // Lance-cell magazine seated directly under the receiver frame (behind the trigger
  // guard): the stock 'mag' reload timeline slides this group.
  box(mag, 0.058, 0.084, 0.062, 0, -0.094, -0.150, COL.blued, { rx: 0.06 });
  box(mag, 0.062, 0.016, 0.066, 0, -0.142, -0.144, VIOLET, { rx: 0.06 });
  for (let i = 0; i < 3; i++) {
    box(mag, 0.044, 0.008, 0.004, 0, -0.072 - i * 0.020, -0.183, VIOLET, { rx: 0.06 });
  }
  box(mag, 0.012, 0.014, 0.012, 0.022, -0.046, -0.156, COL.brass);
  box(mag, 0.012, 0.014, 0.012, -0.022, -0.046, -0.156, COL.brass);

  // Charging sled at bolt home so the recharge reciprocation reads.
  box(bolt, 0.050, 0.034, 0.048, 0, 0.080, BOLT_HOME.lance, COL.steel, { rg: 0.45, mt: 0.65 });
  box(bolt, 0.014, 0.018, 0.054, 0.029, 0.080, BOLT_HOME.lance, VIOLET);
  box(bolt, 0.014, 0.018, 0.054, -0.029, 0.080, BOLT_HOME.lance, VIOLET);
  box(bolt, 0.030, 0.008, 0.038, 0, 0.084, BOLT_HOME.lance + 0.004, COL.polyDark);

  // Trigger blade plus 3-piece guard at the lance trigger zero.
  box(trigger, 0.008, 0.030, 0.008, 0, -0.022, TRIGGER_Z.lance, COL.amber, { rx: -0.22 });
  box(trigger, 0.038, 0.007, 0.068, 0, -0.047, TRIGGER_Z.lance + 0.004, COL.polyDark);
  box(trigger, 0.038, 0.025, 0.007, 0, -0.036, TRIGGER_Z.lance - 0.031, COL.polyDark);
  box(trigger, 0.038, 0.025, 0.007, 0, -0.036, TRIGGER_Z.lance + 0.039, COL.polyDark);
}
