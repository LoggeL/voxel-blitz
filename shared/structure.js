// Structural integrity rules shared by the authoritative server
// (server/sim/structure.js) and clients that animate collapses. The wire
// format and the motion model are documented in docs/structural-physics.md.
import {
  STRUCTURE_CLASS, STRUCTURE_GROUND, STRUCTURE_MATERIALS, isSolidBlock,
} from './world/blocks.js';
import { GRAVITY } from './combatmath.js';

export const STRUCTURE_RULES = Object.freeze({
  /** Support an anchor (ground, bedrock or a load-time pin) gives; 0 = unsupported. */
  supportMax: 254,
  /** Warning between support loss (`creak`) and the fall (`collapse`). */
  creakMs: 450,
  /** Support work units (one cell visit each) per 60 Hz tick; the rest waits for the next tick. */
  tickBudget: 1500,
  /** Creak events per tick, and blocks they list; further clusters creak in the following ticks. */
  maxCreaksPerTick: 16,
  maxCreakCellsPerTick: 1024,
  /** Cells removed by collapses per tick; a larger collapse continues next tick. */
  maxRemovalsPerTick: 512,
  /** One falling chunk holds at most this many blocks; larger clusters split. */
  maxChunkCells: 384,
  /** Chunks one cluster may become; the remaining cells crumble in place. */
  maxChunksPerCluster: 12,
  /** Falling chunks alive at once per room; past that, clusters crumble. */
  maxActiveChunks: 32,
  /** Chunks with more blocks fall straight down (no drift), saving the drift sweep. */
  maxDriftCells: 64,
  /** Seeded horizontal drift (m/s) and spin (rad/s) ranges of a falling chunk. */
  drift: Object.freeze([0.2, 0.9]),
  spin: Object.freeze([0.3, 1.4]),
  gravity: GRAVITY,
  /** A chunk that has not landed after this long is removed. */
  maxFallMs: 6000,
  /** Body hits: `perMass * sqrt(mass) * (speed - minSpeed)`, crush when buried at landing. */
  damage: Object.freeze({ minSpeed: 2, perMass: 2.2, crush: 30, max: 250, vehicleScale: 3 }),
  /** Landing: part of the bottom layer stays as one rubble layer, never inside a body. */
  rubble: Object.freeze({ fraction: 0.4, max: 24, settle: 6, clearance: 0.25 }),
  /** Landing damage to the structural blocks under the chunk (chain collapses). */
  impact: Object.freeze({ perSpeed: 6, maxCells: 32 }),
  /** Blocks listed per event (`n` still counts them all). */
  eventCells: 1024,
});

/** Event kinds this system adds to `tick.events` (docs/structural-physics.md). */
export const STRUCTURE_EVENT_KINDS = Object.freeze(['creak', 'collapse', 'collapseLand', 'crumble']);
/** Kill-feed weapon key of a crush kill. */
export const COLLAPSE_WEAPON = 'collapse';

const MAX = STRUCTURE_RULES.supportMax;
/** Per block id: 0 ignored (passable), 1 ground anchor, 2 structural. */
export const STRUCTURE_KIND = new Uint8Array(256);
/** Support lost per sideways step into / hanging step under a block of this id (>MAX: never). */
export const STRUCTURE_SIDE_COST = new Uint16Array(256);
export const STRUCTURE_DENSITY = new Float32Array(256);
export const STRUCTURE_RUBBLE = new Uint8Array(256);
for (let id = 0; id < 256; id++) {
  if (!isSolidBlock(id)) continue;
  if (STRUCTURE_GROUND.has(id)) { STRUCTURE_KIND[id] = 1; continue; }
  const material = STRUCTURE_MATERIALS[STRUCTURE_CLASS[id] ?? 'masonry'];
  STRUCTURE_KIND[id] = 2;
  STRUCTURE_SIDE_COST[id] = material.span > 0 ? Math.ceil(MAX / (material.span + 1)) : MAX + 1;
  STRUCTURE_DENSITY[id] = material.density;
  STRUCTURE_RUBBLE[id] = material.rubble ? 1 : 0;
}

/** Sideways blocks a structural block of this id may reach from a supported one (0 for ground/passable). */
export function structureSpan(type) {
  if (STRUCTURE_KIND[type & 255] !== 2) return 0;
  const cost = STRUCTURE_SIDE_COST[type & 255];
  return cost > MAX ? 0 : Math.floor((MAX - 1) / cost);
}

