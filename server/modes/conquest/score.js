import { SCORE_POINTS } from '../../../shared/conquest-contract.js';
import { VEHICLE_RULES } from '../../../shared/vehicles.js';

/** Damage older than this no longer earns an assist. */
export const ASSIST_WINDOW_MS = 10000;
/** Hull damage is paid out once the attacker pauses this long (or the hull dies). */
export const VEHICLE_DAMAGE_FLUSH_MS = 1500;
/** Smallest share of a hull's max HP that earns vehicle-damage points. */
export const VEHICLE_DAMAGE_MIN_FRACTION = 0.02;
const OBJECTIVE_REASONS = new Set(['capture', 'neutralize', 'capture_assist', 'defend']);
const STAT_INDEX = Object.freeze({ objective: 0, vehicles: 1, revives: 2, captures: 3 });
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const idOf = value => (value && typeof value === 'object' ? (value.id == null ? null : String(value.id))
  : value == null || value === '' ? null : String(value));

/**
 * Conquest score ledger. Every point a player earns goes through `award`,
 * which adds to `entity.score`, keeps the per-player `cqs` counters and emits
 * `score {id, pts, reason}`. Kill points are paid here, so the controller's
 * killScoreDelta is 0 for Conquest.
 */
export class ScoreLedger {
  /**
   * `host` supplies: now(), emit(kind, fields), entity(id), teamFor(p),
   * isEnemy(a, b), vehicleFor(id), flags() (rich capture rows) and rules;
   * optionally damageTakenScale(entity, weapon) and onInfantryHit(victim,
   * attacker, weapon, amount) (the roles package's kit passives).
   */
  constructor(host) {
    this.host = host;
    this.reset();
  }

  reset() {
    this.stats = new Map();
    this.contributions = new Map();
    this.vehicleDamage = new Map();
  }

  /** Install the damage hook that feeds assists and squad-spawn damage locks. */
  attach(entity) {
    if (!entity || entity.conquestDamageHook) return;
    const prior = typeof entity.beforeDamage === 'function' ? entity.beforeDamage : null;
    const hook = (dmg, attacker, weapon) => {
      let amount = prior ? (prior(dmg, attacker, weapon) ?? dmg) : dmg;
      // Kit damage scaling (Pyro FIREPROOF) before the hit is recorded, so assists see the real damage.
      const scale = this.host.damageTakenScale?.(entity, weapon);
      if (Number.isFinite(scale) && scale !== 1) amount *= Math.max(0, scale);
      this.recordDamage(entity, attacker, amount);
      if (amount > 0) this.host.onInfantryHit?.(entity, attacker, weapon, amount);
      return amount;
    };
    entity.beforeDamage = hook;
    entity.conquestDamageHook = hook;
  }

  detach(entity) {
    if (entity?.conquestDamageHook && entity.beforeDamage === entity.conquestDamageHook) entity.beforeDamage = null;
    if (entity) entity.conquestDamageHook = null;
  }

  recordDamage(victim, attacker, amount) {
    if (!victim || !(amount > 0)) return;
    const now = this.host.now();
    victim.lastDamagedAt = now;
    const attackerId = idOf(attacker);
    if (!attackerId || attackerId === String(victim.id)) return;
    const effective = Math.min(amount, Math.max(0, victim.hp) + Math.max(0, victim.armor || 0));
    if (!(effective > 0)) return;
    const key = String(victim.id);
    const list = (this.contributions.get(key) || []).filter(c => now - c.at <= ASSIST_WINDOW_MS);
    list.push({ id: attackerId, amount: effective, at: now });
    this.contributions.set(key, list);
  }

  /** The latest other player who damaged `victimId` within `windowMs`, or null (fall-death credit). */
  lastAttacker(victimId, windowMs) {
    const now = this.host.now();
    const list = this.contributions.get(String(victimId)) || [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (now - list[i].at > windowMs) break;
      const entity = this.host.entity(list[i].id);
      if (entity) return entity;
    }
    return null;
  }

