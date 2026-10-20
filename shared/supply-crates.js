/**
 * Conquest supply crates (docs/conquest.md "Infantry supply" > "Supply
 * crates"): the Support's AMMO CRATE (gadget 0, `ammocrate`) and the Medic's
 * MEDICAL CRATE (gadget 0, `medcrate`). Pure rules, placement, the shot box and
 * the wire codec, shared by the authority (server/modes/conquest/supply-crates.js),
 * the bots and the client presentation. Balance lives here only.
 *
 * - Placed with the `crate` intent (slot key 3, the kit wheel's gadget
 *   segment, the touch button) on the ground ahead, by the mortar's rule
 *   (shared/mortar-rules.js placeForward / placeRise / placeDrop, no wall
 *   between the feet and the spot). One crate per owner: placing again moves
 *   it. It outlives its owner's death by `lingerMs`, and goes with the owner
 *   leaving or changing team, its floor, a rematch, or `hp` of enemy bullets,
 *   blasts and melee (the destroyer is paid `gadget_destroyed`).
 * - Ammo crate: every `ammo.intervalMs` each living on-foot teammate within
 *   `radius` gets one magazine and one grenade (ConquestRoles.supply), and an
 *   AT / AA round at most every `ammo.gadgetRoundMs` per mate.
 * - Medical crate: every `med.intervalMs` +`med.hp` HP to each mate within
 *   `radius` not hurt in the last `med.hurtQuietMs`, and +1 bandage at most
 *   every `med.bandageMs` per mate.
 * Enemies never draw from a crate; they see the box (a physical object), not
 * its map marker.
 */
import { CRATE_TYPE_IDS } from './conquest-contract.js';
import { MORTAR_RULES, mortarPlacementPoint } from './mortar-rules.js';
import { raycastVoxels } from './raycast.js';

export const SUPPLY_CRATE_RULES = Object.freeze({
  hp: 120,
  /** Reach of a crate's pulse (m, crate feet to the mate's feet, 3D). */
  radius: 5,
  /** A crate stays this long after its owner dies, then goes. */
  lingerMs: 60000,
  /** A new placement (a move) at most this often per owner. */
  replaceCooldownMs: 3000,
  /** Placement: the mortar's ground rule. */
  placeForward: MORTAR_RULES.placeForward,
  placeRise: MORTAR_RULES.placeRise,
  placeDrop: MORTAR_RULES.placeDrop,
  /** Shot box half extents (x, y, z) of the 0.8 x 0.5 x 0.56 m box, centre above the floor (m). */
  half: Object.freeze([0.4, 0.26, 0.28]),
  centerY: 0.26,
  ammo: Object.freeze({ intervalMs: 3000, mags: 1, grenades: 1, gadgetRoundMs: 10000 }),
  med: Object.freeze({ intervalMs: 1000, hp: 8, hurtQuietMs: 3000, bandageMs: 15000 }),
  /** Blast damage at the centre when the blast type has no rules, falling off to its radius. */
  blastDamage: 200,
  /** Bots: at most one placement per this long per bot, a check this often. */
  botPlaceMs: 20000,
  botCheckMs: 2500,
  /** Bots: place where this many mates stand within `botMateRadius` m (no enemy in sight). */
  botMinMates: 2,
  botMateRadius: 10,
  /** Bots: a crate already standing this close (m, flat) to the spot is kept. */
  botKeepRange: 15,
});

/** Crate kinds in wire order (row field 3). */
export const CRATE_KINDS = CRATE_TYPE_IDS;
export const isCrateKind = kind => CRATE_KINDS.includes(kind);

/**
 * Where a crate goes for a player's pose `{x, y, z, yaw}`: the mortar's spot
 * ahead of the feet, on the highest floor within placeRise above / placeDrop
 * below the feet with one free voxel over it, and no wall between the feet
 * and the spot. Returns `{x, y, z, yaw, mount:[x, y, z]}` or `{reason}`
 * ('ground' | 'blocked').
 */
