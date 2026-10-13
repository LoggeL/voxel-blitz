// Titanfall client projectile view registry (docs/titanfall.md §6.1, WP0, frozen).
// Merges the pilot AT views (WP4: archer, arcball) and the titan views (WP5:
// t203, leadwall, cluster, flightRocket). ProjectileFX.launch consults it before
// its 'frag' fallback:
//   if (titanfallProjectileViews.has(event.type)) return titanfallProjectileViews.get(event.type).launch(this, event, opts);
// A view is `{ launch(fx, event, { local, fromSelf }) -> boolean }`. Stock
// projectile types can never be claimed, so other modes are untouched.
import { GRENADE_TYPES } from '../../../shared/grenade-rules.js';
import { PROJECTILE_VIEWS as PILOT_VIEWS } from './pilot-projectile-views.js';
import { PROJECTILE_VIEWS as TITAN_VIEWS } from './titan-projectile-views.js';

/** Event types ProjectileFX draws itself. */
export const STOCK_PROJECTILE_TYPES = Object.freeze(['rocket', 'shell', 'bolt', 'glaive', 'mgl', 'bubble', ...Object.keys(GRENADE_TYPES)]);

function merge(sources) {
  const views = new Map();
  for (const [owner, source] of sources) {
    for (const [type, view] of Object.entries(source || {})) {
      if (STOCK_PROJECTILE_TYPES.includes(type)) throw new Error(`titanfall projectile view ${owner}:${type} shadows a stock type`);
      if (views.has(type)) throw new Error(`titanfall projectile view ${type} registered twice`);
      if (typeof view?.launch !== 'function') throw new Error(`titanfall projectile view ${owner}:${type} has no launch()`);
      views.set(type, view);
    }
  }
  return views;
}

const VIEWS = merge([['pilot', PILOT_VIEWS], ['titan', TITAN_VIEWS]]);

export const titanfallProjectileViews = Object.freeze({
  /** True only for a registered titanfall event type. */
  has: type => typeof type === 'string' && VIEWS.has(type),
  /** The view for a registered type, or null. */
  get: type => (typeof type === 'string' && VIEWS.get(type)) || null,
  types: Object.freeze([...VIEWS.keys()]),
});
