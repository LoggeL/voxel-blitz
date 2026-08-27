// public/js/guns/defs.js — Agent E: viewmodel FEEL profiles layered ON TOP of the canonical
// WEAPONS dict in shared/combatmath.js. Canonical damage/spread/reload numbers NEVER live here;
// TIMERS.rof literally references WEAPONS[x].rpm so the mirror cannot drift.
//
// EXPORT SURFACE (fixed by BUILD-CONTRACT): TIMERS, BOB, HANDS, DEPLOY, timerFor().
// Everything else is module-private.
//
// FRAME CONVENTIONS for this profile sheet:
//  - muzzle[] is in GUN-LOCAL meters (receiver origin, +x RIGHT on screen, +y up, -z forward).
//    Gun-local (not camera-local) was chosen deliberately: the hip offset is runtime state
//    (hip <-> ADS lerp), so a camera-local constant would lie half the time. Consumers never do
//    manual math — ViewmodelRig.getMuzzleWorldPos(out) always returns the live transformed tip.
//  - times are SECONDS unless suffixed Ms (milliseconds). Timeline fractions are 0..1 of the
//    reload/equip duration supplied by the caller.
//  - Camera/render strategy note (why there is no second pass): base FOV 75, near plane 0.01,
//    no font fetches, no textures except procedurally drawn canvas reticle.
import { WEAPONS } from '../../../shared/combatmath.js';
export const TIMERS = {
  rifle: {
    // Two-stage trigger: -0.02s negative pre-travel reads as tactile slack before hammer falls.
    tbase: -0.02,
    // Canonical mirrors below are REFERENCED from shared/combatmath.js — zero drift by
    // construction — and duplicated onto THIS sheet because viewmodel.js obeys a strict
    // "import three only" rule and must not touch combatmath itself.
    rof: WEAPONS.rifle.rpm,
    adsTime: WEAPONS.rifle.adsTime,
    deployTime: WEAPONS.rifle.deployTime,
    weightKg: WEAPONS.rifle.weightKg,
    viewKick: { pitchDeg: WEAPONS.rifle.kickDeg.pitch, yawDeg: WEAPONS.rifle.kickDeg.yaw },
    // Pause ladders in ms BETWEEN cluster groups; descending pauses = cadence climbs.
    bursts: [[100], [70], [52], [34]],
    // Per-group aim-walk nudges (rad), tiny ascending magnitude, alternating sign: recoil
    // descent drift-compensation feel, not a slide rule.
    anglesRad: [0.0016, -0.0021, 0.0027, -0.0035],
    // Extra ms BETWEEN bullets INSIDE a burst beyond the 60000/rof floor. 8ms stalls every
    // 3rd round — extractor hiccup flavor without breaking the 660rpm DPS envelope.
    interval: 8,
    // Shots consumed before the cadence ladder resets to group 0. 8 rounds = one rhythm cycle
    // of a 30-rd mag; keeps spray identity instead of a permanent metronome.
    clip: 8,
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
    adsOffset: { x: 0.012, y: -0.075, z: -0.43 },            // sights ride just under eye line.
    kick: { stiffness: 260, damping: 26, yawWobble: 1.0 },   // crispCRACK spring: fast in, fast out.
  },
  smg: {
    tbase: -0.01,
    rof: WEAPONS.smg.rpm,
    adsTime: WEAPONS.smg.adsTime,
    deployTime: WEAPONS.smg.deployTime,
    viewKick: { pitchDeg: WEAPONS.smg.kickDeg.pitch, yawDeg: WEAPONS.smg.kickDeg.yaw },
    weightKg: WEAPONS.smg.weightKg,
    bursts: [[55]],         // singles only, one tight uniform-ish group pause.
    anglesRad: [-0.0009],
    interval: 0,
    muzzle: [0.0, 0.020, -0.398],
    clip: 999,              // ladder effectively unclipped — one tempo, always.
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
    adsOffset: { x: 0.020, y: -0.080, z: -0.36 },            // close CheekY adapter pose.
    kick: { stiffness: 300, damping: 24, yawWobble: 1.25 },  // stiffer buzz with extra jitter.
  },
  shotgun: {
    // Same referenced-mirror scheme as rifle above.
    tbase: -0.02,
    rof: WEAPONS.shotgun.rpm,
    adsTime: WEAPONS.shotgun.adsTime,
    deployTime: WEAPONS.shotgun.deployTime,
    viewKick: { pitchDeg: WEAPONS.shotgun.kickDeg.pitch, yawDeg: WEAPONS.shotgun.kickDeg.yaw },
    weightKg: WEAPONS.shotgun.weightKg,
    bursts: [[0]],          // zero auto pause: mode 'pump' fully locks out via the pump cycle;
                            // the entry references rof pacing rather than driving anything.
    anglesRad: [0.0022],
    interval: 0, clip: 999,
    muzzle: [0.0, 0.060, -0.668],
    portY: 0.15, ejectRight: -0.06,
    barrelLen: 0.56,        // full-length exposed tube breech -0.11 -> muzzle.
    heatLen: [0.45, 0.75],  // shells run cool: heat band sits mid-barrel, gone before reload.
    boltTravel: 0.08,       // breach block throw feeding the pump linkage feel.
    rechargeDur: 0.09,      // slower ember fade suits cordite haze.
    pumpMag: 0.14,          // FULL frame rock on every dispatch — weight you feel in the wrists.
    cycleBack: true,
    cycleKind: 'pump',
    ejectOnFire: false,
    magTimeline: { start: 0.06, home: 0.94, clickAt: 0.0,
                   type: 'tube', repeatMs: 140 }, // tube loads: rhythmic thunk every 140ms.
    adsOffset: { x: 0.024, y: -0.078, z: -0.50 },
    kick: { stiffness: 300, damping: 30, yawWobble: 0.7 },   // violent, dead-straight rear shove.
  },

  sniper: {
    tbase: -0.02,
    rof: WEAPONS.sniper.rpm,
    adsTime: WEAPONS.sniper.adsTime,
    deployTime: WEAPONS.sniper.deployTime,
    viewKick: { pitchDeg: WEAPONS.sniper.kickDeg.pitch, yawDeg: WEAPONS.sniper.kickDeg.yaw },
    weightKg: WEAPONS.sniper.weightKg,
    bursts: [[1000]],       // INFORMATIONAL: rechambering is NOT auto-enqueued; mode 'bolt'
                            // drives rig.boltAnim() explicitly. The 1000ms documents intended
                            // slow-fire ceiling for designers reading the sheet.
    anglesRad: [-0.0010],
    interval: 0, clip: 999,
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
    adsOffset: { x: 0.006, y: -0.070, z: -0.34 },            // tucked in; HUD scope overlay owns zoom.
    kick: { stiffness: 160, damping: 18, yawWobble: 0.5 },   // heavyweight slow roll-over, tiny yaw.
  },
  lmg: {
    tbase: -0.02,
    rof: WEAPONS.lmg.rpm,
    adsTime: WEAPONS.lmg.adsTime,
    deployTime: WEAPONS.lmg.deployTime,
    weightKg: WEAPONS.lmg.weightKg,
    viewKick: { pitchDeg: WEAPONS.lmg.kickDeg.pitch, yawDeg: WEAPONS.lmg.kickDeg.yaw },
    bursts: [[70], [48], [32]],
    anglesRad: [0.0012, -0.0017, 0.0021],
    interval: 4,
    clip: 12,
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
    adsOffset: { x: 0.018, y: -0.073, z: -0.48 },
    kick: { stiffness: 205, damping: 25, yawWobble: 0.75 },
  },
  revolver: {
    tbase: -0.01,
    rof: WEAPONS.revolver.rpm,
    adsTime: WEAPONS.revolver.adsTime,
    deployTime: WEAPONS.revolver.deployTime,
    weightKg: WEAPONS.revolver.weightKg,
    viewKick: { pitchDeg: WEAPONS.revolver.kickDeg.pitch, yawDeg: WEAPONS.revolver.kickDeg.yaw },
    bursts: [[0]],
    anglesRad: [-0.0014],
    interval: 0,
    clip: 999,
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
    adsOffset: { x: 0.016, y: -0.073, z: -0.39 },
    kick: { stiffness: 235, damping: 22, yawWobble: 0.65 },
  },
};

