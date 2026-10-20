// Frontier ford sluices (docs/conquest.md "Ford sluices"): the template's
// ponds (one voxel over the reach, no water faces but the spill and the boat
// chute), the north sluice blown down by five RX-8 rockets (damaged, the groan
// with ford-north closed, the fall, 300 + assist), the release (pond drained,
// a swimmer in the ford shoved downstream by the bore, the stepping stones),
// the scoured ford (3 m of water: a tank floods and cannot cross where it
// waded before; the road detour in metres), the HUD presenter and FX hook,
// the bots' overrun tasks, and the rematch.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { AIR, MC_WATER, isSolidBlock } from '../shared/world/blocks.js';
import { WADE_RULES } from '../shared/vehicle-defs.js';
import { riverCentreX } from '../shared/world/frontier-terrain.js';
import { SLUICES } from '../shared/map-events/weir.js';
import { SLUICE_EVENTS, SLUICE_NORTH_EVENT, SLUICE_RELEASE } from '../shared/map-events/sluice.js';
import { SluiceController } from '../server/modes/conquest/map-events/sluice.js';
import { closedCrossings } from '../server/bot-bridge.js';
import { crossingDenialValue, hazardAt, roadMetres } from '../server/bot-map-events.js';
import { mapEventBanner } from '../public/js/ui/conquest/map-events.js';
import { MAP_EVENT_PRESENTERS } from '../public/js/ui/conquest/map-events/registry.js';
import { MAP_EVENT_FX } from '../public/js/fx/map-events/registry.js';
import { TICK_MS, eventFixture, groundY } from './lib/map-event-fixtures.mjs';

const t0 = performance.now();
const F = eventFixture({ map: 'frontier', defs: SLUICE_EVENTS, controllers: { 'sluice-north': SluiceController, 'sluice-south': SluiceController } });
const { game, policy, system, world } = F;
const [NORTH, SOUTH] = SLUICES;
const faceRow = w => w.pond.faceY - 1;
const pondCells = w => { let n = 0; for (let z = w.sill.z0; z <= w.pond.z1; z++) for (let x = w.pond.x0; x <= w.pond.x1; x++) if (world.getBlock(x, faceRow(w), z) === MC_WATER) n++; return n; };
const topSolid = (x, z) => { for (let y = 30; y > 0; y--) if (isSolidBlock(world.getBlock(x, y, z))) return y; return 0; };
const fordDepth = (w, x, z) => 22 - (topSolid(x, z) + 1);
const notes = [];

// ---------------------------------------------------------------- the ponds in the template
for (const w of SLUICES) {
  // The bore's centreline (`reach`, data so the client never loads the terrain) is the river's.
  for (const [z, x] of w.reach) assert(Math.abs(riverCentreX(z) - x) < 0.1, `${w.id}: reach z${z} at x ${x} (the river ${riverCentreX(z).toFixed(2)})`);
  const y = faceRow(w);
  let faces = 0, leaks = 0;
  for (let z = w.sill.z0; z <= w.pond.z1; z++) for (let x = w.pond.x0; x <= w.pond.x1; x++) {
    if (world.getBlock(x, y, z) !== MC_WATER) continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (world.getBlock(x + dx, y, z + dz) !== AIR) continue;
      faces++;
      const spill = z + dz > w.pond.z1 && x >= w.pass.x0 && x <= w.pass.x1, chute = z + dz < w.sill.z0 && x >= w.sill.chute.x0 && x <= w.sill.chute.x1;
      if (!spill && !chute) leaks++;
    }
  }
  const pass = w.pass.x1 - w.pass.x0 + 1, chute = w.sill.chute.x1 - w.sill.chute.x0 + 1;
  assert.equal(leaks, 0, `${w.id}: the pond (face y${w.pond.faceY}) is closed but for the spill and the chute`);
  assert.equal(faces, pass + chute, `${w.id}: one face per spill and chute column (${faces})`);
  notes.push(`${w.id} pond ${pondCells(w)} cells`);
  const ford = (game.mapMeta.conquest.crossings).find(c => c.id === w.crossing);
  assert.equal(fordDepth(w, Math.floor(ford.x), Math.floor(ford.z)), 1, `${w.crossing}: one metre of water before the release`);
}

