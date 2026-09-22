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
  GRENADE_DEFAULT_POWER_INDEX,
  GRENADE_POUCH_HOLD_MS,
  GRENADE_POWER_STEPS,
  GRENADE_TAP_MS,
  GRENADE_THROW_COOLDOWN_MS,
  GRENADE_THROW_COOLDOWN_CLIENT_SLACK_MS,
  GRENADE_TYPE_IDS,
  autoReadyGrenade,
  grenadeCookFromHold,
  grenadePowerAt,
  grenadeTypeAt,
  nextStockedGrenade,
} from '../../../shared/grenade-rules.js';
import {
  TOUCH_MOVE_THRESHOLD,
  TouchControls,
  shouldEnableTouchControls,
  touchSprintActive,
} from './touch-controls.js';
import { GamepadInput } from './gamepad.js';
import { readKeybindings, subscribeKeybindings, isTypingTarget } from '../keybindings.js';
import { wheelAngleForSlot, wheelSlotFromVector } from '../ui/weapon-wheel.js';

// Touch drags travel far fewer pixels than a mouse, so thumb-look runs hotter than
// the mouse scale (default 0.003 rad/px × 1.4 ≈ 0.0042 rad/px, about 72° per 300 px).
export const TOUCH_LOOK_SENSITIVITY_SCALE = 1.4;
/** Aim assist never removes more than this much of pad/touch look speed near a target. */
export const AIM_ASSIST_MAX_SLOWDOWN = 0.5;
/** Quick pad crouch press latches; a longer hold releases with the button. */
const PAD_TOGGLE_TAP_MS = 260;
/** Pad Y hold that opens the weapon wheel; a quick Y tap keeps swapping/cycling. */
export const PAD_WHEEL_HOLD_MS = 260;
/** Default wheel radius for mouse normalization and pad look's pixel-equivalent motion. */
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

/** Quick-key action ids -> GRENADE_TYPE_IDS index (limpet is the wall claymore). */
const GRENADE_QUICK_KEYS = Object.freeze({
  grenadeFrag: 0, grenadeClaymore: 1, grenadePulse: 2, grenadeMolotov: 3, grenadeSmoke: 4,
});

