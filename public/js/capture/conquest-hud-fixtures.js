/**
 * Snapshot-shaped Conquest HUD fixtures (wire format: match.conquest tuples,
 * players[].cq / cqs, vehicles[] rows with mounts / sel / st / lk / sp / cmr)
 * for the static capture page and the Node UI suites. Positions come from the
 * frozen FRONTIER_PLAN; nothing here is read by the live game.
 */
import { BREAKTHROUGH_RULES, FRONTIER_PLAN, KIT_IDS, VEHICLE_STATUS, vehicleMountOrder } from '../../../shared/conquest-contract.js';
import { WEAPON_IDS } from '../../../shared/combatmath.js';
import { encodeConquestFlag } from '../../../shared/conquest.js';
import { mortarPitchForRange } from '../../../shared/mortar-rules.js';
import { FPV_RULES, fpvSignal, fpvStatic } from '../../../shared/fpv-rules.js';
import { conquestPlanFor } from '../../../shared/world/battlefield-plans.js';
import { BATTLEFIELD_INFO } from '../../../shared/world/battlefields.js';
import { comebackHudFixtures } from './comeback-hud-fixtures.js';
import { radarHudFixtures } from './radar-hud-fixtures.js';
import { encodeMapEventPoint, encodeMapEventRow, mapEventsFor } from '../../../shared/conquest-map-events.js';
import { DAM_EVENT, DAM_TUNING } from '../../../shared/map-events/dam.js';

export const FIXTURE_NOW = 2_000_000;
const GROUND = 26;
const HQ_Y = FRONTIER_PLAN.heights.hqPlateau;

/** mapMeta with the Conquest statics the client merges (flags with y, bases, combat area). */
export function fixtureMapMeta(mapId = 'frontier') {
  // ?map=redrock on the capture page: the same fixtures over Redrock Canyon's
  // flags (names, radii), HQs and overview image; the fixture rows keep their
  // Frontier positions, which fall on the same five-flag layout.
  const plan = mapId === 'frontier' ? FRONTIER_PLAN : conquestPlanFor(mapId);
  const flags = plan.flags.map(f => ({ ...f, y: GROUND, spawns: [] }));
  const bases = Object.fromEntries(Object.entries(plan.hqs).map(([team, hq]) => [team, { id: team, ...hq, y: HQ_Y, spawns: [] }]));
  return {
    id: mapId, name: BATTLEFIELD_INFO[mapId]?.name ?? 'Frontier', dimensions: { ...plan.dimensions },
    conquest: { version: 2, flags, bases, combatArea: { ...plan.combatArea }, vehicleSpawns: [], roads: [], crossings: plan.crossings.map(c => ({ ...c, y: GROUND })), weather: mapId === 'redrock' ? 'desert' : 'golden' },
  };
}

const flag = (id, control, owner, state, alpha = 0, bravo = 0) => encodeConquestFlag({ id, control, owner, state, alpha, bravo });
const kit = id => KIT_IDS.indexOf(id);
/** cq = [kitIndex, squadId, down, spotted, restrictedDs, lockProgress100, actionProgress100] */
const cq = ({ kitId = 'assault', squad = 1, down = 0, spotted = 0, restrictedDs = 0, lock = 0, action = 0 } = {}) =>
  [kit(kitId), squad, down, spotted, restrictedDs, lock, action];

function player(id, name, team, x, z, extra = {}) {
  return { id, name, team, x, y: GROUND, z, yaw: 0, pitch: 0, hp: 100, state: 'alive', kills: 0, deaths: 0, score: 0, ping: 32,
    cq: cq(extra.cq), cqs: extra.cqs ?? [0, 0, 0, 0], ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'cq' && k !== 'cqs')) };
}

function vehicle(id, type, team, x, z, extra = {}) {
  const mounts = vehicleMountOrder(type).map(() => [extra.yaw ?? 0, 0, -1, 0, 0]);
  return { id, type, team, x, y: GROUND, z, yaw: 0, pitch: 0, roll: 0, hp: 1, seatOccupants: {}, mounts, st: VEHICLE_STATUS.engine,
    lk: 0, sp: 0, cmr: 100, speed: 0, ...extra };
}

function baseMatch({ flags, tickets = { alpha: 214, bravo: 187 }, bleed = { alpha: 0, bravo: 0 }, phase = 'live', winner,
  squads = [['alpha', 1, 'me'], ['alpha', 2, 'tm1'], ['bravo', 1, 'en1']] } = {}) {
  return {
    mode: 'conquest', map: 'frontier', phase, ...(winner !== undefined ? { winner } : {}),
    scores: { ...tickets },
    conquest: { v: 2, tickets, maxTickets: 300, bleed, endsAt: FIXTURE_NOW + 14 * 60_000 + 32_000,
      flags: flags ?? [flag('A', 1, 'alpha', 'idle'), flag('B', 1, 'alpha', 'idle'), flag('C', 0, null, 'idle'),
        flag('D', -1, 'bravo', 'idle'), flag('E', -1, 'bravo', 'idle')],
      // Squad tuples: [team, squadId, leaderId, orderFlag?] (the 4th entry only while the squad has an order).
      squads },
  };
}

/** Camera behind and above a point, looking along yaw. */
const cam = (x, y, z, yaw, pitch = -0.08) => ({ x, y, z, yaw, pitch, fov: 75 });
const yawTo = (from, to) => Math.atan2(-(to.x - from.x), -(to.z - from.z));

const C = FRONTIER_PLAN.flags.find(f => f.id === 'C');
const A = FRONTIER_PLAN.flags.find(f => f.id === 'A');
const B = FRONTIER_PLAN.flags.find(f => f.id === 'B');
const D = FRONTIER_PLAN.flags.find(f => f.id === 'D');

function roster(self, more = []) {
  return [
    self,
    player('sq1', 'Kestrel', 'alpha', self.x - 6, self.z + 9, { cq: { squad: 1, kitId: 'engineer' }, kills: 4, deaths: 2, score: 860, cqs: [350, 1, 0, 1] }),
    player('sq2', 'Brannock', 'alpha', self.x + 14, self.z + 22, { cq: { squad: 1, kitId: 'support' }, kills: 2, deaths: 3, score: 540, cqs: [100, 0, 0, 0] }),
    player('tm1', 'Vale', 'alpha', self.x - 30, self.z + 40, { cq: { squad: 2, kitId: 'recon' }, kills: 6, deaths: 1, score: 1120, cqs: [250, 0, 0, 1] }),
    player('tm2', 'Okafor', 'alpha', A.x, A.z, { cq: { squad: 2 }, kills: 1, deaths: 4, score: 300, cqs: [150, 0, 2, 0] }),
    player('en1', 'Rourke', 'bravo', self.x + 38, self.z - 60, { cq: { squad: 1, spotted: 1, kitId: 'recon' }, kills: 7, deaths: 3, score: 1290, cqs: [400, 1, 0, 2] }),
    player('en2', 'Sato', 'bravo', self.x + 70, self.z - 90, { cq: { squad: 1 }, kills: 3, deaths: 5, score: 610, cqs: [150, 0, 1, 0] }),
    player('en3', 'Ibarra', 'bravo', D.x, D.z, { cq: { squad: 2, kitId: 'engineer' }, kills: 2, deaths: 2, score: 480, cqs: [0, 2, 0, 0] }),
    ...more,
  ];
}

/**
 * FpvPilot.telemetry of the fixture drone (26 s battery, 24 m/s) over a link
 * `distance` m long: the signal and the static from the shared curves, as the
 * live feed reads them off the row's link length.
 */
export function fpvFixtureTelemetry(distance, { altitude = 22, occluded = false } = {}) {
  const signal = fpvSignal(distance), noise = fpvStatic(distance, occluded);
  return { battery: 0.64, seconds: 26, bars: signal.bars, maxBars: FPV_RULES.signal.bars, quality: signal.quality, degraded: signal.degraded,
    speed: 24, altitude, distance, range: FPV_RULES.signal.range, noise: noise.level, tear: noise.tear, bleed: noise.bleed, drop: noise.drop,
    left: 1, roll: 0.06, pitch: -0.32 };
}

/** A state: everything ConquestHud.update needs plus events to replay and capture hints. */
function state(id, title, { selfTeam = 'alpha', self, players, vehicles = [], match, camera, events = [], dead = false, killer = null,
  bigMap = false, nearbyVehicle = null, interactHeld = null, selection = null, screen = 'hud', touch = null, career = null, viewStrip = null,
  flight = null, aim = null, groundPlane = null, rose = null, mapCursor = null, toolKind = null, fpv = null } = {}) {
  return { id, title, selfTeam, self, players, vehicles, match, camera, events, dead, killer, bigMap, nearbyVehicle, interactHeld, selection, screen, touch, career, viewStrip,
    flight, aim, ...(groundPlane != null ? { groundPlane } : {}), ...(rose ? { rose } : {}), ...(mapCursor ? { mapCursor } : {}), ...(toolKind ? { toolKind } : {}), ...(fpv ? { fpv } : {}) };
}

