/**
 * Support mortar (Conquest): the deployable's rules and its ballistics. The
 * Support with gadget 1 (KITS.support.gadgets) sends the `mortar` intent; the
 * server places a `mortar` hull ahead of him and seats him at its exposed
 * operator seat (server/sim/mortars.js). The tube is an ordinary mount: the
 * operator's input yaw is the azimuth, his input pitch the tube elevation
 * (VEHICLE_DEFS.mortar.mounts.tube.pitchLimit), and every round is a server
 * projectile (VEHICLE_WEAPONS.mortarHE). Pure data and pure math, shared by the
 * server, the bots and the client sight, so the HUD's range readout and the
 * server's rounds solve the same arc.
 */
import { VEHICLE_WEAPON_META, decodeConquestPlayer } from './conquest-contract.js';

const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

const META = VEHICLE_WEAPON_META.mortarHE;

/**
 * Placement and lifecycle. The mortar goes `placeForward` m ahead of the
 * player's feet on ground within `placeRise` m above / `placeDrop` m below
 * them. One mortar per player: a new one replaces the old after
 * `replaceCooldownMs`; a destroyed one blocks the next for `lostCooldownMs`.
 * A wreck is removed after `wreckSeconds`. A hull rolling over the mortar at
 * `crushSpeed` m/s or more crushes it. Elevation limits: 45 degrees (the
 * longest range) to 85 degrees (the shortest).
 */
export const MORTAR_RULES = freeze({
  type: 'mortar', weapon: 'mortarHE', seat: 'operator', mount: 'tube',
  minPitch: Math.PI / 4, maxPitch: 85 * Math.PI / 180, restPitch: 1.05,
  placeForward: 1.4, placeRise: 1.1, placeDrop: 2.5,
  replaceCooldownMs: 3000, lostCooldownMs: 20000, wreckSeconds: 4,
  crushSpeed: 1.5,
  // RMB target snap: the spotted enemy nearest the aimed impact within this many metres.
  snapRadius: 45,
  // HUD: the sight's map half-width (m) around the mortar.
  sightRange: 270,
});

/**
 * Support bots: `share` of a team's supports (stable by id) deploy with the
 * mortar. Every `checkMs` one on foot and out of a fight looks for a fire
 * mission: `minCluster`+ spotted enemies within `clusterRadius` m of each
 * other, near (`flagSlack` m beyond the radius) a flag that is contested or
 * being taken, between `minRange` and `maxRange` m away, and the bot himself
 * outside every contested flag zone. He then deploys with chance
 * `deployChance` and walks his rounds in: the first lands within `spreadStart`
 * m of the target, each next one `spreadShrink` closer (never under
 * `spreadMin`). He leaves the tube after `idleExitMs` without a mission, or
 * at once when an enemy closes to `threatRadius` m or his mortar takes damage.
 */
export const MORTAR_BOT_RULES = freeze({
  share: 0.4, checkMs: 3000, deployChance: 0.5,
  minRange: 60, maxRange: 235, clusterRadius: 10, minCluster: 1, flagSlack: 12,
  aimTolerance: 0.015, spreadStart: 8, spreadShrink: 0.6, spreadMin: 1.5,
  retargetMs: 2500, idleExitMs: 25000, threatRadius: 28, boardRange: 45,
});

/** Muzzle speed and gravity of the HE round (VEHICLE_WEAPON_META.mortarHE). */
export const MORTAR_BALLISTICS = freeze({ speed: META.speed, gravity: META.gravity });

/** Horizontal range on level ground at an elevation `pitch` (radians). */
export function mortarFlatRange(pitch, { speed = META.speed, gravity = META.gravity } = {}) {
  return speed * speed * Math.sin(2 * finite(pitch)) / gravity;
}

/** Time of flight on level ground at an elevation `pitch`. */
export function mortarFlatTime(pitch, { speed = META.speed, gravity = META.gravity } = {}) {
  return 2 * speed * Math.sin(finite(pitch)) / gravity;
}

/** Flat-ground range envelope { min, max } of the elevation limits. */
export function mortarRangeEnvelope(rules = MORTAR_RULES) {
  return { min: mortarFlatRange(rules.maxPitch), max: mortarFlatRange(rules.minPitch) };
}

/** Elevation that lands at flat range `range` on the high arc, clamped to the limits. */
export function mortarPitchForRange(range, rules = MORTAR_RULES) {
  const { speed, gravity } = MORTAR_BALLISTICS;
  const s = clamp(finite(range) * gravity / (speed * speed), 0, 1);
  return clamp(Math.PI / 2 - Math.asin(s) / 2, rules.minPitch, rules.maxPitch);
}

