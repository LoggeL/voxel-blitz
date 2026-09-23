// public/js/guns/defs.js — Agent E: viewmodel FEEL profiles layered ON TOP of the canonical
// WEAPONS dict in shared/combatmath.js. Canonical damage/spread/reload numbers NEVER live here;
// TIMERS.rof literally references WEAPONS[x].rpm so the mirror cannot drift.
//
// EXPORT SURFACE (fixed by BUILD-CONTRACT): TIMERS, BOB, HANDS, DEPLOY, timerFor(), kickMassScale().
// Everything else is module-private.
//
// FRAME CONVENTIONS for this profile sheet:
//  - muzzle[] is in GUN-LOCAL meters (receiver origin, +x RIGHT on screen, +y up, -z forward).
//    Gun-local (not camera-local) was chosen deliberately: the hip offset is runtime state
//    (hip <-> ADS lerp), so a camera-local constant would lie half the time. Consumers never do
//    manual math — ViewmodelRig.getMuzzleWorldPos(out) always returns the live transformed tip.
//  - times are SECONDS unless suffixed Ms (milliseconds). Timeline fractions are 0..1 of the
//    reload/equip duration supplied by the caller.
//  - Camera/render strategy (why there is no second pass): the rig renders in the main scene as
//    a child of the camera (base FOV 75, near plane 0.01) and counter-scales by
//    tan(baseFov/2)/tan(liveFov/2) each frame, so ADS zoom never changes its apparent size.
import { WEAPONS } from '../../../shared/combatmath.js';
export const TIMERS = {
  rifle: {
    // Canonical mirrors below are REFERENCED from shared/combatmath.js — zero drift by
    // construction — so the rig's per-model sheet (model.T) carries them alongside the feel data.
    rof: WEAPONS.rifle.rpm,
    adsTime: WEAPONS.rifle.adsTime,
    deployTime: WEAPONS.rifle.deployTime,
    weightKg: WEAPONS.rifle.weightKg,
    viewKick: { pitchDeg: WEAPONS.rifle.recoil.pitch, yawDeg: WEAPONS.rifle.recoil.yaw },
    // Visual barrel tip, gun-local meters (see header). Receiver is built to touch this exactly.
    muzzle: [-0.012, 0.045, -0.598],
    portY: 0.16,        // ejector exit height (m) — feeds shell toss arc handed to FX.
    ejectRight: -0.07,  // sign kept verbatim from contract; rig emits along the TRUE world-right
                        // axis with this magnitude so ports fling right like a real rifle.
    barrelLen: 0.28,    // exposed barrel length (breech z -0.32 -> tip) — heat-band mapping span.
    heatLen: [0.50, 0.90], // heat glow starts halfway out, fades before the brake (flash hides it).
    boltTravel: 0.085,  // per-shot bolt reciprocation distance (m) — visible mechanical pulse.
    rechargeDur: 0.045, // uGlow capacitor-pop decay after each shot (exponential, tau=dur/3).
    pumpMag: 0,         // blowback frame shove; auto guns kick, they don't rock.
    cycleBack: false,   // no open-bolt staging; bolt snaps home the same tick.
    cycleKind: null,
    ejectOnFire: true,
    magTimeline: { start: 0.22, home: 0.78, clickAt: 0.90, type: 'mag' }, // symmetric magwell.
    adsOffset: { x: 0.0, y: -0.145, z: -0.68 },              // iron-sight line on camera axis.
    kick: { stiffness: 260, damping: 26, yawWobble: 1.0 },   // crispCRACK spring: fast in, fast out.
  },
  smg: {
    rof: WEAPONS.smg.rpm,
    adsTime: WEAPONS.smg.adsTime,
    deployTime: WEAPONS.smg.deployTime,
    viewKick: { pitchDeg: WEAPONS.smg.recoil.pitch, yawDeg: WEAPONS.smg.recoil.yaw },
    weightKg: WEAPONS.smg.weightKg,
    muzzle: [0.0, 0.020, -0.398],
    portY: 0.13, ejectRight: -0.05,
    barrelLen: 0.19,        // shrouded stub breech -0.21 -> muzzle.
    heatLen: [0.55, 0.95],  // suppressor shroud heats along nearly its whole skin.
    boltTravel: 0.06,       // short stroke — it reciprocates 15x/sec, keep it subtle.
    rechargeDur: 0.03,      // quickest pop of the roster; strobe-y with 900rpm.
    pumpMag: 0,
    cycleBack: false,
    cycleKind: null,
    ejectOnFire: true,
    magTimeline: { start: 0.18, home: 0.70, clickAt: 0.85, type: 'mag' }, // snappier slap.
    adsOffset: { x: 0.0, y: -0.112, z: -0.58 },              // compact notch/blade sight picture.
    kick: { stiffness: 300, damping: 24, yawWobble: 1.25 },  // stiffer buzz with extra jitter.
  },
  shotgun: {
    // Same referenced-mirror scheme as rifle above.
    rof: WEAPONS.shotgun.rpm,
    adsTime: WEAPONS.shotgun.adsTime,
    deployTime: WEAPONS.shotgun.deployTime,
    viewKick: { pitchDeg: WEAPONS.shotgun.recoil.pitch, yawDeg: WEAPONS.shotgun.recoil.yaw },
    weightKg: WEAPONS.shotgun.weightKg,
    muzzle: [0.0, 0.060, -0.668],
    portY: 0.15, ejectRight: -0.06,
    barrelLen: 0.56,        // full-length exposed tube breech -0.11 -> muzzle.
    heatLen: [0.45, 0.75],  // shells run cool: heat band sits mid-barrel, gone before reload.
    boltTravel: 0.08,       // breach block throw feeding the pump linkage feel.
    rechargeDur: 0.09,      // slower ember fade suits cordite haze.
    pumpMag: 0.10,          // Firm pump impulse without throwing the sight picture off target.
    cycleBack: true,
    cycleKind: 'pump',
    ejectOnFire: false,
    magTimeline: { start: 0.06, home: 0.94, clickAt: 0.0,
                   type: 'tube', repeatMs: 140 }, // tube loads: rhythmic thunk every 140ms.
    adsOffset: { x: 0.0, y: -0.100, z: -0.74 },
    kick: { stiffness: 320, damping: 34, yawWobble: 0.55 },  // decisive shove with a quick recovery.
  },

  sniper: {
    rof: WEAPONS.sniper.rpm,
    adsTime: WEAPONS.sniper.adsTime,
    deployTime: WEAPONS.sniper.deployTime,
    viewKick: { pitchDeg: WEAPONS.sniper.recoil.pitch, yawDeg: WEAPONS.sniper.recoil.yaw },
    weightKg: WEAPONS.sniper.weightKg,
    cycleMs: 1000,          // bolt rechamber length; mode 'bolt' drives rig.boltAnim() explicitly.
    muzzle: [0.0, 0.055, -0.760],
    portY: 0.15, ejectRight: -0.07,
    barrelLen: 0.50,        // long fluted pipe breech -0.26 -> muzzle.
    heatLen: [0.60, 0.92],  // mirage shimmer creeps to the flanker-brake tip.
    boltTravel: 0.16,       // rotary long-throw handle — the theatrical signature.
    rechargeDur: 0.12,      // capacitor whine lingers; sells the charge-up fantasy.
    pumpMag: 0,
    cycleBack: true,
    cycleKind: 'bolt',
    ejectOnFire: false,
    magTimeline: { start: 0.35, home: 0.75, clickAt: 0.75, type: 'stripper' }, // one motion.
    adsOffset: { x: 0.0, y: -0.205, z: -0.72 },              // optic aligns during scope transition.
    kick: { stiffness: 160, damping: 18, yawWobble: 0.5 },   // heavyweight slow roll-over, tiny yaw.
  },
  lmg: {
    rof: WEAPONS.lmg.rpm,
    adsTime: WEAPONS.lmg.adsTime,
    deployTime: WEAPONS.lmg.deployTime,
    weightKg: WEAPONS.lmg.weightKg,
    viewKick: { pitchDeg: WEAPONS.lmg.recoil.pitch, yawDeg: WEAPONS.lmg.recoil.yaw },
    muzzle: [0.0, 0.055, -0.720],
    portY: 0.17,
    ejectRight: -0.075,
    barrelLen: 0.38,
    heatLen: [0.30, 0.94],
    boltTravel: 0.075,
    rechargeDur: 0.055,
    pumpMag: 0,
    cycleBack: false,
    cycleKind: null,
    ejectOnFire: true,
    magTimeline: { start: 0.16, home: 0.84, clickAt: 0.93, type: 'belt' },
    adsOffset: { x: 0.0, y: -0.155, z: -0.78 },
    kick: { stiffness: 205, damping: 25, yawWobble: 0.75 },
  },
  minigun: {
    rof: WEAPONS.minigun.rpm,
    adsTime: WEAPONS.minigun.adsTime,
    deployTime: WEAPONS.minigun.deployTime,
    weightKg: WEAPONS.minigun.weightKg,
    viewKick: { pitchDeg: WEAPONS.minigun.recoil.pitch, yawDeg: WEAPONS.minigun.recoil.yaw },
    muzzle: [0.0, 0.055, -0.880],
    portY: 0.17,
    ejectRight: -0.075,
    barrelLen: 0.53,
    heatLen: [0.30, 0.94],
    boltTravel: 0.075,
    rechargeDur: 0.055,
    pumpMag: 0,
    cycleBack: false,
    cycleKind: null,
    ejectOnFire: true,
    magTimeline: { start: 0.16, home: 0.84, clickAt: 0.93, type: 'belt' },
    adsOffset: { x: 0.0, y: -0.155, z: -0.78 },
    kick: { stiffness: 205, damping: 25, yawWobble: 0.75 },
  },
  revolver: {
    rof: WEAPONS.revolver.rpm,
    adsTime: WEAPONS.revolver.adsTime,
    deployTime: WEAPONS.revolver.deployTime,
    weightKg: WEAPONS.revolver.weightKg,
    viewKick: { pitchDeg: WEAPONS.revolver.recoil.pitch, yawDeg: WEAPONS.revolver.recoil.yaw },
    muzzle: [0.0, 0.040, -0.520],
    portY: 0.10,
    ejectRight: -0.04,
    barrelLen: 0.36,
    heatLen: [0.58, 0.94],
    boltTravel: 0.025,
    rechargeDur: 0.075,
    pumpMag: 0,
    cycleBack: false,
    cycleKind: null,
    ejectOnFire: false,
    magTimeline: { start: 0.14, home: 0.86, clickAt: 0.94, type: 'cylinder' },
    adsOffset: { x: 0.0, y: -0.105, z: -0.64 },
    kick: { stiffness: 235, damping: 22, yawWobble: 0.65 },
  },
  longarc: {
    // Automatic arc launcher: one bolt per cadence tick; the capacitor recharge
    // (rechargeDur) is the visual signature, not a mechanical cycle.
    rof: WEAPONS.longarc.rpm,
    adsTime: WEAPONS.longarc.adsTime,
    deployTime: WEAPONS.longarc.deployTime,
    weightKg: WEAPONS.longarc.weightKg,
    viewKick: { pitchDeg: WEAPONS.longarc.recoil.pitch, yawDeg: WEAPONS.longarc.recoil.yaw },
    muzzle: [0, 0.055, -0.71],
    portY: 0.15,
    ejectRight: -0.06,
    barrelLen: 0.41,        // exposed rail breech -0.30 -> tip.
    heatLen: [0.35, 0.9],   // coil-bank glow spans the rail length.
    boltTravel: 0.11,       // capacitor sled throw on recharge.
    rechargeDur: 0.14,      // slow cyan coil-glow decay sells the charge-up.
    pumpMag: 0,
    cycleBack: false,
    cycleKind: null,
    ejectOnFire: false,     // caseless slug: nothing to fling per shot.
    magTimeline: { start: 0.2, home: 0.8, clickAt: 0.9, type: 'mag' },
    adsOffset: { x: 0, y: -0.155, z: -0.78 },
    kick: { stiffness: 190, damping: 21, yawWobble: 0.55 },
  },
  rocket: {
    // Shoulder launcher: one rocket per tube, so there is no cycle; the "bolt" slot is the
    // arming lever that drops after the launch and the reload slides a fresh rocket in.
    rof: WEAPONS.rocket.rpm,
    adsTime: WEAPONS.rocket.adsTime,
    deployTime: WEAPONS.rocket.deployTime,
    weightKg: WEAPONS.rocket.weightKg,
    viewKick: { pitchDeg: WEAPONS.rocket.recoil.pitch, yawDeg: WEAPONS.rocket.recoil.yaw },
    muzzle: [0, 0.075, -0.78],
    portY: 0.1,
    ejectRight: -0.03,
    barrelLen: 0.56,        // tube from breech -0.22 -> muzzle.
    heatLen: [0.55, 0.95],  // backblast scorch near the tube mouth.
    boltTravel: 0.04,       // arming lever drop.
    rechargeDur: 0.22,      // slow orange glow decay after the launch.
    pumpMag: 0,
    cycleBack: false,
    cycleKind: null,
    ejectOnFire: false,     // nothing to fling: the rocket is the round.
    magTimeline: { start: 0.18, home: 0.84, clickAt: 0.92, type: 'mag' },
    adsOffset: { x: 0, y: -0.175, z: -0.62 },
    kick: { stiffness: 150, damping: 20, yawWobble: 0.7 },
  },
  lance: {
    // CL-9 VOLTLANCE: compact charge rail-lance. The trigger charges a lance cell; the
    // coherent lance leaves on release with zero mechanical cycle, so the capacitor
    // recharge (rechargeDur) is the whole visual signature, like the LONGARC above.
    rof: WEAPONS.lance.rpm,
    adsTime: WEAPONS.lance.adsTime,
    deployTime: WEAPONS.lance.deployTime,
    weightKg: WEAPONS.lance.weightKg,
    viewKick: { pitchDeg: WEAPONS.lance.recoil.pitch, yawDeg: WEAPONS.lance.recoil.yaw },
    muzzle: [0, 0.055, -0.72],
    portY: 0.15,
    ejectRight: -0.06,
    barrelLen: 0.42,        // exposed rail breech -0.30 -> tip.
    heatLen: [0.35, 0.9],   // coil-glow band spans the rail between the lance cells.
    boltTravel: 0.10,       // charging sled throw on recharge.
    rechargeDur: 0.16,      // violet-cyan coil-glow decay sells the cell venting.
    pumpMag: 0,
    cycleBack: false,
    cycleKind: null,
    ejectOnFire: false,     // the lance is a coherent particle spear: nothing to fling.
    magTimeline: { start: 0.2, home: 0.8, clickAt: 0.9, type: 'mag' },
    adsOffset: { x: 0, y: -0.155, z: -0.78 },   // shared 0.155 sight line with the rail optic.
    kick: { stiffness: 185, damping: 21, yawWobble: 0.6 },
  },
  knife: {
    // IRON PICK (slot id `knife`): a one-handed pickaxe. Melee never reloads and never
    // cycles — every field below still exists so the rig/action code can read the sheet
    // without mode special cases; `melee` skips flash, heat and the bolt-status cap.
    rof: WEAPONS.knife.rpm,
    adsTime: WEAPONS.knife.adsTime,
    deployTime: WEAPONS.knife.deployTime,
    weightKg: WEAPONS.knife.weightKg,
    viewKick: { pitchDeg: WEAPONS.knife.recoil.pitch, yawDeg: WEAPONS.knife.recoil.yaw },
    muzzle: [0, 0.02, -0.42],   // forward pick point; the 0.02 sight line runs along the head.
    portY: 0.05,
    ejectRight: 0,
    barrelLen: 0.40,        // fist -> pick point; heat-band mapping span (never lit).
    heatLen: [0.04, 0.12],  // unused: melee skips the heat sleeve.
    boltTravel: 0,          // no bolt: the per-shot jerk stroke no-ops on an empty group.
    rechargeDur: 0.09,
    pumpMag: 0,
    cycleBack: false,
    cycleKind: null,
    ejectOnFire: false,     // nothing to eject; swings consume no ammunition.
    magTimeline: { start: 0.1, home: 0.6, clickAt: 0, type: 'mag' }, // never plays: magSize 0.
    // No sights: aiming sets the pick back by the 75->68 deg adsFov zoom so it
    // frames like the hip hold, a touch down-right and clear of the aim.
    adsOffset: { x: 0.235, y: -0.255, z: -0.552 },
    kick: { stiffness: 320, damping: 26, yawWobble: 0.5 },  // light, snappy wrist snap.
    melee: true,
  },
};

