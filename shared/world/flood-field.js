// Flood fields (docs/conquest.md "Redrock Dam breach" -> "Flood field"):
// moving water as a deterministic function of position and time that the
// server and every client evaluate from the same shared code and the same
// start time, instead of a stream of block deltas. Pure: only + - * / and
// sqrt touch the numbers (correctly rounded everywhere), so two engines that
// read the same column floors build bit-equal tables.
//
//   dam field   Redrock's breach, three column kinds over one box:
//     lake      the basin (z >= lake.z0, connected to the dam face) is a 0-D
//               reservoir: H(t) = sill + h0 / (1 + t/tau)^2, the drain curve
//               of a weir; a riffle at the basin head keeps the north river
//               (and its ford) at its old level
//     gap       the breach: the over-sill sheet, sill + share x (H - sill)
//               plus a film, and the canyon water where that is higher
//     canyon    a 1-D channel along z (the canyon runs almost straight north
//               to south, so z stands for the arc length): the local inertial
//               shallow-water scheme over per-row cross-sections taken from
//               the column floors, fed by a dam-break hydrograph shaped like
//               the lake's drain plus a base flow, held at its `final` stage by
//               a spill at the south edge. Solved once at boot (about 10 ms),
//               sampled at `hz` per row: level and velocity as Int16 cm and
//               cm/s, plus per row the arrival, peak, settle time and final
//               level. A column is wet where its row's level stands over its
//               floor and it connects to the stream under the row's peak, so
//               the water spreads sideways without ever standing as a wall.
//   bore field  a 1-D translational bore down a straight reach
//               (createBoreField: front at `speed`, a `crest` that decays
//               with distance and time); the Frontier ford sluices run on it
//               (sluiceBoreField, shared/map-events/sluice.js).
//
// Every field answers level(x, z, t) (water surface y, NaN where it does not
// reach), velocity(x, z, t, out) (m/s on x and z), arrival(x, z) (s), and
// wet(x, y, z, t) for a voxel cell (true / false, undefined outside the
// field). `t` is seconds since the field's start; t >= endS (and Infinity)
// reads the settled state. A FloodSet (world.flood on the server, LOCAL_FLOOD
// on the client) holds the running fields with their start times, so
// fluidAt, hull depth and boats ask one place.
import { isSolidBlock } from './blocks.js';

const G = 9.81;
const KMAX = 64;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Kinds of a column in a dam field. */
export const FLOOD_KIND = Object.freeze({ none: 0, lake: 1, gap: 2, canyon: 3 });

/**
 * Standing height of a column: the first cell above the solid stack that
 * rises from bedrock (overhangs such as a bridge deck do not count), capped
 * at `top`. `solid(y)` defaults to isSolidBlock(block(x, y, z)).
 */
export function columnFloor(block, x, z, top = 63, cutY = Infinity) {
  let y = 0;
  while (y < top && y < cutY && isSolidBlock(block(x, y, z))) y++;
  return y;
}

/* ------------------------------------------------------------ canyon solver */

/**
 * Cross-section tables of one row from its floor histogram (`counts[k]`
 * columns per metre of row with floor k): area and top width at any level.
 */
function rowSection(counts) {
  const area = new Float64Array(KMAX + 1), width = new Float64Array(KMAX + 1);
  let s = 0;
  for (let k = 0; k < KMAX; k++) {
    s += counts[k];
    width[k] = s;                       // columns with floor <= k are wet for k < level <= k + 1
    area[k + 1] = area[k] + s;
  }
  width[KMAX] = s;
  let bottom = 0;
  while (bottom < KMAX && counts[bottom] === 0) bottom++;
  return { area, width, bottom };
}

const areaAt = (sec, eta) => {
  if (eta <= 0) return 0;
  const k = eta >= KMAX ? KMAX - 1 : Math.floor(eta);
  return sec.area[k] + sec.width[k] * (eta - k);
};
const widthAt = (sec, eta) => sec.width[eta >= KMAX ? KMAX - 1 : eta <= 0 ? 0 : Math.floor(eta)];
function etaOf(sec, a) {
  if (!(a > 0)) return sec.bottom;
  let lo = sec.bottom, hi = KMAX - 1;
  if (a >= sec.area[hi]) return hi + (a - sec.area[hi]) / Math.max(1e-9, sec.width[hi]);
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (sec.area[mid] <= a) lo = mid; else hi = mid; }
  return lo + (a - sec.area[lo]) / Math.max(1e-9, sec.width[lo]);
}

