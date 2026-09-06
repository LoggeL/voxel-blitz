// Authoritative fixed-step simulation facade. Transport, room management and
// map delivery stay outside; focused simulation modules own player state,
// movement, combat and spawn selection.

import {
  AIR,
  SX,
  SZ,
  createMapState,
  getMapMeta,
} from '../shared/worlddata.js';
import { DEFAULT_MAP_ID } from '../shared/modes.js';
import { NETWORK_PRESENTATION } from '../shared/networking.js';
import { TICK_MS, makeSnapshot, evKill, evRespawn, evDie } from './protocol.js';
import { ModeController } from './modes.js';
import {
  PHYSICS,
  PlayerEntity,
  aimAngles,
  clampWeaponSlot,
  fwdFromYawPitch,
  wrapAngle,
} from './sim/player.js';
import { stepMovement, updateCondition, updateTimers } from './sim/movement.js';
import {
  SHOT_REACH,
  blockKey,
  canFire,
  computeConeDeg,
  damageBlock,
  destroyBlock,
  destroyBlockDirect,
  fireOneShot,
  nearestVictim,
  rayAABB,
  resolveWeaponIntent,
  rewindVictim,
  switchWeapon,
} from './sim/combat.js';
import { SpawnSelector } from './sim/spawn.js';
import { ProjectileSystem } from './sim/projectiles.js';
import {
  clampGrenadeCharge,
  clampGrenadeCook,
  clampGrenadeType,
  grenadeTypeAt,
} from '../shared/grenade-rules.js';

