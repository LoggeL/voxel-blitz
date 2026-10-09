/**
 * Pure Conquest HUD read model. Every value here is derived from the
 * authoritative snapshot (match.conquest via decodeConquestMatch, player rows
 * via decodeConquestPlayer / decodeConquestStats, vehicle rows via
 * vehicleStatus and VEHICLE_WEAPON_META) or from server events. Nothing is
 * predicted, and hidden enemy positions are only exposed while spotted.
 */
import {
  CONQUEST_RULES, KITS, KIT_IDS, SCORE_LABELS, SCORE_POINTS, TEAM_DISPLAY, VEHICLE_TOPOLOGY,
  VEHICLE_WEAPON_META, COUNTERMEASURES, decodeConquestPlayer, decodeConquestStats, seatWeaponList,
  vehicleMountOrder, vehicleStatus,
} from '../../../shared/conquest-contract.js';
import {
  decodeConquestMatch, deployOptions, deployViewFromSnapshot, isBotId, oppositeTeam, parseSpawnChoice, resolveDeployChoice, teamSign,
} from '../../../shared/conquest.js';
import * as vehicleDefs from '../../../shared/vehicle-defs.js';
import {
  KIT_ABILITY_LABELS, KIT_GADGET_LABELS, KIT_MENU_ORDER, KIT_ROLE_RULES, kitAbilityHint, kitUnlockLevel, kitUnlocked,
} from '../../../shared/conquest-kits.js';
import { WEAPON_NAMES } from './hud-support.js';
import { relativeTeam, squadName, teamDisplayName } from './conquest/scoring.js';
import {
  angleTo, ballisticAtTime, ballisticImpact, ballisticPoint, clampToEdge, forwardFromAngles, leadPoint, localPlanar,
} from './conquest/projection.js';

/* ------------------------------------------------------------------ teams */

export const CQ_COLORS = Object.freeze({
  own: '#4cc3ff', enemy: '#ff8a3d', neutral: '#d8d8d8', squad: '#7ef29a', self: '#ffffff',
  spotted: '#ff4b4b', down: '#ff6b6b', contested: '#ffd166',
});
export const VEHICLE_LABELS = Object.freeze({ jeep: 'JEEP', tank: 'TANK', helicopter: 'ATTACK HELI', transport: 'TRANSPORT', plane: 'JET' });
const ROLE_LABELS = Object.freeze({ driver: 'DRIVER', pilot: 'PILOT', gunner: 'GUNNER', passenger: 'PASSENGER' });
const SEAT_LABELS = Object.freeze({
  driver: 'DRIVER', gunner: 'GUNNER', commander: 'COMMANDER', 'front-passenger': 'PASSENGER', 'rear-left': 'REAR LEFT',
  'rear-right': 'REAR RIGHT', 'door-left': 'LEFT DOOR', 'door-right': 'RIGHT DOOR',
});
const AIR = new Set(['helicopter', 'transport', 'plane']);
export const isAircraftType = type => AIR.has(type);

export { relativeTeam, teamDisplayName, scoreboardRow, conquestMvps, ticketGraphModel } from './conquest/scoring.js';
export const relativeColor = rel => CQ_COLORS[rel] ?? CQ_COLORS.neutral;

/* ---------------------------------------------------------------- reading */

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp01 = value => Math.max(0, Math.min(1, finite(value)));

/** Map size from mapMeta.dimensions (voxel units = metres). */
export function worldSize(mapMeta) {
  const d = mapMeta?.dimensions;
  return { x: finite(d?.sx, 768), z: finite(d?.sz, 768) };
}

/** Decoded Conquest state plus the map statics needed by the HUD, or null outside Conquest. */
export function readConquest(match, mapMeta) {
  if (match?.mode !== 'conquest' || !match.conquest) return null;
  const meta = mapMeta?.conquest ?? null;
  const decoded = decodeConquestMatch(match.conquest, meta);
  return { ...decoded, size: worldSize(mapMeta), meta };
}

/** The side moving a flag's control, recovered from its state and per-team counts. */
export function flagMover(flag) {
  if (!flag || flag.state === 'idle' || flag.state === 'contested') return null;
  if ((flag.alpha | 0) !== (flag.bravo | 0)) return (flag.alpha | 0) > (flag.bravo | 0) ? 'alpha' : 'bravo';
  return flag.state === 'restoring' ? flag.owner ?? null : null;
}

/* --------------------------------------------------------- tickets + chips */

