/**
 * Event-specific vector glyphs (24x24 path data, filled with currentColor)
 * merged into ICON_PATHS (../icons.js). The framework's generic glyphs
 * (event, event-relay, event-crate, flood, fire, charge) live in icons.js;
 * an event that needs its own adds it here in its slot, so branches that
 * each fill one merge without conflicts (docs/conquest.md "Map events").
 */
export const MAP_EVENT_GLYPHS = Object.freeze({
  // slot dam:
  // slot depot:
  // Hollin Fuel Depot: a squat fuel tank with a flame over it.
  'event-depot': 'M12 1.5c1.9 2.2 3.4 3.9 3.4 5.9a3.4 3.4 0 0 1-6.8 0c0-1.1.5-2.1 1.3-2.9.1 1.1.7 1.9 1.5 2.2-.2-1.8.1-3.5.6-5.2zM4 13.2C4 11.4 7.6 10 12 10s8 1.4 8 3.2V20c0 1.5-3.6 2.5-8 2.5S4 21.5 4 20zM6 14.6v1.6c1.5.6 3.6.9 6 .9s4.5-.3 6-.9v-1.6c-1.5.6-3.6.9-6 .9s-4.5-.3-6-.9z',
  // slot weir:
  // slot relay:
  // slot elevator:
  // slot quarry:
  // slot comeback:
  // slot airdrop:
  // end of glyph slots
});
