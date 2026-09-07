import { createMinigunState, stepMinigun, heatMinigun, minigunDamageMult } from '../../../shared/minigun.js';
import { chaosWeaponDef } from '../../../shared/chaos.js';
// Client weapon state machine. The composition root owns frame order; this module owns
// every weapon transition and receives only narrow adapters for its side effects.
import {
  CONDITION_RULES,
  SNIPER_SCOPE_ADS_THRESHOLD,
  WEAPONS,
  WEAPON_IDS,
  computeRecoilKickDeg,
  computeSpreadConeDeg,
  reloadPlan,
  samplePelletDirection,
  chargeProfile,
  chargeFromHold,
  chargeShotProfile,
} from '../../../shared/combatmath.js';
import { weaponSwapProfile } from '../../../shared/weapon-swap.js';
import { TIMERS } from './defs.js';

const EMPTY_AMMO = Object.freeze({ mag: 0, reserve: 0 });
const DEFAULT_MODE = 'fun';

/** One visibility rule shared by scoped weapon state and spectator presentation. */
export function shouldShowViewmodel({ spectating = false, scopeActive = false } = {}) {
  return !spectating && !scopeActive;
}

function usesAuthoritativeOwnedWeapons(mode) {
  return mode === 'snd' || mode === 'gungame';
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function forwardFromAngles(yaw, pitch) {
  const cp = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cp,
  };
}

function requireMethod(owner, name) {
  if (!owner || typeof owner[name] !== 'function') {
    throw new TypeError(`WeaponState dependency must implement ${name}()`);
  }
}

/**
 * Adapter interface:
 * - rig: setWeapon, fire, reload, pumpAnim, boltAnim, ads
 * - audio: draw, reloadClick, fire
 * - effects: shoot
 * - network: isCurrentGeneration, isRunning
 * - feedback: addExhaustion, addRecoil
 */
export class WeaponState {
  constructor({
    rig,
    audio,
    effects,
    network,
    feedback,
    now = () => performance.now(),
    random = Math.random,
    setTimer = (fn, delay) => setTimeout(fn, delay),
    clearTimer = (timer) => clearTimeout(timer),
  }) {
    for (const name of [
      'setWeapon',
      'fire',
      'reload',
      'pumpAnim',
      'boltAnim',
      'ads',
    ]) requireMethod(rig, name);
    for (const name of ['draw', 'reloadClick', 'fire']) requireMethod(audio, name);
    requireMethod(effects, 'shoot');
    for (const name of ['isCurrentGeneration', 'isRunning']) requireMethod(network, name);
    for (const name of ['addExhaustion', 'addRecoil']) requireMethod(feedback, name);
    if (typeof now !== 'function' || typeof random !== 'function' ||
        typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
      throw new TypeError('WeaponState clock, random, and timer dependencies must be functions');
    }

    this._rig = rig;
    this._audio = audio;
    this._effects = effects;
    this._network = network;
    this._feedback = feedback;
    this._now = now;
    this._random = random;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;

    this._emptyReloadTimer = null;
    this._disposed = false;
    this.menuReset();
  }

  get def() { return chaosWeaponDef({ chaosUpgrades: this._mode === 'chaos' ? this._chaosUpgrades : null }, WEAPONS[WEAPON_IDS[this._slot]]); }
  get slot() { return this._slot; }
  get bloomDeg() { return this._bloomDeg; }
  get adsT() { return this._adsT; }
  get wantAds() { return this._wantAds; }
  get scopeActive() { return this._scopeActive; }
  get isReloading() { return this._reloadState !== null; }
  get flameFiring() {
    // Presentation reads one simulation decision even when rendering takes longer
    // than the keepalive. The next fire update still expires a stalled emitter.
    return this.def.id === 'flamethrower' && this._flameActive && this._allowFire && this._alive &&
      !this._reloadState && this._pendingShotIntent?.held === true &&
      this._flameFrameAt >= this._deployUntil && this._flameFrameAt - this._flameLastShotAt <= 125;
  }
  /** Live 0..1 capacitor charge of a `charge` weapon while the trigger is held. */
  get charge01() {
    if (this._chargeStart === null) return 0;
    return chargeFromHold(this.def, this._now() - this._chargeStart);
  }
  get isCharging() { return this._chargeStart !== null; }
  get coneDeg() {
    return computeSpreadConeDeg(
      this.def,
      this._bloomDeg,
      this._speedXZ,
      this._adsT,
      this._panic,
      this._exhaustion,
      this._crouching,
      this._pain,
    );
  }

