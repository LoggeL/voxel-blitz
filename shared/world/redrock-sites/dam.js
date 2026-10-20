// Flag C, Redrock Dam (384, 384): a concrete gravity dam whose crest carries
// the paved axis over the river. North of it the reservoir laps the upstream
// face and two intake towers stand in the water; south of it the downstream
// face drops 14 m to the canyon floor, a stepped spillway cascades into the
// stream and buttress ribs give the canyon floor cover. An inspection gallery
// runs through the dam body between two portals on the canyon floor. The
// west abutment carries the control house (the hard point); the east one a
// turbine hall. Also builds the decks of the north bridge and the canyon
// trestle.

import {
  AIR, CONCRETE, METAL, RUST, PALE, GLASS, PLANK, MC_WATER, CORRUGATED_STEEL, ACCENT, BARRICADE, TIMBER,
  DUST_CRATE, ASPHALT,
} from '../blocks.js';
import { REDROCK_PLAN } from '../redrock-plan.js';
import {
  REDROCK_CROSSINGS, REDROCK_DAM, REDROCK_CELL_KIND as KIND, CANYON_FLOOR, NORTH_SURFACE, redrockTopY,
} from '../redrock-terrain.js';
import { rect, pickSpawnCells, wall } from './plan.js';
import { crateStack } from '../frontier-sites/props.js';
import { latticeTower } from './props.js';

const FLAG = REDROCK_PLAN.flags.find(f => f.id === 'C');
const SX = REDROCK_PLAN.dimensions.sx;
const CREST = REDROCK_DAM.crestY;
const CONTROL = rect(342, 404, 352, 414);
const TURBINE = rect(415, 404, 425, 414);
const INTAKES = [{ x: 372.5, z: 370.5 }, { x: 395.5, z: 370.5 }];
const INTAKE_TOP = 47;
const SPILLWAY = { x0: 376, x1: 391, z0: REDROCK_DAM.z1, steps: 14 };
const GALLERY = { y: 23, z0: 383, z1: 384, x0: 362, x1: 405, portals: [370, 396] };
const TANK_WEST = { x: 346.5, z: 395.5 }, TANK_EAST = { x: SX - 346.5, z: 395.5 };
const GANTRY = { x: 384, legs: [REDROCK_DAM.z0, REDROCK_DAM.z1 - 1], top: CREST + 9 };

let spawnCells = null;
export const DAM_SITE = Object.freeze({
  flag: 'C', site: 'dam', x: FLAG.x, z: FLAG.z,
  buildings: Object.freeze([CONTROL, TURBINE]),
  hard: CONTROL,
  landmarks: Object.freeze([
    Object.freeze({ id: 'redrock-dam-intakes', kind: 'intake tower', x: INTAKES[0].x, z: INTAKES[0].z, y: INTAKE_TOP, primary: true }),
    Object.freeze({ id: 'redrock-dam-gantry', kind: 'gantry crane', x: GANTRY.x, z: FLAG.z, y: GANTRY.top + 1 }),
  ]),
  // The C tank pad flips abutment with the owner: west for alpha, east for bravo.
  vehicle: Object.freeze({ id: 'flag-C-tank', type: 'tank', team: null, x: TANK_WEST.x, z: TANK_WEST.z, yaw: -Math.PI / 2,
    altX: TANK_EAST.x, altZ: TANK_EAST.z, altYaw: Math.PI / 2 }),
  gallery: Object.freeze({ ...GALLERY, portals: Object.freeze([...GALLERY.portals]) }),
  lanes: Object.freeze([
    Object.freeze({ id: 'C-gallery', from: [GALLERY.portals[0], REDROCK_DAM.z1], to: [GALLERY.portals[1], REDROCK_DAM.z1] }),
  ]),
  ambush: Object.freeze([
    Object.freeze({ x: 356.5, z: 392.5, faces: 'axis' }),
    Object.freeze({ x: 411.5, z: 392.5, faces: 'axis' }),
    Object.freeze({ x: 341.5, z: 376.5, faces: 'axis' }),
    Object.freeze({ x: 426.5, z: 376.5, faces: 'axis' }),
  ]),
  // On the abutments, level with the crest (y34): south of the crest clear of
  // the canyon rim, north of it clear of the reservoir shore. Six on each
  // abutment, so a breached dam (two abutments with the gap between) still
  // spawns both halves of C. They read the terrain, so they resolve on first
  // use (importing the site builds nothing).
  get spawns() {
    const side = sign => pickSpawnCells(FLAG.x, FLAG.z, {
      exclude: [CONTROL, TURBINE, rect(341, 390, 351, 400), rect(416, 390, 426, 400)],
      count: 6, radii: [27, 30, 34, 38, 42, 46, 48],
      accept: (x, z) => (x - FLAG.x) * sign > 0 && redrockTopY(x, z) >= CREST - 1
        && ((z > REDROCK_DAM.z1 + 2 && Math.abs(x - FLAG.x) > 25) || (z < REDROCK_DAM.z0 - 2 && Math.abs(x - FLAG.x) > 44)),
    });
    spawnCells ??= Object.freeze([...side(-1), ...side(1)]);
    return spawnCells;
  },
});

