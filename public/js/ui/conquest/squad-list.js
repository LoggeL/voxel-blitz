/**
 * Squad list beside the minimap (design: gameplay-hud-reference, Alt 2): the
 * squad name and one row per squadmate with the kit glyph (or the hull while
 * seated), the name and DOWN / DEAD. Rows come from squadListModel(), which
 * reads only the authoritative player and vehicle rows.
 */
import { el } from '../hud-support.js';
import { svgIcon } from './icons.js';

const STATE_TEXT = Object.freeze({ alive: '', down: 'DOWN', dead: 'DEAD' });

export class SquadList {
  constructor(parent) {
    this.root = el('div', 'cq-squad', parent);
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Squad');
    this.head = el('div', 'cq-squad-head', this.root);
    this.list = el('ol', 'cq-squad-list', this.root);
    this.rows = [];
  }

  update(model) {
    if (!model || !model.rows?.length) { this.root.hidden = true; return; }
    this.root.hidden = false;
    const head = `${model.name} SQUAD`;
    if (this.head.textContent !== head) this.head.textContent = head;
    let i = 0;
    for (const row of model.rows) {
      let n = this.rows[i];
      if (!n) {
        n = el('li', 'cq-squad-row', this.list);
        n.icon = el('i', 'cq-squad-icon', n);
        n.label = el('span', 'cq-squad-name', n);
        n.state = el('b', 'cq-squad-state', n);
        this.rows.push(n);
      }
      i++;
      n.hidden = false;
      // A downed mate shows the revive cross, a seated one the hull, everyone else the kit.
      const glyph = row.state === 'down' ? 'revive' : row.vehicleType || row.kit || 'squad';
      if (n.glyph !== glyph) {
        n.glyph = glyph;
        n.icon.textContent = '';
        const icon = svgIcon(globalThis.document, glyph, 'cq-squad-glyph');
        if (icon) n.icon.appendChild(icon);
      }
      if (n.dataset.state !== row.state) n.dataset.state = row.state;
      const leader = String(!!row.leader);
      if (n.dataset.leader !== leader) n.dataset.leader = leader;
      if (n.label.textContent !== row.name) n.label.textContent = row.name;
      const state = STATE_TEXT[row.state] ?? '';
      if (n.state.textContent !== state) n.state.textContent = state;
    }
    for (; i < this.rows.length; i++) this.rows[i].hidden = true;
  }
}
