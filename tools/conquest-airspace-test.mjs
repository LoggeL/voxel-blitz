// Airspace beyond the map (shared/world/airspace.js): Frontier's aircraft fly
// past the 768 m map over an outer valley ("apron") that the shared world
// state answers voxel queries from, on the server and on the client. Aircraft
// outside the combat airspace run the out-of-bounds timer, which destroys the
// aircraft; bots keep inside their flight area; voxel writes never reach the
// apron.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { createMapState, getMapMeta, deserializeWorld, getBlock as clientBlock } from '../shared/world/templates.js';
import { AIR, METAL, MC_WATER } from '../shared/world/blocks.js';
import { isSolidBlock } from '../shared/worlddata.js';
import { frontierTopY } from '../shared/world/frontier-terrain.js';
import { AIRSPACE, gapBeyond } from '../shared/world/airspace.js';
import { CONQUEST_RULES, decodeConquestPlayer } from '../shared/conquest-contract.js';
import { destroyBlockDirect } from '../server/sim/combat.js';
import { VEHICLE_RULES } from '../shared/vehicles.js';

const world = createMapState('frontier'), meta = getMapMeta('frontier'), apron = world.apron;
const { sx, sz } = meta.dimensions, { combat, limit, botMargin } = AIRSPACE.frontier;

// --- the apron ---------------------------------------------------------------
{
  assert(apron && apron.limit === limit && apron.combat === combat, 'Frontier has an airspace apron');
  assert.equal(createMapState('foundry').apron, null, 'maps without aircraft keep no apron');
  assert.equal(createMapState('foundry').getBlock(-1, 10, 5), METAL, 'and their edge stays a wall');
  // Every apron column: solid up to its ground, open above, the wall past the limit.
  for (const [x, z] of [[-100, 300], [-5, 40], [900, 900], [384, -400], [1500, 200], [-790, -790]]) {
    const ground = apron.groundAt(x, z);
    assert(ground > 0, `apron ground at ${x},${z}`);
    assert(isSolidBlock(world.getBlock(x, ground - 1, z)), `the apron is solid under its ground (${x},${z})`);
    const above = world.getBlock(x, ground, z);
    assert(above === AIR || above === MC_WATER, `and open above it (${x},${z})`);
    assert.equal(world.getBlock(x, 150, z), AIR, 'the sky over the apron is open');
  }
  assert.equal(world.getBlock(-limit - 1, 150, 300), METAL, 'the world ends at the airspace limit');
  assert.equal(world.getBlock(300, 150, sz + limit), METAL);
  // The apron continues the map's rim: next to the edge it stands within a
  // couple of metres of the edge column's top (the river notch included).
  let worst = 0;
  for (let i = 4; i < sx; i += 16) for (const [x, z, ex, ez] of [[i, -3, i, 0], [i, sz + 2, i, sz - 1], [-3, i, 0, i], [sx + 2, i, sx - 1, i]]) {
    worst = Math.max(worst, Math.abs(apron.groundAt(x, z) - (frontierTopY(ex, ez) + 1) - apron.canopy[Math.floor((z - apron.origin) / apron.cell) * apron.nx + Math.floor((x - apron.origin) / apron.cell)]));
  }
  assert(worst <= 3, `the apron meets the map rim without a cliff (worst step ${worst} m)`);
  // The river leaves the map north and south and keeps its water.
  for (const z of [-60, sz + 60]) {
    const water = apron.waterAt(sx / 2, z);
    assert(water > 0 && world.getBlock(sx / 2, water - 1, z) === MC_WATER, `the river runs on past the map edge (z ${z})`);
  }
  // Ground stays below the flight ceiling with room to fly over it.
  assert(apron.top < 120, `apron ground tops out at ${apron.top} m`);
}

// --- the client singleton answers the same apron -----------------------------
{
  deserializeWorld(world.serializeWorld(), { mapId: 'frontier' });
  for (const [x, y, z] of [[-100, 60, 300], [-100, 75, 300], [384, 19, -60], [1200, 70, 1200], [-limit - 5, 100, 0]])
    assert.equal(clientBlock(x, y, z), world.getBlock(x, y, z), `client and server agree beyond the map at ${x},${y},${z}`);
  deserializeWorld(createMapState('foundry').serializeWorld());
  assert.equal(clientBlock(-1, 10, 5), METAL, 'a map loaded without an airspace keeps its edge wall');
}

// --- voxel writes stay on the map --------------------------------------------
{
  const game = new GameEngine({ mode: 'conquest', world, mapMeta: meta });
  const x = -40, z = 300, y = apron.groundAt(x, z) - 1, before = world.getBlock(x, y, z);
  const ctx = { getBlock: world.getBlock, setBlock: world.setBlock, blockHp: new Map(), blockMining: new Map(),
    pushBlockDelta: (...args) => game.pushBlockDelta(...args), pushEvent: () => assert.fail('no block event for the apron') };
  assert.equal(destroyBlockDirect(x, y, z, null, ctx), false, 'apron voxels cannot be destroyed');
  assert.equal(world.getBlock(x, y, z), before);
  const revision = game.blockRevision;
  game.pushBlockDelta(-1, 30, 5, AIR);
  assert.equal(game.blockRevision, revision, 'an out-of-map delta never wraps onto a map voxel');
}

