/**
 * Titanfall pilot keys (docs/titanfall.md §8.1, §8.2; WP6): the `pilot` key
 * context. A capture-phase window listener consumes `pilotTactical` (Q) and
 * `callTitan` (E) with preventDefault, so Input never sees them as lean while
 * a titanfall pilot is on foot; dispose() removes the listener and Q/E are lean
 * again. Interact (T) is only observed here (never consumed): it rips a
 * battery while riding and mounts an enemy titan's back; the battery insert
 * claims the press through VehicleController.interactClaim instead.
 */
import { isTypingTarget, matchesBinding } from '../keybindings.js';

export const PILOT_KEY_ACTIONS = Object.freeze(['pilotTactical', 'callTitan']);

/**
 * `active()`: true while the pilot keys apply (titanfall, alive, on foot,
 * gameplay input enabled). `onAction(action)`: 'pilotTactical' | 'callTitan' |
 * 'interact'. Returns { dispose, handle(event) }.
 */
export function createPilotController({ target = typeof window !== 'undefined' ? window : null, active = () => false,
  onAction = () => {} } = {}) {
  const keyDown = event => {
    if (event.defaultPrevented || isTypingTarget(event.target) || !active()) return;
    for (const action of PILOT_KEY_ACTIONS) {
      if (!matchesBinding(event, action)) continue;
      event.preventDefault();
      if (!event.repeat) onAction(action);
      return;
    }
    if (matchesBinding(event, 'interact') && !event.repeat) onAction('interact');
  };
  // Keep the release away from Input too, so a lean never sticks half pressed.
  const keyUp = event => {
    if (!active() || isTypingTarget(event.target)) return;
    if (PILOT_KEY_ACTIONS.some(action => matchesBinding(event, action))) event.preventDefault();
  };
  target?.addEventListener('keydown', keyDown, true);
  target?.addEventListener('keyup', keyUp, true);
  let disposed = false;
  return {
    handle: keyDown,
    get listening() { return !disposed; },
    dispose() {
      if (disposed) return;
      disposed = true;
      target?.removeEventListener('keydown', keyDown, true);
      target?.removeEventListener('keyup', keyUp, true);
    },
  };
}
