// Static titan capture page (docs/titanfall.md §7.4; WP5): one titan, a
// turnaround sheet or a walk filmstrip, posed through the real VehicleView and
// titan-presentation rig from synthetic rows. Muted and deterministic: no
// audio, no network, seeded Math.random, fixed 1/60 s steps.
//
// URL (also window.titanCapture.render(params) for multi-shot CDP sessions):
//   ?type=titan_ion&team=alpha|bravo
//   &view=hero|front|side|right|back|threequarter|top|low|face|range|cockpit|sheet|strip|lineup
//   &pose=idle|walk|sprint|dash|doom|embark|landing|guard|core|wreck|recoil
//   &phase=0..1 (walk cycle position; embark progress for pose=embark)  &frames=8 (strip cells)
//   &studio=1 (grey turnaround backdrop)
//   view=strip&pose=embark: the embark sequence (pilot proxy, palm lift, hatch) in `frames` cells
//   view=lineup: all five titans side by side with a pilot for scale (docs/design/titanfall/titan-lineup-b.png)
//   &aim=<rad yaw offset>  &aimPitch=<rad>  &fx=0
//   view=cockpit: &fov=<deg> (settings FOV, default 75)  &core=0..1 (core charge, 1 = CORE READY)  &hp=0..1 (hull)  &lock=0..3
//                 &settle=<s> (stepped page-clock frames before the shot: cockpit damage grows and swings)
//   view=chase: the seat's chase camera (VehicleCamera), as in a match
//   pose=fire: the titan's primary fires `shots` server-shaped shoot events at its cadence (&shots=<n>, &charge=0..1
//              railgun, &split=1 ION split shot, &after=<s> after the last shot, default 0.05) with the pilot
//              as the viewer, so the feel (cockpit kick, FOV punch, reticle bloom) and the muzzle / impact FX show
//   &ability=<shot> (titan-ability-capture.js TITAN_ABILITY_SHOTS: a staged ability with its server-shaped
//   events and a target titan; &at=<s> overrides the capture time)
import * as THREE from '../vendor/three.module.js';
import { VehicleView } from '../engine/vehicle-view.js';
import { VEHICLE_STATUS, vehicleMountOrder } from '../../../shared/conquest-contract.js';
import { vehicleDef, VEHICLE_WEAPONS } from '../../../shared/vehicle-defs.js';
import { TITAN_PHASE, TITAN_ABILITY_BITS, TITAN_LABELS, TITAN_TYPE_IDS } from '../../../shared/titan-contract.js';
import { TITAN_RULES } from '../../../shared/vehicle-handling/titan.js';
import { setTitanWorld, frame as presentationFrame, onEvent as presentationEvent } from '../titanfall/titan-presentation.js';
import { TITAN_ABILITY_SHOTS, abilityBlock, runAbilityShot } from './titan-ability-capture.js';
import { clear as clearAbilityEvents } from '../titanfall/titan-ability-events.js';
import { clear as clearAbilityFx } from '../titanfall/titan-ability-fx.js';
import { makeAvatar, setAvatarTeam } from '../avatar/avatar.js';
import { bakeEnvironment } from '../engine/environment-map.js';
import { mapAtmosphere } from '../engine/map-atmosphere.js';

const STEP = 1 / 60;
// The page clock (performance.now) runs ahead by this many ms while a cockpit settles (&settle).
let clockSkew = 0;
const realNow = performance.now.bind(performance);
performance.now = () => realNow() + clockSkew;
const GROUND_Y = 10;
const canvas = document.getElementById('capture');
const label = document.getElementById('label');
const root = document.documentElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

let seed = 0x5eed;
const reseed = () => { seed = 0x5eed; };
Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// ---- scene -----------------------------------------------------------------------------
const scene = new THREE.Scene();
const sky = new THREE.Color(0xa9c4dc), studio = new THREE.Color(0xdfe2e6);
scene.add(new THREE.HemisphereLight(0xd6e6ff, 0x5a4a36, 1.15));
const sun = new THREE.DirectionalLight(0xfff0d6, 2.3);
sun.position.set(-22, 46, -30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 140 });
scene.add(sun, sun.target);
// Cool fill from the other side so the shadowed flank still reads in turnarounds.
const fill = new THREE.DirectionalLight(0xc8d8ff, 0.7);
fill.position.set(30, 18, 25);
scene.add(fill);
// Image-based light as in a match (WorldView bakes the same prefiltered sky per map; the titanfall
// map is frontier): metal and shadowed faces read as they do in game. `env=0` turns it off.
const atmosphere = mapAtmosphere('frontier');
const environment = bakeEnvironment(renderer, atmosphere, new THREE.Vector3(...atmosphere.sunDir).normalize());
const setEnvironment = on => {
  scene.environment = on && environment ? environment.texture : null;
  scene.environmentIntensity = atmosphere.envIntensity ?? 0.45;
};
setEnvironment(true);
// Value swatches (`swatch=1`): plain MeshStandardMaterial cubes in the camo ground and the titan frame
// grey beside the titan, so a capture shows whether the vehicle shader darkens the palette.
const swatches = new THREE.Group();
for (const [i, hex] of [0x687341, 0x7a8650, 0x5a6068, 0xc9a066].entries()) {
  const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: hex, roughness: 0.65, metalness: 0.05 }));
  cube.position.set(-4.2, GROUND_Y + 0.5 + i * 1.1, -1);
  cube.castShadow = cube.receiveShadow = true;
  swatches.add(cube);
}
swatches.visible = false;
scene.add(swatches);

