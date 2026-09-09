import { isScopeActive, nextScopeZoom } from '../guns/scope-state.js';
import { EYE_HEIGHT, CONDITION_RULES } from '../../../shared/combatmath.js';
import { stanceEye } from '../../../shared/player-stance.js';
import { PlayerPhysics, moveSpeedFor } from '../player-physics.js';
import { hashInt } from '../util/hash.js';
import { clamp01, clampPitch, easeOut, nowMs, smooth01 } from '../util/math.js';
import { adsLookScale } from '../input-settings.js';
import { grenadeLaunch } from '../../../shared/grenade-rules.js';
import { recoverConditions } from '../../../shared/conditions.js';
import { fwdFromAngles } from '../util/look.js';
import { withGoreDamage } from '../weapons/gore-profile.js';
import { AimSway } from './aim-sway.js';
import { WeaponAimMotion } from '../guns/weapon-aim.js';
import { resetFirstPersonBody, updateFirstPersonBody } from './first-person-body.js';

const DEFAULT_SEND_HZ = 60;
const DEFAULT_FOV = 75;
// Reach 95% of the crouched camera height in about 0.2 seconds.
const CROUCH_CAMERA_FOLLOW = 15;
const EMPTY_RECONCILE = Object.freeze({ applied: false, transition: null });

// Camera recoil is a critically-ish damped spring driven by velocity impulses rather
// than an instant offset: the kick builds over ~40–60 ms (the frame the round leaves)
// and then the muzzle is walked back down over a weight-scaled recovery. Heavier guns
// use a slower spring, so their recoil lingers and sustained fire piles up more.
const RECOIL_REFERENCE_WEIGHT_KG = 3.4;
const RECOIL_OMEGA_REFERENCE = 24;      // rad/s natural frequency for the reference mass
const RECOIL_OMEGA_RANGE = [14, 34];
const RECOIL_DAMPING_RATIO = 0.82;     // a touch under critical: visible settle bounce
/** Fraction of each pitch kick that stays on the true aim (spray control), radians in. */
const RECOIL_AIM_CLIMB = 0.18;
/** Fraction of each yaw kick that drifts the true aim so patterns matter sideways too. */
const RECOIL_AIM_DRIFT = 0.10;
/** Camera roll coupled to lateral recoil (rad per rad of yaw kick). */
const RECOIL_ROLL_PER_YAW = -0.42;
/** Aim-climb recovery: once fire pauses for the weapon's resetMs, the weapon's `recovery`
 * fraction of the accumulated climb walks back at this rate (1/s). Mouse compensation
 * during the spray is subtracted first, so a controlled spray never over-recovers. */
const RECOIL_RECOVERY_RATE = 11;
const DEFAULT_RECOIL_PROFILE = Object.freeze({ resetMs: 280, recovery: 0.6 });
const AIM_PUNCH_FULL_DAMAGE = 55;
const AIM_PUNCH_MAX_TRAUMA = 1.55;

/** Reconciliation: the authority correction lands on the physics body at once while the
 * camera eases through a decaying visual offset, so corrections never read as a pop. */
const RECONCILE_SNAP_DISTANCE = 3.2;
const RECONCILE_DEAD_ZONE = 0.12;
const RECONCILE_CORRECTION = 0.28;
const RECONCILE_OFFSET_CLAMP = 1.6;
const RECONCILE_OFFSET_DECAY = 13;   // 1/s (~75 ms to settle a small correction)
const RECONCILE_SNAP_DECAY = 7;      // 1/s for a hard snap (~140 ms)

/** Camera FOV that presents `zoom` magnification against `baseFov` (degrees). */
export function fovForZoom(zoom, baseFov = DEFAULT_FOV) {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const base = Number.isFinite(baseFov) ? baseFov : DEFAULT_FOV;
  const half = Math.atan(Math.tan(base * Math.PI / 360) / z);
  return half * 360 / Math.PI;
}

function recoilOmegaFor(weightKg) {
  const weight = Number.isFinite(weightKg) && weightKg > 0 ? weightKg : RECOIL_REFERENCE_WEIGHT_KG;
  const omega = RECOIL_OMEGA_REFERENCE * Math.pow(RECOIL_REFERENCE_WEIGHT_KG / weight, 0.3);
  return Math.max(RECOIL_OMEGA_RANGE[0], Math.min(RECOIL_OMEGA_RANGE[1], omega));
}

/** Velocity impulse that makes an underdamped spring peak at exactly 1 unit of displacement. */
function impulseGainFor(omega, zeta) {
  const damped = omega * Math.sqrt(Math.max(1e-6, 1 - zeta * zeta));
  const peakAt = Math.atan2(damped, zeta * omega) / damped;
  const peak = Math.exp(-zeta * omega * peakAt) * Math.sin(damped * peakAt) / damped;
  return peak > 1e-9 ? 1 / peak : omega;
}

function stepRecoilSpring(spring, omega, dt) {
  const k = omega * omega;
  const c = 2 * RECOIL_DAMPING_RATIO * omega;
  const steps = 4;
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    spring.v += (-k * spring.p - c * spring.v) * h;
    spring.p += spring.v * h;
  }
}

function isAllowed(value) {
  return typeof value === 'function' ? !!value() : !!value;
}

function isValidImpact(ev) {
  return !!ev && Number.isFinite(Number(ev.vx)) &&
    Number.isFinite(Number(ev.vy)) && Number.isFinite(Number(ev.vz));
}

/**
 * Owns every piece of mutable first-person player state. The composition root
 * supplies authority decisions and the weapon/network adapters for a frame;
 * neither Game nor another engine host object crosses this seam.
 */
