// Frontier's river as a waterway (docs/maps/frontier.md "River", docs/conquest.md
// "Patrol boat"): the 20 m crossings and 36-44 m reaches, the 4-5 m channel and
// the one-voxel fords, the end bridges' clearance for a boat afloat; a bot
// helmsman sails the whole boat lane end to end for each team (under all three
// decks, over both fords, through both sluice ponds), a boat scrapes across a ford slowly, a jeep and a tank
// still drive through both fords, flag C is capturable from either bank, and
// after the Iron Bridge collapse boats still pass where the span stood.
import assert from 'node:assert/strict';
import { createMapState, getMapMeta } from '../shared/worlddata.js';
import { FRONTIER_PLAN, CONQUEST_RULES } from '../shared/conquest-contract.js';
import {
  frontierTerrain, frontierSurfaceY, FRONTIER_CROSSINGS, FRONTIER_CELL_KIND as KIND, riverHalfAt, riverReach, riverCentreX, polylineAt,
} from '../shared/world/frontier-terrain.js';
import { MC_WATER, isSolidBlock } from '../shared/world/blocks.js';
import { BOAT_RULES } from '../shared/vehicle-handling/boat.js';
import { VEHICLE_RULES } from '../shared/vehicles.js';
import { VehicleSystem } from '../server/sim/vehicles.js';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { BOAT_PATROL, boatLane, lanePoint, laneProgress } from '../server/bot-boat-driving.js';
import { IRON_BRIDGE, IRON_BRIDGE_RULES } from '../shared/conquest-bridge.js';
import { STRUCTURE_RULES } from '../shared/structure.js';
import { WEIR } from '../shared/map-events/weir.js';
import { BOAT_TOP } from '../public/js/vehicles/models/boat.js';
import { mulberry32 } from '../shared/noise.js';

Math.random = mulberry32(Number(process.env.VB_TEST_SEED ?? 1));
const started = performance.now();
const meta = getMapMeta('frontier'), terrain = frontierTerrain();
const RIVER = FRONTIER_PLAN.river, SX = FRONTIER_PLAN.dimensions.sx;
const WATER_FACE = RIVER.surfaceY + 1, FLOAT = WATER_FACE - BOAT_RULES.draft;
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const idx = (x, z) => Math.floor(z) * SX + Math.floor(x);
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
/** Measured runs, printed with the summary. */
const notes = [];

// ------------------------------------------------------------------ the channel
{
  for (const c of FRONTIER_CROSSINGS) ok(Math.abs(riverHalfAt(c.z) * 2 - RIVER.width) < 1e-6, `${c.id}: a ${RIVER.width} m channel`);
  let lo = Infinity, hi = 0;
  for (let z = 32; z < 736; z++) if (riverReach(z + 0.5) > 0.999) { const w = riverHalfAt(z + 0.5) * 2; lo = Math.min(lo, w); hi = Math.max(hi, w); }
  ok(lo >= 36 && hi <= 44 && hi - lo > 5, `open reaches ${lo.toFixed(1)}-${hi.toFixed(1)} m wide`);
  // Depth (water face less the standing height) over the open river, islands and fords aside.
  const depths = [];
  for (let i = 0; i < terrain.kind.length; i++) if (terrain.kind[i] === KIND.RIVER && terrain.water[i]) depths.push(WATER_FACE - (terrain.heights[i] + 1));
  const mean = depths.reduce((a, b) => a + b, 0) / depths.length, channel = depths.filter(d => d >= 4);
  ok(Math.min(...depths) >= 2 && Math.max(...depths) === Math.ceil(RIVER.depth), `the river is 2-${Math.ceil(RIVER.depth)} m deep`);
  ok(channel.length > depths.length * 0.75 && Math.abs(channel.reduce((a, b) => a + b, 0) / channel.length - RIVER.depth) < 0.3,
    `the channel averages about ${RIVER.depth} m (${(channel.reduce((a, b) => a + b, 0) / channel.length).toFixed(2)} m over ${(100 * channel.length / depths.length).toFixed(0)} % of the water, ${mean.toFixed(2)} m overall)`);
  // Down the centreline the water never gets shallower than a ford.
  for (let z = 0; z < SX; z++) {
    const i = idx(riverCentreX(z + 0.5), z);
    if (terrain.kind[i] === KIND.BRIDGE) continue;
    ok(terrain.water[i] === RIVER.surfaceY && WATER_FACE - (terrain.heights[i] + 1) >= 1, `water on the centreline at z ${z}`);
  }
  for (const c of FRONTIER_CROSSINGS.filter(c => c.kind === 'ford')) {
    ok(WATER_FACE - (c.bedY + 1) === 1, `${c.id}: one voxel of water over the ford`);
    ok(WATER_FACE - (c.bedY + 1) < BOAT_RULES.shallowDepth && WATER_FACE - (c.bedY + 1) > BOAT_RULES.draft, `${c.id}: a boat floats across it, scraping`);
  }
  // Every bridge deck leaves a boat afloat room under it (the model's canopy roof is its top).
  for (const c of FRONTIER_CROSSINGS.filter(c => c.kind === 'bridge')) {
    ok(c.deckY - 1 >= FLOAT + BOAT_TOP, `${c.id}: the deck underside (y ${c.deckY - 1}) clears a boat afloat (${(FLOAT + BOAT_TOP).toFixed(2)})`);
  }
}

