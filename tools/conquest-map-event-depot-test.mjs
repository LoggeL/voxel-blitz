// Forward service depots (docs/conquest.md "Forward service depots") on the
// real worlds: the sites against the templates, the service loop and its
// gameplay effect against the field regen (HP to full, rearm, damage pause,
// one hull at a time, owner = flag holder), the pool and the chain reaction
// (score, burning road, no service afterwards), the bots (return to base by
// road metres, demolition only on evidence, AA guard), wire, HUD and reset.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { PALE, SCORCHED_EARTH, AIR } from '../shared/world/blocks.js';
import { VEHICLE_STATUS } from '../shared/conquest-contract.js';
import { decodeConquestMatch } from '../shared/conquest.js';
import { MAP_EVENT_DEFS, mapEventsFor } from '../shared/conquest-map-events.js';
import { vehicleMaxHp } from '../shared/vehicles.js';
import { DEPOT_EVENT, DEPOT_EVENTS, DEPOT_SITES, DEPOT_WEST_EVENT } from '../shared/map-events/depot.js';
import { DepotController } from '../server/modes/conquest/map-events/depot.js';
import { MAP_EVENT_CONTROLLERS } from '../server/modes/conquest/map-events/registry.js';
import { planMapEventTasks } from '../server/bot-map-events.js';
import { ConquestVehicleDriving, vehicleRoute } from '../server/bot-vehicle-driving.js';
import { depotGuard, depotTrip, routeLength } from '../server/bot-depot.js';
import { mapEventBanner, mapEventMapItems } from '../public/js/ui/conquest/map-events.js';
import { vehiclePanelModel } from '../public/js/ui/conquest-hud-state.js';
import { TICK_MS, eventFixture, groundY, mapEventWireBytes } from './lib/map-event-fixtures.mjs';

const T = DEPOT_EVENT.tuning, S = T.service;
const controllers = { depot: DepotController, 'depot-w': DepotController };
assert(MAP_EVENT_DEFS.includes(DEPOT_EVENT) && MAP_EVENT_DEFS.includes(DEPOT_WEST_EVENT) && MAP_EVENT_CONTROLLERS['depot-w'] === DepotController, 'both slots');
assert.deepEqual(mapEventsFor('frontier').map(d => d.id), ['comeback', 'depot', 'depot-w'], 'Frontier wire indices');
assert.deepEqual(mapEventsFor('redrock').map(d => d.id), ['comeback', 'dam', 'depot', 'depot-w'], 'Redrock wire indices');

/** Every site's tank bodies as generated (a site change fails here). */
function checkSites(world, map) {
  for (const site of Object.values(DEPOT_SITES[map])) for (const t of site.tanks) {
    for (let y = t.y0 + 2; y <= t.y0 + 6; y++) assert.equal(world.getBlock(Math.floor(t.x), y, Math.floor(t.z)), PALE, `${map} ${site.id} ${t.id} body at y ${y}`);
  }
}

// ======================================================================== Frontier
const F = eventFixture({ defs: DEPOT_EVENTS, controllers });
const { game, policy, system, world } = F;
checkSites(world, 'frontier');
const onSite = s => ({ ...s, pump: { ...s.pump, site: true } });
const kestrel = onSite(DEPOT_SITES.frontier.west);
const west = system.instance('depot-w'), east = system.instance('depot');
const hulls = game.vehicles.vehicles, V = id => hulls.get(id);
const park = (v, at, dx = 0, dz = 0) => {
  // From the site's own floor (a canopy roof is not the forecourt), else the column's top.
  const x = at.x + dx, z = at.z + dz, probe = at.site ? at.y : groundY(world, x, z) ?? at.y;
  v.y = probe + 0.5;
  const y = game.vehicles.placement(v, x, z) ?? probe;
  return Object.assign(v, { x, y, z, vx: 0, vy: 0, vz: 0, speed: 0, lastDamagedAt: -Infinity, grounded: true });
};
const frac = v => v.hp / vehicleMaxHp(v);
F.run(TICK_MS * 2);
assert.deepEqual(F.snap.match.conquest.ev, [[0, 0], [1, 0]], 'a standing depot rides a 5 B idle row (the map badge)');

