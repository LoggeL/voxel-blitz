// Shared third-person grip proportions.
export const HANDS = {
  rifle: {
    grip:   { x: 0.045, y: 0.015, z: -0.09 },              // dominant palm wraps pistol grip.
    support: { x: -0.055, y: 0.005, z: -0.40, on: 'body' }, // foregrip cup under handguard.
  },
  smg: {
    grip: { x: 0.045, y: -0.010, z: -0.06 },
    support: null,                                          // compact PDW: one visible hand.
  },
  shotgun: {
    grip: { x: 0.045, y: 0.010, z: -0.11 },
    support: { x: -0.055, y: -0.030, z: -0.33, on: 'pump' }, // rides the slide, see decision note.
  },
  sniper: {
    grip: { x: 0.045, y: 0.020, z: -0.13 },
    support: { x: -0.055, y: -0.010, z: -0.48, on: 'body' }, // wide benchrest foregrip.
  },
  lmg: {
    grip: { x: 0.050, y: 0.000, z: -0.10 },
    support: { x: -0.060, y: -0.012, z: -0.47, on: 'body' },
  },
  revolver: {
    grip: { x: 0.042, y: -0.012, z: -0.055 },
    support: null,
  },
  longarc: {
    grip: { x: 0.045, y: 0.015, z: -0.10 },                // dominant palm wraps pistol grip.
    support: { x: -0.055, y: 0.005, z: -0.42, on: 'body' }, // foregrip cup under the rail shroud.
  },
  rocket: {
    grip: { x: 0.045, y: -0.02, z: -0.08 },                 // pistol grip under the tube.
    support: { x: -0.06, y: -0.03, z: -0.40, on: 'body' },  // forward handle under the tube.
  },
  lance: {
    grip: { x: 0.045, y: 0.015, z: -0.10 },                 // dominant palm wraps pistol grip.
    support: { x: -0.055, y: 0.005, z: -0.42, on: 'body' }, // cup under the rail shroud.
  },
  knife: {
    grip: { x: 0.020, y: -0.225, z: -0.035 },                // fist rides low: the baked glove
                                                            // cuff must stay under the 0.02 sight line.
    support: null,                                          // single hand: the blade is the support.
  },
};
