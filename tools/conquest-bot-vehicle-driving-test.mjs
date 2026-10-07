// Ground vehicle crews (server/bot-vehicle-driving.js) on the real Frontier v2
// map: road graph from mapMeta.conquest.roads plus crossings, commander-driven
// tank overwatch and jeep squad rides through real applyInput, the detour probe
// rate, reverse-out below 40 %, the countermeasure reflex, bail-out when
// disabled with no engineer near, human seat priority and a boxed-in tank that
// gives up after bounded recoveries. Bots only ever send inputs and actions.
import assert from 'node:assert/strict';
import { createMapState, getMapMeta } from '../shared/worlddata.js';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { roadGraph, vehicleRoute, TANK_RETREAT_HP, BAIL_ENGINEER_RADIUS } from '../server/bot-vehicle-driving.js';
import { vehicleSeatDefinition, vehicleSeatOccupantId } from '../shared/vehicle-seats.js';
import { vehicleMaxHp, VEHICLE_RULES } from '../shared/vehicles.js';
import { botDifficulty } from '../shared/bot-difficulty.js';
import { hullSeatIds } from '../server/bot-commander.js';
import { mulberry32 } from '../shared/noise.js';

// Reproducible: spread and spawn picks draw from Math.random.
Math.random = mulberry32(Number(process.env.VB_TEST_SEED ?? 1));

const meta = getMapMeta('frontier');
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

// --- road graph and routes --------------------------------------------------------
{
  const game = new GameEngine({ mode: 'conquest', world: createMapState('frontier'), mapMeta: meta, broadcast: () => {} });
  const graph = roadGraph(game);
  assert(graph.nodes.length > 20, `road graph built from mapMeta.conquest.roads (${graph.nodes.length} nodes)`);
  for (const crossing of meta.conquest.crossings) {
    assert(graph.nodes.some(n => n.crossing === crossing.id && flat(n, crossing) < 12), `${crossing.id} is tied into the road graph`);
  }
  // Connectivity: every node reaches every other.
  const seen = new Set([0]), queue = [0];
  while (queue.length) for (const next of graph.nodes[queue.shift()].edges.keys()) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  assert.equal(seen.size, graph.nodes.length, 'the road network is one connected graph');
  for (const pad of meta.conquest.vehicleSpawns.filter(s => s.type === 'tank' || s.type === 'jeep')) {
    const hull = game.vehicles.vehicles.get(pad.id) ?? { ...pad, spawn: pad, yaw: pad.yaw ?? 0 };
    for (const flag of meta.conquest.flags) {
      const route = vehicleRoute(game, hull, flag);
      assert(route.length >= 1 && flat(route.at(-1), flag) < 1, `${pad.id} -> ${flag.id}: the route ends at the goal`);
      let length = 0, prev = hull;
      for (const point of route) { length += flat(prev, point); prev = point; }
      if (flat(hull, flag) > 120) assert(length < flat(hull, flag) * 1.9, `${pad.id} -> ${flag.id}: road route is not a wild detour (${(length / flat(hull, flag)).toFixed(2)}x)`);
    }
  }
  game.stop();
}