// ---------------------------------------------------------------- the service and its effect
const tank = park(V('alpha-tank'), kestrel.pump, 9, 0), control = park(V('bravo-tank'), { x: 640, y: 37, z: 300 });
tank.hp = control.hp = 0.3 * vehicleMaxHp(tank);
const at = V('alpha-jeep_at');
park(at, kestrel.pump, -9, 0); at.mounts[0].ammo = 0; at.mounts[0].rearm = [90, 90, 90];
let t = 0;
const fullAt = { tank: null };
while (t < 30000 && fullAt.tank == null) { game.step(TICK_MS); t += TICK_MS; if (tank.hp >= vehicleMaxHp(tank)) fullAt.tank = t; }
const regen = frac(control);
console.log(`depot service: tank 30 % -> 100 % in ${(fullAt.tank / 1000).toFixed(1)} s on the Kestrel forecourt; `
  + `field regen in the same time: 30 % -> ${Math.round(regen * 100)} % (caps at ${Math.round(0.6 * 100)} %)`);
// 5 %/s on top of the field regen (2 %/s to 60 %): 30 -> 100 % in about 12 s, where the field alone stops at 60 %.
assert(fullAt.tank >= 11500 && fullAt.tank <= 14500, `30 -> 100 % in about 12 s (${fullAt.tank} ms)`);
assert(regen <= 0.6 + 1e-6, 'away from the depot the hull never passes 60 %');
assert.equal(at.mounts[0].ammo, 0, 'one hull at a time: the AT jeep waited');
F.run(500);
const row = game.vehicles.snapshot().find(r => r.id === 'alpha-jeep_at');
assert(row.st & VEHICLE_STATUS.servicing, 'the next hull carries the servicing bit');
F.run(S.rearmMs + 300);
assert.equal(at.mounts[0].ammo, 3, 'TOW magazine refilled over 6 s');
assert.equal(at.mounts[0].rearm.length, 0, 'its pending rearm timers dropped');
// Damage pauses it; an enemy hull is never served; the owner follows the flag.
tank.hp = 0.5 * vehicleMaxHp(tank); park(tank, kestrel.pump, 9, 0);
F.run(1000);
const before = tank.hp;
tank.hp -= 1; tank.lastDamagedAt = game.now; // what any hit writes (server/sim/vehicle-damage.js)
F.run(S.quietMs - 500);
assert(Math.abs(tank.hp - (before - 1)) < 1, `a hit pauses the service for 4 s (${before} -> ${tank.hp}, hit at ${tank.lastDamagedAt}, now ${game.now})`);
F.run(1500);
assert(tank.hp > before + 10, 'then it resumes');
const enemy = park(V('bravo-jeep'), kestrel.pump, 6, 4); enemy.hp = 100;
F.run(1500);
assert(!(enemy.depotServiceUntil > 0) && west.controller.servicedHull() !== enemy, 'an enemy hull on the forecourt gets nothing');
const flagA = policy.capture.flags.find(f => f.id === 'A'), heldA = { ...flagA };
Object.assign(flagA, { owner: null, control: 0 });
const hpNeutral = tank.hp; F.run(1000);
assert.equal(tank.hp, hpNeutral, 'a neutral flag: no service');
Object.assign(flagA, { owner: heldA.owner, control: heldA.control, state: heldA.state, mover: heldA.mover });
park(enemy, { x: 600, y: 37, z: 360 });

