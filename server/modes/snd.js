import { WEAPON_IDS } from '../../shared/combatmath.js';
import { TEAM_IDS } from '../../shared/modes.js';
import { SndEconomy, weaponId } from './snd/economy.js';
import { SndObjective, pointOf } from './snd/objective.js';

const MODE = 'snd';
const REVOLVER = 'revolver';
const ALPHA = TEAM_IDS[0];
const BRAVO = TEAM_IDS[1];
const TEAM_SET = new Set(TEAM_IDS);

/**
 * State-owning Search and Destroy match policy.
 *
 * The injected context supplies simulation operations without exposing the
 * GameEngine host object. `now` is read lazily so boundary ticks preserve the
 * authoritative engine clock.
 */
export class SndPolicy {
  constructor({ rules, mapMeta = null, entities, now, emit, respawn, chooseSpawn } = {}) {
    if (!rules || typeof rules !== 'object') throw new TypeError('SndPolicy requires rules');
    if (!entities || typeof entities.get !== 'function' || typeof entities.values !== 'function') {
      throw new TypeError('SndPolicy requires an entity map');
    }
    if (typeof now !== 'function') throw new TypeError('SndPolicy requires a clock');
    if (typeof emit !== 'function') throw new TypeError('SndPolicy requires an event emitter');
    if (typeof respawn !== 'function') throw new TypeError('SndPolicy requires a respawn callback');
    if (typeof chooseSpawn !== 'function') throw new TypeError('SndPolicy requires a spawn selector');

    this.mode = MODE;
    this.rules = rules;
    this.mapMeta = mapMeta && typeof mapMeta === 'object' ? mapMeta : null;

    this._entities = entities;
    this._clock = now;
    this._emitEvent = emit;
    this._respawnEntity = respawn;
    this._chooseSpawn = chooseSpawn;

    this.phase = 'prep';
    this.phaseEndsAt = this.now + this.rules.prepMs;
    this.scores = { [ALPHA]: 0, [BRAVO]: 0 };
    this.matchWinner = null;
    this.roundWinner = null;
    this.round = 1;
    this.completedRounds = 0;
    this.attackers = ALPHA;
    this.defenders = BRAVO;
    this.halftimeSwapped = false;
    this.lossStreak = { [ALPHA]: 0, [BRAVO]: 0 };
    this._players = new Map();
    this._defaultWeapon = REVOLVER;
    this._economy = new SndEconomy(this);
    this._objective = new SndObjective(this);
  }

  get bomb() { return this._objective.bomb; }
  set bomb(value) { this._objective.bomb = value; }
  get _interactions() { return this._objective.interactions; }
  set _interactions(value) { this._objective.interactions = value; }

  get now() {
    const value = this._clock();
    return Number.isFinite(value) ? value : 0;
  }

  tick() {
    this._rememberPositions();
    if (this.phase === 'post') {
      if (this.now >= this.phaseEndsAt) this._startNextRound();
      return;
    }

    this._objective.assignBomb();
    this._objective.pickupDroppedBomb();
    if (this.phase === 'prep') {
      if (this.now >= this.phaseEndsAt) this._startLive();
      return;
    }

    const completedDefuse = this._objective.updateInteractions();
    if (this.bomb.state === 'planted' && this.now >= this.bomb.explodeAt) {
      this.bomb.state = 'exploded';
      this._emit('bomb_explode', {
        site: this.bomb.siteId,
        x: this.bomb.x,
        y: this.bomb.y,
        z: this.bomb.z,
      });
      this._finishRound(this.attackers, 'explosion');
      return;
    }
    if (completedDefuse) {
      this.bomb.state = 'defused';
      this._emit('bomb_defuse', { id: completedDefuse, site: this.bomb.siteId });
      this._finishRound(this.defenders, 'defuse');
      return;
    }

    const outcome = this._eliminationOutcome();
    if (outcome) {
      this._finishRound(outcome, 'elimination');
      return;
    }

    if (this.now >= this.phaseEndsAt && this.bomb.state !== 'planted' && this._players.size) {
      this._finishRound(this.defenders, 'time');
    }
  }

