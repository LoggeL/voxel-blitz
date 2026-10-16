import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { KillcamHistory, sampleKillcam } from '../public/js/player/killcam-history.js';
import { KILLCAM } from '../shared/killcam-rules.js';
import { MODE_RULES } from '../shared/modes.js';
import { KillcamTerrain } from '../public/js/player/killcam-terrain.js';
import { serializeBlocks } from '../shared/world/serialize.js';
import { DEFAULT_DIMENSIONS, LARGE_DIMENSIONS } from '../shared/world/dimensions.js';
import { AIR, PLANK, STONE, METAL, BEDROCK } from '../shared/world/blocks.js';

const history = new KillcamHistory();
const pose = (id, x, yaw = 0) => ({ id, name: id, x, y: 1, z: 10, yaw, pitch: 0, state: 'alive', hp: 100, weapon: 0 });
for (let t = 0; t <= 5000; t += 50) history.record({ serverNow: t,
  players: [pose('killer', t / 1000, t < 3000 ? 3.12 : -3.12), pose('victim', 10)],
  events: t === 5000 ? [{ kind: 'shoot', id: 'killer', w: 'rifle', o: [5, 2, 10], d: [1, 0, 0] }] : [],
  smokeFields: [{ id: 'smoke', x: 5, y: 2, z: 10, radius: 4, createdAt: 2000, expiresAt: 14000 }],
});
assert(history.frames.length <= KILLCAM.maxFrames);
const death = { killer: 'killer', victim: 'victim', w: 'rifle' };
const clip = history.clip(death, 'fun');
assert.equal(clip.end - clip.start, KILLCAM.historyMs + KILLCAM.postKillMs);
assert.equal(history.clip(death, 'snd'), null, 'S&D gives no attacker replay');
assert.equal(history.clip(death, 'training'), null);
assert.equal(history.clip({ ...death, killer: 'victim' }, 'fun'), null);
assert.equal(history.clip({ ...death, killer: 'missing' }, 'fun'), null);
const sample = sampleKillcam(clip, 3025, 3000);
assert(Math.abs(sample.players.get('killer').x - 3.025) < 1e-8);
const wrap = sampleKillcam(clip, 2975).players.get('killer').yaw;
assert(Math.abs(wrap) > 3, 'yaw interpolation crosses the short arc at pi');
assert.equal(sample.events.length, 0, 'killing shot never plays before its recorded time');
assert.equal(sampleKillcam(clip, 5000, 4999).events.length, 1);
assert.equal(sampleKillcam(clip, 5000, 5000).events.length, 0, 'events play once during final hold');
history.record({ serverNow: 5050, players: [pose('killer', 5.05)], events: [] });
assert.equal(sampleKillcam(clip, 5050).players.get('killer').x, 5.05, 'post-kill movement enters the replay');
history.record({ serverNow: 6050, players: [pose('killer', 80)], events: [] });
assert.equal(sampleKillcam(clip, 7000).players.get('killer').x, 5.05, 'movement after the extra second stays outside the clip');
history.clear();
assert.equal(clip.frames.at(-1).players[0].x, 5.05, 'history pruning leaves active playback intact');
assert.equal(history.clip(death, 'fun'), null);

