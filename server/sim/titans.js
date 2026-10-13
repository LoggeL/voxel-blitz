/**
 * Titanfall titans (docs/titanfall.md §5.2). Titans are ordinary VehicleSystem
 * hulls with handling 'walker'; VehicleSystem owns `this.titans` (titanfall
 * profile only) and calls the one-line hooks below. The method list is frozen
 * by WP0 (§12.5); WP2 owns the bodies: call and drop (refusals, crush,
 * friendly push, refund), walking (shared stepTitanWalk), leg-box crush, lava,
 * embark/disembark, doom, eject, destroy and wreck removal, the auto-titan
 * guard, rodeo (rodeo.js), batteries (batteries.js) and the meter credits
 * (meter.js; pilot damage through a chained `beforeDamage` hook). Abilities
 * are WP3's (titan-abilities.js).
 *
 * Times are engine milliseconds (`engine.now`). Titan state on the hull:
 * owner, dropping, landsAt, landedUntil, legYaw, dash (pips), dashT, shield,
 * doomed, doomedBy, doomPool, embarkUntil, disembarkUntil, riderId,
 * batteryOut, dashRequest, tfMove (§5.5), tfAbility.
 */
import { TITAN_RULES, placeWalker, stepTitanWalk, titanFrame, createTitanMove } from '../../shared/vehicle-handling/titan.js';
import { TITAN_PHASE, TITAN_ABILITY_BITS, encodeTitanRow, isTitanType } from '../../shared/titan-contract.js';
import { VEHICLE_DAMAGE_RULES, vehicleDef, vehicleMaxHp, clampMountAim, mountPose } from '../../shared/vehicle-defs.js';
import { VEHICLE_RULES, vehicleLocalPoint } from '../../shared/vehicles.js';
import { hullFootprint, footprintsOverlap, solidHull } from '../../shared/vehicle-collision.js';
import { playerHullContact } from '../../shared/player-vehicle-collision.js';
import { PHYSICS } from '../../shared/player-movement.js';
import { isSolidBlock } from '../../shared/worlddata.js';
import { FLUID_BLOCKS, MC_LAVA } from '../../shared/world/blocks.js';
import { raycastVoxels } from '../../shared/raycast.js';
import { evHit } from '../protocol/events.js';
import { fwdFromYawPitch, markLaunched, aimAngles } from './player.js';
import { applyTitanDamage } from './titanfall/titan-damage.js';
import { rodeoAction, stepRodeo, rodeoRiderHit, releaseRider } from './titanfall/rodeo.js';
import { TitanBatteries } from './titanfall/batteries.js';
import { meterCredit } from './titanfall/meter.js';
import { isPerceivable } from './titanfall/perception.js';
import { useTitanAbility, stepTitanAbilities, resetTitanAbilities, abilityReadiness } from './titanfall/titan-abilities.js';
import { inPlayArea, PLAY_AREA_RULES } from './titanfall/play-area.js';

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
const idOf = player => player?.id == null ? null : String(player.id);
/** Wreck lifetime before an ephemeral titan hull is removed. */
export const TITAN_WRECK_SECONDS = 12;
const WAY_OUT_STEPS = Object.freeze([2, 4, 6, 8, 10]);   // m a landed hull must walk out on a heading
const WAY_OUT_HEADINGS = 16;
/** FNV-1a of a string: the auto-titan's deterministic aim-noise seed. */
const hashSeed = text => { let h = 2166136261; for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return h || 1; };
/** Hull-local leg box indices in TITAN_DEFS_INPUT.hullBoxes (left, right). */
const LEG_BOXES = Object.freeze([0, 1]);

/**
 * Kill credit for a titan whose owner is dead: the owner's id and team, with
 * kills and score forwarded to the owner's entity (game.killPlayer bumps them
 * on the attacker it is given). `bot: true` skips the lag rewind of a human shooter.
 */
function createStandIn(titans, ownerId, team) {
  const entity = () => titans.engine.entities.get(ownerId) ?? null;
  return {
    id: ownerId, team, state: 'alive', bot: true, input: {}, firing: false, standIn: true,
    get kills() { return entity()?.kills ?? 0; },
    set kills(n) { const e = entity(); if (e) e.kills = n; },
    get score() { return entity()?.score ?? 0; },
    set score(n) { const e = entity(); if (e) e.score = n; },
  };
}

export class TitanSystem {
  constructor(vehicles) {
    this.vehicles = vehicles;
    this.engine = vehicles.engine;
    this.bats = new TitanBatteries(this);
    this.standIns = new Map();
    this.n = 0;
    // Reused per walker substep (stepTitanWalk is allocation-free).
    this.controls = { fwd: 0, side: 0, aimYaw: 0, aimPitch: 0, sprint: false, dash: false, piloted: false };
    this.previous = { x: 0, y: 0, z: 0, yaw: 0 };
    const engine = this.engine;
    this.world = {
      solidAt: (x, y, z) => vehicles.solid(x, y, z),
      fluidAt: (x, y, z) => FLUID_BLOCKS.has(engine.world.getBlock(x, y, z)),
      bounds: null, ceiling: Infinity,
      get revision() { return engine.blockRevision ?? 0; },
    };
    this.reset();
  }

  get policy() { return this.engine.mode?.policy ?? null; }
  get now() { return finite(this.engine.now); }
  /** The play area rectangle (policy-owned), or the whole map. */
  area() {
    const area = this.policy?.playArea;
    if (area) return area;
    const d = this.engine.world?.dimensions;
    return d ? { bounds: { minX: 0, maxX: d.sx, minZ: 0, maxZ: d.sz }, sy: d.sy } : null;
  }
  emit(kind, fields = {}) {
    if (!Array.isArray(this.engine.tickEvents)) this.engine.tickEvents = [];
    this.engine.tickEvents.push({ t: 'ev', kind, at: this.now, ...fields });
  }
  /** Every titan hull (live, dropping or wreck). */
  *titans() { for (const v of this.vehicles.vehicles.values()) if (isTitanType(v.type)) yield v; }

