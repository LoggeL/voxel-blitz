import { CONQUEST_RULES, COUNTERMEASURES, seatWeaponList, vehicleMountOrder } from '../../../shared/conquest-contract.js';
import { vehicleEnterDistance } from '../../../shared/vehicles.js';
import { vehicleSeats, vehicleSeatDefinition, vehicleSeatOccupantId, vehicleHasFreeSeat } from '../../../shared/vehicle-seats.js';
import { isBotId } from '../../../shared/conquest.js';
import { isTypingTarget, matchesBinding } from '../keybindings.js';
import { VehicleCamera } from './vehicle-camera.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
const AIRCRAFT = new Set(['helicopter', 'transport', 'plane']);
const aircraft = type => AIRCRAFT.has(type);
const ROTORCRAFT = new Set(['helicopter', 'transport']);
// Look deltas arrive in radians per frame. Treat pointer motion as a spring-
// centred flight stick, preserving device sensitivity without accumulating aim.
const FLIGHT_LOOK_RATE = 2;
const FLIGHT_DEADZONE = 0.015;
const flightAxis = value => {
  const axis = clamp(finite(value), -1, 1), magnitude = Math.abs(axis);
  return magnitude <= FLIGHT_DEADZONE ? 0 : Math.sign(axis) * (magnitude - FLIGHT_DEADZONE) / (1 - FLIGHT_DEADZONE);
};

/**
 * Battlefield-style mouse flight (the desktop default). Mouse motion deflects a
 * virtual stick that springs back to centre: steady motion of `rate` rad/s of
 * look (at flight sensitivity 1) holds full deflection, and the stick relaxes
 * with a 1/`spring` s time constant once the mouse stops. The stick is a rate
 * command, so the total attitude change follows mouse travel. Jet: Y pitch,
 * X roll. Helicopters: Y pitch, X yaw.
 */
export const MOUSE_FLIGHT = Object.freeze({ rate: FLIGHT_LOOK_RATE, spring: 8 });
/** Longest frame a look delta is converted over (main.js caps frame time at 0.25 s). */
const LOOK_STEP_MAX = 0.25;
const DEFAULT_FLIGHT_OPTIONS = Object.freeze({ mouse: false, sensitivity: 1, invertY: false });

/**
 * Advance a mouse-flight stick `{x, y}` (x: right, y: nose up, each -1..1) by one
 * frame of pointer motion in look radians (Input.consumeDelta's mouseDx/mouseDy).
 * Exact first-order spring over the frame, so a steady mouse speed gives the same
 * deflection at any frame rate. Mutates and returns `stick`.
 */
export function stepMouseFlightStick(stick, { dx = 0, dy = 0 } = {}, dt = 1 / 60, options = DEFAULT_FLIGHT_OPTIONS) {
  // dt must be the real frame time the pointer delta covers (main.js passes
  // its 0.25 s-capped frame time); a shorter step would scale the gain up.
  const step = clamp(Number.isFinite(dt) && dt > 0 ? dt : 1 / 60, 1 / 240, LOOK_STEP_MAX);
  const gain = clamp(finite(options?.sensitivity, 1), 0.05, 10) / (MOUSE_FLIGHT.rate * step);
  const decay = Math.exp(-MOUSE_FLIGHT.spring * step);
  const invert = options?.invertY ? -1 : 1;
  // Pointer down (dy > 0) is look down, so it lowers the nose unless inverted.
  const targetX = clamp(finite(dx) * gain, -1e3, 1e3), targetY = clamp(-finite(dy) * gain * invert, -1e3, 1e3);
  stick.x = clamp(targetX + (finite(stick.x) - targetX) * decay, -1, 1);
  stick.y = clamp(targetY + (finite(stick.y) - targetY) * decay, -1, 1);
  return stick;
}
/** F1..F5 pick seats in topology order (not rebindable: F keys are not bindable codes). */
export const SEAT_KEYS = Object.freeze(['F1', 'F2', 'F3', 'F4', 'F5']);
/** Enter/exit is a tap: releasing T before this starts a support hold instead (repair). */
export const INTERACT_TAP_MS = CONQUEST_RULES.repairHoldStartMs;
const MAX_QUEUED_ACTIONS = 4;
/** A seat a human may ask for: free, or held by a bot (the server puts the bot out or swaps it). */
const seatTakeable = (row, seatId) => { const occupant = vehicleSeatOccupantId(row, seatId); return occupant == null || isBotId(occupant); };
const hullTakeable = row => vehicleHasFreeSeat(row) || vehicleSeats(row.type ?? row.kind).some(seat => isBotId(vehicleSeatOccupantId(row, seat.id)));
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Authoritative seating, device-independent vehicle commands and the per-seat
 * camera. Seats, mounts and weapons come from the shared topology; every
 * action is a request the server validates (enter, exit, seat, cm, weapon).
 */
