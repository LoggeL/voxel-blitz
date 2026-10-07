import { VoxelPart } from '../voxel-model/dsl.js';
import { VEHICLE_DEFS } from '../../../../shared/vehicle-defs.js';
import { blueprint, createKit, buildSeatAnchors, buildMounts, lightAnchor, finishModel } from './common.js';

export const TRANSPORT_ROTOR = Object.freeze({ hub: [0, 3.3, -0.2], radius: 6, tail: [0.3, 2.5, 4.3], tailRadius: 1 });

function buildParts() {
  const def = VEHICLE_DEFS.transport;
  const hull = new VoxelPart('transport-hull');
  // Boxy utility fuselage with a glazed nose and an open cabin.
  hull.loft([[-3.6, 0.5, 0.8, 1.6, 2], [-3.0, 0.9, 0.6, 2.1, 3], [-2.2, 1.1, 0.5, 2.5, 7],
    [1.6, 1.1, 0.5, 2.6, 8], [2.2, 0.8, 0.9, 2.5, 5]], 'paint');
  // Cockpit and cabin interior.
  hull.carve([-0.9, 0.7, -2.6], [0.9, 2.4, 1.6]);
  hull.box([-0.9, 0.5, -2.6], [0.9, 0.7, 1.6], 'interior');
  // Wide sliding-door openings on both sides; the doors are slid back.
  for (const side of [-1, 1]) {
    hull.carve([side < 0 ? -1.2 : 0.8, 0.7, -0.6], [side < 0 ? -0.8 : 1.2, 2.2, 1.2]);
    hull.box([side < 0 ? -1.4 : 1.2, 0.8, 1.2], [side < 0 ? -1.2 : 1.4, 2.2, 1.8], 'panel', { tag: side < 0 ? 'door-left' : 'door-right' });
    // IFF panel on the slid-back door, at cabin-roof height.
    hull.box([side < 0 ? -1.4 : 1.2, 1.6, 1.2], [side < 0 ? -1.2 : 1.4, 2.0, 1.8], 'band', { tag: side < 0 ? 'door-left' : 'door-right' });
  }
  // Nose glazing and cockpit side windows.
  hull.loft([[-3.2, 0.5, 1.2, 1.8, 2], [-2.6, 0.95, 1.1, 2.4, 3], [-1.6, 1.05, 1.2, 2.5, 6]], 'glass', { shell: 0.2 });
  hull.box([-0.9, 0.7, -2.6], [0.9, 1.4, -2.4], 'dark');
  hull.box([-0.7, 1.2, -2.4], [0.7, 1.4, -2.2], 'screen');
  // Crew and passenger seats from the def.
  for (const seat of def.seats) {
    const [x, y, z] = seat.position;
    const facing = seat.id.startsWith('door') ? Math.sign(x) : 0;
    if (facing) {
      // Door gunners sit sideways on a jump seat facing out.
      hull.box([x - 0.2, 0.7, z - 0.2], [x + 0.2, y - 0.15, z + 0.2], 'seat');
      hull.box([x - 0.2 - facing * 0.2, y - 0.15, z - 0.2], [x + 0.2 - facing * 0.4, y + 0.55, z + 0.2], 'seat');
    } else {
      hull.box([x - 0.2, 0.7, z - 0.2], [x + 0.2, y - 0.15, z + 0.2], 'seat');
      hull.box([x - 0.2, y - 0.15, z + 0.2], [x + 0.2, y + 0.65, z + 0.4], 'seat');
    }
  }
  // Engines, exhausts and the mast fairing.
  for (const side of [-1, 1]) {
    const tag = side < 0 ? 'engine-left' : 'engine-right';
    hull.loft([[-1.0, 0.3, 2.5, 3.0, 4], [1.0, 0.32, 2.5, 3.0, 4], [1.6, 0.22, 2.55, 2.95, 3]], 'panel', { xOffset: side * 0.5, tag });
    hull.box([side < 0 ? -0.8 : 0.4, 2.6, 1.4], [side < 0 ? -0.4 : 0.8, 2.8, 1.8], 'exhaust', { tag });
  }
  hull.box([-0.2, 2.6, -0.4], [0.2, 3.2, 0.0], 'gunmetal');
  // Faction-coloured cowlings and a recognition band along both lower flanks.
  hull.paint([-1.0, 2.4, -1.0], [1.0, 3.1, 1.2], 'band', { where: material => material === 'panel' });
  for (const normal of [[1, 0, 0], [-1, 0, 0]]) {
    hull.skin([-1.4, 0.6, -2.4], [1.4, 1.0, 2.2], 'band', { normal, where: material => material === 'paint' });
  }
  // Tail boom, stripe, fin, stabilizer.
  hull.loft([[2.0, 0.45, 1.5, 2.4, 4], [3.2, 0.32, 1.85, 2.45, 4], [4.4, 0.22, 2.05, 2.5, 4]], 'paint', { tag: 'tail' });
  hull.box([-0.6, 1.4, 2.2], [0.6, 2.6, 2.4], 'stripe', { tag: 'tail' });
  // Faction band round the boom and the fin flash.
  hull.paint([-0.6, 1.4, 2.6], [0.6, 2.6, 3.0], 'band', { where: material => material === 'paint' });
  hull.prism('x', [[3.8, 2.1], [4.2, 3.6], [4.6, 3.6], [4.6, 2.1]], [-0.1, 0.1], 'paint', { tag: 'tail' });
  hull.paint([-0.2, 2.8, 3.8], [0.2, 3.6, 4.7], 'band');
  hull.box([-1.0, 2.0, 3.6], [1.0, 2.2, 4.0], 'paint', { tag: 'tail' });
  hull.box([-0.1, 3.6, 4.4], [0.1, 3.8, 4.6], 'strobe', { tag: 'tail' });
  // Fixed landing gear: two mains and a tail wheel.
  for (const side of [-1, 1]) {
    const tag = side < 0 ? 'gear-left' : 'gear-right';
    hull.box([side < 0 ? -1.4 : 1.0, 0, -0.2], [side < 0 ? -1.0 : 1.4, 0.4, 0.2], 'rubber', { tag });
    hull.box([side < 0 ? -1.2 : 0.8, 0.4, -0.2], [side < 0 ? -0.8 : 1.2, 0.6, 0.0], 'gunmetal', { tag });
  }
  hull.box([-0.1, 0.0, 3.4], [0.1, 0.4, 3.6], 'rubber', { tag: 'tail' });
  hull.box([-0.1, 0.4, 3.4], [0.1, 2.0, 3.6], 'gunmetal', { tag: 'tail' });
  // Door gun arms from the fuselage.
  for (const mountId of ['door-left', 'door-right']) {
    const [x, y, z] = def.mounts[mountId].pivot, side = Math.sign(x);
    hull.box([side < 0 ? x : 1.0, 1.2, z - 0.1], [side < 0 ? -1.0 : x, 1.4, z + 0.1], 'gunmetal');
  }
  hull.box([-1.2, 1.0, -0.8], [-1.0, 1.2, -0.6], 'navRed');
  hull.box([1.0, 1.0, -0.8], [1.2, 1.2, -0.6], 'navGreen');
  hull.box([-0.4, 0.4, -3.0], [0.4, 0.6, -2.6], 'head');
  // Team roundels on the cabin flanks between the cockpit glass and the doors.
  hull.roundel([1.1, 1.6, -1.1], 0.45, [1, 0, 0]);
  hull.roundel([-1.1, 1.6, -1.1], 0.45, [-1, 0, 0]);
  hull.userData.priority = { tail: 100, 'door-left': 70, 'door-right': 70, 'engine-left': 60, 'engine-right': 60, 'gear-left': 35, 'gear-right': 35 };

  const [hx, hy, hz] = TRANSPORT_ROTOR.hub, r = TRANSPORT_ROTOR.radius;
  const rotor = new VoxelPart('transport-rotor', { pivot: TRANSPORT_ROTOR.hub, grid: [hx - 0.1, hy - 0.1, hz - 0.1] });
  rotor.box([hx - 0.3, hy - 0.1, hz - 0.3], [hx + 0.3, hy + 0.1, hz + 0.3], 'gunmetal', { tag: 'rotor' });
  rotor.box([hx + 0.3, hy - 0.1, hz - 0.1], [hx + r, hy + 0.1, hz + 0.1], 'rotor', { tag: 'rotor' });
  rotor.box([hx - r, hy - 0.1, hz - 0.1], [hx - 0.3, hy + 0.1, hz + 0.1], 'rotor', { tag: 'rotor' });
  rotor.box([hx - 0.1, hy - 0.1, hz + 0.3], [hx + 0.1, hy + 0.1, hz + r], 'rotor', { tag: 'rotor' });
  rotor.box([hx - 0.1, hy - 0.1, hz - r], [hx + 0.1, hy + 0.1, hz - 0.3], 'rotor', { tag: 'rotor' });
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const ex = hx + dx * (r - 0.3), ez = hz + dz * (r - 0.3);
    rotor.box([ex - 0.1, hy - 0.1, ez - 0.1], [ex + 0.1, hy + 0.1, ez + 0.1], 'tip', { tag: 'rotor' });
  }
  rotor.userData.priority = { rotor: 95 };
  const [tx, ty, tz] = TRANSPORT_ROTOR.tail, tr = TRANSPORT_ROTOR.tailRadius;
  const tail = new VoxelPart('transport-tail-rotor', { pivot: TRANSPORT_ROTOR.tail, grid: [tx - 0.1, ty - 0.1, tz - 0.1] });
  tail.box([tx - 0.1, ty - tr, tz - 0.1], [tx + 0.1, ty + tr, tz + 0.1], 'rotor', { tag: 'tail-rotor' });
  tail.box([tx - 0.1, ty - 0.1, tz - tr], [tx + 0.1, ty + 0.1, tz + tr], 'rotor', { tag: 'tail-rotor' });
  tail.userData.priority = { 'tail-rotor': 65 };

  // Door miniguns: swivel post (yaw) and the six-barrel gun (pitch), authored facing -Z.
  const guns = {};
  for (const mountId of ['door-left', 'door-right']) {
    const mount = def.mounts[mountId], [x, y, z] = mount.pivot, tag = mountId;
    const swivel = new VoxelPart(`transport-${mountId}-swivel`, { pivot: mount.pivot, grid: [x - 0.1, y - 0.1, z - 0.1] });
    swivel.box([x - 0.1, y - 0.3, z - 0.1], [x + 0.1, y, z + 0.1], 'steel', { tag });
    const gun = new VoxelPart(`transport-${mountId}-gun`, { pivot: mount.pivot, grid: [x - 0.1, y - 0.1, z] });
    gun.box([x - 0.1, y - 0.1, z - 0.3], [x + 0.1, y + 0.1, z + 0.3], 'dark', { tag });
    gun.box([x - 0.1, y - 0.1, z - mount.muzzle], [x + 0.1, y + 0.1, z - 0.3], 'gunmetal', { tag });
    gun.box([x - 0.3, y - 0.1, z - 0.1], [x - 0.1, y + 0.1, z + 0.3], 'canvas', { tag });
    gun.userData.priority = { [tag]: 55 };
    guns[mountId] = { swivel, gun };
  }
  return { hull, rotor, tail, guns };
}