  ammoOf(weaponId) {
    const ammo = this._ammo[weaponId];
    return ammo ? { mag: ammo.mag, reserve: ammo.reserve } : { mag: 0, reserve: 0 };
  }

  _reloadProgress(now) {
    const reload = this._reloadState;
    return reload
      ? (now - (reload.until - reload.dur)) / reload.dur
      : null;
  }

  /** Weapon-owned portion of the exact HUD read model. */
  readModel(now = this._now()) {
    const def = this.def;
    const ammo = this._ammo[def.id] || EMPTY_AMMO;
    return {
      mag: ammo.mag,
      reserve: ammo.reserve,
      infiniteMagazines: this._mode === 'gungame',
      wname: def.name,
      wid: def.id,
      crosshairConeDeg: this.coneDeg,
      crosshairHitRadius: chargeShotProfile(def, this._chargeStart === null ? 0 : chargeFromHold(def, now - this._chargeStart)).hitRadius,
      reloading01: this._reloadProgress(now),
      reloadStaged: !!this._reloadState?.staged,
      adsT01: this._adsT,
      zoom: def.zoom,
      heat01: def.id === 'minigun' ? this._minigun.heat : null,
      spin01: this._minigun.spin,
      minigunSpinningUp: def.id === 'minigun' && this._minigun.spin > 0 && this._minigun.spin < 1 &&
        !this._minigun.overheated && this._allowFire && (!!this._pendingShotIntent?.held || this._wantAds),
      minigunPrimed: def.id === 'minigun' && this._minigun.spin >= 1 && !this._minigun.overheated &&
        this._wantAds && !this._pendingShotIntent?.held,
      overheated: this._minigun.overheated,
      heatDamageMult: minigunDamageMult(this._minigun),
      fuel01: def.flame ? ammo.mag / def.magSize : null,
      fuelSeconds: def.flame ? ammo.mag * 60 / def.rpm : null,
      flameFiring: this.flameFiring,
      charge01: def.mode === 'charge'
        ? (this._chargeStart === null ? 0 : chargeFromHold(def, now - this._chargeStart))
        : null,
    };
  }

  /** Drop a capacitor charge without firing (switch, reload, death, blocked mode). */
  cancelCharge() {
    if (this._chargeStart === null) return false;
    this._chargeStart = null;
    this._rig.setCharge?.(0);
    this._audio.weaponCharge?.(0, false);
    return true;
  }


  /** Fill canonical active magazines/spare-mag counts without changing selection. */
  resetToLoadout() {
    this._ammo = Object.create(null);
    this._minigun = createMinigunState();
    this._thermalAt = null;
    for (const weaponId of WEAPON_IDS) {
      const def = WEAPONS[weaponId];
      this._ammo[weaponId] = { mag: def.magSize, reserve: def.spareMags };
    }
  }

  /** Apply authoritative ammo arrays in canonical WEAPON_IDS order. */
  adoptServerAmmo(mag, reserve) {
    if (!Array.isArray(mag) || !Array.isArray(reserve)) return;
    for (let index = 0; index < WEAPON_IDS.length; index++) {
      const weaponId = WEAPON_IDS[index];
      let ammo = this._ammo[weaponId];
      if (!ammo) {
        const def = WEAPONS[weaponId];
        ammo = this._ammo[weaponId] = { mag: def.magSize, reserve: def.spareMags };
      }
      if (Number.isFinite(mag[index])) ammo.mag = mag[index];
      if (Number.isFinite(reserve[index])) ammo.reserve = reserve[index];
    }
  }

  _setAuthority(mode, owned) {
    if (mode !== undefined) this._mode = mode;
    if (owned === undefined) return;
    if (!Array.isArray(owned)) {
      this._owned = null;
      return;
    }
    const unchanged = Array.isArray(this._owned) &&
      this._owned.length === owned.length &&
      this._owned.every((weaponId, index) => weaponId === owned[index]);
    if (!unchanged) this._owned = owned.slice();
  }

