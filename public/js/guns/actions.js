// Internal reload, manual-cycle, and reciprocating-action choreography for the viewmodel rig.
import {
  CYCLE_FRACS,
  PUMP_MS,
  PUMP_REST,
  SNIPER_BOLT_MIN_S,
} from './models/common.js';
import { handlingStress, handlingVariant, hesitantProgress, reloadGripBeat, addHandlingPose } from './stress-handling.js';
import { RocketPresentation, resetRocketReload } from './rocket-presentation.js';

const NOOP = () => {};
const MOTION_KEYS = ['dip', 'rock', 'x', 'push', 'yaw', 'roll'];
const CYCLE_POSE_ANCHORS = Object.fromEntries(Object.entries(CYCLE_FRACS)
  .map(([kind, { s1, s2, s3 }]) => [kind, [0, s1, s2, s3, 1]]));

/** The traveling rocket belongs to the action; the chamber belongs to ammo authority. */
export function syncArcherAmmo(archer, mag) {
  archer.authoritativeMag = Math.max(0, Math.trunc(Number(mag) || 0));
  if (archer.reloading) return;
  archer.round.visible = false;
  archer.chambered.visible = archer.authoritativeMag > 0;
}

/** Place the remaining cassette shells in consecutive slots, starting at the top. */
export function presentSkipjackReserve(skipjack, reserve) {
  const rounds = skipjack.rounds;
  const count = Math.max(0, Math.min(rounds.length, Math.trunc(Number(reserve) || 0)));
  const first = rounds.length - count;
  const rise = first * (skipjack.roundPitch || 0.063);
  for (let i = 0; i < rounds.length; i++) {
    const round = rounds[i];
    round.position.copy(round.userData.homePosition);
    round.visible = i >= first;
    if (round.visible) round.position.y += rise;
  }
}

/** Keep the current transfer until the accepted shot reaches its chamber. */
export function syncSkipjackAmmo(skipjack, mag) {
  skipjack.authoritativeMag = Math.max(0, Math.trunc(Number(mag) || 0));
  if (skipjack.reload) return;
  const shot = skipjack.shot;
  if (shot) {
    if (skipjack.authoritativeMag === shot.expectedMag) {
      shot.confirmed = true;
      return;
    }
    if (skipjack.authoritativeMag === shot.fromMag && !shot.confirmed) return;
    skipjack.shot = null;
  }
  presentSkipjackReserve(skipjack, skipjack.authoritativeMag - 1);
}

// Receiver presentation, spent-ammo exit and fresh-ammo entry differ with the
// magazine well, feed system and carried mass. All paths meet the existing cues.
const RELOAD_STYLES = Object.freeze({
  rifle: { pose: [0.070, 0.46, -0.052, 0.050, 0.10, -0.34], exit: [-0.24, -1.30, 0.72], entry: [-0.12, -1.26, 0.66], twist: [0.32, 0, -0.18], socket: [-0.03, -0.15, -0.16] },
  smg: { pose: [0.095, 0.58, -0.080, 0.025, 0.16, -0.50], exit: [-0.36, -1.30, 0.85], entry: [-0.19, -1.30, 0.80], twist: [0.12, 0.24, -0.32], socket: [-0.03, -0.13, -0.14] },
  lmg: { pose: [0.050, 0.27, -0.090, 0.060, 0.15, -0.28], exit: [-0.40, -1.42, 0.74], entry: [-0.22, -1.42, 0.68], twist: [0.20, 0, -0.12], socket: [-0.10, -0.17, -0.12] },
  minigun: { pose: [0.015, 0.18, -0.070, 0.080, 0.25, -0.22], exit: [-0.35, -1.48, 0.72], entry: [-0.18, -1.48, 0.66], twist: [0, 0, -0.72], socket: [-0.08, -0.20, -0.22] },
  longarc: { pose: [0.060, 0.34, -0.030, 0.070, -0.18, -0.42], exit: [-0.30, -1.32, 0.76], entry: [-0.10, -1.32, 0.70], twist: [0.15, 0.48, -0.10], socket: [-0.03, -0.12, -0.17] },
  lance: { pose: [0.100, 0.26, -0.090, 0.040, 0.22, -0.60], exit: [-0.46, -1.30, 0.80], entry: [-0.20, -1.30, 0.72], twist: [0.05, -0.52, -0.16], socket: [-0.03, -0.11, -0.15] },
  flamethrower: { pose: [0.025, 0.26, -0.065, 0.065, -0.10, -0.36], exit: [-0.22, -1.40, 0.74], entry: [-0.08, -1.40, 0.68], twist: [0.95, 0, -0.12], socket: [-0.09, -0.17, -0.23] },
  // RIPTIDE never swaps a magazine: only the fabricate lift, cassette disc up onto the spindle.
  glaive: { pose: [0.020, 0.10, -0.015, 0.020, 0.04, -0.10], exit: [0, 0, 0], entry: [0, -0.114, 0.055], twist: [-0.105, 0, 0], socket: [-0.03, -0.08, 0.04] },
  // SUDSBLASTER: the soap bottle hangs canted under the receiver; the palm cups its base.
  bubble: { pose: [0.050, 0.30, -0.060, 0.030, 0.18, -0.46], exit: [-0.30, -1.10, 0.30], entry: [-0.24, -1.05, 0.26], twist: [0.10, 0, 0.45], socket: [-0.05, -0.13, -0.11] },
});

/**
 * Owns the three weapon-action state machines. Callbacks are deliberately narrow so this module
 * never needs the ViewmodelRig host object; their order at timing boundaries is contractual.
 */
export class WeaponActions {
  constructor({
    onBoltClack = NOOP,
    onShellEject = NOOP,
    onReloadClick = NOOP,
    onPumpImpulse = NOOP,
  } = {}) {
    this._callbacks = { onBoltClack, onShellEject, onReloadClick, onPumpImpulse };
    this._reload = null;
    this._cycle = null;
    this._jerk = null;
    this._return = null;
    this._actionSequence = 0;
    this._stress = 0;
    this._phaseStress = 0;
    this._pain = 0;
    this._gripBeat = 0;
    this._variant = 0.5;
    // Position offsets are meters; pitch (rock), yaw and roll are radians.
    this._motion = { dip: 0, rock: 0, x: 0, push: 0, yaw: 0, roll: 0 };
    this._rocketPresentation = new RocketPresentation(this);
    this._disposed = false;
  }

  get reloading() { return this._reload !== null; }
  get cycling() { return this._cycle !== null; }

  /** Clear all transient action state and restore the supplied model's moving parts. */
  reset(model = null) {
    if (model) this._resetModelPose(model);
    this._reload = null;
    this._cycle = null;
    this._jerk = null;
    this._return = null;
    this._stress = this._phaseStress = this._pain = this._gripBeat = 0;
    this._clearMotion();
  }

  /** Idempotent teardown; a disposed action controller cannot be restarted. */
  dispose(model = null) {
    if (this._disposed) return;
    this.reset(model);
    this._callbacks = null;
    this._disposed = true;
  }

