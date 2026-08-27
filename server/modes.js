import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';
import {
  DEFAULT_MODE_ID,
  MODE_RULES,
  TEAM_IDS,
  WEAPON_PRICES,
  isModeMapCompatible,
  normalizeModeId,
} from '../shared/modes.js';

const REVOLVER = 'revolver';
const ALPHA = TEAM_IDS[0];
const BRAVO = TEAM_IDS[1];
const TEAM_SET = new Set(TEAM_IDS);
const WEAPON_SET = new Set(WEAPON_IDS);

function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

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

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function stableIdCompare(a, b) {
  return String(a.id).localeCompare(String(b.id));
}

function weaponId(value) {
  if (typeof value === 'string' && WEAPON_SET.has(value)) return value;
  if (Number.isFinite(value)) return WEAPON_IDS[Math.trunc(value)] || null;
  return null;
}

function siteCenter(site) {
  if (!site) return null;
  const x = (site.minX + site.maxX) / 2;
  const z = (site.minZ + site.maxZ) / 2;
  return [x, site.y, z].every(Number.isFinite) ? { x, y: site.y, z } : null;
}

function insideSite(player, site) {
  return !!site
    && player.x >= site.minX && player.x <= site.maxX
    && player.z >= site.minZ && player.z <= site.maxZ
    && Number.isFinite(site.y) && Math.abs(player.y - site.y) <= 1.5;
}

function freshBomb() {
  return {
    state: 'dropped',
    carrierId: null,
    siteId: null,
    x: null,
    y: null,
    z: null,
    plantedAt: null,
    explodeAt: null,
    unassigned: true,
  };
}

/**
 * Sole authoritative branch point for match rules. GameEngine owns physics and
 * combat mechanics; this controller owns mode policy and mode state.
 */
export class ModeController {
  constructor(engine, { mode = DEFAULT_MODE_ID, mapMeta = null } = {}) {
    if (!engine || typeof engine !== 'object') throw new TypeError('ModeController requires an engine');

    this.engine = engine;
    this.mode = normalizeModeId(mode);
    this.rules = MODE_RULES[this.mode];
    this.mapMeta = mapMeta && typeof mapMeta === 'object' ? mapMeta : null;
    if (typeof this.mapMeta?.id === 'string'
        && !isModeMapCompatible(this.mode, this.mapMeta.id)) {
      throw new RangeError(`mode ${this.mode} is incompatible with map ${this.mapMeta.id}`);
    }

    this.phase = this.mode === 'snd' ? 'prep' : 'live';
    this.phaseEndsAt = this.mode === 'snd' ? this.now + this.rules.prepMs : null;
    this.scores = this.rules.teams ? { [ALPHA]: 0, [BRAVO]: 0 } : null;
    this.matchWinner = null;
    this.roundWinner = null;

    this.round = this.mode === 'snd' ? 1 : null;
    this.completedRounds = 0;
    this.attackers = ALPHA;
    this.defenders = BRAVO;
    this.halftimeSwapped = false;
    this.lossStreak = { [ALPHA]: 0, [BRAVO]: 0 };
    this.bomb = this.mode === 'snd' ? freshBomb() : null;

    this._players = new Map();
    this._interactions = new Map();
  }

  get now() {
    return Number.isFinite(this.engine.now) ? this.engine.now : 0;
  }

  teamFor(player) {
    const entity = this._entity(player);
    const id = entity ? String(entity.id) : String(player ?? '');
    const team = this._players.get(id)?.team ?? entity?.team ?? null;
    return TEAM_SET.has(team) ? team : null;
  }

  roleFor(player) {
    if (this.mode !== 'snd') return null;
    const team = this.teamFor(player);
    if (team === this.attackers) return 'attackers';
    if (team === this.defenders) return 'defenders';
    return null;
  }

