// Flag radars (docs/conquest.md "Flag radars") on the real battlefields: the
// sweep (crewed enemy ground hulls within 240 m and aircraft within 400 m of
// the flag, never infantry), ownership following the flag, the bots' demolish
// and deny rules, the 600 pool (6 RX-8), the payout, the groan and the
// directed fall through the structural system (the wreck stays, the ladder
// goes with its column, St. Aldric's capture zone keeps its head room), the
// climbable belfry and towers, the `ev` row, the HUD and FX from the row
// alone, Breakthrough and the rematch reset.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { isSolidBlock } from '../shared/world/blocks.js';
import { ladderContact } from '../shared/world/state.js';
import { MAP_EVENT_DEFS, decodeMapEvents, mapEventsFor } from '../shared/conquest-map-events.js';
import { RADAR_EVENTS, RADAR_SITES, RADAR_TUNING as T, radarMountPart, radarPartCells } from '../shared/map-events/radar.js';
import { RADAR_CONTROLLERS } from '../server/modes/conquest/map-events/radar.js';
import { MAP_EVENT_CONTROLLERS } from '../server/modes/conquest/map-events/registry.js';
import { MapEventSystem } from '../server/modes/conquest/map-events/system.js';
import { PlayerEntity } from '../server/sim/player.js';
import { stepMovement } from '../server/sim/movement.js';
import { eventFlagWeights } from '../server/bot-commander.js';
import { mapEventBanner, paintMapEvents } from '../public/js/ui/conquest/map-events.js';
import { RADAR_PRESENTER, radarChipModel, radarSweepAngle, resetRadarHud } from '../public/js/ui/conquest/map-events/radar.js';
import { MapEventFx } from '../public/js/fx/map-event-fx.js';
import { RADAR_HEAD_FX } from '../public/js/fx/map-events/radar.js';
import { RADAR_COLORS } from '../public/js/ui/conquest/map-events/radar.js';
import { TICK_MS, eventFixture, groundY, mapEventWireBytes } from './lib/map-event-fixtures.mjs';

const ids = map => mapEventsFor(map).map(d => d.id);
for (const def of RADAR_EVENTS) assert(MAP_EVENT_DEFS.includes(def) && MAP_EVENT_CONTROLLERS[def.id] === RADAR_CONTROLLERS[def.id], `${def.id} in both slots`);
assert.deepEqual(ids('frontier').filter(id => id.startsWith('radar')), ['radar-aldric', 'radar-ridge'], 'Frontier B and D');
assert.deepEqual(ids('redrock').filter(id => id.startsWith('radar')), ['radar-mesa', 'radar-palmera'], 'Redrock D and A');

/** The antenna's mount (a three.js head, never voxels) sits on the structure's top voxel, in air, on the part it falls with. */
function checkMounts(world, map, parts) {
  for (const [id, site] of Object.entries(RADAR_SITES).filter(([, s]) => s.map === map)) {
    const m = site.mount, x = Math.floor(m.x), y = Math.floor(m.y), z = Math.floor(m.z);
    assert(isSolidBlock(world.getBlock(x, y - 1, z)) && !isSolidBlock(world.getBlock(x, y, z)) && !isSolidBlock(world.getBlock(x, y + 1, z)), `${id}: the antenna stands on the top voxel`);
    assert.equal(radarMountPart(site)?.id, parts[id], `${id}: it falls with the ${parts[id]}`);
  }
}

const solidOf = world => (x, y, z) => isSolidBlock(world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)));
const setFlag = (policy, id, owner) => Object.assign(policy.flags.find(f => f.id === id), { owner, control: owner === 'alpha' ? 1 : owner === 'bravo' ? -1 : 0, state: 'idle', mover: null });
const solidIn = (world, b) => { let n = 0; for (let y = b.y0; y <= b.y1; y++) for (let z = b.z0; z <= b.z1; z++) for (let x = b.x0; x <= b.x1; x++) if (isSolidBlock(world.getBlock(x, y, z))) n++; return n; };
const scoreOf = (F, id) => F.events.filter(e => e.kind === 'score' && e.id === id && e.reason === 'map_event').reduce((n, e) => n + (e.pts ?? 0), 0);

