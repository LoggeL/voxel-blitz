// Redrock Canyon layout and map metadata: the Redrock twin of
// shared/world/frontier-sites/layout.js. Pure data derived from REDROCK_PLAN,
// the terrain heightfield and the site modules; every y is read from the
// terrain (feet = top voxel + 1.02). No voxels are built here, so the server
// can publish mapMeta before allocating a world.
//
// The HQs (airfields, motor pools, HQ spawns) are Frontier's HQ_LAYOUT,
// point-mirrored for bravo exactly as on Frontier (the plateaus are the same
// rectangles); the flags, roads and places are mirror-symmetric about x = 384.

import { REDROCK_PLAN } from '../redrock-plan.js';
import { REDROCK_ROAD_PLAN, REDROCK_CROSSINGS, redrockTopY, redrockSurfaceY } from '../redrock-terrain.js';
import { HQ_LAYOUT, hqTowerLadder } from '../frontier-sites/hq-airfield.js';
import { OASIS_SITE } from './oasis.js';
import { MINE_SITE } from './mine.js';
import { DAM_SITE } from './dam.js';
import { RADAR_SITE } from './radar.js';
import { RAILHEAD_SITE } from './railhead.js';
import { REDROCK_LOCATIONS } from './locations.js';

export { redrockSurfaceY };

export const REDROCK_DIMENSIONS = REDROCK_PLAN.dimensions;
const { sx: SX, sz: SZ } = REDROCK_PLAN.dimensions;
const FEET = 1.02;
const round2 = v => Math.round(v * 100) / 100;
/** Feet position on the terrain at continuous (x, z). */
export const feet = (x, z) => Object.freeze({ x, y: round2(redrockTopY(x, z) + FEET), z });
const pointMirrorFeet = p => feet(SX - p.x, SZ - p.z);
const pointMirrorYaw = yaw => Math.atan2(Math.sin(yaw + Math.PI), Math.cos(yaw + Math.PI));
const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
};

/** Flag sites in A..E order. */
export const REDROCK_SITES = Object.freeze([OASIS_SITE, MINE_SITE, DAM_SITE, RADAR_SITE, RAILHEAD_SITE]);

function buildFlags() {
  return REDROCK_PLAN.flags.map(f => {
    const site = REDROCK_SITES.find(s => s.flag === f.id);
    return {
      id: f.id, name: f.name, site: f.site, ...feet(f.x, f.z), radius: f.radius, home: f.home,
      spawns: site.spawns.map(([x, z]) => feet(x, z)),
    };
  });
}

function buildBases() {
  const out = {};
  for (const team of ['alpha', 'bravo']) {
    const hq = REDROCK_PLAN.hqs[team];
    const spawns = HQ_LAYOUT.spawns.map(([x, z]) => (team === 'alpha' ? feet(x, z) : pointMirrorFeet({ x, z })));
    out[team] = { id: team, name: hq.name, ...feet(hq.x, hq.z), radius: hq.radius, spawns };
  }
  return out;
}

// ---------------------------------------------------------------- airfields

function alphaAirfield() {
  const r = HQ_LAYOUT.runway, y = round2(redrockTopY(r.x, (r.z0 + r.z1) / 2) + FEET);
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
    tower: { ...centre(tower), height: 25, entrance: towerEntrance, ladder: hqTowerLadder(redrockTopY(tower.minX + 1, tower.minZ + 1)) },
    fuelFarm: centre(fuel),
    taxiways: [[p(r.x + r.width / 2, (hangar.minZ + hangar.maxZ + 1) / 2), p(hangar.minX, (hangar.minZ + hangar.maxZ + 1) / 2)]],
    walkingRoutes: Object.values(walkingRoutes),
    routesByVehicle: walkingRoutes,
  };
}

