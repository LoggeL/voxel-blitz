// Static attrition-minion capture (docs/titanfall.md §10; WP8): GRUNTS and SPECTRES
// of both teams next to a pilot and a titan for scale, rendered through the real
// client path (public/js/titanfall/npc-view.js fed with server-shaped
// `match.titanfall.npc` rows, the stock AvatarRoster, the titan VehicleView and
// presentation rig). Muted and deterministic: no audio, no network, seeded
// Math.random, fixed 1/60 s steps. Served by tools/titanfall-grunts-capture.mjs.
//
//   window.gruntCapture.render({ shot: 'hero' | 'lineup' | 'squad' | 'death' | 'closeup', width, height })
import * as THREE from '../vendor/three.module.js';
import { VehicleView } from '../engine/vehicle-view.js';
import { VEHICLE_STATUS, vehicleMountOrder } from '../../../shared/conquest-contract.js';
import { vehicleDef } from '../../../shared/vehicle-defs.js';
import { TITAN_PHASE } from '../../../shared/titan-contract.js';
import { TITAN_RULES } from '../../../shared/vehicle-handling/titan.js';
import { setTitanWorld, frame as presentationFrame } from '../titanfall/titan-presentation.js';
import * as npcView from '../titanfall/npc-view.js';
import { makeAvatar, setAvatarTeam, updateAvatarWeaponPose, updateAvatarStancePose } from '../avatar/avatar.js';
import { bakeEnvironment } from '../engine/environment-map.js';
import { mapAtmosphere } from '../engine/map-atmosphere.js';

const STEP = 1 / 60;
const G = 10;
const canvas = document.getElementById('capture');
const label = document.getElementById('label');
const root = document.documentElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

let seed = 0x6a17;
Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xa9c4dc);
scene.fog = new THREE.FogExp2(0xb8cad6, 0.004);
scene.add(new THREE.HemisphereLight(0xd6e6ff, 0x5a4a36, 1.15));
const sun = new THREE.DirectionalLight(0xfff0d6, 2.3);
sun.position.set(-22, 46, -30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 140 });
scene.add(sun, sun.target);
const fill = new THREE.DirectionalLight(0xc8d8ff, 0.7);
fill.position.set(30, 18, 25);
scene.add(fill);
const atmosphere = mapAtmosphere('frontier');
const environment = bakeEnvironment(renderer, atmosphere, new THREE.Vector3(...atmosphere.sunDir).normalize());
scene.environment = environment?.texture ?? null;
scene.environmentIntensity = atmosphere.envIntensity ?? 0.45;

// Ground: the frontier camo field with a road, as on the titan capture page.
const FIELD = 96;
const field = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 }), FIELD * FIELD);
{
  const color = new THREE.Color(), matrix = new THREE.Matrix4();
  let i = 0;
  for (let x = 0; x < FIELD; x++) for (let z = 0; z < FIELD; z++) {
    const wx = x - FIELD / 2, wz = z - FIELD + 30;
    matrix.makeTranslation(wx + 0.5, G - 0.5, wz + 0.5);
    field.setMatrixAt(i, matrix);
    const road = Math.abs(wx - 7) < 3;
    const n = Math.sin(wx * 0.37) * Math.cos(wz * 0.29) + Math.sin(wx * 0.11 + wz * 0.07);
    if (road) color.setHex(0x8a8579).offsetHSL(0, 0, (Math.random() - 0.5) * 0.04);
    else if (n > 1.1) color.setHex(0x6b5235);
    else color.setHex(n > 0.2 ? 0x5f8a3a : 0x6f9840).offsetHSL(0, 0, (Math.random() - 0.5) * 0.05);
    field.setColorAt(i++, color);
  }
}
field.receiveShadow = true;
scene.add(field);
const getBlock = (x, y, z) => (y < G && y >= G - 4 ? 1 : 0);

const view = new VehicleView({ getBlock });
scene.add(view.group);
setTitanWorld({ getBlock, fx: null, scene, view, selfId: () => 'capture-viewer', teamOf: () => 'alpha' });
const avatars = new THREE.Group();
scene.add(avatars);
// The npc view renders into `avatars` through its own AvatarRoster, as in a match.
npcView.init({ liveAvatarsGroup: avatars, vehicleView: { getBlock }, effects: null, hud: null, net: null });

function titanRow(type, team, x, z, yaw) {
  const def = vehicleDef(type);
  return {
    id: `titan-${team}`, type, team, x, y: G, z, yaw, pitch: 0, roll: 0, speed: 0, hp: def.hp,
    st: VEHICLE_STATUS.engine | VEHICLE_STATUS.grounded,
    mounts: vehicleMountOrder(type).map(() => [yaw, 0.04, 20, 0, 0, 0]),
    tw: [0, TITAN_RULES.frames[def.chassis].pips * 10, 40, 0, 0, TITAN_PHASE.idle], own: 'pilot', ab: [100, 100, 100, 2],
    seatOccupants: { driver: 'pilot' }, occupantId: 'pilot', grounded: true, wreck: false,
  };
}