// Damage at admission, chipping, destruction, replacement and same-type repair
// all have independent historical states, including on the larger arenas.
for (const dimensions of [DEFAULT_DIMENSIONS, LARGE_DIMENSIONS]) {
  const { sx, sy, sz } = dimensions;
  const xyz = { x: sx - 2, y: 10, z: sz - 2 };
  const index = (xyz.y * sz + xyz.z) * sx + xyz.x;
  const blocks = new Uint8Array(sx * sy * sz);
  blocks[index] = PLANK;
  const terrain = new KillcamTerrain(serializeBlocks(blocks, dimensions), [{ ...xyz, v: PLANK, progress: .4 }]);
  const recording = new KillcamHistory(terrain);
  const record = (time, blocks = [], blockDamage = []) => recording.record({ serverNow: time,
    players: [pose('killer', 5), pose('victim', 10)], blocks, blockDamage });
  record(0);
  record(100, [], [{ ...xyz, v: PLANK, progress: .6 }]);
  record(200, [{ i: index, v: AIR }]);
  record(300, [{ i: index, v: STONE }]);
  record(400, [], [{ ...xyz, v: STONE, progress: .5 }]);
  record(500, [{ i: index, v: STONE }]);
  const recorded = recording.clip(death, 'fun');
  const replay = recorded.terrain;
  const state = world => [world.getBlock(xyz.x, xyz.y, xyz.z), world.getBlockDamage(xyz.x, xyz.y, xyz.z)];
  assert.deepEqual(state(replay), [PLANK, .4], 'rewind preserves preexisting damage at clip start');
  assert.deepEqual(state(terrain), [STONE, 0], 'rewind does not modify current terrain');
  record(600, [{ i: index, v: AIR }]);
  record(600, [{ i: index, v: PLANK }]);
  assert.deepEqual(state(terrain), [AIR, 0], 'duplicate snapshots cannot replace newer terrain');
  recording.clear();
  assert.deepEqual(state(replay), [PLANK, .4], 'live destruction and history reset cannot leak into playback');
  const states = [[PLANK, .4], [PLANK, .6], [AIR, 0], [STONE, 0], [STONE, .5], [STONE, 0]];
  let previousTime = -1;
  for (let time = 0; time <= 500; time += 100) {
    const frame = sampleKillcam(recorded, time, previousTime);
    replay.apply(frame.terrain);
    assert.deepEqual(state(replay), states[time / 100], `terrain at ${time}ms`);
    assert.equal(sampleKillcam(recorded, time, time).terrain.length, 0, 'no repeated terrain mutation on held frames');
    previousTime = time;
  }
  assert.equal(replay.getBlock(1, -1, 1), BEDROCK);
  assert.equal(replay.getBlock(-1, 1, 1), METAL);
  assert.equal(replay.getBlock(1, sy, 1), AIR);

  // Pruning sparse undo records must not restore terrain destroyed before the window.
  for (let time = 700; time <= 5000; time += 50) record(time);
  assert(recording.frames.length <= KILLCAM.maxFrames);
  assert.deepEqual(state(recording.clip(death, 'fun').terrain), [AIR, 0]);
  assert.equal(recording.frames.flatMap(frame => frame.terrain).length, 0, 'old terrain deltas are pruned');

  const seeded = new KillcamHistory(new KillcamTerrain(serializeBlocks(blocks, dimensions), [], 100));
  seeded.record({ serverNow: 50, blocks: [{ i: index, v: AIR }] });
  assert.equal(seeded.frames.length, 0, 'already-applied boot snapshots are excluded');
  assert.deepEqual(state(seeded.terrain), [PLANK, 0]);
}

const hits = new KillcamHistory();
const hit = (attacker, hs = false, victim = 'victim') => ({ kind: 'hit', attacker, victim, hs });
for (let time = 0; time <= 1000; time += 50) hits.record({ serverNow: time,
  players: [pose('killer', 5), pose('victim', 10)],
  events: time === 100 ? [hit('other'), hit('killer', false, 'killer')]
    : time === 200 ? [hit('killer')]
    : time === 500 ? [hit('killer', true)]
    : time === 1000 ? [...Array.from({ length: 300 }, () => ({ kind: 'block', from: PLANK, v: AIR })),
      hit('killer', true), { kind: 'kill', ...death, hs: true }, hit('killer')]
    : [],
});
const hitClip = hits.clip(death, 'fun');
assert.equal(sampleKillcam(hitClip, 199).hitmark, null, 'other shooters, misses and self damage produce no killer marker');
assert.equal(sampleKillcam(hitClip, 200).hitmark.kind, 'body');
assert.equal(sampleKillcam(hitClip, 410).hitmark, null, 'body marker expires on replay time');
assert.equal(sampleKillcam(hitClip, 500).hitmark.kind, 'head');
assert.equal(sampleKillcam(hitClip, 999).hitmark, null, 'no premature lethal confirmation');
assert.equal(sampleKillcam(hitClip, 1000).hitmark.kind, 'killHead', 'kill wins over trailing hits, even after a large explosion');
assert.equal(sampleKillcam(hitClip, 1519).hitmark.kind, 'killHead');
assert.equal(sampleKillcam(hitClip, 1520).hitmark, null, 'final hold uses advancing replay time');
assert.equal(sampleKillcam(hitClip, 1000, 1000).events.length, 0, 'confirmation sounds do not repeat on held frames');

