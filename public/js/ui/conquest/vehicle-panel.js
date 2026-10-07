/**
 * Seated vehicle panel (bottom right, replaces the infantry ammo card): seat
 * strip, hull silhouette with hit-zone flash, HP bar and status badges,
 * per-weapon ammo / heat / reload, countermeasure readiness pip.
 */
import { el } from '../hud-support.js';
import { bindingLabel } from '../../keybindings.js';
import { svgIcon } from './icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ZONE_FLASH_MS = 520;
/** Top-down hull zones (front up) in a 60x92 box. */
const ZONES = Object.freeze({
  ground: {
    outline: 'M14 6h32l6 10v62l-6 8H14l-6-8V16z',
    front: 'M14 6h32l6 10H8z', rear: 'M8 78h44l-6 8H14z', left: 'M8 16h8v62H8z', right: 'M44 16h8v62h-8z', top: 'M16 16h28v62H16z',
  },
  air: {
    outline: 'M26 4h8l3 22 21 12v8l-21-4-2 30 9 7v6H16v-6l9-7-2-30-21 4v-8l21-12z',
    front: 'M26 4h8l3 22H23z', rear: 'M23 66h14l9 7v6H14v-6z', left: 'M2 38l21-12v16L2 46z', right: 'M58 38L37 26v16l21 4z', top: 'M23 26h14v40H23z',
  },
});

function hullSvg(documentRef, kind) {
  const shape = ZONES[kind];
  const svg = documentRef.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 60 92');
  svg.setAttribute('class', 'cq-hull-svg');
  svg.setAttribute('aria-hidden', 'true');
  const zones = {};
  for (const zone of ['top', 'front', 'rear', 'left', 'right']) {
    const path = documentRef.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', shape[zone]);
    path.setAttribute('class', `cq-hull-zone cq-hull-${zone}`);
    svg.appendChild(path);
    zones[zone] = path;
  }
  const outline = documentRef.createElementNS(SVG_NS, 'path');
  outline.setAttribute('d', shape.outline);
  outline.setAttribute('class', 'cq-hull-outline');
  svg.appendChild(outline);
  return { svg, zones };
}

/** Which silhouette zone a hit zone lights: side hits light both flanks, bottom lights the outline. */
export function zonePaths(zone) {
  if (zone === 'side') return ['left', 'right'];
  if (zone === 'bottom') return ['top', 'front', 'rear'];
  return ['front', 'rear', 'top', 'left', 'right'].includes(zone) ? [zone] : ['top'];
}

export class VehiclePanel {
  constructor(parent) {
    this.root = el('section', 'cq-vehicle', parent);
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Vehicle status');
    this.seats = el('div', 'cq-vehicle-seats', this.root);
    const main = el('div', 'cq-vehicle-main', this.root);
    this.hull = el('div', 'cq-hull', main);
    const stats = el('div', 'cq-vehicle-stats', main);
    const title = el('div', 'cq-vehicle-title', stats);
    this.icon = el('i', 'cq-vehicle-icon', title);
    this.name = el('strong', 'cq-vehicle-name', title);
    this.role = el('span', 'cq-vehicle-role', title);
    const hp = el('div', 'cq-vehicle-hp', stats);
    this.hpFill = el('i', '', el('div', 'cq-vehicle-hp-track', hp));
    this.hpText = el('span', 'cq-vehicle-hp-text', hp);
    this.badges = el('div', 'cq-vehicle-badges', stats);
    this.telemetry = el('div', 'cq-vehicle-telemetry', stats);
    this.weapons = el('div', 'cq-vehicle-weapons', this.root);
    this.cm = el('div', 'cq-vehicle-cm', this.root);
    this.cmLabel = el('span', 'cq-vehicle-cm-label', this.cm);
    this.cmPip = el('i', 'cq-vehicle-cm-pip', el('span', 'cq-vehicle-cm-track', this.cm));
    this.cmKey = el('kbd', 'cq-vehicle-cm-key', this.cm);
    this._type = null;
    this._zones = null;
    this._sigs = new Map();
    this._flash = new Map();
  }

  _changed(key, value) {
    if (this._sigs.get(key) === value) return false;
    this._sigs.set(key, value);
    return true;
  }

  /** Light a hull zone after a vehicle_hit on our hull. */
  flashZone(flash, nowMs) {
    if (!flash || !this._zones) return;
    for (const zone of zonePaths(flash.zone)) this._flash.set(zone, { until: nowMs + ZONE_FLASH_MS, effective: flash.effective });
  }

