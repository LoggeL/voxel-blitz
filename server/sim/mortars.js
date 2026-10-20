/**
 * Support mortars (Conquest, shared/mortar-rules.js). A Support who chose the
 * MORTAR gadget sends the `mortar` intent: the mortar hull goes on the ground
 * ahead of him and he takes its exposed operator seat at once. From there the
 * tube is an ordinary VehicleMounts mount (his input yaw is the azimuth, his
 * input pitch the elevation) and every round a server projectile. The hull is
 * owned: one per player (a new one replaces the old), never respawned at a pad
 * (respawnSeconds Infinity), never hijacked, crushed by any hull that rolls
 * over it, lost when the ground under it goes, and its operator survives its
 * destruction (VEHICLE_DEFS.mortar.crewSurvives). The wreck is removed after
 * MORTAR_RULES.wreckSeconds.
 */
import { MORTAR_RULES, mortarPlacementPoint } from '../../shared/mortar-rules.js';
import { vehicleDef } from '../../shared/vehicle-defs.js';
import { vehicleHullParts, hullBoxesOverlap, blocksHulls, solidHull } from '../../shared/vehicle-collision.js';
import { playerHullContact } from '../../shared/player-vehicle-collision.js';
import { isAircraft } from '../../shared/vehicles.js';
import { raycastVoxels } from '../../shared/raycast.js';
import { evMortar } from '../protocol/events.js';

const TYPE = MORTAR_RULES.type;
const isMortar = v => v?.type === TYPE;

export class MortarSystem {
  constructor(vehicles) {
    this.vehicles = vehicles;
    this.owned = new Map();      // playerId -> vehicleId
    this.readyAt = new Map();    // playerId -> sim ms before which a new mortar is refused
    this.serial = 0;
  }
  get engine() { return this.vehicles.engine; }
  reset() { this.owned.clear(); this.readyAt.clear(); }
  now() { return this.vehicles.nowMs(); }

  /** The live mortar a player owns, or null. */
  mortarOf(playerId) {
    const v = this.vehicles.vehicles.get(this.owned.get(String(playerId)));
    return v && isMortar(v) && v.hp > 0 && v.ownerId === String(playerId) ? v : null;
  }

  /** Every live mortar (tests, bots). */
  live() { return [...this.vehicles.vehicles.values()].filter(v => isMortar(v) && v.hp > 0); }

  _refuse(p, reason, waitMs = null) {
    this.engine.tickEvents?.push(evMortar(p.id, 'refused', { reason, waitMs }));
    return { ok: false, reason, ...(Number.isFinite(waitMs) ? { waitMs } : {}) };
  }

  /**
   * Place a mortar for `p` and seat him at it. The caller (the Conquest
   * policy) has checked the kit; this checks the body, the cooldown and the
   * ground. Returns { ok, vehicleId } or { ok:false, reason }.
   */
  deploy(p) {
    const vehicles = this.vehicles, now = this.now(), id = String(p?.id ?? '');
    if (!p || p.state !== 'alive' || p.vehicleId || p.chute || !p.grounded || !vehicles.canOperate(p)) return this._refuse(p ?? { id }, 'state');
    const wait = (this.readyAt.get(id) ?? -Infinity) - now;
    if (wait > 0) return this._refuse(p, 'cooldown', wait);
    const spot = mortarPlacementPoint(p);
    const y = vehicles.ground(spot.x, spot.z, p.y, MORTAR_RULES.placeRise, MORTAR_RULES.placeDrop);
    if (y == null) return this._refuse(p, 'ground');
    // No wall between the feet and the spot, the hull clear of voxels, hulls and bodies.
    const from = [p.x, p.y + 0.6, p.z], to = [spot.x, y + 0.6, spot.z], delta = to.map((n, i) => n - from[i]), length = Math.hypot(...delta);
    if (length > 1e-3 && raycastVoxels((x, yy, z) => vehicles.solid(x, yy, z), ...from, ...delta.map(n => n / length), length)) return this._refuse(p, 'blocked');
    const hull = this._hull(`${TYPE}-${id}-${++this.serial}`, p, spot.x, y, spot.z, spot.yaw);
    if (!vehicles.clearHull(hull, hull.x, hull.y, hull.z, hull.yaw)) return this._refuse(p, 'blocked');
    for (const other of vehicles.vehicles.values()) {
      if (!solidHull(other)) continue;
      if (vehicleHullParts(other).some(part => vehicleHullParts(hull).some(box => hullBoxesOverlap(part, box)))) return this._refuse(p, 'blocked');
    }
    for (const body of this.engine.entities.values()) {
      if (body !== p && body.state === 'alive' && !body.vehicleId && playerHullContact(body, hull)) return this._refuse(p, 'blocked');
    }
    // One per player: the old mortar goes quietly (its operator steps off).
    const old = this.mortarOf(id);
    if (old) this.remove(old);
    vehicles.vehicles.set(hull.id, hull);
    this.owned.set(id, hull.id);
    this.readyAt.set(id, now + MORTAR_RULES.replaceCooldownMs);
    if (!vehicles.enter(p, hull.id, MORTAR_RULES.seat)) { this.remove(hull); return this._refuse(p, 'blocked'); }
    this.engine.tickEvents?.push(evMortar(id, 'placed', { vehicleId: hull.id }));
    return { ok: true, vehicleId: hull.id };
  }

