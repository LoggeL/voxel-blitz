// Signal Rock relay and radio mast (docs/conquest.md "Signal Rock relay";
// Frontier, east half, between D and bridge-north; the place itself is built
// by shared/world/frontier-sites/locations.js `signalRock`).
//
// Relay: a side that completes the 8 s hold inside the relay bunker owns the
// relay (phase `active`, `team` the owner, no tickets) until the other side
// completes the hold in turn; the hold only runs while no enemy of the holder
// stands within `capture.contestRadiusM` of the bunker. Every `scan.everyMs`
// the owner's relay marks every living enemy (on foot or aboard, and every
// crewed enemy hull, aircraft included) within `scan.radiusM` of the mast as spotted for
// `scan.revealMs`: the ordinary spot marks (players[].cq spotted,
// vehicles[].sp), so the HUD, the minimap and the bots read them as any spot.
//
// Mast: one integrity pool at its feet (the concrete foundation and the
// first five metres of the lattice), hit by explosions only (the Iron
// Bridge's `supportDamage` table: six rockets) or by the demolition charge a
// rival of the owner plants at the mast's north foot (5 s hold, 5 s fuse,
// three quarters of the pool). At 0 the mast groans (`warning`, 4 s), then
// topples north about its north foot over `fall.fallMs` and lies across the
// north loop road; the relay is offline for the round (`done`).
//
// The fall is deterministic: the standing cells rotate rigidly by
// `fall.restDeg` about the hinge line (x axis through `fall.hinge`), which
// lays the tip about 3 m past the road's north edge (z 134); where the
// wreck crosses the road (the road's half width plus `fall.roadPad`) it is
// crushed to one layer on the road surface, so hulls (step 1 m) still pass.
import { defineMapEvent } from './define.js';

/** Fixed geometry of the Signal Rock mast and bunker (frontier-sites/locations.js RELAY; foundation top y30, bunker floor y27). */
export const RELAY_SITE = Object.freeze({
  /** Every solid cell in this box above the foundation is the standing mast (177 cells: posts, rings, platforms, top, dipole, light). */
  mast: Object.freeze({ x0: 466, y0: 31, z0: 166, x1: 470, y1: 62, z1: 170 }),
  /** The integrity target: the foundation and the lattice's first five metres. */
  feet: Object.freeze({ x0: 466, y0: 30, z0: 166, x1: 470, y1: 35, z1: 170 }),
  /** Centre of the bunker floor (interior x 475-482, z 156-161). */
  bunker: Object.freeze({ x: 478.5, y: 28, z: 158.5 }),
  /** Centre of the mast (scan origin). */
  mastCentre: Object.freeze({ x: 468.5, y: 31, z: 168.5 }),
});

