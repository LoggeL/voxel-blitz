import { el, loadPrefNum, savePref } from './hud-support.js';

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
      sensitivity: loadPrefNum('vb-sens', 0.030, 0.005, 0.08),
      volume: loadPrefNum('vb-volume', 0.80, 0, 1),
      fov: loadPrefNum('vb-fov', 75, 65, 100),
    };
    this._settingsOnChange = null;
    this._settingsOnResume = null;
    this._settingsPreviousFocus = null;
    this._isClosingSettings = false;
    this._deferredTimers = new Set();
    this.settingsDom = {};
  }

  get isOpen() {
    return !!this._settingsOpen;
  }

  setupSettings({ sensitivity, volume, fov, onChange, onResume } = {}) {
    if (sensitivity != null && Number.isFinite(+sensitivity)) {
      this._settingsConfig.sensitivity = Math.min(0.08, Math.max(0.005, +sensitivity));
      savePref('vb-sens', this._settingsConfig.sensitivity);
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

    const panel = el('div', 'vb-settings-panel', root);

    const title = el('h2', 'vb-title', panel, 'settings-title');
    title.textContent = 'SETTINGS';
    const sub = el('div', 'vb-sub', panel);
    sub.textContent = 'tactical system configuration';

    const sensRow = el('div', 'vb-setting-row', panel);
    const sensHeader = el('div', 'vb-setting-header', sensRow);
    const sensLabel = el('label', 'vb-label', sensHeader);
    sensLabel.textContent = 'MOUSE SENSITIVITY';
    sensLabel.htmlFor = 'settings-sens-slider';
    const sensVal = el('span', 'vb-setting-val', sensHeader, 'settings-sens-val');
    const sensSlider = el('input', 'vb-slider', sensRow, 'settings-sens-slider');
    sensSlider.type = 'range';
    sensSlider.min = '0.005';
    sensSlider.max = '0.08';
    sensSlider.step = '0.001';
    sensSlider.setAttribute('aria-label', 'Mouse Sensitivity');
    sensSlider.setAttribute('aria-valuemin', '0.005');
    sensSlider.setAttribute('aria-valuemax', '0.08');

    const volRow = el('div', 'vb-setting-row', panel);
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

    const fovRow = el('div', 'vb-setting-row', panel);
    const fovHeader = el('div', 'vb-setting-header', fovRow);
    const fovLabel = el('label', 'vb-label', fovHeader);
    fovLabel.textContent = 'BASE FIELD OF VIEW (FOV)';
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

    const resumeBtn = el('button', 'vb-btn vb-resume-btn', panel, 'settings-resume-btn');
    resumeBtn.type = 'button';
    resumeBtn.textContent = 'RESUME';

    const hint = el('div', 'vb-settings-hint', panel);
    hint.textContent = 'ESC TO RESUME';

    this.settingsDom = {
      root,
      panel,
      sensSlider,
      sensVal,
      volSlider,
      volVal,
      fovSlider,
      fovVal,
      resumeBtn,
    };

    const onSliderChange = () => {
      const sensitivity = Math.min(0.08, Math.max(0.005, parseFloat(sensSlider.value) || 0.03));
      const volume = Math.min(1, Math.max(0, parseFloat(volSlider.value) || 0));
      const fov = Math.min(100, Math.max(65, Math.round(parseFloat(fovSlider.value) || 75)));

      sensVal.textContent = (sensitivity * 100).toFixed(1);
      sensSlider.setAttribute('aria-valuenow', String(sensitivity));
      sensSlider.setAttribute('aria-valuetext', `${(sensitivity * 100).toFixed(1)} sensitivity`);

      volVal.textContent = `${Math.round(volume * 100)}%`;
      volSlider.setAttribute('aria-valuenow', String(volume));
      volSlider.setAttribute('aria-valuetext', `${Math.round(volume * 100)} percent`);

      fovVal.textContent = `${fov}°`;
      fovSlider.setAttribute('aria-valuenow', String(fov));
      fovSlider.setAttribute('aria-valuetext', `${fov} degrees`);

      this._settingsConfig = { sensitivity, volume, fov };
      savePref('vb-sens', sensitivity);
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
    dom.sensVal.textContent = (config.sensitivity * 100).toFixed(1);
    dom.sensSlider.setAttribute('aria-valuenow', String(config.sensitivity));
    dom.sensSlider.setAttribute('aria-valuetext', `${(config.sensitivity * 100).toFixed(1)} sensitivity`);

    dom.volSlider.value = String(config.volume);
    dom.volVal.textContent = `${Math.round(config.volume * 100)}%`;
    dom.volSlider.setAttribute('aria-valuenow', String(config.volume));
    dom.volSlider.setAttribute('aria-valuetext', `${Math.round(config.volume * 100)} percent`);

    dom.fovSlider.value = String(config.fov);
    dom.fovVal.textContent = `${config.fov}°`;
    dom.fovSlider.setAttribute('aria-valuenow', String(config.fov));
    dom.fovSlider.setAttribute('aria-valuetext', `${config.fov} degrees`);
  }

  dispose() {
    for (const timer of this._deferredTimers) clearTimeout(timer);
    this._deferredTimers.clear();

    this.closeSettings();
    this.settingsDom.root?.remove();

    this._settingsOnChange = null;
    this._settingsOnResume = null;
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