/**
 * Walk / sprint / idle procedural-motion profile. Frequencies Hz, amplitudes meters, tilts radians.
 * figure-8: x = sin(pi*p), y = cos(2*pi*p) traces the classic lazy infinity loop.
 */
export const BOB = {
  walkFreq: 7.8,     // 4 quick strides/sec pair — tuned against 4.4 m/s walk speed.
  walkVert: 0.012,   // vertical head-of-hammer bounce.
  walkHorz: 0.006,   // half of vertical: figure-8 narrow waist.
  sprintFreq: 10,    // faster beat at 6.2 m/s.
  sprintAmpMul: 2.2, // and twice-plus-a-bit taller strokes.
  sprintTiltZ: 4 * (Math.PI / 180), // inward gun cant while sprinting — cute, cheap charm.
  crouchDampen: 0.65,// low crouch gait shortens the pendulum.
  airDampen: 0.30,   // airborne legs stop driving the loop; float calm.
  idleFreq: 1.6,     // breathing sine, 0.0016 m — life without noise-mud.
  idleAmp: 0.0016,
  swayPxPerUnit: 20, // mouse pixels consumed per unit of lag offset (look-inertia).
  swayClamp: 0.05,   // hard clamp (rad-equivalent) so flicks never fling the gun away.
  counterRoll: -1.4 * (Math.PI / 180), // z-roll opposite horizontal bob: handheld weight.
};

