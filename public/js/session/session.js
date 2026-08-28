import { getMapMeta } from '../../../shared/worlddata.js';
import { NetClient } from '../engine/netclient.js';
import { GameplayUiFlow } from './gameplay-ui.js';
import { PregameFlow } from './pregame.js';

const DEFAULT_PERSIST = Object.freeze({
  name: 'vb-name',
  volume: 'vb-volume',
  fov: 'vb-fov',
});

const GAMEPLAY_EVENT_KINDS = Object.freeze([
  'shoot',
  'hit',
  'kill',
  'block',
  'respawn',
  'die',
]);

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function readStoredNumber(storage, key, fallback, min, max) {
  if (!storage) return fallback;
  try {
    const number = parseFloat(storage.getItem(key));
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  } catch (_) {
    return fallback;
  }
}

function requireFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`Session live boot requires ${name}()`);
  }
  return value;
}

/**
 * Stable facade for admission, live-session transitions, gameplay listeners,
 * and terminal resource ownership. PregameFlow owns admission/lobby state and
 * GameplayUiFlow owns settings, buy-menu, and pointer-lock arbitration.
 *
 * Ownership is deliberate: Session owns every NetClient returned by makeNet,
 * and teardown owns the terminal disposal of hud, input, and audio. The
 * gameplay state provider and callbacks are borrowed. They are narrow seams,
 * not a Game instance: gameplay must expose only running, alive, matchState,
 * and selfRow.
 *
 * onEnterLive receives a one-shot payload. Its implementation builds live
 * resources and calls payload.complete exactly once with four callbacks:
 * activateLive, flushQueuedSnapshots, consumeLatestAuthoritativeState, and
 * startLoop. Session invokes them in that order after hud.menuDone(); the flush
 * therefore happens after the menu handoff and before the loop starts. The
 * queue remains caller-owned and flushQueuedSnapshots must preserve arrival
 * order. An asynchronous handoff must return its promise so stale/failing boot
 * continuations remain guarded by the attempt generation.
 *
 * onDisconnect is the synchronous release hook for caller-owned live
 * resources. It runs at most once for a handed-off boot/live generation,
 * before a disconnect returns to the menu and before terminal teardown
 * disposes hud/input/audio. onGameplayInputDisabled owns the corresponding
 * LocalPlayer/WeaponState reset; it runs only on an enabled-to-disabled edge.
 * teardown is terminal and idempotent: its first call returns true, later
 * calls are no-ops returning false.
 */
