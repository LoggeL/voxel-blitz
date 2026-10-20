// Hazard zones of the Conquest map events (docs/conquest.md "Map events"):
// burning ground, a flood wave's shove, a toppling structure's crush line, a
// drowning-style lethal volume. Zones live from `from` to `until` (engine
// ms) and hit infantry and hulls; bots avoid every zone with `avoid` from
// `warnFrom` on (server/bot-map-events.js).
//
//   fire    `dps` to infantry (Pyros are fireproof, as in a Molotov field) and
//           `hullDps` to ground hulls, applied every `tickMs`
//   push    a velocity kick `impulse` {x, y, z} (or radial `push` m/s and `up`)
//           to infantry and ground hulls, at most once per `pushCooldownMs`
//           per body, plus optional `damage` / `hullFraction` with it
//   crush   once, when the zone opens: `damage` (default lethal) to infantry
//           and `hullFraction` of max HP to ground hulls inside
//   lethal  infantry inside for `graceMs` die; hulls take `hullFraction`
//
// Damage and kills credit the zone's `by` (the event's trigger) with its
// `killKey`. As with the Iron Bridge crush, a teammate of `by` is spared
// (`spareTeam`, default true; false: hurt without credit) and `by` itself is
// not. A zone without `by` hurts everyone, uncredited.
import { MAP_EVENT_RULES, zoneCenter, zoneContains } from '../../../../shared/conquest-map-events.js';
import { isAircraft, vehicleMaxHp } from '../../../../shared/vehicles.js';
import { evHit } from '../../../protocol/events.js';
import { markLaunched } from '../../../sim/player.js';

export const HAZARD_KINDS = Object.freeze(['fire', 'push', 'crush', 'lethal']);

export class HazardZones {
  constructor(system, rules = MAP_EVENT_RULES.hazards) {
    this.system = system;
    this.rules = rules;
    this.reset();
  }

  reset() {
    this.zones = [];
    this.serial = 0;
    this.carry = 0;
  }

  get engine() { return this.system.engine; }

  /**
   * Open a zone of `instance`. `spec`: kind, a zone shape (shared geometry:
   * circle / box / line with y0 / y1), from (default now), until (default
   * open), warnFrom (bots avoid it from then; default from), by, killKey,
   * spareTeam, avoid (default true), dps, hullDps, impulse, push, up,
   * damage, hullFraction, graceMs. Returns the zone.
   */
  add(instance, spec) {
    if (!HAZARD_KINDS.includes(spec.kind)) throw new Error(`hazard kind ${spec.kind}`);
    const now = this.system.now;
    const zone = {
      ...spec, instance, id: spec.id ?? `hz-${++this.serial}`, from: spec.from ?? now, until: spec.until ?? Infinity,
      warnFrom: spec.warnFrom ?? spec.from ?? now, by: spec.by == null ? null : String(spec.by), killKey: spec.killKey ?? instance?.controller?.killKey ?? 'collapse',
      spareTeam: spec.spareTeam !== false, avoid: spec.avoid !== false, hits: new Map(), inside: new Map(), fired: false,
    };
    this.zones.push(zone);
    return zone;
  }

  remove(zone) { this.zones = this.zones.filter(z => z !== zone && z.id !== zone); }
  clear(instance) { this.zones = this.zones.filter(z => z.instance !== instance); }
  of(instance) { return this.zones.filter(z => z.instance === instance); }

  active(zone, now = this.system.now) { return now >= zone.from && now < zone.until; }

  /** Zones bots keep out of now (open or about to open), optionally only those that would hurt `team`. */
  avoidZones(now = this.system.now, team = null) {
    return this.zones.filter(z => z.avoid && now >= z.warnFrom && now < z.until && !(team && z.spareTeam && z.byTeam === team));
  }

  /** Zones containing a point (feet), open now. */
  at(x, y, z, now = this.system.now) { return this.zones.filter(zone => this.active(zone, now) && zoneContains(zone, x, y, z)); }

  /** One live tick. */
  tick(now, dtMs) {
    if (!this.zones.length) return;
    this.zones = this.zones.filter(z => now < z.until || (z.kind === 'crush' && !z.fired));
    this.carry += dtMs;
    const pulse = this.carry >= this.rules.tickMs;
    const pulseMs = this.carry;
    if (pulse) this.carry = 0;
    for (const zone of this.zones) {
      if (now < zone.from) continue;
      zone.byTeam = zone.by ? this.system.policy?.teamFor?.(this.system.entity(zone.by)) ?? null : null;
      if (zone.kind === 'crush') { if (!zone.fired) { zone.fired = true; this._crush(zone); zone.until = now; } continue; }
      if (zone.kind === 'push') { this._push(zone, now); continue; }
      if (zone.kind === 'lethal') { this._lethal(zone, now, dtMs); if (pulse) this._hulls(zone, zone.hullFraction ? 'frac' : null, pulseMs); continue; }
      if (pulse) this._fire(zone, pulseMs);
    }
  }

  /** The credited killer for `victim` under `zone`, or `false` when the victim is spared. */
  credit(zone, victim) {
    const killer = zone.by ? this.system.entity(zone.by) : null;
    if (!killer || killer === victim) return killer ?? null;
    if (this.system.policy?.canDamage?.(killer, victim) === false) return zone.spareTeam ? false : null;
    return killer;
  }