const FIELD = 96;
const blockGeometry = new THREE.BoxGeometry(1, 1, 1);
const field = new THREE.InstancedMesh(blockGeometry, new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 }), FIELD * FIELD);
{
  const color = new THREE.Color(), matrix = new THREE.Matrix4();
  let i = 0;
  reseed();
  for (let x = 0; x < FIELD; x++) for (let z = 0; z < FIELD; z++) {
    const wx = x - FIELD / 2, wz = z - FIELD + 20;
    matrix.makeTranslation(wx + 0.5, GROUND_Y - 0.5, wz + 0.5);
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
const studioFloor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0xc9ccd1, roughness: 1 }));
studioFloor.rotation.x = -Math.PI / 2;
studioFloor.position.y = GROUND_Y;
studioFloor.receiveShadow = true;
scene.add(studioFloor);
const getBlock = (x, y, z) => (y < GROUND_Y && y >= GROUND_Y - 4 ? 1 : 0) || abilityBlock(x, y, z);

const view = new VehicleView({ getBlock });
scene.add(view.group);
let particles = null, vehicleFx = null;
try {
  const [{ ParticleField }, { VehicleFx }] = await Promise.all([import('../fx/particle-field.js'), import('../vehicles/vehicle-fx.js')]);
  particles = new ParticleField({ scene, capacity: 4096 });
  vehicleFx = new VehicleFx({ fx: particles, vehicleView: view, getBlock });
} catch (error) { console.warn('titan capture: FX layer unavailable', error); }
// The particle field uploads only the slots written since its last flush, and the GPU reads them
// at the next render: the capture steps many frames between renders, so re-upload every slot
// before each render (else only the last step's particles reach the GPU).
const uploadParticles = () => {
  for (const pool of Object.values(particles?.pools || {})) {
    pool.dirtyMin = 0; pool.dirtyMax = pool.capacity - 1;
    pool.flush();
  }
};
// Effects group = the scene (embark pilot proxy, ability FX, blown hatch); the capture pilot is "self".
// pose=fire makes the seated pilot the viewer (own-shot feel); every other shot watches as 'capture-viewer'.
let captureSelf = 'capture-viewer';
setTitanWorld({ getBlock, fx: particles, scene, view, selfId: () => captureSelf, teamOf: () => 'alpha' });

// ---- rows ----------------------------------------------------------------------------------
function makeRow(p, type, team) {
  const def = vehicleDef(type);
  const order = vehicleMountOrder(type);
  const pose = p.pose;
  const wreck = pose === 'wreck';
  const doomed = pose === 'doom';
  const phase = { doom: TITAN_PHASE.doomed, embark: TITAN_PHASE.embark, landing: TITAN_PHASE.landed }[pose] ?? TITAN_PHASE.idle;
  const bits = (pose === 'guard' ? TITAN_ABILITY_BITS.defensive : 0) | (pose === 'core' ? TITAN_ABILITY_BITS.core : 0)
    | (pose === 'hover' ? TITAN_ABILITY_BITS.hover : 0);
  const occupied = !wreck;   // embark: the server seats the pilot for the whole lock
  return {
    id: `titan-${team}`, type, team, x: 0, y: GROUND_Y, z: 0, yaw: p.yaw, pitch: 0, roll: 0, speed: 0,
    // doomed: the server's draining doom pool (20 % of max)
    hp: wreck ? 0 : doomed ? def.hp * 0.12 : def.hp * (p.hp ?? 1),
    st: (wreck ? VEHICLE_STATUS.wreck : VEHICLE_STATUS.engine) | VEHICLE_STATUS.grounded,
    mounts: order.map(() => [p.yaw + p.aim, p.aimPitch, 20, 0, 0, 0]),
    tw: [0, TITAN_RULES.frames[def.chassis].pips * 10, Math.round((p.core ?? 0.4) * 100), doomed ? 50 : 0, bits, phase], own: occupied ? 'pilot' : null, ab: [100, 100, 100, 2],
    seatOccupants: { driver: occupied ? 'pilot' : null }, occupantId: occupied ? 'pilot' : null,
    grounded: true, wreck, ...(p.lock ? { lk: p.lock } : {}), ...(p.row ?? {}),
  };
}

const num = (params, key, fallback) => { const value = Number(params.get?.(key) ?? params[key]); return (params.has ? params.has(key) : key in params) && Number.isFinite(value) ? value : fallback; };
const str = (params, key, fallback) => (params.get ? params.get(key) : params[key]) ?? fallback;

