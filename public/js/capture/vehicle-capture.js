// Static vehicle capture page for muted CDP screenshots: one hull (or a
// WEST/EAST pair at range) on a sunlit field, posed from fixed angles in a
// chosen damage state. No audio, no network: rows are synthetic snapshot
// rows run through the real VehicleView, VehicleFx and ParticleField.
import * as THREE from '../vendor/three.module.js';
import { VehicleView } from '../engine/vehicle-view.js';
import { VEHICLE_STATUS, vehicleMountOrder } from '../../../shared/conquest-contract.js';
import { vehicleDef } from '../../../shared/vehicle-defs.js';

const params = new URLSearchParams(location.search);
const type = params.get('type') || 'tank';
const team = params.get('team') || 'alpha';
const angle = params.get('angle') || 'hero';
const state = params.get('state') || 'intact';
const crew = params.get('crew') === '1';
const fx = params.get('fx') !== '0';
const rotor = Number(params.get('rotor') ?? (state === 'wreck' ? 0 : 1));
// Seat views (?seat=driver&view=cockpit): the real VehicleCamera poses the shot.
const seatId = params.get('seat');
const seatView = params.get('view');
const seatShot = !!(seatId && seatView);
const num = (key, fallback) => { const value = Number(params.get(key)); return params.has(key) && Number.isFinite(value) ? value : fallback; };
const aimOffset = num('aim', null), aimPitch = num('aimPitch', 0), altitude = num('alt', 6), speed = num('speed', 0);
if (!vehicleDef(type)) throw new Error(`unknown vehicle type ${type}`);

// Deterministic page: no clock-driven randomness leaks into the capture.
let seed = 0x5eed;
Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

const canvas = document.getElementById('capture');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight, false);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const sky = new THREE.Color(0xa9c4dc);
const scene = new THREE.Scene();
scene.background = sky;
scene.fog = new THREE.FogExp2(0xb8cad6, angle === 'range' ? 0.0022 : 0.006);
scene.add(new THREE.HemisphereLight(0xd6e6ff, 0x5a4a36, 1.15));
const sun = new THREE.DirectionalLight(0xfff0d6, 2.3);
sun.position.set(-30, 46, 22);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 140 });
scene.add(sun, sun.target);

// Voxel field: grass blocks with a few dirt patches and a gravel road strip.
const GROUND_Y = 10;
const blockGeometry = new THREE.BoxGeometry(1, 1, 1);
const fieldSize = angle === 'range' ? 260 : seatShot ? 320 : 64;
const field = new THREE.InstancedMesh(blockGeometry, new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 }), fieldSize * fieldSize);
const color = new THREE.Color(), matrix = new THREE.Matrix4();
let index = 0;
for (let x = 0; x < fieldSize; x++) for (let z = 0; z < fieldSize; z++) {
  const wx = x - fieldSize / 2, wz = z - fieldSize / 2 - (angle === 'range' ? 100 : 0);
  matrix.makeTranslation(wx + 0.5, GROUND_Y - 0.5, wz + 0.5);
  field.setMatrixAt(index, matrix);
  const road = Math.abs(wx + 9) < 3;
  const n = Math.sin(wx * 0.37) * Math.cos(wz * 0.29) + Math.sin(wx * 0.11 + wz * 0.07);
  if (road) color.setHex(0x8a8579).offsetHSL(0, 0, (Math.random() - 0.5) * 0.04);
  else if (n > 1.1) color.setHex(0x6b5235);
  else color.setHex(n > 0.2 ? 0x5f8a3a : 0x6f9840).offsetHSL(0, 0, (Math.random() - 0.5) * 0.05);
  field.setColorAt(index++, color);
}
field.receiveShadow = true;
scene.add(field);
const getBlock = (x, y, z) => (y < GROUND_Y && y >= GROUND_Y - 4 ? 1 : 0);

const camera = new THREE.PerspectiveCamera(angle === 'range' ? 40 : 45, innerWidth / innerHeight, seatShot ? 0.05 : 0.1, 900);
const view = new VehicleView({ getBlock });
scene.add(view.group);

