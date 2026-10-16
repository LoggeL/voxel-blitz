// Titan embark / disembark camera moves (public/js/titanfall/titan-transit.js; docs/titanfall.md §7.2,
// Embark and disembark) on a fake app, a fake titan rig and a stepped clock:
//   - embark: the camera starts at the last on-foot view, rides the walk-in (titan-embark-path.js) with
//     the eyes on the chest, has no jump on the way and lands exactly on the seat view at the handoff;
//     the cockpit overlay is off while the camera is outside
//   - hatch and boot (titan-embark-boot.js): two plate clunks, the hatch lock (slam, one shake) and the
//     power-on tone on the timeline's beats; nothing more after a disembark or a lost seat mid-hatch;
//     reduced motion keeps only the lock and the power-on; the timeline itself (plate order, the lock on
//     the server's embark lock, the screen and HUD stages, length, determinism, reduced motion, exit
//     plates clear before the camera leaves)
//   - cockpit transit view (transitFor): embark t/u, the exit with the anchored cabin
//   - first-person exit: leaves forward through the viewport, arcs above both ends, ends on the pilot
//     eye with one landing shake; the cabin stays drawn for the first part only
//   - chase-view exit: a short blend; other pilots vault out of the hatch in an arc onto their spot
import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import * as transit from '../public/js/titanfall/titan-transit.js';
import { TITAN_TRANSIT } from '../public/js/titanfall/titan-transit.js';
import { embarkPath, EMBARK_PATH } from '../public/js/titanfall/titan-embark-path.js';
import { EMBARK_BOOT, embarkBoot, exitHatch, embarkBeats } from '../public/js/titanfall/titan-embark-boot.js';
import { setDisplaySetting } from '../public/js/ui/display-settings.js';
import { TITAN_RULES } from '../shared/vehicle-handling/titan.js';

const checks = [];
const check = (name, fn) => { fn(); checks.push(name); };

// ---- clock, app, rig --------------------------------------------------------------------------
let clock = 1000;
Object.defineProperty(globalThis.performance, 'now', { value: () => clock * 1000, configurable: true, writable: true });
const advance = s => { clock += s; };

function fakeTitan() {
  const root = new THREE.Object3D();
  root.position.set(20, 0, 10);
  root.rotation.y = 0.4;
  const group = new THREE.Object3D();
  root.add(group);
  const node = (x, y, z) => { const o = new THREE.Object3D(); o.position.set(x, y, z); group.add(o); return o; };
  const anchors = { palmL: node(-3.2, 1.2, -1.4), cockpit: node(0, 6.2, 0.4), hatch: node(0, 6.4, -1.6) };
  const model = { group, anchors, rig: { embark: 0 }, skeleton: { def: { collider: { halfLength: 2.2 } }, hipL: [-1.1, 3, 0] } };
  root.updateMatrixWorld(true);
  return { id: 't1', walker: true, root, model };
}

const item = fakeTitan();
const shakes = [];
const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 900);
const vc = { active: false, vehicle: null, view: { firstPerson: true }, sightActive: false };
const vehicleView = { cockpitOverride: null, item: id => (String(id) === 't1' ? item : null) };
const sounds = [];
const vehicleAudio = { sfx: { vehicleReload: (pos, o) => sounds.push(o?.heavy ? 'plate' : 'reload'), vehicleHatch: (pos, o, type) => sounds.push(`hatch:${type}`) },
  titanCue: kind => sounds.push(`cue:${kind}`) };
const app = { myId: 'me', camera, vehicleController: vc, vehicleView, vehicleAudio, player: { alive: true }, cameraShake: { add: k => shakes.push(k) } };

// Within the embark reach (TITAN_RULES.embark.distance 6 m) of the hull.
const footPose = { pos: new THREE.Vector3(16, 1.6, 6), quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -0.6, 0)) };
const seatPose = { pos: new THREE.Vector3(20.3, 7.5, 9.4), quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.05, 0.4, 0)) };
// What VehicleCamera / the pilot camera posed this frame before titan-transit runs.
const posed = p => { camera.position.copy(p.pos); camera.quaternion.copy(p.quat); camera.updateMatrixWorld(); };
const frame = (p, dt = 1 / 60) => { advance(dt); posed(p); transit.frame(dt, { camera }); return camera.position.clone(); };
const seatIn = () => { vc.active = true; vc.vehicle = { id: 't1', type: 'titan_ion' }; };
const seatOut = () => { vc.active = false; vc.vehicle = null; };
const chestAt = () => item.model.anchors.cockpit.getWorldPosition(new THREE.Vector3());
const lookingAt = target => {
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  return fwd.dot(target.clone().sub(camera.position).normalize());
};

