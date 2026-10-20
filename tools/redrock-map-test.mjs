// Redrock Canyon map contract (docs/maps/redrock.md): the second Conquest
// battlefield. Metadata shape and plan agreement, terrain-derived y values,
// standable dry spawns with headroom in the generated voxels, the 17-hull
// fleet, roads that stay drivable, landmarks and named places, lobby and
// presentation wiring, deploy options on the real map, the serialized payload
// and a short deterministic bot match (captures, kills, nobody stuck in the
// canyon).
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { MAP_IDS, MAP_MODE_COMPATIBILITY } from '../shared/modes.js';
import { MAP_PLAYER_LIMITS, lobbyCapacity } from '../shared/lobby-limits.js';
import { VEHICLE_TYPE_IDS, CONQUEST_RULES } from '../shared/conquest-contract.js';
import { createMapState, getMapMeta } from '../shared/world/templates.js';
import { REDROCK_PLAN } from '../shared/world/redrock-plan.js';
import { redrockTopY, redrockDrivable, redrockWaterY, riverCentreX } from '../shared/world/redrock-terrain.js';
import { BATTLEFIELD_MAP_IDS, BATTLEFIELD_INFO, isBattlefieldMap } from '../shared/world/battlefields.js';
import { conquestPlanFor } from '../shared/world/battlefield-plans.js';
import { getMapDimensions, FRONTIER_DIMENSIONS } from '../shared/world/dimensions.js';
import { AIRSPACE, APRON_KIND } from '../shared/world/airspace.js';
import { BEDROCK, FLUID_BLOCKS, isSolidBlock } from '../shared/world/blocks.js';
import { boxCollides, solidBelow } from '../shared/player-movement.js';
import { findMapCaptureShot, MAP_CAPTURE_SHOTS } from '../shared/map-capture-shots.js';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { mulberry32 } from '../shared/noise.js';
import { MAP_LABELS, MAP_PREVIEWS } from '../public/js/ui/hud-support.js';
import { mapAtmosphere, resolveWeather } from '../public/js/engine/map-atmosphere.js';
import { REDROCK_WEATHER } from '../public/js/engine/redrock-atmosphere.js';
import { soundscapeSites } from '../public/js/audio/conquest-soundscape.js';

const started = performance.now();
const meta = getMapMeta('redrock');
const plan = REDROCK_PLAN;
const c = meta.conquest;
const feetY = (x, z) => Math.round((redrockTopY(x, z) + 1.02) * 100) / 100;

// ------------------------------------------------- identity and wiring
assert.equal(MAP_IDS.at(-1), 'redrock', 'redrock is appended to MAP_IDS');
assert.deepEqual(BATTLEFIELD_MAP_IDS, ['frontier', 'redrock']);
assert.ok(isBattlefieldMap('redrock') && isBattlefieldMap('frontier') && !isBattlefieldMap('harbor'));
assert.deepEqual([...MAP_MODE_COMPATIBILITY.redrock], ['conquest'], 'Redrock is Conquest-only');
assert.ok(MAP_MODE_COMPATIBILITY.frontier.includes('conquest'), 'Frontier stays a Conquest map');
assert.equal(MAP_PLAYER_LIMITS.redrock, 16);
assert.equal(lobbyCapacity('conquest', 'redrock'), lobbyCapacity('conquest', 'frontier'), 'same lobby capacity as Frontier');
assert.strictEqual(conquestPlanFor('redrock'), plan);
assert.equal(BATTLEFIELD_INFO.redrock.name, 'Redrock Canyon');
assert.equal(meta.id, 'redrock'); assert.equal(meta.name, 'Redrock Canyon');
assert.deepEqual(meta.dimensions, { sx: 768, sy: 80, sz: 768 });
assert.strictEqual(getMapDimensions('redrock'), FRONTIER_DIMENSIONS, 'same 768 x 80 x 768 extent as Frontier');
assert.ok(Object.isFrozen(meta) && Object.isFrozen(c) && Object.isFrozen(c.flags[0].spawns[0]));
assert.deepEqual(meta.navigation, { mode: 'surface', cell: 4, maxStep: 1 });
assert.ok(AIRSPACE.redrock && AIRSPACE.redrock.limit > AIRSPACE.redrock.combat);
assert.equal(APRON_KIND.DESERT, 8); assert.equal(APRON_KIND.RED_ROCK, 9);

