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
assert.equal(clip.end - clip.start, KILLCAM.historyMs);
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
history.record({ serverNow: 5050, players: [pose('killer', 80)], events: [] });
assert.equal(sampleKillcam(clip, 7000).players.get('killer').x, 5, 'live movement cannot leak into the completed clip');
history.clear();
assert.equal(clip.frames.at(-1).players[0].x, 5, 'history pruning leaves active playback intact');
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
console.log('Killcam: bounded history, pose interpolation, frozen terrain, damage/destruction/repair timing, killer hitmarkers, exclusions and authoritative human respawn passed.');
