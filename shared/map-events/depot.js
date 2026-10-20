// Forward service depots (docs/conquest.md "Forward service depots"): one
// depot behind each side's deep flag on both battlefields, owned by whoever
// holds that flag. A friendly hull parked on the forecourt is repaired to
// full and rearmed (one hull at a time, paused by any damage); the depot's
// three fuel tanks share one integrity pool, and once it is shot down the
// tanks go up in a chain reaction (craters, burning ground, the forecourt
// roof down, a smoke column that blocks spotting and lock-on lines, a
// burning road stretch) and the depot is gone for the round.
//
//   depot    (east)  Frontier Hollin Fuel Depot (E), Redrock Juniper Trading Post (E)
//   depot-w  (west)  Frontier Kestrel Halt (A, three tank wagons on the siding),
//                    Redrock Coyote Well (B)
//
// Two definitions (one `ev` row each) so each depot runs its own phases;
// both use the server controller in server/modes/conquest/map-events/depot.js.
import { defineMapEvent } from './define.js';
import { MOLOTOV_FIRE } from '../molotov-rules.js';
import { ACCENT, CORRUGATED_STEEL, DUST_WOOD, METAL, RUST, TEAL_SIDING, TIMBER } from '../world/blocks.js';

const TANK_R = 4.2;
/** An upright tank (Hollin, Juniper, Coyote): concrete plinth at y0, the body from y0 + 1 to y0 + 6, the cap at y0 + 7. */
const upright = (id, x, z, y0) => Object.freeze({ id, x, z, y0, shape: 'upright',
  box: Object.freeze({ x0: Math.floor(x - TANK_R), y0: y0 + 1, z0: Math.floor(z - TANK_R), x1: Math.floor(x + TANK_R), y1: y0 + 7, z1: Math.floor(z + TANK_R) }) });
/** A tank wagon on the Kestrel Halt siding (x0..x1 along the track, z 321..326; y0 the highest ground under it): chassis at y0 + 1, barrel y0 + 2 to y0 + 6, dome y0 + 7. */
const wagon = (id, x0, x1, y0) => Object.freeze({ id, x: (x0 + x1 + 1) / 2, z: 324, y0, shape: 'wagon', x0, x1,
  box: Object.freeze({ x0, y0: y0 + 1, z0: 321, x1, y1: y0 + 7, z1: 326 }) });

/**
 * The Hollin tanks as generated (Frontier template; the depot test checks
 * every site's tanks against the world, so a site change fails it).
 */
export const DEPOT_TANKS = Object.freeze([upright('tank-w', 506.5, 421.5, 29), upright('tank-e', 517.5, 421.5, 30), upright('tank-s', 512.5, 431.5, 30)]);

/**
 * The sites. `pump` is the service point (the hull's flat distance to it and
 * its height over it decide service), `anchor` the event marker over the
 * tanks, `tanks` the three bodies of the pool, `bund` the earth ring a burst
 * cuts (Hollin only), `wreck` the boxes the last burst brings down through
 * the structural system (forecourt roof, pipe rack, windmill), `canopy` the
 * burning disc under it, `road` the stretch of the adjoining road that burns
 * for `roadFire.ms` (bots keep out of it).
 */