/** Dam body: concrete from the canyon floor to the crest, parapets and the gallery. */
function damBody(kit) {
  const { x0, x1, z0, z1 } = REDROCK_DAM;
  kit.box(x0, CANYON_FLOOR + 1, z0, x1 - 1, CREST - 1, z1 - 1, CONCRETE);
  // Crest roadway markings, parapets with lamp posts.
  for (let x = x0; x < x1; x++) {
    kit.set(x, CREST + 1, z0, CONCRETE);
    kit.set(x, CREST + 1, z1 - 1, CONCRETE);
    if ((x - x0) % 10 === 4) for (const z of [z0, z1 - 1]) { kit.box(x, CREST + 2, z, x, CREST + 4, z, METAL); kit.set(x, CREST + 5, z, GLASS); }
  }
  // Inspection gallery: a 2 x 3 tunnel through the body, two portals onto the canyon floor.
  const g = GALLERY;
  kit.box(g.x0, g.y + 1, g.z0, g.x1, g.y + 3, g.z1, AIR);
  kit.box(g.x0, g.y, g.z0, g.x1, g.y, g.z1, CONCRETE);
  for (const px of g.portals) {
    kit.box(px, g.y + 1, g.z1, px + 1, g.y + 3, z1 - 1, AIR);
    kit.box(px, g.y, g.z1, px + 1, g.y, z1 - 1, CONCRETE);
    kit.box(px - 1, g.y + 4, z1, px + 2, g.y + 4, z1, METAL);
  }
  for (let x = g.x0 + 3; x < g.x1; x += 8) kit.set(x, g.y + 3, g.z0 - 1, GLASS);
  // Buttress ribs on the downstream face (cover on the canyon floor).
  for (let x = x0 + 4; x < x1 - 4; x += 8) {
    if (x + 1 >= SPILLWAY.x0 - 1 && x <= SPILLWAY.x1 + 1) continue;
    if (GALLERY.portals.some(p => Math.abs(p - x) <= 2)) continue;
    for (let dz = 0; dz < 4; dz++) {
      const top = CREST - 2 - dz * 3, z = z1 + dz;
      const g0 = kit.top(x, z);
      if (top > g0) kit.box(x, g0 + 1, z, x + 1, top, z, CONCRETE);
    }
  }
  kit.feature('dam', { id: 'redrock-dam', ...REDROCK_DAM, gallery: GALLERY });
}