  /** Select a weapon, enforcing mode-owned loadouts such as S&D and Gun Game. */
  forceWeapon(slot, { mode, owned, now = this._now() } = {}) {
    this._setAuthority(mode, owned);
    if (!Number.isInteger(slot) || slot < 0 || slot >= WEAPON_IDS.length || slot === this._slot) {
      return false;
    }
    if (usesAuthoritativeOwnedWeapons(this._mode) && Array.isArray(this._owned) &&
        !this._owned.includes(WEAPON_IDS[slot])) {
      return false;
    }

    this._stopFlame();
    this._audio.minigunMotor?.(0, 0, false);
    this._minigun.spin = 0;
    this._lastSlot = this._slot;
    this._slot = slot;
    this.cancelCharge();
    this._resetRecoilPattern();
    this._reloadState = null;
    this._completedReloadWeapon = null;
    this._deployUntil = now + weaponSwapProfile(this.def).total * 1000;
    this._adsT = 0;
    this._scopeActive = false;
    if (this._rig.root) this._rig.root.visible = true;
    this._nextFireAt = Math.max(this._nextFireAt, this._deployUntil);
    if (this._rig.equipWeapon) this._rig.equipWeapon(WEAPON_IDS[slot]);
    else this._rig.setWeapon(WEAPON_IDS[slot]);
    this._audio.draw(WEAPON_IDS[slot]);
    return true;
  }

  cycleWeapon(direction, { mode, owned, now = this._now() } = {}) {
    this._setAuthority(mode, owned);
    if (!Number.isFinite(direction) || direction === 0) return false;

    const authoritativeOwned = usesAuthoritativeOwnedWeapons(this._mode) &&
      Array.isArray(this._owned);
    let availableCount = 0;
    let currentIndex = -1;
    for (let slot = 0; slot < WEAPON_IDS.length; slot++) {
      if (authoritativeOwned && !this._owned.includes(WEAPON_IDS[slot])) continue;
      if (slot === this._slot) currentIndex = availableCount;
      availableCount++;
    }
    if (availableCount === 0) return false;

    const origin = currentIndex >= 0 ? currentIndex : 0;
    const targetIndex = (
      (origin + Math.trunc(direction)) % availableCount + availableCount
    ) % availableCount;
    let seen = 0;
    for (let slot = 0; slot < WEAPON_IDS.length; slot++) {
      if (authoritativeOwned && !this._owned.includes(WEAPON_IDS[slot])) continue;
      if (seen === targetIndex) return this.forceWeapon(slot, { now });
      seen++;
    }
    return false;
  }

  /**
   * Apply already-consumed input edges. Ordering matches the former Game.sampleMovement block:
   * wheel, direct slot, last weapon, reload, then fire tap/hold staging.
   */
  applyIntents({
    switchDelta = 0,
    slot = null,
    lastWeapon = false,
    reload = false,
    fireTap = false,
    fireHeld = false,
    wantAds = false,
    grenadeHandling = false,
  }, now, {
    allowFire = false,
    alive = this._alive,
    mode,
    owned,
  } = {}) {
    this._alive = !!alive;
    this._allowFire = !!allowFire;
    this._grenadeHandling = !!grenadeHandling;
    this._setAuthority(mode, owned);
    this._wantAds = !!wantAds && !this._grenadeHandling;
    if (!fireHeld || !this._alive || !this._allowFire) this._stopFlame();

    if (this._grenadeHandling) {
      this.cancelCharge();
      this._chargeHeldPrev = false;
      this._stopFlame();
      this._scopeActive = false;
      this._fireTapLatched = false;
      this._pendingShotIntent = { tap: false, held: false };
      return;
    }

    if (switchDelta) this.cycleWeapon(switchDelta, { now });
    if (slot !== null) this.forceWeapon(slot, { now });
    if (lastWeapon) this.forceWeapon(this._lastSlot, { now });
    // Melee never reloads: a manual request with a no-magazine weapon drawn is a no-op.
    if (reload && this._alive && this.def.mode !== 'melee') this.startReload(now);

    if (fireTap && this._allowFire) this._fireTapLatched = true;
    if (!this._allowFire) this._fireTapLatched = false;
    this._pendingShotIntent = {
      tap: this._allowFire && !reload && !!fireTap,
      held: this._allowFire && !!fireHeld,
    };
  }

