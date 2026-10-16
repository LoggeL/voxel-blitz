/**
 * Titanfall pilot weapon capture page (docs/titanfall.md §8 On-gun displays):
 * the real first-person ViewmodelRig with the titanfall pilot guns over a map
 * still, under the stock HUD and the titanfall pilot HUD. No audio, no server.
 * Driven by tools/titanfall-weapon-display-capture.mjs through window.__tfw:
 * render({ weapon, state, fov, ads, touch, display }) steps the rig on its own
 * clock (never requestAnimationFrame) and paints one frame.
 */
import * as THREE from '../vendor/three.module.js';
import { HUD } from '../ui/hud.js';
import { TitanHud } from '../titanfall/titan-hud.js';
import { titanHudModel, titanfallTouchModel } from '../titanfall/titan-hud-state.js';
import { TouchControls, setTitanfallTouchSource } from '../engine/touch-controls.js';
import { decodeTitanfallSelf, encodeTitanfallSelf, TITAN_PILOT_AT, titanWeaponRole } from '../../../shared/titan-contract.js';
import { WEAPON_IDS, WEAPONS } from '../../../shared/combatmath.js';
import { ViewmodelRig } from '../guns/viewmodel.js';
import { MuzzleLights } from '../engine/muzzle-lights.js';
import { loadBlenderAssets } from '../engine/blender-assets.js';
import { pilotRow, FIXTURE_NOW } from './titanfall-hud-fixtures.js';
import { applyWeaponDisplay, weaponDisplayModel } from '../guns/weapon-display.js';

const label = document.getElementById('capture-label');
const canvas = document.getElementById('capture');
const KEYS = { interact: 'T', jump: 'SPACE', callTitan: 'E', pilotTactical: 'Q', titanDash: 'SPACE', titanDefensive: 'Q',
  titanTactical: 'E', titanOrdnance: 'G', titanCore: 'V', titanSmoke: 'C', titanEject: 'X' };
/** Capture states: the weapon read model the display gets (WeaponState.readModel fields plus the `tfs` lock). */
const STATES = Object.freeze({
  full: def => ({ mag: def.magSize, reserve: def.magSize * 3 }),
  low: def => ({ mag: Math.max(1, Math.round(def.magSize * 0.2)), reserve: def.magSize * 2 }),
  empty: def => ({ mag: 0, reserve: def.magSize * 2 }),
  reload: def => ({ mag: 0, reserve: def.magSize * 2, reloading01: 0.42 }),
  // A staged tube reload (M-DOCK) half-way: three shells seated, the count stays up.
  staged: def => ({ mag: 3, reserve: def.magSize * 2, reloading01: 0.5, reloadStaged: true }),
  charge: def => ({ mag: def.magSize, reserve: def.magSize * 3, charge01: 0.64 }),
  charged: def => ({ mag: def.magSize, reserve: def.magSize * 3, charge01: 1 }),
  cycle: def => ({ mag: Math.max(1, def.magSize - 1), reserve: def.magSize * 3, ready01: 0.35 }),
  lock: def => ({ mag: def.magSize, reserve: 4, lock: 0.55 }),
  locked: def => ({ mag: def.magSize, reserve: 4, lock: 1 }),
});

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.setClearColor(0x000000, 0);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.01, 100);
camera.position.set(0, 1.62, 0);
scene.add(camera);
// Late-afternoon key from behind the left shoulder over a warm sky fill, as on the map still.
scene.add(new THREE.HemisphereLight(0xffe2c4, 0x5a4632, 1.1));
const sun = new THREE.DirectionalLight(0xffe6c2, 2.1);
sun.position.set(-3, 6, 4);
scene.add(sun);
const rig = new ViewmodelRig(camera);
const muzzleLights = new MuzzleLights(scene);
const captureAvatars = new Map();
let hud = null, titanHud = null, touchControls = null, hudModel = null;
await loadBlenderAssets();

function ensureHud() {
  if (hud) return;
  hud = new HUD();
  hud.buildHUD();
  hud.menuDone?.();
  titanHud = new TitanHud(document.getElementById('hud') ?? document.body);
}

function readModel(weapon, state) {
  const def = WEAPONS[weapon];
  const base = (STATES[state] ?? STATES.full)(def);
  return { wid: weapon, wname: def.name, mag: base.mag, reserve: base.reserve, reloading01: base.reloading01 ?? null, reloadStaged: !!base.reloadStaged,
    charge01: def.mode === 'charge' ? base.charge01 ?? 0 : null, ready01: base.ready01 ?? 1, adsT01: 0, zoom: def.zoom,
    lock: base.lock ?? 0 };
}

