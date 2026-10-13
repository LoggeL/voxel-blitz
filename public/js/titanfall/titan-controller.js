/**
 * Titanfall titan keys (docs/titanfall.md §8.2; WP6): the `titan` key context.
 * While the local pilot sits in its own titan, a capture-phase window listener
 * consumes the titan actions with preventDefault (Input and VehicleController
 * never see Space/Q/E/G/V/C/X/F/H there) and turns them into intents:
 *
 *   titanDash (Space)       dash: seated input first, then ability 'dash' (WP2 send order)
 *   titanDefensive (Q)      ability 'def' on press; titanHold bit 2 while held
 *   titanTactical (E)       ability 'tac'
 *   titanOrdnance (G)       ability 'ord'
 *   titanCore (V)           ability 'core'; titanHold bit 32 while held
 *   titanSmoke (C)          ability 'smoke'
 *   titanEject (X)          eject after three taps within EJECT_TAP_WINDOW_MS, only while doomed
 *   titanMelee (F)          ability 'melee'; titanHold bit 16 while held
 *   titanView (H)           cockpit / chase camera
 */
import { isTypingTarget, matchesBinding } from '../keybindings.js';

export const TITAN_KEY_ACTIONS = Object.freeze(['titanDash', 'titanDefensive', 'titanTactical', 'titanOrdnance', 'titanCore',
  'titanSmoke', 'titanEject', 'titanMelee', 'titanView']);
/** titanHold bits (§3.6). */
export const TITAN_HOLD = Object.freeze({ sprint: 1, defensive: 2, ads: 4, reload: 8, melee: 16, core: 32 });
export const EJECT_TAPS = 3;
export const EJECT_TAP_WINDOW_MS = 800;
const HELD = Object.freeze({ titanDefensive: TITAN_HOLD.defensive, titanMelee: TITAN_HOLD.melee, titanCore: TITAN_HOLD.core });

/**
 * Eject triple-tap counter: `tap(now, doomed)` returns true on the tap that
 * completes the triple within the window; taps while not doomed never count.
 */
export function createEjectTaps({ taps = EJECT_TAPS, windowMs = EJECT_TAP_WINDOW_MS } = {}) {
  let times = [];
  return {
    tap(now, doomed) {
      if (!doomed) { times = []; return false; }
      times = times.filter(at => now - at <= windowMs);
      times.push(now);
      if (times.length < taps) return false;
      times = [];
      return true;
    },
    count(now) { return times.filter(at => now - at <= windowMs).length; },
    reset() { times = []; },
  };
}

/**
 * `active()`: true while seated in the own titan with gameplay input enabled.
 * `onAction(action, down)`: every titan action on press (down true) and the
 * held ones on release (down false). Returns { held(), dispose(), handle }.
 */
export function createTitanController({ target = typeof window !== 'undefined' ? window : null, active = () => false,
  onAction = () => {} } = {}) {
  const down = new Set();
  const actionOf = event => TITAN_KEY_ACTIONS.find(action => matchesBinding(event, action)) ?? null;
  const keyDown = event => {
    if (event.defaultPrevented || isTypingTarget(event.target) || !active()) return;
    const action = actionOf(event);
    if (!action) return;
    event.preventDefault();
    if (event.repeat) return;
    down.add(action);
    onAction(action, true);
  };
  const keyUp = event => {
    const action = actionOf(event);
    if (!action || !down.has(action)) return;
    down.delete(action);
    event.preventDefault();
    if (HELD[action]) onAction(action, false);
  };
  const blur = () => {
    for (const action of down) if (HELD[action]) onAction(action, false);
    down.clear();
  };
  target?.addEventListener('keydown', keyDown, true);
  target?.addEventListener('keyup', keyUp, true);
  target?.addEventListener('blur', blur);
  let disposed = false;
  return {
    handle: keyDown,
    release: keyUp,
    /** titanHold bits of the held titan keys (defensive, melee, core). */
    held() {
      if (!active()) { if (down.size) blur(); return 0; }
      let bits = 0;
      for (const action of down) bits |= HELD[action] ?? 0;
      return bits;
    },
    /** Touch: press or release one titan action as if its key went down/up. */
    touch(action, pressed) {
      if (!TITAN_KEY_ACTIONS.includes(action) || !active()) return false;
      if (pressed) { down.add(action); onAction(action, true); }
      else if (down.delete(action) && HELD[action]) onAction(action, false);
      return true;
    },
    get listening() { return !disposed; },
    dispose() {
      if (disposed) return;
      disposed = true;
      down.clear();
      target?.removeEventListener('keydown', keyDown, true);
      target?.removeEventListener('keyup', keyUp, true);
      target?.removeEventListener('blur', blur);
    },
  };
}
