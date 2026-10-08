// Bots ride with humans (BotCommander.planHitches) on the real Frontier map:
// a hull a human drives or pilots gets its gunner seats filled first, then
// its passenger seats, by the driver's squad mates first; riders stay aboard
// while the human drives, get out at a flag they want, when the human leaves
// or after a long idle stop; no bot ever takes a human's seat; and a bot
// holding a threatened flag never leaves it for a ride.
import assert from 'node:assert/strict';
import { createMapState, getMapMeta } from '../shared/worlddata.js';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { HITCH_RADIUS } from '../server/bot-commander.js';
import { vehicleSeatOccupantId, vehicleSeats } from '../shared/vehicle-seats.js';
import { VEHICLE_TOPOLOGY } from '../shared/conquest-contract.js';
import { mulberry32 } from '../shared/noise.js';

Math.random = mulberry32(Number(process.env.VB_TEST_SEED ?? 1));

const meta = getMapMeta('frontier');
const world = createMapState('frontier');
const STEPS_PER_S = Math.round(1000 / TICK_MS);
let checks = 0;
const check = (cond, msg) => { assert(cond, msg); checks++; };

function fixture(bots = 15) {
  const game = new GameEngine({ mode: 'conquest', world, mapMeta: meta, broadcast: () => {} });
  const manager = attachBots(game, bots);
  game.step(TICK_MS);
  game.addClient('human', 'Human');
  const human = game.entities.get('human');
  const team = game.mode.teamFor(human);
  const squads = game.mode.policy.squads;
  const commander = manager.commander;
  const ts = () => commander.teams.get(team);
  const replan = () => { game.mode.policy._view = null; commander.viewAt = -1; commander.plan(game.now); };
  const hull = type => [...game.vehicles.vehicles.values()].find(v => v.team === team && v.type === type && !v.flag && !v.id.startsWith('flag-'));
  const teamBots = () => [...game.entities.values()].filter(p => p.bot && game.mode.teamFor(p) === team);
  const squadMates = () => teamBots().filter(p => squads.squadOf(p.id) === squads.squadOf(human.id));
  const seat = (v, id) => vehicleSeatOccupantId(v, id);
  const humanSeats = new Map();
  const run = (seconds, until = null) => {
    for (let i = 0; i < seconds * STEPS_PER_S; i++) {
      game.step(TICK_MS);
      // No bot ever holds a seat a human holds.
      for (const [vehicleId, seats] of humanSeats) {
        const v = game.vehicles.vehicles.get(vehicleId);
        for (const [seatId, id] of seats) assert.equal(seat(v, seatId), id, `${id} keeps ${vehicleId}:${seatId}`);
      }
      if (until?.()) return true;
    }
    return until ? !!until() : true;
  };
  const board = (p, v, seatId) => {
    Object.assign(p, { x: v.x + 1, y: v.y, z: v.z + 1 });
    assert(game.vehicles.enter(p, v.id, seatId), `${p.id} enters ${v.id}:${seatId}`);
    if (!p.bot) {
      if (!humanSeats.has(v.id)) humanSeats.set(v.id, new Map());
      humanSeats.get(v.id).set(seatId, p.id);
    }
  };
  const leave = (p) => { for (const seats of humanSeats.values()) for (const [seatId, id] of seats) if (id === p.id) seats.delete(seatId); game.vehicles.exit(p); };
  // Bots near a point, standing on the hull's ground (HQ spawns are flat).
  const placeNear = (bots, v, radius = 14) => bots.forEach((p, i) => {
    const a = i * 2.1;
    Object.assign(p, { x: v.x + Math.cos(a) * radius, y: v.y + 0.02, z: v.z + Math.sin(a) * radius, vx: 0, vy: 0, vz: 0 });
  });
  const dispose = () => { manager.dispose(); game.stop(); };
  return { game, manager, commander, human, team, ts, replan, hull, teamBots, squadMates, seat, run, board, leave, placeNear, dispose, humanSeats };
}