transit.init(app);

check('init installs the VehicleView cockpit override; dispose removes it', () => {
  assert.equal(typeof vehicleView.cockpitOverride, 'function');
  assert.equal(vehicleView.cockpitOverride({ walker: false, id: 'x' }, true), null, 'non-walker: VehicleView decides');
  assert.equal(vehicleView.cockpitOverride(item, true), null, 'no transit: VehicleView decides');
});

// ---- embark -------------------------------------------------------------------------------------
check('on foot the last view is remembered as the embark start', () => {
  seatOut();
  for (let i = 0; i < 5; i++) frame(footPose);
  assert.ok(transit.transitState().foot.pos.distanceTo(footPose.pos) < 1e-9);
});

check('embark: the seat comes first, the camera still stands where the pilot stood', () => {
  transit.onEvent({ kind: 'titan_embark', id: 'me', vehicleId: 't1' });
  seatIn();
  item.model.rig.embark = 0;
  const at = frame(seatPose);
  assert.ok(at.distanceTo(footPose.pos) < 1e-6, `camera at ${at.toArray()}`);
  assert.equal(vehicleView.cockpitOverride(item, true), false, 'no cockpit overlay while outside');
  const t = transit.transitFor('t1');
  assert.equal(t.mode, 'embark');
  assert.ok(t.t > 0 && t.t < 0.1 && t.anchor === null);
});

check('embark: rides the walk-in without a jump, eyes on the chest, onto the seat view at the handoff', () => {
  let last = camera.position.clone(), maxStep = 0, cockpitFlip = null;
  for (let u = 0.005; u <= TITAN_TRANSIT.handoff - 0.005 + 1e-9; u += 0.005) {
    item.model.rig.embark = u;
    const at = frame(seatPose, TITAN_TRANSIT.embarkSeconds * 0.005);
    maxStep = Math.max(maxStep, at.distanceTo(last));
    last = at;
    if (u > EMBARK_PATH.run + 0.01 && u < EMBARK_PATH.ride) {
      const path = embarkPath(item, u);
      assert.ok(Math.abs(at.y - (path.pos[1] + TITAN_TRANSIT.eyeHeight - path.crouch * TITAN_TRANSIT.crouchDrop)) < 1e-6, `eye over the path at u ${u}`);
      assert.ok(lookingAt(chestAt()) > 0.999, `looks at the chest at u ${u}`);
    }
    const drawn = vehicleView.cockpitOverride(item, true);
    if (drawn && cockpitFlip === null) cockpitFlip = u;
    if (cockpitFlip !== null) assert.equal(drawn, true, 'the overlay stays once it is on');
  }
  assert.ok(maxStep < 0.6, `largest camera step ${maxStep.toFixed(3)} m`);
  assert.ok(Math.abs(cockpitFlip - TITAN_TRANSIT.cockpitFrom) < 0.006, `cockpit drawn from u ${cockpitFlip}`);
  assert.ok(last.distanceTo(seatPose.pos) < 0.05, `ends ${last.distanceTo(seatPose.pos).toFixed(3)} m from the seat eye`);
  assert.equal(shakes.length, 0);
});

