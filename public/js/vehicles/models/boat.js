import { VoxelPart } from '../voxel-model/dsl.js';
import { VEHICLE_DEFS } from '../../../../shared/vehicle-defs.js';
import { blueprint, createKit, buildSeatAnchors, buildMounts, lightAnchor, finishModel } from './common.js';

// River patrol boat (docs/design/conquest/boat/variant-a-riverine-reference.jpg):
// a 6.8 m camouflaged hull with a raised, tapered bow, a gun tub with the .50
// behind a shield on the foredeck, a helm console amidships under a roof whose
// top is the cobalt (or orange) air recognition panel, an open aft cockpit with
// two benches and twin outboards on the transom. The team colour runs along
// both flanks and across the transom; a roundel sits on each bow flank.
// Hull frame: keel at y=0, the waterline at the def's draft (0.45 m), forward -Z.

/** Outboard motor positions (x) and the transom face (z). */
export const BOAT_OUTBOARDS = Object.freeze([-0.5, 0.5]);
export const BOAT_TRANSOM_Z = 3.0;
/** Highest point of the model above the keel (the canopy roof), m. */
export const BOAT_TOP = 2.4;
const BOW_Z = -3.4, FOREDECK_Z = -2.0, FLOOR_TOP = 0.6;
const round = v => Math.round(v * 5) / 5;

/** Half width of the hull at the gunwale for a slice centred at z. */
function halfWidth(z) {
  if (z >= -2.2) return 1.2;
  const t = Math.max(0, Math.min(1, (z - BOW_Z) / (-2.2 - BOW_Z)));
  return Math.max(0.2, round(0.2 + 1.0 * Math.sqrt(t)));
}
/** Keel (bottom) height of a slice: the bow rises out of the water. */
const keelY = z => (z < FOREDECK_Z ? round(0.2 + (FOREDECK_Z - z) * 0.5) : 0);
/** Gunwale top of a slice: the sheer climbs toward the bow. */
const sheerY = z => (z < -2.4 ? 1.6 : 1.4);

