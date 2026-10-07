import { KIT_IDS } from '../../../shared/conquest-contract.js';
import { vehicleDef } from '../../../shared/vehicles.js';
import {
  deployOptions,
  oppositeTeam,
  parseSpawnChoice,
  resolveDeployChoice,
} from '../../../shared/conquest.js';

/** Cells an enemy within this many metres can see are never used for a flag spawn. */
export const FLAG_SPAWN_LOS_RANGE = 40;
/** A squad spawn on a mate seated in a hull lands this far outside the hull's footprint radius at most. */
export const SQUAD_HULL_EXTRA_RADIUS = 3;
const DEFAULT_KIT = KIT_IDS[0];
const BOT_KIT_ROTATION = Object.freeze(['assault', 'engineer', 'support', 'recon']);
const round2 = n => Math.round(n * 100) / 100;

export function normalizeKit(kit) { return KIT_IDS.includes(kit) ? kit : DEFAULT_KIT; }
export function normalizeVariant(variant) { return variant === 1 ? 1 : 0; }

/**
 * Deploy gate and spawn resolution. A dead player respawns once it holds a
 * valid choice and the respawn delay has passed. Humans send deploy intents;
 * bots ask the registered bot director (or a frontline fallback) at
 * `respawnAt`. After `respawnAt + deployTimeoutMs` the server deploys the last
 * valid choice, else HQ.
 */
export class DeploySystem {
  /** `policy` is the owning ConquestPolicy (rules, clock, view, squads, engine). */
  constructor(policy) {
    this.policy = policy;
    this.reset();
  }

  reset() {
    this.states = new Map();
    this.squadSpawnAt = new Map();
  }

  /** Rematch: pending and remembered spawns go, chosen kits stay. */
  clearChoices() {
    for (const state of this.states.values()) {
      state.choice = null;
      state.lastValid = null;
      state.resolved = null;
    }
    this.squadSpawnAt.clear();
  }

  state(playerId) {
    const id = String(playerId);
    let state = this.states.get(id);
    if (!state) {
      state = { choice: null, lastValid: null, kit: DEFAULT_KIT, variant: 0, resolved: null, spawnedAt: null };
      this.states.set(id, state);
    }
    return state;
  }

  kitOf(playerId) { const s = this.states.get(String(playerId)); return s ? { kit: s.kit, variant: s.variant } : { kit: DEFAULT_KIT, variant: 0 }; }

  remove(playerId) { this.states.delete(String(playerId)); this.squadSpawnAt.delete(String(playerId)); }

  rename(priorId, nextId) {
    for (const map of [this.states, this.squadSpawnAt]) {
      if (!map.has(String(priorId))) continue;
      map.set(String(nextId), map.get(String(priorId)));
      map.delete(String(priorId));
    }
  }

  /** A death clears the pending choice; the kit and the last valid choice persist. */
  onDeath(entity) {
    const state = this.state(entity.id);
    state.choice = null;
    state.resolved = null;
  }

  /** Options of the shared rules (identical on client fixtures). */
  options(entity) {
    const policy = this.policy;
    const team = policy.teamFor(entity);
    return deployOptions(policy.deployView(), { id: String(entity.id), team, squad: policy.squads.squadOf(entity.id) }, policy.rules);
  }

  /**
   * Shared validation plus the server-only checks (squad damage lock and
   * cooldown). `{ok, reason, kind, id, seatId}`.
   */
  validate(entity, spawn) {
    const choice = parseSpawnChoice(spawn);
    if (!choice) return { ok: false, reason: 'invalid' };
    const resolved = resolveDeployChoice(this.options(entity), spawn);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    if (choice.kind === 'squad') {
      const mate = this.policy._entity(choice.id);
      const rules = this.policy.rules;
      const now = this.policy.now;
      if (!mate || !this.policy.squads.areSquadmates(entity.id, mate.id)) return { ok: false, reason: 'invalid' };
      if (Number.isFinite(mate.lastDamagedAt) && now - mate.lastDamagedAt < rules.squadSpawnDamageLockMs) return { ok: false, reason: 'busy' };
      const last = this.squadSpawnAt.get(String(mate.id));
      if (Number.isFinite(last) && now - last < rules.squadSpawnCooldownMs) return { ok: false, reason: 'cooldown' };
    }
    return { ok: true, reason: null, kind: choice.kind, id: choice.id ?? null, seatId: resolved.seatId ?? null };
  }

