// Rocket artillery truck (shared/artillery-rules.js): a 6x6 cab-over truck
// with an armoured cab over the front axle, a flat bed over the rear bogie and
// one six-tube rocket pod (2 rows x 3 tubes) that traverses on a turntable and
// elevates about the trunnion at its rear. A .50 rides the hatch in the cab
// roof. Every pivot, muzzle length and seat hip comes from
// VEHICLE_DEFS.artillery, so the drawn pod and gun are the server's.
import * as THREE from '../../vendor/three.module.js';
import { VoxelPart } from '../voxel-model/dsl.js';
import { VEHICLE_DEFS } from '../../../../shared/vehicle-defs.js';
import { blueprint, createKit, buildSeatAnchors, buildMounts, lightAnchor, finishModel } from './common.js';

const TYPE = 'artillery';
/** Three axles: the steered front axle under the cab, the rear bogie under the launcher (wheelbase 4.6 m). */
export const ARTILLERY_WHEELS = Object.freeze([
  { x: -1.1, z: -2.7, front: true }, { x: 1.1, z: -2.7, front: true },
  { x: -1.1, z: 1.3, front: false }, { x: 1.1, z: 1.3, front: false },
  { x: -1.1, z: 2.5, front: false }, { x: 1.1, z: 2.5, front: false },
]);
export const ARTILLERY_WHEEL_RADIUS = 0.55;
/** Tube bores on the pod face: [x, y] offsets from the pod pivot (2 rows x 3). */
export const ARTILLERY_TUBES = Object.freeze([0.3, -0.3].flatMap(y => [-0.6, 0, 0.6].map(x => Object.freeze([x, y]))));

const CAB = Object.freeze({ front: -3.4, rear: -1.4, floor: 1.2, roof: 2.8, half: 1.2 });
const CAMO = material => material === 'paint' || material === 'panel';
const snap = metres => Math.round(metres / 0.2 + 1e-6) * 0.2;
/** Grid offset that puts a cell boundary on `value`. */
const onGrid = value => ((value % 0.2) + 0.2) % 0.2;

