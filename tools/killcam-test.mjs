import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { KillcamHistory, sampleKillcam } from '../public/js/player/killcam-history.js';
import { KILLCAM } from '../shared/killcam-rules.js';
import { MODE_RULES } from '../shared/modes.js';

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
console.log('Killcam: bounded history, pose interpolation, immutable death endpoint, event timing, exclusions and authoritative human respawn passed.');