for (const mode of ['fun', 'duel', 'chaos', 'tdm', 'gungame']) {
  const engine = new GameEngine({ mode });
  engine.addClient('human', 'Human'); engine.addBot('enemy', 'Enemy');
  const human = engine.entities.get('human'), enemy = engine.entities.get('enemy');
  engine.killPlayer(human, enemy, 'rifle', false);
  assert.equal(human.respawnAt - engine.now, KILLCAM.respawnMs, `${mode} leaves time for human playback`);
  engine.now = human.respawnAt - 1; engine.processRespawns();
  assert.equal(human.state, 'dead');
  engine.now++; engine.processRespawns();
  assert.equal(human.state, 'alive', `${mode} resumes exactly on the authoritative deadline`);
  engine.killPlayer(enemy, human, 'rifle', false);
  assert.equal(enemy.respawnAt - engine.now, MODE_RULES[mode].respawnMs, `${mode} bots keep their normal delay`);
  engine.stop();
}
// A replayed tank main gun shot plays the cannon report, not the infantry launcher, and draws no tracer.
{
  const { playKillcamShot } = await import('../public/js/player/killcam.js');
  const calls = [];
  const deps = { killer: 'killer', audio: { vehicleCannon: (...a) => calls.push(['cannon', ...a]), fire: (...a) => calls.push(['fire', ...a]) },
    tracers: { shoot: () => calls.push(['tracer']) }, rig: { fire: () => calls.push(['rig']) } };
  assert.equal(playKillcamShot({ kind: 'shoot', id: 'killer', w: 'shell', vehicleWeapon: 'tankAP', o: [1, 2, 3] }, deps), 'cannon');
  assert.deepEqual(calls, [['cannon', [1, 2, 3], { weapon: 'tankAP' }]], 'tank shell: cannon report only');
  calls.length = 0;
  assert.equal(playKillcamShot({ kind: 'shoot', id: 'killer', w: 'rocket', o: [1, 2, 3] }, deps), 'fire');
  assert.deepEqual(calls.map(c => c[0]), ['tracer', 'rig', 'fire'], 'infantry shots keep tracer, viewmodel kick and fire sound');
}

console.log('Killcam: bounded history, pose interpolation, frozen terrain, damage/destruction/repair timing, killer hitmarkers, exclusions and authoritative human respawn passed.');

// Scope magnification survives the real client serializer and authoritative snapshot.
{
  const {NetClient} = await import('../public/js/engine/netclient.js');
  const {WEAPON_IDS} = await import('../shared/combatmath.js');
  const net = new NetClient();
  let wire, snapshot;
  net.ws={readyState:1,send:text=>{wire=JSON.parse(text);}};
  net.sendInput({weapon:WEAPON_IDS.indexOf('sniper'),wantAds:true,scopeZoom:2.5,yaw:0,pitch:0});
  assert.equal(wire.scopeZoom,2.5);
  const game=new GameEngine({mode:'fun',broadcast:value=>{snapshot=value;}});
  game.addClient('scope','Scope');
  const player=game.entities.get('scope');
  player.weapon=WEAPON_IDS.indexOf('sniper');player.deployT=0;
  game.applyInput('scope',wire);game.step(50);
  assert.equal(snapshot.players[0].scopeZoom,2.5);
  assert.ok(snapshot.players[0].adsT>0);
  assert.equal(snapshot.players[0].ads,true);
}
console.log('Killcam scope: selected magnification survives client input, server authority and snapshot.');

