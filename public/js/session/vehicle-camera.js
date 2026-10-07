// Per-seat vehicle cameras. Each seat's profile comes from shared/vehicle-defs.js
// (seat.camera: mode, distance, height, optic):
//   chase    drivers and pilots: a wall-safe chase camera behind the look yaw
//            (ground) or the presented hull (aircraft); aircraft look at the
//            boresight point of their primary fixed mount, so the screen
//            centre is where the guns converge.
//   mount    exposed gunners (pintle, RWS, door guns): over the gun's shoulder.
//   gimbal   the attack helicopter's chin gunner: a stabilised sight at the chin.
//   passenger  an orbit around the seat hip with free look.
// RMB optics zoom by the seat's `optic` factor (tank 3x through the gunner's
// sight, chin 4x, door guns 1.5x). Speed widens the FOV by up to 8 degrees.
// Hold C for free look: the camera orbits while the weapon keeps its aim.
import * as THREE from '../vendor/three.module.js';
import { vehicleDef, mountPose, vehicleDirection } from '../../../shared/vehicle-defs.js';
import { vehicleSeatPose } from '../../../shared/vehicles.js';

/** Camera tuning (presentation only). */
export const VEHICLE_CAMERA = Object.freeze({
  speedFov: 8,            // degrees added at top speed
  fovRate: 6,             // speed-FOV easing per second
  opticRate: 22,          // optic zoom easing per second (~0.15 s)
  follow: 8,              // aircraft hull follow rate
  freeLookReturn: 6,      // free-look spring back rate
  freeLookPitch: [-0.9, 0.7],
  boresightRange: 160,    // aircraft aim point distance
  clearance: 0.3,
});

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
const AIRCRAFT = new Set(['rotor', 'fixedwing']);
const DEFAULT_PROFILE = Object.freeze({ mode: 'passenger', distance: 6, height: 2.2, optic: 1 });

/** Camera profile for one seat: mode, distance, height and RMB optic factor. */
export function seatCameraProfile(type, seatId) {
  const def = vehicleDef(type);
  const seat = def?.seats.find(entry => entry.id === seatId);
  const camera = seat?.camera || DEFAULT_PROFILE;
  const fallbackDistance = def ? Math.max(6, (def.collider?.halfLength ?? 3) * 2.6) : DEFAULT_PROFILE.distance;
  return Object.freeze({
    mode: camera.mode || 'passenger',
    distance: finite(camera.distance, fallbackDistance),
    height: finite(camera.height, DEFAULT_PROFILE.height),
    optic: Math.max(1, finite(camera.optic, 1)),
  });
}

/** Top speed of a hull (m/s) for the speed FOV. */
const topSpeed = type => {
  const rules = vehicleDef(type)?.rules;
  return Math.max(1, finite(rules?.maxSpeed, finite(rules?.speed, 20)));
};

/**
 * Boresight of an aircraft's primary fixed mount (pods converge at their
 * convergence distance, the jet nose gun fires along the hull): world
 * { origin, dir } from the presented row, or null.
 */
export function aircraftBoresight(row) {
  const def = vehicleDef(row);
  if (!def || !AIRCRAFT.has(def.handling)) return null;
  const key = def.mountOrder.find(entry => def.mounts[entry.split(':')[1]]?.fixed);
  if (!key) return null;
  const [seatId, mountId] = key.split(':');
  const mount = def.mounts[mountId];
  if (mount.sides?.length > 1) {
    // Converging pods: aim at the midpoint of both sides' convergence point.
    const left = mountPose(row, seatId, mountId, { side: 0 }), right = mountPose(row, seatId, mountId, { side: 1 });
    if (!left || !right) return null;
    const origin = left.origin.map((value, i) => (value + right.origin[i]) / 2);
    const dir = left.dir.map((value, i) => value + right.dir[i]);
    const length = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    return { origin, dir: dir.map(value => value / length) };
  }
  const pose = mountPose(row, seatId, mountId);
  return pose && { origin: pose.origin, dir: pose.dir };
}

export class VehicleCamera {
  constructor({ camera, raycast = null, shake = null, getBaseFov = null } = {}) {
    this.camera = camera;
    this.raycast = typeof raycast === 'function' ? raycast : () => null;
    this.shake = shake;
    this.getBaseFov = typeof getBaseFov === 'function' ? getBaseFov : null;
    this.baseFov = camera?.fov ?? 70;
    this.seated = false;
    this._seeded = false;
    this._distance = 0;
    this._yaw = 0; this._pitch = 0;
    this._freeYaw = 0; this._freePitch = 0;
    this.mode = null;
    this.zoom = 1;
    this._focus = new THREE.Vector3();
    this._direction = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._eye = new THREE.Vector3();
  }