let inspectionHidden = [];

const stablePose = Object.freeze({ speed: 0, grounded: true, aimSwayScale: 0, reducedMotion: true });

async function render({ weapon = 'rifle', state = 'full', fov = 75, ads = 0, touch = false, display = true, mount = null,
  reloadProgress = null, fire = false, fireElapsed = 0.035, mag = null, plasmaElapsed = 0 } = {}) {
  for (const [element, visibility] of inspectionHidden) element.style.visibility = visibility;
  inspectionHidden = [];
  ensureHud();
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // LocalPlayer.updateCamera: the view narrows toward the weapon's adsFov while aiming.
  camera.fov = fov + (WEAPONS[weapon].adsFov - fov) * ads;
  camera.updateProjectionMatrix();
  document.documentElement.classList.toggle('vb-touch-mode', !!touch);
  hud.gameplay?.setDeviceLabels?.({ touch });

  const read = readModel(weapon, state);
  const isPilotWeapon = !!titanWeaponRole(weapon);
  const mode = isPilotWeapon ? 'titanfall' : 'fun';
  const reloading = state === 'reload' || reloadProgress !== null;
  const progress = reloading ? Math.max(0, Math.min(1, Number(reloadProgress ?? 0.42))) : null;
  const firing = fire || state === 'fire';
  if (mag !== null) read.mag = Math.max(0, Math.trunc(Number(mag) || 0));
  if (firing) read.mag = Math.max(0, read.mag - 1);
  if (weapon === 'thunderbolt') {
    // Titanfall reserves count magazines. Keep every display on this one fixture.
    read.reserve = progress === 1 && read.mag > 0 ? 2 : WEAPONS[weapon].spareMags;
    if (firing) read.ready01 = Math.min(1, Math.max(0, fireElapsed) / (60 / WEAPONS[weapon].rpm));
  }
  if (reloading) read.reloading01 = progress < 1 ? progress : null;
  const at = TITAN_PILOT_AT.includes(weapon) ? weapon : 'chargerifle';
  const primary = TITAN_PILOT_AT.includes(weapon) || weapon === 'revolver' ? 'rifle' : weapon;
  const self = pilotRow({ tf: { meter: 0.46 }, loadout: { primary, at } });
  const slot = WEAPON_IDS.indexOf(weapon);
  self.weapon = slot;
  self.mag[slot] = read.mag;
  self.reserve[slot] = read.reserve;
  const snapshot = { serverNow: FIXTURE_NOW, players: [self], vehicles: [],
    match: { mode, phase: 'live', ...(isPilotWeapon ? { titanfall: { v: 1, endsAt: FIXTURE_NOW + 521000, scoreLimit: 250, sc: [142, 128], bat: [], bay: [1, 2, 6] } } : {}) } };
  const tfs = decodeTitanfallSelf({ t: 'tfs', s: FIXTURE_NOW, d: encodeTitanfallSelf({ jumpsLeft: 1, tacCharges: 2, tacReady: 1, lockProgress: read.lock }) });
  hud.setMatchState(snapshot.match, self, snapshot.players, FIXTURE_NOW);
  hud.setState({ alive: true, hp: 100, medkit: { remaining: 1, active: false, progress: 0 }, armor: 0,
    wid: weapon, wname: read.wname, mag: read.mag, reserve: read.reserve, infiniteMagazines: false,
    grenades: [2, 0, 0, 0, 1], grenadeType: 0, grenadeReady: 0, grenadeCharge: 0, grenadeCharging: false, grenadePouchOpen: false,
    grenadePouchHover: -1, reloading01: read.reloading01, reloadStaged: read.reloadStaged, adsT01: ads, scopeActive: false, yawDeg: 0,
    charge01: read.charge01 });
  const model = titanHudModel({ snapshot, selfRow: self, tfs, now: FIXTURE_NOW, keys: touch ? {} : KEYS, local: { touch } });
  titanHud.render(model);
  hudModel = model;
  if (touch && !touchControls) {
    // The phone layout's buttons sit over the right-hand viewmodel: the panel is judged with them in place.
    touchControls = new TouchControls({ documentRef: document });
    touchControls.mount(document.body);
    touchControls.setEnabled(true);
    setTitanfallTouchSource(() => hudModel?.layout !== 'hidden' ? titanfallTouchModel(hudModel) : null);
  }
  touchControls?.setContext(touch ? { alive: true, canFire: true, canReload: true, weaponCount: 4, canThrow: true, grenadeTotal: 3,
    canInteract: false, grenadeReady: 0, grenadeCounts: [2, 0, 0, 0, 1], conquest: false, deployOpen: false, deployValid: true,
    deployLabel: 'DEPLOY', vehicleSeatCount: 0, vehicleCountermeasure: null, vehicleCountermeasureReady: false } : null);
  if (isPilotWeapon) document.body.dataset.titanfall = model.layout;
  else delete document.body.dataset.titanfall;

  rig.setWeapon(weapon);
  rig.setCharge(read.charge01 ?? 0);
  // Placement study: a trial seat replaces the builder's mount (and the panel built on it) for this shot.
  const bundle = rig._models[weapon];
  if (weapon === 'lance' && bundle.body.userData.blenderAsset !== 'pike') {
    throw new Error('VOLTLANCE capture requires the loaded Blender PIKE asset');
  }
  if (mount) {
    bundle.body.userData.trialMount ??= bundle.body.userData.displayMount;
    bundle.body.userData.displayMount = { ...bundle.body.userData.trialMount, ...mount };
    applyWeaponDisplay(bundle, weapon, null);
  } else if (bundle.body.userData.trialMount) {
    bundle.body.userData.displayMount = bundle.body.userData.trialMount;
    delete bundle.body.userData.trialMount;
    applyWeaponDisplay(bundle, weapon, null);
  }
  const shown = display ? weaponDisplayModel(read, { mode, lock: read.lock }) : null;
  rig.setWeaponDisplay?.(shown);
  // Match WeaponState's authoritative ammo feed. A completed reload starts empty
  // here, then receives its loaded count after its animation reaches the end.
  rig.setArcher?.({ mag: reloading ? 0 : firing ? read.mag + 1 : read.mag });
  rig.setRocket?.({ mag: reloading ? 0 : firing ? read.mag + 1 : read.mag });
  if (weapon === 'thunderbolt') rig.setThunderbolt({
    mag: reloading ? 0 : firing ? read.mag + 1 : read.mag, magSize: 4, reloading: false,
  });
  rig.ads(ads);
  // Settle the draw and ADS BEFORE beginning the action; otherwise these four
  // seconds consume the entire reload before the intended capture point.
  for (let frame = 0; frame < 240; frame++) rig.update(1 / 60, stablePose);
  const advance = seconds => {
    const frames = Math.floor(seconds * 60);
    for (let frame = 0; frame < frames; frame++) rig.update(1 / 60, stablePose);
    rig.update(Math.max(0, seconds - frames / 60), stablePose);
  };
  let fired = null;
  if (reloading) {
    rig.reload(WEAPONS[weapon].reloadTime, 'magswap');
    if (weapon === 'thunderbolt') rig.setThunderbolt({ mag: 0, magSize: 4, reloading: true });
    advance(WEAPONS[weapon].reloadTime * progress + (progress === 1 ? 0.000001 : 0));
    rig.setArcher?.({ mag: read.mag });
    rig.setRocket?.({ mag: read.mag });
    if (weapon === 'thunderbolt') rig.setThunderbolt({ mag: read.mag, magSize: 4, reloading: progress < 1 });
    rig.update(0, stablePose);
  } else if (firing) {
    fired = rig.fire();
    rig.setArcher?.({ mag: read.mag });
    rig.setRocket?.({ mag: read.mag });
    if (weapon === 'thunderbolt') rig.setThunderbolt({ mag: read.mag, magSize: 4, reloading: false });
    advance(Math.max(0, Number(fireElapsed) || 0));
  }
  bundle.extra.userData.thunderbolt?.plasma?.update(Math.max(0, Number(plasmaElapsed) || 0), { reducedMotion: false });
  rig.root.visible = !(WEAPONS[weapon].scoped && ads >= 1);
  const live = !!rig.weaponDisplayLive;
  if (live) document.body.dataset.titanfallGunDisplay = ''; else delete document.body.dataset.titanfallGunDisplay;
  // Match the gameplay pool: hidden source anchors light the gun and gloves
  // through the stable scene lights, including CR-6 capacitor charge.
  muzzleLights.update(rig.root.visible ? rig.flashLight : null, captureAvatars, camera);
  renderer.render(scene, camera);
  label.textContent = `${weapon} · ${state} · fov ${fov}${ads ? ' · ads' : ''} · ${w}×${h}`;
  await new Promise(resolve => setTimeout(resolve, 30));
  const archer = bundle.extra.userData.archer;
  const thunderbolt = bundle.extra.userData.thunderbolt;
  const part = object => object ? { visible: object.visible, position: object.position.toArray(), rotation: object.rotation.toArray().slice(0, 3) } : null;
  return { weapon, state, live, display: shown, ammo: read.mag, hudAmmo: Number(hud.gameplay?.dom?.mag?.textContent),
    reloadProgress: progress, fired, displayMounted: !!bundle.weaponDisplay,
    thunderbolt: thunderbolt ? {
      source: bundle.body.userData.blenderAsset ?? 'procedural',
      plasmaTime: thunderbolt.plasma?.time ?? null,
      visibleRounds: thunderbolt.rounds.filter(round => round.visible).length,
      rounds: thunderbolt.rounds.map(round => part(round)), rotor: part(thunderbolt.rotor), drum: part(thunderbolt.drum),
      energyVisible: thunderbolt.energy.visible, arcsVisible: thunderbolt.arcs.visible,
      authoritativeMag: thunderbolt.animation?.mag ?? null, reloading: thunderbolt.animation?.reloading ?? null,
    } : null,
    archer: archer ? { gate: part(archer.gate), incoming: part(archer.round), chambered: part(archer.chambered),
      seat: archer.seat?.toArray?.() ?? archer.seat ?? null, authoritativeMag: archer.authoritativeMag ?? null } : null };
}