TIMERS.flamethrower = {
  ...TIMERS.rocket,
  continuous: true,
  rof: WEAPONS.flamethrower.rpm, adsTime: WEAPONS.flamethrower.adsTime,
  deployTime: WEAPONS.flamethrower.deployTime, weightKg: WEAPONS.flamethrower.weightKg,
  viewKick: { pitchDeg: WEAPONS.flamethrower.recoil.pitch, yawDeg: WEAPONS.flamethrower.recoil.yaw },
  muzzle: [0, 0.065, -0.655],
  barrelLen: 0.435,
  heatLen: [0.50, 0.95],
  adsOffset: { x: 0, y: -0.158, z: -0.62 },
  boltTravel: 0.01, rechargeDur: 0.2,
};

TIMERS.glaive = {
  // GV-4 RIPTIDE: forearm-braced disc launcher. The "barrel" is the launch spindle the
  // seated disc rides on; the "bolt" is the flywheel drive wheel, which only nudges back.
  // Throw/return/catch choreography lives in glaive-presentation.js, not in a reload.
  rof: WEAPONS.glaive.rpm,
  adsTime: WEAPONS.glaive.adsTime,
  deployTime: WEAPONS.glaive.deployTime,
  weightKg: WEAPONS.glaive.weightKg,
  viewKick: { pitchDeg: WEAPONS.glaive.recoil.pitch, yawDeg: WEAPONS.glaive.recoil.yaw },
  muzzle: [0, 0, -0.40],  // spindle tip on the bore axis.
  portY: 0.08,
  ejectRight: 0,
  barrelLen: 0.30,        // spindle breech -0.10 -> tip.
  heatLen: [0.80, 1.0],   // friction glow on the spindle tip only (z -0.34..-0.40).
  boltTravel: 0.012,      // flywheel kick-back per throw.
  rechargeDur: 0,
  pumpMag: 0,
  cycleBack: false,
  cycleKind: null,
  ejectOnFire: false,     // the disc is the round and it comes back.
  // Never driven by R (R returns discs); kept for the cassette-lift timing only.
  // clickAt follows home so the lift cues stay in the canonical 1-2-3 order.
  magTimeline: { start: 0.2, home: 0.7, clickAt: 0.78, type: 'mag' },
  adsOffset: { x: 0, y: -0.150, z: -0.35 },   // ring sight on the camera axis; eye at gun z +0.35.
  kick: { stiffness: 190, damping: 18, yawWobble: 0.2 },
};

