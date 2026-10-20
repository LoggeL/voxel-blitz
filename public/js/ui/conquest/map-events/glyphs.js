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
  'event-elevator': 'M6 21V6.5L9.5 3l3.5 3.5V21H11v-4H8v4zM8 8.2v2.2h3V8.2zM8 12.2v2.2h3v-2.2zM14.6 21l6.8-6.8 1.4 1.4L17.4 21zM15.2 13.1l2.2-2.2 1.4 1.4-2.2 2.2zM2 21h20v1.5H2z',
  // slot quarry:
  // slot comeback:
  // slot airdrop:
  // end of glyph slots
});
