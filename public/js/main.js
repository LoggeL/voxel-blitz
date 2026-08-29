// Voxel Blitz browser composition root. Mutable gameplay ownership lives in
// Session, LocalPlayer, WeaponState, AvatarRoster, and CombatFeedback.
import * as THREE from './vendor/three.module.js';
import { WEAPONS, WEAPON_IDS } from '../../shared/combatmath.js';
import { deserializeWorld, getBlock, getMapMeta, setBlock } from '../../shared/worlddata.js';
import { Input } from './engine/input.js';
import {
  CombatPostProcess,
  recommendedPostProcessPixelRatio,
} from './engine/combat-post-process.js';
import { WorldView } from './engine/worldview.js';
import { ViewmodelRig } from './guns/viewmodel.js';
import { WeaponState, shouldShowViewmodel } from './guns/weapon-state.js';
import { Effects, attachShellBridge } from './weapons/effects.js';
import { HUD } from './ui/hud.js';
import { sfx } from './audio/sfx.js';
import { Session } from './session/session.js';
import { LocalPlayer } from './player/local-player.js';
import { SpectatorCamera } from './player/spectator-camera.js';
import { AvatarRoster } from './avatar/avatar-roster.js';
import { CombatFeedback, applySnapshotBlocks } from './combat/feedback.js';
import { disposeFirstPersonBody, makeFirstPersonBody } from './player/first-person-body.js';
import { fwdFromAngles } from './util/look.js';
import { nowMs } from './util/math.js';

export { currentConeDeg, fwdFromAngles } from './util/look.js';

class Game {
  constructor() {
    const canvas = document.getElementById('game');
    this.input = new Input(canvas);
    this.hud = new HUD();
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.post = new CombatPostProcess(this.renderer, {
      enabled: !shaderDisabled,
      maxPixelRatio: recommendedPostProcessPixelRatio(Number(navigator.deviceMemory)),
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    });
    this.post.setSize(innerWidth, innerHeight, devicePixelRatio);
    this.camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 400);
    this.clock = new THREE.Clock();
    this.player = new LocalPlayer({ input: this.input });
    this.worldview = null;
    this.effects = null;
    this.rig = null;
    this.weapon = null;
    this.roster = null;
    this.feedback = null;
    this.spectator = null;
    this.ownBody = null;
    this.mapMeta = null;
    this.running = false;
    this.playersCache = Object.freeze([]);
    this.matchState = null;
    this.selfRow = null;
    this.serverNow = null;
    this._lastConsumedSnapSeq = null;
    this._pendingAuthoritativeSnapshots = [];
    this._postFrame = { time: 0, panic: 0, pain: 0, scopeActive: false };
    this._loopGeneration = 0;
    this._rafId = 0;
    this._sbAt = 0;
    this._disposed = false;