TIMERS.bubble = {
  // SB-1 SUDSBLASTER: the "barrel" is the teal nozzle; the "bolt" is the bulb plunger; the
  // "mag" is the screw-in soap tank. Fire/charge/idle choreography lives in bubble-presentation.js.
  rof: WEAPONS.bubble.rpm,
  adsTime: WEAPONS.bubble.adsTime,
  deployTime: WEAPONS.bubble.deployTime,
  weightKg: WEAPONS.bubble.weightKg,
  viewKick: { pitchDeg: WEAPONS.bubble.recoil.pitch, yawDeg: WEAPONS.bubble.recoil.yaw },
  muzzle: [0, 0.030, -0.540],   // nozzle bell lip = wand ring centre.
  portY: 0.09,
  ejectRight: 0,
  barrelLen: 0.24,              // nozzle tube -0.30 -> bell lip.
  heatLen: [0.80, 1.0],         // fx sleeve = cyan sheen on the bell on fire.
  boltTravel: 0.008,
  rechargeDur: 0.06,
  pumpMag: 0,
  cycleBack: false,
  cycleKind: null,
  ejectOnFire: false,           // soap, no brass.
  magTimeline: { start: 0.16, home: 0.80, clickAt: 0.90, type: 'mag' },
  adsOffset: { x: 0, y: -0.140, z: -0.42 },
  kick: { stiffness: 150, damping: 14, yawWobble: 0.55 },   // soft, wobbly spring.
};

