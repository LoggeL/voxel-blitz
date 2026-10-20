// Aldric Quarry rockslide, the server half (docs/conquest.md "Map events:
// Aldric Quarry rockslide"; data in shared/map-events/quarry.js).
//
//   idle     the plunger in the site hut is a 4 s hold for either side
//   warning  5 s: the hazard zones of the slide are posted (bots run out of
//            the north half of the pit), the client sounds the siren
//   active   7 s: five staggered blasts take the charge boxes out of the north
//            face; the face above the talus profile and the hill-house
//            overhang above the bench fall through the structural system;
//            the deposit front runs south row by row (a boulder choke over
//            the haul ramp, a talus slope from the floor up to the rim), each
//            crush band hitting what it reaches; the talus is graded to its
//            profile once the chunks have landed
//   done     once per round; a rematch restores the world
//
// Every voxel change is a staged edit (block deltas: joiners get them from
// the map cache, the bots' surface graph relabels the touched columns), and
// the plan reads the live world, so cells within `clearance` of a body or a
// hull stay open: the slide never buries anyone alive inside rock.
import { AIR, isSolidBlock } from '../../../../shared/world/blocks.js';
import { quarryCellHash, quarryProfileY } from '../../../../shared/map-events/quarry.js';
import { zoneContains } from '../../../../shared/conquest-map-events.js';
import { isAircraft } from '../../../../shared/vehicles.js';
import { MapEventController } from './controller.js';

const GROUND_MATERIALS = new Set([1, 2, 3, 4, 23, 96, 97, 98, 99, 100, 101, 102]);
/** Highest y the slide ever touches (house roofs on the rim reach y47). */
const TOP_Y = 60;
const FLOOR_Y = 22;

export class QuarryController extends MapEventController {
  get slide() { return this.def.tuning.slide; }
  get site() { return this.def.tuning.site; }

  onReset() {
    this.activeAt = null;
    this.step = { blast: 0, face: false, row: 0, grade: false };
    // The pristine ground top of every talus column (the bench and floor the grade never cuts into).
    const world = this.system.engine?.world, t = this.slide.talus, p = this.slide.profile;
    this.groundTop = new Map();
    if (!world) return;
    for (let z = p.z0; z <= t.z1; z++) for (let x = t.x0; x <= t.x1; x++) {
      let top = FLOOR_Y;
      for (let y = 40; y > FLOOR_Y; y--) if (GROUND_MATERIALS.has(world.getBlock(x, y, z))) { top = y; break; }
      this.groundTop.set(x * 1024 + z, top);
    }
  }

  onUse(point, entity, team) {
    if (point.id !== 'plunger' || !this.event.idle) return;
    if (!this.event.trigger({ team, by: entity?.id ?? null })) return;
    this.system.points.enable(this.event, 'plunger', false);
    this.system.award(entity?.id, 'trigger');
  }

  onPhase(phase) {
    if (phase === 'warning') this._postHazards();
    if (phase === 'active') this.activeAt = this.system.now;
  }

  /** The slide's crush bands and knockdown, opening as the front reaches them; bots avoid them from the warning on. */
  _postHazards() {
    const s = this.slide, zone = this.def.tuning.zone, start = this.event.endsAt ?? this.system.now;
    const front = z => start + s.frontAtMs + Math.max(0, z - s.talus.z0) * s.rowMs;
    const by = this.event.by, warnFrom = this.system.now;
    // One harmless zone over the whole footprint comes first, so a bot runs out of all of it at
    // once (bot-map-events.js flees the first zone it stands in) instead of band by band.
    this.system.hazards.add(this.event, { kind: 'fire', ...zone, dps: 0, from: warnFrom, until: start + s.push.untilMs, warnFrom, by });
    for (const [z0, z1] of s.crush.bands) {
      this.system.hazards.add(this.event, { kind: 'crush', shape: 'box', x0: zone.x0, x1: zone.x1, z0, z1, y0: s.crush.y0, y1: s.crush.y1,
        from: front(z0), warnFrom, by, damage: s.crush.damage, hullFraction: s.crush.hullFraction, avoid: false });
    }
    this.system.hazards.add(this.event, { kind: 'push', ...zone, from: start + s.frontAtMs, until: start + s.push.untilMs, warnFrom, by,
      impulse: s.push.impulse, damage: s.push.damage, avoid: false });
  }

