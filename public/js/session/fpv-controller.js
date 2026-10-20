/**
 * The local operator's FPV drone link (docs/conquest.md "FPV drone"). While
 * the snapshot carries a live `fpv` row whose `own` is this client, the
 * pilot is active: main.js stops predicting the body (the server holds it
 * crouched), sends the real keys and the look here instead, and puts the
 * camera in the drone's nose. The look turns locally at once (the drone faces
 * it on the server), the position rides the presented row. Telemetry for the
 * feed HUD (public/js/ui/conquest/fpv-feed.js) is read from the same rows:
 * battery from the row, signal from the distance to the own body, the same
 * curve the server cuts the link with (fpvSignal).
 */
import { FPV_RULES, decodeFpvRow, fpvDronesOf, fpvRowOf, fpvSignal } from '../../../shared/fpv-rules.js';

const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
/** Camera seat in the drone frame: the pod on the nose (metres above the row origin, ahead of it). */
export const FPV_CAMERA = Object.freeze({ up: 0.14, ahead: 0.16, rollShare: 0.6, scan: 160 });

export class FpvPilot {
  constructor({ getBlock = null } = {}) {
    this.getBlock = typeof getBlock === 'function' ? getBlock : null;
    this.row = null; this.info = null; this.left = null;
    this.yaw = 0; this.pitch = 0; this.roll = 0;
    this._id = null;
  }

  get active() { return !!this.row; }
  get vehicleId() { return this.row ? String(this.row.id) : null; }

  /** Snapshot ingest: the own live drone row (alive, link live), else inactive. */
  sync({ self = null, vehicles = [], myId = null, enabled = true } = {}) {
    this.left = fpvDronesOf(self);
    const row = enabled && self?.state === 'alive' ? fpvRowOf(vehicles, myId ?? self?.id) : null;
    const info = decodeFpvRow(row);
    if (!info || info.link !== 'live') { this.row = null; this.info = info; this._id = null; return false; }
    if (this._id !== String(row.id)) {
      // A fresh link (or a reconnect onto one in the air): the look starts where the drone faces.
      this._id = String(row.id);
      this.yaw = finite(row.yaw); this.pitch = info.lookPitch;
    }
    this.row = row; this.info = info;
    return true;
  }

  /** One frame of mouse look and keys: the input frame main.js sends while flying. */
  controls(keys = {}, look = null, fire = false) {
    const lim = FPV_RULES.flight.pitchLimit;
    this.yaw = wrap(this.yaw - finite(look?.dx));
    this.pitch = clamp(this.pitch - finite(look?.dy), -lim, lim);
    const k = keys && typeof keys === 'object' ? keys : {};
    return {
      keys: { forward: !!k.forward, back: !!k.back, left: !!k.left, right: !!k.right, jump: !!k.jump, crouch: !!k.crouch },
      yaw: this.yaw, pitch: this.pitch, wantFire: !!fire,
    };
  }

  /** The camera in the nose of the presented drone (`presented`, else the row) at the feed's wide FOV. */
  updateCamera(camera, presented = null) {
    const row = presented ?? this.row;
    if (!camera || !row) return false;
    const c = Math.cos(this.pitch);
    camera.position.set(row.x - Math.sin(this.yaw) * c * FPV_CAMERA.ahead, finite(row.y) + FPV_CAMERA.up + Math.sin(this.pitch) * FPV_CAMERA.ahead,
      row.z - Math.cos(this.yaw) * c * FPV_CAMERA.ahead);
    this.roll = finite(presented?.roll ?? row.roll) * FPV_CAMERA.rollShare;
    camera.rotation.set(this.pitch, this.yaw, this.roll, 'YXZ');
    if (camera.fov !== FPV_RULES.fov) { camera.fov = FPV_RULES.fov; camera.updateProjectionMatrix(); }
    return true;
  }

  /** Height of the drone over the first solid block under it (m), or null past the scan. */
  _altitude(row) {
    if (!this.getBlock) return null;
    const x = Math.floor(row.x), z = Math.floor(row.z);
    for (let y = Math.floor(finite(row.y)), n = 0; y >= 0 && n < FPV_CAMERA.scan; y--, n++) {
      if (this.getBlock(x, y, z)) return Math.max(0, finite(row.y) - (y + 1));
    }
    return null;
  }

  /**
   * Feed telemetry: `{ battery 0..1, seconds, bars, quality, speed, altitude,
   * distance, noise 0..1, left, roll, pitch }`, or null while inactive.
   * `operator` is the own body's position (x, y, z).
   */
  telemetry(operator = null) {
    if (!this.row || !this.info) return null;
    const row = this.row;
    const distance = operator ? Math.hypot(row.x - operator.x, finite(row.y) - (finite(operator.y) + 1.5), row.z - operator.z) : 0;
    const signal = fpvSignal(distance);
    return {
      battery: this.info.battery, seconds: Math.max(0, Math.round(this.info.battery * FPV_RULES.batteryMs / 1000)),
      bars: signal.bars, maxBars: FPV_RULES.signal.bars, quality: signal.quality, degraded: signal.degraded,
      speed: Math.abs(finite(row.speed)), altitude: this._altitude(row), distance, range: FPV_RULES.signal.range,
      // Static: a faint grain always, growing to a snowstorm as the signal fades.
      noise: clamp(0.08 + (1 - signal.quality) * 0.92, 0, 1),
      left: this.left, roll: this.roll, pitch: this.pitch,
    };
  }

  clear() { this.row = null; this.info = null; this._id = null; }
}
