import * as THREE from '../../vendor/three.module.js';
import { VoxelPart } from '../voxel-model/dsl.js';
import { VEHICLE_DEFS } from '../../../../shared/vehicle-defs.js';
import { AA_RADAR } from '../../../../shared/vehicle-handling/aa.js';
import { TANK_TRACK_PATH, TANK_TRACK_X } from './tank.js';
import { blueprint, createKit, buildSeatAnchors, buildMounts, lightAnchor, finishModel } from './common.js';

/**
 * Mobile AA (design docs/design/conquest/aa/aa-model-reference.png): the
 * tank's running gear under a lower hull, a tall boxy turret with one 35 mm
 * gun in an armoured box on each flank, a tracking dish on the turret face, a
 * rotating search radar on a mast at the back of the roof and the commander's
 * hatch with a roof .50. Every pivot comes from VEHICLE_DEFS.aa.
 */
const ROADWHEEL_Z = Object.freeze([-1.75, -1.05, -0.35, 0.35, 1.05, 1.75]);
const CLEATS_PER_SIDE = 28;
/** Turret ring: yaw pivot at the shared turretForward (turretLocal), on the hull roof. */
export const AA_TURRET_PIVOT = Object.freeze([0, 1.5, -(VEHICLE_DEFS.aa.rules.turretForward ?? 0.19)]);
/** Search radar mast (turret frame): the antenna spins about it. */
const RADAR_PIVOT = Object.freeze([0, 3.4, 1.1]);

const CAMO = material => material === 'paint' || material === 'panel';