export const DEPOT_SITES = Object.freeze({
  frontier: Object.freeze({
    east: Object.freeze({
      id: 'hollin', name: 'HOLLIN DEPOT', flag: 'E', pump: Object.freeze({ x: 488.5, y: 30, z: 441.5 }), anchor: Object.freeze({ x: 512, y: 31, z: 425 }),
      tanks: DEPOT_TANKS,
      bund: Object.freeze({ x0: 499, z0: 414, x1: 525, z1: 438 }),
      wreck: Object.freeze([
        Object.freeze({ id: 'canopy', x0: 481, y0: 29, z0: 437, x1: 495, y1: 35, z1: 445 }),
        Object.freeze({ id: 'pipes', x0: 494, y0: 29, z0: 434, x1: 508, y1: 40, z1: 434 }),
      ]),
      canopy: Object.freeze({ x: 488, z: 441, r: 6 }),
      road: Object.freeze({ shape: 'box', x0: 452, z0: 424, x1: 472, z1: 450 }),
    }),
    // The point mirror of Hollin: the tank wagons on the siding, the forecourt beside the elevator on the halt's drive.
    west: Object.freeze({
      id: 'kestrel', name: 'KESTREL HALT DEPOT', flag: 'A', pump: Object.freeze({ x: 290.5, y: 30, z: 337.5 }), anchor: Object.freeze({ x: 254, y: 31, z: 324 }),
      tanks: Object.freeze([wagon('wagon-w', 241, 248, 31), wagon('wagon-m', 250, 257, 30), wagon('wagon-e', 259, 266, 29)]),
      bund: null,
      wreck: Object.freeze([Object.freeze({ id: 'canopy', x0: 283, y0: 28, z0: 333, x1: 297, y1: 36, z1: 341 })]),
      canopy: Object.freeze({ x: 290, z: 337, r: 6 }),
      road: Object.freeze({ shape: 'box', x0: 296, z0: 318, x1: 316, z1: 344 }),
    }),
  }),
  redrock: Object.freeze({
    east: Object.freeze({
      id: 'juniper', name: 'JUNIPER DEPOT', flag: 'E', pump: Object.freeze({ x: 560.5, y: 32, z: 403.5 }), anchor: Object.freeze({ x: 572, y: 32, z: 418 }),
      tanks: Object.freeze([upright('tank-w', 566.5, 415.5, 31), upright('tank-e', 577.5, 415.5, 31), upright('tank-s', 572, 423.5, 31)]),
      bund: null,
      wreck: Object.freeze([Object.freeze({ id: 'canopy', x0: 556, y0: 31, z0: 399, x1: 564, y1: 38, z1: 407 })]),
      canopy: Object.freeze({ x: 560, z: 403, r: 6 }),
      road: Object.freeze({ shape: 'box', x0: 548, z0: 378, x1: 572, z1: 391 }),
    }),
    // The mirror of Juniper across x 384 (the corral gave way to the tank farm); the windmill comes down.
    west: Object.freeze({
      id: 'coyote', name: 'COYOTE WELL DEPOT', flag: 'B', pump: Object.freeze({ x: 207.5, y: 31, z: 403.5 }), anchor: Object.freeze({ x: 196, y: 32, z: 418 }),
      tanks: Object.freeze([upright('tank-e', 201.5, 415.5, 31), upright('tank-w', 190.5, 415.5, 31), upright('tank-s', 196, 423.5, 31)]),
      bund: null,
      wreck: Object.freeze([Object.freeze({ id: 'windmill', x0: 195, y0: 31, z0: 399, x1: 205, y1: 52, z1: 409 })]),
      canopy: Object.freeze({ x: 208, z: 403, r: 5 }),
      road: Object.freeze({ shape: 'box', x0: 196, z0: 378, x1: 220, z1: 391 }),
    }),
  }),
});

/** The site of a depot definition on a map, or null. */
export const depotSite = (def, mapId) => def?.tuning?.sites?.[mapId] ?? null;

/** The site of a depot definition whose marker is nearest a point ({x, z} or [x, y, z]) on any map (the HUD's banner, the FX). */
export function depotSiteNear(def, at) {
  const x = Array.isArray(at) ? at[0] : at?.x, z = Array.isArray(at) ? at[2] : at?.z;
  let best = null;
  for (const site of Object.values(def?.tuning?.sites ?? {})) {
    const d = Number.isFinite(x) && Number.isFinite(z) ? Math.hypot(site.anchor.x - x, site.anchor.z - z) : Infinity;
    if (!best || d < best.d) best = { site, d };
  }
  return best?.site ?? null;
}

/**
 * Integrity a hit takes off the pool of 900 (all three tanks), by weapon
 * key. Blasts (ProjectileSystem.explode -> onBlast) fall off linearly to
 * max(radius, minReach) from the nearest tank, as at the Iron Bridge. The
 * mounted HMG, the jet's 20 mm and the helicopter's 25 mm chin gun wear it
 * down weakly; a bullet hit is a radius-0 blast on the struck voxel
 * (combat.fireMountedRay). Infantry rifles, MGs, smoke and molotovs do
 * nothing. So: 9 RX-8 rockets or guided / TOW missiles, 8 tank HE shells,
 * 3 jet bombs, 6 AT mines or 12 mortar rounds bring a depot down.
 */
export const DEPOT_SUPPORT_DAMAGE = Object.freeze({
  rocket: 100, guidedMissile: 100, towMissile: 100, tankHE: 115, tankAP: 60, jetBomb: 420, atmine: 150,
  helicopterRocket: 40, mortarHE: 75, mgl: 40, frag: 30, limpet: 60, flak35: 3,
  chinCannon: 5, hmg: 1.5, planeCannon: 2,
});