const MOVEMENT_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'crouch', 'prone', 'leanLeft', 'leanRight', 'interact'];

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
    this._bindings = readKeybindings();
    this._keyboardHeld = new Set();
    this._keyboardFire = false;
    this._keyboardAds = false;
    this._unsubscribeBindings = subscribeKeybindings(bindings => {
      this._bindings = bindings;
      this.clearTransient();
      this._syncKeyboardLock();
    });
    this._bound = false;
    this._locked = false;
    this._gameplayEnabled = true;
    this._spectatorEnabled = false;
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
    this._quickMeleeQueued = false;
    this._medkitQueued = false;
    this._grenadeThrowQueued = null; // {charge, cookMs, type, tap} released this frame
    this._grenadeHeld = false;
    this._grenadeHoldStartedAt = 0;
    // Quick-draw pouch: one ready type that is always stocked, locked for the whole hold.
    this._readyGrenade = 0;    // ready throwable (index into GRENADE_TYPE_IDS), -1 when empty
    this._preferredGrenade = -1; // last manual pick, preferred by auto-advance
    this._grenadeCounts = null; // authoritative counts from setGrenadeCounts; null = unknown
    this._grenadeHoldType = -1; // type locked at the press; -1 while nothing is held
    this._grenadeHoldSource = null; // action that began the hold (only it can release)
    this._grenadePower = Array(GRENADE_TYPE_IDS.length).fill(GRENADE_DEFAULT_POWER_INDEX);
    this._lastGrenadeReleaseAt = -Infinity; // client mirror of the authority throw cooldown
    this._grenadeReleasePrevAt = -Infinity; // restored when a queued release is cancelled
    this._grenadeUiEvents = []; // {kind:'denied'|'advanced'|'cancel'|'readied', type, id, reason}
    this._pouchOpen = false;
    this._pouchSlot = -1;      // hovered pouch slot, always a stocked type (or -1)
    this._pouchCursorX = 0;    // clamped virtual cursor (px) that steers the pouch hover
    this._pouchCursorY = 0;
    this._pouchKeyHeld = false; // H tap/hold split: holding H opens the pouch
    this._pouchKeyDownAt = 0;
    this._pouchKeySpent = false; // the H gesture already opened, confirmed, or was consumed by G
    this._padPouchHeld = false; // pad d-pad-down tap/hold split
    this._padPouchDownAt = 0;
    this._padPouchSpent = false;
    this._switchQueue = 0;     // wheel steps accumulated (+/-1)
    this._wheel = { acc: 0, lastAt: -Infinity };
    this._pendingSlot = null;  // direct Digit1..9/0 pick (0..9) or null
    this._lastWeaponReq = false;
    this._buyMenuQueued = false;
    this._buyMenuHeld = false; // physical B latch suppresses repeat/re-entry
    // Bastion build mode: LMB places instead of firing, R rotates instead of
    // reloading, N cycles the blueprint. The build controller owns the mode.
    this._buildMode = false;
    this._placeQueued = false;
    this._buildToggleQueued = false;
    this._buildRotateQueued = false;
    this._buildExitQueued = false;
    this._zoomStepQueue = 0;   // scope zoom steps (KeyZ, R3)
    // Radial weapon wheel seam: while open, devices reroute (see setWeaponWheelOpen).
    this._wheelOpen = false;
    this._wheelVecX = 0;       // raw mouse px (pad look scaled) toward full ring deflection
    this._wheelVecY = 0;
    this._wheelStepQueue = 0;  // wheel-scroll / pad d-pad steps while open
    this._pendingWheelSlot = null; // direct Digit1..9/0 pick while open (0..9) or null
    this._wheelOpenQueued = false;
    this._wheelReleaseQueued = false;
    this._wheelCancelQueued = false;
    this._wheelKeyHeld = false;
    this._padYHeld = false;    // pad Y tap/hold split: holding Y opens the wheel
    this._padYDownAt = 0;
    this._padYWheelFired = false;
    this._trackpadEvidence = 0;
    this._trackpadDetected = false;
    this._aimAssist = 0;       // 0..1 strength supplied by the composition root
    this.keys = {
      forward: false, back: false, left: false, right: false,
      jump: false, sprint: false, crouch: false, prone: false, leanLeft: false, leanRight: false, interact: false,
    };

    // Gamepad state lives beside the keyboard so both can be held at once.
    this._pad = new GamepadInput();
    this._padKeys = {
      forward: false, back: false, left: false, right: false,
      jump: false, sprint: false, crouch: false, prone: false, leanLeft: false, leanRight: false, interact: false,
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
    this._hFullscreenChange = () => this._syncKeyboardLock();
    this._hLockChange = () => {
      if (this._touchMode) {
        this._locked = false;
        return;
      }
      this._locked = document.pointerLockElement === this.canvas;
      if (!this._locked) this.clearTransient();
      this._syncKeyboardLock();
      if (this.onLockChange) this.onLockChange(this._locked);
    };
  }

  /* ----------------------------------------------------------- held intents */

  /** LMB / RT / touch fire held; reads false while the weapon wheel or grenade pouch is open. */
  get wantFireHeld() { return !this._wheelOpen && !this._pouchOpen && !this._buildMode && (this._mouseFire || this._keyboardFire || this._padFire); }

  /** RMB / F / LT / touch ADS held or latched; reads false while the weapon wheel or pouch is open. */
  get wantAdsHeld() { return !this._wheelOpen && !this._pouchOpen && (this._mouseAds || this._keyboardAds || this._adsLatched || this._padAds); }
  set wantAdsHeld(value) {
    this._mouseAds = !!value;
    if (!value) this._adsLatched = false;
  }

  /** Back/Select on a pad holds the scoreboard, like Tab. */
  get scoreboardHeld() { return this._padScoreboard; }

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
    document.addEventListener('fullscreenchange', this._hFullscreenChange);
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
    if (this._disposed || (!this._gameplayEnabled && !this._spectatorEnabled)) return;
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
    this._requestFullscreen();
  }

  // Pointer lock must be requested first: fullscreen consumes user activation.
  _requestFullscreen() {
    if (this.fallback || typeof document === 'undefined' || document.fullscreenElement) return;
    if (typeof navigator !== 'undefined' && navigator.userActivation?.isActive === false) return;
    try {
      const request = document.documentElement?.requestFullscreen?.();
      request?.catch?.(() => {}); // Denial/unsupported browsers keep windowed play usable.
    } catch (_) {}
  }

  _syncKeyboardLock() {
    const keyboard = typeof navigator === 'undefined' ? null : navigator.keyboard;
    if (!keyboard) return;
    const active = !this._disposed && (this._gameplayEnabled || this._spectatorEnabled) && this._locked
      && typeof document !== 'undefined'
      && document.fullscreenElement === document.documentElement;
    try {
      if (active) keyboard.lock?.([...new Set(Object.values(this._bindings).flat())])?.catch?.(() => {});
      else keyboard.unlock?.();
    } catch (_) {}
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
    this._syncKeyboardLock();
    this._syncTouchControls();
    if (!next) this.clearTransient();
  }

  /** Spectators keep mouse, pad and touch look while movement and combat stay disabled. */
  setSpectatorEnabled(enabled) {
    const next = !!enabled && !this._disposed;
    if (next === this._spectatorEnabled) return;
    this._spectatorEnabled = next;
    this.clearTransient();
    this._syncKeyboardLock();
    this._syncTouchControls();
  }

  /** Touch controls stay up for spectators, reduced to the look zone and pause. */
  _syncTouchControls() {
    const controls = this._touchControls;
    if (!controls) return;
    controls.setSpectating(!this._gameplayEnabled && this._spectatorEnabled);
    controls.setEnabled(this._gameplayEnabled || this._spectatorEnabled);
  }

  /**
   * Sets look sensitivity (mouse rad per pixel, controller multiplier relative
   * to the default) and persists it under SENSITIVITY_PREF_KEY.
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

  /** Per-frame contextual visibility for the touch buttons; cheap when unchanged. */
  setTouchContext(context) {
    this._touchControls?.setContext(context);
  }

  /* ------------------------------------------------------------ build mode */

  /** Bastion build mode: entering clears fire/reload intents so no shot leaks. */
  setBuildMode(active) {
    const next = !!active;
    if (next === this._buildMode) return;
    this._buildMode = next;
    this._placeQueued = false;
    this._buildRotateQueued = false;
    this._buildExitQueued = false;
    if (next) {
      this._mouseFire = false;
      this._keyboardFire = false;
      this._padFire = false;
      this._fireTapQueued = false;
      this._reloadQueued = false;
      // Build mode owns G/H: a held grenade goes back in the pouch and the pouch closes.
      this.cancelGrenade('build');
      this._closeGrenadePouch();
    }
  }

  isBuildMode() { return this._buildMode; }

  /** One placement per LMB press / fire chip tap while build mode is active. */
  consumePlaceRequest() {
    const queued = this._placeQueued;
    this._placeQueued = false;
    return this._canReadGameplay() && this._buildMode && queued;
  }

  /** Build key pressed since the last call: 'next' cycles, 'exit' (Escape) leaves. */
  consumeBuildToggle() {
    const next = this._buildToggleQueued, exit = this._buildExitQueued;
    this._buildToggleQueued = false;
    this._buildExitQueued = false;
    if (!this._canReadGameplay()) return null;
    return exit ? 'exit' : next ? 'next' : null;
  }

  /** Reload key pressed while build mode is active: rotate the blueprint. */
  consumeBuildRotate() {
    const queued = this._buildRotateQueued;
    this._buildRotateQueued = false;
    return this._canReadGameplay() && this._buildMode && queued;
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
      // Preserve a fast wheel-key/flick/release gesture queued before the first frame.
      // Closing and transient resets already clear the previous gesture's vector.
      this._wheelStepQueue = 0;
      this._pendingWheelSlot = null;
      this._accDX = 0;
      this._accDY = 0;
      this._mouseFire = false;
      this._keyboardFire = false;
      this._keyboardAds = false;
      this._fireTapQueued = false;
      this._padFire = false;
      this._mouseAds = false;
      this._adsLatched = false;
      this._reloadQueued = false;
      this._placeQueued = false;
      this._buildRotateQueued = false;
      this._quickMeleeQueued = false;
      this._medkitQueued = false;
      // Cancel a held grenade without throwing it; the pouch and the wheel are exclusive.
      this.cancelGrenade('wheel');
      this._grenadeThrowQueued = null;
      this._closeGrenadePouch();
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

  /** True once a release or cancel freezes selection until the frame closes it. */
  isWeaponWheelClosing() {
    return this._wheelReleaseQueued || this._wheelCancelQueued;
  }

  /* ---------------------------------------------------------------- gamepad */

  /**
   * Poll the gamepad once per frame. `dt` scales stick look; button edges are folded
   * into the same queues the keyboard uses so LocalPlayer never sees a second device.
   */
  poll(now = eventTime(null), dt = 1 / 60) {
    if (this._disposed) return null;
    // The H tap/hold split is time based, so it resolves here even without a pad.
    this._updatePouchKeyHold(now);
    const frame = this._pad.poll(now);
    if (!frame) return null;
    if (frame.connected === false) {
      // Losing a controller cancels holds. Synthetic releases must not throw a
      // grenade, equip a weapon, or latch crouch as though the user tapped it.
      if (frame.released.grenade && this._grenadeHoldSource === 'pad') this.cancelGrenade('disconnect');
      if (this._padPouchHeld && this._pouchOpen) this._closeGrenadePouch();
      this._padPouchHeld = false;
      this._padPouchSpent = false;
      if (this._padYHeld && this._wheelOpen) this._wheelCancelQueued = true;
      this._padYHeld = false;
      this._padYWheelFired = false;
      this._clearPadState();
      return frame;
    }
    if (!this._gameplayEnabled) {
      if (frame.pressed.pause) this._pauseHandler?.();
      this._clearPadState();
      // Back mirrors the keyboard scoreboard key, which also works while dead.
      this._padScoreboard = !!frame.held.scoreboard;
      // Spectators orbit with the right stick; aim assist has no target to slow toward.
      if (this._spectatorEnabled && frame.look.magnitude > 0) this._padLook(frame.look, dt, 1);
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
    // While the wheel or pouch is up, pad B closes it instead of touching crouch.
    if (this._wheelOpen) {
      if (frame.pressed.crouch) this._wheelCancelQueued = true;
    } else if (this._pouchOpen) {
      if (frame.pressed.crouch) {
        this._closeGrenadePouch();
        this._padPouchSpent = true;
      }
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

    if (frame.pressed.fire && this._wheelOpen) this._wheelReleaseQueued = true;
    if (frame.pressed.fire && !this._wheelOpen && !this._pouchOpen) {
      if (this._buildMode) this._placeQueued = true;
      else this._fireTapQueued = true;
    }
    this._padFire = frame.held.fire;
    this._padAds = frame.held.ads;
    // X while a grenade is held puts the pin back; the swallowed press never reloads.
    if (frame.pressed.reload && this._grenadeHeld) this.cancelGrenade('pinBack');
    else if (frame.pressed.reload && !this._wheelOpen) {
      if (this._buildMode) this._buildRotateQueued = true;
      else this._reloadQueued = true;
    }
    // Y is weapons only: a quick release swaps, holding it PAD_WHEEL_HOLD_MS opens the
    // wheel instead.
    if (frame.pressed.weapon) {
      if (this._wheelOpen) {
        this._wheelCancelQueued = true;
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
      if (!this._wheelOpen && this._padYHeld && !this._padYWheelFired) this._switchQueue += 1;
      this._padYHeld = false;
    }
    // D-pad: power steps while RB holds a grenade, wheel steps while it is up, pouch
    // steps while that is up; closed, up switches weapons and down is the pouch split.
    if (this._grenadeHeld) {
      if (frame.pressed.slotUp) this.stepGrenadePower(1);
      if (frame.pressed.grenadePouch) this.stepGrenadePower(-1);
    } else if (this._wheelOpen) {
      if (frame.pressed.slotUp) this._wheelStepQueue -= 1;
      if (frame.pressed.grenadePouch) this._wheelStepQueue += 1;
    } else if (this._pouchOpen) {
      if (frame.pressed.slotUp) this._stepGrenadePouch(-1);
      if (frame.pressed.grenadePouch) this._stepGrenadePouch(1);
    } else {
      if (frame.pressed.slotUp) this._switchQueue -= 1;
      if (frame.pressed.grenadePouch && !this._buildMode) {
        this._padPouchHeld = true;
        this._padPouchDownAt = now;
        this._padPouchSpent = false;
      }
    }
    if (this._padPouchHeld && !this._padPouchSpent && !this._pouchOpen
        && now - this._padPouchDownAt >= PAD_WHEEL_HOLD_MS) {
      this._padPouchSpent = true;
      this.setGrenadePouchOpen(true);
    }
    if (frame.released.grenadePouch) {
      if (this._padPouchHeld) {
        if (this._pouchOpen) this.setGrenadePouchOpen(false, { confirm: true });
        else if (!this._padPouchSpent) this.cycleGrenadeType(1);
      }
      this._padPouchHeld = false;
      this._padPouchSpent = false;
    }
    if (frame.pressed.lastWeapon) this._lastWeaponReq = true;
    if (frame.pressed.buy && !this._wheelOpen) this._buyMenuQueued = true;
    if (frame.pressed.zoom && !this._wheelOpen) this._zoomStepQueue += 1;
    if (frame.pressed.pause) this._pauseHandler?.();
    this._padScoreboard = frame.held.scoreboard;
    if (frame.pressed.grenade && !this._wheelOpen && !this._grenadeHeld) {
      // RB with the pouch up readies the hovered slot and begins the hold in one press.
      if (this._pouchOpen) {
        this.setGrenadePouchOpen(false, { confirm: true });
        if (this._padPouchHeld) this._padPouchSpent = true;
      }
      this._beginGrenadeHold(now, this._readyGrenade, 'pad');
    } else if (frame.released.grenade && this._grenadeHeld && this._grenadeHoldSource === 'pad') {
      this._releaseGrenade(now);
    }

    const look = frame.look;
    if (look.magnitude > 0) {
      if (this._pouchOpen) {
        // Pad look steers the pouch hover; the camera stays put.
        this._steerGrenadePouch(look.x * WHEEL_VECTOR_RADIUS_PX, look.y * WHEEL_VECTOR_RADIUS_PX);
      } else if (this._wheelOpen || this._wheelOpenQueued) {
        // Pad look steers the wheel selection; the camera stays put.
        if (!this._wheelReleaseQueued && !this._wheelCancelQueued) {
          this._wheelVecX += look.x * WHEEL_VECTOR_RADIUS_PX;
          this._wheelVecY += look.y * WHEEL_VECTOR_RADIUS_PX;
        }
      } else {
        this._padLook(look, dt, this._assistScale());
      }
    }
    return frame;
  }

  _padLook(look, dt, assistScale) {
    const step = Math.max(0, Math.min(0.05, Number(dt) || 0));
    const sensitivityScale = this.sens / MOUSE_SENSITIVITY.default;
    const rate = this._options.padSensitivity * sensitivityScale * assistScale * step;
    this._accDX += look.x * rate;
    this._accDY += look.y * rate * (this.invertY ? -1 : 1);
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
      prone: !!k.prone,
      leanLeft: !!k.leanLeft,
      leanRight: !!k.leanRight,
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

  /** One quick chop per physical V press. */
  consumeQuickMelee() {
    const requested = this._quickMeleeQueued;
    this._quickMeleeQueued = false;
    return this._canReadGameplay() && !this._wheelOpen && requested;
  }

  consumeMedkit() {
    const requested = this._medkitQueued;
    this._medkitQueued = false;
    return this._canReadGameplay() && !this._wheelOpen && requested;
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

  /** Previous-weapon request from touch controls since the last call. */
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

  /** Scope zoom steps (Z / R3) since the last call. */
  consumeZoomStep() {
    const q = this._zoomStepQueue;
    this._zoomStepQueue = 0;
    return q;
  }

  /**
   * Queued wheel-open request since the last call: the wheel key press, a
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
   * True when the wheel key is released, LMB clicks, or the pad trigger confirms a wheel
   * selection. Consumed on read.
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
   * Wheel movement since the last call, divided by the visible ring radius.
   * Keep the full distance: clamping each frame loses fast flicks and makes
   * cursor travel depend on frame rate. Pad look contributes pixel-equivalent
   * motion using WHEEL_VECTOR_RADIUS_PX. Consumed and reset on read.
   * @param {number} [radiusPx=WHEEL_VECTOR_RADIUS_PX]
   * @returns {{x:number, y:number}}
   */
  takeWheelVector(radiusPx = WHEEL_VECTOR_RADIUS_PX) {
    const radius = Number.isFinite(radiusPx) && radiusPx > 0
      ? radiusPx : WHEEL_VECTOR_RADIUS_PX;
    const x = this._wheelVecX / radius;
    const y = this._wheelVecY / radius;
    this._wheelVecX = 0;
    this._wheelVecY = 0;
    return { x, y };
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

  /* --------------------------------------------------------- grenade pouch */

  /** True when type `index` can be drawn; unknown counts defer to the authority. */
  _grenadeStocked(index) {
    if (!Number.isInteger(index) || index < 0 || index >= GRENADE_TYPE_IDS.length) return false;
    return !this._grenadeCounts || this._grenadeCounts[index] > 0;
  }

  _emitGrenadeUi(kind, type = this._readyGrenade, reason = null) {
    this._grenadeUiEvents.push({ kind, type, id: GRENADE_TYPE_IDS[type] ?? null, reason });
    // Presentation drains this every frame; never let an idle queue grow.
    if (this._grenadeUiEvents.length > 16) this._grenadeUiEvents.shift();
  }

  /** The type the next hold would draw: the locked type while held, else the ready one. */
  _activeGrenade() {
    return this._grenadeHeld ? this._grenadeHoldType : this._readyGrenade;
  }

  /**
   * Authoritative per-type counts (the self row's `grenades`), fed every frame. Keeps the
   * ready type stocked through autoReadyGrenade and reports the change: 'advanced' when
   * the ready type ran out, 'readied' when an empty pouch gains a type (pickup, respawn).
   */
  setGrenadeCounts(counts) {
    if (!counts || typeof counts.length !== 'number') return;
    const next = GRENADE_TYPE_IDS.map((_, i) => Math.max(0, Math.trunc(Number(counts[i]) || 0)));
    const prev = this._grenadeCounts;
    if (prev && next.every((count, i) => count === prev[i])) return;
    this._grenadeCounts = next;
    const before = this._readyGrenade;
    const ready = autoReadyGrenade(next, before, this._preferredGrenade);
    if (this._pouchOpen && !this._grenadeStocked(this._pouchSlot)) this._pouchSlot = this._snapPouchSlot(this._pouchSlot);
    if (ready === before) return;
    this._readyGrenade = ready;
    if (ready < 0) return;
    const advanced = !!prev && before >= 0;
    this._emitGrenadeUi(advanced ? 'advanced' : 'readied', ready, advanced ? 'empty' : 'stocked');
  }

  /** Copy of the last authoritative counts, or null before the first setGrenadeCounts. */
  getGrenadeCounts() {
    return this._grenadeCounts ? [...this._grenadeCounts] : null;
  }

  /** Count of type `index` from the authoritative row, or null while counts are unknown. */
  getGrenadeCount(index) {
    if (!this._grenadeCounts) return null;
    return this._grenadeCounts[index] ?? 0;
  }

  /**
   * Starts a hold of `typeIndex` (default: the ready type). Returns false and reports
   * 'denied' in build mode, for an empty type, or inside the throw cooldown; otherwise
   * the type is locked until the release or a cancel.
   */
  _beginGrenadeHold(at, typeIndex = this._readyGrenade, source = 'grenade') {
    if (this._grenadeHeld) return false;
    const reason = this._buildMode ? 'build'
      : !this._grenadeStocked(typeIndex) ? 'empty'
        : at - this._lastGrenadeReleaseAt < GRENADE_THROW_COOLDOWN_MS + GRENADE_THROW_COOLDOWN_CLIENT_SLACK_MS
          ? 'cooldown' : null;
    if (reason) {
      this._emitGrenadeUi('denied', typeIndex, reason);
      return false;
    }
    this._grenadeHeld = true;
    this._grenadeHoldStartedAt = at;
    this._grenadeHoldType = typeIndex;
    this._grenadeHoldSource = source;
    return true;
  }

  _clearGrenadeHold() {
    this._grenadeHeld = false;
    this._grenadeHoldStartedAt = 0;
    this._grenadeHoldType = -1;
    this._grenadeHoldSource = null;
  }

  /** Tap and hold release alike: the remembered power step and the cook since the pin. */
  _releaseGrenade(at) {
    const type = this._grenadeHoldType;
    const held = Math.max(0, at - this._grenadeHoldStartedAt);
    this._grenadeThrowQueued = {
      charge: grenadePowerAt(this._grenadePower[type]),
      cookMs: grenadeCookFromHold(held, grenadeTypeAt(type)),
      type,
      tap: held < GRENADE_TAP_MS,
    };
    this._grenadeReleasePrevAt = this._lastGrenadeReleaseAt;
    this._lastGrenadeReleaseAt = at;
    this._clearGrenadeHold();
  }

  /**
   * The released throw `{charge, cookMs, type, tap}`, or null when no release is pending.
   * `charge` is the type's remembered power step, `cookMs` counts from the pin pull (zero
   * for non-cook types), `type` indexes GRENADE_TYPE_IDS, `tap` marks a quick throw.
   */
  consumeGrenadeThrow() {
    const queued = this._grenadeThrowQueued;
    this._grenadeThrowQueued = null;
    return queued;
  }

  /** The pending release without consuming it (presentation vets claymore placement). */
  peekGrenadeThrow() {
    return this._grenadeThrowQueued;
  }

  /** Presentation-driven release (a fuse cooked to the end): queues the throw as if let go. */
  forceGrenadeRelease(now = eventTime(null)) {
    if (!this._grenadeHeld) return false;
    this._releaseGrenade(now);
    return true;
  }

  /**
   * Pin back: drops the held grenade, or a release not yet consumed, without throwing or
   * spending anything, and reports 'cancel' with `reason`. False when nothing was held.
   */
  cancelGrenade(reason = 'pinBack') {
    let type = -1;
    if (this._grenadeHeld) {
      type = this._grenadeHoldType;
      this._clearGrenadeHold();
    } else if (this._grenadeThrowQueued) {
      type = this._grenadeThrowQueued.type;
      this._grenadeThrowQueued = null;
      this._lastGrenadeReleaseAt = this._grenadeReleasePrevAt;
    } else {
      return false;
    }
    this._emitGrenadeUi('cancel', type, reason);
    return true;
  }

  /** True while the grenade key/button is held (charge may still read 0 on the first ms). */
  isGrenadeCharging() {
    return this._grenadeHeld;
  }

  /** Throw charge of the held grenade (its power step) for presentation; 0 while not held. */
  getGrenadeCharge(now = eventTime(null)) {
    return this._grenadeHeld ? this.getGrenadePower() : 0;
  }

  /** Milliseconds the grenade has been held; 0 while not held. */
  getGrenadeHoldMs(now = eventTime(null)) {
    if (!this._grenadeHeld) return 0;
    return Math.max(0, now - this._grenadeHoldStartedAt);
  }

  /** Cook burned off a timed fuse since the pin pull; 0 while not held or for non-cook types. */
  getGrenadeCookMs(now = eventTime(null)) {
    if (!this._grenadeHeld) return 0;
    return grenadeCookFromHold(now - this._grenadeHoldStartedAt, grenadeTypeAt(this._grenadeHoldType));
  }

  /** Locked type of the held grenade, or -1 while nothing is held. */
  getGrenadeHoldType() {
    return this._grenadeHeld ? this._grenadeHoldType : -1;
  }

  /** Ready type index, or -1 when the pouch is empty. */
  getReadyGrenade() {
    return this._readyGrenade;
  }

  /** Held type while a grenade is held, else the ready type (0 when the pouch is empty). */
  getGrenadeType() {
    return Math.max(0, this._activeGrenade());
  }

  /** Remembered power step index of `type` (default: the held or ready type). */
  getGrenadePowerIndex(type = this._activeGrenade()) {
    return this._grenadePower[type] ?? GRENADE_DEFAULT_POWER_INDEX;
  }

  /** Throw charge (0..1) of the remembered power step of `type`. */
  getGrenadePower(type = this._activeGrenade()) {
    return grenadePowerAt(this.getGrenadePowerIndex(type));
  }

  /** Steps the held (or ready) type's power, `dir` > 0 = farther. Returns the new index. */
  stepGrenadePower(dir = 1) {
    const step = dir < 0 ? -1 : 1;
    return this.setGrenadePowerIndex(this.getGrenadePowerIndex() + step);
  }

  /** Sets the held (or ready) type's power step, clamped; remembered for the session. */
  setGrenadePowerIndex(index) {
    const type = this._activeGrenade();
    if (type < 0 || !Number.isFinite(index)) return this.getGrenadePowerIndex();
    this._grenadePower[type] = Math.max(0, Math.min(GRENADE_POWER_STEPS.length - 1, Math.trunc(index)));
    return this._grenadePower[type];
  }

  /**
   * Readies type `index`. Refused while a grenade is held (the type is locked) and for
   * empty types. A manual pick becomes the auto-advance preference. Reports 'readied'.
   */
  selectGrenadeType(index, { manual = true } = {}) {
    if (this._grenadeHeld || !this._grenadeStocked(index)) return false;
    const changed = index !== this._readyGrenade;
    this._readyGrenade = index;
    if (manual) this._preferredGrenade = index;
    if (changed) this._emitGrenadeUi('readied', index, manual ? 'pick' : 'auto');
    return true;
  }

  /**
   * Readies the next stocked type in `direction` (roster order, wrapping). Ignored while a
   * grenade is held; reports 'denied' when no other type is stocked.
   */
  cycleGrenadeType(direction = 1) {
    if (this._grenadeHeld) return this.getGrenadeType();
    const step = Math.trunc(direction) < 0 ? -1 : 1;
    const count = GRENADE_TYPE_IDS.length;
    const next = this._grenadeCounts
      ? nextStockedGrenade(this._grenadeCounts, this._readyGrenade, step)
      : ((Math.max(0, this._readyGrenade) + step) % count + count) % count;
    if (next < 0) this._emitGrenadeUi('denied', this._readyGrenade, 'noOther');
    else this.selectGrenadeType(next);
    return this.getGrenadeType();
  }

  /** Pending pouch/ready events since the last call (HUD flags and sfx). Consumed on read. */
  consumeGrenadeUiEvents() {
    const events = this._grenadeUiEvents;
    this._grenadeUiEvents = [];
    return events;
  }

  /** True while the grenade pouch routes pointer, scroll and stick input. */
  isGrenadePouchOpen() {
    return this._pouchOpen;
  }

  /** Hovered pouch slot (always a stocked type), or -1. */
  getGrenadePouchHover() {
    return this._pouchOpen ? this._pouchSlot : -1;
  }

  /** Hover a pouch slot directly (overlay pointer, touch); empty slots snap to stocked ones. */
  setGrenadePouchHover(index) {
    if (!this._pouchOpen || !Number.isInteger(index)) return this.getGrenadePouchHover();
    this._pouchSlot = this._snapPouchSlot(index);
    return this._pouchSlot;
  }

  /**
   * Opens or closes the pouch. Opening is refused while a grenade is held, in build mode,
   * with the weapon wheel up or queued, or when nothing is stocked (that reports 'denied').
   * Closing with `confirm` readies the hovered slot. Returns whether the state changed.
   */
  setGrenadePouchOpen(open, { confirm = false } = {}) {
    if (!open) {
      if (!this._pouchOpen) return false;
      const slot = this._pouchSlot;
      this._closeGrenadePouch();
      if (confirm && slot >= 0) this.selectGrenadeType(slot);
      return true;
    }
    if (this._pouchOpen) return false;
    if (this._grenadeHeld || this._buildMode || this._wheelOpen || !this._gameplayEnabled) return false;
    const first = this._grenadeStocked(this._readyGrenade) ? this._readyGrenade
      : GRENADE_TYPE_IDS.findIndex((_, i) => this._grenadeStocked(i));
    if (first < 0) {
      this._emitGrenadeUi('denied', this._readyGrenade, 'empty');
      return false;
    }
    this._pouchOpen = true;
    this._pouchSlot = first;
    this._pouchCursorX = 0;
    this._pouchCursorY = 0;
    // Like the wheel: no combat intent leaks through, and a pending wheel open is dropped.
    this._mouseFire = false;
    this._keyboardFire = false;
    this._padFire = false;
    this._fireTapQueued = false;
    this._wheelOpenQueued = false;
    this._accDX = 0;
    this._accDY = 0;
    return true;
  }

  _closeGrenadePouch() {
    this._pouchOpen = false;
    this._pouchSlot = -1;
    this._pouchCursorX = 0;
    this._pouchCursorY = 0;
  }

  /** Nearest stocked slot to `index` by angle (the pointer never rests on an empty one). */
  _snapPouchSlot(index, angle = wheelAngleForSlot(index, GRENADE_TYPE_IDS.length)) {
    if (this._grenadeStocked(index)) return index;
    let best = -1;
    let bestGap = Infinity;
    for (let i = 0; i < GRENADE_TYPE_IDS.length; i++) {
      if (!this._grenadeStocked(i)) continue;
      const gap = Math.abs(((wheelAngleForSlot(i, GRENADE_TYPE_IDS.length) - angle + 540) % 360) - 180);
      if (gap < bestGap) { best = i; bestGap = gap; }
    }
    return best;
  }

  /** Mouse or stick motion (px) steers a clamped cursor; inside the dead zone the hover stays. */
  _steerGrenadePouch(dx, dy) {
    const radius = WHEEL_VECTOR_RADIUS_PX;
    let x = this._pouchCursorX + (Number(dx) || 0);
    let y = this._pouchCursorY + (Number(dy) || 0);
    const length = Math.hypot(x, y);
    if (length > radius) { x *= radius / length; y *= radius / length; }
    this._pouchCursorX = x;
    this._pouchCursorY = y;
    const slot = wheelSlotFromVector(x / radius, y / radius, GRENADE_TYPE_IDS.length);
    if (slot < 0) return;
    const angle = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    const snapped = this._snapPouchSlot(slot, angle);
    if (snapped >= 0) this._pouchSlot = snapped;
  }

  /** Scroll / d-pad step through the stocked pouch slots. */
  _stepGrenadePouch(dir) {
    if (!this._pouchOpen) return;
    const count = GRENADE_TYPE_IDS.length;
    const next = this._grenadeCounts
      ? nextStockedGrenade(this._grenadeCounts, this._pouchSlot, dir)
      : ((this._pouchSlot + (dir < 0 ? -1 : 1)) % count + count) % count;
    if (next >= 0) this._pouchSlot = next;
  }

  /** H held for GRENADE_POUCH_HOLD_MS opens the pouch (a shorter tap readies the next type). */
  _updatePouchKeyHold(now) {
    if (!this._pouchKeyHeld || this._pouchKeySpent || now - this._pouchKeyDownAt < GRENADE_POUCH_HOLD_MS) return;
    this._pouchKeySpent = true;
    if (this._grenadeHeld || this._wheelOpen) return;
    this.setGrenadePouchOpen(true);
  }

  /** Clears all held keys/taps/intents/queues (window blur, tab hide, etc). */
  clearTransient() {
    this._keyboardHeld.clear();
    this._keyboardFire = false;
    this._keyboardAds = false;
    const k = this.keys;
    k.forward = k.back = k.left = k.right = false;
    k.jump = k.sprint = k.crouch = k.prone = k.leanLeft = k.leanRight = k.interact = false;
    this._mouseFire = false;
    this._mouseAds = false;
    this._adsLatched = false;
    this._fireTapQueued = false;
    this._reloadQueued = false;
    this._quickMeleeQueued = false;
    this._medkitQueued = false;
    // Pin back and close the pouch; counts, the ready type and power steps survive.
    this.cancelGrenade('reset');
    this._grenadeThrowQueued = null;
    this._closeGrenadePouch();
    this._pouchKeyHeld = false;
    this._pouchKeySpent = false;
    this._padPouchHeld = false;
    this._padPouchSpent = false;
    this._lastWeaponReq = false;
    this._buyMenuQueued = false;
    this._buyMenuHeld = false;
    this._placeQueued = false;
    this._buildToggleQueued = false;
    this._buildRotateQueued = false;
    this._buildExitQueued = false;
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
    this._wheelKeyHeld = false;
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
    this._unsubscribeBindings?.();
    this._syncKeyboardLock();
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
      document.removeEventListener('fullscreenchange', this._hFullscreenChange);
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
        if (this._gameplayEnabled || this._spectatorEnabled) this._pauseHandler?.();
      },
    });
    this._touchControls.mount(document.body);
    this._touchControls.setOptions({
      size: this._options.touchSize,
      hand: this._options.touchHand,
    });
    this._syncTouchControls();
  }

  _onTouchMove({ x = 0, y = 0, magnitude = 0 } = {}) {
    if (!this._gameplayEnabled) return;
    this.keys.left = x < -TOUCH_MOVE_THRESHOLD;
    this.keys.right = x > TOUCH_MOVE_THRESHOLD;
    this.keys.forward = y < -TOUCH_MOVE_THRESHOLD;
    this.keys.back = y > TOUCH_MOVE_THRESHOLD;
    this.keys.sprint = touchSprintActive({ y, magnitude });
  }

  _onTouchLook(dx, dy) {
    if ((!this._gameplayEnabled && !this._spectatorEnabled) || this._wheelOpen || this._pouchOpen) return;
    const scale = this.sens * TOUCH_LOOK_SENSITIVITY_SCALE *
      this._options.touchSensitivity * (this._gameplayEnabled ? this._assistScale() : 1);
    this._accDX += (Number(dx) || 0) * scale;
    this._accDY += (Number(dy) || 0) * scale * (this.invertY ? -1 : 1);
  }

  /**
   * Touch hold edges. For 'grenade' a press returns whether a hold actually began, so the
   * button can drop its held overlay when the press is denied (cooldown, empty, build).
   */
  _onTouchHold(action, held, at = eventTime(null)) {
    const down = !!held;
    if ((!this._gameplayEnabled || this._wheelOpen) && down) return false;
    switch (action) {
      case 'grenade':
        // Press readies (a pouch pick first) and begins; lifting throws. PIN BACK pulses cancel.
        if (down) {
          if (this._grenadeHeld) return this._grenadeHoldSource === 'touch';
          this.setGrenadePouchOpen(false, { confirm: true });
          return this._beginGrenadeHold(at, this._readyGrenade, 'touch');
        } else if (this._grenadeHeld && this._grenadeHoldSource === 'touch') {
          this._releaseGrenade(at);
        }
        break;
      case 'fire':
        if (this._buildMode) { if (down) this._placeQueued = true; break; }
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
    if (action === 'reload') {
      if (this._grenadeHeld) this.cancelGrenade('pinBack');
      else if (this._buildMode) this._buildRotateQueued = true;
      else this._reloadQueued = true;
    }
    else if (action === 'medkit') this._medkitQueued = true;
    else if (action === 'weapon') this._switchQueue += 1;
    else if (action === 'buy') this._buyMenuQueued = true;
    else if (action === 'build') this._buildToggleQueued = true;
    else if (action === 'grenadeCancel') this.cancelGrenade('pinBack');
    else if (action === 'pouch') {
      if (this._pouchOpen) this.setGrenadePouchOpen(false);
      else this.setGrenadePouchOpen(true);
    } else if (action === 'pouchClose') this.setGrenadePouchOpen(false);
    else if (typeof action === 'string' && action.startsWith('grenadePower:')) {
      // Power stops only mean something in hand; never rewrite the ready type's step blind.
      if (this._grenadeHeld) this.setGrenadePowerIndex(Number(action.slice(13)));
    } else if (typeof action === 'string' && action.startsWith('pouchSlot:')) {
      // A tap on a stocked slot readies it; empty slots are never picked.
      const slot = Number(action.slice(10));
      if (this._pouchOpen && this._grenadeStocked(slot)) {
        this._pouchSlot = slot;
        this.setGrenadePouchOpen(false, { confirm: true });
      }
    }
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

  _keyboardAction(code) {
    // Spectator/replay actions have their own context and listeners.
    return Object.keys(this._bindings).find(action => !action.startsWith('spectate')
      && action !== 'skipReplay' && this._bindings[action].includes(code));
  }

  _actionHeld(action) {
    return this._bindings[action].some(code => this._keyboardHeld.has(code));
  }

  _onKeyDown(e) {
    if (this._disposed || e.defaultPrevented || isTypingTarget(e.target) || e.target?.closest?.('#settings-overlay')) return;
    const action = this._keyboardAction(e.code);
    if (this._canReadGameplay() && action) e.preventDefault();
    if (action === 'buy') {
      e.preventDefault();
      if (!e.repeat && !this._buyMenuHeld && !this._wheelOpen) this._buyMenuQueued = true;
      this._buyMenuHeld = true;
      return;
    }
    if (!this._canReadGameplay()) return;
    this._keyboardHeld.add(e.code);
    switch (action || e.code) {
      case 'prone': if (!e.repeat && !this._wheelOpen) this.keys.prone = !this.keys.prone; break;
      case 'forward': case 'back': case 'left': case 'right': case 'sprint': case 'crouch':
      case 'leanLeft': case 'leanRight':
        this.keys[action] = true;
        break;
      case 'jump':
        if (e.repeat) break;
        // Consume this press to get up; jumping requires a fresh press.
        if (this.keys.prone) {
          this.keys.prone = false;
          this.keys.jump = false;
        } else this.keys.jump = true;
        break;
      case 'interact': if (!this._wheelOpen) this.keys.interact = true; break;
      case 'fire':
        if (!this._wheelOpen) {
          if (!this._keyboardFire && !e.repeat) this._fireTapQueued = true;
          this._keyboardFire = true;
        }
        break;
      case 'quickMelee': if (!e.repeat && !this._wheelOpen) this._quickMeleeQueued = true; break;
      case 'medkit': if (!e.repeat && !this._wheelOpen) this._medkitQueued = true; break;
      case 'reload': case 'grenadeCancel':
        // While a grenade is held R is PIN BACK; the swallowed press never queues a reload.
        if (this._grenadeHeld) {
          if (!e.repeat) this.cancelGrenade('pinBack');
          break;
        }
        if (action === 'reload' && !e.repeat && !this._wheelOpen) {
          if (this._buildMode) this._buildRotateQueued = true;
          else this._reloadQueued = true;
        }
        break;
      case 'build': if (!e.repeat && !this._wheelOpen) this._buildToggleQueued = true; break;
      case 'ads':
        if (!e.repeat && !this._wheelOpen) {
          if (this.adsMode() === 'toggle') this._toggleAds(true);
          else this._keyboardAds = true;
        }
        break;
      case 'zoom': if (!e.repeat && !this._wheelOpen) this._zoomStepQueue += 1; break;
      case 'grenade':
        if (e.repeat || this._wheelOpen || this._grenadeHeld) break;
        // G with the pouch up readies the hovered slot and begins: flick-then-G is one gesture.
        if (this._pouchOpen) {
          this.setGrenadePouchOpen(false, { confirm: true });
          this._pouchKeySpent = true;
        }
        this._beginGrenadeHold(eventTime(e), this._readyGrenade, 'grenade');
        break;
      case 'grenadeType':
        // Tap readies the next stocked type on release; a hold opens the pouch in poll().
        if (e.repeat) { this._updatePouchKeyHold(eventTime(e)); break; }
        if (this._wheelOpen || this._grenadeHeld || this._buildMode || this._pouchKeyHeld) break;
        this._pouchKeyHeld = true;
        this._pouchKeyDownAt = eventTime(e);
        this._pouchKeySpent = this._pouchOpen;
        break;
      case 'grenadePrevious':
        if (!e.repeat && !this._wheelOpen && !this._buildMode && !this._pouchOpen) this.cycleGrenadeType(-1);
        break;
      case 'grenadeFrag': case 'grenadeClaymore': case 'grenadePulse':
      case 'grenadeMolotov': case 'grenadeSmoke': {
        if (e.repeat || this._wheelOpen || this._grenadeHeld) break;
        const type = GRENADE_QUICK_KEYS[action];
        if (this.setGrenadePouchOpen(false)) this._pouchKeySpent = true;
        // An empty type is refused by the hold itself, which reports the dry click.
        if (!this._buildMode) this.selectGrenadeType(type);
        this._beginGrenadeHold(eventTime(e), type, action);
        break;
      }
      case 'previousWeapon': case 'nextWeapon':
        if (!e.repeat) {
          const step = action === 'previousWeapon' ? -1 : 1;
          if (this._wheelOpen) this._wheelStepQueue += step;
          else this._switchQueue += step;
        }
        break;
      case 'weaponWheel':
        if (!e.repeat && !this._wheelKeyHeld) {
          this._wheelKeyHeld = true;
          if (!this._wheelOpen) this._wheelOpenQueued = true;
        }
        break;
      case 'Escape':
        if (this._pouchOpen) {
          this.setGrenadePouchOpen(false);
          this._pouchKeySpent = true;
          e.preventDefault();
        } else if (this._wheelOpen || this._wheelOpenQueued) {
          this._wheelCancelQueued = true;
          e.preventDefault();
        } else if (this._buildMode) {
          this._buildExitQueued = true;
          e.preventDefault();
        }
        break;
      default:
        if (action?.startsWith('slot') && !e.repeat) {
          const slot = Number(action.slice(4)) - 1;
          if (this._wheelOpen) this._pendingWheelSlot = slot;
          else this._pendingSlot = slot;
        }
        break;
    }
  }

  _onKeyUp(e) {
    const action = this._keyboardAction(e.code);
    this._keyboardHeld.delete(e.code);
    if (!this._disposed && this._canReadGameplay() && action) e.preventDefault();
    if (action === 'buy') { this._buyMenuHeld = false; return; }
    if (action === 'weaponWheel') {
      if (!this._disposed && this._canReadGameplay() && this._wheelKeyHeld
          && (this._wheelOpen || this._wheelOpenQueued) && !this._actionHeld(action)) {
        this._wheelReleaseQueued = true;
      }
      this._wheelKeyHeld = this._actionHeld(action);
      return;
    }
    if (this._disposed || !this._canReadGameplay()) return;
    switch (action) {
      case 'forward': case 'back': case 'left': case 'right': case 'jump':
      case 'sprint': case 'crouch': case 'leanLeft': case 'leanRight': case 'interact':
        this.keys[action] = this._actionHeld(action);
        break;
      case 'fire': this._keyboardFire = this._actionHeld(action); break;
      case 'ads': this._keyboardAds = this._actionHeld(action); break;
      case 'grenade': case 'grenadeFrag': case 'grenadeClaymore': case 'grenadePulse':
      case 'grenadeMolotov': case 'grenadeSmoke':
        // Only the action that began the hold releases it.
        if (this._grenadeHeld && this._grenadeHoldSource === action && !this._actionHeld(action)) {
          this._releaseGrenade(eventTime(e));
        }
        break;
      case 'grenadeType': {
        if (!this._pouchKeyHeld || this._actionHeld(action)) break;
        const at = eventTime(e);
        this._updatePouchKeyHold(at);
        this._pouchKeyHeld = false;
        if (this._pouchOpen) this.setGrenadePouchOpen(false, { confirm: true });
        else if (!this._pouchKeySpent && at - this._pouchKeyDownAt < GRENADE_POUCH_HOLD_MS) this.cycleGrenadeType(1);
        this._pouchKeySpent = false;
        break;
      }
      default: break;
    }
  }

  _onMouseMove(e) {
    if (this._disposed || (!this._gameplayEnabled && !this._spectatorEnabled)
        || (!this._locked && !this.fallback)) return;
    if (this._pouchOpen) {
      // Raw pixels steer the pouch hover; the camera does not turn.
      if (this._locked) this._steerGrenadePouch(e.movementX || 0, e.movementY || 0);
      return;
    }
    if (this._wheelOpen || this._wheelOpenQueued) {
      if (!this._locked) return; // Unlocked pointers use the overlay coordinates.
      if (this._wheelReleaseQueued || this._wheelCancelQueued) return;
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
    if (this._disposed || (!this._gameplayEnabled && !this._spectatorEnabled)) return;
    if (!this._locked && !this.fallback) {
      if (e.isTrusted) this.requestLock();
      return;
    }
    if (!this._gameplayEnabled) return;
    if (this._pouchOpen) {
      // The pouch owns the mouse: LMB readies the hovered slot, RMB/MMB close it unchanged.
      this.setGrenadePouchOpen(false, { confirm: e.button === 0 });
      this._pouchKeySpent = true;
      if (e.button !== 0) e.preventDefault?.();
      return;
    }
    if (this._wheelOpen) {
      // The wheel owns the mouse while it is up: LMB confirms the highlighted
      // slot, RMB cancels; combat clicks never pass through.
      if (e.button === 0) {
        this._wheelReleaseQueued = true;
        return;
      }
      if (e.button === 2 || e.button === 1) {
        this._wheelCancelQueued = true;
        e.preventDefault();
        return;
      }
      return;
    }
    if (this._buildMode && e.button === 0) {
      // Build mode owns LMB: one placement per click, never a shot.
      this._placeQueued = true;
      return;
    }
    if (e.button === 0) {
      this._mouseFire = true;
      this._fireTapQueued = true;
    } else if (e.button === 1) {
      this._wheelOpenQueued = true;
    } else if (e.button === 2) {
      this._toggleAds(true);
      e.preventDefault();
    }
  }

  _onMouseUp(e) {
    if (e.button === 1) return;
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
    // Pouch up: scroll steps its slots. Grenade held: scroll up throws farther. The
    // scroll never switches weapons or types during a hold.
    if (this._pouchOpen) this._stepGrenadePouch(step);
    else if (this._grenadeHeld) this.stepGrenadePower(-step);
    else this._switchQueue += step;
  }
}