/**
 * The 1-D dam-break run: `sections` per row (rowSection), `spec` {dz,
 * initial, final, q0, tauS, delayS, qBase, chezy, theta, dtS, hz, endS, rise}.
 * Returns {rows, samples, eta: Int16Array (cm), u: Int16Array (cm/s),
 * arrival, peak, peakS, settleS, final: Float64Array per row, steps}.
 */
export function solveChannel(sections, spec) {
  const N = sections.length, dx = spec.dz, C2 = spec.chezy * spec.chezy;
  const S = Math.round(spec.endS * spec.hz), dtSample = 1 / spec.hz;
  const A = new Float64Array(N), Q = new Float64Array(N + 1), Qold = new Float64Array(N + 1), eta = new Float64Array(N);
  const theta = spec.theta ?? 0.7;
  for (let r = 0; r < N; r++) A[r] = areaAt(sections[r], spec.initial);
  const etaOut = new Int16Array(N * (S + 1)), uOut = new Int16Array(N * (S + 1));
  const inflow = t => {
    if (t < spec.delayS) return 0;
    const x = 1 / (1 + (t - spec.delayS) / spec.tauS);
    return spec.qBase + spec.q0 * x * x * x;
  };
  // The settled river: `final` at the south edge rising `slope` per metre upstream, carrying the base flow.
  const target = Float64Array.from({ length: N }, (_, r) => spec.final + (N - 0.5 - r) * dx * spec.slope);
  const record = i => {
    // The run's sloshing (a closed canyon rings for minutes) eases into the settled river over [blendS].
    const s = clamp((i / spec.hz - spec.blendS[0]) / (spec.blendS[1] - spec.blendS[0]), 0, 1), w = s * s * (3 - 2 * s);
    for (let r = 0; r < N; r++) {
      const e = etaOf(sections[r], A[r]);
      etaOut[r * (S + 1) + i] = Math.round((e + (target[r] - e) * w) * 100);
      const u = A[r] > 0.5 ? 0.5 * (Q[r] + Q[r + 1]) / A[r] : 0, ut = spec.qBase / Math.max(1, areaAt(sections[r], target[r]));
      uOut[r * (S + 1) + i] = clamp(Math.round((u + (ut - u) * w) * 100), -32000, 32000);
    }
  };
  record(0);
  let t = 0, steps = 0;
  for (let i = 1; i <= S; i++) {
    // Substeps keep the gravity wave inside 0.7 cells a step (CFL).
    let left = dtSample;
    while (left > 1e-9) {
      let c = 0;
      for (let r = 0; r < N; r++) {
        eta[r] = etaOf(sections[r], A[r]);
        const h = eta[r] - sections[r].bottom;
        const u = A[r] > 0.5 ? Math.abs(0.5 * (Q[r] + Q[r + 1]) / A[r]) : 0;
        const w = (h > 0 ? Math.sqrt(G * h) : 0) + u;
        if (w > c) c = w;
      }
      let dt = Math.min(left, spec.dtS);
      if (c > 0 && dt * c > 0.7 * dx) dt = 0.7 * dx / c;
      Q[0] = inflow(t);
      Qold.set(Q);
      for (let f = 1; f <= N; f++) {
        const last = f === N;
        const etaL = eta[f - 1], etaR = last ? spec.final : eta[f];
        if (last && etaL <= spec.final) { Q[f] = 0; continue; }
        const top = etaL > etaR ? etaL : etaR;
        const secL = sections[f - 1], secR = last ? secL : sections[f];
        const aL = areaAt(secL, top), aR = areaAt(secR, top);
        const af = aL < aR ? aL : aR, bf = Math.min(widthAt(secL, top), widthAt(secR, top));
        if (af < 0.01) { Q[f] = 0; continue; }
        const radius = af / (bf > 1 ? bf : 1);
        // theta-weighted flux (de Almeida et al. 2012): damps the scheme's checkerboard ringing.
        let q = last ? Qold[f] : theta * Qold[f] + (1 - theta) * 0.5 * (Qold[f - 1] + Qold[f + 1]);
        q = (q - G * af * dt * (etaR - etaL) / dx) / (1 + G * dt * Math.abs(q) / (C2 * radius * af));
        // Never take more than half a row's water in one step.
        if (q > 0) q = Math.min(q, A[f - 1] * dx / (2 * dt));
        else if (!last) q = Math.max(q, -A[f] * dx / (2 * dt));
        else q = 0;
        Q[f] = q;
      }
      for (let r = 0; r < N; r++) { A[r] += dt / dx * (Q[r] - Q[r + 1]); if (A[r] < 0) A[r] = 0; }
      t += dt; left -= dt; steps++;
    }
    record(i);
  }
  const arrival = new Float64Array(N).fill(Infinity), peak = new Float64Array(N), peakS = new Float64Array(N);
  const settleS = new Float64Array(N), final = new Float64Array(N);
  const rise = Math.round((spec.initial + spec.rise) * 100);
  for (let r = 0; r < N; r++) {
    const o = r * (S + 1);
    final[r] = etaOut[o + S] / 100;
    let p = -1e9, at = 0, last = 0;
    for (let i = 0; i <= S; i++) {
      const v = etaOut[o + i];
      if (arrival[r] === Infinity && v > rise) arrival[r] = i / spec.hz;
      if (v > p) { p = v; at = i; }
      if (Math.abs(v - etaOut[o + S]) > spec.settleCm) last = i + 1;
    }
    peak[r] = p / 100; peakS[r] = at / spec.hz; settleS[r] = Math.min(spec.endS, last / spec.hz);
  }
  return { rows: N, samples: S + 1, eta: etaOut, u: uOut, arrival, peak, peakS, settleS, final, steps };
}

