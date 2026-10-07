// Per-flag tactical positions for Conquest bots, computed from real voxels.
//
// For every flag three sets are sampled on rings around it:
//  - cover nodes 10-45 m out: a crouched body is shielded from some of eight
//    threat directions (a solid voxel within 3.5 m at chest height), and the
//    standing eye can see the flag ("peek flag"). Nodes whose standing eye
//    also clears the shield in a direction are waist-high cover: duck to hide,
//    stand to shoot.
//  - overwatch nodes 60-120 m out with a clear standing line of sight to the
//    flag, preferring height (recon).
//  - armour spots 40-80 m out with a turret-height line of sight to the flag
//    (tank overwatch; drivability is checked against the hull at use time).
// Nodes on the surface graph that no walker reaches from either HQ (sealed
// ledges, pockets) are left out. Sets are built at attach and rebuilt, one
// flag at a time, when terrain near a flag changes. Claims keep two bots off
// the same node.

import { raycastVoxels } from '../shared/raycast.js';
import { FLUID_BLOCKS, isSolidBlock } from '../shared/world/blocks.js';
import { surfaceNavigation } from './bot-surface-nav.js';

export const SECTORS = 8;
export const COVER_MIN = 10, COVER_MAX = 45;
export const OVERWATCH_MIN = 60, OVERWATCH_MAX = 120;
export const ARMOR_MIN = 40, ARMOR_MAX = 80;
const SHIELD_REACH = 3.5;
const CHEST = 1.0, STAND_EYE = 1.62, TURRET_EYE = 2.6;
const REBUILD_INTERVAL_MS = 1500;
const TAU = Math.PI * 2;
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

/** Bearing convention shared with the bots: yaw = atan2(-dx, -dz). */
export const bearing = (from, to) => Math.atan2(-(to.x - from.x), -(to.z - from.z));
export const sectorOf = yaw => ((Math.round(wrap(yaw) / (TAU / SECTORS)) % SECTORS) + SECTORS) % SECTORS;
const sectorYaw = sector => wrap(sector * TAU / SECTORS);

const passable = block => !isSolidBlock(block) && !FLUID_BLOCKS.has(block);

// Sets built on a world that matches its pristine template, per template
// voxels, map metadata (HQ starts) and flag: a new room or a restored map
// copies them instead of sampling ~1000 points per flag again.
const PRISTINE_SETS = new WeakMap();

export class CoverIndex {
  constructor(game) {
    this.game = game;
    this.sets = new Map();
    this.dirty = new Set();
    this.nextRebuildAt = 0;
    this.rebuilding = null;    // { id, steps } of the flag whose sets are being rebuilt
    this.claims = new Map();   // node key -> { id, until }
    this.solidAt = (x, y, z) => isSolidBlock(game.world.getBlock(x, y, z));
  }

  /** Feet y of a dry standable surface near refY in one column, or NaN. */
  floorAt(x, z, refY) {
    const world = this.game.world, getBlock = world.getBlock;
    const nav = surfaceNavigation(world);
    let ref = refY;
    if (nav) {
      const snapped = nav.snap({ x, z, y: refY }, 1);
      if (snapped) ref = snapped.y;
      const feet = nav.floorNear(x, z, Math.round(ref), 3, 4);
      return Number.isFinite(feet) && !FLUID_BLOCKS.has(getBlock(Math.floor(x), feet, Math.floor(z))) ? feet : NaN;
    }
    const fx = Math.floor(x), fz = Math.floor(z), top = Math.round(ref) + 4;
    for (let feet = top; feet >= Math.round(ref) - 6 && feet >= 1; feet--) {
      if (isSolidBlock(getBlock(fx, feet - 1, fz)) && passable(getBlock(fx, feet, fz)) && passable(getBlock(fx, feet + 1, fz))) return feet;
    }
    return NaN;
  }

  /**
   * Surface-graph nodes a walker reaches from either HQ (union), cached per
   * graph revision, or null without a graph or HQ spawns. Nodes outside it
   * sit on ledges or pockets no route reaches: a bot sent there would stop at
   * the end of a partial route and never arrive.
   */
  reachable() {
    const steps = this.reachableSteps();
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value;
  }

