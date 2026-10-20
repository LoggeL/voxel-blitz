// Redrock Dam breach (docs/conquest.md "Map events" -> "Redrock Dam breach";
// docs/maps/redrock.md): the headline levolution of Redrock Canyon's flag C.
// Two ways to break it, both combat: demolition charges in the inspection
// gallery's portals (one arms a 35 s fuse, the second cuts what is left to
// 12 s), or the spillway's integrity pool (bombs, tank HE, rockets). Then a
// siren, a 20 m breach through the middle of the crest, and the flood field
// (shared/world/flood-field.js): the basin falls to the raised sill, a
// dam-break wave runs down the canyon and leaves it 2 m deeper for the
// round, so the crest, the canyon floor and the wash ford are closed to every
// hull and the trestle is the last southern crossing. Geometry comes from the
// dam site (shared/world/redrock-sites/dam.js, REDROCK_DAM in
// redrock-terrain.js); every number below is data the server controller
// (server/modes/conquest/map-events/dam.js), the bots and the HUD read.
import { defineMapEvent } from './define.js';

/** Gallery floor (y23 concrete) feet height, its centre line and the portal passages (x370-371, x396-397). */
const GALLERY_FEET = 24;
const GALLERY_Z = 383.5;
/** The charges sit inside the two portal passages, 2 m in from the mouths on the canyon side (z390): the bots' */
/* surface graph reaches the mouths from the canyon floor, but not the gallery behind them (it lies under the crest). */
const CHARGE_Z = 388;
/** The sill the breach leaves: the dam body stays up to y23, so the basin settles at y24.0 (its top water voxel y23). */
const SILL = 24;

/**
 * Event tuning (the controller, the field and the HUD read it; blocks in voxel units, ms engine time, s field time):
 *  fuse      one charge arms `oneMs`, the second cuts what is left to `bothMs` at most
 *  breach    the box brought down through the structural system when it strikes: the
 *            crest middle (x 374-393) through the dam body and the spillway apron
 *            (z 378-403) from `y0` up (the sill below stays); `crush` hurts what stands on it
 *  spillway  the second path: an integrity pool over the spillway face (Iron Bridge
 *            supportDamage table: 4 bombs, 14 tank HE or 16 rockets); at 0 the siren
 *            runs `warningMs` and the breach follows, the final blow credited
 *  flood     the field (buildDamFlood): `lake` the basin from its head z0 to the dam
 *            face, falling from `top` to `sill` as sill + h0/(1 + t/tauS)^2 with the
 *            riffle (z0..z1) keeping the north river's level; `gap` the over-sill sheet
 *            (`share` of the head plus a `film`) and the lake's pull to it (`suction`);
 *            `canyon` the 1-D run from the dam foot to the south edge: rows of `dz` m,
 *            stream surface `initial`, inflow qBase + q0/(1 + t/tauS)^3 m3/s after
 *            `delayS`, Chezy `chezy`, flux weight `theta` (damps ringing), held at `final`
 *            (+`slope` per m upstream) once it
 *            eases out of the run over `blendS`; tables at `hz` up to `endS`
 *  commit    voxels change only where the water has settled, one 16 x 16 column tile
 *            per job, at most `tilesPerS` jobs a second: the basin's cells above its
 *            level as the level passes them, the canyon's new water cells up to its final
 *            level once their row settles (both under the client's clip)
 *  physics   infantry deeper than `minDepth` drift with the flow (`carry` of it from
 *            `carryDepth` m), take `damage.k` x depth (<= 2 m) x speed^2 a second above
 *            `damage.min` (at most `damage.maxDps`), and are knocked off their feet above
 *            `knock.power`; light hulls (`hull.types`) deeper than they wade (or
 *            `hull.depth`) ride a flow over `hull.minFlow` and take `hull.wallFraction`
 *            of max HP a second when it pins them to a wall; heavy hulls stall (WADE_RULES)
 *  gallery   lethal water in the gallery for `ms` from the breach (`graceMs` to get out)
 *  zones     where bots keep out from the siren on: the crest gap (`gap`, for good) and
 *            the canyon floor under `canyonY1`, segment by segment (`segments` z edges)
 *            from `fleeLeadS` before the water reaches it
 *  closes    road crossings closed for bot drivers: the crest from the siren on, the
 *            wash ford once the water reaches it
 *  bots      commander rules (server/modes/conquest/map-events/dam.js botTasks): plant
 *            and breach while the crossing denial is worth `value.plant` m or more to the
 *            side, defuse while it costs it `value.defuse` m or more
 */
