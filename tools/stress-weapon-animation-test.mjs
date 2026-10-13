import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { WeaponActions } from '../public/js/guns/actions.js';
import { ViewmodelRig } from '../public/js/guns/viewmodel.js';
import { buildGun, disposeGunModels } from '../public/js/guns/assemble.js';
import { MaterialCache } from '../public/js/guns/kit.js';
import { handlingStress, handlingVariant, hesitantProgress } from '../public/js/guns/stress-handling.js';
import { WEAPONS } from '../shared/combatmath.js';
import { CYCLE_FRACS, PUMP_REST } from '../public/js/guns/models/common.js';

const keys = ['dip', 'rock', 'x', 'push', 'yaw', 'roll'];
const calm = { panic: 0, pain: 0 };
const stressed = { panic: 1, pain: 0.65 };
const near = (a, b, label = '') => assert.ok(Math.abs(a - b) < 1e-8, `${label}: ${a} != ${b}`);
const zero = (pose) => keys.every((key) => Math.abs(pose[key]) < 1e-12);
const cache = new MaterialCache(), models = [], actions = [];

function fixture(id, conditions = calm, rounds = null) {
  const model = buildGun(id, cache);
  models.push(model);
  let at = 0;
  const clicks = [];
  const action = new WeaponActions({ onReloadClick: (step) => clicks.push({ step, at }),
    onBoltClack: (step) => clicks.push({ step, at }), onShellEject: () => clicks.push({ step: 'eject', at }) });
  actions.push(action);
  const stage = rounds === null ? null : WEAPONS[id].reloadStages;
  const duration = stage ? stage.start + rounds * stage.perRound + stage.end : WEAPONS[id].reloadTime;
  const stages = stage ? { startSeconds: stage.start, perRoundSeconds: stage.perRound, rounds } : null;
  function start() { action.startReload(0, duration, stage ? 'tube' : 'magswap', model.T, stages); }
  start();
  return { model, action, duration, clicks, start,
    sample(frac, dt = 0, ctx = conditions) {
      at = frac * duration;
      const motion = { ...action.update(at, dt, model, model.T, ctx) };
      return { ...motion, mag: model.mag.position.toArray(), hand: model.extra.userData.reloadHand?.hand.position.toArray(),
        visible: model.mag.visible, grip: action._gripBeat };
    },
    cycleStep(dt) { at += dt; return { ...action.update(at, dt, model, model.T, conditions) }; },
  };
}