const def = vehicleDef(type);
const maxHp = def.hp;
const hpByState = { intact: maxHp, damaged: Math.round(maxHp * 0.42), burning: Math.round(maxHp * 0.2), wreck: 0 };
const stByState = {
  intact: VEHICLE_STATUS.engine, damaged: VEHICLE_STATUS.engine,
  burning: VEHICLE_STATUS.engine | VEHICLE_STATUS.disabled | VEHICLE_STATUS.burning, wreck: VEHICLE_STATUS.wreck,
};
const aircraft = ['rotor', 'fixedwing'].includes(def.handling);
const flying = aircraft && params.get('air') === '1';

function rowFor(id, rowTeam, x, z, yaw) {
  const occupants = Object.fromEntries(def.seats.map(seat => [seat.id, crew && state !== 'wreck' ? `${id}-${seat.id}` : null]));
  // Mount aims: tilt every articulated gun a little so the rigs read.
  const mounts = vehicleMountOrder(type).map((key, i) => {
    const mount = def.mounts[key.split(':')[1]];
    const centre = mount.yawLimit ? mount.yawLimit[0] : 0;
    if (aimOffset !== null) return [yaw + centre + (mount.fixed ? 0 : aimOffset), mount.fixed ? 0 : aimPitch, 2, 0, 0];
    return [yaw + centre + (mount.fixed ? 0 : 0.35 - i * 0.15), mount.fixed ? 0 : 0.12, 2, 0, 0];
  });
  return {
    id, type, team: rowTeam, x, y: GROUND_Y + (flying ? altitude : 0), z, yaw, pitch: aircraft ? num('pitch', 0) : 0, roll: aircraft ? num('roll', 0) : 0,
    vx: -Math.sin(yaw) * speed, vy: 0, vz: -Math.cos(yaw) * speed, speed,
    hp: hpByState[state] ?? maxHp, st: (stByState[state] ?? VEHICLE_STATUS.engine) | (flying ? 0 : VEHICLE_STATUS.grounded),
    turretYaw: yaw + (aimOffset ?? 0.35), turretPitch: aimOffset !== null ? aimPitch : 0.06, mounts, seatOccupants: occupants, occupantId: occupants.driver,
    speed: 0, rotorSpeed: rotor, grounded: !flying, enginePower: state === 'wreck' ? 0 : 0.6, wreck: state === 'wreck',
  };
}

const players = [];
let rows;
if (angle === 'range') {
  rows = [rowFor('west', 'alpha', -9, -150, 0.9), rowFor('east', 'bravo', 9, -150, 0.9)];
} else {
  rows = [rowFor('hull', team, 0, 0, 0)];
}
for (const row of rows) for (const [seatId, id] of Object.entries(row.seatOccupants)) {
  if (id) players.push({ id, name: seatId.toUpperCase(), team: row.team, state: 'alive', hp: 100, vehicleId: row.id, vehicleSeatId: seatId });
}
view.sync(rows, players, { id: 'capture', team: 'alpha' });

let seatCamera = null;
if (seatShot) {
  const { VehicleCamera } = await import('../session/vehicle-camera.js');
  seatCamera = new VehicleCamera({ camera, storage: null, getBaseFov: () => num('fov', 75) });
  seatCamera.setView(type, seatId, seatView, { remember: false });
  view.setLocalView(seatCamera.view === 'cockpit' && params.get('head') !== '1' ? { id: rows[0].id, seatId } : null);
}
const poseSeat = (step, move = false) => {
  if (!seatCamera) return;
  if (move) for (const row of rows) { row.x += row.vx * step; row.z += row.vz * step; }
  const row = view.presentedRow(rows[0].id);
  const mountAim = def.seats.find(seat => seat.id === seatId)?.mounts?.length ? rows[0].mounts[vehicleMountOrder(type).indexOf(`${seatId}:${def.seats.find(seat => seat.id === seatId).mounts[0]}`)] : null;
  const aimYaw = type === 'tank' && seatId === 'driver' ? rows[0].turretYaw : mountAim ? mountAim[0] : rows[0].yaw + (aimOffset ?? 0);
  const look = type === 'tank' && seatId === 'driver' ? rows[0].turretPitch : mountAim ? mountAim[1] : aimPitch;
  seatCamera.update(step, { row, seatId, aimYaw, aimPitch: look, freeLook: false });
  if (params.has('look')) { seatCamera.addFreeLook(-num('look', 0), 0); }
};

