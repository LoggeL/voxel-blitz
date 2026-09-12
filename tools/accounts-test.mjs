import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccountService } from '../server/accounts.js';
import { PASSWORD_COST, PasswordHasher, sessionHash, validPassword } from '../server/account-security.js';

const root = mkdtempSync(path.join(tmpdir(), 'vb-accounts-test-'));
const fixtures = [];
const initialPassword = '  untrimmed password 123  ';
const nextPassword = 'A different password 456';
const recoveredPassword = 'Recovered password 789';
const cookiePair = response => response.headers.get('set-cookie')?.split(';')[0] || '';
const accountRequest = cookie => ({ headers: { cookie } });

async function fixture(name, options = {}) {
  const directory = path.join(root, name);
  let service = new AccountService({ directory, rateLimits: { ipLimit: 1000, usernameLimit: 1000 }, ...options });
  const server = http.createServer(async (req, res) => {
    try {
      if (!await service.handleHttp(req, res)) { res.writeHead(404); res.end(); }
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const item = {
    directory, origin, server,
    get service() { return service; },
    restart(overrides = {}) {
      service.dispose();
      service = new AccountService({ directory, rateLimits: { ipLimit: 1000, usernameLimit: 1000 }, ...options, ...overrides });
      return service;
    },
    async request(action = '', data = null, cookie = '', headers = {}) {
      return fetch(origin + '/api/account' + (action ? '/' + action : ''), {
        method: data === null ? 'GET' : 'POST',
        headers: { Origin: origin, 'X-VB-Account': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
        ...(data === null ? {} : { body: JSON.stringify(data) }),
      });
    },
    async identity(cookie) { return (await (await this.request('', null, cookie)).json()).user; },
    async close() {
      service.dispose();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
  fixtures.push(item);
  return item;
}

async function expectError(response, status, message = null) {
  assert.equal(response.status, status);
  const payload = await response.json();
  assert.deepEqual(Object.keys(payload), ['error']);
  assert.equal(typeof payload.error, 'string');
  if (message) assert.match(payload.error, message);
  assert.equal(response.headers.get('set-cookie'), null);
  return payload.error;
}

try {
  assert.deepEqual(PASSWORD_COST, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  assert.equal(validPassword('x'.repeat(11)), false);
  assert.equal(validPassword('x'.repeat(12)), true);
  assert.equal(validPassword('🔒'.repeat(128)), true, 'limit counts complete Unicode characters');
  assert.equal(validPassword('🔒'.repeat(129)), false);
  assert.equal(validPassword('x'.repeat(12) + '\ud800'), false, 'lone surrogates cannot collapse into replacement-byte passwords');

  let clock = 1_000_000;
  const adopted = [];
  const main = await fixture('main', { now: () => clock, onRegistered(req, user) {
    assert.equal(JSON.parse(readFileSync(path.join(root, 'main', user.username.toLowerCase() + '.json'), 'utf8')).id, user.id,
      'registration is durable before the adoption callback');
    adopted.push({ cookie: req.headers.cookie || '', user });
  } });
  const guest = await main.request();
  assert.equal(guest.status, 200); assert.deepEqual(await guest.json(), { user: null });
  assert.equal(guest.headers.get('set-cookie'), null, 'anonymous reads never require or create an account');
  assert.equal(main.service.identity(accountRequest('vb-account=../../secret')), null);
  assert.equal(main.service.identity(accountRequest('vb-account=' + 'f'.repeat(64))), null);
  assert.equal(sessionHash(accountRequest(`vb-account=${'f'.repeat(64)}; vb-account=${'f'.repeat(64)}`)), null);

  const registered = await main.request('register', { username: 'Mixed_Case', password: initialPassword });
  assert.equal(registered.status, 201);
  const cookieA = cookiePair(registered), result = await registered.json();
  assert.deepEqual(Object.keys(result).sort(), ['recoveryCode', 'user']);
  assert.match(result.user.id, /^[a-f0-9]{32}$/); assert.equal(result.user.username, 'Mixed_Case');
  assert.match(result.recoveryCode, /^(?:[A-F0-9]{8}-){5}[A-F0-9]{8}$/);
  assert.match(registered.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000/);
  assert.equal(registered.headers.get('cache-control'), 'no-store');
  assert.equal(adopted.length, 1);
  assert.deepEqual(await main.identity(cookieA), result.user);
  assert.deepEqual(Object.keys(main.service.sessionIdentity(accountRequest(cookieA))).sort(), ['sessionId', 'user']);
  assert.notEqual(main.service.sessionIdentity(accountRequest(cookieA)).sessionId, cookieA.split('=')[1]);
  const raw = readFileSync(path.join(main.directory, 'mixed_case.json'), 'utf8');
  const record = JSON.parse(raw);
  for (const secret of [initialPassword, cookieA.split('=')[1], result.recoveryCode]) assert.equal(raw.includes(secret), false);
  assert.equal(record.password.N, 131072); assert.equal(record.password.r, 8); assert.equal(record.password.p, 1);
  assert.match(record.password.salt, /^[a-f0-9]{32}$/); assert.match(record.password.hash, /^[a-f0-9]{128}$/);
  assert.equal(record.sessions[0].hash, sessionHash(accountRequest(cookieA)));
  assert.equal(statSync(path.join(main.directory, 'mixed_case.json')).mode & 0o777, 0o600);
  assert.equal(statSync(main.directory).mode & 0o777, 0o700);
  await expectError(await main.request('register', { username: 'MIXED_case', password: initialPassword }), 409, /taken/);
  assert.equal(adopted.length, 1, 'duplicates do not run adoption twice');
  for (const username of ['ab', 'a'.repeat(21), ' name', 'with space', '../name', 'näme'])
    await expectError(await main.request('register', { username, password: initialPassword }), 400);
  for (const password of ['x'.repeat(11), 'x'.repeat(129), 123456789012])
    await expectError(await main.request('register', { username: 'Invalid', password }), 400);
  await expectError(await main.request('register', { username: 'Extra', password: initialPassword, admin: true }), 400);

  let hashCalls = 0;
  const originalRun = main.service.hasher.run.bind(main.service.hasher);
  main.service.hasher.run = (...args) => { hashCalls++; return originalRun(...args); };
  const wrong = await expectError(await main.request('login', { username: 'Mixed_Case', password: initialPassword.trim() }), 401);
  const unknown = await expectError(await main.request('login', { username: 'Unknown', password: initialPassword }), 401);
  assert.equal(wrong, unknown, 'login does not reveal whether an account exists');
  assert.equal(hashCalls, 2, 'wrong and nonexistent accounts both perform a password hash');
  const login = await main.request('login', { username: 'mixed_CASE', password: initialPassword });
  assert.equal(login.status, 200); assert.deepEqual(await login.json(), { user: result.user });
  const cookieB = cookiePair(login);
  assert.notEqual(cookieB, cookieA);
  assert.deepEqual(await main.identity(cookieA), result.user, 'another device remains signed in');
  assert.deepEqual(await main.identity(cookieB), result.user);

  const rotate = await main.request('login', { username: 'mixed_case', password: initialPassword }, cookieA);
  const cookieC = cookiePair(rotate); assert.equal(rotate.status, 200); await rotate.json();
  assert.equal(await main.identity(cookieA), null, 'same-browser login revokes the presented old cookie');
  assert.deepEqual(await main.identity(cookieB), result.user, 'session rotation preserves an independent device');
  assert.deepEqual(await main.identity(cookieC), result.user);
  await expectError(await main.request('password', { currentPassword: initialPassword, newPassword: nextPassword }), 401);
  await expectError(await main.request('password', { currentPassword: 'the wrong password', newPassword: nextPassword }, cookieC), 401);
  const changed = await main.request('password', { currentPassword: initialPassword, newPassword: nextPassword }, cookieC);
  assert.equal(changed.status, 200); assert.deepEqual(await changed.json(), { user: result.user });
  const cookieD = cookiePair(changed);
  assert.equal(await main.identity(cookieB), null); assert.equal(await main.identity(cookieC), null);
  assert.equal(main.service.identity(accountRequest(cookieB)), null, 'retained WebSocket headers see immediate revocation');
  await expectError(await main.request('login', { username: 'Mixed_Case', password: initialPassword }), 401);
  const secondDevice = await main.request('login', { username: 'Mixed_Case', password: nextPassword });
  const cookieE = cookiePair(secondDevice); assert.equal(secondDevice.status, 200); await secondDevice.json();
  const logout = await main.request('logout', {}, cookieD);
  assert.equal(logout.status, 200); assert.deepEqual(await logout.json(), { user: null });
  assert.match(logout.headers.get('set-cookie'), /vb-account=;.*Max-Age=0/);
  assert.equal(await main.identity(cookieD), null);
  assert.deepEqual(await main.identity(cookieE), result.user, 'logout revokes only its own device');
  const anonymousLogout = await main.request('logout', {}, cookieD);
  assert.equal(anonymousLogout.status, 200); await anonymousLogout.json();

  await expectError(await main.request('recover', { username: 'Mixed_Case', recoveryCode: '0'.repeat(48), newPassword: recoveredPassword }), 401);
  const recovery = await main.request('recover', { username: 'MIXED_case', recoveryCode: result.recoveryCode.toLowerCase().replaceAll('-', ''), newPassword: recoveredPassword });
  const cookieF = cookiePair(recovery), recovered = await recovery.json();
  assert.equal(recovery.status, 200); assert.deepEqual(recovered.user, result.user);
  assert.notEqual(recovered.recoveryCode, result.recoveryCode);
  assert.equal(await main.identity(cookieE), null, 'recovery revokes all older sessions');
  await expectError(await main.request('recover', { username: 'Mixed_Case', recoveryCode: result.recoveryCode, newPassword: initialPassword }), 401);
  await expectError(await main.request('login', { username: 'Mixed_Case', password: nextPassword }), 401);
  main.restart();
  assert.deepEqual(await main.identity(cookieF), result.user, 'opaque sessions survive a server restart');
  const persistedLogin = await main.request('login', { username: 'mixed_case', password: recoveredPassword });
  assert.equal(persistedLogin.status, 200); const cookieG = cookiePair(persistedLogin); await persistedLogin.json();

  const otherRegistration = await main.request('register', { username: 'Other_User', password: initialPassword });
  const other = await otherRegistration.json();
  const switchLogin = await main.request('login', { username: 'Other_User', password: initialPassword }, cookieF);
  assert.equal(switchLogin.status, 200); const cookieOther = cookiePair(switchLogin); await switchLogin.json();
  assert.equal(await main.identity(cookieF), null, 'switching accounts revokes the previous user session on that browser');
  assert.deepEqual(await main.identity(cookieG), result.user, 'switching accounts preserves the previous user on its other device');
  assert.deepEqual(await main.identity(cookieOther), other.user);
  clock += 30 * 24 * 60 * 60 * 1000 + 1;
  assert.equal(await main.identity(cookieG), null); assert.equal(await main.identity(cookieOther), null);
  main.restart();
  assert.equal(await main.identity(cookieOther), null, 'restart cannot revive expired sessions');
  console.log('Accounts: registration, unmodified passwords, two devices, session rotation, logout, password change, recovery, persistence and expiry passed.');

  const simultaneous = await fixture('duplicate');
  const concurrent = await Promise.all(['Same_Name', 'same_name'].map(username => simultaneous.request('register', { username, password: initialPassword })));
  assert.deepEqual(concurrent.map(response => response.status).sort(), [201, 409]);
  await Promise.all(concurrent.map(response => response.json()));
  assert.equal(readdirSync(simultaneous.directory).filter(file => file.endsWith('.json')).length, 1);
  assert.equal(simultaneous.service.records.size, 1, 'racing duplicate registrations commit once');

  const guarded = await fixture('guarded', { bodyTimeoutMs: 100 });
  const valid = { username: 'Guarded', password: initialPassword };
  await expectError(await guarded.request('register', valid, '', { Origin: 'https://evil.example' }), 403);
  await expectError(await guarded.request('register', valid, '', { Origin: 'null' }), 403);
  await expectError(await guarded.request('register', valid, '', { 'X-VB-Account': '' }), 403);
  await expectError(await guarded.request('register', valid, '', { 'Sec-Fetch-Site': 'cross-site' }), 403);
  await expectError(await guarded.request('register', valid, '', { 'Content-Type': 'text/plain' }), 415);
  await expectError(await guarded.request('register', { ...valid, password: 'x'.repeat(5000) }), 413);
  const malformed = await fetch(guarded.origin + '/api/account/login', { method: 'POST',
    headers: { Origin: guarded.origin, 'X-VB-Account': '1', 'Content-Type': 'application/json' }, body: '{not json' });
  await expectError(malformed, 400);
  await expectError(await guarded.request('register', []), 400);
  const timedOut = await new Promise((resolve, reject) => {
    const request = http.request(guarded.origin + '/api/account/login', { method: 'POST', headers: {
      Origin: guarded.origin, 'X-VB-Account': '1', 'Content-Type': 'application/json', 'Content-Length': '100',
    } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject); request.write('{');
  });
  assert.equal(timedOut, 408, 'a partial body cannot hold a request indefinitely');
  assert.equal(guarded.service.hasher.active, 0, 'rejected bodies never reach password hashing');
  const secure = await guarded.request('register', valid, '', { Origin: guarded.origin.replace('http:', 'https:'), 'X-Forwarded-Proto': 'https' });
  assert.equal(secure.status, 201); assert.match(secure.headers.get('set-cookie'), /; Secure$/); await secure.json();
  console.log('Accounts: duplicate-registration race, strict request schema, CSRF, secure cookies, body byte and time limits passed.');

  let transferFails = true, transferCalls = 0;
  const originalContext = { guest: 'a'.repeat(64), profile: { xp: 900, credits: 80 } };
  const transfer = await fixture('pending-transfer', {
    onRegistering() { return originalContext; },
    onRegistered(req, user, context) {
      transferCalls++;
      assert.deepEqual(context, originalContext, 'retries keep the original registration snapshot');
      assert.equal(user.username, 'Pending');
      if (transferFails) throw new Error('Storage unavailable');
      return false; // A terminal already-claimed decision also completes the job.
    },
  });
  const pendingRegistration = await transfer.request('register', { username: 'Pending', password: initialPassword });
  const pendingCookie = cookiePair(pendingRegistration), pending = await pendingRegistration.json();
  assert.equal(pendingRegistration.status, 201);
  assert.match(pending.warning, /progress.*transferred/);
  assert.equal(transfer.service.registrationPending(pending.user.id), true);
  assert.deepEqual(JSON.parse(readFileSync(path.join(transfer.directory, 'pending.json'), 'utf8')).registrationContext, originalContext);
  assert.equal(Object.hasOwn(pending, 'registrationContext'), false, 'private migration data is never exposed');
  transfer.restart();
  const stillPending = await (await transfer.request('', null, pendingCookie)).json();
  assert.match(stillPending.warning, /progress/);
  assert.equal(transferCalls, 2, 'GET retries the durable context after restart');
  const differentGuest = `vb-career=${'b'.repeat(64)}`;
  const pendingLogin = await transfer.request('login', { username: 'Pending', password: initialPassword }, differentGuest);
  assert.equal(pendingLogin.status, 200); assert.match((await pendingLogin.json()).warning, /progress/);
  assert.equal(transferCalls, 3, 'login retries without adopting the new device guest');
  transferFails = false;
  const repaired = await (await transfer.request('', null, pendingCookie)).json();
  assert.deepEqual(repaired, { user: pending.user });
  assert.equal(transfer.service.registrationPending(pending.user.id), false);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(path.join(transfer.directory, 'pending.json'), 'utf8')), 'registrationContext'), false);
  await transfer.request('', null, pendingCookie);
  assert.equal(transferCalls, 4, 'completed migration is never replayed');
  console.log('Accounts: failed registration follow-up persists its original private context, retries on GET/login after restart, and clears only after success.');

  const ipLimited = await fixture('ip-limit', { rateLimits: { ipLimit: 2, usernameLimit: 10, windowMs: 10000 } });
  let ipHashes = 0;
  const ipRun = ipLimited.service.hasher.run.bind(ipLimited.service.hasher);
  ipLimited.service.hasher.run = (...args) => { ipHashes++; return ipRun(...args); };
  await expectError(await ipLimited.request('login', { username: 'First', password: initialPassword }), 401);
  await expectError(await ipLimited.request('login', { username: 'Second', password: initialPassword }), 401);
  const throttled = await ipLimited.request('login', { username: 'Third', password: initialPassword }, '', { 'X-Forwarded-For': '203.0.113.55' });
  assert.ok(Number(throttled.headers.get('retry-after')) > 0); await expectError(throttled, 429);
  assert.equal(ipHashes, 2, 'untrusted forwarding addresses cannot bypass an IP limit or start another KDF');
  const nameLimited = await fixture('name-limit', { rateLimits: { ipLimit: 20, usernameLimit: 2, windowMs: 10000 } });
  let nameHashes = 0;
  const nameRun = nameLimited.service.hasher.run.bind(nameLimited.service.hasher);
  nameLimited.service.hasher.run = (...args) => { nameHashes++; return nameRun(...args); };
  await expectError(await nameLimited.request('login', { username: 'Target', password: initialPassword }), 401);
  await expectError(await nameLimited.request('login', { username: 'TARGET', password: initialPassword }), 401);
  await expectError(await nameLimited.request('login', { username: 'target', password: initialPassword }), 429);
  assert.equal(nameHashes, 2, 'normalized-username throttling runs before a password hash');
  const hasher = new PasswordHasher({ concurrency: 1, queueLimit: 1 });
  let timerRan = false;
  setTimeout(() => { timerRan = true; }, 10);
  const work = [hasher.hash(initialPassword), hasher.hash(initialPassword), hasher.hash(initialPassword)];
  assert.equal(hasher.active, 1); assert.equal(hasher.queue.length, 1);
  const hashing = await Promise.allSettled(work);
  assert.deepEqual(hashing.map(result => result.status), ['fulfilled', 'fulfilled', 'rejected']);
  assert.equal(hashing[2].reason.status, 503); assert.equal(timerRan, true, 'strong password hashing leaves the event loop responsive');
  assert.notEqual(hashing[0].value.salt, hashing[1].value.salt);
  assert.notEqual(hashing[0].value.hash, hashing[1].value.hash);
  hasher.dispose();
  console.log('Accounts: IP/username limits precede hashing, bounded KDF concurrency/queue and event-loop responsiveness passed.');

  const corrupt = await fixture('corrupt');
  writeFileSync(path.join(corrupt.directory, 'broken.json'), '{corrupt account data');
  corrupt.restart();
  assert.equal(corrupt.service.unavailable, true);
  await expectError(await corrupt.request(), 503);
  await expectError(await corrupt.request('register', { username: 'Fresh', password: initialPassword }), 503);
  assert.equal(readFileSync(path.join(corrupt.directory, 'broken.json'), 'utf8'), '{corrupt account data');
  const hostile = await fixture('hostile-cost');
  const badRecord = { ...record, username: 'Hostile', password: { ...record.password, N: 2147483648 } };
  writeFileSync(path.join(hostile.directory, 'hostile.json'), JSON.stringify(badRecord));
  hostile.restart();
  assert.equal(hostile.service.unavailable, true, 'disk data cannot choose an unbounded KDF cost');
  await expectError(await hostile.request('login', { username: 'Hostile', password: initialPassword }), 503);
  const failure = await fixture('failed-write');
  const failureRegistration = await failure.request('register', { username: 'Durable', password: initialPassword });
  const failureCookie = cookiePair(failureRegistration); await failureRegistration.json();
  const oldRecord = JSON.parse(readFileSync(path.join(failure.directory, 'durable.json'), 'utf8'));
  const block = path.join(root, 'not-a-directory'); writeFileSync(block, 'blocked');
  failure.service.directory = block;
  await expectError(await failure.request('login', { username: 'Durable', password: initialPassword }), 503);
  failure.service.directory = failure.directory;
  assert.deepEqual(JSON.parse(readFileSync(path.join(failure.directory, 'durable.json'), 'utf8')), oldRecord);
  assert.deepEqual(await failure.identity(failureCookie), { id: oldRecord.id, username: 'Durable' });
  console.log('Accounts: corrupt/hostile records fail closed without replacement; failed writes do not issue sessions or alter durable state.');
  console.log('ACCOUNT TESTS: ALL OK');
} finally {
  await Promise.allSettled(fixtures.map(item => item.close()));
  rmSync(root, { recursive: true, force: true });
}
