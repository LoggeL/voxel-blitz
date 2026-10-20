// Conquest map events, the server half (docs/conquest.md "Map events";
// registry, phases and wire codec in shared/conquest-map-events.js). Owned by
// ConquestPolicy: instantiates the current map's events for the variant at
// every round start and rematch, steps their phase timers, interaction
// holds, staged voxel edits and hazard zones in the live tick, routes blasts
// to the integrity targets and `use` intents to the points, and publishes
// `match.conquest.ev` / `evp` plus one `map_event` event per change.
import {
  MAP_EVENT_DEFS, MAP_EVENT_KIND, MAP_EVENT_RULES, MAP_EVENT_SCORE_REASON, encodeMapEventRow, mapEventAnchor, mapEventsFor,
} from '../../../../shared/conquest-map-events.js';
import { MapEventController, MapEventInstance } from './controller.js';
import { MapEventDirector } from './director.js';
import { InteractionPoints } from './interactions.js';
import { IntegrityTargets } from './integrity.js';
import { StagedEdits } from './staged-edits.js';
import { HazardZones } from './hazards.js';
import { MAP_EVENT_CONTROLLERS } from './registry.js';

/** `VB_CONQUEST_EVENTS`: off / false / 0 / no / none turn the map events off (tests, captures). */
export function mapEventsOptionFromEnv(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return ['off', 'false', '0', 'no', 'none'].includes(value.trim().toLowerCase()) ? false : undefined;
}

export class MapEventSystem {
  /**
   * @param {object} policy  ConquestPolicy (engine, mapMeta, variant, teamFor, award, _emit)
   * @param {object} [options]
   * @param {Array|false} [options.defs]  definitions (default: the registry); false turns events off
   * @param {object} [options.controllers]  id -> MapEventController subclass (default: the server registry)
   */
  constructor(policy, { defs = MAP_EVENT_DEFS, controllers = MAP_EVENT_CONTROLLERS, rules = MAP_EVENT_RULES } = {}) {
    this.policy = policy;
    this.enabled = defs !== false;
    this.defs = Array.isArray(defs) ? defs : MAP_EVENT_DEFS;
    this.controllers = controllers ?? {};
    this.rules = rules;
    this.director = new MapEventDirector(this, rules.director);
    this.points = new InteractionPoints(this, rules.interaction);
    this.targets = new IntegrityTargets(this);
    this.edits = new StagedEdits(this, rules.edits);
    this.hazards = new HazardZones(this, rules.hazards);
    this.instances = [];
    this.lastTickAt = null;
  }

  get engine() { return this.policy?.engine ?? null; }
  get now() { return this.policy?.now ?? this.engine?.now ?? 0; }
  get mapId() { return this.policy?.mapMeta?.id ?? null; }
  get variant() { return this.policy?.variant ?? 'conquest'; }

  /** A combatant by id (or the entity itself). */
  entity(value) {
    if (value && typeof value === 'object') return value;
    if (value == null || value === '') return null;
    return this.engine?.combatants?.get?.(String(value)) ?? this.policy?._entity?.(value) ?? null;
  }

  teamOf(value) { const e = this.entity(value); return e ? this.policy?.teamFor?.(e) ?? null : null; }

  /** The map's definitions in wire order (every variant). */
  get mapDefs() { return mapEventsFor(this.mapId, this.defs); }

  /**
   * Swap the definitions and controllers (test fixtures, captures; `defs:
   * false` turns events off) and start over as at a round start.
   */
  configure({ defs, controllers } = {}) {
    if (defs !== undefined) { this.enabled = defs !== false; this.defs = Array.isArray(defs) ? defs : MAP_EVENT_DEFS; }
    if (controllers !== undefined) this.controllers = controllers ?? {};
    this.reset();
    return this;
  }

  /** Round start and rematch (after restoreWorld): fresh instances of this map's events for the variant. */
  reset() {
    this.director.reset();
    this.points.reset();
    this.targets.reset();
    this.edits.reset();
    this.hazards.reset();
    this.instances = [];
    this.lastTickAt = this.now;
    if (!this.enabled || !this.mapId) return;
    const breakthrough = this.variant === 'breakthrough';
    this.mapDefs.forEach((def, index) => {
      if (breakthrough && !def.breakthrough) return;
      const Controller = this.controllers[def.id] ?? MapEventController;
      const instance = new MapEventInstance(this, def, index, Controller);
      this.instances.push(instance);
      for (const point of def.points) this.points.add(instance, { id: point.id });
      for (const target of def.targets) this.targets.add(instance, target);
    });
    for (const instance of this.instances) instance.controller.onReset();
  }

  /** The instance of an event id (or null when the event does not run in this match). */
  instance(id) { return this.instances.find(i => i.id === id) ?? null; }

  /** The marker point of an instance: its runtime anchor, else the definition's on this map. */
  anchorOf(instance) { return instance.anchor ?? mapEventAnchor(instance.def, this.mapId); }