  _stopFlame() {
    this._rig.setFlame?.(false, 0);
    const wasActive = this._flameActive;
    this._flameActive = false;
    this._flameFrameAt = 0;
    this._flameLastShotAt = -Infinity;
    if (wasActive) this._audio.stopFlame?.();
  }

  clearIntents() {
    this._stopFlame();
    this._audio.minigunMotor?.(0, 0, false);
    this._pendingShotIntent = null;
    this._fireTapLatched = false;
    this._wantAds = false;
    this._allowFire = false;
    this._grenadeHandling = false;
    this._audio.weaponCharge?.(0, false);
    this._chargeHeldPrev = false;
    this.cancelCharge();
  }

  startReload(now) {
    if (this._grenadeHandling || this._reloadState || this._completedReloadWeapon === this.def.id || !this._alive || now < this._deployUntil) return false;
    const def = this.def;
    if (def.mode === 'melee') return false; // a knife has no magazine to refill
    const ammo = this._ammo[def.id];
    if (!ammo || ammo.mag >= def.magSize || ammo.reserve <= 0) return false;

    this._stopFlame();
    this._audio.minigunMotor?.(0, 0, false);
    const plan = reloadPlan(def, ammo.mag);
    const dur = plan.seconds * 1000;
    const type = plan.staged ? 'tube' : 'magswap';
    this._reloadState = {
      startedAt: now,
      acknowledged: false,
      until: now + dur,
      dur,
      type,
      weapon: def.id,
      staged: plan.staged,
      stage: plan.staged ? 'start' : null,
      stageAt: now + plan.startSeconds * 1000,
      perRoundMs: plan.perRoundSeconds * 1000,
      endMs: plan.endSeconds * 1000,
      loose: 0,
    };
    if (!plan.staged) {
      // Mirror the authority: once reload starts, the partial magazine is gone.
      // A replacement spare is consumed only after the reload completes.
      ammo.mag = 0;
    }
    this.cancelCharge();
    this._resetRecoilPattern();
    this._rig.reload(dur / 1000, type, plan.staged ? {
      startSeconds: plan.startSeconds,
      perRoundSeconds: plan.perRoundSeconds,
      rounds: plan.rounds,
    } : null);
    return true;
  }

  /** Staged (tube) reloads seat rounds as the authority does; a shot interrupts them. */
  cancelReload() {
    const reload = this._reloadState;
    if (!reload) return false;
    this._reloadState = null;
    this._completedReloadWeapon = null;
    this._rig.cancelReload?.();
    return true;
  }

  tickReload(now) {
    const reload = this._reloadState;
    if (!reload) return false;
    const def = WEAPONS[reload.weapon];
    const ammo = this._ammo[reload.weapon];

    if (reload.staged) {
      let advanced = false;
      while (reload.stage && now >= reload.stageAt) {
        advanced = true;
        if (reload.stage === 'start') {
          if (!def || !ammo || ammo.reserve <= 0 || ammo.mag >= def.magSize) {
            reload.stage = null;
            break;
          }
          if (this._mode !== 'gungame') ammo.reserve -= 1;
          reload.loose = def.magSize;
          reload.stage = 'round';
          reload.stageAt += reload.perRoundMs;
        } else if (reload.stage === 'round') {
          if (reload.loose > 0 && ammo.mag < def.magSize) {
            ammo.mag += 1;
            reload.loose -= 1;
          }
          if (reload.loose > 0 && ammo.mag < def.magSize) {
            reload.stageAt += reload.perRoundMs;
          } else {
            reload.stage = 'end';
            reload.stageAt += reload.endMs;
          }
        } else {
          reload.stage = null;
        }
      }
      if (reload.stage === null || now >= reload.until) {
        this._reloadState = null;
        this._completedReloadWeapon = reload.weapon;
        return true;
      }
      return advanced;
    }

    if (now < reload.until) return false;
    if (def && ammo && ammo.reserve > 0) {
      if (this._mode !== 'gungame') ammo.reserve -= 1;
      ammo.mag = def.magSize;
    }
    this._reloadState = null;
    // Wait for the authoritative completion before accepting another shot/reload.
    // A late in-progress snapshot must not replay the full animation.
    this._completedReloadWeapon = reload.weapon;
    return true;
  }

