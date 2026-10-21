// Flag radars (docs/conquest.md "Flag radars"; server half in
// server/modes/conquest/map-events/radar.js). Two per battlefield, each bound
// to a flag: Frontier D (the Ridge Bunkers' radar dome and observation tower)
// and B (the antenna on St. Aldric's bell tower, whose belfry is climbable);
// Redrock D (the Mesa radome and its dish tower) and A (the antenna on the
// Palmera bell tower).
//
// Ownership is the flag's: whoever holds the flag owns its radar (phase
// `active`, `team` the owner); a neutral flag has none (`idle`). Every
// `everyMs` the owner's radar sweeps around the FLAG (not the structure, so
// both sides' radars cover the same ground): every crewed enemy ground hull
// within `groundM` and every enemy aircraft within `airM` (helicopters,
// transports, jets, a linked FPV drone) is spotted for `revealMs` through
// the ordinary spot marks (`vehicles[].sp`), which the maps, the mortar's
// RMB snap and the bot gunners already read. Never infantry: no wallhack.
//
// The structure is one integrity pool (`integrity` 600 over every part's
// boxes, the Iron Bridge's supportDamage table: 6 RX-8 rockets, 5 tank HE,
// 2 jet bombs or 15 mortar rounds). At 0 it groans for `groanMs`, then it
// comes down through the structural system (StagedEdits `fall`): a toppling
// part falls over its hinge edge as chunks that land as a wreck (no road
// pad, the wreck stays), the other parts collapse in place. The radar is
// gone for the round whoever holds the flag; nothing repairs it.
//
// Every number is data below; the geometry matches the site generators
// (shared/world/frontier-sites/bunkers.js and village.js,
// shared/world/redrock-sites/radar.js and oasis.js) and is checked against
// the real worlds by tools/conquest-map-event-radar-test.mjs.
import {
  ACCENT, CONCRETE, CORRUGATED_STEEL, METAL, PALE, PLANK, RUST, TERRACOTTA_ROOF, TIMBER, TRUCK_RED, WHITE_PLASTER,
} from '../world/blocks.js';
import { FRONTIER_PLAN } from '../conquest-contract.js';
import { REDROCK_PLAN } from '../world/redrock-plan.js';
import { defineMapEvent } from './define.js';

/**
 * Shared tuning of every radar.
 *   groundM / airM   sweep radii round the flag: crewed ground hulls / aircraft and drones
 *   everyMs          one sweep every 15 s while owned; `firstMs` after a capture
 *   revealMs         how long a sweep's spot mark lasts
 *   integrity        the structure's pool; `damagedShare` the 'damaged' note
 *   groanMs          the warning between the last blow and the fall
 *   landMs           the fall's chunks are down by then (the event is `done` at the fall's start)
 *   avoidPad         metres the bots' fall-line avoid zone adds round the parts
 *   bots             see RadarController.botTasks
 */
export const RADAR_TUNING = Object.freeze({
  groundM: 240, airM: 400, everyMs: 15000, firstMs: 5000, revealMs: 5000,
  integrity: 600, damagedShare: 0.5, groanMs: 3000, landMs: 6000, avoidPad: 3,
  bots: Object.freeze({
    /** Demolish an enemy radar once it swept this many own hulls within `sweptWindowMs`. */
    sweptHulls: 2, sweptWindowMs: 60000,
    /** Or deny one: its flag neither ours for `denyAfterMs` and an enemy hull in its ground ring. */
    denyAfterMs: 30000,
    /** Engineers (RX-8) booked to close on it (squad, priority, how near), then the shoot task fires from 25 to 120 m. */
    kits: Object.freeze(['engineer']), squad: 2, priority: 4, approachM: 70, minRange: 25, range: 120,
    /** Commander weight: a flag whose radar stands counts this many metres nearer for attack and one more threat for defence. */
    flagWeightM: 80,
  }),
});

const box = (x0, y0, z0, x1, y1, z1) => Object.freeze({ x0, y0, z0, x1, y1, z1 });

/**
 * The four radars. Per site: `map`, `flag`, `name`, `anchor` (marker point,
 * the dome or antenna top), and `parts` in fall order: each part's `boxes`
 * (inclusive voxel boxes, every one also an integrity box), the `blocks` it
 * is made of (null: every solid block in the boxes; the terrain never is),
 * `exclude` boxes another part owns, and `topple` {hinge [x, y, z], dir
 * [x, z], minRise} for a directed fall (StructureSystem.bringDown `fall`),
 * `chunkCap` its structural chunks, `integrity: false` for a part blasts on
 * it do not count against (it only comes down with the radar). A part listed
 * first comes down first (a nave roof before the tower that falls onto it).
 * `mount` {x, y, z, scale} is where the client's rotating antenna stands (the
 * floor of the air cell over the dome's or the mast's top voxel: a three.js
 * model, never map voxels, public/js/fx/map-events/radar-head.js).
 */
