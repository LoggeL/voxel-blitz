import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer, stopServer } from './lib/server-process.mjs';
import { validateProfile } from '../server/persistence/career-profile.js';
import { CareerClaims } from '../server/career-identity.js';

const directory = mkdtempSync(path.join(tmpdir(), 'vb-account-career-'));
// The application and its HTTP/WS/auth code run unmodified. Only the game's
// interval is faster in this child process so minute rewards need not make
// logout/reset regression tests take several real minutes.
const bootstrap = path.join(directory, 'accelerated-ticks.mjs');
writeFileSync(bootstrap, `const interval = globalThis.setInterval;
globalThis.setInterval = (callback, ms, ...args) => interval(callback, ms === 50 ? 1 : ms, ...args);\n`);
let server;
let base;
const sockets = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(predicate, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(`Timed out: ${description}`);
}

class Browser {
  constructor(cookie = '') {
    this.cookies = new Map(cookie.split(';').filter(Boolean).map(value => {
      const at = value.indexOf('='); return [value.slice(0, at).trim(), value.slice(at + 1).trim()];
    }));
  }
  get cookie() { return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '); }
  async request(route, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(base + route, {
      method, headers: { Cookie: this.cookie,
        ...(method === 'POST' ? { 'Content-Type': 'application/json', Origin: base, 'X-VB-Account': '1', 'X-VB-Career': '1' } : {}),
        ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const at = pair.indexOf('='), name = pair.slice(0, at), value = pair.slice(at + 1);
      if (/Max-Age=0(?:;|$)/i.test(cookie) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await response.text();
    let value;
    try { value = JSON.parse(text); } catch { throw new Error(`${route}: expected JSON, received ${response.status} ${text.slice(0, 100)}`); }
    return { status: response.status, value, headers: response.headers };
  }
  async ok(route, options) {
    const result = await this.request(route, options);
    assert.ok(result.status >= 200 && result.status < 300, `${route}: ${result.status} ${JSON.stringify(result.value)}`);
    assert.match(result.headers.get('cache-control') || '', /no-store/, 'private responses are never cached');
    return result.value;
  }
  post(route, body) { return this.ok(route, { method: 'POST', body }); }
  account() { return this.ok('/api/account'); }
  career() { return this.ok('/api/career'); }
}

async function launch(dataDirectory = directory) {
  server = startServer({ cwd: process.cwd(), args: ['--import', bootstrap, 'server/index.js'],
    env: { VB_DATA_DIR: dataDirectory }, failureContext: 'account career integration' });
  base = `http://127.0.0.1:${await server.port}`;
}

async function openPlayer(browser, active = true) {
  const ws = new WebSocket(base.replace('http:', 'ws:'), {
    headers: { Cookie: browser.cookie, Origin: base },
  });
  const state = { ws, latest: null, welcome: null, lobby: null, error: null, active, seq: 0, interval: null };
  sockets.add(state);
  ws.on('message', (data, binary) => {
    if (binary) return;
    const msg = JSON.parse(data.toString());
    if (msg.t === 'welcome') state.welcome = msg;
    if (msg.t === 'tick') state.latest = msg;
    if (msg.t === 'lobbyState') state.lobby = msg;
    if (msg.t === 'error') state.error = msg.msg;
  });
  ws.on('error', error => { state.error = error.message; });
  await once(ws, 'open');
  ws.send(JSON.stringify({ t: 'create', name: 'Forged client name', bots: 0, gameMode: 'fun', map: 'harbor' }));
  await eventually(() => state.welcome && state.lobby, 'private gameplay admission');
  ws.send(JSON.stringify({ t: 'ready', value: true }));
  await eventually(() => state.lobby.members.some(p => p.id === state.welcome.id && p.ready), 'private player readiness');
  ws.send(JSON.stringify({ t: 'start' }));
  await eventually(() => state.latest, 'authenticated gameplay admission');
  state.interval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ t: 'input', seq: ++state.seq,
      keys: { f: state.active, b: false, l: false, r: false, jump: false, sprint: false, crouch: false },
      yaw: 0, pitch: 0, weapon: 0, wantFire: false, wantAds: false, reload: false }));
  }, 20);
  return state;
}

async function closePlayer(state) {
  clearInterval(state.interval);
  if (state.ws.readyState === WebSocket.OPEN) {
    state.ws.close();
    await Promise.race([once(state.ws, 'close'), delay(1000)]);
  }
  if (state.ws.readyState !== WebSocket.CLOSED) state.ws.terminate();
  sockets.delete(state);
}