  /** Human (or bot) deploy intent; refused choices emit deploy_refused. */
  intent(entity, intent) {
    const policy = this.policy;
    if (!entity || policy.phase !== 'live' || entity.state !== 'dead' || !policy._state(entity)) return false;
    const state = this.state(entity.id);
    const kit = normalizeKit(intent?.kit);
    const variant = normalizeVariant(intent?.variant);
    const check = this.validate(entity, intent?.spawn);
    if (!check.ok) {
      policy._emit('deploy_refused', { id: String(entity.id), reason: check.reason });
      return false;
    }
    state.kit = kit;
    state.variant = variant;
    state.choice = { spawn: intent.spawn, kit, variant };
    state.lastValid = state.choice;
    return true;
  }

  /**
   * canTimedRespawn: resolve a concrete spawn for this tick, or wait. Bots
   * take the director's choice at respawnAt; humans must have chosen.
   */
  ready(entity) {
    const policy = this.policy;
    const now = policy.now;
    if (!Number.isFinite(entity.respawnAt) || now < entity.respawnAt) return false;
    const state = this.state(entity.id);
    if (state.resolved && state.resolved.at === now) return true;
    state.resolved = null;
    const timedOut = now >= entity.respawnAt + policy.rules.deployTimeoutMs;

    if (!state.choice && entity.bot) {
      const pick = this._botChoice(entity);
      if (pick) {
        state.kit = normalizeKit(pick.kit);
        state.variant = normalizeVariant(pick.variant);
        const check = this.validate(entity, pick.spawn);
        state.choice = { spawn: check.ok ? pick.spawn : 'hq', kit: state.kit, variant: state.variant };
        state.lastValid = state.choice;
      }
    }
    if (state.choice) {
      const resolved = this._resolve(entity, state.choice);
      if (resolved.ok) { state.resolved = resolved; return true; }
      state.choice = null;
      policy._emit('deploy_refused', { id: String(entity.id), reason: resolved.reason });
      if (entity.bot) {
        const fallback = this._frontlineChoice(entity);
        const retry = fallback.spawn !== 'hq' ? this._resolve(entity, { spawn: fallback.spawn, kit: state.kit, variant: state.variant }) : null;
        state.resolved = retry?.ok ? retry : this._resolve(entity, { spawn: 'hq', kit: state.kit, variant: state.variant });
        return state.resolved.ok;
      }
    }
    if (!timedOut) return false;
    const fallback = state.lastValid ? this._resolve(entity, state.lastValid) : null;
    state.resolved = fallback?.ok ? fallback : this._resolve(entity, { spawn: 'hq', kit: state.kit, variant: state.variant });
    return state.resolved.ok;
  }

  /** chooseSpawn: the point resolved this tick, else an HQ cell (round start, forced respawn). */
  spawnPoint(entity, excludeIndex = -1) {
    const state = this.state(entity.id);
    if (state.resolved && state.resolved.at === this.policy.now && state.resolved.point) return { ...state.resolved.point };
    return this._hqPoint(entity, excludeIndex);
  }

  /** onPlayerRespawn: hand back (and clear) what this respawn resolved. */
  consume(entity) {
    const state = this.state(entity.id);
    const resolved = state.resolved && state.resolved.at === this.policy.now ? state.resolved : null;
    state.resolved = null;
    state.choice = null;
    if (resolved) { state.kit = resolved.kit; state.variant = resolved.variant; }
    return resolved;
  }

  /**
   * Round start, rematch and team changes spawn everyone at HQ without a
   * deploy screen. A bot that has not deployed yet still takes the kit its
   * director (or its squad slot) would give it, so the opening push carries
   * the squad kit mix instead of four assaults. `freshOnly` limits this to a
   * life that began within the HQ spawn protection window (used when the
   * director registers after the bots spawned). Returns true when the kit or
   * variant changed.
   */
  seedBotKit(entity, { freshOnly = false } = {}) {
    if (!entity?.bot) return false;
    const state = this.state(entity.id);
    if (state.lastValid) return false;
    if (freshOnly && !(Number.isFinite(state.spawnedAt) && this.policy.now - state.spawnedAt <= this.policy.rules.spawnProtectMs)) return false;
    const pick = this._botChoice(entity);
    if (!pick) return false;
    const kit = normalizeKit(pick.kit);
    const variant = normalizeVariant(pick.variant);
    if (kit === state.kit && variant === state.variant) return false;
    state.kit = kit;
    state.variant = variant;
    return true;
  }