export class LocalPlayer {
  constructor({
    physics = new PlayerPhysics(),
    input,
    sendHz = DEFAULT_SEND_HZ,
    body = null,
    baseFov = DEFAULT_FOV,
    aimSway = new AimSway(),
  } = {}) {
    if (!input || typeof input.consumeDelta !== 'function' || typeof input.getKeys !== 'function') {
      throw new TypeError('LocalPlayer requires an Input-compatible adapter');
    }
    if (!physics || typeof physics.step !== 'function' || typeof physics.eyeY !== 'function') {
      throw new TypeError('LocalPlayer requires a PlayerPhysics-compatible adapter');
    }
    if (!aimSway || typeof aimSway.update !== 'function' || typeof aimSway.reset !== 'function') {
      throw new TypeError('LocalPlayer requires an AimSway-compatible module');
    }

    this.physics = physics;
    this.input = input;
    this.body = body;
    this.baseFov = Number.isFinite(baseFov) ? baseFov : DEFAULT_FOV;
    this.sendHz = Number.isFinite(sendHz) && sendHz > 0 ? sendHz : DEFAULT_SEND_HZ;
    this.aimSway = aimSway;
    this._aim = aimSway.readModel;
    this._weaponAim = new WeaponAimMotion();

    this.view = { yaw: 0, pitch: 0 };
    this.keys = {};
    this.wishDir = { x: 0, z: 0 };
    this._alive = true;
    this._hp = 100;
    this.panic = 0;
    this.burning = 0;
    this.exhaustion = 0;
    this.pain = 0;
    this.spawnProtected = false;
    this.currentSpeedXZ = 0;
    this._recoilSpring = { pitch: { p: 0, v: 0 }, yaw: { p: 0, v: 0 } };
    this._recoilOmega = recoilOmegaFor(RECOIL_REFERENCE_WEIGHT_KG);
    this._recoilProfile = DEFAULT_RECOIL_PROFILE;
    this._climb = { pitch: 0, yaw: 0 };
    this._climbFloor = { pitch: 0, yaw: 0 };
    this._lastRecoilAt = -Infinity;
    this._recovering = false;
    this._reconcileOffset = { x: 0, y: 0, z: 0, decay: RECONCILE_OFFSET_DECAY };
    this._lookScale = 1;
    this._scopeZoom = 0;
    this._cameraCrouch = 0;
    this._localGrenadeThrow = null;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.recoilRoll = 0;
    this.adsT = 0;
    this.wantAds = false;
    this.scopeActive = false;
    this.deathElapsed = 0;
    this.deathRoll = 0;
    this.deathPitch = 0;
    this.deathSide = 1;
    this.sendAccum = 0;
    this.pendingShotIntent = null;
    this.fireTapLatched = false;
    this._acceptedFireSlot = null;
    this._pendingShotAim = null;
    this.grenadeThrowLatched = null; // {charge, cookMs, type, at, grenadeAim} awaiting a network send
    this.grenadeHandling = false;
    this._lastLocalImpact = null;
    this._lastReconciledSnapSeq = null;
    this._gameplayInputEnabled = false;
    this._disposed = false;

    // Reused frame records avoid adding hot-path garbage beyond the objects
    // already produced by Input and the wire payload.
    this._weaponIntents = {
      switchDelta: 0,
      slot: null,
      lastWeapon: false,
      reload: false,
      reloadAt: 0,
      shot: null,
      wantAds: false,
      buyMenuRequested: false,
      blockedByBuyMenu: false,
      fireTap: false,
      fireHeld: false,
      throwGrenade: null,
      grenadeHandling: false,
    };
    this._frame = {
      jumped: false,
      weaponIntents: this._weaponIntents,
      inputSent: false,
      inputPayload: null,
    };
    this._reconcileResult = { applied: true, transition: null };
    this._conditions = {};
    Object.defineProperties(this._conditions, {
      panic: { enumerable: true, get: () => this.panic },
      exhaustion: { enumerable: true, get: () => this.exhaustion },
      pain: { enumerable: true, get: () => this.pain },
    });
    this.input.setGameplayEnabled(false);
  }

  get alive() { return this._alive; }
  get hp() { return this._hp; }
  get conditions() { return this._conditions; }
  get pos() { return this.physics.pos; }
  get eyeY() { return this.physics.eyeY(); }
  get speedXZ() { return this.currentSpeedXZ; }
  get crouchBool() { return !!this.physics._crouching; }
  get gameplayInputEnabled() { return this._gameplayInputEnabled; }
  get weaponAim() { return this._weaponAim.readModel; }
  get shotYaw() { return this.aimYaw + this.recoilYaw + this.weaponAim.yaw; }
  get shotPitch() { return clampPitch(this.aimPitch + this.recoilPitch + this.weaponAim.pitch); }

  get aimYaw() { return this.view.yaw + (this._aim?.yaw || 0); }
  get aimPitch() { return clampPitch(this.view.pitch + (this._aim?.pitch || 0)); }
  get aimMotion() { return this._aim; }
  /** Accumulated aim climb still owed to recovery (radians), for HUD/debug readback. */
  get recoilClimb() { return this._climb; }
  /** Live camera offset left by the last reconciliation, decaying toward zero. */
  get reconcileOffset() { return this._reconcileOffset; }
  /** Current scope magnification (0 when the held weapon has no zoom steps). */
  get scopeZoom() { return this._scopeZoom; }

  setMapMeta(mapMeta = null) {
    this.physics.setMapMeta(mapMeta);
    return this;
  }

  setFirstPersonBody(body = null) {
    this.body = body;
    return this;
  }

  setBaseFov(baseFov) {
    if (Number.isFinite(baseFov)) this.baseFov = baseFov;
  }