  reset() {
    for (const v of [...this.titans()]) this.vehicles.vehicles.delete(v.id);
    for (const p of this.engine.entities.values()) {
      p.rodeoVehicleId = null; p.embarkUntil = 0; p.tfBattery = false; p.ejectCloakUntil = 0;
      if (p.ghostUntil === Infinity) { p.ghostVehicleId = null; p.ghostUntil = 0; }
      p.tfRip = null; p.tfInsert = null; p.tfHatch = null;
    }
    this.bats.reset();
    this.standIns.clear();
    this.n = 0;
    const area = this.area();
    this.world.bounds = area?.bounds ?? null;
    this.world.ceiling = Number.isFinite(area?.sy) ? area.sy : Infinity;
  }

  // ---- call and drop ---------------------------------------------------------------

  /** Titanfall call from the pilot eye along the input aim. Returns {ok, reason}. */
  call(player, aimPoint = null) {
    const p = player, policy = this.policy, rules = TITAN_RULES.drop;
    const refuse = reason => { this.emit('titanfall_refused', { owner: idOf(p), reason }); return { ok: false, reason }; };
    if (!p || p.state !== 'alive' || !policy) return { ok: false, reason: 'meter' };
    if (this.ownedBy(p.id)) return refuse('owned');
    if (!(policy.titanMeter(p) >= 1)) return refuse('meter');
    const team = this.vehicles.teamOf(p);
    if (this.teamTitans(team) >= this.bayCap(team) - (p.bot ? this.humanReserve(team) : 0)) return refuse('bay');
    const yaw = finite(p.input?.yaw, finite(p.yaw)), pitch = finite(p.input?.pitch, finite(p.pitch));
    const dir = fwdFromYawPitch(yaw, pitch), world = this.engine.world;
    const ox = finite(p.eyeX, p.x), oy = finite(p.eyeY, p.y + 1.62), oz = finite(p.eyeZ, p.z);
    const block = (x, y, z) => world.getBlock(x, y, z);
    const hit = raycastVoxels((x, y, z) => { const b = block(x, y, z); return isSolidBlock(b) || FLUID_BLOCKS.has(b); },
      ox, oy, oz, dir.x, dir.y, dir.z, rules.range);
    if (!hit || hit.y < 0) return refuse('range');
    if (FLUID_BLOCKS.has(block(hit.x, hit.y, hit.z))) return refuse('fluid');
    const x = ox + dir.x * hit.t, z = oz + dir.z * hit.t;
    void aimPoint; // the client hint is advisory; the server ray decides
    const type = policy.titanTypeFor?.(p) ?? 'titan_ion';
    const f = titanFrame(type);
    const area = this.area();
    if (!inPlayArea(area, x, hit.y + 1, z)) return refuse('range');
    for (const spawn of policy.teamSpawnPool?.(team === 'alpha' ? 'bravo' : 'alpha') ?? []) {
      if (Math.hypot(spawn.x - x, spawn.z - z) < rules.spawnClear) return refuse('spawn');
    }
    // Footprint columns: fluid tops, unevenness and sky clearance.
    const c = Math.cos(yaw), s = Math.sin(yaw), heights = [];
    for (const [lx, lz] of [[0, 0], [-f.hw, -f.hl], [f.hw, -f.hl], [-f.hw, f.hl], [f.hw, f.hl]]) {
      const cx = x + lx * c + lz * s, cz = z - lx * s + lz * c, bx = Math.floor(cx), bz = Math.floor(cz);
      let top = null;
      for (let y = Math.min(hit.y + 3, (area?.sy ?? 80) - 1); y >= Math.max(0, hit.y - 6); y--) {
        const b = block(bx, y, bz);
        if (FLUID_BLOCKS.has(b)) return refuse('fluid');
        if (isSolidBlock(b)) { top = y + 1; break; }
      }
      if (top == null) return refuse('uneven');
      for (let y = top; y < top + rules.skyClearVoxels; y++) if (isSolidBlock(block(bx, y, bz))) return refuse('sky');
      heights.push(top);
    }
    if (Math.max(...heights) - Math.min(...heights) > TITAN_RULES.maxStep) return refuse('uneven');
    const probe = { type, x, y: Math.max(...heights), z, yaw };
    const support = placeWalker(probe, x, z, this.world);
    if (support === null || !Number.isFinite(support)) return refuse('blocked');
    probe.y = support;
    if (this.hullBlocked(probe, null)) return refuse('blocked');
    // Open sky over the footprint is not enough (harbor's gantry roof grid): the hull must walk out.
    if (!this.wayOut(type, x, support, z)) return refuse('enclosed');
    const v = this.spawnDrop(p, x, support, z, type, yaw);
    if (!v) return refuse('blocked');
    policy.setTitanMeter(p, 0);
    return { ok: true, vehicleId: v.id };
  }

  /**
   * True when a `type` hull standing at (x, y, z) walks 10 m out (WAY_OUT_STEPS) on one of
   * WAY_OUT_HEADINGS headings. Shared by human calls and the bots' drop-point search.
   */
  wayOut(type, x, y, z) {
    const world = this.world, probe = { type, x, y, z, yaw: 0 };
    if (!world || !Number.isFinite(placeWalker(probe, x, z, world))) return false;
    for (let k = 0; k < WAY_OUT_HEADINGS; k++) {
      const a = k * Math.PI * 2 / WAY_OUT_HEADINGS, dx = -Math.sin(a), dz = -Math.cos(a);
      probe.yaw = a; probe.y = y;
      let fits = true;
      for (const d of WAY_OUT_STEPS) {
        const support = placeWalker(probe, x + dx * d, z + dz * d, world);
        if (!Number.isFinite(support)) { fits = false; break; }
        probe.y = support;
      }
      if (fits) return true;
    }
    return false;
  }

