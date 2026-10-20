// The registered Conquest map events (docs/conquest.md "Map events"). One
// definition per event file (defineMapEvent, ./define.js). Each event owns
// exactly its two slot lines below (the import and the list entry); the
// comment lines between the slots stay untouched, so branches that each fill
// one slot merge without conflicts. Wire indices never depend on this order:
// `mapEventsFor` sorts a map's events by id. Reserved slots (sluice, radar,
// trestle) stay empty until their branch fills them.

// slot dam (Redrock dam breach):
import { DAM_EVENT } from './dam.js';
// slot depot (forward service depots; today the Frontier Hollin Fuel Depot):
import { DEPOT_EVENT } from './depot.js';
// slot sluice (Frontier ford sluices, reserved):
// slot radar (flag radars on both maps, reserved):
import { RADAR_EVENTS } from './radar.js';
// slot trestle (Redrock canyon trestle collapse, reserved):
// slot comeback (both maps, trailing team call-in):
import { COMEBACK_EVENT } from './comeback.js';
// end of import slots

/** Every map event the game knows, in no particular order. */
export const MAP_EVENT_DEFS = Object.freeze([
  // slot dam:
  DAM_EVENT,
  // slot depot:
  DEPOT_EVENT,
  // slot sluice:
  // slot radar:
  ...RADAR_EVENTS,
  // slot trestle:
  // slot comeback:
  COMEBACK_EVENT,
  // end of list slots
].filter(Boolean));