/* ---------------------------------------------------------------- dam field */

/**
 * Build Redrock's dam field. `block(x, y, z)` reads the pristine voxels (the
 * server's templateBlock; a client its world before the breach, the cut
 * cells and water changes do not move a floor). `spec` (DAM_TUNING.flood):
 *   lake    {x0, x1, z0, z1, seedZ, top, sill, h0, tauS, riffle: {z0, z1}}
 *   gap     {x0, x1, z0, z1, cutY, share, film, suction: {radius, near}}
 *   canyon  {x0, x1, z0, z1, maxFloor, dz, initial, final, q0, tauS, delayS, qBase, chezy, dtS, hz, endS, rise, settleCm}
 */
export function buildDamFlood(block, spec) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const { lake, gap, canyon: cy } = spec;
  const x0 = Math.min(lake.x0, gap.x0, cy.x0), x1 = Math.max(lake.x1, gap.x1, cy.x1);
  const z0 = Math.min(lake.z0, gap.z0, cy.z0), z1 = Math.max(lake.z1, gap.z1, cy.z1);
  const W = x1 - x0 + 1, H = z1 - z0 + 1;
  const floor = new Uint8Array(W * H), kind = new Uint8Array(W * H);
  const idx = (x, z) => (z - z0) * W + (x - x0);
  const scan = (bx0, bx1, bz0, bz1, cut = Infinity) => {
    for (let z = bz0; z <= bz1; z++) for (let x = bx0; x <= bx1; x++) {
      const i = idx(x, z);
      if (floor[i]) continue;
      floor[i] = Math.max(1, columnFloor(block, x, z, 63, cut));
    }
  };
  // The breach box loses every cell from cutY up; its floors never read them.
  scan(gap.x0, gap.x1, gap.z0, gap.z1, gap.cutY);
  scan(lake.x0, lake.x1, lake.z0, lake.z1);
  scan(cy.x0, cy.x1, cy.z0, cy.z1);
  for (let z = gap.z0; z <= gap.z1; z++) for (let x = gap.x0; x <= gap.x1; x++) kind[idx(x, z)] = FLOOD_KIND.gap;

  const flood = (inBox, seeds, open, mark) => {
    const queue = [];
    for (const [x, z] of seeds) { const i = idx(x, z); if (open(x, z, i) && kind[i] !== mark) { if (kind[i] === FLOOD_KIND.none) kind[i] = mark; queue.push(x, z); } }
    const seen = new Uint8Array(W * H);
    for (let q = 0; q < queue.length; q += 2) {
      const x = queue[q], z = queue[q + 1];
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz;
        if (!inBox(nx, nz)) continue;
        const i = idx(nx, nz);
        if (seen[i] || !open(nx, nz, i)) continue;
        seen[i] = 1;
        if (kind[i] === FLOOD_KIND.none) kind[i] = mark;
        queue.push(nx, nz);
      }
    }
  };
  // Lake: every column under the old surface connected to the dam face.
  const inLake = (x, z) => x >= lake.x0 && x <= lake.x1 && z >= lake.z0 && z <= lake.z1;
  const lakeSeeds = [];
  for (let x = lake.x0; x <= lake.x1; x++) lakeSeeds.push([x, lake.seedZ]);
  flood(inLake, lakeSeeds, (x, z, i) => floor[i] < lake.top && kind[i] !== FLOOD_KIND.gap, FLOOD_KIND.lake);

  // Canyon candidates: connected to the stream (floor under the old surface) below maxFloor.
  const inCanyon = (x, z) => x >= cy.x0 && x <= cy.x1 && z >= cy.z0 && z <= cy.z1;
  const candidate = new Uint8Array(W * H);
  {
    const seeds = [];
    for (let z = cy.z0; z <= cy.z1; z++) for (let x = cy.x0; x <= cy.x1; x++) if (floor[idx(x, z)] <= cy.initial - 1) seeds.push([x, z]);
    const queue = [];
    for (const [x, z] of seeds) { candidate[idx(x, z)] = 1; queue.push(x, z); }
    for (let q = 0; q < queue.length; q += 2) {
      const x = queue[q], z = queue[q + 1];
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz;
        if (!inCanyon(nx, nz)) continue;
        const i = idx(nx, nz);
        if (candidate[i] || floor[i] > cy.maxFloor || kind[i] === FLOOD_KIND.lake) continue;
        candidate[i] = 1; queue.push(nx, nz);
      }
    }
  }
  // Rows of dz metres: floor histograms per metre of row, then the run.
  const rows = Math.ceil((cy.z1 - cy.z0 + 1) / cy.dz);
  const sections = [];
  for (let r = 0; r < rows; r++) {
    const counts = new Float64Array(KMAX);
    for (let z = cy.z0 + r * cy.dz; z < Math.min(cy.z1 + 1, cy.z0 + (r + 1) * cy.dz); z++) {
      for (let x = cy.x0; x <= cy.x1; x++) { const i = idx(x, z); if (candidate[i]) counts[Math.min(KMAX - 1, floor[i])] += 1 / cy.dz; }
    }
    sections.push(rowSection(counts));
  }
  const run = solveChannel(sections, cy);
  // The wet canyon: connected to the stream under its row's peak.
  {
    const rowOf = z => clamp(Math.floor((z - cy.z0) / cy.dz), 0, rows - 1);
    const queue = [];
    for (let z = cy.z0; z <= cy.z1; z++) for (let x = cy.x0; x <= cy.x1; x++) {
      const i = idx(x, z);
      if (candidate[i] && floor[i] <= cy.initial - 1) { if (kind[i] === FLOOD_KIND.none) kind[i] = FLOOD_KIND.canyon; candidate[i] = 2; queue.push(x, z); }
    }
    for (let q = 0; q < queue.length; q += 2) {
      const x = queue[q], z = queue[q + 1];
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz;
        if (!inCanyon(nx, nz)) continue;
        const i = idx(nx, nz);
        if (candidate[i] !== 1 || floor[i] >= run.peak[rowOf(nz)]) continue;
        candidate[i] = 2;
        if (kind[i] === FLOOD_KIND.none) kind[i] = FLOOD_KIND.canyon;
        queue.push(nx, nz);
      }
    }
  }
  return new DamFloodField({ spec, x0, z0, W, H, floor, kind, run, buildMs: (typeof performance !== 'undefined' ? performance.now() : 0) - t0 });
}

