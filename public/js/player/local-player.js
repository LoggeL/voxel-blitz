import { CONDITION_RULES, SNIPER_SCOPE_ADS_THRESHOLD } from '../../../shared/combatmath.js';
import { PlayerPhysics, moveSpeedFor } from '../player-physics.js';
import { hashInt } from '../util/hash.js';
import { clamp01, clampPitch, easeOut, nowMs, smooth01 } from '../util/math.js';
import { AimSway } from './aim-sway.js';
import { resetFirstPersonBody, updateFirstPersonBody } from './first-person-body.js';

const DEFAULT_SEND_HZ = 60;
const DEFAULT_FOV = 75;
const EMPTY_RECONCILE = Object.freeze({ applied: false, transition: null });

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

    this.view = { yaw: 0, pitch: 0 };
    this.keys = {};
    this.wishDir = { x: 0, z: 0 };
    this._alive = true;
    this._hp = 100;
    this.panic = 0;
    this.exhaustion = 0;
    this.pain = 0;
    this.spawnProtected = false;
    this.currentSpeedXZ = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.adsT = 0;
    this.wantAds = false;
    this.scopeActive = false;
    this.deathElapsed = 0;
    this.deathRoll = 0;
    this.deathPitch = 0;
    this.deathSide = 1;
    this.lookVelX = 0;
    this.lookVelY = 0;
    this.sendAccum = 0;
    this.pendingShotIntent = null;
    this.fireTapLatched = false;
    this.grenadeThrowLatched = false;
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
      throwGrenade: false,
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
  get myHp() { return this._hp; }
  get conditions() { return this._conditions; }
  get pos() { return this.physics.pos; }
  get eyeY() { return this.physics.eyeY(); }
  get speedXZ() { return this.currentSpeedXZ; }
  get crouchBool() { return !!this.physics._crouching; }
  get gameplayInputEnabled() { return this._gameplayInputEnabled; }
  get lastLocalImpact() { return this._lastLocalImpact; }
  get lastReconciledSnapSeq() { return this._lastReconciledSnapSeq; }
  get aimYaw() { return this.view.yaw + (this._aim?.yaw || 0); }
  get aimPitch() { return clampPitch(this.view.pitch + (this._aim?.pitch || 0)); }
  get aimMotion() { return this._aim; }

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
    this.pendingShotIntent = null;
    this.fireTapLatched = false;
    this.grenadeThrowLatched = false;
    this.wantAds = false;
    this.physics._crouching = false;
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
    this.physics._crouching = false;
    return true;
  }

  /** Reset all player-owned state when returning to the menu. */
  resetForMenu({ physics = new PlayerPhysics(), body = null, baseFov = this.baseFov } = {}) {
    if (!physics || typeof physics.step !== 'function' || typeof physics.eyeY !== 'function') {
      throw new TypeError('resetForMenu requires a PlayerPhysics-compatible adapter');
    }
    this.physics = physics;
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
    this.exhaustion = 0;
    this.pain = 0;
    this.spawnProtected = false;
    this.currentSpeedXZ = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.adsT = 0;
    this.wantAds = false;
    this.scopeActive = false;
    this.deathElapsed = 0;
    this.deathRoll = 0;
    this.deathPitch = 0;
    this.deathSide = 1;
    this.lookVelX = 0;
    this.lookVelY = 0;
    this.sendAccum = 0;
    this.pendingShotIntent = null;
    this.fireTapLatched = false;
    this.grenadeThrowLatched = false;
    this._lastLocalImpact = null;
    this._lastReconciledSnapSeq = null;
    this._reconcileResult.transition = null;
    this._aim = this.aimSway.reset();
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
    this.exhaustion = 0;
    this.pain = Number.isFinite(ev.pain) ? clamp01(ev.pain) : 0;
    this.spawnProtected = typeof spawnProtected === 'boolean' ? spawnProtected : true;
    this._lastLocalImpact = null;
    this.deathElapsed = 0;
    this.deathRoll = 0;
    this.deathPitch = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.currentSpeedXZ = 0;
    this.scopeActive = false;
    this.fireTapLatched = false;
    this.pendingShotIntent = null;
    this.grenadeThrowLatched = false;
    this.wantAds = false;
    this.adsT = 0;
    this._aim = this.aimSway.reset();
    resetFirstPersonBody(this.body);
    return { kind: 'respawn', row: ev };
  }

  /** State-only half of local death; presentation belongs to combat feedback. */
  die(killerId, {
    impact = null,
    headshot = false,
    id = null,
  } = {}) {
    if (!this._alive) return null;
    const resolvedImpact = impact || this._lastLocalImpact;
    const resolvedHeadshot = !!(headshot || resolvedImpact?.hs);
    this._alive = false;
    this._hp = 0;
    this.adsT = 0;
    this.scopeActive = false;
    this.spawnProtected = false;
    this.currentSpeedXZ = 0;
    this.deathElapsed = 0;
    this.deathSide = (hashInt(String(id) + '|' + String(killerId || 'world')) & 1) ? 1 : -1;
    this.recoilPitch += resolvedHeadshot ? 0.2 : 0.11;
    this.recoilYaw += this.deathSide * (resolvedHeadshot ? 0.14 : 0.08);
    const goreImpact = isValidImpact(resolvedImpact)
      ? resolvedImpact
      : {
        vx: this.physics.pos.x,
        vy: this.physics.pos.y + 1.05,
        vz: this.physics.pos.z,
        hs: resolvedHeadshot,
      };
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
    const damage = Math.max(0, Number(ev.dmg) || 0);
    const severity = clamp01(damage / 55);
    const painLevel = Math.max(this.pain, severity);
    const headshot = !!ev.hs;
    const trauma = (0.45 + severity * 0.85 + painLevel * 0.65) * (headshot ? 1.45 : 1);
    const side = (hashInt(`${ev.attacker}|${ev.vx}|${ev.vz}`) & 1) ? 1 : -1;
    this.view.yaw += side * trauma * 0.045;
    this.view.pitch += trauma * 0.052;
    this.view.pitch = clampPitch(this.view.pitch);
    return {
      damage,
      severity,
      painLevel,
      headshot,
      trauma,
      side,
      painImpulse: clamp01(0.18 + severity * 0.72 + painLevel * 0.35),
      impact: ev,
    };
  }

  addExhaustion(amount) {
    if (Number.isFinite(amount)) this.exhaustion = clamp01(this.exhaustion + amount);
  }

  addRecoil(pitch = 0, yaw = 0) {
    if (Number.isFinite(pitch)) this.recoilPitch += pitch;
    if (Number.isFinite(yaw)) this.recoilYaw += yaw;
  }

  _readLook() {
    const delta = this.input.consumeDelta();
    this.lookVelX = delta.dx;
    this.lookVelY = delta.dy;
    if (!this._alive) return;
    this.view.yaw -= delta.dx;
    this.view.pitch -= delta.dy;
    this.view.pitch = clampPitch(this.view.pitch);
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
    weaponIntents.throwGrenade = false;

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

    this.wantAds = !!input.wantAdsHeld;
    weaponIntents.wantAds = this.wantAds;
    weaponIntents.switchDelta = input.consumeWeaponSwitch();
    weaponIntents.slot = input.consumeWeaponSlot();
    weaponIntents.lastWeapon = input.consumeLastWeaponRequest();
    weaponIntents.reload = !!(this.keys.reload && this._alive);

    const fireAllowed = isAllowed(intents.fireAllowed);
    const grenadeTap = input.consumeGrenadeThrow();
    if (grenadeTap && fireAllowed && this._alive) this.grenadeThrowLatched = true;
    if (!fireAllowed || !this._alive) this.grenadeThrowLatched = false;
    weaponIntents.throwGrenade = this.grenadeThrowLatched;
    const fireTap = input.consumeFireTap();
    const fireHeld = !!input.wantFireHeld;
    if (fireTap && fireAllowed) this.fireTapLatched = true;
    if (!fireAllowed) this.fireTapLatched = false;
    this.pendingShotIntent = {
      tap: fireAllowed && fireTap,
      held: fireAllowed && fireHeld,
    };
    weaponIntents.shot = this.pendingShotIntent;
    weaponIntents.fireTap = fireTap;
    weaponIntents.fireHeld = fireHeld;
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
      )
      : false;
    this.currentSpeedXZ = Math.hypot(this.physics.vel.x, this.physics.vel.z);
    this._updateConditionEstimates(dt, jumped);
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
      interact: false,
    };
    this.wishDir.x = 0;
    this.wishDir.z = 0;
    this.physics.vel.x = 0;
    this.physics.vel.y = 0;
    this.physics.vel.z = 0;
    this.physics.coyote = 0;
    this.physics._crouching = false;
  }

  _updateConditionEstimates(dt, jumped) {
    if (!this._alive) return;
    if (jumped) {
      this.exhaustion = clamp01(this.exhaustion + CONDITION_RULES.exhaustionJumpGain);
    }
    const hp01 = clamp01((Number.isFinite(this._hp) ? this._hp : 100) / 100);
    const missingHealth = 1 - hp01;
    const panicFloor = missingHealth * CONDITION_RULES.panicLowHpFloor;
    this.panic = clamp01(Math.max(
      panicFloor,
      this.panic - CONDITION_RULES.panicDecayPerS * dt,
    ));
    const painFloor = missingHealth * CONDITION_RULES.painLowHpFloor;
    this.pain = clamp01(Math.max(
      painFloor,
      this.pain - CONDITION_RULES.painDecayPerS * dt,
    ));
    const sprinting = !!(
      this.keys.sprint && this.keys.forward && !this.keys.back &&
      !this.keys.crouch && !this.wantAds
    );
    const exhaustionRate = sprinting
      ? CONDITION_RULES.exhaustionSprintPerS
      : -CONDITION_RULES.exhaustionRecoverPerS;
    this.exhaustion = clamp01(this.exhaustion + exhaustionRate * dt);
  }

  _sendInputMaybe(dt, intents) {
    const interval = 1 / this.sendHz;
    this.sendAccum += dt;
    if (this.sendAccum < interval) return false;
    this.sendAccum %= interval;

    const fireAllowed = isAllowed(intents.fireAllowed);
    const interactAllowed = isAllowed(intents.interactAllowed);
    const wantFire = !!(
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
        interact: !!(interactAllowed && keys.interact),
      },
      yaw: this.aimYaw,
      pitch: this.aimPitch,
      wantFire,
      weapon: weaponSlot,
      wantAds: this._gameplayInputEnabled && this.wantAds,
      reload: this._gameplayInputEnabled && reloading,
      throwGrenade: this._gameplayInputEnabled && this.grenadeThrowLatched,
    };
    const sent = typeof intents.sendInput === 'function'
      ? !!intents.sendInput(payload)
      : false;
    if (sent && wantFire) this.fireTapLatched = false;
    if (sent && payload.throwGrenade) this.grenadeThrowLatched = false;
    this._frame.inputPayload = payload;
    return sent;
  }

  /**
   * Runs the frozen player-frame order. `onWeaponIntents` executes after all
   * input edges are consumed but before prediction; `beforeSend` is the seam
   * for reload/fire work that must precede the 60 Hz network send.
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
      stationary: this.currentSpeedXZ < 0.18,
      shift: !!this.keys.sprint,
      crouching: !!this.physics._crouching,
      panic: this.panic,
      pain: this.pain,
    });
    if (typeof intents.beforeSend === 'function') intents.beforeSend(this._frame, now);
    this._frame.inputSent = this._sendInputMaybe(dt, intents);
    this.recoilPitch *= Math.max(0, 1 - 11 * dt);
    this.recoilYaw *= Math.max(0, 1 - 9 * dt);
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
        headshot: !!(deathEvent?.hs || impact?.hs),
        id,
      });
    }
    this._hp = hp;


    if ([me.x, me.y, me.z].every(Number.isFinite)) {
      const pos = this.physics.pos;
      const dx = me.x - pos.x;
      const dy = me.y - pos.y;
      const dz = me.z - pos.z;
      const error = Math.hypot(dx, dy, dz);
      if (error > 3.2) {
        pos.x = me.x;
        pos.y = me.y;
        pos.z = me.z;
      } else if (error > 0.12) {
        const correction = 0.18;
        pos.x += dx * correction;
        pos.y += dy * correction;
        pos.z += dz * correction;
      }
    }
    return this._reconcileResult;
  }

  /** Update camera, scope visibility and the first-person body in that order. */
  updateCamera(dt, camera, weaponDef, adsT = this.adsT, baseFov = this.baseFov) {
    if (!camera || !weaponDef) return this.scopeActive;
    this.adsT = Number.isFinite(adsT) ? adsT : 0;
    const pos = this.physics.pos;
    camera.position.set(pos.x, this.physics.eyeY(), pos.z);
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

    camera.rotation.order = 'YXZ';
    camera.rotation.set(
      this.aimPitch + this.recoilPitch + this.deathPitch,
      this.aimYaw + this.recoilYaw,
      this.deathRoll,
    );
    const targetFov = baseFov + (weaponDef.adsFov - baseFov) * easeOut(this.adsT) +
      (!this.wantAds && this.keys && this.keys.sprint && this.currentSpeedXZ > 5 ? 4 : 0);
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 14);
    camera.updateProjectionMatrix();

    this.scopeActive = this._alive && weaponDef.id === 'sniper' &&
      this.adsT >= SNIPER_SCOPE_ADS_THRESHOLD;
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
