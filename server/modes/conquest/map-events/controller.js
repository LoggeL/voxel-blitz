// One Conquest map event in a match (docs/conquest.md "Map events"): the
// phase state machine every event shares (MapEventInstance) and the base
// class an event's own logic extends (MapEventController).
//
//   idle -> armed -> warning -> active -> done          (once per round)
//                                      -> cooldown -> idle  (repeat: def.repeat)
//
// `armed` is a primed event that has not started its warning yet: a fuse
// running, a plant waiting to be defused, or a trigger the director queued
// behind another big event. Phase timers come from the definition's
// `durations` unless the call passes its own; a null duration leaves the
// phase open until the controller advances it. Every change emits one
// `map_event {event, phase, reason?, ...}` and rides `match.conquest.ev`;
// `announce(note)` sends a `map_event` with `note` and no phase change.
import { MAP_EVENT_PHASE } from '../../../../shared/conquest-map-events.js';

export class MapEventInstance {
  /**
   * @param {import('./system.js').MapEventSystem} system
   * @param {object} def    frozen definition (shared/map-events/define.js)
   * @param {number} index  wire index (mapEventsFor(map) position)
   * @param {typeof MapEventController} Controller
   */
  constructor(system, def, index, Controller = MapEventController) {
    this.system = system;
    this.def = def;
    this.index = index;
    this.id = def.id;
    this.fires = 0;
    this.controller = new Controller(this);
    this.reset();
  }

  get now() { return this.system.now; }

  /** Round start and rematch: idle, nothing pending. */
  reset() {
    this.phase = 'idle';
    this.phaseAt = this.now;
    this.endsAt = null;
    this.team = null;
    this.by = null;
    this.progress = 0;
    this.anchor = null;      // a runtime anchor {x, y, z} (published on the wire), null: the definition's
    this.queued = false;     // armed only because the director holds the warning back
    this.fires = 0;
    this.data = {};
  }

  get phaseIndex() { return MAP_EVENT_PHASE[this.phase]; }
  get idle() { return this.phase === 'idle'; }
  /** Milliseconds left in the current phase, or null when it is open-ended. */
  get leftMs() { return Number.isFinite(this.endsAt) ? Math.max(0, this.endsAt - this.now) : null; }

  /**
   * Enter a phase: `ms` its length (undefined: the definition's duration for
   * it, null: open), plus the trigger `team` / `by` and an optional `reason`
   * (the HUD reads `texts['<phase>:<reason>']` first, e.g. 'idle:defused')
   * and small `data` object for the `map_event` event.
   */
  setPhase(phase, { ms, team, by, reason, data } = {}) {
    if (!(phase in MAP_EVENT_PHASE)) throw new Error(`unknown map event phase ${phase}`);
    const prev = this.phase;
    this.phase = phase;
    this.phaseAt = this.now;
    const length = ms !== undefined ? ms : this._defaultMs(phase);
    this.endsAt = Number.isFinite(length) && length >= 0 ? this.now + length : null;
    if (team !== undefined) this.team = team;
    if (by !== undefined) this.by = by == null ? null : String(by);
    if (phase === 'idle') { this.team = team ?? null; this.by = by ?? null; this.queued = false; }
    if (phase !== 'armed') this.queued = false;
    if (phase === 'idle' || phase === 'done' || phase === 'cooldown') this.system.director.release(this);
    this.system.announce(this, { reason, data });
    this.controller.onPhase(phase, prev);
    return this;
  }

  _defaultMs(phase) {
    const d = this.def.durations;
    if (phase === 'armed') return d.armedMs;
    if (phase === 'warning') return d.warningMs;
    if (phase === 'active') return d.activeMs;
    if (phase === 'cooldown') return this.def.repeat?.cooldownMs ?? null;
    return null;
  }

  /** Prime the event (a fuse, a plant): `ms` until it triggers by itself (undefined: durations.armedMs, null: open). */
  arm({ team = this.team, by = this.by, ms, reason, data } = {}) {
    return this.setPhase('armed', { ms, team, by, reason, data });
  }

  /**
   * Set the event off: the director grants the warning a slot (a big event
   * waits, `armed`, while another big one warns or peaks). A definition
   * without a warning goes straight to `active`. Returns false when the event
   * may not fire (not idle or armed, or its repeat cap is spent).
   */
  trigger({ team = this.team, by = this.by, warningMs, reason, data } = {}) {
    if (this.phase !== 'idle' && this.phase !== 'armed') return false;
    if (!this.system.director.mayFire(this)) return false;
    const warn = warningMs !== undefined ? warningMs : this.def.durations.warningMs;
    const start = this.system.director.reserve(this, warn ?? 0);
    this.team = team ?? null; this.by = by == null ? null : String(by);
    this.fires++;
    this.system.director.noteFire(this);
    this._warnMs = warn;
    if (start > this.now) {
      this.queued = true;
      this.setPhase('armed', { ms: start - this.now, team: this.team, by: this.by, reason: 'queued', data });
      this.queued = true;
      return true;
    }
    if (Number.isFinite(warn) && warn > 0) this.setPhase('warning', { ms: warn, reason, data });
    else this.setPhase('active', { reason, data });
    return true;
  }

  /** End the active phase now: done (once per round) or the cooldown (repeat). */
  finish({ reason, data } = {}) {
    if (this.phase === 'done' || this.phase === 'cooldown' || this.phase === 'idle') return false;
    const again = this.def.repeat && this.system.director.mayFire(this);
    this.setPhase(again ? 'cooldown' : 'done', { reason, data });
    return true;
  }

