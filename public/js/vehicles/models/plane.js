import * as THREE from '../../vendor/three.module.js';
import { VoxelPart } from '../voxel-model/dsl.js';
import { VEHICLE_DEFS } from '../../../../shared/vehicle-defs.js';
import { blueprint, createKit, buildSeatAnchors, buildMounts, lightAnchor, finishModel } from './common.js';

export const PLANE_GEAR = Object.freeze({ nose: [0, 1.0, -2.6], mains: [[-0.9, 1.0, 0.9], [0.9, 1.0, 0.9]] });
export const PLANE_NOZZLES = Object.freeze([[-0.45, 1.2, 4.75], [0.45, 1.2, 4.75]]);

const PAINT = material => material === 'paint' || material === 'panel';

// Hull-frame boxes snap to the 0.2 m grid: symmetric pairs use even tenths.
function buildParts() {
  const def = VEHICLE_DEFS.plane;
  const hull = new VoxelPart('plane-hull');
  // Long fuselage: pointed grey radome, cockpit hump, wide engine bays aft.
  hull.loft([[-5.2, 0.1, 0.95, 1.15, 2], [-4.6, 0.3, 0.85, 1.4, 2], [-3.4, 0.5, 0.8, 1.6, 2.5],
    [-2.4, 0.6, 0.8, 1.7, 3], [-1.2, 0.7, 0.85, 1.75, 4], [2.0, 0.8, 0.85, 1.75, 6], [3.6, 0.85, 0.9, 1.65, 6], [4.6, 0.8, 0.95, 1.5, 5]], 'paint');
  hull.paint([-1, 0.6, -5.4], [1, 1.8, -4.2], 'radome');
  // Bubble canopy over the cockpit tub, with a dark windscreen bow.
  hull.carve([-0.4, 1.2, -2.4], [0.4, 1.8, -0.2]);
  hull.box([-0.4, 1.0, -2.4], [0.4, 1.2, -0.2], 'interior');
  hull.loft([[-2.8, 0.15, 1.5, 1.7, 2], [-2.2, 0.42, 1.4, 2.2, 2.5], [-1.0, 0.48, 1.4, 2.35, 3], [-0.2, 0.3, 1.45, 1.9, 2]], 'glass', { shell: 0.2 });
  hull.paint([-1, 1.4, -2.4], [1, 2.4, -2.2], 'dark', { where: material => material === 'glass' });
  const [sx, sy, sz] = def.seats[0].position;
  hull.box([sx - 0.2, 1.2, sz - 0.2], [sx + 0.2, sy - 0.1, sz + 0.2], 'seat');
  hull.box([sx - 0.2, sy - 0.1, sz + 0.2], [sx + 0.2, sy + 0.7, sz + 0.4], 'seat');
  hull.box([-0.4, 1.4, -2.4], [0.4, 1.6, -2.2], 'screen');
  // Dorsal spine from the canopy back to the tails.
  hull.box([-0.4, 1.6, -0.2], [0.4, 1.8, 3.2], 'panel');
  // Boxy intakes either side of the cockpit with dark mouths and a raked lip.
  for (const side of [-1, 1]) {
    const x0 = side < 0 ? -1.0 : 0.6, x1 = side < 0 ? -0.6 : 1.0;
    hull.box([x0, 0.8, -1.8], [x1, 1.6, 0.8], 'paint');
    hull.wedge([x0, 0.8, -2.4], [x1, 1.6, -1.8], 'paint', { along: 'z', slope: 'y', from: 0.5, to: 1, anchor: 1 });
    hull.box([x0, 0.8, -2.2], [x1, 1.2, -2.0], 'exhaust');
    hull.box([side < 0 ? -1.0 : 0.8, 1.0, -1.8], [side < 0 ? -0.8 : 1.0, 1.2, -1.2], 'panel');
  }
  // Swept wings and tailplanes (one symmetric outline each).
  hull.prism('y', [[-0.8, -0.9], [0.8, -0.9], [4.5, 1.3], [4.5, 2.0], [0.8, 2.1], [-0.8, 2.1], [-4.5, 2.0], [-4.5, 1.3]], [1.2, 1.4], 'paint');
  for (const side of [-1, 1]) {
    const tag = side < 0 ? 'wing-left' : 'wing-right';
    hull.paint([side < 0 ? -4.6 : 2.2, 1.0, 0.0], [side < 0 ? -2.2 : 4.6, 1.6, 2.2], 'paint', { tag });
    // Flaps along the trailing edge in the lighter panel coat.
    hull.paint([side < 0 ? -3.6 : 1.0, 1.2, 1.8], [side < 0 ? -1.0 : 3.6, 1.4, 2.2], 'panel', { where: PAINT });
    hull.box([side < 0 ? -4.6 : 4.4, 1.2, 1.4], [side < 0 ? -4.4 : 4.6, 1.4, 1.8], side < 0 ? 'navRed' : 'navGreen', { tag });
    hull.roundel([side * 3.1, 1.4, 1.3], 0.42, [0, 1, 0], { depth: 0.2 });
    hull.roundel([side * 1.0, 1.2, -1.0], 0.36, [side, 0, 0], { depth: 0.2, ring: 0.14 });
  }
  hull.prism('y', [[-0.6, 2.8], [0.6, 2.8], [2.0, 3.6], [2.0, 4.4], [0.6, 4.2], [-0.6, 4.2], [-2.0, 4.4], [-2.0, 3.6]], [1.4, 1.6], 'paint', { tag: 'tailplane' });
  // Twin fins with swept leading edges, rudders in the panel coat, dark tips.
  for (const side of [-1, 1]) {
    const tag = side < 0 ? 'fin-left' : 'fin-right', xs = side < 0 ? [-0.8, -0.6] : [0.6, 0.8];
    hull.prism('x', [[2.2, 1.6], [3.4, 3.4], [4.0, 3.4], [4.4, 1.6]], xs, 'paint', { tag });
    hull.paint([xs[0], 1.8, 3.8], [xs[1], 3.0, 4.4], 'panel', { tag });
    hull.paint([xs[0], 3.2, 3.2], [xs[1], 3.4, 4.0], 'dark', { tag });
  }
  hull.box([-0.8, 3.0, 3.8], [-0.6, 3.2, 4.0], 'strobe', { tag: 'fin-left' });
  // Team stripe: a full band round the fuselage and intakes behind the cockpit.
  hull.skin([-1.2, 0.6, -0.2], [1.2, 2.0, 0.4], 'stripe', { where: PAINT });
  // Twin nozzles: metal cans with petal rims and dark throats.
  for (const [x, y, z] of PLANE_NOZZLES) {
    hull.cyl([x, y, z - 0.35], 0.38, 0.6, 'z', 'gunmetal');
    hull.cyl([x, y, z - 0.15], 0.42, 0.2, 'z', 'dark', { hollow: 0.24 });
    hull.cyl([x, y, z - 0.3], 0.2, 0.6, 'z', 'exhaust');
  }
  // Wing pylons down to the missile rails.
  for (const [x, y, z] of def.mounts.rails.sides) hull.box([x - 0.2, y + 0.2, z - 0.6], [x + 0.2, 1.2, z + 0.8], 'gunmetal', { tag: x < 0 ? 'wing-left' : 'wing-right' });
  // Gun port by the nose.
  const nose = def.mounts.nose.pivot;
  hull.box([nose[0] + 0.2, nose[1] - 0.1, nose[2] + 1.4], [nose[0] + 0.4, nose[1] + 0.1, nose[2] + 1.8], 'dark');
  hull.userData.priority = { 'wing-left': 90, 'wing-right': 90, tailplane: 70, 'fin-left': 60, 'fin-right': 60 };

  // AA missile: white body, grey seeker, red warning band, cruciform fins.
  const missile = new VoxelPart('plane-missile', { grid: [-0.1, -0.1, 0] });
  missile.box([-0.1, -0.1, -1.0], [0.1, 0.1, 0.8], 'missile');
  missile.box([-0.1, -0.1, -1.2], [0.1, 0.1, -1.0], 'radome');
  missile.box([-0.1, -0.1, -0.8], [0.1, 0.1, -0.6], 'marking');
  missile.box([-0.3, -0.1, 0.4], [0.3, 0.1, 0.8], 'missile');
  missile.box([-0.1, -0.3, 0.4], [0.1, 0.3, 0.8], 'missile');
  missile.box([-0.3, -0.1, -0.6], [0.3, 0.1, -0.4], 'warhead');
  missile.userData.breaks = true;

  // Retracting gear legs, pivoting at the bay roof.
  const gear = (name, top, tag) => {
    const [x, y, z] = top;
    const part = new VoxelPart(name, { pivot: top, grid: [x - 0.1, 0, z - 0.1] });
    part.box([x - 0.1, 0.4, z - 0.1], [x + 0.1, y, z + 0.1], 'steel', { tag });
    part.box([x - 0.1, 0, z - 0.3], [x + 0.1, 0.4, z + 0.3], 'rubber', { tag });
    part.box([x - 0.1, 0.2, z - 0.1], [x + 0.1, 0.4, z + 0.1], 'drab', { tag });
    part.userData.priority = { [tag]: 30 };
    return part;
  };
  return {
    hull, missile,
    noseGear: gear('plane-nose-gear', PLANE_GEAR.nose, 'gear-nose'),
    mainGears: PLANE_GEAR.mains.map((top, i) => gear(`plane-main-gear-${i}`, top, i ? 'gear-right' : 'gear-left')),
  };
}