/** Decode an event's `o` + `b` into world cells [{x, y, z, type}]. */
export function structureEventCells(event) {
  const out = [];
  const o = Array.isArray(event?.o) ? event.o : [0, 0, 0], b = Array.isArray(event?.b) ? event.b : [];
  for (let i = 0; i + 3 < b.length; i += 4) out.push({ x: o[0] + b[i], y: o[1] + b[i + 1], z: o[2] + b[i + 2], type: b[i + 3] });
  return out;
}

/**
 * Translation of a falling chunk `t` ms after `collapse.at` (clamped to the
 * landing time): d = v t + (0, -g t^2 / 2, 0). Add it to every block.
 */
export function collapseOffset(event, tMs) {
  const t = Math.max(0, Math.min(Number(event.land) || 0, tMs)) / 1000, g = Number(event.g) || STRUCTURE_RULES.gravity;
  const v = event.v || [0, 0, 0];
  return [v[0] * t, v[1] * t - 0.5 * g * t * t, v[2] * t];
}

/** Rotation of a falling chunk about its pivot `p`: unit axis and angle (radians), clamped to landing. */
export function collapseRotation(event, tMs) {
  const t = Math.max(0, Math.min(Number(event.land) || 0, tMs)) / 1000, w = event.w || [0, 0, 0];
  const rate = Math.hypot(w[0], w[1], w[2]);
  if (!(rate > 0)) return { axis: [0, 1, 0], angle: 0 };
  return { axis: [w[0] / rate, w[1] / rate, w[2] / rate], angle: rate * t };
}

/**
 * The whole chunk transform at `tMs` without allocating: a row-major 3x4
 * matrix [r00 r01 r02 tx, r10 r11 r12 ty, r20 r21 r22 tz] written into `out`
 * (12 numbers), so `point' = R point + t` equals `collapsePoint(event, point, tMs)`
 * for every point. Clients pose a chunk mesh built in world coordinates with it.
 */
export function collapseMatrix(event, tMs, out = new Float64Array(12)) {
  const t = Math.max(0, Math.min(Number(event.land) || 0, tMs)) / 1000, g = Number(event.g) || STRUCTURE_RULES.gravity;
  const v = event.v || ZERO3, w = event.w || ZERO3, p = event.p || ZERO3;
  const rate = Math.hypot(w[0], w[1], w[2]);
  let ax = 0, ay = 1, az = 0, angle = 0;
  if (rate > 0) { ax = w[0] / rate; ay = w[1] / rate; az = w[2] / rate; angle = rate * t; }
  const c = Math.cos(angle), s = Math.sin(angle), k = 1 - c;
  // Rodrigues' formula as a matrix: R = c I + s [a]x + (1 - c) a a^T.
  out[0] = c + ax * ax * k; out[1] = ax * ay * k - az * s; out[2] = ax * az * k + ay * s;
  out[4] = ay * ax * k + az * s; out[5] = c + ay * ay * k; out[6] = ay * az * k - ax * s;
  out[8] = az * ax * k - ay * s; out[9] = az * ay * k + ax * s; out[10] = c + az * az * k;
  // t = p + d - R p
  const dx = v[0] * t, dy = v[1] * t - 0.5 * g * t * t, dz = v[2] * t;
  out[3] = p[0] + dx - (out[0] * p[0] + out[1] * p[1] + out[2] * p[2]);
  out[7] = p[1] + dy - (out[4] * p[0] + out[5] * p[1] + out[6] * p[2]);
  out[11] = p[2] + dz - (out[8] * p[0] + out[9] * p[1] + out[10] * p[2]);
  return out;
}
const ZERO3 = Object.freeze([0, 0, 0]);

/** World position of a point (e.g. a block centre) of a falling chunk at `tMs`. */
export function collapsePoint(event, point, tMs) {
  const d = collapseOffset(event, tMs), { axis, angle } = collapseRotation(event, tMs), p = event.p;
  const rx = point[0] - p[0], ry = point[1] - p[1], rz = point[2] - p[2];
  // Rodrigues' rotation of the pivot-relative point.
  const c = Math.cos(angle), s = Math.sin(angle), [ax, ay, az] = axis, dot = ax * rx + ay * ry + az * rz;
  const x = rx * c + (ay * rz - az * ry) * s + ax * dot * (1 - c);
  const y = ry * c + (az * rx - ax * rz) * s + ay * dot * (1 - c);
  const z = rz * c + (ax * ry - ay * rx) * s + az * dot * (1 - c);
  return [p[0] + d[0] + x, p[1] + d[1] + y, p[2] + d[2] + z];
}
