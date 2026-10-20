// Forward service depots, the server half (docs/conquest.md "Forward service
// depots"; data in shared/map-events/depot.js). One controller per depot
// definition (`depot` east, `depot-w` west), on the map's site.
//
//   idle     the depot serves the side holding its flag (read from the
//            capture system every service tick; a neutral flag serves no
//            one): one friendly hull at a time on the forecourt gains 5 % of
//            its max HP a second to full and refills its magazines over 6 s,
//            paused while it took damage in the last 4 s. The serviced hull
//            carries the `servicing` status bit (the SERVICING vehicle card);
//            the `ev` row rides even while untouched (the map badge in the
//            owner's colour) with the pool's lost share as the gauge and [1]
//            as the extra while a hull is serviced
//   trigger  the three tanks share one integrity pool of 900; the blow that
//            empties it sets the depot off for the side that dealt it (final
//            blow 300, assists their share up to 200), and the tank nearest
//            that blast bursts at once. A director queue (another big event
//            peaking) holds the chain `armed` while the ruptured tank burns
//   warning  the chain reaction: the other two tanks burst spread over the
//            3 s, nearest first; bots run out of the blast radius
//   active   the last tank goes; the forecourt roof (and at Hollin the pipe
//            rack, at Coyote Well the windmill) comes down through the
//            structural system; the burning ground stands for a minute, the
//            adjoining road stretch burns for 45 s and the smoke column for
//            the whole phase (three minutes), blocking spotting and lock-on
//            lines through it (an occluder on the SmokeSystem)
//   done     the column is gone; the depot stays dead and the craters stay
//            until the rematch
//
// A tank's burst: infantry within the blast radius take falloff damage and a
// shove, hulls a linear splash (credited to the trigger with kill key
// `depotBlast`, the trigger's teammates spared as at the Iron Bridge), one
// `map_event` note `burst` {tank} for the client's fireball, and a
// deterministic crater as staged block deltas. Bots: drivers below 45 % drive
// to their own depot (server/bot-depot.js); the other side demolishes it only
// on evidence (`botTasks`: two of its services in two minutes).
import { AIR, BEDROCK, SCORCHED_EARTH, isSolidBlock } from '../../../../shared/world/blocks.js';
import { depotColumnRadius, cylinderChord, depotSite } from '../../../../shared/map-events/depot.js';
import { isAircraft, vehicleMaxHp } from '../../../../shared/vehicles.js';
import { mountMagazine } from '../../../sim/vehicle-upgrades.js';
import { markLaunched } from '../../../sim/player.js';
import { MapEventController } from './controller.js';

/** SmokeSystem occluder id of the east depot's column (the west one's is `map-event:depot-w`). */
export const DEPOT_OCCLUDER = 'map-event:depot';

export class DepotController extends MapEventController {
  get T() { return this.def.tuning; }
  get engine() { return this.system.engine; }
  get site() { return depotSite(this.def, this.system.mapId); }
  get anchor() { return this.site?.anchor ?? null; }
  get occluder() { return `map-event:${this.def.id}`; }

  onReset() {
    const site = this.site;
    this.tanks = (site?.tanks ?? []).map((t, index) => ({ ...t, index, burst: false, dueAt: null }));
    this.pool = site ? this.system.targets.add(this.event, { id: 'tanks', integrity: this.T.pool, supportDamage: this.T.supportDamage, minReach: 2,
      boxes: this.tanks.map(t => ({ id: t.id, ...t.box })) }) : null;
    this.fires = [];
    this.chainZone = null;
    this.firstBurstAt = null;
    // The serviced hull {id, served (ms of service), counted}, the services that counted ({at, team}: the other side's evidence).
    this.serving = null;
    this.visits = [];
    this.serviceAt = null;
    this.engine?.projectiles?.smoke?.setOccluder?.(this.occluder, null);
  }

  // ------------------------------------------------------------ service --

  /** The side the depot serves now: its flag's owner while the depot stands, else null. */
  owner() {
    if (this.event.phase !== 'idle' || !this.site) return null;
    const flag = this.system.policy?.capture?.flags?.find?.(f => f.id === this.site.flag);
    return flag?.owner === 'alpha' || flag?.owner === 'bravo' ? flag.owner : null;
  }

