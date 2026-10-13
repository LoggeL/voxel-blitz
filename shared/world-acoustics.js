import * as BLOCK from './world/blocks.js';

// Presentation-only acoustic estimates. No map scan or navigation mesh: sound
// reads the same live voxels as collision, including player-made openings.
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const validPosition = p => p?.length >= 3 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]);
const coefficient = new Float32Array(256).fill(1.55);
const reflection = new Float32Array(256).fill(0.78);
function materials(names, loss, reflectivity) {
  for (const name of names) {
    const id = BLOCK[name];
    if (Number.isInteger(id)) { coefficient[id] = loss; reflection[id] = reflectivity; }
  }
}
materials(['GLASS', 'MC_GLASS'], 0.38, 0.72);
materials(['WOOD', 'PLANK', 'YELLOW_SIDING', 'TEAL_SIDING', 'DUST_CRATE', 'DUST_WOOD',
  'MC_LOG', 'MC_PLANKS', 'MC_BOOKSHELF', 'MC_CHEST', 'MC_CRAFTING', 'MC_TNT',
  'BB_HULL', 'BB_PINEAPPLE', 'BIRCH_LOG', 'TIMBER'], 0.78, 0.4);
materials(['METAL', 'RUST', 'BUS_YELLOW', 'TRUCK_RED', 'MC_IRON', 'MC_GOLD',
  'POOL_PANEL', 'BB_CHUM', 'CORRUGATED_STEEL'], 1.85, 0.92);
materials(['LEAVES', 'MC_LEAVES', 'MC_CLOUD', 'BB_PINE_LEAF', 'BB_KELP', 'PINE_LEAVES'], 0.12, 0.09);
materials(['MC_WOOL_WHITE', 'MC_WOOL_RED'], 0.58, 0.08);
materials(['GRASS', 'DIRT', 'SAND', 'MC_GRASS', 'MC_DIRT', 'MC_SAND', 'MC_GRAVEL',
  'MC_CLAY', 'BB_SAND', 'MEADOW', 'DRY_GRASS', 'FIELD_WHEAT', 'MUD', 'SCORCHED_EARTH',
  'GRAVEL', 'PINE_NEEDLES', 'BARRICADE'], 1.25, 0.2);

