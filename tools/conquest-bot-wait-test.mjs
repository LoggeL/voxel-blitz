// Bot drivers wait for humans running to their hull (BotCommander.planWaits)
// on the real Frontier map: a bot-driven jeep (squad ride), tank (crew),
// transport (squad ride) and attack helicopter (crew) hold while a human
// teammate runs to them and leave right after the human boards; nobody waits
// for a human walking away or standing far off; the wait times out (8 s, or
// 12 s for the driver's squad mate) and is not repeated for the same human;
// a hull already well on its way does not stop, and an airborne aircraft
// never waits.
import assert from 'node:assert/strict';
import { createMapState, getMapMeta } from '../shared/worlddata.js';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { WAIT_MS, WAIT_SQUAD_MS, WAIT_COOLDOWN_MS, hullSeatIds } from '../server/bot-commander.js';
import { vehicleSeatOccupantId, vehicleSeats } from '../shared/vehicle-seats.js';
import { vehicleEnterDistance } from '../shared/vehicles.js';
import { mulberry32 } from '../shared/noise.js';

Math.random = mulberry32(Number(process.env.VB_TEST_SEED ?? 1));

const meta = getMapMeta('frontier');
const world = createMapState('frontier');
const STEPS_PER_S = Math.round(1000 / TICK_MS);
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const bearing = (a, b) => Math.atan2(-(b.x - a.x), -(b.z - a.z));
let checks = 0;
const check = (cond, msg) => { assert(cond, msg); checks++; };

function fixture(bots = 16) {
  const game = new GameEngine({ mode: 'conquest', world, mapMeta: meta, broadcast: () => {} });
  const manager = attachBots(game, bots);
  game.step(TICK_MS);
  game.addClient('human', 'Human');
  const human = game.entities.get('human');
  const team = game.mode.teamFor(human);
  const commander = manager.commander;
  const ts = () => commander.teams.get(team);
  const replan = () => { game.mode.policy._view = null; commander.viewAt = -1; commander.plan(game.now); };
  const hull = type => [...game.vehicles.vehicles.values()].find(v => v.team === team && v.type === type && !v.id.startsWith('flag-'));
  const teamBots = () => [...game.entities.values()].filter(p => p.bot && game.mode.teamFor(p) === team);
  const squadOf = id => ts().memberSquad.get(String(id));
  // Every seat of the hull empty, and the team's bots parked far away at HQ.
  const empty = v => { for (const s of vehicleSeats(v)) { const id = vehicleSeatOccupantId(v, s.id); if (id) game.vehicles.exit(game.entities.get(id)); } };
  const seatBot = (p, v, seatId) => {
    if (p.state !== 'alive') game.respawnPlayer?.(p);
    if (p.vehicleId) game.vehicles.exit(p);
    Object.assign(p, { x: v.x + 1, y: v.y, z: v.z + 1, vx: 0, vy: 0, vz: 0 });
    assert(game.vehicles.enter(p, v.id, seatId), `${p.id} enters ${v.id}:${seatId}`);
  };
  const place = (p, at) => Object.assign(p, { x: at.x, y: at.y, z: at.z, vx: 0, vy: 0, vz: 0 });
  let order = null; // the human's standing order: walk to/away from a hull, or stand
  const steer = () => {
    if (!order || human.vehicleId || human.state !== 'alive') return;
    const yaw = order.to ? bearing(human, order.to) + (order.away ? Math.PI : 0) : human.yaw;
    game.applyInput(human.id, { keys: { f: !!order.to, sprint: !!order.to }, yaw, pitch: 0 });
  };
  const walkTo = v => { order = { to: v }; steer(); };
  const walkAway = v => { order = { to: v, away: true }; steer(); };
  const stand = () => { order = {}; game.applyInput(human.id, { keys: {}, yaw: human.yaw, pitch: 0 }); };
  const run = (seconds, until = null) => {
    for (let i = 0; i < seconds * STEPS_PER_S; i++) {
      steer();
      game.step(TICK_MS);
      if (until?.()) return true;
    }
    return until ? !!until() : true;
  };
  // Walk up to the hull and get in.
  const boardHuman = (v, seatId, seconds = 12) => {
    walkTo(v);
    const near = run(seconds, () => Math.hypot(human.x - v.x, human.y - v.y, human.z - v.z) < vehicleEnterDistance(v.type) - 0.4);
    stand();
    return near && game.vehicles.enter(human, v.id, seatId);
  };
  // A squad ride on `v`, its driver and first rider already seated (it leaves at once on its own).
  const bookRide = (v, [driver, rider], riderSeat) => {
    empty(v);
    seatBot(driver, v, hullSeatIds(v).driver);
    seatBot(rider, v, riderSeat);
    const t = ts();
    t.transits.clear();
    t.rideCooldown ??= new Map();
    for (const id of t.squads.keys()) t.rideCooldown.set(id, game.now + 120000);
    const flagC = meta.conquest.flags.find(fl => fl.id === 'C');
    t.transits.set(v.id, { vehicleId: v.id, squadId: squadOf(rider.id).id,
      seats: new Map([[String(driver.id), hullSeatIds(v).driver], [String(rider.id), riderSeat]]),
      destination: { x: flagC.x, y: flagC.y, z: flagC.z }, flagId: 'C', createdAt: game.now, departAt: 0, until: game.now + 55000, done: false });
  };
  // A persistent crew order for the bot seated at the wheel of `v`.
  const crewDriver = (v, p) => {
    seatBot(p, v, hullSeatIds(v).driver);
    ts().crews.clear();
    replan();
    assert.equal(ts().crews.get(String(p.id))?.vehicleId, v.id, `${p.id} crews ${v.id}`);
  };
  // Bots of the human's squad, and bots of other squads, free of crew orders.
  const freeBots = mate => teamBots().filter(p => !ts().crews.has(String(p.id))
    && (squadOf(p.id)?.id === squadOf(human.id)?.id) === mate);
  const dispose = () => { manager.dispose(); game.stop(); };
  replan();
  return { game, manager, commander, human, team, ts, replan, hull, teamBots, empty, seatBot, place, walkTo, walkAway, stand,
    run, boardHuman, bookRide, crewDriver, freeBots, dispose };
}

