import { raycastVoxels } from './raycast.js';
import { placeAtMine } from './at-mine-rules.js';

/**
 * Conquest Recon gadgets (docs/conquest.md "Recon gadgets"): the SPAWN BEACON
 * (gadget 0, pouch type `beacon`) and the MOTION SENSOR (gadget 1, pouch type
 * `sensor`). Pure rules, placement, hit boxes and the wire codec, shared by
 * the authority (server/modes/conquest/recon-gadgets.js), the shared deploy
 * options, bots and the client presentation. Balance lives here only.
 *
 * - Beacon: laid like the AT MINE (floor under the crosshair within reach, else
 *   the floor just ahead), one per Recon (a new one replaces the old), lives
 *   through the owner's deaths and goes with a kit or gadget change, a team
 *   change or the owner leaving. Its owner's squad deploys on it
 *   (`beacon:<id>`), unless an enemy stands within `enemyBlockRange` or the
 *   beacon spawned someone in the last `spawnCooldownMs`. Bullets and blasts
 *   destroy it (`hp`). Enemies see its marker within `enemyRevealRange` or
 *   while it is spotted.
 * - Sensor: thrown like a grenade (2 per life), it settles after `fuseMs` and
 *   for `lifeMs` reveals every enemy within `radius` that moves faster than
 *   `minSpeed` (a crouch walk, 2.2 m/s, or a prone crawl stays hidden) on the
 *   owner team's minimap and map. Bullets and blasts destroy it.
 */
export const RECON_GADGET_RULES = Object.freeze({
  beacon: Object.freeze({
    hp: 100,
    /** Spawning here is refused (`enemy`) while a living enemy stands this close (m, flat). */
    enemyBlockRange: 20,
    /** One spawn per beacon per this long (`cooldown`). */
    spawnCooldownMs: 10000,
    /** Enemies get its marker within this range (m) even when it is not spotted. */
    enemyRevealRange: 30,
    /** Spawn cells ring the beacon between these radii (m). */
    spawnMinRadius: 1.2,
    spawnMaxRadius: 3,
    /** Air the antenna needs above the floor voxel (voxels). */
    headroom: 2,
    /** Shot box half extents (x, y, z) of the 0.36 x 0.5 m case with its antenna. */
    half: Object.freeze([0.2, 0.42, 0.2]),
    /** Box centre above the floor (m). */
    centerY: 0.4,
  }),
  sensor: Object.freeze({
    hp: 25,
    /** Air time before it settles and starts sensing (the pouch type's fuse). */
    fuseMs: 1600,
    lifeMs: 20000,
    radius: 30,
    /** Height band (m) around the sensor that counts. */
    dy: 12,
    /** Flat speed (m/s) that gives a body away: above a crouch walk (2.2), below a walk (4.4). */
    minSpeed: 2.6,
    /** A prone body (stance blend above this) is never sensed, whatever its speed. */
    proneBelow: 0.5,
    /** Scan period (ms) and how long a reveal outlives the scan that made it. */
    scanMs: 250,
    revealMs: 1200,
    /** Live sensors per owner: a third removes the oldest. */
    maxPerOwner: 2,
    half: Object.freeze([0.14, 0.12, 0.14]),
    centerY: 0.1,
  }),
  /** Blast damage to a gadget at the centre, falling off linearly to the blast radius, when the type has no rules. */
  blastDamage: 200,
  /** Bots: an enemy beacon or sensor in sight this close is shot at. */
  botShootRange: 45,
  /** Bots: a Recon lays its beacon between these distances (m, flat) from the flag it assaults. */
  botBeaconMin: 25,
  botBeaconMax: 150,
  /** ... with no living enemy closer than this. */
  botBeaconSafe: 30,
  /** Bots: a sensor is thrown at the flag a bot attacks, stages for or defends from this close (m, flat to the flag centre). */
  botSensorMax: 60,
  botSensorMin: 8,
  /** A bot considers its gadgets at most this often. */
  botCheckMs: 2500,
});

/**
 * Placement of a spawn beacon from the eye along `dir`: the AT mine's floor
 * rule (crosshair floor within reach, else the floor below a point just
 * ahead), plus open air for the antenna. Null when there is no such floor.
 */
export function placeBeacon({ x, eyeY, z, dir }, solidAt) {
  const floor = placeAtMine({ x, eyeY, z, dir }, solidAt);
  if (!floor || !solidAt) return null;
  const [mx, my, mz] = floor.mount;
  for (let dy = 1; dy <= RECON_GADGET_RULES.beacon.headroom; dy++) if (solidAt(mx, my + dy, mz)) return null;
  return { type: 'beacon', x: floor.x, y: my + 1, z: floor.z, vx: 0, vy: 0, vz: 0, charge: 0, n: [0, 1, 0], mount: [mx, my, mz] };
}

/**
 * Why a spawn beacon may not stand at `spot` (x, z) for `team`, or null:
 * 'hq' inside an enemy HQ's restricted radius, 'oob' outside the combat area.
 * These are the zones whose timer kills infantry (server BoundsSystem, same
 * map metadata), so a beacon there would deploy its squad into that timer
 * and keep an enemy HQ open to spawns. `metaConquest` is mapMeta.conquest
 * (`bases`, `combatArea`); without it nothing is restricted.
 */