// ----------------------------------------------------- mapMeta.conquest v2
assert.equal(c.version, 2);
assert.deepEqual(Object.keys(c).sort(), ['airfields', 'bases', 'combatArea', 'crossings', 'dressing', 'flags', 'roads', 'vehicleSpawns', 'version', 'weather'].sort());
assert.deepEqual(c.combatArea, plan.combatArea);
assert.ok(REDROCK_WEATHER.includes(c.weather));
assert.deepEqual(c.flags.map(f => f.id), ['A', 'B', 'C', 'D', 'E']);
assert.deepEqual(c.flags.map(f => f.home), ['alpha', 'alpha', null, 'bravo', 'bravo']);
for (const f of c.flags) {
  const p = plan.flags.find(q => q.id === f.id);
  assert.deepEqual([f.name, f.site, f.x, f.z, f.radius, f.home], [p.name, p.site, p.x, p.z, p.radius, p.home]);
  assert.equal(f.y, feetY(f.x, f.z), `flag ${f.id} y is the terrain feet height`);
  assert.equal(f.spawns.length, 12, `flag ${f.id} has 12 forward spawns`);
  for (const s of f.spawns) {
    const d = Math.hypot(s.x - f.x, s.z - f.z);
    assert.ok(d >= 8 && d <= f.radius + 30, `flag ${f.id} spawn ${s.x},${s.z} sits around the zone (${d.toFixed(1)} m)`);
    assert.equal(s.y, feetY(s.x, s.z));
  }
}
// Mirror symmetry about x = 384: A/D and B/E are the same distance from the river.
const flag = id => c.flags.find(f => f.id === id);
assert.ok(Math.abs((384 - flag('A').x) - (flag('D').x - 384)) <= 24 && Math.abs(flag('A').z - flag('D').z) <= 8);
assert.ok(Math.abs((384 - flag('B').x) - (flag('E').x - 384)) <= 24 && Math.abs(flag('B').z - flag('E').z) <= 8);
assert.deepEqual([flag('C').x, flag('C').z], [384, 384], 'the dam flag is the centre of the map');
for (const team of ['alpha', 'bravo']) {
  const b = c.bases[team], hq = plan.hqs[team];
  assert.deepEqual([b.id, b.x, b.z, b.radius, b.name], [team, hq.x, hq.z, hq.radius, hq.name]);
  assert.equal(b.spawns.length, 8);
  for (const s of b.spawns) assert.ok(Math.hypot(s.x - b.x, s.z - b.z) < b.radius, `${team} spawn inside the HQ`);
}

// ------------------------------------- river, crossings and the dam
assert.deepEqual(c.crossings.map(x => [x.id, x.kind, x.x, x.z, x.width]), plan.crossings.map(x => [x.id, x.kind, x.x, x.z, x.width]));
for (const x of c.crossings.filter(x => x.kind === 'bridge')) assert.ok(x.y >= plan.river.surfaceY + 10, `${x.id} deck stands over the canyon`);
const fords = c.crossings.filter(x => x.kind === 'ford');
assert.ok(fords.length >= 2 && fords.every(x => x.y <= redrockWaterY(x.x, x.z) + 1.1), 'fords are wadeable river beds');
assert.ok(redrockWaterY(384, 300) >= plan.river.reservoir.surfaceY, 'the reservoir stands north of the dam');
assert.ok(redrockWaterY(Math.round(riverCentreX(450)), 450) === plan.river.surfaceY, 'the canyon river runs south of the dam');
assert.ok(redrockTopY(330, 450) - redrockTopY(Math.round(riverCentreX(450)) - 8, 450) >= 6, 'the south canyon is walled');

