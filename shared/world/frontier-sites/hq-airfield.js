// HQ plateaus at y36 (spec 4.3): a 312 m runway along z, two helipads, an
// arched aircraft hangar with the team roundel, a control tower with an
// exterior ladder, a fuel farm, the motor pool and AA dressing. Alpha is
// authored here; bravo is its exact point mirror (mirroredKit).

import {
  AIR, ASPHALT, CONCRETE, PALE, METAL, RUST, GLASS, CORRUGATED_STEEL, BARRICADE, ACCENT, PLANK,
  POOL_TILE_BLUE, TRUCK_RED, DUST_CRATE, TIMBER,
} from '../blocks.js';
import { FRONTIER_PLAN } from '../../conquest-contract.js';
import { FRONTIER_RUNWAYS } from '../frontier-terrain.js';
import { mirroredKit } from './kit.js';
import { rect } from './plan.js';
import { sandbags, ring, crateStack } from './props.js';

const HQ = FRONTIER_PLAN.hqs.alpha;
const RUNWAY = FRONTIER_RUNWAYS.find(r => r.team === 'alpha');
/** Alpha HQ layout in continuous coordinates; bravo mirrors every entry. */
export const HQ_LAYOUT = Object.freeze({
  base: { x: HQ.x, z: HQ.z },
  runway: { x: RUNWAY.x, z0: RUNWAY.z0, z1: RUNWAY.z1, width: RUNWAY.width, takeoffStartZ: RUNWAY.z1 - 8, takeoffEndZ: RUNWAY.z1 - 308 },
  helipads: [{ x: 112.5, z: 300.5, radius: 11, rotorClearance: 6 }, { x: 112.5, z: 468.5, radius: 11, rotorClearance: 6 }],
  hangar: rect(70, 228, 106, 262),
  tower: rect(60, 292, 70, 302),
  fuel: rect(64, 270, 86, 286),
  bunker: rect(74, 340, 90, 354),
  motorPool: rect(112, 396, 146, 436),
  shed: rect(96, 432, 108, 446),
  jeep: { x: 126.5, z: 404.5, yaw: -Math.PI / 2 },
  tank: { x: 126.5, z: 424.5, yaw: -Math.PI / 2 },
  aa: [{ x: 134, z: 226 }, { x: 134, z: 542 }],
  spawns: [[84.5, 374.5], [90.5, 374.5], [96.5, 374.5], [102.5, 374.5], [84.5, 393.5], [90.5, 393.5], [96.5, 393.5], [102.5, 393.5]],
  roundel: { x: 106, y: 9, z: 245 },
});

const PALETTES = {
  alpha: { outer: POOL_TILE_BLUE, inner: PALE, centre: POOL_TILE_BLUE, stripe: POOL_TILE_BLUE },
  bravo: { outer: ACCENT, inner: PALE, centre: TRUCK_RED, stripe: ACCENT },
};

/** Ladder volume on the tower's west face (alpha frame). */
export function hqTowerLadder(floorY) {
  const t = HQ_LAYOUT.tower, z = (t.minZ + t.maxZ) >> 1;
  return { minX: t.minX - 1, maxX: t.minX, minY: floorY + 1, maxY: floorY + 13.2, minZ: z - 1, maxZ: z + 1, face: 'x-' };
}

function runway(kit, y) {
  const r = HQ_LAYOUT.runway, x0 = Math.floor(r.x - r.width / 2), x1 = x0 + r.width - 1;
  kit.box(x0, y, r.z0, x1, y, r.z1 - 1, ASPHALT);
  kit.box(x0 + 1, y, r.z0, x0 + 1, y, r.z1 - 1, PALE);
  kit.box(x1 - 1, y, r.z0, x1 - 1, y, r.z1 - 1, PALE);
  for (let z = r.z0 + 14; z < r.z1 - 14; z += 12) kit.box(Math.floor(r.x) - 1, y, z, Math.floor(r.x), y, z + 5, PALE);
  for (const zEnd of [r.z0 + 2, r.z1 - 9]) for (let x = x0 + 3; x <= x1 - 3; x += 3) kit.box(x, y, zEnd, x + 1, y, zEnd + 6, PALE);
  // Edge lights beside the strip, never inside the wing sweep.
  for (let z = r.z0; z < r.z1; z += 20) for (const x of [x0 - 3, x1 + 3]) { kit.set(x, y + 1, z, METAL); kit.set(x, y + 2, z, GLASS); }
  kit.reserve(x0, r.z0, x1, r.z1 - 1, 12, 'runway');
  kit.feature('runway', { team: kit.mirrored ? 'bravo' : 'alpha', minX: x0, maxX: x1, minZ: r.z0, maxZ: r.z1 - 1, y });
}

