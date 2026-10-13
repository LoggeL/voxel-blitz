/**
 * Titan branch of VehicleMounts (docs/titanfall.md §5.4, WP3). vehicle-mounts.js
 * hands every titan hull here from `step`, `fire` and `rows`; other hulls never
 * reach this file. The titan primary is one mount (LEGION: one mount, two
 * weapons through the Mode Switch toggle) on the driver seat.
 *
 * - Charge (railgun): holding the trigger charges for `chargeSeconds`; release
 *   fires at the charge reached (damage and infantryDamage lerp to their
 *   `*Charged` values). A `fire` call (the auto-titan asks every tick it is
 *   aimed) keeps the charge building and shoots at full charge, so the
 *   auto-titan path works without a release edge.
 * - Spin (Predator): trigger or `fire` calls spin the barrels up over
 *   `spinUpSeconds`; rounds only leave at full spin (Smart Core skips the
 *   spin-up); idle barrels spin down over `spinDownSeconds`.
 * - Splitter ADS (titanHold 4): `split.beams` beams in a `fanDeg` fan at
 *   `damageMul` each, for `split.energy` ION energy; plain shots otherwise.
 * - titanHold 8 starts a reload of a part-empty magazine.
 * - Smart Core: ×damageMul on every primary round and auto-aim (smartCoreAim).
 * - Abilities that hold the primary (Vortex, Sword Block, laser/flight/sword
 *   core, phased) refuse the shot (titan-abilities.js primaryBlocked).
 *
 * Crosshair convergence: the pilot's crosshair ray (the client's `titanSight`
 * camera ray, else the cockpit eye along the input aim) is traced against
 * voxels, hulls and pilots, and the mount slews toward that point, so rounds
 * leave along the mount pose and land where the crosshair is in the cockpit
 * and the chase view (titan-sim-test's blind-spot check pins it). A muzzle
 * pushed into a wall fires from the arm pivot instead of refusing the shot.
 * Hitscan rounds go through titanRay (enemy sphere guards, then
 * fireMountedRay, with pierce); shells through the titanfall projectile router
 * ('titan:t203', 'titan:leadwall' per pellet). A railgun shoot event carries
 * the `charge` (0..1) it left at, for the client's crack and beam. Rows are 6-tuples
 * [yaw, pitch, ammo (-1 unlimited), heat100, reload100, charge100] where
 * charge100 is the railgun charge or the Predator spin.
 */
import { VEHICLE_WEAPONS, vehicleDef, mountPose, clampMountAim, seatWeaponList, vehicleLocalPoint, vehicleDirection } from '../../../shared/vehicle-defs.js';
import { raycastVoxels } from '../../../shared/raycast.js';
import { nearestVictim } from '../combat.js';
import { evVehicleShoot } from '../../protocol/events.js';
import { TITAN_HOLD_BITS, titanRay, primaryBlocked, smartCoreActive, smartCoreAim, primaryDamageMul, spendEnergy, titanEnergy, spreadDir } from './titan-abilities.js';

const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const round = (value, scale) => Math.round(finite(value) * scale) / scale;
/** A `fire` call keeps a charge or spin alive this long (ms): a tick or two. */
const ASK_MS = 120;
/**
 * Crosshair convergence (playability pass): the sight is traced this far (m); a
 * client sight origin (`input.titanSight` [x, y, z, yaw, pitch], the camera) is
 * used only within `maxOffset` of the cockpit eye and `maxAngle` of the input aim.
 */
export const TITAN_SIGHT = Object.freeze({ range: 400, maxOffset: 24, maxAngle: 0.8, minConverge: 5, fallback: 40 });

/** The cockpit eye of a titan hull (the driver seat's camera eye, as the client's seatEyeWorld). */
export function titanCockpitEye(v) {
  const def = vehicleDef(v), eye = def?.seats?.[0]?.camera?.eye ?? [0, finite(def?.rules?.eye, 5), 0];
  return vehicleLocalPoint(v, eye[0], eye[1], eye[2]);
}

