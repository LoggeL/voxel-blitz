/**
 * Aldric Quarry rockslide on the HUD (docs/conquest.md "Aldric
 * Quarry rockslide"; design docs/design/conquest/events/quarry/, variant A
 * with variant C's after-slide map). The banner, the world hexagon marker
 * and the plunger prompt are the framework's (texts from the definition);
 * this presenter paints the slide on the minimap and the full map from the
 * decoded `ev` row:
 *
 *   armed / warning  the slide zone in pulsing amber and black hazard stripes
 *   active           the zone in red stripes, filling north to south with the
 *                    slide's progress
 *   done             the buried haul ramp as a red block with a black cross and
 *                    the new talus as a white chevron ladder up to the rim
 *
 * The map badge stands beside the pit (south-west of it), not on the
 * overlay it labels. Geometry comes from the definition's data, the state
 * from the snapshot: a joiner sees the same paint.
 */
import { mapEventGlyph } from '../../../../../shared/conquest-map-events.js';
import { MAP_EVENT_COLORS, mapEventTone } from '../map-events.js';

const LIVE = new Set(['armed', 'warning', 'active']);
/** World point of the map badge (south-west of the pit, clear of the slide overlay). */
export const QUARRY_BADGE_AT = Object.freeze({ x: 238, z: 612 });
/** Smallest on-canvas size (px) of the overlay's parts on a zoomed-out map. */
const MIN_PX = Object.freeze({ zone: 18, choke: 10, chevron: 9, line: 1.4 });

const metres = (minPx, px) => minPx / Math.max(px, 1e-3);

function stripes(ctx, x0, z0, w, h, color, step) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x0, z0, w, h); ctx.clip();
  ctx.strokeStyle = color; ctx.lineWidth = step / 2.4;
  ctx.beginPath();
  for (let d = -h; d < w + h; d += step) { ctx.moveTo(x0 + d, z0); ctx.lineTo(x0 + d - h, z0 + h); }
  ctx.stroke();
  ctx.restore();
}

/** A box grown about its centre to at least `min` metres a side. */
function grown(x0, z0, w, h, min) {
  const gw = Math.max(w, min), gh = Math.max(h, min * (h / Math.max(w, 1e-3)));
  return { x0: x0 - (gw - w) / 2, z0: z0 - (gh - h) / 2, w: gw, h: gh };
}

/** Minimap / full map overlay of one decoded quarry row (world-space context, `px` canvas px per metre). */
export function paintQuarry(ctx, event, { nowMs = 0, px = 1 } = {}) {
  const tuning = event?.def?.tuning;
  if (!ctx || !tuning) return;
  const zone = tuning.zone, s = tuning.slide, lw = metres(MIN_PX.line, px);
  if (LIVE.has(event.phase)) {
    const active = event.phase === 'active';
    const z = grown(zone.x0, zone.z0, zone.x1 + 1 - zone.x0, zone.z1 + 1 - zone.z0, metres(MIN_PX.zone, px));
    const color = active ? MAP_EVENT_COLORS.danger : MAP_EVENT_COLORS.hazard;
    ctx.globalAlpha = active ? 0.95 : 0.55 + 0.4 * Math.abs(Math.sin(nowMs / 180));
    ctx.fillStyle = `${MAP_EVENT_COLORS.ink}cc`;
    ctx.fillRect(z.x0, z.z0, z.w, z.h);
    stripes(ctx, z.x0, z.z0, z.w, z.h, color, Math.max(z.w, z.h) / 6);
    if (active) {
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = MAP_EVENT_COLORS.danger;
      ctx.fillRect(z.x0, z.z0, z.w, z.h * Math.max(0, Math.min(1, event.progress)));
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color; ctx.lineWidth = lw * 1.4;
    ctx.strokeRect(z.x0, z.z0, z.w, z.h);
    return;
  }
  if (event.phase !== 'done') return;
  // The buried haul ramp: a red block over the choke's floor half with a black cross.
  const c = s.choke;
  const k = grown(c.x0, c.z0 + 4, c.x1 + 1 - c.x0, c.z1 + 1 - (c.z0 + 4), metres(MIN_PX.choke, px));
  ctx.fillStyle = MAP_EVENT_COLORS.danger;
  ctx.fillRect(k.x0, k.z0, k.w, k.h);
  ctx.strokeStyle = MAP_EVENT_COLORS.ink; ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(k.x0 + k.w * 0.25, k.z0 + k.h * 0.15); ctx.lineTo(k.x0 + k.w * 0.75, k.z0 + k.h * 0.85);
  ctx.moveTo(k.x0 + k.w * 0.75, k.z0 + k.h * 0.15); ctx.lineTo(k.x0 + k.w * 0.25, k.z0 + k.h * 0.85);
  ctx.stroke();
  // The new talus: white chevrons climbing north from the floor to the rim.
  const t = s.talus, mid = (t.x0 + t.x1 + 1) / 2;
  const half = Math.max((t.x1 + 1 - t.x0) * 0.4, metres(MIN_PX.chevron, px) / 2);
  const top = s.profile.z0, bottom = t.z1 + 1, n = 3, span = Math.max(bottom - top, half * 4.2);
  const z1 = (top + bottom) / 2 + span / 2;
  ctx.strokeStyle = MAP_EVENT_COLORS.neutral; ctx.lineWidth = lw * 1.3; ctx.lineJoin = 'miter';
  for (let i = 0; i < n; i++) {
    const z = z1 - span * (i + 0.7) / n;
    ctx.beginPath();
    ctx.moveTo(mid - half, z + half * 0.75); ctx.lineTo(mid, z); ctx.lineTo(mid + half, z + half * 0.75);
    ctx.stroke();
  }
}

/** The map badge (the framework's event item) moved beside the pit; faded once the slide is over. */
export function quarryMapItems(event, cq, selfTeam, { nowMs = 0 } = {}) {
  if (event.phase === 'idle') return [];
  return [{ kind: 'event', id: event.id, x: QUARRY_BADGE_AT.x, z: QUARRY_BADGE_AT.z, glyph: mapEventGlyph(event.def), label: event.def.short,
    phase: event.phase, tone: mapEventTone(event.def, event.phase, event.team, selfTeam), progress: event.progress,
    pulse: event.phase === 'warning' ? (Math.sin(nowMs / 160) + 1) / 2 : 0, faded: event.phase === 'done' }];
}

export const QUARRY_PRESENTER = Object.freeze({
  paintMap: paintQuarry,
  mapItems: (event, cq, selfTeam) => quarryMapItems(event, cq, selfTeam, { nowMs: performance.now() }),
});
