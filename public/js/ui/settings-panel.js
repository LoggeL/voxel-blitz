import { DISPLAY_OPTIONS, displaySettings, setDisplaySetting } from './display-settings.js';
import { mountMusicControl } from './music-control.js';
import { KeyboardSettings } from './keyboard-settings.js';
import { bindingLabel, subscribeKeybindings } from '../keybindings.js';
import { ConnectionSettings } from './connection-settings.js';
import { FrameRateSettings } from './frame-rate-settings.js';
import { MAP_LABELS, MODE_LABELS, el, loadPref, loadPrefNum, savePref } from './hud-support.js';
import {
  ADS_MODES,
  INPUT_PREF_KEYS,
  PAD_SENSITIVITY,
  POINTER_MODES,
  TOUCH_HANDS,
  TOUCH_SENSITIVITY,
  TOUCH_SIZES,
  clampMouseSensitivity,
  clampPadSensitivity,
  clampTouchSensitivity,
  formatMouseSensitivity,
  normalizeChoice,
  MOUSE_SENSITIVITY,
  SENSITIVITY_PREF_KEY,
} from '../input-settings.js';

const ADS_MODE_LABELS = Object.freeze({
  '': 'AUTO (HOLD · TOGGLE ON TRACKPAD)',
  hold: 'HOLD',
  toggle: 'TOGGLE',
});
const POINTER_MODE_LABELS = Object.freeze({
  auto: 'AUTO DETECT',
  mouse: 'MOUSE',
  trackpad: 'TRACKPAD',
});
const TOUCH_SIZE_LABELS = Object.freeze({ small: 'SMALL', medium: 'MEDIUM', large: 'LARGE' });
const TOUCH_HAND_LABELS = Object.freeze({ right: 'RIGHT HANDED', left: 'LEFT HANDED' });

function readChoicePref(key, choices, fallback) {
  try { return normalizeChoice(localStorage.getItem(key), choices, fallback); } catch (_) { return fallback; }
}

/**
 * Owns the settings dialog's DOM, preferences, callbacks, focus, and close guard.
 * The host is deliberately read-only; dialog dismissal is a separate command so
 * admission cannot mutate or retain facade state.
 */
export class SettingsController {
  constructor(host = {}, dismissBuyMenu = null, navigation = null) {
    this.host = host;
    this.navigation = navigation;
    this.dismissBuyMenu = typeof dismissBuyMenu === 'function' ? dismissBuyMenu : () => {};

    this._settingsOpen = false;
    this._settingsConfig = {
      sensitivity: loadPrefNum(
        SENSITIVITY_PREF_KEY,
        MOUSE_SENSITIVITY.default,
        MOUSE_SENSITIVITY.min,
        MOUSE_SENSITIVITY.max,
      ),
      volume: loadPrefNum('vb-volume', 0.80, 0, 1),
      fov: loadPrefNum('vb-fov', 75, 65, 100),
      adsMode: readChoicePref(INPUT_PREF_KEYS.adsMode, ADS_MODES, ''),
      pointerMode: readChoicePref(INPUT_PREF_KEYS.pointerMode, POINTER_MODES, 'auto'),
      padSensitivity: clampPadSensitivity(loadPrefNum(INPUT_PREF_KEYS.padSensitivity, PAD_SENSITIVITY.default)),
      touchSensitivity: clampTouchSensitivity(
        loadPrefNum(INPUT_PREF_KEYS.touchSensitivity, TOUCH_SENSITIVITY.default),
      ),
      touchSize: readChoicePref(INPUT_PREF_KEYS.touchSize, TOUCH_SIZES, 'medium'),
      touchHand: readChoicePref(INPUT_PREF_KEYS.touchHand, TOUCH_HANDS, 'right'),
      aimAssist: loadPref(INPUT_PREF_KEYS.aimAssist, '1') !== '0',
    };
    this._device = { touch: false, pointerKind: 'mouse', trackpadDetected: false, padActive: false };
    this._settingsOnChange = null;
    this._settingsOnResume = null;
    this._settingsOnLeave = null;
    this._settingsPreviousFocus = null;
    this._isClosingSettings = false;
    this._deferredTimers = new Set();
    this.settingsDom = {};
    this.connection = new ConnectionSettings();
    this.frameRate = new FrameRateSettings();
    this.keyboard = new KeyboardSettings();
    this._unsubscribeBindings = subscribeKeybindings(() => this._syncKeyHints());
  }