const PROBES = Object.freeze([
  [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
  [0.7071, 0.7071, 0], [-0.7071, 0.7071, 0], [0, 0.7071, 0.7071], [0, 0.7071, -0.7071],
]);
const OUTDOOR = Object.freeze({ enclosure: 0, room: 'outdoor', reflectivity: 0.35, span: 24 });
const OPEN = Object.freeze({ gain: 1, lowpassHz: 20000, wet: 0.015, decaySeconds: 0.18,
  preDelaySeconds: 0.01, occlusion: 0, enclosure: 0, room: 'outdoor', apparentPosition: null,
  pathLength: 0, blockedVoxels: 0, budgetLimited: false, deferred: false });

function boundedNumber(value, fallback, min, max) {
  return Number.isFinite(value) ? clamp(value, min, max) : fallback;
}
function cacheKey(position, scale) {
  return `${Math.floor(position[0] * scale)},${Math.floor(position[1] * scale)},${Math.floor(position[2] * scale)}`;
}
function remember(cache, key, value, limit) {
  if (!cache.has(key) && cache.size >= limit) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

/**
 * Bounded ray-based approximation of transmission, room reflections and sound
 * through nearby openings. Gain excludes normal source-distance attenuation.
 * Apparent position is an opening; renderers should retain pathLength when
 * placing a virtual directional source so a doorway does not amplify it.
 *
 * A world supplies getBlock(x,y,z) and preferably mutationCount. The production
 * world increments mutationCount for all replacements, not just ground-level
 * navigation changes. Wrappers without a revision must invalidate after edits.
 */
export class WorldAcoustics {
  constructor(world = null, options = {}) {
    this.limits = Object.freeze({
      maxVoxelReads: Math.floor(boundedNumber(options.maxVoxelReads, 3072, 128, 8192)),
      maxReadsPerFrame: Math.floor(boundedNumber(options.maxReadsPerFrame, 16000, 128, 65536)),
      maxCacheEntries: Math.floor(boundedNumber(options.maxCacheEntries, 256, 4, 2048)),
      probeDistance: boundedNumber(options.probeDistance, 24, 8, 48),
      maxDirectDistance: boundedNumber(options.maxDirectDistance, 1536, 32, 2048),
    });
    this._paths = new Map();
    this._rooms = new Map();
    this._pending = new Map();
    this._stats = { samples: 0, cacheHits: 0, voxelReads: 0, traces: 0, routeTests: 0,
      invalidations: 0, revisionInvalidations: 0, budgetLimited: 0 };
    this._frame = -1;
    this._frameReads = 0;
    this._optionalFrameReads = 0;
    this._reads = 0;
    this._limited = false;
    this.setWorld(world);
  }

  setWorld(world) {
    this.world = world && typeof world.getBlock === 'function' ? world : null;
    this.invalidate();
    return this;
  }

  invalidate() {
    this._paths.clear();
    this._rooms.clear();
    this._pending.clear();
    this._revision = this.world?.mutationCount ?? this.world?.revision;
    this._stats.invalidations++;
  }

  diagnostics() {
    return { ...this._stats, pathCacheSize: this._paths.size, roomCacheSize: this._rooms.size,
      pendingPaths: this._pending.size,
      lastVoxelReads: this._reads, frameVoxelReads: this._frameReads,
      revision: this._revision ?? null, limits: this.limits, lastSample: this._last ?? null };
  }

  sample(source, listener, nowSeconds = 0) {
    this._stats.samples++;
    this._reads = 0;
    this._limited = false;
    this._optional = false;
    if (!this.world || !validPosition(source) || !validPosition(listener)) return this._last = { ...OPEN };
    const now = Number.isFinite(nowSeconds) ? nowSeconds : 0;
    const frame = Math.floor(now * 60);
    if (frame !== this._frame) { this._frame = frame; this._frameReads = 0; this._optionalFrameReads = 0; }
    const revision = this.world.mutationCount ?? this.world.revision;
    if (revision !== this._revision) { this.invalidate(); this._stats.revisionInvalidations++; }
    const key = `${cacheKey(source, 2)}>${cacheKey(listener, 2)}`;
    for (const [pendingKey, pending] of this._pending) {
      if (now < pending.time || now - pending.time > 0.35) this._pending.delete(pendingKey);
    }
    const cached = this._paths.get(key);
    // New paths get priority over refreshing same-revision cached estimates.
    // This matters when active voices are always visited in the same order.
    if (cached && now >= cached.time && (now - cached.time < 0.12
      || (this._pending.size && !this._pending.has(key)))) {
      this._stats.cacheHits++;
      return this._last = cached.value;
    }

    // Trace from the listener to find the nearest wall and a plausible opening
    // direction. The material integral is symmetric in propagation direction.
    const directDistance = distance(source, listener);
    if (!Number.isFinite(directDistance)) return this._last = { ...OPEN };
    // Sources beyond the supported acoustic radius are inaudible, rather than
    // tracing a truncated path and claiming that the unvisited part is clear.
    if (directDistance > this.limits.maxDirectDistance) return this._last = {
      ...OPEN, gain: 0, wet: 0, pathLength: directDistance, rangeLimited: true,
    };
    const direct = this._trace(listener, source, false, Infinity, this._pending.get(key)?.cursor);
    if (!direct.complete) {
      remember(this._pending, key, { time: now, cursor: direct.cursor }, this.limits.maxCacheEntries);
    } else this._pending.delete(key);
    if (!direct.complete && cached) {
      this._stats.budgetLimited++;
      return this._last = { ...cached.value, budgetLimited: true };
    }
    if (!direct.complete) {
      this._stats.budgetLimited++;
      // Unknown new voices wait silently for their bounded DDA to finish.
      // Existing voices can retain a trusted same-revision sample. A deferred
      // result is explicitly unknown, not a wall inferred from missing work.
      return this._last = { ...OPEN, gain: 0, wet: 0, pathLength: directDistance,
        blockedVoxels: direct.blocked, budgetLimited: true, deferred: true };
    }
    const loss = direct.loss;
    let gain = clamp(Math.exp(-loss), 0.035, 1);
    let lowpassHz = clamp(20000 / (1 + 3.2 * loss * loss), 550, 20000);
    let apparentPosition = null;
    let pathLength = directDistance;

    this._optional = true;
    // Probe the listener first so every voice in a frame shares room geometry.
    const room = this._room(listener, now);
    const sourceRoom = directDistance < 2 ? room : this._room(source, now);
    if (direct.first && direct.complete && gain < 0.8 && !this._limited) {
      const route = this._openingRoute(listener, source, direct, directDistance);
      if (route && route.gain > gain) {
        gain = Math.min(1, Math.hypot(gain, route.gain));
        lowpassHz = Math.max(lowpassHz, route.lowpassHz);
        apparentPosition = route.point;
        pathLength = route.length;
      }
    }
    const enclosure = room.enclosure;
    const reflectivity = (room.reflectivity * 2 + sourceRoom.reflectivity) / 3;
    const wet = clamp(0.015 + (0.35 * enclosure + 0.1 * sourceRoom.enclosure) * reflectivity, 0.015, 0.48);
    const decaySeconds = clamp(0.18 + enclosure * (0.32 + room.span * 0.05) * reflectivity
      + (room.room === 'tunnel' ? 0.2 : 0), 0.18, 1.85);
    const value = { gain, lowpassHz, wet, decaySeconds,
      preDelaySeconds: clamp(0.008 + room.span / 343, 0.008, 0.075),
      occlusion: 1 - gain, enclosure, room: room.room, apparentPosition, pathLength,
      blockedVoxels: direct.blocked, budgetLimited: this._limited, deferred: false };
    if (this._limited) this._stats.budgetLimited++;
    // A complete direct trace stays useful even if optional reflection/opening
    // probes ran out. Caching it lets later voices receive the next frame's work.
    remember(this._paths, key, { time: now, value }, this.limits.maxCacheEntries);
    return this._last = value;
  }

  _read(x, y, z) {
    if (this._reads >= this.limits.maxVoxelReads || this._frameReads >= this.limits.maxReadsPerFrame
      || (this._optional && this._optionalFrameReads >= this.limits.maxReadsPerFrame * 0.25)) {
      this._limited = true;
      return -1;
    }
    this._reads++;
    this._frameReads++;
    this._stats.voxelReads++;
    if (this._optional) this._optionalFrameReads++;
    return this.world.getBlock(x, y, z);
  }

  // Amanatides/Woo DDA, integrating the actual length inside each solid cell.
  // Segment boundaries shared by two cells have zero thickness, so diagonal
  // corner contacts cannot become a phantom wall or multiply its absorption.
  _trace(from, to, stopAtFirst = false, maximum = Infinity, cursor = null) {
    this._stats.traces++;
    const length = cursor?.length ?? distance(from, to);
    const out = cursor?.out ?? { loss: 0, blocked: 0, first: null, complete: true, distance: length };
    if (length < 1e-5) return out;
    const end = Math.min(length, maximum);
    const origin = cursor?.origin ?? from;
    const direction = cursor?.direction ?? [(to[0] - from[0]) / length, (to[1] - from[1]) / length, (to[2] - from[2]) / length];
    const cell = cursor?.cell ?? from.map(Math.floor);
    const steps = cursor?.steps ?? direction.map(v => v >= 0 ? 1 : -1);
    const delta = cursor?.delta ?? direction.map(v => v ? Math.abs(1 / v) : Infinity);
    const next = cursor?.next ?? direction.map((v, i) => v ? (steps[i] > 0 ? cell[i] + 1 - from[i] : from[i] - cell[i]) * delta[i] : Infinity);
    let start = cursor?.start ?? 0;
    let normalAxis = cursor?.normalAxis ?? 0;
    let firstWallEnded = cursor?.firstWallEnded ?? false;
    while (start < end - 1e-6) {
      const exit = Math.min(next[0], next[1], next[2], end);
      const thickness = exit - start;
      if (thickness > 1e-6) {
        const id = this._read(cell[0], cell[1], cell[2]);
        if (id === -1) {
          out.complete = false;
          // Save the unvisited cell, not a copy of the whole ray history.
          out.cursor = { length, origin, direction, cell, steps, delta, next, start, normalAxis,
            firstWallEnded, out: { loss: out.loss, blocked: out.blocked, first: out.first,
              complete: true, distance: length } };
          return out;
        }
        if (BLOCK.isSolidBlock(id)) {
          out.blocked++;
          out.loss += (coefficient[id] ?? 1.55) * thickness;
          if (!out.first) out.first = { cell: cell.slice(), axis: normalAxis,
            point: origin.map((v, i) => v + direction[i] * start), distance: start,
            reflectivity: reflection[id] ?? 0.78 };
          if (!firstWallEnded) out.first.lastCell = cell.slice();
          if (stopAtFirst) return out;
        } else if (out.first) firstWallEnded = true;
      }
      if (exit >= end) break;
      // Advance all tied axes at once, avoiding zero-width edge intersections.
      for (let i = 0; i < 3; i++) if (next[i] <= exit + 1e-7) {
        cell[i] += steps[i]; next[i] += delta[i]; normalAxis = i;
      }
      start = exit;
    }
    out.complete = length <= maximum;
    return out;
  }

  _room(position, now) {
    const key = cacheKey(position, 0.5);
    const cached = this._rooms.get(key);
    if (cached && now >= cached.time && now - cached.time < 0.45) return cached.value;
    if (this._limited) return cached?.value ?? OUTDOOR;
    const distances = [];
    let reflectivity = 0;
    let hits = 0;
    for (const direction of PROBES) {
      const target = position.map((value, i) => value + direction[i] * this.limits.probeDistance);
      const ray = this._trace(position, target, true);
      distances.push(ray.first ? ray.first.distance : this.limits.probeDistance);
      if (ray.first) { hits++; reflectivity += ray.first.reflectivity; }
      if (!ray.complete || this._limited) return cached?.value ?? OUTDOOR;
    }
    const reach = this.limits.probeDistance - 0.01;
    const roof = distances[0] < reach ? 1 : 0;
    const walls = distances.slice(1, 5).filter(d => d < reach).length / 4;
    const diagonalRoof = distances.slice(5).filter(d => d < reach).length / 4;
    const enclosure = clamp(roof * 0.45 + walls * 0.4 + diagonalRoof * 0.15, 0, 1);
    const spanX = distances[1] + distances[2];
    const spanZ = distances[3] + distances[4];
    const narrow = Math.min(spanX, spanZ);
    const long = Math.max(spanX, spanZ);
    const tunnel = roof && narrow < 12 && long > narrow * 2.2;
    const value = { enclosure, room: roof && enclosure > 0.52 ? (tunnel ? 'tunnel' : 'room') : 'outdoor',
      reflectivity: hits ? reflectivity / hits : OUTDOOR.reflectivity,
      span: clamp((Math.min(spanX, 36) + Math.min(spanZ, 36) + distances[0] * 2) / 3, 2, 36) };
    remember(this._rooms, key, { time: now, value }, this.limits.maxCacheEntries);
    return value;
  }

  _openingRoute(listener, source, direct, directDistance) {
    const first = direct.first;
    const center = first.cell.map(v => v + 0.5);
    const sideOfWall = source[first.axis] >= listener[first.axis] ? 1 : -1;
    center[first.axis] -= sideOfWall * 0.52;
    // Horizontal walls: search sideways along their face, then up for windows
    // and over low cover. Floors/ceilings: search both horizontal directions.
    const tangent = first.axis === 0 ? 2 : 0;
    const secondTangent = first.axis === 1 ? 2 : 1;
    const offsets = [[1, 0], [-1, 0], [2, 0], [-2, 0], [3, 0], [-3, 0],
      [4, 0], [-4, 0], [5, 0], [-5, 0], [6, 0], [-6, 0], [0, 1], [0, 2], [0, 4], [0, -1],
      [2, 1], [-2, 1], [4, 2], [-4, 2]];
    let best = null;
    for (const [side, height] of offsets) {
      if (this._limited) break;
      const point = center.slice();
      point[tangent] += side;
      point[secondTangent] += height;
      // For a thick wall the sound enters and exits the opening at separate
      // points. A single bend in its center would falsely seal a narrow door.
      const exit = point.slice();
      exit[first.axis] = first.lastCell[first.axis] + 0.5 + sideOfWall * 0.52;
      const passageLength = distance(point, exit);
      const detour = distance(listener, point) + passageLength + distance(source, exit);
      if (detour > directDistance + 16) continue;
      this._stats.routeTests++;
      const aperture = point.map(Math.floor);
      aperture[first.axis] = first.cell[first.axis];
      const openingBlock = this._read(...aperture);
      if (openingBlock === -1) break;
      if (BLOCK.isSolidBlock(openingBlock)) continue;
      const firstLeg = this._trace(listener, point, true);
      if (!firstLeg.complete || firstLeg.first) continue;
      if (passageLength > 0.01) {
        const passage = this._trace(point, exit, true);
        if (!passage.complete || passage.first) continue;
      }
      const secondLeg = this._trace(exit, source, true);
      if (!secondLeg.complete || secondLeg.first) continue;
      const excess = Math.max(0, detour - directDistance);
      const gain = 0.74 / (1 + excess * 0.16);
      if (!best || gain > best.gain) best = { gain, point, length: detour,
        lowpassHz: clamp(9200 / (1 + excess * 0.12), 2400, 9200) };
    }
    return best;
  }
}

export function createWorldAcoustics(world, options) { return new WorldAcoustics(world, options); }