/**
 * The crosshair ray of a seated pilot: { origin, dir, skip }. The client's camera
 * sight when it is plausible (chase or cockpit), else the cockpit eye along the
 * input aim. `skip` is how far along the ray the sight passes the cockpit eye: a
 * chase camera's ray ignores what lies between the camera and the hull.
 */
export function titanSightRay(v, input) {
  const eye = titanCockpitEye(v), aim = vehicleDirection(input.yaw, finite(input.pitch));
  const sight = input.titanSight;
  if (Array.isArray(sight) && sight.length === 5 && sight.every(Number.isFinite)) {
    const origin = [sight[0], sight[1], sight[2]], dir = vehicleDirection(sight[3], sight[4]);
    const off = [eye[0] - origin[0], eye[1] - origin[1], eye[2] - origin[2]];
    if (Math.hypot(...off) <= TITAN_SIGHT.maxOffset && dir[0] * aim[0] + dir[1] * aim[1] + dir[2] * aim[2] >= Math.cos(TITAN_SIGHT.maxAngle)) {
      return { origin, dir, skip: Math.max(0, off[0] * dir[0] + off[1] * dir[1] + off[2] * dir[2]) };
    }
  }
  return { origin: eye, dir: aim, skip: 0 };
}

/** World point under the crosshair: the first voxel, other hull or damageable pilot along the sight (else `range` out). */
export function titanAimPoint(mounts, v, operator, input) {
  const { origin, dir, skip } = titanSightRay(v, input), ctx = mounts.system.combatContext();
  const start = [origin[0] + dir[0] * skip, origin[1] + dir[1] * skip, origin[2] + dir[2] * skip];
  const hit = ctx?.solidAt ? raycastVoxels(ctx.solidAt, ...start, ...dir, TITAN_SIGHT.range) : null;
  let t = hit ? hit.t : TITAN_SIGHT.range;
  const hull = mounts.system.rayHit?.(start, dir, t, v.id);
  if (hull) t = Math.min(t, hull.distance);
  let victim = null;
  if (operator && ctx?.canDamage) {
    victim = nearestVictim(operator, start, { x: dir[0], y: dir[1], z: dir[2] }, t, ctx);
    if (victim) t = victim.t;
  }
  // A wall or hull right in front of the cockpit (playtest: 1-1.6 m) would slew the mount to its
  // pitch stop: closer than minConverge to the cockpit eye, converge at `fallback` along the sight.
  const eye = titanCockpitEye(v), near = [start[0] + dir[0] * t - eye[0], start[1] + dir[1] * t - eye[1], start[2] + dir[2] * t - eye[2]];
  if (!victim && Math.hypot(near[0], near[1], near[2]) < TITAN_SIGHT.minConverge) t = TITAN_SIGHT.fallback;
  return [start[0] + dir[0] * t, start[1] + dir[1] * t, start[2] + dir[2] * t];
}

function nextRandom(state) {
  let x = state.rng >>> 0 || 0x9e3779b9;
  x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
  state.rng = x;
  return x / 4294967296;
}
const nowOf = mounts => finite(mounts.system.titans?.now ?? mounts.engine?.now);