  get isOpen() {
    return !!this._settingsOpen;
  }

  setupSettings({
    sensitivity, volume, fov, options, device, onChange, onResume, onLeave, connection,
  } = {}) {
    if (connection) this.connection.configure(connection);
    if (options && typeof options === 'object') this._adoptOptions(options);
    if (device && typeof device === 'object') this.setDeviceInfo(device);
    if (sensitivity != null && Number.isFinite(+sensitivity)) {
      this._settingsConfig.sensitivity = clampMouseSensitivity(sensitivity);
      savePref(SENSITIVITY_PREF_KEY, this._settingsConfig.sensitivity);
    }
    if (volume != null && Number.isFinite(+volume)) {
      this._settingsConfig.volume = Math.min(1, Math.max(0, +volume));
      savePref('vb-volume', this._settingsConfig.volume);
    }
    if (fov != null && Number.isFinite(+fov)) {
      this._settingsConfig.fov = Math.min(100, Math.max(65, Math.round(+fov)));
      savePref('vb-fov', this._settingsConfig.fov);
    }
    if (typeof onChange === 'function') {
      this._settingsOnChange = onChange;
    }
    if (typeof onResume === 'function') {
      this._settingsOnResume = onResume;
    }
    if (typeof onLeave === 'function') {
      this._settingsOnLeave = onLeave;
    }

    this.ensureSettings();
    this.syncSettingsUI();
  }

  /** Device facts drive which rows show and the detection hint copy. */
  setDeviceInfo(device = {}) {
    this._device = {
      touch: !!device.touch,
      pointerKind: device.pointerKind === 'trackpad' ? 'trackpad' : 'mouse',
      trackpadDetected: !!device.trackpadDetected,
      padActive: !!device.padActive,
    };
    this.syncSettingsUI();
  }

  _adoptOptions(options) {
    const c = this._settingsConfig;
    if ('adsMode' in options) c.adsMode = normalizeChoice(options.adsMode, ADS_MODES, '');
    if ('pointerMode' in options) c.pointerMode = normalizeChoice(options.pointerMode, POINTER_MODES, 'auto');
    if ('padSensitivity' in options) c.padSensitivity = clampPadSensitivity(options.padSensitivity, c.padSensitivity);
    if ('touchSensitivity' in options) {
      c.touchSensitivity = clampTouchSensitivity(options.touchSensitivity, c.touchSensitivity);
    }
    if ('touchSize' in options) c.touchSize = normalizeChoice(options.touchSize, TOUCH_SIZES, c.touchSize);
    if ('touchHand' in options) c.touchHand = normalizeChoice(options.touchHand, TOUCH_HANDS, c.touchHand);
    if ('aimAssist' in options) c.aimAssist = options.aimAssist !== false && options.aimAssist !== '0';
  }

  _optionsSnapshot() {
    const c = this._settingsConfig;
    return {
      adsMode: c.adsMode,
      pointerMode: c.pointerMode,
      padSensitivity: c.padSensitivity,
      touchSensitivity: c.touchSensitivity,
      touchSize: c.touchSize,
      touchHand: c.touchHand,
      aimAssist: c.aimAssist,
    };
  }

  openSettings() {
    if (this.host.isLobbyOpen?.()) return;
    this.dismissBuyMenu();
    this.ensureSettings();
    this.syncSettingsUI();
    this._settingsPreviousFocus = document.activeElement;
    this.connection.update(true);
    this._settingsOpen = true;
    this.navigation?.open(this, () => this.resume());

    const { root } = this.settingsDom;
    if (root) {
      root.classList.remove('hidden');
      root.style.display = 'flex';
      root.setAttribute('aria-hidden', 'false');
    }

    this._defer(() => {
      try {
        if (this._settingsOpen && this.settingsDom.resumeBtn) {
          this.settingsDom.resumeBtn.focus();
        }
      } catch (_) {}
    });
  }

