import { GRENADE_TYPES, GRENADE_TYPE_IDS } from '../../../shared/grenade-rules.js';
const DEFAULT_RADIUS = 54;
const DEFAULT_DEAD_ZONE = 0.14;
/** Quick press/release on a toggle button latches it instead of acting as a hold. */
export const TOUCH_TOGGLE_TAP_MS = 260;
/** A look-zone touch shorter and stiller than this fires one shot instead of aiming. */
export const TOUCH_TAP_FIRE_MS = 180;
export const TOUCH_TAP_FIRE_TRAVEL_PX = 10;
/** A weapon-chip press held this long opens the radial weapon wheel instead of swapping. */
export const WHEEL_TOUCH_HOLD_MS = 300;
const LOOK_DELTA_CLAMP_PX = 90;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function eventTime(event) {
  if (Number.isFinite(event?.timeStamp)) return event.timeStamp;
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Pure joystick shaping shared by the live control and its focused contract. */
export function joystickVector(dx, dy, radius = DEFAULT_RADIUS, deadZone = DEFAULT_DEAD_ZONE) {
  const safeRadius = Math.max(1, Number(radius) || DEFAULT_RADIUS);
  const dead = clamp(Number(deadZone) || 0, 0, 0.95);
  const distance = Math.hypot(Number(dx) || 0, Number(dy) || 0);
  if (distance <= safeRadius * dead) return Object.freeze({ x: 0, y: 0, magnitude: 0 });

  const rawMagnitude = Math.min(1, distance / safeRadius);
  const magnitude = (rawMagnitude - dead) / (1 - dead);
  const scale = distance > 0 ? magnitude / distance : 0;
  return Object.freeze({
    x: clamp((Number(dx) || 0) * scale, -1, 1),
    y: clamp((Number(dy) || 0) * scale, -1, 1),
    magnitude: clamp(magnitude, 0, 1),
  });
}

/**
 * Toggle-button policy shared by ADS and crouch: a quick tap latches the action on
 * until the next tap; a long press behaves like a hold and releases with the finger.
 * Returns the held state the button should report after the release.
 */
export function resolveToggleRelease(heldMs, wasLatched) {
  if (wasLatched) return false;
  return Number(heldMs) < TOUCH_TOGGLE_TAP_MS;
}

/** Whether a look-zone touch reads as a tap-to-fire rather than an aim drag. */
export function isTapToFire(heldMs, travelPx) {
  return Number(heldMs) < TOUCH_TAP_FIRE_MS && Number(travelPx) < TOUCH_TAP_FIRE_TRAVEL_PX;
}
/** Whether a weapon-chip press held this long opens the radial wheel. */
export function isWheelTouchHold(heldMs) {
  return Number(heldMs) >= WHEEL_TOUCH_HOLD_MS;
}

/** Touch/coarse-pointer capability detection; ?touch=1 is the explicit QA override. */
export function shouldEnableTouchControls({
  windowRef = typeof window !== 'undefined' ? window : null,
  navigatorRef = typeof navigator !== 'undefined' ? navigator : null,
  locationRef = typeof location !== 'undefined' ? location : null,
} = {}) {
  try {
    if (new URLSearchParams(locationRef?.search || '').get('touch') === '1') return true;
  } catch (_) {}
  try {
    const matchMedia = windowRef?.matchMedia?.bind(windowRef);
    if (matchMedia?.('(pointer: coarse)')?.matches) return true;
    if (matchMedia?.('(pointer: fine)')?.matches) return false;
    return Number(navigatorRef?.maxTouchPoints) > 0;
  } catch (_) {
    return Number(navigatorRef?.maxTouchPoints) > 0;
  }
}

/** Every contextual button; the pause button is always available. */
export const TOUCH_ACTIONS = Object.freeze([
  'fire', 'ads', 'jump', 'crouch', 'reload', 'grenade', 'grenadeType', 'interact', 'weapon', 'buy', 'zoom',
]);

/**
 * Which touch buttons a gameplay context earns. Null context (menu, dead, spectating)
 * shows nothing but pause; a wheelOpen context keeps only pause while the radial
 * weapon wheel is up. Pure so the rule is contract-testable without DOM.
 */
export function visibleTouchActions(context) {
  const visible = new Set();
  if (!context || context.alive === false) return visible;
  if (context.wheelOpen) return visible; // wheel up: every chip but pause hides
  visible.add('jump');
  visible.add('crouch');
  if (context.canFire !== false) {
    visible.add('fire');
    visible.add('ads');
  }
  if (context.canReload) visible.add('reload');
  const grenadeCount = Array.isArray(context.grenades)
    ? context.grenades.reduce((sum, count) => sum + (count | 0), 0)
    : (context.grenades | 0);
  if (grenadeCount > 0 && context.canFire !== false) {
    visible.add('grenade');
    visible.add('grenadeType');
  }
  if (context.canInteract) visible.add('interact');
  if ((context.weaponCount ?? 2) > 1) visible.add('weapon');
  if (context.canBuy) visible.add('buy');
  if (context.scoped) visible.add('zoom');
  return visible;
}

function addElement(documentRef, tag, className, parent, text = '') {
  const element = documentRef.createElement(tag);
  element.className = className;
  if (text) element.textContent = text;
  parent.appendChild(element);
  return element;
}

/**
 * Owns mobile-control DOM and pointer lifecycles only. Gameplay state remains
 * inside Input through the narrow callbacks supplied by its composition root.
 *
 * Layout: the look zone is the whole screen underneath everything else, so any
 * free thumb aims. The joystick floats to wherever the left thumb lands. The fire
 * button aims while held (drag to track), a quick tap on the look zone fires once,
 * and ADS / crouch are tap-to-toggle, hold-to-hold buttons.
 */
export class TouchControls {
  constructor({
    documentRef = typeof document !== 'undefined' ? document : null,
    windowRef = typeof window !== 'undefined' ? window : null,
    navigatorRef = typeof navigator !== 'undefined' ? navigator : null,
    onMove = () => {},
    onLook = () => {},
    onHold = () => {},
    onPulse = () => {},
    onPause = () => {},
  } = {}) {
    this.document = documentRef;
    this.window = windowRef;
    this.navigator = navigatorRef;
    this.onMove = onMove;
    this.onLook = onLook;
    this.onHold = onHold;
    this.onPulse = onPulse;
    this.onPause = onPause;
    this.root = null;
    this.dom = {};
    this.enabled = false;
    this._listeners = [];
    this._movePointer = null;
    this._moveCenter = null;
    this._moveRadius = DEFAULT_RADIUS;
    this._lookPointer = null;
    this._lookPoint = null;
    this._lookStart = null;
    this._heldPointers = new Map();
    this._heldSince = new Map();
    this._latched = new Set();
    this._pulseHolds = new Map(); // deferred pulses: weapon chip press -> wheel on long hold
    this._immersiveRequested = false;
    this._context = null;
    this._hidden = new Set();
    this._options = { size: 'medium', hand: 'right' };
  }

  /** Actions currently hidden by context (contract readback). */
  get hiddenActions() { return this._hidden; }
  get options() { return { ...this._options }; }

  /**
   * Contextual visibility: buttons only exist while they can do something. A button
   * that hides mid-hold is released first so nothing stays latched behind the HUD.
   */
  setContext(context = null) {
    const next = context && typeof context === 'object' ? context : null;
    const visible = visibleTouchActions(next);
    const changed = [];
    for (const action of TOUCH_ACTIONS) {
      const hide = !visible.has(action);
      if (hide === this._hidden.has(action)) continue;
      if (hide) {
        this._hidden.add(action);
        this._releaseAction(action);
      } else {
        this._hidden.delete(action);
      }
      changed.push(action);
    }
    this._context = next;
    // The type chip names the selected throwable so the thumb knows what G will throw.
    const typeIndex = Number.isInteger(next?.grenadeType) ? next.grenadeType : 0;
    const typeLabel = GRENADE_TYPES[GRENADE_TYPE_IDS[typeIndex]]?.short || 'NADE';
    if (this.dom.grenadeType && this.dom.grenadeType.textContent !== typeLabel) {
      this.dom.grenadeType.textContent = typeLabel;
    }
    for (const action of changed) {
      const button = this.dom[action];
      if (!button) continue;
      const hide = this._hidden.has(action);
      button.classList.toggle('is-hidden', hide);
      button.setAttribute('aria-hidden', hide ? 'true' : 'false');
    }
    return changed;
  }

  /** Layout options: stick/button size and the dominant hand (mirrors the layout). */
  setOptions({ size, hand } = {}) {
    if (size === 'small' || size === 'medium' || size === 'large') this._options.size = size;
    if (hand === 'left' || hand === 'right') this._options.hand = hand;
    const root = this.root;
    if (!root) return this.options;
    root.classList.toggle('is-size-small', this._options.size === 'small');
    root.classList.toggle('is-size-large', this._options.size === 'large');
    root.classList.toggle('is-left-handed', this._options.hand === 'left');
    return this.options;
  }

  _releaseAction(action) {
    const button = this.dom[action];
    const wasHeld = this._heldPointers.has(action) || this._latched.has(action);
    this._heldPointers.delete(action);
    this._heldSince.delete(action);
    this._latched.delete(action);
    this._pulseHolds.delete(action);
    if (button) this._setPressed(button, action, false);
    if (wasHeld) this.onHold(action, false, eventTime(null));
  }

  mount(parent = this.document?.body) {
    if (this.root || !this.document || !parent) return this.root;
    const d = this.dom;
    const root = addElement(this.document, 'div', 'vb-touch-controls', parent);
    root.id = 'touch-controls';
    root.setAttribute('aria-label', 'Mobile game controls');
    root.setAttribute('aria-hidden', 'true');
    this.root = root;
    this.document.documentElement?.classList.add('vb-touch-mode');

    d.look = addElement(this.document, 'div', 'vb-touch-look-zone', root);
    d.look.id = 'touch-look-zone';
    d.look.setAttribute('aria-label', 'Drag anywhere to aim, tap to fire');
    addElement(this.document, 'span', 'vb-touch-zone-label', d.look, 'DRAG TO AIM · TAP TO FIRE');
    d.rotateHint = addElement(this.document, 'div', 'vb-touch-rotate-hint', root, 'ROTATE TO LANDSCAPE');

    d.move = addElement(this.document, 'div', 'vb-touch-move-zone', root);
    d.move.id = 'touch-move-zone';
    d.move.setAttribute('aria-label', 'Movement joystick');
    d.moveBase = addElement(this.document, 'div', 'vb-touch-stick-base', d.move);
    d.moveKnob = addElement(this.document, 'div', 'vb-touch-stick-knob', d.moveBase);
    addElement(this.document, 'span', 'vb-touch-zone-label', d.move, 'MOVE · EDGE TO SPRINT');

    d.pause = this._button(root, 'pause', 'Ⅱ', 'Pause');
    d.fire = this._button(root, 'fire', 'FIRE', 'Fire weapon; drag to aim while firing');
    d.ads = this._button(root, 'ads', 'ADS', 'Aim down sights (tap to toggle, hold to hold)');
    d.jump = this._button(root, 'jump', 'JUMP', 'Jump');
    d.crouch = this._button(root, 'crouch', 'C', 'Crouch (tap to toggle, hold to hold)');
    d.reload = this._button(root, 'reload', 'R', 'Reload');
    d.grenade = this._button(root, 'grenade', 'G', 'Hold to charge grenade, release to throw');
    d.grenadeType = this._button(root, 'grenadeType', 'NADE', 'Cycle grenade type');
    d.interact = this._button(root, 'interact', 'USE', 'Interact');
    d.weapon = this._button(root, 'weapon', 'SWAP', 'Next weapon; hold to open the weapon wheel');
    d.buy = this._button(root, 'buy', 'BUY', 'Open armory');
    d.zoom = this._button(root, 'zoom', 'ZOOM', 'Scope zoom step');

    this._bindMove();
    this._bindLook();
    this._bindHold(d.fire, 'fire', { look: true, haptic: 12 });
    this._bindHold(d.ads, 'ads', { toggle: true });
    this._bindHold(d.jump, 'jump');
    this._bindHold(d.crouch, 'crouch', { toggle: true });
    this._bindHold(d.grenade, 'grenade', { haptic: 8, releaseHaptic: 18 });
    this._bindHold(d.interact, 'interact');
    this._bindPulse(d.reload, 'reload');
    this._bindPulse(d.grenadeType, 'grenadeType');
    this._bindPulse(d.weapon, 'weapon', { holdAction: 'wheel', holdHaptic: 18 });
    this._bindPulse(d.buy, 'buy');
    this._bindPulse(d.zoom, 'zoom');
    this._bindPulse(d.pause, 'pause');
    this.setOptions(this._options);
    this.setContext(this._context);
    this._listen(root, 'contextmenu', (event) => event.preventDefault());
    this._listen(root, 'pointerdown', () => this._ensureImmersive(), { capture: true });
    return root;
  }

  _button(parent, action, text, label) {
    const button = addElement(
      this.document,
      'button',
      `vb-touch-button vb-touch-${action}`,
      parent,
      text,
    );
    button.id = `touch-${action}`;
    button.type = 'button';
    button.dataset.action = action;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', 'false');
    return button;
  }

  _listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this._listeners.push([target, type, handler, options]);
  }

  _capture(element, event) {
    try { element.setPointerCapture?.(event.pointerId); } catch (_) {}
  }

  _haptic(ms) {
    try {
      if (ms > 0 && typeof this.navigator?.vibrate === 'function') this.navigator.vibrate(ms);
    } catch (_) {}
  }

  /** Best-effort fullscreen + landscape lock from the first real gesture; never throws. */
  _ensureImmersive() {
    if (this._immersiveRequested || !this.enabled) return;
    this._immersiveRequested = true;
    const doc = this.document;
    try {
      const element = doc?.documentElement;
      if (element?.requestFullscreen && !doc.fullscreenElement) {
        const request = element.requestFullscreen({ navigationUI: 'hide' });
        if (request?.catch) request.catch(() => {});
      }
    } catch (_) {}
    try {
      const orientation = this.window?.screen?.orientation;
      const lock = orientation?.lock?.('landscape');
      if (lock?.catch) lock.catch(() => {});
    } catch (_) {}
  }

  _bindMove() {
    const zone = this.dom.move;
    const base = this.dom.moveBase;
    const update = (event) => {
      if (!this.enabled || event.pointerId !== this._movePointer || !this._moveCenter) return;
      event.preventDefault();
      const vector = joystickVector(
        event.clientX - this._moveCenter.x,
        event.clientY - this._moveCenter.y,
        this._moveRadius,
      );
      const throwPx = this._moveRadius * 0.62;
      this.dom.moveKnob.style.transform =
        `translate(${(vector.x * throwPx).toFixed(2)}px, ${(vector.y * throwPx).toFixed(2)}px)`;
      zone.classList.toggle('is-engaged', vector.magnitude > 0);
      zone.classList.toggle('is-sprinting', vector.y < -0.5 && vector.magnitude >= 0.92);
      this.onMove(vector);
    };
    const release = (event) => {
      if (event.pointerId !== this._movePointer) return;
      event.preventDefault();
      this._movePointer = null;
      this._moveCenter = null;
      this.dom.moveKnob.style.transform = 'translate(0px, 0px)';
      base.style.left = '';
      base.style.top = '';
      base.style.bottom = '';
      zone.classList.remove('is-engaged', 'is-sprinting', 'is-floating');
      this.onMove({ x: 0, y: 0, magnitude: 0 });
    };
    this._listen(zone, 'pointerdown', (event) => {
      if (!this.enabled || this._movePointer !== null) return;
      event.preventDefault();
      this._movePointer = event.pointerId;
      this._capture(zone, event);
      // Floating stick: the base re-centers under the thumb, clamped inside the zone.
      const zoneRect = zone.getBoundingClientRect();
      const baseRect = base.getBoundingClientRect();
      const half = Math.max(32, Math.min(baseRect.width, baseRect.height) * 0.5);
      const cx = clamp(event.clientX, zoneRect.left + half, zoneRect.right - half);
      const cy = clamp(event.clientY, zoneRect.top + half, zoneRect.bottom - half);
      base.style.left = `${(cx - zoneRect.left - half).toFixed(1)}px`;
      base.style.top = `${(cy - zoneRect.top - half).toFixed(1)}px`;
      base.style.bottom = 'auto';
      zone.classList.add('is-floating');
      this._moveCenter = { x: cx, y: cy };
      this._moveRadius = half;
      update(event);
    });
    this._listen(zone, 'pointermove', update);
    this._listen(zone, 'pointerup', release);
    this._listen(zone, 'pointercancel', release);
    this._listen(zone, 'lostpointercapture', release);
  }

  _bindLook() {
    const zone = this.dom.look;
    const release = (event) => {
      if (event.pointerId !== this._lookPointer) return;
      event.preventDefault();
      const start = this._lookStart;
      this._lookPointer = null;
      this._lookPoint = null;
      this._lookStart = null;
      zone.classList.remove('is-engaged');
      if (this.enabled && start && event.type === 'pointerup') {
        const travel = Math.hypot(event.clientX - start.x, event.clientY - start.y);
        if (isTapToFire(eventTime(event) - start.at, travel)) {
          this._haptic(10);
          this.onPulse('fireTap');
        }
      }
    };
    this._listen(zone, 'pointerdown', (event) => {
      if (!this.enabled || this._lookPointer !== null) return;
      event.preventDefault();
      this._lookPointer = event.pointerId;
      this._lookPoint = { x: event.clientX, y: event.clientY };
      this._lookStart = { x: event.clientX, y: event.clientY, at: eventTime(event) };
      zone.classList.add('is-engaged');
      this._capture(zone, event);
    });
    this._listen(zone, 'pointermove', (event) => {
      if (!this.enabled || event.pointerId !== this._lookPointer || !this._lookPoint) return;
      event.preventDefault();
      this._emitLook(event, this._lookPoint);
    });
    this._listen(zone, 'pointerup', release);
    this._listen(zone, 'pointercancel', release);
    this._listen(zone, 'lostpointercapture', release);
  }

  _emitLook(event, point) {
    const dx = clamp(event.clientX - point.x, -LOOK_DELTA_CLAMP_PX, LOOK_DELTA_CLAMP_PX);
    const dy = clamp(event.clientY - point.y, -LOOK_DELTA_CLAMP_PX, LOOK_DELTA_CLAMP_PX);
    point.x = event.clientX;
    point.y = event.clientY;
    if (dx !== 0 || dy !== 0) this.onLook(dx, dy);
  }

  _setPressed(button, action, held) {
    button.classList.toggle('is-held', held);
    button.classList.toggle('is-latched', this._latched.has(action));
    button.setAttribute('aria-pressed', held ? 'true' : 'false');
  }

  /**
   * Hold button. `toggle` buttons latch on a quick tap and release on the next tap;
   * `look` buttons forward drag deltas so you can track a target while firing.
   */
  _bindHold(button, action, { toggle = false, look = false, haptic = 0, releaseHaptic = 0 } = {}) {
    let lookPoint = null;
    const release = (event) => {
      if (this._heldPointers.get(action) !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      this._heldPointers.delete(action);
      lookPoint = null;
      const heldMs = eventTime(event) - (this._heldSince.get(action) ?? eventTime(event));
      this._heldSince.delete(action);
      if (toggle && event.type === 'pointerup') {
        const wasLatched = this._latched.has(action);
        this._latched.delete(action);
        const stillHeld = resolveToggleRelease(heldMs, wasLatched);
        if (stillHeld) this._latched.add(action);
        this._setPressed(button, action, stillHeld);
        if (!stillHeld) this.onHold(action, false, eventTime(event));
        return;
      }
      this._latched.delete(action);
      this._setPressed(button, action, false);
      if (releaseHaptic) this._haptic(releaseHaptic);
      this.onHold(action, false, eventTime(event));
    };
    this._listen(button, 'pointerdown', (event) => {
      if (!this.enabled || this._hidden.has(action) || this._heldPointers.has(action)) return;
      event.preventDefault();
      event.stopPropagation();
      this._heldPointers.set(action, event.pointerId);
      this._heldSince.set(action, eventTime(event));
      this._capture(button, event);
      if (look) lookPoint = { x: event.clientX, y: event.clientY };
      if (this._latched.has(action)) {
        // Second tap on a latched toggle: the release handler turns it off.
        this._setPressed(button, action, true);
        return;
      }
      this._setPressed(button, action, true);
      if (haptic) this._haptic(haptic);
      this.onHold(action, true, eventTime(event));
    });
    if (look) {
      this._listen(button, 'pointermove', (event) => {
        if (!this.enabled || this._heldPointers.get(action) !== event.pointerId || !lookPoint) return;
        event.preventDefault();
        this._emitLook(event, lookPoint);
      });
    }
    this._listen(button, 'pointerup', release);
    this._listen(button, 'pointercancel', release);
    this._listen(button, 'lostpointercapture', release);
  }

  /**
   * Pulse button: acts once per press. A press on a `holdAction` chip defers the
   * pulse to the release: held past WHEEL_TOUCH_HOLD_MS it pulses `holdAction`
   * instead (the weapon chip: a quick tap swaps weapons, a long press opens the
   * radial wheel). Interrupted presses (cancel, capture loss) never pulse.
   */
  _bindPulse(button, action, { holdAction = null, holdHaptic = 0 } = {}) {
    this._listen(button, 'pointerdown', (event) => {
      if (!this.enabled || this._hidden.has(action)) return;
      if (holdAction && this._pulseHolds.has(action)) return;
      event.preventDefault();
      event.stopPropagation();
      button.classList.add('is-held');
      this._capture(button, event);
      if (holdAction) this._pulseHolds.set(action, { id: event.pointerId, at: eventTime(event) });
      this._haptic(6);
      if (action === 'pause') this.onPause();
      else if (!holdAction) this.onPulse(action);
    });
    const release = (event) => {
      const hold = this._pulseHolds.get(action);
      if (holdAction && (!hold || hold.id !== event.pointerId)) return;
      event.preventDefault();
      event.stopPropagation();
      button.classList.remove('is-held');
      if (!holdAction) return;
      this._pulseHolds.delete(action);
      if (event.type !== 'pointerup') return; // cancelled or capture lost: no pulse
      if (isWheelTouchHold(eventTime(event) - hold.at)) {
        if (holdHaptic) this._haptic(holdHaptic);
        this.onPulse(holdAction);
      } else {
        this.onPulse(action);
      }
    };
    this._listen(button, 'pointerup', release);
    this._listen(button, 'pointercancel', release);
    this._listen(button, 'lostpointercapture', release);
  }

  setEnabled(enabled) {
    const next = !!enabled;
    if (next === this.enabled) return;
    this.enabled = next;
    this.root?.classList.toggle('is-active', next);
    this.root?.setAttribute('aria-hidden', next ? 'false' : 'true');
    if (!next) this.reset(true);
  }

  reset(notify = true) {
    if (notify) {
      this.onMove({ x: 0, y: 0, magnitude: 0 });
      const released = new Set([...this._heldPointers.keys(), ...this._latched]);
      for (const action of released) this.onHold(action, false, eventTime(null));
    }
    this._movePointer = null;
    this._moveCenter = null;
    this._lookPointer = null;
    this._lookPoint = null;
    this._lookStart = null;
    this._heldPointers.clear();
    this._heldSince.clear();
    this._latched.clear();
    this._pulseHolds.clear();
    if (this.dom.moveKnob) this.dom.moveKnob.style.transform = 'translate(0px, 0px)';
    if (this.dom.moveBase) {
      this.dom.moveBase.style.left = '';
      this.dom.moveBase.style.top = '';
      this.dom.moveBase.style.bottom = '';
    }
    this.dom.move?.classList.remove('is-engaged', 'is-sprinting', 'is-floating');
    this.dom.look?.classList.remove('is-engaged');
    for (const button of this.root?.querySelectorAll?.('.vb-touch-button') || []) {
      button.classList.remove('is-held', 'is-latched');
      button.setAttribute('aria-pressed', 'false');
    }
  }

  dispose() {
    this.setEnabled(false);
    for (const [target, type, handler, options] of this._listeners) {
      target.removeEventListener(type, handler, options);
    }
    this._listeners.length = 0;
    this.root?.remove();
    this.document?.documentElement?.classList.remove('vb-touch-mode');
    this.root = null;
    this.dom = {};
  }
}
