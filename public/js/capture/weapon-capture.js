import * as THREE from '../vendor/three.module.js';
import { WEAPONS } from '../../../shared/combatmath.js';
import { findWeaponCaptureShot } from '../../../shared/weapon-capture-shots.js';
import { ViewmodelRig } from '../guns/viewmodel.js';
import { createSniperScope } from '../ui/sniper-scope.js';

const params = new URLSearchParams(location.search);
const weapon = params.get('weapon') || 'rifle';
const state = params.get('state') || 'held';
const shot = findWeaponCaptureShot(weapon, state);

if (!shot) throw new Error(`unknown weapon capture: ${weapon}/${state}`);

const canvas = document.getElementById('capture');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight, false);

const camera = new THREE.PerspectiveCamera(
  state === 'scoped' ? WEAPONS[weapon].adsFov : 75,
  innerWidth / innerHeight,
  0.01,
  100,
);
camera.position.set(0, 1.62, 0);
camera.lookAt(0, 1.62, -10);
camera.updateProjectionMatrix();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x263c52);
scene.fog = new THREE.Fog(0x263c52, 12, 28);
scene.add(camera);
scene.add(new THREE.HemisphereLight(0xc9e0ff, 0x463a30, 0.75));
const keyLight = new THREE.DirectionalLight(0xfff0d8, 1.65);
keyLight.position.set(-3, 6, 4);
scene.add(keyLight);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(30, 30),
  new THREE.MeshStandardMaterial({ color: 0x334a55, roughness: 0.92, metalness: 0.04 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.set(0, 0, -8);
scene.add(floor);

const backstop = new THREE.Mesh(
  new THREE.BoxGeometry(18, 8, 0.25),
  new THREE.MeshStandardMaterial({ color: 0x536778, roughness: 0.82, metalness: 0.18 }),
);
backstop.position.set(0, 3.5, -16);
scene.add(backstop);

const targetMaterial = new THREE.MeshBasicMaterial({ color: 0xffa031 });
for (const [width, height, x, y] of [
  [1.8, 0.08, 0, 1.62],
  [0.08, 1.8, 0, 1.62],
  [0.55, 0.55, 0, 1.62],
]) {
  const marker = new THREE.Mesh(new THREE.BoxGeometry(width, height, 0.04), targetMaterial);
  marker.position.set(x, y, -15.82);
  scene.add(marker);
}

const inspectionFill = new THREE.PointLight(0xfff1dc, 2.4, 3.5, 1.4);
inspectionFill.position.set(-0.35, 0.45, 0.25);
camera.add(inspectionFill);

const rig = new ViewmodelRig(camera);
rig.setWeapon(weapon);

const stablePose = Object.freeze({
  speed: 0,
  grounded: true,
  aimSwayScale: 0,
});
switch (state) {
  case 'charge-low':
  case 'charge-high':
  case 'held':
    rig.ads(0);
    break;
  case 'scoped':
    rig.ads(1);
    break;
  case 'firing':
    rig.ads(0);
    break;
  default:
    throw new Error(`weapon capture state is not implemented: ${state}`);
}
for (let frame = 0; frame < 300; frame++) rig.update(1 / 60, stablePose);

if (state === 'scoped' && weapon === 'sniper') {
  rig.root.visible = false;
  const scope = createSniperScope(document.getElementById('hud'));
  scope.classList.add('active');
  scope.style.opacity = '1';
  scope.style.transform = 'scale(1)';
}

if (state.startsWith('charge-')) {
  rig.setCharge(state === 'charge-low' ? 0.2 : 0.95);
  for (let frame = 0; frame < 30; frame++) rig.update(1 / 60, stablePose);
}

if (state === 'firing') {
  if (!rig.fire()) throw new Error(`weapon capture could not fire: ${weapon}`);
  if (WEAPONS[weapon].mode === 'pump') rig.pumpAnim();
  if (WEAPONS[weapon].mode === 'bolt') rig.boltAnim();
  rig.update(1 / 60, stablePose);
}

renderer.render(scene, camera);
renderer.render(scene, camera);

document.documentElement.dataset.captureReady = 'true';
document.documentElement.dataset.captureWeapon = weapon;
document.documentElement.dataset.captureState = state;
window.__vbWeaponCapture = Object.freeze({ weapon, state });