  /**
   * Mirrors the old input gate exactly: Input is toggled first; local edges
   * are cleared only on an actual enabled -> disabled transition.
   */
  setGameplayInputEnabled(enabled) {
    const next = !!enabled && !this._disposed;
    this.input.setGameplayEnabled(next);
    if (next === this._gameplayInputEnabled) return;
    this._gameplayInputEnabled = next;
    if (next) {
      this.input.consumeBuyMenuRequest();
      return;
    }
    this.keys = {};
    this.wishDir.x = 0;
    this.wishDir.z = 0;
    this._weaponAim.reset(this.aimYaw, this.aimPitch);
    this.pendingShotIntent = null;
    this.fireTapLatched = false;
    this._acceptedFireSlot = null;
    this._pendingShotAim = null;
    this.grenadeThrowLatched = null;
    this.grenadeHandling = false;
    this._localGrenadeThrow = null;
    this.wantAds = false;
    this.physics._crouching = false;
    this._cameraCrouch = 0;
    this.physics.proneT = 0;
    this.physics.wantProne = false;
  }

  spawnAt(x, y, z) {
    if (![x, y, z].every(Number.isFinite)) return false;
    this.physics.pos.x = x;
    this.physics.pos.y = y;
    this.physics.pos.z = z;
    this.physics.vel.x = 0;
    this.physics.vel.y = 0;
    this.physics.vel.z = 0;
    this.physics.grounded = false;
    this.physics.coyote = 0;
    this.physics.vault = null;
    this.physics.jumpGroundY = null;
    this.physics.jumpWasHeld = false;
    this.physics.lastImpulseSeq = 0;
    this.physics._crouching = false;
    this._cameraCrouch = 0;
    this.physics.proneT = 0;
    this.physics.wantProne = false;
    return true;
  }

  /** Reset all player-owned state when returning to the menu. */
  resetForMenu({ physics = new PlayerPhysics(), body = null, baseFov = this.baseFov } = {}) {
    if (!physics || typeof physics.step !== 'function' || typeof physics.eyeY !== 'function') {
      throw new TypeError('resetForMenu requires a PlayerPhysics-compatible adapter');
    }
    this.physics = physics;
    this._cameraCrouch = 0;
    this.setGameplayInputEnabled(false);
    this.body = body;
    this.baseFov = Number.isFinite(baseFov) ? baseFov : DEFAULT_FOV;
    this.view.yaw = 0;
    this.view.pitch = 0;
    this.keys = {};
    this.wishDir.x = 0;
    this.wishDir.z = 0;
    this._alive = true;
    this._hp = 100;
    this.panic = 0;
    this.burning = 0;
    this.exhaustion = 0;
    this.pain = 0;
    this.spawnProtected = false;
    this.currentSpeedXZ = 0;
    this._resetRecoil();
    this._resetReconcileOffset();
    this._scopeZoom = 0;
    this.adsT = 0;
    this.wantAds = false;
    this.scopeActive = false;
    this.deathElapsed = 0;
    this.deathRoll = 0;
    this.deathPitch = 0;
    this.deathSide = 1;
    this.sendAccum = 0;
    this.pendingShotIntent = null;
    this.fireTapLatched = false;
    this._acceptedFireSlot = null;
    this._pendingShotAim = null;
    this.grenadeThrowLatched = null;
    this.grenadeHandling = false;
    this._localGrenadeThrow = null;
    this._lastLocalImpact = null;
    this._lastReconciledSnapSeq = null;
    this._reconcileResult.transition = null;
    this._aim = this.aimSway.reset();
    this._weaponAim.reset(this.aimYaw, this.aimPitch);
  }

  /** State-only half of a local respawn. */
  respawn(ev, {
    spawnProtected = typeof ev?.spawnProtected === 'boolean' ? ev.spawnProtected : true,
  } = {}) {
    if (!ev || ![ev.x, ev.y, ev.z].every(Number.isFinite)) return null;
    this.spawnAt(ev.x, ev.y, ev.z);
    this._alive = true;
    this._hp = 100;
    this.panic = 0;
    this.burning = 0;
    this.exhaustion = 0;
    this.pain = Number.isFinite(ev.pain) ? clamp01(ev.pain) : 0;
    this.spawnProtected = typeof spawnProtected === 'boolean' ? spawnProtected : true;
    this._lastLocalImpact = null;
    this.deathElapsed = 0;
    this.deathRoll = 0;
    this.deathPitch = 0;
    this._resetRecoil();
    this._resetReconcileOffset();
    this.currentSpeedXZ = 0;
    this.scopeActive = false;
    this.fireTapLatched = false;
    this._acceptedFireSlot = null;
    this._pendingShotAim = null;
    this.pendingShotIntent = null;
    this.grenadeThrowLatched = null;
    this.grenadeHandling = false;
    this._localGrenadeThrow = null;
    this.wantAds = false;
    this.adsT = 0;
    this._aim = this.aimSway.reset();
    this._weaponAim.reset(this.aimYaw, this.aimPitch);
    resetFirstPersonBody(this.body);
    return { kind: 'respawn', row: ev };
  }

  /** State-only half of local death; presentation belongs to combat feedback. */
  die(killerId, {
    impact = null,
    damageEvent = null,
    headshot = false,
    id = null,
  } = {}) {
    if (!this._alive) return null;
    const resolvedImpact = impact || this._lastLocalImpact;
    const resolvedHeadshot = !!(headshot || resolvedImpact?.hs);
    this._alive = false;
    this.burning = 0;
    this._hp = 0;
    this.adsT = 0;
    this.scopeActive = false;
    this.spawnProtected = false;
    this.currentSpeedXZ = 0;
    this.deathElapsed = 0;
    this.deathSide = (hashInt(String(id) + '|' + String(killerId || 'world')) & 1) ? 1 : -1;
    this._impulseRecoil(
      resolvedHeadshot ? 0.2 : 0.11,
      this.deathSide * (resolvedHeadshot ? 0.14 : 0.08),
    );
    const goreImpact = withGoreDamage(isValidImpact(resolvedImpact)
      ? resolvedImpact
      : {
        vx: this.physics.pos.x,
        vy: this.physics.pos.y + 1.05,
        vz: this.physics.pos.z,
        hs: resolvedHeadshot,
      }, damageEvent);
    this._lastLocalImpact = null;
    return {
      kind: 'death',
      killerId: killerId || null,
      headshot: resolvedHeadshot,
      impact: resolvedImpact,
      goreImpact,
      deathSide: this.deathSide,
    };
  }

