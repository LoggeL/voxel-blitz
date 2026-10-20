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
// The bore is a 1-D translation front on the shared flood field's bore API
// (createBoreField, shared/world/flood-field.js): `sluiceBore` gives the
// front, crest, arrival and push segments, and with a world its `field`
// raises the reach's own water over the voxels while the bore runs (the
// server's world.flood and the client's LOCAL_FLOOD: swimming, hull depth and
// boats read it). Pure data and helpers shared by the server, the bots and
// the client.
import { createBoreField } from '../world/flood-field.js';
import { FLUID_BLOCKS, isSolidBlock } from '../world/blocks.js';
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
 *              m high there, falling off as 1 / (1 + d / decayM)^2 (0.3 m
 *              100 m down, the flood field's decay), over `reachM`, rising
 *              over `riseM` behind the front and fading with `tailS`
 *              (e-folding, the field's tail); each `segmentM` of reach shoves bodies
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
  bore: freeze({ speed: 5, crest: 1, decayM: 113, riseM: 3, tailS: 8, reachM: 120, segmentM: 10, push: 5, up: 1, hullPush: 0.35, carryMs: 20000, halfWidth: 14, y0: 15, y1: 25 }),
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
 *   segments()         [{z0, z1, x0, x1, fromMs, untilMs, crest}] the reach in
 *                      segmentM slices (the server's push zones)
 *   field              with `block(x, y, z)`: the flood-field bore over the
 *                      reach (sluiceBoreField), else null
 */
export function sluiceBore(weir, rules = SLUICE_RELEASE.bore, block = null) {
  const z0 = weir.z1 + 1;
  const centre = z => {
    const r = weir.reach;
    if (z <= r[0][0]) return r[0][1];
    for (let i = 1; i < r.length; i++) if (z <= r[i][0]) return r[i - 1][1] + (r[i][1] - r[i - 1][1]) * (z - r[i - 1][0]) / (r[i][0] - r[i - 1][0]);
    return r[r.length - 1][1];
  };
  const zAt = d => z0 + d, dAt = z => z - z0;
  const crest = d => (d < 0 || d > rules.reachM ? 0 : rules.crest / (1 + d / rules.decayM) ** 2);
  const onReach = (x, z) => dAt(z) >= 0 && dAt(z) <= rules.reachM && Math.abs(x - centre(z + 0.5)) <= rules.halfWidth;
  const arrival = (x, z) => (onReach(x, z) ? (dAt(z) / rules.speed) * 1000 : Infinity);
  const bore = {
    rules, zAt, dAt, crest, centre,
    front: ms => Math.max(0, Math.min(rules.reachM, (ms / 1000) * rules.speed)),
    arrival,
    segments() {
      const out = [];
      for (let d = 0; d < rules.reachM; d += rules.segmentM) {
        const za = zAt(d), zb = zAt(Math.min(rules.reachM, d + rules.segmentM)), cx = centre((za + zb) / 2);
        const fromMs = (d / rules.speed) * 1000;
        out.push(freeze({ z0: za, z1: zb, x0: cx - rules.halfWidth, x1: cx + rules.halfWidth, fromMs, untilMs: fromMs + rules.carryMs, crest: crest(d) }));
      }
      return out;
    },
  };
  bore.field = block ? sluiceBoreField(bore, block) : null;
  return freeze(bore);
}

/**
 * The bore as a flood field (createBoreField) over the reach, read from the
 * world at the release: only columns on the reach whose top is voxel water
 * take part (their surface is the field's base), so it lifts the river by
 * the bore's crest (peaking at crest(d)) and never wets a bank. `wet` answers true under the
 * raised water and undefined elsewhere (the voxel answers there), so the
 * field only ever adds water. Runs from the fall; the settled state (endS =
 * carryMs) is the plain river again.
 */
export function sluiceBoreField(bore, block) {
  const R = bore.rules, z0 = bore.zAt(0), z1 = bore.zAt(R.reachM) - 1;
  let lo = Infinity, hi = -Infinity;
  for (let z = z0; z <= z1; z++) { lo = Math.min(lo, bore.centre(z + 0.5)); hi = Math.max(hi, bore.centre(z + 0.5)); }
  const box = freeze({ x0: Math.floor(lo - R.halfWidth), x1: Math.ceil(hi + R.halfWidth), z0, z1 });
  const W = box.x1 - box.x0 + 1, surface = new Float32Array(W * (z1 - z0 + 1)).fill(NaN), floor = new Int16Array(surface.length);
  for (let z = z0; z <= z1; z++) for (let x = box.x0; x <= box.x1; x++) {
    if (Math.abs(x + 0.5 - bore.centre(z + 0.5)) > R.halfWidth) continue;
    let y = R.y1;
    while (y > R.y0 && !isSolidBlock(block(x, y, z)) && !FLUID_BLOCKS.has(block(x, y, z))) y--;
    if (!FLUID_BLOCKS.has(block(x, y, z))) continue;
    const top = y + 1;
    while (y > 0 && !isSolidBlock(block(x, y - 1, z))) y--;
    surface[(z - z0) * W + x - box.x0] = top; floor[(z - z0) * W + x - box.x0] = y;
  }
  const cell = (x, z) => {
    const ix = Math.floor(x) - box.x0, iz = Math.floor(z) - z0;
    return ix < 0 || iz < 0 || ix >= W || iz > z1 - z0 ? -1 : iz * W + ix;
  };
  // The field's crest rises behind its front and fades with its tail, so its peak is a share of `crest`:
  // scaled back up, the water peaks at crest(d) over every point of the reach (the push zones' crest).
  let share = 0;
  for (let b = 0.05; b < 4 * R.tailS; b += 0.05) share = Math.max(share, (1 - 1 / (1 + R.speed * b / R.riseM)) / (1 + b / R.tailS) ** 2);
  const field = createBoreField({
    box, axis: 'z', dir: 1, speed: R.speed, crest: R.crest / share, decayM: R.decayM, riseM: R.riseM, tailS: R.tailS, endS: R.carryMs / 1000,
    base: (x, z) => { const i = cell(x, z); return i < 0 ? NaN : surface[i]; },
    floorAt: (x, z) => { const i = cell(x, z); return i < 0 ? Infinity : floor[i]; },
  });
  return freeze({
    kind: field.kind, bounds: field.bounds, endS: field.endS,
    level: (x, z, t) => field.level(x, z, t),
    velocity: (x, z, t, out) => field.velocity(x, z, t, out),
    arrival: (x, z) => field.arrival(x, z),
    settled: (x, z) => field.settled(x, z),
    wet: (x, y, z, t) => (field.wet(x, y, z, t) === true ? true : undefined),
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
