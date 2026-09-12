import assert from 'node:assert/strict';
import { BOT_DIFFICULTIES, DEFAULT_BOT_DIFFICULTY } from '../shared/bot-difficulty.js';
import { observeBotTarget, recognitionThreshold } from '../server/bot-perception.js';
import { mulberry32 } from '../shared/noise.js';
import { PlayerEntity } from '../server/sim/player.js';
import { LobbyManager } from '../server/lobby.js';
import { startServer, stopServer } from './lib/server-process.mjs';
import { Client } from './lib/ws-client.mjs';

const observer = new PlayerEntity('bot', 'Bot', { x: 20.5, y: 1, z: 110.5 });
const target = new PlayerEntity('human', 'Human', { x: 20.5, y: 1, z: 20.5 });
observer.yaw = observer.pitch = target.yaw = target.pitch = 0;
const sight = (difficulty = 'easy', solid = () => false) => observeBotTarget(observer, target, solid,
  { blocksSight: () => false }, 0, false, difficulty);
const far = sight();
assert.ok(far && far.distance === 90, 'visible opponents can be acquired at90m');
const hard = sight('hard');
assert.ok(hard.detectionRate > far.detectionRate && hard.reactionMs < far.reactionMs);
target.z = 90.5;
const near = sight();
const covered = sight('easy', (_x, y, z) => z === 91 && y === 1);
assert.ok(covered && covered.angularArea < near.angularArea);
assert.ok(near.detectionRate > far.detectionRate, 'smaller angular surface is slower to notice');
assert.ok(covered.detectionRate < near.detectionRate, 'partialcover lowers recognitionrate');
assert.equal(sight('hard', (_x, y, z) => z === 100 && y > 0 && y < 5), null, 'hard cannot see throughwalls');
const rng = mulberry32(4201), samples = Array.from({ length: 12000 }, () => recognitionThreshold(rng()));
const noticedBy = (evidence, seconds) => samples.filter(threshold => threshold <=
  evidence.detectionRate * Math.max(0, seconds - evidence.reactionMs / 1000)).length / samples.length;
assert.ok(noticedBy(near, 1) > noticedBy(far, 1) + 0.15, 'seeded probability responds to target angularsize');
assert.ok(noticedBy(near, 1) > noticedBy(covered, 1), 'seeded probability responds to occlusion');
assert.ok(noticedBy(far, 4) > 0.7 && noticedBy(far, 1) < 0.65, 'distant open targets are found gradually');
const expected = 1 - Math.exp(-far.detectionRate * (1 - far.reactionMs / 1000));
assert.ok(Math.abs(noticedBy(far, 1) - expected) < 0.015, 'sampled notices follow exponential evidence distribution');
for (const profile of Object.values(BOT_DIFFICULTIES)) assert.ok(profile.sightRange >= 100);
assert.ok(BOT_DIFFICULTIES.hard.aimError < BOT_DIFFICULTIES.normal.aimError);
assert.ok(BOT_DIFFICULTIES.normal.aimError < BOT_DIFFICULTIES.easy.aimError);

const manager = new LobbyManager({ sendJson() {}, sendFrame() {}, closeClient() {} });
try {
  for (const gameMode of ['fun', 'tdm', 'snd', 'gungame']) {
    const host = { id: `${gameMode}-host` }, guest = { id: `${gameMode}-guest` };
    await manager.create(host, 'Host', 3, gameMode, 'harbor');
    await manager.join(guest, 'Guest', host.room.code);
    const room = host.room;
    manager.ready(host, true); manager.ready(guest, true);
    assert.equal(manager.setBotDifficulty(guest, 'bot-0', 'hard'), false, 'nonhost cannotmodify');
    assert.equal(manager.setBotDifficulty(host, host.id, 'hard'), false, 'human cannotbe configured asbot');
    assert.equal(manager.setBotDifficulty(host, 'bot-0', 'impossible'), false);
    assert.equal(manager.setBotDifficulty(host, 'bot-0', 'hard'), true);
    assert.equal(manager.setBotDifficulty(host, 'bot-1', 'normal'), true);
    assert.ok([...room.members.values()].every(member => !member.ready), 'changes invalidate readiness');
    assert.equal(manager.configure(host, { gameMode, map: 'canyon', bots: 3 }), true);
    assert.deepEqual([...room.botDifficulties.values()], ['hard', 'normal', 'easy'], 'map change keeps eachbot');
    manager.ready(host, true); manager.ready(guest, true); manager.start(host); room.engine.stop();
    assert.deepEqual(room.botManager.brains.map(brain => brain.difficulty), ['hard', 'normal', 'easy'], 'live brains receive individualprofiles');
    assert.equal(manager.setBotDifficulty(host, 'bot-0', 'easy'), false, 'live roster islocked');
    manager.leave(host); manager.leave(guest);
  }
  const host = { id: 'resize' };
  await manager.create(host, 'Host', 3, 'tdm', 'harbor');
  manager.setBotDifficulty(host, 'bot-2', 'hard');
  manager.configure(host, { gameMode: 'tdm', map: 'harbor', bots: 1 });
  manager.configure(host, { gameMode: 'tdm', map: 'harbor', bots: 3 });
  assert.equal(host.room.botDifficulties.get('bot-2'), DEFAULT_BOT_DIFFICULTY, 'removed slot cannot resurrect staleconfiguration');
  manager.configure(host, { gameMode: 'training', map: 'killhouse', bots: 0 });
  assert.equal(host.room.botDifficulties.size, 0);
  manager.leave(host);
} finally { manager.stop(); }

const server = startServer({ failureContext: 'bot difficulty' });
const clients = [];
try {
  const port = await server.port;
  const host = new Client(port, 'Host'), guest = new Client(port, 'Guest'); clients.push(host, guest);
  const welcome = await host.join({ firstFrame: { t: 'create', name: 'Host', bots: 2, gameMode: 'tdm', map: 'harbor' } });
  await guest.join({ firstFrame: { t: 'join', name: 'Guest', lobby: welcome.lobby.code } });
  await host.waitForJson(frame => frame.t === 'lobbyState' && frame.members.length === 4, 'roster');
  const since = guest.frames.length;
  host.send({ t: 'botDifficulty', id: 'bot-0', difficulty: 'hard' });
  const state = await guest.waitForJson(frame => frame.t === 'lobbyState' && frame.members.some(row => row.id === 'bot-0' && row.difficulty === 'hard'), 'difficulty broadcast', since);
  assert.equal(state.members.find(row => row.id === 'bot-1').difficulty, 'easy');
  assert.equal(Object.hasOwn(state.members.find(row => !row.bot), 'difficulty'), false);
  const errorSince = guest.frames.length;
  guest.send({ t: 'botDifficulty', id: 'bot-0', difficulty: 'easy' });
  assert.match((await guest.waitForJson(frame => frame.t === 'error', 'nonhost rejection', errorSince)).msg, /Only the host/);
} finally { await Promise.allSettled(clients.map(client => client.close())); await stopServer(server); }
console.log('Bot difficulty: seeded area/cover probabilities, host permissions, per-bot launch, resize/reset and real WebSocket state passed.');
