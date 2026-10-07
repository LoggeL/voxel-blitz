// Frontier v2 layout and map metadata (spec 3.2 and 4.4). Pure data derived
// from FRONTIER_PLAN, the terrain heightfield and the site modules: every y is
// read from the terrain (feet = top voxel + 1.02), never a constant. No voxels
// are built here, so the server can publish mapMeta before allocating a world.
// shared/world/frontier-layout.js re-exports this module.

import { FRONTIER_PLAN } from '../../conquest-contract.js';
import { FRONTIER_DIMENSIONS } from '../dimensions.js';
import {
  FRONTIER_ROAD_PLAN, FRONTIER_CROSSINGS, frontierTopY, frontierSurfaceY,
} from '../frontier-terrain.js';
import { FARM_SITE } from './farm.js';
import { VILLAGE_SITE } from './village.js';
import { BRIDGE_SITE } from './bridge.js';
import { BUNKERS_SITE, OBSERVATION_TOWER, observationTowerLadder } from './bunkers.js';
import { WORKS_SITE } from './works.js';
import { HQ_LAYOUT, hqTowerLadder } from './hq-airfield.js';
import { frontierWrecks } from './dressing.js';
import { FRONTIER_LOCATIONS } from './locations.js';

export { frontierSurfaceY };

const { sx: SX, sz: SZ } = FRONTIER_PLAN.dimensions;
const FEET = 1.02;
const round2 = v => Math.round(v * 100) / 100;
/** Feet position on the terrain at continuous (x, z). */
export const feet = (x, z) => Object.freeze({ x, y: round2(frontierTopY(x, z) + FEET), z });
const mirrorFeet = p => feet(SX - p.x, SZ - p.z);
const mirrorYaw = yaw => Math.atan2(Math.sin(yaw + Math.PI), Math.cos(yaw + Math.PI));
const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
};

/** Flag sites in A..E order. */
export const FRONTIER_SITES = Object.freeze([FARM_SITE, VILLAGE_SITE, BRIDGE_SITE, BUNKERS_SITE, WORKS_SITE]);

// ------------------------------------------------------------------- flags

function buildFlags() {
  return FRONTIER_PLAN.flags.map(f => {
    const site = FRONTIER_SITES.find(s => s.flag === f.id);
    return {
      id: f.id, name: f.name, site: f.site, ...feet(f.x, f.z), radius: f.radius, home: f.home,
      spawns: site.spawns.map(([x, z]) => feet(x, z)),
    };
  });
}

// ------------------------------------------------------------------- bases

const BASE_NAMES = { alpha: 'West HQ', bravo: 'East HQ' };
function buildBases() {
  const out = {};
  for (const team of ['alpha', 'bravo']) {
    const hq = FRONTIER_PLAN.hqs[team];
    const spawns = HQ_LAYOUT.spawns.map(([x, z]) => (team === 'alpha' ? feet(x, z) : mirrorFeet({ x, z })));
    out[team] = { id: team, name: BASE_NAMES[team] ?? hq.name, ...feet(hq.x, hq.z), radius: hq.radius, spawns };
  }
  return out;
}

// ---------------------------------------------------------------- airfields

/** Alpha-frame airfield; bravo is produced by mirroring every coordinate. */
function alphaAirfield() {
  const r = HQ_LAYOUT.runway, y = round2(frontierTopY(r.x, (r.z0 + r.z1) / 2) + FEET);
  const p = (x, z) => ({ ...feet(x, z) });
  const runway = {
    x: r.x, y, z0: r.z0, z1: r.z1, width: r.width, length: r.z1 - r.z0, yaw: 0,
    takeoffStart: p(r.x, r.takeoffStartZ), takeoffEnd: p(r.x, r.takeoffEndZ),
    approach: { minX: r.x - r.width / 2 - 5, maxX: r.x + r.width / 2 + 5, minZ: r.z0 - 90, maxZ: r.z1 + 4 },
  };
  const helipads = HQ_LAYOUT.helipads.map(h => ({ ...p(h.x, h.z), radius: h.radius, rotorClearance: h.rotorClearance }));
  const base = p(HQ_LAYOUT.base.x, HQ_LAYOUT.base.z);
  const hangar = HQ_LAYOUT.hangar, tower = HQ_LAYOUT.tower, fuel = HQ_LAYOUT.fuel;
  const centre = rect => ({ x: (rect.minX + rect.maxX + 1) / 2, z: (rect.minZ + rect.maxZ + 1) / 2, w: rect.maxX - rect.minX + 1, d: rect.maxZ - rect.minZ + 1 });
  const towerEntrance = p(tower.maxX + 2.5, ((tower.minZ + tower.maxZ) >> 1) + 0.5);
  const walkingRoutes = vehicleWalkingRoutes(base);
  return {
    runway, runways: [runway],
    helipad: helipads[0], helipads,
    motorBays: [
      { id: 'jeep', ...p(HQ_LAYOUT.jeep.x, HQ_LAYOUT.jeep.z), width: 10, depth: 10 },
      { id: 'tank', ...p(HQ_LAYOUT.tank.x, HQ_LAYOUT.tank.z), width: 10, depth: 10 },
    ],
    hangars: [{ id: 'hangar', ...centre(hangar), height: 14, entrance: p(hangar.minX - 4, (hangar.minZ + hangar.maxZ + 1) / 2), kind: 'aircraft hangar' }],
    tower: { ...centre(tower), height: 25, entrance: towerEntrance, ladder: hqTowerLadder(frontierTopY(tower.minX + 1, tower.minZ + 1)) },
    fuelFarm: centre(fuel),
    taxiways: [[p(r.x + r.width / 2, (hangar.minZ + hangar.maxZ + 1) / 2), p(hangar.minX, (hangar.minZ + hangar.maxZ + 1) / 2)]],
    walkingRoutes: Object.values(walkingRoutes),
    routesByVehicle: walkingRoutes,
  };
}

