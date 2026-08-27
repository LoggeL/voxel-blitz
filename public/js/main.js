// Voxel Blitz — game bootstrap & glue. Owns the render loop, local player
// prediction/reconcile, weapon state machine, and event routing between
// net -> sim -> guns/FX/HUD/audio modules.
import * as THREE from './vendor/three.module.js';
import { WEAPONS, WEAPON_IDS, CONDITION_RULES, computeSpreadConeDeg, sampleSpreadDir } from '../../shared/combatmath.js';
import { deserializeWorld, getBlock, getMapMeta, setBlock, SX, SZ } from '../../shared/worlddata.js';

import { NetClient } from './engine/netclient.js';
import { Input } from './engine/input.js';
import { WorldView } from './engine/worldview.js';
import { ViewmodelRig } from './guns/viewmodel.js';
import { TIMERS } from './guns/defs.js';
import { Effects, attachShellBridge } from './weapons/effects.js';
import { HUD } from './ui/hud.js';
import { sfx } from './audio/sfx.js';
import { PlayerPhysics, moveSpeedFor } from './player-physics.js';

const SEND_HZ = 60;
const TEAM_AVATAR_COLORS = Object.freeze({
  alpha: Object.freeze({ suit: 0x38bdf8, dark: 0x0c4a6e }),
  bravo: Object.freeze({ suit: 0xfb923c, dark: 0x7c2d12 }),
});

class Game {
  constructor() {
    this.net = null;
    this.input = new Input(document.getElementById('game'));
    this.input.setGameplayEnabled(false);
    this.hud = new HUD();
    this.renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('game'), antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 400);
    this.baseFov = readStoredNumber('vb-fov', 75, 65, 100);
    this.masterVolume = readStoredNumber('vb-volume', 0.8, 0, 1);
    this.camera.fov = this.baseFov;
    this.camera.updateProjectionMatrix();
    this.worldview = null;
    this.effects = null;
    this.mapMeta = null;
    this.ownBody = null;
    this.rig = null;
    this.physics = new PlayerPhysics();

