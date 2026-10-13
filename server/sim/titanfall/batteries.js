/**
 * Dropped titan batteries (docs/titanfall.md §5.2 Batteries). WP0 ships a basic
 * working list; WP2 owns pickup rules and the carrier lifecycle. A carrier has
 * `p.tfBattery === true` (one each). A carrier who dies drops the battery as
 * a pickup on the ground below (lifeMs, at most `max`, oldest removed first);
 * TitanSystem.step picks pickups up for living pilots within pickupRadius.
 *
 * Map battery caches (mapMeta.batteryCaches, Ashfall §14): each cache holds one
 * pickup that never expires and is never evicted by the cap; after it is taken
 * the cache refills BATTERY_CACHE_MS later.
 */
import { TITAN_RULES } from '../../../shared/vehicle-handling/titan.js';
import { PHYSICS } from '../../../shared/player-movement.js';
import { isSolidBlock } from '../../../shared/worlddata.js';
import { BATTERY_CACHE_MS } from '../../../shared/world/ashfall-layout.js';

const tenths = n => Math.round(n * 10);
/** Metres a dropped battery may fall onto the ground below its drop point. */
const DROP_PROBE = 48;

export class TitanBatteries {
  constructor(titans) { this.titans = titans; this.list = []; this.nextId = 0; this.caches = []; }
  reset() {
    this.list.length = 0; this.nextId = 0;
    const authored = this.titans.engine?.mapMeta?.batteryCaches;
    this.caches = (Array.isArray(authored) ? authored : [])
      .filter(c => [c?.x, c?.y, c?.z].every(Number.isFinite))
      .map((c, i) => ({ index: i, x: c.x, y: c.y, z: c.z, readyAt: 0, item: null }));
  }
  /** Refill every empty cache whose timer ran out. */
  refill(now) {
    for (const c of this.caches) {
      if (c.item || c.readyAt > now) continue;
      c.item = { id: `B${++this.nextId}`, x: c.x, y: c.y, z: c.z, expiresAt: Infinity, cache: c.index };
      this.list.push(c.item);
    }
  }
  /** A carrier died: the battery becomes a pickup (oldest removed beyond the cap). */
  drop(x, y, z, now) {
    if (![x, y, z].every(Number.isFinite)) return null;
    y = this.groundBelow(x, y, z);
    const item = { id: `B${++this.nextId}`, x, y, z, expiresAt: now + TITAN_RULES.battery.lifeMs };
    this.list.push(item);
    let loose = this.list.filter(b => b.cache === undefined).length;
    for (let i = 0; loose > TITAN_RULES.battery.max && i < this.list.length;) {
      if (this.list[i].cache === undefined) { this.list.splice(i, 1); loose--; } else i++;
    }
    this.titans.emit('battery_drop', { id: item.id, x: tenths(x) / 10, y: tenths(y) / 10, z: tenths(z) / 10 });
    return item;
  }
  /** Ground under a drop point (a rider killed on a titan's back drops onto the floor), or the point itself. */
  groundBelow(x, y, z) {
    const world = this.titans.engine?.world;
    if (!world?.getBlock) return y;
    const bx = Math.floor(x), bz = Math.floor(z);
    for (let by = Math.floor(y + 0.5); by >= Math.max(0, Math.floor(y - DROP_PROBE)); by--) {
      if (isSolidBlock(world.getBlock(bx, by, bz))) return Math.min(y, by + 1);
    }
    return y;
  }
  /** Distance from a pickup to a standing body (its feet-to-head segment). */
  reach(b, p) {
    const dy = b.y < p.y ? p.y - b.y : b.y > p.y + PHYSICS.height ? b.y - p.y - PHYSICS.height : 0;
    return Math.hypot(b.x - p.x, dy, b.z - p.z);
  }
  /** Nearest pickup within reach of a living pilot without a battery (not seated, not riding). */
  pickup(p) {
    if (!p || p.state !== 'alive' || p.tfBattery || p.vehicleId || p.rodeoVehicleId || !this.list.length) return false;
    const r = TITAN_RULES.battery.pickupRadius;
    let index = -1, best = r;
    for (let i = 0; i < this.list.length; i++) {
      const d = this.reach(this.list[i], p);
      if (d <= best) { best = d; index = i; }
    }
    if (index < 0) return false;
    const [item] = this.list.splice(index, 1);
    if (item.cache !== undefined) {
      const cache = this.caches[item.cache];
      if (cache) { cache.item = null; cache.readyAt = this.titans.now + BATTERY_CACHE_MS; }
    }
    p.tfBattery = true;
    this.titans.emit('battery_pickup', { id: String(p.id), x: item.x, y: item.y, z: item.z });
    return true;
  }
  step(now) {
    if (this.caches.length) this.refill(now);
    for (let i = this.list.length - 1; i >= 0; i--) if (this.list[i].expiresAt <= now) this.list.splice(i, 1);
  }
  /** `match.titanfall.bat`: [[id, x, y, z]] with coordinates in tenths. */
  rows() { return this.list.map(b => [b.id, tenths(b.x), tenths(b.y), tenths(b.z)]); }
}
