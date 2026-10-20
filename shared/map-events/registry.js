// The registered Conquest map events (docs/conquest.md "Map events"). One
// definition per event file (defineMapEvent, ./define.js). Each event owns
// exactly its two slot lines below (the import and the list entry); the
// comment lines between the slots stay untouched, so branches that each fill
// one slot merge without conflicts. Wire indices never depend on this order:
// `mapEventsFor` sorts a map's events by id.

// slot dam (Redrock dam breach):
// import { DAM_EVENT } from './dam.js';
// slot depot (Frontier Hollin Fuel Depot):
// import { DEPOT_EVENT } from './depot.js';
// slot weir (Frontier sluice gate):
// import { WEIR_EVENT } from './weir.js';
// slot relay (Frontier Signal Rock radio mast):
import { RELAY_EVENT } from './relay.js';
// slot elevator (Frontier Kestrel Halt grain elevator):
// import { ELEVATOR_EVENT } from './elevator.js';
// slot quarry (Frontier Aldric Quarry rockslide):
// import { QUARRY_EVENT } from './quarry.js';
// slot comeback (both maps, trailing team call-in):
// import { COMEBACK_EVENT } from './comeback.js';
// slot airdrop (both maps, supply crate):
// import { AIRDROP_EVENT } from './airdrop.js';
// end of import slots

/** Every map event the game knows, in no particular order. */
export const MAP_EVENT_DEFS = Object.freeze([
  // slot dam:
  // DAM_EVENT,
  // slot depot:
  // DEPOT_EVENT,
  // slot weir:
  // WEIR_EVENT,
  // slot relay:
  RELAY_EVENT,
  // slot elevator:
  // ELEVATOR_EVENT,
  // slot quarry:
  // QUARRY_EVENT,
  // slot comeback:
  // COMEBACK_EVENT,
  // slot airdrop:
  // AIRDROP_EVENT,
  // end of list slots
].filter(Boolean));