    const game = this;
    this._gameplay = Object.freeze({
      get running() { return game.running; },
      get alive() { return game.player.alive; },
      get matchState() { return game.matchState; },
      get selfRow() { return game.selfRow; },
    });
    this._world = Object.freeze({
      getBlock,
      setBlock,
      applyDeltas: (deltas) => this.worldview?.applyDeltas(deltas),
    });
    this.session = new Session({
      hud: this.hud,
      input: this.input,
      audio: sfx,
      gameplay: this._gameplay,
      callbacks: {
        onEnterLive: (payload) => this.bootLive(payload),
        onDisconnect: () => this.disposeLiveResources(),
        onGameplayEvent: (event) => this.feedback?.handleEvent(event),
        onTick: (snapshot, phase) => this.handleTick(snapshot, phase),
        onGameplayInputDisabled: () => {
          this.player.setGameplayInputEnabled(false);
          this.weapon?.clearIntents();
        },
        onGameplayInputEnabled: () => this.player.setGameplayInputEnabled(true),
        onResize: () => this.resize(),
        onTeardown: () => this.disposeTerminalResources(),
      },
    });
    this.camera.fov = this.session.baseFov;
    this.camera.updateProjectionMatrix();
  }

  get net() { return this.session.net; }
  get myId() { return this.session.myId; }

  start() { this.session.start(); }

  resize() {
    if (!this.renderer || !this.camera) return;
    this.renderer.setSize(innerWidth, innerHeight);
    this.post?.setSize(innerWidth, innerHeight, devicePixelRatio);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  async bootLive(payload) {
    const { net, welcome, mapBytes, mapMeta, isActive, showStatus, complete } = payload;
    if (!isActive()) return;
    this.mapMeta = mapMeta || getMapMeta(welcome.map);
    this.player.setMapMeta(this.mapMeta);
    this.player.setBaseFov(this.session.baseFov);
    this.player.respawn({ ...welcome.spawn, state: 'alive', hp: 100 }, { spawnProtected: false });

    deserializeWorld(mapBytes);
    for (const snapshot of net.latestSnapshots) {
      applySnapshotBlocks(snapshot, this._world);
      this.queueAuthoritativeSnapshot(snapshot);
    }
    if (!net.isOpen()) return this.session.handleDisconnect();

    showStatus('building voxel mesh…', 'ok');
    this.worldview = new WorldView({ getBlock }, this.mapMeta);
    await this.worldview.ready();
    if (!isActive()) return;
    if (!net.isOpen()) return this.session.handleDisconnect();
    this.worldview.setGameMode(welcome.gameMode);

    this.effects = new Effects(this.worldview.scene, this.camera, getBlock);
    this.worldview.scene.add(this.camera);
    this.ownBody = makeFirstPersonBody();
    this.worldview.scene.add(this.ownBody.group);
    this.player.setFirstPersonBody(this.ownBody);
    this.rig = new ViewmodelRig(this.camera);
    attachShellBridge(this.effects, this.rig);
    this.weapon = new WeaponState({
      rig: this.rig,
      audio: sfx,
      effects: this.effects,
      network: {
        isCurrentGeneration: (generation) => generation === this._loopGeneration,
        isRunning: () => this.running,
      },
      feedback: {
        addExhaustion: (amount) => this.player.addExhaustion(amount),
        addRecoil: (pitch, yaw) => this.player.addRecoil(pitch, yaw),
      },
    });
    this.weapon.resetToLoadout();
    this.rig.setWeapon(WEAPON_IDS[this.weapon.slot]);
    this.rig.onReloadClick = (step) => sfx.reloadClick(step, WEAPON_IDS[this.weapon.slot]);
    this.rig.onBoltClack = (step) => sfx.cycleClick(step, WEAPON_IDS[this.weapon.slot]);
    this.roster = new AvatarRoster({
      scene: this.worldview.scene,
      gore: (event, options) => this.effects?.gore(event, options),
      getMyId: () => this.myId,
    });
    this.spectator = new SpectatorCamera({
      camera: this.camera,
      raycast: (origin, direction, distance) => (
        this.worldview?.pickCameraRay(origin, direction, distance)
      ),
      now: nowMs,
      onPresent: (state) => this.hud.setSpectatorState(state),
    });
    this.hud.setupSpectator({
      onCycle: (direction) => this.spectator?.cycle(direction),
    });
    this.feedback = new CombatFeedback({
      effects: this.effects,
      sfx,
      hud: this.hud,
      roster: this.roster,
      player: this.player,
      getMyId: () => this.myId,
      getPlayersCache: () => this.playersCache,
      getSelfRow: () => this.selfRow,
      isRunning: () => this.running,
      camera: this.camera,
      world: this._world,
      respawnLocal: (row) => this.respawnLocal(row),
      onLocalDeath: () => {
        this.weapon?.deathReset();
        this.session.syncGameplayInput();
      },
    });

    complete({
      activateLive: () => { this.running = true; this.clock.start(); },
      flushQueuedSnapshots: () => this.flushPendingAuthoritativeSnapshots(),
      consumeLatestAuthoritativeState: () => this.consumeLatestAuthoritativeState(),
      startLoop: () => {
        // Apply visual-debug overrides after authoritative boot reconciliation
        // and input reset so every weapon/ADS URL produces the requested view.
        if (debugMode) {
          const debugSlot = WEAPON_IDS.indexOf(debugWeapon);
          if (debugSlot >= 0) this.weapon.forceWeapon(debugSlot, {
            mode: this.matchState?.mode,
            owned: this.selfRow?.owned,
          });
          this.input.wantAdsHeld = debugAds;
        }
        this.loop(++this._loopGeneration);
      },
    });
  }

  handleTick(snapshot, phase = this.session.phase) {
    applySnapshotBlocks(snapshot, this._world);
    if (phase === 'booting') this.queueAuthoritativeSnapshot(snapshot);
    else if (this.running && phase === 'live') this.consumeAuthoritativeSnapshot(snapshot);
  }

  queueAuthoritativeSnapshot(snapshot) {
    if (snapshot && typeof snapshot === 'object') this._pendingAuthoritativeSnapshots.push(snapshot);
  }

  flushPendingAuthoritativeSnapshots() {
    const pending = this._pendingAuthoritativeSnapshots;
    this._pendingAuthoritativeSnapshots = [];
    for (const snapshot of pending) this.consumeAuthoritativeSnapshot(snapshot);
  }

  consumeLatestAuthoritativeState() {
    const snapshots = this.net?.latestSnapshots;
    this.consumeAuthoritativeSnapshot(Array.isArray(snapshots) && snapshots.length
      ? snapshots[snapshots.length - 1]
      : null);
  }

  consumeAuthoritativeSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    if (Number.isFinite(snapshot.snapSeq) && this._lastConsumedSnapSeq !== null &&
        snapshot.snapSeq <= this._lastConsumedSnapSeq) return;
    if (Number.isFinite(snapshot.snapSeq)) this._lastConsumedSnapSeq = snapshot.snapSeq;

    const players = Array.isArray(snapshot.players) ? snapshot.players : [];
    const presented = Object.freeze(players.map((row) => Object.freeze({
      ...row,
      local: row.id === this.myId,
    })));
    const self = players.find((row) => row.id === this.myId) || null;
    const match = snapshot.match && typeof snapshot.match === 'object' ? snapshot.match : null;
    this.matchState = match;
    this.selfRow = self;
    this.playersCache = presented;
    this.serverNow = Number.isFinite(snapshot.serverNow) ? snapshot.serverNow : null;
    this.spectator?.sync({ self, players: presented, match, serverNow: this.serverNow });

    const events = Array.isArray(snapshot.events) ? snapshot.events : [];
    const deathEvent = events.find((event) => event?.kind === 'kill' && event.victim === this.myId) ||
      events.find((event) => event?.kind === 'die' && event.id === this.myId) || null;
    let hitEvent = null;
    for (let index = events.length - 1; index >= 0; index--) {
      if (events[index]?.kind === 'hit' && events[index].victim === this.myId) {
        hitEvent = events[index];
        break;
      }
    }
    const reconciled = this.player.reconcile(self, snapshot.snapSeq, {
      deathEvent,
      impact: hitEvent,
      id: this.myId,
    });
    if (reconciled.transition?.kind === 'death') {
      this.feedback?.presentLocalDeath(deathEvent?.killer || null, reconciled.transition);
    } else if (reconciled.transition?.kind === 'respawn') {
      this.weapon?.respawn({ mode: match?.mode, weapon: self?.weapon });
      this.feedback?.presentLocalRespawn();
      this.session.restoreGameplayFocus();
    }
    if (self && this.weapon) {
      this.weapon.reconcileServer({
        mag: self.mag,
        reserve: self.reserve,
        mode: match?.mode,
        owned: self.owned,
        weapon: self.weapon,
        reloading: self.reloading,
        alive: this.player.alive,
      });
    }
    const purchased = this.session.confirmPurchase(self);
    if (purchased && this.weapon) {
      const slot = WEAPON_IDS.indexOf(purchased);
      if (slot >= 0) this.weapon.forceWeapon(slot, { mode: match?.mode, owned: self?.owned });
    }
    this.hud.setMatchState(match, self, presented, this.serverNow);
    this.session.syncBuyMenuState();
  }

  respawnLocal(row) {
    const transition = this.player.respawn(row, { spawnProtected: !!row?.spawnProtected });
    if (transition) {
      this.weapon?.respawn({ mode: this.matchState?.mode, weapon: row?.weapon });
      this.session.restoreGameplayFocus();
    }
    return transition;
  }

  isAuthoritativeFireAllowed() {
    if (!this.session.gameplayInputEnabled || !this.player.alive ||
        this.selfRow?.state !== 'alive') return false;
    if (this.matchState?.mode === 'fun') return true;
    return (this.matchState?.mode === 'tdm' || this.matchState?.mode === 'snd' ||
      this.matchState?.mode === 'gungame') &&
      this.matchState.phase === 'live';
  }

  isAuthoritativeInteractAllowed() {
    return !!(this.session.gameplayInputEnabled && this.player.alive &&
      this.matchState?.mode === 'snd' && this.matchState.phase === 'live' &&
      this.selfRow?.state === 'alive');
  }

  isAuthoritativeMovementAllowed() {
    if (!this.session.gameplayInputEnabled || !this.player.alive ||
        this.selfRow?.state !== 'alive') return false;
    return !(this.matchState?.mode === 'snd' && this.matchState.phase === 'prep');
  }

  weaponFrameContext() {
    const position = this.camera.position;
    return {
      allowFire: this.isAuthoritativeFireAllowed(),
      alive: this.player.alive,
      crouching: this.player.crouchBool,
      speedXZ: this.player.speedXZ,
      panic: this.player.panic,
      exhaustion: this.player.exhaustion,
      pain: this.player.pain,
      yaw: this.player.aimYaw,
      pitch: this.player.aimPitch,
      cameraX: position.x,
      cameraY: position.y,
      cameraZ: position.z,
      generation: this._loopGeneration,
    };
  }

  loop(generation) {
    if (!this.running || generation !== this._loopGeneration) return;
    this._rafId = requestAnimationFrame(() => { this._rafId = 0; this.loop(generation); });
    const frameDt = Math.min(0.25, this.clock.getDelta());
    const dt = Math.min(0.05, frameDt);
    const now = nowMs();
    this.session.syncGameplayInput();
    this.player.update(dt, now, {
      movementAllowed: () => this.isAuthoritativeMovementAllowed(),
      fireAllowed: () => this.isAuthoritativeFireAllowed(),
      interactAllowed: () => this.isAuthoritativeInteractAllowed(),
      toggleBuyMenu: () => {
        this.session.toggleBuyMenuFromInput();
        return this.hud.isBuyMenuOpen();
      },
      onWeaponIntents: (intents, at) => this.weapon.applyIntents(intents, at, {
        allowFire: this.isAuthoritativeFireAllowed(),
        alive: this.player.alive,
        mode: this.matchState?.mode,
        owned: this.selfRow?.owned,
      }),
      beforeSend: (_frame, at) => {
        this.weapon.tickReload(at);
        try {
          this.weapon.tryFire(at, this.weaponFrameContext());
        } catch (error) {
          this.phaseError('tryFire', error);
        }
      },
      sendInput: (input) => this.net?.sendInput(input) || false,
      getNetworkWeaponState: () => ({
        slot: this.weapon.slot,
        reloading: this.weapon.isReloading,
      }),
    });
    this.weapon.settleFrame(dt);
    const def = this.weapon.def;
    this.player.updateCamera(dt, this.camera, def, this.weapon.adsT, this.session.baseFov);
    const blastShake = this.effects.currentShakeXY;
    this.camera.rotation.x += blastShake.y;
    this.camera.rotation.y += blastShake.x;
    try {
      this.rig.update(dt, {
        speed: this.player.speedXZ,
        grounded: this.player.physics.grounded,
        verticalVelocity: this.player.physics.vel.y,
        isSprinting: !this.player.wantAds && this.player.keys.sprint && this.player.speedXZ > 4.6,
        crouch: this.player.crouchBool,
        panic: this.player.panic,
        exhaustion: this.player.exhaustion,
        pain: this.player.pain,
        aimSwayScale: this.player.aimMotion?.rigMotionScale,
      });
      this.weapon.syncRigAds();
      this.effects.update(dt);
      this.worldview.update(dt);
    } catch (error) { this.phaseError('fx/rig', error); }
    try {
      const view = this.net?.interpolate(performance.now());
      const presentedPlayers = this.spectator?.ensureTargetPresent(view?.players)
        || view?.players;
      if (presentedPlayers) this.roster.sync(presentedPlayers, dt, now);
      this.spectator?.update(presentedPlayers, dt);
    } catch (error) { this.phaseError('net/interp', error); }

    const spectating = this.spectator?.active === true;
    if (this.rig?.root) {
      this.rig.root.visible = shouldShowViewmodel({
        spectating,
        scopeActive: this.weapon?.scopeActive,
      });
    }
    if (spectating && this.ownBody?.group) this.ownBody.group.visible = false;

    this.hud.setState({
      hp: this.player.hp,
      ...this.weapon.readModel(now),
      panic: this.player.panic,
      pain: this.player.pain,
      crouching: this.player.crouchBool,
      spawnProtected: this.player.spawnProtected,
      yawDeg: ((-this.player.view.yaw * 180 / Math.PI) % 360 + 360) % 360,
      alive: this.player.alive,
      grenades: this.selfRow?.grenades ?? 0,
    });
    this.hud.setTelemetry(frameDt, this.net?.networkStats, now);
    if (now - this._sbAt >= 250 && this.playersCache.length) {
      this._sbAt = now;
      this.hud.setPlayers(this.playersCache);
    }
    const forward = fwdFromAngles(this.player.aimYaw, this.player.aimPitch);
    sfx.setListener({
      fwd: [forward.x, forward.y, forward.z],
      pos: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
    });
    this._postFrame.time = now / 1000;
    this._postFrame.panic = this.player.panic;
    this._postFrame.pain = this.player.pain;
    this._postFrame.scopeActive = !!this.weapon?.scopeActive;
    this.post.render(this.worldview.scene, this.camera, this._postFrame);
  }

  phaseError(phase, error) {
    this.__phases ||= {};
    if ((this.__phases[phase] || 0) >= 5) return;
    this.__phases[phase] = (this.__phases[phase] || 0) + 1;
    console.error('[vb]', String(error?.message || error) + ' @' + phase);
  }

  disposeLiveResources() {
    this._loopGeneration++;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
    this.running = false;
    this.clock.stop();
    this._pendingAuthoritativeSnapshots = [];
    this._lastConsumedSnapSeq = null;
    this.feedback?.dispose();
    this.spectator?.dispose();
    this.roster?.dispose();
    this.weapon?.dispose();
    if (this.ownBody) {
      this.worldview?.scene.remove(this.ownBody.group);
      disposeFirstPersonBody(this.ownBody);
    }
    if (this.rig) this.rig.onReloadClick = null;
    this.rig?.dispose();
    this.effects?.dispose();
    this.worldview?.dispose();
    this.feedback = this.spectator = this.roster = this.weapon = this.ownBody = null;
    this.rig = this.effects = this.worldview = this.mapMeta = null;
    this.playersCache = Object.freeze([]);
    this.matchState = this.selfRow = this.serverNow = null;
    this.player.resetForMenu({ baseFov: this.session.baseFov });
  }

  disposeTerminalResources() {
    if (this._disposed) return;
    this._disposed = true;
    this.disposeLiveResources();
    if (this._debugInterval) clearInterval(this._debugInterval);
    if (this._onDebugError) window.removeEventListener('error', this._onDebugError, true);
    this.player.dispose();
    this.post?.dispose();
    this.post = null;
    this.renderer.dispose();
  }
}

