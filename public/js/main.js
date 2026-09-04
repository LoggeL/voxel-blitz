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
import { Effects, attachShellBridge, attachMuzzleBridge } from './weapons/effects.js';
import { HUD } from './ui/hud.js';
import { WeaponWheelController } from './session/weapon-wheel-controller.js';
import { RunHud } from './ui/run-hud.js';
import { sfx } from './audio/sfx.js';
import { Session } from './session/session.js';
import { aimAssistStrength } from './player/aim-assist.js';
import { LocalPlayer } from './player/local-player.js';
import { SpectatorCamera } from './player/spectator-camera.js';
import { AvatarRoster } from './avatar/avatar-roster.js';
import { CombatFeedback, applySnapshotBlocks, isWorldPointVisible } from './combat/feedback.js';
import { disposeFirstPersonBody, makeFirstPersonBody } from './player/first-person-body.js';
import { fwdFromAngles } from './util/look.js';
import { nowMs } from './util/math.js';
import { GRENADE_TYPES, GRENADE_TYPE_IDS, grenadeFuseAfterCook } from '../../shared/grenade-rules.js';

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
    this._grenadeCharging = false;
    this._grenadeCook01 = 0;
    this._grenadeCookLeftMs = 0;
    this.weapon = null;
    this.roster = null;
    this.feedback = null;
    this.runHud = null;
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
    this._padScoreboard = false;
    this._deviceKey = '';
    this._touchContext = {};
    this._loopGeneration = 0;
    this._rafId = 0;
    this._sbAt = 0;
    this._disposed = false;
    this.weaponWheel = new WeaponWheelController({
      input: this.input,
      hud: this.hud,
      forceOpen: debugUi === 'wheel',
      getContext: () => ({
        weapon: this.weapon, self: this.selfRow, match: this.matchState,
        enabled: this.session?.gameplayInputEnabled, alive: this.player.alive,
        spectating: this.spectator?.active === true,
      }),
    });

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
        onRunEvent: (event) => this.runHud?.handleEvent(event),
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

    this.effects = new Effects(this.worldview.scene, this.camera, getBlock, {
      // Stuck limpets ride their carrier: the local body or a presented remote avatar.
      getEntityPosition: (id) => {
        if (id === this.myId) {
          const pos = this.player.pos;
          return { x: pos.x, y: pos.y, z: pos.z };
        }
        return this.roster?.positionOf(id) || null;
      },
      // Bolt wall-ricochet zap: client-derived from the shared integrator's bounced flag.
      onBounce: (x, y, z) => sfx.arcZap?.([x, y, z]),
    });
    this.worldview.scene.add(this.camera);
    this.ownBody = makeFirstPersonBody();
    this.worldview.scene.add(this.ownBody.group);
    this.player.setFirstPersonBody(this.ownBody);
    this.rig = new ViewmodelRig(this.camera);
    attachShellBridge(this.effects, this.rig);
    attachMuzzleBridge(this.effects, this.rig);
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
        addRecoil: (...args) => this.player.addRecoil(...args),
      },
    });
    this.weapon.resetToLoadout();
    this.hud.setupWeaponWheel({
      onPick: (slot) => this.commitWeaponWheel(slot),
      onCancel: () => this.closeWeaponWheel(),
    });
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
      onLocalDeath: (_transition, killerId) => {
        this.weapon?.deathReset();
        this.session.syncGameplayInput();
        // Kill cam: the spectator camera opens on the killer before rotating.
        if (killerId && killerId !== this.myId) this.spectator?.focusKiller(killerId);
      },
    });
    this.runHud = new RunHud({ getMyId: () => this.myId });

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
      this.feedback?.presentLocalDeath(
        deathEvent?.killer || null,
        reconciled.transition,
        deathEvent?.kind === 'kill' ? deathEvent : null,
      );
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
    this.runHud?.setMatch(match);
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
        this.selfRow?.state !== 'alive' || this._wheelOpen) return false;
    if (this.matchState?.mode === 'fun' || this.matchState?.mode === 'training') return true;
    return (this.matchState?.mode === 'tdm' || this.matchState?.mode === 'snd' ||
      this.matchState?.mode === 'gungame') &&
      this.matchState.phase === 'live';
  }

  isAuthoritativeInteractAllowed() {
    return !!(this.session.gameplayInputEnabled && this.player.alive &&
      this.matchState?.mode === 'snd' && this.matchState.phase === 'live' &&
      this.selfRow?.state === 'alive' && !this._wheelOpen);
  }

  isAuthoritativeMovementAllowed() {
    if (!this.session.gameplayInputEnabled || !this.player.alive ||
        this.selfRow?.state !== 'alive') return false;
    return !(this.matchState?.mode === 'snd' && this.matchState.phase === 'prep');
  }

  /** Remaining count of the selected throwable from the authoritative row. */
  selectedGrenadeCount() {
    const counts = this.selfRow?.grenades;
    const index = this.input.getGrenadeType();
    return Array.isArray(counts) ? (counts[index] | 0) : 0;
  }

  /**
   * Local grenade presentation: pin click and wind-up while G is held, a live flight
   * preview from the shared integrator per grenade type, cook feedback for timed fuses
   * (a fuse held to the end forces the release so authority detonates it in hand), and an
   * immediate predicted projectile on release that the authority event later adopts.
   */
  presentGrenadeHandling(now) {
    const input = this.player.input;
    const typeIndex = input.getGrenadeType();
    const type = GRENADE_TYPES[GRENADE_TYPE_IDS[typeIndex]];
    const canThrow = this.player.alive && this.selectedGrenadeCount() > 0
      && this.isAuthoritativeFireAllowed();
    const charging = !!input.isGrenadeCharging?.() && canThrow;
    const charge = charging ? input.getGrenadeCharge(now) : 0;
    const heldMs = charging ? input.getGrenadeHoldMs(now) : 0;
    if (charging && !this._grenadeCharging) sfx.grenadePin();
    this._grenadeCharging = charging;
    this._grenadeCook01 = charging && type.cook ? Math.min(1, heldMs / type.fuseMs) : 0;
    this._grenadeCookLeftMs = charging && type.cook ? Math.max(0, type.fuseMs - heldMs) : 0;
    if (charging && type.cook && heldMs >= type.fuseMs) input.forceGrenadeRelease(now);
    this.rig?.grenadeCharge(charging ? 0.35 + 0.65 * charge : 0);
    this.effects?.projectilePreview(
      charging ? this.player.grenadeLaunchState(charge, type.id) : null,
    );

    const thrown = this.player.consumeLocalGrenadeThrow();
    if (!thrown || !canThrow) return;
    const thrownType = GRENADE_TYPES[GRENADE_TYPE_IDS[thrown.type]] || type;
    if (thrownType.cook && thrown.cookMs >= thrownType.fuseMs) {
      // Cooked to the end: authority detonates it in the hand; nothing flies.
      this.rig?.grenadeThrow(0);
      return;
    }
    const launch = this.player.grenadeLaunchState(thrown.charge, thrownType.id);
    this.effects?.projectileLaunch({
      type: thrownType.id,
      o: [launch.x, launch.y, launch.z],
      v: [launch.vx, launch.vy, launch.vz],
      fuse: thrownType.cook
        ? grenadeFuseAfterCook(thrown.cookMs, thrownType)
        : (thrownType.sticky ? thrownType.flightMaxMs : thrownType.fuseMs),
    }, { local: true });
    this.rig?.grenadeThrow(thrown.charge);
    sfx.grenadeThrow(thrown.charge);
  }

  get _wheelOpen() { return this.weaponWheel.open; }
  openWeaponWheel() { return this.weaponWheel.openWheel(); }
  closeWeaponWheel(slot = null) { return this.weaponWheel.close(slot); }
  commitWeaponWheel(slot) { return this.weaponWheel.commit(slot); }
  syncWeaponWheel() { this.weaponWheel.sync(); }

  /**
   * Contextual touch buttons: only actions that can do something right now are shown.
   * Cheap on unchanged frames because TouchControls diffs the visibility set.
   */
  syncTouchContext() {
    if (!this.input.usesTouchControls()) return;
    const alive = this.player.alive && this.selfRow?.state === 'alive';
    const def = this.weapon?.def;
    const ammo = this.weapon && def ? this.weapon.ammoOf(def.id) : null;
    const owned = this.selfRow?.owned;
    const ctx = this._touchContext;
    ctx.alive = alive;
    ctx.canFire = this.isAuthoritativeFireAllowed();
    ctx.canReload = !!(ammo && def && ammo.mag < def.magSize && ammo.reserve > 0
      && !this.weapon.isReloading);
    ctx.canInteract = this.isAuthoritativeInteractAllowed();
    ctx.weaponCount = Array.isArray(owned) ? owned.length : WEAPON_IDS.length;
    ctx.canBuy = this.session.canOpenBuyMenu();
    ctx.wheelOpen = this._wheelOpen;
    this.input.setTouchContext(ctx);
  }

  /**
   * Aim assist for pad and touch only: a gentle look slowdown while the reticle sits
   * within a few degrees of a visible living enemy. Mouse look is never touched.
   */
  syncAimAssist(now) {
    if (!this.input.aimAssistEligible(now)) {
      this.input.setAimAssist(0);
      return;
    }
    this.input.setAimAssist(aimAssistStrength({
      players: this.playersCache,
      self: this.selfRow,
      mode: this.matchState?.mode,
      eye: this.camera.position,
      forward: fwdFromAngles(this.player.aimYaw, this.player.aimPitch),
      isVisible: (point) => isWorldPointVisible(this._world, this.camera, point, 0.6),
    }));
  }

  /** Settings copy reacts to the live device (pad appears, trackpad detected). */
  syncDeviceInfo(now) {
    const info = this.input.deviceInfo(now);
    const key = `${info.touch}|${info.pointerKind}|${info.trackpadDetected}|${info.padActive}`;
    if (key === this._deviceKey) return;
    this._deviceKey = key;
    this.hud.setDeviceInfo(info);
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
    this.input.poll(now, dt);
    this.syncWeaponWheel();
    if (this.input.scoreboardHeld !== this._padScoreboard) {
      this._padScoreboard = this.input.scoreboardHeld;
      this.hud.setScoreboard(this._padScoreboard);
    }
    this.player.update(dt, now, {
      weapon: this.weapon,
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
    this.presentGrenadeHandling(now);
    const def = this.weapon.def;
    // Scope zoom steps (Z, wheel while scoped, R3, touch ZOOM) only while looking through the optic.
    const zoomSteps = this.input.consumeZoomStep();
    if (zoomSteps && this.weapon.scopeActive) {
      for (let i = 0; i < Math.abs(zoomSteps); i++) this.player.cycleScopeZoom(def);
    }
    this.input.setScopeZoomMode(!!this.weapon.scopeActive);
    this.player.updateCamera(dt, this.camera, def, this.weapon.adsT, this.session.baseFov);
    const blastShake = this.effects.currentShakeXY;
    this.camera.rotation.x += blastShake.y;
    this.camera.rotation.y += blastShake.x;
    try {
      // Body velocity in the camera frame: +x strafing right, +z backing up. The rig uses
      // it for a lagged lateral lean so the carried gun swings against direction changes.
      const vel = this.player.physics.vel;
      const yaw = this.player.view.yaw;
      const lateralSpeed = vel.x * Math.cos(yaw) - vel.z * Math.sin(yaw);
      const forwardSpeed = -(vel.x * Math.sin(yaw) + vel.z * Math.cos(yaw));
      this.rig.update(dt, {
        speed: this.player.speedXZ,
        lateralSpeed,
        forwardSpeed,
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
    this.syncTouchContext();
    this.syncAimAssist(now);
    this.syncDeviceInfo(now);
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
      grenadeType: this.input.getGrenadeType(),
      grenadeCharge: this.player.input.getGrenadeCharge(now),
      grenadeCharging: this._grenadeCharging,
      grenadeCook01: this._grenadeCook01,
      grenadeCookLeftMs: this._grenadeCookLeftMs,
      holdingBreath: !!this.player.aimMotion?.holdingBreath,
      breath01: this.player.aimMotion?.breathRemaining01 ?? 1,
      canHoldBreath: this.player.speedXZ < 0.18 && this.player.physics.grounded,
      scopeZoom: this.player.scopeZoom,
    });
    this.hud.setTelemetry(frameDt, this.net?.networkStats, now);
    const hp = this.player.hp;
    sfx.lowHealthPulse(this.player.alive && hp < 35 ? (35 - hp) / 35 : 0, now);
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
    this.runHud?.dispose();
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
    this.weaponWheel.reset();
    this.feedback = this.spectator = this.roster = this.weapon = this.ownBody = null;
    this.runHud = null;
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
      scopeZoom: game.player.scopeZoom,
      recoilClimb: { ...game.player.recoilClimb },
      reconcileOffset: Math.hypot(
        game.player.reconcileOffset.x,
        game.player.reconcileOffset.y,
        game.player.reconcileOffset.z,
      ),
      device: game.input.deviceInfo(),
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
  get wheelOpen() { return game._wheelOpen; },
  get wheelOwned() { return game.selfRow?.owned ?? null; },
  get wheelMatchMode() { return game.matchState?.mode ?? null; },
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