const gunnerSeats = type => (VEHICLE_TOPOLOGY[type] ?? []).filter(s => s.role === 'gunner').map(s => s.id);
const passengerSeats = type => (VEHICLE_TOPOLOGY[type] ?? []).filter(s => s.role === 'passenger').map(s => s.id);

// --- jeep: squad mates first, gunner first; they ride on and get out when the human leaves ---
{
  const f = fixture();
  const jeep = f.hull('jeep');
  f.board(f.human, jeep, 'driver');
  const mates = f.squadMates();
  check(mates.length >= 1, `the human has bot squad mates (${mates.length})`);
  f.placeNear(mates, jeep, 16);
  f.replan();
  const bookings = [...f.ts().hitches].filter(([, h]) => h.vehicleId === jeep.id);
  check(bookings.length >= Math.min(3, mates.length), `the jeep's free seats are booked (${bookings.map(([id, h]) => `${id}:${h.seatId}`)})`);
  const gunnerBooking = bookings.find(([, h]) => h.seatId === 'gunner');
  check(gunnerBooking && mates.some(p => p.id === gunnerBooking[0]), 'the gunner seat goes to a squad mate');
  check(bookings.every(([, h]) => h.seatId !== 'driver'), 'nobody is booked into the human\'s seat');
  const filled = f.run(20, () => f.seat(jeep, 'gunner') != null && f.game.entities.get(f.seat(jeep, 'gunner'))?.bot);
  check(filled, `a bot mans the jeep HMG within 20 s (gunner ${f.seat(jeep, 'gunner')})`);
  f.run(6);
  const riders = vehicleSeats(jeep).filter(s => !s.drives).map(s => f.seat(jeep, s.id)).filter(Boolean);
  check(riders.length >= Math.min(3, mates.length), `squad mates fill the seats (${riders.length} aboard)`);
  check(f.commander.crewFor(riders[0])?.role === 'hitch', 'riders hold a hitch order');
  // The human drives off: riders stay aboard while moving.
  f.game.applyInput(f.human.id, { keys: {}, vehicleThrottle: 1, vehicleSteer: 0, yaw: jeep.yaw, pitch: 0, wantFire: false });
  f.run(3);
  check(Math.abs(jeep.speed) > 2, `the human drives (${jeep.speed.toFixed(1)} m/s)`);
  check(riders.every(id => f.game.entities.get(id)?.vehicleId === jeep.id), 'riders stay aboard while the human drives');
  // The human stops and gets out: the riders follow once stopped.
  f.game.applyInput(f.human.id, { keys: {}, vehicleThrottle: 0, vehicleBrake: 1, yaw: jeep.yaw, pitch: 0, wantFire: false });
  f.run(3, () => Math.abs(jeep.speed) < 0.3);
  f.leave(f.human);
  const out = f.run(4, () => vehicleSeats(jeep).every(s => f.seat(jeep, s.id) == null));
  check(out, `riders get out once the human left (${vehicleSeats(jeep).map(s => f.seat(jeep, s.id))})`);
  check(riders.every(id => !f.ts().hitches.has(id)), 'and their hitch orders end');
  f.dispose();
}

// --- bots already aboard (a squad ride the human took over) ride with the human ---
{
  const f = fixture();
  const jeep = f.hull('jeep');
  const [a, b] = f.teamBots().filter(p => !f.ts().crews.has(p.id)).slice(0, 2);
  f.board(a, jeep, 'gunner');
  f.board(b, jeep, 'rear-left');
  f.board(f.human, jeep, 'driver');
  f.replan();
  check(f.commander.crewFor(a.id)?.role === 'hitch' && f.commander.crewFor(b.id)?.role === 'hitch', 'bots aboard a human-driven hull hold hitch orders');
  check(![...f.ts().transits.values()].some(t => t.vehicleId === jeep.id), 'no squad ride runs on a hull a human drives');
  f.run(3);
  check(a.vehicleId === jeep.id && b.vehicleId === jeep.id, 'and stay aboard while the human sits at the wheel');
  f.dispose();
}