  /** Start a new seat: capture the base FOV and drop smoothing state. */
  begin() {
    if (!this.seated) this.baseFov = this.getBaseFov?.() ?? this.camera?.fov ?? this.baseFov;
    this.seated = true;
    this._seeded = false;
    this._freeYaw = 0; this._freePitch = 0;
  }

  /** Leaving the vehicle restores the infantry FOV. */
  end() {
    if (!this.seated) return;
    this.seated = false;
    this._seeded = false;
    if (this.camera) {
      this.camera.fov = this.getBaseFov?.() ?? this.baseFov;
      this.camera.updateProjectionMatrix?.();
    }
    this.mode = null;
    this.zoom = 1;
  }

  /** Free-look offsets (radians, camera only). */
  addFreeLook(dx, dy) {
    this._freeYaw = wrap(this._freeYaw - finite(dx));
    this._freePitch = clamp(this._freePitch - finite(dy), VEHICLE_CAMERA.freeLookPitch[0], VEHICLE_CAMERA.freeLookPitch[1]);
  }

  /**
   * Pose the camera. state: { row (presented hull), seatId, aimYaw, aimPitch,
   * freeLook (bool held), optic (bool held) }.
   */
  update(dt, { row, seatId, aimYaw = 0, aimPitch = 0, freeLook = false, optic = false } = {}) {
    const camera = this.camera;
    if (!camera || !row) return false;
    if (!this.seated) this.begin();
    const step = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    const type = row.type ?? row.kind, def = vehicleDef(type);
    const profile = seatCameraProfile(type, seatId);
    const aircraft = AIRCRAFT.has(def?.handling);
    const seat = def?.seats.find(entry => entry.id === seatId);
    const opticFactor = optic ? profile.optic : 1;
    if (!freeLook) {
      const k = 1 - Math.exp(-step * VEHICLE_CAMERA.freeLookReturn);
      this._freeYaw -= this._freeYaw * k; this._freePitch -= this._freePitch * k;
    }

    // Speed FOV, then the optic divides it.
    const speed = Math.abs(finite(row.speed, Math.hypot(finite(row.vx), finite(row.vy), finite(row.vz))));
    const base = this.getBaseFov?.() ?? this.baseFov;
    const wide = base + VEHICLE_CAMERA.speedFov * clamp(speed / topSpeed(type), 0, 1);
    const targetFov = wide / opticFactor;
    // Optics snap in and out quickly; the speed FOV breathes slowly.
    const zooming = opticFactor > 1 || camera.fov < wide * 0.85;
    const rate = zooming ? VEHICLE_CAMERA.opticRate : VEHICLE_CAMERA.fovRate;
    camera.fov = this._seeded ? camera.fov + (targetFov - camera.fov) * (1 - Math.exp(-step * rate)) : targetFov;
    this.zoom = wide / Math.max(1e-3, camera.fov);

    const mode = profile.mode;
    this.mode = mode;
    if (mode === 'gimbal' || (mode === 'chase' && !aircraft && optic && profile.optic > 1 && seat?.mounts?.length)) {
      // First-person sight at the mount (chin gimbal, tank gunner's sight).
      const mountId = seat?.mounts?.[0];
      const pose = mountId ? mountPose(row, seatId, mountId) : null;
      const origin = pose?.pivot || [finite(row.x), finite(row.y) + finite(def?.height, 2), finite(row.z)];
      const yaw = wrap(aimYaw + this._freeYaw), pitch = clamp(aimPitch + this._freePitch, -1.5, 1.5);
      const dir = vehicleDirection(yaw, pitch);
      // Sit just behind the muzzle so the barrel never fills the sight.
      camera.position.set(origin[0] + dir[0] * 0.6, origin[1] + dir[1] * 0.6 + 0.15, origin[2] + dir[2] * 0.6);
      camera.up.set(0, 1, 0);
      camera.rotation.set(pitch, yaw, 0, 'YXZ');
      this._seeded = true;
      return this._finish(step);
    }

    let focus, lookYaw, lookPitch, distance = profile.distance, height = profile.height;
    if (mode === 'mount' && seat?.mounts?.length) {
      const pose = mountPose(row, seatId, seat.mounts[0]);
      const pivot = pose?.pivot || [finite(row.x), finite(row.y) + 2, finite(row.z)];
      focus = this._focus.set(pivot[0], pivot[1] + height * 0.5, pivot[2]);
      lookYaw = wrap(aimYaw + this._freeYaw);
      lookPitch = clamp(aimPitch + this._freePitch, -0.8, 0.7);
      height = 0;
    } else if (mode === 'passenger' || !seat?.drives) {
      const hip = vehicleSeatPose(row, seatId) || { x: row.x, y: row.y + 1, z: row.z };
      focus = this._focus.set(finite(hip.x), finite(hip.y) + 1.2, finite(hip.z));
      lookYaw = wrap(aimYaw + this._freeYaw);
      lookPitch = clamp(aimPitch + this._freePitch, -0.9, 0.7);
      height = 0;
    } else if (aircraft) {
      // Follow the presented hull with a small lag and a level horizon.
      const hullYaw = wrap(finite(row.yaw)), hullPitch = finite(row.pitch);
      if (!this._seeded) { this._yaw = hullYaw; this._pitch = hullPitch; }
      else {
        const follow = 1 - Math.exp(-step * VEHICLE_CAMERA.follow);
        this._yaw = wrap(this._yaw + wrap(hullYaw - this._yaw) * follow);
        this._pitch += (hullPitch - this._pitch) * follow;
      }
      focus = this._focus.set(finite(row.x), finite(row.y) + finite(def?.height, 2.25) + 0.3, finite(row.z));
      lookYaw = wrap(this._yaw + this._freeYaw);
      lookPitch = clamp(-0.12 + this._pitch * 0.45 + this._freePitch, -0.6, 0.5);
    } else {
      // Ground drivers orbit behind their look (the tank's gun aim).
      focus = this._focus.set(finite(row.x), finite(row.y) + finite(def?.height, 2.25) + 0.3, finite(row.z));
      lookYaw = wrap(aimYaw + this._freeYaw);
      lookPitch = clamp(aimPitch + this._freePitch, -0.35, 0.65);
    }

    // Orbit: behind the look direction, a little above, wall safe.
    const orbitPitch = clamp(-0.18 - lookPitch * 0.35, -0.6, -0.05) - (height > 0 ? Math.atan2(height, distance) * 0.25 : 0);
    this._direction.set(Math.sin(lookYaw) * Math.cos(orbitPitch), -Math.sin(orbitPitch), Math.cos(lookYaw) * Math.cos(orbitPitch));
    let reach = distance;
    const hit = this.raycast(focus, this._direction, distance);
    if (Number.isFinite(hit?.t)) reach = clamp(hit.t - VEHICLE_CAMERA.clearance, 0, distance);
    if (!this._seeded || reach < this._distance) this._distance = reach;
    else this._distance += (reach - this._distance) * (1 - Math.exp(-step * 8));
    this._seeded = true;
    camera.position.copy(focus).addScaledVector(this._direction, this._distance);
    camera.up.set(0, 1, 0);
    const bore = aircraft && seat?.drives && !freeLook ? aircraftBoresight(row) : null;
    if (bore) {
      // The crosshair sits on the guns' convergence point.
      this._target.set(bore.origin[0] + bore.dir[0] * VEHICLE_CAMERA.boresightRange,
        bore.origin[1] + bore.dir[1] * VEHICLE_CAMERA.boresightRange, bore.origin[2] + bore.dir[2] * VEHICLE_CAMERA.boresightRange);
      const to = this._eye.copy(this._target).sub(camera.position);
      const yaw = Math.atan2(-to.x, -to.z), pitch = Math.atan2(to.y, Math.hypot(to.x, to.z));
      camera.rotation.set(clamp(pitch, -1.2, 1.2), yaw, 0, 'YXZ');
    } else {
      camera.rotation.set(lookPitch, lookYaw, 0, 'YXZ');
    }
    return this._finish(step);
  }

  _finish(step) {
    this.camera.updateProjectionMatrix?.();
    this.camera.updateMatrixWorld?.();
    this.shake?.apply(this.camera, step);
    return true;
  }

  /** The rendered camera focus (chase pivot) for tests and the HUD. */
  get focus() { return this._focus; }
}