export class Session {
  constructor({
    hud,
    input,
    audio,
    gameplay,
    makeNet = () => new NetClient(),
    persist = null,
    platform = null,
    callbacks = null,
  } = {}) {
    if (!hud || !input || !audio) {
      throw new TypeError('Session requires hud, input, and audio');
    }
    if (!gameplay || typeof gameplay !== 'object') {
      throw new TypeError('Session requires a narrow gameplay state provider');
    }
    if (typeof makeNet !== 'function') {
      throw new TypeError('Session makeNet must be a function');
    }

    this.hud = hud;
    this.input = input;
    this.audio = audio;
    this._gameplay = gameplay;
    this._makeNet = makeNet;

    const persistence = persist && typeof persist === 'object' ? persist : {};
    this._persist = {
      name: persistence.name || DEFAULT_PERSIST.name,
      volume: persistence.volume || DEFAULT_PERSIST.volume,
      fov: persistence.fov || DEFAULT_PERSIST.fov,
    };

    const browser = platform && typeof platform === 'object' ? platform : {};
    this._window = Object.hasOwn(browser, 'window')
      ? browser.window
      : (typeof window !== 'undefined' ? window : null);
    this._document = Object.hasOwn(browser, 'document')
      ? browser.document
      : (typeof document !== 'undefined' ? document : null);
    this._location = Object.hasOwn(browser, 'location')
      ? browser.location
      : (typeof location !== 'undefined' ? location : null);
    this._history = Object.hasOwn(browser, 'history')
      ? browser.history
      : (typeof history !== 'undefined' ? history : null);
    this._storage = Object.hasOwn(browser, 'storage')
      ? browser.storage
      : (typeof localStorage !== 'undefined' ? localStorage : null);
    this._now = typeof browser.now === 'function' ? browser.now : nowMs;

    const hooks = callbacks && typeof callbacks === 'object' ? callbacks : {};
    this.onEnterLive = typeof hooks.onEnterLive === 'function' ? hooks.onEnterLive : null;
    this.onDisconnect = typeof hooks.onDisconnect === 'function' ? hooks.onDisconnect : null;
    this.onGameplayEvent = typeof hooks.onGameplayEvent === 'function'
      ? hooks.onGameplayEvent
      : null;
    this.onTick = typeof hooks.onTick === 'function' ? hooks.onTick : null;
    this.onGameplayInputDisabled = typeof hooks.onGameplayInputDisabled === 'function'
      ? hooks.onGameplayInputDisabled
      : null;
    this.onGameplayInputEnabled = typeof hooks.onGameplayInputEnabled === 'function'
      ? hooks.onGameplayInputEnabled
      : null;
    this.onResize = typeof hooks.onResize === 'function' ? hooks.onResize : null;
    this.onTeardown = typeof hooks.onTeardown === 'function' ? hooks.onTeardown : null;

    this._phase = 'idle';
    this._gameplayUnsubs = [];
    this._gameplayEventsWired = false;
    this._liveActive = false;
    this._liveResourcesOwned = false;
    this._tornDown = false;
    this._disconnected = false;

    this._welcome = null;
    this._myId = null;
    this._mapMeta = null;
    this._botCount = undefined;
    this._masterVolume = readStoredNumber(
      this._storage,
      this._persist.volume,
      0.8,
      0,
      1,
    );
    this._baseFov = readStoredNumber(
      this._storage,
      this._persist.fov,
      75,
      65,
      100,
    );

    this._pregame = new PregameFlow({
      hud: this.hud,
      makeNet: this._makeNet,
      getPhase: () => this._phase,
      setPhase: (phase) => { this._phase = phase; },
      isTornDown: () => this._tornDown,
      unlockAudio: () => this.unlockAudioFromGesture(),
      connectUrl: () => this._connectUrl(),
      closeNet: (net) => this._closeNet(net),
      writeName: (name) => this._writePreference(this._persist.name, name),
      setBotCount: (bots) => { this._botCount = bots; },
      enterMenu: (message) => this.enterMenu(message),
      detachGameplay: () => this._detachGameplayListeners(),
      enterLive: (attempt) => this._beginLiveBoot(attempt),
      location: this._location,
      history: this._history,
    });
    const session = this;
    this._gameplayUi = new GameplayUiFlow({
      hud: this.hud,
      input: this.input,
      audio: this.audio,
      gameplay: this._gameplay,
      lifecycle: {
        get phase() { return session._phase; },
        get liveActive() { return session._liveActive; },
        get disconnected() { return session._disconnected; },
        get tornDown() { return session._tornDown; },
      },
      settings: {
        get masterVolume() { return session._masterVolume; },
        set masterVolume(value) { session._masterVolume = value; },
        get baseFov() { return session._baseFov; },
        set baseFov(value) { session._baseFov = value; },
      },
      getNet: () => this.net,
      now: this._now,
      writeVolume: (value) => this._writePreference(this._persist.volume, value),
      writeFov: (value) => this._writePreference(this._persist.fov, value),
      unlockAudio: () => this._unlockAudioQuietly(),
      onInputEnabled: () => {
        if (typeof this.onGameplayInputEnabled === 'function') this.onGameplayInputEnabled();
      },
      onInputDisabled: () => {
        if (typeof this.onGameplayInputDisabled === 'function') this.onGameplayInputDisabled();
      },
    });

    this.input.setGameplayEnabled(false);

    this._onResize = () => {
      if (this._tornDown || typeof this.onResize !== 'function') return;
      this.onResize();
    };
    this._onPageHide = () => this.teardown();
    this._onVisibilityChange = () => {
      if (
        this._tornDown ||
        !this._document ||
        this._document.visibilityState !== 'visible'
      ) {
        return;
      }
      this._unlockAudioQuietly();
    };

    this._window?.addEventListener?.('resize', this._onResize);
    this._window?.addEventListener?.('pagehide', this._onPageHide, { once: true });
    this._document?.addEventListener?.('visibilitychange', this._onVisibilityChange);
  }

