/** Top-centre objective bar: team-relative ticket bars with bleed, 5 flag chips, time left. */
import { el } from '../hud-support.js';

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
    this.clock = el('div', 'cq-clock', center);
    this.enemy = side('enemy');
    this.root.appendChild(this.enemy.box);
    this.chipNodes = new Map();
    this._painted = new Map();
  }

  _set(node, key, value) {
    if (this._painted.get(key) === value) return;
    this._painted.set(key, value);
    node.textContent = value;
  }

  update(tickets, chips) {
    if (!tickets) return;
    for (const rel of ['own', 'enemy']) {
      const model = tickets[rel], dom = this[rel];
      this._set(dom.name, `${rel}:name`, model.name);
      this._set(dom.tickets, `${rel}:t`, String(model.tickets));
      dom.fill.style.width = `${(model.fraction * 100).toFixed(1)}%`;
      this._set(dom.bleed, `${rel}:b`, model.bleed);
      dom.box.dataset.bleeding = String(model.bleeding);
      dom.box.dataset.low = String(model.low);
      dom.box.dataset.team = model.team;
    }
    this._set(this.clock, 'clock', tickets.clock);
    this.clock.dataset.urgent = String(tickets.timeLeftMs !== null && tickets.timeLeftMs < 60000);
    const ids = new Set();
    for (const chip of chips) {
      ids.add(chip.id);
      let n = this.chipNodes.get(chip.id);
      if (!n) {
        n = el('div', 'cq-chip', this.chips);
        n.fill = el('i', 'cq-chip-fill', n);
        n.letter = el('span', 'cq-chip-letter', n);
        n.letter.textContent = chip.id;
        this.chipNodes.set(chip.id, n);
      }
      n.dataset.owner = chip.owner;
      n.dataset.lean = chip.lean;
      n.dataset.contested = String(chip.contested);
      n.dataset.moving = chip.moving || '';
      n.dataset.state = chip.state;
      n.style.setProperty('--fill', chip.fill.toFixed(3));
      const title = `${chip.id} ${chip.name}: ${chip.contested ? 'CONTESTED' : chip.owner === 'neutral' ? 'NEUTRAL' : chip.owner === 'own' ? 'HELD' : 'ENEMY'}${chip.moving ? ` · ${chip.state.toUpperCase()}` : ''}`;
      if (n.title !== title) { n.title = title; n.setAttribute('aria-label', title); }
    }
    for (const [id, n] of this.chipNodes) if (!ids.has(id)) { n.remove(); this.chipNodes.delete(id); }
  }
}
