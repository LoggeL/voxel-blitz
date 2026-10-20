/**
 * Iron Bridge collapse on the Conquest HUD (docs/conquest.md "Iron Bridge
 * collapse"; design docs/design/conquest/bridge/). Everything here reads the
 * authoritative bridge state (match.conquest.br decoded into cq.bridge) or a
 * server `bridge` event; nothing is predicted.
 *
 *   damaged  amber banner "IRON BRIDGE DAMAGED · SUPPORTS AT n %", amber
 *            outline over the span on the maps, warning badge on the C chip
 *   failing  amber banner "IRON BRIDGE COLLAPSING" held until the fall with a
 *            draining countdown bar, pulsing hazard stripes over the span
 *   down     red banner "IRON BRIDGE DESTROYED · VEHICLES CROSS AT THE FORDS",
 *            river water and break marks where the span was, "· DOWN" after
 *            the C name on the full map, red badge on the C chip
 */
import { BRIDGE_STAGE, IRON_BRIDGE, IRON_BRIDGE_RULES } from '../../../../shared/conquest-bridge.js';

export const BRIDGE_COLORS = Object.freeze({ hazard: '#ffb020', danger: '#ff4b4b', water: '#3f79a6', ink: '#14100a', mark: '#eef3f6' });
const BANNER_KEY = 'bridge';

/** True when the HUD's map has the Iron Bridge crossing (Frontier). */
export const hasIronBridge = cq => (cq?.meta?.crossings ?? []).some(c => c?.id === IRON_BRIDGE.crossing);

/**
 * Banner for a `bridge` event, or null. The failing banner holds until the
 * fall and carries the countdown; each later stage supersedes the earlier
 * banners so a queued "collapsing" never shows after "destroyed".
 */
export function bridgeBanner(ev, nowMs = 0, rules = IRON_BRIDGE_RULES) {
  if (ev?.kind !== 'bridge' || ev.bridge !== IRON_BRIDGE.id) return null;
  const supersedes = [`${BANNER_KEY}:damaged`, `${BANNER_KEY}:failing`];
  switch (ev.name) {
    case 'damaged':
      return { key: `${BANNER_KEY}:damaged`, tone: 'hazard', title: 'IRON BRIDGE DAMAGED',
        detail: `SUPPORTS AT ${Math.max(0, Math.round(Number(ev.integrity) || 0))} %`, priority: 2 };
    case 'failing': {
      const until = Number.isFinite(ev.fallAt) ? ev.fallAt : nowMs + rules.warnMs;
      return { key: `${BANNER_KEY}:failing`, tone: 'hazard', title: 'IRON BRIDGE COLLAPSING', detail: 'GET OFF THE SPAN',
        priority: 7, holdMs: Math.max(1200, until - nowMs + 400), countdown: { until, total: rules.warnMs }, supersedes };
    }
    case 'down':
      return { key: `${BANNER_KEY}:down`, tone: 'danger', title: 'IRON BRIDGE DESTROYED', detail: 'VEHICLES CROSS AT THE FORDS',
        priority: 8, holdMs: 4200, supersedes };
    default:
      return null;
  }
}

/**
 * The collapsing banner from the snapshot's bridge state (`cq.bridge`, stage
 * failing), or null: a player who joins or reconnects during the groan never
 * saw the `failing` event. `key` names this collapse (its fall time), so the
 * HUD pushes it once whichever of the event and the snapshot arrives first.
 */
export function bridgeStateBanner(cq, nowMs = 0, rules = IRON_BRIDGE_RULES) {
  const bridge = cq?.bridge;
  if (!hasIronBridge(cq) || bridge?.stage !== BRIDGE_STAGE.failing) return null;
  const banner = bridgeBanner({ kind: 'bridge', bridge: IRON_BRIDGE.id, name: 'failing', fallAt: bridge.fallAt }, nowMs, rules);
  return banner && { banner, key: Number.isFinite(bridge.fallAt) ? Math.round(bridge.fallAt) : 'failing' };
}

/** Countdown text and bar share of a banner at `nowMs`: { seconds, fraction, label? } or null. */
export function bannerCountdown(banner, nowMs) {
  const cd = banner?.countdown;
  if (!cd || !Number.isFinite(cd.until)) return null;
  const left = Math.max(0, cd.until - nowMs);
  return { seconds: Math.ceil(left / 1000), fraction: Math.max(0, Math.min(1, left / Math.max(1, cd.total))), ...(cd.label ? { label: cd.label } : {}) };
}

/** Badge on the bridge flag's top-bar chip: { flag, badge: 'hazard' (damaged, failing) | 'down' }, or null. */
export function bridgeChipBadge(cq) {
  const stage = cq?.bridge?.stage | 0;
  if (!hasIronBridge(cq) || stage <= BRIDGE_STAGE.intact) return null;
  return { flag: IRON_BRIDGE.flag, badge: stage >= BRIDGE_STAGE.down ? 'down' : 'hazard' };
}

/** Map overlay model: the span box, stage name and the note after the flag name, or null while intact. */
export function bridgeMapModel(cq) {
  const bridge = cq?.bridge;
  if (!hasIronBridge(cq) || !bridge || !(bridge.stage > BRIDGE_STAGE.intact)) return null;
  const stage = bridge.stage;
  return { stage, name: bridge.name, span: IRON_BRIDGE.span, axisZ: IRON_BRIDGE.z, flag: IRON_BRIDGE.flag,
    note: stage >= BRIDGE_STAGE.down ? 'DOWN' : stage === BRIDGE_STAGE.failing ? 'COLLAPSING' : null,
    noteColor: stage >= BRIDGE_STAGE.down ? BRIDGE_COLORS.danger : BRIDGE_COLORS.hazard };
}

