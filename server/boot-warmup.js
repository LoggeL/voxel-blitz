// Per-process caches a room would otherwise build inside its creation, its
// start or its first tick. Every room shares the one event loop, so such a
// build stalls all running matches (and every player's ping) at once: the
// server builds them at boot, or in short slices between room ticks.
//
// - The battlefields (Frontier synchronous, before listening; Redrock Canyon
//   right after a room tick once listening): template, metadata, wire bytes,
//   surface graph, road graph, the bots' per-flag cover sets and the
//   structural template field.
// - Flat-floor maps (sliced, after listening): the bots' ground grid
//   (`navigationFloor` maps without a surface graph), so the first bot room on
//   one copies it (0.1 ms) instead of sweeping it in its first tick (20-60 ms).

import { createMapState, getMapMeta } from '../shared/worlddata.js';
import { MAP_IDS } from '../shared/modes.js';
import { prepareStructureTemplate } from './sim/structure.js';
import { groundNavigationSteps, surfaceNavigation } from './bot-navigation.js';
import { roadGraph } from './bot-vehicle-driving.js';
import { CoverIndex } from './bot-cover.js';
import { isBattlefieldMap } from '../shared/world/battlefields.js';

/**
 * Build a battlefield's (Frontier, Redrock Canyon) shared caches on a throwaway
 * pristine world. Returns the timings in ms: { total, cover, field } (field
 * null without structure).
 */
export function prepareBattlefield(id, { structural = true } = {}) {
  const started = performance.now();
  const mapMeta = getMapMeta(id);
  const world = createMapState(id);
  world.serializeWorld();
  world.mapFrame();
  surfaceNavigation(world);
  roadGraph({ mapMeta });
  // Cover, overwatch and armour sets of every flag (~10 ms per flag here, built
  // by the first Conquest room's bot commander otherwise); rooms clone them.
  const coverStarted = performance.now();
  new CoverIndex({ world, mapMeta }).ensure(mapMeta.conquest?.flags ?? []);
  const cover = performance.now() - coverStarted;
  // Its structural template field too (~110 ms here, ~400 ms on the production host):
  // built at the first Frontier room's creation it stalled every running room.
  const fieldStarted = performance.now();
  if (structural) prepareStructureTemplate(world);
  const field = structural ? performance.now() - fieldStarted : null;
  return { total: performance.now() - started, cover, field };
}

/** Frontier's shared caches (prepareBattlefield('frontier')). */
export function prepareFrontier(options = {}) {
  return prepareBattlefield('frontier', options);
}

/** Maps whose bots route on the flat ground grid (a navigation floor, no surface graph). */
export function groundGridMaps(ids = MAP_IDS) {
  return ids.filter(id => {
    const meta = getMapMeta(id);
    return meta?.navigation?.mode !== 'surface' && Number.isFinite(meta?.navigationFloor);
  });
}

/**
 * Run generator tasks in short time slices: each slice advances the current
 * task for at most `sliceMs`, then `schedule` decides when the next slice runs
 * (the server: right after a room tick, or at once while no room runs).
 * `tasks` are [label, () => generator]. Resolves with [{ label, ms, slices,
 * longest, built, error? }]; `built` is whether the generator returned a value
 * (a ground grid; null for a map without one).
 */
export function runSliced(tasks, { schedule = (fn) => setImmediate(fn), sliceMs = 2, now = () => performance.now() } = {}) {
  const queue = [...tasks];
  const timings = [];
  let current = null, resolved = false;
  return new Promise((resolve) => {
    const step = () => {
      const started = now();
      try {
        if (!current) {
          if (!queue.length) { resolved = true; resolve(timings); return; }
          const [label, start] = queue.shift();
          current = { row: { label, ms: 0, slices: 0, longest: 0, built: false }, steps: null, start };
          timings.push(current.row);
        }
        // The first slice also runs the task's setup (a map template build is not sliced).
        current.steps ??= current.start();
        let next;
        do next = current.steps.next(); while (!next.done && now() - started < sliceMs);
        if (next.done) { current.row.built = next.value != null; current = null; }
      } catch (error) {
        if (current) current.row.error = error?.message || String(error);
        current = null;
      } finally {
        // The slice belongs to the task it ran (the final, empty step resolves above and charges none).
        const row = timings[timings.length - 1], ms = now() - started;
        if (row && !resolved) { row.ms += ms; row.slices++; if (ms > row.longest) row.longest = ms; }
      }
      schedule(step);
    };
    schedule(step);
  });
}

/** A map's ground-grid warm-up as a generator: nothing for maps without a flat floor. */
function* groundGridSteps(id) {
  // Inside the first slice: reading the metadata builds the map's template.
  const meta = getMapMeta(id);
  if (meta?.navigation?.mode === 'surface' || !Number.isFinite(meta?.navigationFloor)) return null;
  return yield* groundNavigationSteps(createMapState(id));
}

/** Warm the ground grids of `maps` (default: all but the battlefields) in slices (see runSliced); maps without a flat floor finish at once. */
export function warmGroundGrids(maps = MAP_IDS.filter(id => !isBattlefieldMap(id)), options = {}) {
  return runSliced(maps.map(id => [id, () => groundGridSteps(id)]), options);
}
