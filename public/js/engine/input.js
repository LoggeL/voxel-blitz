// Voxel Blitz — pointer-lock first-person input manager (client-side).
//
// Owns raw device reading ONLY: key state edges, accumulated look deltas,
// pointer-lock lifecycle, fire/ADS intents and weapon-switch intents, across
// mouse/keyboard, trackpad, gamepad, and touch. Player physics owns movement
// integration; LocalPlayer owns look integration. This module only accumulates
// sensitivity-scaled pointer deltas using the canonical convention shared by the
// camera and authority:
//   yaw   -= dx  (mouse right => turn right)
//   pitch -= dy  (mouse down  => look down)
//   fwd = (-sin(yaw)*cos(pitch), sin(pitch), -cos(yaw)*cos(pitch))

import {
  ADS_MODES,
  INPUT_PREF_KEYS,
  MOUSE_SENSITIVITY,
  POINTER_MODES,
  SENSITIVITY_PREF_KEY,
  TOUCH_HANDS,
  TOUCH_SIZES,
  TRACKPAD_LOOK_SCALE,
  TRACKPAD_SMOOTHING,
  WHEEL_SWITCH,
  clampMouseSensitivity,
  clampPadSensitivity,
  clampTouchSensitivity,
  normalizeChoice,
  wheelSwitchStep,
} from '../input-settings.js';
import {
  GRENADE_CHARGE_MS,
  GRENADE_TYPE_IDS,
  clampGrenadeCharge,
  clampGrenadeType,
} from '../../../shared/grenade-rules.js';
import { TouchControls, shouldEnableTouchControls } from './touch-controls.js';
import { GamepadInput } from './gamepad.js';

// Touch drags travel far fewer pixels than a mouse, so thumb-look runs hotter than
// the mouse scale (default 0.003 rad/px × 1.4 ≈ 0.0042 rad/px, about 72° per 300 px).
export const TOUCH_LOOK_SENSITIVITY_SCALE = 1.4;
const TOUCH_MOVE_THRESHOLD = 0.2;
const TOUCH_SPRINT_THRESHOLD = 0.86;
/** Aim assist never removes more than this much of pad/touch look speed near a target. */
export const AIM_ASSIST_MAX_SLOWDOWN = 0.5;
/** Quick pad crouch press latches; a longer hold releases with the button. */
const PAD_TOGGLE_TAP_MS = 260;
/** Q / middle-mouse hold that opens the weapon wheel; a shorter Q press stays "previous weapon". */
export const WHEEL_HOLD_MS = 180;
/** Pad Y hold that opens the weapon wheel; a quick Y tap keeps swapping/cycling. */
export const PAD_WHEEL_HOLD_MS = 260;
/** Wheel selection vector length: 1 == this many raw mouse px of accumulated motion. */
export const WHEEL_VECTOR_RADIUS_PX = 90;

