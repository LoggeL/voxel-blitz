// Hollin Fuel Depot explosion (Frontier, docs/conquest.md "Hollin Fuel
// Depot"): the three squat fuel tanks inside the earth bund east of the e-c
// road (shared/world/frontier-sites/locations.js DEPOT). Each tank is an
// integrity target; the first one to fail sets off a chain reaction through
// the other two over the 3 s warning, then the depot burns for a minute under
// a black smoke column that stands for three minutes and blocks spotting and
// lock-on lines through it. Once per round; the server half is
// server/modes/conquest/map-events/depot.js.
import { defineMapEvent } from './define.js';
import { MOLOTOV_FIRE } from '../molotov-rules.js';
import { ACCENT, CORRUGATED_STEEL, METAL, RUST } from '../world/blocks.js';

/**
 * The tanks as generated: centre x/z, `y0` the concrete plinth layer (the
 * body stands from y0 + 1 to y0 + 6, the cap at y0 + 7, radius 4.2).
 * Measured on the Frontier template; tools/conquest-map-event-depot-test.mjs
 * checks them against the world, so a site change fails the test.
 */
export const DEPOT_TANKS = Object.freeze([
  Object.freeze({ id: 'tank-w', x: 506.5, z: 421.5, y0: 29 }),
  Object.freeze({ id: 'tank-e', x: 517.5, z: 421.5, y0: 30 }),
  Object.freeze({ id: 'tank-s', x: 512.5, z: 431.5, y0: 30 }),
]);
const TANK_R = 4.2;
const tankBox = t => ({ x0: Math.floor(t.x - TANK_R), y0: t.y0 + 1, z0: Math.floor(t.z - TANK_R), x1: Math.floor(t.x + TANK_R), y1: t.y0 + 7, z1: Math.floor(t.z + TANK_R) });

/**
 * Integrity a hit takes off one tank (300 each), by weapon key. Blasts
 * (ProjectileSystem.explode -> onBlast) fall off linearly to max(radius,
 * minReach) from the tank, as at the Iron Bridge. The mounted HMG, the jet's
 * 20 mm and the helicopter's 25 mm chin gun wear a tank down weakly; a bullet
 * hit is a radius-0 blast on the struck voxel (combat.fireMountedRay).
 * Infantry rifles, MGs, smoke and molotovs do nothing. So: 3 RX-8 rockets or
 * guided / TOW missiles, 2 tank HE shells, 5 AP, 1 jet bomb, 2 AT mines,
 * 4 mortar rounds, 8 MGL grenades, 10 frags, about 25 s of HMG fire, 11 s of
 * the jet cannon or 12 s of the chin gun on one tank.
 */
export const DEPOT_SUPPORT_DAMAGE = Object.freeze({
  rocket: 100, guidedMissile: 100, towMissile: 100, tankHE: 150, tankAP: 60, jetBomb: 420, atmine: 150,
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

export const DEPOT_EVENT = defineMapEvent({
  id: 'depot',
  maps: ['frontier'],
  kind: 'levolution',
  name: 'Hollin Fuel Depot',
  short: 'DEPOT',
  glyph: 'event-depot',
  anchor: { x: 512, y: 31, z: 425 },
  flag: 'E',
  big: true,
  repeat: null,
  breakthrough: true,
  // The warning is the chain reaction: the remaining tanks go up spread over it,
  // the last at the active start. Active is the smoke column's life.
  durations: { warningMs: 3000, activeMs: 180000 },
  texts: {
    'armed:queued': { title: 'TANK RUPTURED', detail: 'CHAIN REACTION BUILDING · CLEAR THE DEPOT', countdown: 'BLAST IN' },
    warning: { title: 'CHAIN REACTION', countdown: 'BLAST IN', own: { detail: 'THE TANKS ARE GOING UP' }, enemy: { detail: 'GET OUT OF THE DEPOT' } },
    active: { title: 'ABLAZE', detail: 'BURNING GROUND · SMOKE BLOCKS SPOTTING AND LOCKS' },
    done: { title: 'SMOKE CLEARED' },
  },
  targets: DEPOT_TANKS.map(t => ({ id: t.id, integrity: 300, boxes: [tankBox(t)], supportDamage: DEPOT_SUPPORT_DAMAGE, minReach: 2 })),
  killKeys: { depotBlast: { label: 'FUEL DEPOT', icon: 'event-depot' }, depotFire: { label: 'DEPOT FIRE', icon: 'fire' } },
  cues: { warning: { stinger: 'ticket_low' }, active: { stinger: 'neutralized' } },
  tuning: {
    tanks: DEPOT_TANKS,
    tankRadius: TANK_R,
    /** Each tank's burst: infantry damage (1 - d / radius) ^ falloff from the tank's mid-height, a shove, hull splash (linear). */
    blast: Object.freeze({ radius: 20, damage: 180, falloff: 1.2, lift: 3.5, impulse: 14, hullDamage: 260 }),
    /**
     * The crater a tank leaves (deterministic, staged block deltas): every solid
     * cell within `radius` of the centre from `depth` below the plinth (a bowl,
     * deepest in the middle) to `above` over it, scorched earth on the new floor
     * and a ring `scorch` m wider; bund cells within `bundReach` go too.
     */
    crater: Object.freeze({ radius: 6.5, depth: 3, above: 9, scorch: 4, bundReach: 9.5 }),
    /** The earth bund ring (2 m of dirt on the terrain), as generated. */
    bund: Object.freeze({ x0: 499, z0: 414, x1: 525, z1: 438 }),
    /** Brought down through the structural system with the last tank: the pump canopy (the pumps stay) and the pipe rack. */
    wreck: Object.freeze([
      Object.freeze({ id: 'canopy', x0: 481, y0: 29, z0: 437, x1: 495, y1: 35, z1: 445 }),
      Object.freeze({ id: 'pipes', x0: 494, y0: 29, z0: 434, x1: 508, y1: 40, z1: 434 }),
    ]),
    /** The wreck's materials: steel posts, roof sheet, fascia, pipes (the pumps, plinths and the ground stay). */
    wreckBlocks: Object.freeze([METAL, RUST, CORRUGATED_STEEL, ACCENT]),
    wreckChunks: 8,
    /** Burning ground: one disc per burst tank and one under the canopy, molotov damage, until `ms` after the active start. */
    fire: Object.freeze({ ms: 60000, dps: MOLOTOV_FIRE.damagePerSecond, hullDps: 6, radius: 7, band: Object.freeze([-3, 6]),
      canopy: Object.freeze({ x: 488, z: 441, r: 6 }) }),
    /** Bots run out of the blast radius from the first failure until the last burst. */
    chainAvoidRadius: 20,
    /**
     * The smoke column over the farm centre: a vertical cylinder from the ground
     * to `top` (world y) that blocks a sight line whose chord through it is at
     * least `minChordM`; it grows to `radius` over `growMs` and thins over the
     * last `fadeMs` of the active phase.
     */
    column: Object.freeze({ radius: 9, top: 140, growMs: 8000, fadeMs: 20000, minChordM: 4 }),
    /**
     * Bots: an Engineer with its RX-8 shoots the weakest tank when at least
     * `enemies` living enemies stand within `radius` of the farm centre (and
     * more enemies than own), from `minRange` to `range` m.
     */
    bots: Object.freeze({ enemies: 3, radius: 20, minRange: 28, range: 140, priority: 3, scanMs: 500, giveUpMs: 8000 }),
  },
});