  /** Live tick (ConquestPolicy.tick, after the bridge). */
  tick(now = this.now, dtMs = null) {
    if (!this.instances.length) return;
    const dt = Number.isFinite(dtMs) ? dtMs : Math.max(0, now - (this.lastTickAt ?? now));
    this.lastTickAt = now;
    for (const instance of this.instances) instance.step(now);
    this.points.tick(dt);
    for (const instance of this.instances) instance.controller.onTick(now, dt);
    this.edits.tick();
    this.hazards.tick(now, dt);
  }

  /** An explosion (ConquestPolicy.onBlast): the integrity targets take their share. */
  onBlast(origin, blast) {
    if (!this.instances.length) return [];
    return this.targets.onBlast(origin, blast);
  }

  /**
   * A `use` support intent: targetId `<event>:<point>` holds an interaction
   * point; any other `<event>:<rest>` goes to that event's controller
   * (`onIntent(entity, rest)`, e.g. a call-in's target designation).
   */
  intent(entity, targetId) {
    if (!this.instances.length) return false;
    const key = String(targetId ?? ''), split = key.indexOf(':');
    if (!this.points.points.has(key) && split > 0) {
      const instance = this.instance(key.slice(0, split));
      if (instance && typeof instance.controller.onIntent === 'function') return instance.controller.onIntent(this.entity(entity), key.slice(split + 1)) === true;
    }
    return this.points.intent(this.entity(entity), key);
  }

  /** 0..1 progress of the entity's own hold (cq[6]). */
  progressOf(entity) { return this.instances.length ? this.points.progressOf(entity) : 0; }

  /**
   * One `map_event {event, phase, team?, by?, endsAt?, reason?, note?, data?, pos?}`
   * for a phase change (`reason` optional) or a note (`note`, the phase
   * unchanged). Points re-read the event's team (trigger / rival).
   */
  announce(instance, { reason, note, data } = {}) {
    for (const point of this.points.of(instance)) this.points.refreshTeams(point);
    const fields = { event: instance.id, phase: instance.phase };
    if (instance.team) fields.team = instance.team;
    if (instance.by) fields.by = instance.by;
    if (Number.isFinite(instance.endsAt)) fields.endsAt = Math.round(instance.endsAt);
    if (reason) fields.reason = String(reason);
    if (note) fields.note = String(note);
    if (data && typeof data === 'object') fields.data = data;
    const anchor = this.anchorOf(instance);
    if (anchor) fields.pos = [Math.round(anchor.x), Math.round(anchor.y ?? 0), Math.round(anchor.z)];
    this.policy?._emit?.(MAP_EVENT_KIND, fields);
  }

  /**
   * Pay the `map_event` score to a player: `action` one of
   * MAP_EVENT_RULES.score ('trigger', 'defuse', 'use', 'assist') or a number,
   * scaling SCORE_POINTS.map_event (career XP: a major Conquest award).
   * Returns the points.
   */
  award(id, action = 'trigger') {
    if (id == null || id === '') return 0;
    const scale = typeof action === 'number' ? action : this.rules.score[action] ?? 1;
    return this.policy?.award?.(String(id), MAP_EVENT_SCORE_REASON, scale) ?? 0;
  }

  /** `{ev, evp}` for match.conquest, or null when nothing rides. */
  snapshot() {
    if (!this.instances.length) return null;
    const ev = [];
    for (const instance of this.instances) {
      const state = instance.wireState();
      if (state) ev.push(encodeMapEventRow(instance.index, state));
    }
    const evp = this.points.rows();
    if (!ev.length && !evp.length) return null;
    return { ...(ev.length ? { ev } : {}), ...(evp.length ? { evp } : {}) };
  }

  /** Bot tasks per team (BotCommander.plan), hazard zones and closed crossings (server/bot-map-events.js). */
  view() {
    const now = this.now;
    const tasks = { alpha: [], bravo: [] };
    const closed = new Set();
    for (const instance of this.instances) {
      for (const team of ['alpha', 'bravo']) {
        for (const task of instance.controller.botTasks(team, this) ?? []) {
          if (task?.point) tasks[team].push({ priority: 1, squad: 1, radius: 3, kind: 'hold', ...task, event: instance.id, id: `${instance.id}:${task.id ?? task.kind}` });
        }
      }
      for (const id of instance.controller.closedCrossings() ?? []) closed.add(id);
    }
    return { active: this.instances.length > 0, tasks, hazards: this.hazards.avoidZones(now), closed,
      events: this.instances.map(i => ({ id: i.id, phase: i.phase, team: i.team, by: i.by, anchor: this.anchorOf(i), endsAt: i.endsAt })) };
  }

  /** A player left: drop their hold. */
  remove(id) { this.points.forget(id); }
  /** A human took over a bot (ids change). */
  rename(priorId, id) { this.points.rename(priorId, id); }
}
