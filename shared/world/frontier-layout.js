// Frontier v2 layout facade (spec 3.2). The data lives in
// shared/world/frontier-sites/layout.js and is derived from FRONTIER_PLAN,
// the terrain heightfield (shared/world/frontier-terrain.js) and the sites.
// Importing this module never builds the terrain: FRONTIER_CONQUEST and
// FRONTIER_AIRFIELDS are read-only views that resolve on first property access.
import { FRONTIER_LAYOUT } from './frontier-sites/layout.js';

export {
  FRONTIER_ROADS, FRONTIER_SITES, FRONTIER_LAYOUT, createFrontierMetadata, frontierReservedCells, frontierSurfaceY,
} from './frontier-sites/layout.js';

/** Read-only view of a lazily built frozen object (the shell owns no data). */
function lazyView(shell, resolve) {
  const describe = (target, key) => {
    const real = Object.getOwnPropertyDescriptor(resolve(), key);
    if (!real) return undefined;
    // Proxy invariants: only properties the shell itself owns may stay non-configurable.
    return Object.prototype.hasOwnProperty.call(target, key) ? real : { ...real, configurable: true };
  };
  return new Proxy(shell, {
    get: (_, key) => Reflect.get(resolve(), key),
    has: (_, key) => key in resolve(),
    ownKeys: () => Reflect.ownKeys(resolve()),
    getOwnPropertyDescriptor: describe,
    set: () => false, defineProperty: () => false, deleteProperty: () => false,
  });
}

/** mapMeta.conquest v2 (frozen). */
export const FRONTIER_CONQUEST = lazyView({}, () => FRONTIER_LAYOUT.conquest);
/** HQ airfields (runway, helipads, motor pool, hangar, tower) with terrain y. */
export const FRONTIER_AIRFIELDS = lazyView([], () => FRONTIER_LAYOUT.airfields);
