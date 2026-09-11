import { reactorDefenderSolid } from '../shared/world/reactor-layout.js';
import { FlameSystem, updateBurn } from './sim/fire.js';
// Authoritative fixed-step simulation facade. Transport, room management and
// map delivery stay outside; focused simulation modules own player state,
// movement, combat and spawn selection.

import {
  AIR,
  worldDimensions,
  createMapState,
  getMapMeta,
} from '../shared/worlddata.js';
import { DEFAULT_MAP_ID } from '../shared/modes.js';
import { NETWORK_PRESENTATION } from '../shared/networking.js';
import { TICK_MS } from './protocol/admission.js';
import { TickTiming } from './diagnostics.js';
import { KILLCAM, supportsKillcam } from '../shared/killcam-rules.js';
import { makeSnapshot } from './protocol/snapshot.js';
import { medkitMovement, medkitCombat } from '../shared/medkit.js';
import { interruptMedkit, updateMedkit } from './sim/medkit.js';
import { evKill, evRespawn, evDie } from './protocol/events.js';
import { ModeController } from './modes.js';
import {
  PlayerEntity,
  clampWeaponSlot,
  wrapAngle,
} from './sim/player.js';
import { stepMovement, updateCondition, updateTimers } from './sim/movement.js';
import { resolveWeaponIntent } from './sim/combat.js';
import { SpawnSelector } from './sim/spawn.js';
import { ProjectileSystem } from './sim/projectiles.js';
import { createSimulationContexts } from './sim/context.js';
import { CHAOS_CASH_RULES } from '../shared/powerups.js';
import { findChaosCashSites } from '../shared/chaos-cash-sites.js';
import { PowerupSystem } from './sim/powerups.js';
import { findPowerupSites, isPowerupSiteSupported } from '../shared/powerup-sites.js';
import {
  clampGrenadeCharge,
  clampGrenadeCook,
  clampGrenadeType,
  grenadeTypeAt,
} from '../shared/grenade-rules.js';

const MAX_PITCH = (89 * Math.PI) / 180;
const SPAWN_PROTECTION_MS = 1500;

export class GameEngine {
  constructor(callbacks = {}) {
    this.broadcast = callbacks.broadcast || (() => {});
    const fallbackMapId = typeof callbacks.mapMeta?.id === 'string'
      ? callbacks.mapMeta.id
      : DEFAULT_MAP_ID;
    this.world = callbacks.world || createMapState(fallbackMapId);
    this.mapMeta = callbacks.mapMeta || this.world.meta || getMapMeta(fallbackMapId);
    this.solidAt = (x, y, z) => this.world.getBlock(x, y, z) !== AIR;

    this.defenderSolidAt = (x,y,z) => this.solidAt(x,y,z) || reactorDefenderSolid(x,y,z);

    this.entities = new Map();
    this.npcs = new Map();
    this.combatants = {
      *values() { yield* this.humans.values(); yield* this.npcs.values(); },
      humans: this.entities, npcs: this.npcs,
      get(id) { return this.humans.get(id) || this.npcs.get(id); },
      has(id) { return this.humans.has(id) || this.npcs.has(id); },
    };
    this.objectives = new Map();
    this.changedBlocks = new Set();
    const genericSpawns = Array.isArray(this.mapMeta?.spawns?.fun)
      ? this.mapMeta.spawns.fun
      : [];
    this.spawnPoints = (genericSpawns.length ? genericSpawns : this.world.findSpawns(12))
      .map((spawn) => ({ ...spawn }));

    this.now = Date.now();
    this.intervalMs = TICK_MS;
    this.running = false;
    this.timer = null;
    this.tickTiming = new TickTiming();
    this.blockHp = new Map();
    this.blockMining = new Map();
    this.blockDamage = new Map();
    this.tickBlockDamage = new Map();
    this.tickBlocks = [];
    this.tickEvents = [];
    this.tickHooks = [];
    this.projectiles = new ProjectileSystem();
    this.flames = new FlameSystem();

    this.mode = new ModeController(this, { mode: callbacks.mode, mapMeta: this.mapMeta });
    this.powerups = new PowerupSystem({
      solidAt: this.solidAt,
      findSites: () => findPowerupSites(this.world, this.mapMeta),
      isSupported: (site) => isPowerupSiteSupported(this.world, site),
      rng: callbacks.powerupRng,
      now: this.now,
    });
    let cashSites;
    this.cash = new PowerupSystem({
      solidAt: this.solidAt,
      findSites: () => cashSites ??= findChaosCashSites(this.world, this.mapMeta),
      isSupported: (site) => isPowerupSiteSupported(this.world, site),
      rng: callbacks.powerupRng, now: this.now,
      rules: CHAOS_CASH_RULES, types: ['cash'], prefix: 'cash',
    });
    this.contexts = createSimulationContexts(this);
    this.spawnSelector = new SpawnSelector({
      entities: this.entities,
      isEnemy: (left, right) => this.mode.isEnemy(left, right),
      solidAt: this.solidAt,
      spawnBounds: this.mapMeta?.spawnBounds,
      dimensions: this.world.dimensions,
      now: this.now,
    });
  }