// Run the replay camera with real recorded poses and a real viewmodel. UI and
// world-effect owners are inert because this regression concerns projection.
{
  const { Killcam } = await import('../public/js/player/killcam.js');
  const { PerspectiveCamera } = await import('../public/js/vendor/three.module.js');
  const { ViewmodelRig } = await import('../public/js/guns/viewmodel.js');
  const { WEAPON_IDS } = await import('../shared/combatmath.js');
  const noop = () => {};
  for (const baseFov of [65, 75, 100]) for (const ads of [0, 1]) {
    const recording = new KillcamHistory();
    const killer = { ...pose('killer', 5), weapon: WEAPON_IDS.indexOf('minigun'),
      adsT: ads, ads: !!ads, grounded: true, moveSpeed: 0,
      attachments: { optic: 'scope2', grip: 'standard' } };
    for (const serverNow of [0, 500]) recording.record({ serverNow, players: [killer], events: [] });
    const camera = new PerspectiveCamera(baseFov, 1, 0.04, 1500);
    const rig = new ViewmodelRig(camera);
    const replay = Object.assign(Object.create(Killcam.prototype), {
      active: true, clip: recording.clip({ ...death, w: 'minigun' }, 'fun'),
      camera, rig, now: () => 250, started: 0, replayStart: 0, previousTime: -1,
      scope: { classList: { contains: () => false, toggle: noop },
        style: { getPropertyValue: () => '', setProperty: noop }, querySelector: () => ({}) },
      hitmarker: { dataset: {}, classList: { toggle: noop } },
      tracers: { update: noop }, projectiles: { update: noop }, impacts: { update: noop },
      roster: { sync: noop, hideLabels: noop }, timeLabel: {}, progress: { style: {} },
    });
    try {
      assert.equal(replay.update(1 / 60, 16 / 9, baseFov), true);
      const magnification = Math.tan(baseFov * Math.PI / 360) / Math.tan(camera.fov * Math.PI / 360);
      assert.ok(Math.abs(magnification - (ads ? 1.15 : 1)) < 1e-9,
        `minigun replay keeps ${ads ? '1.15x brace zoom' : 'the hip FOV'} at base FOV ${baseFov}`);
      assert.equal(replay.scopeActive, false, 'legacy minigun optic does not restore a replay scope overlay');
      assert.equal(rig.root.visible, true, 'the braced minigun remains visible in replay');
    } finally { rig.dispose(); }
  }
}
console.log('Killcam minigun: hip and braced zoom respect custom FOV and legacy optics cannot restore a scope.');