export class VehicleController {
  constructor({ camera, raycast, eventTarget = typeof window !== 'undefined' ? window : null, onPresent = () => {},
    cameraShake = null, getBaseFov = null, now = nowMs } = {}) {
    this.camera = camera; this.raycast = raycast || (() => null); this.eventTarget = eventTarget;
    this.onPresent = onPresent; this.enabled = false; this.self = null; this.rows = [];
    this.vehicle = null; this.seat = null; this.nearest = null; this._actions = [];
    this.yaw = 0; this.pitch = -0.2; this._seeded = false;
    this.now = now;
    this.view = new VehicleCamera({ camera, raycast: (origin, direction, distance) => this.raycast(origin, direction, distance),
      shake: cameraShake, getBaseFov });
    this.freeLook = false;
    this.flight = DEFAULT_FLIGHT_OPTIONS;
    this._flightSource = DEFAULT_FLIGHT_OPTIONS;
    this._stick = { x: 0, y: 0 };
    this.opticHeld = false;
    this._opticListeners = new Set();
    this._interactDownAt = null;
    this._padInteractAt = null;
    this._key = event => this._keyDown(event);
    this._keyUp = event => this._keyRelease(event);
    this._mouseDown = event => { if (event.button === 2) this._setOptic(true); };
    this._mouseUp = event => { if (event.button === 2) this._setOptic(false); };
    this._blur = () => { this.freeLook = false; this._setOptic(false); this._interactDownAt = null; this._padInteractAt = null; };
    eventTarget?.addEventListener('keydown', this._key, true);
    eventTarget?.addEventListener('keyup', this._keyUp, true);
    eventTarget?.addEventListener('mousedown', this._mouseDown, true);
    eventTarget?.addEventListener('mouseup', this._mouseUp, true);
    eventTarget?.addEventListener('blur', this._blur);
  }

  get active() { return !!this.vehicle; }
  /** True when this seat flies with the mouse-flight layout this frame. */
  get mouseFlight() { return !!this.flight.mouse && this.isDriver && aircraft(this.type); }
  /** Current mouse-flight stick deflection (x right, y nose up), for HUD and tests. */
  get stick() { return { x: this._stick.x, y: this._stick.y }; }

  /**
   * Pilot preferences from Input.flightOptions(): { mouse, sensitivity, invertY }.
   * `mouse` selects the mouse-flight layout; anything else keeps the older one.
   */
  setFlightOptions(options = null) {
    const next = options && typeof options === 'object' ? options : DEFAULT_FLIGHT_OPTIONS;
    // Input hands back the same frozen object until something changes.
    if (next === this._flightSource) return;
    this._flightSource = next;
    this.flight = Object.freeze({ mouse: next.mouse === true, sensitivity: clamp(finite(next.sensitivity, 1), 0.05, 10),
      invertY: next.invertY === true });
    if (!this.flight.mouse) this._stick.x = this._stick.y = 0;
  }
  get seatId() { return this.seat?.id ?? null; }
  get role() { return this.seat?.role ?? null; }
  get isDriver() { return !!this.seat?.drives; }
  get type() { return this.vehicle ? this.vehicle.type ?? this.vehicle.kind : null; }
  /** Every seat that owns a mount fires its own selected weapon; personal-weapon seats fire infantry guns. */
  get canFire() { return !!this.vehicle && (!!this.seat?.weapons || !!this.seat?.personalWeapons); }
  /** True when the seat's own mounts fire (not a passenger's personal weapon). */
  get mountedFire() { return !!this.vehicle && !!this.seat?.weapons; }

  /** Milliseconds T has been held (0 when released); WP7/WP8 use it for repair holds. */
  interactHeldMs() {
    return this._interactDownAt == null ? 0 : Math.max(0, this.now() - this._interactDownAt);
  }