  /** True while a hull of `team` is on the forecourt (flat radius, height band) and of a serviced type. */
  onForecourt(v, team = v?.team) {
    const S = this.T.service, pump = this.site?.pump;
    if (!pump || !v || !(v.hp > 0) || v.padInactive || v.team !== team || !S.types.includes(v.type)) return false;
    if (Math.hypot(v.x - pump.x, v.z - pump.z) > S.radius) return false;
    const dy = v.y - pump.y;
    return S.air.includes(v.type) ? dy >= -S.groundDy && dy <= S.airAbove : Math.abs(dy) <= S.groundDy;
  }

  /** True while the hull is short of anything the depot gives: HP, a round in a magazine, its countermeasures. */
  needsService(v, now = this.system.now) {
    if (v.hp < vehicleMaxHp(v) - 0.5 || (v.cmReadyAt ?? 0) > now) return true;
    return (v.mounts ?? []).some(state => { const mag = mountMagazine(v, state); return mag > 0 && state.ammo < mag; });
  }

  /** The hull serviced now (receiving it this tick), or null. */
  servicedHull() {
    const v = this.serving?.active ? this.engine?.vehicles?.vehicles?.get?.(this.serving.id) : null;
    return v && v.hp > 0 ? v : null;
  }

  onTick(now) {
    if (this.event.phase === 'warning') {
      for (const t of this.tanks) if (!t.burst && Number.isFinite(t.dueAt) && now >= t.dueAt) { t.burst = true; this._burst(t); }
    }
    const S = this.T.service;
    if (this.serviceAt != null && now - this.serviceAt < S.tickMs) return;
    const dt = this.serviceAt == null ? S.tickMs : Math.min(1000, now - this.serviceAt);
    this.serviceAt = now;
    this._service(now, dt / 1000);
  }

  /** One service step: keep or pick the hull, then repair and rearm it unless it was hit within `quietMs`. */
  _service(now, dtS) {
    const S = this.T.service, team = this.owner(), vehicles = this.engine?.vehicles;
    if (!team || !vehicles?.vehicles) { this.serving = null; return; }
    let v = this.serving ? vehicles.vehicles.get(this.serving.id) : null;
    if (v && (!this.onForecourt(v, team) || !this.needsService(v, now))) { v = null; this.serving = null; }
    if (!v) {
      // A crewed hull first, then the most damaged one.
      let best = null;
      for (const hull of vehicles.vehicles.values()) {
        if (!this.onForecourt(hull, team) || !this.needsService(hull, now)) continue;
        const score = (vehicles.crew?.(hull)?.length ? 0 : 1) + hull.hp / Math.max(1, vehicleMaxHp(hull));
        if (!best || score < best.score) best = { hull, score };
      }
      if (!best) return;
      v = best.hull;
      this.serving = { id: v.id, served: 0, counted: false, carry: [], active: false };
    }
    const serving = this.serving;
    serving.active = now - (v.lastDamagedAt ?? -Infinity) >= S.quietMs;
    if (!serving.active) return;
    v.depotServiceUntil = now + S.tickMs * 2;
    const max = vehicleMaxHp(v);
    if (v.hp < max) vehicles.repair(v.id, max * S.hpPerSecond * dtS);
    this._rearm(v, serving, dtS, now);
    serving.served += dtS * 1000;
    if (!serving.counted && serving.served >= S.visitMs) { serving.counted = true; this.visits.push({ at: now, team }); }
  }

  /** Every mount's magazine fills over `rearmMs` (pending rearm timers drop as rounds come in); the countermeasures with the last round. */
  _rearm(v, serving, dtS, now) {
    let full = true;
    (v.mounts ?? []).forEach((state, i) => {
      const mag = mountMagazine(v, state);
      if (!(mag > 0) || state.ammo >= mag) return;
      serving.carry[i] = (serving.carry[i] ?? 0) + mag * dtS * 1000 / this.T.service.rearmMs;
      while (serving.carry[i] >= 1 && state.ammo < mag) { state.ammo++; serving.carry[i]--; state.rearm?.shift?.(); }
      if (state.ammo >= mag) { state.rearm = []; state.reloadT = 0; serving.carry[i] = 0; } else full = false;
    });
    if (full && (v.cmReadyAt ?? 0) > now) v.cmReadyAt = now;
  }