// --------------------------------------------------- fleet (17 hulls)
const fleet = c.vehicleSpawns;
assert.equal(fleet.length, 17);
const expected = [
  ...['alpha', 'bravo'].flatMap(team => ['jeep', 'tank', 'helicopter', 'transport', 'plane', 'jeep_at'].map(type => [`${team}-${type}`, team, type, undefined])),
  ['flag-A-jeep', 'alpha', 'jeep', 'A'], ['flag-B-jeep', 'alpha', 'jeep', 'B'], ['flag-C-tank', null, 'tank', 'C'],
  ['flag-D-jeep', 'bravo', 'jeep', 'D'], ['flag-E-jeep', 'bravo', 'jeep', 'E'],
];
assert.deepEqual(fleet.map(v => [v.id, v.team, v.type, v.flag]).sort(), expected.sort());
for (const v of fleet) {
  assert.ok(VEHICLE_TYPE_IDS.includes(v.type));
  assert.equal(v.y, feetY(v.x, v.z), `${v.id} rests on the terrain`);
  assert.ok(redrockDrivable(v.x, v.z) || v.type === 'helicopter' || v.type === 'transport', `${v.id} pad is drivable ground`);
  if (v.flag) {
    const f = flag(v.flag);
    assert.ok(Math.hypot(v.x - f.x, v.z - f.z) <= f.radius + 40, `${v.id} pad belongs to flag ${v.flag}`);
  }
}
const cTank = fleet.find(v => v.id === 'flag-C-tank');
assert.ok(cTank.x < 384 && cTank.altX > 384, 'C tank: west pad for alpha, east alt pad for bravo');
assert.equal(cTank.altY, feetY(cTank.altX, cTank.altZ));
for (const type of ['jeep', 'tank', 'helicopter', 'transport', 'plane', 'jeep_at']) {
  const a = fleet.find(v => v.id === `alpha-${type}`), b = fleet.find(v => v.id === `bravo-${type}`);
  assert.ok(Math.abs(a.x + b.x - 768) < 1e-9 && Math.abs(a.z + b.z - 768) < 1e-9, `${type} pads are point-mirrored`);
}
assert.deepEqual(c.airfields.map(a => a.team), ['alpha', 'bravo']);

// ------------------------------------------------ roads stay drivable
assert.ok(c.roads.length >= 10 && c.roads.find(r => r.id === 'axis')?.kind === 'paved');
for (const r of c.roads) {
  let samples = 0, drivable = 0, worstStep = 0, prev = null;
  for (let i = 1; i < r.points.length; i++) {
    const [x0, , z0] = r.points[i - 1], [x1, , z1] = r.points[i];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 2));
    for (let k = 0; k <= n; k++) {
      const x = x0 + (x1 - x0) * k / n, z = z0 + (z1 - z0) * k / n;
      samples++;
      if (redrockDrivable(x, z)) drivable++;
      const y = redrockTopY(x, z);
      if (prev != null && !c.crossings.some(q => Math.hypot(q.x - x, q.z - z) < 30)) worstStep = Math.max(worstStep, Math.abs(y - prev));
      prev = y;
    }
  }
  assert.ok(drivable / samples >= 0.9, `${r.id} is drivable (${(100 * drivable / samples).toFixed(0)}%)`);
  assert.ok(worstStep <= 2, `${r.id} never climbs a cliff (worst step ${worstStep} m per 2 m)`);
}

// ------------------------------------------ landmarks and named places
const ids = new Set(meta.landmarks.map(l => l.id));
for (const f of c.flags) assert.ok(ids.has(f.id), `landmarks include flag ${f.id}`);
for (const id of ['redrock-dam-intakes', 'mesa-radar-dish', 'sulphur-water-tower', 'copperhead-headframe', 'palmera-bell-tower',
  'coyote-well', 'juniper-post', 'arch-rock', 'signal-butte'])
  assert.ok(ids.has(id), `landmarks include ${id}`);
const places = meta.landmarks.filter(l => l.kind === 'place');
assert.ok(places.length >= 4 && places.every(p => typeof p.name === 'string' && p.name.length > 3), 'named places carry names');
for (const l of meta.landmarks) assert.ok([l.x, l.y, l.z].every(Number.isFinite), l.id);

