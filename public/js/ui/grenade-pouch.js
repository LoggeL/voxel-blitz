// Five-slot grenade pouch radial. The fixed slot angles follow GRENADE_TYPE_IDS
// (frag on top, then clockwise) so muscle memory builds. The controller mirrors
// WeaponWheelController: a body-level fixed-id root, an idempotent ensure(), a
// diffing setState() driven by the input seam's authoritative pouch state, and a
// real dispose(). Empty slots can never be hovered or picked.
import { bindingLabel } from '../keybindings.js';
import { GRENADE_TYPES, GRENADE_TYPE_IDS, GRENADE_ROLES, grenadeEffectRadius } from '../../../shared/grenade-rules.js';
import { CLAYMORE_RULES } from '../../../shared/claymore-rules.js';
import { GRENADE_HUD_ICONS, el } from './hud-support.js';
import { WHEEL_DEAD_ZONE, wheelAngleForSlot, wheelSlotFromVector } from './weapon-wheel.js';

const SLOT_COUNT = GRENADE_TYPE_IDS.length;
/** Quick-key actions in slot order; unbound by default (see keybindings.js). */
export const GRENADE_QUICK_ACTIONS = Object.freeze(['grenadeFrag', 'grenadeClaymore', 'grenadePulse', 'grenadeMolotov', 'grenadeSmoke']);
/** Taps farther than this (ring radii) from the centre close the touch pouch. */
const TOUCH_OUTSIDE_RADIUS = 1.3;

function stocked(counts, index) {
  return index >= 0 && Number(counts?.[index]) > 0;
}

function formatMetres(value) {
  return `${Number(value.toFixed(1))} m`;
}

/** Chaos level for one type from a number, a per-type map, or a per-slot array. */
export function grenadeChaosLevel(chaos, typeId) {
  if (Number.isFinite(chaos)) return chaos;
  const level = Array.isArray(chaos) ? chaos[GRENADE_TYPE_IDS.indexOf(typeId)] : chaos?.[typeId];
  return Number.isFinite(level) ? level : 0;
}

/**
 * One-line role summary generated from the authoritative profile, e.g.
 * "Timed fuse · cookable · 7.5 m blast". Nothing here is hand-written per type.
 */
export function grenadeRoleLine(typeId, chaosLevel = 0) {
  const type = GRENADE_TYPES[typeId];
  if (!type) return '';
  const parts = [];
  if (type.wallMine) parts.push('Wall mount', `${formatMetres(CLAYMORE_RULES.placementRange)} reach`);
  else parts.push(type.impact ? 'Impact' : 'Timed fuse');
  if (type.cook) parts.push('cookable');
  if (type.concussMs > 0) parts.push('concussion');
  // Damage blasts, a burning selfDamage-only area is fire, anything else screens.
  const effect = type.damage > 0 ? 'blast' : type.selfDamage > 0 ? 'fire' : 'screen';
  parts.push(`${formatMetres(grenadeEffectRadius(typeId, chaosLevel))} ${effect}`);
  return parts.join(' · ');
}

/**
 * Pouch slot under a normalized vector, snapped to the angularly nearest stocked
 * slot when the pointed slot is empty. -1 inside the dead zone or with an empty pouch.
 */
export function grenadePouchSlotFromVector(x, y, counts, deadZone = WHEEL_DEAD_ZONE) {
  const slot = wheelSlotFromVector(x, y, SLOT_COUNT, deadZone);
  if (slot < 0 || stocked(counts, slot)) return slot;
  return snapToStocked(slot, counts, Math.atan2(y, x) * 180 / Math.PI);
}

/** Nearest stocked slot to `slot` (by angle when given), or -1. */
function snapToStocked(slot, counts, angleDeg = wheelAngleForSlot(slot, SLOT_COUNT)) {
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < SLOT_COUNT; i++) {
    if (!stocked(counts, i)) continue;
    const delta = Math.abs((((wheelAngleForSlot(i, SLOT_COUNT) - angleDeg) % 360) + 540) % 360 - 180);
    if (delta < bestDistance) {
      bestDistance = delta;
      best = i;
    }
  }
  return best;
}

function _setText(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
}