/** Slew, reload, charge/spin and fire the titan primary (VehicleMounts.step for a titan hull). */
export function stepTitanMounts(mounts, v, dt) {
  const def = vehicleDef(v);
  if (!def || !v.mounts?.length) return;
  const now = nowOf(mounts), seat = def.seats[0], operator = mounts.system.seatOccupant(v, seat.id);
  const input = operator?.input || null, hold = input ? input.titanHold | 0 : 0;
  const trigger = !!(operator && input?.wantFire && mounts.system.canOperate(operator) && !(operator.embarkUntil > now));
  const choice = mounts.selected(v, seat.id), active = choice ? mounts.state(v, choice.mount) : null;
  const weapon = choice ? VEHICLE_WEAPONS[choice.weapon] : null;
  if (active && trigger) {
    if (weapon.chargeSeconds && !primaryBlocked(v, now)) active.chargeAskAt = now;
    if (weapon.spinUpSeconds) active.spinAskAt = now;
  }
  for (const state of v.mounts) tickTitanTimers(state, dt, now);
  // The crosshair point the mount converges on (one trace per hull and tick).
  const aimPoint = input && Number.isFinite(input.yaw) ? titanAimPoint(mounts, v, operator, input) : null;
  for (const mountId of seat.mounts) {
    const mount = def.mounts[mountId], state = mounts.state(v, mountId);
    if (!state) continue;
    // The auto-titan (no operator) aims its mount itself (TitanSystem.stepAuto).
    if (!aimPoint) { const held = clampMountAim(v, mountId, state.yaw, state.pitch); state.yaw = held.yaw; state.pitch = held.pitch; continue; }
    const pivot = mountPose(v, seat.id, mountId, { side: state.side })?.pivot ?? titanCockpitEye(v);
    const to = [aimPoint[0] - pivot[0], aimPoint[1] - pivot[1], aimPoint[2] - pivot[2]], flat = Math.hypot(to[0], to[2]);
    const target = flat > 1e-6 || Math.abs(to[1]) > 1e-6
      ? clampMountAim(v, mountId, Math.atan2(-to[0], -to[2]), Math.atan2(to[1], flat))
      : clampMountAim(v, mountId, input.yaw, finite(input.pitch));
    const yawStep = mount.yawRate * dt, pitchStep = mount.pitchRate * dt;
    state.yaw = wrap(state.yaw + clamp(wrap(target.yaw - state.yaw), -yawStep, yawStep));
    state.pitch = state.pitch + clamp(target.pitch - state.pitch, -pitchStep, pitchStep);
    const held = clampMountAim(v, mountId, state.yaw, state.pitch);
    state.yaw = held.yaw; state.pitch = held.pitch;
  }
  if (!active) return;
  if ((hold & TITAN_HOLD_BITS.reload) && Number.isFinite(weapon.magazine) && active.ammo < weapon.magazine && !(active.reloadT > 0) && weapon.reloadSeconds) {
    active.reloadT = weapon.reloadSeconds;
    active.charge = 0;
  }
  const wasHeld = active.held;
  for (const mountId of seat.mounts) { const state = mounts.state(v, mountId); if (state) state.held = trigger; }
  if (weapon.chargeSeconds) {
    // Release fires whatever charge was built (a full charge already fired on its own when asked by `fire`).
    if (wasHeld && !trigger && active.charge >= finite(weapon.minReleaseCharge, 0.05)) fireTitanMount(mounts, v, seat, operator, choice.mount, choice.weapon, { release: true });
    return;
  }
  if (trigger) fireTitanMount(mounts, v, seat, operator, choice.mount, choice.weapon, { ads: !!(hold & TITAN_HOLD_BITS.ads) });
}

/** Cooldown, reload, railgun charge, Predator spin. */
export function tickTitanTimers(state, dt, now) {
  const weapon = VEHICLE_WEAPONS[state.weapon];
  state.cooldown = Math.max(state.held ? -dt : 0, state.cooldown - dt);
  if (state.reloadT > 0) {
    state.reloadT = Math.max(0, state.reloadT - dt);
    if (state.reloadT === 0 && Number.isFinite(weapon.magazine)) state.ammo = weapon.magazine;
  }
  if (weapon.chargeSeconds) {
    const asked = now - finite(state.chargeAskAt, -Infinity) <= ASK_MS;
    if (!asked) state.charge = 0;
    else if (!(state.cooldown > 0) && !(state.reloadT > 0)) state.charge = Math.min(1, finite(state.charge) + dt / weapon.chargeSeconds);
  }
  if (weapon.spinUpSeconds || state.spin > 0) {
    const asked = weapon.spinUpSeconds && now - finite(state.spinAskAt, -Infinity) <= ASK_MS && !(state.reloadT > 0);
    state.spin = clamp(finite(state.spin) + (asked ? dt / weapon.spinUpSeconds : -dt / (weapon.spinDownSeconds || 1)), 0, 1);
  }
}