async function advanceMinute(state) {
  const start = state.latest.now;
  await eventually(() => state.latest.now >= start + 65000, 'another active minute through the existing socket');
  assert.equal(state.ws.readyState, WebSocket.OPEN, 'revocation keeps guest gameplay connected');
  assert.equal(state.error, null);
  const self = state.latest.players.find(p => p.id === state.welcome.id);
  assert.equal(self?.state, 'alive');
}

const seed = { xp: 900, credits: 1200, kills: 17, matches: 4,
  owned: ['amber', 'rookie', 'arctic', 'pathfinder'], equipped: { theme: 'arctic', title: 'pathfinder' } };
const token = randomBytes(32).toString('hex');
writeFileSync(path.join(directory, token + '.json'), JSON.stringify(seed));
const user = 'AccountScout';
let password = 'Original-voxel-password!9';
let recoveryCode;
let accountId;
const primary = new Browser(`vb-career=${token}`);
let observer = new Browser();


async function pendingClaimStorage(restartPending) {
  const fixture = path.join(directory, restartPending ? 'pending-restart' : 'pending-live');
  mkdirSync(fixture);
  const guest = randomBytes(32).toString('hex');
  writeFileSync(path.join(fixture, guest + '.json'), JSON.stringify(seed));
  const browser = new Browser(`vb-career=${guest}`);
  const username = restartPending ? 'PendingRestart' : 'PendingRepair';
  const password = 'Pending-storage-password!6';
  await launch(fixture);
  assert.equal((await browser.career()).xp, 900); // Loads the empty claim index before fault injection.
  const blocker = path.join(fixture, 'career-claims');
  writeFileSync(blocker, 'Simulated unavailable claim directory');
  const registered = await browser.post('/api/account/register', { username, password });
  assert.ok(registered.user?.id, 'account registration remains durable while transfer is pending');
  assert.equal((await browser.request('/api/career')).status, 503,
    'pending guest adoption must never return a successful empty account profile');
  if (restartPending) {
    await stopServer(server); server = null;
    await launch(fixture);
    await browser.post('/api/account/login', { username, password });
    assert.equal((await browser.request('/api/career')).status, 503,
      'pending transfer survives restart and still refuses an empty account view');
  }
  rmSync(blocker);
  let repaired = browser;
  if (restartPending) {
    // Recovery on another device must consume the registration snapshot, not
    // whatever guest happens to be logged in on that device now.
    const unrelatedGuest = randomBytes(32).toString('hex');
    writeFileSync(path.join(fixture, unrelatedGuest + '.json'), JSON.stringify({ ...seed, xp: 3600, credits: 2500 }));
    repaired = new Browser(`vb-career=${unrelatedGuest}`);
    await repaired.post('/api/account/login', { username, password });
    assert.equal((await new Browser(`vb-career=${unrelatedGuest}`).career()).xp, 3600,
      'pending recovery never consumes the new device guest profile');
  } else {
    await browser.account(); // GET retries only the pending original registration.
  }
  const recovered = await repaired.career();
  for (const key of ['xp', 'credits', 'kills', 'matches', 'owned', 'equipped']) {
    assert.deepEqual(recovered[key], validateProfile(seed)[key], `${restartPending ? 'restart' : 'live repair'} recovers original ${key}`);
  }
  assert.equal((await new Browser(`vb-career=${guest}`).career()).xp, 0, 'repaired transfer now owns its guest source exactly once');
  await repaired.account();
  assert.deepEqual(await repaired.career(), recovered, 'retries never duplicate the recovered snapshot');
  await stopServer(server); server = null;
  console.log(`Pending guest transfer: ${restartPending ? 'restart plus independent-device login' : 'storage repair plus GET'} preserves all original progress.`);
}

