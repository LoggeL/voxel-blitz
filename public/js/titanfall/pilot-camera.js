// Titanfall pilot camera (docs/titanfall.md §4.2, WP1): the wallrun roll and the
// FOV kicks. Physics never rolls the view: LocalPlayer.updateCamera asks
// `player.pilotCamera.update(dt, player)` (installed by pilot-client.js for the
// match) and adds the returned roll and FOV on top of its own composition, so
// the viewmodel's `viewRoll` follows the same roll.
import { PILOT_RULES } from '../../../shared/pilot-movement.js';

export const PILOT_CAMERA = Object.freeze({
  // Roll: a critically damped spring (no velocity snap on a catch or a side switch);
  // 63 % of the way in ~0.13 s, settled in ~0.3 s.
  rollOmega: 16,      // rad/s, roll spring
  fovRate: 7,         // 1/s, FOV follow
  slideFov: 6,        // degrees while sliding
  wallFov: 4,         // degrees while wallrunning
  grappleFov: 8,      // degrees while reeled in
  speedFov: 5,        // degrees at the horizontal clamp (from sprint speed up)
  kickFov: 3,         // degrees of a double jump or wall-jump kick
  kickRise: 30,       // 1/s, the kick eases in (no one-frame FOV jump)
  kickDecay: 6,       // 1/s
  // Camera offsets (playtest): off the wall while wallrunning (the eye sat 0.32 m from the
  // voxels, the near wall washed out a third of the view), and behind/above the back plate
  // on a rodeo (the eye sat inside the titan mesh).
  wallPush: 0.24,     // m along the wall's outward normal
  rodeoBack: 1.5,     // m from the hull, beyond the rider
  rodeoUp: 0.9,       // m
  offsetRate: 8,      // 1/s, offset follow
  // A wall voxel the body steps around (pillar, angled wall): the eye stays stepMargin off its face
  // (the 0.05 m near plane is ~0.075 m wide at 16:9) and approaches it on a ramp of stepSlope
  // (lateral m per m along the run), looking stepLook m ahead for the next one.
  stepMargin: 0.15,   // m
  stepSlope: 0.5,
  stepLook: 4,        // m
});

// The wall probe heights above the feet (shared/pilot-movement.js WALL_HEIGHTS).
const STEP_PROBE = [0.3, 1.0, 1.8];

/**
 * How much the wall lies on the view's right (+1) or left (-1) for a wall code
 * (shared/pilot-movement.js: the wall's outward normal, ±1 = ±X, ±2 = ±Z) at
 * view yaw `yaw` (forward = (-sin, -cos)). 0 without a wall.
 */
export function wallSideOf(wall, yaw) {
  if (!wall || !Number.isFinite(yaw)) return 0;
  const n = wall > 0 ? 1 : -1, xAxis = wall === 1 || wall === -1;
  const toWallX = xAxis ? -n : 0, toWallZ = xAxis ? 0 : -n;
  return toWallX * Math.cos(yaw) - toWallZ * Math.sin(yaw);
}

export class PilotCamera {
  constructor() {
    this.result = { roll: 0, fov: 0, ox: 0, oy: 0, oz: 0 };
    this.reset();
  }

  reset() {
    this.roll = 0;
    this.rollVel = 0;
    this.fov = 0;
    this.kick = 0;
    this.kickTarget = 0;
    this._shiftX = null;
    this._shiftZ = null;
    this._step = null;
    this._chain = 0;
    this._jumps = 1;
    this.result.roll = 0;
    this.result.fov = 0;
    this.ox = this.oy = this.oz = 0;
    this.result.ox = this.result.oy = this.result.oz = 0;
  }