/**
 * Minion row for the wire: [serial, kind, team, x, y, z, yaw, hp100, flags].
 * `walk` (m/s along yaw) moves it each step; `fire` raises its gun.
 */
const KIND = { grunt: 0, spectre: 1 };
function npc(serial, kind, team, x, z, yaw, { walk = 0, fire = false, crouch = false, hp = 100 } = {}) {
  return { serial, kind, team, x, z, yaw, walk, fire, crouch, hp, dead: false };
}
function wire(list) {
  return list.map(n => [n.serial, KIND[n.kind], n.team === 'bravo' ? 1 : 0, Math.round(n.x * 10) / 10, G,
    Math.round(n.z * 10) / 10, Math.round(n.yaw * 100) / 100, n.dead ? 0 : n.hp,
    (n.walk ? 1 : 0) | (n.fire ? 2 : 0) | (n.crouch ? 4 : 0) | (n.dead ? 8 : 0)]);
}

let serverNow = 1_000_000;
const pilots = [];
function addPilot(team, x, z, yaw, { fire = false, weapon = 0 } = {}) {
  const av = makeAvatar(`pilot-${pilots.length}`, '', team);
  setAvatarTeam(av, team);
  av.tag.visible = av.hpSpr.visible = false;
  av.group.position.set(x, G, z);
  av.group.rotation.y = yaw;
  scene.add(av.group);
  for (let i = 0; i < 40; i++) {
    updateAvatarWeaponPose(av, { weapon, pitch: 0, firing: fire, ads: fire, dt: STEP, blend: 1, movement: { grounded: true } });
    updateAvatarStancePose(av, { stride: 0, swing: 0, blend: 1 });
  }
  pilots.push(av);
  return av;
}
function clearPilots() { for (const av of pilots.splice(0)) scene.remove(av.group); }

/** Run the minions (and the titan rig) for `seconds`, feeding the npc view like a match does. */
function run(list, titans, seconds, camera, onStep = null) {
  const n = Math.round(seconds / STEP);
  for (let i = 0; i < n; i++) {
    for (const m of list) {
      if (m.walk && !m.dead) { m.x -= Math.sin(m.yaw) * m.walk * STEP; m.z -= Math.cos(m.yaw) * m.walk * STEP; }
      if (m.fire && !m.dead && i % 7 === 0) npcView.onEvent({ kind: 'shoot', id: `tfg${m.serial}` });
    }
    onStep?.(i, n);
    serverNow += STEP * 1000;
    npcView.tick({ serverNow, match: { titanfall: { npc: wire(list) } } });
    npcView.frame(STEP, { nowMs: serverNow + 100, camera });
    view.sync(titans, titans.map(t => ({ id: t.occupantId, name: 'PILOT', team: t.team, state: 'alive', hp: 100, vehicleId: t.id, vehicleSeatId: 'driver' })), { id: 'capture', team: 'alpha' });
    view.update(STEP, camera);
    presentationFrame(STEP, { camera });
  }
}

/** Shot framings are authored for this aspect; narrower (portrait) viewports keep their width. */
const SHOT_ASPECT = 1.6;
const MAX_FIT_FOV = 62;

/**
 * Keep a shot's horizontal coverage on a narrower viewport: widen the vertical
 * FOV up to MAX_FIT_FOV, then pull the camera back from the look point for the
 * rest, so every body of the shot stays in frame on a phone-portrait capture.
 */
function fitShot(eye, look, aspect, fov) {
  if (!(aspect < SHOT_ASPECT)) return { eye, fov };
  const tanH = Math.tan(fov * Math.PI / 360) * SHOT_ASPECT;
  const fitFov = Math.min(MAX_FIT_FOV, 2 * Math.atan(tanH / aspect) * 180 / Math.PI);
  const pull = Math.max(1, tanH / (Math.tan(fitFov * Math.PI / 360) * aspect));
  return { fov: fitFov, eye: eye.map((v, i) => look[i] + (v - look[i]) * pull) };
}

function placeCamera(camera, eye, look, aspect, fov) {
  ({ eye, fov } = fitShot(eye, look, aspect, fov));
  camera.fov = fov; camera.aspect = aspect; camera.near = 0.1; camera.far = 600;
  camera.position.set(eye[0], G + eye[1], eye[2]);
  camera.lookAt(look[0], G + look[1], look[2]);
  camera.updateProjectionMatrix();
}

