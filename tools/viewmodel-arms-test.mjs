import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { ViewmodelRig } from '../public/js/guns/viewmodel.js';
import { ARM, ViewmodelArms, solveArm } from '../public/js/guns/viewmodel-arms.js';

const SEGMENTS = ['forearm', 'upperarm', 'shoulder'];
const wrist = new THREE.Vector3();
const shoulder = new THREE.Vector3();

// --- analytic chain --------------------------------------------------------
{
  shoulder.set(0.25, -0.23, 0.06);
  wrist.set(0.20, -0.24, -0.38);
  const solved = solveArm(1, wrist, shoulder, {});
  assert.ok(Math.abs(solved.forearm - ARM.forearm) < 1e-6,
    'a reachable hand keeps the authored forearm length');
  assert.ok(Math.abs(solved.upperArm - ARM.upperArm) < 1e-6,
    'a reachable hand keeps the authored upper arm length');
  assert.ok(solved.elbow.y < Math.min(wrist.y, shoulder.y),
    'the elbow hangs below both joints instead of winging up into the view');

  // A hand held out past the arm's reach may stretch, but only within bounds.
  wrist.set(0.22, -0.30, -1.15);
  const far = solveArm(1, wrist, shoulder, {});
  assert.ok(far.forearm <= ARM.forearm * ARM.forearmStretchMax + 1e-6,
    'an out-of-reach hand never stretches the forearm past its cap');
  assert.ok(far.upperArm > ARM.upperArm,
    'the upper arm, which is mostly off screen, absorbs the rest of the reach');
  assert.ok(far.elbow.distanceTo(wrist) > 0.1, 'the elbow stays off the wrist');
  assert.ok(far.shoulder.distanceTo(shoulder) <= ARM.shoulderGive + 1e-6,
    'the torso leans into a far hand, but only by the allowed give');
  assert.ok(far.shoulder.z < shoulder.z, 'the lean goes toward the hand');

  // A hand folded back onto the shoulder must not collapse the chain.
  wrist.copy(shoulder).add(new THREE.Vector3(0.01, 0.01, 0.01));
  const near = solveArm(1, wrist, shoulder, {});
  assert.ok(Number.isFinite(near.elbow.x + near.elbow.y + near.elbow.z),
    'a hand on top of the shoulder still solves');
  assert.ok(near.forearm > 0.02, 'the folded chain keeps a bend');

  // Mirrored sides put their elbows on opposite sides of the body.
  wrist.set(-0.10, -0.30, -0.45);
  const left = solveArm(-1, wrist, new THREE.Vector3(-0.25, -0.23, 0.06), {}).elbow.x;
  wrist.set(0.10, -0.30, -0.45);
  const right = solveArm(1, wrist, new THREE.Vector3(0.25, -0.23, 0.06), {}).elbow.x;
  assert.ok(left < 0 && right > 0 && left < right,
    'each elbow swings out to its own side of the body');
}

