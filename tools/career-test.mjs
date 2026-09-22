import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { CareerService } from '../server/career.js';
import { GameEngine } from '../server/game.js';
import { careerLevel, serviceStars, CAREER_REWARDS, BOT_MASTERY_CAP_PER_MATCH } from '../shared/career.js';
import { startServer, stopServer } from './lib/server-process.mjs';
import { ProgressionTree } from '../public/js/ui/progression.js';

const directory = mkdtempSync(path.join(tmpdir(), 'vb-career-test-'));
const id = randomBytes(32).toString('hex');
let service = new CareerService({ directory });
let server;
try {
  assert.equal(careerLevel(0), 1);
  assert.equal(careerLevel(99), 1);
  assert.equal(careerLevel(100), 2);
  assert.equal(careerLevel(400), 3);
  assert.equal(careerLevel(249999), 50);
  assert.equal(careerLevel(250000), 51);
  assert.equal(careerLevel(259899), 51);
  assert.equal(careerLevel(259900), 52);
  assert.equal(careerLevel(735100), 100);
  assert.equal(serviceStars(104), 0);
  assert.equal(serviceStars(105), 1);
  assert.deepEqual(CAREER_REWARDS, { kill: { xp: 25 }, botKill: { xp: 10 }, objective: { xp: 75 }, activeMinute: { xp: 20 },
    match: { xp: 100 }, victory: { xp: 50 } }, 'reward values are unchanged');
  assert.equal(BOT_MASTERY_CAP_PER_MATCH, 40);
  assert.equal(service.identity({ headers: { cookie: 'vb-career=../../etc/passwd' } }), null);
  assert.throws(() => service.equip(id, 'arctic'), /not been unlocked/, 'a tree node cannot be equipped before it opens');
  const brokenId = randomBytes(32).toString('hex');
  writeFileSync(path.join(directory, brokenId + '.json'), '{bad json');
  assert.throws(() => service.profile(brokenId), SyntaxError, 'corrupt progress is not silently replaced with an empty profile');
  assert.equal(service.profiles.has(brokenId), false, 'corrupt profiles are not cached');
  const invalidId = randomBytes(32).toString('hex');
  writeFileSync(path.join(directory, invalidId + '.json'), JSON.stringify({ xp: -1, kills: 0, matches: 0, owned: [], equipped: {} }));
  assert.throws(() => service.profile(invalidId), /Invalid career data/);
  const client = { id: 'p1', profileId: id };
  const snapshots = [];
  const engine = new GameEngine({ mode: 'fun', broadcast(snapshot) {
    snapshots.push(snapshot); service.observe(client, snapshot);
  } });
  client.room = { engine };
  engine.addClient('p1', 'Player');
  engine.addClient('p2', 'Enemy');
  const player = engine.entities.get('p1'), enemy = engine.entities.get('p2');
  engine.killPlayer(enemy, player, 'rifle', false);
  engine.step();
  assert.equal(service.profile(id).xp, 25, 'real engine kill awards XP');
  service.observe(client, snapshots.at(-1));
  assert.equal(service.profile(id).xp, 25, 'duplicate tick is ignored');
  const next = (patch = {}) => ({ ...snapshots.at(-1), now: (snapshots.at(-1).now += 1000), events: [], ...patch });
  service.observe(client, next({ events: [{ kind: 'kill', killer: 'p1', victim: 'p1' }] }));
  assert.equal(service.profile(id).xp, 25, 'suicide gives no reward');
  enemy.bot = true;
  service.observe(client, next({ events: [{ kind: 'kill', killer: 'p1', victim: 'p2' }] }));
  assert.equal(service.profile(id).xp, 35, 'bots use the lower reward');
  service.observe(client, next({ events: [{ kind: 'bomb_plant', id: 'p1' }] }));
  assert.equal(service.profile(id).xp, 110, 'objective credit follows authoritative event');
  const beforeIdle = service.profile(id).xp;
  for (let i = 0; i < 61; i++) service.observe(client, next());
  assert.equal(service.profile(id).xp, beforeIdle, 'idle connections earn no playtime rewards');
  player.input = { keys: { f: true } };
  for (let i = 0; i < 60; i++) service.observe(client, next());
  assert.equal(service.profile(id).xp, beforeIdle + 20, 'active minute earns XP');
  service.observe(client, next({ match: { mode: 'fun', phase: 'post', winner: 'p1' } }));
  assert.equal(service.profile(id).xp, beforeIdle + 170, 'completed match plus win rewards');
  const finalXp = service.profile(id).xp;
  service.observe(client, next({ match: { mode: 'fun', phase: 'post', winner: 'p1' } }));
  service.observe(client, next({ match: { mode: 'training', phase: 'live' }, events: [{ kind: 'kill', killer: 'p1', victim: 'p2' }] }));
  assert.equal(service.profile(id).xp, finalXp, 'post repeats and training are excluded');
  const sndId = randomBytes(32).toString('hex');
  const sndClient = { ...client, profileId: sndId };
  let sndNow = 0;
  const sndTick = (phase, winner = null) => service.observe(sndClient, {
    t: 'tick', now: ++sndNow * 1000, events: [],
    players: [{ id: 'p1', team: 'alpha', state: 'alive' }], match: { mode: 'snd', phase, winner },
  });
  for (let i = 0; i < 8; i++) sndTick('live');
  sndTick('post'); sndTick('post');
  assert.equal(service.profile(sndId).matches, 0, 'S&D round ends do not count as completed matches');
  assert.equal(service.profile(sndId).xp, 0, 'intermediate S&D rounds award no completion XP');
  for (let i = 0; i < 3; i++) sndTick('live');
  sndTick('post', 'alpha');
  assert.equal(service.profile(sndId).matches, 1, 'participation carries across S&D rounds to match completion');
  assert.equal(service.profile(sndId).xp, 150);
  sndTick('post', 'alpha');
  assert.equal(service.profile(sndId).xp, 150, 'S&D match reward is awarded once');

  // Bot kills advance weapon mastery at a quarter weight, capped per weapon per match.
  const botId = randomBytes(32).toString('hex');
  const botClient = { id: 'p1', profileId: botId, room: { engine } };
  const botKill = (w = 'rifle', patch = {}) => service.observe(botClient, next({ events: [{ kind: 'kill', killer: 'p1', victim: 'p2', w }], ...patch }));
  for (let i = 0; i < 45; i++) botKill();
  botKill('smg');
  let botProfile = service.profile(botId);
  assert.equal(botProfile.xp, 46 * CAREER_REWARDS.botKill.xp, 'bot kill XP is not capped');
  assert.equal(botProfile.kills, 46);
  assert.equal(botProfile.pvpKills, 0, 'bot kills never count as PvP');
  assert.deepEqual(botProfile.mastery.rifle, { kills: 0, headshots: 0, botKills: 40 }, 'the cap stops bot mastery at 40 per weapon per match');
  assert.deepEqual(botProfile.mastery.smg, { kills: 0, headshots: 0, botKills: 1 }, 'the cap is per weapon');
  service.observe(botClient, next({ match: { mode: 'fun', phase: 'post', winner: 'p2' } }));
  botKill('rifle', { match: { mode: 'fun', phase: 'post', winner: 'p2' } });
  assert.equal(service.profile(botId).mastery.rifle.botKills, 40, 'the cap holds through the post phase');
  service.observe(botClient, next({ match: { mode: 'fun', phase: 'live' } }));
  botKill('rifle', { match: { mode: 'fun', phase: 'live' } });
  assert.equal(service.profile(botId).mastery.rifle.botKills, 41, 'the cap resets once the post phase ends');
  service.observe(botClient, next({ match: { mode: 'training', phase: 'live' }, events: [{ kind: 'kill', killer: 'p1', victim: 'p2', w: 'rifle' }] }));
  assert.equal(service.profile(botId).mastery.rifle.botKills, 41, 'training bot kills do not count');
  // The cap belongs to the match: a reconnect to the same engine keeps its count.
  const rejoinId = randomBytes(32).toString('hex');
  const rejoinKill = (target, w = 'rifle') => service.observe(target, next({ events: [{ kind: 'kill', killer: 'p1', victim: 'p2', w }] }));
  const firstConnection = { id: 'p1', profileId: rejoinId, room: { engine } };
  for (let i = 0; i < 60; i++) rejoinKill(firstConnection);
  const secondConnection = { id: 'p1', profileId: rejoinId, room: { engine } };
  for (let i = 0; i < 60; i++) rejoinKill(secondConnection);
  assert.deepEqual(service.profile(rejoinId).mastery.rifle, { kills: 0, headshots: 0, botKills: 40 }, 'rejoining the same match keeps the per-match cap');
  const otherEngine = new GameEngine({ mode: 'fun', broadcast() {} });
  const freshRoom = { id: 'p1', profileId: rejoinId, room: { engine: otherEngine } };
  otherEngine.addClient('p1', 'Player');
  otherEngine.addClient('p2', 'Enemy');
  otherEngine.entities.get('p2').bot = true;
  service.observe(freshRoom, { ...snapshots.at(-1), now: 1000, events: [{ kind: 'kill', killer: 'p1', victim: 'p2', w: 'rifle' }] });
  assert.equal(service.profile(rejoinId).mastery.rifle.botKills, 41, 'a new match starts a fresh cap');
  // Fun/FFA and chaos never enter a post phase: their cap window is 10 minutes of match time.
  snapshots.at(-1).now += 10 * 60000;
  rejoinKill(secondConnection);
  assert.equal(service.profile(rejoinId).mastery.rifle.botKills, 42, 'endless modes reset the cap every 10 minutes');

  const failureId = randomBytes(32).toString('hex');
  service.award(failureId, { xp: 100 });
  const blockedDirectory = path.join(directory, 'not-a-directory');
  writeFileSync(blockedDirectory, 'blocked');
  service.directory = blockedDirectory;
  assert.throws(() => service.equip(failureId, 'arctic'));
  assert.equal(service.profile(failureId).equipped.theme, 'amber', 'a failed disk write cannot change the saved loadout');
  assert.equal(service.dirty.has(failureId), true, 'pending play rewards remain dirty after a failed equip');
  service.directory = directory;
  service.flush();
  const persistedFailure = new CareerService({ directory });
  assert.equal(persistedFailure.profile(failureId).xp, 100);
  persistedFailure.dispose();
  assert.equal(careerLevel(service.profile(id).xp), 2);
  assert.ok(service.profile(id).owned.includes('arctic'), 'reaching level 2 grants the arctic node automatically');
  const equippedTheme = service.equip(id, 'arctic');
  assert.equal(equippedTheme.equipped.theme, 'arctic');
  assert.equal(equippedTheme.credits, undefined, 'the career view carries no currency');
  service.equip(id, 'arctic');
  assert.equal(service.profile(id).equipped.theme, 'arctic', 'repeating an equip is idempotent');
  service.dispose(); service = new CareerService({ directory });
  assert.equal(service.profile(id).equipped.theme, 'arctic', 'ownership survives server restart');
  assert.equal(service.profile(id).xp, finalXp);
  server = startServer({ cwd: process.cwd(), env: { VB_DATA_DIR: directory } });
  const url = `http://127.0.0.1:${await server.port}`;
  const response = await fetch(url + '/api/career');
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await response.json()).xp, 0);
  const cookie = `vb-career=${id}`;
  const read = await fetch(url + '/api/career', { headers: { Cookie: cookie } });
  assert.equal((await read.json()).equipped.theme, 'arctic');
  const blocked = await fetch(url + '/api/career/purchase', { method: 'POST', headers: { Cookie: cookie }, body: '{}' });
  assert.equal(blocked.status, 403);
  const forged = await fetch(url + '/api/career/purchase', { method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-VB-Career': '1' },
    body: JSON.stringify({ item: 'veteran', xp: 999999, credits: 999999, price: 0 }) });
  assert.equal(forged.status, 400, 'client cannot forge progression, and stray body fields are ignored');
  // The legacy /purchase path stays routed so a cached client bundle keeps working.
  const reset = await fetch(url + '/api/career/purchase', { method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-VB-Career': '1' },
    body: JSON.stringify({ item: 'amber', equipOnly: true }) });
  assert.equal((await reset.json()).equipped.theme, 'amber');
  const originalFetch = globalThis.fetch;
  const pending = [];
  globalThis.fetch = () => new Promise(resolve => pending.push(resolve));
  try {
    const shop = { profile: null, requestVersion: 0, render() {} };
    const poll = ProgressionTree.prototype.request.call(shop);
    const equipping = ProgressionTree.prototype.request.call(shop, 'arctic');
    pending[1]({ ok: true, json: async () => ({ equipped: { theme: 'arctic' } }) });
    await equipping;
    pending[0]({ ok: true, json: async () => ({ equipped: { theme: 'amber' } }) });
    await poll;
    assert.equal(shop.profile.equipped.theme, 'arctic', 'older background refresh cannot overwrite a completed equip');
  } finally { globalThis.fetch = originalFetch; }
  // A request can start while signed in and finish after logout. Authority must
  // still be valid when credits are spent, after the asynchronous body read.
  let authenticated = { id: randomBytes(16).toString('hex'), username: 'ShopTest' };
  const accountId = `account:${authenticated.id}`;
  service.accounts = { identity: () => authenticated };
  service.award(accountId, { xp: 900 });
  const delayedPurchase = () => {
    const request = new PassThrough();
    Object.assign(request, { method: 'POST', url: '/api/career/equip', headers: { 'x-vb-career': '1' } });
    const response = { status: null, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    return { request, response, complete: service.handleHttp(request, response) };
  };
  const control = delayedPurchase();
  control.request.end(JSON.stringify({ item: 'arctic' }));
  await control.complete;
  assert.equal(control.response.status, 200, 'authenticated in-flight equip succeeds');
  assert.equal(service.profile(accountId).equipped.theme, 'arctic');
  const revoked = delayedPurchase();
  authenticated = null;
  revoked.request.end(JSON.stringify({ item: 'orchid' }));
  await revoked.complete;
  assert.equal(revoked.response.status, 401, 'logout before the body finishes invalidates an in-flight equip');
  assert.equal(service.profile(accountId).equipped.theme, 'arctic', 'a revoked equip cannot change the saved loadout');
  authenticated = { id: accountId.slice(8), username: 'ShopTest' };
  service.equip(accountId, 'pathfinder');
  assert.equal(service.equip(accountId, 'standard', () => true, { slot: 'theme' }).equipped.theme, 'amber', 'a theme reset returns to amber');
  assert.equal(service.equip(accountId, 'standard', () => true, { slot: 'title' }).equipped.title, 'rookie', 'a title reset returns to rookie');
  console.log('Career: authoritative kills/objectives, active play, match rewards, dedupe, tree equips, persistence and HTTP authorization passed.');
} finally {
  await stopServer(server);
  service.dispose();
  rmSync(directory, { recursive: true, force: true });
}
