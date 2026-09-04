import { WEAPON_IDS } from '../../shared/combatmath.js';
import { isTrainingDummyId as isDummyId } from '../../shared/modes.js';
import { TrainingCourse } from './training/course.js';

// Firing-range policy for the killhouse map. Idle dummy targets occupy fixed
// posts (range dummies respawn fast, stage dummies gate a 4-stage timed run),
// humans never fight each other, and gate seals are mutated through the
// engine's block seam so every rearm/open broadcasts as a block delta.

const DUMMY_ID_PREFIX = 'dummy-';
const RANGE_DUMMY_RESPAWN_MS = 1200;
const STAGE_DUMMY_RESPAWN_MS = 4000;

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** Owns dummy targets, spawn protection, and the staged killhouse run clock. */
export class TrainingPolicy {
  constructor({
    rules,
    mapMeta = null,
    entities,
    now,
    emit,
    respawn,
    chooseSpawn,
    spawnDummy,
    blocks,
  }) {
    if (!rules || typeof rules !== 'object') {
      throw new TypeError('TrainingPolicy requires rules');
    }
    if (!entities || typeof entities.get !== 'function' || typeof entities.values !== 'function') {
      throw new TypeError('TrainingPolicy requires entities');
    }
    if (typeof now !== 'function'
        || typeof emit !== 'function'
        || typeof respawn !== 'function'
        || typeof chooseSpawn !== 'function'
        || typeof spawnDummy !== 'function') {
      throw new TypeError('TrainingPolicy requires mode callbacks');
    }
    if (!blocks || typeof blocks.get !== 'function' || typeof blocks.set !== 'function') {
      throw new TypeError('TrainingPolicy requires block access');
    }

    this.mode = 'training';
    this.rules = rules;
    this.mapMeta = mapMeta && typeof mapMeta === 'object' ? mapMeta : null;
    this.phase = 'live';
    this.phaseEndsAt = null;
    this.scores = null;
    this.matchWinner = null;
    this.round = null;
    this.roundWinner = null;

    this._entities = entities;
    this._clock = now;
    this._respawnEntity = respawn;
    this._chooseSpawn = chooseSpawn;
    this._spawnDummy = spawnDummy;
    this._players = new Set();
    // Built lazily on the first tick: engine.spawnSelector is assigned after
    // ModeController during engine construction, so addBot would crash earlier.
    this._dummies = null;
    this._stageDummyIds = new Map();
    this.course = new TrainingCourse({
      course: this.mapMeta?.course,
      entities,
      now: () => this.now,
      emit,
      blocks,
      stageTargets: () => this._stageDummyIds,
      resetTargets: () => this._resetStageDummies(),
    });
  }

  get now() {
    const value = this._clock();
    return Number.isFinite(value) ? value : 0;
  }

  tick() {
    this._ensureDummies();
    this.course.tick();
  }

  teamFor() { return null; }
  roleFor() { return null; }

  isEnemy(a, b) {
    const left = this._entity(a);
    const right = this._entity(b);
    if (!left || !right) return false;
    if (isDummyId(left.id)) return false; // dummies are hostile to no one
    if (isDummyId(right.id)) return true; // humans shoot dummies
    return false; // humans never fight each other
  }

  canDamage(attacker, target) {
    const victim = this._entity(target);
    if (!victim) return false;
    if (!isDummyId(victim.id)
        && attacker != null
        && victim.spawnProtectedUntil > this.now) {
      return false;
    }
    if (attacker != null && this._dummies?.get(String(victim.id))?.kind === 'stage'
        && this.course.active && this._entity(attacker)?.id !== this.course.active.id) return false;
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
    if (!entity || isDummyId(entity.id)) return false;
    return entity.state === 'alive' && this.canUseWeapon(entity, entity.weapon);
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
    this.course.removePlayer(id);
    return this._players.delete(id);
  }

  onPlayerDeath(victim) {
    const entity = this._entity(victim);
    if (!entity || !this._players.has(String(entity.id))) return false;
    entity.respawnAt = this.now + this.respawnDelay(entity);
    if (isDummyId(entity.id)) return true;
    this.course.reset(String(entity.id), 'death');
    return true;
  }

  killScoreDelta() { return 0; }

  onPlayerRespawn(player) {
    const entity = this._entity(player);
    if (!entity || !this._players.has(String(entity.id))) return false;
    this._syncPlayer(entity);
    return true;
  }

  respawnDelay(player) {
    const entity = this._entity(player);
    if (entity && isDummyId(entity.id)) {
      return this._dummies?.get(String(entity.id))?.respawnMs ?? RANGE_DUMMY_RESPAWN_MS;
    }
    return this.rules.respawnMs;
  }

  canRespawn(player) {
    const entity = this._entity(player);
    return !!entity && entity.state === 'dead';
  }

  canTimedRespawn(player) {
    const entity = this._entity(player);
    // A timed attempt records its targets until the run ends. Range practice
    // keeps its independent respawn cadence throughout the attempt.
    if (this.course.active && this._dummies?.get(String(entity?.id))?.kind === 'stage') return false;
    return this.canRespawn(player);
  }

  chooseSpawn(player, excludeIndex = -1) {
    const entity = this._entity(player);
    if (entity && isDummyId(entity.id)) {
      const post = this._dummies?.get(String(entity.id))?.post;
      if (post) return this._chooseSpawn([post], entity, excludeIndex);
    }
    const pool = Array.isArray(this.mapMeta?.spawns?.fun) ? this.mapMeta.spawns.fun : [];
    return this._chooseSpawn(pool, entity, excludeIndex);
  }

  buy() { return false; }

  botGoal(_player) {
    return { kind: 'spectate', target: null, interact: false };
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

  dispose() {
    this._players.clear();
    this.course.dispose();
    this._dummies = null;
    this._stageDummyIds.clear();
  }

  _entity(value) {
    if (value && typeof value === 'object') return value;
    if (value == null) return null;
    return this._entities.get(String(value)) || null;
  }

  _syncPlayer(entity) {
    if (isDummyId(entity.id)) entity.spawnProtectedUntil = 0;
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

  _ensureDummies() {
    if (this._dummies) return;
    this._dummies = new Map();
    this._stageDummyIds = new Map();
    const posts = Array.isArray(this.mapMeta?.dummyPosts) ? this.mapMeta.dummyPosts : [];
    posts.forEach((post, index) => {
      if (!post || typeof post !== 'object'
          || ![post.x, post.y, post.z].every(Number.isFinite)) {
        return;
      }
      const id = DUMMY_ID_PREFIX + index;
      const kind = post.kind === 'stage' ? 'stage' : 'range';
      const stage = kind === 'stage' && Number.isFinite(post.stage)
        ? Math.trunc(post.stage)
        : null;
      this._dummies.set(id, {
        post: { x: post.x + 0.5, y: post.y, z: post.z + 0.5, index },
        kind,
        stage,
        respawnMs: kind === 'stage' ? STAGE_DUMMY_RESPAWN_MS : RANGE_DUMMY_RESPAWN_MS,
      });
      if (kind === 'stage' && stage !== null) {
        const ids = this._stageDummyIds.get(stage);
        if (ids) ids.push(id);
        else this._stageDummyIds.set(stage, [id]);
      }
      this._spawnDummy(id, 'Dummy ' + pad2(index + 1));
    });
  }

  /** Fresh targets per attempt: stage dummies return to their posts. */
  _resetStageDummies() {
    for (const ids of this._stageDummyIds.values()) {
      for (const id of ids) {
        const entity = this._entities.get(id);
        if (entity) this._respawn(entity, { emitEvent: false });
      }
    }
  }
}
