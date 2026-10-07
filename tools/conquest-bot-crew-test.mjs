// Conquest crew allocation (BotCommander.planCrews / planTransit) on the real
// Frontier v2 map: the crew budget (<= ceil(teamBots/3)), the spec priority
// (tank > attack helicopter > jeep rides > transport > plane with >= 6 bots),
// unique seats, human-held seats, airborne pilots staying put, squad rides of
// at most 40 s, rides called off when their driver is lost, passive
// passengers, and replacement after a crew death.
import assert from 'node:assert/strict';
import { createMapState, getMapMeta } from '../shared/worlddata.js';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { TRANSIT_MAX_MS, hullSeatIds } from '../server/bot-commander.js';
import { vehicleSeatOccupantId, vehicleSeats } from '../shared/vehicle-seats.js';
import { mulberry32 } from '../shared/noise.js';

// Reproducible: spread and spawn picks draw from Math.random.
Math.random = mulberry32(Number(process.env.VB_TEST_SEED ?? 1));

const meta = getMapMeta('frontier');
const world = createMapState('frontier');
const axes = ['vehicleThrottle', 'vehicleSteer', 'vehicleBrake', 'vehicleLift', 'vehiclePitchControl', 'vehicleRollControl', 'vehicleYawControl'];

function fixture(n) {
  const game = new GameEngine({ mode: 'conquest', world, mapMeta: meta, broadcast: () => {} });
  const bots = attachBots(game, n);
  game.step(TICK_MS);
  const replan = () => { game.mode.policy._view = null; bots.commander.viewAt = -1; bots.commander.plan(game.now); };
  const teamBots = team => bots.brains.filter(br => game.mode.teamFor(game.entities.get(br.id)) === team).length;
  const crewTypes = team => [...bots.commander.teams.get(team).crews.values()]
    .map(c => `${game.vehicles.vehicles.get(c.vehicleId)?.type}:${c.seatId}`).sort();
  return { game, bots, replan, teamBots, crewTypes };
}

function assertCrewsValid(f) {
  for (const team of ['alpha', 'bravo']) {
    const ts = f.bots.commander.teams.get(team);
    const budget = Math.ceil(f.teamBots(team) / 3);
    assert(ts.crews.size <= budget, `${team}: ${ts.crews.size} crews within ceil(${f.teamBots(team)}/3)`);
    const seats = new Set();
    const transit = new Set([...ts.transits.values()].flatMap(t => [...t.seats.keys()]));
    for (const [id, crew] of ts.crews) {
      const key = `${crew.vehicleId}:${crew.seatId}`;
      assert(!seats.has(key), 'one crew per seat'); seats.add(key);
      assert(!transit.has(id), `a bot is either crew or a rider, never both (${id} crew ${key}, transits ${JSON.stringify([...ts.transits.values()].map(t => [t.vehicleId, [...t.seats]]))})`);
      const hull = f.game.vehicles.vehicles.get(crew.vehicleId);
      assert.equal(hull?.team, team, 'crews only ever man their own team\'s hulls');
      const occupant = vehicleSeatOccupantId(hull, crew.seatId);
      assert(occupant == null || occupant === id || f.game.entities.get(occupant)?.bot, 'a human-held seat is never assigned');
    }
  }
}

// --- budget and priority ---------------------------------------------------------
{
  const f = fixture(8);
  f.replan(); assertCrewsValid(f);
  for (const team of ['alpha', 'bravo']) assert.deepEqual(f.crewTypes(team), ['tank:driver'], `4 bots: ${team} crews only the tank`);
  f.bots.dispose(); f.game.stop();
}
{
  const f = fixture(16);
  f.replan(); assertCrewsValid(f);
  for (const team of ['alpha', 'bravo']) assert.deepEqual(f.crewTypes(team), ['helicopter:driver', 'tank:driver'], `8 bots: ${team} crews the tank, then the attack helicopter`);
  f.bots.dispose(); f.game.stop();
}
{
  const f = fixture(24);
  f.replan(); assertCrewsValid(f);
  for (const team of ['alpha', 'bravo']) {
    assert(f.teamBots(team) >= 6);
    assert.deepEqual(f.crewTypes(team), ['helicopter:driver', 'plane:driver', 'tank:driver'], `12 bots: ${team} adds the jet (>= 6 bots)`);
  }
  // Without its tank (destroyed) the slot goes to the next priority.
  const tank = [...f.game.vehicles.vehicles.values()].find(v => v.type === 'tank' && v.team === 'alpha');
  tank.hp = 0;
  f.replan();
  assert(!f.crewTypes('alpha').includes('tank:driver'), 'a destroyed tank is not crewed');
  tank.hp = 1000;
  f.bots.dispose(); f.game.stop();
}