  /**
   * Complete all weapon phases without an interposed network send. The composition root uses
   * tickReload()/tryFire(), sends input, then settleFrame() to preserve the live loop ordering.
   */
  update(dt, now, context) {
    if (this._disposed) return false;
    this._acceptFrameContext(context);
    this.tickReload(now);
    const fired = this._tryFire(now);
    this.settleFrame(dt);
    return fired;
  }

  /** Bloom recovery and ADS are intentionally separate from the pre-send reload/fire phase. */
  settleFrame(dt, { vaulting = false } = {}) {
    if (this._disposed) return;
    const def = this.def;
    this._bloomDeg = Math.max(0, this._bloomDeg - def.bloomRecover * dt);
    this._adsT += (
      (this._wantAds && this._alive && !vaulting && !this._grenadeHandling && !this._reloadState && this._now() >= this._deployUntil) ? 1 : -1
    ) * dt / Math.max(0.08, def.adsTime);
    this._adsT = Math.max(0, Math.min(1, this._adsT));
    this._scopeActive = this._alive && !vaulting && !this._grenadeHandling && def.id === 'sniper' &&
      this._adsT >= SNIPER_SCOPE_ADS_THRESHOLD;
    if (this._rig.root) {
      this._rig.root.visible = shouldShowViewmodel({ scopeActive: this._scopeActive });
    }
  }

  /** Call at the original rig-update point, after camera/body updates. */
  syncRigAds() {
    this._rig.ads(this._adsT);
    this._rig.setFlame?.(this.flameFiring, this.def.flame ? this.ammoOf(this.def.id).mag / this.def.magSize : 0);
  }

  /** Direct fire transition for callers that keep the former split tick/fire frame order. */
  tryFire(now, context) {
    if (context) this._acceptFrameContext(context);
    return this._tryFire(now);
  }

  _tryFire(now) {
    this._flameFrameAt = now;
    const thermalDt = this._thermalAt === null ? 0 : Math.max(0, (now - this._thermalAt) / 1000);
    this._thermalAt = now;
    const canSpin = this.def.id === 'minigun' && this._allowFire && !this._grenadeHandling && this._alive &&
      !this._reloadState && !this._completedReloadWeapon &&
      now >= this._deployUntil && this._ammo.minigun?.mag > 0;
    const driving = canSpin && !!(this._pendingShotIntent?.held || this._pendingShotIntent?.tap);
    const ready = stepMinigun(this._minigun, thermalDt, driving, canSpin && this._wantAds);
    this._rig.setMinigun?.(this._minigun);
    if (this.def.id === 'minigun') {
      this._audio.minigunMotor?.(this._minigun.spin, this._minigun.heat,
        canSpin, this._minigun.overheated);
    }
    // Authority is deliberately the first gate.
    if (!this._allowFire || this._grenadeHandling) {
      this.cancelCharge();
      return false;
    }
    const def = this.def;
    const weaponId = def.id;
    if (this._completedReloadWeapon === weaponId) return false;
    if (def.mode === 'charge') return this._tryChargeFire(now, def, weaponId);
    if (def.mode === 'melee') return this._tryMeleeFire(now, def, weaponId);
    if (now < this._nextFireAt || now < this._deployUntil) return false;
    const ammo = this._ammo[weaponId];
    if (!ammo) return false;
    const reload = this._reloadState;
    if (reload) {
      const wantsShot = !!(this._pendingShotIntent &&
        this._pendingShotIntent.tap);
      // Tube reload yields to the trigger: whatever is seated fires now.
      if (!(reload.staged && wantsShot && ammo.mag > 0)) return false;
      this.cancelReload();
    }
    if (ammo.mag <= 0) {
      if (this._pendingShotIntent && this._pendingShotIntent.tap) {
        this._audio.reloadClick(3, weaponId);
      }
      this.startReload(now);
      return false;
    }

    // Empty-magazine handling must remain reachable while the rotor is stopped.
    if (weaponId === 'minigun' && !ready) return false;

    const input = this._pendingShotIntent;
    if (!input) return false;
    const mode = def.mode;
    if (mode === 'auto') {
      if (!input.held && !input.tap) return false;
    } else if (!input.tap) {
      return false;
    }
    return this._commitShot(now, def, weaponId, ammo, 1);
  }

