// Public HUD facade. The subcontrollers own disjoint DOM, listeners, timers,
// RAFs, and presentation state; this class preserves the historic game API.
import { BuyMenuController } from './buy-menu.js';
import { CombatHudController } from './combat-hud.js';
import { GameplayHud } from './gameplay-hud.js';
import {
  MAP_DESCRIPTIONS,
  MAP_LABELS,
  MODE_DESCRIPTIONS,
  MODE_LABELS,
  WEAPON_BUY_ORDER,
  WEAPON_CLASSES,
  WEAPON_NAMES,
  cleanCode,
  loadName,
  loadPref,
  loadPrefNum,
  resolveKey,
  saveName,
  savePref,
  spreadFromCone,
} from './hud-support.js';
import { MenuLobbyController } from './menu-lobby.js';
import { SettingsController } from './settings-panel.js';
import { SpectatorHud } from './spectator-hud.js';

export {
  MAP_DESCRIPTIONS,
  MAP_LABELS,
  MODE_DESCRIPTIONS,
  MODE_LABELS,
  WEAPON_BUY_ORDER,
  WEAPON_CLASSES,
  WEAPON_NAMES,
};

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
      closeBuyMenuDirect: () => this.closeBuyMenuDirect(),
      toggleBuyMenu: (force) => this.toggleBuyMenu(force),
      isBuyMenuOpen: () => this.isBuyMenuOpen(),
      isSettingsOpen: () => this.settingsOpen,
      getSensitivity: () => this.settings._settingsConfig.sensitivity,
      setSensitivity: (value) => this.settings.setupSettings({ sensitivity: value }),
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
      () => this.closeBuyMenuDirect(),
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
    this.gameplay.match.onPlayers = (players) => this.setPlayers(players);

    this.combat = new CombatHudController({
      dom: () => this.gameplay.dom,
      matchDom: () => this.gameplay.matchDom,
      state: () => this.gameplay.st,
      built: () => this.gameplay.built,
      hudRoot: () => (typeof document !== 'undefined' ? document.getElementById('hud') : null),
      root: (id) => this.gameplay._root(id),
      resolveName: (id) => this.gameplay.names.get(id) || String(id),
      closeBuyMenuDirect: () => this.buy.closeBuyMenuDirect(),
      resetScope: () => this.gameplay.resetScope(),
      setReloadProgress: (value) => this.gameplay.setReloadProgress(value),
      hideCrosshairForAds: (hidden) => this.gameplay.hideCrosshairForAds(hidden),
      updateCrosshairStress: (panic, pain, alive) => (
        this.gameplay.updateCrosshairStress(panic, pain, alive)
      ),
    });
    this.spectator = new SpectatorHud();
  }

  // Compatibility views retained for the existing game and lifecycle checks.
  get built() { return this.gameplay.built; }
  get st() { return this.gameplay.st; }
  get dom() { return this.gameplay.dom; }
  get matchDom() { return this.gameplay.matchDom; }
  get lobbyDom() { return this.menu.lobbyDom; }
  get buyDom() { return this.buy.buyDom; }
  get settingsDom() { return this.settings.settingsDom; }
  get names() { return this.combat.names; }
  get killfeedTimers() { return this.combat.killfeedTimers; }
  get dmgActive() { return this.combat.dmgActive; }
  get dmgPool() { return this.combat.dmgPool; }
  get scopeShown() { return this.gameplay.scopeShown; }
  get scopeProgress() { return this.gameplay.scopeProgress; }
  get settingsOpen() { return this.settings.isOpen; }
  get dead() { return this.combat.dead; }
  get painImpulse() { return this.combat.painImpulse; }
  get deathBrutality() { return this.combat.deathBrutality; }
  get onMenuAction() { return this.menu.onMenuAction; }
  get _lobbyCallbacks() { return this.menu._lobbyCallbacks; }
  get _buyMenuCallbacks() { return this.buy._buyMenuCallbacks; }
  get _settingsConfig() { return this.settings._settingsConfig; }
  get _settingsOnChange() { return this.settings._settingsOnChange; }
  get _settingsOnResume() { return this.settings._settingsOnResume; }
  get _buyMenuState() { return this.buy._buyMenuState; }
  get _latestMatch() { return this.gameplay.match._latestMatch; }
  get _latestSelfRow() { return this.gameplay.match._latestSelfRow; }
  get _latestPlayers() { return this.gameplay.match._latestPlayers; }
  get _ownedRoots() { return this.menu.support._ownedRoots; }
  get _deferredTimers() { return this.menu.support._deferredTimers; }

  root(id) { return this.gameplay._root(id); }
  defer(callback) { return this.menu.support.defer(callback); }
  loadName() { return loadName(); }
  saveName(value) { return saveName(value); }
  loadPref(key, fallback) { return loadPref(key, fallback); }
  savePref(key, value) { return savePref(key, value); }
  loadPrefNum(key, fallback, min, max) { return loadPrefNum(key, fallback, min, max); }
  resolveKey(weapon) { return resolveKey(weapon); }
  spreadFromCone(cone) { return spreadFromCone(cone); }
  cleanCode(raw) { return cleanCode(raw); }

  buildMenu(callback) { return this.menu.buildMenu(callback); }
  showJoinState(message, tone = '') { return this.menu.showJoinState(message, tone); }
  ensureLobbyDom() { return this.menu.ensureLobbyDom(); }
  showLobby(state, callbacks = {}) { return this.menu.showLobby(state, callbacks); }
  updateLobby(state) { return this.menu.updateLobby(state); }
  hideLobby() { return this.menu.hideLobby(); }
  isLobbyOpen() { return this.menu.isLobbyOpen(); }
  showLobbyStatus(message, tone = '') { return this.menu.showLobbyStatus(message, tone); }

  setupSettings(config = {}) { return this.settings.setupSettings(config); }
  openSettings() { return this.settings.openSettings(); }
  closeSettings() { return this.settings.closeSettings(); }
  ensureSettings() { return this.settings.ensureSettings(); }
  syncSettingsUI() { return this.settings.syncSettingsUI(); }

  setupSpectator(config = {}) { return this.spectator.setup(config); }
  setSpectatorState(state = {}) { return this.spectator.setState(state); }

  ensureBuyMenu() { return this.buy.ensureBuyMenu(); }
  setupBuyMenu(config = {}) { return this.buy.setupBuyMenu(config); }
  setBuyMenuState(state = {}) { return this.buy.setBuyMenuState(state); }
  toggleBuyMenu(force) { return this.buy.toggleBuyMenu(force); }
  closeBuyMenuDirect() { return this.buy.closeBuyMenuDirect(); }
  isBuyMenuOpen() { return this.buy.isBuyMenuOpen(); }
  triggerPurchase(weapon) { return this.buy.triggerPurchase(weapon); }
  syncBuyMenuUI() { return this.buy.syncBuyMenuUI(); }

  buildHUD() {
    const result = this.gameplay.buildHUD();
    this.combat.configure();
    this.spectator.build(this.root('hud'));
    return result;
  }

  menuDone() { return this.gameplay.menuDone(); }
  setMatchState(match, selfRow, players, serverNow) {
    return this.gameplay.match.setMatchState(match, selfRow, players, serverNow);
  }
  setState(state) { return this.gameplay.setState(state); }
  apply() { return this.gameplay.apply(); }
  updateAmmoLow() { return this.gameplay.updateAmmoLow(); }
  setSpread(value) { return this.gameplay.setSpread(value); }
  updateCrosshairStress(panic, pain, alive = true) {
    return this.gameplay.updateCrosshairStress(panic, pain, alive);
  }
  hideCrosshairForAds(hidden) { return this.gameplay.hideCrosshairForAds(hidden); }
  setReloadProgress(value) { return this.gameplay.setReloadProgress(value); }
  updateCompass(yaw) { return this.gameplay.updateCompass(yaw); }
  measureCompass() { return this.gameplay.measureCompass(); }
  findNextZeroTick(after) { return this.gameplay.findNextZeroTick(after); }
  setScoreboard(visible) { return this.gameplay.setScoreboard(visible); }
  setPlayers(players) {
    this.combat.setNames(players);
    return this.gameplay.setPlayers(players);
  }
  ensureScope() { return this.gameplay.ensureScope(); }
  setScope(visible) { return this.gameplay.setScope(visible); }

  pushEvent(event) { return this.combat.pushEvent(event); }
  killfeed(event) { return this.combat.killfeed(event); }
  nameFor(id) { return this.combat.nameFor(id); }
  killRow(entry) { return this.combat.killRow(entry); }
  hitmark(headshot) { return this.combat.hitmark(headshot); }
  setOwnDamage(value) { return this.combat.setOwnDamage(value); }
  setPainImpulse(value) { return this.combat.setPainImpulse(value); }
  clearOwnDamage() { return this.combat.clearOwnDamage(); }
  clearDamage() { return this.combat.clearDamage(); }
  resetDamage() { return this.combat.resetDamage(); }
  ensureDeathNote() { return this.combat.ensureDeathNote(); }
  showDeathNote(name) { return this.combat.showDeathNote(name); }
  hideDeathNote() { return this.combat.hideDeathNote(); }
  styleDeathTreatment(force) { return this.combat.styleDeathTreatment(force); }
  setDeathBrutality(value) { return this.combat.setDeathBrutality(value); }
  activateDeathTreatment() { return this.combat.activateDeathTreatment(); }
  resetDeathTreatment() { return this.combat.resetDeathTreatment(); }
  setDead(dead, killer = '') { return this.combat.setDead(dead, killer); }
  spawnDamage(amount, x, y, visible = true, headshot = false) {
    return this.combat.spawnDamage(amount, x, y, visible, headshot);
  }
  takeDmgNode() { return this.combat.takeDmgNode(); }
  placeDmg(record, elapsed) { return this.combat.placeDmg(record, elapsed); }
  dmgStep() { return this.combat.dmgStep(); }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.combat.dispose();
    this.gameplay.dispose();
    this.buy.dispose();
    this.settings.dispose();
    this.spectator.dispose();
    this.menu.dispose();
  }
}