  /** The seat's selected weapon: { mount, weapon, index, count } or null. */
  selectedWeapon() {
    if (!this.vehicle || !this.seatId) return null;
    const list = seatWeaponList(this.type, this.seatId);
    if (!list.length) return null;
    const index = clamp(finite(this.vehicle.sel?.[this.seatId], 0) | 0, 0, list.length - 1);
    return { ...list[index], index, count: list.length };
  }

  /** Subscribe to optic (RMB zoom) changes: cb({ active, zoom, seatId }). Returns an unsubscribe. */
  onOptic(cb) {
    if (typeof cb !== 'function') return () => {};
    this._opticListeners.add(cb);
    return () => this._opticListeners.delete(cb);
  }

  _setOptic(held) {
    const next = !!held && this.active;
    const active = next && this._opticFactor() > 1;
    if (next === this.opticHeld) return;
    this.opticHeld = next;
    for (const cb of this._opticListeners) {
      try { cb({ active, zoom: active ? this._opticFactor() : 1, seatId: this.seatId }); } catch (error) { console.warn('[vb] optic listener', error); }
    }
  }

  _opticFactor() {
    const seat = this.vehicle && vehicleSeatDefinition(this.type, this.seatId);
    return Math.max(1, finite(seat?.camera?.optic, 1));
  }

  _keyDown(event) {
    if (!this.enabled || event.defaultPrevented || isTypingTarget(event.target)) return;
    const seatIndex = SEAT_KEYS.indexOf(event.code);
    if (seatIndex >= 0) {
      // F5 would reload the page: always swallow seat keys while near or seated.
      if (this.vehicle || this.nearest) event.preventDefault();
      if (!event.repeat) this.requestSeat(seatIndex);
      return;
    }
    if (matchesBinding(event, 'interact')) {
      if (!event.repeat && this._interactDownAt == null) this._interactDownAt = this.now();
      if (this.vehicle || this.nearest) event.preventDefault();
      return;
    }
    if (!this.vehicle) return;
    if (matchesBinding(event, 'vehicleCamera')) { this.freeLook = true; event.preventDefault(); return; }
    if (event.repeat) return;
    if (matchesBinding(event, 'vehicleCountermeasure')) { if (this.queueCountermeasure()) event.preventDefault(); return; }
    if (matchesBinding(event, 'vehicleWeaponNext')) {
      // In a pilot seat the lean keys are the rudder (Input maps leanLeft/leanRight
      // to flightYaw*): a key bound to both steers and never flips the weapon
      // mid-turn. The slot keys still pick the jet's cannon or missiles directly.
      const rudder = aircraft(this.type) && this.isDriver && (matchesBinding(event, 'leanLeft') || matchesBinding(event, 'leanRight'));
      if (!rudder && this.queueWeaponNext()) event.preventDefault();
      return;
    }
    // Weapon slot keys pick a seat weapon directly (the jet's Q is also its rudder).
    for (let index = 0; index < 5; index++) {
      if (matchesBinding(event, `slot${index + 1}`)) { if (this.queueWeapon(index)) event.preventDefault(); return; }
    }
  }

  _keyRelease(event) {
    if (matchesBinding(event, 'vehicleCamera')) this.freeLook = false;
    if (matchesBinding(event, 'interact') && this._interactDownAt != null) {
      const held = this.now() - this._interactDownAt;
      this._interactDownAt = null;
      // A tap enters or leaves; a longer hold was a repair/revive and never exits.
      if (this.enabled && held < INTERACT_TAP_MS && this.queueInteract()) event.preventDefault?.();
    }
  }

  /**
   * The pad's Interact (D-pad left), polled once per frame from Input.padButtons:
   * like T, a press released before INTERACT_TAP_MS enters or leaves, and a
   * longer hold stays a repair or revive hold. While disabled (menus, deploy
   * screen, dead) a hold is dropped without acting on its release.
   */
  padInteract({ held = false, pressed = false } = {}, enabled = true) {
    if (!enabled || !this.enabled) { this._padInteractAt = null; return false; }
    if (pressed && this._padInteractAt == null) this._padInteractAt = this.now();
    if (held || this._padInteractAt == null) return false;
    const heldMs = this.now() - this._padInteractAt;
    this._padInteractAt = null;
    return heldMs < INTERACT_TAP_MS && this.queueInteract();
  }