export class DamFloodField {
  constructor({ spec, x0, z0, W, H, floor, kind, run, buildMs }) {
    Object.assign(this, { spec, x0, z0, W, H, floor, kind, run, buildMs });
    this.bounds = Object.freeze({ x0, z0, x1: x0 + W - 1, z1: z0 + H - 1 });
    this.endS = spec.canyon.endS;
    const c = spec.canyon;
    this.rows = run.rows;
    this.cz0 = c.z0; this.dz = c.dz; this.hz = c.hz;
    this.gapMouth = Object.freeze({ x: (spec.gap.x0 + spec.gap.x1 + 1) / 2, z: spec.gap.z0 });
  }

  /** Column kind (FLOOD_KIND) and floor at a world cell, 0 outside. */
  kindAt(x, z) {
    const bx = Math.floor(x) - this.x0, bz = Math.floor(z) - this.z0;
    return bx < 0 || bz < 0 || bx >= this.W || bz >= this.H ? 0 : this.kind[bz * this.W + bx];
  }
  floorAt(x, z) {
    const bx = Math.floor(x) - this.x0, bz = Math.floor(z) - this.z0;
    return bx < 0 || bz < 0 || bx >= this.W || bz >= this.H ? 0 : this.floor[bz * this.W + bx];
  }

