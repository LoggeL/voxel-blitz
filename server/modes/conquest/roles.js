// Conquest infantry roles (server authority): kit loadouts, the down state and
// assault revives, engineer repair through the VehicleSystem repair API, the
// support resupply aura and team spotting. ConquestPolicy owns one instance
// (createConquestRoles) and calls it at the matching points; every value that
// reaches the snapshot comes from here or from the policy, never the client.

import { CONQUEST_RULES, KITS } from '../../../shared/conquest-contract.js';
import {
  KIT_ROLE_RULES,
  applyResupply,
  kitId,
  kitLoadout,
  kitWeapons,
  normalizeGadget,
  normalizeVariant,
} from '../../../shared/conquest-kits.js';
import { PLAYER_HALF, WEAPONS, WEAPON_IDS } from '../../../shared/combatmath.js';
import { nearestHullPoint, vehicleHullParts } from '../../../shared/vehicle-collision.js';
import * as sharedVehicles from '../../../shared/vehicles.js';
import { ConquestSpotting } from './spotting.js';

const DEFAULT_MAX_HP = 100;
const DEFAULT_HULL_REACH = 3;
const MAX_TICK_MS = 250;
/**
 * Deaths that leave no revivable body: the restricted-area timer, falling out
 * of the world (`world` is the void/invalid-state key), and the two lethal
 * volumes (a body in lava or under water would only die again).
 */
// A redeploy (in-game menu RESPAWN) is a deliberate exit: no body to revive.
const NO_DOWN_WEAPONS = new Set(['restricted', 'world', 'void', 'lava', 'water', 'redeploy']);
/** A `vehicle` kill within this reach of a hull that died this tick is wreck blast, not a roadkill. */
const WRECK_BLAST_REACH = 14;
/** A body this close to the hull the victim sat in last tick died seated. */
const SEATED_DEATH_REACH = 8;
/** A body killed in the air settles at most this many voxels down onto the floor below it. */
const BODY_SETTLE_MAX = 48;

const idOf = value => value && typeof value === 'object' ? String(value.id ?? '') : String(value ?? '');
const finite3 = p => !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

function maxHpOf(entity) {
  return Number.isFinite(entity?.maxHp) && entity.maxHp > 0 ? entity.maxHp : DEFAULT_MAX_HP;
}

/** Maximum HP of a hull: the row's own value, the vehicle registry, or the legacy rules. */
export function hullMaxHp(vehicle) {
  if (!vehicle) return 0;
  if (Number.isFinite(vehicle.maxHp) && vehicle.maxHp > 0) return vehicle.maxHp;
  const fromRegistry = sharedVehicles.vehicleMaxHp?.(vehicle);
  if (Number.isFinite(fromRegistry) && fromRegistry > 0) return fromRegistry;
  const legacy = sharedVehicles.VEHICLE_RULES?.[vehicle.type]?.hp;
  return Number.isFinite(legacy) && legacy > 0 ? legacy : 0;
}

/** Distance from an infantry chest to the nearest point of a hull (metres). */
export function distanceToHull(player, vehicle) {
  const chest = [player.x, player.y + 1.0, player.z];
  try {
    const parts = vehicleHullParts(vehicle);
    if (parts.length) {
      let best = Infinity;
      for (const part of parts) {
        const point = nearestHullPoint(part, chest);
        best = Math.min(best, Math.hypot(point[0] - chest[0], point[1] - chest[1], point[2] - chest[2]));
      }
      if (Number.isFinite(best)) return best;
    }
  } catch { /* hull types without collider data use a centre sphere */ }
  return Math.max(0, Math.hypot(vehicle.x - player.x, (vehicle.y + 1) - chest[1], vehicle.z - player.z) - DEFAULT_HULL_REACH);
}

function feetDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Feet y where a body at `pos` comes to rest: the first floor under any corner
 * of the movement collider, so a player shot mid-jump or mid-fall leaves a body
 * a medic can reach and is revived standing. A body over a fluid, the void or
 * a missing world keeps its own height.
 */