  /**
   * Revived out of band: the pending choice no longer applies and the body
   * keeps the kit it died with, so a kit picked on the deploy screen meanwhile
   * is dropped (`kit`/`variant` are the body's kit when the caller knows it).
   */
  onRevived(entity, kit = null, variant = null) {
    const state = this.state(entity.id);
    state.choice = null;
    state.resolved = null;
    if (KIT_IDS.includes(kit)) {
      state.kit = kit;
      state.variant = normalizeVariant(variant);
    }
  }

  /** After respawnPlayer: seat a vehicle deploy, pay the squad spawn, set protection. */
  finalize(entity, resolved) {
    const policy = this.policy;
    const now = policy.now;
    const kind = resolved?.kind ?? 'hq';
    this.state(entity.id).spawnedAt = now;
    entity.spawnProtectedUntil = kind === 'hq' ? now + policy.rules.spawnProtectMs : 0;
    entity.spawnProtected = kind === 'hq';
    if (kind === 'squad') {
      this.squadSpawnAt.set(String(resolved.id), now);
      policy.award(resolved.id, 'squad_spawn');
    } else if (kind === 'vehicle') {
      const vehicles = policy.vehicleSystem;
      const action = { type: 'enter', vehicleId: resolved.id, ...(resolved.seatId ? { seatId: resolved.seatId } : {}) };
      const seated = typeof vehicles?.action === 'function' ? vehicles.action(entity, action)
        : typeof vehicles?.enter === 'function' ? vehicles.enter(entity, resolved.id, resolved.seatId ?? null) : false;
      if (!seated) {
        // The seat was taken this tick: stand at HQ instead of inside the hull.
        policy._emit('deploy_refused', { id: String(entity.id), reason: 'seat' });
        policy._respawnEntity(entity, this._hqPoint(entity, entity.lastSpawnIndex), { emitEvent: true, protect: true });
        entity.spawnProtectedUntil = now + policy.rules.spawnProtectMs;
        entity.spawnProtected = true;
        return 'hq';
      }
    }
    return kind;
  }

  _botChoice(entity) {
    const director = this.policy.director;
    if (director && typeof director.deployFor === 'function') {
      let pick;
      // A throwing director must never break the authoritative tick: fall back.
      try { pick = director.deployFor(entity); } catch { pick = undefined; }
      if (pick && typeof pick === 'object') return pick;
      if (pick === null) return null;
    }
    return this._frontlineChoice(entity);
  }

  /** Director-less bots: the owned flag closest to the fight, else HQ; kits rotate by squad slot. */
  _frontlineChoice(entity) {
    const policy = this.policy;
    const team = policy.teamFor(entity);
    const squadId = policy.squads.squadOf(entity.id);
    const slot = Math.max(0, policy.squads.membersOf(team, squadId).indexOf(String(entity.id)));
    const kit = BOT_KIT_ROTATION[slot % BOT_KIT_ROTATION.length];
    const state = this.state(entity.id);
    const variant = state.lastValid?.kit === kit ? state.variant : 0;
    const flags = policy.capture.flags;
    const targets = flags.filter(f => f.owner !== team);
    const options = this.options(entity).filter(o => o.kind === 'flag' && o.ok);
    let best = null, bestDistance = Infinity;
    for (const option of options) {
      const flag = flags.find(f => f.id === option.id);
      if (!flag) continue;
      const distance = targets.length ? Math.min(...targets.map(t => Math.hypot(t.x - flag.x, t.z - flag.z))) : 0;
      if (distance < bestDistance) { best = option; bestDistance = distance; }
    }
    return { spawn: best ? best.spawn : 'hq', kit, variant };
  }