  isEnemy(a, b) {
    const left = this._entity(a);
    const right = this._entity(b);
    if (!left || !right || String(left.id) === String(right.id)) return false;
    if (!this.rules.teams) return true;
    const leftTeam = this.teamFor(left);
    const rightTeam = this.teamFor(right);
    return !!leftTeam && !!rightTeam && leftTeam !== rightTeam;
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

  canUseWeapon(player, weapon) {
    const id = weaponId(weapon);
    if (!id) return false;
    if (this.mode !== 'snd') return true;
    const state = this._state(player);
    return !!state && state.owned.has(id);
  }

  canFire(player) {
    const entity = this._entity(player);
    if (!entity || entity.state !== 'alive') return false;
    if (this.mode === 'tdm' && this.phase !== 'live') return false;
    if (this.mode === 'snd') {
      const state = this._state(entity);
      if (this.phase !== 'live' || !state?.participating) return false;
    }
    return this.canUseWeapon(entity, entity.weapon);
  }

  onPlayerAdd(player) {
    const entity = this._entity(player);
    if (!entity) return null;
    const id = String(entity.id);
    if (this._players.has(id)) return this.playerSnapshot(entity);

    const team = this.rules.teams ? this._balancedTeam() : null;
    const state = {
      team,
      credits: this.mode === 'snd' ? this.rules.startCredits : 0,
      owned: new Set(this.mode === 'snd' ? [REVOLVER] : WEAPON_IDS),
      participating: this.mode !== 'snd' || this.phase === 'prep',
      survived: false,
      deathHandled: false,
      last: pointOf(entity) || { x: 0, y: 0, z: 0 },
    };
    this._players.set(id, state);
    this._syncPlayer(entity, state);

    if (team) this._emit('team_assigned', { id, team });

    if (this.mode === 'snd' && this.phase !== 'prep') {
      this._makeSpectator(entity, state);
    } else {
      this._respawn(entity, { emitEvent: false });
      state.survived = true;
      if (this.mode === 'snd') this._assignBomb();
    }
    return this.playerSnapshot(entity);
  }

  onPlayerRemove(player) {
    const entity = this._entity(player);
    const id = entity ? String(entity.id) : String(player ?? '');
    const state = this._players.get(id);
    if (!state) return false;

    const position = (entity && pointOf(entity)) || state.last;
    if (this.mode === 'snd' && this.bomb?.state === 'carried' && this.bomb.carrierId === id) {
      this._dropBomb(position, id, 'disconnect');
    }
    this._clearInteraction(id, true);
    this._players.delete(id);
    if (state.team) this._emit('team_removed', { id, team: state.team });
    return true;
  }

  onPlayerDeath(victim, killer = null) {
    const dead = this._entity(victim);
    if (!dead) return false;
    const state = this._state(dead);
    if (!state) return false;
    if (state.deathHandled) return false;
    state.deathHandled = true;

    state.last = pointOf(dead) || state.last;
    dead.respawnAt = this.now + this.respawnDelay();

    if (this.mode === 'snd') {
      if (this.phase !== 'post') state.survived = false;
      this._clearInteraction(String(dead.id), true);
      if (this.bomb.state === 'carried' && this.bomb.carrierId === String(dead.id)) {
        this._dropBomb(state.last, String(dead.id), 'death');
      }
      if (killer && this.isEnemy(killer, dead)) {
        const killerEntity = this._entity(killer);
        const killerState = this._state(killerEntity);
        if (killerEntity && killerState) this._addCredits(killerEntity, killerState, this.rules.killCredits, 'kill');
      }
      return true;
    }

    if (this.mode === 'tdm' && this.phase === 'live' && killer && this.isEnemy(killer, dead)) {
      const team = this.teamFor(killer);
      this.scores[team]++;
      this._emit('team_score', { team, score: this.scores[team] });
      if (this.scores[team] >= this.rules.scoreLimit) this._finishTdmMatch(team);
    }
    return true;
  }

  onPlayerRespawn(player) {
    const entity = this._entity(player);
    const state = this._state(entity);
    if (!entity || !state) return false;

    if (this.mode === 'snd' && this.phase !== 'prep') {
      this._makeSpectator(entity, state);
      return false;
    }
    this._applyOwnedLoadout(entity, state);
    state.deathHandled = false;
    state.last = pointOf(entity) || state.last;
    state.survived = true;
    return true;
  }

  respawnDelay() {
    return this.mode === 'snd' ? Infinity : this.rules.respawnMs;
  }

  canRespawn(player) {
    const entity = this._entity(player);
    if (!entity || entity.state !== 'dead') return false;
    return this.mode === 'fun'
      || (this.mode === 'tdm' ? this.phase === 'live' : this.phase === 'prep');
  }

  canTimedRespawn(player) {
    return this.mode !== 'snd' && this.canRespawn(player);
  }

  chooseSpawn(player, excludeIndex = -1) {
    const entity = this._entity(player);
    const pool = this._spawnPool(entity);
    if (pool.length) {
      if (typeof this.engine.selectSafestSpawn === 'function') {
        return this.engine.selectSafestSpawn(pool, entity, excludeIndex);
      }
      for (let i = 0; i < pool.length; i++) {
        const source = pool[i];
        const point = pointOf(source);
        const index = Number.isFinite(source?.index) ? Math.trunc(source.index) : i;
        if (point && (index !== excludeIndex || pool.length === 1)) {
          return { ...point, index };
        }
      }
    }

    if (typeof this.engine.nextSpawnFor === 'function') {
      return this.engine.nextSpawnFor(entity, excludeIndex);
    }
    if (typeof this.engine.nextSpawn === 'function') return this.engine.nextSpawn(excludeIndex);
    return { x: 0, y: 1, z: 0, index: 0 };
  }

  tick() {
    this._rememberPositions();
    if (this.mode === 'fun') return;
    if (this.mode === 'tdm') {
      if (this.phase === 'post' && this.now >= this.phaseEndsAt) this._resetTdmMatch();
      return;
    }

    if (this.phase === 'post') {
      if (this.now >= this.phaseEndsAt) this._startNextSndRound();
      return;
    }

    this._assignBomb();
    this._pickupDroppedBomb();
    if (this.phase === 'prep') {
      if (this.now >= this.phaseEndsAt) this._startSndLive();
      return;
    }

    const completedDefuse = this._updateInteractions();
    if (this.bomb.state === 'planted' && this.now >= this.bomb.explodeAt) {
      this.bomb.state = 'exploded';
      this._emit('bomb_explode', {
        site: this.bomb.siteId,
        x: this.bomb.x,
        y: this.bomb.y,
        z: this.bomb.z,
      });
      this._finishSndRound(this.attackers, 'explosion');
      return;
    }
    if (completedDefuse) {
      this.bomb.state = 'defused';
      this._emit('bomb_defuse', { id: completedDefuse, site: this.bomb.siteId });
      this._finishSndRound(this.defenders, 'defuse');
      return;
    }

    const outcome = this._eliminationOutcome();
    if (outcome) {
      this._finishSndRound(outcome, 'elimination');
      return;
    }

    if (this.now >= this.phaseEndsAt && this.bomb.state !== 'planted' && this._players.size) {
      this._finishSndRound(this.defenders, 'time');
    }
  }

  purchase(player, weapon) {
    const entity = this._entity(player);
    const state = this._state(entity);
    const id = weaponId(weapon);
    if (this.mode !== 'snd' || this.phase !== 'prep' || !entity || !state || !id) return false;
    if (!state.participating || entity.state !== 'alive') return false;

    const price = WEAPON_PRICES[id];
    if (!Number.isFinite(price) || state.credits < price) return false;
    state.credits -= price;
    state.owned.add(id);
    this._refillWeapon(entity, id);
    entity.weapon = WEAPON_IDS.indexOf(id);
    entity.reloading = false;
    entity.reloadT = 0;
    entity.deployT = WEAPONS[id].deployTime;
    this._syncPlayer(entity, state);
    this._emit('purchase', { id: String(entity.id), weapon: id, price, credits: state.credits });
    return true;
  }

  matchSnapshot() {
    const base = {
      mode: this.mode,
      map: typeof this.mapMeta?.id === 'string' ? this.mapMeta.id : null,
      phase: this.phase,
      phaseEndsAt: this.phaseEndsAt,
      scores: this.scores ? { [ALPHA]: this.scores[ALPHA], [BRAVO]: this.scores[BRAVO] } : null,
      winner: this.matchWinner,
      round: this.round,
      roundWinner: this.roundWinner,
      attackers: this.mode === 'snd' ? this.attackers : null,
      defenders: this.mode === 'snd' ? this.defenders : null,
      bomb: null,
    };
    if (this.mode === 'snd') base.bomb = this._bombSnapshot();
    return base;
  }

  playerSnapshot(player) {
    const entity = this._entity(player);
    const state = this._state(entity);
    const interaction = entity ? this._interactionSnapshot(String(entity.id)) : null;
    if (!state) {
      return {
        team: null,
        credits: 0,
        owned: this.mode === 'snd' ? [] : WEAPON_IDS.slice(),
        bomb: false,
        interaction,
        spawnProtected: false,
      };
    }
    return {
      team: state.team,
      credits: state.credits,
      owned: WEAPON_IDS.filter((id) => state.owned.has(id)),
      bomb: this.mode === 'snd'
        && this.bomb.state === 'carried'
        && this.bomb.carrierId === String(entity.id),
      interaction,
      spawnProtected: Number.isFinite(entity.spawnProtectedUntil)
        && entity.spawnProtectedUntil > this.now,
    };
  }

  botGoal(player) {
    const entity = this._entity(player);
    const state = this._state(entity);
    if (!entity || !state || entity.state !== 'alive') {
      return { kind: 'spectate', target: null, interact: false };
    }
    if (this.mode !== 'snd') return { kind: 'fight', target: null, interact: false };
    if (!state.participating || this.phase === 'post') {
      return { kind: 'spectate', target: null, interact: false };
    }

    const role = this.roleFor(entity);
    const bombPoint = this._bombPosition();
    if (role === 'attackers') {
      if (this.bomb.state === 'planted') {
        return { kind: 'defendBomb', target: bombPoint, interact: false };
      }
      if (this.bomb.state === 'dropped' && bombPoint) {
        return { kind: 'recoverBomb', target: bombPoint, interact: false };
      }
      if (this.bomb.carrierId === String(entity.id)) {
        return { kind: 'plant', target: this._nearestSiteCenter(entity), interact: this.phase === 'live' };
      }
      const carrier = this._entity(this.bomb.carrierId);
      return { kind: 'escortCarrier', target: carrier ? pointOf(carrier) : this._nearestSiteCenter(entity), interact: false };
    }

    if (this.bomb.state === 'planted') {
      return { kind: 'defuse', target: bombPoint, interact: this.phase === 'live' };
    }
    if (this.bomb.state === 'dropped' && bombPoint) {
      return { kind: 'guardBomb', target: bombPoint, interact: false };
    }
    return { kind: 'defendSite', target: this._siteForId(String(entity.id)), interact: false };
  }

  _entity(value) {
    if (value && typeof value === 'object') return value;
    if (value == null || !this.engine.entities?.get) return null;
    return this.engine.entities.get(String(value)) || null;
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
    if (!Array.isArray(this.engine.tickEvents)) this.engine.tickEvents = [];
    this.engine.tickEvents.push({ t: 'ev', kind, at: this.now, ...fields });
  }

  _syncPlayer(entity, state) {
    entity.team = state.team;
    entity.credits = state.credits;
    entity.owned = WEAPON_IDS.filter((id) => state.owned.has(id));
    entity.bomb = this.mode === 'snd'
      && this.bomb?.state === 'carried'
      && this.bomb.carrierId === String(entity.id);
    entity.interaction = this._interactionSnapshot(String(entity.id));
    entity.spawnProtected = Number.isFinite(entity.spawnProtectedUntil)
      && entity.spawnProtectedUntil > this.now;
  }

  _syncAllPlayers() {
    for (const entity of this.engine.entities?.values?.() || []) {
      const state = this._state(entity);
      if (state) this._syncPlayer(entity, state);
    }
  }

  _rememberPositions() {
    for (const entity of this.engine.entities?.values?.() || []) {
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
    if (typeof this.engine.respawnPlayer === 'function') {
      this.engine.respawnPlayer(entity, spawn, { emitEvent });
    } else if (typeof entity.applySpawn === 'function') {
      entity.applySpawn(spawn);
    }
    const state = this._state(entity);
    if (state) {
      state.deathHandled = false;
      state.last = pointOf(entity) || state.last;
      this._applyOwnedLoadout(entity, state);
    }
  }

  _applyOwnedLoadout(entity, state) {
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
  }

  _refillWeapon(entity, id) {
    const slot = WEAPON_IDS.indexOf(id);
    if (slot < 0) return;
    if (!Array.isArray(entity.mag)) entity.mag = WEAPON_IDS.map(() => 0);
    if (!Array.isArray(entity.reserve)) entity.reserve = WEAPON_IDS.map(() => 0);
    entity.mag[slot] = WEAPONS[id].magSize;
    entity.reserve[slot] = WEAPONS[id].reserveMax;
  }

  _spawnPool(entity) {
    const spawns = this.mapMeta?.spawns;
    if (!spawns) return [];
    if (this.mode === 'fun') return Array.isArray(spawns.fun) ? spawns.fun : [];
    if (this.mode === 'tdm') {
      const pool = spawns.tdm?.[this.teamFor(entity)];
      return Array.isArray(pool) ? pool : [];
    }
    const role = this.roleFor(entity);
    const pool = role ? spawns.snd?.[role] : null;
    return Array.isArray(pool) ? pool : [];
  }


  _finishTdmMatch(winner) {
    if (this.phase !== 'live') return;
    this.phase = 'post';
    this.phaseEndsAt = this.now + this.rules.postMs;
    this.matchWinner = winner;
    this._emit('match_end', { mode: this.mode, winner, scores: { ...this.scores } });
    this._emit('phase', { mode: this.mode, phase: this.phase, endsAt: this.phaseEndsAt });
  }

  _resetTdmMatch() {
    this.scores[ALPHA] = 0;
    this.scores[BRAVO] = 0;
    this.matchWinner = null;
    this.phase = 'live';
    this.phaseEndsAt = null;
    for (const entity of this.engine.entities?.values?.() || []) {
      entity.score = 0;
      entity.kills = 0;
      entity.deaths = 0;
      this._respawn(entity);
    }
    this._emit('match_start', { mode: this.mode, scores: { ...this.scores } });
    this._emit('phase', { mode: this.mode, phase: this.phase, endsAt: null });
  }

  _startSndLive() {
    if (this.phase !== 'prep') return;
    this.phase = 'live';
    this.phaseEndsAt = this.now + this.rules.liveMs;
    this._assignBomb();
    this._emit('phase', { mode: this.mode, phase: this.phase, endsAt: this.phaseEndsAt, round: this.round });
  }

  _finishSndRound(winner, reason) {
    if (this.phase !== 'live' || !TEAM_SET.has(winner)) return;
    this.roundWinner = winner;
    this.completedRounds++;
    this.scores[winner]++;

    const loser = winner === ALPHA ? BRAVO : ALPHA;
    this.lossStreak[winner] = 0;
    this.lossStreak[loser]++;
    const lossIndex = Math.min(this.lossStreak[loser] - 1, this.rules.lossCredits.length - 1);
    const lossAward = this.rules.lossCredits[lossIndex];

    for (const entity of this.engine.entities?.values?.() || []) {
      const state = this._state(entity);
      if (!state) continue;
      state.survived = state.participating && entity.state === 'alive';
      if (state.team === winner) this._addCredits(entity, state, this.rules.roundWinCredits, 'round_win');
      else if (state.team === loser) this._addCredits(entity, state, lossAward, 'round_loss');
    }

    this.phase = 'post';
    this.phaseEndsAt = this.now + this.rules.postMs;
    this._clearAllInteractions();
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

  _startNextSndRound() {
    const newMatch = !!this.matchWinner;
    if (newMatch) this._resetSndMatchState();
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
    this._clearAllInteractions();

    for (const entity of this.engine.entities?.values?.() || []) {
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
          if (Number.isFinite(savedReserve[i])) entity.reserve[i] = Math.max(0, Math.trunc(savedReserve[i]));
        }
        if (savedWeapon && state.owned.has(savedWeapon)) entity.weapon = WEAPON_IDS.indexOf(savedWeapon);
      }
      state.survived = true;
      this._syncPlayer(entity, state);
    }

    this.bomb = freshBomb();
    this._assignBomb();
    if (newMatch) this._emit('match_start', { mode: this.mode, scores: { ...this.scores } });
    this._emit('round_start', {
      round: this.round,
      attackers: this.attackers,
      defenders: this.defenders,
    });
    this._emit('phase', { mode: this.mode, phase: this.phase, endsAt: this.phaseEndsAt, round: this.round });
  }

  _resetSndMatchState() {
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
    for (const entity of this.engine.entities?.values?.() || []) {
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

  _addCredits(entity, state, amount, reason) {
    const before = state.credits;
    state.credits = Math.min(this.rules.maxCredits, Math.max(0, before + amount));
    this._syncPlayer(entity, state);
    if (state.credits !== before) {
      this._emit('credits', {
        id: String(entity.id),
        amount: state.credits - before,
        credits: state.credits,
        reason,
      });
    }
  }

  _assignBomb() {
    if (this.mode !== 'snd' || !this.bomb?.unassigned) return;
    const candidates = [];
    for (const entity of this.engine.entities?.values?.() || []) {
      const state = this._state(entity);
      if (state?.participating && state.team === this.attackers && entity.state === 'alive') candidates.push(entity);
    }
    candidates.sort(stableIdCompare);
    if (!candidates.length) return;
    const carrier = candidates[(this.round - 1) % candidates.length];
    this.bomb.state = 'carried';
    this.bomb.carrierId = String(carrier.id);
    this.bomb.siteId = null;
    this.bomb.x = null;
    this.bomb.y = null;
    this.bomb.z = null;
    this.bomb.plantedAt = null;
    this.bomb.explodeAt = null;
    this.bomb.unassigned = false;
    this._syncAllPlayers();
    this._emit('bomb_assigned', { id: this.bomb.carrierId, round: this.round });
  }

  _dropBomb(position, carrierId, reason) {
    if (!position) return;
    this.bomb.state = 'dropped';
    this.bomb.carrierId = null;
    this.bomb.siteId = null;
    this.bomb.x = position.x;
    this.bomb.y = position.y;
    this.bomb.z = position.z;
    this.bomb.plantedAt = null;
    this.bomb.explodeAt = null;
    this.bomb.unassigned = false;
    this._syncAllPlayers();
    this._emit('bomb_drop', {
      id: carrierId,
      reason,
      x: this.bomb.x,
      y: this.bomb.y,
      z: this.bomb.z,
    });
  }

  _pickupDroppedBomb() {
    if (this.bomb.state !== 'dropped' || this.bomb.unassigned) return;
    const point = this._bombPosition();
    if (!point) return;
    const candidates = [];
    for (const entity of this.engine.entities?.values?.() || []) {
      const state = this._state(entity);
      if (!state?.participating || state.team !== this.attackers || entity.state !== 'alive') continue;
      const d = distance(point, entity);
      if (d <= this.rules.pickupRadius) candidates.push({ entity, d });
    }
    candidates.sort((a, b) => a.d - b.d || stableIdCompare(a.entity, b.entity));
    if (!candidates.length) return;
    const carrier = candidates[0].entity;
    this.bomb.state = 'carried';
    this.bomb.carrierId = String(carrier.id);
    this.bomb.x = null;
    this.bomb.y = null;
    this.bomb.z = null;
    this._syncAllPlayers();
    this._emit('bomb_pickup', { id: this.bomb.carrierId });
  }

  _updateInteractions() {
    let completedDefuse = null;
    const entities = Array.from(this.engine.entities?.values?.() || []).sort(stableIdCompare);
    for (const entity of entities) {
      const id = String(entity.id);
      const state = this._state(entity);
      const held = !!(entity.input?.interact || entity.input?.keys?.interact);
      let intent = null;

      if (held && state?.participating && entity.state === 'alive') {
        if (state.team === this.attackers
            && this.bomb.state === 'carried'
            && this.bomb.carrierId === id) {
          const site = this._sites().find((candidate) => insideSite(entity, candidate));
          if (site) intent = { kind: 'plant', siteId: String(site.id), duration: this.rules.plantMs };
        } else if (state.team === this.defenders
            && this.bomb.state === 'planted'
            && distance(entity, this.bomb) <= this.rules.defuseRadius) {
          intent = { kind: 'defuse', siteId: this.bomb.siteId, duration: this.rules.defuseMs };
        }
      }

      if (!intent) {
        this._clearInteraction(id, true);
        continue;
      }

      let interaction = this._interactions.get(id);
      if (!interaction || interaction.kind !== intent.kind || interaction.siteId !== intent.siteId) {
        this._clearInteraction(id, true);
        interaction = { ...intent, startedAt: this.now };
        this._interactions.set(id, interaction);
        this._emit('interaction_start', { id, action: intent.kind, site: intent.siteId });
      }

      if (this.now - interaction.startedAt < interaction.duration) continue;
      if (interaction.kind === 'plant') {
        this._plantBomb(entity, interaction.siteId);
        return null;
      }
      if (!completedDefuse) completedDefuse = id;
    }
    this._syncAllPlayers();
    return completedDefuse;
  }

  _plantBomb(entity, siteId) {
    this.bomb.state = 'planted';
    this.bomb.carrierId = null;
    this.bomb.siteId = siteId;
    this.bomb.x = entity.x;
    this.bomb.y = entity.y;
    this.bomb.z = entity.z;
    this.bomb.plantedAt = this.now;
    this.bomb.explodeAt = this.now + this.rules.fuseMs;
    this.bomb.unassigned = false;
    const state = this._state(entity);
    if (state) this._addCredits(entity, state, this.rules.plantCredits, 'plant');
    this._clearAllInteractions();
    this._syncAllPlayers();
    this._emit('bomb_plant', {
      id: String(entity.id),
      site: siteId,
      x: this.bomb.x,
      y: this.bomb.y,
      z: this.bomb.z,
      explodeAt: this.bomb.explodeAt,
    });
  }

  _clearInteraction(id, emit) {
    const prior = this._interactions.get(id);
    if (!prior) return;
    this._interactions.delete(id);
    const entity = this._entity(id);
    if (entity) entity.interaction = null;
    if (emit) this._emit('interaction_cancel', { id, action: prior.kind, site: prior.siteId });
  }

  _clearAllInteractions() {
    for (const id of Array.from(this._interactions.keys())) this._clearInteraction(id, false);
  }

  _interactionSnapshot(id) {
    const interaction = this._interactions.get(id);
    if (!interaction) return null;
    return {
      kind: interaction.kind,
      site: interaction.siteId,
      progress: clamp01((this.now - interaction.startedAt) / interaction.duration),
    };
  }

  _eliminationOutcome() {
    let attackers = 0;
    let defenders = 0;
    let aliveAttackers = 0;
    let aliveDefenders = 0;
    for (const entity of this.engine.entities?.values?.() || []) {
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

  _bombPosition() {
    if (!this.bomb) return null;
    if (this.bomb.state === 'carried' && this.bomb.carrierId) {
      const carrier = this._entity(this.bomb.carrierId);
      return carrier ? pointOf(carrier) : null;
    }
    return [this.bomb.x, this.bomb.y, this.bomb.z].every(Number.isFinite)
      ? { x: this.bomb.x, y: this.bomb.y, z: this.bomb.z }
      : null;
  }

  _bombSnapshot() {
    const point = this._bombPosition();
    return {
      state: this.bomb.state,
      carrier: this.bomb.carrierId,
      site: this.bomb.siteId,
      x: point?.x ?? null,
      y: point?.y ?? null,
      z: point?.z ?? null,
      explodeAt: this.bomb.explodeAt,
    };
  }

  _sites() {
    return Array.isArray(this.mapMeta?.sites) ? this.mapMeta.sites : [];
  }

  _nearestSiteCenter(entity) {
    let best = null;
    let bestDistance = Infinity;
    for (const site of this._sites()) {
      const center = siteCenter(site);
      if (!center) continue;
      const d = distance(entity, center);
      if (d < bestDistance) {
        best = center;
        bestDistance = d;
      }
    }
    return best;
  }

  _siteForId(id) {
    const sites = this._sites();
    if (!sites.length) return null;
    let hash = this.round || 1;
    for (let i = 0; i < id.length; i++) hash = (Math.imul(hash, 31) + id.charCodeAt(i)) >>> 0;
    return siteCenter(sites[hash % sites.length]);
  }
}