  /** Start magazine, belt, tube, stripper, or cylinder choreography. */
  startReload(now, dur, type, T, stages = null) {
    if (this._disposed || !(dur > 0) || !T || T.melee) return false;
    this._cycle = null;
    this._jerk = null;
    this._return = null;
    const profileType = T.magTimeline.type || 'mag';
    const effectiveType = !type || type === 'magswap' ? profileType : type;
    this._reload = {
      t0: now,
      dur,
      type: effectiveType,
      clicks: 0,
      thunks: 0,
      lastFrac: 0,
      done: false,
      variant: handlingVariant(++this._actionSequence),
      // Staged tube loads thunk exactly when the authority seats each round.
      stages: stages && stages.perRoundSeconds > 0 ? {
        start: stages.startSeconds,
        perRound: stages.perRoundSeconds,
        rounds: Math.max(0, stages.rounds | 0),
      } : null,
    };
    return true;
  }

  /** Restore moving parts immediately; optionally ease the held gun back to its ready pose. */
  cancelReload(model = null, { smooth = false } = {}) {
    if (!this._reload) return false;
    this._return = smooth ? { ...this._motion, elapsed: 0 } : null;
    if (model) this._resetReloadPose(model);
    this._reload = null;
    this._gripBeat = 0;
    this._phaseStress = 0;
    this._clearMotion();
    return true;
  }

  /** Latch the pre-shot cassette count before the ammo authority decrements it. */
  beginSkipjackShot(model, mag) {
    const skipjack = model?.extra.userData.skipjack;
    if (this._disposed || !skipjack || skipjack.reload || skipjack.shot) return false;
    const fromMag = Math.trunc(Number(mag) || 0);
    const fromReserve = Math.min(skipjack.rounds.length, fromMag - 1);
    if (fromReserve <= 0) return false;
    skipjack.shot = { fromMag, expectedMag: fromMag - 1, fromReserve, confirmed: false };
    return true;
  }

  /** Start the short automatic bolt/hammer reciprocation used by non-cycleBack weapons. */
  startJerk(weaponId, model, travel, dur) {
    if (this._disposed || !model) return false;
    const revolver = weaponId === 'revolver';
    const skipjack = weaponId === 'mgl' && model.extra.userData.skipjack?.feed
      ? model.extra.userData.skipjack : null;
    this._jerk = {
      t: 0,
      dur: revolver ? Math.max(0.11, dur) : skipjack ? Math.max(0.23, dur) : dur,
      travel,
      revolver,
      skipjack,
      feedStart: skipjack ? skipjack.feed.rotation.z % (Math.PI * 2) : 0,
      cylinderStart: revolver ? (model.extra.userData.revolver?.cylinder.rotation.z ?? model.mag.rotation.z) : 0,
    };
    if (revolver && model.extra.userData.revolver) {
      // The chamber locks before the shot; recoil must not spin the drum beneath the barrel.
      model.extra.userData.revolver.cylinder.rotation.z = this._jerk.cylinderStart + Math.PI / 3;
    }
    return true;
  }

  /** Begin a mode-driven pump or bolt cycle. */
  beginCycle(kind, silentStall, T) {
    if (this._disposed || !T?.cycleBack || this._cycle) return false;
    let durMs = kind === 'pump' ? PUMP_MS : T.cycleMs || 900;
    if (kind === 'bolt') durMs = Math.max(SNIPER_BOLT_MIN_S * 1000, durMs);
    this._cycle = { kind, dur: durMs / 1000, t: 0, step: 0, silent: !!silentStall,
      variant: handlingVariant(++this._actionSequence) };
    return true;
  }

  /**
   * Advance active states in the rig's original order: reload, jerk, then manual cycle.
   * The returned object is stable and owned here, avoiding a per-frame choreography allocation.
   */
  update(now, dt, model, T, conditions = {}) {
    const motion = this._motion;
    this._clearMotion();
    if (this._disposed || !model || !T) return motion;
    this._stress = handlingStress(conditions);
    this._pain = conditions.pain || 0;
    this._gripBeat = 0;
    if (this._return) {
      const returning = this._return;
      returning.elapsed += Math.max(0, dt);
      const u = Math.min(1, returning.elapsed / (conditions.reducedMotion ? 0.06 : 0.16));
      const remaining = 1 - this._smooth01(u);
      for (const key of MOTION_KEYS) motion[key] = returning[key] * remaining;
      if (u >= 1) this._return = null;
    }
    if (this._reload) {
      const reload = this._reload;
      const elapsed = now - reload.t0;
      const frac = Math.max(0, Math.min(1, elapsed / reload.dur));
      this._variant = reload.variant;
      this._phaseStress = this._stress;
      const gripBeat = reloadGripBeat(frac, elapsed, reload, T.magTimeline, this._variant);
      this._gripBeat = gripBeat * this._stress;
      this._updateReload(now, model, T, motion);
      if (this._reload) addHandlingPose(motion, frac, this._stress, this._pain,
        this._variant, gripBeat);
    }
    // Springs, automatic bolts and cassette feeds run mechanically; fear only
    // reshapes the hands' reload route and the explicit manual cycle below.
    this._phaseStress = 0;
    if (this._jerk) this._stepJerk(model, dt);
    if (this._cycle) this._stepCycle(model, T, dt, motion);
    return motion;
  }

  _resetReloadPose(model) {
    model.mag.visible = true;
    model.mag.position.set(0, 0, 0);
    model.mag.rotation.x = 0;
    model.mag.rotation.y = 0;
    const revolver = model.extra.userData.revolver;
    if (!revolver) model.mag.rotation.z = 0;
    const reloadHand = model.extra.userData.reloadHand;
    if (reloadHand) {
      reloadHand.hand.position.copy(reloadHand.position);
      reloadHand.hand.quaternion.copy(reloadHand.quaternion);
      reloadHand.hand.visible = reloadHand.visible;
    }
    model.bolt.position.set(0, 0, 0);
    model.bolt.rotation.set(0, 0, 0);
    if (revolver) {
      revolver.crane.rotation.z = 0;
      revolver.ejector.position.z = 0;
      revolver.cases.position.set(0, 0, 0);
      revolver.cases.visible = true;
    }
    const cover = model.extra.userData.reloadPart;
    if (cover) cover.rotation.set(0, 0, 0);
    const lead = model.extra.userData.beltLead;
    if (lead) {
      lead.visible = true;
      lead.position.copy(lead.userData.homePosition);
      lead.rotation.set(0, 0, 0);
    }
    // The rocket reload swings the gate about its side pin and yaws the round
    // (the arming lever rides model.bolt, zeroed above); restore all of it.
    const rocket = model.extra.userData.rocketReload;
    resetRocketReload(rocket);
    const stinger = model.extra.userData.stinger;
    if (stinger) {
      for (const clamp of stinger.clamps || []) clamp.rotation.set(0, 0, 0);
      stinger.latch?.rotation.set(0, 0, 0);
      if (stinger.frontCover) stinger.frontCover.visible = (stinger.authoritativeMag ?? 1) > 0;
    }
    const archer = model.extra.userData.archer;
    if (archer?.round) {
      archer.reloading = false;
      archer.gate.position.copy(archer.hinge);
      archer.gate.rotation.set(0, 0, 0);
      archer.round.position.copy(archer.seat);
      archer.round.rotation.set(0, 0, 0);
      syncArcherAmmo(archer, archer.authoritativeMag);
    }
    const skipjack = model.extra.userData.skipjack;
    if (skipjack) {
      skipjack.cassette.position.copy(skipjack.cassette.userData.homePosition);
      skipjack.cassette.rotation.set(0, 0, 0);
      skipjack.cassette.visible = true;
      skipjack.reload = null;
      skipjack.shot = null;
      presentSkipjackReserve(skipjack, skipjack.authoritativeMag - 1);
    }
    const rounds = model.extra.userData.reloadRounds;
    if (rounds) {
      rounds.visible = false;
      for (const child of rounds.children) child.visible = true;
      if (revolver || rocket) rounds.rotation.set(0, 0, 0);
      if (rounds.userData.homePosition) rounds.position.copy(rounds.userData.homePosition);
    }
    const cartridges = model.extra.userData.cartridges;
    for (let i = 0; i < cartridges.length; i++) {
      const cartridge = cartridges[i];
      cartridge.visible = false;
      cartridge.position.y = 0.115 + i * 0.016;
    }
  }