function buildParts() {
  const main = VEHICLE_DEFS.aa.mounts.main, rws = VEHICLE_DEFS.aa.mounts.rws;
  const running = new VoxelPart('aa-running');
  for (const side of [-1, 1]) {
    const x0 = side < 0 ? -1.6 : 1.0, x1 = side < 0 ? -1.0 : 1.6;
    running.prism('x', TANK_TRACK_PATH, [x0, x1], 'track', { shell: 0.15 });
    for (const z of [-2.3, 2.3]) {
      running.cyl([side * 1.3, 0.5, z], 0.32, 0.4, 'x', 'gunmetal');
      running.cyl([side * 1.3, 0.5, z], 0.12, 0.6, 'x', 'dark');
    }
  }

  // Hull: lower tub, a short sloped glacis and a flat deck, lower than the tank's.
  const hull = new VoxelPart('aa-hull');
  hull.box([-1.0, 0.4, -2.2], [1.0, 1.0, 2.6], 'paint');
  hull.wedge([-1.0, 0.4, -2.6], [1.0, 1.0, -2.2], 'paint', { along: 'z', slope: 'y', from: 0.4, to: 1, anchor: 1 });
  hull.box([-1.6, 1.0, -2.0], [1.6, 1.5, 2.6], 'paint');
  hull.wedge([-1.6, 1.0, -2.8], [1.6, 1.5, -2.0], 'paint', { along: 'z', slope: 'y', from: 0.4, to: 1, anchor: 0 });
  hull.box([-1.6, 1.0, 2.6], [1.6, 1.4, 2.8], 'panel');
  hull.box([-1.0, 0.6, 2.6], [1.0, 1.0, 2.8], 'dark');
  for (const side of [-1, 1]) {
    const tag = side < 0 ? 'skirt-left' : null;
    const x0 = side < 0 ? -1.8 : 1.6, x1 = side < 0 ? -1.6 : 1.8;
    hull.box([x0, 0.8, -2.2], [x1, 1.4, 2.4], 'paint', { tag });
    hull.wedge([x0, 0.6, -2.6], [x1, 1.4, -2.2], 'panel', { along: 'z', slope: 'y', from: 0.5, to: 1, anchor: 1, tag });
    for (const z of [-1.2, 0.0, 1.2]) hull.carve([x0, 0.8, z], [x1, 1.0, z + 0.2]);
    hull.skin([x0, 1.2, -2.6], [x1, 1.4, 2.4], 'panel', { normal: [side, 0, 0], where: CAMO });
    // Exhausts and tail lamps on the rear plate, headlights in guards on the glacis.
    hull.box([side < 0 ? -1.4 : 1.0, 1.0, 2.8], [side < 0 ? -1.0 : 1.4, 1.4, 3.0], 'exhaust');
    hull.box([side < 0 ? -1.6 : 1.4, 1.2, 2.8], [side < 0 ? -1.4 : 1.6, 1.4, 3.0], 'tail');
    hull.box([side < 0 ? -1.6 : 1.2, 1.2, -2.6], [side < 0 ? -1.2 : 1.6, 1.4, -2.4], 'dark');
    hull.box([side < 0 ? -1.4 : 1.2, 1.2, -2.8], [side < 0 ? -1.2 : 1.4, 1.4, -2.6], 'head');
    hull.box([side < 0 ? -1.6 : 1.4, 1.2, -2.8], [side < 0 ? -1.4 : 1.6, 1.4, -2.6], 'dark');
    hull.box([side < 0 ? -0.8 : 0.6, 0.4, -2.8], [side < 0 ? -0.6 : 0.8, 0.6, -2.6], 'dark');
    // Stowage bins on the deck aft of the turret.
    hull.box([side < 0 ? -1.6 : 1.2, 1.5, 1.4], [side < 0 ? -1.2 : 1.6, 1.7, 2.4], 'canvas', { tag: side < 0 ? 'tools-left' : 'tools-right' });
  }
  // Engine deck grilles, the driver's hatch at the front left.
  for (let z = 1.4; z < 2.6; z += 0.4) hull.paint([-0.8, 1.4, z], [0.8, 1.5, z + 0.2], 'dark');
  hull.box([-1.2, 1.5, -1.8], [-0.4, 1.7, -1.2], 'panel');
  hull.box([-1.2, 1.5, -2.0], [-0.4, 1.7, -1.8], 'dark');
  // Team markings: a stripe on each skirt, roundels aft and the rear plate.
  for (const side of [-1, 1]) {
    hull.skin([side < 0 ? -2.0 : 1.6, 0.8, -1.8], [side < 0 ? -1.6 : 2.0, 1.4, 1.6], 'recog', { normal: [side, 0, 0], where: CAMO });
  }
  hull.skin([-1.6, 1.0, 2.6], [1.6, 1.4, 2.8], 'recog', { normal: [0, 0, 1], where: CAMO });
  hull.userData.priority = { 'skirt-left': 55, 'tools-left': 30, 'tools-right': 30 };

  // Turret: a tall slab-sided box with a bevelled face, the tracking dish on
  // its face, the search radar mast at the back of the roof.
  const turret = new VoxelPart('aa-turret', { pivot: AA_TURRET_PIVOT });
  turret.box([-1.0, 1.5, -1.2], [1.0, 2.8, 1.4], 'paint', { tag: 'turret' });
  turret.wedge([-1.0, 1.5, -1.6], [1.0, 2.8, -1.2], 'paint', { along: 'z', slope: 'y', from: 0.6, to: 1, anchor: 0, tag: 'turret' });
  turret.box([-0.8, 2.8, -0.8], [0.8, 3.0, 1.2], 'panel', { tag: 'turret' });
  // Tracking radar: a dark dish facing forward between the guns.
  turret.box([-0.2, 2.2, -1.8], [0.2, 2.6, -1.6], 'gunmetal', { tag: 'radar-track' });
  turret.cyl([0, 2.4, -2.0], 0.5, 0.2, 'z', 'dark', { tag: 'radar-track' });
  turret.cyl([0, 2.4, -2.1], 0.2, 0.2, 'z', 'gunmetal', { tag: 'radar-track' });
  // Search radar mast.
  turret.box([-0.2, 3.0, 1.0], [0.2, 3.4, 1.2], 'gunmetal', { tag: 'turret' });
  // Commander hatch (open ring) on the right of the roof, the loader's on the left.
  turret.carve([0.4, 2.4, 0.4], [0.8, 3.0, 0.8]);
  turret.box([0.2, 3.0, 0.8], [1.0, 3.2, 1.0], 'panel', { tag: 'turret' });
  turret.box([-0.8, 3.0, 0.2], [-0.2, 3.2, 0.8], 'panel', { tag: 'turret' });
  for (const side of [-1, 1]) {
    // Smoke banks low on the turret cheeks, facing forward.
    const x0 = side < 0 ? -1.0 : 0.6, x1 = side < 0 ? -0.6 : 1.0;
    for (let i = 0; i < 2; i++) {
      const y = 1.6 + i * 0.2;
      turret.box([x0, y, -1.8], [x1, y + 0.2, -1.4], 'gunmetal', { tag: 'turret' });
      turret.box([x0, y, -2.0], [x1, y + 0.2, -1.8], 'dark', { tag: 'turret' });
    }
    // Recognition band round the turret, a roundel on the rear flank.
    turret.skin([side < 0 ? -1.2 : 0.4, 2.0, -1.6], [side < 0 ? -0.4 : 1.2, 2.4, 1.4], 'recog', { normal: [side, 0, 0], where: CAMO });
    turret.roundel([side * 1.0, 2.0, 1.0], 0.28, [side, 0, 0], { depth: 0.2 });
    // Antenna whips at the rear corners.
    for (let y = 2.8; y < 3.8; y += 0.2) turret.box([side < 0 ? -1.0 : 0.8, y, 1.2], [side < 0 ? -0.8 : 1.0, y + 0.2, 1.4], 'dark', { tag: 'turret' });
  }
  turret.skin([-1.0, 2.0, 1.2], [1.0, 2.4, 1.4], 'recog', { normal: [0, 0, 1], where: CAMO });
  // Air recognition: the roof panel in the team colour with a roundel.
  turret.skin([-0.8, 2.8, -0.8], [0.8, 3.0, 0.2], 'recog', { normal: [0, 1, 0], where: CAMO });
  turret.roundel([0, 3.0, -0.3], 0.34, [0, 1, 0], { depth: 0.2 });
  turret.userData.priority = { turret: 110, 'radar-track': 60 };

  // Gun boxes: one armoured cradle on each flank, pitching about the shared trunnion.
  const [, py, pz] = main.pivot, gx = main.sides[1][0];
  const gun = new VoxelPart('aa-gun', { pivot: main.pivot, grid: [0, py - 0.1, 0] });
  for (const side of [-1, 1]) {
    gun.box([side * gx - 0.3, py - 0.5, -1.3], [side * gx + 0.3, py + 0.3, 0.7], 'paint', { tag: 'gun' });
    gun.box([side * gx - 0.3, py + 0.3, -1.1], [side * gx + 0.3, py + 0.5, 0.5], 'panel', { tag: 'gun' });
    // Ammo feed chutes into the turret side.
    gun.box([side * (gx - 0.4), py - 0.3, 0.1], [side * (gx - 0.2), py + 0.1, 0.5], 'gunmetal', { tag: 'gun' });
    gun.skin([side * gx - 0.4, py - 0.5, -1.3], [side * gx + 0.4, py + 0.5, 0.7], 'panel', { normal: [0, 0, -1], where: CAMO });
  }
  gun.userData.priority = { gun: 90 };

  // Barrels: 0.2 m tubes on each gun's axis with a cooling jacket and a
  // flash hider round a dark bore; both recoil together.
  const barrel = new VoxelPart('aa-barrels', { pivot: main.pivot, grid: [0.1, py - 0.1, 0] });
  const tip = pz - main.muzzle;
  for (const side of [-1, 1]) {
    const x = side * gx;
    barrel.box([x - 0.1, py - 0.1, tip + 0.4], [x + 0.1, py + 0.1, -1.2], 'gunmetal', { tag: 'barrel' });
    barrel.box([x - 0.3, py - 0.1, -1.8], [x + 0.3, py + 0.1, -1.4], 'panel', { tag: 'barrel' });
    barrel.box([x - 0.1, py - 0.3, -1.8], [x + 0.1, py + 0.3, -1.4], 'panel', { tag: 'barrel' });
    barrel.box([x - 0.3, py - 0.1, tip], [x + 0.3, py + 0.1, tip + 0.4], 'dark', { tag: 'barrel' });
    barrel.box([x - 0.1, py - 0.3, tip], [x + 0.1, py + 0.3, tip + 0.4], 'dark', { tag: 'barrel' });
    barrel.paint([x - 0.1, py - 0.1, tip], [x + 0.1, py + 0.1, tip + 0.2], 'exhaust');
  }
  barrel.userData.priority = { barrel: 120 };

  // Search radar antenna: a flat lattice on the mast, spun by animate().
  const radar = new VoxelPart('aa-radar', { pivot: RADAR_PIVOT, grid: [0, 0, 0.1] });
  radar.box([-0.2, 3.4, 1.0], [0.2, 3.6, 1.2], 'gunmetal', { tag: 'radar' });
  radar.box([-0.8, 3.6, 1.0], [0.8, 4.2, 1.2], 'dark', { tag: 'radar' });
  for (let x = -0.6; x < 0.6; x += 0.4) for (let y = 3.8; y < 4.0; y += 0.4) radar.carve([x, y, 1.0], [x + 0.2, y + 0.2, 1.2]);
  radar.box([-1.0, 3.6, 1.0], [-0.8, 4.2, 1.2], 'gunmetal', { tag: 'radar' });
  radar.box([0.8, 3.6, 1.0], [1.0, 4.2, 1.2], 'gunmetal', { tag: 'radar' });
  radar.userData.priority = { radar: 80 };

  // Roof .50: base ring (yaw) and the HMG cradle (pitch).
  const rwsBasePivot = [rws.pivot[0], 3.0, rws.pivot[2]];
  const rwsBase = new VoxelPart('aa-rws-base', { pivot: rwsBasePivot, grid: [rws.pivot[0] - 0.1, 0, rws.pivot[2] - 0.1] });
  rwsBase.box([rws.pivot[0] - 0.1, 2.8, rws.pivot[2] - 0.1], [rws.pivot[0] + 0.1, 2.9, rws.pivot[2] + 0.1], 'gunmetal', { tag: 'rws' });
  rwsBase.box([rws.pivot[0] - 0.1, 2.8, rws.pivot[2] - 0.5], [rws.pivot[0] + 0.1, 3.0, rws.pivot[2] - 0.1], 'gunmetal', { tag: 'rws' });
  const rwsGun = new VoxelPart('aa-rws-gun', { pivot: rws.pivot, grid: [rws.pivot[0] - 0.1, rws.pivot[1] - 0.1, rws.pivot[2]] });
  const [rx, ry, rz] = rws.pivot;
  rwsGun.box([rx - 0.1, ry - 0.1, rz - 0.4], [rx + 0.1, ry + 0.1, rz + 0.2], 'dark', { tag: 'rws' });
  rwsGun.box([rx - 0.1, ry - 0.1, rz - rws.muzzle + 0.2], [rx + 0.1, ry + 0.1, rz - 0.4], 'gunmetal', { tag: 'rws' });
  rwsGun.box([rx - 0.1, ry - 0.1, rz - rws.muzzle], [rx + 0.1, ry + 0.1, rz - rws.muzzle + 0.2], 'dark', { tag: 'rws' });
  rwsGun.box([rx + 0.1, ry - 0.1, rz - 0.4], [rx + 0.3, ry + 0.1, rz], 'panel', { tag: 'rws' });
  rwsGun.userData.priority = { rws: 70 };

  const wheel = new VoxelPart('aa-roadwheel', { grid: [0, 0.1, 0.1] });
  wheel.userData.scale = 0.5;
  wheel.cyl([0, 0, 0], 0.66, 0.8, 'x', 'rubber');
  wheel.cyl([0, 0, 0], 0.46, 0.8, 'x', 'drab');
  wheel.cyl([0, 0, 0], 0.16, 0.8, 'x', 'dark');
  const cleat = new VoxelPart('aa-cleat', { grid: [0.1, -0.1, -0.1] });
  cleat.box([-0.3, -0.1, -0.1], [0.3, 0.1, 0.1], 'track');
  return { running, hull, turret, gun, barrel, radar, rwsBase, rwsGun, wheel, cleat, rwsBasePivot };
}

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
 * Mobile AA model: tracked running gear (ground frame), suspended hull, a
 * 360-degree turret with the twin 35 mm (`driver:main`, two muzzles), the
 * roof .50 (`commander:rws`) and the spinning search radar. Options: { team,
 * material, glass, blur }.
 */
