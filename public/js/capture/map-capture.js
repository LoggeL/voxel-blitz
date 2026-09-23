import * as THREE from '../vendor/three.module.js';
import { createMapState } from '../../../shared/worlddata.js';
import { findMapCaptureShot } from '../../../shared/map-capture-shots.js';
import { WorldView } from '../engine/worldview.js';
import { CombatPostProcess } from '../engine/combat-post-process.js';
import { rendererCapabilities, resolveGraphicsProfile } from '../engine/graphics-quality.js';

const params = new URLSearchParams(location.search);
const map = params.get('map') || 'foundry';
const shotId = params.get('shot') || 'hero';
const shot = findMapCaptureShot(map, shotId);

if (!shot) throw new Error(`unknown map capture: ${map}/${shotId}`);

const canvas = document.getElementById('capture');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.toneMapping = THREE.NeutralToneMapping;
// Captures review the live look: the same tier knobs and post chain as a match.
// ?quality=low|medium|high|ultra picks a tier (default high), ?post=0 the raw scene.
const graphics = resolveGraphicsProfile(params.get('quality') || 'high', rendererCapabilities(renderer));
const post = params.get('post') === '0' ? null : new CombatPostProcess(renderer, {
  maxPixelRatio: 1,
  msaa: graphics.msaa,
  hdr: graphics.hdr,
  bloomLevels: graphics.bloomLevels,
  fxaa: graphics.msaa === 0,
  ssao: graphics.ssao,
});
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight, false);
post?.setSize(innerWidth, innerHeight, 1);

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
const worldview = new WorldView({ getBlock: world.getBlock, meta: world.meta }, world.meta, { graphics, renderer });
post?.setGrade(worldview.palette.grade);
await worldview.ready();
await worldview.skyUpdate.ready;
worldview.setGameMode(shot.mode);
worldview.scene.add(camera);

// Two synchronous frames let sky callbacks and matrices settle without
// introducing gameplay, network, avatar, HUD, weapon state, or a headless
// requestAnimationFrame dependency before the document load event.
// ?avatars=1 stands a few static avatars in the shot (character light, contact shadows).
const captureAvatars = params.get('avatars') === '1'
  ? await (await import('./capture-avatars.js')).placeCaptureAvatars(worldview, camera, world.getBlock, params) : null;
worldview.update(0, camera);
const frame = () => (post ? post.render(worldview.scene, camera, { time: 0, adaptInstant: true }) : renderer.render(worldview.scene, camera));
frame();
frame();

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
  graphics,
  post: post?.stats || null,
  avatars: captureAvatars,
});
