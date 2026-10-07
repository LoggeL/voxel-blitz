import { VoxelPart } from '../voxel-model/dsl.js';
import { VEHICLE_DEFS } from '../../../../shared/vehicle-defs.js';
import { blueprint, createKit, buildSeatAnchors, buildMounts, lightAnchor, finishModel } from './common.js';

export const HELICOPTER_ROTOR = Object.freeze({ hub: [0, 3.1, -0.35], radius: 5.4, tail: [0.3, 2.1, 3.3], tailRadius: 0.8 });

function buildParts() {
  const def = VEHICLE_DEFS.helicopter, chin = def.mounts.chin;
  const hull = new VoxelPart('helicopter-hull');
  // Faceted gunship fuselage with a stepped nose.
  hull.loft([[-3.4, 0.2, 0.9, 1.3, 2], [-2.7, 0.55, 0.62, 1.65, 2.5], [-1.6, 0.85, 0.55, 1.9, 5],
    [-0.2, 0.9, 0.6, 2.2, 6], [1.0, 0.85, 0.7, 2.3, 6], [1.6, 0.55, 1.1, 2.2, 4]], 'paint');
  // Cockpit tub under a glass bubble (side-by-side crew, pilot left).
  hull.carve([-0.8, 1.0, -2.2], [0.8, 2.6, -0.2]);
  hull.box([-0.8, 0.8, -2.2], [0.8, 1.0, -0.2], 'interior');
  hull.loft([[-2.4, 0.4, 1.3, 1.9, 2], [-2.0, 0.75, 1.2, 2.3, 3], [-1.0, 0.85, 1.2, 2.5, 4], [-0.2, 0.85, 1.2, 2.5, 4]], 'glass', { shell: 0.2 });
  hull.box([-0.8, 1.0, -2.2], [0.8, 1.6, -2.0], 'dark');
  hull.box([-0.6, 1.4, -1.9], [0.6, 1.6, -1.7], 'screen');
  for (const seat of def.seats) {
    const [x, y, z] = seat.position;
    hull.box([x - 0.2, 1.0, z - 0.2], [x + 0.2, y - 0.15, z + 0.2], 'seat');
    hull.box([x - 0.2, y - 0.15, z + 0.2], [x + 0.2, y + 0.65, z + 0.4], 'seat');
  }
  // Engine nacelles and the rotor mast fairing.
  for (const side of [-1, 1]) {
    hull.loft([[-0.4, 0.28, 2.1, 2.6, 4], [1.2, 0.3, 2.1, 2.7, 4], [1.8, 0.2, 2.2, 2.6, 3]], 'panel', { xOffset: side * 0.45, tag: side < 0 ? 'engine-left' : 'engine-right' });
    hull.box([side < 0 ? -0.6 : 0.2, 2.2, 1.6], [side < 0 ? -0.2 : 0.6, 2.6, 1.8], 'exhaust', { tag: side < 0 ? 'engine-left' : 'engine-right' });
  }
  // Faction-coloured engine cowlings: the top of the gunship reads from any side.
  hull.paint([-1.0, 2.0, -0.4], [1.0, 2.8, 1.2], 'band', { where: material => material === 'panel' });
  hull.box([-0.2, 2.4, -0.6], [0.2, 3.0, -0.2], 'gunmetal');
  // Tail boom, stripe, fin, stabilizers.
  hull.loft([[1.4, 0.4, 1.3, 2.1, 4], [2.6, 0.3, 1.6, 2.15, 4], [3.6, 0.2, 1.8, 2.2, 4]], 'paint', { tag: 'tail' });
  hull.box([-0.4, 1.3, 1.8], [0.4, 2.2, 2.0], 'stripe', { tag: 'tail' });
  // Faction band round the boom and the fin flash: readable from any side.
  hull.paint([-0.6, 1.2, 2.2], [0.6, 2.4, 2.6], 'band', { where: material => material === 'paint' });
  hull.prism('x', [[3.0, 1.8], [3.5, 3.0], [3.8, 3.0], [3.8, 1.8]], [-0.1, 0.1], 'paint', { tag: 'tail' });
  hull.paint([-0.2, 2.4, 3.0], [0.2, 3.0, 3.9], 'band');
  hull.box([-0.9, 1.8, 2.6], [0.9, 2.0, 3.0], 'paint', { tag: 'tail' });
  hull.box([-0.1, 3.0, 3.6], [0.1, 3.2, 3.8], 'strobe', { tag: 'tail' });
  // Stub wings with the two rocket pods (front faces at the def's pod sides).
  for (const [index, pod] of def.mounts.pods.sides.entries()) {
    const side = index === 0 ? -1 : 1, tag = side < 0 ? 'wing-left' : 'wing-right';
    hull.box([side < 0 ? -1.6 : 0.8, 1.4, -0.4], [side < 0 ? -0.8 : 1.6, 1.6, 0.4], 'paint', { tag });
    hull.cyl([pod[0], pod[1], pod[2] + 0.55], 0.26, 1.1, 'z', 'panel', { tag });
    hull.box([pod[0] - 0.1, pod[1] - 0.1, pod[2] - 0.05], [pod[0] + 0.1, pod[1] + 0.1, pod[2] + 0.15], 'dark', { tag });
    hull.box([side < 0 ? -1.6 : 1.4, 1.4, 0.0], [side < 0 ? -1.4 : 1.6, 1.6, 0.2], side < 0 ? 'navRed' : 'navGreen', { tag });
  }
  // Skids and struts.
  for (const side of [-1, 1]) {
    const x0 = side < 0 ? -1.2 : 1.0, x1 = side < 0 ? -1.0 : 1.2, tag = side < 0 ? 'skid-left' : 'skid-right';
    hull.box([x0, 0, -2.2], [x1, 0.2, 1.4], 'gunmetal', { tag });
    hull.box([x0, 0.2, -2.6], [x1, 0.4, -2.2], 'gunmetal', { tag });
    for (const z of [-1.4, 0.6]) hull.box([side < 0 ? -1.2 : 0.6, 0.2, z], [side < 0 ? -0.6 : 1.2, 0.6, z + 0.2], 'dark', { tag });
  }
  // Chin sensor turret above the gun: a dark ball with one lit lens (not a
  // full-width lamp bar, which read as teeth).
  hull.box([-0.4, 0.6, -2.8], [0.4, 0.8, -2.0], 'dark');
  hull.box([-0.3, 0.6, -3.2], [0.3, 1.0, -2.8], 'gunmetal');
  hull.box([-0.1, 0.8, -3.4], [0.1, 1.0, -3.2], 'head');
  hull.box([0.1, 0.8, -3.4], [0.3, 1.0, -3.2], 'screen');
  // Faction IFF band along both flanks under the engine deck.
  for (const normal of [[1, 0, 0], [-1, 0, 0]]) {
    hull.skin([-1.2, 1.0, -0.4], [1.2, 1.6, 1.6], 'band', { normal, where: material => material === 'paint' });
  }
  hull.roundel([0, 1.7, 2.3], 0.35, [1, 0, 0]);
  hull.roundel([0, 1.7, 2.3], 0.35, [-1, 0, 0]);
  hull.userData.priority = { tail: 100, 'wing-left': 70, 'wing-right': 70, 'engine-left': 60, 'engine-right': 60, 'skid-left': 40, 'skid-right': 40 };

  // Main rotor: four voxel blades on a hub; tail rotor in the YZ plane.
  const [hx, hy, hz] = HELICOPTER_ROTOR.hub;
  const rotor = new VoxelPart('helicopter-rotor', { pivot: HELICOPTER_ROTOR.hub, grid: [hx - 0.1, hy - 0.1, hz - 0.1] });
  rotor.box([hx - 0.3, hy - 0.1, hz - 0.3], [hx + 0.3, hy + 0.1, hz + 0.3], 'gunmetal', { tag: 'rotor' });
  const r = HELICOPTER_ROTOR.radius;
  rotor.box([hx + 0.3, hy - 0.1, hz - 0.1], [hx + r, hy + 0.1, hz + 0.1], 'rotor', { tag: 'rotor' });
  rotor.box([hx - r, hy - 0.1, hz - 0.1], [hx - 0.3, hy + 0.1, hz + 0.1], 'rotor', { tag: 'rotor' });
  rotor.box([hx - 0.1, hy - 0.1, hz + 0.3], [hx + 0.1, hy + 0.1, hz + r], 'rotor', { tag: 'rotor' });
  rotor.box([hx - 0.1, hy - 0.1, hz - r], [hx + 0.1, hy + 0.1, hz - 0.3], 'rotor', { tag: 'rotor' });
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const ex = hx + dx * (r - 0.3), ez = hz + dz * (r - 0.3);
    rotor.box([ex - 0.1, hy - 0.1, ez - 0.1], [ex + 0.1, hy + 0.1, ez + 0.1], 'tip', { tag: 'rotor' });
  }
  rotor.userData.priority = { rotor: 95 };
  const [tx, ty, tz] = HELICOPTER_ROTOR.tail;
  const tail = new VoxelPart('helicopter-tail-rotor', { pivot: HELICOPTER_ROTOR.tail, grid: [tx - 0.1, ty - 0.1, tz - 0.1] });
  const tr = HELICOPTER_ROTOR.tailRadius;
  tail.box([tx - 0.1, ty - tr, tz - 0.1], [tx + 0.1, ty + tr, tz + 0.1], 'rotor', { tag: 'tail-rotor' });
  tail.box([tx - 0.1, ty - 0.1, tz - tr], [tx + 0.1, ty + 0.1, tz + tr], 'rotor', { tag: 'tail-rotor' });
  tail.userData.priority = { 'tail-rotor': 65 };

  // Chin turret: yaw housing and the 25 mm cannon (pitch).
  const [cx, cy, cz] = chin.pivot;
  const chinYaw = new VoxelPart('helicopter-chin-yaw', { pivot: chin.pivot, grid: [cx - 0.1, cy - 0.1, cz - 0.1] });
  chinYaw.box([cx - 0.3, cy - 0.1, cz - 0.3], [cx + 0.3, cy + 0.3, cz + 0.3], 'gunmetal', { tag: 'chin' });
  const chinGun = new VoxelPart('helicopter-chin-gun', { pivot: chin.pivot, grid: [cx - 0.1, cy - 0.1, cz] });
  chinGun.box([cx - 0.1, cy - 0.1, cz - chin.muzzle], [cx + 0.1, cy + 0.1, cz - 0.2], 'gunmetal', { tag: 'chin' });
  chinGun.box([cx - 0.2, cy - 0.2, cz - 0.4], [cx + 0.2, cy + 0.2, cz], 'dark', { tag: 'chin' });
  chinGun.userData.priority = { chin: 60 };
  return { hull, rotor, tail, chinYaw, chinGun };
}

