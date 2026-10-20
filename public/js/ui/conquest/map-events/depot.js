/**
 * Forward service depots on the HUD (docs/conquest.md "Forward service
 * depots"; design docs/design/conquest/depot/, variant A, and the chain
 * reaction of docs/design/conquest/events/depot/). Reads only the decoded
 * `ev` row (phase, gauge, time left, extras), the flag owners and the
 * definition's data:
 *
 *   maps     while the depot stands, a hexagon badge with the wrench and can
 *            at its pump in the colour of the side holding its flag (own
 *            cyan, enemy orange, grey and faded while the flag is neutral),
 *            the pool's lost share as its arc and a slow pulse while a hull
 *            is serviced; while the chain builds, the 20 m blast radius as a
 *            pulsing amber ring; once a tank bursts, its burning ground as
 *            flickering orange discs (until the fire burns out); while the
 *            column stands, a dark disc of its current radius; afterwards the
 *            badge stays grey and faded at the pump (no service this round)
 *   marker   "DEPOT · FIRE 42 S" while the ground burns, "DEPOT · SMOKE" after
 *   banner   the generic phase banners with the site's name ("KESTREL HALT
 *            DEPOT · CHAIN REACTION"); the per-tank `burst` notes are effects only
 * The SERVICING vehicle card is the hull row's `servicing` status bit
 * (vehiclePanelModel in ../../conquest-hud-state.js).
 */
import { depotColumnRadius, depotSiteNear } from '../../../../../shared/map-events/depot.js';
import { mapEventGlyph } from '../../../../../shared/conquest-map-events.js';

/** The framework's hazard amber (MAP_EVENT_COLORS.hazard in ../map-events.js, which imports this file through the registry). */
const HAZARD = '#ffb020';
const nowMs = () => globalThis.performance?.now?.() ?? 0;

/** Seconds into the active phase of a decoded row (null outside it). */
function activeAgeMs(event) {
  if (event?.phase !== 'active' || !Number.isFinite(event.leftMs)) return null;
  return Math.max(0, (event.def.durations.activeMs ?? 0) - event.leftMs);
}

/** The site of a decoded row (its anchor is the site's on this map). */
export const depotSiteOf = event => depotSiteNear(event?.def, event?.anchor);

/** The burst tanks of a row: every tank once active, else those whose extra reads 0. */
export function depotBurstTanks(event) {
  const tanks = depotSiteOf(event)?.tanks ?? [];
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

/** The side a depot row serves now: the owner of its flag while it stands, else null. */
export function depotOwner(event, cq) {
  if (event?.phase !== 'idle') return null;
  const flag = depotSiteOf(event)?.flag;
  const owner = (cq?.flags ?? []).find(f => f.id === flag)?.owner ?? null;
  return owner === 'alpha' || owner === 'bravo' ? owner : null;
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
  banner(ev, ctx, base) {
    if (ev?.note === 'burst') return null;
    const site = base ? depotSiteNear(ctx?.def, ev?.pos) : null;
    return site ? { ...base, title: base.title.replace(ctx.def.name, site.name) } : undefined;
  },

  /** The badge: at the pump while the depot stands or after it fell, over the tanks through the chain and the fire. */
  mapItems(event, cq, selfTeam) {
    const site = depotSiteOf(event);
    if (!site) return [];
    const standing = event.phase === 'idle', burning = event.phase === 'armed' || event.phase === 'warning' || event.phase === 'active';
    const owner = depotOwner(event, cq);
    const tone = burning ? (event.phase === 'active' ? 'danger' : 'hazard') : standing && owner ? (owner === selfTeam ? 'own' : 'enemy') : 'neutral';
    const at = burning ? site.anchor : site.pump, t = nowMs();
    const pulse = event.phase === 'warning' ? (Math.sin(t / 160) + 1) / 2 : standing && event.extra?.[0] === 1 ? (Math.sin(t / 320) + 1) / 2 : 0;
    return [{ kind: 'event', id: event.id, x: at.x, z: at.z, glyph: mapEventGlyph(event.def), label: event.def.short, phase: event.phase, tone,
      progress: standing ? event.progress : 0, pulse, faded: !burning && !owner, owner, servicing: standing && event.extra?.[0] === 1 }];
  },

  paintMap(ctx, event, { nowMs: now = 0, px = 1 } = {}) {
    const T = event?.def?.tuning, site = depotSiteOf(event);
    const a = event?.anchor;
    if (!T || !a || !site) return;
    const unit = 1 / Math.max(0.05, px);
    if (event.phase === 'armed' || event.phase === 'warning') {
      const pulse = (Math.sin(now / 140) + 1) / 2;
      ctx.setLineDash([4 * unit, 3 * unit]);
      disc(ctx, a.x, a.z, Math.max(T.blast.radius, MIN_PX.ring * unit), `rgba(255, 176, 32, ${0.08 + 0.1 * pulse})`, HAZARD, 1.6 * unit);
      ctx.setLineDash([]);
    }
    if (event.phase === 'active') {
      const age = activeAgeMs(event), r = depotColumnRadius(T.column, age, event.leftMs);
      if (r > 0) disc(ctx, a.x, a.z, Math.max(r, MIN_PX.column * unit), 'rgba(20, 18, 16, 0.55)', 'rgba(120, 112, 104, 0.7)', 1 * unit);
    }
    if (depotFireLeftMs(event) > 0) {
      const flicker = 0.55 + 0.25 * Math.sin(now / 90) + 0.1 * Math.sin(now / 37);
      const fires = depotBurstTanks(event).map(t => ({ x: t.x, z: t.z, r: T.fire.radius }));
      if (event.phase === 'active') fires.push(site.canopy);
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