  closeSettings() {
    this.keyboard.cancel();
    this._settingsOpen = false;
    this.navigation?.close(this);
    const root = this.settingsDom.root;
    if (root) {
      root.classList.add('hidden');
      root.style.display = 'none';
      root.setAttribute('aria-hidden', 'true');
    }

    const previousFocus = this._settingsPreviousFocus;
    this._settingsPreviousFocus = null;
    if (
      previousFocus
      && !root?.contains(previousFocus)
      && typeof previousFocus.focus === 'function'
    ) {
      try { previousFocus.focus(); } catch (_) {}
    }
  }

  resume() {
    if (this._isClosingSettings) return;
    this._isClosingSettings = true;
    try {
      this.closeSettings();
      this._settingsOnResume?.();
    } finally {
      this._isClosingSettings = false;
    }
  }

  ensureSettings() {
    if (this.settingsDom.root) return this.settingsDom.root;

    const root = el('div', 'hidden', document.body, 'settings-overlay');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'settings-title');
    root.setAttribute('aria-hidden', 'true');
    root.style.display = 'none';

    const shell = el('div', 'vb-pause-shell', root);
    const nav = el('aside', 'vb-pause-rail', shell);
    el('div', 'vb-pause-brand', nav).textContent = 'VOXEL BLITZ';
    const title = el('h2', 'vb-title', nav, 'settings-title');
    title.textContent = 'IN-GAME MENU';
    const sub = el('div', 'vb-sub vb-pause-match-name', nav);
    sub.textContent = 'LIVE MATCH';

    const resumeBtn = el('button', 'vb-btn vb-resume-btn', nav, 'settings-resume-btn');
    resumeBtn.type = 'button';
    resumeBtn.textContent = 'RESUME';

    const current = el('div', 'vb-pause-nav-current', nav);
    current.textContent = 'SETTINGS';

    const leaveBtn = el('button', 'vb-btn vb-leave-match-btn', nav, 'settings-leave-btn');
    leaveBtn.type = 'button';
    leaveBtn.textContent = 'QUIT TO MAIN MENU';

    const hint = el('div', 'vb-settings-hint', nav);
    hint.textContent = 'ESC · RESUME';
    el('p', 'vb-pause-notice', nav).textContent = 'Multiplayer continues while this menu is open.';
    mountMusicControl(nav);

    const panel = el('section', 'vb-settings-panel', shell);
    el('h2', 'vb-settings-heading', panel).textContent = 'SETTINGS';
    el('p', 'vb-settings-subtitle', panel).textContent = 'Make it feel right.';
    const tabs = el('div', 'vb-settings-tabs', panel);
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Settings category');
    const controls = el('div', 'vb-settings-controls', panel);

    const sensRow = el('div', 'vb-setting-row', controls);
    const sensHeader = el('div', 'vb-setting-header', sensRow);
    const sensLabel = el('label', 'vb-label', sensHeader);
    sensLabel.textContent = 'MOUSE SENSITIVITY';
    sensLabel.htmlFor = 'settings-sens-slider';
    const sensVal = el('span', 'vb-setting-val', sensHeader, 'settings-sens-val');
    const sensSlider = el('input', 'vb-slider', sensRow, 'settings-sens-slider');
    sensSlider.type = 'range';
    sensSlider.min = String(MOUSE_SENSITIVITY.min);
    sensSlider.max = String(MOUSE_SENSITIVITY.max);
    sensSlider.step = String(MOUSE_SENSITIVITY.step);
    sensSlider.setAttribute('aria-label', 'Mouse Sensitivity');
    sensSlider.setAttribute('aria-valuemin', String(MOUSE_SENSITIVITY.min));
    sensSlider.setAttribute('aria-valuemax', String(MOUSE_SENSITIVITY.max));

    const volRow = el('div', 'vb-setting-row', controls);
    const volHeader = el('div', 'vb-setting-header', volRow);
    const volLabel = el('label', 'vb-label', volHeader);
    volLabel.textContent = 'SOUND EFFECTS';
    volLabel.htmlFor = 'settings-vol-slider';
    const volVal = el('span', 'vb-setting-val', volHeader, 'settings-vol-val');
    const volSlider = el('input', 'vb-slider', volRow, 'settings-vol-slider');
    volSlider.type = 'range';
    volSlider.min = '0';
    volSlider.max = '1';
    volSlider.step = '0.01';
    volSlider.setAttribute('aria-label', 'Sound effects volume');
    volSlider.setAttribute('aria-valuemin', '0');
    volSlider.setAttribute('aria-valuemax', '1');