/** A ladder climb with the authoritative movement: up the volume, then `off` (input keys) steps off the top. Returns the body. */
function climb(world, meta, ladder, off = { f: true }) {
  const solid = solidOf(world), face = ladder.face;
  const yaw = face === 'x-' ? Math.PI / 2 : face === 'x+' ? -Math.PI / 2 : face === 'z-' ? 0 : Math.PI;
  let at = null;
  for (let fx = 0; fx <= 1 && !at; fx += 0.05) for (let fz = 0; fz <= 1 && !at; fz += 0.05) {
    const x = ladder.minX + fx * (ladder.maxX - ladder.minX), z = ladder.minZ + fz * (ladder.maxZ - ladder.minZ);
    if (![0, 1].some(dy => solid(x - 0.3, ladder.minY + dy, z - 0.3) || solid(x + 0.3, ladder.minY + dy, z + 0.3) || solid(x - 0.3, ladder.minY + dy, z + 0.3) || solid(x + 0.3, ladder.minY + dy, z - 0.3))) at = { x, y: ladder.minY + 0.02, z };
  }
  assert(at, 'a body fits at the foot of the ladder');
  const p = Object.assign(new PlayerEntity('climber', 'climber', at, false), { grounded: true, deployT: 0, yaw });
  p.input = { yaw, pitch: 0, keys: { f: true } };
  const ctx = { solidAt: solid, fluidAt: () => false, mapMeta: meta, now: 0, onFall: () => {} };
  p.top = p.y;
  for (let i = 0; i < 60 * 15 && p.y < ladder.maxY - 0.1; i++) { ctx.now += TICK_MS; stepMovement(p, TICK_MS / 1000, ctx); p.top = Math.max(p.top, p.y); }
  p.input.keys = off;
  for (let i = 0; i < 60 && !p.grounded; i++) { ctx.now += TICK_MS; stepMovement(p, TICK_MS / 1000, ctx); }
  return p;
}

// ================================================================== Frontier
const F = eventFixture({ defs: RADAR_EVENTS, controllers: RADAR_CONTROLLERS });
const { game, policy, system, world, meta } = F;
const solid = solidOf(world);
const spotting = policy.roles.spotting;
const ridge = system.instance('radar-ridge'), aldric = system.instance('radar-aldric');
const D = policy.flags.find(f => f.id === 'D'), B = policy.flags.find(f => f.id === 'B');
const a = F.player('a', 'alpha'), a2 = F.player('a2', 'alpha'), a3 = F.player('a3', 'alpha'), a4 = F.player('a4', 'alpha');
const b = F.player('b', 'bravo'), b2 = F.player('b2', 'bravo');
const hull = id => game.vehicles.vehicles.get(id);
const crew = (p, id, x, z) => {
  const v = hull(id), y = groundY(world, x, z);
  Object.assign(v, { x: x + 0.5, y, z: z + 0.5, vx: 0, vy: 0, vz: 0 });
  F.place(p, x + 0.5, z + 2.5);
  assert(game.vehicles.enter(p, id, 'driver'), `${p.id} boards ${id}`);
  return v;
};

// ---------------------------------------------------------------- climbs (the belfry, the observation tower)
checkMounts(world, 'frontier', { 'radar-ridge': 'dome', 'radar-aldric': 'tower' });
const ladders = meta.ladders.filter(l => l.support);
const belfry = ladders.find(l => l.minX < 300), tower = ladders.find(l => l.minX > 500);
{
  const up = climb(world, meta, belfry, { l: true });
  assert(up.top >= 56 && up.grounded && Math.abs(up.y - 56) < 0.05, `the belfry ladder reaches the louvre floor (y ${up.y.toFixed(2)})`);
  const obs = climb(world, meta, tower);
  assert(obs.grounded && Math.abs(obs.y - 54) < 0.05, `the observation tower ladder reaches the platform (y ${obs.y.toFixed(2)})`);
}

F.run(TICK_MS * 2);
assert.deepEqual([ridge.phase, ridge.team, aldric.phase, aldric.team], ['active', 'bravo', 'active', 'alpha'], 'the home flags own their radars');