TIMERS.mgl = {
  // GL-3 SKIPJACK: under-slung three-round cassette and 40 mm tube.
  rof: WEAPONS.mgl.rpm,
  adsTime: WEAPONS.mgl.adsTime,
  deployTime: WEAPONS.mgl.deployTime,
  weightKg: WEAPONS.mgl.weightKg,
  viewKick: { pitchDeg: WEAPONS.mgl.recoil.pitch, yawDeg: WEAPONS.mgl.recoil.yaw },
  muzzle: [0, 0.075, -0.782],
  portY: 0.13,
  ejectRight: -0.04,
  barrelLen: 0.44,
  heatLen: [0.62, 0.96],
  boltTravel: 0.025,
  rechargeDur: 0.18,
  pumpMag: 0,
  cycleBack: false,
  cycleKind: null,
  ejectOnFire: false,
  magTimeline: { start: 0.16, home: 0.80, clickAt: 0.90, type: 'mag' },
  adsOffset: { x: 0, y: -0.291, z: -0.70 }, // Center the SKIPJACK reflex dot on the shot ray.
  kick: { stiffness: 150, damping: 21, yawWobble: 0.45 },
};

/**
 * Walk / sprint / idle procedural-motion profile. Frequencies Hz, amplitudes meters, tilts radians.
 * figure-8: x = sin(pi*p), y = cos(2*pi*p) traces the classic lazy infinity loop.
 */
