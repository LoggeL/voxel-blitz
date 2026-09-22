// Voxel Blitz browser composition root. Mutable gameplay ownership lives in
// Session, LocalPlayer, WeaponState, AvatarRoster, and CombatFeedback.
//
// Boot order: this module keeps only what the main menu needs on its static
// import graph (HUD, session, accounts, career, input, audio facade and the
// shared rules). three.js, the chunk mesher, the weapon/avatar factories and
// the Blender library arrive through the asset scheduler after the menu is
// interactive; joining a match waits for exactly the tasks in MATCH_ASSETS.
import { AccountKeybindings } from './account-keybindings.js';
import { loadingScreen } from './ui/loading-screen.js';
import { claymoreProfile } from '../../shared/claymore-rules.js';
import { ProgressionTree } from './ui/progression.js';
import { AccountMenu } from './ui/account-menu.js';
import { applyReticle, applyLocalPresentation, resetLocalPresentation } from './cosmetics/local-presentation.js';
import { BASTION_ENEMIES, bastionRepairAvailable } from '../../shared/bastion.js';
import { FrameRateController } from './engine/frame-rate.js';
import { WEAPON_IDS, HITSCAN_REACH } from '../../shared/combatmath.js';
import { VAULT_SECONDS } from '../../shared/player-movement.js';
import { deserializeWorld, serializeWorld, getBlock, getMapMeta, setBlock } from '../../shared/worlddata.js';
import { Input } from './engine/input.js';
import { HUD } from './ui/hud.js';
import { displaySettings } from './ui/display-settings.js';
import { MAP_LABELS, weaponImagePath } from './ui/hud-support.js';
import { mapAtmosphere } from './engine/map-atmosphere.js';
import { WeaponWheelController } from './session/weapon-wheel-controller.js';
import { RunHud } from './ui/run-hud.js';
import { sfx } from './audio/sfx.js';
import { footstepSurfaceAt } from './audio/footsteps.js';
import { Session } from './session/session.js';
import { aimAssistStrength } from './player/aim-assist.js';
import { smokeBlocksSight, copySmokeFields } from '../../shared/smoke-rules.js';
import { fwdFromAngles } from './util/look.js';
import { nowMs } from './util/math.js';
import { GRENADE_TYPES, GRENADE_TYPE_IDS, grenadeFuseAfterCook } from '../../shared/grenade-rules.js';
import { AssetScheduler } from './boot/asset-scheduler.js';

window.__vbBoot?.phases && (window.__vbBoot.phases.modules ??= Math.round(performance.now() - window.__vbBoot.startedAt));

/** Match runtime namespace (see boot/match-runtime.js) once its task has loaded. */
let runtime = null;
/** Free identifier for Game.handleTick; assigned with the runtime, injected by Node tests. */
let applySnapshotBlocks = null;
// The menu's play gate needs the HUD before the Game instance exists; a
// `let` declared below `new Game()` would sit in its temporal dead zone.
let hudRef = null;
/** Asset tasks a live match waits for, in loading order. */
const MATCH_ASSETS = Object.freeze(['models', 'runtime', 'audio']);
const assets = new AssetScheduler({ onChange: () => renderAssetStatus() });

class Game {
  constructor() {
    const canvas = document.getElementById('game');
    this.input = new Input(canvas);
    this.hud = new HUD();
    hudRef = this.hud;
    // The WebGL renderer, camera, clock, post-process chain and local player
    // belong to the match runtime and are created by ensureRuntime().
    this.rt = null;
    /** Reticle last applied from the authoritative self row; null outside a match. */
    this._liveReticle = null;
    this._menuReturn = false;
    this.renderer = null;
    this.post = null;
    this.camera = null;
    this.clock = null;
    this.player = null;
    this.frameRate = new FrameRateController();
    this._onFrameVisibility = () => {
      this.frameRate.reset(undefined, document.hidden);
      if (document.hidden) sfx.stopCosmetics();
    };
    document.addEventListener('visibilitychange', this._onFrameVisibility);
    this.worldview = null;
    this.effects = null;
    this.rig = null;
    this._grenadeCharging = false;
    this._grenadeCook01 = 0;
    this._grenadeCookLeftMs = 0;
    this.weapon = null;
    this.roster = null;
    this.build = null;
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
    this._disposed = false;
    this.weaponWheel = new WeaponWheelController({
      input: this.input,
      hud: this.hud,
      forceOpen: debugUi === 'wheel',
      getContext: () => ({
        weapon: this.weapon, self: this.selfRow, match: this.matchState,
        enabled: this.session?.gameplayInputEnabled, alive: !!this.player?.alive,
        spectating: this.spectator?.active === true,
      }),
    });

    const game = this;
    this._gameplay = Object.freeze({
      get running() { return game.running; },
      get alive() { return !!game.player?.alive; },
      get spectating() { return game.spectator?.active === true && !game.killcam?.active; },
      get matchState() { return game.matchState; },
      get selfRow() { return game.selfRow; },
    });
    this._world = Object.freeze({
      get meta() { return game.mapMeta; },
      getBlock,
      setBlock,
      applyDeltas: (deltas) => this.worldview?.applyDeltas(deltas),
    });
    this.session = new Session({
      loading: loadingScreen,
      hud: this.hud,
      input: this.input,
      audio: sfx,
      gameplay: this._gameplay,
      callbacks: {
        onEnterLive: (payload) => this.bootLive(payload),
        onDisconnect: () => this.disposeLiveResources(),
        onGameplayEvent: (event) => {
          if (event.kind === 'bastion_clear') { this.effects?.clearCombatHazards(); return; }
          if (event.kind === 'trap') {
            // Innocents hear the effect only; the button and its user stay private.
            if (event.effect !== 'explosion') sfx.bastionCue('bastion_alarm', [event.x, event.y, event.z]);
            this.tttControls?.trapTriggered?.(event);
            return;
          }
          if (event.kind.startsWith('bastion_')) {
            // Transient HUD banners for the tells that need a read before the audio cue.
            const banner = this.bastionBannerFor(event);
            if (banner) this.hud.bastionBanner(banner);
            sfx.bastionCue(event.kind, event.pos ?? (Number.isFinite(event.x) ? [event.x, event.y, event.z] : null));
            if (event.kind === 'bastion_lane') this.worldview?.bastion?.event?.(event.kind);
            return;
          }
          if (this.killcam?.active && ['shoot', 'hit', 'projectileLaunch', 'projectileUpdate', 'projectileStick',
            'projectileExplode', 'blockDamage', 'block', 'mine'].includes(event.kind)) return;
          if (event.kind === 'kill' && event.killer === this.myId && event.victim !== this.myId) this.bumpStattrak(event);
          // Own RIPTIDE stock (embedded discs, fabrication queue) feeds the fabricate gauge.
          if (event.kind === 'glaiveStock' && event.id === this.myId) this.weapon?.adoptGlaiveStock(event);
          // Only the authoritative catch of an own RIPTIDE disc plays the horn clamp.
          if (event.kind === 'projectileExplode' && event.type === 'glaive' && event.caught === true &&
            event.id === this.myId) this.rig?.glaiveCatch();
          // Remote RIPTIDE mounts clamp or restore on the same authoritative events.
          if ((event.kind === 'glaiveStock' || (event.kind === 'projectileExplode' && event.type === 'glaive'))
            && event.id !== this.myId) this.roster?.glaive(event.id, event);
          this.feedback?.handleEvent(event);
        },
        onRunEvent: (event) => this.runHud?.handleEvent(event),
        onTick: (snapshot, phase) => this.handleTick(snapshot, phase),
        onGameplayInputDisabled: () => {
          this.player?.setGameplayInputEnabled(false);
          this.weapon?.clearIntents();
          this.build?.exit();
        },
        onGameplayInputEnabled: () => this.player?.setGameplayInputEnabled(true),
        onMenuBuilt: () => {
          if (this._menuReturn) returnToMenuPresentation();
          this._menuReturn = false;
          renderAssetStatus();
        },
        onResize: () => this.resize(),
        onTeardown: () => this.disposeTerminalResources(),
      },
    });
  }