function vehicleWalkingRoutes(base) {
  const p = (x, z) => ({ ...feet(x, z) });
  const b = p(base.x, base.z);
  const [heli, transport] = HQ_LAYOUT.helipads;
  const jeep = HQ_LAYOUT.jeep, tank = HQ_LAYOUT.tank, jeepAt = HQ_LAYOUT.jeep_at, aa = HQ_LAYOUT.aaVehicle, r = HQ_LAYOUT.runway;
  return {
    jeep: [b, p(110.5, base.z), p(110.5, jeep.z), p(jeep.x - 3.2, jeep.z)],
    tank: [b, p(110.5, base.z), p(110.5, tank.z), p(tank.x - 4.1, tank.z)],
    jeep_at: [b, p(110.5, base.z), p(110.5, jeepAt.z), p(jeepAt.x - 3.2, jeepAt.z)],
    aa: [b, p(110.5, base.z), p(110.5, aa.z), p(aa.x - 4.1, aa.z)],
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
  const yawFor = (team, yaw) => (team === 'alpha' ? yaw : pointMirrorYaw(yaw));
  for (const field of airfields) {
    const team = field.team, routes = field.routesByVehicle;
    const hqPos = alphaPos => (team === 'alpha' ? feet(alphaPos.x, alphaPos.z) : pointMirrorFeet(alphaPos));
    // The mobile AA parks in the motor pool's south bay, as on Frontier (HQ_LAYOUT.aaVehicle).
    for (const type of ['jeep', 'tank', 'jeep_at', 'aa']) {
      const pad = type === 'aa' ? HQ_LAYOUT.aaVehicle : HQ_LAYOUT[type], at = hqPos(pad);
      const out = hqPos({ x: pad.x + 12, z: pad.z }), road = hqPos({ x: pad.x + 12, z: HQ_LAYOUT.base.z });
      spawns.push({ id: `${team}-${type}`, team, type, ...at, yaw: yawFor(team, pad.yaw),
        walkingRoute: routes[type], exitRoute: [at, out, road] });
    }
    const [heliPad, transportPad] = field.helipads;
    spawns.push({ id: `${team}-helicopter`, team, type: 'helicopter', ...feet(heliPad.x, heliPad.z), yaw: yawFor(team, -Math.PI / 2), walkingRoute: routes.helicopter });
    spawns.push({ id: `${team}-transport`, team, type: 'transport', ...feet(transportPad.x, transportPad.z), yaw: yawFor(team, -Math.PI / 2), walkingRoute: routes.transport });
    spawns.push({ id: `${team}-plane`, team, type: 'plane', ...feet(field.runway.takeoffStart.x, field.runway.takeoffStart.z), yaw: field.runway.yaw, walkingRoute: routes.plane });
  }
  for (const site of REDROCK_SITES) {
    const v = site.vehicle;
    const entry = { id: v.id, team: v.team, type: v.type, ...feet(v.x, v.z), yaw: v.yaw, flag: site.flag };
    if (Number.isFinite(v.altX)) Object.assign(entry, { altX: v.altX, altY: round2(redrockTopY(v.altX, v.altZ) + FEET), altZ: v.altZ, altYaw: v.altYaw });
    spawns.push(entry);
  }
  return spawns;
}

// -------------------------------------------------------------- roads, etc.

function buildRoads() {
  return REDROCK_ROAD_PLAN.map(road => {
    const points = [];
    for (let i = 0; i < road.points.length; i++) {
      const [x, z] = road.points[i];
      if (i) {
        const [px, pz] = road.points[i - 1];
        const n = Math.ceil(Math.hypot(x - px, z - pz) / 10);
        for (let k = 1; k < n; k++) {
          const t = k / n, ix = round2(px + (x - px) * t), iz = round2(pz + (z - pz) * t);
          points.push([ix, round2(redrockTopY(ix, iz) + FEET), iz]);
        }
      }
      points.push([x, round2(redrockTopY(x, z) + FEET), z]);
    }
    return { id: road.id, kind: road.kind, width: road.width, points };
  });
}

function buildCrossings() {
  return REDROCK_CROSSINGS.map(c => ({
    id: c.id, kind: c.kind, x: c.x, y: round2((c.kind === 'bridge' ? c.deckY : c.bedY) + FEET), z: c.z, width: c.width,
  }));
}

function buildLandmarks(flags) {
  const tops = [];
  for (const site of REDROCK_SITES) {
    for (const l of site.landmarks) {
      const y = Number.isFinite(l.y) ? l.y : redrockTopY(l.x, l.z) + l.rise;
      tops.push({ id: l.id, kind: l.kind, flag: site.flag, x: l.x, y, z: l.z, ...(l.primary ? { primary: true } : {}) });
    }
  }
  const hangar = HQ_LAYOUT.hangar;
  const hx = (hangar.minX + hangar.maxX + 1) / 2, hz = (hangar.minZ + hangar.maxZ + 1) / 2;
  tops.push({ id: 'west-hq-hangar', kind: 'hangar', x: hx, y: redrockTopY(hx, hz) + 14, z: hz });
  tops.push({ id: 'east-hq-hangar', kind: 'hangar', x: SX - hx, y: redrockTopY(SX - hx, SZ - hz) + 14, z: SZ - hz });
  const places = REDROCK_LOCATIONS.map(l => ({ id: l.id, kind: 'place', name: l.name, ...feet(l.x, l.z) }));
  for (const l of REDROCK_LOCATIONS) tops.push({ id: l.landmark.id, kind: l.landmark.kind, place: l.id, x: l.landmark.x, y: l.landmark.y, z: l.landmark.z });
  return [
    ...flags.map(f => ({ id: f.id, kind: 'flag', name: f.name, x: f.x, y: f.y, z: f.z, radius: f.radius })),
    ...places,
    ...tops,
  ];
}

// ------------------------------------------------------------ the bundle

let bundle = null;
function redrockBundle() {
  if (bundle) return bundle;
  const flags = buildFlags();
  const bases = buildBases();
  const airfields = buildAirfields();
  const vehicleSpawns = buildVehicleSpawns(airfields);
  for (const field of airfields) delete field.routesByVehicle;
  const conquest = {
    version: 2,
    flags, bases,
    combatArea: { ...REDROCK_PLAN.combatArea },
    vehicleSpawns,
    airfields,
    roads: buildRoads(),
    crossings: buildCrossings(),
    weather: 'desert',
    dressing: [],
  };
  const ladders = airfields.map(f => f.tower.ladder);
  bundle = deepFreeze({ conquest, landmarks: buildLandmarks(flags), ladders });
  return bundle;
}

/** Lazily derived (terrain build on first use) but stable, frozen objects. */
export const REDROCK_LAYOUT = Object.freeze({
  get conquest() { return redrockBundle().conquest; },
  get airfields() { return redrockBundle().conquest.airfields; },
  get landmarks() { return redrockBundle().landmarks; },
  get ladders() { return redrockBundle().ladders; },
});

/** Map metadata for Redrock Canyon. Static: no voxel world needed. */
export function createRedrockMetadata() {
  const { conquest, landmarks, ladders } = redrockBundle();
  const teams = { alpha: conquest.bases.alpha.spawns, bravo: conquest.bases.bravo.spawns };
  return {
    id: 'redrock', name: 'Redrock Canyon', dimensions: REDROCK_DIMENSIONS, modes: ['conquest'],
    navigation: { mode: 'surface', cell: 4, maxStep: 1 },
    navigationFloor: null,
    groundLevel: REDROCK_PLAN.heights.plainMin,
    spawnBounds: { minX: 24, maxX: 743, minZ: 24, maxZ: 743, minY: 18, maxY: 79 },
    conquest: structuredClone(conquest),
    spawns: { fun: [...teams.alpha, ...teams.bravo], tdm: teams, snd: { attackers: teams.alpha, defenders: teams.bravo }, conquest: teams },
    ladders: structuredClone(ladders), sites: [], traps: [], landmarks: structuredClone(landmarks), dummyPosts: [], course: null,
  };
}

/** Cells the generator must leave open after every set piece (as frontierReservedCells). */
export function redrockReservedCells() {
  const { conquest } = redrockBundle();
  const cells = [];
  const around = (p, r, height, label) => cells.push({
    minX: Math.floor(p.x - r), maxX: Math.floor(p.x + r), minZ: Math.floor(p.z - r), maxZ: Math.floor(p.z + r), height, label,
  });
  for (const f of conquest.flags) for (const s of f.spawns) around(s, 1, 3, `spawn ${f.id}`);
  for (const b of Object.values(conquest.bases)) for (const s of b.spawns) around(s, 1, 4, `spawn ${b.id}`);
  for (const v of conquest.vehicleSpawns) {
    const r = v.type === 'tank' || v.type === 'aa' ? 4.5 : v.type === 'jeep' || v.type === 'jeep_at' ? 3.5 : 0;
    if (!r) continue;
    around(v, r, 5, v.id);
    if (Number.isFinite(v.altX)) around({ x: v.altX, z: v.altZ }, r, 5, `${v.id} alt`);
  }
  return cells;
}