/**
 * Metres of the segment from-to ([x, y, z]) inside the vertical cylinder
 * (cx, cz, r) between y0 and y1: a cheap closed-form clip, no sampling.
 */
export function cylinderChord(cx, cz, r, y0, y1, from, to) {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const len = Math.hypot(dx, dy, dz);
  if (!(r > 0) || !(len > 0)) return 0;
  let t0 = 0, t1 = 1;
  // Height band.
  if (Math.abs(dy) < 1e-9) { if (from[1] < y0 || from[1] > y1) return 0; }
  else {
    const a = (y0 - from[1]) / dy, b = (y1 - from[1]) / dy;
    t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b));
  }
  // Flat disc.
  const ox = from[0] - cx, oz = from[2] - cz, a2 = dx * dx + dz * dz;
  if (a2 < 1e-12) { if (ox * ox + oz * oz > r * r) return 0; }
  else {
    const b = 2 * (ox * dx + oz * dz), c = ox * ox + oz * oz - r * r, disc = b * b - 4 * a2 * c;
    if (disc <= 0) return 0;
    const s = Math.sqrt(disc);
    t0 = Math.max(t0, (-b - s) / (2 * a2)); t1 = Math.min(t1, (-b + s) / (2 * a2));
  }
  return t1 > t0 ? (t1 - t0) * len : 0;
}

/** The smoke column's radius (m) `ageMs` into the active phase with `leftMs` of it left (0 before it stands or once gone). */
export function depotColumnRadius(column, ageMs, leftMs) {
  if (!(ageMs >= 0) || !(leftMs > 0)) return 0;
  const grow = Math.min(1, ageMs / Math.max(1, column.growMs));
  const fade = Math.min(1, leftMs / Math.max(1, column.fadeMs));
  return column.radius * Math.sqrt(grow) * fade;
}

/** Hull types the forecourt services (ground hulls, and the rotor craft hovering or landed over it). */
export const DEPOT_SERVICE_TYPES = Object.freeze(['jeep', 'jeep_at', 'tank', 'aa', 'mortar', 'helicopter', 'transport']);
export const DEPOT_AIR_TYPES = Object.freeze(['helicopter', 'transport']);

/** The shared tuning of both definitions (each adds its `side` and `sites`). */
const TUNING = Object.freeze({
  tankRadius: TANK_R,
  pool: 900,
  /**
   * Service: one friendly hull at a time within `radius` (flat) of the pump,
   * a ground hull within `groundDy` of its height, a rotor craft up to
   * `airAbove` m over it, that took no damage for `quietMs`. It gains
   * `hpPerSecond` of its max HP a second up to full (a tank from 30 % to
   * full in 14 s) and every mount's magazine refills over `rearmMs`, the
   * countermeasures with the last round. Any damage pauses it; checked
   * every `tickMs`. A visit counts as a service (the enemy's evidence) once
   * the hull got `visitMs` of it.
   */
  service: Object.freeze({ radius: 14, groundDy: 4, airAbove: 10, hpPerSecond: 0.05, rearmMs: 6000, quietMs: 4000, tickMs: 250, visitMs: 2000,
    types: DEPOT_SERVICE_TYPES, air: DEPOT_AIR_TYPES }),
  /** Each tank's burst: infantry damage (1 - d / radius) ^ falloff from the tank's mid-height, a shove, hull splash (linear). */
  blast: Object.freeze({ radius: 20, damage: 180, falloff: 1.2, lift: 3.5, impulse: 14, hullDamage: 260 }),
  /**
   * The crater a tank leaves (deterministic, staged block deltas): every solid
   * cell within `radius` of the centre from `depth` below the plinth (a bowl,
   * deepest in the middle) to `above` over it, scorched earth on the new floor
   * and a ring `scorch` m wider; bund cells within `bundReach` go too.
   */
  crater: Object.freeze({ radius: 6.5, depth: 3, above: 9, scorch: 4, bundReach: 9.5 }),
  /** The wreck's materials (the pumps, plinths and the ground stay). */
  wreckBlocks: Object.freeze([METAL, RUST, CORRUGATED_STEEL, ACCENT, TEAL_SIDING, DUST_WOOD, TIMBER]),
  wreckChunks: 8,
  /** Burning ground: one disc per burst tank and one under the forecourt roof, molotov damage, until `ms` after the active start. */
  fire: Object.freeze({ ms: 60000, dps: MOLOTOV_FIRE.damagePerSecond, hullDps: 6, radius: 7, band: Object.freeze([-3, 6]) }),
  /** The adjoining road stretch (the site's `road`) burns this long from the active start: infantry fire damage, hulls `hullDps`, bots keep out. */
  roadFire: Object.freeze({ ms: 45000, dps: MOLOTOV_FIRE.damagePerSecond, hullDps: 10, band: Object.freeze([-4, 6]) }),
  /** Bots run out of the blast radius from the first failure until the last burst. */
  chainAvoidRadius: 20,
  /**
   * The smoke column over the tanks: a vertical cylinder from the ground to
   * `top` (world y) that blocks a sight line whose chord through it is at
   * least `minChordM`; it grows to `radius` over `growMs` and thins over the
   * last `fadeMs` of the active phase.
   */
  column: Object.freeze({ radius: 9, top: 140, growMs: 8000, fadeMs: 20000, minChordM: 4 }),
  /**
   * Bots. Drivers: a hull below `rtbHp` of its HP with its own team's intact
   * depot within `rtbRoadM` of road drives there, waits until full (or shot
   * at, or `rtbMaxMs`) and goes back (server/bot-depot.js). The mobile AA
   * guards its own forecourt while an enemy hull is within `guardM` of it.
   * Demolition: only on evidence, at least `evidence` enemy services in
   * `evidenceMs`: up to `squad` Engineers walk in to `holdRadius` m of the
   * tanks and fire their RX-8 from `minRange` to `range` m.
   */
  bots: Object.freeze({ rtbHp: 0.45, rtbRoadM: 300, rtbMaxMs: 40000, rtbFullHp: 0.98, guardM: 150, evidence: 2, evidenceMs: 120000,
    priority: 3, squad: 2, holdRadius: 40, minRange: 20, range: 120 }),
});