function eventTime(event) {
  if (Number.isFinite(event?.timeStamp)) return event.timeStamp;
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function readPref(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}

function writePref(key, value) {
  try {
    if (value == null || value === '') localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch (_) {}
}

const MOVEMENT_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'crouch', 'interact'];

export class Input {
  /**
   * @param {HTMLCanvasElement} canvas element pointer lock attaches to
   */
  constructor(canvas) {
    this.canvas = canvas;
    // ?headless=1 lets browser-driven checks bypass pointer lock, but never
    // bypasses explicit gameplay suppression (settings, death, teardown).
    const search = typeof location === 'undefined' ? '' : location.search;
    this.fallback = new URLSearchParams(search).has('headless');
    this.sens = MOUSE_SENSITIVITY.default; // rad per pixel of movementX/Y
    this.invertY = false;
    // Sensitivity override (client-side preference). Guarded so the module
    // stays importable in Node (no localStorage).
    const storedSens = parseFloat(readPref(SENSITIVITY_PREF_KEY));
    if (Number.isFinite(storedSens) && storedSens > 0) this.sens = clampMouseSensitivity(storedSens);

    // Device options (all persisted, all optional).
    this._options = {
      adsMode: normalizeChoice(readPref(INPUT_PREF_KEYS.adsMode), ADS_MODES, ''),
      pointerMode: normalizeChoice(readPref(INPUT_PREF_KEYS.pointerMode), POINTER_MODES, 'auto'),
      padSensitivity: clampPadSensitivity(readPref(INPUT_PREF_KEYS.padSensitivity)),
      touchSensitivity: clampTouchSensitivity(readPref(INPUT_PREF_KEYS.touchSensitivity)),
      touchSize: normalizeChoice(readPref(INPUT_PREF_KEYS.touchSize), TOUCH_SIZES, 'medium'),
      touchHand: normalizeChoice(readPref(INPUT_PREF_KEYS.touchHand), TOUCH_HANDS, 'right'),
      aimAssist: readPref(INPUT_PREF_KEYS.aimAssist) !== '0',
    };

    // Internal edge/accumulator state.
    this._bound = false;
    this._locked = false;
    this._gameplayEnabled = true;
    this._disposed = false;
    this._touchMode = shouldEnableTouchControls();
    this._touchControls = null;
    this._pauseHandler = null;
    this._accDX = 0;          // pending scaled look delta (radians)
    this._accDY = 0;
    this._mouseFire = false;
    this._mouseAds = false;
    this._adsLatched = false; // toggle-mode ADS latch (mouse/keyboard)
    this._fireTapQueued = false;
    this._reloadQueued = false;
    this._grenadeThrowQueued = null; // {charge, cookMs, type} released this frame
    this._grenadeHeld = false;
    this._grenadeHoldStartedAt = 0;
    this._grenadeType = 0;     // selected throwable (index into GRENADE_TYPE_IDS)
    this._switchQueue = 0;     // wheel steps accumulated (+/-1)
    this._wheel = { acc: 0, lastAt: -Infinity };
    this._pendingSlot = null;  // direct Digit1..9/0 pick (0..9) or null
    this._lastWeaponReq = false;
    this._buyMenuQueued = false;
    this._buyMenuHeld = false; // physical B latch suppresses repeat/re-entry
    this._zoomStepQueue = 0;   // scope zoom steps (KeyZ, wheel while scoped, R3)
    this._scopeZoomMode = false;
    // Radial weapon wheel seam: while open, devices reroute (see setWeaponWheelOpen).
    this._wheelOpen = false;
    this._wheelVecX = 0;       // raw mouse px (pad look scaled) toward full ring deflection
    this._wheelVecY = 0;
    this._wheelStepQueue = 0;  // wheel-scroll / pad d-pad steps while open
    this._pendingWheelSlot = null; // direct Digit1..9/0 pick while open (0..9) or null
    this._wheelOpenQueued = false;
    this._wheelReleaseQueued = false;
    this._wheelCancelQueued = false;
    this._qHeld = false;       // Q tap/hold split: holding Q opens the wheel
    this._qDownAt = 0;
    this._qWheelFired = false;
    this._mmbHeld = false;     // physical middle-mouse latch while it opens the wheel
    this._padYHeld = false;    // pad Y tap/hold split: holding Y opens the wheel
    this._padYDownAt = 0;
    this._padYWheelFired = false;
    this._trackpadEvidence = 0;
    this._trackpadDetected = false;
    this._aimAssist = 0;       // 0..1 strength supplied by the composition root
    this.keys = {
      forward: false, back: false, left: false, right: false,
      jump: false, sprint: false, crouch: false, interact: false,
    };

    // Gamepad state lives beside the keyboard so both can be held at once.
    this._pad = new GamepadInput();
    this._padKeys = {
      forward: false, back: false, left: false, right: false,
      jump: false, sprint: false, crouch: false, interact: false,
    };
    this._padFire = false;
    this._padAds = false;
    this._padCrouchLatched = false;
    this._padCrouchUnlatch = false;
    this._padCrouchSince = 0;
    this._padSprintLatched = false;
    this._padScoreboard = false;
    this._lastPollAt = 0;

    // Pre-bound handlers so dispose() can remove them exactly.
    this._hKeyDown = (e) => this._onKeyDown(e);
    this._hKeyUp = (e) => this._onKeyUp(e);
    this._hMouseMove = (e) => this._onMouseMove(e);
    this._hMouseDown = (e) => this._onMouseDown(e);
    this._hMouseUp = (e) => this._onMouseUp(e);
    this._hWheel = (e) => this._onWheel(e);
    this._hContext = (e) => { e.preventDefault(); };
    this._hBlur = () => this.clearTransient();
    this._hVis = () => { if (document.hidden) this.clearTransient(); };
    this._hLockChange = () => {
      if (this._touchMode) {
        this._locked = false;
        return;
      }
      this._locked = document.pointerLockElement === this.canvas;
      if (!this._locked) this.clearTransient();
      if (this.onLockChange) this.onLockChange(this._locked);
    };
  }

  /* ----------------------------------------------------------- held intents */

  /** LMB / RT / touch fire held; reads false while the weapon wheel is open. Assignable for debug and legacy callers. */
  get wantFireHeld() { return !this._wheelOpen && (this._mouseFire || this._padFire); }
  set wantFireHeld(value) { this._mouseFire = !!value; }

  /** RMB / F / LT / touch ADS held or latched; reads false while the weapon wheel is open. */
  get wantAdsHeld() { return !this._wheelOpen && (this._mouseAds || this._adsLatched || this._padAds); }
  set wantAdsHeld(value) {
    this._mouseAds = !!value;
    if (!value) this._adsLatched = false;
  }

  /** Back/Select on a pad holds the scoreboard, like Tab. */
  get scoreboardHeld() { return this._padScoreboard; }

  /**
   * Contract convenience wrapper: bind listeners against (a possibly replaced)
   * canvas and register the lock-change callback. Equivalent to setting
   * .canvas then calling bind(cb).
   * @param {HTMLCanvasElement} canvasEl
   * @param {(locked:boolean)=>void} [cb]
   */
  start(canvasEl, cb) {
    if (canvasEl && canvasEl !== this.canvas) {
      const previousCanvas = this.canvas;
      if (
        this._bound &&
        document.pointerLockElement === previousCanvas &&
        document.exitPointerLock
      ) {
        document.exitPointerLock();
      }
      this.canvas = canvasEl;
      if (this._bound) {
        previousCanvas?.removeEventListener('mousedown', this._hMouseDown);
        previousCanvas?.removeEventListener('contextmenu', this._hContext);
        this.canvas.addEventListener('mousedown', this._hMouseDown);
        this.canvas.addEventListener('contextmenu', this._hContext);
        this._locked = document.pointerLockElement === this.canvas;
        this.clearTransient();
      }
    }
    this.bind(cb);
    return this;
  }

  /**
   * Attaches all DOM listeners. Safe to call once; extra calls are ignored.
   * @param {(locked:boolean)=>void} [cb] onLockChange passthrough
   */
  bind(cb) {
    if (this._disposed) return;
    if (this._bound) {
      if (cb) this.onLockChange = cb;
      return;
    }
    this._bound = true;
    this._locked = document.pointerLockElement === this.canvas;
    if (cb) this.onLockChange = cb;
    window.addEventListener('keydown', this._hKeyDown);
    window.addEventListener('keyup', this._hKeyUp);
    window.addEventListener('blur', this._hBlur);
    document.addEventListener('visibilitychange', this._hVis);
    document.addEventListener('mousemove', this._hMouseMove);
    document.addEventListener('mouseup', this._hMouseUp);
    document.addEventListener('pointerlockchange', this._hLockChange);
    document.addEventListener('wheel', this._hWheel, { passive: false });
    this.canvas.addEventListener('mousedown', this._hMouseDown);
    this.canvas.addEventListener('contextmenu', this._hContext);
    this._mountTouchControls();
  }

  /** True while the game canvas owns the pointer. */
  isLocked() { return this._locked; }

  /** Mobile/coarse-pointer mode never depends on pointer lock. */
  usesTouchControls() { return this._touchMode; }
  requiresPointerLock() { return !this._touchMode; }

  setPauseHandler(handler) {
    this._pauseHandler = typeof handler === 'function' ? handler : null;
  }

  requestLock() {
    if (this._disposed || !this._gameplayEnabled) return;
    if (this._touchMode) return;
    const canvas = this.canvas;
    if (!canvas || typeof canvas.requestPointerLock !== 'function') return;
    // Raw (unaccelerated) deltas where the browser offers them; older engines
    // reject the options bag, so fall back to the plain request.
    let request = null;
    try {
      request = canvas.requestPointerLock({ unadjustedMovement: true });
    } catch (_) {
      request = null;
    }
    if (request && typeof request.catch === 'function') {
      request.catch(() => {
        try {
          const plain = canvas.requestPointerLock();
          if (plain && typeof plain.catch === 'function') plain.catch(() => {});
        } catch (_) {}
      });
    } else if (!request) {
      try {
        const plain = canvas.requestPointerLock();
        if (plain && typeof plain.catch === 'function') plain.catch(() => {});
      } catch (_) {}
    }
  }

  /** Release pointer lock. */
  exit() {
    if (
      typeof document !== 'undefined' &&
      document.pointerLockElement === this.canvas &&
      document.exitPointerLock
    ) {
      document.exitPointerLock();
    }
  }

  /** Enables or suppresses every gameplay input path, including headless. */
  setGameplayEnabled(enabled) {
    const next = !!enabled && !this._disposed;
    if (next === this._gameplayEnabled) return;
    this._gameplayEnabled = next;
    this._touchControls?.setEnabled(next);
    if (!next) this.clearTransient();
  }

  /**
   * Sets mouse-look sensitivity (rad per pixel) and persists the choice under
   * SENSITIVITY_PREF_KEY. Clamped to the MOUSE_SENSITIVITY contract range.
   * @param {number} v
   */
  setSensitivity(v) {
    const s = Number(v);
    if (!Number.isFinite(s) || s <= 0) return;
    this.sens = clampMouseSensitivity(s);
    writePref(SENSITIVITY_PREF_KEY, this.sens);
  }

  /** Current sensitivity in rad per pixel. */
  getSensitivity() {
    return this.sens;
  }

  /* ---------------------------------------------------------- device options */

  /** Persisted device options (copy). */
  getOptions() {
    return { ...this._options };
  }

  /**
   * Apply and persist device options; unknown keys are ignored and invalid values
   * fall back to the current setting. Touch layout changes reach the mounted controls.
   */
  setOptions(next = {}) {
    if (!next || typeof next !== 'object') return this.getOptions();
    const o = this._options;
    if ('adsMode' in next) o.adsMode = normalizeChoice(next.adsMode, ADS_MODES, '');
    if ('pointerMode' in next) o.pointerMode = normalizeChoice(next.pointerMode, POINTER_MODES, o.pointerMode);
    if ('padSensitivity' in next) o.padSensitivity = clampPadSensitivity(next.padSensitivity, o.padSensitivity);
    if ('touchSensitivity' in next) {
      o.touchSensitivity = clampTouchSensitivity(next.touchSensitivity, o.touchSensitivity);
    }
    if ('touchSize' in next) o.touchSize = normalizeChoice(next.touchSize, TOUCH_SIZES, o.touchSize);
    if ('touchHand' in next) o.touchHand = normalizeChoice(next.touchHand, TOUCH_HANDS, o.touchHand);
    if ('aimAssist' in next) o.aimAssist = next.aimAssist !== false && next.aimAssist !== '0';
    writePref(INPUT_PREF_KEYS.adsMode, o.adsMode);
    writePref(INPUT_PREF_KEYS.pointerMode, o.pointerMode);
    writePref(INPUT_PREF_KEYS.padSensitivity, o.padSensitivity);
    writePref(INPUT_PREF_KEYS.touchSensitivity, o.touchSensitivity);
    writePref(INPUT_PREF_KEYS.touchSize, o.touchSize);
    writePref(INPUT_PREF_KEYS.touchHand, o.touchHand);
    writePref(INPUT_PREF_KEYS.aimAssist, o.aimAssist ? '1' : '0');
    if (this.adsMode() === 'hold') this._adsLatched = false;
    this._touchControls?.setOptions({ size: o.touchSize, hand: o.touchHand });
    return this.getOptions();
  }

  /** Effective ADS mode: the explicit preference, else toggle on trackpads, hold otherwise. */
  adsMode() {
    if (this._options.adsMode) return this._options.adsMode;
    return this.pointerKind() === 'trackpad' ? 'toggle' : 'hold';
  }

  /** 'mouse' | 'trackpad' after the preference and the wheel-stream heuristic. */
  pointerKind() {
    if (this._options.pointerMode === 'trackpad') return 'trackpad';
    if (this._options.pointerMode === 'mouse') return 'mouse';
    return this._trackpadDetected ? 'trackpad' : 'mouse';
  }

  /** Device facts for settings copy and the composition root. */
  deviceInfo(now = eventTime(null)) {
    return {
      touch: this._touchMode,
      pointerKind: this.pointerKind(),
      trackpadDetected: this._trackpadDetected,
      padActive: this._pad.isActive(now),
      adsMode: this.adsMode(),
    };
  }

  /** Aim assist only ever applies to pad and touch look, never to a mouse. */
  aimAssistEligible(now = eventTime(null)) {
    return this._options.aimAssist && (this._touchMode || this._pad.isActive(now));
  }

  /** 0..1 slowdown strength near a target, supplied per frame by the composition root. */
  setAimAssist(strength) {
    const value = Number(strength);
    this._aimAssist = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  }

  _assistScale() {
    return 1 - AIM_ASSIST_MAX_SLOWDOWN * this._aimAssist;
  }

  /** Wheel steps become zoom steps instead of weapon switches while scoped. */
  setScopeZoomMode(active) {
    this._scopeZoomMode = !!active;
  }

  /** Per-frame contextual visibility for the touch buttons; cheap when unchanged. */
  setTouchContext(context) {
    this._touchControls?.setContext(context);
  }

  /* ----------------------------------------------------------- weapon wheel */

  /**
   * Opens or closes the radial weapon wheel. While it is up, devices reroute:
   * mouse and pad look feed the wheel vector, scroll/d-pad steps and digits queue
   * wheel intents, and the held-intent getters read false. Opening force-clears
   * every held or queued combat intent (fire, ADS, reload, grenade hold, zoom,
   * switch, direct slot, last-weapon) so nothing stale lands when the wheel
   * closes; closing just zeroes the wheel accumulators.
   * @param {boolean} open
   */
  setWeaponWheelOpen(open) {
    if (open) {
      this._wheelOpen = true;
      this._wheelVecX = 0;
      this._wheelVecY = 0;
      this._wheelStepQueue = 0;
      this._pendingWheelSlot = null;
      this._accDX = 0;
      this._accDY = 0;
      this._mouseFire = false;
      this._fireTapQueued = false;
      this._padFire = false;
      this._mouseAds = false;
      this._adsLatched = false;
      this._reloadQueued = false;
      // Cancel a held grenade without throwing it.
      this._grenadeHeld = false;
      this._grenadeHoldStartedAt = 0;
      this._grenadeThrowQueued = null;
      this._zoomStepQueue = 0;
      this._switchQueue = 0;
      this._pendingSlot = null;
      this._lastWeaponReq = false;
      return;
    }
    this._wheelOpen = false;
    this._wheelVecX = 0;
    this._wheelVecY = 0;
    this._wheelStepQueue = 0;
    this._pendingWheelSlot = null;
    this._wheelOpenQueued = false;
    this._wheelReleaseQueued = false;
    this._wheelCancelQueued = false;
  }

  /** True while the radial weapon wheel routes device input. */
  isWeaponWheelOpen() {
    return this._wheelOpen;
  }

  /* ---------------------------------------------------------------- gamepad */

  /**
   * Poll the gamepad once per frame. `dt` scales stick look; button edges are folded
   * into the same queues the keyboard uses so LocalPlayer never sees a second device.
   */
  poll(now = eventTime(null), dt = 1 / 60) {
    if (this._disposed) return null;
    const frame = this._pad.poll(now);
    // Q hold opens the wheel; read before the pad early-return so keyboard-only
    // players can open it with no pad connected.
    if (
      this._gameplayEnabled &&
      !this._wheelOpen &&
      this._qHeld &&
      !this._qWheelFired &&
      now - this._qDownAt >= WHEEL_HOLD_MS
    ) {
      this._wheelOpenQueued = true;
      this._qWheelFired = true;
    }
    if (!frame) return null;
    if (frame.connected === false) {
      // Losing a controller cancels holds. Synthetic releases must not throw a
      // grenade, equip a weapon, or latch crouch as though the user tapped it.
      if (frame.released.grenade) {
        this._grenadeHeld = false;
        this._grenadeHoldStartedAt = 0;
      }
      if (this._padYHeld && this._wheelOpen) this._wheelCancelQueued = true;
      this._padYHeld = false;
      this._padYWheelFired = false;
      this._clearPadState();
      return frame;
    }
    if (!this._gameplayEnabled) {
      if (frame.pressed.pause) this._pauseHandler?.();
      this._clearPadState();
      return frame;
    }
    const pk = this._padKeys;
    const move = frame.move;
    pk.left = move.x < -TOUCH_MOVE_THRESHOLD;
    pk.right = move.x > TOUCH_MOVE_THRESHOLD;
    pk.forward = move.y < -TOUCH_MOVE_THRESHOLD;
    pk.back = move.y > TOUCH_MOVE_THRESHOLD;
    if (frame.pressed.sprint) this._padSprintLatched = true;
    if (move.magnitude === 0 || !pk.forward) this._padSprintLatched = false;
    pk.sprint = !!this._padSprintLatched || (pk.forward && move.magnitude >= 0.98);
    pk.jump = frame.held.jump;
    pk.interact = frame.held.interact;

    // Crouch: a quick tap latches, the next tap releases, a long hold follows the button.
    // While the wheel is up, pad B cancels the wheel instead of touching crouch.
    if (this._wheelOpen) {
      if (frame.pressed.crouch) this._wheelCancelQueued = true;
    } else if (frame.pressed.crouch) {
      this._padCrouchSince = now;
      this._padCrouchUnlatch = this._padCrouchLatched;
      this._padCrouchLatched = false;
      pk.crouch = !this._padCrouchUnlatch;
    } else if (frame.released.crouch) {
      if (!this._padCrouchUnlatch && now - this._padCrouchSince < PAD_TOGGLE_TAP_MS) {
        this._padCrouchLatched = true;
      }
      this._padCrouchUnlatch = false;
      pk.crouch = this._padCrouchLatched;
    } else {
      pk.crouch = (frame.held.crouch && !this._padCrouchUnlatch) || this._padCrouchLatched;
    }

    if (frame.pressed.fire && !this._wheelOpen) this._fireTapQueued = true;
    this._padFire = frame.held.fire;
    this._padAds = frame.held.ads;
    if (frame.pressed.reload && !this._wheelOpen) this._reloadQueued = true;
    // Y while the grenade is held cycles the throwable instead of the weapon.
    // Closed and off the grenade it arms the tap/hold split: a quick release still
    // swaps, holding it PAD_WHEEL_HOLD_MS opens the wheel instead.
    if (frame.pressed.weapon) {
      if (this._grenadeHeld) {
        this.cycleGrenadeType(1);
        this._padYWheelFired = true;
      } else {
        this._padYHeld = true;
        this._padYDownAt = now;
        this._padYWheelFired = false;
      }
    }
    if (
      !this._wheelOpen &&
      this._padYHeld &&
      !this._padYWheelFired &&
      now - this._padYDownAt >= PAD_WHEEL_HOLD_MS
    ) {
      this._wheelOpenQueued = true;
      this._padYWheelFired = true;
    }
    if (frame.released.weapon) {
      if (this._wheelOpen) this._wheelReleaseQueued = true;
      else if (this._padYHeld && !this._padYWheelFired) {
        if (this._grenadeHeld) this.cycleGrenadeType(1);
        else this._switchQueue += 1;
      }
      this._padYHeld = false;
    }
    // D-pad steps select on the wheel while it is up; closed they switch weapons.
    if (frame.pressed.slotUp) {
      if (this._wheelOpen) this._wheelStepQueue -= 1;
      else this._switchQueue -= 1;
    }
    if (frame.pressed.slotDown) {
      if (this._wheelOpen) this._wheelStepQueue += 1;
      else this._switchQueue += 1;
    }
    if (frame.pressed.lastWeapon) this._lastWeaponReq = true;
    if (frame.pressed.buy && !this._wheelOpen) this._buyMenuQueued = true;
    if (frame.pressed.zoom && !this._wheelOpen) this._zoomStepQueue += 1;
    if (frame.pressed.pause) this._pauseHandler?.();
    this._padScoreboard = frame.held.scoreboard;
    if (frame.pressed.grenade && !this._wheelOpen && !this._grenadeHeld) this._beginGrenadeHold(now);
    else if (frame.released.grenade && this._grenadeHeld) this._releaseGrenade(now);

    const look = frame.look;
    if (look.magnitude > 0) {
      if (this._wheelOpen) {
        // Pad look steers the wheel selection; the camera stays put.
        this._wheelVecX += look.x * WHEEL_VECTOR_RADIUS_PX;
        this._wheelVecY += look.y * WHEEL_VECTOR_RADIUS_PX;
      } else {
        const step = Math.max(0, Math.min(0.05, Number(dt) || 0));
        const rate = this._options.padSensitivity * this._assistScale() * step;
        this._accDX += look.x * rate;
        this._accDY += look.y * rate * (this.invertY ? -1 : 1);
      }
    }
    return frame;
  }

  _clearPadState() {
    const pk = this._padKeys;
    for (const name of MOVEMENT_KEYS) pk[name] = false;
    this._padFire = false;
    this._padAds = false;
    this._padCrouchLatched = false;
    this._padCrouchUnlatch = false;
    this._padSprintLatched = false;
    this._padScoreboard = false;
  }

  /* ---------------------------------------------------------------- readers */

  /**
   * Movement/weapon intents snapshot. Booleans are fresh each call, read
   * straight from current edge state. `reload` is an EDGE: true exactly once
   * per physical R press (first call after the press consumes it).
   * @returns {{forward:boolean,back:boolean,left:boolean,right:boolean,jump:boolean,
   *   sprint:boolean,crouch:boolean,interact:boolean,reload:boolean}}
   */
  getKeys() {
    const k = this.keys;
    const p = this._padKeys;
    const out = {
      forward: k.forward || p.forward,
      back: k.back || p.back,
      left: k.left || p.left,
      right: k.right || p.right,
      jump: k.jump || p.jump,
      sprint: k.sprint || p.sprint,
      crouch: k.crouch || p.crouch,
      interact: k.interact || p.interact,
      reload: this._reloadQueued,
    };
    this._reloadQueued = false;
    return out;
  }

  /**
   * Drains accumulated pointer-look motion since the last call.
   * Units: radians of intended look (already sensitivity-scaled and
   * invertY-adjusted). The local player applies the returned angles directly
   * to immediate camera/authority aim: yaw -= dx, pitch -= dy.
   * @returns {{dx:number,dy:number}} zeroes both accumulators
   */
  consumeDelta() {
    let dx = this._accDX;
    let dy = this._accDY;
    if (this.pointerKind() === 'trackpad' && !this._touchMode) {
      // Trackpads jitter: release most of the pending motion and carry the rest.
      dx *= TRACKPAD_SMOOTHING;
      dy *= TRACKPAD_SMOOTHING;
      this._accDX -= dx;
      this._accDY -= dy;
      if (Math.abs(this._accDX) < 1e-6) this._accDX = 0;
      if (Math.abs(this._accDY) < 1e-6) this._accDY = 0;
      return { dx, dy };
    }
    this._accDX = 0;
    this._accDY = 0;
    return { dx, dy };
  }

  /** Consumes one queued LMB tap (semi-auto / single-action shots). */
  consumeFireTap() {
    const q = this._fireTapQueued;
    this._fireTapQueued = false;
    return q;
  }

  /**
   * Net wheel cycling accumulated as an integer (typically -1/0/+1..n).
   * The caller applies the result modulo its live weapon roster length.
   * @returns {number}
   */
  consumeWeaponSwitch() {
    const q = this._switchQueue;
    this._switchQueue = 0;
    return q;
  }

  /**
   * Direct slot picked with Digit1..9 (slots 0..8) or Digit0 (slot 9), or null if none pending.
   * Consumed on read.
   * @returns {number|null}
   */
  consumeWeaponSlot() {
    const s = this._pendingSlot;
    this._pendingSlot = null;
    return s;
  }

  /** Q pressed since last call ("swap to previous weapon"). */
  consumeLastWeaponRequest() {
    const q = this._lastWeaponReq;
    this._lastWeaponReq = false;
    return q;
  }

  /** B pressed once since last call; physical repeats never enqueue again. */
  consumeBuyMenuRequest() {
    const queued = this._buyMenuQueued;
    this._buyMenuQueued = false;
    return queued;
  }

  /** Scope zoom steps (Z, wheel while scoped, R3) since the last call. */
  consumeZoomStep() {
    const q = this._zoomStepQueue;
    this._zoomStepQueue = 0;
    return q;
  }

  /**
   * Queued wheel-open request since the last call: Q held >= WHEEL_HOLD_MS, a
   * middle-mouse press, or pad Y held >= PAD_WHEEL_HOLD_MS
   * (a short press swaps weapons). Consumed on read.
   * @returns {boolean}
   */
  takeWheelOpenRequest() {
    const queued = this._wheelOpenQueued;
    this._wheelOpenQueued = false;
    return queued;
  }

  /**
   * True when a control that opens the wheel released while it is up (Q keyup,
   * middle-mouse up, pad Y release, LMB press to confirm). Consumed on read.
   * @returns {boolean}
   */
  takeWheelRelease() {
    const queued = this._wheelReleaseQueued;
    this._wheelReleaseQueued = false;
    return queued;
  }

  /**
   * True when a cancel was requested while the wheel is open (Esc, RMB, pad B).
   * Consumed on read.
   * @returns {boolean}
   */
  takeWheelCancelRequest() {
    const queued = this._wheelCancelQueued;
    this._wheelCancelQueued = false;
    return queued;
  }

  /**
   * Wheel selection vector since the last call, normalized so 1 equals
   * WHEEL_VECTOR_RADIUS_PX raw mouse px and the magnitude never exceeds the
   * ring (1); pad look adds per poll scaled by the same radius. Consumed and
   * reset on read.
   * @returns {{x:number, y:number}}
   */
  takeWheelVector() {
    const x = this._wheelVecX / WHEEL_VECTOR_RADIUS_PX;
    const y = this._wheelVecY / WHEEL_VECTOR_RADIUS_PX;
    const magnitude = Math.hypot(x, y);
    const scale = magnitude > 1 ? 1 / magnitude : 1;
    this._wheelVecX = 0;
    this._wheelVecY = 0;
    return { x: x * scale, y: y * scale };
  }

  /**
   * Wheel-scroll / pad d-pad steps accumulated while the wheel is open.
   * Consumed on read.
   * @returns {number}
   */
  takeWheelSteps() {
    const steps = this._wheelStepQueue;
    this._wheelStepQueue = 0;
    return steps;
  }

  /**
   * Direct Digit1..9/Digit0 slot pick (0..9) made while the wheel is open, or null.
   * Consumed on read.
   * @returns {number|null}
   */
  takeWheelDirectSlot() {
    const slot = this._pendingWheelSlot;
    this._pendingWheelSlot = null;
    return slot;
  }

  _beginGrenadeHold(at) {
    this._grenadeHeld = true;
    this._grenadeHoldStartedAt = at;
  }

  _releaseGrenade(at) {
    this._grenadeThrowQueued = {
      charge: this.getGrenadeCharge(at),
      cookMs: this.getGrenadeHoldMs(at),
      type: this._grenadeType,
    };
    this._grenadeHeld = false;
    this._grenadeHoldStartedAt = 0;
  }

  /**
   * The released G throw `{charge, cookMs, type}`, or null when no release is pending.
   * A quick tap is a valid zero-charge throw; `cookMs` is the full hold so the authority
   * can burn it off a timed fuse; `type` indexes GRENADE_TYPE_IDS.
   */
  consumeGrenadeThrow() {
    const queued = this._grenadeThrowQueued;
    this._grenadeThrowQueued = null;
    return queued;
  }

  /** Presentation-driven release (a fuse cooked to the end): queues the throw as if let go. */
  forceGrenadeRelease(now = eventTime(null)) {
    if (!this._grenadeHeld) return false;
    this._releaseGrenade(now);
    return true;
  }

  /** True while the grenade key/button is held (charge may still read 0 on the first ms). */
  isGrenadeCharging() {
    return this._grenadeHeld;
  }

  /** Live 0..1 hold progress for HUD presentation. */
  getGrenadeCharge(now = eventTime(null)) {
    if (!this._grenadeHeld) return 0;
    return clampGrenadeCharge((now - this._grenadeHoldStartedAt) / GRENADE_CHARGE_MS);
  }

  /** Milliseconds the grenade has been held (cook time); 0 while not held. */
  getGrenadeHoldMs(now = eventTime(null)) {
    if (!this._grenadeHeld) return 0;
    return Math.max(0, now - this._grenadeHoldStartedAt);
  }

  /** Selected throwable index (H / wheel or Y while holding G cycle it). */
  getGrenadeType() {
    return this._grenadeType;
  }

  setGrenadeType(index) {
    this._grenadeType = clampGrenadeType(index);
    return this._grenadeType;
  }

  cycleGrenadeType(direction = 1) {
    const count = GRENADE_TYPE_IDS.length;
    const step = Math.trunc(direction) || 1;
    this._grenadeType = ((this._grenadeType + step) % count + count) % count;
    return this._grenadeType;
  }

  /** Clears all held keys/taps/intents/queues (window blur, tab hide, etc). */
  clearTransient() {
    const k = this.keys;
    k.forward = k.back = k.left = k.right = false;
    k.jump = k.sprint = k.crouch = k.interact = false;
    this._mouseFire = false;
    this._mouseAds = false;
    this._adsLatched = false;
    this._fireTapQueued = false;
    this._reloadQueued = false;
    this._grenadeThrowQueued = null;
    this._grenadeHeld = false;
    this._grenadeHoldStartedAt = 0;
    this._lastWeaponReq = false;
    this._buyMenuQueued = false;
    this._buyMenuHeld = false;
    this._switchQueue = 0;
    this._wheel.acc = 0;
    this._pendingSlot = null;
    this._zoomStepQueue = 0;
    this._accDX = 0;
    this._accDY = 0;
    this._wheelOpen = false;
    this._wheelVecX = 0;
    this._wheelVecY = 0;
    this._wheelStepQueue = 0;
    this._pendingWheelSlot = null;
    this._wheelOpenQueued = false;
    this._wheelReleaseQueued = false;
    this._wheelCancelQueued = false;
    this._qHeld = false;
    this._qDownAt = 0;
    this._qWheelFired = false;
    this._mmbHeld = false;
    this._padYHeld = false;
    this._padYDownAt = 0;
    this._padYWheelFired = false;
    this._clearPadState();
    this._touchControls?.reset(false);
  }

  /** Removes every listener this instance attached. Idempotent and terminal. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._gameplayEnabled = false;
    this.clearTransient();
    this._pad.reset();
    const ownedPointerLock =
      typeof document !== 'undefined' && document.pointerLockElement === this.canvas;
    if (this._bound) {
      this._bound = false;
      window.removeEventListener('keydown', this._hKeyDown);
      window.removeEventListener('keyup', this._hKeyUp);
      window.removeEventListener('blur', this._hBlur);
      document.removeEventListener('visibilitychange', this._hVis);
      document.removeEventListener('mousemove', this._hMouseMove);
      document.removeEventListener('mouseup', this._hMouseUp);
      document.removeEventListener('pointerlockchange', this._hLockChange);
      document.removeEventListener('wheel', this._hWheel);
      this.canvas?.removeEventListener('mousedown', this._hMouseDown);
      this.canvas?.removeEventListener('contextmenu', this._hContext);
    }
    this.onLockChange = null;
    this._pauseHandler = null;
    this._touchControls?.dispose();
    this._touchControls = null;
    this._locked = false;
    if (ownedPointerLock && document.exitPointerLock) document.exitPointerLock();
  }

  // ----- internal handlers (also exercised by headless tests) -----
  _canReadGameplay() {
    return this._gameplayEnabled && (this._locked || this.fallback || this._touchMode);
  }

  _mountTouchControls() {
    if (!this._touchMode || this._touchControls || typeof document === 'undefined') return;
    this._touchControls = new TouchControls({
      onMove: (vector) => this._onTouchMove(vector),
      onLook: (dx, dy) => this._onTouchLook(dx, dy),
      onHold: (action, held) => this._onTouchHold(action, held),
      onPulse: (action) => this._onTouchPulse(action),
      onPause: () => {
        if (this._gameplayEnabled) this._pauseHandler?.();
      },
    });
    this._touchControls.mount(document.body);
    this._touchControls.setOptions({
      size: this._options.touchSize,
      hand: this._options.touchHand,
    });
    this._touchControls.setEnabled(this._gameplayEnabled);
  }

  _onTouchMove({ x = 0, y = 0, magnitude = 0 } = {}) {
    if (!this._gameplayEnabled) return;
    this.keys.left = x < -TOUCH_MOVE_THRESHOLD;
    this.keys.right = x > TOUCH_MOVE_THRESHOLD;
    this.keys.forward = y < -TOUCH_MOVE_THRESHOLD;
    this.keys.back = y > TOUCH_MOVE_THRESHOLD;
    this.keys.sprint = this.keys.forward && magnitude >= TOUCH_SPRINT_THRESHOLD;
  }

  _onTouchLook(dx, dy) {
    if (!this._gameplayEnabled || this._wheelOpen) return;
    const scale = this.sens * TOUCH_LOOK_SENSITIVITY_SCALE *
      this._options.touchSensitivity * this._assistScale();
    this._accDX += (Number(dx) || 0) * scale;
    this._accDY += (Number(dy) || 0) * scale * (this.invertY ? -1 : 1);
  }

  _onTouchHold(action, held) {
    const down = !!held;
    if ((!this._gameplayEnabled || this._wheelOpen) && down) return;
    switch (action) {
      case 'fire':
        if (down && !this._mouseFire) this._fireTapQueued = true;
        this._mouseFire = down;
        break;
      case 'ads': this._mouseAds = down; break;
      case 'jump': this.keys.jump = down; break;
      case 'interact': this.keys.interact = down; break;
      default: break;
    }
  }

  _onTouchPulse(action) {
    if (!this._gameplayEnabled || this._wheelOpen) return;
    if (action === 'reload') this._reloadQueued = true;
    else if (action === 'weapon') this._switchQueue += 1;
    else if (action === 'buy') this._buyMenuQueued = true;
  }

  _toggleAds(down) {
    if (this.adsMode() === 'toggle') {
      if (down) {
        this._adsLatched = !this._adsLatched;
        this._mouseAds = false;
      }
      return;
    }
    this._adsLatched = false;
    this._mouseAds = down;
  }

  _onKeyDown(e) {
    if (this._disposed) return;
    if (e.code === 'KeyB') {
      if (!e.repeat && !this._buyMenuHeld && !this._wheelOpen) this._buyMenuQueued = true;
      this._buyMenuHeld = true;
      return;
    }
    if (!this._canReadGameplay()) return;
    if (e.code === 'Space') e.preventDefault();
    switch (e.code) {
      case 'KeyW': this.keys.forward = true; break;
      case 'KeyS': this.keys.back = true; break;
      case 'KeyA': this.keys.left = true; break;
      case 'KeyD': this.keys.right = true; break;
      case 'Space': this.keys.jump = true; break;
      case 'ShiftLeft': case 'ShiftRight': this.keys.sprint = true; break;
      case 'ControlLeft': case 'ControlRight': case 'KeyC': this.keys.crouch = true; break;
      case 'KeyE': if (!this._wheelOpen) this.keys.interact = true; break;
      case 'KeyR': if (!e.repeat && !this._wheelOpen) this._reloadQueued = true; break;
      case 'KeyF': if (!e.repeat && !this._wheelOpen) this._toggleAds(true); break;   // ADS without a second button
      case 'KeyZ': if (!e.repeat && !this._wheelOpen) this._zoomStepQueue += 1; break;
      case 'KeyG':
        if (!e.repeat && !this._wheelOpen && !this._grenadeHeld) this._beginGrenadeHold(eventTime(e));
        break;
      case 'KeyH': if (!e.repeat && !this._wheelOpen) this.cycleGrenadeType(1); break;
      // Q arms a tap/hold split: a quick release swaps to the previous weapon,
      // holding it WHEEL_HOLD_MS opens the wheel (poll() completes the hold).
      case 'KeyQ':
        if (!e.repeat) {
          this._qHeld = true;
          this._qDownAt = eventTime(e);
          this._qWheelFired = false;
        }
        break;
      case 'Escape':
        if (this._wheelOpen) {
          this._wheelCancelQueued = true;
          e.preventDefault();
        }
        break;
      case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': case 'Digit5':
      case 'Digit6': case 'Digit7': case 'Digit8': case 'Digit9': case 'Digit0':
        if (!e.repeat) {
          // Digit0 trails Digit9 as the tenth slot key.
          const digit = e.code === 'Digit0' ? 10 : Number(e.code.slice(-1));
          if (this._wheelOpen) this._pendingWheelSlot = digit - 1;
          else this._pendingSlot = digit - 1;
        }
        break;
      default: break;
    }
  }

  _onKeyUp(e) {
    if (e.code === 'KeyB') {
      this._buyMenuHeld = false;
      return;
    }
    if (this._disposed || !this._canReadGameplay()) return;
    switch (e.code) {
      case 'KeyW': this.keys.forward = false; break;
      case 'KeyS': this.keys.back = false; break;
      case 'KeyA': this.keys.left = false; break;
      case 'KeyD': this.keys.right = false; break;
      case 'Space': this.keys.jump = false; break;
      case 'ShiftLeft': case 'ShiftRight': this.keys.sprint = false; break;
      case 'ControlLeft': case 'ControlRight': case 'KeyC': this.keys.crouch = false; break;
      case 'KeyE': this.keys.interact = false; break;
      case 'KeyF': if (this.adsMode() === 'hold') this._mouseAds = false; break;
      case 'KeyG':
        if (this._grenadeHeld) this._releaseGrenade(eventTime(e));
        break;
      case 'KeyQ':
        // Q release while the wheel is up closes it; a quick tap still swaps.
        if (this._wheelOpen) this._wheelReleaseQueued = true;
        else if (this._qHeld && !this._qWheelFired) this._lastWeaponReq = true;
        this._qHeld = false;
        break;
      default: break;
    }
  }

  _onMouseMove(e) {
    if (!this._gameplayEnabled || (!this._locked && !this.fallback)) return;
    if (this._wheelOpen) {
      // Raw pixels steer the wheel selection; look accumulators stay untouched.
      this._wheelVecX += e.movementX || 0;
      this._wheelVecY += e.movementY || 0;
      return;
    }
    const scale = this.sens * (this.pointerKind() === 'trackpad' ? TRACKPAD_LOOK_SCALE : 1);
    const dx = (e.movementX || 0) * scale;
    const dy = (e.movementY || 0) * scale * (this.invertY ? -1 : 1);
    this._accDX += dx;
    this._accDY += dy;
  }

  _onMouseDown(e) {
    if (!this._gameplayEnabled) return;
    if (!this._locked && !this.fallback) {
      if (e.isTrusted) this.requestLock();
      return;
    }
    if (this._wheelOpen) {
      // The wheel owns the mouse while it is up: LMB confirms the highlighted
      // slot, RMB cancels; combat clicks never pass through.
      if (e.button === 0) {
        this._wheelReleaseQueued = true;
        return;
      }
      if (e.button === 2) {
        this._wheelCancelQueued = true;
        e.preventDefault();
        return;
      }
      return;
    }
    if (e.button === 0) {
      this._mouseFire = true;
      this._fireTapQueued = true;
    } else if (e.button === 1) {
      this._wheelOpenQueued = true;
      this._mmbHeld = true;
    } else if (e.button === 2) {
      this._toggleAds(true);
      e.preventDefault();
    }
  }

  _onMouseUp(e) {
    if (e.button === 1) {
      this._mmbHeld = false;
      if (this._wheelOpen || this._wheelOpenQueued) this._wheelReleaseQueued = true;
      return;
    }
    if (this._wheelOpen) return;
    if (e.button === 0) this._mouseFire = false;
    else if (e.button === 2 && this.adsMode() === 'hold') this._mouseAds = false;
  }

  _onWheel(e) {
    if (!this._gameplayEnabled || (!this._locked && !this.fallback)) return;
    if (e.deltaY === 0) return;
    e.preventDefault();
    // A stream of small pixel deltas is a trackpad; notched wheels never look like this.
    if ((e.deltaMode ?? 0) === 0 && Math.abs(e.deltaY) <= WHEEL_SWITCH.trackpadDeltaPx) {
      if (++this._trackpadEvidence >= WHEEL_SWITCH.trackpadEvidence) this._trackpadDetected = true;
    } else {
      this._trackpadEvidence = 0;
    }
    const step = wheelSwitchStep(this._wheel, e, eventTime(e));
    if (step === 0) return;
    if (this._wheelOpen) {
      // While the wheel is up the scroll steps through its slots.
      this._wheelStepQueue += step;
      return;
    }
    if (this._grenadeHeld) this.cycleGrenadeType(step);
    else if (this._scopeZoomMode) this._zoomStepQueue += 1;
    else this._switchQueue += step;
  }
}
