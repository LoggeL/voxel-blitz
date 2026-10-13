/**
 * Pilot wrist display capture page (docs/titanfall.md §8.7 "Wrist display"): the real first-person
 * viewmodel (ViewmodelRig with the Blender arms) holding a titanfall pilot weapon, the wrist device on its
 * left forearm (pilot-wrist.js), and the stock HUD plus TitanHud over a transparent canvas, all fed from
 * the wrist fixtures (titanfall-wrist-fixtures.js) through titanHudModel, as titan-ui.js feeds them in a
 * match. No audio, no server, no requestAnimationFrame: render() steps every clock itself and draws once.
 * Driven by tools/titanfall-wrist-capture.mjs through window.__wrist:
 *
 *   await __wrist.render({ state: 'grapple-1', weapon: 'rifle', fov: 75, wrist: true, touch: false, ads: 0, gun: false })
 *
 * `gun: true` also feeds the drawn gun's on-gun counter (weapon-display.js, §8.6) from the same stock ammo as the
 * card and sets body[data-titanfall-gun-display] from rig.weaponDisplayLive, as titan-ui's syncGunDisplay does:
 * both diegetic readouts live together (the integration shots).
 *   await __wrist.setBackdrop(dataUrl)
 */
import * as THREE from '../vendor/three.module.js';
import { loadBlenderAssets } from '../engine/blender-assets.js';
import { ViewmodelRig } from '../guns/viewmodel.js';
import { HUD } from '../ui/hud.js';
import { TouchControls, setTitanfallTouchSource } from '../engine/touch-controls.js';
import { TitanHud } from '../titanfall/titan-hud.js';
import { titanHudModel, titanfallTouchModel } from '../titanfall/titan-hud-state.js';
import { decodeTitanfallSelf } from '../../../shared/titan-contract.js';
import { WEAPONS } from '../../../shared/combatmath.js';
import { WRIST_STATES, wristFixture } from './titanfall-wrist-fixtures.js';
import { weaponDisplayModel } from '../guns/weapon-display.js';

const KEYS = Object.freeze({ interact: 'T', jump: 'SPACE', callTitan: 'E', pilotTactical: 'Q' });
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
scene.add(new THREE.HemisphereLight(0xd8c8e8, 0x3a3038, 1.1));
const sun = new THREE.DirectionalLight(0xffe0c0, 1.6);
sun.position.set(-3, 6, 2);
scene.add(sun);

await loadBlenderAssets();
const rig = new ViewmodelRig(camera);
let wrist = null, wristModule = null;
let hud = null, titanHud = null, touchControls = null, touchModel = null;

function ensureHud() {
  if (hud) return;
  hud = new HUD();
  hud.buildHUD();
  hud.menuDone?.();
  titanHud = new TitanHud(document.getElementById('hud') ?? document.body);
}

function stockState(self, weapon) {
  const def = WEAPONS[weapon] ?? WEAPONS.rifle;
  return {
    alive: true, hp: self.hp, medkit: { remaining: 1, active: false, progress: 0 }, armor: 0,
    wid: def.id, wname: def.name, mag: def.magSize, reserve: 60, infiniteMagazines: false,
    grenades: [2, 0, 0, 0, 1], grenadeType: 0, grenadeReady: 0, grenadeCharge: 0, grenadeCharging: false, grenadePouchOpen: false, grenadePouchHover: -1,
    reloading01: null, reloadStaged: false, adsT01: 0, scopeActive: false, yawDeg: 0,
  };
}

/** The pilot touch context as main.js builds it on foot in titanfall (titanfall-hud-capture.js touchContext). */
const TOUCH_CONTEXT = Object.freeze({ alive: true, canFire: true, canReload: true, weaponCount: 4, canThrow: true, grenadeTotal: 3, canInteract: false,
  grenadeReady: 0, grenadeCounts: [2, 0, 0, 0, 1], conquest: false, deployOpen: false, deployValid: true, deployLabel: 'DEPLOY', vehicleSeatCount: 0,
  vehicleCountermeasure: null, vehicleCountermeasureReady: false });