// --- tank: the commander RWS is manned; a human in a gunner seat is never displaced ---
{
  const f = fixture();
  const tank = f.hull('tank');
  // The tank is a crew priority: take the wheel before a bot crew walks in.
  for (const id of [vehicleSeatOccupantId(tank, 'driver'), vehicleSeatOccupantId(tank, 'commander')]) if (id) f.game.vehicles.exit(f.game.entities.get(id));
  f.board(f.human, tank, 'driver');
  f.placeNear(f.teamBots().slice(0, 6), tank, 18);
  const manned = f.run(20, () => f.game.entities.get(f.seat(tank, 'commander') ?? '')?.bot === true);
  check(manned, 'a bot mans the tank commander RWS within 20 s');
  check(f.seat(tank, 'driver') === f.human.id, 'the human keeps the wheel');
  f.dispose();
}
{
  // A second human in the jeep's gunner seat: bots fill only the passenger seats.
  const f = fixture();
  const jeep = f.hull('jeep');
  f.game.addClient('human2', 'Gunner');
  const gunner = f.game.entities.get('human2');
  if (f.game.mode.teamFor(gunner) !== f.team) f.game.mode.setLobbyTeam?.(gunner, f.team);
  check(f.game.mode.teamFor(gunner) === f.team, 'the second human plays on the same team');
  {
    f.board(f.human, jeep, 'driver');
    f.board(gunner, jeep, 'gunner');
    f.placeNear([...f.squadMates(), ...f.teamBots()].slice(0, 6), jeep, 14);
    f.replan();
    check([...f.ts().hitches.values()].every(h => h.seatId !== 'gunner' && h.seatId !== 'driver'), 'no booking targets a human-held seat');
    f.run(15);
    check(f.seat(jeep, 'gunner') === gunner.id && f.seat(jeep, 'driver') === f.human.id, 'both humans keep their seats');
  }
  f.dispose();
}

// --- transport: door guns first, then passengers ---
{
  const f = fixture();
  const transport = f.hull('transport');
  for (const s of vehicleSeats(transport)) { const id = vehicleSeatOccupantId(transport, s.id); if (id) f.game.vehicles.exit(f.game.entities.get(id)); }
  f.board(f.human, transport, 'driver');
  // Only two riders available: they take the two door guns.
  const two = f.squadMates().slice(0, 2);
  f.placeNear(two, transport, 16);
  for (const p of f.teamBots().filter(p => !two.includes(p))) Object.assign(p, { x: transport.x + 200, z: transport.z });
  f.replan();
  const seats = [...f.ts().hitches.values()].filter(h => h.vehicleId === transport.id).map(h => h.seatId).sort();
  check(two.length < 2 || JSON.stringify(seats) === JSON.stringify(gunnerSeats('transport').sort()), `two riders are booked on the door guns (${seats})`);
  check(passengerSeats('transport').length === 2, 'the transport has passenger seats');
  const doors = f.run(20, () => gunnerSeats('transport').every(id => f.game.entities.get(f.seat(transport, id) ?? '')?.bot));
  check(two.length < 2 || doors, 'bots man both door guns within 20 s');
  f.dispose();
}

