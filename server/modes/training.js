import { WEAPON_IDS } from '../../shared/combatmath.js';
import { AIR, METAL } from '../../shared/worlddata.js';

// Firing-range policy for the killhouse map. Idle dummy targets occupy fixed
// posts (range dummies respawn fast, stage dummies gate a 4-stage timed run),
// humans never fight each other, and gate seals are mutated through the
// engine's block seam so every rearm/open broadcasts as a block delta.

const DUMMY_ID_PREFIX = 'dummy-';
const RANGE_DUMMY_RESPAWN_MS = 1200;
const STAGE_DUMMY_RESPAWN_MS = 4000;
const FINISH_STAGE = 3;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function isDummyId(value) {
  return String(value ?? '').startsWith(DUMMY_ID_PREFIX);
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
    this._emitEvent = emit;
    this._respawnEntity = respawn;
    this._chooseSpawn = chooseSpawn;
    this._spawnDummy = spawnDummy;
    this._blocks = blocks;
    this._players = new Set();
    this._runs = new Map();
    this._best = new Map();
    // Built lazily on the first tick: engine.spawnSelector is assigned after
    // ModeController during engine construction, so addBot would crash earlier.
    this._dummies = null;
    this._stageDummyIds = new Map();
  }

  get now() {
    const value = this._clock();
    return Number.isFinite(value) ? value : 0;
  }

  tick() {
    this._ensureDummies();
    this._tickRuns();
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
    this._runs.delete(id);
    return this._players.delete(id);
  }

  onPlayerDeath(victim) {
    const entity = this._entity(victim);
    if (!entity || !this._players.has(String(entity.id))) return false;
    entity.respawnAt = this.now + this.respawnDelay(entity);
    if (isDummyId(entity.id)) return true;
    const id = String(entity.id);
    if (this._runs.has(id)) {
      this._runs.delete(id);
      this._emit('run_reset', { id, reason: 'death' });
    }
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

  canTimedRespawn(player) { return this.canRespawn(player); }

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
    this._runs.clear();
    this._best.clear();
    this._dummies = null;
    this._stageDummyIds.clear();
  }

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

  _tickRuns() {
    const course = this.mapMeta?.course;
    if (!course) return;
    const now = this.now;
    for (const entity of this._entities.values()) {
      if (!entity || entity.state !== 'alive') continue;
      const id = String(entity.id);
      if (isDummyId(id)) continue;
      const run = this._runs.get(id);
      if (!run) {
        if (this._feetInside(entity, course.start)) this._startRun(id, now);
        continue;
      }
      if (this._stageCleared(run.stage)) {
        const ms = now - run.startedAt;
        run.splits.push(ms);
        this._emit('run_split', { id, stage: run.stage, ms });
        // Postfix reading: the gate the player must now pass is the one in
        // front of the room they just cleared.
        if (run.stage < FINISH_STAGE) this._openGate(run.stage);
        run.stage++;
        continue;
      }
      if (run.leftStart) {
        if (this._feetInside(entity, course.start)) {
          this._emit('run_reset', { id, reason: 'rearmed' });
          this._startRun(id, now);
          continue;
        }
      } else if (!this._feetInside(entity, course.start)) {
        run.leftStart = true;
      }
      if (run.stage > FINISH_STAGE && this._feetInside(entity, course.finish)) {
        const ms = now - run.startedAt;
        const prior = this._best.get(id);
        const best = Number.isFinite(prior) ? Math.min(prior, ms) : ms;
        this._best.set(id, best);
        this._emit('run_finish', { id, ms, best, splits: run.splits.slice() });
        this._runs.delete(id);
      }
    }
  }

  _stageCleared(stage) {
    const ids = this._stageDummyIds.get(stage);
    if (!ids || !ids.length) return false;
    return ids.every((id) => !this._isAlive(id));
  }

  _isAlive(id) {
    const entity = this._entities.get(id);
    return !!entity && entity.state === 'alive';
  }

  _startRun(id, now) {
    this._runs.set(id, { stage: 0, startedAt: now, splits: [], leftStart: false });
    this._rearmGates();
    this._resetStageDummies();
    this._emit('run_start', { id, at: now });
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

  _feetInside(entity, region) {
    if (!region) return false;
    const x = Math.floor(entity.x);
    const z = Math.floor(entity.z);
    return x >= region.minX && x <= region.maxX
      && z >= region.minZ && z <= region.maxZ;
  }

  _setGate(gate, value) {
    const course = this.mapMeta?.course;
    if (!course || !gate || !Number.isFinite(gate.x)) return;
    const x = Math.trunc(gate.x);
    const [yMin, yMax] = course.gateY;
    const [zMin, zMax] = course.gateZ;
    for (let y = yMin; y <= yMax; y++) {
      for (let z = zMin; z <= zMax; z++) {
        this._blocks.set(x, y, z, value);
      }
    }
  }

  _rearmGates() {
    for (const gate of this.mapMeta?.course?.gates || []) this._setGate(gate, METAL);
  }

  _openGate(stage) {
    const gate = this.mapMeta?.course?.gates?.[stage];
    if (gate) this._setGate(gate, AIR);
  }

  _emit(kind, fields = {}) {
    this._emitEvent(kind, fields);
  }
}
