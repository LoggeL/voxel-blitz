import { WEAPON_IDS } from '../../shared/combatmath.js';
import { TEAM_IDS } from '../../shared/modes.js';

const ALPHA = TEAM_IDS[0];
const BRAVO = TEAM_IDS[1];
const TEAM_SET = new Set(TEAM_IDS);
const WEAPON_SET = new Set(WEAPON_IDS);

/** `{x,y,z}` copy of an entity or `[x,y,z]` tuple, or null when not finite. */
export function pointOf(value) {
  if (Array.isArray(value)) {
    const [x, y, z] = value;
    return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
  }
  if (!value || typeof value !== 'object') return null;
  return [value.x, value.y, value.z].every(Number.isFinite)
    ? { x: value.x, y: value.y, z: value.z }
    : null;
}

/** Weapon id for a slot index or id string, or null for anything unknown. */
export function weaponId(value) {
  if (typeof value === 'string' && WEAPON_SET.has(value)) return value;
  if (Number.isFinite(value)) return WEAPON_IDS[Math.trunc(value)] || null;
  return null;
}

/**
 * Shared seam of the state-owning mode policies.
 *
 * The injected callbacks are the only link to the simulation: `now` returns
 * the authoritative clock (read lazily so boundary ticks see the engine's
 * time), `emit` queues a mode event, `respawn` applies an authoritative spawn
 * and `chooseSpawn` selects from a policy-owned pool. Subclasses own their
 * player bookkeeping in `this._players`.
 */
export class BasePolicy {
  constructor(name, { rules, mapMeta = null, entities, now, emit, respawn, chooseSpawn } = {}) {
    if (!rules || typeof rules !== 'object') throw new TypeError(`${name} requires rules`);
    if (!entities || typeof entities.get !== 'function' || typeof entities.values !== 'function') {
      throw new TypeError(`${name} requires entities`);
    }
    if (typeof now !== 'function'
        || typeof emit !== 'function'
        || typeof respawn !== 'function'
        || typeof chooseSpawn !== 'function') {
      throw new TypeError(`${name} requires mode callbacks`);
    }

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
  }

  get now() {
    const value = this._clock();
    return Number.isFinite(value) ? value : 0;
  }

  teamFor() { return null; }
  roleFor() { return null; }

  /** Free-for-all by default: any two distinct combatants are enemies. */
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

  /** Any real weapon; modes with loadouts narrow this. */
  canUseWeapon(_player, weapon) {
    return weaponId(weapon) !== null;
  }

  _entity(value) {
    if (value && typeof value === 'object') return value;
    if (value == null) return null;
    return this._entities.get(String(value)) || null;
  }

  /** Per-player state for policies whose `_players` is a Map keyed by id. */
  _state(value) {
    const entity = this._entity(value);
    return entity ? this._players.get(String(entity.id)) || null : null;
  }

  _emit(kind, fields = {}) {
    this._emitEvent(kind, fields);
  }

  _spawnProtected(entity) {
    return !!entity
      && Number.isFinite(entity.spawnProtectedUntil)
      && entity.spawnProtectedUntil > this.now;
  }
}

/** Two-team targeting shared by Team Deathmatch and Search and Destroy. */
export class TeamPolicy extends BasePolicy {
  teamFor(player) {
    const entity = this._entity(player);
    const id = entity ? String(entity.id) : String(player ?? '');
    const team = this._players.get(id)?.team ?? entity?.team ?? null;
    return TEAM_SET.has(team) ? team : null;
  }

  isEnemy(a, b) {
    const left = this._entity(a);
    const right = this._entity(b);
    if (!left || !right || String(left.id) === String(right.id)) return false;
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

  /** New players join the smaller team; ties go to alpha. */
  _balancedTeam() {
    let alpha = 0;
    let bravo = 0;
    for (const state of this._players.values()) {
      if (state.team === ALPHA) alpha++;
      else if (state.team === BRAVO) bravo++;
    }
    return alpha <= bravo ? ALPHA : BRAVO;
  }
}
