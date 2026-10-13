// Titanfall pilot wrist display (docs/titanfall.md §8.7 "Wrist display"): the tactical
// timers of the HUD model over the wrist fixtures, the quantised screen face (tones,
// cells, timer, REEL, IN RANGE gating, touch without key, the compact face), when the
// wrist is worn, the IN RANGE probe against the server's grapple rules, the slab pose
// facing the eye, and PilotWrist on a real ViewmodelRig: placement on the left
// forearm, the stand-in fist for one-handed weapons (chosen per weapon, following the
// gun, eased to the reload hand), the ADS and off-screen handback, every pilot weapon
// at desktop / landscape / portrait, the change-only redraw throttle, the live flag,
// titan-ui's body flag and the CSS rule it drives, and dispose.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from '../public/js/vendor/three.module.js';
import { installFakeDom } from './lib/conquest-ui-dom.mjs';

const checks = [];
const check = (name, fn) => { fn(); checks.push(name); };

const { decodeTitanfallSelf, TITAN_PILOT_PRIMARIES, TITAN_PILOT_AT, TITAN_PILOT_SIDEARM, TITAN_PILOT_MELEE } = await import('../shared/titan-contract.js');
const { WEAPONS } = await import('../shared/combatmath.js');
const { PILOT_RULES } = await import('../shared/pilot-movement.js');
const { titanHudModel } = await import('../public/js/titanfall/titan-hud-state.js');
const { WRIST_STATES, wristFixture } = await import('../public/js/capture/titanfall-wrist-fixtures.js');
const wristMod = await import('../public/js/titanfall/pilot-wrist.js');
const { PILOT_WRIST, PilotWrist, wristFace, drawWristFace, wristShown, wristLive, wristShownAt, resetWrist, grappleInRange, wristPose, weaponShift,
  wristHousingGeometry } = wristMod;
const { ViewmodelRig } = await import('../public/js/guns/viewmodel.js');

const KEYS = { pilotTactical: 'Q' };
const modelOf = (id, { keys = KEYS, touch = false } = {}) => {
  const f = wristFixture(id);
  return titanHudModel({ snapshot: f.snapshot, selfRow: f.self, tfs: decodeTitanfallSelf(f.tfs), now: f.now, keys, local: { touch } });
};
const tacticalOf = (id, options) => modelOf(id, options).pilot.tactical;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

check('tactical model timers over every wrist fixture', () => {
  for (const s of WRIST_STATES) {
    const t = tacticalOf(s.id), e = s.expect;
    assert.equal(t.id, s.tactical, s.id);
    if ('state' in e) assert.equal(t.state, e.state, `${s.id} state`);
    if ('charges' in e) assert.equal(t.charges, e.charges, `${s.id} charges`);
    if ('reeling' in e) assert.equal(t.reeling, e.reeling, `${s.id} reeling`);
    if ('cooldownLeft' in e) {
      if (e.cooldownLeft == null) assert.equal(t.cooldownLeft, null, `${s.id} full: no cooldown`);
      else assert.ok(near(t.cooldownLeft, e.cooldownLeft, 0.01), `${s.id} cooldownLeft ${t.cooldownLeft}`);
    }
    if ('activeLeft' in e) assert.ok(near(t.activeLeft, e.activeLeft, 0.01), `${s.id} activeLeft ${t.activeLeft}`);
    if (t.state === 'active' && t.id !== 'grapple') {
      assert.ok(near(t.activeFrac, t.activeLeft / PILOT_RULES[t.id].seconds, 1e-9), `${s.id} activeFrac`);
    } else {
      assert.equal(t.activeLeft, null, `${s.id} not running`);
      assert.equal(t.activeFrac, 0);
    }
  }
  // The grapple timer is the next charge's recharge (rules), stim/cloak count the cooldown span.
  assert.ok(near(tacticalOf('grapple-0').cooldownLeft, 0.8 * PILOT_RULES.grapple.recharge, 0.01));
  assert.ok(near(tacticalOf('cloak-cooldown').cooldownLeft, 0.45 * PILOT_RULES.cloak.cooldown, 0.01));
  assert.equal(tacticalOf('stim-ready').cooldownLeft, null);
});

