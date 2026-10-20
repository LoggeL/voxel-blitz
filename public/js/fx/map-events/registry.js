/**
 * World effects of the Conquest map events (docs/conquest.md "Map events"):
 * event id -> FX hook. Each event owns exactly its two slot lines (import,
 * map entry); the comment lines between slots stay untouched so branches
 * that each fill one merge without conflicts. An event without a hook gets
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
// import { DAM_FX } from './dam.js';
// slot depot:
import { DEPOT_FX } from './depot.js';
// slot weir:
// import { WEIR_FX } from './weir.js';
// slot relay:
// import { RELAY_FX } from './relay.js';
// slot elevator:
// import { ELEVATOR_FX } from './elevator.js';
// slot quarry:
// import { QUARRY_FX } from './quarry.js';
// slot comeback:
import { COMEBACK_FX } from './comeback.js';
// slot airdrop:
import { AIRDROP_FX } from './airdrop.js';
// end of import slots

export const MAP_EVENT_FX = Object.freeze({
  // slot dam:
  // dam: DAM_FX,
  // slot depot:
  depot: DEPOT_FX,
  // slot weir:
  // weir: WEIR_FX,
  // slot relay:
  // relay: RELAY_FX,
  // slot elevator:
  // elevator: ELEVATOR_FX,
  // slot quarry:
  // quarry: QUARRY_FX,
  // slot comeback:
  comeback: COMEBACK_FX,
  // slot airdrop:
  airdrop: AIRDROP_FX,
  // end of map slots
});
