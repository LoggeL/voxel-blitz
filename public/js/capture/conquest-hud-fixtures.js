/**
 * Snapshot-shaped Conquest HUD fixtures (wire format: match.conquest tuples,
 * players[].cq / cqs, vehicles[] rows with mounts / sel / st / lk / sp / cmr)
 * for the static capture page and the Node UI suites. Positions come from the
 * frozen FRONTIER_PLAN; nothing here is read by the live game.
 */
import { FRONTIER_PLAN, KIT_IDS, VEHICLE_STATUS, vehicleMountOrder } from '../../../shared/conquest-contract.js';
import { WEAPON_IDS } from '../../../shared/combatmath.js';
import { encodeConquestFlag } from '../../../shared/conquest.js';

export const FIXTURE_NOW = 2_000_000;
const GROUND = 26;
const HQ_Y = FRONTIER_PLAN.heights.hqPlateau;

/** mapMeta with the Conquest statics the client merges (flags with y, bases, combat area). */
export function fixtureMapMeta() {
  const flags = FRONTIER_PLAN.flags.map(f => ({ ...f, y: GROUND, spawns: [] }));
  const bases = Object.fromEntries(Object.entries(FRONTIER_PLAN.hqs).map(([team, hq]) => [team, { id: team, ...hq, y: HQ_Y, spawns: [] }]));
  return {
    id: 'frontier', name: 'Frontier', dimensions: { ...FRONTIER_PLAN.dimensions },
    conquest: { version: 2, flags, bases, combatArea: { ...FRONTIER_PLAN.combatArea }, vehicleSpawns: [], roads: [], crossings: FRONTIER_PLAN.crossings.map(c => ({ ...c, y: GROUND })), weather: 'golden' },
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

function baseMatch({ flags, tickets = { alpha: 214, bravo: 187 }, bleed = { alpha: 0, bravo: 0 }, phase = 'live', winner } = {}) {
  return {
    mode: 'conquest', map: 'frontier', phase, ...(winner !== undefined ? { winner } : {}),
    scores: { ...tickets },
    conquest: { v: 2, tickets, maxTickets: 300, bleed, endsAt: FIXTURE_NOW + 14 * 60_000 + 32_000,
      flags: flags ?? [flag('A', 1, 'alpha', 'idle'), flag('B', 1, 'alpha', 'idle'), flag('C', 0, null, 'idle'),
        flag('D', -1, 'bravo', 'idle'), flag('E', -1, 'bravo', 'idle')],
      squads: [['alpha', 1, 'me'], ['alpha', 2, 'tm1'], ['bravo', 1, 'en1']] },
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

/** A state: everything ConquestHud.update needs plus events to replay and capture hints. */
function state(id, title, { selfTeam = 'alpha', self, players, vehicles = [], match, camera, events = [], dead = false, killer = null,
  bigMap = false, nearbyVehicle = null, interactHeld = null, selection = null, screen = 'hud', touch = null, career = null } = {}) {
  return { id, title, selfTeam, self, players, vehicles, match, camera, events, dead, killer, bigMap, nearbyVehicle, interactHeld, selection, screen, touch, career };
}

/** Every HUD state the acceptance list names, in capture order. */
export function conquestHudFixtures() {
  const out = [];
  const meAt = (x, z, extra = {}) => player('me', 'You', 'alpha', x, z, { cq: { squad: 1, kitId: 'assault' }, kills: 5, deaths: 2, score: 940, cqs: [400, 1, 1, 2], ...extra });
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
  const tankAt = { x: C.x - 70, z: C.z + 20 };
  {
    const self = meAt(tankAt.x, tankAt.z, { vehicleId: 'alpha-tank', vehicleSeatId: 'driver' });
    const tank = vehicle('alpha-tank', 'tank', 'alpha', tankAt.x, tankAt.z, { hp: 230, yaw: yawTo(tankAt, C), turretYaw: yawTo(tankAt, C) + 0.12,
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
      seatOccupants: { driver: 'sq2', commander: 'me' }, mounts: [[yaw, 0, 6, 0, 0], [yaw, 0, -1, 0, 0], [yaw + 0.3, 0.05, -1, 81, 0]], sel: { driver: 1 }, cmr: 100 });
    out.push(state('tank-commander', 'Tank commander · RWS hot', { self, players: roster(self), vehicles: [tank, spottedTank], match: baseMatch(),
      camera: cam(tankAt.x + 0.6, GROUND + 3.4, tankAt.z + 0.4, yaw + 0.3, -0.02) }));
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
    const vx = -Math.sin(yaw) * 92, vz = -Math.cos(yaw) * 92;
    const jet = vehicle('alpha-plane', 'plane', 'alpha', jetAt.x, jetAt.z, { y: 140, hp: 450, yaw, pitch: -0.04, roll: 0.1,
      seatOccupants: { driver: 'me' }, mounts: [[yaw, -0.04, -1, 35, 0], [yaw, -0.04, 1, 0, 30]], sel: { driver: 1 }, airspeed: 92, vx, vy: -3, vz, cmr: 100, lk: 0 });
    const target = vehicle('bravo-helicopter', 'helicopter', 'bravo', jetAt.x - Math.sin(yaw) * 260 + 25, jetAt.z - Math.cos(yaw) * 260, { y: 128, hp: 600, sp: 1, vx: 12, vy: 0, vz: -20 });
    out.push(state('jet', 'Jet · AA missile selected · lead pipper · locking 70 %', { self, players: roster(self), vehicles: [jet, target],
      match: baseMatch(), camera: cam(jetAt.x + Math.sin(yaw) * 17, 144.4, jetAt.z + Math.cos(yaw) * 17, yaw, -0.02) }));
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
    match.results = roster(self).map(p => ({ id: p.id, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths, score: p.score, cqs: p.cqs, squad: p.cq[1], bot: p.id !== 'me' }));
    out.push(state('result', 'Result · ticket graph and MVPs', { self, players: roster(self), match, screen: 'result', camera: cam(C.x, GROUND + 1.6, C.z, 0) }));
  }
  return out;
}