  _resetModelPose(model) {
    this._resetReloadPose(model);
    model.mag.rotation.z = 0;
    const revolver = model.extra.userData.revolver;
    if (revolver) {
      revolver.cylinder.rotation.z = 0;
      revolver.hammer.rotation.x = 0;
    }
    model.bolt.position.set(0, 0, 0);
    model.bolt.rotation.set(0, 0, 0);
    if (model.extra.userData.skipjack?.feed) model.extra.userData.skipjack.feed.rotation.z = 0;
    model.triggerGroup.rotation.set(0, 0, 0);
    if (model.pump) model.pump.position.copy(PUMP_REST);
  }

  _stepJerk(model, dt) {
    const jerk = this._jerk;
    jerk.t += dt;
    const u = Math.min(1, jerk.t / jerk.dur);
    const stroke = jerk.skipjack
      ? this._phase(u, 0, 0.16) * (1 - this._phase(u, 0.25, 0.72))
      : Math.sin(Math.PI * u);
    model.triggerGroup.rotation.x = 0.20 * stroke;
    if (jerk.revolver) {
      const revolver = model.extra.userData.revolver;
      if (revolver) {
        revolver.hammer.rotation.x = 0.65 * (1 - this._smooth01(Math.min(1, u / 0.24)));
      } else {
        model.bolt.rotation.x = -0.70 * stroke;
        model.mag.rotation.z = jerk.cylinderStart + (Math.PI / 3) * this._smooth01(u);
      }
    } else if (jerk.skipjack) {
      // The rotary feed advances one chamber as the exposed charging pawl
      // punches back, then settles before the next shot at full fire rate.
      const index = this._phase(u, 0.05, 0.37);
      const settle = this._contact(u, 0.37, 0.28);
      jerk.skipjack.feed.rotation.z = jerk.feedStart + Math.PI / 3 * index + 0.045 * settle;
      model.bolt.position.z = stroke * jerk.travel;
      model.bolt.rotation.x = -0.22 * stroke;
      if (jerk.skipjack.shot) this._animateSkipjackFeed(jerk.skipjack,
        jerk.skipjack.shot.fromReserve, u);
    } else {
      model.bolt.position.z = stroke * jerk.travel;
    }
    if (u >= 1) {
      model.bolt.position.z = 0;
      model.bolt.rotation.x = 0;
      model.triggerGroup.rotation.x = 0;
      if (jerk.skipjack?.shot) {
        jerk.skipjack.shot = null;
        presentSkipjackReserve(jerk.skipjack, jerk.skipjack.authoritativeMag - 1);
      }
      this._jerk = null;
    }
  }

  /** The top shell lifts clear, slides into the receiver, and lower shells rise behind it. */
  _animateSkipjackFeed(skipjack, fromReserve, u) {
    if (fromReserve <= 0) return;
    const rounds = skipjack.rounds;
    const first = rounds.length - fromReserve;
    const pitch = skipjack.roundPitch || 0.063;
    const source = rounds[first];
    const home = source.userData.homePosition;
    const center = source.userData.homeCenter;
    const target = skipjack.chamberAnchor;
    presentSkipjackReserve(skipjack, fromReserve);
    const push = this._phase(u, 0.12, 0.67);
    for (let i = first + 1; i < rounds.length; i++) rounds[i].position.y += pitch * push;
    const lift = this._phase(u, 0.03, 0.34) * (1 - this._phase(u, 0.34, 0.66));
    // Seat before the visibility handoff, including at 30 FPS: the last visible
    // pose is inside the bore rather than a shell floating above the receiver.
    const slide = this._phase(u, 0.32, 0.70);
    const fromY = center.y + first * pitch;
    source.position.set(home.x + (target.x - center.x) * slide,
      home.y + first * pitch + pitch * 0.75 * lift + (target.y - fromY) * slide,
      home.z + (target.z - center.z) * slide);
    source.visible = u < 0.84;
    if (u >= 0.84) presentSkipjackReserve(skipjack, fromReserve - 1);
  }

  _stepCycle(model, T, dt, out) {
    const cycle = this._cycle;
    const fractions = CYCLE_FRACS[cycle.kind];
    this._variant = cycle.variant;
    cycle.t += dt;
    const u = Math.min(1, cycle.t / cycle.dur);

    if (cycle.step < 1 && u >= fractions.s1) {
      cycle.step = 1;
      this._callbacks.onBoltClack(1);
    }
    if (cycle.step < 2 && u >= fractions.s2) {
      cycle.step = 2;
      this._callbacks.onBoltClack(2);
      this._callbacks.onShellEject();
      if (cycle.kind === 'pump') this._callbacks.onPumpImpulse(T.pumpMag * 2.0);
    }
    if (cycle.step < 3 && u >= fractions.s3) {
      cycle.step = 3;
      this._callbacks.onBoltClack(3);
    }

    // Reaches hesitate only between the existing mechanical contacts. Every
    // clack, ejection and ready deadline above still reads the real clock.
    const anchors = CYCLE_POSE_ANCHORS[cycle.kind];
    let poseU = u;
    for (let i = 1; i < anchors.length; i++) {
      if (u <= anchors[i]) {
        const from = anchors[i - 1], span = anchors[i] - from;
        poseU = from + hesitantProgress((u - from) / span, this._stress, this._variant) * span;
        break;
      }
    }
    if (cycle.kind === 'pump' && model.pump) {
      model.pump.position.z = PUMP_REST.z + Math.sin(Math.PI * poseU) * 0.10;
    } else if (cycle.kind === 'bolt') {
      const s1 = fractions.s1;
      const s3 = fractions.s3;
      const lift = poseU < s1 ? 0.45 * (poseU / s1)
        : poseU > s3 ? 0.45 * (1 - (poseU - s3) / (1 - s3))
        : 0.45;
      model.bolt.position.z = Math.sin(Math.PI * poseU) * T.boltTravel;
      model.bolt.rotation.z = lift;
    }
    addHandlingPose(out, u, this._stress, this._pain, this._variant,
      Math.sin(Math.PI * u) ** 2, true);

    if (u >= 1) {
      model.bolt.position.z = 0;
      model.bolt.rotation.z = 0;
      if (model.pump) model.pump.position.z = PUMP_REST.z;
      this._cycle = null;
    }
  }