/** Every HUD state the acceptance list names, in capture order. */
export function conquestHudFixtures({ map = 'frontier' } = {}) {
  const out = [];
  const meAt = (x, z, extra = {}) => player('me', 'You', 'alpha', x, z, { cq: { squad: 1, kitId: 'assault' }, kills: 5, deaths: 2, score: 940, cqs: [400, 1, 1, 2], ...extra });
  const meAtY = (x, y, z, extra = {}) => ({ ...meAt(x, z, extra), y });
  const alphaHeli = vehicle('alpha-helicopter', 'helicopter', 'alpha', 150, 330, { hp: 650, y: 40 });
  const spottedTank = vehicle('bravo-tank', 'tank', 'bravo', C.x + 70, C.z - 30, { hp: 820, sp: 1, yaw: 1.2 });

  // 1. Capturing a neutral C with a 3 vs 1 majority; bleed on the enemy (own holds 3).
  {
    const self = meAt(C.x + 4, C.z + 6);
    out.push(state('capturing', 'Capturing C · 3 vs 1 · enemy bleeding', { self,
      players: roster(self, [player('sq3', 'Halden', 'alpha', C.x - 5, C.z + 2, { cq: { squad: 1 } })]),
      vehicles: [spottedTank, alphaHeli],
      match: baseMatch({ flags: [flag('A', 1, 'alpha', 'idle'), flag('B', 1, 'alpha', 'idle'), flag('C', 0.38, null, 'capturing', 3, 1),
        flag('D', -1, 'bravo', 'idle'), flag('E', 0.4, 'alpha', 'restoring')], bleed: { alpha: 0, bravo: 3000 } }),
      camera: cam(C.x + 4, GROUND + 1.6, C.z + 6, yawTo(C, D) + 0.35),
      events: [{ kind: 'score', id: 'me', pts: 100, reason: 'kill' }, { kind: 'score', id: 'me', pts: 50, reason: 'attacker_kill' },
        { kind: 'score', id: 'me', pts: 25, reason: 'headshot' }] }));
  }
  // 2. Neutralizing enemy D; we hold A, B: no bleed either way.
  {
    const self = meAt(D.x - 5, D.z + 8);
    out.push(state('neutralizing', 'Neutralizing D · 2 vs 0', { self, players: roster(self), vehicles: [spottedTank],
      match: baseMatch({ flags: [flag('A', 1, 'alpha', 'idle'), flag('B', 1, 'alpha', 'idle'), flag('C', -1, 'bravo', 'idle'),
        flag('D', -0.46, 'bravo', 'neutralizing', 2, 0), flag('E', -1, 'bravo', 'idle')], bleed: { alpha: 3000, bravo: 0 } }),
      camera: cam(D.x - 5, GROUND + 1.6, D.z + 8, yawTo(D, C)),
      events: [{ kind: 'flag_state', flag: 'D', state: 'neutralizing', team: 'alpha' }] }));
  }
  // 3. Contested C: 2 vs 2, control frozen.
  {
    const self = meAt(C.x - 3, C.z - 4);
    out.push(state('contested', 'Contested C · 2 vs 2', { self, players: roster(self), vehicles: [spottedTank],
      match: baseMatch({ flags: [flag('A', 1, 'alpha', 'idle'), flag('B', 0.7, 'alpha', 'restoring'), flag('C', 0.22, null, 'contested', 2, 2),
        flag('D', -1, 'bravo', 'idle'), flag('E', -1, 'bravo', 'idle')] }),
      camera: cam(C.x - 3, GROUND + 1.6, C.z - 4, yawTo(C, D)) }));
  }
  // 4. Defending own A (idle, full control) with the enemy losing tickets 2/s... and the own flag under attack banner from B.
  {
    const self = meAt(A.x + 3, A.z - 2);
    out.push(state('defending', 'Defending A · B under attack', { self, players: roster(self), vehicles: [alphaHeli],
      match: baseMatch({ flags: [flag('A', 1, 'alpha', 'idle', 1, 0), flag('B', 0.55, 'alpha', 'neutralizing', 0, 2),
        flag('C', 1, 'alpha', 'idle'), flag('D', 1, 'alpha', 'idle'), flag('E', -1, 'bravo', 'idle')], bleed: { alpha: 0, bravo: 2000 } }),
      camera: cam(A.x + 3, GROUND + 1.6, A.z - 2, yawTo(A, B)),
      events: [{ kind: 'flag_state', flag: 'B', state: 'neutralizing', team: 'bravo' }] }));
  }
  // 5. Restoring own B after the attackers fell; own team is bleeding (enemy holds 3).
  {
    const self = meAt(B.x + 2, B.z + 3);
    out.push(state('restoring', 'Restoring B · own bleeding', { self, players: roster(self), vehicles: [],
      match: baseMatch({ flags: [flag('A', -1, 'bravo', 'idle'), flag('B', 0.62, 'alpha', 'restoring', 1, 0), flag('C', -1, 'bravo', 'idle'),
        flag('D', -1, 'bravo', 'idle'), flag('E', -1, 'bravo', 'idle')], tickets: { alpha: 61, bravo: 240 }, bleed: { alpha: 1000, bravo: 0 } }),
      camera: cam(B.x + 2, GROUND + 1.6, B.z + 3, yawTo(B, C)),
      events: [{ kind: 'ticket_low', team: 'alpha', tickets: 75 }] }));
  }
  // 6. Playing EAST: team-relative colours put EAST in blue on the left.
  {
    const self = player('me', 'You', 'bravo', D.x + 4, D.z + 4, { cq: { squad: 1, kitId: 'support' }, kills: 3, score: 520 });
    out.push(state('east-relative', 'Playing EAST · own side blue', { selfTeam: 'bravo', self,
      players: [self, player('en1', 'Rourke', 'bravo', D.x + 8, D.z, { cq: { squad: 1 } }), player('sq1', 'Kestrel', 'alpha', C.x, C.z, { cq: { spotted: 1 } })],
      vehicles: [vehicle('alpha-tank', 'tank', 'alpha', C.x - 20, C.z + 10, { hp: 900, sp: 1 })],
      match: baseMatch({ flags: [flag('A', 1, 'alpha', 'idle'), flag('B', 1, 'alpha', 'idle'), flag('C', -0.5, null, 'capturing', 0, 1),
        flag('D', -1, 'bravo', 'idle'), flag('E', -1, 'bravo', 'idle')], tickets: { alpha: 190, bravo: 233 } }),
      camera: cam(D.x + 4, GROUND + 1.6, D.z + 4, yawTo(D, C)),
      events: [{ kind: 'flag_neutralized', flag: 'C', team: 'bravo', prev: 'alpha' }] }));
  }
  // 7. Out of bounds countdown (cq[4] = 6.4 s).
  {
    const self = meAt(30, 300, { cq: { squad: 1, restrictedDs: 64 } });
    out.push(state('out-of-bounds', 'Out of bounds · 7 s', { self, players: roster(self), match: baseMatch(),
      camera: cam(30, GROUND + 1.6, 300, -Math.PI / 2) }));
  }
  // 8. A Medic revives a downed teammate within 2 m (cq[6] = 60); a wounded mate shows the heal cross.
  {
    const self = meAt(C.x - 40, C.z + 30, { cq: { squad: 1, kitId: 'medic', action: 60 } });
    const downed = player('dn1', 'Mercer', 'alpha', C.x - 41.2, C.z + 30.8, { hp: 0, state: 'dead', cq: { squad: 1, down: 1 } });
    const downedFar = player('dn2', 'Lindqvist', 'alpha', C.x - 52, C.z + 12, { hp: 0, state: 'dead', cq: { squad: 2, down: 1 } });
    const wounded = player('wd1', 'Okafor', 'alpha', C.x - 50, C.z + 22, { hp: 38, cq: { squad: 2, kitId: 'support' } });
    out.push(state('revive', 'Medic reviving a downed squadmate · 60 %', { self, players: roster(self, [downed, downedFar, wounded]), match: baseMatch(),
      camera: cam(C.x - 40, GROUND + 1.6, C.z + 30, yawTo({ x: C.x - 40, z: C.z + 30 }, { x: C.x - 52, z: C.z + 12 }) + 0.25, -0.18),
      interactHeld: 900 }));
  }
  // 9. Tank driver: main gun AP selected, reloading 40 %, hull hit flash, disabled + burning, lock 0.
  // The hull is turned 50° left of the gun and crawls forward (hull indicator: ◀ 50°).
  const tankAt = { x: C.x - 70, z: C.z + 20 };
  {
    const self = meAt(tankAt.x, tankAt.z, { vehicleId: 'alpha-tank', vehicleSeatId: 'driver' });
    const tank = vehicle('alpha-tank', 'tank', 'alpha', tankAt.x, tankAt.z, { hp: 230, yaw: yawTo(tankAt, C) + 50 * Math.PI / 180, turretYaw: yawTo(tankAt, C) + 0.12,
      seatOccupants: { driver: 'me', commander: 'sq2' }, st: VEHICLE_STATUS.engine | VEHICLE_STATUS.disabled | VEHICLE_STATUS.burning,
      mounts: [[yawTo(tankAt, C) + 0.06, 0.02, 4, 0, 40], [yawTo(tankAt, C) + 0.06, 0.02, -1, 22, 0], [yawTo(tankAt, C) - 0.4, 0.1, -1, 0, 0]],
      sel: { driver: 0 }, cmr: 46, speed: 3.2 });
    // Brannock rides as commander: his row carries the seat like the live snapshot does.
    const crew = roster(self).map(p => p.id === 'sq2' ? { ...p, x: tankAt.x, z: tankAt.z, vehicleId: 'alpha-tank', vehicleSeatId: 'commander' } : p);
    out.push(state('tank-driver', 'Tank driver · AP reloading · disabled', { self, players: crew, vehicles: [tank, spottedTank],
      match: baseMatch(), camera: cam(tankAt.x - Math.sin(yawTo(tankAt, C)) * -9, GROUND + 4.6, tankAt.z - Math.cos(yawTo(tankAt, C)) * -9, yawTo(tankAt, C), -0.06),
      events: [{ kind: 'vehicle_hit', vehicleId: 'alpha-tank', attacker: 'en3', dmg: 220, zone: 'rear', cls: 'at', eff: 1, pos: [tankAt.x, GROUND + 1, tankAt.z] },
        { kind: 'vehicle_hit', vehicleId: 'bravo-tank', attacker: 'me', dmg: 300, zone: 'side', cls: 'at', eff: 1, pos: [0, 0, 0] },
        { kind: 'vehicle_destroyed', vehicleId: 'bravo-jeep', type: 'jeep', attacker: 'me', assists: [], crewKilled: 2 },
        { kind: 'kill', killer: 'me', victim: 'en2', w: 'tankAP' }, { kind: 'kill', killer: 'en1', victim: 'tm2', w: 'vehicle' },
        { kind: 'kill', killer: '', victim: 'sq3', w: 'restricted' }] }));
  }
  // 10. Tank commander on the RWS (.50 HMG, hot) with the coax/main crewed by a bot.
  {
    const self = meAt(tankAt.x, tankAt.z, { vehicleId: 'alpha-tank', vehicleSeatId: 'commander' });
    const yaw = yawTo(tankAt, C);
    const tank = vehicle('alpha-tank', 'tank', 'alpha', tankAt.x, tankAt.z, { hp: 760, yaw, turretYaw: yaw,
      seatOccupants: { driver: 'sq2', commander: 'me' }, mounts: [[yaw, 0, 6, 0, 0], [yaw, 0, -1, 0, 0], [yaw + 0.3, 0.05, -1, 81, 0]], sel: { driver: 1 }, cmr: 100,
      // The bot driver's fixed vehicle upgrade (BOT_VEHICLE_UPGRADES.tank: REACTIVE ARMOUR, row upg 1).
      upg: 1 });
    out.push(state('tank-commander', 'Tank commander · RWS hot', { self, players: roster(self), vehicles: [tank, spottedTank], match: baseMatch(),
      camera: cam(tankAt.x + 0.6, GROUND + 3.4, tankAt.z + 0.4, yaw + 0.3, -0.02) }));
  }
  // 10b. Tank driver in the DRIVER periscope, a moment after V: the camera looks along the hull,
  // the gun is turned 30° right and reloading HE, the hull rolls forward at 23 km/h.
  {
    const yaw = yawTo(tankAt, C), gunYaw = yaw - 30 * Math.PI / 180;
    const self = meAt(tankAt.x, tankAt.z, { vehicleId: 'alpha-tank', vehicleSeatId: 'driver' });
    const tank = vehicle('alpha-tank', 'tank', 'alpha', tankAt.x, tankAt.z, { hp: 640, yaw, turretYaw: gunYaw, turretPitch: 0.03,
      seatOccupants: { driver: 'me', commander: 'sq2' }, mounts: [[gunYaw, 0.03, -1, 0, 55], [gunYaw, 0.03, -1, 10, 0], [yaw, 0, -1, 0, 0]],
      sel: { driver: 1 }, cmr: 100, speed: 6.4 });
    const crew = roster(self).map(p => p.id === 'sq2' ? { ...p, x: tankAt.x, z: tankAt.z, vehicleId: 'alpha-tank', vehicleSeatId: 'commander' } : p);
    // The periscope eye (shared seat camera `periscope`, hull frame [-0.6, 1.5, -2.55]) looking along the hull.
    const c = Math.cos(yaw), s = Math.sin(yaw), [ex, ey, ez] = [-0.6, 1.5, -2.55];
    const views = [['cockpit', 'HATCH'], ['chase', 'CHASE'], ['action', 'ACTION'], ['driver', 'DRIVER']].map(([id, label]) => ({ id, label }));
    out.push(state('tank-periscope', 'Tank driver · DRIVER periscope · HE loading · gun 30° right', { self, players: crew, vehicles: [tank, spottedTank],
      match: baseMatch(), camera: cam(tankAt.x + ex * c + ez * s, GROUND + ey, tankAt.z - ex * s + ez * c, yaw, 0),
      viewStrip: { type: 'tank', seatId: 'driver', view: 'driver', views }, aim: { yaw: gunYaw, pitch: 0.03 } }));
  }
  // 10c. Mobile AA driver (design docs/design/conquest/aa/, variant A): guns laid 12° up toward an
  // enemy attack helicopter crossing 300 m out (radar track box and lead pipper), a second enemy
  // aircraft and our own helicopter on the scope, heat 46 %. 10d: the same guns overheated, no track.
  const aaAt = { x: C.x - 95, z: C.z + 45 };
  {
    const yaw = yawTo(aaAt, C), gunYaw = yaw + 0.04, gunPitch = 0.3;
    const self = meAt(aaAt.x, aaAt.z, { vehicleId: 'alpha-aa', vehicleSeatId: 'driver' });
    const aa = vehicle('alpha-aa', 'aa', 'alpha', aaAt.x, aaAt.z, { hp: 600, yaw: yaw + 0.5, turretYaw: gunYaw, turretPitch: gunPitch,
      seatOccupants: { driver: 'me', commander: 'sq2' }, mounts: [[gunYaw, gunPitch, -1, 46, 0], [yaw + 0.6, 0.1, -1, 0, 0]],
      sel: { driver: 0 }, cmr: 100, speed: 5 });
    const at = (bearing, range, height) => ({ x: aaAt.x - Math.sin(bearing) * range, z: aaAt.z - Math.cos(bearing) * range, y: GROUND + height });
    const h = at(yaw + 0.14, 300, 128), j = at(yaw - 1.4, 380, 120), own = at(yaw + 2.6, 210, 50);
    const enemyHeli = vehicle('bravo-helicopter', 'helicopter', 'bravo', h.x, h.z, { y: h.y, hp: 620, yaw: yaw + Math.PI / 2,
      vx: -Math.cos(yaw) * 22, vy: 0, vz: Math.sin(yaw) * 22, grounded: false, seatOccupants: { driver: 'en1' } });
    const enemyJet = vehicle('bravo-plane', 'plane', 'bravo', j.x, j.z, { y: j.y, hp: 450, vx: 60, vy: 0, vz: 0, grounded: false, seatOccupants: { driver: 'en2' } });
    const ownHeli = vehicle('alpha-helicopter', 'helicopter', 'alpha', own.x, own.z, { y: own.y, hp: 650, grounded: false, seatOccupants: { driver: 'tm1' } });
    const crew = roster(self).map(p => p.id === 'sq2' ? { ...p, x: aaAt.x, z: aaAt.z, vehicleId: 'alpha-aa', vehicleSeatId: 'commander' } : p);
    // Chase eye behind and above the turret, looking along the guns.
    const back = 10, eyeY = GROUND + 3.6 + 2.2;
    out.push(state('aa-driver', 'Mobile AA driver · radar track and lead · heat 46 %', { self, players: crew,
      vehicles: [aa, enemyHeli, enemyJet, ownHeli, spottedTank], match: baseMatch(),
      camera: cam(aaAt.x + Math.sin(gunYaw) * back, eyeY, aaAt.z + Math.cos(gunYaw) * back, gunYaw, gunPitch - 0.02) }));
    const hot = { ...aa, mounts: [[gunYaw, gunPitch, -1, 100, 0], [yaw + 0.6, 0.1, -1, 0, 0]] };
    out.push(state('aa-overheat', 'Mobile AA driver · OVERHEAT · contacts off the gun line', { self, players: crew,
      vehicles: [hot, enemyJet, ownHeli, spottedTank], match: baseMatch(),
      camera: cam(aaAt.x + Math.sin(gunYaw) * back, eyeY, aaAt.z + Math.cos(gunYaw) * back, gunYaw, gunPitch - 0.02) }));
  }
  // 11. Attack helicopter pilot: rocket pods 9 left, flares ready, lock state 1 (locking).
  const heliAt = { x: C.x - 120, z: C.z - 40 };
  {
    const yaw = yawTo(heliAt, C);
    const self = meAt(heliAt.x, heliAt.z, { y: 70, vehicleId: 'alpha-helicopter', vehicleSeatId: 'driver' });
    const heli = vehicle('alpha-helicopter', 'helicopter', 'alpha', heliAt.x, heliAt.z, { y: 70, hp: 540, yaw, pitch: -0.08,
      seatOccupants: { driver: 'me', gunner: 'sq1' }, mounts: [[yaw, -0.08, 9, 0, 0], [yaw + 0.4, -0.3, -1, 12, 0]], lk: 1, cmr: 100,
      airspeed: 38, vx: -Math.sin(yaw) * 38, vy: 0, vz: -Math.cos(yaw) * 38, st: VEHICLE_STATUS.engine });
    const locker = player('en1', 'Rourke', 'bravo', heliAt.x + 80, heliAt.z - 120, { cq: { squad: 1, kitId: 'engineer', lock: 55, spotted: 1 } });
    out.push(state('heli-pilot', 'Helicopter pilot · pods · LOCKING', { self, players: [...roster(self).filter(p => p.id !== 'en1'), locker],
      vehicles: [heli, spottedTank], match: baseMatch(), camera: cam(heliAt.x + Math.sin(yaw) * 13, 74, heliAt.z + Math.cos(yaw) * 13, yaw, -0.12) }));
  }
  // 12. Attack helicopter gunner: chin gun gimbal, LOCKED (lk 2).
  {
    const yaw = yawTo(heliAt, C);
    const self = meAt(heliAt.x, heliAt.z, { y: 70, vehicleId: 'alpha-helicopter', vehicleSeatId: 'gunner' });
    const heli = vehicle('alpha-helicopter', 'helicopter', 'alpha', heliAt.x, heliAt.z, { y: 70, hp: 410, yaw, pitch: -0.05,
      seatOccupants: { driver: 'sq1', gunner: 'me' }, mounts: [[yaw, -0.05, 14, 0, 0], [yaw - 0.9, -0.45, -1, 64, 0]], lk: 2, cmr: 30, airspeed: 22 });
    const locker = player('en1', 'Rourke', 'bravo', heliAt.x - 60, heliAt.z + 150, { cq: { squad: 1, kitId: 'engineer', lock: 100 } });
    out.push(state('heli-gunner', 'Helicopter gunner · chin gimbal · LOCKED', { self, players: [...roster(self).filter(p => p.id !== 'en1'), locker],
      vehicles: [heli], match: baseMatch(), camera: cam(heliAt.x, 69.4, heliAt.z, yaw - 0.9, -0.45) }));
  }
  // 13. Transport door gunner near the arc limit; missile inbound (lk 3); flares recharging.
  const transAt = { x: C.x + 30, z: C.z + 120 };
  {
    const yaw = yawTo(transAt, C);
    const self = meAt(transAt.x, transAt.z, { y: 55, vehicleId: 'alpha-transport', vehicleSeatId: 'door-left' });
    const transport = vehicle('alpha-transport', 'transport', 'alpha', transAt.x, transAt.z, { y: 55, hp: 300, yaw,
      seatOccupants: { driver: 'tm1', 'door-left': 'me', 'door-right': null, 'rear-left': 'sq1', 'rear-right': null },
      mounts: [[yaw + Math.PI / 2 + 1.35, -0.3, -1, 45, 0], [yaw - Math.PI / 2, 0, -1, 0, 0]], lk: 3, cmr: 62, airspeed: 30,
      st: VEHICLE_STATUS.engine | VEHICLE_STATUS.burning });
    const locker = player('en1', 'Rourke', 'bravo', transAt.x + 150, transAt.z - 40, { cq: { squad: 1, lock: 100 } });
    out.push(state('transport-door', 'Transport door gun · arc limit · MISSILE', { self, players: [...roster(self).filter(p => p.id !== 'en1'), locker],
      vehicles: [transport, spottedTank], match: baseMatch(), camera: cam(transAt.x, 56.4, transAt.z, yaw + Math.PI / 2 + 1.35, -0.3) }));
  }
  // 14. Jet pilot: cannon selected, enemy helicopter in the funnel with lead, our own lock attempt 70 %.
  const jetAt = { x: C.x - 200, z: C.z + 10 };
  {
    const yaw = yawTo(jetAt, C);
    const self = meAt(jetAt.x, jetAt.z, { y: 140, vehicleId: 'alpha-plane', vehicleSeatId: 'driver', cq: { squad: 1, lock: 70 } });
    const vx = -Math.sin(yaw) * 58, vz = -Math.cos(yaw) * 58;
    const jet = vehicle('alpha-plane', 'plane', 'alpha', jetAt.x, jetAt.z, { y: 140, hp: 450, yaw, pitch: -0.04, roll: 0.1, grounded: false,
      seatOccupants: { driver: 'me' }, mounts: [[yaw, -0.04, -1, 35, 0], [yaw, -0.04, 1, 0, 30], [yaw, -0.04, 2, 0, 0]], sel: { driver: 1 }, airspeed: 58, vx, vy: -3, vz, cmr: 100, lk: 0 });
    const target = vehicle('bravo-helicopter', 'helicopter', 'bravo', jetAt.x - Math.sin(yaw) * 260 + 25, jetAt.z - Math.cos(yaw) * 260, { y: 128, hp: 600, sp: 1, vx: 12, vy: 0, vz: -20 });
    out.push(state('jet', 'Jet · AA missile selected · lead pipper · locking 70 %', { self, players: roster(self), vehicles: [jet, target],
      match: baseMatch(), camera: cam(jetAt.x + Math.sin(yaw) * 17, 144.4, jetAt.z + Math.cos(yaw) * 17, yaw, -0.02) }));
  }
  // 14a. The same jet a moment after V: the camera view strip under the ticket bar (cockpit view).
  {
    const yaw = yawTo(jetAt, C);
    const self = meAt(jetAt.x, jetAt.z, { y: 140, vehicleId: 'alpha-plane', vehicleSeatId: 'driver', cq: { squad: 1 } });
    const jet = vehicle('alpha-plane', 'plane', 'alpha', jetAt.x, jetAt.z, { y: 140, hp: 450, yaw, pitch: -0.04, roll: 0.1,
      seatOccupants: { driver: 'me' }, mounts: [[yaw, -0.04, -1, 35, 0], [yaw, -0.04, 1, 0, 30], [yaw, -0.04, 2, 0, 0]], sel: { driver: 0 }, airspeed: 58, grounded: false, cmr: 100, lk: 0 });
    const views = [['chase', 'CHASE'], ['action', 'ACTION'], ['cockpit', 'COCKPIT'], ['flyby', 'FLYBY']].map(([id, label]) => ({ id, label }));
    out.push(state('jet-view', 'Jet · V pressed · camera view strip (cockpit)', { self, players: roster(self), vehicles: [jet],
      match: baseMatch(), camera: cam(jetAt.x, 142.1, jetAt.z, yaw, -0.04), viewStrip: { type: 'plane', seatId: 'driver', view: 'cockpit', views } }));
  }
  // 14c-e. Mouse-aim pilots (docs/design/conquest/flight): the chase camera looks along the
  // aim (aim circle at the centre), the nose marker sits where the hull points, speed / AGL
  // tapes with climb, the jet's throttle bar and stall warning, and the first-entry hint.
  // `flight` stands in for VehicleController (aim mode) and the AGL ground cast.
  {
    const aimCam = (at, y, aimYaw, aimPitch, distance) => {
      const orbit = aimPitch - 0.14;
      return cam(at.x + Math.sin(aimYaw) * Math.cos(orbit) * distance, y + 2.6 - Math.sin(orbit) * distance,
        at.z + Math.cos(aimYaw) * Math.cos(orbit) * distance, aimYaw, aimPitch);
    };
    const yaw = yawTo(jetAt, C), aimYaw = yaw - 0.2;
    const self = meAt(jetAt.x, jetAt.z, { y: 120, vehicleId: 'alpha-plane', vehicleSeatId: 'driver', cq: { squad: 1 } });
    const jet = vehicle('alpha-plane', 'plane', 'alpha', jetAt.x, jetAt.z, { y: 120, hp: 450, yaw, pitch: 0.02, roll: -0.85,
      seatOccupants: { driver: 'me' }, mounts: [[yaw, 0.02, -1, 0, 0], [yaw, 0.02, 1, 0, 30], [yaw, 0.02, 2, 0, 0]], sel: { driver: 0 }, airspeed: 64, speed: 64,
      vx: -Math.sin(yaw) * 64, vy: 1.2, vz: -Math.cos(yaw) * 64, throttle: 0.85, enginePower: 0.85, grounded: false, gearDown: false, cmr: 100 });
    out.push(state('jet-aim', 'Jet · mouse aim · banking toward the aim circle · throttle 85 %', { self, players: roster(self), vehicles: [jet],
      match: baseMatch(), camera: aimCam(jetAt, 120, aimYaw, 0.1, 17), flight: { aim: true, mode: 'aim', agl: 94 } }));
  }
  // 14f. Bombs selected in a 26° dive on C at 110 m AGL; the CCIP sits short of the
  // flag on the bomb fall line, the AA missiles stay ready on their own rails.
  // `groundPlane` gives the capture a flat world cast at the valley floor.
  {
    const at = { x: C.x - 165, z: C.z + 12 }, yaw = yawTo(at, C), pitch = -0.45, speed = 56, y = GROUND + 110;
    const self = meAt(at.x, at.z, { y, vehicleId: 'alpha-plane', vehicleSeatId: 'driver', cq: { squad: 1 } });
    const jet = vehicle('alpha-plane', 'plane', 'alpha', at.x, at.z, { y, hp: 450, yaw, pitch, roll: 0,
      seatOccupants: { driver: 'me' }, mounts: [[yaw, pitch, -1, 0, 0], [yaw, pitch, 2, 0, 0], [yaw, pitch, 2, 0, 0]], sel: { driver: 2 }, airspeed: speed, speed,
      vx: -Math.sin(yaw) * Math.cos(pitch) * speed, vy: Math.sin(pitch) * speed, vz: -Math.cos(yaw) * Math.cos(pitch) * speed,
      throttle: 0.6, enginePower: 0.6, grounded: false, gearDown: false, cmr: 100 });
    const orbit = pitch + 0.1 - 0.14;
    out.push(state('jet-bomb', 'Jet · bombs selected · 26° dive on C · CCIP', { self, players: roster(self), vehicles: [jet, spottedTank],
      match: baseMatch(), camera: cam(at.x + Math.sin(yaw) * Math.cos(orbit) * 17, y + 2.6 - Math.sin(orbit) * 17, at.z + Math.cos(yaw) * Math.cos(orbit) * 17, yaw, pitch + 0.1),
      flight: { aim: true, mode: 'aim', agl: 110 }, groundPlane: GROUND }));
  }
  {
    const yaw = yawTo(jetAt, C), aimYaw = yaw + 0.1;
    const self = meAt(jetAt.x, jetAt.z, { y: 150, vehicleId: 'alpha-plane', vehicleSeatId: 'driver', cq: { squad: 1 } });
    const jet = vehicle('alpha-plane', 'plane', 'alpha', jetAt.x, jetAt.z, { y: 150, hp: 450, yaw, pitch: 0.55, roll: 0.15,
      seatOccupants: { driver: 'me' }, mounts: [[yaw, 0.55, -1, 0, 0], [yaw, 0.55, 1, 0, 30], [yaw, 0.55, 2, 0, 0]], sel: { driver: 0 }, airspeed: 19, speed: 19,
      vx: -Math.sin(yaw) * 17, vy: 8.4, vz: -Math.cos(yaw) * 17, throttle: 0.4, enginePower: 0.4, grounded: false, gearDown: false, stalled: true, cmr: 100 });
    const orbit = 0.62 - 0.14;
    out.push(state('jet-stall', 'Jet · mouse aim · zoom climb at 19 m/s · STALL warning', { self, players: roster(self), vehicles: [jet],
      match: baseMatch(), camera: cam(jetAt.x + Math.sin(aimYaw) * Math.cos(orbit) * 17, 152.6 - Math.sin(orbit) * 17, jetAt.z + Math.cos(aimYaw) * Math.cos(orbit) * 17, aimYaw, 0.62),
      flight: { aim: true, mode: 'aim', agl: 124 } }));
  }
  {
    // The map-edge safety pilot holds a hard bank toward the centre; the
    // pilot's aim still points out of the map.
    const yaw = yawTo(jetAt, C) + 2.4, aimYaw = yaw + 0.5;
    const self = meAt(jetAt.x, jetAt.z, { y: 140, vehicleId: 'alpha-plane', vehicleSeatId: 'driver', cq: { squad: 1 } });
    const jet = vehicle('alpha-plane', 'plane', 'alpha', jetAt.x, jetAt.z, { y: 140, hp: 450, yaw, pitch: 0.04, roll: 1.05,
      seatOccupants: { driver: 'me' }, mounts: [[yaw, 0.04, -1, 0, 0], [yaw, 0.04, 1, 0, 30], [yaw, 0.04, 2, 0, 0]], sel: { driver: 0 }, airspeed: 47, speed: 47,
      vx: -Math.sin(yaw) * 47, vy: -1.1, vz: -Math.cos(yaw) * 47, throttle: 0.7, enginePower: 0.7, grounded: false, gearDown: false, autopilot: true, cmr: 100 });
    const orbit = 0.05 - 0.14;
    out.push(state('jet-edge', 'Jet · mouse aim · map-edge safety pilot banking back in · AUTOPILOT chip', { self, players: roster(self), vehicles: [jet],
      match: baseMatch(), camera: cam(jetAt.x + Math.sin(aimYaw) * Math.cos(orbit) * 17, 142.6 - Math.sin(orbit) * 17, jetAt.z + Math.cos(aimYaw) * Math.cos(orbit) * 17, aimYaw, 0.05),
      flight: { aim: true, mode: 'aim', agl: 110 } }));
  }
  {
    // Over the airspace apron past the combat airspace (480 m beyond the west
    // edge): the out-of-bounds countdown that ends in the aircraft's loss.
    const at = { x: -540, z: jetAt.z }, yaw = Math.PI / 2 + 0.3, aimYaw = yaw;
    const self = meAt(at.x, at.z, { y: 150, vehicleId: 'alpha-plane', vehicleSeatId: 'driver', cq: { squad: 1, restrictedDs: 64 } });
    const jet = vehicle('alpha-plane', 'plane', 'alpha', at.x, at.z, { y: 150, hp: 450, yaw, pitch: 0.02, roll: 0.1,
      seatOccupants: { driver: 'me' }, mounts: [[yaw, 0.02, -1, 0, 0], [yaw, 0.02, 1, 0, 30], [yaw, 0.02, 2, 0, 0]], sel: { driver: 0 }, airspeed: 58, speed: 58,
      vx: -Math.sin(yaw) * 58, vy: 0.3, vz: -Math.cos(yaw) * 58, throttle: 0.8, enginePower: 0.8, grounded: false, gearDown: false, cmr: 100 });
    const orbit = 0.05 - 0.14;
    out.push(state('jet-oob', 'Jet · over the airspace apron past the combat airspace · OUT OF BOUNDS countdown', { self, players: roster(self), vehicles: [jet],
      match: baseMatch(), camera: cam(at.x + Math.sin(aimYaw) * Math.cos(orbit) * 17, 152.6 - Math.sin(orbit) * 17, at.z + Math.cos(aimYaw) * Math.cos(orbit) * 17, aimYaw, 0.05),
      flight: { aim: true, mode: 'aim', agl: 85 } }));
  }
  {
    const at = { x: C.x - 90, z: C.z + 70 }, yaw = yawTo(at, C), aimYaw = yaw + 0.35;
    const self = meAt(at.x, at.z, { y: GROUND + 18, vehicleId: 'alpha-helicopter', vehicleSeatId: 'driver', cq: { squad: 1 } });
    const heli = vehicle('alpha-helicopter', 'helicopter', 'alpha', at.x, at.z, { y: GROUND + 18, hp: 650, yaw: yaw + 0.2, pitch: 0.01, roll: 0.02,
      seatOccupants: { driver: 'me' }, rotorSpeed: 1, collective: 0.6, vx: 0.2, vy: 2.6, vz: 0.1, speed: 0.3, grounded: false, cmr: 100 });
    const orbit = -0.05 - 0.14;
    out.push(state('heli-aim', 'Attack heli · mouse aim · climbing on Space · pilot control hint', { self, players: roster(self), vehicles: [heli, spottedTank],
      match: baseMatch(), camera: cam(at.x + Math.sin(aimYaw) * Math.cos(orbit) * 13, GROUND + 18 + 3.5 - Math.sin(orbit) * 13, at.z + Math.cos(aimYaw) * Math.cos(orbit) * 13, aimYaw, -0.05),
      flight: { aim: true, mode: 'aim', agl: 18, hint: true } }));
  }
  // 14b. Engineer on foot with the AX-9 STINGER down the sights: seeker ring on an enemy helicopter, 65 %.
  {
    const at = { x: C.x - 40, z: C.z + 60 };
    const self = meAt(at.x, at.z, { cq: { squad: 1, kitId: 'engineer', lock: 65 }, weapon: WEAPON_IDS.indexOf('stinger'),
      owned: ['smg', 'stinger', 'revolver', 'knife'] });
    const enemy = { x: at.x + 30, z: at.z - 140 };
    const target = vehicle('bravo-helicopter', 'helicopter', 'bravo', enemy.x, enemy.z, { y: 72, hp: 610, sp: 1, vx: 14, vy: 0, vz: 6,
      seatOccupants: { driver: 'en2', gunner: null }, lk: 1 });
    const yaw = yawTo(at, enemy);
    const pitch = Math.atan2(72 + 1.5 - (GROUND + 1.6), Math.hypot(enemy.x - at.x, enemy.z - at.z));
    out.push(state('stinger-lock', 'Engineer · AX-9 STINGER · LOCKING 65 % on a helicopter', { self, players: roster(self), vehicles: [target, spottedTank],
      match: baseMatch(), camera: cam(at.x, GROUND + 1.6, at.z, yaw, pitch) }));
  }
  // 15. Jeep near the player with a free gunner seat: enter prompt; squad dots and spotted enemies.
  {
    const self = meAt(B.x + 30, B.z - 40);
    const jeep = vehicle('flag-B-jeep', 'jeep', 'alpha', B.x + 32, B.z - 41.5, { hp: 320, seatOccupants: { driver: 'sq1', gunner: null, 'front-passenger': null, 'rear-left': null } });
    out.push(state('enter-jeep', 'Enter prompt · jeep gunner seat', { self, players: roster(self), vehicles: [jeep, spottedTank], match: baseMatch(),
      camera: cam(B.x + 30, GROUND + 1.6, B.z - 40, yawTo({ x: B.x + 30, z: B.z - 40 }, C)), nearbyVehicle: jeep,
      // A fresh kill on the ticker while the prompt shows: both share the space under the crosshair.
      events: [{ kind: 'score', id: 'me', pts: 100, reason: 'kill' }, { kind: 'score', id: 'me', pts: 25, reason: 'headshot' }] }));
  }
  // 16. Full map (M).
  {
    const self = meAt(C.x - 50, C.z + 40);
    out.push(state('big-map', 'Full map · flags, squad, team, spotted, vehicles', { self, players: roster(self),
      vehicles: [spottedTank, alphaHeli, vehicle('alpha-tank', 'tank', 'alpha', C.x - 80, C.z + 20, { hp: 700 })],
      match: baseMatch({ flags: [flag('A', 1, 'alpha', 'idle'), flag('B', 1, 'alpha', 'idle'), flag('C', 0.38, null, 'capturing', 3, 1),
        flag('D', -0.5, 'bravo', 'contested', 1, 1), flag('E', -1, 'bravo', 'idle')], bleed: { alpha: 0, bravo: 0 } }),
      camera: cam(C.x - 50, GROUND + 1.6, C.z + 40, 0), bigMap: true }));
  }
  // 16b. Iron Bridge collapsing: held amber banner with its countdown, hazard on the minimap, C chip badge.
  {
    const at = { x: C.x - 34, z: C.z + 2 };
    const self = meAt(at.x, at.z);
    const fallAt = FIXTURE_NOW + 2200;
    const match = baseMatch({ flags: [flag('A', 1, 'alpha', 'idle'), flag('B', 1, 'alpha', 'idle'), flag('C', -0.4, 'bravo', 'neutralizing', 2, 1),
      flag('D', -1, 'bravo', 'idle'), flag('E', -1, 'bravo', 'idle')] });
    match.conquest.br = [2, 0, fallAt];
    out.push(state('bridge-failing', 'Iron Bridge collapsing · countdown banner, map hazard, C chip badge', { self, players: roster(self), match,
      events: [{ kind: 'bridge', bridge: 'iron-bridge', stage: 2, name: 'failing', integrity: 0, fallAt, by: 'en1' }],
      camera: cam(at.x, GROUND + 1.6, at.z, yawTo(at, C), -0.06) }));
  }
  // 16c. Iron Bridge down: full map with the gap and "IRON BRIDGE · DOWN", destroyed banner.
  {
    const self = meAt(C.x - 50, C.z + 40);
    const match = baseMatch({ flags: [flag('A', 1, 'alpha', 'idle'), flag('B', 1, 'alpha', 'idle'), flag('C', 0, null, 'idle'),
      flag('D', -1, 'bravo', 'idle'), flag('E', -1, 'bravo', 'idle')] });
    match.conquest.br = [3, 0];
    out.push(state('bridge-down', 'Iron Bridge destroyed · full map gap, fords, destroyed banner', { self, players: roster(self),
      vehicles: [spottedTank, vehicle('alpha-tank', 'tank', 'alpha', C.x - 80, C.z + 20, { hp: 700 })], match,
      events: [{ kind: 'bridge', bridge: 'iron-bridge', stage: 3, name: 'down', integrity: 0, by: 'en1', blocks: 608 }],
      camera: cam(C.x - 50, GROUND + 1.6, C.z + 40, 0), bigMap: true }));
  }
  // 17. Deploy screen: dead, 3.2 s to respawn, valid spawns plus a refused flag (enemies in B).
  const deployRoster = self => roster(self, [player('en9', 'Draves', 'bravo', B.x + 3, B.z - 2, { cq: { squad: 2 } })]);
  const tankRow = vehicle('alpha-tank', 'tank', 'alpha', 110, 384, { hp: 1000, seatOccupants: { driver: null, commander: null } });
  const heliRow = vehicle('alpha-helicopter', 'helicopter', 'alpha', 96, 360, { hp: 650, seatOccupants: { driver: 'tm1', gunner: null } });
  const deployMatch = () => baseMatch({ flags: [flag('A', 1, 'alpha', 'idle'), flag('B', 0.8, 'alpha', 'neutralizing', 0, 1), flag('C', 0.1, null, 'capturing', 2, 0),
    flag('D', -1, 'bravo', 'idle'), flag('E', -1, 'bravo', 'idle')] });
  {
    const self = meAt(C.x, C.z, { hp: 0, state: 'dead', respawnAt: FIXTURE_NOW + 3200, cq: { squad: 1, kitId: 'engineer' } });
    out.push(state('deploy', 'Deploy · valid spawns, countdown, kit picker', { self, players: deployRoster(self), vehicles: [tankRow, heliRow],
      match: deployMatch(), dead: true, killer: { name: 'Rourke', weaponName: '120MM AP', distance: 142 }, selection: { spawn: 'flag:A', kit: 'engineer', variant: 1 },
      camera: cam(C.x, 40, C.z, 0, -0.5) }));
  }
  {
    const self = meAt(C.x, C.z, { hp: 0, state: 'dead', respawnAt: FIXTURE_NOW - 1500, cq: { squad: 1, kitId: 'assault', down: 1 } });
    out.push(state('deploy-refused', 'Deploy · refused (contested), revive window', { self, players: deployRoster(self), vehicles: [tankRow, heliRow],
      match: deployMatch(), dead: true, killer: { name: 'Sato', weaponName: 'VK-77 RAPTOR', distance: 38, headshot: true },
      selection: { spawn: 'vehicle:alpha-tank:commander', kit: 'assault', variant: 0 },
      events: [{ kind: 'deploy_refused', id: 'me', reason: 'contested' }], camera: cam(C.x, 40, C.z, 0, -0.5) }));
  }
  // 18a. Classes: career LV 3 (the Pyro just unlocked), 1,240 XP toward the Grenadier, the Medic picked.
  {
    const self = meAt(C.x, C.z, { hp: 0, state: 'dead', respawnAt: FIXTURE_NOW + 2400, cq: { squad: 1, kitId: 'medic' } });
    out.push(state('deploy-classes', 'Deploy · nine classes, LV 3, three locked with XP progress', { self, players: deployRoster(self), vehicles: [tankRow, heliRow],
      match: deployMatch(), dead: true, killer: { name: 'Rourke', weaponName: 'ROCKET POD', distance: 96 },
      selection: { spawn: 'hq', kit: 'medic', variant: 0 }, career: { xp: 1240, level: 3, levelStart: 400, nextLevel: 900 },
      events: [{ kind: 'kit_unlocks', id: 'me', level: 3, unlocked: ['assault', 'medic', 'engineer', 'support', 'recon', 'pyro'], newly: ['pyro'] }],
      camera: cam(C.x, 40, C.z, 0, -0.5) }));
  }
  // 18c. A level-1 player asked for a locked class: the server refused it (CLASS LOCKED · LV 5).
  {
    const self = meAt(C.x, C.z, { hp: 0, state: 'dead', respawnAt: FIXTURE_NOW + 1800, cq: { squad: 1, kitId: 'assault' } });
    out.push(state('deploy-locked', 'Deploy · locked class refused, base kits only', { self, players: deployRoster(self), vehicles: [tankRow, heliRow],
      match: deployMatch(), dead: true, killer: { name: 'Sato', weaponName: 'VK-77 RAPTOR', distance: 38 },
      selection: { spawn: 'hq', kit: 'grenadier', variant: 0 }, career: { xp: 260, level: 2, levelStart: 100, nextLevel: 400 },
      events: [{ kind: 'kit_unlocks', id: 'me', level: 2, unlocked: ['assault', 'medic', 'engineer', 'support', 'recon'], newly: [] },
        { kind: 'deploy_refused', id: 'me', reason: 'locked', kit: 'grenadier', level: 5 }],
      camera: cam(C.x, 40, C.z, 0, -0.5) }));
  }
  // 18d. Downed and waiting: the nearest friendly Medic and its distance.
  {
    const self = meAt(C.x, C.z, { hp: 0, state: 'dead', respawnAt: FIXTURE_NOW + 4200, cq: { squad: 1, kitId: 'recon', down: 1 } });
    const medic = player('md1', 'Haldane', 'alpha', C.x + 14, C.z - 18, { cq: { squad: 1, kitId: 'medic' } });
    out.push(state('deploy-down-medic', 'Deploy · awaiting revive, nearest Medic', { self, players: roster(self, [medic]), vehicles: [tankRow, heliRow],
      match: deployMatch(), dead: true, killer: { name: 'Sato', weaponName: 'VK-77 RAPTOR', distance: 38 },
      selection: { spawn: 'hq', kit: 'recon', variant: 0 }, camera: cam(C.x, 40, C.z, 0, -0.5) }));
  }
  // 18e. A Medic in the field: heal aura on the minimap, '+HP' and HEAL / REVIVE awards.
  {
    const self = meAt(C.x - 40, C.z + 30, { hp: 72, cq: { squad: 1, kitId: 'medic' } });
    const wounded = player('wd1', 'Okafor', 'alpha', C.x - 46, C.z + 24, { hp: 41, cq: { squad: 2, kitId: 'assault' } });
    const downed = player('dn1', 'Mercer', 'alpha', C.x - 60, C.z + 4, { hp: 0, state: 'dead', cq: { squad: 1, down: 1 } });
    out.push(state('medic-heal', 'Medic · heal aura, wounded and downed markers, heal awards', { self, players: roster(self, [wounded, downed]), match: baseMatch(),
      events: [{ kind: 'heal', id: 'me', by: 'me', hp: 2.5 }, { kind: 'score', id: 'me', pts: 10, reason: 'heal' }, { kind: 'score', id: 'me', pts: 100, reason: 'revive' }],
      camera: cam(C.x - 40, GROUND + 1.6, C.z + 30, yawTo({ x: C.x - 40, z: C.z + 30 }, { x: C.x - 60, z: C.z + 4 }) + 0.1, -0.12) }));
  }
  // 18b. Deploy screen with the Engineer's AA gadget (AX-9 STINGER) picked.
  {
    const self = meAt(C.x, C.z, { hp: 0, state: 'dead', respawnAt: FIXTURE_NOW + 2400, cq: { squad: 1, kitId: 'engineer' } });
    out.push(state('deploy-aa', 'Deploy · Engineer with the AA STINGER gadget', { self, players: deployRoster(self), vehicles: [tankRow, heliRow],
      match: deployMatch(), dead: true, killer: { name: 'Rourke', weaponName: 'ROCKET POD', distance: 96 },
      selection: { spawn: 'hq', kit: 'engineer', variant: 0, gadget: 1 }, camera: cam(C.x, 40, C.z, 0, -0.5) }));
  }
  // 18f. Recon SPAWN BEACON: a squadmate's beacon offered as a spawn, a second one cooling down,
  // the Recon picked with the beacon gadget (docs/design/conquest/recon).
  {
    const self = meAt(C.x, C.z, { hp: 0, state: 'dead', respawnAt: FIXTURE_NOW + 2600, cq: { squad: 1, kitId: 'recon' } });
    const match = deployMatch();
    match.conquest.recon = { b: [['rb1', 'sq1', 0, C.x - 34, GROUND, C.z + 52, 100, 0, -1], ['rb2', 'sq2', 0, B.x + 40, GROUND, B.z - 30, 100, 42, -1]], s: [], m: [[], []] };
    out.push(state('recon-deploy', 'Deploy · squad SPAWN BEACON, one cooling down, Recon beacon gadget', { self, players: deployRoster(self), vehicles: [tankRow, heliRow],
      match, dead: true, killer: { name: 'Rourke', weaponName: 'VK-77 RAPTOR', distance: 64 },
      selection: { spawn: 'beacon:rb1', kit: 'recon', variant: 0, gadget: 0 }, camera: cam(C.x, 40, C.z, 0, -0.5) }));
  }
  // 18g. Recon in the field: own beacon behind, a MOTION SENSOR ahead revealing two moving enemies.
  {
    const at = { x: C.x - 30, z: C.z + 24 };
    const self = meAt(at.x, at.z, { cq: { squad: 1, kitId: 'recon' }, grenades: [0, 0, 0, 0, 0, 0, 0, 1] });
    const sensor = { x: at.x + 22, z: at.z - 16 };
    const sensedA = player('en5', 'Kovac', 'bravo', sensor.x + 12, sensor.z - 6, { cq: { squad: 2 } });
    const sensedB = player('en6', 'Lindqvist', 'bravo', sensor.x - 4, sensor.z - 18, { cq: { squad: 2 } });
    const match = baseMatch();
    match.conquest.recon = { b: [['rb1', 'me', 0, at.x - 10, GROUND, at.z + 12, 100, 0, -1]],
      s: [['rs1', 'me', 0, sensor.x, GROUND, sensor.z, 160]], m: [['en5', 'en6'], []] };
    out.push(state('recon-sensor', 'Recon · own beacon, motion sensor ring, sensed enemies', { self, players: roster(self, [sensedA, sensedB]), match,
      events: [{ kind: 'recon_gadget', gadget: 'sensor', id: 'rs1', owner: 'me', team: 'alpha', state: 'placed', pos: [sensor.x, GROUND, sensor.z] }],
      camera: cam(at.x, GROUND + 1.6, at.z, yawTo(at, sensor), -0.06) }));
  }
  // 18h. Ribbon earned: the toast under the ticket bar (second MEDIC RIBBON, +50) with the score ticker.
  {
    const self = meAt(C.x - 40, C.z + 30, { hp: 88, cq: { squad: 1, kitId: 'medic' } });
    out.push(state('ribbon', 'Ribbon earned · MEDIC RIBBON ×2 toast and ticker', { self, players: roster(self), match: baseMatch(),
      events: [{ kind: 'score', id: 'me', pts: 100, reason: 'revive' }, { kind: 'score', id: 'me', pts: 50, reason: 'ribbon' },
        { kind: 'ribbon', id: 'me', ribbon: 'medic', count: 2, pts: 50 }],
      camera: cam(C.x - 40, GROUND + 1.6, C.z + 30, yawTo({ x: C.x - 40, z: C.z + 30 }, C), -0.06) }));
  }
  // 18i. A capture banner and a ribbon at once: the toast steps below the banner.
  {
    const self = meAt(C.x + 4, C.z + 6);
    out.push(state('ribbon-banner', 'Ribbon earned under a capture banner · CONQUEST RIBBON', { self, players: roster(self), vehicles: [spottedTank],
      match: baseMatch({ flags: [flag('A', 1, 'alpha', 'idle'), flag('B', 1, 'alpha', 'idle'), flag('C', 1, 'alpha', 'idle'),
        flag('D', -1, 'bravo', 'idle'), flag('E', -1, 'bravo', 'idle')], bleed: { alpha: 0, bravo: 3000 } }),
      events: [{ kind: 'flag_captured', flag: 'C', team: 'alpha' }, { kind: 'score', id: 'me', pts: 250, reason: 'capture' },
        { kind: 'score', id: 'me', pts: 50, reason: 'ribbon' }, { kind: 'ribbon', id: 'me', ribbon: 'conquest', count: 1, pts: 50 }],
      camera: cam(C.x + 4, GROUND + 1.6, C.z + 6, yawTo(C, D) + 0.35) }));
  }
  // 18j. VEHICLES tab: career LV 4 (1,240 XP), the tank's driver seat picked as spawn, three hull upgrades chosen.
  {
    const self = meAt(C.x, C.z, { hp: 0, state: 'dead', respawnAt: FIXTURE_NOW + 3200, cq: { squad: 1, kitId: 'engineer' } });
    out.push(state('deploy-vehicles', 'Deploy · VEHICLES tab, LV 4, hull upgrades, tank spawn', { self, players: deployRoster(self), vehicles: [tankRow, heliRow],
      match: deployMatch(), dead: true, killer: { name: 'Rourke', weaponName: '120MM AP', distance: 142 },
      selection: { spawn: 'vehicle:alpha-tank:driver', kit: 'engineer', variant: 0, tab: 'vehicles', padHull: 'aa',
        upgrades: { tank: 'reactive', jeep: 'turbo', plane: 'extra_flares', helicopter: 'extra_missile', aa: 'reactive' } },
      career: { xp: 1240, level: 4, levelStart: 900, nextLevel: 1600 },
      events: [{ kind: 'kit_unlocks', id: 'me', level: 4, unlocked: ['assault', 'medic', 'engineer', 'support', 'recon', 'pyro'], newly: [] }],
      camera: cam(C.x, 40, C.z, 0, -0.5) }));
  }
  // 18k. Weather: a storm holding (shorter spot / lock ranges, clearing forecast) under a flag banner, with a lightning strike.
  {
    // Between the flags (no capture ring), so the banner shows where it drops under the weather tab.
    const self = meAt(C.x + 4, C.z + 70);
    const match = baseMatch({ flags: [flag('A', 1, 'alpha', 'idle'), flag('B', 1, 'alpha', 'idle'), flag('C', 0.38, null, 'capturing', 3, 1),
      flag('D', -1, 'bravo', 'idle'), flag('E', -1, 'bravo', 'idle')], bleed: { alpha: 0, bravo: 3000 } });
    // wx = [from, to, blend100, etaS, windDeg, wet100, next]: storm holding, overcast in 2:10.
    match.conquest.wx = [3, 3, 0, 130, 40, 82, 1];
    out.push(state('weather-storm', 'Weather · storm: spot 210 m, lock 240 m, clearing 2:10', { self,
      players: roster(self), vehicles: [spottedTank], match,
      camera: cam(C.x + 4, GROUND + 1.6, C.z + 70, yawTo({ x: C.x + 4, z: C.z + 70 }, D) + 0.2),
      events: [{ kind: 'flag_captured', flag: 'B', team: 'alpha' }, { kind: 'weather_strike', x: C.x + 90, y: GROUND, z: C.z - 120 }] }));
  }
  // 18l. Weather: fog lifting into a clear sky, seen by an Engineer (STINGER lock range).
  {
    const self = meAt(B.x + 2, B.z + 3, { cq: { squad: 1, kitId: 'engineer' } });
    const match = baseMatch();
    match.conquest.wx = [2, 0, 35, 31, 300, 0, 0];
    out.push(state('weather-fog', 'Weather · fog lifting: spot 203 m, lock 251 m, clear in 0:31', { self, players: roster(self), vehicles: [alphaHeli], match,
      camera: cam(B.x + 2, GROUND + 1.6, B.z + 3, yawTo(B, C)) }));
  }
  // 19. Scoreboard (squads, objective, vehicles, revives).
  {
    const self = meAt(C.x, C.z);
    out.push(state('scoreboard', 'Scoreboard · squads and Conquest columns', { self, players: roster(self), match: baseMatch(), screen: 'scoreboard',
      camera: cam(C.x, GROUND + 1.6, C.z, 0) }));
  }
  // 20. Result: ticket graph and MVPs.
  {
    const self = meAt(C.x, C.z);
    const graph = Array.from({ length: 61 }, (_, i) => [i * 10_000, Math.max(0, Math.round(300 - i * 2.1 - (i > 30 ? (i - 30) * 1.4 : 0))), Math.max(0, Math.round(300 - i * 2.6 - (i > 40 ? (i - 40) * 3 : 0)))]);
    const match = baseMatch({ phase: 'post', winner: 'alpha', tickets: { alpha: graph.at(-1)[1], bravo: graph.at(-1)[2] } });
    match.conquest.ticketGraph = graph;
    // Debrief rows (contract v6): ribbons cqr, medals cqm, score per category cqp, career cxp [xp, gained].
    const debrief = {
      me: { cqr: [1, 0, 0, 1, 0, 0, 0, 0], cqm: [], cqp: [390, 400, 0, 50, 100], cxp: [3240, 640] },
      sq1: { cqr: [0, 0, 0, 0, 0, 1, 0, 0], cqp: [310, 350, 0, 150, 50] },
      en1: { cqr: [1, 0, 0, 1, 0, 0, 0, 0], cqp: [690, 400, 0, 100, 100] },
    };
    const results = extra => roster(self).map(p => ({ id: p.id, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths, score: p.score, cqs: p.cqs, squad: p.cq[1], bot: p.id !== 'me',
      ...debrief[p.id], ...extra[p.id] }));
    match.results = results({});
    out.push(state('result', 'Result · ticket graph, MVPs and debrief', { self, players: roster(self), match, screen: 'result', camera: cam(C.x, GROUND + 1.6, C.z, 0) }));
    // The same match for a top scorer: two SPREE ribbons earn the VALOR MEDAL, five ribbons the SERVICE MEDAL, and the XP crosses LV 6.
    const medals = { ...match, results: results({ me: { kills: 11, score: 1690, cqs: [400, 1, 6, 2], cqr: [2, 1, 0, 1, 1, 0, 0, 0], cqm: [0, 8],
      cqp: [640, 400, 0, 400, 250], cxp: [2620, 760] } }) };
    out.push(state('result-medals', 'Result · medals and a level-up in the debrief', { self, players: roster(self), match: medals, screen: 'result', camera: cam(C.x, GROUND + 1.6, C.z, 0) }));
  }
  // 21. Squad orders and the comm rose (docs/design/conquest/orders/, variant A).
  // a) A Medic squad leader holds U looking at C: ATTACK C highlighted; a squadmate's NEED MEDIC marker ahead.
  {
    const eye = { x: C.x + 6, z: C.z + 232 };
    const self = meAt(eye.x, eye.z, { cq: { squad: 1, kitId: 'medic' } });
    const look = yawTo(eye, C);
    const nova = player('sq4', 'Nova', 'alpha', eye.x - Math.sin(look) * 30.6 - Math.cos(look) * 14.9, eye.z - Math.cos(look) * 30.6 + Math.sin(look) * 14.9,
      { cq: { squad: 1, kitId: 'assault' }, hp: 38, cqc: [4, 0, null] });
    out.push(state('orders-rose', 'Comm rose · leader aims at C · NEED MEDIC marker', { self, players: roster(self, [nova]), vehicles: [],
      match: baseMatch({ squads: [['alpha', 1, 'me', 'C'], ['alpha', 2, 'tm1', 'A'], ['bravo', 1, 'en1']] }),
      camera: cam(eye.x, GROUND + 1.6, eye.z, look, -0.03), rose: { select: 'order' } }));
  }
  // b) A squad member under a bot leader's ATTACK C order: chip, marker tag, minimap ring, radio lines.
  {
    const eye = { x: C.x - 10, z: C.z + 238 };
    const self = meAt(eye.x, eye.z, { cqc: [7, 1, 'sq2'] });
    out.push(state('orders-chip', 'Squad order ATTACK C · radio: AFFIRMATIVE, AMMO RESPONDING', { self, players: roster(self), vehicles: [],
      match: baseMatch({ squads: [['alpha', 1, 'sq1', 'C'], ['alpha', 2, 'tm1', 'A'], ['bravo', 1, 'en1']] }),
      camera: cam(eye.x, GROUND + 1.6, eye.z, yawTo(eye, C) + 0.22, -0.03),
      events: [{ kind: 'squad_order', team: 'alpha', squad: 1, flag: 'C', by: 'sq1' },
        { kind: 'comm', team: 'alpha', by: 'sq2', comm: 'yes', squad: 1 },
        { kind: 'comm', team: 'alpha', by: 'me', comm: 'ammo', squad: 1, seq: 7 },
        { kind: 'comm_answer', team: 'alpha', seq: 7, comm: 'ammo', by: 'me', responder: 'sq2' }] }));
  }
  // c) The leader orders from the full map: DEFEND B stands, the cursor rests on D.
  {
    const self = meAt(C.x - 50, C.z + 40);
    out.push(state('orders-map', 'Full map · leader picks a flag for the squad order', { self, players: roster(self),
      vehicles: [alphaHeli],
      match: baseMatch({ squads: [['alpha', 1, 'me', 'B'], ['alpha', 2, 'tm1', 'A'], ['bravo', 1, 'en1']] }),
      camera: cam(C.x - 50, GROUND + 1.6, C.z + 40, 0), bigMap: true, mapCursor: { u: D.x / 768, v: D.z / 768 + 0.012 } }));
  }
  // Support mortar: laid on two spotted enemies taking C, 150 m out; four rounds left, the next one loading.
  {
    const at = { x: C.x - 24, z: C.z + 148 }, yaw = yawTo(at, C), pitch = mortarPitchForRange(Math.hypot(C.x - at.x, C.z - at.z));
    const self = meAt(at.x + 0.2, at.z + 0.6, { vehicleId: 'alpha-mortar-me', vehicleSeatId: 'operator', cq: { squad: 1, kitId: 'support' } });
    const mortar = vehicle('alpha-mortar-me', 'mortar', 'alpha', at.x, at.z, { hp: 150, yaw, own: 'me', seatOccupants: { operator: 'me' },
      mounts: [[yaw, pitch, 4, 0, 35]], st: 0 });
    const players = roster(self, [player('en4', 'Dahl', 'bravo', C.x + 3, C.z - 2, { cq: { squad: 2, spotted: 1 } }),
      player('en5', 'Moreau', 'bravo', C.x - 4, C.z + 3, { cq: { squad: 2, spotted: 1, kitId: 'engineer' } })]);
    const back = 5.5, lift = 3.2 + Math.hypot(C.x - at.x, C.z - at.z) * 0.03;
    const camAt = { x: at.x + Math.sin(yaw) * back, y: GROUND + 0.82 + lift, z: at.z + Math.cos(yaw) * back };
    out.push(state('mortar', 'Support mortar · laid on C · 4 / 5 rounds · loading', { self, players, vehicles: [mortar, spottedTank],
      match: baseMatch({ flags: [flag('A', 1, 'alpha', 'idle'), flag('B', 1, 'alpha', 'idle'), flag('C', 0.3, 'bravo', 'neutralizing', 0, 2),
        flag('D', -1, 'bravo', 'idle'), flag('E', -1, 'bravo', 'idle')] }),
      camera: cam(camAt.x, camAt.y, camAt.z, yaw, Math.atan2(GROUND - camAt.y, Math.hypot(C.x - camAt.x, C.z - camAt.z))),
      groundPlane: GROUND, events: [{ kind: 'mortar', id: 'me', state: 'placed', vehicleId: 'alpha-mortar-me' }] }));
  }
  // Support on foot with the M-81 MORTAR picked, 150 m behind C: the kit wheel and the touch MORTAR place it.
  {
    const self = meAt(C.x - 24, C.z + 150, { cq: { squad: 1, kitId: 'support' } });
    out.push(state('mortar-ready', 'Support on foot · M-81 MORTAR ready to place', { self, players: roster(self), vehicles: [spottedTank],
      match: baseMatch(), selection: { kit: 'support', variant: 0, gadget: 1 },
      camera: cam(C.x - 24, GROUND + 1.6, C.z + 150, yawTo({ x: C.x - 24, z: C.z + 150 }, C)) }));
  }
  // Engineer FPV drone: 22 m over the field, 268 m from the crouched operator, closing on the spotted tank by C.
  // `fpv` is FpvPilot.telemetry of that row (the battery from the row, the signal and the static from its link length).
  // The kill feed shows an earlier drone's kill and a mate's mortar kill in the deployables' slot art.
  {
    const op = { x: C.x - 40, z: C.z + 260 }, tank = spottedTank;
    const at = { x: tank.x - 40, z: tank.z + 60 }, yaw = yawTo(at, tank), up = 22;
    const self = meAt(op.x, op.z, { cq: { squad: 1, kitId: 'engineer' }, cqf: 1, crouch: true });
    const drone = vehicle('fpv-me', 'fpv', 'alpha', at.x, at.z, { y: GROUND + up, hp: 8, yaw, pitch: -0.18, roll: 0.1, speed: 24, own: 'me',
      fpv: [64, 0, -32, 268, 0], mounts: [], st: VEHICLE_STATUS.engine });
    out.push(state('fpv', 'Engineer FPV drone · 26 s battery · 3 / 4 signal · closing on the tank', { self, players: roster(self),
      vehicles: [drone, spottedTank], match: baseMatch(), selection: { kit: 'engineer', variant: 0, gadget: 2 },
      camera: { ...cam(at.x, GROUND + up + 0.14, at.z, yaw, Math.atan2(GROUND + 1 - (GROUND + up), Math.hypot(tank.x - at.x, tank.z - at.z))), fov: 104 },
      fpv: fpvFixtureTelemetry(268, { altitude: up }),
      events: [{ kind: 'kill', killer: 'me', victim: 'en1', w: 'fpv' }, { kind: 'kill', killer: 'sq2', victim: 'en2', w: 'mortarHE' },
        { kind: 'fpv', id: 'me', state: 'launched', vehicleId: 'fpv-me', left: 1 }] }));
  }
  // 21. Breakthrough (docs/conquest.md, Breakthrough): WEST attacks, sector 1 (A B) fell, C is active, D E locked.
  const E = FRONTIER_PLAN.flags.find(f => f.id === 'E');
  {
    const self = meAt(C.x + 4, C.z + 6);
    out.push(state('bt-attack', 'Breakthrough · attacking sector 2 · sector 1 captured, +20 tickets', { self,
      players: roster(self, [player('sq3', 'Halden', 'alpha', C.x - 5, C.z + 2, { cq: { squad: 1 } })]), vehicles: [spottedTank],
      match: breakthroughMatch({ sector: 1, tickets: 22, flags: [flag('A', 1, 'alpha', 'idle'), flag('B', 1, 'alpha', 'idle'),
        flag('C', -0.38, 'bravo', 'neutralizing', 3, 1), flag('D', -1, 'bravo', 'idle'), flag('E', -1, 'bravo', 'idle')] }),
      camera: cam(C.x + 4, GROUND + 1.6, C.z + 6, yawTo(C, D) + 0.35),
      events: [{ kind: 'sector_captured', sector: 0, next: 1, team: 'alpha', flags: ['A', 'B'], refill: BREAKTHROUGH_RULES.refillPerSector, tickets: 22, graceEndsAt: null }] }));
  }
  // 22. Breakthrough defender (EAST attacks here, so WEST holds): sector E D just fell, the player stands behind the new line inside the grace.
  {
    const self = meAt(D.x - 30, D.z + 40, { cq: { squad: 1, kitId: 'support' } });
    out.push(state('bt-fallback', 'Breakthrough · defending · sector lost, fall back inside the grace', { self, players: roster(self),
      match: breakthroughMatch({ attackers: 'bravo', sector: 1, tickets: 26, graceEndsAt: FIXTURE_NOW + 12_400,
        flags: [flag('A', 1, 'alpha', 'idle'), flag('B', 1, 'alpha', 'idle'), flag('C', 1, 'alpha', 'idle'),
          flag('D', -1, 'bravo', 'idle'), flag('E', -1, 'bravo', 'idle')] }),
      camera: cam(D.x - 30, GROUND + 1.6, D.z + 40, yawTo({ x: D.x - 30, z: D.z + 40 }, C)),
      events: [{ kind: 'sector_captured', sector: 0, next: 1, team: 'bravo', flags: ['E', 'D'], refill: BREAKTHROUGH_RULES.refillPerSector, tickets: 26, graceEndsAt: FIXTURE_NOW + 12_400 }] }));
  }
  // 23. Breakthrough overtime: the attackers ran out of tickets while contesting E in the last sector.
  {
    const self = meAt(E.x - 4, E.z + 3);
    out.push(state('bt-overtime', 'Breakthrough · attacking the last sector · overtime at 0 tickets', { self, players: roster(self),
      match: breakthroughMatch({ sector: 2, tickets: 0, overtime: true, flags: [flag('A', 1, 'alpha', 'idle'), flag('B', 1, 'alpha', 'idle'),
        flag('C', 1, 'alpha', 'idle'), flag('D', 1, 'alpha', 'idle'), flag('E', -0.6, 'bravo', 'contested', 2, 2)] }),
      camera: cam(E.x - 4, GROUND + 1.6, E.z + 3, yawTo(E, D) + Math.PI),
      events: [{ kind: 'sector_overtime', team: 'alpha' }] }));
  }
  // 24. Breakthrough deploy: the attackers' HQ moved up to the taken sector (FORWARD HQ at A B).
  {
    const self = meAt(C.x, C.z, { hp: 0, state: 'dead', respawnAt: FIXTURE_NOW + 2600, cq: { squad: 1, kitId: 'assault' } });
    out.push(state('bt-deploy', 'Breakthrough · deploy · forward HQ on the taken sector', { self, players: deployRoster(self), vehicles: [tankRow],
      match: breakthroughMatch({ sector: 1, tickets: 22, flags: [flag('A', 1, 'alpha', 'idle'), flag('B', 1, 'alpha', 'idle'),
        flag('C', -1, 'bravo', 'idle'), flag('D', -1, 'bravo', 'idle'), flag('E', -1, 'bravo', 'idle')] }),
      dead: true, killer: { name: 'Rourke', weaponName: 'VK-77 RAPTOR', distance: 64 }, selection: { spawn: 'hq', kit: 'assault', variant: 0 },
      camera: cam(C.x, 40, C.z, 0, -0.5) }));
  }
  out.push(...comebackHudFixtures({ state, roster, baseMatch, meAt, cam, yawTo, C, D, GROUND, meta: fixtureMapMeta(), now: FIXTURE_NOW }));
  out.push(...radarHudFixtures({ state, roster, baseMatch, meAt, cam, yawTo, vehicle, GROUND, now: FIXTURE_NOW }));
  // 25. Hollin Fuel Depot (docs/conquest.md "Hollin Fuel Depot"): the chain reaction 2 s from the last burst, then
  // ablaze 10 s into the active phase (fire on the tanks and the canopy, the smoke column on the maps).
  {
    const depot = mapEventsFor('frontier').findIndex(d => d.id === 'depot');
    const at = { x: 392, z: 431 }, anchor = { x: 512, z: 425 };
    const flags = () => [flag('A', 1, 'alpha', 'idle'), flag('B', 1, 'alpha', 'idle'), flag('C', 0.4, 'alpha', 'restoring'),
      flag('D', -1, 'bravo', 'idle'), flag('E', -1, 'bravo', 'idle')];
    if (depot >= 0) {
      const self = meAt(at.x, at.z);
      const chain = baseMatch({ flags: flags() });
      chain.conquest.ev = [[depot, 2, 0, 1, 20, [0, 100, 100]]];
      out.push(state('depot-chain', 'Hollin Fuel Depot · chain reaction · blast radius on the map', { self, players: roster(self), match: chain,
        events: [{ kind: 'map_event', event: 'depot', phase: 'warning', team: 'bravo', by: 'en1', endsAt: FIXTURE_NOW + 2000, pos: [512, 31, 425] }],
        camera: cam(at.x, GROUND + 1.6, at.z, yawTo(at, anchor)) }));
      const ablaze = baseMatch({ flags: flags() });
      ablaze.conquest.ev = [[depot, 3, 0, 1, 1700]];
      const near = { x: 452, z: 440 };
      const self2 = meAt(near.x, near.z);
      out.push(state('depot-ablaze', 'Hollin Fuel Depot · ablaze · burning ground and the smoke column', { self: self2, players: roster(self2), match: ablaze,
        events: [{ kind: 'map_event', event: 'depot', phase: 'active', team: 'bravo', by: 'en1', endsAt: FIXTURE_NOW + 170_000, pos: [512, 31, 425] }],
        camera: cam(near.x, GROUND + 1.6, near.z, yawTo(near, anchor)) }));
    }
  }
  // Redrock Dam breach (docs/conquest.md "Redrock Dam breach"; --map redrock only, the `ev` index is Redrock's).
  if (map === 'redrock') out.push(...damFixtures(meAtY));
  return out;
}

