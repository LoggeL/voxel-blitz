import { CONQUEST_TEAMS } from '../../../shared/conquest-contract.js';
import { isConquestAircraft } from '../../../shared/conquest.js';

/** Weapon key of a death by the restricted-zone or out-of-bounds timer. */
export const RESTRICTED_WEAPON = 'restricted';

const finiteArea = area => area && ['minX', 'maxX', 'minZ', 'maxZ'].every(k => Number.isFinite(area[k]))
  ? { minX: area.minX, maxX: area.maxX, minZ: area.minZ, maxZ: area.maxZ } : null;

/**
 * HQ restricted zones and the combat area. An enemy inside an HQ radius, or
 * anyone outside the combat area, runs a timer; when it expires the player
 * dies with the `restricted` weapon key. Infantry and ground-vehicle crew are
 * timed against the combat area. Aircraft crew ignore the HQs and the combat
 * area; on a map with an airspace apron (shared/world/airspace.js) they run
 * the same timer outside the combat airspace (`airArea`, the map grown by
 * its `combat` gap), and its expiry destroys the aircraft. Without an apron
 * the map-edge flight guidance bounds aircraft instead. A player who keeps
 * crossing from one zone into the other keeps the earlier deadline.
 */
export class BoundsSystem {
  constructor(rules) {
    this.rules = rules;
    this.reset(null);
  }

  reset(metaConquest, { airArea = null } = {}) {
    this.combatArea = finiteArea(metaConquest?.combatArea);
    this.airArea = finiteArea(airArea);
    this.hqs = CONQUEST_TEAMS.flatMap(team => {
      const base = metaConquest?.bases?.[team];
      return base && Number.isFinite(base.x) && Number.isFinite(base.z) && base.radius > 0
        ? [{ team, x: base.x, z: base.z, radius: base.radius }] : [];
    });
    this.timers = new Map();
  }

  /** Zone the player is breaking right now: 'hq', 'oob', 'air' (aircraft crew) or null. */
  violation(p, team, aircraft = false) {
    if (aircraft) {
      const area = this.airArea;
      return area && (p.x < area.minX || p.x > area.maxX || p.z < area.minZ || p.z > area.maxZ) ? 'air' : null;
    }
    if (this.hqs.some(hq => hq.team !== team && Math.hypot(p.x - hq.x, p.z - hq.z) <= hq.radius)) return 'hq';
    const area = this.combatArea;
    if (area && (p.x < area.minX || p.x > area.maxX || p.z < area.minZ || p.z > area.maxZ)) return 'oob';
    return null;
  }

  /**
   * Advance timers; `kill(entity, aircraft)` is called for every expired
   * player, with the aircraft hull for crew whose 'air' timer ran out (once
   * per hull and step: the hull's loss takes its whole crew).
   */
  step(now, entities, { teamFor, vehicleFor = () => null, kill }) {
    const seen = new Set(), lost = new Set();
    for (const p of entities) {
      const id = String(p.id);
      if (p.state !== 'alive' || p.npcRole) continue;
      const team = teamFor(p);
      if (!team || ![p.x, p.z].every(Number.isFinite)) continue;
      const hull = p.vehicleId ? vehicleFor(p.vehicleId) : null;
      const aircraft = !!hull && isConquestAircraft(hull.type);
      const kind = this.violation(p, team, aircraft);
      if (!kind) continue;
      seen.add(id);
      let timer = this.timers.get(id);
      if (!timer) {
        timer = { kind, endsAt: now + (kind === 'hq' ? this.rules.hqRestrictedMs : this.rules.outOfBoundsMs) };
        this.timers.set(id, timer);
      }
      if (now >= timer.endsAt) {
        this.timers.delete(id);
        seen.delete(id);
        if (!aircraft) kill(p, null);
        else if (!lost.has(hull)) { lost.add(hull); kill(p, hull); }
      }
    }
    for (const id of [...this.timers.keys()]) if (!seen.has(id)) this.timers.delete(id);
  }

  restrictedMs(playerId, now) {
    const timer = this.timers.get(String(playerId));
    return timer ? Math.max(0, timer.endsAt - now) : 0;
  }

  clear(playerId) { this.timers.delete(String(playerId)); }

  rename(priorId, nextId) {
    const timer = this.timers.get(String(priorId));
    if (!timer) return;
    this.timers.delete(String(priorId));
    this.timers.set(String(nextId), timer);
  }
}