export const RADAR_SITES = Object.freeze({
  // Frontier D, Ridge Bunkers: the dome collapses on its drum, the observation
  // tower topples north across the north trench, away from the flag (the
  // zone's north-east edge passes 20 m from the tower).
  'radar-ridge': Object.freeze({
    map: 'frontier', flag: 'D', name: 'Ridge Radar', anchor: Object.freeze({ x: 528.5, y: 44, z: 226.5 }),
    mount: Object.freeze({ x: 528.5, y: 44, z: 226.5, scale: 1 }),
    parts: Object.freeze([
      Object.freeze({ id: 'dome', boxes: Object.freeze([box(523, 35, 221, 534, 44, 232)]), blocks: Object.freeze([CONCRETE, PALE, METAL]), chunkCap: 6 }),
      Object.freeze({ id: 'tower', boxes: Object.freeze([box(509, 34, 229, 515, 60, 235)]),
        blocks: Object.freeze([METAL, RUST, PLANK, CORRUGATED_STEEL, TIMBER, ACCENT]), chunkCap: 12,
        topple: Object.freeze({ hinge: Object.freeze([512.5, 34, 229]), dir: Object.freeze([0, -1]), minRise: 3 }) }),
    ]),
  }),
  // Frontier B, St. Aldric: the antenna on the bell tower's cornice. The tower
  // above its first storey topples east onto the nave, whose roof caves in
  // first, so the hard point turns into an open rubble fight; the flag zone
  // (20 m round the square) ends at the nave's north wall.
  'radar-aldric': Object.freeze({
    map: 'frontier', flag: 'B', name: 'St. Aldric Radar', anchor: Object.freeze({ x: 266.5, y: 71, z: 541.5 }),
    mount: Object.freeze({ x: 266.5, y: 72, z: 541.5, scale: 0.8 }),
    parts: Object.freeze([
      Object.freeze({ id: 'roof', boxes: Object.freeze([box(265, 43, 539, 287, 50, 553)]), blocks: Object.freeze([TERRACOTTA_ROOF, WHITE_PLASTER]),
        exclude: Object.freeze([box(258, 0, 542, 265, 99, 550)]), chunkCap: 10, integrity: false }),
      Object.freeze({ id: 'tower', boxes: Object.freeze([box(257, 41, 541, 265, 59, 551), box(257, 60, 539, 267, 78, 552)]), blocks: null, chunkCap: 14,
        topple: Object.freeze({ hinge: Object.freeze([266, 41, 546.5]), dir: Object.freeze([1, 0]), minRise: 3 }) }),
    ]),
  }),
  // Redrock D, Mesa Radar: the radome collapses on its drum, the dish tower
  // topples east, away from the flag.
  'radar-mesa': Object.freeze({
    map: 'redrock', flag: 'D', name: 'Mesa Radar', anchor: Object.freeze({ x: 564.5, y: 47, z: 249.5 }),
    mount: Object.freeze({ x: 564.5, y: 46, z: 249.5, scale: 1.3 }),
    parts: Object.freeze([
      Object.freeze({ id: 'dome', boxes: Object.freeze([box(556, 34, 241, 573, 47, 258)]), blocks: Object.freeze([CONCRETE, PALE, PLANK, METAL, RUST]), chunkCap: 8 }),
      Object.freeze({ id: 'dish', boxes: Object.freeze([box(563, 32, 258, 572, 58, 268)]), blocks: Object.freeze([METAL, RUST, PALE, TRUCK_RED]), chunkCap: 10,
        topple: Object.freeze({ hinge: Object.freeze([572, 32, 263.5]), dir: Object.freeze([1, 0]), minRise: 3 }) }),
    ]),
  }),
  // Redrock A, Palmera Oasis: the antenna on the mission's bell tower; the
  // tower above its first storey topples north, off the mission and away
  // from the flag.
  'radar-palmera': Object.freeze({
    map: 'redrock', flag: 'A', name: 'Palmera Radar', anchor: Object.freeze({ x: 266.5, y: 57, z: 247.5 }),
    mount: Object.freeze({ x: 266.5, y: 58, z: 247.5, scale: 0.8 }),
    parts: Object.freeze([
      Object.freeze({ id: 'tower', boxes: Object.freeze([box(262, 33, 245, 267, 58, 249), box(262, 38, 250, 267, 58, 250)]), blocks: null, chunkCap: 10,
        topple: Object.freeze({ hinge: Object.freeze([264.5, 33, 245]), dir: Object.freeze([0, -1]), minRise: 3 }) }),
    ]),
  }),
});

const PLANS = Object.freeze({ frontier: FRONTIER_PLAN, redrock: REDROCK_PLAN });
/** The sweep's centre: the radar's flag {x, z} (the map plan's, as the capture state's). */
export function radarCentre(site) {
  const f = PLANS[site?.map]?.flags?.find(flag => flag.id === site.flag);
  return f ? { x: f.x, z: f.z } : null;
}

/** The part the antenna's mount stands on (the one whose boxes hold the voxel under it): it falls with that part. */
export function radarMountPart(site) {
  const m = site?.mount;
  if (!m) return null;
  const x = Math.floor(m.x), y = Math.floor(m.y) - 1, z = Math.floor(m.z);
  return site.parts.find(p => p.boxes.some(b => inBox(b, x, y, z))) ?? null;
}