  *_victims(zone) {
    const engine = this.engine;
    for (const victim of engine?.combatants?.values?.() ?? []) {
      if (victim.state !== 'alive' || victim.vehicleId || victim.objective) continue;
      if (victim.spawnProtected || (Number.isFinite(victim.spawnProtectedUntil) && victim.spawnProtectedUntil > engine.now)) continue;
      if (!zoneContains(zone, victim.x, victim.y, victim.z)) continue;
      yield victim;
    }
  }

  _hurt(zone, victim, amount) {
    if (!(amount > 0)) return false;
    const credited = this.credit(zone, victim);
    if (credited === false) return false;
    const engine = this.engine;
    const lethal = victim.takeDamage(amount, false, credited, zone.killKey);
    engine.tickEvents.push(evHit(credited ? credited.id : '', victim.id, amount, false, [victim.x, victim.y + 1, victim.z], victim.lastDamage));
    if (lethal) engine.killPlayer(victim, credited, zone.killKey, false, null);
    return true;
  }

  _fire(zone, ms) {
    for (const victim of this._victims(zone)) {
      if (victim.fireImmune) continue;
      this._hurt(zone, victim, (zone.dps ?? 0) * ms / 1000);
    }
    if (zone.hullDps > 0) this._hulls(zone, 'dps', ms);
  }

  _crush(zone) {
    for (const victim of this._victims(zone)) this._hurt(zone, victim, zone.damage ?? 999);
    if (zone.hullFraction > 0) this._hulls(zone, 'frac', 0);
  }

  _lethal(zone, now, dtMs) {
    const seen = new Set();
    for (const victim of this._victims(zone)) {
      const id = String(victim.id);
      seen.add(id);
      const t = (zone.inside.get(id) ?? 0) + dtMs;
      zone.inside.set(id, t);
      if (t >= (zone.graceMs ?? 0)) this._hurt(zone, victim, Math.max(999, victim.hp + (victim.armor ?? 0) + 1));
    }
    for (const id of [...zone.inside.keys()]) if (!seen.has(id)) zone.inside.delete(id);
  }

  _push(zone, now) {
    const center = zoneCenter(zone);
    const kick = body => {
      let { x = 0, y = 0, z = 0 } = zone.impulse ?? {};
      if (zone.push && center) {
        const dx = body.x - center.x, dz = body.z - center.z, d = Math.hypot(dx, dz) || 1;
        x += dx / d * zone.push; z += dz / d * zone.push;
      }
      return { x, y: y + (zone.up ?? 0), z };
    };
    const cooldown = this.rules.pushCooldownMs;
    for (const victim of this._victims(zone)) {
      const id = String(victim.id);
      if (now - (zone.hits.get(id) ?? -Infinity) < cooldown) continue;
      if (this.credit(zone, victim) === false) continue;
      zone.hits.set(id, now);
      const v = kick(victim);
      victim.vx = (victim.vx ?? 0) + v.x; victim.vy = Math.max(victim.vy ?? 0, 0) + v.y; victim.vz = (victim.vz ?? 0) + v.z;
      markLaunched(victim);
      if (zone.damage > 0) this._hurt(zone, victim, zone.damage);
    }
    for (const hull of this._hullsIn(zone)) {
      const id = `v:${hull.id}`;
      if (now - (zone.hits.get(id) ?? -Infinity) < cooldown) continue;
      zone.hits.set(id, now);
      const v = kick(hull), scale = zone.hullPush ?? 0.5;
      hull.vx = (hull.vx ?? 0) + v.x * scale; hull.vz = (hull.vz ?? 0) + v.z * scale;
      if (zone.hullFraction > 0) this._damageHull(zone, hull, (vehicleMaxHp(hull.type) || hull.maxHp || 0) * zone.hullFraction);
    }
  }

  *_hullsIn(zone) {
    for (const hull of this.engine?.vehicles?.vehicles?.values?.() ?? []) {
      if (!(hull.hp > 0) || (isAircraft(hull.type) && !hull.grounded)) continue;
      if (zoneContains(zone, hull.x, hull.y, hull.z, 1)) yield hull;
    }
  }

  _hulls(zone, how, ms) {
    for (const hull of this._hullsIn(zone)) {
      const max = vehicleMaxHp(hull.type) || hull.maxHp || 0;
      const amount = how === 'dps' ? zone.hullDps * ms / 1000 : how === 'frac' ? max * zone.hullFraction * (zone.kind === 'lethal' ? ms / 1000 : 1) : 0;
      this._damageHull(zone, hull, amount);
    }
  }

  _damageHull(zone, hull, amount) {
    if (!(amount > 0)) return;
    const killer = zone.by ? this.system.entity(zone.by) : null;
    const friendly = killer && hull.team && this.system.policy?.teamFor?.(killer) === hull.team;
    if (friendly && zone.spareTeam) return;
    this.engine.vehicles.damage(hull.id, amount, friendly ? null : killer,
      { cls: zone.kind === 'fire' ? 'fire' : 'collision', point: [hull.x, hull.y + 1, hull.z] });
  }
}
