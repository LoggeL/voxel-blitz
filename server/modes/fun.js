import { WEAPON_IDS } from '../../shared/combatmath.js';
export class FunPolicy {
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