/** Stepped spillway: a concrete stair of water down the downstream face. */
function spillway(kit) {
  const s = SPILLWAY;
  for (let k = 0; k < s.steps; k++) {
    const z = s.z0 + k, top = CREST - 1 - k;
    for (let x = s.x0; x <= s.x1; x++) {
      const g = kit.top(x, z);
      if (top <= g) continue;
      kit.box(x, Math.max(1, g - 1), z, x, top, z, CONCRETE);
      if (x === s.x0 || x === s.x1) kit.set(x, top + 1, z, CONCRETE);
      else kit.set(x, top + 1, z, MC_WATER);
    }
  }
  // The weir notch in the crest parapet over the spillway.
  for (let x = s.x0 + 1; x < s.x1; x++) kit.set(x, CREST + 1, REDROCK_DAM.z1 - 1, MC_WATER);
  kit.feature('spillway', { x0: s.x0, x1: s.x1, z0: s.z0, z1: s.z0 + s.steps - 1 });
}

/** Intake towers in the reservoir with catwalks back to the crest. */
function intakes(kit) {
  for (const t of INTAKES) {
    const bed = Math.min(redrockTopY(t.x, t.z), NORTH_SURFACE - 2);
    kit.cylinder(t.x, t.z, 3.4, bed, INTAKE_TOP - 4, CONCRETE);
    kit.cylinder(t.x, t.z, 2.3, CREST + 1, INTAKE_TOP - 4, AIR);
    kit.cylinder(t.x, t.z, 3.8, INTAKE_TOP - 3, INTAKE_TOP - 3, CONCRETE);
    kit.cylinder(t.x, t.z, 3.4, INTAKE_TOP - 2, INTAKE_TOP - 1, PALE, true);
    kit.cylinder(t.x, t.z, 2.4, INTAKE_TOP, INTAKE_TOP, RUST);
    const cx = Math.floor(t.x), cz = Math.floor(t.z);
    kit.box(cx, CREST + 1, cz, cx, CREST + 1, cz, PLANK);
    for (const [dx, dz] of [[3, 0], [-3, 0], [0, -3]]) kit.box(cx + dx, CREST + 4, cz + dz, cx + dx, CREST + 5, cz + dz, GLASS);
    // Catwalk to the crest; the door faces the dam.
    kit.box(cx, CREST, cz + 3, cx + 1, CREST, REDROCK_DAM.z0 - 1, METAL);
    for (let z = cz + 4; z < REDROCK_DAM.z0; z++) { kit.set(cx - 1, CREST + 1, z, METAL); kit.set(cx + 2, CREST + 1, z, METAL); }
    kit.box(cx, CREST + 1, cz + 2, cx + 1, CREST + 3, cz + 3, AIR);
    kit.box(cx, CREST + 1, REDROCK_DAM.z0, cx + 1, CREST + 1, REDROCK_DAM.z0, AIR);
    // Trash racks on the upstream face at the waterline.
    kit.box(cx - 2, NORTH_SURFACE - 2, cz - 4, cx + 3, NORTH_SURFACE + 1, cz - 4, METAL);
    kit.box(cx, INTAKE_TOP + 1, cz, cx, INTAKE_TOP + 2, cz, METAL);
    kit.set(cx, INTAKE_TOP + 3, cz, ACCENT);
  }
  kit.feature('landmark', { id: 'redrock-dam-intakes', x: INTAKES[0].x, y: INTAKE_TOP, z: INTAKES[0].z });
}

/** A travelling gantry crane straddling the crest road (well above the 5 m headroom). */
function gantry(kit) {
  const x = GANTRY.x - 1, top = GANTRY.top;
  for (const z of GANTRY.legs) for (const dx of [0, 3]) kit.box(x + dx, CREST + 2, z, x + dx, top, z, RUST);
  kit.box(x, top + 1, GANTRY.legs[0], x + 3, top + 1, GANTRY.legs[1], RUST);
  kit.box(x + 1, top + 2, GANTRY.legs[0] + 2, x + 2, top + 3, GANTRY.legs[0] + 4, ACCENT);
  kit.line(x + 1, top, GANTRY.legs[0] + 3, x + 1, CREST + 8, GANTRY.legs[0] + 3, METAL);
  kit.feature('landmark', { id: 'redrock-dam-gantry', x: GANTRY.x, y: top + 1, z: FLAG.z });
}