// --- the arms as the rig drives them --------------------------------------
const rig = new ViewmodelRig(new THREE.PerspectiveCamera(75, 2, 0.05, 400));
try {
  const ctx = { speed: 0, grounded: true, aimSwayScale: 0, reducedMotion: true };
  const segment = (name, side) => rig.root.getObjectByName(`arm_${name}_${side}`);
  const worldEnds = (name, side) => {
    const group = segment(name, side);
    group.updateWorldMatrix(true, false);
    const length = name === 'forearm' ? ARM.forearm : ARM.upperArm;
    return {
      near: new THREE.Vector3(0, 0, 0).applyMatrix4(group.matrixWorld),
      far: new THREE.Vector3(0, 0, length).applyMatrix4(group.matrixWorld),
    };
  };

  rig.setWeapon('rifle');
  for (let i = 0; i < 120; i++) rig.update(1 / 60, ctx);
  for (const side of ['l', 'r']) {
    for (const name of SEGMENTS) {
      assert.ok(segment(name, side), `two-handed rifle builds ${name}_${side}`);
      assert.equal(segment(name, side).visible, true, `${name}_${side} is shown on a rifle`);
    }
    const hand = rig._cur.root.getObjectByName(side === 'l' ? 'hand_l' : 'hand_r');
    hand.updateWorldMatrix(true, false);
    const palm = new THREE.Vector3(0, 0, ARM.wristZ).applyMatrix4(hand.matrixWorld);
    const fore = worldEnds('forearm', side);
    const upper = worldEnds('upperarm', side);
    assert.ok(fore.near.distanceTo(palm) < 1e-6, `${side}: the forearm starts at the glove wrist`);
    assert.ok(fore.far.distanceTo(upper.near) < 1e-6, `${side}: forearm and upper arm share one elbow`);
    const shoulderGroup = segment('shoulder', side);
    shoulderGroup.updateWorldMatrix(true, false);
    const cap = new THREE.Vector3().setFromMatrixPosition(shoulderGroup.matrixWorld);
    assert.ok(upper.far.distanceTo(cap) < 1e-6, `${side}: the shoulder cap sits on the joint`);
    // The shoulder is a fixed spot on the player's body, never on the gun.
    const local = rig.root.worldToLocal(cap.clone());
    assert.ok(new THREE.Vector3(Math.sign(local.x) * ARM.shoulder[0], ARM.shoulder[1],
      ARM.shoulder[2]).distanceTo(local) <= ARM.shoulderGive + 1e-3,
    `${side}: the shoulder stays within its give of the body anchor`);
  }

  // Looking down bends the spine: the shoulders ride up in camera space, but
  // by less than the head turns, so the body never counter-rotates past it.
  const shoulderY = () => {
    const group = segment('shoulder', 'r');
    group.updateWorldMatrix(true, false);
    return rig.root.worldToLocal(new THREE.Vector3().setFromMatrixPosition(group.matrixWorld)).y;
  };
  const level = shoulderY();
  rig.camera.rotation.x = -1.0;
  rig.camera.updateMatrixWorld(true);
  for (let i = 0; i < 30; i++) rig.update(1 / 60, ctx);
  const down = shoulderY();
  assert.ok(down > level, 'looking down lifts the shoulders in camera space');
  rig.camera.rotation.x = 0;
  rig.camera.updateMatrixWorld(true);
  for (let i = 0; i < 30; i++) rig.update(1 / 60, ctx);

  // One-handed weapons must not leave a support arm hanging in mid air.
  rig.setWeapon('revolver');
  for (let i = 0; i < 60; i++) rig.update(1 / 60, ctx);
  for (const name of SEGMENTS) {
    assert.equal(segment(name, 'l').visible, false,
      `a one-handed revolver hides ${name}_l with its hidden support glove`);
    assert.equal(segment(name, 'r').visible, true, `the revolver still shows ${name}_r`);
  }

  rig.setWeapon('knife');
  for (let i = 0; i < 60; i++) rig.update(1 / 60, ctx);
  for (const name of SEGMENTS) {
    assert.equal(segment(name, 'l').visible, false, `the knife has no support arm (${name}_l)`);
  }

  // Every weapon keeps both segments inside a sane length, so no arm can shoot
  // across the screen when a hand anchor sits somewhere unusual.
  for (const id of ['rifle', 'smg', 'shotgun', 'sniper', 'lmg', 'minigun', 'revolver',
    'longarc', 'lance', 'rocket', 'flamethrower', 'glaive', 'knife']) {
    rig.setWeapon(id);
    for (let i = 0; i < 60; i++) rig.update(1 / 60, ctx);
    for (const side of ['l', 'r']) {
      if (!segment('forearm', side).visible) continue;
      const fore = worldEnds('forearm', side);
      const upper = worldEnds('upperarm', side);
      assert.ok(fore.near.distanceTo(fore.far) <= ARM.forearm * ARM.forearmStretchMax + 1e-6,
        `${id}/${side}: forearm within its stretch cap`);
      assert.ok(upper.near.distanceTo(upper.far) < ARM.upperArm * 2,
        `${id}/${side}: upper arm within a sane length`);
    }
  }

  // Grenades and the medkit holster the gun; the arms leave with it.
  rig.setWeapon('rifle');
  for (let i = 0; i < 60; i++) rig.update(1 / 60, ctx);
  assert.equal(rig._arms.root.visible, true, 'a held weapon shows its arms');
  rig.grenadeCharge(1, 0, null, true);
  for (let i = 0; i < 120; i++) rig.update(1 / 60, ctx);
  assert.equal(rig.content.visible, false, 'the drawn grenade holsters the gun');
  assert.equal(rig._arms.root.visible, false, 'the holstered gun takes its arms off screen');
  rig.cancelGrenade();
  for (let i = 0; i < 120; i++) rig.update(1 / 60, ctx);
  assert.equal(rig._arms.root.visible, true, 'the arms come back with the gun');
} finally {
  rig.dispose();
}

// --- ownership -------------------------------------------------------------
{
  const parent = new THREE.Group();
  const arms = new ViewmodelArms(parent);
  assert.equal(parent.children.length, 1, 'the arms mount one group on the rig');
  arms.update(null, 0, true);
  assert.equal(arms.root.visible, false, 'no weapon means no arms');
  arms.dispose();
  assert.equal(parent.children.length, 0, 'disposal detaches the arms from the rig');
}

console.log('Viewmodel arms: analytic two-bone chain, glove-to-shoulder attachment, spine follow, '
  + 'one-handed and holstered hiding, per-weapon length bounds and disposal passed.');
