// Flag supply caches, the server half (docs/conquest.md "Infantry supply" ->
// "Flag caches"; rules and the spot picker in shared/flag-cache.js). Every
// flag row carries its cache spot from the map metadata; the cache is a
// client-drawn prop, so nothing here changes the voxel world.
//
// Every FLAG_CACHE_RULES.tickMs each living on-foot soldier of the side that
// holds the flag, standing within reach of its cache, gets one magazine and
// one grenade through ConquestRoles.supply, one AT/AA round at most every
// gadgetMs and one bandage at most every bandageMs (per player). A neutral or
// enemy-held flag's cache is inert, and so is a held one while an enemy
// stands in the capture zone (flagCacheTeam). The cache cannot be destroyed;
// it goes quiet when the floor under it is gone (the Iron Bridge span or the
// dam crest after a breach).
import { isSolidBlock } from '../../../shared/world/blocks.js';
import { FLAG_CACHE_RULES, flagCacheTeam, inFlagCacheReach } from '../../../shared/flag-cache.js';

export class FlagCaches {
  constructor(policy) {
    this.policy = policy;
    this.reset();
  }

  reset() {
    this.nextAt = null;
    // Per player: when the last gadget round and the last bandage came from a cache.
    this.clocks = new Map();
  }

  /** The side `flag`'s cache serves now, or null (neutral, enemy in the zone, no cache, floor gone). */
  servingTeam(flag) {
    const team = flagCacheTeam(flag);
    return team && this.floorStands(flag.cache) ? team : null;
  }

  /** True while the voxel under the cache is solid (true without a world). */
  floorStands(cache) {
    const world = this.policy.engine?.world;
    if (typeof world?.getBlock !== 'function') return true;
    return isSolidBlock(world.getBlock(Math.floor(cache.x), Math.floor(cache.y + 0.01) - 1, Math.floor(cache.z)));
  }

  tick(now) {
    if (this.nextAt != null && now < this.nextAt) return;
    this.nextAt = now + FLAG_CACHE_RULES.tickMs;
    const policy = this.policy, roles = policy.roles;
    const served = new Set();
    for (const flag of policy.capture.flags) {
      const team = flag.cache ? this.servingTeam(flag) : null;
      if (!team) continue;
      for (const p of policy._entities.values()) {
        if (!p || p.state !== 'alive' || p.vehicleId || p.npcRole || served.has(String(p.id))) continue;
        if (policy.teamFor(p) !== team || roles.isDown?.(p) || !inFlagCacheReach(flag.cache, p)) continue;
        served.add(String(p.id));
        this._pay(p, now);
      }
    }
    for (const id of this.clocks.keys()) if (!policy._entities.has(id)) this.clocks.delete(id);
  }

  _pay(p, now) {
    const R = FLAG_CACHE_RULES;
    const id = String(p.id);
    let clock = this.clocks.get(id);
    if (!clock) this.clocks.set(id, clock = { gadgetAt: -Infinity, bandageAt: -Infinity });
    const given = this.policy.roles.supply(p, {
      mags: 1, grenades: 1,
      gadgetRound: now - clock.gadgetAt >= R.gadgetMs,
      bandages: now - clock.bandageAt >= R.bandageMs ? 1 : 0,
    });
    if (given.gadget) clock.gadgetAt = now;
    if (given.bandages) clock.bandageAt = now;
    return given;
  }
}