  _updateReload(now, model, T, out) {
    const reload = this._reload;
    const timeline = T.magTimeline;
    const frac = Math.max(0, Math.min(1, (now - reload.t0) / reload.dur));

    if (reload.type === 'tube') {
      const elapsed = now - reload.t0;
      if (reload.stages) {
        while (reload.thunks < reload.stages.rounds && elapsed >=
            reload.stages.start + (reload.thunks + 1) * reload.stages.perRound) {
          reload.thunks++;
          this._callbacks.onReloadClick(((reload.thunks - 1) % 3) + 1);
        }
      } else {
        const thunkEvery = (timeline.repeatMs || 140) / 1000;
        if (frac >= timeline.start && frac < timeline.home &&
            now - (reload.lastThunk || 0) >= thunkEvery) {
          reload.lastThunk = now;
          reload.thunks++;
          this._callbacks.onReloadClick(((reload.thunks - 1) % 3) + 1);
        }
      }
      // Present the loading port quickly, hold it steady, then punch each shell
      // into the tube at the same instant as its canonical seating click.
      const present = this._phase(frac, 0.015, 0.13) * (1 - this._phase(frac, 0.91, 1));
      let seatPulse = 0;
      if (reload.stages?.rounds > 0) {
        const first = reload.stages.start + reload.stages.perRound;
        const nearest = Math.max(0, Math.min(reload.stages.rounds - 1,
          Math.round((elapsed - first) / reload.stages.perRound)));
        seatPulse = this._contact(elapsed, first + nearest * reload.stages.perRound, 0.095);
      }
      out.rock = 0.30 * present + 0.10 * seatPulse;
      out.dip = 0.045 * present + 0.016 * seatPulse;
      out.x = -0.025 * present;
      out.push = 0.025 * present - 0.026 * seatPulse;
      out.yaw = 0.06 * present;
      out.roll = -0.24 * present - 0.045 * seatPulse;
      this._updateShellReload(elapsed, frac, model, reload, timeline);
      reload.lastFrac = frac;
      if (frac >= 1) {
        this._resetReloadPose(model);
        this._reload = null;
        this._clearMotion();
      }
      return;
    }

    if (reload.type === 'cylinder' && model.extra.userData.revolver) {
      this._updateCylinderReload(frac, model, out);
      reload.lastFrac = frac;
      if (frac >= 1) {
        this._resetReloadPose(model);
        this._reload = null;
        this._clearMotion();
      }
      return;
    }

    if (model.extra.userData.archer?.round) {
      this._updateArcherReload(frac, model, out);
      reload.lastFrac = frac;
      if (frac >= 1) {
        this._resetReloadPose(model);
        this._reload = null;
        this._clearMotion();
      }
      return;
    }

    if (model.extra.userData.rocketReload) {
      this._rocketPresentation.update(frac, model, out);
      reload.lastFrac = frac;
      if (frac >= 1) {
        this._resetReloadPose(model);
        this._reload = null;
        this._clearMotion();
      }
      return;
    }

    if (model.extra.userData.skipjack) {
      this._updateSkipjackReload(frac, model, T, out);
      reload.lastFrac = frac;
      if (frac >= 1) {
        this._resetReloadPose(model);
        this._reload = null;
        this._clearMotion();
      }
      return;
    }

    if (model.extra.userData.stinger?.canister) {
      this._updateStingerReload(frac, model, T, out);
      reload.lastFrac = frac;
      if (frac >= 1) {
        this._resetReloadPose(model);
        this._reload = null;
        this._clearMotion();
      }
      return;
    }

    const hasMovingAmmo = model.magazines ? 1 : 0;
    const isBelt = reload.type === 'belt';
    const isCylinder = reload.type === 'cylinder';
    const liftEnd = Math.min(0.16, timeline.start * 0.82);
    const grip = this._phase(frac, 0.025, liftEnd) *
      (1 - this._phase(frac, Math.max(0.82, timeline.home), 0.99));
    const anticipate = this._phase(frac, 0, 0.025) * (1 - this._phase(frac, 0.025, 0.09));
    const pullEnd = timeline.start + Math.min(0.085, (timeline.home - timeline.start) * 0.20);
    const pull = this._phase(frac, timeline.start, pullEnd);
    const insert = this._phase(frac, timeline.home - 0.085, timeline.home);
    const removed = pull * (1 - insert);
    const tug = this._contact(frac, pullEnd, 0.10);
    const seat = this._contact(frac, timeline.home, Math.min(0.09, (1 - timeline.home) * 0.7));
    const latch = timeline.clickAt > timeline.home
      ? this._contact(frac, timeline.clickAt, Math.min(0.055, (1 - timeline.clickAt) * 0.75)) : 0;
    const style = RELOAD_STYLES[model.root.name.slice(4)] || RELOAD_STYLES.rifle;
    const pose = style.pose;
    // Snatch up and cant, brace through the swap, then separate seating and
    // charging-handle contacts from the final return to the shoulder.
    out.dip = pose[0] * grip - 0.018 * anticipate - 0.020 * tug + 0.030 * seat - 0.016 * latch;
    out.rock = pose[1] * grip - 0.08 * anticipate + 0.10 * tug - 0.14 * seat + 0.10 * latch;
    out.x = pose[2] * grip - 0.025 * tug + 0.014 * seat;
    out.push = pose[3] * grip + 0.035 * tug - 0.055 * seat + 0.036 * latch;
    out.yaw = pose[4] * grip - 0.06 * tug + 0.025 * seat;
    out.roll = pose[5] * grip + 0.10 * tug - 0.10 * seat + 0.06 * latch;

    if (reload.type === 'mag' || isBelt || isCylinder) {
      if (frac >= timeline.start && reload.lastFrac < timeline.start) {
        this._callbacks.onReloadClick(1);
      }
      if (frac >= timeline.home && reload.lastFrac < timeline.home) {
        this._callbacks.onReloadClick(2);
      }
    }

    const mag = model.mag;
    if (mag) {
      if (isCylinder) {
        mag.position.x = -0.075 * removed * hasMovingAmmo;
        mag.position.y = 0.012 * removed * hasMovingAmmo;
        mag.rotation.y = -1.05 * removed * hasMovingAmmo;
      } else if (reload.type !== 'stripper') {
        // A spent magazine crosses the lower edge, stays out of view while the
        // hand finds a replacement, then a fresh magazine enters on its own path.
        const exitEnd = timeline.start + Math.min(0.20, (timeline.home - timeline.start) * 0.34);
        const enterStart = timeline.home - 0.21;
        const exiting = frac < enterStart;
        const amount = exiting ? this._phase(frac, timeline.start, exitEnd)
          : 1 - this._phase(frac, enterStart, timeline.home);
        const path = exiting ? style.exit : style.entry;
        mag.position.set(path[0] * amount, path[1] * amount, path[2] * amount);
        mag.rotation.set(style.twist[0] * amount, style.twist[1] * amount, style.twist[2] * amount);
        mag.visible = !(frac >= exitEnd && frac < enterStart);
        if (!exiting && mag.visible) {
          // A small failed alignment and second grip, finished before seating.
          // The hand target below follows this same magazine, never detaches.
          const side = this._variant < 0.5 ? -1 : 1;
          mag.position.x += side * 0.018 * this._gripBeat;
          mag.position.z += 0.012 * this._gripBeat;
          mag.rotation.z += side * 0.12 * this._gripBeat;
        }
        if (isBelt) {
          this._updateBeltReload(frac, model, T, timeline, style, out);
        } else {
          this._moveReloadHand(model, style.socket[0] + mag.position.x,
            style.socket[1] + mag.position.y, style.socket[2] + mag.position.z,
            this._phase(frac, 0.05, timeline.start) * (1 - this._phase(frac, timeline.home, 0.98)), mag.visible);
        }
      }
    }

    const rounds = model.extra.userData.reloadRounds;
    if (isCylinder && rounds) {
      const insert = this._smooth01(Math.max(0, Math.min(1,
        (frac - timeline.start) / Math.max(0.001, timeline.home - timeline.start))));
      rounds.visible = frac >= timeline.start && frac < timeline.home;
      const home = rounds.userData.homePosition;
      rounds.position.set(home.x + insert * 0.052, home.y - insert * 0.012, home.z);
    }

    if (frac >= timeline.clickAt && reload.lastFrac < timeline.clickAt && !reload.done) {
      this._callbacks.onReloadClick(3);
      reload.done = true;
    }
    reload.lastFrac = frac;

    if (reload.type === 'stripper') {
      const open = this._phase(frac, 0.08, 0.24) * (1 - this._phase(frac, 0.80, 0.95));
      model.bolt.position.z = T.boltTravel * open;
      model.bolt.rotation.z = 0.5 * open;
      out.rock = 0.28 * grip + 0.10 * seat;
      out.yaw = -0.22 * grip;
      out.roll = -0.58 * grip;
      const cartridges = model.extra.userData.cartridges;
      const showAll = frac >= timeline.start && frac < timeline.clickAt;
      for (let i = 0; i < cartridges.length; i++) {
        const feed = this._phase(
          (frac - timeline.start) / Math.max(0.001, timeline.clickAt - timeline.start) - i * 0.10, 0, 1);
        const cartridge = cartridges[i];
        cartridge.visible = showAll && feed > 0 && feed < 0.98;
        cartridge.position.y = 0.115 + i * 0.016 + (1 - feed) ** 2 * 0.80 - feed * 0.06;
      }
      const feed = this._phase(frac, timeline.start, timeline.clickAt);
      this._moveReloadHand(model, -0.02, 0.17 + (1 - feed) ** 2 * 0.80, -0.13,
        this._phase(frac, 0.22, timeline.start) * (1 - this._phase(frac, timeline.clickAt, 0.94)));
    }

    if (frac >= 1) {
      this._resetReloadPose(model);
      this._reload = null;
      this._clearMotion();
    }
  }