  /** Create a falling titan for `owner`; it lands at `landsAt` (marker + fall). */
  spawnDrop(owner, x, y, z, type = 'titan_ion', yaw = finite(owner?.yaw)) {
    if (!isTitanType(type) || ![x, y, z].every(Number.isFinite)) return null;
    const def = vehicleDef(type), now = this.now, rules = TITAN_RULES.drop;
    const id = `T${++this.n}`;
    const v = { id, type, team: this.vehicles.teamOf(owner) ?? owner?.team ?? null, x, y, z, yaw, pitch: 0, roll: 0,
      turretYaw: yaw, turretPitch: 0, speed: 0, yawRate: 0, visualSteer: 0, leftTrackSpeed: 0, rightTrackSpeed: 0, vx: 0, vy: 0, vz: 0,
      hp: def.hp, occupantId: null, seatOccupants: this.vehicles.emptySeats(type), respawnIn: 0, engineOn: false, wreckAge: 0,
      spawn: { x, y, z, yaw, flag: null },
      owner: idOf(owner), dropping: true, landsAt: now + rules.markerMs + rules.fallMs, landedUntil: 0, grounded: true,
      legYaw: yaw, dash: titanFrame(type).pips, dashT: 0, dashX: 0, dashZ: 0, dashRequest: false,
      shield: 0, doomed: false, doomedBy: null, doomPool: 0, embarkUntil: 0, disembarkUntil: 0, riderId: null, batteryOut: false };
    this.vehicles.freshCondition(v);
    v.tfMove = createTitanMove();
    this.vehicles.mounts.reset(v);
    resetTitanAbilities(this, v);
    this.vehicles.vehicles.set(id, v);
    this.emit('titanfall_drop', { owner: v.owner, vehicleId: id, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100,
      z: Math.round(z * 100) / 100, landsAt: v.landsAt });
    return v;
  }