function helipad(kit, pad, y) {
  ring(kit, pad.x, pad.z, 0, pad.radius + 1, y, CONCRETE);
  ring(kit, pad.x, pad.z, pad.radius - 2, pad.radius - 1, y, PALE);
  const cx = Math.floor(pad.x), cz = Math.floor(pad.z);
  kit.box(cx - 3, y, cz - 4, cx - 2, y, cz + 4, PALE);
  kit.box(cx + 2, y, cz - 4, cx + 3, y, cz + 4, PALE);
  kit.box(cx - 1, y, cz - 1, cx + 1, y, cz, PALE);
  for (const [dx, dz] of [[pad.radius + 2, 0], [-pad.radius - 2, 0], [0, pad.radius + 2], [0, -pad.radius - 2]]) kit.set(cx + dx, y + 1, cz + dz, GLASS);
  const r = pad.radius + pad.rotorClearance;
  kit.reserve(cx - r + 4, cz - r + 4, cx + r - 4, cz + r - 4, 22, 'helipad');
}

/** Arched hangar open toward the taxiway, the team roundel on the east gable. */
function hangar(kit, y, palette) {
  const { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } = HQ_LAYOUT.hangar;
  kit.box(x0 - 14, y, z0 + 10, x0 - 1, y, z0 + 22, ASPHALT);              // taxiway to the strip
  kit.box(x0, y, z0, x1, y, z1, CONCRETE);
  const eave = y + 8, span = z1 - z0;
  const archTop = z => eave + Math.round(6 * Math.sin(Math.PI * (z - z0) / span));
  for (let z = z0; z <= z1; z++) {
    const top = archTop(z);
    kit.box(x0, top, z, x1, top, z, CORRUGATED_STEEL);
    if (z === z0 || z === z1) kit.box(x0, y + 1, z, x1, top, z, CORRUGATED_STEEL);
    kit.box(x1, y + 1, z, x1, top, z, CORRUGATED_STEEL);                  // east gable
    const prev = archTop(Math.max(z0, z - 1));
    if (prev !== top) kit.box(x0, Math.min(prev, top), z, x1, Math.max(prev, top), z, CORRUGATED_STEEL);
  }
  // Roof ribs, the open west door frame and a personnel door east.
  for (let x = x0; x <= x1; x += 6) for (let z = z0; z <= z1; z++) kit.set(x, archTop(z) + 1, z, METAL);
  kit.box(x0, eave + 6, z0, x0, eave + 6, z1, METAL);
  kit.box(x1, y + 1, ((z0 + z1) >> 1) - 1, x1, y + 3, (z0 + z1) >> 1, AIR);
  // Roundel: concentric rings on the east gable facing the valley.
  const rc = { y: y + HQ_LAYOUT.roundel.y, z: HQ_LAYOUT.roundel.z };
  for (let z = rc.z - 6; z <= rc.z + 6; z++) for (let yy = rc.y - 6; yy <= rc.y + 6; yy++) {
    const d = Math.hypot(z + 0.5 - rc.z - 0.5, yy + 0.5 - rc.y - 0.5);
    if (d > 6) continue;
    kit.set(x1 + 1, yy, z, d > 4.2 ? palette.outer : d > 2.2 ? palette.inner : palette.centre);
  }
  // Workshop furniture: benches, an engine stand, tool racks, crates.
  kit.box(x1 - 3, y + 1, z0 + 2, x1 - 1, y + 2, z0 + 8, METAL);
  kit.box(x1 - 3, y + 3, z0 + 2, x1 - 1, y + 3, z0 + 8, GLASS);
  kit.box(x0 + 10, y + 1, z1 - 3, x0 + 20, y + 1, z1 - 1, PLANK);
  kit.box(x0 + 14, y + 1, z0 + 12, x0 + 16, y + 3, z0 + 14, RUST);
  crateStack(kit, x0 + 24, z1 - 4, 3, 2, 2);
  kit.feature('building', { id: 'hq-hangar', minX: x0, minZ: z0, maxX: x1, maxZ: z1, floorY: y, eave, ridge: eave + 6, enterable: true });
  kit.feature('landmark', { id: kit.mirrored ? 'east-hq-hangar' : 'west-hq-hangar', x: (x0 + x1 + 1) / 2, y: eave + 6, z: (z0 + z1 + 1) / 2 });
}

