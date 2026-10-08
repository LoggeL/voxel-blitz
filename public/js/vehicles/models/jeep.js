import * as THREE from '../../vendor/three.module.js';
import { VoxelPart } from '../voxel-model/dsl.js';
import { VEHICLE_DEFS } from '../../../../shared/vehicle-defs.js';
import { blueprint, createKit, buildSeatAnchors, buildMounts, lightAnchor, finishModel } from './common.js';

export const JEEP_WHEELS = Object.freeze([
  { x: -0.94, z: -1.18, front: true }, { x: 0.94, z: -1.18, front: true },
  { x: -0.94, z: 1.16, front: false }, { x: 0.94, z: 1.16, front: false },
]);
export const JEEP_WHEEL_RADIUS = 0.45;

// Hull-frame boxes snap to the 0.2 m grid: symmetric pairs use even tenths.
function buildParts() {
  const pintle = VEHICLE_DEFS.jeep.mounts.pintle;
  const seats = Object.fromEntries(VEHICLE_DEFS.jeep.seats.map(seat => [seat.id, seat.position]));
  const hull = new VoxelPart('jeep-hull');
  // Chassis rails and the cabin floor (floorTop 0.8).
  hull.box([-0.6, 0.4, -2.0], [0.6, 0.6, 2.0], 'dark');
  hull.box([-0.8, 0.6, -0.6], [0.8, 0.8, 2.0], 'dark');
  // Wide flat bonnet over the engine bay, stepped back from the grille.
  hull.box([-0.8, 0.6, -2.0], [0.8, 1.2, -0.6], 'paint', { tag: 'hood' });
  hull.box([-0.8, 1.2, -1.8], [0.8, 1.4, -0.6], 'panel', { tag: 'hood' });
  // Slotted grille (recessed slots) with round lamps in its corners.
  for (const x of [-0.6, -0.2, 0.0, 0.4]) hull.carve([x, 0.6, -2.0], [x + 0.2, 1.0, -1.8]);
  hull.box([-0.6, 0.6, -1.8], [0.6, 1.0, -1.6], 'dark');
  // Bumper with tow hooks.
  hull.box([-1.0, 0.4, -2.2], [1.0, 0.6, -2.0], 'dark');
  for (const side of [-1, 1]) {
    const tag = side < 0 ? 'fender-front-left' : 'fender-front-right';
    hull.box([side < 0 ? -0.8 : 0.6, 0.8, -2.0], [side < 0 ? -0.6 : 0.8, 1.0, -1.8], 'head');
    hull.box([side < 0 ? -0.6 : 0.4, 0.4, -2.4], [side < 0 ? -0.4 : 0.6, 0.6, -2.2], 'steel');
    // Flared fenders over the front wheels.
    hull.box([side < 0 ? -1.2 : 0.8, 1.0, -1.8], [side < 0 ? -0.8 : 1.2, 1.2, -0.6], 'paint', { tag });
    hull.wedge([side < 0 ? -1.2 : 0.8, 0.8, -2.0], [side < 0 ? -0.8 : 1.2, 1.2, -1.8], 'paint', { along: 'z', slope: 'y', from: 0.5, to: 1, anchor: 1, tag });
    // Half doors with a running board, then the wide rear quarters over the back wheels.
    hull.box([side < 0 ? -1.0 : 0.8, 0.6, -0.6], [side < 0 ? -0.8 : 1.0, 1.2, 0.6], 'paint');
    hull.box([side < 0 ? -1.2 : 1.0, 0.6, -0.6], [side < 0 ? -1.0 : 1.2, 0.8, 0.6], 'dark');
    hull.box([side < 0 ? -1.2 : 0.8, 1.0, 0.6], [side < 0 ? -0.8 : 1.2, 1.4, 2.0], 'paint', { tag: side < 0 ? 'fender-rear-left' : 'fender-rear-right' });
    hull.box([side < 0 ? -1.2 : 1.0, 1.0, 1.8], [side < 0 ? -1.0 : 1.2, 1.2, 2.0], 'tail', { tag: side < 0 ? 'fender-rear-left' : 'fender-rear-right' });
    // Team stripe down each door, roundel on each rear quarter.
    hull.skin([side < 0 ? -1.2 : 0.8, 0.6, -0.2], [side < 0 ? -0.8 : 1.2, 1.2, 0.2], 'stripe', { normal: [side, 0, 0], where: material => material === 'paint' });
    hull.roundel([side * 1.2, 1.2, 1.3], 0.3, [side, 0, 0], { depth: 0.2 });
  }
  // Tailgate, spare wheel and jerrycan on the back.
  hull.box([-0.8, 0.6, 1.8], [0.8, 1.4, 2.0], 'paint', { tag: 'tailgate' });
  hull.cyl([0.4, 1.1, 2.1], 0.36, 0.2, 'z', 'rubber', { tag: 'spare' });
  hull.cyl([0.4, 1.1, 2.1], 0.18, 0.4, 'z', 'drab', { tag: 'spare' });
  hull.box([-0.6, 0.8, 2.0], [-0.2, 1.4, 2.2], 'canvas', { tag: 'jerrycan' });
  // Windscreen: cowl, outer posts, top rail and a centre post between two
  // panes. The frame is its own part: from the local driver's first-person
  // seat it folds away (VehicleView hides model.firstPersonHidden).
  hull.box([-1.0, 1.2, -0.6], [1.0, 1.4, -0.4], 'dark');
  const windscreen = new VoxelPart('jeep-windscreen');
  windscreen.box([-1.0, 1.4, -0.6], [-0.8, 2.0, -0.4], 'paint', { tag: 'windscreen' });
  windscreen.box([0.8, 1.4, -0.6], [1.0, 2.0, -0.4], 'paint', { tag: 'windscreen' });
  windscreen.box([-1.0, 2.0, -0.6], [1.0, 2.2, -0.4], 'paint', { tag: 'windscreen' });
  windscreen.box([-0.2, 1.4, -0.6], [0.2, 2.0, -0.4], 'dark', { tag: 'windscreen' });
  windscreen.box([-0.8, 1.4, -0.6], [-0.2, 2.0, -0.4], 'glass', { tag: 'windscreen' });
  windscreen.box([0.2, 1.4, -0.6], [0.8, 2.0, -0.4], 'glass', { tag: 'windscreen' });
  windscreen.userData.priority = { windscreen: 75 };
  // Seats from the def hips (cushion below, back behind).
  const cushion = (position, width = 0.4) => {
    const [x, y, z] = position;
    hull.box([x - width / 2, 0.8, z - 0.2], [x + width / 2, y - 0.15, z + 0.2], 'seat');
    hull.box([x - width / 2, y - 0.15, z + 0.2], [x + width / 2, y + 0.45, z + 0.4], 'seat');
  };
  cushion([-0.4, seats.driver[1], 0.0]);
  cushion([0.4, seats['front-passenger'][1], 0.0]);
  hull.box([-0.8, 0.8, 1.2], [-0.2, seats['rear-left'][1] - 0.15, 1.6], 'seat');
  hull.box([-0.8, seats['rear-left'][1] - 0.15, 1.6], [-0.2, seats['rear-left'][1] + 0.35, 1.8], 'seat');
  // Roll cage: a hoop behind the front seats, a rear hoop and side rails.
  for (const side of [-1, 1]) {
    const x0 = side < 0 ? -1.0 : 0.8, x1 = side < 0 ? -0.8 : 1.0;
    hull.box([x0, 1.2, 0.4], [x1, 2.0, 0.6], 'gunmetal', { tag: 'rollbar' });
    hull.box([x0, 1.4, 1.6], [x1, 2.0, 1.8], 'gunmetal', { tag: 'rollbar' });
    hull.box([x0, 1.8, -0.4], [x1, 2.0, 1.8], 'gunmetal', { tag: 'rollbar' });
  }
  hull.box([-0.8, 1.8, 0.4], [0.8, 2.0, 0.6], 'gunmetal', { tag: 'rollbar' });
  // The pintle post on the rear bed and the gunner's standing plate behind it.
  hull.box([pintle.pivot[0] - 0.2, 0.8, pintle.pivot[2] - 0.2], [pintle.pivot[0] + 0.2, 1.0, pintle.pivot[2] + 0.2], 'gunmetal');
  hull.box([pintle.pivot[0] - 0.1, 1.0, pintle.pivot[2] - 0.1], [pintle.pivot[0] + 0.1, 1.9, pintle.pivot[2] + 0.1], 'gunmetal');
  hull.box([-0.2, 0.8, 0.8], [0.2, 0.9, 1.4], 'dark');
  // Radio set and two antenna whips at the rear corners.
  hull.box([0.4, 0.8, 1.4], [0.8, 1.2, 1.8], 'drab');
  for (const side of [-1, 1]) {
    for (let y = 1.4; y < 2.4; y += 0.2) hull.box([side < 0 ? -1.0 : 0.8, y, 1.8], [side < 0 ? -0.8 : 1.0, y + 0.2, 2.0], 'dark', { tag: 'antenna' });
  }
  hull.roundel([0, 1.4, -1.2], 0.42, [0, 1, 0]);
  hull.userData.priority = { hood: 80, rollbar: 60, tailgate: 50, spare: 70, jerrycan: 40, antenna: 20,
    'fender-front-left': 45, 'fender-front-right': 45, 'fender-rear-left': 45, 'fender-rear-right': 45 };

  // Steering wheel (spins with the steer input).
  const steering = new VoxelPart('jeep-steering', { pivot: [-0.4, 1.5, -0.3] });
  steering.box([-0.6, 1.4, -0.4], [-0.2, 1.6, -0.2], 'dark');

  // Pintle: swivel ring (yaw) and the .50 HMG with its gun shield, ammo can
  // and spade grips (pitch).
  const [px, py, pz] = pintle.pivot;
  const swivel = new VoxelPart('jeep-pintle-swivel', { pivot: [px, 1.9, pz], grid: [px - 0.1, 0, pz - 0.1] });
  swivel.box([px - 0.1, 1.9, pz - 0.1], [px + 0.1, 2.1, pz + 0.1], 'steel', { tag: 'pintle' });
  swivel.box([px - 0.3, 1.9, pz - 0.3], [px + 0.3, 2.0, pz + 0.3], 'gunmetal', { tag: 'pintle' });
  const hmg = new VoxelPart('jeep-pintle-hmg', { pivot: pintle.pivot, grid: [px - 0.1, py - 0.1, pz] });
  hmg.box([px - 0.1, py - 0.1, pz - 0.4], [px + 0.1, py + 0.1, pz + 0.2], 'dark', { tag: 'pintle' });
  hmg.box([px - 0.1, py + 0.1, pz - 0.2], [px + 0.1, py + 0.2, pz + 0.2], 'gunmetal', { tag: 'pintle' });
  hmg.box([px - 0.1, py - 0.1, pz - pintle.muzzle + 0.2], [px + 0.1, py + 0.1, pz - 0.4], 'gunmetal', { tag: 'pintle' });
  hmg.box([px - 0.1, py - 0.1, pz - pintle.muzzle], [px + 0.1, py + 0.1, pz - pintle.muzzle + 0.2], 'dark', { tag: 'pintle' });
  // Gun shield: a tall plate with a side wing and a vision slot, the barrel through it.
  hmg.box([px - 0.3, py - 0.3, pz - 0.6], [px + 0.5, py + 0.5, pz - 0.4], 'paint', { tag: 'pintle' });
  hmg.box([px + 0.3, py - 0.3, pz - 0.4], [px + 0.5, py + 0.5, pz - 0.2], 'paint', { tag: 'pintle' });
  hmg.box([px - 0.1, py - 0.1, pz - 0.6], [px + 0.1, py + 0.1, pz - 0.4], 'gunmetal', { tag: 'pintle' });
  hmg.box([px + 0.1, py + 0.1, pz - 0.6], [px + 0.3, py + 0.3, pz - 0.4], 'dark', { tag: 'pintle' });
  hmg.box([px - 0.5, py - 0.3, pz - 0.2], [px - 0.1, py + 0.1, pz + 0.2], 'drab', { tag: 'pintle' });
  hmg.box([px - 0.3, py - 0.1, pz + 0.2], [px + 0.3, py + 0.1, pz + 0.4], 'dark', { tag: 'pintle' });
  hmg.userData.priority = { pintle: 85 };

  // Wheels are authored at twice their size and meshed at half scale:
  // 0.1 m voxels give a round tyre, a painted rim and a hub (flush
  // faces keep the instanced wheel cheap).
  const wheel = new VoxelPart('jeep-wheel', { grid: [0, 0.1, 0.1] });
  wheel.userData.scale = 0.5;
  const r = JEEP_WHEEL_RADIUS * 2;
  wheel.cyl([0, 0, 0], r, 0.8, 'x', 'rubber', { hollow: 0.56 });
  wheel.cyl([0, 0, 0], 0.62, 0.8, 'x', 'drab');
  wheel.cyl([0, 0, 0], 0.24, 0.8, 'x', 'dark');
  // Charred tyres stay on the wreck: the hull settles onto them.
  wheel.userData.breaks = false;
  return { hull, windscreen, steering, swivel, hmg, wheel };
}