// ---------------------------------------------------------------- the sweep
const tank = crew(a, 'alpha-tank', D.x, D.z + 200);                 // 200 m: swept
const heli = crew(a2, 'alpha-helicopter', D.x - 250, D.z + 250);    // 354 m aircraft: swept
const jeep = crew(a3, 'alpha-jeep', D.x - 260, D.z);                // 260 m ground: not
const empty = hull('alpha-jeep_at');
Object.assign(empty, { x: D.x + 0.5, y: groundY(world, D.x, D.z + 60), z: D.z + 60.5 });
F.place(a4, D.x + 4.5, D.z + 30.5);                                   // infantry: never
F.runUntil(() => ridge.controller.sweeps > 0, T.firstMs + 500);
assert.equal(ridge.controller.sweeps, 1, 'the first sweep 5 s after the round start');
const swept = new Set(ridge.controller.lastSweep.ids);
assert(swept.has(tank.id) && swept.has(heli.id), 'a crewed tank at 200 m and a helicopter at 354 m are swept');
assert(!swept.has(jeep.id) && !swept.has(empty.id), 'a jeep at 260 m and an empty hull are not');
assert(spotting.isVehicleSpotted(tank.id) && tank.spotted.bravo > game.now && !spotting.isVehicleSpotted(jeep.id), 'through the ordinary spot marks');
assert(!spotting.isSpotted(a4) && !spotting.isSpotted(a), 'never infantry, not even the crew');
assert(F.kinds().some(e => e.event === 'radar-ridge' && e.note === 'sweep' && e.data.team === 'bravo' && e.data.ids.length === 2), 'one `sweep` note');
assert(Math.abs(F.decoded().events.find(e => e.id === 'radar-ridge').leftMs - T.everyMs) <= TICK_MS * 2 + 100, 'the row\'s countdown wraps to 15 s as it fires (the wave\'s clock)');

// ---------------------------------------------------------------- bots: demolish an enemy radar that swept two hulls
policy._view = null;
let tasks = system.view().tasks;
const shootRidge = tasks.alpha.find(t => t.id === 'radar-ridge:shoot'), walk = tasks.alpha.find(t => t.id === 'radar-ridge:demolish');
assert(shootRidge && shootRidge.kind === 'shoot' && walk.kind === 'attack' && walk.squad === 2 && walk.kits.includes('engineer'), 'alpha: shoot plus two Engineers');
assert(!tasks.bravo.some(t => t.event === 'radar-ridge'), 'bravo never shoots the radar it owns');
assert(!tasks.alpha.some(t => t.event === 'radar-aldric') && !tasks.bravo.some(t => t.event === 'radar-aldric'), 'nobody touches St. Aldric yet');
F.run(T.revealMs + 200);
assert(!spotting.isVehicleSpotted(tank.id), 'the mark lasts 5 s');

// ---------------------------------------------------------------- ownership follows the flag; denial of the own radar
setFlag(policy, 'B', null);
F.run(TICK_MS * 2);
assert.deepEqual([aldric.phase, aldric.team], ['idle', null], 'a neutral flag has no radar');
const bTank = crew(b, 'bravo-tank', B.x + 40, B.z - 60);
policy._view = null;
assert(!system.view().tasks.alpha.some(t => t.event === 'radar-aldric'), 'alpha keeps its own radar at first');
F.run(T.bots.denyAfterMs);
policy._view = null;
tasks = system.view().tasks;
assert(tasks.alpha.some(t => t.id === 'radar-aldric:shoot'), 'neutral 30 s with a bravo tank in the ring: alpha denies it');
assert(!tasks.bravo.some(t => t.event === 'radar-aldric'), 'bravo, which never held it, has not been swept by it');
setFlag(policy, 'B', 'bravo');
F.run(TICK_MS * 2);
assert.deepEqual([aldric.phase, aldric.team], ['active', 'bravo'], 'a capture hands it over');
assert(Math.abs(aldric.leftMs - T.firstMs) <= TICK_MS * 2, 'its first sweep 5 s after the capture');
setFlag(policy, 'D', 'alpha');
F.run(TICK_MS * 2);
assert.deepEqual([ridge.phase, ridge.team], ['active', 'alpha']);
policy._view = null;
assert.deepEqual([eventFlagWeights(game).get('B'), eventFlagWeights(game).get('D')], [T.bots.flagWeightM, T.bots.flagWeightM], 'the commander weighs both radar flags');
const row = F.decoded().events;
const bytes = mapEventWireBytes(F.snap.match.conquest);
assert(row.length === 2 && row.every(e => e.phase === 'active' && Number.isFinite(e.leftMs)), 'both rows ride with the sweep timer');
assert.deepEqual(F.snap.match.conquest.ev.map(r => r.length), [5, 5], 'five small integers a row: index, phase, damage, owner, 0.1 s to the sweep');
assert(bytes <= 36, `two radar rows ride ${bytes} B`);