  progress() {
    if (this.event.phase === 'done') return 1;
    if (this.event.phase !== 'active' || this.activeAt == null) return 0;
    return Math.min(1, (this.system.now - this.activeAt) / Math.max(1, this.def.durations.activeMs));
  }

  onTick(now) {
    if (this.event.phase !== 'active' || this.activeAt == null) return;
    const s = this.slide, t = now - this.activeAt, st = this.step, by = this.event.by;
    while (st.blast < s.blastsMs.length && t >= s.blastsMs[st.blast]) this._blast(st.blast++);
    if (!st.face && t >= s.faceAtMs) {
      st.face = true;
      this.system.edits.enqueue({ id: 'quarry-face', instance: this.event, mode: 'fall', cells: this.planFace(), by,
        origin: [(s.face.x0 + s.face.x1) / 2, 34, s.face.z1], chunkCap: s.chunkCap });
      this.event.announce('slide');
    }
    const rows = s.talus.z1 - s.talus.z0 + 1;
    while (st.row < rows && t >= s.frontAtMs + st.row * s.rowMs) {
      const z = s.talus.z0 + st.row++;
      this.system.edits.enqueue({ id: `quarry-row-${z}`, instance: this.event, cells: this.planRow(z), by, authored: true });
    }
    if (!st.grade && t >= s.gradeAtMs) {
      st.grade = true;
      this.system.edits.enqueue({ id: 'quarry-grade', instance: this.event, cells: this.planGrade(), by, authored: true });
      this.event.announce('settled');
    }
  }

  /** Blast `i`: its charge boxes go (a staged edit), one `blast` note for the client's flash. */
  _blast(i) {
    const [x, y, z] = this.site.charges[i] ?? [];
    if (!Number.isFinite(x)) return;
    const world = this.system.engine?.world;
    const cells = [];
    for (const cy of [y, y + 1]) if (world?.getBlock(x, cy, z) === 9) cells.push(x, cy, z, AIR);
    if (cells.length) this.system.edits.enqueue({ id: `quarry-blast-${i}`, instance: this.event, cells, by: this.event.by });
    this.event.announce('blast', { i, pos: [x + 0.5, y + 0.5, z + 0.5] });
  }

  /** Bodies and ground hulls the deposit keeps clear of: [{x, y, z, r}]. */
  _bodies() {
    const out = [], c = this.slide.clearance, engine = this.system.engine;
    for (const e of engine?.combatants?.values?.() ?? []) {
      if (e.state === 'alive' && !e.vehicleId && Number.isFinite(e.x)) out.push({ x: e.x, y: e.y, z: e.z, r: 0.4 + c, h: 2 });
    }
    for (const v of engine?.vehicles?.vehicles?.values?.() ?? []) {
      if (v.hp > 0 && !(isAircraft(v.type) && !v.grounded)) out.push({ x: v.x, y: v.y - 1, z: v.z, r: 2.6 + c, h: 4 });
    }
    return out;
  }

  _clear(bodies, x, y, z) {
    for (const b of bodies) {
      if (y + 1 < b.y - 0.5 || y > b.y + b.h) continue;
      if (Math.hypot(x + 0.5 - b.x, z + 0.5 - b.z) < b.r) return false;
    }
    return true;
  }

  _rubble(x, y, z) { const r = this.slide.rubble; return r[quarryCellHash(x, y, z, r.length)]; }

  /** The `fall` cells: the face above the talus profile and every solid of the overhang box over the bench. */
  planFace(world = this.system.engine?.world) {
    const s = this.slide, out = [];
    if (!world) return out;
    for (let z = s.face.z0; z <= s.face.z1; z++) for (let x = s.face.x0; x <= s.face.x1; x++) {
      for (let y = quarryProfileY(z, s.profile) + 1; y <= TOP_Y; y++) if (isSolidBlock(world.getBlock(x, y, z))) out.push(x, y, z, AIR);
    }
    const o = s.overhang;
    for (let z = o.z0; z <= o.z1; z++) for (let x = o.x0; x <= o.x1; x++) for (let y = o.y0; y <= o.y1; y++) {
      if (isSolidBlock(world.getBlock(x, y, z))) out.push(x, y, z, AIR);
    }
    return out;
  }

