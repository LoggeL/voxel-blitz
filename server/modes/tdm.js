import { WEAPON_IDS } from '../../shared/combatmath.js';
import { TEAM_IDS } from '../../shared/modes.js';

const REVOLVER = 'revolver';
const ALPHA = TEAM_IDS[0];
const BRAVO = TEAM_IDS[1];
const TEAM_SET = new Set(TEAM_IDS);
const WEAPON_SET = new Set(WEAPON_IDS);

function pointOf(value) {
  if (Array.isArray(value)) {
    const [x, y, z] = value;
    return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
  }
  if (!value || typeof value !== 'object') return null;
  return [value.x, value.y, value.z].every(Number.isFinite)
    ? { x: value.x, y: value.y, z: value.z }
    : null;
}

function weaponId(value) {
  if (typeof value === 'string' && WEAPON_SET.has(value)) return value;
  if (Number.isFinite(value)) return WEAPON_IDS[Math.trunc(value)] || null;
  return null;
}

/**
 * State-owning team deathmatch policy.
 *
 * The injected callbacks are the only seam to the simulation: `now` returns
 * the authoritative clock, `emit` queues a mode event, `respawn` applies an
 * authoritative spawn, and `chooseSpawn` selects from a policy-owned pool.
 */
export class TdmPolicy {
  constructor({ rules, mapMeta = null, entities, now, emit, respawn, chooseSpawn }) {
    if (!rules || typeof rules !== 'object') throw new TypeError('TdmPolicy requires rules');
    if (!entities || typeof entities.get !== 'function' || typeof entities.values !== 'function') {
      throw new TypeError('TdmPolicy requires entities');
    }
    if (typeof now !== 'function'
        || typeof emit !== 'function'
        || typeof respawn !== 'function'
        || typeof chooseSpawn !== 'function') {
      throw new TypeError('TdmPolicy requires mode callbacks');
    }

    this.mode = 'tdm';
    this.rules = rules;
    this.mapMeta = mapMeta && typeof mapMeta === 'object' ? mapMeta : null;

    this.phase = 'live';
    this.phaseEndsAt = null;
    this.scores = { [ALPHA]: 0, [BRAVO]: 0 };
    this.matchWinner = null;
    this.round = null;
    this.roundWinner = null;

    this._entities = entities;
    this._now = now;
    this._emitEvent = emit;
    this._respawnEntity = respawn;
    this._chooseSpawn = chooseSpawn;
    this._players = new Map();
  }

  get now() {
    const value = this._now();
    return Number.isFinite(value) ? value : 0;
  }

  teamFor(player) {
    const entity = this._entity(player);
    const id = entity ? String(entity.id) : String(player ?? '');
    const team = this._players.get(id)?.team ?? entity?.team ?? null;
    return TEAM_SET.has(team) ? team : null;
  }

  tick() {
    this._rememberPositions();
    if (this.phase === 'post' && this.now >= this.phaseEndsAt) this.reset();
  }

  onPlayerAdd(player) {
    const entity = this._entity(player);
    if (!entity) return null;
    const id = String(entity.id);
    if (this._players.has(id)) return this.playerSnapshot(entity);

    const team = this._balancedTeam();
    const state = {
      team,
      credits: 0,
      owned: new Set(WEAPON_IDS),
      participating: true,
      survived: false,
      deathHandled: false,
      last: pointOf(entity) || { x: 0, y: 0, z: 0 },
    };
    this._players.set(id, state);
    this._syncPlayer(entity, state);

    this._emit('team_assigned', { id, team });
    this._respawn(entity, { emitEvent: false });
    state.survived = true;
    return this.playerSnapshot(entity);
  }

  onPlayerRemove(player) {
    const entity = this._entity(player);
    const id = entity ? String(entity.id) : String(player ?? '');
    const state = this._players.get(id);
    if (!state) return false;

    this._players.delete(id);
    this._emit('team_removed', { id, team: state.team });
    return true;
  }

  onPlayerDeath(victim, killer = null) {
    const dead = this._entity(victim);
    if (!dead) return false;
    const state = this._state(dead);
    if (!state || state.deathHandled) return false;
    state.deathHandled = true;

    state.last = pointOf(dead) || state.last;
    dead.respawnAt = this.now + this.respawnDelay();

    if (this.phase === 'live' && killer && this.isEnemy(killer, dead)) {
      const team = this.teamFor(killer);
      this.scores[team]++;
      this._emit('team_score', { team, score: this.scores[team] });
      if (this.scores[team] >= this.rules.scoreLimit) this._finishMatch(team);
    }
    return true;
  }

  onPlayerRespawn(player) {
    const entity = this._entity(player);
    const state = this._state(entity);
    if (!entity || !state) return false;

    this.applyRespawnLoadout(entity);
    state.deathHandled = false;
    state.last = pointOf(entity) || state.last;
    state.survived = true;
    return true;
  }

  canFire(player) {
    const entity = this._entity(player);
    return !!entity
      && entity.state === 'alive'
      && this.phase === 'live'
      && this.canUseWeapon(entity, entity.weapon);
  }

  canUseWeapon(_player, weapon) {
    return weaponId(weapon) !== null;
  }

  canDamage(attacker, target) {
    const victim = this._entity(target);
    if (!victim) return false;
    if (attacker != null && victim.spawnProtectedUntil > this.now) return false;
    if (attacker == null) return true;
    if (this.rules.friendlyFire) {
      const source = this._entity(attacker);
      return !!source && String(source.id) !== String(victim.id);
    }
    return this.isEnemy(attacker, victim);
  }