// ------------------------------------------------------------------ fords: hulls drive through, boats scrape
const world = createMapState('frontier');
const isolated = () => {
  const engine = { world, mapMeta: meta, entities: new Map(), mode: { mode: 'conquest', canFire: () => true } };
  return { engine, vehicles: new VehicleSystem(engine) };
};
const steerAlong = (v, aim, input, target) => {
  const want = Math.atan2(-(aim.x - v.x), -(aim.z - v.z)), error = Math.atan2(Math.sin(want - v.yaw), Math.cos(want - v.yaw));
  input.vehicleSteer = Math.max(-1, Math.min(1, -error * 2.5));
  input.vehicleThrottle = v.speed > target + 0.5 ? 0 : 1;
  input.vehicleBrake = v.speed > target + 2 ? 1 : 0;
};
for (const ford of FRONTIER_CROSSINGS.filter(c => c.kind === 'ford')) {
  const road = meta.conquest.roads.find(r => r.points.some(([x, , z]) => Math.hypot(x - ford.x, z - ford.z) < 1));
  const pts = road.points.map(([x, , z]) => [x, z]);
  let at = 0, best = Infinity;
  for (let s = 0, len = pts.slice(1).reduce((n, p, i) => n + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0); s <= len; s += 0.5) {
    const p = polylineAt(pts, s), d = Math.hypot(p.x - ford.x, p.z - ford.z);
    if (d < best) { best = d; at = s; }
  }
  for (const type of ['jeep', 'tank']) for (const dir of [1, -1]) {
    const { engine, vehicles } = isolated();
    const start = polylineAt(pts, at - dir * 45), id = `${type}-${ford.id}-${dir}`;
    vehicles.reset([{ id, type, team: 'alpha', x: start.x, y: frontierSurfaceY(start.x, start.z) + 0.02, z: start.z, yaw: Math.atan2(-dir * start.dx, -dir * start.dz) }]);
    const v = vehicles.vehicles.get(id);
    v.y = vehicles.placement(v, v.x, v.z);
    const p = { id: 'driver', team: 'alpha', state: 'alive', hp: 100, x: v.x, y: v.y, z: v.z, input: { keys: {}, vehicleThrottle: 0, vehicleSteer: 0, vehicleBrake: 0 } };
    engine.entities.set(p.id, p);
    ok(vehicles.enter(p, id, 'driver'), `${type} crew boards before ${ford.id}`);
    let wet = 0, crossed = false, minY = Infinity;
    for (let i = 0; i < 60 * 40 && !crossed; i++) {
      steerAlong(v, polylineAt(pts, nearest(pts, v) + dir * 8), p.input, 8);
      vehicles.step(1 / 60);
      if (world.getBlock(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)) === MC_WATER) wet++;
      minY = Math.min(minY, v.y);
      crossed = dir * (nearest(pts, v) - at) > 40;
    }
    ok(crossed, `a ${type} drives through ${ford.id} (${dir > 0 ? 'down' : 'up'} the road, at ${v.x.toFixed(0)},${v.z.toFixed(0)})`);
    ok(wet > 0 && minY >= ford.bedY + 1 - 0.05, `it wades the ford on its bed (lowest y ${minY.toFixed(2)})`);
    ok(v.hp === VEHICLE_RULES[type].hp, `the ${type} is unharmed`);
  }
}
function nearest(pts, p) {
  let best = Infinity, at = 0, s0 = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i], dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
    const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.z - az) * dz) / (len * len)));
    const d = Math.hypot(ax + dx * t - p.x, az + dz * t - p.z);
    if (d < best) { best = d; at = s0 + t * len; }
    s0 += len;
  }
  return at;
}
{
  // A boat flat out at a ford scrapes across it: the hull slows to a crawl over the
  // voxel of water and planes again in the deep channel beyond.
  const lane = boatLane({ mapMeta: meta });
  for (const ford of FRONTIER_CROSSINGS.filter(c => c.kind === 'ford')) {
    const { engine, vehicles } = isolated();
    const v = vehicles.vehicles.get('alpha-boat-north');
    const s0 = laneProgress(lane, ford), from = lanePoint(lane, s0 - 70);
    Object.assign(v, { x: from.x, z: from.z });
    v.y = vehicles.placement(v, v.x, v.z);
    const p = { id: 'helm', team: 'alpha', state: 'alive', hp: 100, x: v.x, y: v.y, z: v.z, input: { keys: {}, vehicleThrottle: 0, vehicleSteer: 0, vehicleBrake: 0 } };
    engine.entities.set(p.id, p);
    ok(vehicles.enter(p, v.id, 'driver'), 'the helmsman boards');
    let before = 0, over = 0, after = 0, scraped = 0;
    for (let i = 0; i < 60 * 30; i++) {
      const s = laneProgress(lane, v);
      if (s > s0 + 60) break;
      v.yaw = v.course = Math.atan2(-(lanePoint(lane, s + 10).x - v.x), -(lanePoint(lane, s + 10).z - v.z));
      Object.assign(p.input, { vehicleThrottle: 1, vehicleSteer: 0, vehicleBrake: 0 });
      vehicles.step(1 / 60);
      const along = laneProgress(lane, v) - s0;
      if (along < -25) before = Math.max(before, v.speed);
      else if (along > 2 && along < 7) over = Math.max(over, v.speed);
      else if (along > 30) after = Math.max(after, v.speed);
      if (v.boatShallow > 0) scraped++;
    }
    ok(before > 14, `${ford.id}: the boat planes toward the ford (${before.toFixed(1)} m/s)`);
    ok(scraped > 0 && over > 0.5 && over <= BOAT_RULES.shallowSpeed + 3, `${ford.id}: it scrapes across slowly (${over.toFixed(1)} m/s over the ford)`);
    ok(after > over + 3, `${ford.id}: and speeds up in the deep water beyond (${after.toFixed(1)} m/s)`);
    notes.push(`${ford.id} flat out ${before.toFixed(1)} -> ${over.toFixed(1)} -> ${after.toFixed(1)} m/s`);
    ok(v.hp === VEHICLE_RULES.boat.hp && v.y >= FLOAT - 1e-6, `${ford.id}: afloat and unharmed`);
  }
}