/** Infantry pickup routes from the HQ road head to each HQ vehicle (alpha frame). */
function vehicleWalkingRoutes(base) {
  const p = (x, z) => ({ ...feet(x, z) });
  const b = p(base.x, base.z);
  const [heli, transport] = HQ_LAYOUT.helipads;
  const jeep = HQ_LAYOUT.jeep, tank = HQ_LAYOUT.tank, r = HQ_LAYOUT.runway;
  return {
    jeep: [b, p(110.5, base.z), p(110.5, jeep.z), p(jeep.x - 3.2, jeep.z)],
    tank: [b, p(110.5, base.z), p(110.5, tank.z), p(tank.x - 4.1, tank.z)],
    helicopter: [b, p(110.5, base.z), p(110.5, heli.z + 14), p(heli.x, heli.z + 5)],
    transport: [b, p(110.5, base.z), p(110.5, transport.z - 14), p(transport.x, transport.z - 5.5)],
    plane: [b, p(62.5, base.z), p(62.5, r.takeoffStartZ), p(r.x + 6.5, r.takeoffStartZ)],
  };
}

function mirrorAirfield(field) {
  const pt = q => {
    const x = SX - q.x, z = SZ - q.z;
    return Number.isFinite(q.y) ? { ...q, ...feet(x, z) } : { ...q, x, z };
  };
  const runway = r => ({
    ...r, x: SX - r.x, z0: SZ - r.z1, z1: SZ - r.z0, yaw: Math.PI,
    takeoffStart: pt(r.takeoffStart), takeoffEnd: pt(r.takeoffEnd),
    approach: { minX: SX - r.approach.maxX, maxX: SX - r.approach.minX, minZ: SZ - r.approach.maxZ, maxZ: SZ - r.approach.minZ },
  });
  const ladder = l => ({ ...l, minX: SX - l.maxX, maxX: SX - l.minX, minZ: SZ - l.maxZ, maxZ: SZ - l.minZ, face: l.face === 'x-' ? 'x+' : 'x-' });
  const runways = field.runways.map(runway);
  const helipads = field.helipads.map(pt);
  const routesByVehicle = Object.fromEntries(Object.entries(field.routesByVehicle).map(([k, route]) => [k, route.map(pt)]));
  return {
    runway: runways[0], runways, helipad: helipads[0], helipads,
    motorBays: field.motorBays.map(pt),
    hangars: field.hangars.map(h => ({ ...pt(h), entrance: pt(h.entrance) })),
    tower: { ...pt(field.tower), entrance: pt(field.tower.entrance), ladder: ladder(field.tower.ladder) },
    fuelFarm: pt(field.fuelFarm),
    taxiways: field.taxiways.map(t => t.map(pt)),
    walkingRoutes: Object.values(routesByVehicle),
    routesByVehicle,
  };
}

function buildAirfields() {
  const alpha = alphaAirfield();
  const fields = { alpha, bravo: mirrorAirfield(alpha) };
  return ['alpha', 'bravo'].map(team => {
    const f = fields[team];
    return {
      id: `${team}-airfield`, team, name: team === 'alpha' ? 'West airfield' : 'East airfield',
      ...f,
      motorBays: f.motorBays.map(bay => ({ ...bay, id: `${team}-${bay.id}` })),
      hangars: f.hangars.map(h => ({ ...h, id: `${team}-${h.id}` })),
    };
  });
}