/**
 * Single-seat strike jet: glass canopy, nose cannon, AA missiles on wing
 * rails (hidden as they launch), twin nozzles and retracting gear.
 */
export function makePlaneModel(options = {}) {
  const parts = blueprint('plane', buildParts);
  const { kit } = createKit('plane', options);
  const { group } = kit;
  const body = kit.node(group, 'plane-body', [0, 0, 0]);
  kit.part(body, parts.hull);
  const noseGear = kit.node(body, 'plane-nose-gear', PLANE_GEAR.nose);
  kit.part(noseGear, parts.noseGear);
  const mainGears = PLANE_GEAR.mains.map((top, i) => {
    const node = kit.node(body, `plane-main-gear-${i}`, top);
    kit.part(node, parts.mainGears[i]);
    return node;
  });
  const def = VEHICLE_DEFS.plane;
  const missileTransforms = def.mounts.rails.sides.map(([x, y, z]) => ({ position: [x, y, z + 0.2] }));
  const missiles = kit.instances(body, parts.missile, missileTransforms, 'plane-missiles');
  const noseRig = kit.node(body, 'plane-nose-gun', def.mounts.nose.pivot);
  const railRig = kit.node(body, 'plane-rails', def.mounts.rails.pivot);
  const seatAnchors = buildSeatAnchors(kit, 'plane', { body });
  const mounts = buildMounts(kit, 'plane', {
    nose: { yawNode: noseRig, pitchNode: noseRig },
    rails: { yawNode: railRig, pitchNode: railRig },
  });
  const cockpitControls = {
    leftHand: kit.anchor(body, 'plane-left-hand', [-0.27, 1.55, -1.62]), rightHand: kit.anchor(body, 'plane-right-hand', [0.27, 1.55, -1.62]),
    leftPedal: kit.anchor(body, 'plane-left-pedal', [-0.18, 1.2, -1.95]), rightPedal: kit.anchor(body, 'plane-right-pedal', [0.18, 1.2, -1.95]),
  };
  const emitters = {
    afterburner: PLANE_NOZZLES.map(point => ({ node: kit.anchor(body, 'nozzle', point), direction: [0, 0, 1] })),
    exhaust: PLANE_NOZZLES.map(point => ({ node: kit.anchor(body, 'nozzle', point), direction: [0, 0, 1] })),
    wingtips: [[-4.5, 1.3, 1.9], [4.5, 1.3, 1.9]].map(point => kit.anchor(body, 'wingtip', point)),
    lights: [
      lightAnchor(kit, body, 'navRed', [-4.65, 1.3, 1.6], [-1, 0, 0]), lightAnchor(kit, body, 'navGreen', [4.65, 1.3, 1.6], [1, 0, 0]),
      lightAnchor(kit, body, 'strobe', [-0.7, 3.25, 3.9], [0, 1, 0]), lightAnchor(kit, noseGear, 'head', [0, 0.6, -2.85]),
    ],
    flares: [-0.7, 0.7].map(x => ({ node: kit.anchor(body, 'flare-dispenser', [x, 0.9, 3.4]), direction: [Math.sign(x) * 0.6, -0.5, 0.6] })),
    fire: [kit.anchor(body, 'engine-fire', [0, 1.5, 3.4])],
    cookoff: [kit.anchor(body, 'fuel-cookoff', [0, 1.2, 0.6])],
    smokeTrail: kit.anchor(body, 'wreck-trail', [0, 1.4, 4.2]),
  };
  const contacts = [{ x: 0, z: -2.6, radius: 0.35, strength: 0.4, stretch: 1 },
    ...PLANE_GEAR.mains.map(([x, , z]) => ({ x, z: z + 0.2, radius: 0.45, strength: 0.45, stretch: 1 }))];
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), unit = new THREE.Vector3(1, 1, 1);
  const zero = new THREE.Vector3(0, 0, 0);
  let retraction = 0, loaded = [true, true];
  const setMissiles = ammo => {
    const next = [ammo >= 1, ammo >= 2];
    if (next[0] === loaded[0] && next[1] === loaded[1]) return;
    loaded = next;
    missileTransforms.forEach((transform, i) => {
      matrix.compose(position.fromArray(transform.position), quaternion.identity(), loaded[i] ? unit : zero);
      missiles.setMatrixAt(i, matrix);
    });
    missiles.instanceMatrix.needsUpdate = true;
  };
  const animate = (dt, { grounded = true, wreck = false, railAmmo = null } = {}) => {
    const step = Math.max(0, Math.min(0.1, dt || 0));
    const target = grounded || wreck ? 0 : 1;
    retraction += Math.sign(target - retraction) * Math.min(Math.abs(target - retraction), step * 0.75);
    noseGear.rotation.x = -retraction * Math.PI / 2;
    mainGears.forEach((gear, i) => { gear.rotation.z = (i ? -1 : 1) * retraction * 1.45; });
    const visible = retraction < 0.995;
    noseGear.visible = visible; for (const gear of mainGears) gear.visible = visible;
    if (Number.isFinite(railAmmo)) setMissiles(railAmmo);
  };
  return finishModel(kit, {
    body, noseGear, mainGears, landingGear: [noseGear, ...mainGears], missiles,
    mounts, seatAnchors, emitters, contacts, animate, wheels: [],
    turret: noseRig, gun: noseRig, operatorSeat: seatAnchors.driver, cockpitControls,
    pilotPose: { footHeight: 1.2 }, muzzle: mounts['driver:nose'].muzzle, muzzleLength: 0, floorTop: 1.2,
    // Gear legs break away with the wreck: the belly settles this far.
    wreckDrop: 0.75,
    setMissiles,
  });
}