// Camera framings per angle, scaled by the hull size.
const radius = Math.max(def.collider.halfLength, def.collider.halfWidth) + (aircraft ? 2.5 : 1.2);
const target = new THREE.Vector3(0, GROUND_Y + def.height * 0.45 + (flying ? 6 : 0), 0);
const framings = {
  hero: [-1.05, 0.55, -1.35], front: [0, 0.35, -1.9], side: [-1.95, 0.32, 0], rear: [0.55, 0.5, 1.8],
  top: [-0.25, 2.3, 0.35], chase: [0, 0.75, 2.1], low: [-1.35, 0.08, -1.05],
};
if (seatShot) {
  poseSeat(0);
} else if (angle === 'range') {
  camera.position.set(0, GROUND_Y + 6, 0);
  camera.lookAt(0, GROUND_Y + 1.5, -150);
} else {
  const f = framings[angle] || framings.hero;
  camera.position.set(target.x + f[0] * radius * 1.35, target.y + f[1] * radius * 1.35, target.z + f[2] * radius * 1.35);
  camera.lookAt(target);
}
camera.updateProjectionMatrix();

// Optional FX layer: damage smoke, fire, wreck column and lights.
let vehicleFx = null, particles = null;
if (fx) {
  try {
    const [{ ParticleField }, { VehicleFx }] = await Promise.all([import('../fx/particle-field.js'), import('../vehicles/vehicle-fx.js')]);
    particles = new ParticleField({ scene, capacity: 4096 });
    vehicleFx = new VehicleFx({ fx: particles, vehicleView: view, getBlock });
  } catch (error) {
    console.warn('vehicle capture: FX layer unavailable', error);
  }
}

// Wheel and track contact blobs, as the match frame draws them (strength 0.8
// next to the sun shadow map), so hulls sit on the field instead of hovering.
const { ContactShadows } = await import('../engine/contact-shadows.js');
const contactShadows = new ContactShadows(getBlock, { strength: 0.8 });
scene.add(contactShadows.mesh);

// Advance a fixed number of fixed steps: settles smoothing, rotors and FX.
const STEP = 1 / 60;
for (let i = 0; i < 150; i++) {
  view.sync(rows, players, { id: 'capture', team: 'alpha' });
  view.update(STEP, camera);
  poseSeat(STEP, params.get('move') === '1');
  vehicleFx?.update(STEP, camera, rows);
  particles?.update(STEP, camera);
}
contactShadows.begin(camera.position);
view.addContactShadows(contactShadows);
contactShadows.end();

const root = document.documentElement;
// Hull mask for the range check: only opaque hull voxels (no crew, glass,
// rotor blur, particles, ground or contact shadows), drawn flat white on black.
function renderHullMask() {
  const toggled = [];
  scene.traverse(object => {
    if (!(object.isMesh || object.isPoints || object.isSprite || object.isLine)) return;
    const hull = !!object.geometry?.userData?.vehicleVoxel && !object.material?.transparent;
    toggled.push([object, object.visible]);
    object.visible = object.visible && hull;
  });
  const background = scene.background, fog = scene.fog, override = scene.overrideMaterial;
  scene.background = new THREE.Color(0x000000); scene.fog = null;
  scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
  renderer.render(scene, camera);
  const gl = renderer.getContext();
  const mask = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, mask);
  scene.overrideMaterial.dispose();
  scene.background = background; scene.fog = fog; scene.overrideMaterial = override;
  for (const [object, visible] of toggled) object.visible = visible;
  return mask;
}
const hullMask = angle === 'range' ? renderHullMask() : null;
renderer.render(scene, camera);
if (seatShot) {
  // Reticle check: the screen centre (white) and where the weapons hit
  // (green: the aircraft boresight at 160 m, or the seat's mount 100 m out).
  const { aircraftBoresight } = await import('../session/vehicle-camera.js');
  const { mountPose } = await import('../../../shared/vehicle-defs.js');
  const row = view.presentedRow(rows[0].id);
  const seat = def.seats.find(entry => entry.id === seatId);
  let point = null;
  const bore = seat?.drives ? aircraftBoresight(row) : null;
  if (bore) point = bore.origin.map((v, i) => v + bore.dir[i] * 160);
  else if (seat?.mounts?.length) {
    const pose = mountPose(row, seatId, seat.mounts[0]);
    if (pose) point = pose.origin.map((v, i) => v + pose.dir[i] * 100);
  }
  const overlay = document.createElement('canvas');
  overlay.width = innerWidth; overlay.height = innerHeight;
  Object.assign(overlay.style, { position: 'fixed', inset: '0', pointerEvents: 'none' });
  document.body.appendChild(overlay);
  const g = overlay.getContext('2d');
  g.strokeStyle = '#ffffffcc'; g.lineWidth = 1.5;
  const cx = innerWidth / 2, cy = innerHeight / 2;
  g.beginPath(); g.moveTo(cx - 8, cy); g.lineTo(cx + 8, cy); g.moveTo(cx, cy - 8); g.lineTo(cx, cy + 8); g.stroke();
  if (point) {
    const p = new THREE.Vector3(...point).project(camera);
    const px = (p.x * 0.5 + 0.5) * innerWidth, py = (0.5 - p.y * 0.5) * innerHeight;
    g.strokeStyle = '#46ff7a'; g.lineWidth = 2;
    g.beginPath(); g.arc(px, py, 11, 0, Math.PI * 2); g.stroke();
    root.dataset.reticleOffset = String(Math.round(Math.hypot(px - cx, py - cy)));
  }
}