export function settleBodyY(pos, solidAt, fluidAt = null) {
  if (typeof solidAt !== 'function' || !finite3(pos)) return pos?.y;
  const half = PLAYER_HALF.x - 0.02;
  const columns = [[-half, -half], [half, -half], [-half, half], [half, half]]
    .map(([dx, dz]) => [Math.floor(pos.x + dx), Math.floor(pos.z + dz)]);
  const feet = Math.floor(pos.y + 1e-6);
  // Already resting on (or stepping over) a block in its own feet cell.
  if (columns.some(([x, z]) => solidAt(x, feet, z))) return pos.y;
  for (let y = feet, i = 0; i <= BODY_SETTLE_MAX && y > 0; y--, i++) {
    if (columns.some(([x, z]) => solidAt(x, y - 1, z))) return Math.min(pos.y, y);
    if (typeof fluidAt === 'function' && columns.some(([x, z]) => fluidAt(x, y - 1, z))) return pos.y;
  }
  return pos.y;
}

function copyInventory(entity) {
  return {
    weapon: Number.isInteger(entity.weapon) ? entity.weapon : 0,
    mag: Array.isArray(entity.mag) ? entity.mag.slice() : null,
    reserve: Array.isArray(entity.reserve) ? entity.reserve.slice() : null,
    grenades: Array.isArray(entity.grenades) ? entity.grenades.slice() : null,
  };
}

export class ConquestRoles {
  constructor({ policy, engine, rules = CONQUEST_RULES } = {}) {
    this.policy = policy ?? null;
    this.engine = engine ?? null;
    this.rules = { ...CONQUEST_RULES, ...(rules || {}) };
    /** playerId -> role state */
    this.states = new Map();
    this.lastTickAt = null;
    this._reviving = null;
    /** entity object -> the id its role state was last keyed by (bot takeovers re-key it). */
    this._ids = new WeakMap();
    this.spotting = new ConquestSpotting({
      policy: this.policy, engine: this.engine, rules: this.rules,
      kitOf: entity => this.kitOf(entity),
      emit: (kind, fields) => this._emit(kind, fields),
    });
  }

  get now() {
    const value = this.engine?.now ?? this.policy?.now;
    return Number.isFinite(value) ? value : 0;
  }

  // --- lookups ---------------------------------------------------------------

  _entity(value) {
    if (value && typeof value === 'object') return value;
    if (value == null) return null;
    return this.engine?.entities?.get?.(String(value)) ?? this.policy?._entities?.get?.(String(value)) ?? null;
  }

  _entities() {
    const source = this.engine?.entities ?? this.policy?._entities;
    return source && typeof source.values === 'function' ? [...source.values()] : [];
  }

  _state(entity, create = true) {
    const id = idOf(entity);
    if (!id) return null;
    if (entity && typeof entity === 'object') {
      // A human taking over a bot keeps the entity (and its life) under a new id.
      const prior = this._ids.get(entity);
      if (prior !== undefined && prior !== id && this.states.has(prior)) {
        // Never take over state that another live entity now holds under the old id.
        const holder = this.engine?.entities?.get?.(prior) ?? this.policy?._entities?.get?.(prior) ?? null;
        if (!holder || holder === entity) this.rename(prior, id);
      }
      this._ids.set(entity, id);
    }
    let state = this.states.get(id);
    if (!state && create) {
      state = {
        kit: null, variant: 0, gadget: 0, down: null, session: null,
        lastDamageRef: entity && typeof entity === 'object' ? entity.lastDamage ?? null : null,
        lastHp: Number.isFinite(entity?.hp) ? entity.hp : null,
        lastDamagedAt: -Infinity, seatedVehicleId: null,
        repairCredit: new Map(), nextResupplyAt: this.now + KIT_ROLE_RULES.resupplyIntervalMs,
        lastRefilledAt: -Infinity, lastGadgetRefillAt: -Infinity, resupplyAwards: new Map(),
      };
      this.states.set(id, state);
    }
    return state ?? null;
  }