const debugParams = new URLSearchParams(location.search);
const debugMode = debugParams.has('debug');
const debugWeapon = debugParams.get('weapon') || '';
const debugAds = debugParams.has('ads');
const debugUi = debugParams.get('ui') || '';
const shaderDisabled = ['0', 'off', 'false'].includes(debugParams.get('shader'));
const game = new Game();

window.__vb = {
  get stats() {
    const info = game.renderer.info;
    const hist = {};
    if (game.worldview) {
      for (const child of game.worldview.scene.children) hist[child.type] = (hist[child.type] || 0) + 1;
    }
    const snapshots = game.net?.latestSnapshots || [];
    const turn = game.rig?.turnLag;
    const weapon = game.weapon ? WEAPON_IDS[game.weapon.slot] : null;
    const def = weapon ? WEAPONS[weapon] : null;
    const counters = game.roster?.counters || {};
    const pos = game.player.pos;
    return {
      localId: game.myId,
      alive: game.player.alive,
      running: game.running,
      hp: game.player.hp,
      feet: [pos.x, pos.y, pos.z].every(Number.isFinite) ? { x: pos.x, y: pos.y, z: pos.z } : null,
      crouching: game.player.crouchBool,
      pitch: game.player.view.pitch,
      yaw: game.player.view.yaw,
      weapon,
      weaponWeightKg: Number.isFinite(def?.weightKg) ? def.weightKg : null,
      adsT: game.weapon?.adsT ?? null,
      rigAdsT: game.rig?.currentAdsT01 ?? null,
      cameraFov: game.camera?.fov ?? null,
      gunLag: Number.isFinite(turn?.yaw) && Number.isFinite(turn?.pitch) ? {
        yaw: turn.yaw,
        pitch: turn.pitch,
        speed: turn.speed,
        maxSpeed: turn.maxSpeed,
      } : null,
      settingsOpen: !!game.hud.settingsOpen,
      volume: game.session.masterVolume,
      fov: game.session.baseFov,
      panic: game.player.panic,
      exhaustion: game.player.exhaustion,
      pain: game.player.pain,
      spawnProtected: game.player.spawnProtected,
      ownBodyVisible: !!game.ownBody?.group.visible,
      dyingAvatars: counters.dyingAvatars || 0,
      runningAvatars: counters.runningAvatars || 0,
      maxAvatarSpeed: counters.maxAvatarSpeed || 0,
      scopeActive: !!game.weapon?.scopeActive,
      shader: game.post?.stats || null,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      drawCalls: info.render.calls,
      sceneObjects: game.worldview?.scene.children.length || 0,
      hist,
      ringLen: snapshots.length,
      lastSnapAgeMs: snapshots.length
        ? Math.round(performance.now() - (snapshots[snapshots.length - 1].recvLocalMs || 0))
        : null,
      ping: Math.round(game.net?.ping || 0),
      avatars: game.roster?.size || 0,
      chunks: game.worldview?.chunkStore.stats || null,
    };
  },
};

