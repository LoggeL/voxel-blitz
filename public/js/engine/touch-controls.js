import { GRENADE_TYPE_IDS, GRENADE_POWER_STEPS } from '../../../shared/grenade-rules.js';

const DEFAULT_RADIUS = 54;
const DEFAULT_DEAD_ZONE = 0.14;
/** Quick press/release on a toggle button latches it instead of acting as a hold. */
export const TOUCH_TOGGLE_TAP_MS = 260;
const LOOK_DELTA_CLAMP_PX = 90;
/** Slop around the PIN BACK chip so a lift at its edge still cancels. */
const PIN_BACK_SLOP_PX = 10;
/** A look-zone lift within this travel counts as a tap (closes the open pouch). */
const TAP_TRAVEL_PX = 12;

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
 * Toggle-button policy for ADS: a quick tap latches the action on
 * until the next tap; a long press behaves like a hold and releases with the finger.
 * Returns the held state the button should report after the release.
 */
export function resolveToggleRelease(heldMs, wasLatched) {
  if (wasLatched) return false;
  return Number(heldMs) < TOUCH_TOGGLE_TAP_MS;
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
  'fire', 'ads', 'jump', 'reload', 'interact', 'weapon', 'buy', 'medkit', 'build',
  'grenade', 'pouch',
]);

/**
 * Which touch buttons a gameplay context earns. Null context (menu, dead, spectating)
 * shows nothing but pause; a wheelOpen or pouchOpen context keeps only pause while a
 * radial is up (the grenade pouch draws its own slots). Pure so the rule is
 * contract-testable without DOM.
 */
export function visibleTouchActions(context) {
  const visible = new Set();
  if (!context || context.alive === false) return visible;
  if (context.wheelOpen || context.pouchOpen) return visible; // radial up: every chip but pause hides
  visible.add('jump');
  if (context.canFire !== false) {
    visible.add('fire');
    visible.add('ads');
  }
  if (context.canReload) visible.add('reload');
  if (context.canMedkit) visible.add('medkit');
  if (context.canInteract) visible.add('interact');
  if ((context.weaponCount ?? 2) > 1) visible.add('weapon');
  if (context.canBuy) visible.add('buy');
  if (context.canBuild) visible.add('build');
  if (context.canThrow && Number(context.grenadeTotal) > 0) {
    visible.add('grenade');
    visible.add('pouch');
  }
  return visible;
}

