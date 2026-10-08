// Per-seat vehicle cameras. Each seat's profile comes from shared/vehicle-defs.js
// (seat.camera: mode, distance, height, optic, views, eye):
//   chase    drivers and pilots: a wall-safe chase camera behind the look yaw
//            (ground) or the presented hull (aircraft); aircraft look at the
//            boresight point of their primary fixed mount, so the screen
//            centre is where the guns converge. The chase horizon stays level.
//   action   a closer, lower chase for drivers and pilots.
//   cockpit  first person from the seat's eye (VehicleView hides the own
//            head). Drivers and pilots look out along the hull and roll with
//            it; the jeep driver's mouse turns the head within limits, a
//            pilot's head turns with free look (C). Gunners and passengers
//            look along their aim. The tank driver's eye is at the turret
//            hatch and follows the gun aim. Aircraft keep the boresight.
//   flyby    aircraft only: a fixed point ahead of the flight path that the
//            aircraft zooms past, then a new point further on.
//   mount    exposed gunners (pintle, RWS, door guns): over the gun's shoulder.
//   gimbal   the attack helicopter's chin gunner: a stabilised sight at the chin.
//   passenger  an orbit around the seat hip with free look.
// V (vehicleView) cycles the seat's `views`; the choice is remembered per hull
// type and seat in localStorage (VEHICLE_VIEW_PREF_KEY).
// RMB optics zoom by the seat's `optic` factor (tank 3x through the gunner's
// sight, chin 4x, door guns 1.5x). Speed widens the FOV by up to 8 degrees.
// Hold C for free look: the camera orbits while the weapon keeps its aim.
import * as THREE from '../vendor/three.module.js';
import { vehicleDef, mountPose, vehicleDirection, vehicleLocalPoint, turretLocal } from '../../../shared/vehicle-defs.js';
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
  action: { distance: 0.62, height: 0.45, focus: 0.62 },  // action chase: share of the chase distance, height and focus height
  cockpitYaw: 2.5,        // head turn limit inside a cockpit (radians either side)
  cockpitPitch: [-0.9, 0.8],
  driverHeadYaw: 1.75,    // jeep driver: mouse head turn limit
  aimHeadYaw: 1.2,        // mouse-aim pilots: how far the head follows the aim
  aimHeadPitch: [-0.6, 0.7],
  aimOrbitLift: 0.14,     // mouse-aim chase: camera this far (rad) above the aim line
  eyeLift: 0.74,          // default eye above the seat hip
  eyeForward: 0.1,        // default eye ahead of the seat hip
  flyby: { lead: 2.4, minLead: 30, maxLead: 170, side: 7, lift: 2.5, maxAge: 7, pass: 22, minFov: 14 },
});

/** HUD names of the views (VEHICLE_VIEW_LABELS[view]; the first-person name depends on the seat). */
export const VEHICLE_VIEW_LABELS = Object.freeze({
  chase: 'CHASE', action: 'ACTION', cockpit: 'COCKPIT', flyby: 'FLYBY', mount: 'GUN', gimbal: 'SIGHT', passenger: 'ORBIT',
});
/** localStorage key: { [hullType]: { [seatId]: view } }. */
export const VEHICLE_VIEW_PREF_KEY = 'vb-vehicle-view-v1';

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
const AIRCRAFT = new Set(['rotor', 'fixedwing']);
const DEFAULT_PROFILE = Object.freeze({ mode: 'passenger', distance: 6, height: 2.2, optic: 1 });
const VIEW_IDS = new Set(Object.keys(VEHICLE_VIEW_LABELS));