export const BOB = {
  walkFreq: 2.35,    // vertical steps/sec at the canonical 4.4 m/s walk speed.
  walkVert: 0.012,   // vertical head-of-hammer bounce.
  walkHorz: 0.006,   // half of vertical: figure-8 narrow waist.
  sprintFreq: 3.1,   // purposeful run cadence without rapid vertical vibration.
  sprintAmpMul: 2.2, // and twice-plus-a-bit taller strokes.
  sprintTiltZ: 4 * (Math.PI / 180), // inward gun cant while sprinting — cute, cheap charm.
  crouchDampen: 0.65,// low crouch gait shortens the pendulum.
  airDampen: 0.30,   // airborne legs stop driving the loop; float calm.
  airVelocityLag: 0.0028, // gun trails vertical body velocity rather than snapping with the camera.
  airOffsetClamp: 0.022,
  airSpringStiffness: 92,
  airSpringDamping: 16,
  jumpTakeoffImpulse: 0.32,
  landImpactImpulse: 0.44,
  airPitchPerMeter: -0.75,
  idleFreq: 1.6,     // breathing sine, 0.0016 m — life without noise-mud.
  idleAmp: 0.0016,
  counterRoll: -1.4 * (Math.PI / 180), // z-roll opposite horizontal bob: handheld weight.
  // Body-motion inertia: the gun trails strafes/stops on a loose spring (mass-scaled at runtime).
  leanMax: 0.028,    // meters of lateral lag at full strafe speed (6.2 m/s).
  surgeMax: 0.022,   // meters of fore/aft lag at full run speed.
  leanRollPerMeter: -0.9, // rad of cant per meter of lean: swings the muzzle into the strafe.
  bodySpringStiffness: 60,
  bodySpringDamping: 11,
};

