// Conquest Recon gadgets (server authority; docs/conquest.md "Recon gadgets"):
// the SPAWN BEACON a Recon lays from the grenade pouch and the MOTION SENSORS
// it throws. ConquestPolicy owns one instance; the projectile system hands it
// a laid beacon (`ctx.placeBeacon`) and a settled sensor (`ctx.deploySensor`),
// the hitscan walk asks it for gadgets on a round's path (`ctx.nearestGadget`)
// and every blast of the tick reaches it through `projectileExplode`. Rules
// and the wire codec live in shared/recon-gadgets.js.

import { GRENADE_TYPES } from '../../../shared/grenade-rules.js';
import {
  RECON_GADGET_RULES, encodeReconGadgets, placeBeacon, rayReconGadget, reconGadgetCenter, sensorDetects,
} from '../../../shared/recon-gadgets.js';
import { AIR } from '../../../shared/worlddata.js';
import { PROJECTILE_RULES } from '../../sim/projectiles.js';

const idOf = value => value && typeof value === 'object' ? String(value.id ?? '') : String(value ?? '');
/** A flat move faster than this between two scans is a teleport (respawn, seat change), not motion. */
const TELEPORT_SPEED = 60;
/** Blast types that never hurt a gadget (clouds, fire fields, the gadgets themselves). */
const HARMLESS_BLASTS = new Set(['smoke', 'molotov', 'sensor', 'beacon', 'glaive']);

export class ReconGadgets {
  /** `policy` is the owning ConquestPolicy (clock, teams, entities, engine, award, emit). */
  constructor(policy) {
    this.policy = policy;
    this._nextId = 1;
    this.reset();
  }

  reset() {
    /** id -> {kind:'beacon', id, ownerId, team, x, y, z, mount, hp, readyAt, spottedBy, spottedUntil, placedAt} */
    this.beacons = new Map();
    /** id -> {kind:'sensor', id, ownerId, team, x, y, z, hp, until} */
    this.sensors = new Map();
    /** team -> Map(playerId -> reveal until) */
    this.sensed = { alpha: new Map(), bravo: new Map() };
    /** playerId -> {x, z, at} at the last scan */
    this._samples = new Map();
    /** playerId -> {team, ownerId, until}: the latest sensor that revealed it (kill assists) */
    this._revealedBy = new Map();
    this._nextScanAt = -Infinity;
  }

  get now() { return this.policy?.now ?? 0; }
  get engine() { return this.policy?.engine ?? null; }

  _entity(id) { return this.policy?._entity?.(id) ?? this.engine?.entities?.get?.(String(id)) ?? null; }
  _teamOf(entity) { return entity ? this.policy?.teamFor?.(entity) ?? entity.team ?? null : null; }
  _solidAt() {
    const engine = this.engine;
    return engine?.solidAt ?? (engine?.world ? (x, y, z) => engine.world.getBlock(x, y, z) !== AIR : null);
  }

  _emit(gadget, state, extra = {}) {
    this.policy?._emit?.('recon_gadget', { gadget: gadget.kind, id: gadget.id, owner: gadget.ownerId, team: gadget.team,
      state, pos: reconGadgetCenter(gadget).map(v => Math.round(v * 100) / 100), ...extra });
  }

  /** Live gadgets of either kind. */
  *all() { yield* this.beacons.values(); yield* this.sensors.values(); }

  beacon(id) { return this.beacons.get(String(id)) ?? null; }
  beaconOf(ownerId) {
    for (const b of this.beacons.values()) if (b.ownerId === String(ownerId)) return b;
    return null;
  }

  // --- placement -------------------------------------------------------------