/** Face of the grenade button: the ready type id and its count, or nulls when none is ready. */
export function touchGrenadeFace(context) {
  const index = Number.isInteger(context?.grenadeReady) ? context.grenadeReady : -1;
  const type = GRENADE_TYPE_IDS[index] ?? null;
  const count = type && Array.isArray(context?.grenadeCounts)
    ? Math.max(0, Number(context.grenadeCounts[index]) || 0)
    : null;
  return Object.freeze({ type, count });
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
 * button aims while held (drag to track). ADS supports tap-to-toggle or holding.
 * Each pulse button has one action; there are no hidden long-press actions.
 */
export class TouchControls {
  constructor({
    documentRef = typeof document !== 'undefined' ? document : null,
    onMove = () => {},
    onLook = () => {},
    onHold = () => {},
    onPulse = () => {},
    onPause = () => {},
  } = {}) {
    this.document = documentRef;
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
    this._heldPointers = new Map();
    this._heldSince = new Map();
    this._latched = new Set();
    this._pulsePointers = new Map();
    this._pinBackArmed = false;
    this._powerIndex = -1;
    this._lookTap = null;
    this._context = null;
    this._hidden = new Set();
    this._options = { size: 'medium', hand: 'right' };
  }

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
    for (const action of changed) {
      const button = this.dom[action];
      if (!button) continue;
      const hide = this._hidden.has(action);
      button.classList.toggle('is-hidden', hide);
      button.setAttribute('aria-hidden', hide ? 'true' : 'false');
    }
    this._paintGrenade(next);
    return changed;
  }

  /** Ready type icon (CSS keyed on data-type) and count, plus the lit power stop. */
  _paintGrenade(context) {
    const button = this.dom.grenade;
    if (!button) return;
    const face = touchGrenadeFace(context);
    const type = face.type || 'none';
    if (button.dataset.type !== type) button.dataset.type = type;
    const count = face.count === null ? '' : `×${face.count}`;
    if (this.dom.grenadeCount && this.dom.grenadeCount.textContent !== count) {
      this.dom.grenadeCount.textContent = count;
    }
    const authoritative = Number.isInteger(context?.grenadePowerIndex) ? context.grenadePowerIndex : null;
    this._paintPower(authoritative ?? this._powerIndex);
  }

  _paintPower(index) {
    for (const [i, chip] of (this.dom.grenadePowerChips || []).entries()) {
      chip.classList.toggle('is-selected', i === index);
    }
  }

  /** Touch pick from the grenade pouch radial (its controller owns the slot DOM). */
  pickPouchSlot(index) {
    if (!this.enabled || !Number.isInteger(index) || index < 0 || index >= GRENADE_TYPE_IDS.length) return;
    this.onPulse(`pouchSlot:${index}`);
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
    this._pulsePointers.delete(action);
    if (button) this._setPressed(button, action, false);
    if (action === 'grenade') this._endGrenadeHold();
    // A grenade whose button vanishes mid-hold is pinned back, never thrown blind.
    if (wasHeld && action === 'grenade') this.onPulse('grenadeCancel');
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
    d.look.setAttribute('aria-label', 'Drag to aim');

    d.move = addElement(this.document, 'div', 'vb-touch-move-zone', root);
    d.move.id = 'touch-move-zone';
    d.move.setAttribute('aria-label', 'Movement joystick');
    d.moveBase = addElement(this.document, 'div', 'vb-touch-stick-base', d.move);
    d.moveKnob = addElement(this.document, 'div', 'vb-touch-stick-knob', d.moveBase);

    d.pause = this._button(root, 'pause', 'Ⅱ', 'Pause');
    d.fire = this._button(root, 'fire', 'FIRE', 'Fire weapon; drag to aim while firing');
    d.ads = this._button(root, 'ads', 'AIM', 'Aim down sights (tap to toggle, hold to hold)');
    d.jump = this._button(root, 'jump', 'JUMP', 'Jump');
    d.reload = this._button(root, 'reload', 'LOAD', 'Reload');
    d.medkit = this._button(root, 'medkit', 'HEAL', 'Use medkit or cancel healing');
    d.interact = this._button(root, 'interact', 'USE', 'Interact');
    d.weapon = this._button(root, 'weapon', '⇄', 'Next weapon');
    d.buy = this._button(root, 'buy', 'BUY', 'Open armory');
    d.build = this._button(root, 'build', 'BUILD', 'Cycle build blueprint (Bastion)');
    d.grenade = this._button(root, 'grenade', '',
      'Throw ready grenade (tap to throw, hold to aim, lift to throw)');
    d.grenade.dataset.type = 'none';
    d.grenadeIcon = addElement(this.document, 'span', 'vb-touch-grenade-icon', d.grenade);
    d.grenadeIcon.setAttribute('aria-hidden', 'true');
    d.grenadeCount = addElement(this.document, 'span', 'vb-touch-grenade-count', d.grenade);
    d.pouch = this._button(root, 'pouch', '', 'Open grenade pouch');
    addElement(this.document, 'span', 'vb-touch-pouch-bag', d.pouch).setAttribute('aria-hidden', 'true');
    // Held-grenade overlay: the other thumb taps a power stop; the grenade thumb
    // slides onto PIN BACK and lifts to cancel. Both only show while the hold lasts.
    d.grenadePower = addElement(this.document, 'div', 'vb-touch-grenade-power', root);
    d.grenadePower.id = 'touch-grenade-power';
    d.grenadePower.setAttribute('aria-label', 'Grenade throw power');
    d.grenadePowerChips = [];
    for (let i = GRENADE_POWER_STEPS.length - 1; i >= 0; i--) {
      const label = i === 0 ? 'LOB' : `${Math.round(GRENADE_POWER_STEPS[i] * 100)}`;
      const chip = addElement(this.document, 'button', 'vb-touch-grenade-power-chip', d.grenadePower, label);
      chip.type = 'button';
      chip.dataset.power = String(i);
      chip.setAttribute('aria-label', `Throw power ${label}`);
      d.grenadePowerChips[i] = chip;
    }
    d.pinBack = addElement(this.document, 'div', 'vb-touch-pin-back', root, 'PIN BACK');
    d.pinBack.id = 'touch-pin-back';
    d.pinBack.setAttribute('aria-hidden', 'true');

    this._bindMove();
    this._bindLook();
    this._bindHold(d.fire, 'fire', { look: true });
    this._bindHold(d.ads, 'ads', { toggle: true });
    this._bindHold(d.jump, 'jump');
    this._bindHold(d.interact, 'interact');
    this._bindPulse(d.reload, 'reload');
    this._bindPulse(d.medkit, 'medkit');
    this._bindPulse(d.weapon, 'weapon');
    this._bindPulse(d.buy, 'buy');
    this._bindPulse(d.build, 'build');
    this._bindPulse(d.pouch, 'pouch');
    this._bindGrenade(d.grenade);
    d.grenadePowerChips.forEach((chip, i) => this._bindPowerChip(chip, i));
    this._bindPulse(d.pause, 'pause');
    this.setOptions(this._options);
    this.setContext(this._context);
    this._listen(root, 'contextmenu', (event) => event.preventDefault());
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
      const tap = this._lookTap;
      this._lookPointer = null;
      this._lookPoint = null;
      this._lookTap = null;
      zone.classList.remove('is-engaged');
      // Tapping outside the open pouch closes it (the 'pouch' pulse toggles it).
      if (tap && event.type === 'pointerup' && this.enabled && this._context?.pouchOpen
          && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) <= TAP_TRAVEL_PX) {
        this.onPulse('pouch');
      }
    };
    this._listen(zone, 'pointerdown', (event) => {
      if (!this.enabled || this._lookPointer !== null) return;
      event.preventDefault();
      this._lookPointer = event.pointerId;
      this._lookPoint = { x: event.clientX, y: event.clientY };
      this._lookTap = this._context?.pouchOpen ? { x: event.clientX, y: event.clientY } : null;
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
  _bindHold(button, action, { toggle = false, look = false } = {}) {
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
   * Grenade button: press begins the hold (Input tells a tap from a hold by time),
   * lift throws. Drag aims like fire; lifting over the PIN BACK chip cancels instead.
   * A cancelled pointer (system gesture, lost capture) pins back rather than throwing.
   */
  _bindGrenade(button) {
    const action = 'grenade';
    let lookPoint = null;
    const release = (event) => {
      if (this._heldPointers.get(action) !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      const pinBack = event.type !== 'pointerup' || this._overPinBack(event);
      this._heldPointers.delete(action);
      this._heldSince.delete(action);
      lookPoint = null;
      this._setPressed(button, action, false);
      this._endGrenadeHold();
      // Cancel first so the release that follows has nothing left to throw.
      if (pinBack) this.onPulse('grenadeCancel');
      this.onHold(action, false, eventTime(event));
    };
    this._listen(button, 'pointerdown', (event) => {
      if (!this.enabled || this._hidden.has(action) || this._heldPointers.has(action)) return;
      event.preventDefault();
      event.stopPropagation();
      this._heldPointers.set(action, event.pointerId);
      this._heldSince.set(action, eventTime(event));
      this._capture(button, event);
      lookPoint = { x: event.clientX, y: event.clientY };
      this._setPressed(button, action, true);
      this.root?.classList.add('is-grenade-held');
      // Input refused the hold (cooldown, empty, build): no strip, no PIN BACK, no power taps.
      if (this.onHold(action, true, eventTime(event)) === false) {
        this._heldPointers.delete(action);
        this._heldSince.delete(action);
        lookPoint = null;
        this._setPressed(button, action, false);
        this._endGrenadeHold();
      }
    });
    this._listen(button, 'pointermove', (event) => {
      if (!this.enabled || this._heldPointers.get(action) !== event.pointerId || !lookPoint) return;
      event.preventDefault();
      const armed = this._overPinBack(event);
      if (armed !== this._pinBackArmed) {
        this._pinBackArmed = armed;
        this.dom.pinBack?.classList.toggle('is-armed', armed);
      }
      // Parked on PIN BACK: stop turning the camera while the thumb decides.
      if (armed) {
        lookPoint.x = event.clientX;
        lookPoint.y = event.clientY;
        return;
      }
      this._emitLook(event, lookPoint);
    });
    this._listen(button, 'pointerup', release);
    this._listen(button, 'pointercancel', release);
    this._listen(button, 'lostpointercapture', release);
  }

  _overPinBack(event) {
    const rect = this.dom.pinBack?.getBoundingClientRect?.();
    if (!rect || !(rect.width > 0 && rect.height > 0)) return false;
    return event.clientX >= rect.left - PIN_BACK_SLOP_PX && event.clientX <= rect.right + PIN_BACK_SLOP_PX
      && event.clientY >= rect.top - PIN_BACK_SLOP_PX && event.clientY <= rect.bottom + PIN_BACK_SLOP_PX;
  }

  _endGrenadeHold() {
    this._pinBackArmed = false;
    this._powerIndex = -1;
    this.root?.classList.remove('is-grenade-held');
    this.dom.pinBack?.classList.remove('is-armed');
    for (const chip of this.dom.grenadePowerChips || []) chip.classList.remove('is-held');
    this._paintGrenade(this._context);
  }

  /** Power stop: a tap by the free thumb while a grenade is held; no drag-to-dial. */
  _bindPowerChip(chip, index) {
    const key = `grenadePower:${index}`;
    this._listen(chip, 'pointerdown', (event) => {
      if (!this.enabled || !this._heldPointers.has('grenade') || this._pulsePointers.has(key)) return;
      event.preventDefault();
      event.stopPropagation();
      this._pulsePointers.set(key, event.pointerId);
      chip.classList.add('is-held');
      this._capture(chip, event);
    });
    const release = (event) => {
      if (this._pulsePointers.get(key) !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      this._pulsePointers.delete(key);
      chip.classList.remove('is-held');
      if (!this.enabled || !this._heldPointers.has('grenade') || event.type !== 'pointerup') return;
      this._powerIndex = index;
      this._paintGrenade(this._context);
      this.onPulse(key);
    };
    this._listen(chip, 'pointerup', release);
    this._listen(chip, 'pointercancel', release);
    this._listen(chip, 'lostpointercapture', release);
  }

  /** One action on release. Cancelled or hidden presses never activate. */
  _bindPulse(button, action) {
    this._listen(button, 'pointerdown', (event) => {
      if (!this.enabled || this._hidden.has(action) || this._pulsePointers.has(action)) return;
      event.preventDefault();
      event.stopPropagation();
      this._pulsePointers.set(action, event.pointerId);
      this._setPressed(button, action, true);
      this._capture(button, event);
    });
    const release = (event) => {
      if (this._pulsePointers.get(action) !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      this._pulsePointers.delete(action);
      this._setPressed(button, action, false);
      if (!this.enabled || this._hidden.has(action) || event.type !== 'pointerup') return;
      if (action === 'pause') this.onPause();
      else this.onPulse(action);
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
      if (released.has('grenade')) this.onPulse('grenadeCancel');
      for (const action of released) this.onHold(action, false, eventTime(null));
    }
    this._lookTap = null;
    this._endGrenadeHold();
    this._movePointer = null;
    this._moveCenter = null;
    this._lookPointer = null;
    this._lookPoint = null;
    this._heldPointers.clear();
    this._heldSince.clear();
    this._latched.clear();
    this._pulsePointers.clear();
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