/** Shots: minion layouts (x, z in metres; yaw 0 faces the camera side −Z) and a camera. */
const SHOTS = {
  // Both teams' minions skirmishing in front of an ION, an alpha pilot among the alpha squad.
  hero: {
    titans: [['titan_ion', 'alpha', -1.5, 3.5, 0.35]],
    npcs: [
      ['grunt', 'alpha', -3.2, -2.2, -0.9, { fire: true }], ['grunt', 'alpha', -4.6, -0.6, -0.8, { crouch: true, fire: true }],
      ['spectre', 'alpha', -1.4, -3.4, -1.0, { fire: true }], ['grunt', 'alpha', -5.6, -3.4, -1.1, { walk: 2.4 }],
      ['grunt', 'bravo', 6.8, -5.2, 1.9, { fire: true }], ['spectre', 'bravo', 8.4, -3.2, 1.7, { fire: true }],
      ['spectre', 'bravo', 7.6, -7.4, 2.0, { walk: 2.0 }], ['grunt', 'bravo', 9.8, -6.0, 1.8, { crouch: true, fire: true }],
    ],
    pilots: [['alpha', -0.2, -1.2, -0.7, { fire: true }]],
    camera: { eye: [5.5, 3.4, -17], look: [0.8, 2.2, -1.5], fov: 44 },
  },
  // Scale and detail: a row of minions of both teams, a pilot, and the titan behind.
  lineup: {
    titans: [['titan_ion', 'alpha', 0, 3.2, 0]],
    npcs: [
      // The camera looks down +z, so +x is screen left: the label reads left to right.
      ['grunt', 'alpha', 3.6, -2.4, 0], ['spectre', 'alpha', 2.2, -2.4, 0],
      ['grunt', 'bravo', -2.2, -2.4, 0], ['spectre', 'bravo', -3.6, -2.4, 0],
    ],
    pilots: [['alpha', 0, -2.4, 0]],
    camera: { eye: [0, 2.4, -15.5], look: [0, 2.6, 0], fov: 38 },
  },
  // Close-up of the four looks (grunt and spectre of each team).
  closeup: {
    titans: [],
    npcs: [
      ['grunt', 'alpha', 1.65, -1, -0.25], ['spectre', 'alpha', 0.55, -1, -0.15],
      ['grunt', 'bravo', -0.55, -1, 0.15], ['spectre', 'bravo', -1.65, -1, 0.25],
    ],
    pilots: [],
    camera: { eye: [0, 1.5, -5.6], look: [0, 1.15, -1], fov: 40 },
  },
  // A bravo squad advancing on the camera, two firing.
  squad: {
    titans: [['titan_legion', 'bravo', 4.5, 8, Math.PI + 0.3]],
    npcs: [
      ['grunt', 'bravo', -1.2, 0, 0.1, { walk: 2.6 }], ['grunt', 'bravo', 1.2, 0.6, 0.05, { walk: 2.6 }],
      ['spectre', 'bravo', -2.6, 2.2, 0.15, { fire: true }], ['grunt', 'bravo', 2.4, 2.6, -0.1, { fire: true, crouch: true }],
    ],
    pilots: [],
    camera: { eye: [-3.5, 2.2, -11], look: [0, 1.4, 1.2], fov: 42 },
  },
};

async function render(input = {}) {
  const shot = SHOTS[input.shot] ?? SHOTS.hero;
  const width = innerWidth, height = innerHeight;
  renderer.setSize(width, height, false);
  const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 600);
  placeCamera(camera, shot.camera.eye, shot.camera.look, width / height, shot.camera.fov);
  seed = 0x6a17;
  npcView.dispose();
  npcView.init({ liveAvatarsGroup: avatars, vehicleView: { getBlock }, effects: null, hud: null, net: null });
  clearPilots();
  view.sync([], [], { id: 'capture', team: 'alpha' }); view.update(STEP, camera);
  let serial = 1;
  const list = shot.npcs.map(([kind, team, x, z, yaw, opts]) => npc(serial++, kind, team, x, z, yaw, opts));
  const titans = shot.titans.map(([type, team, x, z, yaw]) => titanRow(type, team, x, z, yaw));
  for (const [team, x, z, yaw, opts] of shot.pilots) addPilot(team, x, z, yaw, opts);
  run(list, titans, 2.2, camera);
  if (input.shot === 'death' || input.die) {
    const victim = list.find(m => m.kind === 'grunt' && m.team === 'bravo') ?? list[0];
    victim.dead = true;
    npcView.onEvent({ kind: 'hit', attacker: 'pilot', victim: `tfg${victim.serial}`, dmg: 30, hs: false, vx: victim.x, vy: G + 1.2, vz: victim.z });
    npcView.onEvent({ kind: 'kill', killer: 'pilot', victim: `tfg${victim.serial}`, w: 'rifle', hs: false });
    // The stock death bursts the body into parts (avatar.js beginAvatarDeath): catch it mid-burst.
    run(list, titans, Number(input.after ?? 0.14), camera);
  }
  renderer.render(scene, camera);
  const state = npcView.debugState();
  const live = [...(state.roster?._avatars?.values?.() ?? [])];
  const text = `ATTRITION MINIONS · ${String(input.shot ?? 'hero').toUpperCase()} · ${live.length} bodies · ${live.map(a => a.tfNpcLook).join(' ')}`;
  label.textContent = text;
  root.dataset.captureReady = 'true';
  return { label: text, bodies: live.length, looks: live.map(a => a.tfNpcLook) };
}

window.gruntCapture = { render, ready: true, debug: () => ({ scene, view, npcView }) };
root.dataset.captureReady = 'true';
