import * as THREE from '../../vendor/three.module.js';
import { VoxelPart } from '../voxel-model/dsl.js';
import { VEHICLE_DEFS } from '../../../../shared/vehicle-defs.js';
import { TANK_TURRET_PIVOT } from '../voxel-model/anchors.js';
import { blueprint, createKit, buildSeatAnchors, buildMounts, lightAnchor, finishModel } from './common.js';

/** Outer belt outline in (z, y), shared by the voxel belt and the moving cleats. */
export const TANK_TRACK_PATH = Object.freeze([[-2.2, 0], [2.2, 0], [2.6, 0.45], [2.45, 0.95], [-2.45, 0.95], [-2.6, 0.5]]);
export const TANK_TRACK_X = 1.3;
const ROADWHEEL_Z = Object.freeze([-1.75, -1.05, -0.35, 0.35, 1.05, 1.75]);
const CLEATS_PER_SIDE = 28;

const CAMO = material => material === 'paint' || material === 'panel';

// Hull-frame boxes snap to the 0.2 m grid: symmetric pairs use even tenths.
function buildParts() {
  const main = VEHICLE_DEFS.tank.mounts.main, rws = VEHICLE_DEFS.tank.mounts.rws, coax = VEHICLE_DEFS.tank.mounts.coax;
  // Running gear: belts, drive sprocket and idler stay on the ground frame (no
  // suspension bob). They stay on the wreck, which rests on its belts.
  const running = new VoxelPart('tank-running');
  for (const side of [-1, 1]) {
    const x0 = side < 0 ? -1.6 : 1.0, x1 = side < 0 ? -1.0 : 1.6, tag = null;
    running.prism('x', TANK_TRACK_PATH, [x0, x1], 'track', { shell: 0.15, tag });
    // Drive sprocket at the rear and idler at the front, inside the belt loop.
    for (const z of [-2.3, 2.3]) {
      running.cyl([side * 1.3, 0.5, z], 0.32, 0.4, 'x', 'gunmetal', { tag });
      running.cyl([side * 1.3, 0.5, z], 0.12, 0.6, 'x', 'dark', { tag });
    }
  }

  // Hull: lower tub, long sloped glacis, sponsons over the belts, engine deck.
  const hull = new VoxelPart('tank-hull');
  hull.box([-1.0, 0.4, -2.2], [1.0, 1.0, 2.6], 'paint');
  hull.wedge([-1.0, 0.4, -2.6], [1.0, 1.0, -2.2], 'paint', { along: 'z', slope: 'y', from: 0.4, to: 1, anchor: 1 });
  hull.box([-1.6, 1.0, -1.8], [1.6, 1.6, 2.6], 'paint');
  hull.wedge([-1.6, 1.0, -2.8], [1.6, 1.6, -1.8], 'paint', { along: 'z', slope: 'y', from: 0.34, to: 1, anchor: 0 });
  // Rear plate overhang and the dark belly gap under it.
  hull.box([-1.6, 1.0, 2.6], [1.6, 1.4, 2.8], 'panel');
  hull.box([-1.0, 0.6, 2.6], [1.0, 1.0, 2.8], 'dark');
  // Segmented side skirts: a sloped heavy front plate, panel notches along
  // the bottom edge and a lighter groove along the top.
  for (const side of [-1, 1]) {
    // The left skirt tears off in the blast; the right one stays on the wreck.
    const tag = side < 0 ? 'skirt-left' : null;
    const x0 = side < 0 ? -1.8 : 1.6, x1 = side < 0 ? -1.6 : 1.8;
    hull.box([x0, 0.8, -2.2], [x1, 1.4, 2.4], 'paint', { tag });
    hull.wedge([x0, 0.6, -2.6], [x1, 1.4, -2.2], 'panel', { along: 'z', slope: 'y', from: 0.5, to: 1, anchor: 1, tag });
    for (const z of [-1.4, -0.2, 1.0]) hull.carve([x0, 0.8, z], [x1, 1.0, z + 0.2]);
    hull.skin([x0, 1.2, -2.6], [x1, 1.4, 2.4], 'panel', { normal: [side, 0, 0], where: CAMO });
    // Stowage bins on the sponson tops, aft of the turret ring.
    hull.box([side < 0 ? -1.6 : 1.2, 1.6, 0.6], [side < 0 ? -1.2 : 1.6, 1.8, 2.2], 'canvas', { tag: side < 0 ? 'tools-left' : 'tools-right' });
    // Exhaust grilles and tail lamps on the rear plate.
    hull.box([side < 0 ? -1.4 : 1.0, 1.0, 2.8], [side < 0 ? -1.0 : 1.4, 1.4, 3.0], 'exhaust');
    hull.box([side < 0 ? -1.6 : 1.4, 1.2, 2.8], [side < 0 ? -1.4 : 1.6, 1.4, 3.0], 'tail');
    // Headlights in boxed guards at the glacis corners, tow hooks fore and aft.
    hull.box([side < 0 ? -1.6 : 1.2, 1.2, -2.6], [side < 0 ? -1.2 : 1.6, 1.4, -2.4], 'dark');
    hull.box([side < 0 ? -1.4 : 1.2, 1.2, -2.8], [side < 0 ? -1.2 : 1.4, 1.4, -2.6], 'head');
    hull.box([side < 0 ? -1.6 : 1.4, 1.2, -2.8], [side < 0 ? -1.4 : 1.6, 1.4, -2.6], 'dark');
    hull.box([side < 0 ? -0.8 : 0.6, 0.4, -2.8], [side < 0 ? -0.6 : 0.8, 0.6, -2.6], 'dark');
    hull.box([side < 0 ? -0.8 : 0.6, 0.6, 2.8], [side < 0 ? -0.6 : 0.8, 0.8, 3.0], 'dark');
  }
  // Engine deck grilles (flush dark slats) and the rear stowage rack.
  for (let z = 1.0; z < 2.4; z += 0.4) hull.paint([-0.8, 1.4, z], [0.8, 1.6, z + 0.2], 'dark');
  hull.box([-1.0, 1.6, 0.8], [1.0, 1.8, 1.0], 'panel');
  hull.box([-0.6, 1.4, 2.8], [0.6, 1.8, 3.0], 'canvas', { tag: 'stowage-rear' });
  hull.box([-0.8, 1.4, 2.6], [0.8, 1.8, 2.8], 'gunmetal', { tag: 'stowage-rear' });
  // Driver hatch with periscopes (the driver sits sealed below).
  hull.box([-1.0, 1.6, -1.6], [-0.4, 1.8, -1.0], 'panel');
  hull.box([-1.0, 1.6, -1.8], [-0.4, 1.8, -1.6], 'dark');
  // Team markings: a vertical stripe on each skirt, roundels aft.
  for (const side of [-1, 1]) {
    hull.skin([side < 0 ? -2.0 : 1.6, 0.8, -1.0], [side < 0 ? -1.6 : 2.0, 1.4, -0.6], 'stripe', { normal: [side, 0, 0] });
    hull.roundel([side * 1.8, 1.1, 1.6], 0.34, [side, 0, 0], { depth: 0.2 });
  }
  hull.userData.priority = { 'skirt-left': 55, 'stowage-rear': 40, 'tools-left': 30, 'tools-right': 30 };

  // Turret: low, wide hull with arrow-head add-on cheeks either side of a
  // recessed mantlet, a rear bustle and stowage basket.
  const turret = new VoxelPart('tank-turret', { pivot: TANK_TURRET_PIVOT });
  turret.box([-1.4, 1.6, -1.2], [1.4, 2.4, 1.4], 'paint', { tag: 'turret' });
  turret.box([-1.2, 2.4, -1.0], [1.2, 2.6, 1.6], 'panel', { tag: 'turret' });
  for (const side of [-1, 1]) {
    // Arrow-head cheek: the inner edge reaches far forward, the outer edge sweeps back.
    const cheek = [[0.4, -2.2], [1.4, -1.2], [1.4, -0.8], [0.4, -0.8]].map(([x, z]) => [side * x, z]);
    turret.prism('y', cheek, [1.6, 2.4], 'paint', { tag: 'turret' });
    turret.prism('y', [[0.4, -1.8], [1.2, -1.0], [0.4, -1.0]].map(([x, z]) => [side * x, z]), [2.4, 2.6], 'panel', { tag: 'turret' });
  }
  // Bustle and the stowage basket on its back.
  turret.box([-1.2, 1.8, 1.4], [1.2, 2.4, 2.0], 'paint', { tag: 'turret' });
  turret.box([-1.2, 1.8, 2.0], [1.2, 2.4, 2.4], 'gunmetal', { tag: 'turret' });
  turret.carve([-1.0, 2.0, 2.0], [1.0, 2.4, 2.2]);
  turret.box([-1.0, 2.0, 2.0], [1.0, 2.2, 2.2], 'canvas', { tag: 'turret' });
  // Commander hatch: an open ring the exposed commander stands in.
  turret.carve([0.4, 2.2, 0.2], [0.8, 2.6, 0.6]);
  turret.box([0.2, 2.6, 0.6], [1.0, 2.8, 0.8], 'panel', { tag: 'turret' });
  turret.box([0.2, 2.6, 0.0], [0.4, 2.8, 0.8], 'dark', { tag: 'turret' });
  // Loader hatch and the gunner's primary sight with its dark window.
  turret.box([-1.0, 2.6, 0.2], [-0.4, 2.8, 0.8], 'panel', { tag: 'turret' });
  turret.box([-1.0, 2.6, -1.0], [-0.6, 3.0, -0.4], 'panel', { tag: 'turret' });
  turret.box([-1.0, 2.8, -1.2], [-0.6, 3.0, -1.0], 'dark', { tag: 'turret' });
  for (const side of [-1, 1]) {
    // Smoke launcher bank: three stepped tubes at each front corner with dark
    // mouths facing forward (the smoke pop emits from them).
    const x0 = side < 0 ? -1.6 : 1.4, x1 = side < 0 ? -1.4 : 1.6;
    turret.box([x0, 1.8, -0.8], [x1, 2.4, -0.2], 'panel', { tag: 'turret' });
    for (let i = 0; i < 3; i++) {
      const y = 1.8 + i * 0.2, z = -1.2 + (i % 2) * 0.2;
      turret.box([x0, y, z + 0.2], [x1, y + 0.2, -0.8], 'gunmetal', { tag: 'turret' });
      turret.box([x0, y, z], [x1, y + 0.2, z + 0.2], 'dark', { tag: 'turret' });
    }
    // Side stowage boxes along the bustle flanks.
    turret.box([x0, 1.8, 0.4], [x1, 2.2, 1.6], 'canvas', { tag: side < 0 ? 'stowage-left' : 'stowage-right' });
    // Vertical team stripe across each flank, roundel on the stowage box.
    turret.skin([side < 0 ? -1.8 : 1.0, 1.6, -0.2], [side < 0 ? -1.0 : 1.8, 2.6, 0.2], 'stripe', { normal: [side, 0, 0], where: CAMO });
    turret.roundel([side * 1.6, 2.0, 1.0], 0.3, [side, 0, 0], { depth: 0.2 });
    // Antenna whips at the rear corners.
    for (let y = 2.4; y < 3.4; y += 0.2) turret.box([side < 0 ? -1.0 : 0.8, y, 1.8], [side < 0 ? -0.8 : 1.0, y + 0.2, 2.0], 'dark', { tag: 'turret' });
  }
  turret.roundel([-0.5, 2.6, 1.2], 0.36, [0, 1, 0], { depth: 0.2 });
  turret.userData.priority = { turret: 110, 'stowage-left': 45, 'stowage-right': 45 };

  // Gun cradle: mantlet and coax port; pitches about the main pivot.
  const gunPivot = main.pivot;
  const gun = new VoxelPart('tank-gun', { pivot: gunPivot, grid: [0.1, gunPivot[1] - 0.1, 0] });
  gun.box([-0.3, gunPivot[1] - 0.3, -1.8], [0.3, gunPivot[1] + 0.3, -1.0], 'panel', { tag: 'gun' });
  gun.box([coax.pivot[0] - 0.1, coax.pivot[1] - 0.1, -2.4], [coax.pivot[0] + 0.1, coax.pivot[1] + 0.1, -1.6], 'gunmetal', { tag: 'gun' });
  gun.userData.priority = { gun: 90 };

  // Barrel: a 0.4 m tube centred on the pivot with a thermal collar, a fume
  // extractor and a slotted muzzle brake round a dark bore; recoils along its axis.
  const barrel = new VoxelPart('tank-barrel', { pivot: gunPivot, grid: [0, gunPivot[1], 0] });
  const tip = gunPivot[2] - main.muzzle;
  const y = gunPivot[1];
  const sleeve = (z0, z1, material) => {
    barrel.box([-0.4, y - 0.2, z0], [0.4, y + 0.2, z1], material, { tag: 'barrel' });
    barrel.box([-0.2, y - 0.4, z0], [0.2, y + 0.4, z1], material, { tag: 'barrel' });
  };
  barrel.box([-0.2, y - 0.2, tip + 0.4], [0.2, y + 0.2, -1.6], 'paint', { tag: 'barrel' });
  sleeve(-2.2, -1.8, 'panel');
  sleeve(-3.0, -2.4, 'paint');
  barrel.box([-0.4, y - 0.2, tip], [0.4, y + 0.2, tip + 0.6], 'panel', { tag: 'barrel' });
  barrel.carve([-0.4, y - 0.2, tip + 0.2], [-0.2, y + 0.2, tip + 0.4]);
  barrel.carve([0.2, y - 0.2, tip + 0.2], [0.4, y + 0.2, tip + 0.4]);
  barrel.paint([-0.2, y - 0.2, tip], [0.2, y + 0.2, tip + 0.2], 'exhaust');
  barrel.userData.priority = { barrel: 120 };

  // Remote weapon station: base ring (yaw) and the HMG cradle with its
  // sensor head and ammo box (pitch).
  const rwsBasePivot = [rws.pivot[0], 2.6, rws.pivot[2]];
  const rwsBase = new VoxelPart('tank-rws-base', { pivot: rwsBasePivot, grid: [rws.pivot[0] - 0.1, 0, rws.pivot[2] - 0.1] });
  rwsBase.box([rws.pivot[0] - 0.1, 2.6, rws.pivot[2] - 0.1], [rws.pivot[0] + 0.1, 2.7, rws.pivot[2] + 0.1], 'gunmetal', { tag: 'rws' });
  rwsBase.box([rws.pivot[0] - 0.3, 2.6, rws.pivot[2] - 0.5], [rws.pivot[0] - 0.1, 3.0, rws.pivot[2] - 0.1], 'paint', { tag: 'rws' });
  const rwsGun = new VoxelPart('tank-rws-gun', { pivot: rws.pivot, grid: [rws.pivot[0] - 0.1, rws.pivot[1] - 0.1, rws.pivot[2]] });
  const [rx, ry, rz] = rws.pivot;
  rwsGun.box([rx - 0.1, ry - 0.1, rz - 0.4], [rx + 0.1, ry + 0.1, rz + 0.2], 'dark', { tag: 'rws' });
  rwsGun.box([rx - 0.1, ry - 0.1, rz - rws.muzzle + 0.2], [rx + 0.1, ry + 0.1, rz - 0.4], 'gunmetal', { tag: 'rws' });
  rwsGun.box([rx - 0.1, ry - 0.1, rz - rws.muzzle], [rx + 0.1, ry + 0.1, rz - rws.muzzle + 0.2], 'dark', { tag: 'rws' });
  rwsGun.box([rx + 0.1, ry - 0.1, rz - 0.4], [rx + 0.3, ry + 0.1, rz], 'panel', { tag: 'rws' });
  rwsGun.box([rx - 0.1, ry + 0.1, rz - 0.4], [rx + 0.1, ry + 0.3, rz - 0.2], 'panel', { tag: 'rws' });
  rwsGun.box([rx - 0.1, ry + 0.1, rz - 0.6], [rx + 0.1, ry + 0.3, rz - 0.4], 'dark', { tag: 'rws' });
  rwsGun.userData.priority = { rws: 70 };

  // Roadwheel (instanced): authored at twice its size and meshed at half
  // scale, so the 0.1 m voxels give a round tyre, a painted dish and a hub.
  const wheel = new VoxelPart('tank-roadwheel', { grid: [0, 0.1, 0.1] });
  wheel.userData.scale = 0.5;
  // Flat faces keep the instanced wheel cheap (no AO rings to split quads).
  wheel.cyl([0, 0, 0], 0.66, 0.8, 'x', 'rubber');
  wheel.cyl([0, 0, 0], 0.46, 0.8, 'x', 'drab');
  wheel.cyl([0, 0, 0], 0.16, 0.8, 'x', 'dark');
  const cleat = new VoxelPart('tank-cleat', { grid: [0.1, -0.1, -0.1] });
  cleat.box([-0.3, -0.1, -0.1], [0.3, 0.1, 0.1], 'track');
  return { running, hull, turret, gun, barrel, rwsBase, rwsGun, wheel, cleat, rwsBasePivot };
}