  /**
   * Charge weapons: the press starts the capacitor, the hold is presented on the rig and
   * as a rising whine, and the slug leaves on release (or when the bank vents at holdMaxMs).
   * Mirrors the authoritative `resolveChargeIntent` so the predicted shot matches.
   */
  _tryChargeFire(now, def, weaponId) {
    const input = this._pendingShotIntent || { tap: false, held: false };
    const heldPrev = this._chargeHeldPrev;
    this._chargeHeldPrev = !!input.held;
    const profile = chargeProfile(def);
    const ammo = this._ammo[weaponId];
    if (this._chargeStart === null) {
      const pressed = input.tap || (input.held && !heldPrev);
      if (!pressed) return false;
      if (now < this._nextFireAt || now < this._deployUntil) return false;
      if (!ammo || this._reloadState) return false;
      if (ammo.mag <= 0) {
        this._audio.reloadClick(3, weaponId);
        this.startReload(now);
        return false;
      }
      this._chargeStart = now;
      this._rig.setCharge?.(0);
      this._audio.weaponCharge?.(0, true);
      return false;
    }
    const heldMs = now - this._chargeStart;
    const charge = chargeFromHold(def, heldMs);
    const vent = heldMs >= profile.holdMaxMs;
    if (input.held && !vent) {
      this._rig.setCharge?.(charge);
      this._audio.weaponCharge?.(charge, true);
      return false;
    }
    this.cancelCharge();
    if (!ammo || ammo.mag <= 0 || this._reloadState) return false;
    return this._commitShot(now, def, weaponId, ammo, charge);
  }

  /**
   * Melee (K-7 RIPPER): a swing is free — no magazine, no reload, no ballistics.
   * A tap edge or a held trigger swings on the rpm cadence alone; the reach cone
   * (and its backstab multiplier) is resolved by the authority, so the client
   * only replays the standard fire feedback: rig kick, report, and recoil.
   */
  _tryMeleeFire(now, def, weaponId) {
    const input = this._pendingShotIntent;
    if (!input || (!input.tap && !input.held)) return false;
    if (now < this._nextFireAt || now < this._deployUntil) return false;
    if (this._reloadState) return false;
    if (!this._rig.fire()) return false;
    this._nextFireAt = now + 60000 / def.rpm;
    this._audio.fire(weaponId);
    this.shakeView(def, now, 1);
    return true;
  }

  /** The accepted local shot: ammo, prediction, tracer/rocket FX, report, and recoil. */
  _commitShot(now, def, weaponId, ammo, charge = 1) {
    const mode = def.mode;
    if (!this._rig.fire()) return false;

    if (weaponId === 'minigun') heatMinigun(this._minigun);
    ammo.mag -= 1;
    const period = 60000 / def.rpm;
    // Preserve continuous fuel/rotary cadence across frame boundaries without catching up
    // missed shots after a pause or a stalled frame.
    this._nextFireAt = (def.flame || weaponId === 'minigun') && now - this._nextFireAt < period
      ? this._nextFireAt + period : now + period;

    // Every direction uses the pre-shot bloom and exhaustion values.
    const fwd = forwardFromAngles(this._yaw, this._pitch);
    const spreadCone = computeSpreadConeDeg(
      def,
      this._bloomDeg,
      this._speedXZ,
      this._adsT,
      this._panic,
      this._exhaustion,
      this._crouching,
      this._pain,
    );
    const pellets = [];
    for (let index = 0; index < def.pellets; index++) {
      pellets.push(samplePelletDirection(def, fwd, this._random, spreadCone, index));
    }

    this._bloomDeg = Math.min(def.bloomMaxDeg, this._bloomDeg + def.bloomDeg);
    const exhaustionGain = CONDITION_RULES.exhaustionShotGain * (def.flame ? 0.25 : 1);
    this._exhaustion = clamp01(this._exhaustion + exhaustionGain);
    this._feedback.addExhaustion(exhaustionGain);

    // The wire/prediction origin is the eye (the crosshair ray). The FX layer anchors
    // local tracers to the live rig muzzle and converges them on this ray's endpoint.
    const origin = [this._cameraX, this._cameraY, this._cameraZ];
    this._effects.shoot({
      o: origin,
      d: [fwd.x, fwd.y, fwd.z],
      w: weaponId,
      spread: pellets[0],
      pellets,
      chaos: this._mode === 'chaos',
      charge: mode === 'charge' ? charge : undefined,
    }, { local: true });

    if (def.flame) {
      this._flameActive = true; this._flameLastShotAt = now;
      this._rig.setFlame?.(true, ammo.mag / def.magSize);
    }
    this._audio.fire(weaponId, mode === 'charge' ? { charge } : undefined);
    this.shakeView(def, now, mode === 'charge' ? 0.45 + 0.55 * charge : 1);
    if (mode === 'pump') this._rig.pumpAnim();
    if (mode === 'bolt') this._rig.boltAnim();

    if (ammo.mag === 0) this._scheduleEmptyReload(weaponId, this._generation);
    return true;
  }