  teamOf(entity) {
    if (!entity) return null;
    return this.policy?.teamFor?.(entity) ?? this.policy?.conquestView?.()?.teamOf?.(entity) ?? entity.team ?? null;
  }

  kitOf(entity) { return this._state(entity, false)?.kit ?? null; }
  variantOf(entity) { return this._state(entity, false)?.variant ?? 0; }
  gadgetOf(entity) { return this._state(entity, false)?.gadget ?? 0; }

  /**
   * Re-key everything held for `priorId` (a bot taken over by a human keeps
   * its life, kit, body, support session, marks and award clocks).
   */
  rename(priorId, nextId) {
    const prior = String(priorId ?? ''), next = String(nextId ?? '');
    if (!prior || !next || prior === next) return false;
    const state = this.states.get(prior);
    if (state) {
      this.states.delete(prior);
      this.states.set(next, state);
    }
    for (const other of this.states.values()) {
      if (other.session?.type === 'revive' && other.session.targetId === prior) other.session.targetId = next;
      if (other.resupplyAwards.has(prior)) {
        other.resupplyAwards.set(next, other.resupplyAwards.get(prior));
        other.resupplyAwards.delete(prior);
      }
    }
    if (this._reviving === prior) this._reviving = next;
    this.spotting.rename(prior, next);
    return !!state;
  }

  _live() {
    const phase = this.policy?.phase;
    return phase == null || phase === 'live';
  }

  _emit(kind, fields = {}) {
    if (typeof this.policy?._emit === 'function') { this.policy._emit(kind, fields); return; }
    if (Array.isArray(this.engine?.tickEvents)) this.engine.tickEvents.push({ t: 'ev', kind, at: this.now, ...fields });
  }

  _award(entity, reason, scale = 1) {
    const id = idOf(entity);
    if (id) this.policy?.award?.(id, reason, scale);
  }

  // --- loadout ---------------------------------------------------------------

  /**
   * Issue the kit inventory for a fresh life. During a revive the kit chosen
   * on the deploy screen is ignored: the body keeps the kit it died with.
   */
  applyLoadout(entity, kit, variant, gadget) {
    const p = this._entity(entity);
    const state = this._state(p);
    if (!p || !state) return null;
    let nextKit, nextVariant, nextGadget;
    if (this._reviving === idOf(p) && state.kit) {
      nextKit = state.kit;
      nextVariant = state.variant;
      nextGadget = state.gadget;
    } else {
      nextKit = kitId(kit) ?? state.kit ?? 'assault';
      nextVariant = variant === undefined || variant === null ? (kitId(kit) ? 0 : state.variant) : normalizeVariant(variant);
      // Backward compatible: no gadget choice means the kit default (the AT launcher).
      nextGadget = gadget === undefined || gadget === null ? (kitId(kit) ? 0 : state.gadget) : normalizeGadget(nextKit, gadget);
    }
    const load = kitLoadout(nextKit, nextVariant, nextGadget);
    p.mag = load.mag.slice();
    p.reserve = load.reserve.slice();
    p.grenades = load.grenades.slice();
    p.owned = load.owned.slice();
    // A fresh life always raises the primary.
    p.weapon = load.weapon;
    p.deployT = WEAPONS[load.primary]?.deployTime ?? p.deployT;
    p.reloading = false;
    p.reloadStage = null;
    p.reloadLoose = 0;
    state.kit = load.kit;
    state.variant = load.variant;
    state.gadget = load.gadgetIndex;
    state.nextResupplyAt = this.now + KIT_ROLE_RULES.resupplyIntervalMs;
    return { kit: load.kit, variant: load.variant, gadget: load.gadgetIndex };
  }

  /** Weapon ids this player may hold, or null when no kit applies (non-Conquest fallback). */
  owned(entity) {
    const state = this._state(entity, false);
    return state?.kit ? kitWeapons(state.kit, state.variant, state.gadget).owned : null;
  }

