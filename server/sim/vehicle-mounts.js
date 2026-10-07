/**
 * Per-seat weapon mounts. Each mount slews toward its seat occupant's aim at
 * its own rates and limits, fires along the barrel (no alignment gate), and
 * routes shells/rockets/missiles to the projectile system and hitscan guns to
 * combat.fireMountedRay. Every accepted shot emits a `shoot` event.
 */
import { VEHICLE_DAMAGE_RULES, VEHICLE_WEAPONS, vehicleDef, mountPose, clampMountAim, seatWeaponList } from '../../shared/vehicle-defs.js';
import { raycastVoxels } from '../../shared/raycast.js';
import { fireMountedRay } from './combat.js';
import { evVehicleShoot } from '../protocol/events.js';

const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const round = (value, scale) => Math.round(finite(value) * scale) / scale;
/**
 * clampMountAim is a pure function of the hull type, the mount, the requested
 * aim and the hull attitude (yaw, pitch, roll). Each mount keeps its two most
 * recent results; an idle or parked hull asks the same question every tick.
 */
const aimMemo = new WeakMap();
function clampAim(vehicle, mountId, yaw, pitch) {
  let byMount = aimMemo.get(vehicle);
  if (!byMount) aimMemo.set(vehicle, byMount = new Map());
  let entries = byMount.get(mountId);
  if (!entries) byMount.set(mountId, entries = []);
  for (const e of entries) if (e.type === vehicle.type && e.kind === vehicle.kind && Object.is(e.yaw, yaw) && Object.is(e.pitch, pitch)
    && Object.is(e.hullYaw, vehicle.yaw) && Object.is(e.hullPitch, vehicle.pitch) && Object.is(e.hullRoll, vehicle.roll)) return e.result;
  const result = clampMountAim(vehicle, mountId, yaw, pitch);
  entries.unshift({ type: vehicle.type, kind: vehicle.kind, yaw, pitch, hullYaw: vehicle.yaw, hullPitch: vehicle.pitch, hullRoll: vehicle.roll, result });
  if (entries.length > 2) entries.pop();
  return result;
}