check('wrist face: tones, cells, timer, status, key', () => {
  const face = id => wristFace(tacticalOf(id), { inRange: !!WRIST_STATES.find(s => s.id === id).inRange });
  const two = face('grapple-2');
  assert.deepEqual([two.tone, two.glyph, two.label, two.key, two.timer, two.status, two.drain], ['ready', 'grapple', 'GRAPPLE', 'Q', null, 'READY', false]);
  assert.deepEqual(two.cells, [1, 1]);
  const one = face('grapple-1');
  assert.deepEqual([one.tone, one.timer, one.status], ['ready', '3.3', null], 'one charge recharging: amber with the next-charge timer');
  assert.deepEqual(one.cells, [1, 0.45]);
  const zero = face('grapple-0');
  assert.deepEqual([zero.tone, zero.timer], ['cool', '4.8'], 'no charge: dimmed');
  assert.deepEqual(zero.cells, [0.2, 0]);
  const reel = face('grapple-reel');
  assert.deepEqual([reel.tone, reel.label, reel.status, reel.timer], ['reel', 'REELING', 'REEL', null], 'reeling: cable chevrons, no timer');
  const stim = face('stim-active');
  assert.deepEqual([stim.tone, stim.drain, stim.timer, stim.cells.length], ['stim', true, '2.8', 1], 'stim draining with its time left');
  const cloak = face('cloak-active');
  assert.deepEqual([cloak.tone, cloak.drain, cloak.timer], ['cloak', true, '2.0']);
  const cooling = face('cloak-cooldown');
  assert.deepEqual([cooling.tone, cooling.timer, cooling.status, cooling.label], ['cool', '6.8', null, 'CLOAK'], 'timer rounds up to 0.1 s');
  assert.deepEqual([face('stim-ready').tone, face('stim-ready').status], ['ready', 'READY']);
  // Cells quantise (40 steps): a sub-step recharge does not change the face.
  const t = tacticalOf('grapple-1');
  assert.deepEqual(wristFace({ ...t, pips: [1, 0.451] }).cells, wristFace(t).cells);
  // Touch: no key cap (the GRAPPLE button names the action).
  assert.equal(wristFace(tacticalOf('grapple-2', { touch: true }), { touch: true }).key, '');
  assert.equal(wristFace(null), null);
});

check('IN RANGE shows only on a ready grapple', () => {
  assert.equal(wristFace(tacticalOf('grapple-range'), { inRange: true }).inRange, true);
  assert.equal(wristFace(tacticalOf('grapple-0'), { inRange: true }).inRange, false, 'no charge: no tag');
  assert.equal(wristFace(tacticalOf('grapple-reel'), { inRange: true }).inRange, false, 'reeling: no tag');
  assert.equal(wristFace(tacticalOf('stim-ready'), { inRange: true }).inRange, false, 'stim: no tag');
});

check('grappleInRange: the server grapple test on voxels (range, release from the chest, line of sight)', () => {
  const { range, release, chest } = PILOT_RULES.grapple;
  const wallAt = x => (bx, by, bz) => bx === x && by >= 0 && by < 8 && bz >= -4 && bz <= 4;
  const feet = { x: 0.5, y: 0, z: 0.5 };
  const eye = new THREE.Vector3(0.5, 1.62, 0.5), dir = new THREE.Vector3(1, 0, 0);
  assert.equal(grappleInRange(wallAt(10), eye, dir, feet), true);
  assert.equal(grappleInRange(wallAt(10), eye, dir), true, 'feet default to EYE_HEIGHT under the eye');
  assert.equal(grappleInRange(wallAt(Math.ceil(range) + 3), eye, dir, feet), false, 'past the cable');
  assert.ok(release >= 1);
  assert.equal(grappleInRange(wallAt(1), eye, dir, feet), false, 'closer than the release distance');
  // Release is measured from the anchor to the chest (feet + chest), as the server does: a ceiling 1.33 m over the
  // eye is refused from feet under the eye, taken from feet a metre lower.
  const ceiling = (bx, by) => by === 3 && Math.abs(bx) < 10;
  const up = new THREE.Vector3(0, 1, 0);
  assert.ok(3 - 0.05 - chest < release && 3 - 0.05 - (chest - 1) >= release);
  assert.equal(grappleInRange(ceiling, eye, up, feet), false, 'overhead, chest too close');
  assert.equal(grappleInRange(ceiling, eye, up, { x: 0.5, y: -1, z: 0.5 }), true, 'overhead, chest a metre lower');
  // The pull's line runs from the head (feet + head), not the eye: a leaned eye sees the wall past a block the
  // head-to-anchor line crosses.
  const leanEye = new THREE.Vector3(0.5, 1.62, 1.5);
  const blocked = (bx, by, bz) => (bx === 10 && by >= 0 && by < 8 && bz >= -4 && bz <= 4) || (bx >= 4 && bx <= 6 && by === 1 && bz === 0);
  assert.equal(grappleInRange(blocked, leanEye, dir, { x: 0.5, y: 0, z: 1.5 }), true, 'head line clear');
  assert.equal(grappleInRange(blocked, leanEye, dir, feet), false, 'head line blocked');
  assert.equal(grappleInRange(() => false, eye, dir, feet), false, 'open sky');
  assert.equal(grappleInRange(null, eye, dir), false);
});

