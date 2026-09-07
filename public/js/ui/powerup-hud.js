import { POWERUP_TYPES } from '../../../shared/powerups.js';
import { el } from './hud-support.js';

export class PowerupHud {
  build(hud, healthbar) {
    this.dispose();
    this.armor = el('div', 'vb-armor', healthbar, 'armor-status');
    this.armor.hidden = true;
    el('span', '', this.armor).textContent = 'ARMOR';
    this.amount = el('b', '', this.armor);
    const track = el('div', 'vb-armor-track', this.armor);
    this.fill = el('i', '', track);
    this.toast = el('div', 'vb-powerup-toast', hud, 'powerup-toast');
    this.toast.setAttribute('role', 'status');
    this.toast.setAttribute('aria-live', 'polite');
    this.toast.hidden = true;
    this.until = 0;
    this.lastArmor = -1;
  }

  update(armor, alive) {
    if (!this.armor) return;
    const value = alive && Number.isFinite(armor) ? Math.max(0, Math.min(100, Math.ceil(armor))) : 0;
    if (value !== this.lastArmor) {
      this.lastArmor = value;
      this.armor.hidden = value === 0;
      this.amount.textContent = String(value);
      this.fill.style.width = `${value}%`;
      this.armor.setAttribute('aria-label', `Armor: ${value} of 100`);
    }
    if (!this.toast.hidden && (!alive || performance.now() >= this.until)) this.toast.hidden = true;
  }

  collected(event) {
    if (!this.toast || !Object.hasOwn(POWERUP_TYPES, event?.type)) return;
    const type = POWERUP_TYPES[event.type];
    this.toast.textContent = event.type === 'ammo'
      ? 'AMMO · RESERVES REFILLED'
      : `${type.label.toUpperCase()} +${Math.round(Number(event.amount) || 0)}`;
    this.toast.style.setProperty('--pickup-color', `#${type.color.toString(16).padStart(6, '0')}`);
    this.toast.hidden = false;
    this.until = performance.now() + 2400;
  }

  reset() {
    if (this.armor) this.armor.hidden = true;
    if (this.toast) this.toast.hidden = true;
    this.lastArmor = -1;
    this.until = 0;
  }

  dispose() {
    this.armor?.remove();
    this.toast?.remove();
    this.armor = this.toast = null;
    this.reset();
  }
}