/** Run the scenario to its capture time; returns { row, item } at the shot. */
function simulate(p, row, onFrame = null) {
  const def = vehicleDef(p.type), frame = TITAN_RULES.frames[def.chassis];
  const players = row.occupantId ? [{ id: 'pilot', name: 'PILOT', team: row.team, state: 'alive', hp: 100, vehicleId: row.id, vehicleSeatId: 'driver' }] : [];
  const advance = (seconds, speed = 0, perFrame = null) => {
    const n = Math.round(seconds / STEP);
    for (let i = 0; i < n; i++) {
      row.speed = speed;
      row.x -= Math.sin(row.yaw) * speed * STEP; row.z -= Math.cos(row.yaw) * speed * STEP;
      perFrame?.(i);
      view.sync([row], players, { id: 'capture', team: 'alpha' });
      // An explicit aim (aim-up shot) is live input: keep the weapon raised out of low-ready.
      if (p.aim || Math.abs(p.aimPitch - 0.04) > 1e-6) view.item(row.id)?.model?.rig?.raise?.();
      view.update(STEP, p.camera);
      presentationFrame(STEP, { camera: p.camera });
      vehicleFx?.update(STEP, p.camera, [row]);
      particles?.update(STEP, p.camera);
      onFrame?.();
    }
  };
  const item = () => view.item(row.id);
  const pose = p.pose;
  if (pose === 'walk' || pose === 'sprint') {
    const speed = pose === 'sprint' ? frame.sprint : frame.walk;
    advance(3, speed);
    // Align to a left footfall, measure one gait cycle, then advance to the requested phase.
    const rig = item().model.rig;
    const waitLeft = () => {
      for (let guard = 0; rig && guard < 240; guard++) {
        advance(STEP, speed);
        if (rig.events.some(event => event.type === 'footfall' && event.side < 0)) break;
      }
      return rig ? rig.time : 0;
    };
    const t1 = waitLeft(), t2 = waitLeft();
    p.cycle = rig && t2 > t1 ? t2 - t1 : 0.8;
    advance(p.phase * p.cycle, speed);
  } else if (pose === 'dash') {
    advance(2, frame.walk);
    row.tw[1] = Math.max(0, row.tw[1] - 10);
    advance(0.14, frame.dash.speed);
  } else if (pose === 'landing') {
    // 1.5 s warm-up (lamps, particles), then the drop and 0.7 s into the landed phase.
    row.tw[5] = TITAN_PHASE.idle;
    advance(1.5, 0);
    row.tw[5] = TITAN_PHASE.dropping; row.grounded = false; row.y = GROUND_Y + 40;
    advance(0.6, 0, i => { row.y = Math.max(GROUND_Y, GROUND_Y + 40 - (i + 1) * 70 * STEP); });
    row.y = GROUND_Y; row.grounded = true; row.tw[5] = TITAN_PHASE.landed;
    advance(0.7, 0);
  } else if (pose === 'fire') {
    advance(1.5, 0);
    fire(p, row, advance);
  } else if (pose === 'recoil') {
    advance(1.5, 0);
    view.kick(row.id, vehicleMountOrder(p.type)[0], 0.25);
    advance(2 / 60, 0);
  } else if (pose === 'embark') {
    // The lock starts at the first frame: `phase` is the progress through it.
    advance((p.phase || 0.5) * TITAN_RULES.embark.animMs / 1000, 0);
  } else if (pose === 'hover') {
    // VTOL hover: 4 m up on the thrusters after a 1.5 s warm-up on the ground (art review 2: high
    // enough that the shadow separates).
    row.tw[4] = 0;
    advance(1.5, 0);
    row.tw[4] = TITAN_ABILITY_BITS.hover; row.grounded = false;
    advance(1.4, 0, i => { row.y = GROUND_Y + Math.min(4, (i + 1) * STEP * 4); });
  } else {
    advance(pose === 'doom' ? 1.6 : 2.5, 0);
  }
  return { row, item: item() };
}

/** Titan primaries by chassis type (the first mount's weapon). */
const PRIMARY = Object.freeze({ titan_ion: 'splitter', titan_scorch: 't203', titan_northstar: 'railgun', titan_ronin: 'leadwall', titan_legion: 'predatorClose' });
/** Seconds between the staged shots (the server cadence). */
const cadence = weapon => { const w = VEHICLE_WEAPONS[weapon]; return Math.max(STEP, w?.cooldown ?? 0.2); };

/**
 * pose=fire: `p.shots` shoot events shaped like the server's (titan-mounts.js) from the presented
 * muzzle, through VehicleFx and titan-presentation, `p.after` seconds of frames after the last one.
 * Hitscan rounds stop on the ground ahead (aim the shot down with &aimPitch); the T-203 shell and the
 * Leadwall pellets are projectiles the capture does not fly, so only their muzzle blast shows.
 */