// Perimeter sampling for the moving cleats.
const segments = TANK_TRACK_PATH.map((start, i) => {
  const end = TANK_TRACK_PATH[(i + 1) % TANK_TRACK_PATH.length];
  return { start, end, length: Math.hypot(end[0] - start[0], end[1] - start[1]) };
});
const PERIMETER = segments.reduce((sum, segment) => sum + segment.length, 0);
function pathPoint(distance) {
  let offset = ((distance % PERIMETER) + PERIMETER) % PERIMETER;
  for (const segment of segments) {
    if (offset <= segment.length) {
      const t = offset / segment.length;
      return { z: segment.start[0] + (segment.end[0] - segment.start[0]) * t, y: segment.start[1] + (segment.end[1] - segment.start[1]) * t,
        angle: Math.atan2(segment.end[1] - segment.start[1], segment.end[0] - segment.start[0]) };
    }
    offset -= segment.length;
  }
  return { z: segments[0].start[0], y: segments[0].start[1], angle: 0 };
}

/**
 * Main battle tank: tracked running gear (ground frame), suspended hull,
 * 360-degree turret with the main gun, a slaved coax and the commander's RWS.
 * Options: { team, material, glass, blur }.
 */
export function makeTankModel(options = {}) {
  const parts = blueprint('tank', buildParts);
  const { kit } = createKit('tank', options);
  const { group } = kit;
  kit.part(group, parts.running);
  const body = kit.node(group, 'tank-body', [0, 0, 0]);
  kit.part(body, parts.hull);
  const turret = kit.node(body, 'tank-turret', TANK_TURRET_PIVOT);
  kit.part(turret, parts.turret);
  const main = VEHICLE_DEFS.tank.mounts.main, rws = VEHICLE_DEFS.tank.mounts.rws, coax = VEHICLE_DEFS.tank.mounts.coax;
  const gun = kit.node(turret, 'tank-gun-pitch', main.pivot);
  kit.part(gun, parts.gun);
  const recoil = kit.node(gun, 'tank-barrel-recoil', main.pivot);
  kit.part(recoil, parts.barrel);
  const coaxPitch = kit.node(turret, 'tank-coax-pitch', coax.pivot);
  const rwsYaw = kit.node(turret, 'tank-rws-yaw', parts.rwsBasePivot);
  kit.part(rwsYaw, parts.rwsBase);
  const rwsPitch = kit.node(rwsYaw, 'tank-rws-pitch', rws.pivot);
  kit.part(rwsPitch, parts.rwsGun);
  const grips = {
    left: kit.anchor(rwsPitch, 'rws-grip-left', [rws.pivot[0] - 0.12, rws.pivot[1] - 0.05, rws.pivot[2] + 0.25]),
    right: kit.anchor(rwsPitch, 'rws-grip-right', [rws.pivot[0] + 0.12, rws.pivot[1] - 0.05, rws.pivot[2] + 0.25]),
  };

  // Roadwheels and idlers spin about X; cleats run around each belt.
  const wheelTransforms = [];
  for (const side of [-1, 1]) for (const z of ROADWHEEL_Z) wheelTransforms.push({ position: [side * TANK_TRACK_X, 0.33, z], side });
  const wheels = kit.instances(group, parts.wheel, wheelTransforms, 'tank-roadwheels');
  const cleatTransforms = [];
  for (const side of [-1, 1]) for (let i = 0; i < CLEATS_PER_SIDE; i++) cleatTransforms.push({ position: [side * TANK_TRACK_X, 0, 0], side, index: i });
  const cleats = kit.instances(group, parts.cleat, cleatTransforms, 'tank-track-cleats');

  const seatAnchors = buildSeatAnchors(kit, 'tank', { body, turret });
  const mounts = buildMounts(kit, 'tank', {
    main: { yawNode: turret, pitchNode: gun, recoilNode: recoil },
    coax: { yawNode: turret, pitchNode: coaxPitch },
    rws: { yawNode: rwsYaw, pitchNode: rwsPitch, grips },
  });

  const emitters = {
    exhaust: [-1.2, 1.2].map(x => ({ node: kit.anchor(body, 'exhaust', [x, 1.2, 3.05]), direction: [0, 0.2, 1] })),
    dust: [-1, 1].flatMap(side => [-2.0, 2.0].map(z => kit.anchor(group, 'track-contact', [side * TANK_TRACK_X, 0.05, z]))),
    tracks: [-1, 1].map(side => kit.anchor(group, 'track-decal', [side * TANK_TRACK_X, 0.02, 2.3])),
    lights: [
      lightAnchor(kit, body, 'head', [-1.3, 1.3, -2.85]), lightAnchor(kit, body, 'head', [1.3, 1.3, -2.85]),
      lightAnchor(kit, body, 'tail', [-1.5, 1.3, 3.05], [0, 0, 1]), lightAnchor(kit, body, 'tail', [1.5, 1.3, 3.05], [0, 0, 1]),
    ],
    smoke: [-1, 1].map(side => ({ node: kit.anchor(turret, 'smoke-bank', [side * 1.5, 2.2, -1.2]), direction: [side * 0.6, 0.55, -0.6] })),
    fire: [kit.anchor(body, 'engine-fire', [0, 1.7, 1.6]), kit.anchor(turret, 'turret-fire', [0.3, 2.6, 0.4])],
    cookoff: [kit.anchor(turret, 'ammo-cookoff', [0, 2.5, 1.4])],
  };

  const contacts = [-1, 1].map(side => ({ x: side * TANK_TRACK_X, z: 0, radius: 0.7, stretch: 3.6, strength: 0.75 }));
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), euler = new THREE.Euler();
  const scale = new THREE.Vector3(1, 0.4, 1), unit = new THREE.Vector3(1, 1, 1);
  const state = { left: 0, right: 0, spinLeft: 0, spinRight: 0 };
  const writeCleats = () => {
    cleatTransforms.forEach((transform, i) => {
      const point = pathPoint(transform.index / CLEATS_PER_SIDE * PERIMETER + (transform.side < 0 ? state.left : state.right));
      // Cleats sit inside the belt line so their outer face is the ground contact.
      position.set(transform.side * TANK_TRACK_X, point.y + Math.cos(point.angle) * 0.04, point.z - Math.sin(point.angle) * 0.04);
      quaternion.setFromEuler(euler.set(-point.angle, 0, 0));
      matrix.compose(position, quaternion, scale);
      cleats.setMatrixAt(i, matrix);
    });
    cleats.instanceMatrix.needsUpdate = true;
  };
  const writeWheels = () => {
    wheelTransforms.forEach((transform, i) => {
      position.fromArray(transform.position);
      quaternion.setFromEuler(euler.set(transform.side < 0 ? state.spinLeft : state.spinRight, 0, 0));
      matrix.compose(position, quaternion, unit);
      wheels.setMatrixAt(i, matrix);
    });
    wheels.instanceMatrix.needsUpdate = true;
  };
  writeCleats(); writeWheels();
  /** Signed per-frame belt travel in metres, independently per side. */
  const animateTracks = (leftDistance = 0, rightDistance = 0) => {
    const left = Number.isFinite(leftDistance) ? leftDistance : 0, right = Number.isFinite(rightDistance) ? rightDistance : 0;
    // A parked or pivot-locked belt keeps its last pose: no per-frame instance upload.
    if (left === 0 && right === 0) return;
    state.left += left; state.spinLeft -= left / 0.33;
    state.right += right; state.spinRight -= right / 0.33;
    writeCleats(); writeWheels();
  };
  const animate = (dt, { leftTrackSpeed = 0, rightTrackSpeed = 0, wreck = false } = {}) => {
    if (wreck || !(dt > 0)) return;
    animateTracks(leftTrackSpeed * dt, rightTrackSpeed * dt);
  };

  return finishModel(kit, {
    body, turret, gun, barrel: recoil, mounts, seatAnchors, emitters, contacts,
    wheels: [wheels], trackCleats: cleats, animate, animateTracks,
    muzzle: mounts['driver:main'].muzzle, muzzleLength: main.muzzle,
    gunPivotHeight: main.pivot[1], gunPivotForward: -main.pivot[2] + TANK_TURRET_PIVOT[2],
    floorTop: 1.4, perimeter: PERIMETER,
  });
}
