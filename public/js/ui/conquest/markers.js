/**
 * World-layer markers in screen space: flag markers (letter, distance,
 * progress arc, edge clamp with a direction arrow, contested pulse) and unit
 * markers (squad names, team dots, downed-teammate crosses, spotted-enemy
 * diamonds). Positions come from flagMarkerModels / unitMarkerModels.
 */
import { el } from '../hud-support.js';
import { svgIcon } from './icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ARC_R = 15;
const ARC_C = 2 * Math.PI * ARC_R;
/** On-screen flag markers within this many px of the crosshair dim. */
const NEAR_CROSSHAIR_PX = 64;
/** Unit labels within this many px of a screen side align away from it. */
const EDGE_LABEL_PX = 70;
const UNIT_SHIFT = Object.freeze({ start: '0%', center: '-50%', end: '-100%' });

function flagNode(parent) {
  const doc = globalThis.document;
  const node = el('div', 'cq-flag-marker', parent);
  const graphic = doc.createElementNS(SVG_NS, 'svg');
  graphic.setAttribute('viewBox', '0 0 40 40');
  graphic.setAttribute('class', 'cq-flag-marker-svg');
  graphic.setAttribute('aria-hidden', 'true');
  const diamond = doc.createElementNS(SVG_NS, 'rect');
  for (const [k, v] of Object.entries({ x: 9, y: 9, width: 22, height: 22, rx: 2, transform: 'rotate(45 20 20)', class: 'cq-flag-marker-diamond' })) diamond.setAttribute(k, String(v));
  const arc = doc.createElementNS(SVG_NS, 'circle');
  for (const [k, v] of Object.entries({ cx: 20, cy: 20, r: ARC_R + 3, class: 'cq-flag-marker-arc', transform: 'rotate(-90 20 20)' })) arc.setAttribute(k, String(v));
  graphic.appendChild(arc);
  graphic.appendChild(diamond);
  node.appendChild(graphic);
  node.arc = arc;
  node.letter = el('span', 'cq-flag-marker-letter', node);
  node.distance = el('span', 'cq-flag-marker-distance', node);
  node.arrow = el('i', 'cq-flag-marker-arrow', node);
  return node;
}

export class WorldMarkers {
  constructor(parent) {
    this.root = el('div', 'cq-world', parent);
    this.root.setAttribute('aria-hidden', 'true');
    this.flags = new Map();
    this.units = [];
  }

  update(flagModels, unitModels) {
    const seen = new Set();
    const viewWidth = globalThis.innerWidth || 0, viewHeight = globalThis.innerHeight || 0;
    for (const m of flagModels) {
      seen.add(m.id);
      let n = this.flags.get(m.id);
      if (!n) { n = flagNode(this.root); this.flags.set(m.id, n); n.letter.textContent = m.id; }
      n.hidden = m.inside;
      n.style.transform = `translate(${m.x.toFixed(1)}px, ${m.y.toFixed(1)}px)`;
      n.dataset.owner = m.owner;
      n.dataset.lean = m.lean;
      n.dataset.contested = String(m.contested);
      n.dataset.edge = String(m.edge);
      // A world-anchored flag behind the crosshair dims so the reticle and its readouts stay legible.
      const near = !m.edge && viewWidth > 0 && Math.abs(m.x - viewWidth / 2) < NEAR_CROSSHAIR_PX && Math.abs(m.y - viewHeight / 2) < NEAR_CROSSHAIR_PX;
      if (n.dataset.near !== String(near)) n.dataset.near = String(near);
      n.dataset.moving = m.moving || '';
      const dist = `${m.distance} m`;
      if (n.distance.textContent !== dist) n.distance.textContent = dist;
      const r = (ARC_R + 3) * 2 * Math.PI;
      n.arc.setAttribute('stroke-dasharray', `${(r * m.fill).toFixed(2)} ${r.toFixed(2)}`);
      n.arrow.style.transform = m.edge ? `rotate(${(m.angle * 180 / Math.PI).toFixed(1)}deg)` : '';
    }
    for (const [id, n] of this.flags) if (!seen.has(id)) { n.remove(); this.flags.delete(id); }
    let i = 0;
    for (const m of unitModels) {
      let n = this.units[i];
      if (!n) {
        n = el('div', 'cq-unit-marker', this.root);
        n.glyph = el('i', 'cq-unit-glyph', n);
        n.label = el('span', 'cq-unit-label', n);
        this.units.push(n);
      }
      i++;
      n.hidden = false;
      // Pooled nodes are reused across kinds and hull types: rebuild the glyph when either changes.
      const glyphKey = m.kind === 'spotted-vehicle' ? `${m.kind}:${m.vehicleType || ''}` : m.kind;
      if (n.glyphKey !== glyphKey) {
        n.glyphKey = glyphKey;
        n.dataset.kind = m.kind;
        n.glyph.textContent = '';
        const icon = m.kind === 'down' || m.kind === 'wounded' ? svgIcon(globalThis.document, 'revive', 'cq-unit-icon')
          : m.kind === 'spotted-vehicle' ? svgIcon(globalThis.document, m.vehicleType || 'tank', 'cq-unit-icon') : null;
        if (icon) n.glyph.appendChild(icon);
      }
      // The glyph sits on the projected point; near a screen side the label hangs inward so it is never cut off.
      const align = viewWidth > 0 && m.x > viewWidth - EDGE_LABEL_PX ? 'end' : viewWidth > 0 && m.x < EDGE_LABEL_PX ? 'start' : 'center';
      if (n.dataset.align !== align) n.dataset.align = align;
      n.style.transform = `translate(${m.x.toFixed(1)}px, ${m.y.toFixed(1)}px) translateX(${UNIT_SHIFT[align]})`;
      const text = m.kind === 'down' ? `${m.name ? `${m.name} · ` : ''}${m.distance} m` : m.kind === 'squad' ? m.name
        : m.kind === 'spotted-vehicle' ? `${m.name} ${m.distance} m` : '';
      if (n.label.textContent !== text) n.label.textContent = text;
    }
    for (; i < this.units.length; i++) this.units[i].hidden = true;
  }

  clear() { this.update([], []); }
}