/** Camera profile for one seat: mode, distance, height, RMB optic factor, V views and eye. */
export function seatCameraProfile(type, seatId) {
  const def = vehicleDef(type);
  const seat = def?.seats.find(entry => entry.id === seatId);
  const camera = seat?.camera || DEFAULT_PROFILE;
  const fallbackDistance = def ? Math.max(6, (def.collider?.halfLength ?? 3) * 2.6) : DEFAULT_PROFILE.distance;
  const mode = camera.mode || 'passenger';
  const aircraft = AIRCRAFT.has(def?.handling);
  // Views a hull can actually show: flyby is for aircraft, action for drivers.
  const views = (Array.isArray(camera.views) ? camera.views : [mode])
    .filter(view => VIEW_IDS.has(view) && (view !== 'flyby' || (aircraft && seat?.drives)) && (view !== 'action' || seat?.drives));
  if (!views.includes(mode)) views.unshift(mode);
  return Object.freeze({
    mode,
    distance: finite(camera.distance, fallbackDistance),
    height: finite(camera.height, DEFAULT_PROFILE.height),
    optic: Math.max(1, finite(camera.optic, 1)),
    views: Object.freeze([...new Set(views)]),
    eye: Object.freeze(Array.isArray(camera.eye) ? [...camera.eye] : seatEyeDefault(seat)),
    eyeFrame: camera.eyeFrame ?? (seat?.mount === 'turret' ? 'turret' : 'hull'),
  });
}

function seatEyeDefault(seat) {
  const hip = Array.isArray(seat?.position) ? seat.position : [0, 1, 0];
  return [hip[0], hip[1] + VEHICLE_CAMERA.eyeLift, hip[2] - VEHICLE_CAMERA.eyeForward];
}

/** The V-key views of a seat, default first. */
export const seatViews = (type, seatId) => seatCameraProfile(type, seatId).views;

/** HUD name of one view for a seat ("COCKPIT", "HATCH", "FIRST PERSON", ...). */
export function vehicleViewLabel(type, seatId, view) {
  if (view !== 'cockpit') return VEHICLE_VIEW_LABELS[view] ?? String(view || '').toUpperCase();
  const def = vehicleDef(type), seat = def?.seats.find(entry => entry.id === seatId);
  if (AIRCRAFT.has(def?.handling) && seat?.drives) return 'COCKPIT';
  if (def?.type === 'tank' && seat?.drives) return 'HATCH';
  return 'FIRST PERSON';
}

/**
 * First-person look of a seat in the cockpit view: 'hull' (the head rides the
 * hull attitude: jeep driver and pilots) or 'aim' (the view follows the seat's
 * world aim: the tank hatch, gunners and passengers).
 */
export function cockpitLook(type, seatId) {
  const def = vehicleDef(type), seat = def?.seats.find(entry => entry.id === seatId);
  if (!seat?.drives) return 'aim';
  return AIRCRAFT.has(def.handling) || def.handling === 'wheeled' ? 'hull' : 'aim';
}

/** World eye point of a seat's first-person view on a (presented) hull row. */
export function seatEyeWorld(row, seatId) {
  const profile = seatCameraProfile(row?.type ?? row?.kind, seatId);
  if (profile.eyeFrame === 'mount') {
    // Behind the seat's gun, turning with it about the mount pivot.
    const mountId = vehicleDef(row)?.seats.find(entry => entry.id === seatId)?.mounts?.[0];
    const pose = mountId ? mountPose(row, seatId, mountId) : null;
    if (pose) {
      const yaw = Math.atan2(-pose.dir[0], -pose.dir[2]), c = Math.cos(yaw), s = Math.sin(yaw);
      const [right, up, back] = profile.eye;
      return [pose.pivot[0] + right * c + back * s, pose.pivot[1] + up, pose.pivot[2] - right * s + back * c];
    }
  }
  const local = profile.eyeFrame === 'turret' && Number.isFinite(row?.turretYaw) ? turretLocal(row, profile.eye) : profile.eye;
  return vehicleLocalPoint(row, local[0], local[1], local[2]);
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

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch (_) { return null; }
}

