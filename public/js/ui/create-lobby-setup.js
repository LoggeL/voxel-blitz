import {
  DEFAULT_MAP_ID,
  DEFAULT_MODE_ID,
  MAP_IDS,
  MODE_IDS,
  isModeMapCompatible,
  mapForMode,
  normalizeMapId,
  normalizeModeId,
} from '../../../shared/modes.js';
import {
  MAP_DESCRIPTIONS,
  MAP_LABELS,
  MAP_PREVIEWS,
  MODE_DESCRIPTIONS,
  MODE_LABELS,
  el,
  loadPref,
  loadPrefNum,
  saveName,
  savePref,
} from './hud-support.js';
import {
  formatMouseSensitivity,
  MOUSE_SENSITIVITY,
  SENSITIVITY_PREF_KEY,
} from '../input-settings.js';

function clampBots(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(7, Math.round(parsed))) : 3;
}

/** Owns the second, create-only step of the main menu. */
export class CreateLobbySetup {
  constructor({ parent, nameInput, getSensitivity, setSensitivity, onBack, onCreate }) {
    this.parent = parent;
    this.nameInput = nameInput;
    this.getSensitivity = getSensitivity;
    this.setSensitivity = setSensitivity;
    this.onBack = onBack;
    this.onCreate = onCreate;
    this.root = null;
    this.modeSelect = null;
    this.mapSelect = null;
    this.botSelect = null;
    this.sensitivityInput = null;
    this.firstFocus = null;
    this.previewImage = null;
    this.previewName = null;
    this.previewDescription = null;
    this.visible = false;
    this.build();
  }

