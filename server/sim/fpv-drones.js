/**
 * Engineer FPV drones (Conquest, shared/fpv-rules.js). An Engineer who chose
 * the FPV gadget sends the `fpv` intent: an `fpv` hull goes up over his head
 * and from then on his ordinary input frames fly it (mouse-aim: the drone
 * faces his look, W along it, jump and crouch for height) while his body
 * stays crouched where it stood (`holdOperator` swaps the frame the movement
 * and weapon code read for a still one). The link holds while he is unhurt,
 * the battery lasts and the drone stays inside the signal range; when it
 * breaks (damage, a second press, range, battery) the drone falls and its
 * charge fires FPV_RULES.cutFuseMs later or on contact. The charge is an
 * ordinary projectile explosion (ProjectileSystem.explode), so damage credit,
 * the kill feed (`fpv`), score and the crater all take the usual path. A drone
 * shot down only pops (VEHICLE_DEFS.fpv.destruction) and pays its destroyer
 * `gadget_destroyed` like the mortar. Drones are removed without a blast when
 * the operator dies, leaves or comes back on another loadout.
 */
import { FPV_RULES, FPV_LINK, encodeFpvRow, fpvControls, fpvLook, fpvSignal, stepFpvVelocity, fpvAttitude } from '../../shared/fpv-rules.js';
import { vehicleDef, VEHICLE_RULES } from '../../shared/vehicle-defs.js';
import { raycastVoxels } from '../../shared/raycast.js';
import { occupantBodyCenter, occupantShielded } from './vehicle-damage.js';
import { evFpv } from '../protocol/events.js';