    const fovRow = el('div', 'vb-setting-row', controls);
    const fovHeader = el('div', 'vb-setting-header', fovRow);
    const fovLabel = el('label', 'vb-label', fovHeader);
    fovLabel.textContent = 'FIELD OF VIEW';
    fovLabel.htmlFor = 'settings-fov-slider';
    const fovVal = el('span', 'vb-setting-val', fovHeader, 'settings-fov-val');
    const fovSlider = el('input', 'vb-slider', fovRow, 'settings-fov-slider');
    fovSlider.type = 'range';
    fovSlider.min = '65';
    fovSlider.max = '100';
    fovSlider.step = '1';
    fovSlider.setAttribute('aria-label', 'Field of View');
    fovSlider.setAttribute('aria-valuemin', '65');
    fovSlider.setAttribute('aria-valuemax', '100');

    const choiceRow = (id, labelText, choices, labels) => {
      const row = el('div', 'vb-setting-row', controls);
      const header = el('div', 'vb-setting-header', row);
      const label = el('label', 'vb-label', header);
      label.textContent = labelText;
      label.htmlFor = id;
      const hint = el('span', 'vb-setting-val', header, `${id}-hint`);
      const select = el('select', 'vb-select', row, id);
      select.setAttribute('aria-label', labelText);
      for (const choice of choices) {
        const option = el('option', '', select);
        option.value = choice;
        option.textContent = labels[choice] || String(choice).toUpperCase();
      }
      return { row, select, hint };
    };
    const sliderRow = (id, labelText, spec) => {
      const row = el('div', 'vb-setting-row', controls);
      const header = el('div', 'vb-setting-header', row);
      const label = el('label', 'vb-label', header);
      label.textContent = labelText;
      label.htmlFor = id;
      const value = el('span', 'vb-setting-val', header, `${id}-val`);
      const slider = el('input', 'vb-slider', row, id);
      slider.type = 'range';
      slider.min = String(spec.min);
      slider.max = String(spec.max);
      slider.step = String(spec.step);
      slider.setAttribute('aria-label', labelText);
      slider.setAttribute('aria-valuemin', String(spec.min));
      slider.setAttribute('aria-valuemax', String(spec.max));
      return { row, slider, value };
    };

    const adsMode = choiceRow('settings-ads-mode', 'AIM DOWN SIGHTS', ['', ...ADS_MODES], ADS_MODE_LABELS);
    const pointerMode = choiceRow('settings-pointer-mode', 'POINTING DEVICE', POINTER_MODES, POINTER_MODE_LABELS);
    const padSens = sliderRow('settings-pad-sens', 'GAMEPAD SENSITIVITY', PAD_SENSITIVITY);
    const aimAssist = choiceRow('settings-aim-assist', 'AIM ASSIST (PAD · TOUCH)', ['1', '0'], { 1: 'ON', 0: 'OFF' });
    const touchSens = sliderRow('settings-touch-sens', 'TOUCH LOOK SENSITIVITY', TOUCH_SENSITIVITY);
    const touchSize = choiceRow('settings-touch-size', 'TOUCH CONTROL SIZE', TOUCH_SIZES, TOUCH_SIZE_LABELS);
    const touchHand = choiceRow('settings-touch-hand', 'TOUCH LAYOUT', TOUCH_HANDS, TOUCH_HAND_LABELS);

