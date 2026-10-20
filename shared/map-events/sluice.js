// Frontier ford sluices (docs/conquest.md "Ford sluices"; geometry WEIR /
// WEIR_SOUTH in ./weir.js): one levolution per lane. Each sluice holds a pond
// one voxel over its reach; blowing its piers and gate leaves down releases
// the pond as a bore through its own ford, and the bore scours the ford bed
// two voxels deeper: the ford is closed to every hull for the round (3 m of
// water against the tank's 1.9 m WADE_RULES depth). Infantry keep a slow,
// exposed crossing over the stepping stones the walkway leaves.
//
//   intact  -> damaged   the pool (500, Iron Bridge damage table) at half
//   damaged -> failing   the pool at 0: a 3 s groan, the ford closes for bot
//                        drivers, bots leave the reach below the gates
//   failing -> down      piers, leaves, gantries and walkway come down (at
//                        most 12 chunks), the pond drains over 6 s, the bore
//                        runs 120 m down the reach at 5 m/s shoving swimmers,
//                        boats and light hulls downstream, the stepping
//                        stones settle, then the ford bed is scoured
//
// The bore is the stage-1 one: a 1-D translation front behind `sluiceBore`
// (front, crest, arrival, level, segments), so the shared flood field
// (planned, docs/conquest.md "Map events") can replace it behind the same
// calls. Pure data and helpers shared by the server, the bots and the client.
import { defineLevolution } from './levolution.js';
import { WEIR, WEIR_SOUTH } from './weir.js';

const freeze = Object.freeze;

/**
 * The release, per sluice (times from the fall, the active phase's start):
 *  integrity   the supports' pool (blasts by IRON_BRIDGE_RULES.supportDamage:
 *              5 RX-8 rockets or tank HE shells, a jet bomb and a rocket,
 *              4 AT mines)
 *  warnMs      the groan; chunkCap the fall's chunks
 *  drainMs     the pond's top voxel drains, nearest the gates first
 *  bore        the front: `speed` m/s from the gates' downstream face, `crest`
 *              m high there, falling off as exp(-d / decayM) (0.3 m 100 m
 *              down), over `reachM`; each `segmentM` of reach shoves bodies
 *              in it downstream (`push` m/s per metre of crest and `up`
 *              m/s up, once a second, hulls `hullPush` of the push) from
 *              the front's arrival for `carryMs`, within `halfWidth` of the
 *              river's centreline, feet between y0 and y1
 *  stonesMs    the walkway's stepping stones settle on the bed (after the chunks)
 *  scourMs     the ford bed is scoured once the bore has run through the ford
 *  scour       `depth` voxels off every ford column (2: 3 m of water; 1
 *              would leave 2 m, still over every WADE_RULES depth)
 *  stones      one stone in `every` columns is left out (a 1 m gap to jump),
 *              `ramp` stones step up to the abutments' deck at each end
 *  doneMs      the active phase (the release) ends
 *  bots        a side the fords' armour runs over blows the sluice (enemy
 *              ground hulls near the ford weigh `armour` or more, a tank
 *              `tankWeight`, and none of its own), the side whose armour uses
 *              the ford holds its bank ends (crewed hulls within `reach` m)
 */
export const SLUICE_RELEASE = freeze({
  integrity: 500,
  warnMs: 3000,
  chunkCap: 12,
  drainMs: 6000,
  bore: freeze({ speed: 5, crest: 1, decayM: 83, reachM: 120, segmentM: 10, push: 5, up: 1, hullPush: 0.35, carryMs: 20000, halfWidth: 14, y0: 15, y1: 25 }),
  stonesMs: 5000,
  scourMs: 24000,
  scour: freeze({ depth: 2 }),
  stones: freeze({ every: 3, ramp: 2 }),
  doneMs: 26000,
  bots: freeze({ reach: 140, armour: 2, tankWeight: 2 }),
});

/**
 * The bore below a sluice: a 1-D front running down the reach from the
 * gates' downstream face (z1 + 1, the river runs to +z). Every call is pure
 * in the release time `ms` (from the fall), so the server's hazard zones and
 * the client's foam front agree:
 *   front(ms)          metres run (capped at reachM)
 *   crest(d)           crest height (m) d metres down
 *   zAt(d) / dAt(z)    world z of a distance down the reach, and back
 *   centre(z)          the reach's centreline x (weir.reach)
 *   arrival(x, z)      release ms the front reaches (x, z), Infinity off the reach
 *   level(x, z, ms)    water over the reach's face (m) at (x, z) then: the
 *                      crest from the arrival, falling to 0 over carryMs
 *   segments()         [{z0, z1, x0, x1, fromMs, untilMs, crest}] the reach in
 *                      segmentM slices (the server's push zones)
 */