check('embark: past the handoff the seat camera is untouched; two plates clunk, the hatch locks (one shake), the screen powers on', () => {
  item.model.rig.embark = 0.9;
  const at = frame(seatPose);
  assert.ok(at.distanceTo(seatPose.pos) < 1e-9);
  assert.ok(camera.quaternion.angleTo(seatPose.quat) < 1e-9);
  assert.ok(transit.transitFor('t1').t < EMBARK_BOOT.plates[0][1], 'seated before the first plate is home');
  assert.deepEqual(shakes, []);
  assert.deepEqual(sounds, []);
  while (transit.transitFor('t1').t < EMBARK_BOOT.screen[0] + 0.05) frame(seatPose);
  assert.deepEqual(sounds, ['plate', 'plate', 'hatch:tank', 'cue:insert']);
  assert.deepEqual(shakes, [TITAN_TRANSIT.lockShake]);
  // The rig rewinds when the phase ends: the walk-in counts as done.
  item.model.rig.embark = 0;
  assert.ok(frame(seatPose).distanceTo(seatPose.pos) < 1e-9);
  assert.equal(vehicleView.cockpitOverride(item, true), true);
});

check('embark: the cockpit boot window closes after bootSeconds', () => {
  advance(TITAN_TRANSIT.bootSeconds);
  frame(seatPose);
  assert.equal(transit.transitFor('t1'), null);
  assert.equal(transit.transitState().embark, null);
  assert.equal(vehicleView.cockpitOverride(item, true), null);
});

check('embark without the rig ever moving gives the seat view back after the wait', () => {
  seatOut(); frame(footPose); seatIn();
  transit.onEvent({ kind: 'titan_embark', id: 'me', vehicleId: 't1' });
  item.model.rig.embark = 0;
  assert.ok(frame(seatPose).distanceTo(footPose.pos) < 1e-6);
  advance(TITAN_TRANSIT.embarkSeconds + TITAN_TRANSIT.embarkWait + 0.05);
  assert.ok(frame(seatPose).distanceTo(seatPose.pos) < 1e-9);
  advance(TITAN_TRANSIT.bootSeconds); frame(seatPose);
});

check('embark cut short by a disembark mid-hatch: no lock and no power-on, the exit takes over', () => {
  sounds.length = 0; shakes.length = 0;
  transit.onEvent({ kind: 'titan_embark', id: 'me', vehicleId: 't1' });
  advance(EMBARK_BOOT.plates[1][1] + 0.01); frame(seatPose);
  assert.deepEqual(sounds, ['plate', 'plate']);
  transit.onEvent({ kind: 'titan_disembark', id: 'me', vehicleId: 't1' });
  assert.equal(transit.transitState().embark, null);
  assert.equal(transit.transitFor('t1').mode, 'exit');
  for (let i = 0; i < 40; i++) frame(seatPose);
  assert.deepEqual(sounds, ['plate', 'plate']);
  assert.deepEqual(shakes, []);
  advance(1); frame(seatPose);
});

check('embark cut short by death (the seat is gone) mid-hatch: no further beats', () => {
  sounds.length = 0; shakes.length = 0;
  transit.onEvent({ kind: 'titan_embark', id: 'me', vehicleId: 't1' });
  advance(EMBARK_BOOT.plates[0][1] + 0.01); frame(seatPose);
  assert.deepEqual(sounds, ['plate']);
  seatOut(); app.player.alive = false;
  for (let i = 0; i < 40; i++) frame(footPose, 0.02);
  assert.deepEqual(sounds, ['plate']);
  assert.deepEqual(shakes, []);
  app.player.alive = true;
  advance(TITAN_TRANSIT.bootSeconds); frame(footPose);
  assert.equal(transit.transitState().embark, null);
  seatIn();
});

check('reduced motion: no plate clunks; the lock and the power-on still sound', () => {
  setDisplaySetting('reducedMotion', true);
  try {
    sounds.length = 0; shakes.length = 0;
    transit.onEvent({ kind: 'titan_embark', id: 'me', vehicleId: 't1' });
    for (let t = 0; t < EMBARK_BOOT.screen[0] + 0.05; t += 1 / 30) frame(seatPose, 1 / 30);
    assert.deepEqual(sounds, ['hatch:tank', 'cue:insert']);
    assert.deepEqual(shakes, [TITAN_TRANSIT.lockShake]);
  } finally { setDisplaySetting('reducedMotion', false); }
  advance(TITAN_TRANSIT.bootSeconds); frame(seatPose);
});