  onPlayerAdd(player) {
    const entity = this._entity(player);
    if (!entity) return null;
    const id = String(entity.id);
    if (this._players.has(id)) return this.playerSnapshot(entity);

    const state = {
      team: this._balancedTeam(),
      credits: this.rules.startCredits,
      owned: new Set([REVOLVER]),
      participating: this.phase === 'prep',
      survived: false,
      deathHandled: false,
      last: pointOf(entity) || { x: 0, y: 0, z: 0 },
    };
    this._players.set(id, state);
    this._syncPlayer(entity, state);
    this._emit('team_assigned', { id, team: state.team });

    if (this.phase !== 'prep') {
      this._makeSpectator(entity, state);
    } else {
      this._respawn(entity, { emitEvent: false });
      state.survived = true;
      this._objective.assignBomb();
    }
    return this.playerSnapshot(entity);
  }

  onPlayerRemove(player) {
    const entity = this._entity(player);
    const id = entity ? String(entity.id) : String(player ?? '');
    const state = this._players.get(id);
    if (!state) return false;

    const position = (entity && pointOf(entity)) || state.last;
    if (this.bomb.state === 'carried' && this.bomb.carrierId === id) {
      this._objective.dropBomb(position, id, 'disconnect');
    }
    this._objective.clearInteraction(id, true);
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
    if (this.phase !== 'post') state.survived = false;
    this._objective.clearInteraction(String(dead.id), true);
    if (this.bomb.state === 'carried' && this.bomb.carrierId === String(dead.id)) {
      this._objective.dropBomb(state.last, String(dead.id), 'death');
    }
    if (killer && this.isEnemy(killer, dead)) {
      const killerEntity = this._entity(killer);
      const killerState = this._state(killerEntity);
      if (killerEntity && killerState) {
        this._economy.addCredits(killerEntity, killerState, this.rules.killCredits, 'kill');
      }
    }
    return true;
  }

  onPlayerRespawn(player) {
    const entity = this._entity(player);
    const state = this._state(entity);
    if (!entity || !state) return false;

    if (this.phase !== 'prep') {
      this._makeSpectator(entity, state);
      return false;
    }
    this.applyRespawnLoadout(entity);
    state.deathHandled = false;
    state.last = pointOf(entity) || state.last;
    state.survived = true;
    return true;
  }

  canFire(player) {
    const entity = this._entity(player);
    const state = this._state(entity);
    return !!entity
      && entity.state === 'alive'
      && this.phase === 'live'
      && !!state?.participating
      && this.canUseWeapon(entity, entity.weapon);
  }

  canMove(player) {
    const entity = this._entity(player);
    return !!entity && entity.state === 'alive' && this.phase !== 'prep';
  }

  canUseWeapon(player, weapon) {
    const id = weaponId(weapon);
    if (!id) return false;
    const state = this._state(player);
    return !!state && state.owned.has(id);
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
    return !!entity && entity.state === 'dead' && this.phase === 'prep';
  }

  canTimedRespawn() {
    return false;
  }

  respawnDelay() {
    return Infinity;
  }

  spawnPoolFor(player) {
    const entity = this._entity(player);
    const role = this.roleFor(entity);
    const pool = role ? this.mapMeta?.spawns?.snd?.[role] : null;
    return Array.isArray(pool) ? pool : [];
  }

  applyRespawnLoadout(player) {
    const entity = this._entity(player);
    const state = this._state(entity);
    return this._economy.applyRespawnLoadout(entity, state);
  }

  buy(player, weapon) {
    const entity = this._entity(player);
    const state = this._state(entity);
    return this._economy.buy(entity, state, weapon);
  }