try {
  assert.equal(handlingStress(stressed), 1);
  assert.equal(handlingStress({ pain: 1 }), 0.55, 'injury alone affects handling');
  assert.equal(handlingStress({ panic: NaN, pain: Infinity }), 0);
  assert.equal(handlingStress({ ...stressed, reducedMotion: true }), 0);
  for (let variant = 0; variant <= 1; variant += 0.25) {
    let previous = 0;
    for (let i = 0; i <= 1000; i++) {
      const value = hesitantProgress(i / 1000, 1, variant);
      assert.ok(value >= previous && value <= 1, 'hesitation stays monotonic and inside its contact interval');
      previous = value;
    }
    assert.equal(hesitantProgress(0, 1, variant), 0);
    assert.equal(hesitantProgress(1, 1, variant), 1);
  }
  assert.notEqual(handlingVariant(1), handlingVariant(2));

  const base = fixture('rifle'), stress = fixture('rifle', stressed);
  const b = base.sample(0.67), s = stress.sample(0.67);
  assert.ok(s.grip > 0.5, 'insertion has a readable second grip');
  assert.ok(Math.abs(s.mag[1] - b.mag[1]) > 0.10, 'hesitation changes the magazine route, not just weapon jitter');
  assert.ok(Math.abs(s.push - b.push) > 0.01, 'holding hand braces through the regrip');
  const same = fixture('rifle', stressed);
  for (let i = 0; i < 67; i++) same.sample(i / 100);
  assert.deepEqual(same.sample(0.67), s, 'same action is deterministic across frame densities');
  const firstVariant = stress.action._reload.variant;
  stress.action.cancelReload(stress.model);
  stress.start();
  assert.notEqual(stress.action._reload.variant, firstVariant, 'next action selects its own stable gesture');
  const reduced = fixture('rifle', { ...stressed, reducedMotion: true });
  assert.deepEqual(reduced.sample(0.67), b, 'reduced motion removes added stress motion entirely');
  const injury = fixture('rifle', { panic: 0, pain: 1 });
  assert.ok(injury.sample(0.67).push > b.push, 'pain guards the hold even without panic');

  const ids = ['rifle', 'smg', 'lmg', 'minigun', 'revolver', 'shotgun', 'sniper', 'longarc',
    'lance', 'rocket', 'flamethrower', 'bubble', 'mgl', 'stinger', 'archer', 'kraber', 'thunderbolt', 'chargerifle'];
  for (const id of ids) {
    const a = fixture(id), c = fixture(id, stressed);
    for (let frame = 0; frame <= 180; frame++) {
      const x = a.sample(frame / 180), y = c.sample(frame / 180);
      assert.ok(keys.every((key) => Number.isFinite(y[key])), `${id}: finite stressed pose`);
      for (const key of ['x', 'dip', 'push']) assert.ok(Math.abs(y[key] - x[key]) < 0.13,
        `${id}: bounded handling translation keeps the weapon visible`);
      if (frame === 180) assert.ok(zero(y), `${id}: completes on its canonical deadline`);
    }
    assert.deepEqual(c.clicks, a.clicks, `${id}: unchanged contact sequence and timestamps`);
    assert.equal(c.action.reloading, false);
    assert.deepEqual(c.model.mag.position.toArray(), [0, 0, 0], `${id}: restores moving ammo`);
    assert.ok(zero(c.sample(1.1)), `${id}: no stress motion after completion`);
  }

  // Exact seating, release and charging-handle contacts remain on their known boundaries.
  const contact = fixture('rifle', stressed);
  const { start, home, clickAt } = contact.model.T.magTimeline;
  for (const at of [start, home, clickAt]) contact.sample(at);
  assert.deepEqual(contact.clicks.map(({ step }) => step), [1, 2, 3]);
  contact.clicks.forEach((event, i) => near(event.at, [start, home, clickAt][i] * contact.duration));
  near(contact.model.mag.position.length(), 0, 'the magazine is seated before the final latch');

  const stage = WEAPONS.shotgun.reloadStages;
  const tube = fixture('shotgun', stressed, 3);
  for (let i = 1; i <= 3; i++) {
    const at = stage.start + i * stage.perRound;
    tube.sample((at - 0.002) / tube.duration);
    tube.sample(at / tube.duration);
    assert.equal(tube.clicks.length, i, 'exactly one authoritative shell seating per stage');
    near(tube.clicks.at(-1).at, at);
  }
  assert.equal(tube.model.extra.userData.reloadRounds.visible, false, 'no extra shell after the last round');
  assert.ok(zero(tube.sample(1)));
  const sparseTube = fixture('shotgun', stressed, 3);
  sparseTube.sample((stage.start + 3 * stage.perRound + 0.001) / sparseTube.duration);
  assert.deepEqual(sparseTube.clicks.map(({ step }) => step), [1, 2, 3], 'skipped frames preserve every shell contact');

  // Node does not load the authored sniper asset; supply its cartridge mount
  // contract so stress cannot desynchronize the rounds from their loading palm.
  const stripper = fixture('sniper', stressed);
  const cartridge = new THREE.Group();
  stripper.model.extra.add(cartridge);
  stripper.model.extra.userData.cartridges.push(cartridge);
  for (const frac of [0.45, 0.55, 0.65]) {
    stripper.sample(frac);
    const hand = stripper.model.extra.userData.reloadHand.hand;
    const gap = hand.position.y + hand.parent.position.y - cartridge.position.y;
    assert.ok(gap > 0.045 && gap < 0.13, 'the stripper-loading palm stays with its cartridge under stress');
  }

  // Automatic feed/bolt travel is mechanical, not a stressed manual gesture.
  for (const id of ['rifle', 'mgl']) {
    const a = fixture(id), c = fixture(id, stressed);
    a.action.reset(a.model); c.action.reset(c.model);
    a.action.startJerk(id, a.model, a.model.T.boltTravel, 0.05);
    c.action.startJerk(id, c.model, c.model.T.boltTravel, 0.05);
    for (let i = 0; i < 25; i++) {
      a.cycleStep(0.01); c.cycleStep(0.01);
      near(c.model.bolt.position.z, a.model.bolt.position.z, `${id}: automatic bolt stays mechanical`);
      if (c.model.extra.userData.skipjack) near(c.model.extra.userData.skipjack.feed.rotation.z,
        a.model.extra.userData.skipjack.feed.rotation.z, 'automatic cassette indexing ignores stress');
    }
  }

  // Interruption never holds up a shot or keeps an unseated shell visible.
  const interrupted = fixture('shotgun', stressed, 3);
  const beforeCancel = interrupted.sample((stage.start + stage.perRound * 0.6) / interrupted.duration);
  assert.ok(!zero(beforeCancel));
  interrupted.action.cancelReload(interrupted.model, { smooth: true });
  assert.equal(interrupted.action.reloading, false);
  assert.equal(interrupted.model.extra.userData.reloadRounds.visible, false);
  const returning = interrupted.sample(0.6, 0.016);
  assert.ok(!zero(returning), 'the held gun returns instead of snapping');
  assert.ok(returning.roll / beforeCancel.roll > 0.9, 'the first return frame is continuous');
  assert.ok(zero(interrupted.sample(0.7, 0.2)), 'return finishes within 160 ms');
  interrupted.start();
  interrupted.sample(0.4);
  interrupted.action.cancelReload(interrupted.model, { smooth: true });
  interrupted.action.reset(interrupted.model);
  assert.ok(zero(interrupted.sample(0.5, 0.016)), 'reset removes return motion');
  interrupted.start();
  interrupted.sample(0.4);
  interrupted.action.cancelReload(interrupted.model, { smooth: true });
  interrupted.start();
  assert.equal(interrupted.action._return, null, 'new reload owns the pose');

  for (const [id, kind] of [['shotgun', 'pump'], ['sniper', 'bolt']]) {
    const a = fixture(id), c = fixture(id, stressed);
    a.action.reset(a.model); c.action.reset(c.model);
    a.action.beginCycle(kind, false, a.model.T); c.action.beginCycle(kind, false, c.model.T);
    const duration = c.action._cycle.dur;
    const anchors = CYCLE_FRACS[kind];
    let previous = 0;
    for (const u of [0.08, anchors.s1, (anchors.s1 + anchors.s2) / 2, anchors.s2, anchors.s3, 1]) {
      const dt = (u - previous) * duration;
      a.cycleStep(dt); c.cycleStep(dt);
      previous = u;
    }
    assert.deepEqual(c.clicks, a.clicks, `${kind}: contacts/ejection preserve their clock`);
    assert.equal(c.action.cycling, false);
    near(c.model.bolt.position.z, 0);
    if (c.model.pump) near(c.model.pump.position.z, PUMP_REST.z);
  }

  const camera = new THREE.PerspectiveCamera(80, 16 / 9, 0.01, 300);
  const rig = new ViewmodelRig(camera);
  try {
    rig.setWeapon('rifle'); rig.reload(2, 'magswap');
    for (let i = 0; i < 80; i++) rig.update(1 / 60, stressed);
    assert.equal(rig._actions._stress, 1, 'the live rig forwards actual Panic/Pain');
    rig.cancelReload();
    assert.ok(rig._actions._return);
    rig.equipWeapon('shotgun');
    assert.equal(rig._actions._return, null, 'weapon swap clears the old return pose');
    rig.setWeapon('shotgun'); rig.pumpAnim();
    const duration = rig._actions._cycle.dur;
    for (let i = 0; i < Math.ceil(duration * 30); i++) rig.update(1 / 30, stressed);
    assert.equal(rig._actions.cycling, false, '30 FPS manual cycles finish on elapsed time');
    rig.setWeapon('rifle'); rig.reload(2, 'magswap'); rig.update(0.1, { ...stressed, reducedMotion: true });
    assert.equal(rig._actions._stress, 0, 'live reduced motion preference is respected');
  } finally { rig.dispose(); }
} finally {
  for (let i = 0; i < actions.length; i++) actions[i].dispose(models[i]);
  disposeGunModels(models, cache);
}
console.log('Stress handling: deliberate reach/regrip, pain guard, deterministic variation, reduced motion, all weapon contacts/deadlines, tube stages, cancellation, swaps and manual-cycle authority passed.');