// ---------------------------------------------------------------------------------------------
// Conquest and Titanfall: authoritative replay time, the server's killcam focus (`kv`/`ks`) for
// vehicle and titan killers, minion and redeploy exclusions, the recorded hulls, the seated and
// followed-hull replay cameras, and the copy-on-write clip terrain of large maps.
{
  const { TICK_MS } = await import('../server/protocol/admission.js');
  const { CONQUEST_RULES } = await import('../shared/conquest-contract.js');
  const { getMapMeta, createMapState } = await import('../shared/world/templates.js');
  const { killcamEligible, isTitanHullKillKey, supportsKillcam } = await import('../shared/killcam-rules.js');
  for (const mode of ['conquest', 'titanfall']) assert.equal(supportsKillcam(mode), true, `${mode} replays kills`);
  assert.equal(isTitanHullKillKey('titan_crush'), true);
  assert.equal(isTitanHullKillKey('rodeo'), false, 'a rodeo kill is the pilot on the hull, not a titan');
  assert.equal(killcamEligible({ mode: 'conquest', victim: { id: 'v' }, killer: { id: 'k' }, weapon: 'redeploy' }), false,
    'an in-game RESPAWN never replays, even with an enemy credited');
  const killOf = (engine, victim) => engine.tickEvents.filter(e => e.kind === 'kill' && e.victim === victim.id).at(-1);

  // Conquest: a small flat frontier with one jeep; the replay fits inside the longer deploy delay.
  const SX = 128, SY = 48, SZ = 128, FLOOR = 2;
  const spot = (x, z) => ({ x: x + 0.5, y: FLOOR, z: z + 0.5 });
  const hq = (team, x) => ({ id: team, name: `${team} HQ`, ...spot(x, 64), radius: 12, spawns: [spot(x, 60), spot(x, 64), spot(x, 68)] });
  const bases = { alpha: hq('alpha', 8), bravo: hq('bravo', SX - 9) };
  const mapMeta = { id: 'frontier', dimensions: { sx: SX, sy: SY, sz: SZ },
    spawns: { conquest: { alpha: bases.alpha.spawns, bravo: bases.bravo.spawns } },
    conquest: { version: 2, bases, combatArea: { minX: 2, maxX: SX - 2, minZ: 2, maxZ: SZ - 2 },
      vehicleSpawns: [{ id: 'jeep', team: 'bravo', type: 'jeep', x: 60.5, y: FLOOR, z: 60.5, yaw: 0 }], flags: [] } };
  const getBlock = (x, y, z) => (x < 0 || z < 0 || x >= SX || z >= SZ ? 1 : y < FLOOR ? 1 : 0);
  const world = { dimensions: { sx: SX, sy: SY, sz: SZ }, getBlock, findSpawns: () => [spot(20, 20)], setBlock: () => {} };
  const snapshots = [];
  const conquest = new GameEngine({ mode: 'conquest', mapMeta, world, broadcast: snap => snapshots.push(snap) });
  const join = (id, team) => { conquest.addClient(id, id); const p = conquest.entities.get(id); conquest.mode.policy.setLobbyTeam(p, team); return p; };
  const human = join('h_alpha', 'alpha'), driver = join('d_bravo', 'bravo');
  for (let t = 0; t < 200; t += TICK_MS) conquest.step(TICK_MS);
  Object.assign(driver, { x: 61, y: FLOOR, z: 61, spawnProtected: false, spawnProtectedUntil: 0 });
  Object.assign(human, { x: 40.5, y: FLOOR, z: 40.5, spawnProtected: false, spawnProtectedUntil: 0 });
  assert.ok(conquest.vehicles.enter(driver, 'jeep', 'driver'), 'the killer drives the jeep');
  conquest.killPlayer(human, driver, 'vehicle', false);
  const roadkill = killOf(conquest, human);
  assert.deepEqual([roadkill.kv, roadkill.ks], ['jeep', 'driver'], 'a seated killer names its hull and seat');
  assert.equal(human.respawnAt - conquest.now, CONQUEST_RULES.respawnMs, 'Conquest keeps its own 6 s deploy delay (the replay fits inside)');
  conquest.step(TICK_MS);
  const wire = snapshots.flatMap(s => s.events || []).find(e => e.kind === 'kill' && e.victim === human.id);
  assert.deepEqual([wire?.kv, wire?.ks], ['jeep', 'driver'], 'the focus reaches the wire');
  const jeepRow = snapshots.at(-1).vehicles.find(v => v.id === 'jeep');
  assert.ok(jeepRow && [jeepRow.x, jeepRow.y, jeepRow.z, jeepRow.yaw].every(Number.isFinite), 'hull rows the replay records');
  conquest.stop?.();

  // Titanfall (harbor): pilots get 4.8 s instead of 4 s; minions, bots and redeploys keep the mode pacing.
  const titanfall = new GameEngine({ mode: 'titanfall', mapMeta: getMapMeta('harbor'), world: createMapState('harbor') });
  const policy = titanfall.mode.policy;
  if (policy.grunts) policy.grunts.enabled = false;
  for (const [id, team] of [['pilot', 'alpha'], ['enemy', 'bravo']]) { titanfall.addClient(id, id); policy.setLobbyTeam(id, team); policy.deployNow(id); }
  const pilot = titanfall.entities.get('pilot'), enemy = titanfall.entities.get('enemy');
  const relive = () => { policy.deployNow(pilot.id); Object.assign(pilot, { spawnProtected: false, spawnProtectedUntil: 0 }); };
  const killWith = (killer, key) => { relive(); titanfall.killPlayer(pilot, killer, key, false); return killOf(titanfall, pilot); };
  const RESPAWN = MODE_RULES.titanfall.respawnMs;
  let ev = killWith(enemy, 'rifle');
  assert.equal(pilot.respawnAt - titanfall.now, KILLCAM.respawnMs, 'titanfall: the pilot replay is authoritative respawn time');
  assert.equal(ev.kv, undefined, 'a killer on foot has no hull focus');
  ev = killWith({ id: 'tfg7', team: 'bravo', tfNpc: { kind: 'grunt' } }, 'rifle');
  assert.equal(pilot.respawnAt - titanfall.now, RESPAWN, 'a grunt kill keeps the 4 s respawn (no replay)');
  const hull = { id: 'tt1', type: 'titan_ion', owner: enemy.id, team: 'bravo', hp: 5000 };
  titanfall.vehicles.vehicles.set(hull.id, hull);
  enemy.vehicleId = hull.id; enemy.vehicleSeatId = 'driver';
  ev = killWith(enemy, 'xo16');
  assert.deepEqual([ev.kv, ev.ks], ['tt1', 'driver'], 'a pilot in the cockpit: the titan and its seat');
  assert.equal(pilot.respawnAt - titanfall.now, KILLCAM.respawnMs);
  enemy.vehicleId = null; enemy.vehicleSeatId = null;
  ev = killWith(enemy, 'titan_crush');
  assert.deepEqual([ev.kv, ev.ks], ['tt1', undefined], 'an empty titan crush follows the owner\'s hull');
  ev = killWith(titanfall.vehicles.titans.standInFor(hull, enemy), 'xo16');
  assert.deepEqual([ev.killer, ev.kv, ev.ks], [enemy.id, 'tt1', undefined], 'an auto-titan kill follows its hull, credited to the owner');
  ev = killWith(enemy, 'rodeo');
  assert.equal(ev.kv, undefined, 'a rodeo kill stays with the pilot on foot');
  titanfall.vehicles.vehicles.delete(hull.id);
  ev = killWith(titanfall.vehicles.titans.standInFor(hull, enemy), 'xo16');
  assert.equal(pilot.respawnAt - titanfall.now, RESPAWN, 'a stand-in without a hull to follow gets no replay');
  enemy.bot = true;
  titanfall.killPlayer(enemy, pilot, 'rifle', false);
  assert.equal(enemy.respawnAt - titanfall.now, RESPAWN, 'titanfall bots keep their normal delay');
  titanfall.stop?.();
}