/**
 * High-arc solution from `origin` to `target` ([x,y,z]). Returns
 * { yaw, pitch, tof, range } (yaw 0 faces -Z, positive turns left) or
 * { reason: 'far' | 'near' } when the elevation limits cannot reach it.
 */
export function solveMortarArc(origin, target, { speed = META.speed, gravity = META.gravity, minPitch = MORTAR_RULES.minPitch,
  maxPitch = MORTAR_RULES.maxPitch } = {}) {
  const dx = target[0] - origin[0], dy = target[1] - origin[1], dz = target[2] - origin[2];
  const d = Math.hypot(dx, dz);
  const yaw = Math.atan2(-dx, -dz);
  if (!(d > 0.5)) return { reason: 'near', yaw, range: d };
  const v2 = speed * speed, disc = v2 * v2 - gravity * (gravity * d * d + 2 * dy * v2);
  if (disc < 0) return { reason: 'far', yaw, range: d };
  const pitch = Math.atan((v2 + Math.sqrt(disc)) / (gravity * d));
  if (pitch > maxPitch + 1e-6) return { reason: 'near', yaw, range: d };
  if (pitch < minPitch - 1e-6) return { reason: 'far', yaw, range: d };
  return { yaw, pitch, tof: d / (speed * Math.cos(pitch)), range: d };
}

/** World position of a hull-local point (yaw only: the mortar's baseplate sits level). */
function levelPoint(hull, [x, y, z]) {
  const yaw = finite(hull.yaw), c = Math.cos(yaw), s = Math.sin(yaw);
  return [finite(hull.x) + x * c + z * s, finite(hull.y) + y, finite(hull.z) - x * s + z * c];
}

/**
 * The aim that drops a round from a placed mortar onto `target`: the arc is
 * solved from the muzzle, which moves with the elevation, so the muzzle is
 * re-placed and the arc re-solved a few times. `mount` is the tube's anchor
 * (VEHICLE_DEFS.mortar.mounts.tube: pivot, muzzle).
 */
export function mortarAim(hull, mount, target, rules = MORTAR_RULES) {
  if (!hull || !mount || !Array.isArray(target) || !target.every(Number.isFinite)) return null;
  const pivot = levelPoint(hull, mount.pivot), length = finite(mount.muzzle);
  let solution = solveMortarArc(pivot, target, rules);
  for (let i = 0; i < 3 && Number.isFinite(solution.pitch); i++) {
    const cp = Math.cos(solution.pitch);
    const muzzle = [pivot[0] - Math.sin(solution.yaw) * cp * length, pivot[1] + Math.sin(solution.pitch) * length,
      pivot[2] - Math.cos(solution.yaw) * cp * length];
    const next = solveMortarArc(muzzle, target, rules);
    if (!Number.isFinite(next.pitch)) return next;
    solution = next;
  }
  return solution;
}

/** The ground spot ahead of a player's pose where his mortar goes. */
export function mortarPlacementPoint(pose, rules = MORTAR_RULES) {
  const yaw = finite(pose?.yaw);
  return { x: finite(pose?.x) - Math.sin(yaw) * rules.placeForward, z: finite(pose?.z) - Math.cos(yaw) * rules.placeForward, yaw };
}

/**
 * The RMB snap's candidates for a player of `team`: the snapshot positions of
 * spotted enemy soldiers on foot and spotted enemy hulls (`sp`), as [x, y, z].
 * Hidden enemies never appear (the same rule as the map).
 */
export function mortarSnapTargets({ players = [], vehicles = [], team = null } = {}) {
  if (!team) return [];
  const out = [];
  for (const p of players || []) {
    if (!p || !p.team || p.team === team || p.state !== 'alive' || p.vehicleId || !Number.isFinite(p.x)) continue;
    if (decodeConquestPlayer(p)?.spotted) out.push([p.x, finite(p.y), p.z]);
  }
  for (const v of vehicles || []) {
    if (!v || !v.team || v.team === team || !(v.hp > 0) || v.sp !== 1 || !Number.isFinite(v.x)) continue;
    out.push([v.x, finite(v.y), v.z]);
  }
  return out;
}

/** Refusal reasons of the `mortar` intent (the `mortar` event's `reason`). */
export const MORTAR_REFUSALS = Object.freeze(['kit', 'state', 'cooldown', 'ground', 'blocked']);