  /** Release the cradle, lift out the spent launch tube, and clamp in a fresh one. */
  _updateStingerReload(frac, model, T, out) {
    const parts = model.extra.userData.stinger;
    const canister = parts.canister;
    const { start, home, clickAt } = T.magTimeline;
    const liftEnd = start + 0.09;
    const exitEnd = 0.46;
    const enterStart = 0.56;
    const alignAt = home - 0.09;
    const open = this._phase(frac, 0.10, start) * (1 - this._phase(frac, 0.84, clickAt));
    for (const clamp of parts.clamps || []) clamp.rotation.z = -1.35 * open;
    if (parts.latch) parts.latch.rotation.x = -0.62 * open;

    const hold = this._phase(frac, 0.015, 0.13) * (1 - this._phase(frac, clickAt, 1));
    const seat = this._contact(frac, home, 0.075);
    const latch = this._contact(frac, clickAt, 0.06);
    out.dip = 0.025 * hold + 0.010 * seat;
    out.rock = 0.16 * hold - 0.07 * seat;
    out.x = -0.035 * hold + 0.014 * seat;
    out.push = 0.06 * hold - 0.035 * seat + 0.015 * latch;
    out.yaw = -0.16 * hold;
    out.roll = -0.24 * hold + 0.035 * latch;

    if (frac < enterStart) {
      // First clear the two open clamps vertically, then carry the full tube
      // across the left edge. The receiver, sight and battery stay attached.
      const lift = this._phase(frac, start, liftEnd);
      const carry = this._phase(frac, liftEnd, exitEnd);
      canister.position.set(-0.16 * lift - 0.86 * carry, 0.19 * lift + 0.32 * carry, -0.40 * lift - 0.20 * carry);
      canister.rotation.set(0.09 * carry, -0.15 * carry, 0.18 * carry);
    } else {
      // The replacement rises outside the cradle, aligns above it, then seats.
      const arrive = this._phase(frac, enterStart, alignAt);
      const seatIn = this._phase(frac, alignAt, home);
      const alignBore = this._phase(frac, alignAt, home - 0.035);
      const drawBack = this._phase(frac, home - 0.035, home);
      canister.position.set((-1.05 + 0.85 * arrive) * (1 - seatIn),
        (-0.76 + 0.95 * arrive) * (1 - seatIn), (-0.60 + 0.20 * arrive) * (1 - drawBack));
      canister.rotation.set(-0.14 * (1 - arrive), (0.12 + 0.48 * arrive) * (1 - alignBore), -0.16 * (1 - arrive));
    }
    canister.visible = !(frac >= exitEnd && frac < enterStart);
    if (parts.frontCover) parts.frontCover.visible = frac >= enterStart;

    // Reach for the release first, then keep the palm on the moving tube until
    // it seats; finish by pressing the clamp latch before returning to the grip.
    const grip = this._phase(frac, 0.04, 0.15) * (1 - this._phase(frac, clickAt, 0.985));
    const palm = parts.reloadPalm ||= canister.position.clone();
    palm.set(-0.055, 0.055, -0.30).applyQuaternion(canister.quaternion).add(canister.position);
    let x = palm.x;
    let y = palm.y;
    let z = palm.z;
    const close = this._phase(frac, home, 0.85);
    if (frac >= home) {
      x += (-0.075 - x) * close;
      y += (0.045 - y) * close;
      z += (-0.20 - z) * close;
    }
    this._moveReloadHand(model, x, y, z, grip, canister.visible);
    for (const [at, click] of [[start, 1], [home, 2], [clickAt, 3]]) {
      if (frac >= at && this._reload.lastFrac < at) this._callbacks.onReloadClick(click);
    }
  }