  _queue(action) {
    if (!this.enabled) return false;
    // A newer request of the same type replaces the older one.
    this._actions = this._actions.filter(queued => queued.type !== action.type);
    this._actions.push(action);
    if (this._actions.length > MAX_QUEUED_ACTIONS) this._actions.shift();
    return true;
  }

  sync({ self, vehicles = [], enabled = false } = {}) {
    const oldId = this.vehicle?.id, oldSeatId = this.seatId;
    this.enabled = !!enabled && self?.state === 'alive'; this.self = self;
    this.rows = this.enabled && Array.isArray(vehicles) ? vehicles : [];
    this.vehicle = null; this.seat = null;
    for (const row of this.rows) {
      if (row.hp <= 0 || row.wreck || self?.id == null) continue;
      const type = row.type ?? row.kind;
      const seat = vehicleSeats(type).find(candidate => {
        const occupantId = vehicleSeatOccupantId(row, candidate.id);
        return occupantId != null && occupantId === String(self.id);
      });
      // Older snapshot/replay frames have only the driver alias. A canonical
      // seat map takes priority, so stale player vehicleId cannot retain a seat.
      const legacy = !row.seatOccupants && String(row.id) === String(self.vehicleId) ? vehicleSeatDefinition(type, 'driver') : null;
      if (seat || legacy) { this.vehicle = row; this.seat = seat || legacy; break; }
    }
    this.nearest = null;
    let distance = Infinity;
    if (this.enabled && !this.vehicle) for (const row of this.rows) {
      if (row.hp <= 0 || row.wreck || !hullTakeable(row) || (row.team && row.team !== self.team)) continue;
      const d = Math.hypot(row.x - self.x, row.y - self.y, row.z - self.z);
      if (d <= vehicleEnterDistance(row.type ?? row.kind) && d < distance) { distance = d; this.nearest = row; }
    }
    const seatChanged = this.vehicle?.id !== oldId || this.seatId !== oldSeatId;
    if (seatChanged) {
      this._seeded = false;
      this.freeLook = false;
      this._stick.x = this._stick.y = 0;
      if (this.vehicle) {
        this.view.begin();
        this._seedAim();
      } else {
        this.view.end();
        this._setOptic(false);
      }
      // Seat changes settle every pending request; a new hull starts clean.
      if (this.vehicle?.id !== oldId) this._actions = [];
      else this._actions = this._actions.filter(action => action.type !== 'seat');
    }
    if (!this.enabled) this._actions = [];
    this.onPresent({ active: this.active, vehicle: this.vehicle, seat: this.seat, seatId: this.seatId, role: this.role,
      isDriver: this.isDriver, canFire: this.canFire, nearest: this.nearest, canInteract: !!(this.vehicle || this.nearest),
      weapon: this.selectedWeapon() });
  }

  /** Seed the look from the seat's mount aim, or the hull for drivers and passengers. */
  _seedAim() {
    const row = this.vehicle, type = this.type;
    const hullLook = aircraft(type) && this.isDriver;
    if (hullLook) { this.yaw = wrap(finite(row.yaw)); this.pitch = finite(row.pitch); return; }
    const mountId = this.seat?.mounts?.[0];
    const aim = mountId && Array.isArray(row.mounts) ? this._mountAim(mountId) : null;
    if (aim) { this.yaw = aim.yaw; this.pitch = aim.pitch; return; }
    if (type === 'tank' && Number.isFinite(row.turretYaw) && this.isDriver) { this.yaw = row.turretYaw; this.pitch = finite(row.turretPitch); return; }
    this.yaw = wrap(finite(row.yaw)); this.pitch = 0;
  }

  _mountAim(mountId) {
    const index = vehicleMountOrder(this.type).indexOf(`${this.seatId}:${mountId}`);
    const state = index >= 0 ? this.vehicle.mounts?.[index] : null;
    return Array.isArray(state) && Number.isFinite(state[0]) ? { yaw: state[0], pitch: finite(state[1]) } : null;
  }

  /** T tap: exit when seated, else enter the nearest hull's first free seat. */
  queueInteract() {
    if (!this.enabled) return false;
    if (this.vehicle) return this._queue({ type: 'exit' });
    if (this.nearest) return this._queue({ type: 'enter', vehicleId: this.nearest.id });
    return false;
  }

