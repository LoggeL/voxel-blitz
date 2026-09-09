import * as THREE from './vendor/three.module.js';
import { CombatPostProcess } from './engine/combat-post-process.js';
import { AvatarRoster } from './avatar/avatar-roster.js';
import { ViewmodelRig } from './guns/viewmodel.js';
import { ProjectileFX } from './weapons/projectiles.js';
import { Killcam } from './player/killcam.js';
import { grenadeLaunch, stepGrenade, GRENADE_TYPES } from '../../shared/grenade-rules.js';
import { SMOKE, smokeBlocksSight } from '../../shared/smoke-rules.js';

const stage = document.getElementById('preview-stage');
const status = document.getElementById('preview-status');
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x263746);
scene.fog = new THREE.FogExp2(0x263746, 0.018);
scene.add(new THREE.HemisphereLight(0xc7e7ed, 0x62503d, 2));
const sun = new THREE.DirectionalLight(0xffd29c, 2.6); sun.position.set(-4, 10, 5); scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial({ color: 0x354752, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; scene.add(ground, new THREE.GridHelper(100, 100, 0x53656a, 0x3f515b));
const block = new THREE.BoxGeometry(1, 1, 1);
const steel = new THREE.MeshStandardMaterial({ color: 0x596972, roughness: 0.85 });
for (const x of [-5, 5]) for (let z = -12; z < 10; z += 4) for (let h = 0; h < 2; h++) {
  const crate = new THREE.Mesh(block, steel); crate.scale.set(1.5, 1, 1.6); crate.position.set(x, h + 0.5, z); scene.add(crate);
}
const getBlock = (_x, y) => y < 0 ? 1 : 0;
const camera = new THREE.PerspectiveCamera(68, 1, 0.04, 200); camera.position.set(0, 1.62, 10); scene.add(camera);
const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); stage.append(renderer.domElement);
const post = new CombatPostProcess(renderer);
const rig = new ViewmodelRig(camera); rig.setWeapon('rifle');
const live = new THREE.Group(); scene.add(live);
const roster = new AvatarRoster({ scene: live, getBlock });
const projectiles = new ProjectileFX(live, getBlock, { camera });
const killcam = new Killcam({ scene, getBlock });
const target = { id: 'target', name: 'TARGET', state: 'alive', hp: 100, weapon: 0,
  x: 0, y: 0, z: -8, yaw: Math.PI, pitch: 0, grounded: true, team: null };
let cloud = null, thrown = null, sequence = 0, inside = false, previous = performance.now();
const eyeOutside = () => { inside = false; camera.position.set(0, 1.62, 10); camera.rotation.set(0, 0, 0); };
function reset() {
  killcam.stop(); eyeOutside(); cloud = thrown = null; rig.cancelGrenade();
  for (const p of [...projectiles.projectiles.values()]) projectiles.explode({ pid: p.id, type: 'smoke', x: p.x, y: p.y, z: p.z });
}
function deploy(x, y, z, now) {
  cloud = { id: 'preview-smoke', x, y: y + 1, z, radius: SMOKE.radius,
    createdAt: now, expiresAt: now + SMOKE.durationMs };
}
document.getElementById('preview-throw').onclick = () => {
  reset(); const now = performance.now();
  rig.grenadeCharge(0.25, 'smoke', 600, true);
  for (let i = 0; i < 60; i++) rig.update(1 / 120, { grounded: true });
  rig.grenadeThrow(0.25, 'smoke');
  thrown = { ...grenadeLaunch({ x: 0, y: 0, z: 10, eyeY: 1.62, charge: 0.25, type: 'smoke', dir: { x: 0, y: 0, z: -1 } }),
    id: `preview-${sequence++}`, until: now + GRENADE_TYPES.smoke.fuseMs };
  projectiles.launch({ pid: thrown.id, type: 'smoke', o: [thrown.x, thrown.y, thrown.z],
    v: [thrown.vx, thrown.vy, thrown.vz], fuse: GRENADE_TYPES.smoke.fuseMs });
};
document.getElementById('preview-inside').onclick = () => {
  killcam.stop();
  if (!cloud || cloud.expiresAt <= performance.now()) deploy(0, 0.16, -1, performance.now() - 1000);
  inside = !inside;
  if (inside) camera.position.set(cloud.x, 1.62, cloud.z);
  else eyeOutside();
};
document.getElementById('preview-reset').onclick = reset;
document.getElementById('preview-replay').onclick = () => {
  reset(); killcam.history.clear();
  for (let t = 0; t <= 3000; t += 50) {
    const x = -1.2 + t / 2000, z = 5 - t / 1500;
    const yaw = Math.atan2(x, 8 + z);
    const dead = t === 3000;
    killcam.history.record({ serverNow: t,
      players: [{ ...target, id: 'attacker', name: 'RAIDER', x, z, yaw, moveSpeed: 1.2 },
        { ...target, state: dead ? 'dead' : 'alive', hp: dead ? 0 : 100 }],
      events: t >= 2400 && t % 200 === 0 ? [{ kind: 'shoot', id: 'attacker', w: 'rifle',
        o: [x, 1.47, z], d: [-Math.sin(yaw), 0, -Math.cos(yaw)] }] : [],
    });
  }
  killcam.start({ killer: 'attacker', victim: 'target', w: 'rifle' }, 'fun');
};
function resize() {
  const { width, height } = stage.getBoundingClientRect();
  renderer.setSize(width, height, false); post.setSize(width, height, renderer.getPixelRatio());
  camera.aspect = width / height; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage); resize();
window.addEventListener('error', event => { status.dataset.error = 'true'; status.textContent = event.message; });
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - previous) / 1000); previous = now;
  if (thrown) {
    stepGrenade(thrown, dt, (_x, y) => y < 0);
    if (now >= thrown.until) {
      deploy(thrown.x, thrown.y, thrown.z, now);
      projectiles.explode({ pid: thrown.id, type: 'smoke', x: thrown.x, y: thrown.y, z: thrown.z }); thrown = null;
    }
  }
  if (cloud?.expiresAt <= now) cloud = null;
  const fields = cloud ? [cloud] : [];
  rig.update(dt, { grounded: true }); projectiles.update(dt);
  roster.sync(new Map([[target.id, target]]), dt, now);
  const blocked = smokeBlocksSight(fields, camera.position.toArray(), [target.x, 1.6, target.z], now);
  roster.updateLabels(camera, () => null, '', null, () => blocked);
  const replay = killcam.update(dt, camera.aspect, 68);
  live.visible = rig.root.visible = !replay;
  post.render(scene, replay ? killcam.camera : camera, { time: now / 1000,
    smokeFields: replay ? killcam.sample.smokeFields : fields, smokeNow: replay ? killcam.sample.time : now });
  if (!status.dataset.error) status.textContent = replay ? 'Killcam · drei Sekunden Demo-Verlauf · Leertaste überspringt'
    : thrown ? 'Rauchgranate unterwegs · Zündung nach 1,8 Sekunden'
      : cloud ? `${inside ? 'In der Wolke' : 'Wolke aktiv'} · ${((cloud.expiresAt - now) / 1000).toFixed(1)}s · ${blocked ? 'Ziel und Namensschild verdeckt' : 'freie Sicht zum Ziel'}`
        : 'Bereit · 4 m Radius · 12 Sekunden Rauch · kein Schaden';
  document.documentElement.dataset.previewReady = 'true';
}
requestAnimationFrame(frame);