  /**
   * Belt feed: unlatch and throw the feed cover open before the box drops, lift the
   * spent belt lead out of the tray with it, seat the fresh box, pull its lead across
   * the tray, slam the cover on the canonical third click and rack the charging
   * handle. The box path itself is the shared magazine choreography; this only adds
   * the cover, lead, handle and the support hand's route between them.
   */
  _updateBeltReload(frac, model, T, timeline, style, out) {
    const { start, home, clickAt } = timeline;
    const mag = model.mag;
    const cover = model.extra.userData.reloadPart;
    const lead = model.extra.userData.beltLead;
    const exitEnd = start + Math.min(0.20, (home - start) * 0.34);
    const openStart = Math.max(0.03, start - 0.10);
    const slamStart = clickAt - 0.05;
    const rackStart = clickAt + 0.005;
    const rackBack = rackStart + (1 - rackStart) * 0.45;
    const rackEnd = 0.985;

    const open = this._phase(frac, openStart, start) * (1 - this._phase(frac, slamStart, clickAt));
    if (cover) {
      const slamBounce = 0.06 * this._contact(frac, clickAt, 0.05);
      cover.rotation[cover.userData.reloadAxis || 'x'] = -1.22 * open - slamBounce;
    }

    // Charging handle: a firm pull to full travel, then a quick release home.
    const pull = this._phase(frac, rackStart, rackBack);
    const release = this._phase(frac, rackBack, rackBack + (rackEnd - rackBack) * 0.5);
    const rack = pull * (1 - release);
    model.bolt.position.z = T.boltTravel * rack;

    // Belt lead: the spent lead follows the box out, the fresh one slides in
    // from the feed port after the box seats and stays down for the slam.
    const leadOut = this._phase(frac, start, exitEnd);
    const leadIn = this._phase(frac, home + 0.01, slamStart);
    let leadX = 0;
    let leadY = 0;
    let leadZ = 0;
    if (lead) {
      const homePosition = lead.userData.homePosition;
      if (frac < exitEnd) {
        leadX = -0.10 * leadOut;
        leadY = -0.13 * leadOut + 0.05 * Math.sin(Math.PI * leadOut);
        leadZ = 0.03 * leadOut;
        lead.visible = leadOut < 0.98;
        lead.rotation.z = 0.55 * leadOut;
      } else {
        leadX = -0.09 * (1 - leadIn);
        leadY = -0.045 * (1 - leadIn) + 0.012 * Math.sin(Math.PI * leadIn);
        leadZ = 0;
        lead.visible = frac >= home + 0.01;
        lead.rotation.z = 0.35 * (1 - leadIn);
      }
      lead.position.set(homePosition.x + leadX, homePosition.y + leadY, homePosition.z + leadZ);
    }

    // Receiver impulses layered on the shared swap pose: the cover slam and the
    // handle snapping home both land on the gun as separate contacts.
    const slam = this._contact(frac, clickAt, 0.06);
    const pullTug = this._phase(frac, rackStart, rackBack) * (1 - this._phase(frac, rackBack, rackBack + 0.02));
    const snap = this._contact(frac, rackBack + (rackEnd - rackBack) * 0.5, 0.05);
    out.dip += 0.012 * slam - 0.010 * pullTug + 0.008 * snap;
    out.rock += 0.06 * slam + 0.05 * pullTug - 0.04 * snap;
    out.push += 0.020 * slam + 0.030 * pullTug - 0.025 * snap;
    out.roll += 0.04 * slam - 0.03 * pullTug;

    // Support hand: latch, box, fresh lead, cover, charging handle, then home.
    const boxVisible = mag ? mag.visible : true;
    const socket = [style.socket[0] + (mag ? mag.position.x : 0), style.socket[1] + (mag ? mag.position.y : 0),
      style.socket[2] + (mag ? mag.position.z : 0)];
    const latch = [-0.062, 0.150 + 0.19 * open, -0.02 - 0.06 * open];
    const leadHome = lead ? lead.userData.homePosition : null;
    const leadHand = leadHome ? [leadHome.x + leadX - 0.035, leadHome.y + leadY + 0.012, leadHome.z + leadZ + 0.02]
      : [-0.045, 0.142, -0.105];
    const coverTop = [-0.02, 0.165 + 0.19 * open, -0.03 - 0.05 * open];
    const handle = [-0.118, 0.06, -0.025 + model.bolt.position.z];
    let target;
    let visible = true;
    if (frac < start) {
      target = this._blendTargets(latch, socket, this._phase(frac, start - 0.04, start));
    } else if (frac < home + 0.01) {
      target = socket;
      visible = boxVisible;
    } else if (frac < slamStart) {
      target = this._blendTargets(socket, leadHand, this._phase(frac, home + 0.01, home + 0.05));
    } else if (frac < rackStart) {
      target = this._blendTargets(leadHand, coverTop, this._phase(frac, slamStart, clickAt - 0.02));
    } else {
      target = this._blendTargets(coverTop, handle, this._phase(frac, rackStart, rackStart + 0.012));
    }
    const blend = this._phase(frac, 0.02, openStart) * (1 - this._phase(frac, rackEnd, 0.995));
    this._moveReloadHand(model, target[0], target[1], target[2], blend, visible);
  }

  _blendTargets(from, to, t) {
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
  }

