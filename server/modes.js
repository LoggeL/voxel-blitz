// Authoritative mode facade. GameEngine talks to one stable controller while
// state-owning team policies live in server/modes/.

import { WEAPON_IDS } from '../shared/combatmath.js';
import {
  DEFAULT_MODE_ID,
  MODE_RULES,
  isModeMapCompatible,
  normalizeModeId,
} from '../shared/modes.js';
import { SndPolicy } from './modes/snd.js';
import { TdmPolicy } from './modes/tdm.js';
import { GunGamePolicy } from './modes/gungame.js';
import { TrainingPolicy } from './modes/training.js';

class FunPolicy {
  constructor({ rules, mapMeta, entities, now, respawn, chooseSpawn }) {
    this.mode = 'fun';
    this.rules = rules;
    this.mapMeta = mapMeta;
    this.phase = 'live';
    this.phaseEndsAt = null;
    this.scores = null;
    this.matchWinner = null;
    this.round = null;
    this.roundWinner = null;
    this.attackers = null;
    this.defenders = null;
    this._entities = entities;
    this._clock = now;
    this._respawnEntity = respawn;
    this._chooseSpawn = chooseSpawn;
    this._players = new Set();
  }

  get now() {
    const value = this._clock();
    return Number.isFinite(value) ? value : 0;
  }

  tick() {}

  teamFor() { return null; }
  roleFor() { return null; }

  isEnemy(a, b) {
    const left = this._entity(a);
    const right = this._entity(b);
    return !!left && !!right && String(left.id) !== String(right.id);
  }

  canDamage(attacker, target) {
    const victim = this._entity(target);
    if (!victim) return false;
    if (attacker != null && victim.spawnProtectedUntil > this.now) return false;
    return attacker == null || this.isEnemy(attacker, victim);
  }

  canUseWeapon(_player, weapon) {
    const slot = typeof weapon === 'string'
      ? WEAPON_IDS.indexOf(weapon)
      : Math.trunc(weapon);
    return Number.isFinite(slot) && slot >= 0 && slot < WEAPON_IDS.length;
  }

  canFire(player) {
    const entity = this._entity(player);
    return !!entity && entity.state === 'alive' && this.canUseWeapon(entity, entity.weapon);
  }

  onPlayerAdd(player) {
    const entity = this._entity(player);
    if (!entity) return null;
    const id = String(entity.id);
    if (this._players.has(id)) return this.playerSnapshot(entity);
    this._players.add(id);
    this._respawn(entity, { emitEvent: false });
    return this.playerSnapshot(entity);
  }

  onPlayerRemove(player) {
    const entity = this._entity(player);
    const id = entity ? String(entity.id) : String(player ?? '');
    return this._players.delete(id);
  }

  onPlayerTakeover(player, nextId) {
    const entity = this._entity(player);
    const priorId = entity ? String(entity.id) : '';
    const id = String(nextId ?? '');
    if (!priorId || !id || !this._players.has(priorId) || this._players.has(id)) return false;
    this._players.delete(priorId);
    this._players.add(id);
    return true;
  }

  onPlayerDeath(victim) {
    const entity = this._entity(victim);
    if (!entity || !this._players.has(String(entity.id))) return false;
    entity.respawnAt = this.now + this.respawnDelay();
    return true;
  }

  onPlayerRespawn(player) {
    const entity = this._entity(player);
    if (!entity || !this._players.has(String(entity.id))) return false;
    this._syncPlayer(entity);
    return true;
  }

  respawnDelay() { return this.rules.respawnMs; }

  canRespawn(player) {
    const entity = this._entity(player);
    return !!entity && entity.state === 'dead';
  }

  canTimedRespawn(player) { return this.canRespawn(player); }

  chooseSpawn(player, excludeIndex = -1) {
    const entity = this._entity(player);
    const pool = Array.isArray(this.mapMeta?.spawns?.fun) ? this.mapMeta.spawns.fun : [];
    return this._chooseSpawn(pool, entity, excludeIndex);
  }

  buy() { return false; }

  botGoal(player) {
    const entity = this._entity(player);
    return entity?.state === 'alive'
      ? { kind: 'fight', target: null, interact: false }
      : { kind: 'spectate', target: null, interact: false };
  }

  matchSnapshot() {
    return {
      mode: this.mode,
      map: typeof this.mapMeta?.id === 'string' ? this.mapMeta.id : null,
      phase: this.phase,
      phaseEndsAt: null,
      scores: null,
      winner: null,
      round: null,
      roundWinner: null,
      attackers: null,
      defenders: null,
      bomb: null,
    };
  }

  playerSnapshot(player) {
    const entity = this._entity(player);
    return {
      team: null,
      credits: 0,
      owned: WEAPON_IDS.slice(),
      bomb: false,
      interaction: null,
      spawnProtected: !!entity
        && Number.isFinite(entity.spawnProtectedUntil)
        && entity.spawnProtectedUntil > this.now,
    };
  }

  dispose() { this._players.clear(); }

  _entity(value) {
    if (value && typeof value === 'object') return value;
    if (value == null) return null;
    return this._entities.get(String(value)) || null;
  }