  /**
   * Camera offset target: the wall's outward normal × wallPush while wallrunning; on a
   * rodeo, away from the hull centre (player.rodeoHullFor(id) → {x, z}) and up.
   */
  _offsetTarget(player, pilot, out) {
    out[0] = out[1] = out[2] = 0;
    const riding = player.pilotRiding === true;
    const id = player._pilotRodeo ? player._pilotRodeoId : player._rodeoPending?.id;
    const hull = riding && id != null && typeof player.rodeoHullFor === 'function' ? player.rodeoHullFor(id) : null;
    const pos = player.physics?.pos;
    if (hull && pos && [hull.x, hull.z, pos.x, pos.z].every(Number.isFinite)) {
      const dx = pos.x - hull.x, dz = pos.z - hull.z, len = Math.hypot(dx, dz);
      if (len > 1e-3) { out[0] = dx / len * PILOT_CAMERA.rodeoBack; out[2] = dz / len * PILOT_CAMERA.rodeoBack; }
      out[1] = PILOT_CAMERA.rodeoUp;
      return out;
    }
    const wall = pilot.wall | 0;
    if (wall && !riding) {
      const n = wall > 0 ? 1 : -1;
      if (wall === 1 || wall === -1) out[0] = n * PILOT_CAMERA.wallPush; else out[2] = n * PILOT_CAMERA.wallPush;
    }
    return out;
  }

  /**
   * The next wall voxel the body will step around on this run (shared/pilot-movement.js
   * stepAroundWall: one voxel closer, air one farther, stepGap past the last step), within
   * stepLook m: { xAxis, n, face, edge, dir }, or null. An inner corner or a step the rules refuse
   * ends the run instead, so it does not move the eye.
   */
  _stepAhead(physics, pilot, xAxis, n) {
    const pos = physics?.pos;
    if (!pos || typeof physics.solid !== 'function' || !Number.isFinite(pilot.wallPlane)) return null;
    const lerp = physics.pilotLerp, closer = pilot.wallPlane + n, dir = pilot.wallTan >= 0 ? 1 : -1;
    const along = xAxis ? pos.z + (lerp?.z || 0) : pos.x + (lerp?.x || 0);
    for (let k = 0; k <= PILOT_CAMERA.stepLook; k++) {
      const cell = Math.floor(along) + dir * k, edge = dir > 0 ? cell : cell + 1, before = (edge - along) * dir;
      if (before <= 0) continue;
      if (before > PILOT_CAMERA.stepLook) break;
      const at = plane => STEP_PROBE.some(h => physics.solid(xAxis ? plane : cell, Math.floor(pos.y + h), xAxis ? cell : plane));
      if (!at(closer)) continue;
      if (at(closer + n) || (Number.isFinite(pilot.wallStepAt) && (edge - pilot.wallStepAt) * dir < PILOT_RULES.wallrun.stepGap)) return null;
      return { xAxis, n, face: n > 0 ? closer + 1 : closer, edge, dir };
    }
    return null;
  }

  /**
   * The voxel a step-around went around, from the pilot state right after it: the shift's axis and
   * sign are the wall's outward normal, wallPlane is the stepped voxel's cell and wallStepAt its near
   * edge along the run. Null when the state does not describe one.
   */
  _stepOf(pilot, dx, dz) {
    const xAxis = dx !== 0, shift = xAxis ? dx : dz;
    if (!shift || !Number.isFinite(pilot.wallPlane) || !Number.isFinite(pilot.wallStepAt)) return null;
    const n = shift > 0 ? 1 : -1;
    return { xAxis, n, face: n > 0 ? pilot.wallPlane + 1 : pilot.wallPlane, edge: pilot.wallStepAt,
      dir: pilot.wallTan >= 0 ? 1 : -1 };
  }

  /**
   * Keeps the presented eye (pos + pilotLerp + offset) out of a stepped voxel: stepMargin off its
   * face once level with it, and before its edge behind the face by at most stepSlope × the distance
   * left (a ramp, so the eye moves out at stepSlope × the run speed, never in one frame). The same
   * ramp holds before and after the step, so the step's own frame does not jump. True when it pushed.
   */
  _clampStep(physics, step) {
    const pos = physics?.pos, lerp = physics?.pilotLerp;
    if (!pos) return false;
    const lateral = step.xAxis ? pos.x + (lerp?.x || 0) : pos.z + (lerp?.z || 0);
    const along = step.xAxis ? pos.z + (lerp?.z || 0) : pos.x + (lerp?.x || 0);
    const before = (step.edge - along) * step.dir;
    // Least offset along the outward normal that keeps the eye clear.
    const least = step.n * (step.face - lateral) + PILOT_CAMERA.stepMargin - PILOT_CAMERA.stepSlope * Math.max(0, before);
    if ((step.xAxis ? this.ox : this.oz) * step.n >= least) return false;
    if (step.xAxis) this.ox = step.n * least; else this.oz = step.n * least;
    return true;
  }

