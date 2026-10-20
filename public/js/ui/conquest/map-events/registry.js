/**
 * HUD presenters of the Conquest map events (docs/conquest.md "Map events"):
 * event id -> presenter. Each event owns exactly its two slot lines (import,
 * map entry); the comment lines between slots stay untouched so branches
 * that each fill one merge without conflicts (reserved slots: sluice, radar,
 * trestle, empty until their branch fills them). An event without a presenter
 * gets the generic banner, map badge and world marker (../map-events.js)
 * from its definition's name, glyph and phase texts.
 *
 * A presenter is a plain object; every hook is optional:
 *   banner(ev, ctx, base)    the banner of a `map_event` event: return `base`
 *                            (the generic one) changed, a new banner, null (no
 *                            banner) or undefined (keep `base`). `ctx`:
 *                            {nowMs, selfTeam, selfId, def, where}
 *   paintMap(ctx2d, event, opts)  world-space overlay on the minimap and the
 *                            full map, under the markers (as paintBridge):
 *                            `event` a decoded `ev` row, opts {nowMs, px}
 *   mapItems(event, cq, selfTeam)  extra map items (default: the badge)
 *   marker(model, event, ctx)      change the world marker model
 */

// slot dam:
import { DAM_PRESENTER } from './dam.js';
// slot depot:
import { DEPOT_PRESENTER } from './depot.js';
// slot sluice:
// slot radar:
// slot trestle:
import { levolutionPresenter } from './levolution.js';
// slot comeback:
import { COMEBACK_PRESENTER } from './comeback.js';
// end of import slots

export const MAP_EVENT_PRESENTERS = Object.freeze({
  // slot dam:
  dam: DAM_PRESENTER,
  // slot depot:
  depot: DEPOT_PRESENTER,
  // slot sluice:
  // slot radar:
  // slot trestle:
  trestle: levolutionPresenter({ water: false }),
  // slot comeback:
  comeback: COMEBACK_PRESENTER,
  // end of map slots
});
