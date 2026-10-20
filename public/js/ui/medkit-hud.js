import { bindingLabel } from '../keybindings.js';
import { MEDKIT_RULES } from '../../../shared/medkit.js';
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
    // The mode's kit rule rides the MedkitState (Conquest: bandages, shared/supply.js BANDAGE_RULES).
    const rules = kit?.rules ?? MEDKIT_RULES;
    const remaining = Math.max(0, Math.min(rules.count, Math.trunc(Number(kit?.remaining) || 0)));
    const progress = active ? Math.max(0, Math.min(1, kit.progress || 0)) : 0;
    const key = bindingLabel('medkit');
    const signature = `${key}|${alive}|${active}|${remaining}|${rules.bandage}|${hp >= 100}|${progress}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.inventory.hidden = !alive;
    this.hint.textContent = `STAY STILL · ${key} TO CANCEL`;
    // Conquest: BANDAGE ×N (×0 once spent); elsewhere the one MEDKIT ×1 / MEDKIT USED.
    const label = rules.bandage ? `BANDAGE ×${remaining}` : remaining ? 'MEDKIT ×1' : 'MEDKIT USED';
    this.inventory.title = rules.bandage
      ? `${rules.count} bandages per life, +${rules.hp} HP each. Stand still for ${rules.seconds} s.`
      : 'One medkit per life. Stand still while healing.';
    this.inventory.textContent = remaining ? `${key} · ${label}${hp >= 100 ? ' · FULL HEALTH' : ''}` : label;
    // Touch: no key to name and a 100 px HP card (styles/medkit.css shows this instead).
    this.inventory.dataset.compact = label;
    // The key on its own, for cards that draw it as a key badge (Conquest health row).
    this.inventory.dataset.key = remaining ? key : '';
    this.inventory.classList.toggle('is-spent', !remaining);
    this.root.hidden = !active;
    if (!active) return;
    this.time.textContent = `${((1 - progress) * rules.seconds).toFixed(1)}s`;
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
