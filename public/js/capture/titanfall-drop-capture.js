// Titanfall drop capture page (public/titanfall-drop-capture.html; docs/titanfall.md §7.4,
// docs/design/titanfall/captures/models.md "Titanfall drop"): one called titan falls onto a
// voxel field through the real VehicleView, titan-presentation and titanfall-drop-fx, with the
// game's ParticleField, ExplosionFX (flash, light, scorch) and CameraShake. Muted (no audio
// context), deterministic (seeded Math.random, fixed 1/60 s steps). The server's drop timeline:
// the titanfall_drop event at t = -3 s (landsAt - at = 3000 ms), the landed row 50 ms after the
// impact, the auto-titan row 1 s later.
//
// window.dropCapture.render({ view, type, team, cells, cols, cellW, cellH, at }):
//   view   caller | pilot15 | pilot40 | cockpit | wide | top
//   cells  comma list of seconds relative to the impact → a filmstrip sheet (cols per row)
//   at     one full-size frame at that time instead
//   bare   hide every effect (pose review)
import * as THREE from '../vendor/three.module.js';
import { VehicleView } from '../engine/vehicle-view.js';
import { VEHICLE_STATUS } from '../../../shared/conquest-contract.js';
import { vehicleDef } from '../../../shared/vehicle-defs.js';
import { TITAN_PHASE, TITAN_LABELS } from '../../../shared/titan-contract.js';
import { GRASS, DIRT, STONE } from '../../../shared/world/blocks.js';
import { isSolidBlock } from '../../../shared/worlddata.js';
import * as presentation from '../titanfall/titan-presentation.js';
import * as dropFx from '../titanfall/titanfall-drop-fx.js';
import { CameraShake } from '../engine/camera-shake.js';
import { ParticleField } from '../fx/particle-field.js';
import { ExplosionFX } from '../weapons/explosion-fx.js';
import { makeAvatar, setAvatarTeam } from '../avatar/avatar.js';
import { bakeEnvironment } from '../engine/environment-map.js';
import { mapAtmosphere } from '../engine/map-atmosphere.js';
import { VehicleCamera } from '../session/vehicle-camera.js';

const STEP = 1 / 60;
const G = 10;                 // ground top
const FALL = 3;               // s from the event to the impact (TITAN_RULES.drop markerMs + fallMs)
const LANDED_LAG = 0.05;      // the landed row trails the impact by a tick
const canvas = document.getElementById('capture');
const sheet = document.getElementById('sheet');
const label = document.getElementById('label');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

let seed = 0x7a17;
Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// ---- scene ---------------------------------------------------------------------------------
const scene = new THREE.Scene();
const skyColor = new THREE.Color(0xa7c0d8);
scene.background = skyColor;
scene.fog = new THREE.Fog(skyColor.getHex(), 110, 640);
scene.add(new THREE.HemisphereLight(0xd6e6ff, 0x5a4a36, 1.1));
const sun = new THREE.DirectionalLight(0xfff0d6, 2.2);
sun.position.set(-40, 70, -26);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 220 });
scene.add(sun, sun.target);
const atmosphere = mapAtmosphere('frontier');
const environment = bakeEnvironment(renderer, atmosphere, new THREE.Vector3(...atmosphere.sunDir).normalize());
scene.environment = environment?.texture ?? null;
scene.environmentIntensity = atmosphere.envIntensity ?? 0.45;
const flashLight = new THREE.PointLight(0xffd9a8, 0, 30);
scene.add(flashLight);

