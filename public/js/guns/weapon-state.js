// Client weapon state machine. The composition root owns frame order; this module owns
// every weapon transition and receives only narrow adapters for its side effects.
import {
  CONDITION_RULES,
  SNIPER_SCOPE_ADS_THRESHOLD,
  WEAPONS,
  WEAPON_IDS,
  computeRecoilKickDeg,
  computeSpreadConeDeg,
  sampleSpreadDir,
} from '../../../shared/combatmath.js';
import { TIMERS } from './defs.js';

const EMPTY_AMMO = Object.freeze({ mag: 0, reserve: 0 });
const DEFAULT_MODE = 'fun';

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
 * - rig: setWeapon, fire, reload, getMuzzleWorldPos, pumpAnim, boltAnim, ads
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
      'getMuzzleWorldPos',
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
    this._muzzleTarget = null;
    this._disposed = false;
    this.menuReset();
  }

  get def() { return WEAPONS[WEAPON_IDS[this._slot]]; }
  get timerDef() { return TIMERS[WEAPON_IDS[this._slot]]; }
  get slot() { return this._slot; }
  get bloomDeg() { return this._bloomDeg; }
  get adsT() { return this._adsT; }
  get wantAds() { return this._wantAds; }
  get scopeActive() { return this._scopeActive; }
  get isReloading() { return this._reloadState !== null; }
  get reload01() { return this._reloadProgress(this._now()); }
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
      wname: def.name,
      wid: def.id,
      crosshairConeDeg: this.coneDeg,
      reloading01: this._reloadProgress(now),
      adsT01: this._adsT,
      zoom: def.zoom,
    };
  }


  /** Fill canonical magazines/reserves without changing the selected slot. */
  resetToLoadout() {
    this._ammo = Object.create(null);
    for (const weaponId of WEAPON_IDS) {
      const def = WEAPONS[weaponId];
      this._ammo[weaponId] = { mag: def.magSize, reserve: def.reserveMax };
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
        ammo = this._ammo[weaponId] = { mag: def.magSize, reserve: def.reserveMax };
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

    this._lastSlot = this._slot;
    this._slot = slot;
    this._resetRecoilPattern();
    this._reloadState = null;
    this._deployUntil = now + this.def.deployTime * 1000;
    this._nextFireAt = Math.max(this._nextFireAt, this._deployUntil);
    this._rig.setWeapon(WEAPON_IDS[slot]);
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
  }, now, {
    allowFire = false,
    alive = this._alive,
    mode,
    owned,
  } = {}) {
    this._alive = !!alive;
    this._allowFire = !!allowFire;
    this._setAuthority(mode, owned);
    this._wantAds = !!wantAds;

    if (switchDelta) this.cycleWeapon(switchDelta, { now });
    if (slot !== null) this.forceWeapon(slot, { now });
    if (lastWeapon) this.forceWeapon(this._lastSlot, { now });
    if (reload && this._alive) this.startReload(now);

    if (fireTap && this._allowFire) this._fireTapLatched = true;
    if (!this._allowFire) this._fireTapLatched = false;
    this._pendingShotIntent = {
      tap: this._allowFire && !!fireTap,
      held: this._allowFire && !!fireHeld,
    };
  }

  clearIntents() {
    this._pendingShotIntent = null;
    this._fireTapLatched = false;
    this._wantAds = false;
    this._allowFire = false;
  }

  startReload(now) {
    if (this._reloadState || !this._alive) return false;
    const def = this.def;
    const ammo = this._ammo[def.id];
    if (!ammo || ammo.mag >= def.magSize || ammo.reserve <= 0) return false;

    const dur = def.reloadTime * 1000;
    const type = def.id === 'shotgun' ? 'tube' : 'magswap';
    this._reloadState = { until: now + dur, dur, type, weapon: def.id };
    this._resetRecoilPattern();
    this._rig.reload(dur / 1000, type);
    return true;
  }

  tickReload(now) {
    const reload = this._reloadState;
    if (!reload || now < reload.until) return false;

    const def = WEAPONS[reload.weapon];
    const ammo = this._ammo[reload.weapon];
    if (def && ammo) {
      const need = def.magSize - ammo.mag;
      const take = Math.min(need, ammo.reserve);
      ammo.mag += take;
      ammo.reserve -= take;
    }
    this._reloadState = null;
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
  settleFrame(dt) {
    if (this._disposed) return;
    const def = this.def;
    this._bloomDeg = Math.max(0, this._bloomDeg - def.bloomRecover * dt);
    this._adsT += (
      (this._wantAds && this._alive && !this._reloadState) ? 1 : -1
    ) * dt / Math.max(0.08, def.adsTime);
    this._adsT = Math.max(0, Math.min(1, this._adsT));
    this._scopeActive = this._alive && def.id === 'sniper' &&
      this._adsT >= SNIPER_SCOPE_ADS_THRESHOLD;
    if (this._rig.root) this._rig.root.visible = !this._scopeActive;
  }

  /** Call at the original rig-update point, after camera/body updates. */
  syncRigAds() {
    this._rig.ads(this._adsT);
  }

  /** Direct fire transition for callers that keep the former split tick/fire frame order. */
  tryFire(now, context) {
    if (context) this._acceptFrameContext(context);
    return this._tryFire(now);
  }

  _tryFire(now) {
    // Authority is deliberately the first gate.
    if (!this._allowFire) return false;
    const def = this.def;
    const weaponId = def.id;
    if (now < this._nextFireAt || now < this._deployUntil) return false;
    if (this._reloadState) return false;

    const ammo = this._ammo[weaponId];
    if (!ammo) return false;
    if (ammo.mag <= 0) {
      if (this._pendingShotIntent && this._pendingShotIntent.tap) {
        this._audio.reloadClick(3, weaponId);
      }
      this.startReload(now);
      return false;
    }

    const input = this._pendingShotIntent;
    if (!input) return false;
    const mode = def.mode;
    if (mode === 'auto') {
      if (!input.held && !input.tap) return false;
    } else if (!input.tap) {
      return false;
    }
    if (!this._rig.fire()) return false;

    ammo.mag -= 1;
    this._nextFireAt = now + 60000 / def.rpm;

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
      pellets.push(sampleSpreadDir(fwd, this._random, spreadCone));
    }

    this._bloomDeg = Math.min(def.bloomMaxDeg, this._bloomDeg + def.bloomDeg);
    this._exhaustion = clamp01(this._exhaustion + CONDITION_RULES.exhaustionShotGain);
    this._feedback.addExhaustion(CONDITION_RULES.exhaustionShotGain);

    let origin;
    if (this._adsT > 0.55) {
      const muzzle = this._muzzleTarget
        ? this._rig.getMuzzleWorldPos(this._muzzleTarget)
        : (this._muzzleTarget = this._rig.getMuzzleWorldPos());
      origin = [muzzle.x, muzzle.y, muzzle.z];
    } else {
      origin = [this._cameraX, this._cameraY, this._cameraZ];
    }
    this._effects.shoot({
      o: origin,
      d: [fwd.x, fwd.y, fwd.z],
      w: weaponId,
      spread: pellets[0],
      pellets,
    }, { local: true });

    this._audio.fire(weaponId);
    this.shakeView(def, now);
    if (mode === 'pump') this._rig.pumpAnim();
    if (mode === 'bolt') this._rig.boltAnim();

    if (ammo.mag === 0) this._scheduleEmptyReload(weaponId, this._generation);
    return true;
  }

  shakeView(def, now) {
    if (now - this._lastRecoilAt > def.recoil.resetMs) this._recoilIndex = 0;
    const kick = computeRecoilKickDeg(def, this._recoilIndex, this._adsT, this._random());
    this._recoilIndex++;
    this._lastRecoilAt = now;
    this._feedback.addRecoil(kick.pitch * (Math.PI / 180), kick.yaw * (Math.PI / 180));
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
    weapon,
    reloading,
    alive = this._alive,
  }, now = this._now()) {
    this._alive = !!alive;
    this.adoptServerAmmo(mag, reserve);
    this._setAuthority(mode, owned);

    if (
      usesAuthoritativeOwnedWeapons(this._mode) && Array.isArray(this._owned) &&
      !this._owned.includes(WEAPON_IDS[this._slot]) &&
      Number.isInteger(weapon) && WEAPON_IDS[weapon]
    ) {
      this.forceWeapon(weapon, { now });
    }

    if (!reloading) {
      this._reloadState = null;
    } else if (!this._reloadState && this._alive) {
      const def = this.def;
      const dur = def.reloadTime * 1000;
      this._reloadState = {
        until: now + dur,
        dur,
        type: 'magswap',
        weapon: def.id,
      };
      this._resetRecoilPattern();
      this._rig.reload(dur / 1000, 'magswap');
    }
  }

  deathReset() {
    this._alive = false;
    this._reloadState = null;
    this._adsT = 0;
    this._scopeActive = false;
    this._resetRecoilPattern();
    this.clearIntents();
    if (this._rig.root) this._rig.root.visible = true;
  }

  respawn({ mode = this._mode, weapon, now = this._now() } = {}) {
    this._alive = true;
    this._mode = mode;
    this._reloadState = null;
    this._adsT = 0;
    this._scopeActive = false;
    this._bloomDeg = 0;
    this._resetRecoilPattern();
    this.clearIntents();

    if (!usesAuthoritativeOwnedWeapons(mode)) {
      this._slot = 0;
      this._lastSlot = 1;
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
    if (this._emptyReloadTimer !== null) {
      this._clearTimer(this._emptyReloadTimer);
      this._emptyReloadTimer = null;
    }
    this._slot = 0;
    this._lastSlot = 1;
    this._ammo = Object.create(null);
    this._nextFireAt = 0;
    this._deployUntil = 0;
    this._reloadState = null;
    this._bloomDeg = 0;
    this._resetRecoilPattern();
    this._adsT = 0;
    this._wantAds = false;
    this._scopeActive = false;
    this._pendingShotIntent = null;
    this._fireTapLatched = false;
    this._allowFire = false;
    this._alive = true;
    this._mode = DEFAULT_MODE;
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
    this.clearIntents();
    this._muzzleTarget = null;
  }

  _acceptFrameContext({
    allowFire = false,
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
    this._alive = !!alive;
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