// ---------------------------------------------------------------- blown down by rockets
const a = F.player('a', 'alpha'), b = F.player('b', 'alpha');
const swimmer = F.player('s', 'bravo');
F.run(TICK_MS * 2);
const north = system.instance('sluice-north'), ctl = north.controller;
assert(ctl.levolution.active && system.instance('sluice-south').controller.levolution.active, 'both sluices stand: their levolutions take part');
const A = game.mapMeta.conquest.flags.find(f => f.id === 'A'), D = game.mapMeta.conquest.flags.find(f => f.id === 'D');
const open = roadMetres(game, A, D, []), cut = roadMetres(game, A, D, [NORTH.crossing]);
assert(cut > open + 100, `closing ford-north lengthens A-D by road (${open.toFixed(0)} -> ${cut.toFixed(0)} m)`);
notes.push(`G2 at the start: ${SLUICES.map(w => `${w.crossing} ${crossingDenialValue(game, 'alpha', { close: w.crossing })}/${crossingDenialValue(game, 'bravo', { close: w.crossing })}`).join(', ')} m`);
const pier = NORTH.piers[0], at = [pier.x0 + 0.5, 23.5, NORTH.z0 + 1.5];
const rocket = by => game.mode.onBlast(at, { key: 'rocket', radius: 3, ownerId: by });
rocket('b'); rocket('b'); rocket('b');
F.run(TICK_MS);
assert.equal(north.phase, 'armed', `three rockets: damaged (${Math.round(ctl.levolution.integrity * 100)} %)`);
const presenter = MAP_EVENT_PRESENTERS['sluice-north'];
const banner = mapEventBanner(F.kinds().find(e => e.phase === 'armed'), { defs: SLUICE_EVENTS, presenters: MAP_EVENT_PRESENTERS });
assert.equal(`${banner?.title} · ${banner?.detail}`, 'FORD-NORTH SLUICE · DAMAGED · SUPPORTS AT 40 %', `the HUD banners the supports (${banner?.title} · ${banner?.detail})`);
rocket('a'); rocket('a');
F.run(TICK_MS);
assert.equal(north.phase, 'warning', 'five rockets: the groan');
assert(closedCrossings(game).has(NORTH.crossing), 'ford-north closes for bot drivers from the groan on');
const fordN = game.mapMeta.conquest.crossings.find(c => c.id === NORTH.crossing);
assert(hazardAt(game, { x: fordN.x, y: 21, z: fordN.z }, 'alpha'), 'bots clear the ford below the gates from the groan on');