  /** F1..F5: switch to that seat (free or bot-held), or enter the nearby hull straight into it. */
  requestSeat(index) {
    if (!this.enabled) return false;
    const row = this.vehicle || this.nearest;
    if (!row) return false;
    const seat = vehicleSeats(row.type ?? row.kind)[index];
    if (!seat) return false;
    if (this.vehicle) {
      if (seat.id === this.seatId || !seatTakeable(row, seat.id)) return false;
      return this._queue({ type: 'seat', seatId: seat.id });
    }
    if (!seatTakeable(row, seat.id)) return false;
    return this._queue({ type: 'enter', vehicleId: row.id, seatId: seat.id });
  }

  /** X: flares or smoke, for the hull's driving seat when the type carries one. */
  queueCountermeasure() {
    if (!this.vehicle || !this.isDriver || !COUNTERMEASURES[this.type]) return false;
    return this._queue({ type: 'cm' });
  }

  /** Slot keys: select one weapon of a multi-weapon seat by index. */
  queueWeapon(index) {
    const selected = this.selectedWeapon();
    if (!selected || selected.count < 2 || !(index >= 0 && index < selected.count) || index === selected.index) return false;
    return this._queue({ type: 'weapon', index });
  }

  /** Q: next weapon of a multi-weapon seat (tank AP/HE/coax, jet cannon/missiles). */
  queueWeaponNext() {
    const selected = this.selectedWeapon();
    if (!selected || selected.count < 2) return false;
    return this._queue({ type: 'weapon', index: (selected.index + 1) % selected.count });
  }

  consumeAction() { return this._actions.shift() || null; }