// --- human-held seats, airborne pilots, crew deaths -----------------------------------
{
  const f = fixture(16);
  f.game.addClient('human-pilot', 'Pilot');
  const human = f.game.entities.get('human-pilot');
  const team = f.game.mode.teamFor(human);
  const heli = [...f.game.vehicles.vehicles.values()].find(v => v.type === 'helicopter' && v.team === team);
  Object.assign(human, { x: heli.x, y: heli.y, z: heli.z });
  assert(f.game.vehicles.enter(human, heli.id, 'driver'));
  f.replan(); assertCrewsValid(f);
  assert(!f.crewTypes(team).includes('helicopter:driver'), 'the human pilot keeps the helicopter');
  // Live: no bot ever takes the human's seat.
  for (let i = 0; i < 300; i++) { f.game.step(TICK_MS); assert.equal(vehicleSeatOccupantId(heli, 'driver'), human.id); }
  f.game.removeClient(human.id);
  f.bots.dispose(); f.game.stop();
}
{
  // An airborne bot pilot keeps its aircraft even when the priorities change.
  const f = fixture(16);
  const pilot = [...f.game.entities.values()].find(p => p.bot && f.game.mode.teamFor(p) === 'alpha');
  const plane = f.game.vehicles.vehicles.get('alpha-plane');
  Object.assign(pilot, { x: plane.x, y: plane.y, z: plane.z });
  assert(f.game.vehicles.enter(pilot, plane.id, 'driver'));
  plane.grounded = false; plane.y += 60;
  f.replan(); assertCrewsValid(f);
  const crew = f.bots.commander.teams.get('alpha').crews.get(pilot.id);
  assert.equal(crew?.vehicleId, plane.id, 'the airborne jet pilot stays on its crew order');
  assert(f.bots.commander.teams.get('alpha').crews.size <= 3, 'and still counts against the budget');
  f.bots.dispose(); f.game.stop();
}
{
  // A crew member dies: the slot is filled again (by a deploy into the seat or a nearby bot).
  const f = fixture(16);
  f.replan();
  const ts = f.bots.commander.teams.get('alpha');
  const [id, crew] = [...ts.crews.entries()].find(([, c]) => f.game.vehicles.vehicles.get(c.vehicleId)?.type === 'tank');
  f.game.killPlayer(f.game.entities.get(id), null, 'world', false);
  f.replan();
  const again = [...ts.crews.entries()].find(([, c]) => c.vehicleId === crew.vehicleId && c.seatId === crew.seatId);
  assert(again, 'the tank driver slot stays assigned after its crew dies');
  f.bots.dispose(); f.game.stop();
}

