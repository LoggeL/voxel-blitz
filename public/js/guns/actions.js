// Internal reload, manual-cycle, and reciprocating-action choreography for the viewmodel rig.
import {
  CYCLE_FRACS,
  PUMP_MS,
  PUMP_REST,
  SNIPER_BOLT_MIN_S,
} from './models/common.js';

const NOOP = () => {};

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
    // Position offsets are meters; pitch (rock), yaw and roll are radians.
    this._motion = { dip: 0, rock: 0, x: 0, push: 0, yaw: 0, roll: 0 };
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
    if (this._disposed || !(dur > 0) || !T) return false;
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
      // Staged tube loads thunk exactly when the authority seats each round.
      stages: stages && stages.perRoundSeconds > 0 ? {
        start: stages.startSeconds,
        perRound: stages.perRoundSeconds,
        rounds: Math.max(0, stages.rounds | 0),
      } : null,
    };
    return true;
  }

  /** Interrupt an in-progress reload (a shot fired mid tube load); the pose snaps home. */
  cancelReload(model = null) {
    if (!this._reload) return false;
    if (model) this._resetReloadPose(model);
    this._reload = null;
    this._clearMotion();
    return true;
  }

  /** Start the short automatic bolt/hammer reciprocation used by non-cycleBack weapons. */
  startJerk(weaponId, model, travel, dur) {
    if (this._disposed || !model) return false;
    const revolver = weaponId === 'revolver';
    this._jerk = {
      t: 0,
      dur: revolver ? Math.max(0.11, dur) : dur,
      travel,
      revolver,
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
    let durMs = kind === 'pump' ? PUMP_MS : T.bursts[0][0] || 900;
    if (kind === 'bolt') durMs = Math.max(SNIPER_BOLT_MIN_S * 1000, durMs);
    this._cycle = { kind, dur: durMs / 1000, t: 0, step: 0, silent: !!silentStall };
    return true;
  }

  /**
   * Advance active states in the rig's original order: reload, jerk, then manual cycle.
   * The returned object is stable and owned here, avoiding a per-frame choreography allocation.
   */
  update(now, dt, model, T) {
    const motion = this._motion;
    this._clearMotion();
    if (this._disposed || !model || !T) return motion;
    if (this._reload) this._updateReload(now, model, T, motion);
    if (this._jerk) this._stepJerk(model, dt);
    if (this._cycle) this._stepCycle(model, T, dt);
    return motion;
  }

  _resetReloadPose(model) {
    model.mag.position.set(0, 0, 0);
    model.mag.rotation.x = 0;
    model.mag.rotation.y = 0;
    const revolver = model.extra.userData.revolver;
    if (!revolver) model.mag.rotation.z = 0;
    if (revolver) {
      revolver.crane.rotation.z = 0;
      revolver.ejector.position.z = 0;
      revolver.cases.position.set(0, 0, 0);
      revolver.cases.visible = true;
    }
    const cover = model.extra.userData.reloadPart;
    if (cover) cover.rotation.set(0, 0, 0);
    const rounds = model.extra.userData.reloadRounds;
    if (rounds) {
      rounds.visible = false;
      for (const child of rounds.children) child.visible = true;
      if (revolver) rounds.rotation.set(0, 0, 0);
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
    model.triggerGroup.rotation.set(0, 0, 0);
    if (model.pump) model.pump.position.copy(PUMP_REST);
  }

  _stepJerk(model, dt) {
    const jerk = this._jerk;
    jerk.t += dt;
    const u = Math.min(1, jerk.t / jerk.dur);
    const stroke = Math.sin(Math.PI * u);
    model.triggerGroup.rotation.x = 0.20 * stroke;
    if (jerk.revolver) {
      const revolver = model.extra.userData.revolver;
      if (revolver) {
        revolver.hammer.rotation.x = 0.65 * (1 - this._smooth01(Math.min(1, u / 0.24)));
      } else {
        model.bolt.rotation.x = -0.70 * stroke;
        model.mag.rotation.z = jerk.cylinderStart + (Math.PI / 3) * this._smooth01(u);
      }
    } else {
      model.bolt.position.z = stroke * jerk.travel;
    }
    if (u >= 1) {
      model.bolt.position.z = 0;
      model.bolt.rotation.x = 0;
      model.triggerGroup.rotation.x = 0;
      this._jerk = null;
    }
  }

  _stepCycle(model, T, dt) {
    const cycle = this._cycle;
    const fractions = CYCLE_FRACS[cycle.kind];
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

    if (cycle.kind === 'pump' && model.pump) {
      model.pump.position.z = PUMP_REST.z + Math.sin(Math.PI * u) * 0.10;
    } else if (cycle.kind === 'bolt') {
      const s1 = fractions.s1;
      const s3 = fractions.s3;
      const lift = u < s1 ? 0.45 * (u / s1)
        : u > s3 ? 0.45 * (1 - (u - s3) / (1 - s3))
        : 0.45;
      model.bolt.position.z = Math.sin(Math.PI * u) * T.boltTravel;
      model.bolt.rotation.z = lift;
    }

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
    const weight = isBelt ? 0.85 : 1;
    // Snatch up and cant, brace through the swap, then separate seating and
    // charging-handle contacts from the final return to the shoulder.
    out.dip = 0.070 * grip - 0.018 * anticipate - 0.020 * tug + 0.030 * seat - 0.016 * latch;
    out.rock = (0.46 * grip - 0.08 * anticipate + 0.10 * tug - 0.14 * seat + 0.10 * latch) * weight;
    out.x = -0.052 * grip - 0.025 * tug + 0.014 * seat;
    out.push = 0.050 * grip + 0.035 * tug - 0.055 * seat + 0.036 * latch;
    out.yaw = 0.10 * grip - 0.06 * tug + 0.025 * seat;
    out.roll = (-0.34 * grip + 0.10 * tug - 0.10 * seat + 0.06 * latch) * weight;

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
      } else {
        mag.position.x = (isBelt ? -0.045 : -0.075) * removed * hasMovingAmmo;
        mag.position.y = (isBelt ? -0.14 : -0.19) * removed * hasMovingAmmo;
        mag.position.z = 0.035 * removed * hasMovingAmmo;
        mag.rotation.x = (isBelt ? 0.20 : 0.32) * removed * hasMovingAmmo;
        mag.rotation.z = -0.18 * removed * hasMovingAmmo;
      }
    }

    const cover = model.extra.userData.reloadPart;
    if (isBelt && cover) cover.rotation.x = -1.22 *
      this._phase(frac, timeline.start, pullEnd) *
      (1 - this._phase(frac, timeline.home - 0.045, timeline.home + 0.055));

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
      const cartridges = model.extra.userData.cartridges;
      const showAll = frac >= timeline.start && frac < timeline.clickAt;
      for (let i = 0; i < cartridges.length; i++) {
        const feed = this._smooth01(Math.max(0, Math.min(1,
          (frac - timeline.start) / Math.max(0.001, timeline.clickAt - timeline.start) - i * 0.10)));
        const cartridge = cartridges[i];
        cartridge.visible = showAll && feed > 0 && feed < 0.98;
        cartridge.position.y = 0.115 + i * 0.016 - feed * 0.06;
      }
    }

    if (frac >= 1) {
      this._resetReloadPose(model);
      this._reload = null;
      this._clearMotion();
    }
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
    cases.position.y = -0.07 * phase(0.37, 0.45);
    cases.visible = frac < 0.45 || frac >= 0.68;
    if (frac >= 0.68) cases.position.set(0, 0, 0);

    const loader = model.extra.userData.reloadRounds;
    if (loader) {
      // Cartridge tips enter the rear chamber mouths along the bore axis.
      loader.visible = frac >= 0.50 && frac < 0.77;
      loader.rotation.z = crane.rotation.z + cylinder.rotation.z;
      loader.position.set(-0.058, -0.052,
        0.025 - 0.142 * phase(0.50, 0.67) + 0.16 * phase(0.69, 0.77));
      // Once seated, leave rounds in the cylinder and withdraw just the loader handle.
      for (const child of loader.children) child.visible = frac < 0.68 || child === loader.children.at(-1);
    }
    for (const [at, click] of [[0.10, 1], [0.68, 2], [0.92, 3]]) {
      if (frac >= at && reload.lastFrac < at) this._callbacks.onReloadClick(click);
    }
  }

  _smooth01(t) { return t * t * (3 - 2 * t); }

  _phase(t, from, to) {
    return this._smooth01(Math.max(0, Math.min(1, (t - from) / Math.max(0.001, to - from))));
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
