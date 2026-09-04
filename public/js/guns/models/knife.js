import { COL } from '../kit.js';

// K-7 RIPPER: fighting knife. A flat blued blade with a stepped bevel rises from the steel
// crossguard to a tapered spear point whose front face lands exactly on T.muzzle; the
// glove-material handle carries finger grooves, knurl bands and a lanyard loop, and the
// fist (HANDS.knife.grip) rides just low enough that the baked glove cuff never crosses the
// sight line. Melee consumes no ammunition, so the mag/bolt/pump/trigger groups stay empty
// — no eject port, no bolt cap, and assemble substitutes an inert flash stub for `melee`
// bundles. The blade spine tops out just under the 0.02 sight line the body declares
// (userData.sightHeight): keeping every opaque surface strictly below the declared line is
// what lets the ADS camera axis and remote-avatar mounts graze the blade without hitting it.
export function build({ kit, T, groups }) {
  const { box } = kit;
  const { body } = groups;

  const muzzleX = T.muzzle[0];
  const muzzleY = T.muzzle[1];
  const muzzleZ = T.muzzle[2];
  // Half a millimetre under the declared 0.02 sight line: visually identical, and a margin
  // float rounding can never bridge (the ADS axis must skip, not graze, opaque geometry).
  const SPINE_TOP = muzzleY - 0.0005;

  // Handle: glove-material core with finger grooves and knurl bands (the baked fist wraps
  // this region at HANDS.knife.grip).
  box(body, 0.034, 0.048, 0.125, 0, -0.035, 0.020, COL.polyDark, { rg: 0.95, mt: 0.02 });
  for (const side of [-1, 1]) {
    for (const y of [-0.044, -0.026]) {
      box(body, 0.004, 0.008, 0.094, side * 0.019, y, 0.020, COL.polymer, { rg: 0.95, mt: 0.02 });
    }
  }
  for (const z of [0.048, 0.020, -0.008]) {
    box(body, 0.040, 0.052, 0.010, 0, -0.035, z, COL.steel, { rg: 0.6, mt: 0.5 });
  }
  // Front ferrule joins the handle to the guard.
  box(body, 0.038, 0.052, 0.014, 0, -0.035, -0.036, COL.gunmetal);
  // Pommel cap with a lanyard loop seated against its rear face.
  box(body, 0.040, 0.056, 0.016, 0, -0.035, 0.086, COL.gunmetal);
  box(body, 0.010, 0.014, 0.006, 0, -0.048, 0.092, COL.steel);

  // Steel crossguard, tall enough that the blade's rear face seats across it instead of
  // balancing on one corner.
  box(body, 0.086, 0.026, 0.016, 0, -0.014, -0.050, COL.steel);
  box(body, 0.010, 0.030, 0.014, 0.043, -0.012, -0.050, COL.steel);
  box(body, 0.010, 0.030, 0.014, -0.043, -0.012, -0.050, COL.steel);

  // Blade: three straight segments (ricasso -> belly -> tip taper), each a stepped bevel of
  // spine / grind / edge slabs, then a pointed final stack whose front face terminates
  // exactly on T.muzzle. The slight mid-blade offsets read as a curved blade in profile.
  const bevel = (depth, z, x, slabs) => {
    for (const [w, h, y, color, rg, mt] of slabs) {
      box(body, w, h, depth, x, y, z, color, { rg, mt });
    }
  };
  const BLUED = [COL.blued, 0.44, 0.72];
  const STEEL = [COL.steel, 0.3, 0.8];
  bevel(0.072, -0.094, 0, [           // ricasso: full spine from the guard forward
    [0.007, 0.018, 0.0105, ...BLUED],
    [0.005, 0.018, -0.0045, COL.blued, 0.5, 0.66],
    [0.003, 0.014, -0.016, ...STEEL],
  ]);
  bevel(0.120, -0.190, -0.002, [      // belly
    [0.007, 0.018, 0.0105, ...BLUED],
    [0.005, 0.018, -0.0045, COL.blued, 0.5, 0.66],
    [0.003, 0.014, -0.016, ...STEEL],
  ]);
  bevel(0.105, -0.3025, -0.001, [     // tip taper: the whole cross-section thins
    [0.006, 0.014, 0.0125, ...BLUED],
    [0.004, 0.014, 0.000, COL.blued, 0.5, 0.66],
    [0.0025, 0.011, -0.011, ...STEEL],
  ]);
  bevel(0.065, -0.3875, 0, [          // point: spine only, front face exactly on T.muzzle
    [0.005, 0.008, 0.0155, ...BLUED],
    [0.0035, 0.010, 0.008, COL.blued, 0.5, 0.66],
    [0.002, 0.007, -0.001, ...STEEL],
  ]);
  // Ember collar note: buildGun's heat band (BREACH_Z/heatLen/BARREL_R mapping) hugs the
  // blade base between guard and ricasso, so no extra geometry is needed for it here.

  // Melee: no magazine, no bolt, no pump, no trigger blade — those groups stay empty by
  // design; the action code still parks their transforms with no geometry to move.

  body.userData.sightHeight = 0.02;
}