/**
 * Light utility vehicle with an exposed crew and a pintle HMG. Options:
 * { team, material, glass, blur }.
 */
export function makeJeepModel(options = {}) {
  const parts = blueprint('jeep', buildParts);
  const { kit } = createKit('jeep', options);
  const { group } = kit;
  const body = kit.node(group, 'jeep-body', [0, 0, 0]);
  kit.part(body, parts.hull);
  const windscreen = kit.node(body, 'jeep-windscreen', [0, 0, 0]);
  kit.part(windscreen, parts.windscreen);
  const steering = kit.node(body, 'steering-wheel', parts.steering.pivot);
  kit.part(steering, parts.steering);
  steering.rotation.x = -0.6;
  const pintle = VEHICLE_DEFS.jeep.mounts.pintle;
  const swivel = kit.node(body, 'jeep-pintle-yaw', parts.swivel.pivot);
  kit.part(swivel, parts.swivel);
  const cradle = kit.node(swivel, 'jeep-pintle-pitch', pintle.pivot);
  kit.part(cradle, parts.hmg);
  const grips = {
    left: kit.anchor(cradle, 'pintle-grip-left', [pintle.pivot[0] - 0.14, pintle.pivot[1] - 0.05, pintle.pivot[2] + 0.28]),
    right: kit.anchor(cradle, 'pintle-grip-right', [pintle.pivot[0] + 0.14, pintle.pivot[1] - 0.05, pintle.pivot[2] + 0.28]),
  };
  const wheelTransforms = JEEP_WHEELS.map(wheel => ({ position: [wheel.x, JEEP_WHEEL_RADIUS + 0.02, wheel.z], ...wheel }));
  const wheels = kit.instances(group, parts.wheel, wheelTransforms, 'jeep-wheels');
  const seatAnchors = buildSeatAnchors(kit, 'jeep', { body });
  const mounts = buildMounts(kit, 'jeep', { pintle: { yawNode: swivel, pitchNode: cradle, grips } });
  const wheelControls = { left: kit.anchor(steering, 'steering-grip-left', [-0.57, 1.5, -0.3]),
    right: kit.anchor(steering, 'steering-grip-right', [-0.23, 1.5, -0.3]) };
  const emitters = {
    exhaust: [{ node: kit.anchor(body, 'exhaust', [0.7, 0.5, 2.0]), direction: [0.2, 0, 1] }],
    dust: JEEP_WHEELS.filter(wheel => !wheel.front).map(wheel => kit.anchor(group, 'wheel-contact', [wheel.x, 0.05, wheel.z + 0.3])),
    tracks: JEEP_WHEELS.filter(wheel => !wheel.front).map(wheel => kit.anchor(group, 'tire-decal', [wheel.x, 0.02, wheel.z])),
    lights: [
      lightAnchor(kit, body, 'head', [-0.7, 0.9, -2.05]), lightAnchor(kit, body, 'head', [0.7, 0.9, -2.05]),
      lightAnchor(kit, body, 'tail', [-1.1, 1.1, 2.05], [0, 0, 1]), lightAnchor(kit, body, 'tail', [1.1, 1.1, 2.05], [0, 0, 1]),
    ],
    fire: [kit.anchor(body, 'engine-fire', [0, 1.3, -1.2])],
    cookoff: [kit.anchor(body, 'fuel-cookoff', [-0.4, 1.1, 2.1])],
  };
  const contacts = [-1.17, 1.16].map(z => ({ x: 0, z, radius: 0.6, stretch: 0.62, strength: 0.55, across: true }));
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const unit = new THREE.Vector3(1, 1, 1);
  let spin = 0, steer = 0;
  const write = () => {
    wheelTransforms.forEach((transform, i) => {
      position.fromArray(transform.position);
      quaternion.setFromEuler(euler.set(spin, transform.front ? -steer : 0, 0, 'YXZ'));
      matrix.compose(position, quaternion, unit);
      wheels.setMatrixAt(i, matrix);
    });
    wheels.instanceMatrix.needsUpdate = true;
  };
  write();
  const animate = (dt, { speed = 0, visualSteer = 0, wreck = false } = {}) => {
    if (wreck) return;
    const lastSpin = spin, lastSteer = steer;
    if (dt > 0 && Number.isFinite(speed)) spin = (spin - speed * dt / JEEP_WHEEL_RADIUS) % (Math.PI * 2);
    steer = Number.isFinite(visualSteer) ? Math.max(-0.6, Math.min(0.6, visualSteer)) : 0;
    steering.rotation.z = -steer * 1.8;
    // Parked jeeps keep their wheel pose without re-uploading the instances.
    if (spin !== lastSpin || steer !== lastSteer) write();
  };
  return finishModel(kit, {
    body, mounts, seatAnchors, emitters, contacts, wheels: [wheels], animate,
    turret: swivel, gun: cradle, steeringWheel: steering, wheelControls,
    floorTop: 0.8,
    // Folded away from the local first-person seats (see VehicleView).
    windscreen, firstPersonHidden: [windscreen],
  });
}
