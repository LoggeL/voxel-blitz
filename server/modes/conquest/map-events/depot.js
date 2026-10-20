// Hollin Fuel Depot explosion, the server half (docs/conquest.md "Hollin Fuel
// Depot"; data in shared/map-events/depot.js).
//
//   idle     three integrity targets, one per tank (blasts strongly, mounted
//            HMG / cannon fire weakly); the most damaged tank rides `ev` as the
//            gauge and each tank's share as the extras
//   trigger  the first tank to fail bursts at once and sets the event off for
//            the side that dealt the last blow (`map_event` score); the other
//            targets go inert. A director queue (another big event peaking)
//            holds the chain `armed` while the ruptured tank burns
//   warning  the chain reaction: the remaining tanks burst spread over the
//            3 s, nearest first; bots run out of the blast radius
//   active   the last tank goes; the canopy and the pipe rack come down
//            through the structural system; the burning ground stands for a
//            minute and the smoke column for the whole phase (three minutes),
//            blocking spotting and lock-on lines through it (an occluder on
//            the SmokeSystem every sight check reads)
//   done     the column is gone; the craters stay until the rematch
//
// A tank's burst: infantry within the blast radius take falloff damage and a
// shove, hulls a linear splash (credited to the trigger with kill key
// `depotBlast`, the trigger's teammates spared as at the Iron Bridge), one
// `map_event` note `burst` {tank} for the client's fireball, and a
// deterministic crater as staged block deltas (the tank, a bowl under it,
// the bund nearby, scorched earth around). Joiners get the craters through
// the map cache and the phase, gauges and time left from `ev`.
import { AIR, BEDROCK, SCORCHED_EARTH, isSolidBlock } from '../../../../shared/world/blocks.js';
import { mapEventAnchor } from '../../../../shared/conquest-map-events.js';
import { cylinderChord, depotColumnRadius } from '../../../../shared/map-events/depot.js';
import { isAircraft } from '../../../../shared/vehicles.js';
import { markLaunched } from '../../../sim/player.js';
import { MapEventController } from './controller.js';

/** SmokeSystem occluder id of the column. */
export const DEPOT_OCCLUDER = 'map-event:depot';

export class DepotController extends MapEventController {
  get T() { return this.def.tuning; }
  get engine() { return this.system.engine; }
  get anchor() { return mapEventAnchor(this.def, this.system.mapId) ?? this.def.anchor; }

  onReset() {
    this.tanks = this.T.tanks.map((t, index) => ({ ...t, index, burst: false, dueAt: null }));
    this.fires = [];
    this.chainZone = null;
    this.firstBurstAt = null;
    this._crowd = null;
    this.engine?.projectiles?.smoke?.setOccluder?.(DEPOT_OCCLUDER, null);
  }

  // ------------------------------------------------------------ trigger --