  /**
   * The pouch beacon (ProjectileSystem.throw): laid on the floor under the aim
   * (shared placeBeacon). One per owner: the old one goes. Returns the beacon,
   * or null when refused (no floor, outside the live phase, not a Recon), and
   * then nothing is spent.
   */
  placeBeacon(player, direction, index) {
    const policy = this.policy;
    if (!player || policy?.phase !== 'live' || player.state !== 'alive' || !(player.grenades?.[index] > 0)) return null;
    const team = this._teamOf(player);
    if (!team) return null;
    const solidAt = this._solidAt();
    const spot = placeBeacon({ x: player.eyeX ?? player.x, eyeY: player.eyeY, z: player.eyeZ ?? player.z, dir: direction }, solidAt);
    if (!spot) return null;
    const ownerId = String(player.id);
    const prior = this.beaconOf(ownerId);
    if (prior) this.remove(prior, 'removed');
    const beacon = { kind: 'beacon', id: `rb${this._nextId++}`, ownerId, team, x: spot.x, y: spot.y, z: spot.z,
      mount: spot.mount, hp: RECON_GADGET_RULES.beacon.hp, readyAt: -Infinity, spottedBy: null, spottedUntil: -Infinity,
      placedAt: this.now };
    player.grenades[index]--;
    player.spawnProtectedUntil = 0;
    player.spawnProtected = false;
    this.beacons.set(beacon.id, beacon);
    this._emit(beacon, 'placed');
    return beacon;
  }

  /** A thrown sensor that settled (its fuse ran out): it senses from where it lies for lifeMs. */
  deploySensor(projectile) {
    const owner = this._entity(projectile?.ownerId);
    const team = owner ? this._teamOf(owner) : null;
    if (!team || this.policy?.phase !== 'live' || ![projectile.x, projectile.y, projectile.z].every(Number.isFinite)) return false;
    const r = RECON_GADGET_RULES.sensor;
    const ownerId = String(projectile.ownerId);
    const own = [...this.sensors.values()].filter(s => s.ownerId === ownerId);
    for (let i = 0; i <= own.length - r.maxPerOwner; i++) this.remove(own[i], 'removed');
    // The grenade's centre rides its collision radius above the floor; the sensor's feet sit on it.
    const radius = GRENADE_TYPES.sensor.physics.radius;
    const sensor = { kind: 'sensor', id: `rs${this._nextId++}`, ownerId, team, x: projectile.x, y: projectile.y - radius,
      z: projectile.z, hp: r.hp, until: this.now + r.lifeMs };
    this.sensors.set(sensor.id, sensor);
    this._emit(sensor, 'placed');
    return true;
  }

  // --- damage ----------------------------------------------------------------

  _hostile(gadget, attacker) {
    const team = attacker ? this._teamOf(attacker) : null;
    return !team || team !== gadget.team;
  }

  /** Nearest enemy gadget on a round's path (combat walk): `{gadget, t}` or null. */
  nearest(shooter, origin, direction, limit, minT = 0, radius = 0) {
    if (this.policy?.phase !== 'live' || (!this.beacons.size && !this.sensors.size)) return null;
    let best = null;
    for (const gadget of this.all()) {
      if (!this._hostile(gadget, shooter)) continue;
      const t = rayReconGadget(gadget, origin, direction, best?.t ?? limit, minT, radius);
      if (t !== null) best = { gadget, t };
    }
    return best;
  }

  /** Damage from an enemy (bullets, blasts); destroyed at 0 HP, the destroyer paid `gadget_destroyed`. */
  damage(gadget, amount, attacker = null) {
    if (!gadget || !(amount > 0) || this.policy?.phase !== 'live') return false;
    if (!this.beacons.has(gadget.id) && !this.sensors.has(gadget.id)) return false;
    if (!this._hostile(gadget, attacker)) return false;
    gadget.hp -= amount;
    if (gadget.hp > 0) return false;
    const by = attacker ? idOf(attacker) : null;
    this.remove(gadget, 'destroyed', by ? { by } : {});
    if (by && this._entity(by)) this.policy?.award?.(by, 'gadget_destroyed');
    return true;
  }

  /** Blast damage of one explosion: the type's centre damage, falling off linearly to its radius. */
  _blast(event) {
    const radius = Number(event.radius);
    if (!(radius > 0) || HARMLESS_BLASTS.has(event.type)) return;
    const rules = GRENADE_TYPES[event.type] ?? PROJECTILE_RULES[event.type] ?? null;
    const base = rules ? (Number(rules.damage) || 0) + (Number(rules.directDamage) || 0) : RECON_GADGET_RULES.blastDamage;
    if (!(base > 0)) return;
    const origin = [Number(event.x), Number(event.y), Number(event.z)];
    if (!origin.every(Number.isFinite)) return;
    // A blast whose owner left (team unknown) still hurts every gadget.
    const attacker = event.id ? this._entity(event.id) : null;
    for (const gadget of [...this.all()]) {
      const c = reconGadgetCenter(gadget);
      const d = Math.hypot(c[0] - origin[0], c[1] - origin[1], c[2] - origin[2]);
      if (d < radius) this.damage(gadget, base * (1 - d / radius), attacker);
    }
  }