export const RELAY_EVENT = defineMapEvent({
  id: 'relay',
  maps: ['frontier'],
  kind: 'control',
  name: 'Signal Rock Relay',
  short: 'RELAY',
  glyph: 'event-relay',
  anchor: { x: RELAY_SITE.bunker.x, y: 30, z: RELAY_SITE.bunker.z },
  flag: 'D',
  big: true,
  repeat: null,
  // Off in Breakthrough: Signal Rock stands behind the front through sectors 1 and 2, so only the defenders could take it.
  breakthrough: false,
  durations: { warningMs: 4000 },
  texts: {
    active: {
      title: 'RELAY TAKEN',
      own: { title: 'RELAY SECURED', detail: 'SCAN EVERY 25 S MARKS ENEMIES WITHIN 180 M' },
      enemy: { title: 'RELAY LOST', detail: 'RETAKE THE BUNKER OR BLOW THE MAST' },
    },
    armed: { title: 'MAST FAILING', detail: 'CLEAR THE FALL LINE NORTH OF THE MAST' },
    warning: { title: 'MAST FAILING', detail: 'CLEAR THE FALL LINE NORTH OF THE MAST', countdown: 'FALLS IN' },
    done: { title: 'MAST DOWN', detail: 'RELAY OFFLINE · WRECK ACROSS THE NORTH LOOP' },
  },
  points: [
    { id: 'relay', x: 479.5, y: 28, z: 158.5, radius: 3, holdMs: 8000, teams: 'any', verb: 'Take relay', glyph: 'event-relay' },
    { id: 'charge', x: 468.5, y: 31, z: 165.5, radius: 2.5, holdMs: 5000, teams: 'rival', verb: 'Plant charge', glyph: 'charge', enabled: false },
  ],
  targets: [{ id: 'mast', integrity: 600, boxes: [RELAY_SITE.feet] }],
  killKeys: { relayMast: { label: 'RADIO MAST', icon: 'collapse' }, relayCharge: { label: 'DEMO CHARGE', icon: 'charge' } },
  cues: { active: { stinger: 'capture_start' }, warning: { stinger: 'ticket_low' }, done: { stinger: 'neutralized' } },
  tuning: {
    scan: { everyMs: 25000, firstMs: 6000, radiusM: 180, revealMs: 4000 },
    capture: { contestRadiusM: 14, contestDy: 6 },
    charge: { fuseMs: 5000, damage: 450, blastR: 4, blastDamage: 80, hullFraction: 0.1 },
    fall: {
      hinge: [468.5, 31, 167], restDeg: 96, fallMs: 2600, roadId: 'north-loop', roadPad: 1,
      crushW: 3.5, crushLen: 34, crushDamage: 999, hullFraction: 0.5, cellsPerTick: 40,
    },
    damagedShare: 0.5,
    bots: {
      cycleMs: 120000, takeMs: 60000, takePriority: 2, takeSquad: 1, escortSquad: 2, range: 260,
      defendNearM: 45, defendPriority: 3, defendSquad: 2,
      chargeAfterMs: 20000, chargePriority: 2, chargeKits: ['engineer', 'grenadier', 'support', 'assault'],
    },
  },
});

const finite = Number.isFinite;

/**
 * Where a standing mast cell lies after the fall: the cell centre rotated by
 * `restDeg` about the x axis through `hinge`, the top toward -z (north),
 * floored. Pure; the collapse event's spin (`w = [-rate, 0, 0]`) and the
 * client chunk use the same rotation (shared/structure.js collapseMatrix).
 */
export function relayFallenCell(x, y, z, fall = RELAY_EVENT.tuning.fall) {
  const [, py, pz] = fall.hinge, a = fall.restDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const ry = y + 0.5 - py, rz = z + 0.5 - pz;
  return [x, Math.floor(py + ry * c + rz * s), Math.floor(pz + rz * c - ry * s)];
}

/** Flat distance from (x, z) to a road polyline ([[x, y, z], ...]). */
export function roadDistance(points, x, z) {
  let best = Infinity;
  for (let i = 1; i < (points?.length ?? 0); i++) {
    const [ax, , az] = points[i - 1], [bx, , bz] = points[i];
    const vx = bx - ax, vz = bz - az, len2 = vx * vx + vz * vz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + vx * t), z - (az + vz * t)));
  }
  return best;
}

/** The crush line of the fall (a hazard zone shape): from the hinge to past the tip. */
export function relayCrushLine(fall = RELAY_EVENT.tuning.fall) {
  const [hx, hy, hz] = fall.hinge;
  return { shape: 'line', ax: hx, az: hz, bx: hx, bz: hz - fall.crushLen, w: fall.crushW, y0: hy - 8, y1: hy + 6 };
}

/** True while a decoded relay row says the relay is online and held. */
export const relayHeld = event => !!event && event.phase === 'active' && !!event.team;
/** Seconds to the next scan of a held relay from a decoded row, or null. */
export const relayScanSeconds = event => (relayHeld(event) && finite(event.leftMs) ? Math.ceil(event.leftMs / 1000) : null);
