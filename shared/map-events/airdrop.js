// Supply airdrop (docs/conquest.md "Map events" > "Supply airdrop"): both
// battlefields. A transport helicopter (presentation only) crosses the map on
// a seeded heading and drops a crate under a parachute on open ground between
// two flags of different owners; the first infantry player to hold Interact
// on it for 3 s gets the KR-50 KRABER for that life (limited ammo, no
// resupply) plus a full refill of the kit. An unclaimed crate is gone after
// 90 s. Every number is in `tuning`; the pure helpers below are shared by the
// server controller (server/modes/conquest/map-events/airdrop.js), the HUD
// presenter and the world effects, so the crate falls the same everywhere.
import { defineMapEvent } from './define.js';

/**
 * Phases: idle (the next drop is scheduled) -> warning (the transport runs in
 * for `approachMs`, the crate sinks under its canopy for `descentMs`) ->
 * active (the crate on the ground: the `crate` point, `activeMs` to claim it)
 * -> cooldown (claimed or expired) -> idle. A director queue shows as armed.
 */
export const AIRDROP_TUNING = Object.freeze({
  /** First drop after the round start, then one per interval (trigger to trigger), seeded per match. */
  firstMs: Object.freeze([165000, 195000]),
  intervalMs: Object.freeze([240000, 360000]),
  /** A drop the director refuses (repeat cap) or that finds no spot tries again this much later. */
  retryMs: 30000,
  /** Run-in of the transport to the release point, then the canopy's sink to the ground. */
  approachMs: 9000,
  descentMs: 11000,
  /** Release height above the landing cell, the transport's height above it and its ground speed. */
  releaseM: 55,
  planeM: 62,
  planeSpeed: 45,
  /** The transport flies on past the release for this long, then it is gone (presentation). */
  planeExitMs: 10000,
  /** Heading on the wire in steps of this many degrees (ev[5][1]). */
  headingStepDeg: 5,
  /** The claim: hold radius (m), hold time, then the crate stands this long unclaimed. */
  claimRadius: 2.5,
  claimMs: 3000,
  activeMs: 90000,
  /**
   * Landing spot: a point between two flags of different owners (`lerp` along
   * the pair, up to `sideM` off the line), then the nearest of `tries` seeded
   * cells within `searchM` that is open ground: the first block down from the
   * sky is the standing surface (no roof, canopy, bridge or water), the 3 x 3
   * cells around it within `flatM` voxels of it, `flagClearM` outside every
   * flag zone, `hqClearM` outside both HQ radii, `edgeM` inside the combat
   * area, and a walk node of the bots' surface graph in the flags' component.
   * Pairs farther apart than `pairMaxM` are skipped; the `pairPick` nearest
   * pairs are the seeded choices (4: both maps mirror their flags, so the
   * round-start fronts B-C, C-D, A-C and C-E are an even pick).
   */
  spot: Object.freeze({ lerp: Object.freeze([0.35, 0.65]), sideM: 28, searchM: 60, tries: 48, flatM: 1, flagClearM: 4,
    hqClearM: 30, edgeM: 30, pairMaxM: 360, pairPick: 4 }),
  /** The reward: the weapon id, its magazine and reserve (whole spare magazines) for that life. */
  weapon: Object.freeze({ id: 'kraber', mag: 4, reserve: 1 }),
  /** Bots: who goes (posted tasks, server/bot-map-events.js) and when it is too hot to send a claimer. */
  bots: Object.freeze({ range: 170, landingPriority: 3, claimPriority: 4, contestPriority: 5, escortSquad: 2, landingSquad: 2,
    escortRadius: 9, contestRadius: 3, threatRadius: 35, maxDeficit: 3 }),
});

export const AIRDROP_EVENT = defineMapEvent({
  id: 'airdrop',
  maps: ['frontier', 'redrock'],
  kind: 'supply',
  name: 'Supply drop',
  short: 'CRATE',
  glyph: 'event-crate',
  anchor: null,
  flag: null,
  big: true,
  repeat: { cooldownMs: 1000, max: 6 },
  breakthrough: true,
  durations: { warningMs: AIRDROP_TUNING.approachMs + AIRDROP_TUNING.descentMs, activeMs: AIRDROP_TUNING.activeMs },
  texts: {
    armed: { title: 'INBOUND', detail: 'TRANSPORT ON ITS RUN-IN', countdown: 'RUN-IN' },
    warning: { title: 'INBOUND', detail: 'POWER WEAPON CRATE', countdown: 'LANDS IN' },
    active: { title: 'CRATE DOWN', detail: 'HOLD INTERACT AT THE CRATE TO CLAIM IT', countdown: 'GONE IN' },
    'cooldown:claimed': { title: 'CRATE CLAIMED', own: { detail: 'YOUR TEAM HAS THE KRABER' }, enemy: { detail: 'THE ENEMY HAS THE KRABER' } },
    'cooldown:expired': { title: 'CRATE LOST', detail: 'NOBODY CLAIMED IT' },
    'done:claimed': { title: 'CRATE CLAIMED', own: { detail: 'YOUR TEAM HAS THE KRABER' }, enemy: { detail: 'THE ENEMY HAS THE KRABER' } },
    'done:expired': { title: 'CRATE LOST', detail: 'NOBODY CLAIMED IT' },
  },
  cues: {
    warning: { stinger: 'capture_start' },
    active: { stinger: 'capture_start' },
    cooldown: { stinger: 'neutralized' },
    done: { stinger: 'neutralized' },
  },
  tuning: AIRDROP_TUNING,
});