/**
 * Static hands pose sheet. Coordinates are GUN-LOCAL anchor points for baked glove blocks.
 *
 * DESIGN DECISION (documented per contract): two-hand IK is FAKE by construction — the gloves are
 * static posed box shapes baked into the model, welded at these anchors. Reasons: deterministic
 * frame cost (no IK solver), the chunky voxel aesthetic wants boxy gloves anyway, and the
 * viewmodel travels < 1.2 m so nobody sees wrist popping. The shotgun's off-hand welds to the
 * moving `pump` group (`on:'pump'`) so it rides the action for free — no IK needed anywhere.
 */
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
};

/** Equip ("draw") choreography, fractions of WEAPONS[id].deployTime. Shared by all six guns;
 * heavier weapons feel slower automatically through their canonical deploy times. */
export const DEPLOY = {
  raise: 0.38,     // first slice spends rising out of the equip dip.
  peak: 0.62,      // overshoot apex timing.
  settleBy: 0.85,  // oscillation fully quenched here; tail is micro-jitter only.
  overshoot: 1.12, // spring overshoot ratio past rest height.
  damping: 13.5,   // settle spring damping (1/s).
  startDrop: 0.10, // begin this far below rest pose (meters).
  startTilt: -9 * (Math.PI / 180), // initial muzzle-down tilt, eases upright across `raise`.
};

// Non-exported note constants documenting the VIEWMODEL CAMERA STRATEGY (kept for readers; the
// shipped solution does NOT use a second camera): the rig renders IN THE SAME SCENE as a child
// of the main camera (single pass, no renderer.autoClear tricks, no scissor). Apparent-size
// stability across ADS zoom is held by the SCALE TRICK: each frame the rig counter-scales by
// tan(baseFov/2)/tan(liveFov/2), which cancels perspective growth when WEAPONS.adsFov kicks in.
// nearPlane 0.01 guarantees the closest chrome (-z -0.34 minimum) never clips.
const VIEW_LAYERS = Object.freeze({
  baseFov: 75,
  nearPlane: 0.01,
  rejectedOverlayFov: 55, // the two-camera overlay pass we evaluated and dropped (extra clear,
                          // duplicated lighting, misaligned tracers). Kept here for archaeology.
});

/** Profile accessor with a forgiving fallback so HUD/FX glue never NPEs on a bad key. */
export function timerFor(weaponId) {
  const t = TIMERS[weaponId];
  return t || TIMERS.rifle;
}
