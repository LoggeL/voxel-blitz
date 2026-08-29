import * as THREE from '../vendor/three.module.js';
import { findAvatarCaptureShot } from '../../../shared/avatar-capture-shots.js';
import { disposeAvatar, makeAvatar, updateAvatarWeaponPose } from '../avatar/avatar.js';

const params = new URLSearchParams(location.search);
const weapon = params.get('weapon') || 'rifle';
const view = params.get('view') || 'front';
const shot = findAvatarCaptureShot(weapon, view);
if (!shot) throw new Error(`unknown avatar capture: ${weapon}/${view}`);

const canvas = document.getElementById('capture');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;

const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.01, 100);
const cameraByView = {
  front: [2.55, 1.48, -4.1],
  profile: [4.25, 1.44, -0.15],
  firing: [2.55, 1.48, -4.1],
};
camera.position.fromArray(cameraByView[view]);
camera.lookAt(0, 1.12, -0.12);
camera.updateProjectionMatrix();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x17202a);
scene.fog = new THREE.Fog(0x17202a, 10, 22);
scene.add(new THREE.HemisphereLight(0xd7e9ff, 0x31281f, 1.5));
const keyLight = new THREE.DirectionalLight(0xffead0, 3.2);
keyLight.position.set(-3, 6, -4);
keyLight.castShadow = true;
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0x6db7ff, 1.5);
rimLight.position.set(4, 3, 3);
scene.add(rimLight);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(18, 18),
  new THREE.MeshStandardMaterial({ color: 0x31414b, roughness: 0.9, metalness: 0.05 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const backdrop = new THREE.Mesh(
  new THREE.BoxGeometry(9, 4.5, 0.18),
  new THREE.MeshStandardMaterial({ color: 0x263541, roughness: 0.82, metalness: 0.08 }),
);
backdrop.position.set(0, 2, 2.6);
scene.add(backdrop);

const avatar = makeAvatar('capture-avatar', 'CAPTURE', 'alpha');
avatar.tag.visible = false;
avatar.hpSpr.visible = false;
avatar.group.traverse((object) => {
  if (object.isMesh) {
    object.castShadow = true;
    object.receiveShadow = true;
  }
});
scene.add(avatar.group);

const firing = view === 'firing';
for (let frame = 0; frame < 12; frame++) {
  updateAvatarWeaponPose(avatar, {
    weapon,
    pitch: firing ? -0.06 : 0,
    firing,
    dt: 1 / 60,
    blend: 1,
  });
}

renderer.render(scene, camera);
renderer.render(scene, camera);

document.documentElement.dataset.captureReady = 'true';
document.documentElement.dataset.captureWeapon = weapon;
document.documentElement.dataset.captureView = view;
window.__vbAvatarCapture = Object.freeze({ weapon, view });
window.addEventListener('pagehide', () => disposeAvatar(avatar), { once: true });