  build() {
    const root = el('section', 'vb-create-step hidden', this.parent, 'create-lobby-step');
    root.setAttribute('aria-labelledby', 'create-step-title');
    root.setAttribute('aria-hidden', 'true');

    const header = el('div', 'vb-create-step-header', root);
    const back = el('button', 'vb-step-back', header, 'create-step-back');
    back.type = 'button';
    back.textContent = '← BACK';
    back.addEventListener('click', () => this.onBack?.());
    this.firstFocus = back;
    const heading = el('div', 'vb-create-step-heading', header);
    el('span', 'vb-step-kicker', heading).textContent = 'STEP 2 / 2 · HOST SETUP';
    const title = el('h2', 'vb-create-step-title', heading, 'create-step-title');
    title.textContent = 'CREATE LOBBY';

    const layout = el('div', 'vb-create-layout', root);
    const mission = el('div', 'vb-create-column', layout);
    const squad = el('div', 'vb-create-column', layout);

    const modeGroup = el('div', 'vb-menu-field-group', mission);
    const modeLabel = el('label', 'vb-label', modeGroup);
    modeLabel.textContent = 'MODE / RULESET';
    modeLabel.htmlFor = 'game-mode-select';
    const modeSelect = el('select', 'vb-select', modeGroup, 'game-mode-select');
    modeSelect.setAttribute('aria-describedby', 'game-mode-desc');
    for (const modeId of MODE_IDS) {
      const option = el('option', '', modeSelect);
      option.value = modeId;
      option.textContent = MODE_LABELS[modeId] || modeId.toUpperCase();
    }
    modeSelect.value = normalizeModeId(loadPref('vb-mode', DEFAULT_MODE_ID), DEFAULT_MODE_ID);
    const modeDescription = el('div', 'vb-field-desc', modeGroup, 'game-mode-desc');
    modeDescription.setAttribute('aria-live', 'polite');

    const mapGroup = el('div', 'vb-menu-field-group', mission);
    const mapLabel = el('label', 'vb-label', mapGroup);
    mapLabel.textContent = 'ARENA MAP';
    mapLabel.htmlFor = 'map-select';
    const mapSelect = el('select', 'vb-select', mapGroup, 'map-select');
    mapSelect.setAttribute('aria-describedby', 'map-desc');
    this.mapSelect = mapSelect;

    const preview = el('figure', 'vb-map-preview', mission);
    const previewImage = el('img', 'vb-map-preview-image', preview, 'map-preview-image');
    previewImage.width = 720;
    previewImage.height = 360;
    const previewCaption = el('figcaption', 'vb-map-preview-caption', preview);
    const previewName = el('strong', '', previewCaption);
    const previewDescription = el('span', '', previewCaption, 'map-desc');
    previewDescription.setAttribute('aria-live', 'polite');
    this.previewImage = previewImage;
    this.previewName = previewName;
    this.previewDescription = previewDescription;

    const syncMapOptions = (preferredMap = mapSelect.value) => {
      const mode = normalizeModeId(modeSelect.value, DEFAULT_MODE_ID);
      const validMaps = MAP_IDS.filter((mapId) => isModeMapCompatible(mode, mapId));
      mapSelect.innerHTML = '';
      for (const mapId of validMaps) {
        const option = el('option', '', mapSelect);
        option.value = mapId;
        option.textContent = MAP_LABELS[mapId] || mapId.toUpperCase();
      }
      mapSelect.value = mapForMode(mode, preferredMap);
      modeDescription.textContent = MODE_DESCRIPTIONS[mode] || '';
      this._updateMapPreview();
    };

    modeSelect.addEventListener('change', () => {
      const mode = normalizeModeId(modeSelect.value, DEFAULT_MODE_ID);
      savePref('vb-mode', mode);
      syncMapOptions(mapSelect.value);
      savePref('vb-map', mapSelect.value);
      syncBotControls();
    });
    mapSelect.addEventListener('change', () => {
      savePref('vb-map', normalizeMapId(mapSelect.value, DEFAULT_MAP_ID));
      this._updateMapPreview();
    });
    syncMapOptions(loadPref('vb-map', DEFAULT_MAP_ID));

    const rosterCard = el('section', 'vb-create-roster', squad);
    const rosterHeader = el('div', 'vb-create-roster-header', rosterCard);
    el('span', 'vb-label', rosterHeader).textContent = 'PLAYER LIST';
    const rosterCount = el('span', 'vb-create-roster-count', rosterHeader);
    const rosterList = el('div', 'vb-create-roster-list', rosterCard);
    rosterList.setAttribute('role', 'list');
    rosterList.setAttribute('aria-label', 'Planned lobby player list');

    const botsGroup = el('div', 'vb-menu-field-group', squad);
    const botsLabel = el('label', 'vb-label', botsGroup);
    botsLabel.textContent = 'BOT SETTINGS';
    botsLabel.htmlFor = 'bot-count';
    const botSelect = el('select', 'vb-select', botsGroup, 'bot-count');
    for (let count = 0; count <= 7; count += 1) {
      const option = el('option', '', botSelect);
      option.value = String(count);
      option.textContent = count === 0 ? 'NO BOTS' : `${count} TACTICAL BOTS`;
    }
    botSelect.value = String(clampBots(loadPrefNum('vb-bots', 3, 0, 7)));
    const botsHint = el('div', 'vb-field-desc', botsGroup);
    botsHint.textContent = 'Bots fill open slots; human operators take priority.';

    const sensitivityGroup = el('div', 'vb-menu-field-group', squad);
    const sensitivityHeader = el('div', 'vb-setting-header', sensitivityGroup);
    const sensitivityLabel = el('label', 'vb-label', sensitivityHeader);
    sensitivityLabel.textContent = 'MOUSE SENSITIVITY';
    sensitivityLabel.htmlFor = 'sens-slider';
    const sensitivityValue = el('span', 'vb-setting-val', sensitivityHeader, 'sens-val');
    const sensitivityInput = el('input', 'vb-slider', sensitivityGroup, 'sens-slider');
    sensitivityInput.type = 'range';
    sensitivityInput.min = String(MOUSE_SENSITIVITY.min);
    sensitivityInput.max = String(MOUSE_SENSITIVITY.max);
    sensitivityInput.step = String(MOUSE_SENSITIVITY.step);
    sensitivityInput.value = String(this.getSensitivity());
    const syncSensitivity = () => {
      const value = Number(sensitivityInput.value);
      sensitivityValue.textContent = formatMouseSensitivity(value);
      savePref(SENSITIVITY_PREF_KEY, value);
      this.setSensitivity(value);
    };
    sensitivityInput.addEventListener('input', syncSensitivity);
    syncSensitivity();

    const syncBotControls = () => {
      const training = normalizeModeId(modeSelect.value, DEFAULT_MODE_ID) === 'training';
      botSelect.disabled = training;
      botsHint.textContent = training
        ? 'Training mode: target dummies are built into the range.'
        : 'Bots fill open slots; human operators take priority.';
      renderRoster();
    };
    const renderRoster = () => {
      const training = normalizeModeId(modeSelect.value, DEFAULT_MODE_ID) === 'training';
      const bots = training ? 0 : clampBots(botSelect.value);
      if (!training) savePref('vb-bots', bots);
      const hostName = this.nameInput.value.trim().slice(0, 16) || 'OPERATOR';
      rosterCount.textContent = `${bots + 1} / 8 SLOTS`;
      rosterList.innerHTML = '';
      this._rosterRow(rosterList, hostName, 'HOST');
      for (let index = 0; index < bots; index++) {
        this._rosterRow(rosterList, `TACTICAL BOT ${String(index + 1).padStart(2, '0')}`, 'BOT');
      }
      for (let index = bots + 1; index < 8; index++) {
        this._rosterRow(rosterList, 'OPEN SLOT', 'OPEN', true);
      }
    };
    botSelect.addEventListener('change', renderRoster);
    this.nameInput.addEventListener('input', renderRoster);
    syncBotControls();

    const createButton = el('button', 'vb-btn vb-create-confirm', root, 'create-lobby-confirm-btn');
    createButton.type = 'button';
    createButton.textContent = 'CREATE LOBBY';
    createButton.addEventListener('click', () => {
      if (createButton.disabled) return;
      const name = this.nameInput.value.trim().slice(0, 16) || 'PLAYER';
      saveName(name);
      this.onCreate?.({
        mode: 'create',
        gameMode: normalizeModeId(modeSelect.value, DEFAULT_MODE_ID),
        map: normalizeMapId(mapSelect.value, DEFAULT_MAP_ID),
        name,
        bots: clampBots(botSelect.value),
        sensitivity: Number(sensitivityInput.value),
        code: '',
      });
    });
    const status = el('div', 'vb-status', root, 'create-lobby-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    this.root = root;
    this.modeSelect = modeSelect;
    this.botSelect = botSelect;
    this.sensitivityInput = sensitivityInput;
    this.status = status;
  }

  _updateMapPreview() {
    const normalized = normalizeMapId(this.mapSelect?.value, DEFAULT_MAP_ID);
    if (this.visible) this.previewImage.src = MAP_PREVIEWS[normalized];
    this.previewImage.alt = `${MAP_LABELS[normalized] || normalized} arena preview`;
    this.previewImage.dataset.map = normalized;
    this.previewName.textContent = MAP_LABELS[normalized] || normalized.toUpperCase();
    this.previewDescription.textContent = MAP_DESCRIPTIONS[normalized] || '';
  }

  _rosterRow(parent, name, badge, empty = false) {
    const row = el('div', `vb-create-player${empty ? ' is-empty' : ''}`, parent);
    row.setAttribute('role', 'listitem');
    el('span', 'vb-create-player-dot', row).setAttribute('aria-hidden', 'true');
    el('span', 'vb-create-player-name', row).textContent = name;
    el('span', `vb-create-player-badge vb-create-player-${badge.toLowerCase()}`, row).textContent = badge;
  }

  show() {
    this.visible = true;
    this._updateMapPreview();
    this.root.classList.remove('hidden');
    this.root.setAttribute('aria-hidden', 'false');
    this.firstFocus?.focus();
  }

  hide() {
    this.visible = false;
    this.root.classList.add('hidden');
    this.root.setAttribute('aria-hidden', 'true');
  }

  showStatus(message, tone = '') {
    if (!this.status) return;
    this.status.textContent = message || '';
    this.status.classList.toggle('ok', tone === 'ok');
    this.status.classList.toggle('err', tone === 'err');
  }
}
