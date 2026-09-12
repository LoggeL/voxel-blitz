import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { WeaponAimMotion, SPRINT_AIM_DIP } from '../public/js/guns/weapon-aim.js';
import { projectAimReticle } from '../public/js/ui/aim-reticle.js';
import { ViewmodelRig } from '../public/js/guns/viewmodel.js';
import { LocalPlayer } from '../public/js/player/local-player.js';
import { WEAPONS } from '../shared/combatmath.js';
import { NetClient } from '../public/js/engine/netclient.js';
import { GameEngine } from '../server/game.js';
import { PlayerEntity } from '../server/sim/player.js';
import { stepMovement } from '../server/sim/movement.js';

const close = (a, b, message, epsilon = 1e-5) => assert.ok(Math.abs(a - b) < epsilon, `${message}: ${a} vs ${b}`);
const model = new WeaponAimMotion();
for (let i = 0; i < 120; i++) model.update(1 / 60, { weapon: 'rifle', sprinting: true });
close(model.readModel.pitch, -SPRINT_AIM_DIP, 'Sprint lowers the actual shot ray');
close(model.readModel.yaw, 0, 'Straight sprint does not invent horizontal aim');
const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.01, 400);
camera.rotation.order = 'YXZ';
const down = projectAimReticle(camera, 0, model.readModel.pitch);
assert.ok(down.y > 0.56 && down.y < 0.60, 'Sprint reticle follows the lower ray on screen');
close(down.x, 0.5, 'Straight sprint remains horizontally aligned');

for (const fov of [50, 75, 100]) {
  camera.fov = fov; camera.updateProjectionMatrix();
  camera.rotation.set(0.4, 1.2, 0.06);
  const aim = projectAimReticle(camera, 1.13, 0.29);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(aim.x * 2 - 1, 1 - aim.y * 2), camera);
  const expected = new THREE.Vector3(-Math.sin(1.13) * Math.cos(0.29), Math.sin(0.29), -Math.cos(1.13) * Math.cos(0.29));
  assert.ok(ray.ray.direction.angleTo(expected) < 1e-7, 'Reticle unprojects onto the shot ray at every FOV');
}
model.update(1 / 60, { weapon: 'rifle', yaw: 0.3, pitch: 0.15 });
assert.ok(model.readModel.yaw < 0 && model.readModel.pitch < 0, 'The reticle follows carried-weapon turn lag');
model.update(1 / 60, { weapon: 'rifle', yaw: 0.3, pitch: 0.15, ads: 1, sprinting: true });
assert.ok(model.readModel.yaw < 0 && model.readModel.pitch < 0, 'ADS preserves real turn lag');
for (let i = 0; i < 240; i++) model.update(1 / 60, { weapon: 'rifle', yaw: 0.3, pitch: 0.15, ads: 1, sprinting: true });
close(model.readModel.yaw, 0, 'ADS settles horizontal aim onto the sight');
close(model.readModel.pitch, 0, 'ADS raises sprint carry and settles vertical aim');
model.update(1 / 60, { weapon: 'sniper', yaw: -2, pitch: -0.8 });
close(model.readModel.yaw, 0, 'Weapon swap clears stale angular lag');

// Camera-local Euler addition diverges at steep view pitches. Check the actual
// muzzle transform against the ballistic ray, including both signs of pitch.
const rig = new ViewmodelRig(camera);
rig.setWeapon('rifle');
for (let i = 0; i < 180; i++) rig.update(1 / 60, { grounded: true, aimSwayScale: 0 });
for (const pitch of [-Math.PI / 3, 0, Math.PI / 3]) {
  camera.rotation.set(pitch, 1.2, 0);
  const shotYaw = 1.35, shotPitch = pitch - 0.11;
  const weaponAim = { yaw: 0.15, pitch: -0.11, turn: { yaw: 0.15, pitch: 0, roll: 0, x: 0, y: 0 } };
  rig.update(1 / 60, { grounded: true, aimSwayScale: 0, weaponAim, shotYaw, shotPitch });
  const bore = new THREE.Vector3(0, 0, -1).applyQuaternion(rig._cur.muzzleMarker.getWorldQuaternion(new THREE.Quaternion()));
  const expected = new THREE.Vector3(-Math.sin(shotYaw) * Math.cos(shotPitch), Math.sin(shotPitch), -Math.cos(shotYaw) * Math.cos(shotPitch));
  assert.ok(bore.angleTo(expected) < 1e-6, `Muzzle and ray agree at view pitch ${pitch}`);
}
rig.dispose();

