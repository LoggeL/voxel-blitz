import { WEAPON_IDS } from '../../shared/combatmath.js';
import { TEAM_IDS } from '../../shared/modes.js';
import { TeamPolicy, weaponId } from './base-policy.js';

const REVOLVER = 'revolver';
const ALPHA = TEAM_IDS[0];
const BRAVO = TEAM_IDS[1];
const TEAM_SET = new Set(TEAM_IDS);

/**
 * State-owning team deathmatch policy. Every player owns the full arsenal and
 * nobody buys, so per-player state is only the team and death bookkeeping.
 */
export class TdmPolicy extends TeamPolicy {
  constructor(context) {
    super('TdmPolicy', context);
    this.mode = 'tdm';
    this.scores = { [ALPHA]: 0, [BRAVO]: 0 };
    this._players = new Map();
  }

  tick() {
    if (this.phase === 'post' && Number.isFinite(this.phaseEndsAt) && this.now >= this.phaseEndsAt) this.reset();
  }

  onPlayerAdd(player) {
    const entity = this._entity(player);
    if (!entity) return null;
    const id = String(entity.id);
    if (this._players.has(id)) return this.playerSnapshot(entity);

    const team = this._balancedTeam();
    const state = { team, deathHandled: false };
    this._players.set(id, state);
    this._syncPlayer(entity, state);

    this._emit('team_assigned', { id, team });
    this._respawn(entity, { emitEvent: false });
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

  /** A joining human inherits the bot's selected team and current life. */
  onPlayerTakeover(player, nextId) {
    const entity = this._entity(player);
    const priorId = entity ? String(entity.id) : '';
    const id = String(nextId ?? '');
    const state = this._players.get(priorId);
    if (!state || !id || this._players.has(id)) return false;
    this._players.delete(priorId);
    this._players.set(id, state);
    this._emit('team_assigned', { id, team: state.team });
    return true;
  }

  /** Called by the lobby before the simulation starts. */
  setLobbyTeam(player, team) {
    const entity = this._entity(player);
    const state = this._state(entity);
    if (!state || !TEAM_SET.has(team)) return false;
    if (state.team === team) return true;
    state.team = team;
    this._syncPlayer(entity, state);
    this._respawn(entity, { emitEvent: false });
    return true;
  }

  onPlayerDeath(victim, killer = null) {
    const dead = this._entity(victim);
    if (!dead) return false;
    const state = this._state(dead);
    if (!state || state.deathHandled) return false;
    state.deathHandled = true;

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
    return true;
  }

  canFire(player) {
    const entity = this._entity(player);
    return !!entity
      && entity.state === 'alive'
      && this.phase === 'live'
      && this.canUseWeapon(entity, entity.weapon);
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
    if (!weaponId(entity.weapon)) entity.weapon = WEAPON_IDS.indexOf(REVOLVER);
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
    return {
      team: state?.team ?? null,
      credits: 0,
      owned: WEAPON_IDS.slice(),
      bomb: false,
      interaction: null,
      spawnProtected: !!state && this._spawnProtected(entity),
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

  _syncPlayer(entity, state) {
    entity.team = state.team;
    entity.credits = 0;
    entity.owned = WEAPON_IDS.slice();
    entity.bomb = false;
    entity.interaction = null;
    entity.spawnProtected = this._spawnProtected(entity);
  }

  _respawn(entity, { emitEvent = true } = {}) {
    const spawn = this.chooseSpawn(entity, entity.lastSpawnIndex);
    this._respawnEntity(entity, spawn, { emitEvent });
    const state = this._state(entity);
    if (state) {
      state.deathHandled = false;
      this.applyRespawnLoadout(entity);
    }
  }

  _finishMatch(winner) {
    if (this.phase !== 'live') return;
    this.phase = 'post';
    this.phaseEndsAt = null; // ModeController sets it once the continuation vote passes
    this.matchWinner = winner;
    this._emit('match_end', { mode: this.mode, winner, scores: { ...this.scores } });
    this._emit('phase', { mode: this.mode, phase: this.phase, endsAt: this.phaseEndsAt });
  }
}