  /** Apply only the player-state/view half of a non-lethal local hit. */
  applyHit(ev) {
    if (!this._alive || !ev) return null;
    this._lastLocalImpact = ev;
    const rawDamage = Number(ev.dmg);
    const damage = Number.isFinite(rawDamage) ? Math.max(0, rawDamage) : 0;
    const healthDamage = Number.isFinite(ev.healthDamage) ? Math.max(0, ev.healthDamage) : damage;
    const severity = clamp01(damage / 55);
    const injurySeverity = clamp01(healthDamage / 55);
    const painLevel = injurySeverity;
    const headshot = !!ev.hs;
    // Only this hit's post-armor damage moves the aim. Headshots already carry
    // their damage multiplier; old wounds must not amplify a small new hit.
    const trauma = clamp01(healthDamage / AIM_PUNCH_FULL_DAMAGE) * AIM_PUNCH_MAX_TRAUMA;
    const side = (hashInt(`${ev.attacker}|${ev.vx}|${ev.vz}`) & 1) ? 1 : -1;
    this.view.yaw += side * trauma * 0.045;
    this.view.pitch += trauma * 0.052;
    this.view.pitch = clampPitch(this.view.pitch);
    return {
      damage,
      healthDamage,
      severity,
      painLevel,
      headshot,
      trauma,
      side,
      painImpulse: clamp01(severity * 0.12 + injurySeverity * 0.78),
      impact: ev,
    };
  }

  addExhaustion(amount) {
    if (Number.isFinite(amount)) this.exhaustion = clamp01(this.exhaustion + amount);
  }

  /**
   * Weapon recoil, radians. The camera spring peaks at (pitch, yaw) a few frames later
   * and recovers on its own; RECOIL_AIM_CLIMB of the pitch kick stays on the authoritative
   * aim so sustained fire must be pulled down. `weightKg` slows the spring for heavy guns.
   */
  addRecoil(pitch = 0, yaw = 0, weightKg = RECOIL_REFERENCE_WEIGHT_KG, profile = null, now = nowMs()) {
    const p = Number.isFinite(pitch) ? pitch : 0;
    const y = Number.isFinite(yaw) ? yaw : 0;
    this._recoilOmega = recoilOmegaFor(weightKg);
    this._recoilProfile = profile && Number.isFinite(profile.resetMs)
      ? profile
      : DEFAULT_RECOIL_PROFILE;
    // Freeze this shot before its own recoil changes view angles. Keep it until sent.
    if (this._alive) this._pendingShotAim = { yaw: this.shotYaw, pitch: this.shotPitch };
    this._impulseRecoil(p, y);
    if (!this._alive) return;
    // A fresh shot while recovering re-arms the spray: whatever climb is still owed
    // keeps accumulating instead of being written off.
    this._recovering = false;
    this._climbFloor.pitch = 0;
    this._climbFloor.yaw = 0;
    this._lastRecoilAt = Number.isFinite(now) ? now : nowMs();
    if (p !== 0) {
      const climb = p * RECOIL_AIM_CLIMB;
      this.view.pitch = clampPitch(this.view.pitch + climb);
      this._climb.pitch += climb;
    }
    if (y !== 0) {
      const drift = y * RECOIL_AIM_DRIFT;
      this.view.yaw += drift;
      this._climb.yaw += drift;
    }
  }

  /** Walks the owed aim climb back toward its floor once the spray has paused. */
  _stepRecoilRecovery(dt, now) {
    const climb = this._climb;
    if (!this._alive || (climb.pitch === 0 && climb.yaw === 0)) return;
    if (now - this._lastRecoilAt < this._recoilProfile.resetMs) return;
    if (!this._recovering) {
      this._recovering = true;
      const keep = 1 - clamp01(this._recoilProfile.recovery);
      this._climbFloor.pitch = climb.pitch * keep;
      this._climbFloor.yaw = climb.yaw * keep;
    }
    const k = 1 - Math.exp(-dt * RECOIL_RECOVERY_RATE);
    const dPitch = (climb.pitch - this._climbFloor.pitch) * k;
    const dYaw = (climb.yaw - this._climbFloor.yaw) * k;
    this.view.pitch = clampPitch(this.view.pitch - dPitch);
    this.view.yaw -= dYaw;
    climb.pitch -= dPitch;
    climb.yaw -= dYaw;
    if (Math.abs(climb.pitch - this._climbFloor.pitch) < 1e-4 &&
        Math.abs(climb.yaw - this._climbFloor.yaw) < 1e-4) {
      // The remainder becomes permanent aim: the player owns it from here.
      climb.pitch = 0;
      climb.yaw = 0;
      this._climbFloor.pitch = 0;
      this._climbFloor.yaw = 0;
      this._recovering = false;
    }
  }

  /** Scope zoom step: alternate between the optic's full and half magnification. */
  cycleScopeZoom(weaponDef) {
    this._scopeZoom = nextScopeZoom(weaponDef, this._scopeZoom);
    return this._scopeZoom;
  }

  /** Current look-input multiplier (1 at hip, shrinks with ADS zoom). */
  get lookScale() { return this._lookScale; }

  /**
   * One-shot readback of a grenade release accepted this frame
   * (`{charge, cookMs, type, at, grenadeAim}` or null), so presentation can spawn the predicted throw
   * before the authority event returns.
   */
  consumeLocalGrenadeThrow() {
    const pending = this._localGrenadeThrow;
    this._localGrenadeThrow = null;
    return pending;
  }

  /** Launch state for a local throw with the same formula authority applies. */
  grenadeLaunchState(charge, type = 'frag', grenadeAim = null) {
    const dir = fwdFromAngles(grenadeAim?.yaw ?? this.shotYaw, grenadeAim?.pitch ?? this.shotPitch);
    const pos = this.physics.pos;
    const vel = this.physics.vel;
    return grenadeLaunch({
      x: pos.x, y: pos.y, z: pos.z, eyeY: this.physics.eyeY(),
      vx: vel.x, vy: vel.y, vz: vel.z,
      dir, charge, type,
    });
  }

