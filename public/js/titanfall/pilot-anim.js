// Titanfall pilot poses (docs/titanfall.md §4.2, WP1): wallrun and slide for the
// local first-person legs (LocalPlayer calls `player.pilotAnim.updateBody` after
// updateFirstPersonBody) and for remote avatars (pilot-client.js avatarState,
// after AvatarRoster's stock pose). Remote angles stay small so the visible
// body stays inside the crouch/standing hitbox envelope (shared/player-hitboxes.js):
// the server hitboxes know only crouch, so a slide is a crouch with a short
// forward leg and a wallrun is a running stride with a slight torso lean.
import { TITAN_MV, TITANFALL_PLAYER_FLAGS } from '../../../shared/titan-contract.js';
import { gaitPhaseRate, footstepVolume, strideCrossed } from '../audio/footsteps.js';
import { setAvatarOpacity } from '../avatar/avatar.js';

export const PILOT_POSE = Object.freeze({
  follow: 12,            // 1/s pose blend
  // local first-person legs
  fpWallRoll: 0.28,      // rad, feet toward the wall
  fpSlideLead: -1.2,     // thigh pitch of the leading leg (negative = forward)
  fpSlideTrail: -0.45,
  // remote avatar
  wallLean: 0.09,        // rad body roll away from the wall (about the feet: ~0.17 m at the head)
  wallStride: 0.62,      // leg swing amplitude on the wall
  slideLead: -0.7,
  slideTrail: -0.15,
  slideBack: -0.12,      // torso pitch (negative = leaning back)
  // rodeo rider (TITAN_MV.rodeo): clinging to the back plate it faces, one knee up, leaning in
  // (rodeo feel pass; the legs stay inside the hull-side half of the standing envelope)
  rodeoLead: 0.62, rodeoLeadKnee: -1.05, rodeoTrail: 0.28, rodeoTrailKnee: -0.6, rodeoLean: 0.16,
  fpRodeoLead: -0.85, fpRodeoTrail: -0.45, fpRodeoKnee: 1.2,
  cloakEnemy: 0.06,      // opacity of a cloaked enemy (plus shimmer)
  cloakAlly: 0.4,
  cloakShimmer: 0.05,
});

const lerp = (a, b, t) => a + (b - a) * t;
const blendOf = dt => 1 - Math.exp(-PILOT_POSE.follow * Math.max(0, Math.min(0.1, dt || 0)));

/**
 * Which side of a body at (x, y, z) facing `yaw` a wall is on: +1 right,
 * -1 left, 0 none, probing the four voxel neighbours at chest height.
 */
export function wallSideAt(solidAt, x, y, z, yaw) {
  if (typeof solidAt !== 'function' || ![x, y, z, yaw].every(Number.isFinite)) return 0;
  const reach = 0.32 + 0.3, cy = Math.floor(y + 1.0);
  let side = 0, best = 0;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (!solidAt(Math.floor(x + dx * reach), cy, Math.floor(z + dz * reach))) continue;
    const d = dx * Math.cos(yaw) - dz * Math.sin(yaw);
    if (Math.abs(d) > Math.abs(best)) { best = d; side = d; }
  }
  return side > 0.2 ? 1 : side < -0.2 ? -1 : 0;
}

/** Local first-person legs: wallrun stride and roll, slide leg-out. */
export class PilotAnim {
  constructor() { this.reset(); }

  reset() {
    this.wall = 0;
    this.slide = 0;
    this.rodeo = 0;
    this.side = 0;
    this.phase = 0;
  }

  updateBody(body, dt, player) {
    if (!body || body.disposed || !player?.physics) return;
    const pilot = player.physics.pilot, alive = player.alive !== false;
    const k = blendOf(dt);
    const wallrun = alive && !!pilot?.wall;
    this.wall = lerp(this.wall, wallrun ? 1 : 0, k);
    this.slide = lerp(this.slide, alive && pilot?.slideT > 0 && player.physics.grounded ? 1 : 0, k);
    this.rodeo = lerp(this.rodeo, alive && player.pilotRiding ? 1 : 0, k);
    const r = this.rodeo;
    if (r > 0.01) {
      // On a titan's back: knees up against the plate.
      body.left.leg.rotation.x = lerp(body.left.leg.rotation.x, PILOT_POSE.fpRodeoLead, r);
      body.right.leg.rotation.x = lerp(body.right.leg.rotation.x, PILOT_POSE.fpRodeoTrail, r);
      body.left.knee.rotation.x = lerp(body.left.knee.rotation.x, PILOT_POSE.fpRodeoKnee, r);
      body.right.knee.rotation.x = lerp(body.right.knee.rotation.x, PILOT_POSE.fpRodeoKnee * 0.7, r);
    }
    if (wallrun) {
      // The view's side of the wall (pilot-camera.js convention).
      const n = pilot.wall > 0 ? 1 : -1, xAxis = Math.abs(pilot.wall) === 1, yaw = player.view?.yaw ?? 0;
      const d = (xAxis ? -n : 0) * Math.cos(yaw) - (xAxis ? 0 : -n) * Math.sin(yaw);
      this.side = d > 0 ? 1 : -1;
    }
    const w = this.wall, s = this.slide;
    if (w < 0.01 && s < 0.01) return;
    const speed = Math.hypot(player.physics.vel.x, player.physics.vel.z);
    if (w > 0.01) {
      this.phase += Math.max(0, Math.min(0.1, dt || 0)) * gaitPhaseRate(speed);
      const swing = Math.sin(this.phase);
      body.group.rotation.z = this.side * PILOT_POSE.fpWallRoll * w;
      body.left.leg.rotation.x = lerp(body.left.leg.rotation.x, swing * 0.8 - 0.2, w);
      body.right.leg.rotation.x = lerp(body.right.leg.rotation.x, -swing * 0.8 - 0.2, w);
      body.left.knee.rotation.x = lerp(body.left.knee.rotation.x, 0.35 + Math.max(0, -swing) * 0.7, w);
      body.right.knee.rotation.x = lerp(body.right.knee.rotation.x, 0.35 + Math.max(0, swing) * 0.7, w);
    }
    if (s > 0.01) {
      body.left.leg.rotation.x = lerp(body.left.leg.rotation.x, PILOT_POSE.fpSlideLead, s);
      body.left.knee.rotation.x = lerp(body.left.knee.rotation.x, 0.12, s);
      body.right.leg.rotation.x = lerp(body.right.leg.rotation.x, PILOT_POSE.fpSlideTrail, s);
      body.right.knee.rotation.x = lerp(body.right.knee.rotation.x, 1.55, s);
      body.torso.rotation.x = lerp(body.torso.rotation.x, -0.08, s);
    }
  }
}