  isEnemy(a, b) {
    const left = this._entity(a);
    const right = this._entity(b);
    if (!left || !right || String(left.id) === String(right.id)) return false;
    const leftTeam = this.teamFor(left);
    const rightTeam = this.teamFor(right);
    return !!leftTeam && !!rightTeam && leftTeam !== rightTeam;
  }

  canRespawn(player) {
    const entity = this._entity(player);
    return !!entity && entity.state === 'dead' && this.phase === 'live';
  }

  canTimedRespawn(player) {
    return this.canRespawn(player);
  }

  respawnDelay() {
    return this.rules.respawnMs;
  }

  spawnPoolFor(player) {
    const spawns = this.mapMeta?.spawns;
    const pool = spawns?.tdm?.[this.teamFor(player)];
    return Array.isArray(pool) ? pool : [];
  }

  applyRespawnLoadout(player) {
    const entity = this._entity(player);
    const state = this._state(entity);
    if (!entity || !state) return false;

    if (!Array.isArray(entity.mag)) entity.mag = WEAPON_IDS.map(() => 0);
    if (!Array.isArray(entity.reserve)) entity.reserve = WEAPON_IDS.map(() => 0);
    for (let i = 0; i < WEAPON_IDS.length; i++) {
      const id = WEAPON_IDS[i];
      if (!state.owned.has(id)) {
        entity.mag[i] = 0;
        entity.reserve[i] = 0;
      }
    }
    const selected = weaponId(entity.weapon);
    if (!selected || !state.owned.has(selected)) entity.weapon = WEAPON_IDS.indexOf(REVOLVER);
    this._syncPlayer(entity, state);
    return true;
  }

  buy(_player, _weapon) {
    return false;
  }

  botGoal(player) {
    const entity = this._entity(player);
    const state = this._state(entity);
    if (!entity || !state || entity.state !== 'alive') {
      return { kind: 'spectate', target: null, interact: false };
    }
    return { kind: 'fight', target: null, interact: false };
  }

  matchSnapshot() {
    return {
      mode: this.mode,
      map: typeof this.mapMeta?.id === 'string' ? this.mapMeta.id : null,
      phase: this.phase,
      phaseEndsAt: this.phaseEndsAt,
      scores: { [ALPHA]: this.scores[ALPHA], [BRAVO]: this.scores[BRAVO] },
      winner: this.matchWinner,
      round: this.round,
      roundWinner: this.roundWinner,
      attackers: null,
      defenders: null,
      bomb: null,
    };
  }

  playerSnapshot(player) {
    const entity = this._entity(player);
    const state = this._state(entity);
    if (!state) {
      return {
        team: null,
        credits: 0,
        owned: WEAPON_IDS.slice(),
        bomb: false,
        interaction: null,
        spawnProtected: false,
      };
    }
    return {
      team: state.team,
      credits: state.credits,
      owned: WEAPON_IDS.filter((id) => state.owned.has(id)),
      bomb: false,
      interaction: null,
      spawnProtected: Number.isFinite(entity.spawnProtectedUntil)
        && entity.spawnProtectedUntil > this.now,
    };
  }

  chooseSpawn(player, excludeIndex = -1) {
    const entity = this._entity(player);
    return this._chooseSpawn(this.spawnPoolFor(entity), entity, excludeIndex);
  }

  reset() {
    this.scores[ALPHA] = 0;
    this.scores[BRAVO] = 0;
    this.matchWinner = null;
    this.phase = 'live';
    this.phaseEndsAt = null;
    for (const entity of this._entities.values()) {
      entity.score = 0;
      entity.kills = 0;
      entity.deaths = 0;
      this._respawn(entity);
    }
    this._emit('match_start', { mode: this.mode, scores: { ...this.scores } });
    this._emit('phase', { mode: this.mode, phase: this.phase, endsAt: null });
  }

  dispose() {
    this._players.clear();
  }

  _entity(value) {
    if (value && typeof value === 'object') return value;
    if (value == null) return null;
    return this._entities.get(String(value)) || null;
  }

  _state(value) {
    const entity = this._entity(value);
    if (!entity) return null;
    return this._players.get(String(entity.id)) || null;
  }

  _balancedTeam() {
    let alpha = 0;
    let bravo = 0;
    for (const state of this._players.values()) {
      if (state.team === ALPHA) alpha++;
      else if (state.team === BRAVO) bravo++;
    }
    return alpha <= bravo ? ALPHA : BRAVO;
  }

  _emit(kind, fields = {}) {
    this._emitEvent(kind, fields);
  }

  _syncPlayer(entity, state) {
    entity.team = state.team;
    entity.credits = state.credits;
    entity.owned = WEAPON_IDS.filter((id) => state.owned.has(id));
    entity.bomb = false;
    entity.interaction = null;
    entity.spawnProtected = Number.isFinite(entity.spawnProtectedUntil)
      && entity.spawnProtectedUntil > this.now;
  }

  _rememberPositions() {
    for (const entity of this._entities.values()) {
      const state = this._state(entity);
      const point = pointOf(entity);
      if (state && point) state.last = point;
    }
  }

  _respawn(entity, { emitEvent = true } = {}) {
    const spawn = this.chooseSpawn(entity, entity.lastSpawnIndex);
    this._respawnEntity(entity, spawn, { emitEvent });
    const state = this._state(entity);
    if (state) {
      state.deathHandled = false;
      state.last = pointOf(entity) || state.last;
      this.applyRespawnLoadout(entity);
    }
  }

  _finishMatch(winner) {
    if (this.phase !== 'live') return;
    this.phase = 'post';
    this.phaseEndsAt = this.now + this.rules.postMs;
    this.matchWinner = winner;
    this._emit('match_end', { mode: this.mode, winner, scores: { ...this.scores } });
    this._emit('phase', { mode: this.mode, phase: this.phase, endsAt: this.phaseEndsAt });
  }
}