  /** reachable() as a generator: one flood fill per step. */
  *reachableSteps() {
    const nav = surfaceNavigation(this.game.world);
    if (!nav) return null;
    if (this.reach?.nav === nav && this.reach.revision === nav.revision) return this.reach.seen;
    const revision = nav.revision;
    let seen = null;
    for (const base of Object.values(this.game.mapMeta?.conquest?.bases ?? {})) {
      const starts = [...(Array.isArray(base?.spawns) ? base.spawns : []), base];
      const start = starts.find(point => Number.isFinite(point?.x) && Number.isFinite(point?.z) && nav.nodeAt(point) >= 0);
      if (!start) continue;
      if (seen) yield;
      // The graph changed between steps: start over on the current revision.
      if (nav.revision !== revision) return yield* this.reachableSteps();
      const from = nav.reachableFrom(start);
      if (!seen) seen = from;
      else for (let i = 0; i < seen.length; i++) seen[i] |= from[i];
    }
    this.reach = { nav, revision, seen };
    return seen;
  }

  /** Whether a walker can reach a node point (true when reachability is unknown). */
  reachablePoint(seen, x, feet, z) {
    if (!seen) return true;
    const node = surfaceNavigation(this.game.world)?.nodeAt({ x, y: feet, z }, 1) ?? -1;
    return node >= 0 && seen[node] === 1;
  }

