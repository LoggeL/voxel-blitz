import { WEAPONS, WEAPON_IDS } from '../../shared/combatmath.js';
import { BasePolicy } from './base-policy.js';

export function shuffledGunGameOrder(order, random = Math.random) {
  const weapons = order.filter((id) => id !== 'knife');
  for (let i = weapons.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [weapons[i], weapons[j]] = [weapons[j], weapons[i]];
  }
  return Object.freeze([...weapons, 'knife']);
}

/** Owns Gun Game weapon progression, legal loadouts, and match completion. */
export class GunGamePolicy extends BasePolicy {
  constructor(context) {
    const order = context?.rules?.weaponOrder;
    if (!Array.isArray(order) || !order.length) throw new TypeError('GunGamePolicy requires a weapon order');
    super('GunGamePolicy', context);
    this.mode = 'gungame';
    this.weaponOrder = shuffledGunGameOrder(order);
    this._players = new Map();
  }

  tick() {
    if (this.phase === 'post' && Number.isFinite(this.phaseEndsAt) && this.now >= this.phaseEndsAt) this.reset();
  }

  canUseWeapon(player, weapon) {
    const entity = this._entity(player);
    const state = this._state(entity);
    const slot = typeof weapon === 'string' ? WEAPON_IDS.indexOf(weapon) : Math.trunc(weapon);
    return !!state && Number.isFinite(slot) && slot === this._weaponSlot(state.level);
  }

  canFire(player) {
    const entity = this._entity(player);
    return !!entity
      && entity.state === 'alive'
      && this.phase === 'live'
      && this.canUseWeapon(entity, entity.weapon);
  }

  onPlayerAdd(player) {
    const entity = this._entity(player);
    if (!entity) return null;
    const id = String(entity.id);
    if (this._players.has(id)) return this.playerSnapshot(entity);
    this._players.set(id, { level: 0 });
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
    if (!entity) return false;
    const priorId = String(entity.id);
    const id = String(nextId ?? '');
    const state = this._players.get(priorId);
    if (!state || !id || this._players.has(id)) return false;
    this._players.delete(priorId);
    this._players.set(id, state);
    return true;
  }

  onPlayerDeath(victim, killer = null, context = null) {
    const dead = this._entity(victim);
    if (!dead || !this._state(dead)) return false;
    dead.respawnAt = this.now + this.respawnDelay();

    const scorer = this._entity(killer);
    const state = this._state(scorer);
    const usedWeapon = typeof context?.weapon === 'string' ? context.weapon : null;
    if (scorer && state) scorer.score = state.level;
    if (this.phase !== 'live'
        || !scorer
        || !state
        || !this.isEnemy(scorer, dead)
        || usedWeapon !== this._weaponId(state.level)) {
      return true;
    }

    state.level++;
    scorer.score = state.level;
    if (state.level >= this.weaponOrder.length) {
      this._finishMatch(String(scorer.id));
      return true;
    }

    this._applyLoadout(scorer, state);
    return true;
  }

  killScoreDelta() { return 0; }

  onPlayerRespawn(player) {
    const entity = this._entity(player);
    const state = this._state(entity);
    if (!entity || !state) return false;
    this._applyLoadout(entity, state);
    return true;
  }

  respawnDelay() { return this.rules.respawnMs; }

  canRespawn(player) {
    const entity = this._entity(player);
    return !!entity && entity.state === 'dead' && this.phase === 'live';
  }

  canTimedRespawn(player) { return this.canRespawn(player); }

  chooseSpawn(player, excludeIndex = -1) {
    const pool = Array.isArray(this.mapMeta?.spawns?.fun) ? this.mapMeta.spawns.fun : [];
    return this._chooseSpawn(pool, this._entity(player), excludeIndex);
  }

  buy() { return false; }

  botGoal(player) {
    const entity = this._entity(player);
    return entity?.state === 'alive' && this.phase === 'live'
      ? { kind: 'fight', target: null, interact: false }
      : { kind: 'spectate', target: null, interact: false };
  }

  matchSnapshot() {
    return {
      mode: this.mode,
      map: typeof this.mapMeta?.id === 'string' ? this.mapMeta.id : null,
      phase: this.phase,
      phaseEndsAt: this.phaseEndsAt,
      scores: null,
      winner: this.matchWinner,
      round: null,
      roundWinner: null,
      attackers: null,
      defenders: null,
      bomb: null,
    };
  }

  playerSnapshot(player) {
    const entity = this._entity(player);
    const state = this._state(entity);
    const weapon = this._weaponId(state?.level ?? 0);
    return {
      team: null,
      credits: 0,
      owned: weapon ? [weapon] : [],
      bomb: false,
      interaction: null,
      spawnProtected: this._spawnProtected(entity),
    };
  }

  reset() {
    this.weaponOrder = shuffledGunGameOrder(this.rules.weaponOrder);
    this.phase = 'live';
    this.phaseEndsAt = null;
    this.matchWinner = null;
    for (const entity of this._entities.values()) {
      const state = this._state(entity);
      if (!state) continue;
      state.level = 0;
      entity.score = 0;
      entity.kills = 0;
      entity.deaths = 0;
      this._respawn(entity);
    }
    this._emit('match_start', { mode: this.mode });
    this._emit('phase', { mode: this.mode, phase: this.phase, endsAt: null });
  }

  dispose() { this._players.clear(); }

  _weaponId(level) {
    return this.weaponOrder[Math.max(0, Math.min(
      this.weaponOrder.length - 1,
      Number.isFinite(level) ? Math.trunc(level) : 0,
    ))] || null;
  }

  _weaponSlot(level) {
    return WEAPON_IDS.indexOf(this._weaponId(level));
  }

  _applyLoadout(entity, state) {
    const slot = this._weaponSlot(state.level);
    const id = WEAPON_IDS[slot];
    if (slot < 0 || !WEAPONS[id]) return false;
    if (!Array.isArray(entity.mag)) entity.mag = WEAPON_IDS.map(() => 0);
    if (!Array.isArray(entity.reserve)) entity.reserve = WEAPON_IDS.map(() => 0);
    for (let i = 0; i < WEAPON_IDS.length; i++) {
      entity.mag[i] = i === slot ? WEAPONS[id].magSize : 0;
      entity.reserve[i] = i === slot ? (WEAPONS[id].spareRounds ?? WEAPONS[id].spareMags) : 0;
    }
    entity.infiniteMagazines = true;
    entity.weapon = slot;
    entity.reloading = false;
    entity.reloadT = 0;
    entity.deployT = WEAPONS[id].deployTime;
    entity.ads = false;
    entity.adsT = 0;
    entity.bloom = 0;
    return true;
  }

  _respawn(entity, { emitEvent = true } = {}) {
    const spawn = this.chooseSpawn(entity, entity.lastSpawnIndex);
    this._respawnEntity(entity, spawn, { emitEvent });
    const state = this._state(entity);
    if (state) {
      this._applyLoadout(entity, state);
    }
  }

  _finishMatch(winner) {
    if (this.phase !== 'live') return;
    this.phase = 'post';
    this.phaseEndsAt = null; // ModeController sets it once the continuation vote passes
    this.matchWinner = winner;
    this._emit('match_end', { mode: this.mode, winner });
    this._emit('phase', { mode: this.mode, phase: this.phase, endsAt: this.phaseEndsAt });
  }
}