export function makeAaModel(options = {}) {
  const parts = blueprint('aa', buildParts);
  const { kit } = createKit('aa', options);
  const { group } = kit;
  kit.part(group, parts.running);
  const body = kit.node(group, 'aa-body', [0, 0, 0]);
  kit.part(body, parts.hull);
  const turret = kit.node(body, 'aa-turret', AA_TURRET_PIVOT);
  kit.part(turret, parts.turret);
  const main = VEHICLE_DEFS.aa.mounts.main, rws = VEHICLE_DEFS.aa.mounts.rws;
  const gun = kit.node(turret, 'aa-gun-pitch', main.pivot);
  kit.part(gun, parts.gun);
  const recoil = kit.node(gun, 'aa-barrel-recoil', main.pivot);
  kit.part(recoil, parts.barrel);
  const radar = kit.node(turret, 'aa-radar-spin', RADAR_PIVOT);
  kit.part(radar, parts.radar);
  const rwsYaw = kit.node(turret, 'aa-rws-yaw', parts.rwsBasePivot);
  kit.part(rwsYaw, parts.rwsBase);
  const rwsPitch = kit.node(rwsYaw, 'aa-rws-pitch', rws.pivot);
  kit.part(rwsPitch, parts.rwsGun);
  const grips = {
    left: kit.anchor(rwsPitch, 'rws-grip-left', [rws.pivot[0] - 0.12, rws.pivot[1] - 0.05, rws.pivot[2] + 0.25]),
    right: kit.anchor(rwsPitch, 'rws-grip-right', [rws.pivot[0] + 0.12, rws.pivot[1] - 0.05, rws.pivot[2] + 0.25]),
  };

  const wheelTransforms = [];
  for (const side of [-1, 1]) for (const z of ROADWHEEL_Z) wheelTransforms.push({ position: [side * TANK_TRACK_X, 0.33, z], side });
  const wheels = kit.instances(group, parts.wheel, wheelTransforms, 'aa-roadwheels');
  const cleatTransforms = [];
  for (const side of [-1, 1]) for (let i = 0; i < CLEATS_PER_SIDE; i++) cleatTransforms.push({ position: [side * TANK_TRACK_X, 0, 0], side, index: i });
  const cleats = kit.instances(group, parts.cleat, cleatTransforms, 'aa-track-cleats');

  const seatAnchors = buildSeatAnchors(kit, 'aa', { body, turret });
  const mounts = buildMounts(kit, 'aa', {
    main: { yawNode: turret, pitchNode: gun, recoilNode: recoil },
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
    smoke: [-1, 1].map(side => ({ node: kit.anchor(turret, 'smoke-bank', [side * 0.8, 1.8, -1.9]), direction: [side * 0.6, 0.55, -0.6] })),
    fire: [kit.anchor(body, 'engine-fire', [0, 1.6, 2.0]), kit.anchor(turret, 'turret-fire', [0.6, 2.9, 0.6])],
    cookoff: [kit.anchor(turret, 'ammo-cookoff', [0, 2.6, 0.6])],
  };

  const contacts = [-1, 1].map(side => ({ x: side * TANK_TRACK_X, z: 0, radius: 0.7, stretch: 3.6, strength: 0.7 }));
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), euler = new THREE.Euler();
  const scale = new THREE.Vector3(1, 0.4, 1), unit = new THREE.Vector3(1, 1, 1);
  const state = { left: 0, right: 0, spinLeft: 0, spinRight: 0 };
  const writeCleats = () => {
    cleatTransforms.forEach((transform, i) => {
      const point = pathPoint(transform.index / CLEATS_PER_SIDE * PERIMETER + (transform.side < 0 ? state.left : state.right));
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
  const animateTracks = (leftDistance = 0, rightDistance = 0) => {
    const left = Number.isFinite(leftDistance) ? leftDistance : 0, right = Number.isFinite(rightDistance) ? rightDistance : 0;
    if (left === 0 && right === 0) return;
    state.left += left; state.spinLeft -= left / 0.33;
    state.right += right; state.spinRight -= right / 0.33;
    writeCleats(); writeWheels();
  };
  const radarRate = 2 * Math.PI / AA_RADAR.sweepSeconds;
  const animate = (dt, { leftTrackSpeed = 0, rightTrackSpeed = 0, wreck = false } = {}) => {
    if (wreck || !(dt > 0)) return;
    animateTracks(leftTrackSpeed * dt, rightTrackSpeed * dt);
    // The search radar turns while the hull lives (presentation only).
    radar.rotation.y = (radar.rotation.y - radarRate * dt) % (2 * Math.PI);
  };

  return finishModel(kit, {
    body, turret, gun, barrel: recoil, radar, mounts, seatAnchors, emitters, contacts,
    wheels: [wheels], trackCleats: cleats, animate, animateTracks,
    muzzle: mounts['driver:main'].muzzle, muzzleLength: main.muzzle,
    gunPivotHeight: main.pivot[1], gunPivotForward: -main.pivot[2] + AA_TURRET_PIVOT[2],
    floorTop: 1.5, perimeter: PERIMETER,
  });
}
