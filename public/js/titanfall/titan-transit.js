// Embark and disembark camera moves (docs/titanfall.md §7.2, Embark and disembark; storyboards
// docs/design/titanfall/transit/). A titanfall client module; presentation only, every trigger is an
// authoritative event or row (titan_embark / titan_disembark, the seat, the titan phase).
//
//  - Embark (own pilot): from the last on-foot view the camera follows the walk-in the others see
//    (titan-embark-path.js): run to the lowered palm, hop on, ride it up to the open chest and drop
//    into the seat, then hands over to the cockpit view. While the camera is outside, the own hull
//    is drawn whole (no cockpit overlay). The cockpit then plays its boot (titan-cockpit-fx.js).
//  - Disembark (own pilot): the cockpit stays where it was (anchored to the last cockpit view), the
//    hatch opens, and the camera leaves through the viewport and drops in an arc to the pilot's own
//    eye; a landing bump at the end. From the chase view it is a short blend.
//  - Disembark (other pilots): their avatar vaults out of the hatch in an arc onto the spot the
//    server placed them (AvatarRoster presentation hook via titanfall-client.js avatarState).
//
// `transitFor(vehicleId)` gives the cockpit its part: { mode: 'embark' | 'exit', t (s since start),
// u (0..1 of the move), anchor (Matrix4 world placement for the cabin, exit only) } or null.
import * as THREE from '../vendor/three.module.js';
import { isTitanType } from '../../../shared/titan-contract.js';
import { TITAN_RULES } from '../../../shared/vehicle-handling/titan.js';
import { embarkPath, EMBARK_PATH } from './titan-embark-path.js';

/** Tuning (seconds, metres, shake trauma). */
export const TITAN_TRANSIT = Object.freeze({
  embarkSeconds: TITAN_RULES.embark.animMs / 1000,
  embarkWait: 0.5,      // s the start pose holds while the embark phase has not reached the presented row yet
  bootSeconds: 2.3,     // s from the embark start until the cockpit boot is over (titan-cockpit-fx.js)
  handoff: 0.82,        // share of the embark lock where the camera reaches the seat eye
  cockpitFrom: 0.74,    // ... and from where the cockpit overlay is drawn again
  eyeHeight: 1.6, crouchDrop: 0.32,
  exitSeconds: 0.8, exitOut: 0.36,           // own disembark: total, share spent leaving the cabin
  exitForward: 1.9, exitRise: 0.28, exitHop: 1.1,
  exitCabin: 0.42,      // share of the exit with the anchored cabin still drawn
  chaseBlend: 0.35,     // s blend from a chase view
  landShake: 0.22, lockShake: 0.16,
  remoteSeconds: 0.65, remoteHop: 2.2,   // the arc's control point over the higher end: ~0.45 m rise off a 6 m hatch
});

let app = null;
const state = {
  foot: null,          // { pos, quat } last on-foot camera pose
  seat: null,          // { vehicleId, pos, quat, firstPerson } last seated camera pose in the own titan
  embark: null,        // { vehicleId, at, from, rigSeen, locked }
  exit: null,          // { vehicleId, at, from, firstPerson, anchor, landed }
  remote: new Map(),   // pilot id -> { vehicleId, at, from: [x, y, z] }
  view: null,          // VehicleView whose cockpitOverride we set
};
const _p = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _up = new THREE.Vector3(0, 1, 0);
const nowS = () => (globalThis.performance?.now?.() ?? Date.now()) / 1000;
const smooth = k => k * k * (3 - 2 * k);
const clamp01 = k => Math.max(0, Math.min(1, k));
const easeIn = k => k * k;
const selfId = () => (app?.myId != null ? String(app.myId) : null);
const pose = camera => ({ pos: camera.position.clone(), quat: camera.quaternion.clone() });

export function init(appRef) {
  app = appRef ?? null;
  const view = app?.vehicleView;
  if (view) { view.cockpitOverride = cockpitOverride; state.view = view; }
}

export function tick() {}

