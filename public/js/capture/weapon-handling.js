import * as THREE from '../vendor/three.module.js';
import { WEAPONS, WEAPON_IDS, computeRecoilKickDeg } from '../../../shared/combatmath.js';
import { withWeaponHandling, weaponTurnProfile, HANDLING_EXTREMES } from '../../../shared/weapon-handling.js';
import { ViewmodelRig } from '../guns/viewmodel.js';
import { LocalPlayer } from '../player/local-player.js';
import { projectAimReticle } from '../ui/aim-reticle.js';
import { fwdFromAngles } from '../util/look.js';

const $ = id => document.getElementById(id), DEG = 180 / Math.PI;
const stage = $('stage'), canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x263c52);
const camera = new THREE.PerspectiveCamera(75, 1, 0.01, 150);
camera.rotation.order = 'YXZ'; camera.position.set(0, 1.62, 0); scene.add(camera);
scene.add(new THREE.HemisphereLight(0xd9eeff, 0x353932, 2));
const light = new THREE.DirectionalLight(0xffe3bb, 2.5); light.position.set(-3, 7, 4); scene.add(light);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial({ color: 0x354855 }));
floor.rotation.x = -Math.PI / 2; scene.add(floor);
scene.add(new THREE.GridHelper(100, 50, 0x7a98a9, 0x4c6270));
for (let angle = 0; angle < 360; angle += 15) {
  const a = angle / DEG;
  const group = new THREE.Group(); group.position.set(-Math.sin(a) * 18, 1.55, -Math.cos(a) * 18); group.rotation.y = a;
  const board = new THREE.Mesh(new THREE.BoxGeometry(1.7, 2.8, 0.12), new THREE.MeshStandardMaterial({ color: angle % 90 === 0 ? 0xab7945 : 0x638297 }));
  group.add(board);
  for (const radius of [0.15, 0.35, 0.65]) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(radius - 0.025, radius, 32), new THREE.MeshBasicMaterial({ color: 0xffd398 }));
    ring.position.z = 0.07; group.add(ring);
  }
  scene.add(group);
}
const rig = new ViewmodelRig(camera);
let id = 'rifle', def = WEAPONS[id], player, elapsed = 0, last = performance.now();
let aiming = false, crouching = false, steady = false, firing = false, tap = false, adsT = 0;
let nextShot = 0, shotIndex = 0, lastShot = -Infinity, measurement = null;
let dx = 0, dy = 0, trace = null, traceUntil = 0;
// The local-player module is exercised with stationary range input; world actions
// (grenades, shops, traversal) are deliberately absent from this adapter.
const no = () => false;
const input = {
  consumeDelta: () => { const value = { dx, dy }; dx = dy = 0; return value; },
  getKeys: () => ({ crouch: crouching, sprint: steady }), setGameplayEnabled() {},
  get wantAdsHeld() { return aiming; }, get wantFireHeld() { return firing; },
  consumeBuyMenuRequest: no, consumeGrenadeThrow: no, consumeWeaponSwitch: () => 0,
  consumeWeaponSlot: () => null, consumeLastWeaponRequest: no, consumeQuickMelee: no,
  consumeFireTap: no, consumeMedkit: no, isWeaponWheelClosing: no, isWeaponWheelOpen: no,
};
const physics = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, grounded: true,
  _crouching: false, step: () => false, eyeY: () => crouching ? 1.15 : 1.62, setMapMeta() {} };
