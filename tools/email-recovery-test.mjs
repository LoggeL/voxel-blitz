import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccountService } from '../server/accounts.js';
import { EMAIL_LINK_LIFETIME_MS, normalizeEmail, ResendMailer } from '../server/account-email.js';
import { PostgresStore } from '../server/persistence/postgres.js';
import { postgresFixture } from './lib/postgres-fixture.mjs';

const postgres = process.argv.includes('--postgres');
const directory = await mkdtemp(path.join(tmpdir(), 'vb-email-test-'));
let clock = 1_000_000, service, store, database;
const messages = [];
let failMail = false, holdMail = null;
const mailer = { enabled: true, async send(message) {
  if (failMail) throw new Error('Provider unavailable');
  if (holdMail) await holdMail;
  messages.push(message); return 'fixture-email';
} };
const password = 'Original secure password 123';
const newPassword = 'Different secure password 456';
const server = http.createServer((req, res) => service.handleHttp(req, res));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const options = { directory, mailer, now: () => clock, publicOrigin: origin, rateLimits: { usernameLimit: 1000, ipLimit: 1000 } };
const request = async (action = '', data = null, cookie = '', headers = {}) => {
  const r = await fetch(`${origin}/api/account${action ? '/' + action : ''}`, { method: data === null ? 'GET' : 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-VB-Account': '1', Cookie: cookie, ...headers },
    ...(data === null ? {} : { body: JSON.stringify(data) }) });
  return { status: r.status, body: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] || '' };
};
const ok = async (...args) => { const r = await request(...args); assert.ok(r.status < 300, JSON.stringify(r)); return r; };
const token = message => message.url.split('=')[1];
const drain = () => Promise.all([...service.email.deliveries]);
const freshWindow = () => { clock += 11 * 60 * 1000; };
async function restart() {
  await service?.dispose();
  if (store) { await store.close(); store = await PostgresStore.open({ connectionString: database.connectionString }); }
  service = await AccountService.create({ ...options, store });
}
try {
  if (postgres) { database = await postgresFixture(); store = await PostgresStore.open({ connectionString: database.connectionString }); }
  await restart();
  assert.equal(normalizeEmail('  PERSON@EXAMPLE.COM '), 'person@example.com');
  for (const email of ['a\n@example.com', 'a@example', '.a@example.com', 'a..b@example.com', 'a@-example.com', 'a'.repeat(65)+'@example.com']) assert.equal(normalizeEmail(email), null);
  const created = await ok('register', { username: 'EmailPilot', password, email: 'PILOT@example.com' });
  const cookie = created.cookie, user = created.body.user;
  assert.equal(created.body.emailRecovery.pendingEmail, 'pilot@example.com');
  assert.equal(created.body.emailRecovery.email, null);
  const verification = messages.at(-1);
  assert.equal(verification.kind, 'verify');
  assert.equal(new URL(verification.url).origin, origin);
  assert.equal(new URL(verification.url).search, '');
  const pendingReset = await ok('forgot-password', { email: 'pilot@example.com' });
  await drain(); assert.equal(messages.length, 1, 'unverified addresses receive no password reset');
  const raw = postgres ? JSON.stringify(await store.loadAccounts()) : await readFile(path.join(directory, 'emailpilot.json'), 'utf8');
  assert.equal(raw.includes(token(verification)), false, 'raw link tokens never reach durable storage');
  assert.equal((await request('verify-email', { token: token(verification) }, '', { Origin: 'https://evil.example' })).status, 403);
  await restart();
  await ok('verify-email', { token: token(verification) });
  assert.equal((await request('verify-email', { token: token(verification) })).status, 400, 'confirmation is single use after restart');
  const identity = await ok('', null, cookie);
  assert.equal(identity.body.emailRecovery.email, 'pilot@example.com');
  assert.deepEqual(identity.body.user, user, 'private email data is separate from public identity');
  freshWindow();
  const anonymous = await ok('forgot-password', { email: 'missing@example.com' });
  const matching = await ok('forgot-password', { email: 'pilot@example.com' });
  assert.deepEqual(matching, anonymous, 'known and unknown emails have identical response and no cookie');
  assert.deepEqual(pendingReset.body, matching.body);
  await drain(); const oldReset = token(messages.at(-1));
  await ok('forgot-password', { email: 'pilot@example.com' });
  await drain(); const activeReset = token(messages.at(-1));
  assert.equal((await request('reset-password', { token: oldReset, newPassword })).status, 400, 'new links invalidate older ones');
  assert.equal((await request('reset-password', { token: activeReset, newPassword: 'short' })).status, 400);
  await restart();
  const attempts = await Promise.all([request('reset-password', { token: activeReset, newPassword }), request('reset-password', { token: activeReset, newPassword })]);
  assert.deepEqual(attempts.map(r => r.status).sort(), [200, 400], 'only one concurrent reset may consume a token');
  assert.equal(attempts.find(r => r.status === 200).body.user, null, 'reset requires fresh login');
  assert.equal((await ok('', null, cookie)).body.user, null, 'all previous sessions are revoked');
  assert.equal((await request('login', { username: 'EmailPilot', password })).status, 401);
  const loggedIn = await ok('login', { username: 'EmailPilot', password: newPassword });
  assert.equal(loggedIn.body.emailRecovery.email, 'pilot@example.com');
  await ok('forgot-password', { email: 'pilot@example.com' }); await drain();
  const expired = token(messages.at(-1)); clock += EMAIL_LINK_LIFETIME_MS;
  assert.equal((await request('reset-password', { token: expired, newPassword: password })).status, 400, 'expires at exact boundary');
  await ok('forgot-password', { email: 'pilot@example.com' }); await drain();
  const beforePasswordChange = token(messages.at(-1));
  const changed = await ok('password', { currentPassword: newPassword, newPassword: password }, loggedIn.cookie);
  assert.equal((await request('reset-password', { token: beforePasswordChange, newPassword })).status, 400);
  assert.equal((await request('email', { email: 'next@example.com', currentPassword: 'wrong password 123' }, changed.cookie)).status, 401);
  const added = await ok('email', { email: 'next@example.com', currentPassword: password }, changed.cookie);
  assert.equal(added.body.emailRecovery.email, 'pilot@example.com', 'old verified email stays until confirmation');
  const nextVerify = token(messages.at(-1));
  await ok('forgot-password', { email: 'pilot@example.com' }); await drain();
  const previousEmailReset = token(messages.at(-1));
  await ok('verify-email', { token: nextVerify });
  assert.equal((await request('reset-password', { token: previousEmailReset, newPassword })).status, 400, 'changing email invalidates outstanding reset links');
  const other = await ok('register', { username: 'OtherPilot', password });
  assert.equal((await request('email', { email: 'next@example.com', currentPassword: password }, other.cookie)).status, 409);
  freshWindow();
  failMail = true;
  const failed = await ok('forgot-password', { email: 'next@example.com' }); await drain();
  assert.deepEqual(failed.body, anonymous.body, 'provider errors do not enumerate accounts');
  const stillCreated = await ok('register', { username: 'MailFailure', password, email: 'failure@example.com' });
  assert.match(stillCreated.body.warning, /could not be sent/); assert.ok(stillCreated.body.recoveryCode);
  failMail = false;
  freshWindow();
  let release; holdMail = new Promise(resolve => { release = resolve; });
  await ok('forgot-password', { email: 'next@example.com' });
  release(); await drain(); holdMail = null;
  for (let i=0;i<2;i++) { await ok('forgot-password', { email: 'next@example.com' }); await drain(); }
  assert.equal((await request('forgot-password', { email: 'NEXT@example.com' })).status, 429, 'normalized email throttling');
  for (let i=0;i<3;i++) await ok('forgot-password', { email: 'nobody@example.com' });
  assert.equal((await request('forgot-password', { email: 'NOBODY@example.com' })).status, 429, 'unknown emails use same throttling');
  const disabled = new AccountService({ directory: path.join(directory, 'disabled'), mailer: { enabled: false } });
  assert.equal(disabled.email.enabled, false); disabled.dispose();
  assert.equal(new AccountService({ directory: path.join(directory,'no-origin'), mailer }).email.enabled, false);
  let transportRequest;
  const transport = new ResendMailer({ apiKey: 'fixture-secret', from: 'Voxel Blitz <noreply@example.com>', fetchImpl: async (url, options) => {
    transportRequest = { url, options }; return { ok: true, json: async () => ({ id: 'provider-receipt' }) };
  } });
  assert.equal(await transport.send({ to: 'pilot@example.com', username: '<Pilot>', url: origin+'/#account-reset=fixture', kind: 'reset' }), 'provider-receipt');
  assert.equal(transportRequest.url, 'https://api.resend.com/emails');
  assert.equal(transportRequest.options.headers.Authorization, 'Bearer fixture-secret');
  assert.ok(transportRequest.options.headers['Idempotency-Key']);
  assert.match(JSON.parse(transportRequest.options.body).html, /&lt;Pilot&gt;/);
  transport.fetch = async () => ({ ok: false });
  await assert.rejects(transport.send({ to: 'pilot@example.com', username: 'Pilot', url: origin, kind: 'reset' }), /temporarily unavailable/);
  console.log(`Email recovery (${postgres ? 'PostgreSQL' : 'JSON'}): confirmation, privacy, restart, expiry, concurrent single use, session revocation, email replacement, throttling, mail failures and Resend transport passed.`);
} finally {
  await service?.dispose(); await store?.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await database?.close(); await rm(directory, { recursive: true, force: true });
}
