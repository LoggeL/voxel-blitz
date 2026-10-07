import { VoxelPart } from '../voxel-model/dsl.js';
import { VEHICLE_DEFS } from '../../../../shared/vehicle-defs.js';
import { blueprint, createKit, buildSeatAnchors, buildMounts, lightAnchor, finishModel } from './common.js';

export const HELICOPTER_ROTOR = Object.freeze({ hub: [0, 3.1, -0.35], radius: 5.4, tail: [0.3, 2.1, 3.3], tailRadius: 0.8 });

const PAINT = material => material === 'paint' || material === 'panel';

/** Rocket pod face: a ring of tube mouths (dark) on the front cells of a pod. */
function podFace(part, [px, py, pz], tag) {
  const front = part.ci(pz + 0.15, 2);
  for (let i = part.ci(px - 0.4, 0); i <= part.ci(px + 0.4, 0); i++)
    for (let j = part.ci(py - 0.4, 1); j <= part.ci(py + 0.4, 1); j++) {
      if (!part.getCell(i, j, front) || (i + j) % 2) continue;
      part.setCell(i, j, front, 'dark', tag);
    }
}

/** Main rotor: hub with pitch links and four 0.4 m chord blades with painted tips. */
export function rotorPart(name, hub, radius) {
  const [hx, hy, hz] = hub;
  const rotor = new VoxelPart(name, { pivot: hub, grid: [hx - 0.1, hy - 0.1, hz - 0.1] });
  rotor.box([hx - 0.3, hy - 0.1, hz - 0.3], [hx + 0.3, hy + 0.1, hz + 0.3], 'gunmetal', { tag: 'rotor' });
  rotor.box([hx - 0.1, hy + 0.1, hz - 0.1], [hx + 0.1, hy + 0.3, hz + 0.1], 'gunmetal', { tag: 'rotor' });
  // Each blade's chord trails to the same rotational side, so the four read as one rotor.
  const blades = [
    [[hx + 0.3, hz - 0.1], [hx + radius, hz + 0.3]], [[hx - radius, hz - 0.3], [hx - 0.3, hz + 0.1]],
    [[hx - 0.3, hz + 0.3], [hx + 0.1, hz + radius]], [[hx - 0.1, hz - radius], [hx + 0.3, hz - 0.3]],
  ];
  for (const [[x0, z0], [x1, z1]] of blades) {
    rotor.box([x0, hy - 0.1, z0], [x1, hy + 0.1, z1], 'rotor', { tag: 'rotor' });
    // Painted tip: the outer 0.4 m of the blade.
    const alongX = x1 - x0 > z1 - z0, outer = alongX ? (x0 > hx ? x1 : x0) : (z0 > hz ? z1 : z0);
    if (alongX) rotor.paint([Math.min(outer, outer - Math.sign(outer - hx) * 0.4), hy - 0.1, z0], [Math.max(outer, outer - Math.sign(outer - hx) * 0.4), hy + 0.1, z1], 'tip');
    else rotor.paint([x0, hy - 0.1, Math.min(outer, outer - Math.sign(outer - hz) * 0.4)], [x1, hy + 0.1, Math.max(outer, outer - Math.sign(outer - hz) * 0.4)], 'tip');
  }
  rotor.userData.priority = { rotor: 95 };
  return rotor;
}

