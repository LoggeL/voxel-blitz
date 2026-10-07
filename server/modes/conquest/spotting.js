// Conquest team spotting. Server-authoritative marks on enemy infantry and
// hulls: a manual spot cone along the spotter's view (range and duration by
// kit, voxel line of sight, blocked by smoke), automatic marks on anyone who
// fires an unsuppressed weapon, a per-player cooldown and the spot-assist
// award when a teammate of the spotter kills a marked enemy.

import { CONQUEST_RULES } from '../../../shared/conquest-contract.js';
import { KIT_ROLE_RULES, isUnsuppressedWeapon } from '../../../shared/conquest-kits.js';
import { raycastVoxels } from '../../../shared/raycast.js';
import { vehicleHullParts } from '../../../shared/vehicle-collision.js';
import { VEHICLE_RULES } from '../../../shared/vehicles.js';

const DEFAULT_EYE = 1.6;
const DEFAULT_HULL_RADIUS = 3;
/** Rays end this short of the sample point so the target's own cell never occludes it. */
const LOS_MARGIN = 0.35;
/** A shot-counter change only counts as fire when the counter was read this recently (consecutive ticks). */
const SHOT_SEQ_CONTINUITY_MS = 250;

/** View direction from aim angles; yaw 0 faces -Z, pitch > 0 looks up (matches server/sim/player.js). */
function viewDirection(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

const idOf = value => value && typeof value === 'object' ? String(value.id ?? '') : String(value ?? '');

function eyeOf(p) {
  const y = Number.isFinite(p.eyeY) ? p.eyeY : p.y + DEFAULT_EYE;
  const x = Number.isFinite(p.eyeX) ? p.eyeX : p.x;
  const z = Number.isFinite(p.eyeZ) ? p.eyeZ : p.z;
  return [x, y, z];
}

/** Sample points that count as "seeing" a hull plus its angular radius. */
export function hullSightGeometry(vehicle) {
  try {
    const parts = vehicleHullParts(vehicle);
    if (parts.length) {
      const center = [0, 0, 0];
      let top = -Infinity;
      for (const part of parts) {
        for (let i = 0; i < 3; i++) center[i] += part.center[i] / parts.length;
        top = Math.max(top, part.maxY);
      }
      let radius = 0;
      for (const part of parts) for (const corner of part.corners) {
        radius = Math.max(radius, Math.hypot(corner[0] - center[0], corner[1] - center[1], corner[2] - center[2]));
      }
      if (center.every(Number.isFinite) && Number.isFinite(top) && radius > 0) {
        return { center, points: [center, [center[0], top - 0.25, center[2]]], radius };
      }
    }
  } catch { /* hull types without collider data fall back to a sphere */ }
  const height = VEHICLE_RULES[vehicle.type]?.height ?? 2;
  const center = [vehicle.x, vehicle.y + height * 0.5, vehicle.z];
  return { center, points: [center, [vehicle.x, vehicle.y + height * 0.9, vehicle.z]], radius: DEFAULT_HULL_RADIUS };
}

export class ConquestSpotting {
  /**
   * @param {{policy:object, engine:object, rules?:object, kitOf?:(p)=>string|null, emit?:(kind, fields)=>void}} options
   */
  constructor({ policy, engine, rules = CONQUEST_RULES, kitOf = () => null, emit = null } = {}) {
    this.policy = policy;
    this.engine = engine;
    this.rules = { ...CONQUEST_RULES, ...rules };
    this.kitOf = kitOf;
    this._emit = typeof emit === 'function' ? emit : null;
    /** playerId -> {until, by, team} */
    this.players = new Map();
    /** vehicleId -> {until, by, team} (mirrors engine.vehicles.spot for assists and fallbacks) */
    this.vehicles = new Map();
    /** playerId -> {lastAttempt, lastSpot, shotSeq, seqAt} */
    this.actors = new Map();
  }

  get now() {
    const value = this.engine?.now ?? this.policy?.now;
    return Number.isFinite(value) ? value : 0;
  }

  teamOf(entity) {
    if (!entity) return null;
    return this.policy?.teamFor?.(entity) ?? entity.team ?? null;
  }

  _entities() {
    const source = this.engine?.entities ?? this.policy?._entities;
    return source && typeof source.values === 'function' ? source.values() : [];
  }

  _vehicles() {
    const map = this.engine?.vehicles?.vehicles;
    return map && typeof map.values === 'function' ? map.values() : [];
  }

  _actor(id) {
    let actor = this.actors.get(id);
    if (!actor) {
      actor = { lastAttempt: -Infinity, lastSpot: -Infinity, shotSeq: null, seqAt: -Infinity };
      this.actors.set(id, actor);
    }
    return actor;
  }

  rangeFor(player) {
    return this.kitOf(player) === 'recon' ? this.rules.spotRangeRecon : this.rules.spotRange;
  }

  durationFor(player) {
    return this.kitOf(player) === 'recon' ? this.rules.spotMsRecon : this.rules.spotMs;
  }

  /** Whether the line from `from` to `to` is clear of voxels and smoke. */
  lineOfSight(from, to) {
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
    const distance = Math.hypot(dx, dy, dz);
    if (!(distance > 0)) return true;
    const smoke = this.engine?.projectiles?.smoke;
    if (smoke?.blocksSight?.(from, to, this.now)) return false;
    const solidAt = this.engine?.solidAt;
    if (typeof solidAt !== 'function') return true;
    const reach = distance - LOS_MARGIN;
    return !(reach > 0 && raycastVoxels(solidAt, from[0], from[1], from[2], dx, dy, dz, reach));
  }

  /**
   * Candidates inside the cone and range, best first. Each is
   * `{kind:'player'|'vehicle', target, id, distance, score, points}`.
   * Line of sight is not checked here; `bestTarget` checks it in score order.
   */
  candidates(spotter) {
    const team = this.teamOf(spotter);
    if (!team) return [];
    const eye = eyeOf(spotter);
    const view = viewDirection(Number(spotter.yaw) || 0, Number(spotter.pitch) || 0);
    const range = this.rangeFor(spotter);
    const cone = this.rules.spotConeRad;
    const out = [];
    const consider = (kind, target, id, points, radius) => {
      const aim = points[0];
      const dx = aim[0] - eye[0], dy = aim[1] - eye[1], dz = aim[2] - eye[2];
      const distance = Math.hypot(dx, dy, dz);
      if (!(distance > 0.01) || distance > range + radius) return;
      const cos = (dx * view.x + dy * view.y + dz * view.z) / distance;
      const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
      // The cone widens by the target's own angular radius, so a hull filling
      // the screen at close range is still spotted off-centre.
      const effective = Math.max(0, angle - Math.atan2(radius, distance));
      if (effective > cone) return;
      out.push({ kind, target, id, distance, points,
        score: effective / cone + 0.25 * (distance / range) });
    };

    for (const p of this._entities()) {
      if (!p || p === spotter || p.state !== 'alive' || p.vehicleId) continue;
      if (idOf(p) === idOf(spotter)) continue;
      const otherTeam = this.teamOf(p);
      if (!otherTeam || otherTeam === team) continue;
      const head = eyeOf(p);
      const chest = [p.x, p.y + 1.15, p.z];
      consider('player', p, idOf(p), [chest, head], KIT_ROLE_RULES.spotPlayerRadius);
    }
    for (const v of this._vehicles()) {
      if (!v || !(v.hp > 0) || ![v.x, v.y, v.z].every(Number.isFinite)) continue;
      if (!this._hostileHull(v, team)) continue;
      const geometry = hullSightGeometry(v);
      consider('vehicle', v, String(v.id), geometry.points, geometry.radius);
    }
    out.sort((a, b) => a.score - b.score || a.distance - b.distance);
    return out;
  }

  /** A hull is hostile when it belongs to the other team or carries an enemy crew. */
  _hostileHull(v, team) {
    if (v.team && v.team !== team) return true;
    if (v.team === team) return false;
    const seats = v.seatOccupants && typeof v.seatOccupants === 'object' ? Object.values(v.seatOccupants) : [v.occupantId];
    for (const id of seats) {
      if (id == null) continue;
      const crew = this.engine?.entities?.get?.(String(id));
      const crewTeam = crew && this.teamOf(crew);
      if (crewTeam && crewTeam !== team) return true;
    }
    return false;
  }

  /** Best visible candidate, or null. */
  bestTarget(spotter) {
    const eye = eyeOf(spotter);
    for (const candidate of this.candidates(spotter)) {
      if (candidate.points.some(point => this.lineOfSight(eye, point))) return candidate;
    }
    return null;
  }

  /**
   * Manual spot intent. Returns the marked id, or null when refused (dead,
   * cooldown, nothing in the cone, or everything hidden).
   */
  spot(spotter) {
    if (!spotter || spotter.state !== 'alive') return null;
    const id = idOf(spotter);
    const now = this.now;
    const actor = this._actor(id);
    if (now - actor.lastAttempt < KIT_ROLE_RULES.spotAttemptMinMs) return null;
    if (now - actor.lastSpot < this.rules.spotCooldownMs) return null;
    actor.lastAttempt = now;
    const team = this.teamOf(spotter);
    const best = team ? this.bestTarget(spotter) : null;
    if (!best) return null;
    actor.lastSpot = now;
    const until = now + this.durationFor(spotter);
    if (best.kind === 'player') this.markPlayer(best.target, { by: id, team, until });
    else this.markVehicle(best.target, { by: id, team, until });
    this._emitEvent('spot', { by: id, ids: [best.id] });
    return best.id;
  }

  /** Mark an infantry target. A longer existing mark is kept; a spotter's mark replaces an anonymous one. */
  markPlayer(target, { by = null, team = null, until }) {
    const id = idOf(target);
    if (!id || !Number.isFinite(until)) return false;
    const prior = this.players.get(id);
    if (prior && prior.until > this.now && prior.until >= until && (prior.by || !by)) return false;
    this.players.set(id, { until: Math.max(until, prior?.until ?? 0), by: by ?? prior?.by ?? null, team: team ?? prior?.team ?? null });
    return true;
  }

  /** Mark a hull for the spotting team (published as `vehicles[].sp` by VehicleSystem). */
  markVehicle(vehicle, { by = null, team = null, until }) {
    const id = String(vehicle?.id ?? '');
    if (!id || !Number.isFinite(until)) return false;
    const prior = this.vehicles.get(id);
    const next = { until: Math.max(until, prior?.until ?? 0), by: by ?? prior?.by ?? null, team: team ?? prior?.team ?? null };
    this.vehicles.set(id, next);
    this.engine?.vehicles?.spot?.(id, next.team, next.until);
    return true;
  }

  isSpotted(entity) {
    const mark = this.players.get(idOf(entity));
    return !!mark && mark.until > this.now;
  }

  isVehicleSpotted(vehicleId) {
    const mark = this.vehicles.get(String(vehicleId ?? ''));
    return !!mark && mark.until > this.now;
  }

  spotterOf(entity) {
    const mark = this.players.get(idOf(entity));
    return mark && mark.until > this.now ? mark.by : null;
  }

  /** Auto-spot: firing an unsuppressed weapon reveals the shooter (or the hull it fires from). */
  autoSpotShooter(shooter, { weapon = null, vehicleId = null } = {}) {
    if (!shooter || shooter.state !== 'alive') return false;
    if (!vehicleId && !isUnsuppressedWeapon(weapon ?? shooter.weapon)) return false;
    const team = this.teamOf(shooter);
    const seeing = this._enemyTeamOf(team);
    const until = this.now + this.rules.autoSpotOnFireMs;
    const hullId = vehicleId ?? shooter.vehicleId ?? null;
    if (hullId) {
      const vehicle = this.engine?.vehicles?.vehicles?.get?.(String(hullId));
      if (vehicle && vehicle.hp > 0) return this.markVehicle(vehicle, { team: seeing, until });
      return false;
    }
    return this.markPlayer(shooter, { team: seeing, until });
  }

  _enemyTeamOf(team) {
    if (team === 'alpha') return 'bravo';
    if (team === 'bravo') return 'alpha';
    return null;
  }

  /** Per-tick upkeep: auto-spot this tick's shooters and drop expired marks. */
  tick() {
    const now = this.now;
    const fired = new Map();
    for (const ev of Array.isArray(this.engine?.tickEvents) ? this.engine.tickEvents : []) {
      if (ev?.kind !== 'shoot' || ev.id == null) continue;
      const id = String(ev.id);
      if (ev.vehicleId) fired.set(id, { vehicleId: String(ev.vehicleId), weapon: null });
      else if (!fired.has(id)) fired.set(id, { vehicleId: null, weapon: ev.w ?? null });
    }
    for (const p of this._entities()) {
      if (!p) continue;
      const id = idOf(p);
      const actor = this.actors.get(id);
      const seq = Number.isFinite(p.shotSeq) ? p.shotSeq : null;
      if (actor) {
        // Only a counter read on the previous tick proves a shot this tick; a
        // gap (rounds outside the live phase) just re-baselines it.
        if (seq !== null && actor.shotSeq !== null && seq !== actor.shotSeq && !fired.has(id) && !p.vehicleId
            && p.state === 'alive' && now - actor.seqAt <= SHOT_SEQ_CONTINUITY_MS) {
          fired.set(id, { vehicleId: null, weapon: p.weapon });
        }
        actor.shotSeq = seq;
        actor.seqAt = now;
      } else if (seq !== null) {
        const fresh = this._actor(id);
        fresh.shotSeq = seq;
        fresh.seqAt = now;
      }
    }
    for (const [id, shot] of fired) {
      const shooter = this.engine?.entities?.get?.(id);
      if (shooter) this.autoSpotShooter(shooter, shot);
    }
    for (const [id, mark] of this.players) if (!(mark.until > now)) this.players.delete(id);
    for (const [id, mark] of this.vehicles) if (!(mark.until > now)) this.vehicles.delete(id);
    for (const id of this.actors.keys()) if (!this.engine?.entities?.get?.(id)) this.actors.delete(id);
  }

  /**
   * Death hook: a marked enemy killed by a teammate of its spotter awards the
   * spotter one spot assist. The mark ends with the life either way.
   */
  onDeath(victim, killer) {
    const victimId = idOf(victim);
    const mark = this.players.get(victimId);
    this.players.delete(victimId);
    return this._assist(mark, killer);
  }

  /** Hull destruction hook (from `onVehicleEvent('vehicle_destroyed', …)`). */
  onVehicleDestroyed(vehicleId, attacker) {
    const id = String(vehicleId ?? '');
    const mark = this.vehicles.get(id);
    this.vehicles.delete(id);
    return this._assist(mark, attacker);
  }

  _assist(mark, killer) {
    if (!mark || !(mark.until > this.now) || !mark.by || killer == null) return false;
    const killerEntity = typeof killer === 'object' ? killer : this.engine?.entities?.get?.(String(killer));
    const killerId = idOf(killer);
    if (!killerId || killerId === mark.by) return false;
    const spotter = this.engine?.entities?.get?.(mark.by);
    const spotterTeam = spotter ? this.teamOf(spotter) : mark.team;
    const killerTeam = killerEntity ? this.teamOf(killerEntity) : null;
    if (!spotterTeam || killerTeam !== spotterTeam) return false;
    this.policy?.award?.(mark.by, 'spot_assist');
    return true;
  }

  /** A fresh life starts unmarked. */
  onRespawn(entity) {
    this.players.delete(idOf(entity));
  }

  /** Bot takeover: marks on, marks by and the actor clocks of `priorId` move to `nextId`. */
  rename(priorId, nextId) {
    const prior = String(priorId ?? ''), next = String(nextId ?? '');
    if (!prior || !next || prior === next) return;
    for (const map of [this.players, this.actors]) {
      if (!map.has(prior)) continue;
      map.set(next, map.get(prior));
      map.delete(prior);
    }
    for (const map of [this.players, this.vehicles]) {
      for (const mark of map.values()) if (mark.by === prior) mark.by = next;
    }
  }

  forget(entity) {
    const id = idOf(entity);
    this.players.delete(id);
    this.actors.delete(id);
  }

  reset() {
    this.players.clear();
    this.vehicles.clear();
    this.actors.clear();
  }

  _emitEvent(kind, fields) {
    if (this._emit) { this._emit(kind, fields); return; }
    if (Array.isArray(this.engine?.tickEvents)) this.engine.tickEvents.push({ t: 'ev', kind, at: this.now, ...fields });
  }
}
