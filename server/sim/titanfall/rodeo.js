/**
 * Rodeo (docs/titanfall.md §5.2 Rodeo). The rider is `p.rodeoVehicleId`; the
 * hull keeps `v.riderId` (one enemy rider at a time). Timers on the pilot:
 * `p.tfRip` / `p.tfInsert` = { vehicleId, until } (engine ms), hatch damage
 * budget `p.tfHatch` = { budget, at }.
 *
 * - mount (rodeo feel pass): an airborne enemy pilot whose body comes within
 *   rodeo.contact of the upper hull (back, sides, top; never the front face
 *   below the top), a pilot grappled onto the hull (rope on it now or within
 *   hookMs) within hookReach of any part of it, or one standing on the roof is
 *   grabbed in stepRodeo (shared rodeoContact). The `mount` verb also takes a
 *   grounded pilot in that contact, or a chest within rodeo.reach of the back
 *   anchor. A second contact is pushed off; a dismounted or pushed-off pilot is
 *   not re-grabbed by that hull for remountMs / pushMs (`p.rodeoCooldown`).
 * - riding: posed every tick 0.3 m outside the rear hull box (so an ally's ray
 *   reaches the rider before the hull); game.js skips `integrate` for riders.
 *   Where that spot is in a voxel or outside the play area (back to a wall,
 *   rear over the area edge) the rider is pulled in to the box face, then
 *   inside it. A rider ignores its own hull (`ghostVehicleId`, no end) so the
 *   hull's infantry contact never runs them over; leaving keeps the ordinary
 *   short exit ghost, and a pulled-in rider leaves from a clear exit spot.
 * - rip: once per battery (not batteryOut, not doomed), held ripMs, then
 *   ripFrac × max hp with cls 'rodeo'; the rider carries the battery.
 * - hatch: primary/sidearm hitscan from the rider, raw × TITAN_ARMOR[cls] ×
 *   hatchMul, capped at hatchDpsCap per rider (combat.js skips the hull hit).
 * - insert: a friendly battery carrier near the back anchor, insertMs, then
 *   +batteryShieldFrac × max shield up to shieldMaxFrac, clears batteryOut,
 *   +1 smoke charge (max smoke.charges). Refused at the shield cap.
 * - dismount: the verb, a jump, the hull's death, or the rider's death/leave.
 */
import { TITAN_RULES, titanFrame, batteryInsertGap, rodeoContact, rodeoContactMounts } from '../../../shared/vehicle-handling/titan.js';
import { isTitanType, titanWeaponRole } from '../../../shared/titan-contract.js';
import { TITAN_ARMOR } from '../../../shared/vehicle-armor.js';
import { vehicleMaxHp, vehicleDef } from '../../../shared/vehicle-defs.js';
import { vehicleLocalPoint } from '../../../shared/vehicles.js';
import { PHYSICS } from '../../../shared/player-movement.js';
import { markLaunched } from '../player.js';
import { inPlayArea } from './play-area.js';

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const CHEST = 1.2;
/** Classes a hatch shot never carries (AT, explosive, launcher rounds hit the hull normally). */
const HATCH_EXCLUDED = new Set(['at', 'explosive', 'he', 'aa', 'fire']);
/** History samples kept for a posed rider (server/sim/movement.js HISTORY_SAMPLES). */
const HISTORY_SAMPLES = 32;
/** Burst allowance of the hatch damage cap, in seconds of hatchDpsCap. */
const HATCH_BURST_SECONDS = 0.25;

/** World point of a titan's back anchor (frame table "Back anchor y", just behind the hull). */
export function backAnchor(v) {
  const f = titanFrame(v);
  return f ? vehicleLocalPoint({ x: v.x, y: v.y, z: v.z, yaw: v.yaw }, 0, f.backY, f.hl + 0.3) : null;
}
/** Rider offsets past the rear box face (hull-local +Z): outside, against the face, inside the hull. */
const RIDER_OFFSETS = Object.freeze([0.3 + PHYSICS.halfW, PHYSICS.halfW, -PHYSICS.halfW]);
/**
 * Feet pose of the rider: chest at the anchor height, 0.3 m outside the rear
 * hull box. With `titans`, the first of RIDER_OFFSETS whose body is clear of
 * voxels and inside the play area (the last, inside the hull's own voxel-free
 * volume, always holds); `outside` is true for the nominal spot only.
 */