  /** Award `SCORE_POINTS[reason] * scale` (rounded) to a player; returns the points paid. */
  award(playerId, reason, scale = 1) {
    const base = SCORE_POINTS[reason];
    const entity = this.host.entity(playerId);
    if (!Number.isFinite(base) || !entity || !Number.isFinite(scale) || scale <= 0) return 0;
    const pts = Math.round(base * scale);
    if (pts <= 0) return 0;
    const id = String(entity.id);
    entity.score = (Number.isFinite(entity.score) ? entity.score : 0) + pts;
    const stats = this._stats(id);
    if (OBJECTIVE_REASONS.has(reason)) stats[STAT_INDEX.objective] += pts;
    if (reason === 'vehicle_destroyed') stats[STAT_INDEX.vehicles]++;
    if (reason === 'revive') stats[STAT_INDEX.revives]++;
    if (reason === 'capture') stats[STAT_INDEX.captures]++;
    this.host.emit('score', { id, pts, reason });
    return pts;
  }

  /** `[objectiveScore, vehiclesDestroyed, revives, captures]` for the cqs row. */
  statsRow(playerId) { return this._stats(String(playerId)).slice(); }

  /**
   * Kill payout: kill, headshot, attacker/defender kill near a flag, driver
   * assist for the crew's driver, and damage-share assists to other enemies
   * of the victim who hurt it in the last 10 s.
   */
  onKill(victim, killer, context = {}) {
    const host = this.host;
    const now = host.now();
    const victimId = String(victim.id);
    const recent = (this.contributions.get(victimId) || []).filter(c => now - c.at <= ASSIST_WINDOW_MS);
    this.contributions.delete(victimId);
    const killerEntity = killer ? host.entity(killer) : null;
    const killerId = killerEntity ? String(killerEntity.id) : null;
    if (killerEntity && killerId !== victimId && host.isEnemy(killerEntity, victim)) {
      this.award(killerId, 'kill');
      if (context?.headshot === true) this.award(killerId, 'headshot');
      const zone = this._killZone(victim, killerEntity);
      if (zone) this.award(killerId, zone.owner === host.teamFor(killerEntity) ? 'defender_kill' : 'attacker_kill');
      this._driverAssist(killerEntity);
    }
    const totals = new Map();
    for (const c of recent) totals.set(c.id, (totals.get(c.id) || 0) + c.amount);
    const maxHp = Number.isFinite(victim.maxHp) && victim.maxHp > 0 ? victim.maxHp : 100;
    for (const [id, damage] of totals) {
      if (id === killerId || id === victimId) continue;
      const helper = host.entity(id);
      if (!helper || !host.isEnemy(helper, victim)) continue;
      // 50 points for half a life of damage, scaled into 10..90.
      this.award(id, 'assist', clamp((damage / maxHp) * 2, 0.2, 1.8));
    }
  }

  /** Mode hook from the VehicleSystem: hits, disables and destructions. */
  onVehicleEvent(kind, payload = {}) {
    const now = this.host.now();
    const vehicleId = payload?.vehicleId == null ? null : String(payload.vehicleId);
    if (!vehicleId) return;
    const attackerId = idOf(payload.attacker);
    const vehicleTeam = this.host.vehicleFor(vehicleId)?.team ?? payload.team ?? null;
    const hostile = id => {
      const entity = id ? this.host.entity(id) : null;
      const team = entity ? this.host.teamFor(entity) : null;
      return !!entity && !!team && !!vehicleTeam && team !== vehicleTeam;
    };
    if (kind === 'vehicle_hit') {
      const dmg = Number(payload.dmg);
      if (!(dmg > 0) || payload.eff === 0 || !hostile(attackerId)) return;
      const key = `${attackerId}\u0000${vehicleId}`;
      const row = this.vehicleDamage.get(key) || { attackerId, vehicleId, dmg: 0, at: now };
      row.dmg += dmg;
      row.at = now;
      this.vehicleDamage.set(key, row);
    } else if (kind === 'vehicle_disabled') {
      if (hostile(attackerId)) this.award(attackerId, 'vehicle_disabled');
    } else if (kind === 'vehicle_destroyed') {
      this._flushVehicleDamage(now, vehicleId);
      if (!hostile(attackerId)) return;
      this.award(attackerId, 'vehicle_destroyed');
      const crew = Array.isArray(payload.crewKilled) ? payload.crewKilled.length : Math.max(0, Math.trunc(payload.crewKilled) || 0);
      if (crew > 0) this.award(attackerId, 'vehicle_crew', crew);
    }
  }

