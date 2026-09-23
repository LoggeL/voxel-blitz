/**
 * First-person death: the camera leaves with the severed head. It is thrown away
 * from the killer, whips back, barrel-rolls with its eyes dragged onto the headless
 * body it left, bounces off voxels and lands on its cheek while the screen cuts to
 * black; the killcam or spectator view then fades in.
 * Presentation only: nothing here feeds back into movement, hits or respawn.
 */
export const DEATH_HEAD = Object.freeze({
  /** Head flight before the killcam/spectator takes the camera. */
  introMs: 900,
  /** Black starts creeping in here and is total at `introMs`. */
  fadeStartMs: 240,
  /** Black lifts off the killcam/spectator view over this span. */
  revealMs: 320,
  radius: 0.14,
  gravity: 19,
  throwSpeed: 5.2, headshotThrowSpeed: 7.6,
  lift: 3.6, headshotLift: 4.8,
  /** Neck whip (rad/s, backwards) and barrel roll (rad/s, follows the death side). */
  whip: 11, headshotWhip: 15, roll: 6, headshotRoll: 8.5, rollDrag: 0.6,
  /** Spring that drags the eyes back onto the body (rad/s natural frequency). */
  gaze: 8,
  /** The eyes find the chest, this far below the neck. */
  chestDrop: 0.55,
  restitution: 0.32, friction: 0.62, spinLoss: 0.45,
  /** Settled head: lying on its side, looking a little up. */
  restRoll: Math.PI / 2 - 0.18, restPitch: 0.12, settleRate: 7,
  maxStep: 1 / 120,
});

const TAU = Math.PI * 2;
const wrap = (angle) => angle - TAU * Math.round(angle / TAU);

export class DeathHeadCam {
  constructor() {
    this.active = false;
    this.elapsed = 0;
    this.pos = { x: 0, y: 0, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.spin = { pitch: 0, yaw: 0, roll: 0 };
    this.anchor = { x: 0, y: 0, z: 0 };
    this.pitch = 0;
    this.yaw = 0;
    this.roll = 0;
    this.side = 1;
    this.grounded = false;
  }

  /**
   * `away` is the horizontal direction from the killer to the victim; without one
   * the head goes backwards out of the view. `motion` in [0, 1] scales whip and roll
   * (reduced-motion players get the throw without the spin).
   */
  start({ x, y, z, yaw = 0, pitch = 0, away = null, side = 1, headshot = false, motion = 1 }) {
    const R = DEATH_HEAD;
    let ax = Number(away?.x), az = Number(away?.z);
    let length = Math.hypot(ax, az);
    if (!(length > 1e-3)) { ax = Math.sin(yaw); az = Math.cos(yaw); length = 1; }
    ax /= length; az /= length;
    this.side = side < 0 ? -1 : 1;
    // A little sideways kick so repeated deaths do not fly on the same line.
    const lateral = 0.28 * this.side;
    const speed = headshot ? R.headshotThrowSpeed : R.throwSpeed;
    const spin = Math.max(0, Math.min(1, Number.isFinite(motion) ? motion : 1));
    this.active = true;
    this.elapsed = 0;
    this.grounded = false;
    this.pos.x = x; this.pos.y = y; this.pos.z = z;
    this.vel.x = (ax - az * lateral) * speed;
    this.vel.z = (az + ax * lateral) * speed;
    this.vel.y = headshot ? R.headshotLift : R.lift;
    this.yaw = yaw;
    this.pitch = pitch;
    this.roll = 0;
    this.anchor.x = x; this.anchor.y = y - R.chestDrop; this.anchor.z = z;
    this.spin.pitch = (headshot ? R.headshotWhip : R.whip) * (0.15 + 0.85 * spin);
    this.spin.roll = this.side * (headshot ? R.headshotRoll : R.roll) * (0.1 + 0.9 * spin);
    this.spin.yaw = 0;
    return this;
  }

  stop() {
    this.active = false;
    this.elapsed = 0;
  }

  /** Advance by `dt` seconds against `solid(x, y, z)` voxel cells. */
  step(dt, solid = () => false) {
    if (!this.active) return this;
    let remaining = Math.max(0, Math.min(0.1, Number(dt) || 0));
    this.elapsed += remaining;
    while (remaining > 1e-6) {
      const h = Math.min(DEATH_HEAD.maxStep, remaining);
      remaining -= h;
      this._substep(h, solid);
    }
    return this;
  }

  _substep(h, solid) {
    const R = DEATH_HEAD;
    const { pos, vel, spin } = this;
    vel.y -= R.gravity * h;
    for (const axis of ['x', 'y', 'z']) {
      const move = vel[axis] * h;
      if (move === 0) continue;
      pos[axis] += move;
      const probe = { x: pos.x, y: pos.y, z: pos.z };
      probe[axis] += Math.sign(move) * R.radius;
      if (!solid(Math.floor(probe.x), Math.floor(probe.y), Math.floor(probe.z))) continue;
      pos[axis] -= move;
      const impact = Math.abs(vel[axis]);
      vel[axis] = -vel[axis] * R.restitution;
      if (axis === 'y' && move < 0) {
        vel.x *= R.friction; vel.z *= R.friction;
        if (Math.abs(vel.y) < 0.9) { vel.y = 0; this.grounded = true; }
      }
      if (impact > 0.5) { spin.pitch *= R.spinLoss; spin.roll *= R.spinLoss; spin.yaw *= R.spinLoss; }
    }
    if (this.grounded && vel.y > 0.05) this.grounded = false;
    // Critically damped gaze: whatever the whip does, the eyes end on the body.
    const dx = this.anchor.x - pos.x, dz = this.anchor.z - pos.z;
    const flat = Math.hypot(dx, dz);
    if (flat > 0.05) {
      const w = R.gaze;
      const lookPitch = this.grounded ? R.restPitch : Math.atan2(this.anchor.y - pos.y, flat);
      spin.pitch += (w * w * wrap(lookPitch - this.pitch) - 2 * w * spin.pitch) * h;
      spin.yaw += (w * w * wrap(Math.atan2(-dx, -dz) - this.yaw) - 2 * w * spin.yaw) * h;
    }
    spin.roll *= Math.exp(-R.rollDrag * h);
    this.pitch += spin.pitch * h;
    this.roll += spin.roll * h;
    this.yaw += spin.yaw * h;
    if (this.grounded) {
      // Rolling to a stop on the cheek: bleed the roll, ease towards the rest pose.
      const k = 1 - Math.exp(-R.settleRate * h);
      spin.roll -= spin.roll * k;
      vel.x -= vel.x * k; vel.z -= vel.z * k;
      this.roll += wrap(this.side * R.restRoll - this.roll) * k;
    }
  }
}

/**
 * Screen black level for the death sequence: clear at first, total by `introMs`,
 * then lifting off whatever view follows. `elapsedMs` counts from the death.
 */
export function deathFadeOpacity(elapsedMs) {
  const R = DEATH_HEAD;
  const t = Number(elapsedMs);
  if (!Number.isFinite(t) || t <= R.fadeStartMs) return 0;
  if (t <= R.introMs) {
    const k = (t - R.fadeStartMs) / (R.introMs - R.fadeStartMs);
    return k * k;
  }
  const reveal = (t - R.introMs) / R.revealMs;
  return reveal >= 1 ? 0 : 1 - reveal * reveal * (3 - 2 * reveal);
}