// ------------------------------------------------------------------ bot helmsmen, end to end
/**
 * A bot crews `boatId` from `from` (arc length along the lane) and is sent home
 * to a mooring moved to `to` (a recall: the ordinary patrol helmsman, lane
 * route, narrows and ford speeds, watchdog). Returns the run's record.
 */
function sail(game, bots, boatId, team, from, to, seconds) {
  const lane = boatLane(game), boat = game.vehicles.vehicles.get(boatId);
  const brain = bots.brains.find(br => game.mode.teamFor(game.entities.get(br.id)) === team && !game.entities.get(br.id).vehicleId);
  const bot = game.entities.get(brain.id);
  const start = lanePoint(lane, from), end = lanePoint(lane, to), ahead = lanePoint(lane, from + Math.sign(to - from) * 8);
  Object.assign(boat, { x: start.x, z: start.z, speed: 0, yawRate: 0 });
  boat.yaw = boat.course = Math.atan2(-(ahead.x - start.x), -(ahead.z - start.z));
  boat.y = game.vehicles.placement(boat, boat.x, boat.z);
  const mooring = boat.spawn;
  boat.spawn = { ...mooring, x: end.x, y: FLOAT + 0.02, z: end.z, yaw: boat.yaw };
  const crewFor = bots.commander.crewFor.bind(bots.commander);
  const flag = meta.conquest.flags.find(f => f.id === 'C');
  bots.commander.crewFor = id => String(id) === String(bot.id) ? { role: 'crew', vehicleId: boat.id, seatId: 'driver', prio: 1.5, flag, recall: true } : crewFor(id);
  // The rest of the bots hold their fire: the run measures the river, not a firefight on the bank.
  const applyInput = game.applyInput.bind(game);
  game.applyInput = (id, input) => applyInput(id, String(id) === String(bot.id) ? input : { ...input, wantFire: false, throwGrenade: false });
  for (let i = 0; i < 400 && bot.state !== 'alive'; i++) game.step(TICK_MS);
  Object.assign(bot, { x: boat.x, y: boat.y + 0.5, z: boat.z });
  ok(game.vehicles.enter(bot, boat.id, 'driver'), `${team}: the bot helmsman boards ${boat.id}`);
  const crossed = new Set(), hp = boat.hp;
  let arrived = null, dry = 0, maxFord = 0, minY = Infinity, maxY = -Infinity;
  const fords = FRONTIER_CROSSINGS.filter(c => c.kind === 'ford');
  for (let t = 0; t < seconds * 1000 / TICK_MS && arrived == null; t++) {
    game.step(TICK_MS);
    for (const c of FRONTIER_CROSSINGS) if (Math.abs(boat.z - c.z) < 2 && flat(boat, c) < RIVER.width / 2) crossed.add(c.id);
    if (fords.some(f => Math.abs(boat.z - f.z) < f.width / 2 - 2)) maxFord = Math.max(maxFord, Math.abs(boat.speed));
    if (game.world.getBlock(Math.floor(boat.x), RIVER.surfaceY, Math.floor(boat.z)) !== MC_WATER) dry++;
    minY = Math.min(minY, boat.y); maxY = Math.max(maxY, boat.y);
    if (flat(boat, end) < BOAT_PATROL.moorRadius) arrived = t * TICK_MS / 1000;
    if (!(boat.hp > 0) || bot.vehicleId !== boat.id) break;
  }
  bots.commander.crewFor = crewFor;
  game.applyInput = applyInput;
  game.vehicles.exit(bot);
  // Back to its own mooring, out of the next run's way.
  const record = { x: boat.x, z: boat.z };
  boat.spawn = mooring;
  Object.assign(boat, { x: mooring.x, y: mooring.y, z: mooring.z, yaw: mooring.yaw, course: mooring.yaw, speed: 0, yawRate: 0 });
  return { at: record, boat, arrived, crossed, dry, maxFord, minY, maxY, lost: hp - boat.hp, from: start, to: end };
}
{
  const game = new GameEngine({ mode: 'conquest', world: createMapState('frontier'), mapMeta: meta, broadcast: () => {} });
  const bots = attachBots(game, 4);
  game.step(TICK_MS);
  const lane = boatLane(game);
  ok(lane.points[0].z <= FRONTIER_PLAN.combatArea.minZ + 10 && lane.points.at(-1).z >= FRONTIER_PLAN.combatArea.maxZ - 10, `the lane runs the river's length (${lane.length.toFixed(0)} m)`);
  for (const [boatId, team, from, to] of [['alpha-boat-north', 'alpha', 0, lane.length], ['bravo-boat-north', 'bravo', lane.length, 0]]) {
    const run = sail(game, bots, boatId, team, from, to, 200);
    ok(run.arrived != null, `${team}: a bot sails ${boatId} the whole river, z ${run.from.z.toFixed(0)} to ${run.to.z.toFixed(0)} (${run.arrived?.toFixed(1)} s, at ${run.at.x.toFixed(0)},${run.at.z.toFixed(0)})`);
    ok(FRONTIER_CROSSINGS.every(c => run.crossed.has(c.id)), `${team}: under all three decks and over both fords (${[...run.crossed]})`);
    // Afloat: on the reach's face, or one voxel higher on a sluice pond (WEIR.pond.faceY), never on a bank.
    ok(run.dry === 0 && run.minY >= FLOAT - 1e-6 && run.maxY <= FLOAT + (WEIR.pond.faceY - WATER_FACE) + 1e-6, `${team}: afloat all the way (${run.minY.toFixed(2)}..${run.maxY.toFixed(2)})`);
    ok(run.maxFord <= BOAT_PATROL.ford + 1, `${team}: it takes the fords slowly (${run.maxFord.toFixed(1)} m/s)`);
    ok(run.lost <= VEHICLE_RULES.boat.hp * 0.1, `${team}: no hard bank strikes (${run.lost.toFixed(0)} hp lost)`);
    notes.push(`${team} ${lane.length.toFixed(0)} m in ${run.arrived.toFixed(1)} s (fords at ${run.maxFord.toFixed(1)} m/s, ${run.lost.toFixed(0)} hp lost)`);
  }
  bots.dispose(); game.stop();
}

