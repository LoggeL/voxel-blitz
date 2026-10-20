/**
 * Frontier sluice weir on the HUD (docs/conquest.md "Sluice weir"; design
 * docs/design/conquest/events/weir/, variant A). The generic banner, badge
 * and markers come from the definition's texts; this presenter paints the
 * flooded fords on the minimap and the full map: blue hatched patches over
 * both fords whose strength is the event's flood gauge (the server's
 * `progress`, 0 normal water to 1 high water), so they fill as the surge
 * rises and fade as it recedes. Nothing is predicted.
 */
import { WEIR_FLOODS } from '../../../../../shared/map-events/weir.js';

export const WEIR_COLORS = Object.freeze({ water: '#2f8fe0', hatch: '#bfe6ff', edge: '#4cc3ff' });

/** The patches to paint, world cells (x0, z0 inclusive; x1, z1 exclusive), with their strength 0..1, or []. */
export function weirFloodPatches(event) {
  const k = Math.max(0, Math.min(1, Number(event?.progress) || 0));
  if (!(k > 0.02)) return [];
  return WEIR_FLOODS.map(f => ({ id: f.id, x0: f.x0, z0: f.taper[0], x1: f.x1 + 1, z1: f.taper[1] + 1, strength: k }));
}

export const WEIR_PRESENTER = Object.freeze({
  paintMap(ctx, event, { nowMs = 0, px = 1 } = {}) {
    const line = m => Math.max(m / Math.max(px, 1e-3), 0.25);
    for (const p of weirFloodPatches(event)) {
      const w = p.x1 - p.x0, h = p.z1 - p.z0;
      ctx.save();
      ctx.globalAlpha = 0.35 + 0.35 * p.strength;
      ctx.fillStyle = WEIR_COLORS.water;
      ctx.fillRect(p.x0, p.z0, w, h);
      // Diagonal hatch drifting downstream (+z) so the patch reads as moving water, not a zone.
      ctx.beginPath(); ctx.rect(p.x0, p.z0, w, h); ctx.clip();
      ctx.globalAlpha = 0.25 + 0.5 * p.strength;
      ctx.strokeStyle = WEIR_COLORS.hatch; ctx.lineWidth = line(1.1);
      const step = Math.max(4, line(7)), drift = ((nowMs / 120) % step);
      ctx.beginPath();
      for (let d = -h - step + drift; d < w + step; d += step) { ctx.moveTo(p.x0 + d, p.z0); ctx.lineTo(p.x0 + d + h, p.z1); }
      ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = 0.5 + 0.5 * p.strength;
      ctx.strokeStyle = WEIR_COLORS.edge; ctx.lineWidth = line(1.6);
      ctx.strokeRect(p.x0, p.z0, w, h);
      ctx.restore();
    }
  },
});