  onTarget(target, hit) {
    if (!hit.destroyed || this.event.phase !== 'idle') return;
    const tank = this.tanks.find(t => t.id === target.id);
    if (!tank || tank.burst) return;
    // The first failure: the other tanks no longer take hits, the chain decides.
    for (const t of this.system.targets.of(this.event)) t.enabled = false;
    tank.burst = true;
    if (!this.event.trigger({ team: hit.team ?? null, by: hit.by ?? null })) return;
    this.system.award(hit.by, 'trigger');
    this._burst(tank);
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
      const c = this.T.fire.canopy;
      this.fires.push(this._fireZone({ x: c.x, z: c.z, r: c.r, y0: this.tanks[0].y0 }));
      for (const zone of this.fires) zone.until = until;
      this._wreck();
      const column = this.T.column, a = this.anchor, ground = a.y - 2, event = this.event;
      this.engine?.projectiles?.smoke?.setOccluder?.(DEPOT_OCCLUDER, (from, to, at) => {
        if (event.phase !== 'active') return false;
        const r = depotColumnRadius(column, at - event.phaseAt, (event.endsAt ?? at) - at);
        return r > 0 && cylinderChord(a.x, a.z, r, ground, column.top, from, to) >= column.minChordM;
      });
    } else if (phase === 'done') {
      this.engine?.projectiles?.smoke?.setOccluder?.(DEPOT_OCCLUDER, null);
    }
  }

  onTick(now) {
    if (this.event.phase !== 'warning') return;
    for (const t of this.tanks) if (!t.burst && Number.isFinite(t.dueAt) && now >= t.dueAt) { t.burst = true; this._burst(t); }
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
    const C = this.T.crater, bund = this.T.bund, R = C.radius, reach = Math.max(R + C.scorch, C.bundReach);
    const remove = [], scorch = [];
    const onBund = (x, z) => x >= bund.x0 && x <= bund.x1 && z >= bund.z0 && z <= bund.z1
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
    return this.system.edits.enqueue({ id: `depot-crater-${tank.id}`, instance: this.event, cells, by: this.event.by });
  }

  /** The canopy and the pipe rack come down as structural chunks. */
  _wreck() {
    const world = this.engine?.world;
    if (!world) return;
    for (const b of this.T.wreck) {
      const cells = [];
      for (let y = b.y0; y <= b.y1; y++) for (let z = b.z0; z <= b.z1; z++) for (let x = b.x0; x <= b.x1; x++) {
        const block = world.getBlock(x, y, z);
        if (this.T.wreckBlocks.includes(block)) cells.push(x, y, z, AIR);
      }
      if (cells.length) this.system.edits.enqueue({ id: `depot-${b.id}`, instance: this.event, cells, mode: 'fall', by: this.event.by,
        origin: [(b.x0 + b.x1 + 1) / 2, b.y0, (b.z0 + b.z1 + 1) / 2], chunkCap: this.T.wreckChunks });
    }
  }

  _fireZone({ x, z, r, y0 }) {
    const F = this.T.fire;
    return this.system.hazards.add(this.event, { kind: 'fire', shape: 'circle', x, z, r, y0: y0 + F.band[0], y1: y0 + F.band[1],
      by: this.event.by, killKey: 'depotFire', dps: F.dps, hullDps: F.hullDps });
  }

  /** From the first failure to the last burst: an avoid-only zone over the blast radius (bots run out, nobody burns). */
  _avoidChain() {
    if (this.chainZone) return;
    const a = this.anchor;
    this.chainZone = this.system.hazards.add(this.event, { id: 'depot-chain', kind: 'fire', shape: 'circle', x: a.x, z: a.z,
      r: this.T.chainAvoidRadius, by: this.event.by, dps: 0 });
  }

  // --------------------------------------------------------------- wire --

  /** Idle: the most damaged tank's lost share (0 when untouched, so an intact depot costs no `ev` row). */
  progress() {
    if (this.event.phase !== 'idle') return 0;
    let worst = 0;
    for (const t of this.system.targets.of(this.event)) worst = Math.max(worst, 1 - this.system.targets.share(t));
    return worst;
  }

  /** Each tank's integrity % (0 once burst) until the last one goes; nothing while intact or afterwards. */
  wireExtra() {
    if (this.event.phase === 'active' || this.event.phase === 'done') return null;
    const shares = this.tanks.map(t => (t.burst ? 0 : Math.round(this.system.targets.share(this.target(t.id)) * 100)));
    return shares.some(v => v < 100) ? shares : null;
  }

  // --------------------------------------------------------------- bots --

  /** Living enemies and own soldiers of `team` within the shoot radius of the farm (cached per tick). */
  _crowdFor(team) {
    const now = this.system.now;
    if (this._crowd?.at !== now) {
      const R = this.T.bots.radius, a = this.anchor, counts = { alpha: 0, bravo: 0 };
      for (const p of this.engine?.combatants?.values?.() ?? []) {
        if (p.state !== 'alive' || Math.hypot(p.x - a.x, p.z - a.z) > R) continue;
        const t = this.system.teamOf(p);
        if (t in counts) counts[t]++;
      }
      this._crowd = { at: now, counts };
    }
    const c = this._crowd.counts, other = team === 'alpha' ? 'bravo' : 'alpha';
    return { enemies: c[other] ?? 0, own: c[team] ?? 0 };
  }

  botTasks(team) {
    if (this.event.phase !== 'idle') return [];
    const S = this.T.bots, { enemies, own } = this._crowdFor(team);
    if (enemies < S.enemies || enemies <= own) return [];
    // The weakest tank (the first in order on a tie).
    let best = null;
    for (const t of this.tanks) {
      const target = this.target(t.id);
      if (!target || !target.enabled) continue;
      const share = this.system.targets.share(target);
      if (!best || share < best.share) best = { t, share };
    }
    if (!best) return [];
    return [{ id: `shoot:${best.t.id}`, kind: 'shoot', point: { x: best.t.x, y: best.t.y0 + 4, z: best.t.z }, radius: 3,
      priority: S.priority, squad: 2, minRange: S.minRange, range: S.range, projectiles: ['rocket'], hitWithin: this.T.tankRadius + 1.5 }];
  }
}
