// Voxel Blitz — pointer-lock first-person input manager (client-side).
//
// Owns raw device reading ONLY: key state edges, accumulated look deltas,
// pointer-lock lifecycle, fire/ADS intents and weapon-switch intents.
// Player physics owns movement integration; main.js owns look integration.
// This module only accumulates sensitivity-scaled pointer deltas using the
// canonical convention shared by the camera and authority:
//   yaw   -= dx  (mouse right => turn right)
//   pitch -= dy  (mouse down  => look down)
//   fwd = (-sin(yaw)*cos(pitch), sin(pitch), -cos(yaw)*cos(pitch))


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
    this.sens = 0.030;      // rad per pixel of movementX/Y
    this.invertY = false;
    // Sensitivity override (client-side preference). Guarded so the module
    // stays importable in Node (no localStorage).
    try {
      const s = parseFloat(localStorage.getItem('vb-sens'));
      if (Number.isFinite(s) && s > 0) {
        this.sens = Math.min(0.08, Math.max(0.005, s));
      }
    } catch (_) {}

    // Intents polled by the game loop.
    this.wantFireHeld = false; // LMB hold
    this.wantAdsHeld = false;  // RMB hold

    // Internal edge/accumulator state.
    this._bound = false;
    this._locked = false;
    this._gameplayEnabled = true;
    this._disposed = false;
    this._accDX = 0;          // pending scaled look delta (radians)
    this._accDY = 0;
    this._fireTapQueued = false;
    this._reloadQueued = false;
    this._switchQueue = 0;     // wheel steps accumulated (+/-1)
    this._pendingSlot = null;  // direct Digit1..6 pick (0..5) or null
    this._lastWeaponReq = false;
    this._buyMenuQueued = false;
    this._buyMenuHeld = false; // physical B latch suppresses repeat/re-entry
    this.keys = {
      forward: false, back: false, left: false, right: false,
      jump: false, sprint: false, crouch: false, interact: false,
    };

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
      this._locked = document.pointerLockElement === this.canvas;
      if (!this._locked) this.clearTransient();
      if (this.onLockChange) this.onLockChange(this._locked);
    };
  }

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
  }

  /** True while the game canvas owns the pointer. */
  isLocked() { return this._locked; }

  requestLock() {
    if (this._disposed || !this._gameplayEnabled) return;
    if (this.canvas && typeof this.canvas.requestPointerLock === 'function') {
      const p = this.canvas.requestPointerLock();
      if (p && typeof p.catch === 'function') p.catch(() => {});
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
    if (!next) this.clearTransient();
  }

  /**
   * Sets mouse-look sensitivity (rad per pixel) and persists the choice
   * under 'vb-sens'. Clamped to the settings contract [0.005, 0.08].
   * @param {number} v
   */
  setSensitivity(v) {
    const s = Number(v);
    if (!Number.isFinite(s) || s <= 0) return;
    this.sens = Math.min(0.08, Math.max(0.005, s));
    try { localStorage.setItem('vb-sens', String(this.sens)); } catch (_) {}
  }

  /** Current sensitivity in rad per pixel. */
  getSensitivity() {
    return this.sens;
  }

  /**
   * Movement/weapon intents snapshot. Booleans are fresh each call, read
   * straight from current edge state. `reload` is an EDGE: true exactly once
   * per physical R press (first call after the press consumes it).
   * @returns {{forward:boolean,back:boolean,left:boolean,right:boolean,jump:boolean,
   *   sprint:boolean,crouch:boolean,interact:boolean,reload:boolean}}
   */
  getKeys() {
    const k = this.keys;
    const out = {
      forward: k.forward, back: k.back, left: k.left, right: k.right,
      jump: k.jump, sprint: k.sprint, crouch: k.crouch,
      interact: k.interact,
      reload: this._reloadQueued,
    };
    this._reloadQueued = false;
    return out;
  }

  /**
   * Drains accumulated pointer-look motion since the last call.
   * Units: radians of intended look (already sensitivity-scaled and
   * invertY-adjusted). The yaw/pitch fields were ALREADY integrated by this
   * module — callers use dx/dy only for effects like viewmodel sway or recoil
   * follow-through. Applied angles were yaw -= dx, pitch -= dy.
   * @returns {{dx:number,dy:number}} zeroes both accumulators
   */
  consumeDelta() {
    const out = { dx: this._accDX, dy: this._accDY };
    this._accDX = 0;
    this._accDY = 0;
    return out;
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
   * Direct slot picked with Digit1..6 (0..5), or null if none pending.
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

  /** Clears all held keys/taps/intents/queues (window blur, tab hide, etc). */
  clearTransient() {
    const k = this.keys;
    k.forward = k.back = k.left = k.right = false;
    k.jump = k.sprint = k.crouch = k.interact = false;
    this.wantFireHeld = false;
    this.wantAdsHeld = false;
    this._fireTapQueued = false;
    this._reloadQueued = false;
    this._lastWeaponReq = false;
    this._buyMenuQueued = false;
    this._buyMenuHeld = false;
    this._switchQueue = 0;
    this._pendingSlot = null;
    this._accDX = 0;
    this._accDY = 0;
  }

  /** Removes every listener this instance attached. Idempotent and terminal. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._gameplayEnabled = false;
    this.clearTransient();
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
    this._locked = false;
    if (ownedPointerLock && document.exitPointerLock) document.exitPointerLock();
  }

  // ----- internal handlers (also exercised by headless tests) -----
  _onKeyDown(e) {
    if (this._disposed) return;
    if (e.code === 'KeyB') {
      if (!e.repeat && !this._buyMenuHeld) this._buyMenuQueued = true;
      this._buyMenuHeld = true;
      return;
    }
    if (!this._gameplayEnabled || (!this._locked && !this.fallback)) return;
    if (e.code === 'Space') e.preventDefault();
    switch (e.code) {
      case 'KeyW': this.keys.forward = true; break;
      case 'KeyS': this.keys.back = true; break;
      case 'KeyA': this.keys.left = true; break;
      case 'KeyD': this.keys.right = true; break;
      case 'Space': this.keys.jump = true; break;
      case 'ShiftLeft': case 'ShiftRight': this.keys.sprint = true; break;
      case 'ControlLeft': case 'ControlRight': case 'KeyC': this.keys.crouch = true; break;
      case 'KeyE': this.keys.interact = true; break;
      case 'KeyR': if (!e.repeat) this._reloadQueued = true; break;
      case 'KeyQ': if (!e.repeat) this._lastWeaponReq = true; break;
      case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': case 'Digit5': case 'Digit6':
        if (!e.repeat) this._pendingSlot = Number(e.code.slice(-1)) - 1;
        break;
      default: break;
    }
  }

  _onKeyUp(e) {
    if (e.code === 'KeyB') {
      this._buyMenuHeld = false;
      return;
    }
    if (this._disposed || !this._gameplayEnabled || (!this._locked && !this.fallback)) return;
    switch (e.code) {
      case 'KeyW': this.keys.forward = false; break;
      case 'KeyS': this.keys.back = false; break;
      case 'KeyA': this.keys.left = false; break;
      case 'KeyD': this.keys.right = false; break;
      case 'Space': this.keys.jump = false; break;
      case 'ShiftLeft': case 'ShiftRight': this.keys.sprint = false; break;
      case 'ControlLeft': case 'ControlRight': case 'KeyC': this.keys.crouch = false; break;
      case 'KeyE': this.keys.interact = false; break;
      default: break;
    }
  }

  _onMouseMove(e) {
    if (!this._gameplayEnabled || (!this._locked && !this.fallback)) return;
    const dx = (e.movementX || 0) * this.sens;
    const dy = (e.movementY || 0) * this.sens * (this.invertY ? -1 : 1);
    this._accDX += dx;
    this._accDY += dy;
  }

  _onMouseDown(e) {
    if (!this._gameplayEnabled) return;
    if (!this._locked && !this.fallback) {
      if (e.isTrusted) this.requestLock();
      return;
    }
    if (e.button === 0) {
      this.wantFireHeld = true;
      this._fireTapQueued = true;
    } else if (e.button === 2) {
      this.wantAdsHeld = true;
      e.preventDefault();
    }
  }

  _onMouseUp(e) {
    if (e.button === 0) this.wantFireHeld = false;
    else if (e.button === 2) this.wantAdsHeld = false;
  }

  _onWheel(e) {
    if (!this._gameplayEnabled || (!this._locked && !this.fallback)) return;
    if (e.deltaY === 0) return;
    e.preventDefault();
    this._switchQueue += e.deltaY > 0 ? 1 : -1;
  }
}