// ---------------------------------------------------------------- 6 rockets bring the ridge down
const site = RADAR_SITES['radar-ridge'];
const towerBox = site.parts[1].boxes[0];
const wreckBox = { x0: 505, y0: 34, z0: 196, x1: 520, y1: 46, z1: 228 };
const towerCells = solidIn(world, towerBox), wreckBefore = solidIn(world, wreckBox);
assert(ladderContact(meta, tower.minX + 0.5, 44, tower.minZ + 0.5, 0, solid), 'the tower ladder holds');
const hit = () => system.onBlast([528.5, 38, 226.5], { key: 'rocket', radius: 3, ownerId: 'b' });
for (let i = 0; i < 5; i++) hit();
assert.equal(ridge.phase, 'active', 'five rockets are not enough');
F.run(TICK_MS);
assert(F.kinds().some(e => e.event === 'radar-ridge' && e.note === 'damaged'), 'the damaged note at half');
hit();
assert.equal(ridge.phase, 'warning', 'the sixth starts the groan');
assert.deepEqual([ridge.team, ridge.by], ['bravo', 'b']);
assert.equal(system.hazards.of(ridge).length, 2, 'the bots keep off both fall lines');
let peak = 0;
const step = () => { const t0 = performance.now(); game.step(TICK_MS); peak = Math.max(peak, performance.now() - t0); };
step();
assert.equal(scoreOf(F, 'b'), 300, 'the last blow pays 300');
assert(F.events.some(e => e.kind === 'creak' && e.id.startsWith('radar-ridge')), 'one creak for the groan');
for (let t = 0; t < T.groanMs; t += TICK_MS) step();
assert.equal(ridge.phase, 'done', 'it falls after 3 s');
for (let t = 0; t < T.landMs; t += TICK_MS) step();
const towerLeft = solidIn(world, towerBox), wreckAfter = solidIn(world, wreckBox);
console.log(`radar ridge: ${towerCells} tower cells -> ${towerLeft}, wreck north ${wreckBefore} -> ${wreckAfter}, ${ridge.controller.cells} cells down, peak tick ${peak.toFixed(2)} ms`);
assert(towerLeft < towerCells * 0.1, 'the tower is gone');
assert(wreckAfter >= wreckBefore + 15, 'its wreck lies north of the footing (the chunks\' rubble, no road pad)');
assert(!ladderContact(meta, tower.minX + 0.5, 44, tower.minZ + 0.5, 0, solid), 'and the ladder went with its column');
const sweeps = ridge.controller.sweeps;
F.run(T.everyMs + 500);
assert(ridge.controller.sweeps === sweeps && ridge.phase === 'done', 'no sweeps for the rest of the round, whoever holds D');
policy._view = null;
assert(!system.view().tasks.bravo.some(t => t.event === 'radar-ridge'), 'no task on a wreck');
assert(!eventFlagWeights(game).has('D'), 'and D weighs as any flag again');