  /** Impact: re-place, crush enemies in the footprint, push friendlies, take the drop shield. */
  land(v) {
    v.dropping = false;
    // Light voxels built into the landing volume during the marker break on impact.
    this.ramLight(v, v.x, v.z, TITAN_RULES.dropRamSpeed, TITAN_RULES.dropRam);
    const support = placeWalker(v, v.x, v.z, this.world);
    if (support === null) { this.refund(v); return; }
    // Ground lost under the marker (dug out, blown up): the hull falls the rest of the way under gravity.
    if (Number.isFinite(support) && support >= v.y - 0.05) { v.y = support; v.grounded = true; v.vy = 0; } else { v.grounded = false; v.vy = 0; }
    const f = titanFrame(v), owner = this.attackerFor(v), c = Math.cos(v.yaw), s = Math.sin(v.yaw);
    for (const body of this.engine.entities.values()) {
      if (body.state !== 'alive' || body.vehicleId || body.rodeoVehicleId) continue;
      const dx = body.x - v.x, dz = body.z - v.z, lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) > f.hw + 0.5 || Math.abs(lz) > f.hl + 0.5 || body.y > v.y + f.height || body.y + PHYSICS.height < v.y - 1) continue;
      if (owner && this.vehicles.teamOf(body) !== v.team) this.crushPilot(body, owner, TITAN_RULES.drop.crushKey);
      else this.pushClear(v, body);
    }
    for (const other of this.vehicles.vehicles.values()) {
      if (other === v || !(other.hp > 0) || other.dropping || !solidHull(other)) continue;
      if (this.overlaps(v, other)) this.applyDamage(other, TITAN_RULES.drop.crushDamage, 'titanfall', owner, { point: [other.x, other.y + 1, other.z] });
    }
    v.shield = TITAN_RULES.dropShieldFrac * vehicleMaxHp(v);
    v.landedUntil = this.now + 1000;
  }

  /** Kill one pilot outright (drop or leg crush) with `key`, credited to `attacker`. */
  crushPilot(body, attacker, key) {
    if (body.state !== 'alive') return false;
    if (this.engine.mode?.canDamage?.(attacker, body) === false) return false;
    const damage = Math.max(1, finite(body.hp, 100) + Math.max(0, finite(body.armor)));
    if (typeof body.takeDamage === 'function') body.takeDamage(damage, false, attacker, key);
    this.engine.tickEvents?.push(evHit(attacker?.id ?? '', body.id, damage, false, [body.x, body.y + 0.8, body.z], body.lastDamage));
    this.engine.killPlayer?.(body, attacker, key, false);
    return body.state !== 'alive';
  }

  /** Move a friendly body out of a landing footprint: radially first, then around the hull. */
  pushClear(v, body) {
    const f = titanFrame(v), reach = Math.hypot(f.hw, f.hl) + PHYSICS.halfW + 0.3;
    const dx = body.x - v.x, dz = body.z - v.z, base = Math.hypot(dx, dz) > 1e-6 ? Math.atan2(dz, dx) : 0;
    for (let k = 0; k < 8; k++) {
      const angle = base + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * Math.PI / 4;
      const x = v.x + Math.cos(angle) * reach, z = v.z + Math.sin(angle) * reach;
      const y = this.vehicles.ground(x, z, body.y + 0.5, 2, 4);
      if (y == null || !this.vehicles.bodyClear(x, y, z)) continue;
      Object.assign(body, { x, y, z, vx: 0, vz: 0, vault: null, slide: null });
      return true;
    }
    Object.assign(body, { x: v.x + Math.cos(base) * reach, z: v.z + Math.sin(base) * reach, vx: 0, vz: 0 });
    return false;
  }

  /**
   * Whom a titan's own damage (auto-titan fire, crush) is credited to: the
   * owner while alive, else a stand-in with the owner's id and team (§5.2).
   */
  attackerFor(v) {
    const owner = v?.owner == null ? null : this.engine.entities.get(v.owner) ?? null;
    if (!owner) return null;
    return owner.state === 'alive' ? owner : this.standInFor(v, owner);
  }
  /**
   * The auto-titan's shooter: always the stand-in (`bot: true`), so its rays
   * test victims where it aimed (their current pose), never rewound by an
   * absent owner's view age. Credit still lands on the owner's entity.
   */
  autoShooter(v) {
    const owner = v?.owner == null ? null : this.engine.entities.get(v.owner) ?? null;
    return owner ? this.standInFor(v, owner) : null;
  }
  standInFor(v, owner) {
    let standIn = this.standIns.get(v.owner);
    if (!standIn) { standIn = createStandIn(this, v.owner, v.team); this.standIns.set(v.owner, standIn); }
    standIn.team = this.vehicles.teamOf(owner) ?? v.team;
    return standIn;
  }

  /** A drop that cannot stand is removed and the owner's meter refunded. */
  refund(v) {
    this.vehicles.vehicles.delete(v.id);
    const owner = this.engine.entities.get(v.owner);
    if (owner) this.policy?.setTitanMeter(owner, 1);
  }

  // ---- ownership and crew ----------------------------------------------------------

  /** The pilot's live (or dropping) titan, or null. One titan per pilot. */
  ownedBy(playerId) {
    const id = String(playerId ?? '');
    for (const v of this.titans()) if (v.owner === id && (v.hp > 0 || v.dropping)) return v;
    return null;
  }
  /** True while the pilot has any titan hull, its wreck included: the meter waits for the wreck to clear (§1 step 8). */
  holdsTitan(playerId) {
    const id = String(playerId ?? '');
    for (const v of this.titans()) if (v.owner === id) return true;
    return false;
  }
  teamTitans(team) { let n = 0; for (const v of this.titans()) if (v.team === team && (v.hp > 0 || v.dropping)) n++; return n; }
  bayCap(team) {
    let n = 0;
    for (const p of this.engine.entities.values()) if (this.vehicles.teamOf(p) === team) n++;
    return Math.max(1, Math.ceil(n / 2));
  }
  /**
   * Bay slots held back from bots (playtest: bots filled the bay and starved the human call):
   * one per human teammate without a live or dropping titan. Humans always see the full cap.
   */
  humanReserve(team) {
    let n = 0;
    for (const p of this.engine.entities.values()) {
      if (!p.bot && !p.npcRole && !p.tfNpc && this.vehicles.teamOf(p) === team && !this.ownedBy(p.id)) n++;
    }
    return n;
  }

  /** enter() gate: owner only, not doomed or dropping. Starts the embark lock. */
  canEnter(v, p) {
    if (!isTitanType(v?.type)) return true;
    if (!p || v.owner !== String(p.id) || v.doomed || v.dropping || !(v.hp > 0)) return false;
    if (Math.hypot(p.x - v.x, p.z - v.z) > TITAN_RULES.embark.distance + Math.hypot(titanFrame(v).hw, titanFrame(v).hl)) return false;
    const until = this.now + TITAN_RULES.embark.animMs;
    p.embarkUntil = until; v.embarkUntil = until;
    this.emit('titan_embark', { id: String(p.id), vehicleId: v.id });
    return true;
  }

  /** Disembark: in front of the hatch, else the roof, else behind; never fails. */
  onExit(v, p) {
    const seat = this.vehicles.seatFor(p, v);
    if (!seat) return false;
    const f = titanFrame(v), flat = { ...v, pitch: 0, roll: 0 };
    const free = (x, y, z) => {
      const probe = { ...p, vehicleId: null, ghostVehicleId: null, state: 'alive', x, y, z, proneT: 0 };
      return this.vehicles.bodyClear(x, y, z) && ![...this.vehicles.vehicles.values()].some(other => playerHullContact(probe, other, PHYSICS.height));
    };
    let spot = null;
    for (const lz of [-(f.hl + PHYSICS.halfW + 0.6), null, f.hl + PHYSICS.halfW + 0.6]) {
      if (lz === null) {
        const top = v.y + f.height + 0.02;
        if (this.vehicles.bodyClear(v.x, top, v.z)) { spot = { x: v.x, y: top, z: v.z, ghost: true }; break; }
        continue;
      }
      const point = vehicleLocalPoint(flat, 0, 0, lz), y = this.vehicles.ground(point[0], point[2], v.y + 0.5, 1.5, 3);
      if (y != null && free(point[0], y, point[2])) { spot = { x: point[0], y, z: point[2] }; break; }
    }
    spot ??= { ...this.vehicles.exitSpot(p, v, seat, false) };
    this.vehicles.release(p);
    Object.assign(p, { x: spot.x, y: spot.y, z: spot.z, vx: 0, vy: 0, vz: 0, grounded: !spot.ghost, coyote: 0, jumpGroundY: null, vault: null, slide: null });
    if (spot.ghost) this.vehicles.ghost(p, v);
    p.embarkUntil = 0; v.embarkUntil = 0;
    v.disembarkUntil = this.now + TITAN_RULES.disembarkMs;
    this.emit('titan_disembark', { id: String(p.id), vehicleId: v.id });
    return true;
  }

  /**
   * Eject: only from a doomed titan. Ballistic launch with a short cloak, then
   * the hull dies. The launch starts over the head, or (a voxel there) at the
   * ordinary exit spot, and its apex stays under the first voxel above.
   */
  eject(v, p) {
    const seat = isTitanType(v?.type) && v.doomed ? this.vehicles.seatFor(p, v) : null;
    if (!seat) return false;
    const f = titanFrame(v), sy = finite(this.area()?.sy, 80);
    let start = { x: v.x, y: v.y + f.height + 0.1, z: v.z };
    if (!this.vehicles.bodyClear(start.x, start.y, start.z)) start = this.vehicles.exitSpot(p, v, seat, false);
    this.vehicles.release(p);
    Object.assign(p, { x: start.x, y: start.y, z: start.z, vx: finite(v.vx), vz: finite(v.vz), coyote: 0, jumpGroundY: null, vault: null, slide: null });
    // Apex (feet) half a metre under the play-area ceiling (sy + ceilingPad), so a normal eject never trips OOB,
    // and under the first voxel over the pilot's head.
    const apex = Math.min(sy + PLAY_AREA_RULES.ceilingPad - 0.5, this.headroom(p.x, p.y, p.z, sy));
    p.vy = Math.min(TITAN_RULES.ejectVyMax, Math.sqrt(2 * TITAN_RULES.gravity * Math.max(0, apex - p.y)));
    markLaunched(p);
    this.vehicles.ghost(p, v);
    p.embarkUntil = 0;
    p.ejectCloakUntil = this.now + TITAN_RULES.ejectCloak * 1000;
    this.emit('titan_eject', { id: String(p.id), vehicleId: v.id });
    this.destroyDoomed(v);
    return true;
  }

  /**
   * Highest feet height a pilot body rising straight up from (x, y, z) reaches
   * before its head meets a solid voxel (Infinity when none below the map top `sy`).
   */
  headroom(x, y, z, sy) {
    const world = this.engine.world, half = PHYSICS.halfW, height = PHYSICS.height;
    for (let by = Math.floor(y + height - 0.05) + 1; by < sy; by++) {
      for (let bx = Math.floor(x - half); bx <= Math.floor(x + half); bx++) {
        for (let bz = Math.floor(z - half); bz <= Math.floor(z + half); bz++) {
          if (isSolidBlock(world.getBlock(bx, by, bz))) return Math.max(y, by - height);
        }
      }
    }
    return Infinity;
  }

  // ---- simulation ------------------------------------------------------------------

  /** One walker substep (from VehicleSystem.advance). */
  advance(v, p, input, dt) {
    if (v.dropping) return;
    const now = this.now, k = input?.keys || {};
    const piloted = !!p && this.vehicles.canOperate(p) && !(p.embarkUntil > now);
    v.engineOn = piloted;
    const c = this.controls;
    c.piloted = piloted;
    c.fwd = piloted ? clamp(input.vehicleThrottle ?? ((k.f ? 1 : 0) - (k.b ? 1 : 0)), -1, 1) : 0;
    c.side = piloted ? clamp(input.vehicleSteer ?? ((k.r ? 1 : 0) - (k.l ? 1 : 0)), -1, 1) : 0;
    // An auto-titan (no crew at all) turns its hull toward its target at the leg rate.
    const autoYaw = !p && !v.occupantId && v.tfAuto?.targetId && Number.isFinite(v.tfAuto.yaw) ? v.tfAuto.yaw : v.yaw;
    c.aimYaw = piloted && Number.isFinite(input.yaw) ? input.yaw : autoYaw;
    c.aimPitch = piloted && Number.isFinite(input.pitch) ? input.pitch : 0;
    c.sprint = piloted && (((input.titanHold | 0) & 1) !== 0 || !!k.sprint);
    c.dash = piloted && v.dashRequest === true;
    v.dashRequest = false;
    const prev = this.previous;
    prev.x = v.x; prev.y = v.y; prev.z = v.z; prev.yaw = v.yaw;
    stepTitanWalk(v, c, dt, this.world);
    if (piloted && (c.fwd || c.side) && v.grounded !== false && !(v.dashT > 0)) this.ramAhead(v, c, prev, dt);
    if ((v.x !== prev.x || v.z !== prev.z || v.yaw !== prev.yaw) && this.hullBlocked(v, v)) {
      v.x = prev.x; v.z = prev.z; v.yaw = prev.yaw; v.vx = 0; v.vz = 0; v.speed = 0; v.dashT = 0;
    }
    if (v.speed > TITAN_RULES.crush.minSpeed) this.legCrush(v, piloted ? p : null, v.x - prev.x || finite(v.vx), v.z - prev.z || finite(v.vz));
    // Infantry contact (run-over impact) sees the legs' turn rate, not the 1:1 aim flick of the hull.
    const turn = titanFrame(v).legTurn * dt;
    prev.yaw = wrap(v.yaw - clamp(wrap(v.yaw - prev.yaw), -turn, turn));
    if (!this.vehicles.resolveInfantry(v, prev, p, dt)) { v.x = prev.x; v.z = prev.z; v.vx = 0; v.vz = 0; v.speed = 0; }
    v.turretYaw = v.yaw;
  }

  /**
   * Walker voxel ram: a piloted titan that walked less than half its wish this
   * substep breaks the light voxels (TITAN_RULES.ram) just ahead of it along
   * the wish, through VehicleSystem.ramVoxels (destroyBlock, budget, guards).
   */
  ramAhead(v, c, prev, dt) {
    const f = titanFrame(v), speed = c.fwd > 0 && c.sprint && !c.side ? f.sprint : c.fwd > 0 ? f.walk : c.fwd < 0 ? f.back : f.strafe;
    if (Math.hypot(v.x - prev.x, v.z - prev.z) >= 0.5 * speed * dt) return null;
    const sy = Math.sin(v.yaw), cy = Math.cos(v.yaw);
    let dx = -sy * c.fwd + cy * c.side, dz = -cy * c.fwd - sy * c.side;
    const len = Math.hypot(dx, dz);
    if (!(len > 1e-9)) return null;
    dx /= len; dz /= len;
    return this.ramLight(v, v.x + dx * 0.15, v.z + dz * 0.15, speed);
  }
  /** ramVoxels with a walker ram table at `speed`; the hull's own speed and ram budget are left as they were. */
  ramLight(v, x, z, speed, ram = TITAN_RULES.ram) {
    const saved = v.speed, budget = ram === TITAN_RULES.ram ? null : [v.ramBudget, v.ramBudgetAt, v.ramTickId, v.ramTickLeft];
    v.speed = speed;
    if (budget) v.ramBudget = v.ramTickId = undefined;
    let result = null;
    try { result = this.vehicles.ramVoxels(v, x, z, ram, false); } finally {
      v.speed = saved;
      if (budget) [v.ramBudget, v.ramBudgetAt, v.ramTickId, v.ramTickLeft] = budget;
    }
    return result;
  }

  /**
   * Walker leg-box crush (§5.2 Crush): an enemy pilot whose body overlaps a leg
   * box of a hull moving faster than crush.minSpeed dies (key titan_crush);
   * friendly bodies are left to resolveInfantry's push. Only bodies on the
   * leading side of the hull's motion (mx, mz) are crushed: a pilot running up
   * behind or level with a walking titan (the rodeo approach) is pushed instead.
   */
  legCrush(v, pilot, mx = finite(v.vx), mz = finite(v.vz)) {
    const boxes = vehicleDef(v)?.hullBoxes;
    if (!Array.isArray(boxes)) return 0;
    const reach = VEHICLE_RULES[v.type].radius + PHYSICS.halfW + 0.5, c = Math.cos(v.yaw), s = Math.sin(v.yaw), half = PHYSICS.halfW;
    let attacker, crushed = 0;
    for (const body of this.engine.entities.values()) {
      if (body.state !== 'alive' || body.vehicleId || body.rodeoVehicleId || body.ghostVehicleId === v.id) continue;
      // A rider that just hopped (or was pushed) off this hull is not crushed by it during its remount window.
      if (body.rodeoCooldown?.vehicleId === v.id && this.now < body.rodeoCooldown.until) continue;
      const dx = body.x - v.x, dz = body.z - v.z;
      if (dx * dx + dz * dz > reach * reach || this.vehicles.teamOf(body) === v.team) continue;
      if (!(dx * mx + dz * mz > 0)) continue;
      // Hull-local body box (walkers stay upright: yaw only). A leg box sweeps
      // the collider's full length (the stride reaches the footprint ends), so
      // a body the hull walks into in front of a leg is crushed, not pushed.
      const lx = dx * c - dz * s, lz = dx * s + dz * c, ly = body.y - v.y, top = ly + PHYSICS.height;
      const stride = vehicleDef(v).collider.halfLength + 0.05;
      let hit = false;
      for (const index of LEG_BOXES) {
        const [lo, hi] = boxes[index];
        if (lx + half > lo[0] && lx - half < hi[0] && lz + half > -stride && lz - half < stride && top > lo[1] && ly < hi[1]) { hit = true; break; }
      }
      if (!hit) continue;
      attacker ??= pilot ?? this.attackerFor(v);
      if (attacker && this.crushPilot(body, attacker, TITAN_RULES.crush.key)) crushed++;
    }
    return crushed;
  }

  /** Once per tick after the substeps: landings, doom drain, abilities, rodeo, batteries. */
  step(dt) {
    const now = this.now;
    for (const v of [...this.titans()]) {
      if (v.dropping) { if (now >= v.landsAt) this.land(v); continue; }
      if (!(v.hp > 0)) continue;
      if (v.doomed) {
        v.hp = Math.max(0, v.hp - v.doomPool / TITAN_RULES.doomSeconds * dt);
        if (!(v.hp > 0)) { this.destroyDoomed(v); continue; }
      }
      this.lava(v, dt);
      if (!(v.hp > 0)) continue;
      stepTitanAbilities(this, v, dt);
      if (v.hp > 0) this.stepAuto(v, now);
    }
    for (const p of this.engine.entities.values()) {
      if (p.embarkUntil && !(p.embarkUntil > now)) p.embarkUntil = 0;
      if (!p.tfDamageHook) this.attachDamageHook(p);
    }
    stepRodeo(this, dt);
    this.bats.step(now);
    if (this.bats.list.length) {
      for (const p of this.engine.entities.values()) if (p.state === 'alive' && !p.tfBattery && !p.vehicleId && !p.rodeoVehicleId) this.bats.pickup(p);
    }
  }

  /** Lava under the feet burns the hull (§5.1): lavaDps, cls fire, no attacker. */
  lava(v, dt) {
    if (v.grounded === false || !(dt > 0)) return;
    const world = this.engine.world, bx = Math.floor(v.x), bz = Math.floor(v.z);
    if (world.getBlock(bx, Math.floor(v.y + 0.1), bz) !== MC_LAVA && world.getBlock(bx, Math.floor(v.y - 0.5), bz) !== MC_LAVA) return;
    this.applyDamage(v, TITAN_RULES.fluid.lavaDps * dt, 'fire', null, { point: [v.x, v.y + 0.5, v.z] });
  }

  /**
   * Pilot damage feeds the attacker's titan meter (§5.2 Meter): one chained
   * `beforeDamage` hook per body (the conquest score pattern), inert once this
   * system is no longer the engine's titan system.
   */
  attachDamageHook(p) {
    if (!p || typeof p !== 'object' || p.tfDamageHook) return;
    const prior = typeof p.beforeDamage === 'function' ? p.beforeDamage : null;
    const hook = (dmg, attacker, weapon) => {
      const amount = prior ? (prior(dmg, attacker, weapon) ?? dmg) : dmg;
      if (amount > 0 && attacker && this.vehicles.titans === this && String(attacker.id) !== String(p.id)
        && this.vehicles.teamOf(attacker) !== this.vehicles.teamOf(p)) {
        const dealt = Math.min(amount, Math.max(0, finite(p.hp)) + Math.max(0, finite(p.armor)));
        const credited = this.engine.entities.get(String(attacker.id)) ?? null;
        if (dealt > 0 && credited) meterCredit(this.policy, credited, 'pilotDamage', dealt);
      }
      return amount;
    };
    p.beforeDamage = hook;
    p.tfDamageHook = hook;
  }

  // ---- auto-titan ------------------------------------------------------------------

  /**
   * AUTO-TITAN guard (§5.2): a titan with no crew re-picks, every
   * losIntervalMs, the nearest perceivable enemy pilot or titan within range
   * with a clear voxel line, turns its hull toward it (advance), aims its
   * primary there (plus aimNoise) and fires when the mount is ready, credited
   * to its owner. It drops electric smoke once an enemy rider has been on for
   * smokeAfterRiderMs. It never walks.
   */
  stepAuto(v, now) {
    const crewed = !!v.occupantId || this.vehicles.crew(v).length > 0;
    const auto = v.tfAuto ??= { targetId: null, yaw: NaN, pitch: 0, nextScan: 0, seed: hashSeed(v.id), smokeAskedAt: 0 };
    if (crewed || v.landedUntil > now || v.embarkUntil > now) { auto.targetId = null; return; }
    const rules = TITAN_RULES.auto;
    if (v.riderId && now - finite(v.riderSince, now) >= rules.smokeAfterRiderMs && !(auto.smokeAskedAt >= finite(v.riderSince, now))) {
      auto.smokeAskedAt = now;
      useTitanAbility(this, v, this.attackerFor(v), 'smoke');
    }
    const attacker = this.attackerFor(v);
    if (!attacker || this.engine.mode?.phase !== 'live') { auto.targetId = null; return; }
    if (now >= auto.nextScan) {
      auto.nextScan = now + rules.losIntervalMs;
      auto.targetId = this.autoTarget(v, attacker, now);
    }
    const target = this.autoResolve(v, auto.targetId);
    if (!target) { auto.targetId = null; return; }
    const seat = vehicleDef(v).seats.find(item => item.drives) ?? vehicleDef(v).seats[0];
    const choice = seat ? this.vehicles.mounts.selected(v, seat.id) : null;
    const state = choice ? this.vehicles.mounts.state(v, choice.mount) : null;
    if (!state) return;
    const pivot = mountPose(v, seat.id, choice.mount)?.pivot ?? [v.x, v.y + titanFrame(v).eye, v.z];
    const aim = aimAngles(pivot, target.point);
    auto.yaw = aim.yaw; auto.pitch = aim.pitch;
    const noise = rules.aimNoise;
    auto.seed = (Math.imul(auto.seed, 1664525) + 1013904223) >>> 0;
    const ny = ((auto.seed >>> 8) / 16777216 - 0.5) * 2 * noise;
    auto.seed = (Math.imul(auto.seed, 1664525) + 1013904223) >>> 0;
    const np = ((auto.seed >>> 8) / 16777216 - 0.5) * 2 * noise;
    const held = clampMountAim(v, choice.mount, aim.yaw + ny, aim.pitch + np);
    state.yaw = held.yaw; state.pitch = held.pitch;
    // Fire only once the hull has turned the target into the mount's arc.
    if (Math.abs(wrap(held.yaw - aim.yaw)) > noise + 0.05) return;
    this.vehicles.mounts.fire(v, seat, this.autoShooter(v) ?? attacker, choice.mount, choice.weapon);
  }

  /** Nearest perceivable enemy pilot or titan in range with a clear line, as an id ('p:<id>' | 'v:<id>'), or null. */
  autoTarget(v, attacker, now) {
    const range = TITAN_RULES.auto.range, eye = [v.x, v.y + titanFrame(v).eye, v.z], observer = { x: eye[0], y: eye[1], z: eye[2] };
    let best = null, bestD = range;
    const consider = (key, point, weight = 1) => {
      const dx = point[0] - eye[0], dy = point[1] - eye[1], dz = point[2] - eye[2], d = Math.hypot(dx, dy, dz);
      if (!(d * weight < bestD) || d < 1e-6) return;
      if (raycastVoxels((x, y, z) => this.vehicles.solid(x, y, z, true), ...eye, dx / d, dy / d, dz / d, d - 0.3)) return;
      best = key; bestD = d * weight;
    };
    // Attrition minions (WP8): fair game, after pilots and titans at a similar range.
    for (const body of this.engine.npcs?.values?.() ?? []) {
      if (!body.tfNpc || body.state !== 'alive' || body.team === v.team || this.engine.mode?.canDamage?.(attacker, body) === false) continue;
      consider(`p:${body.id}`, [body.x, body.y + 1.1, body.z], 1.6);
    }
    for (const body of this.engine.entities.values()) {
      if (body.state !== 'alive' || body.vehicleId || body.rodeoVehicleId === v.id || this.vehicles.teamOf(body) === v.team) continue;
      if (this.engine.mode?.canDamage?.(attacker, body) === false || !isPerceivable(observer, body, now)) continue;
      consider(`p:${body.id}`, [body.x, body.y + 1.2, body.z]);
    }
    for (const other of this.titans()) {
      if (other === v || !(other.hp > 0) || other.dropping || other.team === v.team) continue;
      consider(`v:${other.id}`, [other.x, other.y + titanFrame(other).height * 0.6, other.z]);
    }
    return best;
  }
  autoResolve(v, key) {
    if (typeof key !== 'string') return null;
    if (key.startsWith('p:')) {
      const body = (this.engine.combatants ?? this.engine.entities).get(key.slice(2));
      if (!body || body.state !== 'alive' || body.vehicleId) return null;
      return { body, point: [body.x, body.y + 1.2, body.z] };
    }
    const other = this.vehicles.vehicles.get(key.slice(2));
    if (!other || !(other.hp > 0) || other.dropping) return null;
    return { vehicle: other, point: [other.x, other.y + titanFrame(other).height * 0.6, other.z] };
  }

  /** Phase enum for the row (§3.3). */
  phaseOf(v, now = this.now) {
    if (v.dropping) return TITAN_PHASE.dropping;
    if (v.doomed) return TITAN_PHASE.doomed;
    if (v.landedUntil > now) return TITAN_PHASE.landed;
    if (v.embarkUntil > now) return TITAN_PHASE.embark;
    if (v.disembarkUntil > now) return TITAN_PHASE.disembark;
    if (!v.occupantId) return TITAN_PHASE.auto;
    return TITAN_PHASE.idle;
  }

  /** Titan extras on the vehicle row: tw, own, ab (§3.3). */
  rowExtras(v, row) {
    if (!isTitanType(v?.type)) return row;
    const now = this.now, B = TITAN_ABILITY_BITS, mv = v.tfMove;
    let bits = 0;
    if (v.tfAbility?.coreUntil > now) bits |= B.core;
    if (v.tfAbility?.activeUntil?.defensive > now) bits |= B.defensive;
    if (v.tfAbility?.smokeUntil > now) bits |= B.smoke;
    if (mv?.hoverVy != null) bits |= B.hover;
    if (mv?.phasedUntil > now) bits |= B.phased;
    if (v.tfAbility?.slowUntil > now) bits |= B.slowed;
    if (mv?.rooted) bits |= B.rooted;
    if (v.batteryOut) bits |= B.batteryOut;
    if (v.riderId) bits |= B.rider;
    const ready = abilityReadiness(this, v, now);
    const doomLeft = v.doomed && v.hp > 0 && v.doomPool > 0 ? v.hp / v.doomPool * TITAN_RULES.doomSeconds : 0;
    Object.assign(row, encodeTitanRow({ shield: v.shield, dash: v.dash, core: v.tfAbility?.core ?? 0, doomLeft, bits,
      phase: v.hp > 0 || v.dropping ? this.phaseOf(v, now) : TITAN_PHASE.ejected, owner: v.owner,
      def: ready.def, tac: ready.tac, ord: ready.ord, smoke: ready.smoke }));
    return row;
  }

  /** Ephemeral wreck: removed after TITAN_WRECK_SECONDS. */
  wreckDone(v) { return isTitanType(v?.type) && !(v.hp > 0) && finite(v.wreckAge) >= TITAN_WRECK_SECONDS; }

  /** After VehicleSystem.destroy: riders off, locks over. No points here (policy.onVehicleEvent). */
  onDestroyed(v, by) {
    if (!isTitanType(v?.type)) return;
    for (const p of this.engine.entities.values()) {
      if (p.rodeoVehicleId === v.id) releaseRider(this, p);
      if (v.owner === String(p.id)) p.embarkUntil = 0;
    }
    v.shield = 0; v.dropping = false; v.embarkUntil = 0; v.riderId = null; v.tfAuto = null;
    void by;
  }

  // ---- damage ----------------------------------------------------------------------

  applyDamage(v, amount, cls, by, hit = {}) { return applyTitanDamage(this, v, amount, cls, by, hit); }
  /** combat.js hook: a rider's hatch shot. True when consumed (the hull hit is skipped). */
  riderHit(attacker, v, hit, weaponId) { return isTitanType(v?.type) && rodeoRiderHit(this, attacker, v, hit, weaponId) === true; }

  /** hp reached 0: the doom pool starts (20 % of max), draining over doomSeconds. */
  doom(v, by) {
    if (v.doomed) return;
    v.doomed = true;
    v.doomedAt = this.now;
    v.doomedBy = by ?? null;
    v.doomPool = TITAN_RULES.doomPoolFrac * vehicleMaxHp(v);
    v.hp = v.doomPool;
    v.shield = 0;
    this.emit('titan_doomed', { vehicleId: v.id, by: idOf(by) });
  }
  destroyDoomed(v) {
    if (v.tfDestroyed) return;
    v.tfDestroyed = true;
    // §1.1: a pilot still in the embark animation is released at the exit spot and takes no crew death.
    const now = this.now;
    for (const p of [...this.vehicles.crew(v)]) if (p.embarkUntil > now) this.onExit(v, p);
    this.vehicles.destroy(v, this.doomedBy(v), { crewKey: 'titan_doom' });
  }
  isDoomed(v) { return !!v?.doomed && v.hp > 0; }
  shieldOf(v) { return finite(v?.shield); }
  /** Destruction credit: the doomer, else the latest enemy damage inside the assist window. Never the owner. */
  doomedBy(v) {
    // Entities resolve by id: an auto-titan's stand-in (dead owner) credits the owner's entity.
    const resolve = p => {
      const entity = p?.id == null ? null : this.engine.entities.get(String(p.id)) ?? null;
      return entity && this.vehicles.teamOf(entity) !== v.team && String(entity.id) !== v.owner ? entity : null;
    };
    const doomer = resolve(v.doomedBy);
    if (doomer) return doomer;
    const now = this.vehicles.nowMs();
    let best = null, bestAt = -Infinity;
    for (const entry of v.damageLog?.values() ?? []) {
      const entity = now - entry.at > VEHICLE_DAMAGE_RULES.assistWindowMs ? null : resolve(entry.player);
      if (entity && entry.at > bestAt) { best = entity; bestAt = entry.at; }
    }
    return best;
  }
  /**
   * Electric smoke on riders (WP3 calls it per tick while smoke is up): the
   * hull's enemy rider takes `dps × dt` (key electricSmoke), credited to the
   * titan's pilot or owner. Returns the number of riders killed.
   */
  killRiders(v, dps, dt) {
    if (!isTitanType(v?.type) || !v.riderId || !(dps > 0) || !(dt > 0)) return 0;
    const rider = this.engine.entities.get(v.riderId);
    if (!rider || rider.state !== 'alive' || rider.rodeoVehicleId !== v.id) return 0;
    const attacker = this.vehicles.seatOccupant(v, 'driver') ?? this.attackerFor(v);
    const damage = dps * dt;
    const lethal = typeof rider.takeDamage === 'function' && rider.takeDamage(damage, false, attacker, 'electricSmoke');
    this.engine.tickEvents?.push(evHit(attacker?.id ?? '', rider.id, damage, false, [rider.x, rider.y + 0.8, rider.z], rider.lastDamage));
    if (lethal) { this.engine.killPlayer?.(rider, attacker, 'electricSmoke', false); return 1; }
    return 0;
  }

  // ---- intents ---------------------------------------------------------------------

  /** Titan ability intent: 'dash' queues a dash pip; the rest goes to titan-abilities.js. */
  ability(v, p, slot) {
    if (!isTitanType(v?.type) || !(v.hp > 0) || !this.vehicles.seatFor(p, v)) return false;
    if (slot === 'dash') {
      if (!(v.dash >= 1) || v.dashT > 0) return false;
      v.dashRequest = true;
      return true;
    }
    return useTitanAbility(this, v, p, slot) === true;
  }
  rodeo(p, verb) { return rodeoAction(this, p, verb) === true; }
  pickupBattery(p) { return this.bats.pickup(p); }
  batteries() { return this.bats.rows(); }

  /** Owner left or switched team: the titan goes without score, riders and drops included. */
  removeOwned(playerId, reason = 'leave') {
    const id = String(playerId ?? '');
    for (const v of [...this.titans()]) {
      if (v.owner !== id) continue;
      for (const p of this.vehicles.crew(v)) this.vehicles.release(p);
      for (const p of this.engine.entities.values()) if (p.rodeoVehicleId === v.id) releaseRider(this, p);
      this.vehicles.vehicles.delete(v.id);
    }
    const p = this.engine.entities.get(id);
    if (p) {
      if (p.rodeoVehicleId) releaseRider(this, p);
      if (p.tfBattery) { p.tfBattery = false; this.bats.drop(p.x, p.y, p.z, this.now); }
      p.embarkUntil = 0; p.tfRip = null; p.tfInsert = null;
    }
    this.standIns.delete(id);
    void reason;
    return true;
  }
  /** Bot takeover: the titan follows its pilot's new id. */
  renameOwner(priorId, nextId) {
    const prior = String(priorId), next = String(nextId);
    for (const v of this.titans()) {
      if (v.owner === prior) v.owner = next;
      if (v.riderId === prior) v.riderId = next;
    }
    this.standIns.delete(prior);
  }
  ownsAny(playerId) { return !!this.ownedBy(playerId); }

  // ---- collision helpers -----------------------------------------------------------

  /** Footprint and height overlap between two hulls. */
  overlaps(a, b) {
    const ra = VEHICLE_RULES[a.type], rb = VEHICLE_RULES[b.type];
    if (Math.hypot(a.x - b.x, a.z - b.z) > ra.radius + rb.radius + 0.5) return false;
    if (!(a.y < b.y + rb.height && b.y < a.y + ra.height)) return false;
    return footprintsOverlap(hullFootprint(a.type, a.x, a.z, a.yaw), hullFootprint(b.type, b.x, b.z, b.yaw));
  }
  /** True when `probe` overlaps any solid hull (or pending drop) other than `self`. */
  hullBlocked(probe, self) {
    for (const other of this.vehicles.vehicles.values()) {
      if (other === self || (!other.dropping && !solidHull(other))) continue;
      if (this.overlaps(probe, other)) return true;
    }
    return false;
  }
}
