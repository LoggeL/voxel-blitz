/**
 * Squad order chip and the squad radio feed (design A,
 * docs/design/conquest/orders/): SQUAD ORDER · ATTACK C – IRON BRIDGE 240 M
 * above the minimap, and a few short radio lines above it (callouts of the
 * own squad, requests the own kit can answer, answers to own requests).
 * Models come from squadOrderModel() and radioLine() in comms-state.js.
 */
import { el } from '../hud-support.js';
import { svgIcon } from './icons.js';

/** Radio lines stay this long; at most RADIO_LINES show at once. */
export const RADIO_LINE_MS = 4500;
export const RADIO_LINES = 3;

export class OrderChip {
  constructor(parent) {
    this.root = el('div', 'cq-order', parent);
    this.root.hidden = true;
    this.root.setAttribute('aria-live', 'polite');
    this.icon = el('i', 'cq-order-icon', this.root);
    const text = el('div', 'cq-order-text', this.root);
    this.head = el('small', 'cq-order-head', text);
    const line = el('div', 'cq-order-line', text);
    this.title = el('b', 'cq-order-title', line);
    this.name = el('span', 'cq-order-name', line);
    this.distance = el('em', 'cq-order-distance', line);
    this.key = '';
  }

  update(model) {
    if (!model) { this.root.hidden = true; return; }
    this.root.hidden = false;
    if (this.root.dataset.stance !== model.stance) this.root.dataset.stance = model.stance;
    const head = model.leader ? 'YOUR ORDER' : 'SQUAD ORDER';
    if (this.head.textContent !== head) this.head.textContent = head;
    if (this.title.textContent !== model.title) this.title.textContent = model.title;
    const name = `– ${model.name}`;
    if (this.name.textContent !== name) this.name.textContent = name;
    const distance = model.distance == null ? '' : `${model.distance} M`;
    if (this.distance.textContent !== distance) this.distance.textContent = distance;
    const glyph = model.stance === 'defend' ? 'defend' : 'attack';
    if (this.key !== glyph) {
      this.key = glyph;
      this.icon.textContent = '';
      const icon = svgIcon(globalThis.document, glyph, 'cq-order-glyph');
      if (icon) this.icon.appendChild(icon);
    }
  }
}

export class RadioFeed {
  constructor(parent) {
    this.root = el('ol', 'cq-radio', parent);
    this.root.hidden = true;
    this.root.setAttribute('aria-live', 'polite');
    this.root.setAttribute('aria-label', 'Squad radio');
    this.lines = [];
  }

  push(line, now) {
    if (!line?.text) return;
    // The same line twice in a row (event replay) refreshes instead of stacking.
    const last = this.lines.at(-1);
    if (last && last.text === line.text && now - last.at < 1500) { last.at = now; return; }
    this.lines.push({ ...line, at: now });
    while (this.lines.length > RADIO_LINES) this.lines.shift();
    this._draw();
  }

  update(now) {
    const before = this.lines.length;
    this.lines = this.lines.filter(line => now - line.at < RADIO_LINE_MS && now >= line.at - 1000);
    if (this.lines.length !== before) this._draw();
  }

  clear() { this.lines = []; this._draw(); }

  _draw() {
    this.root.textContent = '';
    for (const line of this.lines) {
      const item = el('li', 'cq-radio-line', this.root);
      item.dataset.tone = line.tone || 'squad';
      item.textContent = line.text;
    }
    this.root.hidden = !this.lines.length;
  }
}
