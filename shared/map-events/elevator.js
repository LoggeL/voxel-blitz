// Kestrel Halt grain elevator topple, a Frontier map event (docs/conquest.md
// "Map events" / "Kestrel Halt grain elevator"; server half in
// server/modes/conquest/map-events/elevator.js).
//
// The 25 m timber elevator of Kestrel Halt (west half, between A, C and the
// West HQ) stands on a concrete foundation over a drive-through bay. Its base
// is an integrity target (rockets, tank shells, jet bombs, mines, mortar: the
// Iron Bridge's supportDamage table), and either side may plant a demolition
// charge in the bay that the other side can defuse. At zero integrity (or
// when the fuse runs out) the timber creaks for `warningMs`, then the tower
// topples east over its foundation edge: the structural system brings every
// block down as chunks that turn a quarter and land along the fall line, a
// crush line along the footprint kills what is left under it, and a staged
// rubble pile lies across the a-c road as cover. The sniper perch on the bin
// top (16 m) and the headhouse roof (21-25 m) is gone with it.
//
// Every number is data below; the geometry matches HALT.elevator in
// shared/world/frontier-sites/locations.js (276-282 x 331-337, foundation at
// y 29, pinned against the real world by tools/conquest-map-event-elevator-test.mjs).
import { AIR, CORRUGATED_STEEL, FLUID_BLOCKS, PLANK, TIMBER, isSolidBlock } from '../world/blocks.js';
import { defineMapEvent } from './define.js';

/** The standing structure and its fall (voxel boxes inclusive; x east, z south). */
export const KESTREL_ELEVATOR = Object.freeze({
  /** Timber bin y 30-45 (the bay x 277-281 open at y 30-32), headhouse y 46-50, gable roof y 51-54. */
  box: Object.freeze({ x0: 276, y0: 30, z0: 331, x1: 282, y1: 55, z1: 337 }),
  /** The concrete foundation the bin stands on (it stays: the stump). */
  foundationY: 29,
  /** The sniper perch: the bin-top ledge and the headhouse roof. */
  perch: Object.freeze({ x0: 276, y0: 46, z0: 331, x1: 282, y1: 56, z1: 337 }),
  /** The fall: over the east foundation edge, across the a-c road (x 304-311 at z 334). */
  hinge: Object.freeze({ x: 283, y: 30, z: 334.5 }),
  dir: Object.freeze([1, 0]),
  /** Chunks centred at least this many metres over the hinge are thrown along the fall; the bay frame crumbles in place. */
  minRise: 4,
});

/**
 * The rubble pile the fallen elevator leaves (`along` counts cells east of
 * the hinge, `profile[d]` the pile height d cells off the fall axis z 334):
 * the bin lies on its side as a stepped 3-voxel ridge (waist cover a walker
 * steps over from either side), two one-voxel breaches cut through it, the
 * headhouse is a 2-voxel heap beside the road and the corrugated roof lies
 * across the road as one-voxel sheets with holes that a jeep or a tank rolls
 * over. Splinters scatter beside the bin. Hash-seeded, so every engine lays
 * the same blocks.
 */
export const KESTREL_ELEVATOR_RUBBLE = Object.freeze({
  axisZ: 334,
  segments: Object.freeze([
    Object.freeze({ from: 0, to: 15, profile: Object.freeze([3, 3, 2, 1]), block: TIMBER, alt: PLANK, altShare: 0.25 }),
    Object.freeze({ from: 16, to: 20, profile: Object.freeze([2, 2, 1]), block: PLANK, alt: TIMBER, altShare: 0.2 }),
    Object.freeze({ from: 21, to: 25, profile: Object.freeze([1, 1, 1, 1]), block: CORRUGATED_STEEL, holes: 0.3 }),
  ]),
  /** Along cells where the bin ridge drops to one voxel: walk-through lanes. */
  breaches: Object.freeze([5, 6, 11, 12]),
  splinters: Object.freeze({ from: 0, to: 18, offAxis: Object.freeze([4, 5]), share: 0.22, block: PLANK }),
  /** Ground under the pile is searched from this many voxels over the hinge down. */
  scanUp: 6,
});