  ray(from, to) {
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2], d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) return false;
    return !!raycastVoxels(this.solidAt, ...from, dx / d, dy / d, dz / d, d);
  }

  /** Build every set for one flag. */
  build(flag) {
    let set = this.pristineSet(flag);
    if (!set) {
      const steps = this.buildSteps(flag);
      let next = steps.next();
      while (!next.done) next = steps.next();
      set = next.value;
      this.rememberPristine(flag, set);
    }
    this.sets.set(flag.id, set);
    return set;
  }

  /** Cache slot of a flag's sets while the world matches its template, else null. */
  pristineSlot(flag) {
    const world = this.game.world, template = world.matchesTemplate?.() ? world.templateBlocks : null;
    const meta = this.game.mapMeta;
    if (!template || !meta || typeof meta !== 'object') return null;
    if (!PRISTINE_SETS.has(template)) PRISTINE_SETS.set(template, new WeakMap());
    const byMeta = PRISTINE_SETS.get(template);
    if (!byMeta.has(meta)) byMeta.set(meta, new Map());
    return { map: byMeta.get(meta), key: `${flag.id}:${flag.x}:${flag.y}:${flag.z}:${flag.radius}` };
  }

  /** A private copy of the cached pristine sets for a flag, or null. */
  pristineSet(flag) {
    const slot = this.pristineSlot(flag), cached = slot?.map.get(slot.key);
    return cached ? structuredClone(cached) : null;
  }

  rememberPristine(flag, set) {
    const slot = this.pristineSlot(flag);
    if (slot) slot.map.set(slot.key, structuredClone(set));
  }

  /**
   * One flag's sets as a generator that yields after each sampled ring, so a
   * rebuild mid-match spreads over ticks (see refresh). Returns the set.
   */
  *buildSteps(flag) {
    let elapsed = 0, started = performance.now();
    const cover = [], overwatch = [], armor = [];
    const center = [flag.x, (flag.y ?? 0) + 1.2, flag.z];
    const reach = this.reachableSteps();
    let step = reach.next();
    while (!step.done) {
      elapsed += performance.now() - started; yield; started = performance.now();
      step = reach.next();
    }
    const seen = step.value;
    const pause = function* () { elapsed += performance.now() - started; yield; started = performance.now(); };
    for (let r = COVER_MIN; r <= COVER_MAX; r += 3) {
      yield* pause();
      const count = Math.max(16, Math.round(TAU * r / 4));
      for (let k = 0; k < count; k++) {
        const a = (k + (r % 2) * 0.5) / count * TAU;
        const x = Math.floor(flag.x + Math.cos(a) * r) + 0.5, z = Math.floor(flag.z + Math.sin(a) * r) + 0.5;
        const feet = this.floorAt(x, z, flag.y);
        if (!Number.isFinite(feet) || Math.abs(feet - flag.y) > 12 || !this.reachablePoint(seen, x, feet, z)) continue;
        let mask = 0, peekMask = 0;
        for (let s = 0; s < SECTORS; s++) {
          const yaw = sectorYaw(s), dx = -Math.sin(yaw), dz = -Math.cos(yaw);
          if (raycastVoxels(this.solidAt, x, feet + CHEST, z, dx, 0, dz, SHIELD_REACH)) {
            mask |= 1 << s;
            if (!raycastVoxels(this.solidAt, x, feet + STAND_EYE + 0.1, z, dx, 0, dz, SHIELD_REACH)) peekMask |= 1 << s;
          }
        }
        if (!mask) continue;
        const seesFlag = !this.ray([x, feet + STAND_EYE, z], center);
        if (!seesFlag && !peekMask) continue;
        cover.push({ key: `${flag.id}:c:${x},${z}`, x, y: feet + 0.02, z, dist: r, mask, peekMask, seesFlag });
      }
    }
    for (let r = OVERWATCH_MIN; r <= OVERWATCH_MAX; r += 10) {
      yield* pause();
      const count = Math.max(24, Math.round(TAU * r / 9));
      for (let k = 0; k < count; k++) {
        const a = k / count * TAU;
        const x = Math.floor(flag.x + Math.cos(a) * r) + 0.5, z = Math.floor(flag.z + Math.sin(a) * r) + 0.5;
        const feet = this.floorAt(x, z, flag.y);
        if (!Number.isFinite(feet) || !this.reachablePoint(seen, x, feet, z)) continue;
        if (this.ray([x, feet + STAND_EYE, z], center)) continue;
        overwatch.push({ key: `${flag.id}:o:${x},${z}`, x, y: feet + 0.02, z, dist: r, height: feet - flag.y });
      }
    }
    for (let r = ARMOR_MIN; r <= ARMOR_MAX; r += 8) {
      yield* pause();
      const count = Math.max(20, Math.round(TAU * r / 10));
      for (let k = 0; k < count; k++) {
        const a = k / count * TAU;
        const x = Math.floor(flag.x + Math.cos(a) * r) + 0.5, z = Math.floor(flag.z + Math.sin(a) * r) + 0.5;
        const feet = this.floorAt(x, z, flag.y);
        if (!Number.isFinite(feet) || !this.reachablePoint(seen, x, feet, z)) continue;
        if (this.ray([x, feet + TURRET_EYE, z], center)) continue;
        armor.push({ key: `${flag.id}:a:${x},${z}`, x, y: feet + 0.02, z, dist: r });
      }
    }
    return { flag: { id: flag.id, x: flag.x, y: flag.y, z: flag.z, radius: flag.radius }, cover, overwatch, armor,
      buildMs: elapsed + performance.now() - started };
  }

  /** Make sure every flag has its sets (attach time). */
  ensure(flags) {
    for (const flag of flags) if (!this.sets.has(flag.id) && Number.isFinite(flag.x) && Number.isFinite(flag.z)) this.build(flag);
  }

  /** Mark flags whose sets touch changed columns (keys x + z * sx). */
  markChanged(columns, sx) {
    if (!columns?.size) return;
    for (const set of this.sets.values()) {
      if (this.dirty.has(set.flag.id)) continue;
      for (const key of columns) {
        const x = key % sx, z = (key / sx) | 0;
        if (Math.hypot(x - set.flag.x, z - set.flag.z) <= OVERWATCH_MAX + 4) { this.dirty.add(set.flag.id); break; }
      }
    }
  }

  /** Every set may be stale (world restore): rebuild them all, one per interval. */
  markAllChanged() {
    for (const id of this.sets.keys()) this.dirty.add(id);
  }

  /**
   * Rebuild at most one dirty flag per interval. A rebuild runs one ring per
   * call (a few tenths of a millisecond per tick instead of ~10 ms at once)
   * and replaces the flag's sets when it completes; until then bots keep the
   * previous sets. A change during the rebuild marks the flag dirty again.
   */
  refresh(now) {
    if (this.rebuilding) {
      const step = this.rebuilding.steps.next();
      if (step.done) {
        if (this.sets.has(this.rebuilding.id)) this.sets.set(this.rebuilding.id, step.value);
        this.rebuilding = null;
      }
      return true;
    }
    if (!this.dirty.size || now < this.nextRebuildAt) return false;
    const id = this.dirty.values().next().value;
    this.dirty.delete(id);
    const set = this.sets.get(id);
    this.nextRebuildAt = now + REBUILD_INTERVAL_MS;
    if (!set) return true;
    // A restored (pristine) map takes the cached sets at once.
    const pristine = this.pristineSet(set.flag);
    if (pristine) { this.sets.set(id, pristine); return true; }
    this.rebuilding = { id, steps: this.buildSteps(set.flag) };
    return this.refresh(now);
  }

  claim(node, id, now, ms = 4000) { if (node) this.claims.set(node.key, { id, until: now + ms }); }
  claimedByOther(node, id, now) {
    const claim = this.claims.get(node.key);
    return !!claim && claim.id !== id && claim.until > now;
  }

  /**
   * Cover near a flag against a threat bearing (yaw from the node toward the
   * threat). Waist-high cover that also sees the flag ranks first. `maxDist`
   * and `maxDy` keep only nodes that close to the flag (a defend surge inside
   * the zone).
   */
  cover(flagId, from, threatYaw, id, now, { preferDist = 22, maxDist = Infinity, maxDy = Infinity } = {}) {
    const set = this.sets.get(flagId);
    if (!set) return null;
    const sector = sectorOf(threatYaw), bit = 1 << sector;
    const near = (1 << ((sector + 1) % SECTORS)) | (1 << ((sector + SECTORS - 1) % SECTORS));
    let best = null, bestScore = Infinity;
    for (const node of set.cover) {
      if (!(node.mask & (bit | near)) || this.claimedByOther(node, id, now)) continue;
      if (maxDist < Infinity && Math.hypot(node.x - set.flag.x, node.z - set.flag.z) > maxDist) continue;
      if (maxDy < Infinity && Math.abs(node.y - (set.flag.y ?? node.y)) > maxDy) continue;
      const score = Math.hypot(node.x - from.x, node.z - from.z) * 0.6 + Math.abs(node.dist - preferDist) * 0.5
        + (node.mask & bit ? 0 : 8) + (node.peekMask & bit ? 0 : 5) + (node.seesFlag ? 0 : 6);
      if (score < bestScore) { bestScore = score; best = node; }
    }
    return best;
  }

  /** Any cover within `radius` of a point that shields the threat bearing. */
  coverNear(point, threatYaw, id, now, radius = 25) {
    const sector = sectorOf(threatYaw), bit = 1 << sector;
    let best = null, bestScore = Infinity;
    for (const set of this.sets.values()) {
      if (Math.hypot(set.flag.x - point.x, set.flag.z - point.z) > COVER_MAX + radius) continue;
      for (const node of set.cover) {
        if (!(node.mask & bit) || this.claimedByOther(node, id, now)) continue;
        const d = Math.hypot(node.x - point.x, node.z - point.z);
        if (d > radius) continue;
        const score = d + (node.peekMask & bit ? 0 : 4);
        if (score < bestScore) { bestScore = score; best = node; }
      }
    }
    return best;
  }

  /** Recon overwatch: high ground with sight of the flag, on the friendly side. */
  overwatch(flagId, from, friendlyYaw, id, now) {
    const set = this.sets.get(flagId);
    if (!set) return null;
    let best = null, bestScore = Infinity;
    for (const node of set.overwatch) {
      if (this.claimedByOther(node, id, now)) continue;
      const side = Number.isFinite(friendlyYaw) ? Math.abs(wrap(bearing(set.flag, node) - friendlyYaw)) : 0;
      if (side > 1.4) continue;
      const score = Math.hypot(node.x - from.x, node.z - from.z) * 0.4 + side * 25 - Math.max(0, node.height) * 3
        + Math.abs(node.dist - 85) * 0.3;
      if (score < bestScore) { bestScore = score; best = node; }
    }
    return best;
  }

  /** Tank overwatch candidates on the friendly side, nearest the preferred bearing first. */
  armorSpots(flagId, friendlyYaw, limit = 6) {
    const set = this.sets.get(flagId);
    if (!set) return [];
    return set.armor
      .map(node => ({ node, off: Number.isFinite(friendlyYaw) ? Math.abs(wrap(bearing(set.flag, node) - friendlyYaw)) : 0 }))
      .filter(entry => entry.off <= 1.25)
      .sort((a, b) => a.off - b.off || Math.abs(a.node.dist - 60) - Math.abs(b.node.dist - 60))
      .slice(0, limit).map(entry => entry.node);
  }
}