export class VehicleCamera {
  constructor({ camera, raycast = null, shake = null, getBaseFov = null, storage = undefined } = {}) {
    this.camera = camera;
    this.raycast = typeof raycast === 'function' ? raycast : () => null;
    this.shake = shake;
    this.getBaseFov = typeof getBaseFov === 'function' ? getBaseFov : null;
    this.storage = storage === undefined ? defaultStorage() : storage;
    this.baseFov = camera?.fov ?? 70;
    this.seated = false;
    this._seeded = false;
    this._distance = 0;
    this._yaw = 0; this._pitch = 0;
    this._freeYaw = 0; this._freePitch = 0;
    this.mode = null;
    /** Selected view of the current seat (one of its profile views). */
    this.view = null;
    this.viewChangedAt = -Infinity;
    this._viewKey = null;
    this._type = null; this._seatId = null;
    this._fly = null;
    this.zoom = 1;
    this._focus = new THREE.Vector3();
    this._direction = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._eye = new THREE.Vector3();
    this._vector = new THREE.Vector3();
    this._quaternion = new THREE.Quaternion();
    this._head = new THREE.Quaternion();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._forward = new THREE.Vector3();
  }

  /** Start a new seat: capture the base FOV and drop smoothing state. */
  begin() {
    if (!this.seated) this.baseFov = this.getBaseFov?.() ?? this.camera?.fov ?? this.baseFov;
    this.seated = true;
    this._seeded = false;
    this._freeYaw = 0; this._freePitch = 0;
    this._fly = null;
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
    this.view = null;
    this._viewKey = null;
    this._type = this._seatId = null;
    this._fly = null;
    this.zoom = 1;
  }

  /** Free-look offsets (radians, camera only). */
  addFreeLook(dx, dy) {
    this._freeYaw = wrap(this._freeYaw - finite(dx));
    this._freePitch = clamp(this._freePitch - finite(dy), VEHICLE_CAMERA.freeLookPitch[0], VEHICLE_CAMERA.freeLookPitch[1]);
  }

  // ---------------------------------------------------------------- views

  _readPrefs() {
    try {
      const parsed = JSON.parse(this.storage?.getItem?.(VEHICLE_VIEW_PREF_KEY) ?? 'null');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) { return {}; }
  }

  _writePref(type, seatId, view) {
    if (!this.storage) return;
    try {
      const prefs = this._readPrefs();
      const seats = prefs[type] && typeof prefs[type] === 'object' && !Array.isArray(prefs[type]) ? prefs[type] : {};
      prefs[type] = { ...seats, [seatId]: view };
      this.storage.setItem(VEHICLE_VIEW_PREF_KEY, JSON.stringify(prefs));
    } catch (_) {}
  }

  /** The remembered (or default) view of a seat. */
  storedView(type, seatId) {
    const views = seatViews(type, seatId);
    const saved = this._readPrefs()[type]?.[seatId];
    return views.includes(saved) ? saved : views[0];
  }

  _syncView(type, seatId) {
    const key = `${type}:${seatId}`;
    if (key === this._viewKey && this.view) return;
    this._viewKey = key;
    this._type = type; this._seatId = seatId;
    this.view = this.storedView(type, seatId);
    this._fly = null;
  }

