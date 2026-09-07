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
    this._motion = { dip: 0, rock: 0 };
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
    this._motion.dip = 0;
    this._motion.rock = 0;
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
    this._motion.dip = 0;
    this._motion.rock = 0;
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
    motion.dip = 0;
    motion.rock = 0;
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
    const frac = Math.min(1, (now - reload.t0) / reload.dur);

    if (reload.type === 'tube') {
      const elapsed = now - reload.t0;
      if (reload.stages) {
        const seatAt = reload.stages.start + (reload.thunks + 1) * reload.stages.perRound;
        if (reload.thunks < reload.stages.rounds && elapsed >= seatAt) {
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
      // Each seated shell rocks the receiver; the rock decays until the next one lands.
      const seatPulse = reload.stages
        ? Math.exp(-Math.max(0, (elapsed - reload.stages.start) % reload.stages.perRound) * 9)
        : 0;
      out.rock = 0.06 * Math.sin(frac * Math.PI) + 0.035 * seatPulse * (frac < timeline.home ? 1 : 0);
      out.dip = -0.02 * seatPulse * (frac < timeline.home ? 1 : 0);
      reload.lastFrac = frac;
      if (frac >= 1) {
        this._resetReloadPose(model);
        this._reload = null;
      }
      return;
    }

    if (reload.type === 'cylinder' && model.extra.userData.revolver) {
      this._updateCylinderReload(frac, model, out);
      reload.lastFrac = frac;
      if (frac >= 1) {
        this._resetReloadPose(model);
        this._reload = null;
      }
      return;
    }

    const tMag = Math.max(0, Math.min(1,
      (frac - timeline.start) / Math.max(0.001, timeline.home - timeline.start)));
    const pulse = Math.sin(Math.PI * tMag);
    const hasMovingAmmo = model.magazines ? 1 : 0;
    const isBelt = reload.type === 'belt';
    const isCylinder = reload.type === 'cylinder';
    out.dip = (isBelt ? -0.12 : isCylinder ? -0.035 : -0.095) * pulse *
      (hasMovingAmmo ? 1 : 0.15);
    out.rock = (isBelt ? 0.22 : isCylinder ? 0.16 : 0.35) * pulse;

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
        mag.position.x = -0.075 * pulse * hasMovingAmmo;
        mag.position.y = 0.012 * pulse * hasMovingAmmo;
        mag.rotation.y = -1.05 * pulse * hasMovingAmmo;
      } else {
        mag.position.y = (isBelt ? -0.075 : -0.05) * pulse * hasMovingAmmo;
        mag.rotation.x = (isBelt ? 0.20 : 0.30) * pulse * hasMovingAmmo;
      }
    }

    const cover = model.extra.userData.reloadPart;
    if (isBelt && cover) cover.rotation.x = -1.10 * pulse;

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
    }
  }

  _updateCylinderReload(frac, model, out) {
    const reload = this._reload;
    const { crane, cylinder, ejector, cases } = model.extra.userData.revolver;
    const phase = (from, to) => this._smooth01(Math.max(0, Math.min(1, (frac - from) / (to - from))));
    // Open, hold fully open through extraction and insertion, then latch closed.
    const open = phase(0.10, 0.25) * (1 - phase(0.80, 0.92));
    crane.rotation.z = Math.PI / 2 * open;
    out.dip = -0.045 * open;
    out.rock = 0.22 * open;
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
}