    const meleeHint = el('p', 'vb-settings-hint', controls);
    const medkitHint = el('p', 'vb-settings-hint', controls);
    const groups = { controls: [...controls.children], keyboard: [this.keyboard.mount(controls)], display: [], debug: [] };
    groups.display.push(this.frameRate.mount(controls));
    let category = 'display';
    const displaySelects = {};
    for (const option of DISPLAY_OPTIONS) {
      if (option.section?.toLowerCase().includes('debug')) category = 'debug';
      const before = controls.children.length;
      const control = choiceRow(`settings-${option.key}`, option.label, ['0', '1'], { 0: 'OFF', 1: 'ON' });
      control.select.value = displaySettings()[option.key] ? '1' : '0';
      control.select.addEventListener('change', () => {
        setDisplaySetting(option.key, control.select.value === '1');
      });
      displaySelects[option.key] = control.select;
      if (option.key === 'reducedMotion') {
        el('p', 'vb-settings-hint', controls).textContent = 'Defaults to your system preference. Reduces cosmetic breathing, weapon bob, flashes and camera shake. Shot direction and aiming sway stay the same.';
      }
      groups[category].push(...Array.from(controls.children).slice(before));
    }
    const debugHint = el('p', 'vb-settings-hint', controls);
    debugHint.textContent = 'HITBOXES: cyan body, orange headshot zone. Uses server dimensions at interpolated player positions, not the server rewind. Walls still occlude these views.';