/**
 * Kick-spring mass multiplier: <1 for heavy guns (slower, lazier springs), >1 for light ones.
 * Shared by the rig's recoil and body-inertia springs so every weight cue agrees.
 */
export function kickMassScale(weightKg) {
  const weight = Number.isFinite(weightKg) && weightKg > 0 ? weightKg : 3.4;
  return Math.max(0.55, Math.min(1.5, Math.pow(3.4 / weight, 0.4)));
}

/**
 * Static hands pose sheet. Coordinates are GUN-LOCAL anchor points for baked glove blocks.
 *
 * DESIGN DECISION (documented per contract): two-hand IK is FAKE by construction — the gloves are
 * static posed box shapes baked into the model, welded at these anchors. Reasons: deterministic
 * frame cost (no IK solver), the chunky voxel aesthetic wants boxy gloves anyway, and the
 * viewmodel travels < 1.2 m so nobody sees wrist popping. The shotgun's off-hand welds to the
 * moving `pump` group (`on:'pump'`) so it rides the action for free — no IK needed anywhere.
 */
export { HANDS } from '../../../shared/avatar-hands.js';

/** Equip ("draw") choreography, fractions of WEAPONS[id].deployTime. Shared by every weapon;
 * heavier weapons feel slower automatically through their canonical deploy times. */
export const DEPLOY = {
  raise: 0.38,     // first slice spends rising out of the equip dip.
  peak: 0.62,      // overshoot apex timing.
  settleBy: 0.85,  // oscillation fully quenched here; tail is micro-jitter only.
  overshoot: 1.12, // spring overshoot ratio past rest height.
  startDrop: 0.10, // begin this far below rest pose (meters).
  startTilt: -9 * (Math.PI / 180), // initial muzzle-down tilt, eases upright across `raise`.
};

/** Profile accessor with a forgiving fallback so HUD/FX glue never NPEs on a bad key. */
export function timerFor(weaponId) {
  const t = TIMERS[weaponId];
  return t || TIMERS.rifle;
}