// Hull-frame boxes snap to the 0.2 m grid: symmetric pairs use even tenths.
function buildParts() {
  const def = VEHICLE_DEFS.helicopter, chin = def.mounts.chin;
  const hull = new VoxelPart('helicopter-hull');
  // Narrow gunship fuselage: sensor nose, deep cockpit section, tapering aft.
  hull.loft([[-3.4, 0.3, 0.9, 1.3, 2], [-2.8, 0.55, 0.65, 1.6, 2.5], [-2.0, 0.75, 0.55, 1.8, 4],
    [-1.0, 0.85, 0.55, 2.0, 6], [0.2, 0.85, 0.6, 2.3, 6], [1.0, 0.8, 0.7, 2.3, 6], [1.6, 0.55, 1.0, 2.2, 4]], 'paint');
  // Stepped canopy: a low front section and a taller rear section with dark frames.
  hull.loft([[-2.6, 0.45, 1.0, 1.7, 2], [-2.2, 0.7, 1.0, 2.1, 3], [-1.5, 0.8, 1.0, 2.15, 5],
    [-1.4, 0.8, 1.0, 2.55, 5], [-0.2, 0.8, 1.0, 2.55, 5]], 'glass', { shell: 0.2 });
  hull.paint([-1, 0, -3], [1, 1.6, 0], 'paint', { where: material => material === 'glass' });
  hull.carve([-0.6, 1.0, -2.2], [0.6, 2.2, -0.2]);
  hull.paint([-1, 1.6, -1.6], [1, 2.8, -1.4], 'dark', { where: material => material === 'glass' });
  hull.paint([-1, 1.6, -0.4], [1, 2.8, -0.2], 'dark', { where: material => material === 'glass' });
  hull.paint([-1, 1.6, -2.4], [1, 2.8, -2.2], 'dark', { where: material => material === 'glass' });
  hull.box([-0.6, 0.8, -2.2], [0.6, 1.0, -0.2], 'interior');
  hull.box([-0.6, 1.0, -2.4], [0.6, 1.6, -2.2], 'dark');
  hull.box([-0.4, 1.4, -2.2], [0.4, 1.6, -2.0], 'interior');
  for (const seat of def.seats) {
    const [x, y, z] = seat.position;
    hull.box([x - 0.2, 1.0, z - 0.2], [x + 0.2, y - 0.15, z + 0.2], 'seat');
    hull.box([x - 0.2, y - 0.15, z + 0.2], [x + 0.2, y + 0.65, z + 0.4], 'seat');
  }
  // Engine nacelles hung either side of the spine, dark intakes and
  // exhausts, and the rotor mast fairing between them.
  for (const side of [-1, 1]) {
    const tag = side < 0 ? 'engine-left' : 'engine-right';
    hull.loft([[-0.2, 0.26, 1.9, 2.5, 3], [0.2, 0.32, 1.85, 2.6, 4], [1.4, 0.32, 1.85, 2.6, 4], [1.8, 0.24, 1.95, 2.5, 3]], 'panel', { xOffset: side * 0.8, tag });
    hull.box([side < 0 ? -1.0 : 0.6, 2.0, -0.2], [side < 0 ? -0.6 : 1.0, 2.4, 0.0], 'dark', { tag });
    hull.box([side < 0 ? -1.2 : 0.8, 2.0, 1.4], [side < 0 ? -0.8 : 1.2, 2.4, 1.8], 'exhaust', { tag });
  }
  hull.box([-0.4, 2.2, -0.8], [0.4, 2.8, 0.4], 'panel');
  hull.box([-0.2, 2.8, -0.6], [0.2, 3.0, -0.2], 'gunmetal');
  // Tail boom, fin, stabilizer, tail-rotor gearbox and strobe.
  hull.loft([[1.4, 0.45, 1.2, 2.2, 4], [2.6, 0.3, 1.55, 2.2, 4], [3.8, 0.22, 1.7, 2.25, 4]], 'paint', { tag: 'tail' });
  hull.prism('x', [[3.0, 1.8], [3.5, 3.1], [3.9, 3.1], [3.9, 1.8]], [-0.2, 0.2], 'paint', { tag: 'tail' });
  hull.box([-0.8, 1.8, 3.2], [0.8, 2.0, 3.6], 'paint', { tag: 'tail' });
  hull.box([0.0, 2.0, 3.2], [0.2, 2.2, 3.4], 'gunmetal', { tag: 'tail' });
  hull.box([-0.2, 3.0, 3.6], [0.2, 3.2, 3.8], 'strobe', { tag: 'tail' });
  // Stub wings with rocket pods (front faces at the def's pod sides) and
  // wingtip launch rails carrying two missiles each.
  for (const [index, pod] of def.mounts.pods.sides.entries()) {
    const side = index === 0 ? -1 : 1, tag = side < 0 ? 'wing-left' : 'wing-right';
    hull.box([side < 0 ? -1.6 : 0.8, 1.4, -1.0], [side < 0 ? -0.8 : 1.6, 1.6, 0.2], 'paint', { tag });
    hull.cyl([pod[0], pod[1], pod[2] + 0.55], 0.3, 1.1, 'z', 'panel', { tag });
    podFace(hull, pod, tag);
    hull.box([side < 0 ? -1.8 : 1.6, 1.4, -0.6], [side < 0 ? -1.6 : 1.8, 1.6, 0.4], 'gunmetal', { tag });
    hull.box([side < 0 ? -1.8 : 1.6, 1.2, -0.8], [side < 0 ? -1.6 : 1.8, 1.4, 0.2], 'missile', { tag });
    hull.box([side < 0 ? -1.8 : 1.6, 1.2, -1.0], [side < 0 ? -1.6 : 1.8, 1.4, -0.8], 'warhead', { tag });
    hull.box([side < 0 ? -1.8 : 1.6, 1.4, 0.4], [side < 0 ? -1.6 : 1.8, 1.6, 0.6], side < 0 ? 'navRed' : 'navGreen', { tag });
  }
  // Wheeled gear: trailing-arm mains under the cockpit, a tail wheel aft.
  for (const side of [-1, 1]) {
    const tag = side < 0 ? 'gear-left' : 'gear-right';
    hull.box([side < 0 ? -1.2 : 0.8, 0.0, -1.8], [side < 0 ? -0.8 : 1.2, 0.4, -1.4], 'rubber', { tag });
    hull.box([side < 0 ? -1.2 : 1.0, 0.2, -1.6], [side < 0 ? -1.0 : 1.2, 0.4, -1.4], 'drab', { tag });
    hull.box([side < 0 ? -1.0 : 0.8, 0.4, -1.6], [side < 0 ? -0.8 : 1.0, 0.8, -1.4], 'gunmetal', { tag });
    hull.box([side < 0 ? -0.8 : 0.6, 0.6, -1.6], [side < 0 ? -0.6 : 0.8, 0.8, -1.0], 'gunmetal', { tag });
  }
  hull.box([-0.2, 0.0, 3.2], [0.2, 0.4, 3.6], 'rubber', { tag: 'tail' });
  hull.box([-0.2, 0.4, 3.2], [0.0, 1.8, 3.4], 'gunmetal', { tag: 'tail' });
  // Sensor nose: a dark turret with a lit lens above the chin gun.
  hull.box([-0.4, 0.6, -2.8], [0.4, 0.8, -2.0], 'dark');
  hull.box([-0.4, 0.8, -3.6], [0.4, 1.4, -3.2], 'gunmetal');
  hull.box([-0.2, 0.8, -3.8], [0.2, 1.2, -3.6], 'dark');
  hull.box([-0.2, 1.0, -3.8], [0.0, 1.2, -3.6], 'head');
  hull.box([0.0, 0.8, -3.8], [0.2, 1.0, -3.6], 'screen');
  // Team markings: a vertical stripe behind the cockpit, roundels on the
  // nacelles and the boom.
  for (const side of [-1, 1]) {
    hull.skin([side < 0 ? -1.4 : 0.0, 0.4, 0.4], [side < 0 ? 0.0 : 1.4, 2.8, 0.8], 'stripe', { normal: [side, 0, 0], where: PAINT });
    hull.roundel([side * 1.1, 2.2, 1.25], 0.3, [side, 0, 0], { depth: 0.2, ring: 0.14 });
    hull.roundel([side * 0.4, 1.85, 2.3], 0.3, [side, 0, 0], { depth: 0.3, ring: 0.14 });
  }
  hull.userData.priority = { tail: 100, 'wing-left': 70, 'wing-right': 70, 'engine-left': 60, 'engine-right': 60, 'gear-left': 40, 'gear-right': 40 };

  const rotor = rotorPart('helicopter-rotor', HELICOPTER_ROTOR.hub, HELICOPTER_ROTOR.radius);
  const [tx, ty, tz] = HELICOPTER_ROTOR.tail;
  const tail = new VoxelPart('helicopter-tail-rotor', { pivot: HELICOPTER_ROTOR.tail, grid: [tx - 0.1, ty - 0.1, tz - 0.1] });
  const tr = HELICOPTER_ROTOR.tailRadius;
  tail.box([tx - 0.1, ty - tr, tz - 0.1], [tx + 0.1, ty + tr, tz + 0.1], 'rotor', { tag: 'tail-rotor' });
  tail.box([tx - 0.1, ty - 0.1, tz - tr], [tx + 0.1, ty + 0.1, tz + tr], 'rotor', { tag: 'tail-rotor' });
  tail.box([tx - 0.1, ty - 0.1, tz - 0.1], [tx + 0.3, ty + 0.1, tz + 0.1], 'gunmetal', { tag: 'tail-rotor' });
  tail.userData.priority = { 'tail-rotor': 65 };

  // Chin turret: yaw housing and the 25 mm cannon with a flash hider (pitch).
  const [cx, cy, cz] = chin.pivot;
  const chinYaw = new VoxelPart('helicopter-chin-yaw', { pivot: chin.pivot, grid: [cx - 0.1, cy - 0.1, cz - 0.1] });
  chinYaw.box([cx - 0.3, cy - 0.1, cz - 0.3], [cx + 0.3, cy + 0.3, cz + 0.3], 'gunmetal', { tag: 'chin' });
  chinYaw.box([cx - 0.1, cy + 0.1, cz - 0.1], [cx + 0.1, cy + 0.5, cz + 0.1], 'dark', { tag: 'chin' });
  const chinGun = new VoxelPart('helicopter-chin-gun', { pivot: chin.pivot, grid: [cx - 0.1, cy - 0.1, cz] });
  chinGun.box([cx - 0.1, cy - 0.1, cz - chin.muzzle + 0.2], [cx + 0.1, cy + 0.1, cz - 0.2], 'gunmetal', { tag: 'chin' });
  chinGun.box([cx - 0.1, cy - 0.1, cz - chin.muzzle], [cx + 0.1, cy + 0.1, cz - chin.muzzle + 0.2], 'dark', { tag: 'chin' });
  chinGun.box([cx - 0.3, cy - 0.3, cz - 0.4], [cx + 0.3, cy + 0.1, cz + 0.2], 'dark', { tag: 'chin' });
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
    exhaust: [-1.0, 1.0].map(x => ({ node: kit.anchor(body, 'exhaust', [x, 2.2, 1.85]), direction: [Math.sign(x) * 0.4, 0.3, 1] })),
    rotor: { node: mainRotor, radius: HELICOPTER_ROTOR.radius },
    lights: [
      lightAnchor(kit, body, 'navRed', [-1.75, 1.5, 0.5], [-1, 0, 0]), lightAnchor(kit, body, 'navGreen', [1.75, 1.5, 0.5], [1, 0, 0]),
      lightAnchor(kit, body, 'strobe', [0, 3.25, 3.7], [0, 1, 0]), lightAnchor(kit, body, 'head', [-0.1, 1.1, -3.85]),
    ],
    flares: [-0.8, 0.8].map(x => ({ node: kit.anchor(body, 'flare-dispenser', [x, 1.2, 1.2]), direction: [Math.sign(x), -0.4, 0.6] })),
    fire: [kit.anchor(body, 'engine-fire', [0, 2.5, 0.8])],
    cookoff: [kit.anchor(body, 'pod-cookoff', [-1.2, 1.2, 0])],
    smokeTrail: kit.anchor(body, 'wreck-trail', [0, 2.2, 1.2]),
  };
  const contacts = [-1.0, 1.0].map(x => ({ x, z: -1.6, radius: 0.45, stretch: 1, strength: 0.45 }))
    .concat([{ x: 0, z: 3.4, radius: 0.3, stretch: 1, strength: 0.35 }]);
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
    // The wheeled gear breaks away with the wreck: the belly settles this far.
    wreckDrop: 0.5,
  });
}