  /** Kit weapon gate for ConquestPolicy.canUseWeapon. Without a kit any real weapon passes. */
  canUseWeapon(entity, weapon, load = null) {
    const id = typeof weapon === 'string' ? weapon : Number.isFinite(weapon) ? WEAPON_IDS[Math.trunc(weapon)] : null;
    if (!id || !WEAPONS[id]) return false;
    const owned = load?.owned ?? this.owned(entity);
    return owned ? owned.includes(id) : true;
  }

  // --- life cycle ------------------------------------------------------------

  /** Death hook: settles spot assists and leaves a revivable body when allowed. */
  onDeath(victim, killer = null, context = null) {
    const p = this._entity(victim);
    const state = this._state(p);
    if (!p || !state) return false;
    this.spotting.onDeath(p, this._entity(killer) ?? killer);
    state.session = null;
    state.down = null;
    if (!this._downAllowed(p, state, context)) return false;
    state.down = {
      x: p.x, y: settleBodyY(p, this.engine?.solidAt, this.engine?.fluidAt), z: p.z,
      yaw: Number.isFinite(p.yaw) ? p.yaw : 0,
      pitch: Number.isFinite(p.pitch) ? p.pitch : 0,
      team: this.teamOf(p),
      at: this.now,
      until: this.now + this.rules.reviveWindowMs,
      kit: state.kit,
      variant: state.variant,
      gadget: state.gadget,
      inventory: copyInventory(p),
    };
    return true;
  }

  _downAllowed(p, state, context) {
    if (!this._live() || !finite3(p)) return false;
    const weapon = typeof context?.weapon === 'string' ? context.weapon : '';
    if (NO_DOWN_WEAPONS.has(weapon)) return false;
    if (context?.vehicleDestroyed === true || context?.cause === 'vehicle_destroyed') return false;
    // A crew member dies with the seat: no body outside the hull to revive.
    if (p.vehicleId || context?.seated === true) return false;
    const vehicles = this.engine?.vehicles?.vehicles;
    if (state.seatedVehicleId) {
      const hull = vehicles?.get?.(state.seatedVehicleId);
      if (!hull || !finite3(hull) || Math.hypot(hull.x - p.x, hull.z - p.z) <= SEATED_DEATH_REACH) return false;
    }
    if ((weapon === 'vehicle' || weapon === 'crash') && vehicles && typeof vehicles.values === 'function') {
      for (const hull of vehicles.values()) {
        if (hull && !(hull.hp > 0) && finite3(hull) && !(hull.wreckAge > 0.5)
            && Math.hypot(hull.x - p.x, hull.y - p.y, hull.z - p.z) <= WRECK_BLAST_REACH) return false;
      }
    }
    return true;
  }

  /**
   * Respawn hook. Any respawn other than a revive forfeits the body; the
   * fresh life starts unspotted, without a support action and with a full
   * resupply timer.
   */
  onRespawn(entity) {
    const p = this._entity(entity);
    const state = this._state(p);
    if (!p || !state) return false;
    if (this._reviving !== idOf(p)) state.down = null;
    state.session = null;
    state.repairCredit.clear();
    state.lastDamageRef = p.lastDamage ?? null;
    state.lastHp = Number.isFinite(p.hp) ? p.hp : null;
    state.lastDamagedAt = -Infinity;
    state.seatedVehicleId = p.vehicleId ?? null;
    state.nextResupplyAt = this.now + KIT_ROLE_RULES.resupplyIntervalMs;
    this.spotting.onRespawn(p);
    return true;
  }

  onRemove(entity) {
    const id = idOf(entity);
    this.states.delete(id);
    this.spotting.forget(id);
    for (const state of this.states.values()) {
      if (state.session?.type === 'revive' && state.session.targetId === id) state.session = null;
      state.resupplyAwards.delete(id);
    }
  }