export function riderPose(v, titans = null) {
  const f = titanFrame(v);
  if (!f) return null;
  const hull = { x: v.x, y: v.y, z: v.z, yaw: v.yaw }, last = RIDER_OFFSETS.length - 1;
  for (let i = 0; i <= last; i++) {
    const [x, y, z] = vehicleLocalPoint(hull, 0, f.backY - CHEST, f.hl + RIDER_OFFSETS[i]);
    if (!titans || i === last || (titans.vehicles.bodyClear(x, y, z) && inPlayArea(titans.area(), x, y, z))) return { x, y, z, outside: i === 0 };
  }
  return null;
}
/** Chest-to-anchor distance of a pilot, or Infinity. */
export function anchorDistance(p, v) {
  const anchor = backAnchor(v);
  if (!anchor || ![p?.x, p?.y, p?.z].every(Number.isFinite)) return Infinity;
  return Math.hypot(p.x - anchor[0], p.y + CHEST - anchor[1], p.z - anchor[2]);
}
/** Battery insert reach of a pilot (batteryInsertGap: the ground right behind the hull counts), or Infinity. */
export function insertDistance(p, v) {
  const anchor = backAnchor(v);
  if (!anchor || ![p?.x, p?.y, p?.z].every(Number.isFinite)) return Infinity;
  return batteryInsertGap(p.x - anchor[0], p.y + CHEST - anchor[1], p.z - anchor[2]);
}

const live = v => !!v && isTitanType(v.type) && v.hp > 0 && !v.dropping;
const freePilot = p => !!p && p.state === 'alive' && !p.vehicleId && !p.rodeoVehicleId;
const teamOf = (titans, p) => titans.vehicles.teamOf(p);

/** The nearest live titan matching `accept` whose back anchor is within reach of the pilot's chest. */
function titanInReach(titans, p, accept, slack = 0, distance = anchorDistance) {
  let best = null, bestD = TITAN_RULES.rodeo.reach + slack;
  for (const v of titans.titans()) {
    if (!live(v) || !accept(v)) continue;
    const d = distance(p, v);
    if (d <= bestD) { best = v; bestD = d; }
  }
  return best;
}

/** True when the pilot stands on the hull's roof (footprint, feet at the top). */
function onRoof(p, v) {
  const f = titanFrame(v);
  if (!f) return false;
  const dx = p.x - v.x, dz = p.z - v.z, c = Math.cos(v.yaw), s = Math.sin(v.yaw);
  const lx = dx * c - dz * s, lz = dx * s + dz * c, dy = p.y - (v.y + f.height);
  return Math.abs(lx) <= f.hw + PHYSICS.halfW && Math.abs(lz) <= f.hl + PHYSICS.halfW && dy >= -0.35 && dy <= 0.6;
}

/** Shove a pilot off a hull (a second rider): away from its centre with a hop the client adopts. */
function pushOff(p, v, now) {
  const dx = p.x - v.x, dz = p.z - v.z, len = Math.hypot(dx, dz);
  const nx = len > 1e-6 ? dx / len : Math.sin(v.yaw), nz = len > 1e-6 ? dz / len : Math.cos(v.yaw);
  Object.assign(p, { vx: nx * 5, vy: 3.5, vz: nz * 5 });
  markLaunched(p);
  if (Number.isFinite(now)) p.rodeoCooldown = { vehicleId: v.id, until: now + TITAN_RULES.rodeo.pushMs };
}

/** True while `p` hangs on a grapple hooked to `v`, or let go of one less than hookMs ago. */
function hookedOn(p, v, now) {
  if (p.pilot?.grapple?.vehicleId === v.id) return true;
  const hook = p.rodeoHook;
  return !!hook && hook.vehicleId === v.id && now - hook.at <= TITAN_RULES.rodeo.hookMs;
}