/* ------------------------------------------------------------ pure helpers */

/** Seeded 0..1 generator (mulberry32): the schedule, the flag pair and the cell. */
export function airdropRandom(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded value in [lo, hi]. */
export const airdropBetween = (rng, [lo, hi]) => lo + (hi - lo) * rng();

/**
 * Pairs of flags that front each other: different owners (neutral counts),
 * neither locked, at most `pairMaxM` apart, nearest first.
 */
export function airdropFlagPairs(flags, { pairMaxM = AIRDROP_TUNING.spot.pairMaxM, locked = null } = {}) {
  const open = (flags ?? []).filter(f => f && Number.isFinite(f.x) && Number.isFinite(f.z) && !locked?.(f));
  const pairs = [];
  for (let i = 0; i < open.length; i++) {
    for (let j = i + 1; j < open.length; j++) {
      const a = open[i], b = open[j];
      if ((a.owner ?? null) === (b.owner ?? null)) continue;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d <= pairMaxM) pairs.push({ a, b, d });
    }
  }
  return pairs.sort((p, q) => p.d - q.d || (p.a.id + p.b.id < q.a.id + q.b.id ? -1 : 1));
}

/** Heading (radians, 0 = toward -z, as a hull yaw) from its wire step. */
export const airdropHeading = (step, rules = AIRDROP_TUNING) => (((step | 0) * rules.headingStepDeg) % 360) * Math.PI / 180;

/**
 * Where the transport and the crate are `ms` after the warning began
 * (presentation; the server only times the phases). `spot` {x, y, z} is the
 * landing cell's feet point, `heading` the flight direction (radians).
 * Returns {plane: {x, y, z, yaw, visible}, crate: {x, y, z, state}} with the
 * crate state 'carried' (in the hold), 'falling' (under the canopy) or 'landed'.
 */
export function airdropPose(spot, heading, ms, rules = AIRDROP_TUNING) {
  const dirX = -Math.sin(heading), dirZ = -Math.cos(heading);
  const along = rules.planeSpeed * (ms - rules.approachMs) / 1000;
  const plane = { x: spot.x + dirX * along, y: spot.y + rules.planeM, z: spot.z + dirZ * along, yaw: heading,
    visible: ms >= 0 && ms <= rules.approachMs + rules.planeExitMs };
  let crate;
  if (ms < rules.approachMs) crate = { x: plane.x, y: plane.y - 2, z: plane.z, state: 'carried' };
  else if (ms < rules.approachMs + rules.descentMs) {
    const t = (ms - rules.approachMs) / rules.descentMs;
    // A short drift along the flight line as the canopy opens, then straight down.
    const drift = (1 - t) * (1 - t) * 6;
    crate = { x: spot.x + dirX * drift, y: spot.y + rules.releaseM * (1 - t), z: spot.z + dirZ * drift, state: 'falling' };
  } else crate = { x: spot.x, y: spot.y, z: spot.z, state: 'landed' };
  return { plane, crate };
}

/**
 * The landing cell's feet point from the wire anchor: the server lands the
 * crate on a cell centre (x + 0.5), which `ev` rounds up to the next whole
 * metre, so the centre is half a metre back; y is the feet height.
 */
export function airdropSpot(anchor) {
  if (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.z)) return null;
  return { x: anchor.x - 0.5, y: (Number.isFinite(anchor.y) ? anchor.y : 0) + 0.02, z: anchor.z - 0.5 };
}

/**
 * Milliseconds since the warning began from a decoded `ev` row (phase and
 * leftMs), or null when no drop is under way: the warning counts up from 0,
 * the active phase from the landing (approach + descent).
 */
export function airdropClock(event, rules = AIRDROP_TUNING) {
  if (!event) return null;
  const warn = rules.approachMs + rules.descentMs;
  if (event.phase === 'warning' && Number.isFinite(event.leftMs)) return Math.max(0, warn - event.leftMs);
  if (event.phase === 'active') return warn + (Number.isFinite(event.leftMs) ? Math.max(0, rules.activeMs - event.leftMs) : 0);
  return null;
}
