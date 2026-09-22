// Internal reload, manual-cycle, and reciprocating-action choreography for the viewmodel rig.
import {
  CYCLE_FRACS,
  PUMP_MS,
  PUMP_REST,
  SNIPER_BOLT_MIN_S,
} from './models/common.js';

const NOOP = () => {};

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
    if (this._disposed || !(dur > 0) || !T || T.melee) return false;
    this._cycle = null;
    this._jerk = null;
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
    const rocket = model.extra.userData.rocketReload;
    if (rocket) {
      // The rocket reload swings the gate about its side pin and yaws the round
      // (the arming lever rides model.bolt, zeroed above); restore all of it.
      rocket.gate.position.copy(rocket.hinge);
      rocket.gate.rotation.set(0, 0, 0);
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

    if (model.extra.userData.rocketReload) {
      this._updateRocketReload(frac, model, out);
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
        const feed = this._smooth01(Math.max(0, Math.min(1,
          (frac - timeline.start) / Math.max(0.001, timeline.clickAt - timeline.start) - i * 0.10)));
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

  /**
   * RX-8 HAVOC reload staging, all six beats under the camera: PRESENT the
   * breech, SWING the venturi gate open sideways on its left-flank pin with a
   * weighted hinge-stop, LOAD the round up from lower-right clear of the open
   * gate, SEAT it with an accelerating shove along the bore axis, SLAM the gate
   * shut, COCK the arming lever. Pure function of `frac`; rest pose untouched.
   */
  _updateRocketReload(frac, model, out) {
    const reload = this._reload;
    const timeline = model.T.magTimeline;
    const parts = model.extra.userData.rocketReload;
    // PRESENT: turn the breech toward the camera from 0.02 so every later action
    // happens under the lens — the gate opens on the LEFT flank (the side facing
    // the lens), so the gun yaws its rear in, rides a little left and low, and
    // rolls its top away so the open breech and the round's run-in stay framed —
    // then settle the view before the slam. The seat and latch contacts keep the
    // two heavy clicks felt in the hands.
    const presented = this._phase(frac, 0.02, 0.20) * (1 - this._phase(frac, 0.88, 1.00));
    const seat = this._contact(frac, timeline.home, 0.07);
    const latch = this._contact(frac, timeline.clickAt, 0.05);
    out.yaw = -0.30 * presented;
    out.roll = 0.10 * presented;
    out.x = -0.06 * presented;
    out.dip = 0.06 * presented + 0.03 * seat;
    out.rock = 0.12 * presented - 0.10 * seat - 0.03 * latch;
    out.push = -0.10 * seat;
    // SWING: the gate swings open about its vertical side pin (no slide; the
    // group sits on the hinge the template exported) so the rear stands fully
    // open, clear of the bore axis, before the round starts to rise. Negative
    // rotation.y carries the venturi tail out to -x, the player-facing flank.
    parts.gate.position.copy(parts.hinge);
    const open = this._phase(frac, 0.20, 0.32) * (1 - this._phase(frac, 0.85, 0.90));
    // The hinge-stop bounce at 0.31 overshoots the swing with weight; SLAM swings
    // the gate shut from 0.85 and a smaller rebound at 0.895 reopens it a hair
    // as the latch takes the impact. Both decays end before 0.94 so the rest
    // value is exactly 0 (a closed gate can never rotate past its block face).
    const swing = parts.swing * open + 0.07 * this._contact(frac, 0.31, 0.12)
      + 0.05 * this._contact(frac, 0.895, 0.04);
    parts.gate.rotation.y = swing > 0 ? -swing : 0;
    // COCK: the arming lever tips while the breech stands open and snaps home
    // exactly on cue 3.
    model.bolt.rotation.x = 0.55 * open * (1 - this._phase(frac, 0.88, timeline.clickAt));
    // LOAD: the round rises from lower-right close to the camera — the
    // gate-free flank, clear of the open venturi (its back-clamp collar hangs
    // at x -0.29..-0.32 around z -0.06 while the round climbs at z +0.36) —
    // yawed across the bore with its nose cantled toward the tube mouth, then
    // squares onto the tube axis. Loading from the gate's own (-x) flank parked
    // the nose inside the clamp collar's screen silhouette under the present
    // yaw; the +x entry keeps the round and the open gate on opposite halves of
    // the lens for the whole load, so the nose reads as leading into the mouth.
    const round = model.extra.userData.reloadRounds;
    const raise = this._phase(frac, 0.36, 0.56);
    const align = this._phase(frac, 0.56, 0.68);
    // SEAT: an accelerating shove drives the round home — at insert = 1 its
    // origin reaches rearZ - 0.29 (game z -0.35), its previous seat — and the
    // support hand rides it the whole way.
    const insert = this._phase(frac, 0.70, timeline.home);
    round.visible = frac >= 0.36 && frac < timeline.home;
    round.position.set(0.30 * (1 - align), parts.axisY - 0.55 * (1 - raise),
      parts.rearZ + 0.42 - 0.71 * insert * insert);
    round.rotation.y = 0.45 * (1 - align);
    this._moveReloadHand(model, round.position.x - 0.04, round.position.y - 0.04, round.position.z + 0.075,
      this._phase(frac, 0.24, 0.38) * (1 - this._phase(frac, timeline.home, 0.98)),
      round.visible || frac >= timeline.home);
    for (const [at, click] of [[timeline.start, 1], [timeline.home, 2], [timeline.clickAt, 3]]) {
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