// --- live crews: tank overwatch and jeep squad rides ----------------------------------
{
  const game = new GameEngine({ mode: 'conquest', world: createMapState('frontier'), mapMeta: meta, broadcast: () => {} });
  const bots = attachBots(game, 16);
  const actions = [];
  const applyInput = game.applyInput.bind(game);
  game.applyInput = (id, input) => {
    assert(input.keys && typeof input.keys === 'object', 'bot inputs carry normal keys');
    for (const key of ['x', 'y', 'z', 'vehiclePosition']) assert(!(key in input), 'AI never supplies position overrides');
    if (input.vehicleAction) {
      if (input.vehicleAction.type === 'enter') {
        const hull = game.vehicles.vehicles.get(input.vehicleAction.vehicleId);
        assert(vehicleSeatDefinition(hull, input.vehicleAction.seatId), 'bots request a named, valid seat');
      }
      const p = game.entities.get(id);
      actions.push({ id, type: input.vehicleAction.type, vehicleId: input.vehicleAction.vehicleId ?? p?.vehicleId, at: game.now, x: p?.x, z: p?.z });
    }
    applyInput(id, input);
  };
  const tanks = [...game.vehicles.vehicles.values()].filter(v => v.type === 'tank' && v.team);
  const track = new Map(tanks.map(v => [v.id, { travel: 0, overwatch: null, destroyed: false }]));
  let probesBefore = 0, probeWindowTicks = 0, maxProbeRate = 0;
  const ticks = Math.round(120000 / TICK_MS);
  for (let tick = 0; tick < ticks; tick++) {
    game.step(TICK_MS);
    for (const v of tanks) {
      const t = track.get(v.id);
      if (!(v.hp > 0)) t.destroyed = true;
      t.travel = Math.max(t.travel, flat(v, v.spawn));
      const driverId = vehicleSeatOccupantId(v, 'driver');
      const state = driverId ? bots.vehicleDriving.drivers.get(driverId) : null;
      if (state?.spot && state.settleAt && !t.overwatch && Math.abs(v.speed) < 0.5 && flat(v, state.spot) < 6) {
        const flag = bots.commander.crewFor(driverId)?.flag;
        const threatYaw = bots.commander.threatAxis(game.entities.get(driverId));
        if (flag) t.overwatch = { flagDistance: flat(v, flag), yawError: Math.abs(wrap(threatYaw - v.yaw)), at: tick };
      }
    }
    if (++probeWindowTicks * TICK_MS >= 5000) {
      const drivers = [...bots.vehicleDriving.drivers.values()].length || 1;
      const probes = (bots.vehicleDriving.probes ?? 0) - probesBefore;
      maxProbeRate = Math.max(maxProbeRate, probes / drivers / 5);
      probesBefore = bots.vehicleDriving.probes ?? 0; probeWindowTicks = 0;
    }
  }
  const crewed = tanks.filter(v => actions.some(a => a.type === 'enter' && a.vehicleId === v.id));
  assert(crewed.length >= 2, `both HQ tanks get bot drivers through applyInput (${crewed.length})`);
  // A tank killed on its way (the enemy armour already overwatches the flag)
  // may respawn too late to settle inside the window; every survivor settles.
  assert(crewed.some(v => track.get(v.id).overwatch), 'at least one HQ tank settles on an overwatch spot');
  for (const v of crewed) {
    const t = track.get(v.id);
    assert(t.travel > 100, `${v.id}: leaves its base by more than 100 m (${t.travel.toFixed(0)})`);
    if (!t.destroyed) assert(t.overwatch, `${v.id}: settles on an overwatch spot`);
    if (t.overwatch) assert(t.overwatch.flagDistance >= 36 && t.overwatch.flagDistance <= 84, `${v.id}: overwatch 40-80 m from its flag (${t.overwatch.flagDistance.toFixed(1)})`);
  }
  assert(maxProbeRate <= 4.2, `detour probes stay at or below 4 Hz per driver (${maxProbeRate.toFixed(2)})`);
  const jeepExits = actions.filter(a => a.type === 'exit' && game.vehicles.vehicles.get(a.vehicleId)?.type === 'jeep');
  assert(jeepExits.length >= 2, `squads ride jeeps and unload (${jeepExits.length} exits)`);
  bots.dispose(); game.stop();
}