// ---- hatch and boot timeline (titan-embark-boot.js) ----------------------------------------------
check('boot timeline: left plates first, the right plate last, locked on the server embark lock', () => {
  const B = EMBARK_BOOT, embark = TITAN_RULES.embark.animMs / 1000;
  assert.ok(Math.abs(B.lock - embark - 0.06) < 1e-9, `lock ${B.lock} = embark lock + presentation delay`);
  assert.ok(B.plates[0][0] >= TITAN_TRANSIT.cockpitFrom * embark, 'the first plate moves once the cockpit is drawn');
  for (let i = 1; i < 3; i++) assert.ok(B.plates[i][0] > B.plates[i - 1][0] && B.plates[i][1] > B.plates[i - 1][1], `plate ${i} after plate ${i - 1}`);
  assert.equal(B.plates[2][1], B.lock, 'the last plate home is the lock');
  assert.ok(B.screen[0] > B.lock && B.keys[0] >= B.screen[0], 'dark for a moment, then power with the screen');
  assert.ok(B.keys[0] < B.screens[0] && B.screens[0] < B.pods[0] && B.pods[0] < B.glassHud[0], 'MFDs, pods, glass HUD one after another');
  assert.ok(B.glassHud[1] < B.end && B.screen[1] < B.end && B.banner[3] <= B.end);
  const length = B.end - B.plates[0][0];
  assert.ok(length >= 1.2 && length <= 1.8, `sequence ${length.toFixed(2)} s`);
  assert.equal(TITAN_TRANSIT.bootSeconds, B.end);
});

check('boot timeline: plates, seams, screen and power at each beat; deterministic', () => {
  const B = EMBARK_BOOT;
  const before = embarkBoot(B.plates[0][0] - 0.01);
  assert.equal(before.plates.visible, false);
  assert.deepEqual(before.plates.closed, [0, 0, 0]);
  const first = embarkBoot((B.plates[0][0] + B.plates[0][1]) / 2);
  assert.ok(first.plates.visible && first.plates.closed[0] > 0 && first.plates.closed[0] < 1 && first.plates.closed[2] === 0);
  const locked = embarkBoot(B.lock);
  assert.deepEqual(locked.plates.closed, [1, 1, 1]);
  assert.ok(locked.plates.visible && locked.seams > 0.99 && locked.screen === -1);
  assert.ok(embarkBoot(B.lock + 0.04).power.shell < 0.42, 'dark once locked');
  const line = embarkBoot(B.screen[0] + 0.01);
  assert.ok(line.screen >= 0 && line.screen < 0.1 && !line.plates.visible, 'the screen takes the viewport from black');
  assert.equal(embarkBoot(B.screen[1] + 0.01).screen, -1, 'plain glass after the power-on');
  const done = embarkBoot(B.end);
  assert.deepEqual(Object.values(done.power), [1, 1, 1, 1, 1, 1]);
  assert.equal(done.banner.alpha, 0);
  assert.ok(embarkBoot(B.banner[0] + 0.1).banner.lines.includes('NEURAL LINK'));
  assert.ok(embarkBoot(B.banner[1] + 0.1).banner.lines.includes('PILOT ONLINE'));
  for (let t = 0; t < B.end; t += 0.013) {
    assert.equal(JSON.stringify(embarkBoot(t)), JSON.stringify(embarkBoot(t)), `deterministic at ${t}`);
    assert.equal(embarkBoot(t).dim, 0);
  }
});

check('boot timeline under reduced motion: no plates, no line, no band, a steady dim and fade', () => {
  const B = EMBARK_BOOT;
  let last = null, peak = 0;
  for (let t = 0; t <= B.end + 0.01; t += 0.01) {
    const b = embarkBoot(t, { reduced: true });
    assert.equal(b.plates.visible, false);
    assert.equal(b.screen, -1);
    assert.equal(b.band, -1);
    peak = Math.max(peak, b.dim);
    if (last && t > B.lock) for (const key of ['keys', 'screens', 'pods', 'glassHud']) assert.ok(b.power[key] >= last.power[key] - 1e-9, `${key} rises steadily at ${t.toFixed(2)}`);
    last = b;
  }
  assert.ok(peak > 0.99 && embarkBoot(B.end, { reduced: true }).dim === 0, 'dims and fades back');
});

