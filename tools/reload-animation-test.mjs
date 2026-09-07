import assert from 'node:assert/strict';
import { WeaponActions } from '../public/js/guns/actions.js';
import { buildGun, disposeGunModels } from '../public/js/guns/assemble.js';
import { MaterialCache } from '../public/js/guns/kit.js';
import { WEAPONS } from '../shared/combatmath.js';

const cache = new MaterialCache();
const models = [];
const actions = [];
function animation(id, duration = WEAPONS[id].reloadTime, stages = null) {
  const model = buildGun(id, cache);
  models.push(model);
  const clicks = [];
  let at = 0;
  const action = new WeaponActions({ onReloadClick: (step) => clicks.push({ step, at }) });
  actions.push(action);
  action.startReload(0, duration, 'magswap', model.T, stages);
  return {
    model, action, clicks, duration,
    sample(frac) {
      at = frac * duration;
      const motion = action.update(at, 0, model, model.T);
      return { ...motion, magazine: model.mag.position.clone(), magazineRotation: model.mag.rotation.clone() };
    },
  };
}
const allZero = (motion) => ['dip', 'rock', 'x', 'push', 'yaw', 'roll'].every((key) => motion[key] === 0);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} differs from ${b}`);

try {
  const rifle = animation('rifle');
  const anticipation = rifle.sample(0.025);
  const presented = rifle.sample(0.16);
  assert.ok(anticipation.dip < 0 && anticipation.rock < 0, 'a short downward wind-up precedes the lift');
  assert.ok(presented.dip > 0.055 && presented.rock > 0.4,
    'receiver is raised and firmly tilted before magazine release');
  assert.ok(presented.x < -0.04 && presented.roll < -0.28,
    'sideways presentation exposes the loading side rather than only pitching the muzzle');
  const { start, home, clickAt } = rifle.model.T.magTimeline;
  const beforePull = rifle.sample(start);
  const pulled = rifle.sample(start + 0.085);
  const pullSpeed = pulled.magazine.distanceTo(beforePull.magazine) / (0.085 * rifle.duration);
  assert.ok(pullSpeed > 1, 'magazine is pulled clear in a brisk separate stroke');
  const holdA = rifle.sample(0.44);
  const holdB = rifle.sample(home - 0.09);
  assert.ok(holdA.magazine.y < -0.17 && holdA.magazine.x < -0.06,
    'removed magazine visibly clears the receiver');
  near(holdA.magazine.distanceTo(holdB.magazine), 0);
  const seating = rifle.sample(home);
  assert.equal(seating.magazine.length(), 0, 'magazine is fully seated at its unchanged home click');
  assert.ok(seating.push < holdB.push - 0.04 && seating.dip > holdB.dip + 0.02,
    'seating has a distinct forward/upward contact impulse');
  const settling = rifle.sample(home + 0.07);
  assert.ok(settling.push > seating.push + 0.025, 'the seating impulse settles before the charging-handle contact');
  rifle.sample(clickAt);
  assert.deepEqual(rifle.clicks.map(({ step }) => step), [1, 2, 3]);
  rifle.clicks.forEach(({ at }, index) => near(at, [start, home, clickAt][index] * rifle.duration));
  assert.equal(rifle.action.reloading, true);
  const complete = rifle.sample(1);
  assert.equal(rifle.action.reloading, false, 'aggression does not shorten the canonical reload duration');
  assert.ok(allZero(complete) && complete.magazine.length() === 0);
  assert.equal(rifle.model.mag.rotation.z, 0, 'magazine cant resets completely');
  console.table([
    ['anticipation', anticipation], ['presented', presented], ['magazine clear', pulled],
    ['braced', holdA], ['seating', seating], ['settle', settling], ['complete', complete],
  ].map(([phase, pose]) => ({ phase, y: pose.dip.toFixed(3), pitch: pose.rock.toFixed(3),
    x: pose.x.toFixed(3), z: pose.push.toFixed(3), roll: pose.roll.toFixed(3),
    magazineY: pose.magazine.y.toFixed(3) })));

  for (const id of ['smg', 'lmg', 'minigun', 'sniper', 'longarc', 'lance', 'rocket', 'flamethrower']) {
    const run = animation(id);
    for (let frame = 0; frame < 121; frame++) {
      const pose = run.sample(frame / 120);
      assert.ok(['dip', 'rock', 'x', 'push', 'yaw', 'roll'].every((key) => Number.isFinite(pose[key])),
        `${id}: every phase remains finite`);
    }
    const expectedClicks = run.model.T.magTimeline.type === 'stripper' ? [3] : [1, 2, 3];
    assert.deepEqual(run.clicks.map(({ step }) => step), expectedClicks, `${id}: canonical cue sequence`);
    assert.equal(run.model.mag.position.length(), 0, `${id}: magazine returns home`);
    assert.ok(allZero(run.sample(1.1)), `${id}: no motion leaks past completion`);
  }

  const belt = animation('lmg');
  belt.sample(0.35);
  const openAngle = belt.model.extra.userData.reloadPart.rotation.x;
  belt.sample(0.65);
  near(belt.model.extra.userData.reloadPart.rotation.x, openAngle);
  assert.ok(openAngle < -1.1, 'belt cover opens firmly and stays open while feeding');
  belt.action.cancelReload(belt.model);
  assert.equal(belt.model.extra.userData.reloadPart.rotation.x, 0);
  assert.ok(allZero(belt.sample(0.7)), 'interruption clears every added transform');

  const stage = WEAPONS.shotgun.reloadStages;
  const rounds = 3;
  const duration = stage.start + rounds * stage.perRound + stage.end;
  const tube = animation('shotgun', duration, {
    startSeconds: stage.start, perRoundSeconds: stage.perRound, rounds,
  });
  const firstSeat = stage.start + stage.perRound;
  const beforeShell = tube.sample((firstSeat - 0.06) / duration);
  const shellHit = tube.sample(firstSeat / duration);
  assert.ok(shellHit.rock > beforeShell.rock + 0.07 && shellHit.push < beforeShell.push - 0.02,
    'tube reload has a separate receiver impulse exactly when a shell seats');
  tube.sample((stage.start + rounds * stage.perRound + 0.001) / duration);
  assert.deepEqual(tube.clicks.map(({ step }) => step), [1, 2, 3],
    'a skipped frame preserves all canonical shell-seating contacts');
  assert.ok(allZero(tube.sample(1)));

  const revolver = animation('revolver');
  for (const fraction of [0.10, 0.40, 0.55, 0.68, 0.70]) {
    const pose = revolver.sample(fraction);
    if (fraction > 0.25) near(revolver.model.extra.userData.revolver.crane.rotation.z, Math.PI / 2);
    if (fraction === 0.55) assert.ok(pose.dip > 0.05 && Math.abs(pose.roll) > 0.25);
  }
  revolver.sample(0.92);
  assert.deepEqual(revolver.clicks.map(({ step }) => step), [1, 2, 3]);
  assert.ok(allZero(revolver.sample(1)));

  const dense = animation('rifle');
  for (let i = 0; i < 60; i++) dense.sample(i / 100);
  const sparse = animation('rifle');
  const densePose = dense.sample(0.63);
  const sparsePose = sparse.sample(0.63);
  for (const key of ['dip', 'rock', 'x', 'push', 'yaw', 'roll']) near(densePose[key], sparsePose[key]);
  near(densePose.magazine.distanceTo(sparsePose.magazine), 0);
} finally {
  for (let i = 0; i < actions.length; i++) actions[i].dispose(models[i]);
  disposeGunModels(models, cache);
}
console.log('Reload animation: staged lift/pull/hold/insertion/contact/settle, frame independence, canonical cues, tube/cylinder mechanics and full reset passed.');
