// Gamepad reading for the first-person input manager. GamepadInput polls
// navigator.getGamepads() once per frame and emits a
// normalized frame (sticks, held buttons, and button edges) using the standard mapping.

export const PAD_DEADZONE = Object.freeze({ move: 0.18, look: 0.12 });
/** Response exponent for the look stick: fine control near centre, fast at the rim. */
export const PAD_LOOK_EXPO = 1.75;
/** Milliseconds after the last real pad input during which the pad counts as active. */
export const PAD_ACTIVE_MS = 2500;
const TRIGGER_THRESHOLD = 0.45;

/** Standard-mapping button indexes -> gameplay actions. */
export const PAD_BUTTONS = Object.freeze({
  jump: 0,          // A / Cross
  crouch: 1,        // B / Circle (tap toggles, hold holds)
  reload: 2,        // X / Square
  weapon: 3,        // Y / Triangle: tap next weapon, hold for the weapon wheel (weapons only)
  lastWeapon: 4,    // LB / L1
  grenade: 5,       // RB / R1: tap quick-throws, hold aims, release throws
  ads: 6,           // LT / L2
  fire: 7,          // RT / R2
  scoreboard: 8,    // Back / Select
  pause: 9,         // Start / Options
  sprint: 10,       // L3
  zoom: 11,         // R3: scope zoom step
  slotUp: 12,       // D-pad up (grenade power up while RB is held)
  grenadePouch: 13, // D-pad down: tap next grenade, hold for the pouch (power down while RB is held)
  interact: 14,     // D-pad left (hold)
  buy: 15,          // D-pad right
});

const ACTIONS = Object.keys(PAD_BUTTONS);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Radial dead zone plus power curve. Returns unit-range x/y and the shaped magnitude.
 * Movement uses expo 1 (linear after the dead zone); look uses PAD_LOOK_EXPO.
 */
export function stickCurve(x, y, deadZone, expo = 1) {
  const rawX = Number(x) || 0;
  const rawY = Number(y) || 0;
  const dead = clamp(Number(deadZone) || 0, 0, 0.9);
  const distance = Math.hypot(rawX, rawY);
  if (distance <= dead) return { x: 0, y: 0, magnitude: 0 };
  const linear = clamp((Math.min(1, distance) - dead) / (1 - dead), 0, 1);
  const magnitude = Math.pow(linear, Math.max(1, Number(expo) || 1));
  const scale = magnitude / distance;
  return { x: rawX * scale, y: rawY * scale, magnitude };
}

function buttonPressed(button) {
  if (!button) return false;
  if (typeof button === 'number') return button >= TRIGGER_THRESHOLD;
  if (button.pressed) return true;
  return Number(button.value) >= TRIGGER_THRESHOLD;
}

function usablePad(pad) {
  return pad && pad.connected !== false && (pad.mapping === 'standard' || !pad.mapping);
}

/**
 * Normalize one raw Gamepad into `{move, look, held, pressed, released, any}`; `prev`
 * is the previous frame's `held` map so edges are computed here, not by the consumer.
 */
export function readGamepadFrame(pad, prev = null) {
  const axes = Array.isArray(pad?.axes) ? pad.axes : (pad?.axes ? Array.from(pad.axes) : []);
  const buttons = pad?.buttons || [];
  const move = stickCurve(axes[0], axes[1], PAD_DEADZONE.move, 1);
  const look = stickCurve(axes[2], axes[3], PAD_DEADZONE.look, PAD_LOOK_EXPO);
  const held = {};
  const pressed = {};
  const released = {};
  let any = move.magnitude > 0 || look.magnitude > 0;
  for (let i = 0; i < ACTIONS.length; i++) {
    const action = ACTIONS[i];
    const down = buttonPressed(buttons[PAD_BUTTONS[action]]);
    const was = !!(prev && prev[action]);
    held[action] = down;
    pressed[action] = down && !was;
    released[action] = !down && was;
    if (down) any = true;
  }
  return { move, look, held, pressed, released, any };
}

/** Polls the first connected standard-mapping pad. Safe to construct without a navigator. */
export class GamepadInput {
  constructor({ navigatorRef = typeof navigator !== 'undefined' ? navigator : null } = {}) {
    this.navigator = navigatorRef;
    this._held = null;
    this._activeUntil = -Infinity;
    this._padIndex = null;
    this._padId = null;
    this._rearmOnConnect = false;
    this._blocked = null;
  }

  /** True when a pad produced input recently (used to route aim assist and hints). */
  isActive(now) {
    return now < this._activeUntil;
  }

  _firstPad() {
    try {
      const list = this.navigator?.getGamepads?.();
      if (!list) return null;
      // Keep the selected pad when another one connects in an earlier slot.
      const selected = this._padIndex === null ? null : list[this._padIndex];
      if (usablePad(selected) && (selected.id || '') === this._padId) {
        return { pad: selected, index: this._padIndex };
      }
      for (let i = 0; i < list.length; i++) {
        const pad = list[i];
        if (usablePad(pad)) return { pad, index: i };
      }
    } catch (_) {}
    return null;
  }

  /** Read the pad once; returns the normalized frame, or null when no pad is present. */
  poll(now) {
    const selected = this._firstPad();
    const changed = selected && this._padIndex !== null
      && (selected.index !== this._padIndex || (selected.pad.id || '') !== this._padId);
    if (!selected || changed) {
      this._activeUntil = -Infinity;
      this._padIndex = null;
      this._padId = null;
      if (this._held) {
        // Cancel the old pad before adopting a replacement. Its synthetic releases
        // must never be mistaken for a deliberate grenade throw or weapon tap.
        const frame = readGamepadFrame({ axes: [], buttons: [] }, this._held);
        frame.connected = false;
        this._held = null;
        this._rearmOnConnect = true;
        this._blocked = null;
        return frame;
      }
      return null;
    }
    this._padIndex = selected.index;
    this._padId = selected.pad.id || '';
    const frame = readGamepadFrame(selected.pad, this._held);
    if (this._rearmOnConnect) {
      // Adopting a pad with a button already down is not a fresh press. Each
      // blocked button rearms independently once it physically releases.
      this._blocked = { ...frame.held };
      this._rearmOnConnect = false;
    }
    if (this._blocked) {
      frame.any = frame.move.magnitude > 0 || frame.look.magnitude > 0;
      let blocking = false;
      for (const action of ACTIONS) {
        if (this._blocked[action]) {
          if (!frame.held[action]) this._blocked[action] = false;
          else blocking = true;
          frame.held[action] = frame.pressed[action] = frame.released[action] = false;
        }
        if (frame.held[action]) frame.any = true;
      }
      if (!blocking) this._blocked = null;
    }
    this._held = frame.held;
    if (frame.any) this._activeUntil = now + PAD_ACTIVE_MS;
    return frame;
  }

  reset() {
    this._held = null;
    this._activeUntil = -Infinity;
    this._padIndex = null;
    this._padId = null;
    this._rearmOnConnect = false;
    this._blocked = null;
  }
}