F.runUntil(() => north.phase === 'active', 5000);
const pts = id => F.kinds('score').filter(e => e.id === id && e.reason === 'map_event').reduce((n, e) => n + e.pts, 0);
assert.equal(pts('a'), 300, 'the final blow pays 300');
assert(pts('b') > 100 && pts('b') <= 120, `the assist pays its share (${pts('b')})`);
// A swimmer in the ford as the bore comes through is carried downstream.
F.place(swimmer, fordN.x + 0.5, fordN.z - 4, 21.02);
const z0 = swimmer.z;
// The release's peak tick (the fall's chunks, the drain, the push zones).
let peak = 0;
for (let t = 0; t < SLUICE_RELEASE.drainMs + 500; t += TICK_MS) { const s = performance.now(); game.step(TICK_MS); peak = Math.max(peak, performance.now() - s); }
notes.push(`release peak tick ${peak.toFixed(1)} ms`);
assert(swimmer.z > z0 + 4, `the bore carries a swimmer down the ford (${(swimmer.z - z0).toFixed(1)} m)`);
notes.push(`swimmer carried ${(swimmer.z - z0).toFixed(1)} m in ${((SLUICE_RELEASE.drainMs + 500) / 1000).toFixed(1)} s`);
assert.equal(pondCells(NORTH), 0, 'the pond has drained');
assert(!isSolidBlock(world.getBlock(388, NORTH.deckY, 255)) && !isSolidBlock(world.getBlock(pier.x0, 20, NORTH.z0)), 'walkway and piers are gone');
assert(isSolidBlock(world.getBlock(NORTH.abutments[0].x0, NORTH.deckY, 255)), 'the abutments stay');
let stones = 0;
for (let x = NORTH.abutments[0].x1 + 1; x < NORTH.abutments[1].x0; x++) if (topSolid(x, NORTH.walk.z0) >= 22) stones++;
assert(stones >= 12, `stepping stones across the old walkway (${stones} columns over the water)`);
const release = F.kinds().find(e => e.event === 'sluice-north' && e.note === 'release');
const fallen = F.kinds().find(e => e.event === 'sluice-north' && e.note === 'fallen');
notes.push(`fall ${fallen?.data?.blocks ?? '?'} blocks, pond drained ${release?.data?.pond ?? '?'} cells, ${stones} stone columns`);

// ---------------------------------------------------------------- the washed-out ford
let scourPeak = 0;
for (let t = 0; north.phase !== 'done' && t < SLUICE_RELEASE.doneMs + 5000; t += TICK_MS) { const s = performance.now(); game.step(TICK_MS); scourPeak = Math.max(scourPeak, performance.now() - s); }
notes.push(`stones/scour peak tick ${scourPeak.toFixed(1)} ms`);
assert.equal(north.phase, 'done', 'the release ends');
const scoured = F.kinds().find(e => e.event === 'sluice-north' && e.note === 'scoured');
assert(scoured, 'the ford bed is scoured');
notes.push(`scour ${scoured.data?.cells} cells; active ev ${JSON.stringify(F.snap?.match?.conquest?.ev ?? []).length} B`);
const depth = fordDepth(NORTH, Math.floor(fordN.x), Math.floor(fordN.z));
assert.equal(depth, 1 + SLUICE_RELEASE.scour.depth, `ford-north: ${depth} m of water`);
assert(depth > WADE_RULES.depth.tank, 'deeper than any hull wades');
// A tank on the scoured bed floods (and the one on the untouched south ford wades).
const tank = [...game.vehicles.vehicles.values()].find(v => v.type === 'tank');
const fordS = game.mapMeta.conquest.crossings.find(c => c.id === SOUTH.crossing);
Object.assign(tank, { x: fordS.x + 0.5, z: fordS.z + 0.5, y: topSolid(Math.floor(fordS.x), Math.floor(fordS.z)) + 1, vx: 0, vy: 0, vz: 0 });
assert(!game.vehicles.flooded(tank), `a tank wades the south ford (${game.vehicles.waterDepth(tank).toFixed(2)} m)`);
Object.assign(tank, { x: fordN.x + 0.5, z: fordN.z + 0.5, y: topSolid(Math.floor(fordN.x), Math.floor(fordN.z)) + 1 });
assert(game.vehicles.flooded(tank), `a tank floods in the washed-out ford (${game.vehicles.waterDepth(tank).toFixed(2)} m against ${WADE_RULES.depth.tank})`);
// Driven down the road from the west bank it never makes the east bank.
const driver = F.player('t', 'alpha');
Object.assign(tank, { x: fordN.x - 22, z: fordN.z + 0.5, y: groundY(world, fordN.x - 22, fordN.z) - 0.02, yaw: -Math.PI / 2, speed: 0, hp: tank.maxHp ?? tank.hp, team: 'alpha' });
F.place(driver, tank.x, tank.z);
assert(game.vehicles.enter(driver, tank.id, 'driver'), 'a driver boards the tank');
let farX = tank.x;
for (let t = 0; t < 30000; t += TICK_MS) { driver.input = { ...driver.input, keys: {}, vehicleThrottle: 1, vehicleSteer: 0, vehicleBrake: 0 }; game.step(TICK_MS); farX = Math.max(farX, tank.x); }
// The east bank: the first column past the scoured bed back at the reach's face or over it.
let bank = Math.floor(fordN.x);
while (topSolid(bank, Math.floor(fordN.z)) < 21) bank++;
assert(farX < bank, `a tank driven at it does not cross ford-north (got to x ${farX.toFixed(1)}, the east bank wall is at x ${bank})`);
notes.push(`tank stuck at x ${farX.toFixed(1)} under the x ${bank} wall`);
const after = roadMetres(game, A, D);
assert(Math.abs(after - cut) < 1, `the bots' road A-D now detours (${open.toFixed(0)} -> ${after.toFixed(0)} m)`);
notes.push(`A-D ${open.toFixed(0)} -> ${after.toFixed(0)} m`);