// ----------------------------------------------------------------- vehicles

function buildVehicleSpawns(airfields) {
  const spawns = [];
  const yawFor = (team, yaw) => (team === 'alpha' ? yaw : mirrorYaw(yaw));
  for (const field of airfields) {
    const team = field.team, routes = field.routesByVehicle;
    const hqPos = (alphaPos) => (team === 'alpha' ? feet(alphaPos.x, alphaPos.z) : mirrorFeet(alphaPos));
    for (const type of ['jeep', 'tank']) {
      const pad = HQ_LAYOUT[type], at = hqPos(pad);
      // Drive east out of the motor pool, then north onto the paved axis.
      const out = hqPos({ x: pad.x + 12, z: pad.z }), road = hqPos({ x: pad.x + 12, z: HQ_LAYOUT.base.z });
      spawns.push({ id: `${team}-${type}`, team, type, ...at, yaw: yawFor(team, pad.yaw),
        walkingRoute: routes[type], exitRoute: [at, out, road] });
    }
    const [heliPad, transportPad] = field.helipads;
    spawns.push({ id: `${team}-helicopter`, team, type: 'helicopter', ...feet(heliPad.x, heliPad.z), yaw: yawFor(team, -Math.PI / 2), walkingRoute: routes.helicopter });
    spawns.push({ id: `${team}-transport`, team, type: 'transport', ...feet(transportPad.x, transportPad.z), yaw: yawFor(team, -Math.PI / 2), walkingRoute: routes.transport });
    spawns.push({ id: `${team}-plane`, team, type: 'plane', ...feet(field.runway.takeoffStart.x, field.runway.takeoffStart.z), yaw: field.runway.yaw, walkingRoute: routes.plane });
  }
  for (const site of FRONTIER_SITES) {
    const v = site.vehicle;
    const entry = { id: v.id, team: v.team, type: v.type, ...feet(v.x, v.z), yaw: v.yaw, flag: site.flag };
    if (Number.isFinite(v.altX)) Object.assign(entry, { altX: v.altX, altY: round2(frontierTopY(v.altX, v.altZ) + FEET), altZ: v.altZ, altYaw: v.altYaw });
    spawns.push(entry);
  }
  return spawns;
}

// -------------------------------------------------------------- roads, etc.

/** Road centrelines resampled every <= 10 m, keeping the authored vertices. */
function buildRoads() {
  return FRONTIER_ROAD_PLAN.map(road => {
    const points = [];
    for (let i = 0; i < road.points.length; i++) {
      const [x, z] = road.points[i];
      if (i) {
        const [px, pz] = road.points[i - 1];
        const n = Math.ceil(Math.hypot(x - px, z - pz) / 10);
        for (let k = 1; k < n; k++) {
          const t = k / n, ix = round2(px + (x - px) * t), iz = round2(pz + (z - pz) * t);
          points.push([ix, round2(frontierTopY(ix, iz) + FEET), iz]);
        }
      }
      points.push([x, round2(frontierTopY(x, z) + FEET), z]);
    }
    return { id: road.id, kind: road.kind, width: road.width, points };
  });
}

function buildCrossings() {
  return FRONTIER_CROSSINGS.map(c => ({
    id: c.id, kind: c.kind, x: c.x, y: round2((c.kind === 'bridge' ? c.deckY : c.bedY) + FEET), z: c.z, width: c.width,
  }));
}

/** Site landmark tops (y from the terrain plus each structure's rise). */
function buildLandmarks(flags) {
  const tops = [];
  for (const site of FRONTIER_SITES) {
    for (const l of site.landmarks) {
      const y = Number.isFinite(l.y) ? l.y : frontierTopY(l.x, l.z) + l.rise;
      tops.push({ id: l.id, kind: l.kind, flag: site.flag, x: l.x, y, z: l.z, ...(l.primary ? { primary: true } : {}) });
    }
  }
  // The hangar ridge stands 14 voxels above the plateau floor.
  const hangar = HQ_LAYOUT.hangar;
  const hx = (hangar.minX + hangar.maxX + 1) / 2, hz = (hangar.minZ + hangar.maxZ + 1) / 2;
  tops.push({ id: 'west-hq-hangar', kind: 'hangar', x: hx, y: frontierTopY(hx, hz) + 14, z: hz });
  tops.push({ id: 'east-hq-hangar', kind: 'hangar', x: SX - hx, y: frontierTopY(SX - hx, SZ - hz) + 14, z: SZ - hz });
  // The places between the flags: a named row (kind 'place', for map labels)
  // and the landmark top that names its place.
  const places = FRONTIER_LOCATIONS.map(l => ({ id: l.id, kind: 'place', name: l.name, ...feet(l.x, l.z), ...(Number.isFinite(l.floorY) ? { y: l.floorY + FEET } : {}) }));
  for (const l of FRONTIER_LOCATIONS) tops.push({ id: l.landmark.id, kind: l.landmark.kind, place: l.id, x: l.landmark.x, y: l.landmark.y, z: l.landmark.z });
  return [
    ...flags.map(f => ({ id: f.id, kind: 'flag', name: f.name, x: f.x, y: f.y, z: f.z, radius: f.radius })),
    ...places,
    ...tops,
  ];
}