export function beaconRestricted(spot, team, metaConquest) {
  if (!spot || !metaConquest || ![spot.x, spot.z].every(Number.isFinite)) return null;
  for (const [owner, base] of Object.entries(metaConquest.bases || {})) {
    if (owner === team || !(base?.radius > 0) || ![base.x, base.z].every(Number.isFinite)) continue;
    if (Math.hypot(spot.x - base.x, spot.z - base.z) <= base.radius) return 'hq';
  }
  const area = metaConquest.combatArea;
  if (area && ['minX', 'maxX', 'minZ', 'maxZ'].every(k => Number.isFinite(area[k]))
      && (spot.x < area.minX || spot.x > area.maxX || spot.z < area.minZ || spot.z > area.maxZ)) return 'oob';
  return null;
}

/** Ray entry distance into a gadget's shot box (`kind` beacon or sensor, feet at x/y/z), or null. */
export function rayReconGadget(gadget, origin, direction, limit, minT = 0, radius = 0) {
  const rules = RECON_GADGET_RULES[gadget?.kind];
  if (!rules) return null;
  const center = [gadget.x, gadget.y + rules.centerY, gadget.z];
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

/** Centre of a gadget's shot box (blast distance, line of sight). */
export function reconGadgetCenter(gadget) {
  const rules = RECON_GADGET_RULES[gadget?.kind];
  return [gadget.x, gadget.y + (rules?.centerY ?? 0), gadget.z];
}

/**
 * True when a motion sensor at `sensor` gives `body` away: alive, within the
 * radius and height band, not prone and moving faster than `minSpeed` (flat
 * m/s, measured by the caller between scans).
 */
export function sensorDetects(sensor, body, speed) {
  const r = RECON_GADGET_RULES.sensor;
  if (!sensor || !body || !Number.isFinite(speed)) return false;
  if (Math.abs(body.y - sensor.y) > r.dy) return false;
  if (Math.hypot(body.x - sensor.x, body.z - sensor.z) > r.radius) return false;
  if ((Number(body.proneT) || 0) > r.proneBelow) return false;
  return speed >= r.minSpeed;
}

/** True when a voxel line from `from` to `to` is open (the end cell itself never blocks). */
export function reconLineOpen(solidAt, from, to, endMargin = 0.35) {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const distance = Math.hypot(dx, dy, dz);
  if (!(distance > endMargin) || typeof solidAt !== 'function') return true;
  return !raycastVoxels(solidAt, from[0], from[1], from[2], dx, dy, dz, distance - endMargin);
}

const q = v => Math.round(v * 100) / 100;
const TEAM_CODE = Object.freeze({ alpha: 0, bravo: 1 });
const TEAM_OF = Object.freeze(['alpha', 'bravo']);

/**
 * Wire rows of `match.conquest.recon` (omitted while empty):
 * `{ b: [[id, ownerId, team, x, y, z, hpPct, cooldownDs, spottedBy]], s: [[id, ownerId, team, x, y, z, leftDs]], m: [alphaSensed[], bravoSensed[]] }`.
 * `team` is 0 alpha / 1 bravo; `spottedBy` is the team code that spotted the
 * beacon, or -1; `m[t]` lists the enemy player ids team t's sensors reveal.
 */
export function encodeReconGadgets({ beacons = [], sensors = [], sensed = null } = {}) {
  const b = beacons.map(g => [String(g.id), String(g.ownerId), TEAM_CODE[g.team] ?? -1, q(g.x), q(g.y), q(g.z),
    Math.max(0, Math.min(100, Math.round(g.hp / RECON_GADGET_RULES.beacon.hp * 100))),
    Math.max(0, Math.ceil((g.cooldownMs || 0) / 100)), TEAM_CODE[g.spottedBy] ?? -1]);
  const s = sensors.map(g => [String(g.id), String(g.ownerId), TEAM_CODE[g.team] ?? -1, q(g.x), q(g.y), q(g.z),
    Math.max(0, Math.ceil((g.leftMs || 0) / 100))]);
  const m = [sensed?.alpha ?? [], sensed?.bravo ?? []].map(list => [...list].map(String));
  if (!b.length && !s.length && !m[0].length && !m[1].length) return null;
  return { b, s, m };
}

/** Decoded `match.conquest.recon`: `{beacons, sensors, sensed:{alpha, bravo}}` (empty lists when absent). */
export function decodeReconGadgets(raw) {
  const rows = (list) => (Array.isArray(list) ? list.filter(Array.isArray) : []);
  const beacons = rows(raw?.b).map(([id, ownerId, team, x, y, z, hpPct, cooldownDs, spotted]) => ({
    kind: 'beacon', id: String(id), ownerId: String(ownerId), team: TEAM_OF[team] ?? null,
    x: Number(x), y: Number(y), z: Number(z), hp: Math.max(0, Number(hpPct) || 0) / 100 * RECON_GADGET_RULES.beacon.hp,
    hpFraction: Math.max(0, Math.min(1, (Number(hpPct) || 0) / 100)), cooldownMs: Math.max(0, cooldownDs | 0) * 100,
    spottedBy: TEAM_OF[spotted] ?? null,
  }));
  const sensors = rows(raw?.s).map(([id, ownerId, team, x, y, z, leftDs]) => ({
    kind: 'sensor', id: String(id), ownerId: String(ownerId), team: TEAM_OF[team] ?? null,
    x: Number(x), y: Number(y), z: Number(z), leftMs: Math.max(0, leftDs | 0) * 100,
  }));
  const m = Array.isArray(raw?.m) ? raw.m : [];
  const list = v => (Array.isArray(v) ? v.map(String) : []);
  return { beacons, sensors, sensed: { alpha: list(m[0]), bravo: list(m[1]) } };
}
