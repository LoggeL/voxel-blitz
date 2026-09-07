// Coordinates the gameplay, menu, settings, and combat presentation owners.
import { BuyMenuController } from './buy-menu.js';
import { CombatHudController } from './combat-hud.js';
import { GameplayHud } from './gameplay-hud.js';
import { MenuLobbyController } from './menu-lobby.js';
import { SettingsController } from './settings-panel.js';
import { SpectatorHud } from './spectator-hud.js';
import { WeaponWheelController } from './weapon-wheel.js';

export class HUD {
  constructor() {
    this._disposed = false;
    const readModel = {};
    Object.defineProperties(readModel, {
      dead: { enumerable: true, get: () => this.combat?.dead || false },
      painImpulse: { enumerable: true, get: () => this.combat?.painImpulse || 0 },
    });

    this.menu = new MenuLobbyController({
      closeSettings: () => this.closeSettings(),
      closeBuyMenuDirect: () => this.buy.closeBuyMenuDirect(),
      toggleBuyMenu: (force) => this.toggleBuyMenu(force),
      isBuyMenuOpen: () => this.isBuyMenuOpen(),
      isSettingsOpen: () => this.settingsOpen,
      getSensitivity: () => this.settings._settingsConfig.sensitivity,
    });

    this.settings = new SettingsController(
      {
        isLobbyOpen: () => this.menu.isLobbyOpen(),
        getMatchSummary: () => ({
          mode: this.gameplay?.match?._latestMatch?.mode || null,
          map: this.gameplay?.match?._latestMatch?.map || null,
          players: this.gameplay?.match?._latestPlayers?.length || 0,
        }),
      },
      () => this.buy.closeBuyMenuDirect(),
    );
    this.buy = new BuyMenuController(
      {
        mode: () => this.gameplay?.match?._latestMatch?.mode || null,
        isAlive: () => this.gameplay?.st?.alive !== false,
        settingsOpen: () => this.settings.isOpen,
        isLobbyOpen: () => this.menu.isLobbyOpen(),
      },
      () => this.closeSettings(),
    );

    this.gameplay = new GameplayHud({
      ensureSettings: () => this.settings.ensureSettings(),
      ensureBuyMenu: () => this.buy.ensureBuyMenu(),
      onBuyMenuState: (state) => this.buy.setBuyMenuState(state),
      onBeforeBuild: () => this.combat?.reset(),
      readModel,
    });
    // Match snapshots are also the authoritative source for combat names.
    this.gameplay.match.onPlayers = (players, match, selfRow) => {
      this.combat.setNames(players);
      this.gameplay.setPlayers(players, match, selfRow);
    };

    this.combat = new CombatHudController({
      dom: this.gameplay.dom,
      matchDom: this.gameplay.matchDom,
      state: this.gameplay.st,
      isBuilt: () => this.gameplay.built,
      getHudRoot: () => (typeof document !== 'undefined' ? document.getElementById('hud') : null),
      closeBuyMenuDirect: () => this.buy.closeBuyMenuDirect(),
      resetScope: () => this.gameplay.resetScope(),
      setReloadProgress: (value) => this.gameplay.setReloadProgress(value),
      hideCrosshairForAds: (hidden) => this.gameplay.hideCrosshairForAds(hidden),
      updateCrosshairStress: (panic, pain, alive) => (
        this.gameplay.updateCrosshairStress(panic, pain, alive)
      ),
    });
    this.spectator = new SpectatorHud();
    this.wheel = new WeaponWheelController();
  }

  get settingsOpen() { return this.settings.isOpen; }

  buildMenu(callback, options) { return this.menu.buildMenu(callback, options); }
  showJoinState(message, tone = '') { return this.menu.showJoinState(message, tone); }
  showLobby(state, callbacks = {}) { return this.menu.showLobby(state, callbacks); }
  updateLobby(state) { return this.menu.updateLobby(state); }
  hideLobby() { return this.menu.hideLobby(); }
  showLobbyStatus(message, tone = '') { return this.menu.showLobbyStatus(message, tone); }

  setupSettings(config = {}) { return this.settings.setupSettings(config); }
  openSettings() { return this.settings.openSettings(); }
  closeSettings() { return this.settings.closeSettings(); }
  setDeviceInfo(device = {}) {
    const d = this.gameplay.dom;
    if (d.grenadeKey && d.grenadeSwitch) {
      d.grenadeKey.textContent = device.padActive ? 'RB' : 'G';
      d.grenadeKey.style.display = device.touch && !device.padActive ? 'none' : '';
      d.grenadeSwitch.textContent = device.padActive ? 'RB + Y · SWITCH' : 'H · SWITCH';
      d.grenadeSwitch.hidden = !!device.touch && !device.padActive;
      d.grenadeSwitch.title = device.padActive ? 'Hold RB and press Y to switch grenade type' : 'Switch grenade type (H)';
    }
    return this.settings.setDeviceInfo(device);
  }

  setupSpectator(config = {}) { return this.spectator.setup(config); }
  setSpectatorState(state = {}) { return this.spectator.setState(state); }

  setupBuyMenu(config = {}) { return this.buy.setupBuyMenu(config); }
  setBuyMenuState(state = {}) { return this.buy.setBuyMenuState(state); }
  toggleBuyMenu(force) { return this.buy.toggleBuyMenu(force); }
  isBuyMenuOpen() { return this.buy.isBuyMenuOpen(); }

  setupWeaponWheel(config = {}) { return this.wheel.setup(config); }
  setWeaponWheelState(state = {}) { return this.wheel.setState(state); }
  isWeaponWheelOpen() { return this.wheel.isOpen(); }
  requestWheelCancel() {
    if (!this.wheel.isOpen()) return false;
    return this.wheel.requestCancel();
  }
  weaponWheelHighlight() { return this.wheel.highlightedSlot(); }
  weaponWheelRadius() { return this.wheel.radius(); }

  buildHUD() {
    this.gameplay.buildHUD();
    this.spectator.build(document.getElementById('hud'));
  }

  menuDone() { return this.gameplay.menuDone(); }
  setMatchState(match, selfRow, players, serverNow) {
    return this.gameplay.match.setMatchState(match, selfRow, players, serverNow);
  }
  setState(state) { return this.gameplay.setState(state); }
  setScoreboard(visible) { return this.gameplay.setScoreboard(visible); }
  setTelemetry(frameDt, stats, atMs) {
    return this.gameplay.setTelemetry(frameDt, stats, atMs);
  }
  setScope(visible) { return this.gameplay.setScope(visible); }

  killfeed(event) { return this.combat.killfeed(event); }
  hitmark(headshot) { return this.combat.hitmark(headshot); }
  powerup(event) { return this.gameplay.powerups.collected(event); }
  clearPowerups() { return this.gameplay.powerups.reset(); }
  setPainImpulse(value) { return this.combat.setPainImpulse(value); }
  clearDamage() { return this.combat.clearDamage(); }
  hideDeathNote() { return this.combat.hideDeathNote(); }
  setDeathBrutality(value) { return this.combat.setDeathBrutality(value); }
  setDead(dead, killer = '', recap = '') { return this.combat.setDead(dead, killer, recap); }
  spawnDamage(amount, x, y, visible = true, headshot = false, stackKey = null) {
    return this.combat.spawnDamage(amount, x, y, visible, headshot, stackKey);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.combat.dispose();
    this.gameplay.dispose();
    this.buy.dispose();
    this.settings.dispose();
    this.spectator.dispose();
    this.wheel.dispose();
    this.menu.dispose();
  }
}