/**
 * A Breakthrough match.conquest: attacker-only tickets (BREAKTHROUGH_RULES pool), no bleed
 * field, the `bt` tuple [attackers, sector, 'AB.C.DE', graceEndsAt, overtime].
 */
function breakthroughMatch({ attackers = 'alpha', sector = 0, tickets = BREAKTHROUGH_RULES.tickets, graceEndsAt = 0, overtime = false, flags, phase = 'live', winner } = {}) {
  const match = baseMatch({ flags, phase, winner, tickets: { alpha: attackers === 'alpha' ? tickets : 0, bravo: attackers === 'bravo' ? tickets : 0 } });
  delete match.conquest.bleed;
  match.conquest.maxTickets = BREAKTHROUGH_RULES.tickets;
  match.conquest.endsAt = FIXTURE_NOW + 24 * 60_000 + 18_000;
  match.conquest.bt = [attackers, sector, attackers === 'alpha' ? 'AB.C.DE' : 'ED.C.BA', graceEndsAt, overtime ? 1 : 0];
  return match;
}


/**
 * Redrock Dam fixtures: the enemy's charges armed with 12 s of fuse (WEST at
 * the west portal, the DEFUSE prompt, the charge pips and stripes on the
 * minimap), and the breach under way on the full map (the lake bed showing
 * through, the canyon in flood down to the wave front, the gap in the crest).
 */