  /** A fresh mortar hull (the same fields VehicleSystem.reset gives a pad hull). */
  _hull(vehicleId, owner, x, y, z, yaw) {
    const vehicles = this.vehicles, def = vehicleDef(TYPE), team = vehicles.teamOf(owner) ?? null;
    const v = { id: vehicleId, type: TYPE, team, x, y, z, yaw, pitch: 0, roll: 0,
      turretYaw: yaw, turretPitch: 0, speed: 0, yawRate: 0, visualSteer: 0, leftTrackSpeed: 0, rightTrackSpeed: 0, vx: 0, vy: 0, vz: 0,
      hp: def.hp, occupantId: null, seatOccupants: vehicles.emptySeats(TYPE), respawnIn: 0, engineOn: false, wreckAge: 0,
      // A null pad team: never respawned, never sent home (padTeam).
      spawn: { x, y, z, yaw, team: null }, ownerId: String(owner.id), supportRevision: null };
    vehicles.freshCondition(v);
    vehicles.mounts.reset(v);
    const tube = vehicles.mounts.state(v, MORTAR_RULES.mount);
    if (tube) { tube.yaw = yaw; tube.pitch = MORTAR_RULES.restPitch; }
    return v;
  }

  /** Take a mortar off the field without a blast or an event (replaced, owner gone). */
  remove(v) {
    for (const p of this.vehicles.crew(v)) this.vehicles.exit(p);
    this.vehicles.vehicles.delete(v.id);
    if (this.owned.get(v.ownerId) === v.id) this.owned.delete(v.ownerId);
  }

  /** One substep of a live mortar: owner still in the match, ground still there, no hull rolling over it. */
  advance(v) {
    const vehicles = this.vehicles;
    v.engineOn = false; v.speed = 0;
    if (!this.engine.entities.has(v.ownerId)) { this.remove(v); return; }
    const revision = this.engine.blockRevision ?? 0;
    if (v.supportRevision !== revision) {
      v.supportRevision = revision;
      if (vehicles.ground(v.x, v.z, v.y + 0.05, 0.3, 0.45) == null) { vehicles.destroy(v, null); return; }
    }
    const parts = vehicleHullParts(v), h = vehicleDef(v).rules.height;
    for (const other of vehicles.vehicles.values()) {
      if (other === v || !blocksHulls(other) || !(other.hp > 0)) continue;
      const moving = isAircraft(other.type) ? Math.hypot(other.vx || 0, other.vy || 0, other.vz || 0) : Math.abs(other.speed || 0);
      if (moving < MORTAR_RULES.crushSpeed || Math.hypot(other.x - v.x, other.z - v.z) > 12 || other.y > v.y + h + 4) continue;
      if (!vehicleHullParts(other).some(part => parts.some(box => hullBoxesOverlap(part, box)))) continue;
      const driver = vehicles.momentumDriver(other), enemy = driver && vehicles.teamOf(driver) !== v.team ? driver : null;
      vehicles.destroy(v, enemy, { sourceTeam: enemy ? null : other.team ?? null });
      return;
    }
  }

  wreckDone(v) { return isMortar(v) && v.wreckAge >= MORTAR_RULES.wreckSeconds; }

  onDestroyed(v) {
    if (!isMortar(v) || !v.ownerId) return;
    const wait = MORTAR_RULES.lostCooldownMs;
    this.readyAt.set(v.ownerId, Math.max(this.readyAt.get(v.ownerId) ?? -Infinity, this.now() + wait));
    if (this.owned.get(v.ownerId) === v.id) this.owned.delete(v.ownerId);
    this.engine.tickEvents?.push(evMortar(v.ownerId, 'lost', { vehicleId: v.id, waitMs: wait }));
  }

  /** Snapshot extras: `own`, the placing player's id. */
  rowExtras(v, row) { if (isMortar(v) && v.ownerId) row.own = v.ownerId; }
}
