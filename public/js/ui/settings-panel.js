import { MAP_LABELS, MODE_LABELS, el, loadPrefNum, savePref } from './hud-support.js';
import {
  clampMouseSensitivity,
  formatMouseSensitivity,
  MOUSE_SENSITIVITY,
  SENSITIVITY_PREF_KEY,
} from '../input-settings.js';

/**
 * Owns the settings dialog's DOM, preferences, callbacks, focus, and close guard.
 * The host is deliberately read-only; dialog dismissal is a separate command so
 * admission cannot mutate or retain facade state.
 */
export class SettingsController {
  constructor(host = {}, dismissBuyMenu = null) {
    this.host = host;
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
    };
    this._settingsOnChange = null;
    this._settingsOnResume = null;
    this._settingsOnLeave = null;
    this._settingsPreviousFocus = null;
    this._isClosingSettings = false;
    this._deferredTimers = new Set();
    this.settingsDom = {};
  }

  get isOpen() {
    return !!this._settingsOpen;
  }

  setupSettings({ sensitivity, volume, fov, onChange, onResume, onLeave } = {}) {
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

  openSettings() {
    if (this.host.isLobbyOpen?.()) return;
    this.dismissBuyMenu();
    this.ensureSettings();
    this.syncSettingsUI();
    this._settingsPreviousFocus = document.activeElement;
    this._settingsOpen = true;

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
    this._settingsOpen = false;
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
    const title = el('h2', 'vb-title', nav, 'settings-title');
    title.textContent = 'MATCH PAUSED';
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

    const panel = el('section', 'vb-settings-panel', shell);
    el('span', 'vb-step-kicker', panel).textContent = 'CONTROLS';
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
    volLabel.textContent = 'MASTER VOLUME';
    volLabel.htmlFor = 'settings-vol-slider';
    const volVal = el('span', 'vb-setting-val', volHeader, 'settings-vol-val');
    const volSlider = el('input', 'vb-slider', volRow, 'settings-vol-slider');
    volSlider.type = 'range';
    volSlider.min = '0';
    volSlider.max = '1';
    volSlider.step = '0.01';
    volSlider.setAttribute('aria-label', 'Master Volume');
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

    const matchCard = el('aside', 'vb-pause-match-card', panel);
    el('span', 'vb-label', matchCard).textContent = 'CURRENT MATCH';
    const matchPlayers = el('strong', 'vb-pause-player-count', matchCard);
    matchPlayers.textContent = '0 PLAYERS';

    this.settingsDom = {
      root,
      shell,
      panel,
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
    };

    const onSliderChange = () => {
      const sensitivity = clampMouseSensitivity(sensSlider.value);
      const volume = Math.min(1, Math.max(0, parseFloat(volSlider.value) || 0));
      const fov = Math.min(100, Math.max(65, Math.round(parseFloat(fovSlider.value) || 75)));

      sensVal.textContent = formatMouseSensitivity(sensitivity);
      sensSlider.setAttribute('aria-valuenow', String(sensitivity));
      sensSlider.setAttribute('aria-valuetext', `${formatMouseSensitivity(sensitivity)} sensitivity`);

      volVal.textContent = `${Math.round(volume * 100)}%`;
      volSlider.setAttribute('aria-valuenow', String(volume));
      volSlider.setAttribute('aria-valuetext', `${Math.round(volume * 100)} percent`);

      fovVal.textContent = `${fov}°`;
      fovSlider.setAttribute('aria-valuenow', String(fov));
      fovSlider.setAttribute('aria-valuetext', `${fov} degrees`);

      this._settingsConfig = { sensitivity, volume, fov };
      savePref(SENSITIVITY_PREF_KEY, sensitivity);
      savePref('vb-volume', volume);
      savePref('vb-fov', fov);

      if (typeof this._settingsOnChange === 'function') {
        this._settingsOnChange({ sensitivity, volume, fov });
      }
    };

    sensSlider.addEventListener('input', onSliderChange);
    volSlider.addEventListener('input', onSliderChange);
    fovSlider.addEventListener('input', onSliderChange);

    const doResume = () => {
      if (this._isClosingSettings) return;
      this._isClosingSettings = true;
      try {
        this.closeSettings();
        if (typeof this._settingsOnResume === 'function') {
          this._settingsOnResume();
        }
      } finally {
        this._isClosingSettings = false;
      }
    };

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

    const summary = this.host.getMatchSummary?.() || {};
    const mode = MODE_LABELS[summary.mode] || String(summary.mode || 'LIVE MATCH').toUpperCase();
    const map = MAP_LABELS[summary.map] || String(summary.map || '').toUpperCase();
    if (dom.matchSub) dom.matchSub.textContent = map ? `${mode} · ${map}` : mode;
    if (dom.matchPlayers) {
      const players = Math.max(0, Number(summary.players) || 0);
      dom.matchPlayers.textContent = `${players} PLAYER${players === 1 ? '' : 'S'}`;
    }
  }

  dispose() {
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