const TEXTS = Object.freeze({
  'armed:queued': { title: 'TANKS RUPTURED', detail: 'CHAIN REACTION BUILDING · CLEAR THE DEPOT', countdown: 'BLAST IN' },
  warning: { title: 'CHAIN REACTION', countdown: 'BLAST IN', own: { detail: 'THE TANKS ARE GOING UP' }, enemy: { detail: 'GET OUT OF THE DEPOT' } },
  active: { title: 'DESTROYED', detail: 'NO MORE SERVICE THIS ROUND · SMOKE BLOCKS SPOTTING AND LOCKS' },
  done: { title: 'SMOKE CLEARED' },
});

function depotDef(id, side, name) {
  const sites = Object.freeze({ frontier: DEPOT_SITES.frontier[side], redrock: DEPOT_SITES.redrock[side] });
  return defineMapEvent({
    id,
    maps: ['frontier', 'redrock'],
    kind: 'supply',
    name,
    short: 'DEPOT',
    glyph: 'depot-service',
    anchor: { frontier: sites.frontier.anchor, redrock: sites.redrock.anchor },
    // The east depot binds to E on both maps; the west one to A (Frontier) or B (Redrock): `sites[map].flag`.
    flag: sites.frontier.flag === sites.redrock.flag ? sites.frontier.flag : null,
    big: true,
    repeat: null,
    breakthrough: true,
    // The warning is the chain reaction: the remaining tanks go up spread over it,
    // the last at the active start. Active is the smoke column's life.
    durations: { warningMs: 3000, activeMs: 180000 },
    texts: TEXTS,
    // The pool is registered per map by the controller (the boxes differ): `sites[map].tanks`.
    targets: [],
    killKeys: id === 'depot' ? { depotBlast: { label: 'FUEL DEPOT', icon: 'event-depot' }, depotFire: { label: 'DEPOT FIRE', icon: 'fire' } } : {},
    cues: { warning: { stinger: 'ticket_low' }, active: { stinger: 'neutralized' } },
    tuning: { ...TUNING, side, sites, supportDamage: DEPOT_SUPPORT_DAMAGE },
  });
}

export const DEPOT_EVENT = depotDef('depot', 'east', 'East depot');
export const DEPOT_WEST_EVENT = depotDef('depot-w', 'west', 'West depot');
export const DEPOT_EVENTS = Object.freeze([DEPOT_EVENT, DEPOT_WEST_EVENT]);