/** Seat (embark) and exit edges come from the authoritative events. */
export function onEvent(event) {
  if (!event || (event.kind !== 'titan_embark' && event.kind !== 'titan_disembark')) return;
  const id = event.id != null ? String(event.id) : null, vehicleId = event.vehicleId != null ? String(event.vehicleId) : null;
  if (!id || !vehicleId) return;
  const self = id === selfId(), at = nowS();
  if (event.kind === 'titan_embark') {
    if (self) state.embark = { vehicleId, at, from: state.foot, rigSeen: false, locked: false };
    return;
  }
  if (self) {
    state.embark = null;
    const seat = state.seat?.vehicleId === vehicleId ? state.seat : null;
    state.exit = seat ? { vehicleId, at, from: seat, firstPerson: seat.firstPerson, anchor: null, landed: false } : null;
    if (state.exit?.firstPerson) state.exit.anchor = new THREE.Matrix4().compose(seat.pos, seat.quat, new THREE.Vector3(1, 1, 1));
    return;
  }
  // Another pilot: vault out of that hull's hatch (the hull may be out of view: then no arc).
  const item = app?.vehicleView?.item?.(vehicleId);
  const mouth = item?.model?.anchors?.hatch;
  if (mouth) { item.root.updateMatrixWorld(true); state.remote.set(id, { vehicleId, at, from: mouth.getWorldPosition(_p).toArray() }); }
}

/**
 * The cockpit's view of a transit for one hull: { mode, t, u, anchor } or null (titan-cockpit-fx.js
 * reads it per frame: shutters, boot, glass, the exit's anchored cabin).
 */
export function transitFor(vehicleId) {
  const id = vehicleId != null ? String(vehicleId) : null;
  if (!id) return null;
  if (pinned && pinned.vehicleId === id) return { ...pinned.transit };
  const now = nowS();
  if (state.embark?.vehicleId === id) {
    const t = now - state.embark.at;
    if (t <= TITAN_TRANSIT.bootSeconds) return { mode: 'embark', t, u: clamp01(t / TITAN_TRANSIT.embarkSeconds), anchor: null };
  }
  if (state.exit?.vehicleId === id) {
    const t = now - state.exit.at;
    if (t <= TITAN_TRANSIT.exitSeconds) return { mode: 'exit', t, u: clamp01(t / TITAN_TRANSIT.exitSeconds), anchor: state.exit.anchor };
  }
  return null;
}

/**
 * VehicleView hook: whether the own titan's cockpit overlay draws (null = VehicleView decides).
 * Off while the embark camera is still outside, on for the first part of a first-person exit.
 */
function cockpitOverride(item, inside) {
  if (!item?.walker) return null;
  const id = String(item.id);
  if (inside && state.embark?.vehicleId === id && embarkActive()) return embarkU(item) >= TITAN_TRANSIT.cockpitFrom;
  if (!inside && state.exit?.vehicleId === id && state.exit.firstPerson) {
    return nowS() - state.exit.at < TITAN_TRANSIT.exitSeconds * TITAN_TRANSIT.exitCabin;
  }
  return null;
}

/** Progress of the walk-in on the presented rig (0 until the embark phase reaches the row). */
function embarkU(item) {
  const rig = item?.model?.rig;
  const u = Number.isFinite(rig?.embark) ? rig.embark : 0;
  if (u > 0) state.embark.rigSeen = true;
  // The rig rewinds when the phase ends: past it the walk-in is over.
  return state.embark.rigSeen && u === 0 ? 1 : u;
}

const embarkActive = () => !!state.embark && nowS() - state.embark.at < TITAN_TRANSIT.embarkSeconds + TITAN_TRANSIT.embarkWait + 0.4;

function lookQuat(from, target, out) {
  _m.lookAt(from, target, _up);
  return out.setFromRotationMatrix(_m);
}

