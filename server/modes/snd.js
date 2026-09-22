import { WEAPON_IDS } from '../../shared/combatmath.js';
import { TEAM_IDS } from '../../shared/modes.js';
import { TeamPolicy, pointOf, weaponId } from './base-policy.js';
import { SndEconomy } from './snd/economy.js';
import { SndObjective } from './snd/objective.js';

const MODE = 'snd';
const REVOLVER = 'revolver';
const GLAIVE_SLOT = WEAPON_IDS.indexOf('glaive');
const ALPHA = TEAM_IDS[0];
const BRAVO = TEAM_IDS[1];
const TEAM_SET = new Set(TEAM_IDS);

/**
 * State-owning Search and Destroy match policy.
 *
 * The injected context supplies simulation operations without exposing the
 * GameEngine host object (see BasePolicy).
 */
export class SndPolicy extends TeamPolicy {
  constructor(context) {
    super('SndPolicy', context);
    // Saved RIPTIDE discs: in-flight and embedded discs count toward the kept mag.
    this._glaiveStock = typeof context?.glaiveStock === 'function' ? context.glaiveStock : null;
    this.mode = MODE;
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

  tick() {
    if (this.phase === 'post') {
      if (Number.isFinite(this.phaseEndsAt) && this.now >= this.phaseEndsAt) this._startNextRound();
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
    const wasCarrier = this.bomb.state === 'carried' && this.bomb.carrierId === id;
    if (wasCarrier && this.phase !== 'prep') {
      this._objective.dropBomb(position, id, 'disconnect');
    }
    this._objective.clearInteraction(id, true);
    this._players.delete(id);
    // Nobody can move during prep, so a leaving carrier hands the bomb to a
    // remaining attacker instead of stranding it at an empty spawn. The leaver
    // is already out of _players, so assignBomb cannot pick them again.
    if (wasCarrier && this.phase === 'prep') this._reassignBomb();
    this._emit('team_removed', { id, team: state.team });
    return true;
  }

  /** Preserve a bot slot's team, round eligibility, inventory and bomb ownership. */
  onPlayerTakeover(player, nextId) {
    const entity = this._entity(player);
    const priorId = entity ? String(entity.id) : '';
    const id = String(nextId ?? '');
    const state = this._players.get(priorId);
    if (!state || !id || this._players.has(id)) return false;
    this._objective.clearInteraction(priorId, false);
    this._players.delete(priorId);
    this._players.set(id, state);
    if (this.bomb.carrierId === priorId) {
      this.bomb.carrierId = id;
      this._emit('bomb_assigned', { id, round: this.round });
    }
    this._emit('team_assigned', { id, team: state.team });
    return true;
  }

  /** Waiting-lobby changes also move the bomb to an eligible attacker. */
  setLobbyTeam(player, team) {
    const entity = this._entity(player);
    const state = this._state(entity);
    if (!state || !TEAM_SET.has(team) || this.phase !== 'prep') return false;
    if (state.team === team) return true;
    state.team = team;
    this._objective.clearInteraction(String(entity.id), true);
    this._syncPlayer(entity, state);
    this._respawn(entity, { emitEvent: false });
    this._reassignBomb();
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
      if (this.phase === 'prep') this._reassignBomb();
      else this._objective.dropBomb(state.last, String(dead.id), 'death');
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
      spawnProtected: this._spawnProtected(entity),
    };
  }

  chooseSpawn(player, excludeIndex = -1) {
    const entity = this._entity(player);
    return this._chooseSpawn(this.spawnPoolFor(entity), entity, excludeIndex);
  }

  dispose() {
    this._objective.clearAllInteractions();
    this._players.clear();
    this._objective.dispose();
  }

  roleFor(player) {
    const team = this.teamFor(player);
    if (team === this.attackers) return 'attackers';
    if (team === this.defenders) return 'defenders';
    return null;
  }

  _syncPlayer(entity, state) {
    entity.team = state.team;
    entity.credits = state.credits;
    entity.owned = WEAPON_IDS.filter((id) => state.owned.has(id));
    entity.bomb = this.bomb.state === 'carried'
      && this.bomb.carrierId === String(entity.id);
    entity.interaction = this._objective.interactionSnapshot(String(entity.id));
    entity.spawnProtected = this._spawnProtected(entity);
  }

  _syncAllPlayers() {
    for (const entity of this._entities.values()) {
      const state = this._state(entity);
      if (state) this._syncPlayer(entity, state);
    }
  }

  /** Prep-phase bomb handoff: return it to the pool and pick an eligible attacker. */
  _reassignBomb() {
    this._objective.resetBomb();
    this._syncAllPlayers();
    this._objective.assignBomb();
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
    this.phaseEndsAt = null; // ModeController sets it once the continuation vote passes
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
      // The respawn deletes discs still flying, embedded or fabricating; a survivor
      // keeps them as seated discs (the ammo normaliser trims any excess).
      if (keep && GLAIVE_SLOT >= 0 && this._glaiveStock && Number.isFinite(savedMag[GLAIVE_SLOT])) {
        savedMag[GLAIVE_SLOT] += this._glaiveStock(entity);
      }
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