  /** Select a view of the seat (ignored when the seat has no such view). Returns the view. */
  setView(type, seatId, view, { remember = true, nowMs = null } = {}) {
    const views = seatViews(type, seatId);
    if (!views.includes(view)) return this.view;
    this._viewKey = `${type}:${seatId}`;
    this._type = type; this._seatId = seatId;
    if (view !== this.view) {
      this.view = view;
      this._seeded = false;
      this._fly = null;
      this._freeYaw = this._freePitch = 0;
    }
    this.viewChangedAt = Number.isFinite(nowMs) ? nowMs : (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (remember) this._writePref(type, seatId, view);
    return this.view;
  }

  /** V: the seat's next view (remembered per hull type and seat). */
  cycleView(type, seatId, options = {}) {
    const views = seatViews(type, seatId);
    if (views.length < 2) return this.view ?? views[0] ?? null;
    const current = `${type}:${seatId}` === this._viewKey && this.view ? this.view : this.storedView(type, seatId);
    const index = views.indexOf(current);
    return this.setView(type, seatId, views[(index + 1) % views.length], options);
  }

  /** True while the view is first person from the seat's eye. */
  get firstPerson() { return this.seated && this.view === 'cockpit'; }

  /**
   * True when a ground driver's look rides the hull (jeep cockpit): the
   * controller then carries its look yaw with the hull's turn.
   */
  get hullLook() {
    if (!this.firstPerson || !this._type) return false;
    return cockpitLook(this._type, this._seatId) === 'hull' && !AIRCRAFT.has(vehicleDef(this._type)?.handling);
  }

  /** HUD read model: { view, label, views: [{ id, label }], changedAt }. */
  viewState() {
    if (!this.seated || !this._type) return null;
    const views = seatViews(this._type, this._seatId);
    return { type: this._type, seatId: this._seatId, view: this.view, label: vehicleViewLabel(this._type, this._seatId, this.view),
      views: views.map(id => ({ id, label: vehicleViewLabel(this._type, this._seatId, id) })), changedAt: this.viewChangedAt };
  }

  // ---------------------------------------------------------------- pose

  /**
   * Pose the camera. state: { row (presented hull), seatId, aimYaw, aimPitch,
   * freeLook (bool held), optic (bool held), flightAim ({ yaw, pitch } world
   * aim of a mouse-aim pilot, or null) }.
   */
  update(dt, { row, seatId, aimYaw = 0, aimPitch = 0, freeLook = false, optic = false, flightAim = null } = {}) {
    const camera = this.camera;
    if (!camera || !row) return false;
    if (!this.seated) this.begin();
    const step = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    const type = row.type ?? row.kind, def = vehicleDef(type);
    const profile = seatCameraProfile(type, seatId);
    const aircraft = AIRCRAFT.has(def?.handling);
    const seat = def?.seats.find(entry => entry.id === seatId);
    this._syncView(type, seatId);
    const view = this.view;
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
    const gimbalSight = mode === 'gimbal' && (view === 'gimbal' || optic);
    if (gimbalSight || (mode === 'chase' && !aircraft && optic && profile.optic > 1 && seat?.mounts?.length)) {
      // First-person sight at the mount (chin gimbal, tank gunner's sight).
      this.mode = gimbalSight ? 'gimbal' : view;
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
    this.mode = view;
    if (view === 'cockpit') return this._cockpit(step, { row, seatId, aircraft, aimYaw, aimPitch, flightAim, freeLook });
    if (view === 'flyby' && aircraft) return this._flyby(step, { row, def, wide });

    const action = view === 'action';
    let focus, lookYaw, lookPitch, distance = profile.distance, height = profile.height, aimLook = false;
    if (action) { distance *= VEHICLE_CAMERA.action.distance; height *= VEHICLE_CAMERA.action.height; }
    const focusHeight = action ? finite(def?.height, 2.25) * VEHICLE_CAMERA.action.focus : finite(def?.height, 2.25);
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
      const look = this.aircraftChaseLook(step, row, { flightAim });
      aimLook = look.aim === true;
      focus = this._focus.set(finite(row.x), finite(row.y) + focusHeight + 0.3, finite(row.z));
      lookYaw = wrap(look.yaw + this._freeYaw);
      lookPitch = aimLook ? clamp(look.pitch + this._freePitch, -1.35, 1.35) : clamp(look.pitch + this._freePitch, -0.6, 0.5);
    } else {
      // Ground drivers orbit behind their look (the tank's gun aim).
      focus = this._focus.set(finite(row.x), finite(row.y) + focusHeight + 0.3, finite(row.z));
      lookYaw = wrap(aimYaw + this._freeYaw);
      lookPitch = clamp(aimPitch + this._freePitch, -0.35, 0.65);
    }

    // Orbit: behind the look direction, a little above, wall safe.
    // A mouse-aim pilot's orbit sits on the aim line, a little above it, so
    // the screen centre is the aim and the hull rides just below it.
    const orbitPitch = aimLook ? clamp(lookPitch - VEHICLE_CAMERA.aimOrbitLift + (action ? 0.05 : 0), -1.3, 1.3)
      : clamp(-0.18 - lookPitch * 0.35, -0.6, -0.05) - (height > 0 ? Math.atan2(height, distance) * 0.25 : 0)
      + (action ? 0.08 : 0);
    this._direction.set(Math.sin(lookYaw) * Math.cos(orbitPitch), -Math.sin(orbitPitch), Math.cos(lookYaw) * Math.cos(orbitPitch));
    let reach = distance;
    const hit = this.raycast(focus, this._direction, distance);
    if (Number.isFinite(hit?.t)) reach = clamp(hit.t - VEHICLE_CAMERA.clearance, 0, distance);
    if (!this._seeded || reach < this._distance) this._distance = reach;
    else this._distance += (reach - this._distance) * (1 - Math.exp(-step * 8));
    this._seeded = true;
    camera.position.copy(focus).addScaledVector(this._direction, this._distance);
    camera.up.set(0, 1, 0);
    const bore = aircraft && seat?.drives && !freeLook && !aimLook ? aircraftBoresight(row) : null;
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

  /**
   * Chase look of a pilot (chase and action views): yaw and pitch the orbit
   * sits behind. Follows the presented hull with a small lag and a level
   * horizon. `flightAim` is the mouse-aim pilot's world aim (or null).
   */
  aircraftChaseLook(step, row, { flightAim = null } = {}) {
    const hullYaw = wrap(finite(row.yaw)), hullPitch = finite(row.pitch);
    if (!this._seeded) { this._yaw = hullYaw; this._pitch = hullPitch; }
    else {
      const follow = 1 - Math.exp(-step * VEHICLE_CAMERA.follow);
      this._yaw = wrap(this._yaw + wrap(hullYaw - this._yaw) * follow);
      this._pitch += (hullPitch - this._pitch) * follow;
    }
    // Mouse aim: the camera looks along the pilot's free aim with no hull lag
    // (the hull follow above keeps running so leaving aim mode is smooth).
    if (flightAim && Number.isFinite(flightAim.yaw) && Number.isFinite(flightAim.pitch)) {
      return { yaw: wrap(flightAim.yaw), pitch: flightAim.pitch, aim: true };
    }
    return { yaw: this._yaw, pitch: -0.12 + this._pitch * 0.45 };
  }

  /** First person from the seat's eye. */
  _cockpit(step, { row, seatId, aircraft, aimYaw, aimPitch, flightAim, freeLook }) {
    const camera = this.camera, type = row.type ?? row.kind;
    const eye = seatEyeWorld(row, seatId);
    camera.position.set(eye[0], eye[1], eye[2]);
    camera.up.set(0, 1, 0);
    this._seeded = true;
    if (cockpitLook(type, seatId) === 'aim') {
      const yaw = wrap(aimYaw + this._freeYaw), pitch = clamp(aimPitch + this._freePitch, -1.4, 1.4);
      camera.rotation.set(pitch, yaw, 0, 'YXZ');
      return this._finish(step);
    }
    // The head rides the hull attitude, roll included.
    const hull = this._quaternion.setFromEuler(this._euler.set(finite(row.pitch), finite(row.yaw), finite(row.roll), 'YXZ'));
    let headYaw = this._freeYaw, headPitch = this._freePitch;
    if (aircraft) {
      const bore = !freeLook ? aircraftBoresight(row) : null;
      if (bore) {
        // Keep the screen centre on the guns' convergence point from the eye.
        const range = VEHICLE_CAMERA.boresightRange;
        this._target.set(bore.origin[0] + bore.dir[0] * range - eye[0], bore.origin[1] + bore.dir[1] * range - eye[1],
          bore.origin[2] + bore.dir[2] * range - eye[2]).normalize();
        this._forward.set(0, 0, -1).applyQuaternion(hull);
        hull.premultiply(this._head.setFromUnitVectors(this._forward, this._target));
      }
      const aim = flightAim && Number.isFinite(flightAim.yaw) && Number.isFinite(flightAim.pitch) ? flightAim : null;
      if (aim && !freeLook) {
        // A mouse-aim pilot's head turns toward the aim point, within limits.
        const dir = vehicleDirection(aim.yaw, aim.pitch);
        const local = this._vector.set(dir[0], dir[1], dir[2]).applyQuaternion(this._head.copy(hull).invert());
        headYaw += clamp(Math.atan2(-local.x, -local.z), -VEHICLE_CAMERA.aimHeadYaw, VEHICLE_CAMERA.aimHeadYaw);
        headPitch += clamp(Math.atan2(local.y, Math.hypot(local.x, local.z)), VEHICLE_CAMERA.aimHeadPitch[0], VEHICLE_CAMERA.aimHeadPitch[1]);
      }
    } else {
      // Jeep driver: the mouse turns the head relative to the hull.
      headYaw += clamp(wrap(finite(aimYaw) - finite(row.yaw)), -VEHICLE_CAMERA.driverHeadYaw, VEHICLE_CAMERA.driverHeadYaw);
      headPitch += finite(aimPitch);
    }
    headYaw = clamp(headYaw, -VEHICLE_CAMERA.cockpitYaw, VEHICLE_CAMERA.cockpitYaw);
    headPitch = clamp(headPitch, VEHICLE_CAMERA.cockpitPitch[0], VEHICLE_CAMERA.cockpitPitch[1]);
    camera.quaternion.copy(hull).multiply(this._head.setFromEuler(this._euler.set(headPitch, headYaw, 0, 'YXZ')));
    return this._finish(step);
  }

  /**
   * Fly-by: a fixed point ahead of and beside the flight path. The camera
   * holds it and tracks the aircraft until it has passed and pulled away,
   * then jumps to a new point further on.
   */
  _flyby(step, { row, def, wide }) {
    const camera = this.camera, tune = VEHICLE_CAMERA.flyby;
    const target = this._target.set(finite(row.x), finite(row.y) + finite(def?.height, 2) * 0.5, finite(row.z));
    const velocity = this._vector.set(finite(row.vx), finite(row.vy), finite(row.vz));
    let speed = velocity.length();
    if (speed < 6) {
      // Hovering or rows without velocity: lead along the nose.
      const nose = vehicleDirection(finite(row.yaw), finite(row.pitch));
      velocity.set(nose[0], nose[1], nose[2]).multiplyScalar(Math.max(speed, 12));
      speed = velocity.length();
    }
    const fly = this._fly;
    if (fly) fly.age += step;
    const distance = fly ? fly.point.distanceTo(target) : Infinity;
    const passed = fly && this._forward.copy(target).sub(fly.point).dot(velocity) > 0 && distance > tune.pass;
    if (!fly || passed || fly.age > tune.maxAge || distance > tune.maxLead * 1.6) {
      const lead = clamp(speed * tune.lead, tune.minLead, tune.maxLead);
      const forward = this._forward.copy(velocity).normalize();
      const side = this._direction.set(-forward.z, 0, forward.x);
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
      side.normalize();
      const flip = fly ? -fly.side : 1;
      const point = new THREE.Vector3().copy(target).addScaledVector(forward, lead)
        .addScaledVector(side, flip * (tune.side + lead * 0.05)).add(this._eye.set(0, tune.lift + lead * 0.03, 0));
      // Keep a clear line of sight from the aircraft to the point.
      const to = this._eye.copy(point).sub(target);
      const length = to.length();
      const hit = length > 1e-3 ? this.raycast(target, to.divideScalar(length), length) : null;
      if (Number.isFinite(hit?.t)) point.copy(target).addScaledVector(to, Math.max(2, hit.t - 1.5));
      this._fly = { point, age: 0, side: flip };
    }
    camera.position.copy(this._fly.point);
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    // Zoom so the airframe keeps a readable size as it closes and leaves.
    const span = Math.max(4, finite(def?.collider?.halfLength, 4) * 3.2);
    const range = Math.max(1, camera.position.distanceTo(target));
    camera.fov = clamp(2 * Math.atan2(span, range) * 180 / Math.PI, tune.minFov, wide);
    this.zoom = 1;
    this._seeded = true;
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