/** Own embark: the camera rides the walk-in until it reaches the cockpit eye. */
function embarkCamera(camera, vc) {
  const e = state.embark;
  const row = vc.vehicle;
  if (!row || String(row.id) !== e.vehicleId) return false;
  const item = app.vehicleView?.item?.(e.vehicleId);
  if (!item?.model?.rig || !item.model.anchors?.palmL) return false;
  const T = TITAN_TRANSIT;
  const u = embarkU(item);
  const waited = nowS() - e.at;
  if (u >= T.handoff || (!e.rigSeen && waited > T.embarkSeconds + T.embarkWait)) return false;
  // The cockpit view this frame (VehicleCamera already posed it): where the move ends.
  const seatPos = _c.copy(camera.position), seatQuat = _q.copy(camera.quaternion);
  const from = e.from ?? { pos: seatPos.clone(), quat: seatQuat.clone() };
  item.root.updateMatrixWorld(true);
  const path = embarkPath(item, Math.max(u, 0));
  const eyeOf = p => _a.set(p.pos[0], p.pos[1] + T.eyeHeight - p.crouch * T.crouchDrop, p.pos[2]);
  const P = EMBARK_PATH;
  const chest = item.model.anchors.cockpit ?? item.model.anchors.seat;
  const chestAt = chest.getWorldPosition(_b);
  let pos, quat = new THREE.Quaternion();
  if (u < P.run) {
    // From where the pilot stood to the spot under the palm, turning to the chest.
    const k = smooth(u / P.run);
    const ready = embarkPath(item, P.run);
    pos = from.pos.clone().lerp(eyeOf(ready).clone(), k);
    lookQuat(pos, chestAt, quat);
    quat.copy(from.quat.clone().slerp(quat, k));
  } else if (u < P.ride) {
    // Hop on, ride the palm up: eyes on the open chest.
    pos = eyeOf(path).clone();
    lookQuat(pos, chestAt, quat);
  } else {
    // Step off into the cavity and settle into the seat eye.
    const k = smooth((u - P.ride) / (T.handoff - P.ride));
    pos = eyeOf(path).clone().lerp(seatPos, k);
    lookQuat(pos, chestAt, quat);
    quat.slerp(seatQuat, k);
  }
  camera.position.copy(pos);
  camera.quaternion.copy(quat);
  camera.updateMatrixWorld();
  return true;
}

/** Own exit: through the open viewport and down in an arc to the pilot's eye (already posed). */
function exitCamera(camera, t) {
  const x = state.exit, T = TITAN_TRANSIT;
  const target = pose(camera);
  if (!x.firstPerson) {
    const k = smooth(clamp01(t / T.chaseBlend));
    if (k >= 1) return false;
    camera.position.copy(x.from.pos).lerp(target.pos, k);
    camera.quaternion.copy(x.from.quat).slerp(target.quat, k);
    camera.updateMatrixWorld();
    return true;
  }
  const u = clamp01(t / T.exitSeconds);
  const fwd = _a.set(0, 0, -1).applyQuaternion(x.from.quat); fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
  fwd.normalize();
  const p0 = x.from.pos, p1 = p0.clone().addScaledVector(fwd, T.exitForward).addScaledVector(_up, T.exitRise);
  // Looking out and a little down while leaving the cabin.
  const outQuat = x.from.quat.clone().multiply(_q.setFromAxisAngle(_b.set(1, 0, 0), -0.22));
  if (u < T.exitOut) {
    const k = easeIn(u / T.exitOut);
    camera.position.copy(p0).lerp(p1, k);
    camera.quaternion.copy(x.from.quat).slerp(outQuat, smooth(u / T.exitOut));
  } else {
    const k = smooth((u - T.exitOut) / (1 - T.exitOut));
    const p2 = target.pos;
    const mid = p1.clone().lerp(p2, 0.5).addScaledVector(_up, T.exitHop);
    // Quadratic arc p1 -> mid -> p2.
    const a = p1.clone().lerp(mid, k), b = mid.clone().lerp(p2, k);
    camera.position.copy(a.lerp(b, k));
    camera.quaternion.copy(outQuat).slerp(target.quat, k);
  }
  camera.updateMatrixWorld();
  if (u >= 0.97 && !x.landed) { x.landed = true; app?.cameraShake?.add?.(T.landShake); }
  return u < 1;
}