  /** One deposit row: the talus up to the profile, the choke up to its jagged top; open cells only, bodies kept clear. */
  planRow(z, world = this.system.engine?.world, bodies = this._bodies()) {
    const s = this.slide, out = [];
    if (!world) return out;
    const fill = (x, top) => {
      for (let y = FLOOR_Y; y <= top; y++) {
        if (world.getBlock(x, y, z) === AIR && this._clear(bodies, x, y, z)) out.push(x, y, z, this._rubble(x, y, z));
      }
    };
    const T = quarryProfileY(z, s.profile);
    for (let x = s.talus.x0; x <= s.talus.x1; x++) fill(x, T);
    if (z >= s.choke.z0 && z <= s.choke.z1) for (let x = s.choke.x0; x <= s.choke.x1; x++) fill(x, s.choke.top + quarryCellHash(x, 0, z, 2));
    return out;
  }

  /**
   * The grade: every talus column (face rows included) ends exactly at
   * max(pristine ground, profile): fallen rubble above it clears (except the
   * `keep` blocks, the conveyor and its trestles), open cells below it fill.
   */
  planGrade(world = this.system.engine?.world, bodies = this._bodies()) {
    const s = this.slide, out = [], keep = new Set(s.keep);
    if (!world) return out;
    for (let z = s.profile.z0; z <= s.talus.z1; z++) for (let x = s.talus.x0; x <= s.talus.x1; x++) {
      const T = quarryProfileY(z, s.profile);
      const top = z < s.talus.z0 ? T : Math.max(T, this.groundTop.get(x * 1024 + z) ?? T);
      for (let y = FLOOR_Y; y <= top; y++) {
        if (world.getBlock(x, y, z) === AIR && this._clear(bodies, x, y, z)) out.push(x, y, z, this._rubble(x, y, z));
      }
      for (let y = top + 1; y <= top + s.gradeHeadroom; y++) {
        const b = world.getBlock(x, y, z);
        if (b !== AIR && isSolidBlock(b) && !keep.has(b)) out.push(x, y, z, AIR);
      }
    }
    // Landing chunks break structural blocks they hit: the choke is topped up to its full height.
    for (let z = s.choke.z0; z <= s.choke.z1; z++) for (let x = s.choke.x0; x <= s.choke.x1; x++) {
      for (let y = FLOOR_Y, top = s.choke.top + quarryCellHash(x, 0, z, 2); y <= top; y++) {
        if (world.getBlock(x, y, z) === AIR && this._clear(bodies, x, y, z)) out.push(x, y, z, this._rubble(x, y, z));
      }
    }
    return out;
  }

  /**
   * Bots (tuning.bot): set the slide off on an enemy cluster in the pit (or
   * an enemy hull on its floor) while few of the side's own stand under the
   * face; break an enemy's hold on the plunger.
   */
  botTasks(team) {
    if (!this.event.idle) return [];
    const point = this.point('plunger');
    if (!point?.enabled) return [];
    const b = this.def.tuning.bot, tasks = [];
    if (point.userTeam && point.userTeam !== team) {
      tasks.push(this.areaTask('contest', point, { kind: 'attack', radius: 4, priority: b.contestPriority, squad: b.contestSquad, range: b.contestRange }));
      return tasks;
    }
    const { enemy, own } = this.pressure(team);
    if (enemy >= b.pressure && own <= b.ownMax) {
      const task = this.useTask('plunger', team, { priority: b.priority, squad: 1, range: b.range });
      if (task) tasks.push(task);
    }
    return tasks;
  }

  /** Enemy weight (infantry 1, ground hulls `hullWeight`) and own infantry inside the slide zone grown by `margin`. */
  pressure(team) {
    const zone = this.def.tuning.zone, pit = this.def.tuning.pit, m = this.def.tuning.bot.margin;
    const policy = this.system.policy, engine = this.system.engine;
    let enemy = 0, own = 0;
    for (const e of engine?.combatants?.values?.() ?? []) {
      if (e.state !== 'alive' || e.vehicleId || !zoneContains(zone, e.x, e.y, e.z, m)) continue;
      if (policy?.teamFor?.(e) === team) own++; else enemy++;
    }
    for (const v of engine?.vehicles?.vehicles?.values?.() ?? []) {
      if (!(v.hp > 0) || isAircraft(v.type) || !v.team || v.team === team) continue;
      if (zoneContains(pit, v.x, v.y, v.z)) enemy += this.def.tuning.bot.hullWeight;
    }
    return { enemy, own };
  }
}
