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
  // slot sluice:
  // slot radar:
  // Flag radar: a scope ring with its sweep wedge, the centre and a blip.
  'event-radar': 'M12 2a10 10 0 1 1 0 20a10 10 0 1 1 0-20zM12 4.3a7.7 7.7 0 1 0 0 15.4a7.7 7.7 0 1 0 0-15.4zM12 12V5.5a6.5 6.5 0 0 1 5.6 3.25zM12 10.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3zM7.6 14.2a1.4 1.4 0 1 1 0 2.8a1.4 1.4 0 1 1 0-2.8z',
  // slot trestle:
  // slot comeback:
  // Call-in: a target reticle with its four ticks around a falling bomb.
  callin: 'M12 2a10 10 0 1 1 0 20a10 10 0 1 1 0-20zM12 4.4a7.6 7.6 0 1 0 0 15.2a7.6 7.6 0 1 0 0-15.2zM11.1 0h1.8v4.6h-1.8zM11.1 19.4h1.8V24h-1.8zM0 11.1h4.6v1.8H0zM19.4 11.1H24v1.8h-4.6zM12 8.6a2.3 2.3 0 0 1 2.3 2.3v2.5a2.3 2.7 0 0 1-4.6 0v-2.5A2.3 2.3 0 0 1 12 8.6zM10.5 6.4h3l-.7 1.7h-1.6z',
  // end of glyph slots
});
