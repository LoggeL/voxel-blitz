import { FunPolicy } from './modes/fun.js';
import { TttPolicy } from './modes/ttt.js';
import { CHAOS_START_CREDITS, CHAOS_KILL_CREDITS, CHAOS_UPGRADES, chaosLevel, parseChaosPurchase, chaosPurchaseId } from '../shared/chaos.js';
// Authoritative mode facade. GameEngine talks to one stable controller while
// state-owning team policies live in server/modes/.

import { WEAPON_IDS, WEAPONS } from '../shared/combatmath.js';
import {
  DEFAULT_MODE_ID,
  DUEL_WEAPONS,
  MODE_RULES,
  isModeMapCompatible,
  normalizeModeId,
} from '../shared/modes.js';
import { SndPolicy } from './modes/snd.js';
import { TdmPolicy } from './modes/tdm.js';
import { GunGamePolicy } from './modes/gungame.js';
import { BastionPolicy } from './modes/bastion.js';
import { TrainingPolicy } from './modes/training.js';
import { RoundContinuation } from './modes/round-continuation.js';


class DuelPolicy extends FunPolicy {
  constructor(context) {
    super(context);
    this.mode = 'duel';
  }

  canFire(player) { return this.phase === 'live' && super.canFire(player); }
  canDamage(attacker, target) { return this.phase === 'live' && super.canDamage(attacker, target); }
  canRespawn(player) { return this.phase === 'live' && super.canRespawn(player); }

  onPlayerDeath(victim, killer) {
    if (this.phase !== 'live' || !super.onPlayerDeath(victim)) return false;
    if (killer && this.isEnemy(killer, victim) && killer.kills >= this.rules.killLimit) {
      this.phase = 'post';
      this.matchWinner = String(killer.id);
      this.phaseEndsAt = null;
      this._emit('match_end', { mode: this.mode, winner: this.matchWinner });
    }
    return true;
  }

  tick() {
    if (this.phase !== 'post' || !Number.isFinite(this.phaseEndsAt) || this.now < this.phaseEndsAt) return;
    this.phase = 'live';
    this.phaseEndsAt = null;
    this.matchWinner = null;
    for (const entity of this._entities.values()) {
      entity.kills = entity.deaths = entity.score = 0;
      this._respawn(entity);
    }
    this._emit('match_start', { mode: this.mode });
  }

  matchSnapshot() {
    return { ...super.matchSnapshot(), killLimit: this.rules.killLimit,
      phaseEndsAt: this.phaseEndsAt, winner: this.matchWinner,
      scores: Object.fromEntries([...this._entities.values()].map(p => [p.id, p.kills])) };
  }

  canUseWeapon(player, weapon) {
    const id = typeof weapon === 'string' ? weapon : WEAPON_IDS[Math.trunc(weapon)];
    return DUEL_WEAPONS.includes(id);
  }

  _syncPlayer(entity) {
    super._syncPlayer(entity);
    entity.owned = [...DUEL_WEAPONS];
    if (!this.canUseWeapon(entity, entity.weapon)) entity.weapon = WEAPON_IDS.indexOf('rifle');
    for (let i = 0; i < WEAPON_IDS.length; i++) {
      if (!DUEL_WEAPONS.includes(WEAPON_IDS[i])) {
        entity.mag[i] = 0;
        entity.reserve[i] = 0;
      }
    }
    entity.grenades = entity.grenades.map(() => 0);
  }

  playerSnapshot(player) {
    return { ...super.playerSnapshot(player), owned: [...DUEL_WEAPONS] };
  }
}

class ChaosPolicy extends FunPolicy {
  constructor(context) { super(context); this.mode = 'chaos'; }
  _syncPlayer(entity) {
    const credits = entity.credits;
    super._syncPlayer(entity);
    entity.credits = Number.isFinite(credits) && entity.chaosUpgrades ? credits : CHAOS_START_CREDITS;
    entity.chaosUpgrades ??= {};
    if (chaosLevel(entity, 'mgl') >= 3 && Array.isArray(entity.mag)) {
      const slot = WEAPON_IDS.indexOf('mgl');
      entity.mag[slot] = Math.max(WEAPONS.mgl.magSize + 1, Math.max(0, entity.mag[slot] | 0));
    }
  }
  playerSnapshot(player) {
    const entity = this._entity(player);
    return { ...super.playerSnapshot(player), credits: entity?.credits ?? 0,
      chaosUpgrades: { ...entity?.chaosUpgrades } };
  }
  onPlayerDeath(victim, killer) {
    if (!super.onPlayerDeath(victim)) return false;
    const winner = this._entity(killer);
    if (winner && this.isEnemy(winner, victim)) {
      winner.credits = Math.min(16000, winner.credits + CHAOS_KILL_CREDITS);
      winner.grenades = winner.grenades.map(n => Math.min(5, n + 1));
    }
    return true;
  }
  buy(player, request) {
    const p = this._entity(player), purchase = parseChaosPurchase(request);
    if (!p || p.state !== 'alive' || !purchase || !this._players.has(String(p.id))) return false;
    const { item, level } = purchase;
    const current = chaosLevel(p, item), upgrade = CHAOS_UPGRADES[item][current];
    if (!upgrade || level !== current + 1 || p.credits < upgrade.price) return false;
    p.credits -= upgrade.price;
    p.chaosUpgrades[item] = level;
    // Third plate seats its extra RIPTIDE disc at once; the normaliser keeps the cap.
    if (item === 'glaive' && level === 1 && Array.isArray(p.mag)) p.mag[WEAPON_IDS.indexOf('glaive')]++;
    if (item === 'mgl' && level === 3 && Array.isArray(p.mag)) {
      const slot = WEAPON_IDS.indexOf('mgl');
      p.mag[slot] = Math.min(WEAPONS.mgl.magSize + 1, Math.max(0, p.mag[slot] | 0) + 1);
    }
    return true;
  }
  tick() {
    for (const p of this._entities.values()) {
      if (!p.bot || p.state !== 'alive') continue;
      const item = WEAPON_IDS[p.weapon];
      this.buy(p, chaosPurchaseId(item, chaosLevel(p, item)));
    }
  }
}

