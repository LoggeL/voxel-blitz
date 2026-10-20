/**
 * FPV handset capture page (docs/design/conquest/fpv-handset/): the real
 * first-person viewmodel (ViewmodelRig, Blender arms) raising or lowering the
 * Engineer's drone handset (guns/fpv-handset.js) at a transition frame
 * (session/fpv-transition.js), over a map still. No audio, no server: render()
 * steps the rig itself and draws once. Driven by tools/fpv-handset-capture.mjs:
 *
 *   await __handset.render({ phase: 'raise', ms: 300, weapon: 'rifle', fov: 75 })
 *
 * `phase` 'raise' plays a launch for `ms`; 'lower' plays a launch, the feed and
 * a link loss, then `ms` into the lowering; 'idle' `ms` after it (the redraw).
 */
import * as THREE from '../vendor/three.module.js';
import { loadBlenderAssets } from '../engine/blender-assets.js';
import { ViewmodelRig } from '../guns/viewmodel.js';
import { FpvTransition, FPV_TRANSITION } from '../session/fpv-transition.js';

const label = document.getElementById('capture-label');
const canvas = document.getElementById('capture');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(1);
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.NeutralToneMapping;
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 400);
camera.position.set(0, 1.62, 0);
const scene = new THREE.Scene();
scene.add(camera);
scene.add(new THREE.HemisphereLight(0xe8dcc8, 0x3a3830, 1.2));
const sun = new THREE.DirectionalLight(0xffe6c4, 1.7);
sun.position.set(-3, 6, 2);
scene.add(sun);
await loadBlenderAssets();
const rig = new ViewmodelRig(camera);
const pose = { speed: 0, grounded: true, aimSwayScale: 0 };

async function render({ phase = 'raise', ms = 300, weapon = 'rifle', fov = 75, reducedMotion = false } = {}) {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.fov = fov;
  camera.updateProjectionMatrix();
  camera.rotation.set(-0.05, 0, 0);
  rig.setWeapon(weapon);
  for (let i = 0; i < 120; i++) rig.update(1 / 60, pose);
  const t = new FpvTransition();
  const r = FPV_TRANSITION, launch = 1000;
  const cutAt = launch + r.raiseMs + r.bootMs + 2000;
  const end = phase === 'raise' ? launch + ms : phase === 'lower' ? cutAt + r.lostMs + ms : cutAt + r.lostMs + r.lowerMs + ms;
  let frame = null;
  for (let at = 0; at <= end; at += 1000 / 60) {
    frame = t.update(at, { active: at >= launch && at < cutAt, alive: true, reducedMotion });
    rig.update(1 / 60, { ...pose, reducedMotion, fpvHandset: { level: frame.handset, weaponHidden: frame.weaponHidden,
      screen: frame.phase === 'lower' ? 'lost' : 'static', reducedMotion } });
  }
  // The live game hides the viewmodel while the camera is in the drone.
  rig.root.visible = frame.camera === 'body';
  scene.updateMatrixWorld(true);
  renderer.render(scene, camera);
  label.textContent = `${phase} +${ms} ms · handset ${frame.handset.toFixed(2)} · ${innerWidth}×${innerHeight}`;
  return { phase: frame.phase, handset: frame.handset, weaponHidden: frame.weaponHidden, draws: renderer.info.render.calls };
}

window.__handset = { render, ready: true };
