import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { Input } from '../public/js/engine/input.js';
import { SpectatorCamera } from '../public/js/player/spectator-camera.js';
import { GameplayUiFlow } from '../public/js/session/gameplay-ui.js';

const savedDocument = globalThis.document;
globalThis.document = { addEventListener() {}, removeEventListener() {}, pointerLockElement: null };
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-8, `${message}: ${a} vs ${b}`);
const self = { id: 'self', state: 'dead', team: 'alpha', x: 3, y: 1, z: 8, yaw: 0, respawnAt: 4000 };
const ally = { id: 'ally', name: 'Ally', state: 'alive', team: 'alpha', x: 12, y: 1, z: 12, yaw: 0 };
const other = { ...ally, id: 'other', x: 20, yaw: 1 };
const enemy = { ...ally, id: 'enemy', team: 'bravo' };
const camera = new THREE.PerspectiveCamera();
let wall = null;
let presentation;
const spectator = new SpectatorCamera({ camera, now: () => 1000,
  raycast: () => wall, onPresent: state => { presentation = state; } });
const focus = row => new THREE.Vector3(row.x, row.y + 1.35, row.z);
const sync = (players = [self, ally, other, enemy], local = self) => spectator.sync({
  self: local, players, match: { mode: 'tdm', phase: 'live' }, serverNow: 1000,
});
const input = new Input({ requestPointerLock() { locks++; return Promise.resolve(); } });
input.fallback = true;
input._touchMode = false;
let locks = 0;
let settingsOpen = false;
const gameplay = { running: true, alive: false, spectating: true, selfRow: self, matchState: { mode: 'tdm', phase: 'live' } };
const lifecycle = { liveActive: true, phase: 'live', disconnected: false, tornDown: false };
const flow = new GameplayUiFlow({ input, gameplay, lifecycle, unlockAudio() {},
  hud: { get settingsOpen() { return settingsOpen; }, isBuyMenuOpen: () => false,
    closeSettings() { settingsOpen = false; }, openSettings() { settingsOpen = true; } },
});
try {
  sync();
  const presented = spectator.ensureTargetPresent(new Map());
  assert.equal(presented.get(ally.id), ally, 'the selected target survives interpolation gaps');
  assert.deepEqual(spectator.candidates.map(row => row.id), ['ally', 'other'], 'team restrictions remain authoritative');
  assert.equal(presentation.respawnText, 'RESPAWN IN 3.0s');
  spectator.update(presented, 1 / 60);
  near(camera.position.distanceTo(focus(ally)), 4.6, 'starts in third person');

  flow.syncInput();
  assert.equal(flow.inputEnabled, false, 'spectating never enables player input');
  input._onMouseMove({ movementX: 80, movementY: 35 });
  flow.syncInput(); // A frame must not clear look just because the player is dead.
  const delta = input.consumeDelta();
  near(delta.dx, 0.24, 'spectator mouse sensitivity');
  const before = camera.position.clone();
  spectator.update(presented, 1 / 60, delta);
  assert.ok(camera.position.distanceTo(before) > 0.5, 'both mouse axes orbit the camera');
  assert.ok(camera.position.y > before.y, 'mouse down raises the orbit to look down');
  near(camera.position.distanceTo(focus(ally)), 4.6, 'mouse orbit preserves third-person distance');
  const orbited = camera.position.clone();
  ally.yaw = 2.1;
  sync();
  spectator.update(presented, 1 / 60);
  near(camera.position.distanceTo(orbited), 0, 'target aim and snapshots cannot rotate the spectator');
  camera.position.set(-100, 0, -100);
  spectator.update(presented, 1 / 60);
  near(camera.position.distanceTo(orbited), 0, 'camera does not interpolate from an unrelated first-person position');

  for (const dy of [-1000, 1000]) {
    spectator.update(presented, 1 / 60, { dx: 0, dy });
    assert.ok(camera.position.toArray().every(Number.isFinite));
    assert.ok(Math.hypot(camera.position.x - ally.x, camera.position.z - ally.z) > 1.5,
      'extreme pitch stays outside the target and never flips over');
  }
  wall = { t: 1.4 };
  spectator.update(presented, 1 / 60);
  near(camera.position.distanceTo(focus(ally)), 1.12, 'wall collision snaps inward before rendering');
  wall = null;
  spectator.update(presented, 1 / 60);
  assert.ok(camera.position.distanceTo(focus(ally)) > 1.12 && camera.position.distanceTo(focus(ally)) < 4.6,
    'camera recovers its distance smoothly after clearing a wall');
  assert.equal(spectator.cycle(1), true);
  spectator.update(null, 1 / 60, { dx: 0.2, dy: 0 });
  near(camera.position.distanceTo(focus(other)), 4.6, 'switching targets stays in third person');
  assert.ok(Math.abs(spectator._yaw - (other.yaw - 0.2)) < 1e-8, 'first mouse delta survives target changes');

  sync([self]);
  spectator.update(null, 1 / 60, { dx: 0.4, dy: 0 });
  near(camera.position.distanceTo(focus(self)), 4.6, 'no living targets retains a third-person death-position orbit');
  const waiting = camera.position.clone();
  sync([self]);
  spectator.update(null, 1 / 60);
  near(camera.position.distanceTo(waiting), 0, 'empty snapshots do not reset the waiting orbit');

  for (const button of [0, 1, 2]) input._onMouseDown({ button, preventDefault() {} });
  for (const code of ['KeyW', 'Space', 'KeyR', 'KeyG', 'KeyQ', 'Digit1']) {
    input._onKeyDown({ code, preventDefault() {} });
  }
  assert.equal(input.wantFireHeld, false);
  assert.equal(input.wantAdsHeld, false);
  assert.equal(input.getKeys().forward, false);
  assert.equal(input.getKeys().jump, false);
  assert.equal(input.takeWheelOpenRequest(), false);
  assert.equal(input.consumeGrenadeThrow(), null);

  input.fallback = false;
  input._onMouseDown({ button: 0, isTrusted: true });
  assert.equal(locks, 1, 'dead spectators can acquire pointer lock');
  input._locked = true;
  flow.onPointerLockChange(true);
  assert.equal(flow.inputEnabled, false, 'pointer lock does not enable dead-player combat');
  input._onMouseMove({ movementX: 10, movementY: 0 });
  assert.ok(input.consumeDelta().dx > 0, 'locked mouse controls spectator look');
  assert.equal(flow.pauseFromKeyboard(), true);
  input._onMouseMove({ movementX: 10, movementY: 10 });
  assert.deepEqual(input.consumeDelta(), { dx: 0, dy: 0 }, 'settings block spectator look');
  flow.resumeFromSettings();
  assert.equal(locks, 2, 'resume reacquires pointer lock while dead');
  flow.onPointerLockChange(false);
  assert.equal(settingsOpen, true, 'Escape/pointer release opens settings for spectators');
  flow.resumeFromSettings();

  for (const block of ['post', 'disconnect', 'replay', 'teardown']) {
    gameplay.matchState.phase = block === 'post' ? 'post' : 'live';
    lifecycle.disconnected = block === 'disconnect';
    gameplay.spectating = block !== 'replay';
    lifecycle.tornDown = block === 'teardown';
    flow.syncInput();
    input._onMouseMove({ movementX: 20, movementY: 20 });
    assert.deepEqual(input.consumeDelta(), { dx: 0, dy: 0 }, `${block} blocks spectator look`);
  }
  lifecycle.disconnected = lifecycle.tornDown = false;
  gameplay.alive = true;
  gameplay.spectating = false;
  flow.syncInput();
  assert.equal(flow.inputEnabled, true, 'respawn restores normal player input');
  assert.deepEqual(input.consumeDelta(), { dx: 0, dy: 0 }, 'respawn clears spectator look');
  sync([ally], { ...self, state: 'alive' });
  assert.equal(spectator.update(null, 1 / 60), false, 'respawn releases camera ownership');
  console.log('Spectator contracts passed: mouse orbit, target changes, walls, no-target fallback, input isolation, pause/resume and respawn.');
} finally {
  spectator.dispose();
  input.dispose();
  if (savedDocument === undefined) delete globalThis.document;
  else globalThis.document = savedDocument;
}
