// The framework fixture event live on a battlefield (docs/conquest.md "Map
// events"): `VB_CONQUEST_EVENTS=fixture` runs shared/map-events/fixture.js at
// the map's C flag with this controller, so a real server, its bots and the
// HUD captures exercise the whole framework before any event is registered.
// A plant (hold 3 s) arms a 20 s fuse, the rival team defuses it, the pylon
// also goes down to three rockets; the strike opens a crush zone and 10 s of
// burning ground, credited to the planter. Never on by default.
import { liveFixtureDefs } from '../../../../shared/map-events/fixture.js';
import { MapEventController } from './controller.js';

export { liveFixtureDefs };

/** Fixture timings (ms) and hazards. */
export const FIXTURE_EVENT_RULES = Object.freeze({ fuseMs: 20000, crushR: 5, fireR: 8, fireDps: 12, fireMs: 10000 });

export class FixtureController extends MapEventController {
  onUse(point, entity, team) {
    const event = this.event;
    if (event.phase === 'idle') {
      event.arm({ team, by: entity?.id, ms: FIXTURE_EVENT_RULES.fuseMs, reason: 'planted' });
      this.system.award(entity?.id, 'use');
    } else if (event.phase === 'armed' && !event.queued && team !== event.team) {
      event.cancel({ reason: 'defused' });
      this.system.award(entity?.id, 'defuse');
    }
  }

  onTarget(_target, hit) {
    if (hit.destroyed) this.event.trigger({ team: hit.team, by: hit.by, reason: 'destroyed' });
  }

  onPhase(phase) {
    if (phase === 'warning' && this.event.by) this.system.award(this.event.by, 'trigger');
    if (phase !== 'active') return;
    const a = this.system.anchorOf(this.event), now = this.system.now, by = this.event.by;
    this.system.hazards.add(this.event, { kind: 'crush', shape: 'circle', x: a.x, z: a.z, r: FIXTURE_EVENT_RULES.crushR, by });
    this.system.hazards.add(this.event, { kind: 'fire', shape: 'circle', x: a.x, z: a.z, r: FIXTURE_EVENT_RULES.fireR, by,
      dps: FIXTURE_EVENT_RULES.fireDps, hullDps: 20, until: now + FIXTURE_EVENT_RULES.fireMs });
  }

  wireExtra() { const t = this.target('pylon'); return t ? [Math.round(this.system.targets.share(t) * 100)] : null; }

  botTasks(team) {
    const event = this.event;
    if (event.phase === 'idle') return [this.useTask('charge', team, { priority: 2 })].filter(Boolean);
    if (event.phase !== 'armed' || event.queued) return [];
    const anchor = this.system.anchorOf(event);
    if (team === event.team) return [this.areaTask('guard', anchor, { kind: 'hold', radius: 8, priority: 2, squad: 2 })];
    return [this.useTask('charge', team, { priority: 3, squad: 1 }), this.areaTask('assault', anchor, { kind: 'attack', radius: 6, priority: 2, squad: 2 })].filter(Boolean);
  }
}
