/**
 * Top-centre objective bar: team-relative ticket bars with bleed, 5 flag chips, time left.
 * Breakthrough (design docs/design/conquest/breakthrough/, variant A): the
 * chips group into the sector track (captured / active / locked boxes with
 * chevrons between them), only the attackers' side counts tickets and a tag
 * under the clock carries the overtime or the fall-back grace.
 */
import { el } from '../hud-support.js';
import { svgIcon } from './icons.js';

export class TopBar {
  constructor(parent) {
    this.root = el('div', 'cq-top', parent);
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-label', 'Tickets and objectives');
    const side = rel => {
      const box = el('div', `cq-team cq-team-${rel}`, this.root);
      const head = el('div', 'cq-team-head', box);
      const name = el('span', 'cq-team-name', head);
      const tickets = el('strong', 'cq-tickets', head);
      const track = el('div', 'cq-ticket-track', box);
      const fill = el('i', 'cq-ticket-fill', track);
      const bleed = el('span', 'cq-bleed', box);
      return { box, name, tickets, fill, bleed };
    };
    this.own = side('own');
    const center = el('div', 'cq-center', this.root);
    this.chips = el('div', 'cq-chips', center);
    const foot = el('div', 'cq-center-foot', center);
    this.clock = el('div', 'cq-clock', foot);
    this.tag = el('div', 'cq-sector-tag', foot);
    this.tag.hidden = true;
    this.enemy = side('enemy');
    this.root.appendChild(this.enemy.box);
    this.chipNodes = new Map();
    this.sectorNodes = [];
    this._layout = null;
    this._painted = new Map();
  }

  _set(node, key, value) {
    if (this._painted.get(key) === value) return;
    this._painted.set(key, value);
    node.textContent = value;
  }

  _chip(chip) {
    let n = this.chipNodes.get(chip.id);
    if (!n) {
      n = el('div', 'cq-chip', this.chips);
      n.fill = el('i', 'cq-chip-fill', n);
      n.letter = el('span', 'cq-chip-letter', n);
      n.letter.textContent = chip.id;
      this.chipNodes.set(chip.id, n);
    }
    return n;
  }

  /** Chips straight in the row (Conquest) or inside one box per sector (Breakthrough); rebuilt only when the layout changes. */
  _arrange(chips, bt) {
    const layout = bt ? bt.sectors.map(s => s.flags.join('')).join('.') : chips.map(c => c.id).join('');
    if (layout === this._layout) return;
    this._layout = layout;
    for (const node of this.sectorNodes) node.remove();
    this.sectorNodes = [];
    this.root.dataset.variant = bt ? 'breakthrough' : '';
    if (!bt) { for (const chip of chips) this.chips.appendChild(this._chip(chip)); return; }
    bt.sectors.forEach((sector, index) => {
      if (index) { const sep = el('i', 'cq-sector-sep', this.chips); sep.setAttribute('aria-hidden', 'true'); this.sectorNodes.push(sep); }
      const box = el('div', 'cq-sector', this.chips);
      box.label = el('span', 'cq-sector-label', box);
      box.label.textContent = `S${sector.number}`;
      box.flags = el('div', 'cq-sector-flags', box);
      for (const id of sector.flags) {
        const chip = chips.find(c => c.id === id);
        if (chip) box.flags.appendChild(this._chip(chip));
      }
      box.mark = el('span', 'cq-sector-mark', box);
      box.mark.appendChild(svgIcon(globalThis.document, 'padlock', 'cq-sector-lock'));
      box.progress = el('i', 'cq-sector-progress', box);
      this.sectorNodes.push(box);
    });
  }

  update(tickets, chips) {
    if (!tickets) return;
    const bt = tickets.breakthrough ?? null;
    for (const rel of ['own', 'enemy']) {
      const model = tickets[rel], dom = this[rel];
      this._set(dom.name, `${rel}:name`, model.name);
      this._set(dom.tickets, `${rel}:t`, model.tickets == null ? '' : String(model.tickets));
      dom.fill.style.width = `${(model.fraction * 100).toFixed(1)}%`;
      this._set(dom.bleed, `${rel}:b`, model.bleed);
      dom.box.dataset.bleeding = String(model.bleeding);
      dom.box.dataset.low = String(model.low);
      dom.box.dataset.team = model.team;
      dom.box.dataset.role = model.role || '';
    }
    this._set(this.clock, 'clock', tickets.clock);
    this.clock.dataset.urgent = String(tickets.timeLeftMs !== null && tickets.timeLeftMs < 60000);
    this._arrange(chips, bt);
    for (const chip of chips) {
      const n = this._chip(chip);
      n.dataset.owner = chip.owner;
      n.dataset.lean = chip.lean;
      n.dataset.contested = String(chip.contested);
      n.dataset.moving = chip.moving || '';
      n.dataset.state = chip.state;
      n.dataset.role = chip.role || '';
      n.style.setProperty('--fill', chip.fill.toFixed(3));
      const status = chip.role === 'locked' ? 'LOCKED' : chip.contested ? 'CONTESTED' : chip.owner === 'neutral' ? 'NEUTRAL' : chip.owner === 'own' ? 'HELD' : 'ENEMY';
      const title = `${chip.id} ${chip.name}: ${status}${chip.moving ? ` · ${chip.state.toUpperCase()}` : ''}`;
      if (n.title !== title) { n.title = title; n.setAttribute('aria-label', title); }
    }
    const ids = new Set(chips.map(c => c.id));
    for (const [id, n] of this.chipNodes) if (!ids.has(id)) { n.remove(); this.chipNodes.delete(id); }
    if (bt) {
      const boxes = this.sectorNodes.filter(n => n.classList.contains('cq-sector'));
      bt.sectors.forEach((sector, index) => {
        const box = boxes[index];
        if (!box) return;
        box.dataset.role = sector.role;
        box.style.setProperty('--progress', sector.progress.toFixed(3));
        const title = `${sector.label} · ${sector.flags.join(' ')} · ${sector.role.toUpperCase()}`;
        if (box.title !== title) { box.title = title; box.setAttribute('aria-label', title); }
      });
      this.root.dataset.side = bt.role;
    } else delete this.root.dataset.side;
    const tag = bt?.tag || '';
    this.tag.hidden = !tag;
    this._set(this.tag, 'tag', tag);
    this.tag.dataset.kind = bt?.overtime ? 'overtime' : tag ? 'grace' : '';
  }
}
