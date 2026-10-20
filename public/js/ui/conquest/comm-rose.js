/**
 * The comm rose (design A, docs/design/conquest/orders/orders-a-reference.png):
 * a segmented ring of eight wedges around a COMMS hub. Hold U (or D-pad
 * right on a pad) and push the mouse / right stick toward a wedge; releasing
 * sends it. On touch the COMMS button opens it and a tap on a wedge sends.
 * Segments come from commRoseModel(); a disabled wedge (ORDER without a flag
 * in sight, NEED RIDE while seated...) never sends.
 */
import { el } from '../hud-support.js';
import { svgIcon } from './icons.js';
import { ROSE_DEADZONE_PX, roseIndexAt } from './comms-state.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const OUTER = 98, INNER = 47, LABEL_R = 73, GAP_DEG = 1.4;
/** Stick deflection maps to this many px of mouse travel (same dead zone for both). */
const STICK_PX = 60;

const polar = (deg, r) => {
  const a = deg * Math.PI / 180;
  return [r * Math.sin(a), -r * Math.cos(a)];
};
/** SVG path of one annular wedge centred on `centre` degrees (clockwise from the top). */
export function wedgePath(centre, span, outer = OUTER, inner = INNER, gap = GAP_DEG) {
  const a0 = centre - span / 2 + gap, a1 = centre + span / 2 - gap;
  const [x0, y0] = polar(a0, outer), [x1, y1] = polar(a1, outer);
  const [x2, y2] = polar(a1, inner), [x3, y3] = polar(a0, inner);
  const f = n => n.toFixed(2);
  return `M${f(x0)} ${f(y0)}A${outer} ${outer} 0 0 1 ${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}A${inner} ${inner} 0 0 0 ${f(x3)} ${f(y3)}Z`;
}

export class CommRose {
  constructor(parent, { onPick = () => {}, onClose = () => {} } = {}) {
    this.onPick = onPick;
    this.onClose = onClose;
    this.root = el('section', 'cq-rose', parent);
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Comm rose');
    this.dial = el('div', 'cq-rose-dial', this.root);
    const doc = globalThis.document;
    this.svg = doc?.createElementNS ? doc.createElementNS(SVG_NS, 'svg') : null;
    if (this.svg) {
      this.svg.setAttribute('viewBox', '-100 -100 200 200');
      this.svg.setAttribute('class', 'cq-rose-svg');
      this.svg.setAttribute('aria-hidden', 'true');
      this.dial.appendChild(this.svg);
    }
    this.hub = el('button', 'cq-rose-hub', this.dial);
    this.hub.type = 'button';
    this.hub.setAttribute('aria-label', 'Close the comm rose');
    el('i', 'cq-rose-reticle', this.hub);
    this.hubTitle = el('b', 'cq-rose-title', this.hub);
    this.hubTitle.textContent = 'COMMS';
    this.hubSub = el('span', 'cq-rose-sub', this.hub);
    this.hub.addEventListener?.('click', () => this.close('cancel'));
    this.wedges = [];
    this.labels = [];
    this.model = null;
    this.index = -1;
    this.vec = { x: 0, y: 0 };
    this.mode = 'hold';
    this.open = false;
  }

  /** Build (or rebuild for another segment count) the wedges and their labels. */
  _build(count) {
    if (this.wedges.length === count) return;
    for (const node of [...this.wedges, ...this.labels]) node.remove?.();
    this.wedges = []; this.labels = [];
    const span = 360 / count;
    for (let i = 0; i < count; i++) {
      const centre = i * span;
      let wedge = null;
      if (this.svg) {
        wedge = globalThis.document.createElementNS(SVG_NS, 'path');
        wedge.setAttribute('d', wedgePath(centre, span));
        wedge.setAttribute('class', 'cq-rose-wedge');
        this.svg.appendChild(wedge);
      }
      const label = el('button', 'cq-rose-seg', this.dial);
      label.type = 'button';
      const [x, y] = polar(centre, LABEL_R);
      label.style.left = `${(50 + x / 2).toFixed(2)}%`;
      label.style.top = `${(50 + y / 2).toFixed(2)}%`;
      label.icon = el('i', 'cq-rose-icon', label);
      label.text = el('span', 'cq-rose-label', label);
      label.note = el('small', 'cq-rose-note', label);
      // Pointer (touch, unlocked mouse): hover highlights, a tap / click sends.
      const index = i;
      label.addEventListener?.('pointerenter', () => this.highlight(index));
      label.addEventListener?.('click', event => { event?.preventDefault?.(); this.highlight(index); this.pick(); });
      wedge?.addEventListener?.('pointerenter', () => this.highlight(index));
      wedge?.addEventListener?.('click', () => { this.highlight(index); this.pick(); });
      this.wedges.push(wedge ?? { setAttribute() {}, remove() {}, dataset: {} });
      this.labels.push(label);
    }
  }