function fire(p, row, advance) {
  const weapon = PRIMARY[p.type], mount = vehicleMountOrder(p.type)[0], meta = VEHICLE_WEAPONS[weapon];
  const range = meta?.range ?? 300, gap = cadence(weapon);
  for (let i = 0; i < p.shots; i++) {
    const pose = view.mountWorldPose(row.id, mount);
    if (!pose) break;
    const { origin, dir } = pose;
    const ray = d => {
      const t = d[1] < -1e-3 ? Math.min(range, (GROUND_Y + 0.02 - origin[1]) / d[1]) : range;
      const end = origin.map((o, k) => Math.round((o + d[k] * t) * 100) / 100);
      const hit = t < range ? { x: Math.floor(end[0]), y: GROUND_Y - 1, z: Math.floor(end[2]), nx: 0, ny: 1, nz: 0 } : null;
      return [{ o: origin, end, ...(hit ? { hit } : {}) }];
    };
    const fan = p.split && weapon === 'splitter' ? [-1, 0, 1] : [0];
    const spread = (meta?.split?.fanDeg ?? 1.6) / 2 * Math.PI / 180;   // the fan spans fanDeg
    const paths = meta?.kind === 'hitscan' ? fan.map(k => {
      const c = Math.cos(k * spread), s = Math.sin(k * spread);
      return ray([dir[0] * c - dir[2] * s, dir[1], dir[0] * s + dir[2] * c]);
    }) : undefined;
    const event = { t: 'ev', kind: 'shoot', id: 'pilot', w: weapon, o: origin, d: dir, vehicleId: row.id, mount, vehicleWeapon: weapon,
      tracer: weapon.startsWith('predator') ? i % 3 === 0 : true, ...(paths ? { paths } : {}), ...(meta?.chargeSeconds ? { charge: p.charge } : {}) };
    vehicleFx?.handleEvent(event, 'pilot');
    presentationEvent(event);
    advance(i < p.shots - 1 ? gap : p.after, 0, () => { clockSkew += STEP * 1000; });
  }
}

// ---- cameras -------------------------------------------------------------------------------------
const FRAMINGS = {
  hero: { dir: [0.9, 0.18, -1], fov: 38, dist: 15.5 },
  threequarter: { dir: [-0.75, 0.12, -1], fov: 30, dist: 18, ortho: false },
  front: { dir: [0, 0, -1], ortho: true },
  side: { dir: [-1, 0, 0], ortho: true },
  right: { dir: [1, 0, 0], ortho: true },
  back: { dir: [0, 0, 1], ortho: true },
  top: { dir: [-0.3, 2.2, -0.6], fov: 40, dist: 16 },
  low: { dir: [0.75, -0.05, -1], fov: 44, dist: 11, target: 4.6 },
  rear: { dir: [0.8, 0.1, 1], fov: 38, dist: 15.5 },
  face: { dir: [0.35, 0.1, -1], fov: 22, dist: 12, target: 5.6 },
  range: { dir: [0.6, 0.1, -1], fov: 55, dist: 60 },
  embark: { dir: [-0.5, 0.24, -1], fov: 40, dist: 17, target: 3.2 },
  lineup: { dir: [0.08, 0.1, -1], fov: 30, dist: 27, target: 3.9 },
};

const LINEUP_SPACING = 6.6;
/** The lineup: every titan side by side facing the camera, a pilot in front for scale. */
function renderLineup(p, aspect) {
  const players = [];
  const rows = TITAN_TYPE_IDS.map((type, i) => {
    const row = makeRow({ ...p, type }, type, p.team);
    row.id = `lineup-${type}`; row.x = ((TITAN_TYPE_IDS.length - 1) / 2 - i) * LINEUP_SPACING;   // facing the camera: ION on the left
    row.seatOccupants = { driver: `pilot-${type}` }; row.occupantId = `pilot-${type}`;
    players.push({ id: `pilot-${type}`, name: 'PILOT', team: p.team, state: 'alive', hp: 100, vehicleId: row.id, vehicleSeatId: 'driver' });
    return row;
  });
  for (let i = 0; i < Math.round(2.5 / STEP); i++) {
    view.sync(rows, players, { id: 'capture', team: 'alpha' });
    view.update(STEP, p.camera);
    presentationFrame(STEP, { camera: p.camera });
    particles?.update(STEP, p.camera);
  }
  const pilot = makeAvatar('lineup-pilot', '', p.team);
  setAvatarTeam(pilot, p.team);
  pilot.tag.visible = pilot.hpSpr.visible = false;
  pilot.group.position.set(rows[2].x + LINEUP_SPACING * 0.42, GROUND_Y, -3.2);
  pilot.group.rotation.y = Math.PI;
  scene.add(pilot.group);
  placeCamera(p.camera, FRAMINGS.lineup, new THREE.Vector3(0, GROUND_Y + FRAMINGS.lineup.target, 0), aspect);
  uploadParticles();
  renderer.render(scene, p.camera);
  // Name plates under the feet (projected), like the reference sheet.
  const cells = rows.map(row => {
    const at = new THREE.Vector3(row.x, GROUND_Y - 0.4, -1.5).project(p.camera);
    return { x: (at.x + 1) / 2 * innerWidth, y: (1 - at.y) / 2 * innerHeight, label: TITAN_LABELS[row.type] };
  });
  scene.remove(pilot.group);
  return { rows, cells };
}

function drawPlates(cells) {
  const overlay = document.getElementById('ruler');
  const g = overlay?.getContext('2d');
  if (!g) return;
  g.font = '700 22px system-ui, sans-serif'; g.fillStyle = '#20242a'; g.textAlign = 'center';
  for (const cell of cells) g.fillText(cell.label, cell.x, cell.y + 24);
  g.textAlign = 'start';
}