  get phase() { return this._phase; }
  get net() { return this._pregame.net; }
  get welcome() { return this._welcome; }
  get myId() { return this._myId; }
  get mapMeta() { return this._mapMeta; }
  get botCount() { return this._botCount; }
  get masterVolume() { return this._masterVolume; }
  get baseFov() { return this._baseFov; }
  get disconnected() { return this._disconnected; }
  get tornDown() { return this._tornDown; }
  get gameplayInputEnabled() { return this._gameplayUi.inputEnabled; }

  start() {
    this.enterMenu();
  }

  enterMenu(message = '') {
    if (this._tornDown) return false;

    this._phase = 'menu';
    this._disconnected = false;
    this._liveActive = false;
    this._gameplayUi.resetPendingPurchase();
    this._pregame.resetAttempt();
    this._welcome = null;
    this._myId = null;
    this._mapMeta = null;

    this.setGameplayInputEnabled(false);
    this.closeBuyMenu();
    this.hud.closeSettings();
    this.hud.hideLobby();
    this.hud.setDead(false, '');
    this.hud.setState({
      alive: true,
      hp: 100,
      crosshairConeDeg: 0,
      panic: 0,
      pain: 0,
      crouching: false,
      spawnProtected: false,
      reloading01: null,
      adsT01: 0,
    });
    this.hud.setPainImpulse(0);
    this.hud.setDeathBrutality(0);
    this.hud.hideDeathNote();
    this.hud.clearDamage();
    this.hud.setScope(false);
    this.hud.setMatchState(null, null, [], null);
    this.hud.setBuyMenuState({
      open: false,
      phase: 'idle',
      credits: 0,
      owned: [],
    });

    this._replacePregameNet();
    this.hud.buildMenu((action) => {
      void this.begin(action);
    });
    try {
      Promise.resolve(this.audio.startMenuMusic?.()).catch(() => {});
    } catch (_) {}
    if (message) this.hud.showJoinState(message, 'err');
    return true;
  }

  async begin(action) {
    return this._pregame.begin(action);
  }

  unlockAudioFromGesture() {
    try {
      const initializing = this.audio.init();
      this.audio.setMasterVolume(this._masterVolume);
      const unlocking = this.audio.unlock();
      return Promise.all([initializing, unlocking]).then(
        () => undefined,
        (error) => {
          console.warn('[vb] audio unavailable:', error);
        },
      );
    } catch (error) {
      console.warn('[vb] audio unavailable:', error);
      return Promise.resolve();
    }
  }

  isActivePregameAttempt(attempt) {
    return this._pregame.isActive(attempt);
  }

  async setLobbyReady(attempt, value) {
    return this._pregame.setLobbyReady(attempt, value);
  }

  async startLobby(attempt) {
    return this._pregame.startLobby(attempt);
  }

  leaveLobby(attempt = this._pregame.attempt) {
    return this._pregame.leaveLobby(attempt);
  }

  clearInviteQuery() {
    return this._pregame.clearInviteQuery();
  }

  applySettings(settings) {
    return this._gameplayUi.applySettings(settings);
  }

  resumeFromSettings() {
    return this._gameplayUi.resumeFromSettings();
  }

  resumeFromBuyMenu() {
    return this._gameplayUi.resumeFromBuyMenu();
  }

  onPointerLockChange(locked) {
    return this._gameplayUi.onPointerLockChange(locked);
  }

  canUseGameplayInput() {
    return this._gameplayUi.canUseInput();
  }

  setGameplayInputEnabled(enabled) {
    return this._gameplayUi.setInputEnabled(enabled);
  }

  syncGameplayInput() {
    return this._gameplayUi.syncInput();
  }

  restoreGameplayFocus() {
    return this._gameplayUi.restoreFocus();
  }

  canOpenBuyMenu() {
    return this._gameplayUi.canOpenBuyMenu();
  }

  toggleBuyMenuFromInput() {
    return this._gameplayUi.toggleBuyMenuFromInput();
  }

  closeBuyMenu() {
    return this._gameplayUi.closeBuyMenu();
  }

  syncBuyMenuState() {
    return this._gameplayUi.syncBuyMenuState();
  }

  purchaseWeapon(weapon) {
    return this._gameplayUi.purchaseWeapon(weapon);
  }

  /** Returns the confirmed weapon id once, otherwise null. */
  confirmPurchase(self = this._gameplay.selfRow) {
    return this._gameplayUi.confirmPurchase(self);
  }

