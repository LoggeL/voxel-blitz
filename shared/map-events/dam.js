// Redrock Dam breach (docs/conquest.md "Map events" -> "Redrock Dam breach";
// docs/maps/redrock.md): the headline levolution of Redrock Canyon's flag C.
// Two demolition charges in the inspection gallery's portals; both set, a 40 s fuse;
// then a 10 s siren, a 20 m breach through the middle of the crest, the
// reservoir draining to the sill over 45 s and a flood wave running down the
// canyon, which stays 2 m higher. Geometry comes from the dam site
// (shared/world/redrock-sites/dam.js, REDROCK_DAM in redrock-terrain.js);
// every number below is data the server controller
// (server/modes/conquest/map-events/dam.js), the bots and the HUD read.
import { defineMapEvent } from './define.js';

/** Gallery floor (y23 concrete) feet height, its centre line and the portal passages (x370-371, x396-397). */
const GALLERY_FEET = 24;
const GALLERY_Z = 383.5;
/** The charges sit inside the two portal passages, 2 m in from the mouths on the canyon side (z390): the bots' */
/* surface graph reaches the mouths from the canyon floor, but not the gallery behind them (it lies under the crest). */
const CHARGE_Z = 388;

/**
 * Event tuning (the controller and the HUD read it; blocks in voxel units, ms engine time):
 *  breach    the box brought down through the structural system when it strikes: the
 *            crest middle (x 374-393) through the whole dam body and the spillway apron
 *            (z 378-403) from the sill (top y21 stays) up; `crush` hurts what stands on it
 *  drain     every reservoir water cell above `level` connected to the upstream face
 *            (z 377) turns to air over `ms`, top layer first, nearest the breach first
 *  canyon    the canyon (z >= `z0`) floods to `level` (top water voxel; it was y19):
 *            air cells at y20..21 connected to the stream turn to water as the wave front
 *            passes them
 *  wave      the front starts at the dam foot (`z0`) `delayMs` after the breach and runs
 *            `speed` m/s to the south edge; the `length` m behind the front (feet under
 *            `y1`) shoves infantry downstream (`push`, `up`) for `damage` a hit and light
 *            hulls (`lightHulls`) by `hullPush` m/s for `hullFraction` of max HP
 *  gallery   lethal water in the gallery for `ms` from the breach (`graceMs` to get out)
 *  zones     where bots keep out from the siren on: the canyon floor under `canyonY1`
 *            and the crest gap above the sill (`gap`, until the round ends)
 *  closes    road crossings closed for bot drivers: the crest from the siren on, the
 *            wash ford once the wave front passes it
 *  bots      commander rules (server/modes/conquest/map-events/dam.js botTasks)
 */
export const DAM_TUNING = Object.freeze({
  charges: Object.freeze([
    Object.freeze({ id: 'west', x: 371, y: GALLERY_FEET, z: CHARGE_Z }),
    Object.freeze({ id: 'east', x: 397, y: GALLERY_FEET, z: CHARGE_Z }),
  ]),
  fuseMs: 40000,
  breach: Object.freeze({ x0: 374, x1: 393, z0: 378, z1: 403, y0: 22, y1: 37, chunkCap: 24,
    crush: Object.freeze({ damage: 60, hullFraction: 0.3 }) }),
  drain: Object.freeze({ level: 21, ms: 45000, face: 377, x0: 150, x1: 618, z0: 0, z1: 377 }),
  canyon: Object.freeze({ level: 21, from: 20, z0: 391, z1: 767, x0: 300, x1: 468 }),
  wave: Object.freeze({ z0: 392, z1: 767, delayMs: 1200, speed: 9, length: 18, y1: 26, x0: 330, x1: 438,
    push: Object.freeze({ x: 0, y: 0, z: 7 }), up: 2.6, damage: 22, hullPush: 6, hullFraction: 0.08,
    lightHulls: Object.freeze(['jeep', 'jeep_at', 'mortar']) }),
  gallery: Object.freeze({ x0: 361, x1: 406, z0: 382.5, z1: 385.5, y0: 23, y1: 27.5, ms: 20000, graceMs: 1500 }),
  zones: Object.freeze({ canyonY1: 26, gap: Object.freeze({ x0: 372, x1: 396, z0: 366, z1: 404, y0: 27 }) }),
  closes: Object.freeze({ crest: 'redrock-dam', ford: 'wash-ford', fordZ: 640 }),
  /** Planting in Breakthrough: only the attackers, only while flag C's sector is the active one. */
  breakthrough: Object.freeze({ flag: 'C' }),
  bots: Object.freeze({
    plantPriority: 6, plantSquad: 1, guardSquad: 2, guardRadius: 7,
    defusePriority: 9, defuseSquad: 1, escortSquad: 2,
    /** An enemy ground hull on the crest road (the crest box grown by `armourPad` m) makes the breach worth it. */
    armourPad: 25,
    range: 260,
  }),
});

/** The charge index (0 west, 1 east) of an interaction point id ('plant-west', 'defuse-east'), or -1. */
export const damChargeIndex = id => DAM_TUNING.charges.findIndex(c => typeof id === 'string' && id.endsWith(`-${c.id}`));

const plant = c => ({ id: `plant-${c.id}`, x: c.x, y: c.y, z: c.z, radius: 2, holdMs: 5000, teams: 'any', verb: 'Plant charge', glyph: 'charge' });
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
  durations: { armedMs: DAM_TUNING.fuseMs, warningMs: 10000, activeMs: null },
  texts: {
    'armed:one': { title: 'CHARGE PLANTED', own: { detail: 'PLANT THE SECOND CHARGE IN THE GALLERY' }, enemy: { detail: 'DEFUSE IT IN THE GALLERY' } },
    'armed:fuse': { title: 'CHARGES ARMED', countdown: 'BREACH IN',
      own: { detail: 'HOLD THE GALLERY' }, enemy: { detail: 'DEFUSE THE CHARGES IN THE GALLERY' } },
    'armed:defused': { title: 'CHARGE DEFUSED', detail: 'ONE CHARGE LEFT IN THE GALLERY' },
    armed: { title: 'CHARGES ARMED', countdown: 'BREACH IN' },
    'idle:defused': { title: 'CHARGES DEFUSED' },
    warning: { title: 'BREACH IMMINENT', countdown: 'BREACH IN', detail: 'GET OFF THE CREST · OUT OF THE CANYON' },
    active: { title: 'DAM BREACHED', detail: 'FLOOD WAVE IN THE CANYON' },
    done: { title: 'RESERVOIR DRAINED', detail: 'VEHICLES CROSS AT THE TRESTLE AND THE NORTH BRIDGE' },
  },
  points: DAM_TUNING.charges.flatMap(c => [plant(c), defuse(c)]),
  targets: [],
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
