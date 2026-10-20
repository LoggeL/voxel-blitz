/**
 * Kestrel Halt grain elevator on the HUD (docs/conquest.md "Kestrel Halt
 * grain elevator"; design docs/design/conquest/events/elevator/, variant A
 * for the warning, the rubble strip of variant C after the fall). The
 * generic map event banner, badge and world marker carry the phases; this
 * adds the 'damaged' banner and the fall line on the minimap and the full
 * map: while a charge is armed an amber outline of the footprint the tower
 * will crush, pulsing black and amber hazard stripes with an arrow head east
 * while it gives way and falls, and the brown rubble strip across the a-c
 * road once it is down. Everything reads the authoritative `ev` row phase;
 * the shapes come from the shared definition data.
 */
import { KESTREL_ELEVATOR, KESTREL_ELEVATOR_RUBBLE, elevatorFallZone } from '../../../../../shared/map-events/elevator.js';

const COLORS = Object.freeze({ hazard: '#ffb020', ink: '#14100a', rubble: '#3f3226', rubbleEdge: '#e2d2b0', debris: '#c9b38c' });
/** Smallest drawn half width and arrow head (canvas px), so the line reads on the small minimap. */
const MIN_HALF_PX = 3.2, MIN_ARROW_PX = 6;
const FALL = elevatorFallZone(KESTREL_ELEVATOR, KESTREL_ELEVATOR_RUBBLE, 0.5);
const LENGTH = Math.hypot(FALL.bx - FALL.ax, FALL.bz - FALL.az);
const ANGLE = Math.atan2(FALL.bz - FALL.az, FALL.bx - FALL.ax);

/** Debris dots of the rubble strip (fixed, so the map does not flicker). */
const DEBRIS = Object.freeze(Array.from({ length: 14 }, (_, i) => Object.freeze([
  (((i * 37) % 97) / 97) * LENGTH, ((((i * 53) % 89) / 89) - 0.5) * FALL.w * 1.3, 0.6 + ((i * 29) % 7) / 10])));

/** Capsule along the local +x axis from 0 to `len`, half width `w`. */
function capsule(ctx, len, w) {
  ctx.beginPath();
  ctx.moveTo(0, -w); ctx.lineTo(len, -w);
  ctx.arc(len, 0, w, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(0, w);
  ctx.arc(0, 0, w, Math.PI / 2, Math.PI * 1.5);
  ctx.closePath();
}

export const ELEVATOR_PRESENTER = Object.freeze({
  /** Half integrity: an amber note banner (the generic banner skips notes). */
  banner(ev, ctx) {
    if (ev.note !== 'damaged') return undefined;
    const pct = Number.isFinite(ev.data?.integrity) ? ev.data.integrity : 50;
    return { key: 'event:elevator:damaged', tone: 'hazard', icon: ctx.def.glyph, title: `${ctx.def.name} · BASE DAMAGED`,
      detail: `SUPPORTS AT ${pct} %`, priority: 4, event: ctx.def.id, holdMs: 3200, ...(typeof ctx.where === 'function' ? { where: ctx.where } : {}) };
  },

  /** World-space fall line under the markers (the context maps world x/z, `px` canvas px per metre). */
  paintMap(ctx, event, { nowMs = 0, px = 1 } = {}) {
    const phase = event?.phase;
    if (!['armed', 'warning', 'active', 'done'].includes(phase)) return;
    const line = m => Math.max(m / Math.max(px, 1e-3), 0.25);
    ctx.translate(FALL.ax, FALL.az);
    ctx.rotate(ANGLE);
    const w = Math.max(FALL.w, MIN_HALF_PX / Math.max(px, 1e-3));
    const head = Math.max(w * 1.6, MIN_ARROW_PX / Math.max(px, 1e-3));
    if (phase === 'done' || (phase === 'active' && event.leftMs != null && event.leftMs < 4000)) {
      // Down: a brown rubble strip from the stump across the road, dark edge, light debris dots.
      capsule(ctx, LENGTH, w * 0.8);
      ctx.fillStyle = COLORS.rubble; ctx.globalAlpha = 0.9; ctx.fill();
      ctx.globalAlpha = 1; ctx.lineWidth = line(1.4); ctx.strokeStyle = COLORS.rubbleEdge; ctx.setLineDash?.([line(3), line(2)]); ctx.stroke();
      ctx.setLineDash?.([]);
      ctx.fillStyle = COLORS.debris;
      for (const [x, z, s] of DEBRIS) ctx.fillRect(x - s / 2, z - s / 2, s, s);
      return;
    }
    if (phase === 'warning' || phase === 'active') {
      // Giving way: pulsing black and amber stripes in the capsule, an arrow head at the far end.
      const pulse = 0.55 + 0.45 * Math.abs(Math.sin(nowMs / 180));
      ctx.save();
      ctx.globalAlpha = pulse;
      capsule(ctx, LENGTH, w); ctx.clip();
      ctx.fillStyle = COLORS.ink; ctx.fillRect(-w, -w, LENGTH + 2 * w, 2 * w);
      ctx.strokeStyle = COLORS.hazard; ctx.lineWidth = w / 2.2;
      ctx.beginPath();
      for (let d = -2 * w; d < LENGTH + 4 * w; d += w * 1.1) { ctx.moveTo(d, -w); ctx.lineTo(d - 2 * w, w); }
      ctx.stroke();
      ctx.restore();
      ctx.beginPath();
      ctx.moveTo(LENGTH + w + head, 0); ctx.lineTo(LENGTH + w * 0.4, -head * 0.75); ctx.lineTo(LENGTH + w * 0.4, head * 0.75); ctx.closePath();
      ctx.fillStyle = COLORS.hazard; ctx.fill();
    }
    // Armed (a charge in the bay) and the warning: the amber outline of what it will crush.
    capsule(ctx, LENGTH, w);
    ctx.lineWidth = line(2); ctx.strokeStyle = COLORS.hazard; ctx.stroke();
  },
});