function buildParts() {
  const def = VEHICLE_DEFS[TYPE], pod = def.mounts.pod, ring = def.mounts.ring;
  const seats = Object.fromEntries(def.seats.map(seat => [seat.id, seat.position]));
  const hull = new VoxelPart('artillery-hull');
  // Ladder frame, axles and the engine under the cab.
  hull.box([-0.6, 0.6, -3.4], [0.6, 1.0, 3.4], 'dark');
  for (const z of [-2.7, 1.3, 2.5]) hull.box([-0.8, 0.4, z - 0.1], [0.8, 0.6, z + 0.1], 'gunmetal');
  hull.box([-0.8, 0.6, -3.4], [0.8, 1.0, -2.0], 'dark');
  // Tall front bumper with tow eyes, rear bar with the tail lamps and mud flaps.
  hull.box([-1.2, 0.6, -3.6], [1.2, 1.2, -3.4], 'dark', { tag: 'bumper' });
  hull.box([-1.2, 0.6, 3.4], [1.2, 1.0, 3.6], 'dark');
  for (const side of [-1, 1]) {
    const inner = (a, b) => (side < 0 ? [-b, -a] : [a, b]);
    const span = (a, b, y0, y1, z0, z1) => { const [x0, x1] = inner(a, b); return [[x0, y0, z0], [x1, y1, z1]]; };
    hull.box(...span(0.4, 0.6, 0.6, 0.8, -3.8, -3.6), 'steel', { tag: 'bumper' });
    hull.box(...span(1.0, 1.2, 0.8, 1.0, 3.4, 3.6), 'tail');
    hull.box(...span(0.8, 1.4, 0.4, 1.0, 3.2, 3.4), 'rubber', { tag: side < 0 ? 'flap-left' : 'flap-right' });
    // Stowage lockers on the frame between the cab and the rear bogie.
    hull.box(...span(0.8, 1.2, 0.6, 1.2, -1.2, 0.4), 'paint', { tag: side < 0 ? 'locker-left' : 'locker-right' });
    hull.box(...span(1.2, 1.4, 0.6, 0.8, -1.2, 0.4), 'dark', { tag: side < 0 ? 'locker-left' : 'locker-right' });
  }
  // Launcher deck over the rear bogie.
  hull.box([-0.8, 1.0, CAB.rear], [0.8, 1.2, 3.4], 'dark');

  // Armoured cab: floor, slab walls, flat roof. Wheel arches are cut into the floor.
  hull.box([-CAB.half, 1.0, CAB.front], [CAB.half, CAB.floor, CAB.rear], 'dark');
  hull.box([-CAB.half, CAB.floor, CAB.front], [CAB.half, 1.8, CAB.front + 0.2], 'paint');
  hull.box([-CAB.half, CAB.floor, CAB.rear - 0.2], [CAB.half, CAB.roof - 0.2, CAB.rear], 'paint');
  hull.box([-CAB.half, CAB.roof - 0.2, CAB.front], [CAB.half, CAB.roof, CAB.rear], 'panel');
  // Windscreen: two panes between the corner posts and a centre post. Its own
  // part: from the local first-person seats it folds away (VehicleView hides
  // model.firstPersonHidden), like the jeep's.
  const windscreen = new VoxelPart('artillery-windscreen');
  windscreen.box([-CAB.half, 1.8, CAB.front], [CAB.half, CAB.roof - 0.2, CAB.front + 0.2], 'paint', { tag: 'windscreen' });
  for (const [x0, x1] of [[-1.0, -0.2], [0.2, 1.0]]) windscreen.box([x0, 1.8, CAB.front], [x1, CAB.roof - 0.2, CAB.front + 0.2], 'glass', { tag: 'windscreen' });
  windscreen.userData.priority = { windscreen: 75 };
  // Radiator grille and headlamps in the cab face.
  hull.paint([-0.6, CAB.floor, CAB.front], [0.6, 1.6, CAB.front + 0.2], 'gunmetal');
  for (const x of [-0.4, 0, 0.4]) hull.paint([x - 0.2 + (x > 0 ? 0.2 : 0), CAB.floor, CAB.front], [x + (x > 0 ? 0.2 : 0), 1.6, CAB.front + 0.2], 'dark');
  for (const x of [-1.0, 0.8]) hull.paint([x, CAB.floor, CAB.front], [x + 0.2, 1.4, CAB.front + 0.2], 'head');
  for (const side of [-1, 1]) {
    const x0 = side < 0 ? -CAB.half : CAB.half - 0.2, x1 = x0 + 0.2;
    const out0 = side < 0 ? -1.4 : 1.2, out1 = out0 + 0.2;
    hull.carve([side < 0 ? -1.2 : 0.8, 1.0, CAB.front], [side < 0 ? -0.8 : 1.2, CAB.floor, -2.0]);
    // Door wall with its window, the skirt behind the wheel arch and the step.
    hull.box([x0, CAB.floor, CAB.front + 0.2], [x1, CAB.roof - 0.2, CAB.rear - 0.2], 'paint');
    hull.carve([x0, 1.8, -3.0], [x1, 2.4, -2.2]);
    hull.box([x0, 1.8, -3.0], [x1, 2.4, -2.2], 'glass');
    hull.box([x0, 0.8, -2.0], [x1, 1.0, CAB.rear], 'paint');
    hull.box([out0, 0.8, -2.0], [out1, 1.0, -1.6], 'dark');
    // Arch flare over the front wheel and the door mirror.
    hull.box([out0, CAB.floor, CAB.front], [out1, 1.4, -2.0], 'paint', { tag: side < 0 ? 'fender-front-left' : 'fender-front-right' });
    hull.box([out0, 2.0, CAB.front], [out1, 2.4, CAB.front + 0.2], 'dark', { tag: side < 0 ? 'mirror-left' : 'mirror-right' });
    // Recognition panel on the door, roundel on the skirt end of the cab flank.
    hull.skin([x0, CAB.floor, -3.0], [x1, 1.8, -2.2], 'recog', { normal: [side, 0, 0], where: CAMO });
    hull.roundel([side * CAB.half, 2.1, -1.8], 0.3, [side, 0, 0], { depth: 0.2 });
  }
  // Dash, the two seats from the def hips (cushion below, back behind).
  hull.box([-1.0, CAB.floor, CAB.front + 0.2], [1.0, 1.8, CAB.front + 0.4], 'dark');
  for (const id of ['driver', 'launcher']) {
    const [x, y, z] = seats[id], x0 = snap(x - 0.3), top = snap(y - 0.15), z0 = snap(z - 0.2);
    hull.box([x0, CAB.floor, z0], [x0 + 0.6, top, z0 + 0.4], 'seat');
    hull.box([x0, top, z0 + 0.4], [x0 + 0.6, top + 0.6, z0 + 0.6], 'seat');
  }
  // Launcher fire-control console in front of the operator.
  const lx = snap(seats.launcher[0] - 0.2);
  hull.box([lx, 1.8, CAB.front + 0.2], [lx + 0.4, 2.0, CAB.front + 0.4], 'gunmetal');
  hull.paint([lx, 1.8, CAB.front + 0.2], [lx + 0.4, 2.0, CAB.front + 0.4], 'screen');
  // Roof hatch over the gunner, his standing plate, and the air recognition panel ahead of it.
  const [gx, gy, gz] = seats['top-gunner'];
  const hatch = { z0: Math.max(CAB.front + 0.4, snap(gz - 0.4)), z1: Math.min(CAB.rear - 0.2, snap(gz + 0.2)) };
  hull.carve([gx - 0.4, CAB.roof - 0.2, hatch.z0], [gx + 0.4, CAB.roof, hatch.z1]);
  const plate = Math.floor((gy - 0.74) / 0.2 + 1e-6) * 0.2;
  if (plate > CAB.floor + 0.05) hull.box([gx - 0.4, CAB.floor, hatch.z0], [gx + 0.4, plate, hatch.z1], 'gunmetal');
  hull.skin([-1.0, CAB.roof - 0.2, CAB.front + 0.2], [1.0, CAB.roof, hatch.z0 - 0.2], 'recog', { normal: [0, 1, 0], where: CAMO });
  hull.roundel([0, CAB.roof, (CAB.front + hatch.z0) / 2], 0.34, [0, 1, 0], { depth: 0.2 });
  // Exhaust stack and antenna whip behind the cab corners.
  hull.box([1.0, 1.2, CAB.rear], [1.2, 3.0, CAB.rear + 0.2], 'exhaust', { tag: 'stack' });
  for (let y = CAB.roof; y < 3.6; y += 0.2) hull.box([-1.2, y, CAB.rear - 0.2], [-1.0, y + 0.2, CAB.rear], 'dark', { tag: 'antenna' });
  hull.userData.priority = { bumper: 60, hatch: 35, stack: 40, antenna: 20, 'fender-front-left': 45, 'fender-front-right': 45,
    'locker-left': 50, 'locker-right': 50, 'mirror-left': 15, 'mirror-right': 15, 'flap-left': 15, 'flap-right': 15 };

  // Steering wheel on its column, part of the hull: the sealed cab hides the
  // driver, so nothing holds it and it costs no draw of its own.
  const sx = snap(seats.driver[0] - 0.3), steerPivot = [sx + 0.3, 1.9, CAB.front + 0.5];
  hull.box([sx, 1.8, CAB.front + 0.4], [sx + 0.6, 2.0, CAB.front + 0.6], 'dark');

  // Launcher turntable (yaw): the ring on the deck, a cross beam and the two
  // trunnion cheeks that carry the pod.
  const [px, py, pz] = pod.pivot;
  const basePivot = [px, 1.2, pz];
  const base = new VoxelPart('artillery-turntable', { pivot: basePivot, grid: [0, 0, onGrid(pz)] });
  base.cyl([px, 1.3, pz], 0.8, 0.2, 'y', 'gunmetal', { tag: 'turntable' });
  base.box([px - 1.2, 1.2, pz - 0.2], [px + 1.2, 1.4, pz + 0.2], 'gunmetal', { tag: 'turntable' });
  for (const x of [px - 1.2, px + 1.0]) {
    base.box([x, 1.4, pz - 0.2], [x + 0.2, snap(py) + 0.2, pz + 0.2], 'paint', { tag: 'turntable' });
    base.box([x, snap(py) - 0.2, pz - 0.2], [x + 0.2, snap(py) + 0.2, pz + 0.2], 'gunmetal', { tag: 'turntable' });
  }
  base.userData.priority = { turntable: 70 };

  // The pod (pitch): a slab-sided box from the trunnion forward to the def's
  // muzzle plane, six bores in its face, blast vents in its back.
  const front = pz - pod.muzzle, y0 = py - 0.7, y1 = py + 0.7, rear = front + Math.ceil((pod.muzzle + 0.3) / 0.2 - 1e-6) * 0.2;
  const box = new VoxelPart('artillery-pod', { pivot: pod.pivot, grid: [0, onGrid(y0), onGrid(front)] });
  box.box([px - 1.0, y0, front], [px + 1.0, y1, rear], 'paint');
  box.paint([px - 1.0, y0, front], [px + 1.0, y1, front + 0.2], 'gunmetal');
  box.paint([px - 1.0, y0, rear - 0.2], [px + 1.0, y1, rear], 'gunmetal');
  // Lifting frames round the pod.
  for (const z of [front + 1.0, rear - 1.2]) box.paint([px - 1.0, y0, z], [px + 1.0, y1, z + 0.2], 'panel', { where: m => m === 'paint' });
  for (const [tx, ty] of ARTILLERY_TUBES) {
    const lo = [px + tx - 0.2, py + ty - 0.2], hi = [px + tx + 0.2, py + ty + 0.2];
    // Bore: 0.6 m deep and dark; a loaded rocket's nose sits 0.2 m inside it.
    box.carve([lo[0], lo[1], front], [hi[0], hi[1], front + 0.6]);
    box.paint([lo[0], lo[1], front + 0.6], [hi[0], hi[1], front + 0.8], 'exhaust');
    box.carve([lo[0], lo[1], rear - 0.2], [hi[0], hi[1], rear]);
    box.paint([lo[0], lo[1], rear - 0.4], [hi[0], hi[1], rear - 0.2], 'exhaust');
  }
  // Team markings: a band and a roundel on each flank, the top as the air recognition panel.
  for (const side of [-1, 1]) {
    box.skin([side < 0 ? px - 1.0 : px + 0.8, py - 0.1, front + 0.4], [side < 0 ? px - 0.8 : px + 1.0, py + 0.1, rear - 0.4], 'recog', { normal: [side, 0, 0], where: CAMO });
    box.roundel([px + side * 1.0, py, rear - 0.7], 0.3, [side, 0, 0], { depth: 0.2 });
  }
  box.skin([px - 0.8, y1 - 0.2, front + 0.4], [px + 0.8, y1, front + 2.4], 'recog', { normal: [0, 1, 0], where: CAMO });
  box.roundel([px, y1, front + 1.4], 0.42, [0, 1, 0], { depth: 0.2 });

  // One rocket nose (instanced per loaded tube), authored about its own centre.
  const rocket = new VoxelPart('artillery-rocket');
  rocket.box([-0.2, -0.2, -0.2], [0.2, 0.2, 0], 'missile');
  rocket.userData.breaks = true;

  // Roof .50: the mount ring (yaw) and the HMG with its shield and ammo can (pitch).
  const [rx, ry, rz] = ring.pivot;
  // Over the hatch the gun rides a race ring round the opening; ahead of it, a pedestal on the roof.
  const overHatch = rz > hatch.z0 - 0.25;
  const swivelPivot = [rx, CAB.roof, rz];
  const swivel = new VoxelPart('artillery-ring-swivel', { pivot: swivelPivot,
    grid: overHatch ? [onGrid(rx), 0, onGrid(rz)] : [onGrid(rx - 0.1), 0, onGrid(rz - 0.1)] });
  if (overHatch) {
    swivel.cyl([rx, CAB.roof + 0.1, rz], 0.7, 0.2, 'y', 'gunmetal', { tag: 'ring', hollow: 0.42 });
  } else {
    swivel.box([rx - 0.3, CAB.roof, rz - 0.3], [rx + 0.3, CAB.roof + 0.2, rz + 0.3], 'gunmetal', { tag: 'ring' });
    swivel.box([rx - 0.1, CAB.roof + 0.2, rz - 0.1], [rx + 0.1, ry - 0.1, rz + 0.1], 'steel', { tag: 'ring' });
    // The hatch lid lies open behind the gunner, under the barrel's sweep.
    hull.box([gx - 0.4, CAB.roof, hatch.z1], [gx + 0.4, CAB.roof + 0.2, hatch.z1 + 0.2], 'panel', { tag: 'hatch' });
  }
  swivel.userData.priority = { ring: 60 };
  const hmg = new VoxelPart('artillery-ring-hmg', { pivot: ring.pivot, grid: [onGrid(rx - 0.1), onGrid(ry - 0.1), onGrid(rz)] });
  hmg.box([rx - 0.1, ry - 0.1, rz - 0.4], [rx + 0.1, ry + 0.1, rz + 0.2], 'dark', { tag: 'ring' });
  hmg.box([rx - 0.1, ry + 0.1, rz - 0.2], [rx + 0.1, ry + 0.3, rz + 0.2], 'gunmetal', { tag: 'ring' });
  hmg.box([rx - 0.1, ry - 0.1, rz - ring.muzzle + 0.2], [rx + 0.1, ry + 0.1, rz - 0.4], 'gunmetal', { tag: 'ring' });
  hmg.box([rx - 0.1, ry - 0.1, rz - ring.muzzle], [rx + 0.1, ry + 0.1, rz - ring.muzzle + 0.2], 'dark', { tag: 'ring' });
  // Gun shield: two plates either side of the barrel, a vision slot over it.
  hmg.box([rx - 0.5, ry - 0.1, rz - 0.6], [rx - 0.1, ry + 0.5, rz - 0.4], 'paint', { tag: 'ring' });
  hmg.box([rx + 0.1, ry - 0.1, rz - 0.6], [rx + 0.5, ry + 0.5, rz - 0.4], 'paint', { tag: 'ring' });
  hmg.box([rx - 0.1, ry + 0.3, rz - 0.6], [rx + 0.1, ry + 0.5, rz - 0.4], 'paint', { tag: 'ring' });
  hmg.box([rx - 0.5, ry - 0.3, rz - 0.4], [rx - 0.1, ry + 0.1, rz], 'drab', { tag: 'ring' });
  hmg.box([rx - 0.3, ry - 0.1, rz + 0.2], [rx + 0.3, ry + 0.1, rz + 0.4], 'dark', { tag: 'ring' });
  hmg.userData.priority = { ring: 85 };

  // Wheels: authored at twice their size and meshed at half scale (0.1 m
  // voxels): a round tyre, a painted rim and a hub, flush faces.
  const wheel = new VoxelPart('artillery-wheel', { grid: [0, 0.1, 0.1] });
  wheel.userData.scale = 0.5;
  const r = ARTILLERY_WHEEL_RADIUS * 2;
  wheel.cyl([0, 0, 0], r, 1.0, 'x', 'rubber', { hollow: 0.66 });
  wheel.cyl([0, 0, 0], 0.72, 1.0, 'x', 'drab');
  wheel.cyl([0, 0, 0], 0.28, 1.0, 'x', 'dark');
  // Charred tyres stay on the wreck: the hull settles onto them.
  wheel.userData.breaks = false;
  return { hull, windscreen, steerPivot, base, box, rocket, swivel, hmg, wheel, basePivot, swivelPivot, front, rear };
}