  /** The reservoir surface at `t`. */
  lakeLevel(t) {
    const l = this.spec.lake;
    if (!(t > 0)) return l.top;
    const x = 1 / (1 + t / l.tauS);
    return l.sill + l.h0 * x * x;
  }
  /** The basin's settled level at row z (the riffle at the head). */
  lakeFinal(z) {
    const l = this.spec.lake, r = l.riffle;
    return l.sill + l.h0 * (1 - clamp((z - r.z0) / (r.z1 - r.z0), 0, 1));
  }
  /** The over-sill sheet in the gap at `t`. */
  gapLevel(t) {
    const g = this.spec.gap, l = this.spec.lake;
    return l.sill + g.share * (this.lakeLevel(t) - l.sill) + g.film;
  }

  _sample(table, r, t) {
    const S = this.run.samples - 1, s = t >= this.endS || !(t === t) ? S : Math.max(0, t) * this.hz;
    const i = Math.min(S - 1, Math.floor(s)), f = Math.min(1, s - i), o = r * (S + 1);
    return (table[o + i] * (1 - f) + table[o + i + 1] * f) / 100;
  }
  /** Canyon level at continuous z (rows interpolated) and `t`. */
  rowLevel(z, t) {
    const rf = (z - this.cz0) / this.dz - 0.5, r0 = clamp(Math.floor(rf), 0, this.rows - 1), r1 = Math.min(this.rows - 1, r0 + 1);
    const f = clamp(rf - r0, 0, 1);
    const a = this._sample(this.run.eta, r0, t);
    return r1 === r0 ? a : a + (this._sample(this.run.eta, r1, t) - a) * f;
  }
  rowVelocity(z, t) {
    const r = clamp(Math.floor((z - this.cz0) / this.dz), 0, this.rows - 1);
    return this._sample(this.run.u, r, t);
  }
  /** Row index of a canyon z. */
  row(z) { return clamp(Math.floor((z - this.cz0) / this.dz), 0, this.rows - 1); }

  /** Water surface y at (x, z) and `t`, NaN where the field does not reach. */
  level(x, z, t) {
    const k = this.kindAt(x, z);
    if (k === FLOOD_KIND.lake) return Math.max(this.lakeLevel(t), this.lakeFinal(z));
    if (k === FLOOD_KIND.gap) return z >= this.cz0 ? Math.max(this.gapLevel(t), this.rowLevel(z, t)) : this.gapLevel(t);
    if (k === FLOOD_KIND.canyon) return this.rowLevel(z, t);
    return NaN;
  }