/** Stable policy interface consumed by GameEngine and BotManager. */
export class ModeController {
  constructor(engine, { mode = DEFAULT_MODE_ID, mapMeta = null } = {}) {
    if (!engine || typeof engine !== 'object') {
      throw new TypeError('ModeController requires an engine');
    }
    this.engine = engine;
    this.continuation = new RoundContinuation(engine.entities, () => engine.now);
    const modeId = normalizeModeId(mode);
    const selectedMeta = mapMeta && typeof mapMeta === 'object' ? mapMeta : null;
    if (typeof selectedMeta?.id === 'string'
        && !isModeMapCompatible(modeId, selectedMeta.id)) {
      throw new RangeError(`mode ${modeId} is incompatible with map ${selectedMeta.id}`);
    }

    const context = {
      rules: { ...MODE_RULES[modeId] },
      mapMeta: selectedMeta,
      entities: engine.entities,
      now: () => engine.now,
      emit: (kind, fields = {}) => {
        this._syncContinuation();
        if (kind === 'phase' && fields.phase === 'post') fields = { ...fields, endsAt: this.phaseEndsAt };
        if (!Array.isArray(engine.tickEvents)) engine.tickEvents = [];
        engine.tickEvents.push({ t: 'ev', kind, at: engine.now, ...fields });
      },
      respawn: (entity, spawn, options) => engine.respawnPlayer(entity, spawn, options),
      glaiveStock: (entity) => engine.projectiles.glaiveStock(entity),
      chooseSpawn: (pool, entity, excludeIndex) => {
        if (Array.isArray(pool) && pool.length) {
          const candidates = ['fun', 'chaos', 'tdm', 'snd', 'gungame'].includes(modeId)
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

    if (modeId === 'ttt') this.policy = new TttPolicy(context, engine);
    else if (modeId === 'bastion') this.policy = new BastionPolicy(context, engine);
    else if (modeId === 'duel') this.policy = new DuelPolicy(context);
    else if (modeId === 'chaos') this.policy = new ChaosPolicy(context);
    else if (modeId === 'snd') this.policy = new SndPolicy(context);
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

  beforeTick(dt) { return this.policy.beforeTick?.(dt); }
  tick() {
    this._syncContinuation();
    if (this.phase === 'post' && (this.phaseEndsAt === null || this.engine.now < this.phaseEndsAt)) return;
    this.policy.tick();
    this._syncContinuation();
  }

  /**
   * The controller owns every post-phase deadline: policies enter `post` with
   * phaseEndsAt null and RoundContinuation sets it once enough humans approve.
   */
  _syncContinuation() {
    if (this.policy?.phase !== 'post') {
      if (this.continuation.id) this.continuation.clear();
      return;
    }
    if (!this.continuation.id) this.continuation.begin();
    this.continuation.sync();
    this.policy.phaseEndsAt = this.continuation.endsAt;
  }

  approveContinuation(playerId, roundId) {
    this._syncContinuation();
    if (this.phase !== 'post' || !this.continuation.approve(playerId, roundId)) return false;
    this._syncContinuation();
    return true;
  }
  teamFor(player) { return this.policy.teamFor(player); }
  setLobbyTeam(player, team) { return this.policy.setLobbyTeam?.(player, team) === true; }
  roleFor(player) { return this.policy.roleFor?.(player) ?? null; }
  isEnemy(a, b) { return this.policy.isEnemy(a, b); }
  canDamage(attacker, target) { return this.phase !== 'post' && this.policy.canDamage(attacker, target); }
  canUseWeapon(player, weapon) { return this.policy.canUseWeapon(player, weapon); }
  canFire(player) { return this.policy.canFire(player); }
  canThrow(player) { return this.policy.canThrow?.(player) ?? this.canFire(player); }
  canMelee(player) { return this.policy.canMelee?.(player) ?? this.canFire(player); }
  canMove(player) { return this.phase !== 'post' && this.policy.canMove?.(player) !== false; }
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
  canRespawn(player) { return this.policy.canRespawn(player); }
  canTimedRespawn(player) { return this.policy.canTimedRespawn(player); }
  chooseSpawn(player, excludeIndex) { return this.policy.chooseSpawn(player, excludeIndex); }
  purchase(player, weapon) { return this.policy.buy(player, weapon); }
  matchSnapshot() {
    this._syncContinuation();
    const match = this.policy.matchSnapshot();
    if (this.phase !== 'post') return match;
    return { ...match, continuation: this.continuation.snapshot(), results: this.continuation.results };
  }
  playerSnapshot(player) { return this.policy.playerSnapshot(player); }
  botGoal(player) { return this.policy.botGoal(player); }
  dispose() { return this.policy.dispose?.(); }
}