  /** Pay out hull damage whose attacker paused for VEHICLE_DAMAGE_FLUSH_MS. */
  tick(now) { this._flushVehicleDamage(now, null); }

  rename(priorId, nextId) {
    const prior = String(priorId), next = String(nextId);
    if (this.stats.has(prior)) { this.stats.set(next, this.stats.get(prior)); this.stats.delete(prior); }
    if (this.contributions.has(prior)) { this.contributions.set(next, this.contributions.get(prior)); this.contributions.delete(prior); }
    for (const list of this.contributions.values()) for (const c of list) if (c.id === prior) c.id = next;
    for (const [key, row] of [...this.vehicleDamage]) {
      if (row.attackerId !== prior) continue;
      this.vehicleDamage.delete(key);
      row.attackerId = next;
      this.vehicleDamage.set(`${next}\u0000${row.vehicleId}`, row);
    }
  }

  remove(playerId) {
    const id = String(playerId);
    this.stats.delete(id);
    this.contributions.delete(id);
    for (const [key, row] of [...this.vehicleDamage]) if (row.attackerId === id) this.vehicleDamage.delete(key);
  }

  _stats(id) {
    let row = this.stats.get(id);
    if (!row) { row = [0, 0, 0, 0]; this.stats.set(id, row); }
    return row;
  }

  _flushVehicleDamage(now, vehicleId) {
    for (const [key, row] of [...this.vehicleDamage]) {
      if (vehicleId ? row.vehicleId !== vehicleId : now - row.at < VEHICLE_DAMAGE_FLUSH_MS) continue;
      this.vehicleDamage.delete(key);
      const hull = this.host.vehicleFor(row.vehicleId);
      const maxHp = Number.isFinite(hull?.maxHp) ? hull.maxHp : VEHICLE_RULES[hull?.type]?.hp ?? 1000;
      const fraction = row.dmg / Math.max(1, maxHp);
      // 50 points per quarter hull, scaled into 10..150.
      if (fraction >= VEHICLE_DAMAGE_MIN_FRACTION) this.award(row.attackerId, 'vehicle_damage', clamp(fraction * 4, 0.2, 3));
    }
  }

  /** The flag zone the kill happened in: the victim's zone first, else the killer's. */
  _killZone(victim, killer) {
    const flags = this.host.flags();
    const dy = this.host.rules.presenceDy;
    const inside = (flag, p) => Number.isFinite(p?.x) && Math.hypot(p.x - flag.x, p.z - flag.z) <= flag.radius
      && Math.abs(p.y - flag.y) <= dy;
    return flags.find(f => inside(f, victim)) || flags.find(f => inside(f, killer)) || null;
  }

  /** A gunner or passenger's kill credits the hull's driver. */
  _driverAssist(killer) {
    if (!killer.vehicleId) return;
    const hull = this.host.vehicleFor(killer.vehicleId);
    const driverId = hull?.occupantId == null ? null : String(hull.occupantId);
    if (!driverId || driverId === String(killer.id)) return;
    const driver = this.host.entity(driverId);
    if (driver?.state === 'alive' && this.host.teamFor(driver) === this.host.teamFor(killer)) this.award(driverId, 'driver_assist');
  }
}