    groups.debug.push(debugHint);
    groups.connection = [this.connection.mount(controls)];
    const tabButtons = [];
    const activate = (key) => {
      this.keyboard.cancel();
      for (const [group, nodes] of Object.entries(groups)) for (const node of nodes) node.hidden = group !== key;
      for (const button of tabButtons) {
        button.setAttribute('aria-selected', String(button.dataset.group === key));
        button.tabIndex = button.dataset.group === key ? 0 : -1;
      }
      controls.setAttribute('aria-labelledby', `settings-tab-${key}`);
    };
    controls.id = 'settings-category-panel';
    controls.setAttribute('role', 'tabpanel');
    for (const key of Object.keys(groups)) {
      const button = el('button', 'vb-settings-tab', tabs, `settings-tab-${key}`);
      button.type = 'button'; button.textContent = key.toUpperCase(); button.dataset.group = key;
      button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', controls.id);
      button.addEventListener('click', () => activate(key));
      button.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = tabButtons.indexOf(button);
        const count = tabButtons.length;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : (index + (event.key === 'ArrowRight' ? 1 : count - 1)) % count;
        tabButtons[next].click(); tabButtons[next].focus();
      });
      tabButtons.push(button);
    }
    activate('controls');

    const matchCard = el('aside', 'vb-pause-match-card', panel);
    el('span', 'vb-label', matchCard).textContent = 'CURRENT MATCH';
    const matchPlayers = el('strong', 'vb-pause-player-count', matchCard);
    matchPlayers.textContent = '0 PLAYERS';

    this.settingsDom = {
      root,
      shell,
      panel,
      displaySelects,
      meleeHint,
      medkitHint,
      matchSub: sub,
      matchPlayers,
      sensSlider,
      sensVal,
      volSlider,
      volVal,
      fovSlider,
      fovVal,
      resumeBtn,
      leaveBtn,
      adsModeRow: adsMode.row,
      adsModeSelect: adsMode.select,
      adsModeHint: adsMode.hint,
      pointerModeRow: pointerMode.row,
      pointerModeSelect: pointerMode.select,
      pointerModeHint: pointerMode.hint,
      padSensRow: padSens.row,
      padSensSlider: padSens.slider,
      padSensVal: padSens.value,
      aimAssistRow: aimAssist.row,
      aimAssistSelect: aimAssist.select,
      touchSensRow: touchSens.row,
      touchSensSlider: touchSens.slider,
      touchSensVal: touchSens.value,
      touchSizeRow: touchSize.row,
      touchSizeSelect: touchSize.select,
      touchHandRow: touchHand.row,
      touchHandSelect: touchHand.select,
    };

    const onSliderChange = () => {
      const sensitivity = clampMouseSensitivity(sensSlider.value);
      const volume = Math.min(1, Math.max(0, parseFloat(volSlider.value) || 0));
      const fov = Math.min(100, Math.max(65, Math.round(parseFloat(fovSlider.value) || 75)));
      this._adoptOptions({
        adsMode: adsMode.select.value,
        pointerMode: pointerMode.select.value,
        padSensitivity: padSens.slider.value,
        aimAssist: aimAssist.select.value,
        touchSensitivity: touchSens.slider.value,
        touchSize: touchSize.select.value,
        touchHand: touchHand.select.value,
      });
      const options = this._optionsSnapshot();
      savePref(INPUT_PREF_KEYS.adsMode, options.adsMode);
      savePref(INPUT_PREF_KEYS.pointerMode, options.pointerMode);
      savePref(INPUT_PREF_KEYS.padSensitivity, options.padSensitivity);
      savePref(INPUT_PREF_KEYS.aimAssist, options.aimAssist ? '1' : '0');
      savePref(INPUT_PREF_KEYS.touchSensitivity, options.touchSensitivity);
      savePref(INPUT_PREF_KEYS.touchSize, options.touchSize);
      savePref(INPUT_PREF_KEYS.touchHand, options.touchHand);

      sensVal.textContent = formatMouseSensitivity(sensitivity);
      sensSlider.setAttribute('aria-valuenow', String(sensitivity));
      sensSlider.setAttribute('aria-valuetext', `${formatMouseSensitivity(sensitivity)} sensitivity`);

      volVal.textContent = `${Math.round(volume * 100)}%`;
      volSlider.setAttribute('aria-valuenow', String(volume));
      volSlider.setAttribute('aria-valuetext', `${Math.round(volume * 100)} percent`);

      fovVal.textContent = `${fov}°`;
      fovSlider.setAttribute('aria-valuenow', String(fov));
      fovSlider.setAttribute('aria-valuetext', `${fov} degrees`);

      this._settingsConfig = { ...this._settingsConfig, sensitivity, volume, fov };
      savePref(SENSITIVITY_PREF_KEY, sensitivity);
      savePref('vb-volume', volume);
      savePref('vb-fov', fov);
      this._syncDeviceRows();

      if (typeof this._settingsOnChange === 'function') {
        this._settingsOnChange({ sensitivity, volume, fov, ...options });
      }
    };

    sensSlider.addEventListener('input', onSliderChange);
    volSlider.addEventListener('input', onSliderChange);
    fovSlider.addEventListener('input', onSliderChange);
    padSens.slider.addEventListener('input', onSliderChange);
    touchSens.slider.addEventListener('input', onSliderChange);
    for (const select of [adsMode.select, pointerMode.select, aimAssist.select,
      touchSize.select, touchHand.select]) {
      select.addEventListener('change', onSliderChange);
    }

    const doResume = () => this.resume();

    resumeBtn.addEventListener('click', doResume);
    leaveBtn.addEventListener('click', () => {
      if (this._isClosingSettings || typeof this._settingsOnLeave !== 'function') return;
      this._isClosingSettings = true;
      try {
        this.closeSettings();
        this._settingsOnLeave();
      } finally {
        this._isClosingSettings = false;
      }
    });
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        doResume();
      }
    });

    this.syncSettingsUI();
    return root;
  }

  syncSettingsUI() {
    const dom = this.settingsDom;
    if (!dom.sensSlider) return;
    const config = this._settingsConfig;

    dom.sensSlider.value = String(config.sensitivity);
    dom.sensVal.textContent = formatMouseSensitivity(config.sensitivity);
    dom.sensSlider.setAttribute('aria-valuenow', String(config.sensitivity));
    dom.sensSlider.setAttribute('aria-valuetext', `${formatMouseSensitivity(config.sensitivity)} sensitivity`);

    dom.volSlider.value = String(config.volume);
    dom.volVal.textContent = `${Math.round(config.volume * 100)}%`;
    dom.volSlider.setAttribute('aria-valuenow', String(config.volume));
    dom.volSlider.setAttribute('aria-valuetext', `${Math.round(config.volume * 100)} percent`);

    dom.fovSlider.value = String(config.fov);
    dom.fovVal.textContent = `${config.fov}°`;
    dom.fovSlider.setAttribute('aria-valuenow', String(config.fov));
    dom.fovSlider.setAttribute('aria-valuetext', `${config.fov} degrees`);
    for (const [key, select] of Object.entries(dom.displaySelects || {})) {
      select.value = displaySettings()[key] ? '1' : '0';
    }
    this._syncDeviceRows();
    this._syncKeyHints();

    const summary = this.host.getMatchSummary?.() || {};
    const mode = MODE_LABELS[summary.mode] || String(summary.mode || 'LIVE MATCH').toUpperCase();
    const map = MAP_LABELS[summary.map] || String(summary.map || '').toUpperCase();
    if (dom.matchSub) dom.matchSub.textContent = map ? `${mode} · ${map}` : mode;
    if (dom.matchPlayers) {
      const players = Math.max(0, Number(summary.players) || 0);
      dom.matchPlayers.textContent = `${players} PLAYER${players === 1 ? '' : 'S'}`;
    }
  }

  /** Device rows: pointer/ADS on desktop, touch layout on touch, pad rows when a pad is live. */
  _syncDeviceRows() {
    const dom = this.settingsDom;
    if (!dom.adsModeSelect) return;
    const config = this._settingsConfig;
    const device = this._device;
    const show = (row, visible) => {
      if (!row) return;
      row.style.display = visible ? '' : 'none';
      row.setAttribute('aria-hidden', visible ? 'false' : 'true');
    };
    dom.adsModeSelect.value = config.adsMode;
    dom.pointerModeSelect.value = config.pointerMode;
    dom.padSensSlider.value = String(config.padSensitivity);
    dom.padSensVal.textContent = `${config.padSensitivity.toFixed(1)} rad/s`;
    dom.padSensSlider.setAttribute('aria-valuenow', String(config.padSensitivity));
    dom.aimAssistSelect.value = config.aimAssist ? '1' : '0';
    dom.touchSensSlider.value = String(config.touchSensitivity);
    dom.touchSensVal.textContent = `${Math.round(config.touchSensitivity * 100)}%`;
    dom.touchSensSlider.setAttribute('aria-valuenow', String(config.touchSensitivity));
    dom.touchSizeSelect.value = config.touchSize;
    dom.touchHandSelect.value = config.touchHand;

    const effectivePointer = config.pointerMode === 'auto'
      ? (device.trackpadDetected ? 'trackpad' : 'mouse')
      : config.pointerMode;
    dom.pointerModeHint.textContent = config.pointerMode === 'auto'
      ? (device.trackpadDetected ? 'TRACKPAD DETECTED' : 'MOUSE')
      : POINTER_MODE_LABELS[config.pointerMode];
    dom.adsModeHint.textContent = config.adsMode
      ? ''
      : `${effectivePointer === 'trackpad' ? 'TOGGLE' : 'HOLD'} · ${bindingLabel('ads')} OR RIGHT CLICK`;

    show(dom.pointerModeRow, !device.touch);
    show(dom.adsModeRow, !device.touch);
    show(dom.padSensRow, device.padActive);
    show(dom.aimAssistRow, device.padActive || device.touch);
    show(dom.touchSensRow, device.touch);
    show(dom.touchSizeRow, device.touch);
    show(dom.touchHandRow, device.touch);
  }

  _syncKeyHints() {
    const dom = this.settingsDom;
    if (dom.meleeHint) dom.meleeHint.textContent = `${bindingLabel('quickMelee')}: quick pickaxe hit for melee or mining. Your current weapon returns after the swing.`;
    if (dom.medkitHint) dom.medkitHint.textContent = `${bindingLabel('medkit')}: use your medkit. Stand still for 4 seconds to fully heal. Moving, taking damage, or using a weapon cancels it. One kit per life, spent only after healing. Press again to cancel.`;
    this._syncDeviceRows();
  }

  dispose() {
    this._unsubscribeBindings?.();
    this.keyboard.dispose();
    this.connection.dispose();
    for (const timer of this._deferredTimers) clearTimeout(timer);
    this._deferredTimers.clear();

    this.closeSettings();
    this.settingsDom.root?.remove();

    this._settingsOnChange = null;
    this._settingsOnResume = null;
    this._settingsOnLeave = null;
    this.settingsDom = {};
    this._isClosingSettings = false;
    this._settingsOpen = false;
    this._settingsPreviousFocus = null;
  }

  _defer(callback) {
    const timer = setTimeout(() => {
      this._deferredTimers.delete(timer);
      callback();
    }, 0);
    this._deferredTimers.add(timer);
    return timer;
  }
}
