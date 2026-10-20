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
  // A sluice wheel: rim, hub, cross spokes and four handles.
  'event-weir': 'M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18zM12 5.2a6.8 6.8 0 1 0 0 13.6a6.8 6.8 0 1 0 0-13.6zM11.2 5h1.6v14h-1.6zM5 11.2h14v1.6H5zM12 9.6a2.4 2.4 0 1 1 0 4.8a2.4 2.4 0 1 1 0-4.8zM18.4 3.9a1.7 1.7 0 1 1 0 3.4a1.7 1.7 0 1 1 0-3.4zM5.6 3.9a1.7 1.7 0 1 1 0 3.4a1.7 1.7 0 1 1 0-3.4zM18.4 16.7a1.7 1.7 0 1 1 0 3.4a1.7 1.7 0 1 1 0-3.4zM5.6 16.7a1.7 1.7 0 1 1 0 3.4a1.7 1.7 0 1 1 0-3.4z',
  // slot relay:
  // slot elevator:
  // slot quarry:
  // slot comeback:
  // slot airdrop:
  // end of glyph slots
});