  shakeView(def, now, scale = 1) {
    if (now - this._lastRecoilAt > def.recoil.resetMs) this._recoilIndex = 0;
    const kick = computeRecoilKickDeg(def, this._recoilIndex, this._adsT, this._random());
    this._recoilIndex++;
    this._lastRecoilAt = now;
    this._feedback.addRecoil(
      kick.pitch * (Math.PI / 180) * scale,
      kick.yaw * (Math.PI / 180) * scale,
      def.weightKg,
      def.recoil,
      now,
    );
  }

  _resetRecoilPattern() {
    this._recoilIndex = 0;
    this._lastRecoilAt = -Infinity;
  }

  /** Ammo -> authoritative mode switch -> reload synchronization. */
  reconcileServer({
    mag,
    reserve,
    mode,
    owned,
    chaosUpgrades,
    minigun,
    weapon,
    reloading,
    alive = this._alive,
  }, now = this._now()) {
    this._alive = !!alive;
    this._chaosUpgrades = chaosUpgrades ? { ...chaosUpgrades } : null;
    this.adoptServerAmmo(mag, reserve);
    if (minigun) {
      this._minigun = { ...minigun };
      // A snapshot from before our weapon switch must not restore a spun-up
      // rotor during the new draw. Heat and the overheat lock remain authoritative.
      if (this.def.id !== 'minigun' || now < this._deployUntil) this._minigun.spin = 0;
      this._thermalAt = now;
    }
    this._setAuthority(mode, owned);

    if (
      usesAuthoritativeOwnedWeapons(this._mode) && Array.isArray(this._owned) &&
      !this._owned.includes(WEAPON_IDS[this._slot]) &&
      Number.isInteger(weapon) && WEAPON_IDS[weapon]
    ) {
      this.forceWeapon(weapon, { now });
    }

    // A late snapshot for the previous weapon says nothing about this request.
    if (typeof reloading !== 'boolean' ||
        (Number.isInteger(weapon) && weapon !== this._slot)) return;
    if (!reloading) {
      this._completedReloadWeapon = null;
      const reload = this._reloadState;
      // Until the authority acknowledges this reload, false may predate the
      // request or reflect a temporary draw/vault lock. An elapsed-time guess
      // used to cancel and restart empty-mag reloads every 400ms.
      if (reload?.acknowledged) this.cancelReload();
    } else if (this._reloadState) {
      this._reloadState.acknowledged = true;
    } else if (this._completedReloadWeapon !== this.def.id && this._alive) {
      const def = this.def;
      const ammo = this._ammo[def.id];
      const plan = reloadPlan(def, ammo ? ammo.mag : 0);
      const dur = (plan.staged ? plan.seconds : def.reloadTime) * 1000;
      this._reloadState = {
        startedAt: now,
        acknowledged: true,
        until: now + dur,
        dur,
        type: plan.staged ? 'tube' : 'magswap',
        weapon: def.id,
        // Authority already owns the ammo counts here; the client only animates.
        staged: false,
        stage: null,
      };
      this._resetRecoilPattern();
      this._rig.reload(dur / 1000, plan.staged ? 'tube' : 'magswap');
    }
  }

  deathReset() {
    this._alive = false;
    this.cancelCharge();
    this._reloadState = null;
    this._completedReloadWeapon = null;
    this._adsT = 0;
    this._scopeActive = false;
    this._resetRecoilPattern();
    this.clearIntents();
    if (this._rig.root) this._rig.root.visible = true;
  }

