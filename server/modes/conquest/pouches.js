// Conquest ammo pouches from the fallen (server authority; docs/conquest.md
// "Infantry supply" -> "Ammo pouches"; rules and codec in shared/ammo-pouches.js).
// ConquestPolicy owns one instance: a death on foot drops a pouch at the body
// (ConquestRoles.diedOnFoot: the revivable body's rules), every tick a living
// on-foot soldier of either team inside the reach takes it through
// ConquestRoles.supply (one magazine). A soldier with a full reserve leaves it.
// The wire list (`match.conquest.pch`) rides only ticks where the set changed
// and a keyframe every AMMO_POUCH_RULES.keyframeMs.
import { AMMO_POUCH_RULES, encodeAmmoPouches } from '../../../shared/ammo-pouches.js';

const finite3 = p => !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

export class AmmoPouches {
  /** `policy` is the owning ConquestPolicy (clock, roles, entities, emit). */
  constructor(policy, rules = AMMO_POUCH_RULES) {
    this.policy = policy;
    this.rules = rules;
    this._nextId = 1;
    /** id -> {id, x, y, z, at, until}; insertion order is age order. */
    this.pouches = new Map();
    this._dirty = false;
    this._sentAt = -Infinity;
    this._sent = null;
  }

  get now() { return this.policy?.now ?? 0; }
  get size() { return this.pouches.size; }

  reset() {
    if (this.pouches.size) this._dirty = true;
    this.pouches.clear();
  }

  /** Death hook: a soldier killed on foot drops one pouch at the body. Returns the pouch or null. */
  onDeath(victim, context = null) {
    const roles = this.policy?.roles;
    if (!finite3(victim) || !(victim.y > 0) || !roles?.diedOnFoot?.(victim, context)) return null;
    const y = roles.bodyRestY?.(victim);
    const pouch = { id: this._nextId++, x: victim.x, y: Number.isFinite(y) ? y : victim.y, z: victim.z,
      at: this.now, until: this.now + this.rules.lifetimeMs };
    this.pouches.set(pouch.id, pouch);
    // The cap: the oldest goes first.
    while (this.pouches.size > this.rules.maxActive) this.pouches.delete(this.pouches.keys().next().value);
    this._dirty = true;
    return pouch;
  }

  /** Expire old pouches, then hand each one to the first soldier on it who gets something from it. */
  tick(now = this.now, entities = []) {
    if (!this.pouches.size) return;
    const { radius, height, grant } = this.rules;
    for (const [id, pouch] of this.pouches) {
      if (!(pouch.until > now)) { this.pouches.delete(id); this._dirty = true; continue; }
      for (const p of entities) {
        if (p?.state !== 'alive' || p.vehicleId || !finite3(p)) continue;
        if (Math.abs(p.y - pouch.y) > height || Math.hypot(p.x - pouch.x, p.z - pouch.z) > radius) continue;
        const given = this.policy.roles.supply(p, grant);
        if (!given.any) continue;
        this.pouches.delete(id);
        this._dirty = true;
        this.policy._emit?.('ammo_pouch', { id: String(p.id), pouch: id, rounds: given.reserve });
        break;
      }
    }
  }

  /** Live pouches nearest first within `reach` of `pos` (bots). */
  near(pos, reach) {
    const out = [];
    if (!finite3(pos)) return out;
    for (const pouch of this.pouches.values()) {
      const d = Math.hypot(pouch.x - pos.x, pouch.z - pos.z);
      if (d <= reach && Math.abs(pouch.y - pos.y) <= 4) out.push({ pouch, d });
    }
    return out.sort((a, b) => a.d - b.d).map(row => row.pouch);
  }

  /** The `pch` wire list on a change or keyframe tick, else null (the field stays off the snapshot). */
  snapshot(now = this.now) {
    // A second build on the same tick (a join's first frame) repeats the tick's answer.
    if (now === this._sentAt && !this._dirty) return this._sent;
    // Keyframes only while pouches lie: an empty room sends nothing after the clearing [].
    if (!this._dirty && (!this.pouches.size || now - this._sentAt < this.rules.keyframeMs)) return null;
    this._dirty = false;
    this._sentAt = now;
    return (this._sent = encodeAmmoPouches(this.pouches.values()));
  }
}