  _impulseRecoil(pitch, yaw) {
    const gain = impulseGainFor(this._recoilOmega, RECOIL_DAMPING_RATIO);
    this._recoilSpring.pitch.v += pitch * gain;
    this._recoilSpring.yaw.v += yaw * gain;
  }

  _resetRecoil() {
    this._recoilSpring.pitch.p = this._recoilSpring.pitch.v = 0;
    this._recoilSpring.yaw.p = this._recoilSpring.yaw.v = 0;
    this._recoilOmega = recoilOmegaFor(RECOIL_REFERENCE_WEIGHT_KG);
    this._climb.pitch = this._climb.yaw = 0;
    this._climbFloor.pitch = this._climbFloor.yaw = 0;
    this._lastRecoilAt = -Infinity;
    this._recovering = false;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.recoilRoll = 0;
  }

  _resetReconcileOffset() {
    this._reconcileOffset.x = this._reconcileOffset.y = this._reconcileOffset.z = 0;
    this._reconcileOffset.decay = RECONCILE_OFFSET_DECAY;
  }

  _readLook() {
    const delta = this.input.consumeDelta();
    if (!this._alive) return;
    const dx = delta.dx * this._lookScale;
    const dy = delta.dy * this._lookScale;
    this.view.yaw -= dx;
    this.view.pitch -= dy;
    this.view.pitch = clampPitch(this.view.pitch);
    // Pulling down against the climb is compensation the recovery must not undo.
    const climb = this._climb;
    if (climb.pitch > 0 && dy > 0) climb.pitch = Math.max(0, climb.pitch - dy);
    if (climb.yaw !== 0 && Math.sign(dx) === Math.sign(climb.yaw)) {
      climb.yaw = Math.sign(climb.yaw) * Math.max(0, Math.abs(climb.yaw) - Math.abs(dx));
    }
  }

  _sampleMovement(now, intents) {
    const input = this.input;
    const weaponIntents = this._weaponIntents;
    this.keys = input.getKeys();
    weaponIntents.switchDelta = 0;
    weaponIntents.slot = null;
    weaponIntents.lastWeapon = false;
    weaponIntents.reload = false;
    weaponIntents.reloadAt = now;
    weaponIntents.shot = this.pendingShotIntent;
    weaponIntents.wantAds = this.wantAds;
    weaponIntents.buyMenuRequested = false;
    weaponIntents.blockedByBuyMenu = false;
    weaponIntents.fireTap = false;
    weaponIntents.fireHeld = false;
    weaponIntents.throwGrenade = null;
    weaponIntents.grenadeHandling = this.grenadeHandling;

    if (input.consumeBuyMenuRequest()) {
      weaponIntents.buyMenuRequested = true;
      const menuOpen = typeof intents.toggleBuyMenu === 'function'
        ? !!intents.toggleBuyMenu()
        : !!intents.buyMenuOpen;
      if (menuOpen) {
        weaponIntents.blockedByBuyMenu = true;
        return weaponIntents;
      }
    }

    const fireAllowed = isAllowed(intents.fireAllowed);
    const grenadeThrow = input.consumeGrenadeThrow();
    if (grenadeThrow && fireAllowed && this._alive) {
      this.grenadeThrowLatched = {
        charge: grenadeThrow.charge,
        cookMs: grenadeThrow.cookMs,
        type: grenadeThrow.type,
        at: now,
      };
    }
    if (!fireAllowed || !this._alive) {
      this.grenadeThrowLatched = null;
      this._localGrenadeThrow = null;
    }
    weaponIntents.throwGrenade = this.grenadeThrowLatched;
    const externalHandling = intents.weaponHandlingAllowed == null || isAllowed(intents.weaponHandlingAllowed);
    this.grenadeHandling = this._alive && fireAllowed && (!externalHandling || !!this.grenadeThrowLatched);
    weaponIntents.grenadeHandling = this.grenadeHandling;
    const weaponHandling = !this.grenadeHandling;
    this.wantAds = !!input.wantAdsHeld && weaponHandling;
    weaponIntents.wantAds = this.wantAds;
    weaponIntents.switchDelta = input.consumeWeaponSwitch();
    weaponIntents.slot = input.consumeWeaponSlot();
    weaponIntents.lastWeapon = input.consumeLastWeaponRequest();
    weaponIntents.reload = !!(this.keys.reload && this._alive);
    if (!weaponHandling) {
      weaponIntents.switchDelta = 0;
      weaponIntents.slot = null;
      weaponIntents.lastWeapon = false;
      weaponIntents.reload = false;
    }
    const fireTap = input.consumeFireTap() && weaponHandling;
    const fireHeld = !!input.wantFireHeld && weaponHandling;
    if (fireTap && fireAllowed) this.fireTapLatched = true;
    if (!fireAllowed || !weaponHandling) this.fireTapLatched = false;
    this.pendingShotIntent = {
      tap: fireAllowed && fireTap,
      held: fireAllowed && fireHeld,
    };
    weaponIntents.shot = this.pendingShotIntent;
    weaponIntents.fireTap = fireTap;
    weaponIntents.fireHeld = fireHeld;
    this.physics.wantProne = !!this.keys.prone;
    this.physics._crouching = !!this.keys.crouch;
    return weaponIntents;
  }

  _stepPrediction(dt) {
    const climbAxis = this.keys.forward && !this.keys.back
      ? 1
      : (this.keys.back && !this.keys.forward ? -1 : 0);
    const jumped = this._alive
      ? this.physics.step(
        dt,
        this.wishDir,
        moveSpeedFor(this.keys, this.wantAds),
        this.keys.jump,
        climbAxis,
        this.view.yaw,
      )
      : false;
    this.currentSpeedXZ = Math.hypot(this.physics.vel.x, this.physics.vel.z);
    return jumped;
  }

