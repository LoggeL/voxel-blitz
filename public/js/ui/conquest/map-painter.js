/**
 * Canvas painting shared by the minimap, the full map and the deploy map.
 * Inputs are mapItems() from conquest-hud-state.js (authoritative positions
 * only) plus the map statics; the painter never decides what is visible.
 */
import { CQ_COLORS } from '../conquest-hud-state.js';
import { drawIcon } from './icons.js';

export const OVERVIEW_URL = './assets/maps/frontier-overview.png';
const TONE = Object.freeze({ own: CQ_COLORS.own, enemy: CQ_COLORS.enemy, neutral: CQ_COLORS.neutral,
  squad: CQ_COLORS.squad, spotted: CQ_COLORS.spotted, self: CQ_COLORS.self, contested: CQ_COLORS.contested });
export const toneColor = rel => TONE[rel] ?? TONE.neutral;

let overview = null;
/** One shared overview image (top-down render of the whole map square). */
export function overviewImage(url = OVERVIEW_URL) {
  if (typeof Image !== 'function') return null;
  if (!overview || overview.dataset?.src !== url) {
    overview = new Image();
    overview.decoding = 'async';
    overview.src = url;
    if (overview.dataset) overview.dataset.src = url;
  }
  return overview;
}
export const imageReady = image => !!image && image.complete && image.naturalWidth > 0;

/** Terrain fallback: flat ground, the combat area and road polylines from mapMeta.conquest. */
export function paintVectorBase(ctx, meta, toCanvas, scale) {
  ctx.fillStyle = '#2c3a2c';
  ctx.fillRect(-1e4, -1e4, 2e4, 2e4);
  const area = meta?.combatArea;
  if (area) {
    const a = toCanvas(area.minX, area.minZ), b = toCanvas(area.maxX, area.maxZ);
    ctx.fillStyle = '#3c4b35';
    ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  }
  for (const road of Array.isArray(meta?.roads) ? meta.roads : []) {
    const points = Array.isArray(road.points) ? road.points : [];
    if (points.length < 2) continue;
    ctx.beginPath();
    points.forEach((p, i) => { const c = toCanvas(p[0], p.length >= 3 ? p[2] : p[1]); if (i) ctx.lineTo(c.x, c.y); else ctx.moveTo(c.x, c.y); });
    ctx.strokeStyle = road.kind === 'paved' ? '#8e8a7e' : '#7a6a4f';
    ctx.lineWidth = Math.max(1, (road.width || 6) * scale);
    ctx.stroke();
  }
  for (const crossing of Array.isArray(meta?.crossings) ? meta.crossings : []) {
    const c = toCanvas(crossing.x, crossing.z);
    ctx.fillStyle = crossing.kind === 'bridge' ? '#b8b1a0' : '#5d8fb0';
    ctx.fillRect(c.x - 3, c.y - 3, 6, 6);
  }
}

/** Flag zone ring with owner fill, progress arc toward the leaning side and the letter. */
export function paintFlag(ctx, item, c, radiusPx, { letterSize = 12, pulse = 0 } = {}) {
  const color = toneColor(item.rel);
  ctx.save();
  ctx.beginPath();
  ctx.arc(c.x, c.y, Math.max(radiusPx, 4), 0, Math.PI * 2);
  ctx.fillStyle = `${color}33`;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = item.contested ? TONE.contested : `${color}cc`;
  if (item.contested) ctx.setLineDash([3, 3]);
  ctx.stroke();
  ctx.setLineDash([]);
  if (item.fill > 0 && item.fill < 0.999) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, Math.max(radiusPx, 4) + 2.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * item.fill);
    ctx.strokeStyle = toneColor(item.lean);
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  const size = letterSize + 6;
  ctx.translate(c.x, c.y);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = '#0d151bf0';
  ctx.fillRect(-size / 2, -size / 2, size, size);
  ctx.lineWidth = 2 + pulse;
  ctx.strokeStyle = item.contested ? TONE.contested : color;
  ctx.strokeRect(-size / 2, -size / 2, size, size);
  ctx.rotate(-Math.PI / 4);
  ctx.fillStyle = color;
  ctx.font = `800 ${letterSize}px "Rajdhani", "Barlow Condensed", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(item.label, 0, 1);
  ctx.restore();
}

/** Units: self arrow, squad (green) and team (blue) dots, downed crosses, spotted red diamonds, hull glyphs. */
export function paintUnit(ctx, item, c, heading = 0, size = 1) {
  ctx.save();
  ctx.translate(c.x, c.y);
  switch (item.kind) {
    case 'self':
      ctx.rotate(-heading);
      ctx.beginPath(); ctx.moveTo(0, -8 * size); ctx.lineTo(5.5 * size, 6 * size); ctx.lineTo(0, 3 * size); ctx.lineTo(-5.5 * size, 6 * size); ctx.closePath();
      ctx.fillStyle = TONE.self; ctx.strokeStyle = '#0b1218'; ctx.lineWidth = 2; ctx.stroke(); ctx.fill();
      break;
    case 'squad':
    case 'team': {
      const r = (item.kind === 'squad' ? 4 : 3) * size;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = toneColor(item.rel); ctx.strokeStyle = '#0b1218'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.fill();
      break;
    }
    case 'down':
      ctx.fillStyle = CQ_COLORS.down;
      ctx.fillRect(-1.5 * size, -5 * size, 3 * size, 10 * size); ctx.fillRect(-5 * size, -1.5 * size, 10 * size, 3 * size);
      break;
    case 'spotted':
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = TONE.spotted; ctx.strokeStyle = '#1a0606'; ctx.lineWidth = 1.5;
      ctx.fillRect(-4 * size, -4 * size, 8 * size, 8 * size); ctx.strokeRect(-4 * size, -4 * size, 8 * size, 8 * size);
      break;
    case 'vehicle': {
      const color = toneColor(item.rel);
      ctx.beginPath(); ctx.arc(0, 0, 8 * size, 0, Math.PI * 2); ctx.fillStyle = '#0b1218d9'; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = color; ctx.stroke();
      drawIcon(ctx, item.vehicleType || 'tank', 0, 0, 13 * size, color);
      break;
    }
    case 'hq': {
      const color = toneColor(item.rel);
      ctx.fillStyle = '#0b1218e6'; ctx.fillRect(-9 * size, -9 * size, 18 * size, 18 * size);
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.strokeRect(-9 * size, -9 * size, 18 * size, 18 * size);
      drawIcon(ctx, 'hq', 0, 0, 13 * size, color);
      break;
    }
    default: break;
  }
  ctx.restore();
}

const ORDER = Object.freeze({ hq: 0, flag: 1, vehicle: 2, team: 3, squad: 4, down: 5, spotted: 6, self: 7 });
export const sortItems = items => [...items].sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9));