/**
 * Rocket artillery truck model: six wheels (ground frame, the front pair
 * steers), the sprung body with the cab, the launcher turntable and pod
 * (`launcher:pod`) and the roof .50 (`top-gunner:ring`). Options: { team,
 * material, glass, blur }. animate() takes { speed, visualSteer, wreck,
 * railAmmo }: `railAmmo` is the pod's loaded rounds (the rocket noses shown).
 */
export function makeArtilleryModel(options = {}) {
  const parts = blueprint(TYPE, buildParts);
  const { kit } = createKit(TYPE, options);
  const { group } = kit;
  const def = VEHICLE_DEFS[TYPE], pod = def.mounts.pod, ring = def.mounts.ring;
  const body = kit.node(group, 'artillery-body', [0, 0, 0]);
  kit.part(body, parts.hull);
  const windscreen = kit.node(body, 'artillery-windscreen', [0, 0, 0]);
  kit.part(windscreen, parts.windscreen);
  // Steering column pivot (no mesh of its own: the wheel is part of the hull).
  const steering = kit.node(body, 'steering-wheel', parts.steerPivot);
  // Launcher: turntable (yaw) and the pod on its trunnion (pitch).
  const turntable = kit.node(body, 'artillery-pod-yaw', parts.basePivot);
  kit.part(turntable, parts.base);
  const launcher = kit.node(turntable, 'artillery-pod-pitch', pod.pivot);
  kit.part(launcher, parts.box);
  const rocketTransforms = ARTILLERY_TUBES.map(([x, y]) => ({ position: [x, y, parts.front + 0.4 - pod.pivot[2]] }));
  const rockets = kit.instances(launcher, parts.rocket, rocketTransforms, 'artillery-rockets');
  // Roof .50.
  const swivel = kit.node(body, 'artillery-ring-yaw', parts.swivelPivot);
  kit.part(swivel, parts.swivel);
  const cradle = kit.node(swivel, 'artillery-ring-pitch', ring.pivot);
  kit.part(cradle, parts.hmg);
  const grips = {
    left: kit.anchor(cradle, 'ring-grip-left', [ring.pivot[0] - 0.14, ring.pivot[1] - 0.05, ring.pivot[2] + 0.28]),
    right: kit.anchor(cradle, 'ring-grip-right', [ring.pivot[0] + 0.14, ring.pivot[1] - 0.05, ring.pivot[2] + 0.28]),
  };
  const wheelTransforms = ARTILLERY_WHEELS.map(wheel => ({ position: [wheel.x, ARTILLERY_WHEEL_RADIUS + 0.02, wheel.z], ...wheel }));
  const wheels = kit.instances(group, parts.wheel, wheelTransforms, 'artillery-wheels');
  const seatAnchors = buildSeatAnchors(kit, TYPE, { body });
  const mounts = buildMounts(kit, TYPE, {
    pod: { yawNode: turntable, pitchNode: launcher },
    ring: { yawNode: swivel, pitchNode: cradle, grips },
  });
  const [sx, sy, sz] = parts.steerPivot;
  const wheelControls = { left: kit.anchor(steering, 'steering-grip-left', [sx - 0.17, sy, sz]),
    right: kit.anchor(steering, 'steering-grip-right', [sx + 0.17, sy, sz]) };
  const rearWheels = ARTILLERY_WHEELS.filter(wheel => !wheel.front);
  const emitters = {
    exhaust: [{ node: kit.anchor(body, 'exhaust', [1.1, 3.05, -1.3]), direction: [0, 1, 0.3] }],
    dust: rearWheels.map(wheel => kit.anchor(group, 'wheel-contact', [wheel.x, 0.05, wheel.z + 0.3])),
    tracks: rearWheels.filter(wheel => wheel.z > 2).map(wheel => kit.anchor(group, 'tire-decal', [wheel.x, 0.02, wheel.z])),
    lights: [
      lightAnchor(kit, body, 'head', [-0.9, 1.3, -3.45]), lightAnchor(kit, body, 'head', [0.9, 1.3, -3.45]),
      lightAnchor(kit, body, 'tail', [-1.1, 0.9, 3.65], [0, 0, 1]), lightAnchor(kit, body, 'tail', [1.1, 0.9, 3.65], [0, 0, 1]),
    ],
    // Rocket motor blast out of the back of the pod (rides the pod's aim).
    backblast: [{ node: kit.anchor(launcher, 'pod-backblast', [pod.pivot[0], pod.pivot[1], parts.rear + 0.1]), direction: [0, 0, 1] }],
    fire: [kit.anchor(body, 'engine-fire', [0, 1.5, -3.0]), kit.anchor(launcher, 'pod-fire', [0, pod.pivot[1] + 0.8, pod.pivot[2] - 1.6])],
    cookoff: [kit.anchor(launcher, 'pod-cookoff', [0, pod.pivot[1], pod.pivot[2] - 1.6])],
  };
  const contacts = [-2.7, 1.3, 2.5].map(z => ({ x: 0, z, radius: 0.7, stretch: 0.6, strength: 0.6, across: true }));
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
  const animate = (dt, { speed = 0, visualSteer = 0, wreck = false, railAmmo = null } = {}) => {
    // Loaded tubes show their rocket's nose; a fired or swapped-out pod shows empty bores.
    if (Number.isFinite(railAmmo)) rockets.count = Math.max(0, Math.min(ARTILLERY_TUBES.length, Math.round(railAmmo)));
    if (wreck) return;
    const lastSpin = spin, lastSteer = steer;
    if (dt > 0 && Number.isFinite(speed)) spin = (spin - speed * dt / ARTILLERY_WHEEL_RADIUS) % (Math.PI * 2);
    steer = Number.isFinite(visualSteer) ? Math.max(-0.6, Math.min(0.6, visualSteer)) : 0;
    // A parked truck keeps its wheel pose without re-uploading the instances.
    if (spin !== lastSpin || steer !== lastSteer) write();
  };
  return finishModel(kit, {
    body, mounts, seatAnchors, emitters, contacts, wheels: [wheels], animate,
    turret: turntable, gun: launcher, pod: launcher, rockets,
    ring: swivel, ringGun: cradle, steeringWheel: steering, wheelControls,
    muzzle: mounts['launcher:pod'].muzzle, muzzleLength: pod.muzzle,
    // The hatch gunner stands on the cab floor.
    floorTop: CAB.floor,
    // Folded away from the local first-person seats (see VehicleView).
    windscreen, firstPersonHidden: [windscreen],
  });
}