async function brokenClaimStorage() {
  const fixture = path.join(directory, 'broken-claim-guest');
  const claimsDir = path.join(fixture, 'career-claims');
  mkdirSync(claimsDir, { recursive: true });
  const validGuest = 'a'.repeat(64), badGuest = 'b'.repeat(64);
  writeFileSync(path.join(claimsDir, validGuest + '.json'), JSON.stringify({
    account: 'account:' + '1'.repeat(32), profile: seed,
  }));
  const corrupt = path.join(claimsDir, badGuest + '.json');
  writeFileSync(corrupt, '{broken');
  const claims = new CareerClaims(fixture);
  assert.throws(() => claims.hasGuest(validGuest), SyntaxError);
  rmSync(corrupt);
  assert.equal(claims.hasGuest(validGuest), true,
    'a repaired claim index can reload in the same instance after a partial read failure');
  assert.deepEqual(claims.forAccount('account:' + '1'.repeat(32)), seed);
  writeFileSync(corrupt, '{broken');
  await launch(fixture);
  const browser = new Browser('vb-career=' + 'c'.repeat(64));
  assert.equal((await browser.request('/api/career')).status, 503,
    'unavailable career storage returns a bounded, explicit service error');
  const player = await openPlayer(browser, true);
  assert.equal(player.ws.readyState, WebSocket.OPEN);
  assert.equal(player.latest.match.phase, 'live', 'an existing guest cookie can still enter live gameplay with broken career storage');
  assert.ok(player.latest.players.some(p => p.id === player.welcome.id));
  assert.equal(server.stderr.includes('uncaught'), false, 'storage trouble never escapes the WebSocket admission boundary');
  await closePlayer(player);
  await stopServer(server); server = null;
  console.log('Broken claim storage: in-process index repair succeeds and existing guests can still play.');
}

