import * as THREE from '../vendor/three.module.js';
import { createMapState } from '../../../shared/worlddata.js';
import { findMapCaptureShot } from '../../../shared/map-capture-shots.js';
import { WorldView } from '../engine/worldview.js';

const params = new URLSearchParams(location.search);
const map = params.get('map') || 'foundry';
const shotId = params.get('shot') || 'hero';
const shot = findMapCaptureShot(map, shotId);

if (!shot) throw new Error(`unknown map capture: ${map}/${shotId}`);

const canvas = document.getElementById('capture');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight, false);

const camera = new THREE.PerspectiveCamera(
  shot.fov,
  innerWidth / innerHeight,
  0.05,
  400,
);
camera.position.fromArray(shot.position);
camera.lookAt(new THREE.Vector3().fromArray(shot.target));
camera.updateProjectionMatrix();

const world = createMapState(map);
const worldview = new WorldView({ getBlock: world.getBlock, meta: world.meta }, world.meta);
await worldview.ready();
await worldview.skyUpdate.ready;
worldview.setGameMode(shot.mode);
worldview.scene.add(camera);

// Two synchronous frames let sky callbacks and matrices settle without
// introducing gameplay, network, avatar, HUD, weapon state, or a headless
// requestAnimationFrame dependency before the document load event.
worldview.update(0);
renderer.render(worldview.scene, camera);
renderer.render(worldview.scene, camera);

document.documentElement.dataset.captureReady = 'true';
document.documentElement.dataset.captureMap = map;
document.documentElement.dataset.captureShot = shotId;
window.__vbCapture = Object.freeze({
  map,
  shot: shotId,
  mode: shot.mode,
  position: shot.position,
  target: shot.target,
  fov: shot.fov,
});