  reset() {
    for (const state of this.states.values()) {
      state.down = null;
      state.session = null;
      state.repairCredit.clear();
      state.resupplyAwards.clear();
    }
    this.spotting.reset();
    this.lastTickAt = null;
  }

  isDown(entity) {
    const p = this._entity(entity);
    const down = this._state(entity, false)?.down;
    return !!down && down.until > this.now && (!p || p.state !== 'alive');
  }

  /** Revivable bodies, optionally for one team: [{id, team, x, y, z, until}]. */
  downedBodies(team = null) {
    const out = [];
    for (const [id, state] of this.states) {
      const down = state.down;
      if (!down || !(down.until > this.now) || (team && down.team !== team)) continue;
      out.push({ id, team: down.team, x: down.x, y: down.y, z: down.z, until: down.until });
    }
    return out;
  }

  // --- intents ---------------------------------------------------------------

  /**
   * Conquest `spot` and `support` intents. Returns true when accepted. A
   * support intent only (re)starts or refreshes a session; progress happens
   * in `tick` while the newest intent is fresh.
   */
  intent(player, intent) {
    const p = this._entity(player);
    if (!p || !intent || typeof intent !== 'object' || !this._live() || p.state !== 'alive') return false;
    if (intent.type === 'spot' || (intent.spot && !intent.type)) return this.spotting.spot(p) !== null;
    if (intent.type !== 'support' && !intent.support) return false;
    const raw = intent.support;
    const type = typeof raw === 'string' ? raw : raw?.type ?? intent.kind ?? null;
    const targetId = intent.targetId ?? raw?.targetId ?? null;
    if (type !== 'revive' && type !== 'repair') return false;
    const state = this._state(p);
    const target = this._supportTarget(p, type, typeof targetId === 'string' && targetId ? targetId : null);
    if (!target) return false;
    const now = this.now;
    if (state.session?.type === type && state.session.targetId === target) {
      state.session.lastIntentAt = now;
    } else {
      state.session = { type, targetId: target, lastIntentAt: now, progress: 0, interrupted: false, display: 0 };
    }
    return true;
  }

  /** Valid support target id for `p` (the requested one, or the nearest valid one), else null. */
  _supportTarget(p, type, requested) {
    if (type === 'revive') {
      if (requested) return this._reviveRefusal(p, requested) ? null : requested;
      let best = null, bestDistance = Infinity;
      for (const [id, state] of this.states) {
        if (!state.down || this._reviveRefusal(p, id)) continue;
        const distance = feetDistance(p, state.down);
        if (distance < bestDistance) { best = id; bestDistance = distance; }
      }
      return best;
    }
    if (requested) return this._repairRefusal(p, requested) ? null : requested;
    let best = null, bestDistance = Infinity;
    const vehicles = this.engine?.vehicles?.vehicles;
    for (const v of vehicles && typeof vehicles.values === 'function' ? vehicles.values() : []) {
      if (this._repairRefusal(p, String(v.id))) continue;
      const distance = distanceToHull(p, v);
      if (distance < bestDistance) { best = String(v.id); bestDistance = distance; }
    }
    return best;
  }

  /** Why `actor` cannot revive `targetId` right now, or null when it can. */
  _reviveRefusal(actor, targetId) {
    if (!actor || actor.state !== 'alive' || actor.vehicleId) return 'actor';
    if (KITS[this.kitOf(actor)]?.ability !== 'revive') return 'kit';
    if (targetId === idOf(actor)) return 'self';
    const down = this.states.get(targetId)?.down;
    const target = this._entity(targetId);
    if (!down || !(down.until > this.now) || !target || target.state === 'alive') return 'target';
    if (!down.team || down.team !== this.teamOf(actor)) return 'team';
    if (feetDistance(actor, down) > KIT_ROLE_RULES.reviveRange) return 'range';
    return null;
  }