  /** Surface flow (m/s) at (x, z): the canyon's along z, the over-sill sheet, the lake drawn to the gap. */
  velocity(x, z, t, out = { x: 0, z: 0 }) {
    out.x = 0; out.z = 0;
    const k = this.kindAt(x, z);
    if (!k) return out;
    const g = this.spec.gap, l = this.spec.lake;
    const head = Math.max(0, g.share * (this.lakeLevel(t) - l.sill));
    const sheet = Math.sqrt(G * head);
    if (k === FLOOD_KIND.canyon) { out.z = this.rowVelocity(z, t); return out; }
    if (k === FLOOD_KIND.gap) { out.z = z >= this.cz0 ? Math.max(sheet, this.rowVelocity(z, t)) : sheet; return out; }
    const dx = this.gapMouth.x - (x + 0.5), dz = this.gapMouth.z - (z + 0.5), d = Math.sqrt(dx * dx + dz * dz);
    if (d > g.suction.radius || d < 1e-6) return out;
    const s = sheet * Math.min(1, g.suction.near / d);
    out.x = dx / d * s; out.z = dz / d * s;
    return out;
  }

  /** Seconds after the start until the water rises at (x, z): 0 in the lake and the gap, Infinity where it never comes. */
  arrival(x, z) {
    const k = this.kindAt(x, z);
    if (k === FLOOD_KIND.lake || k === FLOOD_KIND.gap) return 0;
    if (k !== FLOOD_KIND.canyon) return Infinity;
    return this.run.arrival[this.row(z)];
  }

  /** Seconds after the start once the level at (x, z) stays within settleCm of its final value. */
  settled(x, z) {
    const k = this.kindAt(x, z);
    if (k === FLOOD_KIND.canyon) return this.run.settleS[this.row(z)];
    return k ? this.endS : 0;
  }

  /** A voxel cell under the water (its centre below the level, at or over the column floor), undefined outside. */
  wet(x, y, z, t) {
    const lv = this.level(x, z, t);
    if (lv !== lv) return undefined;
    return y >= this.floorAt(x, z) && y + 0.5 < lv;
  }

  /** The south-most z the water has reached at `t` (the front), or the canyon head before it starts. */
  front(t) {
    const a = this.run.arrival;
    let r = -1;
    for (let i = 0; i < this.rows; i++) if (a[i] <= t) r = i;
    return r < 0 ? this.cz0 : Math.min(this.spec.canyon.z1, this.cz0 + (r + 1) * this.dz);
  }

  /** FNV-1a over the tables, kinds and floors (the determinism check: server and client builds must agree). */
  hash() {
    let h = 0x811c9dc5;
    const mix = arr => { const b = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength); for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193); };
    mix(this.run.eta); mix(this.run.u); mix(this.kind); mix(this.floor);
    return (h >>> 0).toString(16).padStart(8, '0');
  }
}

/* --------------------------------------------------------------- bore field */

/**
 * A 1-D translational bore down a straight reach (the ford sluices' release):
 *   box     {x0, x1, z0, z1} the reach (cells), `axis` 'z' or 'x', `dir` +1 / -1
 *           (the flow runs from the box's start edge along it)
 *   base    the standing surface y before the bore (number or (x, z) => y)
 *   floorAt (x, z) => standing height of a column (dry where the level is not over it)
 *   speed   front speed m/s; `crest` m over `base` at the gate, `decayM` m of
 *           e-folding with distance, `riseM` the front's steepness, `tailS` s
 *           of e-folding behind the front; `final` m added to `base` once
 *           settled (a scoured bed holds deeper water); `endS` the run's end
 * Same interface as the dam field (level, velocity, arrival, settled, wet, bounds, endS).
 */