function placeCamera(camera, framing, center, aspect) {
  const dir = new THREE.Vector3(...framing.dir).normalize();
  if (camera.isOrthographicCamera) {
    const h = 4.6;
    camera.left = -h * aspect; camera.right = h * aspect; camera.top = h; camera.bottom = -h;
    camera.near = 0.1; camera.far = 200;
    camera.position.copy(center).addScaledVector(dir, 40);
  } else {
    camera.fov = framing.fov ?? 40;
    camera.aspect = aspect;
    camera.near = 0.1; camera.far = 900;
    camera.position.copy(center).addScaledVector(dir, framing.dist ?? 15);
  }
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

function clearHulls() { view.sync([], [], { id: 'capture', team: 'alpha' }); view.update(STEP, null); presentationFrame(STEP, {}); }

function paramsFrom(input) {
  const get = key => str(input, key, null);
  const type = get('type') || 'titan_ion';
  if (!TITAN_TYPE_IDS.includes(type)) throw new Error(`unknown titan type ${type}`);
  return {
    type, team: get('team') || 'alpha', view: get('view') || 'hero', pose: get('pose') || 'idle',
    phase: Math.max(0, Math.min(1, num(input, 'phase', 0))), frames: Math.max(2, Math.min(12, num(input, 'frames', 8))),
    studio: get('studio') === '1' || ['front', 'side', 'right', 'back', 'sheet'].includes(get('view') || '') && get('studio') !== '0',
    aim: num(input, 'aim', 0), aimPitch: num(input, 'aimPitch', 0.04), yaw: num(input, 'yaw', 0), fx: get('fx') !== '0',
    swatch: get('swatch') === '1', env: get('env') !== '0',
    ability: get('ability') || null, at: num(input, 'at', NaN),
    fov: Math.max(30, Math.min(140, num(input, 'fov', 75))), core: Math.max(0, Math.min(1, num(input, 'core', 0.4))),
    hp: Math.max(0.01, Math.min(1, num(input, 'hp', 1))), lock: Math.max(0, Math.min(3, Math.round(num(input, 'lock', 0)))),
    settle: Math.max(0, Math.min(5, num(input, 'settle', 0))),
    shots: Math.max(1, Math.min(40, Math.round(num(input, 'shots', 1)))), charge: Math.max(0, Math.min(1, num(input, 'charge', 1))),
    split: get('split') === '1' || input?.split === true, after: Math.max(0, Math.min(3, num(input, 'after', 0.05))),
    confirm: ['doom', 'kill'].includes(get('confirm')) ? get('confirm') : null,
    // view=cockpit (object input only): titan row fields over the staged row (titan-cockpit-hud-capture.js states).
    row: !input?.get && input?.row && typeof input.row === 'object' ? input.row : null,
  };
}

function setBackdrop(studioLook) {
  scene.background = studioLook ? studio : sky;
  scene.fog = studioLook ? null : new THREE.FogExp2(0xb8cad6, 0.004);
  field.visible = !studioLook;
  studioFloor.visible = studioLook;
}

function drawRuler(cells, height) {
  let overlay = document.getElementById('ruler');
  if (!overlay) {
    overlay = Object.assign(document.createElement('canvas'), { id: 'ruler' });
    Object.assign(overlay.style, { position: 'fixed', inset: '0', pointerEvents: 'none' });
    document.body.appendChild(overlay);
  }
  overlay.width = innerWidth; overlay.height = innerHeight;
  const g = overlay.getContext('2d');
  g.clearRect(0, 0, overlay.width, overlay.height);
  if (!cells) return;
  g.font = '600 12px system-ui, sans-serif'; g.fillStyle = '#334'; g.strokeStyle = '#33445566';
  for (const cell of cells) {
    // Metres -> pixels for the orthographic cells (4.6 m half height around y = 3.6 m).
    const toY = m => cell.y + cell.h * (1 - (m - (3.6 - 4.6)) / 9.2);
    g.beginPath();
    for (let m = 0; m <= 8; m++) { g.moveTo(cell.x + 6, toY(m)); g.lineTo(cell.x + cell.w - 6, toY(m)); }
    g.stroke();
    g.fillText(cell.label, cell.x + cell.w / 2 - 30, cell.y + cell.h - 8);
    for (let m = 0; m <= 8; m += 2) g.fillText(`${m} m`, cell.x + 6, toY(m) - 2);
  }
  void height;
}

/** Render one shot (or sheet / strip) into the canvas; resolves with stats. */
async function render(input) {
  const p = paramsFrom(input);
  reseed();
  clearHulls();
  particles?.clear?.();
  setBackdrop(p.studio);
  swatches.visible = p.swatch;
  setEnvironment(p.env);
  renderer.setSize(innerWidth, innerHeight, false);
  const aspect = innerWidth / innerHeight;
  const persp = new THREE.PerspectiveCamera(40, aspect, 0.1, 900);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  const framing = FRAMINGS[p.view] || FRAMINGS.hero;
  p.camera = framing.ortho ? ortho : persp;
  const row = makeRow(p, p.type, p.team);
  let seatCamera = null;
  captureSelf = p.pose === 'fire' ? 'pilot' : 'capture-viewer';
  if (p.view === 'cockpit' || p.view === 'chase') {
    const { VehicleCamera } = await import('../session/vehicle-camera.js');
    seatCamera = new VehicleCamera({ camera: persp, storage: null, getBaseFov: () => p.fov });
    seatCamera.setView(p.type, 'driver', p.view, { remember: false });
    seatCamera.begin();
    view.setLocalView({ id: row.id, seatId: 'driver', sight: false });
    p.camera = persp;
  } else view.setLocalView(null);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, innerWidth, innerHeight);
  // Follows the hull up (hover); grounded poses keep the hull at GROUND_Y.
  const center = () => { const it = view.item(row.id); return new THREE.Vector3(it ? it.root.position.x : 0, Math.max(GROUND_Y, it ? it.root.position.y : GROUND_Y) + (framing.target ?? 3.6), it ? it.root.position.z : 0); };
  let ruler = null;
  if (p.view === 'sheet') {
    simulate(p, row);
    const names = [['front', 'FRONT'], ['side', 'LEFT SIDE'], ['back', 'BACK'], ['threequarter', 'THREE-QUARTER']];
    const w = Math.floor(innerWidth / 4), h = innerHeight;
    renderer.setScissorTest(true);
    ruler = [];
    names.forEach(([name, title], i) => {
      const f = FRAMINGS[name];
      const cam = f.ortho ? new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200) : new THREE.PerspectiveCamera(30, w / h, 0.1, 900);
      placeCamera(cam, f.ortho ? f : { ...f, fov: 24, dist: 24 }, center(), w / h);
      renderer.setViewport(i * w, 0, w, h); renderer.setScissor(i * w, 0, w, h);
      uploadParticles();
      renderer.render(scene, cam);
      ruler.push({ x: i * w, y: 0, w, h, label: title });
    });
    renderer.setScissorTest(false);
    drawRuler(ruler.filter((_, i) => i < 3));
  } else if (p.ability) {
    return renderAbility(p, persp, aspect);
  } else if (p.view === 'lineup') {
    p.camera = persp;
    const { rows, cells } = renderLineup(p, aspect);
    drawRuler(null);
    drawPlates(cells);
    const stats = rows.map(row => view.item(row.id)?.model.stats ?? { draws: 0, triangles: 0 });
    const text = `TITAN LINEUP · ${p.team === 'bravo' ? 'EAST' : 'WEST'} · ${stats.map((s, i) => `${TITAN_LABELS[rows[i].type]} ${s.draws}d/${s.triangles}t`).join(' · ')}`;
    label.textContent = text;
    Object.assign(root.dataset, { captureView: 'lineup', capturePose: p.pose, captureReady: 'true' });
    return { draws: Math.max(...stats.map(s => s.draws)), triangles: Math.max(...stats.map(s => s.triangles)), label: text };
  } else if (p.view === 'strip' && p.pose === 'embark') {
    // Embark filmstrip: `frames` cells across the embark lock (run in, palm lift, hatch).
    const cells = p.frames, w = Math.floor(innerWidth / cells), h = innerHeight;
    const cam = new THREE.PerspectiveCamera(34, w / h, 0.1, 900);
    p.camera = cam;
    const players = [{ id: 'pilot', name: 'PILOT', team: row.team, state: 'alive', hp: 100, vehicleId: row.id, vehicleSeatId: 'driver' }];
    const total = TITAN_RULES.embark.animMs / 1000, shots = [];
    // Clipping check (art review 2): between 10 % and 60 % the boarding pilot's box never meets a
    // thigh or shin part's box (every simulated frame, not only the rendered cells).
    const clips = [];
    const legBox = new THREE.Box3(), pilotBox = new THREE.Box3();
    const checkClip = () => {
      const model = view.item(row.id)?.model, u = model?.rig?.embark ?? 0;
      if (u < 0.1 || u > 0.6) return;
      const pilot = scene.getObjectByName('titan-embark-pilot');
      if (!pilot?.visible) return;
      pilotBox.setFromObject(pilot);
      pilotBox.expandByScalar(-0.05);
      for (const slot of ['thighL', 'thighR', 'shinL', 'shinR']) for (const entry of model.rig.meshes[slot] || []) {
        if (!entry.mesh) continue;
        legBox.setFromObject(entry.mesh);
        if (legBox.intersectsBox(pilotBox)) clips.push(`${Math.round(u * 100)}% ${slot}`);
      }
    };
    renderer.setScissorTest(true);
    for (let i = 0; i < cells; i++) {
      const until = (i + 0.5) / cells * total;
      while ((view.item(row.id)?.model.rig?.embark ?? 0) * total < until - 1e-6) {
        view.sync([row], players, { id: 'capture', team: 'alpha' });
        view.update(STEP, cam);
        presentationFrame(STEP, { camera: cam });
        vehicleFx?.update(STEP, cam, [row]);
        particles?.update(STEP, cam);
        checkClip();
        if (!view.item(row.id)?.model.rig) break;
      }
      placeCamera(cam, FRAMINGS.embark, center(), w / h);
      renderer.setViewport(i * w, 0, w, h); renderer.setScissor(i * w, 0, w, h);
      uploadParticles();
      renderer.render(scene, cam);
      shots.push({ x: i * w, y: 0, w, h, label: `${Math.round(view.item(row.id).model.rig.embark * 100)}%` });
    }
    renderer.setScissorTest(false);
    drawRuler(null);
    const overlay = document.getElementById('ruler'), g = overlay.getContext('2d');
    g.font = '600 13px system-ui, sans-serif'; g.fillStyle = '#223';
    for (const shot of shots) g.fillText(shot.label, shot.x + 8, shot.y + 20);
    p.clips = [...new Set(clips)];
  } else if (p.view === 'strip' && p.pose === 'doom') {
    // Doom filmstrip: 0, 0.5, 1 and 2 s into doomed state (fire and smoke build up), after a 1.5 s
    // healthy warm-up.
    const times = [0, 0.5, 1, 2], cells = times.length, w = Math.floor(innerWidth / cells), h = innerHeight;
    const cam = new THREE.PerspectiveCamera(38, w / h, 0.1, 900);
    p.camera = cam;
    const players = [{ id: 'pilot', name: 'PILOT', team: row.team, state: 'alive', hp: 100, vehicleId: row.id, vehicleSeatId: 'driver' }];
    const step = () => {
      view.sync([row], players, { id: 'capture', team: 'alpha' });
      view.update(STEP, cam);
      presentationFrame(STEP, { camera: cam });
      vehicleFx?.update(STEP, cam, [row]);
      particles?.update(STEP, cam);
    };
    const def = vehicleDef(p.type);
    Object.assign(row, { hp: def.hp, tw: [...row.tw.slice(0, 3), 0, row.tw[4], TITAN_PHASE.idle] });
    for (let i = 0; i < Math.round(1.5 / STEP); i++) step();
    Object.assign(row, { hp: def.hp * 0.12, tw: [...row.tw.slice(0, 3), 50, row.tw[4], TITAN_PHASE.doomed] });
    const shots = [];
    let elapsed = 0;
    renderer.setScissorTest(true);
    times.forEach((time, i) => {
      while (elapsed < time - 1e-6) { step(); elapsed += STEP; }
      if (i === 0) step();
      placeCamera(cam, FRAMINGS.hero, center(), w / h);
      renderer.setViewport(i * w, 0, w, h); renderer.setScissor(i * w, 0, w, h);
      uploadParticles();
      renderer.render(scene, cam);
      shots.push({ x: i * w, y: 0, w, h, label: `${time.toFixed(1)} s` });
    });
    renderer.setScissorTest(false);
    drawRuler(null);
    const overlay = document.getElementById('ruler'), g = overlay.getContext('2d');
    g.font = '600 13px system-ui, sans-serif'; g.fillStyle = '#223';
    for (const shot of shots) g.fillText(shot.label, shot.x + 8, shot.y + 20);
  } else if (p.view === 'strip') {
    // Walk filmstrip: `frames` cells across one gait cycle from a left footfall, in rows of 4
    // when there are more than 4 (each cell 9 m wide at the shot's aspect).
    const cells = p.frames, rows = cells > 4 ? 2 : 1, cols = Math.ceil(cells / rows);
    const w = Math.floor(innerWidth / cols), h = Math.floor(innerHeight / rows);
    const shots = [];
    p.pose = p.pose === 'sprint' ? 'sprint' : 'walk';
    p.phase = 0;
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    p.camera = cam;
    simulate(p, row);
    const speed = TITAN_RULES.frames[vehicleDef(p.type).chassis][p.pose === 'sprint' ? 'sprint' : 'walk'];
    renderer.setScissorTest(true);
    for (let i = 0; i < cells; i++) {
      if (i > 0) {
        const n = Math.max(1, Math.round(p.cycle / cells / STEP));
        for (let k = 0; k < n; k++) {
          row.x -= Math.sin(row.yaw) * speed * STEP; row.z -= Math.cos(row.yaw) * speed * STEP; row.speed = speed;
          view.sync([row], [], { id: 'capture', team: 'alpha' });
          view.update(STEP, cam);
          presentationFrame(STEP, { camera: cam });
          vehicleFx?.update(STEP, cam, [row]);
          particles?.update(STEP, cam);
        }
      }
      placeCamera(cam, FRAMINGS.side, center(), w / h);
      const cx = (i % cols) * w, cy = Math.floor(i / cols) * h;
      renderer.setViewport(cx, innerHeight - cy - h, w, h); renderer.setScissor(cx, innerHeight - cy - h, w, h);
      uploadParticles();
      renderer.render(scene, cam);
      shots.push({ x: cx, y: cy, w, h, label: `${Math.round(i / cells * 100)}%` });
    }
    renderer.setScissorTest(false);
    drawRuler(shots);
  } else {
    if (framing.ortho) placeCamera(ortho, framing, new THREE.Vector3(0, GROUND_Y + 3.6, 0), aspect);
    else placeCamera(persp, framing, new THREE.Vector3(0, GROUND_Y + (framing.target ?? 3.6), 0), aspect);
    const seatFrame = seatCamera ? () => {
      const presented = view.presentedRow(row.id);
      seatCamera.update(STEP, { row: presented, seatId: 'driver', aimYaw: row.mounts[0][0], aimPitch: row.mounts[0][1], freeLook: false, optic: false });
    } : null;
    simulate(p, row, seatFrame);
    // view=cockpit &settle=<s>: frames on the page clock (the cockpit damage grows and swings on it).
    // The clock is stepped, not waited for: software GL renders a frame in about a second.
    if (p.settle > 0) {
      const players = row.occupantId ? [{ id: 'pilot', name: 'PILOT', team: row.team, state: 'alive', hp: 100, vehicleId: row.id, vehicleSeatId: 'driver' }] : [];
      for (let i = Math.round(p.settle / STEP); i > 0; i--) {
        clockSkew += STEP * 1000;
        view.sync([row], players, { id: 'capture', team: 'alpha' });
        view.update(STEP, p.camera);
        presentationFrame(STEP, { camera: p.camera });
        seatFrame?.();
      }
    }
    if (!seatCamera) {
      if (framing.ortho) placeCamera(ortho, framing, center(), aspect);
      else placeCamera(persp, framing, center(), aspect);
    }
    drawRuler(null);
    uploadParticles();
    if (p.confirm && p.pose === 'fire') {
      presentationEvent(p.confirm === 'kill'
        ? { kind: 'vehicle_destroyed', type: 'titan_legion', vehicleId: 'enemy-confirm-fixture', attacker: 'pilot' }
        : { kind: 'titan_doomed', vehicleId: 'enemy-confirm-fixture', by: 'pilot' });
    }
    renderer.render(scene, p.camera);
  }
  const item = view.item(row.id);
  const stats = item?.model.stats ?? { draws: 0, triangles: 0 };
  const text = `${TITAN_LABELS[p.type]} · ${p.team === 'bravo' ? 'EAST' : 'WEST'} · ${p.view.toUpperCase()} · ${p.pose.toUpperCase()}${p.pose === 'walk' ? ` ${Math.round(p.phase * 100)}%` : ''} · ${stats.draws} draws · ${stats.triangles} tris`;
  label.textContent = text;
  root.dataset.captureDraws = String(stats.draws);
  root.dataset.captureTriangles = String(stats.triangles);
  root.dataset.captureType = p.type;
  root.dataset.captureView = p.view;
  root.dataset.capturePose = p.pose;
  root.dataset.captureReady = 'true';
  const pelvis = item?.model.pelvis?.getWorldPosition(new THREE.Vector3());
  return { ...stats, label: text, cycle: p.cycle ?? null, rootY: item ? item.root.position.y - GROUND_Y : null,
    pelvisY: pelvis ? pelvis.y - GROUND_Y : null, airborne: item?.model.rig?.airborne ?? null, clips: p.clips ?? null,
    particles: particles ? { alive: particles.stats.alive, emitters: particles.stats.emitters } : null };
}