  // --- life cycle -------------------------------------------------------------

  remove(gadget, state = 'removed', extra = {}) {
    const map = gadget.kind === 'beacon' ? this.beacons : this.sensors;
    if (!map.delete(gadget.id)) return false;
    this._emit(gadget, state, extra);
    return true;
  }

  /** Every gadget of a player (leaving, team change). */
  removeOwner(ownerId, state = 'removed') {
    const id = String(ownerId);
    for (const gadget of [...this.all()]) if (gadget.ownerId === id) this.remove(gadget, state);
  }

  /** A fresh life on another kit, or the Recon on the other gadget: its beacon goes. */
  onLoadout(entity, kit, gadget) {
    const beacon = entity ? this.beaconOf(entity.id) : null;
    if (beacon && (kit !== 'recon' || (gadget | 0) !== 0)) this.remove(beacon, 'removed');
  }

  rename(priorId, nextId) {
    const prior = String(priorId), next = String(nextId);
    for (const gadget of this.all()) if (gadget.ownerId === prior) gadget.ownerId = next;
    for (const map of [...Object.values(this.sensed), this._samples, this._revealedBy]) {
      if (map.has(prior)) { map.set(next, map.get(prior)); map.delete(prior); }
    }
    for (const mark of this._revealedBy.values()) if (mark.ownerId === prior) mark.ownerId = next;
  }

  /** Per-tick upkeep (live phase): this tick's blasts, lost floors and owners, expiry, the sensor scan. */
  tick(now = this.now) {
    if (!this.beacons.size && !this.sensors.size && !this.sensed.alpha.size && !this.sensed.bravo.size && !this._revealedBy.size) {
      this._samples.clear();
      return;
    }
    for (const ev of Array.isArray(this.engine?.tickEvents) ? this.engine.tickEvents : []) {
      if (ev?.kind === 'projectileExplode') this._blast(ev);
    }
    const getBlock = this.engine?.world ? (x, y, z) => this.engine.world.getBlock(x, y, z) : null;
    for (const beacon of [...this.beacons.values()]) {
      const owner = this._entity(beacon.ownerId);
      if (!owner || this._teamOf(owner) !== beacon.team) { this.remove(beacon, 'removed'); continue; }
      // A beacon whose floor voxel was blown away falls with it.
      if (getBlock && beacon.mount && getBlock(...beacon.mount) === AIR) { this.remove(beacon, 'destroyed'); continue; }
      if (beacon.spottedBy && !(beacon.spottedUntil > now)) beacon.spottedBy = null;
    }
    for (const sensor of [...this.sensors.values()]) {
      const owner = this._entity(sensor.ownerId);
      if (!owner || this._teamOf(owner) !== sensor.team) this.remove(sensor, 'removed');
      else if (!(sensor.until > now)) this.remove(sensor, 'expired');
    }
    if (now >= this._nextScanAt) this._scan(now);
    for (const team of Object.values(this.sensed)) for (const [id, until] of team) if (!(until > now)) team.delete(id);
    for (const [id, mark] of this._revealedBy) if (!(mark.until > now)) this._revealedBy.delete(id);
  }

  /**
   * Motion scan: every scanMs each sensor reveals the enemies within reach
   * moving faster than minSpeed (flat speed between two scans; not prone).
   */
  _scan(now) {
    const r = RECON_GADGET_RULES.sensor;
    this._nextScanAt = now + r.scanMs;
    const speeds = new Map();
    for (const p of this.engine?.entities?.values?.() ?? []) {
      if (!p || p.npcRole || p.state !== 'alive' || ![p.x, p.z].every(Number.isFinite)) { this._samples.delete(idOf(p)); continue; }
      const id = idOf(p);
      const last = this._samples.get(id);
      if (last && now > last.at) {
        const speed = Math.hypot(p.x - last.x, p.z - last.z) / ((now - last.at) / 1000);
        if (speed < TELEPORT_SPEED) speeds.set(id, speed);
      }
      this._samples.set(id, { x: p.x, z: p.z, at: now });
    }
    if (!this.sensors.size) return;
    for (const p of this.engine?.entities?.values?.() ?? []) {
      const speed = speeds.get(idOf(p));
      if (speed === undefined) continue;
      const team = this._teamOf(p);
      for (const sensor of this.sensors.values()) {
        if (!team || sensor.team === team || !sensorDetects(sensor, p, speed)) continue;
        this.sensed[sensor.team]?.set(idOf(p), now + r.revealMs);
        // Who revealed it, for the assist on a kill.
        this._revealedBy.set(idOf(p), { team: sensor.team, ownerId: sensor.ownerId, until: now + r.revealMs });
      }
    }
  }