if (debugMode) {
  const root = document.documentElement;
  const seen = new Map();
  let debugUiOpened = false;
  game._debugInterval = setInterval(() => {
    try {
      const stats = window.__vb.stats;
      if (debugUi === 'settings' && !debugUiOpened) {
        debugUiOpened = true;
        game.hud.openSettings();
      }
      if (game.worldview) {
        for (const child of game.worldview.scene.children) {
          if (!seen.has(child.uuid)) seen.set(child.uuid, child.type + '|' + (child.name || ''));
        }
      }
      const kinds = {};
      for (const tag of seen.values()) kinds[tag] = (kinds[tag] || 0) + 1;
      root.dataset.vbStats = JSON.stringify({
        ...stats,
        aliveKinds: Object.fromEntries(Object.entries(kinds).filter(([, count]) => count < 300)),
        phaseErrs: game.__phases || null,
      });
    } catch {}
  }, 500);
  game._onDebugError = (event) => {
    const failedResource = event?.target?.currentSrc || event?.target?.src || '';
    const detail = event?.message || event?.error?.message ||
      (failedResource ? `resource failed: ${failedResource}` : '');
    if (detail) root.dataset.vbLastError = String(detail);
  };
  window.addEventListener('error', game._onDebugError, true);
}

game.start();