  handleDisconnect() {
    if (this._disconnected || this._tornDown) return false;

    this._disconnected = true;
    this._phase = 'disconnecting';
    this._liveActive = false;
    this.closeBuyMenu();
    this.hud.closeSettings();
    this.hud.hideLobby();
    this._document?.getElementById?.('hud')?.classList.add('hidden');
    this._releaseLiveResources();

    if (!this._tornDown && this._phase === 'disconnecting') {
      this.enterMenu('disconnected — try again');
    }
    return true;
  }

  teardown() {
    if (this._tornDown) return false;

    this._tornDown = true;
    this._phase = 'torn-down';
    this._pregame.invalidate();
    this._disconnected = true;
    this._liveActive = false;
    this._gameplayUi.resetPendingPurchase();
    this._welcome = null;
    this._myId = null;
    this._mapMeta = null;

    this.closeBuyMenu();
    this.hud.closeSettings();
    this._releaseLiveResources();
    this.hud.setPainImpulse(0);
    this.hud.setDeathBrutality(0);

    this._pregame.closeCurrentNet();

    this._window?.removeEventListener?.('resize', this._onResize);
    this._window?.removeEventListener?.('pagehide', this._onPageHide);
    this._document?.removeEventListener?.('visibilitychange', this._onVisibilityChange);

    this._disposeOwned(this.input, 'input');
    this._disposeOwned(this.hud, 'hud');
    if (typeof this.onTeardown === 'function') {
      try {
        this.onTeardown();
      } catch (error) {
        console.error('[vb] session teardown callback failed:', error);
      }
    }
    this._disposeOwned(this.audio, 'audio');

    this.onEnterLive = null;
    this.onDisconnect = null;
    this.onGameplayEvent = null;
    this.onTick = null;
    this.onGameplayInputDisabled = null;
    this.onGameplayInputEnabled = null;
    this.onResize = null;
    this.onTeardown = null;
    return true;
  }

  _replacePregameNet() {
    return this._pregame.replaceNet();
  }

  _detachPregameListeners() {
    this._pregame.detachListeners();
  }

  _attachGameplayListeners(net) {
    if (this._gameplayEventsWired) return;
    this._gameplayEventsWired = true;

    for (const kind of GAMEPLAY_EVENT_KINDS) {
      this._gameplayUnsubs.push(net.on(kind, (event) => {
        if (this._tornDown || net !== this.net || !this._liveResourcesOwned) return;
        if (typeof this.onGameplayEvent === 'function') this.onGameplayEvent(event);
      }));
    }
    this._gameplayUnsubs.push(
      net.on('tick', (snapshot) => {
        if (
          this._tornDown ||
          net !== this.net ||
          (this._phase !== 'booting' && this._phase !== 'live')
        ) {
          return;
        }
        if (typeof this.onTick === 'function') this.onTick(snapshot, this._phase);
      }),
      net.on('close', () => {
        if (net === this.net) this.handleDisconnect();
      }),
    );
  }

  _detachGameplayListeners() {
    for (const unsubscribe of this._gameplayUnsubs) unsubscribe();
    this._gameplayUnsubs = [];
    this._gameplayEventsWired = false;
  }

  _beginLiveBoot(attempt) {
    this._attachGameplayListeners(attempt.net);
    this._liveResourcesOwned = true;

    try {
      this._welcome = attempt.welcome;
      this._myId = attempt.welcome.id;
      this._mapMeta = getMapMeta(attempt.welcome.map);
      const handoff = requireFunction(this.onEnterLive, 'onEnterLive');
      const payload = Object.freeze({
        net: attempt.net,
        welcome: attempt.welcome,
        mapBytes: attempt.mapBytes,
        mapMeta: this._mapMeta,
        sensitivity: attempt.sensitivity,
        mode: attempt.mode,
        isActive: () => this._isActiveBootAttempt(attempt),
        showStatus: (message, tone = '') => {
          if (!this._isActiveBootAttempt(attempt)) return false;
          this._pregame.showBootStatus(attempt, message, tone);
          return true;
        },
        complete: (ordering) => this._completeLiveBoot(attempt, ordering),
      });
      const result = handoff(payload);
      Promise.resolve(result).then(
        () => {
          if (this._isActiveBootAttempt(attempt) && !attempt.bootCompleted) {
            this._handleBootFailure(
              attempt,
              new Error('onEnterLive resolved without completing the live boot'),
            );
          }
        },
        (error) => this._handleBootFailure(attempt, error),
      );
    } catch (error) {
      this._handleBootFailure(attempt, error);
    }
  }