/**
 * One titan primary shot (VehicleMounts.fire for a titan hull). `release`:
 * the railgun trigger came up (fire at the charge built); otherwise a railgun
 * keeps charging and fires at full charge. True when a round left.
 */
export function fireTitanMount(mounts, v, seat, operator, mountId, weaponKey, { release = false, ads = null } = {}) {
  const state = mounts.state(v, mountId), weapon = VEHICLE_WEAPONS[weaponKey], titans = mounts.system.titans;
  if (!state || !weapon || !operator || !titans || weapon.kind === 'melee' || state.weapon !== weaponKey) return false;
  const now = nowOf(mounts);
  if (primaryBlocked(v, now)) return false;
  if (weapon.chargeSeconds && !release) state.chargeAskAt = now;
  if (weapon.spinUpSeconds) state.spinAskAt = now;
  if (state.cooldown > 1e-9 || state.reloadT > 0 || (Number.isFinite(weapon.magazine) && state.ammo <= 0)) return false;
  let charge = 1;
  if (weapon.chargeSeconds) {
    charge = finite(state.charge);
    if (release ? charge < finite(weapon.minReleaseCharge, 0.05) : charge < 1) return false;
  }
  if (weapon.spinUpSeconds && state.spin < 1 && !smartCoreActive(v, now)) return false;
  const pose = mountPose(v, seat.id, mountId, { side: state.side });
  if (!pose) return false;
  // A muzzle pushed into a wall (the barrel reaches past the walker collider) fires from the arm
  // pivot, so the round meets that wall; only a pivot inside a voxel refuses the shot.
  let muzzle = pose.origin;
  if (mounts.obstructed(pose)) {
    if (mounts.system.solid(...pose.pivot, true)) return false;
    muzzle = pose.pivot;
  }
  const mul = primaryDamageMul(v, now);
  let aim = pose.dir;
  if (smartCoreActive(v, now)) aim = smartCoreAim(titans, v, muzzle, aim);
  const cone = finite(weapon.spreadDeg) * Math.PI / 180;
  const ends = [];
  if (weapon.projectile) {
    const launch = titans.engine.projectiles?.titanfall, ctx = mounts.system.projectileContext();
    let launched = 0;
    for (let i = 0, n = Math.max(1, weapon.pellets | 0); i < n && launch && ctx; i++) {
      const dir = cone > 0 ? spreadDir(aim, cone, nextRandom(state), nextRandom(state)) : aim;
      if (launch.launch(weapon.projectile, { owner: operator, origin: muzzle, dir, vehicleId: v.id, titanId: v.id, damageMul: mul }, ctx)) launched++;
    }
    if (!launched) return false;
  } else {
    const shot = { ...weapon, damage: weapon.damage * mul, infantryDamage: weapon.infantryDamage * mul };
    if (weapon.chargeSeconds) {
      shot.damage = (weapon.damage + (weapon.damageCharged - weapon.damage) * charge) * mul;
      shot.infantryDamage = (weapon.infantryDamage + (weapon.infantryDamageCharged - weapon.infantryDamage) * charge) * mul;
    }
    const wantsSplit = ads ?? !!((operator.input?.titanHold | 0) & TITAN_HOLD_BITS.ads);
    const split = weapon.split && wantsSplit && titanEnergy(v) >= weapon.split.energy ? weapon.split : null;
    if (split) {
      spendEnergy(titans, v, split.energy);
      const fan = split.fanDeg * Math.PI / 180, yaw = Math.atan2(-aim[0], -aim[2]), flat = Math.hypot(aim[0], aim[2]);
      const beam = { ...shot, damage: shot.damage * split.damageMul, infantryDamage: shot.infantryDamage * split.damageMul };
      for (let b = 0; b < split.beams; b++) {
        const a = yaw + (b - (split.beams - 1) / 2) * fan;
        const dir = [-Math.sin(a) * flat, aim[1], -Math.cos(a) * flat];
        ends.push(titanRay(titans, v, operator, muzzle, dir, beam).result);
      }
    } else {
      const dir = cone > 0 ? spreadDir(aim, cone, nextRandom(state), nextRandom(state)) : aim;
      ends.push(titanRay(titans, v, operator, muzzle, dir, shot, { pierce: weapon.pierce ?? 1 }).result);
    }
  }
  state.shots++;
  state.cooldown = weapon.cooldown + Math.min(0, state.cooldown);
  if (weapon.chargeSeconds) { state.charge = 0; state.chargeAskAt = -Infinity; }
  if (Number.isFinite(weapon.magazine)) {
    state.ammo--;
    if (state.ammo <= 0 && weapon.reloadSeconds) state.reloadT = weapon.reloadSeconds;
  }
  operator.firing = true;
  operator.spawnProtectedUntil = 0;
  operator.spawnProtected = false;
  const tracer = weapon.kind === 'hitscan' ? (weapon.chargeSeconds ? true : (state.shots - 1) % 3 === 0) : false;
  const first = ends[0];
  const event = evVehicleShoot(operator.id, muzzle, aim, weapon.presentation, {
    vehicleId: v.id, mount: mountId, vehicleWeapon: weapon.key, tracer,
    ...(first ? { end: first.end, hit: first.hit } : {}),
  });
  // The charge the shot left at (railgun): the client scales the crack, beam and kick with it (presentation).
  if (weapon.chargeSeconds) event.charge = Math.round(clamp(charge, 0, 1) * 100) / 100;
  if (ends.length > 1) {
    event.paths = ends.map(result => {
      const segment = { o: event.o, end: result.end.map(n => Math.round(n * 100) / 100) };
      if (result.hit) segment.hit = { x: result.hit.x | 0, y: result.hit.y | 0, z: result.hit.z | 0, nx: result.hit.nx | 0, ny: result.hit.ny | 0, nz: result.hit.nz | 0 };
      return [segment];
    });
  }
  titans.engine.tickEvents?.push(event);
  return true;
}