  _updateWishDirection() {
    const keys = this.keys;
    const forward = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
    const right = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    const sin = Math.sin(this.view.yaw);
    const cos = Math.cos(this.view.yaw);
    const wx = forward * -sin + right * cos;
    const wz = forward * -cos + right * -sin;
    const length = Math.hypot(wx, wz);
    this.wishDir = length > 0
      ? { x: wx / length, z: wz / length }
      : { x: 0, z: 0 };
  }

  _lockMovement() {
    this.keys = {
      ...this.keys,
      forward: false,
      back: false,
      left: false,
      right: false,
      jump: false,
      sprint: false,
      crouch: false,
      prone: false,
      interact: false,
    };
    this.wishDir.x = 0;
    this.wishDir.z = 0;
    this.physics.vel.x = 0;
    this.physics.vel.y = 0;
    this.physics.vel.z = 0;
    this.physics.coyote = 0;
    this.physics.vault = null;
    this.physics.jumpGroundY = null;
    this.physics._crouching = false;
    this._cameraCrouch = 0;
    this.physics.proneT = 0;
    this.physics.wantProne = false;
  }

  _updateConditionEstimates(dt, jumped) {
    if (!this._alive) return;
    if (jumped) {
      this.exhaustion = clamp01(this.exhaustion + CONDITION_RULES.exhaustionJumpGain);
    }
    this.burning = Math.max(0, this.burning - dt);
    const sprinting = !!(
      this.keys.sprint && this.keys.forward && !this.keys.back &&
      !this.keys.crouch && !this.keys.prone && !this.physics.proneT && !this.wantAds
    );
    recoverConditions(this, dt, {
      hp: Number.isFinite(this._hp) ? this._hp : 100, burning: this.burning,
      sprinting, holdingBreath: !!this._aim?.holdingBreath,
      crouching: !!this.physics._crouching || this.physics.proneT > 0,
    });
  }

  _sendInputMaybe(dt, intents) {
    const interval = 1 / this.sendHz;
    this.sendAccum += dt;
    if (this.sendAccum < interval) return false;
    this.sendAccum %= interval;

    const fireAllowed = isAllowed(intents.fireAllowed);
    const interactAllowed = isAllowed(intents.interactAllowed);
    const discrete = ['semi', 'bolt', 'pump'].includes(intents.weapon?.def?.mode);
    const predictedDiscrete = discrete && this._discretePrediction;
    const wantFire = predictedDiscrete
      ? fireAllowed && this._acceptedFireSlot === intents.weapon?.slot
      : !!(
      fireAllowed && this.pendingShotIntent &&
      (this.pendingShotIntent.held || this.fireTapLatched)
    );
    const weapon = intents.weapon || null;
    const networkState = typeof intents.getNetworkWeaponState === 'function'
      ? intents.getNetworkWeaponState()
      : null;
    const weaponSlot = Number.isInteger(networkState?.slot)
      ? networkState.slot
      : (Number.isInteger(weapon?.slot) ? weapon.slot : 0);
    const reloading = typeof networkState?.reloading === 'boolean'
      ? networkState.reloading
      : !!(weapon?.isReloading ?? weapon?.reloadState);
    const keys = this.keys || {};
    const payload = {
      keys: {
        forward: !!keys.forward,
        back: !!keys.back,
        left: !!keys.left,
        right: !!keys.right,
        jump: !!keys.jump,
        sprint: !!keys.sprint,
        crouch: !!keys.crouch,
        prone: !!keys.prone,
        interact: !!(interactAllowed && keys.interact),
      },
      yaw: this._pendingShotAim?.yaw ?? this.shotYaw,
      pitch: this._pendingShotAim?.pitch ?? this.shotPitch,
      viewYaw: this.view.yaw,
      wantFire,
      weapon: weaponSlot,
      wantAds: this._gameplayInputEnabled && this.wantAds,
      reload: this._gameplayInputEnabled && reloading,
      reloadId: networkState?.reloadId || 0,
      throwGrenade: !!(this._gameplayInputEnabled && this.grenadeThrowLatched),
      grenadeHandling: this._gameplayInputEnabled && this.grenadeHandling,
      grenadeCharge: this._gameplayInputEnabled ? (this.grenadeThrowLatched?.charge ?? 0) : 0,
      grenadeType: this._gameplayInputEnabled ? (this.grenadeThrowLatched?.type ?? 0) : 0,
      grenadeCook: this._gameplayInputEnabled ? (this.grenadeThrowLatched?.cookMs ?? 0) : 0,
    };
    if (payload.throwGrenade) payload.grenadeAim = this.grenadeThrowLatched.grenadeAim;
    const sent = typeof intents.sendInput === 'function'
      ? !!intents.sendInput(payload)
      : false;
    if (sent) this._pendingShotAim = null;
    if (sent && wantFire) {
      this.fireTapLatched = false;
      this._acceptedFireSlot = null;
    }
    if (sent && payload.throwGrenade) this.grenadeThrowLatched = null;
    this._frame.inputPayload = payload;
    return sent;
  }