check('worn only on foot as a pilot', () => {
  const pilot = modelOf('grapple-2');
  assert.equal(pilot.layout, 'pilot');
  assert.equal(wristShown(pilot), true);
  assert.equal(wristShown(pilot, { spectating: true }), false, 'spectating someone else');
  for (const layout of ['titan', 'embark', 'dead', 'hidden']) assert.equal(wristShown({ ...pilot, layout }), false, layout);
  assert.equal(wristShown({ layout: 'pilot', pilot: {} }), false, 'no tactical');
  assert.equal(wristShown(null), false);
});

check('pose: the glass faces the eye and sits off the sleeve', () => {
  const wrist = new THREE.Vector3(-0.12, -0.18, -0.4);
  const axis = new THREE.Vector3(-0.3, -0.35, 0.88).normalize();
  const back = new THREE.Vector3(0, 1, 0).addScaledVector(axis, -axis.y).normalize();
  const pose = wristPose(wrist, axis, back, {});
  const toEye = pose.position.clone().negate().normalize();
  assert.ok(pose.normal.dot(toEye) > 0.85, `glass normal toward the eye (${pose.normal.dot(toEye).toFixed(3)})`);
  const x = new THREE.Vector3(1, 0, 0).applyQuaternion(pose.quaternion);
  assert.ok(x.x > 0.6, 'screen text reads left to right');
  const y = new THREE.Vector3(0, 1, 0).applyQuaternion(pose.quaternion);
  assert.ok(y.y > 0.3, 'screen top is up');
  // Clear of the sleeve: centre farther from the forearm axis than its radius.
  const rel = pose.position.clone().sub(wrist);
  const radial = rel.clone().addScaledVector(axis, -rel.dot(axis)).length();
  assert.ok(radial > PILOT_WRIST.radius, `off the sleeve (${radial.toFixed(3)} m)`);
  const shifted = wristPose(wrist, axis, back, {}, { shift: -0.05 });
  assert.ok(near(shifted.position.distanceTo(pose.position), 0.05, 1e-6), 'shift moves along the screen x');
  assert.equal(weaponShift('rifle', 1), 0);
  assert.ok(near(weaponShift('mgl', 0), PILOT_WRIST.weaponShift.mgl[0]) && near(weaponShift('mgl', 1), PILOT_WRIST.weaponShift.mgl[1]));
  const housing = wristHousingGeometry();
  assert.ok(housing.attributes.position.count / 3 < 200, 'housing stays a handful of triangles');
  housing.dispose();
});

const pose = Object.freeze({ speed: 0, grounded: true, aimSwayScale: 0 });
const settle = (rig, wrist, tactical, options = {}, frames = 120) => {
  for (let i = 0; i < frames; i++) {
    wrist.update(tactical, { show: true, nowMs: i * 1000 / 60, viewHeight: 1080, ...options });
    rig.update(1 / 60, pose);
  }
};

check('without a document: no canvas, the slab still places', () => {
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 100);
  const rig = new ViewmodelRig(camera);
  const wrist = new PilotWrist();
  try {
    assert.equal(wrist.tex, null);
    assert.equal(wrist.attach(rig), true);
    assert.equal(rig.armGear, wrist);
    rig.setWeapon('rifle');
    settle(rig, wrist, tacticalOf('grapple-1'));
    assert.equal(wrist.group.visible, true, 'rifle: slab on the support forearm');
    assert.equal(wrist.debug().face.timer, '3.3');
  } finally { wrist.dispose(); rig.dispose(); }
  assert.equal(rig.armGear, null, 'dispose detaches');
});

const dom = installFakeDom({ width: 1920, height: 1080 });

