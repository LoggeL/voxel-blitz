/**
 * Pilot control hint: the first few times a desktop player takes an aircraft's
 * pilot seat, a small pill at the bottom centre names the controls of the
 * active flight mode ("MOUSE AIM · W S THROTTLE · A D ROLL · CTRL AIRBRAKE")
 * for FLIGHT_HINT.showMs. Entries are counted per aircraft type and mode in
 * localStorage. Design reference: docs/design/conquest/flight/flight-hud-a-reference.jpg.
 */
import { el } from '../hud-support.js';
import { readKeybindings, keyCodeLabel } from '../../keybindings.js';

export const FLIGHT_HINT = Object.freeze({ showMs: 9000, times: 3, prefKey: 'vb-flight-hint-v1' });

const SHORT = Object.freeze({ 'LEFT SHIFT': 'SHIFT', 'RIGHT SHIFT': 'SHIFT', 'LEFT CTRL': 'CTRL', 'RIGHT CTRL': 'CTRL', 'LEFT ALT': 'ALT', 'RIGHT ALT': 'ALT' });

/** First bound key of an action as a short cap label ("W", "SPACE", "SHIFT"). */
function cap(action, bindings) {
  const code = bindings?.[action]?.[0];
  if (!code) return '?';
  const label = keyCodeLabel(code);
  return SHORT[label] ?? label;
}

/**
 * Hint items for an aircraft type and flight mode ('aim' | 'mouse' |
 * 'keyboard'): [{ keys: [cap...] | null, text }]. `keys` null is a plain word.
 */
export function flightHintItems(type, mode, bindings = readKeybindings()) {
  const k = action => cap(action, bindings);
  const jet = type === 'plane';
  if (mode === 'aim') {
    return jet ? [
      { keys: null, text: 'MOUSE AIM' }, { keys: [k('forward'), k('back')], text: 'THROTTLE' },
      { keys: [k('left'), k('right')], text: 'ROLL' }, { keys: [k('crouch')], text: 'AIRBRAKE' },
    ] : [
      { keys: null, text: 'MOUSE AIM' }, { keys: [k('jump'), k('sprint')], text: 'UP / DOWN' },
      { keys: [k('forward'), k('left'), k('back'), k('right')], text: 'MOVE' }, { keys: null, text: 'RELEASE = HOVER' },
    ];
  }
  if (mode === 'mouse') {
    return jet ? [
      { keys: null, text: 'MOUSE STICK' }, { keys: [k('forward'), k('back')], text: 'THROTTLE' },
      { keys: [k('left'), k('right')], text: 'RUDDER' }, { keys: [k('crouch')], text: 'AIRBRAKE' },
    ] : [
      { keys: null, text: 'MOUSE STICK' }, { keys: [k('forward'), k('back')], text: 'UP / DOWN' },
      { keys: [k('left'), k('right')], text: 'STRAFE' },
    ];
  }
  return jet ? [
    { keys: [k('forward'), k('back')], text: 'THROTTLE' }, { keys: [k('left'), k('right')], text: 'BANK' },
    { keys: null, text: 'MOUSE PITCH' }, { keys: [k('crouch')], text: 'AIRBRAKE' },
  ] : [
    { keys: [k('jump'), k('sprint')], text: 'UP / DOWN' }, { keys: [k('forward'), k('left'), k('back'), k('right')], text: 'MOVE' },
    { keys: [k('leanLeft'), k('leanRight')], text: 'YAW' }, { keys: null, text: 'RELEASE = HOVER' },
  ];
}

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch (_) { return null; }
}

export class FlightHint {
  constructor(parent, { storage = undefined, times = FLIGHT_HINT.times, showMs = FLIGHT_HINT.showMs } = {}) {
    this.root = el('div', 'cq-flight-hint', parent);
    this.root.hidden = true;
    this.root.setAttribute('role', 'note');
    this.storage = storage === undefined ? defaultStorage() : storage;
    this.times = times; this.showMs = showMs;
    this._seatKey = null;
    this._until = -Infinity;
    this._sig = '';
  }

  _counts() {
    try {
      const parsed = JSON.parse(this.storage?.getItem?.(FLIGHT_HINT.prefKey) ?? 'null');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) { return {}; }
  }

  /** Count one pilot-seat entry; true while this type/mode still gets its hint. */
  _claim(countKey) {
    const counts = this._counts();
    const seen = Number.isFinite(counts[countKey]) ? counts[countKey] : 0;
    if (seen >= this.times) return false;
    try { this.storage?.setItem?.(FLIGHT_HINT.prefKey, JSON.stringify({ ...counts, [countKey]: seen + 1 })); } catch (_) {}
    return true;
  }

  /**
   * pilot: { type, vehicleId, mode } while this player flies an aircraft
   * (desktop only), else null. nowMs drives the display window.
   */
  update(pilot, nowMs = 0) {
    const seatKey = pilot ? `${pilot.vehicleId}:${pilot.type}` : null;
    if (seatKey !== this._seatKey) {
      this._seatKey = seatKey;
      this._until = pilot && this._claim(`${pilot.type}:${pilot.mode}`) ? nowMs + this.showMs : -Infinity;
    }
    if (!pilot || nowMs > this._until) {
      if (!this.root.hidden) this.root.hidden = true;
      return;
    }
    this.root.hidden = false;
    this.root.dataset.fading = String(this._until - nowMs < 600);
    const items = flightHintItems(pilot.type, pilot.mode);
    const sig = JSON.stringify(items);
    if (sig === this._sig) return;
    this._sig = sig;
    this.root.replaceChildren(...items.map((item, index) => {
      const part = el('span', 'cq-flight-hint-item');
      if (index) part.dataset.sep = 'true';
      for (const key of item.keys ?? []) el('kbd', 'cq-flight-hint-key', part).textContent = key;
      el('span', 'cq-flight-hint-text', part).textContent = item.text;
      return part;
    }));
    this.root.setAttribute('aria-label', items.map(item => [...(item.keys ?? []), item.text].join(' ')).join(', '));
  }
}
