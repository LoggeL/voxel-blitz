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
  // slot comeback:
  // Call-in: a target reticle with its four ticks around a falling bomb.
  callin: 'M12 2a10 10 0 1 1 0 20a10 10 0 1 1 0-20zM12 4.4a7.6 7.6 0 1 0 0 15.2a7.6 7.6 0 1 0 0-15.2zM11.1 0h1.8v4.6h-1.8zM11.1 19.4h1.8V24h-1.8zM0 11.1h4.6v1.8H0zM19.4 11.1H24v1.8h-4.6zM12 8.6a2.3 2.3 0 0 1 2.3 2.3v2.5a2.3 2.7 0 0 1-4.6 0v-2.5A2.3 2.3 0 0 1 12 8.6zM10.5 6.4h3l-.7 1.7h-1.6z',
  // slot airdrop:
  // end of glyph slots
});