  /** Open with a model; `mode` 'hold' (release sends) or 'tap' (touch: a tap sends). */
  show(model, { mode = 'hold' } = {}) {
    this.mode = mode;
    this.vec = { x: 0, y: 0 };
    this.index = -1;
    this.open = true;
    this.root.hidden = false;
    this.root.dataset.mode = mode;
    this.setModel(model);
    this.highlight(-1);
  }

  setModel(model) {
    this.model = model;
    const segments = model?.segments ?? [];
    this._build(segments.length);
    segments.forEach((segment, i) => {
      const label = this.labels[i], wedge = this.wedges[i];
      const enabled = String(segment.enabled !== false);
      if (label.dataset.kind !== segment.kind) label.dataset.kind = segment.kind;
      if (wedge.dataset) wedge.dataset.kind = segment.kind;
      if (label.dataset.enabled !== enabled) { label.dataset.enabled = enabled; wedge.setAttribute('data-enabled', enabled); }
      if (label.glyph !== segment.icon) {
        label.glyph = segment.icon;
        label.icon.textContent = '';
        const icon = svgIcon(globalThis.document, segment.icon, 'cq-rose-glyph');
        if (icon) label.icon.appendChild(icon);
      }
      if (label.text.textContent !== segment.label) label.text.textContent = segment.label;
      if (label.note.textContent !== (segment.note || '')) label.note.textContent = segment.note || '';
      label.setAttribute?.('aria-label', `${segment.label}${segment.note ? ` (${segment.note})` : ''}`);
      label.disabled = segment.enabled === false;
    });
    const sub = this.mode === 'tap' ? 'TAP TO SEND' : 'RELEASE TO SEND';
    if (this.hubSub.textContent !== sub) this.hubSub.textContent = sub;
  }

  /** Mark segment `index` (-1 none) as the one a release sends. */
  highlight(index) {
    this.index = index;
    this.labels.forEach((label, i) => {
      const on = String(i === index);
      if (label.dataset.selected !== on) { label.dataset.selected = on; this.wedges[i].setAttribute('data-selected', on); }
    });
  }

  /** Raw mouse pixels (locked pointer): the deflection picks the segment. */
  steer(dx, dy) {
    if (!this.open) return;
    const limit = ROSE_DEADZONE_PX * 4;
    this.vec.x += dx; this.vec.y += dy;
    const len = Math.hypot(this.vec.x, this.vec.y);
    if (len > limit) { this.vec.x *= limit / len; this.vec.y *= limit / len; }
    this.highlight(roseIndexAt(this.vec.x, this.vec.y, ROSE_DEADZONE_PX, this.labels.length));
  }

  /** Pad right stick: the stick direction picks; a released stick keeps the last pick. */
  stick(x, y) {
    if (!this.open || Math.hypot(x, y) < 0.45) return;
    const index = roseIndexAt(x * STICK_PX, y * STICK_PX, ROSE_DEADZONE_PX, this.labels.length);
    if (index >= 0) this.highlight(index);
  }

  /** The highlighted segment, or null. */
  get selected() { return this.index >= 0 ? this.model?.segments?.[this.index] ?? null : null; }

  /** Send the highlighted segment (when enabled) and close. Returns the picked segment or null. */
  pick() {
    if (!this.open) return null;
    const segment = this.selected;
    const ok = !!segment && segment.enabled !== false;
    this.close(ok ? 'pick' : 'cancel');
    if (ok) this.onPick(segment);
    return ok ? segment : null;
  }

  close(reason = 'cancel') {
    if (!this.open) return false;
    this.open = false;
    this.root.hidden = true;
    this.highlight(-1);
    this.onClose(reason);
    return true;
  }
}