  get net() { return this.session.net; }
  get myId() { return this.session.myId; }

  /** Banner copy for the bastion events that deserve a 4 s HUD read; null for the rest. */
  bastionBannerFor(event) {
    const name = role => BASTION_ENEMIES[role]?.name || String(role || '').toUpperCase();
    switch (event.kind) {
      // `kind` is the event id on the wire; the unit kind travels as `type` (BastionPolicy.emit).
      case 'bastion_vehicle': return event.phase === 'spawn' ? `VEHICLE INBOUND · ${name(event.type ?? event.vehicle ?? event.role)}` : null;
      case 'bastion_tier': return `${name(event.role)} SIGHTED`;
      case 'bastion_breach': return 'BREACH AT THE LINE';
      case 'bastion_structure': return event.destroyed ? 'STRUCTURE LOST' : null;
      case 'bastion_regroup': return event.next?.name ? `FALL BACK TO ${event.next.name}` : null;
      case 'bastion_extract': return 'EXTRACTION CALLED · HOLD THE BEACON';
      default: return null;
    }
  }

  resize() {
    if (!this.renderer || !this.camera) return;
    this.renderer.setSize(innerWidth, innerHeight);
    this.post?.setSize(innerWidth, innerHeight, devicePixelRatio);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Wait for the match assets (the arena screen lists whatever is still
   * outstanding, followed by the mesh sectors) and build the renderer, camera
   * and local player once. Weapon and avatar templates are guaranteed to be
   * present before the first frame: the Blender library is one of the tasks.
   */
  async ensureRuntime() {
    await assets.require(MATCH_ASSETS, { loading: loadingScreen,
      trailing: [{ id: 'world', label: 'ARENA GEOMETRY', weight: 30 }] });
    if (this.rt || this._disposed) return this.rt;
    const rt = this.rt = runtime;
    const canvas = this.input.canvas;
    this.renderer = new rt.THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.post = new rt.CombatPostProcess(this.renderer, {
      enabled: !shaderDisabled,
      maxPixelRatio: rt.recommendedPostProcessPixelRatio(Number(navigator.deviceMemory)),
      reducedMotion: displaySettings().reducedMotion,
    });
    this.post.setSize(innerWidth, innerHeight, devicePixelRatio);
    this.camera = new rt.THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 400);
    this.camera.fov = this.session.baseFov;
    this.camera.updateProjectionMatrix();
    this.clock = new rt.THREE.Clock();
    this.player = new rt.LocalPlayer({ input: this.input });
    this.player.setGameplayInputEnabled(this.session.gameplayInputEnabled);
    return rt;
  }