// ---------------------------------------------------------------- bots: return to base, guard, evidence
{
  const driving = new ConquestVehicleDriving(game);
  const near = park(V('alpha-tank'), { x: 400, y: 30, z: 330 }); near.hp = 0.4 * vehicleMaxHp(near);
  const crew = F.player('rtb', 'alpha');
  const br = { id: 'rtb', rng: () => 0.5 };
  const inp = {};
  const road = routeLength(near, vehicleRoute(game, near, kestrel.pump));
  assert(depotTrip(driving, br, crew, near, game.now, inp, vehicleRoute) && br.depotTrip.depotId === 'depot-w', '40 % HP, Kestrel in reach: drives to the depot');
  console.log(`depot bots: return to base over ${Math.round(road)} m of road (limit ${T.bots.rtbRoadM} m)`);
  assert(road <= T.bots.rtbRoadM && road > 100 && (inp.vehicleThrottle || inp.vehicleSteer), 'by road, at the wheel');
  near.hp = 0.6 * vehicleMaxHp(near); br.depotTrip = null; br.depotScanAt = 0;
  assert(!depotTrip(driving, br, crew, near, game.now, {}, vehicleRoute), 'above 45 %: no trip');
  const far = park(near, { x: 384, y: 26, z: 560 }); far.hp = 0.3 * vehicleMaxHp(far); br.depotScanAt = 0;
  assert(!depotTrip(driving, br, crew, far, game.now, {}, vehicleRoute), `${Math.round(routeLength(far, vehicleRoute(game, far, kestrel.pump)))} m of road away: no trip`);
  const aa = park(V('alpha-aa'), kestrel.pump, 40, 40);
  assert.equal(depotGuard(game, aa, 'alpha')?.threat.id ?? null, null, 'no enemy near: the AA is free');
  park(enemy, kestrel.pump, 80, -60);
  assert.equal(depotGuard(game, aa, 'alpha'), null, 'an empty enemy hull (or a parked boat) is no threat');
  const driver = F.player('bd', 'bravo'); F.place(driver, enemy.x + 1, enemy.z, enemy.y);
  assert(game.vehicles.enter(driver, enemy.id), 'a bravo driver boards');
  assert.equal(depotGuard(game, aa, 'alpha')?.depotId, 'depot-w', 'an enemy hull within 150 m: the AA guards the forecourt');
  game.vehicles.exit(driver);
  park(enemy, { x: 600, y: 37, z: 360 }); park(aa, { x: 127, y: 37, z: 434 });
}
// Evidence: alpha serviced the tank and the AT jeep (two visits), so bravo may demolish; alpha never shoots its own.
const tasks = system.view().tasks;
assert(tasks.bravo.some(k => k.id === 'depot-w:demolish' && k.kits?.includes('engineer')) && tasks.bravo.some(k => k.kind === 'shoot'), 'bravo demolishes on evidence');
assert(!tasks.alpha.length && !tasks.bravo.some(k => k.event === 'depot'), 'nobody targets an unused depot or its own');
{
  const eng = F.player('eng', 'bravo'); F.place(eng, kestrel.anchor.x + 70, kestrel.anchor.z + 30); eng.bot = true;
  const ts = { team: 'bravo', squads: new Map(), crews: new Map(), hitches: new Map(), memberSquad: new Map() };
  planMapEventTasks({ game, teamBrains: () => [{ id: 'eng' }], kitOf: () => 'engineer' }, ts, game.now);
  assert.equal(ts.eventAssign.get('eng'), 'depot-w:demolish', 'an Engineer 76 m out walks in');
  eng.bot = false;
}

// ---------------------------------------------------------------- HUD: badge, card, banner
{
  F.run(TICK_MS * 2);
  const cq = decodeConquestMatch(F.snap.match.conquest, F.meta.conquest, { mapId: 'frontier', eventDefs: DEPOT_EVENTS });
  const items = mapEventMapItems(cq, 'alpha').filter(i => i.kind === 'event');
  assert.deepEqual(items.map(i => [i.id, i.tone]), [['depot', 'enemy'], ['depot-w', 'own']], 'badges in the flag owner\'s colour');
  park(tank, kestrel.pump, 9, 0); tank.hp = 0.5 * vehicleMaxHp(tank); F.run(600);
  const seated = { row: game.vehicles.snapshot().find(r => r.id === 'alpha-tank'), seat: { id: 'driver', role: 'driver', drives: true } };
  const panel = vehiclePanelModel(seated, { selfId: 'x' });
  assert(panel.servicing && panel.badges.some(b => b.key === 'servicing') && panel.service === 'DEPOT · HULL +5 %/S', 'the SERVICING card');
  assert.deepEqual(F.snap.match.conquest.ev[1], [1, 0, 0, -1, -1, [1]], 'the badge pulses while a hull is serviced');
}