    this.myId = null;
    this.welcome = null;
    this.myHp = 100;
    this.running = false;
    this.alive = true;
    this.slot = 0;                 // active weapon slot
    this.lastSlot = 1;
    this.ammo = {};                // wid -> {mag,reserve}
    this.nextFireAt = 0;
    this.deployUntil = 0;
    this.reloadState = null;       // {until, dur, type, weapon}
    this.bloomDeg = 0;
    this.adsT = 0;                 // 0..1
    this.wantAds = false;
    this.sendAccum = 0;
    this.recoilPitch = 0;          // + kicks view up
    this.recoilYaw = 0;
    this.avatars = new Map();      // id -> avatar refs
    this.pendingAvatarHits = new Map();
    this.remoteImpacts = new Map();
    this.pendingRemoteDeaths = new Map();
    this.playersCache = Object.freeze([]);
    this.matchState = null;
    this.selfRow = null;
    this.serverNow = null;
    this.clock = new THREE.Clock();
    this.view = { yaw: 0, pitch: 0 };
    this.keys = {};
    this.wishDir = { x: 0, z: 0 };
    this.pendingShotIntent = null;
    this.fireTapLatched = false;
    this._lastReconciledSnapSeq = null;
    this._lastConsumedSnapSeq = null;
    this._pendingAuthoritativeSnapshots = [];
    this._loopGeneration = 0;
    this._rafId = 0;
    this._pendingPurchase = null;
    this.currentSpeedXZ = 0;
    this.panic = 0;
    this.exhaustion = 0;
    this.pain = 0;
    this.spawnProtected = false;
    this.lastLocalImpact = null;
    this.scopeActive = false;
    this.deathElapsed = 0;
    this.deathRoll = 0;
    this.deathPitch = 0;
    this.deathSide = 1;
    this.dyingAvatars = 0;
    this.runningAvatars = 0;
    this.maxAvatarSpeed = 0;
    this._gameplayInputEnabled = false;
    this._tornDown = false;
    this._disconnected = false;
    this._phase = 'idle';
    this._pregameGeneration = 0;
    this._pregameAttempt = null;
    this._pregameUnsubs = [];
    this._gameplayUnsubs = [];
    this._gameplayEventsWired = false;
    this._onResize = () => {
      if (!this.renderer || !this.camera) return;
      this.renderer.setSize(innerWidth, innerHeight);
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
    };
    this._onPageHide = () => this.teardown();
    this._onVisibilityChange = () => {
      if (this._tornDown || document.visibilityState !== 'visible') return;
      try {
        Promise.resolve(sfx.unlock()).catch(() => {});
      } catch (_) {}
    };
    window.addEventListener('resize', this._onResize);
    window.addEventListener('pagehide', this._onPageHide, { once: true });
    document.addEventListener('visibilitychange', this._onVisibilityChange);
  }

  // ------------------------------------------------------------------ boot

  start() {
    this.enterMenu();
  }

  enterMenu(message = '') {
    if (this._tornDown) return;
    this._phase = 'menu';
    this._disconnected = false;
    this.alive = true;
    this.myHp = 100;
    this.slot = 0;
    this.lastSlot = 1;
    this.ammo = {};
    this.mapMeta = null;
    this.physics = new PlayerPhysics();
    this.view.yaw = 0;
    this.view.pitch = 0;
    this.sendAccum = 0;
    this.nextFireAt = 0;
    this.deployUntil = 0;
    this.reloadState = null;
    this.bloomDeg = 0;
    this.adsT = 0;
    this.wantAds = false;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.currentSpeedXZ = 0;
    this.panic = 0;
    this.exhaustion = 0;
    this.pain = 0;
    this.spawnProtected = false;
    this.lastLocalImpact = null;
    this.scopeActive = false;
    this.deathElapsed = 0;
    this.deathRoll = 0;
    this.deathPitch = 0;
    this.playersCache = Object.freeze([]);
    this._pendingAuthoritativeSnapshots = [];
    this.remoteImpacts.clear();
    this.pendingRemoteDeaths.clear();
    this.running = false;
    this.setGameplayInputEnabled(false);
    this.closeBuyMenu();
    this.hud.closeSettings();
    this.hud.hideLobby();
    this.matchState = null;
    this.selfRow = null;
    this.serverNow = null;
    this._lastConsumedSnapSeq = null;
    this._lastReconciledSnapSeq = null;
    this._pendingPurchase = null;
    this._pregameAttempt = null;
    this.welcome = null;
    this.myId = null;
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
    this.replacePregameNet();
    this.hud.buildMenu((action) => {
      void this.beginPregame(action);
    });
    if (message) this.hud.showJoinState(message, 'err');
  }

  replacePregameNet() {
    this._pregameGeneration++;
    this.detachPregameListeners();
    this.detachGameplayListeners();
    const previous = this.net;
    if (previous) {
      previous.onMap = null;
      previous.close();
    }

    const net = new NetClient();
    this.net = net;
    this._pregameUnsubs = [
      net.on('lobby', (state) => this.handleLobbyState(net, state)),
      net.on('serverError', (error) => this.handlePregameServerError(net, error)),
      net.on('close', () => this.handlePregameClose(net)),
    ];
    return net;
  }

  detachPregameListeners() {
    for (const unsubscribe of this._pregameUnsubs) unsubscribe();
    this._pregameUnsubs = [];
  }

  detachGameplayListeners() {
    for (const unsubscribe of this._gameplayUnsubs) unsubscribe();
    this._gameplayUnsubs = [];
    this._gameplayEventsWired = false;
  }

  isActivePregameAttempt(attempt) {
    return !this._tornDown &&
      attempt === this._pregameAttempt &&
      attempt.net === this.net &&
      attempt.generation === this._pregameGeneration;
  }

  async beginPregame(action) {
    if (this._tornDown || this._phase !== 'menu' || !action) return;
    const audioReady = this.unlockAudioFromGesture();

    const mode = action.mode === 'create' || action.mode === 'join' ? action.mode : 'quick';
    const name = String(action.name || '').trim().slice(0, 16) || 'Rookie';
    const requestedBots = Number(action.bots);
    const bots = Number.isFinite(requestedBots) ? Math.max(0, Math.round(requestedBots)) : 3;
    const sensitivity = Number(action.sensitivity);
    const code = String(action.code || '').trim().toUpperCase();
    const net = this.net;
    const attempt = {
      generation: this._pregameGeneration,
      net,
      mode,
      name,
      bots,
      sensitivity,
      code,
      welcome: null,
      mapBytes: null,
      lobbyState: null,
      lobbyShown: false,
      liveStarted: false,
    };
    this._pregameAttempt = attempt;
    this._phase = 'connecting';
    try {
      localStorage.setItem('vb-name', name);
    } catch (_) {}
    this.botCount = bots;
    this.hud.showJoinState('connecting…');

    net.onMap = (bytes) => {
      if (!this.isActivePregameAttempt(attempt)) return;
      attempt.mapBytes = bytes;
      this.maybeEnterLive(attempt);
    };

    await audioReady;
    if (!this.isActivePregameAttempt(attempt)) return;

    const opts = { mode };
    if (mode === 'quick' || mode === 'create') opts.bots = bots;
    if (mode === 'create') {
      opts.gameMode = action.gameMode;
      opts.map = action.map;
    }
    if (mode === 'join') opts.lobby = code;
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      const welcome = await net.connect(`${wsProtocol}//${location.host}`, name, opts);
      if (!this.isActivePregameAttempt(attempt)) {
        net.close();
        return;
      }
      attempt.welcome = welcome;
      if (net.latestLobbyState) attempt.lobbyState = net.latestLobbyState;
      if (this.maybeEnterLive(attempt)) return;
      if (attempt.lobbyState && attempt.lobbyState.phase === 'waiting') {
        this.presentLobby(attempt, attempt.lobbyState);
      } else if (mode !== 'quick') {
        this.hud.showJoinState('waiting for lobby…');
      }
    } catch (error) {
      if (!this.isActivePregameAttempt(attempt)) return;
      const detail = error && error.message ? error.message : 'try again';
      this.enterMenu(`connection failed — ${detail}`);
    }
  }

  unlockAudioFromGesture() {
    try {
      const initializing = sfx.init();
      sfx.setMasterVolume(this.masterVolume);
      const unlocking = sfx.unlock();
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

  handleLobbyState(net, state) {
    const attempt = this._pregameAttempt;
    if (!attempt || attempt.net !== net || !this.isActivePregameAttempt(attempt) || !state) return;
    attempt.lobbyState = state;
    if (state.phase === 'live') {
      this.maybeEnterLive(attempt);
      return;
    }
    if (state.phase === 'waiting' && !attempt.liveStarted) this.presentLobby(attempt, state);
  }

  presentLobby(attempt, state) {
    if (!this.isActivePregameAttempt(attempt) || attempt.liveStarted) return;
    this._phase = 'lobby';
    if (attempt.lobbyShown) {
      this.hud.updateLobby(state);
      return;
    }
    attempt.lobbyShown = true;
    this.hud.showLobby(state, {
      onReady: (value) => {
        void this.setLobbyReady(attempt, value);
      },
      onStart: () => {
        void this.startLobby(attempt);
      },
      onLeave: () => this.leaveLobby(attempt),
    });
  }

  async setLobbyReady(attempt, value) {
    await this.unlockAudioFromGesture();
    if (!this.isActivePregameAttempt(attempt) || this._phase !== 'lobby') return;
    attempt.net.setReady(!!value);
  }

  async startLobby(attempt) {
    await this.unlockAudioFromGesture();
    if (!this.isActivePregameAttempt(attempt) || this._phase !== 'lobby') return;
    attempt.net.requestStart();
  }

  leaveLobby(attempt) {
    if (!this.isActivePregameAttempt(attempt) || this._phase !== 'lobby') return;
    this._phase = 'leaving';
    this._pregameAttempt = null;
    this.detachPregameListeners();
    attempt.net.onMap = null;
    attempt.net.close();
    this.clearInviteQuery();
    this.enterMenu();
  }

  clearInviteQuery() {
    try {
      const url = new URL(location.href);
      if (!url.searchParams.has('lobby')) return;
      url.searchParams.delete('lobby');
      history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch (_) {}
  }

  handlePregameServerError(net, error) {
    const attempt = this._pregameAttempt;
    if (!attempt || attempt.net !== net || !this.isActivePregameAttempt(attempt)) return;
    const message = error && typeof error.msg === 'string'
      ? error.msg
      : (typeof error === 'string' ? error : 'server rejected request');
    if (this._phase === 'lobby') {
      this.hud.showLobbyStatus(message, 'err');
      return;
    }
    this.enterMenu(message);
  }

  handlePregameClose(net) {
    const attempt = this._pregameAttempt;
    if (!attempt || attempt.net !== net || !this.isActivePregameAttempt(attempt)) return;
    if (this._phase === 'connecting' || this._phase === 'lobby') {
      this.enterMenu('connection lost — try again');
    }
  }

  maybeEnterLive(attempt) {
    if (!this.isActivePregameAttempt(attempt) || attempt.liveStarted) return false;
    const lobbyPhase = attempt.lobbyState && attempt.lobbyState.phase;
    const welcomePhase = attempt.welcome && attempt.welcome.phase;
    const isLive = attempt.mode === 'quick' || lobbyPhase === 'live' || welcomePhase === 'live';
    if (!isLive || !attempt.welcome || attempt.mapBytes == null) return false;

    attempt.liveStarted = true;
    this._phase = 'booting';
    this.showLiveBootStatus(attempt, 'streaming arena…', 'ok');
    this.detachPregameListeners();
    attempt.net.onMap = null;
    this.wireEvents();
    void this.bootLive(attempt);
    return true;
  }

  showLiveBootStatus(attempt, message, tone = '') {
    if (attempt.lobbyShown) this.hud.showLobbyStatus(message, tone);
    else this.hud.showJoinState(message, tone);
  }

  async bootLive(attempt) {
    try {
      if (this._tornDown || attempt.net !== this.net) return;
      this.welcome = attempt.welcome;
      this.myId = attempt.welcome.id;
      this.mapMeta = getMapMeta(attempt.welcome.map);
      this.physics.setMapMeta(this.mapMeta);
      this.myHp = 100;
      const spawn = attempt.welcome.spawn;
      if (spawn && [spawn.x, spawn.y, spawn.z].every(Number.isFinite)) {
        this.physics.pos.x = spawn.x;
        this.physics.pos.y = spawn.y;
        this.physics.pos.z = spawn.z;
      }

      deserializeWorld(attempt.mapBytes);
      for (const snapshot of this.net.latestSnapshots) {
        this.applySnapshotBlocks(snapshot);
        this.queueAuthoritativeSnapshot(snapshot);
      }
      if (!attempt.net.isOpen()) {
        this.handleDisconnect();
        return;
      }

      this.showLiveBootStatus(attempt, 'building voxel mesh…', 'ok');
      this.worldview = new WorldView({ getBlock }, this.mapMeta);
      await this.worldview.ready();
      if (this._tornDown || attempt.net !== this.net || this._phase !== 'booting') return;
      if (!attempt.net.isOpen()) {
        this.handleDisconnect();
        return;
      }

      this.effects = new Effects(this.worldview.scene, this.camera, getBlock);
      this.worldview.scene.add(this.camera);   // camera parented => viewmodel children render
      this.ownBody = makeFirstPersonBody();
      this.worldview.scene.add(this.ownBody.group);
      this.rig = new ViewmodelRig(this.camera);
      attachShellBridge(this.effects, this.rig);
      this.rig.setWeapon(WEAPON_IDS[this.slot]);
      this.rig.onReloadClick = (step) => sfx.reloadClick(step, WEAPON_IDS[this.slot]);

      this.applyWelcomeAmmo();
      this.input.bind((locked) => this.onPointerLockChange(locked));
      if (Number.isFinite(attempt.sensitivity)) this.input.setSensitivity(attempt.sensitivity);

      this.hud.buildHUD();
      this.hud.setupSettings({
        sensitivity: this.input.getSensitivity(),
        volume: this.masterVolume,
        fov: this.baseFov,
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
      this.hud.menuDone();
      this._phase = 'live';
      this._pregameAttempt = null;
      this.running = true;
      this.clock.start();
      this.flushPendingAuthoritativeSnapshots();
      this.consumeLatestAuthoritativeState();
      this.syncGameplayInput();
      if (this._gameplayInputEnabled) this.input.requestLock();
      this.loop(++this._loopGeneration);
    } catch (error) {
      if (this._tornDown || attempt.net !== this.net) return;
      console.error('[vb] boot failed:', error);
      const message = 'boot failed: ' + (error && error.message || error);
      try { this.showLiveBootStatus(attempt, message, 'err'); } catch (_) {}
      this.teardown();
    }
  }
  applySettings(settings) {
    if (!settings || typeof settings !== 'object') return;
    const sensitivity = clampNumber(settings.sensitivity, 0.005, 0.08, this.input.getSensitivity());
    const volume = clampNumber(settings.volume, 0, 1, this.masterVolume);
    const fov = clampNumber(settings.fov, 65, 100, this.baseFov);
    this.input.setSensitivity(sensitivity);
    this.masterVolume = volume;
    this.baseFov = fov;
    try {
      localStorage.setItem('vb-volume', String(volume));
      localStorage.setItem('vb-fov', String(fov));
    } catch (_) {}
    sfx.setMasterVolume(volume);
  }

  resumeFromSettings() {
    this.hud.closeSettings();
    this.closeBuyMenu();
    this.syncGameplayInput();
    Promise.resolve(sfx.unlock()).catch(() => {});
    if (this._gameplayInputEnabled) this.input.requestLock();
  }

  resumeFromBuyMenu() {
    if (this._tornDown) return;
    this.syncGameplayInput();
    Promise.resolve(sfx.unlock()).catch(() => {});
    if (this._gameplayInputEnabled) this.input.requestLock();
  }

  onPointerLockChange(locked) {
    if (locked) {
      if (!this.canUseGameplayInput()) {
        this.setGameplayInputEnabled(false);
        this.input.exit();
        return;
      }
      this.hud.closeSettings();
      this.setGameplayInputEnabled(true);
      Promise.resolve(sfx.unlock()).catch(() => {});
      return;
    }
    this.setGameplayInputEnabled(false);
    if (
      this.running && this._phase === 'live' && this.alive && !this._disconnected &&
      !this.hud.isBuyMenuOpen()
    ) {
      this.hud.openSettings();
    }
  }

  canUseGameplayInput() {
    return !!(
      this.running && this._phase === 'live' && this.alive && !this._disconnected &&
      !this._tornDown && !this.hud.settingsOpen && !this.hud.isBuyMenuOpen()
    );
  }

  syncGameplayInput() {
    this.setGameplayInputEnabled(this.canUseGameplayInput());
  }

  canOpenBuyMenu() {
    return !!(
      this.canUseGameplayInput() &&
      this.matchState?.mode === 'snd' &&
      this.matchState.phase === 'prep' &&
      this.selfRow?.state === 'alive'
    );
  }

  toggleBuyMenuFromInput() {
    if (this.hud.isBuyMenuOpen()) {
      this.hud.toggleBuyMenu(false);
      return;
    }
    if (!this.canOpenBuyMenu()) return;
    this.hud.closeSettings();
    if (!this.hud.toggleBuyMenu(true)) return;
    this.syncBuyMenuState();
    this.setGameplayInputEnabled(false);
    this.input.exit();
  }

  closeBuyMenu() {
    if (this.hud.isBuyMenuOpen()) this.hud.toggleBuyMenu(false);
    this.hud.setBuyMenuState({
      open: false,
      phase: this.matchState?.phase || 'live',
      credits: 0,
      owned: [],
    });
  }

  syncBuyMenuState() {
    const self = this.selfRow;
    const phase = this.matchState?.phase || 'live';
    const admitted = !!(
      this.running && this._phase === 'live' && this.alive && !this._disconnected &&
      this.matchState?.mode === 'snd' && phase === 'prep' && self?.state === 'alive'
    );
    let open = this.hud.isBuyMenuOpen();
    if (open && !admitted) {
      this.hud.toggleBuyMenu(false);
      open = false;
    }
    this.hud.setBuyMenuState({
      open: open && admitted,
      phase,
      credits: Number.isFinite(self?.credits) ? self.credits : 0,
      owned: Array.isArray(self?.owned) ? self.owned : [],
    });
    if (!open) this.syncGameplayInput();
  }

  purchaseWeapon(weapon) {
    if (
      typeof weapon !== 'string' || !this.hud.isBuyMenuOpen() ||
      !this.matchState || this.matchState.mode !== 'snd' ||
      this.matchState.phase !== 'prep' || this.selfRow?.state !== 'alive' ||
      !this.running || this._disconnected
    ) {
      return;
    }
    if (this.net.buyWeapon(weapon)) {
      this._pendingPurchase = { weapon, until: nowMs() + 1500 };
    }
  }

  applyConfirmedPurchase(self) {
    const pending = this._pendingPurchase;
    if (!pending) return;
    if (Array.isArray(self?.owned) && self.owned.includes(pending.weapon)) {
      this._pendingPurchase = null;
      const slot = WEAPON_IDS.indexOf(pending.weapon);
      if (slot >= 0) this.wantSwitchTo(slot);
      return;
    }
    if (nowMs() >= pending.until || this.matchState?.phase !== 'prep') {
      this._pendingPurchase = null;
    }
  }

  setGameplayInputEnabled(enabled) {
    const next = !!enabled && !this._tornDown;
    this.input.setGameplayEnabled(next);
    if (next === this._gameplayInputEnabled) return;
    this._gameplayInputEnabled = next;
    if (next) {
      this.input.consumeBuyMenuRequest();
      return;
    }
    this.keys = {};
    this.wishDir.x = 0;
    this.wishDir.z = 0;
    this.pendingShotIntent = null;
    this.fireTapLatched = false;
    this.wantAds = false;
    this.physics._crouching = false;
  }



  applyWelcomeAmmo() {
    for (const wid of WEAPON_IDS) {
      const d = WEAPONS[wid];
      this.ammo[wid] = { mag: d.magSize, reserve: d.reserveMax };
    }
  }

  // ------------------------------------------------------------------ net wiring

  wireEvents() {
    if (this._gameplayEventsWired) return;
    this._gameplayEventsWired = true;
    // NetClient dispatches each drained snapshot event by its kind string.
    for (const kind of ['shoot', 'hit', 'kill', 'block', 'respawn', 'die']) {
      this._gameplayUnsubs.push(this.net.on(kind, (ev) => this.handleEvent(ev)));
    }
    this._gameplayUnsubs.push(
      this.net.on('tick', (msg) => this.handleTick(msg)),
      this.net.on('close', () => this.handleDisconnect()),
    );
  }
  handleTick(msg) {
    this.applySnapshotBlocks(msg);
    if (this._phase === 'booting') {
      this.queueAuthoritativeSnapshot(msg);
    } else if (this.running && this._phase === 'live') {
      this.consumeAuthoritativeSnapshot(msg);
    }
  }

  queueAuthoritativeSnapshot(snapshot) {
    if (snapshot && typeof snapshot === 'object') {
      this._pendingAuthoritativeSnapshots.push(snapshot);
    }
  }

  flushPendingAuthoritativeSnapshots() {
    const pending = this._pendingAuthoritativeSnapshots;
    this._pendingAuthoritativeSnapshots = [];
    for (const snapshot of pending) this.consumeAuthoritativeSnapshot(snapshot);
  }


  applySnapshotBlocks(msg) {
    const deltas = msg && Array.isArray(msg.blocks) ? msg.blocks : null;
    if (!deltas || !deltas.length) return;
    const touched = [];
    for (const d of deltas) {
      const i = d.i | 0;
      if (i < 0 || i >= SX * SZ * 40) continue;
      const v = d.v | 0;
      const x = i % SX;
      const z = ((i / SX) | 0) % SZ;
      const y = (i / (SX * SZ)) | 0;
      if (getBlock(x, y, z) === v) continue;
      setBlock(x, y, z, v);
      touched.push({ x, y, z, v });
    }
    if (touched.length && this.worldview) this.worldview.applyDeltas(touched);
  }

  handleDisconnect() {
    if (this._disconnected || this._tornDown) return;
    this._disconnected = true;
    this._phase = 'disconnecting';
    this.running = false;
    this.closeBuyMenu();
    this.hud.closeSettings();
    this.hud.hideLobby();
    document.getElementById('hud')?.classList.add('hidden');
    this.disposeLiveResources();
    this.enterMenu('disconnected — try again');
  }

  disposeLiveResources() {
    this._loopGeneration++;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = 0;
    }
    this.detachGameplayListeners();
    this.running = false;
    this.clock.stop();
    this.setGameplayInputEnabled(false);
    this.input.exit();
    this._pendingAuthoritativeSnapshots = [];
    for (const av of this.avatars.values()) {
      if (this.worldview) this.worldview.scene.remove(av.group);
      disposeAvatar(av);
    }
    this.avatars.clear();
    this.pendingAvatarHits.clear();
    this.remoteImpacts.clear();
    this.pendingRemoteDeaths.clear();
    if (this.ownBody) {
      if (this.worldview) this.worldview.scene.remove(this.ownBody.group);
      disposeObjectTree(this.ownBody.group);
      this.ownBody = null;
    }
    if (this.rig) {
      this.rig.onReloadClick = null;
      this.rig.dispose();
    }
    if (this.effects) this.effects.dispose();
    if (this.worldview) this.worldview.dispose();
    this.rig = null;
    this.effects = null;
    this.worldview = null;
    this.mapMeta = null;
    this.playersCache = Object.freeze([]);
    this.dyingAvatars = 0;
    this.runningAvatars = 0;
    this.maxAvatarSpeed = 0;
  }

  teardown() {
    if (this._tornDown) return;
    this._tornDown = true;
    this._phase = 'torn-down';
    this._pregameGeneration++;
    this._pregameAttempt = null;
    this.detachPregameListeners();
    this.running = false;
    this._disconnected = true;
    this.alive = false;
    this.matchState = null;
    this.selfRow = null;
    this.serverNow = null;
    this._lastConsumedSnapSeq = null;
    this._lastReconciledSnapSeq = null;
    this.closeBuyMenu();
    this.hud.closeSettings();
    this._pendingPurchase = null;
    this.myHp = 0;
    this.reloadState = null;
    this.adsT = 0;
    this.scopeActive = false;
    this.panic = 0;
    this.exhaustion = 0;
    this.pain = 0;
    this.spawnProtected = false;
    this.lastLocalImpact = null;
    this.currentSpeedXZ = 0;
    this.disposeLiveResources();
    this.hud.setPainImpulse(0);
    this.hud.setDeathBrutality(0);
    if (this.net) {
      this.net.onMap = null;
      this.net.close();
    }
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('pagehide', this._onPageHide);
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    if (this._debugInterval) {
      clearInterval(this._debugInterval);
      this._debugInterval = null;
    }
    if (this._onDebugError) {
      window.removeEventListener('error', this._onDebugError, true);
      this._onDebugError = null;
    }
    this.input.dispose();
    this.hud.dispose();
    this.renderer.dispose();
    void sfx.dispose();
  }

  handleEvent(ev) {
    if (!this.running && ev.t !== 'tick') return;
    switch (ev.kind) {
      case 'shoot': {
        const local = ev.id === this.myId;
        if (!local) {
          this.effects.shoot(ev);
          sfx.fire(ev.w, { pos: ev.o });
          const d = this.distanceToRay(ev.o, ev.spread || ev.d);
          if (d < 2.2) sfx.bulletWhiz(Math.max(0.15, 1 - d / 2.2));
        }
        break;
      }
      case 'hit': {
        const localVictim = ev.victim === this.myId;
        if (!localVictim) {
          const victimRow = this.playersCache.find((row) => row.id === ev.victim);
          const lethal = victimRow?.state === 'dead' ||
            (Number.isFinite(victimRow?.hp) && victimRow.hp <= 0);
          this.hitAvatar(ev.victim, ev);
          sfx.pain({
            damage: ev.dmg,
            headshot: ev.hs,
            lethal,
            pos: impactPosition(ev),
            local: false,
          });
        }
        this.effects.impact(ev);
        if (ev.attacker === this.myId && !localVictim) {
          this.hud.hitmark(ev.hs);
          sfx.hitmark(ev.hs);
          this.spawnDamageNumber(ev);
        }
        if (localVictim && this.alive) this.applyLocalHit(ev);
        break;
      }
      case 'kill': {
        this.hud.killfeed(ev);
        if (ev.victim === this.myId) {
          this.onDeath(ev.killer, { headshot: ev.hs });
        } else {
          this.beginRemoteDeath(ev.victim);
        }
        break;
      }
      case 'block': {
        const nextType = ev.v | 0;
        const fromType = ev.from | 0;
        if (getBlock(ev.x, ev.y, ev.z) !== nextType) {
          setBlock(ev.x, ev.y, ev.z, nextType);
          this.worldview.applyDeltas([{ x: ev.x, y: ev.y, z: ev.z, v: nextType }]);
        }
        if (nextType === 0 && fromType !== 0) {
          this.effects.explodeBlock(ev.x, ev.y, ev.z, fromType);
          sfx.impact(this.blockSound(fromType), 0.8, [ev.x, ev.y, ev.z]);
        }
        break;
      }
      case 'respawn': {
        if (ev.id === this.myId) {
          const hp = this.selfRow?.hp;
          if (!this.alive && this.selfRow?.state === 'alive' &&
              Number.isFinite(hp) && hp > 0) {
            this.onRespawned(this.selfRow);
          }
        } else {
          this.resetRemoteAvatar(ev.id, ev);
        }
        break;
      }
      case 'die': {
        if (ev.id === this.myId) this.onDeath(null);
        else this.beginRemoteDeath(ev.id);
        break;
      }
    }
  }

  blockSound(type) {
    if (type === 11 /* GLASS */) return 'glass';
    if (type === 10 /* PLANK */ || type === 6 /* LEAVES */ || type === 5 /* WOOD */) return 'wood';
    if (type === 9 /* ACCENT */ || type === 8 /* METAL */) return 'metal';
    return 'stone';
  }

  distanceToRay(o, d) {
    const px = this.camera.position.x - o[0];
    const py = this.camera.position.y - o[1];
    const pz = this.camera.position.z - o[2];
    const t = Math.max(0, px * d[0] + py * d[1] + pz * d[2]);
    return Math.hypot(px - d[0] * t, py - d[1] * t, pz - d[2] * t);
  }

  spawnDamageNumber(ev) {
    // vx,vy,vz is impact/chest position in world space
    const v = new THREE.Vector3(ev.vx, ev.vy, ev.vz).project(this.camera);
    const behind = v.z > 1;
    const x = (v.x * 0.5 + 0.5) * innerWidth;
    const y = (-v.y * 0.5 + 0.5) * innerHeight;
    this.hud.spawnDamage(ev.dmg, x, y, !behind, ev.hs);
  }
  applyLocalHit(ev) {
    this.lastLocalImpact = ev;
    const damage = Math.max(0, Number(ev.dmg) || 0);
    const severity = clamp01(damage / 55);
    const painLevel = Math.max(this.pain, severity);
    const headshotScale = ev.hs ? 1.45 : 1;
    const trauma = (0.45 + severity * 0.85 + painLevel * 0.65) * headshotScale;
    const side = (hashInt(`${ev.attacker}|${ev.vx}|${ev.vz}`) & 1) ? 1 : -1;
    this.view.yaw += side * trauma * 0.045;
    this.view.pitch += trauma * 0.052;
    this.view.pitch = clampPitch(this.view.pitch);
    this.hud.setPainImpulse(clamp01(0.18 + severity * 0.72 + painLevel * 0.35));
    this.effects.gore(ev, { lethal: false, local: true });
    sfx.impact('flesh', Math.min(0.5, damage / 60), null);
    sfx.pain({
      damage,
      headshot: ev.hs,
      lethal: false,
      pos: impactPosition(ev),
      local: true,
    });
  }


  onDeath(killerId, context = null) {
    if (!this.alive) return;
    const impact = context?.impact || this.lastLocalImpact;
    const headshot = !!(context?.headshot || impact?.hs);
    this.alive = false;
    this.myHp = 0;
    this.reloadState = null;
    this.adsT = 0;
    this.scopeActive = false;
    this.spawnProtected = false;
    this.currentSpeedXZ = 0;
    this.deathElapsed = 0;
    this.deathSide = (hashInt(String(this.myId) + '|' + String(killerId || 'world')) & 1) ? 1 : -1;
    this.recoilPitch += headshot ? 0.2 : 0.11;
    this.recoilYaw += this.deathSide * (headshot ? 0.14 : 0.08);
    if (this.rig && this.rig.root) this.rig.root.visible = true;
    this.closeBuyMenu();
    this.setGameplayInputEnabled(false);
    this._pendingPurchase = null;
    this.input.exit();
    this.hud.closeSettings();
    this.hud.setPainImpulse(1);
    this.hud.setDeathBrutality(headshot ? 1 : 0.82);
    const goreImpact = validImpact(impact)
      ? impact
      : {
        vx: this.physics.pos.x,
        vy: this.physics.pos.y + 1.05,
        vz: this.physics.pos.z,
        hs: headshot,
      };
    this.effects?.gore(goreImpact, { lethal: true, local: true });
    sfx.deathSelf({ headshot });
    this.lastLocalImpact = null;
    this.hud.setDead(true, killerId ? this.nameOf(killerId) : '');
  }


  onRespawned(ev) {
    if (![ev.x, ev.y, ev.z].every(Number.isFinite)) return;
    this.setGameplayInputEnabled(false);
    this.alive = true;
    this.myHp = 100;
    this.physics.pos.x = ev.x;
    this.physics.pos.y = ev.y;
    this.physics.pos.z = ev.z;
    this.physics.vel.x = this.physics.vel.y = this.physics.vel.z = 0;
    this.physics.grounded = false;
    this.physics.coyote = 0;
    this.physics._crouching = false;
    this.panic = 0;
    this.exhaustion = 0;
    this.pain = Number.isFinite(ev.pain) ? clamp01(ev.pain) : 0;
    this.spawnProtected = typeof this.selfRow?.spawnProtected === 'boolean'
      ? this.selfRow.spawnProtected
      : true;
    this.lastLocalImpact = null;
    this.deathElapsed = 0;
    this.deathRoll = 0;
    this.deathPitch = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.currentSpeedXZ = 0;
    this.scopeActive = false;
    this.fireTapLatched = false;
    this.pendingShotIntent = null;
    this.reloadState = null;
    this.wantAds = false;
    this.adsT = 0;
    if (this.matchState?.mode !== 'snd') {
      this.slot = 0;
      this.lastSlot = 1;
      this.applyWelcomeAmmo();
    } else if (Number.isInteger(ev.weapon) && WEAPON_IDS[ev.weapon]) {
      this.slot = ev.weapon;
    }
    this.bloomDeg = 0;
    const deployNow = nowMs();
    this.deployUntil = deployNow + this.weaponDef.deployTime * 1000;
    this.nextFireAt = this.deployUntil;
    if (this.rig) {
      this.rig.setWeapon(WEAPON_IDS[this.slot]);
      if (this.rig.root) this.rig.root.visible = true;
    }
    resetFirstPersonBody(this.ownBody);
    this.hud.setPainImpulse(0);
    this.hud.setDeathBrutality(0);
    this.hud.setDead(false, '');
    this.syncGameplayInput();
    if (this._gameplayInputEnabled) this.input.requestLock();
  }

  nameOf(id) {
    const p = this.playersCache.find((r) => r.id === id);
    return p ? p.name : id;
  }

  // ------------------------------------------------------------------ weapons

  get weaponDef() { return WEAPONS[WEAPON_IDS[this.slot]]; }
  get timerDef() { return TIMERS[WEAPON_IDS[this.slot]]; }

  wantSwitchTo(slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= WEAPON_IDS.length || slot === this.slot) return;
    if (
      this.matchState?.mode === 'snd' && Array.isArray(this.selfRow?.owned) &&
      !this.selfRow.owned.includes(WEAPON_IDS[slot])
    ) {
      return;
    }
    this.lastSlot = this.slot;
    this.slot = slot;
    this.reloadState = null;
    this.deployUntil = nowMs() + this.weaponDef.deployTime * 1000;
    this.nextFireAt = Math.max(this.nextFireAt, this.deployUntil);
    this.rig.setWeapon(WEAPON_IDS[slot]);
    sfx.draw(WEAPON_IDS[slot]);
  }

  cycleWeapon(dir) {
    if (!Number.isFinite(dir) || dir === 0) return;
    const available = this.matchState?.mode === 'snd' && Array.isArray(this.selfRow?.owned)
      ? WEAPON_IDS.map((id, slot) => this.selfRow.owned.includes(id) ? slot : -1)
        .filter((slot) => slot >= 0)
      : WEAPON_IDS.map((_, slot) => slot);
    if (!available.length) return;
    const current = available.indexOf(this.slot);
    const origin = current >= 0 ? current : 0;
    const next = ((origin + Math.trunc(dir)) % available.length + available.length) % available.length;
    this.wantSwitchTo(available[next]);
  }

  startReload(now) {
    if (this.reloadState || !this.alive) return;
    const def = this.weaponDef;
    const a = this.ammo[def.id];
    if (a.mag >= def.magSize || a.reserve <= 0) return;
    const dur = def.reloadTime * 1000;
    const type = def.id === 'shotgun' ? 'tube' : 'magswap';
    this.reloadState = { until: now + dur, dur, type, weapon: def.id };
    this.rig.reload(dur / 1000, type);
  }

  tickReload(now) {
    const rs = this.reloadState;
    if (!rs || now < rs.until) return;
    const def = WEAPONS[rs.weapon];
    const a = this.ammo[rs.weapon];
    if (def && a) {
      const need = def.magSize - a.mag;
      const take = Math.min(need, a.reserve);
      a.mag += take;
      a.reserve -= take;
    }
    this.reloadState = null;
  }

  tryFire(now) {
    if (!this.isAuthoritativeFireAllowed()) return;
    const def = this.weaponDef;
    const tid = def.id;
    if (now < this.nextFireAt || now < this.deployUntil) return;
    if (this.reloadState) return;
    const a = this.ammo[tid];
    if (a.mag <= 0) {
      if (this.pendingShotIntent && this.pendingShotIntent.tap) sfx.reloadClick(3, tid); // empty click on trigger pull
      this.startReload(now);
      return;
    }
    const input = this.pendingShotIntent;
    if (!input) return;
    // Trigger taps are edges for semi-auto guns and a one-shot fallback for
    // an auto weapon released before the next render sample.
    const mode = def.mode;
    if (mode === 'auto') {
      if (!input.held && !input.tap) return;
    } else if (!input.tap) {
      return;
    }
    if (!this.rig.fire()) return;

    a.mag -= 1;
    this.nextFireAt = now + 60000 / def.rpm;

    // Spread samples the pre-shot condition; accepted-shot gain is applied
    // only after every pellet direction has been fixed, matching authority.
    const fwd = fwdFromAngles(this.view.yaw, this.view.pitch);
    const spreadCone = currentConeDeg(
      def,
      this.bloomDeg,
      this.currentSpeedXZ,
      this.adsT,
      this.panic,
      this.exhaustion,
      !!this.physics._crouching,
      this.pain,
    );
    const rngV = () => Math.random();

    const pellets = [];
    for (let i = 0; i < def.pellets; i++) {
      const d = sampleSpreadDir(fwd, rngV, spreadCone);
      pellets.push(d);

    }
    this.bloomDeg = Math.min(def.bloomMaxDeg, this.bloomDeg + def.bloomDeg);
    this.exhaustion = clamp01(this.exhaustion + CONDITION_RULES.exhaustionShotGain);

    let o;
    if (this.adsT > 0.55) {
      const m = this.rig.getMuzzleWorldPos(this._mvTmp || (this._mvTmp = new THREE.Vector3()));
      o = [m.x, m.y, m.z];
    } else {
      const cp = this.camera.position;
      o = [cp.x, cp.y, cp.z];
    }
    this.effects.shoot({
      o, d: [fwd.x, fwd.y, fwd.z], w: tid,
      spread: pellets[0], pellets,
    }, { local: true });

    sfx.fire(tid);
    this.shakeView(def.kickDeg);

    if (mode === 'pump') this.rig.pumpAnim();
    if (mode === 'bolt') this.rig.boltAnim();
    if (a.mag === 0) {
      const generation = this._loopGeneration;
      setTimeout(() => {
        if (
          generation === this._loopGeneration &&
          this.running && this.alive && WEAPON_IDS[this.slot] === tid
        ) {
          this.startReload(nowMs());
        }
      }, 240);
    }
  }

  shakeView(kick) {
    const kp = (kick.pitch * (Math.PI / 180)) * (this.adsT > 0.6 ? 0.55 : 1);
    const ky = (kick.yaw * (Math.PI / 180)) * (Math.random() * 2 - 1) * (this.adsT > 0.6 ? 0.5 : 1);
    this.recoilPitch += kp;
    this.recoilYaw += ky;
  }

  consumeLatestAuthoritativeState() {
    const snapshots = this.net?.latestSnapshots;
    const latest = Array.isArray(snapshots) && snapshots.length
      ? snapshots[snapshots.length - 1]
      : null;
    this.consumeAuthoritativeSnapshot(latest);
  }

  consumeAuthoritativeSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    if (
      Number.isFinite(snapshot.snapSeq) &&
      this._lastConsumedSnapSeq !== null &&
      snapshot.snapSeq <= this._lastConsumedSnapSeq
    ) {
      return;
    }
    if (Number.isFinite(snapshot.snapSeq)) this._lastConsumedSnapSeq = snapshot.snapSeq;

    const players = Array.isArray(snapshot.players) ? snapshot.players : [];
    const presentedPlayers = Object.freeze(players.map((row) => Object.freeze({
      ...row,
      local: row.id === this.myId,
    })));
    const self = players.find((row) => row.id === this.myId) || null;
    const match = snapshot.match && typeof snapshot.match === 'object'
      ? snapshot.match
      : null;
    this.matchState = match;
    this.selfRow = self;
    this.playersCache = presentedPlayers;
    this.serverNow = Number.isFinite(snapshot.serverNow) ? snapshot.serverNow : null;

    const events = Array.isArray(snapshot.events) ? snapshot.events : [];
    const localDeathEvent = events.find((event) =>
      event?.kind === 'kill' && event.victim === this.myId) ||
      events.find((event) => event?.kind === 'die' && event.id === this.myId) ||
      null;
    let localHitEvent = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event?.kind === 'hit' && event.victim === this.myId) {
        localHitEvent = event;
        break;
      }
    }
    this.reconcileSelf(self, snapshot.snapSeq, {
      deathEvent: localDeathEvent,
      impact: localHitEvent,
    });
    this.applyConfirmedPurchase(self);
    this.hud.setMatchState(
      match,
      self,
      presentedPlayers,
      this.serverNow,
    );
    this.syncBuyMenuState();
  }

  isAuthoritativeFireAllowed() {
    if (
      !this._gameplayInputEnabled ||
      !this.alive ||
      this.selfRow?.state !== 'alive'
    ) {
      return false;
    }
    const match = this.matchState;
    if (!match) return false;
    if (match.mode === 'fun') return true;
    if (match.mode === 'tdm' || match.mode === 'snd') return match.phase === 'live';
    return false;
  }

  isAuthoritativeInteractAllowed() {
    return !!(
      this._gameplayInputEnabled && this.alive &&
      this.matchState?.mode === 'snd' && this.matchState.phase === 'live' &&
      this.selfRow?.state === 'alive'
    );
  }

  // ------------------------------------------------------------------ loop

  /** Debug-mode: record the phase where a frame threw so diagnostics can
   *  surface it (loop schedules the next frame first, so an exception would
   *  otherwise repeat invisibly every frame). */
  __phaseErr(phase, e) {
    this.__phases = this.__phases || {};
    const rec = String(e && e.message || e) + ' @' + phase;
    if ((this.__phases[phase] || 0) < 5) {
      this.__phases[phase] = (this.__phases[phase] || 0) + 1;
      console.error('[vb]', rec);
    }
  }

  loop(generation) {
    if (!this.running || generation !== this._loopGeneration) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = 0;
      this.loop(generation);
    });
    const dt = Math.min(0.05, this.clock.getDelta());
    const now = nowMs();
    // Tick listeners apply each authoritative state exactly once on arrival.
    this.syncGameplayInput();

    this.readLook();
    this.sampleMovement();
    const climbAxis = this.keys.forward && !this.keys.back
      ? 1
      : (this.keys.back && !this.keys.forward ? -1 : 0);
    const jumped = this.alive
      ? this.physics.step(
        dt,
        this.wishDir,
        moveSpeedFor(this.keys, this.wantAds),
        this.keys.jump,
        climbAxis,
      )
      : false;
    this.currentSpeedXZ = Math.hypot(this.physics.vel.x, this.physics.vel.z);
    this.updateConditionEstimates(dt, jumped);
    this.tickReload(now);
    try { this.tryFire(now); } catch (e) { this.__phaseErr('tryFire', e); }
    this.sendInputMaybe(dt);

    // recover recoil + bloom
    const def = this.weaponDef;
    this.recoilPitch *= Math.max(0, 1 - 11 * dt);
    this.recoilYaw *= Math.max(0, 1 - 9 * dt);
    this.bloomDeg = Math.max(0, this.bloomDeg - def.bloomRecover * dt);

    // ADS ramp
    this.adsT += ((this.wantAds && this.alive && !this.reloadState) ? 1 : -1) * dt / Math.max(0.08, def.adsTime);
    this.adsT = Math.max(0, Math.min(1, this.adsT));
    this.scopeActive = this.alive && def.id === 'sniper' && this.adsT >= 0.72;
    if (this.rig && this.rig.root) this.rig.root.visible = !this.scopeActive;

    this.updateCamera(dt);
    updateFirstPersonBody(
      this.ownBody,
      dt,
      this.physics.pos,
      this.view.yaw,
      this.currentSpeedXZ,
      !!this.physics._crouching,
      this.alive,
      this.deathElapsed,
      this.deathSide,
      this.scopeActive,
    );
    try {
      this.rig.update(dt, {
        speed: this.currentSpeedXZ,
        grounded: this.physics.grounded,
        mouseDX: this.lookVelX,
        mouseDY: this.lookVelY,
        isSprinting: !this.wantAds && this.keys.sprint && this.currentSpeedXZ > 4.6,
        panic: this.panic,
        exhaustion: this.exhaustion,
      });
      this.rig.ads(this.adsT);
      this.effects.update(dt);
      this.worldview.update(dt);
    } catch (e) { this.__phaseErr('fx/rig', e); }
    try {
      const snapView = this.net.interpolate(performance.now(), 100);
      if (snapView) this.updateAvatars(snapView.players, dt, now);
    } catch (e) { this.__phaseErr('net/interp', e); }


    // HUD aggregate
    const a = this.ammo[WEAPON_IDS[this.slot]];
    const crosshairConeDeg = currentConeDeg(
      def,
      this.bloomDeg,
      this.currentSpeedXZ,
      this.adsT,
      this.panic,
      this.exhaustion,
      !!this.physics._crouching,
      this.pain,
    );
    this.hud.setState({
      hp: this.myHp != null ? this.myHp : 100,
      mag: a.mag, reserve: a.reserve,
      wname: def.name, wid: WEAPON_IDS[this.slot],
      crosshairConeDeg,
      panic: this.panic,
      pain: this.pain,
      crouching: !!this.physics._crouching,
      spawnProtected: this.spawnProtected,
      reloading01: this.reloadState ? (now - (this.reloadState.until - this.reloadState.dur)) / this.reloadState.dur : null,
      adsT01: this.adsT,
      yawDeg: ((-this.view.yaw * 180 / Math.PI) % 360 + 360) % 360,
      alive: this.alive,
      zoom: def.zoom,
    });
    // TAB scoreboard refresh (~250ms throttle)
    if (now - (this._sbAt || 0) >= 250 && this.playersCache.length) {
      this._sbAt = now;
      this.hud.setPlayers(this.playersCache);
    }


    // audio listener
    const f = fwdFromAngles(this.view.yaw, this.view.pitch);
    sfx.setListener({ fwd: [f.x, f.y, f.z], pos: [this.camera.position.x, this.camera.position.y, this.camera.position.z] });

    this.renderer.render(this.worldview.scene, this.camera);
  }

  readLook() {
    const delta = this.input.consumeDelta();
    this.lookVelX = delta.dx; this.lookVelY = delta.dy;
    if (!this.alive) return;
    // Canonical convention (netclient + server agree): yaw=0 faces -Z,
    // +yaw turns LEFT, +pitch looks UP. fwd=(-sin(yaw)cosP, sinP, -cos(yaw)cosP).
    // input.js already scales movement by this.input.sens — do NOT rescale here.
    this.view.yaw -= delta.dx;
    this.view.pitch -= delta.dy;
    this.view.pitch = clampPitch(this.view.pitch);
  }

  sampleMovement() {
    const inp = this.input;
    this.keys = inp.getKeys();
    if (inp.consumeBuyMenuRequest()) {
      this.toggleBuyMenuFromInput();
      if (this.hud.isBuyMenuOpen()) return;
    }
    this.wantAds = !!inp.wantAdsHeld;
    const sw = inp.consumeWeaponSwitch();
    if (sw) this.cycleWeapon(sw);
    const num = inp.consumeWeaponSlot();
    if (num != null) this.wantSwitchTo(num);
    if (inp.consumeLastWeaponRequest()) this.wantSwitchTo(this.lastSlot);

    if (this.keys.reload && this.alive) this.startReload(nowMs());

    // wish dir from canonical yaw: fwdH=(-sinY,-cosY), rightH=(cosY,-sinY)
    const k = this.keys;
    let fz = (k.forward ? 1 : 0) - (k.back ? 1 : 0);
    let fx = (k.right ? 1 : 0) - (k.left ? 1 : 0);
    const sin = Math.sin(this.view.yaw), cos = Math.cos(this.view.yaw);
    let wx = fz * -sin + fx * cos;
    let wz = fz * -cos + fx * -sin;
    const len = Math.hypot(wx, wz);
    this.wishDir = len > 0 ? { x: wx / len, z: wz / len } : { x: 0, z: 0 };
    const fireTap = inp.consumeFireTap();
    const fireAllowed = this.isAuthoritativeFireAllowed();
    if (fireTap && fireAllowed) this.fireTapLatched = true;
    if (!fireAllowed) this.fireTapLatched = false;
    this.pendingShotIntent = {
      tap: fireAllowed && fireTap,
      held: fireAllowed && !!inp.wantFireHeld,
    };
    this.physics._crouching = !!k.crouch;
  }
  updateConditionEstimates(dt, jumped = false) {
    if (!this.alive) return;
    if (jumped) {
      this.exhaustion = clamp01(this.exhaustion + CONDITION_RULES.exhaustionJumpGain);
    }

    const hp01 = clamp01((Number.isFinite(this.myHp) ? this.myHp : 100) / 100);
    const missingHealth = 1 - hp01;
    const panicFloor = missingHealth * CONDITION_RULES.panicLowHpFloor;
    this.panic = clamp01(Math.max(
      panicFloor, this.panic - CONDITION_RULES.panicDecayPerS * dt,
    ));
    const painFloor = missingHealth * CONDITION_RULES.painLowHpFloor;
    this.pain = clamp01(Math.max(
      painFloor, this.pain - CONDITION_RULES.painDecayPerS * dt,
    ));
    const sprinting = !!(
      this.keys.sprint && this.keys.forward && !this.keys.back &&
      !this.keys.crouch && !this.wantAds
    );
    const exhaustionRate = sprinting
      ? CONDITION_RULES.exhaustionSprintPerS
      : -CONDITION_RULES.exhaustionRecoverPerS;
    this.exhaustion = clamp01(this.exhaustion + exhaustionRate * dt);
  }


  sendInputMaybe(dt) {
    const interval = 1 / SEND_HZ;
    this.sendAccum += dt;
    if (this.sendAccum < interval) return;
    this.sendAccum %= interval;
    const k = this.keys || {};
    const wantFire = !!(this.isAuthoritativeFireAllowed() && this.pendingShotIntent &&
      (this.pendingShotIntent.held || this.fireTapLatched));
    const sent = this.net.sendInput({
      keys: {
        forward: !!k.forward, back: !!k.back, left: !!k.left, right: !!k.right,
        jump: !!k.jump, sprint: !!k.sprint, crouch: !!k.crouch,
        interact: !!(this.isAuthoritativeInteractAllowed() && k.interact),
      },
      yaw: this.view ? this.view.yaw : 0,
      pitch: this.view ? this.view.pitch : 0,
      wantFire,
      weapon: this.slot,
      wantAds: this._gameplayInputEnabled && this.wantAds,
      reload: this._gameplayInputEnabled && !!this.reloadState,
    });
    if (sent && wantFire) this.fireTapLatched = false;
  }

  reconcileSelf(me, snapSeq, context = null) {
    if (!me) return;
    if (Number.isFinite(snapSeq)) {
      if (this._lastReconciledSnapSeq !== null && snapSeq <= this._lastReconciledSnapSeq) return;
      this._lastReconciledSnapSeq = snapSeq;
    }

    const hp = Number.isFinite(me.hp) ? me.hp : this.myHp;
    if (Number.isFinite(me.panic)) this.panic = clamp01(me.panic);
    if (Number.isFinite(me.exhaustion)) this.exhaustion = clamp01(me.exhaustion);
    if (Number.isFinite(me.pain)) this.pain = clamp01(me.pain);
    this.spawnProtected = !!me.spawnProtected;
    const authoritativeAlive = me.state === 'alive' && hp > 0;
    if (authoritativeAlive && !this.alive) {
      this.onRespawned(me);
      if (Number.isFinite(me.pain)) this.pain = clamp01(me.pain);
      this.spawnProtected = !!me.spawnProtected;
    } else if (!authoritativeAlive && this.alive) {
      const deathEvent = context?.deathEvent;
      this.onDeath(deathEvent?.killer || null, {
        impact: context?.impact || null,
        headshot: !!(deathEvent?.hs || context?.impact?.hs),
      });
    }
    this.myHp = hp;

    if (Array.isArray(me.mag) && Array.isArray(me.reserve)) {

      for (let i = 0; i < WEAPON_IDS.length; i++) {
        const mag = me.mag[i];
        const reserve = me.reserve[i];
        if (Number.isFinite(mag)) this.ammo[WEAPON_IDS[i]].mag = mag;
        if (Number.isFinite(reserve)) this.ammo[WEAPON_IDS[i]].reserve = reserve;
      }
    }
    if (
      this.matchState?.mode === 'snd' && Array.isArray(me.owned) &&
      !me.owned.includes(WEAPON_IDS[this.slot]) &&
      Number.isInteger(me.weapon) && WEAPON_IDS[me.weapon]
    ) {
      this.wantSwitchTo(me.weapon);
    }

    if (!me.reloading) {
      this.reloadState = null;
    } else if (!this.reloadState && this.alive) {
      const def = this.weaponDef;
      const dur = def.reloadTime * 1000;
      this.reloadState = {
        until: nowMs() + dur, dur, type: 'magswap', weapon: def.id,
      };
      this.rig.reload(dur / 1000, 'magswap');
    }

    if (![me.x, me.y, me.z].every(Number.isFinite)) return;
    const p = this.physics.pos;
    const dx = me.x - p.x, dy = me.y - p.y, dz = me.z - p.z;
    const err = Math.hypot(dx, dy, dz);
    if (err > 3.2) {
      p.x = me.x;
      p.y = me.y;
      p.z = me.z;
    } else if (err > 0.12) {
      const k = 0.18;
      p.x += dx * k;
      p.y += dy * k;
      p.z += dz * k;
    }
  }
  updateCamera(dt) {
    const p = this.physics.pos;
    this.camera.position.set(p.x, this.physics.eyeY(), p.z);
    if (this.alive) {
      this.deathElapsed = 0;
      this.deathRoll = 0;
      this.deathPitch = 0;
    } else {
      this.deathElapsed = Math.min(1.4, this.deathElapsed + dt);
      const impactT = smooth01(this.deathElapsed / 0.18);
      const collapseT = smooth01(this.deathElapsed / 0.86);
      const settleT = smooth01(this.deathElapsed / 1.22);
      this.camera.position.y -= 1.48 * collapseT + 0.12 * impactT;
      this.deathPitch = -0.18 * impactT - 0.66 * collapseT + 0.08 * settleT;
      this.deathRoll = this.deathSide * (0.26 * impactT + 1.12 * collapseT);
    }

    // THREE YXZ: rotation.y=yaw (0 => facing -Z, matches canonical fwd), rotation.x=pitch (+up)
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(
      (this.view ? this.view.pitch : 0) + this.recoilPitch + this.deathPitch,
      (this.view ? this.view.yaw : 0) + this.recoilYaw,
      this.deathRoll,
    );
    const def = this.weaponDef;
    const targetFov = this.baseFov + (def.adsFov - this.baseFov) * easeOut(this.adsT) +
      (!this.wantAds && this.keys && this.keys.sprint && this.currentSpeedXZ > 5 ? 4 : 0);
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 14);
    this.camera.updateProjectionMatrix();
  }

  hitAvatar(id, ev) {
    if (id === this.myId) return;
    const now = nowMs();
    boundedMapSet(this.remoteImpacts, id, { ev, until: now + 2200 });
    const av = this.avatars.get(id);
    if (!av) {
      boundedMapSet(this.pendingAvatarHits, id, { ev, until: now + 650 });
      return;
    }
    av.lastImpact = { ev, until: now + 2200 };
    if (!av.alive) return;
    av.hitT = 0.18;
    av.hitSide = (hashInt(String(ev && ev.attacker || id)) & 1) ? 1 : -1;
  }

  beginRemoteDeath(id) {
    if (id === this.myId) return;
    const now = nowMs();
    const av = this.avatars.get(id);
    if (!av) {
      boundedMapSet(this.pendingRemoteDeaths, id, { until: now + 2200 });
      return;
    }
    const stored = this.remoteImpacts.get(id);
    const recentAvatarImpact = av.lastImpact?.until >= now ? av.lastImpact.ev : null;
    const impact = stored?.ev || recentAvatarImpact || {
      vx: av.group.position.x,
      vy: av.group.position.y + 1.08,
      vz: av.group.position.z,
      hs: false,
    };
    if (!beginAvatarDeath(av, now, impact)) return;
    this.pendingRemoteDeaths.delete(id);
    this.effects?.gore(impact, { lethal: true, local: false });
  }

  resetRemoteAvatar(id, ev) {
    this.pendingAvatarHits.delete(id);
    this.pendingRemoteDeaths.delete(id);
    this.remoteImpacts.delete(id);
    const av = this.avatars.get(id);
    if (!av) return;
    resetAvatarPose(av);
    av.lastHp = null;
    av.lastImpact = null;
    av.updateHealth(1);
    if (ev && [ev.x, ev.y, ev.z].every(Number.isFinite)) {
      av.px = ev.x;
      av.pz = ev.z;
      av.group.position.set(ev.x, ev.y, ev.z);
    }
  }

  updateAvatars(remotes, dt, now) {
    const scene = this.worldview.scene;
    this.dyingAvatars = 0;
    this.runningAvatars = 0;
    this.maxAvatarSpeed = 0;
    for (const [id, pending] of this.pendingAvatarHits) {
      if (pending.until < now) this.pendingAvatarHits.delete(id);
    }
    for (const [id, pending] of this.remoteImpacts) {
      if (pending.until < now) this.remoteImpacts.delete(id);
    }
    for (const [id, pending] of this.pendingRemoteDeaths) {
      if (pending.until < now) this.pendingRemoteDeaths.delete(id);
    }
    for (const [id, av] of this.avatars) {
      if (id === this.myId || !remotes.has(id)) {
        scene.remove(av.group);
        this.avatars.delete(id);
        this.pendingAvatarHits.delete(id);
        this.pendingRemoteDeaths.delete(id);
        this.remoteImpacts.delete(id);
        disposeAvatar(av);
      }
    }

    for (const r of remotes.values()) {
      if (r.id === this.myId) continue;
      let av = this.avatars.get(r.id);
      if (!av) {
        av = makeAvatar(r.id, r.name, r.team);
        av.px = r.x;
        av.pz = r.z;
        av.group.position.set(r.x, r.y, r.z);
        scene.add(av.group);
        this.avatars.set(r.id, av);
      }
      setAvatarTeam(av, r.team);
      const pending = this.pendingAvatarHits.get(r.id);
      if (pending) {
        this.pendingAvatarHits.delete(r.id);
        if (pending.until >= now) this.hitAvatar(r.id, pending.ev);
      }
      const pendingDeath = this.pendingRemoteDeaths.get(r.id);
      if (pendingDeath?.until >= now && av.alive) this.beginRemoteDeath(r.id);

      const rowAlive = r.state === 'alive';
      const alive = rowAlive && now >= av.deathForcedUntil;
      if (!alive) {
        if (av.alive) this.beginRemoteDeath(r.id);
        av.deathT = Math.min(1.5, av.deathT + dt);
        const t = smooth01(av.deathT / 1.28);
        const fade = 1 - smooth01((t - 0.72) / 0.28);
        av.group.visible = av.deathT < 1.42;
        if (av.group.visible) {
          this.dyingAvatars++;
          updateAvatarDeath(av, dt, t);
        }
        av.group.position.set(r.x, r.y, r.z);
        av.group.rotation.set(0, r.yaw, 0);
        setAvatarOpacity(av, fade);
        continue;
      }

      if (!av.alive) resetAvatarPose(av);
      av.alive = true;
      av.group.visible = true;
      av.group.rotation.set(0, r.yaw, 0);
      av.group.scale.set(1, 1, 1);
      setAvatarOpacity(av, 1);

      const rawSpeed = av.motionSeeded && dt > 0
        ? Math.hypot(r.x - av.px, r.z - av.pz) / dt
        : 0;
      const speedBlend = 1 - Math.exp(-dt * 10);
      av.speedEst += (Math.min(9, rawSpeed) - av.speedEst) * speedBlend;
      av.motionSeeded = true;
      av.px = r.x;
      av.pz = r.z;
      this.maxAvatarSpeed = Math.max(this.maxAvatarSpeed, av.speedEst);
      const stride = Math.min(1, av.speedEst / 5.8);
      if (stride > 0.03) {
        av.runPhase += dt * (5.2 + av.speedEst * 1.25);
        this.runningAvatars++;
      }

      const swing = Math.sin(av.runPhase) * stride;
      const cadence = Math.abs(Math.sin(av.runPhase * 2));
      const poseBlend = 1 - Math.exp(-dt * (9 + stride * 5));
      const hit01 = av.hitT > 0 ? av.hitT / 0.18 : 0;
      av.hitT = Math.max(0, av.hitT - dt);
      const flinch = av.hitSide * hit01 * 0.2;

      av.group.position.set(r.x, r.y + cadence * stride * 0.045, r.z);
      av.lLeg.rotation.x += (swing * 0.78 - av.lLeg.rotation.x) * poseBlend;
      av.rLeg.rotation.x += (-swing * 0.78 - av.rLeg.rotation.x) * poseBlend;
      av.lArm.rotation.x += (-swing * 0.68 - av.lArm.rotation.x) * poseBlend;
      av.rArm.rotation.x += (swing * 0.68 - av.rArm.rotation.x) * poseBlend;
      av.lArm.rotation.z += (-0.08 - av.lArm.rotation.z) * poseBlend;
      av.rArm.rotation.z += (0.08 - av.rArm.rotation.z) * poseBlend;
      av.lElbow.rotation.x += (-0.34 - Math.max(0, swing) * 0.3 - av.lElbow.rotation.x) * poseBlend;
      av.rElbow.rotation.x += (-0.46 - Math.max(0, -swing) * 0.3 - av.rElbow.rotation.x) * poseBlend;
      av.torso.rotation.x += (stride * 0.16 - av.torso.rotation.x) * poseBlend;
      av.torso.rotation.z += ((-swing * stride * 0.055) + flinch - av.torso.rotation.z) * poseBlend;
      av.hips.rotation.z += (swing * stride * 0.045 - av.hips.rotation.z) * poseBlend;
      av.head.rotation.x += (r.pitch * 0.7 - hit01 * 0.1 - av.head.rotation.x) * poseBlend;
      av.head.rotation.z += (-flinch * 0.7 - av.head.rotation.z) * poseBlend;
      setAvatarFlash(av, hit01);

      if (r.hp != null && r.hp !== av.lastHp) {
        av.lastHp = r.hp;
        av.updateHealth(r.hp / 100);
      }
    }
  }
}

