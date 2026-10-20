/**
 * Hollin Fuel Depot on the HUD (docs/conquest.md "Hollin Fuel Depot"; design
 * docs/design/conquest/events/depot/). Reads only the decoded `ev` row (phase,
 * time left, the per-tank extras) and the definition's data:
 *
 *   maps     while the chain builds, the 20 m blast radius as a pulsing amber
 *            ring; once a tank bursts, its burning ground as flickering orange
 *            discs (until the fire burns out); while the column stands, a dark
 *            disc of its current radius over the farm
 *   marker   "DEPOT · FIRE 42 S" while the ground burns, "DEPOT · SMOKE" after
 *            (on the minimap, where the depot is smaller than the event hex,
 *            the ring, the column and the fires keep a minimum pixel size so
 *            they show around the hex)
 *   banner   the generic phase banners from the definition's texts; the
 *            per-tank `burst` notes are effects only (no banner)
 */
import { depotColumnRadius } from '../../../../../shared/map-events/depot.js';

/** The framework's hazard amber (MAP_EVENT_COLORS.hazard in ../map-events.js, which imports this file through the registry). */
const HAZARD = '#ffb020';

/** Seconds into the active phase of a decoded row (null outside it). */
function activeAgeMs(event) {
  if (event?.phase !== 'active' || !Number.isFinite(event.leftMs)) return null;
  return Math.max(0, (event.def.durations.activeMs ?? 0) - event.leftMs);
}

/** The burst tanks of a row: every tank once active, else those whose extra reads 0. */
export function depotBurstTanks(event) {
  const tanks = event?.def?.tuning?.tanks ?? [];
  if (event?.phase === 'active') return tanks;
  if (event?.phase !== 'armed' && event?.phase !== 'warning') return [];
  return tanks.filter((_, i) => Array.isArray(event.extra) && event.extra[i] === 0);
}

/** Milliseconds of burning ground left (Infinity while the chain still runs, 0 once out). */
export function depotFireLeftMs(event) {
  if (event?.phase === 'armed' || event?.phase === 'warning') return Infinity;
  const age = activeAgeMs(event);
  return age == null ? 0 : Math.max(0, event.def.tuning.fire.ms - age);
}

/** Minimum screen radii in CSS px (the event hex is about 9 px). */
const MIN_PX = Object.freeze({ ring: 13, column: 12, fireHalo: 14.5, fire: 3, fireSplit: 5 });

function disc(ctx, x, z, r, fill, stroke = null, width = 1) {
  ctx.beginPath();
  ctx.arc(x, z, r, 0, Math.PI * 2);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); }
}

export const DEPOT_PRESENTER = Object.freeze({
  banner(ev) {
    if (ev?.note === 'burst') return null;
    return undefined;
  },

  paintMap(ctx, event, { nowMs = 0, px = 1 } = {}) {
    const T = event?.def?.tuning;
    const a = event?.anchor;
    if (!T || !a) return;
    const unit = 1 / Math.max(0.05, px);
    if (event.phase === 'armed' || event.phase === 'warning') {
      const pulse = (Math.sin(nowMs / 140) + 1) / 2;
      ctx.setLineDash([4 * unit, 3 * unit]);
      disc(ctx, a.x, a.z, Math.max(T.blast.radius, MIN_PX.ring * unit), `rgba(255, 176, 32, ${0.08 + 0.1 * pulse})`, HAZARD, 1.6 * unit);
      ctx.setLineDash([]);
    }
    if (event.phase === 'active') {
      const age = activeAgeMs(event), r = depotColumnRadius(T.column, age, event.leftMs);
      if (r > 0) disc(ctx, a.x, a.z, Math.max(r, MIN_PX.column * unit), 'rgba(20, 18, 16, 0.55)', 'rgba(120, 112, 104, 0.7)', 1 * unit);
    }
    if (depotFireLeftMs(event) > 0) {
      const flicker = 0.55 + 0.25 * Math.sin(nowMs / 90) + 0.1 * Math.sin(nowMs / 37);
      const fires = depotBurstTanks(event).map(t => ({ x: t.x, z: t.z, r: T.fire.radius }));
      if (event.phase === 'active') fires.push(T.fire.canopy);
      if (!fires.length) return;
      // Too small to tell the tanks apart: one flickering halo around the hex instead.
      if (T.fire.radius < MIN_PX.fireSplit * unit) {
        ctx.setLineDash([]);
        disc(ctx, a.x, a.z, MIN_PX.fireHalo * unit, null, `rgba(255, 130, 34, ${Math.min(1, 0.45 + flicker)})`, 2.4 * unit);
        return;
      }
      for (const f of fires) disc(ctx, f.x, f.z, Math.max(f.r, MIN_PX.fire * unit), `rgba(255, 106, 28, ${0.35 * flicker})`, `rgba(255, 150, 40, ${0.8 * flicker})`, 1.2 * unit);
    }
  },

  marker(model, event) {
    if (event.phase !== 'active') return model;
    const left = depotFireLeftMs(event);
    return { ...model, name: left > 0 ? `${event.def.short} · FIRE ${Math.ceil(left / 1000)} S` : `${event.def.short} · SMOKE` };
  },
});