  start(tickRateMs = TICK_MS) {
    if (this.running) return this;
    this.intervalMs = tickRateMs;
    this.running = true;
    let previous = performance.now();
    this.timer = setInterval(() => {
      const at = performance.now();
      try { this.step(this.intervalMs); } finally {
        const finished = performance.now();
        this.tickTiming.record(finished, finished - at, at - previous);
        previous = at;
      }
    }, tickRateMs);
    return this;
  }

  stop() {
    this.running = false;
    this.projectiles.clear();
    this.flames.clear();
    this.powerups.clear();
    this.cash.clear();
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this;
  }

  discardPendingEventsFor(id) {
    const key = String(id);
    for (let i = this.tickEvents.length - 1; i >= 0; i--) {
      if (String(this.tickEvents[i]?.id ?? '') === key) this.tickEvents.splice(i, 1);
    }
  }

  registerTickHook(fn) {
    this.tickHooks.push(fn);
    return () => {
      const index = this.tickHooks.indexOf(fn);
      if (index >= 0) this.tickHooks.splice(index, 1);
    };
  }

  step(intervalMs = this.intervalMs) {
    const dt = intervalMs / 1000;
    this.now += intervalMs;
    this.spawnSelector.setNow(this.now);

    this.mode.beforeTick(dt);

    for (let i = 0; i < this.tickHooks.length; i++) {
      try { this.tickHooks[i](dt); } catch { /* a broken hook never kills the sim */ }
    }

    for (const player of this.combatants.values()) updateTimers(player, dt);
    for (const player of this.combatants.values()) {
      if (player.state === 'alive') this.integrate(player, dt);
    }
    for (const player of this.combatants.values()) {
      if (player.state === 'alive') updateCondition(player, dt);
    }
    const combat = this.contexts.combat;
    for (const player of this.combatants.values()) updateBurn(player, dt, combat);
    this.flames.step(dt, combat);
    this.projectiles.step(dt, this.contexts.projectiles);
    for (const player of this.combatants.values()) {
      player.firing = false;
      if (player.state === 'alive') resolveWeaponIntent(player, dt, combat);
    }
    for (const player of this.combatants.values()) {
      updateMedkit(player, dt, this.mode.phase === 'live');
    }
    // Clear ended rounds before a policy can reset directly into live play.
    if (this.mode.phase !== 'live') {
      this.powerups.clear();
      this.cash.clear();
      this.projectiles.fire.clear();
      this.projectiles.smoke.clear();
    }
    this.mode.tick();
    if (this.mode.phase !== 'live') { this.projectiles.fire.clear(); this.projectiles.smoke.clear(); }
    this.processRespawns();
    for (const pickups of [this.powerups, this.cash]) pickups.step({
      now: this.now, mode: this.mode.mode, phase: this.mode.phase, round: this.mode.round,
      entities: this.entities, pushEvent: (event) => this.tickEvents.push(event),
    });

    const players = Array.from(this.combatants.values());
    for (const player of players) Object.assign(player, this.mode.playerSnapshot(player));
    const snapshot = makeSnapshot(
      players,
      this.tickBlocks,
      this.tickEvents,
      this.now,
      this.mode.matchSnapshot(),
      Array.from(this.tickBlockDamage.values()),
      [...this.powerups.snapshot(), ...this.cash.snapshot()],
      this.projectiles.fire.snapshot(),
      this.projectiles.smoke.snapshot(),
      this.projectiles.mineSnapshot(this.now),
      this.world.dimensions,
    );

    this.tickBlocks.length = 0;
    this.tickBlockDamage.clear();
    this.tickEvents.length = 0;
    this.broadcast(snapshot);
  }

  selectSafestSpawn(pool, player = null, excludeIndex = -1) {
    this.spawnSelector.setNow(this.now);
    return this.spawnSelector.pick(pool, player, excludeIndex, {
      variety: ['fun', 'tdm', 'gungame'].includes(this.mode.mode),
    });
  }

  nextSpawnFor(player, excludeIndex) {
    return this.selectSafestSpawn(this.spawnPoints, player, excludeIndex);
  }