// ---------------------------------------------------------------- helpers

const MAX_REMOTE_RECORDS = 32;

function nowMs() { return performance.now(); }
function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
function clamp01(v) { return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0)); }
function clampPitch(value) {
  const limit = Math.PI / 2 - 0.01;
  return Math.max(-limit, Math.min(limit, Number.isFinite(value) ? value : 0));
}
function smooth01(v) {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
}
function clampNumber(value, min, max, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function readStoredNumber(key, fallback, min, max) {
  try {
    return clampNumber(localStorage.getItem(key), min, max, fallback);
  } catch (_) {
    return fallback;
  }
}
function validImpact(ev) {
  return !!ev && Number.isFinite(Number(ev.vx)) &&
    Number.isFinite(Number(ev.vy)) && Number.isFinite(Number(ev.vz));
}
function impactPosition(ev) {
  return validImpact(ev) ? [Number(ev.vx), Number(ev.vy), Number(ev.vz)] : null;
}
function boundedMapSet(map, key, value) {
  if (!map.has(key) && map.size >= MAX_REMOTE_RECORDS) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

/** Canonical look convention (client + server + bots): yaw=0 faces -Z, +yaw LEFT,
 *  +pitch UP. fwd = (-sin(yaw)*cos(pitch), sin(pitch), -cos(yaw)*cos(pitch)). */
export function fwdFromAngles(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

export function currentConeDeg(
  def,
  bloomDeg,
  speedXZ,
  adsT,
  panic = 0,
  exhaustion = 0,
  crouching = false,
  pain = 0,
) {
  return computeSpreadConeDeg(
    def,
    bloomDeg,
    speedXZ,
    adsT,
    panic,
    exhaustion,
    crouching,
    pain,
  );
}

function makeFirstPersonBody() {
  const group = new THREE.Group();
  group.name = 'first-person-body';
  group.rotation.order = 'YXZ';
  const cloth = new THREE.MeshLambertMaterial({ color: 0x44515e });
  const armor = new THREE.MeshLambertMaterial({ color: 0x202831 });
  const bootMaterial = new THREE.MeshLambertMaterial({ color: 0x0b0f14 });
  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.22, 0.32), armor);
  hips.position.set(0, 0.84, -0.1);
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.3, 0.34), cloth);
  torso.position.set(0, 1.1, -0.16);
  const thighGeometry = new THREE.BoxGeometry(0.21, 0.42, 0.25);
  const shinGeometry = new THREE.BoxGeometry(0.19, 0.4, 0.22);
  const bootGeometry = new THREE.BoxGeometry(0.21, 0.16, 0.38);

  function makeLeg(side) {
    const leg = new THREE.Group();
    leg.position.set(side * 0.16, 0.78, 0);
    const thigh = new THREE.Mesh(thighGeometry, cloth);
    thigh.position.y = -0.2;
    const knee = new THREE.Group();
    knee.position.y = -0.39;
    const shin = new THREE.Mesh(shinGeometry, armor);
    shin.position.y = -0.19;
    const boot = new THREE.Mesh(bootGeometry, bootMaterial);
    boot.position.set(0, -0.42, -0.08);
    knee.add(shin, boot);
    leg.add(thigh, knee);
    return { leg, knee, boot };
  }

  const left = makeLeg(-1);
  const right = makeLeg(1);
  group.add(hips, torso, left.leg, right.leg);
  const body = {
    group,
    hips,
    torso,
    left,
    right,
    phase: 0,
    crouch: 0,
  };
  resetFirstPersonBody(body);
  return body;
}

