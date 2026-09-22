import { WEAPON_IDS } from '../../shared/combatmath.js';
import { BasePolicy } from './base-policy.js';

/** Free-for-all base for Fun, Duel, Chaos and TTT: everyone owns every weapon. */
export class FunPolicy extends BasePolicy {
  constructor(context) {
    super('FunPolicy', context);
    this.mode = 'fun';
    this.attackers = null;
    this.defenders = null;
    this._players = new Set();
  }

  tick() {}

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
    // A map may author a pool for this mode (Waterworld keeps its original
    // entities for Trouble in Terrorist Town); otherwise the free-for-all pool.
    const spawns = this.mapMeta?.spawns;
    const pool = Array.isArray(spawns?.[this.mode]) ? spawns[this.mode]
      : Array.isArray(spawns?.fun) ? spawns.fun : [];
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
      spawnProtected: this._spawnProtected(entity),
    };
  }

  dispose() { this._players.clear(); }

  _syncPlayer(entity) {
    entity.team = null;
    entity.credits = 0;
    entity.owned = WEAPON_IDS.slice();
    entity.bomb = false;
    entity.interaction = null;
    entity.spawnProtected = this._spawnProtected(entity);
  }

  _respawn(entity, options) {
    const spawn = this.chooseSpawn(entity, entity.lastSpawnIndex);
    this._respawnEntity(entity, spawn, options);
    this._syncPlayer(entity);
  }
}