  addClient(id, name) {
    const pid = String(id);
    const existing = this.entities.get(pid);
    if (!existing) {
      const normalizedName = String(name || '').trim().slice(0, 24)
        || 'Player-' + pid.slice(-4);
      const player = new PlayerEntity(pid, normalizedName, this.nextSpawnFor(null, -1), false, this.world.dimensions);
      this.entities.set(pid, player);
      this.mode.onPlayerAdd(player);
    }
    return this.spawnInfoFor(this.entities.get(pid));
  }

  addBot(id, name) {
    const pid = String(id);
    let normalizedName = name == null ? null : String(name).slice(0, 24);
    const existing = this.entities.get(pid);
    if (existing) return this.spawnInfoFor(existing);
    if (!normalizedName) normalizedName = 'BOT-' + pid.replace(/[^0-9]/g, '');
    const player = new PlayerEntity(pid, normalizedName, this.nextSpawnFor(null, -1), true, this.world.dimensions);
    this.entities.set(pid, player);
    this.mode.onPlayerAdd(player);
    return this.spawnInfoFor(player);
  }

  /** NPC ownership stays with the mode, separate from lobby/pseudo-client bots. */
  addNpc(id, profile, spawn, role) {
    if (this.entities.has(id)) return this.entities.get(id);
    const npc = new PlayerEntity(id, profile.name, spawn, true, this.world.dimensions);
    npc.npcRole = role;
    npc.npcSpeed = profile.speed;
    npc.hp = profile.hp;
    npc.armor = profile.armor;
    npc.team = 'bravo';
    this.entities.set(id, npc);
    return npc;
  }

  restoreWorld() {
    const { sx: SX, sz: SZ } = worldDimensions(this.world);
    const pristine = createMapState(this.mapMeta.id);
    for (const i of [...this.changedBlocks]) {
      const x = i % SX, z = Math.floor(i / SX) % SZ, y = Math.floor(i / (SX * SZ));
      const value = pristine.getBlock(x, y, z);
      this.world.setBlock(x, y, z, value);
      this.pushBlockDelta(x, y, z, value);
    }
    this.changedBlocks.clear();
    // Damage that never removed a voxel must also reset between runs.
    for (const row of this.blockDamage.values()) {
      this.tickBlockDamage.set(`${row.x},${row.y},${row.z}`, { ...row, progress: 0 });
    }
    this.blockDamage.clear(); this.blockHp.clear(); this.blockMining.clear();
  }

  /** Transfer one live bot entity to a human without resetting its sim state. */
  takeoverBot(botId, humanId, name) {
    const priorId = String(botId);
    const pid = String(humanId);
    const player = this.entities.get(priorId);
    if (!player?.bot || !pid || this.entities.has(pid)) return null;
    if (!this.mode.onPlayerTakeover(player, pid)) return null;

    this.entities.delete(priorId);
    this.discardPendingEventsFor(priorId);
    player.id = pid;
    player.name = String(name || '').trim().slice(0, 24) || 'Player-' + pid.slice(-4);
    player.bot = false;
    player.input = null;
    player.triggerPrev = false;
    player.fireEdgeQueued = false;
    player.fireAimQueued = null;
    player.quickMeleeQueued = null;
    player.grenadeHandlingQueued = false;
    player.grenadeEdgeQueued = false;
    player.grenadeChargeQueued = 0;
    player.grenadeTypeQueued = 0;
    player.grenadeCookQueued = 0;
    player.grenadeAimQueued = null;
    player.charging = false;
    player.chargeT = 0;
    player.charge = 0;
    this.entities.set(pid, player);
    return this.spawnInfoFor(player);
  }

  removeClient(id) {
    const pid = String(id);
    const player = this.entities.get(pid);
    if (player) this.mode.onPlayerRemove(player);
    this.entities.delete(pid);
  }

  spawnInfoFor(player) {
    return {
      id: player.id,
      name: player.name,
      bot: player.bot,
      spawn: {
        x: +player.x.toFixed(2),
        y: +player.y.toFixed(2),
        z: +player.z.toFixed(2),
      },
      hp: player.hp,
      weapon: player.weapon,
      state: player.state,
      tickRate: Math.round(1000 / this.intervalMs),
    };
  }