// --- drop at a wanted flag, and the human-driven jeep at a flag takes nobody new ---
{
  const f = fixture();
  const jeep = f.hull('jeep');
  f.board(f.human, jeep, 'driver');
  const mates = f.squadMates();
  f.placeNear(mates, jeep, 12);
  f.run(20, () => f.game.entities.get(f.seat(jeep, 'gunner') ?? '')?.bot === true);
  const riders = vehicleSeats(jeep).filter(s => !s.drives).map(s => f.seat(jeep, s.id)).filter(Boolean);
  check(riders.length >= 1, 'riders aboard before the drive');
  // The human "drives" to a flag the team does not own (flag C, neutral): put the hull on the C tank pad.
  const pad = meta.conquest.vehicleSpawns.find(s => s.flag === 'C');
  const flagC = meta.conquest.flags.find(fl => fl.id === 'C');
  const near = { x: flagC.x + (pad.x - flagC.x) * 0.6, z: flagC.z + (pad.z - flagC.z) * 0.6 };
  const padTank = f.game.vehicles.vehicles.get('flag-C-tank');
  if (padTank) Object.assign(padTank, { x: padTank.x, z: padTank.z - 30 });
  let placed = false;
  for (let dy = 0; dy < 6 && !placed; dy++) {
    const y = flagC.y - 1.02 + dy;
    if (f.game.vehicles.clearHull(jeep, near.x, y, near.z)) { Object.assign(jeep, { x: near.x, y, z: near.z, speed: 0, vx: 0, vz: 0 }); placed = true; }
  }
  check(placed, 'the jeep sits beside flag C');
  const out = f.run(6, () => riders.every(id => f.game.entities.get(id)?.vehicleId !== jeep.id));
  check(out, `riders get out at flag C (${riders.map(id => f.game.entities.get(id)?.vehicleId)})`);
  f.replan();
  check(![...f.ts().hitches.values()].some(h => h.vehicleId === jeep.id), 'a hull standing at a wanted flag takes no new riders');
  f.dispose();
}

// --- a bot holding a threatened flag stays; a free bot at the same range rides ---
{
  const f = fixture();
  const flagA = f.game.mode.policy.flags.find(fl => fl.id === 'A');
  const A = meta.conquest.flags.find(fl => fl.id === 'A');
  const jeep = f.game.vehicles.vehicles.get('flag-A-jeep');
  // Make A ours and put the jeep 40 m out on its far side (outside the drop zone).
  flagA.owner = f.team; flagA.control = f.team === 'alpha' ? 1 : -1;
  for (const s of vehicleSeats(jeep)) { const id = vehicleSeatOccupantId(jeep, s.id); if (id) f.game.vehicles.exit(f.game.entities.get(id)); }
  jeep.team = f.team;
  const dir = { x: -1, z: 0 };
  let spot = null;
  for (let r = 40; r <= 44 && !spot; r++) for (let dy = -3; dy < 6 && !spot; dy++) {
    const x = A.x + dir.x * r, z = A.z + dir.z * r, y = Math.floor(A.y) + dy;
    if (f.game.vehicles.clearHull(jeep, x, y, z) && !f.game.vehicles.clearHull(jeep, x, y - 0.3, z)) spot = { x, y, z };
  }
  check(!!spot, 'a parking spot 40 m west of flag A');
  Object.assign(jeep, spot, { speed: 0, vx: 0, vz: 0 });
  f.board(f.human, jeep, 'driver');
  const bots = f.teamBots();
  const [defender, free] = bots;
  for (const p of bots.slice(2)) Object.assign(p, { x: p.x, z: p.z }); // the rest stay at HQ (far away)
  Object.assign(defender, { x: A.x - 12, y: A.y, z: A.z }); // inside A, 28 m from the jeep
  Object.assign(free, { x: A.x - 75, y: A.y, z: A.z });   // 35 m behind the jeep, outside A's alert ring
  check(Math.hypot(free.x - jeep.x, free.z - jeep.z) <= HITCH_RADIUS, 'the free bot is in hitch range');
  // An enemy inside A: the flag is threatened and contested.
  const enemy = [...f.game.entities.values()].find(p => p.bot && f.game.mode.teamFor(p) !== f.team);
  Object.assign(enemy, { x: A.x + 6, y: A.y, z: A.z + 4 });
  for (let i = 0; i < 4; i++) f.replan();
  const ts = f.ts();
  check(ts.threatened.some(fl => fl.id === 'A'), 'flag A is threatened');
  check(!ts.hitches.has(defender.id), 'the bot holding threatened flag A is not booked');
  check(ts.hitches.has(free.id) || ts.crews.has(free.id) || [...ts.transits.values()].some(t => t.seats.has(free.id)),
    `a free bot at the same range is booked (${ts.hitches.get(free.id)?.seatId})`);
  f.dispose();
}

console.log(`conquest-bot-hitch-test: OK (${checks} checks)`);
