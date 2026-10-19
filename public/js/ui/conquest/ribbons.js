/**
 * Ribbon and medal presentation (design docs/design/conquest/ribbons/, toast
 * variant A "service ribbon bar"): the RIBBON EARNED toast under the ticket bar
 * for the local player's server `ribbon` events, and the ribbon bar / medal
 * badge builders the result screen shares. Names, details, counts and points
 * come from the event and the frozen contract; only colours and glyphs live here.
 * It imports only the contract and the icon table, so the result overlay (menu
 * path) can use the builders.
 */
import { MEDALS, RIBBONS } from '../../../../shared/conquest-contract.js';
import { svgIcon } from './icons.js';

export const RIBBON_TOAST_MS = 3200;
const QUEUE_MAX = 4;

/** Stripes (left to right, mirrored by the bar) and the centre glyph of each ribbon. */
export const RIBBON_ART = Object.freeze({
  spree:        { stripes: ['#5c1414', '#d8b04a', '#f3efe2', '#a31f1f'], icon: 'target' },
  medic:        { stripes: ['#1f5a30', '#f3efe2', '#2e8a49', '#f3efe2'], icon: 'revive' },
  anti_vehicle: { stripes: ['#2b2f33', '#c8752b', '#e8d9b0', '#5a3a1a'], icon: 'tank' },
  conquest:     { stripes: ['#16386b', '#f3efe2', '#2f6fc4', '#d8b04a'], icon: 'flag' },
  resupply:     { stripes: ['#4b4a1c', '#d8b04a', '#7a7a2a', '#f3efe2'], icon: 'support' },
  repair:       { stripes: ['#3a2a14', '#e09a2c', '#1e1e1e', '#f0c060'], icon: 'repair' },
  intel:        { stripes: ['#26214f', '#8d7ad8', '#f3efe2', '#4b3d9a'], icon: 'recon' },
  defender:     { stripes: ['#0f3d44', '#5fc3c9', '#f3efe2', '#1b6f78'], icon: 'shield' },
});
/** Medal metal and glyph; the suspension ribbon reuses its ribbon's stripes. */
export const MEDAL_ART = Object.freeze({
  valor: { metal: 'gold', icon: 'target' }, lifesaver: { metal: 'bronze', icon: 'revive' },
  tank_hunter: { metal: 'silver', icon: 'tank' }, conqueror: { metal: 'gold', icon: 'flag' },
  quartermaster: { metal: 'bronze', icon: 'support' }, mechanic: { metal: 'silver', icon: 'repair' },
  pathfinder: { metal: 'silver', icon: 'recon' }, guardian: { metal: 'bronze', icon: 'shield' },
  service: { metal: 'gold', icon: 'squad' },
});
const SERVICE_STRIPES = Object.freeze(['#16386b', '#d8b04a', '#a31f1f', '#f3efe2']);

/** CSS gradient of a ribbon's stripes, mirrored about the centre like a service ribbon. */
export function ribbonGradient(ribbonId) {
  const stripes = RIBBON_ART[ribbonId]?.stripes ?? SERVICE_STRIPES;
  const seq = [...stripes, ...stripes.slice(0, -1).reverse()];
  const step = 100 / seq.length;
  return `linear-gradient(90deg, ${seq.map((c, i) => `${c} ${(i * step).toFixed(2)}% ${((i + 1) * step).toFixed(2)}%`).join(', ')})`;
}

/**
 * Pure: the toast entry of a server `ribbon` event (or an end-of-match `medal`,
 * which the result screen normally covers) for the local player, or null.
 */
export function ribbonToastEntry(ev, selfId) {
  if (selfId == null || String(ev?.id) !== String(selfId)) return null;
  if (ev.kind === 'medal') {
    const medal = MEDALS[ev.medal];
    if (!medal) return null;
    const ribbon = medal.ribbon ? RIBBONS[medal.ribbon] : null;
    return { key: `medal:${ev.medal}`, ribbon: medal.ribbon, medal: ev.medal, eyebrow: 'MEDAL AWARDED', label: medal.label,
      detail: ribbon ? `${medal.count}× ${ribbon.label}` : `${medal.count} RIBBONS`, count: 1, pts: 0 };
  }
  const rule = ev.kind === 'ribbon' ? RIBBONS[ev.ribbon] : null;
  if (!rule) return null;
  const count = Math.max(1, ev.count | 0);
  return { key: `${ev.ribbon}:${count}`, ribbon: ev.ribbon, eyebrow: 'RIBBON EARNED', label: rule.label, detail: rule.detail, count,
    pts: Number.isFinite(ev.pts) ? Math.max(0, Math.trunc(ev.pts)) : 0 };
}

/**
 * Pure toast queue: one toast shows for RIBBON_TOAST_MS, the rest wait in
 * arrival order (bounded); a repeated key (the same ribbon count) is dropped.
 */