function buildParts() {
  const def = VEHICLE_DEFS.boat, bow = def.mounts.bow;
  const seats = Object.fromEntries(def.seats.map(seat => [seat.id, seat.position]));
  const hull = new VoxelPart('boat-hull');
  // Deep-V hull, slice by slice: narrow at the keel, flaring to the gunwale.
  for (let z = BOW_Z; z < BOAT_TRANSOM_Z - 1e-6; z += 0.2) {
    const zc = z + 0.1, hw = halfWidth(zc), yb = keelY(zc), yt = sheerY(zc);
    for (let y = yb; y < yt - 1e-6; y += 0.2) {
      const flare = Math.min(1, (y - yb + 0.2) / 0.6);
      const w = Math.max(0.2, round(hw * (0.5 + 0.5 * flare)));
      hull.box([-w, y, z], [w, y + 0.2, z + 0.2], y < 0.6 ? 'dark' : 'paint');
    }
  }
  // Open cockpit well (floor top 0.6) from the gun tub to the transom wall,
  // and the gun tub sunk into the foredeck.
  for (let z = FOREDECK_Z; z < BOAT_TRANSOM_Z - 0.2 - 1e-6; z += 0.2) {
    const w = halfWidth(z + 0.1) - 0.2;
    hull.carve([-w, FLOOR_TOP, z], [w, 2, z + 0.2]);
  }
  hull.carve([-0.6, FLOOR_TOP, -2.8], [0.6, 2, FOREDECK_Z]);
  hull.paint([-1.2, 0.4, -2.8], [1.2, FLOOR_TOP, BOAT_TRANSOM_Z - 0.2], 'interior', { where: m => m === 'paint' });
  // Gun tub coaming: a raised ring round the gunner, open toward the cockpit.
  hull.box([-0.8, 1.6, -3.0], [0.8, 1.8, -2.8], 'paint');
  for (const side of [-1, 1]) hull.box([side < 0 ? -0.8 : 0.6, 1.6, -2.8], [side < 0 ? -0.6 : 0.8, 1.8, -2.2], 'paint');
  // The pintle pedestal in the tub.
  hull.box([-0.2, FLOOR_TOP, -2.8], [0.2, 1.4, -2.6], 'gunmetal');
  // Helm console in front of the driver, a dash on top, a throttle box beside it.
  const [dx] = seats.driver;
  hull.box([-1.0, FLOOR_TOP, -1.0], [0.2, 1.4, -0.6], 'panel');
  hull.box([-1.0, 1.4, -1.0], [0.2, 1.6, -0.8], 'dark');
  hull.box([0.2, FLOOR_TOP, -0.8], [0.6, 1.0, -0.4], 'drab');
  hull.box([round(dx) - 0.2, 1.4, -0.8], [round(dx) + 0.2, 1.6, -0.6], 'screen');
  // Aft benches for the two passengers, backs toward the transom.
  for (const id of ['rear-left', 'rear-right']) {
    const [x, y, z] = seats[id], x0 = round(x - 0.4), x1 = round(x + 0.4);
    hull.box([x0, FLOOR_TOP, round(z - 0.3)], [x1, round(y - 0.15), round(z + 0.3)], 'seat');
    hull.box([x0, round(y - 0.15), round(z + 0.3)], [x1, round(y + 0.45), round(z + 0.5)], 'seat');
  }
  // Ammunition boxes and a jerrycan on the cockpit floor.
  hull.box([-0.4, FLOOR_TOP, -1.8], [0.0, 0.8, -1.4], 'drab', { tag: 'ammo' });
  hull.box([0.6, FLOOR_TOP, 0.4], [1.0, 1.0, 0.8], 'canvas', { tag: 'jerrycan' });
  // Rubber fender strip under the gunwale, the cobalt band along each flank,
  // the transom in the team colour and a roundel on each bow flank.
  hull.paint([-1.2, 1.2, -2.4], [1.2, 1.4, BOAT_TRANSOM_Z], 'rubber', { where: m => m === 'paint' });
  hull.paint([-1.2, 1.4, BOW_Z], [1.2, 1.6, -2.4], 'rubber', { where: m => m === 'paint' });
  for (const side of [-1, 1]) {
    hull.skin([side < 0 ? -1.2 : 0.8, 0.8, -1.2], [side < 0 ? -0.8 : 1.2, 1.0, BOAT_TRANSOM_Z], 'recog', { normal: [side, 0, 0], where: m => m === 'paint' });
    hull.roundel([side * 1.2, 1.0, -1.9], 0.3, [side, 0, 0], { depth: 0.2 });
  }
  hull.skin([-1.2, 0.6, BOAT_TRANSOM_Z - 0.2], [1.2, 1.4, BOAT_TRANSOM_Z], 'recog', { normal: [0, 0, 1], where: m => m === 'paint' || m === 'rubber' });
  // Grab rails along the aft gunwales.
  for (const side of [-1, 1]) {
    const x0 = side < 0 ? -1.2 : 1.0, x1 = side < 0 ? -1.0 : 1.2;
    for (const z of [0.6, 2.4]) hull.box([x0, 1.4, z], [x1, 1.8, z + 0.2], 'steel', { tag: 'rail' });
    hull.box([x0, 1.8, 0.6], [x1, 2.0, 2.6], 'steel', { tag: 'rail' });
  }
  hull.userData.priority = { ammo: 40, jerrycan: 40, rail: 30 };

  // Canopy: windscreen and a low roof on four posts (its top is the air
  // recognition panel with a roundel). Nothing stands above BOAT_TOP: afloat,
  // the boat clears the Iron Bridge deck (underside 2.43 m over the hull's
  // feet), so it carries no mast or whip antenna. From the driver's
  // first-person seat the canopy folds away (model.firstPersonHidden).
  const canopy = new VoxelPart('boat-canopy');
  canopy.box([-1.0, 1.6, -1.0], [-0.8, 2.0, -0.8], 'paint', { tag: 'windscreen' });
  canopy.box([0.8, 1.6, -1.0], [1.0, 2.0, -0.8], 'paint', { tag: 'windscreen' });
  canopy.box([-0.8, 1.6, -1.0], [0.8, 2.0, -0.8], 'glass', { tag: 'windscreen' });
  for (const x of [-1.0, 0.8]) {
    canopy.box([x, 2.0, -1.0], [x + 0.2, 2.2, -0.8], 'paint', { tag: 'roof' });
    canopy.box([x, 1.4, 0.2], [x + 0.2, 2.2, 0.4], 'paint', { tag: 'roof' });
  }
  canopy.box([-1.0, 2.2, -1.2], [1.0, BOAT_TOP, 0.4], 'panel', { tag: 'roof' });
  canopy.skin([-1.0, 2.2, -1.2], [1.0, BOAT_TOP, 0.4], 'recog', { normal: [0, 1, 0], where: m => m === 'panel' });
  canopy.roundel([0, BOAT_TOP, -0.4], 0.4, [0, 1, 0], { depth: 0.2 });
  canopy.userData.priority = { roof: 70, windscreen: 75 };

  // Wheel on the console (spins with the steer input).
  const steering = new VoxelPart('boat-steering', { pivot: [round(dx), 1.5, -0.6] });
  steering.box([round(dx) - 0.2, 1.4, -0.6], [round(dx) + 0.2, 1.6, -0.4], 'dark');

  // Twin outboards (they swivel with the steer about their clamp).
  const outboards = BOAT_OUTBOARDS.map((x, i) => {
    const part = new VoxelPart(`boat-outboard-${i}`, { pivot: [x, 0.8, BOAT_TRANSOM_Z + 0.2] });
    part.box([x - 0.3, 0.6, BOAT_TRANSOM_Z], [x + 0.3, 1.4, BOAT_TRANSOM_Z + 0.6], 'dark', { tag: 'outboard' });
    part.box([x - 0.3, 1.4, BOAT_TRANSOM_Z], [x + 0.3, 1.6, BOAT_TRANSOM_Z + 0.6], 'gunmetal', { tag: 'outboard' });
    part.box([x - 0.1, 0.0, BOAT_TRANSOM_Z + 0.2], [x + 0.1, 0.6, BOAT_TRANSOM_Z + 0.4], 'gunmetal', { tag: 'outboard' });
    part.box([x - 0.3, 0.0, BOAT_TRANSOM_Z + 0.4], [x + 0.3, 0.2, BOAT_TRANSOM_Z + 0.6], 'steel', { tag: 'outboard' });
    part.userData.priority = { outboard: 60 };
    return part;
  });

  // Bow mount: swivel ring (yaw) and the .50 with its shield, ammo can and
  // spade grips (pitch), as on the jeep pintle.
  const [px, py, pz] = bow.pivot;
  const swivel = new VoxelPart('boat-bow-swivel', { pivot: [px, py - 0.2, pz], grid: [px - 0.1, py - 0.2, pz - 0.1] });
  swivel.box([px - 0.1, py - 0.6, pz - 0.1], [px + 0.1, py - 0.2, pz + 0.1], 'steel', { tag: 'bow' });
  swivel.box([px - 0.3, py - 0.4, pz - 0.3], [px + 0.3, py - 0.2, pz + 0.3], 'gunmetal', { tag: 'bow' });
  const hmg = new VoxelPart('boat-bow-hmg', { pivot: bow.pivot, grid: [px - 0.1, py - 0.1, pz] });
  hmg.box([px - 0.1, py - 0.1, pz - 0.4], [px + 0.1, py + 0.1, pz + 0.2], 'dark', { tag: 'bow' });
  hmg.box([px - 0.1, py + 0.1, pz - 0.2], [px + 0.1, py + 0.2, pz + 0.2], 'gunmetal', { tag: 'bow' });
  hmg.box([px - 0.1, py - 0.1, pz - bow.muzzle + 0.2], [px + 0.1, py + 0.1, pz - 0.4], 'gunmetal', { tag: 'bow' });
  hmg.box([px - 0.1, py - 0.1, pz - bow.muzzle], [px + 0.1, py + 0.1, pz - bow.muzzle + 0.2], 'dark', { tag: 'bow' });
  // Shield: a plate round the receiver with a vision slot, the ammo can on the left.
  hmg.box([px - 0.3, py - 0.3, pz - 0.6], [px + 0.5, py + 0.3, pz - 0.4], 'drab', { tag: 'bow' });
  hmg.box([px - 0.1, py - 0.1, pz - 0.6], [px + 0.1, py + 0.1, pz - 0.4], 'gunmetal', { tag: 'bow' });
  hmg.box([px + 0.1, py + 0.1, pz - 0.6], [px + 0.3, py + 0.3, pz - 0.4], 'dark', { tag: 'bow' });
  hmg.box([px - 0.3, py - 0.3, pz - 0.2], [px - 0.1, py + 0.1, pz + 0.2], 'drab', { tag: 'bow' });
  hmg.box([px - 0.3, py - 0.1, pz + 0.2], [px + 0.3, py + 0.1, pz + 0.4], 'dark', { tag: 'bow' });
  hmg.userData.priority = { bow: 85 };
  return { hull, canopy, steering, outboards, swivel, hmg };
}