try {
  await pendingClaimStorage(false);
  await pendingClaimStorage(true);
  await brokenClaimStorage();
  await launch();
  assert.equal((await primary.account()).user, null, 'guests need no account to play');
  assert.equal((await primary.career()).xp, seed.xp, 'existing browser progress remains readable');
  const oldGuestSocket = await openPlayer(primary, false);
  const registration = await primary.post('/api/account/register', { username: user, password });
  accountId = registration.user?.id;
  recoveryCode = registration.recoveryCode;
  assert.ok(typeof accountId === 'string' && accountId.length > 0);
  assert.ok(typeof recoveryCode === 'string' && recoveryCode.length >= 16, 'registration returns a usable recovery secret');
  assert.equal(registration.user.username.toLowerCase(), user.toLowerCase());
  const adopted = await primary.career();
  for (const key of ['xp', 'credits', 'kills', 'matches', 'owned', 'equipped']) assert.deepEqual(adopted[key], validateProfile(seed)[key], `adopt ${key}`);
  assert.equal(adopted.level, 4);

  const oldGuest = new Browser(`vb-career=${token}`);
  assert.equal((await oldGuest.account()).user, null);
  const freshGuest = await oldGuest.career();
  assert.equal(freshGuest.xp, 0, 'a claimed guest token cannot read the account career');
  assert.notEqual(oldGuest.cookie, `vb-career=${token}`, 'claimed guest cookies are rotated');
  oldGuestSocket.active = true;
  await advanceMinute(oldGuestSocket);
  assert.equal((await primary.career()).xp, seed.xp, 'pre-registration guest socket cannot continue awarding the adopted account');
  await closePlayer(oldGuestSocket);

  const stolenGuest = new Browser(`vb-career=${token}`);
  await stolenGuest.post('/api/account/register', { username: 'OtherScout', password: 'Other-account-password!8' });
  assert.equal((await stolenGuest.career()).xp, 0, 'another account cannot claim the same guest snapshot');

  const bought = await primary.post('/api/career/purchase', { item: 'orchid' });
  assert.equal(bought.credits, 950);
  assert.equal(bought.equipped.theme, 'orchid');
  await observer.post('/api/account/login', { username: user.toLowerCase(), password });
  assert.equal((await observer.account()).user.id, accountId, 'independent device resolves the same account');
  assert.deepEqual(await observer.career(), bought, 'XP, credits, inventory and equipment travel across devices');

  const extraGuestToken = randomBytes(32).toString('hex');
  writeFileSync(path.join(directory, extraGuestToken + '.json'), JSON.stringify({ ...seed, xp: 3600, credits: 2500 }));
  const extraGuest = new Browser(`vb-career=${extraGuestToken}`);
  assert.equal((await extraGuest.career()).xp, 3600);
  await extraGuest.post('/api/account/login', { username: user, password });
  assert.deepEqual(await extraGuest.career(), bought, 'logging into an existing account never merges a second guest career');

  const noHeader = await new Browser().request('/api/account/login', { method: 'POST',
    headers: { 'X-VB-Account': '' }, body: { username: user, password } });
  assert.equal(noHeader.status, 403);
  const crossSite = await primary.request('/api/account/password', { method: 'POST',
    headers: { 'Sec-Fetch-Site': 'cross-site' }, body: { currentPassword: password, newPassword: 'Should-not-change!8' } });
  assert.equal(crossSite.status, 403, 'cross-site ambient-cookie writes are blocked');
  const forged = await primary.request('/api/career/purchase', { method: 'POST',
    body: { item: 'veteran', credits: 999999, xp: 999999, price: 0 } });
  assert.ok(forged.status >= 400 && forged.status < 500);
  assert.deepEqual(await primary.career(), bought, 'account progression and prices stay server-owned');
  assert.equal('passwordHash' in (await primary.account()).user, false);
  assert.equal('recoveryCode' in await primary.account(), false, 'recovery secret is never repeated by account reads');

  // Actual authorized gameplay earns XP first; the SAME connection then keeps
  // playing after a credential transition, proving reward revocation rather
  // than merely checking an HTTP login response or a disconnected socket.
  for (const transition of ['logout', 'password', 'recover']) {
    // Independent credential scenarios get independent real rate-limit windows.
    // Restart preserves account data without disabling or raising rate limits.
    if (transition !== 'logout') {
      await stopServer(server); server = null;
      await launch();
    }
    const actor = new Browser();
    await actor.post('/api/account/login', { username: user, password });
    const captured = new Browser(actor.cookie);
    const ws = await openPlayer(actor);
    const signedName = ws.latest.players.find(p => p.id === ws.welcome.id)?.name;
    assert.equal(signedName?.toLowerCase(), user.toLowerCase(), 'signed-in identity overrides a forged client name');
    const beforePlay = (await actor.career()).xp;
    await eventually(async () => (await actor.career()).xp > beforePlay, 'authorized socket earns a real active-minute reward');
    assert.ok((await actor.career()).xp >= beforePlay + 20);

    if (transition === 'logout') {
      await actor.post('/api/account/logout', {});
      assert.equal((await actor.account()).user, null);
    } else if (transition === 'password') {
      const wrong = await actor.request('/api/account/password', { method: 'POST',
        body: { currentPassword: 'Wrong-voxel-password!9', newPassword: 'New-voxel-password!8' } });
      assert.ok(wrong.status >= 400 && wrong.status < 500);
      const oldPassword = password;
      password = 'Changed-voxel-password!8';
      await actor.post('/api/account/password', { currentPassword: oldPassword, newPassword: password });
      const oldLogin = await new Browser().request('/api/account/login', { method: 'POST', body: { username: user, password: oldPassword } });
      assert.ok(oldLogin.status >= 400 && oldLogin.status < 500);
    } else {
      const reset = new Browser();
      const bad = await reset.request('/api/account/recover', { method: 'POST',
        body: { username: user, recoveryCode: 'invalid-recovery-secret', newPassword: 'Invalid-reset-password!3' } });
      assert.ok(bad.status >= 400 && bad.status < 500);
      password = 'Recovered-voxel-password!7';
      const restored = await reset.post('/api/account/recover', { username: user, recoveryCode, newPassword: password });
      const spentCode = recoveryCode;
      if (restored.recoveryCode) recoveryCode = restored.recoveryCode;
      const replay = await new Browser().request('/api/account/recover', { method: 'POST',
        body: { username: user, recoveryCode: spentCode, newPassword: 'Replay-must-not-work!3' } });
      assert.ok(replay.status >= 400 && replay.status < 500, 'recovery code is single use');
    }
    assert.equal((await captured.account()).user, null, `${transition} invalidates the previously issued cookie`);
    observer = new Browser();
    await observer.post('/api/account/login', { username: user, password });
    const revokedAt = await observer.career();
    await advanceMinute(ws);
    assert.equal((await observer.career()).xp, revokedAt.xp, `${transition}: old websocket cannot award more account XP`);
    const anonymousView = await captured.career();
    assert.equal(anonymousView.xp, 0, `${transition}: old cookie cannot read account progress`);
    await closePlayer(ws);
    console.log(`Account ${transition}: old cookie revoked, existing socket still plays, account XP stays fixed.`);
  }

  const saved = await observer.career();
  await stopServer(server); server = null;
  await launch();
  const afterRestart = new Browser();
  await afterRestart.post('/api/account/login', { username: user, password });
  assert.equal((await afterRestart.account()).user.id, accountId);
  assert.deepEqual(await afterRestart.career(), saved, 'account identity, password, XP, purchases and equipment survive restart');
  const reclaimAfterRestart = new Browser(`vb-career=${token}`);
  await reclaimAfterRestart.post('/api/account/register', { username: 'RestartScout', password: 'Restart-voxel-password!6' });
  assert.equal((await reclaimAfterRestart.career()).xp, 0, 'guest claim ownership survives restart');
  console.log('Account career: optional guest play, one-time adoption, isolated devices, no merge/reclaim, purchases, authorization, credential revocation and restart persistence passed.');
} finally {
  await Promise.all([...sockets].map(closePlayer));
  await stopServer(server);
  rmSync(directory, { recursive: true, force: true });
}
