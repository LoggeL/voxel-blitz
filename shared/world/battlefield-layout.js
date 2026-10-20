// Layout builders shared by the Conquest battlefields' map metadata
// (shared/world/frontier-sites/layout.js, shared/world/redrock-sites/layout.js).
// Both maps put the same HQ plateaus (HQ_LAYOUT: airfield, motor pool, HQ
// spawns) in the alpha corner and point-mirror them for bravo, so the HQ
// airfields, HQ hull pads, flags, roads, crossings, landmarks and the reserved
// cells all derive the same way from a map's plan, sites and terrain height.
// Pure data: no voxels are built here.

import { HQ_LAYOUT, hqTowerLadder } from './frontier-sites/hq-airfield.js';

const FEET = 1.02;
export const round2 = v => Math.round(v * 100) / 100;
export const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
};

/**
 * The builders of one battlefield: `dimensions` {sx, sz} and `topY(x, z)`, the
 * top terrain voxel y (every y is read from it: feet = top voxel + 1.02).
 */
export function battlefieldLayoutKit({ dimensions, topY }) {
  const { sx: SX, sz: SZ } = dimensions;
  /** Feet position on the terrain at continuous (x, z). */
  const feet = (x, z) => Object.freeze({ x, y: round2(topY(x, z) + FEET), z });
  const feetY = (x, z) => round2(topY(x, z) + FEET);
  const mirrorFeet = p => feet(SX - p.x, SZ - p.z);
  const mirrorYaw = yaw => Math.atan2(Math.sin(yaw + Math.PI), Math.cos(yaw + Math.PI));

  /** Flag rows in plan order, each with its site's spawn cells. */
  function buildFlags(planFlags, sites) {
    return planFlags.map(f => {
      const site = sites.find(s => s.flag === f.id);
      return {
        id: f.id, name: f.name, site: f.site, ...feet(f.x, f.z), radius: f.radius, home: f.home,
        spawns: site.spawns.map(([x, z]) => feet(x, z)),
      };
    });
  }

  /** HQ bases: alpha's HQ_LAYOUT spawns, point-mirrored for bravo. `names` overrides the plan's HQ names. */
  function buildBases(hqs, names = {}) {
    const out = {};
    for (const team of ['alpha', 'bravo']) {
      const hq = hqs[team];
      const spawns = HQ_LAYOUT.spawns.map(([x, z]) => (team === 'alpha' ? feet(x, z) : mirrorFeet({ x, z })));
      out[team] = { id: team, name: names[team] ?? hq.name, ...feet(hq.x, hq.z), radius: hq.radius, spawns };
    }
    return out;
  }

  /** Alpha-frame airfield; bravo is produced by mirroring every coordinate. */
  function alphaAirfield() {
    const r = HQ_LAYOUT.runway, y = feetY(r.x, (r.z0 + r.z1) / 2);
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
      tower: { ...centre(tower), height: 25, entrance: towerEntrance, ladder: hqTowerLadder(topY(tower.minX + 1, tower.minZ + 1)) },
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

  /** Both HQ airfields; each keeps `routesByVehicle` until the bundle drops it after the vehicle spawns. */
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

  /** The HQ hull pads of both airfields: the motor pool's ground hulls, the helipads and the runway. */
  function hqVehicleSpawns(airfields) {
    const spawns = [];
    const yawFor = (team, yaw) => (team === 'alpha' ? yaw : mirrorYaw(yaw));
    for (const field of airfields) {
      const team = field.team, routes = field.routesByVehicle;
      const hqPos = (alphaPos) => (team === 'alpha' ? feet(alphaPos.x, alphaPos.z) : mirrorFeet(alphaPos));
      // The mobile AA parks in the motor pool's south bay (HQ_LAYOUT.aaVehicle).
      for (const type of ['jeep', 'tank', 'jeep_at', 'aa']) {
        const pad = type === 'aa' ? HQ_LAYOUT.aaVehicle : HQ_LAYOUT[type], at = hqPos(pad);
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
    return spawns;
  }

  /** Each flag site's own hull, with its alternative pad when the site has one. */
  function siteVehicleSpawns(sites) {
    return sites.map(site => {
      const v = site.vehicle;
      const entry = { id: v.id, team: v.team, type: v.type, ...feet(v.x, v.z), yaw: v.yaw, flag: site.flag };
      if (Number.isFinite(v.altX)) Object.assign(entry, { altX: v.altX, altY: feetY(v.altX, v.altZ), altZ: v.altZ, altYaw: v.altYaw });
      return entry;
    });
  }

  /** Road centrelines resampled every <= 10 m, keeping the authored vertices. */
  function buildRoads(roadPlan) {
    return roadPlan.map(road => {
      const points = [];
      for (let i = 0; i < road.points.length; i++) {
        const [x, z] = road.points[i];
        if (i) {
          const [px, pz] = road.points[i - 1];
          const n = Math.ceil(Math.hypot(x - px, z - pz) / 10);
          for (let k = 1; k < n; k++) {
            const t = k / n, ix = round2(px + (x - px) * t), iz = round2(pz + (z - pz) * t);
            points.push([ix, feetY(ix, iz), iz]);
          }
        }
        points.push([x, feetY(x, z), z]);
      }
      return { id: road.id, kind: road.kind, width: road.width, points };
    });
  }

  function buildCrossings(crossings) {
    return crossings.map(c => ({
      id: c.id, kind: c.kind, x: c.x, y: round2((c.kind === 'bridge' ? c.deckY : c.bedY) + FEET), z: c.z, width: c.width,
    }));
  }

  /** Flag rows, the places between the flags and the landmark tops (site structures, HQ hangars, places). */
  function buildLandmarks(flags, sites, locations) {
    const tops = [];
    // Site landmark tops: y from the terrain plus each structure's rise.
    for (const site of sites) {
      for (const l of site.landmarks) {
        const y = Number.isFinite(l.y) ? l.y : topY(l.x, l.z) + l.rise;
        tops.push({ id: l.id, kind: l.kind, flag: site.flag, x: l.x, y, z: l.z, ...(l.primary ? { primary: true } : {}) });
      }
    }
    // The hangar ridge stands 14 voxels above the plateau floor.
    const hangar = HQ_LAYOUT.hangar;
    const hx = (hangar.minX + hangar.maxX + 1) / 2, hz = (hangar.minZ + hangar.maxZ + 1) / 2;
    tops.push({ id: 'west-hq-hangar', kind: 'hangar', x: hx, y: topY(hx, hz) + 14, z: hz });
    tops.push({ id: 'east-hq-hangar', kind: 'hangar', x: SX - hx, y: topY(SX - hx, SZ - hz) + 14, z: SZ - hz });
    // The places between the flags: a named row (kind 'place', for map labels)
    // and the landmark top that names its place.
    const places = locations.map(l => ({ id: l.id, kind: 'place', name: l.name, ...feet(l.x, l.z), ...(Number.isFinite(l.floorY) ? { y: l.floorY + FEET } : {}) }));
    for (const l of locations) tops.push({ id: l.landmark.id, kind: l.landmark.kind, place: l.id, x: l.landmark.x, y: l.landmark.y, z: l.landmark.z });
    return [
      ...flags.map(f => ({ id: f.id, kind: 'flag', name: f.name, x: f.x, y: f.y, z: f.z, radius: f.radius })),
      ...places,
      ...tops,
    ];
  }

  return { feet, mirrorFeet, mirrorYaw, buildFlags, buildBases, buildAirfields, hqVehicleSpawns, siteVehicleSpawns, buildRoads, buildCrossings, buildLandmarks };
}

/**
 * Map metadata of a battlefield from its frozen bundle `{conquest, landmarks,
 * ladders}`: Conquest only, surface navigation, the HQ spawns for every mode's
 * spawn table. Static: no voxel world needed.
 */
export function battlefieldMetadata({ id, name, dimensions, groundLevel, spawnBounds }, { conquest, landmarks, ladders }) {
  const teams = { alpha: conquest.bases.alpha.spawns, bravo: conquest.bases.bravo.spawns };
  return {
    id, name, dimensions, modes: ['conquest'],
    navigation: { mode: 'surface', cell: 4, maxStep: 1 },
    navigationFloor: null,
    groundLevel,
    spawnBounds,
    conquest: structuredClone(conquest),
    spawns: { fun: [...teams.alpha, ...teams.bravo], tdm: teams, snd: { attackers: teams.alpha, defenders: teams.bravo }, conquest: teams },
    ladders: structuredClone(ladders), sites: [], traps: [], landmarks: structuredClone(landmarks), dummyPosts: [], course: null,
  };
}

/**
 * Cells the generator must leave open after every set piece: each spawn
 * cell with its neighbours and every ground hull pad footprint (the runway
 * and helipads are reserved by the HQ builder itself).
 */
export function battlefieldReservedCells(conquest) {
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