  controls(keys = {}, look = null, fire = false, dt = 1 / 60) {
    if (!this.active) return null;
    keys = keys && typeof keys === 'object' ? keys : {};
    const type = this.type, flying = aircraft(type);
    const dx = finite(look?.dx), dy = finite(look?.dy);
    const wantsFire = this.canFire && !!fire && !this.freeLook;
    if (!this.isDriver) {
      // Gunners aim their mount; passengers look around (and aim personal weapons).
      if (this.freeLook) this.view.addFreeLook(dx, dy);
      else {
        this.yaw = wrap(finite(this.yaw) - dx);
        this.pitch = clamp(finite(this.pitch) - dy, -1.1, 0.9);
      }
      return { yaw: this.yaw, pitch: this.pitch, wantFire: wantsFire };
    }
    const steer = Number(!!(keys.right ?? keys.r)) - Number(!!(keys.left ?? keys.l));
    const drive = Number(!!(keys.forward ?? keys.f)) - Number(!!(keys.back ?? keys.b));
    const mouseFlight = flying && this.mouseFlight;
    const rotor = ROTORCRAFT.has(type);
    let flightControls = {};
    if (flying) {
      this.yaw = wrap(finite(this.vehicle.yaw));
      this.pitch = finite(this.vehicle.pitch);
      // dt is the real frame time (main.js caps it at 0.25 s). The mouse stick
      // converts the pointer motion of that whole frame, so its gain and spring
      // stay frame-rate independent down to 4 fps. Pad look is generated per
      // 0.05 s-capped simulation step, so the legacy pointer share keeps that cap.
      const frameStep = Number.isFinite(dt) && dt > 0 ? dt : 1 / 60;
      const step = clamp(frameStep, 1 / 240, 0.05);
      // Mouse flight reads only the pointer share; pad and touch look (the rest)
      // keep their direct stick mapping below.
      const mouseDx = mouseFlight ? finite(look?.mouseDx) : 0, mouseDy = mouseFlight ? finite(look?.mouseDy) : 0;
      // Free look turns the camera and leaves the stick centred.
      if (this.freeLook) {
        this.view.addFreeLook(dx, dy);
        this._stick.x = this._stick.y = 0;
      } else if (mouseFlight) stepMouseFlightStick(this._stick, { dx: mouseDx, dy: mouseDy }, frameStep, this.flight);
      const pointerPitch = this.freeLook ? 0 : flightAxis(-(dy - mouseDy) / (step * FLIGHT_LOOK_RATE));
      const pointerRoll = this.freeLook ? 0 : flightAxis((dx - mouseDx) / (step * FLIGHT_LOOK_RATE));
      const rudder = Number(!!(keys.flightYawRight ?? keys.leanRight)) - Number(!!(keys.flightYawLeft ?? keys.leanLeft));
      let pitchAxis = pointerPitch, rollAxis = clamp(steer + pointerRoll, -1, 1), yawAxis = rudder;
      if (mouseFlight) {
        const stickX = flightAxis(this._stick.x), stickY = flightAxis(this._stick.y);
        pitchAxis = clamp(stickY + pointerPitch, -1, 1);
        // Jet: mouse X is the aileron and A/D join Q/E on the rudder.
        // Helicopters: mouse X is the pedals and A/D bank (strafe).
        if (rotor) yawAxis = clamp(stickX + rudder, -1, 1);
        else { rollAxis = clamp(stickX + pointerRoll, -1, 1); yawAxis = clamp(steer + rudder, -1, 1); }
      }
      // All axes, including explicit neutral, distinguish human stick control
      // from the absolute world-attitude requests used by aircraft bots.
      flightControls = {
        vehiclePitchControl: Object.hasOwn(keys, 'vehiclePitchControl') ? flightAxis(keys.vehiclePitchControl) : pitchAxis,
        vehicleRollControl: Object.hasOwn(keys, 'vehicleRollControl') ? flightAxis(keys.vehicleRollControl) : rollAxis,
        vehicleYawControl: Object.hasOwn(keys, 'vehicleYawControl') ? flightAxis(keys.vehicleYawControl) : yawAxis,
      };
      // A mouse-flown helicopter keeps the attitude the pilot set instead of
      // levelling itself whenever the springing stick returns to centre.
      if (mouseFlight && rotor) flightControls.vehicleAttitudeHold = true;
    } else if (this.freeLook) {
      this.view.addFreeLook(dx, dy);
    } else {
      this.yaw = wrap(finite(this.yaw) - dx);
      this.pitch = clamp(finite(this.pitch) - dy, -0.35, 0.65);
    }
    // Space/Shift are flight inputs only while seated in an aircraft. Mobile
    // lift holds are separate from the stick's infantry auto-sprint state.
    const up = !!(keys.flightUp || keys.jump);
    const down = !!(keys.flightDown ?? keys.sprint);
    // Mouse-flown helicopters put the collective on W/S as well as Space/Shift.
    const keyLift = Number(up) - Number(down) + (mouseFlight && rotor ? drive : 0);
    const lift = Number.isFinite(keys.vehicleLift) ? clamp(keys.vehicleLift, -1, 1) : clamp(keyLift, -1, 1);
    return { vehicleThrottle: mouseFlight && rotor ? 0 : drive,
      vehicleSteer: steer,
      vehicleBrake: Number(flying ? !!(keys.flightBrake || keys.brake || keys.crouch) : !!(keys.jump ?? keys.brake)),
      vehicleLift: flying ? lift : 0,
      ...flightControls, yaw: this.yaw, pitch: this.pitch, wantFire: wantsFire };
  }

  /** Pose the camera for the current seat (renderVehicle = the presented hull row). */
  updateCamera(dt = 0, renderVehicle = null) {
    if (!this.active || !this.camera) return false;
    const row = renderVehicle ? { ...this.vehicle, ...renderVehicle } : this.vehicle;
    const posed = this.view.update(dt, { row, seatId: this.seatId, aimYaw: this.yaw, aimPitch: this.pitch,
      freeLook: this.freeLook, optic: this.opticHeld });
    this._seeded = true;
    return posed;
  }

  /** Chase focus of the last camera pose (tests and HUD projections). */
  get _focus() { return this.view.focus; }

  reset() { this.sync({ enabled: false }); this._seeded = false; this.view.end(); }

  dispose() {
    this.eventTarget?.removeEventListener('keydown', this._key, true);
    this.eventTarget?.removeEventListener('keyup', this._keyUp, true);
    this.eventTarget?.removeEventListener('mousedown', this._mouseDown, true);
    this.eventTarget?.removeEventListener('mouseup', this._mouseUp, true);
    this.eventTarget?.removeEventListener('blur', this._blur);
    this._opticListeners.clear();
    this.reset();
  }
}