  update(model, nowMs = 0) {
    if (!model) { if (!this.root.hidden) this.root.hidden = true; this._sigs.clear(); return; }
    this.root.hidden = false;
    this.root.dataset.type = model.type;
    this.root.dataset.role = model.role;
    if (this._type !== model.type) {
      this._type = model.type;
      this.hull.textContent = '';
      const { svg, zones } = hullSvg(globalThis.document, model.aircraft ? 'air' : 'ground');
      this.hull.appendChild(svg);
      this._zones = zones;
      this.icon.textContent = '';
      const icon = svgIcon(globalThis.document, model.type, 'cq-vehicle-type-icon');
      if (icon) this.icon.appendChild(icon);
      this.name.textContent = model.name;
    }
    if (this._changed('role', model.seatId)) this.role.textContent = model.seats.find(s => s.id === model.seatId)?.label || '';
    const seatSig = JSON.stringify(model.seats.map(s => [s.key, s.label, s.you, s.free, s.bot, s.name]));
    if (this._changed('seats', seatSig)) {
      this.seats.textContent = '';
      for (const seat of model.seats) {
        const chip = el('span', 'cq-seat', this.seats);
        chip.classList.toggle('is-you', seat.you);
        chip.classList.toggle('is-free', seat.free);
        chip.classList.toggle('is-bot', seat.bot);
        el('kbd', '', chip).textContent = seat.key;
        el('span', '', chip).textContent = seat.label;
        if (seat.you) el('em', '', chip).textContent = 'YOU';
        else if (seat.bot) el('em', '', chip).textContent = 'BOT';
        else if (!seat.free && seat.name) el('em', '', chip).textContent = seat.name.slice(0, 10).toUpperCase();
        chip.title = seat.text;
      }
    }
    const fraction = model.fraction ?? 1;
    this.hpFill.style.width = `${(fraction * 100).toFixed(1)}%`;
    this.root.dataset.hp = fraction < 0.25 ? 'critical' : fraction < 0.5 ? 'damaged' : 'ok';
    if (this._changed('hp', model.hpText)) this.hpText.textContent = model.hpText;
    const badgeSig = model.badges.map(b => b.key).join(',');
    if (this._changed('badges', badgeSig)) {
      this.badges.textContent = '';
      for (const badge of model.badges) {
        const b = el('span', `cq-badge cq-badge-${badge.tone}`, this.badges);
        b.textContent = badge.label;
      }
    }
    const tele = model.aircraft ? `${model.speedKmh} KM/H · ALT ${model.altitude ?? '--'} M` : `${model.speedKmh} KM/H`;
    if (this._changed('tele', tele)) this.telemetry.textContent = tele;
    const weaponSig = model.weapons.map(w => `${w.weapon}:${w.selected}`).join('|');
    if (this._changed('weapons', weaponSig)) {
      this.weapons.textContent = '';
      this._weaponRows = model.weapons.map((w, index) => {
        const row = el('div', 'cq-weapon', this.weapons);
        row.classList.toggle('is-selected', w.selected);
        // In the jet Q is the rudder, so its weapons are picked with the slot keys (1, 2).
        el('kbd', 'cq-weapon-key', row).textContent = model.weapons.length > 1
          ? (model.type === 'plane' ? bindingLabel(`slot${index + 1}`) : bindingLabel('vehicleWeaponNext')) : '';
        el('span', 'cq-weapon-name', row).textContent = w.label;
        const meter = el('span', 'cq-weapon-meter', row);
        const fill = el('i', '', meter);
        const ammo = el('span', 'cq-weapon-ammo', row);
        return { row, fill, ammo };
      });
    }
    model.weapons.forEach((w, i) => {
      const dom = this._weaponRows?.[i];
      if (!dom) return;
      // Reload sweeps 0→1 as it completes; heat weapons show heat, red when locked out.
      const heatWeapon = w.kind === 'hitscan' || w.weapon === 'chinCannon';
      const value = heatWeapon ? w.heat : 1 - w.reload;
      dom.fill.style.width = `${(Math.max(0, Math.min(1, value)) * 100).toFixed(0)}%`;
      dom.row.dataset.state = w.overheated ? 'overheated' : heatWeapon ? (w.heat > 0.75 ? 'hot' : 'ok') : w.reload > 0 ? 'reloading' : 'ready';
      const ammoText = w.overheated ? 'OVERHEAT' : w.reload > 0 && !heatWeapon ? 'RELOAD' : Number.isFinite(w.ammo) && w.ammo >= 0 ? String(w.ammo) : '∞';
      if (dom.ammo.textContent !== ammoText) dom.ammo.textContent = ammoText;
    });
    this.cm.hidden = !model.cm;
    if (model.cm) {
      const label = model.cm.active ? `${model.cm.label} ACTIVE` : model.cm.available ? `${model.cm.label} READY` : `${model.cm.label} ${Math.round(model.cm.ready * 100)}%`;
      if (this._changed('cm', label)) this.cmLabel.textContent = label;
      this.cmPip.style.width = `${(model.cm.ready * 100).toFixed(0)}%`;
      this.cm.dataset.ready = String(model.cm.available);
      const key = bindingLabel('vehicleCountermeasure');
      if (this._changed('cmKey', key)) this.cmKey.textContent = key;
    }
    for (const [zone, path] of Object.entries(this._zones || {})) {
      const flash = this._flash.get(zone);
      const on = flash && flash.until > nowMs;
      path.classList.toggle('is-hit', !!on && flash.effective);
      path.classList.toggle('is-spark', !!on && !flash.effective);
      if (flash && !on) this._flash.delete(zone);
    }
  }
}