/**
 * Paint the overlay in world space (the context already maps world x/z to
 * canvas, as the minimap and the full map do before their markers).
 * `px` is canvas px per metre so strokes keep a readable width.
 */
export function paintBridge(ctx, model, { nowMs = 0, px = 1 } = {}) {
  if (!ctx || !model) return;
  const s = model.span;
  const x0 = s.x0, x1 = s.x1 + 1, z0 = s.z0, z1 = s.z1 + 1;
  const w = x1 - x0, h = z1 - z0;
  const line = m => Math.max(m / Math.max(px, 1e-3), 0.25);
  ctx.save();
  if (model.stage >= BRIDGE_STAGE.down) {
    // The river runs through where the deck was; jagged white break marks on both bank ends of the road.
    ctx.fillStyle = BRIDGE_COLORS.water;
    ctx.fillRect(x0 + 0.5, z0, w - 1, h);
    ctx.strokeStyle = BRIDGE_COLORS.mark; ctx.lineWidth = line(1.6); ctx.lineJoin = 'miter';
    const teeth = 4, step = h / teeth, tooth = Math.min(2.2, w / 5);
    for (const [edge, dir] of [[x0, 1], [x1, -1]]) {
      ctx.beginPath();
      for (let i = 0; i <= teeth; i++) {
        const x = edge + (i % 2 ? dir * tooth : 0), z = z0 + i * step;
        if (i) ctx.lineTo(x, z); else ctx.moveTo(x, z);
      }
      ctx.stroke();
    }
  } else {
    // Amber hazard: outline while damaged, pulsing black and amber stripes while failing.
    if (model.stage === BRIDGE_STAGE.failing) {
      const pulse = 0.55 + 0.45 * Math.abs(Math.sin(nowMs / 180));
      ctx.globalAlpha = pulse;
      ctx.beginPath(); ctx.rect(x0, z0, w, h); ctx.clip();
      ctx.fillStyle = BRIDGE_COLORS.ink; ctx.fillRect(x0, z0, w, h);
      ctx.strokeStyle = BRIDGE_COLORS.hazard; ctx.lineWidth = Math.min(w, h) / 6;
      ctx.beginPath();
      for (let d = -h; d < w + h; d += Math.min(w, h) / 3) { ctx.moveTo(x0 + d, z0); ctx.lineTo(x0 + d - h, z1); }
      ctx.stroke();
      ctx.restore(); ctx.save();
    }
    ctx.strokeStyle = BRIDGE_COLORS.hazard; ctx.lineWidth = line(2);
    ctx.strokeRect(x0, z0, w, h);
  }
  ctx.restore();
}

/**
 * Screen-space decoration around the bridge flag's diamond (the flag sits on
 * the span, so the world overlay hides under its marker on small maps):
 * break marks on the road either side of the diamond and a stage badge at its
 * lower right. `c` is the diamond centre, `size` its half diagonal in canvas
 * px, `dir` the canvas direction of world +x (the road axis), `scale` the
 * canvas px per CSS px.
 */
export function paintBridgeFlag(ctx, model, c, { size = 12, dir = { x: 1, y: 0 }, nowMs = 0, scale = 1 } = {}) {
  if (!ctx || !model || !c) return;
  const len = Math.hypot(dir.x, dir.y) || 1;
  const ux = dir.x / len, uy = dir.y / len, nx = -uy, ny = ux;
  const down = model.stage >= BRIDGE_STAGE.down, failing = model.stage === BRIDGE_STAGE.failing;
  ctx.save();
  if (down || failing) {
    const alpha = failing ? 0.55 + 0.45 * Math.abs(Math.sin(nowMs / 180)) : 1;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = down ? BRIDGE_COLORS.mark : BRIDGE_COLORS.hazard;
    ctx.lineWidth = 2 * scale; ctx.lineJoin = 'miter';
    const half = 5 * scale, tooth = 2.2 * scale;
    for (const side of [-1, 1]) {
      const bx = c.x + ux * side * (size + 5 * scale), by = c.y + uy * side * (size + 5 * scale);
      ctx.beginPath();
      for (let i = 0; i <= 4; i++) {
        const t = -half + (i * 2 * half) / 4, k = (i % 2 ? tooth : 0) * side;
        const x = bx + nx * t + ux * k, y = by + ny * t + uy * k;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.lineWidth = 4 * scale; ctx.strokeStyle = '#081016c0'; ctx.stroke();
      ctx.lineWidth = 2 * scale; ctx.strokeStyle = down ? BRIDGE_COLORS.mark : BRIDGE_COLORS.hazard; ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  // Stage badge: an amber (red once down) warning triangle at the diamond's lower right.
  const r = 5.5 * scale, bx = c.x + size * 0.62, by = c.y + size * 0.55;
  ctx.beginPath();
  ctx.moveTo(bx, by - r); ctx.lineTo(bx + r * 1.05, by + r * 0.8); ctx.lineTo(bx - r * 1.05, by + r * 0.8); ctx.closePath();
  ctx.fillStyle = down ? BRIDGE_COLORS.danger : BRIDGE_COLORS.hazard; ctx.fill();
  ctx.lineWidth = 1.2 * scale; ctx.strokeStyle = '#081016'; ctx.stroke();
  ctx.fillStyle = '#081016';
  ctx.font = `900 ${7 * scale}px "Rajdhani", system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('!', bx, by + r * 0.22);
  ctx.restore();
}
