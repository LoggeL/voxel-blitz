/**
 * Interaction animation capture page (docs/design/interact-anims/): the real
 * first-person viewmodel (ViewmodelRig, Blender arms) through an InteractAnim
 * hold, and the third-person avatar pose with the world charge. No audio, no
 * server: render() steps the rig itself and draws once. Driven by
 * tools/interact-anims-capture.mjs:
 *
 *   await __interact.render({ kind: 'plant', phase: 'work', ms: 1500 })
 *   await __interact.third({ kind: 'revive', ms: 900 })
 *
 * `phase` 'work' holds for `ms` (the progress follows `holdMs`); 'finish'
 * completes the hold and renders `ms` into the finishing beat; 'cancel'
 * releases after 1 s and renders `ms` into the drop.
 */
import * as THREE from '../vendor/three.module.js';
import { loadBlenderAssets } from '../engine/blender-assets.js';
import { ViewmodelRig } from '../guns/viewmodel.js';
import { InteractAnim, INTERACT_ANIM } from '../session/interact-anim.js';
import { makeAvatar, updateAvatarStancePose, updateAvatarWeaponPose } from '../avatar/avatar.js';
import { interactKneels, poseAvatarInteract, unposeAvatarInteract } from '../avatar/avatar-interact.js';
import { buildChargeModel, chargeLedOn } from '../fx/charge-model.js';
import { InteractProps } from '../fx/interact-props.js';

const HOLD_MS = Object.freeze({ plant: 3000, defuse: 5000, revive: 1200, repair: 4000, hack: 4000 });
const label = document.getElementById('capture-label');
const canvas = document.getElementById('capture');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.shadowMap.enabled = true;

function world() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9cc1d9);
  scene.fog = new THREE.Fog(0x9cc1d9, 18, 60);
  scene.add(new THREE.HemisphereLight(0xe8dcc8, 0x5a4a38, 1.3));
  const sun = new THREE.DirectionalLight(0xffe6c4, 2.2);
  sun.position.set(-4, 8, 3); sun.castShadow = true;
  scene.add(sun);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: 0xb59a6a, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  scene.add(floor);
  const block = new THREE.MeshStandardMaterial({ color: 0x8c8478, roughness: 0.9 });
  for (const [x, z, h] of [[-3, -6, 2], [4, -9, 3], [-7, -12, 4], [2, -14, 2]]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(2, h, 2), block);
    b.position.set(x, h / 2, z); b.castShadow = true; scene.add(b);
  }
  return scene;
}

await loadBlenderAssets();
const fp = { scene: world(), camera: new THREE.PerspectiveCamera(75, 1, 0.05, 200) };
fp.scene.add(fp.camera);
const rig = new ViewmodelRig(fp.camera);
// Context props: a hull panel for repair, a downed mate for revive.
const hull = new THREE.Mesh(new THREE.BoxGeometry(3, 1.6, 0.6), new THREE.MeshStandardMaterial({ color: 0x4b5336, roughness: 0.8 }));
hull.position.set(0, 0.8, -1.05); fp.scene.add(hull);
const downed = makeAvatar('capture-downed', 'MATE', 'alpha');
downed.tag.visible = downed.hpSpr.visible = false;
downed.weaponModel.root.visible = false;
downed.group.rotation.set(-Math.PI / 2, Math.PI / 2, 0, 'YXZ');
downed.group.position.set(0.15, 0.0, -1.25);
fp.scene.add(downed.group);
const pose = { speed: 0, grounded: true, aimSwayScale: 0 };

/** Step an InteractAnim through the scripted hold and return the frame at its end. */
function play(kind, phase, ms, step) {
  const anim = new InteractAnim();
  const hold = HOLD_MS[kind], start = 500;
  const cancelAt = start + 1000, doneAt = start + hold;
  const end = phase === 'work' ? start + ms : phase === 'finish' ? doneAt + ms : cancelAt + ms;
  let frame = null;
  for (let at = 0; at <= end; at += 1000 / 60) {
    const running = at >= start && (phase === 'cancel' ? at < cancelAt : at < doneAt);
    const held = at >= start && (phase !== 'cancel' || at < cancelAt);
    const interaction = running ? { kind, progress: Math.min(1, (at - start) / hold) } : null;
    frame = anim.update(at, { interaction, held, alive: true });
    step(frame, at);
  }
  return frame;
}