/**
 * The seat weapon select (VehicleMounts.select, the `weapon` vehicle action) on a titan: the
 * current weapon is a no-op; another one goes through LEGION's Mode Switch (its lockout and
 * tactical cooldown), never as a free swap.
 */
export function selectTitanWeapon(mounts, v, seatId, index) {
  const list = seatWeaponList(v.type, seatId);
  if (!list.length || !Number.isInteger(index) || index < 0 || index >= list.length) return false;
  if (index === mounts.selectedIndex(v, seatId)) return true;
  const titans = mounts.system.titans, pilot = mounts.system.seatOccupant(v, seatId);
  if (!titans || !pilot || list.length !== 2) return false;
  return titans.ability(v, pilot, 'mode') === true;
}

/** Snapshot rows: [yaw, pitch, ammo (-1 unlimited), heat100, reload100 (remaining), charge100 (railgun charge / Predator spin)]. */
export function titanMountRows(v) {
  return (v.mounts || []).map(state => {
    const weapon = VEHICLE_WEAPONS[state.weapon];
    let reload = 0;
    if (state.reloadT > 0) reload = state.reloadT / weapon.reloadSeconds;
    else if (weapon.cooldown >= 1 && state.cooldown > 0) reload = state.cooldown / weapon.cooldown;
    const charge = weapon.chargeSeconds ? finite(state.charge) : finite(state.spin);
    return [round(state.yaw, 1000), round(state.pitch, 1000), state.ammo, 0, Math.round(clamp(reload, 0, 1) * 100), Math.round(clamp(charge, 0, 1) * 100)];
  });
}