  /**
   * SKIPJACK cassette swap, all beats on the left flank under the camera:
   * PRESENT the flank, trip the orange paddle (click 1), SWING the cassette out
   * on its vertical front hinge, LIFT it off the pin and carry it away, bring the
   * loaded cassette in, drop it on the pin and SWING it shut (click 2). An empty
   * swap then racks the charging pawl, lifting and sliding the top fresh round
   * into the chamber (click 3); a tactical swap keeps its chambered round and
   * only pats the closed cassette. The remaining shells rise into the top slots.
   */
  _updateSkipjackReload(frac, model, T, out) {
    const reload = this._reload;
    const { start, home, clickAt } = T.magTimeline;
    const skipjack = model.extra.userData.skipjack;
    const cassette = skipjack.cassette;
    const atHome = cassette.userData.homePosition;
    const plan = skipjack.reload;
    let shown = plan?.shown;
    if (shown === undefined) {
      shown = 0;
      for (let i = 0; i < skipjack.rounds.length; i++) {
        if (skipjack.rounds[i].visible) shown++;
      }
    }
    const fresh = plan?.fresh ?? skipjack.rounds.length;
    const racks = !plan?.chambered;

    const present = this._phase(frac, 0.02, start) * (1 - this._phase(frac, 0.91, 1));
    const open = this._phase(frac, start, 0.27) * (1 - this._phase(frac, 0.70, home));
    const swingKick = this._contact(frac, 0.27, 0.05);
    const lifted = this._phase(frac, 0.30, 0.36) * (1 - this._phase(frac, 0.66, 0.70));
    const away = this._phase(frac, 0.36, 0.46) * (1 - this._phase(frac, 0.56, 0.66));
    const tug = this._contact(frac, 0.33, 0.06);
    const pinDrop = this._contact(frac, 0.70, 0.05);
    const seat = this._contact(frac, home, 0.06);
    const latch = this._contact(frac, home + 0.045, 0.075);
    const rack = racks ? this._phase(frac, clickAt - 0.03, clickAt + 0.02) *
      (1 - this._phase(frac, clickAt + 0.04, 0.98)) : 0;
    const rackHit = racks ? this._contact(frac, clickAt + 0.02, 0.05) : 0;
    const pat = racks ? 0 : this._contact(frac, 0.86, 0.05);

    // Rear edge swings out (-x) about the vertical hub; lift clears the pin.
    cassette.rotation.set(0, -(0.92 * open + 0.07 * swingKick + 0.035 * latch), 0.10 * away);
    cassette.position.set(atHome.x - 0.15 * away, atHome.y + 0.05 * lifted - 0.30 * away,
      atHome.z + 0.05 * away);
    const swapped = frac >= 0.56;
    cassette.visible = frac < 0.46 || swapped;
    presentSkipjackReserve(skipjack, !swapped ? shown : fresh);
    // The Chaos fourth round exceeds the three modeled cassette slots. Its
    // chambered shell is implied, leaving all three exterior shells in place.
    if (swapped && racks && fresh > 0 &&
        (plan?.fullLoad ?? skipjack.rounds.length) <= skipjack.rounds.length) {
      this._animateSkipjackFeed(skipjack, fresh,
        this._phase(frac, clickAt - 0.085, clickAt + 0.055));
    }
    model.bolt.position.z = T.boltTravel * rack;
    model.bolt.rotation.x = -0.18 * rack;

    out.dip = 0.050 * present + 0.018 * tug - 0.012 * pinDrop + 0.022 * seat + 0.012 * rackHit;
    out.rock = 0.24 * present + 0.09 * open - 0.05 * tug - 0.10 * seat +
      0.045 * latch + 0.06 * rackHit - 0.03 * pat;
    out.x = -0.030 * present - 0.012 * open;
    out.push = 0.040 * present + 0.016 * away - 0.040 * seat + 0.012 * latch + 0.016 * rackHit;
    out.yaw = -0.20 * present - 0.05 * open;
    out.roll = 0.14 * present + 0.08 * open - 0.04 * seat - 0.03 * rackHit;

    // Left hand follows the moving cassette edge through the swing and lift,
    // then reaches the charging pawl or pats the latch before returning home.
    // Keep this numeric: the action runs every frame for the whole reload.
    const angle = cassette.rotation.y;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const gripX = cassette.position.x - 0.070 * cos + 0.200 * sin;
    const gripY = cassette.position.y - 0.045;
    const gripZ = cassette.position.z + 0.070 * sin + 0.200 * cos;
    const finishX = racks ? 0.068 : cassette.position.x - 0.058 * cos + 0.120 * sin;
    const finishY = racks ? 0.128 : cassette.position.y - 0.010;
    const finishZ = racks ? -0.292 + model.bolt.position.z
      : cassette.position.z + 0.058 * sin + 0.120 * cos;
    const take = this._phase(frac, start + 0.01, 0.24);
    const finish = this._phase(frac, home + 0.01, racks ? clickAt - 0.03 : 0.85);
    const targetX = -0.188 + (gripX + 0.188) * take;
    const targetY = -0.118 + (gripY + 0.118) * take;
    const targetZ = -0.082 + (gripZ + 0.082) * take;
    const blend = this._phase(frac, 0.02, start - 0.02) * (1 - this._phase(frac, 0.93, 0.995));
    this._moveReloadHand(model, targetX + (finishX - targetX) * finish,
      targetY + (finishY - targetY) * finish,
      targetZ + (finishZ - targetZ) * finish, blend, true);

    if (frac >= start && reload.lastFrac < start) this._callbacks.onReloadClick(1);
    if (frac >= home && reload.lastFrac < home) this._callbacks.onReloadClick(2);
    if (racks && frac >= clickAt && reload.lastFrac < clickAt) this._callbacks.onReloadClick(3);
  }

  _updateCylinderReload(frac, model, out) {
    const reload = this._reload;
    const { crane, cylinder, ejector, cases } = model.extra.userData.revolver;
    const phase = (from, to) => this._smooth01(Math.max(0, Math.min(1, (frac - from) / (to - from))));
    // Open, hold fully open through extraction and insertion, then latch closed.
    const open = phase(0.10, 0.25) * (1 - phase(0.80, 0.92));
    crane.rotation.z = Math.PI / 2 * open;
    const extractHit = this._contact(frac, 0.39, 0.08);
    const seatHit = this._contact(frac, 0.68, 0.08);
    const latchHit = this._contact(frac, 0.92, 0.06);
    out.dip = 0.065 * open - 0.025 * extractHit + 0.025 * seatHit;
    out.rock = 0.40 * open + 0.12 * extractHit - 0.12 * seatHit + 0.09 * latchHit;
    out.x = -0.04 * open;
    out.push = 0.040 * open + 0.025 * extractHit - 0.040 * seatHit;
    out.yaw = 0.12 * open;
    out.roll = -0.30 * open - 0.08 * seatHit + 0.10 * latchHit;
    const extraction = phase(0.29, 0.39);
    ejector.position.z = 0.058 * extraction * (1 - phase(0.44, 0.50));
    cases.position.z = 0.105 * extraction;
    cases.position.y = -1.1 * phase(0.37, 0.45);
    cases.visible = frac < 0.45 || frac >= 0.68;
    if (frac >= 0.68) cases.position.set(0, 0, 0);

    const loader = model.extra.userData.reloadRounds;
    if (loader) {
      // Cartridge tips enter the rear chamber mouths along the bore axis.
      loader.visible = frac >= 0.44 && frac < 0.84;
      loader.rotation.z = crane.rotation.z + cylinder.rotation.z;
      loader.position.set(-0.058, -0.052 - 1.05 * (1 - phase(0.44, 0.53)) - 1.05 * phase(0.71, 0.84),
        0.025 - 0.142 * phase(0.50, 0.67) + 0.16 * phase(0.69, 0.77));
      // Once seated, leave rounds in the cylinder and withdraw just the loader handle.
      for (const child of loader.children) child.visible = frac < 0.68 || child === loader.children.at(-1);
      this._moveReloadHand(model, loader.position.x - 0.04, loader.position.y - 0.015, loader.position.z + 0.055,
        phase(0.32, 0.44) * (1 - phase(0.84, 0.96)), loader.visible);
    }
    for (const [at, click] of [[0.10, 1], [0.68, 2], [0.92, 3]]) {
      if (frac >= at && reload.lastFrac < at) this._callbacks.onReloadClick(click);
    }
  }