function buildDressing() {
  return frontierWrecks().map(w => ({ id: w.id, kind: 'wreck', type: w.type, near: w.near, x: w.smokeX, y: w.y, z: w.smokeZ }));
}

// ------------------------------------------------------------ the bundle

let bundle = null;
function frontierBundle() {
  if (bundle) return bundle;
  const flags = buildFlags();
  const bases = buildBases();
  const airfields = buildAirfields();
  const vehicleSpawns = buildVehicleSpawns(airfields);
  for (const field of airfields) delete field.routesByVehicle;
  const conquest = {
    version: 2,
    flags, bases,
    combatArea: { ...FRONTIER_PLAN.combatArea },
    vehicleSpawns,
    airfields,
    roads: buildRoads(),
    crossings: buildCrossings(),
    weather: 'golden',
    dressing: buildDressing(),
  };
  const towerTop = frontierTopY(OBSERVATION_TOWER.x, OBSERVATION_TOWER.z);
  const ladders = [
    ...airfields.map(f => f.tower.ladder),
    observationTowerLadder(towerTop),
  ];
  bundle = deepFreeze({ conquest, landmarks: buildLandmarks(flags), ladders });
  return bundle;
}

/** Road polylines `[[x, z], ...]` (authored control points). */
export const FRONTIER_ROADS = Object.freeze(FRONTIER_ROAD_PLAN.map(r => Object.freeze(r.points.map(p => Object.freeze([p[0], p[1]])))));

/** Lazily derived (terrain build on first use) but stable, frozen objects. */
export const FRONTIER_LAYOUT = Object.freeze({
  get conquest() { return frontierBundle().conquest; },
  get airfields() { return frontierBundle().conquest.airfields; },
  get landmarks() { return frontierBundle().landmarks; },
  get ladders() { return frontierBundle().ladders; },
});

/** Map metadata for Frontier v2 (spec 3.2). Static: no voxel world needed. */
export function createFrontierMetadata() {
  const { conquest, landmarks, ladders } = frontierBundle();
  const teams = { alpha: conquest.bases.alpha.spawns, bravo: conquest.bases.bravo.spawns };
  return {
    id: 'frontier', name: 'Frontier', dimensions: FRONTIER_DIMENSIONS, modes: ['conquest'],
    navigation: { mode: 'surface', cell: 4, maxStep: 1 },
    navigationFloor: null,
    groundLevel: FRONTIER_PLAN.heights.valleyMin,
    spawnBounds: { minX: 24, maxX: 743, minZ: 24, maxZ: 743, minY: 20, maxY: 79 },
    conquest: structuredClone(conquest),
    spawns: { fun: [...teams.alpha, ...teams.bravo], tdm: teams, snd: { attackers: teams.alpha, defenders: teams.bravo }, conquest: teams },
    ladders: structuredClone(ladders), sites: [], traps: [], landmarks: structuredClone(landmarks), dummyPosts: [], course: null,
  };
}

/**
 * Cells the generator must leave open after every set piece: each spawn
 * cell with its neighbours, every vehicle pad footprint and the runway and
 * helipads (those are reserved by the HQ builder itself).
 */
export function frontierReservedCells() {
  const { conquest } = frontierBundle();
  const cells = [];
  const around = (p, r, height, label) => cells.push({
    minX: Math.floor(p.x - r), maxX: Math.floor(p.x + r), minZ: Math.floor(p.z - r), maxZ: Math.floor(p.z + r), height, label,
  });
  for (const f of conquest.flags) for (const s of f.spawns) around(s, 1, 3, `spawn ${f.id}`);
  for (const b of Object.values(conquest.bases)) for (const s of b.spawns) around(s, 1, 4, `spawn ${b.id}`);
  for (const v of conquest.vehicleSpawns) {
    const r = v.type === 'tank' ? 4.5 : v.type === 'jeep' ? 3.5 : 0;
    if (!r) continue;
    around(v, r, 5, v.id);
    if (Number.isFinite(v.altX)) around({ x: v.altX, z: v.altZ }, r, 5, `${v.id} alt`);
  }
  return cells;
}