const leftArm = rig => rig._arms.arms.find(arm => arm.side < 0);
const screenOf = (wrist, camera, w, h) => { camera.updateMatrixWorld(true); return wrist.screenBox(camera, w, h); };
const insideShare = (box, w, h) => {
  const ix = Math.max(0, Math.min(w, box.left + box.width) - Math.max(0, box.left));
  const iy = Math.max(0, Math.min(h, box.top + box.height) - Math.max(0, box.top));
  return ix * iy / (box.width * box.height);
};

check('on a ViewmodelRig: forearm, stand-in fist, hidden when not worn', () => {
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 100);
  const rig = new ViewmodelRig(camera);
  const wrist = new PilotWrist();
  try {
    assert.ok(wrist.tex, 'canvas texture under a document');
    wrist.attach(rig);
    assert.equal(wrist.group.parent, rig.root);
    assert.equal(wrist.offHand.parent, rig.comp, 'stand-in fist rides the grip-pivot frame');
    let meshes = 0;
    wrist.group.traverse(node => { if (node.isMesh) meshes++; });
    assert.equal(meshes, 2, 'two draws: housing and screen');
    rig.setWeapon('rifle');
    settle(rig, wrist, tacticalOf('grapple-2'));
    assert.equal(wrist.group.visible, true);
    assert.equal(wrist.live, true, 'on screen at the hip: live');
    assert.equal(wrist.debug().offHand, false, 'two-handed weapon: the real support hand');
    assert.ok(wrist.group.position.z < 0, 'ahead of the eye');
    const box = screenOf(wrist, camera, 1920, 1080);
    assert.ok(box.left > 0 && box.left + box.width < 1920 && box.top > 540 && box.top + box.height < 1080,
      `whole glass on screen, lower half (${JSON.stringify(box)})`);
    assert.ok(box.width > 110 && box.height > 80, 'readable at 1080p, FOV 75');
    assert.equal(wrist.compact, false, 'full face at 1080p');
    rig.setWeapon('smg');
    settle(rig, wrist, tacticalOf('grapple-2'));
    assert.equal(wrist.group.visible, true, 'one-handed SMG: the slab still shows');
    assert.equal(wrist.debug().offHand, true, 'on the stand-in left fist');
    assert.equal(wrist.offHandGlove.visible, true);
    // Not worn (titan layout, spectating): slab, fist and the borrowed left arm go.
    settle(rig, wrist, null, { show: false }, 4);
    assert.equal(wrist.group.visible, false);
    assert.equal(wrist.offHandGlove.visible, false);
    assert.equal(rig._arms.offHand, null, 'not worn: no stand-in offered');
    assert.equal(leftArm(rig).segments.forearm.visible, false, 'one-handed gun, wrist off: no handless left sleeve');
    assert.equal(wrist.live, false);
  } finally { wrist.dispose(); rig.dispose(); }
});

check('ADS: the support-arm slab hands back to the chip, the stand-in fist follows the gun', () => {
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 100);
  const rig = new ViewmodelRig(camera);
  const wrist = new PilotWrist();
  try {
    wrist.attach(rig);
    for (const id of ['rifle', 'shotgun', 'chargerifle']) {
      rig.setWeapon(id); rig.ads(0);
      settle(rig, wrist, tacticalOf('grapple-1'));
      assert.equal(wrist.live, true, `${id} hip: live`);
      rig.ads(1);
      settle(rig, wrist, tacticalOf('grapple-1'), {}, 60);
      assert.ok(rig.currentAdsT01 > PILOT_WRIST.adsHandback);
      assert.equal(wrist.live, false, `${id} ADS: the receiver covers the slab, the chip takes over`);
      assert.equal(wristShownAt(), -Infinity, `${id} ADS: live flag cleared at once`);
      rig.ads(0);
      settle(rig, wrist, tacticalOf('grapple-1'), {}, 60);
      assert.equal(wrist.live, true, `${id} back to the hip`);
    }
    rig.setWeapon('smg'); rig.ads(0);
    settle(rig, wrist, tacticalOf('grapple-1'));
    const hipFist = wrist.offHand.position.clone();
    assert.ok(hipFist.distanceTo(wrist.offHandRest.position) < 0.01, 'hip rest: the fist sits at its guard pose');
    rig.ads(1);
    settle(rig, wrist, tacticalOf('grapple-1'), {}, 60);
    assert.ok(wrist.offHand.position.distanceTo(hipFist) > 0.01, 'ADS: the fist follows the gun (damped)');
    assert.equal(wrist.live, true, 'stand-in slab stays clear of the centred gun in ADS');
    const box = screenOf(wrist, camera, 1920, 1080);
    assert.ok(insideShare(box, 1920, 1080) > 0.99 && box.left + box.width < 960, `ADS stand-in glass left of centre (${JSON.stringify(box)})`);
  } finally { wrist.dispose(); rig.dispose(); }
});