  /**
   * Runs the frozen player-frame order. `onWeaponIntents` executes after all
   * input edges are consumed but before prediction; `beforeSend` is the seam
   * for reload/fire work that must precede the 60 Hz network send. Return a
   * boolean shot result there to send only accepted discrete shots.
   */
  update(dt, now = nowMs(), intents = {}) {
    if (this._disposed) return this._frame;
    this._frame.inputSent = false;
    this._frame.inputPayload = null;
    this._readLook();
    const weaponIntents = this._sampleMovement(now, intents);
    const movementAllowed = intents.movementAllowed == null
      ? true
      : isAllowed(intents.movementAllowed);
    if (!movementAllowed) this._lockMovement();
    if (!weaponIntents.blockedByBuyMenu) this._updateWishDirection();
    if (!weaponIntents.blockedByBuyMenu && typeof intents.onWeaponIntents === 'function') {
      intents.onWeaponIntents(weaponIntents, now);
    }
    const jumped = this._stepPrediction(dt);
    this._frame.jumped = jumped;
    this._aim = this.aimSway.update(dt, {
      alive: this._alive,
      grounded: this.physics.grounded,
      stationary: this.currentSpeedXZ < 0.18 && !this.keys.forward && !this.keys.back &&
        !this.keys.left && !this.keys.right && !this.keys.jump,
      shift: !!this.keys.sprint,
      crouching: !!this.physics._crouching,
      panic: this.panic,
      pain: this.pain,
      ads: intents.weapon?.adsT ?? this.adsT,
      handlingAllowed: this._gameplayInputEnabled && !this.grenadeHandling &&
        !this.physics.vault && !intents.weapon?.isReloading && !intents.weapon?.reloadRequested &&
        !intents.weapon?.isDeploying && this.wantAds,
      zoom: this._scopeZoom > 0 ? this._scopeZoom : (Number(intents.weapon?.def?.zoom) || 1),
    });
    this._updateConditionEstimates(dt, jumped);
    const aimWeapon = intents.weapon?.def;
    this._weaponAim.update(dt, {
      weapon: aimWeapon?.id,
      yaw: this.aimYaw + this.recoilYaw,
      pitch: this.aimPitch + this.recoilPitch,
      weightKg: aimWeapon?.weightKg,
      ads: intents.weapon?.adsT ?? this.adsT,
      sprinting: !this.wantAds && this.keys.sprint && this.currentSpeedXZ > 4.6,
      grounded: this.physics.grounded,
      crouching: this.crouchBool || !!this.physics.proneT,
      vaulting: !!this.physics.vault,
      enabled: !!aimWeapon && this._alive && this._gameplayInputEnabled,
    });
    // Capture release after carry aim settles for this frame and before a shot
    // adds recoil. Prediction and a later network send retain this same ray.
    if (this.grenadeThrowLatched && !this.grenadeThrowLatched.grenadeAim) {
      this.grenadeThrowLatched.grenadeAim = { yaw: this.shotYaw, pitch: this.shotPitch };
      this._localGrenadeThrow = { ...this.grenadeThrowLatched };
    }
    const fired = typeof intents.beforeSend === 'function'
      ? intents.beforeSend(this._frame, now) : undefined;
    // A rejected local click must not become a silent server-only shot when
    // the render clock, bolt cycle, or reload readiness differs from authority.
    this._discretePrediction = typeof fired === 'boolean';
    if (!this._alive || !isAllowed(intents.fireAllowed) || this.grenadeHandling ||
        this._acceptedFireSlot !== intents.weapon?.slot) this._acceptedFireSlot = null;
    if (fired === true && ['semi', 'bolt', 'pump'].includes(intents.weapon?.def?.mode)) {
      this._acceptedFireSlot = intents.weapon.slot;
    }
    this._frame.inputSent = this._sendInputMaybe(dt, intents);
    this._stepRecoilRecovery(dt, now);
    stepRecoilSpring(this._recoilSpring.pitch, this._recoilOmega, dt);
    stepRecoilSpring(this._recoilSpring.yaw, this._recoilOmega, dt);
    this.recoilPitch = this._recoilSpring.pitch.p;
    this.recoilYaw = this._recoilSpring.yaw.p;
    this.recoilRoll = this.recoilYaw * RECOIL_ROLL_PER_YAW;
    return this._frame;
  }

  /**
   * Applies the player-owned portion of one authoritative self row. Weapon
   * reconciliation stays with WeaponState and the composition root.
   */
  reconcile(me, snapSeq, {
    deathEvent = null,
    impact = null,
    id = null,
  } = {}) {
    if (!me) return EMPTY_RECONCILE;
    if (Number.isFinite(snapSeq)) {
      if (this._lastReconciledSnapSeq !== null && snapSeq <= this._lastReconciledSnapSeq) {
        return EMPTY_RECONCILE;
      }
      this._lastReconciledSnapSeq = snapSeq;
    }

    const hp = Number.isFinite(me.hp) ? me.hp : this._hp;
    this.burning = Math.max(0, Number(me.burning) || 0);
    if (this.aimSway.breath && Number.isFinite(me.breathReserve)) {
      this.aimSway.breath.reserve = clamp01(me.breathReserve);
      this.aimSway.breath.exhausted = !!me.breathExhausted;
      this.aimSway.breath.releasedFor = Math.max(0, Number(me.breathReleasedFor) || 0);
    }
    if (Number.isFinite(me.panic)) this.panic = clamp01(me.panic);
    if (Number.isFinite(me.exhaustion)) this.exhaustion = clamp01(me.exhaustion);
    if (Number.isFinite(me.pain)) this.pain = clamp01(me.pain);
    this.spawnProtected = !!me.spawnProtected;

    this._reconcileResult.transition = null;
    const authoritativeAlive = me.state === 'alive' && hp > 0;
    if (authoritativeAlive && !this._alive) {
      this._reconcileResult.transition = this.respawn(me, {
        spawnProtected: !!me.spawnProtected,
      });
      if (Number.isFinite(me.pain)) this.pain = clamp01(me.pain);
      this.spawnProtected = !!me.spawnProtected;
    } else if (!authoritativeAlive && this._alive) {
      this._reconcileResult.transition = this.die(deathEvent?.killer || null, {
        impact,
        damageEvent: deathEvent,
        headshot: !!(deathEvent?.hs || impact?.hs),
        id,
      });
    }
    this._hp = hp;
    if (authoritativeAlive && me.impulse) this.physics.adoptImpulse(me.impulse);

    if ([me.x, me.y, me.z].every(Number.isFinite)) {
      const pos = this.physics.pos;
      const dx = me.x - pos.x;
      const dy = me.y - pos.y;
      const dz = me.z - pos.z;
      const error = Math.hypot(dx, dy, dz);
      let cx = 0, cy = 0, cz = 0;
      let decay = RECONCILE_OFFSET_DECAY;
      if (error > RECONCILE_SNAP_DISTANCE) {
        cx = dx; cy = dy; cz = dz;
        decay = RECONCILE_SNAP_DECAY;
      } else if (error > RECONCILE_DEAD_ZONE) {
        cx = dx * RECONCILE_CORRECTION;
        cy = dy * RECONCILE_CORRECTION;
        cz = dz * RECONCILE_CORRECTION;
      }
      if (cx !== 0 || cy !== 0 || cz !== 0) {
        pos.x += cx;
        pos.y += cy;
        pos.z += cz;
        if (this._alive) {
          // The camera stays put and eases into the corrected body over the next frames.
          const offset = this._reconcileOffset;
          offset.x -= cx;
          offset.y -= cy;
          offset.z -= cz;
          const magnitude = Math.hypot(offset.x, offset.y, offset.z);
          if (magnitude > RECONCILE_OFFSET_CLAMP) {
            const scale = RECONCILE_OFFSET_CLAMP / magnitude;
            offset.x *= scale;
            offset.y *= scale;
            offset.z *= scale;
          }
          offset.decay = Math.min(offset.decay, decay);
        }
      }
    }
    return this._reconcileResult;
  }