export const DAM_TUNING = Object.freeze({
  charges: Object.freeze([
    Object.freeze({ id: 'west', x: 371, y: GALLERY_FEET, z: CHARGE_Z }),
    Object.freeze({ id: 'east', x: 397, y: GALLERY_FEET, z: CHARGE_Z }),
  ]),
  fuse: Object.freeze({ oneMs: 35000, bothMs: 12000 }),
  breach: Object.freeze({ x0: 374, x1: 393, z0: 378, z1: 403, y0: SILL, y1: 37, chunkCap: 24,
    crush: Object.freeze({ damage: 60, hullFraction: 0.3 }) }),
  spillway: Object.freeze({ id: 'spillway', integrity: 1600, warningMs: 4000,
    boxes: Object.freeze([Object.freeze({ x0: 376, x1: 391, y0: 20, y1: 33, z0: 390, z1: 404 })]) }),
  flood: Object.freeze({
    lake: Object.freeze({ x0: 150, x1: 618, z0: 214, z1: 377, seedZ: 377, top: 27, sill: SILL, h0: 3, tauS: 30,
      riffle: Object.freeze({ z0: 214, z1: 236 }) }),
    gap: Object.freeze({ x0: 374, x1: 393, z0: 378, z1: 403, cutY: SILL, share: 2 / 3, film: 0.15,
      suction: Object.freeze({ radius: 40, near: 8 }) }),
    canyon: Object.freeze({ x0: 300, x1: 468, z0: 391, z1: 767, maxFloor: 32, dz: 2, initial: 20, final: 23.2, slope: 0.0008,
      q0: 1000, tauS: 50, delayS: 1.2, qBase: 60, chezy: 40, theta: 0.9, dtS: 0.1, hz: 10, endS: 120, rise: 0.3, settleCm: 3,
      blendS: Object.freeze([60, 105]) }),
  }),
  commit: Object.freeze({ tile: 16, tilesPerS: 4 }),
  physics: Object.freeze({
    minDepth: 0.4, carry: 0.75, carryDepth: 1.2, tickMs: 250,
    damage: Object.freeze({ k: 0.2, min: 16, maxDps: 22 }),
    knock: Object.freeze({ power: 45, up: 3, cooldownMs: 1500 }),
    hull: Object.freeze({ types: Object.freeze(['jeep', 'jeep_at', 'mortar']), depth: 1, minFlow: 2, carry: 0.8, wallFraction: 0.04 }),
  }),
  gallery: Object.freeze({ x0: 361, x1: 406, z0: 382.5, z1: 385.5, y0: 23, y1: 27.5, ms: 20000, graceMs: 1500 }),
  zones: Object.freeze({ canyonY1: 29, fleeLeadS: 14, segments: Object.freeze([391, 450, 520, 600, 680, 768]), x0: 330, x1: 438,
    gap: Object.freeze({ x0: 372, x1: 396, z0: 366, z1: 404, y0: 25 }) }),
  closes: Object.freeze({ crest: 'redrock-dam', ford: 'wash-ford', fordZ: 640 }),
  /** Planting in Breakthrough: only the attackers, only while flag C's sector is the active one. */
  breakthrough: Object.freeze({ flag: 'C' }),
  bots: Object.freeze({
    plantPriority: 6, plantSquad: 1, escortSquad: 1, guardRadius: 7,
    defusePriority: 9, defuseSquad: 1, shootPriority: 4,
    /** Crossing denial (metres of road per enemy hull minus per own hull) that makes the breach worth it, or the defuse. */
    value: Object.freeze({ plant: 100, defuse: -100, cacheMs: 10000, capM: 600 }),
    range: 120,
  }),
});

