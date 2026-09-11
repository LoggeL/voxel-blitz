import { bindingLabel } from '../keybindings.js';
import { MEDKIT_SECONDS } from '../../../shared/medkit.js';
import { el } from './hud-support.js';

export class MedkitHud {
  build(hud, healthbar) {
    this.dispose();
    this.inventory = el('div', 'vb-medkit-inventory', healthbar, 'medkit-inventory');
    this.inventory.title = 'One medkit per life. Stand still while healing.';
    this.root = el('div', 'vb-medkit-progress', hud, 'medkit-progress');
    this.root.hidden = true;
    this.label = el('strong', '', this.root);
    this.label.textContent = 'BANDAGING';
    this.time = el('span', '', this.root);
    this.bar = el('div', 'vb-medkit-track', this.root);
    this.bar.setAttribute('role', 'progressbar');
    this.bar.setAttribute('aria-label', 'Healing progress');
    this.bar.setAttribute('aria-valuemin', '0');
    this.bar.setAttribute('aria-valuemax', '100');
    this.fill = el('i', '', this.bar);
    this.hint = el('small', '', this.root);
    this.hint.textContent = `STAY STILL · ${bindingLabel('medkit')} TO CANCEL`;
  }

  update(kit, alive, hp) {
    if (!this.root) return;
    const active = alive && !!kit?.active;
    const remaining = kit?.remaining === 1 ? 1 : 0;
    const progress = active ? Math.max(0, Math.min(1, kit.progress || 0)) : 0;
    const key = bindingLabel('medkit');
    const signature = `${key}|${alive}|${active}|${remaining}|${hp >= 100}|${progress}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.inventory.hidden = !alive;
    this.hint.textContent = `STAY STILL · ${key} TO CANCEL`;
    this.inventory.textContent = remaining ? `${key} · MEDKIT ×1${hp >= 100 ? ' · FULL HEALTH' : ''}` : 'MEDKIT USED';
    this.inventory.classList.toggle('is-spent', !remaining);
    this.root.hidden = !active;
    if (!active) return;
    this.time.textContent = `${((1 - progress) * MEDKIT_SECONDS).toFixed(1)}s`;
    this.fill.style.width = `${progress * 100}%`;
    this.bar.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
  }

  dispose() {
    this.root?.remove();
    this.inventory?.remove();
    this.root = this.inventory = null;
    this.signature = null;
  }
}
