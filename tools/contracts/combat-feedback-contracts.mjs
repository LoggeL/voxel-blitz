import * as THREE from '../../public/js/vendor/three.module.js';
import {
  CombatFeedback,
  bearingDeg,
  deathRecapText,
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

  ok(Math.abs(bearingDeg({ x: 0, z: 0 }, 0, { x: 0, z: -5 })) < 1e-9
      && Math.abs(bearingDeg({ x: 0, z: 0 }, 0, { x: 5, z: 0 }) - 90) < 1e-9
      && Math.abs(Math.abs(bearingDeg({ x: 0, z: 0 }, 0, { x: 0, z: 5 })) - 180) < 1e-9
      && Math.abs(bearingDeg({ x: 0, z: 0 }, Math.PI / 2, { x: -5, z: 0 })) < 1e-9
      && bearingDeg(null, 0, { x: 1, z: 1 }) === null,
  'damage bearing reads ahead/right/behind relative to the current yaw');
  ok(deathRecapText({ weapon: 'sniper', headshot: true, longRange: true, distance: 41.4, killerHp: 33.4 })
      === 'LONGSHOT MK-II · HEADSHOT · LONG RANGE · 41 M · KILLER AT 33 HP'
      && deathRecapText({ weapon: 'grenade' }) === 'GRENADE'
      && deathRecapText({}) === '',
  'death recap lists weapon, markers, range, and the killer\'s remaining health');

  const marks = [];
  const sounds = [];
  const pains = [];
  const deaths = [];
  const killFeedback = new CombatFeedback({
    effects: { impact() {}, gore() {} },
    sfx: {
      hitmark(hs) { sounds.push(`hit:${hs}`); },
      killConfirm(hs) { sounds.push(`kill:${hs}`); },
      pain() {}, impact() {}, deathSelf() {},
    },
    hud: {
      hitmark(kind) { marks.push(kind); },
      spawnDamage(_damage, _x, _y, _visible, _hs, key) { marks.push(`dmg:${key}`); },
      killfeed() {},
      setPainImpulse(value) { pains.push(value); },
      setDeathBrutality() {},
      setDead(dead, name, recap) { deaths.push([dead, name, recap]); },
    },
    roster: { hit() {}, death() {} },
    player: {
      alive: true,
      pos: { x: 0, y: 0, z: 0 },
      view: { yaw: 0 },
      applyHit: () => ({ painImpulse: 0.6, damage: 20 }),
      die: () => ({ kind: 'death', headshot: false, goreImpact: null }),
    },
    getMyId: () => 'self',
    getPlayersCache: () => [
      { id: 'target', state: 'alive', hp: 50, name: 'TARGET', x: 6, y: 0, z: 0 },
      { id: 'rival', state: 'alive', hp: 41, name: 'RIVAL', x: 0, y: 0, z: 8 },
    ],
    getSelfRow: () => null,
    isRunning: () => true,
    camera: feedbackCamera,
    world,
    viewport: { innerWidth: 1280, innerHeight: 720 },
    respawnLocal() {},
    onLocalDeath() {},
  });
  solids.clear();
  killFeedback.handleEvent({ kind: 'hit', attacker: 'self', victim: 'target', dmg: 25, hs: true,
    vx: target[0], vy: target[1], vz: target[2] });
  killFeedback.handleEvent({ kind: 'kill', killer: 'self', victim: 'target', w: 'rifle', hs: true });
  ok(marks.join(',') === 'head,dmg:target,killHead' && sounds.join(',') === 'hit:true,kill:true',
    'a kill by the local player promotes the hitmark to a kill mark and plays the confirmation');
  killFeedback.handleEvent({ kind: 'hit', attacker: 'target', victim: 'self', dmg: 20, hs: false,
    vx: 0, vy: 1, vz: 0 });
  const pain = pains.at(-1);
  ok(pain && typeof pain === 'object' && pain.intensity === 0.6 && Math.abs(pain.angleDeg - 90) < 1e-9,
    'local damage carries the attacker bearing so the pain vignette points at the shooter');
  killFeedback.handleEvent({ kind: 'kill', killer: 'rival', victim: 'self', w: 'smg', hs: false, lr: false });
  ok(deaths.at(-1)?.[0] === true && deaths.at(-1)[1] === 'RIVAL'
      && deaths.at(-1)[2] === 'HORNET SMG · 8 M · KILLER AT 41 HP',
  'local death shows who, with what, from how far, and how much health the killer had left');
}