// ------------------------------------------------------------------ flag C from either bank
{
  const game = new GameEngine({ mode: 'conquest', world: createMapState('frontier'), mapMeta: meta, broadcast: () => {} });
  const C = meta.conquest.flags.find(f => f.id === 'C');
  const west = C.spawns.filter(s => s.x < riverCentreX(s.z) - RIVER.width / 2), east = C.spawns.filter(s => s.x > riverCentreX(s.z) + RIVER.width / 2);
  ok(west.length >= 4 && east.length >= 4, `C spawns on both banks (${west.length} west, ${east.length} east)`);
  for (const s of C.spawns) ok(flat(s, C) <= C.radius + 6 && isSolidBlock(game.world.getBlock(Math.floor(s.x), Math.floor(s.y) - 1, Math.floor(s.z))), `C spawn ${s.x},${s.z} stands on the bank by the zone`);
  for (const [team, side] of [['alpha', west], ['bravo', east]]) {
    game.addClient(`${team}-c`, team);
    const p = game.entities.get(`${team}-c`);
    game.mode.policy.setLobbyTeam(p, team);
  }
  for (let i = 0; i < 4; i++) game.step(TICK_MS);
  const cState = game.mode.policy.capture.flags.find(f => f.id === 'C');
  for (const [team, side, sign] of [['alpha', west, 1], ['bravo', east, -1]]) {
    const p = game.entities.get(`${team}-c`), other = game.entities.get(`${team === 'alpha' ? 'bravo' : 'alpha'}-c`);
    Object.assign(other, { x: 120, y: 40, z: 120 });
    const spot = side.reduce((a, b) => (flat(b, C) < flat(a, C) ? b : a));
    ok(flat(spot, C) < C.radius, `${team}: a ${team === 'alpha' ? 'west' : 'east'}-bank spawn inside the zone (${flat(spot, C).toFixed(1)} m)`);
    const before = cState.control;
    for (let t = 0; t < (CONQUEST_RULES.captureMs ?? 12000) / TICK_MS; t++) {
      Object.assign(p, { x: spot.x, y: spot.y, z: spot.z, vx: 0, vy: 0, vz: 0, hp: 100, state: 'alive', vehicleId: null });
      game.step(TICK_MS);
    }
    ok(sign * (cState.control - before) > 0.2 || cState.owner === team, `${team} takes C from the ${sign > 0 ? 'west' : 'east'} bank (${before.toFixed(2)} -> ${cState.control.toFixed(2)})`);
  }
  game.stop();
}