  /** Why `actor` cannot repair hull `vehicleId` right now, or null when it can. */
  _repairRefusal(actor, vehicleId) {
    if (!actor || actor.state !== 'alive' || actor.vehicleId) return 'actor';
    if (KITS[this.kitOf(actor)]?.ability !== 'repair') return 'kit';
    const vehicle = this.engine?.vehicles?.vehicles?.get?.(String(vehicleId));
    if (!vehicle || !(vehicle.hp > 0) || !finite3(vehicle)) return 'target';
    const team = this.teamOf(actor);
    if (!team || vehicle.team !== team) return 'team';
    if (distanceToHull(actor, vehicle) > KIT_ROLE_RULES.repairRange) return 'range';
    return null;
  }

  // --- tick --------------------------------------------------------------------

  /** Per-tick role simulation: bookkeeping, down expiry, revive, repair, resupply, spotting. */
  tick(nowMs = this.now, dtMs = null) {
    const now = Number.isFinite(nowMs) ? nowMs : this.now;
    const elapsed = Number.isFinite(dtMs) ? dtMs
      : this.lastTickAt === null ? 0 : now - this.lastTickAt;
    const dt = Math.max(0, Math.min(MAX_TICK_MS, elapsed));
    this.lastTickAt = now;

    if (!this._live()) {
      for (const state of this.states.values()) { state.down = null; state.session = null; }
      this.spotting.tick();
      return;
    }

    const entities = this._entities();
    const present = new Set();
    for (const p of entities) {
      const id = idOf(p);
      if (!id) continue;
      present.add(id);
      const state = this._state(p);
      this._trackDamage(p, state, now);
      if (p.state === 'alive') {
        state.seatedVehicleId = p.vehicleId ?? null;
        if (state.down) state.down = null; // respawned through a path that skipped onRespawn
      } else if (state.down && !(state.down.until > now)) {
        state.down = null;
      }
    }
    for (const id of [...this.states.keys()]) if (!present.has(id)) this.onRemove(id);

    for (const p of entities) {
      const state = this.states.get(idOf(p));
      if (!state?.session) continue;
      if (state.session.type === 'revive') this._advanceRevive(p, state, now, dt);
      else this._advanceRepair(p, state, now, dt);
    }
    this._resupply(entities, now);
    this.spotting.tick();
  }

  _trackDamage(p, state, now) {
    const ref = p.lastDamage ?? null;
    const hp = Number.isFinite(p.hp) ? p.hp : null;
    const hit = (ref && ref !== state.lastDamageRef) || (hp !== null && state.lastHp !== null && hp < state.lastHp);
    if (hit && p.state === 'alive') state.lastDamagedAt = now;
    state.lastDamageRef = ref;
    state.lastHp = hp;
  }

  /** True while the session's newest intent is fresh; drops it after a long silence. */
  _sessionFresh(state, now) {
    const age = now - state.session.lastIntentAt;
    if (age <= this.rules.supportIntentStaleMs) return true;
    if (age > KIT_ROLE_RULES.supportSessionDropMs) state.session = null;
    return false;
  }

  _advanceRevive(actor, state, now, dt) {
    const session = state.session;
    if (this._reviveRefusal(actor, session.targetId)) { state.session = null; return; }
    if (!this._sessionFresh(state, now)) return;
    session.progress += dt;
    session.display = Math.min(1, session.progress / this.rules.reviveHoldMs);
    if (session.progress >= this.rules.reviveHoldMs) this._completeRevive(actor, session.targetId);
  }