/** A studio comparison of the actual, state-synchronized bundle, without gloves. */
async function inspect({ weapon = 'thunderbolt', mag = 4, plasmaElapsed = 0, detail = 'weapon' } = {}) {
  const result = await render({ weapon, mag, state: 'full', plasmaElapsed });
  const bundle = rig._models[weapon];
  const model = bundle.root;
  const studio = new THREE.Scene();
  studio.background = new THREE.Color(0x17222f);
  studio.add(new THREE.HemisphereLight(0xd5e6ff, 0x172532, 2.2));
  const key = new THREE.DirectionalLight(0xffead5, 4.1);
  key.position.set(-1.5, 2, 2); studio.add(key);
  const fill = new THREE.DirectionalLight(0x649eff, 1.5);
  fill.position.set(1.5, 0.8, -2); studio.add(fill);
  const original = { parent: model.parent, position: model.position.clone(),
    quaternion: model.quaternion.clone(), scale: model.scale.clone() };
  const hands = ['hand_l', 'hand_r'].map(name => model.getObjectByName(name)).filter(Boolean);
  const handVisibility = hands.map(hand => hand.visible);
  const bounds = new THREE.Box3();
  try {
    studio.add(model);
    model.position.set(0, 0, 0); model.quaternion.identity(); model.scale.setScalar(1);
    for (const hand of hands) hand.visible = false;
    model.updateMatrixWorld(true);
    // Exclude hidden gloves and effects from the model's framing bounds.
    model.traverseVisible(object => {
      if (object.isMesh) bounds.expandByObject(object, true);
    });
    const centre = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const eye = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.01, 20);
    const closeDrum = weapon === 'thunderbolt' && detail === 'drum';
    if (closeDrum) centre.set(-0.103, 0.009, -0.18);
    const distance = closeDrum ? 0.43 : Math.max(size.x, size.y, size.z) * 1.35;
    const direction = closeDrum ? new THREE.Vector3(-0.4, 0.2, 1) : new THREE.Vector3(-0.90, 0.55, 1.05);
    eye.position.copy(centre).add(direction.normalize().multiplyScalar(distance));
    eye.lookAt(centre);
    for (const element of document.body.children) {
      if (element === canvas || element === label || element.tagName === 'SCRIPT') continue;
      inspectionHidden.push([element, element.style.visibility]);
      element.style.visibility = 'hidden';
    }
    renderer.render(studio, eye);
    label.textContent = `${WEAPONS[weapon].name} · actual model · ${mag} orbs · rear three-quarter`;
    return { ...result, inspection: true, bounds: { center: centre.toArray(), size: size.toArray() } };
  } finally {
    original.parent.add(model);
    model.position.copy(original.position); model.quaternion.copy(original.quaternion); model.scale.copy(original.scale);
    hands.forEach((hand, index) => { hand.visible = handVisibility[index]; });
  }
}

window.__tfw = { render, inspect, states: Object.keys(STATES), ready: true };