const behind = (v, r, side = 0) => {
  // A point r m behind the hull's nose (yaw points the nose along -Z rotated), side m to its right.
  const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
  return { x: v.x - fx * r + fz * side, y: v.y + 0.02, z: v.z - fz * r - fx * side };
};

// --- jeep squad ride: holds for the driver's squad mate, leaves once the human sits in ---
{
  const f = fixture();
  const jeep = f.hull('jeep');
  const mates = [f.freeBots(true)[0], f.freeBots(false)[0]];
  check(mates[0], 'the human has a bot squad mate free of crew orders');
  f.place(f.human, behind(jeep, 30));
  f.walkTo(jeep);
  f.run(0.5);
  f.bookRide(jeep, mates, 'gunner');
  f.replan();
  const wait = f.commander.waits.get(jeep.id);
  check(wait?.humanId === 'human' && wait.squad, 'the jeep waits for the running squad mate');
  check(wait.until - wait.since === WAIT_SQUAD_MS, `a squad mate gets the long wait (${wait.until - wait.since} ms)`);
  const start = { x: jeep.x, z: jeep.z };
  const boarded = f.boardHuman(jeep, 'front-passenger');
  check(boarded, 'the human reaches the jeep and gets in');
  check(flat(jeep, start) < 1.5, `the jeep stood while the human ran to it (${flat(jeep, start).toFixed(1)} m)`);
  check(!f.commander.holdFor(jeep), 'boarding releases the hold at once');
  const gone = f.run(3, () => flat(jeep, start) > 4);
  check(gone, `the jeep leaves right after the human boarded (${flat(jeep, start).toFixed(1)} m in 3 s)`);
  f.run(0.6);
  check(!f.commander.waits.has(jeep.id) && !f.ts().waitCooldown.has('human'), 'the wait ends without a cooldown');
  check(f.human.vehicleId === jeep.id, 'the human rides along');
  f.dispose();
}

// --- nobody waits for a human walking away, or standing far off ---
for (const mode of ['away', 'still']) {
  const f = fixture();
  const jeep = f.hull('jeep');
  f.place(f.human, behind(jeep, mode === 'away' ? 15 : 28));
  if (mode === 'away') f.walkAway(jeep); else f.stand();
  f.run(0.5);
  f.bookRide(jeep, f.freeBots(false).slice(0, 2), 'gunner');
  const start = { x: jeep.x, z: jeep.z };
  f.replan();
  check(!f.commander.waits.has(jeep.id), `no wait for a human ${mode === 'away' ? 'walking away' : 'standing 28 m off'}`);
  const gone = f.run(5, () => flat(jeep, start) > 8);
  check(gone && !f.commander.waits.size, `the jeep leaves without waiting (${mode}, ${flat(jeep, start).toFixed(1)} m)`);
  f.dispose();
}

// --- the wait times out for a human who stands at the hull, and is not repeated ---
{
  const f = fixture();
  const jeep = f.hull('jeep');
  f.place(f.human, behind(jeep, 4, 22));
  f.walkTo(jeep);
  f.run(0.5);
  f.bookRide(jeep, f.freeBots(false).slice(0, 2), 'gunner');
  f.replan();
  const wait = f.commander.waits.get(jeep.id);
  check(wait && !wait.squad && wait.until - wait.since === WAIT_MS, `a teammate outside the driver's squad gets ${WAIT_MS} ms`);
  const start = { x: jeep.x, z: jeep.z };
  // Stop beside the jeep and never get in.
  f.run(6, () => flat(f.human, jeep) < 6.5);
  f.stand();
  const left = f.run(WAIT_MS / 1000 + 2, () => flat(jeep, start) > 2);
  const waited = f.game.now - wait.since;
  check(left && waited >= WAIT_MS - 100 && waited <= WAIT_MS + 1500, `the jeep gives up and leaves after ${(waited / 1000).toFixed(1)} s`);
  f.run(0.6);
  check(f.ts().waitCooldown.get('human') > f.game.now + WAIT_COOLDOWN_MS - 2000, 'the human is not waited for again for a while');
  f.walkTo(jeep);
  f.run(1.5);
  check(!f.commander.waits.size, 'running after it again starts no new wait');
  f.dispose();
}