function controlHouse(kit, r, { hard, label }) {
  const { minX: x0, minZ: z0, maxX: x1, maxZ: z1 } = r;
  const y = CREST;
  kit.foundation(x0, z0, x1, z1, y, CONCRETE);
  const eave = y + (hard ? 8 : 7);
  kit.walls(x0, z0, x1, z1, y + 1, eave, hard ? CONCRETE : CORRUGATED_STEEL);
  const mx = (x0 + x1) >> 1, mz = (z0 + z1) >> 1;
  kit.box(mx - 1, y + 1, z0, mx, y + 3, z0, AIR);                      // door to the crest
  kit.box(x0, y + 1, mz, x0, y + 3, mz + 1, AIR);
  kit.box(x1, y + 1, mz, x1, y + 3, mz + 1, AIR);
  for (let x = x0 + 2; x < x1 - 1; x += 3) { kit.box(x, y + 5, z0, x, y + 6, z0, GLASS); kit.box(x, y + 5, z1, x, y + 6, z1, GLASS); }
  if (hard) {
    kit.box(x0 + 1, y + 4, z0 + 1, x1 - 1, y + 4, z1 - 1, PLANK);
    kit.box(x1 - 3, y + 4, z1 - 3, x1 - 1, y + 4, z1 - 1, AIR);
    for (let s = 0; s < 3; s++) kit.box(x1 - 1 - s, y + 1, z1 - 3, x1 - 1 - s, y + 1 + s, z1 - 1, PLANK);
    kit.box(x0 + 2, y + 1, z0 + 2, x0 + 6, y + 2, z0 + 3, METAL);       // switchboards
    kit.box(x0 + 2, y + 3, z0 + 2, x0 + 6, y + 3, z0 + 2, GLASS);
    kit.box(x0, eave + 1, z0, x1, eave + 1, z1, CONCRETE);
    kit.walls(x0, z0, x1, z1, eave + 2, eave + 2, CONCRETE);
    kit.box(x0 + 2, eave + 3, z0 + 2, x0 + 2, eave + 9, z0 + 2, METAL);  // radio mast
  } else {
    kit.box(x0 + 2, y + 1, z0 + 3, x1 - 2, y + 3, z0 + 6, RUST);          // generator sets
    kit.gableRoof(x0 - 1, z0 - 1, x1 + 1, z1 + 1, eave + 1, 'z', CORRUGATED_STEEL);
  }
  kit.feature('building', { id: label, minX: x0, minZ: z0, maxX: x1, maxZ: z1, floorY: y, eave, ridge: eave + (hard ? 2 : 6), enterable: true, ...(hard ? { hard: true } : {}) });
}

