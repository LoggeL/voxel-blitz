/**
 * World effects of the Conquest map events (docs/conquest.md "Map events"):
 * event id -> FX hook. Each event owns exactly its two slot lines (import,
 * map entry); the comment lines between slots stay untouched so branches
 * that each fill one merge without conflicts (reserved slots: sluice, radar,
 * trestle, empty until their branch fills them). An event without a hook gets
 * the generic effects of ../map-event-fx.js (shake, dust and rumble as a
 * levolution or call-in strikes).
 *
 * A hook is a plain object; every method is optional and gets the kit
 * (MapEventFx: shake, puff, emitter, stopEmitter, sound, anchor, camera):
 *   onEvent(ev, kit)           a `map_event` server event (phase change or note);
 *                              return true to replace the generic effects
 *   sync(event, kit, {fresh})  every frame with the decoded `ev` row while it
 *                              rides the snapshot (`fresh` the first frame this
 *                              client sees the event: a joiner starts its
 *                              standing effects, a smoke column, a fire, here)
 *   update(dt, kit)            every frame
 *   end(kit)                   the event left the snapshot (back to idle, a
 *                              rematch); its `<id>:` emitters are already gone
 *   clear(kit)                 match end, leaving
 */

// slot dam:
import { DAM_FX } from './dam.js';
// slot depot:
import { DEPOT_FX } from './depot.js';
// slot sluice:
// slot radar:
// slot trestle:
// slot comeback:
import { COMEBACK_FX } from './comeback.js';
// end of import slots

export const MAP_EVENT_FX = Object.freeze({
  // slot dam:
  dam: DAM_FX,
  // slot depot:
  depot: DEPOT_FX, 'depot-w': DEPOT_FX,
  // slot sluice:
  // slot radar:
  // slot trestle:
  // slot comeback:
  comeback: COMEBACK_FX,
  // end of map slots
});
