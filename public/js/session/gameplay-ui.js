import { MOUSE_SENSITIVITY } from '../input-settings.js';

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

/** Owns gameplay-input, settings, and S&D buy-menu arbitration. */
export class GameplayUiFlow {
  constructor({
    hud,
    input,
    audio,
    gameplay,
    lifecycle,
    settings,
    getNet,
    now,
    writeVolume,
    writeFov,
    unlockAudio,
    onInputEnabled = null,
    onInputDisabled = null,
  } = {}) {
    this._hud = hud;
    this._input = input;
    this._audio = audio;
    this._gameplay = gameplay;
    this._lifecycle = lifecycle;
    this._settings = settings;
    this._getNet = getNet;
    this._now = now;
    this._writeVolume = writeVolume;
    this._writeFov = writeFov;
    this._unlockAudio = unlockAudio;
    this._onInputEnabled = onInputEnabled;
    this._onInputDisabled = onInputDisabled;
    this._inputEnabled = false;
    this._pendingPurchase = null;
  }

  get inputEnabled() { return this._inputEnabled; }

  resetPendingPurchase() {
    this._pendingPurchase = null;
  }

  applySettings(nextSettings) {
    if (!nextSettings || typeof nextSettings !== 'object') return;
    const sensitivity = clampNumber(
      nextSettings.sensitivity,
      MOUSE_SENSITIVITY.min,
      MOUSE_SENSITIVITY.max,
      this._input.getSensitivity(),
    );
    const volume = clampNumber(nextSettings.volume, 0, 1, this._settings.masterVolume);
    const fov = clampNumber(nextSettings.fov, 65, 100, this._settings.baseFov);

    this._input.setSensitivity(sensitivity);
    if (typeof this._input.setOptions === 'function') this._input.setOptions(nextSettings);
    this._settings.masterVolume = volume;
    this._settings.baseFov = fov;
    this._writeVolume(String(volume));
    this._writeFov(String(fov));
    this._audio.setMasterVolume(volume);
  }

  resumeFromSettings() {
    this._hud.closeSettings();
    this.closeBuyMenu();
    this.syncInput();
    this._unlockAudio();
    if (this._inputEnabled) this._input.requestLock();
  }

  resumeFromBuyMenu() {
    if (this._lifecycle.tornDown) return;
    this.syncInput();
    this._unlockAudio();
    if (this._inputEnabled) this._input.requestLock();
  }

  /** Keyboard fallback for browsers that do not expose pointer lock (including headless QA). */
  pauseFromKeyboard() {
    if (!this.canUseInput()) return false;
    this.setInputEnabled(false);
    this._hud.openSettings();
    return true;
  }

  onPointerLockChange(locked) {
    if (locked) {
      if (!this.canUseInput()) {
        this.setInputEnabled(false);
        this._input.exit();
        return;
      }
      this._hud.closeSettings();
      this.setInputEnabled(true);
      this._unlockAudio();
      return;
    }

    this.setInputEnabled(false);
    if (
      this._gameplay.running &&
      this._lifecycle.phase === 'live' &&
      this._gameplay.alive &&
      !this._lifecycle.disconnected &&
      !this._hud.isBuyMenuOpen()
    ) {
      this._hud.openSettings();
    }
  }

  canUseInput() {
    return !!(
      this._gameplay.running &&
      this._lifecycle.liveActive &&
      this._lifecycle.phase === 'live' &&
      this._gameplay.alive &&
      !this._lifecycle.disconnected &&
      !this._lifecycle.tornDown &&
      !this._hud.settingsOpen &&
      !this._hud.isBuyMenuOpen()
    );
  }

  setInputEnabled(enabled) {
    const next = !!enabled && !this._lifecycle.tornDown;
    this._input.setGameplayEnabled(next);
    if (next === this._inputEnabled) return;

    this._inputEnabled = next;
    if (next) {
      this._input.consumeBuyMenuRequest();
      if (typeof this._onInputEnabled === 'function') this._onInputEnabled();
      return;
    }
    if (typeof this._onInputDisabled === 'function') this._onInputDisabled();
  }

  syncInput() {
    this.setInputEnabled(this.canUseInput());
  }

  restoreFocus() {
    this.syncInput();
    this._unlockAudio();
    if (this._inputEnabled) this._input.requestLock();
  }

  canOpenBuyMenu() {
    return !!(
      this.canUseInput() &&
      this._gameplay.matchState?.mode === 'snd' &&
      this._gameplay.matchState.phase === 'prep' &&
      this._gameplay.selfRow?.state === 'alive'
    );
  }

  toggleBuyMenuFromInput() {
    if (this._hud.isBuyMenuOpen()) {
      this._hud.toggleBuyMenu(false);
      return;
    }
    if (!this.canOpenBuyMenu()) return;

    this._hud.closeSettings();
    if (!this._hud.toggleBuyMenu(true)) return;
    this.syncBuyMenuState();
    this.setInputEnabled(false);
    this._input.exit();
  }

  closeBuyMenu() {
    if (this._hud.isBuyMenuOpen()) this._hud.toggleBuyMenu(false);
    this._hud.setBuyMenuState({
      open: false,
      phase: this._gameplay.matchState?.phase || 'live',
      credits: 0,
      owned: [],
    });
  }

  syncBuyMenuState() {
    const self = this._gameplay.selfRow;
    const phase = this._gameplay.matchState?.phase || 'live';
    const admitted = !!(
      this._gameplay.running &&
      this._lifecycle.liveActive &&
      this._lifecycle.phase === 'live' &&
      this._gameplay.alive &&
      !this._lifecycle.disconnected &&
      this._gameplay.matchState?.mode === 'snd' &&
      phase === 'prep' &&
      self?.state === 'alive'
    );

    let open = this._hud.isBuyMenuOpen();
    if (open && !admitted) {
      this._hud.toggleBuyMenu(false);
      open = false;
    }
    this._hud.setBuyMenuState({
      open: open && admitted,
      phase,
      credits: Number.isFinite(self?.credits) ? self.credits : 0,
      owned: Array.isArray(self?.owned) ? self.owned : [],
    });
    if (!open) this.syncInput();
  }

  purchaseWeapon(weapon) {
    if (
      typeof weapon !== 'string' ||
      !this._hud.isBuyMenuOpen() ||
      !this._gameplay.matchState ||
      this._gameplay.matchState.mode !== 'snd' ||
      this._gameplay.matchState.phase !== 'prep' ||
      this._gameplay.selfRow?.state !== 'alive' ||
      !this._gameplay.running ||
      this._lifecycle.disconnected
    ) {
      return false;
    }
    if (!this._getNet()?.buyWeapon(weapon)) return false;

    this._pendingPurchase = { weapon, until: this._now() + 1500 };
    return true;
  }

  confirmPurchase(self = this._gameplay.selfRow) {
    const pending = this._pendingPurchase;
    if (!pending) return null;
    if (Array.isArray(self?.owned) && self.owned.includes(pending.weapon)) {
      this._pendingPurchase = null;
      return pending.weapon;
    }
    if (this._now() >= pending.until || this._gameplay.matchState?.phase !== 'prep') {
      this._pendingPurchase = null;
    }
    return null;
  }
}