{
  const { Killcam, replaySubject, replaySeatView } = await import('../public/js/player/killcam.js');
  const { VehicleCamera } = await import('../public/js/session/vehicle-camera.js');
  const { VehicleView } = await import('../public/js/engine/vehicle-view.js');
  const THREE = await import('../public/js/vendor/three.module.js');
  await import('../public/js/titanfall/titan-presentation.js');   // installs the walker presentation (titans)
  const seated = (id, x, vehicleId, seatId = 'driver', extra = {}) => ({ ...pose(id, x), vehicleId, vehicleSeatId: seatId, ...extra });
  const tank = (x, extra = {}) => ({ id: 'tank1', type: 'tank', team: 'bravo', x, y: 1, z: 10, yaw: 0, pitch: 0, roll: 0, hp: 1000, ...extra });
  const recording = new KillcamHistory();
  for (let t = 0; t <= 3000; t += 50) recording.record({ serverNow: t,
    players: [seated('killer', t / 100, 'tank1', 'driver', { yaw: 0.3, pitch: -0.1 }), pose('victim', 40)],
    vehicles: [tank(t / 100)], events: [] });
  const seatedClip = recording.clip({ killer: 'killer', victim: 'victim', w: 'tankAP', kv: 'tank1', ks: 'driver' }, 'conquest');
  assert.ok(seatedClip && seatedClip.follow === 'player' && seatedClip.focus.vehicleId === 'tank1', 'a seated killer is followed as a player');
  const mid = sampleKillcam(seatedClip, 1525, 1500);
  assert.ok(Math.abs(mid.vehicles.get('tank1').x - 15.25) < 1e-9, 'hull rows interpolate between frames');
  assert.equal(mid.players.get('killer').vehicleId, 'tank1', 'the seat is recorded with the pose');
  const subject = replaySubject(seatedClip, mid);
  assert.deepEqual([subject.kind, subject.seatId, subject.aimYaw], ['seat', 'driver', 0.3], 'the replay rides the seat along the killer\'s aim');
  assert.equal(replaySeatView('tank', 'driver'), 'chase', 'drivers replay from the chase view (hull in the picture)');
  assert.equal(replaySeatView('jeep', 'gunner'), 'mount', 'gunners over the gun');
  assert.equal(replaySeatView('helicopter', 'gunner'), 'gimbal', 'the chin gunner through its sight');
  assert.equal(replaySeatView('titan_ion', 'driver'), 'chase', 'titans replay from behind');
  assert.equal(recording.clip({ killer: 'killer', victim: 'victim', w: 'redeploy' }, 'conquest'), null, 'no replay of a redeploy');
  assert.equal(recording.clip({ killer: 'tfg3', victim: 'victim', w: 'rifle' }, 'titanfall'), null, 'a minion killer has no replay (death cam only)');
  const minions = new KillcamHistory();
  minions.record({ serverNow: 0, players: [pose('killer', 1)], match: { titanfall: { npc: [[3, 0, 1, 10, 2, 10, 0, 80, 1]] } } });
  minions.record({ serverNow: 50, players: [pose('killer', 1)], match: {} });
  minions.record({ serverNow: 400, players: [pose('killer', 1)], match: { titanfall: { npc: [[3, 0, 1, 12, 2, 10, 0, 80, 1]] } } });
  const minionClip = minions.clip({ killer: 'killer', victim: 'victim', w: 'rifle' }, 'titanfall');
  assert.equal(minionClip.frames[1].npcs[0][3], 10, 'a snapshot without the minion list keeps the last one');
  assert.deepEqual(sampleKillcam(minionClip, 225, 200).npcs.b[0].slice(0, 4), [3, 0, 1, 12], 'the replay samples the recorded minions');

  // Auto-titan: the owner is dead the whole window, the titan is followed from behind.
  const titan = (x) => ({ id: 'tt1', type: 'titan_ion', team: 'bravo', own: 'owner', x, y: 1, z: 10, yaw: 1, hp: 8000, mounts: [[1.2, 0.05]] });
  const auto = new KillcamHistory();
  for (let t = 0; t <= 3000; t += 50) auto.record({ serverNow: t,
    players: [{ ...pose('owner', 90), state: 'dead', hp: 0 }, pose('victim', 40)], vehicles: [titan(10 + t / 1000)], events: [] });
  assert.equal(auto.clip({ killer: 'owner', victim: 'victim', w: 'xo16' }, 'titanfall'), null, 'a dead killer alone has no replay');
  const autoClip = auto.clip({ killer: 'owner', victim: 'victim', w: 'xo16', kv: 'tt1' }, 'titanfall');
  assert.ok(autoClip && autoClip.follow === 'vehicle' && autoClip.frames.length > 50, 'the auto-titan hull is followed');
  const autoSubject = replaySubject(autoClip, sampleKillcam(autoClip, 2000, 1950));
  assert.deepEqual([autoSubject.kind, autoSubject.seatId], ['seat', 'driver']);

  // The replay camera for a seated killer and a followed titan, with real hulls and seat cameras.
  const noop = () => {};
  const runSeat = (clip, time) => {
    const camera = new THREE.PerspectiveCamera(75, 1, 0.04, 1500);
    const vehicles = new VehicleView({ getBlock: () => 0 });
    const rig = { root: { visible: true }, dispose: noop };
    const replay = Object.assign(Object.create(Killcam.prototype), {
      active: true, clip, camera, rig, vehicles, now: () => time, started: 0, replayStart: clip.start, previousTime: clip.start - 1,
      seatCamera: new VehicleCamera({ camera, storage: null, getBaseFov: () => 75, raycast: () => null }), _seatKey: null, _baseFov: 75,
      scope: { classList: { toggle: noop } }, hitmarker: { dataset: {}, classList: { toggle: noop } },
      tracers: { update: noop }, projectiles: { update: noop }, impacts: { update: noop },
      roster: { sync: noop, hideLabels: noop }, timeLabel: {}, progress: { style: {} },
    });
    for (let i = 0; i < 30; i++) replay.update(1 / 60, 16 / 9, 75);
    return { replay, camera, vehicles, rig };
  };
  {
    const { replay, camera, vehicles, rig } = runSeat(seatedClip, 1500);
    const hullAt = vehicles.items.get('tank1')?.root.position;
    assert.ok(hullAt, 'the replay draws the killer\'s tank');
    const back = new THREE.Vector3(camera.position.x - hullAt.x, 0, camera.position.z - hullAt.z);
    const forward = new THREE.Vector3(-Math.sin(0.3), 0, -Math.cos(0.3));
    assert.ok(back.length() > 5 && back.normalize().dot(forward) < -0.9, 'the chase camera sits behind the hull along the aim');
    assert.equal(replay.seatCamera.view, 'chase');
    assert.equal(rig.root.visible, false, 'no infantry viewmodel from a seat');
    replay._leaveSeat(); vehicles.dispose();
  }
  {
    const { camera, vehicles } = runSeat(autoClip, 2000);
    const hullAt = vehicles.items.get('tt1')?.root.position;
    assert.ok(hullAt, 'the replay draws the auto-titan');
    assert.ok(camera.position.distanceTo(hullAt) > 5 && camera.position.y > hullAt.y, 'the camera chases the titan from behind and above');
    vehicles.dispose();
  }
}