/** Decks, railings and piers of the north bridge and the canyon trestle. */
function decks(kit) {
  const { kind } = kit.terrain;
  for (const c of REDROCK_CROSSINGS.filter(c => c.kind === 'bridge' && c.id !== 'redrock-dam')) {
    const deck = [];
    const r = c.halfSpan + c.width;
    for (let z = Math.floor(c.z - r); z <= Math.ceil(c.z + r); z++) for (let x = Math.floor(c.x - r); x <= Math.ceil(c.x + r); x++) {
      if (kind[z * kit.SX + x] === KIND.BRIDGE) deck.push([x, z]);
    }
    const isDeck = new Set(deck.map(([x, z]) => `${x},${z}`));
    const trestle = c.id === 'trestle';
    for (const [x, z] of deck) {
      kit.set(x, c.deckY, z, trestle ? PLANK : ASPHALT);
      kit.set(x, c.deckY - 1, z, METAL);
      kit.box(x, c.deckY + 1, z, x, c.deckY + 6, z, AIR);
    }
    for (const [x, z] of deck) for (const [dx, dz] of [[0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (isDeck.has(`${nx},${nz}`)) continue;
      if (kit.top(nx, nz) >= c.deckY) continue;
      kit.box(nx, c.deckY - 1, nz, nx, c.deckY, nz, METAL);
      kit.set(nx, c.deckY + 1, nz, (nx % 3) ? METAL : RUST);
    }
    // Piers: the trestle stands on steel bents to the canyon floor every six
    // metres, cross-braced; the north bridge on two concrete piers.
    const bents = new Map();
    for (const [x, z] of deck) {
      if (trestle ? (x - Math.floor(c.x - c.halfSpan)) % 6 !== 3 : Math.abs(x + 0.5 - c.x) > 1) continue;
      if (!bents.has(x)) bents.set(x, []);
      bents.get(x).push(z);
    }
    for (const [x, zs] of bents) {
      const zMin = Math.min(...zs), zMax = Math.max(...zs);
      for (const z of trestle ? [zMin, zMax] : zs) {
        if ((z - zMin) % 2 && !trestle) continue;
        const g = Math.max(1, kit.terrain.ground[z * kit.SX + x]);
        kit.box(x, g - 1, z, x, c.deckY - 2, z, trestle ? RUST : CONCRETE);
      }
      if (trestle) {
        const g = Math.max(1, Math.min(...zs.map(z => kit.terrain.ground[z * kit.SX + x])));
        for (let y = g + 2; y < c.deckY - 2; y += 4) {
          kit.line(x, y, zMin, x, y + 3, zMax, METAL);
          kit.line(x, y + 3, zMin, x, y, zMax, METAL);
        }
      }
    }
    kit.feature('bridge', { id: c.id, x: c.x, z: c.z, deckY: c.deckY, cells: deck.length, deck: trestle ? 'trestle' : 'girder' });
  }
}

export function buildDamSite(kit) {
  decks(kit);
  damBody(kit);
  spillway(kit);
  intakes(kit);
  gantry(kit);
  controlHouse(kit, CONTROL, { hard: true, label: 'redrock-dam-control-house' });
  kit.feature('hard-building', { flag: 'C', id: 'redrock-dam-control-house', ...CONTROL });
  controlHouse(kit, TURBINE, { hard: false, label: 'redrock-dam-turbine-hall' });
  // Sandbagged abutments and jersey barriers beside the crest.
  wall(kit, [[335, 377], [343, 377]], 2, BARRICADE, { kind: 'sandbags' });
  wall(kit, [[SX - 343, 377], [SX - 335, 377]], 2, BARRICADE, { kind: 'sandbags' });
  wall(kit, [[354, 391], [354, 400]], 2, BARRICADE, { kind: 'sandbags' });
  wall(kit, [[SX - 354, 391], [SX - 354, 400]], 2, BARRICADE, { kind: 'sandbags' });
  wall(kit, [[338, 418], [356, 418]], 2, CONCRETE, { gapEvery: 7, kind: 'jersey barrier' });
  wall(kit, [[SX - 356, 418], [SX - 338, 418]], 2, CONCRETE, { gapEvery: 7, kind: 'jersey barrier' });
  crateStack(kit, 357, 410, 2, 2, 2, DUST_CRATE);
  crateStack(kit, SX - 359, 410, 2, 2, 2, TIMBER);
  // A pylon line from the turbine hall east over the rim.
  latticeTower(kit, 432, 412, CREST + 1, 16, 2, { leg: METAL, brace: METAL });
  for (const lane of DAM_SITE.lanes) kit.feature('lane', { flag: 'C', ...lane });
  for (const a of DAM_SITE.ambush) kit.feature('ambush', { flag: 'C', ...a });
  for (const p of [TANK_WEST, TANK_EAST]) kit.reserve(p.x - 4.5, p.z - 4.5, p.x + 3.5, p.z + 3.5, 5, 'flag-C-tank');
}
