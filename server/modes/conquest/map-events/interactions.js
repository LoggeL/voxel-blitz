// Hold-to-use interaction points of the Conquest map events (docs/conquest.md
// "Map events"): plant and defuse charges, a sluice wheel, a detonator, a
// relay hold, a crate claim. The plumbing is the Medic revive's: the client
// re-sends `{support: {type: 'use', targetId: '<event>:<point>'}}` at 5 Hz
// while Interact is held (public/js/ui/conquest/interact.js), bots send the
// same intent from a goal's `support` (server/bots.js), and the hold advances
// only while the newest intent is fresh.
//
// One user at a time per point and one point per user. A hold resets when the
// user leaves the radius (plus `exitPad`), takes damage, dies, goes down or
// takes a seat, or stops sending. A completed hold calls the controller's
// onUse; the point's progress and the user's team ride `match.conquest.evp`,
// the user's own progress `cq[6]`.
import { MAP_EVENT_RULES, encodeMapEventPoint, mapEventPointKey } from '../../../../shared/conquest-map-events.js';

const TEAMS = ['alpha', 'bravo'];

export class InteractionPoints {
  constructor(system, rules = MAP_EVENT_RULES.interaction) {
    this.system = system;
    this.rules = rules;
    this.reset();
  }

  reset() {
    this.points = new Map();   // key -> point
    this.byUser = new Map();   // entity id -> key
  }

  /**
   * Register a point of `instance` (the definition's points are added at
   * reset; events add runtime ones, such as a landed crate). `spec`: id, x,
   * y, z, radius, holdMs, teams ('any' | 'alpha' | 'bravo' | 'trigger' |
   * 'rival' | 'none' or a team array), verb, glyph, enabled. Returns the point.
   */
  add(instance, spec) {
    const defIndex = instance.def.points.findIndex(p => p.id === spec.id);
    const base = defIndex >= 0 ? instance.def.points[defIndex] : null;
    const index = defIndex >= 0 ? defIndex : instance.def.points.length + this._dynamicCount(instance);
    const point = {
      key: mapEventPointKey(instance.id, index), instance, index, id: spec.id ?? `p${index}`, dynamic: !base,
      x: spec.x ?? base?.x, y: spec.y ?? base?.y ?? 0, z: spec.z ?? base?.z,
      radius: spec.radius ?? base?.radius ?? 2, holdMs: spec.holdMs ?? base?.holdMs ?? 4000,
      verb: spec.verb ?? base?.verb ?? 'USE', glyph: spec.glyph ?? base?.glyph ?? null,
      teamRule: spec.teams ?? base?.teams ?? 'any', teams: new Set(), enabled: spec.enabled ?? base?.enabled ?? true,
      user: null, userTeam: null, progress: 0, lastIntentAt: -Infinity, damageRef: null, hp: 0,
    };
    this.points.set(point.key, point);
    this.refreshTeams(point);
    return point;
  }

  _dynamicCount(instance) {
    let n = 0;
    for (const p of this.points.values()) if (p.instance === instance && p.dynamic) n++;
    return n;
  }

  /** The point of `instance` named `id` (or index), or null. */
  get(instance, id) {
    for (const p of this.points.values()) if (p.instance === instance && (p.id === id || p.index === id)) return p;
    return null;
  }

  /** All points of `instance`. */
  of(instance) { return [...this.points.values()].filter(p => p.instance === instance); }

  remove(instance, id) {
    const p = this.get(instance, id);
    if (!p) return false;
    this._drop(p);
    this.points.delete(p.key);
    return true;
  }

  /** Enable or disable a point; `teams` (optional) changes who may use it. A disabled point drops its hold. */
  enable(instance, id, enabled = true, { teams } = {}) {
    const p = this.get(instance, id);
    if (!p) return null;
    p.enabled = !!enabled;
    if (teams !== undefined) p.teamRule = teams;
    this.refreshTeams(p);
    if (!p.enabled) this._drop(p);
    return p;
  }

  /** Resolve the point's team rule against the event's trigger team. */
  refreshTeams(p) {
    const rule = p.teamRule, team = p.instance.team;
    let teams;
    if (Array.isArray(rule)) teams = rule.filter(t => TEAMS.includes(t));
    else if (rule === 'any') teams = TEAMS;
    else if (rule === 'alpha' || rule === 'bravo') teams = [rule];
    else if (rule === 'trigger') teams = team ? [team] : [];
    else if (rule === 'rival') teams = team ? TEAMS.filter(t => t !== team) : [];
    else teams = [];
    p.teams = new Set(teams);
    if (p.userTeam && !p.teams.has(p.userTeam)) this._drop(p);
  }

