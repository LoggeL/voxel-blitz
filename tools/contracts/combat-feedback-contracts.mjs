import * as THREE from '../../public/js/vendor/three.module.js';
import {
  CombatFeedback,
  isWorldPointVisible,
} from '../../public/js/combat/feedback.js';

export function runCombatFeedbackContracts(ok) {
  const solids = new Set();
  const world = {
    getBlock(x, y, z) {
      return solids.has(`${x},${y},${z}`) ? 1 : 0;
    },
  };
  const camera = { position: { x: 0.5, y: 1.5, z: 0.5 } };
  const target = [5.5, 1.5, 0.5];

  ok(isWorldPointVisible(world, camera, target),
    'world-anchored damage feedback remains visible on a clear camera ray');

  solids.add('3,1,0');
  ok(!isWorldPointVisible(world, camera, target),
    'world-anchored damage feedback is suppressed by intervening voxel cover');

  solids.clear();
  solids.add('6,1,0');
  ok(isWorldPointVisible(world, camera, target),
    'voxel cover beyond the impact point does not suppress damage feedback');

  ok(!isWorldPointVisible(null, camera, target)
    && !isWorldPointVisible(world, null, target)
    && !isWorldPointVisible(world, camera, [NaN, 1, 1]),
  'combat-feedback visibility fails closed for incomplete or nonfinite inputs');

  let hitmarks = 0;
  let hitSounds = 0;
  const damageVisibility = [];
  const feedbackCamera = new THREE.PerspectiveCamera(75, 16 / 9, 0.01, 100);
  feedbackCamera.position.set(0.5, 1.5, 0.5);
  feedbackCamera.lookAt(target[0], target[1], target[2]);
  feedbackCamera.updateMatrixWorld(true);
  feedbackCamera.updateProjectionMatrix();
  const feedback = new CombatFeedback({
    effects: { impact() {}, gore() {} },
    sfx: { hitmark() { hitSounds++; }, pain() {} },
    hud: {
      hitmark() { hitmarks++; },
      spawnDamage(_damage, _x, _y, visible) { damageVisibility.push(visible); },
    },
    roster: { hit() {} },
    player: { alive: true },
    getMyId: () => 'self',
    getPlayersCache: () => [{ id: 'target', state: 'alive', hp: 50 }],
    getSelfRow: () => null,
    isRunning: () => true,
    camera: feedbackCamera,
    world,
    viewport: { innerWidth: 1280, innerHeight: 720 },
    respawnLocal() {},
    onLocalDeath() {},
  });
  const event = {
    kind: 'hit', attacker: 'self', victim: 'target', dmg: 25, hs: false,
    vx: target[0], vy: target[1], vz: target[2],
  };
  feedback.handleEvent(event);
  solids.add('3,1,0');
  feedback.handleEvent(event);
  ok(hitmarks === 1 && hitSounds === 1
      && damageVisibility.length === 2
      && damageVisibility[0] === true
      && damageVisibility[1] === false,
  'voxel cover suppresses the complete remote hit confirmation, not only its damage number');
}