  _completeRevive(reviver, targetId) {
    const target = this._entity(targetId);
    const state = this.states.get(targetId);
    const down = state?.down;
    if (!target || !down) return false;
    const reviverState = this.states.get(idOf(reviver));
    if (reviverState) reviverState.session = null;
    // Terrain may have been blown away under the body since the death.
    down.y = settleBodyY(down, this.engine?.solidAt, this.engine?.fluidAt);
    const spawn = { x: down.x, y: down.y, z: down.z, index: target.lastSpawnIndex | 0 };
    this._reviving = targetId;
    try {
      if (typeof this.engine?.respawnPlayer === 'function') {
        this.engine.respawnPlayer(target, spawn, { emitEvent: true, protect: false });
      } else {
        this.policy?._respawnEntity?.(target, spawn, { emitEvent: true, protect: false });
      }
      // The policy resets its death bookkeeping; onRevive must not apply a deploy choice.
      const hook = this.policy?.onRevive ?? this.policy?.onRevived;
      if (typeof hook === 'function') hook.call(this.policy, target, reviver);
      else this.policy?.onPlayerRespawn?.(target);
    } finally {
      this._reviving = null;
    }
    // Keep the kit and the inventory the body carried.
    state.kit = down.kit ?? state.kit;
    state.variant = down.variant ?? state.variant;
    state.gadget = down.gadget ?? state.gadget;
    const load = kitLoadout(state.kit ?? 'assault', state.variant, state.gadget);
    target.owned = load.owned.slice();
    const inv = down.inventory;
    if (inv?.mag?.length === WEAPON_IDS.length) target.mag = inv.mag.slice();
    if (inv?.reserve?.length === WEAPON_IDS.length) target.reserve = inv.reserve.slice();
    if (Array.isArray(inv?.grenades)) target.grenades = inv.grenades.slice();
    if (Number.isInteger(inv?.weapon) && this.canUseWeapon(target, inv.weapon)) target.weapon = inv.weapon;
    target.x = down.x; target.y = down.y; target.z = down.z;
    target.yaw = down.yaw; target.pitch = down.pitch;
    target.state = 'alive';
    target.hp = Math.max(1, Math.round(this.rules.reviveHpFraction * maxHpOf(target)));
    target.spawnProtectedUntil = 0;
    target.spawnProtected = false;
    state.down = null;
    state.session = null;
    state.lastHp = target.hp;
    state.lastDamageRef = target.lastDamage ?? null;
    const team = down.team ?? this.teamOf(target);
    if (team) this.policy?.refundTicket?.(team);
    this._emit('revive', { id: targetId, by: idOf(reviver) });
    this._award(reviver, 'revive');
    return true;
  }

  _advanceRepair(actor, state, now, dt) {
    const session = state.session;
    if (this._repairRefusal(actor, session.targetId)) { state.session = null; return; }
    const vehicle = this.engine.vehicles.vehicles.get(String(session.targetId));
    const maxHp = hullMaxHp(vehicle);
    session.display = maxHp > 0 ? Math.max(0, Math.min(1, vehicle.hp / maxHp)) : 0;
    if (!this._sessionFresh(state, now)) return;
    session.interrupted = now - state.lastDamagedAt < KIT_ROLE_RULES.repairInterruptMs;
    if (session.interrupted || !(maxHp > 0) || vehicle.hp >= maxHp || !(dt > 0)) return;
    const repair = this.engine?.vehicles?.repair;
    if (typeof repair !== 'function') return;
    const before = vehicle.hp;
    const amount = this.rules.repairPerSecFraction * maxHp * dt / 1000;
    const result = repair.call(this.engine.vehicles, vehicle.id, amount, actor);
    const added = Number.isFinite(result) ? Math.max(0, result) : Math.max(0, (vehicle.hp ?? before) - before);
    session.display = Math.max(0, Math.min(1, vehicle.hp / maxHp));
    if (!(added > 0)) return;
    const key = String(vehicle.id);
    let credit = (state.repairCredit.get(key) ?? 0) + added;
    const step = KIT_ROLE_RULES.repairAwardFraction * maxHp;
    while (step > 0 && credit >= step - 1e-6) {
      credit -= step;
      this._award(actor, 'repair');
    }
    state.repairCredit.set(key, Math.max(0, credit));
  }