function resetFirstPersonBody(body) {
  if (!body) return;
  body.phase = 0;
  body.crouch = 0;
  body.group.visible = true;
  body.group.rotation.set(0, 0, 0);
  body.group.scale.set(1, 1, 1);
  body.hips.position.set(0, 0.84, -0.1);
  body.hips.rotation.set(0, 0, 0);
  body.torso.position.set(0, 1.1, -0.16);
  body.torso.rotation.set(0, 0, 0);
  body.left.leg.position.set(-0.16, 0.78, 0);
  body.right.leg.position.set(0.16, 0.78, 0);
  body.left.leg.rotation.set(0, 0, 0);
  body.right.leg.rotation.set(0, 0, 0);
  body.left.knee.rotation.set(0, 0, 0);
  body.right.knee.rotation.set(0, 0, 0);
  body.left.boot.rotation.set(0, 0, 0);
  body.right.boot.rotation.set(0, 0, 0);
}

function updateFirstPersonBody(
  body,
  dt,
  pos,
  yaw,
  speed,
  crouching,
  alive,
  deathElapsed,
  deathSide,
  scopeActive,
) {
  if (!body || !pos) return;
  body.group.visible = !scopeActive;
  body.group.position.set(pos.x, pos.y, pos.z);
  const stride = alive ? Math.min(1, Math.max(0, speed) / 5.8) : 0;
  if (stride > 0.025) body.phase += dt * (5.4 + speed * 1.15);
  body.crouch += ((crouching && alive ? 1 : 0) - body.crouch) *
    Math.min(1, dt * 13);
  const crouch = crouching && alive ? 1 : body.crouch;
  const swing = Math.sin(body.phase) * stride;
  const bounce = Math.abs(Math.sin(body.phase * 2)) * stride * 0.025;

  if (!alive) {
    const death = smooth01(deathElapsed / 0.9);
    body.group.position.y -= death * 0.14;
    body.group.rotation.set(death * 1.08, yaw, deathSide * death * 0.92);
    body.torso.rotation.x = death * 0.28;
    body.hips.rotation.z = deathSide * death * 0.2;
    body.left.leg.rotation.x = -death * 0.5;
    body.right.leg.rotation.x = death * 0.72;
    body.left.knee.rotation.x = death * 0.34;
    body.right.knee.rotation.x = death * 0.62;
    return;
  }

  body.group.rotation.set(0, yaw, 0);
  body.hips.position.y = 0.84 - crouch * 0.34 + bounce;
  body.torso.position.y = 1.1 - crouch * 0.42 + bounce;
  body.torso.rotation.x = crouch * 0.12;
  body.hips.rotation.z = swing * stride * 0.045;
  body.left.leg.position.y = 0.78 - crouch * 0.28;
  body.right.leg.position.y = 0.78 - crouch * 0.28;
  body.left.leg.rotation.x = swing * 0.72 - crouch * 0.58;
  body.right.leg.rotation.x = -swing * 0.72 - crouch * 0.58;
  body.left.knee.rotation.x = crouch * 1.02 + Math.max(0, -swing) * 0.32;
  body.right.knee.rotation.x = crouch * 1.02 + Math.max(0, swing) * 0.32;
}