/** Every radar id on a map. */
export const radarIdsFor = mapId => Object.keys(RADAR_SITES).filter(id => RADAR_SITES[id].map === mapId);

const inBox = (b, x, y, z) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && z >= b.z0 && z <= b.z1;

/**
 * The solid cells of one part on the current world, bottom up: a flat
 * [x, y, z, 0, ...] list (the StagedEdits `fall` job). `isSolid(block)`
 * decides solidity (shared/world/blocks.js isSolidBlock); `taken` (a Set of
 * "x,y,z") skips cells an earlier part listed and records this part's.
 */
export function radarPartCells(getBlock, part, isSolid, taken = new Set()) {
  const out = [];
  const blocks = part.blocks ? new Set(part.blocks) : null;
  for (const b of part.boxes) {
    for (let y = b.y0; y <= b.y1; y++) for (let z = b.z0; z <= b.z1; z++) for (let x = b.x0; x <= b.x1; x++) {
      const key = `${x},${y},${z}`;
      if (taken.has(key) || (part.exclude ?? []).some(e => inBox(e, x, y, z))) continue;
      const v = getBlock(x, y, z);
      if (!isSolid(v) || (blocks && !blocks.has(v & 255))) continue;
      taken.add(key);
      out.push(x, y, z, 0);
    }
  }
  return out;
}

/**
 * The flat zone a part's fall sweeps (the bots' avoid zone through the
 * groan and the fall): a topple's line from the hinge out along `dir` by the
 * part's height over it, else the part's footprint; `pad` metres round it.
 */
export function radarFallZone(part, pad = RADAR_TUNING.avoidPad) {
  const xs = part.boxes.flatMap(b => [b.x0, b.x1 + 1]), zs = part.boxes.flatMap(b => [b.z0, b.z1 + 1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const t = part.topple;
  if (!t) return { shape: 'box', x0: x0 - pad, z0: z0 - pad, x1: x1 + pad, z1: z1 + pad };
  const [hx, hy, hz] = t.hinge, [ux, uz] = t.dir;
  const rise = Math.max(...part.boxes.map(b => b.y1 + 1)) - hy;
  const across = Math.abs(ux) > Math.abs(uz) ? (z1 - z0) / 2 : (x1 - x0) / 2;
  const back = Math.abs(ux) > Math.abs(uz) ? (x1 - x0) : (z1 - z0);
  return { shape: 'line', ax: hx - ux * back, az: hz - uz * back, bx: hx + ux * rise, bz: hz + uz * rise, w: across + pad };
}

/** Every integrity box of a site: its parts' boxes, except a part that only comes down with it (`integrity: false`, St. Aldric's nave roof). */
export const radarBoxes = site => site.parts.filter(p => p.integrity !== false).flatMap(p => p.boxes);

/** True while a decoded radar row says the radar stands and a side owns it. */
export const radarOnline = event => !!event && event.phase === 'active' && !!event.team;
/** True once the radar's pool is spent: groaning (`warning`) or down (`done`). */
export const radarDown = event => !!event && (event.phase === 'warning' || event.phase === 'done');
/** Seconds to the next sweep of an owned radar from a decoded row, or null. */
export const radarSweepSeconds = event => (radarOnline(event) && Number.isFinite(event.leftMs) ? Math.ceil(event.leftMs / 1000) : null);

function radarEvent(id) {
  const site = RADAR_SITES[id], T = RADAR_TUNING;
  return defineMapEvent({
    id,
    maps: [site.map],
    kind: 'control',
    name: site.name,
    short: `RADAR ${site.flag}`,
    glyph: 'event-radar',
    anchor: { [site.map]: site.anchor },
    flag: site.flag,
    // A small event: its groan never waits behind a dam or a bridge (no director slot).
    big: false,
    repeat: null,
    breakthrough: true,
    durations: { warningMs: T.groanMs },
    texts: {
      active: {
        title: 'RADAR ONLINE',
        own: { title: 'RADAR ONLINE', detail: `SWEEPS ENEMY VEHICLES AND AIRCRAFT EVERY ${T.everyMs / 1000} S` },
        enemy: { title: 'ENEMY RADAR', detail: `YOUR VEHICLES NEAR ${site.flag} ARE SWEPT · DESTROY IT` },
      },
      warning: { title: 'RADAR FAILING', detail: 'CLEAR THE FALL LINE', countdown: 'FALLS IN' },
      done: { title: 'DESTROYED', detail: `${site.flag} LOSES ITS SWEEP` },
    },
    targets: [{ id: 'radar', integrity: T.integrity, boxes: radarBoxes(site) }],
    // No kill key of its own: the falling chunks crush as the structural system's COLLAPSE, credited to the last blow.
    cues: { warning: { stinger: 'ticket_low' }, done: { stinger: 'neutralized' } },
    tuning: { ...T, site },
  });
}

/** The four radar definitions (one registry slot: shared/map-events/registry.js lists them spread). */
export const RADAR_EVENTS = Object.freeze(Object.keys(RADAR_SITES).map(radarEvent));