export { PHYSICS, SHOT_REACH, aimAngles, fwdFromYawPitch };

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

    this.entities = new Map();
    this.humanIds = new Set();
    const genericSpawns = Array.isArray(this.mapMeta?.spawns?.fun)
      ? this.mapMeta.spawns.fun
      : [];
    this.spawnPoints = (genericSpawns.length ? genericSpawns : this.world.findSpawns(12))
      .map((spawn) => ({ ...spawn }));

    this.now = Date.now();
    this.tickNo = 0;
    this.intervalMs = TICK_MS;
    this.running = false;
    this.timer = null;
    this.blockHp = new Map();
    this.tickBlocks = [];
    this.tickEvents = [];
    this.tickHooks = [];
    this.projectiles = new ProjectileSystem();

    this.mode = new ModeController(this, { mode: callbacks.mode, mapMeta: this.mapMeta });
    this.spawnSelector = new SpawnSelector({
      entities: this.entities,
      isEnemy: (left, right) => this.mode.isEnemy(left, right),
      solidAt: this.solidAt,
      now: this.now,
    });
    // Retain the established observable map while ownership lives in SpawnSelector.
    this.spawnUseTimes = this.spawnSelector.spawnUseTimes;
  }

  start(tickRateMs = TICK_MS) {
    if (this.running) return this;
    this.intervalMs = tickRateMs;
    this.running = true;
    this.timer = setInterval(() => this.step(this.intervalMs), tickRateMs);
    return this;
  }

  stop() {
    this.running = false;
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
    this.tickNo++;
    this.spawnSelector.setNow(this.now);

    for (let i = 0; i < this.tickHooks.length; i++) {
      try { this.tickHooks[i](dt); } catch { /* a broken hook never kills the sim */ }
    }

    for (const player of this.entities.values()) this.updateTimers(player, dt);
    for (const player of this.entities.values()) {
      if (player.state === 'alive') this.integrate(player, dt);
    }
    for (const player of this.entities.values()) {
      if (player.state === 'alive') this.updateCondition(player, dt);
    }
    this.projectiles.step(dt, this.projectileContext());
    for (const player of this.entities.values()) {
      player.firing = false;
      if (player.state === 'alive') this.resolveWeaponIntent(player, dt);
    }
    this.mode.tick();
    this.processRespawns();

    const players = Array.from(this.entities.values());
    for (const player of players) Object.assign(player, this.mode.playerSnapshot(player));
    const snapshot = makeSnapshot(
      players,
      this.tickBlocks,
      this.tickEvents,
      this.now,
      this.mode.matchSnapshot(),
    );

    this.tickBlocks.length = 0;
    this.tickEvents.length = 0;
    this.broadcast(snapshot);
  }

  selectSafestSpawn(pool, player = null, excludeIndex = -1) {
    this.spawnSelector.setNow(this.now);
    return this.spawnSelector.pick(pool, player, excludeIndex);
  }

  enemyHasSpawnLos(enemy, point) {
    return this.spawnSelector.enemyHasSpawnLos(enemy, point);
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
      const player = new PlayerEntity(pid, normalizedName, this.nextSpawnFor(null, -1), false);
      this.entities.set(pid, player);
      this.humanIds.add(pid);
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
    const player = new PlayerEntity(pid, normalizedName, this.nextSpawnFor(null, -1), true);
    this.entities.set(pid, player);
    this.mode.onPlayerAdd(player);
    return this.spawnInfoFor(player);
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
    player.grenadeEdgeQueued = false;
    player.grenadeChargeQueued = 0;
    player.grenadeTypeQueued = 0;
    player.grenadeCookQueued = 0;
    player.charging = false;
    player.chargeT = 0;
    player.charge = 0;
    this.entities.set(pid, player);
    this.humanIds.add(pid);
    return this.spawnInfoFor(player);
  }

  removeClient(id) {
    const pid = String(id);
    const player = this.entities.get(pid);
    if (player) this.mode.onPlayerRemove(player);
    this.entities.delete(pid);
    this.humanIds.delete(pid);
  }

  renameClient(id, name) {
    const player = this.entities.get(String(id));
    if (player) player.name = String(name || '').trim().slice(0, 24) || player.name;
    return player ? this.spawnInfoFor(player) : null;
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

  get count() { return this.humanIds.size; }
  get population() { return this.entities.size; }
  get players() { return Array.from(this.entities.values()); }
  get stats() {
    let bots = 0;
    let alive = 0;
    for (const player of this.entities.values()) {
      if (player.bot) bots++;
      if (player.state === 'alive') alive++;
    }
    return {
      now: this.now,
      tick: this.tickNo,
      players: this.entities.size,
      humans: this.humanIds.size,
      bots,
      alive,
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
        interact: !!keys.interact,
      },
      wantFire: !!msg.wantFire,
      wantAds: !!msg.wantAds,
      reload: !!msg.reload,
      throwGrenade: !!msg.throwGrenade,
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
    const requestedWeapon = msg.switchTo != null ? msg.switchTo : msg.weapon;
    if (Number.isFinite(requestedWeapon)) input.switchTo = clampWeaponSlot(requestedWeapon);
    if (input.wantFire && !(previous && previous.wantFire)) player.fireEdgeQueued = true;
    if (input.throwGrenade && !(previous && previous.throwGrenade)) {
      player.grenadeEdgeQueued = true;
      player.grenadeChargeQueued = input.grenadeCharge;
      player.grenadeTypeQueued = input.grenadeType;
      player.grenadeCookQueued = input.grenadeCook;
    }
    player.input = input;
  }

  updateTimers(player, dt) { return updateTimers(player, dt); }
  updateCondition(player, dt) { return updateCondition(player, dt); }

  integrate(player, dt) {
    return stepMovement(player, dt, {
      solidAt: this.solidAt,
      mapMeta: this.mapMeta,
      now: this.now,
      movementLocked: !this.mode.canMove(player),
      onFall: (entity, reason) => {
        if (reason === 'invalid') this.forceRespawn(entity);
        else this.killPlayer(entity, null, 'world', false);
      },
    });
  }

  forceRespawn(player) {
    if (!player || typeof player !== 'object') return false;
    if (player.state === 'alive') this.killPlayer(player, null, 'world', false);
    if (!this.mode.canRespawn(player)) return false;
    this.respawnPlayer(player, this.mode.chooseSpawn(player, player.lastSpawnIndex));
    this.mode.onPlayerRespawn(player);
    return true;
  }

  computeConeDeg(player) { return computeConeDeg(player); }

  resolveWeaponIntent(player, dt = this.intervalMs / 1000) {
    return resolveWeaponIntent(player, dt, this.combatContext());
  }

  switchWeapon(player, slot) { return switchWeapon(player, slot); }

  canFire(player, fireEdge = false) {
    return canFire(player, fireEdge, { canFire: (entity) => this.mode.canFire(entity) });
  }

  rayAABB(...args) { return rayAABB(...args); }
  rewindVictim(player) { return rewindVictim(player, this.now); }

  nearestVictim(shooter, origin, direction, limit) {
    return nearestVictim(shooter, origin, direction, limit, this.combatContext());
  }

  fireOneShot(player) { return fireOneShot(player, this.combatContext()); }
  blockKey(x, y, z) { return blockKey(x, y, z); }

  damageBlock(x, y, z, type, damage) {
    return damageBlock(x, y, z, type, damage, this.combatContext());
  }

  destroyBlock(x, y, z, key) {
    return destroyBlock(x, y, z, key, this.combatContext());
  }

  pushBlockDelta(x, y, z, value) {
    this.tickBlocks.push({ i: ((y * SZ) + z) * SX + x, v: value });
  }

  combatContext() {
    return {
      canFire: (player) => this.mode.canFire(player),
      canUseWeapon: (player, weapon) => this.mode.canUseWeapon(player, weapon),
      killPlayer: (victim, killer, weapon, headshot, markers) => {
        this.killPlayer(victim, killer, weapon, headshot, markers);
      },
      getBlock: (x, y, z) => this.world.getBlock(x, y, z),
      setBlock: (x, y, z, value) => this.world.setBlock(x, y, z, value),
      blockHp: this.blockHp,
      entities: this.entities,
      canDamage: (attacker, target) => this.mode.canDamage(attacker, target),
      now: this.now,
      solidAt: this.solidAt,
      pushBlockDelta: (x, y, z, value) => this.pushBlockDelta(x, y, z, value),
      pushEvent: (event) => this.tickEvents.push(event),
      computeConeDeg: (player) => this.computeConeDeg(player),
      launchRocket: (player, dir) => this.projectiles.launchRocket(
        player, this.projectileContext(), dir,
      ),
      launchBolt: (player, dir, charge01) => this.projectiles.launchBolt(
        player, this.projectileContext(), dir, charge01,
      ),
    };
  }

  projectileContext() {
    return {
      now: this.now,
      entities: this.entities,
      getBlock: (x, y, z) => this.world.getBlock(x, y, z),
      canAffectWorld: () => this.mode.phase === 'live',
      canThrow: (player) => !player.vault && this.mode.canFire(player),
      grenadeDamage: this.mode.mode !== 'gungame',
      canDamage: (attacker, target) => this.mode.canDamage(attacker, target),
      destroyBlock: (x, y, z) => destroyBlockDirect(
        x, y, z, null, this.combatContext(),
      ),
      damageBlock: (x, y, z, type, dmg) => damageBlock(
        x, y, z, type, dmg, this.combatContext(),
      ),
      killPlayer: (victim, killer, weapon, headshot, markers) => (
        this.killPlayer(victim, killer, weapon, headshot, markers)
      ),
      pushEvent: (event) => this.tickEvents.push(event),
    };
  }

  killPlayer(victim, killer, weaponKey, headshot, markers = null) {
    if (victim.state !== 'alive') return;
    victim.hp = 0;
    victim.state = 'dead';
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
    };
    if (killer && killer !== victim && killer.id !== victim.id) {
      killer.kills++;
      killer.score += this.mode.killScoreDelta(victim, killer, modeContext);
    }
    this.mode.onPlayerDeath(victim, killer, modeContext);
    this.tickEvents.push(evDie(victim.id));
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

export function _tickForTest(engine, ticks = 1) {
  for (let i = 0; i < ticks; i++) engine.step(engine.intervalMs);
  return engine;
}

GameEngine.prototype._tickForTest = function (ticks = 1) {
  return _tickForTest(this, ticks);
};