  botGoal(player) {
    const entity = this._entity(player);
    const state = this._state(entity);
    if (!entity || !state || entity.state !== 'alive') {
      return { kind: 'spectate', target: null, interact: false };
    }
    if (!state.participating || this.phase === 'post') {
      return { kind: 'spectate', target: null, interact: false };
    }

    const role = this.roleFor(entity);
    const bombPoint = this._objective.bombPosition();
    if (role === 'attackers') {
      if (this.bomb.state === 'planted') {
        return { kind: 'defendBomb', target: bombPoint, interact: false };
      }
      if (this.bomb.state === 'dropped' && bombPoint) {
        return { kind: 'recoverBomb', target: bombPoint, interact: false };
      }
      if (this.bomb.carrierId === String(entity.id)) {
        return {
          kind: 'plant',
          target: this._objective.nearestSiteCenter(entity),
          interact: this.phase === 'live',
        };
      }
      const carrier = this._entity(this.bomb.carrierId);
      return {
        kind: 'escortCarrier',
        target: carrier ? pointOf(carrier) : this._objective.nearestSiteCenter(entity),
        interact: false,
      };
    }

    if (this.bomb.state === 'planted') {
      return { kind: 'defuse', target: bombPoint, interact: this.phase === 'live' };
    }
    if (this.bomb.state === 'dropped' && bombPoint) {
      return { kind: 'guardBomb', target: bombPoint, interact: false };
    }
    return {
      kind: 'defendSite',
      target: this._objective.siteForId(String(entity.id)),
      interact: false,
    };
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
      attackers: this.attackers,
      defenders: this.defenders,
      bomb: this._objective.bombSnapshot(),
    };
  }

  playerSnapshot(player) {
    const entity = this._entity(player);
    const state = this._state(entity);
    const interaction = entity
      ? this._objective.interactionSnapshot(String(entity.id))
      : null;
    if (!state) {
      return {
        team: null,
        credits: 0,
        owned: [],
        bomb: false,
        interaction,
        spawnProtected: false,
      };
    }
    return {
      team: state.team,
      credits: state.credits,
      owned: WEAPON_IDS.filter((id) => state.owned.has(id)),
      bomb: this.bomb.state === 'carried'
        && this.bomb.carrierId === String(entity.id),
      interaction,
      spawnProtected: Number.isFinite(entity.spawnProtectedUntil)
        && entity.spawnProtectedUntil > this.now,
    };
  }

  chooseSpawn(player, excludeIndex = -1) {
    const entity = this._entity(player);
    return this._chooseSpawn(this.spawnPoolFor(entity), entity, excludeIndex);
  }
  reset() {
    this._startNextRound(true);
  }


  dispose() {
    this._objective.clearAllInteractions();
    this._players.clear();
    this._objective.dispose();
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

  teamFor(player) {
    const entity = this._entity(player);
    const id = entity ? String(entity.id) : String(player ?? '');
    const team = this._players.get(id)?.team ?? entity?.team ?? null;
    return TEAM_SET.has(team) ? team : null;
  }

  roleFor(player) {
    const team = this.teamFor(player);
    if (team === this.attackers) return 'attackers';
    if (team === this.defenders) return 'defenders';
    return null;
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
    entity.bomb = this.bomb.state === 'carried'
      && this.bomb.carrierId === String(entity.id);
    entity.interaction = this._objective.interactionSnapshot(String(entity.id));
    entity.spawnProtected = Number.isFinite(entity.spawnProtectedUntil)
      && entity.spawnProtectedUntil > this.now;
  }

  _syncAllPlayers() {
    for (const entity of this._entities.values()) {
      const state = this._state(entity);
      if (state) this._syncPlayer(entity, state);
    }
  }

  _rememberPositions() {
    for (const entity of this._entities.values()) {
      const state = this._state(entity);
      const point = pointOf(entity);
      if (state && point) state.last = point;
    }
  }

  _makeSpectator(entity, state) {
    state.participating = false;
    state.survived = false;
    state.deathHandled = true;
    entity.hp = 0;
    entity.state = 'dead';
    entity.respawnAt = Infinity;
    entity.firing = false;
    entity.ads = false;
    entity.adsT = 0;
    entity.spawnProtectedUntil = 0;
    this._syncPlayer(entity, state);
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

  _startLive() {
    if (this.phase !== 'prep') return;
    this.phase = 'live';
    this.phaseEndsAt = this.now + this.rules.liveMs;
    this._objective.assignBomb();
    this._emit('phase', { mode: this.mode, phase: this.phase, endsAt: this.phaseEndsAt, round: this.round });
  }

  _finishRound(winner, reason) {
    if (this.phase !== 'live' || !TEAM_SET.has(winner)) return;
    this.roundWinner = winner;
    this.completedRounds++;
    this.scores[winner]++;

    const loser = winner === ALPHA ? BRAVO : ALPHA;
    this.lossStreak[winner] = 0;
    this.lossStreak[loser]++;
    const lossIndex = Math.min(this.lossStreak[loser] - 1, this.rules.lossCredits.length - 1);
    const lossAward = this.rules.lossCredits[lossIndex];

    for (const entity of this._entities.values()) {
      const state = this._state(entity);
      if (!state) continue;
      state.survived = state.participating && entity.state === 'alive';
      if (state.team === winner) {
        this._economy.addCredits(entity, state, this.rules.roundWinCredits, 'round_win');
      } else if (state.team === loser) {
        this._economy.addCredits(entity, state, lossAward, 'round_loss');
      }
    }

    this.phase = 'post';
    this.phaseEndsAt = this.now + this.rules.postMs;
    this._objective.clearAllInteractions();
    this._emit('round_end', {
      round: this.round,
      winner,
      reason,
      scores: { ...this.scores },
    });

    if (this.scores[winner] >= this.rules.roundWins) {
      this.matchWinner = winner;
      this._emit('match_end', { mode: this.mode, winner, scores: { ...this.scores } });
    }
    this._emit('phase', { mode: this.mode, phase: this.phase, endsAt: this.phaseEndsAt, round: this.round });
  }

  _startNextRound(newMatch = !!this.matchWinner) {
    if (newMatch) this._resetMatchState();
    else {
      this.round = this.completedRounds + 1;
      if (!this.halftimeSwapped && this.completedRounds >= this.rules.roundsPerHalf) {
        [this.attackers, this.defenders] = [this.defenders, this.attackers];
        this.halftimeSwapped = true;
        this._emit('halftime', { attackers: this.attackers, defenders: this.defenders });
      }
    }

    this.phase = 'prep';
    this.phaseEndsAt = this.now + this.rules.prepMs;
    this.roundWinner = null;
    this._objective.clearAllInteractions();

    for (const entity of this._entities.values()) {
      const state = this._state(entity);
      if (!state) continue;
      const keep = !newMatch && state.survived;
      const savedWeapon = weaponId(entity.weapon);
      const savedMag = Array.isArray(entity.mag) ? entity.mag.slice() : [];
      const savedReserve = Array.isArray(entity.reserve) ? entity.reserve.slice() : [];
      if (!keep) state.owned = new Set([REVOLVER]);
      state.participating = true;
      this._respawn(entity);
      if (keep) {
        for (let i = 0; i < WEAPON_IDS.length; i++) {
          if (!state.owned.has(WEAPON_IDS[i])) continue;
          if (Number.isFinite(savedMag[i])) entity.mag[i] = Math.max(0, Math.trunc(savedMag[i]));
          if (Number.isFinite(savedReserve[i])) {
            entity.reserve[i] = Math.max(0, Math.trunc(savedReserve[i]));
          }
        }
        if (savedWeapon && state.owned.has(savedWeapon)) entity.weapon = WEAPON_IDS.indexOf(savedWeapon);
      }
      state.survived = true;
      this._syncPlayer(entity, state);
    }

    this._objective.resetBomb();
    this._objective.assignBomb();
    if (newMatch) this._emit('match_start', { mode: this.mode, scores: { ...this.scores } });
    this._emit('round_start', {
      round: this.round,
      attackers: this.attackers,
      defenders: this.defenders,
    });
    this._emit('phase', { mode: this.mode, phase: this.phase, endsAt: this.phaseEndsAt, round: this.round });
  }

  _resetMatchState() {
    this.scores[ALPHA] = 0;
    this.scores[BRAVO] = 0;
    this.matchWinner = null;
    this.round = 1;
    this.completedRounds = 0;
    this.attackers = ALPHA;
    this.defenders = BRAVO;
    this.halftimeSwapped = false;
    this.lossStreak[ALPHA] = 0;
    this.lossStreak[BRAVO] = 0;
    for (const entity of this._entities.values()) {
      const state = this._state(entity);
      if (!state) continue;
      state.credits = this.rules.startCredits;
      state.owned = new Set([REVOLVER]);
      state.survived = false;
      entity.score = 0;
      entity.kills = 0;
      entity.deaths = 0;
      this._syncPlayer(entity, state);
    }
  }

  _eliminationOutcome() {
    let attackers = 0;
    let defenders = 0;
    let aliveAttackers = 0;
    let aliveDefenders = 0;
    for (const entity of this._entities.values()) {
      const state = this._state(entity);
      if (!state?.participating) continue;
      if (state.team === this.attackers) {
        attackers++;
        if (entity.state === 'alive') aliveAttackers++;
      } else if (state.team === this.defenders) {
        defenders++;
        if (entity.state === 'alive') aliveDefenders++;
      }
    }
    if (!attackers || !defenders) return null;
    if (aliveAttackers === 0 && this.bomb.state !== 'planted') return this.defenders;
    if (aliveDefenders === 0) return this.attackers;
    return null;
  }

}