check('reloads: two-handed guns never take the stand-in; one-handed ones ease without a slide; live only in view', () => {
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 100);
  const rig = new ViewmodelRig(camera);
  const wrist = new PilotWrist();
  try {
    wrist.attach(rig);
    for (const id of ['rifle', 'lmg', 'shotgun', 'smg', 'revolver']) {
      rig.setWeapon(id);
      settle(rig, wrist, tacticalOf('grapple-1'), {}, 150);
      const oneHanded = id === 'smg' || id === 'revolver';
      const def = WEAPONS[id];
      rig.reload(def.reloadTime, 'full', def.reloadStages ?? null);
      // The slab rides the forearm: per live frame it moves about as far as its seat on the forearm, never a jump of
      // its own.
      let prev = null, prevJoint = null, worst = 0, ghost = 0, eased = 0;
      const joint = new THREE.Vector3();
      for (let i = 0; i < Math.ceil(def.reloadTime * 60) + 30; i++) {
        wrist.update(tacticalOf('grapple-1'), { show: true, nowMs: 10_000 + i * 1000 / 60, viewHeight: 1080, weapon: id });
        rig.update(1 / 60, pose);
        if (!oneHanded && (wrist.offHandGlove.visible || rig._arms.offHandShare > 0)) ghost++;
        if (oneHanded && rig._arms.offHandShare < 0.95) eased++;
        const box = wrist.group.visible ? screenOf(wrist, camera, 1920, 1080) : null;
        if (wrist.live) assert.ok(insideShare(box, 1920, 1080) >= PILOT_WRIST.inView - 1e-6, `${id} frame ${i}: live only in view`);
        const forearm = leftArm(rig).segments.forearm;
        joint.set(0, 0, PILOT_WRIST.along / (forearm.scale.z || 1));
        forearm.localToWorld(joint).project(camera);
        const jointPx = { x: (joint.x + 1) * 960, y: (1 - joint.y) * 540 };
        if (box && prev && wrist.live) {
          const step = Math.hypot(box.left - prev.left, box.top - prev.top);
          const armStep = Math.hypot(jointPx.x - prevJoint.x, jointPx.y - prevJoint.y);
          worst = Math.max(worst, step - 1.25 * armStep);
        }
        prev = box && wrist.live ? box : null;
        prevJoint = jointPx;
      }
      assert.equal(ghost, 0, `${id}: no stand-in fist on a two-handed gun mid-reload`);
      if (oneHanded) assert.ok(eased > 0, `${id}: the reload hand takes the left arm`);
      assert.ok(worst < 25, `${id}: the live slab follows its wrist joint, no jump (${worst.toFixed(0)} px over)`);
    }
  } finally { wrist.dispose(); rig.dispose(); }
});

const PILOT_WEAPONS = [...TITAN_PILOT_PRIMARIES, ...TITAN_PILOT_AT, TITAN_PILOT_SIDEARM, TITAN_PILOT_MELEE];
const ONE_HANDED = ['smg', 'revolver', 'knife'];

check('every pilot weapon at desktop, phone landscape and phone portrait', () => {
  assert.equal(PILOT_WEAPONS.length, 11);
  const sizes = { desktop: [1920, 1080, false], landscape: [844, 390, true], portrait: [390, 844, true] };
  for (const [size, [w, h, touch]] of Object.entries(sizes)) {
    const camera = new THREE.PerspectiveCamera(75, w / h, 0.05, 100);
    const rig = new ViewmodelRig(camera);
    const wrist = new PilotWrist();
    try {
      wrist.attach(rig);
      for (const id of PILOT_WEAPONS) {
        rig.setWeapon(id);
        settle(rig, wrist, tacticalOf('grapple-1'), { touch, viewHeight: h, weapon: id });
        assert.equal(wrist.debug().offHand, ONE_HANDED.includes(id), `${size} ${id}: stand-in only without a support glove`);
        if (size !== 'portrait') assert.equal(wrist.live, true, `${size} ${id}: live`);
        if (!wrist.live) continue;
        const box = screenOf(wrist, camera, w, h);
        assert.equal(wrist.compact, box.width < PILOT_WRIST.compactPx, `${size} ${id}: compact face below compactPx (${box.width.toFixed(0)} px)`);
        if (size !== 'desktop') assert.equal(wrist.compact, true, `${size} ${id}: compact face on phones`);
        assert.ok(insideShare(box, w, h) >= PILOT_WRIST.inView, `${size} ${id}: in view`);
        if (touch && size === 'portrait') {
          assert.ok(box.top + box.height <= (1 - PILOT_WRIST.touchFloor) / 2 * h + 1, `${size} ${id}: above the touch buttons`);
        }
      }
    } finally { wrist.dispose(); rig.dispose(); }
  }
});