/** The charge index (0 west, 1 east) of an interaction point id ('plant-west', 'defuse-east'), or -1. */
export const damChargeIndex = id => DAM_TUNING.charges.findIndex(c => typeof id === 'string' && id.endsWith(`-${c.id}`));

const plant = c => ({ id: `plant-${c.id}`, x: c.x, y: c.y, z: c.z, radius: 2, holdMs: 4000, teams: 'any', verb: 'Plant charge', glyph: 'charge' });
const defuse = c => ({ id: `defuse-${c.id}`, x: c.x, y: c.y, z: c.z, radius: 2, holdMs: 5000, teams: 'rival', verb: 'Defuse charge', glyph: 'charge', enabled: false });

export const DAM_EVENT = defineMapEvent({
  id: 'dam',
  maps: ['redrock'],
  kind: 'levolution',
  name: 'Redrock Dam',
  short: 'DAM',
  glyph: 'flood',
  // The marker stands in the gallery between the two charges.
  anchor: { x: 384, y: GALLERY_FEET, z: GALLERY_Z },
  flag: 'C',
  big: true,
  repeat: null,
  breakthrough: true,
  durations: { armedMs: DAM_TUNING.fuse.oneMs, warningMs: 10000, activeMs: null },
  texts: {
    'armed:one': { title: 'CHARGE ARMED', countdown: 'BREACH IN',
      own: { detail: 'THE SECOND CHARGE CUTS THE FUSE TO 12 S' }, enemy: { detail: 'DEFUSE IT IN THE GALLERY' } },
    'armed:fuse': { title: 'BOTH CHARGES ARMED', countdown: 'BREACH IN',
      own: { detail: 'HOLD THE GALLERY' }, enemy: { detail: 'DEFUSE THE CHARGES IN THE GALLERY' } },
    'armed:defused': { title: 'CHARGE DEFUSED', countdown: 'BREACH IN', detail: 'ONE CHARGE LEFT IN THE GALLERY' },
    armed: { title: 'CHARGES ARMED', countdown: 'BREACH IN' },
    'idle:defused': { title: 'CHARGES DEFUSED' },
    warning: { title: 'BREACH IMMINENT', countdown: 'BREACH IN', detail: 'GET OFF THE CREST · OUT OF THE CANYON' },
    'warning:spillway': { title: 'SPILLWAY FAILING', countdown: 'BREACH IN', detail: 'GET OFF THE CREST · OUT OF THE CANYON' },
    active: { title: 'DAM BREACHED', detail: 'FLOOD WAVE IN THE CANYON · TRESTLE IS THE LAST SOUTHERN CROSSING' },
    done: { title: 'CANYON FLOODED', detail: 'VEHICLES CROSS AT THE TRESTLE AND THE NORTH BRIDGE' },
  },
  points: DAM_TUNING.charges.flatMap(c => [plant(c), defuse(c)]),
  targets: [{ id: DAM_TUNING.spillway.id, boxes: DAM_TUNING.spillway.boxes, integrity: DAM_TUNING.spillway.integrity }],
  killKeys: {
    damFlood: { label: 'FLOOD', icon: 'flood' },
    damBreach: { label: 'DAM BREACH', icon: 'collapse' },
  },
  cues: {
    armed: { stinger: 'capture_start', enemy: 'under_attack' },
    warning: { stinger: 'ticket_low' },
    active: { stinger: 'neutralized' },
  },
  tuning: DAM_TUNING,
});