  /** Support aura pulses: every supporter refills teammates in reach on its own clock. */
  _resupply(entities, now) {
    const radius = KIT_ROLE_RULES.resupplyRadius;
    const interval = KIT_ROLE_RULES.resupplyIntervalMs;
    for (const supporter of entities) {
      const state = this.states.get(idOf(supporter));
      if (!state || KITS[state.kit]?.ability !== 'resupply') continue;
      if (supporter.state !== 'alive' || supporter.vehicleId) continue;
      if (now < state.nextResupplyAt) continue;
      state.nextResupplyAt = now + interval;
      const team = this.teamOf(supporter);
      if (!team) continue;
      for (const mate of entities) {
        if (!mate || mate.state !== 'alive' || mate.vehicleId) continue;
        const mateState = this.states.get(idOf(mate));
        if (!mateState?.kit || this.teamOf(mate) !== team) continue;
        if (feetDistance(supporter, mate) > radius) continue;
        if (now - mateState.lastRefilledAt < interval) continue;
        const gadgetRound = now - mateState.lastGadgetRefillAt >= KIT_ROLE_RULES.gadgetResupplyMs;
        const given = applyResupply(mate, mateState.kit, mateState.variant, mateState.gadget, { gadgetRound });
        if (given.gadget) mateState.lastGadgetRefillAt = now;
        if (!given.reserve && !given.grenade && !given.gadget) continue;
        mateState.lastRefilledAt = now;
        if (mate === supporter || idOf(mate) === idOf(supporter)) continue;
        const last = state.resupplyAwards.get(idOf(mate)) ?? -Infinity;
        if (now - last < KIT_ROLE_RULES.resupplyAwardCooldownMs) continue;
        state.resupplyAwards.set(idOf(mate), now);
        this._award(supporter, 'resupply');
      }
    }
  }

  // --- vehicle and snapshot hooks -----------------------------------------------

  /** Forwarded from ModeController.onVehicleEvent: spot assists on destroyed hulls. */
  onVehicleEvent(kind, payload = {}) {
    if (kind !== 'vehicle_destroyed') return false;
    return this.spotting.onVehicleDestroyed(payload.vehicleId, payload.attacker);
  }

  /** Session progress for `cq[6]` as a 0..1 fraction (revive hold, or hull HP while repairing). */
  actionProgress(entity) {
    const session = this._state(entity, false)?.session;
    return session ? session.display ?? 0 : 0;
  }

  /**
   * Partial `p.conquest` for the snapshot: `kit` (KIT_IDS id or null), `squad`
   * (1-based id, 0 none), `down` and `spotted` (booleans), `restrictedMs` (ms
   * left on the policy's bounds timer) and `actionProgress` (0..1).
   */
  snapshotFields(entity) {
    const p = this._entity(entity);
    const id = idOf(entity);
    // The policy's squad table (SquadSystem.squadOf), else the per-tick conquestView map.
    const squad = this.policy?.squads?.squadOf?.(id) ?? this.policy?.squadOf?.(p)
      ?? this.policy?.conquestView?.()?.squads?.get?.(id)?.squadId ?? 0;
    // ConquestPolicy.restrictedMs(entity), else its BoundsSystem (restrictedMs(playerId, now)).
    const restricted = this.policy?.restrictedMs?.(p) ?? this.policy?.bounds?.restrictedMs?.(id, this.now)
      ?? p?.conquest?.restrictedMs ?? 0;
    const kit = this.kitOf(p);
    return {
      // Omitted (not null) before the first loadout so the policy's deploy kit stays.
      kit: kit ?? undefined,
      squad: Number.isFinite(squad) ? squad : 0,
      down: this.isDown(p),
      spotted: !!p && p.state === 'alive' && this.spotting.isSpotted(p),
      restrictedMs: Number.isFinite(restricted) ? Math.max(0, restricted) : 0,
      actionProgress: this.actionProgress(p),
    };
  }
}

/** Factory called by ConquestPolicy (spec §3.5). */
export function createConquestRoles({ policy, engine, rules } = {}) {
  return new ConquestRoles({ policy, engine, rules });
}