/**
 * Transport helicopter: glazed cockpit, open cabin with two door miniguns,
 * rear passenger seats, fixed gear, main and tail rotors with a blur disc.
 */
export function makeTransportModel(options = {}) {
  const parts = blueprint('transport', buildParts);
  const { kit } = createKit('transport', options);
  const { group } = kit;
  const body = kit.node(group, 'transport-body', [0, 0, 0]);
  kit.part(body, parts.hull);
  const mainRotor = kit.node(body, 'transport-main-rotor', TRANSPORT_ROTOR.hub);
  kit.part(mainRotor, parts.rotor);
  const blur = kit.blurDisc(body, TRANSPORT_ROTOR.radius, 'transport-rotor-blur');
  blur.position.copy(mainRotor.position);
  const tailRotor = kit.node(body, 'transport-tail-rotor', TRANSPORT_ROTOR.tail);
  kit.part(tailRotor, parts.tail);
  const rigs = {};
  for (const mountId of ['door-left', 'door-right']) {
    const mount = VEHICLE_DEFS.transport.mounts[mountId];
    const yawNode = kit.node(body, `transport-${mountId}-yaw`, mount.pivot);
    kit.part(yawNode, parts.guns[mountId].swivel);
    const pitchNode = kit.node(yawNode, `transport-${mountId}-pitch`, mount.pivot);
    kit.part(pitchNode, parts.guns[mountId].gun);
    // Rest pose points the gun out of its door.
    yawNode.rotation.y = mount.yawLimit ? mount.yawLimit[0] : 0;
    const [x, y, z] = mount.pivot;
    const grips = { left: kit.anchor(pitchNode, `${mountId}-grip-left`, [x - 0.14, y - 0.05, z + 0.35]),
      right: kit.anchor(pitchNode, `${mountId}-grip-right`, [x + 0.14, y - 0.05, z + 0.35]) };
    rigs[mountId] = { yawNode, pitchNode, grips };
  }
  const seatAnchors = buildSeatAnchors(kit, 'transport', { body });
  const mounts = buildMounts(kit, 'transport', rigs);
  const controlAnchors = {
    left: kit.anchor(body, 'collective', [-0.66, 1.55, -1.0]), right: kit.anchor(body, 'cyclic', [-0.36, 1.6, -1.35]),
  };
  const emitters = {
    exhaust: [-0.6, 0.6].map(x => ({ node: kit.anchor(body, 'exhaust', [x, 2.7, 1.85]), direction: [Math.sign(x) * 0.5, 0.2, 1] })),
    rotor: { node: mainRotor, radius: TRANSPORT_ROTOR.radius },
    lights: [
      lightAnchor(kit, body, 'navRed', [-1.25, 1.1, -0.7], [-1, 0, 0]), lightAnchor(kit, body, 'navGreen', [1.25, 1.1, -0.7], [1, 0, 0]),
      lightAnchor(kit, body, 'strobe', [0, 3.85, 4.5], [0, 1, 0]), lightAnchor(kit, body, 'head', [0, 0.45, -3.05], [0, -0.3, -1]),
    ],
    flares: [-1.0, 1.0].map(x => ({ node: kit.anchor(body, 'flare-dispenser', [x, 1.4, 1.9]), direction: [Math.sign(x), -0.3, 0.7] })),
    fire: [kit.anchor(body, 'engine-fire', [0, 2.8, 0.6])],
    cookoff: [kit.anchor(body, 'fuel-cookoff', [0, 0.9, 0.6])],
    smokeTrail: kit.anchor(body, 'wreck-trail', [0, 2.6, 1.2]),
  };
  const contacts = [-1.2, 1.2].map(x => ({ x, z: 0, radius: 0.5, strength: 0.45, stretch: 1 }))
    .concat([{ x: 0, z: 3.5, radius: 0.35, strength: 0.35, stretch: 1 }]);
  let rotorAngle = 0, tailAngle = 0;
  const animate = (dt, { rotorSpeed = 0, wreck = false } = {}) => {
    const spin = wreck ? 0 : Math.max(0, Math.min(1, rotorSpeed));
    const step = Math.max(0, Math.min(0.1, dt || 0));
    rotorAngle = (rotorAngle + spin * 30 * step) % (Math.PI * 2);
    tailAngle = (tailAngle - spin * 55 * step) % (Math.PI * 2);
    mainRotor.rotation.y = rotorAngle;
    tailRotor.rotation.x = tailAngle;
    const blurAmount = Math.max(0, Math.min(1, (spin - 0.35) / 0.4));
    blur.visible = blurAmount > 0.01;
    blur.material.opacity = 0.55 * blurAmount;
    mainRotor.visible = blurAmount < 0.98;
  };
  return finishModel(kit, {
    body, mainRotor, tailRotor, rotorBlur: blur, mounts, seatAnchors, emitters, contacts, animate, wheels: [],
    controlAnchors, cockpitControls: { leftHand: controlAnchors.left, rightHand: controlAnchors.right },
    turret: rigs['door-left'].yawNode, gun: rigs['door-left'].pitchNode,
    muzzle: mounts['door-left:door-left'].muzzle, floorTop: 0.7,
    // Gear breaks away with the wreck: the belly settles this far.
    wreckDrop: 0.45,
  });
}
