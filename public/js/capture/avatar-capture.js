import * as THREE from '../vendor/three.module.js';
import { findAvatarCaptureShot } from '../../../shared/avatar-capture-shots.js';
import {
  disposeAvatar,
  makeAvatar,
  updateAvatarStancePose,
  updateAvatarWeaponPose,
} from '../avatar/avatar.js';

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
  'ads-profile': [4.25, 1.48, -0.15],
  'prone-profile': [4.25, 1.18, -0.15],
  'crouched-profile': [4.25, 1.18, -0.15],
  spectator: [3.4, 2.45, 3.4],
};
camera.position.fromArray(cameraByView[view]);
camera.lookAt(0, view === 'crouched-profile' ? 0.92 : view === 'spectator' ? 1.35 : 1.12,
  view === 'spectator' ? -0.8 : -0.12);
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
if (view === 'spectator') backdrop.position.z = -2.6;
scene.add(backdrop);

const avatar = makeAvatar(params.get('avatar') || 'capture-avatar', 'CAPTURE', params.get('team') || 'alpha');
avatar.tag.visible = false;
avatar.hpSpr.visible = false;
avatar.group.traverse((object) => {
  if (object.isMesh) {
    object.castShadow = true;
    object.receiveShadow = true;
  }
});
scene.add(avatar.group);

const { firing, ads, crouching, proneT = 0 } = shot;
for (let frame = 0; frame < 30; frame++) {
  updateAvatarWeaponPose(avatar, {
    weapon,
    pitch: firing ? -0.06 : ads ? -0.1 : 0,
    firing,
    ads,
    crouching,
    proneT,
    dt: 1 / 60,
    blend: 1,
  });
  updateAvatarStancePose(avatar, { blend: 1 });
}

renderer.render(scene, camera);
renderer.render(scene, camera);

avatar.group.updateMatrixWorld(true);
const weaponBounds = avatar.weaponModel.modelRoot
  ? new THREE.Box3().setFromObject(avatar.weaponModel.modelRoot)
  : new THREE.Box3();
const weaponCorners = [];
for (const x of [weaponBounds.min.x, weaponBounds.max.x]) {
  for (const y of [weaponBounds.min.y, weaponBounds.max.y]) {
    for (const z of [weaponBounds.min.z, weaponBounds.max.z]) {
      weaponCorners.push(new THREE.Vector3(x, y, z).project(camera));
    }
  }
}
const headCenter = avatar.head.getWorldPosition(new THREE.Vector3());
const sightLine = avatar.weaponModel.getSightWorldPosition(new THREE.Vector3());
const captureMetrics = Object.freeze({
  gripError: avatar.rHand.getWorldPosition(new THREE.Vector3()).distanceTo(
    avatar.weaponModel.modelRoot.localToWorld(new THREE.Vector3(
      avatar.weaponModel.handPose.grip.x, avatar.weaponModel.handPose.grip.y, avatar.weaponModel.handPose.grip.z))),
  sightEyeDelta: Math.abs((headCenter.y - 0.04) - sightLine.y),
  weaponInFrame: weaponCorners.length === 8 && weaponCorners.every((corner) =>
    Math.abs(corner.x) < 0.98 && Math.abs(corner.y) < 0.98 &&
    corner.z > -1 && corner.z < 1),
});
if (captureMetrics.gripError > 0.001 || !captureMetrics.weaponInFrame || (ads && captureMetrics.sightEyeDelta > 0.08)) {
  throw new Error(`invalid avatar capture composition: ${JSON.stringify(captureMetrics)}`);
}

document.documentElement.dataset.captureReady = 'true';
document.documentElement.dataset.captureWeapon = weapon;
document.documentElement.dataset.captureView = view;
document.documentElement.dataset.capturePose = shot.pose;
window.__vbAvatarCapture = Object.freeze({ weapon, view, ads, crouching, ...captureMetrics });
window.addEventListener('pagehide', () => disposeAvatar(avatar), { once: true });