// --- flight beyond the map ---------------------------------------------------
const neutral = { vehiclePitchControl: 0, vehicleRollControl: 0, vehicleYawControl: 0 };
function crewed(type) {
  const game = new GameEngine({ mode: 'conquest', world, mapMeta: meta });
  game.addClient('pilot', 'Pilot');
  const p = game.entities.get('pilot'), v = game.vehicles.vehicles.get(`alpha-${type}`);
  Object.assign(p, { x: v.x + 5, y: v.y, z: v.z });
  game.applyInput(p.id, { keys: {}, vehicleAction: { type: 'enter', vehicleId: v.id } });
  assert.equal(p.vehicleId, v.id);
  return { game, p, v };
}
{
  const { game, p, v } = crewed('plane');
  // Westward at 60 m/s from the map edge: no wall, no damage, no takeover.
  Object.assign(v, { x: 10, y: 140, z: 380, yaw: Math.PI / 2, pitch: 0, roll: 0, grounded: false, gearDown: false,
    vx: -60, vy: 0, vz: 0, speed: 60, airspeed: 60, throttle: .8, enginePower: .8, pitchRate: 0, rollRate: 0, rudderRate: 0, yawRate: 0 });
  for (let i = 0; i < 300; i++) {
    if (i % 3 === 0) game.applyInput(p.id, { keys: {}, yaw: Math.PI / 2, pitch: (140 - v.y) * .01, vehicleThrottle: 0, vehicleLift: 0 });
    game.vehicles.step(1 / 60);
    assert(!game.vehicles.boundaryAvoidance.has(v.id), 'no safety pilot past the map edge');
  }
  assert(v.x < -200, `the jet flies on over the apron (x ${v.x.toFixed(0)})`);
  assert.equal(v.hp, VEHICLE_RULES.plane.hp, 'unhurt');
  assert.equal(game.vehicles.clearHull(v, -300, 140, 380), true);
  assert.equal(game.vehicles.clearHull(v, -limit - 20, 140, 380), false, 'the hull cannot pass the airspace limit');
  const ground = apron.groundAt(-300, 380);
  assert.equal(game.vehicles.clearHull(v, -300, ground - 3, 380), false, 'the apron ground is solid to a hull');
  // A bot pilot's guarded area is the combat airspace less the bot margin.
  const area = game.vehicles.flightArea(v, { bot: true });
  assert.deepEqual([area.minX, area.maxX], [-(combat - botMargin), sx + combat - botMargin]);
  assert.deepEqual([game.vehicles.flightArea(v, p).minX], [-limit]);
}

// --- the out-of-bounds timer destroys the aircraft ---------------------------
{
  const { game, p, v } = crewed('helicopter');
  const hover = x => Object.assign(v, { x, y: 130, z: 380, yaw: 0, pitch: 0, roll: 0, grounded: false, vx: 0, vy: 0, vz: 0, speed: 0, airspeed: 0 });
  const row = () => decodeConquestPlayer(game.lastSnapshot?.players?.find(r => r.id === p.id) ?? null);
  let snapshots = 0;
  const events = [];
  game.broadcast = snap => { game.lastSnapshot = snap; snapshots++; events.push(...(snap.events ?? [])); };
  const run = ms => { for (let t = 0; t < ms; t += 1000 / 60) { game.applyInput(p.id, { keys: {}, ...neutral, vehicleThrottle: 0, vehicleLift: 0 }); game.step(1000 / 60); } };
  hover(-(combat - 40));
  run(2000);
  assert.equal(game.mode.policy.restrictedMs(p), 0, 'inside the combat airspace: no timer');
  hover(-(combat + 60));
  run(1000);
  const left = game.mode.policy.restrictedMs(p);
  assert(left > CONQUEST_RULES.outOfBoundsMs - 1200 && left <= CONQUEST_RULES.outOfBoundsMs, `outside it the 10 s timer runs (${left} ms)`);
  assert(snapshots > 0 && row()?.restrictedMs > 0, 'the countdown reaches the client row');
  // Back inside clears it; out again restarts it.
  hover(-(combat - 40)); run(200);
  assert.equal(game.mode.policy.restrictedMs(p), 0, 'returning clears the timer');
  hover(-(combat + 60));
  run(CONQUEST_RULES.outOfBoundsMs - 300);
  assert(v.hp > 0 && p.state === 'alive', 'the aircraft survives until the timer expires');
  run(600);
  assert(!(v.hp > 0), 'an expired timer destroys the aircraft');
  assert.notEqual(p.state, 'alive', 'and its crew');
  assert.equal(p.vehicleId ?? null, null);
  assert(events.some(e => e.kind === 'kill' && e.victim === p.id && e.w === 'restricted'), 'the kill feed names the restricted death');
}

console.log(`Airspace: Frontier apron (top ${apron.top} m, limit ${limit} m) on server and client, map-only voxel writes, `
  + `flight past the edge, bot flight area and the aircraft out-of-bounds timer passed.`);