// Copy-on-write clip terrain: no full copy per replay, frozen against later live edits.
{
  const dimensions = { sx: 64, sy: 16, sz: 64 };
  const blocks = new Uint8Array(dimensions.sx * dimensions.sy * dimensions.sz);
  const at = (x, y, z) => (y * dimensions.sz + z) * dimensions.sx + x;
  blocks[at(3, 2, 3)] = STONE;
  const base = new KillcamTerrain({ blocks, dimensions });
  const history = new KillcamHistory(base);
  history.record({ serverNow: 0, players: [pose('killer', 1), pose('victim', 9)] });
  history.record({ serverNow: 100, players: [pose('killer', 1), pose('victim', 9)], blocks: [{ i: at(3, 2, 3), v: AIR }] });
  history.record({ serverNow: 300, players: [pose('killer', 1), pose('victim', 9)] });
  const clip = history.clip({ killer: 'killer', victim: 'victim', w: 'rifle' }, 'tdm');
  assert.equal(clip.terrain.blocks, undefined, 'the clip holds no copy of the voxels');
  assert.equal(clip.terrain.getBlock(3, 2, 3), STONE, 'rewound to the clip start');
  history.record({ serverNow: 400, players: [pose('killer', 1), pose('victim', 9)], blocks: [{ i: at(5, 2, 5), v: PLANK }] });
  assert.equal(base.getBlock(5, 2, 5), PLANK);
  assert.equal(clip.terrain.getBlock(5, 2, 5), AIR, 'a later live edit is pinned out of the replay until its frame plays');
  clip.terrain.apply(clip.frames.at(-1).terrain);
  assert.equal(clip.terrain.getBlock(5, 2, 5), PLANK, 'and plays at its own frame');
  clip.terrain.release();
  assert.equal(base.views.size, 0, 'a finished replay stops pinning');
}
console.log('Killcam Conquest/Titanfall: authoritative replay time, vehicle/titan focus on the wire, minion/redeploy exclusions, recorded hulls, seat and auto-titan chase cameras and copy-on-write clip terrain passed.');