check('exit: the screen cuts, the plates part right first and clear the viewport before the camera gets there', () => {
  const X = EMBARK_BOOT.exit;
  assert.deepEqual(exitHatch(0).plates.closed, [1, 1, 1]);
  assert.equal(exitHatch(0).screen, 0);
  assert.equal(exitHatch(X.cut + 0.01).screen, -1);
  assert.ok(X.plates[2][0] < X.plates[1][0] && X.plates[1][0] < X.plates[0][0], 'right, lower left, upper left');
  const clear = Math.max(...X.plates.map(w => w[1]));
  assert.deepEqual(exitHatch(clear).plates.closed, [0, 0, 0]);
  assert.equal(exitHatch(clear).plates.visible, false);
  // The camera leaves easing in over exitOut of the exit (titan-transit.js); the shallowest cabin's glass is 1 m ahead.
  const T = TITAN_TRANSIT, reach = (clear / (T.exitSeconds * T.exitOut)) ** 2 * T.exitForward;
  assert.ok(reach < 0.95, `the camera is ${reach.toFixed(2)} m out when the plates are clear`);
  assert.equal(exitHatch(0, { reduced: true }).plates.visible, false);
});

check('boot beats: plate, plate, lock, screen once each however the frames fall', () => {
  assert.deepEqual(embarkBeats(-1, 10), ['plate', 'plate', 'lock', 'screen']);
  assert.deepEqual(embarkBeats(-1, 10, { reduced: true }), ['lock', 'screen']);
  for (const step of [1 / 144, 1 / 30, 0.25]) {
    const all = [];
    for (let t = 0; t < 3; t += step) all.push(...embarkBeats(t - step, t));
    assert.deepEqual(all, ['plate', 'plate', 'lock', 'screen'], `frame step ${step}`);
  }
});

// ---- first-person exit --------------------------------------------------------------------------
const pilotEye = { pos: new THREE.Vector3(17.5, 1.6, 6.5), quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.4, 0)) };

check('first-person exit: out through the viewport, an arc above both ends, onto the pilot eye', () => {
  shakes.length = 0;
  for (let i = 0; i < 4; i++) frame(seatPose);
  transit.onEvent({ kind: 'titan_disembark', id: 'me', vehicleId: 't1' });
  const x = transit.transitState().exit;
  assert.ok(x?.firstPerson && x.anchor instanceof THREE.Matrix4, 'anchored cabin');
  const anchorPos = new THREE.Vector3().setFromMatrixPosition(x.anchor);
  assert.ok(anchorPos.distanceTo(seatPose.pos) < 1e-9, 'the cabin stays at the last cockpit view');
  const view = transit.transitFor('t1');
  assert.equal(view.mode, 'exit');
  assert.equal(view.anchor, x.anchor);
  seatOut();
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(seatPose.quat).setY(0).normalize();
  const steps = Math.round(TITAN_TRANSIT.exitSeconds * 60);
  let last = null, maxStep = 0, peak = -Infinity, firstOut = null, cabinOff = null;
  for (let i = 0; i < steps; i++) {
    const at = frame(pilotEye);
    const t = clock - x.at;
    if (last) maxStep = Math.max(maxStep, at.distanceTo(last));
    last = at;
    peak = Math.max(peak, at.y);
    if (firstOut === null && t > 0.05) firstOut = at.clone().sub(seatPose.pos).dot(fwd);
    if (cabinOff === null && vehicleView.cockpitOverride(item, false) === false) cabinOff = t;
  }
  assert.ok(firstOut > 0, 'leaves forward, through the glass');
  assert.ok(peak > seatPose.pos.y, `arc peak ${peak.toFixed(2)} above the seat eye`);
  assert.ok(maxStep < 0.6, `largest camera step ${maxStep.toFixed(3)} m`);
  assert.ok(Math.abs(cabinOff - TITAN_TRANSIT.exitSeconds * TITAN_TRANSIT.exitCabin) < 0.03, `cabin hidden at ${cabinOff}`);
  advance(0.05);
  const end = frame(pilotEye);
  assert.ok(end.distanceTo(pilotEye.pos) < 1e-9, 'pilot camera untouched after the exit');
  assert.deepEqual(shakes, [TITAN_TRANSIT.landShake]);
  assert.equal(transit.transitFor('t1'), null);
});