  /** player: LocalPlayer (physics.pilot, physics.vel, view.yaw, adsT, alive, deathCamMotion). */
  update(dt, player) {
    const seconds = Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0));
    const physics = player?.physics, pilot = physics?.pilot;
    if (!pilot || player.alive === false) { this.reset(); return this.result; }
    // Reduced motion: main.js lowers deathCamMotion to 0.15; the pilot camera follows it.
    const motion = Number.isFinite(player.deathCamMotion) ? Math.max(0, Math.min(1, player.deathCamMotion)) : 1;
    // Lean away from the wall: a wall on the right rolls the view left (+z).
    const targetRoll = wallSideOf(pilot.wall, player.view?.yaw) * PILOT_RULES.wallrun.roll * motion;
    // Exact critically damped step (stable at any frame time).
    const w = PILOT_CAMERA.rollOmega, e = Math.exp(-w * seconds), x = this.roll - targetRoll;
    const c = this.rollVel + w * x;
    this.roll = targetRoll + (x + c * seconds) * e;
    this.rollVel = (this.rollVel - w * c * seconds) * e;
    const vel = physics.vel || { x: 0, z: 0 };
    const speed = Math.hypot(vel.x || 0, vel.z || 0);
    const R = PILOT_RULES;
    let target = Math.max(0, Math.min(1, (speed - R.sprint) / (R.clamp - R.sprint))) * PILOT_CAMERA.speedFov;
    if (pilot.slideT > 0) target += PILOT_CAMERA.slideFov;
    if (pilot.wall) target += PILOT_CAMERA.wallFov;
    if (pilot.grapple) target += PILOT_CAMERA.grappleFov;
    if (pilot.chain > this._chain || pilot.jumpsLeft < this._jumps) this.kickTarget = PILOT_CAMERA.kickFov;
    this._chain = pilot.chain | 0;
    this._jumps = pilot.jumpsLeft | 0;
    this.kick += (this.kickTarget - this.kick) * (1 - Math.exp(-PILOT_CAMERA.kickRise * seconds));
    this.kickTarget *= Math.exp(-PILOT_CAMERA.kickDecay * seconds);
    this.fov += (target - this.fov) * (1 - Math.exp(-PILOT_CAMERA.fovRate * seconds));
    // Sights stay steady: the kicks fade out with ADS.
    const ads = Number.isFinite(player.adsT) ? Math.max(0, Math.min(1, player.adsT)) : 0;
    // A wall stepped around (shared/pilot-movement.js shiftX/Z) moves the body a voxel off the
    // wall in one tick: the offset takes the jump and eases it out (also when the run ended on that tick).
    const sx = Number.isFinite(pilot.shiftX) ? pilot.shiftX : 0, sz = Number.isFinite(pilot.shiftZ) ? pilot.shiftZ : 0;
    if (this._shiftX !== null && (sx !== this._shiftX || sz !== this._shiftZ)) {
      this.ox -= sx - this._shiftX;
      this.oz -= sz - this._shiftZ;
      this._step = this._stepOf(pilot, sx - this._shiftX, sz - this._shiftZ);
    }
    this._shiftX = sx;
    this._shiftZ = sz;
    const to = this._offsetTarget(player, pilot, this._to ??= [0, 0, 0]), k = 1 - Math.exp(-PILOT_CAMERA.offsetRate * seconds);
    this.ox += (to[0] - this.ox) * k; this.oy += (to[1] - this.oy) * k; this.oz += (to[2] - this.oz) * k;
    // Stepped-around voxels: the one the body went around and the next one ahead keep the eye out.
    const wall = player.pilotRiding === true ? 0 : pilot.wall | 0;
    const ahead = wall ? this._stepAhead(physics, pilot, wall === 1 || wall === -1, wall > 0 ? 1 : -1) : null;
    if (ahead) this._clampStep(physics, ahead);
    if (this._step && !this._clampStep(physics, this._step)) {
      // Done once the offset has eased back to its target.
      if (Math.abs(this._step.xAxis ? this.ox - to[0] : this.oz - to[2]) < 0.01) this._step = null;
    }
    this.result.ox = this.ox; this.result.oy = this.oy; this.result.oz = this.oz;
    this.result.roll = this.roll;
    this.result.fov = (this.fov + this.kick) * motion * (1 - ads);
    return this.result;
  }
}