  _stepReconcileOffset(dt) {
    const offset = this._reconcileOffset;
    if (offset.x === 0 && offset.y === 0 && offset.z === 0) return;
    const keep = Math.exp(-Math.max(0, dt) * offset.decay);
    offset.x *= keep;
    offset.y *= keep;
    offset.z *= keep;
    if (Math.hypot(offset.x, offset.y, offset.z) < 0.002) this._resetReconcileOffset();
  }

  /** Update camera, scope visibility and the first-person body in that order. */
  updateCamera(dt, camera, weaponDef, adsT = this.adsT, baseFov = this.baseFov, scopeActive = null) {
    if (!camera || !weaponDef) return this.scopeActive;
    this.adsT = Number.isFinite(adsT) ? adsT : 0;
    this._stepReconcileOffset(dt);
    const pos = this.physics.pos;
    const offset = this._reconcileOffset;
    const crouchTarget = this.physics._crouching ? 1 : 0;
    this._cameraCrouch += (crouchTarget - this._cameraCrouch) *
      (1 - Math.exp(-CROUCH_CAMERA_FOLLOW * Math.max(0, dt)));
    // Smooth only the visual crouch offset so jumps, stairs and prone keep their timing.
    const crouchDrop = stanceEye(EYE_HEIGHT, false, this.physics.proneT) -
      stanceEye(EYE_HEIGHT, true, this.physics.proneT);
    const cameraEyeY = this.physics.eyeY() + (crouchTarget - this._cameraCrouch) * crouchDrop;
    camera.position.set(pos.x + offset.x, cameraEyeY + offset.y, pos.z + offset.z);
    if (this._alive) {
      this.deathElapsed = 0;
      this.deathRoll = 0;
      this.deathPitch = 0;
    } else {
      this.deathElapsed = Math.min(1.4, this.deathElapsed + dt);
      const impactT = smooth01(this.deathElapsed / 0.18);
      const collapseT = smooth01(this.deathElapsed / 0.86);
      const settleT = smooth01(this.deathElapsed / 1.22);
      camera.position.y -= 1.48 * collapseT + 0.12 * impactT;
      this.deathPitch = -0.18 * impactT - 0.66 * collapseT + 0.08 * settleT;
      this.deathRoll = this.deathSide * (0.26 * impactT + 1.12 * collapseT);
    }

    this.scopeActive = scopeActive ?? isScopeActive({ weapon: weaponDef.id, ads: this.adsT,
      alive: this._alive, vaulting: !!this.physics.vault, grenadeHandling: this.grenadeHandling });
    camera.rotation.order = 'YXZ';
    camera.rotation.set(
      (this.scopeActive ? this.shotPitch : this.aimPitch + this.recoilPitch) + this.deathPitch,
      this.scopeActive ? this.shotYaw : this.aimYaw + this.recoilYaw,
      this.deathRoll + this.recoilRoll,
    );
    this._lookScale = adsLookScale(camera.fov, baseFov);
    if (weaponDef.id === 'sniper') {
      if (!(this._scopeZoom > 0)) this._scopeZoom = Number(weaponDef.zoom) || 1;
    } else this._scopeZoom = 0;
    const adsFov = this._scopeZoom > 0 ? fovForZoom(this._scopeZoom, baseFov) : weaponDef.adsFov;
    const targetFov = baseFov + (adsFov - baseFov) * easeOut(this.adsT) +
      (!this.wantAds && this.keys && this.keys.sprint && this.currentSpeedXZ > 5 ? 4 : 0);
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 14);
    camera.updateProjectionMatrix();

    updateFirstPersonBody(
      this.body,
      dt,
      this.physics.pos,
      this.view.yaw,
      this.currentSpeedXZ,
      !!this.physics._crouching,
      this._alive,
      this.deathElapsed,
      this.deathSide,
      this.scopeActive,
      this.physics.proneT,
      { grounded: this.physics.grounded, verticalVelocity: this.physics.vel.y,
        vaulting: !!this.physics.vault,
        forwardSpeed: -(this.physics.vel.x * Math.sin(this.view.yaw) + this.physics.vel.z * Math.cos(this.view.yaw)),
        lateralSpeed: this.physics.vel.x * Math.cos(this.view.yaw) - this.physics.vel.z * Math.sin(this.view.yaw) },
    );
    return this.scopeActive;
  }

  dispose() {
    if (this._disposed) return;
    this.setGameplayInputEnabled(false);
    this._disposed = true;
    this.body = null;
  }
}