/**
 * Contact mount test of a free enemy pilot against one hull: airborne in contact
 * with the upper hull (or hooked on it), standing on the roof, or with `grounded`
 * (the verb) also standing in that contact.
 */
export function rodeoTouches(p, v, now, { grounded = false } = {}) {
  if (onRoof(p, v)) return true;
  const hooked = hookedOn(p, v, now);
  if (p.grounded !== false && !grounded && !hooked) return false;
  return rodeoContactMounts(rodeoContact(p, v), hooked);
}

/** Pose a rider at the back anchor; their look follows their input. */
function pose(titans, p, v, now) {
  const at = riderPose(v, titans);
  if (!at) return;
  Object.assign(p, { x: at.x, y: at.y, z: at.z, vx: 0, vy: 0, vz: 0, grounded: true, coyote: 0, vault: null, slide: null, jumpGroundY: null });
  // The rider never counts as infantry in contact with its own hull (no run-over by a flick).
  p.ghostVehicleId = v.id; p.ghostUntil = Infinity;
  const input = p.input;
  if (input && Number.isFinite(input.yaw)) { p.yaw = input.yaw; p.pitch = finite(input.pitch); }
  // integrate is skipped for riders: keep the lag-compensation trail current.
  if (Array.isArray(p.hist)) {
    p.hist.push({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, crouch: p.crouch, proneT: p.proneT, leanT: p.leanT || 0,
      ads: p.ads, reloading: p.reloading, weapon: p.weapon, vx: 0, vz: 0, bodyScale: p.bodyScale, combatBox: p.combatBox, t: now });
    if (p.hist.length > HISTORY_SAMPLES) p.hist.shift();
  }
}

/** Mount `v` (an enemy titan) as its one rider. */
export function mountTitan(titans, p, v) {
  if (!freePilot(p) || !live(v) || teamOf(titans, p) === v.team) return false;
  if (v.riderId && v.riderId !== String(p.id)) {
    const current = titans.engine.entities.get(v.riderId);
    if (current && current.state === 'alive' && current.rodeoVehicleId === v.id) { pushOff(p, v, titans.now); return false; }
    v.riderId = null;
  }
  const now = titans.now;
  p.rodeoVehicleId = v.id; p.rodeoSince = now;
  p.rodeoJumpSeq = p.input?.jumpSeq; p.rodeoJumpHeld = !!p.input?.keys?.jump;
  p.tfRip = null; p.tfInsert = null; p.rodeoHook = null;
  v.riderId = String(p.id); v.riderSince = now;
  pose(titans, p, v, now);
  titans.emit('rodeo_mount', { id: String(p.id), vehicleId: v.id });
  return true;
}

/** `{rodeo: 'mount'|'rip'|'insert'|'dismount'}` intent. */
export function rodeoAction(titans, p, verb) {
  if (!p || p.state !== 'alive') return false;
  const now = titans.now, rules = TITAN_RULES.rodeo;
  switch (verb) {
    case 'mount': {
      if (!freePilot(p)) return false;
      const v = titanInReach(titans, p, item => teamOf(titans, p) !== item.team)
        ?? [...titans.titans()].find(item => live(item) && teamOf(titans, p) !== item.team && rodeoTouches(p, item, now, { grounded: true })) ?? null;
      return !!v && mountTitan(titans, p, v);
    }
    case 'rip': {
      const v = titans.vehicles.vehicles.get(p.rodeoVehicleId);
      if (!live(v) || v.riderId !== String(p.id) || v.batteryOut || v.doomed || p.tfBattery || p.tfRip) return false;
      p.tfRip = { vehicleId: v.id, until: now + rules.ripMs };
      return true;
    }
    case 'insert': {
      if (!p.tfBattery || p.vehicleId || p.rodeoVehicleId || p.tfInsert) return false;
      const v = titanInReach(titans, p, item => item.team === teamOf(titans, p) && !item.doomed, 0, insertDistance);
      if (!v || shieldFull(v)) return false;
      p.tfInsert = { vehicleId: v.id, until: now + rules.insertMs };
      return true;
    }
    case 'dismount': return dismount(titans, p);
    default: return false;
  }
}