  /** Call the event off (charges defused, relay lost): back to idle (or the cooldown with `cooldown: true`). */
  cancel({ reason = 'cancelled', data, by, team, cooldown = false } = {}) {
    if (this.phase === 'idle') return false;
    // A cancelled fire gives its slot back (a defused charge may be planted again).
    if (this.fires > 0 && (this.phase === 'armed' || this.phase === 'warning')) this.system.director.refund(this);
    if (cooldown) this.setPhase('cooldown', { reason, data, by, team });
    else this.setPhase('idle', { reason, data, by: by ?? null, team: team ?? null });
    return true;
  }

  /** A note on the current phase (one `map_event` with `note`; no state change): 'hit', 'planted', ... */
  announce(note, data) { this.system.announce(this, { note, data }); }

  /** Phase timer: called once per tick; an expired timer advances the phase (the controller may take it over). */
  step(now) {
    if (!Number.isFinite(this.endsAt) || now < this.endsAt) return;
    const phase = this.phase;
    this.endsAt = null;
    if (this.controller.onTimer(phase) === true) return;
    if (phase === 'armed') {
      if (this.queued) {
        this.queued = false;
        if (Number.isFinite(this._warnMs) && this._warnMs > 0) this.setPhase('warning', { ms: this._warnMs });
        else this.setPhase('active');
      } else {
        // A fuse ran out: the event goes off (through the director).
        this.trigger({ team: this.team, by: this.by });
      }
    } else if (phase === 'warning') this.setPhase('active');
    else if (phase === 'active') this.finish();
    else if (phase === 'cooldown') this.setPhase('idle');
  }

  /** `match.conquest.ev` state, or null while plainly idle. */
  wireState() {
    const progress = this.controller.progress();
    if (this.phase === 'idle' && !(progress > 0) && !this.anchor) return null;
    return { phase: this.phase, progress, team: this.team, leftMs: this.leftMs, anchor: this.anchor, extra: this.controller.wireExtra() };
  }
}

/**
 * Base class of an event's own server logic. Override what the event needs;
 * every hook is optional. `this.event` is the MapEventInstance (phase,
 * team, by, progress, anchor, data), `this.system` the MapEventSystem with
 * its helpers (points, targets, edits, hazards, director), `this.def` the
 * frozen definition.
 */
export class MapEventController {
  constructor(event) {
    this.event = event;
    this.system = event.system;
    this.def = event.def;
  }

  /** Round start and rematch (after the world restore): register dynamic points, targets, state. */
  onReset() {}
  /** Every live tick (after the phase timers). */
  onTick(_now, _dt) {}
  /** After a phase change (the `map_event` is already out). */
  onPhase(_phase, _prev) {}
  /** A phase timer ran out; return true to take the transition over (default: advance). */
  onTimer(_phase) { return false; }
  /** An interaction point's hold completed by `entity` of `team`. */
  onUse(_point, _entity, _team) {}
  /** A `use` intent `<eventId>:<rest>` that names no point of the event (a designation); return true when accepted. */
  onIntent(_entity, _rest) { return false; }
  /** An integrity target took `damage` (share 0..1) from `by`; `destroyed` once it reached 0. */
  onTarget(_target, _hit) {}
  /** The 0..100 gauge on the wire (`ev[i][2]`) as a 0..1 share. */
  progress() { return this.event.progress; }
  /** Up to MAP_EVENT_RULES.wire.extraMax small integers for `ev[i][5]` (a gauge per tank, a water level), or null. */
  wireExtra() { return null; }
  /** Bot tasks for `team` (see server/bot-map-events.js): [{id, kind, point, pointKey?, radius, priority, squad, range?}]. */
  botTasks(_team, _view) { return []; }
  /** Road crossing ids (mapMeta.conquest.crossings) bot drivers may not use now. */
  closedCrossings() { return null; }
  /** A hold on one of the event's points broke off (moved away, hurt, died, stopped). */
  onUseInterrupted(_point, _userId) {}

  // ------------------------------------------------------------ helpers --

  /** The interaction point `id` of this event (registered at reset or added at runtime). */
  point(id) { return this.system.points.get(this.event, id); }
  /** The integrity target `id` of this event. */
  target(id) { return this.system.targets.get(this.event, id); }

  /**
   * A bot task to hold the `use` intent on point `id` (plant, defuse, turn the
   * wheel, claim the crate): {priority, squad, range, ...} override the defaults.
   * Null while the point is disabled or closed to `team`.
   */
  useTask(id, team, extra = {}) {
    const p = this.point(id);
    if (!p || !p.enabled || !p.teams.has(team)) return null;
    return { id: `use:${p.id}`, kind: 'use', point: { x: p.x, y: p.y, z: p.z }, pointKey: p.key, radius: p.radius, priority: 1, squad: 1, ...extra };
  }

  /** A bot task to stand inside `radius` of a point and fight from there (`kind` 'hold'), or to close on it ('attack'). */
  areaTask(id, point, { kind = 'hold', radius = 6, priority = 1, squad = 2, ...extra } = {}) {
    return { id, kind, point: { x: point.x, y: point.y, z: point.z }, radius, priority, squad, ...extra };
  }

  /** Default hazard kill key: the definition's first `killKeys` entry ('collapse' without one). */
  get killKey() { return Object.keys(this.def.killKeys)[0] ?? 'collapse'; }
}