// --- reflexes on a crewed tank: reverse below 40 %, smoke on lock, bail when disabled ---
function crewedTank() {
  const game = new GameEngine({ mode: 'conquest', world: createMapState('frontier'), mapMeta: meta, broadcast: () => {} });
  const bots = attachBots(game, 2);
  const actions = [];
  const applyInput = game.applyInput.bind(game);
  game.applyInput = (id, input) => { if (input.vehicleAction) actions.push({ id, type: input.vehicleAction.type, at: game.now }); applyInput(id, input); };
  const driver = [...game.entities.values()].find(p => p.bot && game.mode.teamFor(p) === 'alpha');
  const tank = game.vehicles.vehicles.get('alpha-tank');
  Object.assign(driver, { x: tank.x + 2, y: tank.y, z: tank.z });
  // Run until the commander's crew reaches the seat.
  for (let i = 0; i < 1200 && !vehicleSeatOccupantId(tank, 'driver'); i++) game.step(TICK_MS);
  const seated = game.entities.get(vehicleSeatOccupantId(tank, 'driver'));
  assert(seated?.bot, 'a bot crews the alpha tank');
  return { game, bots, tank, driver: seated, actions };
}
{
  const { game, bots, tank, driver, actions } = crewedTank();
  for (let i = 0; i < 1200; i++) { game.step(TICK_MS); if (bots.vehicleDriving.drivers.get(driver.id)?.settleAt) break; }
  // Lock warning: the smoke reflex fires after the difficulty's reaction time.
  tank.lk = 2;
  const reaction = botDifficulty(bots.brains.find(b => b.id === driver.id).difficulty).countermeasureMs;
  const lockAt = game.now;
  let cmAt = null;
  for (let i = 0; i < 120 && cmAt === null; i++) {
    tank.lk = 2;
    game.step(TICK_MS);
    if (actions.some(a => a.id === driver.id && a.type === 'cm' && a.at >= lockAt)) cmAt = game.now;
  }
  assert(cmAt !== null, 'a locked tank pops its countermeasure');
  assert(cmAt - lockAt >= reaction - TICK_MS && cmAt - lockAt <= reaction + 3 * TICK_MS, `countermeasure after the ${reaction} ms reaction (${cmAt - lockAt} ms)`);
  assert(reaction >= 300 && reaction <= 800, 'reflex delay is 0.3-0.8 s by difficulty');
  tank.lk = 0;
  // Below 40 % the driver reverses out with the front still toward the threat.
  tank.hp = vehicleMaxHp('tank') * (TANK_RETREAT_HP - 0.05);
  let reversing = 0;
  for (let i = 0; i < 180; i++) { game.step(TICK_MS); if ((driver.input?.vehicleThrottle ?? 0) < 0) reversing++; }
  assert(reversing > 20, `a damaged tank reverses out (${reversing} ticks)`);
  assert(bots.vehicleDriving.drivers.get(driver.id)?.retreat, 'the retreat state is recorded');
  bots.dispose(); game.stop();
}
{
  const { game, bots, tank, driver } = crewedTank();
  // Disabled with no engineer within 20 m: the crew bails out.
  tank.st = (tank.st | 0) | 2; tank.disabled = true;
  game.vehicles.vehicles.get(tank.id).speed = 0;
  let exited = false;
  for (let i = 0; i < 240 && !exited; i++) { tank.st |= 2; tank.disabled = true; game.step(TICK_MS); exited = driver.vehicleId !== tank.id; }
  assert(exited, 'a disabled tank with no engineer near is abandoned');
  assert(BAIL_ENGINEER_RADIUS === 20);
  bots.dispose(); game.stop();
}

// --- a tank commander waiting for its driver keeps its seat ------------------------------
{
  const game = new GameEngine({ mode: 'conquest', world: createMapState('frontier'), mapMeta: meta, broadcast: () => {} });
  const bots = attachBots(game, 2);
  const actions = [];
  const applyInput = game.applyInput.bind(game);
  game.applyInput = (id, input) => { if (input.vehicleAction) actions.push({ id, type: input.vehicleAction.type, at: game.now }); applyInput(id, input); };
  const bot = [...game.entities.values()].find(p => p.bot && game.mode.teamFor(p) === 'alpha');
  const tank = game.vehicles.vehicles.get('alpha-tank');
  const gunner = hullSeatIds(tank).gunner;
  assert(gunner, 'the tank has a gunner (commander) seat');
  // Pin the commander-seat crew order with nobody booked for the wheel.
  const plan = bots.commander.planCrews.bind(bots.commander);
  bots.commander.planCrews = (ts, view, now) => {
    plan(ts, view, now);
    ts.crews = ts.team === 'alpha' ? new Map([[bot.id, { vehicleId: tank.id, seatId: gunner, prio: 5, since: now }]]) : new Map();
  };
  Object.assign(bot, { x: tank.x + 2, y: tank.y, z: tank.z });
  for (let i = 0; i < 600 && vehicleSeatOccupantId(tank, gunner) !== bot.id; i++) game.step(TICK_MS);
  assert.equal(vehicleSeatOccupantId(tank, gunner), bot.id, 'the bot boards the commander seat');
  const from = actions.length;
  for (let i = 0; i < 80; i++) game.step(TICK_MS);
  const churn = actions.slice(from).filter(a => a.id === bot.id && (a.type === 'enter' || a.type === 'exit'));
  assert.equal(churn.length, 0, `no enter/exit churn while the driver seat is empty (${churn.map(a => a.type).join(',')})`);
  assert.equal(vehicleSeatOccupantId(tank, gunner), bot.id, 'the commander stays seated waiting for a driver');
  assert.equal(vehicleSeatOccupantId(tank, hullSeatIds(tank).driver), null);
  // Without the crew order the bot climbs out of the stationary hull.
  bots.commander.planCrews = (ts, view, now) => { plan(ts, view, now); ts.crews = new Map(); };
  for (let i = 0; i < 120 && bot.vehicleId; i++) game.step(TICK_MS);
  assert.equal(bot.vehicleId ?? null, null, 'an unbooked gunner leaves the parked tank');
  bots.dispose(); game.stop();
}