/**
 * Attack helicopter: side-by-side crew under glass, pilot rocket pods on
 * stub wings, the gunner's chin cannon, main and tail rotors with a blur disc.
 */
export function makeHelicopterModel(options = {}) {
  const parts = blueprint('helicopter', buildParts);
  const { kit } = createKit('helicopter', options);
  const { group } = kit;
  const body = kit.node(group, 'helicopter-body', [0, 0, 0]);
  kit.part(body, parts.hull);
  const mainRotor = kit.node(body, 'helicopter-main-rotor', HELICOPTER_ROTOR.hub);
  kit.part(mainRotor, parts.rotor);
  const blur = kit.blurDisc(body, HELICOPTER_ROTOR.radius, 'helicopter-rotor-blur');
  blur.position.copy(mainRotor.position);
  const tailRotor = kit.node(body, 'helicopter-tail-rotor', HELICOPTER_ROTOR.tail);
  kit.part(tailRotor, parts.tail);
  const chin = VEHICLE_DEFS.helicopter.mounts.chin, pods = VEHICLE_DEFS.helicopter.mounts.pods;
  const chinYaw = kit.node(body, 'helicopter-chin-yaw', chin.pivot);
  kit.part(chinYaw, parts.chinYaw);
  const chinPitch = kit.node(chinYaw, 'helicopter-chin-pitch', chin.pivot);
  kit.part(chinPitch, parts.chinGun);
  const podRig = kit.node(body, 'helicopter-pods', pods.pivot);
  const seatAnchors = buildSeatAnchors(kit, 'helicopter', { body });
  const mounts = buildMounts(kit, 'helicopter', {
    pods: { yawNode: podRig, pitchNode: podRig },
    chin: { yawNode: chinYaw, pitchNode: chinPitch },
  });
  const controlAnchors = {
    left: kit.anchor(body, 'collective', [-0.66, 1.55, -1.0]), right: kit.anchor(body, 'cyclic', [-0.36, 1.6, -1.35]),
  };
  const gunnerAnchors = { left: kit.anchor(body, 'gunner-grip-left', [0.2, 1.65, -1.4]), right: kit.anchor(body, 'gunner-grip-right', [0.52, 1.65, -1.4]) };
  const emitters = {
    exhaust: [-0.4, 0.4].map(x => ({ node: kit.anchor(body, 'exhaust', [x, 2.4, 1.85]), direction: [Math.sign(x) * 0.3, 0.3, 1] })),
    rotor: { node: mainRotor, radius: HELICOPTER_ROTOR.radius },
    lights: [
      lightAnchor(kit, body, 'navRed', [-1.65, 1.5, 0.1], [-1, 0, 0]), lightAnchor(kit, body, 'navGreen', [1.65, 1.5, 0.1], [1, 0, 0]),
      lightAnchor(kit, body, 'strobe', [0, 3.25, 3.7], [0, 1, 0]), lightAnchor(kit, body, 'head', [0, 0.9, -3.45]),
    ],
    flares: [-0.8, 0.8].map(x => ({ node: kit.anchor(body, 'flare-dispenser', [x, 1.2, 1.2]), direction: [Math.sign(x), -0.4, 0.6] })),
    fire: [kit.anchor(body, 'engine-fire', [0, 2.5, 0.8])],
    cookoff: [kit.anchor(body, 'pod-cookoff', [-1.2, 1.2, 0])],
    smokeTrail: kit.anchor(body, 'wreck-trail', [0, 2.2, 1.2]),
  };
  const contacts = [-1.1, 1.1].map(x => ({ x, z: -0.4, radius: 0.5, stretch: 3.6, strength: 0.45 }));
  let rotorAngle = 0, tailAngle = 0;
  const animate = (dt, { rotorSpeed = 0, wreck = false } = {}) => {
    const spin = wreck ? 0 : Math.max(0, Math.min(1, rotorSpeed));
    const step = Math.max(0, Math.min(0.1, dt || 0));
    rotorAngle = (rotorAngle + spin * 36 * step) % (Math.PI * 2);
    tailAngle = (tailAngle - spin * 60 * step) % (Math.PI * 2);
    mainRotor.rotation.y = rotorAngle;
    tailRotor.rotation.x = tailAngle;
    // Blades blur into a disc above ~45% rotor speed.
    const blurAmount = Math.max(0, Math.min(1, (spin - 0.35) / 0.4));
    blur.visible = blurAmount > 0.01;
    blur.material.opacity = 0.55 * blurAmount;
    mainRotor.visible = blurAmount < 0.98;
  };
  return finishModel(kit, {
    body, turret: chinYaw, gun: chinPitch, mainRotor, tailRotor, rotorBlur: blur,
    mounts, seatAnchors, emitters, contacts, animate, wheels: [],
    controlAnchors, gunnerAnchors, cockpitControls: { leftHand: controlAnchors.left, rightHand: controlAnchors.right },
    muzzle: mounts['gunner:chin'].muzzle, floorTop: 1.0,
    // Skids break away with the wreck: the belly settles this far.
    wreckDrop: 0.5,
  });
}