  _syncPlayer(entity) {
    entity.team = null;
    entity.credits = 0;
    entity.owned = WEAPON_IDS.slice();
    entity.bomb = false;
    entity.interaction = null;
    entity.spawnProtected = Number.isFinite(entity.spawnProtectedUntil)
      && entity.spawnProtectedUntil > this.now;
  }

  _respawn(entity, options) {
    const spawn = this.chooseSpawn(entity, entity.lastSpawnIndex);
    this._respawnEntity(entity, spawn, options);
    this._syncPlayer(entity);
  }
}

/** Stable policy interface consumed by GameEngine and BotManager. */
export class ModeController {
  constructor(engine, { mode = DEFAULT_MODE_ID, mapMeta = null } = {}) {
    if (!engine || typeof engine !== 'object') {
      throw new TypeError('ModeController requires an engine');
    }
    this.engine = engine;
    const modeId = normalizeModeId(mode);
    const selectedMeta = mapMeta && typeof mapMeta === 'object' ? mapMeta : null;
    if (typeof selectedMeta?.id === 'string'
        && !isModeMapCompatible(modeId, selectedMeta.id)) {
      throw new RangeError(`mode ${modeId} is incompatible with map ${selectedMeta.id}`);
    }

    const context = {
      rules: MODE_RULES[modeId],
      mapMeta: selectedMeta,
      entities: engine.entities,
      now: () => engine.now,
      emit: (kind, fields = {}) => {
        if (!Array.isArray(engine.tickEvents)) engine.tickEvents = [];
        engine.tickEvents.push({ t: 'ev', kind, at: engine.now, ...fields });
      },
      respawn: (entity, spawn, options) => engine.respawnPlayer(entity, spawn, options),
      chooseSpawn: (pool, entity, excludeIndex) => {
        if (Array.isArray(pool) && pool.length) {
          const candidates = ['fun', 'tdm', 'gungame'].includes(modeId)
            ? engine.spawnSelector.expand(pool) : pool;
          return engine.selectSafestSpawn(candidates, entity, excludeIndex);
        }
        return engine.nextSpawnFor(entity, excludeIndex);
      },
      spawnDummy: (id, name) => engine.addBot(id, name),
      blocks: {
        get: (x, y, z) => engine.world.getBlock(x, y, z),
        set: (x, y, z, value) => {
          engine.world.setBlock(x, y, z, value);
          engine.pushBlockDelta(x, y, z, value);
        },
      },
    };

    if (modeId === 'snd') this.policy = new SndPolicy(context);
    else if (modeId === 'tdm') this.policy = new TdmPolicy(context);
    else if (modeId === 'gungame') this.policy = new GunGamePolicy(context);
    else if (modeId === 'training') this.policy = new TrainingPolicy(context);
    else this.policy = new FunPolicy(context);
  }

  get mode() { return this.policy.mode; }
  get rules() { return this.policy.rules; }
  get mapMeta() { return this.policy.mapMeta; }
  get phase() { return this.policy.phase; }
  get phaseEndsAt() { return this.policy.phaseEndsAt; }
  get scores() { return this.policy.scores; }
  get matchWinner() { return this.policy.matchWinner; }
  get round() { return this.policy.round; }
  get roundWinner() { return this.policy.roundWinner; }
  get attackers() { return this.policy.attackers ?? null; }
  get defenders() { return this.policy.defenders ?? null; }
  get bomb() { return this.policy.bomb ?? null; }

  tick() { return this.policy.tick(); }
  teamFor(player) { return this.policy.teamFor(player); }
  roleFor(player) { return this.policy.roleFor?.(player) ?? null; }
  isEnemy(a, b) { return this.policy.isEnemy(a, b); }
  canDamage(attacker, target) { return this.policy.canDamage(attacker, target); }
  canUseWeapon(player, weapon) { return this.policy.canUseWeapon(player, weapon); }
  canFire(player) { return this.policy.canFire(player); }
  canMove(player) { return this.policy.canMove?.(player) !== false; }
  onPlayerAdd(player) { return this.policy.onPlayerAdd(player); }
  onPlayerRemove(player) { return this.policy.onPlayerRemove(player); }
  onPlayerDeath(victim, killer, context) {
    return this.policy.onPlayerDeath(victim, killer, context);
  }
  killScoreDelta(victim, killer, context) {
    const delta = this.policy.killScoreDelta?.(victim, killer, context);
    return Number.isFinite(delta) ? delta : 1;
  }
  onPlayerTakeover(player, nextId) {
    return this.policy.onPlayerTakeover?.(player, nextId) === true;
  }
  onPlayerRespawn(player) { return this.policy.onPlayerRespawn(player); }
  respawnDelay() { return this.policy.respawnDelay(); }
  canRespawn(player) { return this.policy.canRespawn(player); }
  canTimedRespawn(player) { return this.policy.canTimedRespawn(player); }
  chooseSpawn(player, excludeIndex) { return this.policy.chooseSpawn(player, excludeIndex); }
  purchase(player, weapon) { return this.policy.buy(player, weapon); }
  matchSnapshot() { return this.policy.matchSnapshot(); }
  playerSnapshot(player) { return this.policy.playerSnapshot(player); }
  botGoal(player) { return this.policy.botGoal(player); }
  dispose() { return this.policy.dispose?.(); }
}