/** River patrol boat with an exposed crew and a bow .50. Options: { team, material, glass, blur }. */
export function makeBoatModel(options = {}) {
  const parts = blueprint('boat', buildParts);
  const { kit } = createKit('boat', options);
  const { group } = kit;
  const body = kit.node(group, 'boat-body', [0, 0, 0]);
  kit.part(body, parts.hull);
  const canopy = kit.node(body, 'boat-canopy', [0, 0, 0]);
  kit.part(canopy, parts.canopy);
  const steering = kit.node(body, 'steering-wheel', parts.steering.pivot);
  kit.part(steering, parts.steering);
  steering.rotation.x = -0.5;
  const outboards = parts.outboards.map(part => {
    const node = kit.node(body, part.name, part.pivot);
    kit.part(node, part);
    return node;
  });
  const bow = VEHICLE_DEFS.boat.mounts.bow;
  const swivel = kit.node(body, 'boat-bow-yaw', parts.swivel.pivot);
  kit.part(swivel, parts.swivel);
  const cradle = kit.node(swivel, 'boat-bow-pitch', bow.pivot);
  kit.part(cradle, parts.hmg);
  const grips = {
    left: kit.anchor(cradle, 'bow-grip-left', [bow.pivot[0] - 0.14, bow.pivot[1] - 0.05, bow.pivot[2] + 0.28]),
    right: kit.anchor(cradle, 'bow-grip-right', [bow.pivot[0] + 0.14, bow.pivot[1] - 0.05, bow.pivot[2] + 0.28]),
  };
  const seatAnchors = buildSeatAnchors(kit, 'boat', { body });
  const mounts = buildMounts(kit, 'boat', { bow: { yawNode: swivel, pitchNode: cradle, grips } });
  const [wx, wy, wz] = parts.steering.pivot;
  const wheelControls = { left: kit.anchor(steering, 'steering-grip-left', [wx - 0.17, wy, wz]),
    right: kit.anchor(steering, 'steering-grip-right', [wx + 0.17, wy, wz]) };
  const emitters = {
    exhaust: BOAT_OUTBOARDS.map(x => ({ node: kit.anchor(body, 'exhaust', [x, 1.1, BOAT_TRANSOM_Z + 0.6]), direction: [0, 0.3, 1] })),
    // Wake: the stern quarters and the outboards; spray: the bow shoulders (VehicleFx).
    wake: [...BOAT_OUTBOARDS.map(x => kit.anchor(group, 'wake', [x, 0.45, BOAT_TRANSOM_Z + 0.6])),
      kit.anchor(group, 'wake', [-1.1, 0.45, 2.4]), kit.anchor(group, 'wake', [1.1, 0.45, 2.4])],
    spray: [kit.anchor(group, 'bow-spray', [-0.9, 0.5, -2.2]), kit.anchor(group, 'bow-spray', [0.9, 0.5, -2.2])],
    dust: [], tracks: [],
    lights: [
      lightAnchor(kit, body, 'head', [0, 1.5, -3.3]),
      lightAnchor(kit, body, 'tail', [-1.1, 1.3, BOAT_TRANSOM_Z + 0.05], [0, 0, 1]), lightAnchor(kit, body, 'tail', [1.1, 1.3, BOAT_TRANSOM_Z + 0.05], [0, 0, 1]),
    ],
    fire: [kit.anchor(body, 'engine-fire', [0, 1.4, BOAT_TRANSOM_Z + 0.2])],
    cookoff: [kit.anchor(body, 'fuel-cookoff', [0.8, 1.0, 0.6])],
  };
  // Faint shade under the hull fore and aft (ContactShadows; the blobs sit at the keel, under the water face).
  const contacts = [-1.6, 1.6].map(z => ({ x: 0, z, radius: 1.1, stretch: 1.4, strength: 0.22 }));
  let steer = 0;
  const animate = (dt, { visualSteer = 0, wreck = false } = {}) => {
    if (wreck) return;
    steer = Number.isFinite(visualSteer) ? Math.max(-0.6, Math.min(0.6, visualSteer)) : 0;
    steering.rotation.z = -steer * 2.2;
    for (const node of outboards) node.rotation.y = -steer * 0.9;
  };
  return finishModel(kit, {
    body, mounts, seatAnchors, emitters, contacts, wheels: [], animate,
    turret: swivel, gun: cradle, steeringWheel: steering, wheelControls, outboards,
    floorTop: FLOOR_TOP,
    canopy, firstPersonHidden: [canopy],
  });
}