// ------------------------------------ every y within the spawn bounds
const ys = [];
(function walk(value) {
  if (Array.isArray(value)) value.forEach(walk);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) {
    if (k === 'y' || k === 'altY') ys.push(v);
    walk(v);
  }
})(meta);
assert.ok(ys.length > 200 && ys.every(y => Number.isFinite(y) && y >= meta.spawnBounds.minY && y <= meta.spawnBounds.maxY));

// ------------------------------------------------------- the voxel world
const world = createMapState('redrock');
assert.strictEqual(world.meta, meta);
const solid = (x, y, z) => isSolidBlock(world.getBlock(x, y, z));
const fluid = (x, y, z) => FLUID_BLOCKS.has(world.getBlock(x, y, z));
const standable = [...meta.spawns.fun, ...c.flags.flatMap(f => f.spawns), ...c.bases.alpha.spawns, ...c.bases.bravo.spawns];
for (const p of standable) {
  assert.ok(solidBelow(solid, p.x, p.y, p.z) && !boxCollides(solid, p.x, p.y, p.z), `spawn ${p.x},${p.y},${p.z} is standable`);
  const [ix, iy, iz] = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)];
  assert.ok(!fluid(ix, iy, iz) && !fluid(ix, iy - 1, iz), `spawn ${p.x},${p.z} is dry`);
  for (let dy = 0; dy < 3; dy++) assert.ok(!solid(ix, iy + dy, iz), `spawn ${p.x},${p.z} has headroom`);
}
for (const v of fleet) {
  const [ix, iy, iz] = [Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)];
  assert.ok(solid(ix, iy - 1, iz) && !solid(ix, iy, iz) && !solid(ix, iy + 1, iz), `${v.id} pad is clear in the voxels`);
}
assert.equal(world.getBlock(0, 0, 0), BEDROCK);
assert.ok(solid(384, 33, 384) && !solid(384, 35, 384), 'the dam crest road is solid with open air above');
const serialized = world.serializeWorld();
assert.ok(serialized.length <= 3 * 1024 * 1024, `payload ${serialized.length} bytes`);
assert.deepEqual(createMapState('redrock', serialized).serializeWorld(), serialized, 'exact round trip');

// ------------------------------------------- presentation and audio
assert.equal(MAP_PREVIEWS.redrock, './assets/maps/redrock.jpg');
assert.match(MAP_LABELS.redrock, /REDROCK CANYON/);
const overview = findMapCaptureShot('redrock', 'overview');
assert.ok(overview?.kind === 'orthographic' && overview.scale === 768);
for (const shot of MAP_CAPTURE_SHOTS.filter(s => s.map === 'redrock' && s.kind !== 'orthographic')) {
  const [x, y, z] = shot.position;
  assert.ok(y >= redrockTopY(x, z) + 1.5, `capture ${shot.id} stands above the ground`);
}
assert.equal(resolveWeather(meta), c.weather);
const atmosphere = mapAtmosphere('redrock', { weather: c.weather });
assert.equal(atmosphere.backdrop.apron.colors.length, Object.keys(APRON_KIND).length, 'one apron colour per APRON_KIND');
{
  const sites = soundscapeSites('redrock');
  assert.strictEqual(sites.plan, plan, 'the soundscape places its zones from the Redrock plan');
  assert.ok([...sites.birds, sites.bell, sites.industrial].every(id => plan.flags.some(f => f.id === id)));
  assert.notStrictEqual(soundscapeSites('frontier'), sites);
}