function controlTower(kit, y) {
  const { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } = HQ_LAYOUT.tower;
  const mz = (z0 + z1) >> 1;
  kit.box(x0, y, z0, x1, y, z1, CONCRETE);
  kit.walls(x0, z0, x1, z1, y + 1, y + 12, PALE);
  kit.box(x1, y + 1, mz - 1, x1, y + 3, mz, AIR);                            // door toward the base
  for (const fy of [y + 4, y + 8]) { kit.box(x0 + 1, fy, z0 + 1, x1 - 1, fy, z1 - 1, PLANK); kit.box(x0 + 1, fy, mz - 1, x0 + 2, fy, mz + 1, AIR); }
  for (const wy of [y + 2, y + 6, y + 10]) for (let z = z0 + 2; z < z1 - 1; z += 3) kit.set(x1, wy, z, GLASS);
  // Glazed cab and roof.
  kit.box(x0 - 1, y + 13, z0 - 1, x1 + 1, y + 13, z1 + 1, CONCRETE);
  kit.walls(x0, z0, x1, z1, y + 14, y + 17, GLASS);
  for (const [cx, cz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) kit.box(cx, y + 14, cz, cx, y + 17, cz, METAL);
  kit.box(x0 - 1, y + 18, z0 - 1, x1 + 1, y + 18, z1 + 1, METAL);
  kit.box(x0 + 5, y + 19, z0 + 5, x0 + 5, y + 24, z0 + 5, METAL);
  kit.set(x0 + 5, y + 25, z0 + 5, ACCENT);
  kit.box(x0 + 2, y + 14, z0 + 2, x0 + 4, y + 14, z0 + 3, METAL);           // console
  // Exterior ladder up the west face into the cab.
  const l = hqTowerLadder(y);
  kit.box(x0 - 1, y + 1, l.minZ, x0 - 1, y + 14, l.minZ, METAL);
  kit.box(x0 - 1, y + 1, l.maxZ, x0 - 1, y + 14, l.maxZ, METAL);
  for (let yy = y + 2; yy <= y + 12; yy += 2) kit.set(x0 - 1, yy, mz, METAL);
  kit.box(x0, y + 13, mz, x0, y + 14, mz, AIR);
  kit.box(x0 - 2, y + 1, l.minZ, x0 - 2, y + 14, l.maxZ, AIR);
  kit.feature('building', { id: 'hq-control-tower', minX: x0, minZ: z0, maxX: x1, maxZ: z1, floorY: y, eave: y + 18, enterable: true });
}

function fuelFarm(kit, y) {
  const { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } = HQ_LAYOUT.fuel;
  kit.walls(x0, z0, x1, z1, y + 1, y + 1, CONCRETE);
  for (let i = 0; i < 3; i++) {
    const tz = z0 + 3 + i * 5;
    for (let x = x0 + 2; x <= x1 - 2; x++) kit.cylinderAlongX(x, y + 2.5, tz + 0.5, 1.6, PALE);
    kit.box(x0 + 2, y + 1, tz, x0 + 2, y + 1, tz, METAL);
  }
  kit.box(x1 - 1, y + 1, z1 - 1, x1 - 1, y + 3, z1 - 1, ACCENT);
}

function motorPool(kit, y) {
  const m = HQ_LAYOUT.motorPool;
  kit.box(m.minX, y, m.minZ, m.maxX, y, m.maxZ, CONCRETE);
  for (const p of [HQ_LAYOUT.jeep, HQ_LAYOUT.tank]) {
    const z = Math.floor(p.z);
    kit.box(m.minX + 2, y, z - 7, m.maxX - 2, y, z - 7, PALE);
    kit.box(Math.floor(p.x) - 6, y, z + 3 + (p === HQ_LAYOUT.tank ? 3 : 0), Math.floor(p.x) - 6, y, z + 3 + (p === HQ_LAYOUT.tank ? 3 : 0), PALE);
    kit.reserve(Math.floor(p.x) - 5, z - 5, Math.floor(p.x) + 5, z + 5, 6, 'motor bay');
  }
  // Workshop shed with a fuel bowser and tyre stack.
  const s = HQ_LAYOUT.shed;
  for (const [px, pz] of [[s.minX, s.minZ], [s.maxX, s.minZ], [s.minX, s.maxZ], [s.maxX, s.maxZ]]) kit.box(px, y + 1, pz, px, y + 4, pz, METAL);
  kit.box(s.minX, y + 1, s.maxZ, s.maxX, y + 4, s.maxZ, CORRUGATED_STEEL);
  kit.box(s.minX - 1, y + 5, s.minZ - 1, s.maxX + 1, y + 5, s.maxZ + 1, CORRUGATED_STEEL);
  kit.box(s.minX + 2, y + 1, s.minZ + 3, s.minX + 6, y + 2, s.minZ + 5, RUST);
  kit.box(s.maxX - 3, y + 1, s.maxZ - 3, s.maxX - 2, y + 2, s.maxZ - 2, METAL);
  kit.feature('building', { id: 'hq-motor-shed', minX: s.minX, minZ: s.minZ, maxX: s.maxX, maxZ: s.maxZ, floorY: y, eave: y + 5, enterable: true, open: true });
}

function commandBunker(kit, y) {
  const { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } = HQ_LAYOUT.bunker;
  kit.walls(x0, z0, x1, z1, y + 1, y + 4, CONCRETE);
  kit.box(x0, y + 5, z0, x1, y + 5, z1, CONCRETE);
  kit.box(x0 + 1, y + 6, z0 + 1, x1 - 1, y + 6, z1 - 1, BARRICADE);
  kit.box(x1, y + 1, ((z0 + z1) >> 1) - 1, x1, y + 3, (z0 + z1) >> 1, AIR);
  kit.box(x0 + 2, y + 1, z0 + 2, x0 + 6, y + 1, z0 + 4, PLANK);              // map table
  kit.box(x0 + 3, y + 2, z0 + 3, x0 + 5, y + 2, z0 + 3, PALE);
  for (let x = x0 + 2; x < x1 - 1; x += 4) kit.set(x, y + 3, z1, GLASS);
  kit.box(x0 + 2, y + 7, z0 + 2, x0 + 2, y + 12, z0 + 2, METAL);             // radio mast
  kit.feature('building', { id: 'hq-command-bunker', minX: x0, minZ: z0, maxX: x1, maxZ: z1, floorY: y, eave: y + 6, enterable: true, hard: true });
}

function aaPit(kit, p, y) {
  sandbags(kit, [[p.x - 4, p.z - 4], [p.x + 4, p.z - 4], [p.x + 4, p.z + 4], [p.x - 4, p.z + 4], [p.x - 4, p.z - 1]]);
  kit.box(p.x - 1, y + 1, p.z - 1, p.x + 1, y + 1, p.z + 1, METAL);
  kit.box(p.x, y + 2, p.z, p.x, y + 2, p.z, RUST);
  kit.line(p.x, y + 2, p.z, p.x + 3, y + 5, p.z - 3, METAL);
  kit.line(p.x + 1, y + 2, p.z, p.x + 4, y + 5, p.z - 3, METAL);
  crateStack(kit, p.x - 3, p.z + 2, 2, 1, 1, DUST_CRATE);
}

function buildHq(kit, team) {
  const y = FRONTIER_PLAN.heights.hqPlateau;
  const palette = PALETTES[team];
  runway(kit, y);
  for (const pad of HQ_LAYOUT.helipads) helipad(kit, pad, y);
  hangar(kit, y, palette);
  controlTower(kit, y);
  fuelFarm(kit, y);
  motorPool(kit, y);
  commandBunker(kit, y);
  for (const p of HQ_LAYOUT.aa) aaPit(kit, p, y);
  // Spawn court: painted stripe in team colour along the axis road edge.
  for (let x = 80; x <= 106; x++) { kit.set(x, y, 371, palette.stripe); kit.set(x, y, 396, palette.stripe); }
  // Windsock by the strip.
  kit.box(62, y + 1, 214, 62, y + 9, 214, METAL);
  for (let i = 0; i < 5; i++) kit.set(63 + i, y + 9 - (i >> 1), 214, i % 2 ? PALE : ACCENT);
  kit.box(60, y + 1, 318, 64, y + 1, 320, TIMBER);
  for (const [x, z] of HQ_LAYOUT.spawns) kit.reserve(Math.floor(x) - 1, Math.floor(z) - 1, Math.floor(x) + 1, Math.floor(z) + 1, 4, 'hq spawn');
}

export function buildAirfields(kit) {
  buildHq(kit, 'alpha');
  buildHq(mirroredKit(kit), 'bravo');
}