  /** Services of `team` at this depot within the last `ms`. */
  visitsBy(team, ms, now = this.system.now) { return this.visits.filter(v => v.team === team && now - v.at <= ms).length; }

  // ------------------------------------------------------------ trigger --

  onTarget(target, hit) {
    if (!hit.destroyed || target !== this.pool || this.event.phase !== 'idle') return;
    // The pool is empty: the tank nearest the last blast ruptures first, the chain decides the rest.
    target.enabled = false;
    const o = hit.origin;
    const first = Array.isArray(o) ? this.tanks.reduce((a, t) => (Math.hypot(t.x - o[0], t.z - o[2]) < Math.hypot(a.x - o[0], a.z - o[2]) ? t : a)) : this.tanks[0];
    if (!first) return;
    first.burst = true;
    this.serving = null;
    if (!this.event.trigger({ team: hit.team ?? null, by: hit.by ?? null })) return;
    this.system.payDestroyed(target, hit.by);
    this._burst(first);
  }

  onPhase(phase) {
    const now = this.system.now;
    if (phase === 'armed' || phase === 'warning') this._avoidChain();
    if (phase === 'warning') {
      // The rest go up spread over the warning, nearest to the first failure first, the last at its end.
      const first = this.tanks.find(t => t.burst) ?? this.tanks[0];
      const rest = this.tanks.filter(t => !t.burst).sort((a, b) => Math.hypot(a.x - first.x, a.z - first.z) - Math.hypot(b.x - first.x, b.z - first.z));
      const span = this.event.leftMs ?? this.def.durations.warningMs ?? 0;
      rest.forEach((t, k) => { t.dueAt = now + span * (k + 1) / rest.length; });
    } else if (phase === 'active') {
      for (const t of this.tanks) if (!t.burst) { t.burst = true; this._burst(t); }
      if (this.chainZone) { this.system.hazards.remove(this.chainZone); this.chainZone = null; }
      const until = now + this.T.fire.ms;
      const c = this.site.canopy;
      this.fires.push(this._fireZone({ x: c.x, z: c.z, r: c.r, y0: this.site.pump.y - 1 }));
      for (const zone of this.fires) zone.until = until;
      this._roadFire(now);
      this._wreck();
      const column = this.T.column, a = this.anchor, ground = a.y - 2, event = this.event;
      this.engine?.projectiles?.smoke?.setOccluder?.(this.occluder, (from, to, at) => {
        if (event.phase !== 'active') return false;
        const r = depotColumnRadius(column, at - event.phaseAt, (event.endsAt ?? at) - at);
        return r > 0 && cylinderChord(a.x, a.z, r, ground, column.top, from, to) >= column.minChordM;
      });
    } else if (phase === 'done') {
      this.engine?.projectiles?.smoke?.setOccluder?.(this.occluder, null);
    }
  }

  // ------------------------------------------------------------- bursts --

  _burst(tank) {
    this.firstBurstAt ??= this.system.now;
    this.event.announce('burst', { tank: tank.index });
    this._blast(tank);
    this._crater(tank);
    this.fires.push(this._fireZone({ x: tank.x, z: tank.z, r: this.T.fire.radius, y0: tank.y0 }));
  }

  /** A zone-like credit record for the hazard helpers (the trigger's teammates spared). */
  _credit(killKey) { return { kind: 'crush', by: this.event.by, spareTeam: true, killKey }; }