  respawn({ mode = this._mode, weapon, now = this._now() } = {}) {
    this._alive = true;
    this._minigun = createMinigunState();
    this._thermalAt = null;
    this._mode = mode;
    this._reloadState = null;
    this._completedReloadWeapon = null;
    this._adsT = 0;
    this._scopeActive = false;
    this._bloomDeg = 0;
    this._resetRecoilPattern();
    this.clearIntents();

    if (!usesAuthoritativeOwnedWeapons(mode)) {
      // Keep the equipped and quick-swap slots across lives.
      this.resetToLoadout();
    } else if (Number.isInteger(weapon) && WEAPON_IDS[weapon]) {
      this._slot = weapon;
    }

    this._deployUntil = now + this.def.deployTime * 1000;
    this._nextFireAt = this._deployUntil;
    this._rig.setWeapon(WEAPON_IDS[this._slot]);
    if (this._rig.root) this._rig.root.visible = true;
  }

  menuReset() {
    this._stopFlame();
    this._audio.minigunMotor?.(0, 0, false);
    if (this._emptyReloadTimer !== null) {
      this._clearTimer(this._emptyReloadTimer);
      this._emptyReloadTimer = null;
    }
    this._slot = 0;
    this._lastSlot = 1;
    this._ammo = Object.create(null);
    this._minigun = createMinigunState();
    this._thermalAt = null;
    this._nextFireAt = 0;
    this._deployUntil = 0;
    this._reloadState = null;
    this._completedReloadWeapon = null;
    this._bloomDeg = 0;
    this._resetRecoilPattern();
    this._adsT = 0;
    this._wantAds = false;
    this._scopeActive = false;
    this._pendingShotIntent = null;
    this._fireTapLatched = false;
    this._chargeStart = null;
    this._chargeHeldPrev = false;
    this._allowFire = false;
    this._grenadeHandling = false;
    this._alive = true;
    this._mode = DEFAULT_MODE;
    this._chaosUpgrades = null;
    this._owned = null;
    this._generation = 0;
    this._yaw = 0;
    this._pitch = 0;
    this._cameraX = 0;
    this._cameraY = 0;
    this._cameraZ = 0;
    this._speedXZ = 0;
    this._panic = 0;
    this._exhaustion = 0;
    this._crouching = false;
    this._pain = 0;
  }

  dispose() {
    if (this._disposed) return;
    if (this._emptyReloadTimer !== null) {
      this._clearTimer(this._emptyReloadTimer);
      this._emptyReloadTimer = null;
    }
    this._disposed = true;
    this._alive = false;
    this._reloadState = null;
    this._completedReloadWeapon = null;
    this.clearIntents();
  }

  _acceptFrameContext({
    allowFire = false,
    grenadeHandling = this._grenadeHandling,
    alive = this._alive,
    crouching = false,
    speedXZ = 0,
    panic = 0,
    exhaustion = 0,
    pain = 0,
    yaw = 0,
    pitch = 0,
    cameraX = 0,
    cameraY = 0,
    cameraZ = 0,
    generation = this._generation,
  } = {}) {
    this._allowFire = !!allowFire;
    this._grenadeHandling = !!grenadeHandling;
    this._alive = !!alive;
    if (!this._alive || !this._allowFire) this._stopFlame();
    this._crouching = !!crouching;
    this._speedXZ = Number.isFinite(speedXZ) ? speedXZ : 0;
    this._panic = clamp01(panic);
    this._exhaustion = clamp01(exhaustion);
    this._pain = clamp01(pain);
    this._yaw = Number.isFinite(yaw) ? yaw : 0;
    this._pitch = Number.isFinite(pitch) ? pitch : 0;
    this._cameraX = Number.isFinite(cameraX) ? cameraX : 0;
    this._cameraY = Number.isFinite(cameraY) ? cameraY : 0;
    this._cameraZ = Number.isFinite(cameraZ) ? cameraZ : 0;
    this._generation = generation;
  }

  _scheduleEmptyReload(weaponId, generation) {
    this._emptyReloadTimer = this._setTimer(() => {
      this._emptyReloadTimer = null;
      if (
        this._network.isCurrentGeneration(generation) &&
        this._network.isRunning() &&
        this._alive &&
        WEAPON_IDS[this._slot] === weaponId
      ) {
        this.startReload(this._now());
      }
    }, 240);
  }
}