check('compact face: no key cap, IN RANGE as a frame, bigger type', () => {
  const t = tacticalOf('grapple-range');
  const face = wristFace(t, { inRange: true, compact: true });
  assert.deepEqual([face.compact, face.key, face.inRange], [true, '', true]);
  const wrist = new PilotWrist();
  try {
    wrist.compact = true;
    wrist.update(t, { nowMs: 0, inRange: true });
    const calls = wrist.tex.ctx.calls;
    const texts = calls.filter(c => c[0] === 'fillText').map(c => String(c[1]));
    assert.ok(!texts.includes('IN RANGE') && !texts.includes('Q'), `no tag, no key (${texts.join(' ')})`);
    assert.ok(calls.some(c => c[0] === 'strokeRect'), 'IN RANGE frame');
    wrist.compact = false;
    wrist.update(t, { nowMs: 1000, inRange: true });
    assert.equal(wrist.redraws, 2, 'compact <-> full redraws at once');
    assert.equal(wrist.face.key, 'Q', 'full face: the key cap is back');
  } finally { wrist.dispose(); }
});

check('redraws only on change, throttled for cell and timer motion', () => {
  const wrist = new PilotWrist();
  try {
    const t = tacticalOf('grapple-1');
    wrist.update(t, { nowMs: 0 });
    assert.equal(wrist.redraws, 1);
    const ctx = wrist.tex.ctx;
    const texts = ctx.calls.filter(c => c[0] === 'fillText').map(c => String(c[1]));
    assert.ok(texts.includes('GRAPPLE') && texts.some(s => s.startsWith('3.3')), `face text drawn (${texts.join(' ')})`);
    for (let i = 1; i < 30; i++) wrist.update(t, { nowMs: i * 16 });
    assert.equal(wrist.redraws, 1, 'same face: no redraw');
    const later = { ...t, pips: [1, 0.5], cooldownLeft: 3 };
    wrist.update(later, { nowMs: 500 });
    assert.equal(wrist.redraws, 2, 'recharge moved: redraw');
    wrist.update({ ...later, pips: [1, 0.55], cooldownLeft: 2.7 }, { nowMs: 520 });
    assert.equal(wrist.redraws, 2, `within 1/${PILOT_WRIST.redrawHz} s: throttled`);
    wrist.update({ ...later, pips: [1, 0.55], cooldownLeft: 2.7, inRange: true }, { nowMs: 530, inRange: true });
    assert.equal(wrist.redraws, 3, 'IN RANGE change redraws at once');
    wrist.update(tacticalOf('grapple-reel'), { nowMs: 540, inRange: false });
    assert.equal(wrist.redraws, 4, 'tone change redraws at once');
  } finally { wrist.dispose(); }
});

check('live flag follows a live screen draw; dispose resets', () => {
  resetWrist();
  assert.equal(wristLive(), false);
  const wrist = new PilotWrist();
  wrist.screen.onBeforeRender();
  assert.equal(wristShownAt(), -Infinity, 'drawn but not live (off-screen, ADS): no stamp');
  wrist.live = true;
  wrist.screen.onBeforeRender();
  assert.ok(wristShownAt() > -Infinity);
  assert.equal(wristLive(), true);
  assert.equal(wristLive(wristShownAt() + PILOT_WRIST.liveMs + 1), false, 'stale after liveMs');
  wrist.hide();
  assert.equal(wristLive(), false, 'hidden: the chip returns at once');
  wrist.dispose();
  resetWrist();
  assert.equal(wristLive(), false);
  assert.equal(wrist.tex, null);
  assert.equal(wrist.group.children.length, 0);
});