// Voxel field: grass top with dirt patches, a stone wall and crates for scale.
const HALF = 90;
const boxes = [[-9, G, -14, -3, G + 3, -13], [11, G, 6, 13, G + 2, 8], [-14, G, 9, -12, G + 1, 11], [20, G, -20, 26, G + 4, -19]];
const dirtAt = (x, z) => Math.sin(x * 0.21) * Math.cos(z * 0.17) + Math.sin(x * 0.07 + z * 0.05) > 1.05;
function getBlock(x, y, z) {
  if (y < G) {
    if (Math.abs(x) > HALF || Math.abs(z) > HALF || y < G - 6) return y < G - 6 ? STONE : 0;
    return y === G - 1 ? (dirtAt(x, z) ? DIRT : GRASS) : DIRT;
  }
  for (const b of boxes) if (x >= b[0] && x < b[3] && y >= b[1] && y < b[4] && z >= b[2] && z < b[5]) return STONE;
  return 0;
}
{
  const n = (2 * HALF) * (2 * HALF);
  const field = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 }), n);
  const color = new THREE.Color(), matrix = new THREE.Matrix4();
  let i = 0;
  for (let x = -HALF; x < HALF; x++) for (let z = -HALF; z < HALF; z++) {
    matrix.makeTranslation(x + 0.5, G - 0.5, z + 0.5);
    field.setMatrixAt(i, matrix);
    if (dirtAt(x, z)) color.setHex(0x6b5235).offsetHSL(0, 0, (Math.random() - 0.5) * 0.04);
    else color.setHex(Math.sin(x * 0.4) * Math.cos(z * 0.3) > 0.2 ? 0x5f8a3a : 0x6f9840).offsetHSL(0, 0, (Math.random() - 0.5) * 0.05);
    field.setColorAt(i++, color);
  }
  field.receiveShadow = true;
  scene.add(field);
  const stone = new THREE.MeshStandardMaterial({ color: 0x8d8a82, roughness: 0.92 });
  for (const b of boxes) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(b[3] - b[0], b[4] - b[1], b[5] - b[2]), stone);
    mesh.position.set((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
  }
}
const isSolid = (x, y, z) => isSolidBlock(getBlock(Math.floor(x), Math.floor(y), Math.floor(z)));

const baseChildren = new Set(scene.children);   // lights, ground, boxes: kept in a `bare` render
const effects = new THREE.Group();
effects.name = 'effects';
scene.add(effects);
const view = new VehicleView({ getBlock });
scene.add(view.group);
const particles = new ParticleField({ scene, capacity: 8192 });
const explosions = new ExplosionFX(scene, isSolid);
const shake = new CameraShake();
const camera = new THREE.PerspectiveCamera(75, 16 / 10, 0.1, 1200);
// A teammate pilot near the landing spot for scale.
let mate = null;
try {
  mate = makeAvatar('mate', '', 'alpha');
  setAvatarTeam(mate, 'alpha');
  for (const sprite of [mate.tag, mate.hpSpr]) if (sprite) sprite.visible = false;
  mate.group.position.set(7.5, G, 9);
  mate.group.rotation.y = Math.atan2(7.5, 9);
  scene.add(mate.group);
} catch (error) { console.warn('drop capture: no pilot avatar', error); }

const uploadParticles = () => {
  for (const pool of Object.values(particles.pools || {})) { pool.dirtyMin = 0; pool.dirtyMax = pool.capacity - 1; pool.flush(); }
};

// ---- views ---------------------------------------------------------------------------------
/** Eye and look target (metres above G) per view; the titan lands at the origin facing -Z, the caller behind it. */
const VIEWS = Object.freeze({
  caller: { eye: [1.2, 1.7, 30], look: [0, 9, 0], fov: 75, label: 'CALLER · 30 m' },
  pilot15: { eye: [14.1, 1.7, -5.1], look: [0, 9, 0], fov: 75, label: 'PILOT · 15 m' },
  pilot40: { eye: [37.6, 1.7, -13.7], look: [0, 14, 0], fov: 75, label: 'PILOT · 40 m' },
  wide: { eye: [52, 9, 46], look: [-2, 40, -4], fov: 60, label: 'WIDE · 70 m' },
  top: { eye: [26, 34, 26], look: [0, 0, 0], fov: 55, label: 'OVERHEAD' },
  skyward: { eye: [14.1, 1.7, -5.1], look: [-2, 30, -4], fov: 75, label: 'PILOT · 15 m · LOOKING UP' },
  side: { eye: [13, 3.2, -4], look: [0, 3.6, 0], fov: 48, label: 'SIDE · 14 m (pose review)' },
  front: { eye: [-7, 3.4, -12], look: [0, 3.2, 0], fov: 48, label: 'FRONT · 14 m (pose review)' },
  cockpit: { titan: { type: 'titan_legion', x: -15, z: 15 }, fov: 75, label: 'COCKPIT · LEGION 21 m' },
});