// ---------------------------------------------------------------- St. Aldric: the tower falls onto the nave, the zone keeps its head room
{
  const nave = { x0: 266, y0: 43, z0: 539, x1: 287, y1: 50, z1: 553 };
  const roofBefore = solidIn(world, nave);
  const zone = [];
  for (let z = Math.floor(B.z - 20); z <= B.z + 20; z++) for (let x = Math.floor(B.x - 20); x <= B.x + 20; x++) {
    if (Math.hypot(x + 0.5 - B.x, z + 0.5 - B.z) <= 20) zone.push([x, z, groundY(world, x + 0.5, z + 0.5, 60)]);
  }
  for (let i = 0; i < 6; i++) system.onBlast([261.5, 52, 546.5], { key: 'rocket', radius: 3, ownerId: 'a' });
  assert.equal(aldric.phase, 'warning');
  peak = 0;
  for (let t = 0; t < T.groanMs + T.landMs + 500; t += TICK_MS) step();
  const roofAfter = solidIn(world, nave);
  const buried = zone.filter(([x, z, y]) => (groundY(world, x + 0.5, z + 0.5, 60) ?? 0) > (y ?? 0) + 1.5);
  console.log(`radar aldric: nave roof ${roofBefore} -> ${roofAfter} cells, ${aldric.controller.cells} cells down, ${buried.length}/${zone.length} zone columns raised, peak tick ${peak.toFixed(2)} ms`);
  assert(roofAfter < roofBefore * 0.5, 'the roof caves in');
  assert(buried.length <= zone.length * 0.02, 'the B zone keeps its head room');
  assert(!ladderContact(meta, belfry.minX + 0.5, 45, belfry.minZ + 0.5, 0, solid), 'the belfry ladder is gone with the tower');
  assert.equal(scoreOf(F, 'a'), 300);
}