function resetAim() {
  player?.dispose(); player = new LocalPlayer({ input, physics }); player.setGameplayInputEnabled(true);
  nextShot = elapsed + 0.6; shotIndex = 0; lastShot = -Infinity; tap = firing = false;
  $('burst').setAttribute('aria-pressed', 'false'); adsT = 0; measurement = null;
  rig.setWeapon(id); rig.ads(0); camera.rotation.set(0, 0, 0);
  $('status').textContent = 'Bereit. Ein Blickschwenk misst die Zeit bis auf 1° Restfehler.';
}
function syncControls() {
  const h = def.handling;
  $('ergonomics').value = h.ergonomics; $('amplitude').value = h.sway.amplitudeDeg;
  $('frequency').value = h.sway.frequencyHz; $('vertical').value = h.verticalRecoil;
  $('horizontal').value = h.horizontalRecoil;
  $('ergo-value').textContent = `${h.ergonomics} / 100`;
  $('amplitude-value').textContent = `${h.sway.amplitudeDeg.toFixed(2)}°`;
  $('frequency-value').textContent = `${h.sway.frequencyHz.toFixed(2)} Hz`;
  $('vertical-value').textContent = def.mode === 'melee' ? 'Entfällt' : `${h.verticalRecoil.toFixed(2)}°`;
  $('horizontal-value').textContent = def.mode === 'melee' ? 'Entfällt' : `${h.horizontalRecoil.toFixed(2)}°`;
  $('vertical').disabled = $('horizontal').disabled = def.mode === 'melee';
  $('turn-limit').textContent = `Maximal ${(weaponTurnProfile(h).maxSpeed * DEG).toFixed(1)}°/s, auch im Visier.`;
  $('name').textContent = def.name;
}
for (const weapon of WEAPON_IDS) {
  const option = document.createElement('option'); option.value = weapon; option.textContent = WEAPONS[weapon].name; $('weapon').append(option);
}
$('weapon').addEventListener('change', () => { id = $('weapon').value; def = WEAPONS[id]; syncControls(); resetAim(); });
for (const key of ['ergonomics', 'amplitude', 'frequency', 'vertical', 'horizontal']) $(key).addEventListener('input', () => {
  def = withWeaponHandling(WEAPONS[id], { ergonomics: +$('ergonomics').value,
    sway: { amplitudeDeg: +$('amplitude').value, frequencyHz: +$('frequency').value },
    verticalRecoil: +$('vertical').value, horizontalRecoil: +$('horizontal').value }); syncControls();
});
$('standard').addEventListener('click', () => { def = WEAPONS[id]; syncControls(); resetAim(); });
for (const key of ['heavy', 'nimble']) $(key).addEventListener('click', () => {
  // Isolate turn/sway differences; the selected weapon keeps its own recoil.
  const { ergonomics, sway } = HANDLING_EXTREMES[key]; def = withWeaponHandling(WEAPONS[id], { ergonomics, sway }); syncControls(); resetAim();
});
function turn(degrees) {
  player.view.yaw += degrees / DEG; measurement = { started: elapsed, degrees };
  $('status').textContent = `${degrees}°-Schwenk läuft …`;
}
$('turn').addEventListener('click', () => turn(90)); $('reverse').addEventListener('click', () => turn(180));
$('reset').addEventListener('click', resetAim);
$('ads').addEventListener('click', () => { aiming = !aiming; $('ads').setAttribute('aria-pressed', String(aiming)); });
$('crouch').addEventListener('click', () => { crouching = !crouching; $('crouch').setAttribute('aria-pressed', String(crouching)); });
$('breath').addEventListener('click', () => { steady = !steady; $('breath').setAttribute('aria-pressed', String(steady)); });
$('fire').addEventListener('click', () => { tap = true; });
$('burst').addEventListener('click', () => { firing = !firing; $('burst').setAttribute('aria-pressed', String(firing)); });
canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', e => { if (canvas.hasPointerCapture(e.pointerId)) { dx += e.movementX * 0.002; dy += e.movementY * 0.002; } });
canvas.addEventListener('pointerup', e => { if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId); });
function shot() {
  if (!(tap || firing) || elapsed < nextShot) return;
  tap = false;
  if (!rig.fire(def)) return;
  const origin = rig.getMuzzleWorldPos(), direction = fwdFromAngles(player.shotYaw, player.shotPitch);
  const end = new THREE.Vector3(direction.x, direction.y, direction.z).multiplyScalar(35).add(camera.position);
  if (trace) { scene.remove(trace); trace.geometry.dispose(); trace.material.dispose(); }
  trace = new THREE.Line(new THREE.BufferGeometry().setFromPoints([origin, end]), new THREE.LineBasicMaterial({ color: 0xffce81 }));
  scene.add(trace); traceUntil = elapsed + 0.22;
  if (elapsed - lastShot > def.recoil.resetMs / 1000) shotIndex = 0;
  const kick = computeRecoilKickDeg(def, shotIndex++, adsT, 0.5);
  if (def.mode !== 'melee') player.addRecoil(kick.pitch / DEG, kick.yaw / DEG, def.weightKg, def.recoil, elapsed * 1000);
  lastShot = elapsed; nextShot = elapsed + 60 / def.rpm;
}
function resize() { const r = stage.getBoundingClientRect(); renderer.setSize(r.width, r.height); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); }
new ResizeObserver(resize).observe(stage); resize(); syncControls(); resetAim();
function frame(now) {
  const dt = Math.min(0.25, Math.max(0, (now - last) / 1000)); last = now; elapsed += dt;
  adsT = Math.max(0, Math.min(1, adsT + (aiming ? 1 : -1) * dt / def.adsTime));
  player.update(dt, elapsed * 1000, { weapon: { def, slot: WEAPON_IDS.indexOf(id), adsT, isReloading: false },
    movementAllowed: true, fireAllowed: true, beforeSend: shot, sendInput: () => true });
  // The range keeps the camera on the player's look even for scopes, making lag
  // inspectable. The live game uses its existing through-scope camera behavior.
  player.updateCamera(dt, camera, def, adsT, 75, false);
  rig.ads(adsT); rig.update(dt, { grounded: true, crouch: crouching, weaponDef: def,
    weaponAim: player.weaponAim, shotYaw: player.shotYaw, shotPitch: player.shotPitch,
    aimSwayScale: player.aimMotion.rigMotionScale });
  const aim = projectAimReticle(camera, player.shotYaw, player.shotPitch);
  $('crosshair').style.left = `${aim.x * 100}%`; $('crosshair').style.top = `${aim.y * 100}%`;
  const error = Math.hypot(player.weaponAim.yaw, player.weaponAim.pitch) * DEG;
  $('measurements').textContent = `Nachführfehler ${error.toFixed(1)}° · Drehgeschwindigkeit ${(player.weaponAim.turn.speed * DEG).toFixed(1)}°/s`;
  $('warning').textContent = aim.x < 0 || aim.x > 1 || aim.y < 0 || aim.y > 1 ? 'Die Waffe zeigt noch außerhalb des Bildes.' : '';
  if (measurement && error <= 1) {
    $('status').textContent = `${measurement.degrees}° erreicht in ${(elapsed - measurement.started).toFixed(2)} s (bis auf 1°).`; measurement = null;
  }
  if (trace && elapsed >= traceUntil) { scene.remove(trace); trace.geometry.dispose(); trace.material.dispose(); trace = null; }
  renderer.render(scene, camera); document.documentElement.dataset.previewReady = 'true'; requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