// ---------------------------------------------------------------- the pool and the chain
const a = F.player('a', 'alpha'), b = F.player('b', 'bravo'), b2 = F.player('b2', 'bravo');
F.place(b, 330, 300); F.place(b2, 331, 300);
const w0 = kestrel.tanks[0];
const rocket = (by, tk = w0) => system.onBlast([tk.x, tk.y0 + 4, tk.z], { key: 'rocket', radius: 3, ownerId: by });
for (let i = 0; i < 4; i++) rocket('b2');
for (let i = 0; i < 4; i++) rocket('b');
system.onBlast([w0.x, w0.y0 + 4, w0.z], { key: 'rifle', radius: 0, ownerId: 'b' });
assert.equal(west.phase, 'idle', '8 rockets of 9 (rifles do nothing)');
assert(Math.abs(west.controller.progress() - 800 / 900) < 1e-6, 'the gauge is the pool\'s lost share');
const t0 = performance.now();
rocket('b', kestrel.tanks[2]);
const triggerMs = performance.now() - t0;
assert.deepEqual([west.phase, west.team, west.by], ['warning', 'bravo', 'b'], 'the 9th RX-8 sets the chain off');
F.run(TICK_MS * 2);
const score = id => F.events.filter(e => e.kind === 'score' && e.id === id && e.reason === 'map_event').reduce((s, e) => s + e.pts, 0);
assert(score('b') > score('b2') && score('b2') > 0, `final blow ${score('b')} beats the assist ${score('b2')}`);
assert.deepEqual(F.kinds().filter(e => e.event === 'depot-w' && e.note === 'burst').map(e => e.data.tank), [2], 'the wagon nearest the blast first');
let peak = 0;
for (let s = 0; s < 3500; s += TICK_MS) { const s0 = performance.now(); game.step(TICK_MS); peak = Math.max(peak, performance.now() - s0); }
assert.equal(west.phase, 'active');
const road = system.hazards.of(west).find(z => z.id === 'depot-w-road');
assert(road && road.until - game.now > 40000 && system.view().hazards.includes(road), 'the a-c road stretch burns for 45 s and bots keep out');
F.run(4000);
assert.equal(world.getBlock(Math.floor(w0.x), w0.y0 + 3, Math.floor(w0.z)), AIR, 'the wagons are gone');
assert.equal(world.getBlock(Math.floor(w0.x), w0.y0 - T.crater.depth, Math.floor(w0.z)), SCORCHED_EARTH, 'a scorched bowl');
park(tank, kestrel.pump, 9, 0); tank.hp = 0.8 * vehicleMaxHp(tank); // above the field regen's cap
const dead = tank.hp; F.run(2000);
assert(tank.hp <= dead, 'a destroyed depot serves no one for the round');
assert.equal(system.view().tasks.bravo.filter(k => k.event === 'depot-w').length, 0, 'and draws no more tasks');
const banner = mapEventBanner({ kind: 'map_event', event: 'depot-w', phase: 'active', team: 'bravo', pos: [254, 31, 324] }, { nowMs: 0, selfTeam: 'alpha' });
assert.equal(banner.title, 'KESTREL HALT DEPOT · DESTROYED', 'the banner names the site');
const bytes = mapEventWireBytes(F.snap.match.conquest);
console.log(`depot chain: trigger ${triggerMs.toFixed(2)} ms, peak tick ${peak.toFixed(2)} ms, ${system.edits.stats.cells} staged cells, ev ${bytes} B (${JSON.stringify(F.snap.match.conquest.ev)})`);
assert(bytes <= 40, 'both rows stay small');

// ---------------------------------------------------------------- rematch
policy.reset();
F.run(TICK_MS * 2);
assert.equal(world.getBlock(Math.floor(w0.x), w0.y0 + 3, Math.floor(w0.z)), PALE, 'the rematch restores the wagons');
assert(system.instance('depot-w').phase === 'idle' && system.targets.share(system.instance('depot-w').controller.pool) === 1, 'whole again');
assert.deepEqual(F.snap.match.conquest.ev, [[0, 0], [1, 0]]);

// ======================================================================== Redrock and Breakthrough
{
  const R = eventFixture({ map: 'redrock', variant: 'breakthrough', defs: DEPOT_EVENTS, controllers });
  checkSites(R.world, 'redrock');
  assert(R.system.instance('depot') && R.system.instance('depot-w'), 'Breakthrough keeps both depots');
  const juniper = DEPOT_SITES.redrock.east, owner = R.policy.capture.flags.find(f => f.id === juniper.flag);
  owner.owner = 'bravo';
  const v = R.game.vehicles.vehicles.get('bravo-tank');
  const x = juniper.pump.x + 9, z = juniper.pump.z;
  v.y = juniper.pump.y + 0.5;
  Object.assign(v, { x, z, y: R.game.vehicles.placement(v, x, z) ?? juniper.pump.y, lastDamagedAt: -Infinity, hp: 0.7 * vehicleMaxHp(v) });
  R.run(2000);
  const c = R.system.instance('depot').controller;
  assert(c.onForecourt(v, 'bravo') && v.hp > 0.75 * vehicleMaxHp(v), `Juniper services EAST's tank on Redrock (${c.owner()}, ${Math.round(v.x)} ${v.y} ${Math.round(v.z)}, ${(v.hp / vehicleMaxHp(v)).toFixed(2)})`);
}
console.log('conquest map event depot: sites, service, effect, owner, bots, evidence, HUD, chain, road fire, wire, rematch, Redrock, Breakthrough passed');
process.exit(0);
