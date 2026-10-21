import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { CAREER_REWARDS } from '../shared/career.js';
import { startServer, stopServer } from './lib/server-process.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'vb-career-wire-'));
// Author one deterministic kill through the real engine. The actual server
// admission, snapshot sender and persistence code remain intact.
const server = startServer({ env: { VB_DATA_DIR: directory, VB_PERSISTENCE: 'file' },
  args: ['--input-type=module', '--eval', `
    import { GameEngine } from './server/game.js';
    const step = GameEngine.prototype.step;
    GameEngine.prototype.step = function(...args) {
      const players = [...this.entities.values()];
      const human = players.find(p => !p.bot && p.state === 'alive');
      const bot = players.find(p => p.bot && p.state === 'alive');
      if (!this.testKill && human && bot) {
        this.testKill = true;
        this.killPlayer(bot, human, 'rifle', false);
      }
      return step.apply(this, args);
    };
    await import('./server/index.js');
  `] });
let ws;
try {
  const base = `http://127.0.0.1:${await server.port}`;
  const initial = await fetch(`${base}/api/career`);
  const cookie = initial.headers.get('set-cookie').split(';')[0];
  assert.equal((await initial.json()).xp, 0);
  ws = new WebSocket(base.replace('http:', 'ws:'), { headers: { Cookie: cookie } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('reward tick timed out')), 10_000);
    let id;
    let started = false;
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'create', name: 'RewardCheck', gameMode: 'fun', bots: 1 })));
    ws.on('message', (data, binary) => {
      if (binary) return;
      const frame = JSON.parse(data);
      if (frame.t === 'welcome') id = frame.id;
      if (frame.t === 'lobbyState' && !started) {
        started = true;
        ws.send(JSON.stringify({ t: 'ready', value: true }));
        ws.send(JSON.stringify({ t: 'start' }));
      }
      if (frame.t === 'tick' && frame.events.some(event => event.kind === 'kill' && event.killer === id)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const profile = await fetch(`${base}/api/career`, { headers: { Cookie: cookie } }).then(r => r.json());
  assert.equal(profile.xp, CAREER_REWARDS.botKill.xp);
  assert.equal(profile.pvpKills, 0, 'a bot kill is not a PvP kill');
  assert.deepEqual(profile.mastery.rifle, { kills: 0, headshots: 0, botKills: 1 }, 'the HTTP career view carries weighted bot mastery');
  ws.close();
  await stopServer(server);
  assert.doesNotMatch(server.stderr, /\[career\] reward.*failed/, 'successful file reward must not be logged as a persistence error');
  console.log('Career WebSocket: real kill reward reaches file profile without a false persistence error.');
} finally {
  ws?.terminate();
  await stopServer(server);
  await rm(directory, { recursive: true, force: true });
}