const shieldCap = v => TITAN_RULES.shieldMaxFrac * vehicleMaxHp(v);
const shieldFull = v => finite(v.shield) >= shieldCap(v) - 1e-6;

/** Leave the hull with a hop backwards (verb or jump); a pulled-in rider steps off at a clear exit spot instead. */
function dismount(titans, p) {
  const v = titans.vehicles.vehicles.get(p?.rodeoVehicleId);
  const outside = !!v && riderPose(v, titans)?.outside === true;
  if (!releaseRider(titans, p)) return false;
  if (v && p.state === 'alive' && outside) {
    // The hop keeps the hull's own motion, so a reversing titan does not walk its legs into the rider's landing.
    const yaw = finite(v.yaw);
    Object.assign(p, { vx: Math.sin(yaw) * 3.5 + finite(v.vx), vy: 5.5, vz: Math.cos(yaw) * 3.5 + finite(v.vz) });
    markLaunched(p);
  }
  return true;
}

/** Per-tick rider posing, rip/insert timers, roof auto-mount. */
export function stepRodeo(titans, dt) {
  const now = titans.now, rules = TITAN_RULES.rodeo, vehicles = titans.vehicles;
  void dt;
  let liveTitans = null;
  for (const p of vehicles.engine.entities.values()) {
    if (p.tfInsert) stepInsert(titans, p, now);
    // A rider cleared elsewhere (respawn loadout, reset) drops the endless rider ghost.
    if (!p.rodeoVehicleId && p.ghostUntil === Infinity) { p.ghostVehicleId = null; p.ghostUntil = 0; }
    if (p.rodeoVehicleId) {
      const v = vehicles.vehicles.get(p.rodeoVehicleId);
      if (!live(v) || p.state !== 'alive' || p.vehicleId || v.riderId !== String(p.id) || teamOf(titans, p) === v.team) {
        releaseRider(titans, p);
        continue;
      }
      const input = p.input, seq = input?.jumpSeq, held = !!input?.keys?.jump;
      const jumped = (Number.isFinite(seq) && Number.isFinite(p.rodeoJumpSeq) && seq !== p.rodeoJumpSeq) || (held && !p.rodeoJumpHeld);
      p.rodeoJumpSeq = seq; p.rodeoJumpHeld = held;
      if (jumped) { dismount(titans, p); continue; }
      pose(titans, p, v, now);
      if (p.tfRip && now >= p.tfRip.until) {
        const rip = p.tfRip;
        p.tfRip = null;
        if (rip.vehicleId === v.id && !v.batteryOut && !v.doomed && !p.tfBattery) {
          v.batteryOut = true;
          p.tfBattery = true;
          titans.emit('rodeo_rip', { id: String(p.id), vehicleId: v.id });
          titans.applyDamage(v, rules.ripFrac * vehicleMaxHp(v), 'rodeo', p, {});
        }
      }
      continue;
    }
    if (p.tfRip) p.tfRip = null;
    if (p.state !== 'alive' || p.vehicleId) continue;
    // A grapple hooked on a hull is remembered for hookMs after the rope lets go (it releases near the plates).
    const hookId = p.pilot?.grapple?.vehicleId;
    if (hookId) p.rodeoHook = { vehicleId: hookId, at: now };
    // Contact auto-mount (enemy pilots only): airborne on the upper hull, hooked, or on the roof; a second rider is pushed off.
    liveTitans ??= [...titans.titans()].filter(live);
    for (const v of liveTitans) {
      if (teamOf(titans, p) === v.team || Math.abs(p.x - v.x) > 7 || Math.abs(p.z - v.z) > 7) continue;
      if (p.rodeoCooldown?.vehicleId === v.id && now < p.rodeoCooldown.until) continue;
      if (!rodeoTouches(p, v, now)) continue;
      mountTitan(titans, p, v);
      break;
    }
  }
}

