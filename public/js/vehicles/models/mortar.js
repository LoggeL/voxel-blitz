// Support mortar (shared/mortar-rules.js): a baseplate with its ammunition
// box, a bipod that traverses with the azimuth (the mount's yaw node) and the
// tube that elevates in it (the pitch node). The mortar is small, so every
// part is authored at twice its size and meshed at half scale (0.1 m voxels,
// like the jeep's wheels). The tube pivot and length come from
// VEHICLE_DEFS.mortar.mounts.tube, so the drawn muzzle is the server's.
import { VoxelPart } from '../voxel-model/dsl.js';
import { VEHICLE_DEFS } from '../../../../shared/vehicle-defs.js';
import { blueprint, createKit, buildSeatAnchors, buildMounts, finishModel } from './common.js';

const FINE = 0.5;
/** Authoring point of a fine part: `pivot` plus twice the real offset (meshed at FINE about the pivot). */
const at = (pivot, offset) => pivot.map((n, i) => n + offset[i] / FINE);
const fine = (name, pivot, grid = [0, 0, 0]) => {
  const part = new VoxelPart(name, { pivot, grid });
  part.userData.scale = FINE;
  return part;
};

/** A one-voxel rod between two real offsets from `pivot` (bipod legs, handles). */
function rod(part, pivot, a, b, material) {
  const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 0.05));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, p = at(pivot, a.map((n, k) => n + (b[k] - n) * t));
    part.setCell(...part.cells3(p), material);
  }
}

/** Grid offset (authoring metres) that puts a cell centre on `centre` along one axis. */
const centred = centre => (((centre - 0.1) % 0.2) + 0.2) % 0.2;

function buildParts() {
  const tube = VEHICLE_DEFS.mortar.mounts.tube, P = tube.pivot, length = tube.muzzle;
  // Baseplate, its socket and ribs, and the open ammunition box beside it.
  // Cells are centred on x = 0 and on the tube pivot's z, so the extents below
  // are odd multiples of 0.05 m about them.
  const O = [0, 0, 0], bz = P[2];
  const base = fine('mortar-base', O, [0.1, 0, centred(bz / FINE)]);
  base.cyl(at(O, [0, 0.05, bz]), 0.4 / FINE, 0.1 / FINE, 'y', 'gunmetal');
  base.box(at(O, [-0.05, 0.1, bz - 0.35]), at(O, [0.05, 0.2, bz + 0.35]), 'dark');
  base.box(at(O, [-0.35, 0.1, bz - 0.05]), at(O, [0.35, 0.2, bz + 0.05]), 'dark');
  base.box(at(O, [-0.15, 0.1, bz - 0.15]), at(O, [0.15, 0.3, bz + 0.15]), 'steel');
  base.box(at(O, [-0.75, 0, bz + 0.15]), at(O, [-0.45, 0.2, bz + 0.65]), 'drab');
  base.box(at(O, [-0.75, 0.2, bz + 0.15]), at(O, [-0.45, 0.3, bz + 0.65]), 'dark');
  for (const z of [0.25, 0.45]) base.box(at(O, [-0.65, 0.3, bz + z]), at(O, [-0.55, 0.4, bz + z + 0.1]), 'warhead');
  // Bipod: an A-frame forward of the tube with the traverse handwheels toward
  // the operator (his hands follow them round as the tube traverses).
  const bipod = fine('mortar-bipod', P);
  const apex = [0, 0.42, -0.36];
  rod(bipod, P, [-0.3, -0.22, -0.62], apex, 'gunmetal');
  rod(bipod, P, [0.3, -0.22, -0.62], apex, 'gunmetal');
  rod(bipod, P, [-0.18, -0.08, -0.52], [0.18, -0.08, -0.52], 'dark');
  bipod.box(at(P, [-0.3, -0.22, -0.68]), at(P, [-0.2, -0.17, -0.56]), 'dark');
  bipod.box(at(P, [0.2, -0.22, -0.68]), at(P, [0.3, -0.17, -0.56]), 'dark');
  rod(bipod, P, apex, [0, 0.3, 0.05], 'steel');
  rod(bipod, P, [-0.16, 0.3, 0.05], [0.16, 0.3, 0.05], 'dark');
  // The tube along -Z of the pitch node: breech cap, collar band and the sight.
  // Cells centred on the bore (x 0, the pivot height) and ending at the muzzle.
  const barrel = fine('mortar-tube', P, [0.1, centred(P[1]), centred(P[2] - (length - 0.05) / FINE)]);
  barrel.box(at(P, [-0.05, -0.05, -length]), at(P, [0.05, 0.05, 0.05]), 'gunmetal');
  barrel.box(at(P, [-0.15, -0.15, -0.05]), at(P, [0.15, 0.15, 0.05]), 'dark');
  barrel.box(at(P, [-0.15, -0.15, -0.45]), at(P, [0.15, 0.15, -0.35]), 'drab');
  barrel.box(at(P, [-0.25, -0.05, -0.35]), at(P, [-0.15, 0.05, -0.15]), 'dark');
  barrel.box(at(P, [-0.25, 0.05, -0.25]), at(P, [-0.15, 0.15, -0.15]), 'screen');
  return { base, bipod, barrel };
}

/** The Support mortar. Options: { team, material, glass, blur }. */
export function makeMortarModel(options = {}) {
  const type = 'mortar';
  const parts = blueprint(type, buildParts);
  const { kit } = createKit(type, options);
  const { group } = kit;
  const tube = VEHICLE_DEFS.mortar.mounts.tube, P = tube.pivot;
  const body = kit.node(group, 'mortar-body', [0, 0, 0]);
  kit.part(body, parts.base);
  const traverse = kit.node(body, 'mortar-yaw', P);
  kit.part(traverse, parts.bipod);
  const cradle = kit.node(traverse, 'mortar-pitch', P);
  kit.part(cradle, parts.barrel);
  // Traverse handwheels on the yaw node: the crouched operator holds them.
  const grips = {
    left: kit.anchor(traverse, 'mortar-grip-left', [P[0] - 0.16, P[1] + 0.3, P[2] + 0.05]),
    right: kit.anchor(traverse, 'mortar-grip-right', [P[0] + 0.16, P[1] + 0.3, P[2] + 0.05]),
  };
  const seatAnchors = buildSeatAnchors(kit, type, { body });
  const mounts = buildMounts(kit, type, { tube: { yawNode: traverse, pitchNode: cradle, grips } });
  const emitters = {
    exhaust: [], dust: [], tracks: [], lights: [],
    fire: [kit.anchor(body, 'mortar-fire', [-0.55, 0.35, 0.5])],
    cookoff: [kit.anchor(body, 'mortar-cookoff', [-0.55, 0.3, 0.5])],
  };
  return finishModel(kit, {
    body, mounts, seatAnchors, emitters, contacts: [], wheels: [],
    turret: traverse, gun: cradle,
    // The operator crouches on the ground: his hip anchor sits 0.45 m above it.
    floorTop: 0,
  });
}
