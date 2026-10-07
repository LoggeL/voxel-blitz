// Trauma-based camera shake bus. Sources add trauma (0..1); the applied offset
// scales with trauma squared and decays over time, so small hits are a
// flutter and a tank shot next to you is a real jolt. Smooth value noise per
// axis keeps it organic. Reduced motion caps the bus to a faint 20 % sway.
// apply() layers the shake on top of whatever pose the camera already has
// this frame and never accumulates: the caller re-poses the camera each frame.

/** Tuning (presentation only). */
export const CAMERA_SHAKE = Object.freeze({
  decay: 1.35,        // trauma lost per second
  maxYaw: 0.035,      // radians at trauma 1
  maxPitch: 0.03,
  maxRoll: 0.045,
  maxOffset: 0.12,    // metres of positional jitter at trauma 1
  frequency: 17,      // noise samples per second
  reducedScale: 0.2,  // reduced motion keeps only a faint sway
  explosionRange: 4,  // an explosion is felt out to range * radius
});

const clamp01 = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

function hash(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}
/** Smooth 1-D value noise in [-1, 1]. */
function noise1(x, seed) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  const a = hash(i + seed * 101.3), b = hash(i + 1 + seed * 101.3);
  return (a + (b - a) * u) * 2 - 1;
}

export class CameraShake {
  constructor({ reducedMotion = false } = {}) {
    this.trauma = 0;
    this.time = 0;
    this.reducedMotion = !!reducedMotion;
    this.last = { yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, z: 0 };
  }

  /** Add trauma (0..1); the bus saturates at 1. */
  add(trauma) {
    this.trauma = clamp01(this.trauma + clamp01(trauma));
    return this.trauma;
  }

  /**
   * Trauma from an explosion at `pos` with blast `radius`, felt by `camera`
   * (anything with a position): full inside the radius, fading to nothing
   * at CAMERA_SHAKE.explosionRange radii.
   */
  addExplosion(pos, radius = 4, camera = null) {
    const at = Array.isArray(pos) ? pos : pos && [pos.x, pos.y, pos.z];
    const eye = camera?.position;
    if (!at || !eye || !at.every(Number.isFinite)) return 0;
    const r = Math.max(0.5, Number.isFinite(radius) ? radius : 4);
    const distance = Math.hypot(at[0] - eye.x, at[1] - eye.y, at[2] - eye.z);
    const falloff = 1 - Math.max(0, distance - r) / (r * (CAMERA_SHAKE.explosionRange - 1));
    if (falloff <= 0) return 0;
    const amount = Math.min(1, 0.25 + r / 14) * falloff * falloff;
    return this.add(amount);
  }

  setReducedMotion(value) { this.reducedMotion = !!value; }

  /** Current offsets without touching a camera (tests and HUD). */
  sample(dt = 0) {
    const step = Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0));
    this.time += step;
    const out = this.last;
    if (this.trauma <= 0) {
      out.yaw = out.pitch = out.roll = out.x = out.y = out.z = 0;
      return out;
    }
    const scale = this.trauma * this.trauma * (this.reducedMotion ? CAMERA_SHAKE.reducedScale : 1);
    const t = this.time * CAMERA_SHAKE.frequency;
    out.yaw = CAMERA_SHAKE.maxYaw * scale * noise1(t, 1);
    out.pitch = CAMERA_SHAKE.maxPitch * scale * noise1(t, 2);
    out.roll = CAMERA_SHAKE.maxRoll * scale * noise1(t, 3);
    const offset = this.reducedMotion ? 0 : CAMERA_SHAKE.maxOffset * scale;
    out.x = offset * noise1(t, 4); out.y = offset * noise1(t, 5); out.z = offset * noise1(t, 6);
    this.trauma = Math.max(0, this.trauma - CAMERA_SHAKE.decay * step);
    return out;
  }

  /**
   * Layer the shake on the camera's current pose (call after the camera is
   * posed for the frame, before rendering). Returns the applied offsets.
   */
  apply(camera, dt = 0) {
    const out = this.sample(dt);
    if (!camera || (out.yaw === 0 && out.pitch === 0 && out.roll === 0 && out.x === 0 && out.y === 0 && out.z === 0)) return out;
    camera.rotateY(out.yaw);
    camera.rotateX(out.pitch);
    camera.rotateZ(out.roll);
    camera.translateX(out.x); camera.translateY(out.y); camera.translateZ(out.z);
    camera.updateMatrixWorld?.();
    return out;
  }

  reset() { this.trauma = 0; this.time = 0; }
}