  async bootLive(payload) {
    const { net, welcome, mapBytes, mapMeta, isActive, showStatus, showProgress, complete } = payload;
    await this.ensureRuntime();
    if (!isActive()) return;
    if (!net.isOpen()) return this.session.handleDisconnect();
    const rt = this.rt;
    // Let the deployment screen paint before decoding the arena.
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    if (!isActive()) return;
    this.mapMeta = mapMeta || getMapMeta(welcome.map);
    this.player.setMapMeta(this.mapMeta);
    this.hud.setMapMeta(this.mapMeta);
    this.player.setBaseFov(this.session.baseFov);
    this.player.respawn({ ...welcome.spawn, state: 'alive', hp: 100 }, { spawnProtected: false });

    deserializeWorld(mapBytes);
    for (const snapshot of net.latestSnapshots) {
      applySnapshotBlocks(snapshot, this._world);
      this.queueAuthoritativeSnapshot(snapshot);
    }
    if (!net.isOpen()) return this.session.handleDisconnect();

    showStatus('building voxel mesh…', 'ok');
    this.worldview = new rt.WorldView({
      getBlock,
      getBlockDamage: (x, y, z) => net.getBlockDamage(x, y, z),
    }, this.mapMeta);
    await this.worldview.ready({ isActive, onProgress: showProgress,
      yieldControl: () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0))),
    });
    if (!isActive()) return;
    if (!net.isOpen()) return this.session.handleDisconnect();
    this.worldview.setGameMode(welcome.gameMode);

    showStatus('preparing your loadout…', 'ok');
    this.liveEffectsGroup = new rt.THREE.Group();
    this.liveAvatarsGroup = new rt.THREE.Group();
    this.worldview.scene.add(this.liveEffectsGroup, this.liveAvatarsGroup);
    this.effects = new rt.Effects(this.liveEffectsGroup, this.camera, getBlock, {
      // Stuck limpets ride their carrier: the local body or a presented remote avatar.
      getEntityPosition: (id) => {
        if (id === this.myId) {
          const pos = this.player.pos;
          return { x: pos.x, y: pos.y, z: pos.z };
        }
        return this.roster?.positionOf(id) || null;
      },
      // Bolt wall-ricochet zap / RIPTIDE bounce tink: client-derived from the shared
      // integrators' bounced flag.
      onBounce: (x, y, z, type) => (type === 'glaive'
        ? sfx.glaiveCue?.('bounce', { pos: [x, y, z] })
        : sfx.arcZap?.([x, y, z])),
      // RIPTIDE: positional whirr per airborne disc; the local "vwomp" as an own disc turns.
      onGlaiveFlight: (disc) => sfx.glaiveFlight?.(disc.id, [disc.x, disc.y, disc.z],
        { phase: disc.phase, velocity: [disc.vx, disc.vy, disc.vz] }),
      onGlaiveFlip: (detail) => {
        sfx.glaiveCue?.('return');
        // The horns flare and the view leans toward the own disc as it turns home.
        this.rig?.glaiveReturn({ world: detail, all: false });
      },
    });
    this.worldview.scene.add(this.camera);
    this.ownBody = rt.makeFirstPersonBody();
    this.worldview.scene.add(this.ownBody.group);
    this.player.setFirstPersonBody(this.ownBody);
    this.rig = new rt.ViewmodelRig(this.camera);
    const effects = this.effects;
    this.rig.onShellEject = ({ pos, vel }) => effects.spawnBrass(pos, vel);
    rt.attachMuzzleBridge(this.effects, this.rig);
    this.weapon = new rt.WeaponState({
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
    this.weapon.setLoadout(welcome.weaponLoadout);
    this.rig.setMastery(welcome.mastery);
    this.hud.setupWeaponWheel({
      onPick: (slot) => this.weaponWheel.commit(slot),
      onCancel: () => this.weaponWheel.close(),
    });
    this.rig.setWeapon(WEAPON_IDS[this.weapon.slot]);
    this.rig.onReloadClick = (step) => sfx.reloadClick(step, WEAPON_IDS[this.weapon.slot]);
    this.rig.onBoltClack = (step) => sfx.cycleClick(step, WEAPON_IDS[this.weapon.slot]);
    this.rig.onGrenadeCue = ({ cue }) => {
      if (cue === 'pin') sfx.grenadePin();
      else if (cue === 'ignite') sfx.molotovIgnite();
      else if (cue === 'draw') sfx.grenadeDraw();
    };
    this.muzzleLights = new rt.MuzzleLights(this.worldview.scene);
    this.roster = new rt.AvatarRoster({
      getBlock,
      scene: this.liveAvatarsGroup,
      gore: (event, options) => this.effects?.gore(event, options),
      getMyId: () => this.myId,
      footstep: (remote, volume, avatar) => sfx.footstep(volume, {
        pos: [remote.x, remote.y, remote.z], body: avatar,
        surface: footstepSurfaceAt(getBlock, remote),
      }),
      // Positional engine drone per alive vehicle row; stopped when the row dies or leaves.
      vehicle: (id, pos, kind) => (pos ? sfx.vehicleLoop?.(id, pos, kind) : sfx.stopVehicleLoop?.(id)),
    });
    this.footsteps = new rt.FootstepCadence();
    // Bastion build mode: the ghost lives in the world scene, the purchase rides the buy path.
    this.build = rt.BuildController ? new rt.BuildController({
      input: this.input,
      getBlock,
      getWorldview: () => this.worldview,
      getCamera: () => this.camera,
      getPlayer: () => this.player,
      getMatch: () => this.matchState,
      getSelfRow: () => this.selfRow,
      getMapMeta: () => this.mapMeta,
      purchase: (action, item, cell, facing) => this.hud.purchaseBastion(action, item, cell, facing),
      isBuyMenuOpen: () => this.hud.isBuyMenuOpen(),
      inputEnabled: () => !!this.session.gameplayInputEnabled,
    }) : null;
    this.hud.setStructureCallback((kind) => { this.build?.select(kind); });
    rt.attachRemoteMuzzleBridge(this.effects, () => this.roster);
    this.roster.setBurnFX(this.effects.flames);
    this.killcam = new rt.Killcam({ scene: this.worldview.scene, getBlock, worldview: this.worldview,
      mapBytes: serializeWorld(), blockDamage: [...net.blockDamage.values()],
      terrainTime: net.latestSnapshots.at(-1)?.serverNow ?? -Infinity, audio: sfx, now: nowMs });
    this.spectator = new rt.SpectatorCamera({
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
    this.feedback = new rt.CombatFeedback({
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
      onLocalMine: () => this.rig?.pickaxeContact(),
      onLocalFlinch: (strength) => this.rig?.flinch(strength),
      onLocalDeath: (_transition, killerId) => {
        this.weapon?.deathReset();
        this.session.syncGameplayInput();
        // Fallback chase view if there is not enough recorded history.
        if (killerId && killerId !== this.myId) this.spectator?.focusKiller(killerId);
      },
    });
    this.runHud = new RunHud({ getMyId: () => this.myId });

    complete({
      activateLive: () => { this.running = true; this.clock.start(); this.frameRate.reset(); renderAssetStatus(); },
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

  /** Mirror the server's mastery filter so the LED never shows a kill the career will not count. */
  bumpStattrak(event) {
    if (!WEAPON_IDS.includes(event.w) || this.matchState?.mode === 'training') return;
    const victim = Array.isArray(this.playersCache) ? this.playersCache.find(row => row?.id === event.victim) : null;
    if (!victim || victim.bot) return;
    if (this.selfRow?.team && victim.team === this.selfRow.team) return;
    this.rig?.noteKill?.(event.w, event.hs === true);
  }

  handleTick(snapshot, phase = this.session.phase) {
    // Before the runtime arrives there is no world to patch; bootLive replays
    // net.latestSnapshots after deserializing the arena.
    applySnapshotBlocks?.(snapshot, this._world);
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

    this.killcam?.history.record(snapshot);
    const players = Array.isArray(snapshot.players) ? snapshot.players : [];
    const presented = Object.freeze(players.map((row) => Object.freeze({
      ...row,
      local: row.id === this.myId,
    })));
    const self = players.find((row) => row.id === this.myId) || null;
    const match = snapshot.match && typeof snapshot.match === 'object' ? snapshot.match : null;
    const previousMatch = this.matchState;
    this.matchState = match;
    this.worldview?.setMatch(match, Number.isFinite(snapshot.serverNow) ? snapshot.serverNow : undefined);
    this.worldview?.tttTraps?.sync(self?.ttt?.traps || []);
    this.worldview?.setPowerups(snapshot.powerups);
    this.selfRow = self;
    if (match?.mode === 'ttt') this.tttControls ??= new this.rt.TttControls(this);
    this.tttControls?.sync(match,self,players);
    this.rig?.setCosmetics(self?.cosmetics);
    this.ownBody?.setCosmetics(self?.cosmetics);
    // In a match the crosshair follows the server's loadout, not the menu's careerView.
    if (self?.cosmetics && self.cosmetics.reticle !== this._liveReticle) {
      this._liveReticle = self.cosmetics.reticle;
      applyReticle(this._liveReticle);
    }
    if (self?.state !== 'dead') this.killcam?.stop();
    this.playersCache = presented;
    this._tttSnapshotAt = performance.now();
    this.serverNow = Number.isFinite(snapshot.serverNow) ? snapshot.serverNow : null;
    this.effects?.syncFireFields?.(snapshot.fireFields, this.serverNow);
    this.effects?.syncMines?.(snapshot.mines, this.myId);
    this.smokeFields = copySmokeFields(snapshot.smokeFields);
    this.smokeObservedAt = nowMs();
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
      if (deathEvent?.kind === 'kill') this.killcam?.start(deathEvent, match?.mode);
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
        minigun: self.minigun, glaive: self.glaive, attachments: self.attachments,
        mag: self.mag,
        reserve: self.reserve,
        chaosUpgrades: self.chaosUpgrades,
        bastionUpgrades: self.bastionUpgrades,
        mode: match?.mode,
        owned: self.owned,
        weapon: self.weapon,
        reloading: self.reloading,
        reloadAck: self.reloadAck,
        reloadState: self.reloadState,
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
    if (previousMatch && previousMatch.phase !== 'post' && match?.phase === 'post' && match.winner != null) {
      const winner = players.find(row => row.id === match.winner) ||
        players.filter(row => row.team === match.winner && !row.bot)
          .sort((a, b) => (b.kills || 0) - (a.kills || 0) || String(a.id).localeCompare(String(b.id)))[0];
      sfx.playCosmetic(winner?.cosmetics?.sound, 'victory');
    } else if (previousMatch?.phase === 'post' && match?.phase !== 'post') sfx.stopCosmetics();


  }

  respawnLocal(row) {
    const transition = this.player.respawn(row, { spawnProtected: !!row?.spawnProtected });
    if (transition) {
      this.weapon?.respawn({ mode: this.matchState?.mode, weapon: row?.weapon });
      this.session.restoreGameplayFocus();
    }
    return transition;
  }

  isAuthoritativeFireAllowed(grenade = false) {
    if (!this.session.gameplayInputEnabled || !this.player.alive ||
        this.selfRow?.state !== 'alive' || this.weaponWheel.open || this.player.physics.vault) return false;
    if (this.matchState?.mode === 'ttt') {
      const melee = grenade === 'melee' || (!grenade && this.weapon.def.mode === 'melee');
      return this.matchState.phase === 'live' || (this.matchState.phase === 'prep' && melee);
    }
    if (this.matchState?.mode === 'fun' || this.matchState?.mode === 'training') return true;
    return (this.matchState?.mode === 'duel' || this.matchState?.mode === 'chaos' || this.matchState?.mode === 'tdm' || this.matchState?.mode === 'snd' ||
      this.matchState?.mode === 'gungame' || this.matchState?.mode === 'bastion') &&
      this.matchState.phase === 'live';
  }

  isAuthoritativeInteractAllowed() {
    const match = this.matchState;
    const objective = match?.mode === 'snd' && match.phase === 'live';
    const repair = bastionRepairAvailable(match,this.selfRow);
    return !!(this.session.gameplayInputEnabled && this.player.alive &&
      (objective || repair) && this.selfRow?.state === 'alive' && !this.weaponWheel.open);
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
      && this.isAuthoritativeFireAllowed(true);
    const charging = !!input.isGrenadeCharging?.() && canThrow;
    const charge = charging ? input.getGrenadeCharge(now) : 0;
    const heldMs = charging ? input.getGrenadeHoldMs(now) : 0;
    this._grenadeCharging = charging;
    this._grenadeCook01 = charging && type.cook ? Math.min(1, heldMs / type.fuseMs) : 0;
    this._grenadeCookLeftMs = charging && type.cook ? Math.max(0, type.fuseMs - heldMs) : 0;
    if (charging && type.cook && heldMs >= type.fuseMs) input.forceGrenadeRelease(now);
    if (!canThrow && !this.player.alive) this.rig?.cancelGrenade();
    else this.rig?.grenadeCharge(charge, typeIndex, heldMs, charging);
    const preview = charging ? this.player.grenadeLaunchState(charge, type.id) : null;
    this._claymorePlacementValid = type.wallMine && !!preview;
    const mineProfile = claymoreProfile(this.selfRow?.chaosUpgrades?.limpet || 0);
    this.effects?.projectilePreview(preview ? { ...preview,
      ...(type.wallMine ? mineProfile : {}),
      fuseMs: type.cook ? grenadeFuseAfterCook(heldMs, type) : type.fuseMs,
    } : null);

    const thrown = this.player.consumeLocalGrenadeThrow();
    if (!thrown || !canThrow) return;
    const thrownType = GRENADE_TYPES[GRENADE_TYPE_IDS[thrown.type]] || type;
    if (thrownType.cook && thrown.cookMs >= thrownType.fuseMs) {
      // Cooked to the end: authority detonates it in the hand; nothing flies.
      this.rig?.cancelGrenade();
      return;
    }
    const launch = this.player.grenadeLaunchState(thrown.charge, thrownType.id, thrown.grenadeAim);
    if (!launch) {
      this.rig?.cancelGrenade();
      return;
    }
    this.effects?.projectileLaunch({
      type: thrownType.id,
      ...(thrownType.wallMine ? { n: launch.n, ...mineProfile } : {}),
      o: [launch.x, launch.y, launch.z],
      v: [launch.vx, launch.vy, launch.vz],
      fuse: thrownType.cook
        ? grenadeFuseAfterCook(thrown.cookMs, thrownType)
        : (thrownType.sticky ? thrownType.flightMaxMs : thrownType.fuseMs),
    }, { local: true });
    this.rig?.grenadeThrow(thrown.charge, thrown.type);
    if (thrownType.wallMine) sfx.grenadeDraw();
    else sfx.grenadeThrow(thrown.charge);
  }

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
    // Build mode keeps the fire chip: it places the blueprint instead of shooting.
    ctx.canFire = this.isAuthoritativeFireAllowed() || !!this.build?.active;
    ctx.canReload = !!(ammo && def && ammo.mag < def.magSize && ammo.reserve > 0
      && !this.weapon.isReloading);
    ctx.canInteract = this.isAuthoritativeInteractAllowed();
    ctx.weaponCount = Array.isArray(owned) ? owned.length + (this.matchState?.mode === 'ttt' ? 1 : 0) : WEAPON_IDS.length;
    ctx.canBuy = this.session.canOpenBuyMenu();
    ctx.canBuild = !!this.build?.available();
    ctx.canMedkit = this.player.medkit.active || (this.player.medkit.remaining === 1 && this.player.hp < 100);
    ctx.wheelOpen = this.weaponWheel.open;
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
      forward: fwdFromAngles(this.player.shotYaw, this.player.shotPitch),
      isVisible: (point) => !this.smokeObscures(this.camera.position, { x: point[0], y: point[1], z: point[2] })
        && this.rt.isWorldPointVisible(this._world, this.camera, point, 0.6),
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

  smokeObscures(from, to) {
    return smokeBlocksSight(this.smokeFields, [from.x, from.y, from.z], [to.x, to.y, to.z],
      (this.serverNow || 0) + Math.max(0, nowMs() - (this.smokeObservedAt || nowMs())));
  }

  weaponFrameContext() {
    const position = this.camera.position;
    return {
      allowFire: this.isAuthoritativeFireAllowed(),
      allowMelee: this.isAuthoritativeFireAllowed('melee'),
      grenadeHandling: this.player.grenadeHandling || this.player.medkit.active,
      alive: this.player.alive,
      crouching: this.player.crouchBool,
      speedXZ: this.player.speedXZ,
      panic: this.player.panic,
      exhaustion: this.player.exhaustion,
      pain: this.player.pain,
      yaw: this.player.shotYaw,
      pitch: this.player.shotPitch,
      cameraX: position.x,
      cameraY: position.y,
      cameraZ: position.z,
      generation: this._loopGeneration,
    };
  }

  loop(generation, frameAt = performance.now()) {
    if (!this.running || generation !== this._loopGeneration) return;
    this._rafId = requestAnimationFrame(at => { this._rafId = 0; this.loop(generation, at); });
    const cpuStart = performance.now();
    const renderFrame = this.frameRate.begin(frameAt, document.hidden);
    const frameDt = Math.min(0.25, this.clock.getDelta());
    const dt = Math.min(0.05, frameDt);
    const now = nowMs();
    this.session.syncGameplayInput();
    this.input.poll(now, dt);
    // Drain spectator motion before LocalPlayer consumes and discards dead-player look.
    const spectatorLook = this.spectator?.active ? this.input.consumeDelta() : null;
    this.weaponWheel.sync();
    if (this.input.scoreboardHeld !== this._padScoreboard) {
      this._padScoreboard = this.input.scoreboardHeld;
      this.hud.setScoreboard(this._padScoreboard);
    }
    this.player.update(dt, now, {
      weapon: this.weapon,
      movementAllowed: () => this.isAuthoritativeMovementAllowed(),
      fireAllowed: () => this.isAuthoritativeFireAllowed(),
      meleeAllowed: () => this.isAuthoritativeFireAllowed('melee'),
      grenadeAllowed: () => this.isAuthoritativeFireAllowed(true),
      weaponHandlingAllowed: () => !(this.rig?.grenadeActive ||
        (this.input.isGrenadeCharging() && this.selectedGrenadeCount() > 0)),
      interactAllowed: () => this.isAuthoritativeInteractAllowed(),
      toggleBuyMenu: () => {
        this.session.toggleBuyMenuFromInput();
        return this.hud.isBuyMenuOpen();
      },
      onWeaponIntents: (intents, at) => this.weapon.applyIntents(intents, at, {
        allowFire: this.isAuthoritativeFireAllowed(),
        allowMelee: this.isAuthoritativeFireAllowed('melee'),
        alive: this.player.alive,
        mode: this.matchState?.mode,
        owned: this.selfRow?.owned,
      }),
      beforeSend: (_frame, at) => {
        this.weapon.tickReload(at);
        try {
          return this.weapon.tryFire(at, this.weaponFrameContext());
        } catch (error) {
          this.phaseError('tryFire', error);
          return false;
        }
      },
      sendInput: (input) => this.net?.sendInput(input) || false,
      getNetworkWeaponState: () => ({
        slot: this.weapon.slot,
        // reloadIntent also carries a pending RIPTIDE return (R) until the server acks it.
        reloading: this.weapon.reloadIntent,
        reloadId: this.weapon.reloadId,
      }),
    });
    this.weapon.settleFrame(dt, { vaulting: !!this.player.physics.vault });
    // Own footfalls: quiet, unpositioned, so the player knows how loud they are.
    const ownStep = this.footsteps.update(dt, {
      speed: this.player.speedXZ, grounded: !!this.player.physics.grounded,
      crouch: this.player.crouchBool, swimming: !!this.player.physics.swimming,
    });
    if (ownStep > 0 && !this.spectator?.active) sfx.footstep(ownStep * 0.3, {
      body: this.player.physics, surface: footstepSurfaceAt(getBlock, this.player.physics.pos),
    });
    this.presentGrenadeHandling(now);
    const def = this.weapon.def;
    // Scope zoom steps (Z, wheel while scoped, R3, touch ZOOM) only while looking through the optic.
    const zoomSteps = this.input.consumeZoomStep();
    if (zoomSteps && this.weapon.scopeActive) {
      for (let i = 0; i < Math.abs(zoomSteps); i++) this.player.cycleScopeZoom(def);
    }
    this.input.setScopeZoomMode(!!this.weapon.scopeActive);
    if (this.spectator?.active) {
      if (this.camera.fov !== this.session.baseFov) {
        this.camera.fov = this.session.baseFov;
        this.camera.updateProjectionMatrix();
      }
    } else {
      this.player.updateCamera(dt, this.camera, def, this.weapon.adsT, this.session.baseFov, this.weapon.scopeActive);
      const blastShake = this.effects.currentShakeXY;
      this.camera.rotation.x += blastShake.y * (displaySettings().reducedMotion ? 0.15 : 1);
      this.camera.rotation.y += blastShake.x * (displaySettings().reducedMotion ? 0.15 : 1);
    }
    try {
      // Body velocity in the camera frame: +x strafing right, +z backing up. The rig uses
      // it for a lagged lateral lean so the carried gun swings against direction changes.
      const vel = this.player.physics.vel;
      const yaw = this.player.view.yaw;
      const lateralSpeed = vel.x * Math.cos(yaw) - vel.z * Math.sin(yaw);
      const forwardSpeed = -(vel.x * Math.sin(yaw) + vel.z * Math.cos(yaw));
      this.rig.update(frameDt, {
        medkitActive: this.player.alive && this.player.medkit.active,
        medkitProgress: this.player.medkit.progress,
        speed: this.player.speedXZ,
        lateralSpeed,
        forwardSpeed,
        grounded: this.player.physics.grounded,
        swimming: !!this.player.physics.swimming,
        vaulting: !!this.player.physics.vault,
        vaultProgress: this.player.physics.vault ? this.player.physics.vault.elapsed / VAULT_SECONDS : 0,
        verticalVelocity: this.player.physics.vel.y,
        isSprinting: !this.player.wantAds && this.player.keys.sprint && this.player.speedXZ > 4.6,
        crouch: this.player.crouchBool,
        proneT: this.player.physics.proneT,
        panic: this.player.panic,
        exhaustion: this.player.exhaustion,
        pain: this.player.pain,
        aimSwayScale: this.player.aimMotion?.rigMotionScale,
        reducedMotion: displaySettings().reducedMotion,
        weaponAim: this.player.weaponAim,
        weaponDef: this.weapon.def,
        shotYaw: this.player.shotYaw,
        shotPitch: this.player.shotPitch,
      });
      this.weapon.syncRigAds();
      const flameDirection = fwdFromAngles(this.player.shotYaw, this.player.shotPitch);
      this.effects.flames?.setLocalStream(this.weapon.flameFiring,
        [flameDirection.x, flameDirection.y, flameDirection.z],
        [this.camera.position.x, this.camera.position.y, this.camera.position.z]);
      this.effects.update(dt, frameDt);
      this.worldview.update(dt);
    } catch (error) { this.phaseError('fx/rig', error); }
    try {
      if (this.build) {
        this.build.update();
        const model = this.build.readModel();
        this.hud.setBuildState(model.active ? model : null);
        this.hud.setSelectedStructure(model.active ? model.kind : null);
      }
    } catch (error) { this.phaseError('build', error); }
    try {
      const view = this.net?.interpolate(performance.now());
      const presentedPlayers = this.spectator?.ensureTargetPresent(view?.players)
        || view?.players;
      if (presentedPlayers) this.roster.sync(presentedPlayers, dt, now, this.matchState?.mode === 'ttt');
      this.spectator?.update(presentedPlayers, dt, spectatorLook);
      this.roster.updateLabels(this.camera,
        (origin, direction, distance) => this.worldview.pickCameraRay(origin, direction, distance),
        this.matchState?.mode, this.selfRow?.team, (from, to) => this.smokeObscures(from, to));
    } catch (error) { this.phaseError('net/interp', error); }

    const spectating = this.spectator?.active === true;
    this.tttControls?.update();
    this.syncTouchContext();
    this.syncAimAssist(now);
    this.syncDeviceInfo(now);
    if (this.rig?.root) {
      this.rig.root.visible = this.rt.shouldShowViewmodel({
        spectating,
        scopeActive: this.weapon?.scopeActive,
      });
    }
    if (spectating && this.ownBody?.group) this.ownBody.group.visible = false;

    const beamAim = this.weapon.def.id === 'lance'
      ? this.worldview.pickCameraRay(this.camera.position, fwdFromAngles(this.player.shotYaw, this.player.shotPitch), HITSCAN_REACH)
      : null;
    const reticle = this.rt.projectAimReticle(this.camera, this.player.shotYaw, this.player.shotPitch);
    const weaponModel = this.weapon.readModel(now);
    // RIPTIDE pips: the HUD's in-flight, embedded and fabrication split lives with the
    // disc presentation (server launch/explode/glaiveStock events); `mag` stays authoritative.
    if (weaponModel.glaive) {
      weaponModel.glaive = { ...weaponModel.glaive, ...(this.effects?.glaiveHudState?.() || {}) };
    }
    this.hud.setState({
      crosshairX: reticle.x,
      crosshairY: reticle.y,
      crosshairDistance: beamAim?.t ?? 20,
      crosshairFov: this.camera.fov,
      crosshairHeight: innerHeight,
      hp: this.player.hp,
      medkit: this.player.medkit,
      armor: this.selfRow?.armor ?? 0,
      ...weaponModel,
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
      claymorePlacementValid: this._claymorePlacementValid,
      grenadeCook01: this._grenadeCook01,
      grenadeCookLeftMs: this._grenadeCookLeftMs,
      holdingBreath: !!this.player.aimMotion?.holdingBreath,
      breath01: this.player.aimMotion?.breathRemaining01 ?? 1,
      canHoldBreath: !!this.player.aimMotion?.canHoldBreath,
      breathExhausted: !!this.player.aimMotion?.breathExhausted,
      scopeZoom: this.player.scopeZoom,
    });
    sfx.breath(this.player.aimMotion?.breathEvent);
    sfx.painMoan(this.player.pain, now, {
      active: this.player.alive && !spectating && !document.hidden && !this.hud.settingsOpen,
      holding: !!this.player.aimMotion?.holdingBreath,
    });
    sfx.panicBreath(this.player.panic, now, {
      active: this.player.alive && !spectating && !document.hidden && !this.hud.settingsOpen,
      holding: !!this.player.aimMotion?.holdingBreath,
    });
    const hp = this.player.hp;
    const hpDanger = this.player.alive && hp < 35 ? (35 - hp) / 35 : 0;
    // Full panic alone throbs at 60% of near-death intensity: fear you can hear.
    const panicDanger = this.player.alive ? this.player.panic * 0.6 : 0;
    sfx.dangerPulse(Math.max(hpDanger, panicDanger), now);
    const forward = fwdFromAngles(this.player.aimYaw, this.player.aimPitch);
    sfx.setListener({
      fwd: [forward.x, forward.y, forward.z],
      pos: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
    });
    this._postFrame.smokeFields = this.smokeFields;
    this._postFrame.smokeNow = (this.serverNow || 0) + Math.max(0, now - (this.smokeObservedAt || now));
    this._postFrame.time = now / 1000;
    this._postFrame.burning = this.player.alive ? Math.min(1, this.player.burning * 2) : 0;
    this.post.reducedMotion = displaySettings().reducedMotion;
    this._postFrame.panic = this.player.alive ? this.player.panic : 0;
    this._postFrame.pain = this.player.alive ? this.player.pain : 0;
    this._postFrame.scopeActive = !!this.weapon?.scopeActive;
    this.roster.updateMuzzleLights(this.muzzleLights,
      this.rig.root.visible ? this.rig.flashLight : null, this.camera);
    const replaying = this.killcam?.update(frameDt, this.camera.aspect, this.session.baseFov);
    this.liveEffectsGroup.visible = !replaying;
    this.liveAvatarsGroup.visible = !replaying;
    this.worldview.powerups.group.visible = !replaying;
    const renderStart = performance.now();
    if (renderFrame && replaying) {
      this._postFrame.smokeFields = this.killcam.sample.smokeFields;
      this._postFrame.smokeNow = this.killcam.sample.time;
      this._postFrame.panic = this._postFrame.pain = this._postFrame.burning = 0;
      this._postFrame.scopeActive = this.killcam.scopeActive;
      this.post.render(this.worldview.scene, this.killcam.camera, this._postFrame);
    } else if (renderFrame) this.post.render(this.worldview.scene, this.camera, this._postFrame);
    const cpuEnd = performance.now();
    const frameStats = this.frameRate.end(cpuEnd - cpuStart, renderFrame ? cpuEnd - renderStart : 0);
    this.hud.setTelemetry(frameDt, this.net?.networkStats, now, frameStats);
  }

  phaseError(phase, error) {
    this.__phases ||= {};
    if ((this.__phases[phase] || 0) >= 5) return;
    this.__phases[phase] = (this.__phases[phase] || 0) + 1;
    console.error('[vb]', String(error?.message || error) + ' @' + phase);
  }

  disposeLiveResources() {
    sfx.stopCosmetics();
    this._liveReticle = null;
    this._menuReturn = true;
    this.muzzleLights?.dispose();
    this.muzzleLights = null;
    this._loopGeneration++;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
    this.running = false;
    this.clock?.stop();
    this.frameRate.reset();
    sfx.stopPainMoans();
    this._pendingAuthoritativeSnapshots = [];
    this._lastConsumedSnapSeq = null;
    this.feedback?.dispose();
    this.runHud?.dispose();
    this.tttControls?.dispose();this.tttControls=null;
    this.killcam?.dispose();
    this.killcam = null;
    this.spectator?.dispose();
    this.build?.dispose();
    this.build = null;
    this.hud.setBuildState?.(null);
    this.roster?.dispose();
    this.weapon?.dispose();
    if (this.ownBody) {
      this.worldview?.scene.remove(this.ownBody.group);
      this.rt.disposeFirstPersonBody(this.ownBody);
    }
    if (this.rig) this.rig.onReloadClick = null;
    this.rig?.dispose();
    this.effects?.dispose();
    this.worldview?.dispose();
    this.weaponWheel.reset();
    this.feedback = this.spectator = this.roster = this.weapon = this.ownBody = null;
    this.runHud = null;
    this.rig = this.effects = this.worldview = this.mapMeta = null;
    this.liveEffectsGroup = this.liveAvatarsGroup = null;
    this.playersCache = Object.freeze([]);
    this.matchState = this.selfRow = this.serverNow = null;
    this.smokeFields = [];
    this.player?.resetForMenu({ baseFov: this.session.baseFov });
  }

  disposeTerminalResources() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._debugInterval) clearInterval(this._debugInterval);
    if (this._onDebugError) window.removeEventListener('error', this._onDebugError, true);
    document.removeEventListener('visibilitychange', this._onFrameVisibility);
    this.player?.dispose();
    this.post?.dispose();
    this.post = null;
    this.renderer?.dispose();
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
    const info = game.renderer?.info || { memory: {}, render: {} };
    const player = game.player;
    const hist = {};
    if (game.worldview) {
      for (const child of game.worldview.scene.children) hist[child.type] = (hist[child.type] || 0) + 1;
    }
    const snapshots = game.net?.latestSnapshots || [];
    const turn = game.player?.weaponAim?.turn || game.rig?.turnLag;
    const weapon = game.weapon ? WEAPON_IDS[game.weapon.slot] : null;
    const def = game.weapon?.def;
    const counters = game.roster?.counters || {};
    const pos = player?.pos;
    return {
      localId: game.myId,
      alive: !!player?.alive,
      running: game.running,
      assets: assets.status,
      frameRate: game.frameRate.snapshot,
      hp: player?.hp ?? 100,
      feet: pos && [pos.x, pos.y, pos.z].every(Number.isFinite) ? { x: pos.x, y: pos.y, z: pos.z } : null,
      crouching: !!player?.crouchBool,
      pitch: player?.view.pitch ?? 0,
      yaw: player?.view.yaw ?? 0,
      weapon,
      weaponAttachments: def?.attachments || { optic: "standard", grip: "standard" },
      weaponHandling: def?.handling || null,
      weaponWeightKg: Number.isFinite(def?.weightKg) ? def.weightKg : null,
      flameStream: {
        active: !!game.weapon?.flameFiring,
        particles: game.effects?.flames?.geometry.instanceCount || 0,
        fuel: game.weapon?.ammoOf('flamethrower').mag ?? 0,
      },
      throwable: {
        type: GRENADE_TYPE_IDS[game.input.getGrenadeType()],
        counts: game.selfRow?.grenades || [],
        active: !!game.rig?.grenadeActive,
        held: !!game.rig?._throwableHands.held,
        visible: !!(game.rig?.root.visible && game.rig?._throwableHands.root.visible && game.rig?._throwableHands.grip.visible),
        armed: !!game.rig?._throwableHands._armed,
      },
      fireFields: game.effects?.fireFields.fields.size || 0,
      smokeFields: game.smokeFields?.length || 0,
      killcam: { active: !!game.killcam?.active, frames: game.killcam?.history.frames.length || 0,
        killer: game.killcam?.clip?.killer || null, time: game.killcam?.sample?.time ?? null },
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
      panic: player?.panic ?? 0,
      exhaustion: player?.exhaustion ?? 0,
      pain: player?.pain ?? 0,
      spawnProtected: !!player?.spawnProtected,
      ownBodyVisible: !!game.ownBody?.group.visible,
      dyingAvatars: counters.dyingAvatars || 0,
      runningAvatars: counters.runningAvatars || 0,
      maxAvatarSpeed: counters.maxAvatarSpeed || 0,
      scopeActive: !!game.weapon?.scopeActive,
      scopeZoom: player?.scopeZoom ?? 1,
      recoilClimb: { ...(player?.recoilClimb || {}) },
      reconcileOffset: player ? Math.hypot(
        player.reconcileOffset.x,
        player.reconcileOffset.y,
        player.reconcileOffset.z,
      ) : 0,
      device: game.input.deviceInfo(),
      shader: game.post?.stats || null,
      geometries: info.memory.geometries ?? 0,
      textures: info.memory.textures ?? 0,
      drawCalls: info.render.calls ?? 0,
      sceneObjects: game.worldview?.scene.children.length || 0,
      hist,
      ringLen: snapshots.length,
      lastSnapAgeMs: snapshots.length
        ? Math.round(performance.now() - (snapshots[snapshots.length - 1].recvLocalMs || 0))
        : null,
      ping: Math.round(game.net?.ping || 0),
      avatars: game.roster?.size || 0,
      chunks: game.worldview?.chunkStore.stats || null,
      damagedBlocks: game.net?.blockDamage?.size || 0,
    };
  },
  get wheelOpen() { return game.weaponWheel.open; },
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

const accountKeybindings = new AccountKeybindings();
window.addEventListener('vb-account-change', event => accountKeybindings.setAccount(event.detail.user?.id || null));
const accounts = new AccountMenu({ onOpen: () => { if (career.dialog.open) career.dialog.close(); } });
const career = new ProgressionTree({ accounts });

/** Leaving a match: drop the snapshot-driven reticle, restore the menu loadout, then re-read the career. */
function returnToMenuPresentation() {
  resetLocalPresentation();
  if (career.profile) applyLocalPresentation(career.profile.equipped);
  Promise.resolve().then(() => career.refresh()).catch(() => {});
}

// Background tasks in the order a match needs them. Each loader reports the
// real responses it observes; nothing is timed.
assets.define('models', { label: 'WEAPON & OPERATOR MODELS', weight: 55,
  load: (report) => observeResources(/\/assets\/blender\//, report, () => import('./engine/blender-assets.js')) });
assets.define('runtime', { label: 'ARENA & COMBAT SYSTEMS', weight: 20,
  load: (report) => observeResources(/\.js(\?|$)/, report, async () => {
    runtime = await import('./boot/match-runtime.js');
    applySnapshotBlocks = runtime.applySnapshotBlocks;
    return runtime;
  }) });
assets.define('audio', { label: 'SOUND SAMPLES', weight: 10,
  load: (report) => observeResources(/\/assets\/audio\//, report, () => sfx.preloadSamples()) });
// Prewarm only: the ARMORY dialog imports these itself when its WEAPONS tab opens.
assets.define('armory', { label: 'ARMORY', weight: 5,
  load: () => Promise.all([import('./ui/armory/weapon-bench.js'), import('./ui/model-viewer.js')]) });
assets.define('art', { label: 'SKYBOXES & HUD ART', weight: 5, load: (report) => prefetchArt(report) });

/** Count matching resource responses while `run` is pending; detail is files and bytes. */
function observeResources(pattern, report, run) {
  let files = 0, bytes = 0, observer = null;
  const note = (entries) => {
    for (const entry of entries) {
      if (!pattern.test(entry.name)) continue;
      files++;
      bytes += entry.transferSize || entry.encodedBodySize || 0;
    }
    const size = bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes > 0 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : '';
    report({ detail: `${files} FILES${size ? ` · ${size}` : ''}` });
  };
  try {
    observer = new PerformanceObserver((list) => note(list.getEntries()));
    observer.observe({ type: 'resource', buffered: false });
  } catch { /* the detail line is optional */ }
  return Promise.resolve().then(run).finally(() => observer?.disconnect());
}

/** Warm the HTTP cache for the skyboxes and HUD icons the first match will request. */
async function prefetchArt(report) {
  const grenadeIcon = (id) => `./assets/grenades/hud/${id}.${['smoke', 'limpet'].includes(id) ? 'svg' : 'png'}`;
  const urls = [...new Set([
    ...Object.keys(MAP_LABELS).map((map) => mapAtmosphere(map)?.skybox).filter(Boolean),
    ...WEAPON_IDS.map(weaponImagePath),
    ...GRENADE_TYPE_IDS.map(grenadeIcon),
  ])];
  let done = 0;
  await Promise.allSettled(urls.map(async (url) => {
    try { await fetch(url, { priority: 'low' }); } catch { /* optional warm-up */ }
    done++;
    report({ done, total: urls.length, detail: `${done} / ${urls.length} FILES` });
  }));
  return urls.length;
}

// Small "preparing assets 2 / 5" line in the menu; hidden once idle or in a match.
const assetStatusDom = {
  root: document.getElementById('asset-status'),
  count: document.getElementById('asset-status-count'),
  label: document.getElementById('asset-status-label'),
  detail: document.getElementById('asset-status-detail'),
};
function renderAssetStatus() {
  const { root, count, label, detail } = assetStatusDom;
  if (!root) return;
  const status = assets.status;
  const inMatch = document.getElementById('hud')?.classList.contains('hidden') === false;
  root.hidden = status.idle || inMatch;
  const countText = `${status.done} / ${status.total}`;
  if (count.textContent !== countText) count.textContent = countText;
  const labelText = status.active?.label || '';
  if (label.textContent !== labelText) label.textContent = labelText;
  const detailText = status.active?.detail || '';
  if (detail.textContent !== detailText) detail.textContent = detailText;
  // Gate every menu play action until the match set is ready. Failed tasks
  // count as ready: the join path retries them under the loading screen.
  const blocked = MATCH_ASSETS.some((id) => {
    const state = assets.get(id)?.status;
    return state !== 'done' && state !== 'failed';
  });
  hudRef?.menu?.setPlayReady?.(!blocked, {
    fraction: assets.fraction(MATCH_ASSETS),
    label: blocked && status.active ? `LOADING ${status.active.label}…` : '',
  });
}

window.__vbAssets = Object.freeze({
  get status() { return assets.status; },
  get idle() { return assets.status.idle; },
  require: (ids) => assets.require(ids),
});

loadingScreen?.update('Loading your account…');
loadingScreen?.step('account', { status: 'active' });
await accounts.start();
window.__vbBoot?.phases && (window.__vbBoot.phases.account = Math.round(performance.now() - window.__vbBoot.startedAt));
loadingScreen?.step('account', { status: 'done' });
loadingScreen?.update('Loading your career and equipment…');
loadingScreen?.step('career', { status: 'active' });
await career.start();
window.__vbBoot?.phases && (window.__vbBoot.phases.career = Math.round(performance.now() - window.__vbBoot.startedAt));
loadingScreen?.step('career', { status: 'done' });
game.session.start();
window.__vbBoot?.phases && (window.__vbBoot.phases.menu = Math.round(performance.now() - window.__vbBoot.startedAt));

// The menu is interactive now. Let it paint, then load the rest in the background.
const startBackgroundLoads = () => { void assets.startAll(); };
requestAnimationFrame(() => setTimeout(startBackgroundLoads, 0));
setTimeout(startBackgroundLoads, 1000);