  applyInput(id, msg) {
    const player = this.entities.get(String(id));
    if (!player || !msg || typeof msg !== 'object') return;
    const previous = player.input;
    const keys = msg.keys || {};
    const input = {
      seq: Number.isFinite(msg.seq) ? msg.seq | 0 : (previous ? previous.seq : 0),
      keys: {
        f: !!keys.f,
        b: !!keys.b,
        l: !!keys.l,
        r: !!keys.r,
        jump: !!keys.jump,
        sprint: !!keys.sprint,
        crouch: !!keys.crouch,
        prone: !!keys.prone,
        interact: !!keys.interact,
      },
      wantFire: !!msg.wantFire,
      quickMelee: !!msg.quickMelee,
      wantAds: !!msg.wantAds,
      reload: !!msg.reload,
      cancelMedkit: !!msg.cancelMedkit,
      reloadId: Number.isSafeInteger(msg.reloadId) && msg.reloadId > 0 ? msg.reloadId : 0,
      throwGrenade: !!msg.throwGrenade,
      grenadeHandling: !!msg.grenadeHandling || !!msg.throwGrenade,
      grenadeCharge: clampGrenadeCharge(msg.grenadeCharge),
      grenadeType: clampGrenadeType(msg.grenadeType),
      grenadeCook: clampGrenadeCook(msg.grenadeCook, grenadeTypeAt(msg.grenadeType)),
      viewAge: Number.isFinite(msg.viewAge)
        ? Math.max(
          NETWORK_PRESENTATION.minViewAgeMs,
          Math.min(NETWORK_PRESENTATION.maxViewAgeMs, msg.viewAge),
        )
        : (previous?.viewAge ?? NETWORK_PRESENTATION.defaultViewAgeMs),
      switchTo: undefined,
    };
    input.yaw = Number.isFinite(msg.yaw)
      ? wrapAngle(msg.yaw)
      : (previous ? previous.yaw : player.yaw);
    input.pitch = Number.isFinite(msg.pitch)
      ? Math.max(-MAX_PITCH, Math.min(MAX_PITCH, msg.pitch))
      : (previous ? previous.pitch : player.pitch);
    // Carry/turn lag changes weapon aim without steering the player's feet.
    // Older clients omit viewYaw and retain their original movement convention.
    input.viewYaw = Number.isFinite(msg.viewYaw) ? wrapAngle(msg.viewYaw) : input.yaw;
    const requestedWeapon = msg.switchTo != null ? msg.switchTo : msg.weapon;
    if (Number.isFinite(requestedWeapon)) input.switchTo = clampWeaponSlot(requestedWeapon);
    if (player.bastionRelease) {
      if (!input.wantFire && !input.throwGrenade && !input.grenadeHandling && !input.quickMelee) player.bastionRelease = false;
      input.wantFire = input.throwGrenade = input.grenadeHandling = input.quickMelee = false;
    }
    if (input.grenadeHandling) {
      input.quickMelee = false;
      player.quickMeleeQueued = null;
      input.wantFire = false;
      input.wantAds = false;
      input.reload = false;
      input.switchTo = undefined;
      player.fireEdgeQueued = false;
      player.fireAimQueued = null;
      // Preserve the interruption if a later input arrives before the next tick.
      player.grenadeHandlingQueued = true;
    }
    if (input.quickMelee && !previous?.quickMelee) {
      const aim = msg.meleeAim;
      player.quickMeleeQueued = Number.isFinite(aim?.yaw) && Number.isFinite(aim?.pitch)
        ? { yaw: wrapAngle(aim.yaw), pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, aim.pitch)) }
        : { yaw: input.yaw, pitch: input.pitch };
    }
    if (input.wantFire && !(previous && previous.wantFire)) {
      player.fireEdgeQueued = true;
      // Later look/recoil packets must not redirect a click waiting for a tick.
      player.fireAimQueued = { yaw: input.yaw, pitch: input.pitch };
    }
    if (input.throwGrenade && !(previous && previous.throwGrenade)) {
      player.grenadeEdgeQueued = true;
      player.grenadeChargeQueued = input.grenadeCharge;
      player.grenadeTypeQueued = input.grenadeType;
      player.grenadeCookQueued = input.grenadeCook;
      // Freeze the release independently of gun aim in this and later inputs.
      // Legacy or malformed payloads use the sanitized input direction.
      player.grenadeAimQueued = Number.isFinite(msg.grenadeAim?.yaw) && Number.isFinite(msg.grenadeAim?.pitch)
        ? { yaw: wrapAngle(msg.grenadeAim.yaw), pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, msg.grenadeAim.pitch)) }
        : { yaw: input.yaw, pitch: input.pitch };
    }
    if (Number.isSafeInteger(msg.medkitId) && msg.medkitId > player.medkit.ack) {
      player.medkitRequest = Math.max(player.medkitRequest, msg.medkitId);
    }
    if (input.cancelMedkit || medkitMovement(input.keys) || medkitCombat(input, player.weapon)) {
      if (player.medkit.active || player.medkitRequest) interruptMedkit(player);
    }
    player.input = input;
  }

  integrate(player, dt) {
    const ctx = this.contexts.movement;
    ctx.solidAt = this.mode.mode === 'bastion' && !player.npcRole ? this.defenderSolidAt : this.solidAt;
    ctx.movementLocked = !this.mode.canMove(player);
    return stepMovement(player, dt, ctx);
  }

  forceRespawn(player) {
    if (!player || typeof player !== 'object') return false;
    if (player.state === 'alive') this.killPlayer(player, null, 'world', false);
    if (!this.mode.canRespawn(player)) return false;
    this.respawnPlayer(player, this.mode.chooseSpawn(player, player.lastSpawnIndex));
    this.mode.onPlayerRespawn(player);
    return true;
  }

  pushBlockDelta(x, y, z, value) {
    // Any block replacement (including a repair to the same type) is fresh.
    const key = `${x},${y},${z}`;
    this.blockHp.delete(key);
    this.blockMining.delete(key);
    if (this.blockDamage.delete(key)) {
      this.tickBlockDamage.set(key, { x, y, z, v: value, progress: 0 });
    }
    const { sx: SX, sz: SZ } = worldDimensions(this.world);
    const i = ((y * SZ) + z) * SX + x;
    this.changedBlocks.add(i);
    this.tickBlocks.push({ i, v: value });
  }

  pushBlockDamage(x, y, z, value, progress) {
    const key = `${x},${y},${z}`;
    const row = { x, y, z, v: value, progress };
    this.blockDamage.set(key, row);
    this.tickBlockDamage.set(key, row);
  }

  killPlayer(victim, killer, weaponKey, headshot, markers = null) {
    if (victim.state !== 'alive') return;
    if (victim.objective) {
      victim.hp = 0;
      victim.state = 'dead';
      return;
    }
    const damage = victim.hp <= 0 && victim.lastDamage?.lethal ? victim.lastDamage : null;
    victim.hp = 0;
    victim.armor = 0;
    interruptMedkit(victim);
    victim.state = 'dead';
    victim.burn = null;
    victim.burning = 0;
    victim.deaths++;
    victim.firing = false;
    victim.ads = false;
    victim.adsT = 0;
    victim.reloading = false;
    victim.reloadStage = null;
    victim.reloadLoose = 0;
    victim.bloom = 0;
    victim.charging = false;
    victim.chargeT = 0;
    victim.charge = 0;
    victim.spawnProtectedUntil = 0;
    victim.vx = 0;
    victim.vy = 0;
    victim.vz = 0;
    const modeContext = { weapon: weaponKey || '' };
    const shotTraits = {
      longRange: !!markers?.longRange,
      noScope: !!markers?.noScope,
      damage,
    };
    if (killer && killer !== victim && killer.id !== victim.id) {
      killer.kills++;
      killer.score += this.mode.killScoreDelta(victim, killer, modeContext);
    }
    this.mode.onPlayerDeath(victim, killer, modeContext);
    // Human replay time is authoritative; bots and world deaths keep mode pacing.
    if (!victim.bot && killer && killer.id !== victim.id && supportsKillcam(this.mode.mode)
        && Number.isFinite(victim.respawnAt)) {
      victim.respawnAt = Math.max(victim.respawnAt, this.now + KILLCAM.respawnMs);
    }
    this.tickEvents.push(evDie(victim.id, damage));
    this.tickEvents.push(evKill(
      killer ? killer.id : '',
      victim.id,
      weaponKey || '',
      !!headshot,
      shotTraits,
    ));
    victim.spawnProtected = false;
  }

  respawnPlayer(player, spawn = null, { emitEvent = true, protect = false } = {}) {
    const entity = player && typeof player === 'object'
      ? player
      : this.entities.get(String(player));
    if (!entity) return false;
    const next = spawn || this.nextSpawnFor(entity, entity.lastSpawnIndex);
    entity.applySpawn(next);
    entity.spawnProtectedUntil = protect ? this.now + SPAWN_PROTECTION_MS : 0;
    entity.spawnProtected = !!protect;
    if (emitEvent) this.tickEvents.push(evRespawn(entity.id, entity.x, entity.y, entity.z));
    return true;
  }

  processRespawns() {
    for (const player of this.entities.values()) {
      if (player.state === 'dead'
          && this.now >= player.respawnAt
          && this.mode.canTimedRespawn(player)) {
        this.respawnPlayer(
          player,
          this.mode.chooseSpawn(player, player.lastSpawnIndex),
          { protect: true },
        );
        this.mode.onPlayerRespawn(player);
      }
    }
  }
}