  _isActiveBootAttempt(attempt) {
    return this.isActivePregameAttempt(attempt) &&
      attempt.liveStarted &&
      !attempt.bootCompleted &&
      this._phase === 'booting';
  }

  _completeLiveBoot(attempt, ordering) {
    if (!this._isActiveBootAttempt(attempt)) return false;
    if (!ordering || typeof ordering !== 'object') {
      throw new TypeError('Session live boot completion requires ordering callbacks');
    }

    const activateLive = requireFunction(ordering.activateLive, 'activateLive');
    const flushQueuedSnapshots = requireFunction(
      ordering.flushQueuedSnapshots,
      'flushQueuedSnapshots',
    );
    const consumeLatestAuthoritativeState = requireFunction(
      ordering.consumeLatestAuthoritativeState,
      'consumeLatestAuthoritativeState',
    );
    const startLoop = requireFunction(ordering.startLoop, 'startLoop');

    attempt.bootCompleted = true;
    this.input.bind((locked) => this.onPointerLockChange(locked));
    if (Number.isFinite(attempt.sensitivity)) this.input.setSensitivity(attempt.sensitivity);

    this.hud.buildHUD();
    this.hud.setupSettings({
      sensitivity: this.input.getSensitivity(),
      volume: this._masterVolume,
      fov: this._baseFov,
      onChange: (settings) => this.applySettings(settings),
      onResume: () => this.resumeFromSettings(),
    });
    this.hud.setupBuyMenu({
      onBuy: (weapon) => this.purchaseWeapon(weapon),
      onClose: () => this.resumeFromBuyMenu(),
    });
    this.hud.setBuyMenuState({
      open: false,
      phase: 'live',
      credits: 0,
      owned: [],
    });
    this.hud.hideLobby();
    this.audio.stopMenuMusic?.();
    this.hud.menuDone();

    this._phase = 'live';
    this._pregame.clearCompletedAttempt(attempt);
    this._liveActive = true;
    activateLive();
    if (!this._isCurrentLiveNet(attempt.net)) return false;

    flushQueuedSnapshots();
    if (!this._isCurrentLiveNet(attempt.net)) return false;

    consumeLatestAuthoritativeState();
    if (!this._isCurrentLiveNet(attempt.net)) return false;

    this.syncGameplayInput();
    if (this.gameplayInputEnabled) this.input.requestLock();
    if (!this._isCurrentLiveNet(attempt.net)) return false;

    startLoop();
    return true;
  }

  _isCurrentLiveNet(net) {
    return !this._tornDown &&
      !this._disconnected &&
      this._liveActive &&
      this._phase === 'live' &&
      net === this.net;
  }

  _handleBootFailure(attempt, error) {
    if (
      this._tornDown ||
      attempt.net !== this.net ||
      (this._phase !== 'booting' && this._phase !== 'live')
    ) {
      return;
    }
    console.error('[vb] boot failed:', error);
    const message = 'boot failed: ' + (error && error.message || error);
    try {
      this._pregame.showBootStatus(attempt, message, 'err');
    } catch (_) {}
    this.teardown();
  }

  _releaseLiveResources() {
    this._detachGameplayListeners();
    this._liveActive = false;
    this.setGameplayInputEnabled(false);
    this.input.exit();

    if (!this._liveResourcesOwned) return;
    this._liveResourcesOwned = false;
    if (typeof this.onDisconnect === 'function') {
      try {
        this.onDisconnect();
      } catch (error) {
        console.error('[vb] live disposal callback failed:', error);
      }
    }
  }

  _connectUrl() {
    if (!this._location) throw new Error('browser location unavailable');
    const wsProtocol = this._location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProtocol}//${this._location.host}`;
  }

  _writePreference(key, value) {
    if (!this._storage) return;
    try {
      this._storage.setItem(key, value);
    } catch (_) {}
  }

  _unlockAudioQuietly() {
    try {
      Promise.resolve(this.audio.unlock()).catch(() => {});
    } catch (_) {}
  }

  _closeNet(net) {
    net.onMap = null;
    net.close();
  }

  _disposeOwned(value, label) {
    if (!value || typeof value.dispose !== 'function') return;
    try {
      void value.dispose();
    } catch (error) {
      console.error(`[vb] ${label} disposal failed:`, error);
    }
  }
}