/**
 * Pose and shade one remote pilot after the roster's stock pose.
 * state = { mv (TITAN_MV), flags (tf[3]), side (wallSideAt), ally, speed, now (ms) }.
 * Returns { wallrun, slide, cloaked, side, step } where step is the loudness of
 * a footfall on the wall this frame (0 for none).
 */
export function poseRemotePilot(avatar, state, dt) {
  if (!avatar?.torso || !avatar.lLeg || !avatar.rLeg) return null;
  const pose = avatar.tfPilot ??= { wall: 0, slide: 0, rodeo: 0, side: 0, phase: 0 };
  const k = blendOf(dt);
  const wallrun = state.mv === TITAN_MV.wallrun, slide = state.mv === TITAN_MV.slide;
  pose.wall = lerp(pose.wall, wallrun ? 1 : 0, k);
  pose.slide = lerp(pose.slide, slide ? 1 : 0, k);
  pose.rodeo = lerp(pose.rodeo ?? 0, state.mv === TITAN_MV.rodeo ? 1 : 0, k);
  if (wallrun && state.side) pose.side = state.side;
  const w = pose.wall, s = pose.slide;
  let step = 0;
  if (w > 0.01) {
    const before = pose.phase;
    pose.phase += Math.max(0, Math.min(0.1, dt || 0)) * gaitPhaseRate(state.speed || 0);
    if (wallrun && strideCrossed(before, pose.phase)) step = footstepVolume({ speed: state.speed || 0, grounded: true });
    const swing = Math.sin(pose.phase) * PILOT_POSE.wallStride;
    avatar.lLeg.rotation.x = lerp(avatar.lLeg.rotation.x, swing, w);
    avatar.rLeg.rotation.x = lerp(avatar.rLeg.rotation.x, -swing, w);
    // The roster sets the group rotation absolutely every frame, so the lean is
    // a plain roll about the feet (the stock torso/head blends would accumulate an offset).
    if (avatar.group?.rotation) avatar.group.rotation.z = pose.side * PILOT_POSE.wallLean * w;
  }
  if (s > 0.01) {
    avatar.lLeg.rotation.x = lerp(avatar.lLeg.rotation.x, PILOT_POSE.slideLead, s);
    avatar.rLeg.rotation.x = lerp(avatar.rLeg.rotation.x, PILOT_POSE.slideTrail, s);
    avatar.torso.rotation.x = lerp(avatar.torso.rotation.x, PILOT_POSE.slideBack, s);
  }
  const r = pose.rodeo;
  if (r > 0.01) {
    // Riding: the avatar faces the titan's back plate (its look follows the hull); it clings
    // with one knee up and leans in instead of hanging straight-legged behind it.
    avatar.lLeg.rotation.x = lerp(avatar.lLeg.rotation.x, PILOT_POSE.rodeoLead, r);
    avatar.rLeg.rotation.x = lerp(avatar.rLeg.rotation.x, PILOT_POSE.rodeoTrail, r);
    const lj = avatar.lLeg.userData?.joints, rj = avatar.rLeg.userData?.joints;
    if (lj?.knee) lj.knee.rotation.x = lerp(lj.knee.rotation.x, PILOT_POSE.rodeoLeadKnee, r);
    if (rj?.knee) rj.knee.rotation.x = lerp(rj.knee.rotation.x, PILOT_POSE.rodeoTrailKnee, r);
    avatar.torso.rotation.x = lerp(avatar.torso.rotation.x, PILOT_POSE.rodeoLean, r);
  }
  const F = TITANFALL_PLAYER_FLAGS, flags = state.flags | 0;
  const cloaked = !!(flags & (F.cloaked | F.ejectCloak));
  if (cloaked && avatar.fadeMaterials) {
    // Refraction stand-in: a faint body whose alpha ripples.
    const t = (Number.isFinite(state.now) ? state.now : 0) / 1000;
    const shimmer = PILOT_POSE.cloakShimmer * (0.5 + 0.5 * Math.sin(t * 9 + (avatar.group?.position?.x || 0)));
    setAvatarOpacity(avatar, (state.ally ? PILOT_POSE.cloakAlly : PILOT_POSE.cloakEnemy) + shimmer);
  }
  return { wallrun, slide, rodeo: r > 0.5, cloaked, side: pose.side, step };
}