// ---------------------------------------------------------------- HUD and FX from the row and the notes alone
{
  resetRadarHud();
  const defs = mapEventsFor('frontier'), at = i => defs.findIndex(d => d.id === i);
  // Ridge owned by bravo, its next sweep in 6 s; St. Aldric down.
  const cq = { mapEvents: decodeMapEvents([[at('radar-ridge'), 3, 20, 1, 60], [at('radar-aldric'), 4, 100, 0]], null, 'frontier', defs) };
  const ridgeRow = cq.mapEvents.events.find(e => e.id === 'radar-ridge');
  const tankRow = { id: 'alpha-tank', type: 'tank', x: D.x, z: D.z + 200 }, far = { id: 'alpha-jeep', type: 'jeep', x: D.x - 260, z: D.z };
  let chip = radarChipModel(cq, 'alpha', tankRow, 1000);
  assert.deepEqual([chip.state, chip.head, chip.text, chip.share], ['wait', 'ENEMY RADAR D', 'SWEEP IN 6 S', 0.4], 'the swept side\'s chip');
  assert.equal(radarChipModel(cq, 'alpha', far, 1000), null, 'none outside the ring');
  assert.equal(radarChipModel(cq, 'bravo', tankRow, 1000), null, 'none for the owner');
  assert.equal(radarChipModel(cq, 'alpha', { id: 'h', type: 'helicopter', x: D.x - 250, z: D.z + 250 }, 1000).state, 'wait', 'aircraft out to 400 m');
  const sweep = { kind: 'map_event', event: 'radar-ridge', phase: 'active', team: 'bravo', note: 'sweep', data: { team: 'bravo', ids: ['alpha-tank'] } };
  assert.equal(mapEventBanner(sweep, { nowMs: 1000, selfTeam: 'alpha' }), null, 'a sweep is no banner');
  const rowAt = left => ({ mapEvents: decodeMapEvents([[at('radar-ridge'), 3, 20, 1, left / 100]], null, 'frontier', defs) });
  chip = radarChipModel(rowAt(T.everyMs - 1000), 'alpha', tankRow, 2000);
  assert.deepEqual([chip.state, chip.head, chip.text], ['swept', 'RADAR · SWEPT', 'SPOTTED 4 S'], 'then RADAR · SWEPT while the mark lasts');
  assert.equal(radarChipModel(rowAt(T.everyMs - T.revealMs - 100), 'alpha', tankRow, 1000 + T.revealMs + 100).state, 'wait', 'the row\'s sweep age ends it');
  assert.equal(radarChipModel(rowAt(T.everyMs - 1000), 'alpha', far, 2000), null);
  const done = mapEventBanner({ kind: 'map_event', event: 'radar-ridge', phase: 'done', team: 'alpha' }, { nowMs: 0, selfTeam: 'bravo' });
  assert.deepEqual([done.title, done.detail], ['RIDGE RADAR DESTROYED', 'D LOSES ITS SWEEP']);
  assert.equal(mapEventBanner({ kind: 'map_event', event: 'radar-ridge', phase: 'armed', reason: 'down' }, { nowMs: 0, selfTeam: 'bravo' }), null, 'no banner for the bridge');
  const online = mapEventBanner({ kind: 'map_event', event: 'radar-ridge', phase: 'active', team: 'bravo', reason: 'captured', endsAt: 5000 }, { nowMs: 0, selfTeam: 'alpha' });
  assert(online.title === 'ENEMY RIDGE RADAR' && online.priority <= 2, 'a capture is a low-priority banner');
  assert.equal(RADAR_PRESENTER.marker({ name: 'x' }, ridgeRow, { selfTeam: 'bravo' }).name, 'RADAR D · SWEEP 6 S');
  assert.equal(RADAR_PRESENTER.marker({ name: 'x' }, ridgeRow, { selfTeam: 'alpha' }).name, 'RADAR D');
  assert(Math.abs(radarSweepAngle({ leftMs: T.everyMs }) + Math.PI / 2) < 1e-9, 'the sweep line points north as it fires');
  const calls = [];
  const ctx = new Proxy({}, { get: (_t, k) => (k === 'setLineDash' || typeof k !== 'string' ? () => {} : (...args) => calls.push([k, ...args])), set: () => true });
  RADAR_PRESENTER.mapItems(ridgeRow, cq, 'alpha');
  paintMapEvents(ctx, cq.mapEvents, { nowMs: 0, px: 1 });
  const rings = calls.filter(c => c[0] === 'arc' && c[1] === D.x && c[2] === D.z).map(c => c[3]);
  assert(rings.includes(T.groundM) && rings.includes(T.airM), 'the map paints the 240 m and 400 m rings round the flag');
  assert(!calls.some(c => c[0] === 'arc' && c[1] === B.x), 'nothing round a radar that is down');
  const shakes = [];
  const fx = new MapEventFx({ fx: { emit: () => 1, addEmitter: s => s, removeEmitter: () => {} }, audio: {}, cameraShake: { add: t => shakes.push(t) },
    getCamera: () => ({ position: { x: 510, y: 40, z: 230 } }) });
  fx.mapId = 'frontier';
  assert(fx.handleEvent({ kind: 'map_event', event: 'radar-ridge', phase: 'done', pos: [512, 40, 232] }) && shakes.length === 1, 'the fall shakes the camera');

  // The antenna and the wave from the row alone (no scene: the pose only).
  const wfx = new MapEventFx({ fx: { emit: () => 1 }, audio: {}, tier: 'low' });
  const head = wfx.hook('radar-ridge');
  assert(head !== wfx.hook('radar-aldric') && head.update, 'one antenna hook per radar');
  head.clear();
  const frames = (ev, s, opts = {}) => { const match = { conquest: { ev } }; for (let i = 0; i < Math.round(s * 30); i++) wfx.update(1 / 30, { match, mapId: 'frontier', selfTeam: 'alpha', ...opts }); return head.pose; };
  let pose = frames(null, 0.5);
  assert(pose.visible && head.state.speed === 0 && pose.accent !== RADAR_COLORS.enemy && !pose.wave, 'neutral: parked, grey, no wave');
  pose = frames([[at('radar-ridge'), 3, 0, 1, 10]], 0.5);
  assert(head.state.speed > 0.5 && !pose.wave && pose.accent === RADAR_COLORS.enemy, 'bravo\'s radar spins up in the enemy colour, no wave before its sweep');
  pose = frames([[at('radar-ridge'), 3, 0, 1, 149]], 1 / 30);
  assert(pose.wave && pose.waveAge <= 150 && pose.wave.color === RADAR_COLORS.enemy && pose.wave.shellAlpha === 0, 'the wrap starts the wave (the low tier: ring only)');
  const r0 = pose.wave.r;
  pose = frames([[at('radar-ridge'), 3, 0, 1, 149]], 1);
  assert(pose.wave.r > r0 + 100 && Math.abs(pose.waveAge - 1100) <= 60, `the ring runs out on the local clock between rows (${pose.wave.r.toFixed(0)} m)`);
  pose = frames([[at('radar-ridge'), 3, 0, 1, 149]], 1 / 30, { selfTeam: 'bravo' });
  assert.equal(pose.wave.color, RADAR_COLORS.own, 'the owner sees it in its own colour');
  pose = frames([[at('radar-ridge'), 3, 0, 1, 149]], RADAR_HEAD_FX.wave.ms / 1000);
  assert(!pose.wave, 'and it fades out');
  wfx.tier = 'medium';
  assert(frames([[at('radar-ridge'), 3, 0, 1, 150]], 0.1).wave.shellAlpha > 0, 'the medium tier adds the shell');
  assert.equal(frames([[at('radar-ridge'), 3, 0, 1, 150]], 0.1, { reducedMotion: true }).wave.shellAlpha, 0, 'reduced motion drops it');
  pose = frames([[at('radar-ridge'), 4, 100, 1]], 1);
  assert(pose.visible && pose.fall?.drop > 0 && !pose.wave, 'a fall takes the antenna down with the dome');
  assert(!frames([[at('radar-ridge'), 4, 100, 1]], 3).visible, 'then it is gone');
  head.clear();
  assert(!frames([[at('radar-ridge'), 4, 100, 1]], 1 / 30).visible, 'a joiner sees no antenna on a fallen radar');
  assert(frames([[at('radar-ridge'), 3, 0, 0, 50]], 1 / 30).visible, 'a rematch stands it up again');
}