// ------------------------------------------------------------------ after the Iron Bridge collapse
{
  const game = new GameEngine({ mode: 'conquest', world: createMapState('frontier'), mapMeta: meta, broadcast: () => {} });
  const bots = attachBots(game, 4);
  game.step(TICK_MS);
  const pier = [IRON_BRIDGE.x - 0.5, IRON_BRIDGE.waterY + 1, IRON_BRIDGE.z - 2.5];
  for (let i = 0; i < 10; i++) game.mode.onBlast(pier, { key: 'rocket', radius: 3, ownerId: null });
  for (let t = 0; t < (IRON_BRIDGE_RULES.warnMs + STRUCTURE_RULES.creakMs + 4000) / TICK_MS; t++) game.step(TICK_MS);
  ok(game.mode.policy.bridge.down, 'the Iron Bridge is down');
  // The rubble lies on the bed: the lane under the old span keeps its water.
  const lane = boatLane(game), at = laneProgress(lane, IRON_BRIDGE);
  let clear = 0;
  for (let s = at - 14; s <= at + 14; s += 1) {
    const p = lanePoint(lane, s);
    let top = 0;
    for (let y = RIVER.surfaceY + 3; y > 0; y--) if (isSolidBlock(game.world.getBlock(Math.floor(p.x), y, Math.floor(p.z)))) { top = y; break; }
    if (top <= RIVER.surfaceY - 1) clear++;
  }
  ok(clear >= 27, `the channel under the fallen span keeps 2 m of water or more (${clear}/29 lane samples)`);
  for (const [boatId, team, from, to] of [['alpha-boat-north', 'alpha', at - 90, at + 70], ['bravo-boat-north', 'bravo', at + 70, at - 90]]) {
    const run = sail(game, bots, boatId, team, from, to, 60);
    ok(run.arrived != null && run.crossed.has(IRON_BRIDGE.crossing), `${team}: a bot sails ${boatId} through the fallen Iron Bridge (${run.arrived?.toFixed(1)} s, at ${run.at.x.toFixed(0)},${run.at.z.toFixed(0)})`);
    ok(run.lost <= VEHICLE_RULES.boat.hp * 0.1, `${team}: the rubble does not hole it (${run.lost.toFixed(0)} hp lost)`);
    notes.push(`${team} through the fallen span in ${run.arrived.toFixed(1)} s`);
  }
  bots.dispose(); game.stop();
}

console.log(`Frontier river: ${checks} checks passed (channel, fords, decks, bot helmsmen end to end for both teams, flag C from both banks, boats through the fallen Iron Bridge) in ${((performance.now() - started) / 1000).toFixed(1)} s: ${notes.join('; ')}.`);