function disposeObjectTree(root) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  root.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    const list = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of list) {
      if (!material) continue;
      materials.add(material);
      if (material.map) textures.add(material.map);
    }
  });
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}

function disposeAvatar(av) {
  disposeObjectTree(av.group);
}
function hashInt(value) {
  const s = String(value);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

function hashHue(id) {
  return hashInt(id) % 360;
}
function setAvatarTeam(av, team) {
  const normalized = team === 'alpha' || team === 'bravo' ? team : null;
  if (av.team === normalized) return;
  av.team = normalized;
  const palette = normalized ? TEAM_AVATAR_COLORS[normalized] : null;
  if (palette) {
    av.suitMaterial.color.setHex(palette.suit);
    av.darkMaterial.color.setHex(palette.dark);
    return;
  }
  const hue = hashHue(av.id);
  av.suitMaterial.color.setHSL(hue / 360, 0.32, 0.42);
  av.darkMaterial.color.setHSL(hue / 360, 0.25, 0.2);
}

function setAvatarOpacity(av, opacity) {
  for (let i = 0; i < av.fadeMaterials.length; i++) av.fadeMaterials[i].opacity = opacity;
}

function setAvatarFlash(av, amount) {
  const flash = clamp01(amount);
  for (let i = 0; i < av.flashMaterials.length; i++) {
    av.flashMaterials[i].emissive.setRGB(flash * 0.9, flash * 0.08, flash * 0.04);
  }
}

function resetAvatarPose(av) {
  av.alive = true;
  av.deathT = 0;
  av.deathForcedUntil = 0;
  av.hitT = 0;
  av.speedEst = 0;
  av.runPhase = 0;
  av.lastImpact = null;
  av.motionSeeded = false;
  av.group.visible = true;
  av.group.rotation.set(0, 0, 0);
  av.group.scale.set(1, 1, 1);
  av.torso.position.set(0, 1.18, 0);
  av.torso.rotation.set(0, 0, 0);
  av.hips.position.set(0, 0.84, 0);
  av.hips.rotation.set(0, 0, 0);
  av.head.position.set(0, 1.66, 0);
  av.head.rotation.set(0, 0, 0);
  av.lLeg.position.set(-0.16, 0.73, 0);
  av.lLeg.rotation.set(0, 0, 0);
  av.rLeg.position.set(0.16, 0.73, 0);
  av.rLeg.rotation.set(0, 0, 0);
  av.lArm.position.set(-0.41, 1.45, 0);
  av.lArm.rotation.set(0, 0, -0.08);
  av.rArm.position.set(0.41, 1.45, 0);
  av.rArm.rotation.set(0, 0, 0.08);
  av.lElbow.rotation.set(-0.34, 0, 0);
  av.rElbow.rotation.set(-0.46, 0, 0);
  if (av.gunStub) {
    av.gunStub.position.set(0.22, 1.2, -0.4);
    av.gunStub.rotation.set(0, 0, 0);
  }
  if (av.tag) av.tag.visible = true;
  if (av.hpSpr) av.hpSpr.visible = true;
  for (const limb of av.limbStates || []) {
    limb.object.visible = true;
    limb.object.position.copy(limb.basePosition);
    limb.object.rotation.copy(limb.baseRotation);
    limb.velocity.set(0, 0, 0);
    limb.angular.set(0, 0, 0);
  }
  setAvatarOpacity(av, 1);
  setAvatarFlash(av, 0);
}

function beginAvatarDeath(av, now, impact = null) {
  if (!av.alive) return false;
  av.alive = false;
  av.deathT = 0;
  av.hitT = 0;
  av.speedEst = 0;
  av.motionSeeded = false;
  av.lastImpact = impact ? { ev: impact, until: now + 2200 } : av.lastImpact;
  av.deathForcedUntil = Math.max(av.deathForcedUntil, now + 1420);
  if (av.tag) av.tag.visible = false;
  if (av.hpSpr) av.hpSpr.visible = false;
  const headshot = !!impact?.hs;
  for (let i = 0; i < av.limbStates.length; i++) {
    const limb = av.limbStates[i];
    const seed = hashInt(`${av.id}|${i}|${headshot ? 1 : 0}`);
    const angle = (seed / 0xffffffff) * Math.PI * 2;
    const radial = 2.1 + ((seed >>> 8) & 255) / 255 * 1.9;
    const boost = headshot && i === 0 ? 1.85 : 1;
    limb.object.position.copy(limb.basePosition);
    limb.object.rotation.copy(limb.baseRotation);
    limb.velocity.set(
      Math.cos(angle) * radial * boost,
      (3.1 + ((seed >>> 16) & 255) / 255 * 2.8) * boost,
      Math.sin(angle) * radial * boost,
    );
    limb.angular.set(
      (((seed >>> 3) & 15) - 7.5) * 0.75,
      (((seed >>> 11) & 15) - 7.5) * 0.62,
      (((seed >>> 19) & 15) - 7.5) * 0.8,
    );
  }
  setAvatarFlash(av, 0);
  return true;
}

function updateAvatarDeath(av, dt, t) {
  av.torso.position.y = 1.18 - t * 0.56;
  av.torso.rotation.x = t * 1.08;
  av.torso.rotation.z = av.deathSide * t * 0.3;
  av.hips.position.y = 0.84 - t * 0.38;
  av.hips.rotation.x = t * 0.72;
  av.hips.rotation.z = av.deathSide * t * 0.22;
  if (av.gunStub) {
    av.gunStub.position.y = 1.2 - t * 0.58;
    av.gunStub.rotation.x = t * 0.9;
    av.gunStub.rotation.z = -av.deathSide * t * 0.48;
  }
  for (const limb of av.limbStates) {
    limb.velocity.y -= 11.8 * dt;
    limb.object.position.x += limb.velocity.x * dt;
    limb.object.position.y += limb.velocity.y * dt;
    limb.object.position.z += limb.velocity.z * dt;
    if (limb.object.position.y < limb.floorY) {
      limb.object.position.y = limb.floorY;
      if (limb.velocity.y < 0) limb.velocity.y *= -0.24;
      limb.velocity.x *= Math.max(0, 1 - dt * 7);
      limb.velocity.z *= Math.max(0, 1 - dt * 7);
    }
    limb.object.rotation.x += limb.angular.x * dt;
    limb.object.rotation.y += limb.angular.y * dt;
    limb.object.rotation.z += limb.angular.z * dt;
  }
}

function makeAvatar(id, name, team = null) {
  const g = new THREE.Group();
  const hue = hashHue(id);
  const suit = new THREE.MeshLambertMaterial({
    color: new THREE.Color().setHSL(hue / 360, 0.32, 0.42),
    transparent: true,
  });
  const dark = new THREE.MeshLambertMaterial({
    color: new THREE.Color().setHSL(hue / 360, 0.25, 0.2),
    transparent: true,
  });
  const visorMat = new THREE.MeshBasicMaterial({ color: 0x11141a, transparent: true });
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.62, 0.34), suit);
  torso.position.y = 1.18;
  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.22, 0.32), dark);
  hips.position.y = 0.84;

  const head = new THREE.Group();
  head.position.y = 1.66;
  const headBox = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.32, 0.34), suit);
  const helm = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.14, 0.38), dark);
  helm.position.y = 0.16;
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.07, 0.02), visorMat);
  visor.position.set(0, 0.02, -0.175);
  head.add(headBox, helm, visor);

  const lLeg = new THREE.Group();
  lLeg.position.set(-0.16, 0.73, 0);
  const lLegMesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.72, 0.24), dark);
  lLegMesh.position.y = -0.36;
  lLeg.add(lLegMesh);
  const rLeg = new THREE.Group();
  rLeg.position.set(0.16, 0.73, 0);
  const rLegMesh = lLegMesh.clone();
  rLegMesh.position.y = -0.36;
  rLeg.add(rLegMesh);

  const lArm = new THREE.Group();
  lArm.position.set(-0.41, 1.45, 0);
  const lUpper = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.48, 0.2), suit);
  lUpper.position.y = -0.23;
  const lElbow = new THREE.Group();
  lElbow.position.y = -0.45;
  const lFore = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.42, 0.18), dark);
  lFore.position.set(0, -0.19, -0.04);
  lElbow.add(lFore);
  lArm.add(lUpper, lElbow);

  const rArm = new THREE.Group();
  rArm.position.set(0.41, 1.45, 0);
  const rUpper = lUpper.clone();
  const rElbow = new THREE.Group();
  rElbow.position.y = -0.45;
  const rFore = lFore.clone();
  rElbow.add(rFore);
  rArm.add(rUpper, rElbow);

  const gunStub = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.72), dark);
  gunStub.position.set(0.22, 1.2, -0.4);

  // Floating nametag sprite: dark chip + stroked player name.
  const tagCv = document.createElement('canvas');
  tagCv.width = 256; tagCv.height = 64;
  const tc = tagCv.getContext('2d');
  const R = 14;
  tc.fillStyle = 'rgba(8,10,14,.55)';
  tc.beginPath();
  tc.moveTo(16 + R, 8);
  tc.arcTo(240, 8, 240, 56, R);
  tc.arcTo(240, 56, 16, 56, R);
  tc.arcTo(16, 56, 16, 8, R);
  tc.arcTo(16, 8, 240, 8, R);
  tc.closePath();
  tc.fill();
  tc.font = 'bold 28px Rajdhani, Arial Narrow, sans-serif';
  tc.textAlign = 'center';
  tc.textBaseline = 'middle';
  tc.lineWidth = 3;
  tc.strokeStyle = '#000';
  tc.strokeText(name, 128, 33);
  tc.fillStyle = '#fff';
  tc.fillText(name, 128, 33);
  const tagMat = new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(tagCv), transparent: true, depthTest: true,
  });
  const tag = new THREE.Sprite(tagMat);
  tag.scale.set(1.6, 0.4, 1);
  tag.position.set(0, 2.15, 0);

  // Health bar sprite, redrawn only when the row's hp changes.
  const hpCv = document.createElement('canvas');
  hpCv.width = 256; hpCv.height = 64;
  const hc = hpCv.getContext('2d');
  const hpTex = new THREE.CanvasTexture(hpCv);
  const hpMat = new THREE.SpriteMaterial({ map: hpTex, transparent: true, depthTest: true });
  const hpSpr = new THREE.Sprite(hpMat);
  hpSpr.scale.set(1.2, 0.3, 1);
  hpSpr.position.set(0, 1.95, 0);

  g.add(torso, hips, head, lLeg, rLeg, lArm, rArm, gunStub, tag, hpSpr);

  function updateHealth(t01) {
    hc.clearRect(0, 0, 256, 64);
    hc.fillStyle = '#10141a';
    hc.fillRect(0, 52, 256, 12);
    hc.fillStyle = t01 > 0.5 ? '#7fd069' : t01 > 0.25 ? '#ffb340' : '#ff3355';
    hc.fillRect(0, 52, Math.max(0, Math.round(256 * t01)), 12);
    hpTex.needsUpdate = true;
  }

  const av = {
    id,
    group: g,
    torso,
    hips,
    head,
    lLeg,
    rLeg,
    lArm,
    rArm,
    lElbow,
    rElbow,
    gunStub,
    tag,
    hpSpr,
    limbStates: [],
    speedEst: 0,
    runPhase: 0,
    px: 0,
    pz: 0,
    motionSeeded: false,
    lastHp: null,
    lastImpact: null,
    alive: true,
    deathT: 0,
    deathForcedUntil: 0,
    deathSide: (hashInt(id) & 1) ? 1 : -1,
    hitT: 0,
    hitSide: 1,
    team: undefined,
    suitMaterial: suit,
    darkMaterial: dark,
    fadeMaterials: [suit, dark, visorMat, tagMat, hpMat],
    flashMaterials: [suit, dark],
    updateHealth,
  };
  resetAvatarPose(av);
  av.limbStates = [
    { object: head, floorY: 0.18 },
    { object: lArm, floorY: 0.86 },
    { object: rArm, floorY: 0.86 },
    { object: lLeg, floorY: 0.72 },
    { object: rLeg, floorY: 0.72 },
  ].map((limb) => ({
    ...limb,
    basePosition: limb.object.position.clone(),
    baseRotation: limb.object.rotation.clone(),
    velocity: new THREE.Vector3(),
    angular: new THREE.Vector3(),
  }));
  setAvatarTeam(av, team);
  return av;
}
const game = new Game();

