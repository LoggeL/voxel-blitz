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
  // slot weir:
  // slot relay:
  // slot elevator:
  // slot quarry:
  // A cut rock face shedding boulders onto a talus slope.
  rockslide: 'M2 21l6.5-12 2.6 3.6L13 9.5l2.2 3.3L12 21zM14.4 21l3-5.2 1.7 1.9 2.9 3.3zM15.2 3.2h3.2v3.2h-3.2zM18.8 6.8h2.6v2.6h-2.6zM12.4 5.4h2.2v2.2h-2.2z',
  // slot comeback:
  // slot airdrop:
  // end of glyph slots
});
