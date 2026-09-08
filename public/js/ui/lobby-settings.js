import { MAP_IDS, MODE_IDS, isModeMapCompatible, mapForMode } from '../../../shared/modes.js';
import { el, MAP_LABELS, MODE_LABELS, savePref } from './hud-support.js';

/** Host controls edit the authoritative waiting room, never a draft lobby. */
export class LobbySettings {
  constructor(parent, onChange) {
    this.root = el('div', 'vb-lobby-settings', parent);
    this.controls = {};
    for (const [key, label, id] of [
      ['gameMode', 'GAME MODE', 'game-mode-select'],
      ['map', 'ARENA MAP', 'map-select'],
      ['bots', 'BOTS', 'bot-count'],
    ]) {
      const field = el('div', 'vb-menu-field-group', this.root);
      const caption = el('label', 'vb-label', field);
      caption.textContent = label;
      caption.htmlFor = id;
      const select = el('select', 'vb-select', field, id);
      this.controls[key] = select;
      select.addEventListener('change', () => {
        if (select.disabled) return;
        if (key === 'gameMode') this.syncMaps(select.value, this.controls.map.value);
        const settings = {
          gameMode: this.controls.gameMode.value,
          map: this.controls.map.value,
          bots: ['training', 'duel'].includes(this.controls.gameMode.value) ? 0 : Number(this.controls.bots.value),
        };
        savePref('vb-mode', settings.gameMode);
        savePref('vb-map', settings.map);
        savePref('vb-bots', settings.bots);
        onChange(settings);
      });
    }
    this.options(this.controls.gameMode, MODE_IDS, MODE_LABELS);
    this.options(this.controls.bots, Array.from({ length: 8 }, (_, i) => String(i)), {});
    this.loadout = el('div', 'vb-field-desc', this.root, 'lobby-weapon-set');
    this.hint = el('div', 'vb-field-desc', this.root);
  }

  options(select, values, labels) {
    select.innerHTML = '';
    for (const value of values) {
      const option = el('option', '', select);
      option.value = value;
      option.textContent = labels[value] || value;
    }
  }

  syncMaps(mode, preferred) {
    this.options(this.controls.map, MAP_IDS.filter((id) => isModeMapCompatible(mode, id)), MAP_LABELS);
    this.controls.map.value = mapForMode(mode, preferred);
  }

  update(state, isHost) {
    this.controls.gameMode.value = state.gameMode;
    this.syncMaps(state.gameMode, state.map);
    this.controls.bots.value = String(['training', 'duel'].includes(state.gameMode) ? 0 : state.bots);
    for (const [key, select] of Object.entries(this.controls)) {
      select.disabled = !isHost || state.phase !== 'waiting' || (key === 'bots' && ['training', 'duel'].includes(state.gameMode));
    }
    this.loadout.textContent = state.gameMode === 'duel'
      ? 'BASE 1V1 WEAPON SET: Rifle · Shotgun · Sniper · Revolver · Pixel Pick. No throwables.' : '';
    this.hint.textContent = state.gameMode === 'duel'
      ? 'Share the invite link. Two players, no bots. Both players must be ready.' : isHost
      ? 'Invite friends now. Changes reset readiness. Bots fill available slots.'
      : 'The host can change settings while everyone joins.';
  }
}