export function sluiceBore(weir, rules = SLUICE_RELEASE.bore) {
  const z0 = weir.z1 + 1;
  const centre = z => {
    const r = weir.reach;
    if (z <= r[0][0]) return r[0][1];
    for (let i = 1; i < r.length; i++) if (z <= r[i][0]) return r[i - 1][1] + (r[i][1] - r[i - 1][1]) * (z - r[i - 1][0]) / (r[i][0] - r[i - 1][0]);
    return r[r.length - 1][1];
  };
  const zAt = d => z0 + d, dAt = z => z - z0;
  const crest = d => (d < 0 || d > rules.reachM ? 0 : rules.crest * Math.exp(-d / rules.decayM));
  const onReach = (x, z) => dAt(z) >= 0 && dAt(z) <= rules.reachM && Math.abs(x - centre(z + 0.5)) <= rules.halfWidth;
  const arrival = (x, z) => (onReach(x, z) ? (dAt(z) / rules.speed) * 1000 : Infinity);
  return freeze({
    rules, zAt, dAt, crest, centre,
    front: ms => Math.max(0, Math.min(rules.reachM, (ms / 1000) * rules.speed)),
    arrival,
    level(x, z, ms) {
      const at = arrival(x, z);
      if (!(ms >= at)) return 0;
      const k = 1 - (ms - at) / rules.carryMs;
      return k > 0 ? crest(dAt(z)) * k : 0;
    },
    segments() {
      const out = [];
      for (let d = 0; d < rules.reachM; d += rules.segmentM) {
        const za = zAt(d), zb = zAt(Math.min(rules.reachM, d + rules.segmentM)), cx = centre((za + zb) / 2);
        const fromMs = (d / rules.speed) * 1000;
        out.push(freeze({ z0: za, z1: zb, x0: cx - rules.halfWidth, x1: cx + rules.halfWidth, fromMs, untilMs: fromMs + rules.carryMs, crest: crest(d) }));
      }
      return out;
    },
  });
}

/** Box of the over-water part of a sluice (between the abutments) from y0 to y1, its rows z0..z1. */
const overWater = (w, y0, y1, z0 = w.z0, z1 = w.platform.z1 + 1) => ({ x0: w.abutments[0].x1 + 1, y0, z0, x1: w.abutments[1].x0 - 1, y1, z1 });
const BED = 15;

function sluiceEvent(weir, { id, name, short, flag, detail }) {
  const piers = weir.piers.map((p, i) => ({ id: `pier-${i}`, x0: p.x0, y0: BED, z0: weir.z0, x1: p.x1, y1: weir.deckY, z1: weir.z1 }));
  const gates = weir.bays.map(b => ({ id: `gate-${b.id}`, x0: b.x0, y0: BED, z0: weir.gateZ, x1: b.x1, y1: weir.shutTopY, z1: weir.gateZ }));
  const R = SLUICE_RELEASE;
  return defineLevolution({
    id, maps: ['frontier'], name, short, glyph: 'event-sluice', flag,
    anchor: { x: (weir.pass.x0 + weir.pass.x1 + 1) / 2, y: weir.deckY + 1, z: (weir.z0 + weir.z1 + 1) / 2 },
    texts: {
      armed: { title: 'DAMAGED', detail: 'SUPPORTS HOLDING' },
      warning: { title: 'FAILING', detail: 'GET OUT OF THE FORD', countdown: 'BREAKS IN' },
      active: { title: 'WASHED OUT', detail },
    },
    cues: { warning: { stinger: 'ticket_low' }, active: { stinger: 'neutralized' } },
    crossing: weir.crossing, integrity: R.integrity,
    supports: [...piers, ...gates],
    // Everything over the water above the reach's face falls (abutments stay on the banks); the piers under it sink.
    span: overWater(weir, 22, weir.gantryTopY + 1), deckY: weir.deckY,
    sinks: piers.map(p => ({ x0: p.x0, y0: p.y0, z0: p.z0, x1: p.x1, y1: 21, z1: p.z1 })),
    heads: weir.heads, axis: 'x', detect: [weir.piers[0].x0, weir.deckY, weir.z0],
    rules: { warnMs: R.warnMs, chunkCap: R.chunkCap, downMs: R.doneMs },
    tuning: { sluice: freeze({ weir, release: R }) },
  });
}

export const SLUICE_NORTH_EVENT = sluiceEvent(WEIR, {
  id: 'sluice-north', name: 'Ford-North Sluice', short: 'N SLUICE', flag: 'D', detail: 'NO HULL FORDS · VEHICLES CROSS AT THE BRIDGES',
});
export const SLUICE_SOUTH_EVENT = sluiceEvent(WEIR_SOUTH, {
  id: 'sluice-south', name: 'Ford-South Sluice', short: 'S SLUICE', flag: 'B', detail: 'NO HULL FORDS · VEHICLES CROSS AT THE BRIDGES',
});
export const SLUICE_EVENTS = freeze([SLUICE_NORTH_EVENT, SLUICE_SOUTH_EVENT]);