// --- a squad ride whose driver is lost is called off -----------------------------------
{
  const f = fixture(16);
  f.replan();
  const commander = f.bots.commander, ts = commander.teams.get('alpha');
  const jeep = [...f.game.vehicles.vehicles.values()].find(v => v.type === 'jeep' && v.team === 'alpha');
  const seats = vehicleSeats(jeep).map(seat => seat.id), driverSeat = hullSeatIds(jeep).driver;
  const book = (driverId, riderId, createdAt = f.game.now) => {
    ts.transits.clear();
    // As planTransit does on booking: the squads just rode (no instant re-booking).
    ts.rideCooldown ??= new Map();
    for (const id of ts.squads.keys()) ts.rideCooldown.set(id, f.game.now + 60000);
    const squad = ts.memberSquad.get(riderId);
    ts.transits.set(jeep.id, { vehicleId: jeep.id, squadId: squad.id, seats: new Map([[driverId, driverSeat], [riderId, seats.find(id => id !== driverSeat)]]),
      destination: { x: jeep.x + 200, y: jeep.y, z: jeep.z }, flagId: 'C', createdAt, departAt: 0, until: f.game.now + 55000, done: false });
  };
  const squad = [...ts.squads.values()].find(sq => sq.members.filter(id => f.game.entities.get(id)?.bot && !ts.crews.has(id)).length >= 2);
  const [driverId, riderId] = squad.members.filter(id => f.game.entities.get(id)?.bot && !ts.crews.has(id));
  // A fresh ride with its driver walking in is kept.
  book(driverId, riderId);
  f.replan();
  assert(ts.transits.has(jeep.id), 'a ride whose booked driver is on the way is kept');
  // The driver walked too long without boarding: called off.
  book(driverId, riderId, f.game.now - 26000);
  f.replan();
  assert(!ts.transits.has(jeep.id), 'a ride whose driver never boarded is called off');
  // The booked driver dies before departure: the rider already aboard gets out.
  book(driverId, riderId);
  const rider = f.game.entities.get(riderId);
  Object.assign(rider, { x: jeep.x + 1.5, y: jeep.y, z: jeep.z });
  assert(f.game.vehicles.enter(rider, jeep.id, ts.transits.get(jeep.id).seats.get(riderId)), 'the rider boards its seat');
  f.game.killPlayer(f.game.entities.get(driverId), null, 'world', false);
  f.replan();
  assert(!ts.transits.has(jeep.id), 'a ride whose driver died before departure is called off');
  assert.notEqual(commander.crewFor(driverId)?.role, 'transit', 'the dead driver is no longer booked on the jeep');
  let out = false;
  for (let i = 0; i < Math.round(3000 / TICK_MS) && !out; i++) { f.game.step(TICK_MS); out = rider.vehicleId !== jeep.id; }
  assert(out, 'the rider does not sit in the parked jeep waiting for a driver');
  f.bots.dispose(); f.game.stop();
}

// --- live: seats, passive passengers and rides of at most 40 s ---------------------------
{
  const f = fixture(16);
  const seatedAt = new Map(), rides = [];
  const apply = f.game.applyInput.bind(f.game);
  f.game.applyInput = (id, input) => {
    const p = f.game.entities.get(id);
    const hull = p?.vehicleId ? f.game.vehicles.vehicles.get(p.vehicleId) : null;
    if (hull && p.bot) {
      const seat = hull.seatOccupants && Object.entries(hull.seatOccupants).find(([, o]) => o === id)?.[0];
      const transit = f.bots.commander.crewFor(id)?.role === 'transit';
      if (transit && seat && seat !== 'driver' && seat !== 'gunner') {
        for (const axis of axes) assert(!(axis in input) || input[axis] === 0 || input[axis] === undefined, `a riding passenger sends no ${axis}`);
        assert(Object.values(input.keys).every(v => v === false), 'a riding passenger neither walks nor interacts');
      }
    }
    apply(id, input);
  };
  for (let i = 0; i < Math.round(150000 / TICK_MS); i++) {
    f.game.step(TICK_MS);
    if (i % 30 === 0) assertCrewsValid(f);
    for (const br of f.bots.brains) {
      const p = f.game.entities.get(br.id);
      const riding = p?.vehicleId && f.bots.commander.crewFor(p.id)?.role === 'transit';
      if (riding && !seatedAt.has(p.id)) seatedAt.set(p.id, f.game.now);
      if (!riding && seatedAt.has(br.id)) { rides.push(f.game.now - seatedAt.get(br.id)); seatedAt.delete(br.id); }
    }
  }
  assert(rides.length >= 2, `squads ride vehicles toward the front (${rides.length} rides)`);
  const longest = Math.max(...rides);
  assert(longest <= TRANSIT_MAX_MS + 15000, `rides end within the transit window (${(longest / 1000).toFixed(1)} s)`);
  console.log(`crew rides: ${rides.length}, median ${(rides.sort((a, b) => a - b)[Math.floor(rides.length / 2)] / 1000).toFixed(1)} s, longest ${(longest / 1000).toFixed(1)} s`);
  f.bots.dispose(); f.game.stop();
}

console.log('Conquest bot crews: budget, tank > helicopter > jet priority, unique seats, human seats, airborne pilots, crew replacement, passive riders and ride length passed.');