// --- tank overwatch with no standable armour spot drives to the fallback ----------------
{
  const { game, bots, tank, driver } = crewedTank();
  const driving = bots.vehicleDriving, cover = bots.commander.cover;
  // Every precomputed spot fails the hull footprint (village or forest terrain).
  const armorSpots = cover.armorSpots.bind(cover);
  cover.armorSpots = (...args) => armorSpots(...args).map(node => ({ ...node, blocked: true }));
  const standsAt = driving.standsAt.bind(driving);
  driving.standsAt = (v, point) => !point.blocked && standsAt(v, point);
  driving.drivers.delete(driver.id);
  const start = { x: tank.x, z: tank.z };
  game.step(TICK_MS);
  const state = driving.drivers.get(driver.id);
  assert(state?.spot && !state.spot.blocked, 'a fallback overwatch spot is chosen when every candidate fails');
  const flag = bots.commander.crewFor(driver.id)?.flag;
  const d = flat(state.spot, flag);
  assert(d >= 40 && d <= 70, `the fallback sits 45-65 m short of the focus flag (${d.toFixed(1)} m)`);
  let moved = 0;
  for (let i = 0; i < 600; i++) { game.step(TICK_MS); moved = Math.max(moved, flat(tank, start)); }
  assert(moved > 5, `the tank leaves its pad for the fallback spot (${moved.toFixed(1)} m)`);
  bots.dispose(); game.stop();
}

// --- human priority -----------------------------------------------------------------
{
  const game = new GameEngine({ mode: 'conquest', world: createMapState('frontier'), mapMeta: meta, broadcast: () => {} });
  const bots = attachBots(game, 8);
  game.addClient('human-driver', 'Human');
  const human = game.entities.get('human-driver');
  const team = game.mode.teamFor(human);
  const tank = [...game.vehicles.vehicles.values()].find(v => v.type === 'tank' && v.team === team);
  Object.assign(human, { x: tank.x, y: tank.y, z: tank.z });
  game.applyInput(human.id, { keys: {}, vehicleAction: { type: 'enter', vehicleId: tank.id, seatId: 'driver' } });
  game.step(TICK_MS);
  assert.equal(vehicleSeatOccupantId(tank, 'driver'), human.id, 'the human drives the tank');
  for (let i = 0; i < 600; i++) {
    game.step(TICK_MS);
    assert.equal(vehicleSeatOccupantId(tank, 'driver'), human.id, 'no bot ever takes a human-held seat');
  }
  const ts = bots.commander.teams.get(team);
  assert(![...ts.crews.values()].some(c => c.vehicleId === tank.id && c.seatId === 'driver'), 'the commander never assigns a human-held seat');
  game.removeClient(human.id);
  assert.equal(vehicleSeatOccupantId(tank, 'driver'), null, 'disconnect releases the seat');
  bots.setCount(0);
  assert.equal(bots.vehicleDriving.drivers.size, 0, 'roster removal releases every driver');
  bots.dispose(); game.stop();
}

// --- a boxed-in tank gives up after bounded recoveries -------------------------------------
{
  const { game, bots, tank, driver } = crewedTank();
  const x0 = Math.floor(tank.x), z0 = Math.floor(tank.z), y0 = Math.floor(tank.y);
  for (let x = x0 - 6; x <= x0 + 6; x++) for (let z = z0 - 6; z <= z0 + 6; z++) {
    if (Math.abs(x - x0) < 6 && Math.abs(z - z0) < 6) continue;
    for (let y = y0; y <= y0 + 4; y++) game.world.setBlock(x, y, z, 3);
  }
  let gaveUp = false;
  for (let i = 0; i < 60 * 60 && !gaveUp; i++) {
    game.step(TICK_MS);
    gaveUp = driver.vehicleId !== tank.id || !!bots.vehicleDriving.drivers.get(driver.id)?.abandoned;
  }
  assert(gaveUp, 'a permanently boxed-in tank is abandoned after bounded recoveries');
  assert(bots.vehicleDriving.benched(tank.id), 'the abandoned hull is benched for the commander');
  for (let i = 0; i < 120; i++) game.step(TICK_MS);
  assert(![...bots.commander.teams.get('alpha').crews.values()].some(c => c.vehicleId === tank.id), 'no crew is sent back to a benched hull');
  bots.dispose(); game.stop();
}

console.log('Conquest bot driving: road graph and routes, tank overwatch 40-80 m, jeep squad rides, detour probe rate, smoke reflex, reverse below 40 %, disabled bail-out, human priority and bounded recovery passed.');
