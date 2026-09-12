import { DUEL_KILL_LIMITS, DEFAULT_DUEL_KILL_LIMIT, MAP_IDS, MODE_IDS, isModeMapCompatible, mapForMode } from '../../../shared/modes.js';
import { el, MAP_LABELS, MODE_LABELS, savePref } from './hud-support.js';
import { MAX_BOTS, lobbyCapacity } from '../../../shared/lobby-limits.js';

/** Host controls edit the authoritative waiting room, never a draft lobby. */
export class LobbySettings {
  constructor(parent, onChange) {
    this.root = el('div', 'vb-lobby-settings', parent);
    this.controls = {};
    for (const [key, label, id] of [
      ['gameMode', 'GAME MODE', 'game-mode-select'],
      ['map', 'ARENA MAP', 'map-select'],
      ['bots', 'BOTS', 'bot-count'],
      ['duelKillLimit', '1V1 WIN CONDITION', 'duel-kill-limit'],
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
        const limit = lobbyCapacity(this.controls.gameMode.value, this.controls.map.value);
        const settings = {
          gameMode: this.controls.gameMode.value,
          duelKillLimit: Number(this.controls.duelKillLimit.value),
          map: this.controls.map.value,
          bots: ['training', 'duel', 'bastion'].includes(this.controls.gameMode.value) ? 0 : Math.max(0, Math.min(Number(this.controls.bots.value), limit - this.humanCount)),
        };
        // A rapid second map choice must use the already-trimmed bot request.
        this.controls.bots.value = String(settings.bots);
        savePref('vb-mode', settings.gameMode);
        savePref('vb-map', settings.map);
        savePref('vb-bots', settings.bots);
        onChange(settings);
      });
    }
    this.options(this.controls.gameMode, MODE_IDS, MODE_LABELS);
    this.options(this.controls.bots, Array.from({ length: MAX_BOTS + 1 }, (_, i) => String(i)), {});
    this.options(this.controls.duelKillLimit, DUEL_KILL_LIMITS.map(String),
      Object.fromEntries(DUEL_KILL_LIMITS.map(n => [n, `First to ${n} kills`])));
    this.controls.duelKillLimit.value = String(DEFAULT_DUEL_KILL_LIMIT);
    this.loadout = el('div', 'vb-field-desc', this.root, 'lobby-weapon-set');
    this.capacity = el('div', 'vb-map-capacity', this.root, 'lobby-map-capacity');
    this.capacity.setAttribute('role', 'status');
    this.humanCount = 1;
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
    for (const option of this.controls.map.options) {
      const limit = lobbyCapacity(mode, option.value);
      option.textContent = `${MAP_LABELS[option.value]} · ${limit} PLAYERS`;
      option.disabled = this.humanCount > limit;
    }
  }

  update(state, isHost) {
    this.humanCount = state.members?.filter(member => !member.bot).length || 1;
    this.controls.duelKillLimit.value = String(state.duelKillLimit ?? DEFAULT_DUEL_KILL_LIMIT);
    this.controls.duelKillLimit.parentNode.hidden = state.gameMode !== 'duel';
    this.controls.gameMode.value = state.gameMode;
    this.syncMaps(state.gameMode, state.map);
    this.controls.bots.value = String(['training', 'duel', 'bastion'].includes(state.gameMode) ? 0 : state.bots);
    const limit = lobbyCapacity(state.gameMode, state.map);
    for (const option of this.controls.bots.options) {
      option.disabled = Number(option.value) > limit - this.humanCount;
      option.hidden = option.disabled;
    }
    for (const [key, select] of Object.entries(this.controls)) {
      select.disabled = !isHost || state.phase !== 'waiting' || (key === 'bots' && ['training', 'duel', 'bastion'].includes(state.gameMode));
    }
    this.loadout.textContent = state.gameMode === 'duel'
      ? 'BASE 1V1 WEAPON SET: Rifle · Shotgun · Sniper · Revolver · Pixel Pick. No throwables.' : '';
    this.capacity.textContent = `${state.members?.length || 0} / ${limit} SLOTS · ${MAP_LABELS[state.map] || state.map}`;
    this.hint.textContent = state.gameMode === 'bastion'
      ? '1–4 players defend Reactor 9 through 8 waves. Enemy waves are automatic. No friendly bots.' : state.gameMode === 'duel'
      ? 'Share the invite link. Two players, no bots. Both players must be ready.' : isHost
      ? 'Smaller maps reduce bots. Joining friends replace bots when full. Changes reset readiness.'
      : 'The host can change settings while everyone joins.';
  }
}