/** Page backdrop: a data URL (an Ashfall still from the capture tool) or the default map still. */
function setBackdrop(url) {
  document.body.style.background = url ? `#1d2a30 url("${url}") center / cover no-repeat` : '';
  return Promise.resolve();
}

const pose = Object.freeze({ speed: 0, grounded: true, aimSwayScale: 0 });

async function render({ state = 'grapple-2', weapon = 'rifle', fov = 75, wrist: wristOn = true, touch = false, ads = 0, gun = false } = {}) {
  ensureHud();
  const fixture = wristFixture(state, { weapon });
  document.documentElement.classList.toggle('vb-touch-mode', !!touch);
  if (touch && !touchControls) {
    touchControls = new TouchControls({ documentRef: document });
    touchControls.mount(document.body);
    touchControls.setEnabled(true);
    setTitanfallTouchSource(() => titanfallTouchModel(touchModel));
  }
  hud.gameplay?.setDeviceLabels?.({ touch: !!touch });
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.fov = fov;
  camera.updateProjectionMatrix();
  camera.rotation.set(0, 0, 0);
  if (wristOn && !wrist) {
    wristModule = await import('../titanfall/pilot-wrist.js');
    wrist = new wristModule.PilotWrist({ documentRef: document });
    wrist.attach(rig);
  }
  if (!wristOn && wrist) { wrist.dispose(); wrist = null; }
  const model = titanHudModel({ snapshot: fixture.snapshot, selfRow: fixture.self, tfs: decodeTitanfallSelf(fixture.tfs), now: fixture.now,
    keys: touch ? {} : KEYS, local: { touch: !!touch } });
  rig.setWeapon(weapon);
  const stock = stockState(fixture.self, weapon);
  rig.setWeaponDisplay(gun ? weaponDisplayModel({ wid: weapon, mag: stock.mag, reserve: stock.reserve, reloading01: null, charge01: 0, ready01: 1 },
    { mode: 'titanfall', lock: 0 }) : null);
  rig.ads(ads);
  // Settle the deploy and the springs at 60 Hz; the wrist redraws on its own change check.
  for (let i = 0; i < 240; i++) {
    wrist?.update(model.pilot?.tactical ?? null, { show: model.layout === 'pilot', inRange: !!fixture.state.inRange, touch: !!touch,
      weapon, nowMs: i * 1000 / 60 });
    rig.update(1 / 60, pose);
  }
  scene.updateMatrixWorld(true);
  const renderedAt = performance.now();
  renderer.render(scene, camera);
  // The DOM chip hides while the wrist is live: the same wristLive() titan-ui's syncWrist reads, taken at this
  // render (a software GL frame outlasts its window).
  const live = !!wrist && wristModule.wristLive(renderedAt);
  if (live) document.body.dataset.titanfallWrist = ''; else delete document.body.dataset.titanfallWrist;
  const gunLive = gun && rig.weaponDisplayLive === true;
  if (gunLive) document.body.dataset.titanfallGunDisplay = ''; else delete document.body.dataset.titanfallGunDisplay;
  hud.setState(stock);
  titanHud.render(model);
  touchModel = model;
  touchControls?.setContext(touch ? TOUCH_CONTEXT : null);
  document.body.dataset.titanfall = model.layout;
  label.textContent = `${state} · ${weapon} · fov ${fov} · ${innerWidth}×${innerHeight}`;
  return { state, weapon, fov, layout: model.layout, live, gunLive, draws: renderer.info.render.calls, wrist: wrist?.debug?.() ?? null };
}

/** Screen box of the wrist screen (CSS px) for the reference crop, or null. */
function wristBox() {
  const box = wrist?.screenBox?.(camera, innerWidth, innerHeight);
  return box ?? null;
}

window.__wrist = { states: WRIST_STATES.map(s => s.id), render, setBackdrop, wristBox, ready: true };