async function render({ kind = 'plant', phase = 'work', ms = 1200, weapon = 'rifle', fov = 75, pitch = -0.62, reducedMotion = false } = {}) {
  renderer.setSize(innerWidth, innerHeight, false);
  fp.camera.aspect = innerWidth / innerHeight; fp.camera.fov = fov; fp.camera.updateProjectionMatrix();
  hull.visible = kind === 'repair';
  downed.group.visible = kind === 'revive';
  rig.setWeapon(weapon);
  for (let i = 0; i < 90; i++) rig.update(1 / 60, pose);
  const frame = play(kind, phase, ms, (f, at) => {
    fp.camera.position.set(0, 1.62 - (reducedMotion ? 0 : f.dip), 0);
    fp.camera.rotation.set(kind === 'repair' ? -0.12 : kind === 'hack' ? -0.2 : pitch, 0, 0, 'YXZ');
    rig.update(1 / 60, { ...pose, reducedMotion, interact: f, nowMs: at });
  });
  fp.scene.updateMatrixWorld(true);
  renderer.render(fp.scene, fp.camera);
  label.textContent = `${kind} ${phase} +${ms} ms · ${frame.phase} level ${frame.level.toFixed(2)} · ${innerWidth}×${innerHeight}`;
  return { phase: frame.phase, level: frame.level, progress: frame.progress, dip: frame.dip, weaponHidden: frame.weaponHidden, draws: renderer.info.render.calls };
}

// Third person: the avatar kneeling at the work, seen from 6 m, with the world charge for plant / defuse.
const tp = { scene: world(), camera: new THREE.PerspectiveCamera(40, 1, 0.05, 200) };
const avatar = makeAvatar('capture-interact', 'CAPTURE', 'alpha');
avatar.tag.visible = avatar.hpSpr.visible = false;
avatar.group.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
tp.scene.add(avatar.group);
const mate = makeAvatar('capture-mate', 'MATE', 'alpha');
mate.tag.visible = mate.hpSpr.visible = false;
mate.weaponModel.root.visible = false;
mate.group.rotation.set(-Math.PI / 2, Math.PI / 2, 0, 'YXZ');
mate.group.position.set(0.6, 0.14, -0.62);
tp.scene.add(mate.group);
const tpHull = new THREE.Mesh(new THREE.BoxGeometry(3, 1.4, 1.8), new THREE.MeshStandardMaterial({ color: 0x4b5336, roughness: 0.8 }));
tpHull.position.set(0, 0.7, -1.55); tp.scene.add(tpHull);
const charge = buildChargeModel({ name: 'capture-world-charge' });
charge.root.position.set(0, 0, -0.62);
tp.scene.add(charge.root);
const props = new InteractProps({ scene: tp.scene });

async function third({ kind = 'plant', ms = 900, view = 'side', leftMs = 20000 } = {}) {
  renderer.setSize(innerWidth, innerHeight, false);
  tp.camera.aspect = innerWidth / innerHeight; tp.camera.updateProjectionMatrix();
  if (view === 'side') { tp.camera.position.set(3.6, 1.5, -0.2); tp.camera.lookAt(0, 0.55, -0.5); }
  else { tp.camera.position.set(1.2, 1.6, -3.8); tp.camera.lookAt(0, 0.8, -0.4); }
  mate.group.visible = kind === 'revive';
  tpHull.visible = kind === 'repair';
  charge.root.visible = kind === 'defuse' || kind === 'prop';
  const hold = kind === 'prop' ? null : { kind, progress: 0.5 };
  for (let i = 0; i <= Math.round(ms / (1000 / 60)); i++) {
    updateAvatarWeaponPose(avatar, { weapon: 'rifle', pitch: -0.5, crouching: interactKneels(hold), dt: 1 / 60, blend: 1 });
    unposeAvatarInteract(avatar);
    updateAvatarStancePose(avatar, { blend: 1 });
    poseAvatarInteract(avatar, hold, 1 / 60, i / 60);
    avatar.head.rotation.x = -0.45;
  }
  avatar.group.visible = kind !== 'prop';
  charge.setLed(chargeLedOn(ms, leftMs), 1);
  // The world props through the real module: the S&D bomb (2 s left, lit) beside a dam-style charge.
  props.update(kind === 'prop' ? { match: { mode: 'snd', bomb: { state: 'planted', x: 0.35, y: 0, z: -0.7, explodeAt: 2000 } }, serverNow: 0, nowMs: 0 } : {});
  if (kind === 'prop') { charge.root.visible = true; charge.setLed(true, 1); tp.camera.position.set(0.75, 0.5, 0.05); tp.camera.lookAt(0.15, 0.06, -0.66); }
  tp.scene.updateMatrixWorld(true);
  renderer.render(tp.scene, tp.camera);
  label.textContent = `third person ${kind} · ${innerWidth}×${innerHeight}`;
  return { level: avatar.interactLevel, draws: renderer.info.render.calls };
}

window.__interact = { render, third, rules: INTERACT_ANIM, ready: true };