// Live diagnostics: with ?debug=1, mirror render stats into
// <html data-vb-stats="…"> every 300 ms so external tooling (and DevTools)
// can sample them; window.__vb stays available in-page as well.
window.__vb = {
  get stats() {
    const r = game.renderer.info;
    const hist = {};
    let sceneObjects = 0;
    if (game.worldview) {
      sceneObjects = game.worldview.scene.children.length;
      for (const c of game.worldview.scene.children) hist[c.type] = (hist[c.type] || 0) + 1;
    }
    const snaps = game.net.latestSnapshots || [];
    const sway = game.rig && game.rig._sway;
    const gunLag = sway && Number.isFinite(sway.x) && Number.isFinite(sway.y)
      ? { x: sway.x, y: sway.y }
      : null;
    const weapon = WEAPON_IDS[game.slot] || null;
    const def = weapon ? WEAPONS[weapon] : null;
    return {
      localId: game.myId,
      alive: game.alive,
      running: !!game.running,
      hp: game.myHp,
      feet: [game.physics.pos.x, game.physics.pos.y, game.physics.pos.z].every(Number.isFinite)
        ? { x: game.physics.pos.x, y: game.physics.pos.y, z: game.physics.pos.z }
        : null,
      crouching: !!game.physics._crouching,
      pitch: Number.isFinite(game.view.pitch) ? game.view.pitch : 0,
      yaw: Number.isFinite(game.view.yaw) ? game.view.yaw : 0,
      weapon,
      weaponWeightKg: def && Number.isFinite(def.weightKg) ? def.weightKg : null,
      gunLag,
      settingsOpen: !!game.hud.settingsOpen,
      volume: game.masterVolume,
      fov: game.baseFov,
      panic: game.panic,
      exhaustion: game.exhaustion,
      pain: game.pain,
      spawnProtected: game.spawnProtected,
      ownBodyVisible: !!game.ownBody?.group.visible,
      dyingAvatars: game.dyingAvatars,
      runningAvatars: game.runningAvatars,
      maxAvatarSpeed: game.maxAvatarSpeed,
      scopeActive: game.scopeActive,
      geometries: r.memory.geometries,
      textures: r.memory.textures,
      drawCalls: r.render.calls,
      sceneObjects,
      hist,
      ringLen: snaps.length,
      lastSnapAgeMs: snaps.length ? Math.round(performance.now() - (snaps[snaps.length - 1].recvLocalMs || 0)) : null,
      ping: Math.round(game.net.ping),
      avatars: game.avatars ? game.avatars.size : 0,
      chunks: game.worldview ? game.worldview.chunkStore.stats : null,
    };
  },
};