// ---------------------------------------------------------------- the joiner's row, the presenter and FX
const row = F.decoded().events.find(e => e.id === 'sluice-north');
assert.deepEqual([row.phase, row.progress], ['done', 1], 'ev: done, the pool gone');
assert.equal(presenter.marker({ name: 'x' }, row).name, 'N SLUICE · WASHED OUT');
const sounds = [], kit = { defs: SLUICE_EVENTS, audio: { structureCreak: () => sounds.push('creak'), structureImpact: () => sounds.push('impact') },
  puff: () => sounds.push('puff'), shake: () => {}, ring: p => p, sound: { impact: () => sounds.push('impact'), creak: () => sounds.push('creak') } };
const fx = MAP_EVENT_FX['sluice-north'];
assert(fx.onEvent({ kind: 'map_event', event: 'sluice-north', phase: 'armed' }, kit) && sounds.includes('creak'), 'the FX hook groans on damaged');
fx.sync({ id: 'sluice-north', def: SLUICE_NORTH_EVENT, phase: 'active', leftMs: SLUICE_RELEASE.doneMs - 3000 }, kit, { fresh: true });
fx.update(0.1, kit);
assert(sounds.includes('puff'), 'the bore front throws spray');
fx.clear(kit);

// ---------------------------------------------------------------- bots: the overrun side blows it, the attacker holds
policy.reset();
F.run(TICK_MS * 2);
const again = system.instance('sluice-north');
assert(again.phase === 'idle' && pondCells(NORTH) > 1000 && fordDepth(NORTH, Math.floor(fordN.x), Math.floor(fordN.z)) === 1 && !closedCrossings(game).has(NORTH.crossing),
  'the rematch rebuilds the sluice, the pond and the ford');
const westTank = [...game.vehicles.vehicles.values()].find(v => v.type === 'tank' && v.team === 'alpha') ?? tank;
const crew = F.player('c', 'alpha');
Object.assign(westTank, { x: fordN.x - 30, z: fordN.z, y: groundY(world, fordN.x - 30, fordN.z) - 0.02, hp: 1000, team: 'alpha' });
for (const v of game.vehicles.vehicles.values()) if (v !== westTank && v.team === 'bravo' && Math.hypot(v.x - fordN.x, v.z - fordN.z) < 160) Object.assign(v, { hp: 0, respawnIn: 1e9 });
F.place(crew, westTank.x, westTank.z);
assert(game.vehicles.enter(crew, westTank.id, 'driver'));
const east = again.controller.botTasks('bravo').map(t => t.id), west = again.controller.botTasks('alpha').map(t => t.id);
assert.deepEqual(east, ['demolish:sluice-north'], `EAST, run over by a WEST tank at the ford, blows the sluice (${east})`);
assert.deepEqual(west, ['hold:sluice-north:0', 'hold:sluice-north:1'], `WEST holds the ford's bank ends (${west})`);
console.log(`conquest sluice: ok (${(performance.now() - t0).toFixed(0)} ms): ${notes.join('; ')}`);