/** "▼ 1/3s" style label for a bleed of one ticket per `ms`. */
export function bleedLabel(ms) {
  if (!(ms > 0)) return '';
  const seconds = ms / 1000;
  return `▼ 1/${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

/** Clock text m:ss for a remaining duration. */
export function clockText(ms) {
  const total = Math.max(0, Math.ceil(finite(ms) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Own team left in blue, enemy right in orange; bleed is non-zero for the team losing tickets. */
export function ticketModel(cq, selfTeam, nowMs) {
  if (!cq) return null;
  const own = selfTeam === 'bravo' ? 'bravo' : 'alpha', enemy = oppositeTeam(own);
  const max = Math.max(1, finite(cq.maxTickets, CONQUEST_RULES.tickets));
  const side = (team, rel) => {
    const tickets = Math.max(0, cq.tickets?.[team] | 0);
    const bleedMs = Math.max(0, cq.bleed?.[team] | 0);
    return { team, rel, name: teamDisplayName(team), tickets, max, fraction: clamp01(tickets / max), bleedMs,
      bleeding: bleedMs > 0, bleed: bleedLabel(bleedMs), low: tickets <= max * CONQUEST_RULES.ticketLowFractions[0] };
  };
  const timeLeftMs = Number.isFinite(cq.endsAt) && Number.isFinite(nowMs) ? Math.max(0, cq.endsAt - nowMs) : null;
  return { own: side(own, 'own'), enemy: side(enemy, 'enemy'), timeLeftMs, clock: timeLeftMs === null ? '--:--' : clockText(timeLeftMs) };
}

/** One chip per flag: owner colour, progress fill toward the leaning side, contested hatch. */
export function flagChipModels(cq, selfTeam) {
  if (!cq) return [];
  const ownSign = teamSign(selfTeam === 'bravo' ? 'bravo' : 'alpha');
  return cq.flags.map(flag => {
    const relControl = flag.control * ownSign;
    const mover = flagMover(flag);
    return {
      id: flag.id, name: flag.name, state: flag.state,
      owner: relativeTeam(flag.owner, selfTeam),
      lean: relControl > 0.001 ? 'own' : relControl < -0.001 ? 'enemy' : 'neutral',
      fill: clamp01(Math.abs(flag.control)),
      control: relControl,
      contested: flag.state === 'contested',
      moving: mover ? relativeTeam(mover, selfTeam) : null,
      own: flag[selfTeam === 'bravo' ? 'bravo' : 'alpha'] | 0,
      enemy: flag[selfTeam === 'bravo' ? 'alpha' : 'bravo'] | 0,
    };
  });
}

/* ------------------------------------------------------------ capture ring */

/** The flag whose zone contains `pos` (2D radius and presenceDy), nearest first. */
export function zoneAt(cq, pos, rules = CONQUEST_RULES) {
  if (!cq || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return null;
  let best = null, bestDistance = Infinity;
  for (const flag of cq.flags) {
    if (!Number.isFinite(flag.x) || !Number.isFinite(flag.z)) continue;
    const distance = Math.hypot(pos.x - flag.x, pos.z - flag.z);
    if (distance > flag.radius) continue;
    if (Number.isFinite(flag.y) && Number.isFinite(pos.y) && Math.abs(pos.y - flag.y) > rules.presenceDy) continue;
    if (distance < bestDistance) { best = flag; bestDistance = distance; }
  }
  return best;
}

/**
 * Ring under the crosshair while the local player stands in a zone:
 * CAPTURING / NEUTRALIZING / RESTORING (own side moving control),
 * CONTESTED, DEFENDING (own flag held), LOSING / OUTNUMBERED (the enemy moves
 * control while we are inside), NEUTRAL (idle unowned).
 */
export function captureRingModel(cq, self, selfTeam) {
  if (!cq || !self || self.state === 'dead' || !(self.hp > 0)) return null;
  const flag = zoneAt(cq, self);
  if (!flag) return null;
  const own = selfTeam === 'bravo' ? 'bravo' : 'alpha', enemy = oppositeTeam(own);
  const ownCount = flag[own] | 0, enemyCount = flag[enemy] | 0;
  const owner = relativeTeam(flag.owner, own);
  const mover = flagMover(flag), movingRel = mover ? relativeTeam(mover, own) : null;
  let label, tone;
  if (flag.state === 'contested') { label = 'CONTESTED'; tone = 'contested'; }
  else if (movingRel === 'own') {
    label = flag.state === 'neutralizing' ? 'NEUTRALIZING' : flag.state === 'restoring' ? 'RESTORING' : 'CAPTURING';
    tone = 'own';
  } else if (movingRel === 'enemy') {
    label = owner === 'own' ? 'LOSING' : 'OUTNUMBERED';
    tone = 'enemy';
  } else if (owner === 'own') { label = flag.state === 'restoring' ? 'RESTORING' : 'DEFENDING'; tone = 'own'; }
  else if (owner === 'enemy') { label = 'ENEMY FLAG'; tone = 'enemy'; }
  else { label = 'NEUTRAL'; tone = 'neutral'; }
  const relControl = flag.control * teamSign(own);
  return {
    flagId: flag.id, name: flag.name, label, tone, state: flag.state, owner,
    own: ownCount, enemy: enemyCount, counts: `${ownCount} vs ${enemyCount}`,
    control: relControl, fill: clamp01(Math.abs(flag.control)),
    lean: relControl > 0.001 ? 'own' : relControl < -0.001 ? 'enemy' : 'neutral',
  };
}

/* ------------------------------------------------------------- self + rows */

export const selfConquest = self => decodeConquestPlayer(self);
const playerTeam = p => (p?.team === 'alpha' || p?.team === 'bravo') ? p.team : null;
const alive = p => p && p.state !== 'dead' && p.hp > 0;

/** Squad id of the local player (0 none) and the squad roster ids. */
export function squadOf(cq, self, players = []) {
  const team = playerTeam(self);
  const squad = decodeConquestPlayer(self)?.squad | 0;
  const mates = squad > 0 ? players.filter(p => p && String(p.id) !== String(self?.id) && p.team === team &&
    (decodeConquestPlayer(p)?.squad | 0) === squad) : [];
  const entry = cq?.squads?.find(s => s.team === team && s.squadId === squad) ?? null;
  return { squad, leaderId: entry?.leaderId ?? null, mates };
}

/**
 * Squad list beside the minimap: the local player's squadmates from their
 * authoritative rows (cq kit / squad / down, hp, state, vehicleId), leader
 * first. A mate in a hull shows that hull instead of the kit. Null without a
 * squad or squadmates.
 */
export function squadListModel({ cq, self, players = [], vehicles = [] } = {}) {
  if (!self) return null;
  const { squad, leaderId, mates } = squadOf(cq, self, players);
  if (!(squad > 0) || !mates.length) return null;
  const hulls = new Map((vehicles || []).filter(Boolean).map(v => [String(v.id), v]));
  const rows = mates.map(p => {
    const info = decodeConquestPlayer(p);
    const state = info?.down ? 'down' : alive(p) ? 'alive' : 'dead';
    const hull = state === 'alive' && p.vehicleId != null ? hulls.get(String(p.vehicleId)) : null;
    return { id: String(p.id), name: p.name || '', kit: info?.kit ?? null, state, vehicleType: hull?.type ?? null,
      leader: leaderId != null && String(leaderId) === String(p.id) };
  }).sort((a, b) => (b.leader - a.leader) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { squad, name: squadName(squad), selfLeader: leaderId != null && String(leaderId) === String(self.id), rows };
}

/** Restricted / out-of-bounds countdown from cq[4]. */
export function restrictedModel(self, cq = null) {
  const info = decodeConquestPlayer(self);
  if (!info || !(info.restrictedMs > 0) || !alive(self)) return null;
  const team = playerTeam(self);
  const enemyBase = team && cq?.bases?.[oppositeTeam(team)];
  const inEnemyHq = enemyBase && Number.isFinite(enemyBase.x)
    && Math.hypot(self.x - enemyBase.x, self.z - enemyBase.z) <= finite(enemyBase.radius, 56);
  return { ms: info.restrictedMs, seconds: Math.ceil(info.restrictedMs / 1000),
    title: inEnemyHq ? 'ENEMY HQ · RESTRICTED' : 'OUT OF BOUNDS',
    detail: inEnemyHq ? 'LEAVE THE ENEMY BASE' : 'RETURN TO THE BATTLEFIELD',
    urgency: clamp01(1 - info.restrictedMs / CONQUEST_RULES.outOfBoundsMs) };
}

/* --------------------------------------------------------------- vehicles */

const topology = type => VEHICLE_TOPOLOGY[type] || [];
export function seatOccupant(row, seatId) {
  const occupants = row?.seatOccupants;
  if (occupants && typeof occupants === 'object' && Object.hasOwn(occupants, seatId)) {
    const id = occupants[seatId];
    return id == null ? null : String(id);
  }
  return seatId === 'driver' && row?.occupantId != null ? String(row.occupantId) : null;
}

/** Maximum hull HP from the shared vehicle registry, or the legacy row field. */
export function vehicleMaxHp(row) {
  const fromShared = typeof vehicleDefs.vehicleMaxHp === 'function' ? vehicleDefs.vehicleMaxHp(row) : null;
  if (Number.isFinite(fromShared) && fromShared > 0) return fromShared;
  return Number.isFinite(row?.maxHp) && row.maxHp > 0 ? row.maxHp : null;
}

/** The hull and topology seat the local player occupies, by canonical crew membership. */
export function seatedVehicle(self, vehicles = []) {
  if (self?.id == null || !alive(self)) return null;
  const id = String(self.id);
  for (const row of vehicles || []) {
    if (!row || !(row.hp > 0) || row.wreck || vehicleStatus(row).wreck) continue;
    const seats = topology(row.type);
    const index = seats.findIndex(seat => seatOccupant(row, seat.id) === id);
    if (index >= 0) return { row, seat: seats[index], seatIndex: index };
  }
  return null;
}

const nameOf = (players, id) => {
  const row = (players || []).find(p => String(p?.id) === String(id));
  return { name: row?.name ? String(row.name) : null, bot: row?.bot === true };
};

/** Seat strip `F1 DRIVER (you) · F2 COMMANDER [bot]`. */
export function seatStrip(row, selfId, players = []) {
  return topology(row?.type).map((seat, index) => {
    const occupantId = seatOccupant(row, seat.id);
    const who = occupantId ? nameOf(players, occupantId) : { name: null, bot: false };
    const you = occupantId != null && String(occupantId) === String(selfId);
    const label = row?.type === 'tank' && seat.id === 'commander' ? 'COMMANDER' : SEAT_LABELS[seat.id] || ROLE_LABELS[seat.role] || seat.id.toUpperCase();
    return { key: `F${index + 1}`, id: seat.id, role: seat.role, label, occupantId, name: who.name, bot: who.bot, you,
      free: occupantId == null, exposed: seat.exposed,
      text: `${`F${index + 1}`} ${label}${you ? ' (you)' : occupantId ? (who.bot ? ' [bot]' : '') : ' · free'}` };
  });
}

/** Mount state `[yaw, pitch, ammo, heat100, reload100]` for a seat mount, from mounts[]. */
export function mountState(row, seatId, mountId) {
  const order = vehicleMountOrder(row?.type);
  const index = order.indexOf(`${seatId}:${mountId}`);
  const raw = index >= 0 && Array.isArray(row?.mounts) ? row.mounts[index] : null;
  if (!Array.isArray(raw)) return null;
  return { index, yaw: finite(raw[0]), pitch: finite(raw[1]), ammo: Number.isFinite(raw[2]) ? raw[2] : null,
    heat: clamp01(finite(raw[3]) / 100), reload: clamp01(finite(raw[4]) / 100) };
}

/** Selected weapon index of a seat (`sel` is only sent for seats with >1 weapon). */
export function selectedWeaponIndex(row, seatId) {
  const list = seatWeaponList(row?.type, seatId);
  const raw = row?.sel && typeof row.sel === 'object' ? row.sel[seatId] : 0;
  return list.length ? Math.max(0, Math.min(list.length - 1, raw | 0)) : -1;
}

/** Weapon list with ammo, heat and reload for one seat. */
export function seatWeapons(row, seatId) {
  const list = seatWeaponList(row?.type, seatId);
  const selected = selectedWeaponIndex(row, seatId);
  return list.map(({ mount, weapon }, index) => {
    const meta = VEHICLE_WEAPON_META[weapon] || {};
    const state = mountState(row, seatId, mount);
    const heat = state?.heat ?? 0, reload = state?.reload ?? 0;
    return {
      index, mount, weapon, label: meta.label || weapon, kind: meta.kind || null, cls: meta.cls || null,
      selected: index === selected, ammo: state?.ammo ?? null, heat, overheated: heat >= 0.999,
      reload, ready: reload <= 0 && heat < 0.999 && (state?.ammo == null || state.ammo !== 0),
      key: `${index + 1}`,
    };
  });
}

const STATUS_BADGES = Object.freeze([
  ['disabled', 'DISABLED', 'danger'], ['burning', 'BURNING', 'danger'], ['immobilized', 'IMMOBILIZED', 'warn'],
  ['flares', 'FLARES', 'info'], ['smoke', 'SMOKE', 'info'],
]);
const LOCK_LABELS = Object.freeze({ 1: 'LOCKING', 2: 'LOCKED', 3: 'MISSILE INBOUND' });

/** Bearing (radians, 0 = ahead, + clockwise/right) from an observer heading toward a point. */
export function bearingTo(from, yaw, to) {
  const local = localPlanar(to.x - from.x, to.z - from.z, yaw);
  return Math.atan2(local.right, local.forward);
}

/**
 * Lock warning for our hull: lk from the row; the bearing points at the
 * nearest enemy whose own lock progress (cq[5]) is running.
 */
export function lockWarning(row, players = [], selfTeam, yaw) {
  const state = Math.max(0, Math.min(3, row?.lk | 0));
  if (!state) return null;
  let source = null, best = Infinity;
  for (const p of players || []) {
    if (!alive(p) || !p.team || p.team === selfTeam) continue;
    if (!((decodeConquestPlayer(p)?.lockProgress ?? 0) > 0)) continue;
    const d = Math.hypot(p.x - row.x, p.y - row.y, p.z - row.z);
    if (d < best) { best = d; source = p; }
  }
  return { state, label: LOCK_LABELS[state], sourceId: source ? String(source.id) : null,
    bearing: source && Number.isFinite(yaw) ? bearingTo(row, yaw, source) : null, distance: source ? best : null };
}

/** The vehicle panel: seats, hull HP and badges, weapons, countermeasure and lock state. */
/**
 * Height above ground of an aircraft row: 0 while landed, else the distance to
 * the first solid voxel straight below (`raycast(origin, dir, max)` -> { t }),
 * null without a world cast or ground within 400 m.
 */
export function aircraftAgl(row, raycast = null) {
  if (!row || !isAircraftType(row.type) || !Number.isFinite(row.y) || typeof raycast !== 'function') return null;
  if (row.grounded !== false) return 0;
  const hit = raycast({ x: finite(row.x), y: row.y + 0.5, z: finite(row.z) }, { x: 0, y: -1, z: 0 }, 400);
  return hit && Number.isFinite(hit.t) ? Math.max(0, Math.round(hit.t - 0.5)) : null;
}

/**
 * Pilot flight instruments from the authoritative row: airspeed (km/h), height
 * above ground, climb rate (m/s), the jet's persistent throttle (0..1, null
 * for rotors) and its stall flag (airborne only).
 */
export function flightInstruments(row, { raycast = null } = {}) {
  if (!row || !isAircraftType(row.type)) return null;
  const jet = row.type === 'plane';
  const speed = jet && Number.isFinite(row.airspeed) ? row.airspeed : Math.hypot(finite(row.vx), finite(row.vy), finite(row.vz));
  const airborne = row.grounded === false;
  return { rotor: !jet, speedKmh: Math.round(speed * 3.6), agl: aircraftAgl(row, raycast),
    altitude: Number.isFinite(row.y) ? Math.round(row.y) : null, climb: Math.round(finite(row.vy) * 10) / 10,
    throttle: jet ? clamp01(finite(row.throttle)) : null, stalled: jet && airborne && row.stalled === true, airborne };
}

export function vehiclePanelModel(seated, { selfId, players = [], selfTeam = null, yaw = null, raycast = null } = {}) {
  if (!seated?.row) return null;
  const { row, seat } = seated;
  const status = vehicleStatus(row);
  const maxHp = vehicleMaxHp(row);
  const hp = Math.max(0, finite(row.hp));
  const cmKind = COUNTERMEASURES[row.type] ?? null;
  const drives = seat.drives === true;
  const speed = isAircraftType(row.type)
    ? (Number.isFinite(row.airspeed) ? row.airspeed : Math.hypot(finite(row.vx), finite(row.vy), finite(row.vz)))
    : Math.abs(finite(row.speed));
  return {
    type: row.type, name: VEHICLE_LABELS[row.type] || String(row.type || 'VEHICLE').toUpperCase(),
    seatId: seat.id, role: seat.role, drives,
    seats: seatStrip(row, selfId, players),
    hp, maxHp, fraction: maxHp ? clamp01(hp / maxHp) : null,
    hpText: maxHp ? `${Math.ceil(hp)} / ${Math.ceil(maxHp)}` : `${Math.ceil(hp)}`,
    badges: STATUS_BADGES.filter(([key]) => status[key]).map(([key, label, tone]) => ({ key, label, tone })),
    weapons: seatWeapons(row, seat.id),
    cm: cmKind && drives ? { kind: cmKind, label: cmKind === 'smoke' ? 'SMOKE' : 'FLARES',
      ready: clamp01(finite(row.cmr) / 100), available: finite(row.cmr) >= 100, active: status[cmKind] === true } : null,
    lock: lockWarning(row, players, selfTeam, yaw),
    // Height above ground (AGL); the absolute height only without a world cast.
    speedKmh: Math.round(speed * 3.6), altitude: isAircraftType(row.type) && Number.isFinite(row.y) ? Math.round(row.y) : null,
    agl: aircraftAgl(row, raycast),
    throttle: row.type === 'plane' && drives ? Math.round(clamp01(finite(row.throttle)) * 100) : null,
    stalled: row.type === 'plane' && row.grounded === false && row.stalled === true,
    aircraft: isAircraftType(row.type),
  };
}

/** F-key index of the next free seat after `seatId` (wrapping), or -1 when every other seat is taken. */
export function nextFreeSeatIndex(row, seatId) {
  const seats = topology(row?.type);
  if (!seats.length) return -1;
  const current = seats.findIndex(seat => seat.id === seatId);
  for (let step = 1; step <= seats.length; step++) {
    const index = (Math.max(0, current) + step) % seats.length;
    if (index === current) continue;
    if (seatOccupant(row, seats[index].id) == null) return index;
  }
  return -1;
}

/* ---------------------------------------------------------------- reticles */

/** Tank gunner range ladder: horizontal ranges (m) marked along the shell's arc. */
export const TANK_RANGE_TICKS = Object.freeze([100, 200, 300, 400, 500]);
const MOUNT_DEFAULT_HEIGHT = Object.freeze({ jeep: 2.15, tank: 2.3, helicopter: 1.1, transport: 1.5, plane: 1 });

/** Muzzle pose from the shared vehicle registry (mountPose), else from the row mount angles at the hull. */
export function mountPoseOf(row, seatId, mountId, registry = vehicleDefs) {
  const pose = typeof registry?.mountPose === 'function' ? registry.mountPose(row, seatId, mountId) : null;
  if (pose?.origin && pose?.dir) return pose;
  const state = mountState(row, seatId, mountId);
  if (!state || !Number.isFinite(row?.x)) return null;
  const yaw = state.yaw, pitch = state.pitch;
  return { origin: [row.x, finite(row.y) + (MOUNT_DEFAULT_HEIGHT[row.type] ?? 1.5), row.z], dir: forwardFromAngles(yaw, pitch) };
}

/**
 * Reticle description for the seat in screen space. `projector` maps world
 * points to CSS pixels; `aimDistance` is the camera-ray distance to the aimed
 * surface (defaults to 150 m without a surface). `sight` ({ x, y, z, yaw,
 * pitch, zoom }: the camera eye, look and optic zoom) is set while the seat
 * looks through its mount sight (the chin gimbal sensor).
 */
export function reticleModel(seated, { projector = null, players = [], vehicles = [], selfTeam = null, aimDistance = 150, registry = vehicleDefs, raycast = null,
  flightAim = false, sight = null } = {}) {
  if (!seated?.row || !projector) return null;
  const { row, seat } = seated;
  const weapons = seatWeapons(row, seat.id);
  const selected = weapons.find(w => w.selected) || weapons[0] || null;
  const center = { x: projector.width / 2, y: projector.height / 2 };
  const pilot = seat.drives && isAircraftType(row.type);
  // Pilots get the flight instruments; a mouse-aim pilot also the aim circle
  // (screen centre, where the camera looks) apart from the nose marker.
  const base = { type: row.type, seatId: seat.id, center, weapon: selected?.weapon ?? null,
    ...(pilot ? { flight: flightInstruments(row, { raycast }), aim: flightAim === true } : {}) };
  const project = p => { const s = projector.project(p[0], p[1], p[2]); return s.behind ? null : s; };
  if (!selected) {
    if (pilot) {
      // Unarmed pilot (transport): the nose marker 150 m along the hull.
      const ahead = hullPoint(row, registry, null, -150);
      const nose = ahead ? project(ahead) : null;
      return { ...base, kind: 'flight', nose: nose ? { x: nose.x, y: nose.y } : null };
    }
    return null;
  }
  const meta = VEHICLE_WEAPON_META[selected.weapon] || {};
  const pose = mountPoseOf(row, seat.id, selected.mount, registry);
  if (row.type === 'tank' && seat.id === 'driver') {
    // Shells drop (VEHICLE_WEAPON_META gravity): the impact marker sits where the
    // arc from the barrel meets solid terrain (`raycast`, which must skip water like
    // the server's shell cast). A shell that lands nowhere within its lifetime
    // airbursts there (server explodeAt), so the marker shows that burst point.
    // Without a world picker it falls back to `aimDistance` along the arc. The
    // range ladder marks the arc at TANK_RANGE_TICKS metres up to the impact.
    const lifetime = finite(registry?.vehicleWeapon?.(selected.weapon)?.lifetimeMs, 4000) / 1000;
    const landed = pose && raycast ? ballisticImpact(pose.origin, pose.dir, meta.speed, meta.gravity, raycast, { maxSeconds: lifetime }) : null;
    let reach = landed, airburst = false;
    if (pose && raycast && !landed && meta.speed > 0) {
      const point = ballisticAtTime(pose.origin, pose.dir, meta.speed, meta.gravity, lifetime);
      reach = { point, range: Math.hypot(point[0] - pose.origin[0], point[2] - pose.origin[2]), time: lifetime };
      airburst = true;
    }
    const distance = Math.max(20, Math.min(600, finite(aimDistance, 150)));
    const impact = reach?.point ?? (pose ? ballisticPoint(pose.origin, pose.dir, meta.speed, meta.gravity, distance * Math.hypot(pose.dir[0], pose.dir[2])) : null);
    const point = impact ? project(impact) : null;
    const ladder = [];
    for (const range of pose ? TANK_RANGE_TICKS : []) {
      if (reach && range > reach.range + 1) break;
      const at = ballisticPoint(pose.origin, pose.dir, meta.speed, meta.gravity, range);
      const tick = at ? project(at) : null;
      if (tick && Number.isFinite(tick.x) && Number.isFinite(tick.y)) ladder.push({ x: tick.x, y: tick.y, range });
    }
    return { ...base, kind: 'tank', impact: point ? { x: point.x, y: point.y } : null, reload: selected.reload,
      range: reach ? Math.round(reach.range) : null, airburst, ladder,
      ready: selected.ready, label: selected.label, aligned: point ? Math.hypot(point.x - center.x, point.y - center.y) < 6 : false };
  }
  if (row.type === 'helicopter' && seat.drives) {
    const convergence = finite(registry?.vehicleWeapon?.(selected.weapon)?.convergence, 120);
    const point = hullPoint(row, registry, selected.mount, -convergence);
    const pip = point ? project(point) : null;
    return { ...base, kind: 'pods', pip: pip ? { x: pip.x, y: pip.y } : null, convergence, ammo: selected.ammo, reload: selected.reload };
  }
  // Gimbal limits come from the shared mount definition: yawLimit [centre, half] and pitchLimit are hull-relative.
  const mountDef = registry?.vehicleDef?.(row)?.mounts?.[selected.mount] ?? null;
  const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));
  if (row.type === 'helicopter' && seat.id === 'gunner') {
    const state = mountState(row, seat.id, selected.mount);
    const [centre, yawLimit] = Array.isArray(mountDef?.yawLimit) ? mountDef.yawLimit : [0, 1.9];
    const [pitchMin, pitchMax] = Array.isArray(mountDef?.pitchLimit) ? mountDef.pitchLimit : [-1.05, 0.17];
    const relYaw = state ? wrapAngle(state.yaw - finite(row.yaw) - centre) : 0;
    // Snapshot pitch is world pitch; a gimbal mount's limits ride the hull pitch.
    return { ...base, kind: 'gimbal', yaw: relYaw, pitch: state ? state.pitch - finite(row.pitch) : 0, yawLimit, pitchMin, pitchMax,
      heat: selected.heat, overheated: selected.overheated, label: selected.label,
      sensor: sight ? sensorReadout(sight, { pose, state, raycast, project }) : null };
  }
  if (row.type === 'transport' && (seat.id === 'door-left' || seat.id === 'door-right')) {
    const state = mountState(row, seat.id, selected.mount);
    const side = seat.id === 'door-left' ? 1 : -1;
    // Arc: hull-relative yaw within centre ± half (+yaw is left; the left door centres on +π/2).
    const [centerYaw, arc] = Array.isArray(mountDef?.yawLimit) ? mountDef.yawLimit : [side * Math.PI / 2, 1.4];
    const offset = state ? wrapAngle(state.yaw - finite(row.yaw) - centerYaw) : 0;
    return { ...base, kind: 'door', side: seat.id === 'door-left' ? 'left' : 'right', arc, offset,
      atLimit: Math.abs(offset) > arc - 0.08, heat: selected.heat, overheated: selected.overheated };
  }
  if (row.type === 'plane') {
    const nose = hullPoint(row, registry, 'nose', 0) ?? [row.x, finite(row.y) + 1, row.z];
    const far = hullPoint(row, registry, 'nose', -300);
    const dir = far ? [far[0] - nose[0], far[1] - nose[1], far[2] - nose[2]].map(v => v / 300) : forwardFromAngles(finite(row.yaw), finite(row.pitch));
    const bore = project(far ?? [nose[0] + dir[0] * 300, nose[1] + dir[1] * 300, nose[2] + dir[2] * 300]);
    const target = pickAirTarget(row, dir, nose, vehicles, selfTeam, selected.weapon === 'aaMissile' ? 350 : 600);
    let pipper = null, lockBox = null;
    if (target) {
      const velocity = [finite(target.vx), finite(target.vy), finite(target.vz)];
      const lead = leadPoint(nose, [target.x, target.y, target.z], velocity, finite(meta.speed));
      const p = project(lead.point);
      if (p) pipper = { x: p.x, y: p.y, tof: lead.tof, range: Math.round(Math.hypot(target.x - nose[0], target.y - nose[1], target.z - nose[2])) };
      const t = project([target.x, target.y, target.z]);
      if (t) lockBox = { x: t.x, y: t.y, id: String(target.id) };
    }
    const speed = Number.isFinite(row.airspeed) ? row.airspeed : Math.hypot(finite(row.vx), finite(row.vy), finite(row.vz));
    return { ...base, kind: 'jet', boresight: bore ? { x: bore.x, y: bore.y } : null, pipper, target: lockBox,
      speedKmh: Math.round(speed * 3.6), altitude: base.flight?.agl ?? Math.round(finite(row.y)), heat: selected.heat, label: selected.label };
  }
  // Pintle, RWS and other hitscan mounts: barrel crosshair 100 m along the mount.
  const aim = pose ? project([pose.origin[0] + pose.dir[0] * 100, pose.origin[1] + pose.dir[1] * 100, pose.origin[2] + pose.dir[2] * 100]) : null;
  return { ...base, kind: 'mg', barrel: aim ? { x: aim.x, y: aim.y } : null, heat: selected.heat, overheated: selected.overheated };
}

/** Longest sensor rangefinder cast (m); farther or open sky reads as no return. */
export const SENSOR_RANGE_MAX = 1500;

/**
 * Gimbal sensor readouts from the camera and the authoritative mount row:
 * rangefinder distance along the sight line (`raycast`, null without a
 * return), compass heading and elevation of the sight (degrees, heading 0 =
 * north, clockwise), optic zoom, and `pip`, the screen point 300 m along
 * where the barrel actually points (it trails the sight while the turret
 * slews) and whether it sits on the crosshair.
 */
export function sensorReadout(sight, { pose = null, state = null, raycast = null, project = null } = {}) {
  const yaw = finite(sight.yaw), pitch = finite(sight.pitch);
  const dir = forwardFromAngles(yaw, pitch);
  let range = null;
  if (raycast && Number.isFinite(sight.x)) {
    const hit = raycast({ x: sight.x, y: finite(sight.y), z: finite(sight.z) }, { x: dir[0], y: dir[1], z: dir[2] }, SENSOR_RANGE_MAX);
    if (Number.isFinite(hit?.t)) range = Math.round(hit.t);
  }
  const heading = Math.round(((-yaw * 180 / Math.PI) % 360 + 360) % 360) % 360;
  let pip = null;
  if (pose?.origin && pose?.dir && project) {
    const far = 300, p = project([pose.origin[0] + pose.dir[0] * far, pose.origin[1] + pose.dir[1] * far, pose.origin[2] + pose.dir[2] * far]);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) pip = { x: p.x, y: p.y };
  }
  return { range, heading, elevation: Math.round(pitch * 180 / Math.PI), zoom: Math.max(1, finite(sight.zoom, 1)),
    pip, slewing: !!state && Math.abs(Math.atan2(Math.sin(state.yaw - yaw), Math.cos(state.yaw - yaw))) + Math.abs(state.pitch - pitch) > 0.02 };
}

/** World point `ahead` metres along the hull's nose axis from a mount pivot (hull frame, -Z forward). */
function hullPoint(row, registry, mountId, ahead) {
  const pivot = registry?.vehicleDef?.(row)?.mounts?.[mountId]?.pivot;
  if (Array.isArray(pivot) && typeof registry.vehicleLocalPoint === 'function') {
    return registry.vehicleLocalPoint(row, pivot[0], pivot[1], pivot[2] + ahead);
  }
  if (!Number.isFinite(row?.x)) return null;
  const dir = forwardFromAngles(finite(row.yaw), finite(row.pitch));
  return [row.x - dir[0] * ahead, finite(row.y) + 1 - dir[1] * ahead, row.z - dir[2] * ahead];
}

/** Enemy aircraft closest to the boresight within range and a cone (default 15°). */
export function pickAirTarget(row, dir, from, vehicles, selfTeam, range, cone = 15 * Math.PI / 180) {
  let best = null, bestAngle = cone;
  for (const v of vehicles || []) {
    if (!v || v.id === row.id || !isAircraftType(v.type) || !(v.hp > 0) || !v.team || v.team === selfTeam) continue;
    const point = [v.x, v.y, v.z];
    if (Math.hypot(v.x - from[0], v.y - from[1], v.z - from[2]) > range) continue;
    const angle = angleTo(dir, from, point);
    if (angle < bestAngle) { bestAngle = angle; best = v; }
  }
  return best;
}

/**
 * Locker box for our own lock attempt (cq[5]): progress is authoritative; the
 * box marks the enemy aircraft inside the server's lock cone and range for
 * the weapon in use (jet AA missile when flying the plane, else the Engineer's
 * AX-9 STINGER), with a little slack for the view moving between snapshots.
 */
export function lockerModel(self, { projector = null, vehicles = [], selfTeam = null, camera = null, seated = null, registry = vehicleDefs } = {}) {
  const progress = decodeConquestPlayer(self)?.lockProgress ?? 0;
  if (!(progress > 0)) return null;
  let target = null;
  if (projector && camera) {
    const rules = registry?.LOCK_RULES?.[seated?.row?.type === 'plane' ? 'aaMissile' : 'stinger'] ?? { range: 400, cone: 15 * Math.PI / 180 };
    const dir = forwardFromAngles(camera.yaw, camera.pitch);
    const from = [camera.x, camera.y, camera.z];
    target = pickAirTarget({ id: seated?.row?.id ?? null }, dir, from, vehicles, selfTeam, rules.range * 1.1, rules.cone * 1.5);
  }
  const screen = target && projector ? projector.project(target.x, target.y, target.z) : null;
  return { progress, locked: progress >= 1, label: progress >= 1 ? 'LOCKED' : `LOCKING ${Math.round(progress * 100)}%`,
    box: screen && !screen.behind ? { x: screen.x, y: screen.y } : null, targetId: target ? String(target.id) : null };
}

/* ----------------------------------------------------------------- markers */

/** Screen-space flag markers: letter, distance, progress arc, edge clamp, contested pulse. */
export function flagMarkerModels(cq, self, selfTeam, projector, insets) {
  if (!cq || !projector) return [];
  const chips = new Map(flagChipModels(cq, selfTeam).map(c => [c.id, c]));
  const eye = { x: finite(self?.x), y: finite(self?.y), z: finite(self?.z) };
  return cq.flags.filter(f => Number.isFinite(f.x) && Number.isFinite(f.z)).map(flag => {
    const y = Number.isFinite(flag.y) ? flag.y + 6 : eye.y;
    const p = projector.project(flag.x, y, flag.z);
    const placed = clampToEdge(p, projector.width, projector.height, insets);
    const chip = chips.get(flag.id);
    return { id: flag.id, x: placed.x, y: placed.y, edge: placed.edge, angle: placed.angle,
      distance: Math.round(Math.hypot(flag.x - eye.x, flag.z - eye.z)), owner: chip.owner, lean: chip.lean,
      fill: chip.fill, contested: chip.contested, moving: chip.moving, inside: zoneAt(cq, self)?.id === flag.id };
  });
}

/** Screen box of one flag marker around its centre: the 40 px diamond plus the distance label below it. */
export const FLAG_MARKER_BOX = Object.freeze({ left: 24, right: 24, top: 22, bottom: 36 });
/** Clear space kept between two flag markers, so a column of edge markers reads as separate markers. */
export const EDGE_MARKER_GAP = 10;
const EDGE_STEP = 4;

/**
 * Edge-clamped flag markers slide along their border so they never stack on
 * each other or on fixed HUD panels (`obstacles`: screen rects of the minimap,
 * vehicle card, touch buttons...). Nearest flags keep their natural slot first;
 * the others slide away from their nearest neighbour on the same border, so
 * the order along the border follows the flags' bearings. A marker whose border
 * is full moves to the nearest free slot on another border; when no slot clears
 * the panels it still keeps clear of the other markers (a marker over a panel
 * edge reads better than two piled markers). On-screen markers are
 * world-anchored: they never move but are avoided.
 */
export function spreadEdgeMarkers(models, { width, height, insets = {}, obstacles = [], box = FLAG_MARKER_BOX, gap = EDGE_MARKER_GAP } = {}) {
  if (!Array.isArray(models) || !models.some(m => m.edge && !m.inside)) return models;
  const { top = 72, bottom = 96, left = 40, right = 40 } = insets;
  const minX = left, maxX = width - right, minY = top, maxY = height - bottom;
  const pad = gap / 2;
  const rectAt = (x, y, grow = 0) => ({ left: x - box.left - grow, right: x + box.right + grow, top: y - box.top - grow, bottom: y + box.bottom + grow });
  const hits = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const out = models.map(m => ({ ...m }));
  // Marker rects carry half the gap each, so two neighbours keep `gap` px between them.
  const placed = out.filter(m => !m.edge && !m.inside).map(m => rectAt(m.x, m.y, pad));
  const clearOfMarkers = (x, y) => { const r = rectAt(x, y, pad); return !placed.some(p => hits(r, p)); };
  const clearOfPanels = (x, y) => { const r = rectAt(x, y); return !obstacles.some(o => o && hits(r, o)); };
  const free = (x, y) => clearOfPanels(x, y) && clearOfMarkers(x, y);
  const onBorder = [];
  const order = out.filter(m => m.edge && !m.inside).sort((a, b) => a.distance - b.distance || String(a.id).localeCompare(String(b.id)));
  const around = [];
  for (let x = minX; x <= maxX; x += EDGE_STEP) around.push({ x, y: minY }, { x, y: maxY });
  for (let y = minY; y <= maxY; y += EDGE_STEP) around.push({ x: minX, y }, { x: maxX, y });
  const nearestOf = (list, m) => list.reduce((best, p) => (!best || Math.hypot(p.x - m.x, p.y - m.y) < Math.hypot(best.x - m.x, best.y - m.y) ? p : best), null);
  for (const m of order) {
    // Left / right borders slide vertically; top / bottom borders slide horizontally.
    const vertical = Math.abs(m.x - minX) < 0.5 || Math.abs(m.x - maxX) < 0.5;
    const side = vertical ? (m.x < width / 2 ? 'left' : 'right') : (m.y < height / 2 ? 'top' : 'bottom');
    const [lo, hi, start] = vertical ? [minY, maxY, m.y] : [minX, maxX, m.x];
    // Slide away from the nearest already placed neighbour on this border (keeps the bearing order).
    const neighbour = onBorder.filter(n => n.side === side).reduce((best, n) => (!best || Math.abs(n.along - start) < Math.abs(best.along - start) ? n : best), null);
    const dir = neighbour && start < neighbour.along ? -1 : 1;
    const span = Math.max(start - lo, hi - start);
    let spot = null;
    for (let d = 0; d <= span && !spot; d += EDGE_STEP) {
      for (const along of d === 0 ? [start] : [start + d * dir, start - d * dir]) {
        if (along < lo || along > hi) continue;
        const x = vertical ? m.x : along, y = vertical ? along : m.y;
        if (free(x, y)) { spot = { x, y }; break; }
      }
    }
    // A full border (phone landscape has room for about two per side): take the nearest free slot on the others,
    // then the nearest slot that at least clears the other markers.
    if (!spot) spot = nearestOf(around.filter(p => free(p.x, p.y)), m) ?? nearestOf(around.filter(p => clearOfMarkers(p.x, p.y)), m);
    if (spot) { m.x = spot.x; m.y = spot.y; }
    placed.push(rectAt(m.x, m.y, pad));
    onBorder.push({ side, along: start });
  }
  return out;
}

const DOWN_RANGE = 40, SQUAD_RANGE = 400, TEAM_RANGE = 160, SPOT_RANGE = 600;
/** A Medic sees downed mates this far and a heal cross over mates under WOUNDED_FRACTION HP within WOUNDED_RANGE. */
const MEDIC_DOWN_RANGE = 60, WOUNDED_RANGE = 40, WOUNDED_FRACTION = 0.6;

/**
 * Unit markers: squadmates (green, named), teammates (blue dots), downed
 * teammates within 40 m (cross) and spotted enemies (red diamonds) from
 * cq[3] and vehicles[].sp. Seated players are represented by their hull.
 */
export function unitMarkerModels({ self, players = [], vehicles = [], selfTeam, projector, insets = undefined } = {}) {
  if (!projector || !self) return [];
  const selfId = String(self.id);
  const selfInfo = decodeConquestPlayer(self);
  const squad = selfInfo?.squad | 0;
  const medic = KITS[selfInfo?.kit]?.ability === 'revive';
  const out = [];
  const eye = { x: finite(self.x), y: finite(self.y), z: finite(self.z) };
  const place = (x, y, z, edgeAllowed) => {
    const p = projector.project(x, y, z);
    if (!edgeAllowed && !p.inside) return null;
    const placed = edgeAllowed ? clampToEdge(p, projector.width, projector.height, insets) : { x: p.x, y: p.y, edge: false, angle: 0 };
    return placed;
  };
  for (const p of players || []) {
    if (!p || String(p.id) === selfId || !Number.isFinite(p.x)) continue;
    const info = decodeConquestPlayer(p);
    const distance = Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z);
    if (p.team === selfTeam) {
      if (info?.down && distance <= (medic ? MEDIC_DOWN_RANGE : DOWN_RANGE)) {
        const s = place(p.x, p.y + 0.6, p.z, true);
        if (s) out.push({ kind: 'down', id: String(p.id), name: p.name || '', distance: Math.round(distance), ...s });
        continue;
      }
      if (!alive(p) || p.vehicleId) continue;
      // Medic: a green cross over wounded mates nearby (row hp is authoritative).
      if (medic && distance <= WOUNDED_RANGE && Number.isFinite(p.hp) && p.hp > 0 && p.hp < WOUNDED_FRACTION * 100) {
        const s = place(p.x, p.y + 2.5, p.z, false);
        if (s) out.push({ kind: 'wounded', id: String(p.id), name: '', distance: Math.round(distance), hp: Math.round(p.hp), ...s });
      }
      const mate = squad > 0 && (info?.squad | 0) === squad;
      if (distance > (mate ? SQUAD_RANGE : TEAM_RANGE)) continue;
      const s = place(p.x, p.y + 2.1, p.z, false);
      if (s) out.push({ kind: mate ? 'squad' : 'team', id: String(p.id), name: mate ? p.name || '' : '', distance: Math.round(distance), ...s });
    } else if (p.team && info?.spotted && alive(p) && !p.vehicleId && distance <= SPOT_RANGE) {
      const s = place(p.x, p.y + 2.2, p.z, false);
      if (s) out.push({ kind: 'spotted', id: String(p.id), name: '', distance: Math.round(distance), ...s });
    }
  }
  for (const v of vehicles || []) {
    if (!v || !(v.hp > 0) || !Number.isFinite(v.x) || !v.team || v.team === selfTeam || v.sp !== 1) continue;
    const distance = Math.hypot(v.x - eye.x, v.y - eye.y, v.z - eye.z);
    if (distance > SPOT_RANGE * 1.5) continue;
    const s = place(v.x, v.y + 4, v.z, false);
    if (s) out.push({ kind: 'spotted-vehicle', id: String(v.id), vehicleType: v.type, name: VEHICLE_LABELS[v.type] || '', distance: Math.round(distance), ...s });
  }
  return out;
}

/* ----------------------------------------------------------------- minimap */

/**
 * Map items in world coordinates with team-relative tones. Enemies appear
 * only while spotted; teammates and own-team hulls always.
 */
export function mapItems({ cq, self, players = [], vehicles = [], selfTeam }) {
  if (!cq) return [];
  const items = [];
  const selfId = String(self?.id ?? '');
  const squad = decodeConquestPlayer(self)?.squad | 0;
  for (const [team, base] of Object.entries(cq.bases || {})) {
    if (!Number.isFinite(base?.x)) continue;
    items.push({ kind: 'hq', team, rel: relativeTeam(team, selfTeam), x: base.x, z: base.z, radius: finite(base.radius, 56), label: 'HQ', name: base.name || `${teamDisplayName(team)} HQ` });
  }
  for (const chip of flagChipModels(cq, selfTeam)) {
    const flag = cq.flags.find(f => f.id === chip.id);
    if (!Number.isFinite(flag?.x)) continue;
    items.push({ kind: 'flag', id: flag.id, rel: chip.owner, lean: chip.lean, fill: chip.fill, contested: chip.contested,
      x: flag.x, z: flag.z, radius: flag.radius, label: flag.id, name: flag.name });
  }
  for (const v of vehicles || []) {
    if (!v || !(v.hp > 0) || !Number.isFinite(v.x)) continue;
    const rel = relativeTeam(v.team, selfTeam);
    if (rel === 'enemy' && v.sp !== 1) continue;
    if (rel === 'neutral') continue;
    items.push({ kind: 'vehicle', id: String(v.id), rel: rel === 'enemy' ? 'spotted' : 'own', vehicleType: v.type, x: v.x, z: v.z, yaw: finite(v.yaw) });
  }
  for (const p of players || []) {
    if (!p || String(p.id) === selfId || !Number.isFinite(p.x)) continue;
    const info = decodeConquestPlayer(p);
    if (p.team === selfTeam) {
      if (info?.down) { items.push({ kind: 'down', id: String(p.id), rel: 'own', x: p.x, z: p.z }); continue; }
      if (!alive(p) || p.vehicleId) continue;
      const mate = squad > 0 && (info?.squad | 0) === squad;
      items.push({ kind: mate ? 'squad' : 'team', id: String(p.id), rel: mate ? 'squad' : 'own', x: p.x, z: p.z, yaw: finite(p.yaw), name: p.name || '' });
    } else if (p.team && info?.spotted && alive(p) && !p.vehicleId) {
      items.push({ kind: 'spotted', id: String(p.id), rel: 'spotted', x: p.x, z: p.z });
    }
  }
  if (self && alive(self) && Number.isFinite(self.x)) {
    // The Medic's heal aura reach around itself (KIT_ROLE_RULES.healRadius).
    if (KITS[decodeConquestPlayer(self)?.kit]?.aura === 'heal' && !self.vehicleId) items.push({ kind: 'aura', id: `${selfId}:aura`, rel: 'squad', x: self.x, z: self.z, radius: KIT_ROLE_RULES.healRadius });
    items.push({ kind: 'self', id: selfId, rel: 'self', x: self.x, z: self.z, yaw: finite(self.yaw) });
  }
  return items;
}

/** Heading-up minimap placement: px offsets from the map centre for a radius in metres. */
export function minimapPlacement(item, center, yaw, pxPerMetre) {
  const local = localPlanar(item.x - center.x, item.z - center.z, yaw);
  return { x: local.right * pxPerMetre, y: -local.forward * pxPerMetre, heading: Number.isFinite(item.yaw) ? item.yaw - yaw : 0 };
}

/* ------------------------------------------------------------------ events */

/** Score ticker entry for an own `score` event. */
export function scoreEntry(ev, selfId) {
  if (ev?.kind !== 'score' || String(ev.id) !== String(selfId)) return null;
  const pts = Math.round(finite(ev.pts));
  const reason = typeof ev.reason === 'string' ? ev.reason : '';
  return { pts, reason, label: SCORE_LABELS[reason] || reason.replace(/_/g, ' ').toUpperCase() || 'SCORE',
    text: `+${pts} ${SCORE_LABELS[reason] || 'SCORE'}`, base: SCORE_POINTS[reason] ?? null };
}

/**
 * Objective banners from events: captured, lost, neutralized, under attack
 * (flag_state with the enemy moving control on an own flag), ticket low.
 * `flagOwner` is the owner of the flag in the latest snapshot before the event.
 */
export function bannerForEvent(ev, selfTeam, { flagOwner = null, flagName = null } = {}) {
  if (!ev || !selfTeam) return null;
  const label = id => `OBJECTIVE ${id}${flagName ? ` · ${String(flagName).toUpperCase()}` : ''}`;
  switch (ev.kind) {
    case 'flag_captured':
      return ev.team === selfTeam
        ? { key: `cap:${ev.flag}`, tone: 'own', title: `${label(ev.flag)} CAPTURED`, detail: 'FLAG SECURED', flag: ev.flag, priority: 3 }
        : { key: `cap:${ev.flag}`, tone: 'enemy', title: `${label(ev.flag)} TAKEN BY ${teamDisplayName(ev.team)}`, detail: 'RETAKE IT', flag: ev.flag, priority: 2 };
    case 'flag_neutralized':
      if (ev.prev === selfTeam) return { key: `neu:${ev.flag}`, tone: 'enemy', title: `${label(ev.flag)} LOST`, detail: 'FLAG NEUTRALIZED', flag: ev.flag, priority: 4 };
      if (ev.team === selfTeam) return { key: `neu:${ev.flag}`, tone: 'own', title: `${label(ev.flag)} NEUTRALIZED`, detail: 'KEEP CAPTURING', flag: ev.flag, priority: 2 };
      return null;
    case 'flag_state':
      if (flagOwner !== selfTeam) return null;
      if ((ev.state === 'neutralizing' && ev.team && ev.team !== selfTeam) || ev.state === 'contested') {
        return { key: `atk:${ev.flag}`, tone: 'enemy', title: `${label(ev.flag)} UNDER ATTACK`, detail: ev.state === 'contested' ? 'CONTESTED' : 'DEFEND IT', flag: ev.flag, priority: 1 };
      }
      return null;
    case 'ticket_low': {
      const own = ev.team === selfTeam;
      return { key: `tl:${ev.team}:${ev.tickets}`, tone: own ? 'enemy' : 'own', title: own ? 'REINFORCEMENTS LOW' : 'ENEMY REINFORCEMENTS LOW',
        detail: `${teamDisplayName(ev.team)} · ${Math.max(0, ev.tickets | 0)} TICKETS`, priority: 5 };
    }
    default:
      return null;
  }
}

/** Match-end banner from the authoritative result (phase post + winner). */
export function matchEndBanner(match, selfTeam) {
  if (match?.mode !== 'conquest' || match.phase !== 'post') return null;
  const winner = match.winner ?? null;
  if (winner == null) return { key: 'end:draw', tone: 'neutral', title: 'DRAW', detail: 'TICKETS AND FLAGS EVEN', priority: 9, outcome: 'draw' };
  const won = winner === selfTeam;
  return { key: `end:${winner}`, tone: won ? 'own' : 'enemy', title: won ? 'VICTORY' : 'DEFEAT',
    detail: `${teamDisplayName(winner)} WINS`, priority: 9, outcome: won ? 'victory' : 'defeat' };
}

/** Hitmarker variant of a vehicle_hit by the local player: yellow when effective, white spark when not. */
export function vehicleHitMark(ev, selfId) {
  if (ev?.kind !== 'vehicle_hit' || String(ev.attacker) !== String(selfId)) return null;
  return ev.eff === 1 || ev.eff === true ? 'armor' : 'spark';
}

/** Hull-zone flash on our own vehicle from a vehicle_hit. */
export function hullZoneFlash(ev, seatedRow) {
  if (ev?.kind !== 'vehicle_hit' || !seatedRow || String(ev.vehicleId) !== String(seatedRow.id)) return null;
  return { zone: typeof ev.zone === 'string' ? ev.zone : 'side', effective: ev.eff === 1 || ev.eff === true };
}

export const DEPLOY_REFUSED_TEXT = Object.freeze({
  invalid: 'THAT SPAWN IS NOT AVAILABLE', contested: 'FLAG IS CONTESTED OR BEING NEUTRALIZED', enemy: 'ENEMIES IN THE ZONE',
  busy: 'TARGET IS BUSY', cooldown: 'SQUAD SPAWN COOLING DOWN', seat: 'NO FREE SEAT', locked: 'CLASS LOCKED',
});
/** Refusal text; a `locked` refusal names the level that opens the kit ('CLASS LOCKED · LV 5'). */
export function deployRefusedText(reason, level = null) {
  const base = DEPLOY_REFUSED_TEXT[reason] || String(reason || 'invalid').toUpperCase();
  return reason === 'locked' && Number.isFinite(level) ? `${base} · LV ${level}` : base;
}

/**
 * Kit unlock state of the local player from the latest own `kit_unlocks`
 * event (authoritative). Without one only the base kits are open.
 */
export function kitUnlockState(ev = null) {
  const level = Number.isFinite(ev?.level) && ev.level >= 1 ? Math.trunc(ev.level) : 1;
  const listed = Array.isArray(ev?.unlocked) ? ev.unlocked.filter(id => KIT_IDS.includes(id)) : null;
  const unlocked = new Set(listed ?? KIT_IDS.filter(id => kitUnlocked(id, level)));
  return { level, unlocked, known: !!ev };
}

/** `kit_unlocks` for this player, or null. */
export function ownKitUnlocks(ev, selfId) {
  if (ev?.kind !== 'kit_unlocks' || selfId == null || String(ev.id) !== String(selfId)) return null;
  return { level: ev.level, unlocked: Array.isArray(ev.unlocked) ? ev.unlocked.slice() : [], newly: Array.isArray(ev.newly) ? ev.newly.slice() : [] };
}

/** Banner for newly unlocked kits ('NEW CLASS UNLOCKED · PYRO'). */
export function kitUnlockBanner(unlocks, now = 0) {
  const newly = (unlocks?.newly || []).filter(id => KITS[id]);
  if (!newly.length) return null;
  const names = newly.map(id => KITS[id].label);
  return { key: `kit:${newly.join(',')}:${now}`, tone: 'own', priority: 5,
    title: newly.length === 1 ? `NEW CLASS UNLOCKED · ${names[0]}` : 'NEW CLASSES AVAILABLE',
    detail: newly.length === 1 ? `CAREER LV ${unlocks.level} · PICK IT ON THE DEPLOY SCREEN` : names.join(' · ') };
}

/**
 * Killer card for the deploy screen from the authoritative `kill` event of the
 * local player's death; distance from the latest snapshot rows of both.
 */
export function killerCard(ev, selfId, players = []) {
  if (ev?.kind !== 'kill' || selfId == null || String(ev.victim) !== String(selfId)) return null;
  const key = typeof ev.w === 'string' ? ev.w : '';
  const weaponName = WEAPON_NAMES[key] || (key ? key.toUpperCase() : null);
  const killerId = ev.killer == null || ev.killer === '' ? null : String(ev.killer);
  // World deaths (no killer: a fall, the restricted area) read as your own.
  const own = killerId === null || killerId === String(selfId);
  const killer = own ? null : (players || []).find(p => String(p?.id) === killerId) ?? null;
  const victim = (players || []).find(p => String(p?.id) === String(selfId)) ?? null;
  // The server's lethal shot length (ray kills) wins; otherwise the distance between the latest rows.
  const distance = Number.isFinite(ev.dist) && ev.dist > 0 ? ev.dist
    : killer && victim && [killer.x, killer.y, killer.z, victim.x, victim.y, victim.z].every(Number.isFinite)
      ? Math.hypot(killer.x - victim.x, killer.y - victim.y, killer.z - victim.z) : null;
  return {
    self: own, killerId, name: own ? (weaponName || 'YOU DIED') : String(killer?.name || killerId),
    weapon: key || null, weaponName: own ? null : weaponName, distance, headshot: ev.hs === true || ev.hs === 1,
    team: killer?.team ?? null,
  };
}

/* ------------------------------------------------------------------ deploy */

const KIT_WEAPON_LABEL = id => WEAPON_NAMES[id] || String(id || '').toUpperCase();
/** Gadget index valid for a kit: 1 only where the kit offers a second gadget. */
export const kitGadgetIndex = (kit, gadget) => (gadget === 1 && (KITS[kit]?.gadgets?.length ?? 0) > 1 ? 1 : 0);
/**
 * Kit cards for the picker; variant 0/1 selects the primary and `gadget` 0/1
 * the gadget of kits that offer a choice (the Engineer: AT launcher or STINGER).
 * `gadget` on a card is the selected gadget's name (null for kits without one).
 */
export function kitCards(selectedKit, variant = 0, gadget = 0, { unlocked = null, career = null } = {}) {
  const open = unlocked instanceof Set ? unlocked : kitUnlockState().unlocked;
  return KIT_MENU_ORDER.map(id => {
    const kit = KITS[id];
    const chosen = id === selectedKit ? kitGadgetIndex(id, gadget) : 0;
    const gadgets = (kit.gadgets ?? []).length > 1 ? kit.gadgets.map((weapon, index) => ({ index, weapon,
      role: KIT_GADGET_LABELS[weapon]?.role ?? '', hint: KIT_GADGET_LABELS[weapon]?.hint ?? '',
      label: KIT_WEAPON_LABEL(weapon), selected: id === selectedKit && index === chosen })) : [];
    const gadgetId = kit.gadgets?.[chosen] ?? kit.gadget;
    const unlockLevel = kitUnlockLevel(id);
    const isOpen = open.has(id);
    // XP toward the unlock level (careerView: xp; level L starts at 100·(L-1)² XP).
    const needXp = (unlockLevel - 1) ** 2 * 100;
    const xp = Number.isFinite(career?.xp) ? Math.max(0, career.xp) : null;
    const progress = !isOpen && xp !== null ? { xp: Math.min(xp, needXp), need: needXp, fraction: needXp > 0 ? clamp01(xp / needXp) : 1 } : null;
    return { id, label: kit.label, ability: KIT_ABILITY_LABELS[kit.ability] ?? kit.ability.toUpperCase(),
      abilityId: kit.ability, hint: kitAbilityHint(id, CONQUEST_RULES), selected: id === selectedKit,
      row: unlockLevel > 1 ? 'unlock' : 'base', unlockLevel, unlocked: isOpen, lockText: isOpen ? '' : `LV ${unlockLevel}`, progress,
      primaries: kit.primaries.map((weapon, index) => ({ index, weapon, label: KIT_WEAPON_LABEL(weapon), selected: id === selectedKit && index === (variant | 0) })),
      gadget: gadgetId ? KIT_WEAPON_LABEL(gadgetId) : null, gadgetId: gadgetId ?? null, gadgets,
      grenades: Object.entries(kit.grenades).map(([type, count]) => `${count}× ${GRENADE_LABEL[type] || type.toUpperCase()}`) };
  });
}

/** Grenade names as the HUD shows them (the limpet charge is the CLAYMORE). */
const GRENADE_LABEL = Object.freeze({ frag: 'FRAG', limpet: 'CLAYMORE', pulse: 'PULSE', molotov: 'MOLOTOV', smoke: 'SMOKE' });

/** Nearest living, on-foot friendly Medic (revive ability) to a point: {id, name, distance} or null. */
export function nearestMedic(players = [], self) {
  if (!self || !Number.isFinite(self.x)) return null;
  let best = null;
  for (const p of players || []) {
    if (!p || String(p.id) === String(self.id) || p.team !== self.team || !alive(p) || p.vehicleId) continue;
    if (KITS[decodeConquestPlayer(p)?.kit]?.ability !== 'revive') continue;
    const distance = Math.hypot(p.x - self.x, p.y - self.y, p.z - self.z);
    if (!best || distance < best.distance) best = { id: String(p.id), name: String(p.name || 'MEDIC').toUpperCase(), distance: Math.round(distance) };
  }
  return best;
}

/**
 * Deploy screen model: spawn options from the shared deployOptions (the same
 * function the server validates with), the selected choice, countdown to
 * respawnAt and the refusal of the latest choice.
 */
export function deployModel({ cq, self, players = [], vehicles = [], nowMs = null, selection = null, refused = null,
  unlocks = null, career = null } = {}) {
  if (!cq || !self) return null;
  const team = playerTeam(self);
  const info = decodeConquestPlayer(self);
  const view = deployViewFromSnapshot(cq, players, vehicles, decodeConquestPlayer);
  const options = deployOptions(view, { id: self.id, team, squad: info?.squad | 0 });
  const names = new Map((players || []).map(p => [String(p.id), p.name || String(p.id)]));
  const decorated = options.map(option => {
    let label, detail, takeoverNames = null;
    if (option.kind === 'hq') { label = `${teamDisplayName(team)} HQ`; detail = cq.bases?.[team]?.name || 'HEADQUARTERS'; }
    else if (option.kind === 'flag') { const f = cq.flags.find(fl => fl.id === option.id); label = `FLAG ${option.id}`; detail = f?.name?.toUpperCase() || ''; }
    else if (option.kind === 'squad') {
      label = String(names.get(option.id) || 'SQUADMATE').toUpperCase();
      // A mate in an aircraft seats you in it (a free seat, else a bot's).
      detail = option.vehicleId ? `IN ${VEHICLE_LABELS[option.type] || 'AIRCRAFT'} · ${SEAT_LABELS[option.seatId] || 'SEAT'}` : 'SQUADMATE';
    }
    else {
      label = VEHICLE_LABELS[option.type] || 'VEHICLE';
      // Seats a friendly bot holds can be taken: the bot is put out on deploy.
      const hull = option.takeover ? (vehicles || []).find(v => String(v?.id) === option.id) : null;
      for (const seatId of option.takeover || []) (takeoverNames ||= {})[seatId] = String(names.get(seatOccupant(hull, seatId)) || 'BOT').toUpperCase();
      detail = option.seats?.length ? `${option.seats.length} FREE SEAT${option.seats.length === 1 ? '' : 'S'}`
        : option.takeover?.length ? `TAKE SEAT · ${takeoverNames[option.takeover[0]]}` : 'FULL';
    }
    const base = option.kind === 'hq' ? cq.bases?.[team] : null;
    return { ...option, label, detail, x: option.x ?? base?.x ?? null, z: option.z ?? base?.z ?? null,
      ...(takeoverNames ? { takeoverNames, seatChoices: topology(option.type).map(seat => seat.id)
        .filter(id => option.seats?.includes(id) || option.takeover.includes(id)) } : {}),
      reasonText: option.reason ? DEPLOY_REFUSED_TEXT[option.reason] || option.reason.toUpperCase() : '' };
  });
  const parsed = typeof selection?.spawn === 'string' ? parseSpawnChoice(selection.spawn) : null;
  const key = parsed ? (parsed.kind === 'hq' ? 'hq' : `${parsed.kind}:${parsed.id}`) : null;
  const spawn = key && decorated.some(o => o.spawn === key) ? selection.spawn : 'hq';
  const resolved = resolveDeployChoice(options, spawn);
  const respawnAt = Number.isFinite(self.respawnAt) ? self.respawnAt : null;
  const waitMs = respawnAt !== null && Number.isFinite(nowMs) ? Math.max(0, respawnAt - nowMs) : null;
  const unlockState = unlocks?.unlocked instanceof Set ? unlocks : kitUnlockState(unlocks);
  // A locked pick (stored preference, older level) falls back to the default kit.
  const wanted = KIT_IDS.includes(selection?.kit) ? selection.kit : info?.kit && KIT_IDS.includes(info.kit) ? info.kit : 'assault';
  const kit = unlockState.unlocked.has(wanted) ? wanted : 'assault';
  const variant = kit === wanted && selection?.variant === 1 ? 1 : 0;
  const gadget = kit === wanted ? kitGadgetIndex(kit, selection?.gadget) : 0;
  const down = info?.down === true;
  return {
    team, teamName: teamDisplayName(team), options: decorated, spawn, valid: resolved.ok, reason: resolved.reason,
    reasonText: resolved.ok ? '' : DEPLOY_REFUSED_TEXT[resolved.reason] || '',
    seatId: resolved.seatId, kit, variant, gadget, kits: kitCards(kit, variant, gadget, { unlocked: unlockState.unlocked, career }),
    level: unlockState.level, medic: down ? nearestMedic(players, self) : null,
    waitMs, ready: waitMs === 0 && resolved.ok, countdown: waitMs === null ? '' : waitMs > 0 ? `${(waitMs / 1000).toFixed(1)}` : '',
    timeoutMs: respawnAt !== null && Number.isFinite(nowMs) ? Math.max(0, respawnAt + CONQUEST_RULES.deployTimeoutMs - nowMs) : null,
    refused: refused ? { reason: typeof refused === 'object' ? refused.reason : refused,
      text: typeof refused === 'object' ? deployRefusedText(refused.reason, refused.level) : deployRefusedText(refused) } : null,
    down,
    selectedKey: resolved.option?.spawn ?? 'hq',
    // `gadget` only rides kits that offer a choice, so older servers and the other kits see the old shape.
    choice: { spawn, kit, variant, ...((KITS[kit]?.gadgets?.length ?? 0) > 1 ? { gadget } : {}) },
  };
}

/* ---------------------------------------------------------------- interact */

/**
 * Revive / repair / enter prompts. Revive: a kit with the revive ability (the
 * Medic) within KIT_ROLE_RULES.reviveRange of a downed teammate; anyone else
 * there sees NEEDS MEDIC. Repair: an engineer within 3.5 m of a damaged friendly
 * hull. Progress of an action in flight comes from cq[6].
 */
export function interactModel({ self, players = [], vehicles = [], nearbyVehicle = null, seated = null } = {}) {
  if (!self || !alive(self)) return null;
  const info = decodeConquestPlayer(self);
  const team = playerTeam(self);
  const progress = info?.actionProgress ?? 0;
  let needsMedic = null;
  if (!seated) {
    let target = null, best = KIT_ROLE_RULES.reviveRange;
    for (const p of players || []) {
      if (!p || String(p.id) === String(self.id) || p.team !== team || !decodeConquestPlayer(p)?.down) continue;
      const d = Math.hypot(p.x - self.x, p.y - self.y, p.z - self.z);
      if (d <= best) { best = d; target = p; }
    }
    const name = String(target?.name || 'TEAMMATE').toUpperCase();
    if (target && KITS[info?.kit]?.ability === 'revive') return { type: 'revive', targetId: String(target.id), label: `REVIVE ${name}`, progress, hold: true };
    // Only a Medic revives: the others are told who can (after their own repair prompt, see below).
    if (target && !nearbyVehicle) needsMedic = { type: 'needs-medic', targetId: String(target.id), label: `${name} NEEDS A MEDIC`, progress: 0, hold: false };
  }
  if (!seated && info?.kit === 'engineer') {
    let target = null, best = 3.5;
    for (const v of vehicles || []) {
      if (!v || v.team !== team || !(v.hp > 0)) continue;
      const max = vehicleMaxHp(v);
      if (!max || v.hp >= max) continue;
      const d = Math.hypot(v.x - self.x, v.z - self.z);
      if (d <= best) { best = d; target = v; }
    }
    if (target) {
      const max = vehicleMaxHp(target);
      return { type: 'repair', targetId: String(target.id), label: `REPAIR ${VEHICLE_LABELS[target.type] || 'VEHICLE'} ${Math.round(target.hp / max * 100)}%`,
        progress, hold: true, hull: clamp01(target.hp / max) };
    }
  }
  if (needsMedic) return needsMedic;
  if (seated) return { type: 'exit', label: `EXIT ${VEHICLE_LABELS[seated.row.type] || 'VEHICLE'}`, progress: 0, hold: false };
  const near = nearbyVehicle && nearbyVehicle.hp > 0 && (!nearbyVehicle.team || nearbyVehicle.team === team) ? nearbyVehicle : null;
  if (near) {
    const free = topology(near.type).find(seat => seatOccupant(near, seat.id) == null);
    if (free) {
      const index = topology(near.type).indexOf(free);
      return { type: 'enter', targetId: String(near.id), seatId: free.id,
        label: `ENTER ${VEHICLE_LABELS[near.type] || 'VEHICLE'} · F${index + 1} ${SEAT_LABELS[free.id] || free.role.toUpperCase()}`, progress: 0, hold: false };
    }
    // A full hull with a bot aboard: Interact takes the first bot seat (the server puts the bot out).
    const held = topology(near.type).find(seat => isBotId(seatOccupant(near, seat.id)));
    if (held) {
      const index = topology(near.type).indexOf(held);
      const bot = (players || []).find(p => String(p?.id) === seatOccupant(near, held.id));
      return { type: 'enter', targetId: String(near.id), seatId: held.id, takeover: true,
        label: `TAKE ${VEHICLE_LABELS[near.type] || 'VEHICLE'} · F${index + 1} ${SEAT_LABELS[held.id] || held.role.toUpperCase()} · ${String(bot?.name || 'BOT').toUpperCase()}`, progress: 0, hold: false };
    }
  }
  return null;
}

/**
 * Parachute prompt from the predicted chute state (PlayerPhysics.chutePrompt):
 * 'ready' (falling high enough: Jump opens it) or 'open' (Jump cuts it).
 */
export function chutePromptModel(state) {
  if (state === 'ready') return { type: 'chute', binding: 'jump', label: 'OPEN PARACHUTE', progress: 0, hold: false };
  if (state === 'open') return { type: 'chute', binding: 'jump', label: 'CUT PARACHUTE', progress: 0, hold: false };
  return null;
}

/* ---------------------------------------------------------- scoreboard / results */

/* -------------------------------------------------------------------- touch */

/**
 * Conquest fields for the touch context (merged by the integrator into the
 * TouchControls context): map and spot buttons while alive, seat cycle and
 * countermeasure while seated, the DEPLOY button while the deploy screen is up.
 */
export const CONQUEST_TOUCH_DEFAULTS = Object.freeze({
  conquest: false, deployOpen: false, deployValid: true, deployLabel: 'DEPLOY',
  vehicleSeatCount: 0, vehicleCountermeasure: null, vehicleCountermeasureReady: false,
});

/**
 * Always returns every key of CONQUEST_TOUCH_DEFAULTS: the integrator merges
 * this into one persistent context object, so an omitted key would keep a
 * stale value from an earlier seat or deploy screen.
 */
export function conquestTouchFields({ active = false, dead = false, deployOpen = false, deploy = null, seated = null } = {}) {
  const fields = { ...CONQUEST_TOUCH_DEFAULTS };
  if (!active) return fields;
  fields.conquest = true;
  fields.deployOpen = !!(dead && deployOpen);
  if (fields.deployOpen) {
    const valid = deploy?.valid !== false;
    fields.deployValid = valid;
    fields.deployLabel = !valid ? 'UNAVAILABLE' : deploy?.waitMs > 0 ? `DEPLOY ${deploy.countdown}` : 'DEPLOY';
  }
  if (seated?.row) {
    const row = seated.row, drives = seated.seat?.drives === true;
    const cm = COUNTERMEASURES[row.type] ?? null;
    fields.vehicleSeatCount = topology(row.type).length;
    fields.vehicleCountermeasure = drives ? cm : null;
    fields.vehicleCountermeasureReady = drives && cm ? finite(row.cmr) >= 100 : false;
  }
  return fields;
}