// --- a ride already well on its way does not stop or turn back ---
{
  const f = fixture();
  const jeep = f.hull('jeep');
  f.place(f.human, { x: jeep.x, y: jeep.y + 0.02, z: jeep.z - 200 });
  f.stand();
  f.bookRide(jeep, f.freeBots(false).slice(0, 2), 'gunner');
  f.replan();
  const start = { x: jeep.x, z: jeep.z };
  check(f.run(8, () => flat(jeep, start) > 20 && Math.abs(jeep.speed) > 4), `the jeep is on its way (${flat(jeep, start).toFixed(1)} m)`);
  // The human appears beside the road and runs after it.
  const side = Math.abs(Math.sin(jeep.yaw)) > 0.5 ? { x: 0, z: 22 } : { x: 22, z: 0 };
  f.place(f.human, { x: jeep.x + side.x, y: jeep.y + 0.02, z: jeep.z + side.z });
  f.walkTo(jeep);
  let slowest = Infinity;
  f.run(2, () => { slowest = Math.min(slowest, Math.abs(jeep.speed)); return false; });
  check(!f.commander.waits.has(jeep.id), 'no wait for a hull that already left');
  check(slowest > 3, `the jeep drives on (slowest ${slowest.toFixed(1)} m/s)`);
  f.dispose();
}

// --- tank crew: holds at its pad while a human runs to it, then rolls out ---
{
  const f = fixture();
  const tank = f.hull('tank');
  f.empty(tank);
  f.place(f.human, behind(tank, 32));
  f.walkTo(tank);
  f.run(0.5);
  f.crewDriver(tank, f.freeBots(false)[0]);
  const wait = f.commander.waits.get(tank.id);
  check(wait?.humanId === 'human', 'the tank crew waits for the running human');
  const start = { x: tank.x, z: tank.z, yaw: tank.yaw };
  const boarded = f.boardHuman(tank, 'commander');
  check(boarded, 'the human gets into the commander seat');
  check(flat(tank, start) < 1.5, `the tank stood while the human ran to it (${flat(tank, start).toFixed(1)} m)`);
  const rolled = f.run(8, () => flat(tank, start) > 3 || Math.abs(tank.yaw - start.yaw) > 0.3);
  check(rolled, 'the tank moves out once the human is aboard');
  f.dispose();
}

// --- transport squad ride: holds the takeoff, lifts off once the human sits in ---
{
  const f = fixture();
  const transport = f.hull('transport');
  f.place(f.human, behind(transport, 26, 8));
  f.walkTo(transport);
  f.run(0.5);
  f.bookRide(transport, [f.freeBots(true)[0], f.freeBots(false)[0]], 'door-left');
  f.replan();
  check(f.commander.waits.get(transport.id)?.squad, 'the transport waits for the running squad mate');
  const boarded = f.boardHuman(transport, 'rear-left');
  check(boarded, 'the human gets into the transport');
  check(transport.grounded !== false, 'the transport stayed on the ground meanwhile');
  const lifted = f.run(6, () => transport.grounded === false && transport.y > 39);
  check(lifted, `the transport lifts off once the human is aboard (y ${transport.y.toFixed(1)})`);
  f.dispose();
}

// --- attack helicopter: waits on the pad; airborne it never waits ---
{
  const f = fixture();
  const heli = f.hull('helicopter');
  f.empty(heli);
  f.place(f.human, behind(heli, 30));
  f.walkTo(heli);
  f.run(0.5);
  f.crewDriver(heli, f.freeBots(false)[0]);
  check(f.commander.waits.get(heli.id)?.humanId === 'human', 'the grounded helicopter waits for the running human');
  const boarded = f.boardHuman(heli, 'gunner');
  check(boarded && heli.grounded !== false, 'the human takes the chin gun before takeoff');
  check(f.run(6, () => heli.grounded === false && heli.y > 40), 'the helicopter lifts off once the human is aboard');
  f.dispose();
}
{
  const f = fixture();
  const heli = f.hull('helicopter');
  f.empty(heli);
  f.place(f.human, { x: heli.x, y: heli.y + 0.02, z: heli.z + 200 });
  f.stand();
  f.crewDriver(heli, f.freeBots(false)[0]);
  check(f.run(6, () => heli.grounded === false && heli.y > 44), 'the helicopter takes off');
  f.place(f.human, { x: heli.x + 20, y: 37.02, z: heli.z });
  f.walkTo(heli);
  f.run(2);
  check(!f.commander.waits.has(heli.id), 'an airborne helicopter does not wait');
  check(heli.grounded === false, 'and keeps flying');
  f.dispose();
}

console.log(`conquest-bot-wait-test: OK (${checks} checks)`);