  _moveReloadHand(model, x, y, z, blend, visible = true) {
    let state = model.extra.userData.reloadHand;
    if (!state) {
      const hand = model.root.getObjectByName('hand_l');
      if (!hand) return;
      state = model.extra.userData.reloadHand = {
        hand, position: hand.position.clone(), quaternion: hand.quaternion.clone(), target: hand.position.clone(), visible: hand.visible,
      };
    }
    // All weapon hands are children of body or the translating shotgun pump.
    // Keep their original parent so the ordinary support and pump poses survive.
    state.target.set(x, y, z).sub(state.hand.parent.position);
    state.hand.position.copy(state.position).lerp(state.target, blend);
    state.hand.quaternion.copy(state.quaternion);
    state.hand.rotation.x += 0.22 * blend;
    state.hand.rotation.z += (this._variant < 0.5 ? -1 : 1) * 0.10 * this._gripBeat * blend;
    state.hand.visible = state.visible ? visible || blend < 0.5 : blend > 0.01 && visible;
  }

  _updateShellReload(elapsed, frac, model, reload, timeline) {
    const shell = model.extra.userData.reloadRounds;
    if (!shell) return;
    const start = reload.stages?.start ?? timeline.start * reload.dur;
    const perRound = reload.stages?.perRound ?? (timeline.repeatMs || 140) / 1000;
    const round = Math.floor((elapsed - start) / perRound);
    const rounds = reload.stages?.rounds ?? Math.floor((timeline.home * reload.dur - start) / perRound);
    const cycle = (elapsed - start) / perRound - round;
    const reach = this._phase(cycle, 0.08, 0.78);
    const seat = this._phase(cycle, 0.78, 1);
    const loading = elapsed >= start && round >= 0 && round < rounds;
    shell.visible = loading && cycle < 0.995;
    shell.position.set(-0.22 * (1 - reach), -0.80 * (1 - reach) - 0.065 + seat * 0.012,
      0.10 * (1 - reach) + 0.015 - seat * 0.08);
    shell.rotation.x = -0.35 * (1 - reach);
    this._moveReloadHand(model, shell.position.x - 0.025, shell.position.y - 0.022, shell.position.z + 0.02,
      this._phase(frac, 0.01, 0.10) * (1 - this._phase(frac, 0.92, 1)), loading);
  }

  /** Open the split shell, lower a full rocket into the trough, seat and latch. */
  _updateArcherReload(frac, model, out) {
    const reload = this._reload;
    const timeline = model.T.magTimeline;
    const parts = model.extra.userData.archer;
    const present = this._phase(frac, 0.02, 0.19) * (1 - this._phase(frac, 0.94, 1));
    const seat = this._contact(frac, timeline.home, 0.065);
    const latch = this._contact(frac, timeline.clickAt, 0.045);
    out.x = -0.065 * present;
    out.dip = 0.055 * present + 0.012 * seat;
    out.rock = 0.17 * present - 0.07 * seat + 0.035 * latch;
    out.yaw = 0.34 * present;
    out.roll = -0.14 * present - 0.025 * latch;
    out.push = 0.025 * present - 0.050 * seat + 0.020 * latch;

    // The longitudinal pin stays on the right. Its top half swings up and out
    // to +x, leaving the left hand's entire approach and the trough clear.
    const open = this._phase(frac, timeline.start, 0.30) *
      (1 - this._phase(frac, 0.86, timeline.clickAt));
    parts.gate.position.copy(parts.hinge);
    parts.gate.rotation.z = -1.90 * open - 0.035 * this._contact(frac, 0.30, 0.055);
    const cos = Math.cos(parts.gate.rotation.z), sin = Math.sin(parts.gate.rotation.z);
    const grab = [parts.hinge.x - 0.108 * cos - 0.040 * sin,
      parts.hinge.y - 0.108 * sin + 0.040 * cos, parts.hinge.z + 0.025];

    const round = parts.round;
    const bring = this._phase(frac, 0.34, 0.49);
    const align = this._phase(frac, 0.54, 0.68);
    const lower = this._phase(frac, 0.68, 0.75);
    const insert = this._phase(frac, 0.75, timeline.home);
    parts.reloading = true;
    parts.chambered.visible = false;
    round.visible = frac >= 0.34;
    round.position.set(parts.seat.x - (0.38 - 0.21 * bring) * (1 - align),
      parts.seat.y + (0.33 - 0.12 * bring) * (1 - lower),
      parts.seat.z + 0.10 * (1 - insert));
    // Present the whole missile broadside before turning its nose down the
    // bore. An end-on approach lets the exhaust and support palm hide it.
    round.rotation.set(0, 1.0 * (1 - align), -0.10 * (1 - align));
    // Keep the round at its seat through the closing beat. Only completion or
    // cancellation hands visibility back to authority, never an animation cue.
    const roundCos = Math.cos(round.rotation.y), roundSin = Math.sin(round.rotation.y);
    const grip = [round.position.x - 0.025 * roundCos + 0.025 * roundSin,
      round.position.y - 0.068, round.position.z + 0.025 * roundSin + 0.025 * roundCos];
    let target = grab;
    if (frac >= 0.30 && frac < 0.37) {
      target = this._blendTargets(grab, grip, this._phase(frac, 0.30, 0.37));
    } else if (frac >= 0.37 && frac < 0.84) {
      target = grip;
    } else if (frac >= 0.84 && frac < 0.86) {
      target = this._blendTargets(grip, grab, this._phase(frac, 0.84, 0.86));
    }
    this._moveReloadHand(model, target[0], target[1], target[2],
      this._phase(frac, 0.04, 0.16) * (1 - this._phase(frac, 0.94, 1)));
    const palm = model.extra.userData.reloadHand?.hand;
    if (palm) palm.rotation.y += round.rotation.y * this._phase(frac, 0.30, 0.37) *
      (1 - this._phase(frac, 0.84, 0.86));
    model.bolt.rotation.x = 0.28 * open * (1 - this._phase(frac, 0.84, timeline.clickAt));
    for (const [at, click] of [[timeline.start, 1], [timeline.home, 2], [timeline.clickAt, 3]]) {
      if (frac >= at && reload.lastFrac < at) this._callbacks.onReloadClick(click);
    }
  }

  _smooth01(t) { return t * t * (3 - 2 * t); }

  _phase(t, from, to) {
    const progress = Math.max(0, Math.min(1, (t - from) / Math.max(0.001, to - from)));
    return this._smooth01(hesitantProgress(progress, this._phaseStress, this._variant));
  }

  /** Brief wind-up, contact at the exact cue boundary, then a damped return. */
  _contact(t, at, decay) {
    const attack = Math.min(0.018, decay * 0.25);
    return this._phase(t, at - attack, at) * (1 - this._phase(t, at, at + decay));
  }

  _clearMotion() {
    const motion = this._motion;
    motion.dip = motion.rock = motion.x = motion.push = motion.yaw = motion.roll = 0;
  }
}