function stepInsert(titans, p, now) {
  const job = p.tfInsert;
  if (now < job.until) return;
  p.tfInsert = null;
  const v = titans.vehicles.vehicles.get(job.vehicleId);
  if (!live(v) || v.doomed || p.state !== 'alive' || !p.tfBattery || p.vehicleId || p.rodeoVehicleId
    || v.team !== teamOf(titans, p) || insertDistance(p, v) > TITAN_RULES.rodeo.reach + 1 || shieldFull(v)) return;
  const max = vehicleMaxHp(v);
  v.shield = Math.min(shieldCap(v), finite(v.shield) + TITAN_RULES.batteryShieldFrac * max);
  v.batteryOut = false;
  if (v.tfAbility) v.tfAbility.smoke = Math.min(TITAN_RULES.smoke.charges, finite(v.tfAbility.smoke) + TITAN_RULES.smoke.batteryRecharge);
  p.tfBattery = false;
  titans.emit('rodeo_insert', { id: String(p.id), vehicleId: v.id });
}

/**
 * Hatch shots from a rider: true when the hit was consumed (combat.js skips the
 * hull hit). hit = { point, raw, cls }.
 */
export function rodeoRiderHit(titans, attacker, v, hit, weaponId) {
  if (!attacker || !live(v) || attacker.rodeoVehicleId !== v.id || v.riderId !== String(attacker.id)) return false;
  const role = titanWeaponRole(weaponId), cls = hit?.cls;
  if ((role !== 'primary' && role !== 'sidearm') || typeof cls !== 'string' || HATCH_EXCLUDED.has(cls)) return false;
  const rules = TITAN_RULES.rodeo, now = titans.now;
  const raw = finite(hit?.raw) * (TITAN_ARMOR[cls] ?? 0) * rules.hatchMul;
  const burst = rules.hatchDpsCap * HATCH_BURST_SECONDS;
  const state = attacker.tfHatch ??= { budget: burst, at: now };
  state.budget = Math.min(burst, state.budget + Math.max(0, now - state.at) / 1000 * rules.hatchDpsCap);
  state.at = now;
  const amount = Math.min(raw, state.budget);
  if (amount > 0) {
    state.budget -= amount;
    titans.applyDamage(v, amount, 'rodeo', attacker, {});
  }
  return true;
}

/**
 * Detach a rider (death, leave, dismount, hull death). The endless rider ghost
 * becomes the ordinary short exit ghost; a living rider that was pulled in
 * (wall or area edge behind the hull) is moved to a clear exit spot.
 */
export function releaseRider(titans, p) {
  if (!p?.rodeoVehicleId) return false;
  const v = titans.vehicles.vehicles.get(p.rodeoVehicleId);
  if (v && v.riderId === String(p.id)) { v.riderId = null; v.riderSince = 0; }
  const pulled = !!v && p.state === 'alive' && riderPose(v, titans)?.outside === false;
  p.rodeoVehicleId = null;
  p.tfRip = null;
  // The hop off the back stays in contact range a moment: the same hull does not grab it straight back.
  if (v && Number.isFinite(titans.now)) p.rodeoCooldown = { vehicleId: v.id, until: titans.now + TITAN_RULES.rodeo.remountMs };
  if (v) titans.vehicles.ghost(p, v);
  else if (p.ghostUntil === Infinity) { p.ghostVehicleId = null; p.ghostUntil = 0; }
  const seat = pulled ? vehicleDef(v)?.seats?.[0] : null;
  if (seat) {
    const spot = titans.vehicles.exitSpot(p, v, seat, false);
    Object.assign(p, { x: spot.x, y: spot.y, z: spot.z, vx: 0, vy: 0, vz: 0, grounded: true, coyote: 0, jumpGroundY: null, vault: null, slide: null });
  }
  titans.emit('rodeo_off', { id: String(p.id), vehicleId: v?.id ?? null });
  return true;
}