export function createBoreField(spec) {
  const { box, axis = 'z', dir = 1, speed = 5, crest = 1, decayM = 40, riseM = 3, tailS = 12, final = 0, endS = 60 } = spec;
  const base = typeof spec.base === 'function' ? spec.base : () => spec.base;
  const floorAt = spec.floorAt ?? (() => -Infinity);
  const start = dir > 0 ? (axis === 'z' ? box.z0 : box.x0) : (axis === 'z' ? box.z1 + 1 : box.x1 + 1);
  const along = (x, z) => ((axis === 'z' ? z : x) - start) * dir;
  const inside = (x, z) => x >= box.x0 && x <= box.x1 + 1 && z >= box.z0 && z <= box.z1 + 1;
  const extra = (s, t) => {
    if (s < 0) return 0;
    const tf = t >= endS ? Infinity : t, front = speed * tf;
    if (s > front) return 0;
    const behind = tf - s / speed;
    const shape = 1 - 1 / (1 + (front - s) / riseM);           // 0 at the front, 1 well behind it
    const decay = 1 / (1 + s / decayM), fade = 1 / (1 + behind / tailS);
    return crest * decay * decay * shape * fade * fade + final * (1 - fade);
  };
  return Object.freeze({
    kind: 'bore', bounds: Object.freeze({ x0: box.x0, z0: box.z0, x1: box.x1, z1: box.z1 }), endS,
    level(x, z, t) { return inside(x, z) ? base(x, z) + extra(along(x, z), t) : NaN; },
    velocity(x, z, t, out = { x: 0, z: 0 }) {
      out.x = 0; out.z = 0;
      if (!inside(x, z) || !(crest > 0)) return out;
      const u = speed * 0.6 * Math.min(1, extra(along(x, z), t) / crest) * dir;
      if (axis === 'z') out.z = u; else out.x = u;
      return out;
    },
    arrival(x, z) { const s = along(x, z); return inside(x, z) && s >= 0 ? s / speed : Infinity; },
    settled(x, z) { return inside(x, z) ? endS : 0; },
    wet(x, y, z, t) {
      const lv = this.level(x, z, t);
      if (lv !== lv) return undefined;
      return y >= floorAt(x, z) && y + 0.5 < lv;
    },
  });
}

/* ---------------------------------------------------------------- flood set */

/**
 * The running fields of one world with their start times (engine ms): the
 * one place fluidAt (server/game.js, the client's player physics), hull depth
 * (server/sim/vehicles.js) and boats (server/sim/boat.js) ask. `nowMs` is set
 * by the owner every tick (the server's engine time, the client's estimate of
 * it); a start of -Infinity reads the settled state.
 */
export class FloodSet {
  constructor() { this.fields = []; this.nowMs = 0; }
  get active() { return this.fields.length > 0; }
  /** `hooks.drown(player, damage)` (server): a body drowning in this field's water; true when it took the damage itself (credit). */
  add(id, field, startMs, hooks = null) { this.remove(id); this.fields.push({ id, field, startMs, hooks }); return field; }
  remove(id) { this.fields = this.fields.filter(f => f.id !== id); }
  clear() { this.fields = []; }
  get(id) { return this.fields.find(f => f.id === id) ?? null; }
  /** Seconds since the entry's start (Infinity once settled for good). */
  t(entry) { return entry.startMs === -Infinity ? Infinity : Math.max(0, (this.nowMs - entry.startMs) / 1000); }

  /** The entry whose field reaches (x, z), or null. */
  at(x, z) {
    for (const entry of this.fields) {
      const b = entry.field.bounds;
      if (x < b.x0 || x >= b.x1 + 1 || z < b.z0 || z >= b.z1 + 1) continue;
      const lv = entry.field.level(x, z, this.t(entry));
      if (lv === lv) return entry;
    }
    return null;
  }
  /** Water surface y at (x, z), NaN where no field reaches. */
  level(x, z) {
    for (const entry of this.fields) {
      const b = entry.field.bounds;
      if (x < b.x0 || x >= b.x1 + 1 || z < b.z0 || z >= b.z1 + 1) continue;
      const lv = entry.field.level(x, z, this.t(entry));
      if (lv === lv) return lv;
    }
    return NaN;
  }
  /** A cell is under field water (true / false), or undefined where no field reaches (read the voxel). */
  wetCell(x, y, z) {
    if (!this.fields.length) return undefined;
    for (const entry of this.fields) {
      const b = entry.field.bounds;
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
      const w = entry.field.wet(x, y, z, this.t(entry));
      if (w !== undefined) return w;
    }
    return undefined;
  }
  /** Surface flow (m/s) at (x, z). */
  velocity(x, z, out = { x: 0, z: 0 }) {
    out.x = 0; out.z = 0;
    const entry = this.at(x, z);
    return entry ? entry.field.velocity(x, z, this.t(entry), out) : out;
  }
}

/** The flood set of a server world (created on first use). */
export const floodSet = world => (world.flood ??= new FloodSet());
/** The client's flood set (its one world, the legacy singleton). */
export const LOCAL_FLOOD = new FloodSet();
