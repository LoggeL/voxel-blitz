import * as THREE from '../vendor/three.module.js';
import { WEAPONS, WEAPON_IDS, reloadPlan } from '../../../shared/combatmath.js';
import { ViewmodelRig } from '../guns/viewmodel.js';
import { WeaponAimMotion } from '../guns/weapon-aim.js';
import { projectAimReticle } from '../ui/aim-reticle.js';
import { fwdFromAngles } from '../util/look.js';

const $ = (id) => document.getElementById(id);
const renderer = new THREE.WebGLRenderer({ canvas: $('scene'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.01, 200);
camera.position.set(0, 1.62, 0); camera.rotation.order = 'YXZ';
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x263c52);
scene.add(camera, new THREE.HemisphereLight(0xd0e7ff, 0x514132, 1.5));
const light = new THREE.DirectionalLight(0xffeed6, 2); light.position.set(-3, 6, 4); scene.add(light);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: 0x425362 }));
floor.rotation.x = -Math.PI / 2; scene.add(floor);
scene.add(new THREE.GridHelper(80, 40, 0x8998a2, 0x596b78));
for (let x = -12; x <= 12; x += 3) {
  const board = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.4, 0.1), new THREE.MeshStandardMaterial({ color: 0x8c7b62 }));
  board.position.set(x, 1.2, -15); scene.add(board);
  const target = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.35, 32), new THREE.MeshBasicMaterial({ color: 0xffa432 }));
  target.position.set(x, 1.62, -14.93); scene.add(target);
}
const rig = new ViewmodelRig(camera), aimMotion = new WeaponAimMotion();
for (const id of WEAPON_IDS) {
  const option = document.createElement('option'); option.value = id; option.textContent = WEAPONS[id].name; $('weapon').append(option);
}
let weapon = 'rifle', sprint = false, ads = false, paused = false, yaw = 0, reloadAt = null, elapsed = 0, duration = 0;
let trace = null, traceUntil = 0;
const context = () => ({ speed: sprint ? 6.2 : 0, grounded: true, isSprinting: sprint && !ads,
  forwardSpeed: sprint ? 6.2 : 0, aimSwayScale: 0, weaponAim: aimMotion.readModel,
  shotYaw: yaw + aimMotion.readModel.yaw, shotPitch: aimMotion.readModel.pitch });
const settle = () => {
  rig.setWeapon(weapon); aimMotion.reset(yaw, 0); rig.ads(ads ? 1 : 0);
  for (let i = 0; i < 180; i++) rig.update(1 / 60, context());
};
function startReload() {
  if (WEAPONS[weapon].mode === 'melee') return;
  const plan = reloadPlan(WEAPONS[weapon], 0); duration = plan.seconds;
  rig.reload(duration, plan.staged ? 'tube' : 'magswap', plan.staged ? {
    startSeconds: plan.startSeconds, perRoundSeconds: plan.perRoundSeconds, rounds: plan.rounds,
  } : null);
  reloadAt = elapsed; $('phase').value = 0;
}
function toggle(id, value) { $(id).setAttribute('aria-pressed', String(value)); }
$('weapon').addEventListener('change', () => { weapon = $('weapon').value; reloadAt = null; settle(); });
$('sprint').addEventListener('click', () => { sprint = !sprint; toggle('sprint', sprint); });
$('ads').addEventListener('click', () => { ads = !ads; rig.ads(ads ? 1 : 0); toggle('ads', ads); });
$('turn').addEventListener('click', () => { yaw += 0.5; });
$('pause').addEventListener('click', () => { paused = !paused; toggle('pause', paused); });
$('reload').addEventListener('click', () => { paused = false; toggle('pause', false); startReload(); });
$('phase').addEventListener('input', () => {
  const phase = Number($('phase').value); settle(); startReload();
  let remaining = phase * duration;
  while (remaining > 0) { const step = Math.min(1 / 120, remaining); rig.update(step, context()); remaining -= step; }
  reloadAt = elapsed - phase * duration; paused = true; toggle('pause', true); $('phase').value = phase;
});
$('fire').addEventListener('click', () => {
  if (!rig.fire()) return;
  const aim = aimMotion.readModel, dir = fwdFromAngles(yaw + aim.yaw, aim.pitch);
  const end = new THREE.Vector3(dir.x, dir.y, dir.z).multiplyScalar(15).add(camera.position);
  if (trace) { scene.remove(trace); trace.geometry.dispose(); trace.material.dispose(); }
  trace = new THREE.Line(new THREE.BufferGeometry().setFromPoints([rig.getMuzzleWorldPos(), end]),
    new THREE.LineBasicMaterial({ color: 0xffd79a }));
  scene.add(trace); traceUntil = elapsed + 0.18;
});
function resize() {
  renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize(); settle();
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (!paused) {
    elapsed += dt; camera.rotation.y = yaw;
    aimMotion.update(dt, { weapon, yaw, pitch: 0, weightKg: WEAPONS[weapon].weightKg,
      ads: ads ? 1 : 0, sprinting: sprint && !ads });
    rig.update(dt, context());
    if (trace && elapsed > traceUntil) { scene.remove(trace); trace.geometry.dispose(); trace.material.dispose(); trace = null; }
  }
  const aim = aimMotion.readModel;
  const reticle = projectAimReticle(camera, yaw + aim.yaw, aim.pitch);
  $('crosshair').style.left = `${reticle.x * 100}%`; $('crosshair').style.top = `${reticle.y * 100}%`;
  const progress = reloadAt === null ? 0 : Math.min(1, (elapsed - reloadAt) / duration);
  if (!paused) $('phase').value = progress;
  $('progress').textContent = `${Math.round(progress * 100)}%`;
  $('status').textContent = `${WEAPONS[weapon].name} · ${sprint ? 'Sprint' : 'Stand'}${ads ? ' · Visier' : ''}\n`
    + `Zielrichtung: ${(aim.yaw * 180 / Math.PI).toFixed(2)}° seitlich / ${(aim.pitch * 180 / Math.PI).toFixed(2)}° vertikal\n`
    + `Fadenkreuz: ${(reticle.x * 100).toFixed(2)}% / ${(reticle.y * 100).toFixed(2)}% · Nachladen: ${Math.round(progress * 100)}%`;
  renderer.render(scene, camera);
  document.documentElement.dataset.previewReady = 'true';
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