const hash01 = (x, z, salt) => {
  let h = Math.imul(x * 73856093 ^ z * 19349663 ^ salt * 83492791, 0x9e3779b1);
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
};

/** Top solid (non-fluid) voxel of a column at or below `fromY`, or -1. */
function groundTop(getBlock, x, z, fromY) {
  for (let y = fromY; y > 0; y--) {
    const b = getBlock(x, y, z);
    if (isSolidBlock(b) && !FLUID_BLOCKS.has(b)) return y;
  }
  return -1;
}

/**
 * The rubble cells on the current world, from the hinge outward (the order
 * the staged edit lays them, so the pile grows out along the fall): a flat
 * [x, y, z, block, ...] list, only into open (non-solid) cells.
 */
export function planElevatorRubble(getBlock, { tower = KESTREL_ELEVATOR, rubble = KESTREL_ELEVATOR_RUBBLE } = {}) {
  const out = [];
  const x0 = tower.hinge.x, top = tower.hinge.y + rubble.scanUp;
  const open = (x, y, z) => { const b = getBlock(x, y, z); return b === AIR || (!isSolidBlock(b) && !FLUID_BLOCKS.has(b)); };
  const lay = (x, z, h, pick) => {
    const g = groundTop(getBlock, x, z, top);
    if (g < 0) return;
    for (let k = 1; k <= h; k++) if (open(x, g + k, z)) out.push(x, g + k, z, pick(k));
  };
  const last = Math.max(...rubble.segments.map(s => s.to));
  for (let along = 0; along <= last; along++) {
    const x = x0 + along;
    const seg = rubble.segments.find(s => along >= s.from && along <= s.to);
    if (seg) {
      for (let d = -(seg.profile.length - 1); d < seg.profile.length; d++) {
        const z = rubble.axisZ + d;
        if (seg.holes && hash01(x, z, 1) < seg.holes) continue;
        let h = seg.profile[Math.abs(d)];
        if (seg.from === 0 && rubble.breaches.includes(along)) h = Math.min(h, 1);
        lay(x, z, h, k => (seg.alt && hash01(x, z * 31 + k, 2) < seg.altShare ? seg.alt : seg.block));
      }
    }
    const sp = rubble.splinters;
    if (along >= sp.from && along <= sp.to) {
      for (const off of sp.offAxis) for (const side of [-1, 1]) {
        const z = rubble.axisZ + side * off;
        if (hash01(x, z, 3) < sp.share) lay(x, z, 1, () => sp.block);
      }
    }
  }
  return out;
}

/** The structure's solid cells now, bottom up (the doomed list; the foundation stays). */
export function elevatorTowerCells(getBlock, tower = KESTREL_ELEVATOR) {
  const out = [];
  const b = tower.box;
  for (let y = b.y0; y <= b.y1; y++) for (let z = b.z0; z <= b.z1; z++) for (let x = b.x0; x <= b.x1; x++) {
    if (isSolidBlock(getBlock(x, y, z))) out.push(x, y, z, AIR);
  }
  return out;
}

/** True while the elevator stands: most of the headhouse is there (a perch to climb onto). */
export function elevatorStanding(getBlock, tower = KESTREL_ELEVATOR) {
  const b = tower.box, y = tower.perch.y0 + 2;
  let solid = 0, n = 0;
  for (let z = b.z0 + 1; z <= b.z1 - 1; z++) for (let x = b.x0 + 1; x <= b.x1 - 1; x++) { n++; if (isSolidBlock(getBlock(x, y, z))) solid++; }
  return solid >= n / 2;
}