// titan-ui syncWrist on a real rig: the body flag follows the live screen draw, spectating and the titan layout drop
// it, dispose detaches; titanfall.css hides the DOM chip under that flag.
{
  const contract = await import('../shared/titan-contract.js');
  const { titanfallHudFixtures, FIXTURE_NOW } = await import('../public/js/capture/titanfall-hud-fixtures.js');
  const ui = await import('../public/js/titanfall/titan-ui.js');
  const fixtures = titanfallHudFixtures();
  const pilot = fixtures.find(fixture => fixture.id === 'pilot-ready'), titan = fixtures.find(fixture => fixture.id === 'titan');
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 100);
  const rig = new ViewmodelRig(camera);
  rig.setWeapon('rifle');
  const weapon = { wid: 'rifle', def: { id: 'rifle' },
    readDisplay(out) { return Object.assign(out, { wid: this.wid, mag: 9, reserve: 30, reloading01: null, reloadStaged: false, charge01: 0, ready01: 1 }); } };
  const app = { myId: 'me', net: { on: () => () => {}, sendTitanfall: () => true }, hud: { spectator: { setSuppressed() {} } }, rig, weapon,
    player: { shotYaw: 0, shotPitch: 0, pos: { x: 0.5, y: 0, z: 0.5 } }, spectator: { active: false },
    session: { gameplayInputEnabled: true, setOverlayBlock() {}, restoreGameplayFocus() {} }, input: { exit() {}, requestLock() {} } };
  let current = pilot;
  const client = { snapshot: () => current.snapshot, selfRow: () => current.self, selfTf: () => contract.decodeTitanfallPlayer(current.self),
    selfFrame: () => contract.decodeTitanfallSelf(current.tfs) };
  // One match frame: titan-ui (wrist update), the rig (place), then the renderer's draw of the screen.
  const step = () => {
    ui.tick(current.snapshot, 0);
    ui.frame(1 / 60, { nowMs: FIXTURE_NOW, camera });
    rig.update(1 / 60, pose);
    if (rig.armGear?.group.visible) rig.armGear.screen.onBeforeRender();
  };
  const flag = () => document.body.dataset.titanfallWrist;
  ui.init(app, client);
  check('titan-ui: the wrist mounts on the match rig', () => assert.ok(rig.armGear instanceof PilotWrist));
  const wrist = rig.armGear;
  for (let i = 0; i < 90; i++) step();
  check('titan-ui: live screen sets body[data-titanfall-wrist]', () => assert.deepEqual([wrist.live, flag()], [true, '']));
  rig.ads(1);
  for (let i = 0; i < 40; i++) step();
  check('titan-ui: ADS drops the flag (chip back)', () => assert.deepEqual([wrist.live, flag()], [false, undefined]));
  rig.ads(0);
  for (let i = 0; i < 40; i++) step();
  check('titan-ui: back at the hip, flag again', () => assert.equal(flag(), ''));
  app.spectator.active = true;
  step(); step();
  check('titan-ui: spectating hides the slab and drops the flag', () => assert.deepEqual([wrist.group.visible, flag()], [false, undefined]));
  app.spectator.active = false;
  for (let i = 0; i < 4; i++) step();
  check('titan-ui: spectating over, flag again', () => assert.equal(flag(), ''));
  current = titan;
  step(); step();
  check('titan-ui: titan layout drops the flag', () => assert.deepEqual([wrist.group.visible, flag()], [false, undefined]));
  current = pilot;
  for (let i = 0; i < 4; i++) step();
  ui.dispose();
  check('titan-ui: dispose drops the flag and detaches from the rig', () => {
    assert.deepEqual([flag(), rig.armGear, wrist.group.parent, wristLive()], [undefined, null, null, false]);
  });
  rig.dispose();
  const css = readFileSync(new URL('../public/styles/titanfall.css', import.meta.url), 'utf8');
  const hud = readFileSync(new URL('../public/js/titanfall/titan-hud.js', import.meta.url), 'utf8');
  check('titanfall.css hides the DOM tactical chip under the flag', () => {
    assert.match(css, /body\[data-titanfall-wrist\] \.tf-hud \.tf-tactical \{ display: none !important; \}/);
    assert.match(hud, /tf-tactical/, 'TitanHud builds the .tf-tactical chip');
  });
}

void dom;
console.log(`titanfall wrist: ${checks.length} checks ok\n  - ${checks.join('\n  - ')}`);