export function placeCrate(pose, solidAt, rules = SUPPLY_CRATE_RULES) {
  if (!pose || typeof solidAt !== 'function' || ![pose.x, pose.y, pose.z].every(Number.isFinite)) return { reason: 'ground' };
  const spot = mortarPlacementPoint(pose, { placeForward: rules.placeForward });
  const bx = Math.floor(spot.x), bz = Math.floor(spot.z);
  let floor = null;
  for (let y = Math.floor(pose.y + rules.placeRise - 0.001); y >= Math.floor(pose.y - rules.placeDrop); y--) {
    if (y >= 0 && solidAt(bx, y, bz)) { floor = y; break; }
  }
  if (floor === null) return { reason: 'ground' };
  if (solidAt(bx, floor + 1, bz)) return { reason: 'blocked' };
  const from = [pose.x, pose.y + 0.6, pose.z], to = [spot.x, floor + 1 + 0.6, spot.z];
  const d = to.map((v, i) => v - from[i]), length = Math.hypot(...d);
  if (length > 1e-3 && raycastVoxels(solidAt, ...from, ...d.map(v => v / length), length)) return { reason: 'blocked' };
  return { x: spot.x, y: floor + 1, z: spot.z, yaw: spot.yaw, mount: [bx, floor, bz] };
}

/** Centre of a crate's shot box. */
export function crateCenter(crate, rules = SUPPLY_CRATE_RULES) {
  return [crate.x, crate.y + rules.centerY, crate.z];
}

/** Ray entry distance into a crate's shot box (feet at x/y/z), or null. */
export function rayCrate(crate, origin, direction, limit, minT = 0, radius = 0, rules = SUPPLY_CRATE_RULES) {
  if (!crate) return null;
  const center = crateCenter(crate, rules);
  let near = minT, far = limit;
  for (let i = 0; i < 3; i++) {
    const extent = rules.half[i] + radius, delta = center[i] - origin[i];
    const d = i === 0 ? direction.x ?? direction[0] : i === 1 ? direction.y ?? direction[1] : direction.z ?? direction[2];
    if (Math.abs(d) < 1e-10) {
      if (Math.abs(delta) > extent) return null;
      continue;
    }
    const a = (delta - extent) / d, b = (delta + extent) / d;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far) return null;
  }
  return near < limit ? near : null;
}

/** True when `body` (feet) stands in a crate's reach. */
export function inCrateReach(crate, body, rules = SUPPLY_CRATE_RULES) {
  return !!crate && !!body && Math.hypot(body.x - crate.x, (body.y ?? crate.y) - crate.y, body.z - crate.z) <= rules.radius;
}

const q = v => Math.round(v * 100) / 100;
const TEAM_CODE = Object.freeze({ alpha: 0, bravo: 1 });
const TEAM_OF = Object.freeze(['alpha', 'bravo']);

/**
 * Wire rows of `match.conquest.crates` (omitted while empty):
 * `[[id, ownerId, team, kind, x, y, z, yawCdeg, hpPct, lingerDs]]`. `team` is
 * 0 alpha / 1 bravo, `kind` an index into CRATE_KINDS, `yawCdeg` the yaw in
 * whole degrees, `lingerDs` the deciseconds left once its owner died (0
 * while the owner lives).
 */
export function encodeSupplyCrates(crates = [], now = 0) {
  const rows = [...crates].map(c => [String(c.id), String(c.ownerId), TEAM_CODE[c.team] ?? -1, Math.max(0, CRATE_KINDS.indexOf(c.kind)),
    q(c.x), q(c.y), q(c.z), Math.round((Number(c.yaw) || 0) * 180 / Math.PI),
    Math.max(0, Math.min(100, Math.round(c.hp / SUPPLY_CRATE_RULES.hp * 100))),
    Number.isFinite(c.expiresAt) ? Math.max(1, Math.ceil((c.expiresAt - now) / 100)) : 0]);
  return rows.length ? rows : null;
}

/** Decoded `match.conquest.crates`: `[{id, ownerId, team, kind, x, y, z, yaw, hpFraction, lingerMs}]` (empty when absent). */
export function decodeSupplyCrates(raw) {
  return (Array.isArray(raw) ? raw.filter(Array.isArray) : []).map(([id, ownerId, team, kind, x, y, z, yaw, hpPct, lingerDs]) => ({
    id: String(id), ownerId: String(ownerId), team: TEAM_OF[team] ?? null, kind: CRATE_KINDS[kind] ?? CRATE_KINDS[0],
    x: Number(x), y: Number(y), z: Number(z), yaw: (Number(yaw) || 0) * Math.PI / 180,
    hpFraction: Math.max(0, Math.min(1, (Number(hpPct) || 0) / 100)), lingerMs: Math.max(0, lingerDs | 0) * 100,
  }));
}