check('chase-view exit: a short blend from the chase pose', () => {
  shakes.length = 0;
  vc.view.firstPerson = false;
  seatIn();
  const chase = { pos: new THREE.Vector3(22, 10, 18), quat: new THREE.Quaternion() };
  for (let i = 0; i < 3; i++) frame(chase);
  transit.onEvent({ kind: 'titan_disembark', id: 'me', vehicleId: 't1' });
  assert.equal(transit.transitState().exit.firstPerson, false);
  assert.equal(transit.transitState().exit.anchor, null);
  seatOut();
  const mid = frame(pilotEye, TITAN_TRANSIT.chaseBlend / 2);
  assert.ok(mid.distanceTo(chase.pos) > 0.5 && mid.distanceTo(pilotEye.pos) > 0.5, 'between the two views');
  assert.equal(vehicleView.cockpitOverride(item, false), null, 'no anchored cabin from the chase view');
  advance(TITAN_TRANSIT.chaseBlend);
  assert.ok(frame(pilotEye).distanceTo(pilotEye.pos) < 1e-9);
  assert.equal(shakes.length, 0);
  vc.view.firstPerson = true;
  advance(1); frame(pilotEye);
});

// ---- other pilots ------------------------------------------------------------------------------
check('another pilot vaults out of the hatch in an arc onto the server spot', () => {
  transit.onEvent({ kind: 'titan_disembark', id: 'other', vehicleId: 't1' });
  assert.equal(transit.remoteVaulting('other'), true);
  const hatch = item.model.anchors.hatch.getWorldPosition(new THREE.Vector3());
  const spot = new THREE.Vector3(14, 0, 4);
  const avatar = { group: new THREE.Object3D(), lLeg: new THREE.Object3D(), rLeg: new THREE.Object3D(), lArm: new THREE.Object3D(), rArm: new THREE.Object3D(), torso: new THREE.Object3D() };
  const sample = () => { avatar.group.position.copy(spot); const s = transit.avatarState({ id: 'other' }, avatar); return { s, at: avatar.group.position.clone() }; };
  const first = sample();
  assert.ok(first.at.distanceTo(hatch) < 0.05, 'starts at the hatch');
  advance(TITAN_TRANSIT.remoteSeconds * 0.27);
  const rise = sample();
  assert.ok(rise.at.y > hatch.y + 0.2, `vaults up off the hatch (${(rise.at.y - hatch.y).toFixed(2)} m)`);
  assert.ok(avatar.lLeg.rotation.x < -0.3, 'tucked legs');
  advance(TITAN_TRANSIT.remoteSeconds * 0.5);
  const fall = sample();
  assert.ok(fall.at.y < hatch.y && fall.at.y > spot.y, 'drops toward the spot');
  advance(TITAN_TRANSIT.remoteSeconds * 0.23 + 0.01);
  assert.equal(sample().s, null);
  assert.equal(transit.remoteVaulting('other'), false);
  assert.equal(transit.avatarState({ id: 'nobody' }, avatar), null);
});

check('events of other kinds or without ids are ignored', () => {
  transit.onEvent({ kind: 'titan_disembark', id: null, vehicleId: 't1' });
  transit.onEvent({ kind: 'kill', id: 'me', vehicleId: 't1' });
  assert.equal(transit.transitState().exit, null);
  assert.equal(transit.transitState().embark, null);
});

check('pinTransit holds a cockpit transit for captures and releases it', () => {
  transit.pinTransit('t1', { mode: 'exit', t: 0.4 });
  const pinned = transit.transitFor('t1');
  assert.equal(pinned.mode, 'exit');
  assert.ok(Math.abs(pinned.u - 0.4 / TITAN_TRANSIT.exitSeconds) < 1e-9);
  transit.pinTransit(null);
  assert.equal(transit.transitFor('t1'), null);
});

check('dispose clears the hook and the state', () => {
  transit.dispose();
  assert.equal(vehicleView.cockpitOverride, null);
  const s = transit.transitState();
  assert.equal(s.foot, null); assert.equal(s.seat, null); assert.equal(s.remote.size, 0);
});

console.log(`titanfall transit: ${checks.length} checks passed`);