const TYPE = FPV_RULES.type;
const isFpv = v => v?.type === TYPE;
const C = FPV_RULES.charge;
const HEIGHT = VEHICLE_RULES[TYPE].height;
/** Blast profile of the shaped charge (ProjectileSystem.explode reads it as `blastRules`). */
const CHARGE_BLAST = Object.freeze({
  directDamage: C.infantryDirect, damage: C.splash, damageRadius: C.radius, damageFalloffExponent: 1,
  selfDamage: 0.5, knockback: C.knockback, selfKnockback: 0, knockbackRadius: C.radius, knockbackFalloff: 1.22,
  terrainRadius: C.terrainRadius, terrainPower: C.terrainPower, maxDestroyedBlocks: C.maxDestroyedBlocks,
  concussMs: 0, concussPanic: 0, cls: 'at', splashCls: 'at', burn: null,
});
/** The still frame an operator's body reads while he flies (crouched, facing his launch heading). */
const HOLD_KEYS = Object.freeze({ f: false, b: false, l: false, r: false, jump: false, sprint: false, crouch: true, prone: false,
  leanLeft: false, leanRight: false, interact: false });

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export class FpvSystem {
  constructor(vehicles) {
    this.vehicles = vehicles;
    this.serial = 0;
    this.reset();
  }
  get engine() { return this.vehicles.engine; }
  now() { return this.vehicles.nowMs(); }
  reset() {
    this.owned = new Map();     // playerId -> vehicleId of the drone in the air
    this.links = new Map();     // playerId -> { vehicleId, hp, yaw, pitch, input, fire }
    this.stock = new Map();     // playerId -> { left, refillAt }
    this.readyAt = new Map();   // playerId -> sim ms before which a new launch is refused
  }

  /** The live drone a player owns (flying or falling), or null. */
  droneOf(playerId) {
    const v = this.vehicles.vehicles.get(this.owned.get(String(playerId)));
    return v && isFpv(v) && v.hp > 0 && v.ownerId === String(playerId) ? v : null;
  }
  /** The drone `p` is flying now (an intact link), or null. */
  linkedDrone(p) {
    const link = p ? this.links.get(String(p.id)) : null;
    const v = link ? this.vehicles.vehicles.get(link.vehicleId) : null;
    return v && v.hp > 0 && v.cutAt == null ? v : null;
  }
  /** Every live drone (tests, bots, flak). */
  live() { return [...this.vehicles.vehicles.values()].filter(v => isFpv(v) && v.hp > 0); }
  /** Drones left this life (null: not an FPV Engineer). */
  dronesLeft(playerId) { return this.stock.get(String(playerId))?.left ?? null; }

  _event(id, state, extra) { this.engine.tickEvents?.push(evFpv(id, state, extra)); }
  _refuse(p, reason, waitMs = null) {
    this._event(p?.id ?? '', 'refused', { reason, waitMs });
    return { ok: false, reason, ...(Number.isFinite(waitMs) ? { waitMs } : {}) };
  }

  // --- kit -------------------------------------------------------------------

  /** A fresh life: an FPV Engineer gets FPV_RULES.drones, anyone else none (and loses a drone in the air). */
  onLoadout(entity, fpv) {
    const id = String(entity?.id ?? '');
    if (!id) return;
    this.removeOwner(id);
    if (fpv) this.stock.set(id, { left: FPV_RULES.drones, refillAt: -Infinity });
    else this.stock.delete(id);
  }
  /** Support aura: one drone back, at most every FPV_RULES.resupplyMs, never past the issued count. Returns true when given. */
  resupply(entity, now = this.now()) {
    const stock = this.stock.get(String(entity?.id ?? ''));
    if (!stock || stock.left >= FPV_RULES.drones || now - stock.refillAt < FPV_RULES.resupplyMs) return false;
    stock.left++; stock.refillAt = now;
    return true;
  }
  rename(priorId, nextId) {
    const prior = String(priorId), next = String(nextId);
    for (const map of [this.owned, this.links, this.stock, this.readyAt]) {
      if (map.has(prior)) { map.set(next, map.get(prior)); map.delete(prior); }
    }
    for (const v of this.live()) if (v.ownerId === prior) v.ownerId = next;
  }

  // --- launch and link --------------------------------------------------------

  /**
   * The `fpv` intent of `p` (the policy has checked the kit): launch a drone,
   * or cut the link of the one he flies. Returns { ok, vehicleId? } or a refusal.
   */
  toggle(p) {
    const flying = this.linkedDrone(p);
    if (flying) { this.cut(flying, 'released'); return { ok: true, vehicleId: flying.id }; }
    return this.launch(p);
  }

  launch(p) {
    const vehicles = this.vehicles, now = this.now(), id = String(p?.id ?? '');
    if (!p || p.state !== 'alive' || p.vehicleId || p.chute || !p.grounded || !vehicles.canOperate(p)) return this._refuse(p ?? { id }, 'state');
    const stock = this.stock.get(id);
    if (!stock) return this._refuse(p, 'kit');
    if (this.droneOf(id)) return this._refuse(p, 'busy');
    if (!(stock.left > 0)) return this._refuse(p, 'empty');
    const wait = (this.readyAt.get(id) ?? -Infinity) - now;
    if (wait > 0) return this._refuse(p, 'cooldown', wait);
    const yaw = Number.isFinite(p.input?.yaw) ? p.input.yaw : p.yaw ?? 0, pitch = Number.isFinite(p.input?.pitch) ? p.input.pitch : 0;
    const look = fpvLook(yaw, 0);
    const spot = [p.x + look[0] * FPV_RULES.launchForward, p.y + FPV_RULES.launchUp, p.z + look[2] * FPV_RULES.launchForward];
    // Room over the head: the eye sees the spot and the frame's cells are open.
    const eye = [p.x, p.y + 1.5, p.z], delta = spot.map((n, i) => n - eye[i]), length = Math.hypot(...delta);
    const solid = (x, y, z) => vehicles.solid(x, y, z, true);
    if (raycastVoxels(solid, ...eye, ...delta.map(n => n / length), length + 0.3)) return this._refuse(p, 'blocked');
    for (const dx of [-0.35, 0.35]) for (const dz of [-0.35, 0.35]) {
      if (solid(Math.floor(spot[0] + dx), Math.floor(spot[1] + HEIGHT), Math.floor(spot[2] + dz))) return this._refuse(p, 'blocked');
    }
    const v = this._hull(`${TYPE}-${id}-${++this.serial}`, p, spot, yaw, now);
    vehicles.vehicles.set(v.id, v);
    this.owned.set(id, v.id);
    stock.left--;
    // The operator's body keeps the heading and the crouch it launched with.
    this.links.set(id, { vehicleId: v.id, hp: p.hp, yaw, pitch: 0, input: p.input ?? null, fire: !!p.input?.wantFire });
    v.lookPitch = pitch;
    this._event(id, 'launched', { vehicleId: v.id, left: stock.left });
    return { ok: true, vehicleId: v.id };
  }

  /** A fresh drone hull (the fields VehicleSystem.reset gives a pad hull). */
  _hull(vehicleId, owner, spot, yaw, now) {
    const vehicles = this.vehicles, def = vehicleDef(TYPE), team = vehicles.teamOf(owner) ?? null;
    const [x, y, z] = spot;
    const v = { id: vehicleId, type: TYPE, team, x, y, z, yaw, pitch: 0, roll: 0,
      turretYaw: yaw, turretPitch: 0, speed: 0, yawRate: 0, visualSteer: 0, leftTrackSpeed: 0, rightTrackSpeed: 0,
      vx: 0, vy: FPV_RULES.launchSpeed, vz: 0, grounded: false,
      hp: def.hp, occupantId: null, seatOccupants: {}, respawnIn: 0, engineOn: true, wreckAge: 0,
      // A null pad team: never respawned, never sent home (padTeam).
      spawn: { x, y, z, yaw, team: null }, ownerId: String(owner.id),
      launchedAt: now, batteryUntil: now + FPV_RULES.batteryMs, cutAt: null, cutReason: null, lookPitch: 0 };
    vehicles.freshCondition(v);
    vehicles.mounts.reset(v);
    return v;
  }

  /** Break the link: the drone falls and the fuse burns (FPV_RULES.cutFuseMs). The operator is free at once. */
  cut(v, reason) {
    if (!isFpv(v) || v.cutAt != null || !(v.hp > 0)) return false;
    v.cutAt = this.now(); v.cutReason = reason; v.engineOn = false;
    this._release(v.ownerId, v.id);
    this._event(v.ownerId, 'cut', { vehicleId: v.id, reason });
    return true;
  }

  _release(ownerId, vehicleId) {
    const link = this.links.get(String(ownerId));
    if (!link || (vehicleId != null && link.vehicleId !== vehicleId)) return;
    this.links.delete(String(ownerId));
    const p = this.engine.entities.get(String(ownerId));
    // The body takes its own frames again: the last real one stands in until the next arrives.
    if (p && p.input?.fpvHold) p.input = link.input ?? null;
  }

  /**
   * The operator's real input this substep (stored), and his body's still
   * frame in its place: the movement and weapon code then hold him crouched
   * with his hands off the gun (queued fire, grenade and melee edges dropped).
   */
  holdOperator(p, link) {
    if (p.input && !p.input.fpvHold) link.input = p.input;
    const live = link.input ?? {};
    p.input = { seq: live.seq ?? 0, keys: HOLD_KEYS, yaw: link.yaw, pitch: link.pitch, viewYaw: link.yaw, wantFire: false, quickMelee: false,
      wantAds: false, scopeZoom: 0, reload: false, cancelMedkit: false, reloadId: 0, throwGrenade: false, grenadeHandling: false,
      grenadeCharge: 0, grenadeType: 0, grenadeCook: 0, viewAge: live.viewAge, switchTo: undefined, fpvHold: true };
    p.fireEdgeQueued = false; p.fireAimQueued = null; p.grenadeEdgeQueued = false; p.grenadeHandlingQueued = false; p.quickMeleeQueued = null;
    return live;
  }

  // --- flight -------------------------------------------------------------------

  /** One substep of a live drone: link checks, flight, contact, battery and fuse. */
  advance(v, dt) {
    const now = this.now(), engine = this.engine;
    const owner = engine.entities.get(v.ownerId);
    if (!owner) { this.remove(v); return; }
    let controls = { forward: 0, strafe: 0, lift: 0, yaw: v.yaw, pitch: v.lookPitch };
    if (v.cutAt == null) {
      const link = this.links.get(v.ownerId);
      if (!link || link.vehicleId !== v.id) { this.cut(v, 'lost'); }
      else if (owner.state !== 'alive' || engine.mode?.policy?.roles?.isDown?.(owner) === true) { this.remove(v); return; }
      else if (owner.hp < link.hp - 0.01) { link.hp = owner.hp; this.cut(v, 'hit'); }
      else {
        link.hp = owner.hp;
        const live = this.holdOperator(owner, link);
        controls = fpvControls(live);
        // The trigger fires the charge where the drone is.
        const fire = !!live.wantFire;
        if (fire && !link.fire && now - v.launchedAt >= FPV_RULES.armMs) { link.fire = fire; this.detonate(v, null); return; }
        link.fire = fire;
        if (now >= v.batteryUntil) this.cut(v, 'battery');
        else if (fpvSignal(dist([owner.x, owner.y + 1.5, owner.z], [v.x, v.y, v.z])).lost) this.cut(v, 'signal');
      }
    }
    if (v.cutAt != null && now - v.cutAt >= FPV_RULES.cutFuseMs) { this.detonate(v, null); return; }
    const powered = v.cutAt == null;
    const yawBefore = v.yaw;
    stepFpvVelocity(v, controls, dt, powered);
    if (powered) { v.yaw = controls.yaw; v.lookPitch = controls.pitch; }
    const yawRate = dt > 0 ? Math.atan2(Math.sin(v.yaw - yawBefore), Math.cos(v.yaw - yawBefore)) / dt : 0;
    const att = fpvAttitude([v.vx, v.vy, v.vz], v.yaw, yawRate);
    const blend = Math.min(1, dt * 10);
    v.pitch += (att.pitch - v.pitch) * blend; v.roll += (att.roll - v.roll) * blend;
    v.speed = Math.hypot(v.vx, v.vy, v.vz);
    v.engineOn = powered; v.grounded = false;
    this._move(v, dt, owner, now);
  }

  /** Sweep the frame's centre along its velocity: voxels, hulls and bodies stop it or fire the charge. */
  _move(v, dt, owner, now) {
    const vehicles = this.vehicles;
    const from = [v.x, v.y + HEIGHT / 2, v.z], delta = [v.vx * dt, v.vy * dt, v.vz * dt], length = Math.hypot(...delta);
    if (!(length > 1e-6)) return;
    const dir = delta.map(n => n / length), armed = now - v.launchedAt >= FPV_RULES.armMs || v.cutAt != null;
    const reach = length + 0.2;
    const hull = vehicles.rayHit(from, dir, reach, v.id);
    const voxel = raycastVoxels((x, y, z) => vehicles.solid(x, y, z, true), ...from, ...dir, reach);
    const body = armed ? this._bodyOnPath(from, dir, reach, owner, v) : null;
    const voxelT = voxel ? voxel.t : Infinity, hullT = hull ? hull.distance : Infinity, bodyT = body ? body.t : Infinity;
    const first = Math.min(voxelT, hullT, bodyT);
    if (first <= reach) {
      const point = from.map((n, i) => n + dir[i] * Math.max(0, first - 0.05));
      if (hullT === first) { this.detonate(v, { point, vehicleId: hull.wreck ? null : hull.id }); return; }
      if (bodyT === first) { this.detonate(v, { point, victim: body.victim }); return; }
      if (armed && (v.speed >= FPV_RULES.impactSpeed || v.cutAt != null)) { this.detonate(v, { point }); return; }
      // A slow bump: the frame stops against the voxel face.
      if (voxel.nx) v.vx = 0; if (voxel.ny) v.vy = 0; if (voxel.nz) v.vz = 0;
      if (!voxel.nx && !voxel.ny && !voxel.nz) v.vx = v.vy = v.vz = 0;
      return;
    }
    v.x += delta[0]; v.y += delta[1]; v.z += delta[2];
    // Under the world or far over it: gone with a blast.
    if (v.y < 0.5 || v.y > 400) this.detonate(v, null);
  }

  /** The nearest live body (not the operator, not behind armour) within FPV_RULES.bodyRadius of the path. */
  _bodyOnPath(from, dir, reach, owner, v) {
    let best = null;
    for (const e of this.engine.entities.values()) {
      if (e === owner || e.state !== 'alive' || occupantShielded(e)) continue;
      const c = occupantBodyCenter(e), o = c.map((n, i) => n - from[i]);
      const t = o[0] * dir[0] + o[1] * dir[1] + o[2] * dir[2];
      if (t < -FPV_RULES.bodyRadius || t > reach + FPV_RULES.bodyRadius) continue;
      const tc = Math.max(0, Math.min(reach, t));
      const miss = Math.hypot(...o.map((n, i) => n - dir[i] * tc));
      // The body's half height counts too: a drone diving onto a head meets it.
      if (miss > FPV_RULES.bodyRadius + 0.45) continue;
      if (!best || tc < best.t) best = { victim: e, t: tc };
    }
    return best;
  }

  // --- the charge -------------------------------------------------------------------

  /**
   * Fire the shaped charge where the drone is (or at `contact.point`): the
   * hull is gone at once and one projectile explosion carries the damage,
   * the credit (kill key `fpv`) and the crater. `contact.vehicleId` takes
   * the direct charge (FPV_RULES.charge.direct × the armour bonus), a
   * `contact.victim` the infantry direct share.
   */
  detonate(v, contact = null) {
    const engine = this.engine, projectiles = engine.projectiles, ctx = this.vehicles.projectileContext();
    const point = contact?.point ?? [v.x, v.y + HEIGHT / 2, v.z];
    const owner = engine.entities.get(v.ownerId) ?? null;
    this.remove(v, false);
    this._event(v.ownerId, 'detonated', { vehicleId: v.id, pos: point });
    if (!projectiles || !ctx) return false;
    const target = contact?.vehicleId ? this.vehicles.vehicles.get(contact.vehicleId) : null;
    const bonus = target ? C.armor[vehicleDef(target)?.armor] ?? 1 : 1;
    const id = `fpv${++this.serial}`;
    const projectile = { id, type: 'rocket', eventType: 'rocket', weaponKey: FPV_RULES.killKey, ownerId: v.ownerId, owner,
      x: point[0], y: point[1], z: point[2], vx: v.vx, vy: v.vy, vz: v.vz, stuck: false, hit: null, chaosLevel: 0,
      blastRules: CHARGE_BLAST, hullCls: 'at', infantrySplashScale: C.infantry / C.splash,
      hullDirect: target ? C.direct * bonus : 0, directVehicleId: target?.hp > 0 ? target.id : null, directPoint: point, directDir: null,
      directVictim: contact?.victim ?? null };
    projectiles.active.set(id, projectile);
    return projectiles.explode(projectile, ctx);
  }

  // --- life cycle ---------------------------------------------------------------------

  /** Take a drone off the field (no blast; `quiet` skips the event): owner gone, dead, new loadout. */
  remove(v, quiet = true) {
    this.vehicles.vehicles.delete(v.id);
    if (this.owned.get(v.ownerId) === v.id) this.owned.delete(v.ownerId);
    this._release(v.ownerId, v.id);
    this.readyAt.set(v.ownerId, Math.max(this.readyAt.get(v.ownerId) ?? -Infinity, this.now() + FPV_RULES.relaunchMs));
    if (quiet) this._event(v.ownerId, 'removed', { vehicleId: v.id });
  }
  /** Every drone of a player (leaving, team change, death, a new loadout). */
  removeOwner(ownerId) {
    const v = this.droneOf(ownerId);
    if (v) this.remove(v);
    this.links.delete(String(ownerId));
  }

  /** Shot down (VehicleSystem.destroy): the link and the slot are free, the wreck goes next substep. */
  onDestroyed(v, killer) {
    if (!isFpv(v) || !v.ownerId) return;
    this._release(v.ownerId, v.id);
    if (this.owned.get(v.ownerId) === v.id) this.owned.delete(v.ownerId);
    this.readyAt.set(v.ownerId, this.now() + FPV_RULES.relaunchMs);
    this._event(v.ownerId, 'lost', { vehicleId: v.id, by: killer?.id != null ? String(killer.id) : null });
  }
  wreckDone(v) { return isFpv(v); }

  /** Snapshot extras: `own` (the operator) and `fpv` (shared/fpv-rules.js encodeFpvRow). */
  rowExtras(v, row) {
    if (!isFpv(v)) return;
    row.own = v.ownerId;
    row.fpv = encodeFpvRow(v, this.now());
  }
}

export { FPV_LINK };