/** Owns the #grenade-pouch overlay; display only, input owns hover and confirm. */
export class GrenadePouchController {
  /** @param {{onPick?: Function, onCancel?: Function}} [host] Touch callbacks. */
  constructor(host = {}) {
    this.host = host;
    this.dom = {};
    this._open = false;
    this._hover = -1;
    this._ready = -1;
    this._counts = [0, 0, 0, 0, 0];
    this._device = {};
    this._labels = null;
    this._chaos = 0;
    this._sig = '';
    this._ownsRoot = false;
    this._pointerHandlers = null;
  }

  /** Creates (once) or adopts the body-level #grenade-pouch root. */
  ensure() {
    if (this.dom.root) return this.dom.root;
    let root = document.getElementById('grenade-pouch');
    if (!root) {
      root = el('div', 'hidden', document.body, 'grenade-pouch');
      this._ownsRoot = true;
    }
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Grenade pouch');
    root.setAttribute('aria-hidden', 'true');
    root.classList.add('hidden');
    root.innerHTML = '';

    const ring = el('div', 'vb-pouch-ring', root);
    const slots = GRENADE_TYPE_IDS.map((typeId, index) => {
      const type = GRENADE_TYPES[typeId];
      const node = el('div', `vb-pouch-slot vb-pouch-slot-${typeId}`, ring);
      node.dataset.type = typeId;
      node.dataset.role = GRENADE_ROLES[typeId] || '';
      node.style.setProperty('--nade', type.color);
      node.style.setProperty('--vb-pouch-angle', `${wheelAngleForSlot(index, SLOT_COUNT)}deg`);
      const icon = el('img', 'vb-pouch-icon', node);
      icon.src = GRENADE_HUD_ICONS[typeId];
      icon.alt = '';
      icon.draggable = false;
      const count = el('b', 'vb-pouch-count', node);
      const key = el('span', 'vb-pouch-key', node);
      return { node, count, key };
    });
    const hub = el('div', 'vb-pouch-hub', ring);
    const hubName = el('div', 'vb-pouch-hub-name', hub);
    const hubRole = el('div', 'vb-pouch-hub-role', hub);
    const hubHint = el('div', 'vb-pouch-hint', ring);
    this.dom = { root, ring, slots, hub, hubName, hubRole, hubHint };
    this._sig = '';
    this._attachPointerHandlers();
    this._paint();
    return root;
  }

  /** @param {{onPick?: Function, onCancel?: Function}} [config] */
  setup({ onPick, onCancel } = {}) {
    this.host = { ...this.host, onPick, onCancel };
    this.ensure();
  }

  /**
   * Frame-driven, diffing state forwarder. Every field is optional.
   * @param {{open?: boolean, hover?: number, ready?: number, counts?: number[],
   *   device?: {padActive?: boolean, touch?: boolean}, labels?: {quick?: string[], confirm?: string},
   *   chaos?: number|object|number[]}} [state]
   */
  setState({ open, hover, ready, counts, device, labels, chaos } = {}) {
    if (counts !== undefined) {
      this._counts = GRENADE_TYPE_IDS.map((_, i) => Math.max(0, (Array.isArray(counts) ? counts[i] : 0) | 0));
    }
    if (hover !== undefined) this._hover = Number.isInteger(hover) ? hover : -1;
    if (ready !== undefined) this._ready = Number.isInteger(ready) ? ready : -1;
    if (device !== undefined) this._device = device || {};
    if (labels !== undefined) this._labels = labels || null;
    if (chaos !== undefined) this._chaos = chaos;
    if (open !== undefined) this._open = !!open;
    if (!this._open && !this.dom.root) return;
    this.ensure();
    this._paint();
  }

  isOpen() { return this._open; }

  /** Hovered slot after the empty-slot snap, or -1. */
  hovered() {
    if (this._hover < 0 || this._hover >= SLOT_COUNT) return -1;
    return stocked(this._counts, this._hover) ? this._hover : snapToStocked(this._hover, this._counts);
  }

  /** Visible ring radius in pixels, for normalizing mouse deltas. */
  radius() {
    const rect = this.dom.ring?.getBoundingClientRect?.();
    return rect && rect.width > 0 ? rect.width / 2 : 1;
  }