// Team hue check at range: saturation-weighted mean hue of the hull pixels
// (hull mask) inside each hull's projected box.
function hueOfRegion(row) {
  const item = view.item(row.id);
  const box = new THREE.Box3().setFromObject(item.model.body);
  const corners = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    corners.push(new THREE.Vector3(x, y, z).project(camera));
  }
  const xs = corners.map(p => (p.x * 0.5 + 0.5) * canvas.width), ys = corners.map(p => (0.5 - p.y * 0.5) * canvas.height);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(canvas.width, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(canvas.height, Math.ceil(Math.max(...ys)));
  const gl = renderer.getContext();
  const width = Math.max(1, x1 - x0), height = Math.max(1, y1 - y0);
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(x0, canvas.height - y1, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let sx = 0, sy = 0, count = 0;
  const skyHsl = {}; sky.getHSL(skyHsl);
  for (let i = 0; i < pixels.length; i += 4) {
    const px = (i / 4) % width, py = Math.floor(i / 4 / width);
    if (hullMask[((canvas.height - y1 + py) * canvas.width + x0 + px) * 4] < 128) continue;
    const c = new THREE.Color(pixels[i] / 255, pixels[i + 1] / 255, pixels[i + 2] / 255);
    const hsl = {}; c.getHSL(hsl);
    if (hsl.s < 0.08 || Math.abs(hsl.h - skyHsl.h) < 0.03) continue;
    sx += Math.cos(hsl.h * Math.PI * 2) * hsl.s; sy += Math.sin(hsl.h * Math.PI * 2) * hsl.s; count++;
  }
  const hue = ((Math.atan2(sy, sx) / (Math.PI * 2)) + 1) % 1;
  return { hue: Math.round(hue * 360), pixels: count, box: [x0, y0, x1, y1] };
}
if (angle === 'range') {
  const west = hueOfRegion(rows[0]), east = hueOfRegion(rows[1]);
  root.dataset.hueWest = String(west.hue);
  root.dataset.hueEast = String(east.hue);
  root.dataset.huePixels = `${west.pixels},${east.pixels}`;
  // Woodland reads green (> 60 deg), desert reads tan/orange (< 55 deg).
  root.dataset.hueSeparated = String(west.hue - east.hue >= 20 && west.pixels > 4 && east.pixels > 4);
}
const stats = view.item(rows[0].id).model.stats;
root.dataset.captureDraws = String(stats.draws);
root.dataset.captureTriangles = String(stats.triangles);
document.getElementById('label').textContent = seatShot ? `${type.toUpperCase()} · ${seatId.toUpperCase()} · ${seatView.toUpperCase()}` :
  `${type.toUpperCase()} · ${angle === 'range' ? 'WEST vs EAST @150 m' : team === 'bravo' ? 'EAST (desert)' : 'WEST (woodland)'} · ${state.toUpperCase()} · ${stats.draws} draws · ${stats.triangles} tris`;
root.dataset.captureType = type;
root.dataset.captureAngle = angle;
root.dataset.captureState = state;
root.dataset.captureReady = 'true';