  /** True while `team`'s sensors reveal `entity`. */
  isSensed(entity, team) {
    const until = this.sensed[team]?.get(idOf(entity));
    return Number.isFinite(until) && until > this.now;
  }

  /**
   * Kill hook: an enemy a sensor revealed, killed by a teammate of the
   * sensor's owner, pays the owner a `spot_assist` (unless the spot mark
   * already paid one). The reveal ends with the life.
   */
  onDeath(victim, killer, alreadyPaid = false) {
    const mark = this._revealedBy.get(idOf(victim));
    this._revealedBy.delete(idOf(victim));
    for (const team of Object.values(this.sensed)) team.delete(idOf(victim));
    if (alreadyPaid || !mark || !(mark.until > this.now) || !killer) return false;
    const killerId = idOf(killer);
    if (!killerId || killerId === mark.ownerId) return false;
    const killerEntity = typeof killer === 'object' ? killer : this._entity(killerId);
    if (this._teamOf(killerEntity) !== mark.team || !this._entity(mark.ownerId)) return false;
    this.policy?.award?.(mark.ownerId, 'spot_assist');
    return true;
  }

  // --- spotting -----------------------------------------------------------------

  /** Enemy beacons a spotter of `team` may mark (ConquestSpotting candidates). */
  *spottable(team) {
    for (const beacon of this.beacons.values()) if (beacon.team !== team) yield beacon;
  }

  markSpotted(beacon, team, until) {
    if (!this.beacons.has(beacon?.id) || !Number.isFinite(until)) return false;
    beacon.spottedUntil = beacon.spottedBy === team ? Math.max(until, beacon.spottedUntil) : until;
    beacon.spottedBy = team;
    return true;
  }

  // --- deploy -----------------------------------------------------------------

  /** Rows for the shared deployOptions view. */
  deployRows(now = this.now) {
    return [...this.beacons.values()].map(b => ({ id: b.id, ownerId: b.ownerId, team: b.team, x: b.x, y: b.y, z: b.z,
      cooldownMs: Math.max(0, b.readyAt - now) }));
  }

  /** A free standing cell beside a beacon for `entity` (the squad spawn probe), or null. */
  spawnCell(beacon, entity) {
    const r = RECON_GADGET_RULES.beacon;
    const selector = this.policy?.spawnSelector;
    const anchor = { x: beacon.x, y: beacon.y, z: beacon.z, yaw: 0 };
    if (!selector) return { x: beacon.x + r.spawnMinRadius, y: beacon.y, z: beacon.z, index: -1 };
    return selector.probeSquadCell(anchor, { player: entity, minRadius: r.spawnMinRadius, maxRadius: r.spawnMaxRadius });
  }

  /** Someone spawned on `beacon`: its cooldown starts and the owner is paid when it was a squad mate. */
  onSpawn(beacon, entity) {
    if (!this.beacons.has(beacon?.id)) return;
    beacon.readyAt = this.now + RECON_GADGET_RULES.beacon.spawnCooldownMs;
    if (String(entity?.id) !== beacon.ownerId && this._entity(beacon.ownerId)) this.policy?.award?.(beacon.ownerId, 'beacon_spawn');
  }

  // --- snapshot ---------------------------------------------------------------

  /** `match.conquest.recon` (shared/recon-gadgets.js encodeReconGadgets), or null while empty. */
  snapshot(now = this.now) {
    return encodeReconGadgets({
      beacons: [...this.beacons.values()].map(b => ({ ...b, cooldownMs: Math.max(0, b.readyAt - now),
        spottedBy: b.spottedUntil > now ? b.spottedBy : null })),
      sensors: [...this.sensors.values()].map(s => ({ ...s, leftMs: Math.max(0, s.until - now) })),
      sensed: { alpha: [...this.sensed.alpha.keys()], bravo: [...this.sensed.bravo.keys()] },
    });
  }
}