// --------------------------------------------- deploy on the real map
const EPOCH = 1_800_000_000_000;
const atEpoch = build => { const real = Date.now; Date.now = () => EPOCH; try { return build(); } finally { Date.now = real; } };
{
  const game = atEpoch(() => new GameEngine({ mode: 'conquest', world: createMapState('redrock'), mapMeta: meta, broadcast: () => {} }));
  game.addClient('p1', 'p1'); game.addClient('p2', 'p2');
  const a = game.entities.get('p1'), b = game.entities.get('p2');
  assert.deepEqual([a.team, b.team], ['alpha', 'bravo']);
  const policy = game.mode.policy;
  const optionsOf = p => policy.conquestView().deployOptions(p).filter(o => o.ok).map(o => o.spawn);
  assert.deepEqual(optionsOf(a).filter(s => !s.startsWith('vehicle:')).sort(), ['flag:A', 'flag:B', 'hq'], 'alpha deploys at HQ, A and B');
  assert.deepEqual(optionsOf(b).filter(s => !s.startsWith('vehicle:')).sort(), ['flag:D', 'flag:E', 'hq'], 'bravo deploys at HQ, D and E');
  for (const p of [a, b]) {
    const hq = c.bases[p.team];
    assert.ok(Math.hypot(p.x - hq.x, p.z - hq.z) < hq.radius, `${p.team} round start spawns at its HQ`);
  }
  game.killPlayer(a, b, 'rifle', false);
  assert.equal(game.mode.conquestIntent(a, { type: 'deploy', spawn: 'flag:D', kit: 'assault', variant: 0 }), false, 'an enemy flag is refused');
  assert.equal(game.mode.conquestIntent(a, { type: 'deploy', spawn: 'flag:B', kit: 'engineer', variant: 0 }), true);
  for (let t = 0; t < CONQUEST_RULES.respawnMs + 400; t += TICK_MS) game.step(TICK_MS);
  assert.equal(a.state, 'alive');
  const fb = flag('B');
  assert.ok(Math.hypot(a.x - fb.x, a.z - fb.z) <= fb.radius + 30, 'deployed at Copperhead Mine');
  assert.ok(solidBelow(solid, a.x, a.y, a.z) && !boxCollides(solid, a.x, a.y, a.z), 'the B deploy cell is standable');
}

// ----------------------------------------------- bot match smoke (60 s)
{
  Math.random = mulberry32(7);
  const events = [];
  const game = atEpoch(() => new GameEngine({ mode: 'conquest', world: createMapState('redrock'), mapMeta: meta,
    broadcast: snap => { for (const e of snap.events ?? []) events.push(e); } }));
  const bots = attachBots(game, 12, { difficulties: new Map(Array.from({ length: 12 }, (_, i) => [`bot-${i}`, 'normal'])) });
  const owners0 = game.mode.policy.flags.map(f => f.owner);
  const seconds = 60, last = new Map();
  let stuck = 0, samples = 0, seated = 0;
  for (let tick = 0; tick < seconds * 1000 / TICK_MS; tick++) {
    game.step(TICK_MS);
    if (tick % Math.round(1000 / TICK_MS)) continue;
    for (const p of game.entities.values()) {
      if (p.state !== 'alive') { last.delete(p.id); continue; }
      samples++;
      if (p.vehicleId) { seated++; continue; }
      const prev = last.get(p.id);
      if (prev && Math.hypot(p.x - prev.x, p.z - prev.z) < 0.25 && p.y < 22) stuck++;
      last.set(p.id, { x: p.x, z: p.z });
    }
  }
  bots.stop?.();
  const owners = game.mode.policy.flags.map(f => f.owner);
  const captures = events.filter(e => e.kind === 'flag_captured' || e.kind === 'capture' || e.kind === 'flag_neutralized').length;
  const kills = events.filter(e => e.kind === 'kill').length;
  const drowned = events.filter(e => e.kind === 'kill' && e.w === 'water').length;
  assert.ok(owners0.join() !== owners.join() || captures > 0, `bots move the flags (${owners0.join('')} -> ${owners.join('')})`);
  assert.ok(owners[2] != null || game.mode.policy.flags[2].control !== 0 || captures > 0, 'the dam is contested within a minute');
  assert.ok(kills >= 1, `bots fight (${kills} kills)`);
  assert.ok(drowned <= 2, `bots do not drown in the canyon river (${drowned})`);
  assert.ok(seated / samples > 0.05, `bots crew the fleet (${(100 * seated / samples).toFixed(0)}% seated)`);
  assert.ok(stuck / samples < 0.05, `no bots wedged on the canyon floor (${stuck}/${samples})`);
  console.log(`Redrock bot smoke: ${kills} kills, flags ${owners.map(o => o?.[0] ?? '-').join('')}, ${(100 * seated / samples).toFixed(0)}% seated`);
}

console.log(`Redrock map passed: ${(performance.now() - started).toFixed(0)}ms, ${serialized.byteLength} serialized bytes, ${ys.length} terrain y values.`);
