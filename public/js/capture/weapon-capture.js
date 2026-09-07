import * as THREE from '../vendor/three.module.js';
import { WEAPONS } from '../../../shared/combatmath.js';
import { findWeaponCaptureShot } from '../../../shared/weapon-capture-shots.js';
import { ImpactFX } from '../weapons/impacts.js';
import { RailBeamFX } from '../weapons/rail-beam.js';
import { FlameFX } from '../weapons/flame.js';
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
rig.setWeapon(state.startsWith('swap-') ? (weapon === 'rifle' ? 'revolver' : 'rifle') : weapon);

const stablePose = Object.freeze({
  speed: 0,
  vaulting: state === 'vaulting',
  grounded: true,
  aimSwayScale: 0,
});
switch (state) {
  case 'pickaxe-lift':
  case 'pickaxe-impact':
  case 'mining-low':
  case 'mining-high':
  case 'swap-stow':
  case 'swap-draw':
  case 'swap-ready':
  case 'reload-open':
  case 'reload-eject':
  case 'reload-load':
  case 'charge-low':
  case 'charge-high':
  case 'vaulting':
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

if (state.startsWith('pickaxe-')) {
  rig.fire();
  const seconds = state === 'pickaxe-lift' ? 0.15 : 0.27;
  for (let frame = 0; frame < Math.round(seconds * 100); frame++) rig.update(0.01, stablePose);
}
if (state.startsWith('mining-')) {
  const block = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x90969a, roughness: 1 }));
  block.position.set(-0.5, 1.5, -2.5);
  scene.add(block);
  const fx = new ImpactFX(scene, camera, () => 3);
  fx.mine({ x: -1, y: 1, z: -3, nx: 0, ny: 0, nz: 1, from: 3,
    progress: state === 'mining-low' ? 0.2 : 0.9 });
}

if (state.startsWith('swap-')) {
  rig.equipWeapon(weapon);
  const seconds = { 'swap-stow': 0.18, 'swap-draw': 0.8, 'swap-ready': 1.6 }[state];
  for (let frame = 0; frame < Math.round(seconds * 100); frame++) rig.update(0.01, stablePose);
}

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

if (state.startsWith('reload-')) {
  rig.reload(1, 'cylinder');
  const fraction = { 'reload-open': 0.26, 'reload-eject': 0.40, 'reload-load': 0.64 }[state];
  for (let frame = 0; frame < Math.round(fraction * 100); frame++) rig.update(0.01, stablePose);
}

if (state === 'firing') {
  if (weapon === 'minigun') rig.setMinigun({ heat: 0.82, spin: 1, overheated: false });
  if (weapon === 'flamethrower') rig.setFlame(true, 0.7);
  if (!rig.fire()) throw new Error(`weapon capture could not fire: ${weapon}`);
  if (WEAPONS[weapon].mode === 'pump') rig.pumpAnim();
  if (WEAPONS[weapon].mode === 'bolt') rig.boltAnim();
  rig.update(1 / 60, stablePose);
  if (weapon === 'flamethrower') {
    const flame = new FlameFX(scene, (_x, _y, z) => z <= -16 ? 3 : 0);
    flame.muzzleProvider = out => rig.getMuzzleWorldPos(out);
    for (let frame = 0; frame < 72; frame++) {
      rig.update(1 / 120, stablePose);
      scene.updateMatrixWorld(true);
      if (frame % 6 === 0) flame.shoot({ o: [0, 1.62, 0], d: [0, 0, -1] }, { local: true });
      flame.setLocalStream(true, [0, 0, -1], [0, 1.62, 0]);
      flame.update(1 / 120);
    }
  }
  if (weapon === 'lance') {
    const beam = new RailBeamFX(scene, (_x, _y, z) => z <= -16 ? 3 : 0);
    scene.updateMatrixWorld(true);
    beam.muzzleProvider = (out) => rig.getMuzzleWorldPos(out);
    beam.shoot({ o: [0, 1.62, 0], d: [0, 0, -1], charge: 1 }, { local: true });
    beam.update(0.04);
  }
}

renderer.render(scene, camera);
renderer.render(scene, camera);

document.documentElement.dataset.captureReady = 'true';
document.documentElement.dataset.captureWeapon = weapon;
document.documentElement.dataset.captureState = state;
window.__vbWeaponCapture = Object.freeze({ weapon, state });