const input = new Proxy({ consumeDelta: () => ({ dx: 0, dy: 0 }),
  getKeys: () => ({ forward: true, sprint: true }), setGameplayEnabled() {},
  wantAdsHeld: false, wantFireHeld: false }, { get: (target, key) => target[key] ?? (() => false) });
const physics = { pos: { x: 4, y: 1, z: 4 }, vel: { x: 0, y: 0, z: -6.2 },
  grounded: true, _crouching: false, step: () => false, eyeY: () => 2.62, setMapMeta() {} };
const player = new LocalPlayer({ input, physics, aimSway: {
  readModel: { yaw: 0, pitch: 0 }, reset: () => ({ yaw: 0, pitch: 0 }), update: () => ({ yaw: 0, pitch: 0 }),
} });
player.setGameplayInputEnabled(true);
let payload, predicted;
for (let i = 0; i < 120; i++) player.update(1 / 60, i * 1000 / 60, {
  weapon: { def: WEAPONS.rifle, slot: 0, adsT: 0, isReloading: false },
  movementAllowed: true, fireAllowed: true,
  beforeSend: () => { predicted = { yaw: player.shotYaw, pitch: player.shotPitch }; },
  sendInput: (p) => { payload = p; return true; },
});
assert.ok(predicted.pitch < -0.10, 'Live player uses the sprint direction before firing');
close(payload.pitch, predicted.pitch, 'Wire pitch equals predicted shot pitch');
close(payload.yaw, predicted.yaw, 'Wire yaw equals predicted shot yaw');
close(payload.viewYaw, player.view.yaw, 'Movement yaw stays with the view');
player.updateCamera(1 / 60, camera, WEAPONS.rifle, 0);
close(camera.rotation.x, 0, 'Carried muzzle does not pull the camera down');
player.setGameplayInputEnabled(false);
close(player.weaponAim.pitch, 0, 'Pause clears stale carry aim');
player.dispose();

const net = new NetClient(); let wire;
net.ws = { readyState: 1, send: (json) => { wire = JSON.parse(json); } };
assert.ok(net.sendInput({ keys: { forward: true }, yaw: 0.2, pitch: -0.11, viewYaw: 0 }));
close(wire.viewYaw, 0, 'Transport retains independent movement heading');
const authority = new PlayerEntity('aim', 'Test', { x: 4, y: 1, z: 4 }, false);
authority.deployT = 0; authority.grounded = true;
const host = { entities: new Map([['aim', authority]]) };
GameEngine.prototype.applyInput.call(host, 'aim', wire);
stepMovement(authority, 1 / 60, { solidAt: (_x, y) => y < 1, mapMeta: {}, now: 1, onFall() {} });
close(authority.x, 4, 'Server movement does not drift sideways with weapon lag');
assert.ok(authority.z < 4, 'Server still moves forward');
close(authority.yaw, 0.2, 'Authority retains the actual weapon yaw');
close(authority.pitch, -0.11, 'Authority retains the lowered shot pitch');
delete wire.viewYaw;
GameEngine.prototype.applyInput.call(host, 'aim', wire);
close(authority.input.viewYaw, wire.yaw, 'Legacy clients retain their movement convention');
console.log('Weapon aim: sprint, turn lag, ADS, projection, prediction/wire parity, camera independence and movement passed.');