function damFixtures(meAtY) {
  const index = mapEventsFor('redrock').indexOf(DAM_EVENT);
  const pointIndex = id => DAM_EVENT.points.findIndex(p => p.id === id);
  const flags = [flag('A', 1, 'alpha', 'idle'), flag('B', 1, 'alpha', 'idle'), flag('C', -1, 'bravo', 'idle'),
    flag('D', -1, 'bravo', 'idle'), flag('E', -1, 'bravo', 'idle')];
  const out = [];
  const [west] = DAM_TUNING.charges;
  {
    const self = meAtY(west.x + 0.4, west.y, west.z + 1.4);
    const match = baseMatch({ flags });
    match.conquest.ev = [encodeMapEventRow(index, { phase: 'armed', progress: 0.7, team: 'bravo', leftMs: 12000, extra: [3, 0, 0] })];
    match.conquest.evp = ['defuse-west', 'defuse-east'].map(id => encodeMapEventPoint(index, pointIndex(id), { teams: new Set(['alpha']), progress: 0, userTeam: null }));
    out.push(state('dam-armed', 'Redrock Dam · enemy charges armed, 12 s fuse, DEFUSE prompt at the west portal', { self, players: roster(self), match,
      events: [{ kind: 'map_event', event: 'dam', phase: 'armed', reason: 'fuse', team: 'bravo', by: 'en1', endsAt: FIXTURE_NOW + 12000, pos: [384, 24, 384] }],
      camera: cam(self.x, self.y + 1.6, self.z, 0, 0) }));
  }
  {
    const self = meAtY(352, 34, 395);
    const match = baseMatch({ flags });
    match.conquest.ev = [encodeMapEventRow(index, { phase: 'active', progress: 0.55, team: 'bravo', leftMs: null, extra: [3, 55, 548] })];
    out.push(state('dam-breached', 'Redrock Dam breached · full map: lake bed, flooded canyon to the wave front, crest gap', { self, players: roster(self), match,
      events: [{ kind: 'map_event', event: 'dam', phase: 'active', team: 'bravo', by: 'en1', pos: [384, 24, 384] }],
      camera: cam(self.x, self.y + 1.6, self.z, yawTo(self, { x: 384, z: 420 }), -0.1), bigMap: true }));
  }
  return out;
}
