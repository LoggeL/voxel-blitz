// LOADOUT: every equippable slot, what is in it, who sees it, and its options.
import { LOADOUT_SLOTS, treeNode } from '../../../../shared/career.js';
import { COSMETIC_AUDIO, cosmeticVolume } from '../cosmetic-preview.js';
import { weaponImagePath } from '../hud-support.js';
import { loadoutModel, slotOptions, slotOf, weaponName } from './armory-model.js';
import { art, button, glyph, node, standardItem } from './inspector.js';
import { focusKey, restoreFocus, rovingKeys, rovingSync } from './focus-nav.js';

const GROUPS = [['operator', 'OPERATOR'], ['hud', 'HUD']];
const target = (slot, id) => id === 'standard' ? { standard: true, slot } : id;

export class LoadoutPanel {
  constructor(panel, host) {
    this.panel = panel;
    this.host = host;
    this.slot = LOADOUT_SLOTS[0].id;
    this.root = node('div', panel, '', 'vb-armory-loadout');
    this.root.dataset.view = 'slots';
    this.rail = node('nav', this.root, '', 'vb-armory-slots');
    this.rail.setAttribute('aria-label', 'Loadout slots');
    this.options = node('div', this.root, '', 'vb-armory-options');
    rovingKeys(this.rail, '.vb-armory-slot, .vb-armory-weapon-row', { orientation: 'vertical' });
    rovingKeys(this.options, '.vb-armory-option', {
      onMove: option => host.inspector.preview(target(this.slot, option.dataset.option)),
    });
    // Previews follow hover and focus; leaving the option lists reverts to the pinned target.
    this.options.addEventListener('pointerover', event => {
      const option = event.target.closest?.('.vb-armory-option');
      if (option) host.inspector.preview(target(this.slot, option.dataset.option));
    });
    this.options.addEventListener('focusin', event => {
      const option = event.target.closest?.('.vb-armory-option');
      if (option) host.inspector.preview(target(this.slot, option.dataset.option));
    });
    this.options.addEventListener('pointerleave', () => host.inspector.revert());
    this.options.addEventListener('focusout', event => {
      if (!event.relatedTarget || !this.options.contains(event.relatedTarget)) host.inspector.revert();
    });
    // Mobile: Back/Escape inside the options view returns to the slot list first.
    this.root.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this.root.dataset.view === 'options' && this.host.mobile) {
        event.preventDefault();
        this.back();
      }
    });
  }

  get profile() { return this.host.profile; }

  /** The pinned inspector target for a slot: what it has equipped now. */
  equippedTarget(slotId = this.slot) {
    const equipped = this.profile?.equipped?.[slotId] || slotOf(slotId)?.standard || 'standard';
    return target(slotId, equipped);
  }

  selectSlot(slotId, { focusOptions = false } = {}) {
    if (!slotOf(slotId)) return;
    this.slot = slotId;
    if (this.host.mobile) {
      this.railScroll = this.panel.scrollTop;
      this.root.dataset.view = 'options';
    }
    this.render();
    // The pushed options view starts at its heading, not at the slot list's offset.
    if (this.host.mobile) this.panel.scrollTop = 0;
    this.host.inspector.inspect(this.equippedTarget(), { pin: true });
    if (focusOptions || this.host.mobile) (this.options.querySelector('.vb-armory-back:not([hidden])') || this.options.querySelector('[tabindex="0"].vb-armory-option'))?.focus();
  }

  back() {
    this.root.dataset.view = 'slots';
    this.panel.scrollTop = this.railScroll || 0;
    restoreFocus(this.rail, `slot:${this.slot}`);
  }

  render() {
    const profile = this.profile;
    if (!profile) return;
    const key = focusKey(this.root);
    this.renderRail(profile);
    this.renderOptions(profile);
    restoreFocus(this.root, key);
  }

  renderRail(profile) {
    const model = loadoutModel(profile, id => this.host.isNew(id));
    this.rail.replaceChildren();
    for (const [group, label] of GROUPS) {
      node('h4', this.rail, label, 'vb-armory-rail-heading');
      const list = node('ul', this.rail, '', 'vb-armory-slot-list');
      for (const slot of model.slots.filter(entry => entry.group === group)) {
        const item = node('li', list);
        const control = button(item, '', 'vb-armory-slot', () => this.selectSlot(slot.id));
        control.dataset.slot = slot.id;
        control.dataset.focusKey = `slot:${slot.id}`;
        if (slot.id === this.slot) control.setAttribute('aria-current', 'true');
        art(control, slot.equipped === 'standard' ? standardItem(slot.id) : treeNode(slot.equipped), 'thumb');
        const copy = node('span', control, '', 'vb-armory-slot-copy');
        node('span', copy, slot.label, 'vb-armory-slot-label');
        node('strong', copy, slot.equippedName, 'vb-armory-slot-name');
        node('span', copy, `${slot.unlocked} / ${slot.total} UNLOCKED`, 'vb-armory-slot-count');
        if (slot.isNew) {
          control.dataset.hasNew = 'true';
          const dot = node('span', control, '', 'vb-new-dot');
          node('span', dot, 'New unlocks', 'vb-sr');
        }
      }
    }
    node('h4', this.rail, 'WEAPONS', 'vb-armory-rail-heading');
    const list = node('ul', this.rail, '', 'vb-armory-slot-list vb-armory-weapon-list');
    for (const weapon of model.weapons) {
      const item = node('li', list);
      const control = button(item, '', 'vb-armory-weapon-row', () => this.host.open({ tab: 'weapons', weapon: weapon.weapon }));
      control.dataset.weaponRow = weapon.weapon;
      control.dataset.focusKey = `weapon:${weapon.weapon}`;
      const icon = node('img', control, '', 'vb-armory-weapon-icon');
      icon.src = weaponImagePath(weapon.weapon);
      icon.alt = '';
      icon.decoding = 'async';
      icon.loading = 'lazy';
      const copy = node('span', control, '', 'vb-armory-slot-copy');
      node('strong', copy, weapon.name, 'vb-armory-slot-name');
      node('span', copy, weapon.summary, 'vb-armory-slot-count');
    }
    rovingSync(this.rail, '.vb-armory-slot, .vb-armory-weapon-row');
  }

  renderOptions(profile) {
    const slot = slotOf(this.slot);
    this.options.replaceChildren();
    const back = button(this.options, '← ALL SLOTS', 'vb-armory-back', () => this.back());
    back.dataset.focusKey = 'loadout-back';
    const heading = node('h3', this.options, slot.label, 'vb-armory-options-title');
    heading.id = 'armory-options-title';
    node('p', this.options, `WHO SEES IT: ${slot.audience}`, 'vb-armory-audience');
    const options = slotOptions(profile, slot.id);
    const career = options.filter(option => option.group === 'career');
    const mastery = options.filter(option => option.group === 'mastery');
    const grid = this.grid(this.options, career);
    grid.setAttribute('aria-labelledby', 'armory-options-title');
    if (mastery.length) {
      const details = node('details', this.options, '', 'vb-armory-mastery-options');
      details.open = mastery.some(option => option.owned) || this.masteryOpen === true;
      // The grid's single tab stop never hides inside a collapsed group.
      details.addEventListener('toggle', () => { this.masteryOpen = details.open; rovingSync(this.options, '.vb-armory-option'); });
      const owned = mastery.filter(option => option.owned).length;
      node('summary', details, `MASTERY · ${owned} / ${mastery.length} UNLOCKED`);
      const weapons = [...new Set(mastery.map(option => option.weapon))];
      for (const weapon of weapons) {
        const group = node('div', details, '', 'vb-armory-subgroup');
        const title = node('h4', group, weaponName(weapon));
        title.id = `armory-options-${this.slot}-${weapon}`;
        this.grid(group, mastery.filter(option => option.weapon === weapon)).setAttribute('aria-labelledby', title.id);
      }
    }
    if (slot.id === 'sound') this.cueVolume(this.options);
    rovingSync(this.options, '.vb-armory-option');
  }

  grid(parent, options) {
    const grid = node('div', parent, '', 'vb-armory-grid');
    grid.setAttribute('role', 'listbox');
    for (const option of options) {
      const control = button(grid, '', 'vb-armory-option', () => this.activate(option.id, control));
      control.setAttribute('role', 'option');
      control.dataset.option = option.id;
      control.dataset.state = option.state;
      control.dataset.focusKey = `option:${this.slot}:${option.id}`;
      control.setAttribute('aria-selected', String(option.state === 'equipped'));
      const item = option.item || standardItem(this.slot);
      art(control, item, 'thumb', 'vb-armory-option-art');
      node('span', control, option.item ? option.item.name : 'Standard', 'vb-armory-option-name');
      const chip = node('span', control, '', 'vb-armory-chip');
      const fresh = option.item && this.host.isNew(option.id);
      const owned = () => { chip.replaceChildren(); glyph(chip, 'owned'); node('span', chip, 'UNLOCKED'); };
      if (fresh) control.dataset.new = option.id;
      if (option.state === 'equipped') { glyph(chip, 'equipped'); node('span', chip, 'EQUIPPED'); }
      else if (fresh) { glyph(chip, 'new'); node('span', chip, 'NEW', 'vb-new-chip'); control.onSeen = owned; }
      else if (option.state === 'owned') owned();
      else { glyph(chip, option.state === 'next' ? 'next' : 'locked'); node('span', chip, option.chip || 'LOCKED'); }
    }
    return grid;
  }

  /** Owned options equip; locked ones only inspect and say what they need. */
  activate(id, control) {
    const option = slotOptions(this.profile, this.slot).find(entry => entry.id === id);
    if (!option) return;
    const pinned = target(this.slot, id);
    this.host.inspector.inspect(pinned, { pin: true, reveal: true });
    if (option.state === 'equipped') return;
    if (!option.owned) {
      this.host.inspector.setStatus(`${option.item.name}: ${this.host.summary(option.item)}`);
      return;
    }
    this.host.equip(id === 'standard' ? { standard: true, slot: this.slot } : id, { control });
  }

  /** Per-cue volume, same keys and event as the in-match cosmetic audio. */
  cueVolume(parent) {
    const details = node('details', parent, '', 'vb-armory-cue-volume');
    details.open = this.cueOpen === true;
    details.addEventListener('toggle', () => { this.cueOpen = details.open; });
    node('summary', details, 'CUE VOLUME');
    node('p', details, 'Set each cue separately. Zero mutes that cue, including previews.');
    for (const [cue, setting] of Object.entries(COSMETIC_AUDIO)) {
      const row = node('div', details, '', 'vb-armory-cue');
      const label = node('label', row, setting.label);
      label.htmlFor = `armory-volume-${cue}`;
      const slider = node('input', row);
      slider.id = label.htmlFor;
      slider.dataset.focusKey = `cue:${cue}`;
      slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1';
      slider.value = String(Math.round(cosmeticVolume(cue) * 100));
      const output = node('output', row);
      output.htmlFor = slider.id;
      const mute = button(row, 'MUTE', 'vb-btn vb-armory-mute');
      mute.setAttribute('aria-label', `Mute ${setting.label.toLowerCase()}`);
      let lastVolume = Number(slider.value) || setting.defaultVolume * 100;
      const update = (save = false) => {
        const value = Number(slider.value);
        if (value > 0) lastVolume = value;
        output.value = output.textContent = value === 0 ? 'MUTED' : `${value}%`;
        slider.setAttribute('aria-valuetext', value === 0 ? 'Muted' : `${value} percent`);
        mute.textContent = value === 0 ? 'UNMUTE' : 'MUTE';
        mute.setAttribute('aria-pressed', String(value === 0));
        if (!save) return;
        try { localStorage.setItem(`vb-cosmetic-${cue}-volume`, String(value / 100)); } catch { /* per-viewer convenience */ }
        window.dispatchEvent(new CustomEvent('vb-cosmetic-volume', { detail: { cue, volume: value / 100 } }));
        const audition = this.host.inspector.audition;
        if (audition.active?.endsWith(`:${cue}`) && audition.audio) audition.audio.volume = value / 100;
      };
      slider.addEventListener('input', () => update(true));
      slider.addEventListener('keydown', event => { if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation(); });
      mute.addEventListener('click', () => { slider.value = Number(slider.value) === 0 ? String(lastVolume) : '0'; update(true); });
      update();
    }
    return details;
  }
}