/** The fall line: footprint centre out to the roof's landing, as a shared-geometry capsule. */
export function elevatorFallZone(tower = KESTREL_ELEVATOR, rubble = KESTREL_ELEVATOR_RUBBLE, pad = 1) {
  const b = tower.box, last = Math.max(...rubble.segments.map(s => s.to));
  const half = Math.max(...rubble.segments.map(s => s.profile.length)) - 0.5 + pad;
  return Object.freeze({ shape: 'line', ax: (b.x0 + b.x1 + 1) / 2, az: tower.hinge.z, bx: tower.hinge.x + last + 1, bz: tower.hinge.z, w: half });
}

export const ELEVATOR_EVENT = defineMapEvent({
  id: 'elevator',
  maps: ['frontier'],
  kind: 'levolution',
  name: 'Kestrel Elevator',
  short: 'ELEVATOR',
  glyph: 'event-elevator',
  anchor: { x: 279.5, y: 46, z: 334.5 },
  flag: 'A',
  big: true,
  repeat: null,
  // Breakthrough too: the elevator overlooks sector 1 (A) and the a-c road into sector 2.
  breakthrough: true,
  durations: { armedMs: 15000, warningMs: 4000, activeMs: 6000 },
  texts: {
    armed: { title: 'CHARGE PLANTED', countdown: 'BLOWS IN', own: { detail: 'GUARD THE CHARGE IN THE BAY' }, enemy: { detail: 'DEFUSE IT IN THE BAY' } },
    'armed:queued': { title: 'CRACKING', detail: 'TOPPLES SOON · CLEAR THE FALL LINE EAST' },
    warning: { title: 'GIVING WAY', countdown: 'TOPPLES IN', detail: 'CLEAR THE FALL LINE EAST' },
    active: { title: 'COMING DOWN', detail: 'FALLING EAST ACROSS THE A-C ROAD' },
    done: { title: 'DOWN', detail: 'RUBBLE COVER ON THE A-C ROAD · PERCH GONE' },
    'idle:defused': { title: 'CHARGE DEFUSED' },
  },
  points: [
    { id: 'plant', x: 279.5, y: 30, z: 334.5, radius: 2.5, holdMs: 5000, teams: 'any', verb: 'Plant charge', glyph: 'charge' },
    { id: 'defuse', x: 279.5, y: 30, z: 334.5, radius: 2.5, holdMs: 4000, teams: 'rival', verb: 'Defuse charge', glyph: 'charge', enabled: false },
  ],
  // The base: the foundation and the bay frame (the bridge table: 7 rockets, 6 HE shells, 2 bombs, 18 mortar rounds).
  targets: [{ id: 'base', integrity: 700, boxes: [{ x0: 276, y0: 29, z0: 331, x1: 282, y1: 33, z1: 337 }] }],
  killKeys: { elevator: { label: 'ELEVATOR', icon: 'collapse' } },
  tuning: {
    /** Integrity share at or below which a 'damaged' note goes out (HUD banner, creak). */
    damagedAt: 0.5,
    /** A defused charge closes the bay to a new plant this long. */
    replantMs: 20000,
    /** After the warning: the creak (STRUCTURE_RULES.creakMs) then the fall; the crush line fires and the pile starts this long after the release. */
    crushDelayMs: 550,
    rubbleDelayMs: 380,
    /** Rubble cells laid per tick (inside the shared staged-edit budget): about 0.9 s for the pile. */
    rubbleCellsPerTick: 6,
    /** Doomed tower blocks may fall as this many chunks (the structural default is 12). */
    chunkCap: 16,
    /** Crush line: lethal to infantry, a share of max HP to ground hulls (the trigger's team is spared). */
    crush: { damage: 999, hullFraction: 0.35 },
    /** Bots: who plants (the side that does not hold `flag`, EAST when nobody does), task sizes and reach. */
    bots: { plantPriority: 2, plantSquad: 1, guardPriority: 3, guardSquad: 2, defusePriority: 4, defuseSquad: 1, escortSquad: 1, range: 170, guardRadius: 9 },
  },
});