/** An ability shot: the staged titans, their events, the shot's own camera. */
function renderAbility(p, camera, aspect) {
  const def = TITAN_ABILITY_SHOTS[p.ability];
  if (!def) throw new Error(`unknown ability shot ${p.ability}`);
  const shot = Number.isFinite(p.at) ? { ...def, at: p.at } : def;
  clearAbilityEvents(); clearAbilityFx();
  camera.fov = shot.fov ?? 50; camera.aspect = aspect; camera.near = 0.1; camera.far = 900;
  camera.position.set(shot.eye[0], GROUND_Y + shot.eye[1], shot.eye[2]);
  camera.lookAt(shot.look[0], GROUND_Y + shot.look[1], shot.look[2]);
  camera.updateProjectionMatrix();
  const makeAbilityRow = (type, team, id, pilot) => {
    const row = makeRow({ ...p, type, pose: 'idle', yaw: 0, aim: 0 }, type, team);
    Object.assign(row, { id, own: pilot, occupantId: pilot, seatOccupants: { driver: pilot } });
    return row;
  };
  const result = runAbilityShot(p.ability, p.team, {
    G: GROUND_Y, scene, view, makeRow: makeAbilityRow, at: shot.at,
    event: event => { presentationEvent(event); vehicleFx?.handleEvent(event, 'capture-viewer'); },
    step: (rows, players) => {
      view.sync(rows, players, { id: 'capture', team: 'alpha' });
      view.update(STEP, camera);
      presentationFrame(STEP, { camera });
      vehicleFx?.update(STEP, camera, rows);
      particles?.update(STEP, camera);
    },
  });
  drawRuler(null);
  uploadParticles();
  renderer.render(scene, camera);
  const s = result.stats;
  const text = `${TITAN_LABELS[def.type]} · ${p.ability.toUpperCase()} · ${shot.at.toFixed(2)} s · fx ${s.deployables} deployables / ${s.lines} lines / ${s.rays} rays / ${s.flares} flares / ${s.caught} caught`;
  label.textContent = text;
  Object.assign(root.dataset, { captureType: def.type, captureView: 'ability', capturePose: p.ability, captureReady: 'true' });
  return { label: text, events: s, particles: particles ? { alive: particles.stats.alive, emitters: particles.stats.emitters } : null };
}

window.titanCapture = { render, ready: true, debug: () => ({ particles, view, scene, renderer }) };
const params = new URLSearchParams(location.search);
if (params.get('manual') !== '1') await render(params);
else root.dataset.captureReady = 'true';