if (new URLSearchParams(location.search).has('debug')) {
  const root = document.documentElement;
  const seen = new Map();                       // uuid -> {type,name}
  let lastErrPayload = {};
  game._debugInterval = setInterval(() => {
    try {
      const st = window.__vb.stats;
      let fresh = 0;
      if (game.worldview) {
        for (const c of game.worldview.scene.children) {
          if (!seen.has(c.uuid)) { seen.set(c.uuid, c.type + '|' + (c.name || '')); fresh++; }
        }
      }
      // Aggregate identities of everything currently alive that was
      // created recently enough to still be "new" in our window.
      const kinds = {};
      for (const [, tag] of seen) kinds[tag] = (kinds[tag] || 0) + 1;
      const payload = { ...st, aliveKinds: Object.fromEntries(Object.entries(kinds).filter(([, n]) => n < 300)) };
      if (payload.hist && payload.hist.Group > 400 && game.worldview) {
        payload.phantoms = [];
        const kids = game.worldview.scene.children;
        let picked = 0;
        for (let i = 0; i < kids.length && picked < 5; i++) {
          const c = kids[i];
          if (c.type !== 'Group') continue;
          picked++;
          payload.phantoms.push({
            name: c.name || '(anon)',
            kids: c.children.length,
            kidTypes: c.children.slice(0, 6).map(k => k.type),
            visible: c.visible,
            pos: [Math.round(c.position.x * 10) / 10, Math.round(c.position.y * 10) / 10, Math.round(c.position.z * 10) / 10],
            parentType: c.parent ? c.parent.type : null,
            parentName: c.parent ? (c.parent.name || '(anon-parent)') : null,
          });
        }
      }
      lastErrPayload = { ...payload, phaseErrs: game.__phases || null };
      root.dataset.vbStats = JSON.stringify(lastErrPayload);
    } catch {}
  }, 500);
  game._onDebugError = (e) => {
    root.dataset.vbLastError = String((e && e.message) || e);
  };
  window.addEventListener('error', game._onDebugError, true);
}

game.start();