  dispose() {
    const root = this.dom.root;
    if (this._pointerHandlers && root) root.removeEventListener('pointerup', this._pointerHandlers.up);
    this._pointerHandlers = null;
    if (root) {
      if (this._ownsRoot) root.remove();
      else root.innerHTML = '';
    }
    this.dom = {};
    this._open = false;
    this._hover = -1;
    this._sig = '';
    this._ownsRoot = false;
  }

  _quickLabel(index) {
    const given = this._labels?.quick?.[index];
    if (given !== undefined) return given || '';
    if (this._device.padActive || this._device.touch) return '';
    const label = bindingLabel(GRENADE_QUICK_ACTIONS[index]);
    return label === 'UNBOUND' ? '' : label;
  }

  _hint() {
    if (this._labels?.confirm) return this._labels.confirm;
    if (this._device.touch && !this._device.padActive) return 'TAP A GRENADE · TAP OUTSIDE TO CLOSE';
    if (this._device.padActive) return 'RELEASE D▼ · READY   RB · THROW   B · CLOSE';
    const hold = bindingLabel('grenadeType');
    return `RELEASE ${hold} · READY   ${bindingLabel('grenade')} · THROW   ESC · CLOSE`;
  }

  /** Paints only when a rendered field changed, so idle frames never touch the DOM. */
  _paint() {
    const d = this.dom;
    if (!d.root) return;
    const hover = this.hovered();
    const quick = GRENADE_TYPE_IDS.map((_, i) => this._quickLabel(i));
    const focus = hover >= 0 ? hover : this._ready;
    const focusId = GRENADE_TYPE_IDS[focus];
    const roleLine = focusId ? grenadeRoleLine(focusId, grenadeChaosLevel(this._chaos, focusId)) : '';
    const hint = this._hint();
    const sig = `${Number(this._open)}|${hover}|${this._ready}|${this._counts.join(',')}|${quick.join(',')}|${roleLine}|${hint}|${Number(!!this._device.touch)}`;
    if (sig === this._sig) return;
    this._sig = sig;

    d.root.classList.toggle('hidden', !this._open);
    d.root.classList.toggle('is-open', this._open);
    d.root.classList.toggle('is-touch', !!this._device.touch && !this._device.padActive);
    d.root.setAttribute('aria-hidden', this._open ? 'false' : 'true');
    d.slots.forEach((slot, index) => {
      const count = this._counts[index];
      _setText(slot.count, `×${count}`);
      _setText(slot.key, quick[index]);
      slot.key.hidden = !quick[index];
      slot.node.classList.toggle('is-empty', count <= 0);
      slot.node.classList.toggle('is-hl', index === hover);
      slot.node.classList.toggle('is-ready', index === this._ready);
      slot.node.setAttribute('aria-label', `${GRENADE_TYPES[GRENADE_TYPE_IDS[index]].name}, ${count} left${index === this._ready ? ', ready' : ''}`);
    });
    const type = GRENADE_TYPES[focusId];
    _setText(d.hubName, type ? type.name : 'POUCH EMPTY');
    _setText(d.hubRole, roleLine);
    _setText(d.hubHint, hint);
    if (type) d.hub.style.setProperty('--nade', type.color);
  }

  /** Touch: tap a stocked slot to ready it, tap outside the ring to close. */
  _attachPointerHandlers() {
    if (this._pointerHandlers || typeof document === 'undefined') return;
    const up = (event) => {
      if (!this._open || !this._device.touch || document.pointerLockElement) return;
      const ring = this.dom.ring;
      if (!ring || !Number.isFinite(event.clientX)) return;
      event.preventDefault?.();
      const rect = ring.getBoundingClientRect();
      const radius = Math.max(rect.width / 2, 1);
      const x = (event.clientX - (rect.left + rect.width / 2)) / radius;
      const y = (event.clientY - (rect.top + rect.height / 2)) / radius;
      const slot = Math.hypot(x, y) <= TOUCH_OUTSIDE_RADIUS ? grenadePouchSlotFromVector(x, y, this._counts) : -1;
      if (slot >= 0) {
        if (typeof this.host?.onPick === 'function') this.host.onPick(slot);
      } else if (Math.hypot(x, y) > TOUCH_OUTSIDE_RADIUS || !this._counts.some((count) => count > 0)) {
        if (typeof this.host?.onCancel === 'function') this.host.onCancel();
      }
    };
    this.dom.root.addEventListener('pointerup', up);
    this._pointerHandlers = { up };
  }
}