function titanRow(id, type, team, x, z, yaw, phase, occupant = null) {
  return { id, type, team, x, y: G, z, yaw, pitch: 0, roll: 0, speed: 0, hp: vehicleDef(type).hp,
    st: VEHICLE_STATUS.engine | VEHICLE_STATUS.grounded, grounded: true, mounts: [[yaw, 0.08, 20, 0, 0, 0]],
    tw: [0, 20, 0, 0, 0, phase], seatOccupants: occupant ? { driver: occupant } : {}, occupantId: occupant, own: 'caller' };
}

function reset() {
  seed = 0x7a17;
  presentation.dispose();
  view.setLocalView(null);
  view.sync([], [], null);
  view.update(STEP, camera);
  particles.clear();
  explosions.clear();
  shake.reset();
  presentation.setTitanWorld({ getBlock, fx: particles, shake, scene: effects, view, camera, selfId: () => 'viewer', teamOf: () => 'alpha' });
  dropFx.setExplosions(explosions);
}

async function render(params = {}) {
  const p = { view: 'caller', type: 'titan_ion', team: 'alpha', cols: 4, cellW: 640, cellH: 400, cells: null, at: null, ...params };
  const def = VIEWS[p.view];
  if (!def) throw new Error(`unknown view ${p.view}`);
  const times = p.cells != null ? String(p.cells).split(',').map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [Number(p.at ?? 0.15)];
  const strip = p.cells != null;
  const cellW = strip ? Number(p.cellW) : innerWidth, cellH = strip ? Number(p.cellH) : innerHeight;
  renderer.setSize(cellW, cellH, false);
  canvas.width = cellW; canvas.height = cellH;
  camera.aspect = cellW / cellH;
  reset();
  const yaw = 0;   // the caller looked down -Z: the titan faces -Z and comes in from beyond the marker
  const titan = titanRow('T1', p.type, p.team, 0, 0, yaw, TITAN_PHASE.dropping);
  const rows = [titan];
  let seatCamera = null;
  if (def.titan) {
    const t = def.titan, look = Math.atan2(t.x, t.z);   // face the origin: forward (-sin, -cos) points at it
    rows.push(titanRow('C1', t.type, p.team, t.x, t.z, look, TITAN_PHASE.idle, 'viewer'));
    seatCamera = new VehicleCamera({ camera, storage: null, shake, getBaseFov: () => def.fov });
    seatCamera.setView(t.type, 'driver', 'cockpit', { remember: false });
    seatCamera.begin();
    rows[1].mounts[0][1] = 0.16;
  }
  const pose = () => {
    if (seatCamera) {
      view.setLocalView({ id: 'C1', seatId: 'driver', sight: false });
      seatCamera.update(STEP, { row: view.presentedRow('C1'), seatId: 'driver', aimYaw: rows[1].mounts[0][0], aimPitch: rows[1].mounts[0][1] });
      return;
    }
    camera.position.set(def.eye[0], G + def.eye[1], def.eye[2]);
    camera.up.set(0, 1, 0);
    camera.lookAt(def.look[0], G + def.look[1], def.look[2]);
    camera.fov += (def.fov - camera.fov) * Math.min(1, STEP * 14);
    camera.updateProjectionMatrix();
    shake.apply(camera, STEP);
  };
  camera.fov = def.fov; camera.updateProjectionMatrix();
  pose();
  let t = -FALL;
  presentation.onEvent({ t: 'ev', kind: 'titanfall_drop', owner: 'caller', vehicleId: 'T1', x: 0, y: G, z: 0, at: 0, landsAt: FALL * 1000 });
  const sheetCtx = strip ? sheet.getContext('2d') : null;
  if (strip) {
    const rowsN = Math.ceil(times.length / p.cols);
    sheet.width = cellW * p.cols; sheet.height = cellH * rowsN;
    sheetCtx.fillStyle = '#0d1418'; sheetCtx.fillRect(0, 0, sheet.width, sheet.height);
  }
  const shots = [];
  for (let i = 0; i < times.length; i++) {
    const until = times[i];
    while (t < until - 1e-6) {
      titan.tw[5] = t < LANDED_LAG ? TITAN_PHASE.dropping : t < LANDED_LAG + 1 ? TITAN_PHASE.landed : TITAN_PHASE.auto;
      view.sync(rows, [], { id: 'viewer', team: p.team });
      view.update(STEP, camera);
      pose();
      presentation.frame(STEP, { camera });
      particles.update(STEP, camera);
      explosions.update(STEP, camera.position);
      let level = 0;
      for (const blast of explosions.blasts) level = Math.max(level, explosions.lightLevel(blast));
      const blast = explosions.blasts[explosions.blasts.length - 1];
      if (blast) flashLight.position.set(blast.x, blast.y + 1, blast.z);
      flashLight.intensity = level * 60;
      t += STEP;
    }
    uploadParticles();
    // `bare`: only the world and the hulls (pose review without dust, beams and particles).
    const hidden = [];
    if (p.bare) {
      for (const o of scene.children) if (o.visible && !baseChildren.has(o) && o !== view.group && o !== mate?.group) { o.visible = false; hidden.push(o); }
      view.group.traverse(o => { if (o.visible && o.name.startsWith('titanfall-drop')) { o.visible = false; hidden.push(o); } });
    }
    renderer.render(scene, camera);
    for (const o of hidden) o.visible = true;
    const info = dropFx.inspect('T1');
    shots.push({ t: until, lift: info?.lift ?? 0, impacted: info?.impacted ?? true, chunks: dropFx.stats().chunks, particles: particles.stats?.alive ?? null,
      fov: camera.fov, trauma: shake.trauma });
    if (strip) {
      const x = (i % p.cols) * cellW, y = Math.floor(i / p.cols) * cellH;
      sheetCtx.drawImage(canvas, x, y);
      sheetCtx.fillStyle = 'rgba(8, 12, 16, 0.62)';
      sheetCtx.fillRect(x + 8, y + 8, 168, 26);
      sheetCtx.fillStyle = '#f2f5f7';
      sheetCtx.font = '600 15px system-ui, sans-serif';
      sheetCtx.fillText(`${until >= 0 ? '+' : ''}${until.toFixed(2)} s`, x + 16, y + 27);
      sheetCtx.strokeStyle = '#0d1418'; sheetCtx.lineWidth = 2; sheetCtx.strokeRect(x + 1, y + 1, cellW - 2, cellH - 2);
    }
  }
  sheet.style.display = strip ? 'block' : 'none';
  canvas.style.display = strip ? 'none' : 'block';
  label.textContent = `${TITAN_LABELS[p.type] ?? p.type} · TITANFALL · ${def.label}${strip ? '' : ` · ${times[0] >= 0 ? '+' : ''}${times[0].toFixed(2)} s`}`;
  label.style.display = strip ? 'none' : 'block';
  return { width: strip ? sheet.width : cellW, height: strip ? sheet.height : cellH, shots, stats: dropFx.stats() };
}

window.dropCapture = { render, ready: true };
const query = Object.fromEntries(new URLSearchParams(location.search));
if (!query.manual) render(query).catch(error => { console.error(error); label.textContent = String(error?.message || error); });