  /** Resolve a choice to a concrete point now: `{ok, reason, kind, id, seatId, point, kit, variant, at}`. */
  _resolve(entity, choice) {
    const policy = this.policy;
    const base = { kit: normalizeKit(choice.kit), variant: normalizeVariant(choice.variant), at: policy.now };
    const check = this.validate(entity, choice.spawn);
    if (!check.ok) return { ...base, ok: false, reason: check.reason };
    if (check.kind === 'hq') return { ...base, ok: true, reason: null, kind: 'hq', id: null, seatId: null, point: this._hqPoint(entity, entity.lastSpawnIndex) };
    if (check.kind === 'flag') {
      const flag = policy.capture.flag(check.id);
      const point = this._flagCell(entity, flag);
      return point ? { ...base, ok: true, reason: null, kind: 'flag', id: check.id, seatId: null, point }
        : { ...base, ok: false, reason: this._flagCellsBlocked(flag) ? 'invalid' : 'enemy' };
    }
    if (check.kind === 'squad') {
      const mate = policy._entity(check.id);
      const selector = policy.spawnSelector;
      // A mate seated in a ground hull: probe behind the hull, outside its
      // collider, at its base height (the seat pose floats above the floor).
      const hull = mate.vehicleId ? policy.vehicleFor(mate.vehicleId) : null;
      const collider = hull ? vehicleDef(hull)?.collider : null;
      const reach = collider ? Math.hypot(collider.halfWidth, collider.halfLength) : 0;
      const anchor = collider && [hull.x, hull.y, hull.z].every(Number.isFinite)
        ? { x: hull.x, y: hull.y, z: hull.z, yaw: Number.isFinite(hull.yaw) ? hull.yaw : 0 } : mate;
      const probe = anchor === mate ? { player: entity }
        : { player: entity, minRadius: reach + 0.6, maxRadius: reach + SQUAD_HULL_EXTRA_RADIUS };
      const point = selector ? selector.probeSquadCell(anchor, probe)
        : { x: round2(anchor.x + Math.sin(anchor.yaw || 0) * (reach + 2)), y: anchor.y,
          z: round2(anchor.z + Math.cos(anchor.yaw || 0) * (reach + 2)), index: -1 };
      return point ? { ...base, ok: true, reason: null, kind: 'squad', id: String(mate.id), seatId: null, point }
        : { ...base, ok: false, reason: 'busy' };
    }
    const hull = policy.vehicleFor(check.id);
    if (!hull) return { ...base, ok: false, reason: 'invalid' };
    return { ...base, ok: true, reason: null, kind: 'vehicle', id: String(hull.id), seatId: check.seatId,
      point: { x: hull.x, y: hull.y, z: hull.z, index: -1 } };
  }

  /** True when terrain (craters, debris, fire) leaves no flag spawn cell usable, whoever is around. */
  _flagCellsBlocked(flag) {
    const selector = this.policy.spawnSelector;
    if (!flag || !selector) return false;
    const pool = flag.spawns.length ? flag.spawns : [{ x: flag.x, y: flag.y, z: flag.z }];
    return !pool.some(cell => cell && [cell.x, cell.y, cell.z].every(Number.isFinite)
      && selector.standable(cell) && !selector.hazardous(cell));
  }

  _flagCell(entity, flag) {
    if (!flag) return null;
    const policy = this.policy;
    const team = policy.teamFor(entity);
    const enemyFlags = policy.capture.flags.filter(f => f.owner === oppositeTeam(team));
    const enemyBase = policy.mapMeta?.conquest?.bases?.[oppositeTeam(team)];
    const awayFrom = enemyFlags.length ? enemyFlags
      : Number.isFinite(enemyBase?.x) && Number.isFinite(enemyBase?.z) ? [enemyBase] : [];
    const pool = flag.spawns.length ? flag.spawns : [{ x: flag.x, y: flag.y, z: flag.z }];
    const selector = policy.spawnSelector;
    if (selector) return selector.pickFlagCell(pool, entity, { awayFrom, losRange: FLAG_SPAWN_LOS_RANGE, variety: true });
    return { ...pool[0], index: -1 };
  }

  _hqPoint(entity, excludeIndex = -1) {
    const policy = this.policy;
    return policy._chooseSpawn(policy.hqPool(entity), entity, excludeIndex);
  }
}