  _blast(tank) {
    const engine = this.engine, B = this.T.blast, hazards = this.system.hazards;
    if (!engine) return;
    const origin = [tank.x, tank.y0 + B.lift, tank.z];
    const credit = this._credit('depotBlast');
    for (const victim of [...(engine.combatants?.values?.() ?? [])]) {
      if (victim.state !== 'alive' || victim.vehicleId || victim.objective) continue;
      if (victim.spawnProtected || (Number.isFinite(victim.spawnProtectedUntil) && victim.spawnProtectedUntil > engine.now)) continue;
      const dx = victim.x - origin[0], dy = victim.y + 0.9 - origin[1], dz = victim.z - origin[2];
      const d = Math.hypot(dx, dy, dz);
      if (d >= B.radius || hazards.credit(credit, victim) === false) continue;
      const f = Math.pow(1 - d / B.radius, B.falloff);
      const push = B.impulse * f, inv = d > 0.01 ? 1 / d : 0;
      victim.vx = (victim.vx ?? 0) + dx * inv * push;
      victim.vy = Math.max(victim.vy ?? 0, 0) + push * 0.6;
      victim.vz = (victim.vz ?? 0) + dz * inv * push;
      markLaunched(victim);
      hazards._hurt(credit, victim, Math.round(B.damage * f * 10) / 10);
    }
    const killer = credit.by ? this.system.entity(credit.by) : null;
    const killerTeam = killer ? this.system.teamOf(killer) : null;
    for (const hull of [...(engine.vehicles?.vehicles?.values?.() ?? [])]) {
      if (!(hull.hp > 0) || (isAircraft(hull.type) && !hull.grounded)) continue;
      const d = Math.hypot(hull.x - origin[0], hull.y + 1 - origin[1], hull.z - origin[2]);
      if (d >= B.radius || (killerTeam && hull.team === killerTeam)) continue;
      engine.vehicles.damage(hull.id, B.hullDamage * (1 - d / B.radius), killer, { cls: 'explosive', point: [hull.x, hull.y + 1, hull.z] });
    }
  }

  /** The deterministic crater of one tank as one staged job: removals top down, then the scorched floor. */
  _crater(tank) {
    const world = this.engine?.world;
    if (!world) return null;
    const C = this.T.crater, bund = this.site.bund, R = C.radius, reach = Math.max(R + C.scorch, bund ? C.bundReach : 0);
    const remove = [], scorch = [];
    const onBund = (x, z) => !!bund && x >= bund.x0 && x <= bund.x1 && z >= bund.z0 && z <= bund.z1
      && (x === bund.x0 || x === bund.x1 || z === bund.z0 || z === bund.z1);
    const solid = (x, y, z) => { const b = world.getBlock(x, y, z); return isSolidBlock(b) && b !== BEDROCK; };
    for (let z = Math.floor(tank.z - reach); z <= Math.ceil(tank.z + reach); z++) {
      for (let x = Math.floor(tank.x - reach); x <= Math.ceil(tank.x + reach); x++) {
        const h = Math.hypot(x + 0.5 - tank.x, z + 0.5 - tank.z);
        // The bowl: everything from `above` down to its floor, deepest in the middle.
        let floor = null, from = tank.y0 + C.above;
        if (h <= R) {
          floor = tank.y0 - Math.round(C.depth * (1 - (h / R) ** 2));
          for (let y = from; y > floor && y > 1; y--) if (solid(x, y, z)) remove.push([x, y, z]);
        } else if (h <= C.bundReach && onBund(x, z)) {
          for (let y = tank.y0 + 3; y > tank.y0; y--) if (solid(x, y, z)) remove.push([x, y, z]);
          from = tank.y0;
        }
        if (h > R + C.scorch) continue;
        // Outside the bowl the column's top is scorched only where it is ground (a roof or a wall top is left alone).
        if (floor == null) {
          for (let y = from; y >= tank.y0 - 3; y--) if (solid(x, y, z)) { if (y <= tank.y0 + 1) floor = y; break; }
        }
        if (floor != null && floor > 1 && solid(x, floor, z)) scorch.push([x, floor, z]);
      }
    }
    // Top down, so nothing is left hanging for a tick; then the scorched floor.
    remove.sort((a, b) => b[1] - a[1]);
    const cells = new Int32Array((remove.length + scorch.length) * 4);
    let k = 0;
    for (const [x, y, z] of remove) { cells[k++] = x; cells[k++] = y; cells[k++] = z; cells[k++] = AIR; }
    for (const [x, y, z] of scorch) { cells[k++] = x; cells[k++] = y; cells[k++] = z; cells[k++] = SCORCHED_EARTH; }
    return this.system.edits.enqueue({ id: `${this.def.id}-crater-${tank.id}`, instance: this.event, cells, by: this.event.by });
  }