/** Small deterministic spread generator per mount (xorshift on a seeded state). */
function nextRandom(state) {
  let x = state.rng >>> 0 || 0x9e3779b9;
  x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
  state.rng = x;
  return x / 4294967296;
}
function seed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
function spreadDirection(dir, degrees, state) {
  if (!(degrees > 0)) return dir;
  const cone = degrees * Math.PI / 180, a = nextRandom(state) * Math.PI * 2, r = Math.sqrt(nextRandom(state)) * Math.tan(cone);
  const up = Math.abs(dir[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
  let u = [dir[1] * up[2] - dir[2] * up[1], dir[2] * up[0] - dir[0] * up[2], dir[0] * up[1] - dir[1] * up[0]];
  const ul = Math.hypot(...u); u = u.map(n => n / ul);
  const w = [dir[1] * u[2] - dir[2] * u[1], dir[2] * u[0] - dir[0] * u[2], dir[0] * u[1] - dir[1] * u[0]];
  const out = dir.map((n, i) => n + (u[i] * Math.cos(a) + w[i] * Math.sin(a)) * r), l = Math.hypot(...out);
  return out.map(n => n / l);
}

export class VehicleMounts {
  constructor(system) { this.system = system; }
  get engine() { return this.system.engine; }

  /** Fresh mount states in vehicleMountOrder order. */
  create(vehicle) {
    const def = vehicleDef(vehicle);
    return def.mountOrder.map(key => {
      const mountId = key.slice(key.indexOf(':') + 1), mount = def.mounts[mountId], weapon = VEHICLE_WEAPONS[mount.weapons[0]];
      const yaw = wrap(finite(vehicle.yaw) + (mount.yawLimit ? mount.yawLimit[0] : 0));
      return { key, seatId: mount.seatId, mountId, yaw, pitch: 0, weapon: mount.weapons[0], cooldown: 0,
        ammo: Number.isFinite(weapon.magazine) ? weapon.magazine : -1, reloadT: 0, heat: 0, overheated: false, overheatT: 0,
        rearm: [], side: 0, shots: 0, held: false, rng: seed(`${vehicle.id}:${key}`) };
    });
  }
  reset(vehicle) {
    vehicle.mounts = this.create(vehicle);
    vehicle.sel = {};
    const main = this.state(vehicle, 'main');
    if (main) { vehicle.turretYaw = main.yaw; vehicle.turretPitch = main.pitch; }
  }
  state(vehicle, mountId) {
    const index = vehicleDef(vehicle)?.mounts[mountId]?.index;
    return Number.isInteger(index) ? vehicle.mounts?.[index] ?? null : null;
  }

  /** Index into seatWeaponList for a seat (0 by default). */
  selectedIndex(vehicle, seatId) {
    const list = seatWeaponList(vehicle.type, seatId);
    const index = vehicle.sel?.[seatId] | 0;
    return list.length ? clamp(index, 0, list.length - 1) : -1;
  }
  selected(vehicle, seatId) {
    const list = seatWeaponList(vehicle.type, seatId), index = this.selectedIndex(vehicle, seatId);
    return index >= 0 ? list[index] : null;
  }
  /** The weapon action: pick an entry of the seat's weapon list. */
  select(vehicle, seatId, index) {
    const list = seatWeaponList(vehicle.type, seatId);
    if (!list.length || !Number.isInteger(index) || index < 0 || index >= list.length) return false;
    vehicle.sel[seatId] = index;
    const { mount, weapon } = list[index], state = this.state(vehicle, mount);
    if (state && state.weapon !== weapon) {
      state.weapon = weapon;
      // Loading a different shell into the shared breech restarts its reload.
      const cooldown = VEHICLE_WEAPONS[weapon].cooldown;
      if (VEHICLE_WEAPONS[weapon].sharedCooldown) state.cooldown = Math.max(state.cooldown, Math.min(cooldown, 1));
    }
    return true;
  }

  /** Slew, cool, reload, rearm and fire every mount of one live hull. */
  step(vehicle, dt) {
    const def = vehicleDef(vehicle);
    if (!def || !vehicle.mounts?.length) return;
    const slewScale = vehicle.disabled ? VEHICLE_DAMAGE_RULES.disabledSlew : 1;
    for (const state of vehicle.mounts) this.tickTimers(state, dt);
    for (const seat of def.seats) {
      if (!seat.mounts.length) continue;
      const operator = this.system.seatOccupant(vehicle, seat.id);
      const input = operator?.input || null;
      for (const mountId of seat.mounts) {
        const mount = def.mounts[mountId], state = this.state(vehicle, mountId);
        if (!state || mount.slavedTo) continue;
        if (mount.fixed) { state.yaw = finite(vehicle.yaw); state.pitch = finite(vehicle.pitch); continue; }
        const desired = input && Number.isFinite(input.yaw) ? { yaw: input.yaw, pitch: finite(input.pitch) } : { yaw: state.yaw, pitch: state.pitch };
        const target = clampAim(vehicle, mountId, desired.yaw, desired.pitch);
        const yawStep = mount.yawRate * slewScale * dt, pitchStep = mount.pitchRate * slewScale * dt;
        state.yaw = wrap(state.yaw + clamp(wrap(target.yaw - state.yaw), -yawStep, yawStep));
        state.pitch = state.pitch + clamp(target.pitch - state.pitch, -pitchStep, pitchStep);
        // The hull may have turned under a limited mount: stay inside the arc.
        const held = clampAim(vehicle, mountId, state.yaw, state.pitch);
        state.yaw = held.yaw; state.pitch = held.pitch;
      }
      for (const mountId of seat.mounts) {
        const mount = def.mounts[mountId], state = this.state(vehicle, mountId);
        if (!state || !mount.slavedTo) continue;
        const master = this.state(vehicle, mount.slavedTo);
        state.yaw = master.yaw; state.pitch = master.pitch;
      }
      if (seat.mounts.includes('main')) {
        const main = this.state(vehicle, 'main');
        vehicle.turretYaw = main.yaw; vehicle.turretPitch = main.pitch;
      }
      const trigger = !!(operator && input?.wantFire && this.system.canOperate(operator));
      for (const mountId of seat.mounts) { const state = this.state(vehicle, mountId); if (state) state.held = trigger; }
      if (!trigger) continue;
      const choice = this.selected(vehicle, seat.id);
      if (choice) this.fire(vehicle, seat, operator, choice.mount, choice.weapon);
    }
  }

  tickTimers(state, dt) {
    const weapon = VEHICLE_WEAPONS[state.weapon];
    // While the trigger stays held, carry at most one tick of credit so fast
    // guns keep their real cadence instead of rounding each shot up to a tick.
    state.cooldown = Math.max(state.held ? -dt : 0, state.cooldown - dt);
    if (state.overheated) {
      state.overheatT = Math.max(0, state.overheatT - dt);
      if (state.overheatT === 0) { state.overheated = false; state.heat = 0; }
    } else if (weapon.heatPerShot) state.heat = Math.max(0, state.heat - weapon.coolPerSecond * dt);
    if (state.reloadT > 0) {
      state.reloadT = Math.max(0, state.reloadT - dt);
      if (state.reloadT === 0 && Number.isFinite(weapon.magazine)) state.ammo = weapon.magazine;
    }
    if (state.rearm.length) {
      for (let i = 0; i < state.rearm.length; i++) state.rearm[i] -= dt;
      while (state.rearm.length && state.rearm[0] <= 0) { state.rearm.shift(); state.ammo = Math.min(weapon.magazine, state.ammo + 1); }
    }
  }

  /** The barrel between its pivot and muzzle must not pass through terrain. */
  obstructed(pose) {
    const solid = (x, y, z) => this.system.solid(x, y, z, true);
    const delta = pose.origin.map((n, i) => n - pose.pivot[i]), length = Math.hypot(...delta);
    if (solid(...pose.origin)) return true;
    return length > 0.05 && !!raycastVoxels(solid, ...pose.pivot, ...delta.map(n => n / length), length);
  }

  fire(vehicle, seat, operator, mountId, weaponKey) {
    const state = this.state(vehicle, mountId), weapon = VEHICLE_WEAPONS[weaponKey];
    if (!state || !weapon || state.weapon !== weaponKey || state.cooldown > 1e-9 || state.overheated || state.reloadT > 0
      || Number.isFinite(weapon.magazine) && state.ammo <= 0) return false;
    const mount = vehicleDef(vehicle).mounts[mountId];
    const pose = mountPose(vehicle, seat.id, mountId, { side: state.side });
    if (!pose || this.obstructed(pose)) return false;
    const engine = this.engine;
    let result = null, dir = pose.dir;
    if (weapon.kind === 'hitscan') {
      dir = spreadDirection(pose.dir, weapon.spreadDeg, state);
      result = fireMountedRay(operator, pose.origin, dir, weapon, this.system.combatContext(), { vehicleId: vehicle.id });
    } else {
      const targetId = weapon.key === 'aaMissile' ? this.system.locks.lockedTarget(operator, 'aaMissile') : null;
      result = engine.projectiles?.launchVehicleProjectile?.(operator,
        { weapon: weapon.key, origin: pose.origin, dir, vehicleId: vehicle.id, targetId }, this.system.projectileContext());
      if (!result) return false;
    }
    state.shots++;
    state.cooldown = weapon.cooldown + Math.min(0, state.cooldown);
    if (weapon.heatPerShot) {
      state.heat = Math.min(1, state.heat + weapon.heatPerShot);
      if (state.heat >= 1) { state.overheated = true; state.overheatT = weapon.overheatSeconds; }
    }
    if (Number.isFinite(weapon.magazine)) {
      state.ammo--;
      if (weapon.rearmSeconds) state.rearm.push(weapon.rearmSeconds);
      else if (state.ammo <= 0 && weapon.reloadSeconds) state.reloadT = weapon.reloadSeconds;
    }
    const side = mount.sides ? state.side : null;
    if (mount.sides) state.side = (state.side + 1) % mount.sides.length;
    operator.firing = true;
    operator.spawnProtectedUntil = 0;
    operator.spawnProtected = false;
    const tracer = weapon.kind === 'hitscan' ? (state.shots - 1) % 3 === 0 : false;
    engine.tickEvents?.push(evVehicleShoot(operator.id, pose.origin, dir, weapon.presentation, {
      vehicleId: vehicle.id, mount: mountId, vehicleWeapon: weapon.key, tracer, side,
      ...(weapon.kind === 'hitscan' && result ? { end: result.end, hit: result.hit } : {}),
    }));
    return true;
  }

  /** Snapshot rows: [yaw, pitch, ammo (-1 unlimited), heat100, reload100 (remaining)]. */
  rows(vehicle) {
    return (vehicle.mounts || []).map(state => {
      const weapon = VEHICLE_WEAPONS[state.weapon];
      let reload = 0;
      if (state.reloadT > 0) reload = state.reloadT / weapon.reloadSeconds;
      else if (state.rearm.length && state.ammo <= 0) reload = state.rearm[0] / weapon.rearmSeconds;
      else if (weapon.cooldown >= 1 && state.cooldown > 0) reload = state.cooldown / weapon.cooldown;
      return [round(state.yaw, 1000), round(state.pitch, 1000), state.ammo,
        state.overheated ? 100 : Math.round(clamp(state.heat, 0, 1) * 100), Math.round(clamp(reload, 0, 1) * 100)];
    });
  }
}