  /** Why `entity` cannot hold point `p` now, or null. */
  refusal(entity, p, policy = this.system.policy) {
    if (!p || !p.enabled) return 'point';
    if (!entity || entity.state !== 'alive' || entity.vehicleId || entity.chute > 0) return 'actor';
    if (policy?.roles?.isDown?.(entity) === true) return 'actor';
    const team = policy?.teamFor?.(entity);
    if (!p.teams.has(team)) return 'team';
    if (p.user && p.user !== String(entity.id) && this._userValid(p)) return 'busy';
    if (!this.inReach(entity, p, 0)) return 'range';
    return null;
  }

  inReach(entity, p, pad = this.rules.exitPad) {
    return Math.hypot(entity.x - p.x, entity.z - p.z) <= p.radius + pad && Math.abs(entity.y - p.y) <= this.rules.dy + pad;
  }

  /** A `use` support intent: start or refresh the entity's hold on the point `key`. Returns true when accepted. */
  intent(entity, key) {
    const p = this.points.get(String(key));
    if (this.refusal(entity, p)) return false;
    const id = String(entity.id), now = this.system.now;
    const held = this.byUser.get(id);
    if (held && held !== p.key) this._drop(this.points.get(held));
    if (p.user !== id) {
      this._drop(p);
      p.user = id; p.userTeam = this.system.policy?.teamFor?.(entity) ?? null; p.progress = 0;
      p.damageRef = entity.lastDamage ?? null; p.hp = entity.hp;
      this.byUser.set(id, p.key);
    }
    p.lastIntentAt = now;
    if (!(p.holdMs > 0)) this._complete(p, entity);
    return true;
  }

  /** The user's hold is still valid (alive, in reach, unhurt, fresh intent). */
  _userValid(p) {
    const entity = this.system.entity(p.user);
    if (!entity || entity.state !== 'alive' || entity.vehicleId || !this.inReach(entity, p)) return false;
    if (this.system.policy?.roles?.isDown?.(entity) === true) return false;
    if (this.rules.damageResets && ((entity.lastDamage && entity.lastDamage !== p.damageRef && entity.lastDamage.cancelled !== true)
      || (Number.isFinite(entity.hp) && entity.hp < p.hp))) return false;
    return this.system.now - p.lastIntentAt <= this.rules.staleMs;
  }

  _drop(p) {
    if (!p || !p.user) return;
    if (this.byUser.get(p.user) === p.key) this.byUser.delete(p.user);
    const user = p.user;
    p.user = null; p.userTeam = null; p.progress = 0; p.damageRef = null;
    p.instance.controller.onUseInterrupted?.(p, user);
  }

  _complete(p, entity) {
    const team = p.userTeam;
    if (this.byUser.get(p.user) === p.key) this.byUser.delete(p.user);
    p.user = null; p.userTeam = null; p.progress = 0; p.damageRef = null;
    p.instance.controller.onUse(p, entity, team);
  }

  /** Advance every hold by `dtMs`. */
  tick(dtMs) {
    for (const p of this.points.values()) {
      if (!p.user) continue;
      if (!p.enabled || !this._userValid(p)) { this._drop(p); continue; }
      p.progress = Math.min(1, p.progress + dtMs / p.holdMs);
      if (p.progress >= 1) this._complete(p, this.system.entity(p.user));
    }
  }

  /** 0..1 progress of the entity's hold (cq[6]), 0 when none. */
  progressOf(entity) {
    const key = entity ? this.byUser.get(String(entity.id)) : null;
    return key ? this.points.get(key)?.progress ?? 0 : 0;
  }

  /** The point the entity holds now, or null. */
  heldBy(id) { const key = this.byUser.get(String(id)); return key ? this.points.get(key) ?? null : null; }

  forget(id) {
    const key = this.byUser.get(String(id));
    if (key) this._drop(this.points.get(key));
  }

  rename(priorId, id) {
    const key = this.byUser.get(String(priorId));
    if (!key) return;
    this.byUser.delete(String(priorId));
    this.byUser.set(String(id), key);
    const p = this.points.get(key);
    if (p) p.user = String(id);
  }

  /** `match.conquest.evp` rows of the enabled points that some team may use. */
  rows() {
    const out = [];
    for (const p of this.points.values()) if (p.enabled && p.teams.size) out.push(encodeMapEventPoint(p.instance.index, p.index, p));
    return out;
  }
}