  /** The forecourt roof (and the site's other wreck boxes) come down as structural chunks. */
  _wreck() {
    const world = this.engine?.world;
    if (!world) return;
    for (const b of this.site.wreck) {
      const cells = [];
      for (let y = b.y0; y <= b.y1; y++) for (let z = b.z0; z <= b.z1; z++) for (let x = b.x0; x <= b.x1; x++) {
        const block = world.getBlock(x, y, z);
        if (this.T.wreckBlocks.includes(block)) cells.push(x, y, z, AIR);
      }
      if (cells.length) this.system.edits.enqueue({ id: `${this.def.id}-${b.id}`, instance: this.event, cells, mode: 'fall', by: this.event.by,
        origin: [(b.x0 + b.x1 + 1) / 2, b.y0, (b.z0 + b.z1 + 1) / 2], chunkCap: this.T.wreckChunks });
    }
  }

  _fireZone({ x, z, r, y0 }) {
    const F = this.T.fire;
    return this.system.hazards.add(this.event, { kind: 'fire', shape: 'circle', x, z, r, y0: y0 + F.band[0], y1: y0 + F.band[1],
      by: this.event.by, killKey: 'depotFire', dps: F.dps, hullDps: F.hullDps });
  }

  /** The adjoining road stretch burns from the active start: infantry and hulls take fire damage, bots keep out. */
  _roadFire(now) {
    const R = this.T.roadFire, road = this.site.road, y = this.site.pump.y;
    this.roadZone = this.system.hazards.add(this.event, { id: `${this.def.id}-road`, kind: 'fire', ...road, y0: y + R.band[0], y1: y + R.band[1],
      until: now + R.ms, by: this.event.by, killKey: 'depotFire', dps: R.dps, hullDps: R.hullDps });
  }

  /** From the first failure to the last burst: an avoid-only zone over the blast radius (bots run out, nobody burns). */
  _avoidChain() {
    if (this.chainZone) return;
    const a = this.anchor;
    this.chainZone = this.system.hazards.add(this.event, { id: `${this.def.id}-chain`, kind: 'fire', shape: 'circle', x: a.x, z: a.z,
      r: this.T.chainAvoidRadius, by: this.event.by, dps: 0 });
  }

  // --------------------------------------------------------------- wire --

  /** A standing depot rides `ev` while idle too: the HUD's map badge follows its flag's owner. */
  listed() { return this.event.phase === 'idle' && !!this.site; }

  /** Idle: the pool's lost share (the badge's arc). */
  progress() {
    if (this.event.phase !== 'idle' || !this.pool) return 0;
    return 1 - this.system.targets.share(this.pool);
  }

  /** Idle: [1] while a hull is serviced; the chain: 0 per burst tank, 100 per standing one; nothing afterwards. */
  wireExtra() {
    if (this.event.phase === 'idle') return this.servicedHull() ? [1] : null;
    if (this.event.phase === 'armed' || this.event.phase === 'warning') return this.tanks.map(t => (t.burst ? 0 : 100));
    return null;
  }

  // --------------------------------------------------------------- bots --

  /**
   * Demolition, only on evidence: while the depot serves the other side and
   * it serviced at least `evidence` hulls in `evidenceMs`, up to `squad`
   * Engineers walk in to `holdRadius` m of the tanks and fire their RX-8 at
   * any tank they see from `minRange` to `range` m. A bot never shoots its
   * own team's depot.
   */
  botTasks(team) {
    const owner = this.owner(), B = this.T.bots;
    if (!owner || owner === team || !this.pool?.enabled || this.visitsBy(owner, B.evidenceMs) < B.evidence) return [];
    const a = this.anchor;
    return [
      this.areaTask('demolish', a, { kind: 'hold', radius: B.holdRadius, priority: B.priority, squad: B.squad, kits: ['engineer'] }),
      ...this.tanks.map(t => ({ id: `shoot:${t.id}`, kind: 'shoot', point: { x: t.x, y: t.y0 + 4, z: t.z }, radius: 3, priority: B.priority,
        squad: B.squad, minRange: B.minRange, range: B.range, projectiles: ['rocket'], hitWithin: this.T.tankRadius + 1.5 })),
    ];
  }
}
