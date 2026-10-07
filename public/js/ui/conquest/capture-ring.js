/** Capture ring under the crosshair while the local player stands inside a flag zone. */
import { el } from '../hud-support.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RADIUS = 30;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function svg(documentRef, tag, attrs, parent) {
  const node = documentRef.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

export class CaptureRing {
  constructor(parent) {
    const doc = globalThis.document;
    this.root = el('div', 'cq-ring', parent);
    this.root.hidden = true;
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    const dial = el('div', 'cq-ring-dial', this.root);
    const graphic = svg(doc, 'svg', { viewBox: '0 0 72 72', class: 'cq-ring-svg', 'aria-hidden': 'true' }, dial);
    svg(doc, 'circle', { cx: 36, cy: 36, r: RADIUS, class: 'cq-ring-track' }, graphic);
    this.arc = svg(doc, 'circle', { cx: 36, cy: 36, r: RADIUS, class: 'cq-ring-arc',
      'stroke-dasharray': `${CIRCUMFERENCE.toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`, transform: 'rotate(-90 36 36)' }, graphic);
    this.letter = el('span', 'cq-ring-letter', dial);
    this.label = el('div', 'cq-ring-label', this.root);
    this.counts = el('div', 'cq-ring-counts', this.root);
    this.ownCount = el('b', 'cq-ring-own', this.counts);
    el('span', 'cq-ring-vs', this.counts).textContent = 'vs';
    this.enemyCount = el('b', 'cq-ring-enemy', this.counts);
    this._key = '';
  }

  update(model) {
    if (!model) { if (!this.root.hidden) this.root.hidden = true; this._key = ''; return; }
    this.root.hidden = false;
    const key = `${model.flagId}|${model.label}|${model.own}|${model.enemy}|${model.tone}|${model.lean}`;
    if (key !== this._key) {
      this._key = key;
      this.letter.textContent = model.flagId;
      this.label.textContent = model.label;
      this.ownCount.textContent = String(model.own);
      this.enemyCount.textContent = String(model.enemy);
      this.root.dataset.tone = model.tone;
      this.root.dataset.lean = model.lean;
      this.root.dataset.owner = model.owner;
      this.root.setAttribute('aria-label', `${model.label} ${model.flagId} · ${model.own} versus ${model.enemy}`);
    }
    this.arc.setAttribute('stroke-dashoffset', (CIRCUMFERENCE * (1 - model.fill)).toFixed(2));
  }
}