export function scheduleRibbonToast(state, entry, nowMs) {
  let { current, queue } = state;
  if (current && nowMs - current.at >= RIBBON_TOAST_MS) {
    current = queue[0] ? { ...queue[0], at: nowMs } : null;
    queue = queue.slice(1);
  }
  if (entry && current?.key !== entry.key && !queue.some(q => q.key === entry.key)) {
    if (!current) current = { ...entry, at: nowMs };
    else queue = [...queue, entry].slice(-QUEUE_MAX);
  }
  return { current, queue };
}

/** Small service ribbon bar (stripes + glyph); `earned` false draws the dashed placeholder. */
export function ribbonBar(doc, parent, ribbonId, { earned = true, className = 'cq-ribbon-bar' } = {}) {
  const bar = doc.createElement('span');
  bar.className = className;
  bar.dataset.ribbon = ribbonId;
  bar.dataset.earned = String(!!earned);
  if (earned) bar.style.setProperty('--ribbon', ribbonGradient(ribbonId));
  const icon = svgIcon(doc, RIBBON_ART[ribbonId]?.icon, 'cq-ribbon-glyph');
  if (icon) bar.appendChild(icon);
  parent?.appendChild(bar);
  return bar;
}

/** Medal badge: suspension ribbon over a round metal disc with the glyph. */
export function medalBadge(doc, parent, medalId) {
  const art = MEDAL_ART[medalId] ?? MEDAL_ART.service;
  const badge = doc.createElement('span');
  badge.className = 'cq-medal';
  badge.dataset.medal = medalId;
  badge.dataset.metal = art.metal;
  const strap = doc.createElement('span');
  strap.className = 'cq-medal-strap';
  strap.style.setProperty('--ribbon', ribbonGradient(MEDALS[medalId]?.ribbon ?? null));
  badge.appendChild(strap);
  const disc = doc.createElement('span');
  disc.className = 'cq-medal-disc';
  const icon = svgIcon(doc, art.icon, 'cq-medal-glyph');
  if (icon) disc.appendChild(icon);
  badge.appendChild(disc);
  parent?.appendChild(badge);
  return badge;
}

/** RIBBON EARNED toast under the ticket bar (and under a flag banner while one shows). */
export class RibbonToast {
  constructor(parent) {
    const doc = parent.ownerDocument ?? globalThis.document;
    this.doc = doc;
    this.root = doc.createElement('div');
    this.root.className = 'cq-ribbon';
    this.root.hidden = true;
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    this.slot = doc.createElement('span');
    this.slot.className = 'cq-ribbon-slot';
    this.text = doc.createElement('span');
    this.text.className = 'cq-ribbon-text';
    this.eyebrow = doc.createElement('span');
    this.eyebrow.className = 'cq-ribbon-eyebrow';
    this.eyebrow.textContent = 'RIBBON EARNED';
    this.title = doc.createElement('span');
    this.title.className = 'cq-ribbon-title';
    this.detail = doc.createElement('span');
    this.detail.className = 'cq-ribbon-detail';
    this.text.append(this.eyebrow, this.title, this.detail);
    this.pts = doc.createElement('span');
    this.pts.className = 'cq-ribbon-pts';
    this.count = doc.createElement('span');
    this.count.className = 'cq-ribbon-count';
    this.glint = doc.createElement('span');
    this.glint.className = 'cq-ribbon-glint';
    this.root.append(this.slot, this.text, this.pts, this.count, this.glint);
    parent.appendChild(this.root);
    this.state = { current: null, queue: [] };
    this._shown = null;
  }

  push(entry, nowMs) { this.state = scheduleRibbonToast(this.state, entry, nowMs); this.render(); }
  update(nowMs) { this.state = scheduleRibbonToast(this.state, null, nowMs); this.render(); }

  render() {
    const toast = this.state.current;
    if (toast === this._shown) return;
    this._shown = toast;
    this.root.hidden = !toast;
    if (!toast) return;
    this.root.dataset.ribbon = toast.ribbon ?? '';
    this.slot.textContent = '';
    if (toast.medal) medalBadge(this.doc, this.slot, toast.medal);
    else ribbonBar(this.doc, this.slot, toast.ribbon);
    this.eyebrow.textContent = toast.eyebrow;
    this.title.textContent = toast.label;
    this.detail.textContent = toast.detail;
    this.pts.textContent = toast.pts > 0 ? `+${toast.pts}` : '';
    this.count.textContent = toast.count > 1 ? `×${toast.count}` : '';
    this.root.classList.remove('is-in');
    void this.root.offsetWidth;
    this.root.classList.add('is-in');
  }

  clear() { this.state = { current: null, queue: [] }; this.render(); }
}