// ---------------------------------------------------------------- rematch and Breakthrough
policy.reset();
F.run(TICK_MS * 2);
assert.equal(solidIn(world, towerBox), towerCells, 'the rematch restores the tower');
assert(ladderContact(meta, tower.minX + 0.5, 44, tower.minZ + 0.5, 0, solid), 'and its ladder');
const ridge2 = system.instance('radar-ridge');
assert.deepEqual([ridge2.phase, ridge2.team, ridge2.controller.sweeps, system.targets.share(system.targets.get(ridge2, 'radar'))], ['active', 'bravo', 0, 1]);
const bt = new MapEventSystem({ mapMeta: { id: 'frontier' }, variant: 'breakthrough', now: 0 });
bt.reset();
assert(bt.instance('radar-ridge') && bt.instance('radar-aldric'), 'Breakthrough keeps the radars');

// ================================================================== Redrock
{
  const R = eventFixture({ map: 'redrock', defs: RADAR_EVENTS, controllers: RADAR_CONTROLLERS });
  const rl = R.meta.ladders.filter(l => l.support);
  const dish = rl.find(l => l.face === 'x-'), water = rl.find(l => l.face === 'z-');
  const d = climb(R.world, R.meta, dish);
  assert(d.grounded && Math.abs(d.y - (dish.maxY - 0.2)) < 0.05, `the dish ladder reaches the catwalk (y ${d.y.toFixed(2)})`);
  const w = climb(R.world, R.meta, water);
  assert(w.top >= water.maxY - 0.3, `the water tower ladder reaches the rim (top ${w.top.toFixed(2)})`);
  checkMounts(R.world, 'redrock', { 'radar-mesa': 'dome', 'radar-palmera': 'tower' });
  R.run(TICK_MS * 2);
  const mesa = R.system.instance('radar-mesa'), palmera = R.system.instance('radar-palmera');
  assert.deepEqual([mesa.team, palmera.team], ['bravo', 'alpha'], 'D and A own theirs');
  for (const id of ['radar-mesa', 'radar-palmera']) {
    const cells = RADAR_SITES[id].parts.reduce((n, p) => n + radarPartCells((x, y, z) => R.world.getBlock(x, y, z), p, isSolidBlock).length / 4, 0);
    assert(cells > 150, `${id}: ${cells} structure cells`);
  }
  R.player('ra', 'alpha');
  for (let i = 0; i < 6; i++) R.system.onBlast([564.5, 40, 249.5], { key: 'rocket', radius: 3, ownerId: 'ra' });
  R.run(T.groanMs + T.landMs);
  const rs = solidOf(R.world);
  assert(mesa.phase === 'done' && !ladderContact(R.meta, dish.minX + 0.5, 40, dish.minZ + 0.5, 0, rs), 'the Mesa radar falls and takes the dish ladder');
  console.log(`radar mesa: ${mesa.controller.cells} cells down`);
}

console.log('conquest map event radar: registry, climbs, sweep, bots, ownership, wire, antenna and wave, destruction, fall, wreck, ladders, B head room, rematch, Breakthrough, Redrock passed');
process.exit(0);