/** Per frame, after the seat or pilot camera posed this frame's view. */
export function frame(dt, ctx = {}) {
  const camera = ctx.camera ?? app?.camera;
  const vc = app?.vehicleController;
  if (!camera || !vc) return;
  const now = nowS();
  const seated = !!vc.active, row = vc.vehicle;
  const ownTitan = seated && isTitanType(row?.type ?? row?.kind);
  if (state.embark && now - state.embark.at > TITAN_TRANSIT.bootSeconds) state.embark = null;
  if (state.exit && now - state.exit.at > TITAN_TRANSIT.exitSeconds) state.exit = null;
  for (const [id, entry] of state.remote) if (now - entry.at > TITAN_TRANSIT.remoteSeconds) state.remote.delete(id);
  // Embark: ride the walk-in (and the hatch lock bump once seated).
  if (state.embark && ownTitan && embarkActive()) {
    if (!embarkCamera(camera, vc) && !state.embark.locked && state.embark.rigSeen) {
      state.embark.locked = true;
      app?.cameraShake?.add?.(TITAN_TRANSIT.lockShake);
    }
  }
  // Exit: from the cockpit to the pilot's eye.
  let exiting = false;
  if (state.exit && !seated && app?.player?.alive !== false) exiting = exitCamera(camera, now - state.exit.at);
  // Remember the poses the next transit starts from (after any override, so a chained move is smooth).
  if (!seated && !exiting && app?.player?.alive !== false) state.foot = pose(camera);
  if (ownTitan && !(state.embark && embarkActive() && embarkU(app.vehicleView?.item?.(row.id)) < TITAN_TRANSIT.handoff)) {
    state.seat = { vehicleId: String(row.id), ...pose(camera), firstPerson: vc.view?.firstPerson === true && !vc.sightActive };
  }
}

/**
 * AvatarRoster hook for a remote pilot row (titanfall-client.js avatarState): while that pilot
 * just left a titan, the body vaults from the hatch in an arc onto its server spot.
 */
export function avatarState(row, avatar) {
  const entry = row?.id != null ? state.remote.get(String(row.id)) : null;
  if (!entry || !avatar?.group) return null;
  const T = TITAN_TRANSIT;
  const u = clamp01((nowS() - entry.at) / T.remoteSeconds);
  if (u >= 1) { state.remote.delete(String(row.id)); return null; }
  const to = avatar.group.position;
  const k = smooth(u);
  const from = entry.from;
  const peak = Math.max(from[1], to.y) + T.remoteHop;
  const y = (1 - k) * (1 - k) * from[1] + 2 * (1 - k) * k * peak + k * k * to.y;
  avatar.group.position.set(from[0] + (to.x - from[0]) * k, y, from[2] + (to.z - from[2]) * k);
  // Tucked in the air, arms out; straightening for the landing.
  const tuck = Math.sin(Math.min(1, u * 1.15) * Math.PI);
  if (avatar.lLeg) avatar.lLeg.rotation.x = -0.9 * tuck;
  if (avatar.rLeg) avatar.rLeg.rotation.x = -0.5 * tuck;
  if (avatar.lArm) avatar.lArm.rotation.x = -1.3 * tuck;
  if (avatar.rArm) avatar.rArm.rotation.x = -1.1 * tuck;
  if (avatar.torso) avatar.torso.rotation.x = 0.3 * tuck;
  return { vault: u };
}

/** True while a remote pilot's vault plays (tests). */
export const remoteVaulting = id => state.remote.has(String(id));

export function dispose() {
  if (state.view?.cockpitOverride === cockpitOverride) state.view.cockpitOverride = null;
  state.view = null;
  state.foot = state.seat = state.embark = state.exit = null;
  state.remote.clear();
  pinned = null;
  app = null;
}

/** Test hook: the internal state. */
export const transitState = () => state;

/**
 * Capture/test hook: hold one hull's cockpit transit at a fixed point ({ mode: 'embark' | 'exit',
 * t }); null releases it.
 */
let pinned = null;
export function pinTransit(vehicleId, transit = null) {
  if (vehicleId == null || !transit?.mode) { pinned = null; return; }
  const seconds = transit.mode === 'embark' ? TITAN_TRANSIT.embarkSeconds : TITAN_TRANSIT.exitSeconds;
  pinned = { vehicleId: String(vehicleId), transit: { mode: transit.mode, t: transit.t, u: clamp01(transit.t / seconds), anchor: null } };
}
